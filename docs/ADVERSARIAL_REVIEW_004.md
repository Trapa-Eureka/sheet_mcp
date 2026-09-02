# Adversarial Review Report 004 — npm publish final review

- Review date: 2026-09-02
- Scope: entire source, tests, docs, build, and npm distribution artifacts
- Baseline revision: `be2b38f` (`T13: update installation-method docs (npx sheet-mcp)`)
- Previous final status: `docs/ADVERSARIAL_REVIEW_003_STATUS.md` and the subsequent STATUS GAPS document
- Review method: full static review of the code, doc/implementation cross-check, quality gates/coverage/security audit, secret scanning, `npm pack`/`npm publish --dry-run`, public registry name lookup
- Change principle: this review creates only this new audit record and does not change the product code or existing docs

## 1. Final verdict

**The current revision must not be published to npm.**

The automated verification status of the core functionality is good. Under normal local IPC permissions, all 175 tests passed, core line coverage is 93.36%, and there are 0 production dependency vulnerabilities. The tarball does not include repository secrets, tests, or audit docs, and its size is small. The `npx` symlink entrypoint regression test also passes.

However, release-blocking defects were found in the public package contract and operational stability.

1. The public tarball does not contain the stale-claim recovery script, yet package.json and README declare that they provide that command.
2. There is no LICENSE defining public usage rights.
3. `npm publish --dry-run` emits a warning that auto-corrects the `bin` path, meaning the deployment metadata is not normalized.
4. The preview/live pipeline loads the entire data tab and full detail results into memory with no row-count ceiling.
5. External calls to Google/Resend have no timeout, so a single request can hold a batch and its claim for an extended period.
6. The manual smoke test against a real Google Sheet + Resend is still PENDING.

No explicit memory leak in the form of permanently retained objects was found. Instead, there is an unbounded-resource-usage risk from unlimited input size and unlimited external request duration.

## 2. Release-blocking findings

### AR-019 — npm scripts in the public package reference files/devDependencies that do not exist

- Severity: High (release-blocking)
- Location:
  - `dev`, `smoke`, `recover:stale-claim`, `check`, `build` scripts in `package.json`
  - `files` in `package.json`
  - `README.md:66-76`
- tarball evidence:
  - Only `dist/`, `.env.example`, README, and package.json are included.
  - `scripts/recoverStaleClaim.ts`, `scripts/smoke.ts`, `src/`, `tests/`, and the tsconfig files are not included.
  - `tsx`, TypeScript, Vitest, and ESLint are devDependencies, so they are not installed as dependencies for an ordinary consumer.
- Symptom:
  - In the public package, `npm run recover:stale-claim` tries to run `tsx scripts/recoverStaleClaim.ts`, but neither exists.
  - `npm run smoke` and `npm run dev` are likewise broken for the same reason.
  - `npm run check`/`build` also cannot run because tests, src, tsconfig, and dev tools are missing.
  - In particular, since the README presents stale-claim recovery as the official operational procedure, this is not merely a dev-convenience issue.
- Impact:
  - npx users cannot recover a leftover claim via the official procedure after a process crash or release failure.
  - On failure, a row can remain permanently stuck at `skipped_duplicate`.
  - The public package contract is broken because the commands package.json declares it provides differ from what is actually installed.
- Recommendation:
  1. Include the recovery script in the TypeScript build target so it ships as `dist/recoverStaleClaim.js`.
  2. Expose it via a separate bin (e.g. `sheet-mcp-recover`) or a pure Node-based npm script.
  3. Keep the same human-only dry-run/confirm/audit-log safeguards in the distributed package.
  4. Remove dev-only scripts that will not be supported in the public package from the distribution package.json, or use a separate publish manifest.
  5. Install the actual tarball into a fresh temp directory and verify both the server bin and the recovery bin.
