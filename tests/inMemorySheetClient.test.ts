import { beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { InMemorySheetClient, loadFixtureFile } from "../src/mocks/inMemorySheetClient.js";
import type { SheetFixture } from "../src/mocks/inMemorySheetClient.js";

const COLLECTIONS_FIXTURE_PATH = path.resolve(process.cwd(), "fixtures/sheets/collections.json");
const LARGE_FIXTURE_PATH = path.resolve(process.cwd(), "fixtures/sheets/large-1000.json");

function simpleFixture(): SheetFixture {
  return {
    notifyConfig: {
      data_tab: "customers",
      id_column: "customer_id",
      recipient_column: "email",
      channel: "email",
      subject_template: "[{{shop}}] 안내",
      body_template: "{{name}}님 안내드립니다.",
    },
    tabs: {
      customers: [
        { customer_id: "A-1", name: "Alice", email: "alice@example.com", shop: "Shop1" },
        { customer_id: "A-2", name: "Bob", email: "bob@example.com", shop: "Shop1" },
      ],
    },
  };
}

describe("InMemorySheetClient", () => {
  let client: InMemorySheetClient;

  beforeEach(() => {
    client = new InMemorySheetClient({ "sheet-1": simpleFixture() });
  });

  it("readConfig returns the original notify_config", async () => {
    const config = await client.readConfig("sheet-1");
    expect(config.data_tab).toBe("customers");
    expect(config.channel).toBe("email");
  });

  it("readRows assigns rowIndex starting from row 2 (row 1 is the header)", async () => {
    const rows = await client.readRows("sheet-1", "customers");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      rowIndex: 2,
      values: { customer_id: "A-1", name: "Alice", email: "alice@example.com", shop: "Shop1" },
    });
    expect(rows[1]?.rowIndex).toBe(3);
  });

  it("mutating rows returned by readRows does not affect internal state (original is preserved on re-fetch)", async () => {
    const rows = await client.readRows("sheet-1", "customers");
    rows[0]!.values.name = "MUTATED";
    const rowsAgain = await client.readRows("sheet-1", "customers");
    expect(rowsAgain[0]?.values.name).toBe("Alice");
  });

  it("mutating the object returned by readConfig does not affect internal state", async () => {
    const config = await client.readConfig("sheet-1");
    config.channel = "MUTATED";
    const configAgain = await client.readConfig("sheet-1");
    expect(configAgain.channel).toBe("email");
  });

  it("mutating the original fixture object passed to loadSheet afterward does not affect internal state", async () => {
    const fixture = simpleFixture();
    client.loadSheet("sheet-3", fixture);
    fixture.notifyConfig.channel = "MUTATED";
    fixture.tabs.customers![0]!.name = "MUTATED";

    const config = await client.readConfig("sheet-3");
    const rows = await client.readRows("sheet-3", "customers");
    expect(config.channel).toBe("email");
    expect(rows[0]?.values.name).toBe("Alice");
  });

  it("ensureStatusColumns fills the 4 status columns with empty values, reflected on re-fetch", async () => {
    await client.ensureStatusColumns("sheet-1", "customers");
    const rows = await client.readRows("sheet-1", "customers");
    for (const row of rows) {
      expect(row.values._send_status).toBe("");
      expect(row.values._sent_at).toBe("");
      expect(row.values._message_id).toBe("");
      expect(row.values._error).toBe("");
    }
  });

  it("ensureStatusColumns does not touch existing user data column values", async () => {
    await client.ensureStatusColumns("sheet-1", "customers");
    const rows = await client.readRows("sheet-1", "customers");
    expect(rows[0]?.values.name).toBe("Alice");
    expect(rows[0]?.values.email).toBe("alice@example.com");
  });

  it("writeStatus is applied in memory and comes back unchanged on re-fetch", async () => {
    await client.ensureStatusColumns("sheet-1", "customers");
    await client.writeStatus("sheet-1", "customers", [
      { rowIndex: 2, sendStatus: "sent", sentAt: "2026-09-01T00:00:00.000Z", messageId: "msg-1" },
      { rowIndex: 3, sendStatus: "failed", error: "invalid email" },
    ]);

    const rows = await client.readRows("sheet-1", "customers");
    expect(rows[0]?.values).toMatchObject({
      _send_status: "sent",
      _sent_at: "2026-09-01T00:00:00.000Z",
      _message_id: "msg-1",
      _error: "",
    });
    expect(rows[1]?.values).toMatchObject({
      _send_status: "failed",
      _message_id: "",
      _error: "invalid email",
    });
  });

  it("writeStatus preserves existing values for missing fields (sentAt/messageId/error) instead of clearing them", async () => {
    await client.ensureStatusColumns("sheet-1", "customers");
    await client.writeStatus("sheet-1", "customers", [
      { rowIndex: 2, sendStatus: "sent", sentAt: "2026-09-01T00:00:00.000Z", messageId: "msg-1" },
    ]);

    // A common case: even when the same row is later recorded as skipped_duplicate, messageId/error aren't specified
    await client.writeStatus("sheet-1", "customers", [
      { rowIndex: 2, sendStatus: "skipped_duplicate" },
    ]);

    const rows = await client.readRows("sheet-1", "customers");
    expect(rows[0]?.values).toMatchObject({
      _send_status: "skipped_duplicate",
      _sent_at: "2026-09-01T00:00:00.000Z", // not cleared — the previous send record remains
      _message_id: "msg-1",
    });
  });

  it("writeStatus explicitly clears null fields to an empty string (distinct from undefined=preserve, AR-014)", async () => {
    await client.ensureStatusColumns("sheet-1", "customers");
    await client.writeStatus("sheet-1", "customers", [
      {
        rowIndex: 2,
        sendStatus: "failed",
        error: "invalid email",
      },
    ]);

    // On a successful retry, the past _error is cleared with null (it would have remained if it were undefined).
    await client.writeStatus("sheet-1", "customers", [
      { rowIndex: 2, sendStatus: "sent", sentAt: "2026-09-01T00:00:00.000Z", error: null },
    ]);

    const rows = await client.readRows("sheet-1", "customers");
    expect(rows[0]?.values).toMatchObject({ _send_status: "sent", _error: "" });
  });

  it("writeStatus creates and applies status columns even without ensureStatusColumns", async () => {
    await client.writeStatus("sheet-1", "customers", [
      { rowIndex: 2, sendStatus: "skipped_duplicate" },
    ]);
    const rows = await client.readRows("sheet-1", "customers");
    expect(rows[0]?.values._send_status).toBe("skipped_duplicate");
  });

  it("reading a nonexistent sheetId throws an error explaining how to register it", async () => {
    await expect(client.readConfig("no-such-sheet")).rejects.toThrow(
      /Register it first with loadSheet\(sheetId, fixture\)/,
    );
  });

  it("reading a nonexistent tab throws an error explaining which key to add", async () => {
    await expect(client.readRows("sheet-1", "no-such-tab")).rejects.toThrow(
      /Add a 'no-such-tab' key to the fixture's tabs/,
    );
  });

  it("calling writeStatus with a nonexistent rowIndex throws an explicit error", async () => {
    await expect(
      client.writeStatus("sheet-1", "customers", [{ rowIndex: 999, sendStatus: "sent" }]),
    ).rejects.toThrow(/has no rowIndex 999/);
  });

  it("writeStatus is all-or-nothing — if any rowIndex in the batch is missing, earlier rows are not applied either", async () => {
    await expect(
      client.writeStatus("sheet-1", "customers", [
        { rowIndex: 2, sendStatus: "sent", messageId: "should-not-apply" },
        { rowIndex: 999, sendStatus: "sent" },
      ]),
    ).rejects.toThrow(/has no rowIndex 999/);

    const rows = await client.readRows("sheet-1", "customers");
    // Since the whole batch failed, rowIndex 2 should not get status columns either
    expect(rows[0]?.values._send_status).toBeUndefined();
  });

  it("a sheet can be additionally registered with loadSheet", async () => {
    client.loadSheet("sheet-2", simpleFixture());
    const rows = await client.readRows("sheet-2", "customers");
    expect(rows).toHaveLength(2);
  });
});

