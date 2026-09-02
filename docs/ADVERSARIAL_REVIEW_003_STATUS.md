# Adversarial Review Report 003 — Final Fix-Application Status

- Inspection date: 2026-09-01
- Inspection target: the results of re-verifying, directly against the code, the items that
  `docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS_RESOLVED.md` claimed to have "resolved"
- Baseline revision: `f18d6f3` (the GAPS_RESOLVED commit), plus commits additionally fixed
  during this inspection
- Inspection method: each item's "full-resolution criteria" was checked 1:1 against the
  code/tests. Rather than judging solely by test pass/fail, the actual code paths were traced
  directly to confirm they exist and that no counterexample remains.
- Documentation principle: the earlier documents (`ADVERSARIAL_REVIEW_003.md`, `_RESOLUTION.md`,
  `_RESOLUTION_GAPS.md`, `_RESOLUTION_GAPS_RESOLVED.md`) are audit records and are not modified.
  This document is the current-point-in-time **final status board**.

## 1. Conclusion

For the 8 items that `ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS_RESOLVED.md` claimed were "resolved"
(GAP-001~004, 006, 008, REG-001, and GAP-005 which was explicitly stated as a kept policy), the
claims **matched the code in every case, fully**. However, during this re-verification, a new,
genuine defect not covered by that document (GAP-009) was found through direct code tracing and
**fixed together in this pass** — a defect where `release()` could **delete an already-confirmed
(committed) send record** as long as the token matched. This defect does not manifest in the
current pipeline's actual call path (`release()` is called only on the failure path), but the
claim/commit/release contract's own defenses were breached, and this was exactly the same kind of
risk (loss of a confirmed send record → re-sending becomes possible) that GAP-001/AR-013 were
meant to prevent.

`npm run check` shows **all 156 tests passing** (150 at the time of GAPS_RESOLVED → +6 in this
re-verification), core line coverage 93.24% (the 90%+ target is maintained). Every item that could
be fully resolved through code has now been resolved. **Only GAP-005 (status column policy) and
GAP-007 (actual manual smoke test) still require human judgment/execution**, which is not
something resolvable through code in the first place — a point the earlier documents state
identically.

| Item | GAPS_RESOLVED's claim | This re-verification's result |
| --- | --- | --- |
| REG-001 | Resolved | **Matches fact** — confirmed in code |
| GAP-001 | Resolved | **Matches fact** — however, an adjacent defect (GAP-009) was found during re-verification |
| GAP-002 | Resolved | **Matches fact** |
| GAP-003 | Resolved | **Matches fact** |
| GAP-004 | Resolved | **Matches fact** |
| GAP-005 | Policy kept (human re-confirmation needed) | **Matches fact** — still awaiting human judgment |
| GAP-006 | Resolved | **Matches fact** — confirmed down to the MCP tool path |
| GAP-007 | Incomplete (human-only) | **Matches fact** — still incomplete |
| GAP-008 | Resolved | **Matches fact** |
| **GAP-009 (new)** | Not in the document | **Resolved as soon as found** — see §2 below |

## 2. New finding: GAP-009 — a confirmed (sent) record could be deleted by release() based on token match alone

- How it was found: while directly tracing through the code the GAP-001 fix (token-based
  claim/commit/release) that `ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS_RESOLVED.md` claimed, it was
  discovered that the SQL/conditional in `commit()` and `release()` checked only whether
  `claim_token` matched, and **did not check whether it was already `committed=1` (confirmed
  sent)**.
- Reproduction scenario: `claim()` → `commit()` (succeeds, confirmed with `sendStatus="sent"`) →
  later, `release()` is called with the same token (e.g., through mistakenly entangled code paths,
  or a slip during a future refactor) → the pre-fix code accepted this request as-is and **deleted
  the just-confirmed send record entirely**. As a result, `wasSent()` would become `false` again,
  which could lead to a genuine duplicate-send incident where a subsequent run **re-sends a row
  that had actually already been sent**.
- Looking only at the current pipeline's (`src/core/pipeline.ts`) actual call sequence, this
  scenario does not occur — `release()` is called only on the provider-failure/exception branch (a
  path that never reaches `commit()`). But this only means "the call sequence in this one file
  happens to be safe right now" — the `SendLog` adapter's own contract was failing to protect
  itself, which is a lack of defense in depth. `forceReleaseStaleClaim()` was already upholding the
  principle of "never touch a confirmed record under any circumstances," and the fact that the
  ordinary `release()` lacked the same principle — this asymmetry — was also grounds for the
  finding.
- **Fix**: added a "only while not yet `committed`" condition to both `commit()` and `release()`.
  - `commit()`: confirms only when the token matches AND `committed=0`. If an attempt is made to
    commit an already-confirmed record again (a caller bug that commits the same claim twice), it
    throws an error instead of silently overwriting.
  - `release()`: deletes only when the token matches AND `committed=0`. Even if the token matches,
    if it is already confirmed, it is silently ignored (not deleted) — a confirmed audit record
    cannot be deleted by any call.
- **Files changed**: `src/mocks/inMemorySendLog.ts`, `src/adapters/sqliteSendLog.ts` (added the
  `committed = 0` condition to the SQL), `docs/DESIGN.md` §3 (SendLog interface comments).
- **Verification** (on both adapters):
  - Confirmed that "even if the token matches, an already-committed (sent) record is not deleted
    by release()" — after commit, calling release with the same token still leaves
    `wasSent()===true`, `list()`'s `sendStatus==="sent"`, and `messageId` unchanged.
  - Confirmed that "calling commit() twice with the same token makes the second call an error" —
    the first commit's result (`messageId`) is not overwritten by the second attempt.

