import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "apps/web"),
    },
  },
  test: {
    // 시뮬 코어(장부·패킷)는 LLM 없이 단위 테스트한다 (AGENTS.md 5장)
    // apps/web/test는 API 통합 테스트 (mock GM 모드)
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    /**
     * ⚠️ 시즌 완주형 테스트는 단독 20초·병렬 부하에서 그 몇 배를 쓴다 — 타임아웃
     * 실패는 전부 이 부류였고 단정 실패가 아니었다. 느린 테스트에 시간을 주는 것.
     */
    testTimeout: 120_000,
  },
});
