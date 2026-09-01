# 적대적 검수 리포트 003 STATUS — 주요 미해소 사항

- 작성일: 2026-09-01
- 검수 대상: `docs/ADVERSARIAL_REVIEW_003_STATUS.md`
- 관련 문서:
  - `docs/ADVERSARIAL_REVIEW_003.md`
  - `docs/ADVERSARIAL_REVIEW_003_RESOLUTION.md`
  - `docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md`
  - `docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS_RESOLVED.md`
- 기준 리비전: `2fe0293` (`GAP-009(재검증 중 발견): commit()/release()에 committed 가드 추가 + 최종 현황 문서`)
- 검수 원칙: 테스트 통과와 구현 존재만으로 완전 해소를 선언하지 않고, 기존 데이터에서의 업그레이드, 잘못된 운영 입력, 사람이 실제로 수행할 복구 절차와 수동 통합 검증까지 보수적으로 확인
- 변경 원칙: 제품 코드와 기존 감사 문서는 수정하지 않고, 잔여 사항만 신규 문서에 기록

## 1. 결론

`ADVERSARIAL_REVIEW_003_STATUS.md`가 설명한 핵심 코드 수정은 대부분 실제 구현과 일치한다. REG-001 템플릿 해시 충돌, 원자적 claim, 소유권 token, `committed=0` 가드, release 실패 격리, dotenv 평가 순서, cursor pagination, SQLite 종료 처리에는 대응 코드와 회귀 테스트가 존재한다. 정상 권한에서 `npm run check`도 156개 테스트 전부 통과했다.

그러나 다음 이유로 STATUS 문서의 "코드로 완전히 해소 가능한 항목은 전부 해소됐다"는 표현은 아직 보수적으로 성립하지 않는다.

1. 기존 SendLog DB를 새 스키마로 마이그레이션하지 않아 업데이트 직후 실제 발송 경로가 깨진다.
2. stale claim 강제 해제의 시간 입력을 검증하지 않아 음수 값으로 최신 claim까지 즉시 삭제할 수 있다.
3. stale claim 복구 함수는 존재하지만 사람이 안전하게 실행할 공식 CLI/스크립트와 감사 절차가 없다.
4. GAP-005의 상태 컬럼 의미와 GAP-007의 실제 Google Sheet+Resend 스모크는 여전히 미완료다.

따라서 현재 판정은 다음과 같다.

| 구분 | 판정 |
| --- | --- |
| 새로운 설치·새 DB에서의 자동 코드 경로 | 대체로 해소 |
| 기존 DB를 가진 설치의 업데이트 경로 | 미해소 |
| stale claim의 내부 데이터 모델 | 대체로 해소 |
| stale claim의 운영자 복구 경로 | 부분 해소 |
| 상태 컬럼 의미(GAP-005) | 사람 결정 대기 |
| 실제 수동 스모크(GAP-007) | 미완료 |

## 2. 주요 미해소 사항

### STATUS-GAP-001 — 기존 SendLog DB 스키마가 자동 마이그레이션되지 않음

- 심각도: 높음
- 연결 항목: GAP-001, GAP-002, AR-011, AR-013
- 위치: `src/adapters/sqliteSendLog.ts:61-84`
- 현상:
  - 이전 스키마에는 `send_status`, `error` 컬럼이 있고 `claim_token`, `committed` 컬럼은 없다.
  - 현재 생성자는 `CREATE TABLE IF NOT EXISTS`만 실행한다. 테이블이 이미 존재하면 새 컬럼을 추가하거나 데이터를 변환하지 않는다.
  - 현재 `claim()`은 `claim_token` 컬럼에 INSERT하고, `commit()`/`list()`는 `committed` 컬럼을 사용한다.
  - 코드 주석은 "v0.1은 아직 릴리스 전이므로 기존 DB를 지우고 다시 만들라"고 설명하지만, 실행 시 해당 안내를 출력하거나 자동으로 안전한 변환을 수행하지 않는다.

