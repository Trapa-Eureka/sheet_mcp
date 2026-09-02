// Send pipeline — the flow from docs/DESIGN.md §4. core/ knows only interfaces and nothing about the
// actual adapters (SheetClient/NotificationProvider/SendLog/Clock are all injected via the constructor).
// Task: docs/TASKS.md T7. Atomic duplicate prevention via claim/commit/release, the sent_log_failed
// status, and the AR-014 status-cell policy address docs/ADVERSARIAL_REVIEW_003.md
// AR-011/AR-013/AR-014/AR-017.

import { createHash } from "node:crypto";
import { z } from "zod";
import { parseNotifyConfig, type NotifyConfig } from "./config.js";
import { renderTemplate } from "./template.js";
import type {
  Clock,
  NotificationProvider,
  SendLog,
  SendStatus,
  SheetClient,
  SheetRow,
  StatusUpdate,
} from "./types.js";

export interface SendPipelineDeps {
  sheetClient: SheetClient;
  provider: NotificationProvider;
  sendLog: SendLog;
  clock: Clock;
}

export interface RunOptions {
  dryRun: boolean;
}

export interface PipelineRowDetail {
  rowIndex: number;
  rowKey: string;
  status: SendStatus;
  to?: string;
  subject?: string;
  body?: string;
  messageId?: string;
  error?: string;
}

export interface PipelineResult {
  sent: number;
  failed: number;
  skipped: number;
  /** Number of rows with status==="sent_log_failed". Not folded into sent/failed/skipped — mixing an
   * uncertain status that is neither "success" nor "failure" into another aggregate would blur that
   * aggregate's meaning. Instead sent+failed+skipped+logFailed always equals details.length (the
   * aggregate invariant, docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md GAP-002). */
  logFailed: number;
  /** Total number of rows actually matched after applying filter_column/filter_value (can be larger than
   * details.length — when truncated for exceeding MAX_PIPELINE_ROWS.
   * docs/ADVERSARIAL_REVIEW_004.md AR-022). */
  totalMatched: number;
  /** Whether totalMatched exceeded MAX_PIPELINE_ROWS and details was truncated. Can only be true in
   * dry-run — in live mode, exceeding this limit makes run() itself throw instead of truncating and
   * sending only part of the rows (see below). */
  truncated: boolean;
  details: PipelineRowDetail[];
}

/** The maximum number of rows preview/send can process in a single call (measured after filtering) — a
 * conservative cap sized to the fixtures/sheets/large-1000.json (1000-row) scale from the "example sheet
 * template" in docs/DESIGN.md §6 (docs/ADVERSARIAL_REVIEW_004.md AR-022). It does not limit the Google
 * Sheets read itself or the sheet's size, but it caps how many rows this server will render, send, and
 * serialize into a response within a single run, so that a large or accidentally-widened sheet cannot
 * cause a memory spike or a mass accidental send. It is not exposed via an environment variable — exposing
 * it would let a human raise it by mistake and bypass this safeguard itself. */
export const MAX_PIPELINE_ROWS = 1000;

/**
 * The first 12 hex characters of the sha256 of the **original** (pre-render) subject+body template —
 * DESIGN §4 step 4. It hashes the template string itself, not the row values, so all rows sharing the
 * same template share the same hash, and fixing the template (e.g. correcting a typo) changes the hash
 * and allows re-sending (intended behavior).
 *
 * subject and body are **each hashed first, and then the two digests are concatenated and hashed again**
 * — inserting a delimiter character between them instead (e.g. a space) would let a boundary coincide
 * with that delimiter character, so "A "+"B" and "A"+" B" would collapse into the same byte sequence for
 * two different (subject, body) pairs and collide (docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md
 * REG-001 — actually reproduced with a space delimiter). A sha256 digest is always a fixed 64 hex
 * characters, so the boundary where the two digests are concatenated never shifts based on content,
 * which eliminates this problem at the root.
 */
export function computeTemplateHash(subjectTemplate: string, bodyTemplate: string): string {
  const subjectDigest = createHash("sha256").update(subjectTemplate).digest("hex");
  const bodyDigest = createHash("sha256").update(bodyTemplate).digest("hex");
  return createHash("sha256").update(subjectDigest).update(bodyDigest).digest("hex").slice(0, 12);
}

