import type {
  BoardDemand,
  BoardDemandCause,
  BoardDemandKind,
  GamePlayer,
  PressFact,
  TransferWindow,
} from "@story-fm/domain";
import { BOARD_DEMAND_LABEL, boardDemandText, DEMAND_LEVERS } from "@story-fm/domain";
import type { GameState } from "../core/state";
import {
  activeContract,
  financeOf,
  openBoardDemand,
  openInjury,
  playerById,
  pushNarrative,
  squadLevelOf,
  userPlayers,
  weeklyWagesOf,
} from "../core/state";
import { addDays } from "../core/dates";
import { academyPlayerIdsOf } from "./vision";
import { windowOpenForTeam } from "../market/market";
import { ownerOf } from "../world/persona";
import { MANAGER_SUBJECT, moveRelation } from "../world/relations";
import {
  PROMISE_MIN_MATCHES,
  PROMISE_WINDOW_MATCHES,
  matchWindowOf,
  startsInWindow,
} from "../squad/promises";
import {
  bookValueOf,
  budgetFreezeReason,
  debtLimitOf,
  debtOf,
  formatMoney,
  psrStatus,
  relegationGapOf,
} from "./finance";
import { clampRep, signed } from "./press";

/**
 * 보드 요청 — **구단주 원형이 거는 조건 하나** (career.md §5.2).
 *
 * 순위 기대(§5)는 등급 표가 주는 구단의 자리이고, 이것은 **그 구단주라는 사람**이
 * 거는 조건이다. 원형이 종류를 정하고 재정 상태가 발생과 판정에 걸리며, 판정은 전부
 * 코어 장부의 사실이다 — 이적 원장·잔고·주급 총액·선수 소속·출전 명단. LLM은
 * 관여하지 않는다.
 *
 * **갈래가 셋이고 열린 요청은 하나다.**
 *
 *   - **창 갈래** — 창이 열린 날의 이적 시장 조건 (`DEMAND_OF_ARCHETYPE.window`).
 *   - **재정 갈래** — 동결·강등이 서 있으면 그 창의 조건이 매각 요구로 갈린다.
 *   - **시즌 갈래** — 창이 닫힌 동안 서는 경기 단위 요청(`field-player`). 시즌의 8할이
 *     창 밖이라, 그 기간에 구단주가 순위 말고 아무 말도 하지 않으면 그는 분기마다 한
 *     번 나타나는 사람이 된다. 시즌마다 최대 하나다.
 *
 * **선 요청은 감독이 한 차례 되물을 수 있다** (`counterDemand` — §5.2 「흥정」).
 */
export const BOARD_DEMAND = {
  /** 이행 → 보드 평판. 불이행의 절반 폭 — 구단주는 이행을 당연으로 여긴다 */
  MET_BOARD: 3,
  /** 불이행 → 보드 평판 — 보드 경고 한 번과 같은 폭 (career.md §5) */
  FAILED_BOARD: -6,
  /** `wage-freeze`가 허용하는 주급 총액 상승 폭 — 재계약 잔물결까지 동결로 본다 */
  WAGE_TOLERANCE: 0.02,
  /** `sign-star`의 기준 이적료 = 발행 시점 이적 예산 × 이 비율 */
  STAR_FEE_OF_BUDGET: 0.4,
  /** `sign-star`가 서려면 필요한 이적 예산 하한 — 없는 돈으로 스타를 조르지 않는다 */
  SIGN_STAR_MIN_BUDGET: 20_000_000,
  /**
   * 재정 갈래가 서려면 목표액이 넘어야 하는 문턱 — **한 달치 인건비**다
   * (career.md §5.2). PSR 여유가 £10만 모자란 창에 £10만을 조르는 것은 요청이
   * 아니라 소음이다. 자를 주급 총액에서 뽑는 것은 동결선(20주)과 같은 이유다 —
   * 금액이 아니라 주수라 구단 규모를 저절로 탄다.
   */
  FUNDS_MIN_WAGE_WEEKS: 4,
  /** 목표액이 앉는 눈금 — 호가(`askingPriceFor`)와 같은 10만 단위다 */
  FUNDS_ROUNDING: 100_000,
  /** 시즌 갈래의 판정 창 — 발행일부터 우리 공식 경기 다섯 (career.md §5.2 「시즌 갈래」) */
  FIELD_MATCHES: 5,
  /** 그 다섯 중 세워야 하는 선발 횟수 — 절반을 넘는 한 번이다 */
  FIELD_STARTS: 3,
  /** 시즌 갈래의 기한 — 다섯 경기를 담는 날 수 */
  FIELD_DAYS: 30,
  /**
   * 지목 후보의 문턱 — 최근 여덟 경기 선발 비율이 이보다 낮아야 「안 뛴다」다.
   * 자(`startsInWindow`)는 출전 약속과 나눠 쓴다 (people.md §5-2).
   */
  FIELD_UNDERUSED_SHARE: 0.5,
  /** 흥정이 늘릴 수 있는 기한 — 원형 여유 1.0 기준의 상한 (§5.2 「흥정」) */
  COUNTER_EXTEND_DAYS: 30,
  /** 흥정이 숫자를 물러서게 하는 폭 — 원형 여유 1.0 기준의 상한 */
  COUNTER_RELAX: 0.3,
  /** 상태에 남기는 지난 요청 수 — 다가옴·회견과 같은 규약 */
  KEPT: 20,
} as const;