- Full resolution criteria:
  - `sheet-mcp` and the recovery command run in a tarball-installed environment without devDependencies.
  - The recovery command's default run is read-only and does not modify the DB without confirm.
  - Every remaining user-facing script in package.json works in the actual installed package.

### AR-020 — Missing LICENSE leaves public usage/modification/distribution rights undefined

- Severity: High (public release-blocking)
- Location: repository root and `package.json`
- Symptom:
  - There is no `LICENSE`/`LICENSE.md` file.
  - package.json has no `license` field either.
  - The npm tarball does not include a license document.
- Impact:
  - Being downloadable from public npm does not automatically grant rights to use, copy, modify, or redistribute.
  - Legal/security review at consuming organizations may reject the package.
  - If the project intended to be open source, that intent is not legally expressed.
- Recommendation:
  - The rights holder explicitly decides on MIT, Apache-2.0, or a policy of their choosing.
  - Put the SPDX identifier in `package.json.license` and add the matching LICENSE text at the root.
  - Verify with `npm pack --dry-run` that LICENSE is automatically included.
- Full resolution criteria:
  - A license explicitly chosen by the rights holder is consistent between package.json and LICENSE.
  - LICENSE is included in the final tarball.

### AR-021 — npm publish auto-corrects the `bin` metadata

- Severity: Medium (must-fix before publish)
- Location: `bin.sheet-mcp` in `package.json`
- Reproduction command: `npm publish --dry-run --json`
- Actual warning:

```text
npm auto-corrected some errors in your package.json
"bin[sheet-mcp]" script name dist/server.js was invalid and removed
```

- Additional findings:
  - `npm pkg fix` normalized `./dist/server.js` to `dist/server.js`.
  - The current tarball's `dist/server.js` file mode is 0644, and the shebang exists after the build.
  - In the earlier local install verification it ran via the bin link npm created, but relying on publish-time auto-correction makes it hard to predict the final manifest.
- Impact:
  - Normalization differences across npm versions could cause the actual published package's bin registration to differ from what was intended.
  - This conflicts with the T12 verdict that the project was "publish-ready with just one click."
- Recommendation:
  - Apply the canonical form (`dist/server.js`) suggested by `npm pkg fix` directly to the source package.json.
  - Consider explicitly guaranteeing execute permission in postbuild, not just the shebang.
  - After the fix, confirm 0 auto-correction warnings in publish dry-run.
  - Re-verify by installing the dry-run result manifest or the actual tarball and running `.bin/sheet-mcp`.
- Full resolution criteria:
  - `npm publish --dry-run` shows no package.json auto-correction warnings.
  - In a fresh temp install environment, `npx --package=<tarball> sheet-mcp` reaches the expected fail-fast or MCP startup.

## 3. Operational stability findings

### AR-022 — preview/send loads the entire data tab and all detail results into unbounded memory

- Severity: Medium
- Location:
  - `src/adapters/googleSheetClient.ts:177-195`
  - `src/core/pipeline.ts:122-167`
  - `src/server.ts:64-110`
- Symptom:
  - GoogleSheetClient `readRows()` fetches the entire tab range at once and converts every row into an object.
  - `preview_messages` and `send_notifications` build workingRows and details for the entire filtered result.
  - Each detail includes the recipient, the rendered subject, body, and error.
  - The response builds the same payload as both a JSON string `content` and `structuredContent`, so large data can end up resident twice.
  - Only `read_rows` truncates the returned rows to 200; the actual Google API read itself, and preview/send, have no ceiling.
- Impact:
  - On a large sheet, or one where an entire column was used by mistake, this can cause a memory spike, long GC pauses, MCP message size overruns, or process OOM.
  - This is not a classic permanent memory leak, but it is an unbounded resource-consumption path that grows without limit in proportion to call input.
  - In live mode, this can also lead to an operational incident of sending to an extremely large number of customers at once.
