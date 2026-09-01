// SheetClient의 실제 구현 — googleapis + 서비스 계정 인증.
// 설계: docs/DESIGN.md §6(어댑터 메모), §2(시트 규약). 테스트는 작성하지 않는다(네트워크 금지,
// docs/TESTING.md §1) — 검증은 scripts/smoke.ts로 사람이 수동 실행한다 (docs/TASKS.md T3).
//
// 시트 공유 방식(v0.1): 대상 스프레드시트를 서비스 계정 이메일(JSON의 client_email)에
// "편집자"로 공유해야 한다.

import { readFileSync } from "node:fs";
import { google, type sheets_v4 } from "googleapis";
import { z } from "zod";
import type { SheetClient, SheetRow, StatusUpdate } from "../core/types.js";

const STATUS_COLUMNS = ["_send_status", "_sent_at", "_message_id", "_error"] as const;
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

/** google-auth-library JWTInput의 필수 사용 필드만 검증한다. 나머지 키는 그대로 흘려보낸다(passthrough) */
const serviceAccountKeySchema = z
  .object({
    client_email: z.string().min(1),
    private_key: z.string().min(1),
  })
  .passthrough();

export interface GoogleSheetClientOptions {
  /** 기본값: 환경변수 GOOGLE_SERVICE_ACCOUNT_JSON */
  serviceAccountKeyPath?: string;
}

/** Sheets API 셀 값은 string/number/boolean이 보통이지만 타입이 any라 안전하게 문자열화한다 */
function cellToString(cell: unknown): string {
  if (cell === undefined || cell === null) return "";
  if (typeof cell === "string") return cell;
  if (typeof cell === "number" || typeof cell === "boolean") return String(cell);
  return JSON.stringify(cell);
}

