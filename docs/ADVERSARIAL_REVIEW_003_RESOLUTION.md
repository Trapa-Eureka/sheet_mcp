# Adversarial Review Report 003 — Resolution Record

- Action date: 2026-09-01
- Target report: `docs/ADVERSARIAL_REVIEW_003.md` (review baseline revision `63d23f9`)
- Actor: Claude Code agent (before human confirmation, performed only code/doc fixes)
- Principle: The report (`docs/ADVERSARIAL_REVIEW_003.md`) is an audit record and is not modified.
  The actual remediation details and verification results are recorded in this new document
  (per §8 tracking rules).

## 1. Overall Result

All of AR-011~018 were addressed in both code and docs. `npm run check` now shows **all 130 tests
passing** (up from 114 at the time the report was written — +16 from the claim/commit/release
rewrite plus null-clear and regression tests), and `npm run test:coverage` core line coverage is
**93.92%** (the 90%+ target is maintained). During the remediation, the agent independently
discovered and fixed **1 additional defect** not in the report (see §3 below).

AR-011 (duplicate sends) and AR-013 (send/record inconsistency), the release-blocking items, were
fundamentally resolved by redesigning the SendLog interface from `wasSent()+record()` to a
three-stage `claim()/commit()/release()` — this is a design change, not a workaround or
mitigation, so `docs/DESIGN.md` (§2, §3, §4) was updated first and the code was implemented to
match that document (CLAUDE.md guardrail 5).

**Still remaining**: as AR-016 pointed out, the manual smoke test using a real Google Sheet and
real email (the SPEC §5 success criterion) is still not performed, since this agent does not hold
credentials. `docs/TASKS.md` T10 was explicitly marked
`CODE DONE(2026-09-01) / MANUAL SMOKE PENDING` — a human must actually perform it for it to become
fully DONE.

## 2. Remediation by Finding

### AR-011 — Duplicate sends on same-batch/concurrent runs (severity: High, release-blocking) → **Resolved**

- **Root cause**: the previous pipeline had separate stages — "check wasSent() for all rows (stage
  4) → send+record for all rows (stage 6)" — so if a duplicate rowKey in the same batch, or
  concurrently running processes, shared the same "check" moment, both would pass through
  (TOCTOU).
- **Fix**: redesigned the `SendLog` interface as
  `claim(sheetId, tab, rowKey, templateHash, claimedAt): boolean`. Changed the pipeline so that
  each row's "reserve → send → commit/release" is **completed fully, one at a time, before moving
  to the next row** (`src/core/pipeline.ts` `attemptSend()`). `SqliteSendLog.claim()` is
  implemented as a single `INSERT` against a UNIQUE-constrained column, so atomicity is preserved
  across **different processes** looking at the same DB file thanks to SQLite's file-level locking
  (within the same process, InMemorySendLog is already atomic due to JS's single-threaded nature).
- **Files changed**: `src/core/types.ts`, `src/core/pipeline.ts`, `src/mocks/inMemorySendLog.ts`,
  `src/adapters/sqliteSendLog.ts`, `docs/DESIGN.md` §3/§4.
- **Verification**:
  - `tests/pipeline.test.ts` — "AR-011: even if the same rowKey appears twice in the same batch,
    the provider is called only once and only 1 entry remains in the SendLog" (reproduced with
    InMemorySendLog).
  - `tests/sqliteSendLog.test.ts` — "claim blocks each other even between separate SqliteSendLog
    instances looking at the same DB file" (simulated cross-process contention with 2 separate
    instances, verifying file-level atomicity).
  - `tests/inMemorySendLog.test.ts` — unit-verified claim success/failure and re-claim allowed
    after release.

### AR-013 — Success followed by a SendLog record failure misjudged as `failed` (severity: High) → **Resolved**

- **Fix**: added `"sent_log_failed"` to `SendStatus`. If `sendLog.commit()` fails after
  `provider.send()` succeeds (e.g. DB lock, disk full), **`release()` is not called**, and only
  this run's result is marked `sent_log_failed`. Not calling `release()` is the key point — it
  keeps the claim in the DB, preventing the accident where the next run claims the same rowKey
  again and resends. It's also immediately logged via `console.error` so operators don't miss it
  in the logs. It is excluded from the aggregate counts (`sent`/`failed`/`skipped`), forcing a
  direct look at `details[]`.
- **Files changed**: `src/core/types.ts` (SendStatus), `src/core/pipeline.ts`
  (attemptSend/toStatusUpdate), `src/toolSchemas.ts` (zod enum), `docs/DESIGN.md` §2/§3/§4.
- **Verification**: `tests/pipeline.test.ts` "AR-013: ..." — injected a `CommitFailingSendLog` mock
  that simulates only `commit()` failing, confirming: ① the provider is called (the send itself
  succeeds), ② the result status is `sent_log_failed` and is included in neither the `sent` nor
  `failed` count, ③ the claim is not released, so `wasSent()` is still true (blocking a resend).

### AR-012 — README's `.env` procedure is not actually loaded (severity: High) → **Resolved (+ fixed an additional self-discovered defect)**

