import { describe, expect, it } from "vitest";
import { isClubTeam, isTopFlight, type GameState } from "@story-fm/engine";
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
 * **재직 감독에게 오는 접근**(career.md §5.1)은 같은 세계를 **두 번째 시즌**으로 잰다.
 * 한 번으로 끝내지 못하는 이유가 둘이다:
 *
 *   - 첫 시즌의 감독은 tier 1(아스날)이라 부를 수 있는 구단이 tier 1뿐이고 문턱이
 *     80이다 — 위가 없는 자리에서 재면 언제나 0이고, 그건 확률을 잰 것이 아니라
 *     올라갈 곳이 없었다는 말이다.
 *   - 이 하네스의 감독은 회견에 답하지 않아 한 시즌이면 평판이 0으로 내려앉는다.
 *
 * 그래서 두 번째 시즌은 **tier 3 구단의 감독을 평판 고정으로 세워** 「좋은 시즌을
 * 보낸 감독에게 한 시즌에 몇 번 오는가」를 잰다. 재려는 것은 `POACH_CHANCE`와 등급
 * 문이지 이 감독의 평판이 아니다.
 *
 *   pnpm balance manager-market
 */

/**
 * 접근을 재는 시즌의 감독이 서 있는 평판 — **두터움 구간**(`REPUTATION_TIERS`의
 * `firm` 60) 바로 위다. tier 3 감독에게 이 값이면 tier 2·3의 접근 문턱(65·50)이
 * 열리고 tier 1(80)은 닫혀 있다.
 */
const PROBE_REPUTATION = 65;

/** 접근을 재는 시즌의 감독 — 위가 열려 있는 자리여야 문이 있다 (tier 3) */
const PROBE_TEAM = "brentford";

function measure(state: GameState): Readings<typeof MANAGER_MARKET> {
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

  return {
    "경질 구단 수": changed.length,
    "경질 구단 비중": changed.length / Math.max(1, clubs.length),
    "풀 인원": (state.managerPool ?? []).length,
    "풀에서 다시 선 감독 수": fromPool.length,
    "풀 재선임 비중": fromPool.length / Math.max(1, moved.length),
    "재직 감독에게 온 접근": (state.managerOffers ?? []).filter((o) => o.via === "poach").length,
    "시즌말 감독 평판": (state.manager.reputation.board + state.manager.reputation.media) / 2,
  };
}

/** 그 세계에서 바뀐 벤치 수 — 표 옆에 붙는 한 줄이 읽히려면 이 수가 있어야 한다 */
function movedCount(state: GameState): number {
  return state.teams.filter(
    (t) =>
      isClubTeam(t.id) &&
      t.id !== state.userTeamId &&
      t.managerSince !== state.calendar.preseasonStart,
  ).length;
}

describe("한 시즌의 감독 경질 규모", () => {
  it("시드 7", () => {
    const state = createTestGame(7);
    playSeason(state);
    const readings = measure(state);
    console.log(
      reportOf(
        MANAGER_MARKET,
        readings,
        `시드 7 · 1부 96개 구단 · 세계 벤치 중 ${movedCount(state)}곳이 바뀌었다`,
      ),
    );
    expect(outOfBand(MANAGER_MARKET, readings)).toEqual([]);
  });

  it(`시드 7 · ${PROBE_TEAM} · 평판 ${PROBE_REPUTATION} 고정`, () => {
    const state = createTestGame(7, PROBE_TEAM);
    /**
     * 매일 되돌려 놓는다 — 회견에 답하지 않는 감독의 평판은 시즌 내내 내려가고,
     * 그러면 접근의 문턱이 한 번도 열리지 않아 재는 값이 언제나 0이 된다.
     */
    const pin = (s: GameState) => {
      s.manager.reputation.board = PROBE_REPUTATION;
      s.manager.reputation.media = PROBE_REPUTATION;
    };
    pin(state);
    playSeason(state, undefined, pin);
    const readings = measure(state);
    console.log(
      reportOf(
        MANAGER_MARKET,
        readings,
        `시드 7 · ${PROBE_TEAM}(tier 3) 감독 · 평판 ${PROBE_REPUTATION} 고정 · 세계 벤치 중 ${movedCount(state)}곳이 바뀌었다`,
      ),
    );
    expect(outOfBand(MANAGER_MARKET, readings)).toEqual([]);
  });
});
