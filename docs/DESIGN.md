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
// SendLog에는 확정 성공(claim 후 commit된) 발송만 남는다 — 검증 실패/발송 실패 행은 기록되지 않는다.
export interface SendLogEntry {
  sheetId: string;
  tab: string;
  rowKey: string;
  templateHash: string;
  sendStatus: SendStatus;
  sentAt: string;
  messageId?: string;
  error?: string;
}

export interface SendLogListOptions {
  limit?: number; // 생략 시 200, 최대 1000 (AR-015)
}

// claim/commit/release 3단계 — AR-011(같은 배치·동시 실행 중복 발송)/AR-013(발송 성공 후 로컬 기록
// 실패) 대응. 예전 record()는 "먼저 전부 wasSent() 확인 → 나중에 전부 발송"이라는 배치 구조상,
// 같은 rowKey가 한 배치에 두 번 있거나 다른 프로세스가 동시에 실행되면 두 곳 다 wasSent=false를
// 보고 실제로 중복 발송될 수 있었다(TOCTOU). claim()이 "확인"과 "예약"을 원자적 단일 연산으로
// 묶어 이 틈을 없앤다. SqliteSendLog는 claim()을 UNIQUE 제약이 있는 컬럼에 대한 INSERT로 구현해
// 여러 프로세스가 같은 DB 파일을 봐도 원자성이 유지된다.
export interface SendLog {
  // true = 이 호출자가 유일하게 발송을 시도해도 됨(예약 성공). false = 이미 선점됨 → 발송하지 말고
  // skipped_duplicate 처리. true를 반환했다면 반드시 commit() 또는 release()로 마무리해야 한다.
  claim(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    claimedAt: string,
  ): boolean;
  // claim()==true 뒤 발송 성공 시 예약을 최종 기록으로 확정한다.
  commit(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    sentAt: string,
    messageId: string | undefined,
  ): void;
  // claim()==true 뒤 발송 실패 시 예약을 해제한다 — 다음 실행에서 재시도 가능해진다.
  release(sheetId: string, tab: string, rowKey: string, templateHash: string): void;
  // 읽기 전용 조회(dry-run 미리보기 전용 — 상태를 바꾸지 않는다. 발송 흐름의 중복 방지는 claim()을 쓴다).
  wasSent(sheetId: string, tab: string, rowKey: string, templateHash: string): boolean;
  list(sheetId: string, options?: SendLogListOptions): SendLogEntry[];
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
   - `templateHash` = subject+body 템플릿의 sha256 앞 12자. 템플릿이 바뀌면 재발송 허용됨(의도된 동작)
4. **dryRun이면**: `sendLog.wasSent(rowKey, templateHash)`(읽기 전용)로만 중복 표시하고 결과 반환.
   provider/sendLog/시트 쓰기는 전부 없음.
5. **dryRun이 아니면**: 행마다 다음을 **하나씩 끝까지 완결한 뒤 다음 행으로 넘어간다** (같은 배치에
   같은 rowKey가 두 번 있어도 두 번째 claim이 즉시 실패해 중복 발송을 막는다 — AR-011):
   1. `sendLog.claim(rowKey, templateHash)` → false면 `skipped_duplicate` (provider 호출 안 함)
   2. true면 `provider.send()` — **개별 try/catch**, 한 행 실패가 배치를 중단하지 않는다
   3. 성공하면 `sendLog.commit(...)` → `sent`. commit 자체가 실패하면(발송은 됐지만 로컬 기록
      실패) `release()`하지 않고 `sent_log_failed`로 표시(재발송 사고 방지, AR-013)
   4. 실패(provider 실패/예외)면 `sendLog.release(...)` → `failed` (다음 실행에서 재시도 가능)
6. `ensureStatusColumns` + `writeStatus` 일괄 write-back (§2 결측 정책, AR-014)
7. 집계 반환: `{ sent, failed, skipped, details[] }` (`sent_log_failed`는 어느 카운트에도 들어가지
   않는다 — details[]에서 상태를 직접 확인해야 한다)

## 5. MCP 도구 (src/server.ts)

`@modelcontextprotocol/sdk`, stdio transport. 입력 스키마는 zod.

| 도구                 | 입력                          | 동작                                                                                      |
| -------------------- | ----------------------------- | ----------------------------------------------------------------------------------------- |
| `read_rows`          | `sheetId`                     | config 적용된 대상 행 반환 (필터 반영, 최대 200행 미리보기)                               |
| `preview_messages`   | `sheetId`                     | dryRun 파이프라인 실행 — 렌더된 메시지 목록과 결측/중복 경고 반환. **발송 없음**          |
| `send_notifications` | `sheetId`, `confirm: boolean` | `confirm=true` **그리고** `SEND_MODE=live`일 때만 실발송. 아니면 dry-run 결과 + 안내 반환 |
| `get_send_log`       | `sheetId`, `limit?: number`   | 발송 이력을 최신순으로 반환 (기본 200건, 최대 1000건 — AR-015)                            |

안전장치가 이중인 이유: 에이전트가 자율 실행 중 실수로 실발송하는 사고를 막기 위해, 도구 파라미터(대화 레벨)와 환경변수(프로세스 레벨) 둘 다 요구한다.

## 6. 어댑터 메모

- **GoogleSheetClient**: `googleapis` + 서비스 계정. 시트를 서비스 계정 이메일에 공유하는 방식(v0.1). 읽기는 `values.get`, 상태 기록은 `values.batchUpdate`.
- **ResendEmailProvider**: REST 1콜. `RESEND_API_KEY`, `MAIL_FROM` 환경변수. 응답의 id를 `messageId`로 저장.
- **SmtpProvider(Nodemailer)**: Resend 미사용 환경 대비 대체 어댑터. v0.1에서 구현은 선택.
- **SemaphoreSmsProvider**: v0.1에서는 생성자에서 "Sender ID 등록 후 v0.2에서 활성화" 에러를 던지는 스텁만.
- **SqliteSendLog**: `better-sqlite3`, 파일 경로 `SEND_LOG_PATH`(기본 `./data/sendlog.db`). unique 키
  `(sheet_id, tab, row_key, template_hash)` — 이 unique 제약이 곧 claim()의 원자성 경계다(§3).

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
