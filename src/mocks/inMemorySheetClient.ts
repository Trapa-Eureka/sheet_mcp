// SheetClient mock implementation — loads fixtures/sheets/*.json and emulates read/write in memory.
// Design: docs/DESIGN.md §3 (SheetClient contract), test strategy: docs/TESTING.md §2.

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { SheetClient, SheetRow, StatusUpdate } from "../core/types.js";

const STATUS_COLUMNS = ["_send_status", "_sent_at", "_message_id", "_error"] as const;

export interface SheetFixture {
  notifyConfig: Record<string, string>;
  tabs: Record<string, Array<Record<string, string>>>;
}

export interface SheetFixtureFile extends SheetFixture {
  sheetId: string;
}

/** Shared logic for applying the 3-state value of a StatusUpdate field (DESIGN §3, AR-014) — GoogleSheetClient honors the same contract.
 * undefined = leave untouched, null = clear (empty string), string = set to that value. */
function applyOptionalCell(
  values: Record<string, string>,
  column: string,
  value: string | null | undefined,
): void {
  if (value === undefined) return;
  values[column] = value === null ? "" : value;
}

/** The shape fixtures/sheets/*.json must satisfy. The generator script (scripts/genLargeFixture.ts) also validates its output against this schema */
export const sheetFixtureFileSchema = z.object({
  sheetId: z.string(),
  notifyConfig: z.record(z.string(), z.string()),
  tabs: z.record(z.string(), z.array(z.record(z.string(), z.string()))),
});

/** Reads fixtures/sheets/*.json and parses it into a shape ready to register directly with InMemorySheetClient (boundary zod validation) */
export function loadFixtureFile(filePath: string): SheetFixtureFile {
  const raw = readFileSync(filePath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  return sheetFixtureFileSchema.parse(parsed);
}

interface InternalRow {
  rowIndex: number;
  values: Record<string, string>;
}

interface InternalSheet {
  notifyConfig: Record<string, string>;
  tabs: Map<string, InternalRow[]>;
}

export class InMemorySheetClient implements SheetClient {
  private readonly sheets = new Map<string, InternalSheet>();

  constructor(initial: Record<string, SheetFixture> = {}) {
    for (const [sheetId, fixture] of Object.entries(initial)) {
      this.loadSheet(sheetId, fixture);
    }
  }

  /** (Re-)registers a single sheet. Overwrites if it already exists — used for test setup/reinitialization */
  loadSheet(sheetId: string, fixture: SheetFixture): void {
    const tabs = new Map<string, InternalRow[]>();
    for (const [tab, rows] of Object.entries(fixture.tabs)) {
      // Row 1 is the header, so data rows start at row 2 (DESIGN §2)
      tabs.set(
        tab,
        rows.map((values, index) => ({ rowIndex: index + 2, values: { ...values } })),
      );
    }
    this.sheets.set(sheetId, { notifyConfig: { ...fixture.notifyConfig }, tabs });
  }

  private getSheet(sheetId: string): InternalSheet {
    const sheet = this.sheets.get(sheetId);
    if (!sheet) {
      throw new Error(
        `InMemorySheetClient has no sheetId '${sheetId}'. Register it first with loadSheet(sheetId, fixture).`,
      );
    }
    return sheet;
  }

  private getTabRows(sheetId: string, tab: string): InternalRow[] {
    const rows = this.getSheet(sheetId).tabs.get(tab);
    if (!rows) {
      throw new Error(
        `InMemorySheetClient's sheet '${sheetId}' has no tab '${tab}'. Add a '${tab}' key to the fixture's tabs.`,
      );
    }
    return rows;
  }

  // This is an in-memory mock, so it actually behaves synchronously. Using the `async` keyword
  // would trip the eslint `require-await` rule because there's no await inside, so we keep this
  // a plain function and manually reproduce async's behavior of "turning a synchronous throw into
  // a rejected promise" via try/catch + Promise.resolve/reject
  // (without this wrapper, a synchronous throw would propagate as an exception straight to the
  // caller, breaking `await ...().rejects` assertions).
  readConfig(sheetId: string): Promise<Record<string, string>> {
    try {
      return Promise.resolve({ ...this.getSheet(sheetId).notifyConfig });
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  readRows(sheetId: string, tab: string): Promise<SheetRow[]> {
    try {
      return Promise.resolve(
        this.getTabRows(sheetId, tab).map((row) => ({
          rowIndex: row.rowIndex,
          values: { ...row.values },
        })),
      );
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // Known design limitation: this mock does not track headers as a list separate from rows
  // (columns exist only as keys on each row's values). So calling this on an empty tab does
  // nothing and just returns success — it can't actually verify that the 4 header cells got
  // created. Since the SheetClient interface itself has no header-lookup method, this gap is
  // currently unobservable, but it does mean this mock cannot verify whether GoogleSheetClient
  // (T3) honors the real sheet convention (DESIGN §2) that "even an empty data tab must still
  // get headers." Keep this in mind when implementing real header handling in T3.
  ensureStatusColumns(sheetId: string, tab: string): Promise<void> {
    try {
      for (const row of this.getTabRows(sheetId, tab)) {
        for (const column of STATUS_COLUMNS) {
          // `in` also walks the prototype chain, so a polluted Object.prototype could fool it into
          // skipping its own field. Use hasOwn to check strictly for an own property.
          if (!Object.hasOwn(row.values, column)) {
            row.values[column] = "";
          }
        }
      }
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  writeStatus(sheetId: string, tab: string, updates: StatusUpdate[]): Promise<void> {
    try {
      const rows = this.getTabRows(sheetId, tab);
      const byRowIndex = new Map(rows.map((row) => [row.rowIndex, row]));

      // Step 1: validate that every target exists first. This preserves the same all-or-nothing
      // contract as the real Google Sheets batchUpdate, which is processed atomically in a single
      // API call.
      // (Doing validation and application in the same loop would produce a partial failure where
      //  one bad rowIndex partway through the batch rejects after the earlier rows have already
      //  been changed.)
      const targets: InternalRow[] = [];
      for (const update of updates) {
        const row = byRowIndex.get(update.rowIndex);
        if (!row) {
          throw new Error(
            `writeStatus: sheet '${sheetId}' tab '${tab}' has no rowIndex ${String(update.rowIndex)}. Check the actual row number first with readRows. (This batch was not applied at all.)`,
          );
        }
        targets.push(row);
      }

      // Step 2: only apply the changes after validation passes.
      // sentAt/messageId/error are 3-state values (DESIGN §3 StatusUpdate, AR-014):
      // undefined = leave untouched, string = set to that value, null = explicitly clear (empty string).
      // If rowIndex repeats within the same batch, the last update wins in array order (last-write-wins).
      updates.forEach((update, i) => {
        const row = targets[i]!;
        row.values._send_status = update.sendStatus;
        applyOptionalCell(row.values, "_sent_at", update.sentAt);
        applyOptionalCell(row.values, "_message_id", update.messageId);
        applyOptionalCell(row.values, "_error", update.error);
      });
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
