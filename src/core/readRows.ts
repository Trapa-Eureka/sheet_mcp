// Logic backing the read_rows MCP tool (DESIGN §5) — returns a preview of the rows targeted
// for sending, with notify_config applied. Lives in core/, so it only knows the SheetClient
// interface and knows nothing of external IO.
// Task: docs/TASKS.md T8.

import { parseNotifyConfig } from "./config.js";
import { applyFilter } from "./pipeline.js";
import type { SheetClient, SheetRow } from "./types.js";

/** DESIGN §5: read_rows is a "preview of up to 200 rows" */
export const READ_ROWS_PREVIEW_LIMIT = 200;

export interface ReadTargetRowsResult {
  rows: SheetRow[];
  /** Total number of rows actually matched after applying filter_column/filter_value (can exceed rows.length) */
  totalMatched: number;
  /** Whether totalMatched exceeded the preview limit and was truncated */
  truncated: boolean;
}

/**
 * Reads and validates notify_config, reads the data tab, applies filter_column/filter_value,
 * and returns at most READ_ROWS_PREVIEW_LIMIT rows. If config validation fails, ConfigParseError
 * propagates as-is.
 */
export async function readTargetRows(
  sheetClient: SheetClient,
  sheetId: string,
): Promise<ReadTargetRowsResult> {
  const rawConfig = await sheetClient.readConfig(sheetId);
  const config = parseNotifyConfig(rawConfig);
  const allRows = await sheetClient.readRows(sheetId, config.dataTab);
  const filtered = applyFilter(allRows, config.filterColumn, config.filterValue);

  return {
    rows: filtered.slice(0, READ_ROWS_PREVIEW_LIMIT),
    totalMatched: filtered.length,
    truncated: filtered.length > READ_ROWS_PREVIEW_LIMIT,
  };
}
