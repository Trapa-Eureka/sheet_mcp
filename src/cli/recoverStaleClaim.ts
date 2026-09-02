// Human-only operational CLI — inspects stale claims (reservations left neither committed nor
// released) and force-releases them only after an explicit confirmation.
// Addresses docs/ADVERSARIAL_REVIEW_003_STATUS_GAPS.md STATUS-GAP-003.
//
// Unlike scripts/smoke.ts, this file is the second bin published in the npm package
// (`sheet-mcp-recover`, package.json). smoke.ts only makes sense with real sheet/email
// credentials, so only developers who cloned the repo use it — but stale claim recovery is
// just as necessary for operators who installed via `npx sheet-mcp`. That's why it lives in
// src/cli/, which is compiled with the same relative path as src/adapters and shipped together
// under dist/ (docs/ADVERSARIAL_REVIEW_004.md AR-019: it used to live under scripts/, so it was
// never included in the public tarball at all — README pointed to it as the official procedure,
// but anyone who installed via npx had no way to run it).
// Not included in the CI/agent gate (npm run check) — the logic is already covered by
// core/adapters tests, and this file itself only does CLI parsing/wiring.
//
// What this CLI never does:
// - It never force-releases a claim on its own judgment. Without --confirm it only inspects and
//   deletes nothing (the default run opens the DB readonly — even if there's a code bug, SQLite
//   itself refuses any write).
// - It never deletes an already-committed (confirmed sent) record, under any option —
//   forceReleaseStaleClaim() itself only targets rows where committed=0
//   (src/adapters/sqliteSendLog.ts).
// - It never actually resends an email. Releasing a claim by itself sends nothing — to retry
//   after release you must separately re-run the send pipeline (the send tool).
//
// Usage (repo clone, for development):
//   npm run recover:stale-claim -- \
//     --db ./data/sendlog.db --sheet-id <sheetId> --tab <tab> \
//     --row-key <rowKey> --template-hash <templateHash>
//
// Usage (installed via npx sheet-mcp, after publish):
//   npx sheet-mcp-recover \
//     --db ./data/sendlog.db --sheet-id <sheetId> --tab <tab> \
//     --row-key <rowKey> --template-hash <templateHash>
//   (running only this far just inspects. Nothing is changed.)
//
//   npx sheet-mcp-recover \
//     --db ./data/sendlog.db --sheet-id <sheetId> --tab <tab> \
//     --row-key <rowKey> --template-hash <templateHash> \
//     --older-than-ms 1800000 --reason "confirmed not sent in the provider dashboard" --confirm
//   (actually releases the claim.)
//
// Options:
//   --older-than-ms   Default 1800000 (30 minutes). Values under 5 minutes (300000ms) are
//                     rejected without --i-understand-the-risk — a claim that recent is very
//                     likely still mid-send.
//   --reason          A one-line note on why you're releasing it. Recorded verbatim in the audit
//                     log.
//   --confirm         Actually calls forceReleaseStaleClaim(). Without it, inspection only.
//   --i-understand-the-risk   Required only when --older-than-ms is shorter than the operational
//                     minimum.
//
// Every run (inspect or release) appends one line to the audit log (JSON Lines).
// Default path: ./data/recovery-audit.log, overridable via RECOVERY_AUDIT_LOG_PATH.

import Database from "better-sqlite3";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { detectSchemaVersion, SqliteSendLog } from "../adapters/sqliteSendLog.js";
import { assertValidStaleClaimThreshold } from "../core/types.js";

const DEFAULT_OLDER_THAN_MS = 30 * 60 * 1000; // 30 minutes
// Conservative operational minimum (STATUS-GAP-002) — anything shorter carries a very high risk
// of wrongly releasing a claim whose send is still in flight, so it's blocked without a separate
// flag.
const OPERATIONAL_MIN_OLDER_THAN_MS = 5 * 60 * 1000; // 5 minutes

interface Args {
  dbPath: string;
  sheetId: string;
  tab: string;
  rowKey: string;
  templateHash: string;
  olderThanMs: number;
  reason?: string;
  confirm: boolean;
  iUnderstandTheRisk: boolean;
}

function printUsage(): void {
  console.error(`Usage:
  npx sheet-mcp-recover --db <path> --sheet-id <id> --tab <tab> \\
    --row-key <rowKey> --template-hash <hash> \\
    [--older-than-ms 1800000] [--reason "..."] [--confirm] [--i-understand-the-risk]

(If developing from a cloned repo, use npm run recover:stale-claim -- instead of npx)

Running without --confirm only inspects and deletes nothing.
See the comment at the top of src/cli/recoverStaleClaim.ts for details.`);
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  printUsage();
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    const value = argv[idx + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`${flag} must be followed by a value.`);
    }
    return value;
  };

  const dbPath = get("--db");
  const sheetId = get("--sheet-id");
  const tab = get("--tab");
  const rowKey = get("--row-key");
  const templateHash = get("--template-hash");
  if (!dbPath || !sheetId || !tab || !rowKey || !templateHash) {
    fail("--db, --sheet-id, --tab, --row-key, and --template-hash are all required.");
  }

  const olderThanMsRaw = get("--older-than-ms");
  const olderThanMs = olderThanMsRaw === undefined ? DEFAULT_OLDER_THAN_MS : Number(olderThanMsRaw);

  return {
    dbPath,
    sheetId,
    tab,
    rowKey,
    templateHash,
    olderThanMs,
    reason: get("--reason"),
    confirm: argv.includes("--confirm"),
    iUnderstandTheRisk: argv.includes("--i-understand-the-risk"),
  };
}

