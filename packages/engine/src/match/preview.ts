import type {
  ExploitTarget,
  GamePlayer,
  MatchRecord,
  MatchSide,
  PacketTag,
  PacketTagContext,
  StrengthPacket,
  TacticsSpec,
} from "@story-fm/domain";
import { isReserveMatch, naturalPositionOf, packetTagContext } from "@story-fm/domain";
import { buildStrengthPacket, type LineupSlot } from "@story-fm/sim";
import { competitionLabel } from "../data/cup-catalog";
import { derbyForMatch } from "../club/derby";
import { DEFAULT_KICKOFF, diffDays, nextMatchFor } from "../competition/calendar";
import {
  activeSuspension,
  assignmentsOf,
  firstTeamPlayers,
  isAvailable,
  openInjury,
  tacticsOf,
  teamNameIn,
  teamShortNameIn,
  type GameState,
} from "../core/state";
import { assembleUserLineup, directivesOnPitch, slotsFor } from "./match-flow";
import { managerTacticsOf } from "./manager-tactics";

/**
 * 경기 전 상대 분석 — **패킷을 미리 한 번 굴린다** (match.md §1.8).
 *
 * 감독이 라인업과 6축을 정하는 시점은 경기 전인데 판세·키포인트·상성이 첫 진행
 * 턴부터만 실리면, 그의 **분석**과 **전술** 능력은 이미 정해진 판 위에서만 뜻을
 * 갖는다. 그래서 예정된 경기 하나를 골라 킥오프와 **같은 문**(`buildStrengthPacket`
 * → `readKeyPoints`)을 미리 지난다 — 다른 계산이 아니라 같은 계산을 일찍 하는 것뿐이다.
 */

/** 예상 XI 한 명 */
export interface ProjectedPlayer {
  id: string;
  name: string;
  position: string;
  squadNumber: number | null;
  /**
   * 직전 경기 선발에서 **그대로 이어진 이름인가.** `false`면 코어가 메운 자리라
   * 근거가 다르다 — 리포트를 읽는 쪽이 추정과 관측을 갈라 세워야 감독이 예상을
   * 확정으로 읽지 않는다.
   */
  carried: boolean;
}

/**
 * 결장 사유의 이름 — 조회 도구와 GM 스냅샷이 **같은 낱말**을 쓴다.
 * 갈래가 이 파일의 것이므로 이름도 여기 산다.
 */
export const ABSENT_REASON_KO: Record<"injury" | "suspension", string> = {
  injury: "부상",
  suspension: "정지",
};

/** 못 나오는 선수 — 부상·정지는 공개 기록이라 흐리지 않는다 (player.md §10) */
export interface AbsentPlayer {
  id: string;
  name: string;
  position: string;
  reason: "injury" | "suspension";
  /** 부상은 복귀 예정일, 정지는 남은 경기 수 */
  note: string;
}

export interface OpponentReport {
  matchId: string;
  date: string;
  /** 킥오프 시각 `20:00` */
  time: string;
  /** 어느 경기인가 — `프리미어리그 7R` */
  label: string;
  /** 오늘로부터 며칠 뒤인가 — 0이면 오늘이다 */
  inDays: number;
  venue: "home" | "away" | "neutral";
  opponent: { id: string; name: string; short: string };
  /** 우리는 어느 편인가 — 태그의 유불리를 접는 기준 */
  ourSide: MatchSide;
  /** 상대 예상 XI — 직전 경기 선발에서 투영 (`projectXI`) */
  expectedXI: ProjectedPlayer[];
  /**
   * 투영의 근거가 된 상대의 **직전 1군 경기** — 없으면 `null`(개막전·신생 구단).
   * 근거를 함께 내지 않으면 읽는 쪽이 예상을 확정으로 옮긴다.
   */
  basis: { matchId: string; date: string; label: string } | null;
  /** 부상·정지로 못 나오는 상대 선수 */
  absent: AbsentPlayer[];
  /** 상대가 세워 둔 모양과 6축 — 90분 동안 보이는 사실이라 흐리지 않는다 (match.md §8) */
  shape: TacticsSpec;
  /**
   * 감독의 눈을 지난 사실 — **상성과 키포인트뿐이다** (match.md §1.8).
   * 문장은 읽는 쪽이 `packetTagText`로 만든다.
   */
  notes: PacketTag[];
  /**
   * 겨냥할 수 있는 지점 — **라인업이 그대로면 킥오프 패킷의 표적과 같은 id다.**
   * 표적 id가 `축:선수id`라(match.md §1.6) 이 등식이 곧 "경기 전에 노린 지점을
   * 경기 중에 그대로 부를 수 있다"는 뜻이다.
   */
  targets: ExploitTarget[];
  /** 태그가 이름을 대는 자리 — 미리 굴린 그 패킷이 원본이다 */
  tagContext: PacketTagContext;
}

