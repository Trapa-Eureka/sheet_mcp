# CLAUDE.md — sheet_mcp 스티어링

구글시트를 DB로 쓰는 필리핀 SME용 알림 발송 MCP 서버. v0.1 채널은 이메일, SMS는 v0.2 (인터페이스는 v0.1부터 존재). 상세 배경은 `docs/SPEC.md`, 구현 설계는 `docs/DESIGN.md`.

## 스택

- Node.js 20+, TypeScript **strict** (`noUncheckedIndexedAccess` 포함)
- MCP: `@modelcontextprotocol/sdk` — stdio transport
- Google Sheets: `googleapis` (서비스 계정 인증)
- 이메일: Resend API (참조 어댑터) / SMTP(Nodemailer)는 대체 어댑터
- 발송 로그: `better-sqlite3` (로컬 파일 DB)
- 검증: Vitest + ESLint + Prettier, 스키마는 `zod`
- `.env` 로딩: `dotenv` — `main()` 진입점(서버/스모크)에서만 호출, 테스트 경로에는 영향 없음
- 배포: `npm run build`(tsc)로 `dist/`에 컴파일해 `npx sheet-mcp`로 clone 없이 설치하는 경로를 준비 중 (`docs/DESIGN.md` §8-B, `npm publish`는 아직 미실행 — `docs/TASKS.md` T11~T13)

## 명령어

```bash
npm run check        # typecheck + lint + format:check + test 일괄 — 태스크 완료의 필수 게이트
npm run test         # vitest run
npm run test:watch   # vitest watch
npm run test:coverage # vitest run --coverage (core/ 라인 커버리지 리포트, docs/TESTING.md §6)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint .
npm run format       # prettier --write . (docs/ADVERSARIAL_REVIEW_*.md는 감사 기록이라 .prettierignore로 제외)
npm run format:check # prettier --check .
npm run dev          # MCP 서버 stdio 실행
npm run smoke        # 실제 시트/이메일 수동 스모크 (사람 전용, docs/TESTING.md 참조)
npm run build        # src/ -> dist/ 배포용 컴파일 (npm publish 전 단계, docs/DESIGN.md §8-B)
```

## 소스 레이아웃

```
src/
  core/        # 순수 로직: config, template, pipeline, idempotency — 외부 IO 없음
  adapters/    # 외부 IO 구현: googleSheetClient, resendProvider, sqliteSendLog
  mocks/       # InMemorySheetClient, MockNotificationProvider, FixedClock
  cli/         # npm 패키지로 공개 배포되는 사람 전용 운영 CLI (recoverStaleClaim 등) — bin으로 노출됨
  server.ts    # MCP 서버 진입점 (도구 등록만, 로직 없음)
tests/         # Vitest — src/mocks만 사용, 네트워크 금지
fixtures/      # 시트 JSON 픽스처
scripts/       # smoke.ts 등 저장소 개발자 전용 스크립트 (실자격증명 필요, 배포판에 포함 안 됨)
```

## 컨벤션

- 모든 외부 IO(시트, 발송, 시계, 로그 저장)는 **인터페이스 뒤에** 둔다. `core/`는 인터페이스만 안다.
- `any` 금지. 외부 입력(시트 값, config)은 경계에서 `zod`로 파싱한다.
- 에러 메시지는 에이전트 친화적으로: 무엇이 잘못됐고 **어떻게 고치는지**까지 쓴다.
  예: `config 탭에 'recipient_column' 키가 없습니다. notify_config 탭에 recipient_column=<열이름> 행을 추가하세요.`
- 파일은 작게 유지 (~200줄 초과 시 분리 검토). 함수는 단일 책임.
- 커밋 메시지: `T{n}: 요약` 형식 (예: `T4: template engine + tests`).

## 가드레일 (위반 금지)

1. **실발송 금지가 기본값.** `SEND_MODE=dry_run`이 기본이며, 실제 발송은 `SEND_MODE=live` 환경변수 **그리고** MCP 도구 호출의 `confirm: true`가 둘 다 있어야 한다. 테스트 코드에서는 어떤 경우에도 live 경로를 타지 않는다.
2. 테스트에서 **네트워크 호출 금지.** 목/픽스처만 사용 (`docs/TESTING.md`).
3. 시크릿(`GOOGLE_SERVICE_ACCOUNT_JSON`, `RESEND_API_KEY` 등)은 `.env`로만. 커밋 금지, `.env.example`만 커밋.
4. 시트 쓰기는 상태 컬럼(`_send_status`, `_sent_at`, `_message_id`, `_error`)에만 한다. 사용자 데이터 컬럼은 절대 수정하지 않는다.
5. 스펙/설계와 코드가 충돌하면 코드를 임의로 바꾸지 말고 `docs/`를 먼저 고친다 (docs가 진실의 원천).

## 작업 방식

- 작업 단위는 `docs/TASKS.md`의 태스크다. 한 세션에 한 태스크.
- 태스크의 **완료 기준을 전부 충족**하고 `npm run check`가 통과할 때까지 스스로 수정 루프를 돈다. 중간 질문 없이 끝까지 가는 것이 기본이며, 스펙 모호로 진행 불가할 때만 멈추고 질문을 남긴다.
- 완료 시 변경 파일 목록과 검증 결과를 요약하고 종료한다.

## 컨텍스트 관리

- 대량 탐색(파일 검색, 로그·빌드 출력 훑기)은 서브에이전트에 위임하고 결론만 받는다. 원본 출력을 본문에 쌓지 않는다.
- 파일 전체를 습관적으로 읽지 않는다. 필요한 범위만 읽는다.
- 태스크가 길어지면 중간 결과(결정 사항, 남은 할 일)를 `docs/`나 작업 노트에 기록해 둔다. 세션이 끊기거나 컨텍스트가 압축돼도 이어서 진행할 수 있어야 한다.
- 한 태스크가 끝나면 요약하고 종료한다. 여러 태스크를 한 세션에 몰아 하지 않는다.

## 프루닝 로그

이 파일은 격주로 검토해 낡은 규칙을 삭제한다 (`docs/WORKFLOW.md` 습관 1).

- 2026-09-01: 최초 작성.
- 2026-09-01: '컨텍스트 관리' 섹션 추가.
- 2026-09-01: npm 배포(T11~T13) 진행 중 — 스택/명령어 절에 build 반영.
