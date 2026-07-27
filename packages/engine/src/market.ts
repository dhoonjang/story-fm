import type { GamePlayer } from "@story-fm/domain";
import { ageOf, naturalPositionOf } from "@story-fm/domain";
import { diffDays, windowOpenOn } from "./calendar";
import { leagueCatalogById } from "./data/league-catalog";
import { leagueOfTeam, teamCatalogById } from "./data/team-catalog";
import { euroCompetitionOf } from "./europe";
import { hashChannel } from "./rng";
import { knowledgeOf, KNOWLEDGE_KO, type Knowledge } from "./scouting";
import {
  activeContract,
  financeOf,
  playerById,
  playersOf,
  teamName,
  weeklyWagesOf,
  type GameState,
} from "./state";

/**
 * 이적 시장 — 시장가·요구액·주급 기대치와 **딜 성공 확률**을 결정적으로 계산한다.
 *
 * 여기가 협상의 장부다. LLM은 이 숫자를 앵커로 상대편이 되어 판정하고(수락·역제안·
 * 결렬), 코어는 그 판정이 가능한 것인지만 검증한다 (docs/design/transfers.md).
 *
 * 모든 함수는 순수 함수다 — 상태를 읽고 숫자를 낸다. 조회 도구가 그대로 쓴다.
 */

/**
 * **84 OVR 정점기(24~27세) 선수의 시장가.** ⚠️ 밸런스 임시값 (사용자 확인 대기).
 * 곡선 전체가 이 한 값에 비례하므로 조정은 여기서 끝난다.
 *
 * 이적료를 주급에 비례시키지 않는 이유: 실제 축구에서 주급은 완만하고 이적료는
 * 급하다 (84 OVR과 62 OVR의 주급 차이는 3.5배지만 이적료 차이는 수십 배다).
 * 그래서 등급에서 55를 뺀 값의 거듭제곱으로 따로 휘게 만든다.
 */
export const MARKET_VALUE_AT_84 = 65_000_000;
/** 곡선의 급함 — 클수록 최상급과 스쿼드 자원의 격차가 벌어진다 */
const VALUE_EXPONENT = 2.6;
/** 이 등급 아래는 이적료가 거의 붙지 않는다 */
const VALUE_FLOOR_RATING = 55;

/** 인내심 감쇠 — 같은 조건을 반복할 때마다 확률에 곱해진다 */
export const PATIENCE_DECAY = 0.72;
/** "같은 조건"의 기준 — 이적료·주급이 각각 이 비율 안이면 반복으로 본다 */
export const SAME_TERMS_TOLERANCE = 0.03;

/** σ(이 값) = 0.85 — "기대치를 정확히 맞췄을 때" 응할 확률 */
const MEETS_ASKING_SCORE = 1.73;

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** 계약 잔여 연수 (소수) — 만료가 가까울수록 몸값이 빠진다 */
function contractYearsLeft(state: GameState, playerId: string): number {
  const contract = activeContract(state, playerId);
  if (!contract) return 0;
  return Math.max(0, diffDays(state.date, contract.until) / 365);
}

/** 나이·잠재력 곡선 — 피크는 24~27, 어린 유망주는 잠재력만큼 프리미엄 */
function ageCurve(age: number, overall: number, potential: number): number {
  const upside = Math.max(0, potential - overall);
  // 어릴수록 "지금"보다 "될 것"에 값을 매긴다 — 유망주 프리미엄
  if (age <= 21) return 1 + Math.min(0.6, upside / 25);
  if (age <= 23) return 1 + Math.min(0.3, upside / 45);
  if (age <= 27) return 1;
  if (age <= 29) return 0.82;
  if (age <= 31) return 0.6;
  if (age <= 33) return 0.38;
  return 0.2;
}

