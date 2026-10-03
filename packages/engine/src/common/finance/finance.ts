import type {
  FinanceCategory,
  FinanceNote,
  FinanceReport,
  FinanceReportLine,
  LedgerEntry,
  MatchRecord,
  TickSink,
} from "@story-fm/domain";
import {
  FINANCE_CATEGORY_KO,
  FINANCE_EXPENSE_CATEGORIES,
  FINANCE_INCOME_CATEGORIES,
  formatMoney,
  isReserveMatch,
  josa,
} from "@story-fm/domain";
import { buildSeasonCalendar } from "../core/calendar";
import { addDays, dayOfWeek, DEFAULT_KICKOFF, SATURDAY } from "../core/dates";
import { clubProfile } from "../data/club-profile";
import { derbyForMatch } from "../world/derby";
import { clubEconomyLevel, leagueEconomyLevel, leagueTicketSpread } from "../data/league-economy";
import { isMarketOnlyLeague, isTopLeague, leagueCatalogById } from "../data/league-catalog";
import { competitionShortName, isCup, isEuroCup } from "../data/cup-catalog";
import { isFriendly } from "../core/match-kinds";
import { isClubTeam, leagueOfTeam } from "../data/team-catalog";
import { clubEconomyLevelIn, leagueOfTeamIn, leagueSizeIn } from "../core/league-membership";
import { computeStandings } from "../views/standings";
import {
  catalogLeagueIn,
  clubProfileIn,
  financeOf,
  managedTeamId,
  teamShortNameIn,
  weeklyWageLinesOf,
  weeklyWagesOf,
  type GameState,
  type CommandBrief,
} from "../core/state";
import { item } from "../commands/brief";
import { makeRng } from "../core/rng";
import { catalogTierOf, tierOfTeamIn } from "../core/club-tier";

/**
 * 구단 재정 — 실제 구단의 매출·비용 구조 (docs/common/finance.md).
 *
 * 이 파일이 **재정 상수와 공식의 유일한 자리**다. tick·경기는 여기 함수만
 * 부른다. 모든 계산은 결정적이며(난수는 시드 해시뿐) LLM은 개입하지 않는다 —
 * 재정은 장부이므로 코어의 몫이다 (AGENTS §4).
 *
 * 두 축을 구분한다:
 *   현금(cash)   — 통장. 구장 투자가 즉시 빠진다.
 *   손익(pnl)    — 장부. 투자 대신 내용연수로 나눈 자산 상각이 잡힌다.
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
 * 실제 EPL은 강등 뒤 3년간 순수 중계 몫의 55/45/20%를 준다. 우리 균등 배분
 * (£110M)은 중앙 상업 몫까지 흡수한 값이라 같은 금액이 되도록 비율을 조금 낮춰
 * 잡는다. **연차는 언제나 이 배열의 길이다** — 실제 EPL의 "승격 1시즌 만에 다시
 * 내려가면 2년" 조항은 승격이 낙하산 기록을 지우는 우리 세계에서 성립하지 않는다
 * (`stopParachute` — 그 상태가 남지 않는다).
 *
 * 이게 없으면 강등이 곧 파산이다 — 실제로 챔피언십의 재정 기준선을 올려
 * 놓는 것이 이 돈이고, 강등 팀의 40%가 한 시즌 만에 돌아오는 이유이기도 하다.
 */
const PARACHUTE_RATE: readonly number[] = [0.45, 0.36, 0.16];

/**
 * 강등이 상업 수입에 오는 데는 시간이 걸린다 — 스폰서 계약은 그날 끝나지 않는다.
 * 실측(리즈 −10% · 레스터 −26%)이 그 폭이고, **파라슈트가 끝나는 3년차와 겹쳐**
 * 이중 절벽이 된다.
 */
const RELEGATED_COMMERCIAL: readonly number[] = [-0.1, -0.25, -0.35];

/**
 * 상업(스폰서십) 월 정액 — 브랜드 규모별.
 *
 * ⚠️ **구단을 가르는 힘이 이 축에 실린다.** 등급 폭이 실제 격차(15배)를 담지 못하면
 * 구단을 가르는 축이 브랜드가 아니라 구장 크기로 넘어간다.
 *
 * 값은 **실측 × 0.67**이다. 우리 세계는 의도적으로 실제의 6~7할 규모이고(§10.1)
 * 중계권이 이미 0.66에 맞춰져 있다 — 상업만 0.32였던 것이 어긋난 자리였다.
 * 브랜드 1 £220M · 2 £82M · 3 £36M · 4 £15M을 그 배율로 옮겨 적는다.
 */
const COMMERCIAL_MONTHLY: Record<1 | 2 | 3 | 4, number> = {
  1: 9_050_000,
  2: 3_440_000,
  3: 1_500_000,
  4: 630_000,
};
/** 머천다이징 월 정액 — 브랜드 규모별. 실제 회계의 상업:굿즈는 대략 3:1이다 */
const MERCHANDISING_MONTHLY: Record<1 | 2 | 3 | 4, number> = {
  1: 3_030_000,
  2: 1_150_000,
  3: 500_000,
  4: 210_000,
};
/**
 * 머천다이징에 붙는 성적 보정 — 최근 승률이 `PAR` 에서 벗어난 만큼 `SLOPE` 로
 * 기울고 ±`SWING` 에서 멈춘다. 승률을 보는 창은 `MERCH_FORM_MATCHES`.
 */
const MERCH_FORM_MATCHES = 6;
const MERCH_PAR_WIN_RATE = 0.4;
const MERCH_FORM_SLOPE = 0.25;
const MERCH_FORM_SWING = 0.1;
/**
 * 더비 한 경기가 그 창에서 갖는 **무게** — `1 + 이 값 × heat`(heat 3이면 2.5경기).
 * 실제로 유니폼이 팔리는 것은 라이벌을 이긴 주간이고, 진 주간에는 반대다. 창의
 * 길이는 그대로라 더비가 다른 결과를 밀어내지는 않는다 — 무게만 바뀐다.
 */
const MERCH_DERBY_WEIGHT = 0.5;

/**
 * 스폰서 계약의 성과 조항 — 상업 정액에 더해지는 비율 (`commercialClause`).
 * 대항전은 참가만으로 걸리고(무대의 값이다), 우승은 지난 시즌의 것이 한 해 간다.
 */
const COMMERCIAL_UCL_CLAUSE = 0.15;
const COMMERCIAL_UEL_CLAUSE = 0.06;
const COMMERCIAL_UECL_CLAUSE = 0.03;
const COMMERCIAL_TROPHY_CLAUSE = 0.2;

/** 리그 팀 수를 세지 못했을 때의 자 — 성적 수당의 계단 수가 여기서 나온다 */
const DEFAULT_LEAGUE_SIZE = 20;

/** 매치데이 — 기본 점유율(전력 등급별)과 호스피탈리티 가산율 */
const OCCUPANCY_BASE: Record<1 | 2 | 3 | 4, number> = { 1: 0.97, 2: 0.9, 3: 0.85, 4: 0.8 };
const HOSPITALITY_RATE: Record<1 | 2 | 3 | 4, number> = { 1: 0.35, 2: 0.28, 3: 0.2, 4: 0.15 };
/**
 * 티켓 단가 보정 — 리그 평균가에 곱한다. **이 표는 EPL에서 잰 폭이다** — 리그마다
 * 얼마나 벌어지는가는 `leagueTicketSpread`가 1을 축으로 늘이고 줄인다 (§5.2).
 */
const TICKET_TIER_FACTOR: Record<1 | 2 | 3 | 4, number> = { 1: 1.3, 2: 1.1, 3: 0.95, 4: 0.8 };
/** 리그 카탈로그에 평균 티켓가가 없을 때의 자 (£) */
const DEFAULT_TICKET_PRICE = 30;
/** 대항전 홈경기 단가 — 리그 경기보다 이만큼 비싸게 판다 */
const EURO_TICKET_FACTOR = 1.15;

/**
 * **감독이 부를 수 있는 폭** — 기준가 대비 배율 (finance.md §5.2).
 *
 * 폭 밖의 값은 반려하지 않고 잘라서 받는다 — 감독이 부른 값이 틀린 것이 아니라
 * 구단이 낼 수 있는 값이 여기까지인 것이고, 실제로 선 값은 사실 카드가 적는다.
 */
const TICKET_RATIO_MIN = 0.7;
const TICKET_RATIO_MAX = 1.5;

/**
 * **관중 탄력** — 배율이 1에서 벗어난 만큼 관중이 이만큼 반대로 움직인다.
 *
 * 수입은 `배율 × 탄력 계수`에 비례하고 그 곱이 최대가 되는 지점은
 * `(1 + 탄력) ÷ (2 × 탄력)` = **배율 1.06**이다. 즉 `avgTicketPrice`는 이미 시장이
 * 찾아 놓은 값이고, 그 위에서 더 벌 수 있는 것은 **수요가 상한에 잘리고 있던 구단**
 * 뿐이다 (`matchdayRevenue`의 clamp 순서). 0.5쯤으로 낮추면 최적점이 폭 끝으로 밀려
 * "언제나 최대로 올린다"가 되고, 그러면 결정이 아니라 공짜 수입이 된다.
 */
const TICKET_ELASTICITY = 0.9;

// 점유율을 움직이는 것들 — 기본 점유율(`OCCUPANCY_BASE`) 위에 더해지고, 전부 더한
// 뒤 `OCCUPANCY_FLOOR`~1로 잘린다 (finance.md §5.2).

