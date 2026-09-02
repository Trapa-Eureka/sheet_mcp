# 적대적 검수 리포트 004 — 수정 완료 기록

- 대상 리포트: `docs/ADVERSARIAL_REVIEW_004.md` (검수일 2026-09-02, 기준 리비전 `be2b38f`)
- 이 문서 작성일: 2026-09-02
- 원칙: `docs/ADVERSARIAL_REVIEW_004.md`는 감사 기록이므로 수정하지 않는다. 이 문서는 그 리포트가
  지적한 AR-019~027 각 항목에 대해 실제로 무엇을 고쳤고 어떻게 검증했는지만 기록한다.

## 요약

| 항목 | 심각도 | 상태 | 비고 |
| --- | --- | --- | --- |
| AR-019 | 높음(배포 차단) | ✅ 해소 | 복구 CLI를 `src/cli/`로 이동, 두 번째 bin으로 공개 |
| AR-020 | 높음(배포 차단) | ✅ 해소 | MIT LICENSE 추가 |
| AR-021 | 중간(배포 전 필수) | ✅ 해소 | `bin` 경로 정규화, publish dry-run 경고 0건 |
| AR-022 | 중간 | ✅ 해소 | `MAX_PIPELINE_ROWS` 상한 + truncated/totalMatched 반환 |
| AR-023 | 중간 | ✅ 해소 | Google/Resend 호출에 timeout 추가 |
| AR-024 | 중간(릴리스 완료 차단) | ⏸ 사람 전용, 미해소 | T10의 기존 `MANUAL SMOKE PENDING`과 동일 항목 |
| AR-025 | 낮음 | ✅ 해소 | package.json 메타데이터 보강 |
| AR-026 | 낮음 | ✅ 해소 | 빌드에서 `src/mocks` 제외 |
| AR-027 | 낮음 | ✅ 해소 | README에 clone 전용 문서 링크임을 명시 |

AR-019~023, 025~027은 전부 코드/설정/문서 변경과 실측 검증(아래)으로 해소됐다. **AR-024만 사람이
실제 자격증명으로 수행해야 하는 항목이라 코드로 해소할 수 없고, 여전히 PENDING이다** — publish는
그때까지 보류한다(`docs/ADVERSARIAL_REVIEW_004.md` §8 추적 규칙).

> **2026-09-02 후속 갱신**: 위 표/문단은 이 문서 작성 당시(코드 수정 직후) 상태다. **AR-024는 같은
> 날 이후 실제 수동 스모크로 완료됐다** — 자세한 내용은 아래 "남은 일" 절의 후속 메모와
> `docs/TASKS.md` T10 참고.

## 항목별 조치와 검증

### AR-019 — 공개 패키지에 복구 스크립트가 없음

- 조치: `scripts/recoverStaleClaim.ts`를 `src/cli/recoverStaleClaim.ts`로 옮겨 `tsconfig.build.json`
  컴파일 대상(`src/`)에 포함시켰다. `package.json.bin`에 `"sheet-mcp-recover": "dist/cli/recoverStaleClaim.js"`
  를 추가하고, `scripts/postbuild.mjs`가 `dist/server.js`와 함께 `dist/cli/recoverStaleClaim.js`에도
  shebang을 붙이도록 `BIN_TARGETS` 배열로 일반화했다. 레포 clone 경로(`npm run recover:stale-claim`)
  도 새 경로(`src/cli/recoverStaleClaim.ts`)를 가리키도록 갱신했다. `README.md`/`docs/DESIGN.md`
  §6 안내 문구를 "clone 개발 환경 → `npm run recover:stale-claim`, `npx sheet-mcp` 설치 →
  `npx sheet-mcp-recover`" 두 갈래로 갱신했다.
- 안전장치 유지: dry-run 기본값, `--older-than-ms` 5분 미만 거부, `data/recovery-audit.log` 감사
  로그 등 기존 사람 전용 안전장치는 파일 이동만 했을 뿐 로직 변경 없이 그대로 유지된다.
- **완전 해소 기준 검증(실측)**: `npm run build` 후 `npm pack`으로 실제 tarball을 만들어 별도 임시
  디렉터리에 `npm install <tarball>`로 설치하고, devDependencies(`tsx`, TypeScript 등) 없이
  `./node_modules/.bin/sheet-mcp`와 `./node_modules/.bin/sheet-mcp-recover`를 각각 인자 없이
  실행했다. 전자는 기존과 동일하게 `GOOGLE_SERVICE_ACCOUNT_JSON` fail-fast 에러(exit 1)를,
  후자는 필수 인자 안내 메시지(exit 1)를 정상적으로 출력했다 — 두 bin 모두 실제 설치 환경에서
  동작함을 확인했다(T12에서 심볼릭 링크 버그를 잡았던 것과 같은 방식의 실측 검증).

