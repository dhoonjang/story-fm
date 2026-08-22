import { NextResponse } from "next/server";
import { z } from "zod";
import { FormationSchema } from "@story-fm/domain";
import {
  TACTICAL_STYLES,
  adminAddTeam,
  adminResetTeamCatalog,
  adminTeamCatalog,
  isTeamCatalogEdited,
} from "@story-fm/engine";
import { adminWrite } from "@/app/api/admin/admin-guard";

/**
 * 팀 카탈로그 어드민 — 클럽의 정체성(이름·리그·체급·포메이션)과 살림을 편집한다.
 * 선수 카탈로그와 같은 규칙이다: 변경은 **이후 새로 시작하는 게임**에만 반영된다.
 *
 * API는 타입·범위만 본다 — 리그 정원·컵 규모 같은 세계의 성립 조건은 엔진의
 * 불변식 검사(`catalog-invariants.ts`)가 막고, 그 메시지를 그대로 전달한다.
 */

/** 1~4 등급 — 체급·브랜드 등급이 함께 쓴다 */
const grade = (msg: string) =>
  z
    .number()
    .int(msg)
    .min(1, msg)
    .max(4, msg)
    .transform((v) => v as 1 | 2 | 3 | 4);

const AddSchema = z.object({
  id: z.string().min(1, "팀 id가 필요합니다").max(40),
  name: z.string().min(1, "팀 이름이 필요합니다").max(60),
  shortName: z.string().min(1, "짧은 이름이 필요합니다").max(10),
  leagueId: z.string().min(1, "소속 리그가 필요합니다"),
  tier: grade("체급은 1~4여야 합니다"),
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

export function GET() {
  return NextResponse.json({
    teams: adminTeamCatalog(),
    edited: isTeamCatalogEdited(),
  });
}

/** 카탈로그에 새 팀 추가 — 스쿼드는 엔진이 함께 채운다 */
export const POST = adminWrite(async function (request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다" }, { status: 400 });
  }
  const body = AddSchema.safeParse(raw);
  if (!body.success) {
    return NextResponse.json(
      { error: body.error.issues[0]?.message ?? "입력 오류" },
      { status: 400 },
    );
  }
  const res = adminAddTeam(body.data);
  if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
  return NextResponse.json(payload(res.message));
});

/** 팀 카탈로그를 시드 기본값으로 되돌린다 (전술 성향·구단 프로필 포함) */
export const DELETE = adminWrite(async function () {
  const res = adminResetTeamCatalog();
  return NextResponse.json(payload(res.message));
});
