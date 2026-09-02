// Script that generates fixtures/sheets/large-1000.json — for the SendPipeline performance
// regression guard (docs/TESTING.md §4, T7).
// To stay deterministic, values are built from the index rather than Math.random/Date.now.
// Run: npx tsx scripts/genLargeFixture.ts

import { renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetFixtureFileSchema } from "../src/mocks/inMemorySheetClient.js";

const ROW_COUNT = 1000;
const SHOPS = ["ABC Trading", "Cebu Hardware", "Davao Supplies"] as const;

function buildRow(index: number): Record<string, string> {
  const n = index + 1;
  const amount = (100 + (n % 50) * 37.25).toFixed(2);
  const dueDay = ((n % 28) + 1).toString().padStart(2, "0");
  return {
    customer_id: `CUST-${String(n).padStart(4, "0")}`,
    name: `Customer ${String(n)}`,
    // .invalid is an RFC 2606 reserved domain — even if the live-send safeguard is breached,
    // it won't reach a real recipient
    email: `customer${String(n)}@example.invalid`,
    amount: `₱${amount}`,
    due: `2026-09-${dueDay}`,
    status: n % 5 === 0 ? "paid" : "unpaid",
    shop: SHOPS[n % SHOPS.length] ?? SHOPS[0],
  };
}

function buildFixture(): unknown {
  return {
    sheetId: "large-1000",
    notifyConfig: {
      data_tab: "customers",
      id_column: "customer_id",
      recipient_column: "email",
      channel: "email",
      subject_template: "[{{shop}}] Payment Reminder",
      body_template: "{{name}}, your balance of {{amount}} is due on {{due}}.",
      filter_column: "status",
      filter_value: "unpaid",
    },
    tabs: {
      customers: Array.from({ length: ROW_COUNT }, (_, index) => buildRow(index)),
    },
  };
}

function main(): void {
  const outPath = fileURLToPath(new URL("../fixtures/sheets/large-1000.json", import.meta.url));
  const tmpPath = `${outPath}.tmp`;

  // Validate against the same zod schema the fixture loader uses, before writing, to catch
  // schema drift in the generator itself
  const fixture = sheetFixtureFileSchema.parse(buildFixture());

  // Write to a temp file first and rename, so that even if serialization fails/is interrupted,
  // the already-committed fixture doesn't end up left truncated
  writeFileSync(tmpPath, JSON.stringify(fixture, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, outPath);

  console.log(`Done: ${outPath} (${String(ROW_COUNT)} rows, schema validation passed)`);
}

main();
