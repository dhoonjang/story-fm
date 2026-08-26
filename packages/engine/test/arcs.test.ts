import { describe, expect, it } from "vitest";
import type { GamePlayer, Injury, MatchRecord, NarrativeArc, Negotiation } from "@story-fm/domain";
import { ARC_TITLE_MAX, CONDITION_BASE } from "@story-fm/domain";
import {
  MAX_ACTIVE_ARCS,
  activeArcs,
  applyArcTitles,
  describeActiveArcs,
  tickArcs,
} from "../src/world/arcs";
import { addDays } from "../src/core/dates";
import { topNarrative, type GameState } from "../src/core/state";

/**
 * 아크 판정이 읽는 조각만 든 세계 — `createTestGame()`은 여기 필요 없다.
 * 개폐는 부상·불만·경기 결과·협상 네 테이블과 날짜만 보므로, 세계를 지으면
 * 한 번에 1초를 내고 얻는 것이 없다 (AGENTS.md §5).
 */
const TEAM = "our-team";
const TODAY = "2026-08-01";

function stateOf(patch: Partial<GameState> = {}): GameState {
  return {
    date: TODAY,
    season: 1,
    userTeamId: TEAM,
    players: [],
    teams: [],
    injuries: [],
    issues: [],
    matches: [],
    negotiations: [],
    contracts: [],
    seasonStats: [],
    manager: {},
    arcs: [],
    ...patch,
  } as unknown as GameState;
}

/** 나이를 안 주면 스물여섯 — 유망주도 베테랑도 아닌 자리다 */
const player = (id: string, patch: Partial<GamePlayer> = {}): GamePlayer =>
  ({
    id,
    name: id,
    teamId: TEAM,
    birthdate: bornAt(26),
    attributes: { overall: 75 },
    // 상태 칸은 비워 두지 않는다 — 판정이 읽는 자리라 없으면 그 줄에서 터진다
    state: { form: 0, condition: CONDITION_BASE },
    ...patch,
  }) as unknown as GamePlayer;

/** 오늘 만 `age`세가 되는 생일 — 경계를 하루 단위로 겨눈다 */
const bornAt = (age: number): string => {
  const [y, rest] = [Number(TODAY.slice(0, 4)) - age, TODAY.slice(4)];
  return `${y}${rest}`;
};

/** 오늘로부터 `days`일 뒤 만료되는 활성 계약 */
const contractOf = (playerId: string, days: number) =>
  ({
    id: `c-${playerId}`,
    gamePlayerId: playerId,
    teamId: TEAM,
    status: "active",
    until: addDays(TODAY, days),
  }) as unknown as GameState["contracts"][number];

/** 이번 시즌 1군 기록 — 평점은 경기당 `rating`으로 고르게 준다 */
const statOf = (playerId: string, apps: number, rating: number) =>
  ({
    gamePlayerId: playerId,
    season: 1,
    teamId: TEAM,
    apps,
    goals: 0,
    ratingSum: apps * rating,
  }) as unknown as GameState["seasonStats"][number];

/** 예상 결장 `days`일짜리 미복귀 부상 */
const injuryOf = (playerId: string, occurredOn: string, days: number): Injury =>
  ({
    id: `inj-${playerId}`,
    gamePlayerId: playerId,
    bodyPart: "햄스트링",
    severity: "moderate",
    cause: "match",
    occurredOn,
    expectedReturn: addDays(occurredOn, days),
    returnedOn: null,
  }) as unknown as Injury;

/** 오늘로부터 `days`일 전에 걸린 불만 */
const issueOf = (playerId: string, days: number) => ({
  gamePlayerId: playerId,
  kind: "unhappy" as const,
  reason: "minutes" as const,
  since: addDays(TODAY, -days),
});

/** 우리 팀 리그 경기 `n`건 — 전부 같은 결과. 날짜는 하루씩 앞선다 */
function leagueRun(n: number, ours: number, theirs: number): MatchRecord[] {
  return Array.from(
    { length: n },
    (_, i) =>
      ({
        id: `m-${ours}-${theirs}-${i}`,
        season: 1,
        competitionId: "league",
        round: i + 1,
        date: addDays(TODAY, -(n - i)),
        homeTeamId: TEAM,
        awayTeamId: "rival",
        result: { homeGoals: ours, awayGoals: theirs },
      }) as unknown as MatchRecord,
  );
}

