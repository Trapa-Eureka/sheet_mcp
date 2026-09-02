// InMemorySendLog — verifies the claim/commit/release + ownership token + expiry-based manual
// recovery + cursor pagination contract (docs/ADVERSARIAL_REVIEW_003.md AR-011/AR-013,
// docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md GAP-001/002/003/006).

import { describe, expect, it } from "vitest";
import { InMemorySendLog } from "../src/mocks/inMemorySendLog.js";

const SHEET = "sheet-1";
const TAB = "customers";
const HASH = "abc123def456";
const CLAIMED_AT = "2026-09-01T00:00:00.000Z";

describe("InMemorySendLog", () => {
  it("wasSent is false before claim", () => {
    const log = new InMemorySendLog();
    expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(false);
  });

  it("claim returns claimed=true+token the first time, claimed=false claiming the same key again (AR-011)", () => {
    const log = new InMemorySendLog();
    const first = log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
    expect(first.claimed).toBe(true);
    expect(first.token).toBeTruthy();

    const second = log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
    expect(second.claimed).toBe(false);
    expect(second.token).toBeUndefined();
  });

  it("wasSent is true right after claim (before commit) — the reservation itself signals a duplicate", () => {
    const log = new InMemorySendLog();
    log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
    expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(true);
  });

  it(
    "GAP-001: if commit/release is never called after claim, as if the process died, " +
      "list() shows sendStatus='claimed' (it does not masquerade as sent)",
    () => {
      const log = new InMemorySendLog();
      log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
      // Neither commit() nor release() is called — simulating a process that stopped mid-flight.

      const { entries } = log.list(SHEET);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.sendStatus).toBe("claimed");
      expect(entries[0]?.messageId).toBeUndefined();
    },
  );

  it("after commit, list shows the final record reflecting sendStatus='sent'+messageId", () => {
    const log = new InMemorySendLog();
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
  });

  it("commit without a claim throws an explicit error", () => {
    const log = new InMemorySendLog();
    expect(() =>
      log.commit(SHEET, TAB, "CUST-001", HASH, "no-such-token", CLAIMED_AT, "msg-1"),
    ).toThrow(/that was not claimed, token did not match/);
  });

  it("commit is rejected when the token does not match (GAP-001 — prevents a zombie process from confirming someone else's claim)", () => {
    const log = new InMemorySendLog();
    log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
    expect(() =>
      log.commit(SHEET, TAB, "CUST-001", HASH, "wrong-token", CLAIMED_AT, "msg-1"),
    ).toThrow(/that was not claimed, token did not match/);
  });

  it("after release(correct token), wasSent becomes false again and the same key can be re-claimed", () => {
    const log = new InMemorySendLog();
    const { token } = log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
    log.release(SHEET, TAB, "CUST-001", HASH, token!);

    expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(false);
    expect(log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT).claimed).toBe(true);
  });

  it("release(wrong token) is silently ignored and does not delete the existing claim (GAP-001)", () => {
    const log = new InMemorySendLog();
    log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
    expect(() => log.release(SHEET, TAB, "CUST-001", HASH, "wrong-token")).not.toThrow();
    // Must still remain claimed — meaning it was not deleted by the wrong token.
    expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(true);
  });

  it("releasing a nonexistent key is also silently ignored", () => {
    const log = new InMemorySendLog();
    expect(() => log.release(SHEET, TAB, "NO-SUCH", HASH, "any-token")).not.toThrow();
  });

  it(
    "GAP-009 (found during re-verification): a record already committed (sent) is not deleted by " +
      "release() even with the matching token — prevents the confirmed send record from " +
      "vanishing and enabling a resend",
    () => {
      const log = new InMemorySendLog();
      const { token } = log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
      log.commit(SHEET, TAB, "CUST-001", HASH, token!, CLAIMED_AT, "msg-1");

      // Even if release is mistakenly called with the same (correct) token — since it has
      // already been committed, this must be silently ignored.
      expect(() => log.release(SHEET, TAB, "CUST-001", HASH, token!)).not.toThrow();

      expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(true);
      expect(log.list(SHEET).entries[0]?.sendStatus).toBe("sent");
      expect(log.list(SHEET).entries[0]?.messageId).toBe("msg-1");
    },
  );

  it(
    "GAP-009 (found during re-verification): calling commit() twice with the same token errors " +
      "the second time — the claimed→sent transition must happen only once",
    () => {
      const log = new InMemorySendLog();
      const { token } = log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
      log.commit(SHEET, TAB, "CUST-001", HASH, token!, CLAIMED_AT, "msg-1");

      expect(() => log.commit(SHEET, TAB, "CUST-001", HASH, token!, CLAIMED_AT, "msg-2")).toThrow(
        /that was not claimed, token did not match, or was already committed/,
      );
      // The result of the first commit must remain unchanged (not overwritten by the second attempt).
      expect(log.list(SHEET).entries[0]?.messageId).toBe("msg-1");
    },
  );

  describe("forceReleaseStaleClaim (GAP-001 manual recovery)", () => {
    it("a claim younger than the expiry threshold is not reclaimed (returns false, fails safe)", () => {
      const log = new InMemorySendLog();
      const recentClaimedAt = new Date(Date.now() - 1000).toISOString(); // 1 second ago
      log.claim(SHEET, TAB, "CUST-001", HASH, recentClaimedAt);

      const released = log.forceReleaseStaleClaim(SHEET, TAB, "CUST-001", HASH, 60 * 60 * 1000); // 1 hour
      expect(released).toBe(false);
      expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(true);
    });

    it("a claim older than the expiry threshold (not committed) is reclaimed and allows re-claiming", () => {
      const log = new InMemorySendLog();
      const oldClaimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
      log.claim(SHEET, TAB, "CUST-001", HASH, oldClaimedAt);

      const released = log.forceReleaseStaleClaim(SHEET, TAB, "CUST-001", HASH, 60 * 60 * 1000); // 1 hour
      expect(released).toBe(true);
      expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(false);
      expect(log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT).claimed).toBe(true);
    });

    it("a claim already committed (sent) is never reclaimed no matter how old — confirmed records are never touched", () => {
      const log = new InMemorySendLog();
      const oldClaimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const { token } = log.claim(SHEET, TAB, "CUST-001", HASH, oldClaimedAt);
      log.commit(SHEET, TAB, "CUST-001", HASH, token!, oldClaimedAt, "msg-1");

      const released = log.forceReleaseStaleClaim(SHEET, TAB, "CUST-001", HASH, 60 * 60 * 1000);
      expect(released).toBe(false);
      expect(log.list(SHEET).entries[0]?.sendStatus).toBe("sent");
    });

    it("a nonexistent key returns false", () => {
      const log = new InMemorySendLog();
      expect(log.forceReleaseStaleClaim(SHEET, TAB, "NO-SUCH", HASH, 0)).toBe(false);
    });
  });

  describe("list — newest first + cursor pagination (GAP-006)", () => {
    it("list returns only records for the given sheetId, newest first", () => {
      const log = new InMemorySendLog();
      commitOne(log, SHEET, "A", "t1");
      commitOne(log, "sheet-2", "B", "t2");
      commitOne(log, SHEET, "C", "t3");

      const { entries } = log.list(SHEET);
      expect(entries.map((r) => r.rowKey)).toEqual(["C", "A"]);
    });

    it("hasMore is exact (not approximate) at the 199/200/201 boundary", () => {
      const log199 = new InMemorySendLog();
      for (let i = 0; i < 199; i += 1) commitOne(log199, SHEET, `R-${String(i)}`, `t${String(i)}`);
      expect(log199.list(SHEET, { limit: 200 }).hasMore).toBe(false);

      const log200 = new InMemorySendLog();
      for (let i = 0; i < 200; i += 1) commitOne(log200, SHEET, `R-${String(i)}`, `t${String(i)}`);
      const result200 = log200.list(SHEET, { limit: 200 });
      expect(result200.hasMore).toBe(false);
      expect(result200.entries).toHaveLength(200);

      const log201 = new InMemorySendLog();
      for (let i = 0; i < 201; i += 1) commitOne(log201, SHEET, `R-${String(i)}`, `t${String(i)}`);
      const result201 = log201.list(SHEET, { limit: 200 });
      expect(result201.hasMore).toBe(true);
      expect(result201.entries).toHaveLength(200);
      expect(result201.nextCursor).toBeTruthy();
    });

    it("nextCursor can page through two or more pages without duplicates or gaps", () => {
      const log = new InMemorySendLog();
      for (let i = 0; i < 5; i += 1) commitOne(log, SHEET, `R-${String(i)}`, `t${String(i)}`);

      const page1 = log.list(SHEET, { limit: 2 });
      expect(page1.entries.map((r) => r.rowKey)).toEqual(["R-4", "R-3"]);
      expect(page1.hasMore).toBe(true);

      const page2 = log.list(SHEET, { limit: 2, cursor: page1.nextCursor });
      expect(page2.entries.map((r) => r.rowKey)).toEqual(["R-2", "R-1"]);
      expect(page2.hasMore).toBe(true);

      const page3 = log.list(SHEET, { limit: 2, cursor: page2.nextCursor });
      expect(page3.entries.map((r) => r.rowKey)).toEqual(["R-0"]);
      expect(page3.hasMore).toBe(false);
      expect(page3.nextCursor).toBeUndefined();

      const all = [...page1.entries, ...page2.entries, ...page3.entries].map((r) => r.rowKey);
      expect(all).toEqual(["R-4", "R-3", "R-2", "R-1", "R-0"]); // no duplicates, no gaps
    });

    it("an invalid cursor value throws an explicit error", () => {
      const log = new InMemorySendLog();
      expect(() => log.list(SHEET, { cursor: "not-a-number" })).toThrow(/invalid cursor value/);
    });

    it(
      "found during re-verification: a limit of 0/negative does not leak unlimited, it is " +
        "treated as at least 1 (in SQLite, a negative LIMIT means 'unlimited', so passing it " +
        "through as-is would have been dangerous)",
      () => {
        const log = new InMemorySendLog();
        for (let i = 0; i < 5; i += 1) commitOne(log, SHEET, `R-${String(i)}`, `t${String(i)}`);

        expect(log.list(SHEET, { limit: -1 }).entries).toHaveLength(1);
        expect(log.list(SHEET, { limit: 0 }).entries.length).toBeLessThanOrEqual(1);
      },
    );
  });

  it("a different templateHash is allowed as a separate claim even for the same row (resend after template edit)", () => {
    const log = new InMemorySendLog();
    expect(log.claim(SHEET, TAB, "CUST-001", "hash-v1", CLAIMED_AT).claimed).toBe(true);
    expect(log.claim(SHEET, TAB, "CUST-001", "hash-v2", CLAIMED_AT).claimed).toBe(true);
    expect(log.wasSent(SHEET, TAB, "CUST-001", "hash-v1")).toBe(true);
    expect(log.wasSent(SHEET, TAB, "CUST-001", "hash-v2")).toBe(true);
  });

  it("differing in even just one of sheetId/tab/rowKey is treated as a separate key", () => {
    const log = new InMemorySendLog();
    expect(log.claim(SHEET, "customers", "CUST-001", HASH, CLAIMED_AT).claimed).toBe(true);
    expect(log.claim(SHEET, "orders", "CUST-001", HASH, CLAIMED_AT).claimed).toBe(true);
    expect(log.claim(SHEET, "customers", "CUST-002", HASH, CLAIMED_AT).claimed).toBe(true);
  });

  describe("forceReleaseStaleClaim olderThanMs input validation (STATUS-GAP-002)", () => {
    it.each([-1, NaN, Infinity, -Infinity, 1.5])(
      "olderThanMs=%p throws immediately without deleting any claim — uses the same shared " +
        "validation function as SqliteSendLog",
      (invalid) => {
        const log = new InMemorySendLog();
        const recentClaimedAt = new Date(Date.now() - 100).toISOString();
        log.claim(SHEET, TAB, "CUST-001", HASH, recentClaimedAt);

        expect(() => log.forceReleaseStaleClaim(SHEET, TAB, "CUST-001", HASH, invalid)).toThrow(
          /invalid olderThanMs value/,
        );
        expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(true);
      },
    );

    it("olderThanMs=0 is accepted as valid since it is an integer that is >= 0", () => {
      const log = new InMemorySendLog();
      const oldClaimedAt = new Date(Date.now() - 1000).toISOString();
      log.claim(SHEET, TAB, "CUST-001", HASH, oldClaimedAt);
      expect(log.forceReleaseStaleClaim(SHEET, TAB, "CUST-001", HASH, 0)).toBe(true);
    });
  });
});

/** claim() + commit() in one call — a helper to quickly create "one already-confirmed-sent row" in tests. */
function commitOne(log: InMemorySendLog, sheetId: string, rowKey: string, sentAt: string): void {
  const { token } = log.claim(sheetId, TAB, rowKey, HASH, sentAt);
  log.commit(sheetId, TAB, rowKey, HASH, token!, sentAt, undefined);
}
