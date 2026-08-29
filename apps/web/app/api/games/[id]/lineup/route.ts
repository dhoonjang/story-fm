import { NextResponse } from "next/server";
import { z } from "zod";
import {
  MATCHDAY_BENCH,
  SET_PIECE_ROLES,
  SetPieceRoutineSchema,
  type SetPieceRole,
} from "@story-fm/domain";
import {
  lineupChangeNote,
  lineupSignature,
  loadGame,
  managedTeamId,
  recordEdit,
  saveGame,
  setLineup,
  setPlayerRole,
  setSetPieceRoutine,
  setSetPieceTakers,
  setTactics,
  shapeOfTactics,
  startingIdsOf,
} from "@story-fm/engine";
import { toPayload } from "@/lib/store";
import { LOCK_WAIT_MS, busyResponse, withGameLock } from "@/lib/turn-runner";
import { invalidGameId } from "@/app/api/games/game-id";

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
/** 죽은 공 자리 하나의 값 — 선수 id, `null`이면 지정 해제 */
const TakerRef = z.string().min(1).nullable();
/**
 * 죽은 공 키커 — 역할과 같은 규약이다: **서버와 달라진 자리만** 오고 없는 자리는
 * "그대로"다. 자리 목록은 도메인이 갖는다(`SET_PIECE_ROLES`) — 여기 셋을 적어 두면
 * 네 번째 자리가 생긴 날 화면은 보내고 라우트만 조용히 버린다.
 *
 * ⚠️ **여기서 선수를 검증하지 않는다.** 우리 선수인지 보는 문은 명령 하나뿐이고
 * (`set_set_piece_takers` → `pickOurPlayer`), 같은 규칙을 라우트에 한 벌 더 두면
 * 채팅으로 지정할 때와 화면으로 지정할 때가 조용히 갈린다 (match.md §2 키커 지정).
 */
const SetPieceTakersSchema = z
  .object(
    Object.fromEntries(SET_PIECE_ROLES.map((role) => [role, TakerRef])) as Record<
      SetPieceRole,
      typeof TakerRef
    >,
  )
  .partial();
/**
 * ⚠️ **포메이션 이름은 받지 않는다.** 모양은 선발 11명의 좌표에서 읽는 파생값이라
 * (team.md §6 · game-state.md §5) 이름을 입력으로 두면 판과 장부가 갈라진다.
 * 프리셋 열거형으로 받으면 자유 배치가 만든 `4-1-3-2`가 통째로 400이 된다.
 */
const LineupSchema = z.object({
  starting: z.array(SlotSchema).length(11),
  /** 정원의 원본은 도메인 하나다 (→ docs/data/team.md §6) — 화면도 같은 값을 읽는다 */
  bench: z.array(SlotSchema).max(MATCHDAY_BENCH).default([]),
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
  setPieceTakers: SetPieceTakersSchema.optional(),
  /**
   * 죽은 공 지시 — 가담·수비 두 축. 키커와 같은 규약이다: **서버와 달라진 축만**
   * 오고 없는 축은 "그대로"다. 낱말표도 값의 열거도 도메인이 갖는다
   * (`SetPieceRoutineSchema` — match.md §1.4).
   */
  setPieceRoutine: SetPieceRoutineSchema.optional(),
});

