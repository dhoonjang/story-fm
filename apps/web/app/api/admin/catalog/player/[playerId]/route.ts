import { NextResponse } from "next/server";
import { z } from "zod";
import { ATTRIBUTE_AXES } from "@story-fm/domain";
import {
  adminCatalog,
  adminMoveCatalogPlayer,
  adminRemoveCatalogPlayer,
  adminSetCatalogPositions,
  adminUpdateCatalogPlayer,
  isCatalogEdited,
  playerCatalog,
} from "@story-fm/engine";

const attr = z.number().int().min(1).max(99).optional();
const wage = z.number().int().min(0).max(2_000_000).optional();
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
  /** 소속 팀 이동 — 방출은 `freeagents`로 옮기는 것이다 */
  teamId: z.string().min(1).optional(),
  ...axisFields,
  potential: attr,
  /** 실제 주급 (£/주) — 새 게임의 초기 계약에 그대로 쓰인다 */
  weeklyWage: wage,
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
  const { positions, teamId, ...patch } = body.data;
  const messages: string[] = [];
  // 이동을 먼저 본다 — 거절되면 아무것도 반영되지 않은 상태로 멈춘다.
  // 이미 그 팀이면 이동 자체가 없던 일이다 (다른 편집까지 400으로 떨구지 않는다)
  const current = playerCatalog().find((e) => e.id === playerId);
  if (teamId !== undefined && current?.teamId !== teamId) {
    const res = adminMoveCatalogPlayer(playerId, teamId);
    if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
    messages.push(res.message);
  }
  if (positions) {
    const res = adminSetCatalogPositions(playerId, positions);
    if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
    messages.push("포지션을 갱신했습니다");
  }
  if (Object.keys(patch).length > 0) {
    const res = adminUpdateCatalogPlayer(playerId, patch);
    if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
    messages.push(res.message);
  }
  return NextResponse.json({
    ok: true,
    message: messages.join(" · ") || "변경 사항이 없습니다",
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
