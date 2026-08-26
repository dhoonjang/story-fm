import type { SeasonPrediction } from "@story-fm/domain";
import { tierOfTeamIn } from "../core/club-tier";
import type { GameState } from "../core/state";
import { squadRatingsOf } from "../squad/depth";
import { scopedLeagues } from "../world/scope";
import { squadReturnOf } from "./calendar";
import { leagueOfTeamIn, teamsOfLeagueIn } from "./promotion";

/**
 * 언론의 시즌 예상 순위 (→ [../../../../docs/simulation/season.md](../../../../docs/simulation/season.md) §2).
 *
 * 「예상 12위가 4위」는 축구 이야기의 기본 문장인데, 그것을 말하려면 예상이 세계에
 * 적혀 있어야 한다. 보드 기대(career.md §5)는 구단 **안**의 값이라 그 자리를 대신하지
 * 못한다 — 구단주가 거는 목표와 언론이 매기는 순위는 다른 사실이고, 둘이 갈릴 때가
 * 이야기가 되는 자리다.
 *
 * 여기 있는 것은 전부 **결정적 순수 함수다.** 난수도 시각도 LLM도 들어오지 않는다.
 */

/**
 * 항의 가중 — **실제 프리시즌 예상표가 무엇과 함께 움직이는가**에서 왔다 (season.md §2).
 *
 * 예상표는 스쿼드 질(임금 총액·전력)과 가장 강하게 붙고, 그다음이 지난 시즌 성적이며,
 * 구단의 이름값은 그 둘을 못 이긴다. 여름 보강이 넷 중 가장 작다 — 20팀 리그에서 지난
 * 시즌 한 계단이 0.0125, 체급 한 칸이 0.05, 여름의 최대 폭이 0.10이다. 아주 큰 여름은
 * 대여섯 계단을 올리되 순위를 다시 세우지는 못한다.
 */
const W_STRENGTH = 0.45;
const W_LAST = 0.25;
const W_STATURE = 0.2;
const W_NET = 0.1;

/**
 * 여름 순이적이 한 항을 다 채우는 크기 (OVR) — **선발에 닿는 만큼**의 합이다.
 *
 * 열한 명 평균 위로 5쯤 되는 영입 셋이면 한 항이 다 찬다 — 실제로 감독이 여름 하나에
 * 할 수 있는 최대치다. 머릿수로 재면 스물다섯을 사고 다섯을 판 팀이 우승 후보가 된다.
 */
const NET_TRANSFER_SCALE = 15;

/** 체급 → 이름값 (1체급 1.0 ~ 4체급 0.25) */
const TIER_SPAN = 4;

/**
 * 한 리그의 예상 순서 — 1위부터의 팀 id.
 *
 * 점수가 같으면 팀 id가 가른다: 배열 순서가 정하면 같은 세이브가 두 번 다른 답을 낸다
 * (시즌 시상의 마지막 칸과 같은 규약 — season.md §6).
 */
export function preseasonPrediction(state: GameState, leagueId: string): string[] {
  const teamIds = teamsOfLeagueIn(state, leagueId);
  if (teamIds.length === 0) return [];
  const ratings = squadRatingsOf(state);
  const strengths = new Map(teamIds.map((id) => [id, ratings.get(id) ?? 0]));
  const values = [...strengths.values()];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const lastSeason = lastSeasonPlaces(state, leagueId);
  const scored = teamIds.map((teamId) => {
    // 폭이 0이면 전력이 아무것도 가르지 않는다 — 전원 가운데로 둔다(0으로 두면 이 항이 죽는다)
    const strength = max > min ? ((strengths.get(teamId) ?? 0) - min) / (max - min) : 0.5;
    const stature = (TIER_SPAN + 1 - tierOfTeamIn(state, teamId)) / TIER_SPAN;
    /**
     * **지난 시즌 순위가 없으면 체급이 대신 답한다** — 승격 팀과 첫 시즌의 자리다.
     * 0으로 두면 승격 팀이 언제나 꼴찌로 예상되고, 그러면 이 항이 「승격했는가」만 잰다.
     */
    const last = lastSeason.get(teamId) ?? stature;
    const net = netTransferScore(state, teamId, strengths.get(teamId) ?? 0);
    return {
      teamId,
      score: W_STRENGTH * strength + W_LAST * last + W_STATURE * stature + W_NET * net,
    };
  });
  scored.sort((a, b) => b.score - a.score || (a.teamId < b.teamId ? -1 : 1));
  return scored.map((row) => row.teamId);
}