/** 진행 중인 협상 — 라운드 수만 이야기가 된다 */
const negotiationOf = (playerId: string, rounds: number, status = "open"): Negotiation =>
  ({
    id: `neg-${playerId}`,
    gamePlayerId: playerId,
    kind: "buy",
    counterpartTeamId: "rival",
    windowId: null,
    openedOn: "2026-07-01",
    expiresOn: "2026-09-01",
    status,
    rounds: Array.from({ length: rounds }, () => ({})),
  }) as unknown as Negotiation;

const kindsOf = (state: GameState): string[] => activeArcs(state).map((a) => a.kind);
const stageOf = (state: GameState, kind: string): string | undefined =>
  activeArcs(state).find((a) => a.kind === kind)?.stage;

describe("아크 개폐 판정", () => {
  /** `world()`가 세우는 갈래 수 — 활성 상한과는 다른 수다 */
  const KINDS_IN_WORLD = 4;

  /** 네 갈래가 한꺼번에 서는 세계 — 갈래마다 주인이 다르다 */
  const world = (): GameState =>
    stateOf({
      players: [player("p1"), player("p2")],
      issues: [issueOf("p1", 31)],
      injuries: [injuryOf("p2", "2026-07-01", 40)],
      matches: leagueRun(3, 0, 2),
      negotiations: [negotiationOf("p1", 3)],
    });

  it("같은 상태는 같은 아크를 낸다 — 열림도 단계도 id도", () => {
    const a = structuredClone(world());
    const b = structuredClone(world());
    tickArcs(a, []);
    tickArcs(b, []);
    expect(activeArcs(a)).toHaveLength(KINDS_IN_WORLD);
    expect(a.arcs).toEqual(b.arcs);
  });

  it("단계는 사실이 정한다 — 불만 31일은 절정, 3연패는 발단", () => {
    const state = world();
    tickArcs(state, []);
    expect(stageOf(state, "grievance")).toBe("climax");
    expect(stageOf(state, "losing-run")).toBe("open");
    expect(stageOf(state, "transfer-saga")).toBe("rising");
  });

  it("단계가 움직인 아크만 다이제스트에 선다", () => {
    const state = world();
    const digest: string[] = [];
    tickArcs(state, digest);
    expect(digest).toHaveLength(KINDS_IN_WORLD);
    // 두 번째 tick은 사실이 그대로다 — 소식이 아니다
    const again: string[] = [];
    tickArcs(state, again);
    expect(again).toEqual([]);
  });
});

describe("아크 개폐 경계", () => {
  const withInjury = (days: number): GameState =>
    stateOf({ players: [player("p1")], injuries: [injuryOf("p1", TODAY, days)] });

  it("예상 결장 29일은 이야기가 아니고 30일은 이야기다", () => {
    const short = withInjury(29);
    tickArcs(short, []);
    expect(kindsOf(short)).toEqual([]);

    const long = withInjury(30);
    tickArcs(long, []);
    expect(kindsOf(long)).toEqual(["injury-comeback"]);
    expect(stageOf(long, "injury-comeback")).toBe("open");
  });

  it("불만 6일은 열리지 않고 7일은 열린다", () => {
    const six = stateOf({ players: [player("p1")], issues: [issueOf("p1", 6)] });
    tickArcs(six, []);
    expect(kindsOf(six)).toEqual([]);

    const seven = stateOf({ players: [player("p1")], issues: [issueOf("p1", 7)] });
    tickArcs(seven, []);
    expect(kindsOf(seven)).toEqual(["grievance"]);
  });

  it("2연패는 열리지 않고 3연패는 열린다", () => {
    const two = stateOf({ matches: leagueRun(2, 0, 1) });
    tickArcs(two, []);
    expect(kindsOf(two)).toEqual([]);

    const three = stateOf({ matches: leagueRun(3, 0, 1) });
    tickArcs(three, []);
    expect(kindsOf(three)).toEqual(["losing-run"]);
  });

  it("협상 1라운드는 사가가 아니고 2라운드부터 사가다", () => {
    const one = stateOf({ players: [player("p1")], negotiations: [negotiationOf("p1", 1)] });
    tickArcs(one, []);
    expect(kindsOf(one)).toEqual([]);

    const two = stateOf({ players: [player("p1")], negotiations: [negotiationOf("p1", 2)] });
    tickArcs(two, []);
    expect(kindsOf(two)).toEqual(["transfer-saga"]);
  });
});

