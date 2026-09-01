# 적대적 검수 리포트 003 — 최종 수정적용 현황

- 점검일: 2026-09-01
- 점검 대상: `docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS_RESOLVED.md`가 "해결"이라 주장한 내역을
  코드와 직접 대조해 재검증한 결과
- 기준 리비전: `f18d6f3`(GAPS_RESOLVED 커밋) 이후 이 점검에서 추가로 수정한 커밋 포함
- 점검 방식: 각 항목의 "완전 해소 기준"을 코드/테스트와 1:1로 대조. 테스트 통과만으로 판정하지
  않고, 실제로 그 코드 경로가 존재하는지, 반례가 없는지 직접 추적했다.
- 문서 원칙: 이전 문서들(`ADVERSARIAL_REVIEW_003.md`, `_RESOLUTION.md`, `_RESOLUTION_GAPS.md`,
  `_RESOLUTION_GAPS_RESOLVED.md`)은 감사 기록이므로 수정하지 않는다. 이 문서가 현재 시점의
  **최종 현황판**이다.

## 1. 결론

`ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS_RESOLVED.md`가 "해결"이라 주장한 8개 항목(GAP-001~004,
006, 008, REG-001, 그리고 정책 유지로 명시된 GAP-005)의 주장은 **코드와 대조해 전부 사실과
일치했다**. 다만 이번 재검증 과정에서 그 문서가 **다루지 않은 새로운 실결함 1건(GAP-009)**을
직접 코드 추적으로 발견해 **이번에 함께 수정**했다 — token이 일치하기만 하면 `release()`가
**이미 확정(commit)된 발송 기록까지 지울 수 있었던** 결함이다. 현재 파이프라인의 실제 호출
경로에서는 이 결함이 발현되지 않지만(release는 실패 경로에서만 호출됨), claim/commit/release
계약 자체의 방어가 뚫려 있었다는 점에서 GAP-001/AR-013이 막으려던 것과 정확히 같은 종류의
위험(확정 발송 기록 소실 → 재발송 가능)이었다.

`npm run check`는 **156개 테스트 전부 통과**(GAPS_RESOLVED 시점 150개 → 이번 재검증에서 +6),
core 라인 커버리지 93.24%(목표 90% 이상 유지). 코드로 완전히 해소 가능한 항목은 전부 해소됐다.
**GAP-005(상태 컬럼 정책)와 GAP-007(실제 수동 스모크)만 여전히 사람의 판단·실행이 필요**하며,
이는 애초에 코드로 해소할 수 있는 성격이 아니라는 점을 이전 문서들도 동일하게 명시하고 있다.

| 항목 | GAPS_RESOLVED의 주장 | 이번 재검증 결과 |
| --- | --- | --- |
| REG-001 | 해결 | **사실과 일치** — 코드 확인 |
| GAP-001 | 해결 | **사실과 일치** — 단, 재검증 중 인접한 결함(GAP-009) 발견 |
| GAP-002 | 해결 | **사실과 일치** |
| GAP-003 | 해결 | **사실과 일치** |
| GAP-004 | 해결 | **사실과 일치** |
| GAP-005 | 정책 유지(사람 재확인 필요) | **사실과 일치** — 여전히 사람 판단 대기 |
| GAP-006 | 해결 | **사실과 일치** — MCP 도구 경로까지 확인 |
| GAP-007 | 미완료(사람만 가능) | **사실과 일치** — 여전히 미완료 |
| GAP-008 | 해결 | **사실과 일치** |
| **GAP-009(신규)** | 문서에 없음 | **발견 즉시 해결** — 아래 §2 참고 |

## 2. 신규 발견: GAP-009 — token 일치만으로는 확정된(sent) 기록도 release()로 지워질 수 있었음

- 발견 경위: `ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS_RESOLVED.md`가 주장한 GAP-001 해결책(토큰
  기반 claim/commit/release)을 코드로 직접 추적하던 중, `commit()`과 `release()`의 SQL/조건식이
  `claim_token` 일치 여부만 검사하고 **이미 `committed=1`(확정 sent)인지는 검사하지 않는다**는
  것을 발견했다.
- 재현 시나리오: `claim()` → `commit()`(성공, `sendStatus="sent"`로 확정) → 이후 같은 token으로
  `release()`를 호출(예: 코드 경로가 잘못 얽히거나, 향후 리팩터링 중 실수로) → 개조 전 코드는
  이 요청을 그대로 받아들여 **방금 확정한 발송 기록을 통째로 DELETE**했다. 그 결과 `wasSent()`가
  다시 `false`가 되어, 다음 실행이 같은 행을 **실제로는 이미 발송했는데도 다시 발송**하는 진짜
  중복 사고로 이어질 수 있었다.
