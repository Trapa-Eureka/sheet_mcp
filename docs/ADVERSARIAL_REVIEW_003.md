# 적대적 검수 리포트 003

- 검수일: 2026-09-01
- 대상: T1~T10 전체, 문서·코어·어댑터·MCP 서버·테스트·스모크 통합 상태
- 기준 리비전: `63d23f9` (`login-flow`, `docs-tasks-progress-summary`)
- 이전 리포트: `docs/ADVERSARIAL_REVIEW_001.md`, `docs/ADVERSARIAL_REVIEW_002.md`
- 검수 방식: 스펙/설계/태스크/구현 대조, 적대적 경계 분석, 품질 게이트·커버리지·의존성 감사 실행
- 변경 원칙: 제품 코드와 기존 문서는 변경하지 않고 이 감사 기록만 신규 생성

## 1. 총평

T1~T10의 일반 성공 경로와 선언된 자동 테스트는 전반적으로 잘 구현되어 있다. 정상 권한에서 `npm run check`는 114개 테스트 전부 통과했고, 코어 라인 커버리지는 94.15%, 프로덕션 의존성 취약점은 0건이다. 이전 리포트 AR-006~010의 코드·문서 조치도 확인됐다.

그러나 v0.1 성공 기준의 핵심인 "중복 발송 0건"을 깨는 높은 심각도 결함이 있다. 동일한 `id_column` 값이 한 실행 안에 두 번 나타나거나 두 실행이 겹치면, 멱등성 확인과 예약이 원자적이지 않아 실제 이메일이 중복 발송된다. 또한 `.env` 안내와 실제 실행 방식이 맞지 않아 README 절차만으로 서버/스모크가 기동되지 않으며, 외부 발송 성공 뒤 로컬 기록 실패를 발송 실패로 오판하는 일관성 문제가 있다. 따라서 현재 상태를 운영 투입 가능으로 판정할 수 없다.

## 2. T1~T10 검수 요약

| 태스크 | 판정 | 주요 근거/잔여 위험 |
| --- | --- | --- |
| T1 타입/config | 통과(개선 권고) | 필수값·채널·필터 쌍 검증 정상. 식별자 앞뒤 공백 정규화 정책은 여전히 명시되지 않음 |
| T2 인메모리 시트/픽스처 | 통과 | 복사본 반환, 상태 컬럼 제한, 1,000행 픽스처 정상 |
| T3 GoogleSheetClient | 통과(운영 위험) | A1 인용과 쓰기 계약 테스트 존재. 대량 write-back/외부 실패의 통합 복구는 미검증 |
| T4 템플릿 | 통과 | 비ASCII·공백·하이픈 키와 결측 탐지 보강 확인 |
| T5 Provider | 통과(개선 권고) | fetch 주입/오류 응답 처리 정상. 이메일 사전 검증은 `@` 포함 여부뿐 |
| T6 SendLog | 조건부 통과 | 기본 CRUD/unique/영속성 테스트 정상. 원자적 claim 부재, 무제한 list, 수명주기 문제 존재 |
| T7 Pipeline | 차단 | 동일 배치/동시 실행 중복 발송, 발송/로그/시트 상태 불일치 가능 |
| T8 MCP 서버 | 조건부 통과 | 도구 4종과 이중 게이트 테스트 정상. `.env` 미로딩, 무제한 로그 응답 문제 존재 |
| T9 e2e/커버리지 | 자동 기준 통과 | 4개 도구 e2e 통과, core 94.15%. 중복 키·경쟁·부분 커밋 시나리오는 누락 |
| T10 스모크/문서 | 미완료 판정 | 스크립트는 있으나 실제 시트+실제 이메일 수행 증거가 없고 `.env` 절차가 동작하지 않음 |

## 3. 신규 발견 사항

### AR-011 — 동일 배치 및 동시 실행에서 멱등성이 깨져 실제 중복 발송됨

