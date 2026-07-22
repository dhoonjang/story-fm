import { describe, expect, it } from "vitest";
import { TeamSchema } from "@story-fm/domain";
import {
  buildFixtures,
  buildSeasonCalendar,
  generateLeague,
  interpretBackgroundHeuristic,
  ONBOARDING_TOTAL,
  TEAM_CATALOG,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

describe("리그 생성", () => {
  it("20팀, 팀당 16명, 도메인 스키마를 통과한다", () => {
    const teams = generateLeague(7);
    expect(teams).toHaveLength(20);
    for (const team of teams) {
      expect(team.players).toHaveLength(16);
      expect(() => TeamSchema.parse(team)).not.toThrow();
      expect(team.startingXI).toHaveLength(11);
    }
  });

  it("결정적이다 — 같은 시드는 같은 리그", () => {
    expect(generateLeague(7)).toEqual(generateLeague(7));
    expect(generateLeague(7)).not.toEqual(generateLeague(8));
  });

  it("tier 1 팀이 tier 4 팀보다 평균 overall이 높다", () => {
    const teams = generateLeague(7);
    const avg = (id: string) => {
      const t = teams.find((x) => x.id === id);
      if (!t) throw new Error(id);
      return t.players.reduce((s, p) => s + p.attributes.overall, 0) / t.players.length;
    };
    expect(avg("arsenal")).toBeGreaterThan(avg("southampton") + 5);
  });
});

describe("시즌 캘린더", () => {
  it("38라운드 더블 라운드로빈 — 팀당 38경기, 홈 19 어웨이 19", () => {
    const ids = TEAM_CATALOG.map((t) => t.id);
    const fixtures = buildFixtures(ids, "2026-08-15");
    expect(fixtures).toHaveLength(380);
    for (const id of ids) {
      const mine = fixtures.filter((f) => f.homeId === id || f.awayId === id);
      expect(mine).toHaveLength(38);
      expect(mine.filter((f) => f.homeId === id)).toHaveLength(19);
    }
    // 같은 라운드에 한 팀이 두 번 나오지 않는다
    for (let r = 1; r <= 38; r++) {
      const round = fixtures.filter((f) => f.round === r);
      const seen = new Set(round.flatMap((f) => [f.homeId, f.awayId]));
      expect(seen.size).toBe(20);
    }
  });

  it("이적시장 기간 판정", () => {
    const cal = buildSeasonCalendar(1, TEAM_CATALOG.map((t) => t.id));
    expect(cal.windows.summer.open).toBe("2026-07-01");
    expect(cal.windows.winter.open).toBe("2027-01-01");
  });
});

describe("온보딩 — 배경 직접 입력 해석 (결정 #11)", () => {
  it("합계가 항상 고정 총점이다", () => {
    for (const bg of ["선수 출신 주장", "데이터 분석가", "에이전트로 일했다", "축구 유튜버", ""]) {
      const attrs = interpretBackgroundHeuristic(bg);
      const total = attrs.leadership + attrs.tactics + attrs.negotiation + attrs.media;
      expect(total).toBe(ONBOARDING_TOTAL);
    }
  });

  it("배경 키워드가 해당 축을 끌어올린다", () => {
    const player = interpretBackgroundHeuristic("프리미어리그에서 뛰었던 주장 출신 수비수");
    const agent = interpretBackgroundHeuristic("선수 에이전트로 협상 경력 10년");
    expect(player.leadership).toBeGreaterThan(agent.leadership);
    expect(agent.negotiation).toBeGreaterThan(player.negotiation);
  });
});

describe("게임 생성", () => {
  it("초기 상태가 유효하다", () => {
    const state = createTestGame();
    expect(state.teams).toHaveLength(20);
    expect(state.phase).toBe("idle");
    expect(state.calendar.fixtures.filter((f) => f.result)).toHaveLength(0);
    expect(state.date < state.calendar.start).toBe(true);
    expect(state.manager.name).toBe("김감독");
  });
});
