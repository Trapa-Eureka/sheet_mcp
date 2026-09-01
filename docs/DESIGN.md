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
  `_send_status`(`sent`/`failed`/`skipped_duplicate`), `_sent_at`(ISO 8601), `_message_id`, `_error`
- 사용자 데이터 컬럼은 절대 쓰지 않는다.

## 3. 핵심 인터페이스 (TS 시그니처)

```ts
// core/types.ts
export interface SheetRow {
  rowIndex: number;
  values: Record<string, string>;
}

export type SendStatus = "sent" | "failed" | "skipped_duplicate";

// writeStatus가 시트에 반영하는 상태 컬럼 4개(§2)를 행 단위로 표현.
// sentAt/messageId/error가 결측(undefined)이면 "빈 값으로 지운다"가 아니라 "그 컬럼은 건드리지 않는다"는 뜻이다.
// (예: sent 후 같은 행이 다시 skipped_duplicate로 기록돼도 원래 _sent_at/_message_id는 감사 기록으로 남아야 한다.)
export interface StatusUpdate {
  rowIndex: number;
  sendStatus: SendStatus;
  sentAt?: string;
  messageId?: string;
  error?: string;
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

// SqliteSendLog의 unique 키(§6: sheet_id, tab, row_key, template_hash)와 1:1 대응
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

export interface SendLog {
  wasSent(sheetId: string, tab: string, rowKey: string, templateHash: string): boolean;
  record(entry: SendLogEntry): void;
  list(sheetId: string): SendLogEntry[];
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
3. 행별 렌더링: 수신자 결측·템플릿 변수 결측 행은 `failed` 후보로 표시하고 계속 진행
4. 멱등성 검사: `sendLog.wasSent(rowKey, templateHash)` → true면 `skipped_duplicate`
   - `templateHash` = subject+body 템플릿의 sha256 앞 12자. 템플릿이 바뀌면 재발송 허용됨(의도된 동작)
5. `dryRun`이면 여기서 결과(발송될 목록)만 반환
6. 행별 `provider.send()` — **개별 try/catch**, 한 행 실패가 배치를 중단하지 않는다
7. `sendLog.record` + `writeStatus` 일괄 write-back
8. 집계 반환: `{ sent, failed, skipped, details[] }`

## 5. MCP 도구 (src/server.ts)

`@modelcontextprotocol/sdk`, stdio transport. 입력 스키마는 zod.

| 도구                 | 입력                          | 동작                                                                                      |
| -------------------- | ----------------------------- | ----------------------------------------------------------------------------------------- |
| `read_rows`          | `sheetId`                     | config 적용된 대상 행 반환 (필터 반영, 최대 200행 미리보기)                               |
| `preview_messages`   | `sheetId`                     | dryRun 파이프라인 실행 — 렌더된 메시지 목록과 결측/중복 경고 반환. **발송 없음**          |
| `send_notifications` | `sheetId`, `confirm: boolean` | `confirm=true` **그리고** `SEND_MODE=live`일 때만 실발송. 아니면 dry-run 결과 + 안내 반환 |
| `get_send_log`       | `sheetId`                     | SQLite 발송 이력 반환                                                                     |

안전장치가 이중인 이유: 에이전트가 자율 실행 중 실수로 실발송하는 사고를 막기 위해, 도구 파라미터(대화 레벨)와 환경변수(프로세스 레벨) 둘 다 요구한다.

## 6. 어댑터 메모

- **GoogleSheetClient**: `googleapis` + 서비스 계정. 시트를 서비스 계정 이메일에 공유하는 방식(v0.1). 읽기는 `values.get`, 상태 기록은 `values.batchUpdate`.
- **ResendEmailProvider**: REST 1콜. `RESEND_API_KEY`, `MAIL_FROM` 환경변수. 응답의 id를 `messageId`로 저장.
- **SmtpProvider(Nodemailer)**: Resend 미사용 환경 대비 대체 어댑터. v0.1에서 구현은 선택.
- **SemaphoreSmsProvider**: v0.1에서는 생성자에서 "Sender ID 등록 후 v0.2에서 활성화" 에러를 던지는 스텁만.
- **SqliteSendLog**: `better-sqlite3`, 파일 경로 `SEND_LOG_PATH`(기본 `./data/sendlog.db`). unique 키 `(sheet_id, tab, row_key, template_hash)`.

## 7. 환경변수 (.env.example로 커밋)

```
SEND_MODE=dry_run              # dry_run | live
GOOGLE_SERVICE_ACCOUNT_JSON=   # 서비스 계정 키 JSON 경로
RESEND_API_KEY=
MAIL_FROM=notify@example.com
SEND_LOG_PATH=./data/sendlog.db
SMOKE_SHEET_ID=                # npm run smoke 대상 구글시트 ID (사람 전용 수동 스모크, T3+)
SMOKE_SHOW_VALUES=             # 1이면 smoke가 첫 행 실제 값을 출력 (기본은 컬럼명만, 민감정보 로그 방지)
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
