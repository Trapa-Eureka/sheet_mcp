// 사람 전용 운영 CLI — stale claim(commit도 release도 안 된 채 남아 있는 예약)을 조회하고,
// 명시적 확인을 거쳐서만 강제로 회수한다.
// docs/ADVERSARIAL_REVIEW_003_STATUS_GAPS.md STATUS-GAP-003 대응.
//
// scripts/smoke.ts와 달리 이 파일은 npm 패키지로 공개 배포되는 두 번째 bin이다
// (`sheet-mcp-recover`, package.json). smoke.ts는 실제 시트/이메일 자격증명이 있어야만 의미가
// 있어 저장소를 clone한 개발자만 쓰지만, stale claim 복구는 `npx sheet-mcp`로 설치한 운영자도
// 똑같이 필요하다 — 그래서 src/adapters와 같은 상대 경로로 컴파일돼 dist/에 함께 실려야 하는
// src/cli/에 둔다(docs/ADVERSARIAL_REVIEW_004.md AR-019: 예전엔 scripts/에 있어서 공개 tarball에
// 아예 포함되지 않았고, README가 공식 절차로 안내하는데도 npx로 설치한 사람은 실행할 방법이 없었다).
// CI/에이전트 게이트(npm run check)에는 포함하지 않는다 — 로직은 core/adapters 테스트로 이미
// 커버되고, 이 파일 자체는 CLI 파싱/조립만 한다.
//
// 이 CLI가 절대 하지 않는 것:
// - 자동 판단으로 claim을 회수하지 않는다. --confirm 없이는 조회만 하고 아무 것도 지우지 않는다
//   (기본 실행은 DB를 readonly로 연다 — 코드 버그가 있어도 SQLite 자체가 쓰기를 거부한다).
// - 이미 commit(확정 발송)된 기록은 어떤 옵션으로도 지우지 않는다 — forceReleaseStaleClaim() 자체가
//   committed=0인 행만 대상으로 삼는다(src/adapters/sqliteSendLog.ts).
// - 실제로 이메일을 재발송하지 않는다. claim을 회수해도 그 자체로는 아무 것도 발송되지 않는다 —
//   회수 후 재시도하려면 별도로 파이프라인(발송 도구)을 다시 실행해야 한다.
//
// 사용법(레포 clone, 개발용):
//   npm run recover:stale-claim -- \
//     --db ./data/sendlog.db --sheet-id <sheetId> --tab <tab> \
//     --row-key <rowKey> --template-hash <templateHash>
//
// 사용법(npx sheet-mcp 설치, publish 이후):
//   npx sheet-mcp-recover \
//     --db ./data/sendlog.db --sheet-id <sheetId> --tab <tab> \
//     --row-key <rowKey> --template-hash <templateHash>
//   (여기까지만 실행하면 조회만 한다. 아무 것도 바뀌지 않는다.)
//
//   npx sheet-mcp-recover \
//     --db ./data/sendlog.db --sheet-id <sheetId> --tab <tab> \
//     --row-key <rowKey> --template-hash <templateHash> \
//     --older-than-ms 1800000 --reason "provider 대시보드에서 미발송 확인함" --confirm
//   (실제로 claim을 회수한다.)
//
// 옵션:
//   --older-than-ms   기본 1800000(30분). 5분(300000ms) 미만은 --i-understand-the-risk 없이는
//                     거부한다 — 그만큼 최근 claim은 아직 발송이 진행 중일 가능성이 높다.
//   --reason          왜 회수하는지 한 줄 메모. 감사 로그에 그대로 남는다.
//   --confirm         실제로 forceReleaseStaleClaim()을 호출한다. 없으면 조회만.
//   --i-understand-the-risk   --older-than-ms가 운영 최소값보다 짧을 때만 필요.
//
// 모든 실행(조회든 회수든)은 감사 로그(JSON Lines)에 한 줄 남긴다.
// 기본 경로: ./data/recovery-audit.log, RECOVERY_AUDIT_LOG_PATH로 재지정 가능.

import Database from "better-sqlite3";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { detectSchemaVersion, SqliteSendLog } from "../adapters/sqliteSendLog.js";
import { assertValidStaleClaimThreshold } from "../core/types.js";

