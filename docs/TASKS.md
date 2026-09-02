# TASKS — sheet_mcp v0.1 백로그

## 사용법

- 한 에이전트 세션 = 한 태스크. 프롬프트 템플릿:
  > `docs/SPEC.md`, `docs/DESIGN.md`, `docs/TESTING.md`를 읽고 **T4**를 수행해. 완료 기준을 전부 충족하고 `npm run check`가 통과할 때까지 스스로 수정해. 끝나면 변경 파일과 검증 결과를 요약해.
- 완료 기준은 전부 **실행 가능한 검증**이다. 에이전트는 사람 확인 없이 스스로 판정할 수 있어야 한다.
- 완료 시 상태를 `DONE(날짜)`로 갱신하고 커밋 (`T{n}: 요약`).
- 병렬 레인: T1 완료 후 **A/B/C/D 레인은 서로 다른 에이전트(git worktree)로 동시 진행 가능**.

의존 그래프: `T0 → T1 → {A: T2→T3, B: T4, C: T5, D: T6} → T7 → T8 → {T9, T10}`

---

### T0 — 프로젝트 스캐폴딩 · 상태: DONE(2026-09-01)

- 목표: TS strict + ESLint + Prettier + Vitest + 스크립트 일체. `src/`는 빈 진입점만.
- 산출: `package.json`(스크립트: check/test/test:watch/typecheck/lint/dev/smoke), `tsconfig.json`(strict, noUncheckedIndexedAccess), `.eslintrc` 계열, `vitest.config.ts`, `.env.example`, `.gitignore`(.env, data/)
- 완료 기준: [ ] `npm run check` 통과 [ ] 더미 테스트 1개 실행됨 [ ] `git init` + 첫 커밋

### T1 — 도메인 타입 + config 파서 · 상태: DONE(2026-09-01) · 의존: T0

- 목표: DESIGN §3 인터페이스 전체를 `src/core/types.ts`로, `notify_config` zod 파서를 `src/core/config.ts`로.
- 완료 기준: [ ] 필수 키 결측/`channel=sms` 시 **수정 방법이 담긴** 에러 메시지 (CLAUDE.md 컨벤션) [ ] `tests/config.test.ts` — 정상 1, 오류 4케이스 이상 [ ] check 통과

### T2 (레인 A) — InMemorySheetClient + 픽스처 · 상태: DONE(2026-09-01, codex 적대적 검수 반영) · 의존: T1

- 목표: SheetClient 목 구현 + `fixtures/sheets/collections.json`(SPEC §4-3, 타갈로그 혼용 값, 12행 내외) + `fixtures/sheets/large-1000.json` 생성 스크립트.
- 완료 기준: [ ] ensureStatusColumns/writeStatus가 메모리에 반영·재조회됨 [ ] `tests/inMemorySheetClient.test.ts` [ ] check 통과

### T3 (레인 A) — GoogleSheetClient 어댑터 · 상태: DONE(2026-09-01, ADVERSARIAL_REVIEW_002 반영) · 의존: T2

- 목표: googleapis 서비스 계정 구현. **실제 네트워크를 타는 테스트는 작성하지 않는다** — 스모크로 검증.
  (AR-008 이후 명확화: 이는 Sheets API 호출부를 주입 가능하게 만들어 네트워크 없는 mock 계약
  테스트를 쓰는 것까지 금지한다는 뜻은 아니다 — `tests/googleSheetClient.test.ts` 참고.)
- 완료 기준: [ ] SheetClient 계약 충족(typecheck) [ ] `scripts/smoke.ts`에서 읽기 경로 사용 가능 [ ] 시크릿 하드코딩 없음 [ ] check 통과

### T4 (레인 B) — 템플릿 엔진 · 상태: DONE(2026-09-01, ADVERSARIAL_REVIEW_002 반영) · 의존: T1

- 목표: `renderTemplate` 순수 함수 (DESIGN §3). 결측 키는 throw가 아니라 `missing[]` 반환.
- 완료 기준: [ ] 치환/결측/이스케이프 불필요 확인/유니코드 케이스 포함 `tests/template.test.ts` 8케이스 이상 [ ] check 통과

### T5 (레인 C) — NotificationProvider + 어댑터 · 상태: DONE(2026-09-01) · 의존: T1

- 목표: `MockNotificationProvider`(failFor 주입), `ResendEmailProvider`(fetch 1콜), `SemaphoreSmsProvider` 스텁(생성 시 안내 에러).
- 완료 기준: [ ] 목의 기록/실패 주입 테스트 [ ] Resend 어댑터는 fetch를 주입받아 **목 fetch로** 요청 형태 테스트 [ ] check 통과

