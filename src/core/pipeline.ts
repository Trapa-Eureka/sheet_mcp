// 발송 파이프라인 — docs/DESIGN.md §4의 흐름. core/는 인터페이스만 알고 실제 어댑터를 모른다
// (SheetClient/NotificationProvider/SendLog/Clock은 전부 생성자로 주입받는다). 태스크: docs/TASKS.md T7.
// claim/commit/release 기반 원자적 중복 방지, sent_log_failed 상태, AR-014 상태 셀 정책은
// docs/ADVERSARIAL_REVIEW_003.md AR-011/AR-013/AR-014/AR-017 대응.

import { createHash } from "node:crypto";
import { z } from "zod";
import { parseNotifyConfig, type NotifyConfig } from "./config.js";
import { renderTemplate } from "./template.js";
import type {
  Clock,
  NotificationProvider,
  SendLog,
  SendStatus,
  SheetClient,
  SheetRow,
  StatusUpdate,
} from "./types.js";

export interface SendPipelineDeps {
  sheetClient: SheetClient;
  provider: NotificationProvider;
  sendLog: SendLog;
  clock: Clock;
}

export interface RunOptions {
  dryRun: boolean;
}

export interface PipelineRowDetail {
  rowIndex: number;
  rowKey: string;
  status: SendStatus;
  to?: string;
  subject?: string;
  body?: string;
  messageId?: string;
  error?: string;
}

export interface PipelineResult {
  sent: number;
  failed: number;
  skipped: number;
  /** status==="sent_log_failed"인 행 수. sent/failed/skipped 어디에도 넣지 않는다 — "성공"도
   * "실패"도 아닌 불확실한 상태를 다른 집계에 섞으면 그 집계의 의미가 흐려지기 때문이다. 대신
   * sent+failed+skipped+logFailed는 항상 details.length와 같다(집계 불변식,
   * docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md GAP-002). */
  logFailed: number;
  details: PipelineRowDetail[];
}

/**
 * subject+body **원본** 템플릿(렌더 전)의 sha256 앞 12자 — DESIGN §4-4단계.
 * 행 값이 아니라 템플릿 문자열 자체를 해시하므로, 같은 템플릿이면 모든 행이 같은 해시를 공유하고
 * 템플릿을 고치면(오타 수정 등) 해시가 바뀌어 재발송이 허용된다(의도된 동작).
 *
 * subject와 body를 **각각 먼저 해시한 뒤 그 두 다이제스트를 합쳐 다시 해시**한다 — 구분자를 문자로
 * 끼워 넣는 방식(예: 공백)은 "A "+"B"와 "A"+" B"처럼 경계에 그 구분자와 같은 문자가 있으면 서로
 * 다른 (subject, body) 조합이 같은 바이트 시퀀스로 합쳐져 해시가 충돌한다
 * (docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md REG-001 — 실제로 공백 구분자에서 재현됨).
 * sha256 다이제스트는 항상 고정 64자(hex)이므로, 두 다이제스트를 이어붙이는 경계는 내용에 따라
 * 흔들리지 않아 이 문제가 원천적으로 발생하지 않는다.
 */
export function computeTemplateHash(subjectTemplate: string, bodyTemplate: string): string {
  const subjectDigest = createHash("sha256").update(subjectTemplate).digest("hex");
  const bodyDigest = createHash("sha256").update(bodyTemplate).digest("hex");
  return createHash("sha256").update(subjectDigest).update(bodyDigest).digest("hex").slice(0, 12);
}

/**
 * DESIGN §5 "이중 안전장치"의 판정 로직: 도구 파라미터(confirm)와 프로세스 환경변수(SEND_MODE)가
 * **둘 다** 만족해야만 실발송이다. 순수 함수라 MCP 서버 없이도 이 파일의 테스트에서 검증할 수 있다.
 * 하나라도 아니면 무조건 dryRun=true — 안전한 쪽으로 fail한다.
 */
export function resolveDryRun(sendMode: string | undefined, confirm: boolean): boolean {
  return !(sendMode === "live" && confirm);
}

