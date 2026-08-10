import type { GamePlayer, MatchRecord } from "@story-fm/domain";
import { clampCondition, naturalPositionOf } from "@story-fm/domain";
import { conditionDrain, drainVariance } from "@story-fm/sim";
import { EXTRA_TIME_MINUTES, simulateExtraTime } from "../match/quick-sim";
import {
  assignmentsOf,
  ensureSeasonStat,
  firstTeamPlayers,
  playerById,
  pushNarrative,
  tacticsOf,
  teamShortName,
  type GameState,
} from "../core/state";

/**
 * 연장 30분 — 녹아웃에서 승부가 갈리지 않았을 때 **승부차기보다 먼저** 치른다.
 *
 * 유럽 대항전과 국내 컵이 같은 문을 쓴다 (승부차기와 같은 자리). 단판은 90분이
 * 같을 때, 2차전제는 **합계가 같을 때만** — 1차전 무승부는 연장이 아니다.
 *
 * 연장은 90분 장부가 이미 닫힌 뒤에 굴러간다. 그래서 코어가 결정적으로 굴리고
 * 결과를 그 경기 장부에 이어 붙인다 — 유저 경기도 마찬가지다(구간 시뮬은 90분에서
 * 끝난다). 감독이 연장 30분을 지휘하지는 못하지만, **리그가 우리만의 규칙으로
 * 돌지는 않는다**: 우리 컵 8강도 남의 8강도 같은 함수를 지난다.
 */

/**
 * 연장을 뛰는 인원 — 출전 명단의 앞 열한 명.
 *
 * 90분에 누가 서 있었는지는 결과에 남지 않는다(교체 기록은 장부에 없다).
 * 유저 경기의 명단은 종료 시점 온필드가 앞에 오고, 간이 시뮬은 선발이 앞에 온다.
 */
const EXTRA_TIME_XI = 11;

/** 대진 합계 — 마지막 경기(단판·2차전)의 홈·원정 기준 */
export function tieAggregate(
  legs: readonly MatchRecord[],
  decider: MatchRecord,
): { home: number; away: number } {
  const goals = new Map<string, number>();
  for (const leg of legs) {
    const r = leg.result;
    if (!r) continue;
    goals.set(leg.homeTeamId, (goals.get(leg.homeTeamId) ?? 0) + r.homeGoals);
    goals.set(leg.awayTeamId, (goals.get(leg.awayTeamId) ?? 0) + r.awayGoals);
  }
  return {
    home: goals.get(decider.homeTeamId) ?? 0,
    away: goals.get(decider.awayTeamId) ?? 0,
  };
}

/** 그 팀이 연장을 뛰는 열한 명 — 명단이 없는 옛 기록은 1군 상위로 채운다 */
function extraTimeXi(state: GameState, teamId: string, lineup: string[] | undefined): GamePlayer[] {
  const listed = (lineup ?? [])
    .slice(0, EXTRA_TIME_XI)
    .map((id) => playerById(state, id))
    .filter((p): p is GamePlayer => p !== null && p.teamId === teamId);
  if (listed.length > 0) return listed;
  return [...firstTeamPlayers(state, teamId)]
    .sort((a, b) => b.attributes.overall - a.attributes.overall)
    .slice(0, EXTRA_TIME_XI);
}

/** 골 목록에 연장 골을 이어 붙인다 — 세 배열의 길이는 언제나 같다 */
function appendGoals(
  result: NonNullable<MatchRecord["result"]>,
  added: { scorers: string[]; assists: string[]; goalMinutes: number[] },
): void {
  const count = result.scorers.length;
  const assists = result.assists ?? new Array<string>(count).fill("");
  const minutes = result.goalMinutes ?? new Array<number>(count).fill(0);
  result.scorers = [...result.scorers, ...added.scorers];
  result.assists = [...assists, ...added.assists];
  result.goalMinutes = [...minutes, ...added.goalMinutes];
}

/**
 * 연장 30분을 치른다 — 이미 치른 경기면 아무 일도 하지 않는다(`aet`).
 *
 * 대진 승자를 묻는 자리에서 호출되므로 **멱등**이어야 한다: 화면이 브래킷을
 * 그릴 때마다 연장이 다시 굴러가면 스코어가 계속 자란다.
 *
 * @returns 이번 호출에서 연장을 치렀으면 true
 */
export function resolveExtraTime(state: GameState, decider: MatchRecord, channel: string): boolean {
  const result = decider.result;
  if (!result || result.aet) return false;

  const xi = {
    home: extraTimeXi(state, decider.homeTeamId, result.homeLineup),
    away: extraTimeXi(state, decider.awayTeamId, result.awayLineup),
  };
  const extra = simulateExtraTime(
    { teamId: decider.homeTeamId, starters: xi.home },
    { teamId: decider.awayTeamId, starters: xi.away },
    state.seed,
    channel,
    { neutral: decider.neutral === true },
  );

  result.aet = true;
  result.homeGoals += extra.homeGoals;
  result.awayGoals += extra.awayGoals;
  appendGoals(result, extra);

  // 연장 골도 시즌 기록이다 — 출전(apps)은 90분에 이미 쌓였으므로 골·도움만 얹는다
  for (const side of ["home", "away"] as const) {
    const teamId = side === "home" ? decider.homeTeamId : decider.awayTeamId;
    const idOf = (tag: string) => (tag.startsWith(`${side}:`) ? tag.slice(side.length + 1) : null);
    for (const tag of extra.scorers) {
      const id = idOf(tag);
      if (id) ensureSeasonStat(state, id, teamId).goals += 1;
    }
    for (const tag of extra.assists) {
      const id = idOf(tag);
      if (!id) continue;
      const stat = ensureSeasonStat(state, id, teamId);
      stat.assists = (stat.assists ?? 0) + 1;
    }
  }

  // 30분치 피로 — 자리·전술·지구력은 90분과 같은 함수가 정한다
  for (const side of ["home", "away"] as const) {
    const teamId = side === "home" ? decider.homeTeamId : decider.awayTeamId;
    const spec = tacticsOf(state, teamId).spec;
    const slotOf = new Map(assignmentsOf(state, teamId).map((a) => [a.playerId, a.position]));
    for (const player of xi[side]) {
      const position = slotOf.get(player.id) ?? naturalPositionOf(player).position;
      const today = drainVariance(`${state.seed}:${decider.id}:${player.id}`);
      player.state.condition = clampCondition(
        player.state.condition - conditionDrain(player, position, spec, EXTRA_TIME_MINUTES, today),
      );
    }
  }

  if (decider.homeTeamId === state.userTeamId || decider.awayTeamId === state.userTeamId) {
    pushNarrative(
      state,
      `${teamShortName(decider.homeTeamId)} vs ${teamShortName(decider.awayTeamId)} 연장 승부 (${result.homeGoals}-${result.awayGoals})`,
      4,
    );
  }
  return true;
}
