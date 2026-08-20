import { topLeagues } from "../data/league-catalog";
import { leagueOfTeamIn, leagueSizeIn } from "../competition/promotion";
import { tierOfTeamIn } from "../core/club-tier";
import { positionAt, relegationLine } from "../core/league-shape";
import { inventPersonName } from "../world/persona";
import { makeRng, randInt } from "../core/rng";
import { addDays } from "../core/dates";
import { boardExpectation, computeStandings, type StandingRow } from "../competition/season";
import { syncDefaultTraining } from "../squad/training-plan";
import {
  AI_MANAGER_RATING_FALLBACK,
  clampCondition,
  type GameTeam,
  type ManagerOffer,
} from "@story-fm/domain";
import {
  playersOf,
  pushNarrative,
  teamName,
  teamNameIn,
  teamShortName,
  teamShortNameIn,
  type GameState,
} from "../core/state";
import type { SkillResult } from "../skills";

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
 * 이만큼 무직이었는데 아직 한 번도 부른 곳이 없으면 다음 문턱을 넘는 자리는
 * 확률을 건너뛴다 — 세이브가 무직으로 굳지 않게 하는 안전판이다 (career.md §5.1).
 */
const OFFER_DRY_SPELL_DAYS = 120;

/** 감독 팀의 경고 단계 — 이 횟수를 넘기면 경질된다 */
export const USER_WARNINGS_BEFORE_SACK = 3;
/**
 * 감독이 잘리는 순위 — **AI보다 훨씬 아래**다. 강등권에서도 아래 두 자리,
 * 곧 20팀 리그면 19·20위이고 18팀 리그면 17·18위다.
 *
 * 같은 문턱을 쓰면 우승 경쟁이 기대인 구단에서 10위만 해도 시즌 중에 자리가
 * 없어진다. 그건 규칙이라기보다 사고다 — 아직 **새 구단에 부임하는 길이 없어서**
 * 경질은 곧 세이브의 끝이다. 그래서 감독은 경고를 세 번 받고, 보드 신뢰가 바닥이고,
 * 그러고도 그 두 자리에 있을 때만 잘린다. 라이벌 구단이 12위에서 감독을 바꾸는
 * 것과는 다른 잣대인데, 그 비대칭은 의도한 것이다: 세계는 감독의 이야기를 위해
 * 돈다. (새 구단 부임이 생기면 이 문턱은 AI와 같아져야 한다.)
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
  return Math.max(0, Math.round((Date.parse(state.date) - Date.parse(since)) / 86_400_000));
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
  team.managerName = inventPersonName(rng, team.id);
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
    digest.push(`💼 ${teamShortNameIn(state, offer.teamId)}의 감독직 제안이 만료됐다`);
  }
}

/**
 * 공석이 된 구단이 무직 감독을 부른다 (career.md §5.1).
 *
 * @returns 오늘 제안이 붙었으면 true
 */
