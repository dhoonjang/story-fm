import type { GamePlayer, MatchRecord } from "@story-fm/domain";
import { clampCondition, naturalPositionOf } from "@story-fm/domain";
import { conditionDrain, drainVariance } from "@story-fm/sim";
import { EXTRA_TIME_MINUTES, simulateExtraTime } from "../match/quick-sim";
import { simSquadFor } from "../core/tick";
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

/** 한 팀이 그라운드에 세우는 인원 — 옛 세이브의 명단을 자를 때만 쓴다 */
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

/**
 * **경기를 끝낸 사람들** — 연장을 뛰고 페널티를 차는 열한 명(퇴장이 있었으면 그보다 적다).
 *
 * 명단(`homeLineup`)은 **뛴 사람 전부**라 앞 열한 명을 자르면 교체로 나간 선수와
 * 퇴장당한 선수가 연장을 뛴다. 그래서 두 시뮬 다 종료 시점 온필드를 따로 남기고
 * (`homeOnPitch`) 여기가 그것을 읽는다 — 그게 없는 옛 세이브에서만 명단 앞 열한
 * 명으로, 명단조차 없으면 1군 상위로 물러선다 (match.md §7).
 */
export function finishingXi(
  state: GameState,
  match: MatchRecord,
  side: "home" | "away",
): GamePlayer[] {
  const result = match.result;
  const teamId = side === "home" ? match.homeTeamId : match.awayTeamId;
  const onPitch = side === "home" ? result?.homeOnPitch : result?.awayOnPitch;
  const lineup = side === "home" ? result?.homeLineup : result?.awayLineup;
  const listed = (onPitch ?? (lineup ?? []).slice(0, EXTRA_TIME_XI))
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
    home: finishingXi(state, decider, "home"),
    away: finishingXi(state, decider, "away"),
  };
  /**
   * **전력 모델은 90분과 같은 원본에서 선다** — 전술판의 자리·좌표·역할, 팀 전술,
   * 개인 적응도, 감독의 전술 눈금까지 `simSquadFor`가 한 벌로 세운다. 팀 id와
   * 선수 목록만 넘기면 패킷이 자연 포지션·기본 전술·적응도 60·감독 65로 서서
   * 연장에서만 약팀이 살아나거나 죽는다 (match.md §7).
   */
  const extra = simulateExtraTime(
    simSquadFor(state, decider.homeTeamId, xi.home),
    simSquadFor(state, decider.awayTeamId, xi.away),
    state.seed,
    channel,
    { neutral: decider.neutral === true },
  );

  result.aet = true;
  result.homeGoals += extra.homeGoals;
  result.awayGoals += extra.awayGoals;
  result.homeShots = (result.homeShots ?? 0) + extra.homeShots;
  result.awayShots = (result.awayShots ?? 0) + extra.awayShots;
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
