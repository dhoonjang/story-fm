import { describe, expect, it } from "vitest";
import {
  domesticCupCatalog,
  teamCatalog,
  DOMESTIC_CUP_SIZE,
  DOMESTIC_STAGES,
  addMissingClubs,
  advanceDomesticCups,
  advanceTime,
  allMatchesDone,
  buildEuroEntrants,
  buildOfficeViews,
  buildSeasonFixtures,
  clubsOfCountry,
  competitionStageLabel,
  computeStandings,
  diffDays,
  domesticChampion,
  domesticCupEntrants,
  domesticCupField,
  domesticCupWinners,
  domesticCupsOf,
  domesticStageLabel,
  domesticStageMatches,
  europeanEntrants,
  isPostponable,
  isClubTeam,
  isTopFlight,
  leagueOfTeam,
  migrateDomesticPrizeKeys,
  payDomesticCupPrizes,
  playersOf,
  teamName,
  reviewSeason,
  transitionSeason,
  userStillIn,
  type GameState,
} from "@story-fm/engine";
import type { MatchRecord, MatchStage } from "@story-fm/domain";
import { isReserveMatch } from "@story-fm/domain";
import { createTestGame, keepSeat, playMockMatch } from "./helpers";

/**
 * 국내 컵 (FA컵·리그컵·코파·포칼·쿠프) — 32강 순수 녹아웃.
 * 대회 구조·일정 충돌·유럽 티켓 연동을 LLM 없이 결정적으로 검증한다.
 */

/** 그 컵의 "예정" 자리 — 대진이 뽑히기 전에 달력을 채우는 라운드 표식 */
function pendingFor(state: GameState, cupId: string) {
  return state.schedule.filter((e) => e.type === "cup-round" && e.refId.startsWith(`${cupId}:`));
}

/**
 * 시즌을 굴리는 **동안에만** 볼 수 있는 것 — 지나가면 사라지는 예정 자리다.
 *
 * 컵 예정의 불변식(컵당 많아야 하나 · 살아 있을 때만 · 뽑히기 전까지만)은 시즌이
 * 끝난 뒤의 세이브로는 확인할 수 없다. 예전엔 그래서 이 검증만 시즌을 세 번 더
 * 굴렸다 — 지금은 공유 세이브를 만드는 그 진행에 같이 얹는다.
 */
interface PendingWatch {
  violations: string[];
  /** 1라운드를 이기고 **다음** 라운드 예정이 열리는 장면을 실제로 봤나 */
  sawSecond: boolean;
}

function watchPending(state: GameState, watch: PendingWatch): void {
  for (const cup of domesticCupsOf(state.userTeamId)) {
    const pending = pendingFor(state, cup.id);
    if (pending.length > 1) {
      watch.violations.push(`${state.date} ${cup.id}: 예정이 ${pending.length}개`);
      continue;
    }
    const stage = pending[0]?.refId.split(":")[1];
    if (!stage) continue;
    // 예정이 있다 = 아직 살아 있고, 그 라운드는 아직 안 뽑혔다
    if (!userStillIn(state, cup.id)) {
      watch.violations.push(`${state.date} ${cup.id}: 탈락했는데 예정이 남았다`);
    }
    if (domesticStageMatches(state, cup.id, stage as never).length > 0) {
      watch.violations.push(`${state.date} ${cup.id}/${stage}: 뽑힌 라운드에 예정이 남았다`);
    }
    if (stage !== DOMESTIC_STAGES[0]) watch.sawSecond = true;
  }
}

/**
 * 시즌 마지막 경기까지 돌리고 **전환 직전에 멈춘다**.
 *
 * 하루씩 미는 이유: `advanceTime`은 하루를 시작할 때 `allMatchesDone`이면 곧장
 * 시즌을 전환한다. 그러면 `state.matches`가 새 시즌 것으로 갈려 방금 끝난 시즌의
 * 컵 대진을 검사할 수 없다. 매 걸음 전에 우리가 먼저 확인하면 그 문턱을 넘지 않는다.
 */
function playSeason(state: GameState, watch?: PendingWatch): void {
  let guard = 420; // 시즌 한 바퀴(7월~6월)보다 넉넉히
  while (guard-- > 0 && !allMatchesDone(state)) {
    const before = state.date;
    // 컵 편성을 재는 동안 자리는 지킨다 — 경질은 시계를 멈춘다(reviewUserSeat)
    keepSeat(state);
    const advanced = advanceTime(state, { days: 1 });
    if (state.phase === "matchday") playMockMatch(state);
    if (watch) watchPending(state, watch);
    if (state.date === before && advanced.stopped !== "matchday") break;
  }
}

/**
 * 시즌 한 바퀴를 다 돈 세이브 — **시드마다 한 번만 굴리고 나눠 읽는다.**
 *
 * 같은 시드는 같은 장부를 만든다. 검증마다 다시 돌리면 이 파일이 시즌을 열 바퀴
 * 넘게 굴리고, 그 비용이 통째로 각 테스트의 제한 시간 안에 들어가 여럿이 동시에
 * 테스트를 돌릴 때 타임아웃으로 나타났다. 여기서 만든 세이브는 **읽기만** 하는
 * 검증의 것이다 — 시즌을 넘기는 쪽(`transitionSeason`)은 제 세이브를 따로 만든다.
 */
const seasons = new Map<number, GameState>();
const watches = new Map<number, PendingWatch>();

function seasonOf(seed: number): GameState {
  const cached = seasons.get(seed);
  if (cached) return cached;
  const state = createTestGame(seed);
  const watch: PendingWatch = { violations: [], sawSecond: false };
  playSeason(state, watch);
  seasons.set(seed, state);
  watches.set(seed, watch);
  return state;
}

/** 그 시드의 시즌을 굴리면서 모은 컵 예정 관찰 */
function watchOf(seed: number): PendingWatch {
  seasonOf(seed);
  return watches.get(seed)!;
}

