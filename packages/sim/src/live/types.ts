import type {
  LiveMatchState,
  MatchEvent,
  MatchSide,
  MatchStatLine,
  Player,
  SetPieceRoutine,
  SetPieceTakers,
  TacticsSpec,
} from "@story-fm/domain";
import type { LineupSlot } from "../match-ability";
import type { LiveSheet } from "../sheet";

/** 한 편이 한 틱에 말의 규칙에 주는 것 */
export interface LiveSideInput {
  teamId: string;
  /** 지금 그라운드에 선 열한(또는 그보다 적은) 자리 */
  slots: readonly LineupSlot[];
  tactics: TacticsSpec;
  /** 지시 적용률 0.45~1 (match.md §2) */
  uptake: number;
  /** 경기 강도 — 파울·부상의 빈도에 곱한다 */
  intensity: number;
  setPieceTakers?: SetPieceTakers;
  setPieceRoutine?: SetPieceRoutine;
}

/** 한 틱의 입력 — 전부 순수 데이터라 클라이언트와 서버가 같은 것을 만든다 */
export interface LiveInput {
  seed: number;
  matchId: string;
  home: LiveSideInput;
  away: LiveSideInput;
  players: ReadonlyMap<string, Player>;
  sheet: LiveSheet;
  /** 선수 id → 지금까지의 경고 수 */
  yellows: Readonly<Record<string, number>>;
  /** 쓰러졌는데 아직 그라운드에 있는 말 — 느리게 뛴다 */
  injured: ReadonlySet<string>;
  /** 선수 id → 부상 성향 배수 */
  proneness: Readonly<Record<string, number>>;
}

export interface LiveStepResult {
  state: LiveMatchState;
  events: MatchEvent[];
  /** 이 틱의 증가분 — 장부의 `stats`에 더한다 */
  stats: Record<string, MatchStatLine>;
}

export function sideInputOf(input: LiveInput, side: MatchSide): LiveSideInput {
  return side === "home" ? input.home : input.away;
}
