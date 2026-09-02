# Adversarial Review Report 003 — Re-verification of Unresolved Items

- Re-verification date: 2026-09-01
- Target report: `docs/ADVERSARIAL_REVIEW_003.md`
- Target resolution record: `docs/ADVERSARIAL_REVIEW_003_RESOLUTION.md`
- Baseline revision: `fa8b5b6` (`AR-011~018: apply Adversarial Review Report 003`)
- Review principle: do not judge an item resolved based solely on the resolution record's claims or passing tests — conservatively re-verify against the original failure path and the operational outage/recovery path
- Change principle: do not modify product code; record only the unresolved items separately

## 1. Conclusion

The claim in `ADVERSARIAL_REVIEW_003_RESOLUTION.md` that "AR-011~018 all items addressed" is accurate as a statement about whether code was changed, but is inaccurate if interpreted as "all items fully resolved."

Conservative re-verification results:

| Item | Re-verification verdict | Summary |
| --- | --- | --- |
| AR-011 | Partially resolved | Concurrent claims are atomic, but there is no expiration/recovery for interrupted claims, so unsent rows can be permanently blocked |
| AR-012 | Partially resolved | dotenv is loaded, but smoke's `SMOKE_SHOW_VALUES` is evaluated before loading |
| AR-013 | Partially resolved | The API result is `sent_log_failed`, but the claim continues to be exposed as `sent` in SQLite |
| AR-014 | Partially resolved | Leftover errors in the failed→sent transition are cleaned up, but the contradictory state of sent→failed is intentionally retained as policy |
| AR-015 | Partially resolved | A response cap now exists, but there is no cursor and `truncated` is inaccurate |
| AR-016 | Incomplete | Actual manual smoke testing with Google Sheet+Resend has not been performed |
| AR-017 | Fully resolved | Clearly malformed emails are blocked before sending, and a regression test exists |
| AR-018 | Largely resolved | smoke cleanup is adequate, but the server shutdown lifecycle and repeated-creation verification are insufficient |

Additionally, during the fix process it was confirmed that the template hash delimiter changed from NUL to a space, which is a new regression that can cause different templates to produce the same hash.

## 2. Details of Unresolved and Partially Resolved Items

### GAP-001 — Interrupted claims remain permanently recorded as `sent`

- Linked item: AR-011
- Severity: High
- Location:
  - `src/adapters/sqliteSendLog.ts:77-98`
  - `src/core/pipeline.ts:253-307`
  - `src/core/types.ts:99-131`
- Symptom:
  - `SqliteSendLog.claim()` inserts a DB row before sending and immediately records `send_status='sent'`.
  - If the process is force-killed after a successful claim but before or during the Provider call, neither `commit()` nor `release()` runs.
  - That row becomes `wasSent()=true` regardless of whether it was actually sent, and subsequent runs permanently treat it as `skipped_duplicate`.
  - The claim has no expiration timestamp, no separate `claimed` state, no ownership token, and no recovery command.
- Impact:
  - A customer who was never actually sent a message can be treated as having been sent one.
  - Operators will also see this as a normal `sent` in `get_send_log`, making the omission hard to discover.
  - AR-011's duplicate-send race has been mitigated, but in its place a permanent send-omission risk has been introduced.
- Required action:
  1. Separate the DB state into `claimed` and `sent`.
  2. Add a `claim_token`, `claimed_at`, and an expiration policy to the claim.
  3. For expired claims, prefer manual confirmation or an explicit recovery procedure over automatic re-confirmation, because the Provider may have already processed it.
  4. On genuine failure, release only when the token matches; on genuine success, commit only when the token matches.
- Full-resolution criteria:
  - A test exists that simulates a process interruption after claim.
  - An unconfirmed claim is not shown as `sent` when queried.
  - The expiration/recovery/manual-confirmation policy is specified in `DESIGN.md`.

### GAP-002 — Commit-failure state is not preserved as `sent_log_failed` in SQLite

- Linked item: AR-013
- Severity: High
- Location:
  - `src/core/pipeline.ts:270-296`
  - `src/adapters/sqliteSendLog.ts:87-90`, `100-120`
- Symptom:
  - If `commit()` fails after a successful Provider call, `sent_log_failed` is shown in this run's pipeline response and in the sheet.
  - However, the DB claim has been `send_status='sent'` since the moment it was created, and there is no separate storage path that changes it to `sent_log_failed` when the commit fails.
  - Therefore, if `get_send_log` is queried after the process ends, the failure can appear as a normal `sent`.
  - If the sheet write-back also fails, the fact of `sent_log_failed` is left with no structural record other than stderr.
- Impact:
  - In the procedure the resolution record claims — "a human checks the SendLog and the sheet" — SendLog provides incorrect information.
  - Incident investigation and manual-recovery decisions become harder.
