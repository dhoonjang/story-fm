import { describe, expect, it } from "vitest";
import {
  activeContract,
  addDays,
  createGame,
  financeOf,
  generateIncomingOffers,
  incomingOffers,
  interpretBackgroundHeuristic,
  openNegotiationFor,
  pendingOffer,
  playerById,
  playersOf,
  suggestTerms,
  tacticsOf,
  type GameState,
  userPlayers,
} from "@story-fm/engine";
import { TIME_PASSED, buildOnboardingTurn, runMockGmTurn } from "@story-fm/agents";

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

/**
 * 모델 턴 문법 검증 — **첫 줄은 장면의 시점**이고, 나머지 텍스트 줄은 @로 시작한다
 * (overview §2.1). 시점 줄이 시계를 움직이므로 문법의 일부다.
 */
function expectGmGrammar(text: string) {
  const lines = text.split("\n");
  const first = lines.find((line) => line.trim().length > 0)?.trim() ?? "";
  expect(/^\[[^\]]+\]$/u.test(first), `첫 줄이 시점이 아니다: "${first}"`).toBe(true);
  for (const line of lines.slice(lines.indexOf(first) + 1)) {
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

  it("온보딩 폴백은 같은 시드로 재현되고 다른 시드에선 장면이 달라진다", () => {
    expect(buildOnboardingTurn(newGame(42)).text).toBe(buildOnboardingTurn(newGame(42)).text);
    // 첫 줄은 시점(모든 세이브가 7월 1일)이므로 장면이 갈리는 건 그다음 줄이다
    const openings = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map(
        (seed) => buildOnboardingTurn(newGame(seed)).text.split("\n")[1],
      ),
    );
    expect(openings.size).toBeGreaterThan(1);
    // 새 게임 10판 — 세계가 커지면서 `createGame`이 판당 1초를 넘는다.
    // 시드마다 실제로 다른 세계를 만드는 게 이 테스트의 요점이라 판수를 줄이지 않는다.
  }, 60_000);

  it("훈련 지시 → set_training 스킬이 세션을 등록한다", () => {
    const state = newGame();
    const turn = runMockGmTurn(state, "월요일 오전은 세트피스 반복 훈련 잡아줘");
    expectGmGrammar(turn.text);
    expect(turn.toolCalls.map((c) => c.name)).toContain("set_training");
    // 월요일 오전 훈련이 일정 엔트리로 등록됐다 (v6 — 규칙 테이블 없음).
    // 기본 훈련(training-plan)과 섞이므로 감독이 지시한 세션만 본다
    const ordered = new Set(
      state.trainingSessions
        .filter((s) => s.label.includes("세트피스") && !s.auto)
        .map((s) => s.id),
    );
    const entries = state.schedule.filter((e) => e.type === "training" && ordered.has(e.refId));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(new Date(`${e.date}T00:00:00Z`).getUTCDay()).toBe(1); // 월요일
      expect(e.time).toBe("10:00"); // 오전
    }
  });

  it("포메이션 이름은 프리셋을 적용하지 않고 전술 축만 반영한다", () => {
    const state = newGame();
    const before = tacticsOf(state, state.userTeamId).spec.formation;
    const turn = runMockGmTurn(state, "4-4-2로 바꾸고 공격적으로 가자");
    expect(turn.toolCalls.map((c) => c.name)).toContain("set_tactics");
    expect(tacticsOf(state, state.userTeamId).spec.formation).toBe(before);
    expect(tacticsOf(state, state.userTeamId).spec.mentality).toBe(4);
  });

  it("면담 발화 → talk_to_player, 사기가 오른다", () => {
    const state = newGame();
    const player = userPlayers(state)[3];
    if (!player) throw new Error("no player");
    const before = player.state.form;
    // 이름 조각은 2자 이상이어야 선수를 지목한다 (mock GM detectPlayer) —
    // "벤 화이트"처럼 이름이 한 글자인 선수는 성으로 부른다
    const call = player.name.split(" ").reduce((a, b) => (b.length > a.length ? b : a));
    const turn = runMockGmTurn(state, `${call} 면담 좀 하자`);
    expect(turn.toolCalls.map((c) => c.name)).toContain("talk_to_player");
    expect(player.state.form).toBeGreaterThan(before);
  });

  it("진행 → 경기일 → 경기 시작 → 계속으로 경기 종료까지 완주한다", () => {
    const state = newGame(7);

    // 이적 오퍼·부상 같은 attention 정지는 감독의 결정을 기다리며 멈춘다 —
    // 경기일에 닿을 때까지 다시 진행시킨다 (감독이 실제로 하는 일과 같다)
    const advanced = runMockGmTurn(state, "다음 경기로 가자");
    expectGmGrammar(advanced.text);
    // 시계 이동은 스킬이 아니라 코어의 처리 결과라 사람이 읽는 이름으로 남는다
    expect(advanced.toolCalls.map((c) => c.name)).toContain(TIME_PASSED);
    let toMatchday = 30;
    while (state.phase !== "matchday" && toMatchday-- > 0) {
      runMockGmTurn(state, "다음 경기로 가자");
    }
    expect(state.phase).toBe("matchday");

    // 킥오프는 세 걸음 — 도구가 문을 열고, 감독이 들어서고, 그다음 공이 구른다
    const opened = runMockGmTurn(state, "경기 시작");
    expectGmGrammar(opened.text);
    expect(opened.toolCalls.map((c) => c.name)).toContain("start_match");
    expect(opened.text).not.toContain("@중계:");
    expect(state.pendingMatch?.entered).not.toBe(true);

    // 입장 턴은 첫 휘슬만 — 사건은 아직 없다
    const entered = runMockGmTurn(state, "경기장 입장");
    expectGmGrammar(entered.text);
    expect(entered.text).toContain("@중계:");
    expect(state.pendingMatch?.entered).toBe(true);
    expect(state.pendingMatch?.segment).toBe(0);
    expect(entered.goals ?? []).toHaveLength(0);

    // 구간은 그다음부터 간다
    const first = runMockGmTurn(state, "계속");
    expectGmGrammar(first.text);
    expect(state.pendingMatch?.segment ?? 0).toBeGreaterThan(0);

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
    const before = userPlayers(state)[0]?.state.condition ?? 0;
    const turn = runMockGmTurn(state, "다들 잘하고 있다고 한마디 해줘");
    expect(turn.toolCalls.map((c) => c.name)).toContain("team_talk");
    expect(userPlayers(state)[0]?.state.condition ?? 0).toBeGreaterThanOrEqual(before);
  });

  it("모호한 발화에는 상태 요약으로 응답한다 (반문 규약)", () => {
    const state = newGame();
    const turn = runMockGmTurn(state, "음...");
    expectGmGrammar(turn.text);
    expect(turn.toolCalls).toHaveLength(0);
    expect(turn.text).toContain("다음 경기");
  });
});

