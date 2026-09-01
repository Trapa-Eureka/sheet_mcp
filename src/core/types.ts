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

/**
 * SendLog에 실제로 저장되는 두 상태뿐이다 — "claimed"(예약됐지만 아직 확정 안 됨) 또는
 * "sent"(commit으로 확정된 실제 발송). failed/skipped_duplicate/sent_log_failed는 SendLog에
 * 저장되지 않는다(시트에만 그 실행의 결과로 기록됨) — 이 타입을 시트용 SendStatus와 분리해 둔
 * 이유다 (docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md GAP-001/GAP-002).
 */
export type SendLogEntryStatus = "claimed" | "sent";

/** SqliteSendLog의 unique 키(sheet_id, tab, row_key, template_hash — DESIGN §6)와 1:1 대응. */
export interface SendLogEntry {
  sheetId: string;
  tab: string;
  rowKey: string;
  templateHash: string;
  sendStatus: SendLogEntryStatus;
  /** claimed면 claim된 시각, sent면 확정(commit)된 시각. */
  sentAt: string; // ISO 8601
  messageId?: string;
  error?: string;
}

/** list()의 조회 옵션 — 기본/최대 개수를 두어 이력이 무한정 쌓여도 응답이 무제한으로 커지지 않게 한다
 * (docs/ADVERSARIAL_REVIEW_003.md AR-015). */
export interface SendLogListOptions {
  /** 반환할 최대 건수. 생략하면 DEFAULT_SEND_LOG_LIST_LIMIT, 최대 MAX_SEND_LOG_LIST_LIMIT까지 허용. */
  limit?: number;
  /** 이전 list() 호출 결과의 nextCursor를 그대로 넘기면 그 다음(더 오래된) 페이지를 반환한다
   * (docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md GAP-006). */
  cursor?: string;
}

/** list()의 결과 — entries.length가 limit에 도달했다고 무조건 "더 있다"고 추측(GAP-006에서 지적된
 * 부정확한 근사치)하는 대신, 실제로 limit+1개를 조회해 정확한 hasMore를 계산한다. */
export interface SendLogListResult {
  entries: SendLogEntry[];
  hasMore: boolean;
  /** hasMore===true일 때만 존재. 다음 페이지 조회 시 options.cursor로 그대로 넘긴다. */
  nextCursor?: string;
}

export const DEFAULT_SEND_LOG_LIST_LIMIT = 200;
export const MAX_SEND_LOG_LIST_LIMIT = 1000;

/** claim()의 결과. claimed===true일 때만 token이 존재하며, commit()/release()에 그대로 넘겨야
 * 한다 — claim이 만료되어 사람이 forceReleaseStaleClaim()으로 회수한 뒤 같은 키가 다시 claim되면
 * 새 token이 발급되므로, 원래 시도(좀비 프로세스 등)가 뒤늦게 깨어나 옛 token으로 commit/release를
 * 불러도 새 claim을 건드리지 못한다(GAP-001). */
export interface ClaimResult {
  claimed: boolean;
  token?: string;
}

