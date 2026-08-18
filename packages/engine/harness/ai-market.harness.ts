import { describe, expect, it } from "vitest";
import { isTopFlight } from "@story-fm/engine";
import { createTestGame } from "../test/helpers";
import { AI_MARKET } from "./catalog";
import { playSeason } from "./season";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * 한 시즌의 **시장 규모** — 시장이 도는지는 `packages/engine/test/ai-market.test.ts`가
 * 보고, 여기서는 그 양이 실제 시장과 같은 자릿수인지를 본다.
 *
 *   pnpm balance ai-market
 */

/** 여름 창이 닫히는 날 — 겨울과 가르는 경계 */
const WINDOW_CLOSE = "2026-09-05";

describe("한 시즌의 시장 규모", () => {
  it("시드 7", () => {
    const state = createTestGame(7);
    playSeason(state);

    const clubs = state.teams.filter((t) => isTopFlight(t.id)).length;
    const moves = state.transfers.filter(
      (t) => t.fromTeamId !== state.userTeamId && t.toTeamId !== state.userTeamId,
    );
    const readings: Readings<typeof AI_MARKET> = {
      "총 이동": moves.length,
      "1부 팀당 이적": moves.filter((t) => t.type === "transfer").length / clubs,
      "1부 팀당 임대": moves.filter((t) => t.type === "loan").length / clubs,
      "여름 비중": moves.filter((t) => t.date < WINDOW_CLOSE).length / Math.max(1, moves.length),
    };
    console.log(reportOf(AI_MARKET, readings, `시드 7 · 1부 ${clubs}개 구단`));
    expect(outOfBand(AI_MARKET, readings)).toEqual([]);
  });
});
