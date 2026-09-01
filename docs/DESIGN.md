# DESIGN — sheet_mcp v0.1

이 문서가 구현의 진실의 원천이다. 코드와 다르면 이 문서를 기준으로 코드를 고치거나, 설계 변경이 필요하면 이 문서를 먼저 수정한다.

## 1. 아키텍처

```
Claude Code / Claude Desktop
        │  (MCP stdio)
        ▼
  src/server.ts ──── MCP 도구 4종 등록만 담당
        │
        ▼
  core/pipeline.ts (SendPipeline)
   │        │           │            │
   ▼        ▼           ▼            ▼
SheetClient TemplateEngine NotificationProvider SendLog
   │                        │                    │
   ├ adapters/googleSheetClient (googleapis)     ├ adapters/sqliteSendLog
   ├ mocks/inMemorySheetClient  ├ adapters/resendProvider
                                ├ adapters/smtpProvider (옵션)
                                ├ adapters/semaphoreSmsProvider (v0.2 스텁)
                                └ mocks/mockNotificationProvider
```

원칙: `core/`는 인터페이스만 알고 외부 IO를 모른다. 어댑터 교체(이메일→SMS)가 파이프라인 코드 변경 없이 가능해야 한다.

## 2. 시트 규약

하나의 스프레드시트에 **데이터 탭**과 **`notify_config` 탭**을 둔다.

### notify_config 탭 (A열=키, B열=값)

| 키                 | 필수     | 예시                                                | 설명                                              |
| ------------------ | -------- | --------------------------------------------------- | ------------------------------------------------- |
| `data_tab`         | ✓        | `customers`                                         | 데이터 탭 이름                                    |
| `id_column`        | ✓        | `customer_id`                                       | 행 식별 컬럼 (멱등성 키)                          |
| `recipient_column` | ✓        | `email`                                             | 수신자 주소 컬럼                                  |
| `channel`          | ✓        | `email`                                             | v0.1은 `email`만 허용, `sms`는 명시적 미지원 에러 |
| `subject_template` | ✓(email) | `[{{shop}}] 결제 안내`                              | 제목 템플릿                                       |
| `body_template`    | ✓        | `{{name}}님, {{amount}} 결제 기한은 {{due}}입니다.` | 본문 템플릿                                       |
| `filter_column`    | –        | `status`                                            | 발송 대상 필터 컬럼                               |
| `filter_value`     | –        | `unpaid`                                            | 해당 값과 일치하는 행만 발송                      |

### 데이터 탭

- 1행은 헤더. 헤더명이 곧 템플릿 변수명이다.
- 파이프라인이 없으면 **상태 컬럼 4개를 헤더 끝에 추가**하고 이후 그 컬럼만 갱신한다:
  `_send_status`(`sent`/`failed`/`skipped_duplicate`/`sent_log_failed`), `_sent_at`(ISO 8601), `_message_id`, `_error`
  - `sent_log_failed`: 실제 발송(provider)은 성공했지만 SendLog에 그 사실을 기록하는 데 실패한 상태.
    "발송은 됐다"는 사실 자체가 확정이라 `failed`(재시도 가능)로 두면 재발송 사고가 나므로 별도로 분리한다
    (docs/ADVERSARIAL_REVIEW_003.md AR-013). 사람이 SendLog와 이 행을 수동으로 확인해야 한다.
- 사용자 데이터 컬럼은 절대 쓰지 않는다.
- 상태 컬럼 3가지 값의 결측 처리 정책(AR-014): `sent`가 되면 과거 `_error`는 지운다. `failed`가 되면
  과거 `_sent_at`/`_message_id`는 **보존**한다(그 행이 예전에 실제로 발송된 적 있다는 감사 기록은
  새 템플릿의 실패 시도로 지워지지 않는다). `skipped_duplicate`는 아무 것도 건드리지 않는다.