- Required action:
  - Separate claim state from final state, and provide a separate best-effort path or an append-only incident log that can durably record commit failures.
  - At minimum, do not return an unconfirmed claim as normal `sent`.
  - The current response, which does not put `sent_log_failed` into any of the `sent`/`failed`/`skipped` aggregates, breaks the sum invariant, so add a separate `uncertain` or `logFailed` aggregate.
- Full-resolution criteria:
  - In the actual SQLite implementation, the failure state can still be distinguished after a restart following a commit failure.
  - `get_send_log` does not return that row as normal `sent`.
  - The relationship between `details.length` and the aggregate sums is documented and tested.

### GAP-003 — A release failure can break row isolation and halt the entire batch

- Linked item: AR-011, AR-013
- Severity: High
- Location: `src/core/pipeline.ts:297-306`
- Symptom:
  - When the Provider returns `ok=false`, `release()` is called and then the row is changed to failed.
  - If this `release()` throws due to a DB lock, IO error, etc., the outer catch calls `release()` again.
  - If the second release also throws, the exception propagates out of `attemptSend()`, halting processing of subsequent rows.
  - Even on the path where the Provider itself throws, a release failure inside the catch propagates the same way.
- Impact:
  - The core pipeline contract that "one row's failure does not halt the rest of the batch" is not upheld when there is a SendLog failure.
  - A failed claim can also remain and permanently block the next run.
- Required action:
  - Model Provider errors and release errors as separate states.
  - Do not call release redundantly, and isolate release failures so they do not halt processing of other rows.
  - Also leave release failures as a durable incident state that accounts for resend safety.
- Full-resolution criteria:
  - When a `release()` failure is injected, subsequent rows continue to be processed.
  - The number of Provider calls and the final detail state are clear.
  - The follow-up-run policy for the same row is pinned down by a test.

### GAP-004 — `SMOKE_SHOW_VALUES` from `.env` is not applied

- Linked item: AR-012
- Severity: Medium
- Location: `scripts/smoke.ts:24`, `43-49`
- Symptom:
  - The `SHOW_VALUES` constant reads `process.env.SMOKE_SHOW_VALUES` at module load time.
  - dotenv is called later, inside `main()`.
  - Therefore, if `SMOKE_SHOW_VALUES=1` is set only in `.env` and not exported directly from the shell, actual value display is not enabled.
- Impact:
  - The README/.env contract remains inconsistent for some environment variables.
  - Since this does not lean toward unintentionally printing sensitive information, it is fail-closed from a safety standpoint, but the diagnostic option does not behave as documented.
- Required action:
  - Compute `SHOW_VALUES` after the dotenv load, or pass it explicitly to `formatDetail()`.
  - Verify that `SMOKE_SHOW_VALUES` is applied using a child-process test that relies only on `.env`.
- Full-resolution criteria:
  - `SMOKE_SHOW_VALUES=1` from `.env` is applied without a shell export.
  - By default, only non-sensitive metadata continues to be printed.

### GAP-005 — The state contradiction in the sent→failed transition is intentionally retained

- Linked item: AR-014
- Severity: Medium
- Location:
  - `src/core/pipeline.ts:350-389`
  - `docs/DESIGN.md` §2·§3 status column policy
- Symptom:
  - In the failed→sent transition, the old `_error` is cleared, so half of the original problem is resolved.
  - Conversely, if a formerly-sent row becomes failed under a new template, the current `_send_status=failed` and the old `_sent_at`/`_message_id` coexist.
  - The resolution record itself also states that this conflict has not been fully resolved.
- Impact:
  - The sheet's four status columns alone cannot distinguish "current attempt" from "past success."
  - Staff or downstream automation may mistake the presence of `_message_id` for current success.
- Required action:
  - Separate current-attempt status from past-success audit information into a separate column or a SendLog lookup.
  - If only the existing four columns are kept, the meaning of each column must be consistently fixed as either "last attempt" or "last success."
- Full-resolution criteria:
  - A sent→new-template-failed state is unambiguous to both humans and automation.
  - The meaning of the status columns is identical across SPEC/DESIGN/code/tests.

### GAP-006 — SendLog queries are now limited, but there is no pagination and no accurate `truncated`

- Linked item: AR-015
- Severity: Medium
- Location:
  - `src/adapters/sqliteSendLog.ts:130-140`
  - `src/server.ts:122-131`
- Symptom:
  - The default 200 / max 1000 limit substantially mitigates the original risk by capping the memory usage of a single call.
  - However, since there is no cursor, there is no way to query records older than 1000 entries via the MCP tool.
  - `truncated` is computed as `entries.length >= effectiveLimit`, so it is `true` even when the total record count exactly equals the limit.
- Impact:
  - Audit-history lookups are incomplete, and clients may expect a next page that does not exist.
- Required action:
  - Query `limit + 1` entries to determine the actual `hasMore`.
  - Add a stable DB `id` or a `(sent_at, id)` cursor to the input/output contract.
- Full-resolution criteria:
  - `truncated` or `hasMore` is accurate at the 199/200/201-entry boundaries.
  - A test exists that iterates two or more pages without duplication or omission.

