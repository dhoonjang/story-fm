import { ageOf, type GamePlayer } from "@story-fm/domain";
import { addDays, diffDays, seasonYear, windowOpenOn } from "./calendar";
import { isClubTeam, isTopFlight, leagueOfTeam } from "./data/team-catalog";
import { isMarketOnlyLeague } from "./data/league-catalog";
import { recordFinance } from "./finance";
import { marketBiasOf, marketValueOf, windowOpenForTeam } from "./market";
import { makeRng } from "./rng";
import {
  activeContract,
  groupOf,
  isInjured,
  pushNarrative,
  releaseFromTactics,
  squadLevelOf,
  teamName,
  teamShortName,
  weeklyWagesOf,
  type GameState,
} from "./state";
import { clubWageBudget, estimateWeeklyWage, wageSubjectOf } from "./wages";

/**
 * 남의 팀끼리의 이적 시장 — **세계가 감독 없이도 돈다.**
 *
 * 예전엔 이적이 감독을 통해서만 일어났다. 한 시즌을 다 돌려도 AI↔AI 이적은
 * **0건**이었다 — 창이 열리고 닫히는 동안 리그의 스쿼드는 한 명도 움직이지 않고,
 * 신문에 날 만한 일이 우리 구단 안에서만 벌어졌다. 라이벌은 여름 내내 아무도
 * 사지 않는 구단이었다.
 *
 * 여기서 하는 일은 **거래 자체**다. 협상 과정(오퍼·역제안·설득)은 감독의 것이고,
 * AI끼리는 결과만 남긴다 — 매 딜을 협상으로 굴리면 하루에 수백 번의 판정이
 * 필요한데 그 과정을 볼 사람이 없다.
 *
 * ## 빈도를 어떻게 잡았나
 *
 * 실제 5대 리그 구단은 한 시즌에 영입 5~7명 · 임대 아웃 3~5명쯤 한다. 다만
 * 그중 상당수는 우리가 모델링하지 않은 리그(에레디비시·프리메이라·하부리그)와의
 * 거래다. 그래서 **1부 클럽당 시즌 3~4건**을 목표로 잡았다 — 라이벌의 스쿼드가
 * 여름을 지나며 실제로 달라지되, 리그가 하루아침에 재편되지는 않는 정도.
 */

/** 창이 열린 하루에 시도하는 거래 수 (성사되는 수가 아니다) */
const ATTEMPTS_PER_DAY = 62;
/** 그중 임대의 비중 — 조건이 까다로워(어린 자원 · 한 단계 아래 팀) 성사율이 낮다 */
const LOAN_SHARE = 0.42;
/** 마감이 든 주에는 시도가 배로 늘고 날짜도 뒤로 쏠린다 (실제 데드라인 데이) */
const DEADLINE_RUSH = 2.2;
/** 팔 수 있는 최소 스쿼드 — 이 아래로 내려가는 매각은 성립하지 않는다 */
const MIN_SQUAD = 18;
/**
 * 파는 쪽이 지켜야 할 **1군 인원** — 매치데이 명단(선발 11 + 벤치 9)이 바닥이다.
 * 전체 인원만 보면 2군을 잔뜩 안은 구단이 1군을 17명까지 팔아넘긴다.
 */
const MIN_FIRST_TEAM = 20;
/**
 * 사는 쪽 상한 — **1군 인원으로 잰다.**
 *
 * ⚠️ 전체 스쿼드(2군·유스 포함)로 재면 안 된다. 1부 클럽의 전체 인원은 처음부터
 * 40~49명이라 상한 34로 두면 **거의 모든 구단이 살 수 없는 상태**가 된다 —
 * 시장이 열려도 하루 스물여섯 번의 시도가 전부 이 문에서 막혔다.
 */
const MAX_FIRST_TEAM = 30;
/** 그래도 무한정 쌓이지는 않게 — 전체 인원의 최후 상한 */
const MAX_SQUAD = 52;
/**
 * 이적료를 내고도 남아 있어야 할 현금 — 이 아래로 내려가는 딜은 성립하지 않는다.
 *
 * 1부는 약간의 마이너스를 감당하지만(실제 구단도 그렇다) **2부·시장 전용 리그는
 * 0 아래로 못 간다** — 중계권도 매치데이 수입도 얇아서 한 번 파이면 시즌 안에
 * 메우지 못한다. 재정 기준선 테스트가 리그별 중간 잔고를 흑자로 요구한다.
 */
