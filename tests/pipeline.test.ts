// SendPipeline component tests — verifies all 12 items of the required edge-case checklist in
// docs/TESTING.md §4. Uses only the 4 mocks (InMemorySheetClient/MockNotificationProvider/
// InMemorySendLog/FixedClock), no network.

import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  applyFilter,
  buildDryRunNotice,
  computeTemplateHash,
  resolveDryRun,
  SendPipeline,
  type SendPipelineDeps,
} from "../src/core/pipeline.js";
import { InMemorySheetClient, loadFixtureFile } from "../src/mocks/inMemorySheetClient.js";
import type { SheetFixture } from "../src/mocks/inMemorySheetClient.js";
import { MockNotificationProvider } from "../src/mocks/mockNotificationProvider.js";
import { InMemorySendLog } from "../src/mocks/inMemorySendLog.js";
import { FixedClock } from "../src/mocks/fixedClock.js";
import type {
  ClaimResult,
  SendLog,
  SendLogListOptions,
  SendLogListResult,
} from "../src/core/types.js";

const LARGE_FIXTURE_PATH = path.resolve(process.cwd(), "fixtures/sheets/large-1000.json");
const SHEET_ID = "sheet-1";

function baseNotifyConfig(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    data_tab: "customers",
    id_column: "customer_id",
    recipient_column: "email",
    channel: "email",
    subject_template: "[{{shop}}] 안내",
    body_template: "{{name}}님, 안녕하세요.",
    ...overrides,
  };
}

interface SetupOptions {
  notifyConfig?: Record<string, string>;
  rows?: Array<Record<string, string>>;
  failFor?: string[];
  sendLog?: SendLog;
  clock?: FixedClock;
}

interface Setup {
  pipeline: SendPipeline;
  sheetClient: InMemorySheetClient;
  provider: MockNotificationProvider;
  sendLog: SendLog;
  deps: SendPipelineDeps;
}

function setup(opts: SetupOptions = {}): Setup {
  const fixture: SheetFixture = {
    notifyConfig: baseNotifyConfig(opts.notifyConfig),
    tabs: { customers: opts.rows ?? [] },
  };
  const sheetClient = new InMemorySheetClient({ [SHEET_ID]: fixture });
  const provider = new MockNotificationProvider({ failFor: opts.failFor });
  const sendLog = opts.sendLog ?? new InMemorySendLog();
  const clock = opts.clock ?? new FixedClock();
  const deps: SendPipelineDeps = { sheetClient, provider, sendLog, clock };
  return { pipeline: new SendPipeline(deps), sheetClient, provider, sendLog, deps };
}

