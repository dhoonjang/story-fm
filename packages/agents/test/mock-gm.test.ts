import { describe, expect, it } from "vitest";
import {
  KNOCK_BOARD_HIT,
  RENEWAL_YEARS_MAX,
  activeContract,
  addDays,
  counterpartyAnchor,
  createGame,
  financeOf,
  generateIncomingOffers,
  tickInterests,
  incomingOffers,
  interpretBackgroundHeuristic,
  openNegotiationFor,
  openRenewal,
  pendingOffer,
  playerById,
  playersOf,
  renewalExpectation,
  suggestTerms,
  tacticsOf,
  teamName,
  tierOfTeamIn,
  type GameState,
  userPlayers,
} from "@story-fm/engine";
import {
  TIME_PASSED,
  buildCounterpartyBlock,
  buildGmTools,
  buildOnboardingTurn,
  runMockGmTurn,
} from "@story-fm/agents";

function build(seed: number): GameState {
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
 * 시드 42의 세계를 **한 번만** 세우고 케이스마다 복제한다 — `createGame`은 판당
 * 수 초, 복제는 그 수십 분의 일이다. 다른 시드가 필요한 케이스만 따로 짓는다.
 */
const BASE = build(42);
const newGame = (): GameState => structuredClone(BASE);

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
  });

  /**
   * 폴백 장면은 **상태만 읽는다** — 같은 세이브를 두 번 열면 같은 장면이고, 세계가
   * 다르면 장면도 갈린다. 방향이 결정적이라 시드 둘이면 잡힌다(열 판을 세울 이유가
   * 없다 — 판당 수 초다).
   */
  it("온보딩 폴백은 같은 세이브에서 재현되고 다른 세계에선 장면이 달라진다", () => {
    const state = newGame();
    expect(buildOnboardingTurn(state).text).toBe(buildOnboardingTurn(state).text);
    // 첫 줄은 시점(모든 세이브가 7월 1일)이므로 장면이 갈리는 건 그다음 줄이다
    const opening = (seed: number) => buildOnboardingTurn(build(seed)).text.split("\n")[1];
    expect(opening(1)).not.toBe(opening(2));
  });

  /**
   * 모의 GM도 **실모드와 같은 것을 기록해야** 화면이 같다.
   *
   * 항목 요약(`brief`)을 안 실으면 말풍선이 조용히 옛 문자열로 폴백해, 요약을
   * 고쳐도 mock으로 플레이하는 동안에는 아무것도 달라지지 않는다.
   */
  it("훈련 지시 → 기록이 항목 요약을 함께 싣고, 감독의 말을 세션 이름으로 쓰지 않는다", () => {
    const state = newGame();
    const said = "응 그리고 훈련 싹다 갈아엎자. 체력 훈련 싹 지우고, 패스 훈련에 집중하자";
    const turn = runMockGmTurn(state, said);
    const call = turn.toolCalls.find((c) => c.name === "set_training")!;
    expect(call.brief!.items.length).toBeGreaterThan(0);
    // 요일을 몇 개로 펼치든 항목 하나로 접힌다 — 그게 말풍선 한 줄이다
    expect(call.brief!.items).toHaveLength(1);
    // 감독의 발화는 세션 이름이 아니다 — 달력에도 요약에도 박히면 안 된다
    const labels = state.trainingSessions.filter((x) => !x.auto).map((x) => x.label);
    for (const label of labels) expect(said).not.toContain(label);
    expect(JSON.stringify(call.brief)).not.toContain("갈아엎자");
    // 장면은 도구 결과를 인용하지 않는다 — 같은 사실이 대사와 말풍선에 두 번 서면 안 된다
    expect(turn.text).not.toContain(call.summary);
  });

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
    const state = build(7);

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
    const state = build(13);
    runMockGmTurn(state, "경기일로 가자");
    runMockGmTurn(state, "경기 시작");
    expect(state.phase).toBe("match");
    // **첫 인-매치 턴은 킥오프 휘슬이다** — 도구를 부르지 않는 자리라 한 턴 흘린다
    expect(runMockGmTurn(state, "계속").toolCalls).toHaveLength(0);
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
  });
});