const CASH_FLOOR_TOP = -10_000_000;
const CASH_FLOOR_OTHER = 0;
/**
 * 주급 여력 — 새 계약을 얹고도 구단 임금 예산(`clubWageBudget`)의 이 배율 안이어야 한다.
 *
 * 현금만 보면 **이적료는 못 내도 주급은 낼 수 있는 것처럼** 보인다. 이적료는 한 번
 * 나가지만 주급은 매주 나가므로, 파산의 실제 경로는 대개 이쪽이다.
 */
const WAGE_HEADROOM = 1.1;
/** 수준 차 — 이보다 크게 벌어지면 애초에 거래가 성립하지 않는다 */
const LEVEL_BAND = 7;
/** 감독의 달력·브리핑에 올릴 만한 이적 — 이 아래는 조용히 지나간다 */
const NOTABLE_FEE = 25_000_000;
const NOTABLE_OVERALL = 82;
/** 하루에 브리핑할 이적 수 — 창이 열린 날 열 줄씩 올라오면 소음이다 */
const NOTABLE_PER_DAY = 2;

/**
 * 하루치 스쿼드 색인 — **한 번 훑고 그 뒤로는 O(1)**.
 *
 * `playersOf`는 전 선수(5,700명)를 매번 필터한다. 하루 예순두 번의 시도가 각자
 * 서너 번씩 부르면 하루 tick이 37ms에서 86ms로 뛴다 — 시즌으로 치면 12초가
 * 29초다. 딜이 성사되면 색인도 함께 옮겨 준다(옮기지 않으면 같은 선수가 두 번
 * 팔린다).
 */
interface Squads {
  of(teamId: string): GamePlayer[];
  firstTeam(teamId: string): GamePlayer[];
  move(player: GamePlayer, toTeamId: string): void;
}

function indexSquads(state: GameState): Squads {
  const byTeam = new Map<string, GamePlayer[]>();
  for (const p of state.players) {
    const list = byTeam.get(p.teamId);
    if (list) list.push(p);
    else byTeam.set(p.teamId, [p]);
  }
  return {
    of: (teamId) => byTeam.get(teamId) ?? [],
    firstTeam: (teamId) => (byTeam.get(teamId) ?? []).filter((p) => squadLevelOf(p) === "first"),
    move: (player, toTeamId) => {
      const from = byTeam.get(player.teamId);
      if (from) {
        const i = from.indexOf(player);
        if (i >= 0) from.splice(i, 1);
      }
      const to = byTeam.get(toTeamId);
      if (to) to.push(player);
      else byTeam.set(toTeamId, [player]);
    },
  };
}

/** 그 팀의 수준 — 상위 15명 평균 (`signFreeAgents`와 같은 잣대) */
function squadLevel(squad: readonly GamePlayer[]): number {
  if (squad.length === 0) return 0;
  const top = squad
    .map((p) => p.attributes.overall)
    .sort((a, b) => b - a)
    .slice(0, 15);
  return top.reduce((s, v) => s + v, 0) / top.length;
}

/** 이적 시장에 참여하는 구단 — 우리 팀은 빠진다 (감독이 직접 한다) */
function marketClubs(state: GameState): string[] {
  return state.teams
    .map((t) => t.id)
    .filter((id) => id !== state.userTeamId && isClubTeam(id) && leagueOfTeam(id) !== "free");
}

function pick<T>(rng: () => number, items: readonly T[]): T | null {
  return items.length === 0 ? null : (items[Math.floor(rng() * items.length)] ?? null);
}

/**
 * 이 선수를 팔 수 있나 — 스쿼드가 무너지지 않고, 임대 중이 아니고, 계약이 있다.
 * 부상 중인 선수는 팔지 않는다 (실제로도 메디컬을 통과하지 못한다).
 */
function sellable(
  state: GameState,
  squads: Squads,
  player: GamePlayer,
  ledger: { departures: Map<string, number> },
): boolean {
  if (player.loan) return false;
  if (isInjured(state, player.id)) return false;
  if (!activeContract(state, player.id)) return false;
  const squad = squads.of(player.teamId);
  if (squad.length <= MIN_SQUAD) return false;
  const firstTeam =
    squads.firstTeam(player.teamId).length - (ledger.departures.get(player.teamId) ?? 0);
  if (firstTeam <= MIN_FIRST_TEAM) return false;
  // 골키퍼 둘은 남아야 한다 (`squadShortfall`과 같은 규칙 — 색인으로 빠르게)
  if (squad.filter((p) => p.id !== player.id && groupOf(p) === "GK").length < 2) return false;
  return true;
}