- **정책 결정(STATUS-GAP-004, GAP-005 후속)**: 위 보존 정책 때문에 한 행에 `_send_status=failed`와
  과거 성공의 `_message_id`/`_sent_at`이 동시에 남을 수 있다. 4개 상태 컬럼만 보고 "이 행이 지금
  성공 상태인지"를 판단하면 착각할 수 있으므로, 다음을 확정된 계약으로 둔다(위 세 옵션 중
  "현재 혼합 정책 유지 + 계약 명확화"를 선택):
  - `_send_status`는 **항상 가장 최근 실행(마지막 시도)** 의 결과만 나타낸다. `sent`/`sent_log_failed`
    일 때만 "지금 발송된 상태"로 해석해야 하고, `failed`/`skipped_duplicate`일 때 `_message_id`/
    `_sent_at`이 채워져 있어도 **그건 과거 시도의 감사 기록이지 이번 실행이 성공했다는 뜻이 아니다**.
  - 시트만 보고 자동화(다른 스크립트, 사람의 리포트)를 만들 때는 반드시 `_send_status`만으로
    성공/실패를 판정해야 한다. `_message_id`/`_sent_at`이 값을 가진다는 사실만으로 "발송 성공"을
    추론하면 안 된다.
  - "이 행/템플릿 조합이 과거에 실제로 발송된 적이 있는가"가 필요하면 시트가 아니라
    `SendLog.wasSent()`/`list()`(get_send_log MCP 도구)를 조회해야 한다 — SendLog가 진실의
    원천이고, 시트 상태 컬럼은 사람이 보기 위한 스냅샷일 뿐이다.
  - 시트 스키마(컬럼 4개)를 "마지막 시도"/"마지막 성공" 2세트로 분리하는 안(옵션 B)은 채택하지
    않는다 — 기존 시트 사용자에게 마이그레이션 부담을 주는 변경이라 v0.1에서는 보류한다.

## 3. 핵심 인터페이스 (TS 시그니처)

