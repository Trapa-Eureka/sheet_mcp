import { describe, expect, it } from "vitest";
import { InMemorySendLog } from "../src/mocks/inMemorySendLog.js";
import type { SendLogEntry } from "../src/core/types.js";

function entry(overrides: Partial<SendLogEntry> = {}): SendLogEntry {
  return {
    sheetId: "sheet-1",
    tab: "customers",
    rowKey: "CUST-001",
    templateHash: "abc123def456",
    sendStatus: "sent",
    sentAt: "2026-09-01T00:00:00.000Z",
    messageId: "msg-1",
    ...overrides,
  };
}

describe("InMemorySendLog", () => {
  it("기록 전에는 wasSent가 false다", () => {
    const log = new InMemorySendLog();
    expect(log.wasSent("sheet-1", "customers", "CUST-001", "abc123def456")).toBe(false);
  });

  it("record 후 같은 키로 wasSent를 물으면 true다", () => {
    const log = new InMemorySendLog();
    log.record(entry());
    expect(log.wasSent("sheet-1", "customers", "CUST-001", "abc123def456")).toBe(true);
  });

  it("list는 해당 sheetId의 기록만 반환한다", () => {
    const log = new InMemorySendLog();
    log.record(entry({ sheetId: "sheet-1", rowKey: "A" }));
    log.record(entry({ sheetId: "sheet-2", rowKey: "B" }));
    log.record(entry({ sheetId: "sheet-1", rowKey: "C" }));

    const rows = log.list("sheet-1");
    expect(rows.map((r) => r.rowKey)).toEqual(["A", "C"]);
  });

  it("같은 (sheetId, tab, rowKey, templateHash) 조합을 두 번 record하면 조용히 무시하지 않고 명시적으로 에러를 던진다", () => {
    const log = new InMemorySendLog();
    log.record(entry());
    expect(() => log.record(entry())).toThrow(/이미 기록되어 있습니다/);
    // 실패한 두 번째 시도가 목록을 오염시키지 않았는지 확인
    expect(log.list("sheet-1")).toHaveLength(1);
  });

  it("templateHash가 다르면 같은 행이라도 별도 기록으로 허용한다 (템플릿 수정 후 재발송)", () => {
    const log = new InMemorySendLog();
    log.record(entry({ templateHash: "hash-v1" }));
    expect(() => log.record(entry({ templateHash: "hash-v2" }))).not.toThrow();
    expect(log.wasSent("sheet-1", "customers", "CUST-001", "hash-v1")).toBe(true);
    expect(log.wasSent("sheet-1", "customers", "CUST-001", "hash-v2")).toBe(true);
    expect(log.list("sheet-1")).toHaveLength(2);
  });

  it("sheetId/tab/rowKey 중 하나만 달라도 별도 키로 취급한다", () => {
    const log = new InMemorySendLog();
    log.record(entry({ tab: "customers" }));
    expect(() => log.record(entry({ tab: "orders" }))).not.toThrow();
    expect(() => log.record(entry({ rowKey: "CUST-002" }))).not.toThrow();
    expect(log.list("sheet-1")).toHaveLength(3);
  });
});
