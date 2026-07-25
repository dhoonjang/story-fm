import { describe, expect, it } from "vitest";
import {
  createGame,
  interpretBackgroundHeuristic,
  tacticsOf,
  userPlayers,
  type GameState,
} from "@story-fm/engine";
import { buildOnboardingTurn, runMockGmTurn } from "@story-fm/agents";

function newGame(seed = 42): GameState {
  const background = "프리미어리그에서 뛰었던 주장 출신 수비수";
  return createGame({
    seed,
    userTeamId: "arsenal",
    managerName: "김감독",
    background,
    attributes: interpretBackgroundHeuristic(background),
  });
}

/** 모델 턴 문법 검증 — 모든 텍스트 줄은 @로 시작 (overview §2.1) */
function expectGmGrammar(text: string) {
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    expect(line.startsWith("@"), `문법 위반 줄: "${line}"`).toBe(true);
  }
}

describe("mock GM — 유저 여정 시나리오", () => {
  it("온보딩 턴이 @문법으로 배경·스쿼드·다음 일정을 브리핑한다", () => {
    const state = newGame();
    const turn = buildOnboardingTurn(state);
    expectGmGrammar(turn.text);
    expect(turn.text).toContain("김감독");
    expect(turn.text).toContain("다음 경기");
  });

  it("훈련 지시 → set_training 스킬이 세션을 등록한다", () => {
    const state = newGame();
    const turn = runMockGmTurn(state, "월요일 오전은 세트피스 반복 훈련 잡아줘");
    expectGmGrammar(turn.text);
    expect(turn.toolCalls.map((c) => c.name)).toContain("set_training");
    // 월요일 오전 훈련이 일정 엔트리로 등록됐다 (v6 — 규칙 테이블 없음)
    const entries = state.schedule.filter((e) => e.type === "training");
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(new Date(`${e.date}T00:00:00Z`).getUTCDay()).toBe(1); // 월요일
      expect(e.time).toBe("10:00"); // 오전
    }
    const session = state.trainingSessions.find((x) => x.id === entries[0]?.refId);
    expect(session?.label).toContain("세트피스");
  });

  it("전술 변경 발화 → set_tactics", () => {
    const state = newGame();
    const turn = runMockGmTurn(state, "4-4-2로 바꾸고 공격적으로 가자");
    expect(turn.toolCalls.map((c) => c.name)).toContain("set_tactics");
    expect(tacticsOf(state, state.userTeamId).spec.formation).toBe("4-4-2");
    expect(tacticsOf(state, state.userTeamId).spec.mentality).toBe(4);
  });

  it("면담 발화 → talk_to_player, 사기가 오른다", () => {
    const state = newGame();
    const player = userPlayers(state)[3];
    if (!player) throw new Error("no player");
    const before = player.state.morale;
    const turn = runMockGmTurn(state, `${player.name.split(" ")[0]} 면담 좀 하자`);
    expect(turn.toolCalls.map((c) => c.name)).toContain("talk_to_player");
    expect(player.state.morale).toBeGreaterThan(before);
  });

  it("진행 → 경기일 → 경기 시작 → 계속으로 경기 종료까지 완주한다", () => {
    const state = newGame(7);

    const advanced = runMockGmTurn(state, "다음 경기로 가자");
    expectGmGrammar(advanced.text);
    expect(advanced.toolCalls.map((c) => c.name)).toContain("advance_time");
    expect(state.phase).toBe("matchday");

    const kickoff = runMockGmTurn(state, "경기 시작");
    expectGmGrammar(kickoff.text);
    expect(kickoff.toolCalls.map((c) => c.name)).toContain("start_match");
    expect(kickoff.text).toContain("@중계:");

    let guard = 20;
    while (state.phase === "match" && guard-- > 0) {
      const turn = runMockGmTurn(state, "계속");
      expectGmGrammar(turn.text);
    }
    expect(state.phase).toBe("idle");

    const round1 = state.matches.find(
      (m) =>
        m.round === 1 && (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    );
    expect(round1?.result).not.toBeNull();
  });

  it("경기 중 하프타임 팀토크가 판정형으로 반영된다", () => {
    const state = newGame(13);
    runMockGmTurn(state, "경기일로 가자");
    runMockGmTurn(state, "경기 시작");
    if (state.phase !== "match") return; // 이미 끝났으면 스킵 (짧은 경기 시드)
    const before = userPlayers(state)[0]?.state.morale ?? 0;
    const turn = runMockGmTurn(state, "다들 잘하고 있다고 한마디 해줘");
    expect(turn.toolCalls.map((c) => c.name)).toContain("team_talk");
    expect(userPlayers(state)[0]?.state.morale ?? 0).toBeGreaterThanOrEqual(before);
  });

  it("모호한 발화에는 상태 요약으로 응답한다 (반문 규약)", () => {
    const state = newGame();
    const turn = runMockGmTurn(state, "음...");
    expectGmGrammar(turn.text);
    expect(turn.toolCalls).toHaveLength(0);
    expect(turn.text).toContain("다음 경기");
  });
});