```ts
// core/types.ts
export interface SheetRow {
  rowIndex: number;
  values: Record<string, string>;
}

export type SendStatus = "sent" | "failed" | "skipped_duplicate" | "sent_log_failed";

// writeStatus가 시트에 반영하는 상태 컬럼 4개(§2)를 행 단위로 표현.
// sentAt/messageId/error는 3단계 값이다(AR-014):
// - undefined(필드 생략) = 그 컬럼을 건드리지 않는다.
// - string = 그 값으로 덮어쓴다.
// - null = 명시적으로 지운다(빈 문자열로).
export interface StatusUpdate {
  rowIndex: number;
  sendStatus: SendStatus;
  sentAt?: string | null;
  messageId?: string | null;
  error?: string | null;
}

// SendLog에는 이 두 상태만 저장된다. failed/skipped_duplicate/sent_log_failed는 시트에만 그
// 실행의 결과로 기록되고 SendLog에는 남지 않는다 — 시트용 SendStatus와 분리하는 이유다
// (docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md GAP-001/002).
export type SendLogEntryStatus = "claimed" | "sent";

export interface SheetClient {
  readConfig(sheetId: string): Promise<Record<string, string>>;
  readRows(sheetId: string, tab: string): Promise<SheetRow[]>;
  ensureStatusColumns(sheetId: string, tab: string): Promise<void>;
  writeStatus(sheetId: string, tab: string, updates: StatusUpdate[]): Promise<void>;
}

export interface OutboundMessage {
  rowKey: string;
  to: string;
  subject?: string;
  body: string;
  channel: "email" | "sms";
}

export interface SendResult {
  rowKey: string;
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface NotificationProvider {
  readonly channel: "email" | "sms";
  send(msg: OutboundMessage): Promise<SendResult>;
}

// SqliteSendLog의 unique 키(§6: sheet_id, tab, row_key, template_hash)와 1:1 대응.
export interface SendLogEntry {
  sheetId: string;
  tab: string;
  rowKey: string;
  templateHash: string;
  sendStatus: SendLogEntryStatus; // "claimed" | "sent" 뿐
  sentAt: string; // claimed면 claim된 시각, sent면 확정(commit)된 시각
  messageId?: string;
}

export interface SendLogListOptions {
  limit?: number; // 생략 시 200, 최대 1000 (AR-015)
  cursor?: string; // 이전 list() 결과의 nextCursor — 다음(더 오래된) 페이지 (GAP-006)
}

// hasMore/nextCursor는 limit+1개를 조회해 계산한 정확한 값이다 — "entries.length===limit이면 더
// 있다고 추측"하는 근사치가 아니다(GAP-006, 경계값에서 부정확했던 예전 방식).
export interface SendLogListResult {
  entries: SendLogEntry[];
  hasMore: boolean;
  nextCursor?: string; // hasMore===true일 때만 존재
}

// claim()의 결과. claimed===true일 때만 token이 존재하며 commit()/release()에 그대로 넘겨야 한다 —
// 만료된 claim을 사람이 forceReleaseStaleClaim()으로 회수한 뒤 같은 키가 다시 claim되면 새
// token이 발급되므로, 원래 시도(좀비 프로세스 등)가 뒤늦게 깨어나 옛 token으로 commit/release를
// 불러도 새 claim을 건드리지 못한다(GAP-001).
export interface ClaimResult {
  claimed: boolean;
  token?: string;
}

// claim/commit/release 3단계 + 소유권 토큰 + 만료 기반 수동 복구 — AR-011(같은 배치·동시 실행
// 중복 발송)/AR-013(발송 성공 후 로컬 기록 실패)/GAP-001(중단된 claim의 영구 방치) 대응.
// 예전 record()는 "먼저 전부 wasSent() 확인 → 나중에 전부 발송"이라는 배치 구조상, 같은 rowKey가
// 한 배치에 두 번 있거나 다른 프로세스가 동시에 실행되면 두 곳 다 wasSent=false를 보고 실제로
// 중복 발송될 수 있었다(TOCTOU). claim()이 "확인"과 "예약"을 원자적 단일 연산으로 묶어 이 틈을
// 없앤다. SqliteSendLog는 claim()을 UNIQUE 제약이 있는 컬럼에 대한 INSERT로 구현해 여러 프로세스가
// 같은 DB 파일을 봐도 원자성이 유지된다.
//
// claim 직후(commit/release 전) 프로세스가 죽으면 그 claim은 "claimed" 상태로 영구히 남는다 —
// 자동으로 "sent"도, 자동으로 재사용 가능으로도 되지 않는다(실제로 발송됐는지 알 수 없어서다).
// list()에서 sendStatus="claimed"로 그대로 보이므로 운영자가 발견할 수 있고, 충분히 오래됐다고
// 판단되면 forceReleaseStaleClaim()으로 **명시적으로만** 회수한다 — 자동 만료·자동 재사용은
// 하지 않는다. 이 복구 함수는 MCP 도구로는 노출하지 않는다(자율 에이전트가 "발송됐을 수도 있는"
// 상태를 스스로 재사용 가능하게 만드는 건 안전하지 않다 — 사람이 직접 검토 후 스크립트/REPL로
// 호출하는 것을 전제한다).
export interface SendLog {
  // claimed=true면 이 호출자가 유일하게 발송을 시도해도 됨(예약 성공) — 반환된 token을 반드시
  // commit() 또는 release()에 넘겨야 한다. claimed=false면 이미 선점됨(claimed든 sent든) →
  // 발송하지 말고 skipped_duplicate 처리.
  claim(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    claimedAt: string,
  ): ClaimResult;
  // claim()이 발급한 token과 일치하고 **아직 commit되지 않았을 때만** 예약을 최종 발송 기록으로
  // 확정한다(claimed→sent는 한 번만 일어나야 하는 전이). token 불일치든 이미 commit됐든 에러.
  commit(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    token: string,
    sentAt: string,
    messageId: string | undefined,
  ): void;
  // claim()이 발급한 token과 일치하고 **아직 commit되지 않았을 때만** 예약을 해제한다(재시도
  // 가능해짐). token이 불일치하거나 이미 commit(확정)된 기록이면 조용히 무시한다 — 확정된
  // 기록은 release()로도 절대 지워지지 않는다(재검증 중 발견·강화됨: 이 committed 체크가
  // 없으면 commit 성공 후 release가 잘못 불렸을 때 방금 확정한 발송 기록이 통째로 사라져
  // wasSent()가 false가 되고 재발송이 가능해지는 위험이 있었다).
  release(sheetId: string, tab: string, rowKey: string, templateHash: string, token: string): void;
  // claim된 지 olderThanMs 이상이고 아직 commit 안 된 claim만 강제로 회수한다(token 불필요 — 사람이
  // 직접 검토 후 호출). 조건에 안 맞으면 아무 것도 안 하고 false.
  forceReleaseStaleClaim(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    olderThanMs: number,
  ): boolean;
  // 읽기 전용 조회(dry-run 미리보기 전용 — 상태를 바꾸지 않는다. 발송 흐름의 중복 방지는 claim()을 쓴다).
  wasSent(sheetId: string, tab: string, rowKey: string, templateHash: string): boolean;
  list(sheetId: string, options?: SendLogListOptions): SendLogListResult;
}

export interface Clock {
  now(): Date;
} // 테스트 결정론용
```

