import { describe, expect, it } from "vitest";
import {
  applyFinanceEvent,
  buildOfficeViews,
  categoryOf,
  cupProgressOf,
  type BracketStageView,
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
  type GameState,
} from "@story-fm/engine";
import { edgeOf } from "@story-fm/sim";
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
  it("선발은 11명이고 주장은 하나다", () => {
    const state = createTestGame();
    const views = buildOfficeViews(state);
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
    /**
     * **같은 숫자를 두 번 보여주지 않는다** — 자리 값이 카드의 종합과 같으면 비운다.
     * 종합은 그 선수가 **가장 잘 맞는 자리**의 값이라(player.md §4) 주 포지션에 선
     * 선수라도 둘이 갈릴 수 있고, 갈릴 때는 보여 주는 것이 맞다.
     */
    for (const p of buildOfficeViews(state).squad.players) {
      expect(p.slotOverall, p.name).not.toBe(p.overall);
    }

    target.position = "ST";
    const moved = buildOfficeViews(state).squad.players.find((p) => p.id === target.playerId)!;
    expect(moved.slotOverall).not.toBeNull();
    // 수비·중원 자원을 최전방에 세웠으니 그 자리 전력은 주 포지션보다 낮다
    expect(moved.slotOverall!).toBeLessThan(moved.overall);
    // 주 포지션 값 자체는 움직이지 않는다 — 자리를 옮겨도 그 선수의 본업은 그대로다
    expect(moved.overall).toBe(naturalRow.overall);
  });

  it("명단 OVR은 자리 목록의 최댓값이다 (같은 공식·같은 안개 채널)", () => {
    /**
     * 카드의 종합은 **가장 잘 맞는 자리에서 기본 역할로** 낸 값이다 (player.md §4).
     * 자리 목록과 카드가 다른 공식이나 다른 안개 채널을 쓰면 어느 자리도 카드의
     * 숫자에 닿지 못하거나 넘어선다 — 그 자리에서 어드민 표와 게임이 갈렸다.
     */
    const state = createTestGame();
    const row = buildOfficeViews(state).squad.players.find(
      (p) => p.positions.length > 1 && p.position !== "GK",
    )!;
    expect(Math.max(...row.positions.map((x) => x.overall))).toBe(row.overall);
  });

  it("부상 중인 선수는 가용에서 빠진다", () => {
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

    // 유저 팀 경기만 (리그 38 + 대항전)
    expect(cal.entries.filter((e) => e.type === "match")).toHaveLength(userFixtureCount(state));
    expect(cal.entries.some((e) => e.title?.includes("패스 훈련"))).toBe(true);
    // 이적창 엔트리
    expect(cal.entries.some((e) => e.type === "window-open")).toBe(true);
    expect(cal.windows.find((w) => w.kind === "여름")?.open).toBe(true);
  });

  it("일지는 저장하지 않고 기록 테이블에서 파생된다", () => {
    const state = createTestGame(13);
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

  it("큰 비정기 항목만 돈 줄로 서고 정액 항목은 서지 않는다", () => {
    const state = createTestGame();
    advanceDays(state, 10);
    const day = state.date;
    const label = "훈련장 잔디 전면 교체";
    expect(
      applyFinanceEvent(state, {
        kind: "expense",
        category: "facility",
        amount: 1_500_000,
        note: label,
      }).ok,
    ).toBe(true);

    const events = buildOfficeViews(state).calendar.events;
    // 진행 중인 달은 원장에서 파생한다 — 큰 비정기 지출이 그날 줄로 선다
    expect((events[day] ?? []).some((l) => l.kind === "money" && l.text.startsWith(label))).toBe(
      true,
    );

    // 매달·매경기 같은 자리에 서는 항목은 문턱을 넘어도 일지에 없다
    const moneyTexts = Object.values(events)
      .flat()
      .filter((l) => l.kind === "money")
      .map((l) => l.text);
    const FIXED = new Set(["broadcast_equal", "commercial", "player_wages", "staff_wages"]);
    const fixed = financeOf(state, state.userTeamId).ledger.filter(
      (e) => FIXED.has(categoryOf(e)) && e.amount >= 1_000_000,
    );
    expect(fixed.length).toBeGreaterThan(0); // 문턱을 넘는 정액 항목이 실제로 쌓여 있다
    for (const e of fixed) {
      expect(
        moneyTexts.some((t) => t.startsWith(e.label)),
        e.label,
      ).toBe(false);
    }
  });
});

