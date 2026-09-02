# sheet_mcp

An **automated notification-sending MCP server** for Philippine SMEs, using a Google Spreadsheet as a database.

- It reads row data from a sheet, merges it into a template, sends a notification to the recipient, and writes the send status back to the sheet.
- **The v0.1 sending channel is email.** SMS (via a Philippine gateway such as Semaphore) will be added as an adapter in v0.2, once the Sender ID registration issue is sorted out. The channel sits behind the `NotificationProvider` interface from the start, so the pipeline code won't change when SMS is added.
- This is the first vertical slice validating the MCP automation core's shared capability (sheet integration → notification sending). Once validated, it will be folded into the core.

## Key Features (v0.1)

### 4 MCP Tools (`docs/DESIGN.md` §5)

| Tool                 | What it does                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `read_rows`          | Reads and returns target rows per the notify_config convention (filter applied, up to 200-row preview) |
| `preview_messages`   | Previews the actual rendered message list + missing-value/duplicate warnings. **No sending.**          |
| `send_notifications` | Sends email after confirmation. Without both safeguards below, returns only a dry-run result.          |
| `get_send_log`       | Queries send history via cursor-based pagination, newest first (200 by default, 1000 max).             |

### Safeguards

- **No live sending without dual confirmation**: a real email only goes out when **both** the MCP tool call's `confirm: true` **and** the process environment variable `SEND_MODE=live` are present — this guards against mistakes by an autonomous agent.
- **Duplicate-send prevention (idempotency)**: the same row + the same template combination is sent only once. A 3-step `claim → send → commit/release` flow atomically records whether a send happened, so running the same command multiple times — or the process dying mid-run — never causes a double send (local SQLite `SendLog`, `docs/DESIGN.md` §3/§6).
- **Mass-misfire prevention**: if the number of rows passing the filter exceeds 1,000, a live send sends nothing and aborts immediately (prevents partial-send incidents, `MAX_PIPELINE_ROWS`).
- **External API timeouts**: both Google Sheets and Resend calls have a default 30-second timeout, so a network failure can't hang the whole pipeline indefinitely.
- **User data is never touched**: sheet writes are limited to the 4 status columns (`_send_status`/`_sent_at`/`_message_id`/`_error`).
- **Recovery that can't run automatically**: if the process dies while a claim is held, an autonomous agent cannot reclaim it by itself — only a human, via the operational CLI (`sheet-mcp-recover`, read-only by default + audit log), can reclaim it.

### Sheet Convention

Just add a `notify_config` tab (send settings: data tab name, recipient column, subject/body templates, optional filter) and a data tab (row 1 = header = template variable names) to a single Google Sheet — no separate database or schema migration needed. See "Example Sheet Template" below for the full convention and a minimal example.

### Two Installation Methods

- **Clone the repo** (for development/contribution): commit `.mcp.json` and share it with the team.
- **`npx sheet-mcp`** (use it without cloning): register it by passing environment variables directly via `claude mcp add`'s `-e` flag. See "Setup Procedure" below and `docs/DESIGN.md` §8.

## Documentation Map

