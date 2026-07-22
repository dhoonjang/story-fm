import type { Player, PlayerAttributes, PositionGroup, TacticsSpec, Team } from "@story-fm/domain";
import { DEFAULT_TACTICS } from "@story-fm/domain";

/** 테스트용 선수 생성 — 전 능력치를 base로 깔고 필요한 것만 덮어쓴다 */
export function makePlayer(
  id: string,
  positionGroup: PositionGroup,
  base: number,
  overrides: Partial<PlayerAttributes> = {},
  state: Partial<Player["state"]> = {},
): Player {
  return {
    id,
    name: id,
    age: 25,
    positionGroup,
    position: positionGroup,
    attributes: {
      pace: base,
      shooting: base,
      passing: base,
      dribbling: base,
      defending: base,
      physical: base,
      overall: base,
      potential: Math.min(99, base + 5),
      ...(positionGroup === "GK" ? { goalkeeping: base } : {}),
      ...overrides,
    },
    state: { form: 0, morale: 60, fatigue: 20, injury: "none", ...state },
  };
}

/** 4-4-2 구성의 테스트 팀 — base 능력치 일괄 지정 */
export function makeTeam(id: string, base: number, stateOverride: Partial<Player["state"]> = {}): Team {
  const players: Player[] = [
    makePlayer(`${id}-gk`, "GK", base, {}, stateOverride),
    ...[1, 2, 3, 4].map((n) => makePlayer(`${id}-df${n}`, "DF", base, {}, stateOverride)),
    ...[1, 2, 3, 4].map((n) => makePlayer(`${id}-mf${n}`, "MF", base, {}, stateOverride)),
    ...[1, 2].map((n) => makePlayer(`${id}-fw${n}`, "FW", base, {}, stateOverride)),
    // 벤치
    makePlayer(`${id}-sub-gk`, "GK", base - 5, {}, stateOverride),
    makePlayer(`${id}-sub-df`, "DF", base - 5, {}, stateOverride),
    makePlayer(`${id}-sub-mf`, "MF", base - 5, {}, stateOverride),
    makePlayer(`${id}-sub-fw`, "FW", base - 5, {}, stateOverride),
  ];
  return {
    id,
    name: id.toUpperCase(),
    shortName: id.toUpperCase(),
    players,
    startingXI: players.slice(0, 11).map((p) => p.id),
    bench: players.slice(11).map((p) => p.id),
  };
}

export const tactics = (over: Partial<TacticsSpec> = {}): TacticsSpec => ({
  ...DEFAULT_TACTICS,
  ...over,
});