/**
 * 이 구단이 이 선수를 원하는가 — **자리와 수준.**
 *
 * 수준이 맞아야 하고(위로도 아래로도 `LEVEL_BAND`), 그 자리가 두텁지 않아야 한다.
 * 시장 전용 리그(사우디·MLS)는 다르게 본다 — 나이를 개의치 않고 이름값을 산다.
 */
function wants(state: GameState, squads: Squads, buyerId: string, player: GamePlayer): boolean {
  const squad = squads.of(buyerId);
  if (squad.length >= MAX_SQUAD) return false;
  const firstTeam = squads.firstTeam(buyerId);
  if (firstTeam.length >= MAX_FIRST_TEAM) return false;
  const level = squadLevel(squad);
  const bias = marketBiasOf(buyerId);
  const age = ageOf(player.birthdate, state.date);
  if (isMarketOnlyLeague(leagueOfTeam(buyerId))) {
    // 돈으로 흡수하는 곳 — 수준이 위여도 데려가고, 노장을 반긴다
    return player.attributes.overall >= level - LEVEL_BAND * 2 && age >= 26;
  }
  if (Math.abs(level - player.attributes.overall) > LEVEL_BAND) return false;
  /**
   * 그 자리가 얇을수록 산다 — 이미 두터우면 굳이 더 쌓지 않는다.
   *
   * ⚠️ **1군 인원으로 센다.** 전체 스쿼드(2군·유스 포함)로 세면 포지션군 중앙값이
   * 12명이라(최대 19) 문턱 8에 거의 모든 1부 구단이 걸린다 — 실제로 그 바람에
   * 성사되는 딜의 대부분이 2부 구단의 쇼핑이었다.
   */
  const atGroup = firstTeam.filter((p) => groupOf(p) === groupOf(player)).length;
  if (atGroup >= (groupOf(player) === "GK" ? 3 : 9)) return false;
  return bias.veteranAppetite > 1 || age <= 33;
}

/** 이적료 — 시장가에 구단 성향과 약간의 흔들림을 얹는다 */
function feeFor(state: GameState, buyerId: string, player: GamePlayer, rng: () => number): number {
  const base = marketValueOf(state, player) * marketBiasOf(buyerId).fee;
  const jitter = 0.85 + rng() * 0.4;
  return Math.max(0, Math.round((base * jitter) / 100_000) * 100_000);
}

/** 소속을 옮긴다 — 원장(TRANSFER) · 계약 · 배치 정리까지 한 번에 */
function moveClub(
  state: GameState,
  squads: Squads,
  player: GamePlayer,
  toTeamId: string,
  input: { fee: number; type: "transfer" | "free"; rng: () => number },
): void {
  const fromTeamId = player.teamId;
  const windowId = windowOpenForTeam(state, toTeamId)?.id ?? null;
  state.transfers.push({
    id: `tr-ai-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    windowId,
    fromTeamId,
    toTeamId,
    date: state.date,
    type: input.type,
    fee: input.fee,
    note: `${teamName(fromTeamId)} → ${teamName(toTeamId)}`,
  });

  const previous = activeContract(state, player.id);
  if (previous) previous.status = "ended";
  const squad = squads.of(toTeamId);
  const wage = Math.round(
    estimateWeeklyWage(
      toTeamId,
      wageSubjectOf(player, state.date),
      [...squad, player].map((p) => wageSubjectOf(p, state.date)),
    ) * marketBiasOf(toTeamId).wage,
  );
  const years = 2 + Math.floor(input.rng() * 3);
  state.contracts.push({
    id: `c-ai-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    teamId: toTeamId,
    weeklyWage: wage,
    since: state.date,
    until: `${seasonYear(state.season) + years}-06-30`,
    status: "active",
  });

  if (input.fee > 0) {
    const ref = { type: "player" as const, id: player.id };
    recordFinance(state, toTeamId, {
      kind: "expense",
      category: "transfer_out",
      label: `이적료 — ${player.name} 영입`,
      amount: input.fee,
      ref,
    });
    recordFinance(state, fromTeamId, {
      kind: "income",
      category: "transfer_in",
      label: `이적료 — ${player.name} 매각`,
      amount: input.fee,
      ref,
    });
    const buyer = state.finances.find((f) => f.teamId === toTeamId);
    const seller = state.finances.find((f) => f.teamId === fromTeamId);
    if (buyer) buyer.transferBudget -= input.fee;
    if (seller) seller.transferBudget += input.fee;
  }

  releaseFromTactics(state, fromTeamId, player.id);
  squads.move(player, toTeamId);
  player.teamId = toTeamId;
  player.isCaptain = false;
  player.squadLevel = "first";
}

