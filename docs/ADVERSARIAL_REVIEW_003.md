# Adversarial Review Report 003

- Review date: 2026-09-01
- Scope: T1~T10 in full, combined status of docs, core, adapters, MCP server, tests, and smoke
- Baseline revision: `63d23f9` (`login-flow`, `docs-tasks-progress-summary`)
- Previous reports: `docs/ADVERSARIAL_REVIEW_001.md`, `docs/ADVERSARIAL_REVIEW_002.md`
- Review method: cross-checking spec/design/tasks against the implementation, adversarial boundary analysis, running quality gates, coverage, and dependency audits
- Change principle: no changes to product code or existing docs — only this new audit record was created

## 1. Overall Assessment

The general success paths and declared automated tests for T1~T10 are, on the whole, well implemented. Under normal permissions, `npm run check` passed all 114 tests, core line coverage was 94.15%, and there were 0 production dependency vulnerabilities. The code/doc fixes for AR-006~010 from the previous report were also confirmed.

However, there is a high-severity defect that breaks "zero duplicate sends," the core of the v0.1 success criteria. If the same `id_column` value appears twice within a single run, or two runs overlap, the idempotency check and the reservation are not atomic, so an actual email gets sent twice. There is also an inconsistency where the `.env` guidance does not match how the server is actually run, so following the README procedure alone will not start the server/smoke, and a case where a successful external send followed by a local record failure gets misjudged as a send failure. Given this, the current state cannot be judged ready for production deployment.

## 2. T1~T10 Review Summary

| Task | Verdict | Key basis / residual risk |
| --- | --- | --- |
| T1 Types/config | Pass (improvement recommended) | Required-value, channel, and filter-pair validation are working correctly. The policy for normalizing leading/trailing whitespace in identifiers is still unspecified |
| T2 In-memory sheet/fixtures | Pass | Returns copies, restricts status columns, and the 1,000-row fixture works correctly |
| T3 GoogleSheetClient | Pass (operational risk) | A1 quoting and write-back contract tests exist. Integrated recovery for bulk write-back / external failures is unverified |
| T4 Template | Pass | Confirmed reinforced handling of non-ASCII, whitespace, and hyphenated keys, and of missing-value detection |
| T5 Provider | Pass (improvement recommended) | fetch injection / error response handling work correctly. Email pre-validation only checks for the presence of `@` |
| T6 SendLog | Conditional pass | Basic CRUD/unique/persistence tests work correctly. Lacks atomic claim, has unbounded list, and has lifecycle issues |
| T7 Pipeline | Blocked | Duplicate sends possible within the same batch/concurrent runs; send/log/sheet status can become inconsistent |
| T8 MCP server | Conditional pass | The 4 tools and the dual-gate tests work correctly. `.env` is not loaded, and there is an unbounded log response issue |
| T9 e2e/coverage | Meets automated criteria | 4 tools pass e2e, core at 94.15%. Duplicate-key, race, and partial-commit scenarios are missing |
| T10 Smoke/docs | Judged incomplete | The script exists, but there is no evidence of an actual run against a real sheet and real email, and the `.env` procedure does not work |

## 3. New Findings

### AR-011 — Idempotency breaks within the same batch and in concurrent runs, causing actual duplicate sends

- Severity: High (release-blocking)
- Location: `src/core/pipeline.ts:130-147`, `src/core/pipeline.ts:242-264`, `src/adapters/sqliteSendLog.ts:61-98`
- Symptom:
  - The pipeline first checks `wasSent()` for every row, and only afterward performs per-row `provider.send()` and `record()`.
  - If the same `id_column` value appears twice in the same data tab, both rows see `wasSent=false` and become `pending`.
  - Even after the first row is sent and recorded, the second row is sent without being re-checked. Only the second `record()` hits a unique conflict.
  - The same TOCTOU (check-then-act) race also occurs when two separate MCP calls run concurrently.
