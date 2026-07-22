import { describe, expect, it } from "vitest";
import { setLineup, transitionSeason, userTeam } from "@story-fm/engine";
import { createTestGame } from "./helpers";

/**
 * 회귀 — 시즌 전환 시 GK 최소 2명이 유스로 보충되어, 아무리 시즌이
 * 지나도 GK가 소멸하지 않는다. (리뷰 발견: 유스에 GK가 없어 ~17시즌 후
 * 라인업 확정 불능 소프트락)
 */
describe("회귀: GK 소멸 방지", () => {
  it("17시즌을 전환해도 모든 팀에 GK가 있고 선발은 11명이다", () => {
    const state = createTestGame(42);

    // 초기 GK 최대 나이 33 → 17시즌이면 초기 선수 전원 은퇴하는 최악 케이스
    for (let s = 0; s < 17; s++) {
      transitionSeason(state);
    }

    for (const team of state.teams) {
      const gks = team.players.filter((p) => p.positionGroup === "GK");
      expect(gks.length).toBeGreaterThanOrEqual(1);
      expect(team.startingXI).toHaveLength(11);
    }

    // 유저 팀은 라인업 확정도 가능해야 한다 — 현재 선발 그대로 재확정
    const team = userTeam(state);
    const res = setLineup(state, { startingXI: [...team.startingXI] });
    expect(res.ok).toBe(true);
  });
});
