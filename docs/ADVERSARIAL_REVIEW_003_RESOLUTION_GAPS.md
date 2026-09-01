# 적대적 검수 리포트 003 — 미해소 내역 재검증

- 재검증일: 2026-09-01
- 대상 리포트: `docs/ADVERSARIAL_REVIEW_003.md`
- 대상 수정 기록: `docs/ADVERSARIAL_REVIEW_003_RESOLUTION.md`
- 기준 리비전: `fa8b5b6` (`AR-011~018: 적대적 검수 리포트 003 반영`)
- 검수 원칙: 수정 기록의 선언이나 테스트 통과만으로 해소 판정하지 않고, 원래 실패 경로와 운영 중단·복구 경로를 보수적으로 재검증
- 변경 원칙: 제품 코드는 변경하지 않고 미해소 사항만 별도 기록

## 1. 결론

`ADVERSARIAL_REVIEW_003_RESOLUTION.md`의 "AR-011~018 전 항목 조치"는 코드 변경 여부를 뜻하는 표현으로는 맞지만, "전 항목 완전 해소"로 해석하면 정확하지 않다.

보수적 재검증 결과:

| 항목 | 재검증 판정 | 요약 |
| --- | --- | --- |
| AR-011 | 부분 해소 | 동시 claim은 원자적이나 중단된 claim의 만료·복구가 없어 미발송 행이 영구 차단될 수 있음 |
| AR-012 | 부분 해소 | dotenv는 로드되지만 smoke의 `SMOKE_SHOW_VALUES`는 로드 전에 평가됨 |
| AR-013 | 부분 해소 | API 결과는 `sent_log_failed`지만 SQLite에는 claim이 계속 `sent`로 노출됨 |
| AR-014 | 부분 해소 | failed→sent 잔여 오류는 정리되지만 sent→failed의 모순 상태는 정책적으로 유지됨 |
| AR-015 | 부분 해소 | 응답 상한은 생겼지만 cursor가 없고 `truncated`가 부정확함 |
| AR-016 | 미완료 | 실제 Google Sheet+Resend 수동 스모크가 수행되지 않음 |
| AR-017 | 완전 해소 | 명백한 불량 이메일이 발송 전에 차단되고 회귀 테스트가 존재함 |
| AR-018 | 대체로 해소 | smoke 정리는 적절하나 서버 종료 수명주기와 반복 생성 검증이 충분하지 않음 |

또한 수정 과정에서 템플릿 해시 구분자가 NUL에서 공백으로 바뀌어 서로 다른 템플릿이 같은 해시를 만들 수 있는 신규 회귀가 확인됐다.

## 2. 미해소 및 부분 해소 상세

### GAP-001 — 중단된 claim이 영구 `sent` 기록으로 남음

- 연결 항목: AR-011
- 심각도: 높음
- 위치:
  - `src/adapters/sqliteSendLog.ts:77-98`
  - `src/core/pipeline.ts:253-307`
  - `src/core/types.ts:99-131`
- 현상:
  - `SqliteSendLog.claim()`은 발송 전에 DB 행을 삽입하면서 즉시 `send_status='sent'`를 기록한다.
  - claim 성공 후 Provider 호출 전이나 호출 도중 프로세스가 강제 종료되면 `commit()`과 `release()`가 모두 실행되지 않는다.
  - 해당 행은 실제 발송 여부와 무관하게 `wasSent()=true`가 되고, 이후 실행은 영구적으로 `skipped_duplicate` 처리한다.
  - claim에 만료 시각, 별도 `claimed` 상태, 소유 토큰, 복구 명령이 없다.
- 영향:
  - 실제로 발송되지 않은 고객이 발송 완료로 간주될 수 있다.
  - 운영자는 `get_send_log`에서도 이를 정상 `sent`로 보게 되어 누락을 발견하기 어렵다.
  - AR-011의 중복 발송 경쟁은 완화됐지만, 그 대신 영구 발송 누락 위험이 생겼다.
- 필요한 조치:
  1. DB 상태를 `claimed`와 `sent`로 분리한다.
  2. claim에 `claim_token`, `claimed_at`, 만료 정책을 둔다.
  3. 만료 claim은 자동 재확정보다 수동 확인 또는 명시적 복구 절차를 우선한다. Provider가 이미 처리했을 가능성이 있기 때문이다.
  4. 정상 실패는 token이 일치할 때만 release하고 정상 성공은 token이 일치할 때만 commit한다.
- 완전 해소 기준:
  - claim 후 프로세스 중단을 모사한 테스트가 존재한다.
  - 미확정 claim이 `sent`로 조회되지 않는다.
  - 만료·복구·수동 확인 정책이 `DESIGN.md`에 명시된다.