- 심각도: 높음(릴리스 차단)
- 위치: `src/core/pipeline.ts:130-147`, `src/core/pipeline.ts:242-264`, `src/adapters/sqliteSendLog.ts:61-98`
- 현상:
  - 파이프라인은 모든 행에 대해 먼저 `wasSent()`를 검사한 뒤, 이후에야 행별 `provider.send()`와 `record()`를 수행한다.
  - 같은 데이터 탭에 동일한 `id_column` 값이 두 번 있으면 두 행 모두 `wasSent=false`를 보고 `pending`이 된다.
  - 첫 행이 발송·기록된 뒤에도 두 번째 행은 재검사 없이 발송된다. 두 번째 `record()`만 unique 충돌한다.
  - 별도 MCP 호출 두 개가 동시에 실행되는 경우에도 동일한 TOCTOU(check-then-act) 경쟁이 발생한다.
- 최소 재현 조건:
  1. 같은 탭에 `customer_id=C-1`인 발송 대상 행을 2개 둔다.
  2. `dryRun=false`로 한 번 실행한다.
  3. Provider 호출은 2회 발생하며, SendLog에는 1건만 남는다.
- 영향:
  - `docs/SPEC.md` §5의 "같은 명령을 두 번 실행해도 중복 발송 0건"을 보장하지 못한다.
  - 수금 독촉·예약 알림이 같은 고객에게 중복 발송되어 신뢰 및 비용 문제가 발생할 수 있다.
- 권고:
  - 발송 전에 `(sheetId, tab, rowKey, templateHash)`를 원자적으로 claim하는 SendLog 계약을 추가한다. 예: `tryClaim(): boolean` + `pending/sent` 상태 및 만료/복구 정책.
  - 동일 프로세스 직렬화만으로 끝내지 말고 SQLite unique insert를 claim 경계로 사용해 다중 프로세스도 방어한다.
  - 같은 배치의 중복 rowKey를 발송 전에 명시적 `failed`로 거부하거나 첫 행만 claim하도록 정책을 문서화한다.
  - 동일 배치 중복과 `Promise.all()` 동시 실행 회귀 테스트를 추가한다.

### AR-012 — README의 `.env` 절차가 실제 실행 명령에서 적용되지 않음

- 심각도: 높음
- 위치: `README.md:33-39`, `package.json`의 `dev`/`smoke`, `.mcp.json:5-7`, `src/server.ts:134-145`
- 현상:
  - README는 `.env.example`을 `.env`로 복사해 값을 채우라고 안내한다.
  - 하지만 `tsx src/server.ts`, `tsx scripts/smoke.ts`, `.mcp.json` 어디에도 dotenv 로딩이나 Node의 `--env-file=.env`가 없다.
  - 소스는 `process.env`만 읽으므로 사용자가 README대로 `.env` 파일만 만들면 필수 환경변수가 프로세스에 들어오지 않는다.
- 영향:
  - `npm run dev`는 `GOOGLE_SERVICE_ACCOUNT_JSON 환경변수가 없습니다`로 종료한다.
  - `npm run smoke`는 `SMOKE_SHEET_ID`가 없다고 건너뛴다.
  - Claude Code의 커밋된 MCP 설정도 셸이 미리 export하지 않았다면 기동 실패한다.
- 권고:
  - Node 20 호환성을 유지하는 방식으로 명시적 `.env` 로더를 진입점 최상단에 두거나, 실행 스크립트와 `.mcp.json`에 검증된 env-file 옵션을 사용한다.
  - 대안으로 `.env` 사용을 문서에서 제거하고 `export`/환경 주입 절차를 정확히 안내한다.
  - 임시 `.env`를 만든 자식 프로세스 기동 테스트로 회귀를 막되 시크릿 값은 가짜 값을 사용한다.

### AR-013 — 외부 발송 성공 후 SendLog 기록 실패를 `failed`로 오판함

