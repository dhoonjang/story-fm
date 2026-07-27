import { NextResponse } from "next/server";
import { z } from "zod";
import {
  SKILL_CATALOG,
  SKILL_NAMES,
  resetSkillDescriptionOverrides,
  resolveSkillDescriptions,
  saveSkillDescriptionOverrides,
  type SkillDescriptions,
} from "@story-fm/agents";

export const dynamic = "force-dynamic";

const SkillDescriptionSchema = z
  .string()
  .max(10_000, "스킬 설명은 10,000자 이하여야 합니다")
  .refine((text) => text.trim().length > 0, "빈 스킬 설명은 저장할 수 없습니다");

const SkillDescriptionsSchema = z
  .record(SkillDescriptionSchema)
  .superRefine((descriptions, ctx) => {
    for (const name of SKILL_NAMES) {
      if (descriptions[name] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `스킬 설명이 없습니다: ${name}`,
          path: [name],
        });
      }
    }
  });

const SaveSkillsSchema = z.object({
  descriptions: SkillDescriptionsSchema,
});

function payload(message?: string) {
  const resolved = resolveSkillDescriptions();
  return {
    skills: SKILL_CATALOG.map((skill) => ({
      name: skill.name,
      label: skill.label,
      group: skill.group,
      readOnly: skill.readOnly,
      description: resolved.descriptions[skill.name],
    })),
    edited: resolved.edited,
    ...(message ? { message } : {}),
  };
}

/** 현재 실제로 모델에 전달되는 스킬 설명과 고정 메타데이터 조회. */
export function GET() {
  return NextResponse.json(payload());
}

/** 스킬별 자연어 설명만 저장한다. 이름·스키마·핸들러는 변경하지 않는다. */
export async function PUT(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다" }, { status: 400 });
  }
  const body = SaveSkillsSchema.safeParse(raw);
  if (!body.success) {
    return NextResponse.json(
      { error: body.error.issues[0]?.message ?? "입력 오류" },
      { status: 400 },
    );
  }
  const descriptions = Object.fromEntries(
    SKILL_NAMES.map((name) => [name, body.data.descriptions[name]]),
  ) as SkillDescriptions;
  saveSkillDescriptionOverrides(descriptions);
  return NextResponse.json(payload("스킬 설명을 저장했습니다"));
}

/** 저장된 설명 편집본을 삭제하고 코드 기본값으로 복원. */
export function DELETE() {
  resetSkillDescriptionOverrides();
  return NextResponse.json(payload("스킬 설명을 코드 기본값으로 되돌렸습니다"));
}
