// Tests for the logic backing the read_rows MCP tool (core/readRows.ts). Uses only
// InMemorySheetClient, no network.

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
  it("returns all rows when there is no filter", async () => {
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

  it("applies filter_column/filter_value and returns only matching rows", async () => {
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

  it(`truncates and sets truncated=true when matched rows exceed ${String(READ_ROWS_PREVIEW_LIMIT)} rows`, async () => {
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

  it("propagates ConfigParseError as-is when config validation fails", async () => {
    const client = new InMemorySheetClient({
      [SHEET_ID]: { notifyConfig: { data_tab: "customers" }, tabs: { customers: [] } },
    });
    await expect(readTargetRows(client, SHEET_ID)).rejects.toThrow(/notify_config/);
  });
});
