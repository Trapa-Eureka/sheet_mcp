// 사람 전용 수동 스모크 스크립트. 실제 시트를 사용한다 — CI/에이전트 게이트에 포함하지 않는다.
// 현재는 T3 범위(GoogleSheetClient 읽기 경로)만 구현됨.
// 발송까지 포함한 전체 파이프라인 스모크(dry-run 미리보기 + live 게이트)는 T10에서 완성한다
// (docs/TASKS.md T10, docs/TESTING.md §3).

import { GoogleSheetClient } from "../src/adapters/googleSheetClient.js";

async function main(): Promise<void> {
  const sheetId = process.env.SMOKE_SHEET_ID;
  if (!sheetId) {
    console.log(
      "SMOKE_SHEET_ID 환경변수가 없어 읽기 스모크를 건너뜁니다. " +
        ".env에 SMOKE_SHEET_ID=<테스트용 구글시트 ID>를 설정하고 다시 실행하세요 " +
        "(시트 ID는 스프레드시트 URL의 /d/<이 부분>/edit). " +
        "해당 시트는 GOOGLE_SERVICE_ACCOUNT_JSON의 서비스 계정 이메일에 편집자로 공유되어 있어야 합니다. " +
        "발송까지 포함한 전체 스모크는 T10에서 구현됩니다.",
    );
    return;
  }

  const client = new GoogleSheetClient();

  console.log(`[smoke] readConfig(${sheetId}) 호출 중...`);
  const config = await client.readConfig(sheetId);
  console.log("[smoke] notify_config:", config);

  const dataTab = config.data_tab;
  if (!dataTab) {
    console.log(
      "[smoke] notify_config에 data_tab 키가 없어 readRows는 건너뜁니다. " +
        "notify_config 탭에 data_tab=<데이터 탭 이름> 행을 추가하세요.",
    );
    return;
  }

  console.log(`[smoke] readRows(${sheetId}, ${dataTab}) 호출 중...`);
  const rows = await client.readRows(sheetId, dataTab);
  console.log(`[smoke] ${String(rows.length)}행 읽음.`);

  const first = rows[0];
  if (!first) {
    console.log("[smoke] 데이터 없음.");
    return;
  }

  // 기본값은 비민감 메타데이터만 출력한다 — 실제 고객 이름/이메일/금액 등이 터미널 기록이나
  // 세션 로그에 남지 않도록 (docs/ADVERSARIAL_REVIEW_002.md AR-009).
  console.log(
    `[smoke] 첫 행 rowIndex=${String(first.rowIndex)}, 컬럼: ${Object.keys(first.values).join(", ")}`,
  );

  if (process.env.SMOKE_SHOW_VALUES === "1") {
    console.log(
      "[smoke] SMOKE_SHOW_VALUES=1로 명시적 요청됨 — 첫 행 실제 값(민감정보 포함 가능):",
      first.values,
    );
  } else {
    console.log(
      "[smoke] 실제 값은 출력하지 않습니다. 필요하면 SMOKE_SHOW_VALUES=1로 다시 실행하세요 " +
        "(터미널/세션 로그에 실제 고객 데이터가 남을 수 있으니 신중히 사용하세요).",
    );
  }
}

main().catch((err: unknown) => {
  console.error("[smoke] 실패:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