/**
 * 지난 시즌 그 리그의 자리 — `(팀 수 − 순위 + 1) / 팀 수`, 1위가 1.0이다.
 *
 * 결산 스냅샷(`state.history`)의 행 순서가 곧 순위다 (game-state.md §3.3). 그 표에
 * 없는 팀(승격·첫 시즌)은 여기 담기지 않는다 — 부르는 쪽이 체급으로 떨어진다.
 */
function lastSeasonPlaces(state: GameState, leagueId: string): Map<string, number> {
  const places = new Map<string, number>();
  const last = (state.history ?? []).find((row) => row.season === state.season - 1);
  const table = last?.leagues.find((l) => l.leagueId === leagueId);
  if (!table || table.rows.length === 0) return places;
  const size = table.rows.length;
  table.rows.forEach((row, index) => places.set(row.teamId, (size - index) / size));
  return places;
}

/**
 * 여름 순이적 — **선수 수가 아니라 선발에 닿는 만큼**을 −1\~+1로 (season.md §2).
 *
 * 상위 열한 명 평균(`rating`) 아래의 영입은 그 열한 명을 바꾸지 못하므로 0으로 센다.
 * 매각도 같은 자로 재어 빼므로, 벤치를 정리한 여름과 주전을 판 여름이 갈린다.
 */
function netTransferScore(state: GameState, teamId: string, rating: number): number {
  const from = state.calendar.preseasonStart;
  const overallOf = new Map(state.players.map((p) => [p.id, p.attributes.overall]));
  let net = 0;
  for (const transfer of state.transfers) {
    if (transfer.date < from || transfer.date > state.date) continue;
    const overall = overallOf.get(transfer.gamePlayerId);
    if (overall === undefined) continue;
    const above = Math.max(0, overall - rating);
    if (above === 0) continue;
    if (transfer.toTeamId === teamId) net += above;
    else if (transfer.fromTeamId === teamId) net -= above;
  }
  return Math.max(-1, Math.min(1, net / NET_TRANSFER_SCALE));
}

/**
 * 이 시즌의 예상표를 세운다 — **리그마다 한 번, 소집일에** (season.md §2).
 *
 * 멱등하다: 그 시즌 그 리그의 줄이 이미 있으면 아무것도 하지 않는다. 개막 전 스쿼드가
 * 원본이라 여름 창이 닫히고 나면 같은 함수가 같은 답을 내지 못하므로, 다시 세우는
 * 것이 곧 예상을 결과로 고쳐 쓰는 일이 된다.
 *
 * @returns 이번에 새로 선 리그 id — 하나도 없으면 빈 배열
 */
export function standPredictions(state: GameState): string[] {
  const stood: string[] = [];
  const rows = (state.predictions ??= []);
  for (const league of scopedLeagues(state.world)) {
    if (rows.some((r) => r.season === state.season && r.leagueId === league.id)) continue;
    const order = preseasonPrediction(state, league.id);
    if (order.length === 0) continue;
    rows.push({ season: state.season, leagueId: league.id, order });
    stood.push(league.id);
  }
  return stood;
}

/**
 * 오늘 예상표를 세울 수 있는가 — **소집일부터 개막 전날까지**다.
 *
 * 소집일 하루가 아니라 창인 것은 그날 tick을 놓친 세이브(옛 세이브·중간에 붙은
 * 세이브)가 프리시즌 안에서 따라잡을 수 있게 하기 위해서다. 개막에서 닫는 것은
 * 그 뒤의 스쿼드로 세운 「예상」이 예상이 아니기 때문이다 — 시즌이 이미 시작했다.
 */
export function predictionsDue(state: GameState): boolean {
  return state.date >= squadReturnOf(state.calendar) && state.date < state.calendar.start;
}

/** 그 시즌 그 리그의 예상 줄 — 없으면 null (옛 세이브·예상이 서기 전) */
export function predictionOf(
  state: GameState,
  leagueId: string,
  season = state.season,
): SeasonPrediction | null {
  return (
    (state.predictions ?? []).find((r) => r.season === season && r.leagueId === leagueId) ?? null
  );
}

/**
 * 그 팀의 예상 순위 (1부터) — 예상이 없거나 그 표에 없으면 null.
 *
 * 리그를 묻지 않는다: 팀이 지금 속한 리그의 표를 본다. 승강으로 리그가 바뀌면 그
 * 시즌의 표는 새 리그의 것이라, 이 함수가 답하는 자리(회견 카드·순위표 열)와 같다.
 */
export function predictedPlaceOf(
  state: GameState,
  teamId: string,
  season = state.season,
): number | null {
  const row = predictionOf(state, leagueOfTeamIn(state, teamId), season);
  if (!row) return null;
  const index = row.order.indexOf(teamId);
  return index < 0 ? null : index + 1;
}
