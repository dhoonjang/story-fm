import { NextResponse } from "next/server";
import { z } from "zod";
import {
  LEAGUE_KINDS,
  adminAddLeague,
  adminLeagueCatalog,
  adminResetLeagueCatalog,
  isLeagueCatalogEdited,
} from "@story-fm/engine";
import { adminWrite } from "@/app/api/admin/admin-guard";

/**
 * 리그 카탈로그 어드민 — 대회의 불변 정의(종류·계수·중계권·티켓 단가)를 편집한다.
 * 팀 어드민과 같은 규칙이다: 변경은 이후 새로 시작하는 게임에만 반영된다.
 *
 * `kind`는 리그가 게임에서 **하는 일**이라 구조 필드다 — 여기서 받기만 하고
 * 세계가 성립하는지는 엔진의 불변식 검사가 판정한다.
 */

const LeagueFields = {
  name: z.string().min(1, "리그 이름이 필요합니다").max(60),
  country: z.string().min(1, "나라가 필요합니다").max(40),
  kind: z.enum(LEAGUE_KINDS),
  coefficient: z.number().min(1, "계수는 1 이상이어야 합니다").max(99),
  realSquads: z.boolean(),
  broadcastPool: z.number().min(0, "중계권 배율은 0 이상이어야 합니다").max(10),
  avgTicketPrice: z.number().min(0, "평균 티켓 단가는 0 이상이어야 합니다").max(10_000),
};

const AddSchema = z.object({
  id: z.string().min(1, "리그 id가 필요합니다").max(40),
  ...LeagueFields,
});

function payload(message: string) {
  return {
    ok: true,
    message,
    leagues: adminLeagueCatalog(),
    edited: isLeagueCatalogEdited(),
  };
}

export function GET() {
  return NextResponse.json({
    leagues: adminLeagueCatalog(),
    edited: isLeagueCatalogEdited(),
  });
}

/** 카탈로그에 새 리그 추가 */
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
  const res = adminAddLeague(body.data);
  if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
  return NextResponse.json(payload(res.message));
});

/** 리그 카탈로그를 시드 기본값으로 되돌린다 */
export const DELETE = adminWrite(async function () {
  const res = adminResetLeagueCatalog();
  return NextResponse.json(payload(res.message));
});
