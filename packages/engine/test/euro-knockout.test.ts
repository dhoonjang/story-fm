import { describe, expect, it } from "vitest";
import type { GameState } from "@story-fm/engine";
import {
  CUP_CATALOG,
  advanceEuroKnockouts,
  computeStandings,
  cupCatalogById,
  euroChampion,
  euroLeaguePhaseDone,
  euroStageMatches,
  euroTieWinner,
  knockoutBracketSize,
  knockoutDates,
  knockoutStages,
  reservedEuroDates,
  buildMatchweekDates,
  diffDays,
  isCup,
  stageLabel,
  advanceTime,
  buildOfficeViews,
} from "@story-fm/engine";
import { createTestGame, playMockMatch } from "./helpers";

/**
 * 대항전 녹아웃 — 단계 진행·2차전 합계·승부차기·트로피.
 *
 * 실제 경기를 다 치르는 대신 리그 페이즈와 각 단계 결과를 결정적으로 채워 넣고
 * `advanceEuroKnockouts`가 다음 단계를 옳게 편성하는지 본다 (코어는 순수 함수다).
 */

/** 남은 경기를 정해진 스코어로 채운다 — 홈 승 (편성 검증에 결과의 내용은 무관) */
function fillResults(
  matches: Array<{ result: unknown; homeTeamId: string; awayTeamId: string }>,
  homeGoals = 2,
  awayGoals = 0,
): void {
  for (const m of matches) {
    if (m.result) continue;
    (m as { result: unknown }).result = { homeGoals, awayGoals, scorers: [] };
  }
}

function leaguePhaseOf(state: GameState, cupId: string) {
  return state.matches.filter(
    (m) => m.competitionId === cupId && (m.stage ?? "league") === "league",
  );
}

/** 녹아웃을 끝까지 굴린다 — 단계마다 결과를 채우고 다음 단계를 편성한다 */
function runKnockouts(state: GameState, cupId: string, digest: string[] = []): void {
  const cup = cupCatalogById(cupId)!;
  fillResults(leaguePhaseOf(state, cupId));
  for (let step = 0; step < knockoutStages(cup).length + 1; step++) {
    advanceEuroKnockouts(state, digest);
    for (const stage of knockoutStages(cup)) fillResults(euroStageMatches(state, cupId, stage));
  }
  advanceEuroKnockouts(state, digest);
}

describe("녹아웃 정의", () => {
  it("본선 대진 수는 2의 거듭제곱이다 (대회 규모가 달라도)", () => {
    for (const cup of CUP_CATALOG) {
      const bracket = knockoutBracketSize(cup);
      expect(Number.isInteger(Math.log2(bracket)), `${cup.id}: ${bracket}대진`).toBe(true);
      // 직행 + 플레이오프 참가는 리그 페이즈 규모를 넘지 않는다
      expect(cup.directSlots + cup.playoffSlots, cup.id).toBeLessThanOrEqual(cup.size);
    }
  });

  it("단계 순서는 플레이오프 → 본선 → 결승이고 대진 수와 맞물린다", () => {
    expect(knockoutStages(cupCatalogById("ucl")!)).toEqual(["playoff", "r16", "qf", "sf", "final"]);
    expect(knockoutStages(cupCatalogById("uel")!)).toEqual(["playoff", "qf", "sf", "final"]);
    expect(knockoutStages(cupCatalogById("uecl")!)).toEqual(["playoff", "sf", "final"]);
  });

  it("녹아웃 경기일은 수요일이고 결승은 리그 최종전 뒤 토요일이다", () => {
    for (const stage of ["playoff", "r16", "qf", "sf"]) {
      const dates = knockoutDates(1, stage);
      expect(dates, stage).toHaveLength(2);
      for (const d of dates) expect(new Date(`${d}T00:00:00Z`).getUTCDay(), d).toBe(3);
      expect(diffDays(dates[0]!, dates[1]!), stage).toBeGreaterThanOrEqual(7);
    }
    const [finalDate] = knockoutDates(1, "final");
    const lastLeagueRound = buildMatchweekDates(1)[37]!;
    expect(new Date(`${finalDate}T00:00:00Z`).getUTCDay()).toBe(6); // 토요일
    expect(diffDays(lastLeagueRound.date, finalDate!)).toBeGreaterThan(0);
  });

  it("리그 주중 라운드는 녹아웃 주도 비켜 간다 (8시즌)", () => {
    for (let season = 1; season <= 8; season++) {
      const weeks = buildMatchweekDates(season);
      expect(weeks, `시즌 ${season}`).toHaveLength(38);
      for (const week of weeks) {
        for (const reserved of reservedEuroDates(season)) {
          expect(
            Math.abs(diffDays(reserved, week.date)),
            `시즌 ${season} R${week.round} ${week.date} vs ${reserved}`,
          ).toBeGreaterThan(1);
        }
      }
    }
  });
});

