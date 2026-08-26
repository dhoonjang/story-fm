import { describe, expect, it } from "vitest";
import { ageOf } from "@story-fm/domain";
import {
  activeContract,
  assignmentsOf,
  declareRetirements,
  groupOf,
  isClubTeam,
  playersOf,
  transitionSeason,
} from "@story-fm/engine";
import { createTestGame } from "../test/helpers";
import { SQUAD_LONGEVITY } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * 전환을 열다섯 번 되풀이한 뒤에도 **구단이 선발 XI와 계약을 세우는가**
 * (→ `docs/simulation/season.md` §6).
 *
 *   pnpm balance squad-longevity
 *
 * 은퇴가 유스 콜업·영입보다 빠르면 어느 시즌엔가 열한 명을 못 세우는 구단이 생기는데,
 * 그 어긋남은 한 번의 전환을 보는 단위 테스트로는 보이지 않는다.
 */

/** 은퇴와 콜업의 불균형이 쌓여 드러나는 가장 짧은 창 */
const SEASONS = 15;

describe("15시즌을 전환한 뒤의 스쿼드", () => {
  it("시드 42", () => {
    const state = createTestGame(42);
    /**
     * **예고를 함께 굴린다** — 전환은 집행일 뿐이고 명단은 1월의 예고가 정한다
     * (season.md §6). 여기서 tick을 돌리지 않으므로 그 하루를 직접 부른다: 빼면
     * 나이(35) 밖의 은퇴가 통째로 사라져 실제 게임보다 늙고 두꺼운 스쿼드를 잰다.
     */
    for (let s = 0; s < SEASONS; s++) {
      declareRetirements(state, []);
      transitionSeason(state);
    }

    const clubs = state.teams.filter((t) => isClubTeam(t.id));
    let shortXI = 0;
    let noKeeper = 0;
    let ghostAssignments = 0;
    let contractless = 0;
    const sizes: number[] = [];
    const keepers: number[] = [];
    const ages: number[] = [];

    for (const team of clubs) {
      const roster = playersOf(state, team.id);
      const owned = new Set(roster.map((p) => p.id));
      if (assignmentsOf(state, team.id, "starting").length !== 11) shortXI += 1;
      const gk = roster.filter((p) => groupOf(p) === "GK").length;
      if (gk === 0) noKeeper += 1;
      for (const a of assignmentsOf(state, team.id)) {
        if (!owned.has(a.playerId)) ghostAssignments += 1;
      }
      for (const p of roster) {
        if (activeContract(state, p.id) === null) contractless += 1;
        ages.push(ageOf(p.birthdate, state.date));
      }
      sizes.push(roster.length);
      keepers.push(gk);
    }

    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
    const readings: Readings<typeof SQUAD_LONGEVITY> = {
      "클럽 수": clubs.length,
      "선발 XI가 11이 아닌 구단": shortXI,
      "GK 없는 구단": noKeeper,
      "보유하지 않은 선수를 가리키는 배치": ghostAssignments,
      "활성 계약 없는 선수": contractless,
      "구단당 평균 스쿼드 인원": mean(sizes),
      "가장 얕은 스쿼드 인원": Math.min(...sizes),
      "가장 얕은 GK 보유": Math.min(...keepers),
      "스쿼드 평균 나이": mean(ages),
    };
    console.log(reportOf(SQUAD_LONGEVITY, readings, `시드 42 · ${SEASONS}시즌 · ${state.date}`));
    expect(outOfBand(SQUAD_LONGEVITY, readings)).toEqual([]);
  });
});