describe("mock GM — 이적 협상", () => {
  it("선수를 지목하면 오퍼를 넣고, 답이 오면 확률대로 판정한다", () => {
    const state = newGame(42);
    // 살 수 있는 상대 팀 선수를 하나 고른다
    const budget = financeOf(state, state.userTeamId).transferBudget;
    const wanted = state.players.find((p) => {
      if (p.teamId === state.userTeamId) return false;
      const terms = suggestTerms(state, p.id);
      return terms !== null && terms.fee > 1_000_000 && terms.fee < budget * 0.5;
    })!;

    const sent = runMockGmTurn(state, `${wanted.name} 데려오자`);
    expect(sent.toolCalls.map((c) => c.name)).toContain("send_offer");
    const negotiation = openNegotiationFor(state, wanted.id)!;
    expect(negotiation).toBeDefined();

    // 답이 오는 날로 이동한 뒤 다시 물으면 상대편이 되어 판정한다
    state.date = pendingOffer(negotiation)!.respondsOn!;
    const answered = runMockGmTurn(state, "협상 어떻게 됐나");
    expect(answered.toolCalls.map((c) => c.name)).toContain("respond_offer");
    expect(["agreed", "rejected", "open", "completed"]).toContain(negotiation.status);
    // 수락됐다면 계약까지 확정한다 (mock은 확률 50% 이상에서 수락)
    if (pendingOffer(negotiation) === null && negotiation.status === "completed") {
      expect(playerById(state, wanted.id)!.teamId).toBe(state.userTeamId);
    }
  });

  it("받은 오퍼는 감독의 말에 따라 거절·역제안·수락된다", () => {
    const state = newGame(42);
    const digest: string[] = [];
    for (let i = 0; i < 60 && incomingOffers(state).length === 0; i++) {
      state.date = addDays(state.date, 1);
      generateIncomingOffers(state, digest);
    }
    const incoming = incomingOffers(state)[0]!;
    expect(incoming).toBeDefined();

    const refused = runMockGmTurn(state, "그 오퍼는 거절해");
    expect(refused.toolCalls.map((c) => c.name)).toContain("respond_offer");
    expect(incoming.status).toBe("rejected");
  });
});

describe("mock GM — 재계약", () => {
  it("재계약을 제안하고, 답이 오면 선수 본인이 되어 판정한다", () => {
    const state = newGame(42);
    const player = playersOf(state, state.userTeamId)[0]!;
    activeContract(state, player.id)!.until = addDays(state.date, 120);

    const proposed = runMockGmTurn(state, `${player.name} 재계약 하자`);
    expect(proposed.toolCalls.map((c) => c.name)).toContain("open_renewal");
    const renewal = state.negotiations.find((n) => n.kind === "renew")!;
    expect(renewal).toBeDefined();
    expect(renewal.counterpartTeamId).toBeNull();

    state.date = pendingOffer(renewal)!.respondsOn!;
    const answered = runMockGmTurn(state, `${player.name} 재계약 어떻게 됐나`);
    expect(answered.toolCalls.map((c) => c.name)).toContain("respond_offer");
    // 기대 주급대로 제안했으므로 대체로 수락된다
    if (renewal.status === "completed") {
      expect(activeContract(state, player.id)!.until > addDays(state.date, 120)).toBe(true);
    }
  });
});
