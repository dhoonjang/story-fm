import { describe, expect, it } from "vitest";
import { isClubTeam, isTopFlight } from "@story-fm/engine";
import { createTestGame } from "../test/helpers";
import { MANAGER_MARKET } from "./catalog";
import { playSeason } from "./season";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * 한 시즌에 벤치의 사람이 몇 번 바뀌고, **그중 몇이 아는 얼굴인가** — 규칙이 맞는지는
 * `packages/engine/test/manager-market.test.ts`가 보고, 여기서는 `SACK_CHANCE`와
 * 문턱이 만든 **빈도**, 그리고 `POOL_HIRE_CHANCE`와 `POOL_RATING_BAND`가 만든
 * **재선임 비중**을 잰다 (transfer.md §7 「감독 풀」).
 *
 * 경질 규모는 1부만 세고 풀은 세계 전체로 센다 — 감독 시장은 5대 리그 전체를 돌고,
 * 잘린 사람은 리그를 건너 부임한다.
 *
 *   pnpm balance manager-market
 */
describe("한 시즌의 감독 경질 규모", () => {
  it("시드 7", () => {
    const state = createTestGame(7);
    playSeason(state);

    const clubs = state.teams.filter((t) => isTopFlight(t.id));
    const changed = clubs.filter((t) => t.managerSince !== state.calendar.preseasonStart);
    /**
     * 세계 전체의 벤치 — **지금 앉아 있는 사람이 풀에서 왔는가**는 지난 재임이
     * 있는지로 답한다. 한 시즌에 두 번 갈린 벤치는 마지막 사람만 세므로 이 비중은
     * 실제 재선임보다 낮게 잡히는 쪽이다.
     */
    const world = state.teams.filter((t) => isClubTeam(t.id) && t.id !== state.userTeamId);
    const moved = world.filter((t) => t.managerSince !== state.calendar.preseasonStart);
    const fromPool = moved.filter((t) => (t.managerSpells ?? []).length > 0);

    const readings: Readings<typeof MANAGER_MARKET> = {
      "경질 구단 수": changed.length,
      "경질 구단 비중": changed.length / Math.max(1, clubs.length),
      "풀 인원": (state.managerPool ?? []).length,
      "풀에서 다시 선 감독 수": fromPool.length,
      "풀 재선임 비중": fromPool.length / Math.max(1, moved.length),
    };
    console.log(
      reportOf(
        MANAGER_MARKET,
        readings,
        `시드 7 · 1부 ${clubs.length}개 구단 · 세계 ${world.length}개 벤치 중 ${moved.length}곳이 바뀌었다`,
      ),
    );
    expect(outOfBand(MANAGER_MARKET, readings)).toEqual([]);
  });
});