/**
 * 결정 하나 — **아직 일어나지 않은 거래.**
 *
 * 계획은 주 단위로 세우고 실행은 날짜별로 흩는다. 그래서 결정과 실행을 갈랐다:
 * 여기서 나오는 것은 "누가 어디로, 얼마에, 언제"이고 장부는 그날 tick이 쓴다.
 */
export interface AiDeal {
  gamePlayerId: string;
  toTeamId: string;
  kind: "transfer" | "loan";
  fee: number;
  date: string;
}

/** 한 주를 계획하는 동안의 가계부 — 같은 선수를 두 번 팔지 않고 예산을 두 번 쓰지 않는다 */
interface Ledger {
  committed: Set<string>;
  spent: Map<string, number>;
  arrivals: Map<string, number>;
  departures: Map<string, number>;
}

function budgetLeft(state: GameState, teamId: string, ledger: Ledger): number {
  const finance = state.finances.find((f) => f.teamId === teamId);
  if (!finance) return 0;
  return finance.transferBudget - (ledger.spent.get(teamId) ?? 0);
}

function cashLeft(state: GameState, teamId: string, ledger: Ledger): number {
  const finance = state.finances.find((f) => f.teamId === teamId);
  if (!finance) return 0;
  return finance.balance - (ledger.spent.get(teamId) ?? 0);
}

/** 이 주에 이미 정해진 인원 변동까지 반영한 1군 인원 */
function plannedFirstTeam(squads: Squads, teamId: string, ledger: Ledger): number {
  return (
    squads.firstTeam(teamId).length +
    (ledger.arrivals.get(teamId) ?? 0) -
    (ledger.departures.get(teamId) ?? 0)
  );
}

/** 완전 이적 한 건 계획 */
function planTransfer(
  state: GameState,
  squads: Squads,
  clubs: readonly string[],
  ledger: Ledger,
  rng: () => number,
): AiDeal | null {
  const buyerId = pick(rng, clubs);
  if (!buyerId) return null;
  if (!windowOpenForTeam(state, buyerId)) return null;
  /**
   * **2부는 돈을 쓰지 않는다.** 우리 세계의 2부는 리그전이 없어 중계권도
   * 매치데이 수입도 없다(컵 참가 전용). 그래서 이적료는 한 방향 유출이고,
   * 한 시즌이면 세리에 B 중간 잔고가 £25M에서 마이너스로 내려갔다. 파는 것과
   * 임대로 받는 것은 그대로 두되(그쪽이 실제 2부의 시장이다) 사는 건 막는다.
   */
  if (!isTopFlight(buyerId) && !isMarketOnlyLeague(leagueOfTeam(buyerId))) return null;
  const finance = state.finances.find((f) => f.teamId === buyerId);
  if (!finance || finance.budgetFrozen) return null;
  if (plannedFirstTeam(squads, buyerId, ledger) >= MAX_FIRST_TEAM) return null;

  const sellerId = pick(
    rng,
    clubs.filter((id) => id !== buyerId),
  );
  if (!sellerId) return null;

  /**
   * 한 구단에서 **세 명까지 훑는다** — 아무나 한 명 뽑아 조건을 보면 대부분
   * 수준·자리가 안 맞아 헛돈다. 시도 수를 늘리는 것보다 이쪽이 싸다
   * (스쿼드 배열은 이미 손에 있다).
   */
  const squad = squads.of(sellerId);
  let target: GamePlayer | null = null;
  for (let i = 0; i < 3 && !target; i++) {
    const candidate = pick(rng, squad);
    if (!candidate || ledger.committed.has(candidate.id)) continue;
    if (sellable(state, squads, candidate, ledger) && wants(state, squads, buyerId, candidate)) {
      target = candidate;
    }
  }
  if (!target) return null;

  // **주급을 감당할 수 있나** — 이적료보다 이쪽이 파산의 실제 경로다
  const newWage = estimateWeeklyWage(
    buyerId,
    wageSubjectOf(target, state.date),
    [...squads.of(buyerId), target].map((p) => wageSubjectOf(p, state.date)),
  );
  if (weeklyWagesOf(state, buyerId) + newWage > clubWageBudget(buyerId) * WAGE_HEADROOM) {
    return null;
  }

  const fee = feeFor(state, buyerId, target, rng);
  if (fee > budgetLeft(state, buyerId, ledger)) return null;
  /**
   * ⚠️ **예산만 보면 구단이 파산한다.** 이적 예산은 보드가 허락한 한도일 뿐이고
   * 실제로 나가는 건 현금이다. 사우디처럼 경기 수입이 없는 구단은 들어오는 돈이
   * 없어서, 예산만 보고 지르게 두면 한 시즌에 잔고가 −£180M까지 내려갔다.
   */
  const floor = isTopFlight(buyerId) ? CASH_FLOOR_TOP : CASH_FLOOR_OTHER;
  if (cashLeft(state, buyerId, ledger) - fee < floor) return null;

  ledger.committed.add(target.id);
  ledger.spent.set(buyerId, (ledger.spent.get(buyerId) ?? 0) + fee);
  ledger.arrivals.set(buyerId, (ledger.arrivals.get(buyerId) ?? 0) + 1);
  ledger.departures.set(sellerId, (ledger.departures.get(sellerId) ?? 0) + 1);
  return { gamePlayerId: target.id, toTeamId: buyerId, kind: "transfer", fee, date: state.date };
}

