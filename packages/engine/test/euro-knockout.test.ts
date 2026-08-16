import { describe, expect, it } from "vitest";
import type { CupCatalogEntry, GameState } from "@story-fm/engine";
import {
  cupCatalog,
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
  financeOf,
  payWinnerPrize,
  payStagePrizes,
  euroCompetitionOf,
  entrantsOf,
  simSquadOf,
  playerById,
  tieAggregate,
} from "@story-fm/engine";
import { createTestGame, keepSeat, playMockMatch, playPreseason } from "./helpers";

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

/**
 * 추첨일까지 시계를 옮기고 편성한다.
 *
 * 대진은 라운드가 끝나는 순간이 아니라 **며칠 뒤 추첨에서** 나온다(달력에 오르는
 * 사건이다). 이 테스트는 경기 결과를 직접 채워 넣으므로 시계도 직접 밀어 준다 —
 * 실제 게임에선 tick이 날짜를 넘기면서 자연히 추첨일에 닿는다.
 */
function advanceKnockouts(state: GameState, digest: string[] = []): void {
  advanceEuroKnockouts(state, digest); // ① 추첨 예약
  for (const e of state.schedule) {
    if (e.type === "draw" && e.status === "scheduled" && e.date > state.date) state.date = e.date;
  }
  advanceEuroKnockouts(state, digest); // ② 추첨일 도래 → 편성
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
    advanceKnockouts(state, digest);
    for (const stage of knockoutStages(cup)) fillResults(euroStageMatches(state, cupId, stage));
  }
  advanceKnockouts(state, digest);
}

