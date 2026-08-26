import { topLeagues } from "../data/league-catalog";
import { leagueOfTeamIn, leagueSizeIn } from "../competition/promotion";
import { tierOfTeamIn } from "../core/club-tier";
import { positionAt, relegationLine } from "../core/league-shape";
import { inventPersonName, occupiedPersonNames, reseatClubPersonas } from "../world/persona";
import { makeRng, randInt } from "../core/rng";
import { addDays, contractUntil, diffDays } from "../core/dates";
import { boardExpectation, computeStandings, type StandingRow } from "../competition/season";
import { syncDefaultTraining } from "../squad/training-plan";
import { expirePendingPress } from "../club/press";
import { payManagerSeverance, recordFinance } from "../club/finance";
import { spendFromWallet, walletOf } from "../club/manager-wallet";
import {
  AI_MANAGER_RATING_FALLBACK,
  MANAGER_TERMS_BY_TIER,
  USER_WARNINGS_BEFORE_SACK,
  boardExpectationText,
  clampCondition,
  formatMoney,
  type Dismissal,
  type GameTeam,
  type ManagerContract,
  type ManagerOffer,
} from "@story-fm/domain";
import {
  clampReputation,
  financeOf,
  managedTeamId,
  playersOf,
  pushNarrative,
  teamName,
  teamNameIn,
  teamShortName,
  teamShortNameIn,
  type GameState,
  type SkillBriefItem,
} from "../core/state";
import type { SkillResult } from "../skills";
import { item } from "../skills/brief";

/**
 * 감독 시장 — **벤치의 사람도 바뀐다.**
 *
 * 이게 없으면 리그의 감독은 시즌이 끝나도 그대로다. 12월에 6연패를 한 구단이
 * 이듬해 5월까지 같은 벤치로 앉아 있고, 감독이 겪는 세계에서 "라이벌이 감독을
 * 갈아치웠다"는 사건이 아예 일어나지 않는다.
 *
 * 판단은 단순하다 — **기대와 실제의 거리**. 구단 등급이 기대 순위를 정하고
 * (`boardExpectation`), 그보다 한참 아래로 처지면 자리가 흔들린다. 실제 경질도
 * 대개 그 계산이다.
 *
 * ## 감독 팀도 예외가 아니다
 *
 * 다만 **감독은 미리 안다.** AI 구단은 조용히 자르지만 감독에게는 경고가 먼저
 * 온다(보드 평판이 깎이고 브리핑에 줄이 선다). 아무 예고 없이 세이브가 끝나면
 * 그건 사건이 아니라 사고다.
 */

/** 이만큼은 치러야 판단한다 — 개막 직후의 순위는 순위가 아니다 */
const MIN_MATCHES = 8;
/** 부임 직후의 유예 (일) — 새 감독에게 시간을 준다 */
const GRACE_DAYS = 75;
/**
 * 등급별 문턱 — **위험한 순위와 잘리는 순위**를 리그 크기의 비율로 적는다.
 *
 * ⚠️ 기대 순위와의 **차이**로만 재면 하위 구단은 영원히 안 잘린다: 잔류가 기대인
 * 팀은 꼴찌를 해도 차이가 강등 칸 수뿐이다. 실제로도 강등권 팀 감독이 가장 자주
 * 잘리는데 그 반대가 됐다. 그래서 등급마다 자리를 직접 적는다.
 *
 * ⚠️ **자리를 순위로 적으면 18팀 리그가 어긋난다** — tier 4의 20위는 분데스리가에
 * 없는 자리라 그 리그의 잔류권 구단은 아무리 처져도 감독이 안 잘렸다. 20팀을 넣으면
 * 예전 값 6·10 / 10·14 / 15·18 / 18·20이 그대로 나온다 (career.md §5).
 */
const SEAT_BAND: Record<number, { danger: number; sack: number }> = {
  1: { danger: 0.3, sack: 0.5 },
  2: { danger: 0.5, sack: 0.7 },
  3: { danger: 0.75, sack: 0.9 },
};

/**
 * 이 구단의 자리 — 체급은 **세이브가 갖는다**(team.md §2), 카탈로그가 아니다.
 * 잔류가 기대인 tier 4는 비율이 아니라 리그의 모양이 자리를 정한다: 강등권에
 * 들어가면 위험하고 꼴찌면 자리가 없다.
 */
function seatOf(state: GameState, teamId: string): { danger: number; sack: number } {
  const size = leagueSizeIn(state, teamId);
  const tier = tierOfTeamIn(state, teamId);
  if (tier === 4) return { danger: relegationLine(size), sack: size };
  const band = SEAT_BAND[tier]!;
  return { danger: positionAt(size, band.danger), sack: positionAt(size, band.sack) };
}
/** 하루에 잘리는 감독 수 상한 — 리그가 하루아침에 뒤집히지 않게 */
const SACKINGS_PER_DAY = 2;
/** 문턱에 걸린 구단이 오늘 결단할 확률 — 시즌 96구단 중 30건 안팎이 되게 */
const SACK_CHANCE = 0.09;
/** 새 감독 효과 — 실제로 관측되는 반등(잠깐이지만 분명하다) */
const NEW_MANAGER_BOUNCE = 6;

/**
 * **무직 감독을 부르는 평판 문턱** — `(보드 + 미디어) / 2` (career.md §5.1).
 *
 * 경질 직후의 보드 평판은 25 이하라 합이 대개 40 언저리다. 그래서 잘린 감독이
 * 곧장 가는 곳은 tier 3·4이고, 위로 올라가려면 그 자리에서 성적을 내야 한다.
 * tier 4는 문턱이 없다 — 잔류가 기대인 구단은 사람을 가리지 않는다.
 */
const OFFER_REPUTATION_GATE: Partial<Record<1 | 2 | 3 | 4, number>> = { 1: 70, 2: 55, 3: 40 };
/** 문턱을 넘은 공석이 오늘 부를 확률 — 매번 부르면 경질이 하루짜리 사건이 된다 */
const OFFER_CHANCE = 0.2;
/** 제안이 살아 있는 날 수 — 답을 미루는 것도 답이다 */
const OFFER_DAYS = 10;
/**
 * 마지막 제안으로부터 이만큼 지나도록 새 제안이 없으면 다음 문턱을 넘는 자리는
 * 확률을 건너뛴다 — 세이브가 무직으로 굳지 않게 하는 안전판이다 (career.md §5.1).
 * 기준이 "제안이 아예 없었다"이면 첫 제안(10일 만료)을 놓친 뒤로는 안전판이 없다.
 */
export const OFFER_DRY_SPELL_DAYS = 120;
/**
 * 공석 명부가 열려 있는 날 수 — 경질 뒤 이만큼은 무직 감독이 먼저 두드릴 수 있다
 * (career.md §5.1). 새 감독은 그날로 서지만, 갓 앉은 벤치는 아직 굳지 않았다.
 */
export const VACANCY_KNOCK_DAYS = 14;
/** 지원해서 선 제안의 연봉 배율 — 아쉬운 쪽이 깎인다 (career.md §5.1) */
export const KNOCK_SALARY_RATE = 0.85;
/**
 * 보드가 재계약 여부를 판정하는 시점 — **만료 이 날 수 앞에서 한 번**
 * (career.md §5.4). 매일 다시 보면 평판이 오르내릴 때마다 통보가 번복된다.
 */