/**
 * 임대 한 건 계획 — **어린 자원이 뛸 자리를 찾아 나간다.**
 *
 * 실제 임대의 대부분이 그렇다: 상위 구단의 유망주가 한 단계 아래에서 한 시즌을
 * 뛴다. 그래서 보내는 쪽은 수준이 위여야 하고, 받는 쪽은 그 자리가 얇아야 한다.
 */
const LOAN_MAX_AGE = 23;

/**
 * 주급 분담 — **받는 쪽의 형편이 정한다.**
 *
 * 1부끼리면 반반이지만, 2부로 내려보낼 땐 원소속이 대부분을 낸다(실제 임대가
 * 그렇다 — 뛰게 하려고 보내는 것이라 돈을 얹어 보낸다). 반반으로 뒀더니 세리에 B
 * 구단의 중간 잔고가 마이너스로 내려갔다: 리그전이 없어 수입이 얇은 구단에
 * 상위 팀 주급의 절반은 감당이 안 되는 짐이다.
 */
function loanWageShare(hostId: string): number {
  return isTopFlight(hostId) ? 0.5 : 0.2;
}

function planLoan(
  state: GameState,
  squads: Squads,
  clubs: readonly string[],
  ledger: Ledger,
  rng: () => number,
): AiDeal | null {
  const fromId = pick(rng, clubs);
  const toId = pick(
    rng,
    clubs.filter((id) => id !== fromId),
  );
  if (!fromId || !toId) return null;
  if (!windowOpenForTeam(state, toId)) return null;
  // 시장 전용 리그는 임대를 하지 않는다 (그들이 하는 일은 흡수지 육성이 아니다)
  if (isMarketOnlyLeague(leagueOfTeam(fromId)) || isMarketOnlyLeague(leagueOfTeam(toId))) {
    return null;
  }

  const squad = squads.of(fromId);
  const target = pick(rng, squad);
  if (!target || target.loan || ledger.committed.has(target.id)) return null;
  if (isInjured(state, target.id)) return null;
  if (!activeContract(state, target.id)) return null;
  if (ageOf(target.birthdate, state.date) > LOAN_MAX_AGE) return null;
  if (squad.length <= MIN_SQUAD) return null;
  if (plannedFirstTeam(squads, fromId, ledger) <= MIN_FIRST_TEAM) return null;
  // 그 팀에서 주전이면 내보내지 않는다 — 상위 12명 안이면 자리가 있다는 뜻이다
  const rank = squad
    .map((p) => p.attributes.overall)
    .sort((a, b) => b - a)
    .indexOf(target.attributes.overall);
  if (rank >= 0 && rank < 12) return null;
  // 받는 쪽은 한 단계 아래여야 하고, 그 자리가 얇아야 한다
  const host = squads.of(toId);
  if (host.length >= MAX_SQUAD) return null;
  if (plannedFirstTeam(squads, toId, ledger) >= MAX_FIRST_TEAM) return null;
  if (squadLevel(host) > squadLevel(squad) - 2) return null;
  if (host.filter((p) => groupOf(p) === groupOf(target)).length >= 7) return null;
  // 받는 쪽이 분담할 주급도 형편 안이어야 한다
  const share =
    (activeContract(state, target.id)?.weeklyWage ?? 0) * loanWageShare(toId);
  if (weeklyWagesOf(state, toId) + share > clubWageBudget(toId) * WAGE_HEADROOM) return null;

  ledger.committed.add(target.id);
  ledger.arrivals.set(toId, (ledger.arrivals.get(toId) ?? 0) + 1);
  ledger.departures.set(fromId, (ledger.departures.get(fromId) ?? 0) + 1);
  return { gamePlayerId: target.id, toTeamId: toId, kind: "loan", fee: 0, date: state.date };
}