function appendAuditLog(entry: Record<string, unknown>): void {
  const logPath = process.env.RECOVERY_AUDIT_LOG_PATH ?? "./data/recovery-audit.log";
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

interface InspectResult {
  version: "none" | "v1_record" | "v2_claim";
  found: boolean;
  committed?: boolean;
  claimedOrSentAt?: string;
  ageMs?: number;
}

// Opens the DB readonly to inspect — even with a code bug, SQLite itself refuses any write, so
// this function is structurally incapable of deleting anything.
function inspect(dbPath: string, args: Args): InspectResult {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const version = detectSchemaVersion(db);
    if (version === "none") return { version, found: false };
    if (version === "v1_record") {
      // v1 has no claim/commit concept — starting the server once auto-migrates it to v2.
      return { version, found: false };
    }
    const row = db
      .prepare<[string, string, string, string], { committed: number; sent_at: string }>(
        `SELECT committed, sent_at FROM send_log
         WHERE sheet_id = ? AND tab = ? AND row_key = ? AND template_hash = ?`,
      )
      .get(args.sheetId, args.tab, args.rowKey, args.templateHash);
    if (!row) return { version, found: false };
    return {
      version,
      found: true,
      committed: row.committed === 1,
      claimedOrSentAt: row.sent_at,
      ageMs: Date.now() - Date.parse(row.sent_at),
    };
  } finally {
    db.close();
  }
}

function printInspectResult(result: InspectResult): void {
  if (result.version === "none") {
    console.log("The DB has no send_log table yet — there are no claim records at all.");
    return;
  }
  if (result.version === "v1_record") {
    console.log(
      "This DB is still on the old (v1) schema. Starting the server once (or running this CLI " +
        "with --confirm) will auto-migrate it to the new schema (v2) — existing 'sent' records " +
        "are preserved, and the original table is kept as a backup table (STATUS-GAP-001). " +
        "Re-inspect after migrating.",
    );
    return;
  }
  if (!result.found) {
    console.log("No claim record found for that (sheetId, tab, rowKey, templateHash) key.");
    return;
  }
  const ageSec = Math.floor((result.ageMs ?? 0) / 1000);
  if (result.committed) {
    console.log(
      `This is an already-committed send record (sent_at=${result.claimedOrSentAt}, ${ageSec}s ago). ` +
        "forceReleaseStaleClaim() will never delete this record, even with --confirm.",
    );
  } else {
    console.log(
      `This is a not-yet-committed (claimed) reservation (claimed_at=${result.claimedOrSentAt}, ` +
        `${ageSec}s ago, ${Math.floor(ageSec / 60)} minutes elapsed). Re-run with --confirm and a ` +
        "sufficiently large --older-than-ms to release it.",
    );
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  // Reject NaN/Infinity/negative/fractional values immediately, before any inspect or delete.
  assertValidStaleClaimThreshold(args.olderThanMs);
  if (args.olderThanMs < OPERATIONAL_MIN_OLDER_THAN_MS && !args.iUnderstandTheRisk) {
    fail(
      `--older-than-ms=${args.olderThanMs} is shorter than the operational minimum of ` +
        `${OPERATIONAL_MIN_OLDER_THAN_MS}ms (5 minutes). A claim that recent is very likely still ` +
        "mid-send. If you really want to use that value, add the --i-understand-the-risk flag.",
    );
  }
  if (!existsSync(args.dbPath)) {
    fail(`DB file not found: ${args.dbPath}`);
  }

  const before = inspect(args.dbPath, args);
  printInspectResult(before);
  appendAuditLog({
    action: "inspect",
    dbPath: args.dbPath,
    sheetId: args.sheetId,
    tab: args.tab,
    rowKey: args.rowKey,
    templateHash: args.templateHash,
    olderThanMs: args.olderThanMs,
    reason: args.reason,
    result: before,
  });

  if (!args.confirm) {
    console.log("\nRan without --confirm, so nothing was deleted.");
    return;
  }
  if (before.version !== "v2_claim" || !before.found || before.committed) {
    console.log("\nNo target to release, so --confirm was not applied.");
    return;
  }

  // Only from here does this actually write to the DB — the SqliteSendLog constructor also
  // performs a v1->v2 migration if needed (already confirmed as v2 above, so no migration
  // happens on this path).
  const sendLog = new SqliteSendLog(args.dbPath);
  let released: boolean;
  try {
    released = sendLog.forceReleaseStaleClaim(
      args.sheetId,
      args.tab,
      args.rowKey,
      args.templateHash,
      args.olderThanMs,
    );
  } finally {
    sendLog.close();
  }

  appendAuditLog({
    action: "force_release",
    dbPath: args.dbPath,
    sheetId: args.sheetId,
    tab: args.tab,
    rowKey: args.rowKey,
    templateHash: args.templateHash,
    olderThanMs: args.olderThanMs,
    reason: args.reason,
    released,
  });

  if (released) {
    console.log(
      "\nClaim released. Before resending, be sure to check the email provider's (Resend) " +
        `dashboard to confirm no email was actually sent to this recipient around this time ` +
        `(claimed_at=${before.claimedOrSentAt}). Retrying without checking risks sending a ` +
        "duplicate email that actually already went out. Once you've confirmed, separately " +
        "re-run the send pipeline to retry this row.",
    );
  } else {
    console.log(
      "\nFailed to release the claim — another run may have already committed/released it since " +
        "the inspection, or the conditions (committed=0 and old enough) may no longer hold. " +
        "Re-inspect to check the current state.",
    );
  }
}

main();
