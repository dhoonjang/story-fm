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
 * 그 판정은 이 파일의 `needsExtraTime` 하나가 갖는다: 대회마다 따로 판단하면
 * 어느 하나만 고쳐도 두 대회의 규칙이 조용히 갈린다.
 *
 * **감독의 경기는 여기를 지나지 않는다.** 구간 시뮬이 120분까지 가므로
 * (`match-engine.ts`의 `extra_first`·`extra_second`) 연장의 교체·카드·부상이
 * 다 장부에 남고, 그 경기는 `MatchResult.aet` 표식이 붙어 이 함수를 통과한다 —
 * 그게 **이중 적용의 문지기**다. 나머지 2,000여 경기는 여기서 한 번에 굴러간다:
 * 우리 컵 8강도 남의 8강도 같은 규칙을 지난다.
 */

/**
 * 연장을 뛰는 인원 — 출전 명단의 앞 열한 명.
 *
 * 90분에 누가 서 있었는지는 결과에 남지 않는다(교체 기록은 장부에 없다).
 * 유저 경기의 명단은 종료 시점 온필드가 앞에 오고, 간이 시뮬은 선발이 앞에 온다.
 */
const EXTRA_TIME_XI = 11;

/**
 * 대진 번호 — 녹아웃 경기 id에 박혀 있다 (`...-p{대진}-l{차수}`).
 *
 * 국내 컵과 대항전이 같은 규칙으로 id를 만들므로 여기 한 벌만 둔다.
 */
export function pairOf(match: MatchRecord): number {
  return Number(/-p(\d+)-l\d+$/.exec(match.id)?.[1] ?? 0);
}

/** 이 경기가 속한 대진의 모든 차전 — 차수 순. 녹아웃이 아니면 자기 자신뿐이다 */
function tieLegs(state: GameState, match: MatchRecord): MatchRecord[] {
  const pair = pairOf(match);
  return state.matches
    .filter(
      (m) =>
        m.season === match.season &&
        m.competitionId === match.competitionId &&
        m.stage === match.stage &&
        pairOf(m) === pair,
    )
    .sort((a, b) => a.round - b.round);
}

/**
 * **이 경기 뒤에 연장이 붙는가** — 연장 판정의 단일 지점.
 *
 * 리그·친선·대항전 리그 페이즈는 무승부로 그냥 끝난다(`stage`가 없거나 `league`).
 * 녹아웃은 **마지막 다리**(단판 또는 2차전)에서, 그리고 **합계가 같을 때만** 간다 —
 * 1차전 무승부는 연장이 아니다.
 *
 * 진행 중인 경기(장부 스코어)와 이미 끝난 경기(`result`)를 같은 잣대로 재려고
 * 스코어를 인자로 받는다. 없으면 저장된 결과를 읽는다.
 */
export function needsExtraTime(
  state: GameState,
  match: MatchRecord,
  score?: { home: number; away: number },
): boolean {
  const stage = match.stage ?? "league";
  if (stage === "league") return false;

  const legs = tieLegs(state, match);
  // 2차전제의 1차전은 비겨도 연장이 없다 — 승부는 마지막 다리가 가린다
  if (legs.length > 0 && legs[legs.length - 1]!.id !== match.id) return false;

  const now =
    score ?? (match.result ? { home: match.result.homeGoals, away: match.result.awayGoals } : null);
  if (!now) return false;

  // 앞 차전에서 넘어온 합계 — 이 경기의 홈·원정 기준으로 뒤집어 더한다
  const carry = tieAggregate(
    legs.filter((m) => m.id !== match.id),
    match,
  );
  return carry.home + now.home === carry.away + now.away;
}

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
 * 그릴 때마다 연장이 다시 굴러가면 스코어가 계속 자란다. 감독이 구간 시뮬로
 * 직접 치른 연장에도 `aet`가 붙어 있으므로 여기서 두 번 굴러가지 않는다.
 *
 * @returns 이번 호출에서 연장을 치렀으면 true
 */
export function resolveExtraTime(state: GameState, decider: MatchRecord, channel: string): boolean {
  const result = decider.result;
  if (!result || result.aet) return false;
  // 연장이 필요한 경기인지도 같은 문에서 묻는다 — 호출부마다 따로 판단하지 않는다
  if (!needsExtraTime(state, decider)) return false;

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
  result.homeXg = (result.homeXg ?? 0) + extra.homeXg;
  result.awayXg = (result.awayXg ?? 0) + extra.awayXg;
  result.homeExpectedGoals = (result.homeExpectedGoals ?? 0) + extra.homeExpectedGoals;
  result.awayExpectedGoals = (result.awayExpectedGoals ?? 0) + extra.awayExpectedGoals;
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
