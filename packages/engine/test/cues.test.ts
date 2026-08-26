import { describe, expect, it } from "vitest";
import {
  leaderGroupOf,
  addDays,
  APPROACH_THRESHOLD,
  marketValueOf,
  approachThreshold,
  BOARD_DEMAND,
  BOARD_REQUEST,
  boardDemandFact,
  boardRequestCeiling,
  boardThriftFactor,
  boardTrustFactor,
  clubProfileIn,
  consumeEarmark,
  earmarkedFor,
  signingBudgetOf,
  coachArchetypeKeyOf,
  coachCues,
  COACH_ARCHETYPE_LABELS,
  COACH_EYE_KEYS,
  assignmentsOf,
  DEMAND_OF_ARCHETYPE,
  financeOf,
  openBoardDemand,
  OWNER_ARCHETYPE_LABELS,
  pendingApproach,
  openBoardRequest,
  playerById,
  requestBoard,
  respondToApproach,
  speakerCues,
  tickApproaches,
  tickBoardDemands,
  tickBoardRequests,
  userPlayers,
  userWageRoom,
  wageLiftOf,
  windowOpenForTeam,
  worldFigures,
  type GameState,
  categoryOf,
  STADIUM_ASSET_MONTHS,
} from "@story-fm/engine";
import type { BoardRequestKind, PlayerIssueReason, Transfer } from "@story-fm/domain";
import { BOARD_REQUEST_KINDS } from "@story-fm/domain";
import { createTestGame } from "./helpers";

/**
 * 선수 근황 — **세계에 지금 무슨 이야기가 있는가** (cues.ts).
 *
 * 이 줄이 없으면 스냅샷이 이름을 내보내는 자리는 부상·정지·불만 셋뿐이고,
 * 셋 다 몇 주씩 바뀌지 않아 GM이 아는 "이야기가 있는 선수"가 늘 같은 두세 명이다.
 */

/** 1군 선수를 앞에서부터 n명 — 근황을 심을 대상 */
const firsts = (state: GameState, n: number) =>
  userPlayers(state)
    .filter((p) => p.squadLevel === "first")
    .slice(0, n);

/**
 * 리더 그룹 밖의 1군 — **압력의 눈금을 재는 자리는 리더 배수가 걸리지 않아야 한다**
 * (people.md §5-1). 명단 앞쪽은 서열도 앞쪽이라, 그대로 쓰면 사다리 테스트가 재는
 * 것이 계단이 아니라 배수가 된다.
 */
const plains = (state: GameState, n: number) => {
  const leaders = new Set(leaderGroupOf(state, state.userTeamId).map((r) => r.playerId));
  return userPlayers(state)
    .filter((p) => p.squadLevel === "first" && !leaders.has(p.id))
    .slice(0, n);
};

/** 근황이 하나도 없는 판 — 폼을 전부 평소로 눕힌다 */
function quiet(state: GameState) {
  for (const p of userPlayers(state)) p.state.form = 0;
  return state;
}

describe("근황은 사실에서 온다", () => {
  it("폼이 절정이거나 바닥이면 이야기가 된다 — 평소는 아니다", () => {
    const state = quiet(createTestGame(11));
    const [peak, slump] = firsts(state, 2);
    peak!.state.form = 0.8;
    slump!.state.form = -0.8;

    const cues = speakerCues(state, 10);
    expect(cues.find((c) => c.playerId === peak!.id)?.fact).toContain("절정");
    expect(cues.find((c) => c.playerId === slump!.id)?.fact).toContain("바닥");
    expect(cues).toHaveLength(2);
  });

  it("복귀가 눈앞인 부상만 근황이다 — 재활 초입은 주의 줄이 이미 말한다", () => {
    const state = quiet(createTestGame(11));
    const [soon, far] = firsts(state, 2);
    for (const [player, days] of [
      [soon!, 7],
      [far!, 60],
    ] as const) {
      state.injuries.push({
        id: `inj-${player.id}`,
        gamePlayerId: player.id,
        bodyPart: "햄스트링",
        severity: "moderate",
        cause: "training",
        occurredOn: state.date,
        expectedReturn: addDays(state.date, days),
        returnedOn: null,
      });
    }
    const cues = speakerCues(state, 10);
    expect(cues.find((c) => c.playerId === soon!.id)?.fact).toContain("복귀 임박");
    expect(cues.some((c) => c.playerId === far!.id)).toBe(false);
  });

  it("2군은 세지 않는다 — 감독의 일상에 닿지 않는다", () => {
    const state = quiet(createTestGame(11));
    const target = firsts(state, 1)[0]!;
    target.state.form = 0.9;
    expect(speakerCues(state, 10).some((c) => c.playerId === target.id)).toBe(true);
    playerById(state, target.id)!.squadLevel = "reserve";
    expect(speakerCues(state, 10).some((c) => c.playerId === target.id)).toBe(false);
  });

  it("아무 일도 없으면 빈 목록 — 없는 이야기를 만들지 않는다", () => {
    expect(speakerCues(quiet(createTestGame(11)), 10)).toEqual([]);
  });

  it("결정적이다 — 같은 날 같은 세이브면 같은 목록", () => {
    const state = quiet(createTestGame(11));
    for (const p of firsts(state, 5)) p.state.form = 0.8;
    expect(speakerCues(state)).toEqual(speakerCues(state));
  });
});

/**
 * **"최근 세 경기"는 날짜의 것이다.**
 *
 * `state.matches`는 날짜순이 아니다 — 컵·대항전 대진은 그 라운드가 확정될 때 배열
 * 뒤에 붙는다. 배열 끝에서 세면 시즌 후반의 "최근"이 방금 편성된 컵 경기가 되고,
 * 리그 3연속 명단 제외가 조용히 새어 나간다. 화면에 아무 소리도 나지 않는 종류라
 * 여기가 아니면 드러날 자리가 없다.
 */
describe("연속 명단 제외는 날짜순 직전 세 경기로 센다", () => {
  /** 치른 경기 하나 — `lineup`에 있는 선수만 뛴 것으로 남는다 */
  function played(state: GameState, id: string, date: string, lineup: readonly string[]) {
    state.matches.push({
      id,
      season: state.season,
      competitionId: "epl",
      round: 1,
      date,
      homeTeamId: state.userTeamId,
      awayTeamId: "chelsea",
      result: {
        homeGoals: 1,
        awayGoals: 0,
        scorers: [],
        homeLineup: [...lineup],
      },
    });
  }

  /** 세 경기를 벤치에서 본 선수 하나를 만들고, 그 선수를 돌려준다 */
  function benchedForThree(state: GameState) {
    const target = firsts(state, 1)[0]!;
    const others = userPlayers(state)
      .filter((p) => p.id !== target.id)
      .map((p) => p.id);
    for (const [i, day] of [4, 3, 2].entries()) {
      played(state, `m-league-${i}`, addDays(state.date, -day), others);
    }
    return target;
  }

  it("배열 뒤에 붙은 옛 경기가 최근 세 경기를 밀어내지 않는다", () => {
    const state = quiet(createTestGame(11));
    const target = benchedForThree(state);
    // 3주 전 컵 경기가 이제야 배열 끝에 붙는다 — 그날은 이 선수가 뛰었다
    played(state, "m-cup-old", addDays(state.date, -21), [target.id]);

    const cue = speakerCues(state, 40).find((c) => c.playerId === target.id);
    expect(cue?.fact).toBe("3경기 연속 명단 제외");
  });

  it("직전 경기에 나섰으면 근황이 아니다 — 배열 끝이 옛 대진이어도", () => {
    const state = quiet(createTestGame(11));
    const target = firsts(state, 1)[0]!;
    played(state, "m-yesterday", addDays(state.date, -1), [target.id]);
    // 배열 끝의 셋은 3주 전 컵 대진이다 — 편성 순서지 날짜 순서가 아니다
    for (const [i, day] of [21, 22, 23].entries()) {
      played(state, `m-cup-${i}`, addDays(state.date, -day), []);
    }
    expect(speakerCues(state, 40).some((c) => c.playerId === target.id)).toBe(false);
  });
});