/** 순위 보정 — 이 순위가 0점이고, 한 계단마다 `RANK_SWING / RANK_SPAN`씩 움직인다 */
const OCCUPANCY_RANK_PIVOT = 11;
const OCCUPANCY_RANK_SPAN = 10;
const OCCUPANCY_RANK_SWING = 0.04;
/** 최근 폼 — 이만큼의 대회 경기를 보고, 이 승률이 0점이다 */
const OCCUPANCY_FORM_MATCHES = 5;
const OCCUPANCY_PAR_WIN_RATE = 0.4;
const OCCUPANCY_FORM_SWING = 0.05;
/** 상대 매력도 — 큰 구단이 오면 표가 더 팔린다 (3등급은 0) */
const OCCUPANCY_BY_OPPONENT_TIER: Record<1 | 2 | 3 | 4, number> = {
  1: 0.04,
  2: 0.02,
  3: 0,
  4: -0.02,
};
/**
 * 더비 가산 — `heat` 한 계단마다 (team.md §3.2). **상대 매력도와 따로 선다**:
 * 상대의 체급만 보면 리버풀-에버턴이 리버풀-본머스와 같은 자인데, 실제로 매진되는
 * 것은 앞의 경기다. tier1(base 0.97)은 어느 heat에서도 만석에 붙으므로 이 항이
 * 실제로 보이는 곳은 중·하위 구단의 더비다.
 */
const OCCUPANCY_DERBY_BONUS = 0.03;
/** 컵 경기 가산 */
const OCCUPANCY_CUP_BONUS = 0.02;
/** 평일(월~목) 저녁 킥오프가 깎는 몫 */
const OCCUPANCY_WEEKNIGHT_PENALTY = 0.03;
/** 결정적 미세 변동의 폭 — 시드 해시로 ±절반이 흔들린다 */
const OCCUPANCY_JITTER = 0.04;
/** 아무리 못해도 이 아래로는 내려가지 않는다 (친선 배율은 이 clamp **뒤에** 곱한다) */
const OCCUPANCY_FLOOR = 0.45;
/** 경기 운영비 — 매치데이 수입 대비 */
const MATCHDAY_OPEX_RATE = 0.12;
/**
 * 프리시즌 친선의 매치데이 — **관중과 단가 양쪽**에 붙어 게이트가 리그의 약 36%가
 * 된다. 실제 프리시즌도 관중이 덜 들고 표가 싸다 (finance.md §5.2).
 *
 * 관중 배율은 점유율 하한(0.45) **clamp를 적용한 뒤에** 곱한다 — 친선을 만석
 * 판정에 넣으면 하한이 친선의 바닥을 리그와 같은 자리에 놔 버린다.
 */
const FRIENDLY_ATTENDANCE_FACTOR = 0.6;
const FRIENDLY_TICKET_FACTOR = 0.6;

/** 주급을 월액으로 옮기는 자 — 한 해 52주를 열두 달로 고르게 편다 */
const WEEKS_PER_MONTH = 52 / 12;
/**
 * 스태프 급여 — 월 선수 급여 대비 (하위 팀일수록 상대 비중이 크다).
 *
 * **명명 스태프의 연봉은 이 안에서 이름을 얻는다** — 비율을 손대지 않고 파생 줄에서
 * 명명된 만큼을 뺀다 (`staffWageBaseOf` · §6.3). 임금 천장(`affordableWageBill`)이
 * 읽는 것은 실제 합계가 아니라 **구단 규모의 자**인 이 비율 그대로다: 스태프를 몇 명
 * 자르면 선수 주급 천장이 오르는 세계는 감독이 읽을 수 없다.
 */
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
/** 이자·세금 월 정액 — 기존 부채의 뭉갠 값. 새로 지는 빚의 이자는 여기 얹힌다(§9.2) */
const FINANCE_COST_MONTHLY: Record<1 | 2 | 3 | 4, number> = {
  1: 1_500_000,
  2: 1_100_000,
  3: 700_000,
  4: 400_000,
};
/** 리그 카탈로그에 중계권 배율이 없을 때의 자 — EPL 대비 몫이다 */
const DEFAULT_BROADCAST_POOL = 0.3;
/** 원정 비용 — 국내/유럽 */
const TRAVEL_DOMESTIC = 120_000;
const TRAVEL_EUROPE = 400_000;
/** 부상 치료비 — 심각도별 */
const MEDICAL_COST: Record<"minor" | "moderate" | "major", number> = {
  minor: 30_000,
  moderate: 120_000,
  major: 400_000,
};

/** 상세 원장 보존 개월 수 — 그 이전은 월간 보고서가 요약해 보관한다 */
const LEDGER_MONTHS_KEPT = 3;

/**
 * 달력 일지에 서는 돈의 문턱 — **£1M 또는 잔고의 1%, 둘 중 낮은 쪽**.
 *
 * 낮은 쪽을 쓰므로 규모가 작은 구단은 자기 눈금으로 본다(잔고 £20M이면 £200k부터).
 * 하한이 있는 이유는 빚진 구단이다 — 잔고가 0 이하면 1%도 0 이하가 되어 모든
 * 항목이 통과한다.
 */
const JOURNAL_MONEY_ABSOLUTE = 1_000_000;
const JOURNAL_MONEY_BALANCE_RATE = 0.01;
const JOURNAL_MONEY_FLOOR = 100_000;

/**
 * 일지에 설 수 있는 카테고리 — **비정기 항목만** (docs/common/finance.md).
 *
 * 중계권·스폰서십·주급·시설·상각은 매달, 매치데이·수당·생중계는 매경기 같은
 * 자리에 선다. 아스날의 월 중계권은 £9M이라 언제나 문턱 위인데, 그 줄이 매달 서면
 * 일지가 글자 벽이 되어 그날 실제로 벌어진 일을 덮는다.
 */
const JOURNAL_MONEY_CATEGORIES: readonly FinanceCategory[] = ["prize"];

/** 이 잔고에서 일지에 설 수 있는 최소 금액 */
function journalMoneyThreshold(balance: number): number {
  return Math.max(
    JOURNAL_MONEY_FLOOR,
    Math.min(JOURNAL_MONEY_ABSOLUTE, balance * JOURNAL_MONEY_BALANCE_RATE),
  );
}

/**
 * 이 원장 한 줄이 달력 일지에 서는가 — 비정기 항목이면서 문턱을 넘을 때만.
 * 서사가 만든 항목(`apply_finance_event`)은 정의상 일회성이라 카테고리를 묻지 않는다.
 */
export function isJournalMoney(entry: LedgerEntry, balance: number): boolean {
  const oneOff = entry.source === "narrative" || JOURNAL_MONEY_CATEGORIES.includes(entry.category);
  return oneOff && entry.amount >= journalMoneyThreshold(balance);
}

/**
 * **부채 = 음수 잔고.** 별도 테이블도 상환 일정도 두지 않는다 — 통장이 마이너스면
 * 그만큼 빌린 것이고, 흑자가 나면 저절로 갚아진다. 세이브에 새 필드가 없다.
 *
 * 연 8%는 실제 구단의 차입 금리대(6~8%)의 상단이다. 상단을 쓰는 이유는 여기서
 * 빌리는 구단이 이미 곤란한 구단이기 때문이고, **무이자면 음수 잔고가 공짜**여서
 * 재정이 게임에 물리지 않는다. 금액이 아니라 비율이라 구단 규모를 저절로 탄다.
 */
export const DEBT_INTEREST_ANNUAL = 0.08;

/** 급여 비중 경고선 — 게임 기준 (실제 EPL 평균은 70% 근처) */
const WAGE_RATIO_CAUTION = 0.65;
const WAGE_RATIO_DANGER = 0.75;

/** 급여 비중이 선 자리 — 월간 보고서의 경고 문구와 화면의 색이 **같은 경계**를 쓴다 */
export type WageRatioTone = "ok" | "caution" | "danger";

/**
 * 그 비중이 어느 구간인가. 화면이 색을 고르는 근거이자 보고서가 문구를 고르는 근거다 —
 * 경계를 화면에 복사해 두면 여기를 손볼 때 색만 옛 자리에 남는다.
 */
export function wageRatioTone(ratio: number): WageRatioTone {
  if (ratio >= WAGE_RATIO_DANGER) return "danger";
  if (ratio >= WAGE_RATIO_CAUTION) return "caution";
  return "ok";
}

// ── 기본 유틸 ───────────────────────────────────────────

/**
 * 이 파일의 체급 통로 — **`state`가 두 문맥을 가른다.**
 *
 * 재정 공식은 대부분 세이브 위에서 돈다(`state`가 있다). 그런데 주급 기준선은
 * 세계 생성 시점, 즉 세이브가 서기 **전에** 한 번 계산된다(`world/wages.ts` →
 * `affordableWageBill`). 그래서 `state`를 마지막 optional 인자로 받아 있으면
 * 세이브의 체급을, 없으면 카탈로그 체급을 읽는다 — 세이브가 있는데도 카탈로그를
 * 읽으면 어드민의 체급 편집이 진행 중인 세이브의 살림에 샌다 (team.md §2).
 */
function tierOf(state: GameState | undefined, teamId: string): 1 | 2 | 3 | 4 {
  return state ? tierOfTeamIn(state, teamId) : catalogTierOf(teamId);
}

/**
 * 이 파일의 구장·브랜드 통로 — `tierOf`와 같은 이유로 `state`가 두 문맥을 가른다.
 * 세이브가 있으면 세이브가 든 프로필을 읽는다 — 카탈로그를 읽으면 어드민의 수용인원·
 * 브랜드 편집이 진행 중인 세이브의 매치데이·상업 수입을 그 자리에서 바꾼다 (team.md §3).
 */
function profileOf(state: GameState | undefined, teamId: string) {
  return state ? clubProfileIn(state, teamId) : clubProfile(teamId, tierOf(state, teamId));
}

