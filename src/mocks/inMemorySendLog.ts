// SendLog 인메모리 구현 — 결정론적 테스트용 (SQLite 어댑터는 tests/sqliteSendLog.test.ts로 별도 검증).
// 설계: docs/DESIGN.md §3(SendLog), §6(unique 키). claim/commit/release + 소유권 토큰 + 만료 기반
// 수동 복구 + cursor 페이지네이션 배경은 docs/ADVERSARIAL_REVIEW_003.md AR-011/AR-013,
// docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md GAP-001/002/003/006.

import { randomUUID } from "node:crypto";
import type {
  ClaimResult,
  SendLog,
  SendLogEntry,
  SendLogListOptions,
  SendLogListResult,
} from "../core/types.js";
import {
  assertValidStaleClaimThreshold,
  DEFAULT_SEND_LOG_LIST_LIMIT,
  MAX_SEND_LOG_LIST_LIMIT,
} from "../core/types.js";

const KEY_SEPARATOR = " ";

function uniqueKey(sheetId: string, tab: string, rowKey: string, templateHash: string): string {
  return [sheetId, tab, rowKey, templateHash].join(KEY_SEPARATOR);
}

interface InternalRecord {
  id: number;
  token: string;
  committed: boolean;
  sheetId: string;
  tab: string;
  rowKey: string;
  templateHash: string;
  sentAt: string; // claimed 동안은 claimedAt, commit 후에는 실제 sentAt
  messageId?: string;
}

function toEntry(record: InternalRecord): SendLogEntry {
  return {
    sheetId: record.sheetId,
    tab: record.tab,
    rowKey: record.rowKey,
    templateHash: record.templateHash,
    sendStatus: record.committed ? "sent" : "claimed",
    sentAt: record.sentAt,
    messageId: record.messageId,
  };
}

export class InMemorySendLog implements SendLog {
  private readonly records = new Map<string, InternalRecord>();
  private nextId = 1;

  // JS는 단일 스레드라 claim()의 has+set 사이에 다른 코드가 끼어들 수 없다 — 이 동기성 자체가
  // 같은 프로세스 안에서의 원자성을 보장한다(AR-011). 진짜 다중 프로세스 원자성은 SqliteSendLog가
  // SQLite의 UNIQUE 제약으로 보장한다.
  claim(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    claimedAt: string,
  ): ClaimResult {
    const key = uniqueKey(sheetId, tab, rowKey, templateHash);
    if (this.records.has(key)) return { claimed: false };

    const token = randomUUID();
    this.records.set(key, {
      id: this.nextId++,
      token,
      committed: false,
      sheetId,
      tab,
      rowKey,
      templateHash,
      sentAt: claimedAt,
    });
    return { claimed: true, token };
  }

  commit(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    token: string,
    sentAt: string,
    messageId: string | undefined,
  ): void {
    const record = this.records.get(uniqueKey(sheetId, tab, rowKey, templateHash));
    // token이 일치해도 이미 committed된 기록은 다시 commit할 수 없다 — claimed→sent는 한 번만
    // 일어나야 하는 전이다. 두 번째 commit() 호출은 호출자 버그이므로 조용히 덮어쓰지 않고
    // 똑같이 에러로 알린다(release()의 이중 호출 보호와 대칭 — 아래 참고, 재검증 과정에서
    // 발견된 방어 강화).
    if (!record || record.token !== token || record.committed) {
      throw new Error(
        `SendLog.commit: claim되지 않았거나 token이 일치하지 않거나 이미 commit된 ` +
          `(sheetId='${sheetId}', tab='${tab}', rowKey='${rowKey}', templateHash='${templateHash}')을 ` +
          "commit하려 했습니다. claim() 없이 commit()을 호출했거나, 같은 claim을 두 번 commit " +
          "했거나, 그 사이 forceReleaseStaleClaim()으로 회수되고 다른 claim으로 대체됐을 수 있습니다.",
      );
    }
    record.committed = true;
    record.sentAt = sentAt;
    record.messageId = messageId;
  }

  release(sheetId: string, tab: string, rowKey: string, templateHash: string, token: string): void {
    const key = uniqueKey(sheetId, tab, rowKey, templateHash);
    const record = this.records.get(key);
    // token이 일치하고 **아직 committed되지 않았을 때만** 지운다. 이미 없거나, 다른 claim으로
    // 대체됐거나, token은 맞지만 이미 commit(확정 발송)된 기록이면 조용히 무시한다 — 확정된
    // 기록은 release()로도 절대 지워지면 안 된다(재검증 과정에서 발견: 예전엔 이 committed
    // 체크가 없어서, 정상 흐름에서는 안 일어나지만 commit 성공 후 release가 잘못 불리면
    // 방금 확정한 발송 기록이 통째로 사라져 wasSent()가 false가 되고 재발송이 가능해지는
    // 위험이 있었다 — forceReleaseStaleClaim()이 committed 기록을 절대 건드리지 않는 것과
    // 같은 원칙을 release()에도 동일하게 적용한다).
    if (record && record.token === token && !record.committed) {
      this.records.delete(key);
    }
  }

  forceReleaseStaleClaim(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    olderThanMs: number,
  ): boolean {
    // 음수/NaN/Infinity/소수는 어떤 claim도 건드리기 전에 거부한다 — SqliteSendLog와 같은
    // 공통 검증 함수를 쓴다(STATUS-GAP-002).
    assertValidStaleClaimThreshold(olderThanMs);
    const key = uniqueKey(sheetId, tab, rowKey, templateHash);
    const record = this.records.get(key);
    if (!record || record.committed) return false;
    const ageMs = Date.now() - new Date(record.sentAt).getTime();
    if (ageMs < olderThanMs) return false;
    this.records.delete(key);
    return true;
  }

  wasSent(sheetId: string, tab: string, rowKey: string, templateHash: string): boolean {
    return this.records.has(uniqueKey(sheetId, tab, rowKey, templateHash));
  }

  list(sheetId: string, options: SendLogListOptions = {}): SendLogListResult {
    // MCP 경계(sendLogLimitSchema)는 이미 양의 정수만 허용하지만, SendLog는 그 zod 검증 없이도
    // 직접 호출될 수 있는 인터페이스이므로 0/음수가 들어와도 항상 최소 1건 이상을 요청한 것으로
    // 취급한다(재검증 중 강화 — 음수 limit이 SQLite의 "LIMIT -1=무제한" 의미와 우연히 겹쳐
    // AR-015가 막으려던 무제한 응답을 다시 열어줄 수 있었다).
    const limit = Math.max(
      1,
      Math.min(options.limit ?? DEFAULT_SEND_LOG_LIST_LIMIT, MAX_SEND_LOG_LIST_LIMIT),
    );
    const cursorId = parseCursor(options.cursor);

    const matched = [...this.records.values()]
      .filter((r) => r.sheetId === sheetId && (cursorId === undefined || r.id < cursorId))
      .sort((a, b) => b.id - a.id);

    const page = matched.slice(0, limit);
    const hasMore = matched.length > limit;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? String(last.id) : undefined;

    return { entries: page.map(toEntry), hasMore, nextCursor };
  }
}

function parseCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined;
  const id = Number(cursor);
  if (!Number.isInteger(id)) {
    throw new Error(
      `SendLog.list: cursor 값이 올바르지 않습니다: '${cursor}'. 이전 list() 응답의 nextCursor를 그대로 사용하세요.`,
    );
  }
  return id;
}
