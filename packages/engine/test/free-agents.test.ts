import { describe, expect, it } from "vitest";
import {
  FREE_AGENT_TEAM,
  activeContract,
  answerOffer,
  freeAgents,
  isClubTeam,
  loanPlayer,
  offerPlayerOut,
  openNegotiationFor,
  pendingVerdicts,
  playerById,
  playersOf,
  releasePlayer,
  runAiRenewals,
  sendOffer,
  signFreeAgents,
  userPlayers,
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
    const target = spare(state);
    releasePlayer(state, { playerId: target.id });

    const digest: string[] = [];
    for (let i = 0; i < 400 && freeAgents(state).length > 0; i++) {
      state.date = `2026-07-${String((i % 28) + 1).padStart(2, "0")}`;
      signFreeAgents(state, digest);
    }
    const after = state.players.find((p) => p.id === target.id)!;
    if (after.teamId === FREE_AGENT_TEAM) return; // 아무도 안 데려갈 수도 있다
    expect(isClubTeam(after.teamId)).toBe(true);
    expect(activeContract(state, target.id)?.teamId).toBe(after.teamId);
    expect(digest.join("")).toContain(after.name ?? "");
  });

  it("감독이 직접 데려온다 — 무소속엔 파는 쪽 스쿼드 하한이 없다", () => {
    const state = createTestGame(11);
    state.date = "2026-08-01";
    const target = spare(state);
    const wage = activeContract(state, target.id)!.weeklyWage;
    releasePlayer(state, { playerId: target.id });
    expect(target.teamId).toBe(FREE_AGENT_TEAM);

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

  it("우리 팀은 이 경로로 선수를 받지 않는다 — 감독이 직접 데려와야 한다", () => {
    const state = createTestGame(11);
    const before = playersOf(state, state.userTeamId).length;
    const target = spare(state);
    releasePlayer(state, { playerId: target.id });
    const digest: string[] = [];
    for (let i = 0; i < 200; i++) signFreeAgents(state, digest);
    expect(playersOf(state, state.userTeamId).length).toBeLessThan(before);
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
    const contractBefore = activeContract(state, target.id)!;
    const res = sendOffer(state, {
      playerId: target.id,
      fee: 3_000_000,
      weeklyWage: Math.round(contractBefore.weeklyWage * 0.5),
      years: 1,
      kind: "loan",
    });
    expect(res.ok, res.message).toBe(true);
    const negotiation = openNegotiationFor(state, target.id)!;
    expect(negotiation.kind).toBe("loan");

    state.date = negotiation.rounds[0]!.respondsOn!;
    const verdict = answerOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    if (!verdict.ok) return; // 확률이 바닥이면 코어가 막는다

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
    contract.until = "2026-12-31";

    sendOffer(state, { playerId: target.id, fee: 20_000_000, weeklyWage: 90_000, years: 4 });
    expect(openNegotiationFor(state, target.id)).not.toBeNull();

    const digest: string[] = [];
    for (let i = 0; i < 500 && openNegotiationFor(state, target.id); i++) {
      runAiRenewals(state, digest);
    }
    if (openNegotiationFor(state, target.id)) return; // 재계약을 안 할 수도 있다
    expect(activeContract(state, target.id)!.until > "2026-12-31").toBe(true);
  });

  it("우리 선수는 건드리지 않는다 — 재계약은 감독의 일이다", () => {
    const state = createTestGame(11);
    const ours = userPlayers(state)[0]!;
    const until = activeContract(state, ours.id)!.until;
    const digest: string[] = [];
    for (let i = 0; i < 300; i++) runAiRenewals(state, digest);
    expect(activeContract(state, ours.id)!.until).toBe(until);
  });
});

describe("임대 내보내기도 흥정이다 — 상대가 받아 줘야 한다", () => {
  it("send_offer(kind=loan_out) → 판정 → 확정이면 그쪽으로 간다", () => {
    const state = createTestGame(11);
    state.date = "2026-08-01";
    const target = spare(state);
    const wage = activeContract(state, target.id)!.weeklyWage;

    const res = offerPlayerOut(state, {
      playerId: target.id,
      teamId: "chelsea",
      fee: 500_000,
      weeklyWage: Math.round(wage * 0.6),
      loan: true,
    });
    expect(res.ok, res.message).toBe(true);
    const negotiation = openNegotiationFor(state, target.id)!;
    expect(negotiation.kind).toBe("loan_out");

    state.date = negotiation.rounds[0]!.respondsOn!;
    const verdict = answerOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    if (!verdict.ok) return;
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
    const respondsOn = negotiation.rounds[0]!.respondsOn!;
    if (respondsOn > state.date) {
      expect(pendingVerdicts(state), "답이 오기 전엔 서지 않는다").toHaveLength(0);
    }
    state.date = respondsOn;
    const waiting = pendingVerdicts(state);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.action).toBe("respond_offer");
  });

  it("합의된 협상은 확정을 기다린다", () => {
    const state = createTestGame(11);
    state.date = "2026-08-01";
    const target = spare(state);
    offerPlayerOut(state, { playerId: target.id, teamId: "chelsea", fee: 500_000 });
    const negotiation = openNegotiationFor(state, target.id)!;
    state.date = negotiation.rounds[0]!.respondsOn!;
    if (!answerOffer(state, { negotiationId: negotiation.id, verdict: "accept" }).ok) return;
    const waiting = pendingVerdicts(state);
    expect(waiting[0]!.action).toBe("accept_deal");
  });
});