function poolOf(state: GameState, teamId: string): number {
  return leagueCatalogById(leagueOfTeamIn(state, teamId))?.broadcastPool ?? DEFAULT_BROADCAST_POOL;
}

/** 브랜드가 중계 몫을 끌어올리는 배수 — 경제 수준 ÷ 리그 수준 (브랜드 보정만 남긴다) */
function brandPoolLift(state: GameState | undefined, teamId: string): number {
  // 승강이 아니라 **원 소속**이다 — 분자와 분모가 같은 리그여야 브랜드 보정만 남는다
  const league = catalogLeagueIn(state, teamId);
  const level = leagueEconomyLevel(league);
  const { commercialTier } = profileOf(state, teamId);
  return level > 0
    ? clubEconomyLevel(teamId, tierOf(state, teamId), league, commercialTier) / level
    : 1;
}

/**
 * 이 파일의 경제 수준 통로 — `tierOf`와 같은 이유로 `state`가 두 문맥을 가른다.
 * 세이브가 있으면 승강을 반영한 소속·체급을 읽는다: 강등한 구단이 2부 수입을
 * 받으면서 1부 고정비를 내던 자리다 (finance.md §6.2).
 */
function economyOf(state: GameState | undefined, teamId: string): number {
  return state
    ? clubEconomyLevelIn(state, teamId)
    : clubEconomyLevel(teamId, tierOf(state, teamId));
}

/** 시설·아카데미 월 고정비 — tier 정액에 구단 경제 수준을 곱한다 */
function facilityCostOf(state: GameState | undefined, teamId: string): number {
  return FACILITY_MONTHLY[tierOf(state, teamId)] * economyOf(state, teamId);
}

/** 이자·세금 월 고정비 — 같은 자 */
function financeCostOf(state: GameState | undefined, teamId: string): number {
  return FINANCE_COST_MONTHLY[tierOf(state, teamId)] * economyOf(state, teamId);
}

/**
 * 경기 성적과 무관하게 매달 나가는 돈 (시설·아카데미 + 이자·세금).
 * 이게 인건비를 넘으면 그 리그는 구조적으로 가라앉는다 — §10.2가 세리에B에서 본 결함.
 *
 * `state`는 세이브 문맥에서만 넘어온다 (`tierOf` 주석).
 */
export function monthlyFixedCostOf(teamId: string, state?: GameState): number {
  return facilityCostOf(state, teamId) + financeCostOf(state, teamId);
}

/**
 * 균등 배분에도 **리그 배율을 적용한다** (finance.md §5.1) — 실제로 각국 중계권
 * 규모는 리그마다 크게 다르다 (리그1은 EPL의 0.16).
 *
 * ⚠️ 주급 곡선도 리그를 알아야 성립한다 (wages.ts) — 수입만 리그를 알면 약체 리그
 * 구단이 EPL 수준 주급을 내면서 6분의 1 수입을 받는다.
 */
function equalShareFactor(state: GameState, teamId: string): number {
  return poolOf(state, teamId);
}

/**
 * 금액 표기 — 규칙은 도메인이 갖는다(화면도 같은 자를 부른다). 재정만이 아니라
 * 상금·조회 응답이 전부 여기를 거친다.
 */
export { formatMoney };
const money = formatMoney;

export function monthOf(date: string): string {
  return date.slice(0, 7);
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
  /** 자산 상각·매각 손익은 noncash */
  accounting?: "cash" | "noncash";
  time?: string;
  /** 서사가 만든 항목인가 (apply_finance_event) */
  source?: "narrative";
}

/**
 * 재정 변화 기록 — **모든 금액 이동의 유일한 입구**.
 *
 * 잔고는 언제나 갱신하지만 **상세 엔트리는 유저 팀만** 남긴다. AI 팀 재정은
 * 잔고만 읽히므로 96팀 분량의 원장을 쌓을 이유가 없다 (finance.md §4.5).
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
  if (input.amount <= 0 || f.prizesPaid.includes(key)) return false;
  f.prizesPaid.push(key);
  recordFinance(state, teamId, input);
  return true;
}

// ── 중계권 ──────────────────────────────────────────────

/**
 * 지난 시즌 순위를 알 수 없을 때 성적 수당이 쓰는 자 — 등급이 곧 순위 어림이다.
 * AI 팀엔 시즌 기록이 없고, 유저 팀도 승강한 시즌엔 앞 리그의 순위를 쓸 수 없다.
 */
const ASSUMED_RANK_BY_TIER: Record<1 | 2 | 3 | 4, number> = { 1: 3, 2: 7, 3: 12, 4: 17 };

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
  return ASSUMED_RANK_BY_TIER[tierOf(state, teamId)];
}

/** 리그 팀 수 — 성적 수당의 계단 수 (18팀 리그는 계단이 짧다) */
function leagueSizeOf(state: GameState, teamId: string): number {
  return Math.max(2, leagueSizeIn(state, teamId));
}

/**
 * 이 경기가 **리그 중계권 수당**의 대상인가 — 토요일 15:00만 비중계 (실제 블랙아웃 규약).
 *
 * 컵은 전부 제외한다. 대항전 방송 수입은 UEFA 배분(참가비·승무 수당)에, 국내 컵은
 * 라운드 진출 상금에 이미 들어 있어서 여기서 또 주면 이중 계상이다.
 */
export function isTelevised(match: MatchRecord): boolean {
  // 친선은 리그 중계 계약 밖의 경기다 — 어느 대회에도 속하지 않으니 배분도 없다
  if (isFriendly(match)) return false;
  if (isCup(match.competitionId)) return false;
  const time = match.time;
  return !(dayOfWeek(match.date) === SATURDAY && time === DEFAULT_KICKOFF);
}

// ── 매치데이 ────────────────────────────────────────────

/**
 * 이 구단의 **기준 티켓 단가** (£) — 리그 평균가에 리그 폭이 걸린 tier 보정.
 *
 * 감독의 배율은 여기 들어가지 않는다: 기준가는 "이 구단의 표가 얼마짜리인가"의 자라
 * 임금 천장(§6.4)과 서사 이벤트 한도가 같이 읽는데, 이번 시즌의 결정이 섞이면 값을
 * 내린 감독의 급여 여력이 그 자리에서 함께 줄어든다.
 */
function ticketBasePriceOf(
  state: GameState | undefined,
  teamId: string,
  leagueId: string | null,
): number {
  const factor = 1 + (TICKET_TIER_FACTOR[tierOf(state, teamId)] - 1) * leagueTicketSpread(leagueId);
  return (leagueCatalogById(leagueId)?.avgTicketPrice ?? DEFAULT_TICKET_PRICE) * factor;
}

/** 감독이 세워 둔 배율 — 없거나 AI 구단이면 1(기준가)이다 */
function ticketRatioOf(state: GameState, teamId: string): number {
  if (teamId !== state.userTeamId) return 1;
  const set = financeOf(state, teamId).ticketPrice;
  if (!set) return 1;
  return Math.min(TICKET_RATIO_MAX, Math.max(TICKET_RATIO_MIN, set.ratio));
}

export interface TicketPrice {
  /** 리그 평균가 × 리그 폭이 걸린 tier 보정 — 감독의 배율을 타지 않는다 */
  base: number;
  /** 감독이 세워 둔 배율 (기본 1) */
  ratio: number;
  /** 지금 팔고 있는 값 */
  price: number;
  /** 부를 수 있는 폭 */
  min: number;
  max: number;
}

/**
 * 이 구단의 티켓 값 한 덩이 — 사실 카드·조회·테스트가 같은 자를 읽는다.
 * 리그 경기의 값이다: 대항전·친선 보정은 그 경기가 안다 (`matchdayRevenue`).
 */
export function ticketPriceOf(state: GameState, teamId: string): TicketPrice {
  const base = ticketBasePriceOf(state, teamId, leagueOfTeamIn(state, teamId));
  const ratio = ticketRatioOf(state, teamId);
  return {
    base,
    ratio,
    price: base * ratio,
    min: base * TICKET_RATIO_MIN,
    max: base * TICKET_RATIO_MAX,
  };
}

/** 값을 올린 만큼 관중이 줄어드는 몫 — 기준가면 1이고 0 아래로는 가지 않는다 */
function ticketDemandFactor(ratio: number): number {
  return Math.max(0, 1 - (ratio - 1) * TICKET_ELASTICITY);
}

/**
 * 감독의 가격 결정이 **매치데이 수입에 남기는 몫** — `배율 × 탄력 계수`.
 *
 * 관중 상한(만석)을 모르는 자리에서 쓴다. 실제 경기의 매치데이는 상한이 걸리므로
 * 이 곱이 아니라 `matchdayRevenue`가 관중과 단가를 따로 계산한다.
 */
function ticketRevenueFactor(state: GameState, teamId: string): number {
  const ratio = ticketRatioOf(state, teamId);
  return ratio * ticketDemandFactor(ratio);
}

/** 티켓 단가는 £ 단위 그대로 읽는다 — `formatMoney`는 £45를 `£0k`로 적는다 */
function ticketText(price: number): string {
  return `£${Math.round(price)}`;
}

export interface SetTicketPriceInput {
  /** 감독이 부른 값 (£) */
  price: number;
}

/**
 * `set_ticket_price` — 감독이 홈 경기 티켓 값을 매긴다 (finance.md §5.2).
 *
 * 부른 값을 **기준가 대비 배율로 접어** 든다: 승강으로 기준가가 바뀌어도 "우리는 조금
 * 비싸게 판다"는 선택이 그대로 남는다. 폭 밖의 값은 반려하지 않고 잘라서 받고, 실제로
 * 선 값은 사실 카드가 적는다 — 보드의 답과 달리 이건 감독의 권한이라 거절할 자가 없다.
 */