/**
 * 원형 → **흥정의 여유** (career.md §5.2 「흥정」). 계약의 길이(§5.4)와 다년 계획의
 * 길이(§5)를 정하는 그 인내가 여기서도 폭을 정한다 — 큰 그림의 사람은 기다려 주고,
 * 분기로 셈하는 사람은 기다려 주지 않는다.
 *
 * 표 밖의 카드는 아무것도 내주지 않는다 — 조건부 요청을 걸지 않는 것과 같은 규약이다.
 */
export const OWNER_SLACK: Readonly<Record<string, number>> = {
  국부펀드형: 1,
  "지역 유지형": 0.8,
  축구광형: 0.6,
  흥행가형: 0.6,
  투자자형: 0.4,
  산업가형: 0.2,
};

/**
 * 원형이 **누구를 지목하는가** — 시즌 갈래의 렌즈 (career.md §5.2 「시즌 갈래」).
 *
 * 종류가 하나(`field-player`)인 자리에서 원형이 가르는 것은 「무엇을 요구하는가」가
 * 아니라 **누가 안 뛰는 것을 못 견디는가**다. 여섯이 같은 스쿼드를 보고 다른 사람을
 * 지목한다.
 */
export type SeasonDemandLens =
  /** 우리 아카데미 출신 중 종합 최고 — 축구광형·지역 유지형 */
  | "academy"
  /** 1군 종합 최고 — 흥행가형 */
  | "top-overall"
  /** 가장 비싸게 데려온 영입 — 국부펀드형 */
  | "top-fee"
  /** 장부 잔존가가 가장 큰 선수 — 투자자형 */
  | "top-book"
  /** 주급이 가장 높은 선수 — 산업가형 */
  | "top-wage";

/**
 * 원형 → 요청의 결 (people.md §2의 구단주 6종). **여섯 원형 밖의 카드는 조건부
 * 요청을 걸지 않는다** — 옛 세이브의 커스텀 구단주에게 없는 성격을 지어내지 않는다.
 *
 * `window`는 창이 열린 날의 조건이고 `season`은 창 밖에서 그가 지목하는 사람이다.
 * 국부펀드형만 여름 창에 한정하는 것은 인내의 표현이다 — 큰 그림의 사람은 겨울
 * 땜질을 조르지 않는다.
 */
export const DEMAND_OF_ARCHETYPE: Record<
  string,
  { window: BoardDemandKind; summerOnly?: true; season: SeasonDemandLens }
> = {
  산업가형: { window: "wage-freeze", season: "top-wage" },
  투자자형: { window: "net-profit", season: "top-book" },
  축구광형: { window: "keep-player", season: "academy" },
  국부펀드형: { window: "sign-star", summerOnly: true, season: "top-fee" },
  "지역 유지형": { window: "stay-solvent", season: "academy" },
  흥행가형: { window: "sign-star", season: "top-overall" },
};

/**
 * 원형 → **재정 갈래**의 요청 (career.md §5.2 「재정 갈래」). 위 표를 덮는 것이 아니라
 * 재정이 급한 창에만 대신 선다.
 *
 * **사람을 지목하는 것은 선수를 자산·비용으로 읽는 둘뿐이다** (people.md §2) —
 * 투자자형은 회수를, 산업가형은 구조를 본다. 나머지 넷은 금액만 부른다: 화제성을 파는
 * 사람도 위상을 지키는 사람도 연고의 사람도 경기 내용을 보는 사람도 "그 선수를
 * 팔아라"라고는 말하지 않는다.
 *
 * 여섯 원형 밖의 카드는 여기서도 아무 요청을 걸지 않는다 — 위 표와 같은 규약이다.
 */