/**
 * 리포트가 세우는 사실 — 대진의 조건(더비)·상성·키포인트. 나머지 갈래는 경기
 * 중의 것이다 (match.md §1.8): 구멍은 그라운드에서 보이는 사실이고, 공략과 지역
 * 플랜은 킥오프 뒤에만 걸 수 있다.
 */
const REPORT_SOURCES: ReadonlySet<PacketTag["source"]> = new Set([
  "context",
  "counter",
  "mismatch",
]);

/** 상대의 직전 1군 경기 — 그 경기가 이미 벌어졌다는 것이 투영의 유일한 근거다 */
function lastPlayedBefore(
  state: GameState,
  teamId: string,
  before: MatchRecord,
): MatchRecord | null {
  let best: MatchRecord | null = null;
  for (const m of state.matches) {
    if (!m.result || isReserveMatch(m)) continue;
    if (m.homeTeamId !== teamId && m.awayTeamId !== teamId) continue;
    if (m.date > before.date || m.id === before.id) continue;
    if (best === null || m.date > best.date || (m.date === best.date && m.id > best.id)) best = m;
  }
  return best;
}

/**
 * 상대 예상 XI — **직전 경기 선발 + 가용**으로 투영한다 (match.md §1.8).
 *
 * `simSquadOf`를 부르지 않는 것이 이 함수의 전부다. 그쪽은 로테이션·임대 빚까지
 * 반영해 **내일 실제로 설 열한 명**을 돌려주므로, 경기 전에 보여 주는 순간 감독은
 * 상대 벤치의 결정을 미리 읽는다. 여기서 쓰는 것은 감독이 실제로 관측할 수 있는
 * 것뿐이다 — 이미 벌어진 경기의 선발, 그리고 공개 기록인 부상·정지·대표팀 소집.
 */
function projectXI(
  state: GameState,
  teamId: string,
  basis: MatchRecord | null,
): { xi: GamePlayer[]; carried: Set<string> } {
  const squad = firstTeamPlayers(state, teamId);
  const byId = new Map(squad.map((p) => [p.id, p] as const));
  const available = (p: GamePlayer) => isAvailable(state, p.id);

  const started =
    basis === null
      ? []
      : ((basis.homeTeamId === teamId ? basis.result?.homeStarters : basis.result?.awayStarters) ??
        []);
  const xi: GamePlayer[] = [];
  const carried = new Set<string>();
  const seen = new Set<string>();
  const seat = (p: GamePlayer | undefined, from: "carried" | "guess") => {
    if (!p || xi.length >= 11 || seen.has(p.id) || !available(p)) return;
    seen.add(p.id);
    xi.push(p);
    if (from === "carried") carried.add(p.id);
  };

  // ① 직전 경기 선발 중 지금 뛸 수 있는 사람
  for (const id of started) seat(byId.get(id), "carried");
  // ② 빈자리는 그 팀 전술판의 선발 배치에서
  for (const a of assignmentsOf(state, teamId, "starting")) seat(byId.get(a.playerId), "guess");
  // ③ 그래도 모자라면 가용 1군 종합 상위
  for (const p of [...squad].sort((a, b) => b.attributes.overall - a.attributes.overall)) {
    seat(p, "guess");
  }
  return { xi, carried };
}