const DEFAULT_OLDER_THAN_MS = 30 * 60 * 1000; // 30분
// 운영 정책상 보수적 최소값(STATUS-GAP-002) — 이보다 짧은 값은 발송이 아직 진행 중인 claim을
// 잘못 회수할 위험이 매우 높아서 별도 플래그 없이는 막는다.
const OPERATIONAL_MIN_OLDER_THAN_MS = 5 * 60 * 1000; // 5분

interface Args {
  dbPath: string;
  sheetId: string;
  tab: string;
  rowKey: string;
  templateHash: string;
  olderThanMs: number;
  reason?: string;
  confirm: boolean;
  iUnderstandTheRisk: boolean;
}

function printUsage(): void {
  console.error(`사용법:
  npx sheet-mcp-recover --db <path> --sheet-id <id> --tab <tab> \\
    --row-key <rowKey> --template-hash <hash> \\
    [--older-than-ms 1800000] [--reason "..."] [--confirm] [--i-understand-the-risk]

(레포를 clone해 개발 중이라면 npx 대신 npm run recover:stale-claim --)

--confirm 없이 실행하면 조회만 하고 아무 것도 지우지 않습니다.
자세한 안내는 src/cli/recoverStaleClaim.ts 상단 주석을 참고하세요.`);
}

function fail(message: string): never {
  console.error(`오류: ${message}`);
  printUsage();
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    const value = argv[idx + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`${flag} 다음에 값이 필요합니다.`);
    }
    return value;
  };

  const dbPath = get("--db");
  const sheetId = get("--sheet-id");
  const tab = get("--tab");
  const rowKey = get("--row-key");
  const templateHash = get("--template-hash");
  if (!dbPath || !sheetId || !tab || !rowKey || !templateHash) {
    fail("--db, --sheet-id, --tab, --row-key, --template-hash는 모두 필수입니다.");
  }

  const olderThanMsRaw = get("--older-than-ms");
  const olderThanMs = olderThanMsRaw === undefined ? DEFAULT_OLDER_THAN_MS : Number(olderThanMsRaw);

  return {
    dbPath,
    sheetId,
    tab,
    rowKey,
    templateHash,
    olderThanMs,
    reason: get("--reason"),
    confirm: argv.includes("--confirm"),
    iUnderstandTheRisk: argv.includes("--i-understand-the-risk"),
  };
}

function appendAuditLog(entry: Record<string, unknown>): void {
  const logPath = process.env.RECOVERY_AUDIT_LOG_PATH ?? "./data/recovery-audit.log";
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

interface InspectResult {
  version: "none" | "v1_record" | "v2_claim";
  found: boolean;
  committed?: boolean;
  claimedOrSentAt?: string;
  ageMs?: number;
}

// DB를 readonly로 열어 조회한다 — 코드에 버그가 있어도 SQLite 자체가 어떤 쓰기도 거부하므로,
// 이 함수는 구조적으로 아무 것도 지울 수 없다.
function inspect(dbPath: string, args: Args): InspectResult {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const version = detectSchemaVersion(db);
    if (version === "none") return { version, found: false };
    if (version === "v1_record") {
      // v1은 claim/commit 개념이 없다 — 서버를 한 번 기동하면 자동으로 v2로 마이그레이션된다.
      return { version, found: false };
    }
    const row = db
      .prepare<[string, string, string, string], { committed: number; sent_at: string }>(
        `SELECT committed, sent_at FROM send_log
         WHERE sheet_id = ? AND tab = ? AND row_key = ? AND template_hash = ?`,
      )
      .get(args.sheetId, args.tab, args.rowKey, args.templateHash);
    if (!row) return { version, found: false };
    return {
      version,
      found: true,
      committed: row.committed === 1,
      claimedOrSentAt: row.sent_at,
      ageMs: Date.now() - Date.parse(row.sent_at),
    };
  } finally {
    db.close();
  }
}

