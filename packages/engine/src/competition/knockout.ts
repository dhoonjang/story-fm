import type { MatchRecord, MatchStage } from "@story-fm/domain";
import { sortEntries } from "./calendar";
import { pairOf } from "./extra-time";
import { pushNarrative, type GameState } from "../core/state";

/**
 * 녹아웃 대회의 **공통 골격** — 단계의 경기 목록·대진의 차전·감독 달력 등재·단계 결과 보고.
 *
 * 국내 컵(`domestic-cup.ts`)과 유럽 대항전(`euro-knockout.ts`)은 편성 규칙이 서로
 * 다르지만(순위표 시드 대 추첨, 고정 날짜 대 달력의 틈) **대진을 읽고 감독에게
 * 알리는 방식은 같다.** 다른 것만 인자로 받는다 — 킥오프 시각, 단계 라벨, 약칭.
 */

/** 이 대회 이 단계의 경기 — 대진 번호, 그다음 차수 순 */
export function stageMatchesOf(state: GameState, cupId: string, stage: MatchStage): MatchRecord[] {
  return state.matches
    .filter((m) => m.season === state.season && m.competitionId === cupId && m.stage === stage)
    .sort((a, b) => pairOf(a) - pairOf(b) || a.round - b.round);
}

/** 이 대진의 모든 차전 — 차수 순 (`stageMatches`가 이미 정렬돼 있다) */
export function tieLegsOf(stageMatches: readonly MatchRecord[], pair: number): MatchRecord[] {
  return stageMatches.filter((m) => pairOf(m) === pair);
}

/**
 * 감독의 달력에 우리 팀 경기를 올린다 (남의 경기는 장부에만 남는다).
 *
 * @param defaultKickoff 경기에 시각이 적히지 않았을 때의 자리 — 대회마다 다르다.
 */
export function registerUserEntries(
  state: GameState,
  matches: readonly MatchRecord[],
  defaultKickoff: string,
): void {
  const ours = matches.filter(
    (m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId,
  );
  if (ours.length === 0) return;
  for (const m of ours) {
    state.schedule.push({
      id: `se-${m.id}`,
      date: m.date,
      time: m.time ?? defaultKickoff,
      type: "match",
      refId: m.id,
      teamId: state.userTeamId,
      status: "scheduled",
    });
  }
  state.schedule = sortEntries(state.schedule);
}

/** 감독의 팀이 그 단계에서 낸 결과 — 통과인지 탈락인지 */
export interface TieReport {
  /** 그 단계의 경기 전부 — 감독의 팀이 뛰었는지를 여기서 읽는다 */
  matches: readonly MatchRecord[];
  /** 대회 약칭 — 국내 컵은 `cup.short`, 대항전은 `competitionShortName(cup.id)` */
  short: string;
  /** 단계 이름 — 대회마다 부르는 법이 다르다 */
  label: string;
  /** 그 단계를 통과한 팀 전부 */
  winners: readonly string[];
}

/** 우리 팀이 뛴 단계의 결과 보고 — 다음 단계 편성과 같은 시점에 한 번만 */
export function reportOurTie(state: GameState, tie: TieReport, digest: string[]): void {
  const played = tie.matches.some(
    (m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId,
  );
  if (!played) return;
  const advanced = tie.winners.includes(state.userTeamId);
  const what = `${tie.short} ${tie.label} ${advanced ? "통과" : "탈락"}`;
  digest.push(what);
  pushNarrative(state, what, 4);
}
