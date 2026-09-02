// Reference email adapter for NotificationProvider — a single Resend REST API call.
// Design: docs/DESIGN.md §6 (adapter notes), task: docs/TASKS.md T5.
// Tests inject fetch and verify request shape/response handling with a mock fetch (no network calls).

import { z } from "zod";
import type { NotificationProvider, OutboundMessage, SendResult } from "../core/types.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Default request timeout (ms) — docs/ADVERSARIAL_REVIEW_004.md AR-023: without a timeout, a
 * network half-open or a delay on Resend's side could leave one row's fetch hanging indefinitely,
 * and since the pipeline processes rows sequentially, that row's claim would stay locked that
 * whole time without a commit/release, stalling every row behind it. */
const DEFAULT_RESEND_TIMEOUT_MS = 30_000;

/**
 * Bounds a call to fetchImpl by timeoutMs. The real fetch is also passed `AbortSignal.timeout()`
 * (see send() below), which genuinely cancels the socket itself, but that alone won't make a
 * test actually finish against a **mock** fetch simulating a "response that never comes" (a bare
 * `new Promise(() => {})` that ignores the signal) — this race is what guarantees our code
 * produces a result within timeoutMs even when the mock knows nothing about the signal (same
 * pattern as withTimeout() in src/adapters/googleSheetClient.ts).
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`Resend request did not respond within ${String(timeoutMs)}ms.`);
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
// The error response shape can vary by Resend version, so we loosely try just `message` and fall back to the HTTP status when it's absent
const resendErrorLikeSchema = z.object({ message: z.string() }).partial();

export interface ResendEmailProviderOptions {
  /** Default: environment variable RESEND_API_KEY */
  apiKey?: string;
  /** Default: environment variable MAIL_FROM */
  from?: string;
  /** Hook for injecting a mock fetch in tests. Default: global fetch */
  fetchImpl?: typeof fetch;
  /** Request timeout (ms). Defaults to DEFAULT_RESEND_TIMEOUT_MS (30s). Left injectable so tests
   * can verify the "response that never comes" scenario within a short time (AR-023). */
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
        "RESEND_API_KEY environment variable is missing. Set RESEND_API_KEY=<Resend API key> in .env. See .env.example.",
      );
    }
    const from = options.from ?? process.env.MAIL_FROM;
    if (!from) {
      throw new Error(
        "MAIL_FROM environment variable is missing. Set MAIL_FROM=<sender email address> in .env. See .env.example.",
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
        error: `ResendEmailProvider only supports channel=email (received channel: '${msg.channel}').`,
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
          // AbortSignal.timeout() cancels the socket itself on the real fetch (Node 20+'s built-in
          // undici) — withTimeout()'s race exists to let tests finish even against a mock fetch
          // that knows nothing about this signal, while this one is for genuinely cleaning up
          // resources on real requests (AR-023).
          signal: AbortSignal.timeout(this.timeoutMs),
        }),
        this.timeoutMs,
      );
    } catch (err) {
      // We report an abort from AbortSignal.timeout() (name "TimeoutError") and a withTimeout()
      // race timeout with the same message — either way, the fact that "we don't actually know
      // whether the request went through" is the same. We classify it as failed to allow a retry
      // (the claim gets released), but since we can't rule out that it was already sent, we
      // recommend checking the Resend dashboard before resending (rather than introducing a
      // separate delivery_unknown status, we chose for now to make that uncertainty explicit in
      // the error message — see DESIGN §6/§7).
      const isTimeout = err instanceof Error && err.name === "TimeoutError";
      const message = isTimeout
        ? `Resend request did not respond within ${String(this.timeoutMs)}ms and was treated as a timeout. ` +
          "It may have already been delivered, so before retrying, check the Resend dashboard to " +
          "see whether the email went out to this recipient."
        : `Resend request itself failed: ${err instanceof Error ? err.message : String(err)}`;
      return { rowKey: msg.rowKey, ok: false, error: message };
    }

    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const parsedError = resendErrorLikeSchema.safeParse(payload);
      const message =
        parsedError.success && parsedError.data.message
          ? parsedError.data.message
          : `Resend API error (HTTP ${String(response.status)})`;
      return { rowKey: msg.rowKey, ok: false, error: message };
    }

    const parsedSuccess = resendSuccessSchema.safeParse(payload);
    if (!parsedSuccess.success) {
      return {
        rowKey: msg.rowKey,
        ok: false,
        error: "Resend response has no id (unexpected response format).",
      };
    }

    return { rowKey: msg.rowKey, ok: true, messageId: parsedSuccess.data.id };
  }
}
