import { describe, expect, it } from "vitest";
import { ageOf } from "@story-fm/domain";
import {
  buildOfficeViews,
  financeOf,
  humanizePlayerIds,
  setTraining,
  userPlayers,
} from "@story-fm/engine";
import { advanceAndPlay, advanceDays, advanceToMatchday, createTestGame, playMockMatch, userFixtureCount } from "./helpers";

describe("오피스 뷰 — 스쿼드", () => {
  it("나이·포지션 목록·계약·배치가 파생 표시된다", () => {
    const state = createTestGame();
    const views = buildOfficeViews(state);
    const row = views.squad.players[0]!;
    const player = userPlayers(state).find((p) => p.id === row.id)!;

    expect(row.age).toBe(ageOf(player.birthdate, state.date));
    expect(row.positions.length).toBeGreaterThan(0);
    expect(row.positions.filter((p) => p.isNatural)).toHaveLength(1);
    expect(row.weeklyWage).toBeGreaterThan(0);
    expect(row.contractUntil).toBeTruthy();
    expect(row.goalkeeping).toBeGreaterThan(0); // 전 선수 GK 능력치
    expect(["선발", "벤치", "스쿼드"]).toContain(row.role);
    expect(views.squad.players.filter((p) => p.role === "선발")).toHaveLength(11);
    expect(views.squad.players.filter((p) => p.isCaptain)).toHaveLength(1);
  });

  it("부상·정지는 파생 객체로 노출된다", () => {
    const state = createTestGame();
    const player = userPlayers(state)[3]!;
    state.injuries.push({
      id: "inj-v",
      gamePlayerId: player.id,
      bodyPart: "무릎",
      severity: "moderate",
      cause: "match",
      occurredOn: state.date,
      expectedReturn: "2026-09-01",
      returnedOn: null,
    });
    const row = buildOfficeViews(state).squad.players.find((p) => p.id === player.id)!;
    expect(row.injury?.bodyPart).toBe("무릎");
    expect(row.injury?.severity).toBe("중상");
    expect(row.available).toBe(false);
  });
});

describe("오피스 뷰 — 달력 (일정 축)", () => {
  it("경기·훈련·이적창이 한 축에 시간과 함께 나온다", () => {
    const state = createTestGame();
    setTraining(state, {
      sessions: [{ date: "2026-07-06", slot: "am", label: "패스 훈련", focus: ["passing"] }],
    });
    const cal = buildOfficeViews(state).calendar;

    expect(cal.today).toBe("2026-07-01");
    expect(cal.preseasonStart).toBe("2026-07-01");
    // 유저 팀 경기만 (리그 38 + 대항전)
    expect(cal.entries.filter((e) => e.type === "match")).toHaveLength(userFixtureCount(state));
    const training = cal.entries.find((e) => e.type === "training");
    expect(training?.time).toBe("10:00");
    expect(training?.title).toContain("패스 훈련");
    // 이적창 엔트리
    expect(cal.entries.some((e) => e.type === "window-open")).toBe(true);
    expect(cal.windows.find((w) => w.kind === "여름")?.open).toBe(true);
  });

  it("일지는 저장하지 않고 기록 테이블에서 파생된다", () => {
    const state = createTestGame(13);
    // diary 필드가 상태에 없다 (v6)
    expect("diary" in state).toBe(false);

    setTraining(state, {
      repeatWeekly: [{ dow: 2, slot: "am", label: "체력 훈련", focus: ["strength"] }],
      weeks: 2,
    });
    advanceDays(state, 9);
    const events = buildOfficeViews(state).calendar.events;
    const lines = Object.values(events).flat();
    // 완료된 훈련이 일지에 나타난다
    expect(lines.some((l) => l.includes("체력 훈련"))).toBe(true);
  });

  it("일지에는 미래 일정이 들어가지 않는다 (지나간 일만)", () => {
    const state = createTestGame();
    const cal = buildOfficeViews(state).calendar;
    // 7/1 시작 시점 — 겨울 이적창(2027-01)은 아직 일어나지 않았다
    for (const [date, lines] of Object.entries(cal.events)) {
      expect(date <= state.date).toBe(true);
      expect(lines.length).toBeGreaterThan(0);
    }
    const all = Object.values(cal.events).flat().join(" ");
    expect(all).not.toContain("겨울 이적시장");
  });

  it("경기 결과·득점자가 일지와 엔트리에 반영된다", () => {
    const state = createTestGame(17);
    advanceAndPlay(state);
    const cal = buildOfficeViews(state).calendar;
    const played = cal.entries.find((e) => e.type === "match" && e.result);
    expect(played).toBeTruthy();
    expect(played?.status).toBe("done");
    expect(Object.values(cal.events).flat().some((l) => l.startsWith("⚽"))).toBe(true);
  });
});

