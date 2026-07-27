import { NextResponse } from "next/server";
import { z } from "zod";
import { ATTRIBUTE_AXES } from "@story-fm/domain";
import {
  adminAddCatalogPlayer,
  adminCatalog,
  adminResetCatalog,
  isCatalogEdited,
  CATALOG_AGE_REF,
} from "@story-fm/engine";

/**
 * 선수 카탈로그 어드민 — 게임과 무관한 초기치 DB를 편집한다.
 * 여기서의 변경은 **이후 새로 시작하는 게임**에만 반영된다 (진행 중 세이브 무영향).
 */

export function GET() {
  return NextResponse.json({
    teams: adminCatalog(),
    edited: isCatalogEdited(),
    ageRef: CATALOG_AGE_REF,
  });
}

const attr = z.number().int().min(1).max(99);
const AddSchema = z.object({
  teamId: z.string().min(1),
  nameKo: z.string().min(1).max(40),
  nameEn: z.string().max(60).optional(),
  birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "출생년월일 형식(YYYY-MM-DD)이 올바르지 않습니다"),
  position: z.string().min(1),
  // 능력치 15축 — 도메인 상수에서 펼친다
  ...(Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, attr])) as Record<string, typeof attr>),
  potential: attr,
});

/** 카탈로그에 새 선수 추가 */
export async function POST(request: Request) {
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
  const { teamId, ...input } = body.data;
  const res = adminAddCatalogPlayer(teamId, input);
  if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
  return NextResponse.json({
    ok: true,
    message: res.message,
    playerId: res.playerId,
    teams: adminCatalog(),
    edited: isCatalogEdited(),
  });
}

/** 카탈로그를 시드 기본값으로 되돌린다 */
export async function DELETE() {
  const res = adminResetCatalog();
  return NextResponse.json({
    ok: true,
    message: res.message,
    teams: adminCatalog(),
    edited: isCatalogEdited(),
  });
}
