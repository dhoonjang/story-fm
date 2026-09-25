import { z } from "zod";
import type { MatchEvent, MatchSide, PlayPhase, ShotOrigin } from "./match";

/**
 * 실시간 경기의 상태 — **말 22개와 공** (live-match.md).
 *
 * 클라이언트가 굴리고 서버가 같은 함수로 재실행해 검증하므로(§8) 여기 든 값은 전부
 * 직렬화 가능한 순수 데이터다. 세이브의 `pendingMatch.live`는 마지막으로 **확정된**
 * 상태이고, 그 뒤의 틱은 입력 로그에서 다시 굴린다.
 */

/** 틱 하나의 경기 시간 (초) — 이동·비행·경합의 눈금 */
export const LIVE_STEP = 0.05;

/** 경기장 — 실물 규격 (m). 홈은 +x로 공격한다 */
export const FIELD = {
  length: 105,
  width: 68,
  goalWidth: 7.32,
  goalHeight: 2.44,
  boxDepth: 16.5,
  boxHalfWidth: 20.16,
  sixYardDepth: 5.5,
  penaltySpot: 11,
} as const;

export interface FieldPoint {
  x: number;
  y: number;
}

/** 말이 지금 무엇을 하고 있는가 — 화면이 자세를 고르고 원인이 사슬을 잇는 데 쓴다 */
export const LIVE_ACTIONS = [
  "shape",
  "press",
  "mark",
  "cover",
  "support",
  "run",
  "hold",
  "carry",
  "chase",
  "sweep",
] as const;
export type LiveAction = (typeof LIVE_ACTIONS)[number];

/**
 * 판독기가 말 하나에 주는 개인 지시 — 시트의 `behavior` 줄이 싣는 것 (live-match.md §6.2).
 * 코어가 실재를 검증한 뒤 그 말의 자리 규칙을 덮는다.
 */
export const LIVE_BEHAVIOR_ACTIONS = ["press", "mark", "cover", "support", "run", "hold"] as const;
export const LiveBehaviorActionSchema = z.enum(LIVE_BEHAVIOR_ACTIONS);
export type LiveBehaviorAction = z.infer<typeof LiveBehaviorActionSchema>;

export const LIVE_BEHAVIOR_WHEN = ["attack", "defend", "always"] as const;
export const LiveBehaviorWhenSchema = z.enum(LIVE_BEHAVIOR_WHEN);
export type LiveBehaviorWhen = z.infer<typeof LiveBehaviorWhenSchema>;

export const LIVE_LANES = ["left", "center", "right"] as const;
export const LiveLaneSchema = z.enum(LIVE_LANES);
export type LiveLane = z.infer<typeof LiveLaneSchema>;

export const LIVE_BANDS = ["defense", "midfield", "attack"] as const;
export const LiveBandSchema = z.enum(LIVE_BANDS);
export type LiveBand = z.infer<typeof LiveBandSchema>;

export interface LiveBehavior {
  player: string;
  action: LiveBehaviorAction;
  when: LiveBehaviorWhen;
  targetPlayer?: string;
  lane?: LiveLane;
  band?: LiveBand;
}

/** 속도 구간별 누적 — 부하의 원본이다 (live-match.md §7) */
export interface LiveLoad {
  /** 총 거리 (m) */
  distance: number;
  /** 고속 주행 19.8~25.2 km/h (m) */
  highSpeed: number;
  /** 스프린트 >25.2 km/h (m) */
  sprint: number;
  /** 스프린트 횟수 — 구간에 진입할 때마다 하나 */
  sprints: number;
}

export interface LivePlayer extends FieldPoint {
  id: string;
  side: MatchSide;
  vx: number;
  vy: number;
  action: LiveAction;
  /** 지금 향하는 지점 */
  target: FieldPoint;
  /** 다음 판단 시각 (tick) */
  decideAt: number;
  /** 공을 받은 뒤 다시 찰 수 있는 시각 (tick) — 첫 터치·침착성이 정한다 */
  readyAt: number;
  /** 경기 체력 0~100 — 부하가 줄인다. 킥오프 값은 저장된 체력(원정은 감점) */
  condition: number;
  /** 순간 여력 0~1 — 반복 스프린트의 단기 연료 */
  fuel: number;
  load: LiveLoad;
  /** 지금 스프린트 구간 안에 있는가 — 횟수를 세는 표식 */
  sprinting: boolean;
}

export interface BallFlight {
  kind: "pass" | "shot" | "cross" | "clearance";
  from: string;
  side: MatchSide;
  to: FieldPoint;
  /** 받으라고 보낸 말 — 패스·크로스에만 */
  receiver?: string;
  /** 찬 순간 받는 말이 오프사이드였나 */
  offside?: boolean;
  speed: number;
  travelled: number;
  distance: number;
  /** 정점 높이 (m) — 0이면 땅볼 */
  height: number;
  xg?: number;
  probability?: number;
  assist?: string;
  origin?: ShotOrigin;
}

