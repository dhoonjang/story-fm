import { topLeagues } from "../data/league-catalog";
import { leagueOfTeamIn, leagueSizeIn } from "../competition/promotion";
import { tierOfTeamIn } from "../core/club-tier";
import { positionAt, relegationLine } from "../core/league-shape";
import {
  generateOwner,
  inventPersonName,
  occupiedPersonNames,
  ownerOf,
  reseatClubPersonas,
} from "../world/persona";
// 경고도 그 지워짐도 구단주와의 사이를 옮긴다 (people.md §6)
import { MANAGER_SUBJECT, moveRelation } from "../world/relations";
import { makeRng, randInt } from "../core/rng";
import { addDays, contractUntil, diffDays } from "../core/dates";
import { boardExpectation, computeStandings, type StandingRow } from "../competition/season";
import { syncDefaultTraining } from "../squad/training-plan";
import { expirePendingPress, openAppointmentPress } from "../club/press";
import { reportAppointment, reportSacking } from "../club/media";
import { derbyOf } from "../data/derbies";
import { isWorldFigureName } from "../data/world-figures";
import { clearClubVision, standClubVision } from "../club/vision";
import {
  annualRevenueEstimate,
  payManagerSeverance,
  recordFinance,
  wageRatioTone,
} from "../club/finance";
import { spendFromWallet, walletOf } from "../club/manager-wallet";
import {
  AI_MANAGER_RATING_FALLBACK,
  APPROACH_CHANNEL_LABEL,
  APPROACH_PATIENCE_DAYS,
  MANAGER_TERMS_BY_TIER,
  RENEWAL_NOTICE_DAYS,
  USER_WARNINGS_BEFORE_SACK,
  ageOf,
  approachContextText,
  boardExpectationText,
  clampCondition,
  formatMoney,
  naturalPositionOf,
  pressFactText,
  type Approach,
  type ApproachContext,
  type Dismissal,
  type GamePlayer,
  type GameTeam,
  type ManagerContract,
  type ManagerOffer,
  type ManagerPoolEntry,
  type ManagerVacancy,
  type PressFact,
  type PressStance,
} from "@story-fm/domain";
import {
  activeContract,
  clampReputation,
  expirePendingApproach,
  financeOf,
  firstTeamPlayers,
  managedTeamId,
  pendingApproach,
  playersOf,
  pushApproach,
  pushNarrative,
  teamName,
  teamNameIn,
  teamShortName,
  teamShortNameIn,
  weeklyWagesOf,
  type GameState,
  type CommandBriefItem,
} from "../core/state";
import type { CommandResult } from "../commands";
import { item } from "../commands/brief";

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
 * **무직 감독 풀의 상한** — 시즌 30건 안팎의 경질이 나므로 한 시즌 반쯤이다
 * (transfer.md §7 「감독 풀」). 넘으면 자리를 잃은 지 오래된 순으로 민다: 두
 * 시즌째 부르는 데 없는 사람은 세계가 잊은 사람이다.
 */
export const MANAGER_POOL_MAX = 40;
/**
 * 공석이 **풀에서** 사람을 찾을 확률. 풀이 빈 첫 시즌은 이 값과 무관하게 예전처럼
 * 굴러가고(후보가 없으면 지어낸다), 시즌이 쌓일수록 아는 얼굴이 돌아온다.
 */
const POOL_HIRE_CHANCE = 0.6;
/** 그 벤치의 눈높이와 후보 역량치의 허용 차 — 이 폭이 곧 등급 문이다 */
const POOL_RATING_BAND = 8;
/**
 * 자리를 잃고 이만큼은 지나야 후보가 된다. 오늘 잘린 사람이 내일 옆 구단에 서면
 * 그건 이동이 아니라 자리 바꾸기다.
 */
const POOL_HIRE_COOLDOWN_DAYS = 21;

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
 * **재직 감독을 부르는 자리의 등급 여유** — 우리 등급보다 이만큼 아래까지 부를 수
 * 있다 (career.md §5.1 「재직 중 접근·노크」). 0이면 우리보다 낮은 등급은 부르지
 * 않는다: 내려가는 이직은 세계가 먼저 부를 일이 아니라 감독이 두드릴 일이다.
 */
const POACH_TIER_MARGIN = 0;
/**
 * 재직 감독을 부르려면 평판이 문턱 위로 이만큼 서 있어야 한다 (career.md §5.1).
 *
 * 무직의 문턱(`OFFER_REPUTATION_GATE`)이 「이 사람을 앉혀도 되나」라면 여기는
 * 「위약금을 물고 서 있는 사람을 빼올 만한가」라, 같은 표에 여유가 얹힌다 —
 * tier 1 80 · 2 65 · 3 50 · 4 35. 시작 평판이 50이라 위는 성적으로만 열린다.
 */
const POACH_REPUTATION_MARGIN = 10;
/**
 * 문턱을 넘은 자리가 오늘 재직 감독을 부를 확률 — 무직의 `OFFER_CHANCE`보다 낮다.
 * 매 시즌 여러 번 오면 자리를 옮기는 일이 사건이 아니라 일상이 된다.
 */
const POACH_CHANCE = 0.06;
/**
 * **재직 중 노크가 깎는 보드 평판** (career.md §5.1) — 경고 한 번(`WARNING_BOARD_HIT`)과
 * 같은 무게다. 감독의 눈이 밖에 있다는 것은 보드에게 성적을 문제 삼는 것과 같은
 * 크기의 사실이다.
 */
export const KNOCK_BOARD_HIT = 6;
/**
 * **부름을 흘려보낸 값** — 충성의 값 (career.md §5.1). 깎이는 쪽보다 작다: 남는 것이
 * 두드리는 것보다 쉬워야 자리를 지키는 선택이 보상이 아니라 기본이 된다.
 */
export const LOYALTY_BOARD_LIFT = 4;
/**
 * 보드가 재계약 여부를 판정하는 시점 — 값은 도메인이 갖는다. 판정을 내리는 이
 * 파일과 그 뒤 회견마다 거취를 사실로 세우는 `club/press.ts`가 같은 값을 읽는다.
 */
export { RENEWAL_NOTICE_DAYS };
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
 * **벤치에서 내려온 사람을 무직 감독 풀에 앉힌다** (transfer.md §7 「감독 풀」).
 *
 * 경질도, 유저가 그 자리에 부임하는 것도 그 사람에게는 같은 하루다 — 자리를
 * 잃었다. 그래서 두 자리가 이 함수 하나를 부른다.
 *
 * 벤치에 이름이 없으면(유저 팀·옛 세이브) 앉힐 사람이 없다.
 */
