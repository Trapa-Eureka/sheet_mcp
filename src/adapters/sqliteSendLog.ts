// The real implementation of SendLog — a better-sqlite3 local file DB.
// Design: docs/DESIGN.md §6 (unique key: sheet_id, tab, row_key, template_hash), task: docs/TASKS.md T6.
// Background on claim/commit/release + ownership tokens + expiry-based manual recovery + cursor
// pagination:
// docs/ADVERSARIAL_REVIEW_003.md AR-011/AR-013,
// docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md GAP-001/002/003/006 — the INSERT itself, backed by
// SQLite's UNIQUE constraint, is used as the atomic "claim" boundary, preventing duplicate sends
// even under concurrent execution across separate processes looking at the same file.
// Tests verify against a temp file DB (file IO is allowed, it's not network — docs/TESTING.md §1).

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
  committed: z.number(), // sqlite has no boolean type, so this is stored as a 0/1 integer
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
      `SendLog.list: invalid cursor value: '${cursor}'. Use the nextCursor from a previous list() response as-is.`,
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

// Distinguishes the T6 (record-only) schema from the GAP-001 redesign (claim/commit/release) schema
// by which columns exist. PRAGMA table_info doesn't support parameter binding, but since this is
// fixed SQL with no literals, there's no injection risk. src/cli/recoverStaleClaim.ts reuses this
// as-is for its read-only lookup too (STATUS-GAP-003).
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
    "SendLog: the 'send_log' table already exists but doesn't match a known schema (v1 record or " +
      "v2 claim/commit). The DB file may be corrupted, or the table may have been created by " +
      "another tool. Back up the DB file, then inspect the send_log table structure directly.",
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
 * Moves the record()-only v1 schema used by T6 (send_status/error columns) to the claim/commit v2
 * schema from GAP-001 onward — docs/ADVERSARIAL_REVIEW_003_STATUS_GAPS.md STATUS-GAP-001.
 *
 * - Only rows with send_status='sent' are moved over, as confirmed records with committed=1. That
 *   way an email that was actually sent in the past still reads as wasSent()=true / claim()=false
 *   after migration, preventing a duplicate send.
 * - Rows with send_status='failed'/'skipped_duplicate' are not moved. Under v1, the UNIQUE
 *   constraint meant that once a key was recorded as a failure, it could never be retried again
 *   (this is exactly the bug AR-011/GAP-001 set out to fix) — that bug must not be carried over
 *   into the new schema.
 * - A fresh migration-only claim_token is issued for each row, since it isn't used for real
 *   ownership verification (these are historical records; nobody will ever call commit/release with
 *   that token).
 * - The old table isn't dropped — it's preserved, renamed to send_log_v1_backup_<timestamp>.
 * - Everything is wrapped in a single transaction, so if it fails partway through (e.g. a conflict
 *   with a send_log_new temp table left behind by a previously interrupted migration),
 *   better-sqlite3 automatically rolls back and restores the original send_log untouched — this
 *   avoids leaving data in a partially-migrated, mixed state.
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
        "A 'send_log_new' temp table already exists. A previous migration attempt may have been " +
          "interrupted partway through. Back up the DB file, inspect the send_log_new table's " +
          "contents, and if it isn't needed, drop it with 'DROP TABLE send_log_new;' and restart " +
          "the server.",
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
      `SendLog migration failed: could not migrate the existing send_log (v1) schema to the new ` +
        `schema (v2) — ${msg} The transaction was rolled back, so the original send_log table was ` +
        "preserved unchanged. Resolve the cause above, then restart the server.",
    );
  }
  // stdout is reserved for MCP JSON-RPC framing, so this is logged to stderr (console.error) only.
  console.error(
    `[sheet-mcp] SendLog: detected an old (v1) send_log schema and migrated it to the new (v2) ` +
      `schema. Only ${result.migratedCount} past 'sent' record(s) were moved over ` +
      `(failed/skipped_duplicate were not moved), and the original table was preserved as ` +
      `'${result.backupTableName}'.`,
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
      // STATUS-GAP-001: this used to just tell the operator to "delete it and recreate" — in
      // practice a destructive instruction that would wipe past send history and risk resending.
      // Now it auto-converts while preserving the existing data.
      migrateV1ToV2(this.db);
    }
    // v2_claim: already the current schema, so nothing to do.
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

  // The INSERT itself is the atomic claim boundary: SQLite decides whether the UNIQUE constraint
  // is violated within this single statement, so there's no window for another process to slip in
  // between, the way there would be with a "check first, then insert" approach.
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
    // The committed = 0 condition must be included — even with a matching token, a row that's
    // already committed can't be committed again (claimed→sent must happen exactly once). A second
    // commit() call is a caller bug, so it's reported as an error instead of silently overwriting
    // (hardened during re-verification).
    const result = this.db
      .prepare<[string, string | null, string, string, string, string, string]>(
        `UPDATE send_log SET committed = 1, sent_at = ?, message_id = ?
         WHERE sheet_id = ? AND tab = ? AND row_key = ? AND template_hash = ? AND claim_token = ?
           AND committed = 0`,
      )
      .run(sentAt, messageId ?? null, sheetId, tab, rowKey, templateHash, token);
    if (result.changes === 0) {
      throw new Error(
        `SendLog.commit: attempted to commit ` +
          `(sheetId='${sheetId}', tab='${tab}', rowKey='${rowKey}', templateHash='${templateHash}') ` +
          "which was not claimed, whose token didn't match, or which was already committed. " +
          "Either commit() was called without claim(), the same claim was committed twice, or it " +
          "was reclaimed by forceReleaseStaleClaim() and replaced with a different claim in the " +
          "meantime.",
      );
    }
  }

  release(sheetId: string, tab: string, rowKey: string, templateHash: string, token: string): void {
    // Only deletes a row whose token matches AND that is **not yet committed (committed = 0)**. If
    // it's already gone, was replaced by a different claim, or the token matches but the record is
    // already committed (a confirmed send), this is a silent no-op — a confirmed record must never
    // be deleted by release() either (found during re-verification: without the committed check, a
    // stray release() called after a successful commit would wipe out the just-confirmed send
    // record, making wasSent() return false and reopening the door to a duplicate send — the same
    // principle by which forceReleaseStaleClaim() never touches committed records).
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
    // Negative/NaN/Infinity/non-integer values are rejected before touching any claim
    // (STATUS-GAP-002) — if validation fails, neither the cutoffIso calculation nor the DELETE
    // runs.
    assertValidStaleClaimThreshold(olderThanMs);
    // Only deletes a row where committed=0 (a claim not yet confirmed) AND sent_at (=claim time)
    // is older than the cutoff — a confirmed (sent) record is never touched, under any
    // circumstance.
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

  // AR-015/GAP-006: fetches limit+1 rows so it can determine exactly (not approximately) whether
  // there's a next page, and supports continuing from a cursor (the last id seen). Returns newest
  // first.
  list(sheetId: string, options: SendLogListOptions = {}): SendLogListResult {
    // The MCP boundary (sendLogLimitSchema) already only allows positive integers, but SendLog is
    // an interface that can be called directly without that zod validation, so 0/negative values
    // are always treated as a request for at least 1 record (hardened during re-verification —
    // passing a negative limit straight through to SQL LIMIT would let SQLite interpret it as
    // "LIMIT -1 = unlimited", reopening exactly the unbounded-response hole AR-015 was meant to
    // close).
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

  /** Closes the DB file handle. Call this on test/process shutdown (docs/ADVERSARIAL_REVIEW_003.md AR-018). */
  close(): void {
    this.db.close();
  }
}
