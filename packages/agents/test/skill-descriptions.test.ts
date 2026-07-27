import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_SKILL_DESCRIPTIONS,
  buildGmTools,
  loadSkillDescriptionOverrides,
  makeLogMatchEventsTool,
  resetSkillDescriptionOverrides,
  resolveSkillDescriptions,
  saveSkillDescriptionOverrides,
  skillDescriptionsPath,
} from "@story-fm/agents";
import { createGame, interpretBackgroundHeuristic } from "@story-fm/engine";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "story-fm-skills-"));
  process.env.STORY_FM_DATA_DIR = dir;
});

afterEach(() => {
  resetSkillDescriptionOverrides();
  delete process.env.STORY_FM_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("스킬 설명 오버라이드", () => {
  it("저장 전에는 코드 기본값을 사용한다", () => {
    expect(loadSkillDescriptionOverrides()).toBeNull();
    expect(resolveSkillDescriptions()).toEqual({
      descriptions: DEFAULT_SKILL_DESCRIPTIONS,
      edited: false,
    });
  });

  it("스킬별 설명을 저장하고 실제 도구 description에 즉시 적용한다", () => {
    const descriptions = {
      ...DEFAULT_SKILL_DESCRIPTIONS,
      advance_time: "테스트용 시간 진행 설명",
      log_match_events: "테스트용 경기 기록 설명",
    };
    saveSkillDescriptionOverrides(descriptions);

    expect(existsSync(skillDescriptionsPath())).toBe(true);
    expect(resolveSkillDescriptions()).toEqual({ descriptions, edited: true });

    const background = "전술 분석가";
    const state = createGame({
      seed: 17,
      userTeamId: "arsenal",
      managerName: "테스트",
      background,
      attributes: interpretBackgroundHeuristic(background),
    });
    expect(buildGmTools(state, []).find((tool) => tool.name === "advance_time")?.description).toBe(
      descriptions.advance_time,
    );
    expect(makeLogMatchEventsTool(() => ({ ok: true, message: "ok" })).description).toBe(
      descriptions.log_match_events,
    );
  });

  it("초기화하거나 저장 파일이 손상되면 코드 기본값으로 폴백한다", () => {
    saveSkillDescriptionOverrides({
      ...DEFAULT_SKILL_DESCRIPTIONS,
      get_player: "편집한 선수 조회 설명",
    });
    resetSkillDescriptionOverrides();
    expect(resolveSkillDescriptions().descriptions).toEqual(DEFAULT_SKILL_DESCRIPTIONS);

    writeFileSync(skillDescriptionsPath(), "{ 깨진 JSON", "utf8");
    expect(loadSkillDescriptionOverrides()).toBeNull();
    expect(resolveSkillDescriptions().descriptions).toEqual(DEFAULT_SKILL_DESCRIPTIONS);
  });
});
