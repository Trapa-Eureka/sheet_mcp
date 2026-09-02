// Regression guard discovered during T12 (npm pack local install verification): the executable
// npm creates via the `bin` field (`node_modules/.bin/sheet-mcp`) is a **symlink** pointing at
// dist/server.js. Node's ESM loader always resolves import.meta.url to the real file's realpath,
// but process.argv[1] stays as "the path used to invoke it" (the symlink path) as-is — comparing
// the raw strings without a realpath comparison means the entrypoint guard is always false when
// run via a symlink, so main() is never called at all and the process exits silently with no
// output and no error (see the entrypoint guard comment in src/server.ts).
//
// To make this verifiable without a dist/ build artifact, we run src/server.ts directly via tsx,
// but wrap that path in a symlink to reproduce the same situation as npm's bin mechanism. There
// is no network access — it's enough for main() to reach the point where it fails fast on
// GOOGLE_SERVICE_ACCOUNT_JSON validation (reaching that point is itself proof that "main() was
// called" — before the fix, this point was never reached at all and the process exited
// silently).
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER_SRC = join(process.cwd(), "src/server.ts");
const TSX_BIN = join(process.cwd(), "node_modules/.bin/tsx");

describe("server entrypoint guard — main() is called even when run via a symlink (reproduces npm's bin mechanism)", () => {
  it(
    "reaches the GOOGLE_SERVICE_ACCOUNT_JSON fail-fast error even when run through a symlink " +
      "like node_modules/.bin/<name> (= proof that main() was called)",
    () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "sheet-mcp-symlink-entrypoint-"));
      const symlinkPath = join(tmpDir, "sheet-mcp");
      const isolatedCwd = join(tmpDir, "cwd"); // fully isolate .env/SEND_LOG_PATH relative paths from the repo
      mkdirSync(isolatedCwd, { recursive: true });

      try {
        symlinkSync(SERVER_SRC, symlinkPath);

        // Inherit the parent env (needed for tsx to find node/modules), but strip out all
        // actual credential-related variables to reliably hit the fail-fast path.
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
          if (value === undefined) continue;
          if (
            key === "GOOGLE_SERVICE_ACCOUNT_JSON" ||
            key === "RESEND_API_KEY" ||
            key === "MAIL_FROM"
          ) {
            continue;
          }
          env[key] = value;
        }
        env.SEND_LOG_PATH = join(tmpDir, "sendlog.db");

        let stdout = "";
        let stderr = "";
        let exitCode = 0;
        try {
          stdout = execFileSync(TSX_BIN, [symlinkPath], {
            cwd: isolatedCwd,
            env,
            input: "",
            timeout: 15_000,
            encoding: "utf8",
          });
        } catch (err) {
          const spawnErr = err as { status?: number; stdout?: string; stderr?: string };
          exitCode = spawnErr.status ?? 1;
          stdout = spawnErr.stdout ?? "";
          stderr = spawnErr.stderr ?? "";
        }

        expect(exitCode).toBe(1);
        expect(stderr).toContain("The GOOGLE_SERVICE_ACCOUNT_JSON environment variable is not set");
        // Before the fix, output was completely empty (since main() itself was never called) —
        // this also guards against that regression directly.
        expect(stdout + stderr).not.toBe("");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