- 심각도: 높음
- 위치: `src/core/pipeline.ts:242-273`
- 현상:
  - `provider.send()`와 `sendLog.record()`가 하나의 `try/catch` 안에 있다.
  - Provider가 `ok=true`를 반환한 뒤 `record()`가 unique 충돌, DB 잠금, 디스크 가득 참 등으로 실패하면 catch가 행 상태를 `failed`로 덮어쓴다.
  - 실제로는 고객에게 이미 이메일이 전송됐으므로 rollback할 수 없다.
- 영향:
  - API 결과와 시트에는 실패로 보이지만 고객은 메일을 받는 거짓 실패(false failure)가 생긴다.
  - 운영자가 실패 건을 재시도하면 중복 발송할 수 있다. AR-011의 동일 rowKey 재현에서는 이 경로가 즉시 발생한다.
- 권고:
  - Provider 결과와 로컬 기록 결과를 별도 단계/상태로 모델링한다.
  - claim → send → finalize 패턴을 사용하고, finalize 실패는 `delivery_unknown` 또는 `sent_log_failed`처럼 재발송 금지 상태로 격리한다.
  - `record()` 실패 주입 테스트에서 Provider 호출 횟수, 반환 상태, 재실행 정책을 검증한다.

### AR-014 — 재시도 성공 후 과거 `_error`가 남아 행 상태가 모순됨

- 심각도: 중간
- 위치: `src/core/types.ts`의 `StatusUpdate` 계약, `src/core/pipeline.ts:329-335`, `src/adapters/googleSheetClient.ts:248-273`
- 현상:
  - optional 상태 필드의 `undefined`는 해당 셀을 건드리지 않는 의미다.
  - 실패 시 `_error`가 기록된 행이 데이터 수정 후 성공해도 sent 업데이트에는 `error`가 없어 과거 `_error`가 그대로 남는다.
  - 반대로 과거 성공 행이 새 템플릿에서 실패하면 과거 `_sent_at`과 `_message_id`가 남아 현재 `_send_status=failed`와 충돌한다.
- 영향:
  - 시트만 보는 담당자는 성공/실패를 잘못 판단할 수 있다.
  - 후속 자동화가 `_error` 또는 `_message_id` 존재 여부를 기준으로 삼으면 오동작한다.
- 권고:
  - `undefined=미변경`, `null=셀 지우기` 같은 명시적 3상태 계약을 도입한다.
  - 성공 시 `_error`를 지우고, 실패 시 현재 시도의 `_message_id` 정책을 문서화한다.
  - failed→sent, sent→새 템플릿 failed, sent→duplicate 전이를 각각 테스트한다.

### AR-015 — `get_send_log`가 무제한 전체 조회·직렬화되어 메모리/응답 크기가 계속 증가함

- 심각도: 중간
- 위치: `src/core/types.ts`의 `SendLog.list`, `src/adapters/sqliteSendLog.ts:101-108`, `src/server.ts:109-123`
- 현상:
  - `list(sheetId)`는 해당 시트의 모든 기록을 한 번에 배열로 적재한다.
  - MCP 핸들러는 같은 배열을 JSON 문자열과 `structuredContent`로 각각 구성해 큰 데이터가 중복으로 메모리에 상주할 수 있다.
  - limit, cursor, 날짜 범위, 최대 응답 크기가 없다.
- 영향:
  - 장기 운영 시 단일 호출이 이벤트 루프를 오래 점유하고 메모리 급증/OOM 또는 MCP 메시지 크기 초과를 일으킬 수 있다.
  - 이는 객체를 영구 보유하는 전형적 누수는 아니지만, 로그가 단조 증가하므로 운영상 누수와 유사한 비한정 자원 증가 위험이다.
- 권고:
  - `list(sheetId, {limit, cursor})`로 바꾸고 보수적인 기본/최대 limit을 둔다.
  - DB 쿼리에 `ORDER BY id DESC LIMIT ?`와 cursor 조건을 적용한다.
  - 큰 이력에서 content/structuredContent 이중 직렬화 비용을 측정하고 최대 응답 정책을 정한다.

