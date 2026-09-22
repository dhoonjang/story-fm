import { describe, expect, it } from "vitest";
import {
  buildStrengthPacket,
  createSpatialMatch,
  stepSpatialMatch,
  type SpatialInput,
} from "@story-fm/sim";
import { makeSide } from "../../sim/test/helpers";
import { SPATIAL_MATCH } from "./catalog";
import { outOfBand, reportOf } from "./harness";

describe("공간 경기", () => {
  it("움직임에서 생기는 공격을 측정한다", () => {
    const home = makeSide("spatial-home", 70),
      away = makeSide("spatial-away", 70);
    const packet = buildStrengthPacket(home, away);
    let goals = 0,
      shots = 0,
      passes = 0,
      invalid = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const input: SpatialInput = {
        seed,
        matchId: "balance",
        packet,
        players: new Map([...home.starters, ...away.starters].map((s) => [s.player.id, s.player])),
        tactics: { home: home.tactics, away: away.tactics },
        behaviors: [],
        yellows: {},
      };
      let state = createSpatialMatch(input);
      while (state.seconds < 5400) {
        const step = stepSpatialMatch(state, input);
        state = step.state;
        goals += step.events.filter((e) => e.type === "goal").length;
        shots += step.events.filter((e) => e.type === "shot" || e.type === "goal").length;
        passes += Object.values(step.stats).reduce((sum, line) => sum + line.passes, 0);
        invalid += state.players.filter(
          (p) =>
            !Number.isFinite(p.x) ||
            !Number.isFinite(p.y) ||
            p.x < 0 ||
            p.x > 105 ||
            p.y < 0 ||
            p.y > 68,
        ).length;
      }
    }
    const readings = {
      "경기당 골": goals / 4,
      "경기당 슛": shots / 4,
      "경기당 패스": passes / 4,
      "범위 이탈": invalid,
    };
    console.log(reportOf(SPATIAL_MATCH, readings, "4경기"));
    expect(outOfBand(SPATIAL_MATCH, readings)).toEqual([]);
  });
});
