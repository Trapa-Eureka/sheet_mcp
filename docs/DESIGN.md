# DESIGN — sheet_mcp v0.1

This document is the source of truth for the implementation. If the code differs from it, fix the code to match this document; if a design change is needed, update this document first.

## 1. Architecture

```
Claude Code / Claude Desktop
        │  (MCP stdio)
        ▼
  src/server.ts ──── responsible only for registering the 4 MCP tools
        │
        ▼
  core/pipeline.ts (SendPipeline)
   │        │           │            │
   ▼        ▼           ▼            ▼
SheetClient TemplateEngine NotificationProvider SendLog
   │                        │                    │
   ├ adapters/googleSheetClient (googleapis)     ├ adapters/sqliteSendLog
   ├ mocks/inMemorySheetClient  ├ adapters/resendProvider
                                ├ adapters/smtpProvider (optional)
                                ├ adapters/semaphoreSmsProvider (v0.2 stub)
                                └ mocks/mockNotificationProvider
```

Principle: `core/` knows only interfaces and nothing about external IO. Swapping an adapter (email → SMS) must be possible without changing pipeline code.

## 2. Sheet Conventions

A single spreadsheet has a **data tab** and a **`notify_config` tab**.

### notify_config tab (column A = key, column B = value)

| Key                | Required  | Example                                                          | Description                                                            |
| ------------------ | --------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `data_tab`         | ✓         | `customers`                                                      | Data tab name                                                          |
| `id_column`        | ✓         | `customer_id`                                                    | Row identifier column (idempotency key)                                |
| `recipient_column` | ✓         | `email`                                                          | Recipient address column                                               |
| `channel`          | ✓         | `email`                                                          | v0.1 allows only `email`; `sms` raises an explicit not-supported error |
| `subject_template` | ✓ (email) | `[{{shop}}] Payment Notice`                                      | Subject template                                                       |
| `body_template`    | ✓         | `Dear {{name}}, the payment due date for {{amount}} is {{due}}.` | Body template                                                          |
| `filter_column`    | –         | `status`                                                         | Filter column for send targets                                         |
| `filter_value`     | –         | `unpaid`                                                         | Only rows matching this value are sent                                 |

### Data tab

- Row 1 is the header. Header names are the template variable names.
- If the pipeline doesn't find them, it **appends 4 status columns to the end of the header** and
  thereafter updates only those columns:
  `_send_status` (`sent`/`failed`/`skipped_duplicate`/`sent_log_failed`), `_sent_at` (ISO 8601),
  `_message_id`, `_error`
  - `sent_log_failed`: a state where the actual send (provider) succeeded, but recording that fact
    in SendLog failed. Since the fact that "the send happened" is itself settled, leaving it as
    `failed` (retryable) would cause a duplicate-send accident, so it is kept as a separate state
    (docs/ADVERSARIAL_REVIEW_003.md AR-013). A human must manually check SendLog and this row.
- User data columns are never written to.
- Missing-value handling policy for the status columns across the 3 outcomes (AR-014): when a row
  becomes `sent`, the previous `_error` is cleared. When it becomes `failed`, the previous
  `_sent_at`/`_message_id` are **preserved** (the audit record that this row was actually sent
  before is not erased by a failed attempt with a new template). `skipped_duplicate` touches
  nothing.