/**
 * 이 파일이 굴리는 시드 — 컵·대항전 진출 조합이 시드마다 다르다.
 *
 * ⚠️ **77은 값이 있어서 있는 자리다.** 앞의 넷이 전부 초록인 동안 77에서만 맨체스터
 * 시티가 리그 다음 날 FA컵을 뛰었다(24시간). 시드를 늘리는 값은 한 시즌 완주만큼
 * 비싸므로 함부로 더하지 않지만, **네 시드가 못 본 것을 실제로 본 시드**는 그 값을
 * 한다 — 편성은 진출 조합이 만드는 조합 폭발이라 표본이 곧 탐지력이다.
 */
const SEEDS = [7, 23, 42, 91, 77];

/**
 * 한 팀이 하루에 두 경기를 갖지 않는다 — 컵 편성의 **가장 중요한 불변식**이다.
 *
 * 겹치면 tick이 그날 우리 경기 하나만 처리하고 나머지를 영원히 남긴다. 그러면
 * `allMatchesDone`이 끝내 참이 되지 않아 **시즌이 넘어가지 않는다** (실제로
 * FA컵 결승이 UCL 결승과 같은 날 잡혀 이렇게 멈춘 적이 있다 — `reservedEuroDates`가
 * 대항전 결승일을 빼먹은 탓이었다).
 */
function expectNoDoubleBooking(state: GameState): void {
  const seen = new Map<string, string>();
  for (const m of state.matches) {
    if (m.season !== state.season) continue;
    // 2군 경기는 다른 스쿼드의 경기다 — 1군 경기와 같은 날이어도 tick이 간이 시뮬로
    // 그날 소화하므로(우리 경기 컷오프·finalizeMatch 재호출) 영원히 남지 않는다
    if (isReserveMatch(m)) continue;
    for (const teamId of [m.homeTeamId, m.awayTeamId]) {
      const key = `${teamId}@${m.date}`;
      expect(seen.get(key), `${key}: ${seen.get(key)} ↔ ${m.id}`).toBeUndefined();
      seen.set(key, m.id);
    }
  }
}

/**
 * 한 팀이 두 경기를 치르는 간격 — **킥오프 시각으로** 잰 최소값(시간).
 *
 * 날짜로 세면 목요일 21:00 유로파 다음 토요일 12:30(=39시간 30분)이 "이틀 뒤"로
 * 통과한다. 컵은 리그·대항전이 채운 달력의 틈으로 들어가므로 이 값이 실제로
 * 지켜지는지는 시즌을 한 바퀴 돌려 봐야 안다.
 */
function minRestHours(state: GameState): { hours: number; where: string } {
  const at = (m: MatchRecord) => Date.parse(`${m.date}T${m.time ?? "15:00"}:00Z`);
  const byTeam = new Map<string, MatchRecord[]>();
  for (const m of state.matches) {
    if (m.season !== state.season) continue;
    // 2군 경기는 다른 열한 명의 경기다 — 1군 휴식 눈금에 들어가지 않는다 (season.md §2)
    if (isReserveMatch(m)) continue;
    for (const teamId of [m.homeTeamId, m.awayTeamId]) {
      const list = byTeam.get(teamId);
      if (list) list.push(m);
      else byTeam.set(teamId, [m]);
    }
  }
  let hours = Number.POSITIVE_INFINITY;
  let where = "없음";
  for (const [teamId, list] of byTeam) {
    list.sort((a, b) => at(a) - at(b));
    for (let i = 1; i < list.length; i++) {
      const gap = (at(list[i]!) - at(list[i - 1]!)) / 3_600_000;
      if (gap >= hours) continue;
      hours = gap;
      where = `${teamName(teamId)} ${list[i - 1]!.date} ${list[i - 1]!.time}(${list[i - 1]!.competitionId}) → ${list[i]!.date} ${list[i]!.time}(${list[i]!.competitionId})`;
    }
  }
  return { hours, where };
}

describe("컵 카탈로그 — 32강 브래킷이 성립한다", () => {
  it("나라마다 1부+2부 32클럽 · 컵 참가 명단이 정확히 32팀", () => {
    for (const cup of domesticCupCatalog()) {
      const entrants = domesticCupEntrants(cup.id);
      expect(entrants).toHaveLength(DOMESTIC_CUP_SIZE);
      expect(new Set(entrants).size).toBe(DOMESTIC_CUP_SIZE);
      // 참가 명단은 그 나라 클럽만
      const country = new Set(clubsOfCountry(cup.country).map((t) => t.id));
      for (const id of entrants) expect(country.has(id)).toBe(true);
    }
  });

  it("잉글랜드만 컵이 둘 — FA컵이 리그컵보다 앞선다", () => {
    const english = domesticCupsOf("arsenal");
    expect(english.map((c) => c.id)).toEqual(["facup", "eflcup"]);
    expect(domesticCupsOf("realmadrid").map((c) => c.id)).toEqual(["copadelrey"]);
  });

  it("2부 클럽은 리그 순위표에 들어가지 않는다", () => {
    const state = createTestGame(11);
    const table = computeStandings(state, "epl");
    expect(table).toHaveLength(20);
    for (const row of table) expect(isTopFlight(row.teamId)).toBe(true);
    // 2부 클럽도 세이브에는 있다 (컵 참가자)
    expect(state.teams.some((t) => leagueOfTeam(t.id) === "championship")).toBe(true);
  });
});