export const FINANCE_DEMAND_OF_ARCHETYPE: Record<string, BoardDemandKind> = {
  산업가형: "sell-player",
  투자자형: "sell-player",
  축구광형: "raise-funds",
  국부펀드형: "raise-funds",
  "지역 유지형": "raise-funds",
  흥행가형: "raise-funds",
};

/**
 * **마지막으로 판정이 끝난 요청** — 이행이든 불이행이든. 요청은 창 순서대로 쌓이므로
 * 뒤에서 첫 번째가 가장 최근의 판정이다.
 *
 * 보드 대치 아크가 절정을 가를 때 이것을 읽는다 (people.md §9). 지난 요청 전부에서
 * 불이행을 찾으면 세 시즌 전의 한 번이 대치를 영원히 절정에 묶어 둔다.
 */
export function lastJudgedDemand(state: GameState): BoardDemand | null {
  const judged = (state.boardDemands ?? []).filter((d) => d.status !== "open");
  return judged[judged.length - 1] ?? null;
}

/**
 * 하루치 보드 요청 — tick이 매일 부른다 (감독이 있는 날만).
 *
 * 순서가 뜻을 갖는다: **판정이 발행보다 먼저다** — 창이 닫혀 기한이 지난 요청을
 * 정산한 뒤라야, 다음 창이 열린 날 새 요청이 그 자리를 이어받는다.
 */
export function tickBoardDemands(state: GameState, digest: string[]): void {
  const demands = (state.boardDemands ??= []);
  const open = demands.find((d) => d.status === "open");
  if (open) judgeDemand(state, open, digest);
  if (!demands.some((d) => d.status === "open")) issueDemand(state, demands, digest);
  if (demands.length > BOARD_DEMAND.KEPT) state.boardDemands = demands.slice(-BOARD_DEMAND.KEPT);
}

// ── 발생 ───────────────────────────────────────────────────────

/**
 * 오늘 설 요청 하나 — 원형이 없거나 전제가 안 서면 아무 일도 없다.
 *
 * **창이 열려 있는지가 갈래를 가른다** (career.md §5.2): 열려 있으면 이적 시장의
 * 조건이(재정 갈래가 먼저 묻는다), 닫혀 있으면 창 밖의 기용 요청이 선다.
 */
function issueDemand(state: GameState, demands: BoardDemand[], digest: string[]): void {
  const window = windowOpenForTeam(state, state.userTeamId);
  const demand = window ? windowDemand(state, demands, window) : seasonDemand(state, demands);
  if (!demand) return;
  demands.push(demand);
  digest.push(`구단주 요청 — ${describeDemand(state, demand)} · 기한 ${demand.deadline}`);
  pushNarrative(state, `구단주 요청 — ${describeDemand(state, demand)}`, 4);
}

/**
 * 이 창에 설 요청 — **재정 갈래가 먼저 묻는다**: 동결·강등이 서 있고 목표액이 문턱을
 * 넘으면 그 창의 조건은 매각 요구다. 문턱 아래면 평소 조건이 그대로 선다.
 */
function windowDemand(
  state: GameState,
  demands: BoardDemand[],
  window: TransferWindow,
): BoardDemand | null {
  // 창마다 최대 하나 — 일찍 닫힌 요청이 같은 창에 다시 서지 않는다
  if (demands.some((d) => d.windowId === window.id)) return null;
  const archetype = ownerOf(state).archetype;
  return financeDemand(state, window, archetype) ?? archetypeDemand(state, window, archetype);
}

/**
 * 창이 닫힌 동안 설 요청 — **덜 쓰이는 사람이 없으면 서지 않는다** (career.md §5.2
 * 「시즌 갈래」). 구단주가 굴리는 주사위가 아니라 감독이 만든 사실이 이 요청을 부른다.
 *
 * **시즌마다 최대 하나다** — 다섯 경기짜리 요청이 판정되는 대로 다시 서면 구단주가
 * 매달 라인업을 지시하는 사람이 된다. 자리를 재는 칸은 창 갈래와 같다(`windowId`).
 */
function seasonDemand(state: GameState, demands: BoardDemand[]): BoardDemand | null {
  const slot = seasonSlotOf(state);
  if (demands.some((d) => d.windowId === slot.id)) return null;
  const rule = DEMAND_OF_ARCHETYPE[ownerOf(state).archetype];
  if (!rule) return null;
  const named = underusedBy(state, rule.season);
  if (!named) return null;
  return {
    ...baseDemand(state, slot, "field-player"),
    playerId: named,
    target: BOARD_DEMAND.FIELD_STARTS,
  };
}