- **Policy decision (STATUS-GAP-004, follow-up to GAP-005)**: because of the preservation policy
  above, a single row can end up with `_send_status=failed` alongside the `_message_id`/`_sent_at`
  from a past success at the same time. Judging "whether this row is currently in a success state"
  from the 4 status columns alone can be misleading, so the following is fixed as the settled
  contract (of the three options above, "keep the current mixed policy + clarify the contract" was
  chosen):
  - `_send_status` **always represents only the result of the most recent run (the last
    attempt)**. It should be interpreted as "currently in a sent state" only when it is
    `sent`/`sent_log_failed`; even if `_message_id`/`_sent_at` are populated while it is
    `failed`/`skipped_duplicate`, **that is an audit record of a past attempt, not a sign that
    this run succeeded**.
  - When building automation (another script, a human's report) that reads only the sheet,
    success/failure must be judged solely from `_send_status`. The mere fact that
    `_message_id`/`_sent_at` hold a value must not be used to infer "the send succeeded".
  - When you need to know "has this row/template combination actually been sent before," query
    `SendLog.wasSent()`/`list()` (the get_send_log MCP tool), not the sheet — SendLog is the
    source of truth, and the sheet's status columns are only a snapshot for humans to view.
  - The proposal (option B) to split the sheet schema (4 columns) into two sets — "last attempt"
    and "last success" — is not adopted; since it would impose a migration burden on existing
    sheet users, it is deferred for v0.1.

## 3. Core Interfaces (TS Signatures)

```ts
// core/types.ts
export interface SheetRow {
  rowIndex: number;
  values: Record<string, string>;
}

export type SendStatus = "sent" | "failed" | "skipped_duplicate" | "sent_log_failed";

// Represents, per row, the 4 status columns (§2) that writeStatus reflects onto the sheet.
// sentAt/messageId/error are 3-state values (AR-014):
// - undefined (field omitted) = leave that column untouched.
// - string = overwrite with that value.
// - null = explicitly clear it (to an empty string).
export interface StatusUpdate {
  rowIndex: number;
  sendStatus: SendStatus;
  sentAt?: string | null;
  messageId?: string | null;
  error?: string | null;
}

// SendLog stores only these two states. failed/skipped_duplicate/sent_log_failed are recorded
// only on the sheet as the result of that run and are not kept in SendLog — this is why it is
// kept separate from the sheet's SendStatus
// (docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md GAP-001/002).
export type SendLogEntryStatus = "claimed" | "sent";

export interface SheetClient {
  readConfig(sheetId: string): Promise<Record<string, string>>;
  readRows(sheetId: string, tab: string): Promise<SheetRow[]>;
  ensureStatusColumns(sheetId: string, tab: string): Promise<void>;
  writeStatus(sheetId: string, tab: string, updates: StatusUpdate[]): Promise<void>;
}

export interface OutboundMessage {
  rowKey: string;
  to: string;
  subject?: string;
  body: string;
  channel: "email" | "sms";
}

export interface SendResult {
  rowKey: string;
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface NotificationProvider {
  readonly channel: "email" | "sms";
  send(msg: OutboundMessage): Promise<SendResult>;
}

// Corresponds 1:1 to SqliteSendLog's unique key (§6: sheet_id, tab, row_key, template_hash).
export interface SendLogEntry {
  sheetId: string;
  tab: string;
  rowKey: string;
  templateHash: string;
  sendStatus: SendLogEntryStatus; // only "claimed" | "sent"
  sentAt: string; // if claimed, the time it was claimed; if sent, the time it was finalized (committed)
  messageId?: string;
}

export interface SendLogListOptions {
  limit?: number; // 200 if omitted, max 1000 (AR-015)
  cursor?: string; // the nextCursor from a previous list() result — the next (older) page (GAP-006)
}

// hasMore/nextCursor are exact values computed by fetching limit+1 entries — not an approximation
// that "guesses there are more if entries.length===limit" (GAP-006, the previous approach, which
// was inaccurate at boundary values).
export interface SendLogListResult {
  entries: SendLogEntry[];
  hasMore: boolean;
  nextCursor?: string; // exists only when hasMore===true
}

// The result of claim(). token exists only when claimed===true, and must be passed through as-is
// to commit()/release() — when a human reclaims an expired claim via forceReleaseStaleClaim() and
// the same key is claimed again, a new token is issued, so if the original attempt (e.g. a zombie
// process) wakes up late and calls commit/release with the old token, it cannot touch the new
// claim (GAP-001).
export interface ClaimResult {
  claimed: boolean;
  token?: string;
}

// The 3-step claim/commit/release + ownership token + expiration-based manual recovery — a
// response to AR-011 (duplicate sends from the same batch / concurrent runs), AR-013 (local
// record failure after a successful send), and GAP-001 (a stalled claim being permanently
// abandoned).
// The old record() had a batch structure of "first check wasSent() for everything → then send
// everything," so if the same rowKey appeared twice in one batch, or another process ran
// concurrently, both places could see wasSent=false and actually cause a duplicate send (TOCTOU).
// claim() closes this gap by combining "check" and "reserve" into a single atomic operation.
// SqliteSendLog implements claim() as an INSERT into a column with a UNIQUE constraint, so
// atomicity holds even when multiple processes look at the same DB file.
//
// If the process dies right after a claim (before commit/release), that claim remains
// permanently in the "claimed" state — it does not automatically become "sent," nor does it
// automatically become reusable (because it's unknown whether it was actually sent). Since
// list() shows it as-is with sendStatus="claimed", an operator can discover it, and if it is
// judged old enough, it is reclaimed **only explicitly** via forceReleaseStaleClaim() — there is
// no automatic expiration or automatic reuse. This recovery function is not exposed as an MCP
// tool (it is not safe to let an autonomous agent make a state that "may have been sent" reusable
// on its own — this presumes a human reviews it directly and calls it via a script/REPL).
export interface SendLog {
  // If claimed=true, this caller is the sole one permitted to attempt the send (reservation
  // succeeded) — the returned token must be passed to commit() or release(). If claimed=false,
  // it has already been claimed (whether claimed or sent) → do not send, treat as
  // skipped_duplicate.
  claim(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    claimedAt: string,
  ): ClaimResult;
  // Finalizes the reservation into the final send record only when the token matches the one
  // issued by claim() **and it has not yet been committed** (claimed→sent must happen only
  // once). Errors on either a token mismatch or an already-committed record.
  commit(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    token: string,
    sentAt: string,
    messageId: string | undefined,
  ): void;
  // Releases the reservation (making it retryable) only when the token matches the one issued by
  // claim() **and it has not yet been committed**. If the token doesn't match, or the record is
  // already committed (finalized), it is silently ignored — a finalized record can never be
  // erased by release() either (found and hardened during re-verification: without this
  // committed check, if release() were mistakenly called after a successful commit, the
  // just-finalized send record would be wiped out entirely, making wasSent() return false and
  // creating the risk of a duplicate send).
  release(sheetId: string, tab: string, rowKey: string, templateHash: string, token: string): void;
  // Forcibly reclaims only a claim that has been claimed for at least olderThanMs and has not
  // yet been committed (no token needed — a human calls this after reviewing it directly). If
  // the condition isn't met, it does nothing and returns false.
  forceReleaseStaleClaim(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    olderThanMs: number,
  ): boolean;
  // Read-only lookup (for dry-run preview only — it does not change state. Use claim() for
  // duplicate prevention in the send flow).
  wasSent(sheetId: string, tab: string, rowKey: string, templateHash: string): boolean;
  list(sheetId: string, options?: SendLogListOptions): SendLogListResult;
}

export interface Clock {
  now(): Date;
} // for test determinism
```

```ts
// core/template.ts — pure function
export interface RenderResult { text: string; missing: string[] }
renderTemplate(template: string, values: Record<string, string>): RenderResult
// Substitutes {{key}}. When a value is missing, the key is returned in RenderResult.missing
// (not thrown — handled as a per-row failure)
```

## 4. Send Pipeline (core/pipeline.ts)

`run(sheetId, opts: { dryRun: boolean })` order:

1. `readConfig` → zod parsing (on failure, an error stating which key is wrong and why)
2. `readRows` → apply `filter_column`/`filter_value` → if the matched rows exceed
   `MAX_PIPELINE_ROWS` (1000):
   - **dry-run**: truncate to the first 1000 rows for the preview and report via
     `totalMatched`/`truncated` that there are actually more (same policy as `read_rows`).
   - **live**: to avoid a partial-send accident where only some rows are sent silently, **it does
     not start sending at all** and aborts with a clear error (including guidance to narrow the
     filter or split into batches). No side effect whatsoever — provider.send()/claim(), etc. —
     occurs (`docs/ADVERSARIAL_REVIEW_004.md` AR-022 — if an entire large/accidentally-widened
     sheet matched with no filter, it could lead not only to a memory spike but also to a
     mass-misfire of sends).
3. Per-row rendering: rows with a missing recipient, malformed email, or missing template variable
   are marked as `failed` candidates and processing continues
   - `templateHash` = sha256 the subject, sha256 the body, concatenate the two digests, then
     sha256 that again and take the first 12 characters. The previous implementation, which
     inserted a separator character between subject and body, could let two different
     (subject, body) combinations collide on the same hash if a character matching the separator
     sat at the boundary (`REG-001`, docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md — reproduced
     and confirmed empirically). An sha256 digest is always a fixed 64 characters, so the
     concatenation boundary never shifts based on content, and this problem does not occur.
     Changing the template also changes the hash, which permits a resend (intended behavior)
4. **If dryRun**: mark duplicates using only `sendLog.wasSent(rowKey, templateHash)` (read-only)
   and return the result. No provider/sendLog/sheet writes at all.
5. **If not dryRun**: for each row, **fully complete the following one step at a time before
   moving to the next row** (even if the same rowKey appears twice in the same batch, the second
   claim fails immediately, preventing a duplicate send — AR-011):
   1. `sendLog.claim(rowKey, templateHash)` → if `claimed=false`, `skipped_duplicate` (provider is
      not called)
   2. if `claimed=true`, `provider.send()` — **individual try/catch**; a single row's failure does
      not abort the batch
   3. on success, `sendLog.commit(token, ...)` → `sent`. If commit itself fails (the send
      succeeded but the local record failed), it is marked `sent_log_failed` without calling
      `release()` (prevents a duplicate-send accident, AR-013)
   4. on failure (provider failure/exception), `sendLog.release(token, ...)` → `failed` (retryable
      on the next run). **Even if release() itself fails, it is never thrown outward** — the
      failure is recorded only in the error message and stderr, and processing of the remaining
      rows continues (`GAP-003` — previously, a release failure would abort the entire batch).
      This row's claim may not be automatically released for retry, so a human's
      `forceReleaseStaleClaim()` check may be needed.
6. `ensureStatusColumns` + `writeStatus` batch write-back (§2 missing-value policy, AR-014)
7. Return aggregates: `{ sent, failed, skipped, logFailed, totalMatched, truncated, details[] }`.
   `sent_log_failed` is not counted under either `sent` or `failed`, and is tallied separately as
   `logFailed` — `sent+failed+skipped+logFailed` always equals `details.length` (aggregation
   invariant, `GAP-002`). `totalMatched`/`truncated` indicate whether the `MAX_PIPELINE_ROWS`
   truncation from step 2 above occurred (`AR-022`).

## 5. MCP Tools (src/server.ts)

`@modelcontextprotocol/sdk`, stdio transport. Input schemas use zod.

| Tool                 | Input                                          | Behavior                                                                                                                                                                                                                       |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `read_rows`          | `sheetId`                                      | Returns target rows with config applied (filter applied, preview up to 200 rows)                                                                                                                                               |
| `preview_messages`   | `sheetId`                                      | Runs the dryRun pipeline — returns the list of rendered messages and missing/duplicate warnings. **No sending**                                                                                                                |
| `send_notifications` | `sheetId`, `confirm: boolean`                  | Sends for real only when `confirm=true` **and** `SEND_MODE=live`. Otherwise returns the dry-run result + guidance                                                                                                              |
| `get_send_log`       | `sheetId`, `limit?: number`, `cursor?: string` | Returns send history in most-recent-first order (default 200 entries, max 1000). If `hasMore=true`, pass the response's `nextCursor` as the `cursor` for the next call to continue the query (exact hasMore — AR-015, GAP-006) |

Why the safeguard is dual: to prevent an accident where an agent mistakenly sends for real during
autonomous execution, both a tool parameter (conversation level) and an environment variable
(process level) are required.

## 6. Adapter Notes

- **GoogleSheetClient**: `googleapis` + service account. The sheet is shared with the service
  account's email (v0.1). Reads use `values.get`; status writes use `values.batchUpdate`.
- **ResendEmailProvider**: a single REST call. `RESEND_API_KEY`, `MAIL_FROM` environment
  variables. The response's id is stored as `messageId`.
- **SmtpProvider (Nodemailer)**: an alternative adapter for environments not using Resend.
  Implementation in v0.1 is optional.
- **SemaphoreSmsProvider**: in v0.1, only a stub whose constructor throws a "register a Sender ID,
  then it will be enabled in v0.2" error.
- **SqliteSendLog**: `better-sqlite3`, file path `SEND_LOG_PATH` (default `./data/sendlog.db`).
  The unique key is `(sheet_id, tab, row_key, template_hash)` — this unique constraint is
  precisely claim()'s atomicity boundary (§3). It has `claim_token` (ownership token) and
  `committed` (0/1, distinguishing claimed/sent) columns. `close()` is idempotent (guaranteed by
  better-sqlite3 itself, manually verified), so it is safe to call it from multiple, overlapping
  exit paths (normal/SIGINT/SIGTERM/`exit`) (AR-018/GAP-008).
  - **Upgrading an existing DB (STATUS-GAP-001)**: even if you open a `sendlog.db` as-is that was
    created with the T6-era, `record()`-only v1 schema (`send_status`/`error` columns, no
    `claim_token`/`committed`), the constructor automatically migrates it to the v2 (claim/commit)
    schema. Only rows whose past `send_status` was `'sent'` are moved over as finalized records
    with `committed=1` (so that past sends continue to block duplicate sends after migration);
    `failed`/`skipped_duplicate` rows are not moved (v1 had a bug where the UNIQUE constraint
    permanently blocked retries after a single failure, and that bug must not be carried into the
    new schema). The original v1 table is not deleted — it is left in place, only renamed to
    `send_log_v1_backup_<timestamp>_<random>`. Since the whole thing is one transaction, if it
    fails partway through (e.g. a conflict with a `send_log_new` temp table left behind by a
    previously interrupted migration), the original `send_log` is rolled back and preserved as-is,
    and the constructor fails with an agent-friendly error explaining the cause and the remedy
    (fail-fast). Since the conversion happens automatically with no data loss, the old guidance to
    "delete the DB file and recreate it" is no longer necessary or recommended.
  - **Stale claim recovery (STATUS-GAP-002/003)**: `forceReleaseStaleClaim(olderThanMs)` now
    throws immediately, before touching any claim, if `olderThanMs` is not a non-negative integer
    (negative/NaN/Infinity/fractional) — this prevents an accident where passing a negative value
    by mistake pushes the cutoff into the future and misjudges even a claim just created as
    "stale," deleting it (shared with InMemorySendLog via the common validation function
    `assertValidStaleClaimThreshold()`). To let a human use this internal API safely by hand, an
    operational CLI, `src/cli/recoverStaleClaim.ts`, is provided — run it as
    `npm run recover:stale-claim --` if developing from a cloned repo, or as
    `npx sheet-mcp-recover` if installed via `npx sheet-mcp` (the second published `bin`,
    `docs/ADVERSARIAL_REVIEW_004.md` AR-019 — previously it lived under `scripts/`, so it wasn't
    included in the npm package at all, and even though the README pointed to it as the official
    procedure, someone who installed via `npx` had no way to run it). By default, without
    `--confirm`, it opens the DB **read-only** and only queries; an `--older-than-ms` under 5
    minutes is rejected without `--i-understand-the-risk`; and every query/recovery run is logged
    to `data/recovery-audit.log` (JSON Lines, relocatable via `RECOVERY_AUDIT_LOG_PATH`). It is
    still not exposed as an MCP tool (see the SendLog interface comment in §3 — the principle
    that an autonomous agent must not be able to reclaim a claim that "may have been sent" on its
    own still stands).

`npm run dev`/`npm run smoke` load `.env` via `dotenv` at startup (it does not overwrite process
environment variables that are already set). Test paths that import only `createServer()` never
load it — so as not to affect test determinism (AR-012).

## 7. Environment Variables (committed as .env.example)

```
SEND_MODE=dry_run              # dry_run | live
GOOGLE_SERVICE_ACCOUNT_JSON=   # path to the service account key JSON
RESEND_API_KEY=
MAIL_FROM=notify@example.com
SEND_LOG_PATH=./data/sendlog.db
SMOKE_SHEET_ID=                # target Google Sheet ID for npm run smoke (human-only manual smoke test)
SMOKE_SHOW_VALUES=             # if 1, smoke prints the actual values of the first row (default is column names only, to prevent logging sensitive info)
SMOKE_CONFIRM_SEND=            # if 1, smoke consents to a real send (must be combined with SEND_MODE=live to actually send)
```

## 8. Connecting Claude Code

There are two installation paths — someone directly developing/contributing to this repo uses A,
and someone who just wants to use the already-built server (a teammate, an SME user) uses B.

### A. Cloning the repo (for development/contribution)

Register it at project scope so `.mcp.json` is committed to the repo (shared with the
team/your future self).

```bash
claude mcp add sheet-mcp --scope project -- npx tsx src/server.ts
```

The resulting `.mcp.json` looks like:

```json
{
  "mcpServers": {
    "sheet-mcp": { "type": "stdio", "command": "npx", "args": ["tsx", "src/server.ts"] }
  }
}
```

### B. npm package (`npx sheet-mcp`) — using it without cloning

**Recommended approach: pass environment variables directly via `claude mcp add`'s `-e`.** Don't
prepare a separate `.env` file.

```bash
claude mcp add sheet-mcp --scope local \
  -e GOOGLE_SERVICE_ACCOUNT_JSON=/absolute/path/service-account.json \
  -e RESEND_API_KEY=re_xxxxx \
  -e MAIL_FROM=notify@updates.yourdomain.com \
  -- npx -y sheet-mcp
```

- **Why `-e` instead of a `.env` file**: `npx -y sheet-mcp` inherits the cwd of Claude Code (the
  parent process) as-is, whatever directory it happens to be running from — unlike path A, which
  uses a cloned repo, there is no fixed location where you can say "just put a `.env` here."
  Values passed via `-e` are already present in the child process's `process.env` when it starts,
  and `src/server.ts`'s `dotenv.config()` **does not overwrite environment variables that are
  already set** (dotenv's default behavior), so they are used as-is regardless of whether a
  `.env` file exists.
- **Always pass `GOOGLE_SERVICE_ACCOUNT_JSON` as an absolute path.** This value is the **file
  path** to the service account key JSON (not its contents), and for the same reason as above, a
  relative path makes it unpredictable which directory it would actually be resolved against.
- **`SEND_LOG_PATH`'s default is also a relative path (`./data/sendlog.db`).** If not specified,
  the DB file is likewise created in an unpredictable location — specifying it explicitly with
  `-e SEND_LOG_PATH=/absolute/path/sendlog.db` is recommended.
- **Use `--scope local`** (the default). Registering with `--scope project` stores the values
  passed via `-e` as-is in the `.mcp.json` that gets committed to the repo, exposing secrets —
  `local`/`user` scope is stored only in that person's local settings and is not committed to
  git.
- If the repo is cloned and the run directory is fixed as in A, the existing `.env` file approach
  still works too (§7) — however, for path B (npx), the `-e` approach above is the primary
  recommendation.

> **`npm publish` has not been run yet** (`docs/TASKS.md` T11~T13; `npm publish` itself requires
> separate approval — exposure to the public registry is hard to reverse, so it has been prepared
> but execution is held off). Until then, `npx sheet-mcp`/`npx -y sheet-mcp` **will not** work,
> since no package with this name exists in the registry. Right now, only method A (cloning the
> repo) above can actually be used. Delete this paragraph after publishing.

Verify the connection with `/mcp` inside Claude Code. Do not put secrets in plaintext into the
committed `.mcp.json` (project scope) — A supplies them via the shell environment/.env, B via
`-e` + `local`/`user` scope as above.

## 9. Directory Structure (target)

```
sheet_mcp/
  CLAUDE.md  README.md  .mcp.json  .env.example
  docs/  fixtures/sheets/  scripts/smoke.ts
  src/{core,adapters,mocks}/  src/server.ts
  tests/
```
