import { describe, expect, it } from "vitest";
import {
  DEFAULT_SKILL_DESCRIPTIONS,
  GM_SYSTEM,
  MATCH_INTENT_SYSTEM,
  SKILL_CATALOG,
  SKILL_NAMES,
  buildGmTools,
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
    for (const tool of buildGmTools(state, [])) {
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

/**
 * 규칙이 사는 자리 — docs/llm/prompts.md §5.
 *
 * 한 도구의 사용법은 그 도구의 설명에만 있고, 경기 중에는 그 설명이 실리지 않으므로
 * 같은 판정 근거를 `MATCH_INTENT_SYSTEM`이 따로 갖는다. 프롬프트를 옮기다 규칙이
 * 어느 쪽에서도 사라지는 것이 이 셋이 막는 것이다.
 */
describe("규칙이 사는 자리", () => {
  const JUDGEMENT_CRITERIA = ["맥락 적합성", "설득 근거", "수용성"];
  /** 사용법이 설명으로 넘어간 도구들 — 시스템 프롬프트는 이 이름을 다시 부르지 않는다. */
  const MOVED = ["team_talk", "talk_to_player", "respond_to_media", "deal_odds", "send_offer"];

  it("판정형 도구의 설명이 판정 기준 셋을 갖는다", () => {
    for (const name of ["team_talk", "talk_to_player"] as const) {
      for (const word of JUDGEMENT_CRITERIA) {
        expect(DEFAULT_SKILL_DESCRIPTIONS[name]).toContain(word);
      }
    }
  });

  it("경기 프롬프트도 같은 판정 기준 셋을 갖는다 — 경기 중 도구 표면은 0이다", () => {
    for (const word of JUDGEMENT_CRITERIA) {
      expect(MATCH_INTENT_SYSTEM).toContain(word);
    }
  });

  it("시스템 프롬프트는 넘긴 도구의 사용법을 다시 적지 않는다", () => {
    for (const name of MOVED) {
      expect(GM_SYSTEM).not.toContain(name);
    }
  });
});
