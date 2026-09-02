// SheetClient의 실제 구현 — googleapis + 서비스 계정 인증.
// 설계: docs/DESIGN.md §6(어댑터 메모), §2(시트 규약).
// 실제 네트워크를 타는 테스트는 작성하지 않는다(네트워크 금지, docs/TESTING.md §1) — 대신
// Sheets API 호출부만 얇은 인터페이스(SheetsApiLike)로 분리해 주입 가능하게 하고, 그 목으로
// range 문자열·요청 바디 형태를 검증하는 계약 테스트를 둔다(tests/googleSheetClient.test.ts,
// docs/ADVERSARIAL_REVIEW_002.md AR-008). 실제 인증/읽기 경로 통합 확인은 scripts/smoke.ts로
// 사람이 수동 실행한다 (docs/TASKS.md T3).
//
// 시트 공유 방식(v0.1): 대상 스프레드시트를 서비스 계정 이메일(JSON의 client_email)에
// "편집자"로 공유해야 한다.

import { readFileSync } from "node:fs";
import { google } from "googleapis";
import { z } from "zod";
import type { SheetClient, SheetRow, StatusUpdate } from "../core/types.js";

const STATUS_COLUMNS = ["_send_status", "_sent_at", "_message_id", "_error"] as const;
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

/** Sheets API 호출 기본 timeout(ms) — docs/ADVERSARIAL_REVIEW_004.md AR-023: 네트워크 half-open/DNS
 * 지연 등으로 응답이 영영 안 오면 이 값 없이는 파이프라인 전체가(claim 포함) 무기한 멈춰 있을 수
 * 있었다. 실제 in-flight 요청을 취소하지는 못한다(SheetsApiLike는 이 어댑터가 정의한 좁은
 * 인터페이스라 AbortController를 전달할 표준 방법이 없음) — 대신 이 시간이 지나면 결과를 더 이상
 * 기다리지 않고 명확한 에러로 실패 처리한다(readConfig/readRows/ensureStatusColumns/writeStatus
 * 어느 쪽이 걸려도 호출 자체가 무기한 대기하지 않게 하는 것이 목적). */
const DEFAULT_GOOGLE_SHEETS_TIMEOUT_MS = 30_000;

/** Promise가 timeoutMs 안에 끝나지 않으면 명확한 에러로 대신 reject한다. 원본 promise 자체를
 * 취소하지는 않는다(위 상수 설명 참고) — 호출자가 그 결과를 더 이상 기다리지 않을 뿐이다. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `${what}이(가) ${String(timeoutMs)}ms 안에 응답하지 않아 타임아웃 처리했습니다. ` +
            "네트워크 상태나 Google API 장애 여부를 확인한 뒤 다시 시도하세요.",
        ),
      );
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** google-auth-library JWTInput의 필수 사용 필드만 검증한다. 나머지 키는 그대로 흘려보낸다(passthrough) */
const serviceAccountKeySchema = z
  .object({
    client_email: z.string().min(1),
    private_key: z.string().min(1),
  })
  .passthrough();

/**
 * 이 어댑터가 실제로 쓰는 Sheets API 표면만 좁게 정의한 인터페이스.
 * googleapis의 `sheets_v4.Sheets`는 구조적으로 이 인터페이스를 만족하므로 실제 클라이언트를
 * 그대로 대입할 수 있고, 테스트는 이 좁은 표면만 흉내내는 목을 주입하면 된다(AR-008).
 */
export interface SheetsApiLike {
  spreadsheets: {
    values: {
      get(params: {
        spreadsheetId: string;
        range: string;
      }): Promise<{ data: { values?: unknown[][] | null } }>;
      update(params: {
        spreadsheetId: string;
        range: string;
        valueInputOption: string;
        requestBody: { values: unknown[][] };
      }): Promise<unknown>;
      batchUpdate(params: {
        spreadsheetId: string;
        requestBody: {
          valueInputOption: string;
          data: Array<{ range: string; values: unknown[][] }>;
        };
      }): Promise<unknown>;
    };
  };
}

