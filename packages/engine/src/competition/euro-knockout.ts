import type { MatchRecord, MatchStage } from "@story-fm/domain";
import { addDays, sortEntries } from "./calendar";
import {
  CUP_CATALOG,
  competitionShortName,
  cupCatalogById,
  knockoutStages,
  stageLabel,
  type CupCatalogEntry,
} from "../data/cup-catalog";
import { completeDraw, drawIsDue, scheduleDraw } from "./draw-schedule";
import { knockoutDates } from "./europe";
import { payLeaguePhasePrizes, payStagePrizes } from "./euro-prize";
import { makeRng } from "../core/rng";
import { pairOf, resolveExtraTime, tieAggregate } from "./extra-time";
import { shootout } from "./shootout";
import { pushNarrative, teamName, teamShortName, type GameState } from "../core/state";
import { computeStandings } from "./season";

/**
 * 유럽 대항전 녹아웃 — 리그 페이즈가 끝난 뒤부터 결승까지.
 *
 * 대진을 시즌 시작에 미리 짤 수 없다 (누가 올라올지 모른다). 그래서 **단계가
 * 끝나면 다음 단계를 만드는** 진행형이다. `advanceEuroKnockouts`가 매일 tick에서
 * 호출되고, 직전 단계가 완결됐을 때만 다음 단계를 편성한다. 날짜는 시즌 시작에
 * 이미 예약돼 있으므로(`knockoutDates`) 리그 일정과 부딪히지 않는다.
 *
 * 2차전제는 합계 득점으로 가리고, 같으면 승부차기다 (원정 다득점 규칙은 2021년에
 * 폐지됐다). 결승은 중립 경기장 단판.
 */

/** 녹아웃 경기 id — 단계·대진 번호·차수를 id에 박아 브래킷 순서를 잃지 않는다 */
function knockoutId(cupId: string, season: number, stage: MatchStage, pair: number, leg: number) {
  return `m-${cupId}-${season}-${stage}-p${pair}-l${leg}`;
}


/** 이 대회 이 단계의 경기 — 대진 번호, 그다음 차수 순 */
export function euroStageMatches(
  state: GameState,
  cupId: string,
  stage: MatchStage,
): MatchRecord[] {
  return state.matches
    .filter((m) => m.season === state.season && m.competitionId === cupId && m.stage === stage)
    .sort((a, b) => pairOf(a) - pairOf(b) || a.round - b.round);
}

/** 리그 페이즈 완주 여부 — 녹아웃 편성의 전제 */
export function euroLeaguePhaseDone(state: GameState, cupId: string): boolean {
  const phase = state.matches.filter(
    (m) =>
      m.season === state.season && m.competitionId === cupId && (m.stage ?? "league") === "league",
  );
  return phase.length > 0 && phase.every((m) => m.result !== null);
}

/**
 * 대진의 승자 — 두 경기(또는 결승 한 경기)가 모두 끝났을 때만.
 * 합계가 같으면 **연장 30분**을 치르고(`extra-time.ts`), 그래도 같으면 승부차기
 * 결과를 2차전 장부에 기록하고 그것으로 가린다.
 */
export function euroTieWinner(
  state: GameState,
  cupId: string,
  stage: MatchStage,
  pair: number,
): string | null {
  const legs = euroStageMatches(state, cupId, stage).filter((m) => pairOf(m) === pair);
  if (legs.length === 0 || legs.some((m) => !m.result)) return null;

  const decider = legs[legs.length - 1]!;
  const channel = `${cupId}:${stage}:${pair}`;
  /** 지금 합계로 갈리는 쪽 — 같으면 null */
  const level = () => {
    const agg = tieAggregate(legs, decider);
    if (agg.home === agg.away) return null;
    return agg.home > agg.away ? decider.homeTeamId : decider.awayTeamId;
  };
  const regulation = level();
  if (regulation) return regulation;

  resolveExtraTime(state, decider, channel);
  const afterExtra = level();
  if (afterExtra) return afterExtra;

  const pens =
    decider.result!.penalties ?? shootout(state, decider.homeTeamId, decider.awayTeamId, channel);
  decider.result!.penalties = pens;
  return pens.home > pens.away ? decider.homeTeamId : decider.awayTeamId;
}

/** 리그 페이즈 최종 순위 — 시드의 원본 (녹아웃 경기는 순위표에 들어가지 않는다) */
function leaguePhaseSeeds(state: GameState, cupId: string): string[] {
  return computeStandings(state, cupId).map((r) => r.teamId);
}

/** 이 팀의 리그 페이즈 순위 (0-based) — 홈/원정 이점 배정에 쓴다 */
function seedIndex(seeds: string[], teamId: string): number {
  const i = seeds.indexOf(teamId);
  return i < 0 ? seeds.length : i;
}

