"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MATCHDAY_BENCH,
  TACTIC_AXES,
  adaptationOf,
  anchorOf,
  defaultRoleOf,
  isUnfamiliarPosition,
  positionAtPoint,
  positionGroupOf,
  positionProficiency,
  rolesFor,
  separateBoardPoints,
  shapeOf,
  snapToBoard,
  type BoardPoint,
} from "@story-fm/domain";
import type { GamePayload, GameSlice } from "@/lib/store";
import type { MatchBoardOrder } from "@/lib/match-orders";
import { slotOverallOf } from "@/lib/slot-overall";
import {
  familiarityForRole,
  lineupBody,
  resetRolesForMovedPlayers,
  roleAtSlot,
  swappedLists,
  type BoardState,
} from "@/lib/board-roles";
import { IconBoard } from "@/components/icons";
import { PitchChip, PitchGround } from "../../pitch";
import { createLineupSaver, type LineupSaveOutcome, type LineupSaver } from "../../lineup-saver";
import { useBoardDrag } from "./board-drag";
import { Margin, fitAt } from "./marks";
import { PlayerDetail } from "./player-detail";
import { SquadTable, type SortKey } from "./squad-table";
import { TacticsPanel } from "./tactics-panel";
import type { BoardSlot, Selection, SquadRow, TacticsView, Tier } from "./types";

/**
 * 신원이 고정된 콜백 — 항상 **최신 클로저**를 부른다.
 *
 * 드래그 중에는 프레임마다 렌더가 도는데, 명단에 넘기는 콜백이 매번 새 함수면
 * `useMemo`가 무조건 깨져 43행을 다시 그린다. 그렇다고 의존성에서 빼면 옛 상태를
 * 붙든 콜백이 남는다. 참조로 최신 함수를 가리키면 둘 다 피할 수 있다.
 */
function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

/** 골키퍼 자리 수 — 정확히 1이 아니면 서버가 반려하므로 저장을 보류한다 */
const gkCountOf = (b: BoardState) => b.points.filter((p) => positionAtPoint(p) === "GK").length;