- Recommendation:
  1. Add an explicit `maxRows` in config or tool input, and enforce a conservative default/absolute ceiling.
  2. Require live sends to reconfirm a batch token or expected row count generated from preview.
  3. Read and process the sheet in pages/ranges, and chunk the write-back as well.
  4. Cap the MCP response details and return total/truncated.
  5. Measure peak RSS and response size under large-scale testing.
- Full resolution criteria:
  - Sending safely aborts before dispatch when the configured maximum row count is exceeded.
  - The preview/send response does not grow past a bounded size.
  - Memory ceiling and chunking behavior are tested against a large sheet.

### AR-023 — External requests to Google/Resend have no timeout or cancellation

- Severity: Medium
- Location:
  - `src/adapters/resendProvider.ts:56-79`
  - all API calls in `src/adapters/googleSheetClient.ts`
- Symptom:
  - The Resend fetch has no `AbortSignal` or timeout.
  - Google API calls also have no explicit timeout/abort policy.
  - The pipeline sends rows sequentially, so if one row's request never completes, all subsequent rows never proceed.
  - Because the claim is created before the Provider call, that row remains claimed until forcibly killed.
- Impact:
  - Network half-open conditions, DNS/TLS delays, or long internal SDK retries can cause an MCP call to wait indefinitely or excessively long.
  - Long-lived requests and pending Promises continue to hold memory/sockets, and the operator may have to perform stale-claim recovery.
- Recommendation:
  - Add `AbortSignal.timeout()` or an injectable timeout to the Resend fetch.
  - Set a consistent timeout on Google client requests as well.
  - Classify a timeout as row-level failed and safely release the claim, but separately consider a `delivery_unknown` policy for ambiguous timeouts where the Provider may have actually processed the request.
  - Design a lifecycle that can cancel in-flight requests on server shutdown.
- Full resolution criteria:
  - A never-resolving mock fetch/API test finishes within a time limit.
  - Subsequent rows either continue processing or follow a specified batch-abort policy.
  - The safe resend policy after a timeout is documented.

### AR-024 — Manual smoke test against real Google Sheet + Resend not completed

- Severity: Medium (blocks marking the release as complete)
- Location: `docs/TASKS.md` T10, `docs/SPEC.md` §5
- Symptom:
  - T10's status is `CODE DONE / MANUAL SMOKE PENDING`.
  - Real Google permissions, the Resend domain/API, actual email receipt, sheet write-back, and duplicate-prevention on a second run have not been verified.
- Impact:
  - Real API/permission/plan/domain issues that local mock/contract tests cannot catch could be exposed to the very first npm users.
- Recommendation and completion criteria:
  - Perform the existing STATUS-GAP-005's 7-step real smoke test, leave secret-free audit evidence, then publish.

## 4. Deployment quality improvement items

### AR-025 — Public package metadata is too sparse

- Severity: Low
- Location: `package.json`
- Missing items:
  - `description`
  - `keywords`
  - `repository`
  - `homepage`
  - `bugs`
  - `author` or a maintainers policy
  - `license` (AR-020 is a separate blocking item)
- Impact:
  - Makes npm search, trust, issue reporting, and source verification difficult.
  - Users have difficulty confirming the official repository and maintainer.
- Recommendation:
  - Once the rights holder confirms the actual public repository URL and maintainer information, fill these in.

### AR-026 — tarball includes mocks that are not used at runtime

- Severity: Low
- Location: `tsconfig.build.json`, `files` in package.json
- Symptom:
  - The entire `src` is compiled, so the four `dist/mocks/*` files are also included in the public tarball.
  - The server runtime does not import these files.
- Impact:
  - Currently only about 16KB, so the performance impact is small.
  - Test tooling that is not a public API is included in the distribution surface, which makes the support scope ambiguous.
- Recommendation:
  - Narrow the build include or publish files to runtime modules only, or, if there is intent to officially export mocks, explicitly define exports and a support policy.

### AR-027 — The distribution README links to repository docs not present in the tarball

