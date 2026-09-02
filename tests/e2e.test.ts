// e2e-mock 테스트 (docs/TESTING.md §3) — MCP 서버를 실제 stdio 자식 프로세스로 띄우고
// MCP SDK Client로 도구 4종을 호출한다. 서버 프로세스는 tests/support/e2eTestServer.ts로,
// 실제 어댑터 대신 목만 주입하므로 네트워크 호출이 없다.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { E2E_SHEET_ID } from "./support/e2eTestServer.js";

const SERVER_SCRIPT = path.resolve(process.cwd(), "tests/support/e2eTestServer.ts");
const TSX_BIN = path.resolve(process.cwd(), "node_modules/.bin/tsx");

// StdioClientTransport 기본 env는 안전 목록만 상속하므로, tsx가 자식 프로세스에서 node/모듈을
// 정상적으로 찾도록 부모 프로세스 env를 그대로 넘긴다(undefined 값은 Record<string,string>에
// 넣을 수 없어 걸러낸다).
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

describe("e2e-mock: MCP stdio 서버 도구 4종", () => {
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

  it("도구 4종이 등록되어 있다", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_send_log",
      "preview_messages",
      "read_rows",
      "send_notifications",
    ]);
  });

  it("read_rows로 filter_column/filter_value가 적용된 대상 행만 확인할 수 있다", async () => {
    const result = await client.callTool({
      name: "read_rows",
      arguments: { sheetId: E2E_SHEET_ID },
    });
    expect(result.isError).toBeFalsy();

    const rows = result.structuredContent as ReadRowsOutput;
    // 픽스처는 status=unpaid 1행, status=paid 1행 — filter_value=unpaid이므로 1행만 매칭된다.
    expect(rows.totalMatched).toBe(1);
    expect(rows.truncated).toBe(false);
  });

  it("preview → send(SEND_MODE 미설정이라 dry-run) → get_send_log 시나리오", async () => {
    const preview = await client.callTool({
      name: "preview_messages",
      arguments: { sheetId: E2E_SHEET_ID },
    });
    expect(preview.isError).toBeFalsy();
    const previewResult = preview.structuredContent as PipelineOutput;
    expect(previewResult.sent).toBe(1);
    expect(previewResult.failed).toBe(0);

    // 이 e2e 서버 프로세스에는 SEND_MODE=live를 넘기지 않았으므로, confirm=true를 줘도
    // 이중 안전장치(DESIGN §5)에 의해 실제로는 발송되지 않아야 한다.
    const send = await client.callTool({
      name: "send_notifications",
      arguments: { sheetId: E2E_SHEET_ID, confirm: true },
    });
    expect(send.isError).toBeFalsy();
    const sendResult = send.structuredContent as SendNotificationsOutput;
    expect(sendResult.liveSend).toBe(false);
    expect(sendResult.notice).toContain("SEND_MODE=live");
    expect(sendResult.sent).toBe(1); // dry-run 미리보기 상 "발송될" 행 수

    const log = await client.callTool({
      name: "get_send_log",
      arguments: { sheetId: E2E_SHEET_ID },
    });
    expect(log.isError).toBeFalsy();
    const logResult = log.structuredContent as SendLogOutput;
    // dry-run만 수행했으므로 실제 발송 기록은 하나도 없어야 한다.
    expect(logResult.entries).toHaveLength(0);
    expect(logResult.hasMore).toBe(false);
  });

  it("존재하지 않는 sheetId는 isError:true와 함께 원인이 담긴 메시지를 반환한다", async () => {
    const result = await client.callTool({
      name: "read_rows",
      arguments: { sheetId: "no-such-sheet" },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("no-such-sheet");
  });
});
