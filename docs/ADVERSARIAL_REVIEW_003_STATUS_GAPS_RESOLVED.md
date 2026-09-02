# 적대적 검수 리포트 003 STATUS_GAPS — 조치 결과

- 작성일: 2026-09-01
- 대상 문서: `docs/ADVERSARIAL_REVIEW_003_STATUS_GAPS.md` (STATUS-GAP-001~005, OBS-001~002)
- 관련 문서 체인:
  - `docs/ADVERSARIAL_REVIEW_003.md` (AR-011~018)
  - `docs/ADVERSARIAL_REVIEW_003_RESOLUTION.md`
  - `docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md` (GAP-001~008, REG-001)
  - `docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS_RESOLVED.md`
  - `docs/ADVERSARIAL_REVIEW_003_STATUS.md`
  - `docs/ADVERSARIAL_REVIEW_003_STATUS_GAPS.md` ← 이번 조치 대상
- 변경 원칙: 기존 감사 문서(위 목록)는 수정하지 않는다. 이 문서가 그 결과를 기록한다.

## 1. 결론

`ADVERSARIAL_REVIEW_003_STATUS_GAPS.md`가 지적한 5개 주요 미해소 항목(STATUS-GAP-001~005)과
관찰 사항(OBS-001~002) 중, **코드·CLI·문서로 해소 가능한 항목은 전부 조치했다.** 사람의 실제
자격증명(Google Sheets/Resend)이 있어야만 수행 가능한 STATUS-GAP-005(실제 수동 스모크)만은
이번에도 코드로 대신할 수 없어 여전히 미완료다 — 이 문서는 그 사실을 숨기지 않고 그대로 남긴다.

| 구분                                            | 판정                                             |
| ------------------------------------------------ | ------------------------------------------------- |
| STATUS-GAP-001 — 기존 v1 DB 스키마 자동 마이그레이션 | **해소** — 무손실 자동 변환 + 원본 백업 + 롤백 안전성 테스트 |
| STATUS-GAP-002 — olderThanMs 입력 검증           | **해소** — 공통 검증 함수, 두 어댑터 모두 적용     |
| STATUS-GAP-003 — 사람 전용 stale claim 복구 CLI  | **해소** — `npm run recover:stale-claim` 신규     |
| STATUS-GAP-004 — 상태 컬럼 의미 정책 결정        | **해소** — 옵션 C(현재 정책 유지 + 계약 명확화) 채택·문서화 |
| STATUS-GAP-005 — 실제 Google Sheet+Resend 스모크 | **미해소** — 실제 자격증명이 필요해 이번에도 수행 불가 |
| OBS-001 — claim 만료 임계값 운영 확정            | **미해소(그대로 둠)** — 실제 운영 데이터가 있어야 정할 수 있는 값 |
| OBS-002 — 기존 DB 삭제/업그레이드 안내 문서화    | **해소** — README §운영, DESIGN §6에 추가          |

## 2. STATUS-GAP-001 — 기존 SendLog DB 스키마 자동 마이그레이션

### 조치

`src/adapters/sqliteSendLog.ts` 생성자가 `PRAGMA table_info(send_log)`로 기존 테이블의 스키마
버전을 판별한다(`detectSchemaVersion()`, export됨).

- `none`(테이블 없음): 새 v2 스키마로 바로 생성.
- `v2_claim`(`claim_token`/`committed` 컬럼 있음): 이미 최신 스키마 — 아무 것도 하지 않음.
- `v1_record`(`send_status` 컬럼만 있음, T6 시절 record() 스키마): `migrateV1ToV2()`가 자동 변환.
- 그 외(알 수 없는 컬럼 구성): 마이그레이션을 시도하지 않고 원인·조치를 안내하는 에러로 즉시 실패.

`migrateV1ToV2()`는 단일 트랜잭션(`db.transaction()`)으로 다음을 수행한다.

1. 이전에 중단된 마이그레이션이 남긴 `send_log_new` 임시 테이블이 있으면 즉시 에러(충돌 방지).
2. v2 스키마로 `send_log_new`를 만든다.
3. 이전 `send_status='sent'`였던 행만 `committed=1`(확정)로 옮긴다. `claim_token`은 마이그레이션
   전용 신규 UUID를 발급한다(과거 실행이 그 토큰으로 commit/release를 부를 일이 없으므로 소유권
   충돌이 생기지 않는다). `failed`/`skipped_duplicate`였던 행은 **의도적으로 옮기지 않는다** —
   v1은 UNIQUE 제약 때문에 한 번 실패로 기록되면 같은 키를 영구히 재시도할 수 없었던 버그가
   있었고(바로 이 버그가 AR-011/GAP-001이 claim/commit 재설계로 고치려던 문제), 그 버그를 새
   스키마로 그대로 옮기면 안 되기 때문이다.