### AR-016 — T10과 v0.1의 실제 스모크 완료 기준이 실행 증거 없이 DONE 처리됨

- 심각도: 중간
- 위치: `docs/TASKS.md` T10, `docs/SPEC.md:49-54`
- 근거:
  - SPEC 성공 기준은 실제 구글시트 1개와 실제 이메일 주소로 end-to-end 수행하는 것이다.
  - T10 기록은 실제 자격증명이 없어 직접 실행하지 못했고 목 기반 임시 스크립트로 분기만 검증했다고 명시한다.
  - 따라서 스모크 "스크립트 구현"은 완료됐지만 제품 성공 기준인 수동 실발송은 완료되지 않았다.
- 영향:
  - Google 권한, 실제 Resend 발신 도메인, API 응답, write-back, 재실행 중복 방지가 한 번도 통합 검증되지 않은 채 v0.1 완료로 오인될 수 있다.
- 권고:
  - T10을 `CODE DONE / MANUAL SMOKE PENDING`처럼 분리하거나 별도 릴리스 체크리스트를 둔다.
  - 실제 수행 일시, 테스트 시트, 1차 messageId, 2차 skipped 결과를 시크릿 없이 감사 기록에 남긴다.
  - AR-012를 먼저 고친 뒤 README 그대로 수행되는지도 함께 검증한다.

### AR-017 — 이메일 형식 검증이 `@` 포함 여부뿐이라 명백한 불량 주소를 API까지 전달함

- 심각도: 낮음
- 위치: `src/core/pipeline.ts:178-199`
- 현상:
  - `a@`, `@example.com`, `a@@example.com`, 공백 포함 주소도 `includes("@")`를 통과한다.
- 영향:
  - 불필요한 외부 API 호출과 행 단위 실패가 늘고, Provider 응답에 따라 불명확한 오류가 기록된다.
- 권고:
  - 과도한 RFC 전체 구현 대신 검증된 이메일 스키마 또는 최소한의 실용적 형식 검사를 경계에 적용한다.
  - 대표적인 명백한 불량 주소를 component 테스트에 추가한다.

### AR-018 — 프로덕션 SQLite 핸들의 명시적 종료 경로가 없음

- 심각도: 낮음
- 위치: `src/adapters/sqliteSendLog.ts:111-114`, `src/server.ts:134-155`, `scripts/smoke.ts:42-113`
- 현상:
  - `SqliteSendLog.close()`는 테스트에서만 호출한다.
  - 서버와 smoke는 생성한 인스턴스를 종료 시 명시적으로 닫지 않는다.
- 영향:
  - 정상 프로세스 종료 시 OS가 회수하므로 즉각적인 영구 메모리 누수는 확인되지 않았다.
  - 다만 임베딩/재기동/테스트 러너 같은 장수 프로세스에서 반복 생성하면 파일 descriptor와 native DB 자원이 누적될 수 있고, WAL checkpoint/종료 동작도 명시적이지 않다.
- 권고:
  - 의존성 수명주기(`dispose`/`close`)를 조립 계층에 노출하고 MCP 서버 종료 및 smoke `finally`에서 호출한다.
  - 반복 생성·종료 시 파일 descriptor가 안정적인지 테스트한다.

## 4. 이전 리포트 추적