### T6 (레인 D) — SendLog · 상태: DONE(2026-09-01) · 의존: T1

- 목표: `InMemorySendLog` + `SqliteSendLog`(better-sqlite3, unique 키는 DESIGN §6).
- 완료 기준: [ ] 임시 파일 DB로 wasSent/record/list 테스트 (파일 IO는 허용, 네트워크 아님) [ ] unique 충돌 시 조용히 무시 아님—명시 처리 [ ] check 통과

### T7 — SendPipeline · 상태: DONE(2026-09-01) · 의존: T2, T4, T5, T6

- 목표: DESIGN §4의 8단계 흐름 구현.
- 완료 기준: [x] **TESTING §4 체크리스트 12항목 전부** `tests/pipeline.test.ts`로 통과 [x] check 통과

### T8 — MCP 서버 · 상태: DONE(2026-09-01) · 의존: T7

- 목표: 도구 4종 등록 (DESIGN §5), 이중 안전장치(SEND_MODE + confirm), `.mcp.json` 커밋.
- 완료 기준: [x] 도구 입출력 zod 스키마 [x] server.ts에 비즈니스 로직 없음(조립만) [x] `npm run dev`로 기동 확인 [x] check 통과

### T9 — e2e-mock + 커버리지 · 상태: DONE(2026-09-01) · 의존: T8

- 목표: MCP 클라이언트(SDK)로 stdio 서버 도구 4종 호출하는 e2e 테스트. 커버리지 리포트.
- 완료 기준: [x] preview → send(dry_run 모드) → get_send_log 시나리오 통과 [x] core 커버리지 ≥ 90% 리포트 첨부 [x] check 통과
- 커버리지 리포트(`npm run test:coverage`, 2026-09-01): All files 94.15% stmts / 93.18% branch / 100% funcs / 94.15% lines.
  미달 라인은 전부 "내부 오류(버그 리포트)" 방어 가드(config.ts required(), pipeline.ts finalizeStatus/toStatusUpdate)로,
  정상 흐름에서는 도달 불가능해 의도적으로 테스트하지 않음.

### T10 — 스모크 스크립트 + 문서 갱신 · 상태: CODE DONE(2026-09-01) / MANUAL SMOKE PENDING · 의존: T8

- 목표: `scripts/smoke.ts`(실시트 1개, 실이메일 1건, live 게이트 준수), README 퀵스타트 실제 명령으로 갱신, 예시 시트 템플릿 설명.
- 완료 기준: [x] smoke가 dry_run에서 발송 없이 미리보기 출력 [x] 사람 실행 절차가 README에 5줄 이내로 [x] check 통과
- smoke.ts는 이제 core/pipeline.ts의 SendPipeline을 실제 어댑터로 조립해 dry-run 미리보기 →
  (SEND_MODE=live && SMOKE_CONFIRM_SEND=1 && 대상 1행일 때만) 실발송까지 전체 흐름을 수행한다.
  대상이 2행 이상이면 실수로 여러 명에게 발송되는 사고를 막기 위해 중단한다.
  실제 Google/Resend 자격증명 없이는 이 환경에서 직접 실행할 수 없어(사람 전용 수동 스모크),
  동일 분기 로직을 목으로 재현한 임시 스크립트로 5개 시나리오(기본/SEND_MODE만/confirm만/
  대상 2행/둘 다 충족)를 검증 후 삭제함.
- **상태를 "CODE DONE / MANUAL SMOKE PENDING"으로 명시 구분한다** (docs/ADVERSARIAL_REVIEW_003.md
  AR-016): 위 자동 검증 가능한 완료 기준(체크박스 3개)은 전부 충족했지만, `docs/SPEC.md` §5의
  진짜 성공 기준인 "실제 구글시트 1개 + 실제 이메일 1건 end-to-end"는 이 에이전트가 실제
  Google/Resend 자격증명을 가지고 있지 않아 아직 한 번도 수행되지 않았다. 이 항목은 사람이
  실제로 수행한 뒤에만 DONE으로 승격하고, 그때 실행 일시·테스트 시트(익명화)·1차 messageId·
  2차 skipped 결과를 시크릿 없이 여기 기록한다.

---

## npm 패키지 배포 준비 (T11~T13, `npx sheet-mcp`)

- 배경: 지금은 레포를 clone해 `npx tsx src/server.ts`로 실행하는 구조(DESIGN §8). `npx sheet-mcp`처럼
  clone 없이 바로 쓸 수 있게 하려면 빌드 산출물 + 패키지 메타데이터가 필요하다.
