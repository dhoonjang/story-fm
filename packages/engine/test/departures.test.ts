import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOAN_WAGE_SHARE,
  activeContract,
  loanPlayer,
  loanedOut,
  movePlayerSlot,
  playersOf,
  recallLoan,
  releasePlayer,
  setPlayerTraining,
  severanceOf,
  userPlayers,
  userTactics,
  weeklyWagesOf,
  type GameState,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

/**
 * 팀을 떠나는 다른 길들 — 방출·임대 (departures.ts).
 * 둘 다 **대가가 분명한 선택**이라 밸런스가 흔들리지 않는다:
 * 방출은 돈을 잃고, 임대는 전력을 잃는다.
 */

/** 주전이 아닌 선수 — 스쿼드 하한에 걸리지 않게 뒤에서 고른다 */
const spare = (state: GameState) => {
  const squad = userPlayers(state).sort((a, b) => a.attributes.overall - b.attributes.overall);
  return squad.find((p) => p.positions[0]?.position !== "GK") ?? squad[0]!;
};

describe("방출 — 돈으로 자리를 비운다", () => {
  it("위약금을 물고 계약이 끝난다 — 주급 총액에서 사라진다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    const wagesBefore = weeklyWagesOf(state, state.userTeamId);
    const severance = severanceOf(state, target.id);
    expect(severance).toBeGreaterThan(0);

    const res = releasePlayer(state, { playerId: target.id });
    expect(res.ok, res.message).toBe(true);
    expect(activeContract(state, target.id)?.teamId).not.toBe(state.userTeamId);
    expect(weeklyWagesOf(state, state.userTeamId)).toBeLessThan(wagesBefore);
  });

  it("위약금이 원장에 남는다 — PSR까지 간다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    releasePlayer(state, { playerId: target.id });
    const finance = state.finances.find((f) => f.teamId === state.userTeamId)!;
    expect(finance.ledger.some((e) => e.label.includes("계약 해지 위약금"))).toBe(true);
  });

  it("떠난 선수는 우리 스쿼드에 없다 — 무소속으로 남기지 않는다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    releasePlayer(state, { playerId: target.id });
    expect(playersOf(state, state.userTeamId).some((p) => p.id === target.id)).toBe(false);
    expect(state.players.find((p) => p.id === target.id)!.teamId).not.toBe(state.userTeamId);
    expect(userTactics(state).assignments.some((a) => a.playerId === target.id)).toBe(false);
  });

  it("타 팀 선수는 방출할 수 없다", () => {
    const state = createTestGame(11);
    const theirs = playersOf(state, "chelsea").find((p) => p.teamId !== state.userTeamId)!;
    expect(releasePlayer(state, { playerId: theirs.id }).ok).toBe(false);
  });
});

describe("임대 — 전력을 내주고 성장을 산다", () => {
  it("보내면 상대 팀 선수가 되고 복귀일이 남는다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    target.squadNumber = 77;
    const res = loanPlayer(state, { playerId: target.id, teamId: "chelsea" });
    expect(res.ok, res.message).toBe(true);
    const after = state.players.find((p) => p.id === target.id)!;
    expect(after.teamId).toBe("chelsea");
    expect(after.squadNumber).toBeTypeOf("number");
    expect(
      playersOf(state, "chelsea").filter((p) => p.squadNumber === after.squadNumber),
    ).toHaveLength(1);
    expect(after.loan!.fromTeamId).toBe(state.userTeamId);
    expect(after.loan!.wageShare).toBe(DEFAULT_LOAN_WAGE_SHARE);
    expect(loanedOut(state).some((p) => p.id === target.id)).toBe(true);
    expect(state.transfers.some((t) => t.gamePlayerId === target.id && t.type === "loan")).toBe(
      true,
    );
  });

  it("주급을 나눠 낸다 — 계약은 우리 것으로 남는다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    const wage = activeContract(state, target.id)!.weeklyWage;
    const before = weeklyWagesOf(state, state.userTeamId);
    loanPlayer(state, { playerId: target.id, teamId: "chelsea", wageShare: 0.5 });
    expect(activeContract(state, target.id)!.teamId).toBe(state.userTeamId);
    expect(weeklyWagesOf(state, state.userTeamId)).toBeCloseTo(before - wage * 0.5, 0);
  });

  it("계약보다 길게 보낼 수 없다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    const res = loanPlayer(state, {
      playerId: target.id,
      teamId: "chelsea",
      until: "2099-06-30",
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("계약이");
  });

  it("불러들이면 2군으로 돌아온다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    loanPlayer(state, { playerId: target.id, teamId: "chelsea" });
    target.squadNumber = 88;
    const res = recallLoan(state, { playerId: target.id });
    expect(res.ok, res.message).toBe(true);
    const after = state.players.find((p) => p.id === target.id)!;
    expect(after.teamId).toBe(state.userTeamId);
    expect(after.squadNumber).toBeTypeOf("number");
    expect(
      playersOf(state, state.userTeamId).filter((p) => p.squadNumber === after.squadNumber),
    ).toHaveLength(1);
    expect(after.squadLevel).toBe("reserve");
    expect(after.loan).toBeUndefined();
  });

  it("임대 중인 선수는 방출할 수 없다 — 먼저 불러들여야 한다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    loanPlayer(state, { playerId: target.id, teamId: "chelsea" });
    expect(releasePlayer(state, { playerId: target.id }).message).toContain("임대 중");
  });
});

describe("자리 이동 — 교체 없이 선발 안에서만", () => {
  it("뛰고 있는 선수의 자리를 바꾼다", () => {
    const state = createTestGame(11);
    const starter = userTactics(state).assignments.find((a) => a.role === "starting")!;
    const res = movePlayerSlot(state, { playerId: starter.playerId, position: "CM" });
    if (starter.position === "CM") return;
    expect(res.ok, res.message).toBe(true);
    expect(
      userTactics(state).assignments.find((a) => a.playerId === starter.playerId)!.position,
    ).toBe("CM");
  });

  it("벤치 선수는 교체로만 넣는다 — 자리 이동으로는 못 들어온다", () => {
    const state = createTestGame(11);
    const bench = userTactics(state).assignments.find((a) => a.role === "bench")!;
    const res = movePlayerSlot(state, { playerId: bench.playerId, position: "CM" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("그라운드에 없습니다");
  });
});

describe("개인 훈련 — 팀 훈련 위에 한 선수만", () => {
  it("축과 자리를 걸고 거둘 수 있다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    expect(setPlayerTraining(state, { playerId: target.id, axis: "finishing" }).ok).toBe(true);
    expect(state.playerTraining).toHaveLength(1);

    expect(setPlayerTraining(state, { playerId: target.id, position: "CB" }).ok).toBe(true);
    expect(state.playerTraining[0]!.position).toBe("CB");
    // 프로그램은 선수당 하나 — 덮어쓴다
    expect(state.playerTraining).toHaveLength(1);

    expect(setPlayerTraining(state, { playerId: target.id, clear: true }).ok).toBe(true);
    expect(state.playerTraining).toHaveLength(0);
  });

  it("없는 축·자리는 반려한다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    expect(setPlayerTraining(state, { playerId: target.id, axis: "wizardry" }).ok).toBe(false);
    expect(setPlayerTraining(state, { playerId: target.id, position: "XX" }).ok).toBe(false);
  });
});