describe("활성 상한", () => {
  /** 후보가 여덟인 세계 — 불만 둘, 부상 둘, 사가 둘, 연패 하나, 보드 대치 하나 */
  const crowded = (): GameState =>
    stateOf({
      players: ["p1", "p2", "p3", "p4", "p5", "p6"].map((id) => player(id)),
      // 사전순의 뒤엣것을 먼저 넣는다 — 정렬이 실제로 서는지 보기 위해
      issues: [issueOf("p2", 31), issueOf("p1", 31)],
      injuries: [injuryOf("p4", "2026-07-01", 40), injuryOf("p3", "2026-07-01", 40)],
      negotiations: [negotiationOf("p6", 3), negotiationOf("p5", 3)],
      matches: leagueRun(3, 0, 2),
      manager: { boardWarnings: 1 } as GameState["manager"],
    });

  it("우선순위 순으로 여섯 자리만 찬다 — 같은 갈래면 주인 사전순", () => {
    const state = crowded();
    tickArcs(state, []);
    expect(activeArcs(state).map((a) => `${a.kind}:${a.subjectId}`)).toEqual([
      `board-standoff:${TEAM}`,
      "grievance:p1",
      "grievance:p2",
      "injury-comeback:p3",
      "injury-comeback:p4",
      "transfer-saga:p5",
    ]);
  });

  it("이미 선 아크는 우선순위가 높은 후보에게도 밀려나지 않는다", () => {
    const state = stateOf({
      players: ["p1", "p2", "p3", "p4", "p5", "p6", "p7"].map((id) => player(id)),
      negotiations: [1, 2, 3, 4, 5, 6].map((n) => negotiationOf(`p${n}`, 2)),
    });
    tickArcs(state, []);
    expect(kindsOf(state)).toEqual(Array(MAX_ACTIVE_ARCS).fill("transfer-saga"));

    // 자리가 없는 채로 불만이 곪는다 — 우선순위가 위지만 열리지 않는다
    state.issues = [issueOf("p7", 31)];
    tickArcs(state, []);
    expect(kindsOf(state)).toEqual(Array(MAX_ACTIVE_ARCS).fill("transfer-saga"));
  });
});

