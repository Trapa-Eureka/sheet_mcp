import { beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { InMemorySheetClient, loadFixtureFile } from "../src/mocks/inMemorySheetClient.js";
import type { SheetFixture } from "../src/mocks/inMemorySheetClient.js";

const COLLECTIONS_FIXTURE_PATH = path.resolve(process.cwd(), "fixtures/sheets/collections.json");

function simpleFixture(): SheetFixture {
  return {
    notifyConfig: {
      data_tab: "customers",
      id_column: "customer_id",
      recipient_column: "email",
      channel: "email",
      subject_template: "[{{shop}}] 안내",
      body_template: "{{name}}님 안내드립니다.",
    },
    tabs: {
      customers: [
        { customer_id: "A-1", name: "Alice", email: "alice@example.com", shop: "Shop1" },
        { customer_id: "A-2", name: "Bob", email: "bob@example.com", shop: "Shop1" },
      ],
    },
  };
}

describe("InMemorySheetClient", () => {
  let client: InMemorySheetClient;

  beforeEach(() => {
    client = new InMemorySheetClient({ "sheet-1": simpleFixture() });
  });

  it("readConfig가 notify_config 원본을 반환한다", async () => {
    const config = await client.readConfig("sheet-1");
    expect(config.data_tab).toBe("customers");
    expect(config.channel).toBe("email");
  });

  it("readRows가 2행부터 rowIndex를 매긴다 (1행은 헤더)", async () => {
    const rows = await client.readRows("sheet-1", "customers");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      rowIndex: 2,
      values: { customer_id: "A-1", name: "Alice", email: "alice@example.com", shop: "Shop1" },
    });
    expect(rows[1]?.rowIndex).toBe(3);
  });

  it("readConfig/readRows는 내부 상태의 복사본을 반환한다 (외부에서 변형해도 영향 없음)", async () => {
    const rows = await client.readRows("sheet-1", "customers");
    rows[0]!.values.name = "MUTATED";
    const rowsAgain = await client.readRows("sheet-1", "customers");
    expect(rowsAgain[0]?.values.name).toBe("Alice");
  });

  it("ensureStatusColumns는 상태 컬럼 4개를 빈 값으로 채우고, 재조회 시 반영된다", async () => {
    await client.ensureStatusColumns("sheet-1", "customers");
    const rows = await client.readRows("sheet-1", "customers");
    for (const row of rows) {
      expect(row.values._send_status).toBe("");
      expect(row.values._sent_at).toBe("");
      expect(row.values._message_id).toBe("");
      expect(row.values._error).toBe("");
    }
  });

  it("ensureStatusColumns는 기존 사용자 데이터 컬럼 값을 건드리지 않는다", async () => {
    await client.ensureStatusColumns("sheet-1", "customers");
    const rows = await client.readRows("sheet-1", "customers");
    expect(rows[0]?.values.name).toBe("Alice");
    expect(rows[0]?.values.email).toBe("alice@example.com");
  });

  it("writeStatus가 메모리에 반영되고 재조회 시 그대로 나온다", async () => {
    await client.ensureStatusColumns("sheet-1", "customers");
    await client.writeStatus("sheet-1", "customers", [
      { rowIndex: 2, sendStatus: "sent", sentAt: "2026-09-01T00:00:00.000Z", messageId: "msg-1" },
      { rowIndex: 3, sendStatus: "failed", error: "invalid email" },
    ]);

    const rows = await client.readRows("sheet-1", "customers");
    expect(rows[0]?.values).toMatchObject({
      _send_status: "sent",
      _sent_at: "2026-09-01T00:00:00.000Z",
      _message_id: "msg-1",
      _error: "",
    });
    expect(rows[1]?.values).toMatchObject({
      _send_status: "failed",
      _message_id: "",
      _error: "invalid email",
    });
  });

  it("writeStatus는 ensureStatusColumns 없이도 상태 컬럼을 새로 만들어 반영한다", async () => {
    await client.writeStatus("sheet-1", "customers", [
      { rowIndex: 2, sendStatus: "skipped_duplicate" },
    ]);
    const rows = await client.readRows("sheet-1", "customers");
    expect(rows[0]?.values._send_status).toBe("skipped_duplicate");
  });

  it("존재하지 않는 sheetId를 읽으면 등록 방법을 안내하는 에러를 던진다", async () => {
    await expect(client.readConfig("no-such-sheet")).rejects.toThrow(
      /loadSheet\(sheetId, fixture\)로 먼저 등록/,
    );
  });

  it("존재하지 않는 tab을 읽으면 어떤 키를 추가해야 하는지 안내하는 에러를 던진다", async () => {
    await expect(client.readRows("sheet-1", "no-such-tab")).rejects.toThrow(
      /tabs에 'no-such-tab' 키를 추가/,
    );
  });

  it("존재하지 않는 rowIndex로 writeStatus를 호출하면 명시적으로 에러를 던진다", async () => {
    await expect(
      client.writeStatus("sheet-1", "customers", [{ rowIndex: 999, sendStatus: "sent" }]),
    ).rejects.toThrow(/rowIndex 999가 없습니다/);
  });

  it("writeStatus는 all-or-nothing이다 — 배치 중 하나라도 rowIndex가 없으면 앞선 행도 반영되지 않는다", async () => {
    await expect(
      client.writeStatus("sheet-1", "customers", [
        { rowIndex: 2, sendStatus: "sent", messageId: "should-not-apply" },
        { rowIndex: 999, sendStatus: "sent" },
      ]),
    ).rejects.toThrow(/rowIndex 999가 없습니다/);

    const rows = await client.readRows("sheet-1", "customers");
    // 배치 전체가 실패했으므로 rowIndex 2도 status 컬럼이 생기지 않아야 한다
    expect(rows[0]?.values._send_status).toBeUndefined();
  });

  it("loadSheet으로 시트를 추가 등록할 수 있다", async () => {
    client.loadSheet("sheet-2", simpleFixture());
    const rows = await client.readRows("sheet-2", "customers");
    expect(rows).toHaveLength(2);
  });
});

describe("fixtures/sheets/collections.json (SPEC §4-3 수금 안내)", () => {
  it("loadFixtureFile로 로드해 InMemorySheetClient에 등록하고 필터/유니코드 값을 읽을 수 있다", async () => {
    const fixture = loadFixtureFile(COLLECTIONS_FIXTURE_PATH);
    const client = new InMemorySheetClient({ [fixture.sheetId]: fixture });

    const config = await client.readConfig(fixture.sheetId);
    expect(config.filter_column).toBe("status");
    expect(config.filter_value).toBe("unpaid");

    const rows = await client.readRows(fixture.sheetId, config.data_tab ?? "");
    expect(rows).toHaveLength(12);

    const unpaidRows = rows.filter((row) => row.values.status === "unpaid");
    expect(unpaidRows.length).toBeGreaterThan(0);
    expect(unpaidRows.length).toBeLessThan(rows.length);

    // 타갈로그/영어 혼용 값이 깨지지 않고 그대로 유지되는지 확인
    const first = rows[0];
    expect(first?.values.notes).toContain("bayaran");
    expect(config.body_template).toContain("po,");
  });
});
