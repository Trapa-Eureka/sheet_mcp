# 적대적 검수 리포트 003 — 미해소 내역(GAPS) 재조치 기록

- 조치일: 2026-09-01
- 대상 문서: `docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md` (기준 리비전 `fa8b5b6` 재검증 결과)
- 조치자: Claude Code 에이전트 (사람 확인 전, 코드/문서 수정만 수행)
- 원칙: `ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md`는 감사 기록이므로 수정하지 않는다. 실제 조치
  내역과 검증 결과는 이 신규 문서에 기록한다(그 문서 §7 추적 규칙에 따름).

## 1. 총괄 결과

GAP-001~008, REG-001 전 항목을 조치했다. 핵심은 SendLog를 **소유권 토큰 기반 claim/commit/release**
로 다시 설계한 것 — claim이 확정(commit)되지 않은 채로 프로세스가 죽어도 그 사실이 `"claimed"`로
그대로 남아 운영자가 발견할 수 있고, 자동으로 "발송됨"으로도 "재사용 가능"으로도 둔갑하지 않는다.
`npm run check`는 **150개 테스트 전부 통과**(GAPS 재검증 시점 130개 → +20), core 라인 커버리지
93.24%(목표 90% 이상 유지).

| 항목 | 이전 판정 | 이번 조치 후 |
| --- | --- | --- |
| GAP-001 | 부분 해소 | 해소 — claim/sent 상태 분리 + token + 만료 기반 수동 복구 |
| GAP-002 | 부분 해소 | 해소 — SendLog가 claimed를 sent로 잘못 보여주지 않음, `logFailed` 별도 집계로 불변식 회복 |
| GAP-003 | 부분 해소 | 해소 — release() 실패를 격리해 배치를 막지 않음 |
| GAP-004 | 부분 해소 | 해소 — dotenv 로드 이후에 SMOKE_SHOW_VALUES 평가 |
| GAP-005 | 정책 유지 | **정책 유지, 재확인 필요**(아래 §3 참고 — 의도적 트레이드오프) |
| GAP-006 | 부분 해소 | 해소 — limit+1 조회로 정확한 hasMore + cursor 페이지네이션 |
| GAP-007 | 미완료 | **미완료 그대로** — 사람만 가능 (아래 §3) |
| GAP-008 | 대체로 해소 | 해소 — close() 멱등 확인, SIGINT/SIGTERM 처리, 반복 생성·종료 회귀 테스트 |
| REG-001 | 신규 회귀 | 해소 — 이중 해시 방식으로 충돌 원천 차단 |

## 2. 항목별 상세 조치

### REG-001 — 템플릿 해시 충돌 (심각도: 높음) → **해결**

- **재현 확인**: 조치 전 코드로 `subject="A ", body="B"`와 `subject="A", body=" B"`를 실제로 해시해
  둘 다 `a70bb07d2189`로 충돌함을 직접 재현했다(리포트의 실측 결과와 일치).
- **조치**: `computeTemplateHash`를 "subject와 body를 각각 먼저 sha256 → 그 두 64자 다이제스트를
  이어붙여 다시 sha256"으로 변경. 다이제스트가 고정 길이라 경계 모호성이 구조적으로 없다.
- **변경 파일**: `src/core/pipeline.ts`.
- **검증**: `tests/pipeline.test.ts` "REG-001: ..." — 위 두 조합의 해시가 이제 다름을 확인. 기존
  "subject/body 중 하나만 달라도 해시가 달라진다" 테스트도 함께 통과.

### GAP-001 — 중단된 claim이 영구 `sent` 기록으로 남음 (심각도: 높음, AR-011) → **해결**

- **조치**: `SendLog.claim()`이 이제 `ClaimResult { claimed, token }`을 반환하고, DB에는 즉시
  `"sent"`가 아니라 `"claimed"` 상태로만 기록된다. `commit()`/`release()`는 claim이 발급한 token과
  일치할 때만 동작한다(불일치 시 commit은 에러, release는 조용히 무시). 프로세스가 claim 직후
  죽으면(commit/release 둘 다 미호출) 그 행은 `list()`에서 `sendStatus: "claimed"`로 그대로
  보인다 — `"sent"`로 둔갑하지 않는다.