describe("겹쳐 읽어야 열리는 갈래", () => {
  /** 스물한 살, 다섯 경기, 평점 6.3 — 유망주 아크가 서는 최소한의 세계 */
  const prospect = (age: number, apps: number, rating: number): GameState =>
    stateOf({
      players: [player("kid", { birthdate: bornAt(age) })],
      seasonStats: [statOf("kid", apps, rating)],
    });

  it("나이·출전·평점 셋이 다 서야 열린다", () => {
    // 셋이 다 선 자리
    const open = prospect(21, 5, 6.3);
    tickArcs(open, []);
    expect(kindsOf(open)).toEqual(["prospect-rise"]);

    // 하루 늦게 태어났어도 스물둘이면 아니다
    const grown = prospect(22, 5, 6.3);
    tickArcs(grown, []);
    expect(kindsOf(grown)).toEqual([]);

    // 네 경기는 표본이 아니다
    const few = prospect(21, 4, 6.3);
    tickArcs(few, []);
    expect(kindsOf(few)).toEqual([]);

    // 기준선 위로 못 오른 평점은 돌파가 아니다
    const plain = prospect(21, 5, 6.29);
    tickArcs(plain, []);
    expect(kindsOf(plain)).toEqual([]);
  });

  it("출전이 단계를 민다 — 5·10·15", () => {
    for (const [apps, stage] of [
      [5, "open"],
      [10, "rising"],
      [15, "climax"],
    ] as const) {
      const state = prospect(21, apps, 6.5);
      tickArcs(state, []);
      expect(stageOf(state, "prospect-rise"), `${apps}경기`).toBe(stage);
    }
  });

  it("유망주 이야기는 한 시즌에 하나 — 가장 나아간 사람의 것이다", () => {
    const state = stateOf({
      players: [
        player("a-kid", { birthdate: bornAt(20) }),
        player("b-kid", { birthdate: bornAt(20) }),
      ],
      // 사전순으로는 a가 앞이지만 절정에 선 것은 b다
      seasonStats: [statOf("a-kid", 5, 6.5), statOf("b-kid", 15, 6.5)],
    });
    tickArcs(state, []);
    expect(activeArcs(state).map((arc) => arc.subjectId)).toEqual(["b-kid"]);

    // 하나가 서 있는 동안 다른 하나는 자리를 얻지 못한다
    state.date = addDays(TODAY, 1);
    tickArcs(state, []);
    expect(activeArcs(state).map((arc) => arc.subjectId)).toEqual(["b-kid"]);
  });

  it("임대 보낸 유망주도 주인이다 — 출전은 남의 경기장 것이다", () => {
    const away = player("kid", { birthdate: bornAt(19) });
    (away as { teamId: string }).teamId = "borrower";
    (away as { loan?: unknown }).loan = { fromTeamId: TEAM, until: addDays(TODAY, 300) };
    const state = stateOf({
      players: [away],
      seasonStats: [
        { ...statOf("kid", 12, 6.6), teamId: "borrower" } as GameState["seasonStats"][number],
      ],
    });
    tickArcs(state, []);
    expect(kindsOf(state)).toEqual(["prospect-rise"]);
    expect(describeActiveArcs(state)).toContain("임대 borrower");
  });

  it("황혼은 나이와 계약을 겹쳐 읽는다 — 계약이 남았으면 아직 아니다", () => {
    const twilight = (age: number, days: number, overall = 75): GameState =>
      stateOf({
        players: [player("vet", { birthdate: bornAt(age), attributes: { overall } as never })],
        contracts: [contractOf("vet", days)],
      });

    const long = twilight(34, 366);
    tickArcs(long, []);
    expect(kindsOf(long)).toEqual([]);

    const young = twilight(32, 100);
    tickArcs(young, []);
    expect(kindsOf(young)).toEqual([]);

    const last = twilight(33, 365);
    tickArcs(last, []);
    expect(stageOf(last, "veteran-twilight")).toBe("open");

    // 이미 은퇴 문턱을 넘었으면 계약이 얼마나 남았든 이번 시즌이 마지막이다
    const done = twilight(35, 365);
    tickArcs(done, []);
    expect(stageOf(done, "veteran-twilight")).toBe("climax");
  });

  it("주장 승계는 팀의 이야기다 — 완장이 넘어가면 새 주장의 사실로 다시 선다", () => {
    const state = stateOf({
      players: [
        // 서른둘 — 서른셋이면 베테랑 황혼이 함께 서서 무엇을 재는지가 흐려진다
        player("cap", { birthdate: bornAt(32), isCaptain: true }),
        player("heir", { birthdate: bornAt(24) }),
      ],
      contracts: [contractOf("cap", 300), contractOf("heir", 900)],
    });
    tickArcs(state, []);
    expect(activeArcs(state).map((a) => a.subjectId)).toEqual([TEAM]);
    expect(describeActiveArcs(state)).toContain("부주장 공석");

    // 젊고 계약이 긴 사람에게 완장이 넘어가면 사실이 사라진다
    (state.players[0] as { isCaptain: boolean }).isCaptain = false;
    (state.players[1] as { isCaptain: boolean }).isCaptain = true;
    state.date = addDays(TODAY, 1);
    tickArcs(state, []);
    expect(activeArcs(state)).toEqual([]);
  });

  it("한 달 결장한 완장은 부주장이 없을 때만 절정이다", () => {
    const absent = (deputy: boolean): GameState =>
      stateOf({
        players: [
          player("cap", { birthdate: bornAt(32), isCaptain: true }),
          player("vice", { birthdate: bornAt(27), isViceCaptain: deputy }),
        ],
        contracts: [contractOf("cap", 300), contractOf("vice", 900)],
        injuries: [injuryOf("cap", addDays(TODAY, -30), 60)],
      });

    const alone = absent(false);
    tickArcs(alone, []);
    expect(stageOf(alone, "captain-succession")).toBe("climax");

    const covered = absent(true);
    tickArcs(covered, []);
    expect(stageOf(covered, "captain-succession")).toBe("rising");
  });

  it("보드 경고 0은 대치가 아니고 1은 대치다 — 요청 불이행은 절정으로 민다", () => {
    const standoff = (warnings: number, failed = false): GameState =>
      stateOf({
        manager: { boardWarnings: warnings } as GameState["manager"],
        boardDemands: failed
          ? ([{ id: "d1", status: "failed" }] as GameState["boardDemands"])
          : undefined,
      });

    const quiet = standoff(0);
    tickArcs(quiet, []);
    expect(kindsOf(quiet)).toEqual([]);

    const one = standoff(1);
    tickArcs(one, []);
    expect(stageOf(one, "board-standoff")).toBe("open");
    expect(describeActiveArcs(one)).toBe("- [발단] 보드 경고 1/3");

    const two = standoff(2);
    tickArcs(two, []);
    expect(stageOf(two, "board-standoff")).toBe("rising");

    // 경고 하나여도 구단주 요청을 어겼으면 절정이다
    const broken = standoff(1, true);
    tickArcs(broken, []);
    expect(stageOf(broken, "board-standoff")).toBe("climax");
  });

  it("경고가 지워지면 대치가 닫힌다 — 경질·이직이 따로 닫지 않는 이유다", () => {
    const state = stateOf({ manager: { boardWarnings: 2 } as GameState["manager"] });
    tickArcs(state, []);
    expect(kindsOf(state)).toEqual(["board-standoff"]);

    state.manager.boardWarnings = 0;
    state.date = addDays(TODAY, 1);
    tickArcs(state, []);
    expect(activeArcs(state)).toEqual([]);
  });
});

