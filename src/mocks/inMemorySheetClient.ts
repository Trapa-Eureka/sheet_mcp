// SheetClient 목 구현 — fixtures/sheets/*.json을 로드해 메모리에서 읽기/쓰기를 흉내낸다.
// 설계: docs/DESIGN.md §3(SheetClient 계약), 테스트 전략: docs/TESTING.md §2.

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { SheetClient, SheetRow, StatusUpdate } from "../core/types.js";

const STATUS_COLUMNS = ["_send_status", "_sent_at", "_message_id", "_error"] as const;

export interface SheetFixture {
  notifyConfig: Record<string, string>;
  tabs: Record<string, Array<Record<string, string>>>;
}

export interface SheetFixtureFile extends SheetFixture {
  sheetId: string;
}

/** fixtures/sheets/*.json이 지켜야 할 형태. 생성 스크립트(scripts/genLargeFixture.ts)도 이 스키마로 결과물을 검증한다 */
export const sheetFixtureFileSchema = z.object({
  sheetId: z.string(),
  notifyConfig: z.record(z.string(), z.string()),
  tabs: z.record(z.string(), z.array(z.record(z.string(), z.string()))),
});

/** fixtures/sheets/*.json을 읽어 InMemorySheetClient에 바로 등록 가능한 형태로 파싱한다 (경계 zod 검증) */
export function loadFixtureFile(filePath: string): SheetFixtureFile {
  const raw = readFileSync(filePath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  return sheetFixtureFileSchema.parse(parsed);
}

interface InternalRow {
  rowIndex: number;
  values: Record<string, string>;
}

interface InternalSheet {
  notifyConfig: Record<string, string>;
  tabs: Map<string, InternalRow[]>;
}

export class InMemorySheetClient implements SheetClient {
  private readonly sheets = new Map<string, InternalSheet>();

  constructor(initial: Record<string, SheetFixture> = {}) {
    for (const [sheetId, fixture] of Object.entries(initial)) {
      this.loadSheet(sheetId, fixture);
    }
  }

  /** 시트 하나를 (재)등록한다. 이미 있으면 덮어쓴다 — 테스트 셋업/재초기화에 사용 */
  loadSheet(sheetId: string, fixture: SheetFixture): void {
    const tabs = new Map<string, InternalRow[]>();
    for (const [tab, rows] of Object.entries(fixture.tabs)) {
      // 1행은 헤더이므로 데이터 행은 2행부터 시작한다 (DESIGN §2)
      tabs.set(
        tab,
        rows.map((values, index) => ({ rowIndex: index + 2, values: { ...values } })),
      );
    }
    this.sheets.set(sheetId, { notifyConfig: { ...fixture.notifyConfig }, tabs });
  }

  private getSheet(sheetId: string): InternalSheet {
    const sheet = this.sheets.get(sheetId);
    if (!sheet) {
      throw new Error(
        `InMemorySheetClient에 sheetId '${sheetId}'가 없습니다. loadSheet(sheetId, fixture)로 먼저 등록하세요.`,
      );
    }
    return sheet;
  }

  private getTabRows(sheetId: string, tab: string): InternalRow[] {
    const rows = this.getSheet(sheetId).tabs.get(tab);
    if (!rows) {
      throw new Error(
        `InMemorySheetClient의 시트 '${sheetId}'에 탭 '${tab}'이 없습니다. fixture의 tabs에 '${tab}' 키를 추가하세요.`,
      );
    }
    return rows;
  }

  // 메모리 목이라 실제로는 동기 동작이다. `async` 키워드를 쓰면 내부에 await가 없다는 이유로
  // eslint `require-await` 규칙에 걸리므로, 순수 함수로 두고 try/catch + Promise.resolve/reject로
  // "동기 throw를 rejected promise로 바꿔주는" async의 동작을 수동으로 재현한다
  // (이 감쌈이 없으면 동기 throw가 그대로 호출부까지 예외로 전파돼 `await ...().rejects` 검증이 깨진다).
  readConfig(sheetId: string): Promise<Record<string, string>> {
    try {
      return Promise.resolve({ ...this.getSheet(sheetId).notifyConfig });
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  readRows(sheetId: string, tab: string): Promise<SheetRow[]> {
    try {
      return Promise.resolve(
        this.getTabRows(sheetId, tab).map((row) => ({
          rowIndex: row.rowIndex,
          values: { ...row.values },
        })),
      );
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // 알려진 설계상 한계: 이 목은 헤더를 행과 독립된 별도 목록으로 추적하지 않는다
  // (컬럼은 각 행 values의 key로만 존재). 그래서 빈 탭에 대해 호출하면 아무 것도 안 하고
  // 성공만 반환하며, 실제로 헤더 셀 4개가 생겼는지는 검증하지 못한다.
  // SheetClient 인터페이스 자체에 헤더 조회 메서드가 없어 이 차이는 현재 관찰 불가능하지만,
  // "빈 데이터 탭에도 헤더는 생겨야 한다"는 실제 시트 규약(DESIGN §2)을 GoogleSheetClient(T3)가
  // 지키는지는 이 목으로 검증할 수 없다는 뜻이다. T3에서 실제 헤더 처리를 구현할 때 유념할 것.
  ensureStatusColumns(sheetId: string, tab: string): Promise<void> {
    try {
      for (const row of this.getTabRows(sheetId, tab)) {
        for (const column of STATUS_COLUMNS) {
          // `in`은 프로토타입 체인도 훑으므로 오염된 Object.prototype에 속아 자기 own 필드를
          // 안 만들 수 있다. hasOwn으로 own 프로퍼티인지만 정확히 본다.
          if (!Object.hasOwn(row.values, column)) {
            row.values[column] = "";
          }
        }
      }
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  writeStatus(sheetId: string, tab: string, updates: StatusUpdate[]): Promise<void> {
    try {
      const rows = this.getTabRows(sheetId, tab);
      const byRowIndex = new Map(rows.map((row) => [row.rowIndex, row]));

      // 1단계: 전부 존재하는지 먼저 검증한다. 실제 Google Sheets batchUpdate가
      // 하나의 API 호출로 원자적으로 처리되는 것과 동일한 all-or-nothing 계약을 지키기 위함.
      // (검증과 반영을 한 루프에서 같이 하면 배치 중간의 잘못된 rowIndex 하나 때문에
      //  앞선 행들만 이미 변경된 채로 reject되는 반쪽짜리 실패가 생긴다.)
      const targets: InternalRow[] = [];
      for (const update of updates) {
        const row = byRowIndex.get(update.rowIndex);
        if (!row) {
          throw new Error(
            `writeStatus: 시트 '${sheetId}' 탭 '${tab}'에 rowIndex ${String(update.rowIndex)}가 없습니다. readRows로 먼저 실제 행 번호를 확인하세요. (이 배치는 전혀 반영되지 않았습니다)`,
          );
        }
        targets.push(row);
      }

      // 2단계: 검증 통과 후에만 실제로 반영한다.
      // sentAt/messageId/error가 결측이면 "지운다"가 아니라 "건드리지 않는다" (DESIGN §3 StatusUpdate 참고) —
      // 예를 들어 sent 후 같은 행이 skipped_duplicate로 다시 기록돼도 원래 _sent_at/_message_id는 남는다.
      // 같은 배치 안에서 rowIndex가 중복되면 배열 순서상 마지막 update가 최종 값이 된다(last-write-wins).
      updates.forEach((update, i) => {
        const row = targets[i]!;
        row.values._send_status = update.sendStatus;
        if (update.sentAt !== undefined) row.values._sent_at = update.sentAt;
        if (update.messageId !== undefined) row.values._message_id = update.messageId;
        if (update.error !== undefined) row.values._error = update.error;
      });
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