export const RENEWAL_NOTICE_DAYS = 90;
/** 재계약 제안이 서는 보드 평판 문턱 — 아래면 비갱신 통보다 */
export const RENEWAL_BOARD_GATE = 40;
/**
 * 경질 위약금이 무는 **잔여 연봉의 비율** (career.md §5.4).
 *
 * 잔여 전액을 물리면 tier 1의 3년 계약이 £18M — 이적 예산 한 시즌치가 경질 하루에
 * 사라진다. 절반이면 tier 1 최대 £6M이고, 잔여가 짧을수록 싸져 시즌 말 경질이
 * 구단에 싸다는 실제 결이 남는다.
 *
 * 선수 합의 해지의 정산 비율(`market.ts`의 `SEVERANCE_RATE`)과 값이 같지만 **다른
 * 손잡이다** — 하나는 선수가 합의해 줄 앵커고 하나는 구단이 무는 대가라, 합치면
 * 어느 한쪽을 조율할 때 다른 쪽이 딸려 움직인다.
 */
export const MANAGER_SEVERANCE_RATE = 0.5;
/** 잔여를 연 단위로 환산하는 자 — 위약금은 남은 **날**에 비례한다 */
const DAYS_PER_YEAR = 365;

/**
 * tier 4의 흥정 기준점 — 문턱이 없는 등급이라 여유의 출발점만 여기서 잰다.
 * 경질 직후 보드 평판의 바닥(`USER_BOARD_FLOOR`)과 같은 값이다: 그 처지에서는
 * 여유도 바닥에서 시작한다.
 */
const TIER4_HEADROOM_ANCHOR = 25;

/** 문턱에 턱걸이인 감독이 받는 최소 폭 */
const COUNTER_HEADROOM_MIN = 0.05;
/** 아무리 이름값이 커도 여기서 멈춘다 */
const COUNTER_HEADROOM_MAX = 0.3;
/** 문턱 위 평판 1점이 폭을 넓히는 자 — `MIN`에서 `MAX`까지 딱 50점이 걸린다 */
const COUNTER_HEADROOM_SPAN = 200;

/**
 * **흥정의 여유** — 보드가 제시 조건 위로 물러설 수 있는 비율 (career.md §5.1).
 *
 * 문턱(`OFFER_REPUTATION_GATE`)을 얼마나 넘어서 있느냐가 폭이다: 문턱에 턱걸이면
 * 5%, 50을 넘으면 상한 30%. 평판이 문턱 아래인 제안(안전판·tier 4)은 최저 폭만
 * 받는다.
 */
export function counterHeadroom(reputation: number, tier: 1 | 2 | 3 | 4): number {
  const anchor = OFFER_REPUTATION_GATE[tier] ?? TIER4_HEADROOM_ANCHOR;
  return Math.min(
    COUNTER_HEADROOM_MAX,
    COUNTER_HEADROOM_MIN + Math.max(0, reputation - anchor) / COUNTER_HEADROOM_SPAN,
  );
}

/**
 * 경고 단계의 눈금은 **도메인이 갖는다** — 보드 대치 아크가 같은 자를 읽는다
 * (people.md §9). 여기서 부르던 자리가 옮기지 않게 다시 내보낸다.
 */
export { USER_WARNINGS_BEFORE_SACK };
/** 같은 말을 매일 반복하지 않는 간격 — 경고는 한 달에 한 번까지다 */
const WARNING_COOLDOWN_DAYS = 30;
/** 경고 한 번이 깎는 보드 평판 — 경고가 마지막이 아니어도 압박은 남는다 */
const WARNING_BOARD_HIT = 6;
/**
 * 감독이 잘리는 순위 — **AI보다 훨씬 아래**다. 강등권에서도 아래 두 자리,
 * 곧 20팀 리그면 19·20위이고 18팀 리그면 17·18위다.
 *
 * 같은 문턱을 쓰면 우승 경쟁이 기대인 구단에서 10위만 해도 시즌 중에 자리가
 * 없어진다. 그건 규칙이라기보다 사고다 — **경고가 먼저 오기 때문에** 감독은 경고를
 * 세 번 받고, 보드 신뢰가 바닥이고, 그러고도 그 두 자리에 있을 때만 잘린다.
 * 라이벌 구단이 12위에서 감독을 바꾸는 것과는 다른 잣대인데, 그 비대칭은 의도한
 * 것이다: 세계는 감독의 이야기를 위해 돈다.
 */
function userSackBottom(leagueSize: number): number {
  return Math.min(leagueSize, relegationLine(leagueSize) + 1);
}
/** 감독 팀은 이만큼 치른 뒤에야 판단한다 — AI보다 늦게 본다 (경고를 먼저 주기 때문) */
const USER_MIN_MATCHES = 12;
/** 보드 평판이 이 아래로 내려가야 마지막 단계로 간다 */
const USER_BOARD_FLOOR = 25;

/**
 * 순위표를 리그당 한 번만 짓는 자 — **같은 표를 96번 세우지 않는다.**
 *
 * `runManagerMarket`은 96구단을 돌며 각자의 순위를 묻는데, 순위표는 경기 원장에서
 * 파생하고 이 루프는 원장을 건드리지 않는다(감독 이름·선수 상태만 바뀐다). 한 번
 * 세운 표를 그대로 돌려줘도 같은 답이다.
 */
function standingsCache(state: GameState): (leagueId: string) => StandingRow[] {
  const built = new Map<string, StandingRow[]>();
  return (leagueId) => {
    let table = built.get(leagueId);
    if (!table) {
      table = computeStandings(state, leagueId);
      built.set(leagueId, table);
    }
    return table;
  };
}

/** 그 팀이 리그에서 몇 위인가 (1부만 — 2부는 리그전이 없다) */
function positionOf(
  state: GameState,
  teamId: string,
  tableOf: (leagueId: string) => StandingRow[],
): { position: number; played: number } | null {
  const leagueId = leagueOfTeamIn(state, teamId);
  if (!topLeagues().some((l) => l.id === leagueId)) return null;
  const table = tableOf(leagueId);
  const index = table.findIndex((r) => r.teamId === teamId);
  if (index < 0) return null;
  return { position: index + 1, played: table[index]!.played };
}

/** 지금 자리 — 순위와 소화 경기 수 */
function seatStatus(
  state: GameState,
  teamId: string,
  tableOf: (leagueId: string) => StandingRow[] = standingsCache(state),
): { position: number; played: number } | null {
  return positionOf(state, teamId, tableOf);
}

/** 부임한 지 얼마나 됐나 — 옛 세이브엔 없어 시즌 시작으로 본다 */
function daysInCharge(state: GameState, team: { managerSince?: string } | undefined): number {
  const since = team?.managerSince ?? state.calendar.preseasonStart;
  // 부임일이 오늘보다 뒤인 세이브는 없지만, 음수를 그대로 흘리면 유예 판정이 뒤집힌다
  return Math.max(0, diffDays(since, state.date));
}

