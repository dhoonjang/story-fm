import { NextResponse } from "next/server";
import { z } from "zod";
import { FormationSchema } from "@story-fm/domain";
import {
  TACTICAL_STYLES,
  adminRemoveTeam,
  adminTeamCatalog,
  adminUpdateTeam,
  isTeamCatalogEdited,
} from "@story-fm/engine";
import { adminWrite } from "@/app/api/admin/admin-guard";

/** 1~4 등급 — 체급·브랜드 등급이 함께 쓴다 */
const grade = (msg: string) =>
  z
    .number()
    .int(msg)
    .min(1, msg)
    .max(4, msg)
    .transform((v) => v as 1 | 2 | 3 | 4);

/** 모든 필드 optional — 보낸 것만 갱신한다 */
const PatchSchema = z.object({
  name: z.string().min(1, "팀 이름이 필요합니다").max(60).optional(),
  shortName: z.string().min(1, "짧은 이름이 필요합니다").max(10).optional(),
  leagueId: z.string().min(1, "소속 리그가 필요합니다").optional(),
  tier: grade("체급은 1~4여야 합니다").optional(),
  formation: FormationSchema.optional(),
  tacticalStyle: z.enum(TACTICAL_STYLES).optional(),
  stadium: z.string().min(1, "구장 이름이 필요합니다").max(60).optional(),
  capacity: z.number().int().min(1, "수용인원은 1 이상이어야 합니다").max(200_000).optional(),
  commercialTier: grade("브랜드 등급은 1~4여야 합니다").optional(),
});

function payload(message: string) {
  return {
    ok: true,
    message,
    teams: adminTeamCatalog(),
    edited: isTeamCatalogEdited(),
  };
}

/** 카탈로그 팀 편집 */
export const PATCH = adminWrite(async function (
  request: Request,
  context: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await context.params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다" }, { status: 400 });
  }
  const body = PatchSchema.safeParse(raw);
  if (!body.success) {
    return NextResponse.json(
      { error: body.error.issues[0]?.message ?? "입력 오류" },
      { status: 400 },
    );
  }
  const res = adminUpdateTeam(teamId, body.data);
  if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
  return NextResponse.json(payload(res.message));
});

/** 카탈로그에서 팀 삭제 — 그 팀의 선수도 함께 사라진다 */
export const DELETE = adminWrite(async function (
  _request: Request,
  context: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await context.params;
  const res = adminRemoveTeam(teamId);
  if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
  return NextResponse.json(payload(res.message));
});