### GAP-007 — Actual manual smoke testing is still incomplete

- Linked item: AR-016
- Severity: Medium (blocks release-completion verdict)
- Location: `docs/TASKS.md` T10, `docs/SPEC.md` §5
- Symptom:
  - The correction of the document status to `CODE DONE / MANUAL SMOKE PENDING` is appropriate.
  - However, an actual Google Sheet+Resend live send, status write-back, and duplicate-blocking on a second run have not yet been performed.
- Full-resolution criteria:
  1. Confirm dry-run results on an actual test sheet.
  2. Send one actual email.
  3. Verify the sheet status and the SendLog messageId.
  4. Re-run under the same conditions and confirm it becomes `skipped_duplicate` without a Provider call.
  5. Record the run date/time and results in the audit trail without secrets.

### GAP-008 — Verification of the server's SQLite shutdown lifecycle is insufficient

- Linked item: AR-018
- Severity: Low
- Location: `src/server.ts:165-173`
- Symptom:
  - smoke's `try/finally` appropriately closes the DB on the normal, early-return, and exception paths.
  - The server only wires close to `process.on("exit")`. This is not connected to the MCP server's explicit close/dispose and dependency lifecycle.
  - There is also no test for file-descriptor stability across repeated creation/shutdown, as recommended by the original report.
- Required action:
  - Provide an explicit `close()`/`dispose()` on the server assembly result, and call it exactly once across the normal-shutdown, signal, and initialization-failure paths.
  - Establish an idempotency or duplicate-call-guard policy for close.
  - Add a resource regression test for repeated creation/shutdown.
- Full-resolution criteria:
  - Cleanup is verified across normal shutdown, initialization failure, and representative signal paths.
  - Repeated creation/shutdown in a long-lived process does not accumulate DB handles.

## 3. New Regression

### REG-001 — Template hash delimiter changed from NUL to a space, enabling collisions

- Severity: High
- Location: `src/core/pipeline.ts:55-61`
- Difference from the baseline revision:
  - Previous implementation: `subjectTemplate + NUL + bodyTemplate`
  - Current implementation: `subjectTemplate + " " + bodyTemplate`
  - The comment still describes using a NUL delimiter, so it is also inconsistent with the code.
- Reproduction:

```text
subject="A ", body="B"
subject="A",  body=" B"
```

For both combinations, the hash input bytes both become `"A  B"`, producing the same 12-character hash in the current implementation.

Actual measured result:

```json
{"a":"a70bb07d2189","b":"a70bb07d2189","collision":true}
```

- Impact:
  - Different templates are treated as having the same idempotency key.
  - Even when a user has modified a template, a resend can be incorrectly blocked as `skipped_duplicate`.
- Required action:
  - Restore the NUL delimiter or use an unambiguous serialization such as length-prefixing.
  - Add a regression test for collisions from boundary-whitespace combinations in subject/body.
- Full-resolution criteria:
  - The hashes of the two combinations above are different.
  - The code comment matches the actual serialization method.

## 4. Items Confirmed Fully Resolved

### AR-017 — Email format validation

- `z.string().email()` is used to block `a@`, `@example.com`, `a@@example.com`, and addresses containing whitespace before the Provider call.
- A component regression test exists for representative malformed addresses.
- Existing valid-address and 1,000-row fixture tests also pass.
- Verdict: Fully resolved.

## 5. Automated Verification Results

Results of running `npm run check` under normal local IPC permissions:

- TypeScript typecheck: Passed
- ESLint: Passed
- Prettier: Passed
- Vitest: 13 test files, 130 tests passed

In the restricted sandbox, the e2e child `tsx`'s Unix socket creation failed with `EPERM`, but on re-running under normal permissions, all 130 passed. This is an execution-environment constraint, not a product defect.

Even though the automated gate passes, GAP-001~008 and REG-001 affect the resolution verdict because they involve paths the current tests do not cover, such as process interruption, DB failure, accurate pagination, and environment-variable load order.

## 6. Remediation Priority

1. Fix the REG-001 template hash collision regression
2. GAP-001/GAP-002: design `claimed`/`sent` state separation and interruption/commit-failure recovery
3. GAP-003: per-row isolation of release failures
4. GAP-004: fix the smoke environment-variable evaluation order
5. GAP-005: separate current status from past-success audit information
6. GAP-006: accurate hasMore and cursor pagination
7. GAP-007: perform actual manual smoke testing
8. GAP-008: verify server resource lifecycle and repeated shutdown

## 7. Tracking Rules

- This document does not overwrite `ADVERSARIAL_REVIEW_003_RESOLUTION.md`; it preserves the results of a subsequent re-verification.
- Link fix commits and test names to `GAP-001`~`GAP-008`, `REG-001`.
- Do not mark AR-011~016 and AR-018 as "fully resolved" until all full-resolution criteria are met.
