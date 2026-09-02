# CLAUDE.md — sheet_mcp steering

An MCP server for sending notifications to Philippine SMEs, using a Google Sheet as a database. The v0.1 channel is email; SMS is v0.2 (the interface exists from v0.1). Detailed background: `docs/SPEC.md`. Implementation design: `docs/DESIGN.md`.

## Stack

- Node.js 20+, TypeScript **strict** (including `noUncheckedIndexedAccess`)
- MCP: `@modelcontextprotocol/sdk` — stdio transport
- Google Sheets: `googleapis` (service-account auth)
- Email: Resend API (reference adapter) / SMTP (Nodemailer) as an alternative adapter
- Send log: `better-sqlite3` (local file DB)
- Verification: Vitest + ESLint + Prettier, schemas via `zod`
- `.env` loading: `dotenv` — called only from the `main()` entrypoints (server/smoke), never affects the test path
- Distribution: `npm run build` (tsc) compiles to `dist/`, published to npm as `sheet-mcp` — `npx sheet-mcp` works without cloning the repo (`docs/DESIGN.md` §8-B). Published 2026-09-02 (v0.1.0).

## Commands

```bash
npm run check        # typecheck + lint + format:check + test, all together — the required gate for task completion
npm run test         # vitest run
npm run test:watch   # vitest watch
npm run test:coverage # vitest run --coverage (core/ line coverage report, docs/TESTING.md §6)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint .
npm run format       # prettier --write . (docs/ADVERSARIAL_REVIEW_*.md are audit records, excluded via .prettierignore)
npm run format:check # prettier --check .
npm run dev          # runs the MCP server over stdio
npm run smoke        # manual smoke test against a real sheet/email (human-only, see docs/TESTING.md)
npm run build        # compiles src/ -> dist/ for distribution (docs/DESIGN.md §8-B)
```

## Source Layout

```
src/
  core/        # pure logic: config, template, pipeline, idempotency — no external I/O
  adapters/    # external I/O implementations: googleSheetClient, resendProvider, sqliteSendLog
  mocks/       # InMemorySheetClient, MockNotificationProvider, FixedClock
  cli/         # human-only operational CLI published in the npm package (recoverStaleClaim, etc.) — exposed as a bin
  server.ts    # MCP server entrypoint (tool registration only, no logic)
tests/         # Vitest — uses only src/mocks, no network calls
fixtures/      # sheet JSON fixtures
scripts/       # repo-developer-only scripts such as smoke.ts (need real credentials, not included in the distributed package)
```

## Conventions

- Put all external I/O (sheets, sending, clock, log storage) **behind an interface**. `core/` knows only the interfaces.
- No `any`. Parse external input (sheet values, config) with `zod` at the boundary.
- Write agent-friendly error messages: state what's wrong **and how to fix it**.
  Example: `The 'recipient_column' key is missing from the config tab. Add a recipient_column=<column name> row to the notify_config tab.`
- Keep files small (consider splitting past ~200 lines). Functions should have a single responsibility.
- Commit message format: `T{n}: summary` (e.g., `T4: template engine + tests`).

## Guardrails (do not violate)

1. **Live sending is off by default.** `SEND_MODE=dry_run` is the default; an actual send requires **both** the `SEND_MODE=live` environment variable **and** `confirm: true` on the MCP tool call. Test code must never take the live path under any circumstance.
2. **No network calls in tests.** Use only mocks/fixtures (`docs/TESTING.md`).
3. Secrets (`GOOGLE_SERVICE_ACCOUNT_JSON`, `RESEND_API_KEY`, etc.) live only in `.env`. Never commit them; only `.env.example` is committed.
4. Sheet writes are limited to the status columns (`_send_status`, `_sent_at`, `_message_id`, `_error`). User data columns are never modified.
5. If the spec/design and the code conflict, don't change the code arbitrarily — update `docs/` first (docs are the source of truth).

## How We Work

- The unit of work is a task from `docs/TASKS.md`. One task per session.
- Loop on fixes yourself until the task's **completion criteria are fully met** and `npm run check` passes. The default is to go all the way through without intermediate questions; stop and leave a question only when spec ambiguity blocks progress.
- On completion, summarize the changed files and verification results, then end the session.

## Context Management

- Delegate large-scale exploration (file search, skimming log/build output) to subagents and take only the conclusion. Don't pile the raw output into the main context.
- Don't habitually read whole files. Read only the range you need.
- If a task runs long, record intermediate results (decisions made, remaining work) in `docs/` or working notes. Work should be resumable even if the session is interrupted or context gets compacted.
- Summarize and end the session once a task is done. Don't cram multiple tasks into one session.

## Pruning Log

This file is reviewed biweekly to remove stale rules (`docs/WORKFLOW.md`, habit 1).

- 2026-09-01: initial version.
- 2026-09-01: added the "Context Management" section.
- 2026-09-01: npm distribution (T11–T13) in progress — reflected `build` in the stack/commands sections.
- 2026-09-02: `npm publish` completed (v0.1.0) — updated the stale "not yet published" note. All project docs (including this file) were translated from Korean to English at the project owner's request; the historical Adversarial Review audit trail (docs/ADVERSARIAL_REVIEW_*.md) was translated in place with its findings/verdicts preserved verbatim in meaning, as a one-time authorized exception to the "never modify audit records" convention — only the language changed.