#### 실제 재현

이전 버전과 같은 스키마의 DB 파일을 만든 뒤 현재 `SqliteSendLog`로 열고 `claim()`을 호출했다.

```text
SqliteError: table send_log has no column named claim_token
```

즉 생성자 자체는 성공하지만 실제 발송 시점에야 실패한다. 파이프라인에서 `claim()`은 Provider 호출 전에 실행되므로 실발송은 발생하지 않지만, 해당 실행 전체가 예외로 종료될 수 있다.

#### 영향

- 기존 개발·스모크 환경이 코드를 업데이트한 직후 발송 기능을 사용할 수 없다.
- 단순히 DB 파일을 삭제하면 기존 멱등성 이력이 사라진다.
- 과거에 발송한 행이 새 DB에서는 미발송으로 보이므로 같은 템플릿이 다시 발송될 수 있다.
- "DB를 지우면 된다"는 대응은 데이터 손실과 중복 발송 위험 때문에 안전한 마이그레이션으로 볼 수 없다.

#### 필요한 조치

1. 생성 시 `PRAGMA table_info(send_log)` 또는 명시적 schema version 테이블로 현재 버전을 판별한다.
2. 기존 레코드를 보존하는 트랜잭션 마이그레이션을 구현한다.
3. 이전 `send_status='sent'` 레코드는 `committed=1`로 변환한다.
4. 과거 확정 레코드에 필요한 `claim_token`은 마이그레이션 전용 고유값을 생성하되 외부 claim 소유권으로 재사용되지 않게 한다.
5. 변환할 수 없는 상태가 있으면 서버가 도구 연결 전에 fail-fast하고, DB 경로와 백업·복구 방법을 에이전트 친화적 오류로 안내한다.
6. 마이그레이션 전 DB 백업 또는 원자적 임시 테이블 교체 전략을 문서화한다.

#### 완전 해소 기준

- 이전 스키마 DB 파일을 fixture로 생성하고 현재 생성자로 열었을 때 자동 변환된다.
- 기존 발송 기록의 `wasSent()`가 마이그레이션 후에도 true다.
- 기존 messageId와 sentAt이 보존된다.
- 같은 행/템플릿의 `claim()`은 false여서 재발송을 차단한다.
- 새 행은 정상적으로 claim→commit된다.
- 마이그레이션 중 실패해도 원본 DB가 손상되지 않는 테스트가 있다.
- README 또는 운영 문서에 업그레이드 및 백업 절차가 있다.

### STATUS-GAP-002 — `forceReleaseStaleClaim()`이 음수·비정상 시간값을 검증하지 않음

- 심각도: 중간
- 연결 항목: GAP-001
- 위치:
  - `src/adapters/sqliteSendLog.ts:168-185`
  - `src/mocks/inMemorySendLog.ts:119-132`
  - `src/core/types.ts:175-187`
- 현상:
  - `olderThanMs`는 `number`일 뿐, finite/정수/0 이상이라는 실행 시 검증이 없다.
  - SQLite 구현은 `new Date(Date.now() - olderThanMs)`로 cutoff를 만든다.
  - 음수를 주면 cutoff가 미래가 되어 방금 생성한 최신 claim도 "오래된 claim" 조건을 만족한다.
  - 인메모리 구현도 `ageMs < olderThanMs` 비교 때문에 음수 값에서 최신 claim을 해제한다.

#### 실제 재현

방금 생성한 claim에 `olderThanMs=-1`을 전달했다.

```json
{
  "released": true,
  "stillPresent": false
}
```

최신 claim이 즉시 삭제됐으므로 다른 실행이 같은 행을 다시 claim하고 중복 발송할 수 있다.

#### 추가 경계값

