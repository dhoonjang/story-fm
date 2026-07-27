import { describe, expect, it } from "vitest";
import {
  GamePlayerSchema,
  TeamTacticsSchema,
  clusterOf,
  naturalPositionOf,
  sameCluster,
} from "@story-fm/domain";
import {
  teamsOfLeague,
  buildMatches,
  buildTransferWindows,
  interpretBackgroundHeuristic,
  ONBOARDING_TOTAL,
  playerCatalog,
  playersOf,
  assignmentsOf,
  activeContract,
  weeklyWagesOf,
} from "@story-fm/engine";
import { createTestGame, userFixtureCount } from "./helpers";

describe("선수 카탈로그 (불변 초기치 DB)", () => {
  const catalog = playerCatalog();

  it("5대 리그 96팀 · 3,800명+ · 전역 id 유일", () => {
    expect(new Set(catalog.map((e) => e.teamId)).size).toBe(96);
    expect(catalog.length).toBeGreaterThanOrEqual(3800);
    expect(new Set(catalog.map((e) => e.id)).size).toBe(catalog.length);
  });

  it("전 선수가 goalkeeping을 갖는다 — 예외 분기 없음 (v6)", () => {
    for (const e of catalog) {
      expect(typeof e.goalkeeping).toBe("number");
      expect(e.goalkeeping).toBeGreaterThan(0);
    }
    // 필드 플레이어는 낮고, GK는 높다
    const gks = catalog.filter((e) => e.positions.some((p) => p.isNatural && p.position === "GK"));
    const outfield = catalog.filter((e) => !e.positions.some((p) => p.isNatural && p.position === "GK"));
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean(gks.map((e) => e.goalkeeping))).toBeGreaterThan(
      mean(outfield.map((e) => e.goalkeeping)) + 30,
    );
  });

  it("주 포지션 정확히 1개 + 멀티 포지션 적응도를 갖는다", () => {
    for (const e of catalog) {
      expect(e.positions.filter((p) => p.isNatural)).toHaveLength(1);
      for (const p of e.positions) {
        expect(p.proficiency).toBeGreaterThan(0);
        expect(p.proficiency).toBeLessThanOrEqual(99);
      }
    }
    // 필드 플레이어 대다수는 부포지션을 갖는다 (GK는 전문 포지션)
    const outfield = catalog.filter((e) => naturalPositionOf(e).position !== "GK");
    const multi = outfield.filter((e) => e.positions.length > 1);
    expect(multi.length).toBeGreaterThan(outfield.length * 0.8);
  });

  it("사실상 같은 자리(CB↔RCB/LCB 등)는 적응도가 거의 같다", () => {
    let compared = 0;
    for (const e of catalog) {
      const nat = naturalPositionOf(e);
      const cluster = clusterOf(nat.position);
      if (!cluster) continue;
      // 묶음 전체를 갖고 있어야 한다 — 좌우 분화는 다른 자리가 아니다
      for (const code of cluster) {
        const own = e.positions.find((p) => p.position === code);
        expect(own, `${e.nameEn} (${nat.position}) 에 ${code} 없음`).toBeDefined();
        expect(nat.proficiency - own!.proficiency).toBeLessThanOrEqual(3);
        expect(own!.proficiency).toBeLessThanOrEqual(nat.proficiency);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(1000); // 중앙 계열이 카탈로그의 큰 몫
  });

  it("묶음 밖 확장 포지션은 여전히 뚜렷하게 낮다", () => {
    // 적응도가 "다 비슷해지는" 반대 방향 붕괴를 막는다
    const outside = catalog.flatMap((e) => {
      const nat = naturalPositionOf(e);
      return e.positions
        .filter((p) => !p.isNatural && !sameCluster(nat.position, p.position))
        .map((p) => nat.proficiency - p.proficiency);
    });
    expect(outside.length).toBeGreaterThan(1000);
    expect(Math.min(...outside)).toBeGreaterThan(3);
  });

  it("결정적이다 — 같은 카탈로그가 반복 호출에도 동일", () => {
    expect(playerCatalog()).toEqual(catalog);
  });
});

describe("게임 생성 (7월 1일 프리시즌 시작)", () => {
  const state = createTestGame();

  it("7월 1일에 시작하고 여름 이적창이 열려 있다", () => {
    expect(state.date).toBe("2026-07-01");
    expect(state.calendar.preseasonStart).toBe("2026-07-01");
    expect(state.date < state.calendar.start).toBe(true); // 프리시즌
    const summer = state.windows.find((w) => w.kind === "summer");
    expect(summer?.opensOn).toBe("2026-07-01");
    expect(state.date >= (summer?.opensOn ?? "")).toBe(true);
  });

  it("리그 개막은 8월 중순 금요일 밤 (실제 EPL처럼 개막전 1경기가 금요일)", () => {
    expect(state.calendar.start.startsWith("2026-08")).toBe(true);
    expect(new Date(`${state.calendar.start}T00:00:00Z`).getUTCDay()).toBe(5);
    // 개막일에 정확히 1경기 — 나머지 라운드는 주말에 흩어진다
    // 리그마다 금요일 개막전이 1경기씩 (5개 리그 = 5경기)
    const openerDay = state.matches.filter(
      (m) => m.date === state.calendar.start && m.competitionId === "epl",
    );
    expect(openerDay).toHaveLength(1);
  });

  it("팀·선수·전술·재정·계약이 인스턴스화된다", () => {
    expect(state.teams).toHaveLength(96);
    expect(state.players.length).toBeGreaterThanOrEqual(3800);
    expect(state.tactics).toHaveLength(96);
    expect(state.finances).toHaveLength(96);
    expect(state.contracts).toHaveLength(state.players.length);
    for (const p of state.players) {
      expect(() => GamePlayerSchema.parse(p)).not.toThrow();
      expect(p.catalogId).toBe(p.id); // 시드 선수는 카탈로그 링크를 갖는다
    }
    for (const t of state.tactics) {
      expect(() => TeamTacticsSchema.parse(t)).not.toThrow();
    }
  });

  it("팀마다 선발 11 + 벤치 배치가 있고 GK가 정확히 1명이다", () => {
    for (const team of state.teams) {
      const starters = assignmentsOf(state, team.id, "starting");
      expect(starters).toHaveLength(11);
      expect(starters.filter((a) => a.position === "GK")).toHaveLength(1);
      expect(assignmentsOf(state, team.id, "bench").length).toBeGreaterThan(0);
      // 배치는 모두 그 팀 선수
      const ids = new Set(playersOf(state, team.id).map((p) => p.id));
      for (const a of assignmentsOf(state, team.id)) expect(ids.has(a.playerId)).toBe(true);
    }
  });

  it("계약이 주급의 원본 — 팀 주급 총액은 활성 계약의 합", () => {
    const team = state.userTeamId;
    const sum = state.contracts
      .filter((c) => c.status === "active" && c.teamId === team)
      .reduce((s, c) => s + c.weeklyWage, 0);
    expect(weeklyWagesOf(state, team)).toBe(sum);
    expect(sum).toBeGreaterThan(0);
    for (const p of playersOf(state, team)) {
      expect(activeContract(state, p.id)).not.toBeNull();
    }
  });

  it("주장이 정확히 1명이다", () => {
    expect(playersOf(state, state.userTeamId).filter((p) => p.isCaptain)).toHaveLength(1);
  });

  it("초기 상태 — 기록 테이블은 비어 있고 훈련도 없다", () => {
    expect(state.injuries).toHaveLength(0);
    expect(state.bookings).toHaveLength(0);
    expect(state.suspensions).toHaveLength(0);
    expect(state.growthLog).toHaveLength(0);
    expect(state.trainingSessions).toHaveLength(0);
    expect(state.schedule.filter((e) => e.type === "training")).toHaveLength(0);
    expect(state.phase).toBe("idle");
  });

  it("tier가 낮을수록(강할수록) 평균 overall이 높다", () => {
    const avg = (id: string) => {
      const roster = playersOf(state, id);
      return roster.reduce((s, p) => s + p.attributes.overall, 0) / roster.length;
    };
    expect(avg("arsenal")).toBeGreaterThan(avg("hull") + 3);
  });
});

describe("시즌 일정 (일정 축)", () => {
  it("38라운드 더블 라운드로빈 — 팀당 38경기, 홈 19 어웨이 19", () => {
    const ids = teamsOfLeague("epl").map((t) => t.id);
    const matches = buildMatches(1, ids);
    expect(matches).toHaveLength(380);
    for (const id of ids) {
      const mine = matches.filter((m) => m.homeTeamId === id || m.awayTeamId === id);
      expect(mine).toHaveLength(38);
      expect(mine.filter((m) => m.homeTeamId === id)).toHaveLength(19);
    }
    for (let r = 1; r <= 38; r++) {
      const round = matches.filter((m) => m.round === r);
      expect(new Set(round.flatMap((m) => [m.homeTeamId, m.awayTeamId])).size).toBe(20);
    }
  });

  it("경기·이적창이 SCHEDULE_ENTRY로 등록된다 (시간 포함)", () => {
    const state = createTestGame();
    const matchEntries = state.schedule.filter((e) => e.type === "match");
    // 우리 리그 380경기 전체 + 우리 팀 대항전 경기 (남의 대항전은 달력에 없다)
    expect(matchEntries).toHaveLength(380 + (userFixtureCount(state) - 38));
    for (const e of matchEntries) expect(e.time).toMatch(/^\d{2}:\d{2}$/);
    // 이적창 개장·폐장 = 창 2개 × 2
    expect(state.schedule.filter((e) => e.type === "window-open")).toHaveLength(2);
    expect(state.schedule.filter((e) => e.type === "window-close")).toHaveLength(2);
    // 정렬 — 날짜·시간 순
    const dates = state.schedule.map((e) => `${e.date} ${e.time}`);
    expect([...dates].sort()).toEqual(dates);
  });

  it("이적창은 여름(7/1~9/1)·겨울(1/1~2/1)", () => {
    const windows = buildTransferWindows(1);
    expect(windows.map((w) => w.kind)).toEqual(["summer", "winter"]);
    expect(windows[0]?.opensOn).toBe("2026-07-01");
    expect(windows[0]?.closesOn).toBe("2026-09-01");
    expect(windows[1]?.opensOn).toBe("2027-01-01");
  });
});

describe("온보딩 — 배경 직접 입력 해석 (결정 #11)", () => {
  it("합계가 항상 고정 총점이다", () => {
    for (const bg of ["선수 출신 주장", "데이터 분석가", "에이전트로 일했다", "축구 유튜버", ""]) {
      const attrs = interpretBackgroundHeuristic(bg);
      expect(attrs.leadership + attrs.tactics + attrs.negotiation + attrs.media).toBe(
        ONBOARDING_TOTAL,
      );
    }
  });

  it("배경 키워드가 해당 축을 끌어올린다", () => {
    const player = interpretBackgroundHeuristic("프리미어리그에서 뛰었던 주장 출신 수비수");
    const agent = interpretBackgroundHeuristic("선수 에이전트로 협상 경력 10년");
    expect(player.leadership).toBeGreaterThan(agent.leadership);
    expect(agent.negotiation).toBeGreaterThan(player.negotiation);
  });
});