function contractFactor(yearsLeft: number): number {
  if (yearsLeft <= 0) return 0; // 계약 만료 = 자유계약, 이적료 없음
  if (yearsLeft < 1) return 0.45;
  if (yearsLeft < 2) return 0.7;
  if (yearsLeft < 3) return 0.9;
  return 1;
}

function leagueFactor(teamId: string): number {
  const coefficient = leagueCatalogById(leagueOfTeam(teamId))?.coefficient ?? 5;
  return 1.15 - coefficient * 0.05; // 계수 1 → 1.10, 계수 5 → 0.90
}

/** 등급 → 기본 시장가. 84 OVR이 기준점이고 아래로 급하게 떨어진다 */
export function baseValueOf(overall: number): number {
  const over = Math.max(0, overall - VALUE_FLOOR_RATING);
  return MARKET_VALUE_AT_84 * Math.pow(over / (84 - VALUE_FLOOR_RATING), VALUE_EXPONENT);
}

/** 이 선수의 시장가 (£) — 안개 없는 진짜 값 */
export function marketValueOf(state: GameState, player: GamePlayer): number {
  const base = baseValueOf(player.attributes.overall);
  const age = ageOf(player.birthdate, state.date);
  const value =
    base *
    ageCurve(age, player.attributes.overall, player.attributes.potential) *
    (1 + player.state.form * 0.04) *
    contractFactor(contractYearsLeft(state, player.id)) *
    leagueFactor(player.teamId);
  return Math.round(value / 100_000) * 100_000;
}

/** 이 선수가 원하는 주급 (£/주) — 현 주급과 시장가에서 파생 */
export function wageExpectationOf(state: GameState, player: GamePlayer): number {
  const current = activeContract(state, player.id)?.weeklyWage ?? 0;
  const byRating = Math.pow(Math.max(40, player.attributes.overall) / 40, 4.2) * 6_000;
  // 이적은 인상을 전제한다 — 현 주급의 115% 또는 등급 기대치 중 높은 쪽
  return Math.round(Math.max(current * 1.15, byRating) / 1_000) * 1_000;
}

/**
 * 이 팀에서 그 자리를 더 잘 보는 선수 수 — 포지션군(GK/DF/MF/FW)은 40인 스쿼드에서
 * 너무 거칠어 "8명이 더 낫다"가 늘 나온다. 주 포지션 코드로 좁혀 센다.
 */
function betterAtPosition(state: GameState, teamId: string, player: GamePlayer): number {
  const position = naturalPositionOf(player).position;
  return playersOf(state, teamId).filter(
    (p) =>
      p.id !== player.id &&
      naturalPositionOf(p).position === position &&
      p.attributes.overall > player.attributes.overall,
  ).length;
}

/** 파는 쪽의 태도 — 요구액이 시장가에서 얼마나 벌어지는가 */
function sellerStance(state: GameState, player: GamePlayer): { multiple: number; why: string[] } {
  const why: string[] = [];
  let multiple = 1.1; // 기본적으로 시장가보다 조금 높게 부른다
  const better = betterAtPosition(state, player.teamId, player);
  if (better === 0) {
    multiple += 0.25;
    why.push("팀의 대체 불가 자원이다");
  } else if (better >= 2) {
    multiple -= 0.15;
    why.push(`같은 자리에 더 나은 선수가 ${better}명 있다`);
  }
  const yearsLeft = contractYearsLeft(state, player.id);
  if (yearsLeft < 1) {
    multiple -= 0.2;
    why.push("계약이 1년도 남지 않았다");
  }
  const finance = financeOf(state, player.teamId);
  if (finance.balance < weeklyWagesOf(state, player.teamId) * 20) {
    multiple -= 0.15;
    why.push("상대 구단의 재정이 빠듯하다");
  }
  return { multiple: Math.max(0.7, multiple), why };
}

/** 상대가 기대하는 이적료 */
export function askingPriceFor(state: GameState, player: GamePlayer): number {
  const stance = sellerStance(state, player);
  return Math.round((marketValueOf(state, player) * stance.multiple) / 100_000) * 100_000;
}