function printInspectResult(result: InspectResult): void {
  if (result.version === "none") {
    console.log("DB에 send_log 테이블이 아직 없습니다 — claim 기록이 전혀 없습니다.");
    return;
  }
  if (result.version === "v1_record") {
    console.log(
      "이 DB는 아직 이전(v1) 스키마입니다. 서버(또는 이 CLI의 --confirm 실행)를 한 번 기동하면 " +
        "자동으로 새 스키마(v2)로 마이그레이션됩니다(기존 'sent' 기록은 보존, 원본은 백업 " +
        "테이블로 남음 — STATUS-GAP-001). 마이그레이션 후 다시 조회하세요.",
    );
    return;
  }
  if (!result.found) {
    console.log("해당 (sheetId, tab, rowKey, templateHash) 키에 대한 claim 기록이 없습니다.");
    return;
  }
  const ageSec = Math.floor((result.ageMs ?? 0) / 1000);
  if (result.committed) {
    console.log(
      `이미 확정(commit)된 발송 기록입니다 (sent_at=${result.claimedOrSentAt}, ${ageSec}초 전). ` +
        "이 기록은 --confirm을 줘도 forceReleaseStaleClaim()이 절대 지우지 않습니다.",
    );
  } else {
    console.log(
      `아직 확정되지 않은(claimed) 예약입니다 (claimed_at=${result.claimedOrSentAt}, ${ageSec}초 전, ` +
        `${Math.floor(ageSec / 60)}분 경과). --confirm과 충분히 큰 --older-than-ms로 다시 실행하면 ` +
        "회수할 수 있습니다.",
    );
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  // NaN/Infinity/음수/소수는 어떤 조회·삭제도 하기 전에 즉시 거부한다.
  assertValidStaleClaimThreshold(args.olderThanMs);
  if (args.olderThanMs < OPERATIONAL_MIN_OLDER_THAN_MS && !args.iUnderstandTheRisk) {
    fail(
      `--older-than-ms=${args.olderThanMs}는 운영 최소값 ${OPERATIONAL_MIN_OLDER_THAN_MS}ms(5분)보다 ` +
        "짧습니다. 그만큼 최근 claim은 아직 발송이 진행 중일 가능성이 높습니다. 정말 그 값을 쓰려면 " +
        "--i-understand-the-risk 플래그를 추가하세요.",
    );
  }
  if (!existsSync(args.dbPath)) {
    fail(`DB 파일이 없습니다: ${args.dbPath}`);
  }

  const before = inspect(args.dbPath, args);
  printInspectResult(before);
  appendAuditLog({
    action: "inspect",
    dbPath: args.dbPath,
    sheetId: args.sheetId,
    tab: args.tab,
    rowKey: args.rowKey,
    templateHash: args.templateHash,
    olderThanMs: args.olderThanMs,
    reason: args.reason,
    result: before,
  });

  if (!args.confirm) {
    console.log("\n--confirm 없이 실행했으므로 아무 것도 지우지 않았습니다.");
    return;
  }
  if (before.version !== "v2_claim" || !before.found || before.committed) {
    console.log("\n회수할 대상이 없어 --confirm을 적용하지 않았습니다.");
    return;
  }

  // 여기서부터만 실제로 DB를 쓴다 — SqliteSendLog 생성자가 필요하면 v1→v2 마이그레이션도
  // 수행한다(이미 v2로 확인됐으므로 이 경로에서는 마이그레이션이 일어나지 않는다).
  const sendLog = new SqliteSendLog(args.dbPath);
  let released: boolean;
  try {
    released = sendLog.forceReleaseStaleClaim(
      args.sheetId,
      args.tab,
      args.rowKey,
      args.templateHash,
      args.olderThanMs,
    );
  } finally {
    sendLog.close();
  }

  appendAuditLog({
    action: "force_release",
    dbPath: args.dbPath,
    sheetId: args.sheetId,
    tab: args.tab,
    rowKey: args.rowKey,
    templateHash: args.templateHash,
    olderThanMs: args.olderThanMs,
    reason: args.reason,
    released,
  });

  if (released) {
    console.log(
      "\nclaim을 회수했습니다. 재발송하기 전에 반드시 이메일 Provider(Resend) 대시보드에서 이 " +
        `수신자·시각(claimed_at=${before.claimedOrSentAt}) 근처에 실제로 발송된 이메일이 없는지 ` +
        "확인하세요. 확인 없이 바로 재시도하면 실제로는 발송됐던 메일이 중복 발송될 수 있습니다. " +
        "확인이 끝나면 별도로 발송 파이프라인을 다시 실행해 이 행을 재시도하세요.",
    );
  } else {
    console.log(
      "\nclaim을 회수하지 못했습니다 — 조회 시점 이후 다른 실행이 먼저 commit/release했거나, " +
        "조건(committed=0 그리고 충분히 오래됨)을 만족하지 않게 됐을 수 있습니다. 다시 조회해서 " +
        "현재 상태를 확인하세요.",
    );
  }
}

main();