/**
 * 계획을 장부로 — **그 날짜의 tick이 부른다.**
 * 한 주 전에 정해진 일이라 그사이 사정이 바뀌었을 수 있다: 다치거나, 이미
 * 옮겼거나, 돈이 없어졌으면 조용히 무산된다 (실제 시장의 결렬이다).
 */
function settle(state: GameState, deal: AiDeal, rng: () => number): GamePlayer | null {
  const player = state.players.find((p) => p.id === deal.gamePlayerId);
  if (!player || player.teamId === deal.toTeamId) return null;
  if (isInjured(state, player.id)) return null;
  if (!activeContract(state, player.id)) return null;
  if (!windowOpenForTeam(state, deal.toTeamId)) return null;
  const squads = indexSquads(state);
  const empty: Ledger = {
    committed: new Set(),
    spent: new Map(),
    arrivals: new Map(),
    departures: new Map(),
  };

  if (deal.kind === "loan") {
    if (player.loan) return null;
    if (squads.firstTeam(player.teamId).length <= MIN_FIRST_TEAM) return null;
    const fromId = player.teamId;
    state.transfers.push({
      id: `tr-loan-${player.id}-${state.date}`,
      gamePlayerId: player.id,
      windowId: windowOpenForTeam(state, deal.toTeamId)?.id ?? null,
      fromTeamId: fromId,
      toTeamId: deal.toTeamId,
      date: state.date,
      type: "loan",
      fee: 0,
      note: `${teamName(fromId)} → ${teamName(deal.toTeamId)} 임대`,
    });
    releaseFromTactics(state, fromId, player.id);
    player.teamId = deal.toTeamId;
    player.squadLevel = "first";
    player.isCaptain = false;
    // 계약은 원소속에 남는다 — 복귀는 이 값이 파생시킨다 (`returnDueLoans`)
    player.loan = {
      fromTeamId: fromId,
      until: `${seasonYear(state.season) + 1}-06-30`,
      wageShare: loanWageShare(deal.toTeamId),
    };
    return player;
  }

  if (!sellable(state, squads, player, empty)) return null;
  const finance = state.finances.find((f) => f.teamId === deal.toTeamId);
  if (!finance || finance.budgetFrozen) return null;
  if (deal.fee > finance.transferBudget) return null;
  const floor = isTopFlight(deal.toTeamId) ? CASH_FLOOR_TOP : CASH_FLOOR_OTHER;
  if (finance.balance - deal.fee < floor) return null;
  moveClub(state, squads, player, deal.toTeamId, {
    fee: deal.fee,
    type: deal.fee > 0 ? "transfer" : "free",
    rng,
  });
  return player;
}

/**
 * 이번 주 계획을 세운다 — **묶어서 결정하고, 날짜는 흩는다.**
 *
 * 매일 굴리면 하루 tick이 무거워지고(시도 예순두 번 × 스쿼드 색인), 한 날에
 * 몰아 실행하면 "8월 3일에 리그 전체가 이적한 날"이 된다. 그래서 결정은 주 1회,
 * 실행은 그 주의 각 날짜로 흩는다. **마감이 가까우면 뒤쪽 날짜에 몰린다** —
 * 실제 시장의 데드라인 데이가 그렇다.
 */
