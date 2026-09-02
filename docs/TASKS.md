# TASKS — sheet_mcp v0.1 backlog

## Usage

- One agent session = one task. Prompt template:
  > Read `docs/SPEC.md`, `docs/DESIGN.md`, `docs/TESTING.md`, then do **T4**. Keep fixing it yourself until every completion criterion is met and `npm run check` passes. When done, summarize the changed files and verification results.
- Every completion criterion must be **executably verifiable**. An agent must be able to self-judge without human confirmation.
- On completion, update the status to `DONE(date)` and commit (`T{n}: summary`).
- Parallel lanes: once T1 is done, **lanes A/B/C/D can proceed concurrently with different agents (git worktrees)**.

Dependency graph: `T0 → T1 → {A: T2→T3, B: T4, C: T5, D: T6} → T7 → T8 → {T9, T10}`

---

### T0 — Project scaffolding · Status: DONE(2026-09-01)

- Goal: TS strict + ESLint + Prettier + Vitest + the full set of scripts. `src/` should have only an empty entrypoint.
- Output: `package.json` (scripts: check/test/test:watch/typecheck/lint/dev/smoke), `tsconfig.json` (strict, noUncheckedIndexedAccess), `.eslintrc` family, `vitest.config.ts`, `.env.example`, `.gitignore` (.env, data/)
- Completion criteria: [ ] `npm run check` passes [ ] 1 dummy test runs [ ] `git init` + first commit

### T1 — Domain types + config parser · Status: DONE(2026-09-01) · Depends on: T0

- Goal: put the full DESIGN §3 interface set in `src/core/types.ts`, and the `notify_config` zod parser in `src/core/config.ts`.
- Completion criteria: [ ] error messages **containing how to fix it** for missing required keys / `channel=sms` (CLAUDE.md convention) [ ] `tests/config.test.ts` — 1 success case, 4+ error cases [ ] check passes

### T2 (lane A) — InMemorySheetClient + fixtures · Status: DONE(2026-09-01, incorporates codex adversarial review) · Depends on: T1

- Goal: a SheetClient mock implementation + `fixtures/sheets/collections.json` (SPEC §4-3, mixed-Tagalog values, ~12 rows) + a generator script for `fixtures/sheets/large-1000.json`.
- Completion criteria: [ ] ensureStatusColumns/writeStatus are reflected in memory and re-readable [ ] `tests/inMemorySheetClient.test.ts` [ ] check passes

### T3 (lane A) — GoogleSheetClient adapter · Status: DONE(2026-09-01, incorporates ADVERSARIAL_REVIEW_002) · Depends on: T2

