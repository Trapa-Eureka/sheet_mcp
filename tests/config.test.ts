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
  it("정상 config를 파싱한다 (필터 포함)", () => {
    const config = parseNotifyConfig(
      validRaw({ filter_column: "status", filter_value: "unpaid" }),
    );
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

  it("filter_column/filter_value가 둘 다 없으면 정상 파싱된다 (선택 항목)", () => {
    const config = parseNotifyConfig(validRaw());
    expect(config.filterColumn).toBeUndefined();
    expect(config.filterValue).toBeUndefined();
  });

  it("필수 키(recipient_column)가 없으면 어떤 키를 어떻게 추가할지 담은 에러를 던진다", () => {
    const raw = validRaw();
    delete raw.recipient_column;
    expect(() => parseNotifyConfig(raw)).toThrow(ConfigParseError);
    expect(() => parseNotifyConfig(raw)).toThrow(/recipient_column.*키가 없습니다/s);
    expect(() => parseNotifyConfig(raw)).toThrow(/recipient_column=<값> 행을 추가하세요/);
  });

  it("필수 키 값이 공백뿐이면 결측으로 취급한다", () => {
    const raw = validRaw({ data_tab: "   " });
    expect(() => parseNotifyConfig(raw)).toThrow(/'data_tab' 키가 없습니다/);
  });

  it("channel=sms는 v0.2 안내가 담긴 명시적 에러를 던진다", () => {
    const raw = validRaw({ channel: "sms" });
    expect(() => parseNotifyConfig(raw)).toThrow(ConfigParseError);
    expect(() => parseNotifyConfig(raw)).toThrow(/channel=sms는 v0.1에서 지원하지 않습니다/);
    expect(() => parseNotifyConfig(raw)).toThrow(/v0.2/);
  });

  it("channel이 email/sms가 아니면 허용값을 안내하는 에러를 던진다", () => {
    const raw = validRaw({ channel: "kakao" });
    expect(() => parseNotifyConfig(raw)).toThrow(/channel 값 'kakao'은 지원하지 않습니다/);
    expect(() => parseNotifyConfig(raw)).toThrow(/channel=email만 허용/);
  });

  it("filter_column만 있고 filter_value가 없으면 에러를 던진다", () => {
    const raw = validRaw({ filter_column: "status" });
    expect(() => parseNotifyConfig(raw)).toThrow(/filter_column과 filter_value는 함께 설정/);
  });

  it("filter_value만 있고 filter_column이 없으면 에러를 던진다", () => {
    const raw = validRaw({ filter_value: "unpaid" });
    expect(() => parseNotifyConfig(raw)).toThrow(/filter_column과 filter_value는 함께 설정/);
  });

  it("여러 필수 키가 동시에 없으면 각 키에 대한 에러 메시지를 모두 포함한다", () => {
    const raw = validRaw();
    delete raw.data_tab;
    delete raw.body_template;
    try {
      parseNotifyConfig(raw);
      throw new Error("에러가 던져지지 않음");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigParseError);
      const message = (err as Error).message;
      expect(message).toMatch(/'data_tab' 키가 없습니다/);
      expect(message).toMatch(/'body_template' 키가 없습니다/);
    }
  });
});