export interface DealFactor {
  label: string;
  /** 확률 기여 (%p) — 합이 최종 확률과 정확히 같지는 않다 (곱셈 구조) */
  delta: number;
  why: string;
}

export interface DealOdds {
  /** 0~100 — 이 조건이 받아들여질 확률 (우리가 아는 만큼 흐려진 값) */
  probability: number;
  marketValue: number;
  askingPrice: number;
  wageExpectation: number;
  /** 우리가 이 선수를 얼마나 아는가 — 숫자의 신뢰도 */
  knowledge: Knowledge;
  /** 안개가 낀 값인가 (seen·rumoured) */
  fuzzy: boolean;
  factors: DealFactor[];
  /** 확률과 무관하게 막는 것 — 하나라도 있으면 오퍼 자체가 불가능하다 */
  blockers: string[];
}

export interface DealTerms {
  playerId: string;
  fee: number;
  weeklyWage: number;
  /** 계약 연수 */
  years: number;
  /**
   * 영입인가 매각인가 — 기본은 영입.
   * 매각이면 관문이 뒤집힌다: **사는 쪽이 그 값을 낼까** + **선수가 떠날까**.
   */
  kind?: "buy" | "sell";
}

/** 매각 상대 — 우리가 부른 값을 낼 구단 (오퍼를 넣은 쪽) */
export interface SellContext {
  buyerTeamId: string;
}

/** 안개 밴드 — 지식 수준이 낮으면 확률·금액이 흐려진다 (결정적) */
const ODDS_MARGIN: Record<Knowledge, number> = { own: 0, scouted: 0, seen: 10, rumoured: 20 };

function fuzz(seed: number, key: string, value: number, margin: number): number {
  if (margin === 0) return value;
  const h = hashChannel(`${seed}:${key}`);
  const offset = (h % (margin * 2 + 1)) - margin;
  return value + offset;
}

/**
 * 딜 성공 확률 — 두 관문의 곱.
 *
 * `p_club`(파는 구단이 응할 확률) × `p_player`(선수가 응할 확률) × 창 마감 압박.
 * 여기에 **인내심 감쇠**(같은 조건 반복)가 곱해진다. `factors`가 그 분해다 —
 * 확률만 주면 LLM이 "왜"를 지어내므로 근거를 함께 준다.
 */