> The relative paths below are only valid if you've cloned the repository or are viewing the
> [GitHub repository](https://github.com/Trapa-Eureka/sheet_mcp) — the package installed via
> `npx sheet-mcp` does not include `docs/` (docs/ADVERSARIAL_REVIEW_004.md AR-027).

| Document           | Content                                                                  | When to read it                                   |
| ------------------ | ------------------------------------------------------------------------ | ------------------------------------------------- |
| `CLAUDE.md`        | Agent steering file — stack, commands, conventions, guardrails           | At the start of every agent session (auto-loaded) |
| `docs/SPEC.md`     | Product spec — background, goals/non-goals, scenarios, roadmap           | Before discussing features/scope                  |
| `docs/DESIGN.md`   | Technical design — architecture, interfaces, sheet convention, MCP tools | Required reading before implementation            |
| `docs/TESTING.md`  | Test strategy — mock setup, edge cases, gates                            | Before writing tests                              |
| `docs/TASKS.md`    | Task backlog — agent execution units, completion criteria                | When assigning work                               |
| `docs/WORKFLOW.md` | AI-native development approach — the rules that run this repo            | Once at the start + as an ongoing reference       |

## Development Approach

This project proceeds in the order **docs → agent implementation → verification** (see `docs/WORKFLOW.md`).
A human (Jin) owns spec/design/review/live-send approval, and code is written by a Claude Code agent, one task at a time from `docs/TASKS.md`. Every task's shared completion condition is that `npm run check` passes.

## Quickstart (Development/Testing)

```bash
npm install
npm run check         # typecheck + lint + format:check + test — the shared agent/human gate
npm run dev           # runs the MCP server over stdio (.env secrets required — see "Setup Procedure" below)
```

## Setup Procedure (Trying it with a real sheet/email)

1. Copy `.env.example` to `.env` and fill in `GOOGLE_SERVICE_ACCOUNT_JSON`/`RESEND_API_KEY`/`MAIL_FROM`.
2. Build a Google Sheet per "Example Sheet Template" below, share it with your service account's email as an editor, then set `SMOKE_SHEET_ID=<sheet ID>` in `.env`.
3. Run `npm run smoke` to check the preview (the default is always a dry run — nothing is sent).
4. To actually send, run `SEND_MODE=live SMOKE_CONFIRM_SEND=1 npm run smoke` (only sends if exactly one row is targeted).
5. In Claude Code, open this repo and confirm the `sheet-mcp` connection with `/mcp` (`.mcp.json` is committed, see `docs/DESIGN.md` §8).

### Using `npx sheet-mcp` (no clone required)

The package is published on npm, so you can register it directly with Claude Code without cloning this repo. Instead of a `.env` file, pass your credentials directly as `-e` flags on `claude mcp add` — see `docs/DESIGN.md` §8-B for why a `.env` file doesn't work reliably for this path.

```bash
claude mcp add sheet-mcp --scope local \
  -e GOOGLE_SERVICE_ACCOUNT_JSON=<absolute path to your service-account JSON file> \
  -e RESEND_API_KEY=<your Resend API key> \
  -e MAIL_FROM=<your verified sending address> \
  -- npx -y sheet-mcp
```

**Worked example** — this is exactly the same command with every value filled in, so you can see what a real, working setup looks like. Copy it and swap in your own values:

```bash
claude mcp add sheet-mcp --scope local \
  -e GOOGLE_SERVICE_ACCOUNT_JSON=/Users/jin/keys/sheet-mcp-service-account.json \
  -e RESEND_API_KEY=re_AbCdEfGh_1234567890abcdefghij \
  -e MAIL_FROM=notify@updates.example.com \
  -- npx -y sheet-mcp
```

What to change for your own setup:

- **`GOOGLE_SERVICE_ACCOUNT_JSON`** — the absolute path to the service-account key JSON file you downloaded from Google Cloud Console (IAM & Admin → Service Accounts → Keys → Add Key → JSON). It must be an **absolute** path: `npx` runs from wherever Claude Code happens to be running, not from this repo, so a relative path like `./service-account.json` won't resolve reliably.
- **`RESEND_API_KEY`** — your own key from resend.com → API Keys.
- **`MAIL_FROM`** — an address at a domain you've verified with Resend (resend.com → Domains → Add Domain, then add the DNS records it gives you). If you don't have a domain yet, you can start with Resend's test-only address `onboarding@resend.dev` to try things out — but that address can only send to the email address on your own Resend account until you verify a real domain.
- **`sheet-mcp`** (the first argument) — the name this server is registered under in Claude Code; change it if you want something else.
- **`--scope local`** — keep this as `local` (or `user`) when passing real secrets. Never use `--scope project` with real credentials: that scope commits `.mcp.json` to git, which would leak your secrets.

Once registered, confirm the connection inside Claude Code with `/mcp`.

## Example Sheet Template

One `notify_config` tab (column A = key, column B = value) and one data tab — see `docs/DESIGN.md` §2 for the full key list and rules.

**Minimal `notify_config` tab**

| A                  | B                                     |
| ------------------ | ------------------------------------- |
| `data_tab`         | `customers`                           |
| `id_column`        | `customer_id`                         |
| `recipient_column` | `email`                               |
| `channel`          | `email`                               |
| `subject_template` | `[{{shop}}] Payment notice`           |
| `body_template`    | `Hi {{name}}, please pay {{amount}}.` |
| `filter_column`    | `status`                              |
| `filter_value`     | `unpaid`                              |

**Data tab**: row 1 is the header (= template variable names), data starts at row 2. `fixtures/sheets/collections.json` is a real example (12 rows, a mixed Tagalog/English outstanding-balance scenario) — move it into a Google Sheet with the same columns and it's ready to use for a smoke test. Send results are automatically recorded at the end of this tab in 4 columns — `_send_status`/`_sent_at`/`_message_id`/`_error` — and user data columns are never modified.

## Operations — Existing DB Upgrade / Stale Claim Recovery

- **Upgrading an existing `sendlog.db`**: the next time you run the server (`npm run dev`) or the smoke script (`npm run smoke`) with the newer code, `SqliteSendLog` auto-detects the old DB schema and migrates it losslessly to the new schema (the original is preserved in a `send_log_v1_backup_*` table). There's nothing a human needs to do. See `docs/DESIGN.md` §6 for details.
- **When a claim has been sitting for a long time** (e.g., the process died without a clean shutdown): never touch the DB file directly — query it first. In a repo-clone dev environment: `npm run recover:stale-claim -- --db ./data/sendlog.db --sheet-id <id> --tab <tab> --row-key <key> --template-hash <hash>`. If installed via `npx sheet-mcp`: `npx sheet-mcp-recover --db ... --sheet-id ... --tab ... --row-key ... --template-hash ...` (same arguments; read-only by default, deletes nothing). To actually reclaim it, add `--older-than-ms` and `--confirm`. For full options and safeguards, see the header comment in `src/cli/recoverStaleClaim.ts` and `docs/DESIGN.md` §6.

## Status

Progress isn't tracked manually here — the single source of truth is each task's status (`DONE(date)`/`TODO`) in `docs/TASKS.md`. Duplicating it in the README makes it easy to forget to update on the next task's completion (`docs/ADVERSARIAL_REVIEW_002.md` AR-010).

Whether this is a fully working product end to end, including the MCP tools, is determined by whether T8–T10 are `DONE`.