function offerVacancy(
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
  // 한 번 부른 구단은 다시 부르지 않는다 — 만료·수락한 기록이 남는 이유다
  if (offers.some((o) => o.teamId === teamId)) return false;

  const tier = tierOfTeamIn(state, teamId);
  const gate = OFFER_REPUTATION_GATE[tier];
  const reputation = (state.manager.reputation.board + state.manager.reputation.media) / 2;
  if (gate !== undefined && reputation < gate) return false;

  const dry = offers.length === 0 && daysBetween(dismissal.on, state.date) >= OFFER_DRY_SPELL_DAYS;
  // 구단·날짜마다 채널을 갈라 뽑는다 — AI 경질의 난수열을 흔들지 않는다
  const rng = makeRng(state.seed, `manager-offer:${state.date}:${teamId}`);
  if (!dry && rng() > OFFER_CHANCE) return false;

  const expectation = boardExpectation(state, teamId);
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
      expectation: expectation.label,
      status: "open",
    },
  ];
  digest.push(
    `💼 ${teamShortNameIn(state, teamId)}가 감독직을 제안했다 — 기대는 ${expectation.label}` +
      ` · ${OFFER_DAYS}일 안에 답해야 한다`,
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
  if (manager.lastWarnedOn && daysBetween(manager.lastWarnedOn, state.date) < 30) return false;

  const board = manager.reputation.board;
  // 경고 수는 마지막 단계에서 멈춘다 — 4/3은 화면이 그릴 수 없는 숫자다.
  // 평판 압박은 계속 걸린다(그게 마지막 경고를 마지막이게 하는 힘이다) (career.md §5)
  const next = Math.min(warnings + 1, USER_WARNINGS_BEFORE_SACK);
  manager.lastWarnedOn = state.date;

  const sackable = standing.position >= userSackBottom(leagueSizeIn(state, state.userTeamId));
  const expectation = boardExpectation(state, state.userTeamId);
  if (next < USER_WARNINGS_BEFORE_SACK || !sackable || board > USER_BOARD_FLOOR) {
    manager.boardWarnings = next;
    manager.reputation.board = Math.max(0, board - 6);
    digest.push(
      `⚠️ 보드가 성적을 문제 삼았다 — 기대는 ${expectation.label}인데 현재 ${standing.position}위다` +
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
  state.dismissal = {
    on: state.date,
    season: state.season,
    teamId: sackedTeamId,
    tier: tierOfTeamIn(state, sackedTeamId),
    position: standing.position,
    target: expectation.target,
    expectation: expectation.label,
  };

  // 감독이 없는 구단은 세계에 없다 — 옛 구단은 그날로 후임을 세운다
  const team = state.teams.find((t) => t.id === sackedTeamId);
  if (team) installNewManager(state, team, makeRng(state.seed, `user-sacked:${state.date}`));

  /**
   * **진행 중이던 협상은 전부 사라진다** — 감독이 없는 구단의 흥정이고, 무직인
   * 감독이 남의 구단 선수를 계속 흥정할 수는 없다 (career.md §5.1).
   */
  for (const negotiation of state.negotiations) {
    if (negotiation.status === "open" || negotiation.status === "agreed") {
      negotiation.status = "expired";
    }
  }

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
 * **제안을 받아들인다 — 그날부로 부임한다** (career.md §5.1).
 *
 * 시즌 중이어도 막지 않는다. 순위표는 감독이 아니라 구단 단위라 부임 전 경기까지
 * 포함한 성적이 그 시즌의 기록이 된다 — 그것이 감독이 물려받는 것이다.
 *
 * @param ref 제안 id 또는 구단 이름·약칭
 */
export function acceptManagerOffer(state: GameState, ref: string): SkillResult {
  if (!state.dismissal) {
    return { ok: false, message: `${teamNameIn(state, state.userTeamId)} 감독으로 재직 중입니다` };
  }
  const offer = (state.managerOffers ?? []).find((o) => offerMatches(state, o, ref));
  if (!offer) return { ok: false, message: `"${ref}"에 해당하는 감독직 제안이 없습니다` };
  if (offer.status !== "open" || offer.expiresOn < state.date) {
    return {
      ok: false,
      message: `${teamNameIn(state, offer.teamId)}의 제안은 ${offer.expiresOn}에 만료됐습니다`,
    };
  }

  offer.status = "accepted";
  const team = state.teams.find((t) => t.id === offer.teamId);
  state.userTeamId = offer.teamId;
  if (team) {
    team.managerName = state.manager.name;
    team.managerSince = state.date;
  }
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
  // 기본 훈련은 새 선수단으로 다시 깔린다
  syncDefaultTraining(state);

  const name = teamNameIn(state, offer.teamId);
  pushNarrative(state, `${name} 부임`, 5);
  return {
    ok: true,
    message:
      `${name} 감독으로 부임했습니다 (${state.date}) — 보드의 기대는 ${offer.expectation},` +
      ` 지금 순위는 ${offer.position ?? "-"}위입니다`,
    tone: "good",
  };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}