/**
 * The decision logic for DESIGN §5's "dual safeguard": it is a real send only when **both** the tool
 * parameter (confirm) and the process environment variable (SEND_MODE) are satisfied. It's a pure
 * function, so it can be verified in this file's tests without an MCP server. If either one is missing,
 * dryRun=true unconditionally — fail toward the safe side.
 */
export function resolveDryRun(sendMode: string | undefined, confirm: boolean): boolean {
  return !(sendMode === "live" && confirm);
}

/**
 * The notice text the DESIGN §5 send_notifications tool attaches. When resolveDryRun() returned
 * dryRun=true (i.e., no real send happened), it explains why not and how to actually send for real. No
 * notice is needed for a real send, so undefined.
 */
export function buildDryRunNotice(dryRun: boolean): string | undefined {
  if (!dryRun) return undefined;
  return (
    "No actual send was made (this is a preview result). To actually send, pass " +
    "confirm=true when calling send_notifications, and set SEND_MODE=live in the server process's " +
    "environment variables (DESIGN §5 dual safeguard — both are required)."
  );
}

/** Keeps only the rows targeted for sending by applying filter_column/filter_value. Exported because the
 * read_rows tool (core/readRows.ts) must apply the same filtering rule. */
export function applyFilter(
  rows: SheetRow[],
  filterColumn: string | undefined,
  filterValue: string | undefined,
): SheetRow[] {
  // config.ts has already validated that filter_column/filter_value are "either both present or both
  // absent", so we don't need to worry about only one of them being present here.
  if (filterColumn === undefined || filterValue === undefined) {
    return rows;
  }
  // DESIGN §2/TESTING §4: compare case-sensitively (no normalization).
  return rows.filter((row) => row.values[filterColumn] === filterValue);
}

// A pragmatic format check that filters out only common, obviously-bad addresses (`a@`, `@example.com`,
// `a@@example.com`, addresses containing whitespace, etc.) at the boundary before sending, rather than a
// full RFC 5322 implementation — docs/ADVERSARIAL_REVIEW_003.md AR-017.
const emailFormatSchema = z.string().email();

/** Internal pipeline working state. "pending" means before a send attempt (having passed the idempotency
 * check), and unless it's on the dryRun path, every row must resolve to a non-pending status by the time
 * run() finishes. */
interface WorkingRow {
  rowIndex: number;
  rowKey: string;
  status: SendStatus | "pending";
  to?: string;
  subject?: string;
  body?: string;
  messageId?: string;
  error?: string;
}

export class SendPipeline {
  constructor(private readonly deps: SendPipelineDeps) {}