function poolSacked(state: GameState, team: GameTeam): void {
  const name = team.managerName;
  if (name === undefined) return;
  /**
   * ⚠️ **감독 자신은 앉지 않는다** (transfer.md §7 「감독 풀」). 감독이 떠난 벤치도
   * 그날로 후임을 세우지만, 거기 서 있던 이름은 감독의 것이라 풀에 넣으면 세계가
   * 그 이름으로 다른 벤치를 채운다 — 감독이 둘이 된다.
   */
  if (name === state.manager.name) return;
  const pool = state.managerPool ?? [];
  // 이름이 곧 `characterId`(전역 유일)라 같은 이름이 두 줄에 앉을 수 없다 (people.md §1)
  if (pool.some((e) => e.name === name)) return;

  const spell = {
    teamId: team.id,
    from: team.managerSince ?? state.calendar.preseasonStart,
    to: state.date,
  };
  const entry: ManagerPoolEntry = {
    name,
    ...(isWorldFigureName(name) ? { real: true } : {}),
    rating: team.aiManagerTacticsRating ?? AI_MANAGER_RATING_FALLBACK,
    lastTeamId: team.id,
    sackedOn: state.date,
    ...(team.managerPersonaSeat === undefined ? {} : { personaSeat: team.managerPersonaSeat }),
    spells: [...(team.managerSpells ?? []), spell],
  };

  /**
   * 상한을 넘으면 **자리를 잃은 지 오래된 순으로 민다** — 같은 날이면 먼저 앉은
   * 사람이 먼저 밀린다. 정렬이 안정적이어야 같은 시드가 같은 세계를 돌린다.
   */
  const next = [...pool, entry];
  state.managerPool =
    next.length <= MANAGER_POOL_MAX
      ? next
      : next
          .map((e, index) => ({ e, index }))
          .sort((a, b) => b.e.sackedOn.localeCompare(a.e.sackedOn) || b.index - a.index)
          .slice(0, MANAGER_POOL_MAX)
          .sort((a, b) => a.index - b.index)
          .map(({ e }) => e);
}

/**
 * 이 벤치의 눈높이에 맞는 무직 감독 — 없으면 `null` (transfer.md §7 「감독 풀」).
 *
 * 등급 문턱을 따로 적지 않는 이유: **체급은 이미 역량치 안에 있다.** 톱클럽에서
 * 잘린 사람의 역량치는 그대로라 하위 구단의 눈높이와 `POOL_RATING_BAND`를 넘게
 * 벌어진다.
 */
function hireFromPool(
  state: GameState,
  teamId: string,
  target: number,
  rng: () => number,
): ManagerPoolEntry | null {
  const candidates = (state.managerPool ?? []).filter(
    (e) =>
      // 자기가 방금 자른 사람을 다시 부르지는 않는다 — 그건 선임이 아니라 번복이다.
      // 그 앞의 구단은 막지 않는다: 몇 해 뒤의 복귀는 이야기가 되는 자리다
      e.lastTeamId !== teamId &&
      diffDays(e.sackedOn, state.date) >= POOL_HIRE_COOLDOWN_DAYS &&
      Math.abs(e.rating - target) <= POOL_RATING_BAND,
  );
  // 확률을 후보 유무와 무관하게 먼저 굴린다 — 순서가 흔들리면 같은 시드가 다른 세계를 돈다
  const drawn = rng() < POOL_HIRE_CHANCE;
  if (!drawn || candidates.length === 0) return null;
  const picked = candidates[randInt(rng, 0, candidates.length - 1)]!;
  state.managerPool = (state.managerPool ?? []).filter((e) => e.name !== picked.name);
  return picked;
}

/**
 * 새 감독을 앉힌다 — 이름·전술 역량치·부임일, 그리고 선수단의 짧은 반등.
 *
 * **풀에서 먼저 찾고, 없으면 지어낸다** (transfer.md §7 「감독 풀」). 풀에서 온
 * 사람은 이름·사람됨·역량치·이력을 그대로 들고 오므로, 그 벤치는 아는 얼굴을
 * 맞는다. 유저가 잘린 구단도 이 길로 후임을 세운다 — 감독이 없는 구단은 세계에 없다.
 *
 * @returns 풀에서 온 사람이면 그 줄, 지어냈으면 `null`
 */
function installNewManager(
  state: GameState,
  team: GameTeam,
  rng: () => number,
): ManagerPoolEntry | null {
  // 순위표가 없는 팀은 부르는 쪽에서 걸러지므로 무소속은 여기 닿지 않는다 —
  // 폴백은 값 없는 팀(무소속·옛 세이브)을 위한 것이다 (평균 AI 감독)
  const before = team.aiManagerTacticsRating ?? AI_MANAGER_RATING_FALLBACK;
  /** 구단이 원하는 사람 — 직전보다 조금 나은 쪽으로 기운다 */
  const target = Math.min(92, Math.max(50, before + randInt(rng, -4, 10)));

  /**
   * **전임을 풀에 넣기 전에 고른다** — 오늘 잘린 사람이 오늘 자기 자리에 다시
   * 앉는 일이 없어야 한다. 식은 기간이 이미 막지만, 순서로도 막는다.
   */
  const hired = hireFromPool(state, team.id, target, rng);
  const outgoing = { ...team };

  if (hired !== null) {
    team.managerName = hired.name;
    // 역량치는 사람이 들고 다닌다 — 그래서 아는 얼굴이 아는 축구를 데려온다
    team.aiManagerTacticsRating = hired.rating;
    team.managerSpells = hired.spells;
    if (hired.personaSeat === undefined) delete team.managerPersonaSeat;
    else team.managerPersonaSeat = hired.personaSeat;
  } else {
    team.aiManagerTacticsRating = target;
    // 이미 선 사람들의 이름은 피한다 — 전임도 그 집합에 있으므로 후임은 반드시
    // 다른 이름, 곧 다른 사람이다 (사람됨 채널이 이름이다 — people.md §2)
    team.managerName = inventPersonName(rng, team.id, occupiedPersonNames(state));
    // 전임의 이력·자리 표식이 남으면 지어낸 사람이 남의 과거를 갖는다
    delete team.managerSpells;
    delete team.managerPersonaSeat;
  }
  team.managerSince = state.date;
  poolSacked(state, outgoing);

  /**
   * **새 감독 효과** — 실제로 관측되는 짧은 반등이다. 선수단이 다시 뛴다:
   * 폼과 컨디션이 조금 오르고, 그 덕에 다음 몇 경기의 결과가 달라진다.
   */
  for (const player of playersOf(state, team.id)) {
    player.state.condition = clampCondition(player.state.condition + NEW_MANAGER_BOUNCE);
    player.state.form = Math.min(1, player.state.form + 0.1);
  }
  return hired;
}

/** 지금 열려 있는 제안 — 만료일 순 (가장 먼저 사라질 것이 앞) */
export function openManagerOffers(state: GameState): ManagerOffer[] {
  return (state.managerOffers ?? [])
    .filter((o) => o.status === "open" && o.expiresOn >= state.date)
    .sort((a, b) => a.expiresOn.localeCompare(b.expiresOn) || a.id.localeCompare(b.id));
}

/**
 * 제안에 걸린 기대 한 줄 — **코드가 원본이고 문장은 폴백이다** (career.md §5.1).
 * 새 제안은 갈래 코드만 적으므로, 옛 세이브의 문장을 먼저 읽으면 새 제안이 빈칸으로 선다.
 */
function offerExpectation(offer: ManagerOffer): string {
  return offer.expectationCode
    ? boardExpectationText(offer.expectationCode, offer.target)
    : `${offer.expectation ?? "-"}(${offer.target}위)`;
}