/** 상대의 결장자 — 부상이 먼저, 그다음 정지. 같은 갈래 안에서는 이름 순 */
function absentOf(state: GameState, teamId: string): AbsentPlayer[] {
  const rows: AbsentPlayer[] = [];
  for (const p of firstTeamPlayers(state, teamId)) {
    const injury = openInjury(state, p.id);
    if (injury) {
      rows.push({
        id: p.id,
        name: p.name,
        position: naturalPositionOf(p).position,
        reason: "injury",
        note: `${injury.bodyPart} ~${injury.expectedReturn}`,
      });
      continue;
    }
    const suspension = activeSuspension(state, p.id);
    if (!suspension) continue;
    rows.push({
      id: p.id,
      name: p.name,
      position: naturalPositionOf(p).position,
      reason: "suspension",
      note: `${suspension.lengthMatches - suspension.served}경기`,
    });
  }
  return rows.sort(
    (a, b) =>
      (a.reason === b.reason ? 0 : a.reason === "injury" ? -1 : 1) || (a.id < b.id ? -1 : 1),
  );
}

/** 우리 쪽은 킥오프에 설 그 열한 명이다 — 자동 대체까지 지난 뒤라야 판이 같다 */
function ourSlots(state: GameState): LineupSlot[] | null {
  const lineup = assembleUserLineup(state);
  if (lineup.error) return null;
  return slotsFor(state, state.userTeamId, lineup.onPitch);
}

/**
 * 다음 경기를 고른다 — id를 주면 그것, 아니면 우리 다음 경기.
 * 끝난 경기·2군 경기·우리가 없는 경기는 리포트의 대상이 아니다.
 */
function pickPreviewMatch(state: GameState, matchId?: string): MatchRecord | null {
  if (matchId === undefined) return nextMatchFor(state.matches, state.userTeamId, state.date);
  const m = state.matches.find((x) => x.id === matchId);
  if (!m || m.result || isReserveMatch(m)) return null;
  if (m.homeTeamId !== state.userTeamId && m.awayTeamId !== state.userTeamId) return null;
  return m;
}

/**
 * 경기 전 상대 분석 리포트 — 예정된 우리 경기 하나. 없으면 `null`.
 *
 * **경기 중에는 서지 않는다.** 90분 안에 다음 상대를 분석하는 자리는 없고, 지금
 * 판은 판세 화면이 이미 들고 있다 (match.md §8). 진행 중인 장부를 읽는
 * `slotsFor`가 다른 경기의 교체를 우리 배치에 얹는 것도 이 문이 막는다.
 */