describe("아크의 단계는 뒤로 가지 않는다", () => {
  it("다가옴 계단이 절정으로 민 아크는 계단이 사라져도 절정이다", () => {
    const state = stateOf({
      players: [player("p1")],
      issues: [issueOf("p1", 7)],
      approachPressure: [{ subject: "p1", topic: "minutes", value: 210, step: 2 }],
    });
    tickArcs(state, []);
    expect(stageOf(state, "grievance")).toBe("climax");

    // 면담이 압력을 비웠다 — 불만은 8일째로 여전히 '발단'의 사실이다
    state.approachPressure = [];
    state.date = addDays(TODAY, 1);
    tickArcs(state, []);
    expect(stageOf(state, "grievance")).toBe("climax");
    expect(activeArcs(state)[0]?.updatedOn).toBe(TODAY);
  });
});

describe("아크가 닫히는 자리", () => {
  it("불만이 지워지면 닫힌다", () => {
    const state = stateOf({ players: [player("p1")], issues: [issueOf("p1", 31)] });
    tickArcs(state, []);
    expect(kindsOf(state)).toEqual(["grievance"]);

    state.issues = [];
    state.date = addDays(TODAY, 1);
    tickArcs(state, []);
    expect(activeArcs(state)).toEqual([]);
    expect(state.arcs?.[0]?.resolvedOn).toBe(addDays(TODAY, 1));
    expect(describeActiveArcs(state)).toBeNull();
  });

  it("연속이 끊기면 닫힌다", () => {
    const state = stateOf({ matches: leagueRun(3, 0, 2) });
    tickArcs(state, []);
    expect(kindsOf(state)).toEqual(["losing-run"]);

    state.matches = [...state.matches, ...leagueRun(1, 1, 1)];
    tickArcs(state, []);
    expect(activeArcs(state)).toEqual([]);
  });

  it("무직이면 옛 구단의 이야기가 전부 닫힌다", () => {
    const state = stateOf({
      players: [player("p1"), player("p2")],
      issues: [issueOf("p1", 31)],
      injuries: [injuryOf("p2", "2026-07-01", 40)],
    });
    tickArcs(state, []);
    expect(activeArcs(state)).toHaveLength(2);

    state.dismissal = { on: TODAY, teamId: TEAM } as GameState["dismissal"];
    tickArcs(state, []);
    expect(activeArcs(state)).toEqual([]);
  });
});

