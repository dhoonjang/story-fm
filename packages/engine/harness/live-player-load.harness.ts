import { describe, expect, it } from "vitest";
import { weightSlotOf, type WeightSlot } from "@story-fm/domain";
import { EXPECTED_LOAD } from "@story-fm/sim";
import { createTestGame } from "../test/helpers";
import { LIVE_PLAYER_LOAD } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";
import { leagueFixtures, liveMatchWith, mean, playToEnd } from "./live-runs";

/**
 * **말이 포지션대로 뛰는가** — 풀타임을 뛴 선수의 총 거리·고속·스프린트를 포지션 묶음별로
 * 모아 실측(football-reference.md §7-B)과 기대 부하표(`EXPECTED_LOAD`)에 맞댄다.
 *
 * 기대 부하표는 간이 시뮬과 경기 뒤 체력 정산이 읽는 값이라, 실시간 경기가 실제로 뛴
 * 것과 갈리면 감독의 선수와 남의 선수가 다른 몸으로 시즌을 난다.
 *
 *   pnpm balance live-player-load
 */

const SEEDS = [42, 7];
const MATCHES_PER_SEED = 8;

type Group = "CB" | "FB" | "CM" | "W" | "ST";
const GROUP_OF: Partial<Record<WeightSlot, Group>> = {
  CB: "CB",
  FB: "FB",
  DM: "CM",
  CM: "CM",
  AM: "CM",
  W: "W",
  CF: "ST",
  ST: "ST",
};

interface Load {
  distance: number;
  highSpeed: number;
  sprint: number;
}

describe("포지션별 부하", () => {
  it("풀타임 선수의 거리·고속·스프린트가 포지션의 실측에 선다", () => {
    const loads: Record<Group | "GK", Load[]> = { GK: [], CB: [], FB: [], CM: [], W: [], ST: [] };
    const expected: Record<Group | "GK", number[]> = {
      GK: [],
      CB: [],
      FB: [],
      CM: [],
      W: [],
      ST: [],
    };
    for (const seed of SEEDS) {
      const state = createTestGame(seed);
      for (const fixture of leagueFixtures(state, MATCHES_PER_SEED)) {
        const live = liveMatchWith(state, fixture);
        const starters = new Set([...live.ledger.home.onPitch, ...live.ledger.away.onPitch]);
        playToEnd(live);
        const left = new Set(
          live.ledger.events
            .filter(
              (e) => e.type === "substitution" || e.type === "red_card" || e.type === "injury",
            )
            .map((e) => e.actors[0] ?? ""),
        );
        for (const id of starters) {
          if (left.has(id)) continue;
          const slot = weightSlotOf(live.positionsPlayed[id] ?? "");
          const group = slot === "GK" ? "GK" : GROUP_OF[slot];
          const line = live.ledger.stats[id];
          if (!group || !line) continue;
          loads[group].push({
            distance: line.distance,
            highSpeed: line.highSpeed,
            sprint: line.sprint,
          });
          expected[group].push(EXPECTED_LOAD[slot].distance);
        }
      }
    }
    const km = (g: Group | "GK") => mean(loads[g].map((l) => l.distance)) / 1000;
    const hsr = (g: Group) => mean(loads[g].map((l) => l.highSpeed));
    const spr = (g: Group) => mean(loads[g].map((l) => l.sprint));
    const all = (Object.keys(loads) as Array<Group | "GK">).flatMap((g) =>
      loads[g].map((l) => l.distance),
    );
    const allExpected = (Object.keys(expected) as Array<Group | "GK">).flatMap((g) => expected[g]);

    const readings: Readings<typeof LIVE_PLAYER_LOAD> = {
      "풀타임 표본": all.length,
      "골키퍼 거리 (km)": km("GK"),
      "센터백 거리 (km)": km("CB"),
      "풀백 거리 (km)": km("FB"),
      "중앙 미드 거리 (km)": km("CM"),
      "측면 거리 (km)": km("W"),
      "공격수 거리 (km)": km("ST"),
      "센터백 고속 (m)": hsr("CB"),
      "풀백 고속 (m)": hsr("FB"),
      "중앙 미드 고속 (m)": hsr("CM"),
      "측면 고속 (m)": hsr("W"),
      "공격수 고속 (m)": hsr("ST"),
      "센터백 스프린트 (m)": spr("CB"),
      "측면 스프린트 (m)": spr("W"),
      "실측/기대 부하표 — 거리": mean(all) / Math.max(1, mean(allExpected)),
    };
    console.log(
      reportOf(
        LIVE_PLAYER_LOAD,
        readings,
        `시드 ${SEEDS.join("·")} × 리그 ${MATCHES_PER_SEED}경기 · 풀타임 선수만`,
      ),
    );
    expect(outOfBand(LIVE_PLAYER_LOAD, readings)).toEqual([]);
  });
});