describe("한 시즌을 돌리면 컵이 끝까지 진행된다", () => {
  const state = seasonOf(7);

  it("우리 나라 컵이 32강부터 결승까지 전부 편성·소화된다", () => {
    for (const cup of domesticCupsOf(state.userTeamId)) {
      const perStage = DOMESTIC_STAGES.map((s) => domesticStageMatches(state, cup.id, s));
      // 32강 16대진 → 16강 8 → 8강 4 → 준결승 2 → 결승 1
      const pairs = perStage.map((ms) => new Set(ms.map((m) => /-p(\d+)-/.exec(m.id)?.[1])).size);
      expect(pairs).toEqual([16, 8, 4, 2, 1]);
      for (const ms of perStage) for (const m of ms) expect(m.result).not.toBeNull();
      expect(domesticChampion(state, cup.id)).not.toBeNull();
    }
  });

  it("무승부로 끝난 컵 경기는 승부차기로 갈린다 — 장부에 승자가 남는다", () => {
    for (const cup of domesticCupsOf(state.userTeamId)) {
      for (const stage of DOMESTIC_STAGES) {
        const single = domesticStageMatches(state, cup.id, stage).filter((m) => m.round === 1);
        for (const m of single) {
          const twoLegged = cup.twoLegged.includes(stage) && stage !== "final";
          if (twoLegged) continue;
          const r = m.result!;
          if (r.homeGoals === r.awayGoals) expect(r.penalties).toBeDefined();
        }
      }
    }
  });

  it("어떤 팀도 하루에 두 경기를 뛰지 않는다", () => {
    expectNoDoubleBooking(state);
  });

  it("우리 팀 컵 경기는 감독의 달력(SCHEDULE_ENTRY)에 오른다", () => {
    const ourCupIds = new Set(domesticCupsOf(state.userTeamId).map((c) => c.id));
    const ourCupMatches = state.matches.filter(
      (m) =>
        m.season === state.season &&
        m.competitionId !== null &&
        ourCupIds.has(m.competitionId) &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    );
    expect(ourCupMatches.length).toBeGreaterThan(0);
    const scheduled = new Set(state.schedule.filter((e) => e.type === "match").map((e) => e.refId));
    for (const m of ourCupMatches) expect(scheduled.has(m.id)).toBe(true);
  });
});

describe("대진 추첨이 일정 축에 오른다", () => {
  const state = seasonOf(7);
  const entries = buildOfficeViews(state).calendar.entries.filter((e) => e.type === "draw");

  it("라운드마다 추첨일이 달력에 남는다 — 경기보다 앞선 날짜로", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.title).toContain("대진 추첨");
      expect(e.status).toBe("done"); // 시즌을 끝까지 돌렸으니 전부 소화됐다
    }
    // 리그컵 3라운드(1부가 들어오는 라운드) 추첨은 그 라운드 경기보다 먼저 열린다
    const draw = entries.find((e) => e.title.startsWith("리그컵 3라운드"))!;
    const firstTie = domesticStageMatches(state, "eflcup", "r32")[0]!;
    expect(draw.date < firstTie.date).toBe(true);
  });

  it("결승은 추첨하지 않는다 — 준결승 승자 둘이 곧 대진이다", () => {
    // 제목("준결승 대진 추첨")엔 "결승"이 들어가므로 refId의 단계로 본다
    const stages = state.schedule
      .filter((e) => e.type === "draw")
      .map((e) => e.refId.split(":")[1]);
    expect(stages.length).toBeGreaterThan(0);
    expect(stages).not.toContain("final");
  });

  it("남의 나라 컵 추첨은 감독의 달력에 오르지 않는다", () => {
    for (const e of entries) {
      expect(["리그컵", "FA컵", "UCL", "UEL", "UECL"].some((s) => e.title.startsWith(s))).toBe(
        true,
      );
    }
  });

  it("추첨이 밀려 있으면 시즌이 넘어가지 않는다", () => {
    const fresh = createTestGame(31);
    // 1라운드 추첨을 인위로 되살리면(=아직 안 열린 라운드) 시즌 종료가 막힌다
    fresh.schedule.push({
      id: "se-draw-test",
      date: fresh.date,
      time: "12:00",
      type: "draw",
      refId: "facup:sf",
      teamId: fresh.userTeamId,
      status: "scheduled",
    });
    expect(allMatchesDone(fresh)).toBe(false);
  });
});

describe("추첨 전에도 라운드 날짜는 달력에 있다 — 단, 확보한 자리만", () => {
  it("부임 첫날엔 컵마다 첫 라운드 하나씩만 — 뒷 라운드는 올라간다는 보장이 없다", () => {
    const state = createTestGame(7);
    const rounds = buildOfficeViews(state).calendar.entries.filter((e) => e.type === "cup-round");
    // FA컵 3라운드 + 리그컵 3라운드 — 1부가 들어오는 그 라운드가 우리의 첫 라운드다
    expect(rounds).toHaveLength(2);
    for (const r of rounds) {
      expect(r.match, "상대가 없어야 예정이다").toBeNull();
      expect(r.cup).not.toBeNull();
      expect(r.date >= state.date).toBe(true);
      // 제목이 다 말하므로 부연은 붙이지 않는다
      expect(r.detail).toBeNull();
    }
    expect(rounds.map((r) => r.title).sort()).toEqual(["FA컵 3라운드 예정", "리그컵 3라운드 예정"]);
  });

  it("대진이 확정되면 예정 자리는 사라지고, 이기기 전엔 다음 라운드가 열리지 않는다", () => {
    const state = createTestGame(7);
    expect(pendingFor(state, "eflcup").some((e) => e.refId.endsWith(":r32"))).toBe(true);

    // 리그컵 3라운드 추첨일(8/27)을 지나면 대진이 나온다
    let guard = 60;
    while (guard-- > 0 && domesticStageMatches(state, "eflcup", "r32").length === 0) {
      advanceTime(state, { days: 1 });
      if (state.phase === "matchday") playMockMatch(state);
    }
    expect(domesticStageMatches(state, "eflcup", "r32").length).toBeGreaterThan(0);
    // 대진이 있으니 예정 자리는 제 몫을 다했고, 16강은 아직 우리 자리가 아니다
    expect(pendingFor(state, "eflcup")).toHaveLength(0);
  }, 60_000);

  /**
   * ⚠️ **"다음 자리가 열렸다"는 우리가 1라운드를 이겼을 때만 볼 수 있다** — 시드 하나에
   * 매면 체력·전력 밸런스를 만질 때마다 이 테스트가 결과 운으로 깜빡인다. 불변식
   * (예정은 많아야 하나 · 살아 있을 때만 · 뽑히기 전까지만)은 모든 시드에서 재고,
   * 다음 자리가 열리는 장면은 시드 하나에서 보이면 된다.
   */
  it("시즌 내내 컵당 예정은 많아야 하나 — 직전 라운드를 이겨야 다음이 열린다", () => {
    for (const seed of SEEDS) {
      expect(watchOf(seed).violations, `시드 ${seed}`).toEqual([]);
      // 시즌이 끝난 뒤 — 탈락한 컵엔 아무 예정도 남지 않는다
      const state = seasonOf(seed);
      for (const cup of domesticCupsOf(state.userTeamId)) {
        if (userStillIn(state, cup.id)) continue;
        expect(pendingFor(state, cup.id), `시드 ${seed} ${cup.id} 탈락 후 예정`).toHaveLength(0);
      }
    }
    expect(
      SEEDS.some((seed) => watchOf(seed).sawSecond),
      "어느 시드에서도 1라운드를 이기고 다음 자리가 열리지 않았다",
    ).toBe(true);
  }, 180_000);
});

