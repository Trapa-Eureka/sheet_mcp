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
import {
  assertValidStaleClaimThreshold,
  DEFAULT_SEND_LOG_LIST_LIMIT,
  MAX_SEND_LOG_LIST_LIMIT,
} from "../core/types.js";

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

const CREATE_SEND_LOG_SQL = `
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
`;

export type SchemaVersion = "none" | "v1_record" | "v2_claim";

// T6(record 전용) 스키마와 GAP-001 재설계(claim/commit/release) 스키마를 컬럼 존재 여부로 구분한다.
// PRAGMA table_info는 파라미터 바인딩을 지원하지 않지만 리터럴이 없는 고정 SQL이라 인젝션 위험이
// 없다. scripts/recoverStaleClaim.ts가 read-only 조회에도 그대로 재사용한다(STATUS-GAP-003).
export function detectSchemaVersion(db: Database.Database): SchemaVersion {
  const tableExists = db
    .prepare<[], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'send_log'`,
    )
    .get();
  if (!tableExists) return "none";

  const columns = db.prepare<[], { name: string }>(`PRAGMA table_info(send_log)`).all();
  const names = new Set(columns.map((c) => c.name));
  if (names.has("claim_token") && names.has("committed")) return "v2_claim";
  if (names.has("send_status")) return "v1_record";
  throw new Error(
    "SendLog: 'send_log' 테이블이 이미 있지만 알려진 스키마(v1 record 또는 v2 claim/commit)와 " +
      "일치하지 않습니다. DB 파일이 손상됐거나 다른 도구가 만든 테이블일 수 있습니다. DB 파일을 " +
      "백업한 뒤 send_log 테이블 구조를 직접 확인하세요.",
  );
}

interface LegacyV1SentRow {
  sheet_id: string;
  tab: string;
  row_key: string;
  template_hash: string;
  sent_at: string;
  message_id: string | null;
}

/**
 * T6에서 쓰던 record() 전용 v1 스키마(send_status/error 컬럼)를 GAP-001 이후의 claim/commit
 * v2 스키마로 옮긴다 — docs/ADVERSARIAL_REVIEW_003_STATUS_GAPS.md STATUS-GAP-001.
 *
 * - send_status='sent'였던 행만 committed=1인 확정 기록으로 옮긴다. 그래야 과거에 실제로 보낸
 *   메일이 마이그레이션 후에도 wasSent()=true / claim()=false로 남아 중복 발송을 막는다.
 * - send_status='failed'/'skipped_duplicate'였던 행은 옮기지 않는다. v1은 UNIQUE 제약 때문에
 *   한 번 실패로 기록되면 같은 키를 다시는 재시도할 수 없었다(이 자체가 AR-011/GAP-001이
 *   고치려던 버그) — 그 버그를 새 스키마로 그대로 옮기면 안 된다.
 * - claim_token은 실제 소유권 검증에 쓰이지 않는(과거 기록이라 아무도 그 token으로 commit/release를
 *   부르지 않는) 마이그레이션 전용 값을 새로 발급한다.
 * - 옛 테이블은 지우지 않고 send_log_v1_backup_<타임스탬프>로 이름만 바꿔 보존한다.
 * - 전체를 한 트랜잭션으로 묶어서, 중간에 실패하면(예: 이전에 중단된 마이그레이션이 남긴
 *   send_log_new 임시 테이블과 충돌) better-sqlite3가 자동으로 롤백해 원본 send_log를 그대로
 *   되돌려 놓는다 — 부분 마이그레이션으로 데이터가 섞이는 상태를 만들지 않는다.
 */
function migrateV1ToV2(db: Database.Database): void {
  const migrate = db.transaction(() => {
    const staleTemp = db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'send_log_new'`,
      )
      .get();
    if (staleTemp) {
      throw new Error(
        "'send_log_new' 임시 테이블이 이미 존재합니다. 이전 마이그레이션 시도가 도중에 중단됐을 " +
          "수 있습니다. DB 파일을 백업한 뒤 send_log_new 테이블 내용을 확인하고, 필요 없으면 " +
          "'DROP TABLE send_log_new;'로 지운 다음 서버를 다시 시작하세요.",
      );
    }

    db.exec(`
      CREATE TABLE send_log_new (
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

    const legacySentRows = db
      .prepare<[], LegacyV1SentRow>(
        `SELECT sheet_id, tab, row_key, template_hash, sent_at, message_id
         FROM send_log WHERE send_status = 'sent'`,
      )
      .all();

    const insert = db.prepare<[string, string, string, string, string, string, string | null]>(
      `INSERT INTO send_log_new
         (sheet_id, tab, row_key, template_hash, claim_token, committed, sent_at, message_id)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    for (const row of legacySentRows) {
      insert.run(
        row.sheet_id,
        row.tab,
        row.row_key,
        row.template_hash,
        `migrated-${randomUUID()}`,
        row.sent_at,
        row.message_id,
      );
    }

    const backupTableName = `send_log_v1_backup_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    db.exec(`ALTER TABLE send_log RENAME TO "${backupTableName}";`);
    db.exec(`ALTER TABLE send_log_new RENAME TO send_log;`);

    return { migratedCount: legacySentRows.length, backupTableName };
  });

  let result: { migratedCount: number; backupTableName: string };
  try {
    result = migrate();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `SendLog 마이그레이션 실패: 기존 send_log(v1) 스키마를 새 스키마(v2)로 옮기지 못했습니다 — ${msg} ` +
        "트랜잭션이 롤백돼 원본 send_log 테이블은 그대로 보존됐습니다. 위 원인을 해결한 뒤 서버를 " +
        "다시 시작하세요.",
    );
  }
  // stdout은 MCP JSON-RPC 프레이밍 전용이라 여기서도 stderr(console.error)로만 남긴다.
  console.error(
    `[sheet-mcp] SendLog: 기존 send_log(v1) 스키마를 감지해 새 스키마(v2)로 마이그레이션했습니다. ` +
      `과거 'sent' 기록 ${result.migratedCount}건만 옮겨졌고(failed/skipped_duplicate는 옮기지 않음), ` +
      `원본 테이블은 '${result.backupTableName}'로 보존됩니다.`,
  );
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

    const version = detectSchemaVersion(this.db);
    if (version === "none") {
      this.db.exec(CREATE_SEND_LOG_SQL);
    } else if (version === "v1_record") {
      // STATUS-GAP-001: 예전엔 "지우고 다시 만들라"고만 안내했다 — 실제로는 과거 발송 이력이
      // 사라져 재발송 위험이 있는 파괴적 지시였다. 이제는 기존 데이터를 보존하며 자동 변환한다.
      migrateV1ToV2(this.db);
    }
    // v2_claim: 이미 현재 스키마이므로 아무 것도 하지 않는다.
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
    // 음수/NaN/Infinity/소수는 어떤 claim도 건드리기 전에 거부한다(STATUS-GAP-002) — 검증을
    // 통과하지 못하면 cutoffIso 계산도, DELETE도 실행되지 않는다.
    assertValidStaleClaimThreshold(olderThanMs);
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
