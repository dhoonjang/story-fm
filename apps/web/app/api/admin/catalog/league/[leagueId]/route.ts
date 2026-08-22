import { NextResponse } from "next/server";
import { z } from "zod";
import {
  LEAGUE_KINDS,
  adminLeagueCatalog,
  adminRemoveLeague,
  adminUpdateLeague,
  isLeagueCatalogEdited,
} from "@story-fm/engine";
import { adminWrite } from "@/app/api/admin/admin-guard";

/** 모든 필드 optional — 보낸 것만 갱신한다 */
const PatchSchema = z.object({
  name: z.string().min(1, "리그 이름이 필요합니다").max(60).optional(),
  country: z.string().min(1, "나라가 필요합니다").max(40).optional(),
  kind: z.enum(LEAGUE_KINDS).optional(),
  coefficient: z.number().min(1, "계수는 1 이상이어야 합니다").max(99).optional(),
  realSquads: z.boolean().optional(),
  broadcastPool: z.number().min(0, "중계권 배율은 0 이상이어야 합니다").max(10).optional(),
  avgTicketPrice: z.number().min(0, "평균 티켓 단가는 0 이상이어야 합니다").max(10_000).optional(),
});

function payload(message: string) {
  return {
    ok: true,
    message,
    leagues: adminLeagueCatalog(),
    edited: isLeagueCatalogEdited(),
  };
}

/** 카탈로그 리그 편집 */
export const PATCH = adminWrite(async function (
  request: Request,
  context: { params: Promise<{ leagueId: string }> },
) {
  const { leagueId } = await context.params;
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
  const res = adminUpdateLeague(leagueId, body.data);
  if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
  return NextResponse.json(payload(res.message));
});

/** 카탈로그에서 리그 삭제 — 소속 팀이 남아 있으면 엔진이 막는다 */
export const DELETE = adminWrite(async function (
  _request: Request,
  context: { params: Promise<{ leagueId: string }> },
) {
  const { leagueId } = await context.params;
  const res = adminRemoveLeague(leagueId);
  if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
  return NextResponse.json(payload(res.message));
});