describe("실제 대회 규정을 따른다", () => {
  it("추첨 방식이 둘 — 코파 이탈리아만 시즌 초에 대진표가 확정된다", () => {
    const perRound = domesticCupCatalog().filter((c) => c.drawStyle === "per-round");
    const fixed = domesticCupCatalog().filter((c) => c.drawStyle === "fixed-bracket");
    expect(fixed.map((c) => c.id)).toEqual(["coppaitalia"]);
    expect(perRound.length).toBe(5);
  });

  it("대진표 확정형은 추첨이 딱 한 번 — 시즌 초 대진표 확정뿐이다", () => {
    const state = seasonOf(7);
    const refs = state.schedule.filter((e) => e.type === "draw").map((e) => e.refId);
    expect(refs.filter((r) => r.startsWith("coppaitalia:"))).toEqual(["coppaitalia:r32"]);
    // 라운드별 추첨 대회는 라운드마다 추첨이 남는다
    expect(refs.filter((r) => r.startsWith("eflcup:")).length).toBeGreaterThan(1);
  }, 30_000);

  it("홈 배정이 대회 규정을 따른다 — 포칼은 하부 클럽, 코파 이탈리아는 시드", () => {
    const state = seasonOf(7);
    const mixed = (cupId: string) =>
      domesticStageMatches(state, cupId, "r32").filter(
        (m) => isTopFlight(m.homeTeamId) !== isTopFlight(m.awayTeamId),
      );
    // 포칼: 1부↔2부 대진은 예외 없이 2부가 홈 (실제 규정)
    const pokal = mixed("dfbpokal");
    expect(pokal.length).toBeGreaterThan(0);
    for (const m of pokal) expect(isTopFlight(m.homeTeamId)).toBe(false);
    // 코파 이탈리아: 반대로 시드(1부)가 홈
    const coppa = mixed("coppaitalia");
    expect(coppa.length).toBeGreaterThan(0);
    for (const m of coppa) expect(isTopFlight(m.homeTeamId)).toBe(true);
  }, 30_000);

  it("결승 요일도 대회 규정이다 — 넷은 주말, 코파 이탈리아만 수요일 밤", () => {
    const state = seasonOf(7);
    for (const cup of domesticCupCatalog()) {
      const final = domesticStageMatches(state, cup.id, "final")[0];
      if (!final) continue;
      const dow = new Date(`${final.date}T00:00:00Z`).getUTCDay();
      expect(cup.finalMidweek ? [2, 3] : [0, 6], `${cup.id} 결승 ${final.date}`).toContain(dow);
    }
  }, 30_000);

  it("32강은 하루에 몰지 않고 이틀에 흩는다 (실제 컵의 화·수 / 토·일)", () => {
    const state = seasonOf(7);
    for (const cup of domesticCupCatalog()) {
      const dates = new Set(domesticStageMatches(state, cup.id, "r32").map((m) => m.date));
      expect(dates.size, `${cup.id} 1라운드가 ${dates.size}일`).toBeGreaterThanOrEqual(2);
      // 그렇다고 늘어져서도 안 된다 — 한 라운드가 2주를 넘기면 대회가 흐물흐물해진다
      const sorted = [...dates].sort();
      const span =
        (Date.parse(`${sorted.at(-1)}T00:00:00Z`) - Date.parse(`${sorted[0]}T00:00:00Z`)) /
        86_400_000;
      expect(span, `${cup.id} 1라운드가 ${span}일에 걸침`).toBeLessThanOrEqual(14);
    }
  }, 30_000);

  it("첫 라운드 추첨일이 실제 대회 날짜다 — FA컵 12/8, 리그컵 8월 말", () => {
    const state = seasonOf(7);
    const dateOf = (cupId: string) =>
      state.schedule.find((e) => e.type === "draw" && e.refId === `${cupId}:r32`)?.date;
    expect(dateOf("facup")).toBe("2026-12-08");
    expect(dateOf("eflcup")).toBe("2026-08-27");
    expect(dateOf("copadelrey")).toBe("2026-12-09");
  }, 30_000);
});

/**
 * **1부는 1라운드에 나오지 않는다.**
 *
 * 실제 컵은 하부리그가 먼저 몇 달을 싸우고 1부는 한참 뒤에 들어온다. 우리는
 * 그 앞부분을 모델링하지 않으므로 **1부가 들어오는 라운드에서 대회를 시작한다** —
 * 아스날의 리그컵 첫 경기는 9월 말 3라운드이지 8월 1라운드가 아니다.
 */
