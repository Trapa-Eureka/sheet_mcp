// SendLog의 실제 구현 — better-sqlite3 로컬 파일 DB.
// 설계: docs/DESIGN.md §6(unique 키: sheet_id, tab, row_key, template_hash), 태스크: docs/TASKS.md T6.
// 테스트는 임시 파일 DB로 검증한다(파일 IO는 허용, 네트워크 아님 — docs/TESTING.md §1).

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { SendLog, SendLogEntry } from "../core/types.js";

const sendLogRowSchema = z.object({
  sheet_id: z.string(),
  tab: z.string(),
  row_key: z.string(),
  template_hash: z.string(),
  send_status: z.enum(["sent", "failed", "skipped_duplicate"]),
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

  record(entry: SendLogEntry): void {
    try {
      this.db
        .prepare<[string, string, string, string, string, string, string | null, string | null]>(
          `INSERT INTO send_log
             (sheet_id, tab, row_key, template_hash, send_status, sent_at, message_id, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.sheetId,
          entry.tab,
          entry.rowKey,
          entry.templateHash,
          entry.sendStatus,
          entry.sentAt,
          entry.messageId ?? null,
          entry.error ?? null,
        );
    } catch (err) {
      if (err instanceof Database.SqliteError && err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new Error(
          `SendLog: (sheetId='${entry.sheetId}', tab='${entry.tab}', rowKey='${entry.rowKey}', ` +
            `templateHash='${entry.templateHash}') 조합은 이미 기록되어 있습니다. 같은 템플릿으로 같은 ` +
            "행을 두 번 기록하려는 시도입니다 — 파이프라인이 record() 전에 wasSent()를 먼저 확인했는지 점검하세요.",
        );
      }
      throw err;
    }
  }

  list(sheetId: string): SendLogEntry[] {
    const rows: unknown[] = this.db
      .prepare<[string]>(
        `SELECT sheet_id, tab, row_key, template_hash, send_status, sent_at, message_id, error
         FROM send_log WHERE sheet_id = ? ORDER BY id ASC`,
      )
      .all(sheetId);
    return rows.map((row) => rowToEntry(sendLogRowSchema.parse(row)));
  }

  /** DB 파일 핸들을 닫는다. 테스트에서 임시 파일 정리 전에 호출한다. */
  close(): void {
    this.db.close();
  }
}