### Incidental finding: `list()`'s `limit` being negative overlaps with SQLite's `LIMIT -1` (unlimited) meaning

- Found alongside the GAP-006 re-verification. `SendLog.list()` is an interface that can be called
  directly at the library level without passing through the MCP boundary
  (`sendLogLimitSchema`, which allows only positive integers), and when `limit` came in as 0 or
  negative, `Math.min(limit, MAX)` passed that negative value straight through. Since SQLite
  interprets a negative `LIMIT` as "unlimited," this could reopen, through this path, the
  "unbounded response" problem that AR-015 was meant to block (it doesn't reproduce through the
  actual product surface — the MCP tool — because zod blocks it there, but the interface itself
  provided no defense).
- **Fix**: added a floor via `Math.max(1, Math.min(...))` (on both adapters).
- **Verification**: confirmed on both adapters that passing `limit: -1` directly is always clamped
  to at least 1.

## 3. Per-item re-verification grounds (existing GAP-001~008/REG-001)

Kept concise — only "why each item was judged to match the facts" is recorded here. For the full
narrative of the fixes themselves, see `ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS_RESOLVED.md`.

- **REG-001**: confirmed directly in `src/core/pipeline.ts` that `computeTemplateHash` sha256's the
  subject/body separately and then re-hashes. Re-confirmed via test that the original collision
  case (`"A "`+`"B"` vs `"A"`+`" B"`) now produces different hashes.
- **GAP-001**: confirmed in adapter code that a `ClaimResult{claimed, token}` is returned, that the
  DB records only `claimed` (`committed=0`), and that commit/release require the token.
  Re-confirmed by checking all 4 MCP tools (`read_rows`/`preview_messages`/`send_notifications`/
  `get_send_log`) in `src/server.ts` that `forceReleaseStaleClaim` is not exposed as an MCP tool.
- **GAP-002**: confirmed that the `PipelineResult.logFailed` field actually exists in
  `src/core/pipeline.ts` (definition + aggregation) and `src/toolSchemas.ts` (zod output schema).
  Confirmed that the `send_notifications`/`preview_messages` handlers in `server.ts` spread
  `...result` as-is, so `logFailed` is not omitted from the response.
- **GAP-003**: directly traced in code that `attemptSend()`'s release call sites are exactly 2
  (provider failure/exception), both going through `safeRelease()`. Confirmed `safeRelease()`
  catches internally and never re-throws.
- **GAP-004**: confirmed that the point in `scripts/smoke.ts` where `SMOKE_SHOW_VALUES` is read is
  the line **immediately after** the `loadDotenv()` call (not a module-top-level constant).
- **GAP-005**: confirmed that the `failed` branch in `toStatusUpdate()` in `src/core/pipeline.ts`
  still does not touch `sentAt`/`messageId` (preservation policy kept). The fact that the policy
  hasn't changed is not "resolved" but "intentionally kept," which matches the original document's
  labeling.
- **GAP-006**: confirmed that `list()` queries `limit+1` to compute `hasMore`, and that `cursor` is
  implemented via SQL's `id < ?` (Sqlite)/`r.id < cursorId` (InMemory). Confirmed that
  `get_send_log` in `src/server.ts` passes the `cursor` input and `hasMore`/`nextCursor` output
  through as-is (passing the adapter's result through directly rather than computing its own
  approximation).
- **GAP-007**: confirmed that T10 in `docs/TASKS.md` is still marked
  `CODE DONE(2026-09-01) / MANUAL SMOKE PENDING`, and that the `[PENDING]` marker in §5 of
  `docs/SPEC.md` remains — both were unchanged (since this item cannot be resolved through code,
  the fact that the document status hasn't changed is precisely what "correctly maintained" means).
- **GAP-008**: confirmed that all 3 handlers — `SIGINT`/`SIGTERM`/`exit` — are present in
  `src/server.ts`. Re-confirmed separately via script that better-sqlite3's `close()` is actually
  idempotent (§4).

## 4. Automated gate re-run results

```
npm run check
```

- TypeScript typecheck: passed
- ESLint: passed
- Prettier: passed
- Vitest: 13 test files, **156 tests passed**

```
npm run test:coverage
```

| | Stmts | Branch | Funcs | Lines |
|---|---|---|---|---|
| All files (src/core/\*\*) | 93.24% | 82.52% | 100% | 93.24% |

Same as at the GAPS_RESOLVED point in time (93.24%) — the GAP-009 fix reinforced an existing code
path, so there was no significant change to the coverage structure.

## 5. What still requires a human only (unchanged)

- **GAP-005**: whether to split the meaning of the 4 status columns into "last attempt" and "last
  success," or keep the current behavior of "preserving the past success audit record even after a
  failure" — this is a decision that changes the sheet layout/SPEC contract, so a human must decide.
- **GAP-007**: manual smoke testing with real Google Sheet + Resend credentials.
- **Claim expiry threshold value**: the actual operational value for
  `forceReleaseStaleClaim(olderThanMs)` depends on the Resend/Google API timeout and retry policy,
  and was not finalized in this session.

## 6. Tracking rule

- This document does not overwrite the previous 4 documents (`_003.md`, `_RESOLUTION.md`,
  `_RESOLUTION_GAPS.md`, `_RESOLUTION_GAPS_RESOLVED.md`) — all are preserved as-is, as audit
  records.
- The next adversarial review will start freshly as `docs/ADVERSARIAL_REVIEW_004.md`. At that
  point, along with GAP-005/GAP-007, it would be good to also sweep for whether "adjacent contract
  asymmetries" of the GAP-009 kind found this time exist elsewhere as well (e.g., defense in depth
  in other adapters).