### AR-020 — LICENSE 부재

- 조치: 저장소 루트에 `LICENSE`(MIT, 2026 Trapa-Eureka) 추가, `package.json`에 `"license": "MIT"`
  필드 추가.
- 검증: `npm pack --dry-run`/`npm pack` 파일 목록에 `LICENSE`(1.1kB)가 실제로 포함됨을 확인했다.

### AR-021 — `npm publish`가 `bin` 경로를 자동 교정함

- 조치: `package.json.bin`의 값에서 선행 `./`를 제거해 `npm pkg fix`가 제시한 정규형
  (`dist/server.js`, `dist/cli/recoverStaleClaim.js`)과 일치시켰다.
- 검증: `npm run build` 후 `npm publish --dry-run --json` 실행 결과 이전에 나타났던
  `"bin[sheet-mcp]" script name ... was invalid and removed` 경고가 더 이상 나타나지 않는다
  (남는 출력은 dry-run 자체의 정상 동작인 "로그인 필요" 안내뿐). `dist/server.js`,
  `dist/cli/recoverStaleClaim.js` 둘 다 shebang이 정상적으로 붙어 있음을 직접 확인했다.

### AR-022 — preview/send 행 수 무제한

- 조치: `src/core/pipeline.ts`에 `MAX_PIPELINE_ROWS = 1000` 상수를 추가하고, filter 적용 후 매칭된
  행 수가 이를 넘으면: dry-run은 앞 1000행만 잘라 미리보기하며 `totalMatched`/`truncated`로 실제
  매칭 수와 잘림 여부를 알리고, live는 **한 건도 발송하지 않고** 명확한 에러로 즉시 중단한다(부분
  발송 사고 방지). `PipelineResult`/`pipelineResultShape`(zod)에 `totalMatched`/`truncated` 필드를
  추가했다.
- 문서: `docs/DESIGN.md` §4 파이프라인 흐름에 절단 정책을 반영했다.
- 검증: `npm run check`의 `tests/pipeline.test.ts`에 회귀 테스트를 추가해 (a) 1000행 이하는 전부
  처리, (b) 1000행 초과 dry-run은 잘라서 반환하며 `truncated:true`, (c) 1000행 초과 live는
  provider.send()/claim() 등 어떤 부수효과도 없이 즉시 에러를 던지는지 확인한다.

### AR-023 — 외부 요청에 timeout 없음

- 조치: `src/adapters/googleSheetClient.ts`에 `withTimeout()` 헬퍼와
  `DEFAULT_GOOGLE_SHEETS_TIMEOUT_MS = 30_000`을 추가해 `readConfig`/`readRows`/`readHeader`/
  `ensureStatusColumns`/`writeStatus`의 모든 Sheets API 호출을 감쌌다. `src/adapters/resendProvider.ts`
  는 같은 패턴의 `withTimeout()` + `DEFAULT_RESEND_TIMEOUT_MS = 30_000`에 더해 실제 `fetch`에
  `AbortSignal.timeout()`도 함께 넘겨 소켓 자체를 취소한다(목 fetch가 signal을 무시해도
  `withTimeout()`의 race가 테스트를 반드시 끝낸다). 둘 다 생성자 옵션(`timeoutMs`)으로 재정의
  가능해 테스트에서 "응답이 영영 안 오는" 상황을 짧은 시간 안에 재현할 수 있다.
- 정책: timeout은 해당 행을 `failed`로 분류하고 claim을 release해 재시도를 허용하되, Resend
  timeout 에러 메시지에는 "실제로는 이미 발송됐을 수 있으니 재시도 전에 대시보드를 확인하라"는
  불확실성 경고를 명시한다(리포트가 언급한 `delivery_unknown` 별도 상태 도입 대신, 지금은
  에러 메시지로 그 사실을 알리는 쪽을 택함 — 정책 결정 사항으로 `docs/DESIGN.md` §6/§7에 기록).
- 검증: `tests/googleSheetClient.test.ts`/`tests/resendProvider.test.ts`에 "응답이 영영 안 오는"
  목(never-resolving mock)을 주입해 짧은 `timeoutMs`로도 호출이 실제로 제한 시간 안에 명확한
  에러로 끝나는 회귀 테스트를 추가했다.

### AR-024 — 실제 수동 스모크 미완료

