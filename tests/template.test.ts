import { describe, expect, it } from "vitest";
import { renderTemplate } from "../src/core/template.js";

describe("renderTemplate", () => {
  it("substitutes multiple keys correctly", () => {
    const result = renderTemplate("{{name}}님, {{amount}} 결제 기한은 {{due}}입니다.", {
      name: "Juan",
      amount: "₱1,200.00",
      due: "2026-09-15",
    });
    expect(result).toEqual({
      text: "Juan님, ₱1,200.00 결제 기한은 2026-09-15입니다.",
      missing: [],
    });
  });

  it("returns plain text with no placeholders unchanged", () => {
    const result = renderTemplate("안내 메시지입니다.", {});
    expect(result).toEqual({ text: "안내 메시지입니다.", missing: [] });
  });

  it("leaves the original placeholder and adds it to missing when a value is missing (key absent from record)", () => {
    const result = renderTemplate("{{name}}님, {{amount}}을 확인하세요.", { name: "Juan" });
    expect(result).toEqual({
      text: "Juan님, {{amount}}을 확인하세요.",
      missing: ["amount"],
    });
  });

  it("adds all missing keys to missing in order of appearance when several are missing", () => {
    const result = renderTemplate("{{a}} {{b}} {{c}}", { b: "B" });
    expect(result).toEqual({ text: "{{a}} B {{c}}", missing: ["a", "c"] });
  });

  it("adds a missing key to missing only once even if it appears multiple times in the template", () => {
    const result = renderTemplate("{{x}} 그리고 {{x}}", {});
    expect(result.text).toBe("{{x}} 그리고 {{x}}");
    expect(result.missing).toEqual(["x"]);
  });

  it("an empty string value is not missing — it is substituted as an empty string and not added to missing", () => {
    const result = renderTemplate("메모: [{{note}}]", { note: "" });
    expect(result).toEqual({ text: "메모: []", missing: [] });
  });

  it("allows whitespace inside braces ({{ name }})", () => {
    const result = renderTemplate("{{ name }}님 안녕하세요.", { name: "Maria" });
    expect(result).toEqual({ text: "Maria님 안녕하세요.", missing: [] });
  });

  it("recognizes and substitutes sheet header names as keys even when they mix Korean/Tagalog/spaces/hyphens (AR-006)", () => {
    const result = renderTemplate("{{고객명}} / {{customer-name}} / {{shop name}}", {
      고객명: "홍길동",
      "customer-name": "A",
      "shop name": "ABC Trading",
    });
    expect(result).toEqual({
      text: "홍길동 / A / ABC Trading",
      missing: [],
    });
  });

  it("correctly catches non-ASCII/special-character keys in missing even when they are missing (AR-006)", () => {
    const result = renderTemplate("{{고객명}}님, {{customer-name}} 확인", { 고객명: "홍길동" });
    expect(result).toEqual({
      text: "홍길동님, {{customer-name}} 확인",
      missing: ["customer-name"],
    });
  });

  it("does not recognize malformed forms (unmatched braces) as placeholders and leaves them as-is", () => {
    const result = renderTemplate("{name}} 그리고 {{amount}", { name: "x", amount: "y" });
    expect(result).toEqual({ text: "{name}} 그리고 {{amount}", missing: [] });
  });

  it("inserts replacement values verbatim even when they contain replace special patterns like $&, $1, $$ (no escaping needed)", () => {
    const result = renderTemplate("금액: {{amount}}", { amount: "$1 (was $&, now $$)" });
    expect(result).toEqual({
      text: "금액: $1 (was $&, now $$)",
      missing: [],
    });
  });

  it("merges values mixing Tagalog and Korean without corruption", () => {
    const result = renderTemplate("{{name}} po, {{note}}", {
      name: "Juan Dela Cruz",
      note: "паalala: bayaran bago ang 마감일.",
    });
    expect(result.text).toBe("Juan Dela Cruz po, паalala: bayaran bago ang 마감일.");
    expect(result.missing).toEqual([]);
  });

  it("substitutes every occurrence identically when the same key appears multiple times and has a value", () => {
    const result = renderTemplate("{{shop}} - {{shop}} 안내", { shop: "ABC Trading" });
    expect(result).toEqual({ text: "ABC Trading - ABC Trading 안내", missing: [] });
  });
});
