import { defineConfig } from "vitest/config";

/**
 * 밸런스 하네스 전용 — `pnpm balance`가 쓴다 (→ `docs/simulation/balance-harness.md`).
 *
 * ⚠️ 이 설정의 `include`와 `vitest.config.ts`의 것은 **겹치지 않는다.** 하네스가
 * 테스트 디렉터리 아래로 들어가는 순간 `pnpm test`가 다시 걷고, 그러면 케이스를
 * 건너뛰어도 파일당 모듈 그래프 값(2.2초)을 CI가 계속 낸다 (AGENTS.md 5장).
 */
export default defineConfig({
  test: {
    include: ["packages/*/harness/**/*.harness.ts"],
    // 한 케이스가 세계 하나로 한 시즌을 돈다 — 분 단위가 정상이다
    testTimeout: 900_000,
    hookTimeout: 900_000,
    reporters: ["verbose"],
  },
});
