// MCP 도구 4종(DESIGN §5)의 입력/출력 zod 스키마. server.ts를 "도구 등록 조립"에만 집중시키기
// 위해 스키마 정의를 분리했다. 태스크: docs/TASKS.md T8.

import { z } from "zod";
import { DEFAULT_SEND_LOG_LIST_LIMIT, MAX_SEND_LOG_LIST_LIMIT } from "./core/types.js";

export const sheetIdSchema = z
  .string()
  .min(
    1,
    "sheetId가 비어 있습니다. 대상 구글 스프레드시트 ID를 넘기세요 (시트 URL의 /d/<이 부분>/edit).",
  );

const sheetRowSchema = z.object({
  rowIndex: z.number(),
  values: z.record(z.string(), z.string()),
});

/** read_rows 도구 출력 (core/readRows.ts ReadTargetRowsResult와 1:1) */
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

/** preview_messages / send_notifications가 공유하는 core/pipeline.ts PipelineResult 형태 */
const pipelineResultShape = {
  sent: z.number(),
  failed: z.number(),
  skipped: z.number(),
  details: z.array(pipelineRowDetailSchema),
};

/** preview_messages 도구 출력 — PipelineResult 그대로 */
export const previewMessagesOutputSchema = pipelineResultShape;

/** send_notifications 도구 출력 — PipelineResult + 이중 안전장치 판정 결과 */
export const sendNotificationsOutputSchema = {
  ...pipelineResultShape,
  liveSend: z.boolean(),
  notice: z.string().optional(),
};

const sendLogEntrySchema = z.object({
  sheetId: z.string(),
  tab: z.string(),
  rowKey: z.string(),
  templateHash: z.string(),
  sendStatus: sendStatusSchema,
  sentAt: z.string(),
  messageId: z.string().optional(),
  error: z.string().optional(),
});

/** get_send_log 도구 출력 — SendLogEntry[]를 객체로 감쌈(MCP 출력 스키마는 최상위가 객체여야 함) */
export const getSendLogOutputSchema = {
  entries: z.array(sendLogEntrySchema),
  truncated: z.boolean(),
};

/** get_send_log 도구 입력의 limit — 이력이 무한정 쌓여도 응답이 무제한으로 커지지 않게 상한을 둔다
 * (docs/ADVERSARIAL_REVIEW_003.md AR-015). */
export const sendLogLimitSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_SEND_LOG_LIST_LIMIT, `limit은 최대 ${String(MAX_SEND_LOG_LIST_LIMIT)}까지입니다.`)
  .optional()
  .describe(
    `반환할 최대 건수(최신순). 생략하면 ${String(DEFAULT_SEND_LOG_LIST_LIMIT)}건, ` +
      `최대 ${String(MAX_SEND_LOG_LIST_LIMIT)}건까지 지정할 수 있습니다.`,
  );