describe("오피스 뷰 — 재정·순위·커리어", () => {
  it("재정은 유저 팀 것이고 주급은 계약 합이다", () => {
    const state = createTestGame();
    const views = buildOfficeViews(state);
    expect(views.finance.balance).toBe(financeOf(state, state.userTeamId).balance);
    expect(views.finance.weeklyWages).toBeGreaterThan(0);
    expect(views.finance.transferBudget).toBeGreaterThan(0);
  });

  it("이번 달 재정 집계와 실시간 피드가 시간 경과로 쌓인다", () => {
    const state = createTestGame();
    advanceDays(state, 10);
    const finance = buildOfficeViews(state).finance;
    expect(finance.current.expense.some((e) => e.category === "player_wages")).toBe(true);
    expect(finance.feed.length).toBeGreaterThan(0);
    expect(finance.stadium.capacity).toBeGreaterThan(0);
  });

  it("순위는 한글 팀명으로, 커리어는 감독 소속 기록으로 나온다", () => {
    const state = createTestGame();
    const views = buildOfficeViews(state);
    expect(views.schedule.standings).toHaveLength(20);
    for (const row of views.schedule.standings) {
      expect(row.name).not.toMatch(/^[a-z]+$/); // id가 아니라 한글명
    }
    expect(views.career.seasons).toHaveLength(0); // 첫 시즌 진행 중
    expect(views.career.trophies).toHaveLength(0);
  });

  it("이적 이력 뷰가 유저 팀 관련 이동을 담는다", () => {
    const state = createTestGame();
    state.transfers.push({
      id: "tr-x",
      gamePlayerId: userPlayers(state)[0]!.id,
      windowId: state.windows[0]!.id,
      fromTeamId: "chelsea",
      toTeamId: state.userTeamId,
      date: state.date,
      type: "transfer",
      fee: 50_000_000,
      note: "협상 타결",
    });
    const recent = buildOfficeViews(state).transfers.recent;
    expect(recent).toHaveLength(1);
    expect(recent[0]?.to).toBeTruthy();
    expect(recent[0]?.fee).toBe(50_000_000);
  });
});

describe("id → 이름 치환", () => {
  it("humanizePlayerIds가 서사 속 선수 id를 이름으로 바꾼다", () => {
    const state = createTestGame();
    const p = userPlayers(state)[0]!;
    const out = humanizePlayerIds(state, `@${p.id}: 준비됐습니다. ${p.id} 침투 시작.`);
    expect(out).toContain(p.name);
    expect(out).not.toContain(p.id);
  });
});

describe("경기 흐름 통합", () => {
  it("경기일 → 경기 → idle로 돌아오고 결과가 남는다", () => {
    const state = createTestGame(23);
    advanceToMatchday(state);
    expect(state.phase).toBe("matchday");
    // 경기일에 도달했으면 경기를 치러야 시간이 다시 흐른다
    const digest = playMockMatch(state);
    expect(digest.some((d) => d.includes("최종 스코어"))).toBe(true);
    expect(state.phase).toBe("idle");
    expect(state.pendingMatch).toBeNull();
  });
});