describe("오피스 뷰 — 재정·순위·커리어", () => {
  it("피드는 선수별 상각을 한 줄로 접고 합계·명세가 원장과 같다", () => {
    const state = createTestGame();
    advanceDays(state, 10);
    const ledger = financeOf(state, state.userTeamId).ledger;
    const raw = ledger.filter((e) => e.category === "amortisation" && e.label !== "");
    expect(raw.length).toBeGreaterThan(10); // 매월 1일 선수마다 한 줄

    const feed = buildOfficeViews(state).finance.feed;
    const folded = feed.filter((row) => row.category === "amortisation");
    // 상각이 원장에선 스물몇 줄인데 피드에선 그 날짜만큼만 선다
    expect(folded.length).toBeLessThan(raw.length);

    const days = new Set(raw.map((e) => e.date));
    for (const date of days) {
      const perPlayer = raw.filter((e) => e.date === date && !e.label.includes(" — "));
      const row = folded.find((r) => r.date === date && r.label === "")!;
      expect(row.items).toHaveLength(perPlayer.length);
      expect(row.amount).toBe(perPlayer.reduce((sum, e) => sum + e.amount, 0));
      expect(new Set(row.items!.map((i) => i.label))).toEqual(
        new Set(perPlayer.map((e) => e.label)),
      );
      expect(row.noncash).toBe(true);
    }
  });

  it("접은 뒤 세므로 상각이 다른 사건을 피드 밖으로 밀지 않는다", () => {
    const state = createTestGame();
    advanceDays(state, 10);
    const feed = buildOfficeViews(state).finance.feed;
    // 접기 전엔 최근 30건이 상각 한 날짜로 덮였다
    expect(feed.some((row) => row.category !== "amortisation")).toBe(true);
    expect(new Set(feed.map((row) => row.id)).size).toBe(feed.length);
    // 한 건짜리 줄은 접지 않는다
    expect(feed.find((row) => row.category === "staff_wages")!.items).toBeUndefined();
  });

  /** 주급도 선수별로 적히므로 피드에선 한 줄로 서고, 펼치면 명세가 나온다 (§8.1) */
  it("주급은 한 줄로 서고 펼치면 선수별 주급이 큰 금액부터 나온다", () => {
    const state = createTestGame();
    advanceDays(state, 10);
    const ledger = financeOf(state, state.userTeamId).ledger;
    const feed = buildOfficeViews(state).finance.feed;
    const rows = feed.filter((row) => row.category === "player_wages");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const raw = ledger.filter((e) => e.category === "player_wages" && e.date === row.date);
      expect(row.items).toHaveLength(raw.length);
      expect(row.amount).toBe(raw.reduce((sum, e) => sum + e.amount, 0));
      expect(row.unit).toBe("명");
      // 명세는 큰 금액부터 — 화면이 첫 이름을 대표로 세운다
      const amounts = row.items!.map((i) => i.amount);
      expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
    }
  });

  /**
   * `이자·세금`과 `시설·아카데미 운영`은 같은 `facility`인데 서로 다른 사건이다.
   * 묶으면 라벨이 사라지고 두 항목이 한 금액이 된다.
   */
  it("대상 없는 항목은 카테고리가 같아도 각자 선다", () => {
    const state = createTestGame();
    advanceDays(state, 10);
    const feed = buildOfficeViews(state).finance.feed;
    const facility = feed.filter((row) => row.category === "facility");
    expect(facility.length).toBeGreaterThan(1);
    for (const row of facility) {
      expect(row.items).toBeUndefined();
      expect(row.label).not.toBe("");
    }
  });

  /** 라벨 규약 이전 세이브 — `이적료 상각 — 이름`이 접혀도 카테고리를 되풀이하지 않는다 */
  it("항목명이 카테고리 이름을 되풀이하면 없는 것으로 읽는다", () => {
    const state = createTestGame();
    advanceDays(state, 10);
    const finance = financeOf(state, state.userTeamId);
    finance.ledger = finance.ledger.map((e) =>
      e.category === "amortisation" && !e.label.includes(" — ")
        ? { ...e, label: `이적료 상각 — ${e.label}` }
        : e,
    );
    const row = buildOfficeViews(state)
      .finance.feed.filter((r) => r.category === "amortisation")
      .find((r) => (r.items?.length ?? 0) > 1)!;
    expect(row.label).toBe("");
    expect(row.items!.every((i) => !i.label.includes("이적료 상각"))).toBe(true);
  });

  it("대회 뷰는 우리 리그 + 우리 대항전이고 라운드별 일정을 담는다", () => {
    const state = createTestGame();
    const list = buildOfficeViews(state).competitions.list;

    // 우리 리그가 먼저, 그 뒤에 우리가 나가는 대항전
    expect(list[0]!.kind).toBe("league");
    for (const c of list.slice(1)) expect(c.kind).toBe("cup");

    const league = list[0]!;
    expect(league.rounds).toHaveLength(38);
    // 라운드마다 10경기(20팀), 전 팀의 경기가 모두 들어간다
    for (const round of league.rounds) expect(round.matches).toHaveLength(10);
    expect(league.rounds.every((r) => r.matches.filter((m) => m.ours).length === 1)).toBe(true);
    // 시작 시점엔 결과가 없고 현재 라운드는 딱 하나
    expect(league.rounds.flatMap((r) => r.matches).every((m) => m.score === null)).toBe(true);
    expect(league.rounds.filter((r) => r.current)).toHaveLength(1);
    expect(league.rounds.find((r) => r.current)!.key).toBe("league:1");
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
    // 현재 라운드 = 아직 지나지 않은 경기가 남은 첫 라운드 (우리 경기만 끝났어도
    // 같은 라운드의 다른 경기가 남아 있으면 그 라운드가 현재다)
    const league = list[0]!;
    const current = league.rounds.find((r) => r.current)!;
    expect(current.matches.some((m) => m.date >= state.date)).toBe(true);
    for (const round of league.rounds.slice(0, league.rounds.indexOf(current))) {
      expect(round.matches.every((m) => m.date < state.date)).toBe(true);
    }
  });

  it("대항전 탭의 리그 페이즈 순위표는 통과 경계선을 담을 만큼 길다", () => {
    const state = createTestGame();
    const cup = buildOfficeViews(state).competitions.list.find((c) => c.kind === "cup");
    // 이 시드는 대항전에 나간다 — 아니라면 케이스가 재는 것이 없으므로 조용히 넘어가지 않는다
    expect(cup, "대항전 탭이 서지 않았다").toBeDefined();
    expect(cup!.europe).not.toBeNull();
    expect(cup!.standings.length).toBeGreaterThanOrEqual(cup!.europe!.playoffCutoff);
  });
});

