import { describe, expect, it } from "vitest";
import { MockNotificationProvider } from "../src/mocks/mockNotificationProvider.js";
import type { OutboundMessage } from "../src/core/types.js";

function msg(rowKey: string, overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    rowKey,
    to: `${rowKey}@example.invalid`,
    subject: "안내",
    body: "본문",
    channel: "email",
    ...overrides,
  };
}

describe("MockNotificationProvider", () => {
  it("defaults to channel email", () => {
    const provider = new MockNotificationProvider();
    expect(provider.channel).toBe("email");
  });

  it("allows channel to be specified via options", () => {
    const provider = new MockNotificationProvider({ channel: "sms" });
    expect(provider.channel).toBe("sms");
  });

  it("records successful messages in the sent array", async () => {
    const provider = new MockNotificationProvider();
    const result = await provider.send(msg("CUST-001"));

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("mock-CUST-001");
    expect(provider.sent).toEqual([msg("CUST-001")]);
    expect(provider.failed).toEqual([]);
  });

  it("treats a rowKey registered in failFor as failed and excludes it from sent", async () => {
    const provider = new MockNotificationProvider({ failFor: ["CUST-003"] });
    const result = await provider.send(msg("CUST-003"));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/CUST-003/);
    expect(provider.sent).toEqual([]);
    expect(provider.failed).toEqual([msg("CUST-003")]);
  });

  it("sends rows not in failFor normally, and fails only the rows that are (partial failure)", async () => {
    const provider = new MockNotificationProvider({ failFor: ["CUST-003"] });

    const r1 = await provider.send(msg("CUST-001"));
    const r2 = await provider.send(msg("CUST-003"));
    const r3 = await provider.send(msg("CUST-005"));

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    expect(r3.ok).toBe(true);
    expect(provider.sent.map((m) => m.rowKey)).toEqual(["CUST-001", "CUST-005"]);
    expect(provider.sent.map((m) => m.rowKey)).not.toContain("CUST-003");
    expect(provider.failed.map((m) => m.rowKey)).toEqual(["CUST-003"]);
  });

  it("preserves call order in sent", async () => {
    const provider = new MockNotificationProvider();
    await provider.send(msg("A"));
    await provider.send(msg("B"));
    await provider.send(msg("C"));
    expect(provider.sent.map((m) => m.rowKey)).toEqual(["A", "B", "C"]);
  });
});
