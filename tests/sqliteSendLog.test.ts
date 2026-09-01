// 임시 파일 DB로 SqliteSendLog를 검증한다 (파일 IO는 허용, 네트워크 아님 — docs/TESTING.md §1).
// claim/commit/release 재설계 배경: docs/ADVERSARIAL_REVIEW_003.md AR-011/AR-013/AR-015.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteSendLog } from "../src/adapters/sqliteSendLog.js";

const SHEET = "sheet-1";
const TAB = "customers";
const HASH = "abc123def456";
const CLAIMED_AT = "2026-09-01T00:00:00.000Z";

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

  it("claim 전에는 wasSent가 false다", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(false);
    } finally {
      log.close();
    }
  });

  it("claim은 처음엔 true, 같은 키로 다시 claim하면 false다(AR-011)", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      expect(log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT)).toBe(true);
      expect(log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT)).toBe(false);
    } finally {
      log.close();
    }
  });

  it("claim 직후(commit 전)에도 wasSent는 true다", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
      expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(true);
    } finally {
      log.close();
    }
  });

  it("commit 후 list에 messageId까지 반영된 최종 기록이 남는다", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
      log.commit(SHEET, TAB, "CUST-001", HASH, "2026-09-01T00:00:05.000Z", "msg-1");

      const [row] = log.list(SHEET);
      expect(row).toEqual({
        sheetId: SHEET,
        tab: TAB,
        rowKey: "CUST-001",
        templateHash: HASH,
        sendStatus: "sent",
        sentAt: "2026-09-01T00:00:05.000Z",
        messageId: "msg-1",
      });
    } finally {
      log.close();
    }
  });

  it("messageId 없이 commit해도 undefined로 정확히 복원된다", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
      log.commit(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT, undefined);
      const [row] = log.list(SHEET);
      expect(row?.messageId).toBeUndefined();
    } finally {
      log.close();
    }
  });

  it("claim 없이 commit하면 명시적으로 에러를 던진다", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      expect(() => log.commit(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT, "msg-1")).toThrow(
        /claim되지 않은/,
      );
    } finally {
      log.close();
    }
  });

  it("release 후에는 wasSent가 다시 false가 되고, 같은 키로 재claim할 수 있다(재시도 허용)", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
      log.release(SHEET, TAB, "CUST-001", HASH);

      expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(false);
      expect(log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT)).toBe(true);
    } finally {
      log.close();
    }
  });

  it("templateHash가 다르면 같은 행이라도 별도 claim으로 허용한다 (템플릿 수정 후 재발송)", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      expect(log.claim(SHEET, TAB, "CUST-001", "hash-v1", CLAIMED_AT)).toBe(true);
      expect(log.claim(SHEET, TAB, "CUST-001", "hash-v2", CLAIMED_AT)).toBe(true);
      expect(log.list(SHEET)).toHaveLength(2);
    } finally {
      log.close();
    }
  });

  it("list는 최신순으로 반환하고 limit을 넘으면 잘라낸다(AR-015)", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      for (let i = 0; i < 5; i += 1) {
        const rowKey = `R-${String(i)}`;
        log.claim(SHEET, TAB, rowKey, HASH, `t${String(i)}`);
      }
      expect(log.list(SHEET).map((r) => r.rowKey)).toEqual(["R-4", "R-3", "R-2", "R-1", "R-0"]);
      expect(log.list(SHEET, { limit: 2 }).map((r) => r.rowKey)).toEqual(["R-4", "R-3"]);
    } finally {
      log.close();
    }
  });

  it("DB를 닫고 같은 파일 경로로 다시 열어도 기록이 유지된다 (영속성)", () => {
    const first = new SqliteSendLog(dbPath);
    first.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
    first.commit(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT, "msg-1");
    first.close();

    const second = new SqliteSendLog(dbPath);
    try {
      expect(second.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(true);
      expect(second.list(SHEET)).toHaveLength(1);
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
        log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
        expect(existsSync(dbPath)).toBe(true);
      } finally {
        log.close();
      }
    } finally {
      if (original === undefined) delete process.env.SEND_LOG_PATH;
      else process.env.SEND_LOG_PATH = original;
    }
  });

  it(
    "같은 DB 파일을 보는 별도 SqliteSendLog 인스턴스끼리도 claim이 서로를 막는다 " +
      "(AR-011 — 서로 다른 프로세스가 같은 파일을 열었을 때의 동시 실행을 흉내낸 시나리오)",
    () => {
      const first = new SqliteSendLog(dbPath);
      const second = new SqliteSendLog(dbPath);
      try {
        expect(first.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT)).toBe(true);
        // second는 별도 인스턴스(별도 프로세스를 흉내)지만 같은 파일의 UNIQUE 제약을 공유하므로
        // 똑같은 키를 claim하려 하면 반드시 실패해야 한다.
        expect(second.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT)).toBe(false);
      } finally {
        first.close();
        second.close();
      }
    },
  );
});