/**
 * DESIGN §5 send_notifications 도구가 붙일 안내 문구. resolveDryRun()이 dryRun=true를 반환했을 때
 * (즉 실발송하지 않았을 때) 왜 안 됐는지·어떻게 실발송하는지를 알려준다. 실발송이면 안내가
 * 필요 없으므로 undefined.
 */
export function buildDryRunNotice(dryRun: boolean): string | undefined {
  if (!dryRun) return undefined;
  return (
    "실제 발송하지 않았습니다 (미리보기 결과입니다). 실제로 발송하려면 send_notifications 호출 시 " +
    "confirm=true를 넘기고, 서버 프로세스 환경변수에 SEND_MODE=live를 설정하세요 (DESIGN §5 이중 안전장치, 둘 다 필요)."
  );
}

/** filter_column/filter_value를 적용해 발송 대상 행만 남긴다. read_rows 도구(core/readRows.ts)도
 * 같은 필터링 규칙을 써야 하므로 export한다. */
export function applyFilter(
  rows: SheetRow[],
  filterColumn: string | undefined,
  filterValue: string | undefined,
): SheetRow[] {
  // config.ts가 filter_column/filter_value를 "함께 있거나 둘 다 없거나"로 이미 검증했으므로
  // 여기서는 하나만 있는 경우를 걱정할 필요가 없다.
  if (filterColumn === undefined || filterValue === undefined) {
    return rows;
  }
  // DESIGN §2/TESTING §4: 대소문자 그대로 비교(정규화 없음).
  return rows.filter((row) => row.values[filterColumn] === filterValue);
}

// 과도한 RFC 5322 전체 구현 대신, 흔한 명백한 불량 주소(`a@`, `@example.com`, `a@@example.com`,
// 공백 포함 등)만 발송 전 경계에서 걸러내는 실용적 형식 검사 — docs/ADVERSARIAL_REVIEW_003.md AR-017.
const emailFormatSchema = z.string().email();

/** 파이프라인 내부 작업 상태. "pending"은 발송 시도 전(멱등성 검사까지 통과) 상태를 뜻하며,
 * dryRun 경로가 아닌 이상 run() 종료 시점까지 반드시 pending이 아닌 상태로 해소되어야 한다. */
interface WorkingRow {
  rowIndex: number;
  rowKey: string;
  status: SendStatus | "pending";
  to?: string;
  subject?: string;
  body?: string;
  messageId?: string;
  error?: string;
}

export class SendPipeline {
  constructor(private readonly deps: SendPipelineDeps) {}

  async run(sheetId: string, opts: RunOptions): Promise<PipelineResult> {
    // 1. config 읽기 + zod 검증 — 실패하면 ConfigParseError가 그대로 전파된다.
    //    (에러 메시지 자체가 "무엇이 왜 + 어떻게 고치나"를 담고 있으므로 여기서 감쌀 필요 없음)
    const rawConfig = await this.deps.sheetClient.readConfig(sheetId);
    const config = parseNotifyConfig(rawConfig);

    // 2. 행 읽기 + filter_column/filter_value 적용
    const allRows = await this.deps.sheetClient.readRows(sheetId, config.dataTab);
    const rows = applyFilter(allRows, config.filterColumn, config.filterValue);

    const templateHash = computeTemplateHash(config.subjectTemplate, config.bodyTemplate);

    // 3. 행별 렌더링 — 수신자 결측/이메일 형식 불량/템플릿 변수 결측은 여기서 failed로 확정한다
    const workingRows = rows.map((row) => this.planRow(row, config));

    if (opts.dryRun) {
      // dry-run 전용 멱등성 검사: 상태를 바꾸지 않는 읽기 전용 wasSent()만 쓴다(claim()은 절대 쓰지
      // 않는다 — 미리보기가 실제 발송 예약을 만들면 그 예약이 commit/release 없이 영원히 남아
      // 이후 실제 발송을 막아버린다).
      for (const row of workingRows) {
        if (row.status !== "pending") continue;
        if (this.deps.sendLog.wasSent(sheetId, config.dataTab, row.rowKey, templateHash)) {
          row.status = "skipped_duplicate";
        }
      }
      // dryRun이면 여기서 결과(발송될 목록 미리보기)만 반환 — provider/sendLog/시트 쓰기 전부 없음
      return this.summarize(workingRows, true);
    }

    // 4~6 (live): 행마다 "예약(claim) → 발송 → 확정(commit)/해제(release)"를 하나씩 끝까지 완결한
    // 뒤에야 다음 행으로 넘어간다 — 이렇게 해야 같은 배치에 같은 rowKey가 두 번 있어도 두 번째
    // 행의 claim()이 즉시 실패해 중복 발송이 안 된다(AR-011). 개별 try/catch로 한 행의 실패가
    // 배치를 중단하지 않는다.
    const nowIso = this.deps.clock.now().toISOString();
    for (const row of workingRows) {
      if (row.status !== "pending") continue;
      await this.attemptSend(sheetId, config.dataTab, templateHash, nowIso, row);
    }

    // 7. write-back: 상태 컬럼 보장 후 일괄 반영
    await this.deps.sheetClient.ensureStatusColumns(sheetId, config.dataTab);
    const updates = workingRows.map((row) => toStatusUpdate(row, nowIso));
    await this.deps.sheetClient.writeStatus(sheetId, config.dataTab, updates);

    // 8. 집계 반환
    return this.summarize(workingRows, false);
  }