- `NaN`: SQLite에서는 `toISOString()`이 `RangeError`를 던질 수 있고 구현 간 동작이 달라질 수 있다.
- `Infinity`: 잘못된 Date를 만들 수 있다.
- 소수: 의미상 허용할 이유가 없으며 운영 입력 실수를 감춘다.
- 매우 작은 값(0 또는 1ms): 기능상 가능하지만 실제 발송이 진행 중인 claim을 성급히 회수할 위험이 매우 높다.

#### 필요한 조치

1. 두 어댑터가 같은 공통 검증 함수를 사용한다.
2. `Number.isFinite(olderThanMs)`, `Number.isInteger(olderThanMs)`, `olderThanMs >= 0`을 강제한다.
3. 운영용 복구 경로에서는 0보다 큰 보수적인 최소값을 별도로 강제한다.
4. 오류 메시지에 허용 단위(ms), 입력값, 안전한 수정 방법을 포함한다.
5. 가능하면 절대 cutoff ISO 시각을 사람이 확인해 넘기는 방식도 검토한다.

#### 완전 해소 기준

- `-1`, `NaN`, `Infinity`, 소수 입력을 명시적으로 거부한다.
- 잘못된 입력에서 어떤 claim도 삭제되지 않는다.
- InMemory와 SQLite 구현의 동작이 동일하다.
- 0ms 허용 여부와 운영 최소값 정책이 DESIGN 및 운영 문서에 명시된다.

### STATUS-GAP-003 — stale claim을 사람이 안전하게 복구할 공식 실행 경로가 없음

- 심각도: 중간
- 연결 항목: GAP-001, GAP-003
- 위치:
  - `src/core/types.ts:175-187`
  - `src/adapters/sqliteSendLog.ts:168-185`
  - `docs/DESIGN.md`의 claim 복구 설명
- 현상:
  - `forceReleaseStaleClaim()` 내부 API는 구현됐다.
  - 자율 MCP 도구로 노출하지 않은 것은 안전한 판단이다. 실제 발송됐을 가능성이 있는 claim을 에이전트가 자동으로 해제해서는 안 된다.
  - 하지만 사람을 위한 별도 CLI, 운영 스크립트, dry-run 검사 명령, 승인 문구, 감사 로그도 없다.
  - 함수가 클래스 메서드로만 존재하므로 운영자는 직접 TypeScript 코드를 작성하거나 임시 REPL 명령을 만들어야 한다.

#### 영향

- release 실패 또는 프로세스 중단으로 claim이 남으면 실제 운영에서 복구 방법을 즉시 수행할 수 없다.
- 임시 코드 작성 과정에서 sheetId/tab/rowKey/templateHash를 잘못 입력하거나 너무 짧은 만료 시간을 선택할 수 있다.
- 강제 해제 사실이 감사 기록에 남지 않아 누가 왜 재발송 가능 상태로 바꿨는지 추적하기 어렵다.

#### 필요한 조치

사람 전용 운영 CLI 또는 스크립트를 추가한다. 권장 흐름:

1. DB 경로와 대상 키를 명시적으로 입력한다.
2. 먼저 read-only inspection을 실행해 claim 시각, 경과 시간, 수신 행 정보를 출력한다.
3. 기본값은 dry-run이며 어떤 레코드도 삭제하지 않는다.
4. 실제 해제는 별도의 명시적 confirm 문구나 환경변수를 요구한다.
5. 확정 sent 레코드는 어떤 옵션으로도 삭제할 수 없어야 한다.
6. 해제 전후 내용을 민감정보 없이 별도 감사 로그에 남긴다.
7. 해제 후 즉시 재발송하지 않고, Provider 대시보드/messageId/수신자 확인 절차를 안내한다.

#### 완전 해소 기준

- 운영자가 제품 코드 수정 없이 공식 명령으로 claim을 조회할 수 있다.
- 기본 실행은 read-only다.
- 잘못된 키, 젊은 claim, 확정 sent를 안전하게 거부한다.
- 명시적 승인 없이 claim을 삭제하지 않는다.
- 수행 결과와 사유를 감사 가능한 형태로 남긴다.
- 문서에 권장 `olderThanMs` 결정 기준과 Provider 확인 절차가 있다.