4. 원본 `send_log`는 지우지 않고 `send_log_v1_backup_<timestamp>_<random>`으로 이름만 바꾼다.
5. `send_log_new`를 `send_log`로 바꾼다.

트랜잭션이라 1번(충돌) 또는 그 사이 어떤 SQL 오류가 나도 better-sqlite3가 전부 롤백해 원본
`send_log`가 손상 없이 그대로 남는다 — 생성자는 이를 감싸 "원본은 보존됐다"는 문구가 포함된
에이전트 친화적 에러로 다시 던진다.

### 검증

`tests/sqliteSendLog.test.ts`의 `v1(T6 record) → v2(claim/commit) 자동 마이그레이션` describe
블록(6개 테스트)이 실제로:

- 이전 `send_status='sent'` fixture DB를 만들고 새 `SqliteSendLog`로 열었을 때 `wasSent()=true`,
  `claim()=false`, `list()`가 원래 `messageId`/`sentAt`을 그대로 보존한 채 `sendStatus='sent'`로
  반환하는지.
- `failed`/`skipped_duplicate` 행은 옮겨지지 않아 그 키를 다시 `claim()`할 수 있는지.
- 마이그레이션 후 `send_log_v1_backup_*` 테이블이 원본 행 그대로 남아 있는지(raw SQLite 쿼리로
  직접 확인).
- `send_log_new` 임시 테이블이 이미 있는 상태(중단된 마이그레이션 흉내)에서 생성자가 던지고,
  원본 v1 `send_log` 테이블의 컬럼/행이 마이그레이션 시도 전과 동일하게 남아 있는지.
- 이미 v2 스키마인 DB는 마이그레이션 없이(백업 테이블 생성 없이) 그대로 열리는지.
- v1도 v2도 아닌 알 수 없는 컬럼 구성은 명시적 에러를 던지는지.

`npm run recover:stale-claim`으로도 실제 v1 DB 파일을 만들어 수동 실행 확인함(§4 참고).

### 완전 해소 기준 대조

STATUS-GAP-001의 7개 완전 해소 기준(문서 원문) 중 "README 또는 운영 문서에 업그레이드 및 백업
절차가 있다"까지 포함해 전부 충족했다 — README `운영` 절, `docs/DESIGN.md` §6에 반영(§6 참고).

## 3. STATUS-GAP-002 — olderThanMs 입력 검증

### 조치

`src/core/types.ts`에 `assertValidStaleClaimThreshold(olderThanMs)`를 신설했다. `Number.isInteger`
검사 하나로 음수/NaN/Infinity/소수를 전부 거부한다(NaN·Infinity는 애초에 `isInteger`가 false).
`SqliteSendLog.forceReleaseStaleClaim()`과 `InMemorySendLog.forceReleaseStaleClaim()` 양쪽 모두
이 **하나의 공통 함수**를 함수 맨 앞에서 호출해, 검증에 실패하면 cutoff 계산이나 DELETE/삭제
로직에 도달하기 전에 던진다 — 잘못된 입력에서는 어떤 claim도 건드려지지 않는다.

### 검증

두 어댑터의 테스트 파일에 각각 `it.each([-1, NaN, Infinity, -Infinity, 1.5])` 파라미터화 테스트를
추가해, 5개 경계값 전부가 즉시 에러를 던지고 방금 만든 claim이 그대로 남아 있는지(`wasSent()`로
확인) 검증한다. `olderThanMs=0`은 유효한 값으로 허용됨도 별도 테스트로 확인했다.

### 완전 해소 기준 대조

"운영용 복구 경로에서는 0보다 큰 보수적인 최소값을 별도로 강제한다"는 이 함수 자체가 아니라
STATUS-GAP-003의 CLI가 담당한다(5분 미만은 `--i-understand-the-risk` 없이 거부, §4).
"0ms 허용 여부와 운영 최소값 정책이 DESIGN 및 운영 문서에 명시된다"는 `docs/DESIGN.md` §6에
반영했다.

## 4. STATUS-GAP-003 — stale claim 사람 전용 복구 CLI

### 조치

`scripts/recoverStaleClaim.ts` 신규(`npm run recover:stale-claim`). 요구했던 흐름을 그대로
구현했다.

- **기본은 read-only 조회**: `--confirm` 없이 실행하면 DB를 `new Database(path, {readonly:true})`로
  연다 — 구조적으로 SQLite 자체가 어떤 쓰기도 거부하므로, 이 경로는 코드에 버그가 있어도
  아무 것도 지울 수 없다. claim 존재 여부, `committed` 여부, claim(또는 확정) 이후 경과 시간을
  출력한다.
