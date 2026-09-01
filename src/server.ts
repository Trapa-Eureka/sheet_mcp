// MCP 서버 진입점. 도구 4종 등록만 담당한다 — 비즈니스 로직은 core/에 있고 여기서는
// zod 입력/출력 검증 -> core 함수 호출 -> 결과 직렬화만 조립한다 (DESIGN §5, 태스크: docs/TASKS.md T8).

import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GoogleSheetClient } from "./adapters/googleSheetClient.js";
import { ResendEmailProvider } from "./adapters/resendProvider.js";
import { SqliteSendLog } from "./adapters/sqliteSendLog.js";
import { SystemClock } from "./adapters/systemClock.js";
import {
  buildDryRunNotice,
  resolveDryRun,
  SendPipeline,
  type SendPipelineDeps,
} from "./core/pipeline.js";
import { readTargetRows } from "./core/readRows.js";
import {
  getSendLogOutputSchema,
  previewMessagesOutputSchema,
  readRowsOutputSchema,
  sendNotificationsOutputSchema,
  sheetIdSchema,
} from "./toolSchemas.js";

/**
 * McpServer를 조립한다. deps를 주입받으므로 e2e-mock 테스트(T9)에서는 실제 어댑터 대신 목을 넣어
 * 네트워크 없이 검증할 수 있다. 도구 핸들러가 던지는 예외는 SDK(McpServer)가 자동으로
 * `{isError: true, content:[...]}`로 감싸므로, 여기서 별도 try/catch를 두지 않는다
 * (ConfigParseError 등 core의 에러 메시지가 이미 "무엇이 왜 + 어떻게 고치나"를 담고 있다).
 */
export function createServer(deps: SendPipelineDeps): McpServer {
  const pipeline = new SendPipeline(deps);
  const server = new McpServer({ name: "sheet-mcp", version: "0.1.0" });

  server.registerTool(
    "read_rows",
    {
      title: "시트 대상 행 읽기",
      description:
        "notify_config의 filter_column/filter_value가 적용된 발송 대상 행을 읽는다 " +
        "(최대 200행 미리보기, 발송 없음).",
      inputSchema: { sheetId: sheetIdSchema },
      outputSchema: readRowsOutputSchema,
    },
    async ({ sheetId }) => {
      const result = await readTargetRows(deps.sheetClient, sheetId);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        // 스프레드로 새 객체 리터럴을 만든다 — registerTool의 structuredContent는
        // Record<string, unknown>(인덱스 시그니처)을 요구하는데, 인터페이스 타입 변수는 그대로
        // 넘기면 인덱스 시그니처가 없다는 이유로 타입 에러가 난다(TS의 알려진 동작).
        structuredContent: { ...result },
      };
    },
  );

  server.registerTool(
    "preview_messages",
    {
      title: "발송 메시지 미리보기",
      description:
        "실제 발송 없이(dry-run) 파이프라인을 실행해 렌더된 메시지 목록과 결측/중복 경고를 반환한다.",
      inputSchema: { sheetId: sheetIdSchema },
      outputSchema: previewMessagesOutputSchema,
    },
    async ({ sheetId }) => {
      const result = await pipeline.run(sheetId, { dryRun: true });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: { ...result },
      };
    },
  );

  server.registerTool(
    "send_notifications",
    {
      title: "알림 발송",
      description:
        "notify_config 기준으로 알림을 발송한다. confirm=true이고 서버 프로세스 환경변수 " +
        "SEND_MODE=live일 때만 실발송한다 (이중 안전장치, DESIGN §5). 하나라도 아니면 실제 발송 " +
        "없이 미리보기 결과를 반환한다.",
      inputSchema: {
        sheetId: sheetIdSchema,
        confirm: z
          .boolean()
          .describe("실제 발송에 동의하면 true. false거나 생략하면 항상 미리보기만 수행한다."),
      },
      outputSchema: sendNotificationsOutputSchema,
    },
    async ({ sheetId, confirm }) => {
      const dryRun = resolveDryRun(process.env.SEND_MODE, confirm);
      const result = await pipeline.run(sheetId, { dryRun });
      const notice = buildDryRunNotice(dryRun);
      const payload = {
        liveSend: !dryRun,
        ...(notice !== undefined ? { notice } : {}),
        ...result,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    "get_send_log",
    {
      title: "발송 이력 조회",
      description: "이 sheetId에 대한 SQLite 발송 이력을 반환한다.",
      inputSchema: { sheetId: sheetIdSchema },
      outputSchema: getSendLogOutputSchema,
    },
    ({ sheetId }) => {
      const entries = deps.sendLog.list(sheetId);
      return {
        content: [{ type: "text", text: JSON.stringify(entries, null, 2) }],
        structuredContent: { entries },
      };
    },
  );

  return server;
}

/**
 * 실제 어댑터로 SendPipelineDeps를 조립한다. 필수 환경변수(GOOGLE_SERVICE_ACCOUNT_JSON,
 * RESEND_API_KEY, MAIL_FROM)가 없으면 각 어댑터 생성자가 무엇이 왜 틀렸고 어떻게 고치는지 담은
 * 에러를 즉시 던진다 — 설정이 잘못된 채로 서버가 조용히 뜨는 대신 fail fast한다.
 */
function buildProductionDeps(): SendPipelineDeps {
  return {
    sheetClient: new GoogleSheetClient(),
    provider: new ResendEmailProvider(),
    sendLog: new SqliteSendLog(),
    clock: new SystemClock(),
  };
}

async function main(): Promise<void> {
  const server = createServer(buildProductionDeps());
  await server.connect(new StdioServerTransport());
}

// tsx/node로 이 파일을 직접 실행할 때만(`npm run dev`) 서버를 기동한다. import(테스트 등)만으로는
// 실행되지 않는다 — createServer()가 실제 어댑터 생성 없이 독립적으로 테스트 가능한 이유다.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error("sheet-mcp: 서버 기동 실패:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
