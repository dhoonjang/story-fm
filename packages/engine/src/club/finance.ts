import type {
  FinanceCategory,
  FinanceReport,
  FinanceReportLine,
  LedgerEntry,
  MatchRecord,
} from "@story-fm/domain";
import {
  FINANCE_CATEGORY_KO,
  FINANCE_EXPENSE_CATEGORIES,
  FINANCE_INCOME_CATEGORIES,
} from "@story-fm/domain";
import { dayOfWeek } from "../competition/calendar";
import { clubProfile } from "../data/club-profile";
import { clubEconomyLevel } from "../world/wages";
import { isMarketOnlyLeague, isTopLeague, leagueCatalogById } from "../data/league-catalog";
import { competitionShortName, isCup, isEuroCup } from "../data/cup-catalog";
import { isClubTeam, leagueOfTeam, teamCatalogById } from "../data/team-catalog";
import { leagueOfTeamIn } from "../competition/promotion";
import { computeStandings } from "../competition/season";
import {
  financeOf,
  pushNarrative,
  teamShortName,
  weeklyWagesOf,
  type GameState,
} from "../core/state";
import { makeRng } from "../core/rng";

/**
 * 구단 재정 — 실제 구단의 매출·비용 구조 (docs/simulation/finance.md).
 *
 * 이 파일이 **재정 상수와 공식의 유일한 자리**다. tick·경기·협상은 여기 함수만
 * 부른다. 모든 계산은 결정적이며(난수는 시드 해시뿐) LLM은 개입하지 않는다 —
 * 재정은 장부이므로 코어의 몫이다 (AGENTS §4).
 *
 * 두 축을 구분한다:
 *   현금(cash)   — 통장. 이적료가 즉시 빠진다.
 *   손익(pnl)    — 장부. 이적료 대신 계약기간으로 나눈 상각이 잡힌다.
 * PSR(3시즌 누적 손익) 판정은 손익 축으로만 가능하다 (결정 A).
 */

// ── 상수 (EPL 기준값 — 다른 리그는 broadcastPool 배율) ──────────────

/**
 * 중계권 균등 배분 — 시즌 총액. **12개월 분납**한다.
 *
 * 실제 배분은 시즌 중 분기 지급이지만, 경기 없는 달(6·7월)에 방송 수입을 0으로
 * 두면 그 달의 급여 비중이 300%로 튀어 지표가 무의미해진다. 실제 구단도 현금은
 * 연중 들어온다 — 총액을 유지하고 고르게 나눈다.
 */
const BROADCAST_EQUAL_SEASON = 110_000_000;
const BROADCAST_MONTHS = 12;
/** 성적 수당 — 순위 한 계단당. 1위 = 20계단 (2.4 × 20 = £48M) */
const BROADCAST_MERIT_STEP = 2_400_000;
/** 생중계로 편성된 경기당 수당 */
const BROADCAST_FACILITY_PER_MATCH = 1_100_000;
/** 매출 어림에 쓰는 중위 구단의 자 — 20팀 리그의 중간 순위, 시즌 38경기 중 편성분 */
const MERIT_STEPS_TYPICAL = 10;
const TELEVISED_TYPICAL = 32;

/**
 * **파라슈트 페이먼트** — 강등 클럽이 떠나온 리그에서 받는 낙하산.
 *
 * 실제 EPL은 강등 뒤 3년간 순수 중계 몫의 55/45/20%를 준다(승격 1시즌 만에
 * 다시 내려간 팀은 2년). 우리 균등 배분(£110M)은 중앙 상업 몫까지 흡수한
 * 값이라 같은 금액이 되도록 비율을 조금 낮춰 잡는다.
 *
 * 이게 없으면 강등이 곧 파산이다 — 실제로 챔피언십의 재정 기준선을 올려
 * 놓는 것이 이 돈이고, 강등 팀의 40%가 한 시즌 만에 돌아오는 이유이기도 하다.
 */
const PARACHUTE_RATE: readonly number[] = [0.45, 0.36, 0.16];
/** 승격 1시즌 만에 다시 강등되면 2년만 받는다 */
const PARACHUTE_YEARS_SHORT = 2;

/**
 * 강등이 상업 수입에 오는 데는 시간이 걸린다 — 스폰서 계약은 그날 끝나지 않는다.
 * 실측(리즈 −10% · 레스터 −26%)이 그 폭이고, **파라슈트가 끝나는 3년차와 겹쳐**
 * 이중 절벽이 된다.
 */
const RELEGATED_COMMERCIAL: readonly number[] = [-0.1, -0.25, -0.35];

/** 상업(스폰서십) 월 정액 — 브랜드 규모별 */
const COMMERCIAL_MONTHLY: Record<1 | 2 | 3 | 4, number> = {
  1: 4_500_000,
  2: 2_600_000,
  3: 1_500_000,
  4: 900_000,
};
/** 머천다이징 월 정액 — 브랜드 규모별 */
const MERCHANDISING_MONTHLY: Record<1 | 2 | 3 | 4, number> = {
  1: 1_200_000,
  2: 700_000,
  3: 400_000,
  4: 250_000,
};

/** 매치데이 — 기본 점유율(전력 등급별)과 호스피탈리티 가산율 */
const OCCUPANCY_BASE: Record<1 | 2 | 3 | 4, number> = { 1: 0.97, 2: 0.9, 3: 0.85, 4: 0.8 };
const HOSPITALITY_RATE: Record<1 | 2 | 3 | 4, number> = { 1: 0.35, 2: 0.28, 3: 0.2, 4: 0.15 };
/** 티켓 단가 보정 — 리그 평균가에 곱한다 */
const TICKET_TIER_FACTOR: Record<1 | 2 | 3 | 4, number> = { 1: 1.3, 2: 1.1, 3: 0.95, 4: 0.8 };
/** 경기 운영비 — 매치데이 수입 대비 */
const MATCHDAY_OPEX_RATE = 0.12;

/** 스태프 급여 — 월 선수 급여 대비 (하위 팀일수록 상대 비중이 크다) */
const STAFF_WAGE_RATE: Record<1 | 2 | 3 | 4, number> = { 1: 0.22, 2: 0.24, 3: 0.26, 4: 0.28 };
/** 승리 수당 — 주급 총액 대비 */
const WIN_BONUS_RATE = 0.1;
/**
 * 시설·아카데미 월 정액 — **tier 정액 × 구단 경제 수준**(`facilityCostOf`).
 *
 * 표는 EPL 기준이다. 리그를 곱하지 않으면 세리에B 구단이 EPL tier와 같은 시설비를
 * 내면서 리그 배율이 걸린 수입만 받아 가라앉는다 (§10.2 — 고정비가 인건비의 1.9배).
 * tier 곡선은 그대로 둔다 — 같은 리그 안에서 작은 구단이 상대적으로 무거운 고정비를
 * 지는 것은 실제와 같다.
 */
const FACILITY_MONTHLY: Record<1 | 2 | 3 | 4, number> = {
  1: 3_500_000,
  2: 2_800_000,
  3: 2_200_000,
  4: 1_600_000,
};
/** 이자·세금 월 정액 (부채 모델 전의 뭉갠 값 — club-finance §12) */
const FINANCE_COST_MONTHLY: Record<1 | 2 | 3 | 4, number> = {
  1: 1_500_000,
  2: 1_100_000,
  3: 700_000,
  4: 400_000,
};
/** 원정 비용 — 국내/유럽 */
const TRAVEL_DOMESTIC = 120_000;
const TRAVEL_EUROPE = 400_000;
/** 부상 치료비 — 심각도별 */
const MEDICAL_COST: Record<"minor" | "moderate" | "major", number> = {
  minor: 30_000,
  moderate: 120_000,
  major: 400_000,
};
/** 에이전트 수수료 — 이적료 대비 */
export const AGENT_FEE_RATE = 0.1;

/** 상세 원장 보존 개월 수 — 그 이전은 월간 보고서가 요약해 보관한다 */
const LEDGER_MONTHS_KEPT = 3;

/** PSR — 3시즌 누적 손실 한도 (실제 EPL 규정과 같은 £105M) */
export const PSR_LOSS_LIMIT = 105_000_000;
const PSR_SEASONS = 3;

/** 급여 비중 경고선 — 게임 기준 (실제 EPL 평균은 70% 근처) */
const WAGE_RATIO_CAUTION = 0.65;
const WAGE_RATIO_DANGER = 0.75;

// ── 기본 유틸 ───────────────────────────────────────────

function tierOf(teamId: string): 1 | 2 | 3 | 4 {
  return teamCatalogById(teamId)?.tier ?? 3;
}

function profileOf(teamId: string) {
  return clubProfile(teamId, tierOf(teamId));
}

function poolOf(state: GameState, teamId: string): number {
  return leagueCatalogById(leagueOfTeamIn(state, teamId))?.broadcastPool ?? 0.3;
}

