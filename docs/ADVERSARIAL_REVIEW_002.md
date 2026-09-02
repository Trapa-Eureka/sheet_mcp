# Adversarial Review Report 002

- Review date: 2026-09-01
- Target: T3 `GoogleSheetClient`, T4 template engine, T5 notification provider, and their integration impact on existing code
- Baseline revision: `b823a2d` (`login-flow`)
- Previous report: `docs/ADVERSARIAL_REVIEW_001.md`
- Review method: cross-checking design, tasks, implementation, and tests; reproducing boundary values; running quality gates, coverage, and dependency audit
- Change policy: product code and existing documentation were not modified during the review

## 1. Overall Assessment

The stated completion criteria for T3~T5 and `npm run check` were satisfied. The Google service account key is validated at the boundary, Resend is tested without network access via an injected mock fetch, and the template engine and provider tests also cover the basic success and failure paths. The config blank-value, dependency vulnerability, and Prettier gate issues raised in the previous review have also been resolved.

However, from a release standpoint, 5 new issues were identified that require blocking or upfront fixes. In particular, the template key syntax is narrower than the sheet header contract documented in the design, so some placeholders are not even detected as missing — and if the T7 pipeline is implemented in this state, un-substituted text could be sent to customers.

## 2. New Findings

### AR-006 — Common sheet headers are not recognized as template keys, bypassing missing-value detection

- Severity: High
- Location: `src/core/template.ts:6-7`
- Basis:
  - The regular expression restricts keys to `[A-Za-z0-9_]+`.
  - `docs/DESIGN.md` stipulates that header names are template variable names, but does not restrict them to ASCII alphanumerics and underscores.
  - Actual Google Sheets headers can contain Korean, Tagalog characters, spaces, hyphens, and more.
- Repro:

```ts
renderTemplate("{{고객명}} / {{customer-name}}", {
  고객명: "홍길동",
  "customer-name": "A",
});
```

Actual result:

```json
{ "text": "{{고객명}} / {{customer-name}}", "missing": [] }
```

- Impact:
  - Even when substitution fails, `missing` is empty, so T7's per-row failure handling does not kick in.
  - An un-substituted placeholder is treated as a normal message and could be sent to the customer as-is.
  - The documented contract and the actual accepted syntax differ.
- Recommendation:
  - Parse the key between `{{` and `}}` broadly per the documented rule, trimming only leading/trailing whitespace.
  - Alternatively, if allowed keys are to be restricted to ASCII identifiers, first change `DESIGN.md` and the config/header validation to reject such keys at the boundary.
  - Add tests for Korean keys, hyphenated keys, keys containing spaces, and non-ASCII missing keys.
  - Fix before starting T7.

### AR-007 — Google Sheets tab names are not quoted per A1 notation

- Severity: Medium
- Location: `src/adapters/googleSheetClient.ts:120-125`, `141-149`, `160-165`, `195-217`
- Basis:
  - Tab names are directly concatenated in forms such as `range: tab`, `` `${tab}!1:1` ``, and `` `${tab}!A2` ``.
  - In A1 notation, sheet names containing spaces, single quotes, or special characters require single-quote quoting and internal single-quote escaping.
- Impact:
  - Reads or status writes could fail on common tab names such as `Customer Data`, `미수금 고객`, or `Jin's Sheet`.
  - Since config's `data_tab` is external input, ambiguity also arises when combined with range syntax.
- Recommendation:
  - Route all tab names through a single A1-quoting function. Escape internal `'` as `''`.
  - Ensure reads, header lookup, status column creation, and batch update all use the same function.
  - Verify the request range against a mock API for tab names containing spaces, single quotes, and `!`.

### AR-008 — The Google write path is marked complete but unverified

- Severity: Medium
- Location: `src/adapters/googleSheetClient.ts:154-225`, `scripts/smoke.ts:23-38`
- Basis:
  - `ensureStatusColumns` and `writeStatus` are the core paths that modify the actual user sheet.
  - T3 has zero tests for the Google adapter.
  - The current smoke script only calls `readConfig` and `readRows` and does not verify either write method.
- Impact:
  - Regressions in column-index calculation, range quoting, preservation of unaffected fields, or batchUpdate request shape all pass both typecheck and the current smoke test.
  - The core safeguard that "user data columns must never be modified" is not backed by an executable verification in the actual adapter.