describe("단계 진행", () => {
  it("리그 페이즈가 끝나기 전에는 아무것도 편성되지 않는다", () => {
    const state = createTestGame(42);
    expect(euroLeaguePhaseDone(state, "ucl")).toBe(false);
    advanceEuroKnockouts(state, []);
    expect(euroStageMatches(state, "ucl", "playoff")).toHaveLength(0);
  });

  it("한 단계가 끝날 때마다 다음 단계만 편성된다", () => {
    const state = createTestGame(42);
    fillResults(leaguePhaseOf(state, "ucl"));

    advanceEuroKnockouts(state, []);
    expect(euroStageMatches(state, "ucl", "playoff")).toHaveLength(16); // 8대진 × 2차전
    expect(euroStageMatches(state, "ucl", "r16")).toHaveLength(0); // 아직

    advanceEuroKnockouts(state, []); // 플레이오프가 안 끝났으니 그대로
    expect(euroStageMatches(state, "ucl", "r16")).toHaveLength(0);

    fillResults(euroStageMatches(state, "ucl", "playoff"));
    advanceEuroKnockouts(state, []);
    expect(euroStageMatches(state, "ucl", "r16")).toHaveLength(16); // 8대진 × 2차전
  });

  it("대회마다 결승까지 도달하고 우승 팀이 하나 남는다", () => {
    for (const cup of CUP_CATALOG) {
      const state = createTestGame(42);
      runKnockouts(state, cup.id);
      for (const stage of knockoutStages(cup)) {
        const matches = euroStageMatches(state, cup.id, stage);
        const pairs = new Set(matches.map((m) => /-p(\d+)-/.exec(m.id)?.[1])).size;
        const expectedPairs =
          stage === "playoff"
            ? cup.playoffSlots / 2
            : knockoutBracketSize(cup) / 2 ** stageDepth(cup, stage);
        expect(pairs, `${cup.id}/${stage}`).toBe(expectedPairs);
        expect(matches.length, `${cup.id}/${stage} 경기 수`).toBe(
          stage === "final" ? 1 : pairs * 2,
        );
      }
      const champion = euroChampion(state, cup.id);
      expect(champion, `${cup.id} 우승 팀`).toBeTruthy();
      // 우승 팀은 이 대회 참가 팀이다
      const entrants = new Set(
        leaguePhaseOf(state, cup.id).flatMap((m) => [m.homeTeamId, m.awayTeamId]),
      );
      expect(entrants.has(champion!), `${cup.id} 우승 팀이 참가자`).toBe(true);
    }
  });

  it("결승은 중립 단판이고 나머지는 홈·원정 2차전이다", () => {
    const state = createTestGame(42);
    runKnockouts(state, "ucl");
    const finalMatch = euroStageMatches(state, "ucl", "final")[0]!;
    expect(finalMatch.neutral).toBe(true);
    expect(finalMatch.round).toBe(1);

    for (const stage of ["playoff", "r16", "qf", "sf"] as const) {
      for (const m of euroStageMatches(state, "ucl", stage)) expect(m.neutral).toBeUndefined();
      // 같은 대진의 두 경기는 홈/원정이 뒤바뀐다
      const legs = euroStageMatches(state, "ucl", stage).filter((m) => /-p0-/.test(m.id));
      expect(legs).toHaveLength(2);
      expect(legs[0]!.homeTeamId).toBe(legs[1]!.awayTeamId);
      expect(legs[0]!.awayTeamId).toBe(legs[1]!.homeTeamId);
      expect(legs[0]!.date < legs[1]!.date).toBe(true);
    }
  });

  it("상위 시드가 2차전 홈을 갖는다", () => {
    const state = createTestGame(42);
    fillResults(leaguePhaseOf(state, "ucl"));
    const seeds = computeStandings(state, "ucl").map((r) => r.teamId);
    advanceEuroKnockouts(state, []);
    for (const stage of ["playoff"] as const) {
      const matches = euroStageMatches(state, "ucl", stage);
      for (let pair = 0; pair * 2 < matches.length; pair++) {
        const [leg1, leg2] = [matches[pair * 2]!, matches[pair * 2 + 1]!];
        const better =
          seeds.indexOf(leg2.homeTeamId) < seeds.indexOf(leg2.awayTeamId)
            ? leg2.homeTeamId
            : leg2.awayTeamId;
        expect(leg2.homeTeamId, `p${pair} 2차전 홈`).toBe(better);
        expect(leg1.awayTeamId).toBe(better);
      }
    }
  });
});