/**
 * 새 감독을 앉힌다 — 이름·전술 역량치·부임일, 그리고 선수단의 짧은 반등.
 *
 * 유저가 잘린 구단도 이 길로 후임을 세운다. 감독이 없는 구단은 세계에 없다.
 */
function installNewManager(state: GameState, team: GameTeam, rng: () => number): void {
  // 순위표가 없는 팀은 부르는 쪽에서 걸러지므로 무소속은 여기 닿지 않는다 —
  // 폴백은 값 없는 팀(무소속·옛 세이브)을 위한 것이다 (평균 AI 감독)
  const before = team.aiManagerTacticsRating ?? AI_MANAGER_RATING_FALLBACK;
  team.aiManagerTacticsRating = Math.min(92, Math.max(50, before + randInt(rng, -4, 10)));
  // 이미 선 사람들의 이름은 피한다 — 전임도 그 집합에 있으므로 후임은 반드시
  // 다른 이름, 곧 다른 사람이다 (원형 채널에 이름이 들어간다 — people.md §2)
  team.managerName = inventPersonName(rng, team.id, occupiedPersonNames(state));
  team.managerSince = state.date;

  /**
   * **새 감독 효과** — 실제로 관측되는 짧은 반등이다. 선수단이 다시 뛴다:
   * 폼과 컨디션이 조금 오르고, 그 덕에 다음 몇 경기의 결과가 달라진다.
   */
  for (const player of playersOf(state, team.id)) {
    player.state.condition = clampCondition(player.state.condition + NEW_MANAGER_BOUNCE);
    player.state.form = Math.min(1, player.state.form + 0.1);
  }
}

/** 지금 열려 있는 제안 — 만료일 순 (가장 먼저 사라질 것이 앞) */
export function openManagerOffers(state: GameState): ManagerOffer[] {
  return (state.managerOffers ?? [])
    .filter((o) => o.status === "open" && o.expiresOn >= state.date)
    .sort((a, b) => a.expiresOn.localeCompare(b.expiresOn) || a.id.localeCompare(b.id));
}

/** 기한이 지난 제안은 사라진다 — 답하지 않은 것도 답이다 */
function expireStaleOffers(state: GameState, digest: string[]): void {
  for (const offer of state.managerOffers ?? []) {
    if (offer.status !== "open" || offer.expiresOn >= state.date) continue;
    offer.status = "expired";
    digest.push(
      offer.via === "renewal"
        ? `💼 ${teamShortNameIn(state, offer.teamId)}의 재계약 제안이 만료됐다`
        : `💼 ${teamShortNameIn(state, offer.teamId)}의 감독직 제안이 만료됐다`,
    );
  }
}

/** 14일이 지난 공석은 명부에서 내려간다 — 새 벤치가 굳은 자리다 (career.md §5.1) */
function pruneVacancies(state: GameState): void {
  if (!state.managerVacancies?.length) return;
  state.managerVacancies = state.managerVacancies.filter(
    (v) => diffDays(v.on, state.date) < VACANCY_KNOCK_DAYS,
  );
}

/**
 * 무직 안전판 — **이번 무직 기간의 마지막 제안**으로부터 120일이 지났는가
 * (career.md §5.1). 제안이 아직 없었으면 경질일에서 잰다.
 *
 * 지난 무직 기간의 제안(`madeOn < dismissal.on`)은 세지 않는다 — 기준일이
 * 경질일에서 시작하므로 그보다 앞선 기록은 저절로 걸러진다.
 */
export function offerDrySpell(
  offers: ManagerOffer[] | undefined,
  dismissal: { on: string },
  today: string,
): boolean {
  const anchor = (offers ?? []).reduce(
    (latest, o) => (o.madeOn > latest ? o.madeOn : latest),
    dismissal.on,
  );
  return diffDays(anchor, today) >= OFFER_DRY_SPELL_DAYS;
}

/**
 * 공석이 된 구단이 무직 감독을 부른다 (career.md §5.1).
 *
 * @returns 오늘 제안이 붙었으면 true
 */
export function offerVacancy(
  state: GameState,
  teamId: string,
  position: number,
  digest: string[],
): boolean {
  const dismissal = state.dismissal;
  if (!dismissal) return false;
  // 감독이 답할 자리는 한 번에 하나다
  if (openManagerOffers(state).length > 0) return false;
  const offers = state.managerOffers ?? [];
  /**
   * 한 번 부른 구단은 다시 부르지 않는다 — 단 **이번 무직 기간** 안에서다.
   * 기록은 세이브 전체에 쌓이므로 전부 세면 경질이 되풀이될수록 부를 수 있는
   * 구단 풀 자체가 준다.
   */
  if (offers.some((o) => o.madeOn >= dismissal.on && o.teamId === teamId)) return false;

  const tier = tierOfTeamIn(state, teamId);
  const gate = OFFER_REPUTATION_GATE[tier];
  const reputation = (state.manager.reputation.board + state.manager.reputation.media) / 2;
  if (gate !== undefined && reputation < gate) return false;

  const dry = offerDrySpell(offers, dismissal, state.date);
  // 구단·날짜마다 채널을 갈라 뽑는다 — AI 경질의 난수열을 흔들지 않는다
  const rng = makeRng(state.seed, `manager-offer:${state.date}:${teamId}`);
  if (!dry && rng() > OFFER_CHANCE) return false;

  const expectation = boardExpectation(state, teamId);
  const terms = MANAGER_TERMS_BY_TIER[tier];
  state.managerOffers = [
    ...offers,
    {
      // 같은 시드·같은 날이면 같은 id — 난수로 지으면 재현이 깨진다
      id: `mgr-offer-${teamId}-${state.date}`,
      teamId,
      madeOn: state.date,
      expiresOn: addDays(state.date, OFFER_DAYS),
      tier,
      position,
      target: expectation.target,
      expectationCode: expectation.code,
      salary: terms.salary,
      years: terms.years,
      budgetPledge: terms.budgetPledge,
      via: "vacancy",
      status: "open",
    },
  ];
  digest.push(
    `💼 ${teamShortNameIn(state, teamId)}가 감독직을 제안했다 — 기대는 ${boardExpectationText(expectation.code, expectation.target)}` +
      ` · 연봉 ${formatMoney(terms.salary)}·${terms.years}년 · ${OFFER_DAYS}일 안에 답해야 한다`,
  );
  pushNarrative(state, `${teamNameIn(state, teamId)} 감독직 제안`, 5);
  return true;
}

/**
 * AI 구단의 경질·선임 + **무직 감독에게 오는 제안** — tick이 매일 부른다.
 *
 * 새 감독은 **전술 역량치를 새로 뽑고**(직전보다 조금 높게 나오는 쪽으로 기울인다 —
 * 구단은 더 나은 사람을 데려오려 한다) 선수단에 짧은 반등을 남긴다. 그렇게 빈
 * 자리가 무직 감독의 눈높이에 맞으면 그날 제안이 붙는다 (career.md §5.1).
 *
 * @returns 오늘 새 제안이 붙었으면 true — tick이 거기서 멈춰 세운다
 */