/** 시설·아카데미 월 고정비 — tier 정액에 구단 경제 수준을 곱한다 */
function facilityCostOf(teamId: string): number {
  return FACILITY_MONTHLY[tierOf(teamId)] * clubEconomyLevel(teamId);
}

/** 이자·세금 월 고정비 — 같은 자 */
function financeCostOf(teamId: string): number {
  return FINANCE_COST_MONTHLY[tierOf(teamId)] * clubEconomyLevel(teamId);
}

/**
 * 경기 성적과 무관하게 매달 나가는 돈 (시설·아카데미 + 이자·세금).
 * 이게 인건비를 넘으면 그 리그는 구조적으로 가라앉는다 — §10.2가 세리에B에서 본 결함.
 */
export function monthlyFixedCostOf(teamId: string): number {
  return facilityCostOf(teamId) + financeCostOf(teamId);
}

/**
 * 균등 배분에도 **리그 배율을 적용한다** (club-finance §5.1) — 실제로 각국 중계권
 * 규모는 리그마다 크게 다르다 (리그1은 EPL의 0.16).
 *
 * 예전엔 껐다. 주급 곡선이 리그를 몰라(능력치로만 정해져) 약체 리그 구단이 EPL 수준
 * 주급을 내면서 6분의 1 수입을 받아 파산했기 때문이다. **주급이 리그를 알게 되면서**
 * (wages.ts) 그 이유가 사라졌다 — 이제 수입도 리그를 안다.
 */
const EQUAL_SHARE_LEAGUE_SCALED = true;

function equalShareFactor(state: GameState, teamId: string): number {
  return EQUAL_SHARE_LEAGUE_SCALED ? poolOf(state, teamId) : 1;
}

const money = (amount: number) =>
  Math.abs(amount) >= 1_000_000
    ? `£${(amount / 1_000_000).toFixed(1)}M`
    : `£${Math.round(amount / 1000)}k`;

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** 구 세이브의 엔트리는 카테고리가 없다 */
export function categoryOf(entry: LedgerEntry): FinanceCategory {
  return entry.category ?? "other";
}

function isNoncash(entry: LedgerEntry): boolean {
  return entry.accounting === "noncash";
}

// ── 원장 기록 ───────────────────────────────────────────

export interface RecordFinanceInput {
  kind: "income" | "expense";
  category: FinanceCategory;
  label: string;
  amount: number;
  ref?: LedgerEntry["ref"];
  /** 상각만 noncash */
  accounting?: "cash" | "noncash";
  time?: string;
  /** 서사가 만든 항목인가 (apply_finance_event) */
  source?: "narrative";
}

/**
 * 재정 변화 기록 — **모든 금액 이동의 유일한 입구**.
 *
 * 잔고는 언제나 갱신하지만 **상세 엔트리는 유저 팀만** 남긴다. AI 팀 재정은
 * 이적 예산·매각 압박에서 잔고만 읽히므로 96팀 분량의 원장을 쌓을 이유가 없다.
 * 상각(noncash)은 장부에만 잡히므로 잔고를 건드리지 않는다.
 */
export function recordFinance(state: GameState, teamId: string, input: RecordFinanceInput): void {
  const f = financeOf(state, teamId);
  const value = Math.max(0, Math.round(input.amount));
  if (value === 0) return;
  const noncash = input.accounting === "noncash";
  if (!noncash) f.balance += input.kind === "income" ? value : -value;
  if (teamId !== state.userTeamId) return;

  const sameDay = f.ledger.filter((e) => e.date === state.date).length;
  f.ledger.push({
    id: `led-${state.date}-${input.category}-${sameDay + 1}`,
    date: state.date,
    ...(input.time ? { time: input.time } : {}),
    kind: input.kind,
    category: input.category,
    label: input.label,
    amount: value,
    ...(input.ref ? { ref: input.ref } : {}),
    ...(noncash ? { accounting: "noncash" as const } : {}),
    ...(input.source ? { source: input.source } : {}),
  });
}

/** 1회성 항목(상금 등)을 중복 지급하지 않고 지급한다 — 원장은 절단되므로 키로 관리 */
export function payOnce(
  state: GameState,
  teamId: string,
  key: string,
  input: RecordFinanceInput,
): boolean {
  const f = financeOf(state, teamId);
  f.prizesPaid ??= [];
  if (input.amount <= 0 || f.prizesPaid.includes(key)) return false;
  f.prizesPaid.push(key);
  recordFinance(state, teamId, input);
  return true;
}

// ── 중계권 ──────────────────────────────────────────────

/**
 * 이 팀의 지난 시즌 리그 순위 — 성적 수당의 기준.
 *
 * 유저 팀은 시즌 기록에서 정확히 알 수 있다. AI 팀은 지난 시즌 순위표를
 * 저장하지 않으므로(시즌 전환에서 파생 후 버린다) 구단 등급으로 어림한다 —
 * AI 팀 재정은 잔고만 쓰이므로 이 정도로 충분하다.
 */
function previousRankOf(state: GameState, teamId: string): number {
  if (teamId === state.userTeamId) {
    const last = [...state.seasonRecords].reverse().find((r) => r.teamId === teamId);
    /**
     * ⚠️ **리그가 바뀌었으면 그 순위는 쓸 수 없다** — 챔피언십 1위와 프리미어리그
     * 1위는 같은 수당이 아니다. 승격·강등한 시즌은 등급 어림으로 되돌린다.
     */
    const sameLeague =
      last?.leagueId === undefined || last.leagueId === leagueOfTeamIn(state, teamId);
    if (last && sameLeague) return last.position;
  }
  const tier = tierOf(teamId);
  return tier === 1 ? 3 : tier === 2 ? 7 : tier === 3 ? 12 : 17;
}

/** 리그 팀 수 — 성적 수당의 계단 수 (18팀 리그는 계단이 짧다) */
function leagueSizeOf(state: GameState, teamId: string): number {
  const league = leagueOfTeamIn(state, teamId);
  return Math.max(2, state.teams.filter((t) => leagueOfTeamIn(state, t.id) === league).length);
}

/**
 * 이 경기가 **리그 중계권 수당**의 대상인가 — 토요일 15:00만 비중계 (실제 블랙아웃 규약).
 *
 * 컵은 전부 제외한다. 대항전 방송 수입은 UEFA 배분(참가비·승무 수당)에, 국내 컵은
 * 라운드 진출 상금에 이미 들어 있어서 여기서 또 주면 이중 계상이다.
 */
export function isTelevised(match: MatchRecord): boolean {
  if (isCup(match.competitionId)) return false;
  const time = match.time ?? "15:00";
  return !(dayOfWeek(match.date) === 6 && time === "15:00");
}

// ── 매치데이 ────────────────────────────────────────────

export interface MatchdayRevenue {
  attendance: number;
  capacity: number;
  occupancy: number;
  /** 입장 + 호스피탈리티 */
  income: number;
  opex: number;
}

/**
 * 홈경기 수입 — `수용인원 × 점유율 × 단가 + 호스피탈리티`.
 *
 * 점유율은 순위·최근 폼·상대 매력도·대회·킥오프 슬롯이 만든다. 시드 해시로
 * ±2%만 흔들어 같은 세이브·같은 경기면 항상 같은 관중이 나온다.
 */
export function matchdayRevenue(state: GameState, match: MatchRecord): MatchdayRevenue {
  const teamId = state.userTeamId;
  const tier = tierOf(teamId);
  const { capacity } = profileOf(teamId);
  const opponentId = match.homeTeamId === teamId ? match.awayTeamId : match.homeTeamId;

  let occupancy = OCCUPANCY_BASE[tier];

  // 순위 — 상위권일수록 표가 팔린다 (순위표가 아직 없으면 보정 없음)
  const standings = computeStandings(state, leagueOfTeamIn(state, teamId));
  const rank = standings.findIndex((r) => r.teamId === teamId) + 1;
  if (rank > 0) occupancy += ((11 - rank) / 10) * 0.04;

  // 최근 5경기 폼
  const recent = state.matches
    .filter((m) => m.result && (m.homeTeamId === teamId || m.awayTeamId === teamId))
    .slice(-5);
  if (recent.length > 0) {
    const wins = recent.filter((m) => {
      const home = m.homeTeamId === teamId;
      const mine = home ? m.result!.homeGoals : m.result!.awayGoals;
      const theirs = home ? m.result!.awayGoals : m.result!.homeGoals;
      return mine > theirs;
    }).length;
    occupancy += (wins / recent.length - 0.4) * 0.05;
  }

  // 상대 매력도 · 대회 · 슬롯
  const oppTier = tierOf(opponentId);
  occupancy += oppTier === 1 ? 0.04 : oppTier === 2 ? 0.02 : oppTier === 4 ? -0.02 : 0;
  if (isCup(match.competitionId)) occupancy += 0.02;
  const dow = dayOfWeek(match.date);
  if (dow === 1 || dow === 2 || dow === 3 || dow === 4) occupancy -= 0.03;

  // 결정적 미세 변동
  const rng = makeRng(state.seed, `attendance:${match.id}`);
  occupancy += (rng() - 0.5) * 0.04;

  occupancy = Math.max(0.45, Math.min(1, occupancy));
  const attendance = Math.round(capacity * occupancy);

  const basePrice = leagueCatalogById(leagueOfTeamIn(state, teamId))?.avgTicketPrice ?? 30;
  const price = basePrice * TICKET_TIER_FACTOR[tier] * (isEuroCup(match.competitionId) ? 1.15 : 1);
  const gate = attendance * price;
  const income = Math.round(gate * (1 + HOSPITALITY_RATE[tier]));

  return {
    attendance,
    capacity,
    occupancy,
    income,
    opex: Math.round(income * MATCHDAY_OPEX_RATE),
  };
}