- **수동 복구**: `forceReleaseStaleClaim(sheetId, tab, rowKey, templateHash, olderThanMs)`을
  추가했다. `committed=0`이고 `claimedAt`이 `olderThanMs`보다 오래된 claim만 회수하며, 이미
  `sent`로 확정된 기록은 아무리 오래돼도 절대 건드리지 않는다. **자동 만료·자동 재사용은 어디에도
  없다** — 리포트의 "만료 claim은 자동 재확정보다 수동 확인을 우선한다"는 권고를 그대로 따라, 이
  함수는 사람이 직접 검토한 뒤 호출하는 것을 전제하고 **MCP 도구로는 노출하지 않았다**(자율
  에이전트가 "발송됐을 수도 있는" claim을 스스로 재사용 가능하게 만드는 판단은 위험하다고 판단).
- **변경 파일**: `src/core/types.ts`(SendLog 인터페이스, `ClaimResult`, `SendLogEntryStatus`),
  `src/mocks/inMemorySendLog.ts`, `src/adapters/sqliteSendLog.ts`(schema에 `claim_token`,
  `committed` 컬럼 추가), `src/core/pipeline.ts`, `docs/DESIGN.md` §2/§3/§4.
- **검증**:
  - "GAP-001: claim 후 프로세스가 죽은 것처럼 commit/release를 전혀 안 부르면 list()에
    sendStatus='claimed'로(sent로 둔갑하지 않고) 보인다" — InMemory/Sqlite 양쪽.
  - `forceReleaseStaleClaim` describe 블록 — 젊은 claim은 회수 안 함, 오래된 claim은 회수+재claim
    허용, 이미 commit된 건 아무리 오래돼도 회수 안 함, 존재하지 않는 키는 false — 4개 테스트 ×
    InMemory/Sqlite.
  - "token이 일치하지 않으면 commit이 거부된다", "release(잘못된 token)는 조용히 무시하고 기존
    claim을 지우지 않는다" — 좀비 프로세스가 회수된 claim을 잘못 확정/삭제하지 못함을 검증.

### GAP-002 — commit 실패 상태가 SQLite에 보존되지 않음 (심각도: 높음, AR-013) → **해결**

- GAP-001의 claimed/sent 상태 분리가 그대로 이 문제도 해결한다: commit()이 실패하면 DB의 claim은
  `committed=0`(claimed) 그대로 남고, **`"sent"`로 잘못 확정되지 않는다**. `get_send_log`로 조회해도
  `sendStatus: "claimed"`로 정직하게 보인다 — 리포트가 지적한 "장애가 정상 sent로 보일 수 있다"는
  더 이상 성립하지 않는다.
- **집계 불변식**: `PipelineResult`에 `logFailed: number`를 추가했다. `sent_log_failed` 행은 이제
  `sent`/`failed`/`skipped` 어디에도 안 들어가고 `logFailed`로 별도 집계되므로,
  `sent+failed+skipped+logFailed === details.length`가 항상 성립한다(예전엔 `sent_log_failed`가
  어느 카운트에도 없어 이 등식이 깨졌다).
- **변경 파일**: `src/core/pipeline.ts`(PipelineResult, summarize), `src/toolSchemas.ts`,
  `docs/DESIGN.md` §4.
- **검증**: AR-013 테스트에 다음을 추가했다 — `result.logFailed===1`, 집계 불변식
  `sent+failed+skipped+logFailed===details.length`, `sendLog.list()`로 조회한 항목의
  `sendStatus`가 `"claimed"`임(정상 sent로 보이지 않음)을 확인.

### GAP-003 — release 실패가 행 격리를 깨고 배치를 중단시킬 수 있음 (심각도: 높음) → **해결**