/** 기한이 지난 제안은 사라진다 — 답하지 않은 것도 답이다 */
function expireStaleOffers(state: GameState, digest: string[]): void {
  for (const offer of state.managerOffers ?? []) {
    if (offer.status !== "open" || offer.expiresOn >= state.date) continue;
    offer.status = "expired";
    if (offer.via === "renewal") {
      digest.push(`💼 ${teamShortNameIn(state, offer.teamId)}의 재계약 제안이 만료됐다`);
      continue;
    }
    /**
     * **부름을 흘려보낸 것도 답이다** (career.md §5.1) — 재직 중에 온 접근을 그냥
     * 지나가게 두면 보드가 그것을 읽는다. 자기가 두드려 선 제안(`knock`)에는 붙지
     * 않는다: 남은 것이 아니라 두드려 놓고 안 간 것이다.
     */
    if (offer.via === "poach" && !state.dismissal) {
      const manager = state.manager;
      manager.reputation.board = clampReputation(manager.reputation.board + LOYALTY_BOARD_LIFT);
      digest.push(
        `💼 ${teamShortNameIn(state, offer.teamId)}의 접근이 답 없이 지나갔다 —` +
          ` 보드가 그것을 봤다 (보드 평판 +${LOYALTY_BOARD_LIFT})`,
      );
      pushNarrative(state, `${teamNameIn(state, offer.teamId)} 접근 무응답`, 4);
      continue;
    }
    digest.push(`💼 ${teamShortNameIn(state, offer.teamId)}의 감독직 제안이 만료됐다`);
  }
}

/**
 * **이번 기간이 시작된 날** — 무직이면 자리를 잃은 날, 재직 중이면 부임한 날
 * (career.md §5.1).
 *
 * 「한 구단은 한 번만 부른다」와 「이번에 이미 이야기가 오간 구단」이 같은 자를 읽어야
 * 한다. 세이브 전체로 세면 재임이 쌓일수록 부를 수 있는 구단 풀 자체가 준다.
 */
function spellStart(state: GameState): string {
  if (state.dismissal) return state.dismissal.on;
  const team = state.teams.find((t) => t.id === state.userTeamId);
  return team?.managerSince ?? state.calendar.preseasonStart;
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
 * 공석이 된 구단이 감독을 부른다 — **무직이면 제안, 재직 중이면 접근**
 * (career.md §5.1).
 *
 * 갈리는 것은 문과 돈이다: 무직은 앉히면 그만이고, 재직 중인 감독은 등급·평판의
 * 문을 더 지나야 하며 옛 구단에 보상금이 간다. 두 길이 한 함수에서 갈리는 것은
 * **부르는 자리가 하나**이기 때문이다 — AI 경질이 낸 그 벤치다.
 *
 * @returns 오늘 제안이 붙었으면 true
 */
export function offerVacancy(
  state: GameState,
  teamId: string,
  position: number,
  digest: string[],
): boolean {
  // 감독이 답할 자리는 한 번에 하나다 — 열린 제안도, 답을 기다리는 면접도 그 하나다
  if (openManagerOffers(state).length > 0 || pendingInterview(state)) return false;
  const dismissal = state.dismissal;
  return dismissal
    ? offerToUnemployed(state, dismissal, teamId, position, digest)
    : poachInPost(state, teamId, position, digest);
}

/**
 * **재직 중인 감독에게 다른 구단이 손을 뻗는다** (career.md §5.1 「재직 중 접근·노크」).
 *
 * 문이 넷이다 — 부임 유예, 등급, 평판, 확률. 넷을 다 지나야 제안이 서고, 그 제안은
 * 옛 구단에 물 보상금(`compensation`)을 들고 온다.
 */
function poachInPost(
  state: GameState,
  teamId: string,
  position: number,
  digest: string[],
): boolean {
  const contract = state.manager.contract;
  // 물 위약금이 없는 자리는 데려가는 협상이 아니다 (계약을 갖지 않는 옛 세이브)
  if (!contract) return false;
  // 갓 앉은 벤치는 아직 굳지 않았다 — AI 구단의 유예와 같은 값이다
  const ourTeam = state.teams.find((t) => t.id === state.userTeamId);
  if (daysInCharge(state, ourTeam) < GRACE_DAYS) return false;

  const tier = tierOfTeamIn(state, teamId);
  // 내려가는 이직은 세계가 먼저 부를 일이 아니다 — 그건 감독이 두드릴 일이다
  if (tier > tierOfTeamIn(state, state.userTeamId) + POACH_TIER_MARGIN) return false;

  const offers = state.managerOffers ?? [];
  const since = spellStart(state);
  // 한 번 부른 구단은 **이번 재임 안에서는** 다시 부르지 않는다
  if (offers.some((o) => o.madeOn >= since && o.teamId === teamId)) return false;

  /**
   * 문턱이 없는 등급(tier 4)은 `counterHeadroom`이 쓰는 기준점에서 잰다 — 부르는
   * 쪽이 아쉬운 무직의 제안과 달리, 서 있는 사람을 빼오는 데에는 어느 등급이든
   * 「그럴 만한 사람인가」가 있다.
   */
  const gate = (OFFER_REPUTATION_GATE[tier] ?? TIER4_HEADROOM_ANCHOR) + POACH_REPUTATION_MARGIN;
  const reputation = (state.manager.reputation.board + state.manager.reputation.media) / 2;
  if (reputation < gate) return false;

  // 채널을 갈라 뽑는다 — 무직의 제안도 AI 경질의 난수열도 흔들지 않는다
  const rng = makeRng(state.seed, `manager-poach:${state.date}:${teamId}`);
  if (rng() > POACH_CHANCE) return false;

  const expectation = boardExpectation(state, teamId);
  const terms = MANAGER_TERMS_BY_TIER[tier];
  // 금액은 **부를 때** 잰다 — 그 구단이 물기로 한 값이 곧 이 값이다 (career.md §5.1)
  const compensation = managerSeveranceOf(contract, state.date);
  state.managerOffers = [
    ...offers,
    {
      id: `mgr-poach-${teamId}-${state.date}`,
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
      ...(compensation > 0 ? { compensation } : {}),
      via: "poach",
      status: "open",
    },
  ];
  digest.push(
    `💼 ${teamShortNameIn(state, teamId)}가 재직 중인 감독에게 손을 뻗었다 —` +
      ` 기대는 ${boardExpectationText(expectation.code, expectation.target)}` +
      ` · 연봉 ${formatMoney(terms.salary)}·${terms.years}년` +
      (compensation > 0 ? ` · 우리 구단에 보상금 ${formatMoney(compensation)}` : "") +
      ` · ${OFFER_DAYS}일 안에 답해야 한다`,
  );
  pushNarrative(state, `${teamNameIn(state, teamId)} 감독직 접근`, 5);
  return true;
}

/** 공석이 된 구단이 무직 감독을 부른다 (career.md §5.1) */
function offerToUnemployed(
  state: GameState,
  dismissal: Dismissal,
  teamId: string,
  position: number,
  digest: string[],
): boolean {
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
  /**
   * **면접도 사흘이면 닫힌다** (career.md §5.1). 무직인 동안에는 `tickApproaches`가
   * 돌지 않으므로 다가옴의 만료가 이 자리를 대신 본다 — 안 그러면 감독이 답하지 않은
   * 자리가 세이브에 영영 남아 다음 노크를 막는다.
   */
  const closed = expireInterview(state, digest);

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

    /**
     * 라이벌의 경질은 **다음 회견이 싣는다** (people.md §4). 후임이 앉으면 그 구단의
     * 자리가 달라지므로, 그날의 순위는 그날 적어 둔다 — `installNewManager` 앞이다.
     */
    if (derbyOf(state.userTeamId, team.id)) {
      state.pressSackings = [
        ...(state.pressSackings ?? []),
        { teamId: team.id, date: state.date, position: standing.position },
      ];
    }
    /** 재임 일수는 후임이 앉는 순간 사라진다 — 그날의 사실은 그날 읽어 둔다 */
    const wasSince = team.managerSince;
    const hired = installNewManager(state, team, rng);
    sacked += 1;

    /**
     * 공석 명부 — 감독이 먼저 두드릴 수 있는 문이다 (career.md §5.1). **재직 중에도
     * 쌓인다**: 계약을 남기고 떠나는 길이 열려 있으므로 재직 중의 공석도 감독의
     * 것이다. 14일이 지나면 `pruneVacancies`가 내린다.
     */
    state.managerVacancies = [
      ...(state.managerVacancies ?? []),
      { teamId: team.id, on: state.date, position: standing.position },
    ];

    // 우리 리그의 일만 브리핑한다 — 5대 리그 전체를 올리면 소음이다
    if (leagueOfTeamIn(state, team.id) === ourLeague) {
      digest.push(
        `📰 ${teamShortName(team.id)}가 감독을 경질했다 — 후임은 ${team.managerName}` +
          // 풀에서 온 사람이면 어디서 왔는지가 곧 그 선임의 뜻이다 (transfer.md §7)
          (hired === null ? "" : ` (전 ${teamShortNameIn(state, hired.lastTeamId)} 감독)`),
      );
      pushNarrative(state, `${teamName(team.id)} 감독 경질`, 3);
      /**
       * **다이제스트 한 줄 옆에 기사 두 장이 선다** (people.md §4-1). 줄은 그 턴에
       * 흘러가고 마는 사실이지만, 기사는 화자를 지목해 GM이 그 사람의 말을 쓸 수 있게
       * 한다 — 부임한 감독이 무슨 말을 했는지가 라이벌 이야기의 시작이다.
       */
      reportSacking(state, {
        teamId: team.id,
        kind: "sacked",
        position: standing.position,
        target: boardExpectation(state, team.id).target,
        ...(wasSince === undefined ? {} : { since: wasSince }),
      });
      if (team.managerName !== undefined) {
        reportAppointment(state, {
          teamId: team.id,
          managerName: team.managerName,
          fromPool: hired !== null,
          position: standing.position,
        });
      }
    }

    // 그 자리가 무직 감독의 것이 될 수도 있다
    if (!offered) offered = offerVacancy(state, team.id, standing.position, digest);
  }
  /**
   * **마주 앉은 사람 앞에서는 시계가 선다** (people.md §8 · career.md §5.1) — 자리가
   * 사흘이면 사라지므로, 시간이 그 위를 지나가면 감독은 답할 기회 없이 문만 잃는다.
   * 닫힌 날도 하루 세운다: 그 사실을 감독이 모르는 채 지나가면 안 된다.
   */
  return offered || closed || pendingInterview(state) !== null;
}

