// Mock implementation of NotificationProvider — records sent messages in an array, and lets
// failFor inject forced failures for specific rows.
// Design: docs/DESIGN.md §3 (NotificationProvider), test strategy: docs/TESTING.md §2, §5.

import type { Channel, NotificationProvider, OutboundMessage, SendResult } from "../core/types.js";

export interface MockNotificationProviderOptions {
  channel?: Channel;
  /** These rowKeys are forced to fail on send() (docs/TESTING.md §5 failure-injection pattern) */
  failFor?: string[];
}

export class MockNotificationProvider implements NotificationProvider {
  readonly channel: Channel;
  /** Only records messages that were treated as successful (call order preserved) */
  readonly sent: OutboundMessage[] = [];
  /** Messages forced to fail via failFor (call order preserved) */
  readonly failed: OutboundMessage[] = [];
  private readonly failFor: Set<string>;

  constructor(options: MockNotificationProviderOptions = {}) {
    this.channel = options.channel ?? "email";
    this.failFor = new Set(options.failFor ?? []);
  }

  // This is actually synchronous, but it honors the interface contract (Promise<SendResult>).
  // Since this function never throws (it always builds and returns a normal SendResult),
  // Promise.resolve is sufficient without a try/catch.
  send(msg: OutboundMessage): Promise<SendResult> {
    if (this.failFor.has(msg.rowKey)) {
      this.failed.push(msg);
      return Promise.resolve({
        rowKey: msg.rowKey,
        ok: false,
        error: `MockNotificationProvider: forced failure for rowKey('${msg.rowKey}') registered in failFor.`,
      });
    }
    this.sent.push(msg);
    return Promise.resolve({ rowKey: msg.rowKey, ok: true, messageId: `mock-${msg.rowKey}` });
  }
}
