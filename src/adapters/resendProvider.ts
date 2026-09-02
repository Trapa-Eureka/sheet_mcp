// NotificationProvider의 이메일 참조 어댑터 — Resend REST API 1콜.
// 설계: docs/DESIGN.md §6(어댑터 메모), 태스크: docs/TASKS.md T5.
// 테스트는 fetch를 주입받아 목 fetch로 요청 형태/응답 처리를 검증한다(네트워크 호출 없음).

import { z } from "zod";
import type { NotificationProvider, OutboundMessage, SendResult } from "../core/types.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** 기본 요청 timeout(ms) — docs/ADVERSARIAL_REVIEW_004.md AR-023: timeout 없이는 네트워크
 * half-open이나 Resend 쪽 지연에서 한 행의 fetch가 무기한 걸려 있을 수 있었고, 파이프라인은 행을
 * 순차 처리하므로 그 행의 claim이 commit/release 없이 그만큼 오래 고정돼 뒤 행 전체가 멈춘다. */
const DEFAULT_RESEND_TIMEOUT_MS = 30_000;

/**
 * fetchImpl 호출을 timeoutMs로 경계 짓는다. 실제 fetch에는 `AbortSignal.timeout()`도 함께
 * 넘겨(아래 send() 참고) 소켓 자체를 진짜로 취소하지만, 그것만으로는 "응답이 영영 안 오는" 상황을
 * 흉내낸 **목** fetch(signal을 무시하는 순수 `new Promise(() => {})`)에서는 테스트가 실제로 끝나지
 * 않는다 — 이 race가 있어야 목이 signal을 몰라도 우리 코드는 반드시 timeoutMs 안에 결과를 낸다
 * (src/adapters/googleSheetClient.ts의 withTimeout()과 같은 패턴).
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`Resend 요청이 ${String(timeoutMs)}ms 안에 응답하지 않았습니다.`);
      err.name = "TimeoutError";
      reject(err);
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

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
  /** 요청 timeout(ms). 기본값 DEFAULT_RESEND_TIMEOUT_MS(30초). 테스트에서 "응답이 영영 안 오는"
   * 상황을 짧은 시간 안에 검증하려고 주입 가능하게 열어 둔다(AR-023). */
  timeoutMs?: number;
}

export class ResendEmailProvider implements NotificationProvider {
  readonly channel = "email" as const;
  private readonly apiKey: string;
  private readonly from: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

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
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RESEND_TIMEOUT_MS;
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
      response = await withTimeout(
        this.fetchImpl(RESEND_ENDPOINT, {
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
          // AbortSignal.timeout()은 실제 fetch(Node 20+ 내장 undici)에서 소켓 자체를 취소한다 —
          // withTimeout()의 race는 이 signal을 모르는 목 fetch에서도 테스트가 끝나게 하기 위함이고,
          // 이건 실제 요청에서 자원을 진짜로 정리하기 위함이다(AR-023).
          signal: AbortSignal.timeout(this.timeoutMs),
        }),
        this.timeoutMs,
      );
    } catch (err) {
      // AbortSignal.timeout()에 의한 중단(name이 "TimeoutError")과 withTimeout()의 race 타임아웃을
      // 같은 문구로 안내한다 — 어느 쪽이든 "요청이 실제로 처리됐는지 알 수 없다"는 사실은 같다.
      // failed로 분류해 재시도를 허용하지만(claim은 release됨), 실제로 이미 발송됐을 가능성을
      // 배제할 수 없으므로 재발송 전 Resend 대시보드 확인을 권한다(delivery_unknown을 별도 상태로
      // 만드는 대신, 지금은 에러 메시지로 그 불확실성을 명시하는 쪽을 택했다 — DESIGN §6/§7 참고).
      const isTimeout = err instanceof Error && err.name === "TimeoutError";
      const message = isTimeout
        ? `Resend 요청이 ${String(this.timeoutMs)}ms 안에 응답하지 않아 타임아웃 처리했습니다. ` +
          "실제로는 이미 발송됐을 수도 있으니, 재시도하기 전에 Resend 대시보드에서 이 수신자로 " +
          "메일이 나갔는지 먼저 확인하세요."
        : `Resend 요청 자체가 실패했습니다: ${err instanceof Error ? err.message : String(err)}`;
      return { rowKey: msg.rowKey, ok: false, error: message };
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
