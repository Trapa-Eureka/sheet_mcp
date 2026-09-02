import { describe, expect, it } from "vitest";
import { ConfigParseError, parseNotifyConfig } from "../src/core/config.js";

function validRaw(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    data_tab: "collections",
    id_column: "customer_id",
    recipient_column: "email",
    channel: "email",
    subject_template: "[{{shop}}] 결제 안내",
    body_template: "{{name}}님, {{amount}} 결제 기한은 {{due}}입니다.",
    ...overrides,
  };
}

describe("parseNotifyConfig", () => {
  it("parses a valid config (including filter)", () => {
    const config = parseNotifyConfig(validRaw({ filter_column: "status", filter_value: "unpaid" }));
    expect(config).toEqual({
      dataTab: "collections",
      idColumn: "customer_id",
      recipientColumn: "email",
      channel: "email",
      subjectTemplate: "[{{shop}}] 결제 안내",
      bodyTemplate: "{{name}}님, {{amount}} 결제 기한은 {{due}}입니다.",
      filterColumn: "status",
      filterValue: "unpaid",
    });
  });

  it("parses successfully when both filter_column/filter_value are absent (optional)", () => {
    const config = parseNotifyConfig(validRaw());
    expect(config.filterColumn).toBeUndefined();
    expect(config.filterValue).toBeUndefined();
  });

  it("normalizes to undefined without leaking the raw whitespace when both filter_column/filter_value are whitespace-only", () => {
    const config = parseNotifyConfig(validRaw({ filter_column: "   ", filter_value: "   " }));
    expect(config.filterColumn).toBeUndefined();
    expect(config.filterValue).toBeUndefined();
  });

  it("throws an error naming which key is missing and how to add it when a required key (recipient_column) is absent", () => {
    const raw = validRaw();
    delete raw.recipient_column;
    expect(() => parseNotifyConfig(raw)).toThrow(ConfigParseError);
    expect(() => parseNotifyConfig(raw)).toThrow(/recipient_column.*is missing/s);
    expect(() => parseNotifyConfig(raw)).toThrow(/recipient_column=<value> row/);
  });

  it("treats a required key as missing when its value is whitespace-only", () => {
    const raw = validRaw({ data_tab: "   " });
    expect(() => parseNotifyConfig(raw)).toThrow(/'data_tab' key is missing/);
  });

  it("throws an explicit error with v0.2 guidance for channel=sms", () => {
    const raw = validRaw({ channel: "sms" });
    expect(() => parseNotifyConfig(raw)).toThrow(ConfigParseError);
    expect(() => parseNotifyConfig(raw)).toThrow(
      /channel=sms in the notify_config tab is not supported in v0.1/,
    );
    expect(() => parseNotifyConfig(raw)).toThrow(/v0.2/);
  });

  it("throws an error listing the allowed values when channel is neither email nor sms", () => {
    const raw = validRaw({ channel: "kakao" });
    expect(() => parseNotifyConfig(raw)).toThrow(
      /channel value 'kakao' in the notify_config tab is not supported/,
    );
    expect(() => parseNotifyConfig(raw)).toThrow(/supports only channel=email/);
  });

  it("throws an error when filter_column is present but filter_value is missing", () => {
    const raw = validRaw({ filter_column: "status" });
    expect(() => parseNotifyConfig(raw)).toThrow(
      /filter_column and filter_value in the notify_config tab must be set together/,
    );
  });

  it("throws an error when filter_value is present but filter_column is missing", () => {
    const raw = validRaw({ filter_value: "unpaid" });
    expect(() => parseNotifyConfig(raw)).toThrow(
      /filter_column and filter_value in the notify_config tab must be set together/,
    );
  });

  it("includes an error message for every key when multiple required keys are missing at once", () => {
    const raw = validRaw();
    delete raw.data_tab;
    delete raw.body_template;
    try {
      parseNotifyConfig(raw);
      throw new Error("No error was thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigParseError);
      const message = (err as Error).message;
      expect(message).toMatch(/'data_tab' key is missing/);
      expect(message).toMatch(/'body_template' key is missing/);
    }
  });
});
