// e2e-mock tests (docs/TESTING.md §3) — spawns the MCP server as a real stdio child process and
// calls the 4 tools via the MCP SDK Client. The server process is tests/support/e2eTestServer.ts,
// which injects only mocks instead of the real adapters, so there is no network access.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { E2E_SHEET_ID } from "./support/e2eTestServer.js";

const SERVER_SCRIPT = path.resolve(process.cwd(), "tests/support/e2eTestServer.ts");
const TSX_BIN = path.resolve(process.cwd(), "node_modules/.bin/tsx");

// StdioClientTransport's default env only inherits a safe allowlist, so we pass the parent
// process's env through as-is so tsx can properly find node/modules in the child process
// (undefined values are filtered out since they can't go into a Record<string,string>).
function parentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface ReadRowsOutput {
  rows: unknown[];
  totalMatched: number;
  truncated: boolean;
}

interface PipelineOutput {
  sent: number;
  failed: number;
  skipped: number;
  logFailed: number;
  totalMatched: number;
  truncated: boolean;
  details: unknown[];
}

interface SendNotificationsOutput extends PipelineOutput {
  liveSend: boolean;
  notice?: string;
}

interface SendLogOutput {
  entries: unknown[];
  hasMore: boolean;
  nextCursor?: string;
}

describe("e2e-mock: MCP stdio server's 4 tools", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: TSX_BIN,
      args: [SERVER_SCRIPT],
      cwd: process.cwd(),
      env: parentEnv(),
    });
    client = new Client({ name: "e2e-test-client", version: "0.0.1" });
    await client.connect(transport);
  }, 20000);

  afterAll(async () => {
    await client.close();
  });

  it("all 4 tools are registered", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_send_log",
      "preview_messages",
      "read_rows",
      "send_notifications",
    ]);
  });

  it("read_rows returns only target rows with filter_column/filter_value applied", async () => {
    const result = await client.callTool({
      name: "read_rows",
      arguments: { sheetId: E2E_SHEET_ID },
    });
    expect(result.isError).toBeFalsy();

    const rows = result.structuredContent as ReadRowsOutput;
    // The fixture has 1 row with status=unpaid and 1 row with status=paid — since
    // filter_value=unpaid, only 1 row matches.
    expect(rows.totalMatched).toBe(1);
    expect(rows.truncated).toBe(false);
  });

  it("preview → send (dry-run since SEND_MODE is unset) → get_send_log scenario", async () => {
    const preview = await client.callTool({
      name: "preview_messages",
      arguments: { sheetId: E2E_SHEET_ID },
    });
    expect(preview.isError).toBeFalsy();
    const previewResult = preview.structuredContent as PipelineOutput;
    expect(previewResult.sent).toBe(1);
    expect(previewResult.failed).toBe(0);

    // This e2e server process was not given SEND_MODE=live, so even with confirm=true, the
    // dual safeguard (DESIGN §5) means it must not actually send.
    const send = await client.callTool({
      name: "send_notifications",
      arguments: { sheetId: E2E_SHEET_ID, confirm: true },
    });
    expect(send.isError).toBeFalsy();
    const sendResult = send.structuredContent as SendNotificationsOutput;
    expect(sendResult.liveSend).toBe(false);
    expect(sendResult.notice).toContain("SEND_MODE=live");
    expect(sendResult.sent).toBe(1); // the number of rows that "would be sent" per the dry-run preview

    const log = await client.callTool({
      name: "get_send_log",
      arguments: { sheetId: E2E_SHEET_ID },
    });
    expect(log.isError).toBeFalsy();
    const logResult = log.structuredContent as SendLogOutput;
    // Only a dry-run was performed, so there must be zero actual send records.
    expect(logResult.entries).toHaveLength(0);
    expect(logResult.hasMore).toBe(false);
  });

  it("a nonexistent sheetId returns isError:true with a message containing the cause", async () => {
    const result = await client.callTool({
      name: "read_rows",
      arguments: { sheetId: "no-such-sheet" },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("no-such-sheet");
  });
});