describe("녹아웃 정의", () => {
  it("본선 대진 수는 2의 거듭제곱이다 (대회 규모가 달라도)", () => {
    for (const cup of cupCatalog()) {
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
    advanceKnockouts(state, []);
    expect(euroStageMatches(state, "ucl", "playoff")).toHaveLength(0);
  });

  it("한 단계가 끝날 때마다 다음 단계만 편성된다", () => {
    const state = createTestGame(42);
    fillResults(leaguePhaseOf(state, "ucl"));

    advanceKnockouts(state, []);
    expect(euroStageMatches(state, "ucl", "playoff")).toHaveLength(16); // 8대진 × 2차전
    expect(euroStageMatches(state, "ucl", "r16")).toHaveLength(0); // 아직

    advanceKnockouts(state, []); // 플레이오프가 안 끝났으니 그대로
    expect(euroStageMatches(state, "ucl", "r16")).toHaveLength(0);

    fillResults(euroStageMatches(state, "ucl", "playoff"));
    advanceKnockouts(state, []);
    expect(euroStageMatches(state, "ucl", "r16")).toHaveLength(16); // 8대진 × 2차전
  });

  it("대회마다 결승까지 도달하고 우승 팀이 하나 남는다", () => {
    for (const cup of cupCatalog()) {
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
    advanceKnockouts(state, []);
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
    advanceKnockouts(state, []);
    const legs = euroStageMatches(state, "ucl", "playoff").filter((m) => /-p0-/.test(m.id));
    // 1차전 원정 2골, 2차전 홈 1-0 → 합계 2-1로 원정팀(=상위 시드)이 통과
    legs[0]!.result = { homeGoals: 0, awayGoals: 2, scorers: [] };
    legs[1]!.result = { homeGoals: 1, awayGoals: 0, scorers: [] };
    expect(euroTieWinner(state, "ucl", "playoff", 0)).toBe(legs[1]!.homeTeamId);
    expect(legs[1]!.result?.penalties).toBeUndefined();
  });

  it("합계가 같으면 연장을 먼저 치르고, 그래도 같으면 승부차기가 2차전 장부에 남는다", () => {
    const state = createTestGame(42);
    fillResults(leaguePhaseOf(state, "ucl"));
    advanceKnockouts(state, []);
    // 대진마다 연장이 다르다 — 연장이 끝낸 대진과 승부차기까지 간 대진을 둘 다 본다
    const pairs = new Set(
      euroStageMatches(state, "ucl", "playoff").map((m) => Number(/-p(\d+)-/.exec(m.id)?.[1])),
    );
    let decidedInExtra = 0;
    let decidedOnPenalties = 0;
    for (const pair of pairs) {
      const legs = euroStageMatches(state, "ucl", "playoff").filter((m) =>
        new RegExp(`-p${pair}-`).test(m.id),
      );
      legs[0]!.result = { homeGoals: 1, awayGoals: 1, scorers: [] };
      legs[1]!.result = { homeGoals: 2, awayGoals: 2, scorers: [] };

      const winner = euroTieWinner(state, "ucl", "playoff", pair);
      const result = legs[1]!.result;
      expect(result.aet, "연장 표식").toBe(true); // 승부차기 앞에 연장이 있다
      const agg = tieAggregate(legs, legs[1]!);
      if (agg.home === agg.away) {
        const pens = result.penalties;
        expect(pens, "승부차기 기록").toBeDefined();
        expect(pens!.home).not.toBe(pens!.away);
        expect(winner).toBe(pens!.home > pens!.away ? legs[1]!.homeTeamId : legs[1]!.awayTeamId);
        decidedOnPenalties++;
      } else {
        expect(result.penalties).toBeUndefined(); // 연장에서 갈렸으면 승부차기는 없다
        expect(winner).toBe(agg.home > agg.away ? legs[1]!.homeTeamId : legs[1]!.awayTeamId);
        decidedInExtra++;
      }
      // 같은 질문에 같은 답 — 재호출이 기록을 바꾸지 않는다
      const score = { home: result.homeGoals, away: result.awayGoals };
      expect(euroTieWinner(state, "ucl", "playoff", pair)).toBe(winner);
      expect({ home: result.homeGoals, away: result.awayGoals }).toEqual(score);
    }
    expect(decidedInExtra + decidedOnPenalties).toBe(pairs.size);
    expect(decidedOnPenalties).toBeGreaterThan(0); // 연장도 조용한 대진은 있다
  });

  it("경기가 남아 있으면 승자가 없다", () => {
    const state = createTestGame(42);
    fillResults(leaguePhaseOf(state, "ucl"));
    advanceKnockouts(state, []);
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
    advanceKnockouts(state, []);
    // 대회 목록: 리그 → 대항전 → 국내 컵. 대항전이 첫 컵이다
    const comp = buildOfficeViews(state).competitions.list.find((c) => c.europe !== null) ?? null;
    expect(comp, "아스날은 UCL에 나간다").not.toBeNull();
    const europe = comp!.europe;
    expect(europe!.short).toBe("UCL");
    expect(europe!.standings).toHaveLength(cupCatalogById("ucl")!.size);
    expect(europe!.ourPosition).toBeGreaterThan(0);
    expect(europe!.directSlots).toBe(8);
    expect(europe!.playoffCutoff).toBe(24);

    const playoff = comp!.bracket.find((b) => b.stage === "playoff");
    expect(playoff!.ties).toHaveLength(8);
    expect(playoff!.ties.every((t) => t.score === null)).toBe(true); // 아직 안 열렸다
    // 아스날은 직행이라 플레이오프에 없다
    expect(playoff!.ties.some((t) => t.ours)).toBe(false);
  });

  it("합계와 승부차기가 브래킷에 그대로 보인다", () => {
    const state = createTestGame(42);
    runKnockouts(state, "ucl");
    const comp = buildOfficeViews(state).competitions.list.find((c) => c.europe !== null)!;
    const finalStage = comp.bracket.find((b) => b.stage === "final")!;
    expect(finalStage.ties).toHaveLength(1);
    expect(finalStage.ties[0]!.score).toMatch(/^\d+-\d+/);
    for (const stage of comp.bracket) {
      for (const tie of stage.ties) {
        if (tie.score?.includes("승부차기")) expect(tie.score).toMatch(/승부차기 \d+-\d+/);
      }
    }
  });

  it("뷰를 여는 것이 게임 상태를 바꾸지 않는다", () => {
    const state = createTestGame(42);
    fillResults(leaguePhaseOf(state, "ucl"));
    advanceKnockouts(state, []);
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
      // 대회 진행을 재는 동안 자리는 지킨다 — 경질은 시계를 멈춘다(reviewUserSeat)
      keepSeat(state);
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
    // 시즌 340일을 하루씩 도는 통합 테스트 — 병렬 실행 부하까지 감안해 여유를 준다
  }, 120_000);
});

/** 이 단계가 본선에서 몇 번째인가 — 대진 수 기대값 계산용 */
function stageDepth(cup: CupCatalogEntry, stage: string): number {
  const main = knockoutStages(cup).filter((s) => s !== "playoff");
  return main.indexOf(stage as (typeof main)[number]) + 1;
}

describe("상금", () => {
  it("리그 페이즈 정산은 참가비 + 승/무 수당이고 한 번만 들어온다", () => {
    const state = createTestGame(42);
    const cup = cupCatalogById("ucl")!;
    const before = financeOf(state, state.userTeamId).balance;
    // 우리 팀 경기를 3승 2무 3패로 채운다 (나머지는 홈 승)
    const ours = leaguePhaseOf(state, "ucl").filter(
      (m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId,
    );
    ours.forEach((m, i) => {
      const home = m.homeTeamId === state.userTeamId;
      const win = i < 3;
      const draw = i >= 3 && i < 5;
      m.result = draw
        ? { homeGoals: 1, awayGoals: 1, scorers: [] }
        : win === home
          ? { homeGoals: 2, awayGoals: 0, scorers: [] }
          : { homeGoals: 0, awayGoals: 2, scorers: [] };
    });
    fillResults(leaguePhaseOf(state, "ucl"));

    const digest: string[] = [];
    advanceKnockouts(state, digest);
    const expected = cup.prize.participation + 3 * cup.prize.win + 2 * cup.prize.draw;
    const ledger = financeOf(state, state.userTeamId).ledger.filter((e) =>
      e.label.includes("리그 페이즈 상금"),
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.amount).toBe(expected);
    expect(digest.some((d) => d.includes("리그 페이즈 상금"))).toBe(true);

    // 여러 번 호출해도 다시 주지 않는다
    const balance = financeOf(state, state.userTeamId).balance;
    advanceKnockouts(state, []);
    advanceKnockouts(state, []);
    expect(financeOf(state, state.userTeamId).balance).toBe(balance);
    expect(balance).toBeGreaterThan(before);
  });

  it("단계마다 진출 상금이 그 단계의 팀 전원에게 들어간다", () => {
    const state = createTestGame(42);
    const cup = cupCatalogById("ucl")!;
    runKnockouts(state, "ucl");
    // 지급 사실은 prizesPaid 키가 갖는다 — AI 팀은 상세 원장을 쌓지 않는다.
    // 항목명은 정확히 비교한다 — "준결승 진출 상금"은 "결승 진출 상금"을 포함한다
    const paidFor = (stage: "r16" | "qf" | "sf" | "final") => {
      const label = `UCL ${stageLabel(stage, 1, false)} 진출 상금 (S1)`;
      return state.finances.filter((f) => (f.prizesPaid ?? []).includes(label)).length;
    };
    expect(paidFor("r16")).toBe(16);
    expect(paidFor("qf")).toBe(8);
    expect(paidFor("sf")).toBe(4);
    expect(paidFor("final")).toBe(2);
    // 금액은 카탈로그 값 그대로 — 상세 원장을 갖는 유저 팀에 직접 지급해 확인한다
    const fresh = createTestGame(42);
    payStagePrizes(fresh, "ucl", "r16", [fresh.userTeamId], []);
    const entry = financeOf(fresh, fresh.userTeamId).ledger.find(
      (e) => e.label === "UCL 16강 진출 상금 (S1)",
    );
    expect(entry?.amount).toBe(cup.prize.stage.r16);
    expect(entry?.category).toBe("prize");
  });

  it("우승 상금은 시즌 리뷰에서 우승 팀에게만 간다", () => {
    const state = createTestGame(42);
    runKnockouts(state, "ucl");
    const champion = euroChampion(state, "ucl")!;
    const cup = cupCatalogById("ucl")!;
    const before = financeOf(state, champion).balance;
    payWinnerPrize(state, "ucl", champion, []);
    payWinnerPrize(state, "ucl", champion, []); // 두 번 불러도 한 번만
    // 지급 사실은 prizesPaid가 갖는다 (AI 팀은 원장을 쌓지 않는다)
    const paid = state.finances.filter((f) => (f.prizesPaid ?? []).includes("UCL 우승 상금 (S1)"));
    expect(paid).toHaveLength(1);
    expect(paid[0]!.teamId).toBe(champion);
    expect(financeOf(state, champion).balance - before).toBe(cup.prize.winner);
  });

  it("우승 경로 총액이 tier 1 시즌 수입의 3분의 1 수준이다 (밸런스 기준선)", () => {
    const cup = cupCatalogById("ucl")!;
    const stages = Object.values(cup.prize.stage).reduce((s, v) => s + (v ?? 0), 0);
    // 5승 2무 1패로 우승했을 때
    const total =
      cup.prize.participation + 5 * cup.prize.win + 2 * cup.prize.draw + stages + cup.prize.winner;
    const seasonIncome = 12 * (13_000_000 + 6_000_000); // 중계권 + 스폰서 (tier 1)
    expect(total / seasonIncome).toBeGreaterThan(0.2);
    expect(total / seasonIncome).toBeLessThan(0.4);
  });
});

describe("주중 경기 부담 (로테이션)", () => {
  it("AI 팀도 경기마다 피로가 쌓이고, 지친 선발은 로테이션된다", () => {
    const state = createTestGame(42);
    const cup = euroCompetitionOf(state.euroEntrants, state.userTeamId)!;
    // 우리 팀이 아닌 대항전 참가 팀을 하나 고른다 (간이 시뮬 대상)
    const rival = entrantsOf(state.euroEntrants, cup).find((id) => id !== state.userTeamId)!;

    const before = simSquadOf(state, rival).starters.map((p) => p.id);
    expect(before).toHaveLength(11);
    // 선발 전원을 로테이션 기준 위로 지치게 만든다
    for (const id of before) playerById(state, id)!.state.condition = 20;

    const after = simSquadOf(state, rival).starters;
    expect(after).toHaveLength(11);
    const changed = after.filter((p) => !before.includes(p.id));
    expect(changed.length, "지친 선발 일부가 교체된다").toBeGreaterThan(0);
    // 대체 자원은 신선하다 — 지쳐 빠진 선발(20)보다 체력이 높아야 한다
    for (const p of changed) expect(p.state.condition).toBeGreaterThan(20);
  });

  it("간이 시뮬을 치른 AI 팀 선발은 피로가 오른다", () => {
    const state = createTestGame(42);
    const digest: string[] = [];
    const fatigueBefore = new Map(state.players.map((p) => [p.id, p.state.condition]));
    // 첫 리그 라운드까지 전진 — 우리 경기가 아닌 경기들이 간이 시뮬로 소화된다.
    // 프리시즌 친선이 먼저 걸리므로 치르고 간다 (경기일엔 시계가 선다)
    playPreseason(state);
    let guard = 20;
    while (guard-- > 0) {
      const advanced = advanceTime(state, { days: 7 });
      digest.push(...advanced.digest);
      if (state.matches.some((m) => m.result)) break;
      if (advanced.stopped === "matchday") break;
    }
    const played = state.matches.filter((m) => m.result);
    expect(played.length, "간이 시뮬이 돌았다").toBeGreaterThan(0);
    const tired = state.players.filter(
      (p) => p.state.condition > (fatigueBefore.get(p.id) ?? 0) + 20,
    );
    expect(tired.length, "경기를 뛴 선수들의 피로가 올랐다").toBeGreaterThan(0);
  });
});