export function dealOdds(state: GameState, terms: DealTerms): DealOdds {
  const player = playerById(state, terms.playerId);
  const knowledge = player ? knowledgeOf(state, terms.playerId) : "rumoured";
  const empty: DealOdds = {
    probability: 0,
    marketValue: 0,
    askingPrice: 0,
    wageExpectation: 0,
    knowledge,
    fuzzy: false,
    factors: [],
    blockers: [`"${terms.playerId}"라는 선수를 찾지 못했습니다`],
  };
  if (!player) return empty;

  const blockers: string[] = [];
  const marketValue = marketValueOf(state, player);
  const askingPrice = askingPriceFor(state, player);
  const wageExpectation = wageExpectationOf(state, player);
  const window = windowOpenOn(state.windows, state.date);
  const freeAgent = contractYearsLeft(state, player.id) <= 0;

  if (terms.kind === "sell") {
    if (player.teamId !== state.userTeamId) {
      blockers.push(`${player.name}은(는) 우리 선수가 아닙니다`);
    }
    if (!window) blockers.push("이적시장이 닫혀 있습니다");
  } else {
    if (player.teamId === state.userTeamId) {
      blockers.push(`${player.name}은(는) 이미 우리 선수입니다`);
    }
    if (!window && !freeAgent) {
      blockers.push("이적시장이 닫혀 있습니다");
    }
    const budget = financeOf(state, state.userTeamId).transferBudget;
    if (terms.fee > budget) {
      blockers.push(`이적 예산을 넘습니다 — 가용 £${(budget / 1_000_000).toFixed(1)}M`);
    }
  }

  if (terms.kind === "sell") {
    return sellOdds(state, terms, player, blockers, knowledge);
  }

  /**
   * 기여 항목 — 각 항이 어느 관문의 점수를 얼마나 움직이는지만 적는다.
   * 확률 기여(%p)는 마지막에 **빼고 다시 계산해서** 구한다. 임의 상수를 delta로
   * 쓰면 "왜"가 거짓이 된다 (디자인 원칙 2 — 납득 가능한 결과).
   */
  const contributions: Array<{
    gate: "club" | "player";
    score: number;
    label: string;
    why: string;
  }> = [];

  // ① 파는 구단 — 제시 이적료와 상대 사정
  const stance = sellerStance(state, player);
  const feeRatio = askingPrice > 0 ? terms.fee / askingPrice : 2;
  contributions.push({
    gate: "club",
    score: (feeRatio - 1) * 8,
    label: "제시 이적료",
    why:
      askingPrice > 0
        ? `상대는 £${(askingPrice / 1_000_000).toFixed(1)}M을 기대한다 (제시액은 그 ${Math.round(feeRatio * 100)}%)`
        : "계약이 만료돼 이적료가 필요 없다",
  });
  for (const why of stance.why) {
    contributions.push({
      gate: "club",
      score: why.includes("대체 불가") ? -0.9 : 0.75,
      label: "상대 사정",
      why,
    });
  }

  // ② 선수 본인 — 주급·출전 기회·간판
  const wageRatio = wageExpectation > 0 ? terms.weeklyWage / wageExpectation : 1.2;
  contributions.push({
    gate: "player",
    score: (wageRatio - 1) * 6,
    label: "제시 주급",
    why: `선수 기대는 £${Math.round(wageExpectation / 1_000)}k/주 (제시액은 그 ${Math.round(wageRatio * 100)}%)`,
  });

  const ourCup = euroCompetitionOf(state.euroEntrants, state.userTeamId);
  const theirCup = euroCompetitionOf(state.euroEntrants, player.teamId);
  if (ourCup && !theirCup) {
    contributions.push({
      gate: "player",
      score: 0.5,
      label: "대항전 출전권",
      why: "우리는 유럽에 나가고 상대는 아니다",
    });
  } else if (!ourCup && theirCup) {
    contributions.push({
      gate: "player",
      score: -0.5,
      label: "대항전 출전권",
      why: "상대는 유럽에 나가고 우리는 아니다",
    });
  }

  const blockedBy = betterAtPosition(state, state.userTeamId, player);
  if (blockedBy >= 2) {
    contributions.push({
      gate: "player",
      score: -0.45,
      label: "출전 경쟁",
      why: `우리 ${naturalPositionOf(player).position} 자리에 더 나은 선수가 ${blockedBy}명 있다`,
    });
  } else if (blockedBy === 0) {
    contributions.push({
      gate: "player",
      score: 0.35,
      label: "출전 기회",
      why: "곧바로 주전으로 뛸 자리가 있다",
    });
  }

  const reputation = (state.manager.reputation.media + state.manager.reputation.board) / 2;
  if (Math.abs(reputation - 50) >= 10) {
    contributions.push({
      gate: "player",
      score: (reputation - 50) / 60,
      label: "감독 평판",
      why: `언론·보드 평판 ${Math.round(reputation)}`,
    });
  }

  // ③ 감독 협상력 — 두 관문에 함께 (결정 #13)
  const negotiation = state.manager.attributes.negotiation;
  if (Math.abs(negotiation - 50) >= 5) {
    const score = (negotiation - 50) / 100;
    contributions.push({ gate: "club", score, label: "감독 협상력", why: `협상 ${negotiation}` });
    contributions.push({ gate: "player", score, label: "감독 협상력", why: `협상 ${negotiation}` });
  }

  // ④ 창 마감 압박 · ⑤ 인내심 — 확률에 곱해지는 항
  let multiplier = 1;
  const repeats = sameTermsRepeats(state, terms);
  const closingSoon = window ? diffDays(state.date, window.closesOn) <= 3 : false;
  if (closingSoon) multiplier *= 1.15;
  if (repeats > 0) multiplier *= Math.pow(PATIENCE_DECAY, repeats);

  const sumOf = (gate: "club" | "player", skip: ReadonlySet<number>) =>
    contributions.reduce(
      (acc, c, i) => acc + (c.gate === gate && !skip.has(i) ? c.score : 0),
      MEETS_ASKING_SCORE,
    );
  const NONE: ReadonlySet<number> = new Set();
  const chance = (skip: ReadonlySet<number> = NONE, withMultiplier = multiplier) =>
    sigmoid(sumOf("club", skip)) * sigmoid(sumOf("player", skip)) * withMultiplier * 100;

  const raw = chance();
  // 같은 항목명(예: 두 관문에 함께 들어가는 감독 협상력)은 한 줄로 합친다
  const grouped = new Map<string, { why: string; indices: number[] }>();
  contributions.forEach((c, i) => {
    const key = `${c.label}|${c.why}`;
    const found = grouped.get(key);
    if (found) found.indices.push(i);
    else grouped.set(key, { why: c.why, indices: [i] });
  });
  const factors: DealFactor[] = [
    {
      label: "기준",
      delta: Math.round(sigmoid(MEETS_ASKING_SCORE) ** 2 * 100),
      why: "이적료·주급 기대치를 그대로 맞췄을 때",
    },
    // 각 항의 기여 = 그 항만 빼고 다시 계산한 값과의 차이 (한계 기여)
    ...[...grouped.entries()].map(([key, group]) => ({
      label: key.split("|")[0]!,
      delta: Math.round(raw - chance(new Set(group.indices))),
      why: group.why,
    })),
  ];
  if (closingSoon) {
    factors.push({
      label: "마감 임박",
      delta: Math.round(raw - chance(NONE, multiplier / 1.15)),
      why: `이적시장 마감까지 ${window ? diffDays(state.date, window.closesOn) : 0}일`,
    });
  }
  if (repeats > 0) {
    factors.push({
      label: "상대의 인내심",
      delta: Math.round(raw - chance(NONE, multiplier / Math.pow(PATIENCE_DECAY, repeats))),
      why: `같은 조건으로 ${repeats + 1}번째 제안이다 — 조건을 올려야 움직인다`,
    });
  }

  // 안개는 **선수별 고정 편향**이다. 제시액마다 새로 뽑으면 "더 줬는데 확률이
  // 떨어지는" 일이 생겨 흥정이 무의미해진다 (단조성은 테스트로 고정).
  const margin = ODDS_MARGIN[knowledge];
  const shown = Math.max(
    0,
    Math.min(100, Math.round(fuzz(state.seed, `odds:${player.id}`, raw, margin))),
  );
  return {
    probability: shown,
    marketValue: Math.max(
      0,
      Math.round(fuzz(state.seed, `mv:${player.id}`, marketValue, margin * marketValue * 0.004)),
    ),
    askingPrice: Math.max(
      0,
      Math.round(fuzz(state.seed, `ap:${player.id}`, askingPrice, margin * askingPrice * 0.004)),
    ),
    wageExpectation,
    knowledge,
    fuzzy: margin > 0,
    factors,
    blockers,
  };
}

