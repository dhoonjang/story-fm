import {
  acceptDeal,
  answerIncomingOffer,
  incomingOffer,
  advanceSegment,
  advanceTime,
  assignmentsOf,
  createGame,
  runMedicals,
  cupCatalogById,
  euroCompetitionOf,
  finalizeMatch,
  interpretBackgroundHeuristic,
  isInjured,
  isSettling,
  playerById,
  playersOf,
  startMatch,
  type GameState,
  squadReturnOf,
  FRIENDLY_ROUNDS,
  MINI_WORLD,
  FAMILIARITY_DRIFT_CAP,
  FAMILIARITY_DRIFT_PER_DAY,
  assignmentsOf as assignmentsOfTeam,
} from "@story-fm/engine";
import { applyFamiliarityGain } from "@story-fm/domain";
import type { GamePlayer } from "@story-fm/domain";

/** 간이 시뮬 입력 조립 — 배치 선발에서 가용 선수를 뽑는다 (테스트용) */
export function simSquad(state: GameState, teamId: string) {
  const starters = assignmentsOf(state, teamId, "starting")
    .map((a) => playerById(state, a.playerId))
    .filter((p): p is GamePlayer => p !== null && !isInjured(state, p.id));
  if (starters.length < 11) {
    const used = new Set(starters.map((p) => p.id));
    for (const p of playersOf(state, teamId)) {
      if (starters.length >= 11) break;
      if (!used.has(p.id) && !isInjured(state, p.id)) starters.push(p);
    }
  }
  return { teamId, starters };
}

/**
 * 축소 세계의 새 게임 — 한 리그 8팀, 컵 없음 (`MINI_WORLD`).
 *
 * 시즌을 끝까지 도는 검증에 쓴다. 전체 세계는 한 시즌에 2,100여 경기를 굴려
 * 파일 하나가 몇 분을 쓰는데, 같은 규칙의 작은 세계는 1초 안에 끝난다.
 * 컵·대항전 구조를 검증하는 테스트는 그 규모가 곧 대상이므로 전체 세계를 쓴다.
 */
export function createMiniGame(seed = 42, teamId = "arsenal"): GameState {
  const background = "K리그에서 뛰다 은퇴한 수비수 출신 분석가";
  return createGame({
    seed,
    userTeamId: teamId,
    managerName: "김감독",
    background,
    attributes: interpretBackgroundHeuristic(background, teamId),
    world: MINI_WORLD,
  });
}

/**
 * 축소 세계에서 시즌 하나를 끝까지 돈다 — 유저 경기는 구간 시뮬로 치른다.
 * @returns 시즌이 끝났으면 true (한도 안에 못 끝내면 false)
 */
export function playFullSeason(state: GameState, limit = 400): boolean {
  for (let i = 0; i < limit; i++) {
    const advanced = advanceTime(state, "next_match");
    if (!advanced.ok) throw new Error(advanced.digest.join(" / "));
    if (advanced.stopped === "season_end") return true;
    if (advanced.stopped === "blocked") return false;
    if (advanced.stopped === "matchday") {
      drillUserTactics(state, 7);
      playMockMatch(state);
    }
  }
  return false;
}

/**
 * 훈련하는 감독 — 감독 팀의 전술 적응도를 AI 팀과 같은 눈금으로 올린다.
 *
 * 실제 플레이에서는 훈련·경기 결산(LLM)이 이 자리를 채워 95·100까지 간다.
 * mock 모드에는 그 판정이 없어서, 하네스가 이걸 하지 않으면 **감독 팀만 기준선
 * (60)에 멎은 채** AI 팀은 80까지 붙는 세계를 측정하게 된다.
 */
/**
 * 인내하는 보드 — 측정용. 경질은 시계를 멈추므로(state.dismissal) 재정·시즌
 * 분포를 재는 하네스는 자리를 지킨 채 한 시즌을 다 돌아야 한다.
 */
export function keepSeat(state: GameState): void {
  state.manager.reputation.board = 60;
  state.manager.boardWarnings = 0;
}

