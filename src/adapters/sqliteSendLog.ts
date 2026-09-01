// SendLog의 실제 구현 — better-sqlite3 로컬 파일 DB.
// 설계: docs/DESIGN.md §6(unique 키: sheet_id, tab, row_key, template_hash), 태스크: docs/TASKS.md T6.
// claim/commit/release 재설계 배경: docs/ADVERSARIAL_REVIEW_003.md AR-011/AR-013 — SQLite의
// UNIQUE 제약을 이용한 INSERT 자체를 원자적 "예약(claim)" 경계로 써서, 같은 파일을 바라보는
// 서로 다른 프로세스(예: MCP 서버 두 인스턴스) 사이의 동시 실행에서도 중복 발송을 막는다.
// 테스트는 임시 파일 DB로 검증한다(파일 IO는 허용, 네트워크 아님 — docs/TESTING.md §1).

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { SendLog, SendLogEntry, SendLogListOptions } from "../core/types.js";
import { DEFAULT_SEND_LOG_LIST_LIMIT, MAX_SEND_LOG_LIST_LIMIT } from "../core/types.js";

const sendLogRowSchema = z.object({
  sheet_id: z.string(),
  tab: z.string(),
  row_key: z.string(),
  template_hash: z.string(),
  send_status: z.enum(["sent", "failed", "skipped_duplicate", "sent_log_failed"]),
  sent_at: z.string(),
  message_id: z.string().nullable(),
  error: z.string().nullable(),
});

function rowToEntry(row: z.infer<typeof sendLogRowSchema>): SendLogEntry {
  return {
    sheetId: row.sheet_id,
    tab: row.tab,
    rowKey: row.row_key,
    templateHash: row.template_hash,
    sendStatus: row.send_status,
    sentAt: row.sent_at,
    messageId: row.message_id ?? undefined,
    error: row.error ?? undefined,
  };
}

export class SqliteSendLog implements SendLog {
  private readonly db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? process.env.SEND_LOG_PATH ?? "./data/sendlog.db";
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS send_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sheet_id TEXT NOT NULL,
        tab TEXT NOT NULL,
        row_key TEXT NOT NULL,
        template_hash TEXT NOT NULL,
        send_status TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        message_id TEXT,
        error TEXT,
        UNIQUE (sheet_id, tab, row_key, template_hash)
      );
    `);
  }

  wasSent(sheetId: string, tab: string, rowKey: string, templateHash: string): boolean {
    const row = this.db
      .prepare<[string, string, string, string], { found: number }>(
        `SELECT 1 AS found FROM send_log
         WHERE sheet_id = ? AND tab = ? AND row_key = ? AND template_hash = ? LIMIT 1`,
      )
      .get(sheetId, tab, rowKey, templateHash);
    return row !== undefined;
  }

  // INSERT 자체가 원자적 claim 경계다: SQLite는 이 한 문장 안에서 UNIQUE 위반 여부를 판정하므로,
  // "먼저 조회 → 나중에 삽입"처럼 그 사이에 다른 프로세스가 끼어들 틈이 없다.
  claim(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    claimedAt: string,
  ): boolean {
    try {
      this.db
        .prepare<[string, string, string, string, string]>(
          `INSERT INTO send_log (sheet_id, tab, row_key, template_hash, send_status, sent_at)
           VALUES (?, ?, ?, ?, 'sent', ?)`,
        )
        .run(sheetId, tab, rowKey, templateHash, claimedAt);
      return true;
    } catch (err) {
      if (err instanceof Database.SqliteError && err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return false;
      }
      throw err;
    }
  }

  commit(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    sentAt: string,
    messageId: string | undefined,
  ): void {
    const result = this.db
      .prepare<[string, string | null, string, string, string, string]>(
        `UPDATE send_log SET sent_at = ?, message_id = ?
         WHERE sheet_id = ? AND tab = ? AND row_key = ? AND template_hash = ?`,
      )
      .run(sentAt, messageId ?? null, sheetId, tab, rowKey, templateHash);
    if (result.changes === 0) {
      throw new Error(
        `SendLog.commit: claim되지 않은 (sheetId='${sheetId}', tab='${tab}', rowKey='${rowKey}', ` +
          `templateHash='${templateHash}')을 commit하려 했습니다. claim() 없이 commit()을 호출한 버그입니다.`,
      );
    }
  }

  release(sheetId: string, tab: string, rowKey: string, templateHash: string): void {
    this.db
      .prepare<[string, string, string, string]>(
        `DELETE FROM send_log WHERE sheet_id = ? AND tab = ? AND row_key = ? AND template_hash = ?`,
      )
      .run(sheetId, tab, rowKey, templateHash);
  }

  // AR-015: 이력이 무한정 쌓여도 응답이 무제한으로 커지지 않도록 기본/최대 limit을 두고,
  // 최근 것부터 반환한다(ORDER BY id DESC) — 오래된 항목만 영원히 보이는 것을 방지.
  list(sheetId: string, options: SendLogListOptions = {}): SendLogEntry[] {
    const limit = Math.min(options.limit ?? DEFAULT_SEND_LOG_LIST_LIMIT, MAX_SEND_LOG_LIST_LIMIT);
    const rows: unknown[] = this.db
      .prepare<[string, number]>(
        `SELECT sheet_id, tab, row_key, template_hash, send_status, sent_at, message_id, error
         FROM send_log WHERE sheet_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(sheetId, limit);
    return rows.map((row) => rowToEntry(sendLogRowSchema.parse(row)));
  }

  /** DB 파일 핸들을 닫는다. 테스트/프로세스 종료 시 호출한다 (docs/ADVERSARIAL_REVIEW_003.md AR-018). */
  close(): void {
    this.db.close();
  }
}