/**
 * 라인업 편집 (스쿼드 탭) — 포지션 변경 후 선발/벤치 확정.
 * 경기 중(phase=match)에는 채팅 교체만 허용하므로 반려한다.
 * 게임 잠금을 턴과 공유해 진행 중인 GM 턴과 저장이 엉키지 않게 한다 — **그 잠금을
 * 기다리는 데는 상한이 있다.** 넘기면 409 + `retry`라, 그 편집은 화면의 대기열에 남아
 * 다음 자동 저장에 다시 실린다. 여기서 몇 분씩 기다리면 감독이 손을 놓고 기다리게 되고,
 * 기다린 끝에 저장되는 배치는 이미 지난 턴의 것이다 (docs/llm/models.md §1-1).
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const bad = invalidGameId(id);
  if (bad) return bad;

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

  return withGameLock(id, LOCK_WAIT_MS.lineup, async () => {
    const state = loadGame(id);
    if (!state) return NextResponse.json({ error: "게임을 찾을 수 없습니다" }, { status: 404 });
    // 서버는 **사실만** 낸다 — 그 다음에 무엇을 하라는 말은 GM이 쓴다
    if (state.phase === "match") {
      return NextResponse.json({ error: "경기 중 — 전술판 잠금" }, { status: 409 });
    }
    // 무직 잠금 — userTeamId는 옛 구단을 가리키므로 막지 않으면 남의 선발을 짠다 (career.md §5.1)
    if (managedTeamId(state) === null) {
      return NextResponse.json({ error: "무직 — 전술판 잠금" }, { status: 409 });
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
    /**
     * v6: 전술판 배치는 TACTIC_ASSIGNMENT를 갱신한다 (주 포지션은 바꾸지 않는다).
     *
     * 1·2군 이동도 **같은 호출로** 넘긴다 — 순서(승격 → 배치 → 강등)와 검증은 코어가
     * 한 벌만 갖는다(`setLineup` · team.md §6). 라우트가 승격을 따로 부르던 때는
     * 배치가 반려돼도 승격만 남았고, 같은 규칙이 두 곳에 적혀 한쪽만 고쳐졌다.
     */
    const res = setLineup(state, {
      starting: body.data.starting,
      bench: body.data.bench,
      ...(body.data.squadLevels ? { squadLevels: body.data.squadLevels } : {}),
    });
    if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });

    /**
     * 역할은 **배치 뒤에** — 방금 선발이 된 선수에게도 걸 수 있어야 한다.
     *
     * 그리고 **역할 하나의 반려가 배치를 되돌리지 않는다** (player.md §3.1).
     * 역할은 한 요청에 묶여 오는 값 중 가장 늦게 정해지고 가장 잘 어긋나는 것이라
     * (자리를 옮긴 직후의 화면이 보낸다) 400으로 빠져나오면 옳게 바꾼 배치까지
     * 함께 날아가고, 화면은 같은 역할을 계속 보내 저장 불가 상태로 굳는다.
     * 걸리는 것만 걸고, 반려는 삼키지 않고 결과로 남긴다.
     */
    const rejectedRoles: string[] = [];
    for (const pick of body.data.roles ?? []) {
      const applied = setPlayerRole(state, { playerId: pick.playerId, role: pick.role });
      if (!applied.ok) {
        rejectedRoles.push(applied.message);
        continue;
      }
      recordEdit(state, `role:${pick.playerId}`, applied.message);
    }
    // 사유는 코어가 쓴 문장 그대로다. 고정 키라 열 번 저장해도 마지막 것만 남는다
    if (rejectedRoles.length > 0) recordEdit(state, "role:rejected", rejectedRoles.join(" · "));

    /**
     * 죽은 공 키커 — **역할과 같은 자리, 같은 규약.** 반려가 배치를 되돌리지 않는다:
     * 지정은 배치 뒤에 정해지는 값이라 400으로 빠져나오면 옳게 바꾼 판까지 함께 날아간다.
     *
     * 화면이 달라진 자리만 보내므로(`lineupBody`) 여기 온 것은 감독이 방금 고른
     * 것이다 — 그래도 `unchanged`를 한 번 더 본다: 채팅이 같은 값을 먼저 넣은 턴에
     * 감독이 만지지 않은 편집 노트가 남지 않게.
     */
    const takers = body.data.setPieceTakers;
    if (takers && Object.keys(takers).length > 0) {
      const applied = setSetPieceTakers(state, takers);
      if (!applied.ok) recordEdit(state, "setpiece:rejected", applied.message);
      else if (applied.unchanged !== true) recordEdit(state, "setpiece", applied.message);
    }

    /** 죽은 공 지시 — 키커 바로 옆, **같은 규약.** 라우트는 값을 옮기기만 한다 */
    const routine = body.data.setPieceRoutine;
    if (routine && Object.keys(routine).length > 0) {
      const applied = setSetPieceRoutine(state, routine);
      if (!applied.ok) recordEdit(state, "setpiece-routine:rejected", applied.message);
      else if (applied.unchanged !== true) recordEdit(state, "setpiece-routine", applied.message);
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
    /**
     * **바꾼 것은 스쿼드 하나다.** 전술판은 조작이 멎을 때마다 저장하므로 판을 짜는
     * 동안 이 응답이 3초마다 나간다 — 전부를 실으면 감독은 전술판만 만졌는데
     * 채팅·순위·일정까지 매번 다시 그려진다. `edits`는 뷰에 없고, 경기 중에는 위에서
     * 409로 막았으니 `match`도 달라지지 않는다.
     */
    return NextResponse.json(toPayload(state, ["squad"]));
  }).catch(busyResponse);
}
