# Adversarial Review Report 003 STATUS — Major Unresolved Items

- Written on: 2026-09-01
- Review target: `docs/ADVERSARIAL_REVIEW_003_STATUS.md`
- Related documents:
  - `docs/ADVERSARIAL_REVIEW_003.md`
  - `docs/ADVERSARIAL_REVIEW_003_RESOLUTION.md`
  - `docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md`
  - `docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS_RESOLVED.md`
- Baseline revision: `2fe0293` (`GAP-009 (found during re-verification): added a committed guard to commit()/release() + final status document`)
- Review principle: rather than declaring full resolution based solely on tests passing and the implementation existing, conservatively verify upgrades against existing data, malformed operational input, and the actual recovery procedures and manual integration verification a human would have to perform
- Change principle: the product code and existing audit documents are not modified; only remaining items are recorded in a new document

## 1. Conclusion

Most of the core code fixes described by `ADVERSARIAL_REVIEW_003_STATUS.md` match the actual
implementation. There is corresponding code and regression tests for the REG-001 template hash
collision, atomic claim, ownership token, `committed=0` guard, release failure isolation, dotenv
evaluation order, cursor pagination, and SQLite shutdown handling. Under normal permissions,
`npm run check` also passed all 156 tests.

However, for the following reasons, the STATUS document's statement that "every item that could be
fully resolved through code has now been resolved" does not yet conservatively hold.

1. The existing SendLog DB is not migrated to the new schema, so the actual send path breaks
   immediately after an update.
2. The time input for forced stale-claim release is not validated, so a negative value can
   immediately delete even the most recent claim.
3. The stale-claim recovery function exists, but there is no official CLI/script or audit
   procedure for a human to safely execute it.
4. The status column meaning from GAP-005 and the actual Google Sheet+Resend smoke test from
   GAP-007 remain incomplete.

Therefore the current verdict is as follows.

| Category | Verdict |
| --- | --- |
| Automated code path for a fresh install / new DB | Mostly resolved |
| Update path for an installation with an existing DB | Unresolved |
| Internal data model of stale claims | Mostly resolved |
| Operator recovery path for stale claims | Partially resolved |
| Status column meaning (GAP-005) | Awaiting human decision |
| Actual manual smoke test (GAP-007) | Incomplete |

## 2. Major unresolved items

### STATUS-GAP-001 — Existing SendLog DB schema is not automatically migrated

- Severity: High
- Related items: GAP-001, GAP-002, AR-011, AR-013
- Location: `src/adapters/sqliteSendLog.ts:61-84`
- Symptom:
  - The previous schema has `send_status`, `error` columns, and does not have `claim_token`,
    `committed` columns.
  - The current constructor only runs `CREATE TABLE IF NOT EXISTS`. If the table already exists,
    it neither adds the new columns nor converts the data.
  - The current `claim()` inserts into the `claim_token` column, and `commit()`/`list()` use the
    `committed` column.
  - The code comment explains "since v0.1 hasn't been released yet, delete the existing DB and
    recreate it," but at runtime it neither prints that guidance nor automatically performs a safe
    conversion.

#### Actual reproduction

A DB file with the same schema as the previous version was created, then opened with the current
`SqliteSendLog` and `claim()` was called.

```text
SqliteError: table send_log has no column named claim_token
```

That is, the constructor itself succeeds, but the failure only occurs at the actual send moment.
In the pipeline, `claim()` runs before the provider call, so no actual send occurs, but the entire
run can terminate with an exception.

#### Impact

- Existing development/smoke environments become unable to use the send feature right after
  updating the code.
- Simply deleting the DB file erases the existing idempotency history.
- Rows sent in the past will appear unsent in the new DB, so the same template could be sent
  again.
- The response of "just delete the DB" cannot be considered a safe migration, due to the risk of
  data loss and duplicate sends.

#### Required action

1. Determine the current version at creation time via `PRAGMA table_info(send_log)` or an explicit
   schema version table.
