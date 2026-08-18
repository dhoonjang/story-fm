import { describe, expect, it } from "vitest";
import {
  FREE_AGENT_TEAM,
  LOAN_FEE_RATE,
  activeContract,
  addDays,
  answerOffer,
  dealOdds,
  freeAgents,
  isClubTeam,
  loanPlayer,
  offerPlayerOut,
  openNegotiationFor,
  pendingVerdicts,
  marketValueOf,
  playerById,
  playersOf,
  releasePlayer,
  runAiRenewals,
  sendOffer,
  signFreeAgents,
  userPlayers,
  wageExpectationOf,
  weeklyWagesOf,
  windowOpenOn,
  withdrawOffer,
  type GameState,
} from "@story-fm/engine";
import { completeDeal, createTestGame } from "./helpers";

const spare = (state: GameState) => {
  const squad = userPlayers(state).sort((a, b) => a.attributes.overall - b.attributes.overall);
  return squad.find((p) => p.positions[0]?.position !== "GK") ?? squad[0]!;
};

/**
 * 내보내는 딜의 **결정적 픽스처** — 이 파일의 매각·임대 송출 케이스가 공유한다.
 *
 * 두 가지가 케이스를 조용히 죽인다. ① 스쿼드 맨 밑은 유스라 몸값이 0이고
 * (`baseValueOf` 하한) 그러면 "사는 쪽 상한의 몇 %를 불렀나"가 언제나 0%라
 * 확률이 0으로 떨어진다. ② 시장가 위로 부르면 같은 자리에서 하한(5%)에 걸린다.
 * 둘 다 코어가 옳게 막는 것이라, 예전엔 `if (!verdict.ok) return`으로 빠져 나가
 * 케이스가 한 줄도 안 돌았다.
 *
 * **오퍼를 손으로 세우지는 않는다** — 이 케이스들이 재는 것이 바로
 * `offer_player_out → 판정 → 확정` 경로 자체다. 경로는 그대로 두고 값만 눈금
 * 위로 올려, 주사위가 빗나갈 수 없게 만든다.
 */
const outgoing = (state: GameState, kind: "sell" | "loan_out") => {
  const player = userPlayers(state)
    .sort((a, b) => a.attributes.overall - b.attributes.overall)
    .find((p) => p.positions[0]?.position !== "GK" && marketValueOf(state, p) > 0);
  expect(player, "값이 붙는 매물이 스쿼드에 없다").toBeDefined();
  const value = marketValueOf(state, player!);
  return {
    player: player!,
    fee: Math.round(value * (kind === "loan_out" ? LOAN_FEE_RATE : 0.5)),
  };
};

