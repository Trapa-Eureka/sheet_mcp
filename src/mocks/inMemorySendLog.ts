// In-memory SendLog implementation — for deterministic tests (the SQLite adapter is verified
// separately in tests/sqliteSendLog.test.ts).
// Design: docs/DESIGN.md §3 (SendLog), §6 (unique key). Background for claim/commit/release +
// ownership tokens + expiry-based manual recovery + cursor pagination is in
// docs/ADVERSARIAL_REVIEW_003.md AR-011/AR-013,
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
  sentAt: string; // claimedAt while claimed, the actual sentAt after commit
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

  // JS is single-threaded, so nothing can run between claim()'s has+set — this synchronicity
  // itself guarantees atomicity within a single process (AR-011). True multi-process atomicity is
  // guaranteed by SqliteSendLog via SQLite's UNIQUE constraint.
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
    // Even if the token matches, a record that has already been committed cannot be committed
    // again — claimed→sent must be a transition that happens exactly once. A second commit()
    // call is a caller bug, so instead of silently overwriting it we report it as an error,
    // symmetrically with the double-call guard in release() (see below) — a defense strengthened
    // during re-verification.
    if (!record || record.token !== token || record.committed) {
      throw new Error(
        `SendLog.commit: attempted to commit ` +
          `(sheetId='${sheetId}', tab='${tab}', rowKey='${rowKey}', templateHash='${templateHash}') ` +
          "that was not claimed, token did not match, or was already committed. You may have " +
          "called commit() without claim(), committed the same claim twice, or it was reclaimed " +
          "via forceReleaseStaleClaim() and replaced by a different claim in the meantime.",
      );
    }
    record.committed = true;
    record.sentAt = sentAt;
    record.messageId = messageId;
  }

  release(sheetId: string, tab: string, rowKey: string, templateHash: string, token: string): void {
    const key = uniqueKey(sheetId, tab, rowKey, templateHash);
    const record = this.records.get(key);
    // Delete only when the token matches **and** the record has not yet been committed. If the
    // record is already gone, was replaced by a different claim, or the token matches but the
    // record has already been committed (a confirmed send), silently ignore the call — a
    // confirmed record must never be deleted by release() either (found during re-verification:
    // this committed check used to be missing, so although it can't happen in normal flow, if
    // release() were mistakenly called after a successful commit, the just-confirmed send record
    // would vanish entirely, making wasSent() return false and allowing a resend — release() now
    // applies the same principle as forceReleaseStaleClaim(), which never touches a committed
    // record either).
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
    // Reject negative/NaN/Infinity/non-integer values before touching any claim — uses the same
    // shared validation function as SqliteSendLog (STATUS-GAP-002).
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
    // The MCP boundary (sendLogLimitSchema) already allows only positive integers, but SendLog is
    // an interface that can be called directly without that zod validation, so even 0/negative
    // values are always treated as a request for at least 1 (strengthened during re-verification
    // — a negative limit happened to coincide with SQLite's "LIMIT -1 = unlimited" meaning, which
    // could have reopened the unlimited response that AR-015 was meant to prevent).
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
      `SendLog.list: invalid cursor value: '${cursor}'. Use the nextCursor from a previous list() response as-is.`,
    );
  }
  return id;
}