### GAP-002 — commit 실패 상태가 SQLite에 `sent_log_failed`로 보존되지 않음

- 연결 항목: AR-013
- 심각도: 높음
- 위치:
  - `src/core/pipeline.ts:270-296`
  - `src/adapters/sqliteSendLog.ts:87-90`, `100-120`
- 현상:
  - Provider 성공 후 `commit()`이 실패하면 파이프라인의 이번 응답과 시트에는 `sent_log_failed`가 표시된다.
  - 그러나 DB claim은 생성 시점부터 `send_status='sent'`이며, commit 실패 시 이를 `sent_log_failed`로 바꾸는 별도 저장 경로가 없다.
  - 따라서 프로세스가 끝난 뒤 `get_send_log`를 조회하면 장애가 정상 `sent`로 보일 수 있다.
  - 시트 write-back마저 실패하면 `sent_log_failed` 사실은 stderr 외에는 구조적으로 남지 않는다.
- 영향:
  - 수정 기록이 주장하는 "사람이 SendLog와 시트를 확인"하는 절차에서 SendLog가 잘못된 정보를 제공한다.
  - 장애 조사와 수동 복구 판단이 어려워진다.
- 필요한 조치:
  - claim 상태와 최종 상태를 분리하고, commit 실패를 durable하게 기록할 수 있는 별도 best-effort 경로 또는 append-only incident log를 둔다.
  - 적어도 확정되지 않은 claim을 정상 `sent`로 반환하지 않는다.
  - `sent_log_failed`를 `sent`/`failed`/`skipped` 집계 어디에도 넣지 않는 현재 응답은 합계 불변식을 깨므로 별도 `uncertain` 또는 `logFailed` 집계를 추가한다.
- 완전 해소 기준:
  - 실제 SQLite 구현에서 commit 실패 후 재기동해도 장애 상태를 구분할 수 있다.
  - `get_send_log`가 해당 행을 정상 `sent`로 반환하지 않는다.
  - `details.length`와 집계 합계의 관계가 문서화되고 테스트된다.

### GAP-003 — release 실패가 행 격리를 깨고 전체 배치를 중단할 수 있음

- 연결 항목: AR-011, AR-013
- 심각도: 높음
- 위치: `src/core/pipeline.ts:297-306`
- 현상:
  - Provider가 `ok=false`를 반환하면 `release()`를 호출한 뒤 행을 failed로 바꾼다.
  - 이 `release()`가 DB 잠금·IO 오류 등으로 throw하면 바깥 catch가 다시 `release()`를 호출한다.
  - 두 번째 release도 throw하면 예외가 `attemptSend()` 밖으로 전파되어 다음 행 처리가 중단된다.
  - Provider 자체가 throw한 경로에서도 catch 내부의 release 실패는 그대로 전파된다.
- 영향:
  - "한 행 실패가 나머지 배치를 중단하지 않는다"는 핵심 파이프라인 계약이 SendLog 장애에서는 지켜지지 않는다.
  - 실패한 claim도 남아 다음 실행을 영구 차단할 수 있다.
- 필요한 조치:
  - Provider 오류와 release 오류를 별도 상태로 모델링한다.
  - release를 중복 호출하지 않고, release 실패가 다른 행 처리를 중단하지 않게 격리한다.
  - release 실패 역시 재발송 안전성을 고려한 durable incident 상태로 남긴다.
- 완전 해소 기준:
  - `release()` 실패 주입 시 이후 행도 계속 처리된다.
  - Provider 호출 수와 최종 상세 상태가 명확하다.
  - 같은 행의 후속 실행 정책이 테스트로 고정된다.

### GAP-004 — `.env`의 `SMOKE_SHOW_VALUES`가 적용되지 않음

- 연결 항목: AR-012
- 심각도: 중간
- 위치: `scripts/smoke.ts:24`, `43-49`
- 현상:
  - `SHOW_VALUES` 상수는 모듈 로드 시 `process.env.SMOKE_SHOW_VALUES`를 읽는다.
  - dotenv는 그보다 나중인 `main()` 안에서 호출된다.
  - 따라서 셸에서 직접 export하지 않고 `.env`에만 `SMOKE_SHOW_VALUES=1`을 적은 경우 실제 값 출력이 활성화되지 않는다.
- 영향:
  - README/.env 계약이 일부 환경변수에서 여전히 일관되지 않다.
  - 민감정보가 의도치 않게 출력되는 방향은 아니므로 안전상 fail-closed지만, 진단 옵션이 문서대로 동작하지 않는다.