  async run(sheetId: string, opts: RunOptions): Promise<PipelineResult> {
    // 1. Read config + validate with zod — on failure, the ConfigParseError propagates as-is.
    //    (The error message itself already carries "what's wrong + how to fix it", so no need to wrap it here.)
    const rawConfig = await this.deps.sheetClient.readConfig(sheetId);
    const config = parseNotifyConfig(rawConfig);

    // 2. Read rows + apply filter_column/filter_value
    const allRows = await this.deps.sheetClient.readRows(sheetId, config.dataTab);
    const matchedRows = applyFilter(allRows, config.filterColumn, config.filterValue);
    const totalMatched = matchedRows.length;
    const truncated = totalMatched > MAX_PIPELINE_ROWS;

    // AR-022: if the rows passing the filter exceed MAX_PIPELINE_ROWS, in live mode we don't quietly
    // send only some of them — we abort the send entirely before it starts. A partial-send incident
    // where "some people got it and some didn't, and we don't know which" is far more dangerous than
    // nobody getting it and the operator narrowing the filter and retrying. dry-run doesn't change any
    // state, so it just truncates for the preview and reports via totalMatched/truncated that there is
    // actually more (the same policy as read_rows).
    if (truncated && !opts.dryRun) {
      throw new Error(
        `The send target has ${String(totalMatched)} rows, exceeding the limit (${String(MAX_PIPELINE_ROWS)} rows). ` +
          "Narrow the target using notify_config's filter_column/filter_value, or run it in multiple " +
          "batches. For safety, the entire run was aborted instead of sending only part of it (nothing was sent).",
      );
    }
    const rows = truncated ? matchedRows.slice(0, MAX_PIPELINE_ROWS) : matchedRows;

    const templateHash = computeTemplateHash(config.subjectTemplate, config.bodyTemplate);

    // 3. Per-row rendering — a missing recipient, malformed email format, or missing template variable
    // is finalized as failed right here.
    const workingRows = rows.map((row) => this.planRow(row, config));

    if (opts.dryRun) {
      // dry-run-only idempotency check: uses only the read-only wasSent(), which doesn't change state
      // (claim() is never used here — if the preview created a real send reservation, that reservation
      // would sit there forever with no commit/release and block a later real send).
      for (const row of workingRows) {
        if (row.status !== "pending") continue;
        if (this.deps.sendLog.wasSent(sheetId, config.dataTab, row.rowKey, templateHash)) {
          row.status = "skipped_duplicate";
        }
      }
      // For dryRun, return only the result here (a preview of what would be sent) — no provider,
      // sendLog, or sheet writes at all
      return this.summarize(workingRows, true, totalMatched, truncated);
    }

    // 4-6 (live): for each row, complete "reserve (claim) → send → confirm (commit)/release" fully, one
    // row at a time, before moving on to the next — this way, even if the same rowKey appears twice in
    // the same batch, the second row's claim() fails immediately and prevents a duplicate send (AR-011).
    // Individual try/catch means one row's failure doesn't abort the batch.
    const nowIso = this.deps.clock.now().toISOString();
    for (const row of workingRows) {
      if (row.status !== "pending") continue;
      await this.attemptSend(sheetId, config.dataTab, templateHash, nowIso, row);
    }

    // 7. write-back: ensure status columns exist, then apply the updates in bulk
    await this.deps.sheetClient.ensureStatusColumns(sheetId, config.dataTab);
    const updates = workingRows.map((row) => toStatusUpdate(row, nowIso));
    await this.deps.sheetClient.writeStatus(sheetId, config.dataTab, updates);

    // 8. Return the aggregate (in live mode, truncated=false was already enforced above)
    return this.summarize(workingRows, false, totalMatched, truncated);
  }

  private planRow(row: SheetRow, config: NotifyConfig): WorkingRow {
    const rowIndex = row.rowIndex;
    const rawRowKey = row.values[config.idColumn];
    const rowKey =
      rawRowKey !== undefined && rawRowKey.trim() !== ""
        ? rawRowKey
        : `__row_${String(rowIndex)}__`;

    if (rawRowKey === undefined || rawRowKey.trim() === "") {
      return {
        rowIndex,
        rowKey,
        status: "failed",
        error:
          `Row has an empty id_column '${config.idColumn}' value (rowIndex ${String(rowIndex)}). ` +
          `Fill in the ${config.idColumn} value for that row in the '${config.dataTab}' tab.`,
      };
    }

    const recipient = row.values[config.recipientColumn];
    if (recipient === undefined || recipient.trim() === "") {
      return {
        rowIndex,
        rowKey,
        status: "failed",
        error:
          `The recipient column (recipient_column='${config.recipientColumn}') value is empty (rowIndex ${String(rowIndex)}). ` +
          `Fill in the ${config.recipientColumn} value for that row in the '${config.dataTab}' tab.`,
      };
    }

    if (!emailFormatSchema.safeParse(recipient).success) {
      return {
        rowIndex,
        rowKey,
        status: "failed",
        to: recipient,
        error:
          `The recipient email format is invalid: '${recipient}' (rowIndex ${String(rowIndex)}). ` +
          `Fix the ${config.recipientColumn} value to a valid email address.`,
      };
    }

    const subjectResult = renderTemplate(config.subjectTemplate, row.values);
    const bodyResult = renderTemplate(config.bodyTemplate, row.values);
    const missing = [...new Set([...subjectResult.missing, ...bodyResult.missing])];
    if (missing.length > 0) {
      return {
        rowIndex,
        rowKey,
        status: "failed",
        to: recipient,
        error:
          `Missing template variable(s): ${missing.join(", ")} (rowIndex ${String(rowIndex)}). ` +
          `Add a column with that name to the '${config.dataTab}' tab, or remove it from the template in notify_config.`,
      };
    }

    return {
      rowIndex,
      rowKey,
      status: "pending",
      to: recipient,
      subject: subjectResult.text,
      body: bodyResult.text,
    };
  }

