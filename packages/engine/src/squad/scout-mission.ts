import type { GamePlayer, ScoutMission } from "@story-fm/domain";
import { MISSION_CANDIDATES, observedOverall } from "@story-fm/domain";
import { observationOf, potentialBand } from "./scouting";
import { observedMarketValue } from "../market/market";
import { inPlayerPool, playerPoolOf } from "../world/player-pool";
import { isOurPlayer, type GameState } from "../core/state";

/**
 * **스카우트 임무의 추천 목록** — 조건 한 벌이 후보 다섯이 되는 자리
 * (→ docs/data/player.md §9.4).
 *
 * ⚠️ **안개를 우회하지 않는다.** 줄을 세우는 값은 그 후보의 행이 찍는 값과 같은
 * 관측값이다(player.md §10 — 정렬과 상위 N도 노출이다). 참값으로 다섯을 고르고
 * 흐린 값으로 그리면, 다섯이 뽑혔다는 사실 자체가 참값을 말해 준다.
 *
 * ⚠️ **결정적이다.** 같은 상태·같은 조건이면 언제나 같은 다섯이 나온다 — 관측값은
 * `(seed, 선수 id, 축)` 해시이고 동점은 선수 id가 가른다. 추첨이 끼면 감독이
 * 임무를 두 번 보낼 이유가 「다시 굴리기」가 된다.
 */

/**
 * 후보 하나의 정렬 키 — **선수당 한 번만** 뽑는다.
 *
 * 관측값 셋은 모두 지식 수준 파생이라 한 번이 기록 훑기다. 조건으로 좁힌 뒤에
 * 뽑고, 비교는 그 숫자로 한다 (`searchPlayers`의 `sortKeyOf`와 같은 이유).
 */
interface CandidateKey {
  id: string;
  /** 관측 종합 — 카드의 행이 찍는 그 값 */
  overall: number;
  /**
   * 관측 잠재력 구간의 중심. 구간이 없는 선수(`rumoured`)는 성장 여력을 짐작할
   * 근거가 없으므로 **지금 실력이 곧 중심**이다.
   */
  centre: number;
  /** 관측 시장가 — 예산 조건이 거르는 값 */
  value: number;
}

function candidateKeyOf(state: GameState, player: GamePlayer): CandidateKey {
  const overall = observedOverall(player.attributes.overall, observationOf(state, player.id));
  const band = potentialBand(state, player);
  return {
    id: player.id,
    overall,
    centre: band ? (band.low + band.high) / 2 : overall,
    value: observedMarketValue(state, player),
  };
}

/**
 * 조건을 지나는 후보 `MISSION_CANDIDATES`명 — **관측 종합 → 잠재력 구간 중심 → id.**
 *
 * 종합과 구간을 **한 점수로 섞지 않는다.** 섞으면 구간을 가진 선수(우리와 붙어 본
 * 적이 있거나 이미 스카우팅을 마친 선수)가 그 사실 하나로 조용히 위로 올라온다 —
 * 임무가 데려오라고 한 것은 「우리가 이미 아는 선수」가 아니다. 구간은 같은 종합
 * 안에서만 줄을 가른다.
 *
 * 값은 **조건이지 점수가 아니다** — 예산 안에서 가장 좋은 선수를 데려오는 것이
 * 스카우트의 일이지 싼 선수를 골라 오는 것이 아니다.
 */
export function rankMissionCandidates(state: GameState, mission: ScoutMission): string[] {
  const pool = playerPoolOf(state, {
    competitionId: mission.competitionId ?? null,
    ...(mission.position === undefined ? {} : { position: mission.position }),
    ...(mission.minAge === undefined ? {} : { minAge: mission.minAge }),
    ...(mission.maxAge === undefined ? {} : { maxAge: mission.maxAge }),
  });
  // 싼 조건이 앞에 선다 — 관측값은 선수마다 기록을 훑으므로 좁힌 만큼만 뽑는다
  const keys: CandidateKey[] = [];
  for (const player of state.players) {
    // 우리 선수에게는 스카우트를 보내지 않는다 (`scoutPlayer`와 같은 자)
    if (isOurPlayer(state, player)) continue;
    if (!inPlayerPool(state, player, pool)) continue;
    const key = candidateKeyOf(state, player);
    if (mission.maxValue !== undefined && key.value > mission.maxValue) continue;
    keys.push(key);
  }
  keys.sort((a, b) => b.overall - a.overall || b.centre - a.centre || (a.id < b.id ? -1 : 1));
  return keys.slice(0, MISSION_CANDIDATES).map((k) => k.id);
}