  private planRow(row: SheetRow, config: NotifyConfig): WorkingRow {
    const rowIndex = row.rowIndex;
    const rawRowKey = row.values[config.idColumn];
    const rowKey =
      rawRowKey !== undefined && rawRowKey.trim() !== ""
        ? rawRowKey
        : `__row_${String(rowIndex)}__`;

    if (rawRowKey === undefined || rawRowKey.trim() === "") {
      return {
        rowIndex,
        rowKey,
        status: "failed",
        error:
          `id_column '${config.idColumn}' 값이 비어 있는 행입니다 (rowIndex ${String(rowIndex)}). ` +
          `시트 '${config.dataTab}' 탭에서 해당 행의 ${config.idColumn} 값을 채우세요.`,
      };
    }

    const recipient = row.values[config.recipientColumn];
    if (recipient === undefined || recipient.trim() === "") {
      return {
        rowIndex,
        rowKey,
        status: "failed",
        error:
          `수신자 컬럼(recipient_column='${config.recipientColumn}') 값이 비어 있습니다 (rowIndex ${String(rowIndex)}). ` +
          `시트 '${config.dataTab}' 탭에서 해당 행의 ${config.recipientColumn} 값을 채우세요.`,
      };
    }

    if (!emailFormatSchema.safeParse(recipient).success) {
      return {
        rowIndex,
        rowKey,
        status: "failed",
        to: recipient,
        error:
          `수신자 이메일 형식이 올바르지 않습니다: '${recipient}' (rowIndex ${String(rowIndex)}). ` +
          `유효한 이메일 주소로 ${config.recipientColumn} 값을 수정하세요.`,
      };
    }

    const subjectResult = renderTemplate(config.subjectTemplate, row.values);
    const bodyResult = renderTemplate(config.bodyTemplate, row.values);
    const missing = [...new Set([...subjectResult.missing, ...bodyResult.missing])];
    if (missing.length > 0) {
      return {
        rowIndex,
        rowKey,
        status: "failed",
        to: recipient,
        error:
          `템플릿 변수 결측: ${missing.join(", ")} (rowIndex ${String(rowIndex)}). ` +
          `시트 '${config.dataTab}' 탭에 해당 이름의 컬럼을 추가하거나, notify_config의 템플릿에서 제거하세요.`,
      };
    }

    return {
      rowIndex,
      rowKey,
      status: "pending",
      to: recipient,
      subject: subjectResult.text,
      body: bodyResult.text,
    };
  }