/**
 * **경질 위약금** — 잔여 계약에 비례하되 연봉 1년치에서 멈춘다 (career.md §5.4).
 *
 * 만료로 끝난 계약에는 잔여가 없어 0이다 — 끝까지 간 계약에 물 것은 없다.
 *
 * ⚠️ **스태프 해고도 이 식이다** (people.md §2-2 · `releaseStaff`). 인자를 연봉과
 * 만료일까지로 좁혀 둔 이유가 그것이다 — 두 곳이 같은 자를 쓰지 않으면 한쪽만
 * 조정되는 날이 온다 (AGENTS.md §5 — 한 규칙 한 정의).
 */
export function managerSeveranceOf(
  contract: Pick<ManagerContract, "salary" | "until">,
  today: string,
): number {
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
   * ⚠️ **사임과 이적은 여기 오지 않는다** — 사임은 감독이 지갑에서 무는 돈이고
   * (`resignPost`), 이적은 새 구단이 옛 구단에 무는 돈이라(`leaveForMove`) 둘 다
   * 방향이 반대다. 구단이 감독에게 무는 것은 경질뿐이고, 그 둘은 카드를 세우기
   * **전에** 각자의 두 장부를 적는다.
   */
  if (contract && card.kind !== "resigned" && card.kind !== "moved") {
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
  /**
   * **감독 자신의 이별도 기사가 된다** (people.md §4-1) — 원인 코드는 카드의 `kind`
   * 그대로다. 재임 일수는 후임이 앉기 전에 읽는다.
   */
  reportSacking(state, {
    teamId,
    kind: card.kind ?? "sacked",
    ...(card.position === undefined ? {} : { position: card.position }),
    ...(card.target === undefined ? {} : { target: card.target }),
    ...(team?.managerSince === undefined ? {} : { since: team.managerSince }),
  });
  if (team) {
    const hired = installNewManager(state, team, makeRng(state.seed, `${channel}:${state.date}`));
    if (team.managerName !== undefined) {
      reportAppointment(state, {
        teamId,
        managerName: team.managerName,
        fromPool: hired !== null,
        ...(card.position === undefined ? {} : { position: card.position }),
      });
    }
  }

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
  /**
   * **감독실 앞에 서 있던 사람도 돌아간다** (people.md §8 · career.md §5.1) — 감독이
   * 무시한 것이 아니라 물을 구단이 없어진 것이라 대가가 없다. 그대로 두면 무직인
   * 감독의 문 앞에 앞 구단 선수가 사흘째 서 있고, 그 자리가 면접이 설 문을 막는다.
   */
  expirePendingApproach(state);
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
export function resignPost(state: GameState): CommandResult {
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
      // 지워진 경고는 구단주와의 사이도 되돌린다 — 압박이 이야기가 되려면 양쪽이 있어야 한다
      moveRelation(state, MANAGER_SUBJECT, ownerOf(state).characterId, "board-eased");
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
    /**
     * **평판과 사이는 다른 값이다** (people.md §6) — 평판은 구단이 감독을 어떻게
     * 보는가이고, 이쪽은 그 사람과의 사이다. 경고를 세 번 받은 감독과 요청을 세 번
     * 지킨 감독의 구단주가 같은 카드로 말하지 않는 자리가 여기다.
     */
    moveRelation(state, MANAGER_SUBJECT, ownerOf(state).characterId, "board-warned");
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
function acceptRenewal(state: GameState, offer: ManagerOffer): CommandResult {
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
 * **재직 중인 감독을 데려간다** — 새 구단이 옛 구단에 보상금을 물고, 감독은 그날로
 * 자리를 옮긴다 (career.md §5.1 「재직 중 접근·노크」).
 *
 * 그다음은 경질·만료·사임과 **한 길**이다(`leaveClub`) — 옛 구단은 후임을 세우고
 * 진행 중이던 협상은 사라진다. 여기서 갈리는 것은 돈의 방향과 카드의 갈래뿐이라,
 * 이 함수가 세운 `moved` 카드를 부임의 일곱 단계가 그대로 받는다.
 *
 * @returns 이력으로 갈 `moved` 카드 — 보상금은 그 `severance`에 적혀 있다
 */
function leaveForMove(state: GameState, offer: ManagerOffer): Dismissal {
  const fromTeamId = state.userTeamId;
  const contract = state.manager.contract;
  /**
   * 금액은 **제안이 들고 온 값**이다 — 부를 때 잰 것이 그 구단이 물기로 한 값이라
   * 열흘 뒤 수락한다고 달라지지 않는다. 조건이 없는 옛 세이브의 제안만 그날 잰다.
   */
  const compensation =
    offer.compensation ?? (contract ? managerSeveranceOf(contract, state.date) : 0);
  if (compensation > 0) {
    // `userTeamId`가 아직 옛 구단이라 이 줄이 **옛 구단** 원장에 선다 (`recordFinance`)
    recordFinance(state, fromTeamId, {
      kind: "income",
      category: "manager_compensation",
      label: `감독 이적 보상금 — ${teamShortNameIn(state, offer.teamId)}`,
      amount: compensation,
    });
  }
  const expectation = boardExpectation(state, fromTeamId);
  const standing = seatStatus(state, fromTeamId);
  const card: Dismissal = {
    on: state.date,
    season: state.season,
    kind: "moved",
    teamId: fromTeamId,
    tier: tierOfTeamIn(state, fromTeamId),
    ...(standing ? { position: standing.position } : {}),
    target: expectation.target,
    expectationCode: expectation.code,
    ...(compensation > 0 ? { severance: compensation } : {}),
  };
  leaveClub(state, card, "manager-moved");
  return card;
}

/**
 * **제안을 받아들인다 — 그날부로 부임한다** (career.md §5.1).
 *
 * 시즌 중이어도 막지 않는다. 순위표는 감독이 아니라 구단 단위라 부임 전 경기까지
 * 포함한 성적이 그 시즌의 기록이 된다 — 그것이 감독이 물려받는 것이다.
 *
 * @param ref 제안 id 또는 구단 이름·약칭
 */
export function acceptManagerOffer(state: GameState, ref: string): CommandResult {
  const offer = (state.managerOffers ?? []).find((o) => offerMatches(state, o, ref));
  /**
   * **재계약은 부임이 아니다** (career.md §5.4) — 구단도 자리도 그대로라 아래의
   * 전이는 하나도 일어나지 않는다.
   *
   * 재직 중에 답할 수 있는 나머지는 **이직 제안**이다 (career.md §5.1) — 다른 구단이
   * 손을 뻗었거나(`poach`) 감독이 재직 중에 두드려 얻은 자리(`knock`)이고, 어느
   * 쪽이든 새 구단이 보상금을 물고 데려가는 한 길이다.
   */
  if (!state.dismissal) {
    if (offer?.via === "renewal") return acceptRenewal(state, offer);
    const moving =
      offer !== undefined &&
      (offer.via === "poach" || offer.via === "knock") &&
      offer.teamId !== state.userTeamId;
    if (!moving) {
      return {
        ok: false,
        message: `${teamNameIn(state, state.userTeamId)} 감독으로 재직 중입니다`,
      };
    }
  }
  if (!offer) return { ok: false, message: `"${ref}"에 해당하는 감독직 제안이 없습니다` };
  if (offer.status !== "open" || offer.expiresOn < state.date) {
    return {
      ok: false,
      message: `${teamNameIn(state, offer.teamId)}의 제안은 ${offer.expiresOn}에 만료됐습니다`,
    };
  }

  /**
   * ⚠️ **자리를 떠나기 전에 이 제안부터 닫는다** — `leaveClub`이 열린 제안을 전부
   * 만료시키므로, 순서가 뒤집히면 방금 수락한 자리가 사라진다.
   */
  offer.status = "accepted";
  const fromTeamId = state.userTeamId;
  /**
   * **이 부임이 이력에 남길 카드** — 무직이면 서 있던 경질장이고, 재직 중이면
   * 여기서 자리를 떠나며 선 이적장이다 (career.md §5.1). 보상금·후임·협상 정리는
   * `leaveForMove`가 그 자리에서 끝낸다.
   */
  const leaving = state.dismissal ?? leaveForMove(state, offer);
  const compensation = leaving.kind === "moved" ? (leaving.severance ?? 0) : 0;
  const team = state.teams.find((t) => t.id === offer.teamId);
  // 경질 뒤에도 `userTeamId`는 옛 구단이다 (§5.1) — 떠나기 전에 리그를 읽어 둔다
  const fromLeague = leagueOfTeamIn(state, state.userTeamId);
  state.userTeamId = offer.teamId;
  if (team) {
    /**
     * **그 벤치에 서 있던 사람도 자리를 잃는다** (transfer.md §7 「감독 풀」) —
     * 경질과 다르지 않다. 이름을 덮기 전에 풀에 앉혀야 그가 세계에 남는다.
     */
    poolSacked(state, team);
    team.managerName = state.manager.name;
    team.managerSince = state.date;
    // 전임의 이력·자리 표식은 그를 따라 풀로 갔다 — 감독의 커리어는 `dismissals`가 든다
    delete team.managerSpells;
    delete team.managerPersonaSeat;
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
  /**
   * **새 구단이 문 보상금** (career.md §5.1 · finance.md §9.7) — `userTeamId`가 이미
   * 새 구단이라 이 줄은 새 구단 원장에 선다. 갈래가 `severance`인 것은 경질 위약금과
   * 같은 성질이기 때문이다: 감독 계약이 부르는 일회성 지출이라 급여 비중을 흔들지
   * 않는다. 이적 예산 약속과 다른 지갑이라 부임 첫날의 예산은 그대로다.
   */
  if (compensation > 0) {
    recordFinance(state, offer.teamId, {
      kind: "expense",
      category: "severance",
      label: `감독 이적 보상금 — ${teamShortNameIn(state, fromTeamId)}`,
      amount: compensation,
    });
  }
  // 부임한 감독에게 공석은 더 이상 문이 아니다
  state.managerVacancies = [];
  /**
   * 경질장은 지워지지 않고 **이력으로 옮겨진다** (career.md §6) — 잘린 시즌은
   * `SEASON_RECORD`가 없으므로, 이 줄이 없으면 그 해가 커리어 표에서 통째로 빈다.
   */
  state.dismissals = [...(state.dismissals ?? []), leaving];
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
  /**
   * 앞 구단의 다년 계획은 지고 가지 않고, 새 구단의 계획이 **부임하는 그 자리에서**
   * 선다 (career.md §5.1). 다음 전환까지 미루면 그 시즌 내내 화면과 GM이 순수
   * 폴백을 읽는데, 그 `since`는 읽는 시점의 시즌이라 계획이 한 번 다시 시작한 것처럼
   * 보인다 — 「1년차」가 두 시즌 연속 뜬다.
   *
   * ⚠️ **`reseatClubPersonas` 뒤여야 한다.** `standClubVision`은 `ownerOf(state)`로
   * 원형 표를 고르는데, 그 앞에서는 구단주 페르소나가 아직 **앞 구단 사람**이다.
   */
  clearClubVision(state);
  standClubVision(state);
  /**
   * **부임 회견이 열린다** (career.md §5.1 · people.md §4). 앞 구단의 회견은 위에서
   * 이미 `expired`로 닫혔으므로 이 자리가 그것을 거절로 읽지 않는다 — 순서가
   * 뒤집히면 이직 하나로 언론 평판이 깎인다.
   *
   * ⚠️ **구단에 묶인 것이 다 선 뒤여야 한다** — `reporterFor`가 `reportersOf(state)`를
   * 읽는데, 리그를 건너는 이직이면 그 앞에서는 아직 앞 리그의 기자단이다.
   * 전임의 사실은 제안이 들고 온 것이다: 그 벤치가 비어 있었던 이유가 그것이다.
   */
  openAppointmentPress(state, {
    ...(offer.position === undefined ? {} : { position: offer.position }),
    target: offer.target,
    expectationCode: offer.expectationCode ?? "mid",
  });

  const name = teamNameIn(state, offer.teamId);
  pushNarrative(state, compensation > 0 ? `${name} 이적 부임` : `${name} 부임`, 5);
  return {
    ok: true,
    message:
      `${name} 감독으로 부임했습니다 (${state.date}) — 보드의 기대는 ${offerExpectation(offer)},` +
      ` 지금 순위는 ${offer.position ?? "-"}위입니다.` +
      ` 계약은 연봉 ${formatMoney(salary)}에 ${contract.until}까지` +
      (pledge > 0 ? `, 이적 예산 ${formatMoney(pledge)}이 약속대로 더해졌습니다` : `입니다`) +
      (compensation > 0
        ? `. 보상금 ${formatMoney(compensation)}는 ${teamNameIn(state, fromTeamId)}의 장부로 갔습니다 — 감독의 지갑은 그대로입니다`
        : ""),
    tone: "good",
    brief: {
      head: compensation > 0 ? "이적 부임" : "부임",
      items: [
        item({ label: "구단", text: name, note: `기대 ${offerExpectation(offer)}` }),
        item({ label: "연봉", text: formatMoney(salary), note: `${contract.until}까지` }),
        ...(pledge > 0
          ? [item({ label: "이적 예산", text: formatMoney(pledge), delta: pledge })]
          : []),
        ...(compensation > 0
          ? [
              item({
                label: "보상금",
                text: formatMoney(compensation),
                note: `${teamShortNameIn(state, fromTeamId)}로`,
              }),
            ]
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
): CommandResult {
  const offer = (state.managerOffers ?? []).find((o) => offerMatches(state, o, ref));
  /**
   * 재직 중에 되부를 수 있는 것은 재직 중에 설 수 있는 제안뿐이다 — 보드의 재계약
   * (career.md §5.4)과 이직 제안(§5.1). 흥정의 길은 셋 다 같다.
   */
  const inPost = offer?.via === "renewal" || offer?.via === "poach" || offer?.via === "knock";
  if (!state.dismissal && !inPost) {
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
  const items: CommandBriefItem[] = [];

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

// ── 감독직 면접 ────────────────────────────────────────────────
//
// **노크가 문턱을 넘으면 제안이 아니라 자리가 선다** (career.md §5.1). 구단주가 마주
// 앉아 그 구단의 사실을 내놓고, 감독의 답(스탠스)을 아래 표가 읽어 조건을 정한다 —
// 판정형이다: 코어가 앵커(기대·공석·재정 등급)를 박고 LLM은 스탠스 하나만 정하며
// 코어가 흥정의 천장으로 자른다 (prompts.md §2).
//
// 자리를 여는 것도 닫는 것도 여기 있는 이유는 하나다 — **이 자리가 만드는 것이
// `ManagerOffer`**라서다. 다가옴의 장부 셋(`pendingApproach`·`pushApproach`·
// `expirePendingApproach`)만 `core/state`에서 가져다 쓴다 (AGENTS.md §5).

/**
 * 면접의 계단 — **고정이다.** 압력도 사다리도 없는 자리라 이 값이 하는 일은 서사
 * 눈금 하나뿐이고, 폭은 쓰이지 않는다: 면접은 어떤 축도 옮기지 않는다.
 */
const INTERVIEW_STEP = 3;

/** 이적 예산 등급을 가르는 리그 안 삼분위 — 위 1/3 · 가운데 · 아래 1/3 */
const BUDGET_TERTILE = 1 / 3;

/** 주급을 연 수입과 견주는 자 — 비전의 재정 항목과 같은 결이다 (career.md §5) */
const WEEKS_PER_YEAR = 52;

/** 답이 여는 문 — 조건을 올려 받는가, 기본인가, 닫히는가 (career.md §5.1) */
type InterviewTerms = "raised" | "base" | "closed";

/**
 * **스탠스 → 조건.** 구단의 처지를 받는 답은 기본 조건으로, 조건을 걸고 오는 답은
 * 흥정의 천장까지, 보드 앞에서 구단을 깎거나 말을 아낀 답은 문이 닫힌다.
 *
 * `bold`가 여기서 얻는 것은 `counterHeadroom`의 천장과 같은 값이다 — 흥정을 미리
 * 당겨 쓴 것이라 `counteredOn`이 그날로 서고 되부를 기회는 남지 않는다.
 */
const INTERVIEW_TERMS: Record<PressStance, InterviewTerms> = {
  own: "base",
  defend: "base",
  bold: "raised",
  criticise: "closed",
  deflect: "closed",
};

/** 면접 카드가 화면에서 서는 이름 — 다섯 줄이 전부 「보드」이면 무엇을 읽는지가 사라진다 */
const INTERVIEW_FACT_KO: Partial<Record<PressFact["kind"], string>> = {
  standing: "자리",
  vacancy: "전임",
  "key-player": "선수단",
  "finance-grade": "재정",
};

/** 답을 기다리는 면접 — 무직인 동안 열릴 수 있는 유일한 자리다 */
export function pendingInterview(state: GameState): Approach | null {
  const open = pendingApproach(state);
  return open?.topic === "interview" ? open : null;
}

/** 이번 무직 기간에 이미 마주 앉은 구단인가 — 같은 문을 두 번 두드릴 수는 없다 */
function interviewedSince(state: GameState, teamId: string, since: string): boolean {
  return (state.approaches ?? []).some(
    (a) => a.topic === "interview" && a.teamId === teamId && a.date >= since,
  );
}

/**
 * 그 선수단의 중심 — **1군 최고 종합 자원.** 부임 회견이 짚는 것과 같은 카드다
 * (people.md §4). 감독이 그 이름을 부를 수 있어야 면접이 「이 선수단을 어떻게
 * 쓰겠는가」의 자리가 된다.
 *
 * ⚠️ `about`을 걸지 않는다 — 아직 남의 구단 선수라 감독의 답이 그의 사기에 닿지
 * 않는다. 이름은 카드의 `name`이 든다.
 */
function keyPlayerOf(state: GameState, teamId: string): PressFact | null {
  const best = firstTeamPlayers(state, teamId).reduce<GamePlayer | null>(
    (top, p) => (top === null || p.attributes.overall > top.attributes.overall ? p : top),
    null,
  );
  if (!best) return null;
  const contract = activeContract(state, best.id);
  return {
    kind: "key-player",
    data: {
      name: best.name,
      tags: [naturalPositionOf(best).position],
      values: {
        age: ageOf(best.birthdate, state.date),
        ...(contract ? { contractDays: Math.max(0, diffDays(state.date, contract.until)) } : {}),
      },
    },
    about: null,
    sharp: false,
  };
}

/**
 * 재정 두 줄 — **등급이지 숫자가 아니다** (career.md §5.1). 아직 그 구단의 사람이
 * 아니라 장부를 열어 보여 주지 않는다.
 *
 * 급여 비중은 재정 보고서와 **같은 구간표**(`wageRatioTone`)를 읽고, 이적 예산은 그
 * 리그 안에서 선 자리를 삼분위로 가른다 — 절대액은 리그마다 자릿수가 달라 등급이
 * 되지 못한다.
 */
function financeGradeFacts(state: GameState, teamId: string): PressFact[] {
  const facts: PressFact[] = [];
  const revenue = annualRevenueEstimate(state, teamId);
  if (revenue > 0) {
    const ratio = (weeklyWagesOf(state, teamId) * WEEKS_PER_YEAR) / revenue;
    facts.push({
      kind: "finance-grade",
      data: { tags: ["wage-share", wageRatioTone(ratio)] },
      about: null,
      // 급여가 수입을 잡아먹는 구단은 감독이 첫날 알아야 하는 사실이다
      sharp: wageRatioTone(ratio) !== "ok",
    });
  }
  const league = leagueOfTeamIn(state, teamId);
  const budgets = state.finances
    .filter((f) => leagueOfTeamIn(state, f.teamId) === league)
    .map((f) => f.transferBudget)
    .sort((a, b) => a - b);
  const mine = state.finances.find((f) => f.teamId === teamId);
  if (mine && budgets.length >= 3) {
    const rank = budgets.filter((b) => b < mine.transferBudget).length / budgets.length;
    const grade = rank >= 1 - BUDGET_TERTILE ? "rich" : rank < BUDGET_TERTILE ? "tight" : "mid";
    facts.push({
      kind: "finance-grade",
      data: { tags: ["transfer-budget", grade] },
      about: null,
      sharp: false,
    });
  }
  return facts;
}

/**
 * **면접 자리를 연다** — 노크가 문턱을 넘은 그 자리에서 (career.md §5.1).
 *
 * 다가옴에서 **세계가 아니라 감독이 여는 유일한 자리**라 소음의 문 넷을 지나지
 * 않는다: 감독 자신이 두드린 문이고, 무직인 동안에는 압력이 여는 자리도 회견도
 * 서지 않는다. 문은 `applyForManagerJob`이 이미 본 둘뿐이다 — 열린 제안, 열린 면접.
 */
function openInterview(state: GameState, vacancy: ManagerVacancy): Approach {
  const teamId = vacancy.teamId;
  const expectation = boardExpectation(state, teamId);
  const facts: PressFact[] = [
    {
      kind: "standing",
      data: { values: { rank: expectation.target }, tags: ["board-target", expectation.code] },
      about: null,
      sharp: true,
    },
    {
      kind: "vacancy",
      data: {
        values: {
          days: Math.max(0, diffDays(vacancy.on, state.date)),
          ...(vacancy.position === undefined ? {} : { position: vacancy.position }),
        },
      },
      about: null,
      sharp: true,
    },
  ];
  const key = keyPlayerOf(state, teamId);
  if (key) facts.push(key);
  facts.push(...financeGradeFacts(state, teamId));

  const contextCard: ApproachContext = {
    code: "interview",
    ...(vacancy.position === undefined ? {} : { value: vacancy.position }),
    limit: expectation.target,
  };
  const approach: Approach = {
    id: `approach-interview-${teamId}-${state.date}`,
    date: state.date,
    channel: "owner",
    topic: "interview",
    // 우리 구단주가 아니라 **마주 앉은 쪽**의 사람이다 (people.md §8)
    speakerId: generateOwner(state.seed, teamId).characterId,
    about: null,
    teamId,
    contextCard,
    facts,
    step: INTERVIEW_STEP,
    status: "pending",
  };
  pushApproach(state, approach);
  pushNarrative(state, `${teamNameIn(state, teamId)} 감독직 면접`, 5);
  return approach;
}

/**
 * 사흘이 지난 면접은 닫힌다 — **대가 없이** (career.md §5.1). 평판도 사이도 옮기지
 * 않는 자리라 남는 것은 그 구단의 문이 이번 무직 기간에 다시 열리지 않는다는 사실뿐이다.
 *
 * @returns 오늘 닫았으면 true — tick이 그 하루를 세워 감독에게 알린다
 */
function expireInterview(state: GameState, digest: string[]): boolean {
  const open = pendingInterview(state);
  if (!open || diffDays(open.date, state.date) < APPROACH_PATIENCE_DAYS) return false;
  open.status = "expired";
  const name = teamNameIn(state, open.teamId ?? "");
  digest.push(`💼 ${name}와의 면접이 답 없이 지나갔다 — 그 자리는 닫혔다`);
  pushNarrative(state, `${name} 감독직 면접 무응답`, 4);
  return true;
}

/**
 * **면접의 답이 조건이 된다** (career.md §5.1) — `respondToApproach`가 자리를 닫은
 * 뒤에 부른다. 표가 문을 닫으면 제안이 서지 않고, 열면 노크의 조건이 선다.
 */
export function settleInterview(
  state: GameState,
  approach: Approach,
  stance: PressStance | null,
): CommandResult {
  const teamId = approach.teamId ?? "";
  const name = teamNameIn(state, teamId);
  const terms = stance === null ? "closed" : INTERVIEW_TERMS[stance];
  if (terms === "closed") {
    pushNarrative(state, `${name} 감독직 면접 결렬`, 4);
    return {
      ok: true,
      tone: "bad",
      message: `${name}는 제안 없이 자리를 닫았습니다 — 보드는 확신을 얻지 못했습니다`,
      brief: { head: "감독직 면접", items: [item({ label: name, text: "제안 없음" })] },
    };
  }

  const tier = tierOfTeamIn(state, teamId);
  const base = MANAGER_TERMS_BY_TIER[tier];
  const expectation = boardExpectation(state, teamId);
  /**
   * 지원한 쪽이라 연봉은 기본의 0.85배다 (`KNOCK_SALARY_RATE`) — 그 위에서만
   * `bold`가 흥정의 천장까지 올린다. 두 손잡이가 곱해지는 것이 아니라 순서대로 선다.
   */
  const reputation = (state.manager.reputation.board + state.manager.reputation.media) / 2;
  const lift = terms === "raised" ? 1 + counterHeadroom(reputation, tier) : 1;
  const salary = Math.round(base.salary * KNOCK_SALARY_RATE * lift);
  const budgetPledge = Math.round(base.budgetPledge * lift);
  const position = approach.contextCard?.value;
  /**
   * **재직 중에 두드린 자리면 보상금이 실린다** (career.md §5.1) — 감독이 먼저
   * 두드렸든 구단이 불렀든 옛 구단이 받는 돈은 같은 식이다(`managerSeveranceOf`).
   */
  const contract = state.manager.contract;
  const compensation = state.dismissal || !contract ? 0 : managerSeveranceOf(contract, state.date);

  state.managerOffers = [
    ...(state.managerOffers ?? []),
    {
      id: `mgr-offer-${teamId}-${state.date}`,
      teamId,
      madeOn: state.date,
      expiresOn: addDays(state.date, OFFER_DAYS),
      tier,
      ...(position === undefined ? {} : { position }),
      target: expectation.target,
      expectationCode: expectation.code,
      salary,
      years: base.years,
      budgetPledge,
      ...(compensation > 0 ? { compensation } : {}),
      via: "knock",
      // 미리 당겨 쓴 흥정은 되부를 기회를 남기지 않는다
      ...(terms === "raised" ? { counteredOn: state.date } : {}),
      status: "open",
    },
  ];
  pushNarrative(state, `${name} 감독직 제안 (면접)`, 5);
  return {
    ok: true,
    tone: "good",
    message:
      `${name}가 제안으로 답했습니다 — 기대는 ${boardExpectationText(expectation.code, expectation.target)},` +
      ` 연봉 ${formatMoney(salary)}·${base.years}년·이적 예산 약속 ${formatMoney(budgetPledge)}.` +
      (compensation > 0
        ? ` 수락하면 ${teamNameIn(state, state.userTeamId)}에 보상금 ${formatMoney(compensation)}를 뭅니다.`
        : "") +
      (terms === "raised"
        ? ` 자리에서 조건을 불렀으므로 흥정은 여기까지입니다 — 남은 것은 수락 여부입니다.`
        : ` 흥정은 한 차례 남아 있습니다.`) +
      ` ${OFFER_DAYS}일 안에 답해야 합니다`,
    brief: {
      head: "감독직 면접",
      items: [
        item({
          label: name,
          text: "제안",
          note: boardExpectationText(expectation.code, expectation.target),
        }),
        item({
          label: "연봉",
          text: formatMoney(salary),
          note: terms === "raised" ? `${base.years}년 · 천장까지` : `${base.years}년`,
        }),
        item({ label: "이적 예산 약속", text: formatMoney(budgetPledge) }),
        ...(compensation > 0
          ? [
              item({
                label: "보상금",
                text: formatMoney(compensation),
                note: `${teamShortNameIn(state, state.userTeamId)}로`,
              }),
            ]
          : []),
        item({ label: "흥정", text: terms === "raised" ? "소진" : "한 차례 남음" }),
      ],
    },
  };
}

/**
 * **노크 — 감독이 공석에 먼저 지원한다** (career.md §5.1).
 *
 * 공석 명부(`state.managerVacancies`)에 있는 구단만 두드릴 수 있고, 평판 문턱은
 * 제안과 같은 표(`OFFER_REPUTATION_GATE`)다. 확률이 없다 — 문은 열리거나 안
 * 열리거나다.
 *
 * **재직 중에도 열려 있다** (career.md §5.1 「재직 중 접근·노크」). 갈리는 것은
 * 대가다 — 문이 열린 그날 보드 평판이 `KNOCK_BOARD_HIT`만큼 깎이고, 그 사실이
 * 다음 회견에 `job-link` 카드로 선다 (`club/press.ts`).
 *
 * ⚠️ **문턱을 넘어도 제안이 서지는 않는다.** 그 자리에 서는 것은 **면접**이고,
 * 조건은 감독이 구단주의 물음에 어떻게 답하느냐가 정한다 (`settleInterview`).
 * 공석이 먼저 부르는 길(`offerVacancy`)만 그대로 제안이다 — 부른 쪽이 아쉽다.
 *
 * @param teamRef 구단 id 또는 이름·약칭
 */
export function applyForManagerJob(state: GameState, teamRef: string): CommandResult {
  const inPost = state.dismissal === undefined;
  if (openManagerOffers(state).length > 0) {
    return {
      ok: false,
      message: "열린 제안이 있는 동안에는 지원할 수 없습니다 — 답할 자리는 한 번에 하나입니다",
    };
  }
  /**
   * **감독 앞에 두 자리가 서지 않는다** ([people.md] §8). 무직에게 열릴 수 있는 자리는
   * 면접 하나지만 재직 중에는 선수도 구단주도 감독실 앞에 선다 — 그 자리를 두고 문을
   * 하나 더 열면 뒤에 선 쪽이 `pendingApproach`에 잡히지 않아 답 한 번 못 받고 사흘 뒤
   * 사라진다.
   */
  const sitting = pendingApproach(state);
  if (sitting) {
    return {
      ok: false,
      message:
        sitting.topic === "interview"
          ? `${teamNameIn(state, sitting.teamId ?? "")}와의 면접이 아직 열려 있습니다 — 답할 자리는 한 번에 하나입니다`
          : `감독실 앞에 아직 답을 기다리는 사람이 있습니다 — 답할 자리는 한 번에 하나입니다`,
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
  const since = spellStart(state);
  if (
    (state.managerOffers ?? []).some((o) => o.madeOn >= since && o.teamId === vacancy.teamId) ||
    interviewedSince(state, vacancy.teamId, since)
  ) {
    return {
      ok: false,
      message:
        `${teamNameIn(state, vacancy.teamId)}와는 이번 ${inPost ? "임기" : "무직 기간"}에` +
        ` 이미 이야기가 오갔습니다`,
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

  /**
   * 문이 열렸다 — **구단주가 마주 앉는다.** 제안이 아니라 자리다 (career.md §5.1).
   * 사실 카드를 결과에 실어 보내는 것은 이 턴에 GM이 그 장면을 쓸 수 있어야 하기
   * 때문이다: 스냅샷의 `<approach>`는 다음 턴에야 선다.
   */
  const approach = openInterview(state, vacancy);
  const owner = generateOwner(state.seed, vacancy.teamId);
  const line = approachContextText(approach.contextCard!, {
    subject: teamNameIn(state, vacancy.teamId),
  });
  /**
   * **재직 중의 노크는 언론에 새는 사실이다** (career.md §5.1). 자리가 선 그날
   * 보드가 그것을 알고, 다음 회견의 `job-link` 카드가 같은 사실을 읽는다 —
   * 두드렸으나 문이 안 열린 자리는 기록이 남지 않으므로 대가도 없다.
   */
  if (inPost) {
    const manager = state.manager;
    manager.reputation.board = clampReputation(manager.reputation.board - KNOCK_BOARD_HIT);
    pushNarrative(state, `${teamNameIn(state, vacancy.teamId)} 감독직 지원 — 재직 중`, 5);
  }
  return {
    ok: true,
    tone: "good",
    message:
      `${teamNameIn(state, vacancy.teamId)}가 면접 자리를 열었습니다 —` +
      ` ${owner.name}(${APPROACH_CHANNEL_LABEL.owner})이(가) 마주 앉습니다 (${line}).` +
      ` 감독의 답이 제안 조건을 정하고, ${APPROACH_PATIENCE_DAYS}일 안에 답하지 않으면 자리는 닫힙니다` +
      (inPost
        ? `. 재직 중에 두드린 자리라 보드가 알게 됐습니다 (보드 평판 −${KNOCK_BOARD_HIT}) — 기자도 곧 묻습니다`
        : ""),
    brief: {
      head: "감독직 면접",
      items: [
        item({ label: teamNameIn(state, vacancy.teamId), text: owner.name, note: line }),
        ...approach.facts.map((f) =>
          item({ label: INTERVIEW_FACT_KO[f.kind] ?? "보드", text: pressFactText(f) }),
        ),
        ...(inPost
          ? [item({ label: "보드 평판", text: `−${KNOCK_BOARD_HIT}`, delta: -KNOCK_BOARD_HIT })]
          : []),
      ],
    },
  };
}