/**
 * 컵 진행 — 순위표가 없는 대회의 "현재 위치". 브래킷을 뒤져 우리 자리를 찾는 일은
 * 화면이 아니라 코어가 한다(§5). 다섯 갈래가 전부 같은 대진에서 갈리므로, 하나만
 * 어긋나도 머리줄이 그럴듯하게 틀린다 — "8강 탈락"과 "탈락"은 화면에서 구분되지 않는다.
 */
describe("컵 진행", () => {
  const tie = (ours: boolean, won: boolean | null) => ({
    date: "2027-01-10",
    home: "A",
    away: "B",
    score: null,
    ours,
    won,
  });
  const stage = (id: string, label: string, ties: ReturnType<typeof tie>[]): BracketStageView => ({
    stage: id,
    label,
    ties,
  });

  it("추첨 전과 대진 밖은 다른 자리다", () => {
    expect(cupProgressOf([])).toEqual({ stage: null, outcome: "undrawn" });
    expect(cupProgressOf([stage("r32", "32강", [tie(false, null)])])).toEqual({
      stage: null,
      outcome: "out",
    });
  });

  it("우리 대진이 마지막으로 선 단계를 읽는다", () => {
    const bracket = [
      stage("r16", "16강", [tie(true, true)]),
      stage("qf", "8강", [tie(true, null)]),
    ];
    expect(cupProgressOf(bracket)).toEqual({ stage: "8강", outcome: "through" });
  });

  it("진 단계는 그 단계 이름과 함께 남는다", () => {
    const bracket = [
      stage("r16", "16강", [tie(true, true)]),
      stage("qf", "8강", [tie(true, false)]),
    ];
    expect(cupProgressOf(bracket)).toEqual({ stage: "8강", outcome: "eliminated" });
  });

  it("결승을 이겨야만 우승이다 — 준결승 승리는 진출이다", () => {
    const sf = stage("sf", "준결승", [tie(true, true)]);
    expect(cupProgressOf([sf])).toEqual({ stage: "준결승", outcome: "through" });
    expect(cupProgressOf([sf, stage("final", "결승", [tie(true, true)])])).toEqual({
      stage: "결승",
      outcome: "champion",
    });
  });
});

describe("id → 이름 치환", () => {
  const state = createTestGame();

  it("humanizePlayerIds가 서사 속 선수 id를 이름으로 바꾼다", () => {
    const p = userPlayers(state)[0]!;
    const out = humanizePlayerIds(state, `@${p.id}: 준비됐습니다. ${p.id} 침투 시작.`);
    expect(out).toContain(p.name);
    expect(out).not.toContain(p.id);
  });

  /**
   * 부분 문자열까지 치우면 짧은 id가 긴 id를 반쪽만 먹는다 — 이슈의 `rodri` ⊂
   * `rodrigo-muniz`가 그 자리고, 동명이인을 가르는 `-<생년>` 꼬리도 같은 모양이다.
   * 세계는 필요 없다 — 이 함수가 읽는 것은 `players`의 id와 이름뿐이다.
   */
  it("id는 낱말 경계에서만 바뀐다 — 짧은 id가 긴 id를 반쪽 먹지 않는다", () => {
    const named = {
      players: [
        { id: "rodri", name: "로드리" },
        { id: "rodrigo-muniz", name: "호드리구 무니스" },
        { id: "rodri-2005", name: "로드리 주니어" },
      ],
    } as unknown as GameState;

    expect(humanizePlayerIds(named, "rodrigo-muniz에게 rodri가 붙는다")).toBe(
      "호드리구 무니스에게 로드리가 붙는다",
    );
    expect(humanizePlayerIds(named, "rodri-2005와 rodri는 다른 사람이다")).toBe(
      "로드리 주니어와 로드리는 다른 사람이다",
    );
  });
});