  private async attemptSend(
    sheetId: string,
    tab: string,
    templateHash: string,
    nowIso: string,
    row: WorkingRow,
  ): Promise<void> {
    if (row.to === undefined || row.body === undefined) {
      // planRow가 "pending"으로 반환하는 유일한 경로에서 항상 to/body를 채우므로 실제로는 도달 불가.
      // 방어적 가드 — 여기 도달하면 planRow/attemptSend 사이의 불변식이 깨진 버그다.
      throw new Error(
        `내부 오류: rowKey '${row.rowKey}'가 pending 상태인데 to 또는 body가 없습니다. 버그를 리포트하세요.`,
      );
    }

    // 원자적 claim — 같은 배치의 중복 rowKey, 동시에 실행 중인 다른 프로세스, 과거 성공 전부
    // 이 한 번의 호출로 막는다(AR-011). claim에 실패하면 provider를 아예 호출하지 않는다.
    const claim = this.deps.sendLog.claim(sheetId, tab, row.rowKey, templateHash, nowIso);
    if (!claim.claimed) {
      row.status = "skipped_duplicate";
      return;
    }
    if (claim.token === undefined) {
      // SendLog 구현이 claimed=true인데 token을 안 준 경우 — 인터페이스 계약 위반. 여기서 잡아야
      // "token이 undefined인 채로 commit/release에 넘어가는" 더 헷갈리는 실패를 막을 수 있다.
      throw new Error(
        `내부 오류: SendLog.claim()이 claimed=true인데 token이 없습니다 (rowKey='${row.rowKey}'). ` +
          "SendLog 구현의 버그입니다.",
      );
    }
    const token = claim.token;

    try {
      const result = await this.deps.provider.send({
        rowKey: row.rowKey,
        to: row.to,
        subject: row.subject,
        body: row.body,
        channel: this.deps.provider.channel,
      });

      if (result.ok) {
        try {
          this.deps.sendLog.commit(
            sheetId,
            tab,
            row.rowKey,
            templateHash,
            token,
            nowIso,
            result.messageId,
          );
          row.status = "sent";
          row.messageId = result.messageId;
        } catch (commitErr) {
          // 발송 자체는 이미 성공했다 — claim을 release하면 다음 실행에서 똑같이 재발송되는 진짜
          // 중복 사고가 나므로 절대 release하지 않는다(AR-013). 이번 실행 결과만 별도 상태로
          // 표시해 사람이 SendLog/시트를 수동으로 확인하게 한다.
          row.status = "sent_log_failed";
          row.messageId = result.messageId;
          row.error =
            `발송은 성공했지만(messageId=${result.messageId ?? "없음"}) 로컬 발송 기록 저장에 실패했습니다: ` +
            `${commitErr instanceof Error ? commitErr.message : String(commitErr)}. SendLog와 이 시트 행을 ` +
            "수동으로 확인한 뒤, 실제로 이미 발송됐는지 확인하지 않고서는 재발송하지 마세요.";
          console.error(
            `[sheet-mcp] sent_log_failed: sheetId=${sheetId} tab=${tab} rowKey=${row.rowKey} ` +
              `messageId=${result.messageId ?? "없음"} — ${row.error}`,
          );
        }
      } else {
        row.status = "failed";
        row.error =
          result.error ?? `${this.deps.provider.channel} 발송이 실패했습니다 (사유 미상).`;
        this.safeRelease(sheetId, tab, templateHash, token, row);
      }
    } catch (err) {
      row.status = "failed";
      row.error = `발송 중 예외가 발생했습니다: ${err instanceof Error ? err.message : String(err)}`;
      this.safeRelease(sheetId, tab, templateHash, token, row);
    }
  }

  /**
   * release()가 그 자체로 실패해도(DB 잠금·IO 오류 등) 절대 밖으로 던지지 않는다 — 예전에는 이
   * release() 실패가 attemptSend() 밖으로 그대로 전파돼 run()의 for 루프를 중단시켜 "한 행 실패가
   * 나머지 배치를 막지 않는다"는 핵심 계약을 깼다(docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md
   * GAP-003). release가 실패하면 이 행의 claim이 안 풀려 다음 실행에서 재시도가 막힐 수 있다는
   * 사실을 error 메시지와 stderr에 남겨 사람이 forceReleaseStaleClaim()으로 복구할 수 있게 한다.
   */
  private safeRelease(
    sheetId: string,
    tab: string,
    templateHash: string,
    token: string,
    row: WorkingRow,
  ): void {
    try {
      this.deps.sendLog.release(sheetId, tab, row.rowKey, templateHash, token);
    } catch (releaseErr) {
      const releaseErrMessage =
        releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
      row.error = `${row.error ?? ""} (추가로 예약 해제도 실패해 재시도가 자동으로 막혀 있을 수 있습니다: ${releaseErrMessage}. 수동 확인이 필요합니다.)`;
      console.error(
        `[sheet-mcp] release 실패: sheetId=${sheetId} tab=${tab} rowKey=${row.rowKey} — ${releaseErrMessage}`,
      );
    }
  }