- 필요한 조치:
  - dotenv 로드 후 `SHOW_VALUES`를 계산하거나 `formatDetail()`에 명시적으로 전달한다.
  - `.env`만 사용한 자식 프로세스 테스트로 `SMOKE_SHOW_VALUES` 적용을 확인한다.
- 완전 해소 기준:
  - 셸 export 없이 `.env`의 `SMOKE_SHOW_VALUES=1`이 적용된다.
  - 기본값에서는 계속 비민감 메타데이터만 출력된다.

### GAP-005 — sent→failed 전이의 상태 모순이 의도적으로 남아 있음

- 연결 항목: AR-014
- 심각도: 중간
- 위치:
  - `src/core/pipeline.ts:350-389`
  - `docs/DESIGN.md` §2·§3 상태 컬럼 정책
- 현상:
  - failed→sent 전이에서는 과거 `_error`를 지우므로 원래 문제의 절반은 해결됐다.
  - 반대로 과거 sent 행이 새 템플릿에서 failed가 되면 현재 `_send_status=failed`와 과거 `_sent_at`/`_message_id`가 공존한다.
  - 수정 기록도 이 충돌이 완전히 해소되지 않았음을 명시한다.
- 영향:
  - 시트의 네 상태 컬럼만으로 "현재 시도"와 "과거 성공"을 구분할 수 없다.
  - 담당자 또는 후속 자동화가 `_message_id` 존재 여부를 현재 성공으로 오인할 수 있다.
- 필요한 조치:
  - 현재 시도 상태와 과거 성공 감사 정보를 별도 컬럼 또는 SendLog 조회로 분리한다.
  - 기존 네 컬럼만 유지한다면 각 컬럼의 의미가 마지막 시도인지 마지막 성공인지 일관되게 정해야 한다.
- 완전 해소 기준:
  - sent→새 템플릿 failed 상태가 사람과 자동화 모두에게 모호하지 않다.
  - 상태 컬럼 의미가 SPEC/DESIGN/코드/테스트에서 동일하다.

### GAP-006 — SendLog 조회는 제한됐지만 페이지 이동과 정확한 `truncated`가 없음

- 연결 항목: AR-015
- 심각도: 중간
- 위치:
  - `src/adapters/sqliteSendLog.ts:130-140`
  - `src/server.ts:122-131`
- 현상:
  - 기본 200, 최대 1000 limit은 단일 호출의 메모리 사용량을 제한하므로 원래 위험을 상당 부분 완화한다.
  - 하지만 cursor가 없어 1000건보다 오래된 기록은 MCP 도구로 조회할 방법이 없다.
  - `truncated`는 `entries.length >= effectiveLimit`으로 계산하므로 전체 기록 수가 limit과 정확히 같아도 `true`다.
- 영향:
  - 감사 이력 조회가 불완전하고, 클라이언트가 존재하지 않는 다음 페이지를 예상할 수 있다.
- 필요한 조치:
  - `limit + 1`건을 조회해 실제 `hasMore`를 판정한다.
  - 안정적인 DB `id` 또는 `(sent_at, id)` cursor를 입출력 계약에 추가한다.
- 완전 해소 기준:
  - 199/200/201건 경계에서 `truncated` 또는 `hasMore`가 정확하다.
  - 두 페이지 이상을 중복·누락 없이 순회하는 테스트가 존재한다.

### GAP-007 — 실제 수동 스모크가 여전히 미완료

- 연결 항목: AR-016
- 심각도: 중간(릴리스 완료 판정 차단)
- 위치: `docs/TASKS.md` T10, `docs/SPEC.md` §5
- 현상:
  - 문서 상태를 `CODE DONE / MANUAL SMOKE PENDING`으로 바로잡은 조치는 적절하다.
  - 그러나 실제 Google Sheet+Resend 실발송, 상태 write-back, 두 번째 실행의 중복 차단은 아직 수행되지 않았다.
- 완전 해소 기준:
  1. 실제 테스트 시트에서 dry-run 결과를 확인한다.
  2. 실제 이메일 1건을 발송한다.
  3. 시트 상태와 SendLog messageId를 확인한다.
  4. 같은 조건으로 재실행해 Provider 호출 없이 `skipped_duplicate`가 되는지 확인한다.
  5. 시크릿 없이 실행 일시와 결과를 감사 기록에 남긴다.

### GAP-008 — 서버 SQLite 종료 수명주기 검증이 불충분함