/** 이번 시즌의 자리 — 시즌 갈래가 차지하는 칸 하나와 그 기한 */
function seasonSlotOf(state: GameState): DemandSlot {
  return {
    id: `season-${state.season}`,
    deadline: addDays(state.date, BOARD_DEMAND.FIELD_DAYS),
  };
}

/**
 * 그 원형의 눈이 고른 **덜 쓰이는 한 명** — 아무도 걸리지 않으면 `null`이다.
 *
 * 「덜 쓰인다」의 자는 출전 약속과 같은 것 하나다 (`startsInWindow` — people.md §5-2):
 * 최근 여덟 경기에서 **설 수 있었던 경기가 셋 이상이고** 선발 비율이 절반 미만이어야
 * 한다. 지금 부상이면 후보가 아니다 — 다음 다섯 경기에 세울 수 없는 사람을 세우라고
 * 하는 것은 요청이 아니라 함정이다.
 */
function underusedBy(state: GameState, lens: SeasonDemandLens): string | null {
  const pool = matchWindowOf(state);
  // 셀 경기가 셋에 못 미치면 누구도 「덜 쓰인다」가 아니다 — 스쿼드를 훑을 것도 없다
  if (pool.length < PROMISE_MIN_MATCHES) return null;
  const academy = lens === "academy" ? academyPlayerIdsOf(state, state.userTeamId) : null;
  let best: { id: string; rank: number } | null = null;
  for (const player of userPlayers(state)) {
    if (openInjury(state, player.id)) continue;
    const rank = lensRankOf(state, lens, player, academy);
    if (rank === null || rank <= 0) continue;
    const read = startsInWindow(state, player, { matches: PROMISE_WINDOW_MATCHES, pool });
    if (read.played < PROMISE_MIN_MATCHES) continue;
    if (read.share >= BOARD_DEMAND.FIELD_UNDERUSED_SHARE) continue;
    if (!best || rank > best.rank || (rank === best.rank && player.id < best.id)) {
      best = { id: player.id, rank };
    }
  }
  return best?.id ?? null;
}

/** 그 렌즈로 본 눈금 — 클수록 구단주가 먼저 이름을 부르는 사람이다. 밖이면 `null` */
function lensRankOf(
  state: GameState,
  lens: SeasonDemandLens,
  player: GamePlayer,
  academy: ReadonlySet<string> | null,
): number | null {
  switch (lens) {
    case "academy":
      return academy?.has(player.id) === true ? player.attributes.overall : null;
    case "top-overall":
      return squadLevelOf(player) === "first" ? player.attributes.overall : null;
    case "top-fee":
      return feePaidFor(state, player.id);
    case "top-book":
      return bookValueOf(state, state.userTeamId, player.id);
    case "top-wage":
      return activeContract(state, player.id)?.weeklyWage ?? null;
  }
}

/** 우리가 그를 데려오며 낸 이적료 — 가장 최근의 영입 한 건이다. 없으면 0 */
function feePaidFor(state: GameState, playerId: string): number {
  let fee = 0;
  for (const t of state.transfers) {
    if (t.gamePlayerId !== playerId || t.toTeamId !== state.userTeamId) continue;
    if (t.type !== "transfer") continue;
    fee = t.fee;
  }
  return fee;
}

/** 원형의 평소 조건 — 국부펀드형의 여름 한정이 여기 걸린다 */
function archetypeDemand(
  state: GameState,
  window: TransferWindow,
  archetype: string,
): BoardDemand | null {
  const rule = DEMAND_OF_ARCHETYPE[archetype];
  if (!rule) return null;
  if (rule.summerOnly && window.kind !== "summer") return null;
  return buildDemand(state, window, rule.window);
}

/**
 * 재정이 세우는 요청 — 사유가 없거나 목표액이 문턱 아래면 `null`이다 (평소 조건이 선다).
 *
 * **여름 한정은 여기서 풀린다** — 곤란은 겨울을 기다려 주지 않는다. 큰 그림의 사람이
 * 겨울 땜질을 조르지 않는 것과, 지갑이 닫힌 겨울에 아무 말도 하지 않는 것은 다르다.
 */
function financeDemand(
  state: GameState,
  window: TransferWindow,
  archetype: string,
): BoardDemand | null {
  const kind = FINANCE_DEMAND_OF_ARCHETYPE[archetype];
  if (!kind) return null;
  const cause = demandCause(state);
  if (!cause) return null;
  const target = fundsTargetOf(state);
  const floor = weeklyWagesOf(state, state.userTeamId) * BOARD_DEMAND.FUNDS_MIN_WAGE_WEEKS;
  if (target < floor) return null;

  const base = { ...baseDemand(state, windowSlotOf(window), kind), cause };
  if (kind === "sell-player") {
    const named = priciestAsset(state);
    // 장부에 값이 남은 선수가 하나도 없으면 지목할 것이 없다 — 금액 요청으로 떨어진다
    if (named) return { ...base, playerId: named };
    return { ...base, kind: "raise-funds", baseline: target };
  }
  return { ...base, baseline: target };
}