- **조치**: `attemptSend()`의 release 호출을 전부 `safeRelease()`라는 별도 메서드로 감쌌다.
  `release()` 자체가 throw해도 **밖으로 전파하지 않고** 잡아서, 그 사실을 행의 `error` 메시지와
  `console.error`에 남긴다. `run()`의 `for` 루프는 계속 진행되므로 뒤 행들은 정상 처리된다.
- **변경 파일**: `src/core/pipeline.ts`(`safeRelease`).
- **검증**: `tests/pipeline.test.ts` "GAP-003: ..." — `ReleaseFailingSendLog` 목(release()가 항상
  throw)을 주입해, 실패가 주입된 C-1은 `failed`(+error에 "예약 해제도 실패" 포함)로 처리되고, 뒤에
  오는 C-2는 정상적으로 `sent`까지 도달함을 확인 — 배치가 중단되지 않았다는 직접 증거.

### GAP-004 — `.env`의 `SMOKE_SHOW_VALUES`가 적용되지 않음 (심각도: 중간) → **해결**

- **조치**: `SHOW_VALUES` 모듈 최상위 상수를 제거하고, `main()` 안에서 `loadDotenv()` **다음에**
  `process.env.SMOKE_SHOW_VALUES`를 읽어 `formatDetail(detail, showValues)`에 매개변수로 전달하도록
  바꿨다.
- **변경 파일**: `scripts/smoke.ts`.
- **검증**: 자동화된 유닛 테스트는 없다(smoke.ts는 기존에도 테스트 대상이 아닌 사람 전용 스크립트,
  T3/T10 결정에 따름). 대신 셸 환경변수를 전부 비우고(`env -i`) `.env` 파일에만
  `SMOKE_SHEET_ID`/`SMOKE_SHOW_VALUES=1`을 적어 실행해, `.env`의 `SMOKE_SHEET_ID`가 정상 인식되어
  "SMOKE_SHEET_ID 없음" 분기를 건너뛰고 실제 로직(Google 인증 시도)까지 진행됨을 확인했다 —
  `loadDotenv()` → 환경변수 읽기 순서가 올바르게 작동한다는 직접 증거다(가짜 자격증명이라 그
  이후 암호화 단계에서 실패하는 것은 예상된 동작).

### GAP-005 — sent→failed 전이의 상태 모순 (심각도: 중간, AR-014) → **정책 유지, 재확인 요청**

- 이 항목은 이전 라운드(`ADVERSARIAL_REVIEW_003_RESOLUTION.md`)에서 이미 "의도적 정책"으로
  문서화했고, 이번 재검증 리포트도 이를 "정책적으로 유지됨"이라고 정확히 파악했다 — 새로운 결함이
  아니라 이전에 내가 내린 판단에 대한 재확인 요청이다.
- **현재 정책(변경하지 않음)**: `sent`가 되면 과거 `_error`를 지운다. `failed`가 되면 과거
  `_sent_at`/`_message_id`는 **보존**한다 — 그 행이 예전에 실제로 이메일을 받은 적 있다는 감사
  기록이, 새 템플릿의 실패 시도 때문에 지워지면 안 된다는 판단이다. 이 판단을 바꾸지 않은 이유:
  네 컬럼만으로 "현재 시도 상태"와 "과거 성공 이력"을 분리하려면 상태 컬럼을 8개로 늘리거나
  별도 조회 경로를 추가해야 하는데, 이는 DESIGN §2가 정한 "상태 컬럼 4개" 계약 자체를 바꾸는
  더 큰 결정이라 이번 조치 범위를 넘어선다고 판단했다.
