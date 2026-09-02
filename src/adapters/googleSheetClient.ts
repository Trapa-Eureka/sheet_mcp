// Actual implementation of SheetClient — googleapis + service account auth.
// Design: docs/DESIGN.md §6 (adapter notes), §2 (sheet conventions).
// We don't write tests that hit the real network (network calls forbidden, docs/TESTING.md §1) —
// instead, only the Sheets API call surface is split out behind a thin interface (SheetsApiLike)
// so it can be injected, and that mock is used for contract tests that verify range strings and
// request body shapes (tests/googleSheetClient.test.ts, docs/ADVERSARIAL_REVIEW_002.md AR-008).
// Integration checks of the real auth/read path are run manually by a human via scripts/smoke.ts
// (docs/TASKS.md T3).
//
// Sheet sharing (v0.1): the target spreadsheet must be shared with the service account's email
// (the client_email in the JSON key) as an "Editor".

import { readFileSync } from "node:fs";
import { google } from "googleapis";
import { z } from "zod";
import type { SheetClient, SheetRow, StatusUpdate } from "../core/types.js";

const STATUS_COLUMNS = ["_send_status", "_sent_at", "_message_id", "_error"] as const;
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

/** Default timeout (ms) for Sheets API calls — docs/ADVERSARIAL_REVIEW_004.md AR-023: if a
 * response never comes back due to network half-open states, DNS delays, etc., without this
 * value the whole pipeline (including claim) could hang indefinitely. This does not cancel the
 * actual in-flight request (SheetsApiLike is a narrow interface this adapter defines, so there's
 * no standard way to pass an AbortController through it) — instead, once this time elapses we
 * stop waiting for the result and fail with a clear error (the goal is to make sure the call
 * itself never waits indefinitely, whether it's readConfig/readRows/ensureStatusColumns/
 * writeStatus that gets stuck). */
const DEFAULT_GOOGLE_SHEETS_TIMEOUT_MS = 30_000;

/** Rejects with a clear error instead if the promise doesn't settle within timeoutMs. Does not
 * cancel the original promise itself (see the constant comment above) — the caller just stops
 * waiting for its result. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `${what} did not respond within ${String(timeoutMs)}ms, so it was treated as a timeout. ` +
            "Check your network status or whether the Google API is having an outage, then try again.",
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

/** Validates only the fields of google-auth-library's JWTInput that are actually used. Other keys pass through unchanged (passthrough) */
const serviceAccountKeySchema = z
  .object({
    client_email: z.string().min(1),
    private_key: z.string().min(1),
  })
  .passthrough();

/**
 * A narrow interface defining only the Sheets API surface this adapter actually uses.
 * googleapis's `sheets_v4.Sheets` structurally satisfies this interface, so the real client can
 * be passed in as-is, and tests just need to inject a mock that mimics this narrow surface (AR-008).
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
  /** Default: the GOOGLE_SERVICE_ACCOUNT_JSON environment variable */
  serviceAccountKeyPath?: string;
  /** Test only: inject the Sheets API call surface directly, without real auth (AR-008) */
  sheetsApi?: SheetsApiLike;
  /** Timeout (ms) per Sheets API call. Default DEFAULT_GOOGLE_SHEETS_TIMEOUT_MS (30s). Left
   * injectable so tests can verify a "response never comes back" scenario quickly (AR-023). */
  timeoutMs?: number;
}

/** Sheets API cell values are usually string/number/boolean, but the type is any, so stringify safely */
function cellToString(cell: unknown): string {
  if (cell === undefined || cell === null) return "";
  if (typeof cell === "string") return cell;
  if (typeof cell === "number" || typeof cell === "boolean") return String(cell);
  return JSON.stringify(cell);
}

function columnIndexToLetter(index: number): string {
  let n = index + 1; // convert to 1-based
  let letters = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/**
 * Quotes a sheet (tab) name per A1 notation. Names containing special characters like spaces,
 * single quotes, `!`, etc. can fail range parsing or be misinterpreted as a different range if
 * left unquoted. Quoting a simple name is always valid in A1 notation too, so we quote
 * everything without exception (AR-007). An internal `'` is escaped as `''`.
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
        "The GOOGLE_SERVICE_ACCOUNT_JSON environment variable is not set. Set it in .env to the " +
          "path of your service account key JSON file (e.g. GOOGLE_SERVICE_ACCOUNT_JSON=./service-account.json). " +
          "See .env.example.",
      );
    }
    this.keyPath = keyPath;
    this.sheetsApi = null;
  }

  // All operations here are synchronous (file read / JSON parse / creating the auth client), so
  // async isn't actually needed. This isn't dodging the require-await rule — there's genuinely no
  // async IO in this function.
  private getSheetsApi(): SheetsApiLike {
    if (this.sheetsApi) return this.sheetsApi;

    // If sheetsApi wasn't injected in the constructor, keyPath is guaranteed to exist (enforced there).
    const keyPath = this.keyPath;
    if (keyPath === undefined) {
      throw new Error("Internal error: GoogleSheetClient has neither keyPath nor sheetsApi.");
    }

    let raw: string;
    try {
      raw = readFileSync(keyPath, "utf-8");
    } catch (err) {
      throw new Error(
        `Could not read the service account key file: '${keyPath}'. Check that the ` +
          `GOOGLE_SERVICE_ACCOUNT_JSON path is correct and the file exists. (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `The service account key file '${keyPath}' is not valid JSON. Make sure it's the ` +
          "service account key JSON file issued by Google Cloud Console.",
      );
    }

    const result = serviceAccountKeySchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `The service account key file '${keyPath}' is missing client_email/private_key. ` +
          "Reissue the key from Google Cloud Console > IAM & Admin > Service Accounts.",
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
      "reading notify_config (Sheets API)",
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
      `reading tab '${tab}' (Sheets API)`,
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
      // Row 1 is the header, so data rows start at row 2 (DESIGN §2)
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
      `reading header of tab '${tab}' (Sheets API)`,
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
      "writing status column headers (Sheets API)",
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
          `writeStatus: sheet '${sheetId}' tab '${tab}' has no '${columnName}' column. ` +
            "Call ensureStatusColumns first to create the status columns.",
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

    // sentAt/messageId/error are 3-state values (DESIGN §3 StatusUpdate, AR-014):
    // undefined = leave untouched (that range isn't included in batchUpdate at all),
    // null = explicitly clear (write empty string), string = set to that value.
    // Same contract as InMemorySheetClient (mocks).
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
      "send status write-back (Sheets API)",
    );
  }
}