function planWeek(state: GameState, rng: () => number): AiDeal[] {
  const squads = indexSquads(state);
  const clubs = marketClubs(state);
  const ledger: Ledger = {
    committed: new Set(),
    spent: new Map(),
    arrivals: new Map(),
    departures: new Map(),
  };
  const window = windowOpenOn(state.windows, state.date);
  const lastDay = window ? minDate(window.closesOn, addDays(state.date, WEEK - 1)) : state.date;
  const span = Math.max(0, diffDays(state.date, lastDay));
  const deadlineWeek = window ? window.closesOn <= addDays(state.date, WEEK - 1) : false;

  const attempts = Math.round(ATTEMPTS_PER_DAY * WEEK * (deadlineWeek ? DEADLINE_RUSH : 1));
  const deals: AiDeal[] = [];
  for (let i = 0; i < attempts; i++) {
    const deal =
      rng() < LOAN_SHARE
        ? planLoan(state, squads, clubs, ledger, rng)
        : planTransfer(state, squads, clubs, ledger, rng);
    if (!deal) continue;
    /**
     * 날짜 배분 — 균등하게 흩되 **마감 주에는 뒤로 쏠린다**(제곱으로 눌러
     * 마지막 이틀에 몰린다). 실제 데드라인 데이의 모양이다.
     */
    const u = rng();
    const offset = Math.min(span, Math.floor((deadlineWeek ? Math.sqrt(u) : u) * (span + 1)));
    deals.push({ ...deal, date: addDays(state.date, offset) });
  }
  return deals;
}

const WEEK = 7;

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

/**
 * 하루치 AI 이적 시장 — tick이 **매일** 부르지만, 계획은 **주 1회**만 세운다.
 *
 * 감독에게는 **큰 건만** 알린다. 창이 열린 날 리그 전체의 이적을 다 올리면
 * 브리핑이 이적 공시로 덮인다 — 감독이 알아야 할 것은 "우리 리그의 누가
 * 어디로 갔나"이고, 나머지는 조회 도구가 갖는다.
 */
export function runAiTransfers(state: GameState, digest: string[]): void {
  const queue = (state.aiDeals ??= []);
  const rng = makeRng(state.seed, `ai-market:${state.date}`);

  // ① 오늘 자리 잡은 딜을 장부로 옮긴다 (지난 날짜는 밀린 것 — 함께 처리한다)
  const due = queue.filter((d) => d.date <= state.date);
  const settled: { player: GamePlayer; deal: AiDeal }[] = [];
  for (const deal of due) {
    const player = settle(state, deal, rng);
    if (player) settled.push({ player, deal });
  }
  state.aiDeals = queue.filter((d) => d.date > state.date);

  // ② 계획은 주 1회 — 창이 열린 동안, 큐가 비었을 때만
  const anyWindow = windowOpenOn(state.windows, state.date);
  const marketWindow = state.teams.some(
    (t) => isMarketOnlyLeague(leagueOfTeam(t.id)) && windowOpenForTeam(state, t.id),
  );
  if ((anyWindow || marketWindow) && state.aiDeals.length === 0) {
    state.aiDeals = planWeek(state, rng);
  }

  /** 감독의 리그에서 벌어진 큰 건만 — 그것도 하루 두 줄까지 */
  const ourLeague = leagueOfTeam(state.userTeamId);
  const notable = settled
    .filter(
      ({ player, deal }) =>
        deal.kind === "transfer" &&
        (deal.fee >= NOTABLE_FEE || player.attributes.overall >= NOTABLE_OVERALL) &&
        (leagueOfTeam(deal.toTeamId) === ourLeague || isTopFlight(deal.toTeamId)),
    )
    .sort((a, b) => b.deal.fee - a.deal.fee)
    .slice(0, NOTABLE_PER_DAY);
  for (const { player, deal } of notable) {
    const fee = deal.fee > 0 ? ` (£${(deal.fee / 1_000_000).toFixed(1)}M)` : " (자유계약)";
    digest.push(`📰 ${player.name} → ${teamShortName(deal.toTeamId)}${fee}`);
    pushNarrative(state, `${player.name} ${teamShortName(deal.toTeamId)} 이적`, 2);
  }
}
