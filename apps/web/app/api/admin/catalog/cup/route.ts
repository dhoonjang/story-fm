import { NextResponse } from "next/server";
import { adminCupCatalog, adminResetCupCatalog, isCupCatalogEdited } from "@story-fm/engine";

/**
 * 컵 카탈로그 어드민 — 유럽 대항전과 국내 컵을 한 표에서 편집한다.
 * 두 대회군은 모양이 다르지만 오버라이드 파일이 하나라 조회·리셋도 함께 움직인다.
 */

export function GET() {
  const { europe, domestic } = adminCupCatalog();
  return NextResponse.json({ europe, domestic, edited: isCupCatalogEdited() });
}

/** 컵 카탈로그를 시드 기본값으로 되돌린다 (유럽·국내 함께) */
export async function DELETE() {
  const res = adminResetCupCatalog();
  const { europe, domestic } = adminCupCatalog();
  return NextResponse.json({
    ok: true,
    message: res.message,
    europe,
    domestic,
    edited: isCupCatalogEdited(),
  });
}
