# Adversarial Review Report 003 STATUS_GAPS — Action Results

- Written on: 2026-09-01
- Target document: `docs/ADVERSARIAL_REVIEW_003_STATUS_GAPS.md` (STATUS-GAP-001~005, OBS-001~002)
- Related document chain:
  - `docs/ADVERSARIAL_REVIEW_003.md` (AR-011~018)
  - `docs/ADVERSARIAL_REVIEW_003_RESOLUTION.md`
  - `docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md` (GAP-001~008, REG-001)
  - `docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS_RESOLVED.md`
  - `docs/ADVERSARIAL_REVIEW_003_STATUS.md`
  - `docs/ADVERSARIAL_REVIEW_003_STATUS_GAPS.md` ← target of this round of action
- Change principle: the existing audit documents (the list above) are not modified. This document
  records the results.

## 1. Conclusion

Of the 5 major unresolved items (STATUS-GAP-001~005) and the observations (OBS-001~002) pointed
out by `ADVERSARIAL_REVIEW_003_STATUS_GAPS.md`, **every item resolvable through code, a CLI, or
documentation has now been addressed.** Only STATUS-GAP-005 (the actual manual smoke test), which
can be performed only with actual human credentials (Google Sheets/Resend), remains incomplete this
time as well, since it still cannot be substituted with code — this document does not hide that
fact and leaves it recorded as-is.

| Category | Verdict |
| --- | --- |
| STATUS-GAP-001 — automatic migration of the existing v1 DB schema | **Resolved** — lossless automatic conversion + original backup + rollback safety test |
| STATUS-GAP-002 — olderThanMs input validation | **Resolved** — a common validation function, applied to both adapters |
| STATUS-GAP-003 — human-only stale claim recovery CLI | **Resolved** — new `npm run recover:stale-claim` |
| STATUS-GAP-004 — status column meaning policy decision | **Resolved** — Option C (keep current policy + clarify the contract) adopted and documented |
| STATUS-GAP-005 — actual Google Sheet+Resend smoke test | **Unresolved** — still not performable this time, as actual credentials are required |
| OBS-001 — finalizing the claim expiry threshold operationally | **Unresolved (left as-is)** — a value that can only be set once real operational data exists |
| OBS-002 — documenting existing DB deletion/upgrade guidance | **Resolved** — added to README §Operations, DESIGN §6 |

## 2. STATUS-GAP-001 — Automatic migration of the existing SendLog DB schema

### Action

The `src/adapters/sqliteSendLog.ts` constructor determines the schema version of an existing table
via `PRAGMA table_info(send_log)` (`detectSchemaVersion()`, exported).

- `none` (no table): create the new v2 schema directly.
- `v2_claim` (has `claim_token`/`committed` columns): already the latest schema — do nothing.
- `v1_record` (has only the `send_status` column, the T6-era record() schema):
  `migrateV1ToV2()` converts it automatically.
- Anything else (an unrecognized column configuration): no migration is attempted; it immediately
  fails with an error explaining the cause and the remedy.

`migrateV1ToV2()` performs the following in a single transaction (`db.transaction()`):

1. If a `send_log_new` temp table left over from a previously interrupted migration exists, it
   errors immediately (to prevent a collision).
2. Creates `send_log_new` with the v2 schema.
3. Moves only rows that previously had `send_status='sent'` over, as `committed=1` (confirmed).
   `claim_token` is issued as a fresh, migration-only UUID (since a past run will never call
   commit/release with that token, no ownership conflict arises). Rows that were `failed`/
   `skipped_duplicate` are **deliberately not carried over** — v1 had a bug where, because of a
   UNIQUE constraint, once a key was recorded as a failure, the same key could never be retried
   permanently (this exact bug is what AR-011/GAP-001 fixed via the claim/commit redesign), and
   that bug must not be carried into the new schema.
4. The original `send_log` is not deleted, only renamed to
   `send_log_v1_backup_<timestamp>_<random>`.
5. `send_log_new` is renamed to `send_log`.

Because it is a transaction, if step 1 (a collision) or any other SQL error occurs along the way,
better-sqlite3 rolls everything back, leaving the original `send_log` intact and undamaged — the
constructor wraps this and re-throws it as an agent-friendly error that includes the phrase "the
original was preserved."

### Verification

The `v1(T6 record) → v2(claim/commit) automatic migration` describe block (6 tests) in
`tests/sqliteSendLog.test.ts` actually confirms:

- That when a fixture DB with the previous `send_status='sent'` is created and opened with the new
  `SqliteSendLog`, `wasSent()=true`, `claim()=false`, and `list()` returns the original
  `messageId`/`sentAt` unchanged along with `sendStatus='sent'`.
- That `failed`/`skipped_duplicate` rows are not carried over, so that key can be `claim()`'d
  again.
- That, after migration, the `send_log_v1_backup_*` table remains with the original rows intact
  (confirmed directly via a raw SQLite query).
- That, when the `send_log_new` temp table already exists (simulating an interrupted migration),
  the constructor throws, and the original v1 `send_log` table's columns/rows remain identical to
  before the migration attempt.