/**
 * 요청을 부른 재정 사유 — **동결 사유가 먼저다.** 지갑이 이미 닫혔다는 것이 절벽이
 * 서 있다는 것보다 앞선 사실이고, 둘 다 참인 창에서 감독이 들어야 하는 것도 그쪽이다.
 */
function demandCause(state: GameState): BoardDemandCause | null {
  const frozen = budgetFreezeReason(state, state.userTeamId);
  if (frozen) return frozen;
  const parachute = financeOf(state, state.userTeamId).parachute;
  return parachute?.startSeason === state.season ? "relegation" : null;
}

/**
 * 매각 목표액 — **세 구멍 중 가장 큰 것** (career.md §5.2). 어느 하나만 메워도
 * 나머지가 남으므로 최대이고, 호가와 같은 10만 단위로 올린다.
 */
export function fundsTargetOf(state: GameState): number {
  const teamId = state.userTeamId;
  const target = Math.max(
    0,
    debtOf(state, teamId) - debtLimitOf(state, teamId),
    -psrStatus(state).headroom,
    relegationGapOf(state, teamId),
  );
  const step = BOARD_DEMAND.FUNDS_ROUNDING;
  return Math.ceil(target / step) * step;
}

/**
 * 장부 잔존가가 가장 큰 우리 선수 — 같으면 id 사전순. 값이 남은 선수가 없으면 `null`.
 *
 * 시장가가 아니라 잔존가인 이유는 구단주가 보는 것이 **처분 이익**이기 때문이다
 * (finance.md §6.1) — 장부의 구멍을 메우는 것은 잔존가가 큰 선수의 매각이다.
 */
function priciestAsset(state: GameState): string | null {
  let best: { id: string; value: number } | null = null;
  for (const player of userPlayers(state)) {
    const value = bookValueOf(state, state.userTeamId, player.id);
    if (value <= 0) continue;
    if (!best || value > best.value || (value === best.value && player.id < best.id)) {
      best = { id: player.id, value };
    }
  }
  return best?.id ?? null;
}

/**
 * 요청이 차지하는 **자리** — 칸 하나와 기한. 창 갈래는 창이 정하고 시즌 갈래는
 * 발행일이 정한다 (career.md §5.2).
 */
interface DemandSlot {
  id: string;
  deadline: string;
}

/** 그 창의 자리 — 기한은 창이 닫히는 날이다 */
function windowSlotOf(window: TransferWindow): DemandSlot {
  return { id: window.id, deadline: window.closesOn };
}

/** 종류가 무엇이든 같은 껍데기 — id·칸·기한은 자리가 정한다 */
function baseDemand(state: GameState, slot: DemandSlot, kind: BoardDemandKind): BoardDemand {
  return {
    id: `board-demand-${slot.id}`,
    kind,
    windowId: slot.id,
    issuedOn: state.date,
    deadline: slot.deadline,
    status: "open",
  };
}

/** 종류별 전제와 기준값 — 세울 수 없으면 `null`. 기준값은 발행 순간의 사실이다 */
function buildDemand(
  state: GameState,
  window: TransferWindow,
  kind: BoardDemandKind,
): BoardDemand | null {
  const base = baseDemand(state, windowSlotOf(window), kind);
  switch (kind) {
    case "wage-freeze":
      return { ...base, baseline: weeklyWagesOf(state, state.userTeamId) };
    case "keep-player": {
      const star = starPlayer(state);
      return star ? { ...base, playerId: star } : null;
    }
    case "sign-star": {
      const finance = financeOf(state, state.userTeamId);
      if (finance.budgetFrozen === true) return null;
      if (finance.transferBudget < BOARD_DEMAND.SIGN_STAR_MIN_BUDGET) return null;
      return {
        ...base,
        baseline: Math.round(finance.transferBudget * BOARD_DEMAND.STAR_FEE_OF_BUDGET),
      };
    }
    default:
      return base;
  }
}

/** 1군 최고 능력치 선수 — 같으면 id 사전순. 축구광이 "그 선수"라 부르는 사람이다 */
function starPlayer(state: GameState): string | null {
  const firsts = userPlayers(state).filter((p) => squadLevelOf(p) === "first");
  if (firsts.length === 0) return null;
  firsts.sort((a, b) => b.attributes.overall - a.attributes.overall || (a.id < b.id ? -1 : 1));
  return firsts[0]!.id;
}

