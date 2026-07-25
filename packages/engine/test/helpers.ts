import {
  advanceMockSegment,
  advanceTime,
  assignmentsOf,
  createGame,
  finalizeMatch,
  interpretBackgroundHeuristic,
  isInjured,
  playerById,
  playersOf,
  startMatch,
  type GameState,
} from "@story-fm/engine";
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

export function createTestGame(seed = 42, teamId = "arsenal"): GameState {
  const background = "K리그에서 뛰다 은퇴한 수비수 출신 분석가";
  return createGame({
    seed,
    userTeamId: teamId,
    managerName: "김감독",
    background,
    attributes: interpretBackgroundHeuristic(background),
  });
}

/** 경기일 상태에서 mock 스크립트로 경기를 끝까지 치른다 */
export function playMockMatch(state: GameState): string[] {
  const started = startMatch(state);
  if (!started.ok) throw new Error(started.message);
  let guard = 30;
  while (state.phase === "match" && guard-- > 0) {
    const step = advanceMockSegment(state);
    if (!step.ok) throw new Error(step.message);
    if (step.segment?.stop === "full_time") {
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
    if (advanced.stopped === "season_end") return;
    if (advanced.stopped === "attention") continue; // 부상·불만 보고 후 계속
    if (advanced.stopped === "matchday") {
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

export { advanceTime };