export function runManagerMarket(state: GameState, digest: string[]): boolean {
  const rng = makeRng(state.seed, `manager-market:${state.date}`);
  let sacked = 0;
  let offered = false;
  const ourLeague = leagueOfTeamIn(state, state.userTeamId);
  const tableOf = standingsCache(state);

  expireStaleOffers(state, digest);
  pruneVacancies(state);

  for (const team of state.teams) {
    if (sacked >= SACKINGS_PER_DAY) break;
    if (team.id === state.userTeamId) continue;
    if (daysInCharge(state, team) < GRACE_DAYS) continue;
    const standing = seatStatus(state, team.id, tableOf);
    if (!standing || standing.played < MIN_MATCHES) continue;
    if (standing.position < seatOf(state, team.id).sack) continue;
    /**
     * 같은 처지라고 다 잘리지는 않는다 — 구단마다 인내가 다르고, 그래야 리그가
     * 한 라운드에 우르르 감독을 바꾸지 않는다.
     */
    if (rng() > SACK_CHANCE) continue;

    installNewManager(state, team, rng);
    sacked += 1;

    // 공석 명부 — 무직 감독이 먼저 두드릴 수 있는 문이다. 무직인 동안만 쌓는다:
    // 재직 중의 공석은 감독의 것이 아니고, 세이브에 쌓일 이유도 없다 (career.md §5.1)
    if (state.dismissal) {
      state.managerVacancies = [
        ...(state.managerVacancies ?? []),
        { teamId: team.id, on: state.date, position: standing.position },
      ];
    }

    // 우리 리그의 일만 브리핑한다 — 5대 리그 전체를 올리면 소음이다
    if (leagueOfTeamIn(state, team.id) === ourLeague) {
      digest.push(`📰 ${teamShortName(team.id)}가 감독을 경질했다 — 후임은 ${team.managerName}`);
      pushNarrative(state, `${teamName(team.id)} 감독 경질`, 3);
    }

    // 그 자리가 무직 감독의 것이 될 수도 있다
    if (!offered) offered = offerVacancy(state, team.id, standing.position, digest);
  }
  return offered;
}

/**
 * **경질 위약금** — 잔여 계약에 비례하되 연봉 1년치에서 멈춘다 (career.md §5.4).
 *
 * 만료로 끝난 계약에는 잔여가 없어 0이다 — 끝까지 간 계약에 물 것은 없다.
 */
export function managerSeveranceOf(contract: ManagerContract, today: string): number {
  const left = Math.max(0, diffDays(today, contract.until));
  return Math.min(
    contract.salary,
    Math.round((contract.salary * left * MANAGER_SEVERANCE_RATE) / DAYS_PER_YEAR),
  );
}

/**
 * **감독이 그 구단의 사람이 아니게 되는 하루** — 경질과 계약 만료가 함께 쓴다
 * (career.md §5.1 · §5.4).
 *
 * 갈리는 것은 카드의 `kind`와 위약금뿐이다. 무직은 **상태지 사유가 아니라서**,
 * 그 뒤로 도는 길(제안·노크·공석 명부·무직의 tick)은 어느 쪽이든 같아야 한다.
 *
 * @param channel 후임 감독을 뽑는 rng 채널 — 경질과 만료가 같은 날 같은 사람을
 *                세우지 않게 갈라 둔다
 */
function leaveClub(state: GameState, card: Dismissal, channel: string): void {
  const teamId = card.teamId;
  const contract = state.manager.contract;
  /**
   * **위약금은 구단이 무는 구단의 지출이다** (career.md §5.4) — 계약을 지우기 전에
   * 잰다. 만료는 끝까지 간 계약이라 잔여가 0이고, 계약이 없던 옛 세이브도 0이다.
   *
   * ⚠️ **사임은 여기 오지 않는다** — 그쪽은 감독이 지갑에서 무는 돈이라 방향이
   * 반대다. `resignPost`가 카드를 세우기 **전에** 지갑과 원장을 함께 적는다.
   */
  if (contract && card.kind !== "resigned") {
    const severance = managerSeveranceOf(contract, state.date);
    if (severance > 0) {
      payManagerSeverance(state, teamId, severance);
      card.severance = severance;
    }
  }
  state.dismissal = card;
  delete state.manager.contract;

  // 감독이 없는 구단은 세계에 없다 — 옛 구단은 그날로 후임을 세운다
  const team = state.teams.find((t) => t.id === teamId);
  if (team) installNewManager(state, team, makeRng(state.seed, `${channel}:${state.date}`));

  /**
   * **진행 중이던 협상은 전부 사라진다** — 감독이 없는 구단의 흥정이고, 무직인
   * 감독이 남의 구단 선수를 계속 흥정할 수는 없다 (career.md §5.1).
   */
  for (const negotiation of state.negotiations) {
    if (negotiation.status === "open" || negotiation.status === "agreed") {
      negotiation.status = "expired";
    }
  }
  // 답을 기다리던 재계약 제안도 닫힌다 — 다시 계약할 구단이 없어졌다 (career.md §5.4)
  for (const offer of state.managerOffers ?? []) {
    if (offer.status === "open") offer.status = "expired";
  }
}

/**
 * `resign` — **감독이 계약을 물고 스스로 떠난다** (career.md §5.4 · finance.md §9.7).
 *
 * 경질의 거울상이다: 금액은 같은 식(`managerSeveranceOf`)이고, 나가는 곳만 반대라
 * 지갑에서 빠져 옛 구단의 원장에 수입으로 선다. 그다음은 경질·만료와 **한 길**이다 —
 * `leaveClub`이 후임을 세우고 협상을 닫고 무직의 길을 연다.
 *
 * **지갑이 모자라면 못 나간다** — 물지 못하는 계약은 깨지지 않는다.
 */
export function resignPost(state: GameState): SkillResult {
  const teamId = managedTeamId(state);
  if (teamId === null) return { ok: false, message: "이미 무직입니다" };

  const contract = state.manager.contract;
  const buyout = contract ? managerSeveranceOf(contract, state.date) : 0;
  if (buyout > 0) {
    const spend = spendFromWallet(state, { kind: "buyout", amount: buyout, ref: teamId });
    if (!spend.ok) {
      return {
        ok: false,
        message: `${teamNameIn(state, teamId)}와의 계약을 물려면 ${formatMoney(buyout)}가 필요합니다 — 지갑엔 ${formatMoney(walletOf(state))}뿐입니다`,
      };
    }
    recordFinance(state, teamId, {
      kind: "income",
      category: "manager_buyout",
      label: "감독 사임 위약금",
      amount: buyout,
    });
  }

  const expectation = boardExpectation(state, teamId);
  const standing = seatStatus(state, teamId);
  leaveClub(
    state,
    {
      on: state.date,
      season: state.season,
      kind: "resigned",
      teamId,
      tier: tierOfTeamIn(state, teamId),
      ...(standing ? { position: standing.position } : {}),
      target: expectation.target,
      expectationCode: expectation.code,
      ...(buyout > 0 ? { severance: buyout } : {}),
    },
    "user-resigned",
  );

  const line = `사임 — ${teamNameIn(state, teamId)}를 떠났다${buyout > 0 ? ` · 위약금 ${formatMoney(buyout)}` : ""}`;
  pushNarrative(state, line, 5);
  return {
    ok: true,
    message: `${line}. 지갑 ${formatMoney(walletOf(state))} — 이제 무직입니다`,
    brief: {
      head: "사임",
      items: [
        item({ label: "구단", text: teamShortNameIn(state, teamId) }),
        ...(buyout > 0 ? [item({ label: "위약금", text: formatMoney(buyout) })] : []),
        item({ label: "지갑", text: formatMoney(walletOf(state)) }),
      ],
    },
  };
}

