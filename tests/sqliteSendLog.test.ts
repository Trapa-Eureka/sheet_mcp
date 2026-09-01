// 임시 파일 DB로 SqliteSendLog를 검증한다 (파일 IO는 허용, 네트워크 아님 — docs/TESTING.md §1).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteSendLog } from "../src/adapters/sqliteSendLog.js";
import type { SendLogEntry } from "../src/core/types.js";

function entry(overrides: Partial<SendLogEntry> = {}): SendLogEntry {
  return {
    sheetId: "sheet-1",
    tab: "customers",
    rowKey: "CUST-001",
    templateHash: "abc123def456",
    sendStatus: "sent",
    sentAt: "2026-09-01T00:00:00.000Z",
    messageId: "msg-1",
    ...overrides,
  };
}

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sheet-mcp-sendlog-"));
  dbPath = join(tmpDir, "sendlog.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteSendLog", () => {
  it("존재하지 않는 디렉터리 경로를 줘도 자동으로 만들고 DB 파일을 생성한다", () => {
    const nestedPath = join(tmpDir, "nested", "dir", "sendlog.db");
    const log = new SqliteSendLog(nestedPath);
    try {
      expect(existsSync(nestedPath)).toBe(true);
    } finally {
      log.close();
    }
  });

  it("기록 전에는 wasSent가 false다", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      expect(log.wasSent("sheet-1", "customers", "CUST-001", "abc123def456")).toBe(false);
    } finally {
      log.close();
    }
  });

  it("record 후 같은 키로 wasSent를 물으면 true다", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      log.record(entry());
      expect(log.wasSent("sheet-1", "customers", "CUST-001", "abc123def456")).toBe(true);
    } finally {
      log.close();
    }
  });

  it("list는 해당 sheetId의 기록만, 필드 그대로 반환한다", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      log.record(entry({ sheetId: "sheet-1", rowKey: "A" }));
      log.record(entry({ sheetId: "sheet-2", rowKey: "B" }));

      const rows = log.list("sheet-1");
      expect(rows).toEqual([entry({ sheetId: "sheet-1", rowKey: "A" })]);
    } finally {
      log.close();
    }
  });

  it("messageId/error가 없는 기록도 undefined로 정확히 복원된다", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      log.record(entry({ sendStatus: "failed", messageId: undefined, error: "invalid email" }));
      const [row] = log.list("sheet-1");
      expect(row?.messageId).toBeUndefined();
      expect(row?.error).toBe("invalid email");
    } finally {
      log.close();
    }
  });

  it("같은 (sheetId, tab, rowKey, templateHash) 조합을 두 번 record하면 조용히 무시하지 않고 명시적으로 에러를 던진다", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      log.record(entry());
      expect(() => log.record(entry())).toThrow(/이미 기록되어 있습니다/);
      expect(log.list("sheet-1")).toHaveLength(1);
    } finally {
      log.close();
    }
  });

  it("templateHash가 다르면 같은 행이라도 별도 기록으로 허용한다 (템플릿 수정 후 재발송)", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      log.record(entry({ templateHash: "hash-v1" }));
      expect(() => log.record(entry({ templateHash: "hash-v2" }))).not.toThrow();
      expect(log.list("sheet-1")).toHaveLength(2);
    } finally {
      log.close();
    }
  });

  it("DB를 닫고 같은 파일 경로로 다시 열어도 기록이 유지된다 (영속성)", () => {
    const first = new SqliteSendLog(dbPath);
    first.record(entry());
    first.close();

    const second = new SqliteSendLog(dbPath);
    try {
      expect(second.wasSent("sheet-1", "customers", "CUST-001", "abc123def456")).toBe(true);
      expect(second.list("sheet-1")).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it("dbPath 생략 시 SEND_LOG_PATH 환경변수를 사용한다", () => {
    const original = process.env.SEND_LOG_PATH;
    process.env.SEND_LOG_PATH = dbPath;
    try {
      const log = new SqliteSendLog();
      try {
        log.record(entry());
        expect(existsSync(dbPath)).toBe(true);
      } finally {
        log.close();
      }
    } finally {
      if (original === undefined) delete process.env.SEND_LOG_PATH;
      else process.env.SEND_LOG_PATH = original;
    }
  });
});
