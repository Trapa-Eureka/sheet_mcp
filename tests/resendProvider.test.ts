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
  it("apiKey가 없으면 수정 방법이 담긴 에러를 던진다", () => {
    expect(() => new ResendEmailProvider({ from: "notify@example.invalid" })).toThrow(
      /RESEND_API_KEY 환경변수가 없습니다/,
    );
  });

  it("from이 없으면 수정 방법이 담긴 에러를 던진다", () => {
    expect(() => new ResendEmailProvider({ apiKey: "re_test_key" })).toThrow(
      /MAIL_FROM 환경변수가 없습니다/,
    );
  });

  it("성공 응답의 id를 messageId로 반환한다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "email_abc123" }));
    const provider = new ResendEmailProvider({
      apiKey: "re_test_key",
      from: "notify@example.invalid",
      fetchImpl,
    });

    const result = await provider.send(MSG);

    expect(result).toEqual({ rowKey: "CUST-001", ok: true, messageId: "email_abc123" });
  });

  it("Resend에 REST 1콜 — 요청 URL/메서드/헤더/바디 형태를 검증한다", async () => {
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

  it("실패 응답의 message를 error로 반환한다", async () => {
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

  it("실패 응답에 message가 없으면 HTTP status를 담은 에러를 반환한다", async () => {
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

  it("성공 응답인데 id가 없으면 명시적으로 실패 처리한다 (예상과 다른 응답 형식)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ unexpected: true }));
    const provider = new ResendEmailProvider({
      apiKey: "re_test_key",
      from: "notify@example.invalid",
      fetchImpl,
    });

    const result = await provider.send(MSG);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/id가 없습니다/);
  });

  it("fetch 자체가 실패(네트워크 에러)하면 예외를 던지지 않고 실패 SendResult를 반환한다", async () => {
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

  it("channel=sms 메시지가 오면 fetch를 호출하지 않고 실패 처리한다", async () => {
    const fetchImpl = vi.fn();
    const provider = new ResendEmailProvider({
      apiKey: "re_test_key",
      from: "notify@example.invalid",
      fetchImpl,
    });

    const result = await provider.send({ ...MSG, channel: "sms" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/channel=email만 지원/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
