import { describe, expect, it } from "vitest";
import { ageOf, isReserveMatch, PLAYER_ARCHETYPE_TRAITS } from "@story-fm/domain";
import {
  playerArchetypeOf,
  reservePlayers,
  seasonStatOf,
  setDevelopmentFocus,
  squadLevelOf,
  type GameState,
} from "@story-fm/engine";
import { createTestGame } from "../test/helpers";
import { playSeason } from "./season";
import { YOUTH_DEVELOPMENT } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * 유스 육성 — **2군 리그가 돌고, 감독의 선택이 유망주의 성장 속도를 가르는가**
 * (→ `docs/simulation/season.md` §2 2군 리그).
 *
 *   pnpm balance youth-development
 *
 * 집중 육성 + 출전을 다 받은 유망주와 배율 없는 타 팀 유망주의 시즌 성장을 나란히
 * 놓는다. 격차가 0이면 육성이 게임플레이가 아니라 배경 시뮬로 되돌아간 것이다.
 */

describe("한 시즌의 유스 육성", () => {
  it("시드 42", () => {
    const state = createTestGame(42);
    const u21 = (s: GameState, birthdate: string) => ageOf(birthdate, s.date) <= 21;

    // 잠재력 여유가 가장 큰 U21 셋에 집중 육성을 건다 — 감독이 할 법한 선택
    const focusIds = reservePlayers(state, state.userTeamId)
      .filter((p) => u21(state, p.birthdate))
      .sort(
        (a, b) =>
          b.attributes.potential -
          b.attributes.overall -
          (a.attributes.potential - a.attributes.overall),
      )
      .slice(0, 3)
      .map((p) => p.id);
    const set = setDevelopmentFocus(state, { playerIds: focusIds });
    expect(set.ok).toBe(true);

    const before = new Map(state.players.map((p) => [p.id, p.attributes.overall]));
    const ourReserveU21 = state.players
      .filter(
        (p) =>
          p.teamId === state.userTeamId &&
          squadLevelOf(p) === "reserve" &&
          u21(state, p.birthdate) &&
          !focusIds.includes(p.id),
      )
      .map((p) => p.id);
    const baselineU21 = state.players
      .filter(
        (p) =>
          p.teamId !== state.userTeamId && squadLevelOf(p) === "reserve" && u21(state, p.birthdate),
      )
      .map((p) => p.id);

    playSeason(state);

    const reserveMatches = state.matches.filter(isReserveMatch);
    const unplayed = reserveMatches.filter((m) => m.result === null).length;
    const reserveApps = reservePlayers(state, state.userTeamId).map(
      (p) => seasonStatOf(state, p.id)?.reserveApps ?? 0,
    );
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
    // 시즌 중 이적·은퇴로 떠난 선수는 표본에서 빠진다 — 성장을 잰 창이 다르다
    const growthOf = (ids: string[]) =>
      mean(
        ids
          .map((id) => {
            const player = state.players.find((p) => p.id === id);
            return player === undefined ? null : player.attributes.overall - before.get(id)!;
          })
          .filter((d): d is number => d !== null),
      );

    const focusGrowth = growthOf(focusIds);
    const baselineGrowth = growthOf(baselineU21);

    /**
     * **직업의식이 세계 규모에서 실제로 갈리는가** (people.md §6).
     *
     * 집중 육성 표본은 셋뿐이라 원형 추첨의 잡음이 계수를 덮는다 — 배율 없는 타 팀
     * 2군 U21 전체를 성실/게으름으로 갈라야 계수의 몫만 남는다.
     */
    const professionalismOf = (id: string) => {
      const player = state.players.find((p) => p.id === id);
      return player === undefined
        ? null
        : PLAYER_ARCHETYPE_TRAITS[playerArchetypeOf(state.seed, player)].professionalism;
    };
    const DILIGENT_AT = 1.1;
    const LAZY_AT = 0.95;
    const diligent = baselineU21.filter((id) => (professionalismOf(id) ?? 0) >= DILIGENT_AT);
    const lazy = baselineU21.filter((id) => (professionalismOf(id) ?? 1) <= LAZY_AT);
    const readings: Readings<typeof YOUTH_DEVELOPMENT> = {
      "2군 경기 수": reserveMatches.length,
      "결과 없는 2군 경기": unplayed,
      "2군 평균 출전": mean(reserveApps),
      "집중 육성 시즌 성장": focusGrowth,
      "무지정 우리 2군 U21 성장": growthOf(ourReserveU21),
      "타 팀 2군 U21 성장": baselineGrowth,
      "집중 육성 격차": focusGrowth - baselineGrowth,
      "성실한 U21 표본": diligent.length,
      "게으른 U21 표본": lazy.length,
      "직업의식 격차": growthOf(diligent) - growthOf(lazy),
    };
    console.log(reportOf(YOUTH_DEVELOPMENT, readings, `시드 42 · ${state.date}`));
    expect(outOfBand(YOUTH_DEVELOPMENT, readings)).toEqual([]);
  });
});