- **명시적 확인 없이는 삭제 없음**: `--confirm`이 있어야만 (그리고 그 시점에만) 쓰기 가능한
  연결로 `SqliteSendLog`를 열어 `forceReleaseStaleClaim()`을 호출한다.
- **확정 sent 기록은 어떤 옵션으로도 삭제 불가**: `forceReleaseStaleClaim()` 자체가
  `committed=0`인 행만 대상으로 하므로(§ GAP-001/GAP-009), CLI가 별도로 재확인해도 그 아래 계층이
  이미 막고 있다. CLI는 조회 결과가 `committed=true`면 `--confirm`을 줘도 애초에
  `forceReleaseStaleClaim()`을 호출하지 않고 "회수할 대상이 없다"고 안내한다.
- **운영 최소값**: `--older-than-ms` 기본값 30분, **5분 미만은 `--i-understand-the-risk` 플래그
  없이는 거부**한다(STATUS-GAP-002의 완전 해소 기준에서 요구한 "운영용 복구 경로의 보수적 최소값").
- **감사 로그**: 조회(`inspect`)와 실제 회수(`force_release`) 둘 다 `data/recovery-audit.log`(JSON
  Lines, `RECOVERY_AUDIT_LOG_PATH`로 재지정 가능)에 시각·인자·결과·`--reason`을 기록한다. 시트
  값이나 이메일 본문 등 민감정보는 애초에 이 스크립트가 다루지 않는다(sheetId/tab/rowKey/
  templateHash는 AR-009 기준으로 이미 비민감 메타데이터로 취급됨).
- **재발송 안내**: 회수에 성공하면 "재발송 전에 Provider 대시보드에서 실제로 이미 발송되지
  않았는지 확인하라"는 경고를 출력하고, 이 스크립트 자체는 재발송을 수행하지 않는다(별도로
  파이프라인을 다시 실행해야 함을 명시).

### 검증

실제로 v2 스키마 DB 파일을 만들어 4단계(조회 → 너무 짧은 `--older-than-ms` 거부 → 정상 회수 →
회수 후 재조회)를 수동으로 실행해 출력과 감사 로그 내용을 확인했다(이 문서 작성 세션에서 직접
실행, 결과는 기대한 그대로였고 임시 산출물은 정리함). `npm run check`에는 포함하지 않는다 —
`smoke.ts`와 같은 성격의 사람 전용 도구다.

### 완전 해소 기준 대조

문서가 요구한 6개 기준(제품 코드 수정 없이 조회, 기본 read-only, 잘못된 키/젊은 claim/확정 sent
안전 거부, 명시적 승인 없이 삭제 안 함, 감사 가능한 기록, 권장 `olderThanMs` 결정 기준과 Provider
확인 절차 문서화) 전부 충족했다.

## 5. STATUS-GAP-004 — 상태 컬럼 의미(GAP-005) 정책 결정

STATUS-GAP-004는 코드 버그가 아니라 "네 상태 컬럼만으로 과거 성공/현재 실패를 구분하기 어렵다"는
**제품 정책 미결정**이었다. 이번에 세 옵션(A: 마지막 시도만 표시, B: 시도/성공 컬럼 분리, C: 현재
혼합 정책 유지 + 계약 명확화) 중 **옵션 C**를 채택해 결정을 확정했다.

### 결정 이유

- 옵션 B(컬럼 분리)는 기존 사용자의 시트 스키마 변경(컬럼 추가)을 강제해 v0.1 범위를 넘는 마이그
  레이션 부담을 준다.
- 옵션 A(마지막 시도만 표시하고 과거 성공은 항상 SendLog 조회)는 시트만 보는 사람이 "이 행이
  과거에 한 번이라도 성공했는지"를 확인할 수 없게 되어, AR-014가 애초에 보존하려던 감사 가치를
  없앤다.
- 옵션 C는 코드 변경이 전혀 필요 없고(현재 구현이 이미 이 정책과 일치), "계약을 명확히 문서화하지
  않았다"는 것이 실제 결함이었으므로 문서 보강만으로 완전히 해소된다.

### 조치

`docs/DESIGN.md` §2에 "정책 결정(STATUS-GAP-004, GAP-005 후속)" 절을 추가해 다음을 명문화했다.

- `_send_status`는 항상 **가장 최근 실행(마지막 시도)** 만을 나타낸다.
- `failed`/`skipped_duplicate`일 때 `_message_id`/`_sent_at`에 값이 있어도 그건 과거 시도의 감사
  기록이지 "이번 실행이 성공했다"는 뜻이 아니다 — 자동화는 반드시 `_send_status`만으로 성공/실패를
  판정해야 한다.