export function drillUserTactics(state: GameState, days = 1): void {
  for (const a of assignmentsOfTeam(state, state.userTeamId)) {
    if (a.familiarity >= FAMILIARITY_DRIFT_CAP) continue;
    a.familiarity = Math.min(
      FAMILIARITY_DRIFT_CAP,
      applyFamiliarityGain(a.familiarity, FAMILIARITY_DRIFT_PER_DAY * days, "training"),
    );
  }
}

export function createTestGame(seed = 42, teamId = "arsenal"): GameState {
  const background = "K리그에서 뛰다 은퇴한 수비수 출신 분석가";
  return createGame({
    seed,
    userTeamId: teamId,
    managerName: "김감독",
    background,
    // 앱과 같은 경로 — 부임 구단의 격까지 넣어 판정한다
    attributes: interpretBackgroundHeuristic(background, teamId),
  });
}

/**
 * 유저 팀의 시즌 경기 수 — 프리시즌 친선 + 리그 38 + 대항전 리그 페이즈.
 * 대항전 출전 여부는 시드에 따라 갈리므로 하드코딩하지 않고 파생한다.
 */
export function userFixtureCount(state: GameState): number {
  const cup = euroCompetitionOf(state.euroEntrants, state.userTeamId);
  return FRIENDLY_ROUNDS + 38 + (cup ? (cupCatalogById(cup)?.matchesPerTeam ?? 0) : 0);
}

/**
 * 경기일까지 전진 — attention 정지(부상·이적 오퍼 등)는 넘긴다.
 * `advanceTime` 한 번으로는 경기일에 닿지 않는다: 감독의 결정이 필요한 사건이
 * 중간에 멈춰 세우기 때문이다 (그게 정상 동작이다).
 */
export function advanceToMatchday(state: GameState): void {
  let guard = 30;
  while (guard-- > 0) {
    const advanced = advanceTime(state, "next_match");
    if (!advanced.ok) throw new Error(advanced.digest.join(" / "));
    if (advanced.stopped === "attention") continue;
    return;
  }
  throw new Error("attention 정지가 반복되어 경기일에 도달하지 못했습니다");
}

/**
 * 경기일 상태에서 코어 구간 시뮬레이터로 경기를 끝까지 치른다.
 * 실모드와 같은 함수를 쓴다 — 차이는 서술을 LLM이 맡는지뿐이다.
 */
export function playMockMatch(state: GameState): string[] {
  const started = startMatch(state);
  if (!started.ok) throw new Error(started.message);
  let guard = 60;
  while (state.phase === "match" && guard-- > 0) {
    const step = advanceSegment(state);
    if (!step.ok) throw new Error(step.message);
    if (step.plan?.stop === "full_time") {
      return finalizeMatch(state);
    }
  }
  throw new Error("경기가 끝나지 않았습니다");
}

/** idle → 다음 경기일까지 전진 후 경기까지 완료 (attention 정지는 계속 진행) */
export function advanceAndPlay(state: GameState): void {
  let guard = 10;
  while (guard-- > 0) {
    const advanced = advanceTime(state, "next_match");
    if (!advanced.ok) throw new Error(advanced.digest.join(" / "));
    // 경질은 시계가 멈춘 상태다 — 오류가 아니라 끝이다
    if (advanced.stopped === "season_end" || advanced.stopped === "blocked") return;
    if (advanced.stopped === "attention") continue; // 부상·불만 보고 후 계속
    if (advanced.stopped === "matchday") {
      drillUserTactics(state, 7); // 지난 한 주의 훈련
      playMockMatch(state);
      return;
    }
    throw new Error(`경기일 도달 실패: ${advanced.stopped}`);
  }
  throw new Error("attention 정지가 반복되어 경기일에 도달하지 못했습니다");
}

