// Zod input/output schemas for the 4 MCP tools (DESIGN §5). The schema definitions are kept
// separate so server.ts can focus purely on "tool registration wiring". Task: docs/TASKS.md T8.

import { z } from "zod";
import { DEFAULT_SEND_LOG_LIST_LIMIT, MAX_SEND_LOG_LIST_LIMIT } from "./core/types.js";

export const sheetIdSchema = z
  .string()
  .min(
    1,
    "sheetId is empty. Pass the target Google Sheets ID (the <this part> in the sheet URL's /d/<this part>/edit).",
  );

const sheetRowSchema = z.object({
  rowIndex: z.number(),
  values: z.record(z.string(), z.string()),
});

/** read_rows tool output (1:1 with core/readRows.ts ReadTargetRowsResult) */
export const readRowsOutputSchema = {
  rows: z.array(sheetRowSchema),
  totalMatched: z.number(),
  truncated: z.boolean(),
};

const sendStatusSchema = z.enum(["sent", "failed", "skipped_duplicate", "sent_log_failed"]);

const pipelineRowDetailSchema = z.object({
  rowIndex: z.number(),
  rowKey: z.string(),
  status: sendStatusSchema,
  to: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  messageId: z.string().optional(),
  error: z.string().optional(),
});

/** The core/pipeline.ts PipelineResult shape shared by preview_messages / send_notifications.
 * sent+failed+skipped+logFailed === details.length always holds (aggregation invariant, GAP-002).
 * totalMatched/truncated: whether details was truncated because rows passing the filter
 * exceeded MAX_PIPELINE_ROWS (docs/ADVERSARIAL_REVIEW_004.md AR-022). */
const pipelineResultShape = {
  sent: z.number(),
  failed: z.number(),
  skipped: z.number(),
  logFailed: z.number(),
  totalMatched: z.number(),
  truncated: z.boolean(),
  details: z.array(pipelineRowDetailSchema),
};

/** preview_messages tool output — the PipelineResult as-is */
export const previewMessagesOutputSchema = pipelineResultShape;

/** send_notifications tool output — PipelineResult + double-safeguard decision result */
export const sendNotificationsOutputSchema = {
  ...pipelineResultShape,
  liveSend: z.boolean(),
  notice: z.string().optional(),
};

// SendLog stores only two statuses: claimed (reserved but not yet finalized) or sent (finalized) —
// separate from the 4 statuses written to the sheet (sendStatusSchema) (core/types.ts SendLogEntryStatus, GAP-001/002).
const sendLogEntryStatusSchema = z.enum(["claimed", "sent"]);

const sendLogEntrySchema = z.object({
  sheetId: z.string(),
  tab: z.string(),
  rowKey: z.string(),
  templateHash: z.string(),
  sendStatus: sendLogEntryStatusSchema,
  sentAt: z.string(),
  messageId: z.string().optional(),
});

/** get_send_log tool output — 1:1 with SendLogListResult. hasMore/nextCursor are not
 * approximations — they are exact values computed by fetching limit+1 entries (GAP-006). */
export const getSendLogOutputSchema = {
  entries: z.array(sendLogEntrySchema),
  hasMore: z.boolean(),
  nextCursor: z.string().optional(),
};

/** limit for the get_send_log tool input — caps the response size so it doesn't grow unbounded
 * even as history accumulates indefinitely (docs/ADVERSARIAL_REVIEW_003.md AR-015). */
export const sendLogLimitSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_SEND_LOG_LIST_LIMIT, `limit can be at most ${String(MAX_SEND_LOG_LIST_LIMIT)}.`)
  .optional()
  .describe(
    `Maximum number of entries to return (most recent first). Defaults to ${String(DEFAULT_SEND_LOG_LIST_LIMIT)} if omitted, ` +
      `and can be set up to ${String(MAX_SEND_LOG_LIST_LIMIT)}.`,
  );

/** cursor for the get_send_log tool input — passing the previous call's nextCursor as-is
 * returns the next (older) page (GAP-006). */
export const sendLogCursorSchema = z
  .string()
  .optional()
  .describe(
    "Passing the previous get_send_log response's nextCursor as-is returns the next (older) page.",
  );
