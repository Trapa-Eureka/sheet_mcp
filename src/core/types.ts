// 도메인 타입 — docs/DESIGN.md §3과 1:1 대응. core/는 이 인터페이스만 알고 외부 IO를 모른다.

export interface SheetRow {
  rowIndex: number;
  values: Record<string, string>;
}

// sent_log_failed: 실제 발송(provider.send)은 성공했지만 SendLog에 그 사실을 기록하는 과정에서
// 실패한 상태 — docs/ADVERSARIAL_REVIEW_003.md AR-013. "발송은 됐다"는 사실 자체는 확정이므로
// failed(재시도 가능)로 두면 안 되고, 사람이 수동으로 SendLog/시트를 확인해야 하는 상태로 별도 분리한다.
export type SendStatus = "sent" | "failed" | "skipped_duplicate" | "sent_log_failed";

/**
 * writeStatus가 시트 상태 컬럼 4개(_send_status/_sent_at/_message_id/_error, DESIGN §2)에 반영할 행 단위 갱신.
 *
 * sentAt/messageId/error는 3단계 값을 가진다 (docs/ADVERSARIAL_REVIEW_003.md AR-014):
 * - `undefined`(필드 자체를 생략) — 그 컬럼은 **건드리지 않는다**. 예: sent 후 같은 행이 다시
 *   skipped_duplicate로 기록돼도 원래 _sent_at/_message_id는 감사 기록으로 남는다.
 * - `string` — 그 값으로 **덮어쓴다**.
 * - `null` — 그 셀을 **명시적으로 지운다**(빈 문자열로). 예: 실패했던 행이 이번에 성공하면
 *   과거 _error가 새 성공 옆에 잘못 남지 않도록 error를 null로 지운다.
 */
export interface StatusUpdate {
  rowIndex: number;
  sendStatus: SendStatus;
  sentAt?: string | null; // ISO 8601
  messageId?: string | null;
  error?: string | null;
}

export interface SheetClient {
  readConfig(sheetId: string): Promise<Record<string, string>>;
  readRows(sheetId: string, tab: string): Promise<SheetRow[]>;
  ensureStatusColumns(sheetId: string, tab: string): Promise<void>;
  writeStatus(sheetId: string, tab: string, updates: StatusUpdate[]): Promise<void>;
}

export type Channel = "email" | "sms";

export interface OutboundMessage {
  rowKey: string;
  to: string;
  subject?: string;
  body: string;
  channel: Channel;
}

export interface SendResult {
  rowKey: string;
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface NotificationProvider {
  readonly channel: Channel;
  send(msg: OutboundMessage): Promise<SendResult>;
}

/** SqliteSendLog의 unique 키(sheet_id, tab, row_key, template_hash — DESIGN §6)와 1:1 대응.
 * SendLog에는 확정 성공(claim 후 commit된) 발송만 남는다 — 검증 실패/발송 실패 행은 절대 기록되지 않는다
 * (데이터를 고치면 재시도할 수 있어야 하므로, DESIGN §4). */
export interface SendLogEntry {
  sheetId: string;
  tab: string;
  rowKey: string;
  templateHash: string;
  sendStatus: SendStatus;
  sentAt: string; // ISO 8601
  messageId?: string;
  error?: string;
}

/** list()의 조회 옵션 — 기본/최대 개수를 두어 이력이 무한정 쌓여도 응답이 무제한으로 커지지 않게 한다
 * (docs/ADVERSARIAL_REVIEW_003.md AR-015). */
export interface SendLogListOptions {
  /** 반환할 최대 건수. 생략하면 DEFAULT_SEND_LOG_LIST_LIMIT, 최대 MAX_SEND_LOG_LIST_LIMIT까지 허용. */
  limit?: number;
}

export const DEFAULT_SEND_LOG_LIST_LIMIT = 200;
export const MAX_SEND_LOG_LIST_LIMIT = 1000;

/**
 * SendLog — docs/ADVERSARIAL_REVIEW_003.md AR-011/AR-013 대응으로 claim/commit/release 3단계로
 * 재설계됐다. 예전 record()는 "먼저 전부 wasSent() 확인 → 나중에 전부 send"라는 배치 구조상,
 * 같은 실행 안에 같은 rowKey가 두 번 있거나 다른 프로세스가 동시에 실행되면 두 곳 다 wasSent=false를
 * 보고 실제로 중복 발송될 수 있었다(TOCTOU). claim()이 "확인"과 "예약"을 원자적 단일 연산으로
 * 묶어 이 틈을 없앤다.
 *
 * 파이프라인의 올바른 사용 순서(행 하나마다, 다음 행으로 넘어가기 전에 반드시 완료):
 *   1. claim() — false면 이미 선점됨(같은 배치의 앞선 행 / 동시 실행 중인 다른 프로세스 / 과거 성공)
 *      → provider를 호출하지 말고 skipped_duplicate 처리.
 *   2. true면 provider.send() 호출.
 *   3a. 성공하면 commit() — 예약을 최종 발송 기록으로 확정.
 *   3b. 실패(예외 포함)하면 release() — 예약을 해제해 다음 실행에서 재시도 가능하게 한다.
 * dry-run 미리보기는 상태를 바꾸면 안 되므로 claim() 대신 읽기 전용 wasSent()를 쓴다.
 */
export interface SendLog {
  /**
   * (sheetId, tab, rowKey, templateHash)에 대한 발송 권리를 원자적으로 예약한다.
   * true = 이 호출자가 유일하게 발송을 시도해도 된다는 뜻이며, placeholder 기록이 즉시 남는다.
   * false = 이미 다른 곳이 선점했다는 뜻 — 발송을 시도하지 말고 skipped_duplicate로 처리해야 한다.
   * true를 반환했다면 반드시 commit() 또는 release()로 마무리해야 한다(안 하면 영구히 재시도가 막힌다).
   */
  claim(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    claimedAt: string,
  ): boolean;

  /** claim()==true 뒤 실제 발송이 성공했을 때 호출해 예약을 최종 발송 기록으로 확정한다. */
  commit(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    sentAt: string,
    messageId: string | undefined,
  ): void;

  /** claim()==true 뒤 실제 발송이 실패했을 때 호출해 예약을 해제한다 — 다음 실행에서 재시도 가능해진다. */
  release(sheetId: string, tab: string, rowKey: string, templateHash: string): void;

  /** 이미 확정 발송된(commit된) 적 있는지 읽기 전용으로 조회한다. dry-run 미리보기 전용 —
   * 상태를 바꾸지 않으므로 발송 흐름의 중복 방지에는 쓰면 안 된다(claim()을 써야 한다). */
  wasSent(sheetId: string, tab: string, rowKey: string, templateHash: string): boolean;

  list(sheetId: string, options?: SendLogListOptions): SendLogEntry[];
}

/** 테스트 결정론용 — 실제 구현은 SqliteSendLog/파이프라인에서 Date.now() 대신 이 인터페이스를 주입받는다 */
export interface Clock {
  now(): Date;
}

/** core/template.ts renderTemplate()의 반환 타입. 결측 키는 throw가 아니라 missing[]로 담는다 */
export interface RenderResult {
  text: string;
  missing: string[];
}
