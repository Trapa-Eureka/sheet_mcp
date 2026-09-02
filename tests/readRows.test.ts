// read_rows MCP 도구 지원 로직(core/readRows.ts) 테스트. InMemorySheetClient만 사용, 네트워크 없음.

import { describe, expect, it } from "vitest";
import { readTargetRows, READ_ROWS_PREVIEW_LIMIT } from "../src/core/readRows.js";
import { InMemorySheetClient } from "../src/mocks/inMemorySheetClient.js";
import type { SheetFixture } from "../src/mocks/inMemorySheetClient.js";

const SHEET_ID = "sheet-1";

function fixtureWithRows(
  rows: Array<Record<string, string>>,
  overrides: Record<string, string> = {},
): SheetFixture {
  return {
    notifyConfig: {
      data_tab: "customers",
      id_column: "customer_id",
      recipient_column: "email",
      channel: "email",
      subject_template: "안내",
      body_template: "{{name}}님 안내드립니다.",
      ...overrides,
    },
    tabs: { customers: rows },
  };
}

describe("readTargetRows", () => {
  it("filter가 없으면 전체 행을 반환한다", async () => {
    const rows = [
      { customer_id: "C-1", name: "Alice", email: "a@example.com" },
      { customer_id: "C-2", name: "Bob", email: "b@example.com" },
    ];
    const client = new InMemorySheetClient({ [SHEET_ID]: fixtureWithRows(rows) });

    const result = await readTargetRows(client, SHEET_ID);

    expect(result.totalMatched).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.rows).toHaveLength(2);
  });

  it("filter_column/filter_value를 적용해 매칭 행만 반환한다", async () => {
    const rows = [
      { customer_id: "C-1", name: "Alice", email: "a@example.com", status: "unpaid" },
      { customer_id: "C-2", name: "Bob", email: "b@example.com", status: "paid" },
    ];
    const client = new InMemorySheetClient({
      [SHEET_ID]: fixtureWithRows(rows, { filter_column: "status", filter_value: "unpaid" }),
    });

    const result = await readTargetRows(client, SHEET_ID);

    expect(result.totalMatched).toBe(1);
    expect(result.rows.map((r) => r.values.customer_id)).toEqual(["C-1"]);
  });

  it(`매칭 행이 ${String(READ_ROWS_PREVIEW_LIMIT)}행을 넘으면 잘라서 반환하고 truncated=true`, async () => {
    const rows = Array.from({ length: READ_ROWS_PREVIEW_LIMIT + 10 }, (_, i) => ({
      customer_id: `C-${String(i)}`,
      name: `User ${String(i)}`,
      email: `user${String(i)}@example.com`,
    }));
    const client = new InMemorySheetClient({ [SHEET_ID]: fixtureWithRows(rows) });

    const result = await readTargetRows(client, SHEET_ID);

    expect(result.totalMatched).toBe(READ_ROWS_PREVIEW_LIMIT + 10);
    expect(result.rows).toHaveLength(READ_ROWS_PREVIEW_LIMIT);
    expect(result.truncated).toBe(true);
  });

  it("config 검증 실패 시 ConfigParseError가 그대로 전파된다", async () => {
    const client = new InMemorySheetClient({
      [SHEET_ID]: { notifyConfig: { data_tab: "customers" }, tabs: { customers: [] } },
    });
    await expect(readTargetRows(client, SHEET_ID)).rejects.toThrow(/notify_config/);
  });
});
