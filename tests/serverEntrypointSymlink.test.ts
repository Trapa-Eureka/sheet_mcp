// T12(npm pack 로컬 설치 검증) 중 발견한 회귀 가드: npm이 `bin` 필드로 만드는 실행 파일
// (`node_modules/.bin/sheet-mcp`)은 dist/server.js를 가리키는 **심볼릭 링크**다. Node ESM 로더는
// import.meta.url을 항상 실제 파일의 realpath로 해석하지만 process.argv[1]은 "호출에 쓰인 경로"
// (심볼릭 링크 경로) 그대로 남는다 — realpath 비교 없이 문자열을 그대로 비교하면 심볼릭 링크로
// 실행했을 때 진입점 가드가 항상 false가 되어 main()이 전혀 호출되지 않고 프로세스가 아무 출력도,
// 에러도 없이 조용히 종료된다(src/server.ts 진입점 가드 주석 참고).
//
// dist/ 빌드 산출물 없이도 검증 가능하도록 src/server.ts를 tsx로 직접 실행하되, 그 경로를 심볼릭
// 링크로 감싸 npm의 bin 메커니즘과 동일한 상황을 재현한다. 네트워크 호출은 없다 — main()이
// GOOGLE_SERVICE_ACCOUNT_JSON 검증에서 fail-fast하는 지점까지만 도달하면 충분하다(그 지점까지
// 도달했다는 것 자체가 "main()이 호출됐다"는 증거다 — 고치기 전에는 이 지점에 아예 도달하지 못하고
// 조용히 종료됐다).
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER_SRC = join(process.cwd(), "src/server.ts");
const TSX_BIN = join(process.cwd(), "node_modules/.bin/tsx");

describe("서버 진입점 가드 — 심볼릭 링크로 실행해도 main()이 호출된다(npm bin 메커니즘 재현)", () => {
  it(
    "node_modules/.bin/<name> 같은 심볼릭 링크를 통해 실행해도 " +
      "GOOGLE_SERVICE_ACCOUNT_JSON fail-fast 에러까지 도달한다(=main()이 호출됐다는 증거)",
    () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "sheet-mcp-symlink-entrypoint-"));
      const symlinkPath = join(tmpDir, "sheet-mcp");
      const isolatedCwd = join(tmpDir, "cwd"); // .env/SEND_LOG_PATH 상대경로를 레포와 완전히 분리
      mkdirSync(isolatedCwd, { recursive: true });

      try {
        symlinkSync(SERVER_SRC, symlinkPath);

        // 부모 env를 상속하되(tsx가 node/모듈을 찾으려면 필요) 실제 자격증명 관련 변수는
        // 전부 제거해 확실히 fail-fast 경로를 타게 한다.
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
        expect(stderr).toContain("GOOGLE_SERVICE_ACCOUNT_JSON 환경변수가 없습니다");
        // 고치기 전에는 출력이 완전히 비어 있었다(main() 자체가 호출되지 않았으므로) — 그 회귀를
        // 직접적으로도 가드한다.
        expect(stdout + stderr).not.toBe("");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