describe("무소속 — 클럽이 아니라 클럽이 없는 상태", () => {
  // 새 게임을 읽기만 하는 케이스가 함께 쓴다 — 세계를 다시 세우지 않는다
  const fresh = createTestGame(11);

  it("게임 시작 시 비어 있다", () => {
    expect(freeAgents(fresh)).toHaveLength(0);
    expect(isClubTeam(FREE_AGENT_TEAM)).toBe(false);
  });

  /**
   * 무소속은 **클럽이 아니다** — 팀 엔티티 한 줄만 있고 재정도 전술도 AI 감독도
   * 없다 (team.md §4). 만들어 두면 £4.8M을 쥔 "무소속 구단"이 이적료를 지불하고
   * 순위표 밖에서 감독을 경질당한다.
   */
  it("재정도 전술도 AI 감독도 갖지 않는다 — 팀 엔티티 한 줄뿐이다", () => {
    const team = fresh.teams.find((t) => t.id === FREE_AGENT_TEAM);
    // 방출된 선수의 `teamId`가 가리킬 자리라 팀 자체는 서 있어야 한다
    expect(team, "무소속 팀 엔티티가 없다").toBeDefined();
    expect(team!.aiManagerTacticsRating).toBeUndefined();
    expect(team!.managerSince).toBeUndefined();
    expect(fresh.finances.some((f) => f.teamId === FREE_AGENT_TEAM)).toBe(false);
    expect(fresh.tactics.some((t) => t.teamId === FREE_AGENT_TEAM)).toBe(false);
  });

  it("방출하면 무소속이 된다 — 계약이 끊긴다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    target.squadNumber = 77;
    releasePlayer(state, { playerId: target.id });
    expect(state.players.find((p) => p.id === target.id)!.teamId).toBe(FREE_AGENT_TEAM);
    expect(activeContract(state, target.id)).toBeNull();
    expect(target.squadNumber).toBeUndefined();
    expect(freeAgents(state).some((p) => p.id === target.id)).toBe(true);
  });

  it("다른 구단이 데려간다 — 자리가 얇고 수준이 맞는 곳으로", () => {
    const state = createTestGame(11);
    /**
     * **스쿼드 중간을 내놓는다.** 영입은 수준이 맞는 구단만 하므로
     * (`SUITOR_LEVEL_BAND` — 팀 상위 15명 평균과 ±7), 맨 밑의 유스는 어느 리그와도
     * 눈금이 안 맞아 영원히 무소속으로 남는다. 그건 이 케이스가 재려는 것이 아니다.
     */
    const squad = userPlayers(state).sort((a, b) => a.attributes.overall - b.attributes.overall);
    const target = squad[Math.floor(squad.length / 2)]!;
    releasePlayer(state, { playerId: target.id });

    /**
     * **날짜를 앞으로만 민다.** `signFreeAgents`의 rng는 (시드, 날짜) 하나로
     * 정해지므로 같은 날을 다시 부르면 같은 눈이 나온다 — 스물여덟 날을 돌려
     * 쓰면 400번을 불러도 실제 시도는 스물여덟 번이다.
     */
    const digest: string[] = [];
    for (let i = 0; i < 200 && freeAgents(state).length > 0; i++) {
      state.date = addDays(state.date, 1);
      signFreeAgents(state, digest);
    }
    const after = state.players.find((p) => p.id === target.id)!;
    expect(after.teamId, "200일 동안 아무도 데려가지 않았다").not.toBe(FREE_AGENT_TEAM);
    expect(isClubTeam(after.teamId)).toBe(true);
    expect(activeContract(state, target.id)?.teamId).toBe(after.teamId);
    expect(digest.join("")).toContain(after.name ?? "");
    // **우리 팀은 이 경로로 받지 않는다** — 감독이 직접 데려와야 한다
    expect(after.teamId, "가만히 있었는데 스쿼드가 채워졌다").not.toBe(state.userTeamId);
  });

  it("감독이 직접 데려온다 — 무소속엔 파는 쪽 스쿼드 하한이 없다", () => {
    const state = createTestGame(11);
    state.date = "2026-08-01";
    const target = spare(state);
    releasePlayer(state, { playerId: target.id });
    expect(target.teamId).toBe(FREE_AGENT_TEAM);

    /**
     * **옛 계약 주급이 아니라 기대 주급을 부른다.** 방출 전 주급은 그 구단이
     * 매기던 값이라 선수의 기대치와 무관하다 — 어린 유망주는 둘이 크게 벌어져,
     * 옛 주급으로 부르면 성사 확률 0%가 나오고 시드가 바뀔 때마다 흔들린다.
     */
    const wage = dealOdds(state, {
      playerId: target.id,
      fee: 0,
      weeklyWage: 0,
      years: 2,
      kind: "buy",
    }).wageExpectation;
    const offered = sendOffer(state, { playerId: target.id, fee: 0, weeklyWage: wage, years: 2 });
    expect(offered.ok, offered.message).toBe(true);
    const negotiation = openNegotiationFor(state, target.id)!;
    state.date = negotiation.rounds[0]!.respondsOn!;
    const verdict = answerOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(verdict.ok, verdict.message).toBe(true);

    const done = completeDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    expect(negotiation.status).toBe("completed");
    expect(playerById(state, target.id)!.teamId).toBe(state.userTeamId);
    expect(activeContract(state, target.id)!.teamId).toBe(state.userTeamId);
  });

  /**
   * **무소속엔 이적료를 받을 구단이 없다.** 막지 않으면 그 돈이 세계 밖으로 나간다 —
   * 예전엔 무소속이 £4.8M 장부를 갖고 있어서 £5M이 아무도 쓰지 않는 잔고로 사라졌다.
   */
  it("이적료를 붙인 오퍼는 무소속에게 넣을 수 없다 — 공짜면 통한다", () => {
    const state = createTestGame(11);
    state.date = "2026-08-01";
    const target = spare(state);
    const wage = activeContract(state, target.id)!.weeklyWage;
    releasePlayer(state, { playerId: target.id });
    const offer = { playerId: target.id, weeklyWage: wage, years: 2 };

    const paid = sendOffer(state, { ...offer, fee: 5_000_000 });
    expect(paid.ok, "무소속에 이적료가 붙었다").toBe(false);
    // 막는 것은 이적료지 영입이 아니다
    expect(sendOffer(state, { ...offer, fee: 0 }).ok).toBe(true);
  });

  it("창이 닫힌 날의 결렬은 30일이면 식는다 — 창으로 재면 영구 배제가 된다", () => {
    const state = createTestGame(11);
    state.date = "2026-11-15";
    expect(windowOpenOn(state.windows, state.date)).toBeNull();
    const target = spare(state);
    const wage = activeContract(state, target.id)!.weeklyWage;
    releasePlayer(state, { playerId: target.id });
    const offer = { playerId: target.id, fee: 0, weeklyWage: wage, years: 2 };

    expect(sendOffer(state, offer).ok).toBe(true);
    withdrawOffer(state, openNegotiationFor(state, target.id)!.id);
    expect(sendOffer(state, offer).ok, "아직 식지 않았다").toBe(false);

    state.date = "2026-12-20";
    expect(windowOpenOn(state.windows, state.date)).toBeNull();
    const again = sendOffer(state, offer);
    expect(again.ok, again.message).toBe(true);
  });
});

