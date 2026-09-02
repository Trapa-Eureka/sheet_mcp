// T9 e2e-mock 테스트 전용 서버 프로세스 진입점 (docs/TESTING.md §3 e2e-mock 레이어).
// tests/e2e.test.ts가 이 파일을 별도 프로세스로 스폰해 StdioClientTransport로 연결한다 —
// src/server.ts의 실제 main()과 달리 실제 어댑터(GoogleSheetClient/ResendEmailProvider) 대신
// src/mocks만 주입하므로 네트워크 호출이 없다 (docs/TESTING.md §1).
// 이 파일은 vitest 테스트 파일이 아니라 자식 프로세스로 실행되는 스크립트이므로 tests/support/에 둔다.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../../src/server.js";
import { InMemorySheetClient } from "../../src/mocks/inMemorySheetClient.js";
import { MockNotificationProvider } from "../../src/mocks/mockNotificationProvider.js";
import { InMemorySendLog } from "../../src/mocks/inMemorySendLog.js";
import { FixedClock } from "../../src/mocks/fixedClock.js";

/** tests/e2e.test.ts가 호출하는 시나리오와 짝을 맞춘 고정 픽스처. */
export const E2E_SHEET_ID = "e2e-sheet";

function buildSheetClient(): InMemorySheetClient {
  const client = new InMemorySheetClient();
  client.loadSheet(E2E_SHEET_ID, {
    notifyConfig: {
      data_tab: "customers",
      id_column: "customer_id",
      recipient_column: "email",
      channel: "email",
      subject_template: "[{{shop}}] 안내",
      body_template: "{{name}}님, 안내드립니다.",
      filter_column: "status",
      filter_value: "unpaid",
    },
    tabs: {
      customers: [
        {
          customer_id: "CUST-001",
          name: "Alice",
          email: "alice@example.com",
          shop: "Shop1",
          status: "unpaid",
        },
        {
          customer_id: "CUST-002",
          name: "Bob",
          email: "bob@example.com",
          shop: "Shop1",
          status: "paid",
        },
      ],
    },
  });
  return client;
}

async function main(): Promise<void> {
  const server = createServer({
    sheetClient: buildSheetClient(),
    provider: new MockNotificationProvider(),
    sendLog: new InMemorySendLog(),
    clock: new FixedClock(),
  });
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  console.error("e2e test server 기동 실패:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