- **`npm publish` 실행 자체는 이 세 태스크에 포함하지 않는다** — 공개 레지스트리에 소스가 노출되는
  되돌리기 어려운 동작이라 별도로 명시적 승인을 받은 뒤에만 실행한다. T11~T13은 "publish만 누르면
  되는 상태"까지 준비하는 것이 목표다.
- 각 태스크 완료 후 다음 태스크로 넘어가기 전에 사람 확인을 받는다(세션 규칙, 자동 연속 진행 안 함).
- 의존 그래프: `T10 → T11 → T12 → T13`

### T11 — 빌드 파이프라인 · 상태: DONE(2026-09-01) · 의존: T10

- 목표: `tsc` 기반으로 `src/`를 `dist/`에 순수 JS로 컴파일하는 빌드 스크립트를 추가한다. 배포판은
  `tsx`/devDependencies 없이 `node dist/server.js`만으로 실행돼야 한다.
- 완료 기준:
  [x] `tsconfig.build.json`(또는 동등한 설정)으로 `dist/`에 outDir 지정, 테스트 파일은 빌드 대상에서 제외
  [x] `npm run build` 스크립트 추가
  [x] 빌드된 `dist/server.js` 최상단에 `#!/usr/bin/env node` shebang이 있다
  [x] `.env` 없이 `node dist/server.js` 실행 시 기존 `tsx src/server.ts`와 동일한 fail-fast 에러가 난다(동작 동치성 확인)
  [x] `npm run check` 통과(기존 vitest는 여전히 `src/`를 대상으로 함 — 변경 없음)
- `tsconfig.build.json`은 `tsconfig.json`을 extends하고 `noEmit:false`/`outDir:dist`/`rootDir:src`만
  덮어쓴다 — `include`를 `["src"]`로 좁혀 tests/scripts는 애초에 컴파일 대상에서 빠진다.
  `scripts/postbuild.mjs`(plain Node ESM, tsx 없이 실행)가 `dist/server.js` 맨 앞에 shebang을 붙인다
  (tsc는 shebang을 보존하지 않음). `node dist/server.js`와 `npx tsx src/server.ts`를 각각 `.env` 없이
  실행해 완전히 동일한 에러 메시지·종료 코드(`GOOGLE_SERVICE_ACCOUNT_JSON 환경변수가 없습니다...`,
  exit 1)를 확인함(동작 동치성 수동 검증).

### T12 — 배포 메타데이터 + 로컬 패키지 검증 · 상태: DONE(2026-09-01) · 의존: T11

- 목표: `package.json`을 npm 배포 가능한 형태로 정리하고, 실제로 tarball을 만들어 로컬에서
  `npx`로 설치·실행되는지 검증한다.
- 완료 기준:
  [x] `"private": true` 제거
  [x] `"bin": {"sheet-mcp": "./dist/server.js"}` 추가
  [x] `"files"`로 배포에 포함할 대상을 `dist/`, `.env.example` 등으로 제한(src/tests/docs 제외)
  [x] `"prepublishOnly"`가 `npm run check && npm run build`를 실행하도록 연결
  [x] `npm pack`으로 만든 tarball을 별도 임시 디렉터리에서 `npm install -g <tarball>` 또는
  `npx <tarball 경로>`로 설치해 실제로 MCP 서버가 기동되는지 확인(자격증명 없이 fail-fast까지)
  [x] `npm run check` 통과
- `"prepack": "npm run build"`도 함께 추가했다(완료 기준엔 없었지만 `npm pack` 단독 실행 시에도
  `dist/`가 자동으로 최신 상태로 빌드되게 하기 위함 — `prepublishOnly`는 `npm publish`에서만
  실행되고 `npm pack`에서는 실행되지 않아, 이게 없으면 stale `dist/`를 그대로 패키징할 위험이 있었다).