- **미해소 (사람 전용 항목, 코드로 해소 불가)**. `docs/TASKS.md` T10이 이미
  `CODE DONE / MANUAL SMOKE PENDING`으로 명시 구분해 두고 있으며, 이번 리포트의 지적은 그 기존
  상태를 재확인한 것이다. 실제 Google 서비스 계정 권한 + Resend API 키/도메인 + 실제 수신 메일함이
  필요해 이 세션(코드 에이전트)이 직접 수행할 수 없다.
- `docs/TASKS.md`에 "T13 후속" 항목을 추가해 AR-004의 배포 차단/안정성 항목이 해소됐고 이 항목만
  남았음을 명시했다. `npm publish`는 이 스모크가 완료돼 T10이 DONE으로 승격되기 전까지 보류한다.

### AR-025 — package.json 메타데이터 부족

- 조치: `description`, `keywords`, `author`, `repository`, `homepage`, `bugs` 필드를 추가했다
  (권리자 확인: 커밋 작성자 GitHub 계정 `Trapa-Eureka` 기준 저장소 URL을 사용했다 — 실제 공개
  저장소 URL이 다르면 publish 전에 사람이 재확인해야 한다).
- 검증: `npm pack --dry-run`으로 만들어진 tarball의 `package.json`에 필드가 그대로 반영됨을 확인.

### AR-026 — tarball에 불필요한 mocks 포함

- 조치: `tsconfig.build.json`에 `"exclude": ["src/mocks"]`을 추가했다. 테스트는 `dist/`가 아니라
  `src/mocks/*.ts` 원본을 tsx로 직접 import하므로 영향이 없다.
- 검증: `npm pack --dry-run`/`npm pack` 파일 목록에 `dist/mocks/*`가 더 이상 나타나지 않음을
  확인했다(빌드 후 파일 목록 직접 대조). `npm run check` 180 tests 그대로 통과(테스트 경로 영향 없음).

### AR-027 — 배포 README가 tarball에 없는 문서를 링크함

- 조치: `README.md` 문서 맵 바로 위에 "이 상대 경로는 clone/GitHub에서만 유효하고 `npx sheet-mcp`
  설치본에는 `docs/`가 포함되지 않는다"는 경고 문단을 추가했다. 링크 자체를 절대 URL로 바꾸는 대신
  경고를 택한 이유: 저장소가 아직 실제 GitHub에 올라가 있는지, 최종 URL이 무엇인지가 AR-025와
  마찬가지로 권리자 확인이 필요한 사안이라 임의로 확정하지 않았다(AR-025 메모와 동일한 사유).

## 자동 검증 게이트 (2026-09-02, `npm run build` 이후)

- `npm run check`: TypeScript/ESLint/Prettier/Vitest 전부 통과, **180 tests** (검수 시점 175 → AR-022
  ×3 + AR-023 ×2 신규 회귀 테스트 반영).
- `npm run test:coverage`: `src/core/**` 라인 커버리지 목표(90%) 유지 확인.
- `npm audit --omit=dev`: 프로덕션 의존성 취약점 0건 (변경 없음, 새 의존성 추가하지 않았음).
- `npm publish --dry-run --json`: 자동 교정 경고 0건 (AR-021 해소 확인).
- `npm pack` 실제 tarball 생성 → 임시 디렉터리에 설치 → `sheet-mcp`, `sheet-mcp-recover` 두 bin
  모두 devDependencies 없이 정상 fail-fast까지 도달 (AR-019 완전 해소 기준 실측 충족). 검증 후
  임시 디렉터리와 tarball은 삭제했다(저장소에 산출물 남기지 않음).

## 남은 일

- ~~**AR-024 / T10 MANUAL SMOKE PENDING**: 실제 자격증명으로 사람이 수행.~~ **2026-09-02 후속
  갱신: 완료됨.** 위 "AR-024" 절 작성 시점에는 미해소였으나, 같은 날 사람이 실제 Google 서비스
  계정 + Resend(테스트 전용 주소 `onboarding@resend.dev`)로 end-to-end 발송과 중복 발송 방지까지
  실측 완료했다. 이 문서는 감사 기록이라 위 AR-024 절 본문은 작성 당시 상태 그대로 두고 이 후속
  메모만 추가한다 — 상세 기록(실행 일시·messageId·2차 skipped 결과)은 `docs/TASKS.md` T10 참고.
- **AR-025 메타데이터의 저장소 URL**: 실제 공개 저장소 주소가 확정되면 `package.json`/`README.md`의
  URL을 재확인.
- 위 두 가지가 정리된 뒤에만 `npm publish` 실행에 대한 별도의 명시적 사용자 승인을 받는다
  (`docs/ADVERSARIAL_REVIEW_004.md` §7-10, §8 추적 규칙 — 이 문서/코드 수정 권한에 실제 publish는
  포함되지 않는다).