| 기존 ID | 상태 | 검증 결과 |
| --- | --- | --- |
| AR-001 | 기능 구현은 해소, 릴리스 판정은 보류 | T3~T10 코드 존재. AR-011~016 때문에 운영 준비 완료는 아님 |
| AR-002 | 해소 | 공백 필터가 `undefined`로 정규화됨 |
| AR-003 | 해소 | `npm audit --omit=dev` 취약점 0건 |
| AR-004 | 해소 | `format:check`가 품질 게이트에 포함되고 통과 |
| AR-005/010 | 해소 | README가 태스크 문서를 진실의 원천으로 연결함 |
| AR-006 | 해소 | 템플릿 키가 비ASCII/공백/하이픈을 지원하고 테스트됨 |
| AR-007 | 해소 | 모든 Google A1 탭 이름을 공통 인용하며 특수문자 테스트 존재 |
| AR-008 | 해소 | Google 읽기/쓰기 경로에 네트워크 없는 계약 테스트 12개 존재 |
| AR-009 | 해소 | smoke 기본 출력이 rowKey/상태로 제한되고 값 출력은 opt-in |

## 5. 검증 결과

### 품질 게이트

샌드박스 밖 정상 로컬 IPC 권한에서 `npm run check` 통과:

- TypeScript typecheck: 통과
- ESLint: 통과
- Prettier: 통과
- Vitest: 13개 테스트 파일, 114개 테스트 통과, 실패/skip 0

참고: 제한 샌드박스에서는 e2e 자식 `tsx`가 로컬 Unix socket 생성 시 `EPERM`으로 실패했다. 정상 권한 재실행에서는 통과했으므로 제품 결함이 아닌 실행 환경 제약으로 판정했다.

### 커버리지

`npm run test:coverage` 결과:

- core statements: 94.15%
- branches: 93.18%
- functions: 100%
- lines: 94.15%
- `config.ts`: 95.29% lines
- `pipeline.ts`: 92.68% lines
- `readRows.ts`, `template.ts`: 100% lines

수치 목표는 충족하지만 AR-011~014의 상태 전이·경쟁 조건은 커버리지 수치만으로 드러나지 않는다.

### 의존성 보안

`npm audit --omit=dev --json` 결과:

- 취약점: 0건
- 프로덕션 의존성: 189
- high/critical: 0

### 저장소/실행 환경

- 검수 시작 시 Git tracked 변경: 없음
- 기준 Node: v24.12.0 (`package.json`의 `>=20` 범위 안)
- `npm ci` 후 native SQLite 및 전체 테스트 실행 확인
- 실제 Google/Resend 자격증명은 사용하지 않았고 네트워크 실발송도 수행하지 않음

## 6. 확인된 강점

- 실발송은 `SEND_MODE=live`와 `confirm=true`가 모두 필요하며 e2e에서 dry-run 경로가 검증된다.
- 외부 IO가 인터페이스 뒤에 있고 Google/Resend는 네트워크 없는 주입 테스트를 지원한다.
- Google A1 인용, 상태 컬럼 제한, optional 필드 미기록 계약이 어댑터 테스트에 포함됐다.
- 템플릿 결측은 행 단위 실패로 격리되고 유니코드 헤더/값을 처리한다.
- 한 행의 Provider 실패가 나머지 발송을 중단하지 않는다.
- 시크릿 하드코딩과 커밋된 `.env`는 확인되지 않았다.
- 자동 게이트가 타입·lint·format·unit/component/e2e를 모두 포함한다.

## 7. 조치 우선순위

1. AR-011/AR-013: 원자적 claim과 발송 후 기록 실패 상태 모델 도입
2. AR-012: `.env` 실행 계약 수정 및 실제 진입점 테스트
3. AR-014: 상태 셀 clear/보존의 3상태 계약과 전이 테스트
4. AR-016: 실제 시트+이메일 수동 스모크 완료 후 v0.1 판정
5. AR-015: SendLog pagination과 응답 크기 제한
6. AR-017/AR-018: 이메일 검증 및 자원 종료 수명주기 보강

## 8. 추적 규칙

- 다음 적대적 검수는 `docs/ADVERSARIAL_REVIEW_004.md`로 기록한다.
- 기존 리포트는 당시 상태의 감사 기록이므로 덮어쓰지 않는다.
- 수정 커밋·테스트·태스크 설명에 발견 ID(`AR-011` 등)를 연결한다.
