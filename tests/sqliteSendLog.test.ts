// Verifies SqliteSendLog against a temp file DB (file IO is allowed, it's not network —
// docs/TESTING.md §1).
// Background on claim/commit/release + ownership tokens + expiry-based manual recovery + cursor
// pagination:
// docs/ADVERSARIAL_REVIEW_003.md AR-011/AR-013/AR-015,
// docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md GAP-001/002/003/006,
// docs/ADVERSARIAL_REVIEW_003_STATUS_GAPS.md STATUS-GAP-001/002.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteSendLog } from "../src/adapters/sqliteSendLog.js";

const SHEET = "sheet-1";
const TAB = "customers";
const HASH = "abc123def456";
const CLAIMED_AT = "2026-09-01T00:00:00.000Z";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sheet-mcp-sendlog-"));
  dbPath = join(tmpDir, "sendlog.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** claim() + commit() in one go — quickly creates "one already-confirmed sent row". */
function commitOne(log: SqliteSendLog, sheetId: string, rowKey: string, sentAt: string): void {
  const { token } = log.claim(sheetId, TAB, rowKey, HASH, sentAt);
  log.commit(sheetId, TAB, rowKey, HASH, token!, sentAt, undefined);
}

describe("SqliteSendLog", () => {
  it("creates the DB file and auto-creates the directory even if given a nonexistent directory path", () => {
    const nestedPath = join(tmpDir, "nested", "dir", "sendlog.db");
    const log = new SqliteSendLog(nestedPath);
    try {
      expect(existsSync(nestedPath)).toBe(true);
    } finally {
      log.close();
    }
  });

  it("wasSent is false before claiming", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(false);
    } finally {
      log.close();
    }
  });

  it("claim is claimed=true+token the first time; claiming the same key again is claimed=false (AR-011)", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      const first = log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
      expect(first.claimed).toBe(true);
      expect(first.token).toBeTruthy();

      const second = log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
      expect(second.claimed).toBe(false);
    } finally {
      log.close();
    }
  });

  it("wasSent is true even right after claim (before commit)", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
      expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(true);
    } finally {
      log.close();
    }
  });

  it(
    "GAP-001: if commit/release are never called after claim (as if the process died), " +
      "list() shows sendStatus='claimed' (not mislabeled as sent)",
    () => {
      const log = new SqliteSendLog(dbPath);
      try {
        log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);

        const { entries } = log.list(SHEET);
        expect(entries).toHaveLength(1);
        expect(entries[0]?.sendStatus).toBe("claimed");
        expect(entries[0]?.messageId).toBeUndefined();
      } finally {
        log.close();
      }
    },
  );

  it("after commit, list shows the final record with sendStatus='sent'+messageId reflected", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      const { token } = log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
      log.commit(SHEET, TAB, "CUST-001", HASH, token!, "2026-09-01T00:00:05.000Z", "msg-1");

      const { entries } = log.list(SHEET);
      expect(entries[0]).toEqual({
        sheetId: SHEET,
        tab: TAB,
        rowKey: "CUST-001",
        templateHash: HASH,
        sendStatus: "sent",
        sentAt: "2026-09-01T00:00:05.000Z",
        messageId: "msg-1",
      });
    } finally {
      log.close();
    }
  });

  it("committing without claiming throws an explicit error", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      expect(() =>
        log.commit(SHEET, TAB, "CUST-001", HASH, "no-such-token", CLAIMED_AT, "msg-1"),
      ).toThrow(/was not claimed, whose token didn't match/);
    } finally {
      log.close();
    }
  });

  it("commit is rejected when the token doesn't match (GAP-001)", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
      expect(() =>
        log.commit(SHEET, TAB, "CUST-001", HASH, "wrong-token", CLAIMED_AT, "msg-1"),
      ).toThrow(/was not claimed, whose token didn't match/);
    } finally {
      log.close();
    }
  });

  it("after release(correct token), wasSent becomes false again and the same key can be re-claimed", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      const { token } = log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
      log.release(SHEET, TAB, "CUST-001", HASH, token!);

      expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(false);
      expect(log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT).claimed).toBe(true);
    } finally {
      log.close();
    }
  });

  it("release(wrong token) is silently ignored and doesn't delete the existing claim (GAP-001)", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
      expect(() => log.release(SHEET, TAB, "CUST-001", HASH, "wrong-token")).not.toThrow();
      expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(true);
    } finally {
      log.close();
    }
  });

  it(
    "GAP-009 (found during re-verification): even with a matching token, a record already " +
      "committed (sent) is not deleted by release() — this prevents an accident where a confirmed " +
      "send record disappears and becomes eligible for a duplicate send",
    () => {
      const log = new SqliteSendLog(dbPath);
      try {
        const { token } = log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
        log.commit(SHEET, TAB, "CUST-001", HASH, token!, CLAIMED_AT, "msg-1");

        expect(() => log.release(SHEET, TAB, "CUST-001", HASH, token!)).not.toThrow();

        expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(true);
        const { entries } = log.list(SHEET);
        expect(entries[0]?.sendStatus).toBe("sent");
        expect(entries[0]?.messageId).toBe("msg-1");
      } finally {
        log.close();
      }
    },
  );

  it(
    "GAP-009 (found during re-verification): calling commit() twice with the same token errors " +
      "the second time — the claimed→sent transition must happen exactly once",
    () => {
      const log = new SqliteSendLog(dbPath);
      try {
        const { token } = log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
        log.commit(SHEET, TAB, "CUST-001", HASH, token!, CLAIMED_AT, "msg-1");

        expect(() => log.commit(SHEET, TAB, "CUST-001", HASH, token!, CLAIMED_AT, "msg-2")).toThrow(
          /was not claimed, whose token didn't match, or which was already committed/,
        );
        expect(log.list(SHEET).entries[0]?.messageId).toBe("msg-1");
      } finally {
        log.close();
      }
    },
  );

  describe("forceReleaseStaleClaim (GAP-001 manual recovery)", () => {
    it("does not reclaim a claim that is still younger than the expiry threshold", () => {
      const log = new SqliteSendLog(dbPath);
      try {
        const recentClaimedAt = new Date(Date.now() - 1000).toISOString();
        log.claim(SHEET, TAB, "CUST-001", HASH, recentClaimedAt);

        expect(log.forceReleaseStaleClaim(SHEET, TAB, "CUST-001", HASH, 60 * 60 * 1000)).toBe(
          false,
        );
        expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(true);
      } finally {
        log.close();
      }
    });

    it("reclaims an (uncommitted) claim older than the expiry threshold and allows re-claiming", () => {
      const log = new SqliteSendLog(dbPath);
      try {
        const oldClaimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        log.claim(SHEET, TAB, "CUST-001", HASH, oldClaimedAt);

        expect(log.forceReleaseStaleClaim(SHEET, TAB, "CUST-001", HASH, 60 * 60 * 1000)).toBe(true);
        expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(false);
        expect(log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT).claimed).toBe(true);
      } finally {
        log.close();
      }
    });

    it("never reclaims an already-committed (sent) claim, no matter how old", () => {
      const log = new SqliteSendLog(dbPath);
      try {
        const oldClaimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        const { token } = log.claim(SHEET, TAB, "CUST-001", HASH, oldClaimedAt);
        log.commit(SHEET, TAB, "CUST-001", HASH, token!, oldClaimedAt, "msg-1");

        expect(log.forceReleaseStaleClaim(SHEET, TAB, "CUST-001", HASH, 60 * 60 * 1000)).toBe(
          false,
        );
        expect(log.list(SHEET).entries[0]?.sendStatus).toBe("sent");
      } finally {
        log.close();
      }
    });
  });

  it("allows a separate claim for the same row when templateHash differs (resend after template edit)", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      expect(log.claim(SHEET, TAB, "CUST-001", "hash-v1", CLAIMED_AT).claimed).toBe(true);
      expect(log.claim(SHEET, TAB, "CUST-001", "hash-v2", CLAIMED_AT).claimed).toBe(true);
      expect(log.list(SHEET).entries).toHaveLength(2);
    } finally {
      log.close();
    }
  });

  describe("list — newest-first + cursor pagination (GAP-006)", () => {
    it("hasMore is exact (not approximate) at the 199/200/201-record boundary", () => {
      const log = new SqliteSendLog(dbPath);
      try {
        for (let i = 0; i < 199; i += 1) commitOne(log, SHEET, `R-${String(i)}`, `t${String(i)}`);
        expect(log.list(SHEET, { limit: 200 }).hasMore).toBe(false);
      } finally {
        log.close();
      }

      const dbPath200 = join(tmpDir, "sendlog-200.db");
      const log200 = new SqliteSendLog(dbPath200);
      try {
        for (let i = 0; i < 200; i += 1)
          commitOne(log200, SHEET, `R-${String(i)}`, `t${String(i)}`);
        const result = log200.list(SHEET, { limit: 200 });
        expect(result.hasMore).toBe(false);
        expect(result.entries).toHaveLength(200);
      } finally {
        log200.close();
      }

      const dbPath201 = join(tmpDir, "sendlog-201.db");
      const log201 = new SqliteSendLog(dbPath201);
      try {
        for (let i = 0; i < 201; i += 1)
          commitOne(log201, SHEET, `R-${String(i)}`, `t${String(i)}`);
        const result = log201.list(SHEET, { limit: 200 });
        expect(result.hasMore).toBe(true);
        expect(result.entries).toHaveLength(200);
        expect(result.nextCursor).toBeTruthy();
      } finally {
        log201.close();
      }
    });

    it("can page through two or more pages via nextCursor without duplicates or gaps", () => {
      const log = new SqliteSendLog(dbPath);
      try {
        for (let i = 0; i < 5; i += 1) commitOne(log, SHEET, `R-${String(i)}`, `t${String(i)}`);

        const page1 = log.list(SHEET, { limit: 2 });
        expect(page1.entries.map((r) => r.rowKey)).toEqual(["R-4", "R-3"]);
        expect(page1.hasMore).toBe(true);

        const page2 = log.list(SHEET, { limit: 2, cursor: page1.nextCursor });
        expect(page2.entries.map((r) => r.rowKey)).toEqual(["R-2", "R-1"]);

        const page3 = log.list(SHEET, { limit: 2, cursor: page2.nextCursor });
        expect(page3.entries.map((r) => r.rowKey)).toEqual(["R-0"]);
        expect(page3.hasMore).toBe(false);

        const all = [...page1.entries, ...page2.entries, ...page3.entries].map((r) => r.rowKey);
        expect(all).toEqual(["R-4", "R-3", "R-2", "R-1", "R-0"]);
      } finally {
        log.close();
      }
    });

    it("an invalid cursor value throws an explicit error", () => {
      const log = new SqliteSendLog(dbPath);
      try {
        expect(() => log.list(SHEET, { cursor: "not-a-number" })).toThrow(/invalid cursor value/);
      } finally {
        log.close();
      }
    });

    it(
      "found during re-verification: a negative limit doesn't leak through as SQLite's " +
        "'LIMIT -1 = unlimited' meaning, and is instead treated as a minimum of 1 record",
      () => {
        const log = new SqliteSendLog(dbPath);
        try {
          for (let i = 0; i < 5; i += 1) commitOne(log, SHEET, `R-${String(i)}`, `t${String(i)}`);
          expect(log.list(SHEET, { limit: -1 }).entries).toHaveLength(1);
        } finally {
          log.close();
        }
      },
    );
  });

  it("records persist across closing the DB and reopening the same file path (persistence)", () => {
    const first = new SqliteSendLog(dbPath);
    commitOne(first, SHEET, "CUST-001", CLAIMED_AT);
    first.close();

    const second = new SqliteSendLog(dbPath);
    try {
      expect(second.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(true);
      expect(second.list(SHEET).entries).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it("uses the SEND_LOG_PATH environment variable when dbPath is omitted", () => {
    const original = process.env.SEND_LOG_PATH;
    process.env.SEND_LOG_PATH = dbPath;
    try {
      const log = new SqliteSendLog();
      try {
        log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
        expect(existsSync(dbPath)).toBe(true);
      } finally {
        log.close();
      }
    } finally {
      if (original === undefined) delete process.env.SEND_LOG_PATH;
      else process.env.SEND_LOG_PATH = original;
    }
  });

  it(
    "separate SqliteSendLog instances looking at the same DB file also block each other's claims " +
      "(AR-011 — a scenario mimicking concurrent execution when different processes open the same file)",
    () => {
      const first = new SqliteSendLog(dbPath);
      const second = new SqliteSendLog(dbPath);
      try {
        expect(first.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT).claimed).toBe(true);
        // second is a separate instance (mimicking a separate process), but since it shares the
        // same file's UNIQUE constraint, claiming the exact same key must fail.
        expect(second.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT).claimed).toBe(false);
      } finally {
        first.close();
        second.close();
      }
    },
  );

  it("close() is idempotent — calling it twice throws no error (GAP-008)", () => {
    const log = new SqliteSendLog(dbPath);
    log.close();
    expect(() => log.close()).not.toThrow();
  });

  it(
    "resources don't accumulate from repeatedly opening and closing the same file (GAP-008 — a " +
      "regression guard mimicking a long-lived process that repeatedly creates/tears down SendLog)",
    () => {
      for (let i = 0; i < 50; i += 1) {
        const log = new SqliteSendLog(dbPath);
        const { token } = log.claim(SHEET, TAB, `R-${String(i)}`, HASH, CLAIMED_AT);
        log.commit(SHEET, TAB, `R-${String(i)}`, HASH, token!, CLAIMED_AT, undefined);
        log.close();
      }

      // Even after 50 iterations, the file must open normally with every record intact (no fd
      // exhaustion or corruption).
      const verify = new SqliteSendLog(dbPath);
      try {
        expect(verify.list(SHEET, { limit: 100 }).entries).toHaveLength(50);
      } finally {
        verify.close();
      }
    },
  );

  describe("v1 (T6 record) → v2 (claim/commit) automatic migration (STATUS-GAP-001)", () => {
    /** Directly builds a DB file with the T6-era record()-only schema — a migration input fixture. */
    function createLegacyV1Db(path: string): Database.Database {
      const db = new Database(path);
      db.exec(`
        CREATE TABLE send_log (
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
      return db;
    }

    it("a previous send_status='sent' record is moved as committed=1, so wasSent/claim prevent a resend", () => {
      const legacy = createLegacyV1Db(dbPath);
      legacy
        .prepare(
          `INSERT INTO send_log (sheet_id, tab, row_key, template_hash, send_status, sent_at, message_id, error)
           VALUES (?, ?, ?, ?, 'sent', ?, ?, NULL)`,
        )
        .run(SHEET, TAB, "CUST-001", HASH, "2026-08-01T00:00:00.000Z", "legacy-msg-1");
      legacy.close();

      const log = new SqliteSendLog(dbPath);
      try {
        expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(true);
        expect(log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT).claimed).toBe(false);

        const { entries } = log.list(SHEET);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toEqual({
          sheetId: SHEET,
          tab: TAB,
          rowKey: "CUST-001",
          templateHash: HASH,
          sendStatus: "sent",
          sentAt: "2026-08-01T00:00:00.000Z",
          messageId: "legacy-msg-1",
        });
      } finally {
        log.close();
      }
    });

    it("previous send_status='failed'/'skipped_duplicate' records are not moved, so a retry isn't blocked", () => {
      const legacy = createLegacyV1Db(dbPath);
      legacy
        .prepare(
          `INSERT INTO send_log (sheet_id, tab, row_key, template_hash, send_status, sent_at, message_id, error)
           VALUES (?, ?, ?, ?, 'failed', ?, NULL, 'provider error')`,
        )
        .run(SHEET, TAB, "CUST-FAILED", HASH, "2026-08-01T00:00:00.000Z");
      legacy
        .prepare(
          `INSERT INTO send_log (sheet_id, tab, row_key, template_hash, send_status, sent_at, message_id, error)
           VALUES (?, ?, ?, ?, 'skipped_duplicate', ?, NULL, NULL)`,
        )
        .run(SHEET, TAB, "CUST-SKIPPED", HASH, "2026-08-01T00:00:00.000Z");
      legacy.close();

      const log = new SqliteSendLog(dbPath);
      try {
        expect(log.wasSent(SHEET, TAB, "CUST-FAILED", HASH)).toBe(false);
        expect(log.claim(SHEET, TAB, "CUST-FAILED", HASH, CLAIMED_AT).claimed).toBe(true);
        expect(log.wasSent(SHEET, TAB, "CUST-SKIPPED", HASH)).toBe(false);
        expect(log.claim(SHEET, TAB, "CUST-SKIPPED", HASH, CLAIMED_AT).claimed).toBe(true);
      } finally {
        log.close();
      }
    });

    it("after migration, the original v1 table is not dropped and is preserved as send_log_v1_backup_*", () => {
      const legacy = createLegacyV1Db(dbPath);
      legacy
        .prepare(
          `INSERT INTO send_log (sheet_id, tab, row_key, template_hash, send_status, sent_at, message_id, error)
           VALUES (?, ?, ?, ?, 'sent', ?, ?, NULL)`,
        )
        .run(SHEET, TAB, "CUST-001", HASH, "2026-08-01T00:00:00.000Z", "legacy-msg-1");
      legacy.close();

      const log = new SqliteSendLog(dbPath);
      log.close();

      const raw = new Database(dbPath);
      try {
        const backupTables = raw
          .prepare<[], { name: string }>(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'send_log_v1_backup_%'`,
          )
          .all();
        expect(backupTables).toHaveLength(1);
        const backupName = backupTables[0]?.name;
        expect(backupName).toBeTruthy();
        const backupRows = raw.prepare(`SELECT * FROM "${String(backupName)}"`).all();
        expect(backupRows).toHaveLength(1);
      } finally {
        raw.close();
      }
    });

    it(
      "if a send_log_new temp table left behind by a previously interrupted migration exists, " +
        "migration is refused and the original send_log (v1) is preserved unchanged (transaction rollback)",
      () => {
        const legacy = createLegacyV1Db(dbPath);
        legacy
          .prepare(
            `INSERT INTO send_log (sheet_id, tab, row_key, template_hash, send_status, sent_at, message_id, error)
             VALUES (?, ?, ?, ?, 'sent', ?, ?, NULL)`,
          )
          .run(SHEET, TAB, "CUST-001", HASH, "2026-08-01T00:00:00.000Z", "legacy-msg-1");
        legacy.exec(`CREATE TABLE send_log_new (leftover TEXT);`);
        legacy.close();

        expect(() => new SqliteSendLog(dbPath)).toThrow(/SendLog migration failed/);

        const raw = new Database(dbPath);
        try {
          const cols = raw.prepare(`PRAGMA table_info(send_log)`).all() as { name: string }[];
          expect(cols.map((c) => c.name)).toContain("send_status");
          const rows = raw.prepare(`SELECT * FROM send_log`).all();
          expect(rows).toHaveLength(1);
        } finally {
          raw.close();
        }
      },
    );

    it("a DB already built with the v2 (claim/commit) schema opens as-is, with no migration", () => {
      const first = new SqliteSendLog(dbPath);
      const { token } = first.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
      first.commit(SHEET, TAB, "CUST-001", HASH, token!, CLAIMED_AT, "msg-1");
      first.close();

      const second = new SqliteSendLog(dbPath);
      try {
        expect(second.list(SHEET).entries).toHaveLength(1);
        expect(second.list(SHEET).entries[0]?.messageId).toBe("msg-1");
      } finally {
        second.close();
      }

      const raw = new Database(dbPath);
      try {
        const backupTables = raw
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%backup%'`)
          .all();
        expect(backupTables).toHaveLength(0);
      } finally {
        raw.close();
      }
    });

    it("an unknown (neither v1 nor v2) send_log schema throws an explicit error", () => {
      const weird = new Database(dbPath);
      weird.exec(`CREATE TABLE send_log (id INTEGER PRIMARY KEY, whatever TEXT);`);
      weird.close();

      expect(() => new SqliteSendLog(dbPath)).toThrow(/doesn't match a known schema/);
    });
  });

  describe("forceReleaseStaleClaim's olderThanMs input validation (STATUS-GAP-002)", () => {
    it.each([-1, NaN, Infinity, -Infinity, 1.5])(
      "olderThanMs=%p throws immediately without deleting any claim",
      (invalid) => {
        const log = new SqliteSendLog(dbPath);
        try {
          const recentClaimedAt = new Date(Date.now() - 100).toISOString();
          log.claim(SHEET, TAB, "CUST-001", HASH, recentClaimedAt);

          expect(() => log.forceReleaseStaleClaim(SHEET, TAB, "CUST-001", HASH, invalid)).toThrow(
            /invalid olderThanMs value/,
          );
          // Since validation failed, the claim must remain intact.
          expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(true);
        } finally {
          log.close();
        }
      },
    );

    it("olderThanMs=0 is allowed as a valid value, since it's an integer >= 0", () => {
      const log = new SqliteSendLog(dbPath);
      try {
        const oldClaimedAt = new Date(Date.now() - 1000).toISOString();
        log.claim(SHEET, TAB, "CUST-001", HASH, oldClaimedAt);
        expect(log.forceReleaseStaleClaim(SHEET, TAB, "CUST-001", HASH, 0)).toBe(true);
      } finally {
        log.close();
      }
    });
  });
});