describe("SendPipeline — TESTING §4 checklist", () => {
  it("1. Empty data tab → sent 0, not an error", async () => {
    const { pipeline } = setup({ rows: [] });
    const result = await pipeline.run(SHEET_ID, { dryRun: false });
    expect(result).toEqual({
      sent: 0,
      failed: 0,
      skipped: 0,
      logFailed: 0,
      totalMatched: 0,
      truncated: false,
      details: [],
    });
  });

  it("2. Row missing recipient_column value → only that row failed, reason in _error", async () => {
    const { pipeline, sheetClient } = setup({
      rows: [
        { customer_id: "C-1", name: "Alice", email: "", shop: "Shop1" },
        { customer_id: "C-2", name: "Bob", email: "bob@example.com", shop: "Shop1" },
      ],
    });
    const result = await pipeline.run(SHEET_ID, { dryRun: false });

    expect(result.failed).toBe(1);
    expect(result.sent).toBe(1);
    const failedDetail = result.details.find((d) => d.rowKey === "C-1");
    expect(failedDetail?.status).toBe("failed");
    expect(failedDetail?.error).toContain("recipient_column");
    expect(failedDetail?.error).toContain("email");

    const rows = await sheetClient.readRows(SHEET_ID, "customers");
    const row = rows.find((r) => r.values.customer_id === "C-1");
    expect(row?.values._send_status).toBe("failed");
    expect(row?.values._error).toContain("email");
  });

  it("3. Malformed email (no '@') → failed during pre-send validation", async () => {
    const { pipeline, provider } = setup({
      rows: [{ customer_id: "C-1", name: "Alice", email: "not-an-email", shop: "Shop1" }],
    });
    const result = await pipeline.run(SHEET_ID, { dryRun: false });

    expect(result.failed).toBe(1);
    expect(result.details[0]?.error).toContain("email format");
    expect(provider.sent).toHaveLength(0);
  });

  it("4. Missing template variable ({{amount}} with no matching column) → that row failed, missing key named explicitly", async () => {
    const { pipeline } = setup({
      notifyConfig: { body_template: "{{name}}님, {{amount}} 결제 안내입니다." },
      rows: [{ customer_id: "C-1", name: "Alice", email: "alice@example.com", shop: "Shop1" }],
    });
    const result = await pipeline.run(SHEET_ID, { dryRun: false });

    expect(result.failed).toBe(1);
    expect(result.details[0]?.status).toBe("failed");
    expect(result.details[0]?.error).toContain("amount");
  });

  it("5. Same run executed twice → the second run is entirely skipped_duplicate, 0 provider calls", async () => {
    const sendLog = new InMemorySendLog();
    const rows = [
      { customer_id: "C-1", name: "Alice", email: "alice@example.com", shop: "Shop1" },
      { customer_id: "C-2", name: "Bob", email: "bob@example.com", shop: "Shop1" },
    ];
    const { pipeline: first, sheetClient } = setup({ rows, sendLog });
    const firstResult = await first.run(SHEET_ID, { dryRun: false });
    expect(firstResult.sent).toBe(2);

    // The second run is reassembled with the same sendLog, on top of the same sheetClient state
    // (status columns already written).
    const provider2 = new MockNotificationProvider();
    const second = new SendPipeline({
      sheetClient,
      provider: provider2,
      sendLog,
      clock: new FixedClock(),
    });
    const secondResult = await second.run(SHEET_ID, { dryRun: false });

    expect(secondResult.skipped).toBe(2);
    expect(secondResult.sent).toBe(0);
    expect(secondResult.failed).toBe(0);
    expect(provider2.sent).toHaveLength(0);
    expect(provider2.failed).toHaveLength(0);
  });

  it("5-1. Even when re-recorded as skipped_duplicate after being sent, the _sent_at/_message_id audit record remains", async () => {
    const sendLog = new InMemorySendLog();
    const rows = [{ customer_id: "C-1", name: "Alice", email: "alice@example.com", shop: "Shop1" }];
    const { pipeline: first, sheetClient } = setup({ rows, sendLog });
    await first.run(SHEET_ID, { dryRun: false });

    const afterFirst = await sheetClient.readRows(SHEET_ID, "customers");
    const sentAt = afterFirst[0]?.values._sent_at;
    const messageId = afterFirst[0]?.values._message_id;
    expect(sentAt).toBeTruthy();
    expect(messageId).toBe("mock-C-1");

    const second = new SendPipeline({
      sheetClient,
      provider: new MockNotificationProvider(),
      sendLog,
      clock: new FixedClock("2026-09-02T00:00:00.000Z"),
    });
    await second.run(SHEET_ID, { dryRun: false });

    const afterSecond = await sheetClient.readRows(SHEET_ID, "customers");
    expect(afterSecond[0]?.values._send_status).toBe("skipped_duplicate");
    expect(afterSecond[0]?.values._sent_at).toBe(sentAt);
    expect(afterSecond[0]?.values._message_id).toBe(messageId);
  });

  it("6. Re-run after editing the template → re-sent because templateHash changed", async () => {
    const sendLog = new InMemorySendLog();
    const rows = [{ customer_id: "C-1", name: "Alice", email: "alice@example.com", shop: "Shop1" }];
    const { pipeline: first, sheetClient } = setup({ rows, sendLog });
    const firstResult = await first.run(SHEET_ID, { dryRun: false });
    expect(firstResult.sent).toBe(1);

    sheetClient.loadSheet(SHEET_ID, {
      notifyConfig: baseNotifyConfig({ body_template: "{{name}}님, (수정됨) 안녕하세요." }),
      tabs: { customers: rows },
    });
    const provider2 = new MockNotificationProvider();
    const second = new SendPipeline({
      sheetClient,
      provider: provider2,
      sendLog,
      clock: new FixedClock(),
    });
    const secondResult = await second.run(SHEET_ID, { dryRun: false });

    expect(secondResult.sent).toBe(1);
    expect(secondResult.skipped).toBe(0);
    expect(provider2.sent).toHaveLength(1);
  });

  it("7. Injecting failure into some rows → the rest send normally + aggregate is accurate + only failed rows have _error", async () => {
    const rows = [
      { customer_id: "C-1", name: "Alice", email: "alice@example.com", shop: "Shop1" },
      { customer_id: "C-2", name: "Bob", email: "bob@example.com", shop: "Shop1" },
      { customer_id: "C-3", name: "Carol", email: "carol@example.com", shop: "Shop1" },
    ];
    const { pipeline, provider, sheetClient } = setup({ rows, failFor: ["C-2"] });
    const result = await pipeline.run(SHEET_ID, { dryRun: false });

    expect(result.sent).toBe(2);
    expect(result.failed).toBe(1);
    expect(provider.sent.map((m) => m.rowKey)).not.toContain("C-2");

    const sheetRows = await sheetClient.readRows(SHEET_ID, "customers");
    const failedRow = sheetRows.find((r) => r.values.customer_id === "C-2");
    const okRow = sheetRows.find((r) => r.values.customer_id === "C-1");
    expect(failedRow?.values._send_status).toBe("failed");
    expect(failedRow?.values._error).toBeTruthy();
    expect(okRow?.values._send_status).toBe("sent");
    expect(okRow?.values._error).toBeFalsy();
  });

  it("8. filter_column/value applied correctly (case-sensitive comparison)", async () => {
    const { pipeline, provider } = setup({
      notifyConfig: { filter_column: "status", filter_value: "unpaid" },
      rows: [
        {
          customer_id: "C-1",
          name: "Alice",
          email: "alice@example.com",
          shop: "Shop1",
          status: "unpaid",
        },
        // Case differs, so this should not match
        {
          customer_id: "C-2",
          name: "Bob",
          email: "bob@example.com",
          shop: "Shop1",
          status: "Unpaid",
        },
        {
          customer_id: "C-3",
          name: "Carol",
          email: "carol@example.com",
          shop: "Shop1",
          status: "paid",
        },
      ],
    });
    const result = await pipeline.run(SHEET_ID, { dryRun: false });

    expect(result.sent).toBe(1);
    expect(result.details.map((d) => d.rowKey)).toEqual(["C-1"]);
    expect(provider.sent.map((m) => m.rowKey)).toEqual(["C-1"]);
  });

  it("9. Unicode: no merge breakage with Tagalog/Korean values", async () => {
    const { pipeline, provider } = setup({
      notifyConfig: {
        subject_template: "[{{shop}}] 결제 안내 / Paalala",
        body_template: "{{name}} 님/po, {{amount}} 결제 부탁드립니다. Salamat po!",
      },
      rows: [
        {
          customer_id: "C-1",
          name: "김철수",
          email: "kim@example.com",
          shop: "세부 하드웨어",
          amount: "₱1,200.50",
        },
      ],
    });
    const result = await pipeline.run(SHEET_ID, { dryRun: false });

    expect(result.sent).toBe(1);
    const sentMsg = provider.sent[0];
    expect(sentMsg?.subject).toBe("[세부 하드웨어] 결제 안내 / Paalala");
    expect(sentMsg?.body).toBe("김철수 님/po, ₱1,200.50 결제 부탁드립니다. Salamat po!");
  });

  it("10. dryRun: true → 0 provider calls, 0 writeStatus calls (sheet status columns unchanged)", async () => {
    const rows = [{ customer_id: "C-1", name: "Alice", email: "alice@example.com", shop: "Shop1" }];
    const { pipeline, provider, sheetClient } = setup({ rows });
    const result = await pipeline.run(SHEET_ID, { dryRun: true });

    expect(result.sent).toBe(1); // Preview: a row that passed validation and isn't a duplicate is marked as "will be sent"
    expect(provider.sent).toHaveLength(0);
    expect(provider.failed).toHaveLength(0);

    const sheetRows = await sheetClient.readRows(SHEET_ID, "customers");
    expect(sheetRows[0]?.values._send_status).toBeUndefined();
  });

  it("11. send_notifications(confirm=true) under SEND_MODE=dry_run → returns a dry-run result with no real send", async () => {
    // Verifies how the MCP tool-level decision logic (resolveDryRun) folds SEND_MODE and confirm into dryRun.
    expect(resolveDryRun("dry_run", true)).toBe(true);
    expect(resolveDryRun(undefined, true)).toBe(true);
    expect(resolveDryRun("live", false)).toBe(true);
    expect(resolveDryRun("live", true)).toBe(false);

    const rows = [{ customer_id: "C-1", name: "Alice", email: "alice@example.com", shop: "Shop1" }];
    const { pipeline, provider } = setup({ rows });
    const dryRun = resolveDryRun("dry_run", true);
    const result = await pipeline.run(SHEET_ID, { dryRun });

    expect(dryRun).toBe(true);
    expect(result.sent).toBe(1);
    expect(provider.sent).toHaveLength(0);
  });

  it("12. 1,000-row fixture pipeline < 2 seconds", async () => {
    const fixture = loadFixtureFile(LARGE_FIXTURE_PATH);
    const sheetClient = new InMemorySheetClient({
      [fixture.sheetId]: { notifyConfig: fixture.notifyConfig, tabs: fixture.tabs },
    });
    const provider = new MockNotificationProvider();
    const sendLog = new InMemorySendLog();
    const pipeline = new SendPipeline({ sheetClient, provider, sendLog, clock: new FixedClock() });

    const dataTab = fixture.notifyConfig.data_tab ?? "customers";
    const filterColumn = fixture.notifyConfig.filter_column;
    const filterValue = fixture.notifyConfig.filter_value;
    const expectedCount =
      filterColumn !== undefined && filterValue !== undefined
        ? (fixture.tabs[dataTab] ?? []).filter((row) => row[filterColumn] === filterValue).length
        : (fixture.tabs[dataTab] ?? []).length;

    const start = Date.now();
    const result = await pipeline.run(fixture.sheetId, { dryRun: false });
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(2000);
    expect(result.sent + result.failed + result.skipped).toBe(expectedCount);
    expect(result.sent).toBeGreaterThan(0);
  });
});

