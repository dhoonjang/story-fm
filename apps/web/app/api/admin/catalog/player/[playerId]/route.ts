import { NextResponse } from "next/server";
import { z } from "zod";
import { ATTRIBUTE_AXES } from "@story-fm/domain";
import {
  adminCatalog,
  adminRemoveCatalogPlayer,
  adminSetCatalogPositions,
  adminUpdateCatalogPlayer,
  isCatalogEdited,
} from "@story-fm/engine";

const attr = z.number().int().min(1).max(99).optional();
/** 능력치 15축 — 도메인 상수에서 스키마를 펼친다 (축이 늘면 여기도 자동으로) */
const axisFields = Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, attr]));
const PatchSchema = z.object({
  nameKo: z.string().min(1).max(40).optional(),
  nameEn: z.string().min(1).max(60).optional(),
  birthdate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "출생년월일 형식(YYYY-MM-DD)이 올바르지 않습니다")
    .optional(),
  position: z.string().min(1).optional(),
  ...axisFields,
  potential: attr,
  /** 가능 포지션 전체 교체 (멀티 포지션 편집) */
  positions: z
    .array(
      z.object({
        position: z.string().min(1),
        proficiency: z.number().int().min(1).max(99),
        isNatural: z.boolean(),
      }),
    )
    .optional(),
});

/** 카탈로그 선수 편집 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ playerId: string }> },
) {
  const { playerId } = await context.params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다" }, { status: 400 });
  }
  const body = PatchSchema.safeParse(raw);
  if (!body.success) {
    return NextResponse.json({ error: body.error.issues[0]?.message ?? "입력 오류" }, { status: 400 });
  }
  const { positions, ...patch } = body.data;
  if (positions) {
    const res = adminSetCatalogPositions(playerId, positions);
    if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
  }
  if (Object.keys(patch).length > 0) {
    const res = adminUpdateCatalogPlayer(playerId, patch);
    if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
    return NextResponse.json({
      ok: true,
      message: res.message,
      teams: adminCatalog(),
      edited: isCatalogEdited(),
    });
  }
  return NextResponse.json({
    ok: true,
    message: "포지션을 갱신했습니다",
    teams: adminCatalog(),
    edited: isCatalogEdited(),
  });
}

/** 카탈로그에서 선수 삭제 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ playerId: string }> },
) {
  const { playerId } = await context.params;
  const res = adminRemoveCatalogPlayer(playerId);
  if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
  return NextResponse.json({
    ok: true,
    message: res.message,
    teams: adminCatalog(),
    edited: isCatalogEdited(),
  });
}
