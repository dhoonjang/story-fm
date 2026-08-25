import { describe, expect, it } from "vitest";
import { ageOf, isReserveMatch, PLAYER_ARCHETYPE_TRAITS } from "@story-fm/domain";
import {
  leagueOfTeamIn,
  loanPlayer,
  onLoanFromUs,
  playerArchetypeOf,
  recallLoan,
  reservePlayers,
  seasonStatOf,
  setDevelopmentFocus,
  squadLevelOf,
  teamShortNameIn,
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
 * 네 팔을 나란히 놓는다 — 집중 육성 / 무지정 우리 2군 / **같은 리그로 보낸 임대** /
 * 배율 없는 타 팀 기준선. 집중 육성 격차가 0이면 육성이 게임플레이가 아니라 배경
 * 시뮬로 되돌아간 것이고, 임대 격차가 0 아래면 유망주를 내보내는 결정이 손해가 된
 * 것이다 (season.md §2 임대).
 */

/** 임대 팔의 크기 — 평균을 낼 만큼은 되되, 우리 2군 팔을 비우지 않을 만큼 */
const LOAN_ARM_SIZE = 5;

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

    /**
     * **임대 팔** — 집중 육성과 겹치지 않는 U21 몇을 같은 리그의 다른 클럽으로
     * 보낸다(수준 계수 1.0). 창은 프리시즌 첫날(7/1)에 이미 열려 있다.
     *
     * 받는 쪽은 **1군이 가장 약한 클럽부터** 훑는다 — 감독이 할 법한 선택이고, 뛸
     * 자리가 없는 곳으로 보내면 재는 것이 배율이 아니라 그 구단의 명단이 된다.
     * 1군이 차 있어 그쪽 2군으로 들어가면(`arrivingSquadLevel`) 1군 경기를 아예 못
     * 뛰므로 되불러 다음 구단을 본다.
     */
    const ourLeague = leagueOfTeamIn(state, state.userTeamId);
    const meanOverall = (squad: readonly { attributes: { overall: number } }[]) =>
      squad.reduce((sum, p) => sum + p.attributes.overall, 0) / (squad.length || 1);
    const hosts = state.teams
      .filter((t) => t.id !== state.userTeamId && leagueOfTeamIn(state, t.id) === ourLeague)
      .map((t) => ({
        id: t.id,
        strength: meanOverall(
          state.players.filter((p) => p.teamId === t.id && squadLevelOf(p) === "first"),
        ),
      }))
      .sort((a, b) => a.strength - b.strength)
      .map((t) => t.id);
    /**
     * 두 팔이 **같은 잠재력 분포**를 갖게 한 칸씩 걸러 뽑는다 — 여유가 큰 쪽부터
     * 잘라 가면 임대 팔이 무지정 팔의 위쪽을 통째로 가져가, 재는 것이 배율이 아니라
     * 표본의 잠재력 차이가 된다.
     */
    const loanCandidates = reservePlayers(state, state.userTeamId)
      .filter((p) => u21(state, p.birthdate) && !focusIds.includes(p.id))
      .sort(
        (a, b) =>
          b.attributes.potential -
          b.attributes.overall -
          (a.attributes.potential - a.attributes.overall),
      )
      .filter((_, index) => index % 2 === 0)
      .slice(0, LOAN_ARM_SIZE);
    const loanedIds: string[] = [];
    for (const player of loanCandidates) {
      const rejected: string[] = [];
      for (const teamId of hosts) {
        const sent = loanPlayer(state, { playerId: player.id, teamId });
        if (!sent.ok) {
          rejected.push(`${teamShortNameIn(state, teamId)}: ${sent.message}`);
          continue;
        }
        // 그쪽 1군에 못 들면 1군 경기를 못 뛴다 — 이 팔이 재려는 것이 아니다
        if (squadLevelOf(player) === "first") {
          loanedIds.push(player.id);
          break;
        }
        rejected.push(`${teamShortNameIn(state, teamId)}: 1군이 차 그쪽 2군으로 들어갔다`);
        recallLoan(state, { playerId: player.id });
      }
      if (!loanedIds.includes(player.id)) {
        console.log(`임대 반려 — ${player.name}: ${rejected.slice(0, 3).join(" / ")}`);
      }
    }

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
     * 임대 표본은 **시즌이 끝난 시점에도 여전히 우리 임대인 선수**만 센다 — 중도
     * 복귀·이적으로 길이 갈린 선수의 성장은 임대의 몫이 아니다.
     */
    const stillOnLoan = loanedIds.filter((id) => {
      const player = state.players.find((p) => p.id === id);
      return player !== undefined && onLoanFromUs(state, player);
    });
    const loanGrowth = growthOf(stillOnLoan);
    /** 임대처에서 실제로 뛴 경기 — 격차의 원인이 배율인지 출전인지 가른다 */
    const loanApps = stillOnLoan.map((id) => {
      const player = state.players.find((p) => p.id === id)!;
      return state.matches.filter(
        (m) =>
          !isReserveMatch(m) &&
          m.result !== null &&
          (m.homeTeamId === player.teamId || m.awayTeamId === player.teamId) &&
          [...(m.result.homeLineup ?? []), ...(m.result.awayLineup ?? [])].includes(id),
      ).length;
    });

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
      "임대 표본": stillOnLoan.length,
      "임대 U21 성장": loanGrowth,
      "임대처 평균 출전": mean(loanApps),
      "임대 격차": loanGrowth - baselineGrowth,
      "성실한 U21 표본": diligent.length,
      "게으른 U21 표본": lazy.length,
      "직업의식 격차": growthOf(diligent) - growthOf(lazy),
    };
    console.log(reportOf(YOUTH_DEVELOPMENT, readings, `시드 42 · ${state.date}`));
    expect(outOfBand(YOUTH_DEVELOPMENT, readings)).toEqual([]);
  });
});
