# SPEC — sheet_mcp v0.1

Written: 2026-09-01 · Status: Finalized (if changed, update this document first)

## 1. Background

Philippine SMEs mostly manage orders, collections, reservations, and customer lists via Google Sheets. Notifications (order confirmations, payment reminders, reservation reminders) are sent manually by staff looking at the sheet, so they get missed or sent late.

The original target channel was SMS (the standard for Philippine business communication). However, since the SIM Registration Act, business SMS effectively requires going through a gateway (Semaphore, M360, etc.) plus Sender ID registration, which involves setup lead time. Therefore:

> **v0.1 validates the entire pipeline via email sending, and SMS is added in v0.2 as a single extra adapter.**

This project is the first validation of the MCP automation core's common functionality (sheet integration → notification sending). It is built as an independent MVP, and once validated, it will be folded into the core and existing services (tax/study-abroad/logistics verticals).

## 2. v0.1 Goals

Users can do the following:

1. Prepare a Google Sheet with notification target data according to the convention (the sheet convention in `docs/DESIGN.md`).
2. From Claude Code/Claude Desktop, using MCP tools:
   - Read rows from the sheet (`read_rows`)
   - Preview the messages that will be sent **without sending them** (`preview_messages`)
   - Send emails after confirmation (`send_notifications`)
   - Query the send history (`get_send_log`)
3. The send result (success/failure/timestamp/message ID) is automatically recorded in the sheet's status columns.
4. The same row is **never sent twice** with the same template (idempotency).

## 3. v0.1 Non-Goals

- Actual SMS sending (only the interface and stub are prepared)
- Web UI / self-serve signup
- Multi-tenant auth/billing
- Automatic scheduling (sending is triggered by a person or agent via MCP tools)
- Sender ID registration proxy flow

## 4. Representative Scenarios

One from each of the three verticals (professional services, education/study-abroad, logistics). v0.1 must be able to handle all three with the same pipeline.

1. **Tax filing deadline reminder** — Filter rows in the customer list sheet whose `filing_deadline` is approaching and send a "7 days until deadline" email. Whether the notification was sent is recorded in the sheet, so staff can narrow down who needs a phone follow-up.
2. **Study-abroad document deadline notice** — In the student sheet, merge the list of missing documents into rows where `docs_status = incomplete` and send a notice.
3. **Collections notice (logistics/distribution)** — In the outstanding balance sheet, merge the amount and due date into rows where `balance > 0` and send a payment notice.

## 5. Success Criteria (v0.1 completion determination)

- Perform one of the above scenarios end-to-end with 1 real Google Sheet + a real email address (manual smoke test).
  **Done (2026-09-02)** — Confirmed successful sending using a real Google service account + Resend
  (see docs/ADVERSARIAL_REVIEW_003.md AR-016, docs/TASKS.md T10).
- Zero duplicate sends even when the same command is run twice. **Done (2026-09-02)** — On re-running the
  above smoke test, rows were processed as `skipped_duplicate`, and zero duplicate sends were empirically confirmed (docs/TASKS.md T10).
- Even if some rows fail (e.g., invalid address), the rest are sent, and `_error` is recorded on the failed rows.
- `npm run check` passes fully, core coverage at 90% or above.

## 6. Roadmap

| Version | Content                                                                           | Prerequisite                    |
| ------- | --------------------------------------------------------------------------------- | ------------------------------- |
| v0.1    | Email sending pipeline + 4 MCP tools                                              | —                               |
| v0.2    | Real `SemaphoreSmsProvider` implementation, Sender ID registration guide document | Sender ID registration complete |
| v0.3    | Scheduled sending (cron — Cloudflare Workers or a local daemon)                   | v0.1 validated                  |
| v0.4    | Self-serve: OAuth sheet connection + minimal web UI, usage billing                | After core integration decision |

## 7. Open Items

- [ ] Email sending domain: which domain's SPF/DKIM to set up (decision needed before smoke test)
- [ ] Whether to support sheets without an `id_column` (v0.1 mandates it; row-hash fallback to be considered in v0.2)
- [ ] Whether to include a Tagalog/English mixed template sample in fixtures (recommended: include)
