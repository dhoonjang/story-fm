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
  /**
   * 화면은 엔진을 **타입으로만** 가져온다 (AGENTS.md 5장).
   *
   * 값 import 하나가 `node:fs`를 브라우저 번들에 끌어와 `next build`를 죽이는데
   * 타입 검사는 통과한다 — 이 규칙이 없으면 CI e2e가 빌드에서 터질 때에야 잡히고
   * 메시지는 원인과 멀다. 그래서 `apps/web` 전체에 기본으로 걸고, 서버에서만 도는
   * 파일을 아래 블록에서 되돌린다. 새로 생긴 폴더가 규칙 밖으로 빠져나가는 쪽보다
   * 서버 전용 파일을 한 줄 늘리는 쪽이 안전하다.
   *
   * 그 서버 전용 모듈 자체도 화면에서 값으로 부르면 같은 일이 벌어진다 — 엔진을
   * 끌고 들어오기 때문이다. 그래서 두 번째 그룹으로 함께 막는다.
   */
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@story-fm/engine",
              allowTypeImports: true,
              message:
                "화면은 엔진을 타입으로만 가져온다 — 값 import는 node:fs를 브라우저 번들에 끌어와 next build를 죽인다. 화면과 코어가 함께 쓰는 순수 규칙은 packages/domain에 두고 엔진이 re-export한다 (AGENTS.md 5장). 서버에서만 도는 모듈이면 eslint.config.js의 예외 목록에 그 파일을 올려라.",
            },
          ],
          patterns: [
            {
              group: ["**/lib/store", "**/lib/turn-runner", "./store", "./turn-runner"],
              allowTypeImports: true,
              message:
                "store.ts·turn-runner.ts는 서버에서만 돈다 — 값으로 부르면 엔진이 딸려 들어와 next build가 죽는다. 화면은 타입만 가져오고, 값이 필요하면 API 라우트를 거쳐라.",
            },
          ],
        },
      ],
    },
  },
  /**
   * 서버에서만 도는 파일 — 값 import가 정당하다. 라우트 핸들러는 클라이언트가
   * import할 수 없고, `store.ts`·`turn-runner.ts`는 위 그룹이 화면 쪽에서 막는다.
   * (`test/`는 번들이 아니라 vitest가 node에서 돌리고, `next.config.ts`는 빌드 설정이다.)
   */
  {
    files: [
      "apps/web/app/api/**/*.ts",
      "apps/web/lib/store.ts",
      "apps/web/lib/turn-runner.ts",
      "apps/web/test/**/*.ts",
      "apps/web/next.config.ts",
    ],
    rules: { "@typescript-eslint/no-restricted-imports": "off" },
  },
);