/**
 * 매각 확률 — 관문이 뒤집힌다.
 *
 * ① **사는 쪽이 그 값을 낼까** — 우리가 부르는 값이 상대의 상한을 넘으면 떨어진다.
 *    상한은 시장가 기준이다(구단은 시장가를 크게 넘겨 사지 않는다).
 * ② **선수가 떠날까** — 우리 팀에서 주전이면 버티고, 자리가 막혀 있으면 떠나려 한다.
 *    이 관문 때문에 "핵심을 팔아 돈을 만드는" 선택이 공짜가 아니다.
 */
function sellOdds(
  state: GameState,
  terms: DealTerms,
  player: GamePlayer,
  blockers: string[],
  knowledge: Knowledge,
): DealOdds {
  const marketValue = marketValueOf(state, player);
  const buyerCeiling = Math.round(marketValue * BUYER_CEILING_MULTIPLE);
  const wageExpectation = wageExpectationOf(state, player);
  const contributions: Array<{
    gate: "club" | "player";
    score: number;
    label: string;
    why: string;
  }> = [];

  const feeRatio = terms.fee > 0 ? buyerCeiling / terms.fee : 2;
  contributions.push({
    gate: "club",
    score: (feeRatio - 1) * 8,
    label: "우리가 부른 값",
    why: `사는 쪽이 낼 수 있는 상한은 £${(buyerCeiling / 1_000_000).toFixed(1)}M 정도다 (부른 값은 그 ${Math.round((terms.fee / Math.max(1, buyerCeiling)) * 100)}%)`,
  });

  const blockedBy = betterAtPosition(state, state.userTeamId, player);
  if (blockedBy === 0) {
    contributions.push({
      gate: "player",
      score: -0.8,
      label: "선수의 의지",
      why: `우리 ${naturalPositionOf(player).position} 자리의 주전이다 — 떠날 이유가 없다`,
    });
  } else if (blockedBy >= 2) {
    contributions.push({
      gate: "player",
      score: 0.7,
      label: "선수의 의지",
      why: `자리가 막혀 있다 (더 나은 선수 ${blockedBy}명) — 출전 기회를 찾는다`,
    });
  }
  if (player.state.morale < 45) {
    contributions.push({
      gate: "player",
      score: 0.5,
      label: "선수의 사기",
      why: `사기 ${player.state.morale} — 팀에 남을 마음이 옅다`,
    });
  }
  const yearsLeft = contractYearsLeft(state, player.id);
  if (yearsLeft < 1) {
    contributions.push({
      gate: "player",
      score: 0.4,
      label: "계약 잔여",
      why: "계약이 1년도 남지 않아 붙잡을 명분이 약하다",
    });
  }
  const negotiation = state.manager.attributes.negotiation;
  if (Math.abs(negotiation - 50) >= 5) {
    contributions.push({
      gate: "club",
      score: (negotiation - 50) / 100,
      label: "감독 협상력",
      why: `협상 ${negotiation}`,
    });
  }

  const sumOf = (gate: "club" | "player", skip: ReadonlySet<number>) =>
    contributions.reduce(
      (acc, c, i) => acc + (c.gate === gate && !skip.has(i) ? c.score : 0),
      MEETS_ASKING_SCORE,
    );
  const NONE: ReadonlySet<number> = new Set();
  const chance = (skip: ReadonlySet<number> = NONE) =>
    sigmoid(sumOf("club", skip)) * sigmoid(sumOf("player", skip)) * 100;
  const raw = chance();

  const factors: DealFactor[] = [
    {
      label: "기준",
      delta: Math.round(sigmoid(MEETS_ASKING_SCORE) ** 2 * 100),
      why: "상대 상한에 맞춰 부르고 선수도 떠날 뜻이 있을 때",
    },
    ...contributions.map((c, i) => ({
      label: c.label,
      delta: Math.round(raw - chance(new Set([i]))),
      why: c.why,
    })),
  ];

  return {
    probability: Math.max(0, Math.min(100, Math.round(raw))),
    marketValue,
    askingPrice: buyerCeiling,
    wageExpectation,
    knowledge,
    fuzzy: false, // 우리 선수라 안개가 없다
    factors,
    blockers,
  };
}

