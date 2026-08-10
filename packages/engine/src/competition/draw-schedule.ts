import type { MatchStage, ScheduleEntry } from "@story-fm/domain";
import { sortEntries } from "./calendar";
import { competitionShortName, competitionStageName } from "../data/cup-catalog";
import type { GameState } from "../core/state";

/**
 * 컵 대진 추첨을 일정 축에 올린다 — 국내 컵과 유럽 대항전 녹아웃이 공유한다.
 *
 * 왜 별도 엔티티를 두지 않았나: 추첨은 **상태가 아니라 시각**이다. 남길 것은
 * "언제 어느 대회의 어느 단계가 뽑히는가"뿐이고, 그건 SCHEDULE_ENTRY 하나로
 * 충분하다 (`refId = "facup:r16"`). 덕분에 저장 스키마도 그대로다.
 *
 * 이 엔트리는 UI 장식이 아니라 **진행 상태 기계의 일부**다. `scheduled`인 추첨이
 * 남아 있다는 것은 곧 "그 라운드는 아직 안 열렸다"는 뜻이라, 시즌 종료 판정도
 * 이걸 본다 (`allMatchesDone`). 감독의 달력엔 우리와 상관있는 추첨만 보인다.
 */

/** 추첨 시각 — 실제 컵 추첨도 경기 없는 날 낮에 열린다 */
export const DRAW_TIME = "12:00";

export function drawRefId(competitionId: string, stage: MatchStage): string {
  return `${competitionId}:${stage}`;
}

export function parseDrawRef(refId: string): { competitionId: string; stage: MatchStage } | null {
  const [competitionId, stage] = refId.split(":");
  if (!competitionId || !stage) return null;
  return { competitionId, stage: stage as MatchStage };
}

export function drawEntryOf(
  state: GameState,
  competitionId: string,
  stage: MatchStage,
): ScheduleEntry | undefined {
  const refId = drawRefId(competitionId, stage);
  return state.schedule.find((e) => e.type === "draw" && e.refId === refId);
}

/**
 * 추첨 예약 — 이미 있으면 아무 일도 하지 않는다.
 * @param forUser 우리 팀이 이 라운드에 걸려 있는가 (달력에 보일지를 정한다)
 * @returns 새로 잡았으면 true — 호출부가 "한 번만" 보고할 때 쓴다
 */
export function scheduleDraw(
  state: GameState,
  competitionId: string,
  stage: MatchStage,
  date: string,
  forUser: boolean,
): boolean {
  if (drawEntryOf(state, competitionId, stage)) return false;
  state.schedule.push({
    id: `se-draw-${competitionId}-${state.season}-${stage}`,
    date,
    time: DRAW_TIME,
    type: "draw",
    refId: drawRefId(competitionId, stage),
    // 우리와 무관한 추첨도 엔트리는 남는다(편성 시점의 원본) — 달력에서만 감춘다
    teamId: forUser ? state.userTeamId : null,
    status: "scheduled",
  });
  state.schedule = sortEntries(state.schedule);
  return true;
}

/** 추첨일이 됐는가 — 예약이 없으면 아직 잡히지도 않은 것이다 */
export function drawIsDue(state: GameState, competitionId: string, stage: MatchStage): boolean {
  const entry = drawEntryOf(state, competitionId, stage);
  return entry !== undefined && entry.status === "scheduled" && entry.date <= state.date;
}

/** 추첨 완료 — 대진이 나왔으니 엔트리를 소화 처리한다 */
export function completeDraw(state: GameState, competitionId: string, stage: MatchStage): void {
  const entry = drawEntryOf(state, competitionId, stage);
  if (entry) entry.status = "done";
}

/** 아직 열리지 않은 추첨이 남아 있는가 — 시즌을 넘기면 안 되는 이유 */
export function hasPendingDraw(state: GameState): boolean {
  return state.schedule.some((e) => e.type === "draw" && e.status === "scheduled");
}

/**
 * 추첨의 조각 — 대회 약칭과 단계 이름. 좁은 달력 칸은 제목을 통째로 못 쓰므로
 * UI가 문자열을 자르지 않도록 나눠서 준다.
 */
export function drawParts(refId: string): { competition: string; stage: string } {
  const parsed = parseDrawRef(refId);
  if (!parsed) return { competition: "", stage: "대진" };
  return {
    competition: competitionShortName(parsed.competitionId),
    stage: competitionStageName(parsed.competitionId, parsed.stage),
  };
}

/** 달력·조회에 쓰는 제목 — "FA컵 16강 대진 추첨" (추첨은 차수와 무관하다) */
export function drawTitle(refId: string): string {
  const { competition, stage } = drawParts(refId);
  return `${competition} ${stage} 대진 추첨`;
}