describe("아크 이름 짓기", () => {
  const named = (): GameState => {
    const state = stateOf({ players: [player("p1")], issues: [issueOf("p1", 31)] });
    tickArcs(state, []);
    return state;
  };

  it("있는 활성 아크에만, 한 번만 붙는다", () => {
    const state = named();
    const id = activeArcs(state)[0]?.id ?? "";

    expect(applyArcTitles(state, [{ arcId: "arc:없음:p1:2026-08-01", title: "유령" }])).toBe(0);
    expect(applyArcTitles(state, [{ arcId: id, title: "  등을 돌린 밤  " }])).toBe(1);
    expect(activeArcs(state)[0]?.title).toBe("등을 돌린 밤");

    // 한 번 붙은 이름은 시즌 내내 같은 이야기를 가리킨다
    expect(applyArcTitles(state, [{ arcId: id, title: "다른 이름" }])).toBe(0);
    expect(activeArcs(state)[0]?.title).toBe("등을 돌린 밤");
  });

  it("길이를 넘긴 제목과 빈 제목은 버린다", () => {
    const state = named();
    const id = activeArcs(state)[0]?.id ?? "";
    expect(applyArcTitles(state, [{ arcId: id, title: "가".repeat(ARC_TITLE_MAX + 1) }])).toBe(0);
    expect(applyArcTitles(state, [{ arcId: id, title: "   " }])).toBe(0);
    expect(applyArcTitles(state, [{ arcId: id, title: "가".repeat(ARC_TITLE_MAX) }])).toBe(1);
  });

  it("닫힌 아크에는 이름이 붙지 않는다", () => {
    const state = named();
    const id = activeArcs(state)[0]?.id ?? "";
    state.issues = [];
    tickArcs(state, []);
    expect(applyArcTitles(state, [{ arcId: id, title: "지난 이야기" }])).toBe(0);
    expect((state.arcs as NarrativeArc[])[0]?.title).toBeUndefined();
  });

  it("이름이 있으면 스냅샷 줄에 서고, 없으면 사실 줄이 그 자리를 대신한다", () => {
    const state = named();
    expect(describeActiveArcs(state)).toBe("- [절정] p1 불만 출전 기회 · 31일째");
    applyArcTitles(state, [{ arcId: activeArcs(state)[0]?.id ?? "", title: "등을 돌린 밤" }]);
    expect(describeActiveArcs(state)).toBe("- [절정] 등을 돌린 밤 — p1 불만 출전 기회 · 31일째");
  });
});

describe("서사 기억의 가중 주입 (topNarrative)", () => {
  const noteOf = (daysAgo: number, salience: number) => ({
    date: addDays(TODAY, -daysAgo),
    text: `d${daysAgo}s${salience}`,
    salience,
  });

  it("무게 5는 반감기를 세 번 지나도 오늘의 1을 이긴다", () => {
    // 5 × 0.5^3 = 0.625 < 1 이지만, 21일이면 세 번이 채 안 돼 1.25 > 1 — 경계는 3반감기다
    const state = stateOf({
      narrative: [noteOf(14, 5), ...Array.from({ length: 4 }, (_, i) => noteOf(i, 1))],
    });
    const picked = topNarrative(state, 4).map((n) => n.text);
    expect(picked).toContain("d14s5");
    // 뽑힌 뒤에는 시간순으로 선다 — 무게 5가 가장 오래됐으니 맨 앞이다
    expect(picked[0]).toBe("d14s5");
  });

  it("반감기를 충분히 지난 무게 5는 오늘의 1에 밀린다", () => {
    const state = stateOf({
      narrative: [noteOf(28, 5), ...Array.from({ length: 4 }, (_, i) => noteOf(i, 1))],
    });
    // 5 × 0.5^4 = 0.3125 < 1 × 0.5^(3/7)
    expect(topNarrative(state, 4).map((n) => n.text)).not.toContain("d28s5");
  });

  it("가중치가 같으면 최신이 이기고, 결과는 결정적이다", () => {
    const state = stateOf({
      narrative: Array.from({ length: 6 }, (_, i) => ({ ...noteOf(0, 2), text: `same-${i}` })),
    });
    const a = topNarrative(state, 4).map((n) => n.text);
    expect(a).toEqual(topNarrative(state, 4).map((n) => n.text));
    expect(a).toEqual(["same-2", "same-3", "same-4", "same-5"]);
  });
});
