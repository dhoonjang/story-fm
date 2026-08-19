import type { MatchRecord, MatchStage } from "@story-fm/domain";
import {
  MIN_REST_HOURS,
  HARD_MIN_REST_HOURS,
  addDays,
  cupBlankWeekend,
  dayOfWeek,
  firstCupRoundFloor,
  restHours,
  seasonDate,
  snapToWeekday,
  sortEntries,
  tooClose,
} from "./calendar";
import {
  domesticCupCatalog,
  DOMESTIC_CUP_SIZE,
  DOMESTIC_STAGES,
  domesticCupById,
  domesticCupsOfCountry,
  domesticStageLabel,
  type DomesticCupEntry,
} from "../data/domestic-cup-catalog";
import { leagueCatalogById, topLeagueOfCountry } from "../data/league-catalog";
import { completeDraw, drawEntryOf, drawIsDue, drawRefId, scheduleDraw } from "./draw-schedule";
import { clubsOfCountry, leagueOfTeam } from "../data/team-catalog";
import { tierOfTeamIn } from "../core/club-tier";
import { isTopFlightIn } from "./promotion";
import { reservedEuroDatesFor } from "./euro-knockout";
import { formatMoney, payOnce } from "../club/finance";
import { clearForCup } from "./reschedule";
import { makeRng } from "../core/rng";
import { needsShootout, pairOf, resolveExtraTime, settledTieWinner } from "./extra-time";
import { resolveShootout } from "./shootout";
import { pushNarrative, teamName, teamShortName, type GameState } from "../core/state";

/**
 * 국내 컵 — FA컵·리그컵·코파 델 레이·코파 이탈리아·DFB-포칼·쿠프 드 프랑스.
 *
 * 대항전 녹아웃(euro-knockout.ts)과 같은 **진행형 상태 기계**지만 셋이 다르다:
 *
 * ① **순위표가 없다.** 리그 페이즈 없이 32강부터 바로 녹아웃이다.
 * ② **날짜가 고정이 아니다.** 대항전은 UEFA가 주중을 예약해 두고 리그가 비켜
 *    가지만, 국내 컵은 리그·대항전이 이미 채운 달력의 **틈**으로 들어가야 한다.
 *    그래서 목표 시기(`windows`)에서 시작해 두 팀 모두 쉴 수 있는 첫 날을 찾는다.
 * ③ **추첨이 사건이다.** 대진은 라운드가 끝나는 순간이 아니라 **추첨일에** 나오고,
 *    그 날짜는 직전 라운드 마지막 경기에서 정해져 몇 주 전부터 달력에 오른다.
 *
 * 실제 대회를 조사해 반영한 규정 셋 (자세한 근거는 카탈로그 주석):
 * - **추첨 방식이 두 갈래다.** FA컵·리그컵·코파·포칼·쿠프는 라운드마다 새로 뽑고,
 *   코파 이탈리아만 시즌 초에 대진표(tabellone) 전체가 확정된다.
 * - **추첨 시점도 다르다.** FA컵·리그컵은 직전 라운드 **마지막 경기 직후** 그
 *   자리에서 뽑고(TV 생중계), 포칼은 며칠 뒤에 뽑는다 (`drawDelayDays`).
 * - **홈 배정 규정도 다르다.** 포칼·코파·쿠프는 **하부 클럽이 홈**(규정),
 *   코파 이탈리아는 **시드 클럽이 홈**, FA컵·리그컵은 **먼저 뽑힌 팀이 홈**.
 */

/**
 * 빈 날 찾기 — 앞뒤로 하루씩 쉬는 자리는 **가까운 데서만** 찾는다.
 *
 * 넉넉한 창으로 완벽한 휴식을 고집하면 라운드가 3주에 걸쳐 흩어진다(한 팀이
 * 대항전 주중까지 뛰면 2월엔 그런 날이 거의 없다). 실제 컵도 혼잡한 팀은 붙여
 * 치른다 — 가까이서 못 찾으면 휴식 조건을 한 단계씩 푸는 편이 라운드를 뭉친다.
 */
const REST_SEARCH_DAYS = 10;
const SEARCH_WINDOW_DAYS = 28;
/** 결승만 창이 넓다 — 리그가 끝난 뒤 주말까지 밀어도 된다 (실제로도 그렇게 열린다) */
const FINAL_SEARCH_DAYS = 42;
/** 다만 넓은 창은 **나중**이다 — 결승도 목표 주말 언저리(두 주)를 먼저 훑는다 */
const FINAL_NEAR_DAYS = 14;
/** 최후 방어의 창 — 겹치지 않는 날은 이 안에 반드시 있다 (한 팀의 연간 경기는 60여 회) */
const LAST_RESORT_DAYS = 150;

/**
 * 리그를 비켜세워서라도 지키는 목표 구간 — 목표일부터 이만큼.
 * 실제 대회도 라운드를 하루이틀 안에서 조정하지 몇 주씩 옮기지는 않는다.
 */
const TARGET_HOLD_DAYS = 3;

/** 컵 경기가 설 수 있는 요일 — 주중 화·수, 주말 토·일 (실제 컵 라운드의 자리) */
const CUP_WEEKDAYS = new Set([2, 3, 6, 0]);

/**
 * 결승은 **주말에만** 선다 — 웸블리·베를린·라 카르투하·스타드 드 프랑스,
 * 실제 결승이 예외 없이 토·일이다. 목표 주말이 리그와 겹치면 다음 주말로 밀 뿐,
 * 화요일 결승 같은 건 만들지 않는다.
 *
 * **코파 이탈리아만 예외** — 로마 올림피코 결승은 실제로 수요일 밤이다
 * (`finalMidweek`). 리그가 주말을 채운 5월에 결승을 세울 자리도 거기뿐이다.
 */
const FINAL_WEEKDAYS = new Set([6, 0]);
const FINAL_MIDWEEK_WEEKDAYS = new Set([2, 3]);

function finalWeekdaysOf(cup: DomesticCupEntry): Set<number> {
  return cup.finalMidweek ? FINAL_MIDWEEK_WEEKDAYS : FINAL_WEEKDAYS;
}

/**
 * 라운드를 이틀에 걸쳐 흩는다 — 실제 컵도 16경기를 하루에 몰지 않는다
 * (FA컵 3라운드는 토·일, 리그컵 라운드는 화·수 이틀에 나뉜다).
 *
 * 대진이 적은 단계(8강·준결승)는 같은 날 치르는 편이 자연스러워 그대로 둔다.
 * 갈라진 절반이 **어느 날로** 가는지는 `stageTieTarget`이 정한다.
 */
function spreadOffset(pair: number, pairCount: number): number {
  if (pairCount < 4) return 0;
  return pair < Math.ceil(pairCount / 2) ? 0 : -1;
}

