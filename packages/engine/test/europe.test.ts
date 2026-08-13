import { describe, expect, it } from "vitest";
import {
  cupCatalog,
  buildAllEuroMatches,
  buildAllLeagueMatches,
  buildEuroEntrants,
  buildSeasonFixtures,
  entrantsOf,
  computeStandings,
  cupCatalogById,
  diffDays,
  euroCompetitionOf,
  euroMatchdayDates,
  europeanEntrants,
  euroPotCount,
  euroPots,
  isCup,
  isUserFixture,
  leagueOfTeam,
  relaxEuroAdjacency,
  teamsOfLeague,
  transitionSeason,
} from "@story-fm/engine";
import { advanceAndPlay, createTestGame } from "./helpers";

/**
 * 유럽 대항전 — 참가 배정 · 리그 페이즈 편성 · 리그 일정과의 공존.
 *
 * 편성은 대회 규모가 커도 구조적으로 성립해야 한다. 특히 "한 팀이 같은 라운드에
 * 두 번 나오는" 실패는 예전에 실제로 났던 버그다 (간선 색칠 문제 — europe.ts 주석).
 */
/** 첫 시즌 배정 — 지난 시즌이 없으므로 구단 등급 기준 */
const ENTRANTS = buildEuroEntrants(1, 42);

describe("대항전 참가 배정", () => {
  it("리그별 티켓 수만큼, 상위 대회와 겹치지 않게 배정된다", () => {
    for (const cup of cupCatalog()) {
      const entrants = europeanEntrants(cup.id, 1, 42);
      expect(entrants, cup.id).toHaveLength(cup.size);
      expect(new Set(entrants).size, cup.id).toBe(cup.size);
      for (const [leagueId, count] of Object.entries(cup.slots)) {
        expect(
          entrants.filter((id) => leagueOfTeam(id) === leagueId),
          `${cup.id}/${leagueId}`,
        ).toHaveLength(count);
      }
    }
    // 한 팀이 두 대회에 동시에 나가지 않는다
    const all = cupCatalog().flatMap((c) => europeanEntrants(c.id, 1, 42));
    expect(new Set(all).size).toBe(all.length);
  });

  it("지난 시즌 리그 최종 순위가 다음 시즌 티켓을 정한다", () => {
    const state = createTestGame(42);
    // 우리 리그를 인위적으로 끝내고 최종 순위를 만든다 (홈 승으로 전부 채움)
    for (const m of state.matches) {
      if (m.season !== state.season) continue;
      m.result = {
        homeGoals: m.homeTeamId === state.userTeamId ? 5 : 1,
        awayGoals: 0,
        scorers: [],
      };
    }
    const finalTable = computeStandings(state, "epl").map((r) => r.teamId);
    expect(finalTable[0], "홈 5골이면 우리 팀이 1위").toBe(state.userTeamId);

    transitionSeason(state);

    // UCL 잉글랜드 티켓 5장은 최종 1~5위에게 간다
    const ucl = entrantsOf(state.euroEntrants, "ucl").filter((id) => leagueOfTeam(id) === "epl");
    expect(ucl).toEqual(finalTable.slice(0, 5));
    // 유로파는 그다음 4장, 컨퍼런스는 그다음 2장 — 겹치지 않는다
    const uel = entrantsOf(state.euroEntrants, "uel").filter((id) => leagueOfTeam(id) === "epl");
    const uecl = entrantsOf(state.euroEntrants, "uecl").filter((id) => leagueOfTeam(id) === "epl");
    expect(uel).toEqual(finalTable.slice(5, 9));
    expect(uecl).toEqual(finalTable.slice(9, 11));
  });

  it("첫 시즌은 지난 순위가 없으니 구단 등급으로 배정된다", () => {
    const withoutTables = buildEuroEntrants(1, 42);
    const withTables = buildEuroEntrants(2, 42, {
      epl: teamsOfLeague("epl")
        .map((t) => t.id)
        .reverse(),
    });
    // 지난 순위를 주면 배정이 그것을 따른다 (등급 기준과 달라진다)
    expect(entrantsOf(withTables, "ucl").filter((id) => leagueOfTeam(id) === "epl")).toEqual(
      teamsOfLeague("epl")
        .map((t) => t.id)
        .reverse()
        .slice(0, 5),
    );
    expect(entrantsOf(withoutTables, "ucl")).not.toEqual(entrantsOf(withTables, "ucl"));
  });

  it("배정은 시드에 따라 갈리고 같은 시드면 같다", () => {
    expect(europeanEntrants("ucl", 1, 42)).toEqual(europeanEntrants("ucl", 1, 42));
    expect(europeanEntrants("ucl", 1, 42)).not.toEqual(europeanEntrants("ucl", 1, 7));
  });

  it("euroCompetitionOf는 그 팀이 나가는 대회를 되돌린다", () => {
    const ucl = europeanEntrants("ucl", 1, 42)[0]!;
    expect(euroCompetitionOf(ENTRANTS, ucl)).toBe("ucl");
    const inEurope = new Set(cupCatalog().flatMap((c) => europeanEntrants(c.id, 1, 42)));
    const outsider = teamsOfLeague("epl").find((t) => !inEurope.has(t.id));
    if (outsider) expect(euroCompetitionOf(ENTRANTS, outsider.id)).toBeNull();
  });
});

