import { describe, expect, it } from "vitest";
import { advanceTime, startMatch, substitutePlayer, userSide, userTeam } from "@story-fm/engine";
import { createTestGame } from "./helpers";

/** 회귀 — 부상 선수는 경기 어느 경로로도 출전할 수 없다 (리뷰 발견 버그의 역전) */
describe("회귀: 부상 선수 경기 출전 차단", () => {
  it("벤치의 부상 선수는 교체 투입이 반려된다", () => {
    const state = createTestGame();
    advanceTime(state, "next_match");
    const team = userTeam(state);

    // 킥오프 전에 벤치 선수 하나를 부상 처리 — startMatch가 벤치에서 걸러낸다
    const benchCandidate = team.players.find((p) => !team.startingXI.includes(p.id));
    if (!benchCandidate) throw new Error("벤치 후보 없음");
    benchCandidate.state.injury = "minor";
    state.injuryDays[benchCandidate.id] = 7;

    const started = startMatch(state);
    expect(started.ok).toBe(true);
    const match = state.pendingMatch;
    if (!match) throw new Error("no match");
    const side = userSide(state);
    const myLedger = side === "home" ? match.ledger.home : match.ledger.away;

    // ① startMatch가 부상자를 벤치에서 제외한다
    expect(myLedger.bench).not.toContain(benchCandidate.id);

    // ② 그래도 투입을 시도하면 엔진 경계 검증이 반려한다
    const out = myLedger.onPitch.find((id) => {
      const p = team.players.find((x) => x.id === id);
      return p?.positionGroup !== "GK";
    });
    if (!out) throw new Error("교체 아웃 대상 없음");
    const result = substitutePlayer(state, { out, in: benchCandidate.id });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("부상");
  });

  it("경기 사이 선발 멤버가 부상당하면 startMatch가 건강한 선수로 자동 대체한다", () => {
    const state = createTestGame();
    advanceTime(state, "next_match");
    const team = userTeam(state);

    const starterId = team.startingXI[0];
    if (!starterId) throw new Error("선발 없음");
    const starter = team.players.find((p) => p.id === starterId);
    if (!starter) throw new Error("선수 없음");
    starter.state.injury = "minor";
    state.injuryDays[starterId] = 7;

    const started = startMatch(state);
    expect(started.ok).toBe(true);
    const side = userSide(state);
    const ledger =
      side === "home" ? state.pendingMatch?.ledger.home : state.pendingMatch?.ledger.away;
    // 부상자는 그라운드에 없고, 선발은 여전히 11명이다
    expect(ledger?.onPitch).not.toContain(starterId);
    expect(ledger?.onPitch).toHaveLength(11);
  });
});