describe("경기 흐름 통합", () => {
  it("경기일 → 경기 → idle로 돌아오고 결과가 남는다", () => {
    const state = createTestGame(23);
    advanceToMatchday(state);
    expect(state.phase).toBe("matchday");
    // 경기일에 도달했으면 경기를 치러야 시간이 다시 흐른다
    playMockMatch(state);
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
    expect(m.onPitch.home).toHaveLength(11);
    expect(m.onPitch.away).toHaveLength(11);
    expect(m.zones).toHaveLength(3);
    // 매치업은 맞붙는 두 값을 견준다 — 공격 존의 상대 값은 상대 **수비**다.
    // 값은 우리 편 기준으로 접혀 온다 (자리만 홈 기준)
    const attack = m.zones.find((z) => z.zone === "attack")!;
    const packet = state.pendingMatch!.packet;
    const weAreHome = m.home.ours;
    expect(attack.ours).toBe(weAreHome ? packet.home.zones.attack : packet.away.zones.defense);
    expect(attack.theirs).toBe(weAreHome ? packet.away.zones.defense : packet.home.zones.attack);
    // 선수마다 전력과 남은 다리
    for (const p of [...m.onPitch.home, ...m.onPitch.away]) {
      expect(p.effective).toBeGreaterThan(0);
      // 전력·체력은 정수로 넘긴다 — 명단의 OVR과 같은 눈금이어야 견줄 수 있다
      expect(Number.isInteger(p.effective), `${p.name} 전력 ${p.effective}`).toBe(true);
      expect(Number.isInteger(p.condition.value)).toBe(true);
      expect(p.condition.value).toBeGreaterThanOrEqual(0);
      expect(p.condition.value).toBeLessThanOrEqual(100);
    }
    expect(m.onPitch.home.some((p) => p.ours) || m.onPitch.away.some((p) => p.ours)).toBe(true);

    /**
     * 줄 머리(존 매치업)와 그 줄 아홉 칸은 **같은 판정에서 나와야 한다.**
     * 화면은 색만 칠하므로, 둘이 갈리면 같은 판이 두 색으로 보이고 그때 감독이
     * 믿는 것은 화면이지 코어의 매치업 문장이 아니다.
     */
    for (const zone of m.zones) {
      const row = m.grid.filter((c) => c.band === zone.zone);
      expect(row).toHaveLength(3);
      const ours = row.reduce((sum, c) => sum + c.ours, 0);
      const theirs = row.reduce((sum, c) => sum + c.theirs, 0);
      const { edge, size } = edgeOf(ours / theirs);
      expect(zone.edge, zone.label).toBe(
        edge === "even" ? "even" : edge === "home" ? "ours" : "theirs",
      );
      if (zone.edge !== "even") expect(zone.size, zone.label).toBe(size);
    }
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

// ─── 커리어 뷰 (career.test.ts에서 옮겨 왔다 — 같은 buildOfficeViews 도메인) ───
/**
 * 커리어 화면이 **경질을 실제로 정하는 값**을 싣는가.
 *
 * 경고 카운터는 이 세이브가 끝나는 유일한 길의 눈금이다 (career.md §5).
 * 경고를 세는 일은 `reviewUserSeat`의 몫이고 뷰는 상태에서 파생만 한다.
 */
describe("커리어 뷰 — 보드 경고", () => {
  it("옛 세이브(경고 필드 없음)는 0으로 읽힌다", () => {
    const state = createTestGame(42);
    delete state.manager.boardWarnings;
    delete state.manager.lastWarnedOn;

    const views = buildOfficeViews(state);
    expect(views.squad.manager.boardWarnings).toBe(0);
    expect(views.squad.manager.lastWarnedOn).toBeNull();
  });
});

describe("커리어 뷰 — 감독 XP", () => {
  it("소수로 쌓인 XP(훈련 세션당 0.5)는 반올림해서 싣는다", () => {
    const state = createTestGame(44);
    state.managerXP.training = 87.5;

    expect(buildOfficeViews(state).squad.manager.xp.training).toBe(88);
  });
});