/**
 * 경기 직후 재정 반영 — 매치데이(홈)·생중계 수당·승리 수당·원정 비용.
 * `finalizeMatch`가 부른다 (경기 사건은 창발, 반영은 공식).
 */
export function applyMatchFinance(
  state: GameState,
  match: MatchRecord,
  outcome: "win" | "draw" | "loss",
  digest: string[],
): void {
  const teamId = state.userTeamId;
  const home = match.homeTeamId === teamId;
  const opponentId = home ? match.awayTeamId : match.homeTeamId;
  const label = `${competitionShortName(match.competitionId)} vs ${teamShortName(opponentId)}`;
  const ref = { type: "match" as const, id: match.id };

  // 홈 입장 수입 — 중립 경기(결승)는 우리 수입이 아니다
  if (home && !match.neutral) {
    const gate = matchdayRevenue(state, match);
    recordFinance(state, teamId, {
      kind: "income",
      category: "matchday",
      label: `홈 입장 수입 (${label} · ${gate.attendance.toLocaleString("en-US")}명)`,
      amount: gate.income,
      ref,
    });
    recordFinance(state, teamId, {
      kind: "expense",
      category: "matchday_opex",
      label: `경기 운영비 (${label})`,
      amount: gate.opex,
      ref,
    });
    digest.push(
      `💰 관중 ${gate.attendance.toLocaleString("en-US")}명 (${Math.round(gate.occupancy * 100)}%) — 입장 수입 ${money(gate.income)}`,
    );
  } else if (!home) {
    recordFinance(state, teamId, {
      kind: "expense",
      category: "travel_medical",
      label: `원정 비용 (${label})`,
      amount: isEuroCup(match.competitionId) ? TRAVEL_EUROPE : TRAVEL_DOMESTIC,
      ref,
    });
  }

  // 생중계 수당 — 편성된 경기만
  if (isTelevised(match)) {
    recordFinance(state, teamId, {
      kind: "income",
      category: "broadcast_facility",
      label: `생중계 수당 (${label})`,
      amount: BROADCAST_FACILITY_PER_MATCH * poolOf(state, teamId),
      ref,
    });
  }

  // 승리 수당
  if (outcome === "win") {
    recordFinance(state, teamId, {
      kind: "expense",
      category: "bonus",
      label: `승리 수당 (${label})`,
      amount: weeklyWagesOf(state, teamId) * WIN_BONUS_RATE,
      ref,
    });
  }
}

/**
 * AI 팀 경기의 재정 반영 — 간이 시뮬(`quickSimulate`)마다.
 *
 * 유저 경기와 달리 **가벼운 공식**을 쓴다: 한 시즌에 1500경기가 지나가므로
 * 순위표·최근 폼을 매번 계산할 수 없다. 관중은 등급 기본 점유율로 어림하고,
 * 승리 수당은 계산 비용(계약 3천 건 합산) 때문에 넣지 않는다.
 *
 * 이걸 빼면 AI 팀은 매치데이 수입 없이 주급만 내는 구조적 적자에 빠진다.
 */
export function applyAiMatchFinance(state: GameState, match: MatchRecord): void {
  for (const side of ["home", "away"] as const) {
    const teamId = side === "home" ? match.homeTeamId : match.awayTeamId;
    if (teamId === state.userTeamId) continue;
    const tier = tierOf(teamId);

    if (side === "home" && !match.neutral) {
      const { capacity } = profileOf(teamId);
      const price =
        (leagueCatalogById(leagueOfTeamIn(state, teamId))?.avgTicketPrice ?? 30) *
        TICKET_TIER_FACTOR[tier] *
        (isEuroCup(match.competitionId) ? 1.15 : 1);
      const gate = capacity * OCCUPANCY_BASE[tier] * price * (1 + HOSPITALITY_RATE[tier]);
      recordFinance(state, teamId, {
        kind: "income",
        category: "matchday",
        label: "홈 입장 수입",
        amount: gate,
      });
      recordFinance(state, teamId, {
        kind: "expense",
        category: "matchday_opex",
        label: "경기 운영비",
        amount: gate * MATCHDAY_OPEX_RATE,
      });
    } else if (side === "away") {
      recordFinance(state, teamId, {
        kind: "expense",
        category: "travel_medical",
        label: "원정 비용",
        amount: isEuroCup(match.competitionId) ? TRAVEL_EUROPE : TRAVEL_DOMESTIC,
      });
    }

    if (isTelevised(match)) {
      recordFinance(state, teamId, {
        kind: "income",
        category: "broadcast_facility",
        label: "생중계 수당",
        amount: BROADCAST_FACILITY_PER_MATCH * poolOf(state, teamId),
      });
    }
  }
}

/** 부상 치료비 — 부상 발생 시점에 (원인 무관) */
export function recordMedicalCost(
  state: GameState,
  playerId: string,
  playerName: string,
  severity: "minor" | "moderate" | "major",
): void {
  recordFinance(state, state.userTeamId, {
    kind: "expense",
    category: "travel_medical",
    label: `치료비 — ${playerName}`,
    amount: MEDICAL_COST[severity],
    ref: { type: "player", id: playerId },
  });
}

// ── 주급 ────────────────────────────────────────────────

/**
 * 이적 시장 전용 구단의 상시 이적 예산 — **우리 경제 밖의 돈**이다.
 *
 * 사우디·MLS 클럽은 경기를 하지 않아 중계권도 매치데이 수입도 없다. 그대로
 * 두면 레전드 주급(주 £3.4M)만 나가 한 시즌 안에 파산한다. 원장을 흉내 내는
 * 대신 예산을 상수로 두고 재정 시뮬에서 빼는 게 정직하다 — 이 클럽들의 재정은
 * 게임의 관심사가 아니고, 감독이 들여다볼 화면도 없다.
 */
export const MARKET_LEAGUE_BUDGET: Record<string, number> = {
  saudi: 250_000_000,
  mls: 60_000_000,
};

/** 이 구단이 우리 재정 세계 밖인가 (사우디·MLS) */
export function isOutsideOurEconomy(teamId: string): boolean {
  return isMarketOnlyLeague(leagueOfTeam(teamId));
}

/** 주간 주급 지급 — 전 팀 (월요일) */
export function payWeeklyWages(state: GameState): void {
  for (const team of state.teams) {
    // 무소속은 구단이 아니다 — 자유계약 선수가 모인 자리라 낼 주급도 받을 수입도 없다
    if (!isClubTeam(team.id) || isOutsideOurEconomy(team.id)) continue;
    const wages = weeklyWagesOf(state, team.id);
    if (wages <= 0) continue;
    recordFinance(state, team.id, {
      kind: "expense",
      category: "player_wages",
      label: "선수단 주급",
      amount: wages,
    });
  }
}

// ── 상각 ────────────────────────────────────────────────

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm);
}

export interface AmortisationLine {
  playerId: string;
  monthly: number;
}

/**
 * **레거시 상각의 자 — 계약 주급.**
 *
 * 시작 스쿼드는 이적 기록 없이 놓이므로 상각의 원본(§6.1)이 비어 있다. 그래서
 * 상각이 £0이 되고 현금 순증과 장부 손익이 소수점까지 같아진다 — §3 결정 A의
 * 2축 회계가 한 축으로 붕괴하고, PSR(§9.2)이 발동할 길도 함께 사라진다.
 *
 * 자를 시장가가 아니라 주급으로 잡는다. 취득원가는 움직이면 안 되는데 시장가는
 * 폼·나이·잔여 계약으로 매달 흔들린다. 계약 주급은 서명 때 정해져 계약 내내
 * 고정이고, 실제로도 상위 구단의 상각 총액과 인건비는 같은 크기로 붙어 다닌다.
 *
 * 0.7은 두 자를 동시에 만족하는 값이다 — 상각이 비용의 3할 안팎(실제 상위 구단과
 * 같은 비중)이 되고, tier1 유저의 연 장부 손익이 §10.1 밴드 안에 든다.
 */
const LEGACY_AMORTISATION_WAGE_RATE = 0.7;
const WEEKS_PER_MONTH = 52 / 12;