function columnIndexToLetter(index: number): string {
  let n = index + 1; // 1-based로 변환
  let letters = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

export class GoogleSheetClient implements SheetClient {
  private readonly keyPath: string;
  private sheetsApi: sheets_v4.Sheets | null = null;

  constructor(options: GoogleSheetClientOptions = {}) {
    const keyPath = options.serviceAccountKeyPath ?? process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!keyPath) {
      throw new Error(
        "GOOGLE_SERVICE_ACCOUNT_JSON 환경변수가 없습니다. .env에 서비스 계정 키 JSON 파일 경로를 " +
          "설정하세요 (예: GOOGLE_SERVICE_ACCOUNT_JSON=./service-account.json). .env.example 참고.",
      );
    }
    this.keyPath = keyPath;
  }

  // 전부 동기 작업(파일 읽기/JSON 파싱/인증 클라이언트 생성)이라 async가 필요 없다.
  // require-await 규칙 회피가 아니라 실제로 비동기 IO가 없는 함수다.
  private getSheetsApi(): sheets_v4.Sheets {
    if (this.sheetsApi) return this.sheetsApi;

    let raw: string;
    try {
      raw = readFileSync(this.keyPath, "utf-8");
    } catch (err) {
      throw new Error(
        `서비스 계정 키 파일을 읽을 수 없습니다: '${this.keyPath}'. GOOGLE_SERVICE_ACCOUNT_JSON ` +
          `경로가 올바른지, 파일이 존재하는지 확인하세요. (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `서비스 계정 키 파일 '${this.keyPath}'이 올바른 JSON이 아닙니다. Google Cloud Console에서 ` +
          "발급받은 서비스 계정 키 JSON 파일인지 확인하세요.",
      );
    }

    const result = serviceAccountKeySchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `서비스 계정 키 파일 '${this.keyPath}'에 client_email/private_key가 없습니다. ` +
          "Google Cloud Console > IAM 및 관리자 > 서비스 계정에서 키를 다시 발급받으세요.",
      );
    }

    const auth = new google.auth.GoogleAuth({ credentials: result.data, scopes: SCOPES });
    this.sheetsApi = google.sheets({ version: "v4", auth });
    return this.sheetsApi;
  }

  async readConfig(sheetId: string): Promise<Record<string, string>> {
    const sheets = this.getSheetsApi();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: "notify_config!A:B",
    });

    const config: Record<string, string> = {};
    const rows: unknown[][] = res.data.values ?? [];
    for (const row of rows) {
      const key: unknown = row[0];
      const value: unknown = row[1];
      if (typeof key === "string" && key.trim() !== "" && typeof value === "string") {
        config[key] = value;
      }
    }
    return config;
  }

  async readRows(sheetId: string, tab: string): Promise<SheetRow[]> {
    const sheets = this.getSheetsApi();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: tab,
    });

    const values: unknown[][] = res.data.values ?? [];
    const header = values[0] ?? [];
    return values.slice(1).map((row, index) => {
      const rowValues: Record<string, string> = {};
      header.forEach((columnName: unknown, columnIndex: number) => {
        if (typeof columnName === "string" && columnName.trim() !== "") {
          rowValues[columnName] = cellToString(row[columnIndex]);
        }
      });
      // 1행은 헤더이므로 데이터 행은 2행부터 시작한다 (DESIGN §2)
      return { rowIndex: index + 2, values: rowValues };
    });
  }

  private async readHeader(
    sheets: sheets_v4.Sheets,
    sheetId: string,
    tab: string,
  ): Promise<string[]> {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${tab}!1:1`,
    });
    const headerRow: unknown[] = res.data.values?.[0] ?? [];
    return headerRow.map((cell) => cellToString(cell));
  }

  async ensureStatusColumns(sheetId: string, tab: string): Promise<void> {
    const sheets = this.getSheetsApi();
    const header = await this.readHeader(sheets, sheetId, tab);
    const missing = STATUS_COLUMNS.filter((column) => !header.includes(column));
    if (missing.length === 0) return;

    const startColumnLetter = columnIndexToLetter(header.length);
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${tab}!${startColumnLetter}1`,
      valueInputOption: "RAW",
      requestBody: { values: [missing] },
    });
  }

  async writeStatus(sheetId: string, tab: string, updates: StatusUpdate[]): Promise<void> {
    if (updates.length === 0) return;

    const sheets = this.getSheetsApi();
    const header = await this.readHeader(sheets, sheetId, tab);

    const columnLetterFor = (columnName: string): string => {
      const index = header.indexOf(columnName);
      if (index === -1) {
        throw new Error(
          `writeStatus: 시트 '${sheetId}' 탭 '${tab}'에 '${columnName}' 컬럼이 없습니다. ` +
            "ensureStatusColumns를 먼저 호출해 상태 컬럼을 만드세요.",
        );
      }
      return columnIndexToLetter(index);
    };

    const columnLetters = {
      _send_status: columnLetterFor("_send_status"),
      _sent_at: columnLetterFor("_sent_at"),
      _message_id: columnLetterFor("_message_id"),
      _error: columnLetterFor("_error"),
    };

    // sentAt/messageId/error 결측은 "지운다"가 아니라 "건드리지 않는다" (DESIGN §3 StatusUpdate,
    // InMemorySheetClient와 동일한 계약 — 감사 기록을 보존하기 위해 해당 셀은 아예 쓰지 않는다).
    const data: sheets_v4.Schema$ValueRange[] = [];
    for (const update of updates) {
      data.push({
        range: `${tab}!${columnLetters._send_status}${String(update.rowIndex)}`,
        values: [[update.sendStatus]],
      });
      if (update.sentAt !== undefined) {
        data.push({
          range: `${tab}!${columnLetters._sent_at}${String(update.rowIndex)}`,
          values: [[update.sentAt]],
        });
      }
      if (update.messageId !== undefined) {
        data.push({
          range: `${tab}!${columnLetters._message_id}${String(update.rowIndex)}`,
          values: [[update.messageId]],
        });
      }
      if (update.error !== undefined) {
        data.push({
          range: `${tab}!${columnLetters._error}${String(update.rowIndex)}`,
          values: [[update.error]],
        });
      }
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { valueInputOption: "RAW", data },
    });
  }
}