export interface GoogleSheetClientOptions {
  /** 기본값: 환경변수 GOOGLE_SERVICE_ACCOUNT_JSON */
  serviceAccountKeyPath?: string;
  /** 테스트 전용: 실제 인증 없이 Sheets API 호출부를 직접 주입한다 (AR-008) */
  sheetsApi?: SheetsApiLike;
  /** Sheets API 호출당 timeout(ms). 기본값 DEFAULT_GOOGLE_SHEETS_TIMEOUT_MS(30초). 테스트에서
   * "응답이 영영 안 오는" 상황을 짧은 시간 안에 검증하려고 주입 가능하게 열어 둔다(AR-023). */
  timeoutMs?: number;
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

/**
 * A1 표기법에 맞게 시트(탭) 이름을 인용한다. 공백·작은따옴표·`!` 등 특수문자가 포함된 이름은
 * 인용하지 않으면 range 파싱이 실패하거나 다른 범위로 오해석될 수 있다. 단순한 이름을 인용해도
 * A1 표기법상 항상 유효하므로 예외 없이 전부 인용한다(AR-007). 내부 `'`는 `''`로 이스케이프.
 */
function quoteSheetName(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

export class GoogleSheetClient implements SheetClient {
  private readonly keyPath: string | undefined;
  private sheetsApi: SheetsApiLike | null;
  private readonly timeoutMs: number;

  constructor(options: GoogleSheetClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GOOGLE_SHEETS_TIMEOUT_MS;

    if (options.sheetsApi) {
      this.sheetsApi = options.sheetsApi;
      this.keyPath = undefined;
      return;
    }

    const keyPath = options.serviceAccountKeyPath ?? process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!keyPath) {
      throw new Error(
        "GOOGLE_SERVICE_ACCOUNT_JSON 환경변수가 없습니다. .env에 서비스 계정 키 JSON 파일 경로를 " +
          "설정하세요 (예: GOOGLE_SERVICE_ACCOUNT_JSON=./service-account.json). .env.example 참고.",
      );
    }
    this.keyPath = keyPath;
    this.sheetsApi = null;
  }

  // 전부 동기 작업(파일 읽기/JSON 파싱/인증 클라이언트 생성)이라 async가 필요 없다.
  // require-await 규칙 회피가 아니라 실제로 비동기 IO가 없는 함수다.
  private getSheetsApi(): SheetsApiLike {
    if (this.sheetsApi) return this.sheetsApi;

    // 생성자에서 sheetsApi를 주입하지 않았다면 keyPath는 반드시 존재한다(생성자에서 보장).
    const keyPath = this.keyPath;
    if (keyPath === undefined) {
      throw new Error("내부 오류: GoogleSheetClient에 keyPath도 sheetsApi도 없습니다.");
    }

    let raw: string;
    try {
      raw = readFileSync(keyPath, "utf-8");
    } catch (err) {
      throw new Error(
        `서비스 계정 키 파일을 읽을 수 없습니다: '${keyPath}'. GOOGLE_SERVICE_ACCOUNT_JSON ` +
          `경로가 올바른지, 파일이 존재하는지 확인하세요. (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `서비스 계정 키 파일 '${keyPath}'이 올바른 JSON이 아닙니다. Google Cloud Console에서 ` +
          "발급받은 서비스 계정 키 JSON 파일인지 확인하세요.",
      );
    }

    const result = serviceAccountKeySchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `서비스 계정 키 파일 '${keyPath}'에 client_email/private_key가 없습니다. ` +
          "Google Cloud Console > IAM 및 관리자 > 서비스 계정에서 키를 다시 발급받으세요.",
      );
    }

    const auth = new google.auth.GoogleAuth({ credentials: result.data, scopes: SCOPES });
    this.sheetsApi = google.sheets({ version: "v4", auth });
    return this.sheetsApi;
  }

  async readConfig(sheetId: string): Promise<Record<string, string>> {
    const sheets = this.getSheetsApi();
    const res = await withTimeout(
      sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `${quoteSheetName("notify_config")}!A:B`,
      }),
      this.timeoutMs,
      "notify_config 읽기(Sheets API)",
    );

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
    const res = await withTimeout(
      sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: quoteSheetName(tab),
      }),
      this.timeoutMs,
      `'${tab}' 탭 읽기(Sheets API)`,
    );

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

  private async readHeader(sheets: SheetsApiLike, sheetId: string, tab: string): Promise<string[]> {
    const res = await withTimeout(
      sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `${quoteSheetName(tab)}!1:1`,
      }),
      this.timeoutMs,
      `'${tab}' 탭 헤더 읽기(Sheets API)`,
    );
    const headerRow: unknown[] = res.data.values?.[0] ?? [];
    return headerRow.map((cell) => cellToString(cell));
  }

  async ensureStatusColumns(sheetId: string, tab: string): Promise<void> {
    const sheets = this.getSheetsApi();
    const header = await this.readHeader(sheets, sheetId, tab);
    const missing = STATUS_COLUMNS.filter((column) => !header.includes(column));
    if (missing.length === 0) return;

    const startColumnLetter = columnIndexToLetter(header.length);
    await withTimeout(
      sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${quoteSheetName(tab)}!${startColumnLetter}1`,
        valueInputOption: "RAW",
        requestBody: { values: [missing] },
      }),
      this.timeoutMs,
      "상태 컬럼 헤더 기록(Sheets API)",
    );
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

    const quotedTab = quoteSheetName(tab);

    // sentAt/messageId/error는 3단계 값이다(DESIGN §3 StatusUpdate, AR-014):
    // undefined=건드리지 않음(그 range는 아예 batchUpdate에 넣지 않음),
    // null=명시적으로 지움(빈 문자열 기록), string=그 값으로 설정.
    // InMemorySheetClient(mocks)와 동일한 계약.
    const data: Array<{ range: string; values: unknown[][] }> = [];
    const pushOptionalCell = (
      columnLetter: string,
      rowIndex: number,
      value: string | null | undefined,
    ): void => {
      if (value === undefined) return;
      data.push({
        range: `${quotedTab}!${columnLetter}${String(rowIndex)}`,
        values: [[value === null ? "" : value]],
      });
    };
    for (const update of updates) {
      data.push({
        range: `${quotedTab}!${columnLetters._send_status}${String(update.rowIndex)}`,
        values: [[update.sendStatus]],
      });
      pushOptionalCell(columnLetters._sent_at, update.rowIndex, update.sentAt);
      pushOptionalCell(columnLetters._message_id, update.rowIndex, update.messageId);
      pushOptionalCell(columnLetters._error, update.rowIndex, update.error);
    }

    await withTimeout(
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: { valueInputOption: "RAW", data },
      }),
      this.timeoutMs,
      "발송 상태 write-back(Sheets API)",
    );
  }
}
