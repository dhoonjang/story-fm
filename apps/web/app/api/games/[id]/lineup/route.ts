import { NextResponse } from "next/server";
import { z } from "zod";
import {
  lineupChangeNote,
  lineupSignature,
  loadGame,
  recordEdit,
  saveGame,
  setLineup,
  setPlayerRole,
  setSquadLevel,
  setTactics,
  shapeOfTactics,
  startingIdsOf,
} from "@story-fm/engine";
import { toPayload } from "@/lib/store";
import { withGameLock } from "@/lib/turn-runner";

const SlotSchema = z.object({
  playerId: z.string().min(1),
  /** 이 전술에서 맡는 포지션 (전술판 슬롯 코드) — point가 있으면 서버가 무시하고 좌표로 다시 정한다 */
  position: z.string().min(1).optional(),
  /** 전술판 좌표(자유 배치) — 있으면 포지션은 이 좌표의 파생이다 */
  point: z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) }).optional(),
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
    passStyle: z.number().int().min(1).max(5),
  })
  .partial();
/**
 * ⚠️ **포메이션 이름은 받지 않는다.** 모양은 선발 11명의 좌표에서 읽는 파생값이라
 * (team.md §6 · game-state.md §5) 이름을 입력으로 두면 판과 장부가 갈라진다.
 * 프리셋 열거형으로 받으면 자유 배치가 만든 `4-1-3-2`가 통째로 400이 된다.
 */
const LineupSchema = z.object({
  starting: z.array(SlotSchema).length(11),
  bench: z.array(SlotSchema).max(12).default([]),
  tactics: TacticsSchema.optional(),
  /**
   * 1·2군 이동 — 전술판에서 2군 선수를 끌어올리거나 1군을 내릴 때 함께 온다.
   * 라인업과 한 요청으로 묶어야 "승격 성공 + 배치 실패" 같은 반쪽 상태가 안 생긴다.
   */
  squadLevels: z
    .array(z.object({ playerId: z.string().min(1), level: z.enum(["first", "reserve"]) }))
    .max(60)
    .optional(),
  /**
   * 세부 역할 — **서버와 달라진 것만** 온다. 알약을 누를 때마다 요청을 보내면
   * 결정 하나가 요청 여럿이 되므로, 다른 조작과 함께 자동 저장에 실린다.
   */
  roles: z
    .array(z.object({ playerId: z.string().min(1), role: z.string().min(1) }))
    .max(30)
    .optional(),
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

    // 저장 전 모습 — 무엇이 달라졌는지는 결과로만 말한다 (`lineupChangeNote`)
    const before = {
      starting: startingIdsOf(state),
      shape: shapeOfTactics(state),
      signature: lineupSignature(state),
    };

    // 전술 6축이 먼저 — 한 번만 호출해야 적응도 하락(tacticsChangeDrop)도 한 번만
    // 적용된다. 배치가 만드는 모양 이름은 아래 setLineup이 좌표에서 다시 읽는다
    const axes = body.data.tactics ?? {};
    if (Object.keys(axes).length > 0) {
      const res = setTactics(state, axes);
      if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
    }
    // 1·2군 이동은 **승격 먼저, 강등 나중**이다. 승격이 앞서야 그 선수를 라인업에
    // 넣을 수 있고(2군은 setLineup이 반려한다), 강등은 뒤에 해야 방금 짠 배치에서
    // 다시 빠지지 않는다.
    const levels = body.data.squadLevels ?? [];
    for (const move of levels.filter((m) => m.level === "first")) {
      const res = setSquadLevel(state, move);
      if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
    }

    // v6: 전술판 배치는 TACTIC_ASSIGNMENT를 갱신한다 (주 포지션은 바꾸지 않는다)
    const res = setLineup(state, { starting: body.data.starting, bench: body.data.bench });
    if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });

    for (const move of levels.filter((m) => m.level === "reserve")) {
      const demoted = setSquadLevel(state, move);
      if (!demoted.ok) return NextResponse.json({ error: demoted.message }, { status: 400 });
    }

    // 역할은 **배치 뒤에** — 방금 선발이 된 선수에게도 걸 수 있어야 한다
    for (const pick of body.data.roles ?? []) {
      const applied = setPlayerRole(state, { playerId: pick.playerId, role: pick.role });
      if (!applied.ok) return NextResponse.json({ error: applied.message }, { status: 400 });
      recordEdit(state, `role:${pick.playerId}`, applied.message);
    }

    /**
     * 전술판 저장은 채팅 턴을 만들지 않는다 — 판을 짜는 동안 열 번을 만지는데
     * 그때마다 턴이 되면 채팅이 조작 로그가 된다. 대신 **바뀐 결과 한 줄**을
     * 모아 두고 다음 발화 때 GM이 읽는다. 여러 번 저장해도 `lineup` 키로
     * 접히므로 마지막 결과만 남는다.
     */
    const note = lineupChangeNote(state, before);
    if (note) recordEdit(state, "lineup", note);
    saveGame(state);
    return NextResponse.json(toPayload(state));
  });
}
