import { describe, expect, it } from "vitest";
import { ageOf } from "@story-fm/domain";
import {
  adaptationOf,
  buildOfficeViews,
  financeOf,
  humanizePlayerIds,
  setTraining,
  startMatch,
  userPlayers,
  userTactics,
  squadReturnOf,
  addDays,
  diffDays,
  playerById,
} from "@story-fm/engine";
import {
  advanceAndPlay,
  advanceDays,
  advanceToMatchday,
  createTestGame,
  playMockMatch,
  playPreseason,
  userFixtureCount,
} from "./helpers";

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

  it("자리 기준 전력 — 요구 역량이 다른 자리에 세우면 그 자리 값이 함께 나온다", () => {
    const state = createTestGame();
    const tactics = userTactics(state);
    // 골키퍼가 아닌 선발 하나를 스트라이커로 옮긴다. 원래 자리가 무엇이든
    // ST와 요구 역량이 같은 자리(CF·ST 계열)만 아니면 값이 갈려야 한다.
    const target = tactics.assignments.find(
      (a) =>
        a.role === "starting" && !["GK", "ST", "CF", "LST", "RST", "LF", "RF"].includes(a.position),
    )!;
    const naturalRow = buildOfficeViews(state).squad.players.find((p) => p.id === target.playerId)!;
    // 배치가 주 포지션과 같은 계열이면 같은 숫자를 두 번 보여주지 않는다
    expect(naturalRow.slotOverall).toBeNull();

    target.position = "ST";
    const moved = buildOfficeViews(state).squad.players.find((p) => p.id === target.playerId)!;
    expect(moved.slotOverall).not.toBeNull();
    // 수비·중원 자원을 최전방에 세웠으니 그 자리 전력은 주 포지션보다 낮다
    expect(moved.slotOverall!).toBeLessThan(moved.overall);
    // 주 포지션 값 자체는 움직이지 않는다 — 자리를 옮겨도 그 선수의 본업은 그대로다
    expect(moved.overall).toBe(naturalRow.overall);
  });

  it("포지션 목록은 자리마다 전력과 적응도를 따로 갖는다", () => {
    const state = createTestGame();
    const row = buildOfficeViews(state).squad.players.find(
      (p) => p.positions.length > 1 && p.position !== "GK",
    )!;
    for (const pos of row.positions) {
      expect(pos.overall).toBeGreaterThan(0);
      expect(pos.proficiency).toBeGreaterThan(0);
    }
    // 주 포지션의 자리 전력은 명단에 뜨는 OVR과 같은 값이다 (같은 공식·같은 안개 채널)
    const natural = row.positions.find((x) => x.isNatural)!;
    expect(natural.overall).toBe(row.overall);
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
      sessions: [
        {
          date: addDays(squadReturnOf(state.calendar), 1),
          slot: "am",
          label: "패스 훈련",
          focus: ["passing"],
        },
      ],
    });
    const cal = buildOfficeViews(state).calendar;

    expect(cal.today).toBe("2026-07-01");
    expect(cal.preseasonStart).toBe("2026-07-01");
    // 유저 팀 경기만 (리그 38 + 대항전)
    expect(cal.entries.filter((e) => e.type === "match")).toHaveLength(userFixtureCount(state));
    const training = cal.entries.find((e) => e.title?.includes("패스 훈련"));
    expect(training?.time).toBe("10:00");
    // 이적창 엔트리
    expect(cal.entries.some((e) => e.type === "window-open")).toBe(true);
    expect(cal.windows.find((w) => w.kind === "여름")?.open).toBe(true);
  });

  it("일지는 저장하지 않고 기록 테이블에서 파생된다", () => {
    const state = createTestGame(13);
    // diary 필드가 상태에 없다 (v6)
    expect("diary" in state).toBe(false);

    // 휴가가 끝나야 훈련이 실제로 소화된다 (소집일 전에는 걸 수 없다)
    advanceDays(state, diffDays(state.date, squadReturnOf(state.calendar)));
    setTraining(state, {
      repeatWeekly: [{ dow: 2, slot: "am", label: "체력 훈련", focus: ["strength"] }],
      weeks: 2,
    });
    advanceDays(state, 9);
    const events = buildOfficeViews(state).calendar.events;
    const lines = Object.values(events).flat();
    // 완료된 훈련이 일지에 나타난다
    expect(lines.some((l) => l.kind === "training" && l.text.includes("체력 훈련"))).toBe(true);
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
    // 아이콘은 문자열이 아니라 종류로 온다 — 화면이 도형을 그린다
    expect(
      Object.values(cal.events)
        .flat()
        .some((l) => l.kind === "match"),
    ).toBe(true);
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
    // 대항전(있으면 하나) + 우리 나라 국내 컵 — 잉글랜드는 FA컵·리그컵 둘이다
    expect(list.filter((c) => c.kind === "cup").map((c) => c.id)).toEqual([
      "ucl",
      "facup",
      "eflcup",
    ]);
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
    // 친선은 대회 화면에 서지 않는다 — 대회 일정을 보려면 리그 경기여야 한다
    playPreseason(state);
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

describe("적응도 — 포지션과 전술을 하나로", () => {
  it("합친 값이 두 축 사이에 놓이고, 영향 폭에 비례해 섞인다", () => {
    const state = createTestGame();
    const tactics = userTactics(state);
    const target = tactics.assignments.find((a) => a.role === "starting")!;
    target.familiarity = 40;

    const row = buildOfficeViews(state).squad.players.find((p) => p.id === target.playerId)!;
    expect(row.familiarity).toBe(40);
    expect(row.positionFit).toBeGreaterThan(0);
    // 합친 값은 두 축 사이 — 어느 쪽으로도 튀지 않는다
    expect(row.adaptation).toBeGreaterThan(Math.min(row.familiarity, row.positionFit) - 1);
    expect(row.adaptation).toBeLessThan(Math.max(row.familiarity, row.positionFit) + 1);
    expect(row.adaptation).toBe(adaptationOf(row.positionFit, row.familiarity, target.position));
  });

  it("전술 적응이 오르면 합친 값도 오른다 (같은 자리에서)", () => {
    const state = createTestGame();
    const target = userTactics(state).assignments.find((a) => a.role === "starting")!;
    target.familiarity = 30;
    const low = buildOfficeViews(state).squad.players.find((p) => p.id === target.playerId)!;
    target.familiarity = 90;
    const high = buildOfficeViews(state).squad.players.find((p) => p.id === target.playerId)!;
    expect(high.adaptation).toBeGreaterThan(low.adaptation);
    expect(high.positionFit).toBe(low.positionFit); // 자리는 그대로다
  });

  it("낯선 자리에 세우면 합친 값이 내려간다 (전술 적응은 그대로)", () => {
    const state = createTestGame();
    const target = userTactics(state).assignments.find(
      (a) => a.role === "starting" && a.position !== "GK",
    )!;
    const before = buildOfficeViews(state).squad.players.find((p) => p.id === target.playerId)!;
    target.position = "GK"; // 필드 플레이어를 골문에 — 가장 낯선 자리
    const after = buildOfficeViews(state).squad.players.find((p) => p.id === target.playerId)!;
    expect(after.positionFit).toBeLessThan(before.positionFit);
    expect(after.adaptation).toBeLessThan(before.adaptation);
    expect(after.familiarity).toBe(before.familiarity);
  });
});

describe("경기 화면 뷰", () => {
  it("경기 중에만 채워지고, 판세·전술·선수 상태를 함께 담는다", () => {
    const state = createTestGame(9, "manutd");
    expect(buildOfficeViews(state).match).toBeNull(); // 킥오프 전
    advanceToMatchday(state);
    startMatch(state);

    const m = buildOfficeViews(state).match!;
    expect(m).not.toBeNull();
    expect(m.onPitch.home).toHaveLength(11);
    expect(m.onPitch.away).toHaveLength(11);
    expect(m.zones).toHaveLength(3);
    // 매치업은 맞붙는 두 값을 견준다 — 공격 존의 상대 값은 상대 **수비**다
    const attack = m.zones.find((z) => z.zone === "attack")!;
    const packet = state.pendingMatch!.packet;
    expect(attack.home).toBe(packet.home.zones.attack);
    expect(attack.away).toBe(packet.away.zones.defense);
    // 양팀 전술 6축 + 소화율
    expect(m.tactics.home.uptake).toBeGreaterThan(0);
    expect(m.tactics.away.formation).toBeTruthy();
    // 선수마다 전력과 남은 다리
    for (const p of [...m.onPitch.home, ...m.onPitch.away]) {
      expect(p.effective).toBeGreaterThan(0);
      // 전력·체력은 정수로 넘긴다 — 명단의 OVR과 같은 눈금이어야 견줄 수 있다
      expect(Number.isInteger(p.effective), `${p.name} 전력 ${p.effective}`).toBe(true);
      expect(Number.isInteger(p.condition.value)).toBe(true);
      expect(p.condition.value).toBeGreaterThanOrEqual(0);
      expect(p.condition.value).toBeLessThanOrEqual(100);
      expect(typeof p.gassed).toBe("boolean");
    }
    expect(m.onPitch.home.some((p) => p.ours) || m.onPitch.away.some((p) => p.ours)).toBe(true);
  });

  /**
   * 상대 팀 탭이 "안개 낀 화면"으로 성립하려면 **전력도 흐려야** 한다.
   * 그리고 그 흐림은 명단 화면과 **같은 채널**이어야 한다 — 채널이 갈리면 같은
   * 상대 선수가 스쿼드에서 82, 경기 화면에서 78로 보인다.
   */
  it("상대의 전력도 안개를 지난다 — 우리 선수만 정확하다", () => {
    const state = createTestGame(9, "manutd");
    advanceToMatchday(state);
    startMatch(state);

    const m = buildOfficeViews(state).match!;
    const all = [...m.onPitch.home, ...m.onPitch.away];
    for (const p of all) {
      if (p.ours) expect(p.margin, p.name).toBe(0);
      else expect(p.margin, p.name).toBeGreaterThan(0);
      expect(p.effective).toBeGreaterThan(0);
    }
    // 폭만 있고 값이 안 흔들리면 안개가 아니다
    const packet = state.pendingMatch!.packet;
    const truthOf = new Map(
      [...packet.home.lineup, ...packet.away.lineup].map((x) => [x.id, Math.round(x.effective)]),
    );
    const theirs = all.filter((p) => !p.ours);
    expect(theirs.some((p) => p.effective !== truthOf.get(p.id))).toBe(true);
  });

  /**
   * 경기 중 "다음 경기"는 **지금 이 경기가 아니다.** 결과는 종료 시점에 쓰이므로
   * 결과 없는 첫 경기를 그냥 고르면 대회 탭 아래에 "오늘 · 지금 상대"가 뜬다.
   */
  it("다음 경기는 진행 중인 경기를 건너뛴다", () => {
    const state = createTestGame(9, "manutd");
    advanceToMatchday(state);
    const before = buildOfficeViews(state).competitions.nextMatch!;
    expect(before.inDays).toBe(0); // 킥오프 전 — 오늘 그 경기가 다음 경기다

    startMatch(state);
    const during = buildOfficeViews(state).competitions.nextMatch;
    expect(during).not.toBeNull();
    expect(during!.inDays).toBeGreaterThan(0);
    expect(during!.opponent).not.toBe(before.opponent);
    // 화면이 그대로 쓸 수 있게 조각으로 온다 — 문자열을 잘라 쓰지 않는다
    expect(during!.label).toBeTruthy();
    expect(["home", "away", "neutral"]).toContain(during!.venue);
  });

  it("체력은 누구도 값 하나로 서지 않는다 — 우리는 좁게, 상대는 넓게", () => {
    const state = createTestGame(9, "manutd");
    advanceToMatchday(state);
    startMatch(state);

    const m = buildOfficeViews(state).match!;
    const all = [...m.onPitch.home, ...m.onPitch.away];
    const worn = state.pendingMatch!.matchFatigue ?? {};
    const truthOf = (id: string) =>
      Math.round(Math.max(0, (playerById(state, id)?.state.condition ?? 0) - (worn[id] ?? 0)));

    const ours = all.filter((p) => p.ours);
    const theirs = all.filter((p) => !p.ours);
    expect(ours.length).toBe(11);
    expect(theirs.length).toBe(11);

    // 참값은 언제나 구간 안에 있다 — 안개는 흐릴 뿐 거짓말하지 않는다
    for (const p of all) {
      const truth = truthOf(p.id);
      expect(p.condition.margin, p.name).toBeGreaterThan(0);
      expect(p.condition.low, p.name).toBeLessThanOrEqual(truth);
      expect(p.condition.high, p.name).toBeGreaterThanOrEqual(truth);
      expect(p.condition.label).toBeTruthy();
    }
    // 출발점을 아는 우리 쪽이 뚜렷하게 좁다
    const widthOf = (rows: typeof all) =>
      rows.reduce((s, p) => s + p.condition.margin, 0) / rows.length;
    expect(widthOf(ours)).toBeLessThan(widthOf(theirs) / 2);
    // 상대는 실제로 흔들린다 — 폭만 있고 값이 참값 그대로면 안개가 아니다
    expect(theirs.some((p) => p.condition.value !== truthOf(p.id))).toBe(true);

    // 결정적 — 같은 화면을 다시 그려도 같은 값이다
    const again = buildOfficeViews(state).match!;
    expect(again.onPitch.away.map((p) => p.condition.value)).toEqual(
      m.onPitch.away.map((p) => p.condition.value),
    );
  });

  it("경기가 끝나면 사라진다 — 빈 화면을 남기지 않는다", () => {
    const state = createTestGame(9, "manutd");
    advanceToMatchday(state);
    playMockMatch(state);
    expect(buildOfficeViews(state).match).toBeNull();
  });
});