describe("컵은 1부가 들어오는 라운드에서 시작한다", () => {
  const ENTRY = {
    facup: { label: "3라운드", month: 1 },
    eflcup: { label: "3라운드", month: 9 },
    copadelrey: { label: "32강", month: 1 },
    coppaitalia: { label: "1라운드", month: 8 },
    dfbpokal: { label: "1라운드", month: 8 },
    coupedefrance: { label: "32강", month: 1 },
  } as const;

  it("첫 라운드 이름이 실제 진입 라운드다 — 리그컵·FA컵은 3라운드", () => {
    for (const cup of domesticCupCatalog()) {
      const expected = ENTRY[cup.id as keyof typeof ENTRY];
      expect(competitionStageLabel(cup.id, "r32"), cup.id).toBe(expected.label);
      // 그 라운드의 목표 달도 실제 대회 시기다
      expect(cup.windows.r32[0], `${cup.id} 첫 라운드 달`).toBe(expected.month);
    }
  });

  it("8강부터는 이름이 규모와 맞는다 — 대회마다 다르지 않다", () => {
    for (const cup of domesticCupCatalog()) {
      expect(competitionStageLabel(cup.id, "qf"), cup.id).toBe("8강");
      expect(competitionStageLabel(cup.id, "final"), cup.id).toBe("결승");
    }
  });

  it("아스날의 리그컵 첫 경기는 9월 말이다 — 8월 1라운드가 아니다", () => {
    const state = seasonOf(7);
    const first = domesticStageMatches(state, "eflcup", "r32").find(
      (m) => m.homeTeamId === "arsenal" || m.awayTeamId === "arsenal",
    )!;
    expect(first, "아스날이 리그컵 첫 라운드에 없다").toBeTruthy();
    expect(first.date >= "2026-09-01", `첫 경기 ${first.date}`).toBe(true);
    // 그 경기가 곧 아스날의 리그컵 데뷔전이다 (앞선 라운드가 없다)
    const ours = state.matches.filter(
      (m) =>
        m.season === state.season &&
        m.competitionId === "eflcup" &&
        (m.homeTeamId === "arsenal" || m.awayTeamId === "arsenal"),
    );
    expect(ours.every((m) => m.date >= first.date)).toBe(true);
  }, 30_000);

  it("첫 라운드가 부전승 없이 꽉 찬다 — 시드 진입 대회만 정원이 절반이다", () => {
    const state = seasonOf(7);
    for (const cup of domesticCupCatalog()) {
      const opening = domesticStageMatches(state, cup.id, "r32");
      const teams = new Set(opening.flatMap((m) => [m.homeTeamId, m.awayTeamId]));
      // 시드가 진입 라운드 정원에서 자리를 갖는 만큼 첫 라운드가 준다 (§3.2-1의 산수)
      const expected = cup.seedEntry
        ? 2 *
          (DOMESTIC_CUP_SIZE / 2 ** DOMESTIC_STAGES.indexOf(cup.seedEntry.stage) -
            cup.seedEntry.count)
        : DOMESTIC_CUP_SIZE;
      expect(teams.size, `${cup.id} 첫 라운드 참가`).toBe(expected);
    }
  }, 30_000);

  /**
   * **불변식 — 시드는 자기 진입 라운드 전에 대진표에 등장하지 않는다** (#351).
   *
   * 코파 이탈리아 시드 8팀은 실제로 16강(ottavi)부터 나온다. 명단 32는 시드 8 ·
   * 1라운드 16 · 앞 라운드 탈락 8로 갈리고, 16강의 여덟 대진은 전부 시드 대
   * 1라운드 승자다 (competition.md §3.2-1).
   */
  it("코파 이탈리아 시드 8팀은 16강부터다 — 진입 라운드 전엔 대진표에 없다", () => {
    const state = seasonOf(7);
    const coppa = domesticCupCatalog().find((c) => c.id === "coppaitalia")!;
    const field = domesticCupField(state, coppa);
    expect(field.seeds).toHaveLength(8);
    expect(field.opening).toHaveLength(16);
    expect(field.eliminated).toHaveLength(8);
    const roster = [...field.seeds, ...field.opening, ...field.eliminated];
    expect(new Set(roster).size).toBe(DOMESTIC_CUP_SIZE);
    // 시드는 전원 1부(전력 서열 상위 8), 탈락 처리는 전원 2부다
    for (const id of field.seeds) expect(isTopFlight(id), id).toBe(true);
    for (const id of field.eliminated) expect(isTopFlight(id), id).toBe(false);

    const opening = new Set(
      domesticStageMatches(state, coppa.id, "r32").flatMap((m) => [m.homeTeamId, m.awayTeamId]),
    );
    for (const id of field.seeds)
      expect(opening.has(id), `시드 ${id}가 1라운드에 있다`).toBe(false);
    for (const id of field.eliminated) {
      expect(opening.has(id), `탈락 처리된 ${id}가 1라운드에 있다`).toBe(false);
    }
    // 16강 = 시드 8 + 1라운드 승자 8 — 대진마다 시드가 정확히 하나다
    const r16 = domesticStageMatches(state, coppa.id, "r16").filter((m) => m.round === 1);
    expect(r16).toHaveLength(8);
    for (const m of r16) {
      const seeded = [m.homeTeamId, m.awayTeamId].filter((id) => field.seeds.includes(id));
      expect(seeded, `${m.id} 시드 수`).toHaveLength(1);
      expect(opening.has(seeded[0] === m.homeTeamId ? m.awayTeamId : m.homeTeamId)).toBe(true);
    }
  }, 30_000);
});