  private summarize(rows: WorkingRow[], dryRun: boolean): PipelineResult {
    const details: PipelineRowDetail[] = rows.map((row) => ({
      rowIndex: row.rowIndex,
      rowKey: row.rowKey,
      status: finalizeStatus(row, dryRun),
      to: row.to,
      subject: row.subject,
      body: row.body,
      messageId: row.messageId,
      error: row.error,
    }));

    return {
      sent: details.filter((d) => d.status === "sent").length,
      failed: details.filter((d) => d.status === "failed").length,
      skipped: details.filter((d) => d.status === "skipped_duplicate").length,
      logFailed: details.filter((d) => d.status === "sent_log_failed").length,
      details,
    };
  }
}

/**
 * "pending"(검증 통과 + 미중복이라 발송 시도 대상)을 최종 SendStatus로 확정한다.
 * dryRun에서는 provider를 호출하지 않으므로 실제 성공 여부를 알 수 없다 — DESIGN §4-5단계가
 * "결과(발송될 목록)만 반환"이라 명시하므로, pending 행은 "발송될 것"이라는 예측을 status="sent"로
 * 나타낸다(미리보기 용도. 실제 발송 결과와 다를 수 있음).
 */
function finalizeStatus(row: WorkingRow, dryRun: boolean): SendStatus {
  if (row.status !== "pending") {
    return row.status;
  }
  if (!dryRun) {
    // run()의 live 경로가 pending 행을 전부 attemptSend()로 해소하므로 여기 도달하면 버그다.
    throw new Error(
      `내부 오류: rowKey '${row.rowKey}'가 dryRun이 아닌데도 발송 시도 전 상태(pending)로 남아있습니다.`,
    );
  }
  return "sent";
}

/**
 * StatusUpdate 변환. sentAt/messageId/error 결측 정책(docs/ADVERSARIAL_REVIEW_003.md AR-014):
 * - sent: 과거 실패의 잔재(_error)가 새 성공 옆에 잘못 남지 않도록 null로 지운다.
 *   messageId도 이번 발송 기준으로 다시 쓴다(없으면 null로 지워 옛 값이 새 sentAt과 짝지어
 *   잘못 보이지 않게 한다).
 * - sent_log_failed: 발송은 됐지만 로컬 기록에 실패했다는 사실을 사람이 시트에서 바로 보도록
 *   sentAt/messageId/error를 전부 채운다.
 * - failed: 과거 _sent_at/_message_id는 **의도적으로 보존**한다 — 이 행이 예전에 실제로 발송된 적
 *   있다는 감사 기록은 새 템플릿의 실패 시도로 지워지면 안 된다는 판단이다(문서화된 정책).
 * - skipped_duplicate: 아무 것도 건드리지 않는다(과거 sent 감사 기록 보존, 기존 정책 유지).
 */
function toStatusUpdate(row: WorkingRow, nowIso: string): StatusUpdate {
  if (row.status === "pending") {
    // run()의 live 경로 이후에만 호출되므로 실제로는 도달 불가 — 방어적 가드.
    throw new Error(
      `내부 오류: rowKey '${row.rowKey}'가 write-back 시점에도 pending 상태입니다. 버그를 리포트하세요.`,
    );
  }
  if (row.status === "sent") {
    return {
      rowIndex: row.rowIndex,
      sendStatus: "sent",
      sentAt: nowIso,
      messageId: row.messageId ?? null,
      error: null,
    };
  }
  if (row.status === "sent_log_failed") {
    return {
      rowIndex: row.rowIndex,
      sendStatus: "sent_log_failed",
      sentAt: nowIso,
      messageId: row.messageId ?? null,
      error: row.error ?? null,
    };
  }
  if (row.status === "failed") {
    return { rowIndex: row.rowIndex, sendStatus: "failed", error: row.error ?? null };
  }
  return { rowIndex: row.rowIndex, sendStatus: "skipped_duplicate" };
}
