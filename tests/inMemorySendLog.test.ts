// InMemorySendLog — claim/commit/release + 소유권 토큰 + 만료 기반 수동 복구 + cursor
// 페이지네이션 계약 검증 (docs/ADVERSARIAL_REVIEW_003.md AR-011/AR-013,
// docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md GAP-001/002/003/006).

import { describe, expect, it } from "vitest";
import { InMemorySendLog } from "../src/mocks/inMemorySendLog.js";

const SHEET = "sheet-1";
const TAB = "customers";
const HASH = "abc123def456";
const CLAIMED_AT = "2026-09-01T00:00:00.000Z";

describe("InMemorySendLog", () => {
  it("claim 전에는 wasSent가 false다", () => {
    const log = new InMemorySendLog();
    expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(false);
  });

  it("claim은 처음엔 claimed=true+token, 같은 키로 다시 claim하면 claimed=false다(AR-011)", () => {
    const log = new InMemorySendLog();
    const first = log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
    expect(first.claimed).toBe(true);
    expect(first.token).toBeTruthy();

    const second = log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
    expect(second.claimed).toBe(false);
    expect(second.token).toBeUndefined();
  });

  it("claim 직후(commit 전)에도 wasSent는 true다 — 예약 자체가 중복 방지 신호다", () => {
    const log = new InMemorySendLog();
    log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
    expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(true);
  });

  it(
    "GAP-001: claim 후 프로세스가 죽은 것처럼 commit/release를 전혀 안 부르면 " +
      "list()에 sendStatus='claimed'로(sent로 둔갑하지 않고) 보인다",
    () => {
      const log = new InMemorySendLog();
      log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
      // commit()도 release()도 호출하지 않는다 — 프로세스 중단을 흉내낸다.

      const { entries } = log.list(SHEET);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.sendStatus).toBe("claimed");
      expect(entries[0]?.messageId).toBeUndefined();
    },
  );

  it("commit 후에는 list에 sendStatus='sent'+messageId가 반영된 최종 기록이 남는다", () => {
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

  it("claim 없이 commit하면 명시적으로 에러를 던진다", () => {
    const log = new InMemorySendLog();
    expect(() =>
      log.commit(SHEET, TAB, "CUST-001", HASH, "no-such-token", CLAIMED_AT, "msg-1"),
    ).toThrow(/claim되지 않았거나 token이 일치하지 않는/);
  });

  it("token이 일치하지 않으면 commit이 거부된다(GAP-001 — 좀비 프로세스가 남의 claim을 확정하지 못하게)", () => {
    const log = new InMemorySendLog();
    log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
    expect(() =>
      log.commit(SHEET, TAB, "CUST-001", HASH, "wrong-token", CLAIMED_AT, "msg-1"),
    ).toThrow(/claim되지 않았거나 token이 일치하지 않는/);
  });

  it("release(올바른 token) 후에는 wasSent가 다시 false가 되고, 같은 키로 재claim할 수 있다", () => {
    const log = new InMemorySendLog();
    const { token } = log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
    log.release(SHEET, TAB, "CUST-001", HASH, token!);

    expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(false);
    expect(log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT).claimed).toBe(true);
  });

  it("release(잘못된 token)는 조용히 무시하고 기존 claim을 지우지 않는다(GAP-001)", () => {
    const log = new InMemorySendLog();
    log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
    expect(() => log.release(SHEET, TAB, "CUST-001", HASH, "wrong-token")).not.toThrow();
    // 여전히 claim된 상태로 남아 있어야 한다 — 잘못된 token으로 지워지지 않았다는 뜻.
    expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(true);
  });

  it("존재하지 않는 키를 release해도 조용히 무시한다", () => {
    const log = new InMemorySendLog();
    expect(() => log.release(SHEET, TAB, "NO-SUCH", HASH, "any-token")).not.toThrow();
  });

  describe("forceReleaseStaleClaim (GAP-001 수동 복구)", () => {
    it("아직 만료 기준보다 젊은 claim은 회수하지 않는다(false 반환, 안전 쪽으로 fail)", () => {
      const log = new InMemorySendLog();
      const recentClaimedAt = new Date(Date.now() - 1000).toISOString(); // 1초 전
      log.claim(SHEET, TAB, "CUST-001", HASH, recentClaimedAt);

      const released = log.forceReleaseStaleClaim(SHEET, TAB, "CUST-001", HASH, 60 * 60 * 1000); // 1시간
      expect(released).toBe(false);
      expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(true);
    });

    it("만료 기준보다 오래된(commit 안 된) claim은 회수하고 재claim을 허용한다", () => {
      const log = new InMemorySendLog();
      const oldClaimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2시간 전
      log.claim(SHEET, TAB, "CUST-001", HASH, oldClaimedAt);

      const released = log.forceReleaseStaleClaim(SHEET, TAB, "CUST-001", HASH, 60 * 60 * 1000); // 1시간
      expect(released).toBe(true);
      expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(false);
      expect(log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT).claimed).toBe(true);
    });

    it("이미 commit된(sent) claim은 아무리 오래됐어도 회수하지 않는다 — 확정 기록은 절대 안 건드림", () => {
      const log = new InMemorySendLog();
      const oldClaimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const { token } = log.claim(SHEET, TAB, "CUST-001", HASH, oldClaimedAt);
      log.commit(SHEET, TAB, "CUST-001", HASH, token!, oldClaimedAt, "msg-1");

      const released = log.forceReleaseStaleClaim(SHEET, TAB, "CUST-001", HASH, 60 * 60 * 1000);
      expect(released).toBe(false);
      expect(log.list(SHEET).entries[0]?.sendStatus).toBe("sent");
    });

    it("존재하지 않는 키는 false를 반환한다", () => {
      const log = new InMemorySendLog();
      expect(log.forceReleaseStaleClaim(SHEET, TAB, "NO-SUCH", HASH, 0)).toBe(false);
    });
  });

  describe("list — 최신순 + cursor 페이지네이션 (GAP-006)", () => {
    it("list는 해당 sheetId의 기록만, 최신 것부터 반환한다", () => {
      const log = new InMemorySendLog();
      commitOne(log, SHEET, "A", "t1");
      commitOne(log, "sheet-2", "B", "t2");
      commitOne(log, SHEET, "C", "t3");

      const { entries } = log.list(SHEET);
      expect(entries.map((r) => r.rowKey)).toEqual(["C", "A"]);
    });

    it("199/200/201건 경계에서 hasMore가 정확하다(근사치 아님)", () => {
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

    it("nextCursor로 두 페이지 이상을 중복·누락 없이 순회할 수 있다", () => {
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
      expect(all).toEqual(["R-4", "R-3", "R-2", "R-1", "R-0"]); // 중복도 누락도 없음
    });

    it("잘못된 cursor 값은 명시적으로 에러를 던진다", () => {
      const log = new InMemorySendLog();
      expect(() => log.list(SHEET, { cursor: "not-a-number" })).toThrow(
        /cursor 값이 올바르지 않습니다/,
      );
    });
  });

  it("templateHash가 다르면 같은 행이라도 별도 claim으로 허용한다 (템플릿 수정 후 재발송)", () => {
    const log = new InMemorySendLog();
    expect(log.claim(SHEET, TAB, "CUST-001", "hash-v1", CLAIMED_AT).claimed).toBe(true);
    expect(log.claim(SHEET, TAB, "CUST-001", "hash-v2", CLAIMED_AT).claimed).toBe(true);
    expect(log.wasSent(SHEET, TAB, "CUST-001", "hash-v1")).toBe(true);
    expect(log.wasSent(SHEET, TAB, "CUST-001", "hash-v2")).toBe(true);
  });

  it("sheetId/tab/rowKey 중 하나만 달라도 별도 키로 취급한다", () => {
    const log = new InMemorySendLog();
    expect(log.claim(SHEET, "customers", "CUST-001", HASH, CLAIMED_AT).claimed).toBe(true);
    expect(log.claim(SHEET, "orders", "CUST-001", HASH, CLAIMED_AT).claimed).toBe(true);
    expect(log.claim(SHEET, "customers", "CUST-002", HASH, CLAIMED_AT).claimed).toBe(true);
  });
});

/** claim() + commit()을 한 번에 — 테스트에서 "이미 확정 발송된 행 하나"를 빠르게 만들기 위한 헬퍼. */
function commitOne(log: InMemorySendLog, sheetId: string, rowKey: string, sentAt: string): void {
  const { token } = log.claim(sheetId, TAB, rowKey, HASH, sentAt);
  log.commit(sheetId, TAB, rowKey, HASH, token!, sentAt, undefined);
}
