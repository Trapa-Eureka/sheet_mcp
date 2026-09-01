# 적대적 검수 리포트 003 — 수정 완료 기록

- 조치일: 2026-09-01
- 대상 리포트: `docs/ADVERSARIAL_REVIEW_003.md` (검수 기준 리비전 `63d23f9`)
- 조치자: Claude Code 에이전트 (사람 확인 전, 코드/문서 수정만 수행)
- 원칙: 리포트(`docs/ADVERSARIAL_REVIEW_003.md`)는 감사 기록이므로 수정하지 않는다. 실제 조치
  내역과 검증 결과는 이 신규 문서에 기록한다 (§8 추적 규칙에 따름).

## 1. 총괄 결과

AR-011~018 전 항목을 코드/문서 양쪽에서 조치했다. `npm run check`는 **130개 테스트 전부 통과**
(리포트 작성 시점 114개에서 +16 — claim/commit/release·null-clear·회귀 테스트 추가분),
`npm run test:coverage` core 라인 커버리지 **93.92%**(목표 90% 이상 유지). 조치 과정에서 리포트에
없던 **추가 결함 1건**(아래 §3 참고)을 자체 발견해 함께 수정했다.

릴리스 차단 사유였던 AR-011(중복 발송)과 AR-013(발송-기록 불일치)은 SendLog 인터페이스를
`wasSent()+record()`에서 `claim()/commit()/release()` 3단계로 재설계해 근본적으로 해결했다 —
우회나 완화가 아니라 설계 자체를 바꾼 것이므로, `docs/DESIGN.md`(§2·§3·§4)를 먼저 고치고 코드를
그 문서에 맞춰 구현했다(CLAUDE.md 가드레일 5).

**아직 남은 것**: AR-016이 지적한 대로, 실제 구글시트+실제 이메일을 쓰는 수동 스모크(SPEC §5
성공 기준)는 이 에이전트가 자격증명을 가지고 있지 않아 여전히 미수행이다. `docs/TASKS.md` T10을
`CODE DONE(2026-09-01) / MANUAL SMOKE PENDING`으로 명시했다 — 사람이 실제로 수행해야 완전한
DONE이 된다.

## 2. 발견 항목별 조치

### AR-011 — 동일 배치·동시 실행 중복 발송 (심각도: 높음, 릴리스 차단) → **해결**

- **근본 원인**: 예전 파이프라인은 "모든 행 wasSent() 확인(4단계) → 모든 행 발송+record(6단계)"로
  단계가 분리돼 있어, 같은 배치의 중복 rowKey나 동시 실행 프로세스가 같은 "확인" 시점을 공유하면
  둘 다 통과해버렸다(TOCTOU).
- **조치**: `SendLog` 인터페이스를 `claim(sheetId, tab, rowKey, templateHash, claimedAt): boolean`
  으로 재설계. 행마다 "예약 → 발송 → 확정/해제"를 **하나씩 끝까지 완결한 뒤 다음 행으로** 진행하도록
  파이프라인을 바꿨다(`src/core/pipeline.ts` `attemptSend()`). `SqliteSendLog.claim()`은 UNIQUE 제약이
  걸린 컬럼에 대한 단일 `INSERT`로 구현해, SQLite 파일 레벨 잠금 덕분에 **서로 다른 프로세스**가 같은
  DB 파일을 봐도 원자성이 유지된다(같은 프로세스 내 InMemorySendLog는 JS 단일 스레드 특성으로 이미
  원자적).
- **변경 파일**: `src/core/types.ts`, `src/core/pipeline.ts`, `src/mocks/inMemorySendLog.ts`,
  `src/adapters/sqliteSendLog.ts`, `docs/DESIGN.md` §3/§4.
- **검증**:
  - `tests/pipeline.test.ts` — "AR-011: 같은 배치 안에 동일 rowKey가 2번 있어도 provider는 1번만
    호출되고 SendLog엔 1건만 남는다" (InMemorySendLog로 재현).
  - `tests/sqliteSendLog.test.ts` — "같은 DB 파일을 보는 별도 SqliteSendLog 인스턴스끼리도 claim이
    서로를 막는다" (별도 인스턴스 2개로 프로세스 간 경쟁을 흉내내 파일 레벨 원자성 검증).
  - `tests/inMemorySendLog.test.ts` — claim 성공/실패, release 후 재claim 허용을 단위 검증.

### AR-013 — 발송 성공 후 SendLog 기록 실패를 `failed`로 오판 (심각도: 높음) → **해결**