- "이 행/템플릿 조합이 과거에 실제로 발송된 적 있는가"는 시트가 아니라 `SendLog.wasSent()`/
  `list()`(`get_send_log` MCP 도구)로 조회해야 한다 — SendLog가 진실의 원천이다.
- 옵션 B는 v0.1에서 채택하지 않는다는 점도 명시했다(향후 필요해지면 별도 태스크로 재논의).

### 완전 해소 기준 대조

"사람이 A/B/C 중 정책을 결정한다"는 이 문서 자체가 그 결정이다. "SPEC, DESIGN, 시트 컬럼명,
파이프라인, 어댑터 테스트가 같은 의미를 사용한다"는 이미 일치하고 있었고(코드는 애초에 옵션 C대로
동작 중이었다), 이번에 DESIGN.md에 그 의미를 명문화해 "왜 이렇게 동작하는지"를 문서만 보고도 알 수
있게 했다. 전이 규칙(sent→failed, failed→sent, sent→duplicate)이 모호하지 않다는 것도 기존
`toStatusUpdate()`와 AR-014 회귀 테스트로 이미 검증돼 있다(변경 없음).

## 6. STATUS-GAP-005 — 실제 Google Sheet+Resend 수동 스모크 (미해소)

이번 세션에도 `.env` 파일이 존재하지 않고(확인함), 실제 Google 서비스 계정 키·Resend API 키·테스트
전용 구글시트가 없다. 코드/CLI/문서만으로는 이 항목을 대신할 수 없다 — 실제 발송 인프라와 사람의
승인이 필요한 항목이라는 것이 GAP-007/AR-016 때부터 반복해서 확인된 성격이다.

완전 해소 기준(문서 원문 §2 STATUS-GAP-005) 7단계는 그대로 유효하며, 실행 준비(스모크 코드, 이중
안전장치, `MANUAL SMOKE PENDING` 표시)는 이미 되어 있다. **사람이 실제 자격증명으로
`npm run smoke`(dry-run) → `SEND_MODE=live SMOKE_CONFIRM_SEND=1 npm run smoke`(실발송 1건) →
재실행(중복 차단 확인) 순서로 직접 수행하고, 그 결과를 별도 감사 문서에 남겨야 완전 해소로
표시할 수 있다.**

## 7. OBS-001 — claim 복구 임계값 운영 확정 (미해소, 의도적으로 그대로 둠)

`forceReleaseStaleClaim(olderThanMs)`의 실제 운영 기본값은 이번에도 코드 상수로 확정하지 않았다.
STATUS-GAP-003 CLI에 넣은 "5분 미만은 `--i-understand-the-risk` 없이 거부"는 **입력 실수 방지용
가드**일 뿐, "실제로 몇 분이 적절한 stale 기준인가"라는 운영 정책 질문에 대한 답은 아니다. 이
값은 Resend 응답 지연, 재시도 정책, 운영자가 대시보드를 확인하는 데 걸리는 실제 시간처럼 실제
운영 데이터가 쌓여야 정할 수 있다 — STATUS-GAP-005의 실제 스모크가 선행돼야 의미 있는 값을 고를
수 있으므로, 그 전까지는 미해소로 남겨 둔다.

## 8. OBS-002 — 기존 DB 삭제 안내 문서화

STATUS-GAP-001 조치로 "DB를 지우고 다시 만들라"는 안내 자체가 더 이상 필요하지 않게 됐다(자동
마이그레이션이 무손실이므로). 대신 새 자동 업그레이드 동작과 STATUS-GAP-003 복구 CLI 사용법을
`README.md`의 신규 "운영 — 기존 DB 업그레이드 / stale claim 복구" 절과 `docs/DESIGN.md` §6에
추가했다.

## 9. 자동 품질 게이트

```
npm run check
  ✓ typecheck (tsc --noEmit)
  ✓ lint (eslint .)
  ✓ format:check (prettier --check .)
  ✓ test (vitest run) — 13 test files, 174 tests passed (기존 156 + 신규 18)

npm run test:coverage
  core/ 전체 93.36% stmts/lines (기존 93.24%에서 소폭 상승 — types.ts 100% 유지)
```

kingfish/DevWork 두 워크트리 모두에서 동일하게 확인함(§10 커밋 동기화 참고).

## 10. 추적 규칙

- 이 문서는 `docs/ADVERSARIAL_REVIEW_003_STATUS_GAPS.md`를 덮어쓰지 않는다.
- STATUS-GAP-005와 OBS-001은 실제 스모크 증거가 기록되기 전까지 미해소로 유지한다 — 코드
  게이트 통과나 이 문서의 존재를 근거로 "완전 해소"라고 말하지 않는다.
- 이후 재검수가 나오면 `docs/ADVERSARIAL_REVIEW_004.md`로 새로 시작한다(기존 체인은 보존).