export interface LiveBall extends FieldPoint {
  z: number;
  owner: string | null;
  flight: BallFlight | null;
}

export const LIVE_RESTARTS = [
  "kickoff",
  "goal_kick",
  "throw_in",
  "corner",
  "free_kick",
  "penalty",
] as const;
export type LiveRestartKind = (typeof LIVE_RESTARTS)[number];

export interface LiveRestart {
  kind: LiveRestartKind;
  side: MatchSide;
  at: FieldPoint;
  /** 이 tick까지 공이 멈춘다 — 재시작의 죽은 시간 */
  untilTick: number;
}

/** 팀이 지금 있는 국면 (live-match.md §3.1) */
export const LIVE_PHASES = [
  "build_up",
  "progression",
  "final_third",
  "organised_defence",
  "attacking_transition",
  "defensive_transition",
  "set_piece",
] as const;
export type LivePhase = (typeof LIVE_PHASES)[number];

export interface LiveHalfClock {
  /** 이 하프에 센 중단 — 추가시간의 원본 */
  stoppages: number;
  /** 확정된 추가시간 (초) — 하프가 끝날 때 적힌다 */
  added: number | null;
}

export interface LiveMatchState {
  version: 2;
  tick: number;
  /** 경기 시계 (초) — 규정분 + 추가시간이 이어진다 */
  seconds: number;
  phase: PlayPhase;
  /** 이 하프의 중단 셈 — 하프마다 새로 센다 */
  half: LiveHalfClock;
  players: LivePlayer[];
  ball: LiveBall;
  /** 지금 공을 안정적으로 가진 편 */
  possession: MatchSide;
  /** 공이 편을 넘어간 시각 (tick) — 전환 국면의 시작 */
  possessionSince: number;
  /** 지난 패스 — 도움의 근거 */
  lastPass: { from: string; to: string; tick: number } | null;
  /** 공을 잃은 자리 — `high_turnover`의 근거 */
  lastTurnover: { by: string; side: MatchSide; tick: number; at: FieldPoint } | null;
  restart: LiveRestart | null;
  setPiece: { origin: ShotOrigin; untilTick: number; side: MatchSide } | null;
  /** 휴식 중 — 하프타임·연장 개시. 감독이 재개한다 */
  interval: boolean;
  /** 편마다 공을 가졌던 시간 (초) — 점유율의 원본 */
  possessionTime: Record<MatchSide, number>;
  /** 편마다 마지막 슈팅 시각 (초) — 공을 돌리는 상대를 벤치가 알아보는 근거 */
  lastShotAt: Record<MatchSide, number>;
  /** 이 하프에 킥오프하는 편 */
  kickoffSide: MatchSide;
  /** 벤치의 다음 판단 시각 (초) */
  bench: {
    nextShiftAt: number;
    nextSubAt: number;
    /** 공을 돌리는 상대에게 압박으로 답한 시각 — 한 번 답하면 다시 세운다 */
    stallCheckedAt: number;
  };
}

/**
 * 화면이 받는 프레임 — 위치와 공만. 숨은 능력치·전술 파라미터는 경계를 넘지 않는다.
 */
export interface LiveMatchFrame {
  matchId: string;
  tick: number;
  seconds: number;
  players: Array<Pick<LivePlayer, "id" | "side" | "x" | "y" | "vx" | "vy" | "action">>;
  ball: FieldPoint & { z: number };
  score: { home: number; away: number };
  interval: boolean;
  finished: boolean;
  events: MatchEvent[];
}

/** 체크포인트 간격 (경기 시간 분) — 정지점이 없어도 이만큼 굴리면 확정한다 */
export const CHECKPOINT_MAX_MINUTES = 5;
/** 체크포인트 간격 (틱) */
export const CHECKPOINT_TICKS = Math.round((CHECKPOINT_MAX_MINUTES * 60) / LIVE_STEP);

/**
 * **정지점** — 이 사건이 나오면 실행기가 그 자리에서 체크포인트를 내고, 확정되면 시계를 잡고
 * 정지점 턴(`match_stop`)을 연다. 판독기가 판을 다시 읽고 매치 GM이 그 사건을 중계한다
 * (live-match.md §8.3). 종료 휘슬의 정지점 턴이 마감이다.
 */
export const STOP_EVENT_TYPES: ReadonlySet<string> = new Set([
  "goal",
  "yellow_card",
  "red_card",
  "injury",
  "substitution",
  "tactical_shift",
  "half_time",
  "extra_time_start",
  "extra_half_time",
  "full_time",
]);

/** 휴식을 여는 정지점 — 판독은 라커룸의 것이다 */
export const BREAK_EVENT_TYPES: ReadonlySet<string> = new Set([
  "half_time",
  "extra_time_start",
  "extra_half_time",
]);