- **완전 해소로 가는 길**(리포트가 제시한 대로, 사람 결정 필요): (a) 상태 컬럼을 "마지막 시도"와
  "마지막 성공"으로 분리하거나, (b) 네 컬럼은 "마지막 시도"만 나타내는 것으로 재정의하고 과거
  성공 이력은 `get_send_log`로만 조회하게 한다(현재 컬럼 의미를 SPEC/DESIGN에서 더 명확히
  못박는 것). 어느 쪽이든 시트 레이아웃 또는 문서 계약이 바뀌므로, 사람이 방향을 정해야 한다.
- **변경 파일**: 없음(이번 라운드에서는 코드/문서 변경하지 않음 — 판단 재확인만).

### GAP-006 — pagination과 정확한 `truncated`가 없음 (심각도: 중간, AR-015) → **해결**

- **조치**: `SendLog.list()`가 `limit+1`개를 조회해 실제로 더 있는지 정확히 판정하도록 바꿨다
  (근사치였던 `entries.length >= effectiveLimit` 방식 제거). `SendLogListOptions`에 `cursor`를,
  `SendLogListResult`에 `hasMore`/`nextCursor`를 추가해 진짜 cursor 페이지네이션을 구현했다 —
  SQLite는 `id < cursor ORDER BY id DESC`, InMemory는 동등한 로직. `get_send_log` MCP 도구도
  `cursor` 입력과 `hasMore`/`nextCursor` 출력을 그대로 노출한다.
- **변경 파일**: `src/core/types.ts`, `src/mocks/inMemorySendLog.ts`, `src/adapters/sqliteSendLog.ts`,
  `src/toolSchemas.ts`, `src/server.ts`, `docs/DESIGN.md` §3/§5.
- **검증**:
  - "199/200/201건 경계에서 hasMore가 정확하다(근사치 아님)" — InMemory/Sqlite 양쪽에서 정확히
    3개 경계값을 직접 확인(리포트가 요구한 완전 해소 기준 그대로).
  - "nextCursor로 두 페이지 이상을 중복·누락 없이 순회할 수 있다" — 5건을 limit=2로 3페이지에
    걸쳐 순회해 합친 결과가 원본과 정확히 일치함을 확인(중복·누락 없음의 직접 증거).
  - "잘못된 cursor 값은 명시적으로 에러를 던진다".

### GAP-007 — 실제 수동 스모크 미완료 (심각도: 중간, AR-016) → **여전히 미완료 (사람만 가능)**

- 이 항목은 코드로 해소할 수 없다 — 실제 Google Sheet + Resend 자격증명이 필요하고, 이 에이전트는
  그것을 가지고 있지 않다. `docs/TASKS.md` T10은 이미 `CODE DONE(2026-09-01) / MANUAL SMOKE
  PENDING`으로 정확히 구분돼 있으며(이전 라운드 조치), 이번 라운드에서도 상태를 바꾸지 않았다 —
  리포트의 완전 해소 기준(1~5단계: dry-run 확인 → 실발송 1건 → 상태/messageId 확인 → 재실행 시
  skipped_duplicate 확인 → 감사 기록)은 사람이 실제로 수행해야 하는 항목 그대로다.

### GAP-008 — 서버 SQLite 종료 수명주기 검증 불충분 (심각도: 낮음, AR-018) → **해결**

- **조치**:
  1. better-sqlite3의 `close()`가 실제로 멱등인지(두 번 불러도 에러 없음) 직접 코드로 검증했다 —
     그렇다는 것을 확인했으므로 별도 가드 플래그 없이도 여러 종료 경로가 겹쳐도 안전하다.
  2. `src/server.ts`에 `SIGINT`/`SIGTERM` 핸들러를 명시적으로 추가해(`close()` 호출 +
     `process.exit(0)`), 기존 `process.on("exit", ...)`만으로는 불명확했던 신호 경로를 확실하게
     처리한다.
  3. "서버 조립 결과에 명시적 close 제공"에 대해서는, `buildProductionDeps()`가 `sendLog`를
     `deps`와 별도로 반환해 호출자(`main()`)가 명시적으로 수명주기를 소유·관리하는 현재 구조를
     유지했다 — `createServer(deps)`는 의도적으로 자신이 만들지 않은 어댑터의 수명주기를 갖지
     않는다(e2e 테스트에서 목을 주입해 검증 가능해야 하므로). 이 설계 판단은
     `docs/DESIGN.md`/코드 주석에 명시했다.