describe("한 사람이 계속 말하지 않는다", () => {
  it("최근에 말한 선수는 뒤로 밀린다", () => {
    const state = quiet(createTestGame(11));
    const [a, b] = firsts(state, 2);
    a!.state.form = 0.8;
    b!.state.form = 0.8;
    state.chat.push({
      role: "model",
      text: `[${state.date} AM 9:00]\n@${a!.name}: 감독님, 드릴 말씀이 있습니다.`,
      toolCalls: [],
      at: state.date,
    });
    expect(speakerCues(state, 1)[0]!.playerId).toBe(b!.id);
  });

  it("공백만 다른 이름도 같은 사람이다 — 모델이 붙여 써도 회전에서 빠지지 않는다", () => {
    const state = quiet(createTestGame(11));
    const [a, b] = firsts(state, 2);
    a!.state.form = 0.8;
    b!.state.form = 0.8;
    // 모델은 같은 사람을 "스티브 홀랜드"로도 "스티브홀랜드"로도 쓴다
    const spaced = a!.name.replace(/^(.)/u, "$1 ");
    state.chat.push({
      role: "model",
      text: `[${state.date} AM 9:00]\n@${spaced}: 감독님, 드릴 말씀이 있습니다.`,
      toolCalls: [],
      at: state.date,
    });
    expect(speakerCues(state, 1)[0]!.playerId).toBe(b!.id);
  });

  it("날짜가 바뀌면 차례가 돈다 — 근황이 그대로여도", () => {
    const state = quiet(createTestGame(11));
    for (const p of firsts(state, 4)) p.state.form = 0.8;
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      seen.add(speakerCues(state, 1)[0]!.playerId);
      state.date = addDays(state.date, 1);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

/**
 * 다가옴 — **세계가 먼저 말을 건다** (approach.ts · people.md §8).
 *
 * 근황과 같은 파일에 두는 이유는 재는 것이 하나이기 때문이다: 코어가 감독에게
 * 무엇을 내미는가. 근황은 사실을 흘리고, 다가옴은 답을 요구한다.
 */

/** 그 선수에게 출전 기회 불만을 건다 — 압력의 원인이 서는 유일한 길이다 */
function gripe(state: GameState, playerId: string, reason: PlayerIssueReason = "minutes") {
  state.issues.push({ gamePlayerId: playerId, kind: "unhappy", reason, since: state.date });
}

/** 하루씩 민다 — tick 전체가 아니라 압력만 굴려 다른 사건이 섞이지 않게 한다 */
function pressDays(state: GameState, days: number): string[] {
  const digest: string[] = [];
  for (let i = 0; i < days; i++) {
    state.date = addDays(state.date, 1);
    tickApproaches(state, digest);
  }
  return digest;
}

describe("압력이 임계를 넘어야 자리가 열린다", () => {
  it("임계 직전까지는 아무도 오지 않는다 — 넘은 날 온다", () => {
    const state = quiet(createTestGame(11));
    const target = plains(state, 1)[0]!;
    gripe(state, target.id);

    // minutes는 하루 7 — 14일이면 98로 임계 100에 못 미친다
    pressDays(state, 14);
    expect(pendingApproach(state)).toBeNull();

    pressDays(state, 1);
    const open = pendingApproach(state);
    expect(open?.speakerId).toBe(target.name);
    expect(open?.about).toBe(target.id);
    expect(open?.step).toBe(1);
  });

  /**
   * 리더 배수 — 주장의 불만은 15일이 아니라 8일 만에 문을 두드린다
   * (people.md §5-1 · §8). 배수가 죽으면 완장이 다시 서사에서만 뜻을 갖는다.
   */
  it("리더의 불만은 더 빨리 임계에 닿는다 — 주장은 배수 2.0", () => {
    const state = quiet(createTestGame(11));
    const captain = userPlayers(state).find((p) => p.isCaptain)!;
    gripe(state, captain.id);
    // 하루 7 × 2.0 = 14 — 7일이면 98로 아직 임계 아래다
    pressDays(state, 7);
    expect(pendingApproach(state)).toBeNull();
    pressDays(state, 1);
    expect(pendingApproach(state)?.about).toBe(captain.id);
    // 자리를 연 배경 카드가 그 사람의 완장을 함께 든다
    expect(pendingApproach(state)?.contextCard?.leader).toBe("captain");
  });

  it("열려 있는 동안에는 다음 자리가 열리지 않는다", () => {
    const state = quiet(createTestGame(11));
    const [a, b] = plains(state, 2);
    gripe(state, a!.id);
    gripe(state, b!.id);
    pressDays(state, 15);
    const first = pendingApproach(state);
    expect(first).not.toBeNull();
    // 사흘을 넘기면 코어가 닫고, 지나친 그날에는 다음 사람이 오지 않는다
    pressDays(state, 3);
    expect(pendingApproach(state)).toBeNull();
    expect(first?.status).toBe("declined");
  });
});

describe("답한 것과 답하지 않은 것의 차이는 남는 압력이다", () => {
  it("답하면 압력이 0으로, 계단이 하나 오른다 — 다음 임계는 두 배다", () => {
    const state = quiet(createTestGame(11));
    const target = plains(state, 1)[0]!;
    gripe(state, target.id);
    pressDays(state, 15);

    expect(respondToApproach(state, { stance: "defend" }).ok).toBe(true);
    const row = state.approachPressure!.find((r) => r.subject === target.id)!;
    expect(row.value).toBe(0);
    expect(row.step).toBe(1);
    expect(approachThreshold(row.step)).toBe(APPROACH_THRESHOLD * 2);

    // 200을 채우는 데 하루 7이면 29일 — 28일째에는 아직 오지 않는다
    pressDays(state, 28);
    expect(pendingApproach(state)).toBeNull();
    pressDays(state, 1);
    expect(pendingApproach(state)?.step).toBe(2);
  });

  it("돌려보내면 직전 임계의 75%가 남는다 — 무시가 다음 계단을 앞당긴다", () => {
    const state = quiet(createTestGame(11));
    const target = plains(state, 1)[0]!;
    gripe(state, target.id);
    pressDays(state, 15);

    expect(respondToApproach(state, { decline: true }).ok).toBe(true);
    const row = state.approachPressure!.find((r) => r.subject === target.id)!;
    expect(row.value).toBe(APPROACH_THRESHOLD * 0.75);
    expect(row.step).toBe(1);
  });

  it("답이 원인을 지우지는 않는다 — 불만은 그대로 남는다", () => {
    const state = quiet(createTestGame(11));
    const target = plains(state, 1)[0]!;
    gripe(state, target.id);
    pressDays(state, 15);
    respondToApproach(state, { stance: "own" });
    expect(state.issues.some((i) => i.gamePlayerId === target.id)).toBe(true);
  });
});

describe("원인이 사라지면 식는다", () => {
  it("불만이 풀리면 압력이 빠지고, 계단은 남는다", () => {
    const state = quiet(createTestGame(11));
    const target = plains(state, 1)[0]!;
    gripe(state, target.id);
    pressDays(state, 15);
    respondToApproach(state, { stance: "defend" });

    pressDays(state, 5); // 압력 35
    state.issues = state.issues.filter((i) => i.gamePlayerId !== target.id);
    pressDays(state, 3); // 하루 12씩 식어 0에서 멈춘다
    const row = state.approachPressure!.find((r) => r.subject === target.id)!;
    expect(row.value).toBe(0);
    expect(row.step).toBe(1);
  });
});

describe("찾아온 사람은 근황 줄에 다시 서지 않는다", () => {
  it("같은 선수를 두 자리가 함께 밀지 않는다", () => {
    const state = quiet(createTestGame(11));
    const target = plains(state, 1)[0]!;
    target.state.form = -0.8; // 근황이 붙는 폼
    gripe(state, target.id);
    pressDays(state, 15);
    expect(pendingApproach(state)?.about).toBe(target.id);
    expect(speakerCues(state, 10).some((c) => c.playerId === target.id)).toBe(false);
  });
});

describe("자리는 그 자리에 있던 사람에게만 닿는다", () => {
  it("구단주와 닫고 한 이야기는 언론 평판을 움직이지 않는다", () => {
    const state = quiet(createTestGame(11));
    const before = { ...state.manager.reputation };
    state.approaches = [
      {
        id: "approach-results-board-x",
        date: state.date,
        channel: "owner",
        topic: "results",
        speakerId: "구단주",
        about: null,
        context: "리그 15위 · 기대 6위",
        facts: [{ kind: "standing", text: "리그 15위 · 20경기", about: null, sharp: true }],
        step: 3,
        status: "pending",
      },
    ];
    // bold는 언론 +1 · 보드 −0.3인 행이다 — 마스킹이 없으면 언론이 크게 오른다
    expect(respondToApproach(state, { stance: "bold" }).ok).toBe(true);
    expect(state.manager.reputation.media).toBe(before.media);
    expect(state.manager.reputation.board).toBeLessThan(before.board);
  });

  it("갓 열린 회견이 있으면 아무도 오지 않는다 — 감독이 지나친 회견은 자리를 다투지 않는다", () => {
    const state = quiet(createTestGame(11));
    const target = plains(state, 1)[0]!;
    gripe(state, target.id);
    pressDays(state, 14); // 압력 98 — 임계 한 칸 앞

    state.pressConferences = [
      {
        id: "press-x",
        date: addDays(state.date, 1),
        trigger: "match",
        context: "웨스트햄전 1-3 패배",
        facts: [{ kind: "result", text: "웨스트햄전 1-3 패배 (홈)", about: null, sharp: true }],
        status: "pending",
        weight: 2,
      },
    ];
    pressDays(state, 1);
    expect(pendingApproach(state)).toBeNull();

    // 사흘이 지나면 그 회견은 감독이 지나친 것이고, 기다리던 사람이 온다
    pressDays(state, 3);
    expect(pendingApproach(state)?.about).toBe(target.id);
  });
});

describe("자기 일이 아닌 자리는 대신 오는 사람이 있다", () => {
  it("라커룸이 식으면 주장이 온다 — 걸린 선수 없이", () => {
    const state = quiet(createTestGame(11));
    const squad = userPlayers(state).filter((p) => p.squadLevel === "first");
    for (const p of squad) p.state.form = -0.5;
    const captain = squad.find((p) => p.isCaptain) ?? squad[0]!;
    captain.isCaptain = true;

    // morale은 하루 8 — 13일이면 104로 임계를 넘는다
    pressDays(state, 13);
    const open = pendingApproach(state);
    expect(open?.channel).toBe("captain");
    expect(open?.speakerId).toBe(captain.name);
    expect(open?.about).toBeNull();
  });
});

/**
 * 사다리의 위쪽 두 계단 — **방치가 행동이 된다** (people.md §8).
 *
 * 아래 세 계단은 사람이 오지만 4·5는 세계가 움직인다: 불만이 신문에 새고, 그다음엔
 * 에이전트가 이적 요청을 들고 온다. 계단마다 임계가 달라 눈으로는 맞출 수 없다.
 */

/** 그 압력 줄 */
const rowOf = (state: GameState, subject: string) =>
  state.approachPressure!.find((r) => r.subject === subject)!;

/** 사다리를 그 계단까지 올린다 — 자리가 열릴 때마다 감독이 답한다(압력은 0으로) */
function climbTo(state: GameState, subject: string, step: number): void {
  for (let day = 0; day < 400; day++) {
    if ((state.approachPressure?.find((r) => r.subject === subject)?.step ?? 0) >= step) return;
    pressDays(state, 1);
    if (pendingApproach(state)) respondToApproach(state, { stance: "defend" });
  }
  throw new Error(`${subject}의 사다리가 ${step}계단까지 오르지 않았다`);
}

describe("계단 4·5 — 언론 유출과 이적 요청", () => {
  it("계단 3을 지나 임계 400을 채우면 자리가 아니라 유출이 선다", () => {
    const state = quiet(createTestGame(11));
    const target = plains(state, 1)[0]!;
    gripe(state, target.id);
    climbTo(state, target.id, 3);

    // minutes는 하루 7 — 57일이면 399로 임계 400에 못 미친다
    pressDays(state, 57);
    expect(state.pressLeaks ?? []).toEqual([]);

    pressDays(state, 1);
    expect(pendingApproach(state)).toBeNull();
    expect(state.pressLeaks).toEqual([{ playerId: target.id, topic: "minutes", date: state.date }]);
    const row = rowOf(state, target.id);
    expect(row.step).toBe(4);
    // 유출은 압력을 풀지 않는다 — 직전 임계(400)의 75%가 남는다
    expect(row.value).toBe(300);
  });

  it("유출 뒤 임계 500을 채우면 에이전트가 이적 요청을 들고 온다", () => {
    const state = quiet(createTestGame(11));
    const target = plains(state, 1)[0]!;
    gripe(state, target.id);
    climbTo(state, target.id, 3);
    pressDays(state, 58); // 유출 — 300이 남는다

    pressDays(state, 29); // 300 + 203 = 503
    const open = pendingApproach(state);
    expect(open?.channel).toBe("agent");
    expect(open?.step).toBe(5);
    expect(open?.about).toBe(target.id);
    expect(worldFigures(state).some((f) => f.characterId === open?.speakerId)).toBe(true);
    expect(open?.facts[0]?.kind).toBe("transfer-request");
    // 자리가 열리는 순간 요청이 선다 — 감독의 답을 기다리지 않는다
    expect(target.state.transferRequestedOn).toBe(state.date);
  });

  it("요청이 서 있는 동안 압력은 더 쌓이지 않고, 불만이 풀리면 걷힌다", () => {
    const state = quiet(createTestGame(11));
    const target = plains(state, 1)[0]!;
    gripe(state, target.id);
    climbTo(state, target.id, 3);
    pressDays(state, 58);
    pressDays(state, 29);
    expect(respondToApproach(state, { stance: "defend" }).ok).toBe(true);
    // 꼭대기 계단에서는 남는 압력이 없다
    expect(rowOf(state, target.id).value).toBe(0);
    // 답은 요청을 지우지 못한다
    expect(target.state.transferRequestedOn).not.toBeUndefined();

    pressDays(state, 5);
    expect(rowOf(state, target.id).value).toBe(0);

    state.issues = state.issues.filter((i) => i.gamePlayerId !== target.id);
    pressDays(state, 1);
    expect(target.state.transferRequestedOn).toBeUndefined();
  });

  it("주장의 사다리는 3에서 멈춘다 — 유출도 에이전트도 서지 않는다", () => {
    const state = quiet(createTestGame(11));
    for (const p of userPlayers(state).filter((x) => x.squadLevel === "first")) p.state.form = -0.5;
    climbTo(state, "squad", 3);

    // morale은 하루 8 — 400을 채우고도 계단은 3에 선다
    pressDays(state, 50);
    const open = pendingApproach(state);
    expect(open?.channel).toBe("captain");
    expect(open?.step).toBe(3);
    expect(state.pressLeaks ?? []).toEqual([]);
  });
});

/** 우리 스쿼드에서 가장 나은 선수 — 상위 14명 문을 확실히 지나는 대상 */
function best(state: GameState) {
  return [...userPlayers(state)].sort((a, b) => b.attributes.overall - a.attributes.overall)[0]!;
}

/**
 * 스쿼드에 **서로 다른 종합**을 매겨 순위를 정확히 만든다 — 상위 14명 경계를 재려면
 * 동점이 없어야 한다(`betterThanInSquad`는 자기보다 **높은** 선수만 센다).
 */
function rankedSquad(state: GameState) {
  const squad = [...userPlayers(state)].sort((a, b) => b.attributes.overall - a.attributes.overall);
  squad.forEach((p, i) => {
    p.attributes.overall = 90 - i;
  });
  return squad;
}

/**
 * 최근에 끝난 타 구단의 매각 오퍼 하나 — `interest`의 유일한 원인.
 * `feeRatio`는 **시장가 대비**다 — `MARKET_NEAR_LOW` 이상이라야 값이 붙은 오퍼다.
 */
function closedOffer(
  state: GameState,
  playerId: string,
  input: { feeRatio: number; status: "rejected" | "expired"; daysAgo: number },
) {
  const on = addDays(state.date, -input.daysAgo);
  const fee = Math.round(marketValueOf(state, playerById(state, playerId)!) * input.feeRatio);
  state.negotiations.push({
    id: `neg-in-${playerId}-${on}`,
    gamePlayerId: playerId,
    kind: "sell",
    counterpartTeamId: state.teams.find((t) => t.id !== state.userTeamId)!.id,
    windowId: null,
    openedOn: on,
    expiresOn: on,
    status: input.status,
    rounds: [
      {
        date: on,
        by: "them",
        fee,
        weeklyWage: 0,
        contractYears: 4,
        respondsOn: null,
        probability: 50,
        verdict: null,
      },
    ],
  });
}

/**
 * 에이전트 채널 — **계약과 관심은 협상 테이블 건너편에서 온다** (people.md §8).
 *
 * 사다리 꼭대기(계단 5)에서만 서던 대리인이 계단 1부터 서는 자리라, 「누가 오는가」와
 * 「어디서 멈추는가」가 주제마다 갈리는지가 여기서 결정된다.
 */
describe("계약과 관심 — 에이전트가 계단 1부터 온다", () => {
  it("계약 만료 불만은 대리인이 들고 온다 — 계단 1도 에이전트다", () => {
    const state = quiet(createTestGame(11));
    const target = best(state);
    gripe(state, target.id, "contract");

    // contract는 하루 5 — 19일이면 95로 임계 100에 못 미친다
    pressDays(state, 19);
    expect(pendingApproach(state)).toBeNull();

    pressDays(state, 1);
    const open = pendingApproach(state)!;
    expect(open.step).toBe(1);
    expect(open.channel).toBe("agent");
    expect(worldFigures(state).some((f) => f.characterId === open.speakerId)).toBe(true);
    expect(open.about).toBe(target.id);
    expect(open.facts[0]?.kind).toBe("contract-demand");
    expect(open.contextCard?.code).toBe("contract-demand");
  });

  it("재계약을 열면 압력이 식는다 — 불만은 그대로 남는다", () => {
    const state = quiet(createTestGame(11));
    const target = best(state);
    gripe(state, target.id, "contract");
    pressDays(state, 10); // 50

    state.negotiations.push({
      id: `neg-renew-${target.id}`,
      gamePlayerId: target.id,
      kind: "renew",
      counterpartTeamId: null,
      windowId: null,
      openedOn: state.date,
      expiresOn: addDays(state.date, 14),
      status: "open",
      rounds: [],
    });

    // 원인이 서지 않으니 하루 12씩 식는다
    pressDays(state, 2);
    expect(rowOf(state, target.id).value).toBe(26);
    // 0에서 멈추고, 계단도 0인 줄은 장부에서 사라진다
    pressDays(state, 3);
    expect(state.approachPressure!.some((r) => r.subject === target.id)).toBe(false);
    // 협상을 여는 것은 압력만 멈춘다 — 불만을 푸는 것은 성사뿐이다
    expect(state.issues.some((i) => i.gamePlayerId === target.id)).toBe(true);
  });

  it("계약 만료도 같은 사다리를 탄다 — 계단 4는 유출이다", () => {
    const state = quiet(createTestGame(11));
    const target = best(state);
    gripe(state, target.id, "contract");
    climbTo(state, target.id, 3);

    // contract는 하루 5 — 80일이면 400을 채운다
    pressDays(state, 80);
    expect(pendingApproach(state)).toBeNull();
    expect(state.pressLeaks).toEqual([
      { playerId: target.id, topic: "contract", date: state.date },
    ]);
  });

  it("최근 창에서 끝난 오퍼가 대리인을 부른다 — 사유가 없어도 온다", () => {
    const state = quiet(createTestGame(11));
    const target = best(state);
    closedOffer(state, target.id, { feeRatio: 1, status: "expired", daysAgo: 0 });

    // interest는 하루 8 — 12일이면 96으로 임계 100에 못 미친다
    pressDays(state, 12);
    expect(pendingApproach(state)).toBeNull();

    pressDays(state, 1);
    const open = pendingApproach(state)!;
    expect(open.topic).toBe("interest");
    expect(open.channel).toBe("agent");
    expect(open.about).toBe(target.id);
    expect(open.facts[0]?.kind).toBe("interest");
    // 불만이 아니다 — 라커룸 장부에는 아무것도 남지 않는다
    expect(state.issues).toEqual([]);
  });

  it("창이 지나면 식는다 — 답으로 지울 원인이 없다", () => {
    const state = quiet(createTestGame(11));
    const target = best(state);
    closedOffer(state, target.id, { feeRatio: 1, status: "expired", daysAgo: 0 });
    pressDays(state, 13);
    expect(respondToApproach(state, { stance: "defend" }).ok).toBe(true);

    // 창(14일)이 지난 뒤로는 원인이 서지 않아 하루 12씩 식는다
    pressDays(state, 10);
    expect(rowOf(state, target.id).value).toBe(0);
    expect(rowOf(state, target.id).step).toBe(1);
  });

  it("관심의 사다리는 3에서 멈춘다 — 유출도 요청도 서지 않는다", () => {
    const state = quiet(createTestGame(11));
    const target = best(state);
    /**
     * 창이 14일뿐이라 사다리를 굴려서는 3계단에 닿지 못한다 — 계단 3의 임계(400)를
     * 코앞에 둔 줄을 세워 두고 하루만 민다.
     */
    state.approachPressure = [{ subject: target.id, topic: "interest", value: 399, step: 3 }];
    closedOffer(state, target.id, { feeRatio: 1, status: "expired", daysAgo: 0 });

    pressDays(state, 1);
    const open = pendingApproach(state);
    expect(open?.topic).toBe("interest");
    expect(open?.step).toBe(3);
    expect(state.pressLeaks ?? []).toEqual([]);
    expect(target.state.transferRequestedOn).toBeUndefined();
  });

  it("헐값 오퍼가 흘러간 것은 세지 않는다 — 값의 자는 막힌 이적과 같다 (`isSeriousOffer`)", () => {
    const state = quiet(createTestGame(11));
    const target = best(state);
    closedOffer(state, target.id, { feeRatio: 0.5, status: "expired", daysAgo: 0 });

    pressDays(state, 13);
    expect(state.approachPressure!.some((r) => r.topic === "interest")).toBe(false);
  });

  it("경계는 상위 14명이다 — 열넷째까지 서고 열다섯째는 서지 않는다", () => {
    const state = quiet(createTestGame(11));
    const squad = rankedSquad(state);
    const core = squad[13]!; // 그보다 나은 선수 13명 — 안
    const fringe = squad[14]!; // 14명 — 밖
    closedOffer(state, core.id, { feeRatio: 1, status: "rejected", daysAgo: 0 });
    closedOffer(state, fringe.id, { feeRatio: 1, status: "expired", daysAgo: 0 });

    pressDays(state, 13);
    expect(rowOf(state, core.id).topic).toBe("interest");
    expect(state.approachPressure!.some((r) => r.subject === fringe.id)).toBe(false);
  });

  it("막힌 이적 불만과 함께 선다 — 한 사건의 두 얼굴이고 화자가 다르다", () => {
    const state = quiet(createTestGame(11));
    const target = best(state);
    closedOffer(state, target.id, { feeRatio: 1, status: "rejected", daysAgo: 0 });
    gripe(state, target.id, "blocked-move");

    pressDays(state, 13);
    const rows = state.approachPressure!.filter((r) => r.subject === target.id);
    expect(rows.map((r) => r.topic).sort()).toEqual(["blocked-move", "interest"]);
    // 그래도 열린 자리는 하나다 — 먼저 임계를 넘은 쪽(하루 9)이 선다
    expect((state.approaches ?? []).filter((a) => a.status === "pending")).toHaveLength(1);
    expect(pendingApproach(state)?.topic).toBe("blocked-move");
  });
});

/**
 * 보드 요청 — **구단주 원형이 이적창마다 거는 조건 하나** (board-demand.ts ·
 * career.md §5.2). 같은 파일에 두는 이유는 위와 같다: 세계가 감독에게 무엇을
 * 내미는가 — 요청은 다가옴의 구단주 자리가 실어 나른다.
 */
describe("보드 요청 — 요청 → 이행/불이행 → 평판", () => {
  /** 구단주의 원형을 고른다 — 페르소나는 세이브의 데이터다 (people.md §1) */
  function ownedBy(state: GameState, archetype: string): GameState {
    state.personas!.find((p) => p.role === "owner")!.archetype = archetype;
    return state;
  }

  /** 이 창의 이동 한 건 — 판정이 읽는 유일한 장부다 */
  function moved(
    state: GameState,
    windowId: string,
    dir: "in" | "out",
    fee: number,
    id: string,
    type: Transfer["type"] = "transfer",
  ) {
    state.transfers.push({
      id,
      gamePlayerId: `gp-${id}`,
      windowId,
      fromTeamId: dir === "out" ? state.userTeamId : "chelsea",
      toTeamId: dir === "out" ? "chelsea" : state.userTeamId,
      date: state.date,
      type,
      fee,
    });
  }

  it("여섯 원형 전부에 요청의 결이 있다 — 원형이 늘거나 이름이 바뀌면 여기서 선다", () => {
    for (const label of OWNER_ARCHETYPE_LABELS) {
      expect(DEMAND_OF_ARCHETYPE[label], label).toBeDefined();
    }
  });

  it("투자자형 — 매각이 앞서면 이행 +3, 판정은 창이 닫힌 다음 날이다", () => {
    const state = ownedBy(createTestGame(11), "투자자형");
    tickBoardDemands(state, []);
    const demand = openBoardDemand(state)!;
    expect(demand.kind).toBe("net-profit");
    expect(demand.deadline).toBeDefined();

    moved(state, demand.windowId, "out", 10_000_000, "t-sale");
    moved(state, demand.windowId, "in", 6_000_000, "t-buy");
    // 창이 닫히기 전에는 판정하지 않는다 — 마지막 날의 매각 한 건이 판을 뒤집을 수 있다
    tickBoardDemands(state, []);
    expect(demand.status).toBe("open");

    const before = state.manager.reputation.board;
    state.date = addDays(demand.deadline, 1);
    tickBoardDemands(state, []);
    expect(demand.status).toBe("met");
    expect(state.manager.reputation.board).toBe(before + BOARD_DEMAND.MET_BOARD);
  });

  it("투자자형 — 지출이 앞서면 불이행 −6", () => {
    const state = ownedBy(createTestGame(11), "투자자형");
    tickBoardDemands(state, []);
    const demand = openBoardDemand(state)!;
    moved(state, demand.windowId, "in", 6_000_000, "t-buy");

    const before = state.manager.reputation.board;
    state.date = addDays(demand.deadline, 1);
    tickBoardDemands(state, []);
    expect(demand.status).toBe("failed");
    expect(state.manager.reputation.board).toBe(before + BOARD_DEMAND.FAILED_BOARD);
  });

  it("축구광형 — 1군 최고를 지목하고, 떠나는 순간 불이행으로 일찍 닫힌다", () => {
    const state = ownedBy(createTestGame(11), "축구광형");
    tickBoardDemands(state, []);
    const demand = openBoardDemand(state)!;
    expect(demand.kind).toBe("keep-player");
    const star = userPlayers(state)
      .filter((p) => p.squadLevel === "first")
      .sort((a, b) => b.attributes.overall - a.attributes.overall || (a.id < b.id ? -1 : 1))[0]!;
    expect(demand.playerId).toBe(star.id);
    // 열린 동안에는 구단주의 사실 카드에 요청 줄이 선다
    expect(boardDemandFact(state)?.kind).toBe("board-demand");
    expect(boardDemandFact(state)?.about).toBe(star.id);

    const before = state.manager.reputation.board;
    playerById(state, star.id)!.teamId = "chelsea";
    state.date = addDays(state.date, 1);
    tickBoardDemands(state, []);
    // 기한 전인데도 닫힌다 — 떠난 선수는 창이 닫혀도 돌아오지 않는다
    expect(demand.status).toBe("failed");
    expect(state.manager.reputation.board).toBe(before + BOARD_DEMAND.FAILED_BOARD);
    // 같은 창에는 다시 서지 않고, 요청 줄도 내려간다
    expect(openBoardDemand(state)).toBeNull();
    expect(boardDemandFact(state)).toBeNull();
  });

  it("흥행가형 — 기준 이적료를 넘는 영입이 닿는 순간 이행으로 닫힌다", () => {
    const state = ownedBy(createTestGame(11), "흥행가형");
    tickBoardDemands(state, []);
    const demand = openBoardDemand(state)!;
    expect(demand.kind).toBe("sign-star");
    const budget = financeOf(state, state.userTeamId).transferBudget;
    expect(demand.baseline).toBe(Math.round(budget * BOARD_DEMAND.STAR_FEE_OF_BUDGET));

    const before = state.manager.reputation.board;
    moved(state, demand.windowId, "in", demand.baseline!, "t-star");
    state.date = addDays(state.date, 1);
    tickBoardDemands(state, []);
    expect(demand.status).toBe("met");
    expect(state.manager.reputation.board).toBe(before + BOARD_DEMAND.MET_BOARD);
  });

  it("흥행가형 — 예산이 하한 아래거나 동결이면 요청이 서지 않는다", () => {
    const state = ownedBy(createTestGame(11), "흥행가형");
    financeOf(state, state.userTeamId).transferBudget = BOARD_DEMAND.SIGN_STAR_MIN_BUDGET - 1;
    tickBoardDemands(state, []);
    expect(openBoardDemand(state)).toBeNull();
  });

  it("지역 유지형 — 기준값 없는 요청이다: 창이 닫힌 다음 날의 잔고 하나로 갈린다", () => {
    for (const [balance, status] of [
      [0, "met"],
      [-1, "failed"],
    ] as const) {
      const state = ownedBy(createTestGame(11), "지역 유지형");
      tickBoardDemands(state, []);
      const demand = openBoardDemand(state)!;
      expect(demand.kind).toBe("stay-solvent");
      // 발행 순간의 사실을 붙들지 않는다 — 선은 언제나 0이다
      expect(demand.baseline).toBeUndefined();

      financeOf(state, state.userTeamId).balance = balance;
      // 창이 열려 있는 동안에는 판정하지 않는다
      tickBoardDemands(state, []);
      expect(demand.status, `잔고 ${balance}`).toBe("open");

      const before = state.manager.reputation.board;
      state.date = addDays(demand.deadline, 1);
      tickBoardDemands(state, []);
      expect(demand.status, `잔고 ${balance}`).toBe(status);
      expect(state.manager.reputation.board).toBe(
        before + (status === "met" ? BOARD_DEMAND.MET_BOARD : BOARD_DEMAND.FAILED_BOARD),
      );
    }
  });

  it("국부펀드형 — 겨울 창은 조르지 않는다. 여름 창에 하나 서고 그 창에 다시 서지 않는다", () => {
    const state = ownedBy(createTestGame(11), "국부펀드형");
    const summer = state.date;
    const winter = state.windows.find((w) => w.kind === "winter")!;

    // 큰 그림의 사람은 겨울 땜질을 조르지 않는다 (people.md §2)
    state.date = winter.opensOn;
    expect(windowOpenForTeam(state, state.userTeamId)?.kind, "겨울 창이 안 열렸다").toBe("winter");
    tickBoardDemands(state, []);
    expect(openBoardDemand(state)).toBeNull();
    expect(state.boardDemands ?? []).toEqual([]);

    state.date = summer;
    tickBoardDemands(state, []);
    const demand = openBoardDemand(state)!;
    expect(demand.kind).toBe("sign-star");
    expect(demand.windowId).not.toBe(winter.id);

    // 창마다 최대 하나 — 며칠이 더 지나도 두 번째 요청이 서지 않는다
    state.date = addDays(state.date, 5);
    tickBoardDemands(state, []);
    expect(state.boardDemands).toHaveLength(1);
    expect(openBoardDemand(state)!.id).toBe(demand.id);
  });

  /**
   * 임대료는 이적 예산에서 실제로 빠져나가는 현금이라 **두 요청이 같은 셈으로 잡는다**
   * (career.md §5.2). 한쪽만 세면 같은 한 건이 요청마다 다른 무게를 갖는다.
   */
  it("임대 한 건이 스타 영입에도 순이익에도 같은 무게로 잡힌다", () => {
    const showman = ownedBy(createTestGame(11), "흥행가형");
    tickBoardDemands(showman, []);
    const signStar = openBoardDemand(showman)!;
    const fee = signStar.baseline!;
    // 이적이 아니라 임대로 들어와도 기준액을 낸 영입이다
    moved(showman, signStar.windowId, "in", fee, "t-loan-star", "loan");
    showman.date = addDays(showman.date, 1);
    tickBoardDemands(showman, []);
    expect(signStar.status).toBe("met");

    const investor = ownedBy(createTestGame(11), "투자자형");
    tickBoardDemands(investor, []);
    const netProfit = openBoardDemand(investor)!;
    // 같은 임대료가 순지출로도 잡힌다 — 매각 수입보다 1원 앞서면 불이행이다
    moved(investor, netProfit.windowId, "out", fee, "t-sale");
    moved(investor, netProfit.windowId, "in", fee + 1, "t-loan-star", "loan");
    investor.date = addDays(netProfit.deadline, 1);
    tickBoardDemands(investor, []);
    expect(netProfit.status).toBe("failed");
  });

  it("산업가형 — 임금 동결의 허용 폭은 2%다: 이내면 이행, 넘으면 불이행", () => {
    for (const [bump, status] of [
      [1.01, "met"],
      [1.05, "failed"],
    ] as const) {
      const state = ownedBy(createTestGame(11), "산업가형");
      tickBoardDemands(state, []);
      const demand = openBoardDemand(state)!;
      expect(demand.kind).toBe("wage-freeze");

      const contract = state.contracts.find(
        (c) => c.status === "active" && c.teamId === state.userTeamId && c.weeklyWage > 0,
      )!;
      contract.weeklyWage += demand.baseline! * (bump - 1);
      state.date = addDays(demand.deadline, 1);
      tickBoardDemands(state, []);
      expect(demand.status, `주급 ×${bump}`).toBe(status);
    }
  });
});

/**
 * 감독이 보드에 거는 요청 — **위와 방향이 반대인 별개 상태다** (board-request.ts ·
 * finance.md §9.6). 판정이 굴림이 아니라 한도라, 값이 도는 자리는 전부 경계다:
 * 신뢰 계수의 바닥, 살림 계수의 계단, 한도와 부른 값이 갈리는 선, 공기가 차는 날.
 */
describe("보드 요청 (감독 → 보드) — 한도가 답을 정한다", () => {
  /** 답이 나오는 판 — 잔고와 보드 평판을 원하는 자리에 세운다 */
  function board(state: GameState, balance: number, reputation: number): GameState {
    financeOf(state, state.userTeamId).balance = balance;
    state.manager.reputation.board = reputation;
    return state;
  }

  /** 답이 오는 날까지 시계를 민다 */
  function untilAnswer(state: GameState, kind: BoardRequestKind) {
    state.date = addDays(state.date, BOARD_REQUEST.RESPOND_DAYS[kind]);
    tickBoardRequests(state, []);
  }

  it("신뢰 계수는 평판 30에서 0이고 80에서 1.0, 위로는 1.2에서 멈춘다", () => {
    expect(boardTrustFactor(BOARD_REQUEST.TRUST_FLOOR)).toBe(0);
    expect(boardTrustFactor(BOARD_REQUEST.TRUST_FLOOR - 10)).toBe(0);
    expect(boardTrustFactor(80)).toBeCloseTo(1);
    expect(boardTrustFactor(100)).toBe(BOARD_REQUEST.TRUST_MAX);
  });

  it("살림 계수는 급여 비중 경고선에서 반, 위험선에서 0으로 떨어진다", () => {
    expect(boardThriftFactor(BOARD_REQUEST.WAGE_RATIO_CAUTION - 0.001)).toBe(1);
    expect(boardThriftFactor(BOARD_REQUEST.WAGE_RATIO_CAUTION)).toBe(0.5);
    expect(boardThriftFactor(BOARD_REQUEST.WAGE_RATIO_DANGER)).toBe(0);
  });

  it("답은 그 자리에서 나오지 않는다 — 종류가 정한 날에 도착해 예산에 얹힌다", () => {
    const state = board(createTestGame(11), 100_000_000, 80);
    const budgetBefore = financeOf(state, state.userTeamId).transferBudget;
    // 잔고 £100M × 0.25 × 신뢰 1.0 × 살림 1.0
    expect(boardRequestCeiling(state, "transfer-budget")).toBe(25_000_000);

    expect(requestBoard(state, { kind: "transfer-budget", amount: 20_000_000 }).ok).toBe(true);
    // 답이 오기 전날까지는 아무 일도 없다
    state.date = addDays(state.date, BOARD_REQUEST.RESPOND_DAYS["transfer-budget"] - 1);
    tickBoardRequests(state, []);
    expect(openBoardRequest(state)?.status).toBe("pending");
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(budgetBefore);

    state.date = addDays(state.date, 1);
    tickBoardRequests(state, []);
    const answered = (state.boardRequests ?? [])[0]!;
    expect(answered.status).toBe("approved");
    expect(answered.granted).toBe(20_000_000);
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(budgetBefore + 20_000_000);
    // 답은 보드 평판을 옮기지 않는다 — 구단주 요청과 갈리는 자리다
    expect(state.manager.reputation.board).toBe(80);
  });

  it("한도를 넘겨 부르면 한도만큼만 나온다 — 부분 승인은 granted < amount다", () => {
    const state = board(createTestGame(11), 100_000_000, 80);
    const budgetBefore = financeOf(state, state.userTeamId).transferBudget;
    requestBoard(state, { kind: "transfer-budget", amount: 40_000_000 });
    untilAnswer(state, "transfer-budget");

    const answered = (state.boardRequests ?? [])[0]!;
    expect(answered.status).toBe("approved");
    expect(answered.granted).toBe(25_000_000);
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(budgetBefore + 25_000_000);
  });

  it("보드 평판이 바닥이면 한도가 0이라 거절이고, 동결이면 잔고가 있어도 거절이다", () => {
    const poor = board(createTestGame(11), 100_000_000, BOARD_REQUEST.TRUST_FLOOR);
    expect(boardRequestCeiling(poor, "transfer-budget")).toBe(0);
    requestBoard(poor, { kind: "transfer-budget", amount: 1_000_000 });
    untilAnswer(poor, "transfer-budget");
    expect((poor.boardRequests ?? [])[0]!.status).toBe("rejected");

    // 동결은 돈이 아니라 규정의 문제라 물어서 풀리지 않는다 (finance.md §9.2)
    const frozen = board(createTestGame(11), 100_000_000, 100);
    financeOf(frozen, frozen.userTeamId).budgetFrozen = true;
    for (const kind of BOARD_REQUEST_KINDS) {
      expect(boardRequestCeiling(frozen, kind), kind).toBe(0);
    }
  });

  it("열린 요청은 하나뿐이고, 같은 안건은 쿨다운이 지나야 다시 걸린다", () => {
    const state = board(createTestGame(11), 100_000_000, 80);
    requestBoard(state, { kind: "transfer-budget", amount: 1_000_000 });
    // 답을 기다리는 동안에는 종류가 달라도 걸 수 없다
    expect(requestBoard(state, { kind: "wage-room", amount: 1000 }).ok).toBe(false);
    untilAnswer(state, "transfer-budget");

    // 종류가 다르면 곧바로 걸 수 있다
    expect(requestBoard(state, { kind: "transfer-budget", amount: 1_000_000 }).ok).toBe(false);
    expect(requestBoard(state, { kind: "wage-room", amount: 1000 }).ok).toBe(true);
    untilAnswer(state, "wage-room");

    const resolved = state.boardRequests!.find((r) => r.kind === "transfer-budget")!.resolvedOn!;
    state.date = addDays(resolved, BOARD_REQUEST.COOLDOWN_DAYS - 1);
    expect(requestBoard(state, { kind: "transfer-budget", amount: 1_000_000 }).ok).toBe(false);
    state.date = addDays(resolved, BOARD_REQUEST.COOLDOWN_DAYS);
    expect(requestBoard(state, { kind: "transfer-budget", amount: 1_000_000 }).ok).toBe(true);
  });

  it("주급 상향은 여력 위로 얹히고 시즌 끝에 만료된다 — 누계는 여력을 넘지 않는다", () => {
    const state = board(createTestGame(11), 100_000_000, 80);
    const ceiling = boardRequestCeiling(state, "wage-room");
    expect(ceiling).toBeGreaterThan(0);
    const roomBefore = userWageRoom(state);

    requestBoard(state, { kind: "wage-room", amount: ceiling });
    untilAnswer(state, "wage-room");
    expect(wageLiftOf(state, state.userTeamId)).toBe(ceiling);
    expect(userWageRoom(state)).toBe(roomBefore + ceiling);

    // 이미 얹힌 몫이 여력에서 빠지므로 같은 시즌에 두 번째 한도는 0이다
    expect(boardRequestCeiling(state, "wage-room")).toBe(0);

    // 만료일이 지나면 스스로 사라진다 — 지우러 오는 tick이 없다
    state.date = addDays(financeOf(state, state.userTeamId).wageLift!.until, 1);
    expect(wageLiftOf(state, state.userTeamId)).toBe(0);
  });

  it("구장은 승인 즉시 공사비가 나가고 좌석은 공기가 찬 날에 선다", () => {
    const state = board(createTestGame(11), 2_000_000_000, 80);
    const teamId = state.userTeamId;
    const before = clubProfileIn(state, teamId).capacity;
    const seats = boardRequestCeiling(state, "stadium");
    // 잔고가 넉넉하면 여력을 정하는 것은 지금 수용인원이다
    expect(seats).toBe(Math.floor(before * BOARD_REQUEST.SEATS_OF_CAPACITY));

    const balanceBefore = financeOf(state, teamId).balance;
    requestBoard(state, { kind: "stadium", amount: seats });
    untilAnswer(state, "stadium");
    const built = state.boardRequests!.find((r) => r.kind === "stadium")!;
    expect(built.status).toBe("approved");
    expect(financeOf(state, teamId).balance).toBe(balanceBefore - seats * BOARD_REQUEST.SEAT_COST);
    /**
     * 공사비는 **자본 지출**이다 — 현금은 오늘 나가지만 손익은 자산이 내용연수에
     * 나눠 문다 (finance.md §6.1-1). 착공 달 하나가 PSR을 통째로 먹지 않는다.
     */
    const spent = financeOf(state, teamId).ledger.filter((e) => categoryOf(e) === "capex");
    expect(spent).toHaveLength(1);
    const asset = financeOf(state, teamId).assets?.[0];
    expect(asset?.cost).toBe(seats * BOARD_REQUEST.SEAT_COST);
    expect(asset?.months).toBe(STADIUM_ASSET_MONTHS);
    // 돈은 나갔지만 좌석은 아직 없다
    expect(clubProfileIn(state, teamId).capacity).toBe(before);
    // 공사 중에는 다시 걸 수 없다 — 여력이 수용인원에서 나오므로 복리로 커진다
    state.date = addDays(built.resolvedOn!, BOARD_REQUEST.COOLDOWN_DAYS);
    expect(requestBoard(state, { kind: "stadium", amount: 100 }).ok).toBe(false);

    state.date = addDays(built.deliversOn!, -1);
    tickBoardRequests(state, []);
    expect(clubProfileIn(state, teamId).capacity).toBe(before);

    state.date = built.deliversOn!;
    tickBoardRequests(state, []);
    expect(clubProfileIn(state, teamId).capacity).toBe(before + seats);
    // 두 번 얹지 않는다
    state.date = addDays(state.date, 1);
    tickBoardRequests(state, []);
    expect(clubProfileIn(state, teamId).capacity).toBe(before + seats);
  });

  /** 구단주의 원형이 되걸기의 결을 정한다 — 페르소나는 세이브의 데이터다 */
  function ownedBy(state: GameState, archetype: string): GameState {
    state.personas!.find((p) => p.role === "owner")!.archetype = archetype;
    return state;
  }

  /** 우리가 판 한 건 — `raise` 조건이 읽는 유일한 장부다 */
  function sold(state: GameState, fee: number) {
    state.transfers.push({
      id: `tr-out-${fee}`,
      gamePlayerId: "gp-sold",
      windowId: null,
      fromTeamId: state.userTeamId,
      toTeamId: "chelsea",
      date: state.date,
      type: "transfer",
      fee,
    });
  }

  it("되거는 원형은 부분 승인 대신 조건을 걸고, 장부가 채워진 날 부른 값 그대로 승인이다", () => {
    const state = ownedBy(board(createTestGame(11), 100_000_000, 80), "투자자형");
    const before = financeOf(state, state.userTeamId).transferBudget;
    // 한도 £25M < 부른 £40M — 되거는 원형이라 절반을 내주는 대신 조건이 선다
    requestBoard(state, { kind: "transfer-budget", amount: 40_000_000 });
    untilAnswer(state, "transfer-budget");

    const asked = openBoardRequest(state)!;
    expect(asked.status).toBe("conditional");
    expect(asked.condition).toEqual({
      kind: "raise",
      // 모자란 만큼이다 — 굴리지 않는다
      amount: 15_000_000,
      since: state.date,
      until: addDays(state.date, BOARD_REQUEST.CONDITION_DAYS),
    });
    // 답이 끝나지 않은 요청이라 `resolvedOn`이 서지 않고 다음 안건도 막는다
    expect(asked.resolvedOn).toBeUndefined();
    expect(requestBoard(state, { kind: "wage-room", amount: 1000 }).ok).toBe(false);
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(before);

    sold(state, 15_000_000);
    state.date = addDays(state.date, 1);
    tickBoardRequests(state, []);

    const answered = state.boardRequests!.find((r) => r.kind === "transfer-budget")!;
    expect(answered.status).toBe("approved");
    // 되건 것은 약속이라 한도를 다시 재지 않는다 — 부른 값 그대로다
    expect(answered.granted).toBe(40_000_000);
    expect(answered.resolvedOn).toBe(state.date);
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(before + 40_000_000);
  });

  it("조건을 기한까지 못 채우면 거절이다 — 부분 승인으로 되돌아가지 않는다", () => {
    const state = ownedBy(board(createTestGame(11), 100_000_000, 80), "투자자형");
    const before = financeOf(state, state.userTeamId).transferBudget;
    requestBoard(state, { kind: "transfer-budget", amount: 40_000_000 });
    untilAnswer(state, "transfer-budget");
    const until = openBoardRequest(state)!.condition!.until;

    // 기한 당일까지는 아직 살아 있다
    state.date = until;
    tickBoardRequests(state, []);
    expect(openBoardRequest(state)?.status).toBe("conditional");

    state.date = addDays(until, 1);
    tickBoardRequests(state, []);
    const answered = state.boardRequests!.find((r) => r.kind === "transfer-budget")!;
    expect(answered.status).toBe("rejected");
    expect(answered.granted).toBe(0);
    expect(answered.resolvedOn).toBe(state.date);
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(before);
  });

  it("되걸지 않는 원형은 지금대로 부분 승인이다", () => {
    const state = ownedBy(board(createTestGame(11), 100_000_000, 80), "국부펀드형");
    requestBoard(state, { kind: "transfer-budget", amount: 40_000_000 });
    untilAnswer(state, "transfer-budget");
    const answered = state.boardRequests![0]!;
    expect(answered.status).toBe("approved");
    expect(answered.granted).toBe(25_000_000);
  });

  it("건별 영입 승인분은 그 선수 밖으로 새지 않는다 — 확정도 만료도 예산을 늘리지 않는다", () => {
    const state = board(createTestGame(11), 100_000_000, 80);
    const teamId = state.userTeamId;
    const before = financeOf(state, teamId).transferBudget;
    const outside = state.players.filter((p) => p.teamId !== teamId);
    const target = outside[0]!;
    const other = outside[1]!;

    // 잔고 £100M × 0.40 — 총액 증액(0.25)보다 큰 자리다
    expect(boardRequestCeiling(state, "signing")).toBe(40_000_000);
    expect(requestBoard(state, { kind: "signing", amount: 30_000_000 }).ok).toBe(false);
    expect(
      requestBoard(state, { kind: "signing", amount: 30_000_000, playerId: target.id }).ok,
    ).toBe(true);
    untilAnswer(state, "signing");

    const answered = state.boardRequests![0]!;
    expect(answered.status).toBe("approved");
    expect(answered.granted).toBe(30_000_000);
    // 이적 예산에는 한 푼도 얹히지 않는다 — 승인은 이름 하나에 대한 것이다
    expect(financeOf(state, teamId).transferBudget).toBe(before);
    expect(signingBudgetOf(state, target.id)).toBe(before + 30_000_000);
    expect(signingBudgetOf(state, other.id)).toBe(before);
    // 걸려 있는 몫만큼 다음 건별 승인의 여력이 준다
    expect(boardRequestCeiling(state, "signing")).toBe(10_000_000);

    // 기한이 지나면 사라진다 — 예산으로 흘러들지 않는다
    state.date = addDays(state.date, BOARD_REQUEST.EARMARK_DAYS + 1);
    tickBoardRequests(state, []);
    expect(earmarkedFor(state, target.id)).toBe(0);
    expect(financeOf(state, teamId).transferBudget).toBe(before);

    /**
     * 확정되는 날 — **오늘 나갈 만큼만** 예산으로 옮겨 앉고 줄은 통째로 사라진다.
     * 남은 몫이 예산에 남으면 다음 영입이 그 돈을 쓴다 (finance.md §9.6).
     */
    financeOf(state, teamId).earmarked = [
      {
        requestId: answered.id,
        gamePlayerId: target.id,
        amount: 30_000_000,
        until: addDays(state.date, 10),
      },
    ];
    expect(consumeEarmark(state, target.id, 12_000_000)).toBe(12_000_000);
    expect(financeOf(state, teamId).transferBudget).toBe(before + 12_000_000);
    expect(earmarkedFor(state, target.id)).toBe(0);
  });
});

/**
 * 수석코치의 눈 — **원형이 같은 장부에서 무엇을 먼저 보는가** (coach-cues.ts).
 *
 * 이 표가 없으면 6원형은 말투에만 남는다 — 데이터 분석가형과 야전 조련사형이
 * 같은 스냅샷을 읽고 같은 것을 말한다 (people.md §7-1).
 */
describe("수석코치의 눈", () => {
  /** 이 세이브의 수석코치를 그 원형으로 갈아 끼운다 — 원형은 시드가 뽑으므로 */
  const asCoach = (state: GameState, key: string) => {
    const coach = (state.personas ?? []).find((p) => p.role === "head_coach");
    coach!.archetype = COACH_ARCHETYPE_LABELS[key]!;
    return state;
  };

  /** 다음 경기를 오늘로부터 `days` 뒤로 옮긴다 — 그 앞의 다른 대진은 뒤로 민다 */
  const fixtureIn = (state: GameState, days: number) => {
    const next = state.matches
      .filter(
        (m) =>
          m.result === null &&
          (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
      )
      .sort((a, b) => (a.date < b.date ? -1 : 1))[0]!;
    state.date = addDays(next.date, -days);
    return next;
  };

  it("6원형 전부가 표에 있다 — 빠진 원형은 빈 카드가 된다", () => {
    expect([...COACH_EYE_KEYS].sort()).toEqual(Object.keys(COACH_ARCHETYPE_LABELS).sort());
    // 세이브에 남는 것은 라벨이다 — 라벨로 키를 되찾지 못하면 그 코치는 빈손이다
    for (const [key, label] of Object.entries(COACH_ARCHETYPE_LABELS)) {
      expect(coachArchetypeKeyOf({ archetype: label })).toBe(key);
    }
    expect(coachArchetypeKeyOf({ archetype: "사라진 원형" })).toBeNull();
  });

  it("조련사는 경기 3일 안일 때만 지친 선발을 짚는다 — 체력 60이 경계다", () => {
    const state = asCoach(createTestGame(11), "drill_sergeant");
    fixtureIn(state, 3);
    const starters = assignmentsOf(state, state.userTeamId, "starting")
      .map((a) => playerById(state, a.playerId))
      .filter((p): p is NonNullable<typeof p> => p !== null);
    for (const p of starters) p.state.condition = 90;
    const worn = starters[0]!;

    worn.state.condition = 61;
    expect(coachCues(state).some((c) => c.code === "tired")).toBe(false);

    worn.state.condition = 60;
    const cue = coachCues(state).find((c) => c.code === "tired");
    expect(cue?.fact).toContain(`${worn.name} 60`);
    expect(cue?.playerIds).toContain(worn.id);

    // 나흘 뒤 경기는 아직 회복이 걸리는 자리가 아니다
    state.date = addDays(state.date, -1);
    expect(coachCues(state).some((c) => c.code === "tired")).toBe(false);
  });

  it("원형이 다르면 다른 갈래의 사실이 선다 — 같은 세이브, 같은 날", () => {
    const base = createTestGame(11);
    fixtureIn(base, 2);
    const codesOf = (key: string) =>
      coachCues(asCoach(structuredClone(base), key)).map((c) => c.code);

    const sergeant = codesOf("drill_sergeant");
    const analyst = codesOf("analyst");
    const tactician = codesOf("veteran_tactician");
    expect(analyst.length).toBeGreaterThan(0);
    expect(tactician.length).toBeGreaterThan(0);
    for (const code of analyst) expect(sergeant).not.toContain(code);
    for (const code of tactician) expect(analyst).not.toContain(code);
    // 한 턴에 두 장까지 — 갈래가 셋인 원형도 자리는 둘이다
    expect(analyst.length).toBeLessThanOrEqual(2);
  });

  it("자리보다 갈래가 많으면 날짜로 굴러 뒷 사실도 차례가 온다", () => {
    const base = asCoach(createTestGame(11), "analyst");
    fixtureIn(base, 5);
    const one = (offset: number) => {
      const day = structuredClone(base);
      day.date = addDays(base.date, offset);
      return coachCues(day, 1).map((c) => c.code);
    };
    const seen = new Set([...one(0), ...one(1)]);
    // 한 장만 실리는 날에도 같은 사실이 이틀 연속 맨 앞에 서지 않는다
    expect(seen.size).toBe(2);
  });

  it("무직이면 벤치에 앉을 사람이 없다 — 한 장도 서지 않는다", () => {
    const state = asCoach(createTestGame(11), "club_loyalist");
    state.dismissal = { on: state.date, season: state.season, teamId: state.userTeamId };
    expect(coachCues(state)).toEqual([]);
  });

  /**
   * 훈련 결산은 **원형이 고르지 않는다** — 훈련장은 어느 원형이든 이 코치가 여는
   * 자리라, 눈 하나로 넣으면 그 원형을 쓰는 감독에게만 자기 훈련의 결과가 닿는다
   * (people.md §7-1 · season.md §4).
   */
  it("훈련 결산은 원형 앞에 서고 2장 상한을 지지 않는다", () => {
    const base = createTestGame(11);
    fixtureIn(base, 2);
    const someone = userPlayers(base)[0]!;
    base.trainingReports = [
      {
        from: addDays(base.date, -6),
        to: base.date,
        sessions: 6,
        moved: [{ gamePlayerId: someone.id, target: "tactical", delta: 1 }],
        marks: [{ gamePlayerId: someone.id, code: "standout", note: "마지막까지 남았다" }],
      },
    ];
    const cuesOf = (key: string) => coachCues(asCoach(structuredClone(base), key));

    for (const key of COACH_EYE_KEYS) {
      expect(cuesOf(key)[0]?.code, `${key}에게 결산이 첫 줄로 서지 않았다`).toBe("training-report");
    }
    // 원형의 두 장은 그대로다 — 결산이 자리를 뺏지 않는다 (갈래가 셋인 원형)
    const analyst = cuesOf("analyst");
    expect(analyst.filter((c) => c.code !== "training-report")).toHaveLength(2);
    // 눈을 되찾지 못한 원형에게도 이 한 장은 간다
    const orphan = coachCues(asCoach(structuredClone(base), "club_loyalist"));
    expect(orphan[0]!.fact).toContain(`${someone.name}`);
    expect(orphan[0]!.fact).toContain("두드러짐");

    // 창(3일)을 넘긴 카드는 소식이 아니라 기록이다 — 달력이 갖는다
    const stale = structuredClone(base);
    stale.date = addDays(base.date, 4);
    expect(coachCues(stale).some((c) => c.code === "training-report")).toBe(false);
  });

  /**
   * 임대 리포트도 **원형이 고르지 않는다** — 리콜은 이적 창 안에서만 되는 결정이라,
   * 유스형이 아닌 코치를 쓰는 감독이 근거 없이 복귀일을 맞으면 안 된다
   * (season.md §2 임대).
   */
  it("임대 리포트는 이달 1일에 서고 사흘 뒤 사라진다 — 임대가 없으면 서지 않는다", () => {
    const base = createTestGame(11);
    base.date = `${base.date.slice(0, 7)}-01`;
    // 임대가 하나도 없으면 자리를 채우려고 사실을 만들지 않는다
    expect(coachCues(base).some((c) => c.code === "loan-report")).toBe(false);

    const target =
      userPlayers(base).find((p) => p.squadLevel === "reserve") ?? userPlayers(base)[0]!;
    target.teamId = "chelsea";
    target.loan = {
      fromTeamId: base.userTeamId,
      until: addDays(base.date, 180),
      wageShare: 0.5,
    };

    // 유망주를 보지 않는 원형에게도 이 한 장은 간다 — 원형의 자리를 쓰지 않는다
    const elsewhere = coachCues(asCoach(structuredClone(base), "club_loyalist"));
    const cue = elsewhere.find((c) => c.code === "loan-report");
    expect(cue?.fact).toContain(target.name);
    expect(cue?.playerIds).toContain(target.id);

    // 창 안이면 선다 — 사흘째까지
    const on = (offset: number) => {
      const day = structuredClone(base);
      day.date = addDays(base.date, offset);
      return coachCues(day).some((c) => c.code === "loan-report");
    };
    expect(on(3)).toBe(true);
    // 나흘째는 소식이 아니라 기록이다 — 다음 달 1일이 새로 세운다
    expect(on(4)).toBe(false);
  });

  it("아무것도 안 움직인 구간도 사실로 선다 — 빈자리는 지어낸다", () => {
    const state = createTestGame(11);
    state.trainingReports = [
      { from: state.date, to: state.date, sessions: 2, moved: [], marks: [] },
    ];
    const cue = coachCues(state).find((c) => c.code === "training-report");
    expect(cue?.fact).toContain("훈련 2회 결산");
    expect(cue?.fact).toContain("장부에 남은 변화 없음");
  });
});
