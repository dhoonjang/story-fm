import { describe, expect, it } from "vitest";
import { ageOf, AXIS_GROUPS, isReserveMatch, PLAYER_ARCHETYPE_TRAITS } from "@story-fm/domain";
import type { GamePlayer } from "@story-fm/domain";
import {
  academyUseOf,
  LOAN_BENCH_RUN_ALERT,
  MENTEES_PER_MENTOR,
  leagueOfTeamIn,
  loanPlayer,
  mentorBlock,
  mentorPairOf,
  onLoanFromUs,
  playerArchetypeOf,
  reservePlayers,
  seasonStatOf,
  setDevelopmentFocus,
  setMentor,
  squadLevelOf,
  teamShortNameIn,
  transitionSeason,
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
 * 다섯 팔을 나란히 놓는다 — 집중 육성 / **멘토링** / 무지정 우리 2군 /
 * **같은 리그로 보낸 임대** / 배율 없는 타 팀 기준선. 집중 육성 격차가 0이면 육성이
 * 게임플레이가 아니라 배경 시뮬로 되돌아간 것이고, 임대 격차가 0 아래면 유망주를
 * 내보내는 결정이 손해가 된 것이다 (season.md §2 임대).
 *
 * ⚠️ **멘토링 팔은 종합이 아니라 정신 6축 합으로 읽는다** — 멘토 항이 닿는 자리가
 * 그 여섯뿐이라(people.md §5-3) 종합으로 읽으면 자리별 가중치가 그 몫을 반으로 접는다.
 * 그래도 표본이 셋이라 격차 자체는 눈금 아래이고, 항이 세계에 닿았는가는 성장 로그의
 * `origin`이 결정적으로 답한다.
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
     * 받는 쪽은 **1군이 가장 약한 클럽부터, 한 구단에 한 명씩** 훑는다. 창
     * (`LOAN_ROTATION_OVR_DROP`)이 약체일수록 넓으므로 이 순서가 곧 "뛸 수 있는
     * 곳부터"이고, 한 명씩인 것은 감독이 할 법한 선택이기도 하다 — 다섯을 한 구단에
     * 몰면 재는 것이 임대의 문이 아니라 그 구단 명단의 혼잡이 된다.
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
    let nextHost = 0;
    for (const player of loanCandidates) {
      const rejected: string[] = [];
      while (nextHost < hosts.length) {
        const teamId = hosts[nextHost]!;
        nextHost += 1;
        const sent = loanPlayer(state, { playerId: player.id, teamId });
        if (sent.ok) {
          loanedIds.push(player.id);
          break;
        }
        rejected.push(`${teamShortNameIn(state, teamId)}: ${sent.message}`);
      }
      if (!loanedIds.includes(player.id)) {
        console.log(`임대 반려 — ${player.name}: ${rejected.slice(0, 3).join(" / ")}`);
      }
    }

    /**
     * **멘토링 팔** — 우리 1군에서 자격을 통과하는 고참 중 리더십 최상위 하나에게,
     * 남은 2군 U21을 `MENTEES_PER_MENTOR`까지 맡긴다 (people.md §5-3).
     *
     * 무지정 팔과 **같은 잠재력 분포**를 갖게 여유 순으로 세운 뒤 홀수 자리를 뽑는다 —
     * 임대 팔이 짝수 자리를 걸러 뽑는 것과 같은 이유다.
     */
    const mentor = state.players
      .filter((p) => p.teamId === state.userTeamId && mentorBlock(state, p) === null)
      .sort((a, b) => b.attributes.leadership - a.attributes.leadership)[0];
    const restU21 = reservePlayers(state, state.userTeamId)
      .filter((p) => u21(state, p.birthdate) && !focusIds.includes(p.id))
      .sort(
        (a, b) =>
          b.attributes.potential -
          b.attributes.overall -
          (a.attributes.potential - a.attributes.overall),
      );
    const menteeIds = restU21
      .filter((_, index) => index % 2 === 1)
      .slice(0, MENTEES_PER_MENTOR)
      .map((p) => p.id);
    if (mentor && menteeIds.length > 0) {
      const assigned = setMentor(state, { mentorId: mentor.id, menteeIds });
      expect(assigned.ok).toBe(true);
      console.log(
        `멘토 ${mentor.name}(${ageOf(mentor.birthdate, state.date)}세 · 리더십 ` +
          `${mentor.attributes.leadership}) → ${menteeIds.length}명`,
      );
    } else {
      console.log("멘토 자격자가 없다 — 멘토링 팔이 비었다");
    }

    const before = new Map(state.players.map((p) => [p.id, p.attributes.overall]));
    /** 정신 6축 합 — 멘토 항이 닿는 자리가 그 여섯뿐이라 종합 대신 이 자를 쓴다 */
    const mentalSum = (p: GamePlayer) =>
      AXIS_GROUPS.mental.reduce((sum, axis) => sum + p.attributes[axis], 0);
    const mentalBefore = new Map(state.players.map((p) => [p.id, mentalSum(p)]));
    const ourReserveU21 = state.players
      .filter(
        (p) =>
          p.teamId === state.userTeamId &&
          squadLevelOf(p) === "reserve" &&
          u21(state, p.birthdate) &&
          !focusIds.includes(p.id) &&
          !menteeIds.includes(p.id),
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
     * 멘토링 표본은 **시즌이 끝난 시점에도 사이가 서 있는 선수**만 센다 — 멘토가
     * 이적·승격으로 빠져 사이가 닫힌 아이의 성장은 이 팔의 몫이 아니다.
     */
    const stillMentored = menteeIds.filter((id) => mentorPairOf(state, id) !== null);
    const mentalGrowthOf = (ids: string[]) =>
      mean(
        ids
          .map((id) => {
            const player = state.players.find((p) => p.id === id);
            return player === undefined ? null : mentalSum(player) - mentalBefore.get(id)!;
          })
          .filter((d): d is number => d !== null),
      );
    const mentoredMental = mentalGrowthOf(stillMentored);
    const plainMental = mentalGrowthOf(ourReserveU21);
    const mentoringRows = state.growthLog.filter((g) => g.origin === "mentoring").length;
    /**
     * 임대 표본은 **시즌이 끝난 시점에도 여전히 우리 임대인 선수**만 센다 — 중도
     * 복귀·이적으로 길이 갈린 선수의 성장은 임대의 몫이 아니다.
     */
    const stillOnLoan = loanedIds.filter((id) => {
      const player = state.players.find((p) => p.id === id);
      return player !== undefined && onLoanFromUs(state, player);
    });
    const loanGrowth = growthOf(stillOnLoan);
    /**
     * 임대처에서 실제로 뛴 경기와, **그 구단 경기에서 가장 길게 연속으로 명단 밖이던
     * 구간**. 앞 줄은 성장 배율에 곱할 분(分)이 있는가를 재고, 뒷줄은 리포트의
     * `no-minutes`(`LOAN_BENCH_RUN_ALERT` 4)가 배경음인지 사건인지를 가른다
     * (season.md §2 임대).
     */
    const hostMatchesOf = (teamId: string) =>
      state.matches
        .filter(
          (m) =>
            !isReserveMatch(m) &&
            m.result !== null &&
            (m.homeTeamId === teamId || m.awayTeamId === teamId),
        )
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const loanApps: number[] = [];
    const loanBenchRuns: number[] = [];
    for (const id of stillOnLoan) {
      const player = state.players.find((p) => p.id === id)!;
      let apps = 0;
      let run = 0;
      let longest = 0;
      for (const match of hostMatchesOf(player.teamId)) {
        const lineup =
          match.homeTeamId === player.teamId ? match.result?.homeLineup : match.result?.awayLineup;
        if (lineup?.includes(id)) {
          apps += 1;
          run = 0;
        } else {
          run += 1;
          longest = Math.max(longest, run);
        }
      }
      loanApps.push(apps);
      loanBenchRuns.push(longest);
      console.log(
        `임대 ${player.name}(${player.attributes.overall}) → ${teamShortNameIn(state, player.teamId)}: ` +
          `${apps}경기 · 최장 미출전 ${longest}`,
      );
    }

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
    /** 멘토 자격자 — **전환 전의 명단**으로 센다 (아래 전환이 나이와 명단을 바꾼다) */
    const mentorEligible = state.players.filter(
      (p) => p.teamId === state.userTeamId && mentorBlock(state, p) === null,
    ).length;
    /**
     * **다음 여름의 인테이크** — 이 시즌 2군에 누구를 세웠는가가 한 해 뒤 후보의
     * 수와 여지로 돌아온다 (season.md §6 유스 인테이크). 전환 한 번을 더 굴리는 것은
     * 그 되돌아옴이 이 하네스가 이미 만든 2군 시즌 위에서만 보이기 때문이다 —
     * 활용도는 그 시즌 2군 출전 장부에서 나온다.
     *
     * ⚠️ **맨 마지막에 굴린다.** 위의 성장·표본은 전부 방금 끝난 시즌의 것이라, 전환이
     * 명단과 나이를 바꾼 뒤에 세면 다른 시즌을 재게 된다.
     */
    const academyUse = academyUseOf(state, state.userTeamId, state.season);
    transitionSeason(state);
    const intake = (state.youthCandidates ?? []).map((row) => row.player);
    const intakeUpside = intake.map((p) => p.attributes.potential - p.attributes.overall);

    const readings: Readings<typeof YOUTH_DEVELOPMENT> = {
      "2군 경기 수": reserveMatches.length,
      "결과 없는 2군 경기": unplayed,
      "2군 평균 출전": mean(reserveApps),
      "집중 육성 시즌 성장": focusGrowth,
      "무지정 우리 2군 U21 성장": growthOf(ourReserveU21),
      "타 팀 2군 U21 성장": baselineGrowth,
      "집중 육성 격차": focusGrowth - baselineGrowth,
      "멘토 자격자": mentorEligible,
      "멘토링 표본": stillMentored.length,
      "멘토링 성장 로그": mentoringRows,
      "멘토링 정신축 성장": mentoredMental,
      "무지정 정신축 성장": plainMental,
      "멘토링 격차": mentoredMental - plainMental,
      "임대 표본": stillOnLoan.length,
      "임대 U21 성장": loanGrowth,
      "임대처 평균 출전": mean(loanApps),
      "경보 전에 뛴 임대": stillOnLoan.length
        ? loanBenchRuns.filter((run) => run < LOAN_BENCH_RUN_ALERT).length / stillOnLoan.length
        : 0,
      "임대 격차": loanGrowth - baselineGrowth,
      "성실한 U21 표본": diligent.length,
      "게으른 U21 표본": lazy.length,
      "직업의식 격차": growthOf(diligent) - growthOf(lazy),
      "아카데미 활용도": academyUse,
      "다음 여름 유스 후보": intake.length,
      "유스 후보 잠재력 여지 — 평균": mean(intakeUpside),
      "유스 후보 잠재력 여지 — 최대": Math.max(...intakeUpside),
    };
    console.log(reportOf(YOUTH_DEVELOPMENT, readings, `시드 42 · ${state.date}`));
    expect(outOfBand(YOUTH_DEVELOPMENT, readings)).toEqual([]);
  });
});
