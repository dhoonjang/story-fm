import { NextResponse } from "next/server";
import { z } from "zod";
import { loadGame, saveGame, setLineup, setTactics } from "@story-fm/engine";
import { toPayload } from "@/lib/store";
import { withGameLock } from "@/lib/turn-runner";

const SlotSchema = z.object({
  playerId: z.string().min(1),
  /** 이 전술에서 맡는 포지션 (전술판 슬롯 코드) */
  position: z.string().min(1).optional(),
});
const Scale5 = z.number().int().min(1).max(5);
/** 전술판에서 함께 저장하는 팀 전술 — 슬라이더 5축 + 패스 스타일 */
const TacticsSchema = z
  .object({
    mentality: Scale5,
    defensiveLine: Scale5,
    pressing: Scale5,
    tempo: Scale5,
    width: Scale5,
    passStyle: z.enum(["short", "mixed", "direct"]),
  })
  .partial();
const LineupSchema = z.object({
  starting: z.array(SlotSchema).length(11),
  bench: z.array(SlotSchema).max(12).default([]),
  formation: z.enum(["4-4-2", "4-3-3", "4-2-3-1", "3-5-2", "5-4-1"]).optional(),
  tactics: TacticsSchema.optional(),
});

/**
 * 라인업 편집 (스쿼드 탭) — 포지션 변경 후 선발/벤치 확정.
 * 경기 중(phase=match)에는 채팅 교체만 허용하므로 반려한다.
 * 턴 뮤텍스를 공유해 진행 중인 GM 턴과 저장이 엉키지 않게 한다.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다" }, { status: 400 });
  }
  const body = LineupSchema.safeParse(raw);
  if (!body.success) {
    return NextResponse.json({ error: "라인업 형식이 올바르지 않습니다" }, { status: 400 });
  }

  return withGameLock(id, async () => {
    const state = loadGame(id);
    if (!state) return NextResponse.json({ error: "게임을 찾을 수 없습니다" }, { status: 404 });
    if (state.phase === "match") {
      return NextResponse.json(
        { error: "경기 중에는 채팅으로 교체를 지시하세요" },
        { status: 409 },
      );
    }

    // 전술(포메이션 포함) 먼저 — setLineup의 슬롯 기본값이 새 포메이션 기준으로
    // 잡히게 한다. 한 번만 호출해야 적응도 하락(tacticsChangeDrop)도 한 번만 적용된다
    const spec = {
      ...(body.data.formation ? { formation: body.data.formation } : {}),
      ...(body.data.tactics ?? {}),
    };
    if (Object.keys(spec).length > 0) {
      const res = setTactics(state, spec);
      if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
    }
    // v6: 전술판 배치는 TACTIC_ASSIGNMENT를 갱신한다 (주 포지션은 바꾸지 않는다)
    const res = setLineup(state, { starting: body.data.starting, bench: body.data.bench });
    if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });

    // 전술판 저장은 채팅에 전송하지 않는다 (사용자 요청). GM은 필요할 때
    // 컨텍스트(buildGmContext)로 현재 전술·라인업을 읽어 반응한다.
    saveGame(state);
    return NextResponse.json(toPayload(state));
  });
}
