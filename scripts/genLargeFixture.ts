// fixtures/sheets/large-1000.json 생성 스크립트 — SendPipeline 성능 회귀 가드용 (docs/TESTING.md §4, T7).
// 결정론 유지를 위해 Math.random/Date.now를 쓰지 않고 인덱스 기반으로 값을 만든다.
// 실행: npx tsx scripts/genLargeFixture.ts

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROW_COUNT = 1000;
const SHOPS = ["ABC Trading", "Cebu Hardware", "Davao Supplies"] as const;

function buildRow(index: number): Record<string, string> {
  const n = index + 1;
  const amount = (100 + (n % 50) * 37.25).toFixed(2);
  const dueDay = ((n % 28) + 1).toString().padStart(2, "0");
  return {
    customer_id: `CUST-${String(n).padStart(4, "0")}`,
    name: `Customer ${String(n)}`,
    email: `customer${String(n)}@example.ph`,
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
  const fixture = buildFixture();
  writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n", "utf-8");
  console.log(`생성 완료: ${outPath} (${String(ROW_COUNT)}행)`);
}

main();