/**
 * **재계약 제안** — 지금 구단이 거는 다음 임기 (career.md §5.4).
 *
 * 조건은 지금 등급의 기본 표이되 현 연봉이 그보다 높으면 현 연봉을 유지한다 —
 * 구단이 스스로 깎아 부르지는 않는다. 흥정도 수락도 이직 제안과 같은 길을 탄다.
 */
function standRenewalOffer(state: GameState, contract: ManagerContract, digest: string[]): void {
  const teamId = state.userTeamId;
  const tier = tierOfTeamIn(state, teamId);
  const terms = MANAGER_TERMS_BY_TIER[tier];
  const expectation = boardExpectation(state, teamId);
  const salary = Math.max(contract.salary, terms.salary);
  state.managerOffers = [
    ...(state.managerOffers ?? []),
    {
      id: `mgr-renewal-${teamId}-${state.date}`,
      teamId,
      madeOn: state.date,
      expiresOn: addDays(state.date, OFFER_DAYS),
      tier,
      target: expectation.target,
      expectationCode: expectation.code,
      salary,
      years: terms.years,
      budgetPledge: terms.budgetPledge,
      via: "renewal",
      status: "open",
    },
  ];
  digest.push(
    `💼 보드가 재계약을 제안했다 — 연봉 ${formatMoney(salary)}·${terms.years}년 ·` +
      ` 이적 예산 약속 ${formatMoney(terms.budgetPledge)} · ${OFFER_DAYS}일 안에 답해야 한다`,
  );
  pushNarrative(state, `${teamNameIn(state, teamId)} 재계약 제안`, 5);
}

/**
 * **감독 계약의 하루** — 만료 판정과 재계약 통보 (career.md §5.4). tick이 매일 부른다.
 *
 * 만료는 `오늘 > 만료일` 하나로 잰다. ⚠️ **"만료일 당일"로 재면 영영 오지 않는다** —
 * 리그 최종전과 07-01 사이를 시즌 전환이 통째로 건너뛰므로 계약이 끝나는 06-30은
 * tick이 밟는 날이 아니다(선수 계약의 만료 예고가 이미 밟은 함정이다 —
 * `dueExpiryStage`). 날짜는 단조 증가하므로 건너뛴 날은 다음 tick에 걸리고, 판정이
 * 계약을 지우므로 두 번 걸리지 않는다.
 *
 * @returns 오늘 감독이 알아야 할 일 — 자리를 잃었으면 `"expired"`, 보드의 통보가
 *          섰으면 `"notice"`. tick이 거기서 시계를 세운다.
 */
export function reviewManagerContract(
  state: GameState,
  digest: string[],
): "expired" | "notice" | null {
  // 무직에겐 계약이 없다 — 경질이 이미 지웠다
  if (state.dismissal) return null;
  const contract = state.manager.contract;
  if (!contract) return null;

  if (state.date > contract.until) {
    const teamId = state.userTeamId;
    const expectation = boardExpectation(state, teamId);
    // 순위는 있으면 싣는다 — 만료는 성적이 부른 일이 아니지만 그날의 자리는 사실이다
    const standing = seatStatus(state, teamId);
    leaveClub(
      state,
      {
        on: state.date,
        season: state.season,
        kind: "expired",
        teamId,
        tier: tierOfTeamIn(state, teamId),
        ...(standing ? { position: standing.position } : {}),
        target: expectation.target,
        expectationCode: expectation.code,
      },
      "contract-expired",
    );
    digest.push(
      `💼 계약 만료 — ${teamNameIn(state, teamId)}와의 계약이 ${contract.until}로 끝났다`,
    );
    pushNarrative(state, `${teamNameIn(state, teamId)} 계약 만료`, 5);
    return "expired";
  }

  // 보드의 판정은 만료 90일 전에 한 번뿐이다 — 매일 다시 보면 통보가 번복된다
  if (contract.renewalDecidedOn) return null;
  if (diffDays(state.date, contract.until) > RENEWAL_NOTICE_DAYS) return null;
  contract.renewalDecidedOn = state.date;

  const board = state.manager.reputation.board;
  if (board < RENEWAL_BOARD_GATE) {
    contract.renewalOffered = false;
    digest.push(
      `💼 보드가 재계약하지 않기로 했다 — 계약은 ${contract.until}에 끝난다` +
        ` (보드 평판 ${board} · 문턱 ${RENEWAL_BOARD_GATE})`,
    );
    pushNarrative(state, `재계약 불가 통보 — ${contract.until} 만료`, 5);
    return "notice";
  }
  contract.renewalOffered = true;
  standRenewalOffer(state, contract, digest);
  return "notice";
}

/**
 * 감독 팀의 자리 — **경고가 먼저, 경질은 나중.**
 *
 * 예고 없이 끝나면 사건이 아니라 사고다. 그래서 기대에 못 미치는 상태가
 * 이어지면 보드가 먼저 말하고(`state.manager.boardWarnings`), 그 뒤에도 나아지지
 * 않으면 자리가 없어진다.
 *
 * @returns **오늘** 경질됐으면 true — tick이 그날 하루만 시계를 세운다.
 *          이미 무직이면 볼 자리가 없어 false다 (career.md §5.1).
 */
