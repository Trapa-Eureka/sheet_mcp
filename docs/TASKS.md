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

### T9 — e2e-mock + 커버리지 · 상태: TODO · 의존: T8

- 목표: MCP 클라이언트(SDK)로 stdio 서버 도구 4종 호출하는 e2e 테스트. 커버리지 리포트.
- 완료 기준: [ ] preview → send(dry_run 모드) → get_send_log 시나리오 통과 [ ] core 커버리지 ≥ 90% 리포트 첨부 [ ] check 통과

### T10 — 스모크 스크립트 + 문서 갱신 · 상태: TODO · 의존: T8

- 목표: `scripts/smoke.ts`(실시트 1개, 실이메일 1건, live 게이트 준수), README 퀵스타트 실제 명령으로 갱신, 예시 시트 템플릿 설명.
- 완료 기준: [ ] smoke가 dry_run에서 발송 없이 미리보기 출력 [ ] 사람 실행 절차가 README에 5줄 이내로 [ ] check 통과

---

## v0.2 대기열 (착수 금지 — SPEC 로드맵 참조)

- Semaphore 실구현 + Sender ID 등록 가이드 / 행 해시 폴백 멱등성 / 스케줄러
