import { defineConfig } from "@playwright/test";

/**
 * e2e — mock GM 모드로 LLM 없이 전체 시나리오를 브라우저에서 검증한다.
 * 실모드(Opus) 시나리오는 스모크로 별도 수행 (ANTHROPIC_API_KEY 필요).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  retries: 1,
  use: {
    baseURL: "http://localhost:3311",
  },
  webServer: {
    command: "pnpm --filter @story-fm/web dev",
    url: "http://localhost:3311",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: "3311",
      LLM_MODE: "mock",
      STORY_FM_DATA_DIR: "/tmp/story-fm-e2e",
    },
  },
});
