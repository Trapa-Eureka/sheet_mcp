// Server process entrypoint dedicated to the T9 e2e-mock tests (docs/TESTING.md §3 e2e-mock
// layer). tests/e2e.test.ts spawns this file as a separate process and connects to it via
// StdioClientTransport — unlike src/server.ts's real main(), this injects only src/mocks instead
// of the real adapters (GoogleSheetClient/ResendEmailProvider), so there is no network access
// (docs/TESTING.md §1).
// This file is not a vitest test file but a script run as a child process, so it lives under
// tests/support/.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../../src/server.js";
import { InMemorySheetClient } from "../../src/mocks/inMemorySheetClient.js";
import { MockNotificationProvider } from "../../src/mocks/mockNotificationProvider.js";
import { InMemorySendLog } from "../../src/mocks/inMemorySendLog.js";
import { FixedClock } from "../../src/mocks/fixedClock.js";

/** Fixed fixture paired with the scenarios that tests/e2e.test.ts calls. */
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
  console.error("e2e test server startup failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
