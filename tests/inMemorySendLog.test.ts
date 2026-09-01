// InMemorySendLog — claim/commit/release 계약(docs/ADVERSARIAL_REVIEW_003.md AR-011/AR-013) 검증.

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

  it("claim은 처음엔 true, 같은 키로 다시 claim하면 false다(AR-011)", () => {
    const log = new InMemorySendLog();
    expect(log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT)).toBe(true);
    expect(log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT)).toBe(false);
  });

  it("claim 직후(commit 전)에도 wasSent는 true다 — 예약 자체가 중복 방지 신호다", () => {
    const log = new InMemorySendLog();
    log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
    expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(true);
  });

  it("commit 후 list에 messageId까지 반영된 최종 기록이 남는다", () => {
    const log = new InMemorySendLog();
    log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
    log.commit(SHEET, TAB, "CUST-001", HASH, "2026-09-01T00:00:05.000Z", "msg-1");

    const [row] = log.list(SHEET);
    expect(row).toEqual({
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
    expect(() => log.commit(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT, "msg-1")).toThrow(
      /claim되지 않은/,
    );
  });

  it("release 후에는 wasSent가 다시 false가 되고, 같은 키로 재claim할 수 있다(재시도 허용)", () => {
    const log = new InMemorySendLog();
    log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
    log.release(SHEET, TAB, "CUST-001", HASH);

    expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(false);
    expect(log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT)).toBe(true);
  });

  it("존재하지 않는 키를 release해도 조용히 무시한다(이미 없으면 목표 상태와 같으므로)", () => {
    const log = new InMemorySendLog();
    expect(() => log.release(SHEET, TAB, "NO-SUCH", HASH)).not.toThrow();
  });

  it("list는 해당 sheetId의 기록만, 최신 것부터 반환한다", () => {
    const log = new InMemorySendLog();
    log.claim(SHEET, TAB, "A", HASH, "t1");
    log.commit(SHEET, TAB, "A", HASH, "t1", undefined);
    log.claim("sheet-2", TAB, "B", HASH, "t2");
    log.commit("sheet-2", TAB, "B", HASH, "t2", undefined);
    log.claim(SHEET, TAB, "C", HASH, "t3");
    log.commit(SHEET, TAB, "C", HASH, "t3", undefined);

    const rows = log.list(SHEET);
    expect(rows.map((r) => r.rowKey)).toEqual(["C", "A"]);
  });

  it("limit을 넘는 기록이 있으면 최신 limit건만 반환한다(AR-015)", () => {
    const log = new InMemorySendLog();
    for (let i = 0; i < 5; i += 1) {
      const rowKey = `R-${String(i)}`;
      log.claim(SHEET, TAB, rowKey, HASH, `t${String(i)}`);
      log.commit(SHEET, TAB, rowKey, HASH, `t${String(i)}`, undefined);
    }
    const rows = log.list(SHEET, { limit: 2 });
    expect(rows.map((r) => r.rowKey)).toEqual(["R-4", "R-3"]);
  });

  it("templateHash가 다르면 같은 행이라도 별도 claim으로 허용한다 (템플릿 수정 후 재발송)", () => {
    const log = new InMemorySendLog();
    expect(log.claim(SHEET, TAB, "CUST-001", "hash-v1", CLAIMED_AT)).toBe(true);
    expect(log.claim(SHEET, TAB, "CUST-001", "hash-v2", CLAIMED_AT)).toBe(true);
    expect(log.wasSent(SHEET, TAB, "CUST-001", "hash-v1")).toBe(true);
    expect(log.wasSent(SHEET, TAB, "CUST-001", "hash-v2")).toBe(true);
  });

  it("sheetId/tab/rowKey 중 하나만 달라도 별도 키로 취급한다", () => {
    const log = new InMemorySendLog();
    expect(log.claim(SHEET, "customers", "CUST-001", HASH, CLAIMED_AT)).toBe(true);
    expect(log.claim(SHEET, "orders", "CUST-001", HASH, CLAIMED_AT)).toBe(true);
    expect(log.claim(SHEET, "customers", "CUST-002", HASH, CLAIMED_AT)).toBe(true);
  });
});