- **변경 파일**: `src/server.ts`.
- **검증**:
  - "close()는 멱등이다 — 두 번 불러도 에러 없음(GAP-008)".
  - "같은 파일을 반복해서 열고 닫아도 자원이 누적되지 않는다" — SqliteSendLog를 50회 반복
    생성→claim→commit→close한 뒤, 새 인스턴스로 다시 열어 50건 전부가 손상 없이 남아 있음을
    확인(fd 고갈/파일 손상 없음의 근사 증거 — 실제 OS fd 카운트 측정은 플랫폼 종속적이라 하지
    않았다).
  - 수동 검증: 더미 자격증명으로 서버를 기동해 stdin을 닫아 정상 종료되는지, DB 파일이 실제로
    생성되는지 재확인(§4).

## 3. 사람 재확인이 필요한 항목 (완전 자동 해소 불가)

- **GAP-005(상태 컬럼 의미 재정의)**: 위 §2에서 설명한 트레이드오프에 동의하는지, 아니면 시트
  레이아웃/SPEC 계약을 바꿔서라도 "마지막 시도"와 "마지막 성공"을 분리하길 원하는지 결정이
  필요하다.
- **GAP-007(실제 수동 스모크)**: 사람이 실제 자격증명으로 수행해야 한다.
- **claim 만료 기준값**: `forceReleaseStaleClaim`은 `olderThanMs`를 호출자가 넘기도록 설계했다 —
  "얼마나 오래된 claim을 안전하다고 볼지"는 운영 판단(Resend/Google API의 실제 타임아웃·재시도
  정책에 달림)이라 이 세션에서 기본값을 확정하지 않았다. 실제 운영 스크립트를 만들 때 정해야 한다.

## 4. 검증 결과

### 자동 게이트

```
npm run check
```

- TypeScript typecheck: 통과
- ESLint: 통과
- Prettier: 통과
- Vitest: 13개 테스트 파일, **150개 테스트 통과** (GAPS 재검증 시점 130개 → +20)

### 커버리지

```
npm run test:coverage
```

| | Stmts | Branch | Funcs | Lines |
|---|---|---|---|---|
| All files (src/core/\*\*) | 93.24% | 82.52% | 100% | 93.24% |

목표(90% 이상) 유지. 브랜치 커버리지 하락은 claim/commit/release/forceReleaseStaleClaim의 분기가
늘어난 데 더해, 미달분이 여전히 기존 "내부 오류(버그 리포트)" 방어 가드뿐이기 때문이다.

### 수동 검증

1. fail-fast: 시크릿 미설정 시 `npm run dev` 즉시 명확한 에러로 종료.
2. 정상 기동: 더미 자격증명으로 `npm run dev`가 기동해 stdin 종료 시 자연 종료, DB 파일 생성 확인.
3. stdout 순수성 재확인: 실제 `.env` 존재 상태에서 stdout이 0바이트임을 재확인(REG-001/claim 재설계
   과정에서 회귀가 없었는지 재점검).
4. GAP-004: 셸 환경변수를 전부 비우고 `.env` 파일만으로 `SMOKE_SHEET_ID`/`SMOKE_SHOW_VALUES`가
   적용되는지 확인(§2 GAP-004 참고).

## 5. 추적 규칙

- 이 문서는 `ADVERSARIAL_REVIEW_003_RESOLUTION.md`, `ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md`를
  덮어쓰지 않고 후속 재검증 결과를 보존한다.
- 다음 적대적 검수는 `docs/ADVERSARIAL_REVIEW_004.md`로 기록한다. 특히 GAP-005(상태 컬럼 정책)와
  claim 만료 기준값 결정 여부를 그때 확인하면 좋다.
