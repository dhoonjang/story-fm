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
  },
});