describe("MAX_PIPELINE_ROWS cap (docs/ADVERSARIAL_REVIEW_004.md AR-022)", () => {
  /** Creates N synthetic rows, each with a unique id_column/email — for large-volume cap testing only. */
  function manyRows(count: number): Array<Record<string, string>> {
    return Array.from({ length: count }, (_, i) => ({
      customer_id: `CUST-${String(i)}`,
      name: `User${String(i)}`,
      email: `user${String(i)}@example.com`,
      shop: "Shop1",
    }));
  }

  it("dry-run: 1001 rows exceeding MAX_PIPELINE_ROWS(1000) are truncated for the preview and reported via totalMatched/truncated", async () => {
    const { pipeline } = setup({ rows: manyRows(1001) });
    const result = await pipeline.run(SHEET_ID, { dryRun: true });

    expect(result.totalMatched).toBe(1001);
    expect(result.truncated).toBe(true);
    expect(result.details).toHaveLength(1000);
  });

  it(
    "live: exceeding MAX_PIPELINE_ROWS(1000) throws and aborts the entire run instead of quietly " +
      "sending only some — provider.send() and claim() are never called even once (no partial send)",
    async () => {
      const { pipeline, provider, sheetClient, sendLog } = setup({ rows: manyRows(1001) });

      await expect(pipeline.run(SHEET_ID, { dryRun: false })).rejects.toThrow(
        /The send target has 1001 rows, exceeding the limit \(1000 rows\)/,
      );

      expect(provider.sent).toHaveLength(0);
      expect(provider.failed).toHaveLength(0);
      // Indirectly confirms claim() was never called, via wasSent() — sampling just the first few rows.
      expect(sendLog.wasSent(SHEET_ID, "customers", "CUST-0", "irrelevant")).toBe(false);
      // The sheet's status columns must also be completely untouched — meaning the write-back call
      // never happened.
      const rowsAfter = await sheetClient.readRows(SHEET_ID, "customers");
      expect(rowsAfter[0]?.values["_send_status"]).toBeUndefined();
    },
  );
});