- Verdict:
  - `docs/TASKS.md` avoided writing tests on the grounds that network tests are prohibited, but this does not mean unit tests based on a mock API or an injection boundary should also be prohibited.
- Recommendation:
  - Make the Sheets API object or call function injectable and write network-free contract tests.
  - At minimum, verify the generated range and request body, that missing fields are not written, and that no call occurs for empty updates.
  - If writes are to be verified via manual smoke, specify a test-only sheet and a recovery procedure, and require explicit confirm.

### AR-009 — T3 smoke may expose entire real customer rows in logs

- Severity: Medium
- Location: `scripts/smoke.ts:38`
- Symptom:
  - The entire first row of the actual sheet is output via `console.log`.
- Impact:
  - Personal and business information such as names, emails, receivables, due dates, and notes may remain in terminal history, CI captures, and session logs.
  - Smoke is human-only, but since it is designed to use the actual sheet, the risk is real.
- Recommendation:
  - Limit default output to non-sensitive metadata such as row count, column names, and rowIndex.
  - Allow output of actual values only behind a separate, explicit debug flag, and mask sensitive columns.

### AR-010 — README progress status has fallen behind again

- Severity: Low
- Location: README status section
- Symptom:
  - README records T0~T2 as complete and T3 onward as TODO.
  - The actual `docs/TASKS.md` and Git history show T3~T5 as complete.
- Impact:
  - New developers or agents may misjudge the implementation scope and the next task to start.
- Recommendation:
  - Update the status to T0~T5 complete, T6 onward TODO.
  - Also consider making `docs/TASKS.md` the sole source of truth instead of a manually maintained status string.

## 3. Tracking of Previous Report

| Existing ID | Status | Verification Result |
| --- | --- | --- |
| AR-001 | In progress | T3~T5 complete. T6~T10 are still TODO, so it is not a runnable MCP product |
| AR-002 | Resolved | Blank optional filter values are normalized to `undefined`, and a regression test has been added |
| AR-003 | Resolved | `googleapis` has been updated to 178, and `npm audit --omit=dev` shows 0 vulnerabilities |
| AR-004 | Resolved | `format:check` is included in `npm run check` and currently passes |
| AR-005 | Follow-up finding, recurring in nature | The status text at that time was fixed, but has gone stale again after T3~T5 completion. Tracked as AR-010 |

## 4. Verification Results

### Quality gates

`npm run check` passes:

- TypeScript typecheck: pass
- ESLint: pass
- Prettier format check: pass
- Vitest: 7 test files passed
- Test cases: 55 passed, 0 failed
- Signs of actual network calls during test execution: none

### Coverage

Result of `npm test -- --coverage`:

- `src/core/` statements: 96.07%
- branches: 96%
- functions: 100%
- lines: 96.07%
- `template.ts`: 100%

Note: the coverage configuration includes only `src/core/**`, so adapter coverage for `GoogleSheetClient`, `ResendEmailProvider`, etc. is not reflected in the figures above.

### Dependency security

Result of `npm audit --omit=dev --json`:

- Total vulnerabilities: 0
- Production dependencies: 189
- high/critical: 0

### Repository status

- Git working tree at the start of the review: clean
- Baseline commit: `b823a2d`
- No product code changes made during the review

## 5. Confirmed Strengths

- The service account key file is validated for required fields via zod, and errors include how to fix them.
- No service account JSON or API key is hardcoded in the repository.
- Resend fetch is injected, blocking actual network access in tests.
- Resend's HTTP failures, network failures, abnormal success responses, and channel mismatches are all handled as failure results.
- The SMS stub provides v0.2 and Sender ID guidance immediately upon creation.
- `$&`, `$1`, and `$$` in template substitution values are inserted as-is without special handling.
- Deduplication of missing keys and substitution of Unicode values behave deterministically.
- The Google status write implements the contract that a cell is not written when an optional field is `undefined`.

## 6. Remediation Priority

1. AR-006 fix the template key contract and add regression tests
2. AR-007 unify A1 tab-name quoting
3. AR-008 add mock contract tests for the Google write path
4. AR-009 minimize and mask smoke output
5. AR-010 update README status
6. Proceed with T6, T7 after the above fixes

## 7. Tracking Rules

- The next adversarial review is recorded as `docs/ADVERSARIAL_REVIEW_003.md`.
- Existing reports are an audit record of the state at that time and must not be overwritten.
- Link the finding ID (e.g., `AR-006`) in the fix commit or task description.