export function reviewUserSeat(state: GameState, digest: string[]): boolean {
  if (state.dismissal) return false;
  /**
   * 부임 직후엔 보지 않는다 — 새 구단의 순위는 앞 감독이 만든 것이다.
   * 시즌 중 부임이 가능해지면서 생긴 자리다 (career.md §5.1).
   */
  if (
    daysInCharge(
      state,
      state.teams.find((t) => t.id === state.userTeamId),
    ) < GRACE_DAYS
  ) {
    return false;
  }
  const standing = seatStatus(state, state.userTeamId);
  if (!standing || standing.played < USER_MIN_MATCHES) return false;
  const seat = seatOf(state, state.userTeamId);
  const manager = state.manager;
  const warnings = manager.boardWarnings ?? 0;

  // 기대 위로 올라섰으면 경고가 하나 지워진다 — 되돌릴 수 있어야 압박이 이야기가 된다
  if (standing.position <= boardExpectation(state, state.userTeamId).target) {
    if (warnings > 0) {
      manager.boardWarnings = warnings - 1;
      digest.push(
        `보드가 한숨 돌렸다 — 경고 하나가 지워졌다 (${manager.boardWarnings}/${USER_WARNINGS_BEFORE_SACK})`,
      );
    }
    return false;
  }
  if (standing.position < seat.danger) return false;
  // 경고는 **한 달에 한 번까지** — 매일 같은 말을 반복하지 않는다
  if (manager.lastWarnedOn && diffDays(manager.lastWarnedOn, state.date) < WARNING_COOLDOWN_DAYS) {
    return false;
  }

  const board = manager.reputation.board;
  // 경고 수는 마지막 단계에서 멈춘다 — 4/3은 화면이 그릴 수 없는 숫자다.
  // 평판 압박은 계속 걸린다(그게 마지막 경고를 마지막이게 하는 힘이다) (career.md §5)
  const next = Math.min(warnings + 1, USER_WARNINGS_BEFORE_SACK);
  manager.lastWarnedOn = state.date;

  const sackable = standing.position >= userSackBottom(leagueSizeIn(state, state.userTeamId));
  const expectation = boardExpectation(state, state.userTeamId);
  if (next < USER_WARNINGS_BEFORE_SACK || !sackable || board > USER_BOARD_FLOOR) {
    manager.boardWarnings = next;
    manager.reputation.board = clampReputation(board - WARNING_BOARD_HIT);
    digest.push(
      `⚠️ 보드가 성적을 문제 삼았다 — 기대는 ${boardExpectationText(expectation.code, expectation.target)}인데 현재 ${standing.position}위다` +
        ` (경고 ${next}/${USER_WARNINGS_BEFORE_SACK})`,
    );
    pushNarrative(state, `보드 경고 ${next}회`, 4);
    return false;
  }

  /**
   * 경질 카드는 **사실만** 남긴다 — 등급·순위·기대가 있으면 "우승을 노리라는
   * 구단에서 17위"와 "잔류가 기대인 구단에서 17위"가 갈린다. 문장은 화면과 GM이
   * 쓴다 (overview.md §1 철칙 4).
   */
  const sackedTeamId = state.userTeamId;
  leaveClub(
    state,
    {
      on: state.date,
      season: state.season,
      kind: "sacked",
      teamId: sackedTeamId,
      tier: tierOfTeamIn(state, sackedTeamId),
      position: standing.position,
      target: expectation.target,
      expectationCode: expectation.code,
    },
    "user-sacked",
  );

  digest.push(`💼 경질 — ${teamNameIn(state, sackedTeamId)}가 감독 계약을 해지했다`);
  pushNarrative(state, `${teamNameIn(state, sackedTeamId)} 경질`, 5);
  return true;
}

/** 부르는 말을 견주기 위한 정규화 — 사이의 공백·구두점은 같은 말이다 */
const norm = (q: string) => q.replace(/[\s·・\-_.]/g, "").toLowerCase();

/** 제안이 가리키는 말인가 — 제안 id 또는 그 구단의 id·약칭·이름 */
function offerMatches(state: GameState, offer: ManagerOffer, ref: string): boolean {
  const key = norm(ref);
  return (
    norm(offer.id) === key ||
    norm(offer.teamId) === key ||
    norm(teamShortNameIn(state, offer.teamId)) === key ||
    norm(teamNameIn(state, offer.teamId)) === key
  );
}

/**
 * **재계약을 받아들인다 — 같은 구단에서 임기가 다시 시작된다** (career.md §5.4).
 *
 * 계약만 다시 서고 그 밖에는 아무것도 움직이지 않는다: 경고도 압력도 사람도 훈련도
 * 지금 구단의 것이라 지울 이유가 없다. 이적 예산 약속은 부임과 같이 그 자리에서
 * 이행된다.
 */
function acceptRenewal(state: GameState, offer: ManagerOffer): SkillResult {
  if (offer.teamId !== state.userTeamId) {
    return { ok: false, message: `${teamNameIn(state, offer.teamId)}의 제안이 아닙니다` };
  }
  if (offer.status !== "open" || offer.expiresOn < state.date) {
    return {
      ok: false,
      message: `보드의 재계약 제안은 ${offer.expiresOn}에 만료됐습니다`,
    };
  }
  offer.status = "accepted";
  const base = MANAGER_TERMS_BY_TIER[offer.tier as 1 | 2 | 3 | 4];
  const salary = offer.salary ?? base.salary;
  const years = offer.years ?? base.years;
  // 새 임기의 계약이라 재계약 판정 자국은 지고 가지 않는다 — 다음 만료 90일 전에 다시 선다
  state.manager.contract = {
    salary,
    signedOn: state.date,
    until: contractUntil(state.date, years),
  };
  const pledge = offer.budgetPledge ?? 0;
  if (pledge > 0) financeOf(state, state.userTeamId).transferBudget += pledge;

  const name = teamNameIn(state, state.userTeamId);
  pushNarrative(state, `${name} 재계약`, 5);
  return {
    ok: true,
    tone: "good",
    message:
      `${name}와 재계약했습니다 — 연봉 ${formatMoney(salary)}에 ${state.manager.contract.until}까지` +
      (pledge > 0 ? `, 이적 예산 ${formatMoney(pledge)}이 약속대로 더해졌습니다` : `입니다`),
    brief: {
      head: "재계약",
      items: [
        item({ label: "구단", text: name }),
        item({
          label: "연봉",
          text: formatMoney(salary),
          note: `${state.manager.contract.until}까지`,
        }),
        ...(pledge > 0
          ? [item({ label: "이적 예산", text: formatMoney(pledge), delta: pledge })]
          : []),
      ],
    },
  };
}

/**
 * **제안을 받아들인다 — 그날부로 부임한다** (career.md §5.1).
 *
 * 시즌 중이어도 막지 않는다. 순위표는 감독이 아니라 구단 단위라 부임 전 경기까지
 * 포함한 성적이 그 시즌의 기록이 된다 — 그것이 감독이 물려받는 것이다.
 *
 * @param ref 제안 id 또는 구단 이름·약칭
 */
