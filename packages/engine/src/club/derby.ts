/**
 * 더비 전적 — **장부에서 파생한다.** 어느 대진이 더비인가는 표가 정하고
 * (`data/derbies.ts`), 그 결과가 어땠는지는 경기 원장이 이미 갖고 있다.
 *
 * 따로 저장하지 않는 이유는 두 벌이 갈리기 때문이다: 저장한 전적은 경기 결과를
 * 고치는 자리(연장·승부차기 판정, 어드민)를 따라오지 못하고, 그때부터 회견이
 * 순위표와 다른 말을 한다.
 */

import { isReserveMatch, type MatchRecord } from "@story-fm/domain";
import type { GameState } from "../core/state";
import { isFriendly } from "../competition/friendly";
import { derbyOf, type Derby } from "../data/derbies";

/**
 * 전적이 거슬러 올라가는 시즌 수 — **상한이지 약속이 아니다.**
 * 지금 원장(`state.matches`)은 시즌 전환에서 통째로 갈리므로(season.md §5) 실제로
 * 서는 것은 이번 시즌 한 해다. 상한을 적어 두는 것은 원장이 깊어지는 날 전적이
 * 조용히 커리어 전체로 넓어지지 않게 하기 위한 것이다.
 */
export const DERBY_RECORD_SEASONS = 3;

export interface DerbyRecord {
  won: number;
  drawn: number;
  lost: number;
}

/**
 * 이 경기의 더비 — **라이벌 축이 걸리는 자리가 전부 이 문 하나를 지난다**
 * (강도·사기·관중·전적).
 *
 * ⚠️ 친선과 2군은 더비가 아니다. 대진은 같아도 프리시즌 친선의 승패가 스쿼드
 * 전원의 폼을 흔들면 몸을 만드는 5주가 라커룸을 정하고, 2군 경기는 결과가 출전과
 * 성장에만 닿는 경기다 (season.md §2).
 */
export function derbyForMatch(match: MatchRecord): Derby | null {
  if (isFriendly(match) || isReserveMatch(match)) return null;
  return derbyOf(match.homeTeamId, match.awayTeamId);
}

/** 전적에 세는 경기인가 */
function counts(state: GameState, m: MatchRecord): boolean {
  return (
    m.result !== null &&
    m.season > state.season - DERBY_RECORD_SEASONS &&
    !isFriendly(m) &&
    !isReserveMatch(m)
  );
}

/**
 * 감독 팀이 치른 더비들 — 새 경기가 뒤다.
 * @param opponentId 주면 그 상대와의 더비만
 */
export function derbyMatchesOf(state: GameState, opponentId?: string): MatchRecord[] {
  const us = state.userTeamId;
  return state.matches
    .filter((m) => {
      if (!counts(state, m)) return false;
      if (m.homeTeamId !== us && m.awayTeamId !== us) return false;
      const them = m.homeTeamId === us ? m.awayTeamId : m.homeTeamId;
      if (opponentId !== undefined && them !== opponentId) return false;
      return derbyOf(us, them) !== null;
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** 경기 목록의 우리 시각 전적 */
export function derbyRecordFrom(state: GameState, matches: readonly MatchRecord[]): DerbyRecord {
  const record: DerbyRecord = { won: 0, drawn: 0, lost: 0 };
  for (const m of matches) {
    const home = m.homeTeamId === state.userTeamId;
    const ours = home ? m.result!.homeGoals : m.result!.awayGoals;
    const theirs = home ? m.result!.awayGoals : m.result!.homeGoals;
    if (ours > theirs) record.won++;
    else if (ours === theirs) record.drawn++;
    else record.lost++;
  }
  return record;
}

/**
 * 그 상대와의 더비 전적.
 * @param excludeMatchId 이 경기는 빼고 센다 — 방금 끝난 경기의 회견이 **그 전까지의**
 *   전적을 묻는 자리라, 넣으면 첫 더비가 이미 1승 0패로 시작한다 (people.md §4).
 */
export function derbyRecordOf(
  state: GameState,
  opponentId: string,
  excludeMatchId?: string,
): DerbyRecord {
  return derbyRecordFrom(
    state,
    derbyMatchesOf(state, opponentId).filter((m) => m.id !== excludeMatchId),
  );
}
