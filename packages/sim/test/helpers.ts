import type {
  AxisValues,
  GamePlayer,
  PlayerAttributes,
  PositionGroup,
  TacticsSpec,
} from "@story-fm/domain";
import { ATTRIBUTE_AXES, DEFAULT_TACTICS } from "@story-fm/domain";
import type { LedgerSide, LineupSlot, SideInput } from "@story-fm/sim";

/** 테스트용 선수 — 15축 전부 보유, positions[], 부상은 상태에 없음 */
export function makePlayer(
  id: string,
  teamId: string,
  position: string,
  group: PositionGroup,
  base: number,
  overrides: Partial<PlayerAttributes> = {},
  state: Partial<GamePlayer["state"]> = {},
): GamePlayer {
  return {
    id,
    catalogId: null,
    teamId,
    name: id,
    birthdate: "2000-01-01",
    positions: [{ position, proficiency: 90, isNatural: true }],
    attributes: {
      // 15축 전부를 base로 채우고, GK만 goalkeeping을 따로 준다
      ...(Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, base])) as AxisValues),
      goalkeeping: group === "GK" ? base : 22,
      overall: base,
      potential: Math.min(99, base + 5),
      ...overrides,
    },
    state: { form: 0, condition: 75, ...state },
    isCaptain: false,
  };
}

/** 4-4-2 구성 스쿼드 — 선발 11 + 벤치 4. id는 기존 테스트 관례 유지 */
const SQUAD: Array<[slug: string, position: string, group: PositionGroup]> = [
  ["gk", "GK", "GK"],
  ["df1", "RB", "DF"],
  ["df2", "RCB", "DF"],
  ["df3", "LCB", "DF"],
  ["df4", "LB", "DF"],
  ["mf1", "RM", "MF"],
  ["mf2", "RCM", "MF"],
  ["mf3", "LCM", "MF"],
  ["mf4", "LM", "MF"],
  ["fw1", "ST", "FW"],
  ["fw2", "ST", "FW"],
];
const BENCH: Array<[slug: string, position: string, group: PositionGroup]> = [
  ["sub-gk", "GK", "GK"],
  ["sub-df", "CB", "DF"],
  ["sub-mf", "CM", "MF"],
  ["sub-fw", "ST", "FW"],
];

export interface TestSquad {
  teamId: string;
  starters: GamePlayer[];
  bench: GamePlayer[];
}

export function makeSquad(
  teamId: string,
  base: number,
  stateOverride: Partial<GamePlayer["state"]> = {},
): TestSquad {
  const starters = SQUAD.map(([slug, pos, group]) =>
    makePlayer(`${teamId}-${slug}`, teamId, pos, group, base, {}, stateOverride),
  );
  const bench = BENCH.map(([slug, pos, group]) =>
    makePlayer(`${teamId}-${slug}`, teamId, pos, group, base - 5, {}, stateOverride),
  );
  return { teamId, starters, bench };
}

const slotsOf = (players: GamePlayer[], familiarity = 99): LineupSlot[] =>
  players.map((p) => ({
    player: p,
    position: p.positions[0]!.position,
    proficiency: p.positions[0]!.proficiency,
    familiarity,
  }));

/** 전력 패킷 입력 — 배치 슬롯으로 조립 */
export function makeSide(
  teamId: string,
  base: number,
  opts: {
    managerTactics?: number;
    tactics?: Partial<TacticsSpec>;
    state?: Partial<GamePlayer["state"]>;
    /** 전술 적응도 0~100 — 선발 전원에 같은 값을 넣는다 (기본 99) */
    familiarity?: number;
  } = {},
): SideInput {
  const squad = makeSquad(teamId, base, opts.state ?? {});
  return {
    teamId,
    teamName: teamId.toUpperCase(),
    starters: slotsOf(squad.starters, opts.familiarity),
    bench: slotsOf(squad.bench, opts.familiarity),
    tactics: { ...DEFAULT_TACTICS, ...(opts.tactics ?? {}) },
    managerTactics: opts.managerTactics ?? 60,
  };
}

/** 장부 시작 명단 */
export function makeLedgerSide(squad: TestSquad): LedgerSide {
  return {
    onPitch: squad.starters.map((p) => p.id),
    bench: squad.bench.map((p) => p.id),
  };
}

export const tactics = (over: Partial<TacticsSpec> = {}): TacticsSpec => ({
  ...DEFAULT_TACTICS,
  ...over,
});
