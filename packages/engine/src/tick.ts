import { addDays, dayOfWeek, fixturesOn, nextFixtureFor } from "./calendar";
import { recomputeOverall } from "./generate";
import { quickSimulate } from "./quick-sim";
import { endSeason, allFixturesDone } from "./season";
import { pushNarrative, teamById, userTeam, type GameState } from "./state";
import { makeRng, pick, randInt } from "./rng";

/**
 * advance_time — 캘린더 시계가 흐르는 유일한 경로 (game-loop.md §3).
 * 하루 단위 tick(§4)을 결정적으로 적용하고, 감독의 결정이 필요한
 * 이벤트(경기일)에서 멈춘다.
 */

export interface AdvanceOutcome {
  ok: boolean;
  digest: string[];
  /** attention = 감독의 결정이 필요한 이벤트(부상 발생 등)에서 멈춤 (game-loop §3) */
  stopped: "matchday" | "reached" | "season_end" | "blocked" | "attention";
}

const AGE_FACTOR = (age: number) => (age <= 21 ? 1.5 : age <= 27 ? 1 : age <= 30 ? 0.5 : 0);
const XP_THRESHOLD = 25;

const FOCUS_ATTR: Record<string, "shooting" | "defending" | "passing" | "physical"> = {
  set_pieces: "shooting",
  shooting: "shooting",
  defending: "defending",
  passing: "passing",
  fitness: "physical",
};

/** 훈련 XP 적립 → 임계 도달 시 능력치 +1 (attribute-model.md §3) */
function applyTrainingDay(state: GameState, digest: string[]): void {
  const team = userTeam(state);
  const focusAttr = FOCUS_ATTR[state.training.teamFocus] ?? "passing";
  const individualMap = new Map(state.training.individual.map((i) => [i.playerId, i.focus]));

  for (const player of team.players) {
    if (player.state.injury !== "none") continue;
    const factor = AGE_FACTOR(player.age);
    if (factor === 0) continue;

    const xp = (state.playerXP[player.id] ??= {});
    const gains: Array<[string, number]> = [[focusAttr, 2 * factor]];
    const personal = individualMap.get(player.id);
    if (personal) gains.push([personal, 6 * factor]);

    for (const [attr, amount] of gains) {
      xp[attr] = (xp[attr] ?? 0) + amount;
      const attrs = player.attributes as unknown as Record<string, number>;
      if ((xp[attr] ?? 0) >= XP_THRESHOLD && (attrs[attr] ?? 99) < player.attributes.potential) {
        xp[attr] = (xp[attr] ?? 0) - XP_THRESHOLD;
        attrs[attr] = (attrs[attr] ?? 0) + 1;
        recomputeOverall(player); // 성장이 전력 평가 전체에 반영되도록
        digest.push(`훈련 성과: ${player.name} ${attr} ${attrs[attr]}`);
      }
    }
  }
}

/** @returns 감독의 결정이 필요한 이벤트(부상·불만 발생)가 있으면 true */
function dailyTick(state: GameState, digest: string[]): boolean {
  let needsAttention = false;
  const team = userTeam(state);
  const dow = dayOfWeek(state.date);
  const recovery = new Set(state.training.recovery);
  const rng = makeRng(state.seed, `tick:${state.date}`);
  const issuePlayers = new Set(state.issues.map((i) => i.playerId));

  for (const player of team.players) {
    // 1. 피로 회복 — 회복조는 가속
    const recover = recovery.has(player.id) ? 14 : 8;
    player.state.fatigue = Math.max(0, player.state.fatigue - recover);

    // 2. 부상 경과
    const days = state.injuryDays[player.id];
    if (days !== undefined) {
      if (days <= 1) {
        delete state.injuryDays[player.id];
        player.state.injury = "none";
        digest.push(`부상 복귀: ${player.name}`);
      } else {
        state.injuryDays[player.id] = days - 1;
      }
    }

    // 4~5. 폼·사기 흐름 — 방치된 불만 선수는 계속 떨어진다 (game-loop §4-5)
    if (dow === 1 && player.state.form !== 0) {
      player.state.form += player.state.form > 0 ? -1 : 1;
    }
    if (issuePlayers.has(player.id)) {
      player.state.morale = Math.max(0, player.state.morale - 1);
    } else if (player.state.morale !== 60) {
      player.state.morale += player.state.morale > 60 ? -1 : 1;
    }
  }

  // 3. 훈련 (평일, 경기일 제외)
  const isMatchday = fixturesOn(state.calendar, state.date).length > 0;
  if (dow >= 1 && dow <= 5 && !isMatchday) {
    applyTrainingDay(state, digest);

    // 8. 훈련 부상 — 소확률, 피로 가중 (결정적 시드)
    const candidates = team.players.filter((p) => p.state.injury === "none");
    if (candidates.length > 0 && rng() < 0.015) {
      const victim = pick(rng, candidates);
      const duration = randInt(rng, 5, 12) + (victim.state.fatigue > 70 ? 4 : 0);
      victim.state.injury = "minor";
      state.injuryDays[victim.id] = duration;
      digest.push(`훈련 중 부상: ${victim.name} — 약 ${duration}일 결장 예상`);
      pushNarrative(state, `${victim.name} 훈련 중 부상 (${duration}일)`, 3);
      needsAttention = true; // 부상 발생은 감독 결정 필요 이벤트 (game-loop §3)
    }
  }

  // 7. 주급 (금요일)
  if (dow === 5) {
    state.finance.balance -= state.finance.weeklyWages;
  }

  // 8-2. 벤치 불만 발생 — 월요일, 고평가 벤치 자원 (간이)
  if (dow === 1 && rng() < 0.15) {
    const benched = team.players.filter(
      (p) =>
        !team.startingXI.includes(p.id) &&
        p.attributes.overall >= 78 &&
        !issuePlayers.has(p.id),
    );
    if (benched.length > 0) {
      const gripe = pick(rng, benched);
      state.issues.push({
        playerId: gripe.id,
        kind: "unhappy",
        note: "출전 기회 불만",
        since: state.date,
      });
      digest.push(`${gripe.name}이(가) 출전 기회에 불만을 품기 시작했다 — 면담이 필요해 보인다`);
      pushNarrative(state, `${gripe.name} 출전 불만`, 3);
      needsAttention = true;
    }
  }
  return needsAttention;
}