/** 사는 쪽이 낼 수 있는 상한 — 시장가의 이 배수 (구단은 시장가를 크게 넘기지 않는다) */
const BUYER_CEILING_MULTIPLE = 1.15;

/** 이 선수에게 같은 조건으로 몇 번 제안했는가 — 인내심 감쇠의 근거 */
export function sameTermsRepeats(state: GameState, terms: DealTerms): number {
  const negotiation = state.negotiations.find(
    (n) => n.gamePlayerId === terms.playerId && n.status === "open",
  );
  if (!negotiation) return 0;
  return negotiation.rounds.filter(
    (r) =>
      r.by === "us" &&
      near(r.fee, terms.fee, SAME_TERMS_TOLERANCE) &&
      near(r.weeklyWage, terms.weeklyWage, SAME_TERMS_TOLERANCE),
  ).length;
}

function near(a: number, b: number, tolerance: number): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / scale <= tolerance;
}

/**
 * 응답까지 걸리는 날수 — **상황에서 나온다** (고정 지연이 아니다).
 *
 * 헐값이면 볼 것도 없이 하루 만에 차이고, 진지한 제안은 이사회가 논의하며 며칠을
 * 쓴다. 마감이 임박하면 절반으로 줄고, 같은 조건을 반복하면 상대가 지쳐 미룬다.
 * 범위 안의 실제 값은 시드 해시로 뽑아 결정적이면서도 자연스럽게 흩어진다.
 */
