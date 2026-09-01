// SendPipeline 컴포넌트 테스트 — docs/TESTING.md §4의 필수 엣지 케이스 체크리스트 12항목 전부를 검증한다.
// 목 4종(InMemorySheetClient/MockNotificationProvider/InMemorySendLog/FixedClock)만 사용, 네트워크 없음.

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
  sendLog?: InMemorySendLog;
  clock?: FixedClock;
}

interface Setup {
  pipeline: SendPipeline;
  sheetClient: InMemorySheetClient;
  provider: MockNotificationProvider;
  sendLog: InMemorySendLog;
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

describe("SendPipeline — TESTING §4 체크리스트", () => {
  it("1. 빈 데이터 탭 → sent 0, 에러 아님", async () => {
    const { pipeline } = setup({ rows: [] });
    const result = await pipeline.run(SHEET_ID, { dryRun: false });
    expect(result).toEqual({ sent: 0, failed: 0, skipped: 0, details: [] });
  });

  it("2. recipient_column 값 결측 행 → 그 행만 failed, _error에 사유", async () => {
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

  it("3. 이메일 형식 불량('@' 없음) → 발송 전 검증에서 failed", async () => {
    const { pipeline, provider } = setup({
      rows: [{ customer_id: "C-1", name: "Alice", email: "not-an-email", shop: "Shop1" }],
    });
    const result = await pipeline.run(SHEET_ID, { dryRun: false });

    expect(result.failed).toBe(1);
    expect(result.details[0]?.error).toContain("이메일 형식");
    expect(provider.sent).toHaveLength(0);
  });

  it("4. 템플릿 변수 결측({{amount}}인데 컬럼 없음) → 그 행 failed, 결측 키 명시", async () => {
    const { pipeline } = setup({
      notifyConfig: { body_template: "{{name}}님, {{amount}} 결제 안내입니다." },
      rows: [{ customer_id: "C-1", name: "Alice", email: "alice@example.com", shop: "Shop1" }],
    });
    const result = await pipeline.run(SHEET_ID, { dryRun: false });

    expect(result.failed).toBe(1);
    expect(result.details[0]?.status).toBe("failed");
    expect(result.details[0]?.error).toContain("amount");
  });

  it("5. 같은 실행 2회 → 2회차 전부 skipped_duplicate, provider 호출 0건", async () => {
    const sendLog = new InMemorySendLog();
    const rows = [
      { customer_id: "C-1", name: "Alice", email: "alice@example.com", shop: "Shop1" },
      { customer_id: "C-2", name: "Bob", email: "bob@example.com", shop: "Shop1" },
    ];
    const { pipeline: first, sheetClient } = setup({ rows, sendLog });
    const firstResult = await first.run(SHEET_ID, { dryRun: false });
    expect(firstResult.sent).toBe(2);

    // 두 번째 실행은 같은 sheetClient 상태(이미 상태 컬럼이 기록된) 위에서, 같은 sendLog로 재조립한다.
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

  it("5-1. sent 후 skipped_duplicate로 재기록돼도 _sent_at/_message_id 감사 기록이 남는다", async () => {
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

  it("6. 템플릿 수정 후 재실행 → templateHash 변경으로 재발송됨", async () => {
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

  it("7. 일부 행 실패 주입 → 나머지 정상 발송 + 집계 정확 + 실패 행만 _error", async () => {
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

  it("8. filter_column/value 적용 정확성 (대소문자 그대로 비교)", async () => {
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
        // 대소문자가 다르므로 매칭되지 않아야 한다
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

  it("9. 유니코드: 타갈로그·한글 값 머지 깨짐 없음", async () => {
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

  it("10. dryRun: true → provider 호출 0건, writeStatus 호출 0건 (시트 상태 컬럼 미변경)", async () => {
    const rows = [{ customer_id: "C-1", name: "Alice", email: "alice@example.com", shop: "Shop1" }];
    const { pipeline, provider, sheetClient } = setup({ rows });
    const result = await pipeline.run(SHEET_ID, { dryRun: true });

    expect(result.sent).toBe(1); // 미리보기: 검증 통과 + 미중복 행은 "발송될 것"으로 표시
    expect(provider.sent).toHaveLength(0);
    expect(provider.failed).toHaveLength(0);

    const sheetRows = await sheetClient.readRows(SHEET_ID, "customers");
    expect(sheetRows[0]?.values._send_status).toBeUndefined();
  });

  it("11. SEND_MODE=dry_run에서 send_notifications(confirm=true) → 실발송 없이 dry-run 결과 반환", async () => {
    // MCP 도구 레벨 판정 로직(resolveDryRun)이 SEND_MODE와 confirm을 어떻게 dryRun으로 접는지 확인한다.
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

  it("12. 1,000행 픽스처 파이프라인 < 2초", async () => {
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

describe("SendPipeline — 추가 견고성 케이스", () => {
  it("id_column 값 결측 행 → failed, provider 호출 안 됨", async () => {
    const { pipeline, provider } = setup({
      rows: [{ customer_id: "", name: "Alice", email: "alice@example.com", shop: "Shop1" }],
    });
    const result = await pipeline.run(SHEET_ID, { dryRun: false });

    expect(result.failed).toBe(1);
    expect(result.details[0]?.error).toContain("id_column");
    expect(provider.sent).toHaveLength(0);
  });

  it("config 검증 실패 시 ConfigParseError가 그대로 전파된다", async () => {
    const { pipeline, sheetClient } = setup({ rows: [] });
    sheetClient.loadSheet(SHEET_ID, {
      notifyConfig: { data_tab: "customers" }, // 필수 키 대부분 결측
      tabs: { customers: [] },
    });
    await expect(pipeline.run(SHEET_ID, { dryRun: false })).rejects.toThrow(/notify_config/);
  });
});

describe("computeTemplateHash", () => {
  it("같은 템플릿이면 항상 같은 해시(12자)를 반환한다", () => {
    const a = computeTemplateHash("subject {{x}}", "body {{y}}");
    const b = computeTemplateHash("subject {{x}}", "body {{y}}");
    expect(a).toBe(b);
    expect(a).toHaveLength(12);
  });

  it("subject/body 중 하나만 달라도 해시가 달라진다", () => {
    const a = computeTemplateHash("subject A", "body");
    const b = computeTemplateHash("subject B", "body");
    const c = computeTemplateHash("subject A", "body 2");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("resolveDryRun", () => {
  it("SEND_MODE=live 그리고 confirm=true일 때만 실발송(dryRun=false)이다", () => {
    expect(resolveDryRun("live", true)).toBe(false);
    expect(resolveDryRun("live", false)).toBe(true);
    expect(resolveDryRun("dry_run", true)).toBe(true);
    expect(resolveDryRun("dry_run", false)).toBe(true);
    expect(resolveDryRun(undefined, true)).toBe(true);
    expect(resolveDryRun(undefined, false)).toBe(true);
  });
});

describe("buildDryRunNotice", () => {
  it("dryRun=true면 SEND_MODE/confirm 안내 문구를 반환한다", () => {
    const notice = buildDryRunNotice(true);
    expect(notice).toContain("SEND_MODE=live");
    expect(notice).toContain("confirm=true");
  });

  it("dryRun=false(실발송)면 안내가 필요 없다", () => {
    expect(buildDryRunNotice(false)).toBeUndefined();
  });
});

describe("applyFilter", () => {
  it("filter_column/filter_value가 없으면 전체 행을 그대로 반환한다", () => {
    const rows = [
      { rowIndex: 2, values: { status: "unpaid" } },
      { rowIndex: 3, values: { status: "paid" } },
    ];
    expect(applyFilter(rows, undefined, undefined)).toEqual(rows);
  });

  it("filter_column/filter_value가 있으면 정확히 일치하는 행만 남긴다", () => {
    const rows = [
      { rowIndex: 2, values: { status: "unpaid" } },
      { rowIndex: 3, values: { status: "paid" } },
    ];
    expect(applyFilter(rows, "status", "unpaid")).toEqual([rows[0]]);
  });
});