describe("mock GM — 이적 협상", () => {
  it("선수를 지목하면 오퍼를 넣고, 답이 오면 확률대로 판정한다", () => {
    const state = newGame();
    // 살 수 있는 상대 팀 선수를 하나 고른다
    const budget = financeOf(state, state.userTeamId).transferBudget;
    const wanted = state.players.find((p) => {
      if (p.teamId === state.userTeamId) return false;
      const terms = suggestTerms(state, p.id);
      return terms !== null && terms.fee > 1_000_000 && terms.fee < budget * 0.5;
    })!;
    // 원 소속은 지금 읽어 둔다 — `wanted`는 상태 안의 살아 있는 객체다
    const fromTeamId = wanted.teamId;

    const sent = runMockGmTurn(state, `${wanted.name} 데려오자`);
    expect(sent.toolCalls.map((c) => c.name)).toContain("send_offer");
    const negotiation = openNegotiationFor(state, wanted.id)!;
    expect(negotiation).toBeDefined();

    // 답이 오는 날로 이동한 뒤 다시 물으면 상대편이 되어 판정한다
    state.date = pendingOffer(negotiation)!.respondsOn!;
    const answered = runMockGmTurn(state, "협상 어떻게 됐나");
    expect(answered.toolCalls.map((c) => c.name)).toContain("respond_offer");
    // 답이 온 오퍼는 판정을 받는다 — 대기 중인 채로 남지 않는다
    expect(pendingOffer(negotiation)).toBeNull();
    expect(negotiation.status).not.toBe("open");
    /**
     * 선수가 옮겨 앉는 것은 **계약 확정(completed)** 뿐이다. 구단 합의(agreed)에서
     * 이미 소속을 바꾸면 개인 조건이 깨졌을 때 되돌릴 자리가 없다.
     */
    expect(playerById(state, wanted.id)!.teamId).toBe(
      negotiation.status === "completed" ? state.userTeamId : fromTeamId,
    );
  });

  it("받은 오퍼는 감독의 말에 따라 거절·조정·수락된다", () => {
    const state = newGame();
    const digest: string[] = [];
    // tick과 같은 순서 — 오퍼는 `bidding`까지 오른 관심에서 나온다 (transfer.md §1-2)
    for (let i = 0; i < 90 && incomingOffers(state).length === 0; i++) {
      state.date = addDays(state.date, 1);
      tickInterests(state, digest);
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
    const state = newGame();
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
    // 기대 주급대로 제안했으므로 수락된다 — 확정이면 계약 기간이 실제로 늘어난다
    expect(renewal.status).toBe("completed");
    expect(activeContract(state, player.id)!.until > addDays(state.date, 120)).toBe(true);
  });
});

/**
 * **실모드의 교섭** — mock은 앵커를 그대로 반영하지만(위), 실모드는 GM이 상대가 되어
 * 낸 판정이 `rule_offer_response`의 스키마를 지나 코어의 폭으로 잘린다 (agents.md §4-1).
 *
 * 재계약의 연수는 **스키마에 칸이 없으면 파싱에서 조용히 버려진다** — 코어가 폭을
 * 만들어 둬도 언제나 앵커 연수가 서고, 화면에는 정상으로 보인다. 서류에 폭이 적히지
 * 않는 것도 마찬가지로 드러나지 않는다. 두 자리를 여기서 함께 잰다.
 */
describe("교섭 — GM이 되부르는 연수", () => {
  it("폭 밖의 연수도 반려되지 않고 폭 끝으로 잘려 라운드에 남는다", async () => {
    const state = newGame();
    const player = playersOf(state, state.userTeamId)[0]!;
    activeContract(state, player.id)!.until = addDays(state.date, 120);
    // 기대치보다 낮게 불러 앵커를 조정 자리에 세운다 — 수락이면 되부를 것이 없다
    const opened = openRenewal(state, {
      playerId: player.id,
      weeklyWage: Math.round(renewalExpectation(state, player) * 0.8),
      years: 3,
    });
    expect(opened.ok, opened.message).toBe(true);
    const renewal = state.negotiations.find((n) => n.kind === "renew")!;
    state.date = pendingOffer(renewal)!.respondsOn!;
    const anchor = counterpartyAnchor(state, renewal)!;
    expect(anchor.allowed).toContain("counter");
    // 스키마가 열어 둔 폭(계약 상한)은 코어의 폭(앵커 ±1년)보다 넓다 — 그래서 자를 것이 있다
    expect(anchor.yearsRoom!.max).toBeLessThan(RENEWAL_YEARS_MAX);

    // 서류에 폭이 없으면 모델은 연수를 판정의 재료로 읽지도 못한다
    const block = buildCounterpartyBlock(state, renewal);
    expect(block).toContain(`조정 연수: 기준 ${anchor.contractYears}년`);
    expect(block).toContain(`<counterparty id="${renewal.id}">`);

    const tool = buildGmTools(state, []).find((t) => t.name === "rule_offer_response")!;
    const settled = await tool.handle({
      negotiationId: renewal.id,
      verdict: "counter",
      contractYears: RENEWAL_YEARS_MAX,
    });
    expect(settled.ok, settled.message).toBe(true);
    expect(renewal.rounds[renewal.rounds.length - 1]!.contractYears).toBe(anchor.yearsRoom!.max);
    // 답이 선 협상은 서류가 더 서지 않는다 — 두 번 답하지 않는다
    expect(buildCounterpartyBlock(state, renewal)).toBeNull();
  });
});

/**
 * **mock의 기록 조건은 실모드와 같다** — `recordCall` 하나를 쓰므로 성공한 호출만
 * 남는다 (agents.md §8). 갈라져 있던 시절 mock에만 실패 칩이 서서, e2e가 실모드에는
 * 없는 칩을 보고 통과했다.
 */
describe("mock GM — 기록은 성공한 호출만", () => {
  it("같은 선수에게 재계약을 두 번 열면 두 번째는 기록에 서지 않는다", () => {
    const state = newGame();
    const player = playersOf(state, state.userTeamId)[0]!;
    activeContract(state, player.id)!.until = addDays(state.date, 120);

    const first = runMockGmTurn(state, `${player.name} 재계약 하자`);
    expect(first.toolCalls.map((c) => c.name)).toContain("open_renewal");

    // 같은 날 다시 — 협상이 이미 열려 있어 코어가 막는다
    const second = runMockGmTurn(state, `${player.name} 재계약 하자`);
    expect(second.toolCalls.map((c) => c.name)).not.toContain("open_renewal");
    // 왜 안 됐는지는 장면이 말한다 — 칩이 없다고 감독이 모르는 것은 아니다
    expect(second.text.length).toBeGreaterThan(0);
    expect(state.negotiations.filter((n) => n.kind === "renew")).toHaveLength(1);
  });
});

/**
 * **무직이 아는 도구도 셋이다** — 수락·흥정·노크 (career.md §5.1). 실모드가 여는
 * 도구 집합과 같아야 mock으로 도는 경로가 실모드에 없는 길을 만들지 않는다.
 */
describe("mock GM — 무직", () => {
  /** 경질장과 열린 제안 하나를 직접 세운다 — 판정 경로는 엔진 테스트가 잰다 */
  function dismissed(): { state: GameState; offerId: string } {
    const state = newGame();
    const target = state.teams.find((t) => t.id !== state.userTeamId)!;
    state.dismissal = { on: state.date, season: state.season, teamId: state.userTeamId };
    const offerId = "mgr-offer-test";
    state.managerOffers = [
      {
        id: offerId,
        teamId: target.id,
        madeOn: state.date,
        expiresOn: addDays(state.date, 10),
        tier: 2,
        target: 10,
        expectationCode: "mid",
        salary: 3_000_000,
        years: 3,
        budgetPledge: 20_000_000,
        status: "open",
      },
    ];
    return { state, offerId };
  }

  it("흥정 → 수락 — 옛 구단 수석코치가 화자로 서지 않는다", () => {
    const { state, offerId } = dismissed();

    const haggled = runMockGmTurn(state, "연봉을 더 받아내자");
    expect(haggled.toolCalls.map((c) => c.name)).toContain("counter_manager_offer");
    expect(state.managerOffers![0]!.counteredOn).toBe(state.date);
    // 무직인 감독 옆에는 구단의 사람이 없다 — 장면은 내레이션뿐이다
    for (const line of haggled.text.split("\n").slice(1)) {
      expect(line.startsWith("@:"), `무직 장면에 화자가 섰다: "${line}"`).toBe(true);
    }

    const taken = runMockGmTurn(state, "그 자리 수락하겠다");
    expect(taken.toolCalls.map((c) => c.name)).toContain("accept_manager_offer");
    expect(state.dismissal).toBeUndefined();
    expect(state.managerOffers!.find((o) => o.id === offerId)!.status).toBe("accepted");
  });

  it("부르는 곳이 없으면 공석에 먼저 지원한다", () => {
    const { state } = dismissed();
    const vacant = state.teams.find((t) => t.id !== state.userTeamId)!;
    state.managerOffers = [];
    state.managerVacancies = [{ teamId: vacant.id, on: state.date }];

    const knocked = runMockGmTurn(state, "그 자리에 지원해보자");
    expect(knocked.toolCalls.map((c) => c.name)).toContain("apply_manager_job");
  });
});

/**
 * **재직 중에도 거취는 열려 있다** (career.md §5.1 「재직 중 접근·노크」). 코어가 연
 * 자리에 mock이 말로 닿지 못하면 그 길은 e2e를 통과하지 못한다.
 */
describe("mock GM — 재직 중의 거취", () => {
  /** 다른 구단이 재직 중인 감독에게 손을 뻗었다 — 보상금까지 실린 접근 제안 하나 */
  function poached(): { state: GameState; teamId: string } {
    const state = newGame();
    const target = state.teams.find((t) => t.id !== state.userTeamId)!;
    state.managerOffers = [
      {
        id: "mgr-poach-test",
        teamId: target.id,
        madeOn: state.date,
        expiresOn: addDays(state.date, 10),
        tier: 2,
        target: 10,
        expectationCode: "mid",
        salary: 3_000_000,
        years: 3,
        budgetPledge: 20_000_000,
        compensation: 1_000_000,
        via: "poach",
        status: "open",
      },
    ];
    return { state, teamId: target.id };
  }

  it("이직 제안을 흥정하고 수락하면 그날로 그 벤치에 선다", () => {
    const { state, teamId } = poached();

    const haggled = runMockGmTurn(state, "이직 제안 말인데, 연봉을 더 받아내자");
    expect(haggled.toolCalls.map((c) => c.name)).toContain("counter_manager_offer");
    expect(state.managerOffers![0]!.counteredOn).toBe(state.date);

    const taken = runMockGmTurn(state, `${teamName(teamId)}로 가겠다`);
    expect(taken.toolCalls.map((c) => c.name)).toContain("accept_manager_offer");
    expect(state.userTeamId).toBe(teamId);
  });

  /**
   * **문이 좁아야 한다** — 열린 제안이 있다는 이유로 가로채면 재직 중의 평범한 턴이
   * 전부 이 자리로 떨어진다. 흥정의 말은 이적 협상도 쓰는 말이다.
   */
  it("열린 제안이 일상 지시와 이적의 말을 가로채지 않는다", () => {
    const { state, teamId } = poached();
    expect(
      runMockGmTurn(state, "내일 오전 빌드업 훈련하자").toolCalls.map((c) => c.name),
    ).toContain("set_training");
    // 「더 받아내자」는 이적 협상의 말이기도 하다 — 구단 이름이 붙어도 거취가 아니다
    const haggle = runMockGmTurn(state, `${teamName(teamId)} 오퍼는 더 받아내자`);
    expect(haggle.toolCalls.map((c) => c.name)).not.toContain("counter_manager_offer");
    expect(state.managerOffers![0]!.counteredOn).toBeUndefined();
  });

  it("재직 중에도 공석을 두드린다 — 자리가 서는 날 보드가 그것을 안다", () => {
    const state = newGame();
    // 문턱이 없는 등급을 고른다 — 두드림이 반드시 자리로 이어져야 대가를 잴 수 있다
    const vacant = state.teams.find(
      (t) => t.id !== state.userTeamId && tierOfTeamIn(state, t.id) === 4,
    )!;
    state.managerVacancies = [{ teamId: vacant.id, on: state.date }];
    const board = state.manager.reputation.board;

    const knocked = runMockGmTurn(state, `${teamName(vacant.id)} 감독직에 지원하자`);
    expect(knocked.toolCalls.map((c) => c.name)).toContain("apply_manager_job");
    expect(state.manager.reputation.board).toBe(board - KNOCK_BOARD_HIT);
  });
});
