// Human-only manual smoke script. Uses the real sheet + real email adapter —
// not included in the CI/agent gate (npm run check) (docs/TESTING.md §3 manual smoke).
//
// Flow: dry-run preview (always runs, never sends) -> confirm the target is exactly 1 row ->
// only send one real email when both SEND_MODE=live and SMOKE_CONFIRM_SEND=1 are set
// (reuses the same double-safety judgment logic as the MCP tool, DESIGN §5).
//
// Example runs:
//   npm run smoke                                          # preview only (always safe)
//   SEND_MODE=live SMOKE_CONFIRM_SEND=1 npm run smoke       # actual send (only when target is 1 row)

import { config as loadDotenv } from "dotenv";
import { GoogleSheetClient } from "../src/adapters/googleSheetClient.js";
import { ResendEmailProvider } from "../src/adapters/resendProvider.js";
import { SqliteSendLog } from "../src/adapters/sqliteSendLog.js";
import { SystemClock } from "../src/adapters/systemClock.js";
import {
  buildDryRunNotice,
  resolveDryRun,
  SendPipeline,
  type PipelineRowDetail,
} from "../src/core/pipeline.js";

// By default, only prints non-sensitive metadata (rowKey/status) — so real customer names,
// emails, amounts, etc. don't end up in terminal history or session logs
// (docs/ADVERSARIAL_REVIEW_002.md AR-009).
// showValues is taken as a parameter — keeping it as a module-load-time constant had a bug where,
// if SMOKE_SHOW_VALUES=1 was only set in .env, it wouldn't take effect because dotenv hadn't read
// .env yet at that point (docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md GAP-004).
function formatDetail(detail: PipelineRowDetail, showValues: boolean): string {
  if (showValues) {
    const parts = [
      `rowKey=${detail.rowKey}`,
      `status=${detail.status}`,
      `to=${detail.to ?? "-"}`,
      `subject=${detail.subject ?? "-"}`,
      `error=${detail.error ?? "-"}`,
    ];
    return `  - ${parts.join(" ")}`;
  }
  const hint = detail.error ? " (has an error — rerun with SMOKE_SHOW_VALUES=1 for details)" : "";
  return `  - rowKey=${detail.rowKey} status=${detail.status}${hint}`;
}

async function main(): Promise<void> {
  // Load .env if present — previously this call was missing, so even following the README
  // exactly, .env values never made it into the process
  // (docs/ADVERSARIAL_REVIEW_003.md AR-012). quiet: true suppresses dotenv's own banner so it
  // doesn't mix in with [smoke] logs (unlike server.ts there's no stdout protocol constraint
  // here, but this keeps things consistent).
  loadDotenv({ quiet: true });

  // Must be read after loadDotenv() so that a value set only via .env also takes effect (GAP-004).
  const showValues = process.env.SMOKE_SHOW_VALUES === "1";

  const sheetId = process.env.SMOKE_SHEET_ID;
  if (!sheetId) {
    console.log(
      "SMOKE_SHEET_ID environment variable is not set, skipping the smoke run. " +
        "Set SMOKE_SHEET_ID=<test Google Sheet ID> in .env and run again " +
        "(the sheet ID is the <this part> in the spreadsheet URL's /d/<this part>/edit). " +
        "That sheet must be shared as an editor with the service account email from " +
        "GOOGLE_SERVICE_ACCOUNT_JSON.",
    );
    return;
  }

  const sendLog = new SqliteSendLog();
  try {
    const pipeline = new SendPipeline({
      sheetClient: new GoogleSheetClient(),
      provider: new ResendEmailProvider(),
      sendLog,
      clock: new SystemClock(),
    });

    console.log(`[smoke] Running preview (dry-run) — sheetId=${sheetId}...`);
    const preview = await pipeline.run(sheetId, { dryRun: true });
    console.log(
      `[smoke] Preview result: sent(would send)=${String(preview.sent)} failed=${String(preview.failed)} skipped(duplicate)=${String(preview.skipped)}`,
    );
    preview.details.forEach((detail) => console.log(formatDetail(detail, showValues)));

    if (preview.sent === 0) {
      console.log("[smoke] No target rows to send. Stopping here (nothing sent).");
      return;
    }

    // The smoke script's goal is to send exactly "one real email" (docs/TASKS.md T10) — to avoid
    // accidentally sending a smoke-test email to several real customers, it stops here if the
    // target is 2 or more rows.
    if (preview.sent > 1) {
      console.log(
        `[smoke] Stopping — target is ${String(preview.sent)} rows, but a smoke run must target ` +
          "exactly 1 row. Narrow notify_config's filter_column/filter_value, or on a smoke-only " +
          "sheet, leave just 1 test row and temporarily delete or change the status of the " +
          "remaining unpaid rows.",
      );
      return;
    }

    const confirm = process.env.SMOKE_CONFIRM_SEND === "1";
    const dryRun = resolveDryRun(process.env.SEND_MODE, confirm);
    const notice = buildDryRunNotice(dryRun);
    if (notice) {
      console.log(`[smoke] ${notice}`);
      console.log(
        "[smoke] (In the smoke script, confirm is given via the SMOKE_CONFIRM_SEND=1 environment " +
          "variable.) To actually send: SEND_MODE=live SMOKE_CONFIRM_SEND=1 npm run smoke",
      );
      return;
    }

    console.log(
      "[smoke] Confirmed SEND_MODE=live && SMOKE_CONFIRM_SEND=1 — sending 1 real email...",
    );
    const sendResult = await pipeline.run(sheetId, { dryRun: false });
    console.log(
      `[smoke] Send result: sent=${String(sendResult.sent)} failed=${String(sendResult.failed)} skipped=${String(sendResult.skipped)}`,
    );
    sendResult.details.forEach((detail) => console.log(formatDetail(detail, showValues)));

    const logPage = sendLog.list(sheetId);
    console.log(
      `[smoke] SendLog(${sheetId}) accumulated records (latest ${String(logPage.entries.length)} fetched, ` +
        `hasMore=${String(logPage.hasMore)}): check complete.`,
    );
  } finally {
    // Since this is a script humans run repeatedly, explicitly clean up the DB file handle (AR-018).
    sendLog.close();
  }
}

main().catch((err: unknown) => {
  console.error("[smoke] Failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
