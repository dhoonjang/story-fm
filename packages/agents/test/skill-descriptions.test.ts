import { describe, expect, it } from "vitest";
import {
  DEFAULT_SKILL_DESCRIPTIONS,
  SKILL_CATALOG,
  SKILL_NAMES,
  buildGmTools,
  buildMatchTools,
} from "@story-fm/agents";
import { createGame, interpretBackgroundHeuristic } from "@story-fm/engine";

function testGame() {
  const background = "전술 분석가";
  return createGame({
    seed: 17,
    userTeamId: "arsenal",
    managerName: "테스트",
    background,
    attributes: interpretBackgroundHeuristic(background),
  });
}

describe("스킬 설명 — 코드가 유일한 원본이다", () => {
  it("카탈로그의 설명이 그대로 도구 description이 된다", () => {
    const state = testGame();
    const gm = buildGmTools(state, []);
    const match = buildMatchTools(state, []);
    for (const tool of [...gm, ...match]) {
      const entry = SKILL_CATALOG.find((s) => s.name === tool.name);
      if (entry) expect(tool.description).toBe(entry.description);
    }
  });

  it("빈 설명을 가진 스킬은 없다", () => {
    for (const name of SKILL_NAMES) {
      expect(DEFAULT_SKILL_DESCRIPTIONS[name].trim().length).toBeGreaterThan(0);
    }
  });
});
