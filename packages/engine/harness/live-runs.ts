import type { MatchRecord, MatchSide, MatchStatLine, TacticsSpec } from "@story-fm/domain";
import { playLiveToEnd, possessionOf, sideStatLine, type LiveMatch } from "@story-fm/sim";
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