describe("승자 판정", () => {
  it("합계 득점으로 가린다 (원정 다득점 규칙 없음)", () => {
    const state = createTestGame(42);
    fillResults(leaguePhaseOf(state, "ucl"));
    advanceEuroKnockouts(state, []);
    const legs = euroStageMatches(state, "ucl", "playoff").filter((m) => /-p0-/.test(m.id));
    // 1차전 원정 2골, 2차전 홈 1-0 → 합계 2-1로 원정팀(=상위 시드)이 통과
    legs[0]!.result = { homeGoals: 0, awayGoals: 2, scorers: [] };
    legs[1]!.result = { homeGoals: 1, awayGoals: 0, scorers: [] };
    expect(euroTieWinner(state, "ucl", "playoff", 0)).toBe(legs[1]!.homeTeamId);
    expect(legs[1]!.result?.penalties).toBeUndefined();
  });

  it("합계가 같으면 승부차기로 갈리고 2차전 장부에 남는다", () => {
    const state = createTestGame(42);
    fillResults(leaguePhaseOf(state, "ucl"));
    advanceEuroKnockouts(state, []);
    const legs = euroStageMatches(state, "ucl", "playoff").filter((m) => /-p0-/.test(m.id));
    legs[0]!.result = { homeGoals: 1, awayGoals: 1, scorers: [] };
    legs[1]!.result = { homeGoals: 2, awayGoals: 2, scorers: [] };

    const winner = euroTieWinner(state, "ucl", "playoff", 0);
    const pens = legs[1]!.result.penalties;
    expect(pens, "승부차기 기록").toBeDefined();
    expect(pens!.home).not.toBe(pens!.away);
    expect(winner).toBe(pens!.home > pens!.away ? legs[1]!.homeTeamId : legs[1]!.awayTeamId);
    // 같은 질문에 같은 답 — 재호출이 기록을 바꾸지 않는다
    expect(euroTieWinner(state, "ucl", "playoff", 0)).toBe(winner);
    expect(legs[1]!.result.penalties).toEqual(pens);
  });

  it("경기가 남아 있으면 승자가 없다", () => {
    const state = createTestGame(42);
    fillResults(leaguePhaseOf(state, "ucl"));
    advanceEuroKnockouts(state, []);
    expect(euroTieWinner(state, "ucl", "playoff", 0)).toBeNull();
  });
});

describe("게임 상태 반영", () => {
  it("우리 팀 녹아웃 경기가 달력에 등록된다", () => {
    const state = createTestGame(42);
    runKnockouts(state, "ucl");
    const ourKnockouts = state.matches.filter(
      (m) =>
        isCup(m.competitionId) &&
        (m.stage ?? "league") !== "league" &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    );
    expect(ourKnockouts.length).toBeGreaterThan(0);
    for (const m of ourKnockouts) {
      const entry = state.schedule.find((e) => e.type === "match" && e.refId === m.id);
      expect(entry, `${m.id} 달력 엔트리`).toBeDefined();
      expect(entry!.date).toBe(m.date);
      expect(entry!.time).toBe(m.time);
    }
    // 일정 축은 늘 정렬 상태를 유지한다
    const keys = state.schedule.map((e) => `${e.date} ${e.time}`);
    expect([...keys].sort()).toEqual(keys);
  });

  it("녹아웃은 리그 페이즈 순위표에 들어가지 않는다", () => {
    const state = createTestGame(42);
    runKnockouts(state, "ucl");
    const table = computeStandings(state, "ucl");
    const cup = cupCatalogById("ucl")!;
    for (const row of table) expect(row.played).toBeLessThanOrEqual(cup.matchesPerTeam);
  });

  it("우리 팀 단계 통과·탈락이 한 번만 보고된다", () => {
    const state = createTestGame(42);
    const digest: string[] = [];
    runKnockouts(state, "ucl", digest);
    for (const stage of ["r16", "qf", "sf"] as const) {
      const label = stageLabel(stage, 1, false);
      const lines = digest.filter((d) => d.includes(`UCL ${label} `) && /통과|탈락/.test(d));
      expect(lines.length, `${label}: ${lines.join(" | ")}`).toBeLessThanOrEqual(1);
    }
  });
});