- **재검증 중 심각한 버그 발견·수정**: `npm pack` → `npm install <tarball>` → `./node_modules/.bin/sheet-mcp`
  실행으로 실제 검증하던 중, 서버가 **아무 출력도 에러도 없이 exit code 0으로 조용히 종료**되는
  것을 발견했다. 원인은 `src/server.ts`의 진입점 가드 `process.argv[1] === fileURLToPath(import.meta.url)`
  — npm이 `bin` 필드로 만드는 실행 파일은 실제 파일이 아니라 심볼릭 링크인데, Node ESM 로더는
  `import.meta.url`을 항상 실제 파일의 realpath로 해석하는 반면 `process.argv[1]`은 호출에 쓰인
  심볼릭 링크 경로 그대로 남아 두 값이 절대 같아지지 않는다 — 그 결과 `main()`이 전혀 호출되지
  않았다. `npx sheet-mcp`/전역 설치 후 실행 등 npm이 만드는 모든 실행 경로가 이 문제에 해당돼,
  **T11~T13 전체의 목표(npx로 clone 없이 쓰기)가 그 자체로 무력화되는 버그**였다.
  `realpathSync(process.argv[1])`로 심볼릭 링크를 해석한 뒤 비교하도록 고쳤고,
  `tests/serverEntrypointSymlink.test.ts`(신규, `dist/` 빌드 없이 `tsx` + 심볼릭 링크로 동일 상황을
  재현)로 회귀 가드를 추가했다 — 수정 전 코드로 되돌려 이 테스트가 실제로 실패하는지도 확인함.
- 최종 검증: 실제 `npm pack` → `npm install <tarball>`(로컬) → `./node_modules/.bin/sheet-mcp` 및
  `npx --package=<tarball> sheet-mcp` 양쪽 경로 모두 자격증명 없이 `node dist/server.js`/
  `tsx src/server.ts`와 동일한 fail-fast 에러·종료 코드 1을 반환함을 확인. `npm run check` 175 tests
  (기존 174 + 회귀 가드 1) 전부 통과.

### T13 — 설치 방식 문서 갱신 · 상태: DONE(2026-09-01) · 의존: T12

- 목표: `npx sheet-mcp` 설치 경로를 `CLAUDE.md`/`docs/DESIGN.md` §8/`README.md`에 반영한다(가드레일
  5: 설계 변경은 코드보다 docs를 먼저/함께 고친다). 기존 "레포 clone" 경로도 계속 유효하므로 두
  방법 다 남긴다.
- 완료 기준:
  [x] `docs/DESIGN.md` §8에 `claude mcp add sheet-mcp -- npx -y sheet-mcp` 예시 추가(기존 clone 방식과
  나란히, 어떤 걸 언제 쓰는지 한 줄 설명 포함)
  [x] `README.md` 퀵스타트/실행 절차에 npx 설치 경로 반영
  [x] `CLAUDE.md` 스택 절에 배포 방식(빌드+npm) 한 줄 추가
  [x] 아직 `npm publish`를 하지 않았다는 사실과, 그 전까지는 `npx sheet-mcp`가 동작하지 않는다는
  점을 두 문서 모두에 명확히 표시(문서가 앞서가서 안 되는 기능을 있는 것처럼 설명하지 않는다)
  [x] check 통과
- `docs/DESIGN.md` §8을 A(레포 clone, 개발/기여용)/B(`npx sheet-mcp`, clone 없이 쓰기) 두 절로
  나누고, B 절에 "아직 publish 전이라 지금은 동작하지 않는다"는 경고를 명확히 넣었다. `README.md`
  "실행 절차"의 기존 5단계는 그대로 두고(T10 완료 기준 "5줄 이내" 유지) 그 아래 별도 문단으로
  npx 경로와 동일한 경고를 추가했다. `CLAUDE.md`는 스택 절 한 줄 + 명령어 절에 `npm run build` +
  프루닝 로그 항목을 추가했다. T11~T13 전체가 아직 `npm publish` 실행 전 준비 단계이므로, 실제
  퍼블리시는 이후 별도로 사용자 승인을 받아 진행한다.

### T13 후속 — 적대적 검수 004(publish 최종 검수) 반영 · 상태: CODE DONE(2026-09-02) / MANUAL SMOKE PENDING

- `docs/ADVERSARIAL_REVIEW_004.md`(AR-019~~027, `be2b38f` 기준)가 "현재 리비전을 publish해서는 안
  된다"고 판정했다. 배포 차단 3건(AR-019~~021)과 운영 안정성 2건(AR-022~~023), 품질 개선 3건
  (AR-025~~027)을 코드로 전부 해소했다 — 상세 내역·검증 증거는 `docs/ADVERSARIAL_REVIEW_004_RESOLUTION.md`.
- **AR-024(실제 Google Sheet+Resend 수동 스모크)만 남아 있다** — 이는 T10의 기존
  `MANUAL SMOKE PENDING` 항목과 동일한 사람 전용 실행 항목이며, 코드 변경으로 해소할 수 없다.
  실제 스모크를 수행해 T10과 함께 DONE으로 승격하기 전까지 `npm publish`는 여전히 보류한다.

---

## v0.2 대기열 (착수 금지 — SPEC 로드맵 참조)

- Semaphore 실구현 + Sender ID 등록 가이드 / 행 해시 폴백 멱등성 / 스케줄러
