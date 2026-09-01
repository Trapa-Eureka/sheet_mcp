// SendLog의 실제 구현 — better-sqlite3 로컬 파일 DB.
// 설계: docs/DESIGN.md §6(unique 키: sheet_id, tab, row_key, template_hash), 태스크: docs/TASKS.md T6.
// claim/commit/release + 소유권 토큰 + 만료 기반 수동 복구 + cursor 페이지네이션 배경:
// docs/ADVERSARIAL_REVIEW_003.md AR-011/AR-013,
// docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md GAP-001/002/003/006 — SQLite의 UNIQUE 제약을
// 이용한 INSERT 자체를 원자적 "예약(claim)" 경계로 써서, 같은 파일을 바라보는 서로 다른 프로세스
// 사이의 동시 실행에서도 중복 발송을 막는다.
// 테스트는 임시 파일 DB로 검증한다(파일 IO는 허용, 네트워크 아님 — docs/TESTING.md §1).

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type {
  ClaimResult,
  SendLog,
  SendLogEntry,
  SendLogListOptions,
  SendLogListResult,
} from "../core/types.js";
import { DEFAULT_SEND_LOG_LIST_LIMIT, MAX_SEND_LOG_LIST_LIMIT } from "../core/types.js";

const sendLogRowSchema = z.object({
  id: z.number(),
  sheet_id: z.string(),
  tab: z.string(),
  row_key: z.string(),
  template_hash: z.string(),
  committed: z.number(), // sqlite에는 boolean이 없어 0/1 정수로 저장
  sent_at: z.string(),
  message_id: z.string().nullable(),
});

function rowToEntry(row: z.infer<typeof sendLogRowSchema>): SendLogEntry {
  return {
    sheetId: row.sheet_id,
    tab: row.tab,
    rowKey: row.row_key,
    templateHash: row.template_hash,
    sendStatus: row.committed === 1 ? "sent" : "claimed",
    sentAt: row.sent_at,
    messageId: row.message_id ?? undefined,
  };
}

function parseCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined;
  const id = Number(cursor);
  if (!Number.isInteger(id)) {
    throw new Error(
      `SendLog.list: cursor 값이 올바르지 않습니다: '${cursor}'. 이전 list() 응답의 nextCursor를 그대로 사용하세요.`,
    );
  }
  return id;
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
    // claim/commit 재설계(GAP-001)로 스키마가 바뀌었다 — v0.1은 아직 릴리스 전이라 기존 로컬
    // DB 파일과의 하위호환 마이그레이션은 두지 않는다. 개발 중 만든 data/sendlog.db가 있다면
    // 지우고 다시 만들면 된다.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS send_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sheet_id TEXT NOT NULL,
        tab TEXT NOT NULL,
        row_key TEXT NOT NULL,
        template_hash TEXT NOT NULL,
        claim_token TEXT NOT NULL,
        committed INTEGER NOT NULL DEFAULT 0,
        sent_at TEXT NOT NULL,
        message_id TEXT,
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
  ): ClaimResult {
    const token = randomUUID();
    try {
      this.db
        .prepare<[string, string, string, string, string, string]>(
          `INSERT INTO send_log (sheet_id, tab, row_key, template_hash, claim_token, sent_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(sheetId, tab, rowKey, templateHash, token, claimedAt);
      return { claimed: true, token };
    } catch (err) {
      if (err instanceof Database.SqliteError && err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { claimed: false };
      }
      throw err;
    }
  }

  commit(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    token: string,
    sentAt: string,
    messageId: string | undefined,
  ): void {
    // committed = 0 조건을 반드시 포함한다 — token이 일치해도 이미 committed된 행은 다시
    // commit할 수 없다(claimed→sent는 한 번만 일어나야 하는 전이). 두 번째 commit() 호출은
    // 호출자 버그이므로 조용히 덮어쓰지 않고 에러로 알린다(재검증 과정에서 강화됨).
    const result = this.db
      .prepare<[string, string | null, string, string, string, string, string]>(
        `UPDATE send_log SET committed = 1, sent_at = ?, message_id = ?
         WHERE sheet_id = ? AND tab = ? AND row_key = ? AND template_hash = ? AND claim_token = ?
           AND committed = 0`,
      )
      .run(sentAt, messageId ?? null, sheetId, tab, rowKey, templateHash, token);
    if (result.changes === 0) {
      throw new Error(
        `SendLog.commit: claim되지 않았거나 token이 일치하지 않거나 이미 commit된 ` +
          `(sheetId='${sheetId}', tab='${tab}', rowKey='${rowKey}', templateHash='${templateHash}')을 ` +
          "commit하려 했습니다. claim() 없이 commit()을 호출했거나, 같은 claim을 두 번 commit " +
          "했거나, 그 사이 forceReleaseStaleClaim()으로 회수되고 다른 claim으로 대체됐을 수 있습니다.",
      );
    }
  }

  release(sheetId: string, tab: string, rowKey: string, templateHash: string, token: string): void {
    // token이 일치하고 **아직 committed되지 않은(committed = 0)** 행만 지운다. 이미 없거나, 다른
    // claim으로 대체됐거나, token은 맞지만 이미 commit(확정 발송)된 기록이면 조용히 무시한다 —
    // 확정된 기록은 release()로도 절대 지워지면 안 된다(재검증 과정에서 발견: committed 체크가
    // 없으면 commit 성공 후 release가 잘못 불렸을 때 방금 확정한 발송 기록이 통째로 사라져
    // wasSent()가 false가 되고 재발송이 가능해지는 위험이 있었다 — forceReleaseStaleClaim()이
    // committed 기록을 절대 건드리지 않는 것과 같은 원칙).
    this.db
      .prepare<[string, string, string, string, string]>(
        `DELETE FROM send_log
         WHERE sheet_id = ? AND tab = ? AND row_key = ? AND template_hash = ? AND claim_token = ?
           AND committed = 0`,
      )
      .run(sheetId, tab, rowKey, templateHash, token);
  }

  forceReleaseStaleClaim(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    olderThanMs: number,
  ): boolean {
    // committed=0(아직 확정 안 된 claim)이고, sent_at(=claim 시각)이 cutoff보다 오래된 경우에만
    // 지운다 — 확정된(sent) 기록은 어떤 경우에도 건드리지 않는다.
    const cutoffIso = new Date(Date.now() - olderThanMs).toISOString();
    const result = this.db
      .prepare<[string, string, string, string, string]>(
        `DELETE FROM send_log
         WHERE sheet_id = ? AND tab = ? AND row_key = ? AND template_hash = ?
           AND committed = 0 AND sent_at <= ?`,
      )
      .run(sheetId, tab, rowKey, templateHash, cutoffIso);
    return result.changes > 0;
  }

  // AR-015/GAP-006: limit+1개를 조회해 실제로 다음 페이지가 있는지 정확히 판정하고(근사치 아님),
  // cursor(마지막으로 본 id)로 이어서 조회할 수 있게 한다. 최근 것부터 반환한다.
  list(sheetId: string, options: SendLogListOptions = {}): SendLogListResult {
    // MCP 경계(sendLogLimitSchema)는 이미 양의 정수만 허용하지만, SendLog는 그 zod 검증 없이도
    // 직접 호출될 수 있는 인터페이스이므로 0/음수가 들어와도 항상 최소 1건 이상을 요청한 것으로
    // 취급한다(재검증 중 강화 — 음수 limit을 그대로 SQL LIMIT에 넘기면 SQLite가 "LIMIT -1=무제한"
    // 으로 해석해 AR-015가 막으려던 무제한 응답을 다시 열어줄 수 있었다).
    const limit = Math.max(
      1,
      Math.min(options.limit ?? DEFAULT_SEND_LOG_LIST_LIMIT, MAX_SEND_LOG_LIST_LIMIT),
    );
    const cursorId = parseCursor(options.cursor);

    const rows: unknown[] =
      cursorId === undefined
        ? this.db
            .prepare<[string, number]>(
              `SELECT id, sheet_id, tab, row_key, template_hash, committed, sent_at, message_id
               FROM send_log WHERE sheet_id = ? ORDER BY id DESC LIMIT ?`,
            )
            .all(sheetId, limit + 1)
        : this.db
            .prepare<[string, number, number]>(
              `SELECT id, sheet_id, tab, row_key, template_hash, committed, sent_at, message_id
               FROM send_log WHERE sheet_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
            )
            .all(sheetId, cursorId, limit + 1);

    const parsed = rows.map((row) => sendLogRowSchema.parse(row));
    const hasMore = parsed.length > limit;
    const page = hasMore ? parsed.slice(0, limit) : parsed;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? String(last.id) : undefined;

    return { entries: page.map(rowToEntry), hasMore, nextCursor };
  }

  /** DB 파일 핸들을 닫는다. 테스트/프로세스 종료 시 호출한다 (docs/ADVERSARIAL_REVIEW_003.md AR-018). */
  close(): void {
    this.db.close();
  }
}