// ── 판정 ───────────────────────────────────────────────────────

/**
 * 열린 요청 하나를 오늘의 사실로 판정한다.
 *
 * **닿는 순간 닫히는 것이 넷이다** — `sign-star`·`raise-funds`는 이행으로,
 * `keep-player`는 불이행으로, 그 거울인 `sell-player`는 선수가 떠나는 순간 이행으로.
 * 창이 닫힌 뒤에는 어차피 되돌릴 수 없는 사실이라서다. 나머지는 기한이 지난 첫날
 * 판정한다: 창이 닫히기 전의 순지출은 마지막 날의 매각 한 건으로 뒤집힐 수 있다.
 */
function judgeDemand(state: GameState, demand: BoardDemand, digest: string[]): void {
  const expired = state.date > demand.deadline;
  const verdict = ((): boolean | null => {
    switch (demand.kind) {
      case "keep-player": {
        const player = demand.playerId ? playerById(state, demand.playerId) : null;
        if (!player || player.teamId !== state.userTeamId) return false;
        return expired ? true : null;
      }
      case "sign-star": {
        const landed = windowTransfers(state, demand.windowId).some(
          (t) => t.toTeamId === state.userTeamId && t.fee >= (demand.baseline ?? 0),
        );
        return landed ? true : expired ? false : null;
      }
      case "raise-funds": {
        let raised = 0;
        for (const t of windowTransfers(state, demand.windowId)) {
          if (t.fromTeamId === state.userTeamId) raised += t.fee;
        }
        return raised >= (demand.baseline ?? 0) ? true : expired ? false : null;
      }
      case "sell-player": {
        /**
         * **소속 하나로 갈린다** — `keep-player`의 정확한 거울이다 (career.md §5.2).
         * 값이 오간 이동만 세지 않는 것은 그 자를 `raise-funds`가 이미 쥐고 있어서다:
         * 하나는 돈을, 하나는 그 사람이 남았는가를 본다. 세계에서 사라진 선수(은퇴)도
         * 구단주가 원한 자리가 빈 것은 같다.
         */
        const player = demand.playerId ? playerById(state, demand.playerId) : null;
        if (!player || player.teamId !== state.userTeamId) return true;
        return expired ? false : null;
      }
      case "net-profit": {
        if (!expired) return null;
        let net = 0;
        for (const t of windowTransfers(state, demand.windowId)) {
          if (t.fromTeamId === state.userTeamId) net += t.fee;
          if (t.toTeamId === state.userTeamId) net -= t.fee;
        }
        return net >= 0;
      }
      case "wage-freeze": {
        if (!expired) return null;
        const cap = (demand.baseline ?? 0) * (1 + BOARD_DEMAND.WAGE_TOLERANCE);
        return weeklyWagesOf(state, state.userTeamId) <= cap;
      }
      case "stay-solvent":
        return expired ? financeOf(state, state.userTeamId).balance >= 0 : null;
      case "field-player": {
        const player = demand.playerId ? playerById(state, demand.playerId) : null;
        // 쓰라고 한 사람을 판 것도 답이다 — `keep-player`와 같은 결로 그 순간 갈린다
        if (!player || player.teamId !== state.userTeamId) return false;
        const read = startsInWindow(state, player, {
          from: demand.issuedOn,
          matches: BOARD_DEMAND.FIELD_MATCHES,
        });
        if (read.starts >= (demand.target ?? BOARD_DEMAND.FIELD_STARTS)) return true;
        if (!expired) return null;
        /**
         * **부상으로 세울 자리가 없었던 것은 감독의 결정이 아니다** — 출전 약속의
         * 판정과 같은 규약이다 (people.md §5-2). 분모는 그가 설 수 있었던 경기다.
         */
        return read.played < PROMISE_MIN_MATCHES;
      }
    }
  })();
  if (verdict === null) return;

  demand.status = verdict ? "met" : "failed";
  demand.resolvedOn = state.date;
  const delta = verdict ? BOARD_DEMAND.MET_BOARD : BOARD_DEMAND.FAILED_BOARD;
  const rep = state.manager.reputation;
  rep.board = clampRep(rep.board + delta);
  // 요청을 지켰는가는 구단주와의 **사이**이기도 하다 (people.md §6 「관계 점수」)
  moveRelation(
    state,
    MANAGER_SUBJECT,
    ownerOf(state).characterId,
    verdict ? "demand-met" : "demand-failed",
  );
  const line = `보드 요청 ${verdict ? "이행" : "불이행"} — ${describeDemand(state, demand)}`;
  digest.push(`${line} (${signed("보드", delta) ?? ""})`);
  pushNarrative(state, line, verdict ? 3 : 4);
}