/** N일을 소화할 때까지 advance (attention 정지 무시) — tick 검증용 */
export function advanceDays(state: GameState, days: number): void {
  const target = days;
  let consumed = 0;
  let guard = 30;
  while (consumed < target && guard-- > 0) {
    const before = state.date;
    const r = advanceTime(state, { days: target - consumed });
    if (!r.ok) throw new Error(r.digest.join(" / "));
    consumed += diffDays(before, state.date);
    if (r.stopped === "matchday" || r.stopped === "season_end") return;
  }
}

function diffDays(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

/**
 * 정착이 끝날 때까지 우리 팀 경기 출전을 쌓는다 — 안개가 걷힌 상태를 만드는 용도.
 * 날짜를 밀어서는 안 끝난다(정착은 달력이 아니라 겪은 양이다).
 */
export function settleFully(state: GameState, playerId: string): void {
  for (let i = 0; i < 60 && isSettling(state, playerId); i++) {
    state.matches.push({
      id: `settle-${playerId}-${i}`,
      season: state.season,
      competitionId: "friendly",
      round: 1,
      date: state.date,
      homeTeamId: state.userTeamId,
      awayTeamId: "opponent",
      result: { homeGoals: 0, awayGoals: 0, scorers: [], homeLineup: [playerId] },
    });
  }
}

export { advanceTime };

/**
 * 휴가가 끝난 시점으로 — **훈련을 걸 수 있는 상태**로 만든다.
 *
 * 게임은 7월 1일에 시작하지만 선수단은 소집일(둘째 월요일) 전까지 휴가다.
 * 훈련을 검증하는 테스트는 그 뒤에서 시작해야 한다 (`setTraining`이 거부한다).
 */
export function afterSquadReturn(state: GameState): GameState {
  const back = squadReturnOf(state.calendar);
  if (state.date < back) state.date = back;
  return state;
}

/**
 * 합의된 딜을 **끝까지** 민다 — 메디컬을 지나 계약까지.
 *
 * `acceptDeal` 한 번은 이제 검진 일정만 잡는다(medical.ts). 장부가 움직이는 것을
 * 보려는 테스트는 검진일까지 시계를 옮기고 결과를 받아야 하고, 소견이 나오면
 * 감독이 강행하는 경로(같은 도구를 한 번 더)까지 따라가야 한다 — 이 게임에서
 * "이적이 끝났다"는 그 셋을 다 지난 상태다.
 *
 * @returns 마지막 호출의 결과 (실패 이유를 그대로 볼 수 있게)
 */
export function completeDeal(state: GameState, negotiationId: string) {
  const negotiation = state.negotiations.find((n) => n.id === negotiationId);
  if (!negotiation) return { ok: false, message: `협상 "${negotiationId}"을 찾지 못했습니다` };
  // 이미 검진이 잡혀 있으면 다시 부르지 않는다 — "결과를 기다리는 중"만 돌아온다
  let result = negotiation.medical ? { ok: true, message: "" } : acceptDeal(state, negotiationId);
  if (!result.ok) return result;
  const medical = negotiation.medical;
  if (medical && medical.status === "scheduled") {
    if (state.date < medical.onDate) state.date = medical.onDate;
    const digest: string[] = [];
    runMedicals(state, digest);
    // 통과했으면 runMedicals가 이미 계약까지 옮겼다
    if (negotiation.status === "completed") return { ok: true, message: digest.join(" · ") };
    /**
     * 우리가 파는 쪽이면 소견을 본 상대가 값을 깎아 다시 불렀다 — 협상이
     * `open`으로 돌아와 감독의 답을 기다린다. 테스트는 그 값을 받는 쪽으로 민다.
     */
    if (negotiation.status === "open" && incomingOffer(negotiation)) {
      const answered = answerIncomingOffer(state, { negotiationId, verdict: "accept" });
      if (!answered.ok) return answered;
    }
    if (negotiation.status !== "agreed") return { ok: false, message: digest.join(" · ") };
    // 소견이 붙었다 — 감독이 강행한다
    result = acceptDeal(state, negotiationId);
  }
  return result;
}
