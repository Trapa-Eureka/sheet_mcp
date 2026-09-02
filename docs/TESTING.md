# TESTING — sheet_mcp

Purpose: let the agent verify its own changes **locally and deterministically**, without a live cloud (Shift Testing Left). Tests are the agent's feedback loop.

## 1. Principles

- **Zero network calls** in tests. Both Google Sheets and the email API are mocked only.
- Determinism: time comes from `FixedClock`, no randomness, fixed fixtures.
- Fast: the whole suite in a few seconds. Slow tests kill the agent's iteration speed.
- `npm run check` = typecheck + lint + test. The completion gate for every task.

## 2. Mock composition — src/mocks/

| Mock                       | Role                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `InMemorySheetClient`      | Implements SheetClient by loading `fixtures/sheets/*.json`. Reflects `writeStatus` results in memory so they can be re-queried and verified |
| `MockNotificationProvider` | Records sent messages into an array. Supports injecting failures for specific rows via the `failFor: rowKey[]` option                       |
| `InMemorySendLog`          | In-memory implementation of SendLog (the SQLite adapter has its own separate unit tests)                                                    |
| `FixedClock`               | `now()` returns a fixed timestamp                                                                                                           |

Fixture example: `fixtures/sheets/collections.json` — the collections scenario (SPEC §4-3), includes Tagalog/English mixed values.

## 3. Test layers

1. **unit** — `core/template`, `core/config` (zod parsing/error messages), templateHash, idempotency determination
2. **component** — assembles `SendPipeline` with the 4 mocks to verify the end-to-end flow (this is where the checklist below lives)
3. **e2e-mock** — starts the MCP server over stdio and calls the 4 tools with an SDK client (T9)
4. **manual smoke** — `npm run smoke` (`scripts/smoke.ts`): 1 real sheet + 1 real email. **Run by a human only**, not included in the CI/agent gate

## 4. Required edge-case checklist (component level)

- [ ] Empty data tab → 0 sent, not an error
- [ ] Row with a missing `recipient_column` value → only that row is `failed`, with the reason in `_error`
- [ ] Malformed email (no `@`) → `failed` at pre-send validation
- [ ] Missing template variable (`{{amount}}` but no such column) → that row is `failed`, with the missing key stated explicitly
- [ ] Same run twice → the second run is entirely `skipped_duplicate`, 0 provider calls
- [ ] Re-run after editing the template → resent due to a changed templateHash
- [ ] Injecting failures on some rows → the rest send normally + aggregate counts are correct + only the failed rows carry `_error`
- [ ] Correctness of filter_column/value application (case-sensitive comparison as-is)
- [ ] Unicode: Tagalog/Korean values merge without corruption
- [ ] `dryRun: true` → 0 provider calls, 0 writeStatus calls
- [ ] `send_notifications(confirm=true)` under `SEND_MODE=dry_run` → returns a dry-run result with no actual sending
- [ ] 1,000-row fixture pipeline < 2 seconds (performance regression guard)

## 5. Failure injection pattern

```ts
const provider = new MockNotificationProvider({ failFor: ["CUST-003"] });
const result = await pipeline.run("sheet-1", { dryRun: false });
expect(result.failed).toBe(1);
expect(provider.sent.map((m) => m.rowKey)).not.toContain("CUST-003");
```

## 6. Coverage

- `src/core/` line coverage 90% or above (vitest `--coverage`; not included in check — reported only in T9).
- Adapters are not mock targets, so lower coverage is acceptable — compensated for by smoke tests.