/**
 * 이 창의 **값이 오간 이동** — 판정의 유일한 장부다.
 *
 * 이적과 임대를 가르지 않는다: 임대료도 이적 예산에서 빠져나가는 같은 돈이라
 * 스타 영입에도 순이익에도 같은 셈으로 잡힌다 (career.md §5.2). 자유계약·유스·
 * 은퇴는 오간 값이 없어 어느 셈도 움직이지 않는다.
 */
function windowTransfers(state: GameState, windowId: string) {
  return state.transfers.filter(
    (t) => t.windowId === windowId && (t.type === "transfer" || t.type === "loan"),
  );
}

// ── 흥정 ───────────────────────────────────────────────────────

/** 감독이 되묻는 것 — 기한이거나 조건이거나, 둘 다일 수도 있다 */
export interface DemandCounter {
  /** 기한을 며칠 늘려 달라 — 원형의 여유가 실제로 내주는 날 수의 상한을 정한다 */
  extendDays?: number;
  /** 조건을 낮춰 달라 — 요청이 든 숫자가 원형의 여유만큼 물러선다 */
  relax?: boolean;
}

/**
 * **감독이 선 요청에 한 차례 되묻는다** (career.md §5.2 「흥정」).
 *
 * 코어가 원형의 여유(`OWNER_SLACK`)를 앵커로 조건을 옮긴다 — 감독이 부른 값은
 * 상한을 넘지 못한다. **평판은 움직이지 않는다**: 되묻는 것에 값을 매기면 감독이
 * 되묻지 않게 되고, 그러면 이 길이 없는 것과 같다 (§5.3과 같은 이유).
 *
 * ⚠️ **깎아 주지 않은 것도 답이다** — 여유가 한 칸을 만들지 못해 조건이 그대로 서도
 * 되물은 차례는 쓴 것이다. 안 그러면 산업가형 앞에서 감독이 매일 같은 말을 반복한다.
 */
export function counterDemand(
  state: GameState,
  ask: DemandCounter,
): { ok: boolean; message: string } {
  const demand = openBoardDemand(state);
  if (!demand) return { ok: false, message: "지금 되물을 구단주 요청이 없습니다" };
  if (demand.counteredOn) return { ok: false, message: "이미 한 차례 되물었습니다" };
  const slack = OWNER_SLACK[ownerOf(state).archetype];
  if (slack === undefined) {
    return { ok: false, message: "이 구단주는 조건을 두고 흥정하지 않습니다" };
  }
  const label = BOARD_DEMAND_LABEL[demand.kind];
  const levers = DEMAND_LEVERS[demand.kind];
  const wantsExtend = (ask.extendDays ?? 0) > 0;
  const wantsRelax = ask.relax === true;
  if (!wantsExtend && !wantsRelax) {
    return { ok: false, message: "기한(extendDays)이나 조건(relax) 중 하나는 물어야 합니다" };
  }
  if (wantsExtend && !levers.extend) {
    return { ok: false, message: `${label}의 기한은 늘려 봐야 장부가 달라지지 않습니다` };
  }
  if (wantsRelax && !levers.relax) {
    return { ok: false, message: `${label}에는 낮출 숫자가 없습니다` };
  }

  demand.counteredOn = state.date;
  const moved: string[] = [];
  if (wantsExtend) {
    const granted = Math.min(
      ask.extendDays ?? 0,
      Math.round(BOARD_DEMAND.COUNTER_EXTEND_DAYS * slack),
    );
    if (granted > 0) {
      demand.deadline = addDays(demand.deadline, granted);
      moved.push(`기한 +${granted}일 → ${demand.deadline}`);
    }
  }
  if (wantsRelax) {
    const line = relaxDemand(state, demand, BOARD_DEMAND.COUNTER_RELAX * slack);
    if (line) moved.push(line);
  }
  return {
    ok: true,
    message:
      moved.length > 0
        ? `구단주가 물러섰다 — ${moved.join(" · ")}`
        : "구단주가 조건을 그대로 두었다",
  };
}

/**
 * 요청이 든 숫자를 `ratio`만큼 물러서게 한다 — 움직인 것이 없으면 `null`.
 *
 * 방향이 종류마다 다르다: 채워야 할 목표는 **내려가고**, 넘지 말아야 할 선은
 * **올라간다**. `sell-player`만 숫자가 아니라 요청 자체를 갈아탄다.
 */