- Minimal reproduction:
  1. Put 2 send-target rows with `customer_id=C-1` in the same tab.
  2. Run once with `dryRun=false`.
  3. The Provider is called twice, but only 1 entry remains in the SendLog.
- Impact:
  - Fails to guarantee "zero duplicate sends when the same command is run twice" from `docs/SPEC.md` §5.
  - Payment reminders and reservation notifications can be sent twice to the same customer, causing trust and cost issues.
- Recommendation:
  - Add a SendLog contract that atomically claims `(sheetId, tab, rowKey, templateHash)` before sending. E.g., `tryClaim(): boolean` plus a `pending`/`sent` state and an expiration/recovery policy.
  - Don't stop at same-process serialization alone — use a SQLite unique insert as the claim boundary so multiple processes are also protected.
  - Document a policy to either explicitly reject duplicate rowKeys within the same batch as `failed` before sending, or to claim only the first row.
  - Add regression tests for same-batch duplication and concurrent `Promise.all()` execution.

### AR-012 — The README's `.env` procedure does not take effect in the actual run commands

- Severity: High
- Location: `README.md:33-39`, `dev`/`smoke` in `package.json`, `.mcp.json:5-7`, `src/server.ts:134-145`
- Symptom:
  - The README instructs copying `.env.example` to `.env` and filling in the values.
  - However, none of `tsx src/server.ts`, `tsx scripts/smoke.ts`, or `.mcp.json` load dotenv or use Node's `--env-file=.env`.
  - Since the source only reads `process.env`, if a user just creates a `.env` file as the README says, the required environment variables never make it into the process.
- Impact:
  - `npm run dev` exits with `GOOGLE_SERVICE_ACCOUNT_JSON environment variable is missing`.
  - `npm run smoke` skips, saying `SMOKE_SHEET_ID` is missing.
  - Claude Code's committed MCP config also fails to start unless the shell has already exported the variables beforehand.
- Recommendation:
  - Either place an explicit `.env` loader at the very top of the entry point in a way that preserves Node 20 compatibility, or use a verified env-file option in the run scripts and `.mcp.json`.
  - Alternatively, remove `.env` usage from the docs and accurately describe the `export`/environment-injection procedure.
  - Prevent regressions with a child-process startup test that creates a temporary `.env`, using fake secret values.

### AR-013 — A SendLog record failure after a successful external send is misjudged as `failed`

- Severity: High
- Location: `src/core/pipeline.ts:242-273`
- Symptom:
  - `provider.send()` and `sendLog.record()` are inside a single `try/catch`.
  - If the Provider returns `ok=true` and then `record()` fails (e.g., unique conflict, DB lock, disk full), the catch overwrites the row status with `failed`.
  - In reality the email has already been sent to the customer, so this cannot be rolled back.
- Impact:
  - Creates a false failure: the API result and the sheet show failure, but the customer actually received the email.
  - If an operator retries the "failed" entry, it can be sent twice. In the AR-011 same-rowKey reproduction, this path is triggered immediately.
- Recommendation:
  - Model the Provider result and the local record result as separate steps/states.
  - Use a claim → send → finalize pattern, and isolate a finalize failure into a resend-blocking state such as `delivery_unknown` or `sent_log_failed`.
  - Verify Provider call count, returned status, and re-run policy with a `record()` failure-injection test.

### AR-014 — A stale `_error` remains after a successful retry, leaving the row status contradictory

- Severity: Medium
- Location: the `StatusUpdate` contract in `src/core/types.ts`, `src/core/pipeline.ts:329-335`, `src/adapters/googleSheetClient.ts:248-273`
- Symptom:
  - `undefined` on an optional status field means "leave this cell untouched."
  - When a row that previously recorded `_error` on failure later succeeds after the data is fixed, the sent update carries no `error`, so the stale `_error` remains as-is.
  - Conversely, if a previously successful row fails under a new template, the previous `_sent_at` and `_message_id` remain, conflicting with the current `_send_status=failed`.