export function SquadView({
  game,
  onUpdate,
  onGoToChat,
  onOrder,
  boardOpen = true,
  onToggleBoard,
  saver: sharedSaver,
}: {
  game: GamePayload;
  /** 저장이 바꾼 뷰만 온다 — 화면이 쥔 payload에 얹는 일은 바깥이 한다 */
  onUpdate: (slice: GameSlice) => void;
  onGoToChat: () => void;
  /**
   * 전술판을 펼쳐 두었나 — **접으면 명단만 남는다.**
   *
   * 채팅 옆에 나란히 설 때 스쿼드가 통째로 들어오면 전술판이 200px로 눌려 아무
   * 쓸모가 없다. 감독이 채팅을 보며 곁눈질하는 것은 대개 **명단**이고(누가 부상인가,
   * 누가 폼이 좋은가), 판을 만지는 것은 그 자체로 하나의 일이다. 그래서 명단이 먼저
   * 오른쪽에 서고, 판을 펼치면 그때 화면을 통째로 쓴다.
   */
  boardOpen?: boolean;
  /** 펼침을 뒤집는다 — 주지 않으면 손잡이를 그리지 않는다(경기 중 전술판 탭) */
  onToggleBoard?: () => void;
  /**
   * 경기 중 조작 — **지시로 보낸다.**
   *
   * 경기 중 라인업·전술은 감독이 직접 저장하는 값이 아니다(교체 횟수·적응도
   * 대가·상대 반응이 걸려 있다). 그래서 전술판을 잠가 뒀는데, 그러면 감독이
   * 손에 쥔 판을 두고 채팅에 "손흥민 빼고 이강인"이라고 타이핑해야 했다.
   * 지금은 판에서 조작하면 그것이 **오퍼레이터 지시**가 되어 GM이 받는다 —
   * 시간 이동 손잡이와 같은 경로다.
   */
  onOrder?: (order: MatchBoardOrder) => void;
  /**
   * 자동 저장 대기열 — **화면이 쥐고 있으면 턴이 나가기 전에 비워진다.**
   *
   * 판이 자기 안에서만 예약을 들고 있으면 채팅은 그것을 모른 채 턴을 보내고,
   * 서버는 옛 배치로 GM 입력을 만든다 (lineup-saver.ts).
   */
  saver?: LineupSaver;
}) {
  const squad = game.views.squad;
  const players = squad.players;
  const byId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const boardRef = useRef<HTMLDivElement>(null);
  /** 직접 저장할 수 있는가 — 경기 중과 무직에는 아니다 (뷰의 `editable`이 판정한다) */
  const live = squad.editable;
  /** 무직 — 판은 옛 구단의 것이라 잠겨 있다 (career.md §5.1). 여기서는 문구만 가른다 */
  const dismissed = game.views.career.dismissal !== null;
  /** 경기 중이지만 **판으로 지시할 수는 있다** */
  const advisory = !live && onOrder !== undefined;
  /** 판을 만질 수 있는가 — 저장이든 지시든 */
  const usable = live || advisory;

  // 서버가 준 배치 — 이 값이 바뀌면(저장 완료·채팅 지시) 작업 사본을 다시 맞춘다
  const serverBoard = useMemo<BoardState>(() => {
    const starters = players.filter((p) => p.role === "선발");
    return {
      points: starters.map((p) => p.assignedPoint ?? anchorOf(p.assignedPosition ?? "CM")),
      occupants: starters.map((p) => p.id),
      bench: players.filter((p) => p.role === "벤치").map((p) => p.id),
      reserve: players.filter((p) => p.squadLevel === "reserve").map((p) => p.id),
      roles: Object.fromEntries(
        players.filter((p) => p.roleId !== null).map((p) => [p.id, p.roleId!]),
      ),
      tactics: squad.tactics,
    };
  }, [players, squad.tactics]);

  const [board, setBoard] = useState<BoardState>(serverBoard);
  const [selection, setSelection] = useState<Selection>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 경기 중 판에서 만들었지만 아직 다음 진행 턴으로 보내지 않은 작업 사본 */
  const [advisoryPending, setAdvisoryPending] = useState(false);
  const [squadFilter, setSquadFilter] = useState<"first" | "reserve">("first");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "role", desc: false });

  // 자동 저장 — rev는 로컬 변경 번호. 저장된 번호보다 앞서 있으면 아직 서버에 안 갔다
  const revRef = useRef(0);
  const savedRevRef = useRef(0);
  const dirty = revRef.current !== savedRevRef.current;
  // 예약·진행 중인 저장은 판 바깥이 쥔다 — 턴이 나가기 전에 화면이 비운다.
  // 혼자 서는 자리(테스트·판만 그리는 화면)에서는 제 것을 만들어 쓴다.
  const ownSaverRef = useRef<LineupSaver | null>(null);
  ownSaverRef.current ??= createLineupSaver();
  const saver = sharedSaver ?? ownSaverRef.current;
  /** 서버가 아는 2군 명단 — 저장할 때 "무엇이 달라졌는지"의 기준점 */
  const serverReserveRef = useRef<Set<string>>(new Set(serverBoard.reserve));
  serverReserveRef.current = new Set(serverBoard.reserve);
  /**
   * 서버가 준 행 — 저장 본문이 "이 역할을 코어가 스스로 낼 수 있는가"를 재는 기준점.
   * 기억이 들어 있어 되찾기 3단을 여기서 다시 밟을 수 있다 (player.md §3.2).
   */
  const rowsRef = useRef<Map<string, SquadRow>>(byId);
  rowsRef.current = byId;

  const post = useCallback(
    (snapshot: BoardState) =>
      fetch(`/api/games/${game.id}/lineup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lineupBody(snapshot, serverReserveRef.current, rowsRef.current)),
      }),
    [game.id],
  );

  const save = useCallback(
    async (snapshot: BoardState, rev: number): Promise<LineupSaveOutcome> => {
      // 골키퍼가 어긋난 배치는 서버가 반려한다 — 보내지 않고 대기열에 남긴다.
      // 화면은 이미 이유를 말하고 있고(`gkIssue`), 고칠 때까지 턴도 나가지 않는다.
      if (gkCountOf(snapshot) !== 1)
        return { ok: false, error: "GK 자리가 한 곳이 될 때까지 저장이 보류됩니다", keep: true };
      setSaving(true);
      setSaveError(null);
      try {
        const res = await post(snapshot);
        const data = await res.json();
        if (!res.ok) {
          /**
           * 턴이 잠금을 쥐고 있다(`retry`) — 이 편집은 **대기열에 남는다.** 판은
           * 그대로 두고 다음 자동 저장이 같은 배치를 다시 보낸다 (models.md §1-1).
           */
          if (data.retry === true) {
            const busy = (data.error as string | undefined) ?? "저장 실패";
            setSaveError(busy);
            return { ok: false, error: busy, keep: true };
          }
          throw new Error(data.error ?? "저장 실패");
        }
        savedRevRef.current = rev;
        onUpdate(data);
        return { ok: true };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        setSaveError(error);
        return { ok: false, error };
      } finally {
        setSaving(false);
      }
    },
    [onUpdate, post],
  );

  /** 로컬 변경을 반영하고 저장을 예약한다 — 모든 전술판 조작이 이 문을 지난다 */
  /**
   * 편집 하나를 확정하고 자동 저장을 예약한다.
   *
   * 기본은 **선택 해제**다 — 배치를 바꾸면 고른 선수가 방금 다른 자리로 갔으므로
   * 그 선택을 들고 있을 이유가 없다. 다만 `keepSelection`을 주면 유지한다:
   * **세부 역할처럼 그 선수를 계속 보면서 고르는 조작**이 있다. 이걸 구분하지
   * 않던 때는 역할 알약을 누르는 순간 상세가 접혀서, 저장은 되는데 아무 일도
   * 일어나지 않은 것처럼 보였다.
   */
  const commit = useCallback(
    (next: BoardState, opts?: { keepSelection?: boolean }) => {
      revRef.current += 1;
      const rev = revRef.current;
      setBoard(next);
      if (opts?.keepSelection !== true) setSelection(null);
      saver.schedule(() => save(next, rev));
    },
    [save, saver],
  );

  // 서버 값이 바뀌면 작업 사본을 맞춘다. 저장 안 된 로컬 변경이 있으면 덮지 않는다
  // (드래그 중에 이전 저장의 응답이 도착하는 경우)
  useEffect(() => {
    if (revRef.current !== savedRevRef.current) return;
    setBoard(serverBoard);
    setAdvisoryPending(false);
  }, [serverBoard]);

  // 탭을 떠나 언마운트될 때 예약된 저장을 흘려보낸다 (마지막 조작을 잃지 않게).
  // 기다리지는 않지만 대기열이 그 요청을 쥐고 있어, 곧바로 나가는 턴은 이것부터 기다린다.
  useEffect(() => () => void saver.flush(), [saver]);

  const boardSlots: BoardSlot[] = board.points.map((point, i) => {
    const playerId = board.occupants[i];
    return playerId ? { playerId, point } : null;
  });
  // 실제 배치에서 읽어낸 포메이션 숫자 (드래그 중에도 즉시 갱신된다)
  const shape = shapeOf(board.points);
  const onPitch = new Set(board.occupants);
  // 로컬 편집 기준 — 방금 올린 2군 선수가 저장 전까지 2군 탭에 남아 있으면 안 된다
  const localReserve = new Set(board.reserve);
  const benchPlayers = players.filter((p) => !localReserve.has(p.id) && !onPitch.has(p.id));
  const benchSet = new Set(board.bench.filter((id) => !onPitch.has(id)));
  const benchDesignated = benchPlayers.filter((p) => benchSet.has(p.id));
  // Set·배열은 매 렌더 새 객체라 메모 의존성으로 못 쓴다 — 내용으로 만든 키를 쓴다
  const localReserveKey = board.reserve.join(",");
  const benchKey = [...benchSet].join(",");
  /**
   * 지금 화면의 역할 — **아직 저장되지 않은 선택까지 포함한다.**
   *
   * 칩·명단·상세가 저마다 `p.roleId`(서버 값)를 보던 때는 알약을 눌러도 숫자가
   * 자동 저장 왕복(3초)이 끝난 뒤에야 따라왔다. 감독이 "이 역할로 바꾸면 얼마가
   * 되나"를 손으로 더듬어 볼 수가 없다.
   */
  const roleOf = (p: SquadRow): string | undefined => {
    const i = board.occupants.indexOf(p.id);
    // 자리가 없으면 역할도 없다 (player.md §3.1)
    if (i < 0) return undefined;
    return board.roles[p.id] ?? roleAtSlot(p, positionAtPoint(board.points[i]!));
  };

  /**
   * 명단에 넘길 행 — **지금 화면의 배치·역할로 다시 맞춘 사본.**
   *
   * 서버가 준 `slotOverall`·`assignedPosition`·`adaptation`은 저장된 배치 기준이라
   * 자동 저장(3초)과 왕복이 끝나야 바뀐다. 칩은 이미 좌표에서 즉시 계산하고 있었고,
   * 명단만 한 박자 늦어 같은 선수의 두 숫자가 잠시 어긋나 보였다.
   *
   * ⚠️ 값은 `slotOverallOf` 하나가 낸다 — **전술판 칩과 같은 함수다.** 두 곳이
   * 따로 계산하던 때는 같은 선수의 OVR이 왼쪽과 오른쪽에서 다르게 보였다.
   */
  const localRows = useMemo(
    () =>
      players.map((p) => {
        const idx = board.occupants.indexOf(p.id);
        const code = idx >= 0 ? positionAtPoint(board.points[idx]!) : null;
        const role = board.roles[p.id] ?? (code ? roleAtSlot(p, code) : undefined);
        if (code === p.assignedPosition && role === (p.roleId ?? undefined)) return p;
        const fit = code ? positionProficiency(p.positions, code, p.foot) : p.positionFit;
        /**
         * 전술 적응도도 여기서 맞춘다 — 서버 값 그대로 두면 역할을 바꾼 직후
         * OVR만 움직이고 적응도는 옛 값에 머물러, **같은 화면의 두 숫자가 다른
         * 시점을 가리킨다** (player.md §7.2).
         *
         * ⚠️ **배치가 없던 선수는 아침 값부터 다르다.** 코어는 배치되는 순간
         * 선반(2군·예비를 다녀온 값)을 먼저 보고 없을 때만 `min(기준선, 팀 적응도)`를
         * 준다 — 그 규칙은 뷰가 `familiarityIfSlotted`로 이미 매겨 준다. 화면이 다시
         * 계산하면 돌아온 주전을 60으로 예고했다가 저장 응답에서 혼자 튄다.
         */
        const morning = p.role === "스쿼드" ? p.familiarityIfSlotted : p.familiarity;
        const familiarity =
          code && role ? familiarityForRole({ ...p, familiarity: morning }, code, role) : morning;
        return {
          ...p,
          assignedPosition: code,
          slotOverall: slotOverallOf(p, code, role),
          positionFit: fit,
          familiarity,
          adaptation: adaptationOf(fit, familiarity, code ?? p.assignedPosition ?? p.position),
        };
      }),
    [players, board.occupants, board.points, board.roles],
  );

  /** 감독이 고른 세부 역할의 지문 — 명단 표를 다시 그릴지 가리는 값 */
  const rolesKey = Object.entries(board.roles)
    .map(([id, role]) => `${id}:${role}`)
    .sort()
    .join(",");
  const onPitchKey = board.occupants.join(",");

  /** 비선발 선수를 매치데이 벤치(최대 9)로 지정/해제 — 나머지는 예비 스쿼드 */
  function toggleBench(id: string) {
    if (!live) return;
    const next = benchSet.has(id)
      ? board.bench.filter((x) => x !== id)
      : benchSet.size >= MATCHDAY_BENCH
        ? board.bench
        : [...board.bench, id];
    commit({ ...board, bench: next });
  }

  function changeTactics(patch: Partial<TacticsView>) {
    if (advisory) {
      // 경기 중 — 축 하나를 바꾸면 그 한 줄이 곧 지시다
      const [key, value] = Object.entries(patch)[0] ?? [];
      const axis = TACTIC_AXES.find((a) => a.key === key);
      if (!axis || typeof value !== "number") return;
      setBoard({ ...board, tactics: { ...board.tactics, [axis.key]: value } });
      setAdvisoryPending(true);
      return onOrder?.({ kind: "tactic", axis: axis.key, value });
    }
    if (!live) return;
    commit({ ...board, tactics: { ...board.tactics, ...patch } });
  }

  /**
   * 선택-스왑: 자리↔자리는 선수 교환(좌표는 그대로), 자리↔명단은 선수 교체.
   *
   * 이미 선발인 선수를 명단에서 골라 다른 자리에 넣으면 같은 선수가 두 자리에 앉는다.
   * 그 경로는 자리 교환으로 돌린다.
   */
  function applySwap(a: Selection, b: Selection) {
    if (!a || !b || !live) return;
    if (a.kind === "bench" && b.kind === "bench") return;
    if (a.kind === "bench") {
      const already = board.occupants.indexOf(a.id);
      if (already >= 0) return applySwap({ kind: "slot", index: already }, b);
    }
    if (b.kind === "bench") {
      const already = board.occupants.indexOf(b.id);
      if (already >= 0) return applySwap(a, { kind: "slot", index: already });
    }

    const occupants = [...board.occupants];
    let bench = [...board.bench];
    if (a.kind === "slot" && b.kind === "slot") {
      const tmp = occupants[a.index]!;
      occupants[a.index] = occupants[b.index]!;
      occupants[b.index] = tmp;
    } else {
      const slot = (a.kind === "slot" ? a : b) as { kind: "slot"; index: number };
      const incoming = (a.kind === "bench" ? a : b) as { kind: "bench"; id: string };
      // 2군 선수는 승격 전에는 라인업에 넣을 수 없다 (서버도 반려한다)
      if (byId.get(incoming.id)?.squadLevel === "reserve") return setSelection(null);
      const outgoing = occupants[slot.index]!;
      occupants[slot.index] = incoming.id;
      // 올라간 선수는 벤치 지정에서 빼고, 내려온 선수를 벤치에 넣는다
      bench = bench.filter((x) => x !== incoming.id);
      if (bench.length < MATCHDAY_BENCH) bench.push(outgoing);
    }
    commit(resetRolesForMovedPlayers({ ...board, occupants, bench }, byId));
  }

  /**
   * 자유 배치 — 한 자리의 좌표만 옮기고, 옮긴 자리를 고정한 채 나머지를 비켜세운다.
   * 격자에 맞춰(snapToBoard) 손으로 놓은 자리도 줄이 맞는다.
   */
  function repositionSlot(index: number, point: BoardPoint) {
    const points = [...board.points];
    points[index] = snapToBoard(point);
    const next = resetRolesForMovedPlayers(
      { ...board, points: separateBoardPoints(points, index) },
      byId,
    );
    if (advisory) {
      const playerId = board.occupants[index];
      const target = next.points[index];
      if (!playerId || !target) return;
      setBoard(next);
      setAdvisoryPending(true);
      return onOrder?.({
        kind: "position",
        playerId,
        position: positionAtPoint(target),
        point: target,
      });
    }
    if (live) commit(next);
  }

  /**
   * 전술판 칩을 누른다 — **고르기만 한다.** 누른다고 자리가 바뀌지 않는다.
   * 자리끼리 맞바꾸는 건 드래그뿐이고(칩을 끌어 다른 칩 위에), 명단에서 데려오는 건
   * 그 행의 화살표 버튼뿐이다. 같은 칩을 다시 누르면 선택이 풀린다.
   */
  function clickSlot(index: number) {
    const here: Selection = { kind: "slot", index };
    if (!usable) return setSelection(board.occupants[index] ? here : null);
    const same = selection?.kind === "slot" && selection.index === index;
    setSelection(same ? null : here);
  }

  /**
   * 명단에서 선수를 누른다 — **상세 보기뿐이다. 라인업은 절대 건드리지 않는다.**
   * 목록을 훑다가 선수 정보를 열었을 뿐인데 배치가 바뀌면 안 된다 —
   * 교체는 자리를 고른 뒤 그 행의 화살표 버튼으로만 일어난다.
   */
  function clickRoster(id: string) {
    const onBoardIndex = board.occupants.indexOf(id);
    const here: Selection =
      onBoardIndex >= 0 ? { kind: "slot", index: onBoardIndex } : { kind: "bench", id };
    const same =
      (selection?.kind === "slot" && selection.index === onBoardIndex) ||
      (selection?.kind === "bench" && selection.id === id);
    setSelection(same ? null : here);
  }

  /** 이 선수가 지금 속한 칸 */
  function tierOf(id: string): Tier {
    if (board.occupants.includes(id)) return "선발";
    if (board.reserve.includes(id)) return "2군";
    return board.bench.includes(id) ? "벤치" : "예비";
  }

  /**
   * 고른 선수와 이 행의 선수가 **칸을 맞바꾼다** — 명단 화살표가 부르는 유일한 경로.
   *
   * 선발·벤치·예비·2군 어떤 조합이든 성립한다: 둘이 서로의 자리를 그대로 넘겨받는다.
   * 2군이 끼면 승격·강등이 함께 일어나므로 1군 인원수는 변하지 않는다(한 명 올라오고
   * 한 명 내려간다) — 라우트가 승격→배치→강등 순으로 한 요청에 처리한다.
   */
  function swapWithRow(rowId: string) {
    if (advisory) {
      const aId = selection?.kind === "slot" ? board.occupants[selection.index] : selection?.id;
      if (!aId || aId === rowId) return;
      // 경기 중에 뜻이 있는 맞바꿈은 **그라운드 ↔ 벤치** 하나뿐이다
      const [outId, inId] = board.occupants.includes(aId) ? [aId, rowId] : [rowId, aId];
      if (!board.occupants.includes(outId) || board.occupants.includes(inId)) return;
      const occupants = [...board.occupants];
      const slot = occupants.indexOf(outId);
      if (slot < 0) return;
      occupants[slot] = inId;
      const bench = board.bench.filter((id) => id !== inId);
      if (bench.length < MATCHDAY_BENCH) bench.push(outId);
      // 장부를 직접 저장하지 않는다. 다음 진행 턴의 substitute 검증 전까지는 작업 사본이다.
      setBoard(resetRolesForMovedPlayers({ ...board, occupants, bench }, byId));
      setAdvisoryPending(true);
      setSelection(null);
      return onOrder?.({ kind: "substitution", out: outId, in: inId });
    }
    if (!live || !selection) return;
    const aId = selection.kind === "slot" ? board.occupants[selection.index] : selection.id;
    if (!aId) return;
    const swapped = swappedLists(board, aId, rowId);
    if (!swapped) return; // 같은 칸끼리는 바꿀 게 없다 (선발 자리 교환은 드래그)
    commit(resetRolesForMovedPlayers({ ...board, ...swapped }, byId));
  }

  /**
   * 칩 끌기 — 끌린 결과만 받는다. 다른 칩 위면 자리 교환(저장 가능할 때만),
   * 빈 곳이면 그 자리로 이동이다 (`board-drag.ts`).
   */
  const drag = useBoardDrag({
    boardRef,
    points: board.points,
    occupants: board.occupants,
    enabled: usable,
    onTap: clickSlot,
    onDrop: (index, point, onto) => {
      if (onto !== null && live) applySwap({ kind: "slot", index }, { kind: "slot", index: onto });
      else repositionSlot(index, point);
    },
  });

  const gkCount = gkCountOf(board);
  const gkIssue = live && gkCount !== 1;
  const gkSlotIdx = board.points.findIndex((p) => positionAtPoint(p) === "GK");
  const gkOccupant = gkSlotIdx >= 0 ? byId.get(board.occupants[gkSlotIdx] ?? "") : undefined;
  const gkWarning = live && gkOccupant && gkOccupant.positionGroup !== "GK";
  const xi = board.occupants
    .map((id) => byId.get(id))
    .filter((p): p is SquadRow => p !== undefined);
  const unavailableInXI = xi.filter((p) => !p.available);
  const unavailableOnBench = benchDesignated.filter((p) => !p.available);
  /**
   * 선발 평균 — **각자 그 자리에서 내는 값**의 평균이다 (칩에 쓰인 숫자 그대로).
   * `overall`로 재면 센터백을 윙에 세워도 평균이 꿈쩍하지 않아, 판을 잘못 짠 것이
   * 머리 요약에서만 멀쩡해 보인다.
   *
   * ⚠️ **화면이 값을 직접 내는 그 자리다** (overview §5). 전술판은 칩을 옮기는 3초
   * 동안 저장 전 배치를 그리므로 물어볼 뷰가 없다 — 대신 값을 내는 것은 서버와 같은
   * 함수(`slotOverallOf` → `observedFit`) 하나다. 경기 화면의 선발 평균은 저장된
   * 배치라 뷰가 낸다(`match.xiRating`).
   */
  const xiRating =
    xi.length > 0
      ? Math.round(
          xi.reduce((s, p, i) => {
            const point = board.points[board.occupants.indexOf(p.id)] ?? board.points[i];
            const code = point ? positionAtPoint(point) : null;
            return s + (slotOverallOf(p, code, roleOf(p)) ?? p.overall);
          }, 0) / xi.length,
        )
      : 0;
  const misfits = board.points
    .map((point, i) => ({ p: byId.get(board.occupants[i] ?? ""), code: positionAtPoint(point) }))
    // 낯선 자리의 경계는 도메인이 갖는다 — 여기 숫자를 두면 판정이 두 곳이 된다
    .filter((x) => x.p && isUnfamiliarPosition(fitAt(x.p, x.code).value));

  const selectedPlayer =
    selection?.kind === "slot"
      ? byId.get(board.occupants[selection.index] ?? "")
      : selection?.kind === "bench"
        ? byId.get(selection.id)
        : undefined;
  const selectedSlotCode =
    selection?.kind === "slot" && board.points[selection.index]
      ? positionAtPoint(board.points[selection.index]!)
      : null;
  // 자리를 고르면 명단이 "이 자리에 넣을 선수 고르기" 모드가 된다
  /**
   * 교체 짝 — 고른 선수 하나가 정해지면 **칸이 다른** 모든 행에 화살표가 뜬다.
   * 선발·벤치·예비·2군 어느 조합이든 열린다 (같은 칸끼리만 닫힌다 — 선발 자리
   * 맞바꾸기는 드래그의 몫이라서다).
   */
  const swapPair = (() => {
    if (!usable || !selection) return null;
    const id = selection.kind === "slot" ? (board.occupants[selection.index] ?? "") : selection.id;
    if (!id) return null;
    return { id, name: byId.get(id)?.name ?? "", tier: tierOf(id), slotCode: selectedSlotCode };
  })();
  /** 행마다의 칸 — 로컬 편집 반영 (뷰의 role·squadLevel은 저장 전까지 옛 값이다) */
  const tierById = useStable((id: string): Tier => tierOf(id));
  // 명단에 넘기는 콜백은 전부 신원을 고정한다 (위 useStable 주석 참고)
  const onSelectRow = useStable(clickRoster);
  const onToggleBenchRow = useStable(toggleBench);
  const onSwapInRow = useStable(swapWithRow);
  const onRoleRow = useStable(chooseRole);
  const onMoveSquadRow = useStable(moveSquad);
  // 새 기준은 큰 값부터 보는 게 자연스럽다 — 칸 순(기본)만 위에서 아래로 읽는다
  const onSortRow = useStable((key: SortKey) =>
    setSort((prev) => ({ key, desc: prev.key === key ? !prev.desc : key !== "role" })),
  );

  /**
   * 1·2군 이동 — **다른 조작과 같은 문을 지난다.**
   *
   * 단독 왕복이던 때는 이 버튼만 스피너가 돌았고, 판을 짜는 동안 그 한 요청이
   * 자동 저장과 순서를 다퉜다. `lineupBody`가 서버와 달라진 `reserve`를
   * `squadLevels` 차이로 실어 보내고, 라우트가 승격 → 배치 → 강등 순으로 처리한다.
   */
  function moveSquad(playerId: string, level: "first" | "reserve") {
    if (!live) return;
    const reserve = board.reserve.filter((x) => x !== playerId);
    // 강등은 매치데이 벤치 지정도 함께 거둔다 — 코어가 배치에서 빼기 때문이다(`setSquadLevel`)
    commit({
      ...board,
      reserve: level === "reserve" ? [...reserve, playerId] : reserve,
      bench: level === "reserve" ? board.bench.filter((x) => x !== playerId) : board.bench,
    });
  }

  /**
   * 역할 선택 — **다른 조작과 같은 문을 지난다.**
   * 알약을 누를 때마다 요청을 보내면 결정 하나가 요청 여럿이 되고, 감독이
   * 고르는 동안 서버가 계속 값을 매긴다. 정해진 값 하나만 자동 저장에 실린다.
   */
  function chooseRole(playerId: string, role: string) {
    if (advisory) {
      setBoard({ ...board, roles: { ...board.roles, [playerId]: role } });
      setAdvisoryPending(true);
      return onOrder?.({ kind: "role", playerId, role });
    }
    if (!live) return;
    // 상세를 열어 둔 채 고른다 — 역할은 비교하며 바꾸는 값이다
    commit({ ...board, roles: { ...board.roles, [playerId]: role } }, { keepSelection: true });
  }

  /**
   * 칩의 클래스 — **자리의 색과 상태의 테두리는 다른 채널이다.**
   *
   * 색(배경)은 "이 자리가 무슨 자리인가"를 말한다: 최전방 붉게 · 중원 초록 ·
   * 수비 파랑 · 골키퍼 노랑. 판을 훑을 때 라인이 색 띠로 먼저 읽힌다.
   * 테두리는 **상태**가 이미 쓰고 있다(선택=초록, 못 뛰는 선수=빨강) — 여기에
   * 자리 색까지 얹으면 초록 테두리가 "고른 것"인지 "미드필더"인지 알 수 없다.
   *
   * 색의 근거는 선수의 주 포지션군이 아니라 **지금 서 있는 자리**다. 센터백을
   * 윙에 세우면 그 칩은 최전방 색이어야 판이 실제 배치대로 읽힌다.
   */
  const chipClass = (p: SquadRow | undefined, selected: boolean, code: string | null) => {
    const group = code ? (positionGroupOf(code) ?? null) : null;
    return (
      `${group ? `g-${group.toLowerCase()}` : ""}` +
      `${selected ? " selected" : ""}${p && !p.available ? " unavailable" : ""}`
    );
  };

  /**
   * 명단은 **드래그 프레임마다 다시 그리지 않는다.** 43행 × (게이지·상태바·화살표
   * SVG)를 초당 60번 새로 만들면 정작 손에 붙어야 할 칩이 늦어진다. 드래그가 바꾸는
   * 건 칩 좌표뿐이고 명단은 그와 무관하므로, 드래그 상태를 뺀 값들로만 메모한다.
   */
  const rosterTable = useMemo(
    () => (
      <SquadTable
        players={localRows.filter((p) =>
          squadFilter === "reserve" ? localReserve.has(p.id) : !localReserve.has(p.id),
        )}
        sort={sort}
        onSort={onSortRow}
        selectedId={selectedPlayer?.id ?? null}
        onSelect={onSelectRow}
        swapPair={swapPair}
        tierOf={tierById}
        tierKey={`${onPitchKey}|${benchKey}|${localReserveKey}`}
        onSwapIn={onSwapInRow}
        renderDetail={(p) => (
          <PlayerDetail
            p={p}
            slotCode={p.id === selectedPlayer?.id ? selectedSlotCode : null}
            onRole={usable ? (role) => onRoleRow(p.id, role) : undefined}
            roleId={board.roles[p.id] ?? p.roleId}
            action={
              <>
                {/* 벤치 지정 — 명단의 배지 열을 없앤 뒤 이 조작이 여기로 왔다.
                비선발 1군에게만 뜻이 있다 (선발은 이미 나가고, 2군은 승격이 먼저) */}
                {live && !onPitch.has(p.id) && !localReserve.has(p.id) && (
                  <button
                    className="ghost-btn"
                    disabled={saving}
                    data-testid={`benchtoggle-${p.id}`}
                    onClick={() => onToggleBenchRow(p.id)}
                  >
                    {benchSet.has(p.id) ? "벤치에서 빼기" : "매치데이 벤치로"}
                  </button>
                )}
                {/* 선발을 그대로 내리면 판이 열 명이 된다 — 코어가 배치에서 함께 빼기 때문이다.
                옆의 벤치 지정이 선발 행에서 빠져 있는 것과 같은 이유다 */}
                <button
                  className="ghost-btn"
                  disabled={!live || onPitch.has(p.id)}
                  /* 잠긴 이유는 **사실로만** — 다음에 무엇을 하라는 말은 붙이지 않는다 */
                  title={
                    !live
                      ? dismissed
                        ? "무직 — 전술판 잠금"
                        : "경기 중 — 1·2군 이동 잠금"
                      : onPitch.has(p.id)
                        ? "선발 배치 중 — 1·2군 이동 잠금"
                        : undefined
                  }
                  onClick={() => onMoveSquadRow(p.id, localReserve.has(p.id) ? "first" : "reserve")}
                >
                  {localReserve.has(p.id) ? "1군 승격" : "2군 강등"}
                </button>
              </>
            }
          />
        )}
      />
    ),
    /**
     * ⚠️ 집합·표는 **문자열 열쇠로** 싣는다 (`localReserveKey`·`benchKey`·
     * `onPitchKey`·`rolesKey`). `Set`과 객체는 내용이 같아도 렌더마다 새 객체라,
     * 그것을 그대로 실으면 메모가 매번 깨져 아무것도 아끼지 못한다. 규칙은 열쇠가
     * 무엇을 대신하는지 볼 수 없어 원본이 빠졌다고 읽는다.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      localRows,
      squadFilter,
      localReserveKey,
      sort,
      // 감독이 고른 세부 역할 — 이게 없으면 알약을 눌러도 표가 다시 그려지지 않아
      // 선택이 화면에 안 나타난다(저장은 되는데 아무 일도 안 일어난 것처럼 보인다)
      rolesKey,
      selectedPlayer?.id,
      selectedSlotCode,
      benchKey,
      onPitchKey,
      live,
      dismissed,
      saving,
      swapPair?.id,
      swapPair?.tier,
      swapPair?.slotCode,
      onSelectRow,
      onToggleBenchRow,
      onSwapInRow,
      onRoleRow,
      onMoveSquadRow,
      onSortRow,
      tierById,
    ],
  );

  return (
    /*
     * 저장 상태는 **글자가 아니라 속성**으로만 남긴다. 화면에 "저장됨"을 띄우면
     * 자동 저장이라 늘 켜져 있는 등이 되지만, 테스트는 저장이 끝났는지를
     * 결정적으로 기다릴 수 있어야 한다.
     */
    <div
      className={`squad-view${boardOpen ? "" : " folded"}`}
      data-testid="view-squad"
      data-save={
        advisory
          ? advisoryPending
            ? "pending"
            : "ready"
          : !live
            ? "locked"
            : saving
              ? "saving"
              : dirty
                ? "dirty"
                : "saved"
      }
    >
      <div className="squad-head">
        <div className="squad-summary">
          <span>
            {/* 이름은 실제 배치에서 읽는다 — 칩을 옮기면 숫자가 바로 따라 바뀐다 */}
            <b data-testid="shape">{shape}</b> · 선발 평균 <b>{xiRating}</b>
          </span>
          {/* 1군·2군 인원은 오른쪽 명단 탭이 이미 세어 준다 — 여기선 매치데이 인원만 */}
          <span className="muted">매치데이 {xi.length + benchDesignated.length}인</span>
          {advisoryPending && (
            <span className="reg-chip" data-testid="match-orders-pending">
              다음 진행에 반영
            </span>
          )}
          {/* 등록 명단 — 영입·승격의 진짜 벽이라 늘 보여야 한다 (U21은 명단 밖) */}
          <span
            className={`reg-chip${squad.registration.issues.length > 0 ? " over" : ""}`}
            data-testid="registration"
            title={
              squad.registration.issues.length > 0
                ? squad.registration.issues.join(" / ")
                : `21세 초과 ${squad.registration.limit}명까지 · 그중 홈그로운 ${squad.registration.homegrownMin}명 이상 · U21 ${squad.registration.under21}명은 명단 밖`
            }
          >
            등록 <b>{squad.registration.listed}</b>/{squad.registration.limit} · HG{" "}
            <b>{squad.registration.homegrown}</b>/{squad.registration.homegrownMin}
          </span>
          {/**
           * 전술판 손잡이 — **글자가 아니라 상태로 알린다.**
           *
           * 눌린 채로 남는 버튼이라 지금 펼쳐져 있는지가 모양에 드러난다. 안내
           * 문구를 붙이지 않는 것도 같은 이유다 — 누르면 판이 열리는 것을 보면 안다.
           * 요약 줄 안에 두는 이유는 머리글이 **두 칸짜리 격자**이기 때문이다:
           * 세 번째 칸으로 세우면 책갈피가 명단에서 한 줄 떨어진다.
           */}
          {onToggleBoard && (
            <button
              className={`board-toggle${boardOpen ? " on" : ""}`}
              onClick={onToggleBoard}
              aria-pressed={boardOpen}
              data-testid="board-toggle"
            >
              <IconBoard />
              전술판
            </button>
          )}
        </div>
        {/*
         * 저장 상태는 적지 않는다 — 자동 저장이라 "저장됨"은 늘 켜져 있는 등이고,
         * 늘 켜진 등은 아무것도 알리지 않으면서 머리글 오른쪽을 차지한다.
         * **실패했을 때만** 아래 경고 줄이 말한다.
         */}
        {/*
         * 명단 머리(책갈피 + 정원)는 **위 요약 줄의 오른쪽 칸**에 선다.
         *
         * 명단 열 안에 두면 그 줄 높이(31px)만큼 표가 전술판보다 내려가 두 열의
         * 윗변이 어긋난다. 이 줄이 `squad-layout`과 **같은 그리드**를 쓰므로
         * 책갈피는 여전히 명단 바로 위에 서고, 표와도 이어진다.
         */}
        <div className="roster-head">
          {/* 책갈피 — 고른 쪽이 아래 명단과 한 장으로 이어진다 */}
          <div className="roster-tabs" role="tablist">
            {(
              [
                ["first", "1군", players.length - localReserve.size],
                ["reserve", "2군", localReserve.size],
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                role="tab"
                aria-selected={squadFilter === key}
                className={`roster-tab${squadFilter === key ? " on" : ""}`}
                onClick={() => setSquadFilter(key)}
              >
                {label}
                <span className="roster-tab-n">{count}</span>
              </button>
            ))}
          </div>
          {/* 조작법 대신 숫자만 — 벤치 정원이 몇 자리 남았는지가 유일하게 필요한 정보다 */}
          <span className="roster-counts" data-testid="bench-count">
            벤치 {benchDesignated.length}/{MATCHDAY_BENCH} · 예비{" "}
            {benchPlayers.length - benchDesignated.length}
          </span>
        </div>
        {/* 무직 잠금은 버튼이 아니다 — 돌아갈 경기가 없고, 판의 잠긴 모양이 이미 말한다 */}
        {!live && !advisory && !dismissed && (
          <button className="ghost-btn" onClick={onGoToChat}>
            경기 중 — 채팅으로
          </button>
        )}
      </div>

      {(gkIssue ||
        gkWarning ||
        unavailableInXI.length > 0 ||
        unavailableOnBench.length > 0 ||
        misfits.length > 0 ||
        saveError) && (
        <div className="lineup-status warn" data-testid="lineup-status">
          {/* 경고는 사실만 — "교체하세요" 같은 지시나 규칙 설명은 붙이지 않는다.
              저장이 멈추는 GK 문제만 이유를 밝힌다 (안 그러면 왜 안 되는지 모른다) */}
          {gkIssue && <div>⚠ GK 자리 {gkCount}곳 — 한 명이 될 때까지 저장이 보류됩니다.</div>}
          {gkWarning && <div>⚠ GK 자리에 필드 플레이어</div>}
          {unavailableInXI.length > 0 && (
            <div>⚠ 선발 불가(부상·정지): {unavailableInXI.map((p) => p.name).join(", ")}</div>
          )}
          {unavailableOnBench.length > 0 && (
            <div>⚠ 벤치에 출전 불가: {unavailableOnBench.map((p) => p.name).join(", ")}</div>
          )}
          {misfits.length > 0 && (
            <div>⚠ 낯선 자리: {misfits.map((x) => `${x.p!.name}(${x.code})`).join(", ")}</div>
          )}
          {saveError && <div data-testid="lineup-error">{saveError}</div>}
        </div>
      )}

      {/* 왼쪽 전술판 · 오른쪽 명단 — 한 화면에서 보고 바로 조작한다.
          접으면 명단만 남아 채팅 옆에 설 수 있다 */}
      <div className="squad-layout">
        {/* 접힘은 **CSS가 정한다** — 채팅이 옆에 설 만큼 넓을 때만 뜻이 있고,
            좁은 화면에서는 접어도 남는 자리를 명단이 늘어나 채울 뿐이다 */}
        <div className="squad-board-col">
          {/**
           * 판과 전술 줄은 **한 덩어리다** — 채팅 위에 얹힐 때 둘이 한 장으로 붙는다.
           * 평소 레이아웃에서는 `display: contents`라 이 래퍼가 없는 것과 같다.
           */}
          <div className="board-stack">
            {/* 그라운드와 칩은 상대 판과 **같은 컴포넌트**다 (pitch.tsx) — 상태만 얹는다 */}
            <PitchGround
              boardRef={boardRef}
              variant={usable ? "editing" : "locked"}
              testId="pitch-board"
              tactics={board.tactics}
            >
              {boardSlots.map((slot, i) => {
                const p = slot ? byId.get(slot.playerId) : undefined;
                // 끌고 있는 칩은 미리보기 좌표로 그린다 (놓기 전엔 실제 배치를 안 바꾼다)
                const dragging = drag.index === i;
                const point = dragging && drag.point ? drag.point : slot?.point;
                const code = point ? positionAtPoint(point) : null;
                /**
                 * 칩의 전력은 **좌표에서 즉시** 나온다 — 서버가 준 값은 저장된 배치
                 * 기준이라 자동 저장(`AUTOSAVE_MS`)과 왕복이 끝나야 바뀌는데, 끌어
                 * 놓고 한 박자 뒤에 숫자가 따라오면 "이 자리로 옮기면 얼마가 되나"를
                 * 손으로 더듬어 볼 수가 없다.
                 *
                 * ⚠️ 계산은 **명단과 같은 함수**(`slotOverallOf`)다. 여기서만 `roleFit`을
                 * 다시 굴리던 때는 같은 선수의 OVR이 칩과 명단에서 달랐다.
                 */
                const liveOverall = p ? slotOverallOf(p, code, roleOf(p)) : null;
                const selected = selection?.kind === "slot" && selection.index === i;
                /**
                 * 맡은 역할 — **기본 역할이 아닐 때만** 칩에 뜬다.
                 * 전원에게 붙이면 열한 칩이 다 같은 말(센터백·풀백·윙어)을 달고 있어
                 * 읽히지 않는다. 감독이 실제로 **고른** 것만 보이면 판을 훑을 때
                 * 그 선택이 눈에 남는다. 표기는 FM 약칭(BPD·IWB·RGA)이다 —
                 * 칩에 들어갈 만큼 짧으면서 감독이 이미 아는 말이다.
                 */
                const liveRole = p ? roleOf(p) : undefined;
                const roleTag =
                  p && code && liveRole && liveRole !== defaultRoleOf(code)
                    ? (rolesFor(code).find((r) => r.id === liveRole) ?? null)
                    : null;
                if (!point) return null;
                return (
                  <PitchChip
                    key={i}
                    as="button"
                    variant={`${chipClass(p, selected, code)}${dragging ? " dragging" : ""}`}
                    style={{ left: `${point.x}%`, top: `${point.y}%` }}
                    onPointerDown={(e) => drag.onPointerDown(i, e)}
                    onClick={() => {
                      // 완전히 잠긴 판만 포인터 핸들러가 없으므로 여기서 상세를 연다
                      if (!usable) clickSlot(i);
                    }}
                    testId={`slot-${i}`}
                    title={
                      p
                        ? // 명단 OVR 칸의 툴팁과 **같은 두 줄**이다 — 같은 숫자를
                          // 두 화면에서 다른 말로 설명하면 규칙이 없어 보인다
                          [
                            `${p.name}`,
                            `${code} 자리 기준 ${liveOverall ?? p.overall} — 경기에서 쓰이는 값입니다`,
                            liveOverall !== null && liveOverall !== p.overall
                              ? `주 포지션(${p.position}) 기준 ${p.overall}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join("\n")
                        : (code ?? "")
                    }
                    code={code}
                    squadNumber={p?.squadNumber}
                    roleTag={roleTag}
                    captain={p?.isCaptain}
                    name={p?.name ?? null}
                    /* 칩은 "그 자리에 선 선수"라 주 포지션 값이 아니라 자리 값이 맞다.
                         자리가 안 맞으면 이 숫자가 이미 낮다 — 옆에 "포지션 적응도"를
                         따로 세우면 감독이 두 축을 머리로 합쳐야 한다 (적응도는 하나다).
                         툴팁이 주 포지션 값을 갖는다 */
                    ovr={p ? (liveOverall ?? p.overall) : ""}
                    metaExtra={
                      p && (
                        <>
                          <Margin observation={p.observation} />
                          {!p.available && <span className="slot-flag">✖</span>}
                          {p.hasIssue && <span className="slot-flag warn">!</span>}
                        </>
                      )
                    }
                  />
                );
              })}
            </PitchGround>

            <TacticsPanel tactics={board.tactics} editing={usable} onChange={changeTactics} />
          </div>
        </div>

        <div className="squad-side-col">
          <div className="roster-scroll">{rosterTable}</div>
        </div>
      </div>
    </div>
  );
}