function relaxDemand(state: GameState, demand: BoardDemand, ratio: number): string | null {
  switch (demand.kind) {
    case "field-player": {
      const before = demand.target ?? BOARD_DEMAND.FIELD_STARTS;
      const after = Math.max(1, Math.round(before * (1 - ratio)));
      if (after >= before) return null;
      demand.target = after;
      return `선발 ${before}회 → ${after}회`;
    }
    case "wage-freeze": {
      const before = demand.baseline ?? 0;
      const after = Math.round(before * (1 + ratio));
      if (after <= before) return null;
      demand.baseline = after;
      return `허용 주급 총액 ${formatMoney(before)} → ${formatMoney(after)}`;
    }
    case "sign-star":
    case "raise-funds": {
      const before = demand.baseline ?? 0;
      const after = roundedFunds(before * (1 - ratio));
      if (after >= before) return null;
      demand.baseline = after;
      return `기준 ${formatMoney(before)} → ${formatMoney(after)}`;
    }
    case "sell-player": {
      /**
       * **「그 사람 대신 그 값을」** — 지목이 풀리고 금액 요청이 선다 (§5.2 「흥정」).
       * 지목이 풀리는 것이 곧 완화라서 이쪽만 요청 자체가 갈린다. 값은 그 선수의 장부
       * 잔존가에서 물러선 액수다 — 구단주가 그를 팔라고 한 것은 그만큼의 구멍 때문이다.
       */
      const named = demand.playerId ? playerById(state, demand.playerId) : null;
      const after = roundedFunds(
        (demand.playerId ? bookValueOf(state, state.userTeamId, demand.playerId) : 0) * (1 - ratio),
      );
      if (after <= 0) return null;
      demand.kind = "raise-funds";
      demand.baseline = after;
      delete demand.playerId;
      return `${named?.name ?? "지목"} 매각 → 매각 자금 ${formatMoney(after)}`;
    }
    default:
      return null;
  }
}

/** 금액이 앉는 눈금 — 목표액과 같은 10만 단위이고, 한 눈금 아래로는 내려가지 않는다 */
function roundedFunds(value: number): number {
  const step = BOARD_DEMAND.FUNDS_ROUNDING;
  return Math.max(step, Math.round(value / step) * step);
}

// ── 사실 카드 ──────────────────────────────────────────────────

/**
 * 요청 한 줄 — 라벨에 발행 시점의 기준을 붙인다. 문장은 읽는 쪽이 쓴다.
 *
 * 자는 도메인이 갖는다(`boardDemandText`) — 사실 카드가 같은 것을 부르므로, 두 벌이면
 * 같은 요청이 감독의 브리핑과 구단주의 입에서 다른 값으로 선다.
 */
function describeDemand(state: GameState, demand: BoardDemand): string {
  const player = demand.playerId ? playerById(state, demand.playerId) : null;
  // 종류가 든 숫자는 하나다 — 채워야 할 목표이거나 발행 시점의 기준값
  return boardDemandText(demand.kind, player?.name ?? "", demand.target ?? demand.baseline);
}

/** 요청이 든 숫자 — 목표(`field-player`)이거나 기준값이고, 없는 종류는 빈손이다 */
function demandValues(demand: BoardDemand): { values?: Record<string, number> } {
  if (demand.target !== undefined) return { values: { target: demand.target } };
  if (demand.baseline !== undefined) return { values: { baseline: demand.baseline } };
  return {};
}

/**
 * 구단주가 찾아온 자리에 싣는 요청 줄 (people.md §8) — **창 갈래의 평소 조건이 서는
 * 것 자체는 자리를 열지 않는다.** 자리는 순위 압력이 열고, 열린 자리가 조건을 함께
 * 나른다. 스스로 자리를 여는 둘(재정 갈래·시즌 갈래)은 `approach.ts`가 따로 세운다.
 */
export function boardDemandFact(state: GameState): PressFact | null {
  const demand = openBoardDemand(state);
  if (!demand) return null;
  const player = demand.playerId ? playerById(state, demand.playerId) : null;
  return {
    kind: "board-demand",
    data: {
      // 사유는 재정 갈래에만 있다 — `tags[1]`이 그 자리다 (career.md §5.2)
      tags: demand.cause ? [demand.kind, demand.cause] : [demand.kind],
      date: demand.deadline,
      ...(player ? { name: player.name } : {}),
      ...demandValues(demand),
    },
    about: demand.playerId ?? null,
    sharp: true,
  };
}