- Impact:
  - Staff who only look at the sheet may misjudge success/failure.
  - Downstream automation that keys off the presence of `_error` or `_message_id` will misbehave.
- Recommendation:
  - Introduce an explicit three-state contract, such as `undefined=no change`, `null=clear the cell`.
  - Clear `_error` on success, and document the `_message_id` policy for the current attempt on failure.
  - Test each of the failed→sent, sent→new-template-failed, and sent→duplicate transitions.

### AR-015 — `get_send_log` does an unbounded full read and serialization, so memory/response size keeps growing

- Severity: Medium
- Location: `SendLog.list` in `src/core/types.ts`, `src/adapters/sqliteSendLog.ts:101-108`, `src/server.ts:109-123`
- Symptom:
  - `list(sheetId)` loads all records for that sheet into an array all at once.
  - The MCP handler builds the same array separately as a JSON string and as `structuredContent`, which can leave large data resident in memory twice over.
  - There is no limit, cursor, date range, or maximum response size.
- Impact:
  - Over long-term operation, a single call can occupy the event loop for a long time and cause a memory spike/OOM, or exceed the MCP message size.
  - This is not a classic leak from permanently retained objects, but since the log grows monotonically, it carries an operational risk of unbounded resource growth similar to a leak.
- Recommendation:
  - Change to `list(sheetId, {limit, cursor})` with a conservative default/max limit.
  - Apply an `ORDER BY id DESC LIMIT ?` and cursor condition to the DB query.
  - Measure the double-serialization cost of content/structuredContent on large histories and decide on a maximum response policy.

### AR-016 — T10 and v0.1's actual smoke-completion criteria were marked DONE without execution evidence

- Severity: Medium
- Location: `docs/TASKS.md` T10, `docs/SPEC.md:49-54`
- Basis:
  - The SPEC success criterion is to perform an end-to-end run against one real Google Sheet and a real email address.
  - The T10 record states that, lacking real credentials, it could not be run directly, and only the branches were verified with a temporary mock-based script.
  - Therefore, smoke "script implementation" is done, but the product success criterion — an actual manual send — is not done.
- Impact:
  - Google permissions, an actual Resend sending domain, the API response, write-back, and duplicate prevention on re-run have never been integration-verified even once, and this could be mistaken for v0.1 completion.
- Recommendation:
  - Split T10 into something like `CODE DONE / MANUAL SMOKE PENDING`, or maintain a separate release checklist.
  - Record the actual execution date/time, test sheet, first-run messageId, and second-run skipped result in the audit record, without secrets.
  - Fix AR-012 first, and also verify that the README procedure works as written.

### AR-017 — Email format validation only checks for the presence of `@`, so clearly malformed addresses reach the API

- Severity: Low
- Location: `src/core/pipeline.ts:178-199`
- Symptom:
  - Addresses like `a@`, `@example.com`, `a@@example.com`, and ones containing whitespace all pass `includes("@")`.
- Impact:
  - Increases unnecessary external API calls and per-row failures, and produces unclear errors recorded depending on the Provider response.
- Recommendation:
  - Rather than an excessive full RFC implementation, apply a validated email schema or at least a minimal practical format check at the boundary.
  - Add representative clearly-malformed addresses to the component tests.

### AR-018 — No explicit shutdown path for the production SQLite handle

- Severity: Low
- Location: `src/adapters/sqliteSendLog.ts:111-114`, `src/server.ts:134-155`, `scripts/smoke.ts:42-113`
- Symptom:
  - `SqliteSendLog.close()` is only called in tests.
  - Neither the server nor smoke explicitly closes the instance it creates on shutdown.
- Impact:
  - No immediate permanent memory leak was confirmed, since the OS reclaims resources on normal process exit.
  - However, in a long-lived process that repeatedly creates instances — e.g. embedded/restart/test-runner scenarios — file descriptors and native DB resources could accumulate, and the WAL checkpoint/shutdown behavior is also not explicit.
