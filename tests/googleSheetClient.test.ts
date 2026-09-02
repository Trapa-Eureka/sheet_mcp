// GoogleSheetClient contract tests — inject SheetsApiLike as a mock instead of making real
// network calls, and verify the shape of range strings/request bodies (docs/ADVERSARIAL_REVIEW_002.md AR-007, AR-008).
import { describe, expect, it, vi } from "vitest";
import { GoogleSheetClient } from "../src/adapters/googleSheetClient.js";
import type { SheetsApiLike } from "../src/adapters/googleSheetClient.js";

function makeSheetsApiMock(getValues: unknown[][] | null = null): SheetsApiLike {
  return {
    spreadsheets: {
      values: {
        get: vi.fn().mockResolvedValue({ data: { values: getValues } }),
        update: vi.fn().mockResolvedValue({}),
        batchUpdate: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

describe("GoogleSheetClient", () => {
  describe("quoting tab names for A1 notation (AR-007)", () => {
    it("readRows quotes the tab name with single quotes when building the range", async () => {
      const sheetsApi = makeSheetsApiMock([["name"], ["Juan"]]);
      const client = new GoogleSheetClient({ sheetsApi });

      await client.readRows("sheet-1", "Customer Data");

      expect(sheetsApi.spreadsheets.values.get).toHaveBeenCalledWith({
        spreadsheetId: "sheet-1",
        range: "'Customer Data'",
      });
    });

    it("escapes a single quote in the tab name as ''", async () => {
      const sheetsApi = makeSheetsApiMock([["name"]]);
      const client = new GoogleSheetClient({ sheetsApi });

      await client.readRows("sheet-1", "Jin's Sheet");

      expect(sheetsApi.spreadsheets.values.get).toHaveBeenCalledWith({
        spreadsheetId: "sheet-1",
        range: "'Jin''s Sheet'",
      });
    });

    it("ensureStatusColumns/writeStatus also build ranges with quoted tab names", async () => {
      const sheetsApi = makeSheetsApiMock([
        ["name", "_send_status", "_sent_at", "_message_id", "_error"],
      ]);
      const client = new GoogleSheetClient({ sheetsApi });

      await client.writeStatus("sheet-1", "미수금 고객", [{ rowIndex: 2, sendStatus: "sent" }]);

      const call = vi.mocked(sheetsApi.spreadsheets.values.batchUpdate).mock.calls[0]?.[0];
      expect(call?.requestBody.data[0]?.range).toBe("'미수금 고객'!B2");
    });
  });

  describe("ensureStatusColumns (AR-008)", () => {
    it("does not call update when all 4 status columns already exist", async () => {
      const sheetsApi = makeSheetsApiMock([
        ["name", "_send_status", "_sent_at", "_message_id", "_error"],
      ]);
      const client = new GoogleSheetClient({ sheetsApi });

      await client.ensureStatusColumns("sheet-1", "customers");

      expect(sheetsApi.spreadsheets.values.update).not.toHaveBeenCalled();
    });

    it("adds all 4 columns at once, after the header (past the last existing column), when none exist", async () => {
      const sheetsApi = makeSheetsApiMock([["name", "email"]]);
      const client = new GoogleSheetClient({ sheetsApi });

      await client.ensureStatusColumns("sheet-1", "customers");

      expect(sheetsApi.spreadsheets.values.update).toHaveBeenCalledWith({
        spreadsheetId: "sheet-1",
        range: "'customers'!C1",
        valueInputOption: "RAW",
        requestBody: { values: [["_send_status", "_sent_at", "_message_id", "_error"]] },
      });
    });

    it("adds only the missing status columns when some already exist", async () => {
      const sheetsApi = makeSheetsApiMock([["name", "_send_status", "_sent_at"]]);
      const client = new GoogleSheetClient({ sheetsApi });

      await client.ensureStatusColumns("sheet-1", "customers");

      expect(sheetsApi.spreadsheets.values.update).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: { values: [["_message_id", "_error"]] },
        }),
      );
    });
  });

  describe("writeStatus (AR-008)", () => {
    const HEADER = ["name", "_send_status", "_sent_at", "_message_id", "_error"];

    it("does not call the Sheets API at all when the updates array is empty", async () => {
      const sheetsApi = makeSheetsApiMock(null);
      const client = new GoogleSheetClient({ sheetsApi });

      await client.writeStatus("sheet-1", "customers", []);

      expect(sheetsApi.spreadsheets.values.get).not.toHaveBeenCalled();
      expect(sheetsApi.spreadsheets.values.batchUpdate).not.toHaveBeenCalled();
    });

    it("missing fields (sentAt/messageId/error) are not included in the batchUpdate request at all", async () => {
      const sheetsApi = makeSheetsApiMock([HEADER]);
      const client = new GoogleSheetClient({ sheetsApi });

      await client.writeStatus("sheet-1", "customers", [
        { rowIndex: 2, sendStatus: "skipped_duplicate" },
      ]);

      const call = vi.mocked(sheetsApi.spreadsheets.values.batchUpdate).mock.calls[0]?.[0];
      expect(call?.requestBody.data).toEqual([
        { range: "'customers'!B2", values: [["skipped_duplicate"]] },
      ]);
    });

    it("puts all 4 cells into batchUpdate when every field is present", async () => {
      const sheetsApi = makeSheetsApiMock([HEADER]);
      const client = new GoogleSheetClient({ sheetsApi });

      await client.writeStatus("sheet-1", "customers", [
        {
          rowIndex: 2,
          sendStatus: "sent",
          sentAt: "2026-09-01T00:00:00.000Z",
          messageId: "msg-1",
          error: undefined,
        },
      ]);

      const call = vi.mocked(sheetsApi.spreadsheets.values.batchUpdate).mock.calls[0]?.[0];
      expect(call?.requestBody.data).toEqual([
        { range: "'customers'!B2", values: [["sent"]] },
        { range: "'customers'!C2", values: [["2026-09-01T00:00:00.000Z"]] },
        { range: "'customers'!D2", values: [["msg-1"]] },
      ]);
    });

    it("null fields are explicitly cleared to empty string (distinct from undefined = leave untouched, AR-014)", async () => {
      const sheetsApi = makeSheetsApiMock([HEADER]);
      const client = new GoogleSheetClient({ sheetsApi });

      await client.writeStatus("sheet-1", "customers", [
        {
          rowIndex: 2,
          sendStatus: "sent",
          sentAt: "2026-09-01T00:00:00.000Z",
          messageId: null,
          error: null,
        },
      ]);

      const call = vi.mocked(sheetsApi.spreadsheets.values.batchUpdate).mock.calls[0]?.[0];
      expect(call?.requestBody.data).toEqual([
        { range: "'customers'!B2", values: [["sent"]] },
        { range: "'customers'!C2", values: [["2026-09-01T00:00:00.000Z"]] },
        { range: "'customers'!D2", values: [[""]] },
        { range: "'customers'!E2", values: [[""]] },
      ]);
    });

    it("throws an error telling you to call ensureStatusColumns first when a status column is missing from the header", async () => {
      const sheetsApi = makeSheetsApiMock([["name", "email"]]);
      const client = new GoogleSheetClient({ sheetsApi });

      await expect(
        client.writeStatus("sheet-1", "customers", [{ rowIndex: 2, sendStatus: "sent" }]),
      ).rejects.toThrow(/Call ensureStatusColumns first/);
    });
  });

  describe("readConfig", () => {
    it("reads the notify_config!A:B range into a key-value record", async () => {
      const sheetsApi = makeSheetsApiMock([
        ["data_tab", "customers"],
        ["channel", "email"],
        ["", "ignored empty key"],
      ]);
      const client = new GoogleSheetClient({ sheetsApi });

      const config = await client.readConfig("sheet-1");

      expect(sheetsApi.spreadsheets.values.get).toHaveBeenCalledWith({
        spreadsheetId: "sheet-1",
        range: "'notify_config'!A:B",
      });
      expect(config).toEqual({ data_tab: "customers", channel: "email" });
    });
  });

  describe("constructor", () => {
    it("throws an error with fix instructions when sheetsApi isn't injected and GOOGLE_SERVICE_ACCOUNT_JSON isn't set either", () => {
      const original = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      try {
        expect(() => new GoogleSheetClient()).toThrow(
          /GOOGLE_SERVICE_ACCOUNT_JSON environment variable is not set/,
        );
      } finally {
        if (original !== undefined) process.env.GOOGLE_SERVICE_ACCOUNT_JSON = original;
      }
    });
  });

  describe("timeout (docs/ADVERSARIAL_REVIEW_004.md AR-023)", () => {
    it("readRows: even a Sheets API call whose response never comes back ends with a clear error within timeoutMs", async () => {
      const sheetsApi: SheetsApiLike = {
        spreadsheets: {
          values: {
            // Since our SheetsApiLike interface has no signal argument, the mock never finishes
            // unless it finishes on its own — without the withTimeout() race, this test itself
            // would hang.
            get: vi.fn().mockImplementation(() => new Promise(() => {})),
            update: vi.fn(),
            batchUpdate: vi.fn(),
          },
        },
      };
      const client = new GoogleSheetClient({ sheetsApi, timeoutMs: 20 });

      await expect(client.readRows("sheet-1", "customers")).rejects.toThrow(/treated as a timeout/);
    });

    it("writeStatus: even if batchUpdate never finishes, it ends with a clear error within timeoutMs", async () => {
      const sheetsApi: SheetsApiLike = {
        spreadsheets: {
          values: {
            get: vi.fn().mockResolvedValue({
              data: { values: [["_send_status", "_sent_at", "_message_id", "_error"]] },
            }),
            update: vi.fn(),
            batchUpdate: vi.fn().mockImplementation(() => new Promise(() => {})),
          },
        },
      };
      const client = new GoogleSheetClient({ sheetsApi, timeoutMs: 20 });

      await expect(
        client.writeStatus("sheet-1", "customers", [{ rowIndex: 2, sendStatus: "sent" }]),
      ).rejects.toThrow(/treated as a timeout/);
    });
  });
});
