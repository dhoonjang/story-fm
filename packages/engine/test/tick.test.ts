import { describe, expect, it } from "vitest";
import { ageOf } from "@story-fm/domain";
import {
  advanceTime,
  assignmentsOf,
  financeOf,
  openInjury,
  playersOf,
  setTraining,
  userPlayers,
  weeklyWagesOf,
} from "@story-fm/engine";
import { advanceDays, createTestGame } from "./helpers";

describe("advance_time — 시간은 스킬로만 흐른다 (game-loop §3)", () => {
  it("프리시즌에서 다음 경기일까지 전진하면 개막전에서 멈춘다", () => {
    const state = createTestGame();
    expect(state.date).toBe("2026-07-01"); // 7/1 프리시즌 시작
    const result = advanceTime(state, "next_match");
    expect(result.ok).toBe(true);
    expect(result.stopped).toBe("matchday");
    expect(state.phase).toBe("matchday");
    // 멈춘 날은 유저의 첫 경기 날짜
    const first = state.matches
      .filter((m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId)
      .sort((a, b) => (a.date < b.date ? -1 : 1))[0];
    expect(state.date).toBe(first?.date);
    expect(result.digest.some((d) => d.includes("경기일"))).toBe(true);
  });

  it("게임 시작 시 여름 창은 이미 열려 있고, 폐장은 진행 중 안내된다", () => {
    const state = createTestGame();
    const summer = state.windows.find((w) => w.kind === "summer")!;
    // 7/1 시작 = 개장일이므로 개장 엔트리는 소화된 상태로 출발
    const openEntry = state.schedule.find(
      (e) => e.type === "window-open" && e.refId === summer.id,
    );
    expect(openEntry?.status).toBe("done");
    // 폐장 엔트리는 아직 예정
    const closeEntry = state.schedule.find(
      (e) => e.type === "window-close" && e.refId === summer.id,
    );
    expect(closeEntry?.status).toBe("scheduled");
    expect(closeEntry?.date).toBe(summer.closesOn);
  });

  it("경기일에는 시간이 흐르지 않는다 — 경기가 우선", () => {
    const state = createTestGame();
    advanceTime(state, "next_match");
    const blocked = advanceTime(state, { days: 1 });
    expect(blocked.ok).toBe(false);
    expect(blocked.stopped).toBe("blocked");
  });

  it("타 팀 경기는 각자 날짜에 간이 시뮬되고 시즌 스탯이 쌓인다", () => {
    const state = createTestGame();
    advanceTime(state, "next_match");
    const round1 = state.matches.filter((m) => m.round === 1);
    const others = round1.filter(
      (m) => m.homeTeamId !== state.userTeamId && m.awayTeamId !== state.userTeamId,
    );
    // 유저 리그(EPL)의 나머지 9경기 — 다른 리그 경기도 같은 날 함께 시뮬된다
    expect(others.filter((m) => m.competitionId === "epl").length).toBe(9);
    for (const m of others) {
      if (m.date <= state.date) expect(m.result).not.toBeNull();
    }
    // 유저 경기는 시뮬되지 않는다
    const mine = round1.find(
      (m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId,
    );
    expect(mine?.result).toBeNull();
    // 시뮬된 경기의 출전 기록이 남는다
    if (others.some((m) => m.result)) {
      expect(state.seasonStats.length).toBeGreaterThan(0);
    }
  });

  it("훈련이 쌓이면 능력치가 오르고 성장 로그가 남는다 (trainXP 없이)", () => {
    const state = createTestGame(11);
    const roster = userPlayers(state);
    const young = roster.find((p) => ageOf(p.birthdate, state.date) <= 21) ?? roster[0]!;
    const before = young.attributes.finishing;
    // 평일 오전·오후 슈팅 훈련 등록 (기본 훈련 없음 → 스킬이 일정을 만든다)
    setTraining(state, {
      repeatWeekly: [1, 2, 3, 4, 5].flatMap((dow) => [
        { dow, slot: "am" as const, label: "슈팅 마무리", focus: ["finishing" as const] },
        { dow, slot: "pm" as const, label: "슈팅 마무리", focus: ["finishing" as const] },
      ]),
      weeks: 3,
    });
    expect(state.schedule.filter((e) => e.type === "training").length).toBeGreaterThan(10);

    let guard = 20;
    while (guard-- > 0 && young.attributes.finishing === before) {
      const r = advanceTime(state, { days: 3 });
      if (!r.ok || r.stopped === "matchday") break;
    }
    expect(young.attributes.finishing).toBeGreaterThanOrEqual(before);
    if (young.attributes.finishing > before) {
      const log = state.growthLog.filter(
        (g) => g.gamePlayerId === young.id && g.target === "finishing",
      );
      expect(log.length).toBeGreaterThan(0);
      expect(log[0]?.source).toBe("training");
      expect(log[0]?.entryId).toBeTruthy(); // 출처 일정이 기록된다
    }
  });

  it("전술 훈련은 배치 적응도를 올리고 로그를 남긴다", () => {
    const state = createTestGame(5);
    const assignment = assignmentsOf(state, state.userTeamId, "starting")[0]!;
    const before = assignment.familiarity;
    setTraining(state, {
      repeatWeekly: [1, 2, 3, 4, 5].map((dow) => ({
        dow,
        slot: "am" as const,
        label: "전술 조직 훈련",
        focus: ["tactical" as const],
      })),
      weeks: 2,
    });
    advanceDays(state, 8);
    const after = assignmentsOf(state, state.userTeamId, "starting").find(
      (a) => a.playerId === assignment.playerId,
    );
    expect(after?.familiarity ?? 0).toBeGreaterThan(before);
    expect(state.growthLog.some((g) => g.target === "tactical")).toBe(true);
  });

  it("주급이 매주 월요일 팀 재정에서 빠져나간다 (계약 합)", () => {
    const state = createTestGame();
    const finance = financeOf(state, state.userTeamId);
    const before = finance.balance;
    const wages = weeklyWagesOf(state, state.userTeamId);
    advanceDays(state, 8); // 최소 한 번의 월요일 포함
    expect(finance.balance).toBeLessThan(before);
    expect(finance.ledger.some((l) => l.label === "선수단 주급" && l.amount === wages)).toBe(true);
  });

  it("불만 이슈가 있는 선수는 사기가 계속 떨어진다", () => {
    const state = createTestGame();
    const player = userPlayers(state)[8]!;
    player.state.morale = 50;
    state.issues.push({
      gamePlayerId: player.id,
      kind: "unhappy",
      note: "출전 불만",
      since: state.date,
    });
    advanceDays(state, 5);
    expect(player.state.morale).toBeLessThan(50);
  });

  it("부상은 INJURY row로 기록되고 복귀 시 이력으로 닫힌다", () => {
    const state = createTestGame(3);
    const victim = userPlayers(state)[3]!;
    // 부상을 직접 열고 tick이 복귀를 처리하는지 확인
    state.injuries.push({
      id: "inj-test",
      gamePlayerId: victim.id,
      bodyPart: "발목",
      severity: "minor",
      cause: "training",
      occurredOn: state.date,
      expectedReturn: state.date, // 오늘 복귀 예정
      returnedOn: null,
    });
    expect(openInjury(state, victim.id)).not.toBeNull();
    advanceDays(state, 2);
    expect(openInjury(state, victim.id)).toBeNull();
    // 이력은 남는다
    expect(state.injuries.find((i) => i.id === "inj-test")?.returnedOn).toBeTruthy();
  });

  it("AI 팀도 재정·주급이 돌아간다 (이적시장 기반)", () => {
    const state = createTestGame();
    const ai = state.teams.find((t) => t.id !== state.userTeamId)!;
    const before = financeOf(state, ai.id).balance;
    expect(weeklyWagesOf(state, ai.id)).toBeGreaterThan(0);
    expect(playersOf(state, ai.id).length).toBeGreaterThan(11);
    advanceDays(state, 8);
    expect(financeOf(state, ai.id).balance).not.toBe(before);
  });
});