- **조치**: `SendStatus`에 `"sent_log_failed"`를 추가. `provider.send()`가 성공한 뒤 `sendLog.commit()`
  이 실패하면(예: DB 잠금/디스크 가득 참) **`release()`를 호출하지 않고** 이번 실행 결과만
  `sent_log_failed`로 표시한다. `release()`를 부르지 않는 것이 핵심 — 그래야 claim이 DB에 남아
  다음 실행이 같은 rowKey를 다시 claim해 재발송하는 사고를 막는다. `console.error`로도 즉시 남겨
  운영자가 로그에서 놓치지 않게 했다. 집계(`sent`/`failed`/`skipped`)에는 포함하지 않아 `details[]`를
  직접 확인하도록 강제한다.
- **변경 파일**: `src/core/types.ts`(SendStatus), `src/core/pipeline.ts`(attemptSend/toStatusUpdate),
  `src/toolSchemas.ts`(zod enum), `docs/DESIGN.md` §2/§3/§4.
- **검증**: `tests/pipeline.test.ts` "AR-013: ..." — commit()만 실패하도록 흉내낸
  `CommitFailingSendLog` 목을 주입해, ① provider는 호출됨(발송 자체는 성공) ② 결과 상태가
  `sent_log_failed`이고 `sent`/`failed` 카운트 어디에도 안 들어감 ③ claim이 release되지 않아
  `wasSent()`가 여전히 true(재발송 차단)임을 확인.

### AR-012 — README `.env` 절차가 실제로 로드되지 않음 (심각도: 높음) → **해결 (+ 자체 발견 추가 결함 수정)**

- **조치**: `dotenv` 의존성 추가. `src/server.ts`/`scripts/smoke.ts`의 `main()` 진입점 맨 앞에서
  `.env`를 로드한다. `createServer()`만 단독 import하는 테스트 경로(T9 e2e 포함)는 `main()`을 타지
  않으므로 테스트 결정론에 영향이 없다.
- **자체 발견 추가 결함**: dotenv(v17)는 기본적으로 "injected env ..." 배너를 **stdout**에 찍는다.
  MCP stdio transport는 stdout을 JSON-RPC 프레이밍 전용으로 쓰므로, `.env`가 있는 상태로
  `npm run dev`를 실행하면 이 배너가 첫 메시지를 오염시켜 **MCP 클라이언트의 JSON 파싱이 깨지는**
  회귀가 생길 뻔했다. `loadDotenv({ quiet: true })`로 배너를 껐고, `.env` 존재 상태에서 실제로
  stdout이 0바이트임을 수동 검증했다(§4 참고). 이 항목은 원 리포트(AR-011~018)에는 없던, 이번
  수정 과정에서 직접 발견한 결함이다.
- **변경 파일**: `package.json`(dotenv 의존성), `src/server.ts`, `scripts/smoke.ts`.
- **검증**: §4 "수동 검증" 참고 (자동 테스트로는 확인 어려운 실제 프로세스 stdout 바이트 검사).

### AR-014 — 재시도/재실패 시 상태 셀 모순 (심각도: 중간) → **부분 정책 채택, 문서화**

