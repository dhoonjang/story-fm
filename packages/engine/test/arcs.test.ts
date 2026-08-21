import { describe, expect, it } from "vitest";
import type { GamePlayer, Injury, MatchRecord, NarrativeArc, Negotiation } from "@story-fm/domain";
import { ARC_TITLE_MAX } from "@story-fm/domain";
import {
  MAX_ACTIVE_ARCS,
  activeArcs,
  applyArcTitles,
  describeActiveArcs,
  tickArcs,
} from "../src/world/arcs";
import { addDays } from "../src/core/dates";
import type { GameState } from "../src/core/state";

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
    injuries: [],
    issues: [],
    matches: [],
    negotiations: [],
    arcs: [],
    ...patch,
  } as unknown as GameState;
}

const player = (id: string): GamePlayer =>
  ({ id, name: id, teamId: TEAM }) as unknown as GamePlayer;

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
    expect(activeArcs(a)).toHaveLength(MAX_ACTIVE_ARCS);
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
    expect(digest).toHaveLength(MAX_ACTIVE_ARCS);
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
  /** 후보가 여섯인 세계 — 불만 둘, 부상 둘, 사가 하나, 연패 하나 */
  const crowded = (): GameState =>
    stateOf({
      players: ["p1", "p2", "p3", "p4", "p5"].map(player),
      // 사전순의 뒤엣것을 먼저 넣는다 — 정렬이 실제로 서는지 보기 위해
      issues: [issueOf("p2", 31), issueOf("p1", 31)],
      injuries: [injuryOf("p4", "2026-07-01", 40), injuryOf("p3", "2026-07-01", 40)],
      negotiations: [negotiationOf("p5", 3)],
      matches: leagueRun(3, 0, 2),
    });

  it("우선순위 순으로 네 자리만 찬다 — 같은 갈래면 주인 사전순", () => {
    const state = crowded();
    tickArcs(state, []);
    expect(activeArcs(state).map((a) => `${a.kind}:${a.subjectId}`)).toEqual([
      "grievance:p1",
      "grievance:p2",
      "injury-comeback:p3",
      "injury-comeback:p4",
    ]);
  });

  it("이미 선 아크는 우선순위가 높은 후보에게도 밀려나지 않는다", () => {
    const state = stateOf({
      players: ["p1", "p2", "p3", "p4", "p5"].map(player),
      negotiations: [1, 2, 3, 4].map((n) => negotiationOf(`p${n}`, 2)),
    });
    tickArcs(state, []);
    expect(kindsOf(state)).toEqual(Array(MAX_ACTIVE_ARCS).fill("transfer-saga"));

    // 자리가 없는 채로 불만이 곪는다 — 우선순위 1위지만 열리지 않는다
    state.issues = [issueOf("p5", 31)];
    tickArcs(state, []);
    expect(kindsOf(state)).toEqual(Array(MAX_ACTIVE_ARCS).fill("transfer-saga"));
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