  private async attemptSend(
    sheetId: string,
    tab: string,
    templateHash: string,
    nowIso: string,
    row: WorkingRow,
  ): Promise<void> {
    if (row.to === undefined || row.body === undefined) {
      // planRow always fills in to/body on the only path where it returns "pending", so this is
      // unreachable in practice. A defensive guard — reaching this means the invariant between
      // planRow/attemptSend was broken by a bug.
      throw new Error(
        `Internal error: rowKey '${row.rowKey}' is in pending status but has no to or body. Please report this bug.`,
      );
    }

    // Atomic claim — this single call blocks a duplicate rowKey within the same batch, another process
    // running concurrently, and any past success, all at once (AR-011). If claim fails, the provider is
    // never called at all.
    const claim = this.deps.sendLog.claim(sheetId, tab, row.rowKey, templateHash, nowIso);
    if (!claim.claimed) {
      row.status = "skipped_duplicate";
      return;
    }
    if (claim.token === undefined) {
      // The SendLog implementation returned claimed=true without a token — a violation of the interface
      // contract. Catching it here prevents the even more confusing failure of an undefined token being
      // passed on to commit/release.
      throw new Error(
        `Internal error: SendLog.claim() returned claimed=true but no token (rowKey='${row.rowKey}'). ` +
          "This is a bug in the SendLog implementation.",
      );
    }
    const token = claim.token;

    try {
      const result = await this.deps.provider.send({
        rowKey: row.rowKey,
        to: row.to,
        subject: row.subject,
        body: row.body,
        channel: this.deps.provider.channel,
      });

      if (result.ok) {
        try {
          this.deps.sendLog.commit(
            sheetId,
            tab,
            row.rowKey,
            templateHash,
            token,
            nowIso,
            result.messageId,
          );
          row.status = "sent";
          row.messageId = result.messageId;
        } catch (commitErr) {
          // The send itself already succeeded — releasing the claim would cause a genuine duplicate-send
          // incident by re-sending identically on the next run, so it must never be released (AR-013).
          // Instead, this run's result is marked with a separate status so a human can manually check
          // SendLog and the sheet.
          row.status = "sent_log_failed";
          row.messageId = result.messageId;
          row.error =
            `The send succeeded (messageId=${result.messageId ?? "none"}), but saving the local send log failed: ` +
            `${commitErr instanceof Error ? commitErr.message : String(commitErr)}. Manually check SendLog and ` +
            "this sheet row, and do not re-send without first confirming whether it was actually already sent.";
          console.error(
            `[sheet-mcp] sent_log_failed: sheetId=${sheetId} tab=${tab} rowKey=${row.rowKey} ` +
              `messageId=${result.messageId ?? "none"} — ${row.error}`,
          );
        }
      } else {
        row.status = "failed";
        row.error = result.error ?? `${this.deps.provider.channel} send failed (reason unknown).`;
        this.safeRelease(sheetId, tab, templateHash, token, row);
      }
    } catch (err) {
      row.status = "failed";
      row.error = `An exception occurred while sending: ${err instanceof Error ? err.message : String(err)}`;
      this.safeRelease(sheetId, tab, templateHash, token, row);
    }
  }

