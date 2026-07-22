import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.next/**",
      "**/next-env.d.ts",
      "test-results/**",
      "playwright-report/**",
      ".data/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // AGENTS.md 5장: any 금지 (불가피하면 unknown + 좁히기)
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