export function setTicketPrice(
  state: GameState,
  input: SetTicketPriceInput,
): { ok: boolean; message: string; brief?: CommandBrief } {
  if (managedTeamId(state) === null) {
    return { ok: false, message: "무직입니다 — 값을 매길 구단이 없습니다" };
  }
  const teamId = state.userTeamId;
  const finance = financeOf(state, teamId);
  const { base, ratio: before } = ticketPriceOf(state, teamId);
  if (base <= 0) {
    return { ok: false, message: "이 리그에는 기준 티켓가가 없습니다" };
  }
  const asked = Math.round(input.price);
  if (asked <= 0) return { ok: false, message: "티켓 가격이 0입니다" };

  const ratio = Math.min(TICKET_RATIO_MAX, Math.max(TICKET_RATIO_MIN, asked / base));
  finance.ticketPrice = { ratio, setOn: state.date };

  const price = base * ratio;
  const capped = Math.abs(price - asked) >= 1;
  const swing = Math.round((ratio - 1) * 100);
  const crowd = Math.round((ticketDemandFactor(ratio) - 1) * 100);
  const line =
    `티켓 값 ${ticketText(base * before)} → ${ticketText(price)} ` +
    `(기준가 ${ticketText(base)} 대비 ${swing >= 0 ? "+" : ""}${swing}%)`;
  return {
    ok: true,
    message:
      line +
      (capped
        ? ` — 부른 값 ${josa(ticketText(asked), "은/는")} 이 구단이 부를 수 있는 폭 밖입니다`
        : "") +
      `. 관중은 기준 대비 ${crowd >= 0 ? "+" : ""}${crowd}%로 움직입니다`,
    brief: {
      head: "티켓 가격",
      items: [
        item({ label: "단가", text: ticketText(price), delta: price - base * before }),
        item({ label: "기준가", text: ticketText(base) }),
        item({ label: "관중", text: `${crowd >= 0 ? "+" : ""}${crowd}%`, delta: crowd }),
      ],
    },
  };
}

/**
 * 티켓 한 줄 — `get_finance`가 싣는다. **기준가와 나란히 적는다**: 모델이 다음 값을
 * 부르려면 지금 값이 어디에 서 있는지를 알아야 한다.
 */
