# Adversarial Review Report 003 — Record of Re-remediation of Unresolved Items (GAPS)

- Remediation date: 2026-09-01
- Target document: `docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md` (re-verification results against baseline revision `fa8b5b6`)
- Performed by: Claude Code agent (prior to human confirmation; performed code/document changes only)
- Principle: `ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md` is an audit record and is not modified. The actual
  remediation details and verification results are recorded in this new document (per that document's §7 tracking rules).

## 1. Overall Result

All of GAP-001~008 and REG-001 have been addressed. The core change was redesigning SendLog as an
**ownership-token-based claim/commit/release** — even if the process dies without the claim being
confirmed (committed), that fact remains visible as `"claimed"` so an operator can discover it, and it
never automatically turns into either "sent" or "reusable."
`npm run check` now **passes all 150 tests** (130 at the time of the GAPS re-verification → +20), with
core line coverage at 93.24% (maintaining the 90%+ target).

| Item | Previous verdict | After this remediation |
| --- | --- | --- |
| GAP-001 | Partially resolved | Resolved — separated claim/sent states + token + expiration-based manual recovery |
| GAP-002 | Partially resolved | Resolved — SendLog no longer incorrectly shows claimed as sent; sum invariant restored via a separate `logFailed` aggregate |
| GAP-003 | Partially resolved | Resolved — isolated `release()` failures so they do not block the batch |
| GAP-004 | Partially resolved | Resolved — SMOKE_SHOW_VALUES is now evaluated after the dotenv load |
| GAP-005 | Policy retained | **Policy retained, re-confirmation requested** (see §3 below — an intentional trade-off) |
| GAP-006 | Partially resolved | Resolved — accurate hasMore via limit+1 queries + cursor pagination |
| GAP-007 | Incomplete | **Still incomplete** — only a human can do this (see §3 below) |
| GAP-008 | Largely resolved | Resolved — confirmed close() idempotency, added SIGINT/SIGTERM handling, added a repeated-creation/shutdown regression test |
| REG-001 | New regression | Resolved — eliminated the source of collisions via a double-hashing method |

## 2. Detailed Remediation by Item

### REG-001 — Template hash collision (Severity: High) → **Resolved**

- **Reproduction confirmed**: using the pre-fix code, I actually hashed `subject="A ", body="B"` and
  `subject="A", body=" B"` and directly reproduced that both collide to `a70bb07d2189` (matching the
  report's measured result).
- **Fix**: changed `computeTemplateHash` to "sha256 each of subject and body separately first → then
  concatenate those two 64-character digests and sha256 again." Since the digests are fixed-length,
  there is structurally no boundary ambiguity.
- **Changed files**: `src/core/pipeline.ts`.
- **Verification**: `tests/pipeline.test.ts` "REG-001: ..." — confirms the hashes of the two combinations
  above are now different. The existing "the hash differs if either subject or body alone differs" test
  also continues to pass.

### GAP-001 — Interrupted claims remain permanently recorded as `sent` (Severity: High, AR-011) → **Resolved**

- **Fix**: `SendLog.claim()` now returns a `ClaimResult { claimed, token }`, and the DB immediately
  records only a `"claimed"` state, not `"sent"`. `commit()`/`release()` operate only when the token
  matches the one issued by the claim (on mismatch, commit errors out and release is silently ignored).
  If the process dies right after claim (neither commit nor release is called), that row still shows
  as `sendStatus: "claimed"` in `list()` — it does not turn into `"sent"`.
- **Manual recovery**: added `forceReleaseStaleClaim(sheetId, tab, rowKey, templateHash, olderThanMs)`.
  It reclaims only claims where `committed=0` and `claimedAt` is older than `olderThanMs`, and it never
  touches a record already confirmed as `sent`, no matter how old. **There is no automatic expiration
  and no automatic reuse anywhere** — following the report's recommendation that "for expired claims,
  prefer manual confirmation over automatic re-confirmation" exactly, this function is designed to be
  called only after a human directly reviews it, and it is **not exposed as an MCP tool** (I judged it
  risky to let an autonomous agent decide on its own to make a claim that "may already have been sent"
  reusable).
- **Changed files**: `src/core/types.ts` (SendLog interface, `ClaimResult`, `SendLogEntryStatus`),
  `src/mocks/inMemorySendLog.ts`, `src/adapters/sqliteSendLog.ts` (added `claim_token`,
  `committed` columns to the schema), `src/core/pipeline.ts`, `docs/DESIGN.md` §2/§3/§4.
- **Verification**:
  - "GAP-001: if commit/release is never called after claim, as if the process died — list() shows
    sendStatus='claimed' (not turned into sent)" — on both InMemory/Sqlite.
  - `forceReleaseStaleClaim` describe block — a young claim is not reclaimed, an old claim is reclaimed
    and can be re-claimed, an already-committed record is never reclaimed no matter how old, and a
    non-existent key returns false — 4 tests × InMemory/Sqlite.
  - "commit is rejected when the token does not match", "release(with a wrong token) is silently
    ignored and does not delete the existing claim" — verifies that a zombie process cannot wrongly
    confirm/delete a reclaimed claim.

### GAP-002 — Commit-failure state is not preserved in SQLite (Severity: High, AR-013) → **Resolved**

- The claimed/sent state separation from GAP-001 resolves this issue as well: if commit() fails, the
  DB claim remains `committed=0` (claimed) and is **never incorrectly confirmed as `"sent"`**. Querying
  via `get_send_log` also honestly shows `sendStatus: "claimed"` — the report's finding that "a failure
  can appear as normal sent" no longer holds.
- **Sum invariant**: added `logFailed: number` to `PipelineResult`. `sent_log_failed` rows are no longer
  put into any of `sent`/`failed`/`skipped`; they are now counted separately as `logFailed`, so
  `sent+failed+skipped+logFailed === details.length` always holds (previously this equality was broken
  because `sent_log_failed` was in none of the counts).
- **Changed files**: `src/core/pipeline.ts` (PipelineResult, summarize), `src/toolSchemas.ts`,
  `docs/DESIGN.md` §4.
- **Verification**: added the following to the AR-013 test — `result.logFailed===1`, the sum invariant
  `sent+failed+skipped+logFailed===details.length`, and confirmation that the entry queried via
  `sendLog.list()` has `sendStatus` of `"claimed"` (not shown as normal sent).

### GAP-003 — A release failure can break row isolation and halt the batch (Severity: High) → **Resolved**

- **Fix**: wrapped all release calls in `attemptSend()` in a separate method called `safeRelease()`.
  Even if `release()` itself throws, it is **not propagated outward** — it is caught, and the fact is
  recorded in the row's `error` message and via `console.error`. The `for` loop in `run()` keeps going,
  so subsequent rows are processed normally.
- **Changed files**: `src/core/pipeline.ts` (`safeRelease`).
- **Verification**: `tests/pipeline.test.ts` "GAP-003: ..." — injects a `ReleaseFailingSendLog` mock
  (whose `release()` always throws), confirming that C-1, where the failure is injected, is processed
  as `failed` (with the error including "release also failed"), while the following C-2 reaches `sent`
  normally — direct evidence that the batch was not halted.

### GAP-004 — `SMOKE_SHOW_VALUES` from `.env` is not applied (Severity: Medium) → **Resolved**

- **Fix**: removed the module-top-level `SHOW_VALUES` constant, and instead read
  `process.env.SMOKE_SHOW_VALUES` inside `main()` **after** `loadDotenv()`, passing it as a parameter to
  `formatDetail(detail, showValues)`.
- **Changed files**: `scripts/smoke.ts`.
- **Verification**: there is no automated unit test (as before, `smoke.ts` is a human-only script that
  is not a test target, per the T3/T10 decision). Instead, I cleared all shell environment variables
  (`env -i`) and set only `SMOKE_SHEET_ID`/`SMOKE_SHOW_VALUES=1` in the `.env` file to run it, confirming
  that `.env`'s `SMOKE_SHEET_ID` was correctly recognized, skipping the "no SMOKE_SHEET_ID" branch and
  proceeding into the actual logic (attempting Google authentication) — direct evidence that the
  `loadDotenv()` → environment-variable-read order works correctly (the subsequent failure at the
  decryption stage due to fake credentials is expected behavior).

### GAP-005 — State contradiction in the sent→failed transition (Severity: Medium, AR-014) → **Policy retained, re-confirmation requested**

- This item was already documented as an "intentional policy" in the previous round
  (`ADVERSARIAL_REVIEW_003_RESOLUTION.md`), and this re-verification report also correctly identified it
  as "retained as policy" — this is not a new defect but a request to re-confirm a judgment I made
  previously.
- **Current policy (unchanged)**: when a row becomes `sent`, its past `_error` is cleared. When a row
  becomes `failed`, the past `_sent_at`/`_message_id` are **preserved** — the judgment being that the
  audit record that this row actually received an email at some point in the past should not be erased
  by a new template's failed attempt. Reason for not changing this judgment: separating "current attempt
  state" from "past success history" using only four columns would require either expanding to eight
  status columns or adding a separate lookup path, which is a bigger decision that would change the
  DESIGN §2 "four status columns" contract itself, and I judged that to be beyond the scope of this
  remediation.
- **Path to full resolution** (as the report presents, requiring a human decision): (a) split the status
  columns into "last attempt" and "last success," or (b) redefine the four columns as representing only
  "last attempt," with past success history queryable only via `get_send_log` (pinning down the current
  column meaning more clearly in SPEC/DESIGN). Either way, the sheet layout or the documented contract
  changes, so a human needs to decide the direction.
- **Changed files**: none (no code/document changes in this round — judgment re-confirmation only).

### GAP-006 — No pagination and no accurate `truncated` (Severity: Medium, AR-015) → **Resolved**

- **Fix**: changed `SendLog.list()` to query `limit+1` entries to accurately determine whether more
  exist (removing the previously approximate `entries.length >= effectiveLimit` method). Added `cursor`
  to `SendLogListOptions` and `hasMore`/`nextCursor` to `SendLogListResult`, implementing genuine cursor
  pagination — SQLite uses `id < cursor ORDER BY id DESC`, and InMemory uses equivalent logic. The
  `get_send_log` MCP tool also exposes the `cursor` input and `hasMore`/`nextCursor` output as-is.
- **Changed files**: `src/core/types.ts`, `src/mocks/inMemorySendLog.ts`, `src/adapters/sqliteSendLog.ts`,
  `src/toolSchemas.ts`, `src/server.ts`, `docs/DESIGN.md` §3/§5.
- **Verification**:
  - "hasMore is accurate at the 199/200/201-entry boundaries (not an approximation)" — directly confirmed
    at exactly the 3 boundary values on both InMemory/Sqlite (exactly the full-resolution criteria the
    report required).
  - "Two or more pages can be iterated via nextCursor without duplication or omission" — confirmed that
    iterating 5 entries with limit=2 across 3 pages and combining the results exactly matches the
    original (direct evidence of no duplication/omission).
  - "An invalid cursor value explicitly throws an error."

### GAP-007 — Actual manual smoke testing incomplete (Severity: Medium, AR-016) → **Still incomplete (human only)**

- This item cannot be resolved by code — it requires actual Google Sheet + Resend credentials, which
  this agent does not have. `docs/TASKS.md` T10 is already correctly marked as `CODE DONE(2026-09-01) /
  MANUAL SMOKE PENDING` (from the previous round's remediation), and this round did not change that
  status — the report's full-resolution criteria (steps 1-5: confirm dry-run → send 1 live email →
  confirm status/messageId → confirm skipped_duplicate on re-run → audit record) remain exactly the
  items that a human must actually perform.

### GAP-008 — Insufficient verification of the server's SQLite shutdown lifecycle (Severity: Low, AR-018) → **Resolved**

- **Fix**:
  1. Directly verified in code whether better-sqlite3's `close()` is actually idempotent (no error when
     called twice) — confirmed that it is, so multiple overlapping shutdown paths are safe even without
     a separate guard flag.
  2. Added explicit `SIGINT`/`SIGTERM` handlers to `src/server.ts` (calling `close()` +
     `process.exit(0)`), so that the signal path, which was previously unclear with only
     `process.on("exit", ...)`, is now handled reliably.
  3. Regarding "provide an explicit close on the server assembly result," kept the current structure in
     which `buildProductionDeps()` returns `sendLog` separately from `deps` so that the caller
     (`main()`) explicitly owns and manages the lifecycle — `createServer(deps)` intentionally does not
     own the lifecycle of an adapter it did not create itself (since it must be possible to inject mocks
     in e2e tests for verification). This design decision is documented in `docs/DESIGN.md`/code
     comments.
- **Changed files**: `src/server.ts`.
- **Verification**:
  - "close() is idempotent — no error when called twice (GAP-008)."
  - "Opening and closing the same file repeatedly does not accumulate resources" — after repeatedly
    creating→claiming→committing→closing SqliteSendLog 50 times, confirmed that reopening with a new
    instance leaves all 50 entries intact without corruption (approximate evidence of no fd
    exhaustion/file corruption — actual OS fd-count measurement was not done since it is
    platform-dependent).
  - Manual verification: re-confirmed (§4) that starting the server with dummy credentials and closing
    stdin results in a normal shutdown, and that the DB file is actually created.

## 3. Items Requiring Human Re-confirmation (Cannot Be Fully Auto-resolved)

- **GAP-005 (redefinition of status column meaning)**: a decision is needed on whether to agree with the
  trade-off described in §2 above, or to change the sheet layout/SPEC contract to separate "last
  attempt" from "last success."
- **GAP-007 (actual manual smoke testing)**: a human must perform this with real credentials.
- **claim expiration threshold**: `forceReleaseStaleClaim` is designed so the caller passes
  `olderThanMs` — "how old a claim must be to be considered safe" is an operational judgment (depending
  on Resend/Google API's actual timeout and retry policy), so a default value was not settled in this
  session. It must be decided when building the actual operational script.

## 4. Verification Results

### Automated gate

```
npm run check
```

- TypeScript typecheck: Passed
- ESLint: Passed
- Prettier: Passed
- Vitest: 13 test files, **150 tests passed** (130 at the time of the GAPS re-verification → +20)

### Coverage

```
npm run test:coverage
```

| | Stmts | Branch | Funcs | Lines |
|---|---|---|---|---|
| All files (src/core/\*\*) | 93.24% | 82.52% | 100% | 93.24% |

Maintains the target (90%+). The drop in branch coverage is because, in addition to the increased number
of branches in claim/commit/release/forceReleaseStaleClaim, the shortfall is still solely from the
existing "internal error (bug report)" defensive guards.

### Manual verification

1. Fail-fast: `npm run dev` exits immediately with a clear error when secrets are not configured.
2. Normal startup: `npm run dev` starts with dummy credentials, shuts down naturally when stdin ends,
   and the DB file is confirmed created.
3. Re-confirmed stdout purity: re-confirmed that stdout is 0 bytes with an actual `.env` present
   (re-checking for regressions during the REG-001/claim redesign process).
4. GAP-004: confirmed that `SMOKE_SHEET_ID`/`SMOKE_SHOW_VALUES` are applied using only the `.env` file
   with all shell environment variables cleared (see §2 GAP-004).

## 5. Tracking Rules

- This document does not overwrite `ADVERSARIAL_REVIEW_003_RESOLUTION.md` or
  `ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md`; it preserves the results of a subsequent re-verification.
- The next adversarial review will be recorded as `docs/ADVERSARIAL_REVIEW_004.md`. It would be good to
  confirm GAP-005 (status column policy) and the claim expiration threshold decision at that time in
  particular.