  /**
   * Never lets a release() failure (DB lock, IO error, etc.) propagate outward on its own — previously,
   * a release() failure propagated straight out of attemptSend() and stopped run()'s for loop, breaking
   * the core contract that "one row's failure must not block the rest of the batch"
   * (docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md GAP-003). If release fails, this row's claim stays
   * unreleased, which may block a retry on the next run — that fact is recorded in the error message and
   * on stderr so a human can recover it with forceReleaseStaleClaim().
   */
  private safeRelease(
    sheetId: string,
    tab: string,
    templateHash: string,
    token: string,
    row: WorkingRow,
  ): void {
    try {
      this.deps.sendLog.release(sheetId, tab, row.rowKey, templateHash, token);
    } catch (releaseErr) {
      const releaseErrMessage =
        releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
      row.error = `${row.error ?? ""} (Additionally, releasing the reservation also failed, which may be blocking retries automatically: ${releaseErrMessage}. Manual verification is required.)`;
      console.error(
        `[sheet-mcp] release failed: sheetId=${sheetId} tab=${tab} rowKey=${row.rowKey} — ${releaseErrMessage}`,
      );
    }
  }

  private summarize(
    rows: WorkingRow[],
    dryRun: boolean,
    totalMatched: number,
    truncated: boolean,
  ): PipelineResult {
    const details: PipelineRowDetail[] = rows.map((row) => ({
      rowIndex: row.rowIndex,
      rowKey: row.rowKey,
      status: finalizeStatus(row, dryRun),
      to: row.to,
      subject: row.subject,
      body: row.body,
      messageId: row.messageId,
      error: row.error,
    }));

    return {
      sent: details.filter((d) => d.status === "sent").length,
      failed: details.filter((d) => d.status === "failed").length,
      skipped: details.filter((d) => d.status === "skipped_duplicate").length,
      logFailed: details.filter((d) => d.status === "sent_log_failed").length,
      totalMatched,
      truncated,
      details,
    };
  }
}

/**
 * Finalizes "pending" (passed validation and not a duplicate, so a send was attempted) into the final
 * SendStatus. In dryRun, the provider is never called, so the actual outcome is unknown — DESIGN §4
 * step 5 states the result is "only the list of what would be sent", so a pending row is treated as the
 * prediction "this will be sent" and reported as status="sent" (for preview purposes only; the actual
 * send result may differ).
 */
function finalizeStatus(row: WorkingRow, dryRun: boolean): SendStatus {
  if (row.status !== "pending") {
    return row.status;
  }
  if (!dryRun) {
    // run()'s live path resolves every pending row via attemptSend(), so reaching here is a bug.
    throw new Error(
      `Internal error: rowKey '${row.rowKey}' is not dryRun but is still in the pre-send-attempt (pending) status.`,
    );
  }
  return "sent";
}

/**
 * Converts a row into a StatusUpdate. sentAt/messageId/error missing-value policy
 * (docs/ADVERSARIAL_REVIEW_003.md AR-014):
 * - sent: cleared to null so that a leftover from a past failure (_error) doesn't linger next to a new
 *   success. messageId is also rewritten based on this send (cleared to null when absent, so an old
 *   value can't appear misleadingly paired with the new sentAt).
 * - sent_log_failed: sentAt/messageId/error are all filled in, so a human can see directly in the sheet
 *   that the send succeeded but the local record failed.
 * - failed: the past _sent_at/_message_id are **deliberately preserved** — the judgment is that an audit
 *   record showing this row was actually sent successfully before must not be erased by a new template's
 *   failed attempt (a documented policy).
 * - skipped_duplicate: nothing is touched (past sent audit record preserved, keeping the existing
 *   policy).
 */
function toStatusUpdate(row: WorkingRow, nowIso: string): StatusUpdate {
  if (row.status === "pending") {
    // Only ever called after run()'s live path, so unreachable in practice — a defensive guard.
    throw new Error(
      `Internal error: rowKey '${row.rowKey}' is still pending at write-back time. Please report this bug.`,
    );
  }
  if (row.status === "sent") {
    return {
      rowIndex: row.rowIndex,
      sendStatus: "sent",
      sentAt: nowIso,
      messageId: row.messageId ?? null,
      error: null,
    };
  }
  if (row.status === "sent_log_failed") {
    return {
      rowIndex: row.rowIndex,
      sendStatus: "sent_log_failed",
      sentAt: nowIso,
      messageId: row.messageId ?? null,
      error: row.error ?? null,
    };
  }
  if (row.status === "failed") {
    return { rowIndex: row.rowIndex, sendStatus: "failed", error: row.error ?? null };
  }
  return { rowIndex: row.rowIndex, sendStatus: "skipped_duplicate" };
}
