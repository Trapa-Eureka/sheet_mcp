import { describe, expect, it } from "vitest";

// T0 dummy test — confirms the scaffolding (typecheck/lint/test pipeline) works.
// Real domain tests are added starting at T1, in files like tests/config.test.ts.
describe("scaffolding", () => {
  it("the test runner works", () => {
    expect(1 + 1).toBe(2);
  });
});