- Goal: a googleapis service-account implementation. **Do not write tests that hit the real network** — verify via the smoke test instead.
  (Clarified after AR-008: this does not mean the Sheets API call surface can't be made injectable for network-free mock contract tests — see `tests/googleSheetClient.test.ts`.)
- Completion criteria: [ ] satisfies the SheetClient contract (typecheck) [ ] the read path is usable from `scripts/smoke.ts` [ ] no hardcoded secrets [ ] check passes

### T4 (lane B) — Template engine · Status: DONE(2026-09-01, incorporates ADVERSARIAL_REVIEW_002) · Depends on: T1

- Goal: a pure `renderTemplate` function (DESIGN §3). Missing keys return a `missing[]` array instead of throwing.
- Completion criteria: [ ] `tests/template.test.ts` with 8+ cases covering substitution/missing values/no-escaping-needed confirmation/Unicode cases [ ] check passes

### T5 (lane C) — NotificationProvider + adapters · Status: DONE(2026-09-01) · Depends on: T1

- Goal: `MockNotificationProvider` (with injectable `failFor`), `ResendEmailProvider` (single fetch call), a `SemaphoreSmsProvider` stub (throws a guidance error on construction).
- Completion criteria: [ ] tests for the mock's recording/failure injection [ ] the Resend adapter is tested for request shape using an **injected mock fetch** [ ] check passes

### T6 (lane D) — SendLog · Status: DONE(2026-09-01) · Depends on: T1

- Goal: `InMemorySendLog` + `SqliteSendLog` (better-sqlite3, the unique key is defined in DESIGN §6).
- Completion criteria: [ ] wasSent/record/list tested against a temp file DB (file I/O is allowed, it's not network) [ ] a unique-constraint conflict is explicitly handled, not silently ignored [ ] check passes

### T7 — SendPipeline · Status: DONE(2026-09-01) · Depends on: T2, T4, T5, T6

- Goal: implement the 8-step flow from DESIGN §4.
- Completion criteria: [x] **all 12 items of the TESTING §4 checklist** pass via `tests/pipeline.test.ts` [x] check passes

### T8 — MCP server · Status: DONE(2026-09-01) · Depends on: T7

- Goal: register the 4 tools (DESIGN §5), the dual safeguard (SEND_MODE + confirm), commit `.mcp.json`.
- Completion criteria: [x] zod schemas for tool input/output [x] no business logic in server.ts (wiring only) [x] boot confirmed via `npm run dev` [x] check passes

### T9 — e2e-mock + coverage · Status: DONE(2026-09-01) · Depends on: T8

- Goal: an e2e test that calls all 4 stdio-server tools via an MCP client (SDK). A coverage report.
- Completion criteria: [x] the preview → send (dry_run mode) → get_send_log scenario passes [x] core coverage ≥ 90% report attached [x] check passes
- Coverage report (`npm run test:coverage`, 2026-09-01): All files 94.15% stmts / 93.18% branch / 100% funcs / 94.15% lines.
  The shortfall lines are all "internal error (bug report)" defensive guards (config.ts's required(), pipeline.ts's finalizeStatus/toStatusUpdate) that are unreachable in normal flow, so they were deliberately left untested.

### T10 — Smoke script + docs update · Status: DONE(2026-09-02, live smoke test complete) · Depends on: T8

- Goal: `scripts/smoke.ts` (1 real sheet, 1 real email, honoring the live gate), update the README quickstart with real commands, describe the example sheet template.
- Completion criteria: [x] smoke prints a preview with no sending in dry_run [x] the human setup procedure fits in 5 lines or fewer in the README [x] check passes
- `scripts/smoke.ts` now wires up `core/pipeline.ts`'s SendPipeline with real adapters and runs the full flow: a dry-run preview, then (only when `SEND_MODE=live && SMOKE_CONFIRM_SEND=1` and the target is exactly 1 row) an actual send.
  If 2 or more rows are targeted, it aborts to prevent accidentally sending to multiple people.
  This could not be run directly in this environment without real Google/Resend credentials (a human-only manual smoke test), so the same branching logic was reproduced in a temporary mock-based script and verified across 5 scenarios (baseline / SEND_MODE only / confirm only / 2 target rows / both conditions met), then deleted.
- **Real manual smoke test completion record** (the real end-to-end Google Sheets + Resend verification required by docs/ADVERSARIAL_REVIEW_003.md AR-016 / AR-024 / STATUS-GAP-005):
  - Run date: 2026-09-02
  - Test sheet: 1 human-owned Google Sheet (anonymized, sheet ID kept private), configured with `notify_config` + `customers` tabs, 1 data row
  - Sender: Resend's test-only address `onboarding@resend.dev` (domain unverified — Resend itself restricts this address to sending only to the account owner's own email, so the recipient was set to the account owner's email to verify. Before switching to real production use, this must be replaced with a verified own domain, see `docs/DESIGN.md` §8-B)
  - 1st run (`SEND_MODE=live SMOKE_CONFIRM_SEND=1 npm run smoke`): `sent=1 failed=0`,
    messageId=`57d32e8d-f371-4374-a753-296237110603`. Confirmed the sheet's status columns (`_send_status=sent`,
    `_sent_at`, `_message_id`, `_error=""`) were written back correctly.
  - 2nd run (re-running the same command): `sent=0 failed=0 skipped=1` (`skipped_duplicate`) — **confirmed
    zero duplicate sends** (the key success criterion in SPEC §5).
  - Removed the `[PENDING]` marker from `docs/SPEC.md` §5 — all v0.1 success criteria are now met.

---

## npm package distribution prep (T11–T13, `npx sheet-mcp`)

- Background: right now, using this requires cloning the repo and running `npx tsx src/server.ts` (DESIGN §8). Using it without cloning, like `npx sheet-mcp`, requires build output + package metadata.
- **Running `npm publish` itself is not part of these three tasks** — exposing source to the public registry is a hard-to-reverse action, so it only happens after a separate, explicit approval. T11–T13's goal is to get to a state where "publish" is the only remaining step.
- Get human confirmation after each task completes, before moving to the next (session rule — no automatic continuation).
- Dependency graph: `T10 → T11 → T12 → T13`

### T11 — Build pipeline · Status: DONE(2026-09-01) · Depends on: T10

- Goal: add a `tsc`-based build script that compiles `src/` into plain JS in `dist/`. The distributed package must run via `node dist/server.js` alone, with no `tsx`/devDependencies.
- Completion criteria:
  [x] `tsconfig.build.json` (or an equivalent config) sets `outDir` to `dist/`, test files excluded from the build
  [x] added the `npm run build` script
  [x] the built `dist/server.js` has a `#!/usr/bin/env node` shebang at the top
  [x] running `node dist/server.js` without `.env` produces the same fail-fast error as `tsx src/server.ts` (behavioral equivalence confirmed)
  [x] `npm run check` passes (the existing vitest suite still targets `src/` — unchanged)
- `tsconfig.build.json` extends `tsconfig.json` and only overrides `noEmit:false`/`outDir:dist`/`rootDir:src` —
  narrowing `include` to `["src"]` excludes tests/scripts from compilation entirely.
  `scripts/postbuild.mjs` (plain Node ESM, runs without tsx) prepends the shebang to `dist/server.js`
  (tsc doesn't preserve shebangs). Ran `node dist/server.js` and `npx tsx src/server.ts` each without `.env` and
  confirmed they produce the exact same error message and exit code (`GOOGLE_SERVICE_ACCOUNT_JSON environment variable is missing...`,
  exit 1) — manually verified behavioral equivalence.

### T12 — Distribution metadata + local package verification · Status: DONE(2026-09-01) · Depends on: T11

- Goal: clean up `package.json` into an npm-publishable shape, and actually build a tarball to verify it installs and runs via `npx` locally.
- Completion criteria:
  [x] removed `"private": true`
  [x] added `"bin": {"sheet-mcp": "./dist/server.js"}`
  [x] restricted `"files"` to what should ship — `dist/`, `.env.example`, etc. (src/tests/docs excluded)
  [x] wired `"prepublishOnly"` to run `npm run check && npm run build`
  [x] built a tarball with `npm pack` and installed it in a separate temp directory via `npm install -g <tarball>` or
  `npx <tarball path>` to confirm the MCP server actually boots (fails fast without credentials)
  [x] `npm run check` passes
- Also added `"prepack": "npm run build"` (not in the completion criteria, but ensures `dist/` is
  automatically rebuilt to the latest state even when `npm pack` is run alone — without it, `npm pack`
  would risk packaging a stale `dist/`, since `prepublishOnly` only runs on `npm publish`, not `npm pack`).
- **A serious bug was found and fixed during re-verification**: while verifying with a real `npm pack` → `npm install <tarball>` → `./node_modules/.bin/sheet-mcp`
  run, the server was found to **exit silently with code 0, with no output and no error at all**.
  The cause was the entrypoint guard in `src/server.ts`, `process.argv[1] === fileURLToPath(import.meta.url)`
  — the executable npm creates for a `bin` field is not a real file but a symlink, and the Node ESM loader
  always resolves `import.meta.url` to the real file's realpath, while `process.argv[1]` keeps the
  symlink path used to invoke it — so the two values could never be equal. As a result, `main()` was never called at all.
  Every npm-created execution path — `npx sheet-mcp`, running after a global install, etc. — hit this issue,
  making this **a bug that undermined the entire goal of T11–T13 (using it via npx without cloning) by itself**.
  Fixed by resolving the symlink with `realpathSync(process.argv[1])` before comparing, and added
  `tests/serverEntrypointSymlink.test.ts` (new — reproduces the same situation via `tsx` + a symlink, without
  building `dist/`) as a regression guard — also confirmed this test actually fails when reverted to the pre-fix code.
- Final verification: confirmed that both a real `npm pack` → `npm install <tarball>` (local) → `./node_modules/.bin/sheet-mcp`
  run and an `npx --package=<tarball> sheet-mcp` run return the exact same fail-fast error and exit code 1 without
  credentials as `node dist/server.js`/`tsx src/server.ts` do. `npm run check` passes all 175 tests
  (174 existing + 1 new regression guard).

### T13 — Update installation-method docs · Status: DONE(2026-09-01) · Depends on: T12

- Goal: reflect the `npx sheet-mcp` install path in `CLAUDE.md`/`docs/DESIGN.md` §8/`README.md` (guardrail
  5: update docs before/alongside a design change). Keep the existing "clone the repo" path valid too, so both remain documented.
- Completion criteria:
  [x] added a `claude mcp add sheet-mcp -- npx -y sheet-mcp` example to `docs/DESIGN.md` §8 (alongside
  the existing clone-based method, with a one-line note on when to use which)
  [x] reflected the npx install path in `README.md`'s quickstart/setup procedure
  [x] added a one-line note on the distribution method (build + npm) to `CLAUDE.md`'s stack section
  [x] clearly noted in both docs that `npm publish` had not yet run, and that `npx sheet-mcp` would not
  work until then (docs must not describe a not-yet-available feature as if it existed)
  [x] check passes
- Split `docs/DESIGN.md` §8 into two sections, A (clone the repo, for development/contribution) and
  B (`npx sheet-mcp`, use without cloning), and put a clear "doesn't work yet, pre-publish" warning
  in section B. Left README.md's existing 5-step "Setup Procedure" as-is (to keep T10's completion
  criterion of "5 lines or fewer"), and added the same npx-path warning as a separate paragraph below it.
  Added one line to `CLAUDE.md`'s stack section plus `npm run build` to the commands section and a
  Pruning Log entry. All of T11–T13 was still pre-`npm publish` prep at this point, so the actual
  publish was deferred to a later, separately user-approved step.

### T13 follow-up — Adversarial Review 004 (final pre-publish review) addressed · Status: DONE(2026-09-02)

- `docs/ADVERSARIAL_REVIEW_004.md` (AR-019–027, as of `be2b38f`) ruled that "the current revision must not
  be published." 3 release-blocking findings (AR-019–021), 2 operational-stability findings (AR-022–023), and 3
  quality-improvement findings (AR-025–027) were all resolved in code — see `docs/ADVERSARIAL_REVIEW_004_RESOLUTION.md`
  for details and verification evidence.
- **AR-024 (real Google Sheets + Resend manual smoke test) was also completed on 2026-09-02** — see the detailed
  record under T10. All of the "required steps before publish" from `docs/ADVERSARIAL_REVIEW_004.md` §2/§8 are met.
  No publish blockers remain at the code level (only operational steps — npm login, finalizing the version — remain).

### T14 — `npm publish` executed · Status: DONE(2026-09-02)

- Goal: run the actual `npm publish`, after separate, explicit user approval (per the guardrail noted under
  "npm package distribution prep" above and in `CLAUDE.md`).
- Completion record (no secrets):
  - Published: `sheet-mcp@0.1.0`, 2026-09-02, to the public npm registry (`registry.npmjs.org`), tag `latest`.
  - Pre-publish gate re-run immediately before publishing: `npm run check` (180 tests, all passing),
    `npm run build`, `npm publish --dry-run` (zero auto-correction warnings — confirms AR-021 stayed resolved).
  - `npm login` required a real interactive browser session — it could not complete via this agent session's
    non-interactive shell execution, so the human ran it directly in their own terminal.
  - The registry rejected the first publish attempt with `403 Forbidden` — modern npm requires either 2FA or a
    granular access token with "bypass 2FA" enabled for account-changing actions like publish. A granular
    access token (read/write, all packages, 2FA bypass enabled, no organization access) was issued by the human
    and applied via `npm config set //registry.npmjs.org/:_authToken=...`; publish then succeeded.
  - Post-publish verification: confirmed `GET https://registry.npmjs.org/sheet-mcp` returns the package with
    `dist-tags.latest = "0.1.0"`, and ran `npx -y sheet-mcp` from a clean directory against the real registry —
    it correctly fails fast with the expected `GOOGLE_SERVICE_ACCOUNT_JSON` error and exit code 1 without credentials.
  - Also verified end-to-end with real credentials via `npm run smoke`, first via Resend's test-only
    `onboarding@resend.dev` address (send restricted to the account owner's own email), then again after
    verifying a real custom domain in Resend (Cloudflare-managed DNS) and switching `MAIL_FROM` to it — this
    second run sent successfully to a recipient other than the account owner, confirming the sandbox
    restriction was fully lifted.

### T14 follow-up — Republished as `0.1.1` to refresh the npm-hosted README · Status: DONE(2026-09-02)

- npm has no way to edit the README of an already-published version — refreshing what shows on the
  package page requires publishing a new version. This was a docs-only change (the full English
  translation, see the commit translating all project docs), so it's a patch bump per semver:
  `0.1.0` → `0.1.1`. No code changes; `package.json.description` was also translated to English while
  bumping the version, since it's user-facing text on the npm page.
- Completion record (no secrets): published `sheet-mcp@0.1.1` to the public npm registry, tag `latest`,
  after separate explicit user approval. Verified `dist-tags.latest = "0.1.1"` via the registry API and
  that the package page's README reflects the English version.

---

## v0.2 queue (do not start — see the SPEC roadmap)

- A real Semaphore implementation + Sender ID registration guide / row-hash fallback idempotency / a scheduler
