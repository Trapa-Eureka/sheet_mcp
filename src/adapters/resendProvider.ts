// NotificationProvider의 이메일 참조 어댑터 — Resend REST API 1콜.
// 설계: docs/DESIGN.md §6(어댑터 메모), 태스크: docs/TASKS.md T5.
// 테스트는 fetch를 주입받아 목 fetch로 요청 형태/응답 처리를 검증한다(네트워크 호출 없음).

import { z } from "zod";
import type { NotificationProvider, OutboundMessage, SendResult } from "../core/types.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

const resendSuccessSchema = z.object({ id: z.string() });
// 에러 응답 형태는 Resend 버전에 따라 다를 수 있어 message만 느슨하게 시도하고, 없으면 HTTP status로 대체한다
const resendErrorLikeSchema = z.object({ message: z.string() }).partial();

export interface ResendEmailProviderOptions {
  /** 기본값: 환경변수 RESEND_API_KEY */
  apiKey?: string;
  /** 기본값: 환경변수 MAIL_FROM */
  from?: string;
  /** 테스트에서 목 fetch를 주입하기 위한 훅. 기본값: 전역 fetch */
  fetchImpl?: typeof fetch;
}

export class ResendEmailProvider implements NotificationProvider {
  readonly channel = "email" as const;
  private readonly apiKey: string;
  private readonly from: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ResendEmailProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error(
        "RESEND_API_KEY 환경변수가 없습니다. .env에 RESEND_API_KEY=<Resend API 키>를 설정하세요. .env.example 참고.",
      );
    }
    const from = options.from ?? process.env.MAIL_FROM;
    if (!from) {
      throw new Error(
        "MAIL_FROM 환경변수가 없습니다. .env에 MAIL_FROM=<발신자 이메일 주소>를 설정하세요. .env.example 참고.",
      );
    }
    this.apiKey = apiKey;
    this.from = from;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (msg.channel !== "email") {
      return {
        rowKey: msg.rowKey,
        ok: false,
        error: `ResendEmailProvider는 channel=email만 지원합니다 (받은 channel: '${msg.channel}').`,
      };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.from,
          to: [msg.to],
          subject: msg.subject ?? "",
          text: msg.body,
        }),
      });
    } catch (err) {
      return {
        rowKey: msg.rowKey,
        ok: false,
        error: `Resend 요청 자체가 실패했습니다: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const parsedError = resendErrorLikeSchema.safeParse(payload);
      const message =
        parsedError.success && parsedError.data.message
          ? parsedError.data.message
          : `Resend API 오류 (HTTP ${String(response.status)})`;
      return { rowKey: msg.rowKey, ok: false, error: message };
    }

    const parsedSuccess = resendSuccessSchema.safeParse(payload);
    if (!parsedSuccess.success) {
      return {
        rowKey: msg.rowKey,
        ok: false,
        error: "Resend 응답에 id가 없습니다 (예상과 다른 응답 형식).",
      };
    }

    return { rowKey: msg.rowKey, ok: true, messageId: parsedSuccess.data.id };
  }
}
