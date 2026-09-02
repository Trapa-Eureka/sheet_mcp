# Adversarial Review Report 004 — resolution record

- Target report: `docs/ADVERSARIAL_REVIEW_004.md` (review date 2026-09-02, baseline revision `be2b38f`)
- This document's write date: 2026-09-02
- Principle: `docs/ADVERSARIAL_REVIEW_004.md` is an audit record and is not modified. This document
  records only what was actually fixed for each of AR-019~027 raised by that report, and how it was
  verified.

## Summary

| Item | Severity | Status | Note |
| --- | --- | --- | --- |
| AR-019 | High (release-blocking) | ✅ Resolved | Recovery CLI moved to `src/cli/`, exposed as a second bin |
| AR-020 | High (release-blocking) | ✅ Resolved | Added MIT LICENSE |
| AR-021 | Medium (must-fix before publish) | ✅ Resolved | Normalized `bin` path, 0 publish dry-run warnings |
| AR-022 | Medium | ✅ Resolved | `MAX_PIPELINE_ROWS` cap + returns truncated/totalMatched |
| AR-023 | Medium | ✅ Resolved | Added timeout to Google/Resend calls |
| AR-024 | Medium (blocks marking release complete) | ⏸ Human-only, unresolved | Same item as T10's existing `MANUAL SMOKE PENDING` |
| AR-025 | Low | ✅ Resolved | Enriched package.json metadata |
| AR-026 | Low | ✅ Resolved | Excluded `src/mocks` from the build |
| AR-027 | Low | ✅ Resolved | README now states the docs links are clone-only |

AR-019~023 and 025~027 were all resolved through code/config/doc changes plus measured verification
(below). **Only AR-024 requires a human to perform it with real credentials and cannot be resolved by
code — it is still PENDING** — publish is held until then (`docs/ADVERSARIAL_REVIEW_004.md` §8 tracking
rules).

> **2026-09-02 follow-up update**: the table/paragraph above reflect the state at the time this document
> was written (right after the code fixes). **AR-024 was completed via a real manual smoke test later the
> same day** — see the follow-up note in the "Remaining work" section below, and `docs/TASKS.md` T10.

## Per-item actions and verification

### AR-019 — Recovery script missing from the public package

- Action: moved `scripts/recoverStaleClaim.ts` to `src/cli/recoverStaleClaim.ts` so it is included in
  the `tsconfig.build.json` compile target (`src/`). Added `"sheet-mcp-recover": "dist/cli/recoverStaleClaim.js"`
  to `package.json.bin`, and generalized `scripts/postbuild.mjs` into a `BIN_TARGETS` array so it attaches
  the shebang to `dist/cli/recoverStaleClaim.js` as well as `dist/server.js`. The repo-clone path
  (`npm run recover:stale-claim`) was also updated to point at the new location
  (`src/cli/recoverStaleClaim.ts`). The guidance text in `README.md`/`docs/DESIGN.md` §6 was updated into
  two branches: "clone dev environment → `npm run recover:stale-claim`" and "`npx sheet-mcp` install →
  `npx sheet-mcp-recover`".
- Safeguards preserved: the existing human-only safeguards — dry-run default, rejecting `--older-than-ms`
  under 5 minutes, the `data/recovery-audit.log` audit log, etc. — were only moved along with the file; no
  logic changed, and they remain intact.
- **Full resolution criteria verification (measured)**: after `npm run build`, built an actual tarball
  with `npm pack`, installed it into a separate temp directory with `npm install <tarball>`, and ran
  `./node_modules/.bin/sheet-mcp` and `./node_modules/.bin/sheet-mcp-recover` each with no arguments,
  without devDependencies (`tsx`, TypeScript, etc.). The former produced the expected
  `GOOGLE_SERVICE_ACCOUNT_JSON` fail-fast error (exit 1), as before, and the latter produced the required
  arguments notice (exit 1) — confirming both bins work in an actual installed environment (measured
  verification the same way the symlink bug was caught in T12).

### AR-020 — Missing LICENSE

- Action: added `LICENSE` (MIT, 2026 Trapa-Eureka) to the repository root, and added the
  `"license": "MIT"` field to `package.json`.
- Verification: confirmed that `LICENSE` (1.1kB) is actually included in the `npm pack --dry-run`/`npm pack`
  file listing.

### AR-021 — `npm publish` auto-corrects the `bin` path

- Action: removed the leading `./` from the values in `package.json.bin` to match the canonical form
  suggested by `npm pkg fix` (`dist/server.js`, `dist/cli/recoverStaleClaim.js`).
- Verification: after `npm run build`, running `npm publish --dry-run --json` no longer produces the
  previously seen `"bin[sheet-mcp]" script name ... was invalid and removed` warning (the only remaining
  output is the "login required" notice, which is normal dry-run behavior). Directly confirmed that both
  `dist/server.js` and `dist/cli/recoverStaleClaim.js` have the shebang properly attached.

### AR-022 — Unlimited preview/send row count

- Action: added a `MAX_PIPELINE_ROWS = 1000` constant to `src/core/pipeline.ts`; when the number of
  matched rows after filtering exceeds this, dry-run truncates to the first 1000 rows for the preview and
  reports the actual matched count and whether truncation occurred via `totalMatched`/`truncated`, while
  live **sends nothing at all** and aborts immediately with a clear error (preventing a partial-send
  incident). Added `totalMatched`/`truncated` fields to `PipelineResult`/`pipelineResultShape` (zod).
