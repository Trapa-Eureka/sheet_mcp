import { describe, expect, it } from "vitest";

// T0 더미 테스트 — 스캐폴딩(typecheck/lint/test 파이프라인)이 동작함을 확인한다.
// 실제 도메인 테스트는 T1부터 tests/config.test.ts 등으로 추가된다.
describe("scaffolding", () => {
  it("test runner가 동작한다", () => {
    expect(1 + 1).toBe(2);
  });
});