export function buildOpponentReport(
  state: GameState,
  options: {
    /** 이 경기 하나 — 주지 않으면 우리 다음 경기다 */
    matchId?: string;
    /**
     * 며칠 앞까지만 세우는가 — 넘으면 **패킷을 굴리기 전에** 빈손을 낸다.
     * 경기 전날에만 서는 자리(GM 스냅샷)가 매 턴 패킷 한 벌을 굴릴 이유는 없다.
     */
    withinDays?: number;
  } = {},
): OpponentReport | null {
  if (state.pendingMatch) return null;
  const match = pickPreviewMatch(state, options.matchId);
  if (!match) return null;
  if (options.withinDays !== undefined && diffDays(state.date, match.date) > options.withinDays) {
    return null;
  }

  const userIsHome = match.homeTeamId === state.userTeamId;
  const opponentId = userIsHome ? match.awayTeamId : match.homeTeamId;
  const ourSide: MatchSide = userIsHome ? "home" : "away";

  const us = ourSlots(state);
  if (!us) return null;

  /**
   * 전술이 없는 팀은 리포트를 세울 수 없다 — 대조할 판이 없다. 뷰가 매 턴 부르는
   * 자리라 `tacticsOf`의 예외로 오피스 화면 전체를 떨구지 않는다.
   */
  const theirTactics = state.tactics.find((t) => t.teamId === opponentId);
  if (!theirTactics) return null;

  const basis = lastPlayedBefore(state, opponentId, match);
  const { xi, carried } = projectXI(state, opponentId, basis);
  if (xi.length === 0) return null;
  /**
   * 자리를 앉히는 것도 **킥오프와 같은 함수**다 (`slotsFor`). 여기서 자연 포지션으로
   * 대신 세우면, 배치에 없는 선수가 낀 XI에서 리포트와 킥오프가 다른 판을 보고
   * 표적 id가 갈린다 — 감독이 경기 전에 노린 지점이 킥오프에 사라진다.
   */
  const theirSlots: LineupSlot[] = slotsFor(
    state,
    opponentId,
    xi.map((p) => p.id),
  );

  const sideOf = (
    teamId: string,
    starters: LineupSlot[],
    ours: boolean,
  ): Parameters<typeof buildStrengthPacket>[0] => {
    const tactics = tacticsOf(state, teamId);
    return {
      teamId,
      teamName: teamNameIn(state, teamId),
      starters,
      /**
       * **벤치는 세우지 않는다** — 상대 벤치는 관측할 수 없고, 리포트가 읽는 것
       * (키포인트·상성)은 선발 열한 명만 본다.
       */
      bench: [],
      tactics: tactics.spec,
      managerTactics: managerTacticsOf(state, teamId),
      ...(tactics.setPieceTakers ? { setPieceTakers: tactics.setPieceTakers } : {}),
      // 감독의 눈은 우리 쪽에만 — 킥오프 패킷과 같은 규약 (match-flow의 `buildPacketFor`)
      ...(ours ? { managerAnalysis: state.manager.attributes.analysis } : {}),
      directives: directivesOnPitch(
        state,
        teamId,
        starters.map((s) => s.player.id),
      ),
    };
  };

  /**
   * 더비는 **대진이 갖고 있는 사실**이라 킥오프 패킷과 같은 자리에서 온다
   * (`derbyForMatch` — team.md §3.2). 경기 전 리포트가 그것을 빠뜨리면 감독은
   * 킥오프에야 무슨 경기인지 안다.
   *
   * `inMatch`는 서지 않는다 — 벤치에서 외치는 조정이 더 잘 먹히는 보정(§1.2)은
   * 그라운드 위의 것이다. 표적 목록은 이 값을 보지 않으므로 킥오프와 갈리지 않는다.
   */
  const derby = derbyForMatch(match);
  const packet: StrengthPacket = buildStrengthPacket(
    userIsHome ? sideOf(match.homeTeamId, us, true) : sideOf(match.homeTeamId, theirSlots, false),
    userIsHome ? sideOf(match.awayTeamId, theirSlots, false) : sideOf(match.awayTeamId, us, true),
    {
      neutral: match.neutral === true,
      inMatch: false,
      ...(derby ? { derby: { name: derby.name, heat: derby.heat } } : {}),
    },
  );

  return {
    matchId: match.id,
    date: match.date,
    time: match.time ?? DEFAULT_KICKOFF,
    label: competitionLabel(match.competitionId, match.stage ?? "league", match.round),
    inDays: Math.max(0, diffDays(state.date, match.date)),
    venue: match.neutral ? "neutral" : userIsHome ? "home" : "away",
    opponent: {
      id: opponentId,
      name: teamNameIn(state, opponentId),
      short: teamShortNameIn(state, opponentId),
    },
    ourSide,
    expectedXI: theirSlots.map((slot) => ({
      id: slot.player.id,
      name: slot.player.name,
      position: slot.position,
      squadNumber: slot.player.squadNumber ?? null,
      carried: carried.has(slot.player.id),
    })),
    basis: basis
      ? {
          matchId: basis.id,
          date: basis.date,
          label: competitionLabel(basis.competitionId, basis.stage ?? "league", basis.round),
        }
      : null,
    absent: absentOf(state, opponentId),
    shape: { ...theirTactics.spec },
    notes: packet.keyPoints.filter((tag) => REPORT_SOURCES.has(tag.source)),
    targets: packet.targets,
    tagContext: packetTagContext(packet),
  };
}
