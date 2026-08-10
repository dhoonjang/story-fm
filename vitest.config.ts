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
     * 기본 5초는 이 저장소엔 너무 짧다 — 새 게임 한 판(`createGame`)이 5대 리그
     * 96팀 + 2부 64팀 + 마켓 리그의 스쿼드·일정·추첨을 전부 만드느라 1초를 넘고,
     * 장기 시즌 회귀 테스트는 단독으로도 20초를 쓴다. 그래서 게임을 여러 판 만들거나
     * 여러 시즌을 도는 테스트가 병렬 실행 부하에 따라 **실행마다 다른 조합으로**
     * 걸렸다 — 단정 실패는 하나도 없었다. 단정을 느슨하게 하는 게 아니라 느린
     * 테스트에 시간을 주는 것이므로 전역으로 올린다.
     */
    testTimeout: 60_000,
  },
});