describe("임대 영입 — 사는 게 아니라 빌리는 것", () => {
  const targetOf = (state: GameState) =>
    playersOf(state, "chelsea")
      .filter((p) => p.teamId !== state.userTeamId)
      .sort((a, b) => a.attributes.overall - b.attributes.overall)[2]!;

  it("임대 오퍼 → 수락 → 확정이면 계약은 그대로 두고 선수만 온다", () => {
    const state = createTestGame(11);
    state.date = "2026-08-01";
    const target = targetOf(state);
    // 임대료·주급을 상대가 부르는 값 위로 얹는다 — 확률이 하한(5%)에 걸리지 않게
    const res = sendOffer(state, {
      playerId: target.id,
      fee: Math.round(marketValueOf(state, target) * LOAN_FEE_RATE * 1.5),
      weeklyWage: Math.round(wageExpectationOf(state, target) * 1.2),
      years: 1,
      kind: "loan",
    });
    expect(res.ok, res.message).toBe(true);
    const negotiation = openNegotiationFor(state, target.id)!;
    expect(negotiation.kind).toBe("loan");

    state.date = negotiation.rounds[0]!.respondsOn!;
    const verdict = answerOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(verdict.ok, verdict.message).toBe(true);

    const done = completeDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    const after = state.players.find((p) => p.id === target.id)!;
    expect(after.teamId).toBe(state.userTeamId);
    expect(after.loan!.fromTeamId).toBe("chelsea");
    // 계약은 원소속에 남는다
    expect(activeContract(state, target.id)!.teamId).toBe("chelsea");
  });

  it("주급은 분담한다 — 양쪽 총액에 파생으로 반영된다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    const wage = activeContract(state, target.id)!.weeklyWage;
    const ourBefore = weeklyWagesOf(state, state.userTeamId);
    const theirBefore = weeklyWagesOf(state, "chelsea");
    loanPlayer(state, { playerId: target.id, teamId: "chelsea", wageShare: 0.4 });
    expect(weeklyWagesOf(state, state.userTeamId)).toBeCloseTo(ourBefore - wage * 0.4, 0);
    expect(weeklyWagesOf(state, "chelsea")).toBeCloseTo(theirBefore + wage * 0.4, 0);
  });
});