describe("SendPipeline — additional robustness cases", () => {
  it("Row missing id_column value → failed, provider not called", async () => {
    const { pipeline, provider } = setup({
      rows: [{ customer_id: "", name: "Alice", email: "alice@example.com", shop: "Shop1" }],
    });
    const result = await pipeline.run(SHEET_ID, { dryRun: false });

    expect(result.failed).toBe(1);
    expect(result.details[0]?.error).toContain("id_column");
    expect(provider.sent).toHaveLength(0);
  });

  it("ConfigParseError propagates as-is when config validation fails", async () => {
    const { pipeline, sheetClient } = setup({ rows: [] });
    sheetClient.loadSheet(SHEET_ID, {
      notifyConfig: { data_tab: "customers" }, // missing most required keys
      tabs: { customers: [] },
    });
    await expect(pipeline.run(SHEET_ID, { dryRun: false })).rejects.toThrow(/notify_config/);
  });
});

describe("computeTemplateHash", () => {
  it("Returns the same hash (12 chars) for the same template every time", () => {
    const a = computeTemplateHash("subject {{x}}", "body {{y}}");
    const b = computeTemplateHash("subject {{x}}", "body {{y}}");
    expect(a).toBe(b);
    expect(a).toHaveLength(12);
  });

  it("The hash changes if either subject or body differs", () => {
    const a = computeTemplateHash("subject A", "body");
    const b = computeTemplateHash("subject B", "body");
    const c = computeTemplateHash("subject A", "body 2");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("REG-001: different (subject, body) pairs don't collide even when a boundary character matches the delimiter", () => {
    // In the old implementation (concatenated with a space delimiter), these two pairs both became
    // "A  B" and hashed the same.
    const a = computeTemplateHash("A ", "B");
    const b = computeTemplateHash("A", " B");
    expect(a).not.toBe(b);
  });
});

describe("resolveDryRun", () => {
  it("It's a real send (dryRun=false) only when SEND_MODE=live and confirm=true", () => {
    expect(resolveDryRun("live", true)).toBe(false);
    expect(resolveDryRun("live", false)).toBe(true);
    expect(resolveDryRun("dry_run", true)).toBe(true);
    expect(resolveDryRun("dry_run", false)).toBe(true);
    expect(resolveDryRun(undefined, true)).toBe(true);
    expect(resolveDryRun(undefined, false)).toBe(true);
  });
});

describe("buildDryRunNotice", () => {
  it("Returns the SEND_MODE/confirm notice text when dryRun=true", () => {
    const notice = buildDryRunNotice(true);
    expect(notice).toContain("SEND_MODE=live");
    expect(notice).toContain("confirm=true");
  });

  it("No notice is needed when dryRun=false (a real send)", () => {
    expect(buildDryRunNotice(false)).toBeUndefined();
  });
});

describe("applyFilter", () => {
  it("Returns all rows unchanged when filter_column/filter_value are absent", () => {
    const rows = [
      { rowIndex: 2, values: { status: "unpaid" } },
      { rowIndex: 3, values: { status: "paid" } },
    ];
    expect(applyFilter(rows, undefined, undefined)).toEqual(rows);
  });

  it("Keeps only exactly-matching rows when filter_column/filter_value are present", () => {
    const rows = [
      { rowIndex: 2, values: { status: "unpaid" } },
      { rowIndex: 3, values: { status: "paid" } },
    ];
    expect(applyFilter(rows, "status", "unpaid")).toEqual([rows[0]]);
  });
});

// A mock that simulates only SendLog's commit() failing — for reproducing AR-013 (send succeeded +
// local record failed). claim/release/wasSent/list/forceReleaseStaleClaim are all delegated as-is to the
// inner InMemorySendLog.
class CommitFailingSendLog implements SendLog {
  private readonly inner = new InMemorySendLog();

  claim(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    claimedAt: string,
  ): ClaimResult {
    return this.inner.claim(sheetId, tab, rowKey, templateHash, claimedAt);
  }

  commit(): void {
    throw new Error("DB write failed (test-injected)");
  }

  release(sheetId: string, tab: string, rowKey: string, templateHash: string, token: string): void {
    this.inner.release(sheetId, tab, rowKey, templateHash, token);
  }

  forceReleaseStaleClaim(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    olderThanMs: number,
  ): boolean {
    return this.inner.forceReleaseStaleClaim(sheetId, tab, rowKey, templateHash, olderThanMs);
  }

  wasSent(sheetId: string, tab: string, rowKey: string, templateHash: string): boolean {
    return this.inner.wasSent(sheetId, tab, rowKey, templateHash);
  }

  list(sheetId: string, options?: SendLogListOptions): SendLogListResult {
    return this.inner.list(sheetId, options);
  }
}

// A mock that simulates only SendLog's release() failing — for reproducing GAP-003 (verifying a
// release failure doesn't abort the batch).
class ReleaseFailingSendLog implements SendLog {
  private readonly inner = new InMemorySendLog();

  claim(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    claimedAt: string,
  ): ClaimResult {
    return this.inner.claim(sheetId, tab, rowKey, templateHash, claimedAt);
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
    this.inner.commit(sheetId, tab, rowKey, templateHash, token, sentAt, messageId);
  }

  release(): void {
    throw new Error("release DB error (test-injected)");
  }

  forceReleaseStaleClaim(
    sheetId: string,
    tab: string,
    rowKey: string,
    templateHash: string,
    olderThanMs: number,
  ): boolean {
    return this.inner.forceReleaseStaleClaim(sheetId, tab, rowKey, templateHash, olderThanMs);
  }

  wasSent(sheetId: string, tab: string, rowKey: string, templateHash: string): boolean {
    return this.inner.wasSent(sheetId, tab, rowKey, templateHash);
  }

  list(sheetId: string, options?: SendLogListOptions): SendLogListResult {
    return this.inner.list(sheetId, options);
  }
}

describe("docs/ADVERSARIAL_REVIEW_003.md regression tests", () => {
  it("AR-011: even if the same rowKey appears twice in the same batch, the provider is called only once and only one entry remains in SendLog", async () => {
    const rows = [
      { customer_id: "C-1", name: "Alice", email: "alice@example.com", shop: "Shop1" },
      {
        customer_id: "C-1",
        name: "Alice (duplicate row)",
        email: "alice@example.com",
        shop: "Shop1",
      },
    ];
    const sendLog = new InMemorySendLog();
    const { pipeline, provider } = setup({ rows, sendLog });
    const result = await pipeline.run(SHEET_ID, { dryRun: false });

    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(1);
    expect(provider.sent).toHaveLength(1);
    expect(sendLog.list(SHEET_ID).entries).toHaveLength(1);
  });

  it(
    "AR-013: if the SendLog record fails after a successful send, it's separated as sent_log_failed instead " +
      "of failed, and the claim is not released so a retry within the same run cannot attempt to send again",
    async () => {
      const rows = [
        { customer_id: "C-1", name: "Alice", email: "alice@example.com", shop: "Shop1" },
      ];
      const sendLog = new CommitFailingSendLog();
      const { pipeline, provider } = setup({ rows, sendLog });

      const result = await pipeline.run(SHEET_ID, { dryRun: false });

      expect(provider.sent).toHaveLength(1); // The actual send itself succeeded
      expect(result.details[0]?.status).toBe("sent_log_failed");
      expect(result.details[0]?.error).toContain("saving the local send log failed");
      // Must not be counted in either failed or sent — it falls into the separate logFailed aggregate (GAP-002).
      expect(result.sent).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.logFailed).toBe(1);
      // Aggregate invariant: sent+failed+skipped+logFailed === details.length must always hold.
      expect(result.sent + result.failed + result.skipped + result.logFailed).toBe(
        result.details.length,
      );

      // GAP-002: the claim must remain in SendLog with 'claimed' status — a commit failure must not be
      // incorrectly finalized as 'sent', and it must not appear as a normal sent entry when queried.
      const logEntries = sendLog.list(SHEET_ID).entries;
      expect(logEntries).toHaveLength(1);
      expect(logEntries[0]?.sendStatus).toBe("claimed");

      // Since the claim was not released, wasSent is still true — a retry will not send again.
      expect(
        sendLog.wasSent(
          SHEET_ID,
          "customers",
          "C-1",
          computeTemplateHash("[{{shop}}] 안내", "{{name}}님, 안녕하세요."),
        ),
      ).toBe(true);
    },
  );

  it(
    "GAP-003: even when release() itself fails, the remaining rows continue to be processed (the batch is " +
      "not aborted), and the release failure is recorded in the error message",
    async () => {
      const rows = [
        { customer_id: "C-1", name: "Alice", email: "alice@example.com", shop: "Shop1" },
        { customer_id: "C-2", name: "Bob", email: "bob@example.com", shop: "Shop1" },
      ];
      const sendLog = new ReleaseFailingSendLog();
      // C-1 is made to fail by the provider so it goes through release() (which always throws in the
      // mock), and C-2 should send normally — this checks that an earlier row's release failure doesn't
      // block processing of the row after it.
      const { pipeline, provider } = setup({ rows, sendLog, failFor: ["C-1"] });

      const result = await pipeline.run(SHEET_ID, { dryRun: false });

      expect(result.failed).toBe(1);
      expect(result.sent).toBe(1);
      expect(provider.sent.map((m) => m.rowKey)).toEqual(["C-2"]); // C-1 failed, C-2 was sent
      const failedDetail = result.details.find((d) => d.rowKey === "C-1");
      expect(failedDetail?.status).toBe("failed");
      expect(failedDetail?.error).toContain("releasing the reservation also failed");
    },
  );

  it("AR-014: when a previously-failed row succeeds on retry, the past _error is cleared", async () => {
    const rows = [{ customer_id: "C-1", name: "Alice", email: "alice@example.com", shop: "Shop1" }];
    const sendLog = new InMemorySendLog();
    const { pipeline: first, sheetClient } = setup({ rows, sendLog, failFor: ["C-1"] });
    await first.run(SHEET_ID, { dryRun: false });

    const afterFail = await sheetClient.readRows(SHEET_ID, "customers");
    expect(afterFail[0]?.values._send_status).toBe("failed");
    expect(afterFail[0]?.values._error).toBeTruthy();

    // Re-run on top of the same sheetClient/sendLog, this time with a provider that has no injected
    // failure (retrying the same template).
    const second = new SendPipeline({
      sheetClient,
      provider: new MockNotificationProvider(),
      sendLog,
      clock: new FixedClock(),
    });
    await second.run(SHEET_ID, { dryRun: false });

    const afterRetry = await sheetClient.readRows(SHEET_ID, "customers");
    expect(afterRetry[0]?.values._send_status).toBe("sent");
    expect(afterRetry[0]?.values._error).toBe("");
  });

  it("AR-014: past _sent_at/_message_id are preserved even when a previously-sent row later fails (new template)", async () => {
    const rows = [{ customer_id: "C-1", name: "Alice", email: "alice@example.com", shop: "Shop1" }];
    const sendLog = new InMemorySendLog();
    const { pipeline: first, sheetClient } = setup({ rows, sendLog });
    await first.run(SHEET_ID, { dryRun: false });

    const afterSent = await sheetClient.readRows(SHEET_ID, "customers");
    const originalSentAt = afterSent[0]?.values._sent_at;
    const originalMessageId = afterSent[0]?.values._message_id;
    expect(originalSentAt).toBeTruthy();
    expect(originalMessageId).toBe("mock-C-1");

    // Re-run after changing the template (making it eligible for re-send), this time injecting a
    // failure. loadSheet overwrites the whole tab, so it must be reloaded from afterSent (the current
    // values after the first run, including the status columns) rather than the original rows, so the
    // _sent_at/_message_id just recorded is preserved.
    sheetClient.loadSheet(SHEET_ID, {
      notifyConfig: baseNotifyConfig({ body_template: "{{name}}님, (수정됨) 실패할 예정." }),
      tabs: { customers: afterSent.map((row) => row.values) },
    });
    const second = new SendPipeline({
      sheetClient,
      provider: new MockNotificationProvider({ failFor: ["C-1"] }),
      sendLog,
      clock: new FixedClock("2026-09-02T00:00:00.000Z"),
    });
    await second.run(SHEET_ID, { dryRun: false });

    const afterFailedRetry = await sheetClient.readRows(SHEET_ID, "customers");
    expect(afterFailedRetry[0]?.values._send_status).toBe("failed");
    expect(afterFailedRetry[0]?.values._sent_at).toBe(originalSentAt);
    expect(afterFailedRetry[0]?.values._message_id).toBe(originalMessageId);
  });

  it("AR-017: obviously malformed email formats that used to pass a mere '@'-presence check are now treated as failed", async () => {
    const badEmails = ["a@", "@example.com", "a@@example.com", "a b@example.com"];
    for (const email of badEmails) {
      const { pipeline, provider } = setup({
        rows: [{ customer_id: "C-1", name: "Alice", email, shop: "Shop1" }],
      });
      const result = await pipeline.run(SHEET_ID, { dryRun: false });
      expect(result.failed, `email='${email}' must be failed`).toBe(1);
      expect(provider.sent, `email='${email}' must not call the provider`).toHaveLength(0);
    }
  });
});
