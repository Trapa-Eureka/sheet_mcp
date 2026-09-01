// fixtures/sheets/large-1000.json 생성 스크립트 — SendPipeline 성능 회귀 가드용 (docs/TESTING.md §4, T7).
// 결정론 유지를 위해 Math.random/Date.now를 쓰지 않고 인덱스 기반으로 값을 만든다.
// 실행: npx tsx scripts/genLargeFixture.ts

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
    // .invalid는 RFC 2606 예약 도메인 — 실발송 안전장치가 뚫리더라도 실제 수신자에게 닿지 않는다
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

  // 생성기 자체의 스키마 드리프트를 잡기 위해, 쓰기 전에 fixture 로더와 동일한 zod 스키마로 검증한다
  const fixture = sheetFixtureFileSchema.parse(buildFixture());

  // 직렬화 실패/중단 시에도 기존 커밋된 fixture가 잘린 채로 남지 않도록 임시 파일에 먼저 쓰고 rename한다
  writeFileSync(tmpPath, JSON.stringify(fixture, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, outPath);

  console.log(`생성 완료: ${outPath} (${String(ROW_COUNT)}행, 스키마 검증 통과)`);
}

main();