describe("기존 세이브 — 2부 클럽 채워 넣기", () => {
  it("클럽이 빠진 세이브를 로드하면 팀·스쿼드·전술·재정이 복구된다", () => {
    const state = createTestGame(5);
    // 2부 클럽을 통째로 들어낸 옛 세이브를 흉내낸다
    // 무소속(`free`)은 클럽이 아니라 스쿼드가 없다 — 2부와 함께 세지 않는다
    const second = state.teams
      .filter((t) => !isTopFlight(t.id) && isClubTeam(t.id))
      .map((t) => t.id);
    expect(second.length).toBe(
      teamCatalog().filter((t) => !isTopFlight(t.id) && isClubTeam(t.id)).length,
    );
    const drop = new Set(second);
    state.teams = state.teams.filter((t) => !drop.has(t.id));
    state.players = state.players.filter((p) => !drop.has(p.teamId));
    state.tactics = state.tactics.filter((t) => !drop.has(t.teamId));
    state.finances = state.finances.filter((f) => !drop.has(f.teamId));
    state.contracts = state.contracts.filter((c) => !drop.has(c.teamId));

    expect(addMissingClubs(state)).toBe(second.length);
    for (const id of second) {
      expect(
        state.teams.some((t) => t.id === id),
        id,
      ).toBe(true);
      expect(playersOf(state, id).length, id).toBeGreaterThanOrEqual(18);
      expect(
        state.tactics.some((t) => t.teamId === id),
        id,
      ).toBe(true);
      expect(
        state.finances.some((f) => f.teamId === id),
        id,
      ).toBe(true);
      for (const p of playersOf(state, id)) {
        expect(
          state.contracts.some((c) => c.gamePlayerId === p.id),
          p.id,
        ).toBe(true);
      }
    }
    // 두 번 불러도 중복되지 않는다
    expect(addMissingClubs(state)).toBe(0);
  });

  it("1라운드 추첨일이 크게 지난 뒤 붙은 세이브는 그 시즌 컵을 건너뛴다", () => {
    const state = createTestGame(5);
    state.date = "2027-02-01"; // 전 컵의 1라운드 추첨이 지난 시점
    advanceDomesticCups(state, []);
    for (const cup of domesticCupCatalog()) {
      expect(domesticStageMatches(state, cup.id, "r32"), cup.id).toHaveLength(0);
    }
  });

  /**
   * 소프트락 회귀 — 안 열린 컵의 우승자를 기다리면 결승이 영영 없어 날짜만 흐른다.
   *
   * 시즌을 다시 굴리지 않고 완주한 세이브를 복제해 만든다. 어드민이 한 나라 클럽을
   * 하나 뺀 세이브가 이 모양이다 — 참가 명단의 팀이 세이브에 없고, 그래서 그 대회는
   * 한 판도 편성되지 않았다.
   */
  it("그 시즌 열리지 않은 컵은 시즌 종료를 막지 않는다", () => {
    const state = structuredClone(seasonOf(7));
    const ours = new Set(domesticCupsOf(state.userTeamId).map((c) => c.id));
    const [skipped, ran] = domesticCupCatalog().filter((c) => !ours.has(c.id));
    const dropSeasonMatches = (cupId: string, stage?: MatchStage) => {
      state.matches = state.matches.filter(
        (m) =>
          !(
            m.season === state.season &&
            m.competitionId === cupId &&
            (stage === undefined || m.stage === stage)
          ),
      );
    };

    dropSeasonMatches(skipped!.id);
    state.teams = state.teams.filter((t) => t.id !== domesticCupEntrants(skipped!.id)[0]);
    expect(domesticChampion(state, skipped!.id)).toBeNull();
    expect(allMatchesDone(state)).toBe(true);

    // 뒤집어 — **열린** 컵은 우승자가 없으면 여전히 기다린다. 빠진 것이 같은
    // 우승자인데도 판정이 갈리는 자리가 게이트다
    dropSeasonMatches(ran!.id, "final");
    expect(domesticChampion(state, ran!.id)).toBeNull();
    expect(allMatchesDone(state)).toBe(false);
  });
});