- That a DB that is already on the v2 schema opens as-is without migration (without creating a
  backup table).
- That an unrecognized column configuration that is neither v1 nor v2 throws an explicit error.

Also manually confirmed by creating an actual v1 DB file and running `npm run recover:stale-claim`
against it (see §4).

### Full-resolution criteria comparison

Of STATUS-GAP-001's 7 full-resolution criteria (as written in the original document), all were
met, including "the README or operational documentation has an upgrade and backup procedure" —
reflected in the README `Operations` section and `docs/DESIGN.md` §6 (see §6).

## 3. STATUS-GAP-002 — olderThanMs input validation

### Action

`assertValidStaleClaimThreshold(olderThanMs)` was newly added to `src/core/types.ts`. A single
`Number.isInteger` check rejects negative/NaN/Infinity/fractional values altogether (NaN/Infinity
already make `isInteger` false to begin with). Both `SqliteSendLog.forceReleaseStaleClaim()` and
`InMemorySendLog.forceReleaseStaleClaim()` call this **single common function** at the very start
of the function, so it throws before ever reaching the cutoff calculation or the DELETE/removal
logic — no claim is touched on invalid input.

### Verification

Parameterized tests using `it.each([-1, NaN, Infinity, -Infinity, 1.5])` were added to each
adapter's test file, verifying that all 5 boundary values immediately throw an error and that the
just-created claim remains intact (confirmed via `wasSent()`). It was also separately verified via
a test that `olderThanMs=0` is allowed as a valid value.

### Full-resolution criteria comparison

"The operational recovery path separately enforces a conservative minimum greater than 0" is
handled not by this function itself but by the STATUS-GAP-003 CLI (rejecting anything under 5
minutes without `--i-understand-the-risk`, §4). "Whether 0ms is allowed and the operational minimum
policy are documented in DESIGN and operational docs" has been reflected in `docs/DESIGN.md` §6.

## 4. STATUS-GAP-003 — Human-only stale claim recovery CLI

### Action

New `scripts/recoverStaleClaim.ts` (`npm run recover:stale-claim`). It implements the requested
flow exactly.

- **Defaults to a read-only lookup**: running without `--confirm` opens the DB via
  `new Database(path, {readonly:true})` — since SQLite itself structurally refuses any write, this
  path cannot delete anything even if there were a bug in the code. It prints whether the claim
  exists, whether it is `committed`, and the elapsed time since the claim (or confirmation).
- **No deletion without explicit confirmation**: only with `--confirm` (and only at that point)
  does it open a writable connection to `SqliteSendLog` and call `forceReleaseStaleClaim()`.
- **A confirmed sent record cannot be deleted by any option**: since `forceReleaseStaleClaim()`
  itself only targets rows with `committed=0` (see GAP-001/GAP-009), even if the CLI re-checks
  separately, the layer below is already blocking it. If the lookup result shows
  `committed=true`, the CLI does not even call `forceReleaseStaleClaim()` even when given
  `--confirm`, and instead reports that "there is nothing to reclaim."