```ts
// core/template.ts — 순수 함수
export interface RenderResult { text: string; missing: string[] }
renderTemplate(template: string, values: Record<string, string>): RenderResult
// {{key}} 치환. 값 결측 시 RenderResult.missing에 키를 담아 반환 (throw 아님 — 행 단위 실패 처리)
```

## 4. 발송 파이프라인 (core/pipeline.ts)

`run(sheetId, opts: { dryRun: boolean })` 순서:

1. `readConfig` → zod 파싱 (실패 시 어떤 키가 왜 틀렸는지 명시한 에러)
2. `readRows` → `filter_column/value` 적용
3. 행별 렌더링: 수신자 결측·이메일 형식 불량·템플릿 변수 결측 행은 `failed` 후보로 표시하고 계속 진행
   - `templateHash` = subject를 sha256, body를 sha256한 뒤 그 두 다이제스트를 이어붙여 다시 sha256한
     값의 앞 12자. subject/body 사이에 구분자 문자를 끼워 넣는 방식(과거 구현)은 그 구분자와 같은
     문자가 경계에 있으면 서로 다른 (subject,body) 조합이 같은 해시로 충돌할 수 있었다
     (`REG-001`, docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md — 실측으로 재현·확인됨). sha256
     다이제스트는 항상 고정 64자라 이어붙이는 경계가 내용에 따라 흔들리지 않아 이 문제가 없다.
     템플릿이 바뀌면 해시도 바뀌어 재발송이 허용된다(의도된 동작)
4. **dryRun이면**: `sendLog.wasSent(rowKey, templateHash)`(읽기 전용)로만 중복 표시하고 결과 반환.
   provider/sendLog/시트 쓰기는 전부 없음.
5. **dryRun이 아니면**: 행마다 다음을 **하나씩 끝까지 완결한 뒤 다음 행으로 넘어간다** (같은 배치에
   같은 rowKey가 두 번 있어도 두 번째 claim이 즉시 실패해 중복 발송을 막는다 — AR-011):
   1. `sendLog.claim(rowKey, templateHash)` → `claimed=false`면 `skipped_duplicate`(provider 호출 안 함)
   2. `claimed=true`면 `provider.send()` — **개별 try/catch**, 한 행 실패가 배치를 중단하지 않는다
   3. 성공하면 `sendLog.commit(token, ...)` → `sent`. commit 자체가 실패하면(발송은 됐지만 로컬
      기록 실패) `release()`하지 않고 `sent_log_failed`로 표시(재발송 사고 방지, AR-013)
   4. 실패(provider 실패/예외)면 `sendLog.release(token, ...)` → `failed` (다음 실행에서 재시도 가능).
      **release() 자체가 실패해도 절대 밖으로 던지지 않는다** — 실패 사실을 error 메시지와
      stderr에만 남기고, 나머지 행 처리는 계속한다(`GAP-003` — 예전에는 release 실패가 배치
      전체를 중단시켰다). 이 행의 claim은 재시도가 자동으로는 안 풀릴 수 있어 사람의
      `forceReleaseStaleClaim()` 확인이 필요할 수 있다.
