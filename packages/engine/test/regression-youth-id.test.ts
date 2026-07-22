import { describe, expect, it } from "vitest";
import { transitionSeason, userTeam } from "@story-fm/engine";
import { createTestGame } from "./helpers";

/**
 * 회귀 — 유스 ID에 시즌이 명시되어(-y{season}-{i}) 대량 은퇴 시즌 뒤에도
 * ID가 충돌하지 않는다. (리뷰 발견: season*10+i 공식은 은퇴 11명+ 시 충돌)
 */
describe("회귀: 유스 ID 시즌 간 유일성", () => {
  it("한 시즌 은퇴자 11명이어도 전 시즌에 걸쳐 ID가 유일하다", () => {
    const state = createTestGame(7);
    const team = userTeam(state);

    for (let i = 0; i < 11; i++) {
      const p = team.players[i];
      if (!p) throw new Error("no player");
      p.age = 34; // 전환 시 +1 → 35 → 동시 은퇴
    }

    transitionSeason(state);
    transitionSeason(state);

    for (const t of state.teams) {
      const ids = t.players.map((p) => p.id);
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      expect(dupes).toHaveLength(0);
    }
  });
});
