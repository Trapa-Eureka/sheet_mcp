// 도메인 타입 — docs/DESIGN.md §3과 1:1 대응. core/는 이 인터페이스만 알고 외부 IO를 모른다.

export interface SheetRow {
  rowIndex: number;
  values: Record<string, string>;
}

export type SendStatus = "sent" | "failed" | "skipped_duplicate";

/** writeStatus가 시트 상태 컬럼 4개(_send_status/_sent_at/_message_id/_error, DESIGN §2)에 반영할 행 단위 갱신 */
export interface StatusUpdate {
  rowIndex: number;
  sendStatus: SendStatus;
  sentAt?: string; // ISO 8601
  messageId?: string;
  error?: string;
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

/** SqliteSendLog의 unique 키(sheet_id, tab, row_key, template_hash — DESIGN §6)와 1:1 대응 */
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

export interface SendLog {
  wasSent(sheetId: string, tab: string, rowKey: string, templateHash: string): boolean;
  record(entry: SendLogEntry): void;
  list(sheetId: string): SendLogEntry[];
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