- Severity: Low
- Location: `README.md` documentation map and operational guidance
- Symptom:
  - The npm tarball has no docs directory, but the README guides readers to relative paths such as `docs/DESIGN.md`, `docs/SPEC.md`, `docs/TASKS.md`.
- Impact:
  - Links are broken or content cannot be found from the npm package page or install directory.
- Recommendation:
  - Link with absolute URLs to the public repository, or include only the docs essential to users in the tarball.

## 5. Verification results

### Automated quality gates

`npm run check` under normal local IPC permissions:

- TypeScript typecheck: passed
- ESLint: passed
- Prettier: passed
- Vitest: 14 test files, 175 tests passed

Under a restricted sandbox, `tsx` could not create a Unix socket, so the e2e/symlink tests failed with `EPERM`, but they all passed when rerun with normal permissions. This is a review-environment constraint, not a product defect.

### Coverage

`npm run test:coverage`:

| Scope | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| all of `src/core/**` | 93.36% | 83.01% | 100% | 93.36% |
| `pipeline.ts` | 91.63% | 77.63% | 100% | 91.63% |

The 90% line target is met. However, adapters, the entrypoint, and the recovery script are not counted in coverage.

### Production dependency security

`npm audit --omit=dev --json`:

- Vulnerabilities: 0
- Production dependencies: 190
- high/critical: 0

### npm distribution artifacts

`npm pack --dry-run --json`:

- tarball: `sheet-mcp-0.1.0.tgz`
- Packed size: 30,525 bytes
- Unpacked size: 94,252 bytes
- File count: 19
- Included: README, `.env.example`, package.json, `dist/**`
- Exclusion confirmed: src, tests, docs audit documents, fixtures, an actual `.env`, service account keys
- Secret pattern scan: no actual keys/private key files found

`npm publish --dry-run --json`:

- prepublishOnly → check → build → prepack → build ran
- No actual publish performed
- package.json bin auto-correction warning occurred (AR-021)
- The "npm login required" notice is normal dry-run behavior

### Public name lookup

`npm view sheet-mcp ...` returned 404 as of 2026-09-02. This means no public package is currently found under that name, but it does not guarantee the name will still be available at the actual publish time.

## 6. Memory/resource leak verdict

- Not found:
  - Production code that permanently accumulates request results into a global array/Map
  - A path that adds a process event listener on every call (main does so once)
  - A path where SQLite handles are not closed on normal shutdown
- Residual risk:
  - Unlimited row/response memory from AR-022
  - Unlimited external request wait and socket/Promise occupation from AR-023
  - SendLog itself has pagination and a limit, so single-query memory is bounded
- Conclusion: no classic leak was reproduced, but long-term operational stability cannot be guaranteed due to unbounded resource usage.

## 7. Required action order before publish

1. AR-019: align the server/recovery command contract in the distribution with the actual tarball.
2. AR-020: have the rights holder decide on a license and reflect it in LICENSE/package.json.
3. AR-021: normalize the npm manifest and remove the publish dry-run warnings.
4. AR-022: add a max row count and response ceiling for live/preview.
5. AR-023: add external-request timeouts and an uncertain-send policy.
6. AR-024: complete the real Google Sheet + Resend smoke test.
7. AR-025~027: clean up public metadata, doc links, and unnecessary distribution files.
8. Install the final tarball into an empty temp project and verify `npx sheet-mcp` and the recovery command.
9. Rerun `npm publish --dry-run` and `npm audit --omit=dev`.
10. Only after that, perform the actual `npm publish` with a separate, explicit user approval.

## 8. Tracking rules

- The next review/resolution record is added as a separate file and does not overwrite the existing audit document.
- Link fix commits and test names to AR-019~027.
- Do not mark this as npm-publish-ready until AR-019~024 are resolved.
- Actual `npm publish` is a public state change and is not included within the authority granted to write this document or modify code.
