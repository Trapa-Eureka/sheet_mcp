// Domain types — map 1:1 to docs/DESIGN.md §3. core/ knows only these interfaces, not external IO.

export interface SheetRow {
  rowIndex: number;
  values: Record<string, string>;
}

// sent_log_failed: the actual send (provider.send) succeeded, but recording that fact in SendLog
// failed — docs/ADVERSARIAL_REVIEW_003.md AR-013. Since the fact that "the send happened" is
// settled, this must not be left as failed (retryable) — it's kept as a separate state that a
// human must check manually in SendLog/the sheet.
export type SendStatus = "sent" | "failed" | "skipped_duplicate" | "sent_log_failed";

/**
 * A per-row update that writeStatus applies to the sheet's 4 status columns
 * (_send_status/_sent_at/_message_id/_error, DESIGN §2).
 *
 * sentAt/messageId/error each take a 3-way value (docs/ADVERSARIAL_REVIEW_003.md AR-014):
 * - `undefined` (the field is omitted entirely) — that column is **left untouched**. E.g. if the
 *   same row is later recorded again as skipped_duplicate after being sent, the original
 *   _sent_at/_message_id stays as an audit record.
 * - `string` — **overwrites** the column with that value.
 * - `null` — **explicitly clears** the cell (to an empty string). E.g. if a row that previously
 *   failed now succeeds, error is cleared to null so the old _error doesn't linger next to the new
 *   success.
 */
export interface StatusUpdate {
  rowIndex: number;
  sendStatus: SendStatus;
  sentAt?: string | null; // ISO 8601
  messageId?: string | null;
  error?: string | null;
}

export interface SheetClient {
  readConfig(sheetId: string): Promise<Record<string, string>>;
  readRows(sheetId: string, tab: string): Promise<SheetRow[]>;
  ensureStatusColumns(sheetId: string, tab: string): Promise<void>;
  writeStatus(sheetId: string, tab: string, updates: StatusUpdate[]): Promise<void>;
}

export type Channel = "email" | "sms";

export interface OutboundMessage {
  rowKey: string;
  to: string;
  subject?: string;
  body: string;
  channel: Channel;
}