- Docs: reflected the truncation policy in `docs/DESIGN.md` §4 pipeline flow.
- Verification: added regression tests to `tests/pipeline.test.ts` as part of `npm run check`, confirming
  (a) 1000 rows or fewer are processed in full, (b) dry-run over 1000 rows returns truncated with
  `truncated:true`, and (c) live over 1000 rows throws an error immediately with no side effects at all
  (no `provider.send()`/`claim()`, etc.).

### AR-023 — No timeout on external requests

- Action: added a `withTimeout()` helper and `DEFAULT_GOOGLE_SHEETS_TIMEOUT_MS = 30_000` to
  `src/adapters/googleSheetClient.ts`, wrapping every Sheets API call in `readConfig`/`readRows`/
  `readHeader`/`ensureStatusColumns`/`writeStatus`. `src/adapters/resendProvider.ts` uses the same
  `withTimeout()` + `DEFAULT_RESEND_TIMEOUT_MS = 30_000` pattern, and additionally passes
  `AbortSignal.timeout()` to the actual `fetch` itself to cancel the socket directly (even if a mock fetch
  ignores the signal, the `withTimeout()` race always ends the test). Both are overridable via a
  constructor option (`timeoutMs`), letting tests reproduce a "response that never arrives" situation
  within a short time.
- Policy: a timeout classifies the row as `failed` and safely releases the claim to allow a retry, but the
  Resend timeout error message explicitly carries an uncertainty warning that "the send may have actually
  gone through already — check the dashboard before retrying" (instead of introducing a separate
  `delivery_unknown` status as the report mentioned, the current choice is to surface that fact via the
  error message — a policy decision recorded in `docs/DESIGN.md` §6/§7).
- Verification: added regression tests to `tests/googleSheetClient.test.ts`/`tests/resendProvider.test.ts`
  that inject a never-resolving mock and confirm the call actually ends within the time limit with a clear
  error even with a short `timeoutMs`.

### AR-024 — Real manual smoke test not completed

- **Unresolved (human-only item, cannot be resolved by code)**. `docs/TASKS.md` T10 already explicitly
  marks this as `CODE DONE / MANUAL SMOKE PENDING`, and this report's finding is simply a
  reconfirmation of that existing status. It requires real Google service account permissions + a Resend
  API key/domain + an actual receiving mailbox, which this session (a code agent) cannot perform directly.
- Added a "T13 follow-up" item to `docs/TASKS.md` noting that AR-004's release-blocking/stability items
  have been resolved and only this item remains. `npm publish` is held until this smoke test is complete
  and T10 is promoted to DONE.

### AR-025 — Insufficient package.json metadata

- Action: added `description`, `keywords`, `author`, `repository`, `homepage`, and `bugs` fields (rights
  holder confirmation: used the repository URL based on the commit author's GitHub account
  `Trapa-Eureka` — if the actual public repository URL differs, a human must reconfirm before publish).
- Verification: confirmed the fields are reflected as-is in the `package.json` of the tarball produced by
  `npm pack --dry-run`.

### AR-026 — Unnecessary mocks included in the tarball

- Action: added `"exclude": ["src/mocks"]` to `tsconfig.build.json`. Tests import the `src/mocks/*.ts`
  originals directly via tsx rather than `dist/`, so there is no impact.
- Verification: confirmed that `dist/mocks/*` no longer appears in the `npm pack --dry-run`/`npm pack`
  file listing (direct comparison of the file listing after the build). `npm run check`'s 180 tests still
  pass unchanged (no impact on the test path).

### AR-027 — Distribution README links to docs not present in the tarball

- Action: added a warning paragraph right above the README's documentation map stating that "these
  relative paths are valid only in a clone/on GitHub, and an `npx sheet-mcp` install does not include
  `docs/`." Reason for choosing a warning instead of changing the links themselves to absolute URLs: like
  AR-025, whether the repository is actually up on GitHub yet and what the final URL will be requires
  rights-holder confirmation, so it was not arbitrarily finalized here (same rationale as the AR-025
  note).

## Automated verification gates (2026-09-02, after `npm run build`)

- `npm run check`: TypeScript/ESLint/Prettier/Vitest all passed, **180 tests** (175 at review time → +3
  new regression tests for AR-022 and +2 for AR-023).
- `npm run test:coverage`: confirmed `src/core/**` line coverage target (90%) is maintained.
- `npm audit --omit=dev`: 0 production dependency vulnerabilities (unchanged, no new dependencies added).
- `npm publish --dry-run --json`: 0 auto-correction warnings (confirms AR-021 resolved).
- `npm pack` built an actual tarball → installed into a temp directory → both `sheet-mcp` and
  `sheet-mcp-recover` bins reach the expected fail-fast without devDependencies (measured fulfillment of
  AR-019's full resolution criteria). After verification, the temp directory and tarball were deleted (no
  artifacts left in the repository).

## Remaining work

- ~~**AR-024 / T10 MANUAL SMOKE PENDING**: to be performed by a human with real credentials.**~~
  **2026-09-02 follow-up update: completed.** At the time the "AR-024" section above was written it was
  unresolved, but later the same day a human completed the end-to-end send and duplicate-send-prevention
  test with real Google service account credentials + Resend (test-only address `onboarding@resend.dev`).
  Since this document is an audit record, the body of the AR-024 section above is left as it was at the
  time of writing, and only this follow-up note is added — see `docs/TASKS.md` T10 for the detailed
  record (run date/time, messageId, second-run skipped result).
- **AR-025 metadata's repository URL**: once the actual public repository address is finalized, recheck
  the URL in `package.json`/`README.md`.
- Only once the above two items are settled should the explicit user approval for actually running
  `npm publish` be obtained (`docs/ADVERSARIAL_REVIEW_004.md` §7-10, §8 tracking rules — actual publish is
  not included within the authority granted to modify this document/code).