2. Implement a transactional migration that preserves existing records.
3. Convert previous `send_status='sent'` records to `committed=1`.
4. Generate a migration-only unique value for the `claim_token` needed by past confirmed records,
   ensuring it is never reused as an external claim ownership token.
5. If there is a state that cannot be converted, the server should fail-fast before tool
   connection, and guide the user with an agent-friendly error that includes the DB path and a
   backup/recovery method.
6. Document a pre-migration DB backup or atomic temp-table-swap strategy.

#### Full-resolution criteria

- A DB file with the previous schema, created as a fixture, is automatically converted when opened
  by the current constructor.
- `wasSent()` for an existing send record is still true after migration.
- The existing messageId and sentAt are preserved.
- `claim()` on the same row/template returns false, blocking re-sending.
- New rows go through claim→commit normally.
- There is a test confirming the original DB is not corrupted even if the migration fails midway.
- The README or operational documentation has an upgrade and backup procedure.

### STATUS-GAP-002 — `forceReleaseStaleClaim()` does not validate negative/abnormal time values

- Severity: Medium
- Related items: GAP-001
- Location:
  - `src/adapters/sqliteSendLog.ts:168-185`
  - `src/mocks/inMemorySendLog.ts:119-132`
  - `src/core/types.ts:175-187`
- Symptom:
  - `olderThanMs` is just a `number`; there is no runtime validation that it is finite/an
    integer/greater than or equal to 0.
  - The SQLite implementation constructs the cutoff via `new Date(Date.now() - olderThanMs)`.
  - Given a negative value, the cutoff becomes a future time, so even the most recently created
    claim satisfies the "old claim" condition.
  - The in-memory implementation also releases the most recent claim on a negative value, because
    of the `ageMs < olderThanMs` comparison.

#### Actual reproduction

`olderThanMs=-1` was passed for a just-created claim.

```json
{
  "released": true,
  "stillPresent": false
}
```

Because the most recent claim was deleted immediately, another run could claim the same row again
and send a duplicate.

#### Additional edge cases

- `NaN`: in SQLite, `toISOString()` can throw a `RangeError`, and behavior can differ between
  implementations.
- `Infinity`: can produce an invalid Date.
- Fractional values: there is no semantic reason to allow these, and they conceal an operational
  input mistake.
- Very small values (0 or 1ms): functionally possible, but carries a very high risk of prematurely
  reclaiming a claim whose send is actually in progress.

#### Required action

1. Both adapters use the same common validation function.
2. Enforce `Number.isFinite(olderThanMs)`, `Number.isInteger(olderThanMs)`, `olderThanMs >= 0`.
3. Enforce a separate, conservative minimum greater than 0 for the operational recovery path.
4. Include the allowed unit (ms), the input value, and a safe fix in the error message.
5. If possible, also consider a mode where a human confirms and passes an absolute cutoff ISO
   timestamp.

#### Full-resolution criteria

- `-1`, `NaN`, `Infinity`, and fractional input are explicitly rejected.
- No claim is deleted on invalid input.
- The InMemory and SQLite implementations behave identically.
- Whether 0ms is allowed, and the operational minimum policy, are documented in DESIGN and
  operational docs.

### STATUS-GAP-003 — No official execution path exists for a human to safely recover a stale claim

- Severity: Medium
- Related items: GAP-001, GAP-003
- Location:
  - `src/core/types.ts:175-187`
  - `src/adapters/sqliteSendLog.ts:168-185`
  - The claim recovery description in `docs/DESIGN.md`
- Symptom:
  - The internal API `forceReleaseStaleClaim()` is implemented.
  - Not exposing it as an autonomous MCP tool is a safe judgment. A claim that may already have
    been sent should not be automatically released by an agent.
  - However, there is no separate CLI for humans, no operational script, no dry-run inspection
    command, no confirmation wording, and no audit log.
  - Since the function exists only as a class method, an operator must write TypeScript code
    directly or build an ad hoc REPL command.