/**
 * 게임이 시작한 날 — 시작 스쿼드의 계약이 전부 이 날에 놓인다(`createGame`).
 * 그 뒤에 맺은 계약(영입·재계약)은 전부 이보다 늦으므로 레거시와 갈린다.
 */
function gameStartDate(state: GameState): string {
  let earliest = state.date;
  for (const c of state.contracts) if (c.since < earliest) earliest = c.since;
  return earliest;
}

/** 상각이 남아 있는가 — 계약 기간을 다 채웠으면 끝났다 */
function amortisationMonthsLeft(state: GameState, since: string, until: string): number {
  // 계약 기간의 개월 수 — 시작 달과 만료 달을 모두 센다
  // (2026-07-01 ~ 2030-06-30 = 48개월)
  const months = monthsBetween(since, until) + 1;
  if (months <= 0) return 0;
  return Math.max(0, months - monthsBetween(since, monthOf(state.date)));
}

/**
 * 이번 달 이적료 상각 — 활성 계약 + 이적 원장에서 **파생**한다 (자산 테이블 없음).
 *
 * 두 갈래가 같은 축으로 들어온다:
 *   게임 중 영입 — 이적료 ÷ 계약 개월수 (원본은 이적 원장)
 *   시작 스쿼드 — 주급 × 배수 (원본은 계약 자체)
 * 계약 시작일로 갈리므로 **한 선수가 두 갈래에 동시에 들지 않는다** — 영입한
 * 선수의 계약은 언제나 게임 시작일보다 늦다.
 *
 * 계약이 끝나거나 선수를 팔면 활성 계약이 사라지므로 상각도 자동으로 멈춘다.
 * 매각 시 장부상 잔존가 처리는 v1에서 생략한다 (club-finance §13).
 *
 * 이적 갈래의 순회 기준은 **이적 원장**이다 — 이적은 몇 건뿐이고 계약은 3천 건에
 * 가까우므로(96팀 × 30명) 계약을 훑으면 월초 정산이 팀 수만큼 느려진다.
 */
export function amortisationOf(state: GameState, teamId: string): AmortisationLine[] {
  const lines: AmortisationLine[] = [];
  const bought = new Set<string>();
  for (const transfer of state.transfers) {
    if (transfer.toTeamId !== teamId || transfer.fee <= 0) continue;
    const contract = state.contracts.find(
      (c) =>
        c.gamePlayerId === transfer.gamePlayerId &&
        c.status === "active" &&
        c.teamId === teamId &&
        c.since >= transfer.date,
    );
    if (!contract) continue;
    const months = monthsBetween(contract.since, contract.until) + 1;
    if (months <= 0) continue;
    if (amortisationMonthsLeft(state, contract.since, contract.until) <= 0) continue;
    bought.add(transfer.gamePlayerId);
    lines.push({ playerId: transfer.gamePlayerId, monthly: transfer.fee / months });
  }

  const start = gameStartDate(state);
  for (const contract of state.contracts) {
    if (contract.status !== "active" || contract.teamId !== teamId) continue;
    // 게임 중에 맺은 계약은 이적 원장이 받는다 — 재계약도 새 이적료를 만들지 않는다
    if (contract.since > start || bought.has(contract.gamePlayerId)) continue;
    if (amortisationMonthsLeft(state, contract.since, contract.until) <= 0) continue;
    lines.push({
      playerId: contract.gamePlayerId,
      monthly: contract.weeklyWage * WEEKS_PER_MONTH * LEGACY_AMORTISATION_WAGE_RATE,
    });
  }
  return lines;
}

/**
 * 팀별 최근 성적 — 월초 정산이 96팀 × 전 경기를 훑지 않도록 한 번만 만든다.
 * @returns teamId → 최근 N경기 승률 (경기가 없으면 없음)
 */
function recentWinRates(state: GameState, window: number): Map<string, number> {
  const results = new Map<string, boolean[]>();
  for (const m of state.matches) {
    if (!m.result) continue;
    const push = (teamId: string, won: boolean) => {
      const list = results.get(teamId) ?? [];
      list.push(won);
      if (list.length > window) list.shift();
      results.set(teamId, list);
    };
    push(m.homeTeamId, m.result.homeGoals > m.result.awayGoals);
    push(m.awayTeamId, m.result.awayGoals > m.result.homeGoals);
  }
  const rates = new Map<string, number>();
  for (const [teamId, list] of results) {
    if (list.length > 0) rates.set(teamId, list.filter(Boolean).length / list.length);
  }
  return rates;
}

// ── 월초 정산 + 보고서 ──────────────────────────────────

/**
 * 매월 1일 — ① 지난달 마감(보고서 발행) ② 이번 달 정액 항목 ③ 원장 절단.
 *
 * 순서가 중요하다: 보고서는 **지난달**을 담아야 하므로 이번 달 항목을 붙이기
 * 전에 마감한다.
 */
export function runMonthlyFinance(state: GameState, digest: string[]): void {
  closeMonth(state, digest);
  postMonthlyItems(state);
  pruneLedger(state);
}

/**
 * 이 달의 정액 항목이 아직 안 붙었으면 붙인다 — **게임 시작 달 보정**.
 *
 * 게임은 7월 1일에 시작하지만 그날의 tick은 돌지 않으므로(첫 tick은 7월 2일)
 * 시작 달만 중계권·스폰서·시설비가 없는 반쪽 달이 된다. 첫 tick에서 한 번 채운다.
 */
export function ensureMonthlyPosted(state: GameState): void {
  const month = monthOf(state.date);
  const posted = financeOf(state, state.userTeamId).ledger.some(
    (e) => monthOf(e.date) === month && categoryOf(e) === "facility",
  );
  if (!posted) postMonthlyItems(state);
}

/**
 * 이번 시즌 이 클럽이 받는 파라슈트의 시즌 총액 (없으면 0).
 * 연차가 지나면 0이 되고, 승격했으면 애초에 걸려 있지 않다.
 */
export function parachuteSeasonAmount(state: GameState, teamId: string): number {
  const finance = state.finances.find((f) => f.teamId === teamId);
  const drop = finance?.parachute;
  if (!drop) return 0;
  const year = state.season - drop.startSeason; // 0 = 1년차
  if (year < 0 || year >= drop.years) return 0;
  const rate = PARACHUTE_RATE[year] ?? 0;
  const pool = leagueCatalogById(drop.fromLeagueId)?.broadcastPool ?? 1;
  return BROADCAST_EQUAL_SEASON * pool * rate;
}

/**
 * 강등 클럽에 파라슈트를 세운다 — 시즌 전환에서 부른다.
 * 직전 강등에서 아직 받는 중이었으면(승격 1시즌 만의 재강등) 햇수가 짧아진다.
 */
export function startParachute(state: GameState, teamId: string, fromLeagueId: string): void {
  const finance = state.finances.find((f) => f.teamId === teamId);
  if (!finance) return;
  const stillFalling = parachuteSeasonAmount(state, teamId) > 0;
  finance.parachute = {
    fromLeagueId,
    startSeason: state.season + 1,
    years: stillFalling ? PARACHUTE_YEARS_SHORT : PARACHUTE_RATE.length,
  };
}

/** 승격하면 낙하산은 그 자리에서 끝난다 — 1부 배분과 겹쳐 받을 수 없다 */
export function stopParachute(state: GameState, teamId: string): void {
  const finance = state.finances.find((f) => f.teamId === teamId);
  if (finance) delete finance.parachute;
}

/** 강등 뒤 몇 해가 지났나 — 상업 수입 감소가 이 값을 본다 (없으면 null) */
function relegatedYear(state: GameState, teamId: string): number | null {
  const drop = state.finances.find((f) => f.teamId === teamId)?.parachute;
  if (!drop) return null;
  const year = state.season - drop.startSeason;
  return year >= 0 && year < RELEGATED_COMMERCIAL.length ? year : null;
}

