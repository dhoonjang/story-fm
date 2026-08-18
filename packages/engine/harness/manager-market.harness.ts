import { describe, expect, it } from "vitest";
import { isTopFlight } from "@story-fm/engine";
import { createTestGame } from "../test/helpers";
import { MANAGER_MARKET } from "./catalog";
import { playSeason } from "./season";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * 한 시즌에 벤치의 사람이 몇 번 바뀌는가 — 규칙이 맞는지는
 * `packages/engine/test/manager-market.test.ts`가 보고, 여기서는 `SACK_CHANCE`와
 * 문턱이 만든 **빈도**를 잰다.
 *
 *   pnpm balance manager-market
 */
describe("한 시즌의 감독 경질 규모", () => {
  it("시드 7", () => {
    const state = createTestGame(7);
    playSeason(state);

    const clubs = state.teams.filter((t) => isTopFlight(t.id));
    const changed = clubs.filter((t) => t.managerSince !== state.calendar.preseasonStart);
    const readings: Readings<typeof MANAGER_MARKET> = {
      "경질 구단 수": changed.length,
      "경질 구단 비중": changed.length / Math.max(1, clubs.length),
    };
    console.log(reportOf(MANAGER_MARKET, readings, `시드 7 · 1부 ${clubs.length}개 구단`));
    expect(outOfBand(MANAGER_MARKET, readings)).toEqual([]);
  });
});