/** 해당 날짜의 타 팀 경기 간이 시뮬 (결정 #5) */
function simulateOtherFixtures(state: GameState, digest: string[]): void {
  for (const fixture of fixturesOn(state.calendar, state.date)) {
    if (fixture.result) continue;
    if (fixture.homeId === state.userTeamId || fixture.awayId === state.userTeamId) continue;
    const result = quickSimulate(
      teamById(state, fixture.homeId),
      teamById(state, fixture.awayId),
      state.seed,
      `${state.season}:${fixture.round}:${fixture.homeId}-${fixture.awayId}`,
    );
    fixture.result = {
      homeGoals: result.homeGoals,
      awayGoals: result.awayGoals,
      scorers: result.scorers,
    };
  }
  const played = fixturesOn(state.calendar, state.date).filter(
    (f) => f.result && f.homeId !== state.userTeamId && f.awayId !== state.userTeamId,
  );
  if (played.length > 0) {
    digest.push(
      `라운드 결과: ` +
        played
          .map(
            (f) =>
              `${teamById(state, f.homeId).shortName} ${f.result?.homeGoals}-${f.result?.awayGoals} ${teamById(state, f.awayId).shortName}`,
          )
          .join(", "),
    );
  }
}

export function advanceTime(
  state: GameState,
  until: "next_match" | { days: number },
): AdvanceOutcome {
  if (state.phase !== "idle") {
    return {
      ok: false,
      digest: ["오늘은 경기가 있습니다 — 경기를 먼저 치러야 시간이 흐릅니다."],
      stopped: "blocked",
    };
  }

  const digest: string[] = [];
  const maxDays = typeof until === "object" ? Math.min(until.days, 30) : 60;

  for (let d = 0; d < maxDays; d++) {
    // 시즌 종료 체크 — 남은 경기가 없으면 시즌 리뷰 + 전환
    if (allFixturesDone(state)) {
      const lines = endSeason(state);
      digest.push(...lines);
      return { ok: true, digest, stopped: "season_end" };
    }

    state.date = addDays(state.date, 1);
    const needsAttention = dailyTick(state, digest);
    simulateOtherFixtures(state, digest);

    const userFixture = fixturesOn(state.calendar, state.date).find(
      (f) => !f.result && (f.homeId === state.userTeamId || f.awayId === state.userTeamId),
    );
    if (userFixture) {
      state.phase = "matchday";
      const opponentId =
        userFixture.homeId === state.userTeamId ? userFixture.awayId : userFixture.homeId;
      digest.push(
        `경기일 — R${userFixture.round} ${userFixture.homeId === state.userTeamId ? "홈" : "원정"} vs ${teamById(state, opponentId).name}`,
      );
      return { ok: true, digest, stopped: "matchday" };
    }

    // needsManager 정지 — 부상·불만 발생은 감독에게 마이크를 넘긴다 (game-loop §3)
    if (needsAttention) {
      return { ok: true, digest, stopped: "attention" };
    }

    if (typeof until === "object" && d + 1 >= until.days) {
      return { ok: true, digest, stopped: "reached" };
    }
  }

  return { ok: true, digest, stopped: "reached" };
}

export function describeNextFixture(state: GameState): string {
  const next = nextFixtureFor(state.calendar, state.userTeamId, state.date);
  if (!next) return "남은 일정이 없습니다 — 시즌 마무리 국면입니다.";
  const opponentId = next.homeId === state.userTeamId ? next.awayId : next.homeId;
  return `다음 경기: R${next.round} ${next.date} ${next.homeId === state.userTeamId ? "홈" : "원정"} vs ${teamById(state, opponentId).name}`;
}