function registerUserEntries(state: GameState, matches: MatchRecord[]): void {
  const ours = matches.filter(
    (m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId,
  );
  if (ours.length === 0) return;
  for (const m of ours) {
    state.schedule.push({
      id: `se-${m.id}`,
      date: m.date,
      time: m.time ?? "21:00",
      type: "match",
      refId: m.id,
      teamId: state.userTeamId,
      status: "scheduled",
    });
  }
  state.schedule = sortEntries(state.schedule);
}

/** 대진 하나를 2차전제로 만든다 — 상위 시드가 2차전 홈 */
function createTie(
  state: GameState,
  cup: CupCatalogEntry,
  stage: MatchStage,
  pair: number,
  better: string,
  worse: string,
): MatchRecord[] {
  const dates = knockoutDates(state.season, stage);
  const twoLegged = stage !== "final";
  if (!twoLegged) {
    return [
      {
        id: knockoutId(cup.id, state.season, stage, pair, 1),
        season: state.season,
        competitionId: cup.id,
        stage,
        round: 1,
        date: dates[0]!,
        time: "21:00",
        neutral: true,
        homeTeamId: better,
        awayTeamId: worse,
        result: null,
      },
    ];
  }
  return [0, 1].map((leg) => ({
    id: knockoutId(cup.id, state.season, stage, pair, leg + 1),
    season: state.season,
    competitionId: cup.id,
    stage,
    round: leg + 1,
    date: dates[leg] ?? dates[0]!,
    time: "21:00",
    // 1차전은 하위 시드 홈, 2차전은 상위 시드 홈 (실제 대회의 이점 배분)
    homeTeamId: leg === 0 ? worse : better,
    awayTeamId: leg === 0 ? better : worse,
    result: null,
  }));
}

/** 한 단계를 편성한다 — 참가 팀을 대진으로 묶어 경기를 만든다 */
function createStage(
  state: GameState,
  cup: CupCatalogEntry,
  stage: MatchStage,
  pairs: Array<[string, string]>,
  digest: string[],
): void {
  const seeds = leaguePhaseSeeds(state, cup.id);
  const created: MatchRecord[] = [];
  pairs.forEach(([a, b], pair) => {
    const better = seedIndex(seeds, a) <= seedIndex(seeds, b) ? a : b;
    const worse = better === a ? b : a;
    created.push(...createTie(state, cup, stage, pair, better, worse));
  });
  state.matches.push(...created);
  registerUserEntries(state, created);
  payStagePrizes(state, cup.id, stage, pairs.flat(), digest);

  const short = competitionShortName(cup.id);
  const label = stageLabel(stage, 1, false);
  const ours = created.find(
    (m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId,
  );
  if (ours) {
    const opponent = ours.homeTeamId === state.userTeamId ? ours.awayTeamId : ours.homeTeamId;
    digest.push(`🎫 ${short} ${label} 대진 확정 — 상대는 ${teamName(opponent)} (${ours.date})`);
    pushNarrative(state, `${short} ${label} 진출 — vs ${teamName(opponent)}`, 4);
  } else {
    digest.push(
      `${short} ${label} 대진: ${pairs
        .slice(0, 4)
        .map(([a, b]) => `${teamShortName(a)}–${teamShortName(b)}`)
        .join(", ")}${pairs.length > 4 ? " 등" : ""}`,
    );
  }
}

/** 플레이오프 대진 — 상위 시드(직행 다음 순위)가 하위 시드를 만난다 */
function playoffPairs(cup: CupCatalogEntry, seeds: string[]): Array<[string, string]> {
  const pool = seeds.slice(cup.directSlots, cup.directSlots + cup.playoffSlots);
  const half = pool.length / 2;
  return Array.from({ length: half }, (_, i) => [pool[i]!, pool[pool.length - 1 - i]!]);
}

/**
 * 본선 첫 단계 대진 — 직행 팀과 플레이오프 승자를 붙인다.
 * 상위 시드가 하위(=플레이오프를 거친) 팀을 만나는 것은 실제 대회와 같고,
 * 어느 승자를 만나는지는 시드 해시로 결정적으로 추첨한다.
 */
function mainDrawPairs(
  state: GameState,
  cup: CupCatalogEntry,
  seeds: string[],
  winners: string[],
): Array<[string, string]> {
  const direct = seeds.slice(0, cup.directSlots);
  const rng = makeRng(state.seed, `draw:${cup.id}:${state.season}`);
  const pool = [...winners];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return direct.map((teamId, i) => [teamId, pool[i] ?? pool[pool.length - 1]!]);
}

/** 브래킷 순서대로 인접한 두 팀을 붙인다 (승자 위치가 다음 대진을 정한다) */
function pairUp(teams: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i + 1 < teams.length; i += 2) pairs.push([teams[i]!, teams[i + 1]!]);
  return pairs;
}

/**
 * 대항전 녹아웃 진행 — 매일 tick에서 호출된다.
 *
 * 대회마다 "다음에 만들어야 할 단계"를 찾아 하나만 편성한다. 편성은 직전 단계가
 * 완결된 직후(= 예약된 날짜보다 몇 주 앞)에 일어나므로 감독의 달력에 미리 오른다.
 * 편성이 곧 **한 번만 일어나는 사건**이므로 진출·탈락 보고도 이때 함께 낸다
 * (매일 호출되는 함수에서 중복 보고를 피하는 가장 단순한 방법이다).
 * 우승·트로피는 시즌 리뷰가 맡는다 (`reviewSeason` — 결승은 리그 종료 뒤에 열린다).
 */
export function advanceEuroKnockouts(state: GameState, digest: string[]): void {
  for (const cup of CUP_CATALOG) {
    if (!euroLeaguePhaseDone(state, cup.id)) continue;
    // 참가비·승무 수당 — 리그 페이즈가 끝나면 한 번에 정산된다
    payLeaguePhasePrizes(state, cup.id, digest);
    const stages = knockoutStages(cup);
    const seeds = leaguePhaseSeeds(state, cup.id);
    let previousWinners: string[] | null = null;

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i]!;
      const existing = euroStageMatches(state, cup.id, stage);
      if (existing.length === 0) {
        const previous = i > 0 ? stages[i - 1]! : null;
        const pairs =
          stage === "playoff"
            ? playoffPairs(cup, seeds)
            : previousWinners === null
              ? // 플레이오프 없는 대회 — 리그 페이즈 상위가 곧 본선 대진
                pairUp(seeds.slice(0, cup.directSlots))
              : previous === "playoff"
                ? mainDrawPairs(state, cup, seeds, previousWinners)
                : pairUp(previousWinners);
        if (pairs.length === 0) break;
        // 추첨은 며칠 뒤 — 그 사이 감독은 달력에서 "누가 걸릴까"를 기다린다.
        // 결승만 예외다: 준결승 승자 둘이 곧 대진이라 뽑을 게 없다.
        if (stage === "final") {
          if (previous && previousWinners) {
            reportOurTie(state, cup, previous, previousWinners, digest);
          }
        } else {
          // 예약이 새로 잡히는 순간에만 직전 라운드 결과를 보고한다 (중복 방지)
          if (scheduleEuroDraw(state, cup, stage, pairs.flat(), digest)) {
            if (previous && previousWinners) {
              reportOurTie(state, cup, previous, previousWinners, digest);
            }
          }
          if (!drawIsDue(state, cup.id, stage)) break;
        }
        createStage(state, cup, stage, pairs, digest);
        completeDraw(state, cup.id, stage);
        break; // 한 번에 한 단계만 — 다음 단계는 이 단계가 끝난 뒤
      }
      const pairCount = new Set(existing.map((m) => pairOf(m))).size;
      const winners: string[] = [];
      for (let pair = 0; pair < pairCount; pair++) {
        const winner = euroTieWinner(state, cup.id, stage, pair);
        if (winner) winners.push(winner);
      }
      if (winners.length < pairCount) break; // 아직 진행 중
      previousWinners = winners;
    }
  }
}