- **Operational minimum**: `--older-than-ms` defaults to 30 minutes, and **anything under 5 minutes
  is rejected without the `--i-understand-the-risk` flag** (the "conservative minimum for the
  operational recovery path" required by STATUS-GAP-002's full-resolution criteria).
- **Audit log**: both lookup (`inspect`) and actual reclaim (`force_release`) record the time,
  arguments, result, and `--reason` to `data/recovery-audit.log` (JSON Lines, relocatable via
  `RECOVERY_AUDIT_LOG_PATH`). This script does not handle sensitive information such as sheet
  values or email bodies to begin with (sheetId/tab/rowKey/templateHash are already treated as
  non-sensitive metadata, per the AR-009 standard).
- **Re-send guidance**: on a successful reclaim, it prints a warning to "verify on the Provider
  dashboard, before re-sending, that it was not actually already sent," and the script itself does
  not perform a re-send (it explicitly states the pipeline must be run again separately).

### Verification

An actual v2-schema DB file was created and 4 stages (lookup → rejection of a too-short
`--older-than-ms` → normal reclaim → re-lookup after reclaim) were run manually, confirming the
output and the audit log contents (run directly in the session that authored this document; the
result was as expected, and temporary artifacts were cleaned up). It is not included in
`npm run check` — it is a human-only tool of the same character as `smoke.ts`.

### Full-resolution criteria comparison

All 6 criteria required by the document (lookup without modifying product code, defaulting to
read-only, safely rejecting an invalid key/young claim/confirmed sent, no deletion without explicit
approval, an auditable record, and documenting the recommended `olderThanMs` decision criteria and
Provider verification procedure) were met.

## 5. STATUS-GAP-004 — Status column meaning (GAP-005) policy decision

STATUS-GAP-004 was not a code bug but a **product policy that had not been decided**: "it is
difficult to distinguish a past success from a current failure using only the 4 status columns."
This time, among the three options (A: show only the last attempt, B: split into attempt/success
columns, C: keep the current mixed policy + clarify the contract), **Option C** was adopted, and
the decision is now finalized.

### Reason for the decision

- Option B (splitting the columns) would force a sheet schema change (adding columns) on existing
  users, imposing a migration burden beyond the v0.1 scope.
- Option A (showing only the last attempt, always looking up past successes from SendLog) would
  make it impossible for someone looking only at the sheet to check "has this row ever succeeded
  in the past," eliminating the audit value that AR-014 originally intended to preserve.
- Option C requires no code changes at all (the current implementation already matches this
  policy), and since "the contract was not clearly documented" was the actual defect, it is fully
  resolved by documentation alone.

### Action

A "Policy decision (STATUS-GAP-004, GAP-005 follow-up)" section was added to `docs/DESIGN.md` §2,
formalizing the following.

- `_send_status` always represents only the **most recent run (last attempt)**.
- Even if `_message_id`/`_sent_at` has a value when the status is `failed`/`skipped_duplicate`,
  that is an audit record of a past attempt, not a statement that "this run succeeded" —
  automation must judge success/failure solely by `_send_status`.
- "Has this row/template combination ever actually been sent in the past" should be looked up via
  `SendLog.wasSent()`/`list()` (the `get_send_log` MCP tool), not the sheet — SendLog is the source
  of truth.
- It also states explicitly that Option B is not adopted in v0.1 (to be revisited as a separate
  task if it becomes necessary in the future).

### Full-resolution criteria comparison

"A human decides among policies A/B/C" — this document itself is that decision. "SPEC, DESIGN, the
sheet column names, the pipeline, and the adapter tests use the same meaning" was already the case
(the code was already behaving according to Option C from the start), and this time the meaning has
been formalized in DESIGN.md so that "why it behaves this way" can be understood from the
documentation alone. That the transition rules (sent→failed, failed→sent, sent→duplicate) are
unambiguous has also already been verified via the existing `toStatusUpdate()` and the AR-014
regression test (unchanged).

## 6. STATUS-GAP-005 — Actual Google Sheet+Resend manual smoke test (unresolved)

This session too, no `.env` file exists (confirmed), and there is no actual Google service account
key, Resend API key, or dedicated test Google Sheet. This item cannot be substituted through
code/CLI/documentation alone — it requires actual send infrastructure and human approval, a
character repeatedly confirmed since GAP-007/AR-016.

The 7 steps of the full-resolution criteria (as written in the original document, §2
STATUS-GAP-005) remain valid as-is, and the execution readiness (smoke test code, dual safeguards,
`MANUAL SMOKE PENDING` marker) is already in place. **It can only be marked as fully resolved once
a human directly performs, with actual credentials, `npm run smoke` (dry-run) →
`SEND_MODE=live SMOKE_CONFIRM_SEND=1 npm run smoke` (an actual 1-item send) → a re-run (confirming
the duplicate block) in that order, and records the results in a separate audit document.**

## 7. OBS-001 — Finalizing the claim recovery threshold operationally (unresolved, intentionally left as-is)

The actual operational default for `forceReleaseStaleClaim(olderThanMs)` was again not finalized as
a code constant this time. The "reject anything under 5 minutes without
`--i-understand-the-risk`" added to the STATUS-GAP-003 CLI is merely an **input-mistake-prevention
guard**, not an answer to the operational policy question of "how many minutes is actually the
right stale threshold." This value can only be set once real operational data has accumulated —
things like Resend response latency, the retry policy, and the actual time it takes an operator to
check the dashboard — so since STATUS-GAP-005's actual smoke test must come first for a meaningful
value to be chosen, it is left unresolved until then.

## 8. OBS-002 — Documenting existing DB deletion guidance

With the STATUS-GAP-001 action, the guidance of "delete the DB and recreate it" is no longer needed
in the first place (since the automatic migration is lossless). Instead, the new automatic upgrade
behavior and how to use the STATUS-GAP-003 recovery CLI have been added to a new
"Operations — Upgrading an existing DB / stale claim recovery" section in `README.md` and to
`docs/DESIGN.md` §6.

## 9. Automated quality gate

```
npm run check
  ✓ typecheck (tsc --noEmit)
  ✓ lint (eslint .)
  ✓ format:check (prettier --check .)
  ✓ test (vitest run) — 13 test files, 174 tests passed (156 existing + 18 new)

npm run test:coverage
  core/ overall 93.36% stmts/lines (a slight rise from 93.24% — types.ts maintained at 100%)
```

Confirmed identically in both the kingfish and DevWork worktrees (see §10 on commit
synchronization).

## 10. Tracking rule

- This document does not overwrite `docs/ADVERSARIAL_REVIEW_003_STATUS_GAPS.md`.
- STATUS-GAP-005 and OBS-001 remain unresolved until actual smoke test evidence is recorded — the
  gate passing or the existence of this document is not grounds for saying "fully resolved."
- If a subsequent re-review is produced, it will start freshly as
  `docs/ADVERSARIAL_REVIEW_004.md` (the existing chain is preserved).
