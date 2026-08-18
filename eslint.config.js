import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import next from "@next/eslint-plugin-next";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      // Next 빌드 산출물 — 기본 `.next` 외에 e2e·스크린샷용 distDir도 함께 (`.next-*`)
      "**/.next/**",
      "**/.next-*/**",
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
  /**
   * 화면에만 거는 규칙 — 훅과 Next 규약은 `apps/web` 밖에 걸 곳이 없다.
   * 코어 패키지에 얹으면 React를 쓰지 않는 파일마다 규칙을 헛돌린다.
   *
   * 훅 규칙은 **둘만** 켠다. 플러그인의 `recommended-latest`는 React Compiler
   * 규칙군(`refs`·`purity`·`immutability`·`set-state-in-effect`)까지 들여오는데,
   * 그건 렌더 중 ref 접근과 이펙트 안 setState를 잡는 규칙이라 지금 코드에서
   * 12건이 걸리고(`squad.tsx`·`game-screen.tsx`·`turn-trace.tsx`·`players-panel.tsx`)
   * 전부 컴포넌트 구조를 바꿔야 지워진다. 게이트를 넓히는 일과 화면을 다시 짜는
   * 일은 한 PR에 같이 들어갈 것이 아니다.
   */
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    extends: [next.flatConfig.coreWebVitals],
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // 경고로 두면 CI가 초록이라 아무도 읽지 않는다 — 예외는 이유를 적고 끈다
      "react-hooks/exhaustive-deps": "error",
      // App Router 앱이라 `pages/`가 없다 — 규칙이 매번 못 찾겠다고 말한다
      "@next/next/no-html-link-for-pages": "off",
    },
  },
);