/** 대항전 라운드 사이 추첨 — 직전 라운드가 끝나고 며칠 뒤, 늦어도 1차전 전날 */
const EURO_DRAW_LEAD_DAYS = 4;

function scheduleEuroDraw(
  state: GameState,
  cup: CupCatalogEntry,
  stage: MatchStage,
  participants: string[],
  digest: string[],
): boolean {
  const firstLeg = knockoutDates(state.season, stage)[0];
  const latest = firstLeg ? addDays(firstLeg, -1) : addDays(state.date, EURO_DRAW_LEAD_DAYS);
  const soonest = addDays(state.date, EURO_DRAW_LEAD_DAYS);
  const date = soonest < latest ? soonest : latest;
  const forUser = participants.includes(state.userTeamId);
  const created = scheduleDraw(state, cup.id, stage, date, forUser);
  if (created && forUser) {
    const short = competitionShortName(cup.id);
    digest.push(`🎲 ${short} ${stageLabel(stage, 1, false)} 대진 추첨 — ${date}`);
  }
  return created;
}

/** 우리 팀이 뛴 단계의 결과 보고 — 다음 단계 편성과 같은 시점에 한 번만 */
function reportOurTie(
  state: GameState,
  cup: CupCatalogEntry,
  stage: MatchStage,
  winners: string[],
  digest: string[],
): void {
  const played = euroStageMatches(state, cup.id, stage).some(
    (m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId,
  );
  if (!played) return;
  const short = competitionShortName(cup.id);
  const label = stageLabel(stage, 1, false);
  const advanced = winners.includes(state.userTeamId);
  digest.push(
    advanced
      ? `${short} ${label} 통과 — 다음 라운드로 간다`
      : `${short} ${label} 탈락 — 여정이 여기서 끝났다`,
  );
  pushNarrative(state, `${short} ${label} ${advanced ? "통과" : "탈락"}`, 4);
}

/** 이 대회의 우승 팀 — 결승이 끝났을 때만 (시즌 리뷰·트로피의 원본) */
export function euroChampion(state: GameState, cupId: string): string | null {
  const cup = cupCatalogById(cupId);
  if (!cup) return null;
  return euroTieWinner(state, cupId, "final", 0);
}