/**
 * SendLog — docs/ADVERSARIAL_REVIEW_003.md AR-011/AR-013, 이후
 * docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md GAP-001/002/003/006 대응으로 claim/commit/release
 * 3단계 + 소유권 토큰 + 만료 기반 수동 복구로 재설계됐다.
 *
 * 예전 record()는 "먼저 전부 wasSent() 확인 → 나중에 전부 send"라는 배치 구조상, 같은 실행 안에
 * 같은 rowKey가 두 번 있거나 다른 프로세스가 동시에 실행되면 두 곳 다 wasSent=false를 보고 실제로
 * 중복 발송될 수 있었다(TOCTOU). claim()이 "확인"과 "예약"을 원자적 단일 연산으로 묶어 이 틈을
 * 없앤다.
 *
 * claim 직후(commit/release 전) 프로세스가 죽으면 그 claim은 "claimed" 상태로 영구히 남는다 —
 * 이게 자동으로 "sent"로도, 자동으로 재사용 가능으로도 되지 않는다(실제로 발송됐는지 알 수 없기
 * 때문). 이런 claim은 list()에서 sendStatus="claimed"로 그대로 보이므로 운영자가 발견할 수 있고,
 * 충분히 오래됐다고 판단되면 forceReleaseStaleClaim()으로 **명시적으로만** 회수한다 — 자동
 * 만료·자동 재사용은 절대 하지 않는다(발송됐을 가능성을 배제할 수 없어서다).
 *
 * 파이프라인의 올바른 사용 순서(행 하나마다, 다음 행으로 넘어가기 전에 반드시 완료):
 *   1. claim() — claimed=false면 이미 선점됨(같은 배치의 앞선 행 / 동시 실행 중인 다른 프로세스 /
 *      과거 성공 / 아직 해소 안 된 claim) → provider를 호출하지 말고 skipped_duplicate 처리.
 *   2. claimed=true면 provider.send() 호출.
 *   3a. 성공하면 commit(token, ...) — 예약을 최종 발송 기록으로 확정.
 *   3b. 실패(예외 포함)하면 release(token) — 예약을 해제해 다음 실행에서 재시도 가능하게 한다.
 * dry-run 미리보기는 상태를 바꾸면 안 되므로 claim() 대신 읽기 전용 wasSent()를 쓴다.
 */
export interface SendLog {
  /**
   * (sheetId, tab, rowKey, templateHash)에 대한 발송 권리를 원자적으로 예약한다.
   * claimed=true면 이 호출자가 유일하게 발송을 시도해도 된다는 뜻이며, 반환된 token을 반드시
   * commit() 또는 release()에 그대로 넘겨야 한다(안 하면 영구히 재시도가 막힌다 — 사람이
   * forceReleaseStaleClaim()으로 명시적으로 회수하지 않는 한).
   * claimed=false면 이미 다른 곳이 선점했다는 뜻 — 발송을 시도하지 말고 skipped_duplicate로
   * 처리해야 한다.
   */
  claim(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    claimedAt: string,
  ): ClaimResult;

  /**
   * claim()이 발급한 token과 일치할 때만 실제 발송이 성공했음을 확정 기록한다. token이 일치하지
   * 않으면(예: 그 사이 사람이 회수하고 다른 실행이 새로 claim함) 아무 것도 확정하지 않고 에러를
   * 던진다 — 좀비 프로세스가 남의 claim을 잘못 확정하는 사고를 막는다(GAP-001).
   */
  commit(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    token: string,
    sentAt: string,
    messageId: string | undefined,
  ): void;

  /**
   * claim()이 발급한 token과 일치할 때만 예약을 해제한다 — 다음 실행에서 재시도 가능해진다.
   * token이 일치하지 않으면(이미 회수됐거나 다른 claim으로 대체됨) 조용히 아무 것도 하지 않는다
   * (이미 목표 상태이거나, 더 이상 이 호출자의 claim이 아니므로 건드릴 권한이 없다 — GAP-001).
   */
  release(sheetId: string, tab: string, rowKey: string, templateHash: string, token: string): void;

  /**
   * claim된 지 olderThanMs 이상 지났고 아직 commit되지 않은 claim만 강제로 회수한다(token 불필요 —
   * 사람이 직접 검토한 뒤 수동으로만 호출하는 것을 전제한다. MCP 도구로는 노출하지 않는다 —
   * 자율 에이전트가 "발송됐을 수도 있는" 상태를 스스로 판단해 재사용 가능하게 만드는 것은 안전하지
   * 않다). 조건에 맞는 claim이 없으면 아무 것도 하지 않고 false를 반환한다.
   */
  forceReleaseStaleClaim(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    olderThanMs: number,
  ): boolean;

  /** 이미 확정 발송(commit)됐거나 아직 처리 중(claimed)인 예약이 있는지 읽기 전용으로 조회한다.
   * dry-run 미리보기 전용 — 상태를 바꾸지 않으므로 발송 흐름의 중복 방지에는 쓰면 안 된다
   * (claim()을 써야 한다). */
  wasSent(sheetId: string, tab: string, rowKey: string, templateHash: string): boolean;

  list(sheetId: string, options?: SendLogListOptions): SendLogListResult;
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