describe("컵이 리그를 비켜세운다 — 겹치면 리그가 연기된다", () => {
  const state = seasonOf(7);
  // 편성 원본은 세이브가 아니라 시드에서 나온다 — 시즌을 굴린 뒤에도 같은 표다
  const originalDates = new Map(
    buildSeasonFixtures(1, state.seed, buildEuroEntrants(1, state.seed))
      .filter((m) => m.competitionId === "epl")
      .map((m) => [m.id, m.date] as const),
  );
  const league = state.matches.filter((m) => m.competitionId === "epl");
  const moved = league.filter((m) => originalDates.get(m.id) !== m.date);

  it("컵이 실제 대회 날짜를 지킨다 — FA컵은 목표 주말을 벗어나지 않는다", () => {
    // 리그가 비켜서기 전에는 8강이 화요일로, 결승이 3주 뒤로 밀렸다
    const datesOf = (stage: "qf" | "sf" | "final") =>
      [...new Set(domesticStageMatches(state, "facup", stage).map((m) => m.date))].sort();
    // 8강은 목표 주말(3/21) 언저리에 머문다. 한두 대진이 주중으로 새는 건 48시간
    // 휴식을 지키려는 대가고, 실제 FA컵 8강도 주말에 다 못 넣으면 화요일로 뺀다
    for (const date of datesOf("qf")) {
      expect(date >= "2027-03-19" && date <= "2027-03-24", `8강 ${date}`).toBe(true);
    }
    expect(datesOf("qf").length, "8강이 한 주에 흩어져야 한다").toBeLessThanOrEqual(3);
    expect(datesOf("sf")).toEqual(["2027-04-25"]); // 실제 4강 날짜
    expect(datesOf("final")).toEqual(["2027-05-16"]); // 실제 웸블리 결승일
  });

  /**
   * **개막 라운드는 최종 라운드와 같이 계약이다** (`isPostponable`).
   *
   * 이 문이 없던 동안 코파 이탈리아 1라운드(8/16)·포칼 1라운드(8/18)가 개막 주말을
   * 차지하고 리그를 비켜세워, 세리에 A 개막 라운드 10경기가 통째로 주중으로,
   * 분데스리가는 아홉 중 일곱이 8~9월에 흩어졌다. 컵을 스치지 않는 EPL만 보면
   * 초록이라, 검사는 **다섯 리그 전부**를 본다.
   */
  it("어느 리그든 개막 라운드가 개막 주말에 그대로 있다", () => {
    const opener = state.calendar.start; // 금요일 밤 개막전 — 주말은 여기서 사흘
    for (const leagueId of ["epl", "laliga", "seriea", "bundesliga", "ligue1"]) {
      const first = state.matches.filter(
        (m) => m.season === state.season && m.competitionId === leagueId && m.round === 1,
      );
      expect(first.length, `${leagueId} 개막 라운드가 없다`).toBeGreaterThan(0);
      for (const m of first) {
        const offset = diffDays(opener, m.date);
        expect(offset >= 0 && offset <= 3, `${leagueId} ${m.date} (개막 ${opener})`).toBe(true);
      }
    }
  });

  it("연기해도 리그 경기 수는 그대로다 — 옮길 뿐 없애지 않는다", () => {
    expect(league).toHaveLength(380);
    expect(moved.length).toBeGreaterThan(0);
    // 그렇다고 리그 전체가 흔들려서도 안 된다 (실제 EPL 재편성도 시즌당 20여 경기)
    expect(moved.length).toBeLessThan(60);
  });

  it("연기된 경기는 뒤로만 가고, 최종 라운드를 넘지 않는다", () => {
    const lastRound = Math.max(...league.map((m) => m.round));
    const deadline = league
      .filter((m) => m.round === lastRound)
      .reduce((max, m) => (m.date > max ? m.date : max), "");
    for (const m of moved) {
      expect(m.date > originalDates.get(m.id)!, `${m.id} 앞으로 당겨짐`).toBe(true);
      expect(m.date <= deadline, `${m.id} 최종전(${deadline}) 뒤로 밀림`).toBe(true);
      expect(m.round, "최종 라운드는 동시 킥오프라 못 옮긴다").toBeLessThan(lastRound);
    }
  });

  it("컵·대항전 경기는 연기 대상이 아니다 — 그쪽 날짜는 계약이다", () => {
    for (const m of state.matches.filter((x) => x.season === state.season)) {
      if (m.competitionId === "epl") continue;
      expect(isPostponable(state, m), `${m.competitionId} 경기가 연기 가능으로 표시됨`).toBe(false);
    }
  });

  /**
   * 일정 축(`state.schedule`)에는 **감독의 경기만** 오른다. 그래서 검사는 "옮겨진
   * 경기 중 달력에 있는 것"을 훑는다 — 어느 시드에서 하필 우리 경기가 안 밀렸다고
   * 계약이 사라지는 것은 아니다(친선이 붙은 뒤로 시즌이 다르게 굴러 그런 시드가
   * 생겼다). 기계가 죽으면 `moved`가 0이 되므로 그건 따로 못 박는다.
   */
  it("연기된 경기는 일정 축도 따라 옮겨진다", () => {
    expect(moved.length, "컵이 리그를 하나도 비켜세우지 않았다").toBeGreaterThan(0);
    const onCalendar = moved
      .map((m) => ({
        m,
        entry: state.schedule.find((e) => e.type === "match" && e.refId === m.id),
      }))
      .filter((x) => x.entry !== undefined);
    for (const { m, entry } of onCalendar) {
      expect(entry!.date, `${m.id} 달력이 옛 날짜에 남음`).toBe(m.date);
    }
  });
});