/** 2차전제 2차전 — 1차전에서 이만큼 뒤부터 자리를 찾는다 */
const SECOND_LEG_GAP_DAYS = 14;

/** 녹아웃 경기 id — 단계·대진 번호·차수를 박아 브래킷 순서를 잃지 않는다 */
function tieId(cupId: string, season: number, stage: MatchStage, pair: number, leg: number) {
  return `m-${cupId}-${season}-${stage}-p${pair}-l${leg}`;
}

/** 이 컵 이 단계의 경기 — 대진 번호, 그다음 차수 순 */
export function domesticStageMatches(
  state: GameState,
  cupId: string,
  stage: MatchStage,
): MatchRecord[] {
  return state.matches
    .filter((m) => m.season === state.season && m.competitionId === cupId && m.stage === stage)
    .sort((a, b) => pairOf(a) - pairOf(b) || a.round - b.round);
}

/** 이 컵의 참가 클럽 — 그 나라 1부 + 2부 전체 (카탈로그가 32팀으로 맞춰져 있다) */
export function domesticCupEntrants(cupId: string): string[] {
  const cup = domesticCupById(cupId);
  if (!cup) return [];
  return clubsOfCountry(cup.country).map((t) => t.id);
}

/** 이 팀이 이번 시즌 나가는 국내 컵 — 명성 순 (잉글랜드는 FA컵 → 리그컵) */
export function domesticCupsOf(teamId: string): DomesticCupEntry[] {
  const country = leagueCatalogById(leagueOfTeam(teamId))?.country;
  return country ? domesticCupsOfCountry(country) : [];
}

/**
 * 이 단계의 목표 날짜 — 시즌 해를 붙인 실제 대회 일정 골격.
 *
 * ⚠️ **결승만 요일을 그 시즌에 맞춘다.** 카탈로그의 값은 고정 월·일이라 해가 바뀌면
 * 요일이 밀리는데, 결승은 서는 요일이 둘뿐이라(토·일) 그 밀림이 치명적이다 — 쿠프
 * 결승 5/22는 2027년엔 토요일이지만 2028년엔 월요일이고, 그때 앞으로만 훑으면
 * 리그 최종 라운드와 대항전 결승이 막고 선 5월 말을 지나 **6월로 넘어간다**
 * (실측: 쿠프·포칼 결승이 6/10에 앉아 시즌 밖으로 밀려났다).
 *
 * 다른 라운드는 설 수 있는 요일이 넷이라(화·수·토·일) 앞으로 하루이틀만 훑으면
 * 자리가 나온다 — 굳이 당기지 않는다.
 *
 * ⚠️ **달력이 비워 준 라운드만 예외다** (`cupBlankWeekend`). 달력은 그 라운드의
 * 목표일이 걸리는 주말을 통째로 비우는데, 여기서 원 날짜를 그대로 내주면 비운
 * 주말은 아무 경기 없이 지나가고 라운드는 주중으로 간다. 그 라운드의 목표는
 * **비운 주말의 토요일**이다 (competition.md §3.4).
 *
 * ⚠️ **1라운드만 바닥이 있다** (`firstCupRoundFloor`) — 개막 주말보다 이른 목표일은
 * 개막 라운드 뒤로 밀린다. 코파 이탈리아 1라운드(8/16)·포칼 1라운드(8/18)가 개막
 * 주말에 걸려 세리에 A·분데스리가의 개막 라운드를 통째로 밀어낸 자리다 (season.md §3).
 */
export function stageTarget(season: number, cup: DomesticCupEntry, stage: MatchStage): string {
  const target = seasonDate(season, cup.windows[stage]);
  if (stage === "final") return snapToWeekday(target, finalWeekdaysOf(cup));
  // 1라운드는 개막 라운드 뒤다 — 고정 월·일은 개막 토요일의 흔들림을 모른다
  const floor = stage === DOMESTIC_STAGES[0] ? firstCupRoundFloor(season) : null;
  // 달력이 이 라운드를 위해 비운 주말이 있으면 **그 토요일이 목표다** — 목표일보다
  // 앞이든 뒤든(1/10이 화요일이면 비운 주말은 그 앞이다). 다만 바닥보다 이른
  // 주말은 개막 라운드의 것이라 쓸 수 없다.
  const blank = cupBlankWeekend(season, cup, stage);
  if (blank !== null && (floor === null || blank >= floor)) return blank;
  return floor !== null && target < floor ? floor : target;
}

/**
 * 이 대진이 자리를 찾기 시작하는 날 — 라운드를 이틀에 흩은 결과다.
 *
 * 달력이 비운 주말에 앉은 라운드는 **그 주말 안에서** 흩는다(토 → 일) — 이틀 다
 * 리그가 비켜선 자리다.
 *
 * 그 밖의 라운드는 목표일의 **하루 앞의 컵 요일**부터 찾는다. 하루 뒤로 미루면 그
 * 자리가 막혔을 때 계속 뒤로 밀려 라운드가 열흘 넘게 늘어졌다. 그냥 하루만 당기면
 * 그 날이 컵 요일이 아닐 때(수요일 목표 → 화요일은 되지만, 화요일 목표 → 월요일은
 * 안 된다) 앞으로 훑다가 결국 같은 날에 앉아 라운드가 하루에 몰린다.
 */
export function stageTieTarget(
  season: number,
  cup: DomesticCupEntry,
  stage: MatchStage,
  pair: number,
  pairCount: number,
): string {
  const base = stageTarget(season, cup, stage);
  if (stage === "final" || spreadOffset(pair, pairCount) === 0) return base;
  if (cupBlankWeekend(season, cup, stage) === base) return addDays(base, 1);
  for (let i = 1; i <= 3; i++) {
    const back = addDays(base, -i);
    if (CUP_WEEKDAYS.has(dayOfWeek(back))) return back;
  }
  return base;
}

/** 이 대회의 결승이 설 수 있는 요일 (0=일) — 규정이자 편성의 제약 */
export function finalWeekdays(cup: DomesticCupEntry): number[] {
  return [...finalWeekdaysOf(cup)];
}