### STATUS-GAP-004 — GAP-005 상태 컬럼 의미 결정이 완료되지 않음

- 심각도: 중간
- 연결 항목: GAP-005, AR-014
- 위치:
  - `src/core/pipeline.ts`의 `toStatusUpdate()`
  - `docs/DESIGN.md` 상태 컬럼 정책
- 현재 정책:
  - failed→sent 전이에서는 과거 `_error`를 지운다.
  - sent→새 템플릿 failed 전이에서는 과거 `_sent_at`과 `_message_id`를 보존한다.
- 잔여 문제:
  - `_send_status=failed`와 과거 성공의 `_message_id`가 한 행에 공존한다.
  - 네 상태 컬럼만 보는 사람이나 자동화는 현재 실패와 과거 성공을 구분하기 어렵다.
  - STATUS 문서도 이를 사람의 정책 판단 대기로 남겼으므로 완전 해소가 아니다.

#### 필요한 결정

- 선택 A: 네 상태 컬럼은 "마지막 시도"만 나타내고 과거 성공은 SendLog에서 조회한다.
- 선택 B: "마지막 시도" 컬럼과 "마지막 성공" 컬럼을 분리한다.
- 선택 C: 현재 혼합 정책을 유지하되 컬럼명과 문서를 더 명확히 바꾸고 후속 자동화가 `_send_status`만 기준으로 삼도록 강제한다.

#### 완전 해소 기준

- 사람이 A/B/C 중 정책을 결정한다.
- SPEC, DESIGN, 시트 컬럼명, 파이프라인, Google/InMemory 어댑터 테스트가 같은 의미를 사용한다.
- sent→failed, failed→sent, sent→duplicate 전이가 사람과 자동화 모두에게 모호하지 않다.

### STATUS-GAP-005 — 실제 Google Sheet+Resend 수동 스모크 미완료

- 심각도: 중간(릴리스 완료 판정 차단)
- 연결 항목: GAP-007, AR-016, T10
- 위치:
  - `docs/TASKS.md` T10
  - `docs/SPEC.md` §5
  - `scripts/smoke.ts`
- 현상:
  - 스모크 코드와 안전 게이트는 구현돼 있다.
  - 실제 Google Sheet 권한, Resend 발신 도메인, 실제 이메일 1건, Google 상태 write-back, 동일 실행 재시도의 중복 차단은 아직 통합 검증되지 않았다.
  - 문서가 `MANUAL SMOKE PENDING`으로 표시한 것은 정확하지만 제품 성공 기준은 아직 충족되지 않았다.

#### 완전 해소 기준

1. 실제 테스트 시트에서 dry-run을 실행한다.
2. 발송 대상이 정확히 1행인지 확인한다.
3. `SEND_MODE=live`와 `SMOKE_CONFIRM_SEND=1`을 모두 사용해 실제 이메일 1건을 발송한다.
4. 수신 이메일, Resend messageId, 시트 `_send_status/_sent_at/_message_id/_error`를 확인한다.
5. 같은 설정으로 다시 실행해 Provider 재호출 없이 `skipped_duplicate`가 되는지 확인한다.
6. SendLog에서 해당 기록이 `sent`인지 확인한다.
7. 실행 일시, 익명화한 시트 식별 정보, messageId의 비민감 일부, 두 번째 실행 결과를 감사 문서에 기록한다.

## 3. 추가 관찰 사항

### OBS-001 — claim 복구 임계값이 아직 운영 정책으로 확정되지 않음

- `STATUS.md`도 `forceReleaseStaleClaim(olderThanMs)`의 실제 운영 값을 확정하지 않았다고 명시한다.
- 이는 단순한 상수 선택 문제가 아니다. Provider 요청 timeout, 네트워크 재시도, Resend 측 비동기 처리, 운영자의 대시보드 확인 가능 시간과 연결된다.
- 너무 짧으면 처리 중인 발송을 재사용 가능하게 만들어 중복 발송할 수 있고, 너무 길면 미발송 행이 오래 차단된다.
- 실제 수동 스모크와 장애 주입 결과를 바탕으로 보수적인 기본값과 최소 허용값을 정해야 한다.

