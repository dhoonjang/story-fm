import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { dataDir } from "@story-fm/engine";

/** 어드민에서 편집할 수 있는 두 역할의 고정 시스템 프롬프트. */
export interface SystemPrompts {
  gm: string;
  match: string;
}

export interface ResolvedSystemPrompts {
  prompts: SystemPrompts;
  edited: boolean;
}

const StoredSystemPromptsSchema = z.object({
  version: z.literal(1),
  gm: z.string().min(1),
  match: z.string().min(1),
});

/** 프롬프트 오버라이드 파일 — 없으면 코드에 있는 기본 상수를 사용한다. */
export function systemPromptsPath(): string {
  return path.join(dataDir(), "system-prompts.json");
}

/**
 * 저장된 오버라이드를 읽는다.
 * 파일이 없거나 손상됐으면 null을 반환해 런타임이 코드 기본값으로 안전하게 폴백한다.
 */
export function loadSystemPromptOverrides(): SystemPrompts | null {
  const file = systemPromptsPath();
  if (!existsSync(file)) return null;
  try {
    const parsed = StoredSystemPromptsSchema.safeParse(
      JSON.parse(readFileSync(file, "utf8")) as unknown,
    );
    return parsed.success ? { gm: parsed.data.gm, match: parsed.data.match } : null;
  } catch {
    return null;
  }
}

/** 코드 기본값과 저장된 오버라이드를 합쳐 현재 실제로 적용할 프롬프트를 돌려준다. */
export function resolveSystemPrompts(defaults: SystemPrompts): ResolvedSystemPrompts {
  const override = loadSystemPromptOverrides();
  if (!override) return { prompts: defaults, edited: false };
  return {
    prompts: override,
    edited: override.gm !== defaults.gm || override.match !== defaults.match,
  };
}

/** 어드민 편집 결과를 원자적으로 저장한다. */
export function saveSystemPromptOverrides(prompts: SystemPrompts): void {
  const parsed = StoredSystemPromptsSchema.parse({ version: 1, ...prompts });
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const file = systemPromptsPath();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(parsed, null, 2), "utf8");
  renameSync(tmp, file);
}

/** 오버라이드를 지워 코드 기본 프롬프트로 되돌린다. */
export function resetSystemPromptOverrides(): void {
  const file = systemPromptsPath();
  if (existsSync(file)) rmSync(file);
}
