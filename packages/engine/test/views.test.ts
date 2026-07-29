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
    const league = views.competitions.list[0]!;
    expect(league.kind).toBe("league");
    expect(league.standings).toHaveLength(20);
    for (const row of league.standings) {
      expect(row.name).not.toMatch(/^[a-z]+$/); // id가 아니라 한글명
    }
    expect(views.career.seasons).toHaveLength(0); // 첫 시즌 진행 중
    expect(views.career.trophies).toHaveLength(0);
  });

  it("대회 뷰는 우리 리그 + 우리 대항전이고 라운드별 일정을 담는다", () => {
    const state = createTestGame();
    const list = buildOfficeViews(state).competitions.list;

    // 우리 리그가 먼저, 그 뒤에 우리가 나가는 대항전
    expect(list[0]!.kind).toBe("league");
    expect(list[0]!.id).toBe("epl");
    expect(list.filter((c) => c.kind === "cup").length).toBeLessThanOrEqual(1);
    for (const c of list.slice(1)) expect(c.kind).toBe("cup");

    const league = list[0]!;
    expect(league.rounds).toHaveLength(38);
    expect(league.rounds[0]!.label).toBe("1라운드");
    // 라운드마다 10경기(20팀), 전 팀의 경기가 모두 들어간다
    for (const round of league.rounds) expect(round.matches).toHaveLength(10);
    expect(league.rounds.every((r) => r.matches.filter((m) => m.ours).length === 1)).toBe(true);
    // 시작 시점엔 결과가 없고 현재 라운드는 딱 하나
    expect(league.rounds.flatMap((r) => r.matches).every((m) => m.score === null)).toBe(true);
    expect(league.rounds.filter((r) => r.current)).toHaveLength(1);
    expect(league.rounds.find((r) => r.current)!.key).toBe("league:1");
    expect(league.next).toContain("vs");
  });

  it("경기를 치르면 대회 일정에 스코어와 승패가 남는다", () => {
    const state = createTestGame(17);
    advanceAndPlay(state);
    const list = buildOfficeViews(state).competitions.list;
    const played = list
      .flatMap((c) => c.rounds)
      .flatMap((r) => r.matches)
      .filter((m) => m.ours && m.score !== null);
    expect(played).toHaveLength(1);
    expect(played[0]!.score).toMatch(/^\d+-\d+/);
    expect(["W", "D", "L"]).toContain(played[0]!.win);
    // 현재 라운드 = 아직 지나지 않은 경기가 남은 첫 라운드 (우리 경기만 끝났어도
    // 같은 라운드의 다른 경기가 남아 있으면 그 라운드가 현재다)
    const league = list[0]!;
    const current = league.rounds.find((r) => r.current)!;
    expect(current.matches.some((m) => m.date >= state.date)).toBe(true);
    for (const round of league.rounds.slice(0, league.rounds.indexOf(current))) {
      expect(round.matches.every((m) => m.date < state.date)).toBe(true);
    }
  });

  it("대항전 탭은 리그 페이즈 순위표와 통과 경계선을 갖는다", () => {
    const state = createTestGame();
    const cup = buildOfficeViews(state).competitions.list.find((c) => c.kind === "cup");
    if (!cup) return; // 시드에 따라 대항전에 못 나갈 수 있다
    expect(cup.europe).not.toBeNull();
    expect(cup.europe!.directSlots).toBeGreaterThan(0);
    expect(cup.standings.length).toBeGreaterThanOrEqual(cup.europe!.playoffCutoff);
    // 리그 페이즈 라운드가 먼저 오고 녹아웃 단계가 뒤에 붙는다
    expect(cup.rounds[0]!.label).toContain("리그 페이즈");
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