- 현재 파이프라인(`src/core/pipeline.ts`)의 실제 호출 순서만 보면 이 시나리오는 발생하지
  않는다 — `release()`는 provider 실패/예외 분기(`commit()`을 아예 타지 않는 경로)에서만
  불린다. 하지만 이건 "지금 이 한 파일의 호출 순서가 우연히 안전할 뿐" 이지, `SendLog` 어댑터
  자체의 계약이 스스로를 지키지 못하고 있었다는 점에서 방어 심도(defense in depth)가 부족했다.
  `forceReleaseStaleClaim()`은 이미 "확정된 기록은 어떤 경우에도 건드리지 않는다"는 원칙을
  지키고 있었는데, 정작 평범한 `release()`에는 같은 원칙이 빠져 있었던 비대칭도 발견 근거였다.
- **조치**: `commit()`과 `release()` 양쪽 모두에 "아직 `committed`되지 않았을 때만" 조건을
  추가했다.
  - `commit()`: token 일치 + `committed=0`일 때만 확정. 이미 확정된 걸 다시 commit하려 하면
    (같은 claim을 두 번 commit하는 호출자 버그) 조용히 덮어쓰지 않고 에러를 던진다.
  - `release()`: token 일치 + `committed=0`일 때만 삭제. token이 맞아도 이미 확정됐으면 조용히
    무시한다(삭제하지 않음) — 확정된 감사 기록은 어떤 호출로도 지워지지 않는다.
- **변경 파일**: `src/mocks/inMemorySendLog.ts`, `src/adapters/sqliteSendLog.ts`(SQL의
  `committed = 0` 조건 추가), `docs/DESIGN.md` §3(SendLog 인터페이스 주석).
- **검증**(양쪽 어댑터 모두):
  - "token이 맞아도 이미 commit된(sent) 기록은 release()로 지워지지 않는다" — commit 후 같은
    token으로 release해도 `wasSent()===true`, `list()`의 `sendStatus==="sent"`,
    `messageId`가 그대로 유지됨을 확인.
  - "같은 token으로 commit()을 두 번 부르면 두 번째는 에러" — 첫 commit의 결과(`messageId`)가
    두 번째 시도로 덮어써지지 않음을 확인.

### 부수 발견: `list()`의 `limit`이 음수일 때 SQLite `LIMIT -1`(무제한) 의미와 겹치는 문제

- GAP-006 재검증 중 함께 발견. `SendLog.list()`는 MCP 경계(`sendLogLimitSchema`, 양의 정수만
  허용)를 거치지 않고도 라이브러리 차원에서 직접 호출될 수 있는 인터페이스인데, `limit`이 0/음수로
  들어오면 `Math.min(limit, MAX)`이 그 음수를 그대로 통과시켰다. SQLite는 `LIMIT`에 음수를 주면
  "무제한"으로 해석하므로, AR-015가 막으려던 "무한정 응답"이 이 경로로 다시 열릴 수 있었다(실제
  제품 표면인 MCP 도구에서는 zod가 막아 재현되지 않지만, 인터페이스 자체의 방어는 아니었다).
- **조치**: `Math.max(1, Math.min(...))`로 하한을 뒀다(양쪽 어댑터).
- **검증**: `limit: -1`을 직접 넘겨도 항상 최소 1건 이상으로 클램프됨을 양쪽 어댑터에서 확인.

## 3. 항목별 재검증 근거 (기존 GAP-001~008/REG-001)

간결하게, 각 항목이 "왜 사실과 일치한다고 판단했는지"만 남긴다 — 조치 자체의 전체 서술은
`ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS_RESOLVED.md`를 참고한다.

- **REG-001**: `computeTemplateHash`가 subject/body 각각 sha256 후 재해시하는 방식인지
  `src/core/pipeline.ts`에서 직접 확인. 원래 충돌 사례(`"A "`+`"B"` vs `"A"`+`" B"`)가 이제
  다른 해시를 내는지 테스트로 재확인.
- **GAP-001**: `ClaimResult{claimed, token}` 반환, DB에는 `claimed`로만 기록(`committed=0`),
  commit/release가 token을 요구하는지 어댑터 코드에서 직접 확인. `forceReleaseStaleClaim`이
  MCP 도구로 노출되지 않았는지 `src/server.ts`의 도구 4종(`read_rows`/`preview_messages`/
  `send_notifications`/`get_send_log`)을 전부 확인해 재확인.
