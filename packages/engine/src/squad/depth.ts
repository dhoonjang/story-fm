import type { GamePlayer } from "@story-fm/domain";
import { naturalPositionOf } from "@story-fm/domain";
import { playersOf, type GameState } from "../core/state";

/**
 * 스쿼드의 **깊이와 힘** — "그 자리에 나보다 나은 선수가 몇이나 있나"와 "이 팀은
 * 얼마나 센가"를 한 벌로 갖는다.
 *
 * 이적 시장·재계약·설득·승강·체급 재산정이 전부 이 두 물음을 던진다. 원래는
 * 부르는 자리마다 같은 세 줄을 다시 적었고 — 설득 쪽은 `market ↔ persuasion` 순환
 * import를 피하려고 일부러 베꼈다 — 그래서 "같은 자리"의 뜻이 파일마다 조용히
 * 갈릴 수 있었다. **순환은 복제의 이유가 아니라 아래로 내리라는 신호다**
 * (AGENTS.md §5): 여기는 아무도 import 하지 않는 잎이라 어느 쪽에서든 부를 수 있다.
 */

/** 판에 서는 인원 — 스쿼드의 힘은 이만큼의 평균으로 잰다 */
const STARTING_XI = 11;

/**
 * 이 팀에서 그 자리를 더 잘 보는 선수 수 — 포지션군(GK/DF/MF/FW)은 40인 스쿼드에서
 * 너무 거칠어 "8명이 더 낫다"가 늘 나온다. 주 포지션 코드로 좁혀 센다.
 */
export function betterAtPosition(state: GameState, teamId: string, player: GamePlayer): number {
  const position = naturalPositionOf(player).position;
  return playersOf(state, teamId).filter(
    (p) =>
      p.id !== player.id &&
      naturalPositionOf(p).position === position &&
      p.attributes.overall > player.attributes.overall,
  ).length;
}

/**
 * `betterAtPosition`을 여러 번 물어야 할 때 쓰는 **팀×자리 색인** — 세는 규칙은
 * 위와 같고, 선수 배열을 한 번만 훑는다.
 *
 * AI 재계약 검토(`runAiRenewals`)는 하루에 수백 건의 계약을 보는데, 건마다 전
 * 선수를 훑으면 그 하루가 5,777 × 수백이 된다. 색인은 **읽기 전용 파생**이라
 * 선수의 소속·전력이 그대로인 동안만 유효하다 — 한 번의 순회 안에서 세우고 버린다.
 */
export interface SquadDepth {
  /** 그 팀 그 자리에서 이 선수보다 나은 선수 수 */
  betterThan(teamId: string, player: GamePlayer): number;
}

export function squadDepthOf(state: GameState): SquadDepth {
  // 자리별 전력을 내림차순으로 — "나보다 큰" 구간이 앞쪽 연속이 되어 경계만 찾으면 된다
  const bySlot = new Map<string, number[]>();
  for (const p of state.players) {
    const slot = `${p.teamId}\u0000${naturalPositionOf(p).position}`;
    const list = bySlot.get(slot);
    if (list) list.push(p.attributes.overall);
    else bySlot.set(slot, [p.attributes.overall]);
  }
  for (const list of bySlot.values()) list.sort((a, b) => b - a);
  return {
    betterThan(teamId, player) {
      const list = bySlot.get(`${teamId}\u0000${naturalPositionOf(player).position}`);
      if (!list) return 0;
      const mine = player.attributes.overall;
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid]! > mine) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    },
  };
}

/**
 * 스쿼드 상위 열한 명의 평균 OVR — 팀 하나를 한 숫자로 줄이는 잣대.
 * 승강(2부 클럽 줄 세우기)과 체급 재산정의 전력 축이 같은 자를 쓴다.
 */
export function squadRating(state: GameState, teamId: string): number {
  const squad = playersOf(state, teamId);
  if (squad.length === 0) return 0;
  const top = [...squad]
    .sort((a, b) => b.attributes.overall - a.attributes.overall)
    .slice(0, STARTING_XI);
  return top.reduce((sum, p) => sum + p.attributes.overall, 0) / top.length;
}