function postMonthlyItems(state: GameState): void {
  // 96팀 × 전 경기 순회를 피한다 (월초 정산은 전 팀에 적용된다)
  const winRates = recentWinRates(state, 6);
  const leagueSizes = new Map<string, number>();
  for (const t of state.teams) {
    const league = leagueOfTeamIn(state, t.id);
    leagueSizes.set(league, (leagueSizes.get(league) ?? 0) + 1);
  }
  const playerNames = new Map(state.players.map((p) => [p.id, p.name] as const));

  for (const team of state.teams) {
    /**
     * **무소속은 구단이 아니다.** 리그 밖의 자리(`isClubTeam`)라 시설도 아카데미도
     * 이자도 없다. 예전엔 여기서 걸러지지 않아 자유계약 선수단이 매달 시설비와
     * 이자를 내며 적자를 쌓았다 — 세 시즌에 −£6M이었다.
     */
    if (!isClubTeam(team.id)) continue;
    // 이적 시장 전용 구단은 원장 대신 상시 예산만 유지한다
    if (isOutsideOurEconomy(team.id)) {
      const finance = state.finances.find((f) => f.teamId === team.id);
      if (finance) {
        finance.transferBudget = MARKET_LEAGUE_BUDGET[leagueOfTeam(team.id)] ?? 50_000_000;
      }
      continue;
    }
    const tier = tierOf(team.id);
    const pool = poolOf(state, team.id);
    const { commercialTier } = profileOf(team.id);

    recordFinance(state, team.id, {
      kind: "income",
      category: "broadcast_equal",
      label: "중계권 균등 배분",
      amount: (BROADCAST_EQUAL_SEASON * equalShareFactor(state, team.id)) / BROADCAST_MONTHS,
    });
    const rank = previousRankOf(state, team.id);
    const size = leagueSizes.get(leagueOfTeamIn(state, team.id)) ?? 20;
    const steps = Math.max(1, size + 1 - rank);
    recordFinance(state, team.id, {
      kind: "income",
      category: "broadcast_merit",
      label: `중계권 성적 수당 (지난 시즌 ${rank}위)`,
      amount: (BROADCAST_MERIT_STEP * steps * pool) / BROADCAST_MONTHS,
    });

    /**
     * 파라슈트 — 강등의 완충. 균등 배분과 **같은 항목**으로 적자 없이 흐르되
     * 라벨로 갈린다(감독이 "이 돈이 언제 끊기나"를 원장에서 읽어야 한다).
     */
    const parachute = parachuteSeasonAmount(state, team.id);
    if (parachute > 0) {
      recordFinance(state, team.id, {
        kind: "income",
        category: "broadcast_equal",
        label: "파라슈트 페이먼트",
        amount: parachute / BROADCAST_MONTHS,
      });
    }

    // 상업 — 대항전 참가·우승 조항 (지난 시즌 성적의 결과) + 강등 후 지연 감소
    const droppedYear = relegatedYear(state, team.id);
    const relegationCut = droppedYear === null ? 0 : (RELEGATED_COMMERCIAL[droppedYear] ?? 0);
    recordFinance(state, team.id, {
      kind: "income",
      category: "commercial",
      label: "스폰서십",
      amount:
        COMMERCIAL_MONTHLY[commercialTier] * (1 + commercialClause(state, team.id) + relegationCut),
    });
    // 머천다이징은 성적에 붙는다 — 최근 승률 ±10%
    const winRate = winRates.get(team.id);
    const form = winRate === undefined ? 0 : Math.max(-0.1, Math.min(0.1, (winRate - 0.4) * 0.25));
    recordFinance(state, team.id, {
      kind: "income",
      category: "merchandising",
      label: "머천다이징",
      amount: MERCHANDISING_MONTHLY[commercialTier] * (1 + form),
    });

    /**
     * 리그전을 굴리지 않는 리그는 홈 경기가 없어 매치데이가 0이다 — 그 몫을
     * 같은 공식으로 되돌린다. 굴리는 리그는 0이라 아무 일도 일어나지 않는다.
     */
    const unplayed = unplayedLeagueMatchdayMonthly(state, team.id);
    if (unplayed > 0) {
      recordFinance(state, team.id, {
        kind: "income",
        category: "matchday",
        label: "리그 홈경기 수입",
        amount: unplayed,
      });
      recordFinance(state, team.id, {
        kind: "expense",
        category: "matchday_opex",
        label: "리그 경기 운영비",
        amount: unplayed * MATCHDAY_OPEX_RATE,
      });
    }

    // 스태프 급여 — 월 선수 급여 대비
    recordFinance(state, team.id, {
      kind: "expense",
      category: "staff_wages",
      label: "코칭·사무 스태프 급여",
      amount: weeklyWagesOf(state, team.id) * (52 / 12) * STAFF_WAGE_RATE[tier],
    });
    recordFinance(state, team.id, {
      kind: "expense",
      category: "facility",
      label: "시설·아카데미 운영",
      amount: facilityCostOf(team.id),
    });
    recordFinance(state, team.id, {
      kind: "expense",
      category: "facility",
      label: "이자·세금",
      amount: financeCostOf(team.id),
    });

    // 이적료 상각 — 장부에만 (noncash)
    for (const line of amortisationOf(state, team.id)) {
      recordFinance(state, team.id, {
        kind: "expense",
        category: "amortisation",
        label: `이적료 상각 — ${playerNames.get(line.playerId) ?? line.playerId}`,
        amount: line.monthly,
        ref: { type: "player", id: line.playerId },
        accounting: "noncash",
      });
    }
  }
}

/**
 * 리그전을 굴리지 않는 리그의 **매치데이 대체 수입** (월할).
 *
 * ⚠️ 2부(컵 전용)는 리그 일정을 만들지 않는다 — 국내 컵을 채우는 배경이라 경기를
 * 시뮬하지 않는 것이 구현 결정이다. 그런데 그 결정이 재정에는 **수입원 하나가
 * 통째로 빠진 것**으로 나타났다: 주급·스태프·시설·이자는 매달 내면서 홈 경기가
 * 없어 매치데이가 0이다. 세 시즌을 굴리면 serieB·리그2의 중간 잔고가 −£16M으로
 * 가라앉았다 — 재정 기준선 테스트가 한 시즌만 봐서 잡히지 않던 자리다.
 *
 * 값은 **새 상수가 아니라 기존 모델에서 파생한다** — 그 리그를 뛰었다면 받았을
 * 홈 경기 수입을 같은 공식(수용인원 × 기본 점유율 × 티켓가 × 호스피탈리티)으로
 * 계산해 열두 달로 나눈다. 임의 금액을 새로 만들면 밸런스의 근거가 사라진다.
 */
const UNPLAYED_HOME_MATCHES = 19;

/**
 * 전형적인 홈 경기 수입 — 매치데이 공식의 기본값(순위·폼·상대 보정과 난수 없이).
 * 경기를 아직 하나도 치르지 않은 날에도 읽히므로 서사 이벤트 한도의 자가 된다.
 */
function typicalHomeGate(state: GameState, teamId: string): number {
  const tier = tierOf(teamId);
  const { capacity } = profileOf(teamId);
  const price =
    (leagueCatalogById(leagueOfTeamIn(state, teamId))?.avgTicketPrice ?? 30) *
    TICKET_TIER_FACTOR[tier];
  return capacity * OCCUPANCY_BASE[tier] * price * (1 + HOSPITALITY_RATE[tier]);
}

function unplayedLeagueMatchdayMonthly(state: GameState, teamId: string): number {
  if (isTopLeague(leagueOfTeamIn(state, teamId))) return 0;
  return (typicalHomeGate(state, teamId) * UNPLAYED_HOME_MATCHES) / BROADCAST_MONTHS;
}

/**
 * 이 구단의 **연 매출 어림** — 성적·관중 편차 없이 공식의 기본값만 더한 값.
 *
 * AI 팀은 원장을 남기지 않으므로(§4.5) 실제 매출을 읽을 방법이 없다. 그런데
 * §10.3의 다년 불변식은 "잔고가 매출을 넘지 않는가"를 리그마다 물어야 하고,
 * §12.3의 부채 한도도 같은 자를 쓴다. 그래서 매출의 눈금을 여기서 한 번 정한다.
 *
 * 상금·대항전·순위 수당의 편차는 넣지 않는다 — 이건 "이 구단이 어느 규모인가"의
 * 자이지 그 시즌 성적표가 아니다.
 */
export function annualRevenueEstimate(state: GameState, teamId: string): number {
  const { commercialTier } = profileOf(teamId);
  const pool = poolOf(state, teamId);
  const broadcast =
    (BROADCAST_EQUAL_SEASON +
      BROADCAST_MERIT_STEP * MERIT_STEPS_TYPICAL +
      BROADCAST_FACILITY_PER_MATCH * TELEVISED_TYPICAL) *
    pool;
  const commercial =
    (COMMERCIAL_MONTHLY[commercialTier] + MERCHANDISING_MONTHLY[commercialTier]) * 12;
  return broadcast + commercial + typicalHomeGate(state, teamId) * UNPLAYED_HOME_MATCHES;
}

/** 스폰서 계약의 성과 조항 — 이번 시즌 대항전 참가와 지난 시즌 우승에서 파생 */
function commercialClause(state: GameState, teamId: string): number {
  let bonus = 0;
  for (const entry of state.euroEntrants) {
    if (!entry.teams.includes(teamId)) continue;
    bonus += entry.cupId === "ucl" ? 0.15 : entry.cupId === "uel" ? 0.06 : 0.03;
  }
  const lastSeason = state.season - 1;
  if (state.trophies.some((t) => t.teamId === teamId && t.season === lastSeason)) bonus += 0.2;
  return bonus;
}