export function ticketPriceLine(state: GameState): string {
  const teamId = state.userTeamId;
  const { base, ratio, price, min, max } = ticketPriceOf(state, teamId);
  const swing = Math.round((ratio - 1) * 100);
  return (
    `티켓 단가 ${ticketText(price)} (기준가 ${ticketText(base)}${swing === 0 ? "" : ` · ${swing > 0 ? "+" : ""}${swing}%`}) · ` +
    `부를 수 있는 폭 ${ticketText(min)}~${ticketText(max)}`
  );
}

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
  const tier = tierOf(state, teamId);
  const { capacity } = profileOf(state, teamId);
  const opponentId = match.homeTeamId === teamId ? match.awayTeamId : match.homeTeamId;

  let occupancy = OCCUPANCY_BASE[tier];

  // 순위 — 상위권일수록 표가 팔린다 (순위표가 아직 없으면 보정 없음)
  const standings = computeStandings(state, leagueOfTeamIn(state, teamId));
  const rank = standings.findIndex((r) => r.teamId === teamId) + 1;
  if (rank > 0) {
    occupancy += ((OCCUPANCY_RANK_PIVOT - rank) / OCCUPANCY_RANK_SPAN) * OCCUPANCY_RANK_SWING;
  }

  // 최근 5경기 폼 — **대회 경기만.** 친선의 승패가 표를 팔면 프리시즌 성적이 살림에
  // 남는다 (season.md §2)
  const recent = state.matches
    .filter(
      (m) =>
        m.result &&
        !isFriendly(m) &&
        // 2군 리그도 표를 팔지 않는다 — 1군 성적만 관중을 움직인다 (season.md §2)
        !isReserveMatch(m) &&
        (m.homeTeamId === teamId || m.awayTeamId === teamId),
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
    .slice(-OCCUPANCY_FORM_MATCHES);
  if (recent.length > 0) {
    const wins = recent.filter((m) => {
      const home = m.homeTeamId === teamId;
      const mine = home ? m.result!.homeGoals : m.result!.awayGoals;
      const theirs = home ? m.result!.awayGoals : m.result!.homeGoals;
      return mine > theirs;
    }).length;
    occupancy += (wins / recent.length - OCCUPANCY_PAR_WIN_RATE) * OCCUPANCY_FORM_SWING;
  }

  // 상대 매력도 · 더비 · 대회 · 슬롯
  const oppTier = tierOf(state, opponentId);
  occupancy += OCCUPANCY_BY_OPPONENT_TIER[oppTier];
  const derby = derbyForMatch(match);
  if (derby) occupancy += OCCUPANCY_DERBY_BONUS * derby.heat;
  if (isCup(match.competitionId)) occupancy += OCCUPANCY_CUP_BONUS;
  const dow = dayOfWeek(match.date);
  if (dow === 1 || dow === 2 || dow === 3 || dow === 4) occupancy -= OCCUPANCY_WEEKNIGHT_PENALTY;

  // 결정적 미세 변동
  const rng = makeRng(state.seed, `attendance:${match.id}`);
  occupancy += (rng() - 0.5) * OCCUPANCY_JITTER;

  /**
   * **하한은 성적이 만드는 몫에만 걸린다** (finance.md §5.2). 순위도 폼도 바닥이면
   * 0.45는 오지만, 그 뒤에 곱하는 가격 탄력과 친선 배율은 하한 밖이다 — 표를 두 배
   * 값에 팔면 관중이 0.45 아래로 내려가야 하고, 프리시즌 관중은 만석 판정에 넣지
   * 않는다. 상한(만석)을 **탄력 뒤에** 두는 것이 가격 결정권의 요점이다: 수요가 1을
   * 넘어 잘리고 있던 구단만 값을 올려도 관중을 잃지 않는다.
   */
  occupancy = Math.max(OCCUPANCY_FLOOR, occupancy);
  const ratio = ticketRatioOf(state, teamId);
  occupancy = Math.min(1, occupancy * ticketDemandFactor(ratio));
  const friendly = isFriendly(match);
  if (friendly) occupancy *= FRIENDLY_ATTENDANCE_FACTOR;
  const attendance = Math.round(capacity * occupancy);

  const price =
    ticketBasePriceOf(state, teamId, leagueOfTeamIn(state, teamId)) *
    ratio *
    (isEuroCup(match.competitionId) ? EURO_TICKET_FACTOR : 1) *
    (friendly ? FRIENDLY_TICKET_FACTOR : 1);
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
 *
 * **상대 구단의 몫도 여기서 함께 넣는다.** 간이 시뮬은 두 팀을 다 챙기는데
 * (`applyAiMatchFinance` — tick.ts) 유저 경기는 이 함수가 유저 쪽만 기록했다.
 * 그래서 유저가 원정 가는 시즌 열아홉 경기의 **홈 팀이 입장 수입을 못 받았다**.
 * 그 함수가 유저 팀을 건너뛰므로 겹치지 않는다.
 */
export function applyMatchFinance(
  state: GameState,
  match: MatchRecord,
  outcome: "win" | "draw" | "loss",
  digest: TickSink,
): void {
  applyAiMatchFinance(state, match);
  const teamId = state.userTeamId;
  const home = match.homeTeamId === teamId;
  const opponentId = home ? match.awayTeamId : match.homeTeamId;
  const label = `${competitionShortName(match.competitionId)} vs ${teamShortNameIn(state, opponentId)}`;
  const ref = { type: "match" as const, id: match.id };

  /**
   * **중립 경기(결승)에선 홈 표기가 자리 이름일 뿐이다** — 게이트는 개최지의 몫이라
   * 우리 수입이 아니고, 두 팀 다 남의 구장으로 이동한다. 표기로 원정비를 가르면 같은
   * 결승에서 낸 돈이 갈린다 (finance.md §5.2).
   */
  const travels = !home || match.neutral === true;

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
      `관중 ${gate.attendance.toLocaleString("en-US")}명 (${Math.round(gate.occupancy * 100)}%) — 입장 수입 ${money(gate.income)}`,
    );
  }
  if (travels && !isFriendly(match)) {
    /**
     * **친선 원정에는 비용을 매기지 않는다** — 주최 측이 부담하는 자리다.
     *
     * 실제 프리시즌은 초청이다: 판을 벌인 쪽이 게이트를 갖고 방문 클럽에는 출전료가
     * 간다. 우리 모델엔 출전료가 없으므로, 방문 쪽에 정규 원정비(경기 하나 £120k)를
     * 그대로 물리면 **한쪽만 있는 장부**가 된다. 리그전을 굴리지 않는 2부는 그 차액을
     * 메울 리그 수입이 없어 프리시즌마다 구조적으로 깎인다 (finance.md §5.1).
     * 새 상수를 만들지 않는 쪽이 근거가 분명하다 — 매기지 않는다.
     */
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

  // 승리 수당 — 걸린 것이 있는 경기에만. 친선의 승리는 수당의 대상이 아니다
  if (outcome === "win" && !isFriendly(match)) {
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
    const tier = tierOf(state, teamId);
    const friendly = isFriendly(match);

    if (side === "home" && !match.neutral) {
      const { capacity } = profileOf(state, teamId);
      // AI 구단은 언제나 기준가다 — 가격 결정권은 감독의 길이다 (finance.md §5.2)
      const price =
        ticketBasePriceOf(state, teamId, leagueOfTeamIn(state, teamId)) *
        (isEuroCup(match.competitionId) ? EURO_TICKET_FACTOR : 1) *
        (friendly ? FRIENDLY_TICKET_FACTOR : 1);
      const occupancy = OCCUPANCY_BASE[tier] * (friendly ? FRIENDLY_ATTENDANCE_FACTOR : 1);
      const gate = capacity * occupancy * price * (1 + HOSPITALITY_RATE[tier]);
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
    }
    // 중립 경기는 양쪽 다 원정이다 — 유저 경기와 같은 규칙(`applyMatchFinance`)
    if ((side === "away" || match.neutral === true) && !friendly) {
      // 친선 원정은 주최 측이 부담한다 — 같은 자리
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

/** 이 구단이 우리 재정 세계 밖인가 — 경기를 하지 않는 리그(사우디·MLS)는 원장이 없다 */
export function isOutsideOurEconomy(teamId: string): boolean {
  return isMarketOnlyLeague(leagueOfTeam(teamId));
}

/**
 * 주간 주급 지급 — 전 팀 (월요일).
 *
 * **유저 팀만 선수별로 적는다.** 원장은 유저 팀만 쌓으므로(§4.5) AI 팀에 명세를
 * 만들면 잔고 한 번 더할 것을 스물몇 번 나눠 더하는 값만 치른다 — 160개 구단 ×
 * 매주다.
 * 유저 팀 명세는 선수별 줄이라 피드가 묶음으로 접는다 (§8.1).
 *
 * `weeks`는 **하루에 무는 주 수**다 — 시즌 마감이 건너뛴 월요일을 한 번에 물 때만
 * 1이 아니다 (§7.1). 그날의 주급 명세로 계산하므로, 이미 팀을 떠난 선수의 지난
 * 주급을 소급하지는 않는다.
 */
export function payWeeklyWages(state: GameState, weeks = 1): void {
  if (weeks <= 0) return;
  const suffix = weeks > 1 ? ` (${weeks}주)` : "";
  const playerNames = new Map(state.players.map((p) => [p.id, p.name]));
  for (const team of state.teams) {
    // 무소속은 구단이 아니다 — 자유계약 선수가 모인 자리라 낼 주급도 받을 수입도 없다
    if (!isClubTeam(team.id) || isOutsideOurEconomy(team.id)) continue;
    if (team.id !== state.userTeamId) {
      const wages = weeklyWagesOf(state, team.id);
      if (wages > 0) {
        recordFinance(state, team.id, {
          kind: "expense",
          category: "player_wages",
          label: `선수단 주급${suffix}`,
          amount: wages * weeks,
        });
      }
      continue;
    }
    for (const line of weeklyWageLinesOf(state, team.id)) {
      recordFinance(state, team.id, {
        kind: "expense",
        category: "player_wages",
        label: `${playerNames.get(line.gamePlayerId) ?? line.gamePlayerId}${suffix}`,
        amount: line.weekly * weeks,
        ref: { type: "player", id: line.gamePlayerId },
      });
    }
  }
}

/**
 * 시즌 전환이 건너뛰는 주급의 주 수 — `from` **다음 날부터 `until` 전날까지**의
 * 월요일 수 (§7.1).
 *
 * `from`(시즌 종료일)의 주급은 그날의 tick이 이미 물었고, `until`(다음 시즌
 * 시작일 = 7월 1일)은 새 시즌·새 스쿼드의 몫이라 양 끝을 다 뺀다.
 */
export function skippedWageWeeks(from: string, until: string): number {
  let weeks = 0;
  for (let date = addDays(from, 1); date < until; date = addDays(date, 1)) {
    if (dayOfWeek(date) === 1) weeks += 1;
  }
  return weeks;
}

// ── 자산 상각 ─────────────────────────────────────────────

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm);
}

/**
 * **구장 자산의 내용연수** (개월) — 10년 (finance.md §6.1).
 *
 * 실제 구장의 감가상각은 25~50년이지만 근거는 그쪽이 아니라 **회수 기간**이다:
 * 좌석 하나가 `SEAT_COST`(£8k)에 서서 시즌당 그 십분의 일쯤을 벌어들이므로,
 * 상각 기간을 회수 기간에 맞추면 증설은 갚는 동안 손익이 대략 0이고 다 갚은 뒤부터
 * 이익이 된다 — 감독이 원장에서 읽을 수 있는 이야기가 그 자리에서 나온다.
 */
export const STADIUM_ASSET_MONTHS = 120;

export interface CapitalAssetInput {
  id: string;
  label: string;
  cost: number;
  months: number;
}

/**
 * **자본 자산을 산다** — 현금은 오늘 한 번(`capex`), 손익은 내용연수에 나눠(`depreciation`).
 *
 * 취득원가와 기간을 `finance.assets`에 줄로 든다 (finance.md §6.1). 자산을 만드는
 * 유일한 입구다.
 */
export function recordCapitalAsset(
  state: GameState,
  teamId: string,
  input: CapitalAssetInput,
): void {
  const cost = Math.max(0, Math.round(input.cost));
  if (cost <= 0 || input.months <= 0) return;
  recordFinance(state, teamId, {
    kind: "expense",
    category: "capex",
    label: input.label,
    amount: cost,
  });
  const finance = financeOf(state, teamId);
  finance.assets.push({
    id: input.id,
    label: input.label,
    cost,
    since: state.date,
    months: input.months,
  });
}

export interface DepreciationLine {
  label: string;
  monthly: number;
}

/**
 * 이번 달 자산 상각 — 내용연수가 남은 자산만.
 *
 * 선수 쪽과 같은 불변식을 진다: **턴 상각의 총합이 취득원가를 넘지 않는다.** 여기선
 * 기간이 자산에 적혀 있으므로 지난 개월이 `months`에 닿으면 그냥 멈춘다.
 */
export function depreciationOf(state: GameState, teamId: string): DepreciationLine[] {
  const assets = state.finances.find((f) => f.teamId === teamId)?.assets ?? [];
  const lines: DepreciationLine[] = [];
  for (const asset of assets) {
    if (asset.months <= 0) continue;
    /**
     * **취득한 달의 다음 달부터 센다.** 착공일이 월초든 월말이든 정확히 `months`번
     * 서야 상각 총합이 취득원가와 같다 — 취득한 달을 세면 보드의 답이 1일에 온
     * 자산만 한 달치를 더 문다.
     */
    const elapsed = monthsBetween(monthOf(asset.since), monthOf(state.date));
    if (elapsed < 1 || elapsed > asset.months) continue;
    lines.push({ label: asset.label, monthly: asset.cost / asset.months });
  }
  return lines;
}

/**
 * 팀별 최근 성적 — 월초 정산이 96팀 × 전 경기를 훑지 않도록 한 번만 만든다.
 *
 * **더비는 한 경기보다 무겁다** (`MERCH_DERBY_WEIGHT` · finance.md §5.3) — 창은
 * 여전히 N경기이고 무게만 바뀐다.
 *
 * @returns teamId → 최근 N경기 가중 승률 (경기가 없으면 없음)
 */
function recentWinRates(state: GameState, window: number): Map<string, number> {
  const results = new Map<string, { won: boolean; weight: number }[]>();
  for (const m of [...state.matches].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  )) {
    // 친선·2군 리그는 세지 않는다 — 머천다이징이 읽을 성적은 1군 대회뿐이다 (season.md §2)
    if (!m.result || isFriendly(m) || isReserveMatch(m)) continue;
    const weight = 1 + MERCH_DERBY_WEIGHT * (derbyForMatch(m)?.heat ?? 0);
    const push = (teamId: string, won: boolean) => {
      const list = results.get(teamId) ?? [];
      list.push({ won, weight });
      if (list.length > window) list.shift();
      results.set(teamId, list);
    };
    push(m.homeTeamId, m.result.homeGoals > m.result.awayGoals);
    push(m.awayTeamId, m.result.awayGoals > m.result.homeGoals);
  }
  const rates = new Map<string, number>();
  for (const [teamId, list] of results) {
    const total = list.reduce((sum, e) => sum + e.weight, 0);
    if (total > 0) {
      rates.set(teamId, list.reduce((sum, e) => sum + (e.won ? e.weight : 0), 0) / total);
    }
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
export function runMonthlyFinance(state: GameState, digest: TickSink): void {
  closeMonths(state, digest, previousMonth(monthOf(state.date)));
  postMonthlyItems(state);
  pruneLedger(state);
}

/**
 * 시즌의 **마지막 달 마감** — 시즌 리뷰와 시즌 전환 사이에서만 부른다 (§7.1).
 *
 * 월초 훅만으로는 시즌의 마지막 달이 시즌 안에서 마감되지 않는다. 시즌은 6월 초에
 * 끝나고 전환이 곧바로 다음 7월 1일로 건너뛰므로 다음 월초 훅은 8월 1일이다. 그런데
 * 6월은 리그 상금·시즌 보너스가 앉는 달이다 — 마감하지 않으면 그 달의 보고서가
 * 다음 시즌 8월에야 선다.
 *
 * **마감보다 먼저 남은 주급을 문다.** 전환이 건너뛰는 월요일만큼 주급이 빠지면 그
 * 달만 수입은 만근이고 지출은 한 주치라, 그 후한 손익이 보고서에 그대로 남는다. 선수는 6월 30일까지 계약돼 있으므로 회계로도 나가야 하는 돈이다.
 *
 * ⚠️ `state.season`·`state.calendar`가 **아직 끝난 시즌일 때** 돌아야 한다. 보고서의
 * 시즌 번호를 그 둘로 역산하고, 남은 월요일도 다음 시즌 달력으로 세기 때문이다.
 */
export function closeSeasonBooks(state: GameState, digest: TickSink): void {
  const nextSeasonStart = buildSeasonCalendar(state.season + 1).preseasonStart;
  payWeeklyWages(state, skippedWageWeeks(state.date, nextSeasonStart));
  closeMonths(state, digest, monthOf(state.date));
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
    (e) => monthOf(e.date) === month && e.category === "facility",
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

/** 강등 클럽에 파라슈트를 세운다 — 시즌 전환에서 부른다 */
export function startParachute(state: GameState, teamId: string, fromLeagueId: string): void {
  const finance = state.finances.find((f) => f.teamId === teamId);
  if (!finance) return;
  finance.parachute = {
    fromLeagueId,
    startSeason: state.season + 1,
    years: PARACHUTE_RATE.length,
  };
}

/** 승격하면 낙하산은 그 자리에서 끝난다 — 1부 배분과 겹쳐 받을 수 없다 */
export function stopParachute(state: GameState, teamId: string): void {
  const finance = state.finances.find((f) => f.teamId === teamId);
  if (finance) delete finance.parachute;
}

/**
 * 강등 뒤 몇 해가 지났나 — 상업 수입 감소가 이 값을 본다 (없으면 null).
 *
 * **`RELEGATED_COMMERCIAL`의 마지막 해를 넘기면 null이다** — 감소는 스폰서 계약이
 * 다시 쓰이기까지의 지연이지 2부의 상업 수준이 아니고, 상업 정액은 리그를 모르는
 * 브랜드 등급에서 나온다(finance.md §9-1).
 */
function relegatedYear(state: GameState, teamId: string): number | null {
  const drop = state.finances.find((f) => f.teamId === teamId)?.parachute;
  if (!drop) return null;
  const year = state.season - drop.startSeason;
  return year >= 0 && year < RELEGATED_COMMERCIAL.length ? year : null;
}

/** 명명 스태프 한 사람이 원장에 남기는 줄 — 라벨과 그달의 몫 */
interface NamedStaffWage {
  label: string;
  monthly: number;
}

/**
 * 이 구단이 **이름으로 급여를 주는 사람들** — 수석코치·코치·의료진·스카우트
 * (finance.md §6.4-1 · ../data/people.md §2-2). 고용 정보를 든 인물이 곧 그 목록이다.
 *
 * 감독은 여기 없다 — 스태프가 아니라 구단이 감독과 맺은 계약이고, 파생 몫 위에 따로
 * 얹힌다. 인물은 감독의 구단에만 서므로 AI 구단은 언제나 빈 목록이다.
 *
 * ⚠️ **사람마다 반올림한 뒤 더한다.** 합계를 먼저 내고 열둘로 나누면 원장에 선 줄들의
 * 합과 파생 몫이 잔돈만큼 어긋나 총액이 기준액에서 밀린다.
 */
function namedStaffWagesOf(state: GameState, teamId: string): NamedStaffWage[] {
  return state.personas.flatMap((persona) => {
    const job = persona.employment;
    if (!job || job.teamId !== teamId || job.contract.until < state.date) return [];
    return [
      { label: `${persona.name} (${job.title})`, monthly: Math.round(job.contract.salary / 12) },
    ];
  });
}

/** 명명 스태프의 월 급여 합 — 파생 몫이 이만큼 덜어진다 (§6.3) */
export function namedStaffMonthlyOf(state: GameState, teamId: string): number {
  return namedStaffWagesOf(state, teamId).reduce((sum, wage) => sum + wage.monthly, 0);
}

/**
 * 스태프 급여의 **파생 기준액** — 월 선수 급여 대비 구단 규모의 몫 (§6.3).
 *
 * 명명된 사람은 이 안에서 이름을 얻고, 명명 합계가 이를 넘어선 뒤부터 고용이 실제로
 * 총액을 올린다. 그달의 `staff_wages`는 `max(이 값, 명명 합계)`다.
 */
export function staffWageBaseOf(state: GameState, teamId: string): number {
  return weeklyWagesOf(state, teamId) * WEEKS_PER_MONTH * STAFF_WAGE_RATE[tierOf(state, teamId)];
}

function postMonthlyItems(state: GameState): void {
  // 96팀 × 전 경기 순회를 피한다 (월초 정산은 전 팀에 적용된다)
  const winRates = recentWinRates(state, MERCH_FORM_MATCHES);
  const leagueSizes = new Map<string, number>();
  for (const t of state.teams) {
    const league = leagueOfTeamIn(state, t.id);
    leagueSizes.set(league, (leagueSizes.get(league) ?? 0) + 1);
  }

  for (const team of state.teams) {
    /**
     * **무소속은 구단이 아니다.** 리그 밖의 자리(`isClubTeam`)라 시설도 아카데미도
     * 이자도 없다 — 거르지 않으면 무소속 선수단이 매달 시설비와 이자를 내며
     * 적자를 쌓는다.
     */
    if (!isClubTeam(team.id)) continue;
    // 경기를 하지 않는 리그의 구단은 원장이 없다
    if (isOutsideOurEconomy(team.id)) continue;
    const pool = poolOf(state, team.id);
    const { commercialTier } = profileOf(state, team.id);

    /**
     * 빚에는 이자가 붙는다 (§9.2) — **그 달을 시작한 잔고**에 붙이므로 이번 달 수입이
     * 들어오기 전에 먼저 뗀다. 새 카테고리를 만들지 않고 이자·세금과 같은 자리에
     * 라벨로만 갈린다. 이자는 비용이라 손익에 잡힌다.
     */
    const interest = monthlyInterestOf(state, team.id);
    if (interest > 0) {
      recordFinance(state, team.id, {
        kind: "expense",
        category: "facility",
        label: "부채 이자",
        amount: interest,
      });
    }

    recordFinance(state, team.id, {
      kind: "income",
      category: "broadcast_equal",
      label: "중계권 균등 배분",
      amount: (BROADCAST_EQUAL_SEASON * equalShareFactor(state, team.id)) / BROADCAST_MONTHS,
    });
    const rank = previousRankOf(state, team.id);
    const size = leagueSizes.get(leagueOfTeamIn(state, team.id)) ?? DEFAULT_LEAGUE_SIZE;
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
    const form =
      winRate === undefined
        ? 0
        : Math.max(
            -MERCH_FORM_SWING,
            Math.min(MERCH_FORM_SWING, (winRate - MERCH_PAR_WIN_RATE) * MERCH_FORM_SLOPE),
          );
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

    /**
     * 스태프 급여 — **명명된 사람은 대상별 한 줄, 남은 몫이 파생 줄**이다 (§6.3).
     *
     * 총액은 `max(파생 기준액, 명명 합계)`라 시작 인원에서는 지금 실측 그대로다:
     * 고용은 스태프 급여를 늘리는 것이 아니라 그 안에서 이름을 얻는 것이고, 감독이
     * 기준액보다 많이 고용했을 때에야 총액이 오른다.
     */
    for (const wage of namedStaffWagesOf(state, team.id)) {
      recordFinance(state, team.id, {
        kind: "expense",
        category: "staff_wages",
        label: wage.label,
        amount: wage.monthly,
      });
    }
    // 명명 합계가 기준액을 넘으면 파생 몫은 0 — `recordFinance`가 0인 줄을 걸러 준다
    recordFinance(state, team.id, {
      kind: "expense",
      category: "staff_wages",
      label: "코칭·사무 스태프 급여",
      amount: Math.max(0, staffWageBaseOf(state, team.id) - namedStaffMonthlyOf(state, team.id)),
    });
    // 감독 연봉 — 계약이 있는 것은 감독 팀뿐이다 (career.md §5.1, 경질은 계약을
    // 지운다). AI 벤치의 몫은 위 스태프 급여율에 이미 뭉쳐 있다
    if (team.id === state.userTeamId && state.manager.contract) {
      const monthly = Math.round(state.manager.contract.salary / 12);
      recordFinance(state, team.id, {
        kind: "expense",
        category: "staff_wages",
        label: "감독 연봉",
        amount: monthly,
      });
    }
    recordFinance(state, team.id, {
      kind: "expense",
      category: "facility",
      label: "시설·아카데미 운영",
      amount: facilityCostOf(state, team.id),
    });
    recordFinance(state, team.id, {
      kind: "expense",
      category: "facility",
      label: "이자·세금",
      amount: financeCostOf(state, team.id),
    });

    /** 자산 상각 — 구장 증설처럼 현금이 한 번 나간 자산의 몫 (§6.1) */
    for (const line of depreciationOf(state, team.id)) {
      recordFinance(state, team.id, {
        kind: "expense",
        category: "depreciation",
        label: line.label,
        amount: line.monthly,
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
function typicalHomeGate(teamId: string, leagueId: string | null, state?: GameState): number {
  const tier = tierOf(state, teamId);
  const { capacity } = profileOf(state, teamId);
  const price = ticketBasePriceOf(state, teamId, leagueId);
  return capacity * OCCUPANCY_BASE[tier] * price * (1 + HOSPITALITY_RATE[tier]);
}

function unplayedLeagueMatchdayMonthly(state: GameState, teamId: string): number {
  const league = leagueOfTeamIn(state, teamId);
  if (isTopLeague(league)) return 0;
  /**
   * 감독의 가격 결정은 여기에도 닿는다 — 감독이 강등돼 이 리그에 있으면 홈 경기가
   * 아예 없어, 이 대체 수입이 그 구단의 매치데이 전부다. 기준가(`typicalHomeGate`)에
   * 배율과 탄력을 함께 곱한다.
   */
  const gate = typicalHomeGate(teamId, league, state) * ticketRevenueFactor(state, teamId);
  return (gate * UNPLAYED_HOME_MATCHES) / BROADCAST_MONTHS;
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
  return catalogRevenueEstimate(teamId, leagueOfTeamIn(state, teamId), state);
}

/**
 * **급여에 쓸 수 있는 돈** (연, £) — 매출에서 고정비를 뺀 뒤의 몫.
 *
 * 천장을 매출에 직접 걸면 안 된다 — 여력 ×1.1이 얹힌 주급에
 * 스태프(주급의 22~28%)·고정비(매출의 2~3할)·경기 운영비를 더하면 **매출을
 * 넘는다.** 현금 하한은 매수 시점만 보고 부채 동결선도 매수만 막으니, 그 뒤로
 * 잔고를 파는 것은 매주 나가는 주급이다.
 *
 * 그래서 **먼저 고정비를 빼고**(그 돈은 급여로 쓸 수 없다) **스태프
 * 급여까지 벗겨** 선수 주급의 몫만 돌려준다 — 주급 £1을 늘리면 실제로는 £1.24가 나간다.
 * 고정비가 매출의 3할인 리그와 2할인 리그가 같은 비중을 쓰지 않게 되는 것이 요점이다.
 *
 * 0.85의 근거는 단위 9와 같다 — **아스날·맨시티가 이미 앉아 있는 값**이다
 * (0.875·0.890). 그 두 구단의 시드를 신뢰하므로 그것을 전 구단의 자로 쓴다.
 */
const WAGE_AFFORDABLE_SHARE = 0.85;

/**
 * `state`는 세이브 문맥에서만 넘어온다 (`tierOf` 주석).
 *
 * ⚠️ **리그는 세이브가 있으면 세이브가 답한다**(`leagueOfTeamIn`) — 고정비는 이미
 * 승강을 알므로(§6.2) 매출만 카탈로그 소속을 읽으면 강등 구단이 2부 수입에 1부 급여
 * 천장을 그대로 갖고, 승격 구단은 1부 수입에 2부 천장으로 묶인다 (finance.md §6.4).
 * 세이브가 아직 없는 세계 생성 시점만 카탈로그 소속이 답한다.
 */
export function affordableWageBill(teamId: string, leagueId?: string, state?: GameState): number {
  const league = leagueId ?? (state ? leagueOfTeamIn(state, teamId) : leagueOfTeam(teamId));
  const net =
    catalogRevenueEstimate(teamId, league, state) - monthlyFixedCostOf(teamId, state) * 12;
  return Math.max(0, net * WAGE_AFFORDABLE_SHARE) / (1 + STAFF_WAGE_RATE[tierOf(state, teamId)]);
}

/**
 * 같은 자를 **세이브 없이** 읽는다 — 새 게임의 초기 주급이 서는 시점엔 `state`가 아직
 * 없다(`initialWages`). 리그를 주지 않으면 카탈로그 리그로 본다. 승강은 세이브에만
 * 있으므로 t=0에서는 두 값이 같다.
 */
function catalogRevenueEstimate(
  teamId: string,
  leagueId = leagueOfTeam(teamId),
  state?: GameState,
): number {
  const { commercialTier } = profileOf(state, teamId);
  /**
   * 중계 몫에 **브랜드 보정**을 얹는다 — 리그 풀을 전 구단에 고르게 곱하면 레알이
   * 브렌트포드와 같은 규모가 된다(실측 매출은 네 배 차이다). 실제로도 큰 브랜드는
   * 자국 배분에서 더 큰 몫을 받고 국제 수입이 따로 붙는다. 같은 보정을 고정비·초기치가
   * 쓰고 있어(`clubEconomyLevel`) 새 눈금이 아니다.
   */
  const pool = Math.min(
    1,
    (leagueCatalogById(leagueId)?.broadcastPool ?? DEFAULT_BROADCAST_POOL) *
      brandPoolLift(state, teamId),
  );
  const broadcast =
    (BROADCAST_EQUAL_SEASON +
      BROADCAST_MERIT_STEP * MERIT_STEPS_TYPICAL +
      BROADCAST_FACILITY_PER_MATCH * TELEVISED_TYPICAL) *
    pool;
  const commercial =
    (COMMERCIAL_MONTHLY[commercialTier] + MERCHANDISING_MONTHLY[commercialTier]) * 12;
  return broadcast + commercial + typicalHomeGate(teamId, leagueId, state) * UNPLAYED_HOME_MATCHES;
}

/** 스폰서 계약의 성과 조항 — 이번 시즌 대항전 참가와 지난 시즌 우승에서 파생 */
function commercialClause(state: GameState, teamId: string): number {
  let bonus = 0;
  for (const entry of state.euroEntrants) {
    if (!entry.teams.includes(teamId)) continue;
    bonus +=
      entry.cupId === "ucl"
        ? COMMERCIAL_UCL_CLAUSE
        : entry.cupId === "uel"
          ? COMMERCIAL_UEL_CLAUSE
          : COMMERCIAL_UECL_CLAUSE;
  }
  const lastSeason = state.season - 1;
  if (state.trophies.some((t) => t.teamId === teamId && t.season === lastSeason)) {
    bonus += COMMERCIAL_TROPHY_CLAUSE;
  }
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

/**
 * 지금 구단의 보고서만 (finance.md §4.3).
 *
 * 보고서는 감독의 구단 것만 쌓이지만, 읽는 자리는 이 문 하나로 모은다.
 */
export function userReports(state: GameState): FinanceReport[] {
  return state.financeReports.filter((r) => r.teamId === state.userTeamId);
}

/**
 * 한 카테고리의 한 줄 — **방향은 `kind`가 정한다.** 카테고리만으로 접으면 서사가 양쪽에
 * 세울 수 있는 항목이 한쪽 줄에서 상계된다 (finance.md §4.2·§4.4).
 */
function lineOf(
  entries: LedgerEntry[],
  kind: "income" | "expense",
  category: FinanceCategory,
): FinanceReportLine | null {
  const mine = entries.filter((e) => e.kind === kind && e.category === category);
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
  const income = FINANCE_INCOME_CATEGORIES.map((c) => lineOf(entries, "income", c)).filter(
    (x): x is FinanceReportLine => x !== null,
  );
  const expense = FINANCE_EXPENSE_CATEGORIES.map((c) => lineOf(entries, "expense", c)).filter(
    (x): x is FinanceReportLine => x !== null,
  );

  const incomeTotal = income.reduce((s, l) => s + l.amount, 0);
  const expenseTotal = expense.reduce((s, l) => s + l.amount, 0);
  const amount = (list: FinanceReportLine[], category: FinanceCategory) =>
    list.find((l) => l.category === category)?.amount ?? 0;

  /**
   * **현금은 자산 상각을 빼고, 손익은 투자를 뺀다** (§6.1) — 현금은 살 때 한 번
   * 나가고, 손익은 쓰는 기간에 나눠 문다.
   */
  const cashNet = entries
    .filter((e) => !isNoncash(e))
    .reduce((sum, e) => sum + (e.kind === "income" ? e.amount : -e.amount), 0);
  const pnlNet =
    incomeTotal -
    amount(income, "transfer_income") -
    (expenseTotal -
      amount(expense, "capex") -
      amount(expense, "transfer_fee") -
      amount(expense, "signing_bonus"));
  const revenue = incomeTotal - amount(income, "transfer_income") - amount(income, "transfer_gain");
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

/** 직전 달 — "YYYY-MM" */
function previousMonth(month: string): string {
  const [year, m] = month.split("-").map(Number) as [number, number];
  return m > 1 ? `${year}-${String(m - 1).padStart(2, "0")}` : `${year - 1}-12`;
}

/** `through`까지 마감 — 유저 팀만. 같은 달을 두 번 마감하지 않는다 */
function closeMonths(state: GameState, digest: TickSink, through: string): void {
  const finance = financeOf(state, state.userTeamId);
  const months = [...new Set(finance.ledger.map((e) => monthOf(e.date)))]
    .filter((m) => m <= through)
    .sort();
  for (const month of months) {
    if (userReports(state).some((r) => r.month === month)) continue;
    const report = buildReport(state, month, finance.ledger);
    state.financeReports.push(report);
    digest.push(
      `${month.replace("-", "년 ")}월 재정 보고서 — 수입 ${money(report.incomeTotal)} / 지출 ${money(report.expenseTotal)} / 순 ${report.cashNet >= 0 ? "+" : "−"}${money(Math.abs(report.cashNet))}`,
      ...financeNoteTexts(report).map((n) => `   ${n}`),
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
  const sameSeason = userReports(state).filter((r) => r.season === season);
  const seasonToDate = {
    income: sameSeason.reduce((x, r) => x + r.incomeTotal, 0) + s.incomeTotal,
    expense: sameSeason.reduce((x, r) => x + r.expenseTotal, 0) + s.expenseTotal,
    cashNet: sameSeason.reduce((x, r) => x + r.cashNet, 0) + s.cashNet,
    pnlNet: sameSeason.reduce((x, r) => x + r.pnlNet, 0) + s.pnlNet,
  };

  const noteCards: FinanceNote[] = [];
  const tone = wageRatioTone(s.wageRatio);
  if (tone === "danger") {
    noteCards.push({ code: "wage-ratio-danger", value: s.wageRatio, limit: WAGE_RATIO_DANGER });
  } else if (tone === "caution") {
    noteCards.push({ code: "wage-ratio-caution", value: s.wageRatio, limit: WAGE_RATIO_CAUTION });
  }
  if (s.cashNet < 0) {
    noteCards.push({ code: "cash-deficit-operating", value: Math.abs(s.cashNet) });
  }
  // 부채는 잔고의 부호로 읽는다 — 감독이 이자를 물고 있다는 사실을 여기서 본다
  const debt = debtOf(state, state.userTeamId);
  if (debt > 0) {
    noteCards.push({ code: "debt", value: debt, extra: debt * DEBT_INTEREST_ANNUAL });
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
    noteCards,
    /**
     * 큰 비정기 항목은 **절단 전에** 여기로 옮겨 적는다 — 그러지 않으면 3개월 뒤
     * 남는 것이 카테고리 합계뿐이라 "그 돈이 언제 들어왔나"에 답할 자리가 없다.
     * 문턱의 기준은 그달을 마감한 잔고다 (§8.2).
     */
    highlights: entries
      .filter((e) => isJournalMoney(e, closingBalance))
      .map((e) => ({
        date: e.date,
        kind: e.kind,
        category: e.category,
        label: e.label,
        amount: e.amount,
      })),
  };
}

/**
 * 월간 보고서 노트 한 줄 — **카드에서 만든다** (finance.md §4.3).
 *
 * 세이브가 드는 것은 `{ code, value, limit }`뿐이다. 문장을 적어 두면 문구 하나를
 * 고쳐도 지난 달의 보고서는 옛 말로 남고, 화면·GM·브리핑이 각자 다른 말을 쓴다.
 * 조언도 판정도 담지 않는다.
 */
export function financeNoteText(note: FinanceNote): string {
  const pct = (v: number | undefined) => `${Math.round((v ?? 0) * 100)}%`;
  switch (note.code) {
    case "wage-ratio-danger":
      return `급여 비중 ${pct(note.value)} — 위험 구간 (${pct(note.limit)} 이상)`;
    case "wage-ratio-caution":
      return `급여 비중 ${pct(note.value)} — 주의 구간 (${pct(note.limit)} 이상)`;
    case "cash-deficit-operating":
      return `운영만으로 ${money(note.value ?? 0)} 적자`;
    case "debt":
      return `부채 ${money(note.value ?? 0)} — 연 이자 ${money(note.extra ?? 0)}`;
  }
}

/**
 * 보고서의 노트 줄들 — 카드에서 문장을 만든다. 보여 주는 자리에만 쓴다.
 */
export function financeNoteTexts(report: FinanceReport): string[] {
  return report.noteCards.map(financeNoteText);
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

// ── 부채 (§9.2) ─────────────────────────────────────────

/** 이 구단이 지고 있는 빚 — 음수 잔고가 곧 부채다 */
export function debtOf(state: GameState, teamId: string): number {
  return Math.max(0, -financeOf(state, teamId).balance);
}

/** 이번 달 이자 — 원금은 자본 이동이라 장부에 잡히지 않고 이자만 비용이 된다 */
function monthlyInterestOf(state: GameState, teamId: string): number {
  return (debtOf(state, teamId) * DEBT_INTEREST_ANNUAL) / 12;
}

// ── 시즌 단위 ───────────────────────────────────────────

/**
 * 시즌 성과 보너스 — 순위 계단과 그 자리의 주급 총액 배수 (finance.md §6).
 *
 * **고정된 계단이다.** 리그 팀 수에서도, 대항전 티켓 수(`cup-catalog`의 `slots` — EPL은
 * UCL 5 · UEL 4 · UECL 2)에서도 파생하지 않는다: 선수단에 무엇을 약속했는가의 자이지
 * 진출 자체의 판정이 아니다.
 */
const SEASON_BONUS = {
  champion: { position: 1, wageMultiple: 4 },
  ucl: { position: 4, wageMultiple: 2 },
  europe: { position: 6, wageMultiple: 1 },
} as const;

/** 우승·유럽 진출 보너스 — 시즌 리뷰에서 (주급 총액 배수) */
export function paySeasonBonuses(state: GameState, position: number, digest: TickSink): void {
  const wages = weeklyWagesOf(state, state.userTeamId);
  const bonus =
    position === SEASON_BONUS.champion.position
      ? wages * SEASON_BONUS.champion.wageMultiple
      : position <= SEASON_BONUS.ucl.position
        ? wages * SEASON_BONUS.ucl.wageMultiple
        : position <= SEASON_BONUS.europe.position
          ? wages * SEASON_BONUS.europe.wageMultiple
          : 0;
  if (bonus <= 0) return;
  const label = position === SEASON_BONUS.champion.position ? "우승 보너스" : "유럽 진출 보너스";
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

/** 리그 순위 상금 — 한 계단당 */
const LEAGUE_PRIZE_STEP = 700_000;

/**
 * 리그 순위 상금 — 시즌 리뷰에서 (전 팀).
 *
 * **리그는 언제나 세이브 기준**(`leagueOfTeamIn`)이다. 승강은 `state.leagueOf`로만
 * 표현되므로(competition/promotion.ts) 카탈로그 리그로 순위표를 부르면 강등팀도
 * 승격팀도 자기가 없는 순위표를 받아 rank 0 — **상금이 통째로 사라진다.** 순위표는
 * 카탈로그 리그로, 리그 크기·중계 배율은 세이브 리그로 읽던 것이 어긋난 자리다.
 */
export function payLeaguePrizes(state: GameState, digest: TickSink): void {
  for (const team of state.teams) {
    if (isOutsideOurEconomy(team.id)) continue;
    const league = leagueOfTeamIn(state, team.id);
    /**
     * 리그전을 하지 않는 2부는 **순위가 없다.** 0경기 0승점 순위표는 정렬이 안정적이라
     * 카탈로그 등재 순서가 그대로 순위가 되고, 매 시즌 같은 팀이 같은 상금을 받아
     * 2부의 재정 서열이 영구히 굳는다. 그 리그의 수입 공백은 매치데이 대체분이 메운다
     * (`unplayedLeagueMatchdayMonthly`).
     */
    if (!isTopLeague(league)) continue;
    const standings = computeStandings(state, league);
    const rank = standings.findIndex((r) => r.teamId === team.id) + 1;
    if (rank <= 0) continue;
    const size = leagueSizeOf(state, team.id);
    const amount = (size + 1 - rank) * LEAGUE_PRIZE_STEP * poolOf(state, team.id);
    if (
      payOnce(state, team.id, `league-prize:S${state.season}`, {
        kind: "income",
        category: "prize",
        label: `리그 순위 상금 (${rank}위 · S${state.season})`,
        amount,
        ref: { type: "competition", id: league },
      }) &&
      team.id === state.userTeamId
    ) {
      digest.push(`리그 순위 상금 ${money(amount)} 입금 (${rank}위)`);
    }
  }
}

// ── 서사가 재정에 닿는 통로 (GM 스킬) ───────────────────

/**
 * 서사 이벤트가 열 수 있는 카테고리 — **코어가 공식으로 내는 축은 닫는다.**
 *
 * 중계권·주급·상각·상금은 계약과 규정에서 계산되는 값이라 서사가 손대면
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
): { ok: boolean; message: string; brief?: CommandBrief } {
  const allowed: readonly string[] =
    input.kind === "income" ? NARRATIVE_INCOME_CATEGORIES : NARRATIVE_EXPENSE_CATEGORIES;
  if (!allowed.includes(input.category)) {
    return {
      ok: false,
      message: `${josa(input.kind === "income" ? "수입" : "지출", "으로/로")} 쓸 수 없는 항목입니다: ${input.category} (가능: ${allowed.join(", ")})`,
    };
  }

  if (managedTeamId(state) === null) return { ok: false, message: "현재 맡은 구단이 없습니다" };
  const amount = input.amount;
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return { ok: false, message: "금액은 양의 안전한 정수여야 합니다" };
  }
  const finance = financeOf(state, state.userTeamId);
  const nextBalance = finance.balance + (input.kind === "income" ? amount : -amount);
  if (!Number.isFinite(nextBalance) || Math.abs(nextBalance) > Number.MAX_SAFE_INTEGER) {
    return { ok: false, message: "잔고가 표현 가능한 금액 범위를 넘습니다" };
  }

  recordFinance(state, state.userTeamId, {
    kind: input.kind,
    category: input.category,
    label: input.note,
    amount,
    source: "narrative",
  });
  const moved = input.kind === "income" ? amount : -amount;
  return {
    ok: true,
    message: `${FINANCE_CATEGORY_KO[input.category]} ${input.kind === "income" ? "수입" : "지출"} ${money(amount)} — ${input.note}`,
    /**
     * 원장 라벨(`note`)은 LLM이 쓴 자유 문장이라 항목에 싣지 않는다 — 갈래는
     * 항목 이름(`FINANCE_CATEGORY_KO`)이 이미 말하고, 그 문장은 장면과 원장에 남는다.
     */
    brief: {
      head: input.kind === "income" ? "수입" : "지출",
      items: [
        item({ label: FINANCE_CATEGORY_KO[input.category], text: money(amount), delta: moved }),
      ],
    },
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
    ...userReports(state).filter((r) => r.season === state.season),
    currentMonthSummary(state),
  ];
  let wages = 0;
  let revenue = 0;
  for (const m of months) {
    const at = (list: FinanceReportLine[], category: FinanceCategory) =>
      list.find((l) => l.category === category)?.amount ?? 0;
    wages += at(m.expense, "player_wages") + at(m.expense, "staff_wages");
    revenue += m.incomeTotal - at(m.income, "transfer_income") - at(m.income, "transfer_gain");
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
 * **경질 위약금** — 구단의 일회성 지출로 기록한다 (career.md §5.4).
 *
 * 금액을 정하는 것은 계약의 일이라 `story/world/manager-employment.ts`의 `managerSeveranceOf`가
 * 갖고, 여기는 그 값을 구단 원장에 기록한다. 일회성 지출이라 카테고리가
 * 따로다 — `staff_wages`에 얹으면 경질한 달의 구단이 임금 과다로 읽힌다
 * (finance.md §9.3).
 */
export function payManagerSeverance(state: GameState, teamId: string, amount: number): void {
  recordFinance(state, teamId, {
    kind: "expense",
    category: "severance",
    label: "감독 위약금",
    amount,
  });
}