6. `ensureStatusColumns` + `writeStatus` 일괄 write-back (§2 결측 정책, AR-014)
7. 집계 반환: `{ sent, failed, skipped, logFailed, details[] }`. `sent_log_failed`는 `sent`/`failed`
   어느 쪽 카운트에도 들어가지 않고 `logFailed`로 별도 집계된다 — `sent+failed+skipped+logFailed`는
   항상 `details.length`와 같다(집계 불변식, `GAP-002`)

## 5. MCP 도구 (src/server.ts)

`@modelcontextprotocol/sdk`, stdio transport. 입력 스키마는 zod.

| 도구                 | 입력                                           | 동작                                                                                                                                                                        |
| -------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_rows`          | `sheetId`                                      | config 적용된 대상 행 반환 (필터 반영, 최대 200행 미리보기)                                                                                                                 |
| `preview_messages`   | `sheetId`                                      | dryRun 파이프라인 실행 — 렌더된 메시지 목록과 결측/중복 경고 반환. **발송 없음**                                                                                            |
| `send_notifications` | `sheetId`, `confirm: boolean`                  | `confirm=true` **그리고** `SEND_MODE=live`일 때만 실발송. 아니면 dry-run 결과 + 안내 반환                                                                                   |
| `get_send_log`       | `sheetId`, `limit?: number`, `cursor?: string` | 발송 이력을 최신순으로 반환 (기본 200건, 최대 1000건). `hasMore=true`면 응답의 `nextCursor`를 다음 호출의 `cursor`로 넘겨 이어서 조회한다(정확한 hasMore — AR-015, GAP-006) |

안전장치가 이중인 이유: 에이전트가 자율 실행 중 실수로 실발송하는 사고를 막기 위해, 도구 파라미터(대화 레벨)와 환경변수(프로세스 레벨) 둘 다 요구한다.

## 6. 어댑터 메모

- **GoogleSheetClient**: `googleapis` + 서비스 계정. 시트를 서비스 계정 이메일에 공유하는 방식(v0.1). 읽기는 `values.get`, 상태 기록은 `values.batchUpdate`.
- **ResendEmailProvider**: REST 1콜. `RESEND_API_KEY`, `MAIL_FROM` 환경변수. 응답의 id를 `messageId`로 저장.
- **SmtpProvider(Nodemailer)**: Resend 미사용 환경 대비 대체 어댑터. v0.1에서 구현은 선택.
- **SemaphoreSmsProvider**: v0.1에서는 생성자에서 "Sender ID 등록 후 v0.2에서 활성화" 에러를 던지는 스텁만.
- **SqliteSendLog**: `better-sqlite3`, 파일 경로 `SEND_LOG_PATH`(기본 `./data/sendlog.db`). unique 키
  `(sheet_id, tab, row_key, template_hash)` — 이 unique 제약이 곧 claim()의 원자성 경계다(§3).
  `claim_token`(소유권 토큰)과 `committed`(0/1, claimed/sent 구분) 컬럼을 둔다. `close()`는 멱등이라
  (better-sqlite3 자체 보장, 수동 검증됨) 여러 종료 경로(정상/SIGINT/SIGTERM/`exit`)에서 겹쳐
  불려도 안전하다(AR-018/GAP-008).
  - **기존 DB 업그레이드(STATUS-GAP-001)**: T6 시절의 `record()` 전용 v1 스키마(`send_status`/
    `error` 컬럼, `claim_token`/`committed` 없음)로 만들어진 `sendlog.db`를 그대로 열어도 생성자가
    자동으로 v2(claim/commit) 스키마로 마이그레이션한다. 과거 `send_status='sent'`였던 행만
    `committed=1`인 확정 기록으로 옮기고(그래야 과거 발송분이 마이그레이션 후에도 중복 발송을
    계속 막는다), `failed`/`skipped_duplicate` 행은 옮기지 않는다(v1은 UNIQUE 제약 때문에 한 번
    실패하면 영구히 재시도가 막히는 버그가 있었고, 그 버그를 새 스키마로 옮기면 안 되기 때문).
    원본 v1 테이블은 지우지 않고 `send_log_v1_backup_<timestamp>_<random>`으로 이름만 바꿔 그대로
    남긴다. 전체가 하나의 트랜잭션이라 중간에 실패하면(예: 이전에 중단된 마이그레이션이 남긴
    `send_log_new` 임시 테이블과 충돌) 원본 `send_log`가 그대로 롤백돼 보존되고, 생성자가
    에이전트 친화적 에러로 원인과 조치를 안내하며 실패한다(fail-fast). 데이터 손실 없이 자동
    전환되므로 "DB 파일을 지우고 다시 만들라"는 예전 안내는 더 이상 필요/권장하지 않는다.
  - **stale claim 복구(STATUS-GAP-002/003)**: `forceReleaseStaleClaim(olderThanMs)`는 이제
    `olderThanMs`가 0 이상의 정수가 아니면(음수/NaN/Infinity/소수) 어떤 claim도 건드리기 전에
    즉시 에러를 던진다 — 음수를 잘못 넘기면 cutoff가 미래가 되어 방금 만든 최신 claim까지
    "오래됨"으로 오판해 삭제해버리는 사고를 막는다(InMemorySendLog와 공통 검증 함수
    `assertValidStaleClaimThreshold()`를 공유). 이 내부 API를 사람이 직접 안전하게 쓸 수 있도록
    `npm run recover:stale-claim`(`scripts/recoverStaleClaim.ts`) 운영 CLI를 제공한다: 기본은
    `--confirm` 없이 DB를 **readonly로 열어** 조회만 하고, 5분 미만의 `--older-than-ms`는
    `--i-understand-the-risk` 없이 거부하며, 모든 조회·회수 실행을 `data/recovery-audit.log`(JSON
    Lines, `RECOVERY_AUDIT_LOG_PATH`로 재지정 가능)에 남긴다. MCP 도구로는 여전히 노출하지 않는다
    (§3 SendLog 인터페이스 주석 참고 — 자율 에이전트가 "발송됐을 수도 있는" claim을 스스로
    회수 가능하게 만들면 안 된다는 원칙은 그대로다).

`npm run dev`/`npm run smoke`는 시작 시 `dotenv`로 `.env`를 로드한다(이미 설정된 실제 프로세스
환경변수는 덮어쓰지 않음). `createServer()`를 단독 import하는 테스트 경로에서는 절대 로드하지
않는다 — 테스트 결정론에 영향을 주지 않기 위함(AR-012).

## 7. 환경변수 (.env.example로 커밋)

```
SEND_MODE=dry_run              # dry_run | live
GOOGLE_SERVICE_ACCOUNT_JSON=   # 서비스 계정 키 JSON 경로
RESEND_API_KEY=
MAIL_FROM=notify@example.com
SEND_LOG_PATH=./data/sendlog.db
SMOKE_SHEET_ID=                # npm run smoke 대상 구글시트 ID (사람 전용 수동 스모크)
SMOKE_SHOW_VALUES=             # 1이면 smoke가 첫 행 실제 값을 출력 (기본은 컬럼명만, 민감정보 로그 방지)
SMOKE_CONFIRM_SEND=            # 1이면 smoke가 실발송에 동의(SEND_MODE=live와 함께 있어야 실제로 발송됨)
```

## 8. Claude Code 연결

프로젝트 스코프로 등록해 `.mcp.json`을 레포에 커밋한다(팀/미래의 나와 공유).

```bash
claude mcp add sheet-mcp --scope project -- npx tsx src/server.ts
```

생성되는 `.mcp.json` 형태:

```json
{
  "mcpServers": {
    "sheet-mcp": { "type": "stdio", "command": "npx", "args": ["tsx", "src/server.ts"] }
  }
}
```

연결 확인은 Claude Code 안에서 `/mcp`. 시크릿은 `.mcp.json`에 넣지 않고 셸 환경/.env로 공급한다.

## 9. 디렉터리 구조 (목표)

```
sheet_mcp/
  CLAUDE.md  README.md  .mcp.json  .env.example
  docs/  fixtures/sheets/  scripts/smoke.ts
  src/{core,adapters,mocks}/  src/server.ts
  tests/
```
