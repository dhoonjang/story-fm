import { NextResponse } from "next/server";
import { z } from "zod";
import {
  GM_SYSTEM,
  MATCH_CASTER_SYSTEM,
  resolveSystemPrompts,
  resetSystemPromptOverrides,
  saveSystemPromptOverrides,
  type SystemPrompts,
} from "@story-fm/agents";

export const dynamic = "force-dynamic";

const PromptTextSchema = z
  .string()
  .max(50_000, "프롬프트는 50,000자 이하여야 합니다")
  .refine((text) => text.trim().length > 0, "빈 프롬프트는 저장할 수 없습니다");

const SystemPromptsSchema = z.object({
  gm: PromptTextSchema,
  match: PromptTextSchema,
});

const defaults: SystemPrompts = {
  gm: GM_SYSTEM,
  match: MATCH_CASTER_SYSTEM,
};

function payload(message?: string) {
  const resolved = resolveSystemPrompts(defaults);
  return {
    prompts: resolved.prompts,
    edited: resolved.edited,
    ...(message ? { message } : {}),
  };
}

/** 현재 적용되는 GM·경기 시스템 프롬프트 조회. */
export function GET() {
  return NextResponse.json(payload());
}

/** 두 시스템 프롬프트를 함께 저장 — 다음 실모드 턴부터 전 게임에 적용된다. */
export async function PUT(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다" }, { status: 400 });
  }
  const body = SystemPromptsSchema.safeParse(raw);
  if (!body.success) {
    return NextResponse.json(
      { error: body.error.issues[0]?.message ?? "입력 오류" },
      { status: 400 },
    );
  }
  saveSystemPromptOverrides(body.data);
  return NextResponse.json(payload("기본 프롬프트를 저장했습니다"));
}

/** 저장된 오버라이드를 삭제하고 코드 기본값으로 복원. */
export function DELETE() {
  resetSystemPromptOverrides();
  return NextResponse.json(payload("기본 프롬프트를 코드 기본값으로 되돌렸습니다"));
}
