// 사람 전용 수동 스모크 스크립트. 실제 시트 + 실제 이메일 어댑터를 쓴다 —
// CI/에이전트 게이트(npm run check)에 포함하지 않는다 (docs/TESTING.md §3 manual smoke).
//
// 흐름: dry-run 미리보기(항상 실행, 발송 없음) -> 대상이 정확히 1행인지 확인 ->
// SEND_MODE=live 그리고 SMOKE_CONFIRM_SEND=1 둘 다일 때만 실제 이메일 1건 발송
// (MCP 도구의 이중 안전장치와 동일한 판정 로직을 그대로 재사용, DESIGN §5).
//
// 실행 예:
//   npm run smoke                                          # 미리보기만 (항상 안전)
//   SEND_MODE=live SMOKE_CONFIRM_SEND=1 npm run smoke       # 실제 발송 (대상 1행일 때만)

import { config as loadDotenv } from "dotenv";
import { GoogleSheetClient } from "../src/adapters/googleSheetClient.js";
import { ResendEmailProvider } from "../src/adapters/resendProvider.js";
import { SqliteSendLog } from "../src/adapters/sqliteSendLog.js";
import { SystemClock } from "../src/adapters/systemClock.js";
import {
  buildDryRunNotice,
  resolveDryRun,
  SendPipeline,
  type PipelineRowDetail,
} from "../src/core/pipeline.js";

// 기본값은 비민감 메타데이터(rowKey/상태)만 출력한다 — 실제 고객 이름/이메일/금액 등이
// 터미널 기록이나 세션 로그에 남지 않도록 (docs/ADVERSARIAL_REVIEW_002.md AR-009).
// showValues는 매개변수로 받는다 — 모듈 로드 시점의 상수로 두면 dotenv가 아직 .env를 읽기 전이라
// .env에만 SMOKE_SHOW_VALUES=1을 적은 경우 반영되지 않는 버그가 있었다
// (docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md GAP-004).
function formatDetail(detail: PipelineRowDetail, showValues: boolean): string {
  if (showValues) {
    const parts = [
      `rowKey=${detail.rowKey}`,
      `status=${detail.status}`,
      `to=${detail.to ?? "-"}`,
      `subject=${detail.subject ?? "-"}`,
      `error=${detail.error ?? "-"}`,
    ];
    return `  - ${parts.join(" ")}`;
  }
  const hint = detail.error ? " (에러 있음 — 상세는 SMOKE_SHOW_VALUES=1로 다시 실행)" : "";
  return `  - rowKey=${detail.rowKey} status=${detail.status}${hint}`;
}

async function main(): Promise<void> {
  // .env가 있으면 로드한다 — 예전에는 이 호출이 없어서 README를 그대로 따라도 .env 값이 프로세스에
  // 들어오지 않았다 (docs/ADVERSARIAL_REVIEW_003.md AR-012). quiet: true로 dotenv 자체 배너를 꺼서
  // [smoke] 로그와 섞이지 않게 한다(server.ts와 달리 stdout 프로토콜 제약은 없지만 일관성을 위해).
  loadDotenv({ quiet: true });

  // loadDotenv() 이후에 읽어야 .env로만 설정한 값도 반영된다(GAP-004).
  const showValues = process.env.SMOKE_SHOW_VALUES === "1";

  const sheetId = process.env.SMOKE_SHEET_ID;
  if (!sheetId) {
    console.log(
      "SMOKE_SHEET_ID 환경변수가 없어 스모크를 건너뜁니다. " +
        ".env에 SMOKE_SHEET_ID=<테스트용 구글시트 ID>를 설정하고 다시 실행하세요 " +
        "(시트 ID는 스프레드시트 URL의 /d/<이 부분>/edit). " +
        "해당 시트는 GOOGLE_SERVICE_ACCOUNT_JSON의 서비스 계정 이메일에 편집자로 공유되어 있어야 합니다.",
    );
    return;
  }

  const sendLog = new SqliteSendLog();
  try {
    const pipeline = new SendPipeline({
      sheetClient: new GoogleSheetClient(),
      provider: new ResendEmailProvider(),
      sendLog,
      clock: new SystemClock(),
    });

    console.log(`[smoke] 미리보기(dry-run) 실행 중 — sheetId=${sheetId}...`);
    const preview = await pipeline.run(sheetId, { dryRun: true });
    console.log(
      `[smoke] 미리보기 결과: sent(발송될)=${String(preview.sent)} failed=${String(preview.failed)} skipped(중복)=${String(preview.skipped)}`,
    );
    preview.details.forEach((detail) => console.log(formatDetail(detail, showValues)));

    if (preview.sent === 0) {
      console.log("[smoke] 발송될 대상 행이 없습니다. 여기서 종료합니다 (발송 없음).");
      return;
    }

    // 스모크는 "실제 이메일 1건"만 보내는 게 목표다(docs/TASKS.md T10) — 실수로 실제 고객 여러 명에게
    // 스모크성 메일이 나가는 사고를 막기 위해, 대상이 2행 이상이면 여기서 멈춘다.
    if (preview.sent > 1) {
      console.log(
        `[smoke] 대상 행이 ${String(preview.sent)}개라 중단합니다 — 스모크는 정확히 1행만 대상으로 해야 ` +
          "합니다. notify_config의 filter_column/filter_value를 좁히거나, 스모크 전용 시트에 테스트용 " +
          "행 1개만 남기고 나머지 unpaid 행은 잠시 지우거나 status를 바꿔두세요.",
      );
      return;
    }

    const confirm = process.env.SMOKE_CONFIRM_SEND === "1";
    const dryRun = resolveDryRun(process.env.SEND_MODE, confirm);
    const notice = buildDryRunNotice(dryRun);
    if (notice) {
      console.log(`[smoke] ${notice}`);
      console.log(
        "[smoke] (스모크에서는 confirm이 SMOKE_CONFIRM_SEND=1 환경변수로 주어집니다.) " +
          "실제 발송하려면: SEND_MODE=live SMOKE_CONFIRM_SEND=1 npm run smoke",
      );
      return;
    }

    console.log(
      "[smoke] SEND_MODE=live && SMOKE_CONFIRM_SEND=1 확인됨 — 실제 이메일 1건을 발송합니다...",
    );
    const sendResult = await pipeline.run(sheetId, { dryRun: false });
    console.log(
      `[smoke] 발송 결과: sent=${String(sendResult.sent)} failed=${String(sendResult.failed)} skipped=${String(sendResult.skipped)}`,
    );
    sendResult.details.forEach((detail) => console.log(formatDetail(detail, showValues)));

    const logPage = sendLog.list(sheetId);
    console.log(
      `[smoke] SendLog(${sheetId}) 누적 기록(최신 ${String(logPage.entries.length)}건 조회, ` +
        `더 있음=${String(logPage.hasMore)}): 확인 완료.`,
    );
  } finally {
    // 사람이 반복 실행하는 스크립트라 DB 파일 핸들을 명시적으로 정리한다 (AR-018).
    sendLog.close();
  }
}

main().catch((err: unknown) => {
  console.error("[smoke] 실패:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
