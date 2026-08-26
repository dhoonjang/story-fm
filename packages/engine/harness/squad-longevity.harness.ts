import { describe, expect, it } from "vitest";
import { ageOf } from "@story-fm/domain";
import {
  activeContract,
  addDays,
  applyMonthlyDevelopment,
  assignmentsOf,
  declareRetirements,
  firstTeamPlayers,
  groupOf,
  isClubTeam,
  leagueOfTeamIn,
  playersOf,
  transitionSeason,
} from "@story-fm/engine";
import type { GameState } from "@story-fm/engine";
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
/** 리그의 체급을 읽는 표본 — 1군 상위 몇 명의 종합 평균을 볼 것인가 */
const TOP_N = 15;

/**
 * 우리 리그 각 구단 1군 상위 `TOP_N`의 종합 평균과 그 선수들의 잠재력 평균 —
 * **리그의 체급과 그 천장, 두 줄.** 스쿼드 평균은 인원 수가 흔들면 같이 흔들리므로
 * 실제로 뛰는 층만 본다. 둘을 함께 재는 이유는 드리프트의 원인이 갈리기 때문이다:
 * 종합만 내려가면 성장이 천장에 못 닿는 것이고, 잠재력이 함께 내려가면 여름마다
 * 세계가 리그에 건네는 사람이 얇아진 것이다 (season.md §6).
 */
function leagueTopMean(state: GameState): { overall: number; potential: number } {
  const league = leagueOfTeamIn(state, state.userTeamId);
  const overall: number[] = [];
  const potential: number[] = [];
  for (const team of state.teams.filter((t) => isClubTeam(t.id))) {
    if (leagueOfTeamIn(state, team.id) !== league) continue;
    const top = firstTeamPlayers(state, team.id)
      .sort((a, b) => b.attributes.overall - a.attributes.overall)
      .slice(0, TOP_N);
    for (const p of top) {
      overall.push(p.attributes.overall);
      potential.push(p.attributes.potential);
    }
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  return { overall: mean(overall), potential: mean(potential) };
}

describe("15시즌을 전환한 뒤의 스쿼드", () => {
  it("시드 42", () => {
    const state = createTestGame(42);
    const before = leagueTopMean(state);
    for (let s = 0; s < SEASONS; s++) {
      /**
       * **자라고 늙는 열두 달을 함께 굴린다** — 전환만 되풀이하면 능력치가 한 칸도
       * 움직이지 않는 세계를 재게 된다. 코어 월간 성장(`applyMonthlyDevelopment`)이
       * 리그의 95%가 지나는 경로이고, 아래 드리프트는 그 경로가 노화 곡선과
       * 균형을 이루는지를 묻는 자리다 (player.md §6.3).
       */
      for (let m = 0; m < 12; m++) {
        state.date = addDays(state.date, 30);
        applyMonthlyDevelopment(state);
      }
      /**
       * **예고를 함께 굴린다** — 전환은 집행일 뿐이고 명단은 1월의 예고가 정한다
       * (season.md §6). 여기서 tick을 돌리지 않으므로 그 하루를 직접 부른다: 빼면
       * 나이(35) 밖의 은퇴가 통째로 사라져 실제 게임보다 늙고 두꺼운 스쿼드를 잰다.
       */
      declareRetirements(state, []);
      transitionSeason(state);
    }
    const after = leagueTopMean(state);

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
      "리그 1군 상위 15 종합 — 시작": before.overall,
      "리그 1군 상위 15 종합 — 15시즌 뒤": after.overall,
      "시즌당 종합 드리프트": (after.overall - before.overall) / SEASONS,
      "리그 1군 상위 15 잠재력 — 시작": before.potential,
      "리그 1군 상위 15 잠재력 — 15시즌 뒤": after.potential,
      "시즌당 잠재력 드리프트": (after.potential - before.potential) / SEASONS,
    };
    console.log(reportOf(SQUAD_LONGEVITY, readings, `시드 42 · ${SEASONS}시즌 · ${state.date}`));
    expect(outOfBand(SQUAD_LONGEVITY, readings)).toEqual([]);
  });
});