describe("오피스 뷰", () => {
  it("우리 대회의 리그 페이즈 순위표와 브래킷이 함께 나온다", () => {
    const state = createTestGame(42);
    fillResults(leaguePhaseOf(state, "ucl"));
    advanceEuroKnockouts(state, []);
    const europe = buildOfficeViews(state).schedule.europe;
    expect(europe, "아스날은 UCL에 나간다").not.toBeNull();
    expect(europe!.short).toBe("UCL");
    expect(europe!.standings).toHaveLength(cupCatalogById("ucl")!.size);
    expect(europe!.ourPosition).toBeGreaterThan(0);
    expect(europe!.directSlots).toBe(8);
    expect(europe!.playoffCutoff).toBe(24);

    const playoff = europe!.bracket.find((b) => b.stage === "playoff");
    expect(playoff!.ties).toHaveLength(8);
    expect(playoff!.ties.every((t) => t.score === null)).toBe(true); // 아직 안 열렸다
    // 아스날은 직행이라 플레이오프에 없다
    expect(playoff!.ties.some((t) => t.ours)).toBe(false);
  });

  it("합계와 승부차기가 브래킷에 그대로 보인다", () => {
    const state = createTestGame(42);
    runKnockouts(state, "ucl");
    const europe = buildOfficeViews(state).schedule.europe!;
    const finalStage = europe.bracket.find((b) => b.stage === "final")!;
    expect(finalStage.ties).toHaveLength(1);
    expect(finalStage.ties[0]!.score).toMatch(/^\d+-\d+/);
    for (const stage of europe.bracket) {
      for (const tie of stage.ties) {
        if (tie.score?.includes("승부차기")) expect(tie.score).toMatch(/승부차기 \d+-\d+/);
      }
    }
  });

  it("뷰를 여는 것이 게임 상태를 바꾸지 않는다", () => {
    const state = createTestGame(42);
    fillResults(leaguePhaseOf(state, "ucl"));
    advanceEuroKnockouts(state, []);
    // 합계 동점으로 만들고 승부차기는 아직 기록하지 않은 상태
    const legs = euroStageMatches(state, "ucl", "playoff").filter((m) => /-p0-/.test(m.id));
    legs[0]!.result = { homeGoals: 1, awayGoals: 1, scorers: [] };
    legs[1]!.result = { homeGoals: 0, awayGoals: 0, scorers: [] };
    const before = JSON.stringify(state);
    buildOfficeViews(state);
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe("한 시즌 완주 (mock 경기)", () => {
  it("리그 페이즈부터 결승까지 돌고 트로피가 커리어에 남는다", () => {
    const state = createTestGame(42);
    const digest: string[] = [];
    let guard = 500;
    let ended = false;
    while (guard-- > 0) {
      const advanced = advanceTime(state, "next_match");
      digest.push(...advanced.digest);
      expect(advanced.ok, advanced.digest.join(" / ")).toBe(true);
      if (advanced.stopped === "season_end") {
        ended = true;
        break;
      }
      if (advanced.stopped === "matchday") {
        digest.push(...playMockMatch(state));
        continue;
      }
      if (advanced.stopped === "attention") continue;
      break; // reached — 남은 경기가 없는데 시즌이 끝나지 않았다
    }
    expect(ended, `시즌 종료에 도달하지 못했다 (${state.date})`).toBe(true);

    // 세 대회 모두 우승 팀을 남겼다 (결승은 리그 종료 뒤에 열린다)
    expect(digest.filter((d) => d.includes("우승")).length).toBeGreaterThanOrEqual(3);
    // 시즌 전환이 일정을 새 시즌으로 교체한다 — 지난 시즌 경기는 남지 않는다
    // (대항전 티켓을 지난 순위로 배정하려면 최종 순위를 따로 기록해야 한다)
    expect(state.matches.filter((m) => m.season === 1)).toHaveLength(0);

    // 우리 팀이 우승했다면 트로피가, 아니면 최소한 리그 기록이 남는다
    const cupTrophies = state.trophies.filter((t) => t.competition.startsWith("UEFA"));
    const wonUcl = digest.some((d) => d.includes("🏆 UEFA 챔피언스리그 우승"));
    expect(cupTrophies.length).toBe(wonUcl ? 1 : 0);
    expect(state.seasonRecords).toHaveLength(1);
  });
});

/** 이 단계가 본선에서 몇 번째인가 — 대진 수 기대값 계산용 */
function stageDepth(cup: (typeof CUP_CATALOG)[number], stage: string): number {
  const main = knockoutStages(cup).filter((s) => s !== "playoff");
  return main.indexOf(stage as (typeof main)[number]) + 1;
}
