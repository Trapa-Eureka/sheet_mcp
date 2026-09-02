// read_rows MCP 도구(DESIGN §5) 지원 로직 — notify_config를 적용한 발송 대상 행을 미리보기
// 개수만큼 반환한다. core/이므로 SheetClient 인터페이스만 알고 외부 IO를 모른다.
// 태스크: docs/TASKS.md T8.

import { parseNotifyConfig } from "./config.js";
import { applyFilter } from "./pipeline.js";
import type { SheetClient, SheetRow } from "./types.js";

/** DESIGN §5: read_rows는 "최대 200행 미리보기" */
export const READ_ROWS_PREVIEW_LIMIT = 200;

export interface ReadTargetRowsResult {
  rows: SheetRow[];
  /** filter_column/filter_value 적용 후 실제로 매칭된 전체 행 수 (rows.length보다 클 수 있음) */
  totalMatched: number;
  /** totalMatched가 미리보기 한도를 넘어 잘렸는지 */
  truncated: boolean;
}

/**
 * notify_config를 읽어 검증하고, 데이터 탭을 읽어 filter_column/filter_value를 적용한 뒤
 * 최대 READ_ROWS_PREVIEW_LIMIT행만 반환한다. config 검증 실패 시 ConfigParseError가 그대로 전파된다.
 */
export async function readTargetRows(
  sheetClient: SheetClient,
  sheetId: string,
): Promise<ReadTargetRowsResult> {
  const rawConfig = await sheetClient.readConfig(sheetId);
  const config = parseNotifyConfig(rawConfig);
  const allRows = await sheetClient.readRows(sheetId, config.dataTab);
  const filtered = applyFilter(allRows, config.filterColumn, config.filterValue);

  return {
    rows: filtered.slice(0, READ_ROWS_PREVIEW_LIMIT),
    totalMatched: filtered.length,
    truncated: filtered.length > READ_ROWS_PREVIEW_LIMIT,
  };
}