export function acceptManagerOffer(state: GameState, ref: string): SkillResult {
  const offer = (state.managerOffers ?? []).find((o) => offerMatches(state, o, ref));
  /**
   * **재계약은 부임이 아니다** (career.md §5.4) — 구단도 자리도 그대로라 아래의
   * 전이는 하나도 일어나지 않는다. 재직 중에 설 수 있는 제안은 이것뿐이다.
   */
  if (!state.dismissal) {
    if (offer?.via === "renewal") return acceptRenewal(state, offer);
    return { ok: false, message: `${teamNameIn(state, state.userTeamId)} 감독으로 재직 중입니다` };
  }
  if (!offer) return { ok: false, message: `"${ref}"에 해당하는 감독직 제안이 없습니다` };
  if (offer.status !== "open" || offer.expiresOn < state.date) {
    return {
      ok: false,
      message: `${teamNameIn(state, offer.teamId)}의 제안은 ${offer.expiresOn}에 만료됐습니다`,
    };
  }

  offer.status = "accepted";
  const team = state.teams.find((t) => t.id === offer.teamId);
  // 경질 뒤에도 `userTeamId`는 옛 구단이다 (§5.1) — 떠나기 전에 리그를 읽어 둔다
  const fromLeague = leagueOfTeamIn(state, state.userTeamId);
  state.userTeamId = offer.teamId;
  if (team) {
    team.managerName = state.manager.name;
    team.managerSince = state.date;
  }
  /**
   * **감독 계약이 선다** — 제안의 조건으로 (career.md §5.1). 옛 세이브의 제안엔
   * 조건이 없어 그 순간 등급 표의 기본으로 선다. 이적 예산 약속은 그 자리에서
   * 새 구단의 예산에 더해진다 — 약속은 부임과 함께 이행되는 사실이다.
   */
  const base = MANAGER_TERMS_BY_TIER[offer.tier as 1 | 2 | 3 | 4];
  const salary = offer.salary ?? base.salary;
  const years = offer.years ?? base.years;
  const contract = { salary, signedOn: state.date, until: contractUntil(state.date, years) };
  state.manager.contract = contract;
  const pledge = offer.budgetPledge ?? 0;
  if (pledge > 0) financeOf(state, offer.teamId).transferBudget += pledge;
  // 부임한 감독에게 공석은 더 이상 문이 아니다
  state.managerVacancies = [];
  /**
   * 경질장은 지워지지 않고 **이력으로 옮겨진다** (career.md §6) — 잘린 시즌은
   * `SEASON_RECORD`가 없으므로, 이 줄이 없으면 그 해가 커리어 표에서 통째로 빈다.
   */
  state.dismissals = [...(state.dismissals ?? []), state.dismissal];
  delete state.dismissal;
  // 답할 자리는 하나였으니 남은 것은 이제 답할 필요가 없다
  for (const other of state.managerOffers ?? []) {
    if (other.status === "open") other.status = "expired";
  }
  // 앞 구단의 경고를 지고 가지 않는다
  delete state.manager.boardWarnings;
  delete state.manager.lastWarnedOn;
  /**
   * 다가옴의 압력도 마찬가지다 (people.md §8) — 앞 구단 선수의 불만이 쌓아 둔 눈금을
   * 지고 오면, 새 구단 첫 주에 이미 사다리 중턱에서 시작한다.
   */
  state.approaches = [];
  state.approachPressure = [];
  // 보드 요청도 앞 구단주의 것이다 (career.md §5.2) — 새 구단주의 조건은 새 창이 건다
  state.boardDemands = [];
  // 감독이 앞 구단 보드에 건 요청도 같다 (career.md §5.3) — 답할 보드가 없어졌다
  state.boardRequests = [];
  /**
   * 앞 구단 보드가 내준 건별 영입 승인분도 지운다 (finance.md §9.6) — 그 허가는 그
   * 감독의 그 자리에 대한 것이라, 남겨 두면 60일 안에 돌아온 감독이 남의 임기에
   * 받은 승인으로 선수를 산다.
   */
  for (const finance of state.finances) delete finance.earmarked;
  // 라커룸 불만도 앞 구단의 것이다 (people.md §5) — 지고 오면 주의 줄이 옛 이름을 나열한다
  state.issues = [];
  // 앞 구단 선수에게 한 약속도 같다 (people.md §5-2) — 지킬 수 없는 약속이 기한마다 판정된다
  state.promises = [];
  /**
   * 답을 기다리던 회견도 앞 구단의 자리다 (people.md §4) — 그대로 두면 새 구단의
   * 첫 회견이 그것을 방치로 읽어 이유 없이 언론 평판을 깎는다. 감독이 무시한 것이
   * 아니라 물을 구단이 없어진 것이므로 대가 없이 만료다.
   */
  expirePendingPress(state);
  // 기본 훈련은 새 선수단으로 다시 깔린다
  syncDefaultTraining(state);
  // 수석코치·구단주는 구단의 사람이라 새 구단 기준으로 다시 서고,
  // 기자단은 리그를 따라다니므로 리그를 건널 때만 갈린다 (career.md §5.1)
  reseatClubPersonas(state, offer.teamId, {
    crossedLeague: fromLeague !== leagueOfTeamIn(state, offer.teamId),
  });

  const name = teamNameIn(state, offer.teamId);
  pushNarrative(state, `${name} 부임`, 5);
  return {
    ok: true,
    message:
      `${name} 감독으로 부임했습니다 (${state.date}) — 보드의 기대는 ${offer.expectation},` +
      ` 지금 순위는 ${offer.position ?? "-"}위입니다.` +
      ` 계약은 연봉 ${formatMoney(salary)}에 ${contract.until}까지` +
      (pledge > 0 ? `, 이적 예산 ${formatMoney(pledge)}이 약속대로 더해졌습니다` : `입니다`),
    tone: "good",
    brief: {
      head: "부임",
      items: [
        item({ label: "구단", text: name, note: `기대 ${offer.expectation}` }),
        item({ label: "연봉", text: formatMoney(salary), note: `${contract.until}까지` }),
        ...(pledge > 0
          ? [item({ label: "이적 예산", text: formatMoney(pledge), delta: pledge })]
          : []),
      ],
    },
  };
}

/**
 * **제안에 한 차례 조건을 되부른다** — 연봉·이적 예산 약속 (career.md §5.1).
 *
 * 보드의 답은 천장이 정한다: 제시 조건 × (1 + `counterHeadroom`). 되부른 값이
 * 천장 이하면 그대로, 넘으면 천장에서 멈춘다. 어느 쪽이든 흥정은 이 한 번으로
 * 끝난다(`counteredOn`) — 남는 것은 수락 여부뿐이다.
 *
 * @param ref 제안 id 또는 구단 이름·약칭
 */
