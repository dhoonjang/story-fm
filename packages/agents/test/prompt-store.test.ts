import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadSystemPromptOverrides,
  resetSystemPromptOverrides,
  resolveSystemPrompts,
  saveSystemPromptOverrides,
  systemPromptsPath,
} from "@story-fm/agents";

let dir: string;
const defaults = {
  gm: "기본 GM 프롬프트",
  match: "기본 경기 프롬프트",
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "story-fm-prompts-"));
  process.env.STORY_FM_DATA_DIR = dir;
});

afterEach(() => {
  resetSystemPromptOverrides();
  delete process.env.STORY_FM_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("시스템 프롬프트 오버라이드", () => {
  it("저장 전에는 코드 기본값을 사용한다", () => {
    expect(loadSystemPromptOverrides()).toBeNull();
    expect(resolveSystemPrompts(defaults)).toEqual({
      prompts: defaults,
      edited: false,
    });
  });

  it("두 프롬프트를 원자적으로 저장하고 즉시 다시 읽는다", () => {
    const prompts = {
      gm: "어드민에서 편집한 GM 프롬프트",
      match: "어드민에서 편집한 경기 프롬프트",
    };
    saveSystemPromptOverrides(prompts);

    expect(existsSync(systemPromptsPath())).toBe(true);
    expect(loadSystemPromptOverrides()).toEqual(prompts);
    expect(resolveSystemPrompts(defaults)).toEqual({
      prompts,
      edited: true,
    });
  });

  it("초기화하거나 저장 파일이 손상되면 코드 기본값으로 폴백한다", () => {
    saveSystemPromptOverrides({ gm: "편집 GM", match: "편집 경기" });
    resetSystemPromptOverrides();
    expect(resolveSystemPrompts(defaults).prompts).toEqual(defaults);

    writeFileSync(systemPromptsPath(), "{ 깨진 JSON", "utf8");
    expect(loadSystemPromptOverrides()).toBeNull();
    expect(resolveSystemPrompts(defaults).prompts).toEqual(defaults);
  });
});