describe("다른 구단도 계약을 관리한다", () => {
  it("재계약하면 노리던 협상이 그 자리에서 끝난다", () => {
    const state = createTestGame(11);
    state.date = "2026-08-01";
    // 계약이 곧 끝나는 타 팀 선수를 만든다
    const target = playersOf(state, "chelsea").find((p) => p.teamId !== state.userTeamId)!;
    const contract = activeContract(state, target.id)!;
    const until = "2027-06-30";
    contract.until = until;

    sendOffer(state, { playerId: target.id, fee: 20_000_000, weeklyWage: 90_000, years: 4 });
    expect(openNegotiationFor(state, target.id)).not.toBeNull();

    /**
     * **이 선수의 계약 하나만 남긴다.** 판정은 하루에 한 번이고 매번 세계의 모든
     * 계약을 훑으므로, 그대로 두면 케이스 하나가 몇 분을 쓴다. 오퍼는 이미
     * 온전한 세계에서 넣었고, 여기서 보는 것은 그 뒤의 한 갈래다.
     */
    state.contracts = state.contracts.filter((c) => c.gamePlayerId === target.id);

    // 검토 창(만료 240일 전)이 열리는 날부터 하루씩 — 날짜를 안 밀면 같은 눈만 나온다
    state.date = "2026-11-02";
    const digest: string[] = [];
    for (let i = 0; i < 240 && openNegotiationFor(state, target.id); i++) {
      runAiRenewals(state, digest);
      state.date = addDays(state.date, 1);
    }
    expect(openNegotiationFor(state, target.id), "검토 창 내내 재계약이 없었다").toBeNull();
    expect(activeContract(state, target.id)!.until > until).toBe(true);
  });

  it("우리 선수는 건드리지 않는다 — 재계약은 감독의 일이다", () => {
    const state = createTestGame(11);
    const ours = userPlayers(state)[0]!;
    const until = activeContract(state, ours.id)!.until;
    const digest: string[] = [];
    for (let i = 0; i < 120; i++) {
      runAiRenewals(state, digest);
      state.date = addDays(state.date, 1);
    }
    expect(activeContract(state, ours.id)!.until).toBe(until);
  });
});

describe("임대 내보내기도 흥정이다 — 상대가 받아 줘야 한다", () => {
  it("send_offer(kind=loan_out) → 판정 → 확정이면 그쪽으로 간다", () => {
    const state = createTestGame(11);
    state.date = "2026-08-01";
    const { player: target, fee } = outgoing(state, "loan_out");
    const wage = activeContract(state, target.id)!.weeklyWage;

    const res = offerPlayerOut(state, {
      playerId: target.id,
      teamId: "chelsea",
      fee,
      weeklyWage: Math.round(wage * 0.6),
      loan: true,
    });
    expect(res.ok, res.message).toBe(true);
    const negotiation = openNegotiationFor(state, target.id)!;
    expect(negotiation.kind).toBe("loan_out");

    state.date = negotiation.rounds[0]!.respondsOn!;
    const verdict = answerOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(verdict.ok, verdict.message).toBe(true);
    const done = completeDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    const after = state.players.find((p) => p.id === target.id)!;
    expect(after.teamId).toBe("chelsea");
    expect(after.loan!.fromTeamId).toBe(state.userTeamId);
    // 계약은 우리 것으로 남는다
    expect(activeContract(state, target.id)!.teamId).toBe(state.userTeamId);
  });
});

describe("판정을 기다리는 협상은 눈에 띈다", () => {
  it("답이 도착하면 pendingVerdicts에 선다", () => {
    const state = createTestGame(11);
    state.date = "2026-08-01";
    const target = playersOf(state, "chelsea").find((p) => p.teamId !== state.userTeamId)!;
    sendOffer(state, { playerId: target.id, fee: 15_000_000, weeklyWage: 80_000, years: 4 });
    const negotiation = openNegotiationFor(state, target.id)!;
    /**
     * 답신 지연 0일은 설계다(`responseDelayDays`) — 그 선수가 걸리면 "기다리는
     * 동안"을 잴 수 없으므로 답신일을 이틀 뒤로 못 박고 두 상태를 다 본다.
     */
    const respondsOn = addDays(state.date, 2);
    negotiation.rounds[0]!.respondsOn = respondsOn;
    expect(pendingVerdicts(state), "답이 오기 전엔 서지 않는다").toHaveLength(0);
    state.date = respondsOn;
    const waiting = pendingVerdicts(state);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.action).toBe("respond_offer");
  });

  it("합의된 협상은 확정을 기다린다", () => {
    const state = createTestGame(11);
    state.date = "2026-08-01";
    const { player: target, fee } = outgoing(state, "sell");
    offerPlayerOut(state, { playerId: target.id, teamId: "chelsea", fee });
    const negotiation = openNegotiationFor(state, target.id)!;
    state.date = negotiation.rounds[0]!.respondsOn!;
    const answered = answerOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(answered.ok, answered.message).toBe(true);
    const waiting = pendingVerdicts(state);
    expect(waiting[0]!.action).toBe("accept_deal");
  });
});