export function responseDelayDays(
  state: GameState,
  terms: DealTerms,
  probability: number,
  repeats = 0,
): number {
  const [from, to] = probability < 15 ? [1, 1] : probability >= 70 ? [1, 3] : [2, 5];
  const h = hashChannel(`${state.seed}:delay:${terms.playerId}:${state.date}:${terms.fee}`);
  let days = from + (h % (to - from + 1));
  const window = windowOpenOn(state.windows, state.date);
  if (window && diffDays(state.date, window.closesOn) <= 3)
    days = Math.max(1, Math.floor(days / 2));
  return days + (repeats > 0 ? 1 : 0);
}

/** 협상 상황 한 줄 요약 — 조회 도구·상태 스냅샷용 */
export function describeOdds(odds: DealOdds): string {
  if (odds.blockers.length > 0) return `불가 — ${odds.blockers.join(" / ")}`;
  const money = (n: number) => `£${(n / 1_000_000).toFixed(1)}M`;
  const head = odds.fuzzy
    ? `성사 가능성 ${oddsLabel(odds.probability)} (${KNOWLEDGE_KO[odds.knowledge]} — 숫자는 어림)`
    : `성사 확률 ${odds.probability}%`;
  return [
    head,
    `시장가 ${money(odds.marketValue)} · 요구액 ${money(odds.askingPrice)} · 주급 기대 £${Math.round(odds.wageExpectation / 1_000)}k`,
    ...odds.factors.map(
      (f) => `  ${f.delta >= 0 ? "+" : "−"}${Math.abs(f.delta)} ${f.label} — ${f.why}`,
    ),
  ].join("\n");
}

/** 안개가 낀 확률은 숫자 대신 라벨로 — 기존 안개 규칙과 같은 태도 */
export function oddsLabel(probability: number): string {
  if (probability >= 80) return "거의 확실하다";
  if (probability >= 60) return "해볼 만하다";
  if (probability >= 40) return "반반이다";
  if (probability >= 20) return "쉽지 않다";
  if (probability >= 8) return "가망이 희박하다";
  return "사실상 불가능하다";
}

/** 협상 상대 — buy는 선수의 현 소속, sell은 오퍼를 넣은 구단 */
export function counterpartOf(state: GameState, playerId: string): string | null {
  const player = playerById(state, playerId);
  if (!player || player.teamId === state.userTeamId) return null;
  return player.teamId;
}

export { teamName, teamCatalogById };