describe("fixtures/sheets/collections.json (SPEC §4-3 collection notice)", () => {
  it("loading via loadFixtureFile and registering with InMemorySheetClient allows reading filter/unicode values", async () => {
    const fixture = loadFixtureFile(COLLECTIONS_FIXTURE_PATH);
    const client = new InMemorySheetClient({ [fixture.sheetId]: fixture });

    const config = await client.readConfig(fixture.sheetId);
    expect(config.filter_column).toBe("status");
    expect(config.filter_value).toBe("unpaid");

    const rows = await client.readRows(fixture.sheetId, config.data_tab ?? "");
    expect(rows).toHaveLength(12);

    const unpaidRows = rows.filter((row) => row.values.status === "unpaid");
    expect(unpaidRows.length).toBeGreaterThan(0);
    expect(unpaidRows.length).toBeLessThan(rows.length);

    // Verify that mixed Tagalog/English values remain intact without corruption
    const first = rows[0];
    expect(first?.values.notes).toContain("bayaran");
    expect(config.body_template).toContain("po,");
  });
});

describe("fixtures/sheets/large-1000.json (for T7 performance regression guard, generated by scripts/genLargeFixture.ts)", () => {
  it("loads via loadFixtureFile and 1000 rows satisfy the schema (detects generator drift)", async () => {
    const fixture = loadFixtureFile(LARGE_FIXTURE_PATH);
    const client = new InMemorySheetClient({ [fixture.sheetId]: fixture });

    const rows = await client.readRows(fixture.sheetId, fixture.notifyConfig.data_tab ?? "");
    expect(rows).toHaveLength(1000);
    // Even if the live-send safeguard is breached, only RFC 2606 reserved domains should be used so real recipients are never reached
    for (const row of rows) {
      expect(row.values.email).toMatch(/@example\.invalid$/);
    }
  });
});
