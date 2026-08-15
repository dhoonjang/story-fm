import type { MatchRecord } from "@story-fm/domain";

/**
 * 프리시즌 친선 — **대회가 아니라 경기다** (season.md §2 · competition.md §1).
 *
 * 소집일과 개막 사이 5주가 훈련만으로 남지 않게 하는 것이 전부다. 대회 id를 하나
 * 더 만들면 순위표·대진표·시즌 기록·상금이 전부 따라붙으므로, 친선은
 * `competitionId`가 널인 경기로 존재한다.
 */

/** 팀당 치르는 친선 경기 수 — 개막 직전 토요일에서 거꾸로 주 1회 */
export const FRIENDLY_ROUNDS = 4;

/** 감독에게 보이는 이름 — 대회명이 아니므로 단계 라벨도 붙지 않는다 */
export const FRIENDLY_LABEL = "친선";

/**
 * 이 경기가 어느 대회에도 속하지 않는가.
 *
 * 대회를 세는 자리(순위표·시즌 기록·징계·상금·대회 화면)는 전부 이 문을 먼저
 * 지난다. `competitionId`를 널 허용으로 연 것이 곧 그 자리들을 타입으로 드러내는
 * 장치다.
 */
export function isFriendly(match: Pick<MatchRecord, "competitionId">): boolean {
  return match.competitionId === null;
}