export interface SendResult {
  rowKey: string;
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface NotificationProvider {
  readonly channel: Channel;
  send(msg: OutboundMessage): Promise<SendResult>;
}

/**
 * Only two states are ever actually stored in SendLog — "claimed" (reserved but not yet
 * confirmed) or "sent" (an actual send confirmed via commit). failed/skipped_duplicate/
 * sent_log_failed are never stored in SendLog (they're recorded only in the sheet, as the result
 * of that run) — this is why this type is kept separate from the sheet's SendStatus
 * (docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md GAP-001/GAP-002).
 */
export type SendLogEntryStatus = "claimed" | "sent";

/** Maps 1:1 to SqliteSendLog's unique key (sheet_id, tab, row_key, template_hash — DESIGN §6). */
export interface SendLogEntry {
  sheetId: string;
  tab: string;
  rowKey: string;
  templateHash: string;
  sendStatus: SendLogEntryStatus;
  /** The time it was claimed, if claimed; the time it was confirmed (committed), if sent. */
  sentAt: string; // ISO 8601
  messageId?: string;
  error?: string;
}

/** Query options for list() — a default/max count keeps the response from growing unbounded even
 * as history piles up indefinitely (docs/ADVERSARIAL_REVIEW_003.md AR-015). */
export interface SendLogListOptions {
  /** Max number of entries to return. Defaults to DEFAULT_SEND_LOG_LIST_LIMIT if omitted, capped
   * at MAX_SEND_LOG_LIST_LIMIT. */
  limit?: number;
  /** Passing the nextCursor from a previous list() result returns the next (older) page
   * (docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md GAP-006). */
  cursor?: string;
}

/** Result of list() — instead of assuming "there's more" whenever entries.length reaches limit
 * (the inaccurate approximation flagged in GAP-006), this actually fetches limit+1 entries to
 * compute an exact hasMore. */
export interface SendLogListResult {
  entries: SendLogEntry[];
  hasMore: boolean;
  /** Present only when hasMore===true. Pass it back as options.cursor to fetch the next page. */
  nextCursor?: string;
}

export const DEFAULT_SEND_LOG_LIST_LIMIT = 200;
export const MAX_SEND_LOG_LIST_LIMIT = 1000;

/** Result of claim(). token exists only when claimed===true, and must be passed back verbatim to
 * commit()/release() — if a claim expires and a human reclaims it via forceReleaseStaleClaim(),
 * and the same key is claimed again, a new token is issued, so the original attempt (e.g. a
 * zombie process) waking up late and calling commit/release with the old token cannot touch the
 * new claim (GAP-001). */
export interface ClaimResult {
  claimed: boolean;
  token?: string;
}

/**
 * Validates forceReleaseStaleClaim()'s olderThanMs immediately at call time — both adapters
 * (SqliteSendLog/InMemorySendLog) share this single function
 * (docs/ADVERSARIAL_REVIEW_003_STATUS_GAPS.md STATUS-GAP-002).
 * A negative value would push the cutoff into the future, misjudging even the most recently
 * created claim as a "stale claim" and reclaiming (deleting) it immediately — a different run
 * could then claim the same row right after, leading to a duplicate send.
 * NaN/Infinity/non-integers are rejected for the same reason. On validation failure this throws
 * before touching any claim.
 */
export function assertValidStaleClaimThreshold(olderThanMs: number): void {
  if (!Number.isInteger(olderThanMs) || olderThanMs < 0) {
    throw new Error(
      `forceReleaseStaleClaim: invalid olderThanMs value (received: ${olderThanMs}). ` +
        "Only integers >= 0 (in milliseconds) are allowed. Example: 30 * 60 * 1000 (30 minutes). " +
        "Negative/NaN/Infinity/non-integer values are rejected because they would misjudge even " +
        "recent claims as 'stale', leading to duplicate sends — no claim was deleted.",
    );
  }
}

/**
 * SendLog — following docs/ADVERSARIAL_REVIEW_003.md AR-011/AR-013, and later addressed by
 * docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md GAP-001/002/003/006, this was redesigned around a
 * claim/commit/release 3-phase flow with ownership tokens and expiry-based manual recovery.
 *
 * The old record() had a batch structure of "check wasSent() for all rows first → then send all
 * rows", so if the same rowKey appeared twice within one run, or two processes ran concurrently,
 * both could see wasSent=false and actually send a duplicate (TOCTOU). claim() closes this gap by
 * combining "check" and "reserve" into a single atomic operation.
 *
 * If a process dies right after claim() (before commit/release), that claim stays "claimed"
 * forever — it is never automatically turned into "sent", nor automatically made reusable (since
 * whether it was actually sent is unknown). Such a claim still shows up in list() as
 * sendStatus="claimed" so an operator can find it, and once it's judged old enough, it can be
 * reclaimed via forceReleaseStaleClaim() **only explicitly** — there is never automatic expiry or
 * automatic reuse (because the possibility that it was sent can't be ruled out).
 *
 * Correct usage order in the pipeline (per row, must fully complete before moving to the next row):
 *   1. claim() — if claimed=false, it's already taken (an earlier row in the same batch / another
 *      process running concurrently / a past success / a claim not yet resolved) → don't call the
 *      provider, treat it as skipped_duplicate.
 *   2. if claimed=true, call provider.send().
 *   3a. on success, commit(token, ...) — confirms the reservation as a final send record.
 *   3b. on failure (including exceptions), release(token) — releases the reservation so the next
 *      run can retry.
 * A dry-run preview must not change state, so it uses the read-only wasSent() instead of claim().
 */
export interface SendLog {
  /**
   * Atomically reserves the right to send for (sheetId, tab, rowKey, templateHash).
   * claimed=true means this caller is the only one allowed to attempt the send, and the returned
   * token must be passed back verbatim to commit() or release() (otherwise retries stay blocked
   * forever — unless a human explicitly reclaims it via forceReleaseStaleClaim()).
   * claimed=false means someone else already claimed it — don't attempt the send; treat it as
   * skipped_duplicate.
   */
  claim(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    claimedAt: string,
  ): ClaimResult;

  /**
   * Confirms that the actual send succeeded only if the token matches the one claim() issued. If
   * the token doesn't match (e.g. a human reclaimed it in the meantime and another run claimed it
   * anew), nothing is confirmed and an error is thrown — this prevents a zombie process from
   * wrongly confirming someone else's claim (GAP-001).
   */
  commit(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    token: string,
    sentAt: string,
    messageId: string | undefined,
  ): void;

  /**
   * Releases the reservation only if the token matches the one claim() issued — this makes it
   * retryable on the next run. If the token doesn't match (already reclaimed, or replaced by a
   * different claim), this silently does nothing (it's already in the target state, or this
   * caller no longer has permission to touch it since it's no longer their claim — GAP-001).
   */
  release(sheetId: string, tab: string, rowKey: string, templateHash: string, token: string): void;

  /**
   * Force-reclaims only a claim that was claimed at least olderThanMs ago and not yet committed
   * (no token needed — this assumes a human has reviewed it and calls it manually only. It is not
   * exposed as an MCP tool — it isn't safe for an autonomous agent to judge on its own that a
   * state "might have been sent" and make it reusable). If no claim matches, this does nothing and
   * returns false.
   */
  forceReleaseStaleClaim(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    olderThanMs: number,
  ): boolean;

  /** Read-only check for whether a reservation already exists, either confirmed (committed) as
   * sent or still in progress (claimed). For dry-run preview only — since it doesn't change state,
   * it must not be used for duplicate prevention in the actual send flow (use claim() instead). */
  wasSent(sheetId: string, tab: string, rowKey: string, templateHash: string): boolean;

  list(sheetId: string, options?: SendLogListOptions): SendLogListResult;
}

/** For test determinism — the real implementation is injected with this interface instead of
 * Date.now() in SqliteSendLog/the pipeline */
export interface Clock {
  now(): Date;
}

/** Return type of core/template.ts renderTemplate(). Missing keys are collected into missing[]
 * instead of throwing */
export interface RenderResult {
  text: string;
  missing: string[];
}
