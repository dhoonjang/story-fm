import { describe, expect, it } from "vitest";
import {
  addDays,
  APPROACH_THRESHOLD,
  approachThreshold,
  pendingApproach,
  playerById,
  respondToApproach,
  speakerCues,
  tickApproaches,
  userPlayers,
  type GameState,
} from "@story-fm/engine";
import type { PlayerIssueReason } from "@story-fm/domain";
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
    const target = firsts(state, 1)[0]!;
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

  it("열려 있는 동안에는 다음 자리가 열리지 않는다", () => {
    const state = quiet(createTestGame(11));
    const [a, b] = firsts(state, 2);
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
    const target = firsts(state, 1)[0]!;
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
    const target = firsts(state, 1)[0]!;
    gripe(state, target.id);
    pressDays(state, 15);

    expect(respondToApproach(state, { decline: true }).ok).toBe(true);
    const row = state.approachPressure!.find((r) => r.subject === target.id)!;
    expect(row.value).toBe(APPROACH_THRESHOLD * 0.75);
    expect(row.step).toBe(1);
  });

  it("답이 원인을 지우지는 않는다 — 불만은 그대로 남는다", () => {
    const state = quiet(createTestGame(11));
    const target = firsts(state, 1)[0]!;
    gripe(state, target.id);
    pressDays(state, 15);
    respondToApproach(state, { stance: "own" });
    expect(state.issues.some((i) => i.gamePlayerId === target.id)).toBe(true);
  });
});

describe("원인이 사라지면 식는다", () => {
  it("불만이 풀리면 압력이 빠지고, 계단은 남는다", () => {
    const state = quiet(createTestGame(11));
    const target = firsts(state, 1)[0]!;
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
    const target = firsts(state, 1)[0]!;
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
    const target = firsts(state, 1)[0]!;
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