#### Impact

- If a claim is left behind due to a release failure or process interruption, there is no way to
  immediately perform recovery in actual operations.
- During ad hoc code authoring, sheetId/tab/rowKey/templateHash could be entered incorrectly, or an
  overly short expiration time could be chosen.
- The fact of a forced release is not recorded in any audit trail, making it hard to trace who
  changed a record back to re-sendable and why.

#### Required action

Add a human-only operational CLI or script. Recommended flow:

1. Explicitly input the DB path and the target key.
2. First run a read-only inspection that prints the claim time, elapsed time, and recipient row
   information.
3. Default to dry-run, deleting no records.
4. Require an actual release to have a separate, explicit confirm phrase or environment variable.
5. A confirmed sent record must not be deletable via any option.
6. Record the before/after contents, without sensitive information, in a separate audit log.
7. Do not re-send immediately after release; guide the user through a Provider dashboard/messageId/
   recipient verification procedure.

#### Full-resolution criteria

- The operator can look up a claim through an official command without modifying product code.
- The default run is read-only.
- Invalid keys, young claims, and confirmed sent records are safely rejected.
- No claim is deleted without explicit approval.
- The execution result and reason are left in an auditable form.
- The documentation states the recommended `olderThanMs` decision criteria and the Provider
  verification procedure.

### STATUS-GAP-004 — The GAP-005 status column meaning decision is not complete

- Severity: Medium
- Related items: GAP-005, AR-014
- Location:
  - `toStatusUpdate()` in `src/core/pipeline.ts`
  - The status column policy in `docs/DESIGN.md`
- Current policy:
  - On a failed→sent transition, the past `_error` is cleared.
  - On a sent→new-template-failed transition, the past `_sent_at` and `_message_id` are preserved.
- Remaining problem:
  - `_send_status=failed` and a past success's `_message_id` coexist in a single row.
  - A person or automation looking only at the 4 status columns has difficulty distinguishing the
    current failure from a past success.
  - The STATUS document also left this awaiting a human policy decision, so it is not a full
    resolution.

#### Decision needed

- Option A: the 4 status columns represent only the "last attempt," and past successes are looked
  up from SendLog.
- Option B: split into a "last attempt" column and a "last success" column.
- Option C: keep the current mixed policy, but make the column names and documentation clearer,
  and require downstream automation to rely only on `_send_status`.

#### Full-resolution criteria

- A human decides among policies A/B/C.
- SPEC, DESIGN, the sheet column names, the pipeline, and the Google/InMemory adapter tests all use
  the same meaning.
- The sent→failed, failed→sent, and sent→duplicate transitions are unambiguous for both humans and
  automation.

### STATUS-GAP-005 — Actual Google Sheet+Resend manual smoke test incomplete

- Severity: Medium (blocks the release-complete verdict)
- Related items: GAP-007, AR-016, T10
- Location:
  - T10 in `docs/TASKS.md`
  - §5 in `docs/SPEC.md`
  - `scripts/smoke.ts`
- Symptom:
  - The smoke test code and safety gates are implemented.
  - Actual Google Sheet permissions, the Resend sending domain, an actual 1-email send, the Google
    status write-back, and duplicate blocking on a retry of the same run have not yet been verified
    end to end.
  - The document correctly shows `MANUAL SMOKE PENDING`, but the product success criteria have not
    yet been met.

#### Full-resolution criteria

1. Run a dry-run against an actual test sheet.
2. Confirm the send target is exactly 1 row.
3. Use both `SEND_MODE=live` and `SMOKE_CONFIRM_SEND=1` to send an actual 1 email.
4. Verify the received email, the Resend messageId, and the sheet's
   `_send_status/_sent_at/_message_id/_error`.
5. Re-run with the same configuration to confirm it becomes `skipped_duplicate` without a provider
   re-call.
