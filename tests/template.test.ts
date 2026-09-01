import { describe, expect, it } from "vitest";
import { renderTemplate } from "../src/core/template.js";

describe("renderTemplate", () => {
  it("여러 키를 정상 치환한다", () => {
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

  it("플레이스홀더가 없는 일반 텍스트는 그대로 반환한다", () => {
    const result = renderTemplate("안내 메시지입니다.", {});
    expect(result).toEqual({ text: "안내 메시지입니다.", missing: [] });
  });

  it("값이 결측(record에 키 없음)이면 원본 플레이스홀더를 남기고 missing에 담는다", () => {
    const result = renderTemplate("{{name}}님, {{amount}}을 확인하세요.", { name: "Juan" });
    expect(result).toEqual({
      text: "Juan님, {{amount}}을 확인하세요.",
      missing: ["amount"],
    });
  });

  it("여러 키가 결측이면 등장 순서대로 missing에 전부 담는다", () => {
    const result = renderTemplate("{{a}} {{b}} {{c}}", { b: "B" });
    expect(result).toEqual({ text: "{{a}} B {{c}}", missing: ["a", "c"] });
  });

  it("같은 결측 키가 템플릿에 여러 번 나오면 missing에는 한 번만 담긴다", () => {
    const result = renderTemplate("{{x}} 그리고 {{x}}", {});
    expect(result.text).toBe("{{x}} 그리고 {{x}}");
    expect(result.missing).toEqual(["x"]);
  });

  it("값이 빈 문자열이면 결측이 아니다 — 빈 문자열로 치환되고 missing에 안 들어간다", () => {
    const result = renderTemplate("메모: [{{note}}]", { note: "" });
    expect(result).toEqual({ text: "메모: []", missing: [] });
  });

  it("중괄호 안 공백을 허용한다 ({{ name }})", () => {
    const result = renderTemplate("{{ name }}님 안녕하세요.", { name: "Maria" });
    expect(result).toEqual({ text: "Maria님 안녕하세요.", missing: [] });
  });

  it("잘못된 형태(중괄호 짝 안 맞음)는 플레이스홀더로 인식하지 않고 그대로 둔다", () => {
    const result = renderTemplate("{name}} 그리고 {{amount}", { name: "x", amount: "y" });
    expect(result).toEqual({ text: "{name}} 그리고 {{amount}", missing: [] });
  });

  it("치환값에 $&, $1, $$ 같은 replace 특수 패턴이 있어도 그대로 삽입된다 (이스케이프 불필요)", () => {
    const result = renderTemplate("금액: {{amount}}", { amount: "$1 (was $&, now $$)" });
    expect(result).toEqual({
      text: "금액: $1 (was $&, now $$)",
      missing: [],
    });
  });

  it("타갈로그·한글이 섞인 값도 깨지지 않고 그대로 머지된다", () => {
    const result = renderTemplate("{{name}} po, {{note}}", {
      name: "Juan Dela Cruz",
      note: "паalala: bayaran bago ang 마감일.",
    });
    expect(result.text).toBe("Juan Dela Cruz po, паalala: bayaran bago ang 마감일.");
    expect(result.missing).toEqual([]);
  });

  it("같은 키가 여러 번 등장하고 값이 있으면 전부 동일하게 치환된다", () => {
    const result = renderTemplate("{{shop}} - {{shop}} 안내", { shop: "ABC Trading" });
    expect(result).toEqual({ text: "ABC Trading - ABC Trading 안내", missing: [] });
  });
});
