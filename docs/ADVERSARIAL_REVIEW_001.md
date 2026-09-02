# Adversarial Review Report 001

- Review date: 2026-09-01
- Target: entire `sheet_mcp` project
- Baseline revision: `bcec6d4` (`login-flow`)
- Review method: cross-checking docs, source, tests, and config; running local quality gates; auditing production dependency security
- Change policy: existing source and config were not modified during the review

## 1. Overall Assessment

The scaffolding, domain types, config parser, and in-memory sheet client covering the T0~T2 range pass the declared quality gates and are defensively implemented. However, since T3~T10 are still TODO, the repository is not currently a runnable MCP product. It must not be put into operation or user-facing testing.

The key risks are as follows.

1. The MCP tools, actual sheet integration, sending, idempotency, and send log have not yet been implemented.
2. Empty filter config is returned as a whitespace string, which could cause it to be incorrectly activated in a future pipeline.
3. There are 4 moderate-severity vulnerabilities in the production dependency path.
4. Prettier is not included in the completion gate, so `npm run check` does not guarantee format quality.
5. The status and quickstart descriptions in README do not match the actual implementation state.

## 2. Findings

### AR-001 — Core product functionality not implemented

- Severity: High
- Basis:
  - `src/server.ts` outputs only a "not implemented" notice to standard output instead of an MCP server.
  - `scripts/smoke.ts` also outputs only a "not implemented" notice.
  - Per `docs/TASKS.md`, T3~T10 are TODO.
- Impact:
  - `read_rows`, `preview_messages`, `send_notifications`, `get_send_log` cannot be called.
  - Google Sheets integration, email sending, duplicate-send prevention, status recording, and send history lookup are all impossible.
  - Following README's `npm run dev` does not start a usable MCP server.
- Verdict: This is currently a planned non-implementation on the roadmap, but from a release-readiness standpoint it is a blocker.
- Recommendation:
  - Complete T3~T10 following the dependency order in `docs/TASKS.md`.
  - After T8, verify protocol startup with an stdio MCP client.
  - Do not mark v0.1 as complete before T9's e2e-mock and T10's manual smoke are finished.

### AR-002 — Missing semantic normalization of empty filter config

- Severity: Medium
- Location: `src/core/config.ts:68-69`, `src/core/config.ts:105-106`
- Symptom:
  - The validation step treats `filter_column` and `filter_value` containing only whitespace as unset values.
  - The return step returns the same values as the original whitespace string rather than `undefined`.
- Repro:

```ts
parseNotifyConfig({
  data_tab: "x",
  id_column: "id",
  recipient_column: "email",
  channel: "email",
  subject_template: "s",
  body_template: "b",
  filter_column: "   ",
  filter_value: "   ",
});
```

The relevant part of the actual return value:

```json
{ "filterColumn": "   ", "filterValue": "   " }
```

- Impact:
  - If a future pipeline determines filter activation by `filterColumn !== undefined` or by a method other than truthiness, it could look up a column with a whitespace name.
  - This could lead to a failure where all rows are unintentionally filtered out.
- Recommendation:
  - Normalize both optional values to `undefined` when they are blank.
  - Add a regression test verifying that a whitespace pair input returns an `undefined` pair.
  - Also specify in the documentation the policy for handling leading/trailing whitespace in required identifiers and tab names.

### AR-003 — Production dependency vulnerabilities

- Severity: Medium
- Verification command: `npm audit --omit=dev --json`
- Result:
  - Total 4: moderate 4, high 0, critical 0
  - Direct dependency: `googleapis@144.0.0`
  - Related transitive dependencies: `googleapis-common`, `gaxios`, `uuid`
  - Advisory related to `uuid`: GHSA-w5hq-g745-h8pq
  - The fix suggested by the audit tool is a major upgrade to `googleapis@178.0.0`.
- Impact:
  - The current implementation has no Google adapter, so actual use of the vulnerable path is limited.
  - Once T3 begins actually using `googleapis`, the attack surface will expand.
- Recommendation:
  - Before starting T3, verify upgrade compatibility with the latest `googleapis`.
  - After the major upgrade, perform a typecheck and a read smoke test.
  - Add a production dependency audit to CI or periodic checks.

### AR-004 — Prettier missing from the completion gate

- Severity: Low
- Location: `scripts.check` in `package.json`
- Symptom:
  - `npm run check` runs only typecheck, lint, and test.
  - Prettier is installed as a dev dependency but is not included in the check script or the completion gate.
- Verification command: `npx prettier --check .`
- Result: format mismatches in 7 files
  - `docs/DESIGN.md`
  - `docs/SPEC.md`
  - `docs/TASKS.md`
  - `docs/TESTING.md`
  - `docs/WORKFLOW.md`
  - `README.md`
  - `tests/config.test.ts`
- Impact:
  - Passing `npm run check` does not guarantee the format quality declared by the repository.
  - The formatting of output from different agents could gradually diverge.
- Recommendation:
  - Add a `format:check` script and include it in `check`.
  - Finalize the Markdown format policy before bulk-fixing existing document formatting.

### AR-005 — README does not match actual implementation state

- Severity: Low
- Location: `README.md:25-37`
- Symptom:
  - The status is still shown as "documentation stage (no code written)".
  - In reality, T0~T2 code and tests exist.
  - The quickstart's `npm run dev` appears to run a normal MCP server, but it currently only outputs a "not implemented" notice.
- Impact:
  - New developers and agents may misjudge the current scope of completion and runnability.
- Recommendation:
  - Update the status to "T0~T2 complete, T3 onward not implemented".
  - State in the quickstart that `npm run dev` is a placeholder until T8.

## 3. Verification Results

### Declared completion gate

`npm run check` passes:

- TypeScript typecheck: pass
- ESLint: pass
- Vitest: 3 test files passed
- Test cases: 27 passed, 0 failed

### Coverage

Result of `npm test -- --coverage`:

- `src/core/` statements: 95.12%
- branches: 94.11%
- functions: 100%
- lines: 95.12%

The currently implemented core scope exceeds the 90% target in `docs/SPEC.md`, but this must be re-measured once `template.ts` and `pipeline.ts` are added later.

### Repository hygiene

- Git working tree at the start of the review: clean
- Committed `.env`: none
- `.env`, `data/`, `node_modules/`, `dist/`, `coverage/` in `.gitignore`: normal
- Large fixture recipients: use the RFC 2606 reserved domain `example.invalid`

## 4. Confirmed Strengths

- TypeScript strict and `noUncheckedIndexedAccess` are enabled.
- External inputs — config and fixtures — are validated at the zod boundary.
- `InMemorySheetClient`'s read results are copies, making it difficult for callers to tamper with internal state.
- `writeStatus` validates the batch's target rows first, preventing partial application.
- Responsibility for user data columns and status columns is separated.
- Error messages include the cause of the problem and how to fix it.
- Generation of the 1,000-row fixture is deterministic and blocks the possibility of reaching real email addresses.

## 5. Remediation Priority

1. AR-002's empty filter normalization and regression test
2. AR-003's `googleapis` upgrade review
3. Implementation of T3~T7 core adapters and pipeline
4. Completion of T8~T10 MCP/E2E/smoke
5. AR-004's addition of the format check gate
6. AR-005's README status update

## 6. Tracking Rules

- Subsequent adversarial reviews are added in the same directory in order as `ADVERSARIAL_REVIEW_002.md`, `ADVERSARIAL_REVIEW_003.md`.
- Existing reports are an audit record of the state at that time and must not be overwritten.
- When fixing a finding, link the corresponding ID (e.g., `AR-001`) in the commit or task description.