6. Confirm the corresponding record in SendLog is `sent`.
7. Record the execution date/time, anonymized sheet identifying information, a non-sensitive
   portion of the messageId, and the second run's result in an audit document.

## 3. Additional observations

### OBS-001 — The claim recovery threshold has not yet been finalized as an operational policy

- `STATUS.md` also states that the actual operational value of
  `forceReleaseStaleClaim(olderThanMs)` has not been finalized.
- This is not simply a matter of choosing a constant. It is connected to Provider request timeout,
  network retries, Resend-side asynchronous processing, and how much time an operator has to check
  the dashboard.
- Too short, and it enables an in-progress send to be reclaimed, causing duplicate sends; too long,
  and unsent rows stay blocked for a long time.
- A conservative default and a minimum allowed value should be set based on the results of actual
  manual smoke tests and fault injection.

### OBS-002 — There is no guidance for existing DB deletion in user-facing documentation

- The explanation of legacy schema incompatibility exists only in a source code comment.
- The README, DESIGN's execution procedure, and the error message give no way to determine how to
  identify and back up an existing DB.
- However, DB deletion itself removes the idempotency history, so it should not be documented as
  the recommended solution. Safe migration takes priority.

## 4. Correct actions already confirmed

The following changes matched what the STATUS document claimed and the actual code.

- REG-001: sha256 each of subject/body first, then re-hash the fixed-length digest, removing the
  boundary collision
- Part of GAP-001: separation of `claimed`/`sent` states, claim token, defense against an incorrect
  token
- GAP-002: separate `logFailed` aggregation and restoration of the aggregation invariant
- GAP-003: `safeRelease()` isolates release errors on a per-row basis
- GAP-004: `SMOKE_SHOW_VALUES` evaluated after the dotenv load
- GAP-006: `limit+1`, accurate `hasMore`, cursor pagination
- GAP-008: SIGINT/SIGTERM/exit cleanup and a repeated SQLite open/close test
- GAP-009: a committed record cannot be released, and double-commit is rejected
- The negative SendLog query limit is now clamped to a minimum of 1 so it is not passed through to
  SQLite's unlimited `LIMIT -1`

## 5. Verification results

### Automated quality gate

Re-ran `npm run check` under normal local IPC permissions:

- TypeScript typecheck: passed
- ESLint: passed
- Prettier: passed
- Vitest: 13 test files, 156 tests passed

### Additional manual reproduction

#### Existing DB schema

Calling `claim()` against the current code on a DB with the previous table structure:

```text
SqliteError: table send_log has no column named claim_token
```

#### Negative stale threshold

Applying `olderThanMs=-1` to the most recent claim:

```json
{
  "released": true,
  "stillPresent": false
}
```

Neither issue is covered by the current 156 tests, so neither is caught by the full gate passing
alone.

## 6. Remediation priority

1. STATUS-GAP-001: lossless, atomic schema migration for existing DBs
2. STATUS-GAP-002: stale time input validation and a safe minimum-value policy
3. STATUS-GAP-003: a human-only, read-only-first recovery CLI and audit log
4. STATUS-GAP-004: a human decision on the status column meaning, and contract unification
5. STATUS-GAP-005: actual Google Sheet+Resend manual smoke test
6. OBS-001: determining the actual operational claim expiry threshold value

## 7. Tracking rule

- This document does not overwrite the existing `ADVERSARIAL_REVIEW_003_STATUS.md`, and preserves
  the results of the follow-up conservative re-verification.
- Fix commits and test names are linked to `STATUS-GAP-001`~`STATUS-GAP-005`.
- Until STATUS-GAP-001~003 are resolved, do not mark it as "every item that could be fully resolved
  through code has been resolved."
- STATUS-GAP-004 is judged resolved only after the human policy decision is reflected in
  code/SPEC/DESIGN.
- STATUS-GAP-005 is judged resolved only after actual smoke test evidence is recorded.