/** 이 팀이 이 컵에서 아직 살아 있는가 — 추첨을 감독의 달력에 올릴지 정한다 */
export function userStillIn(state: GameState, cupId: string): boolean {
  let latest: MatchStage | null = null;
  for (const stage of DOMESTIC_STAGES) {
    if (domesticStageMatches(state, cupId, stage).length > 0) latest = stage;
  }
  if (latest === null) return true; // 아직 시작 전 — 전 클럽이 나간다
  const matches = domesticStageMatches(state, cupId, latest);
  const ours = matches.find(
    (m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId,
  );
  if (!ours) return false; // 이 라운드에 우리가 없다 = 이미 떨어졌다
  const winner = domesticTieWinner(state, cupId, latest, pairOf(ours));
  return winner === null || winner === state.userTeamId;
}

/**
 * 전력 서열 — 작을수록 강하다. 1부가 2부보다 앞서고, 같은 부에선 tier 순.
 * 홈 배정 규정(`homeRule`)의 기준이다. 둘 다 **지금** 값이라 강등한 클럽은 그
 * 시즌 컵에서 하부 클럽으로 셈해진다.
 */
function rankOf(state: GameState, teamId: string): number {
  return (isTopFlightIn(state, teamId) ? 0 : 10) + tierOfTeamIn(state, teamId);
}

/**
 * 대진 하나의 경기일.
 *
 * **① 실제 대회 날짜를 먼저 차지한다.** 목표일(그리고 흩기 오프셋) 근처에서 걸리는
 * 것이 리그 경기뿐이면 그 리그 경기를 연기시키고 제 자리를 지킨다 — 실제 리그가
 * "컵 진출로 인한 연기"를 하는 방식이다 (`clearForCup`).
 * **② 그게 안 되면** 목표일부터 앞으로 훑어 빈 날을 찾는다. 조건을 단계적으로 푼다:
 * 앞뒤 휴식 → 앞쪽 휴식 → 같은 날만 비면 됨 → 요일까지 풀고 겹치지 않는 날.
 */
function pickTieDate(
  state: GameState,
  home: string,
  away: string,
  from: string,
  options: { weekdays?: Set<number>; isFinal?: boolean; digest?: string[] } = {},
): { date: string; time: string } {
  const weekdays = options.weekdays ?? CUP_WEEKDAYS;
  const teams = [home, away];
  /**
   * 두 팀이 이미 잡아 둔 자리.
   *  - 편성된 경기는 **킥오프 시각까지** 안다 → 48시간 규칙으로 잰다.
   *  - 예약된 대항전 날짜는 시각을 모른다 → 그날 하루를 통째로 막는다(보수적으로).
   */
  const commitments = () => {
    const played: Array<{ date: string; time?: string }> = [];
    for (const m of state.matches) {
      if (m.season !== state.season) continue;
      if (m.homeTeamId === home || m.awayTeamId === home) played.push(m);
      else if (m.homeTeamId === away || m.awayTeamId === away) played.push(m);
    }
    const blocked = new Set<string>();
    for (const teamId of teams) {
      for (const d of reservedEuroDatesFor(state, teamId)) blocked.add(d);
    }
    return { played, blocked };
  };
  let busy = commitments();
  /** 그날 아무 경기도 없나 (같은 날 두 경기는 시즌을 멈춘다) */
  const free = (date: string) =>
    !busy.played.some((m) => m.date === date) && !busy.blocked.has(date);
  /** 48시간 휴식이 지켜지나 — 예약 대항전 날짜는 앞뒤 하루까지 본다 */
  const rested = (date: string, time: string) =>
    !busy.played.some((m) => tooClose(m, { date, time })) &&
    ![-1, 0, 1].some((o) => busy.blocked.has(addDays(date, o)));
  /** 아직 대진이 없는 예약 대항전 날짜 **바로 옆**인가 */
  const nearReserved = (date: string) => [-1, 1].some((o) => busy.blocked.has(addDays(date, o)));
  /**
   * 40시간 바닥(`HARD_MIN_REST_HOURS`)은 지켜지나 — 아래 사다리가 조건을 풀며
   * 내려갈 때 **`free`로 곧장 떨어지지 않게 붙잡는 단**이다. `free`는 "그날만
   * 겹치지 않으면 된다"라서, 토요일 저녁 리그 **다음 날** 낮에 컵을 앉힌다.
   *
   * ⚠️ **예약된 대항전 날짜도 바닥을 만든다.** 그 녹아웃은 아직 뽑히지 않아 장부에
   * 없지만 날짜는 이미 UEFA의 것이고, 그 밤 경기(18:45·21:00) 앞뒤 하루는 어떤
   * 킥오프를 잡아도 25시간 안쪽이다. 장부만 보고 "40시간을 지켰다"고 앉힌 자리가
   * 나중에 25시간이 됐다 — 코파 이탈리아 8강 화요일 19:45, 다음 날 UCL 플레이오프
   * 21:00 (시드 23·42).
   */
  const restedHard = (date: string, time: string) =>
    !busy.played.some((m) => restHours(m, { date, time }) < HARD_MIN_REST_HOURS) &&
    !nearReserved(date);

  // ① 목표 자리를 지키기 위해 리그를 비켜세운다 (컵이 밀리기 전에 먼저 시도)
  const target = from > state.date ? from : addDays(state.date, 1);
  for (let i = 0; i <= TARGET_HOLD_DAYS; i++) {
    const date = addDays(target, i);
    if (!weekdays.has(dayOfWeek(date))) continue;
    if (rested(date, kickoffFor(date))) break; // 이미 비어 있다 — 아무도 옮길 필요가 없다
    if (clearForCup(state, teams, date, options.digest ?? [], kickoffFor(date))) {
      busy = commitments(); // 리그가 비켜났으니 다시 읽는다
      // 비켜세우고도 48시간이 안 나오면(옮길 수 없는 대항전이 옆에 있다) 계속 찾는다
      if (rested(date, kickoffFor(date))) break;
    }
  }
  // 결승은 휴식을 넓게 찾는다 — 리그 최종전 **전날** 웸블리에 서지 않도록,
  // 리그가 끝난 뒤 주말까지 밀 수 있게 창을 크게 잡는다.
  // 결승도 **가까운 창을 먼저** 본다. 42일로 시작하면 5월 16일 웸블리가 6월 12일로
  // 밀린다 — 휴식이 완벽한 날을 찾아 대회를 통째로 옮긴 셈이다. 두 주면 다음
  // 주말까지 미룰 수 있고, 그래도 안 되면 아래에서 창이 42일로 넓어진다.
  const restWindow = options.isFinal ? FINAL_NEAR_DAYS : REST_SEARCH_DAYS;
  const window = options.isFinal ? FINAL_SEARCH_DAYS : SEARCH_WINDOW_DAYS;
  /**
   * 이 날에 앉으면 어떤가 — 두 값으로 잰다.
   *
   * `rest`는 **실제로 편성된 경기**와의 최소 간격(시간)이고, `nearReserved`는 아직
   * 대진이 없는 예약 대항전 날짜 옆인지다. 둘을 하나로 합치면 안 된다 — 예약일을
   * "24시간짜리 경기"로 세면 1·2월엔 거의 모든 후보가 24로 눌려 동점이 되고,
   * 그러면 가장 이른 날이 뽑혀 **하필 UCL 전날**에 컵이 앉는다 (실제로 그랬다).
   */
  const scoreAt = (date: string) => {
    const slot = { date, time: kickoffFor(date) };
    let rest = Number.POSITIVE_INFINITY;
    for (const m of busy.played) rest = Math.min(rest, restHours(m, slot));
    return { rest, nearReserved: nearReserved(date) };
  };
  /** 왼쪽이 더 나은 자리인가 — 실제 휴식이 먼저, 같으면 예약일에서 먼 쪽 */
  const better = (a: ReturnType<typeof scoreAt>, b: ReturnType<typeof scoreAt> | null) =>
    b === null || a.rest > b.rest || (a.rest === b.rest && !a.nearReserved && b.nearReserved);

  interface Pass {
    days: number;
    weekdays: Set<number> | null;
    ok: (d: string) => boolean;
    /** 첫 자리를 잡지 말고 창 전체에서 **가장 덜 나쁜** 자리를 고른다 */
    best?: boolean;
  }
  /**
   * 자리 찾기의 순서 — **대회 날짜를 먼저, 휴식은 그다음**.
   *
   * 휴식을 우선하면 컵이 제 날짜를 잃는다. 실제로 그랬다: FA컵 준결승 두 대진이
   * 4월 25일과 **5월 19일**로 갈라졌다 — 48시간이 나오는 날을 찾아 한 달을 민 것이다.
   * 실제 협회는 정반대로 움직인다. 준결승 주말은 고정이고, 붙는 리그 경기를 옮긴다.
   *
   * 그래서 **가까운 창(10일)을 먼저 다 훑고** — 완벽한 휴식 → 가장 긴 휴식 순으로 —
   * 그래도 없을 때만 창을 넓힌다.
   */
  const passes: Pass[] = [
    // ① 가까이서 48시간이 나오는 자리
    { days: restWindow, weekdays, ok: (d) => rested(d, kickoffFor(d)) },
    // ② 가까이서 **가장 긴 휴식**. 첫 빈 날을 덥석 잡으면 UCL 전날에 컵이 앉는다 —
    //    같은 창 안에 이틀 뒤 자리가 있는데도. 예약된 대항전 날짜 옆은 `restedHard`가
    //    막는다: 그 녹아웃은 **나중에** 편성되므로 지금 장부에는 없다.
    {
      days: restWindow,
      weekdays,
      ok: (d) => free(d) && restedHard(d, kickoffFor(d)),
      best: true,
    },
    // ③ 그래도 없으면 창을 넓힌다 (예전엔 여기서 "직전 하루만 쉬면 된다"로 조건을
    //    풀어 버려서 컵 다음날 리그가 섰다 — 창을 넓힐지언정 조건은 안 푼다)
    { days: window, weekdays, ok: (d) => rested(d, kickoffFor(d)) },
    { days: window, weekdays, ok: (d) => free(d) && restedHard(d, kickoffFor(d)), best: true },
    // ④ **40시간 바닥은 창보다 앞선다.** 여기까지 왔다는 건 28일 안에 바닥을 지키는
    //    자리가 없다는 뜻이다. 그때는 라운드가 늘어지는 것보다 연이틀 경기가 나쁘므로
    //    창을 끝까지, 요일까지 풀어서 바닥을 지키는 자리를 먼저 찾는다.
    //    ⚠️ 여기서는 `best`를 쓰지 않는다 — 최대 휴식을 고르면 창 끝의 한산한 날이
    //    이겨 라운드가 몇 주씩 갈라진다. 바닥만 지키면 되므로 **가장 이른 자리**다.
    { days: LAST_RESORT_DAYS, weekdays, ok: (d) => free(d) && restedHard(d, kickoffFor(d)) },
    {
      days: LAST_RESORT_DAYS,
      weekdays: null,
      ok: (d) => free(d) && restedHard(d, kickoffFor(d)),
    },
    // ⑤ 최후 방어 — 바닥까지 내준다. **같은 날만 아니면 된다.**
    //    같은 날 두 경기는 tick이 그중 하나를 영원히 남겨 시즌을 멈춘다
    //    (FA컵 결승이 UCL 결승과 같은 날 잡혀 실제로 그렇게 멈춘 적이 있다).
    //    24시간은 빡빡한 것이고 0시간은 멈추는 것이라, 여기서만 바닥을 포기한다.
    { days: window, weekdays, ok: (d) => free(d) && !nearReserved(d), best: true },
    { days: window, weekdays, ok: free, best: true },
    { days: LAST_RESORT_DAYS, weekdays: null, ok: free },
  ];

  // ② 그래도 걸리면 뒤로 밀어 자리를 찾는다.
  // (목표일이 이미 지난 세이브는 내일부터 — 과거 날짜 경기는 tick이 소화하지 못한다)
  const start = target;
  for (const pass of passes) {
    let picked: string | null = null;
    let pickedScore: ReturnType<typeof scoreAt> | null = null;
    for (let i = 0; i <= pass.days; i++) {
      const date = addDays(start, i);
      if (pass.weekdays && !pass.weekdays.has(dayOfWeek(date))) continue;
      if (!pass.ok(date)) continue;
      if (!pass.best) return { date, time: kickoffFor(date) };
      // 목표일에 가까운 쪽이 먼저 오므로, 같은 점수면 앞선 날이 이긴다
      const score = scoreAt(date);
      if (better(score, pickedScore)) {
        picked = date;
        pickedScore = score;
      }
    }
    if (picked) {
      // 결승은 가까운 창에서 휴식이 모자란 자리를 찾았다고 곧장 확정하지 않는다.
      // 다음 넓은 창에는 리그 최종전 뒤의 온전한 주말이 있을 수 있다. 여기서
      // 확정하면 결승 다음 날 최종 라운드를 치르는 대진이 결과에 따라 생긴다.
      if (
        options.isFinal &&
        pass.days === restWindow &&
        pickedScore !== null &&
        pickedScore.rest < MIN_REST_HOURS
      ) {
        continue;
      }
      // 휴식이 모자란 자리밖에 없으면 **리그를 한 번 더 비켜세워** 본다.
      // 실제 리그가 하는 일이고(컵 진출로 인한 연기), 성공하면 48시간이 살아난다.
      if (scoreAt(picked).rest < MIN_REST_HOURS) {
        if (clearForCup(state, teams, picked, options.digest ?? [], kickoffFor(picked))) {
          busy = commitments();
        }
      }
      return { date: picked, time: kickoffFor(picked) };
    }
  }
  return { date: start, time: kickoffFor(start) };
}

/** 주말은 오후, 주중은 야간 — 실제 컵 라운드의 킥오프 */
function kickoffFor(date: string): string {
  const dow = dayOfWeek(date);
  return dow === 0 || dow === 6 ? "15:00" : "19:45";
}

/** 감독의 달력에 우리 팀 컵 경기를 올린다 (남의 컵 경기는 장부에만 남는다) */
function registerUserEntries(state: GameState, matches: MatchRecord[]): void {
  const ours = matches.filter(
    (m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId,
  );
  if (ours.length === 0) return;
  for (const m of ours) {
    state.schedule.push({
      id: `se-${m.id}`,
      date: m.date,
      time: m.time ?? "19:45",
      type: "match",
      refId: m.id,
      teamId: state.userTeamId,
      status: "scheduled",
    });
  }
  state.schedule = sortEntries(state.schedule);
}

/**
 * 홈 배정 — 대회 규정을 따른다 (`homeRule`).
 * `a`는 추첨에서 먼저 뽑힌 팀이고, 결승은 중립이라 이 함수를 타지 않는다.
 */
function homeSideOf(state: GameState, cup: DomesticCupEntry, a: string, b: string): string {
  if (cup.homeRule === "draw") return a; // 먼저 뽑힌 팀 (FA컵·리그컵)
  const diff = rankOf(state, a) - rankOf(state, b);
  if (diff === 0) return a; // 서열이 같으면 추첨 순서대로
  const underdog = diff > 0 ? a : b;
  const seeded = diff > 0 ? b : a;
  return cup.homeRule === "underdog" ? underdog : seeded;
}

/** 대진 하나를 경기로 만든다 (결승은 중립 단판) */
function createTie(
  state: GameState,
  cup: DomesticCupEntry,
  stage: MatchStage,
  pair: number,
  pairCount: number,
  a: string,
  b: string,
  digest: string[],
): MatchRecord[] {
  const isFinal = stage === "final";
  const home = isFinal ? a : homeSideOf(state, cup, a, b);
  const away = home === a ? b : a;
  const twoLegged = cup.twoLegged.includes(stage) && !isFinal;
  const weekdays = isFinal ? finalWeekdaysOf(cup) : CUP_WEEKDAYS;
  const target = stageTieTarget(state.season, cup, stage, pair, pairCount);

  const first = pickTieDate(state, home, away, target, { weekdays, isFinal, digest });
  const legs: MatchRecord[] = [
    {
      id: tieId(cup.id, state.season, stage, pair, 1),
      season: state.season,
      competitionId: cup.id,
      stage,
      round: 1,
      date: first.date,
      time: first.time,
      // 1차전은 뒤에 홈을 갖는 쪽이 원정 — 2차전제의 이점 배분
      homeTeamId: twoLegged ? away : home,
      awayTeamId: twoLegged ? home : away,
      ...(stage === "final" ? { neutral: true } : {}),
      result: null,
    },
  ];
  if (twoLegged) {
    const second = pickTieDate(state, home, away, addDays(first.date, SECOND_LEG_GAP_DAYS), {
      weekdays,
      digest,
    });
    legs.push({
      id: tieId(cup.id, state.season, stage, pair, 2),
      season: state.season,
      competitionId: cup.id,
      stage,
      round: 2,
      date: second.date,
      time: second.time,
      homeTeamId: home,
      awayTeamId: away,
      result: null,
    });
  }
  return legs;
}

/** 한 컵 한 시즌 안에서 상금을 가르는 축 — 라벨과 달리 표시에 쓰이지 않는다 */
type PrizeKind = `stage:${MatchStage}` | "winner" | "runner-up";

/**
 * 멱등 키 — `category + ref + 무엇 + season` (finance.md §4.1).
 *
 * 라벨은 언제든 고쳐 쓰는 문장이라 키로 쓸 수 없다. 컵 약칭이나 단계 이름 한
 * 글자를 고치는 순간 이미 지급한 상금이 새 키를 얻어 한 번 더 나간다.
 */
function prizeKey(cupId: string, kind: PrizeKind, season: number): string {
  return `prize:competition:${cupId}:${kind}:S${season}`;
}

function prizeLabel(cup: DomesticCupEntry, season: number, what: string): string {
  return `${cup.short} ${what} 상금 (S${season})`;
}

/**
 * 옛 세이브 호환 — 표시 라벨을 그대로 멱등 키로 쓰던 시절의 `prizesPaid`를 안정
 * 키로 옮긴다. 옮기지 않으면 로드가 곧바로 부르는 `advanceDomesticCups`의 라운드
 * 정산이 옛 키를 못 알아보고 같은 상금을 한 번 더 지급한다.
 *
 * 라벨이 시즌을 달고 있어 지난 시즌 기록까지 그대로 옮겨온다. 새 키는 이 표에
 * 없으므로 두 번 돌려도 결과가 같다.
 */
export function migrateDomesticPrizeKeys(state: GameState): void {
  const moved = new Map<string, string>();
  for (const cup of domesticCupCatalog()) {
    for (let season = 1; season <= state.season; season++) {
      moved.set(prizeLabel(cup, season, "우승"), prizeKey(cup.id, "winner", season));
      moved.set(prizeLabel(cup, season, "준우승"), prizeKey(cup.id, "runner-up", season));
      for (const stage of DOMESTIC_STAGES) {
        moved.set(
          prizeLabel(cup, season, `${domesticStageLabel(cup, stage)} 진출`),
          prizeKey(cup.id, `stage:${stage}`, season),
        );
      }
    }
  }
  for (const finance of state.finances) {
    const keys = finance.prizesPaid;
    if (!keys) continue;
    for (let i = 0; i < keys.length; i++) {
      const next = moved.get(keys[i]!);
      if (next) keys[i] = next;
    }
  }
}

/** 라운드 진출 상금 — 그 단계에 오른 모든 팀에게 (중복 지급은 원장 키가 막는다) */
function payRoundPrize(
  state: GameState,
  cup: DomesticCupEntry,
  stage: MatchStage,
  teams: string[],
  digest: string[],
): void {
  const amount = cup.prize.round[stage] ?? 0;
  if (amount <= 0) return;
  const label = prizeLabel(cup, state.season, `${domesticStageLabel(cup, stage)} 진출`);
  for (const teamId of new Set(teams)) {
    const paid = payOnce(state, teamId, prizeKey(cup.id, `stage:${stage}`, state.season), {
      kind: "income",
      category: "prize",
      label,
      amount,
      ref: { type: "competition", id: cup.id },
    });
    if (paid && teamId === state.userTeamId) {
      digest.push(`💰 ${label} ${formatMoney(amount)} 입금`);
    }
  }
}

/** 결정적 셔플 — 같은 (seed, channel)이면 항상 같은 추첨 */
function shuffled<T>(items: readonly T[], seed: number, channel: string): T[] {
  const rng = makeRng(seed, channel);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * 대진표 확정형(코파 이탈리아)의 1라운드 자리 배치 — 시드 8팀을 브래킷에 흩는다.
 *
 * 실제 코파 이탈리아는 직전 시즌 상위 8팀을 시드로 두고 대진표를 미리 확정한다
 * (인테르·로마·피오렌티나·나폴리가 한쪽, 볼로냐·라치오·유베·아탈란타가 반대쪽).
 * 16대진 토너먼트에서 시드가 8강 전에 만나지 않으려면 이 자리들에 앉혀야 한다.
 */
const SEED_SLOTS = [0, 15, 8, 7, 4, 11, 12, 3];

function seededBracket(state: GameState, cup: DomesticCupEntry, teams: string[]): string[] {
  const byStrength = [...teams].sort((a, b) => rankOf(state, a) - rankOf(state, b));
  const seeds = byStrength.slice(0, SEED_SLOTS.length);
  const rest = shuffled(
    byStrength.slice(SEED_SLOTS.length),
    state.seed,
    `cupbracket:${cup.id}:${state.season}`,
  );
  // 시드는 각자의 대진에서 홈(앞자리), 나머지는 남은 자리를 차례로 채운다
  const order: Array<string | null> = new Array(teams.length).fill(null);
  seeds.forEach((id, i) => {
    order[SEED_SLOTS[i]! * 2] = id;
  });
  let next = 0;
  for (let slot = 0; slot < order.length; slot++) {
    if (order[slot] === null) order[slot] = rest[next++]!;
  }
  return order as string[];
}

/**
 * 한 단계를 편성한다.
 *
 * 라운드별 추첨 대회는 매번 새로 뽑고(시드 없음), 대진표 확정형은 1라운드만
 * 시드 배치로 깔고 이후엔 **브래킷 자리 순서**를 그대로 쓴다 — 그래서 개막부터
 * "이기면 8강에서 누구"가 보인다.
 */
function createStage(
  state: GameState,
  cup: DomesticCupEntry,
  stage: MatchStage,
  teams: string[],
  digest: string[],
): void {
  const firstStage = stage === DOMESTIC_STAGES[0];
  const order =
    cup.drawStyle === "fixed-bracket"
      ? firstStage
        ? seededBracket(state, cup, teams)
        : teams // 브래킷 자리가 대진을 정한다 (승자 목록이 이미 그 순서다)
      : shuffled(teams, state.seed, `cupdraw:${cup.id}:${state.season}:${stage}`);
  const created: MatchRecord[] = [];
  const pairCount = Math.floor(order.length / 2);
  for (let pair = 0; pair < pairCount; pair++) {
    const legs = createTie(
      state,
      cup,
      stage,
      pair,
      pairCount,
      order[pair * 2]!,
      order[pair * 2 + 1]!,
      digest,
    );
    // **바로 장부에 올린다.** 라운드를 다 짜고 한꺼번에 올리면, 뒤 대진이 리그를
    // 비켜세울 때(`clearForCup`) 앞 대진의 경기가 아직 장부에 없어 그 날짜로 리그가
    // 옮겨 앉는다 — 한 팀이 하루에 두 경기를 갖고 시즌이 멈춘다.
    // (쿠프 드 프랑스 1라운드가 릴·앙제의 리그 16R와 같은 날 잡혔던 원인이다.)
    state.matches.push(...legs);
    created.push(...legs);
  }
  if (created.length === 0) return;

  registerUserEntries(state, created);
  payRoundPrize(state, cup, stage, teams, digest);
  scheduleNextDraw(state, cup, stage, created, digest);

  const label = domesticStageLabel(cup, stage);
  const ours = created.find(
    (m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId,
  );
  if (ours) {
    const opponent = ours.homeTeamId === state.userTeamId ? ours.awayTeamId : ours.homeTeamId;
    const where = ours.neutral ? "중립" : ours.homeTeamId === state.userTeamId ? "홈" : "원정";
    digest.push(
      `🎫 ${cup.short} ${label} 대진 확정 — ${where}에서 ${teamName(opponent)} (${ours.date})`,
    );
    pushNarrative(state, `${cup.short} ${label} vs ${teamName(opponent)}`, 4);
  }
}

/** 이 대진의 모든 차전 — 차수 순 */
function tieLegsOf(
  state: GameState,
  cupId: string,
  stage: MatchStage,
  pair: number,
): MatchRecord[] {
  return domesticStageMatches(state, cupId, stage).filter((m) => pairOf(m) === pair);
}

/**
 * 대진의 승자 — **이미 적힌 결과만 읽는다.** 갈리지 않았으면 null.
 *
 * ⚠️ 여기서 연장·승부차기를 굴리지 않는다. 승자를 묻는 자리는 화면이 브래킷을
 * 그릴 때마다, 달력이 예약을 지울 때마다 열리고, 조회가 상태를 바꾸면 그때마다
 * 결과가 새로 굴러간다. 굴리는 것은 `resolveDomesticTie` 하나다 (competition.md §6).
 */
export function domesticTieWinner(
  state: GameState,
  cupId: string,
  stage: MatchStage,
  pair: number,
): string | null {
  return settledTieWinner(tieLegsOf(state, cupId, stage, pair));
}

/**
 * 대진을 **끝까지 치러** 승자를 낸다 — 경기가 모두 끝났을 때만.
 *
 * 단판은 90분, 2차전제는 합계가 같으면 **연장 30분**을 먼저 치르고(`extra-time.ts`)
 * 그래도 갈리지 않으면 승부차기다(`shootout.ts`). 둘 다 멱등이라 여러 번 불러도
 * 스코어가 자라지 않는다. 부르는 곳은 대회를 진행시키는 `advanceDomesticCups`뿐이다.
 */
export function resolveDomesticTie(
  state: GameState,
  cupId: string,
  stage: MatchStage,
  pair: number,
): string | null {
  const legs = tieLegsOf(state, cupId, stage, pair);
  if (legs.length === 0 || legs.some((m) => !m.result)) return null;

  const decider = legs[legs.length - 1]!;
  resolveExtraTime(state, decider, `${cupId}:${stage}:${pair}`);
  if (needsShootout(state, decider)) resolveShootout(state, decider);
  return settledTieWinner(legs);
}

/** 이 컵의 우승 팀 — 결승이 끝났을 때만 (시즌 리뷰·트로피·유럽 티켓의 원본) */
export function domesticChampion(state: GameState, cupId: string): string | null {
  return domesticTieWinner(state, cupId, "final", 0);
}

/** 결승에서 진 팀 — 준우승 상금·서사용 */
export function domesticRunnerUp(state: GameState, cupId: string): string | null {
  const champion = domesticChampion(state, cupId);
  const decider = domesticStageMatches(state, cupId, "final")[0];
  if (!champion || !decider) return null;
  return decider.homeTeamId === champion ? decider.awayTeamId : decider.homeTeamId;
}

/** 우리 팀이 뛴 단계의 결과 보고 — 다음 단계 편성과 같은 시점에 한 번만 */
function reportOurTie(
  state: GameState,
  cup: DomesticCupEntry,
  stage: MatchStage,
  winners: string[],
  digest: string[],
): void {
  const played = domesticStageMatches(state, cup.id, stage).some(
    (m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId,
  );
  if (!played) return;
  const label = domesticStageLabel(cup, stage);
  const advanced = winners.includes(state.userTeamId);
  digest.push(advanced ? `${cup.short} ${label} 통과` : `${cup.short} ${label} 탈락`);
  pushNarrative(state, `${cup.short} ${label} ${advanced ? "통과" : "탈락"}`, 4);
}

/**
 * 다음 라운드 추첨을 **이번 라운드를 편성하는 순간** 예약한다.
 *
 * 실제 대회가 그렇다 — 3라운드 대진이 나오면 "4라운드 추첨은 1월 12일"이 함께
 * 발표되고, 그 날짜는 **3라운드 마지막 경기일**이다(FA컵·리그컵은 그 경기 직후
 * 현장에서 뽑는다). 그래서 감독은 몇 주 전부터 달력에서 추첨일을 본다.
 *
 * 결승은 예외 — 준결승 승자 둘이 곧 대진이라 뽑을 게 없다.
 * 대진표 확정형(코파 이탈리아)도 예외 — 이후 라운드에 추첨 자체가 없다.
 */
function scheduleNextDraw(
  state: GameState,
  cup: DomesticCupEntry,
  stage: MatchStage,
  created: MatchRecord[],
  digest: string[],
): void {
  if (cup.drawStyle === "fixed-bracket") return;
  const next = DOMESTIC_STAGES[DOMESTIC_STAGES.indexOf(stage) + 1];
  if (!next || next === "final") return;

  const lastTie = created.reduce((max, m) => (m.date > max ? m.date : max), created[0]!.date);
  const date = addDays(lastTie, cup.drawDelayDays);
  if (scheduleDraw(state, cup.id, next, date, userStillIn(state, cup.id))) {
    digest.push(`🎲 ${cup.short} ${domesticStageLabel(cup, next)} 대진 추첨 — ${date}`);
  }
}

/** 1라운드 추첨일이 이만큼 지난 뒤에야 붙은 세이브는 그 시즌 컵을 건너뛴다 */
const LATE_ADOPTION_GRACE_DAYS = 21;

/**
 * 이 컵을 이번 시즌에 돌리는가.
 *
 * **한 번 시작한 컵은 무조건 끝까지 간다.** 아래 조건들은 *시작*의 문턱일 뿐이다 —
 * 매 tick의 게이트로 쓰면 시즌 중반에 대회가 통째로 멈춘다.
 *
 * 시작 조건 둘:
 * ① 참가 클럽 32팀이 **세이브에 실제로 있어야** 한다. 2부 클럽이 없던 옛 세이브를
 *    마이그레이션 없이 열면 존재하지 않는 팀으로 대진을 짜게 된다.
 * ② 1라운드 추첨일이 아직 크게 지나지 않았어야 한다. 시즌 중반에 컵이 새로 붙는
 *    세이브에 다섯 라운드를 남은 몇 주에 욱여넣으면 일정이 무너진다 — 그런 시즌은
 *    조용히 건너뛰고 다음 시즌부터 정상으로 돈다.
 *
 * 시즌 종료 판정(`allMatchesDone`)도 **이 함수로** 기다릴 컵을 고른다 — 게이트가
 * 둘이면 안 열린 컵의 우승자를 영원히 기다린다.
 */
export function cupRunsThisSeason(state: GameState, cup: DomesticCupEntry): boolean {
  const entrants = domesticCupEntrants(cup.id);
  if (entrants.length !== DOMESTIC_CUP_SIZE) return false;
  if (entrants.some((id) => !state.teams.some((t) => t.id === id))) return false;
  // 이미 1라운드가 편성됐으면 시작한 대회다 — 문턱은 더 볼 필요가 없다
  if (domesticStageMatches(state, cup.id, DOMESTIC_STAGES[0]!).length > 0) return true;
  return state.date <= addDays(seasonDate(state.season, cup.firstDraw), LATE_ADOPTION_GRACE_DAYS);
}

/**
 * 국내 컵 진행 — 매일 tick과 우리 경기 종료 직후에 호출된다.
 *
 * 대회마다 "다음에 만들어야 할 단계"를 하나만 본다. 라운드는 **추첨일에** 열리고,
 * 그 날짜는 실제 대회에서 왔다 — 1라운드는 카탈로그의 `firstDraw`(FA컵 12/8 등),
 * 이후는 직전 라운드 마지막 경기 + `drawDelayDays`.
 * 우승·트로피는 시즌 리뷰가 확정한다 (`reviewDomesticCups`).
 */
export function advanceDomesticCups(state: GameState, digest: string[]): void {
  for (const cup of domesticCupCatalog()) {
    if (!cupRunsThisSeason(state, cup)) continue;
    let previousWinners: string[] | null = null;

    for (let i = 0; i < DOMESTIC_STAGES.length; i++) {
      const stage = DOMESTIC_STAGES[i]!;
      const existing = domesticStageMatches(state, cup.id, stage);
      if (existing.length === 0) {
        if (i === 0) {
          // 1라운드 — 실제 대회의 추첨일에 그 나라 전 클럽으로 뽑는다
          const entrants = domesticCupEntrants(cup.id);
          scheduleDraw(
            state,
            cup.id,
            stage,
            seasonDate(state.season, cup.firstDraw),
            entrants.includes(state.userTeamId),
          );
          if (!drawIsDue(state, cup.id, stage)) break;
          createStage(state, cup, stage, entrants, digest);
        } else {
          if (!previousWinners || previousWinners.length < 2) break;
          // 추첨일은 직전 라운드를 편성할 때 이미 잡혀 있다 (없으면 추첨 없는 단계)
          if (drawEntryOf(state, cup.id, stage) && !drawIsDue(state, cup.id, stage)) break;
          reportOurTie(state, cup, DOMESTIC_STAGES[i - 1]!, previousWinners, digest);
          createStage(state, cup, stage, previousWinners, digest);
        }
        completeDraw(state, cup.id, stage);
        break; // 한 번에 한 단계만 — 다음 단계는 이 단계가 끝난 뒤
      }
      const pairCount = new Set(existing.map((m) => pairOf(m))).size;
      const winners: string[] = [];
      for (let pair = 0; pair < pairCount; pair++) {
        const winner = resolveDomesticTie(state, cup.id, stage, pair);
        if (winner) winners.push(winner);
      }
      if (winners.length < pairCount) break; // 아직 진행 중
      previousWinners = winners;
    }

    // 탈락하면 남은 추첨은 감독의 달력에서 내린다 (우리 상대를 뽑는 자리가 아니다)
    if (!userStillIn(state, cup.id)) {
      for (const e of state.schedule) {
        if (e.type === "draw" && e.status === "scheduled" && e.refId.startsWith(`${cup.id}:`)) {
          e.teamId = null;
        }
      }
    }
  }
  syncCupRounds(state);
}

/**
 * 우리가 **이미 자리를 확보한** 다음 라운드 — 없으면 null.
 *
 * 1라운드는 전 클럽이 나가므로 시작 전부터 확보돼 있고, 그 뒤로는 **직전 라운드를
 * 이겨야** 다음 자리가 생긴다. 진행 중인 대진은 확보가 아니다 — 질 수도 있다.
 */
function securedStage(state: GameState, cup: DomesticCupEntry): MatchStage | null {
  const next = DOMESTIC_STAGES.find((s) => domesticStageMatches(state, cup.id, s).length === 0);
  if (!next) return null; // 결승까지 다 추첨됐다
  const prevIdx = DOMESTIC_STAGES.indexOf(next) - 1;
  if (prevIdx < 0) return next; // 1라운드 — 전 클럽 참가
  const prev = DOMESTIC_STAGES[prevIdx]!;
  const ours = domesticStageMatches(state, cup.id, prev).find(
    (m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId,
  );
  if (!ours) return null; // 직전 라운드에 우리가 없다 = 이미 떨어졌다
  // 아직 안 끝났으면(winner === null) 다음 라운드는 우리 것이 아니다
  return domesticTieWinner(state, cup.id, prev, pairOf(ours)) === state.userTeamId ? next : null;
}

/**
 * 우리가 확보한 컵 라운드의 **예정일**을 감독의 달력에 올린다.
 *
 * 상대는 몰라도 날짜는 미리 안다 — 실제 협회도 시즌 전에 전 라운드 날짜를
 * 공표한다("3라운드는 1월 10일 주말"). 추첨 때까지 달력이 비어 있으면 감독이
 * 그 주의 로테이션·훈련을 계획할 수 없다.
 *
 * 다만 **올라간다는 보장이 없는 라운드는 올리지 않는다** — 7월에 "FA컵 결승 5/16"이
 * 달력에 박혀 있으면 거짓 약속이다. 한 컵당 많아야 한 칸, 직전 라운드를 이긴
 * 시점에 다음 칸이 열린다. 대진이 확정되면 그 자리는 사라지고 경기가 잇는다.
 *
 * 대항전 녹아웃도 같은 이유로 넣지 않는다 — 리그 페이즈를 통과해야 우리 경기다.
 */
function syncCupRounds(state: GameState): void {
  const ours = domesticCupsOf(state.userTeamId);
  const wanted = new Map<string, { cup: DomesticCupEntry; stage: MatchStage }>();
  for (const cup of ours) {
    if (!cupRunsThisSeason(state, cup)) continue;
    const stage = securedStage(state, cup);
    if (!stage) continue;
    if (stageTarget(state.season, cup, stage) < state.date) continue; // 지난 라운드
    wanted.set(`se-round-${cup.id}-${state.season}-${stage}`, { cup, stage });
  }

  const before = state.schedule.length;
  state.schedule = state.schedule.filter((e) => e.type !== "cup-round" || wanted.has(e.id));
  let changed = state.schedule.length !== before;

  for (const [id, { cup, stage }] of wanted) {
    if (state.schedule.some((e) => e.id === id)) continue;
    const date = stageTarget(state.season, cup, stage);
    state.schedule.push({
      id,
      date,
      time: dayOfWeek(date) === 0 || dayOfWeek(date) === 6 ? "15:00" : "19:45",
      type: "cup-round",
      refId: drawRefId(cup.id, stage),
      teamId: state.userTeamId,
      status: "scheduled",
    });
    changed = true;
  }
  if (changed) state.schedule = sortEntries(state.schedule);
}

/**
 * 시즌 리뷰의 국내 컵 결산 — 우승 트로피·상금·평판.
 * 결승이 리그 최종전보다 앞설 수 있지만, 우승 확정은 시즌 리뷰 한 곳에서만 한다
 * (매일 tick에서 중복 보고하지 않기 위해서다).
 */
export function reviewDomesticCups(state: GameState): string[] {
  const digest: string[] = [];
  for (const cup of domesticCupCatalog()) {
    const champion = domesticChampion(state, cup.id);
    if (!champion) continue;
    const runnerUp = domesticRunnerUp(state, cup.id);
    const ours = champion === state.userTeamId || runnerUp === state.userTeamId;

    const payTo = (teamId: string, kind: PrizeKind, what: string, amount: number) => {
      const label = prizeLabel(cup, state.season, what);
      const paid = payOnce(state, teamId, prizeKey(cup.id, kind, state.season), {
        kind: "income",
        category: "prize",
        label,
        amount,
        ref: { type: "competition", id: cup.id },
      });
      if (paid && teamId === state.userTeamId) {
        digest.push(`💰 ${label} ${formatMoney(amount)} 입금`);
      }
    };
    payTo(champion, "winner", "우승", cup.prize.winner);
    if (runnerUp) payTo(runnerUp, "runner-up", "준우승", cup.prize.runnerUp);

    if (champion === state.userTeamId) {
      state.trophies.push({ season: state.season, competition: cup.name, teamId: champion });
      state.manager.reputation.media = Math.min(100, state.manager.reputation.media + 8);
      state.manager.reputation.board = Math.min(100, state.manager.reputation.board + 6);
      digest.push(`🏆 ${cup.name} 우승`);
      pushNarrative(state, `${cup.name} 우승`, 5);
    } else if (ours) {
      state.manager.reputation.media = Math.min(100, state.manager.reputation.media + 3);
      digest.push(`${cup.short} 준우승 — 결승 상대 ${teamName(champion)}`);
      pushNarrative(state, `${cup.short} 준우승`, 4);
    } else if (cup.country === countryOf(state.userTeamId)) {
      digest.push(`${cup.short} 우승: ${teamShortName(champion)}`);
    }
  }
  return digest;
}

function countryOf(teamId: string): string | null {
  return leagueCatalogById(leagueOfTeam(teamId))?.country ?? null;
}

/**
 * 이번 시즌 국내 컵 우승팀 — 리그별 유럽 티켓 배정에 쓴다.
 * `{ [leagueId]: { uel?: teamId, uecl?: teamId } }` 꼴로, 우승팀이 아직 없으면 비어 있다.
 */
export function domesticCupWinners(
  state: GameState,
): Record<string, { uel?: string; uecl?: string }> {
  const out: Record<string, { uel?: string; uecl?: string }> = {};
  for (const cup of domesticCupCatalog()) {
    const champion = domesticChampion(state, cup.id);
    if (!champion) continue;
    // 티켓은 그 나라 1부 리그의 몫에서 나간다 — 2부 클럽이 우승해도 마찬가지다
    const leagueId = topLeagueOfCountry(cup.country);
    if (!leagueId) continue;
    const slot = (out[leagueId] ??= {});
    slot[cup.europeanTicket] = champion;
  }
  return out;
}