describe("대항전 리그 페이즈 편성", () => {
  const matches = buildAllEuroMatches(1, 42, buildEuroEntrants(1, 42));

  it("대회마다 팀당 정해진 경기 수 · 홈 절반 · 상대는 모두 다르다", () => {
    for (const cup of cupCatalog()) {
      const mine = matches.filter((m) => m.competitionId === cup.id);
      expect(mine, cup.id).toHaveLength((cup.size * cup.matchesPerTeam) / 2);
      for (const teamId of europeanEntrants(cup.id, 1, 42)) {
        const played = mine.filter((m) => m.homeTeamId === teamId || m.awayTeamId === teamId);
        expect(played, `${cup.id}/${teamId}`).toHaveLength(cup.matchesPerTeam);
        expect(
          played.filter((m) => m.homeTeamId === teamId),
          `${cup.id}/${teamId} 홈`,
        ).toHaveLength(cup.matchesPerTeam / 2);
        const opponents = played.map((m) =>
          m.homeTeamId === teamId ? m.awayTeamId : m.homeTeamId,
        );
        expect(new Set(opponents).size, `${cup.id}/${teamId} 중복 상대`).toBe(opponents.length);
        expect(opponents).not.toContain(teamId);
      }
    }
  });

  it("라운드마다 각 팀이 정확히 한 경기 — 같은 날 두 경기가 없다", () => {
    for (const cup of cupCatalog()) {
      const mine = matches.filter((m) => m.competitionId === cup.id);
      for (let round = 1; round <= cup.matchesPerTeam; round++) {
        const inRound = mine.filter((m) => m.round === round);
        const teams = inRound.flatMap((m) => [m.homeTeamId, m.awayTeamId]);
        expect(new Set(teams).size, `${cup.id} R${round}`).toBe(teams.length);
      }
    }
  });

  it("예약된 대항전 주중에만 열리고 킥오프는 대회별 슬롯을 쓴다", () => {
    const anchors = euroMatchdayDates(1);
    for (const m of matches) {
      const nearAnchor = anchors.some((a) => Math.abs(diffDays(a, m.date)) <= 1);
      expect(nearAnchor, `${m.id} ${m.date}`).toBe(true);
      expect(["18:45", "21:00"]).toContain(m.time);
      // UCL은 화·수, 유로파·컨퍼런스는 목요일
      const dow = new Date(`${m.date}T00:00:00Z`).getUTCDay();
      expect(m.competitionId === "ucl" ? [2, 3] : [4], `${m.id} 요일`).toContain(dow);
    }
  });

  it("같은 리그끼리는 거의 만나지 않는다 (실제 대회의 협회 회피)", () => {
    for (const seed of [42, 7, 1007]) {
      const entrants = buildEuroEntrants(1, seed);
      const all = buildAllEuroMatches(1, seed, entrants);
      for (const cup of cupCatalog()) {
        const mine = all.filter((m) => m.competitionId === cup.id);
        const same = mine.filter((m) => leagueOfTeam(m.homeTeamId) === leagueOfTeam(m.awayTeamId));
        // 축소된 규모(UCL 24팀 중 5팀이 잉글랜드)에선 0이 항상 가능하지 않아
        // 무거운 벌점으로 누른다 — 실측 최악이 대회당 1건이라 상한을 2로 잡는다
        expect(same.length, `seed ${seed} ${cup.id}`).toBeLessThanOrEqual(2);
        const perTeam = new Map<string, number>();
        for (const m of same) {
          for (const t of [m.homeTeamId, m.awayTeamId]) perTeam.set(t, (perTeam.get(t) ?? 0) + 1);
        }
        expect(
          Math.max(0, ...perTeam.values()),
          `seed ${seed} ${cup.id} 한 팀 반복`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it("한 전력대(포트)에 상대가 몰리지 않는다", () => {
    // 이상값은 포트마다 2경기지만, 원형 편성의 자리 배치로 정확한 균등 분할이
    // 항상 가능하지는 않다 (8-정규 그래프의 균등 분할 문제). 같은 리그 회피를
    // 우선 벌점으로 두고 포트 분포는 최선 노력이라, 여기서는 **편중 상한**만 고정한다.
    for (const seed of [42, 7, 1007]) {
      const entrants = buildEuroEntrants(1, seed);
      const all = buildAllEuroMatches(1, seed, entrants);
      for (const cup of cupCatalog()) {
        const list = entrantsOf(entrants, cup.id);
        const pots = euroPots(cup.id, seed, list);
        for (const teamId of list) {
          const opponents = all
            .filter(
              (m) =>
                m.competitionId === cup.id && (m.homeTeamId === teamId || m.awayTeamId === teamId),
            )
            .map((m) => (m.homeTeamId === teamId ? m.awayTeamId : m.homeTeamId));
          expect(opponents).toHaveLength(cup.matchesPerTeam);
          const perPot = new Map<number, number>();
          for (const opp of opponents) {
            const pot = pots.get(opp) ?? 0;
            perPot.set(pot, (perPot.get(pot) ?? 0) + 1);
          }
          // 이상값(경기수/포트수)보다 크게 몰리지 않는다 — 절반 + 1이 상한
          expect(
            Math.max(...perPot.values()),
            `seed ${seed} ${cup.id} ${teamId} 편중`,
          ).toBeLessThanOrEqual(cup.matchesPerTeam / 2 + 1);
          // 4개 포트 대회는 한 포트를 아예 안 만나는 일이 드물어야 한다
          if (euroPotCount(list.length) === 4) {
            expect(
              perPot.size,
              `seed ${seed} ${cup.id} ${teamId} 포트 누락`,
            ).toBeGreaterThanOrEqual(3);
          }
        }
      }
    }
  });

  it("시즌·시드마다 대진이 달라지되 재현 가능하다", () => {
    const key = (season: number, seed: number) =>
      buildAllEuroMatches(season, seed, buildEuroEntrants(season, seed))
        .map((m) => `${m.date}|${m.homeTeamId}|${m.awayTeamId}`)
        .join(",");
    expect(key(1, 42)).toBe(key(1, 42));
    expect(key(1, 42)).not.toBe(key(1, 7));
    expect(key(1, 42)).not.toBe(key(2, 42));
  });
});

describe("리그 일정과의 공존", () => {
  it("어떤 팀도 같은 날 두 경기를 하거나 이틀 연속 뛰지 않는다", () => {
    for (const [season, seed] of [
      [1, 42],
      [2, 7],
      [3, 1007],
    ] as const) {
      const fixtures = buildSeasonFixtures(season, seed, buildEuroEntrants(season, seed));
      const byTeam = new Map<string, string[]>();
      for (const m of fixtures) {
        for (const teamId of [m.homeTeamId, m.awayTeamId]) {
          const dates = byTeam.get(teamId);
          if (dates) dates.push(m.date);
          else byTeam.set(teamId, [m.date]);
        }
      }
      for (const [teamId, dates] of byTeam) {
        dates.sort();
        for (let i = 1; i < dates.length; i++) {
          expect(
            diffDays(dates[i - 1]!, dates[i]!),
            `시즌 ${season} ${teamId}: ${dates[i - 1]} → ${dates[i]}`,
          ).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it("슬롯 맞교환은 라운드 편성을 건드리지 않는다", () => {
    const league = buildAllLeagueMatches(1, 42);
    const before = league.map(
      (m) => `${m.competitionId}|${m.round}|${m.homeTeamId}|${m.awayTeamId}`,
    );
    const slotsBefore = new Map<string, string[]>();
    for (const m of league) {
      const key = `${m.competitionId}:${m.round}`;
      const slots = slotsBefore.get(key);
      if (slots) slots.push(`${m.date} ${m.time}`);
      else slotsBefore.set(key, [`${m.date} ${m.time}`]);
    }

    const swaps = relaxEuroAdjacency(league, buildAllEuroMatches(1, 42, buildEuroEntrants(1, 42)));
    expect(swaps).toBeGreaterThan(0); // 실제로 붙는 자리가 있다 (교환이 필요하다)

    // 대진·라운드는 그대로, 라운드가 쓰는 슬롯 집합도 그대로 — 자리만 맞바뀐다
    expect(
      league.map((m) => `${m.competitionId}|${m.round}|${m.homeTeamId}|${m.awayTeamId}`),
    ).toEqual(before);
    for (const [key, slots] of slotsBefore) {
      const after = league
        .filter((m) => `${m.competitionId}:${m.round}` === key)
        .map((m) => `${m.date} ${m.time}`);
      expect(after.slice().sort(), key).toEqual(slots.slice().sort());
    }
  });

  it("리그 주중 라운드는 대항전 주를 비켜 간다", () => {
    const anchors = euroMatchdayDates(1);
    for (const m of buildAllLeagueMatches(1, 42)) {
      for (const anchor of anchors) {
        expect(Math.abs(diffDays(anchor, m.date)), `${m.id} ${m.date}`).toBeGreaterThan(1);
      }
    }
  });
});

describe("게임 연결", () => {
  const state = createTestGame(42);

  it("createGame이 리그와 대항전을 함께 편성한다", () => {
    const cups = state.matches.filter((m) => isCup(m.competitionId));
    expect(cups.length).toBe(
      cupCatalog().reduce((sum, c) => sum + (c.size * c.matchesPerTeam) / 2, 0),
    );
    expect(state.matches.every((m) => m.time !== undefined)).toBe(true);
  });

  it("감독의 달력에는 우리 리그 전체 + 우리 팀 대항전만 오른다", () => {
    const entries = state.schedule.filter((e) => e.type === "match");
    const byId = new Map(state.matches.map((m) => [m.id, m] as const));
    for (const e of entries) {
      const match = byId.get(e.refId);
      expect(match, e.refId).toBeDefined();
      expect(isUserFixture(match!, state.userTeamId), e.refId).toBe(true);
      // 엔트리의 시간은 경기가 가진 킥오프를 그대로 비춘다
      expect(e.time).toBe(match!.time);
    }
    const registered = new Set(entries.map((e) => e.refId));
    const missing = state.matches.filter(
      (m) => isUserFixture(m, state.userTeamId) && !registered.has(m.id),
    );
    expect(missing).toHaveLength(0);
  });

  it("우리 팀이 대항전에 나가면 그 경기도 달력에 있다", () => {
    const cup = euroCompetitionOf(state.euroEntrants, state.userTeamId);
    expect(cup, "테스트 팀(arsenal)은 대항전에 나가야 한다").not.toBeNull();
    const ours = state.schedule.filter(
      (e) => e.type === "match" && e.refId.startsWith(`m-${cup}-`),
    );
    expect(ours).toHaveLength(cupCatalogById(cup!)!.matchesPerTeam);
  });

  it("리그 페이즈 순위표도 같은 computeStandings로 계산된다", () => {
    const fresh = createTestGame(42);
    for (const m of fresh.matches.filter((m) => m.competitionId === "ucl" && m.round === 1)) {
      m.result = { homeGoals: 2, awayGoals: 0, scorers: [] };
    }
    const table = computeStandings(fresh, "ucl");
    expect(table).toHaveLength(cupCatalogById("ucl")!.size);
    expect(table[0]?.points).toBe(3);
    expect(table[table.length - 1]?.points).toBe(0);
    // 리그 순위표는 대항전 결과에 오염되지 않는다
    expect(computeStandings(fresh, "epl").every((r) => r.played === 0)).toBe(true);
  });

  it("우리 팀 대항전 경기도 경기일로 열리고 결과가 장부에 남는다", () => {
    const playing = createTestGame(42);
    const cup = euroCompetitionOf(playing.euroEntrants, playing.userTeamId)!;
    const ourCupMatches = () =>
      playing.matches.filter(
        (m) =>
          m.competitionId === cup &&
          (m.homeTeamId === playing.userTeamId || m.awayTeamId === playing.userTeamId),
      );
    for (let i = 0; i < 12 && !ourCupMatches().some((m) => m.result); i++) advanceAndPlay(playing);

    const played = ourCupMatches().filter((m) => m.result);
    expect(played.length, "대항전 경기일에 도달하지 못했다").toBeGreaterThan(0);
    // 같은 날 열린 다른 대항전 경기도 간이 시뮬로 소화된다
    const sameDay = playing.matches.filter(
      (m) => m.competitionId === cup && m.date === played[0]!.date,
    );
    expect(sameDay.every((m) => m.result !== null)).toBe(true);
    // 대항전 출전도 시즌 스탯에 쌓인다
    const lineup = played[0]!.result!.homeLineup ?? played[0]!.result!.awayLineup ?? [];
    expect(lineup.length).toBeGreaterThan(0);
  });

  it("시즌 전환도 대항전을 다시 편성한다", () => {
    const next = createTestGame(42);
    transitionSeason(next);
    const cups = next.matches.filter((m) => isCup(m.competitionId));
    expect(cups.length).toBeGreaterThan(0);
    expect(cups.every((m) => m.season === 2 && m.result === null)).toBe(true);
    const cup = euroCompetitionOf(next.euroEntrants, next.userTeamId);
    if (cup) {
      const entries = next.schedule.filter(
        (e) => e.type === "match" && e.refId.startsWith(`m-${cup}-`),
      );
      expect(entries).toHaveLength(cupCatalogById(cup)!.matchesPerTeam);
    }
  });
});
