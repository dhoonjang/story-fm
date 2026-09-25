import type {
  KeeperDistribution,
  TacklingLevel,
  TacticsSpec,
  TransitionMode,
} from "@story-fm/domain";
import { TACTIC_SCALE_NEUTRAL, tacticToggleValue } from "@story-fm/domain";
import {
  AMBITION_PER_MENTALITY_STEP,
  BLOCK_FOLLOW_PER_STEP,
  BLOCK_SLIDE_PER_STEP,
  COMMIT_PER_MENTALITY_STEP,
  PRESS_REACH_PER_STEP,
  SHAPE_NOISE_BASE,
  SHOT_THRESHOLD_PER_MENTALITY_STEP,
} from "./tuning";

/**
 * 전술 → 말의 파라미터 (live-match.md §6.1).
 *
 * 여섯 축과 토글 넷이 말의 규칙 어디에 닿는지가 전부 여기 한 표다. **지시 적용률**은
 * 축의 값을 중립 쪽으로 섞는다 — 반쯤만 소화한 지시는 반쯤만 걸린다.
 */
export interface TeamParams {
  /** 조직 수비의 수비 라인 높이 — 우리 골라인에서 (m) */
  lineHeight: number;
  /** 조직 수비에서 라인 사이 간격의 배율 — 작을수록 압축 */
  compactness: number;
  /** 압박을 시작하는 공의 깊이 — 우리 골라인에서 (m). 공이 이보다 멀리(상대 쪽) 있어도 압박한다 */
  pressLine: number;
  /** 압박에 나서는 반경의 배율 — 강한 압박은 더 먼 공까지 뛰어간다 */
  pressReach: number;
  /** 수비 블록이 공의 깊이를 따라 오르내리는 비 — 압박이 강하면 블록이 공을 따라 더 뛴다 */
  blockFollow: number;
  /** 수비 블록이 공 쪽으로 쏠리는 비 */
  blockSlide: number;
  /** 동시에 압박에 나서는 말의 수 */
  pressers: number;
  /** 공을 잃은 뒤 즉시 되찾으러 가는 시간 (초) */
  counterpressSeconds: number;
  /** 공을 가졌을 때 블록이 앞으로 나가는 거리 (m) */
  attackShift: number;
  /** 공격 형태의 폭 배율 */
  attackWidth: number;
  /** 수비 형태의 폭 배율 */
  defendWidth: number;
  /** 효용의 위험 회피 — 클수록 잃었을 때의 위험을 무겁게 본다 */
  riskAversion: number;
  /** 판단 간격의 배율 — 템포가 빠르면 짧다 */
  decisionPace: number;
  /** 선호하는 패스 길이 (m) */
  passLength: number;
  /** 위협 증가(전진)의 값에 거는 배율 — 멘탈리티. 공격적이면 앞으로 가는 공을 더 값지게 본다 */
  ambition: number;
  /** 전진 패스의 효용 가산 */
  directness: number;
  /** 크로스의 효용 가산 */
  crossBias: number;
  /** 슈팅을 고르는 최소 xG — `xg.ts`의 `XG_BASE`와 같은 눈금이다 */
  shotThreshold: number;
  /** 공격에 가담하는 인원의 배율 — 멘탈리티. 형태의 전진과 침투·박스 진입의 빈도가 이 배율을 탄다 */
  commit: number;
  transition: TransitionMode;
  offsideTrap: boolean;
  tackling: TacklingLevel;
  keeperDistribution: KeeperDistribution;
  /** 형태 오차 (m) — 적응도와 시트 `cohesion`이 정한다 */
  shapeNoise: number;
}

/** 축을 적용률만큼 중립 쪽으로 섞는다 */
function blend(value: number, uptake: number): number {
  return TACTIC_SCALE_NEUTRAL + (value - TACTIC_SCALE_NEUTRAL) * uptake;
}

export function teamParamsOf(spec: TacticsSpec, uptake: number, cohesion: number): TeamParams {
  const mentality = blend(spec.mentality, uptake);
  const line = blend(spec.defensiveLine, uptake);
  const pressing = blend(spec.pressing, uptake);
  const tempo = blend(spec.tempo, uptake);
  const width = blend(spec.width, uptake);
  const pass = blend(spec.passStyle, uptake);
  const transition = (tacticToggleValue(spec, "transition") ?? "none") as TransitionMode;
  const tackling = (tacticToggleValue(spec, "tackling") ?? "normal") as TacklingLevel;
  const keeper = (tacticToggleValue(spec, "keeperDistribution") ?? "none") as KeeperDistribution;
  return {
    lineHeight: 28 + (line - 3) * 5,
    compactness: 0.5 - (pressing - 3) * 0.04,
    pressLine: 48 - (pressing - 3) * 11,
    pressReach: 1 + (pressing - 3) * PRESS_REACH_PER_STEP,
    blockFollow: 0.5 + (pressing - 3) * BLOCK_FOLLOW_PER_STEP,
    blockSlide: 0.4 + (pressing - 3) * BLOCK_SLIDE_PER_STEP,
    pressers: pressing >= 4.5 ? 3 : pressing >= 2.5 ? 2 : 1,
    counterpressSeconds: pressing >= 3.5 ? 6 : pressing >= 2.5 ? 3 : 0,
    attackShift: 7 + (mentality - 3) * 3,
    attackWidth: 0.95 + (width - 3) * 0.1,
    defendWidth: 0.6 + (width - 3) * 0.03,
    riskAversion: 1 - (mentality - 3) * 0.18,
    decisionPace: 1 - (tempo - 3) * 0.1,
    passLength: 16 + (pass - 3) * 4,
    ambition: 1 + (mentality - 3) * AMBITION_PER_MENTALITY_STEP,
    directness: (pass - 3) * 0.5 + (tempo - 3) * 0.2,
    crossBias: (width - 3) * 0.25,
    shotThreshold: 0.1259 - (mentality - 3) * SHOT_THRESHOLD_PER_MENTALITY_STEP,
    commit: 1 + (mentality - 3) * COMMIT_PER_MENTALITY_STEP,
    transition,
    offsideTrap: spec.offsideTrap === true,
    tackling,
    keeperDistribution: keeper,
    shapeNoise: SHAPE_NOISE_BASE * (1 + (1 - uptake) * 1.5) * cohesion,
  };
}