- **Fix**: added the `dotenv` dependency. `.env` is now loaded at the very top of the `main()`
  entry points in `src/server.ts`/`scripts/smoke.ts`. Test paths that import only `createServer()`
  (including the T9 e2e) do not go through `main()`, so test determinism is unaffected.
- **Self-discovered additional defect**: dotenv (v17) prints an "injected env ..." banner to
  **stdout** by default. Since the MCP stdio transport uses stdout exclusively for JSON-RPC
  framing, running `npm run dev` with a `.env` present would have let this banner contaminate the
  first message, causing a regression where **the MCP client's JSON parsing breaks**. This was
  fixed with `loadDotenv({ quiet: true })` to suppress the banner, and it was manually verified
  that stdout is exactly 0 bytes with a `.env` present (see §4). This item was not in the original
  report (AR-011~018) — it was discovered directly during this remediation work.
- **Files changed**: `package.json` (dotenv dependency), `src/server.ts`, `scripts/smoke.ts`.
- **Verification**: see §4 "Manual verification" (an actual-process stdout byte check that is hard
  to confirm with automated tests).

### AR-014 — Status cell contradictions on retry/re-failure (severity: Medium) → **Partial policy adopted, documented**

- **Fix**: extended `StatusUpdate`'s `sentAt`/`messageId`/`error` to a three-way
  undefined/string/**null** state (null = explicitly cleared). Applied identically to both
  `InMemorySheetClient` and `GoogleSheetClient`.
  - **On success (`sent`)**: `error` is always cleared to `null` — so if a row that had previously
    failed succeeds on retry, the old `_error` no longer incorrectly remains next to the new
    success. `messageId` is also rewritten based on this send (or null if none).
  - **On failure (`failed`)**: the report pointed out that "the old `_sent_at`/`_message_id`
    remain, conflicting with `_send_status=failed`," but the report's own recommendation text —
    "clear `_error` on success, and **document** the policy on failure" — did not require the
    latter to be necessarily cleared. After review, it was decided to **preserve it
    intentionally** — the audit record that the row actually received an email in the past should
    not be erased by a new template's failed attempt (erasing it could increase the risk of
    duplicate sends by giving the false impression "this customer was never sent anything"). This
    policy is documented with the same rationale in three places: `docs/DESIGN.md` §2/§3,
    `src/core/types.ts`, and `src/core/pipeline.ts` (toStatusUpdate). **If a human disagrees with
    this judgment, it is left as a topic for re-discussion in the next review.**
  - `skipped_duplicate` retains its existing policy (touches nothing).
- **Files changed**: `src/core/types.ts`, `src/core/pipeline.ts`, `src/mocks/inMemorySheetClient.ts`,
  `src/adapters/googleSheetClient.ts`, `docs/DESIGN.md` §2/§3.
- **Verification**:
  - `tests/pipeline.test.ts` "AR-014: when a previously failed row succeeds on retry, the old
    _error is cleared".
  - `tests/pipeline.test.ts` "AR-014: when a previously successful row later fails (under a new
    template), the old _sent_at/_message_id are preserved" — locking in the above policy as a
    regression test.
  - `tests/inMemorySheetClient.test.ts`, `tests/googleSheetClient.test.ts` — each verifies at the
    adapter level that a null value actually clears the cell, unlike undefined.

### AR-015 — Unbounded `get_send_log` response (severity: Medium) → **Resolved**

- **Fix**: extended to `SendLog.list(sheetId, { limit? })`. Default of 200, max of 1000
  (`DEFAULT_SEND_LOG_LIST_LIMIT`/`MAX_SEND_LOG_LIST_LIMIT`, `src/core/types.ts`). SQLite returns
  the most recent first via `ORDER BY id DESC LIMIT ?`; InMemory returns the equivalent reversed.
  Added a `limit` input (upper bound validated by zod) to the MCP `get_send_log` tool, and when the
  returned count reaches the requested limit, it also returns `truncated: true` (an approximation,
  without an exact total count query) so the client can tell there may be more.
- **Files changed**: `src/core/types.ts`, `src/mocks/inMemorySendLog.ts`, `src/adapters/sqliteSendLog.ts`,
  `src/toolSchemas.ts`, `src/server.ts`, `docs/DESIGN.md` §3/§5.
- **Verification**: `tests/inMemorySendLog.test.ts`/`tests/sqliteSendLog.test.ts` — confirmed
  most-recent-first ordering and truncation when exceeding the limit.

### AR-016 — T10/v0.1 smoke completion criteria not executed (severity: Medium) → **Explicitly separated in docs**

- **Fix**: changed the `docs/TASKS.md` T10 status to `CODE DONE(2026-09-01) / MANUAL SMOKE
  PENDING`, separately describing what can be automatically verified versus what a human must
  actually perform. Added a `[PENDING]` marker and supporting link to the "real sheet + email
  end-to-end" item in the `docs/SPEC.md` §5 success criteria.
- **Files changed**: `docs/TASKS.md`, `docs/SPEC.md`.
- **Remaining work**: a human needs to run `npm run smoke` (dry-run) with real credentials, then
  `SEND_MODE=live SMOKE_CONFIRM_SEND=1 npm run smoke` (one real send), record the execution
  date/time, test sheet (anonymized), first-run messageId, and second-run skipped result in
  `docs/TASKS.md` T10, and raise the status to full `DONE`.

### AR-017 — Email format validation only checks for `@` (severity: Low) → **Resolved**

- **Fix**: replaced `!recipient.includes("@")` with `z.string().email()` (zod's built-in
  validation) — without an excessive full RFC 5322 implementation, it filters out clearly bad
  addresses like `a@`, `@example.com`, `a@@example.com`, and addresses containing whitespace.
- **Files changed**: `src/core/pipeline.ts`.
- **Verification**: `tests/pipeline.test.ts` "AR-017: ..." — confirmed all 4 representative bad
  addresses are treated as `failed` and the provider is not called. Also re-confirmed no false
  positives on valid addresses by re-running the existing "malformed email (no '@')" test and the
  1,000-row fixture test (which includes `.invalid` domains).

### AR-018 — SQLite handle not closed (severity: Low) → **Resolved**

- **Fix**: registered `process.on("exit", () => sendLog.close())` in `main()` in `src/server.ts` —
  cleans up the DB file no matter how the process ends (including via the parent's stdin closing).
  `scripts/smoke.ts` wraps its entire logic in `try/finally` so that `sendLog.close()` is always
  called no matter how the script ends (normal exit / early return / exception).
- **Files changed**: `src/server.ts`, `scripts/smoke.ts`.
- **Verification**: §4 manual verification — started the server with dummy credentials and closed
  stdin to confirm it exits cleanly, and confirmed the DB file is actually created/closed.

## 3. Additional Findings Not in the Report (Self-Discovered During This Remediation)

- **dotenv stdout contamination** — see AR-012. In terms of severity, this was on the level of
  AR-011/013 (release-blocking — every real user actually using `.env` would have had their MCP
  connection broken), but it was fixed immediately upon discovery in the same remediation session.

## 4. Verification Results

### Automated gate

```
npm run check
```

- TypeScript typecheck: pass
- ESLint: pass
- Prettier: pass
- Vitest: **13 test files, 130 tests passed** (up from 114 at the time of the original report —
  +16 from the claim/commit/release rewrite plus AR-011/013/014/017 regression tests)

### Coverage

```
npm run test:coverage
```

| | Stmts | Branch | Funcs | Lines |
|---|---|---|---|---|
| All files (src/core/\*\*) | 93.92% | 84.37% | 100% | 93.92% |

The target (90%+) is maintained. The drop in branch coverage from the report's figure (93.18%) is
because the number of claim/commit/release and sent_log_failed branches increased, and the entire
shortfall consists of pre-existing "internal error (bug report)" defensive guards
(`config.ts required()`, and the unreachable branches of `pipeline.ts`'s
finalizeStatus/toStatusUpdate) — these are intentionally left unverified since they are not
reached in normal flow.

### Manual verification (actual process behavior that's hard to confirm with automated tests)

1. **Fail-fast**: confirmed that `npm run dev` exits immediately with a clear error (not a crash)
   when secrets like `GOOGLE_SERVICE_ACCOUNT_JSON` are not set.
2. **Normal startup**: confirmed at the process level that `npm run dev` starts with dummy
   credentials, waits on stdio, and exits naturally when stdin is closed. Confirmed the
   SqliteSendLog DB file is actually created.
3. **dotenv stdout contamination fix confirmed**: started the server with an actual `.env` file
   present and confirmed stdout is exactly 0 bytes before any JSON-RPC message goes out (see §2
   AR-012).
4. **MCP tool round-trip**: called `createServer()` directly with `InMemoryTransport` + the MCP SDK
   `Client` to round-trip all 4 tools — confirmed zod output validation passes, the dual
   safeguards, and the `entries`/`truncated` response shape of `get_send_log` (separate from T9's
   stdio child-process e2e, this was a quick re-check right after this refactor; not included in
   the commit).

## 5. Not Addressed This Time

- **The v0.2 backlog** (Semaphore SMS, etc.) remains off-limits to start per the SPEC roadmap —
  outside the scope of this remediation.
- **AR-014's "preserve past sentAt/messageId on failed"** — as explained in §2 above, this is an
  intentionally adopted policy, and what the report called "appears to conflict" is not fully
  resolved (a past success trace and the current failed state can still coexist on the same row).
  Confirmation is needed on whether a human agrees with this trade-off.
- **Actual manual smoke test** (AR-016) — see §2 above; only a human can perform this.

## 6. Notes for the Next Session

- To raise `docs/TASKS.md` T10 to full `DONE`, a record of an actual smoke run is needed.
- The next adversarial review is recorded as `docs/ADVERSARIAL_REVIEW_004.md` (per report 003 §8
  tracking rules). It would be good to re-examine at that time whether the AR-014 policy adopted
  here still holds up, and whether the claim/commit/release design behaves as expected in actual
  operation (especially how often `sent_log_failed` occurs).
</content>
