// NotificationProvider 목 구현 — 보낸 메시지를 배열에 기록하고, failFor로 특정 행 실패를 주입한다.
// 설계: docs/DESIGN.md §3(NotificationProvider), 테스트 전략: docs/TESTING.md §2, §5.

import type { Channel, NotificationProvider, OutboundMessage, SendResult } from "../core/types.js";

export interface MockNotificationProviderOptions {
  channel?: Channel;
  /** 이 rowKey들은 send() 호출 시 강제로 실패 처리한다 (docs/TESTING.md §5 실패 주입 패턴) */
  failFor?: string[];
}

export class MockNotificationProvider implements NotificationProvider {
  readonly channel: Channel;
  /** 성공으로 처리된 메시지만 기록 (호출 순서 보존) */
  readonly sent: OutboundMessage[] = [];
  /** failFor에 의해 강제로 실패 처리된 메시지 (호출 순서 보존) */
  readonly failed: OutboundMessage[] = [];
  private readonly failFor: Set<string>;

  constructor(options: MockNotificationProviderOptions = {}) {
    this.channel = options.channel ?? "email";
    this.failFor = new Set(options.failFor ?? []);
  }

  // 실제로는 동기 동작이지만 인터페이스 계약(Promise<SendResult>)을 지킨다. 이 함수는 throw하지
  // 않으므로(항상 정상적으로 SendResult를 만들어 반환) try/catch 없이 Promise.resolve로 충분하다.
  send(msg: OutboundMessage): Promise<SendResult> {
    if (this.failFor.has(msg.rowKey)) {
      this.failed.push(msg);
      return Promise.resolve({
        rowKey: msg.rowKey,
        ok: false,
        error: `MockNotificationProvider: failFor에 등록된 rowKey('${msg.rowKey}')라 강제로 실패 처리했습니다.`,
      });
    }
    this.sent.push(msg);
    return Promise.resolve({ rowKey: msg.rowKey, ok: true, messageId: `mock-${msg.rowKey}` });
  }
}
