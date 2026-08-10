import { defineConfig } from "@playwright/test";

/**
 * e2e — mock GM 모드로 LLM 없이 전체 시나리오를 브라우저에서 검증한다.
 * 실모드(Opus) 시나리오는 스모크로 별도 수행 (ANTHROPIC_API_KEY 필요).
 *
 * 포트 3399는 e2e 전용 — 개발용 플레이 서버(3311, 실모드일 수 있음)를
 * reuseExistingServer가 재사용해 mock 기대가 깨지는 사고를 방지한다.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  retries: 1,
  use: {
    baseURL: "http://localhost:3399",
  },
  webServer: {
    command: "pnpm --filter @story-fm/web dev",
    url: "http://localhost:3399",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: "3399",
      LLM_MODE: "mock",
      STORY_FM_DATA_DIR: "/tmp/story-fm-e2e",
      // 개발 서버(.next)와 빌드 산출물을 나눠 쓴다 — 공유하면 재컴파일 때
      // 서로의 청크를 지워 테스트가 무작위로 깨진다
      NEXT_DIST_DIR: ".next-e2e",
    },
  },
});