- 연결 항목: AR-018
- 심각도: 낮음
- 위치: `src/server.ts:165-173`
- 현상:
  - smoke의 `try/finally`는 정상·조기 return·예외 경로에서 DB를 닫으므로 적절하다.
  - 서버는 `process.on("exit")`에만 close를 연결했다. MCP 서버의 명시적 close/dispose와 의존성 수명주기가 연결돼 있지 않다.
  - 원 리포트가 권고한 반복 생성·종료 시 파일 descriptor 안정성 테스트도 없다.
- 필요한 조치:
  - 서버 조립 결과에 명시적 `close()`/`dispose()`를 제공하고 정상 종료·signal·초기화 실패 경로에서 한 번만 호출한다.
  - close의 멱등성 또는 중복 호출 방어 정책을 둔다.
  - 반복 생성·종료 자원 회귀 테스트를 추가한다.
- 완전 해소 기준:
  - 정상 종료, 초기화 실패, 대표 signal 경로의 정리가 검증된다.
  - 장수 프로세스에서 반복 생성·종료해도 DB 핸들이 누적되지 않는다.

## 3. 신규 회귀

### REG-001 — 템플릿 해시 구분자가 NUL에서 공백으로 바뀌어 충돌 가능

- 심각도: 높음
- 위치: `src/core/pipeline.ts:55-61`
- 기준 리비전과의 차이:
  - 이전 구현: `subjectTemplate + NUL + bodyTemplate`
  - 현재 구현: `subjectTemplate + " " + bodyTemplate`
  - 주석은 여전히 NUL 구분자를 사용한다고 설명해 코드와도 불일치한다.
- 재현:

```text
subject="A ", body="B"
subject="A",  body=" B"
```

두 조합은 해시 입력 바이트가 모두 `"A  B"`가 되어 현재 구현에서 같은 12자리 해시를 생성한다.

실측 결과:

```json
{"a":"a70bb07d2189","b":"a70bb07d2189","collision":true}
```

- 영향:
  - 서로 다른 템플릿이 같은 멱등성 키로 취급된다.
  - 사용자가 템플릿을 수정했는데도 재발송이 `skipped_duplicate`로 잘못 차단될 수 있다.
- 필요한 조치:
  - NUL 구분자를 복원하거나 길이-prefix와 같이 모호하지 않은 직렬화를 사용한다.
  - subject/body 경계 공백 조합의 충돌 회귀 테스트를 추가한다.
- 완전 해소 기준:
  - 위 두 조합의 해시가 다르다.
  - 코드 주석과 실제 직렬화 방식이 일치한다.

## 4. 완전 해소가 확인된 항목

### AR-017 — 이메일 형식 검증

- `z.string().email()`을 이용해 `a@`, `@example.com`, `a@@example.com`, 공백 포함 주소를 Provider 호출 전에 차단한다.
- 대표 불량 주소에 대한 component 회귀 테스트가 존재한다.
- 기존 정상 주소 및 1,000행 픽스처 테스트도 통과한다.
- 판정: 완전 해소.

## 5. 자동 검증 결과

정상 로컬 IPC 권한에서 `npm run check` 실행 결과:

- TypeScript typecheck: 통과
- ESLint: 통과
- Prettier: 통과
- Vitest: 13개 테스트 파일, 130개 테스트 통과

제한 샌드박스에서는 e2e 자식 `tsx`의 Unix socket 생성이 `EPERM`으로 실패했으나, 정상 권한 재실행에서 130개 전부 통과했다. 이는 제품 결함이 아닌 실행 환경 제약이다.

자동 게이트가 통과해도 GAP-001~008과 REG-001은 프로세스 중단, DB 장애, 정확한 pagination, 환경변수 로드 순서처럼 현재 테스트가 다루지 않는 경로이므로 해소 판정에 영향을 준다.

## 6. 조치 우선순위

1. REG-001 템플릿 해시 충돌 회귀 수정
2. GAP-001/GAP-002: `claimed`/`sent` 상태 분리와 중단·commit 실패 복구 설계
3. GAP-003: release 실패의 행 단위 격리
4. GAP-004: smoke 환경변수 평가 순서 수정
5. GAP-005: 현재 상태와 과거 성공 감사 정보 분리
6. GAP-006: 정확한 hasMore와 cursor pagination
7. GAP-007: 실제 수동 스모크 수행
8. GAP-008: 서버 자원 수명주기 및 반복 종료 검증

## 7. 추적 규칙

- 이 문서는 `ADVERSARIAL_REVIEW_003_RESOLUTION.md`를 덮어쓰지 않고 후속 재검증 결과를 보존한다.
- 수정 커밋과 테스트 이름에 `GAP-001`~`GAP-008`, `REG-001`을 연결한다.
- 모든 완료 기준을 충족하기 전에는 AR-011~016 및 AR-018을 "완전 해소"로 표시하지 않는다.