- **GAP-002**: `PipelineResult.logFailed` 필드가 `src/core/pipeline.ts`(정의+집계)와
  `src/toolSchemas.ts`(zod 출력 스키마)에 실제로 있는지 확인. `server.ts`의
  `send_notifications`/`preview_messages` 핸들러가 `...result`를 그대로 스프레드해
  `logFailed`가 응답에서 누락되지 않는지 확인.
- **GAP-003**: `attemptSend()`의 release 호출 지점이 정확히 2곳(provider 실패/예외)뿐이고,
  둘 다 `safeRelease()`를 거치는지 코드로 직접 추적. `safeRelease()`가 내부에서 catch하고
  절대 재throw하지 않는지 확인.
- **GAP-004**: `scripts/smoke.ts`에서 `SMOKE_SHOW_VALUES`를 읽는 지점이 `loadDotenv()` 호출문
  **다음 줄**인지 확인(모듈 최상위 상수가 아님).
- **GAP-005**: `src/core/pipeline.ts`의 `toStatusUpdate()`에서 `failed` 분기가 여전히
  `sentAt`/`messageId`를 건드리지 않는지(보존 정책 유지) 확인. 정책이 바뀌지 않았다는 것은
  "해결"이 아니라 "의도적 유지"이므로 원 문서의 표기와 일치.
- **GAP-006**: `list()`가 `limit+1`을 조회해 `hasMore`를 계산하는지, `cursor`가 SQL의
  `id < ?`(Sqlite)/`r.id < cursorId`(InMemory)로 구현됐는지 확인. `src/server.ts`의
  `get_send_log`가 `cursor` 입력과 `hasMore`/`nextCursor` 출력을 그대로 노출하는지(자체
  근사치 계산을 하지 않고 어댑터 결과를 그대로 전달하는지) 확인.
- **GAP-007**: `docs/TASKS.md` T10이 여전히 `CODE DONE(2026-09-01) / MANUAL SMOKE PENDING`
  인지, `docs/SPEC.md` §5의 `[PENDING]` 표시가 남아 있는지 확인 — 둘 다 그대로였다(이 항목은
  코드로 해소할 수 없으므로 문서 상태가 안 바뀐 것이 곧 "정확히 유지됨"을 뜻한다).
- **GAP-008**: `src/server.ts`에 `SIGINT`/`SIGTERM`/`exit` 핸들러 3개가 모두 있는지 확인.
  better-sqlite3의 `close()`가 실제로 멱등인지 별도 스크립트로 재확인(§4).

## 4. 자동 게이트 재실행 결과

```
npm run check
```

- TypeScript typecheck: 통과
- ESLint: 통과
- Prettier: 통과
- Vitest: 13개 테스트 파일, **156개 테스트 통과**

```
npm run test:coverage
```

| | Stmts | Branch | Funcs | Lines |
|---|---|---|---|---|
| All files (src/core/\*\*) | 93.24% | 82.52% | 100% | 93.24% |

GAPS_RESOLVED 시점(93.24%)과 동일 — GAP-009 수정이 기존 코드 경로 보강이라 커버리지 구조에
큰 변화가 없었다.

## 5. 여전히 사람만 할 수 있는 것 (변경 없음)

- **GAP-005**: 상태 컬럼 4개의 의미를 "마지막 시도"와 "마지막 성공"으로 분리할지, 현재처럼
  "실패해도 과거 성공 감사 기록 보존"을 유지할지 — 시트 레이아웃/SPEC 계약을 바꾸는 결정이라
  사람이 정해야 한다.
- **GAP-007**: 실제 Google Sheet + Resend 자격증명으로 하는 수동 스모크.
- **claim 만료 기준값**: `forceReleaseStaleClaim(olderThanMs)`의 실제 운영 값은 Resend/Google
  API의 타임아웃·재시도 정책에 달려 있어 이 세션에서 확정하지 않았다.

## 6. 추적 규칙

- 이 문서는 이전 4개 문서(`_003.md`, `_RESOLUTION.md`, `_RESOLUTION_GAPS.md`,
  `_RESOLUTION_GAPS_RESOLVED.md`)를 덮어쓰지 않는다 — 전부 그대로 보존된 감사 기록이다.
- 다음 적대적 검수는 `docs/ADVERSARIAL_REVIEW_004.md`로 새로 시작한다. 그때 GAP-005/GAP-007과
  더불어, 이번에 발견된 GAP-009류의 "인접 계약 비대칭"이 다른 곳에도 없는지(예: 다른 어댑터의
  방어 심도) 함께 훑어보면 좋다.
