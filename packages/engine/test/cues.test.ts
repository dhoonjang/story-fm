import { describe, expect, it } from "vitest";
import { addDays, playerById, speakerCues, userPlayers, type GameState } from "@story-fm/engine";
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