/** 상세 원장 절단 — 최근 N개월만. 그 이전은 보고서가 요약해 갖는다 */
function pruneLedger(state: GameState): void {
  const finance = financeOf(state, state.userTeamId);
  const [year, month] = monthOf(state.date).split("-").map(Number) as [number, number];
  const cutoffMonth = month - (LEDGER_MONTHS_KEPT - 1);
  const cutoff =
    cutoffMonth > 0
      ? `${year}-${String(cutoffMonth).padStart(2, "0")}`
      : `${year - 1}-${String(12 + cutoffMonth).padStart(2, "0")}`;
  finance.ledger = finance.ledger.filter((e) => monthOf(e.date) >= cutoff);
}

function lineOf(entries: LedgerEntry[], category: FinanceCategory): FinanceReportLine | null {
  const mine = entries.filter((e) => categoryOf(e) === category);
  if (mine.length === 0) return null;
  const byLabel = new Map<string, number>();
  for (const e of mine) byLabel.set(e.label, (byLabel.get(e.label) ?? 0) + e.amount);
  return {
    category,
    amount: mine.reduce((s, e) => s + e.amount, 0),
    top: [...byLabel.entries()]
      .map(([label, amount]) => ({ label, amount }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 3),
  };
}

/** 원장 구간을 보고서 형태로 접는다 — 진행 중인 달의 잠정 집계에도 쓴다 */
export function summarise(entries: LedgerEntry[]): {
  income: FinanceReportLine[];
  expense: FinanceReportLine[];
  incomeTotal: number;
  expenseTotal: number;
  cashNet: number;
  pnlNet: number;
  wageRatio: number;
} {
  const income = FINANCE_INCOME_CATEGORIES.map((c) => lineOf(entries, c)).filter(
    (x): x is FinanceReportLine => x !== null,
  );
  const expense = [...FINANCE_EXPENSE_CATEGORIES, "other" as const]
    .map((c) => lineOf(entries, c))
    .filter((x): x is FinanceReportLine => x !== null);

  const incomeTotal = income.reduce((s, l) => s + l.amount, 0);
  const expenseTotal = expense.reduce((s, l) => s + l.amount, 0);
  const amount = (list: FinanceReportLine[], category: FinanceCategory) =>
    list.find((l) => l.category === category)?.amount ?? 0;

  // 현금은 상각을 빼고, 손익은 이적료 지출을 뺀다 (§6.1)
  const cashNet = incomeTotal - (expenseTotal - amount(expense, "amortisation"));
  const pnlNet = incomeTotal - (expenseTotal - amount(expense, "transfer_out"));
  const revenue = incomeTotal - amount(income, "transfer_in");
  const wages = amount(expense, "player_wages") + amount(expense, "staff_wages");

  return {
    income,
    expense,
    incomeTotal,
    expenseTotal,
    cashNet,
    pnlNet,
    wageRatio: revenue > 0 ? wages / revenue : 0,
  };
}

/** 그 달 이후에 일어난 현금 흐름 — 마감 시점의 기말 잔고를 역산하는 데 쓴다 */
function cashFlowAfter(ledger: LedgerEntry[], month: string): number {
  return ledger
    .filter((e) => monthOf(e.date) > month && !isNoncash(e))
    .reduce((s, e) => s + (e.kind === "income" ? e.amount : -e.amount), 0);
}

/** 지난달 마감 — 유저 팀만. 같은 달을 두 번 마감하지 않는다 */
function closeMonth(state: GameState, digest: string[]): void {
  const finance = financeOf(state, state.userTeamId);
  const months = [...new Set(finance.ledger.map((e) => monthOf(e.date)))]
    .filter((m) => m < monthOf(state.date))
    .sort();
  for (const month of months) {
    if (state.financeReports.some((r) => r.month === month && r.teamId === state.userTeamId)) {
      continue;
    }
    const report = buildReport(state, month, finance.ledger);
    state.financeReports.push(report);
    digest.push(
      `📊 ${month.replace("-", "년 ")}월 재정 보고서 — 수입 ${money(report.incomeTotal)} / 지출 ${money(report.expenseTotal)} / 순 ${report.cashNet >= 0 ? "+" : "−"}${money(Math.abs(report.cashNet))}`,
      ...report.notes.map((n) => `   ${n}`),
    );
    pushNarrative(
      state,
      `${month} 재정: 순 ${report.cashNet >= 0 ? "+" : "−"}${money(Math.abs(report.cashNet))}, 급여 비중 ${Math.round(report.wageRatio * 100)}%`,
      2,
    );
  }
}

function buildReport(state: GameState, month: string, ledger: LedgerEntry[]): FinanceReport {
  const entries = ledger.filter((e) => monthOf(e.date) === month);
  const s = summarise(entries);
  const finance = financeOf(state, state.userTeamId);

  // 기말 잔고 = 현재 잔고 − 그 달 이후의 현금 흐름. 마감 순서(주급이 먼저
  // 기록됐는지 등)에 좌우되지 않게 역산한다
  const closingBalance = finance.balance - cashFlowAfter(ledger, month);
  const openingBalance = closingBalance - s.cashNet;

  const season = seasonOfMonth(state, month);
  const sameSeason = state.financeReports.filter((r) => r.season === season);
  const seasonToDate = {
    income: sameSeason.reduce((x, r) => x + r.incomeTotal, 0) + s.incomeTotal,
    expense: sameSeason.reduce((x, r) => x + r.expenseTotal, 0) + s.expenseTotal,
    cashNet: sameSeason.reduce((x, r) => x + r.cashNet, 0) + s.cashNet,
    pnlNet: sameSeason.reduce((x, r) => x + r.pnlNet, 0) + s.pnlNet,
  };

  const rolling = rollingPnl(state, season, s.pnlNet);
  const psr = { rolling3Season: rolling, headroom: PSR_LOSS_LIMIT + rolling };

  const notes: string[] = [];
  if (s.wageRatio >= WAGE_RATIO_DANGER) {
    notes.push(`급여 비중 ${Math.round(s.wageRatio * 100)}% — 위험 구간, 주급 구조를 손볼 때다`);
  } else if (s.wageRatio >= WAGE_RATIO_CAUTION) {
    notes.push(`급여 비중 ${Math.round(s.wageRatio * 100)}% — 주의 구간`);
  }
  const transferOut = s.expense.find((l) => l.category === "transfer_out")?.amount ?? 0;
  if (s.cashNet < 0 && transferOut > 0) {
    notes.push(`이적 지출 ${money(transferOut)}으로 현금이 ${money(Math.abs(s.cashNet))} 줄었다`);
  } else if (s.cashNet < 0) {
    notes.push(`운영만으로 ${money(Math.abs(s.cashNet))} 적자 — 수입 구조를 점검해야 한다`);
  }
  if (psr.headroom < 0) {
    notes.push(`PSR 위반 — 3시즌 누적 ${money(rolling)}, 한도를 ${money(-psr.headroom)} 넘었다`);
  } else if (psr.headroom < PSR_LOSS_LIMIT * 0.25) {
    notes.push(`PSR 여유 ${money(psr.headroom)} — 대형 영입 전에 매각이 필요하다`);
  }

  return {
    id: `fr-${state.userTeamId}-${month}`,
    teamId: state.userTeamId,
    month,
    season,
    openingBalance,
    closingBalance,
    income: s.income,
    expense: s.expense,
    incomeTotal: s.incomeTotal,
    expenseTotal: s.expenseTotal,
    cashNet: s.cashNet,
    pnlNet: s.pnlNet,
    wageRatio: s.wageRatio,
    seasonToDate,
    psr,
    notes,
  };
}

/**
 * 그 달이 속한 시즌 — 시즌은 7월에 시작해 이듬해 6월에 끝난다. 시즌 전환 전후로
 * 보고서가 엉키지 않게 현재 시즌의 프리시즌 연도를 기준으로 역산한다.
 */
function seasonOfMonth(state: GameState, month: string): number {
  const [year, m] = month.split("-").map(Number) as [number, number];
  const startYear = Number(state.calendar.preseasonStart.slice(0, 4));
  return state.season + ((m >= 7 ? year : year - 1) - startYear);
}

/** 3시즌 누적 손익 — 보고서에서 파생 (보유 시즌이 적으면 있는 만큼) */
function rollingPnl(state: GameState, season: number, pending = 0): number {
  const from = season - (PSR_SEASONS - 1);
  return (
    state.financeReports
      .filter((r) => r.season >= from && r.season <= season)
      .reduce((s, r) => s + r.pnlNet, 0) + pending
  );
}

/** 지금까지의 3시즌 누적 손익과 여유 — 시즌 전환·보드 판정용 */
export function psrStatus(state: GameState): { rolling3Season: number; headroom: number } {
  const rolling = rollingPnl(state, state.season);
  return { rolling3Season: rolling, headroom: PSR_LOSS_LIMIT + rolling };
}

// ── 시즌 단위 ───────────────────────────────────────────

/** 우승·유럽 진출 보너스 — 시즌 리뷰에서 (주급 총액 배수) */
export function paySeasonBonuses(state: GameState, position: number, digest: string[]): void {
  const wages = weeklyWagesOf(state, state.userTeamId);
  const bonus = position === 1 ? wages * 4 : position <= 4 ? wages * 2 : position <= 6 ? wages : 0;
  if (bonus <= 0) return;
  const label = position === 1 ? "우승 보너스" : "유럽 진출 보너스";
  if (
    payOnce(state, state.userTeamId, `${label}:S${state.season}`, {
      kind: "expense",
      category: "bonus",
      label: `${label} (S${state.season})`,
      amount: bonus,
    })
  ) {
    digest.push(`선수단 ${label} ${money(bonus)} 지급`);
  }
}

/** 리그 순위 상금 — 시즌 리뷰에서 (전 팀) */
export function payLeaguePrizes(state: GameState, digest: string[]): void {
  for (const team of state.teams) {
    if (isOutsideOurEconomy(team.id)) continue;
    const standings = computeStandings(state, leagueOfTeam(team.id));
    const rank = standings.findIndex((r) => r.teamId === team.id) + 1;
    if (rank <= 0) continue;
    const size = leagueSizeOf(state, team.id);
    const amount = (size + 1 - rank) * 700_000 * poolOf(state, team.id);
    if (
      payOnce(state, team.id, `league-prize:S${state.season}`, {
        kind: "income",
        category: "prize",
        label: `리그 순위 상금 (${rank}위 · S${state.season})`,
        amount,
        ref: { type: "competition", id: leagueOfTeam(team.id) },
      }) &&
      team.id === state.userTeamId
    ) {
      digest.push(`💰 리그 순위 상금 ${money(amount)} 입금 (${rank}위)`);
    }
  }
}

/**
 * 시즌 이적 예산 보충 — 등급별 base에 **재정 성과**를 얹는다.
 * PSR 여유가 없으면 동결한다 (결정 D — 승점은 건드리지 않는다).
 */
export function topUpTransferBudget(
  state: GameState,
  teamId: string,
  base: number,
  digest: string[],
): void {
  const finance = financeOf(state, teamId);
  const isUser = teamId === state.userTeamId;

  if (isUser) {
    const psr = psrStatus(state);
    if (psr.headroom < 0) {
      finance.budgetFrozen = true;
      digest.push(
        `⚠️ 보드가 이적 예산을 동결했다 — 3시즌 누적 ${money(psr.rolling3Season)}로 PSR 한도를 ${money(-psr.headroom)} 넘겼다. 매각 없이는 영입할 수 없다`,
      );
      pushNarrative(state, `PSR 위반으로 이적 예산 동결`, 4);
      return;
    }
    finance.budgetFrozen = false;
  }

  // 성과 보너스 — 지난 시즌 장부 손익의 절반까지 (손실이면 깎인다)
  const lastSeason = state.season - 1;
  const pnl = isUser
    ? state.financeReports.filter((r) => r.season === lastSeason).reduce((s, r) => s + r.pnlNet, 0)
    : 0;
  const performance = Math.max(-base * 0.5, Math.min(base, pnl * 0.5));
  finance.transferBudget += base + performance;

  if (isUser && Math.abs(performance) >= 1_000_000) {
    digest.push(
      performance > 0
        ? `보드가 재정 성과를 반영해 이적 예산을 ${money(performance)} 더 얹었다`
        : `지난 시즌 적자로 이적 예산이 ${money(-performance)} 깎였다`,
    );
  }
}

// ── 서사가 재정에 닿는 통로 (GM 스킬) ───────────────────

/**
 * 서사 이벤트가 열 수 있는 카테고리 — **코어가 공식으로 내는 축은 닫는다.**
 *
 * 중계권·주급·이적료·상각·상금은 계약과 규정에서 계산되는 값이라 서사가 손대면
 * 장부가 두 개의 진실을 갖는다. 열어 두는 것은 세상의 반응으로 흔들리는 축뿐이다 —
 * 스폰서·굿즈·입장 수입, 시설·의료·보너스 지출.
 */
export const NARRATIVE_INCOME_CATEGORIES = ["commercial", "merchandising", "matchday"] as const;
export const NARRATIVE_EXPENSE_CATEGORIES = [
  "facility",
  "travel_medical",
  "bonus",
  "matchday_opex",
] as const;

/**
 * 서사 이벤트의 하루 상한 — **주급 총액의 배수**.
 *
 * 절대 금액으로 잡으면 같은 £10M이 승격팀에겐 재정을 뒤집고 빅클럽에겐 푼돈이
 * 된다. 주급 총액은 구단 규모를 가장 잘 대신하는 값이라(맨시티 £4M/주 vs
 * 승격팀 £1M/주) 이벤트의 무게가 어느 구단에서나 비슷해진다.
 *
 * 카테고리별 건당 상한(`narrativeEventCap`)과 **역할이 다르다.** 건당 상한은 한 사건의
 * 금액이 그 축에 맞는지를 보고, 이 한도는 같은 장면을 여러 번 나눠 불러 하루를 통째로
 * 흔드는 것을 막는다. 둘 다 필요하다 — 하나만으론 다른 쪽이 열린다.
 */
export const NARRATIVE_FINANCE_WAGE_LIMIT = 2;
/** 장부에 남길 서사 재정 이벤트의 최소 단위 — 일상 비용은 게임 재정에서 무시한다. */
export const NARRATIVE_FINANCE_MIN_AMOUNT = 10_000;
/** 어떤 카테고리에서도 넘을 수 없는 절대 상한 — 도구 스키마의 바깥 울타리 */
export const NARRATIVE_FINANCE_MAX_AMOUNT = 10_000_000;
/** 이적 예산 지원·삭감의 하루 상한 (같은 주급 배수 자) — 예산은 매출보다 큰 단위로 움직인다 */
export const BUDGET_ADJUST_WAGE_LIMIT = 10;

// 건당 상한의 배수 — 새 금액이 아니라 같은 축의 기존 상수에서 파생한다
/** 포상·회식 — 주급 총액 대비. `WIN_BONUS_RATE`(승리 수당)의 2.5배 = 큰 경기 하나의 무게 */
const NARRATIVE_BONUS_WAGE_RATE = WIN_BONUS_RATE * 2.5;
/** 원정·의료 — 최중상 치료비 두 명분. 코어의 원정·의료비가 그렇듯 구단 규모를 타지 않는다 */
const NARRATIVE_MEDICAL_FACTOR = 2;
/** 시설 — 월 시설비의 절반 */
const NARRATIVE_FACILITY_FACTOR = 0.5;
/** 매치데이 — 전형적 홈경기 수입의 3할 */
const NARRATIVE_MATCHDAY_FACTOR = 0.3;
/** 상업·머천다이징 — 각자의 월 정액 절반 */
const NARRATIVE_COMMERCIAL_FACTOR = 0.5;

/**
 * 서사 이벤트 **한 건**의 상한 — 그 축이 이 구단에서 실제로 움직이는 폭.
 *
 * 하루 누적 한도만 있을 때 모델의 유일한 앵커는 "£10k 미만은 적지 마라"였고, 그 위는
 * 아스날에서 하루 £5.5M까지 열려 있었다. 그래서 회식 장면에 £100k처럼 그럴듯하게
 * 반올림한 수가 나왔다. 눈금을 가르치는 것은 프롬프트의 설명이 아니라 **거절당한 값**이라
 * 한도를 코드에 두고 거부 메시지에 실어 보낸다 (AGENTS §6.5·§6.7).
 *
 * 어느 표에도 없는 카테고리는 **포상 한도로 떨어진다** — 두 체급 모두에서 가장 좁은
 * 자라, 카테고리가 늘어도 한도 없이 통과하는 일이 없다.
 */
export function narrativeEventCap(state: GameState, category: FinanceCategory): number {
  const teamId = state.userTeamId;
  const bonusCap = weeklyWagesOf(state, teamId) * NARRATIVE_BONUS_WAGE_RATE;
  switch (category) {
    case "travel_medical":
      return MEDICAL_COST.major * NARRATIVE_MEDICAL_FACTOR;
    case "facility":
      return facilityCostOf(teamId) * NARRATIVE_FACILITY_FACTOR;
    case "matchday":
    case "matchday_opex":
      return typicalHomeGate(state, teamId) * NARRATIVE_MATCHDAY_FACTOR;
    case "commercial":
      return COMMERCIAL_MONTHLY[profileOf(teamId).commercialTier] * NARRATIVE_COMMERCIAL_FACTOR;
    case "merchandising":
      return MERCHANDISING_MONTHLY[profileOf(teamId).commercialTier] * NARRATIVE_COMMERCIAL_FACTOR;
    case "bonus":
    default:
      return bonusCap;
  }
}

/** 오늘 서사가 이미 움직인 금액 */
function narrativeSpentToday(state: GameState): number {
  return financeOf(state, state.userTeamId)
    .ledger.filter((e) => e.date === state.date && e.source === "narrative")
    .reduce((sum, e) => sum + e.amount, 0);
}

export interface FinanceEventInput {
  kind: "income" | "expense";
  category: FinanceCategory;
  amount: number;
  note: string;
}

/**
 * 서사에서 벌어진 매출·비용을 장부에 남긴다.
 *
 * 원장에 들어가므로 월간 보고서·급여 비중·PSR에 그대로 전파된다 — 경기가 재밌어서
 * 굿즈가 팔린 것도, 시설 사고로 돈이 나간 것도 3시즌 뒤 PSR 여유에 남는다.
 */
export function applyFinanceEvent(
  state: GameState,
  input: FinanceEventInput,
): { ok: boolean; message: string } {
  const allowed: readonly string[] =
    input.kind === "income" ? NARRATIVE_INCOME_CATEGORIES : NARRATIVE_EXPENSE_CATEGORIES;
  if (!allowed.includes(input.category)) {
    return {
      ok: false,
      message: `${input.kind === "income" ? "수입" : "지출"}으로 쓸 수 없는 항목입니다: ${input.category} (가능: ${allowed.join(", ")})`,
    };
  }

  const amount = Math.max(0, Math.round(input.amount));
  if (amount < NARRATIVE_FINANCE_MIN_AMOUNT) {
    return {
      ok: false,
      message: `£10k 미만의 일상 비용은 재정 장부에서 무시합니다`,
    };
  }

  // 건당 상한 — 거절당한 값이 눈금을 가르치므로 허용 상한을 메시지에 실어 보낸다
  const eventCap = narrativeEventCap(state, input.category);
  if (amount > eventCap) {
    return {
      ok: false,
      message:
        `${FINANCE_CATEGORY_KO[input.category]} 이벤트 한 건은 ${money(eventCap)}까지입니다 — ` +
        `${money(amount)}은 이 구단에서 그 축이 움직이는 폭을 넘습니다`,
    };
  }

  const cap = weeklyWagesOf(state, state.userTeamId) * NARRATIVE_FINANCE_WAGE_LIMIT;
  const spent = narrativeSpentToday(state);
  if (spent + amount > cap) {
    return {
      ok: false,
      message: `하루 한도를 넘습니다 — 오늘 ${money(spent)} 기록됨, 한도 ${money(cap)}`,
    };
  }

  recordFinance(state, state.userTeamId, {
    kind: input.kind,
    category: input.category,
    label: input.note,
    amount,
    source: "narrative",
  });
  pushNarrative(state, `${input.note} (${input.kind === "income" ? "+" : "-"}${money(amount)})`, 3);
  return {
    ok: true,
    message: `${FINANCE_CATEGORY_KO[input.category]} ${input.kind === "income" ? "수입" : "지출"} ${money(amount)} — ${input.note}`,
  };
}

/**
 * 구단주·보드가 이적 예산을 조정한다 — **손익이 아니라 자본이다.**
 *
 * 원장에 넣지 않는 이유가 있다. 구단주 출자는 실제 회계에서도 매출이 아니라
 * 자본 투입이라 PSR 계산에 들어가지 않는다. 원장에 수입으로 적으면 "구단주가
 * 돈을 넣으면 PSR이 풀린다"가 되어 재정 규정이 통째로 무력해진다.
 * PSR로 동결된 예산은 돈이 아니라 규정의 문제이므로 증액으로 풀 수 없다.
 */
export function adjustTransferBudget(
  state: GameState,
  input: { delta: number; note: string },
): { ok: boolean; message: string } {
  const finance = financeOf(state, state.userTeamId);
  const delta = Math.round(input.delta);
  if (delta === 0) return { ok: false, message: "금액이 0입니다" };
  if (delta > 0 && finance.budgetFrozen) {
    return { ok: false, message: "PSR 위반으로 이적 예산이 동결돼 있습니다 — 매각이 먼저입니다" };
  }

  /**
   * **하루 누적**이다. 건당으로 막으면 같은 장면을 여러 번 나눠 불러 얼마든지
   * 넘길 수 있다 — 주석은 "하루 상한"이라 적혀 있었는데 코드는 건당이었다.
   * 이 도구로 **이적료를 흉내 내는 길**을 막는 것이 이 한도의 실제 일이다:
   * 매각 대금은 `accept_deal`이 원장을 거쳐 넣는다.
   */
  const cap = weeklyWagesOf(state, state.userTeamId) * BUDGET_ADJUST_WAGE_LIMIT;
  const movedToday =
    finance.budgetAdjusted?.date === state.date ? finance.budgetAdjusted.amount : 0;
  if (movedToday + Math.abs(delta) > cap) {
    return {
      ok: false,
      message:
        `하루 한도를 넘습니다 — 오늘 ${money(movedToday)} 움직였고 한도는 ${money(cap)}입니다. ` +
        `선수를 팔아 만든 돈은 이 도구가 아니라 매각(accept_deal)이 넣습니다`,
    };
  }

  const before = finance.transferBudget;
  finance.transferBudget = Math.max(0, before + delta);
  const moved = finance.transferBudget - before;
  finance.budgetAdjusted = { date: state.date, amount: movedToday + Math.abs(moved) };
  pushNarrative(state, `${input.note} (이적 예산 ${moved > 0 ? "+" : ""}${money(moved)})`, 3);
  return {
    ok: true,
    message: `이적 예산 ${moved > 0 ? "+" : "-"}${money(Math.abs(moved))} → ${money(finance.transferBudget)} — ${input.note}`,
  };
}

// ── 조회 (GM 도구 · 오피스) ─────────────────────────────

/**
 * 시즌 누계 급여 비중 — 오피스 요약 카드의 헤드라인 지표.
 *
 * 한 달만 보면 프리시즌(매치데이 수입 0)에 100%를 넘어 무의미해진다. 시즌 전체의
 * 급여 ÷ 매출로 봐야 실제 구단 지표(EPL 평균 ~70%)와 같은 뜻이 된다.
 */
export function seasonWageRatio(state: GameState): number {
  const months = [
    ...state.financeReports.filter(
      (r) => r.teamId === state.userTeamId && r.season === state.season,
    ),
    currentMonthSummary(state),
  ];
  let wages = 0;
  let revenue = 0;
  for (const m of months) {
    const at = (list: FinanceReportLine[], category: FinanceCategory) =>
      list.find((l) => l.category === category)?.amount ?? 0;
    wages += at(m.expense, "player_wages") + at(m.expense, "staff_wages");
    revenue += m.incomeTotal - at(m.income, "transfer_in");
  }
  return revenue > 0 ? wages / revenue : 0;
}

/** 이번 달 진행 중 집계 — 아직 마감되지 않은 달 */
export function currentMonthSummary(state: GameState) {
  const finance = financeOf(state, state.userTeamId);
  const month = monthOf(state.date);
  return { month, ...summarise(finance.ledger.filter((e) => monthOf(e.date) === month)) };
}

/**
 * 재정 조회 (GM `get_finance`) — 월간 보고서 또는 이번 달 잠정 집계.
 * 컨텍스트에 상시 넣지 않고 물어볼 때만 읽는다 (llm-io 3층 규약).
 */
export function financeLookup(state: GameState, month?: string): { ok: boolean; message: string } {
  const finance = financeOf(state, state.userTeamId);
  const lines: string[] = [];
  const report = month
    ? state.financeReports.find((r) => r.month === month)
    : [...state.financeReports].reverse()[0];

  lines.push(
    `잔고 ${money(finance.balance)} · 이적 예산 ${money(finance.transferBudget)}${finance.budgetFrozen ? " (동결)" : ""} · 주급 총액 ${money(weeklyWagesOf(state, state.userTeamId))}/주`,
  );

  if (month && !report) {
    lines.push(
      `${month} 보고서가 없습니다 — 발행된 달: ${state.financeReports.map((r) => r.month).join(", ") || "없음"}`,
    );
  }

  if (report) {
    lines.push(
      "",
      `[${report.month} 월간 보고서]`,
      `수입 ${money(report.incomeTotal)} / 지출 ${money(report.expenseTotal)}`,
      `현금 순증 ${money(report.cashNet)} · 장부 손익 ${money(report.pnlNet)} · 급여 비중 ${Math.round(report.wageRatio * 100)}%`,
      ...report.income.map((l) => `  + ${FINANCE_CATEGORY_KO[l.category]} ${money(l.amount)}`),
      ...report.expense.map((l) => `  − ${FINANCE_CATEGORY_KO[l.category]} ${money(l.amount)}`),
    );
    if (report.psr) {
      lines.push(
        `PSR: 3시즌 누적 ${money(report.psr.rolling3Season)} · 여유 ${money(report.psr.headroom)}`,
      );
    }
    if (report.notes.length > 0) lines.push(...report.notes.map((n) => `※ ${n}`));
  }

  if (!month) {
    const now = currentMonthSummary(state);
    lines.push(
      "",
      `[${now.month} 진행 중]`,
      `수입 ${money(now.incomeTotal)} / 지출 ${money(now.expenseTotal)} / 순 ${money(now.cashNet)}`,
    );
  }
  return { ok: true, message: lines.join("\n") };
}
