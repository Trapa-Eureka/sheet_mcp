import { describe, expect, it } from "vitest";
import { SemaphoreSmsProvider } from "../src/adapters/semaphoreSmsProvider.js";

describe("SemaphoreSmsProvider (v0.1 스텁)", () => {
  it("생성 시 v0.2 안내가 담긴 에러를 던진다 (Sender ID 등록 전이라 SMS 미지원)", () => {
    expect(() => new SemaphoreSmsProvider()).toThrow(/Sender ID 등록/);
    expect(() => new SemaphoreSmsProvider()).toThrow(/v0.2/);
  });
});