- **조치**: `StatusUpdate`의 `sentAt`/`messageId`/`error`를 undefined/string/**null** 3단계로
  확장(null=명시적으로 지움). `InMemorySheetClient`·`GoogleSheetClient` 양쪽에 동일하게 반영.
  - **성공(`sent`) 시**: `error`를 항상 `null`로 지운다 — 실패했던 행이 재시도로 성공하면 과거
    `_error`가 새 성공 옆에 잘못 남지 않는다. `messageId`도 이번 발송 기준으로 다시 쓴다(없으면 null).
  - **실패(`failed`) 시**: 리포트는 "과거 `_sent_at`/`_message_id`가 남아 `_send_status=failed`와
    충돌한다"고 지적했지만, 리포트 자체 권고 문구도 "성공 시 `_error`를 지우고, 실패 시 정책을
    **문서화**한다"로 후자는 필수 소거를 요구하지 않았다. 검토 결과 **의도적으로 보존**하기로
    했다 — 그 행이 과거에 실제로 이메일을 받은 적 있다는 감사 기록은 새 템플릿의 실패 시도로
    지워지면 안 된다는 판단이다(오지우면 "이 고객에게 한 번도 안 갔다"고 오인해 중복 발송 위험을
    오히려 키울 수 있다). 이 정책은 `docs/DESIGN.md` §2/§3, `src/core/types.ts`,
    `src/core/pipeline.ts`(toStatusUpdate) 세 곳에 동일한 근거로 명시했다. **사람이 이 판단에
    동의하지 않으면 다음 검수에서 재논의 대상으로 남긴다.**
  - `skipped_duplicate`는 기존 정책(아무 것도 안 건드림) 유지.
- **변경 파일**: `src/core/types.ts`, `src/core/pipeline.ts`, `src/mocks/inMemorySheetClient.ts`,
  `src/adapters/googleSheetClient.ts`, `docs/DESIGN.md` §2/§3.
- **검증**:
  - `tests/pipeline.test.ts` "AR-014: 실패했던 행이 재시도로 성공하면 과거 _error가 지워진다".
  - `tests/pipeline.test.ts` "AR-014: 성공했던 행이 이후(새 템플릿) 실패해도 과거
    _sent_at/_message_id는 보존된다" — 위 정책을 회귀 테스트로 고정.
  - `tests/inMemorySheetClient.test.ts`, `tests/googleSheetClient.test.ts` — null 값이 undefined와
    다르게 셀을 실제로 지우는지 어댑터 레벨에서 각각 검증.

### AR-015 — `get_send_log` 무제한 응답 (심각도: 중간) → **해결**

- **조치**: `SendLog.list(sheetId, { limit? })`로 확장. 기본 200건, 최대 1000건
  (`DEFAULT_SEND_LOG_LIST_LIMIT`/`MAX_SEND_LOG_LIST_LIMIT`, `src/core/types.ts`). SQLite는
  `ORDER BY id DESC LIMIT ?`로 최근 것부터, InMemory는 동등하게 뒤집어 반환. MCP `get_send_log`
  도구에 `limit` 입력(zod로 상한 검증)을 추가하고, 응답 개수가 요청 limit에 도달하면 `truncated: true`
  를 함께 반환해(정확한 total count 조회 없는 근사치) 클라이언트가 더 있을 수 있음을 알 수 있게 했다.
- **변경 파일**: `src/core/types.ts`, `src/mocks/inMemorySendLog.ts`, `src/adapters/sqliteSendLog.ts`,
  `src/toolSchemas.ts`, `src/server.ts`, `docs/DESIGN.md` §3/§5.
- **검증**: `tests/inMemorySendLog.test.ts`/`tests/sqliteSendLog.test.ts` — 최신순 반환, limit 초과
  시 절단 확인.

### AR-016 — T10/v0.1 스모크 완료 기준 미실행 (심각도: 중간) → **문서로 명시적 구분**

- **조치**: `docs/TASKS.md` T10 상태를 `CODE DONE(2026-09-01) / MANUAL SMOKE PENDING`으로 바꾸고,
  자동 검증 가능한 항목과 사람이 실제로 수행해야 하는 항목을 분리 서술. `docs/SPEC.md` §5 성공
  기준의 "실제 시트+이메일 end-to-end" 항목에 `[PENDING]` 표시와 근거 링크를 추가.
- **변경 파일**: `docs/TASKS.md`, `docs/SPEC.md`.
- **남은 일**: 사람이 실제 자격증명으로 `npm run smoke`(dry-run) →
  `SEND_MODE=live SMOKE_CONFIRM_SEND=1 npm run smoke`(실발송 1건)를 수행한 뒤, 실행 일시·테스트
  시트(익명화)·1차 messageId·2차 skipped 결과를 `docs/TASKS.md` T10에 기록하고 상태를 완전한
  `DONE`으로 올려야 한다.

### AR-017 — 이메일 형식 검증이 `@` 포함 여부뿐 (심각도: 낮음) → **해결**

- **조치**: `!recipient.includes("@")` 대신 `z.string().email()`(zod 내장 검증)로 교체 — 과도한
  RFC 5322 풀 구현 없이 `a@`, `@example.com`, `a@@example.com`, 공백 포함 주소 등 명백한 불량을
  걸러낸다.
- **변경 파일**: `src/core/pipeline.ts`.
- **검증**: `tests/pipeline.test.ts` "AR-017: ..." — 4가지 대표 불량 주소가 전부 `failed` 처리되고
  provider가 호출되지 않음을 확인. 기존 "이메일 형식 불량('@' 없음)" 테스트와 1,000행 픽스처
  테스트(`.invalid` 도메인 포함)도 함께 통과해 정상 주소 오탐이 없음을 재확인했다.

### AR-018 — SQLite 핸들 미종료 (심각도: 낮음) → **해결**

- **조치**: `src/server.ts` `main()`에서 `process.on("exit", () => sendLog.close())` 등록 — 프로세스가
  어떤 경로(부모의 stdin 종료 포함)로 끝나든 DB 파일을 정리한다. `scripts/smoke.ts`는 전체 로직을
  `try/finally`로 감싸 스크립트가 어떻게 끝나든(정상/조기 return/예외) `sendLog.close()`가 항상 호출되게
  했다.
- **변경 파일**: `src/server.ts`, `scripts/smoke.ts`.
- **검증**: §4 수동 검증 — 더미 자격증명으로 서버를 띄우고 stdin을 닫아 정상 종료되는지, DB 파일이
  실제로 생성/닫히는지 확인.

## 3. 리포트에 없던 추가 발견 (이번 조치 중 자체 발견)

- **dotenv stdout 오염** — AR-012 참고. 심각도로 따지면 AR-011/013급(릴리스 차단급 — 실제로
  `.env`를 쓰는 모든 실사용자의 MCP 연결이 깨졌을 것)이었으나, 같은 조치 세션에서 발견 즉시 수정했다.

## 4. 검증 결과

### 자동 게이트

```
npm run check
```

- TypeScript typecheck: 통과
- ESLint: 통과
- Prettier: 통과
- Vitest: **13개 테스트 파일, 130개 테스트 통과** (원 리포트 시점 114개 → claim/commit/release
  재작성분 + AR-011/013/014/017 회귀 테스트 +16)

### 커버리지

```
npm run test:coverage
```

| | Stmts | Branch | Funcs | Lines |
|---|---|---|---|---|
| All files (src/core/\*\*) | 93.92% | 84.37% | 100% | 93.92% |

목표(90% 이상) 유지. 브랜치 커버리지가 리포트 시점(93.18%)보다 낮아진 것은 claim/commit/release·
sent_log_failed 분기가 늘어난 데다, 미달분이 전부 기존부터 있던 "내부 오류(버그 리포트)" 방어
가드(`config.ts required()`, `pipeline.ts` finalizeStatus/toStatusUpdate의 도달 불가 분기)이기
때문이며 정상 흐름에서는 도달하지 않아 의도적으로 미검증 상태다.

### 수동 검증 (자동 테스트로 확인하기 어려운 실제 프로세스 동작)

1. **fail-fast**: `GOOGLE_SERVICE_ACCOUNT_JSON` 등 시크릿 미설정 시 `npm run dev`가 즉시 명확한
   에러로 종료됨을 확인 (크래시 아님).
2. **정상 기동**: 더미 자격증명으로 `npm run dev`가 기동해 stdio에서 대기하고, stdin이 닫히면
   자연 종료됨을 프로세스 레벨로 확인. SqliteSendLog DB 파일이 실제로 생성됨을 확인.
3. **dotenv stdout 오염 수정 확인**: 실제 `.env` 파일이 있는 상태로 서버를 기동해, JSON-RPC 메시지가
   나가기 전 stdout이 정확히 0바이트임을 확인(§2 AR-012 참고).
4. **MCP 도구 왕복**: `InMemoryTransport` + MCP SDK `Client`로 `createServer()`를 직접 호출해 도구
   4종을 왕복 — zod 출력 검증 통과, 이중 안전장치, `get_send_log`의 `entries`/`truncated` 응답
   형태를 확인 (T9의 stdio 자식 프로세스 e2e와는 별도로, 이번 리팩터 직후의 빠른 재확인용. 커밋에는
   포함하지 않음).

## 5. 이번에 다루지 않은 것

- **v0.2 대기열**(Semaphore SMS 등)은 SPEC 로드맵상 착수 금지 그대로 — 이번 조치 범위 밖.
- **AR-014의 "failed 시 과거 sentAt/messageId 보존"** — 위 §2에서 설명한 대로 의도적 정책 채택이며,
  리포트가 지적한 "충돌해 보임" 자체는 완전히 해소되지 않았다(과거 성공 흔적과 현재 실패 상태가
  같은 행에 공존할 수 있다). 사람이 이 트레이드오프에 동의하는지 확인이 필요하다.
- **실제 수동 스모크**(AR-016) — 위 §2 참고, 사람만 수행 가능.

## 6. 다음 세션을 위한 메모

- `docs/TASKS.md` T10을 완전한 `DONE`으로 올리려면 실제 스모크 수행 기록이 필요하다.
- 다음 적대적 검수는 `docs/ADVERSARIAL_REVIEW_004.md`로 기록한다(리포트 003 §8 추적 규칙).
  이번에 채택한 AR-014 정책이 여전히 타당한지, claim/commit/release 설계가 실제 운영에서 예상대로
  동작하는지(특히 `sent_log_failed` 발생 빈도)를 그때 다시 점검하면 좋다.
