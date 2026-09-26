import type { MatchRecord, MatchSide, MatchStatLine, TacticsSpec } from "@story-fm/domain";
import { otherSide, weightSlotOf } from "@story-fm/domain";
import {
  depthOf,
  playLiveToEnd,
  possessionOf,
  sideStatLine,
  type LiveMatch,
  type LiveTickObserver,
} from "@story-fm/sim";
import { buildAiLiveMatch, leagueOfTeamIn, type GameState } from "@story-fm/engine";

/**
 * 실시간 경기 하네스들이 같이 쓰는 실행기 — 두 AI 팀의 경기를 화면 없이 끝까지 굴리고
 * 팀-경기 표본으로 접는다. 하네스가 아니라서 `*.harness.ts`가 아니다.
 */

/** 두 AI 팀의 경기를 종료 휘슬까지 — 러너의 화면 없는 실행기 그대로다 */
export const playToEnd = playLiveToEnd;

/** 킥오프 전술을 갈아 끼운 AI 경기 — 벤치가 옮기는 기준도 이 값이다 */
export function liveMatchWith(
  state: GameState,
  fixture: MatchRecord,
  tactics?: Partial<Record<MatchSide, Partial<TacticsSpec>>>,
): LiveMatch {
  const live = buildAiLiveMatch(state, fixture);
  for (const side of ["home", "away"] as const) {
    const over = tactics?.[side];
    if (!over) continue;
    live.tactics[side] = { ...live.tactics[side], ...over };
    live.setup.sides[side].kickoffTactics = { ...live.setup.sides[side].kickoffTactics, ...over };
  }
  return live;
}

export interface TeamSample {
  teamId: string;
  side: MatchSide;
  goals: number;
  line: MatchStatLine;
  possession: number;
  yellows: number;
  reds: number;
}

export interface MatchSample {
  teams: TeamSample[];
  home: number;
  away: number;
  /** 추가시간을 넣은 경기 길이 (분) */
  length: number;
  /** 볼 인플레이 몫 — 재시작이 아닌 시간 ÷ 경기 시간 */
  inPlay: number;
}

export function sampleOf(match: LiveMatch): MatchSample {
  const possession = possessionOf(match);
  const events = match.ledger.events;
  const addedOf = (type: string) => events.find((e) => e.type === type)?.added ?? 0;
  const length = 90 + addedOf("half_time") + addedOf("full_time");
  const played = match.state.possessionTime.home + match.state.possessionTime.away;
  const teams = (["home", "away"] as const).map((side) => ({
    teamId: match.setup.sides[side].teamId,
    side,
    goals: match.ledger.score[side],
    line: sideStatLine(match.ledger, side),
    possession: possession[side],
    yellows: events.filter((e) => e.type === "yellow_card" && e.team === side).length,
    reds: events.filter((e) => e.type === "red_card" && e.team === side).length,
  }));
  return {
    teams,
    home: match.ledger.score.home,
    away: match.ledger.score.away,
    length,
    inPlay: played / (length * 60),
  };
}

/** 감독 리그의 대진 앞에서부터 `count`경기 */
export function leagueFixtures(state: GameState, count: number): MatchRecord[] {
  const league = leagueOfTeamIn(state, state.userTeamId);
  return state.matches
    .filter((m) => m.competitionId === league && m.stage === "league")
    .slice(0, count);
}

export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
export const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
export const median = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};
export const share = (xs: number[], test: (x: number) => boolean) =>
  xs.filter(test).length / Math.max(1, xs.length);

/** 정렬한 표본의 분위 — 0..1 */
export const quantile = (xs: number[], q: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
};

/** 풀백의 깊이를 이만큼 틱마다 적는다 — 1초 */
const DEPTH_SAMPLE_TICKS = 20;

/**
 * 장부에 없는 배치를 재는 관찰자 — 슈팅 순간 공보다 골 쪽에 선 수비 필드 선수 수와,
 * 풀백마다 경기 중 선 깊이(우리 골라인에서)의 표본 (live-match.md §3.3 · §5.2).
 */
export interface ShapeProbe {
  onTick: LiveTickObserver;
  /** 슈팅 한 번마다 — 공보다 골 쪽의 수비 필드 선수 수 */
  goalSide: number[];
  /** 풀백 id → 1초마다의 깊이 */
  fullBackDepths: Map<string, number[]>;
  /** 풀백 id → 우리가 공을 가졌을 때 달리기(`run`)를 시작한 횟수 — 오버래핑·침투 */
  fullBackRuns: Map<string, number>;
}

export function shapeProbe(): ShapeProbe {
  const probe: ShapeProbe = {
    onTick: () => {},
    goalSide: [],
    fullBackDepths: new Map(),
    fullBackRuns: new Map(),
  };
  let lastShot: Record<MatchSide, number> | null = null;
  const running = new Set<string>();
  probe.onTick = (state, input) => {
    const slotOf = (id: string) =>
      weightSlotOf(
        (
          input.home.slots.find((s) => s.player.id === id) ??
          input.away.slots.find((s) => s.player.id === id)
        )?.position ?? "",
      );
    for (const side of ["home", "away"] as const) {
      if (lastShot && state.lastShotAt[side] !== lastShot[side] && !state.restart) {
        const defending = otherSide(side);
        const ballDepth = depthOf(state.ball.x, defending);
        probe.goalSide.push(
          state.players.filter(
            (p) =>
              p.side === defending && slotOf(p.id) !== "GK" && depthOf(p.x, defending) < ballDepth,
          ).length,
        );
      }
    }
    lastShot = { ...state.lastShotAt };
    for (const p of state.players) {
      const run = p.action === "run" && p.side === state.possession;
      if (run && !running.has(p.id) && slotOf(p.id) === "FB") {
        probe.fullBackRuns.set(p.id, (probe.fullBackRuns.get(p.id) ?? 0) + 1);
      }
      if (run) running.add(p.id);
      else running.delete(p.id);
    }
    if (state.tick % DEPTH_SAMPLE_TICKS !== 0 || state.restart) return;
    for (const p of state.players) {
      if (slotOf(p.id) !== "FB") continue;
      const depths = probe.fullBackDepths.get(p.id) ?? [];
      depths.push(depthOf(p.x, p.side));
      probe.fullBackDepths.set(p.id, depths);
    }
  };
  return probe;
}