### OBS-002 — 기존 DB 삭제 안내가 사용자 문서에 없음

- 기존 스키마 비호환 설명은 소스 코드 주석에만 있다.
- README, DESIGN의 실행 절차, 오류 메시지에서는 기존 DB를 어떻게 판별하고 백업할지 알 수 없다.
- 단, DB 삭제 자체는 멱등성 이력을 제거하므로 권장 해결책으로 문서화해서는 안 된다. 안전한 마이그레이션이 우선이다.

## 4. 이미 확인된 정상 조치

다음 변경은 STATUS 문서의 주장과 실제 코드가 일치했다.

- REG-001: subject/body 각각을 먼저 sha256한 뒤 고정 길이 digest를 재해시해 경계 충돌 제거
- GAP-001 일부: `claimed`/`sent` 상태 분리, claim token, 잘못된 token 방어
- GAP-002: `logFailed` 별도 집계와 집계 불변식 복원
- GAP-003: `safeRelease()`가 release 오류를 행 단위로 격리
- GAP-004: dotenv 로드 후 `SMOKE_SHOW_VALUES` 평가
- GAP-006: `limit+1`, 정확한 `hasMore`, cursor pagination
- GAP-008: SIGINT/SIGTERM/exit 정리와 SQLite 반복 open/close 테스트
- GAP-009: commit된 레코드를 release할 수 없고 이중 commit을 거부
- 음수 SendLog 조회 limit이 SQLite의 무제한 `LIMIT -1`로 전달되지 않도록 최소 1로 제한

## 5. 검증 결과

### 자동 품질 게이트

정상 로컬 IPC 권한에서 `npm run check` 재실행:

- TypeScript typecheck: 통과
- ESLint: 통과
- Prettier: 통과
- Vitest: 13개 테스트 파일, 156개 테스트 통과

### 추가 수동 재현

#### 기존 DB 스키마

이전 테이블 구조를 가진 DB에서 현재 `claim()` 호출:

```text
SqliteError: table send_log has no column named claim_token
```

#### 음수 stale 기준

최신 claim에 `olderThanMs=-1` 적용:

```json
{
  "released": true,
  "stillPresent": false
}
```

두 문제 모두 현재 156개 테스트에는 포함되지 않아 전체 게이트 통과만으로 발견되지 않는다.

## 6. 조치 우선순위

1. STATUS-GAP-001: 기존 DB의 무손실·원자적 스키마 마이그레이션
2. STATUS-GAP-002: stale 시간 입력 검증 및 안전한 최소값 정책
3. STATUS-GAP-003: 사람 전용 read-only 우선 복구 CLI와 감사 로그
4. STATUS-GAP-004: 상태 컬럼 의미에 대한 사람 결정 및 계약 통일
5. STATUS-GAP-005: 실제 Google Sheet+Resend 수동 스모크
6. OBS-001: 실제 운영 claim 만료 기준값 결정

## 7. 추적 규칙

- 이 문서는 기존 `ADVERSARIAL_REVIEW_003_STATUS.md`를 덮어쓰지 않고 후속 보수적 재검증 결과를 보존한다.
- 수정 커밋과 테스트 이름에 `STATUS-GAP-001`~`STATUS-GAP-005`를 연결한다.
- STATUS-GAP-001~003을 해결하기 전에는 "코드로 완전히 해소 가능한 항목은 전부 해소"로 표시하지 않는다.
- STATUS-GAP-004는 사람의 정책 결정이 코드·SPEC·DESIGN에 반영된 뒤 해소 판정한다.
- STATUS-GAP-005는 실제 스모크 증거가 기록된 뒤에만 해소 판정한다.