describe("여러 시드로 한 시즌 완주 — 편성이 게임을 멈추지 않는다", () => {
  // 시드마다 컵·대항전 진출 조합이 달라 겹침이 드러나는 자리도 달라진다.
  // 하나라도 겹치면 그 세이브는 시즌을 넘기지 못하므로 여러 시드로 돌려 본다.
  for (const seed of SEEDS) {
    const state = seasonOf(seed);
    it(`시드 ${seed} — 하루 두 경기 없이 시즌이 끝나고 결승은 주말이다`, () => {
      expect(allMatchesDone(state), `시드 ${seed}: ${state.date}에 시즌이 안 끝났다`).toBe(true);
      expectNoDoubleBooking(state);

      /**
       * **48시간 규칙** — 한 팀이 이틀 안에 두 경기를 뛰지 않는다.
       *
       * 완전한 48시간은 강제하지 않는다. 목요일 밤 유로파를 뛴 팀이 토요일 저녁·
       * 일요일 낮에 리그를 치르는 43~47시간짜리 일정은 **실제 프리미어리그에서
       * 매 시즌 벌어지는 일**이라 그것까지 없애면 라운드 골격이 무너진다.
       * 없어야 하는 건 그 아래 — 같은 날, 다음 날, 그리고 40시간 미만이다.
       */
      const rest = minRestHours(state);
      expect(rest.hours, `시드 ${seed}: ${rest.where}`).toBeGreaterThanOrEqual(40);

      const dayBefore = (iso: string) => {
        const d = new Date(`${iso}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().slice(0, 10);
      };
      for (const cup of domesticCupCatalog()) {
        const final = domesticStageMatches(state, cup.id, "final")[0];
        if (!final) continue;
        const dow = new Date(`${final.date}T00:00:00Z`).getUTCDay();
        // 코파 이탈리아만 주중 결승이다 (실제 올림피코 결승이 수요일 밤)
        expect(cup.finalMidweek ? [2, 3] : [0, 6], `${cup.id} 결승 ${final.date}`).toContain(dow);
        // 결승 **전날**엔 경기가 없다. (다음 날 리그가 붙는 건 혼잡한 5월엔 일어난다 —
        // 리그 38라운드 골격을 깨지 않는 선에서의 타협이고, 실제로도 컵 결승 주간엔
        // 결승 팀의 리그 경기가 재편성된다. 우리는 그 재편성까지는 하지 않는다.)
        for (const teamId of [final.homeTeamId, final.awayTeamId]) {
          const eve = state.matches.find(
            (m) =>
              m.season === state.season &&
              m.date === dayBefore(final.date) &&
              (m.homeTeamId === teamId || m.awayTeamId === teamId),
          );
          expect(eve, `${cup.id} 결승 전날(${eve?.date}) 경기`).toBeUndefined();
        }
      }
    }, 60_000);
  }
});

describe("컵 우승 → 트로피와 유럽 티켓", () => {
  // 여기만 시즌을 **넘긴다** — 공유 세이브(`seasonOf`)를 고쳐 쓰지 않고 복제해 쓴다.
  // 같은 시드를 다시 굴리면 같은 장부가 나오지만, 그 값이 시즌 한 바퀴다
  const state = structuredClone(seasonOf(23));

  it("컵 우승팀은 다음 시즌 유럽 대항전에 들어간다", () => {
    reviewSeason(state);
    const winners = domesticCupWinners(state);
    expect(Object.keys(winners).length).toBeGreaterThan(0);

    transitionSeason(state);
    for (const [leagueId, slots] of Object.entries(winners)) {
      for (const teamId of Object.values(slots ?? {})) {
        if (!teamId) continue;
        const inEurope = state.euroEntrants.some((e) => e.teams.includes(teamId));
        expect(inEurope, `${leagueId} 컵 우승 ${teamId}가 유럽에 없다`).toBe(true);
      }
    }
  }, 30_000);

  it("티켓을 끼워 넣어도 대회 정원은 그대로 — 자리의 주인만 바뀐다", () => {
    const tables = { epl: eplOrder() };
    const before = europeanEntrants("uel", 2, 42, tables);
    const outsider = "outsider-fc";
    const after = europeanEntrants("uel", 2, 42, tables, { epl: { uel: outsider } });
    expect(after).toHaveLength(before.length);
    expect(after).toContain(outsider);
    // 밀려난 팀은 한 단계 아래(UECL)의 마지막 자리로 내려간다
    const displaced = before.find((id) => !after.includes(id))!;
    const uecl = europeanEntrants("uecl", 2, 42, tables, { epl: { uel: outsider } });
    expect(uecl).toContain(displaced);
  });

  it("컵 우승팀이 이미 순위로 유럽에 들어갔으면 아무도 밀리지 않는다", () => {
    const tables = { epl: eplOrder() };
    const alreadyIn = tables.epl[0]!; // 리그 1위 = UCL
    expect(europeanEntrants("uel", 2, 42, tables, { epl: { uel: alreadyIn } })).toEqual(
      europeanEntrants("uel", 2, 42, tables),
    );
  });
});

describe("상금 멱등 키 — 표시 라벨이 아니라 안정 키다", () => {
  // 장부를 고쳐 쓰는 검증이라 공유 세이브를 복제해 쓴다
  const played = structuredClone(seasonOf(23));

  /** 라벨을 그대로 키로 쓰던 시절의 국내 컵 지급 기록 — 안정 키 → 옛 문장 */
  const legacy = new Map<string, string>();
  for (const cup of domesticCupCatalog()) {
    const put = (kind: string, what: string) =>
      legacy.set(
        `prize:competition:${cup.id}:${kind}:S${played.season}`,
        `${cup.short} ${what} 상금 (S${played.season})`,
      );
    put("winner", "우승");
    put("runner-up", "준우승");
    for (const stage of DOMESTIC_STAGES) {
      put(`stage:${stage}`, `${domesticStageLabel(cup, stage)} 진출`);
    }
  }

  it("라운드 진출 상금이 안정 키로 그 라운드 팀 전원에게 남는다", () => {
    // 지급 사실은 prizesPaid 키가 갖는다 — AI 팀은 상세 원장을 쌓지 않는다
    const paidFor = (cupId: string, stage: MatchStage) =>
      played.finances.filter((f) =>
        (f.prizesPaid ?? []).includes(
          `prize:competition:${cupId}:stage:${stage}:S${played.season}`,
        ),
      ).length;
    for (const cup of domesticCupCatalog()) {
      expect(paidFor(cup.id, "r16"), cup.id).toBe(DOMESTIC_CUP_SIZE / 2);
      expect(paidFor(cup.id, "sf"), cup.id).toBe(4);
    }
  });

  it("옛 라벨 키를 옮긴다 — 라벨을 고쳐도 같은 시즌 상금이 두 번 나가지 않는다", () => {
    const save = structuredClone(played);
    payDomesticCupPrizes(save, []); // 우승·준우승 상금

    let downgraded = 0;
    for (const finance of save.finances) {
      const keys = finance.prizesPaid;
      if (!keys) continue;
      for (let i = 0; i < keys.length; i++) {
        const old = legacy.get(keys[i]!);
        if (!old) continue;
        keys[i] = old;
        downgraded++;
      }
    }
    expect(downgraded).toBeGreaterThan(0);

    const balances = save.finances.map((f) => f.balance);
    migrateDomesticPrizeKeys(save);
    migrateDomesticPrizeKeys(save); // 멱등
    payDomesticCupPrizes(save, []);

    expect(save.finances.map((f) => f.balance)).toEqual(balances);
    const legacyKeys = new Set(legacy.values());
    expect(
      save.finances.flatMap((f) => f.prizesPaid ?? []).filter((k) => legacyKeys.has(k)),
    ).toEqual([]);
  });
});

/** EPL 최종 순위 자리표 — 유럽 배정만 검증하므로 실제 팀 id면 충분하다 */
function eplOrder(): string[] {
  return clubsOfCountry("잉글랜드")
    .filter((t) => isTopFlight(t.id))
    .map((t) => t.id);
}
