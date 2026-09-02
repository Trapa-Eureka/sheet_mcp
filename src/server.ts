// MCP server entrypoint. Only responsible for registering the 4 tools — business logic lives in
// core/, and here we only assemble zod input/output validation -> core function calls -> result
// serialization (DESIGN §5, task: docs/TASKS.md T8).

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
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
import { DEFAULT_SEND_LOG_LIST_LIMIT } from "./core/types.js";
import {
  getSendLogOutputSchema,
  previewMessagesOutputSchema,
  readRowsOutputSchema,
  sendLogCursorSchema,
  sendLogLimitSchema,
  sendNotificationsOutputSchema,
  sheetIdSchema,
} from "./toolSchemas.js";

/**
 * Assembles the McpServer. Because deps are injected, the e2e-mock tests (T9) can substitute
 * mocks for the real adapters and verify without any network access. Exceptions thrown by tool
 * handlers are automatically wrapped by the SDK (McpServer) into
 * `{isError: true, content:[...]}`, so we don't add a separate try/catch here
 * (error messages from core, such as ConfigParseError, already contain "what's wrong, why + how
 * to fix it").
 */
export function createServer(deps: SendPipelineDeps): McpServer {
  const pipeline = new SendPipeline(deps);
  const server = new McpServer({ name: "sheet-mcp", version: "0.1.0" });

  server.registerTool(
    "read_rows",
    {
      title: "Read sheet target rows",
      description:
        "Reads the send-target rows with notify_config's filter_column/filter_value applied " +
        "(up to a 200-row preview, no sending).",
      inputSchema: { sheetId: sheetIdSchema },
      outputSchema: readRowsOutputSchema,
    },
    async ({ sheetId }) => {
      const result = await readTargetRows(deps.sheetClient, sheetId);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        // Build a new object literal via spread — registerTool's structuredContent requires
        // Record<string, unknown> (an index signature), but passing an interface-typed variable
        // as-is causes a type error because it has no index signature (a known TS behavior).
        structuredContent: { ...result },
      };
    },
  );

  server.registerTool(
    "preview_messages",
    {
      title: "Preview send messages",
      description:
        "Runs the pipeline without actually sending (dry-run) and returns the list of rendered " +
        "messages plus missing-data/duplicate warnings.",
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
      title: "Send notifications",
      description:
        "Sends notifications based on notify_config. Only actually sends when confirm=true AND " +
        "the server process's SEND_MODE environment variable is live (dual safeguard, DESIGN " +
        "§5). If either is not met, returns preview results without actually sending.",
      inputSchema: {
        sheetId: sheetIdSchema,
        confirm: z
          .boolean()
          .describe(
            "true to consent to actually sending. If false or omitted, only a preview is ever performed.",
          ),
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
      title: "Look up send history",
      description:
        "Returns the send history for this sheetId, newest first (default " +
        `${String(DEFAULT_SEND_LOG_LIST_LIMIT)} entries, adjustable via limit). If hasMore=true, ` +
        "pass nextCursor as the cursor in the next call to continue.",
      inputSchema: {
        sheetId: sheetIdSchema,
        limit: sendLogLimitSchema,
        cursor: sendLogCursorSchema,
      },
      outputSchema: getSendLogOutputSchema,
    },
    ({ sheetId, limit, cursor }) => {
      const payload = deps.sendLog.list(sheetId, { limit, cursor });
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: { ...payload },
      };
    },
  );

  return server;
}

/**
 * Assembles SendPipelineDeps using the real adapters. If required environment variables
 * (GOOGLE_SERVICE_ACCOUNT_JSON, RESEND_API_KEY, MAIL_FROM) are missing, each adapter's
 * constructor immediately throws an error explaining what's wrong, why, and how to fix it —
 * this fails fast instead of letting the server come up quietly with a broken config.
 * sendLog is returned separately so main() can explicitly close() it on process exit
 * (docs/ADVERSARIAL_REVIEW_003.md AR-018).
 */
function buildProductionDeps(): { deps: SendPipelineDeps; sendLog: SqliteSendLog } {
  const sendLog = new SqliteSendLog();
  const deps: SendPipelineDeps = {
    sheetClient: new GoogleSheetClient(),
    provider: new ResendEmailProvider(),
    sendLog,
    clock: new SystemClock(),
  };
  return { deps, sendLog };
}

async function main(): Promise<void> {
  // Loads .env if present (does not override actual process environment variables that are
  // already set — dotenv's default behavior). This is never executed when createServer() is
  // imported on its own (e.g. in tests), so it has no effect on test determinism —
  // docs/ADVERSARIAL_REVIEW_003.md AR-012.
  // quiet: true is required — by default dotenv prints an "injected env" banner to stdout, but
  // the MCP stdio transport uses stdout exclusively for JSON-RPC framing. If the banner gets
  // mixed in, the client's JSON parsing breaks starting from the very first message.
  loadDotenv({ quiet: true });

  const { deps, sendLog } = buildProductionDeps();
  const server = createServer(deps);
  // Clean up the DB file handle no matter how the process ends (the parent closing stdin for a
  // natural exit, or either SIGINT/SIGTERM) — AR-018/GAP-008. better-sqlite3's close() is
  // already idempotent (calling it twice throws no error, manually verified), so it's safe to
  // call from overlapping paths. Without explicitly catching SIGINT/SIGTERM, when the 'exit'
  // handler runs can vary by Node version/environment, so the signal paths are handled
  // separately and explicitly to be sure.
  process.on("exit", () => {
    sendLog.close();
  });
  process.on("SIGINT", () => {
    sendLog.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    sendLog.close();
    process.exit(0);
  });

  await server.connect(new StdioServerTransport());
}

// The server is started only when this file is run directly via tsx/node (`npm run dev`). It is
// not started by import alone (e.g. in tests) — this is why createServer() can be tested
// independently without creating real adapters.
//
// process.argv[1] must be resolved through realpathSync to follow symlinks before comparing
// (discovered during T12's npm pack local install verification): the executable that npm
// creates via the `bin` field (`node_modules/.bin/sheet-mcp`) is not an actual file but a
// symlink pointing at dist/server.js. Node's ESM loader always resolves import.meta.url to the
// real file's realpath, whereas process.argv[1] stays as "the path used to invoke it" (the
// symlink path) as-is. Comparing the raw strings without a realpath comparison means this
// condition is always false when run via a symlink (`npx sheet-mcp`, running `sheet-mcp` after
// a global install, and every other path npm creates) — main() is never called at all, and the
// process exits silently with no output and no error whatsoever. This is a serious bug that
// defeats the entire purpose of the deployment, so it was fixed as soon as it was found.
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err: unknown) => {
    console.error("sheet-mcp: server startup failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
