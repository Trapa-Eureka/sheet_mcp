// GoogleSheetClient 계약 테스트 — 실제 네트워크 호출 없이 SheetsApiLike를 목으로 주입해
// range 문자열/요청 바디 형태를 검증한다 (docs/ADVERSARIAL_REVIEW_002.md AR-007, AR-008).
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
  describe("탭 이름 A1 인용 (AR-007)", () => {
    it("readRows는 탭 이름을 작은따옴표로 인용해서 range를 만든다", async () => {
      const sheetsApi = makeSheetsApiMock([["name"], ["Juan"]]);
      const client = new GoogleSheetClient({ sheetsApi });

      await client.readRows("sheet-1", "Customer Data");

      expect(sheetsApi.spreadsheets.values.get).toHaveBeenCalledWith({
        spreadsheetId: "sheet-1",
        range: "'Customer Data'",
      });
    });

    it("탭 이름에 작은따옴표가 있으면 ''로 이스케이프한다", async () => {
      const sheetsApi = makeSheetsApiMock([["name"]]);
      const client = new GoogleSheetClient({ sheetsApi });

      await client.readRows("sheet-1", "Jin's Sheet");

      expect(sheetsApi.spreadsheets.values.get).toHaveBeenCalledWith({
        spreadsheetId: "sheet-1",
        range: "'Jin''s Sheet'",
      });
    });

    it("ensureStatusColumns/writeStatus도 인용된 탭 이름으로 range를 만든다", async () => {
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
    it("상태 컬럼 4개가 이미 있으면 update를 호출하지 않는다", async () => {
      const sheetsApi = makeSheetsApiMock([
        ["name", "_send_status", "_sent_at", "_message_id", "_error"],
      ]);
      const client = new GoogleSheetClient({ sheetsApi });

      await client.ensureStatusColumns("sheet-1", "customers");

      expect(sheetsApi.spreadsheets.values.update).not.toHaveBeenCalled();
    });

    it("상태 컬럼이 없으면 헤더 끝(열 개수만큼 뒤)에 4개를 한 번에 추가한다", async () => {
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

    it("일부 상태 컬럼만 없으면 없는 것만 추가한다", async () => {
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

    it("빈 updates 배열이면 Sheets API를 전혀 호출하지 않는다", async () => {
      const sheetsApi = makeSheetsApiMock(null);
      const client = new GoogleSheetClient({ sheetsApi });

      await client.writeStatus("sheet-1", "customers", []);

      expect(sheetsApi.spreadsheets.values.get).not.toHaveBeenCalled();
      expect(sheetsApi.spreadsheets.values.batchUpdate).not.toHaveBeenCalled();
    });

    it("결측 필드(sentAt/messageId/error)는 batchUpdate 요청에 아예 포함되지 않는다", async () => {
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

    it("전체 필드가 있으면 4개 셀 전부 batchUpdate에 담는다", async () => {
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

    it("null 필드는 빈 문자열로 명시적으로 지운다(undefined=건드리지 않음과 구분, AR-014)", async () => {
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

    it("상태 컬럼이 헤더에 없으면 ensureStatusColumns를 먼저 호출하라는 에러를 던진다", async () => {
      const sheetsApi = makeSheetsApiMock([["name", "email"]]);
      const client = new GoogleSheetClient({ sheetsApi });

      await expect(
        client.writeStatus("sheet-1", "customers", [{ rowIndex: 2, sendStatus: "sent" }]),
      ).rejects.toThrow(/ensureStatusColumns를 먼저 호출/);
    });
  });

  describe("readConfig", () => {
    it("notify_config!A:B 범위를 읽어 키-값 record로 만든다", async () => {
      const sheetsApi = makeSheetsApiMock([
        ["data_tab", "customers"],
        ["channel", "email"],
        ["", "무시되는 빈 키"],
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

  describe("생성자", () => {
    it("sheetsApi를 주입하지 않고 GOOGLE_SERVICE_ACCOUNT_JSON도 없으면 수정 방법이 담긴 에러를 던진다", () => {
      const original = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      try {
        expect(() => new GoogleSheetClient()).toThrow(
          /GOOGLE_SERVICE_ACCOUNT_JSON 환경변수가 없습니다/,
        );
      } finally {
        if (original !== undefined) process.env.GOOGLE_SERVICE_ACCOUNT_JSON = original;
      }
    });
  });
});
