import type {
  AxisValues,
  GamePlayer,
  PlayerAttributes,
  PositionGroup,
  TacticsSpec,
} from "@story-fm/domain";
import { ATTRIBUTE_AXES, DEFAULT_TACTICS } from "@story-fm/domain";
import type { LiveSlot } from "@story-fm/domain";
import {
  createLedger,
  createLiveMatch,
  type LedgerSide,
  type LiveMatch,
  type LiveSetup,
} from "@story-fm/sim";

/** 테스트용 선수 — 16축 전부 보유, positions[], 부상은 상태에 없음 */
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
    squadLevel: "first",
    name: id,
    birthdate: "2000-01-01",
    positions: [{ position, proficiency: 90, isNatural: true }],
    attributes: {
      // 16축 전부를 base로 채우고, GK만 goalkeeping을 따로 준다
      ...(Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, base])) as AxisValues),
      goalkeeping: group === "GK" ? base : 22,
      overall: base,
      potential: Math.min(99, base + 5),
      ...overrides,
    },
    state: {
      form: 0,
      condition: 75,
      injuryProneness: 1,
      talkMorale: [],
      outOfPositionRun: 0,
      fatigue: 0,
      caps: 0,
      internationalGoals: 0,
      ...state,
    },
    isCaptain: false,
    isViceCaptain: false,
    growthCarry: {},
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

/** 실시간 경기 한 편의 자리 — 배치 슬롯을 id로 */
export function makeLiveSlots(players: GamePlayer[], familiarity = 99): LiveSlot[] {
  return players.map((p) => ({
    playerId: p.id,
    position: p.positions[0]!.position,
    proficiency: p.positions[0]!.proficiency,
    familiarity,
  }));
}

export interface LiveTestOptions {
  seed?: number;
  home?: { base?: number; tactics?: Partial<TacticsSpec>; state?: Partial<GamePlayer["state"]> };
  away?: { base?: number; tactics?: Partial<TacticsSpec>; state?: Partial<GamePlayer["state"]> };
  friendly?: boolean;
  extraTime?: { home: number; away: number } | null;
  ai?: { home?: boolean; away?: boolean };
}

/** 실시간 경기 묶음 — 두 스쿼드를 세우고 킥오프 상태까지 */
export function makeLiveMatch(opts: LiveTestOptions = {}): LiveMatch {
  const home = makeSquad("home", opts.home?.base ?? 70, opts.home?.state ?? {});
  const away = makeSquad("away", opts.away?.base ?? 70, opts.away?.state ?? {});
  const players: Record<string, GamePlayer> = {};
  for (const p of [...home.starters, ...home.bench, ...away.starters, ...away.bench])
    players[p.id] = p;
  const homeTactics = { ...DEFAULT_TACTICS, ...(opts.home?.tactics ?? {}) };
  const awayTactics = { ...DEFAULT_TACTICS, ...(opts.away?.tactics ?? {}) };
  const setup: LiveSetup = {
    seed: opts.seed ?? 42,
    matchId: "m-test-1",
    friendly: opts.friendly ?? false,
    extraTime: opts.extraTime ?? null,
    sides: {
      home: {
        teamId: "home",
        ai: opts.ai?.home ?? true,
        managerTactics: 65,
        kickoffTactics: homeTactics,
        derbyHeat: 0,
      },
      away: {
        teamId: "away",
        ai: opts.ai?.away ?? true,
        managerTactics: 65,
        kickoffTactics: awayTactics,
        derbyHeat: 0,
      },
    },
    players,
    proneness: {},
  };
  const ledger = createLedger(makeLedgerSide(home), makeLedgerSide(away), {
    friendly: setup.friendly,
  });
  return createLiveMatch(
    setup,
    ledger,
    { home: makeLiveSlots(home.starters), away: makeLiveSlots(away.starters) },
    { home: homeTactics, away: awayTactics },
    { points: [], sheet: [] },
  );
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
