import { describe, expect, it } from "vitest";
import { SemaphoreSmsProvider } from "../src/adapters/semaphoreSmsProvider.js";

describe("SemaphoreSmsProvider (v0.1 stub)", () => {
  it("throws an error with v0.2 guidance when constructed (SMS unsupported before Sender ID registration)", () => {
    expect(() => new SemaphoreSmsProvider()).toThrow(/Sender ID registration/);
    expect(() => new SemaphoreSmsProvider()).toThrow(/v0.2/);
  });
});
