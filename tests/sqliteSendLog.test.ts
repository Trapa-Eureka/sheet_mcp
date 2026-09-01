// 임시 파일 DB로 SqliteSendLog를 검증한다 (파일 IO는 허용, 네트워크 아님 — docs/TESTING.md §1).
// claim/commit/release + 소유권 토큰 + 만료 기반 수동 복구 + cursor 페이지네이션 배경:
// docs/ADVERSARIAL_REVIEW_003.md AR-011/AR-013/AR-015,
// docs/ADVERSARIAL_REVIEW_003_RESOLUTION_GAPS.md GAP-001/002/003/006.
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

/** claim() + commit()을 한 번에 — "이미 확정 발송된 행 하나"를 빠르게 만든다. */
function commitOne(log: SqliteSendLog, sheetId: string, rowKey: string, sentAt: string): void {
  const { token } = log.claim(sheetId, TAB, rowKey, HASH, sentAt);
  log.commit(sheetId, TAB, rowKey, HASH, token!, sentAt, undefined);
}

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

  it("claim은 처음엔 claimed=true+token, 같은 키로 다시 claim하면 claimed=false다(AR-011)", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      const first = log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
      expect(first.claimed).toBe(true);
      expect(first.token).toBeTruthy();

      const second = log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
      expect(second.claimed).toBe(false);
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

  it(
    "GAP-001: claim 후 프로세스가 죽은 것처럼 commit/release를 전혀 안 부르면 " +
      "list()에 sendStatus='claimed'로(sent로 둔갑하지 않고) 보인다",
    () => {
      const log = new SqliteSendLog(dbPath);
      try {
        log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);

        const { entries } = log.list(SHEET);
        expect(entries).toHaveLength(1);
        expect(entries[0]?.sendStatus).toBe("claimed");
        expect(entries[0]?.messageId).toBeUndefined();
      } finally {
        log.close();
      }
    },
  );

  it("commit 후에는 list에 sendStatus='sent'+messageId가 반영된 최종 기록이 남는다", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      const { token } = log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
      log.commit(SHEET, TAB, "CUST-001", HASH, token!, "2026-09-01T00:00:05.000Z", "msg-1");

      const { entries } = log.list(SHEET);
      expect(entries[0]).toEqual({
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

  it("claim 없이 commit하면 명시적으로 에러를 던진다", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      expect(() =>
        log.commit(SHEET, TAB, "CUST-001", HASH, "no-such-token", CLAIMED_AT, "msg-1"),
      ).toThrow(/claim되지 않았거나 token이 일치하지 않/);
    } finally {
      log.close();
    }
  });

  it("token이 일치하지 않으면 commit이 거부된다(GAP-001)", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
      expect(() =>
        log.commit(SHEET, TAB, "CUST-001", HASH, "wrong-token", CLAIMED_AT, "msg-1"),
      ).toThrow(/claim되지 않았거나 token이 일치하지 않/);
    } finally {
      log.close();
    }
  });

  it("release(올바른 token) 후에는 wasSent가 다시 false가 되고, 같은 키로 재claim할 수 있다", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      const { token } = log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
      log.release(SHEET, TAB, "CUST-001", HASH, token!);

      expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(false);
      expect(log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT).claimed).toBe(true);
    } finally {
      log.close();
    }
  });

  it("release(잘못된 token)는 조용히 무시하고 기존 claim을 지우지 않는다(GAP-001)", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
      expect(() => log.release(SHEET, TAB, "CUST-001", HASH, "wrong-token")).not.toThrow();
      expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(true);
    } finally {
      log.close();
    }
  });

  it(
    "GAP-009(재검증 중 발견): token이 맞아도 이미 commit된(sent) 기록은 release()로 지워지지 " +
      "않는다 — 확정 발송 기록이 사라져 재발송 가능해지는 사고를 막는다",
    () => {
      const log = new SqliteSendLog(dbPath);
      try {
        const { token } = log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
        log.commit(SHEET, TAB, "CUST-001", HASH, token!, CLAIMED_AT, "msg-1");

        expect(() => log.release(SHEET, TAB, "CUST-001", HASH, token!)).not.toThrow();

        expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(true);
        const { entries } = log.list(SHEET);
        expect(entries[0]?.sendStatus).toBe("sent");
        expect(entries[0]?.messageId).toBe("msg-1");
      } finally {
        log.close();
      }
    },
  );

  it(
    "GAP-009(재검증 중 발견): 같은 token으로 commit()을 두 번 부르면 두 번째는 에러 — " +
      "claimed→sent 전이는 한 번만 일어나야 한다",
    () => {
      const log = new SqliteSendLog(dbPath);
      try {
        const { token } = log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT);
        log.commit(SHEET, TAB, "CUST-001", HASH, token!, CLAIMED_AT, "msg-1");

        expect(() => log.commit(SHEET, TAB, "CUST-001", HASH, token!, CLAIMED_AT, "msg-2")).toThrow(
          /claim되지 않았거나 token이 일치하지 않거나 이미 commit된/,
        );
        expect(log.list(SHEET).entries[0]?.messageId).toBe("msg-1");
      } finally {
        log.close();
      }
    },
  );

  describe("forceReleaseStaleClaim (GAP-001 수동 복구)", () => {
    it("아직 만료 기준보다 젊은 claim은 회수하지 않는다", () => {
      const log = new SqliteSendLog(dbPath);
      try {
        const recentClaimedAt = new Date(Date.now() - 1000).toISOString();
        log.claim(SHEET, TAB, "CUST-001", HASH, recentClaimedAt);

        expect(log.forceReleaseStaleClaim(SHEET, TAB, "CUST-001", HASH, 60 * 60 * 1000)).toBe(
          false,
        );
        expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(true);
      } finally {
        log.close();
      }
    });

    it("만료 기준보다 오래된(commit 안 된) claim은 회수하고 재claim을 허용한다", () => {
      const log = new SqliteSendLog(dbPath);
      try {
        const oldClaimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        log.claim(SHEET, TAB, "CUST-001", HASH, oldClaimedAt);

        expect(log.forceReleaseStaleClaim(SHEET, TAB, "CUST-001", HASH, 60 * 60 * 1000)).toBe(true);
        expect(log.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(false);
        expect(log.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT).claimed).toBe(true);
      } finally {
        log.close();
      }
    });

    it("이미 commit된(sent) claim은 아무리 오래됐어도 회수하지 않는다", () => {
      const log = new SqliteSendLog(dbPath);
      try {
        const oldClaimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        const { token } = log.claim(SHEET, TAB, "CUST-001", HASH, oldClaimedAt);
        log.commit(SHEET, TAB, "CUST-001", HASH, token!, oldClaimedAt, "msg-1");

        expect(log.forceReleaseStaleClaim(SHEET, TAB, "CUST-001", HASH, 60 * 60 * 1000)).toBe(
          false,
        );
        expect(log.list(SHEET).entries[0]?.sendStatus).toBe("sent");
      } finally {
        log.close();
      }
    });
  });

  it("templateHash가 다르면 같은 행이라도 별도 claim으로 허용한다 (템플릿 수정 후 재발송)", () => {
    const log = new SqliteSendLog(dbPath);
    try {
      expect(log.claim(SHEET, TAB, "CUST-001", "hash-v1", CLAIMED_AT).claimed).toBe(true);
      expect(log.claim(SHEET, TAB, "CUST-001", "hash-v2", CLAIMED_AT).claimed).toBe(true);
      expect(log.list(SHEET).entries).toHaveLength(2);
    } finally {
      log.close();
    }
  });

  describe("list — 최신순 + cursor 페이지네이션 (GAP-006)", () => {
    it("199/200/201건 경계에서 hasMore가 정확하다(근사치 아님)", () => {
      const log = new SqliteSendLog(dbPath);
      try {
        for (let i = 0; i < 199; i += 1) commitOne(log, SHEET, `R-${String(i)}`, `t${String(i)}`);
        expect(log.list(SHEET, { limit: 200 }).hasMore).toBe(false);
      } finally {
        log.close();
      }

      const dbPath200 = join(tmpDir, "sendlog-200.db");
      const log200 = new SqliteSendLog(dbPath200);
      try {
        for (let i = 0; i < 200; i += 1)
          commitOne(log200, SHEET, `R-${String(i)}`, `t${String(i)}`);
        const result = log200.list(SHEET, { limit: 200 });
        expect(result.hasMore).toBe(false);
        expect(result.entries).toHaveLength(200);
      } finally {
        log200.close();
      }

      const dbPath201 = join(tmpDir, "sendlog-201.db");
      const log201 = new SqliteSendLog(dbPath201);
      try {
        for (let i = 0; i < 201; i += 1)
          commitOne(log201, SHEET, `R-${String(i)}`, `t${String(i)}`);
        const result = log201.list(SHEET, { limit: 200 });
        expect(result.hasMore).toBe(true);
        expect(result.entries).toHaveLength(200);
        expect(result.nextCursor).toBeTruthy();
      } finally {
        log201.close();
      }
    });

    it("nextCursor로 두 페이지 이상을 중복·누락 없이 순회할 수 있다", () => {
      const log = new SqliteSendLog(dbPath);
      try {
        for (let i = 0; i < 5; i += 1) commitOne(log, SHEET, `R-${String(i)}`, `t${String(i)}`);

        const page1 = log.list(SHEET, { limit: 2 });
        expect(page1.entries.map((r) => r.rowKey)).toEqual(["R-4", "R-3"]);
        expect(page1.hasMore).toBe(true);

        const page2 = log.list(SHEET, { limit: 2, cursor: page1.nextCursor });
        expect(page2.entries.map((r) => r.rowKey)).toEqual(["R-2", "R-1"]);

        const page3 = log.list(SHEET, { limit: 2, cursor: page2.nextCursor });
        expect(page3.entries.map((r) => r.rowKey)).toEqual(["R-0"]);
        expect(page3.hasMore).toBe(false);

        const all = [...page1.entries, ...page2.entries, ...page3.entries].map((r) => r.rowKey);
        expect(all).toEqual(["R-4", "R-3", "R-2", "R-1", "R-0"]);
      } finally {
        log.close();
      }
    });

    it("잘못된 cursor 값은 명시적으로 에러를 던진다", () => {
      const log = new SqliteSendLog(dbPath);
      try {
        expect(() => log.list(SHEET, { cursor: "not-a-number" })).toThrow(
          /cursor 값이 올바르지 않습니다/,
        );
      } finally {
        log.close();
      }
    });

    it(
      "재검증 중 발견: limit이 음수여도 SQLite의 'LIMIT -1=무제한' 의미로 새지 않고 " +
        "최소 1건으로 취급한다",
      () => {
        const log = new SqliteSendLog(dbPath);
        try {
          for (let i = 0; i < 5; i += 1) commitOne(log, SHEET, `R-${String(i)}`, `t${String(i)}`);
          expect(log.list(SHEET, { limit: -1 }).entries).toHaveLength(1);
        } finally {
          log.close();
        }
      },
    );
  });

  it("DB를 닫고 같은 파일 경로로 다시 열어도 기록이 유지된다 (영속성)", () => {
    const first = new SqliteSendLog(dbPath);
    commitOne(first, SHEET, "CUST-001", CLAIMED_AT);
    first.close();

    const second = new SqliteSendLog(dbPath);
    try {
      expect(second.wasSent(SHEET, TAB, "CUST-001", HASH)).toBe(true);
      expect(second.list(SHEET).entries).toHaveLength(1);
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
        expect(first.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT).claimed).toBe(true);
        // second는 별도 인스턴스(별도 프로세스를 흉내)지만 같은 파일의 UNIQUE 제약을 공유하므로
        // 똑같은 키를 claim하려 하면 반드시 실패해야 한다.
        expect(second.claim(SHEET, TAB, "CUST-001", HASH, CLAIMED_AT).claimed).toBe(false);
      } finally {
        first.close();
        second.close();
      }
    },
  );

  it("close()는 멱등이다 — 두 번 불러도 에러 없음(GAP-008)", () => {
    const log = new SqliteSendLog(dbPath);
    log.close();
    expect(() => log.close()).not.toThrow();
  });

  it(
    "같은 파일을 반복해서 열고 닫아도 자원이 누적되지 않는다(GAP-008 — 장수 프로세스에서 " +
      "SendLog를 반복 생성·종료하는 상황을 흉내낸 회귀 가드)",
    () => {
      for (let i = 0; i < 50; i += 1) {
        const log = new SqliteSendLog(dbPath);
        const { token } = log.claim(SHEET, TAB, `R-${String(i)}`, HASH, CLAIMED_AT);
        log.commit(SHEET, TAB, `R-${String(i)}`, HASH, token!, CLAIMED_AT, undefined);
        log.close();
      }

      // 50번 반복 후에도 파일이 정상 열리고 모든 기록이 남아 있어야 한다(fd 고갈/손상 없음).
      const verify = new SqliteSendLog(dbPath);
      try {
        expect(verify.list(SHEET, { limit: 100 }).entries).toHaveLength(50);
      } finally {
        verify.close();
      }
    },
  );
});