export function counterManagerOffer(
  state: GameState,
  ref: string,
  ask: { salary?: number; transferBudget?: number },
): SkillResult {
  const offer = (state.managerOffers ?? []).find((o) => offerMatches(state, o, ref));
  // 재직 중에 되부를 수 있는 것은 보드의 재계약 제안뿐이다 (career.md §5.4)
  if (!state.dismissal && offer?.via !== "renewal") {
    return { ok: false, message: `${teamNameIn(state, state.userTeamId)} 감독으로 재직 중입니다` };
  }
  if (!offer) return { ok: false, message: `"${ref}"에 해당하는 감독직 제안이 없습니다` };
  if (offer.status !== "open" || offer.expiresOn < state.date) {
    return {
      ok: false,
      message: `${teamNameIn(state, offer.teamId)}의 제안은 ${offer.expiresOn}에 만료됐습니다`,
    };
  }
  if (offer.counteredOn) {
    return {
      ok: false,
      message: `${teamNameIn(state, offer.teamId)}와의 흥정은 이미 한 차례 끝났습니다 — 남은 것은 수락 여부뿐입니다`,
    };
  }
  if (ask.salary === undefined && ask.transferBudget === undefined) {
    return { ok: false, message: "연봉·이적 예산 중 하나는 불러야 합니다" };
  }

  const tier = offer.tier as 1 | 2 | 3 | 4;
  const base = MANAGER_TERMS_BY_TIER[tier];
  const reputation = (state.manager.reputation.board + state.manager.reputation.media) / 2;
  const headroom = counterHeadroom(reputation, tier);
  const parts: string[] = [];
  /** 흥정이 실제로 선 값 — 축마다 한 줄이다 (모델이 읽는 줄과 같은 자에서 갈린다) */
  const items: SkillBriefItem[] = [];

  /** 한 축의 흥정 — 제시액 아래로는 내려가지 않고, 천장 위로는 올라가지 않는다 */
  const settle = (label: string, offered: number, asked: number): number => {
    const ceiling = Math.round(offered * (1 + headroom));
    if (asked <= offered) {
      parts.push(`${label} ${formatMoney(offered)} — 제시액 아래로는 내려가지 않는다`);
      items.push(item({ label, text: formatMoney(offered), note: "제시액 그대로" }));
      return offered;
    }
    if (asked <= ceiling) {
      parts.push(`${label} ${formatMoney(asked)} — 요구대로`);
      items.push(item({ label, text: formatMoney(asked), note: "요구대로" }));
      return asked;
    }
    parts.push(`${label} ${formatMoney(ceiling)} — 천장에서 멈췄다 (요구 ${formatMoney(asked)})`);
    items.push(item({ label, text: formatMoney(ceiling), note: "천장에서 멈췄다" }));
    return ceiling;
  };

  // 흥정이 끝난 제안의 조건은 확정 사실로 적힌다 — 옛 세이브의 빈 칸도 여기서 찬다
  offer.salary =
    ask.salary === undefined
      ? (offer.salary ?? base.salary)
      : settle("연봉", offer.salary ?? base.salary, ask.salary);
  offer.budgetPledge =
    ask.transferBudget === undefined
      ? (offer.budgetPledge ?? base.budgetPledge)
      : settle("이적 예산 약속", offer.budgetPledge ?? base.budgetPledge, ask.transferBudget);
  offer.years = offer.years ?? base.years;
  offer.counteredOn = state.date;

  pushNarrative(state, `${teamNameIn(state, offer.teamId)} 조건 흥정`, 4);
  return {
    ok: true,
    message:
      `${teamNameIn(state, offer.teamId)}가 답했습니다 — ${parts.join(" · ")}.` +
      ` 흥정은 여기까지입니다 — 남은 것은 수락 여부입니다 (${offer.expiresOn}까지)`,
    brief: {
      head: `${teamNameIn(state, offer.teamId)} 조건 흥정`,
      items: [...items, item({ label: "기한", text: `${offer.expiresOn}까지` })],
    },
  };
}

/**
 * **노크 — 무직 감독이 공석에 먼저 지원한다** (career.md §5.1).
 *
 * 공석 명부(`state.managerVacancies`)에 있는 구단만 두드릴 수 있고, 평판 문턱은
 * 제안과 같은 표(`OFFER_REPUTATION_GATE`)다. 확률이 없다 — 문은 열리거나 안
 * 열리거나다. 성사된 제안은 연봉이 기본의 0.85배다: 아쉬운 쪽이 깎인다.
 *
 * @param teamRef 구단 id 또는 이름·약칭
 */
export function applyForManagerJob(state: GameState, teamRef: string): SkillResult {
  const dismissal = state.dismissal;
  if (!dismissal) {
    return { ok: false, message: `${teamNameIn(state, state.userTeamId)} 감독으로 재직 중입니다` };
  }
  if (openManagerOffers(state).length > 0) {
    return {
      ok: false,
      message: "열린 제안이 있는 동안에는 지원할 수 없습니다 — 답할 자리는 한 번에 하나입니다",
    };
  }
  pruneVacancies(state);
  const key = norm(teamRef);
  const vacancy = (state.managerVacancies ?? []).find(
    (v) =>
      norm(v.teamId) === key ||
      norm(teamShortNameIn(state, v.teamId)) === key ||
      norm(teamNameIn(state, v.teamId)) === key,
  );
  if (!vacancy) {
    const open = (state.managerVacancies ?? []).map((v) => teamShortNameIn(state, v.teamId));
    return {
      ok: false,
      message:
        open.length > 0
          ? `"${teamRef}"은(는) 최근 공석이 아닙니다 — 지금 공석: ${open.join(", ")}`
          : `"${teamRef}"은(는) 최근 공석이 아닙니다 — 지금 지원할 수 있는 공석이 없습니다`,
    };
  }
  if (
    (state.managerOffers ?? []).some((o) => o.madeOn >= dismissal.on && o.teamId === vacancy.teamId)
  ) {
    return {
      ok: false,
      message: `${teamNameIn(state, vacancy.teamId)}와는 이번 무직 기간에 이미 이야기가 오갔습니다`,
    };
  }

  const tier = tierOfTeamIn(state, vacancy.teamId);
  const gate = OFFER_REPUTATION_GATE[tier];
  const reputation = (state.manager.reputation.board + state.manager.reputation.media) / 2;
  if (gate !== undefined && reputation < gate) {
    // 거절도 게임의 사실이다 — 기록은 남기지 않는다: 평판을 회복하면 다시 두드릴 수 있다
    pushNarrative(state, `${teamNameIn(state, vacancy.teamId)} 감독직 지원 거절`, 3);
    return {
      ok: true,
      tone: "bad",
      message:
        `${teamNameIn(state, vacancy.teamId)}가 정중히 거절했습니다 —` +
        ` 평판 ${Math.round(reputation)}이 ${tier}티어의 문턱 ${gate}에 미치지 못합니다`,
      brief: {
        head: "감독직 지원",
        items: [
          item({ label: teamNameIn(state, vacancy.teamId), text: "거절" }),
          item({
            label: "평판",
            text: `${Math.round(reputation)}`,
            note: `${tier}티어 문턱 ${gate}`,
          }),
        ],
      },
    };
  }

  const expectation = boardExpectation(state, vacancy.teamId);
  const terms = MANAGER_TERMS_BY_TIER[tier];
  const salary = Math.round(terms.salary * KNOCK_SALARY_RATE);
  state.managerOffers = [
    ...(state.managerOffers ?? []),
    {
      id: `mgr-offer-${vacancy.teamId}-${state.date}`,
      teamId: vacancy.teamId,
      madeOn: state.date,
      expiresOn: addDays(state.date, OFFER_DAYS),
      tier,
      ...(vacancy.position !== undefined ? { position: vacancy.position } : {}),
      target: expectation.target,
      expectationCode: expectation.code,
      salary,
      years: terms.years,
      budgetPledge: terms.budgetPledge,
      via: "knock",
      status: "open",
    },
  ];
  pushNarrative(state, `${teamNameIn(state, vacancy.teamId)} 감독직 제안 (지원)`, 5);
  return {
    ok: true,
    tone: "good",
    message:
      `${teamNameIn(state, vacancy.teamId)}가 제안으로 답했습니다 — 기대는 ${boardExpectationText(expectation.code, expectation.target)},` +
      ` 연봉 ${formatMoney(salary)}·${terms.years}년·이적 예산 약속 ${formatMoney(terms.budgetPledge)}.` +
      ` 지원한 쪽이라 연봉은 기본보다 짭니다. ${OFFER_DAYS}일 안에 답해야 합니다`,
    brief: {
      head: "감독직 지원",
      items: [
        item({
          label: teamNameIn(state, vacancy.teamId),
          text: "제안",
          note: boardExpectationText(expectation.code, expectation.target),
        }),
        item({ label: "연봉", text: formatMoney(salary), note: `${terms.years}년` }),
        item({ label: "이적 예산 약속", text: formatMoney(terms.budgetPledge) }),
      ],
    },
  };
}
