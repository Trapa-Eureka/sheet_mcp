// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "data/**", "coverage/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // 테스트에서 `expect(obj.method).toHaveBeenCalledWith(...)`, `vi.mocked(obj.method)`처럼
    // mock 메서드를 값으로 참조하는 건 vitest/jest의 표준 패턴이고 this 바인딩 위험이 없다.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/unbound-method": "off",
    },
  },
  eslintConfigPrettier,
);