- Recommendation:
  - Expose a dependency lifecycle (`dispose`/`close`) at the composition layer and call it on MCP server shutdown and in smoke's `finally`.
  - Test that file descriptors remain stable across repeated creation/closing.

## 4. Tracking of Previous Report Items

| Existing ID | Status | Verification result |
| --- | --- | --- |
| AR-001 | Feature implementation resolved; release verdict withheld | T3~T10 code exists. Not release-ready due to AR-011~016 |
| AR-002 | Resolved | Blank filters are normalized to `undefined` |
| AR-003 | Resolved | `npm audit --omit=dev` shows 0 vulnerabilities |
| AR-004 | Resolved | `format:check` is included in the quality gate and passes |
| AR-005/010 | Resolved | The README links to the task doc as the source of truth |
| AR-006 | Resolved | Template keys support non-ASCII/whitespace/hyphens and are tested |
| AR-007 | Resolved | All Google A1 tab names are quoted uniformly, with tests for special characters |
| AR-008 | Resolved | 12 network-free contract tests exist for the Google read/write paths |
| AR-009 | Resolved | The smoke default output is limited to rowKey/status; value output is opt-in |

## 5. Verification Results

### Quality gates

Under normal, non-sandboxed local IPC permissions, `npm run check` passes:

- TypeScript typecheck: pass
- ESLint: pass
- Prettier: pass
- Vitest: 13 test files, 114 tests passed, 0 failed/skipped

Note: in a restricted sandbox, the e2e child `tsx` process failed with `EPERM` when creating a local Unix socket. It passed on re-run under normal permissions, so this was judged an execution-environment constraint, not a product defect.

### Coverage

`npm run test:coverage` results:

- core statements: 94.15%
- branches: 93.18%
- functions: 100%
- lines: 94.15%
- `config.ts`: 95.29% lines
- `pipeline.ts`: 92.68% lines
- `readRows.ts`, `template.ts`: 100% lines

The numeric targets are met, but the state-transition and race-condition issues in AR-011~014 are not revealed by coverage numbers alone.

### Dependency security

`npm audit --omit=dev --json` results:

- Vulnerabilities: 0
- Production dependencies: 189
- high/critical: 0

### Repository/execution environment

- Git tracked changes at the start of the review: none
- Baseline Node: v24.12.0 (within the `>=20` range in `package.json`)
- Confirmed native SQLite and the full test suite run after `npm ci`
- No real Google/Resend credentials were used, and no actual network sends were performed

## 6. Confirmed Strengths

- Live sending requires both `SEND_MODE=live` and `confirm=true`, and the dry-run path is verified in e2e.
- External IO sits behind interfaces, and Google/Resend support network-free injection tests.
- Google A1 quoting, status-column restriction, and the optional-field-not-written contract are covered in the adapter tests.
- Missing template values are isolated as per-row failures, and non-ASCII headers/values are handled.
- A Provider failure on one row does not halt the remaining sends.
- No hardcoded secrets or committed `.env` were found.
- The automated gate covers type checking, lint, format, and unit/component/e2e tests all together.

## 7. Remediation Priority

1. AR-011/AR-013: introduce atomic claim and a post-send record-failure state model
2. AR-012: fix the `.env` execution contract and test the actual entry points
3. AR-014: a three-state contract for clearing/preserving status cells, with transition tests
4. AR-016: complete a manual smoke test with a real sheet + real email before the v0.1 verdict
5. AR-015: SendLog pagination and response size limits
6. AR-017/AR-018: reinforce email validation and resource shutdown lifecycle

## 8. Tracking Rules

- The next adversarial review is recorded as `docs/ADVERSARIAL_REVIEW_004.md`.
- Existing reports are an audit record of the state at the time, so they are not overwritten.
- Link finding IDs (e.g. `AR-011`) in fix commits, tests, and task descriptions.
</content>
