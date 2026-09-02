import { describe, expect, it, vi } from "vitest";
import { ResendEmailProvider } from "../src/adapters/resendProvider.js";
import type { OutboundMessage } from "../src/core/types.js";

const MSG: OutboundMessage = {
  rowKey: "CUST-001",
  to: "juan@example.invalid",
  subject: "[ABC Trading] 결제 안내",
  body: "Juan님, ₱1,200.00 결제 기한은 2026-09-15입니다.",
  channel: "email",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ResendEmailProvider", () => {
  it("throws an error explaining how to fix it when apiKey is missing", () => {
    expect(() => new ResendEmailProvider({ from: "notify@example.invalid" })).toThrow(
      /RESEND_API_KEY environment variable is missing/,
    );
  });

  it("throws an error explaining how to fix it when from is missing", () => {
    expect(() => new ResendEmailProvider({ apiKey: "re_test_key" })).toThrow(
      /MAIL_FROM environment variable is missing/,
    );
  });

  it("returns the id from a success response as messageId", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "email_abc123" }));
    const provider = new ResendEmailProvider({
      apiKey: "re_test_key",
      from: "notify@example.invalid",
      fetchImpl,
    });

    const result = await provider.send(MSG);

    expect(result).toEqual({ rowKey: "CUST-001", ok: true, messageId: "email_abc123" });
  });

  it("makes a single REST call to Resend — verifies the request URL/method/headers/body shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "email_abc123" }));
    const provider = new ResendEmailProvider({
      apiKey: "re_test_key",
      from: "notify@example.invalid",
      fetchImpl,
    });

    await provider.send(MSG);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer re_test_key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      from: "notify@example.invalid",
      to: ["juan@example.invalid"],
      subject: "[ABC Trading] 결제 안내",
      text: "Juan님, ₱1,200.00 결제 기한은 2026-09-15입니다.",
    });
  });

  it("returns the message from a failure response as error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: "Invalid `to` field" }, 400));
    const provider = new ResendEmailProvider({
      apiKey: "re_test_key",
      from: "notify@example.invalid",
      fetchImpl,
    });

    const result = await provider.send(MSG);

    expect(result).toEqual({
      rowKey: "CUST-001",
      ok: false,
      error: "Invalid `to` field",
    });
  });

  it("returns an error containing the HTTP status when a failure response has no message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    const provider = new ResendEmailProvider({
      apiKey: "re_test_key",
      from: "notify@example.invalid",
      fetchImpl,
    });

    const result = await provider.send(MSG);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/HTTP 500/);
  });

  it("explicitly treats it as a failure when a success response has no id (unexpected response format)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ unexpected: true }));
    const provider = new ResendEmailProvider({
      apiKey: "re_test_key",
      from: "notify@example.invalid",
      fetchImpl,
    });

    const result = await provider.send(MSG);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no id/);
  });

  it("returns a failed SendResult without throwing when fetch itself fails (network error)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const provider = new ResendEmailProvider({
      apiKey: "re_test_key",
      from: "notify@example.invalid",
      fetchImpl,
    });

    const result = await provider.send(MSG);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/network down/);
  });

  it("treats a channel=sms message as a failure without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const provider = new ResendEmailProvider({
      apiKey: "re_test_key",
      from: "notify@example.invalid",
      fetchImpl,
    });

    const result = await provider.send({ ...MSG, channel: "sms" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/only supports channel=email/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it(
    "docs/ADVERSARIAL_REVIEW_004.md AR-023: a fetch whose response never comes still ends as a " +
      "failed SendResult within timeoutMs (without throwing) — advises checking the dashboard before retrying",
    async () => {
      // A pure hang that ignores the signal — the very fact that AbortSignal.timeout() alone
      // can't stop this mock is why the withTimeout() race is needed.
      const fetchImpl = vi.fn().mockImplementation(() => new Promise<Response>(() => {}));
      const provider = new ResendEmailProvider({
        apiKey: "re_test_key",
        from: "notify@example.invalid",
        fetchImpl,
        timeoutMs: 20,
      });

      const result = await provider.send(MSG);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/treated as a timeout/);
      expect(result.error).toMatch(/Resend dashboard/);
    },
  );
});
