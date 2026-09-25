import type {
  AttributeAxis,
  BoardPoint,
  Player,
  PlayerAttributes,
  TacticsSpec,
} from "@story-fm/domain";
import {
  ADAPTATION_IMPACT,
  FAMILIARITY_MAX,
  RATING_MAX,
  proficiencyReadiness,
  tacticToggleValue,
  tacticalSensitivityOf,
} from "@story-fm/domain";
import { stateModifier } from "./state-modifier";

/**
 * 선수의 경기 능력 — **오늘 이 자리에서의 능력치** (match.md §2 · live-match.md §2).
 *
 * 실시간 경기의 말과 간이 시뮬의 팀 평점이 같은 함수를 지난다 — 계수가 두 벌이면
 * 감독의 경기와 리그의 나머지가 다른 눈금으로 같은 선수를 읽는다.
 */

/** 경기 명단 한 자리 — 선수와 그가 맡은 자리·역할·적응도 */
export interface LineupSlot {
  player: Player;
  /** 이 경기에서 맡는 포지션 (주 포지션과 다를 수 있다) */
  position: string;
  /** 프리셋이 아닌 실제 전술판 좌표 */
  point?: BoardPoint;
  /** 실제 세부 역할 — 없으면 그 자리 기본 역할 */
  roleId?: string;
  /** 그 포지션 적응도 0~99 — 낯선 자리면 기여가 깎인다 */
  proficiency: number;
  /**
   * 이 선수의 **전술 적응도** 0~100 (`TACTIC_ASSIGNMENT.familiarity`). 팀 평균이 아니라
   * 개인 값이다 — 어제 영입한 선수와 3년 뛴 선수가 같은 전술을 같은 정도로 소화할 리 없다.
   */
  familiarity: number;
}

/** 포지션 적응도 계수 0.10~1.00 — 정규화한 log1p (player.md §8) */
export function profFactor(proficiency: number): number {
  return proficiencyReadiness(proficiency);
}

/** 전술 적응도의 기본 감점 폭 — 자리 민감도가 이 폭을 키우거나 줄인다 */
const FAMILIARITY_SPREAD = ADAPTATION_IMPACT.tactical;

/**
 * 전술 적응도 계수 — 개인 값에 **자리 민감도**를 곱한다 (player.md §7).
 * 중원은 크게 최전방은 작게 깎인다 — 판을 몸으로 기억하는 것이라 같은 어긋남도 자리마다
 * 대가가 다르다.
 */
export function famFactor(familiarity: number, position: string): number {
  const gap = 1 - Math.min(1, Math.max(0, familiarity) / FAMILIARITY_MAX);
  return 1 - gap * FAMILIARITY_SPREAD * tacticalSensitivityOf(position);
}

/**
 * 경기 계수 — 상태(폼·체력) × 포지션 적응도 × 전술 적응도 × (1 + 시트 edge).
 *
 * `condition`은 **지금** 체력이다. 실시간 경기는 말의 경기 체력을, 간이 시뮬은 킥오프
 * 체력을 넘긴다. `edge`는 판독기가 준 이번 경기의 실행 품질(sim `sheet.ts`)이고 없으면 0.
 */
export function matchFactor(
  slot: Pick<LineupSlot, "player" | "position" | "proficiency" | "familiarity">,
  condition: number = slot.player.state.condition,
  edge = 0,
): number {
  return (
    stateModifier({ ...slot.player.state, condition }) *
    profFactor(slot.proficiency) *
    famFactor(slot.familiarity, slot.position) *
    (1 + edge)
  );
}

/** 경기 능력치 — 저장된 축 값에 경기 계수를 곱한 값. 판정마다 그 판정의 축을 읽는다 */
export function matchAttribute(
  attributes: PlayerAttributes,
  axis: AttributeAxis,
  factor: number,
): number {
  return Math.min(RATING_MAX * 1.1, attributes[axis] * factor);
}

// ── 지시 적용률 ─────────────────────────────────────────────────────────────

/** 감독 전술 0 · 팀 적응도 0에서의 적용률 */
const UPTAKE_FLOOR = 0.45;
/** 감독 전술 축(0~99)이 채우는 몫 */
const UPTAKE_TACTICS_SPAN = 0.35;
/** 팀 평균 전술 적응도(0~100)가 채우는 몫 */
const UPTAKE_FAMILIARITY_SPAN = 0.2;

/**
 * 지시 적용률 0.45~1.0 — 열한 명이 함께 소화하므로 팀 값이다 (match.md §2).
 * 낮으면 말의 전술 파라미터가 기본값 쪽으로 섞이고 형태 오차가 커진다.
 */
export function instructionUptake(managerTactics: number, squadFamiliarity: number): number {
  const fam = Math.max(0, Math.min(1, squadFamiliarity / FAMILIARITY_MAX));
  return round2(
    UPTAKE_FLOOR +
      UPTAKE_TACTICS_SPAN * (managerTactics / RATING_MAX) +
      UPTAKE_FAMILIARITY_SPAN * fam,
  );
}

/** 선발 열한 명의 전술 적응도 평균 — 적용률의 입력 */
export function squadFamiliarityOf(slots: readonly Pick<LineupSlot, "familiarity">[]): number {
  if (slots.length === 0) return FAMILIARITY_MAX;
  return slots.reduce((sum, s) => sum + s.familiarity, 0) / slots.length;
}

// ── 경기 강도 ───────────────────────────────────────────────────────────────

/** 압박 한 칸이 강도에 얹는 몫 */
const PRESSING_INTENSITY_STEP = 0.07;
/** 템포 한 칸이 강도에 얹는 몫 */
const TEMPO_INTENSITY_STEP = 0.04;
/** 태클 강도 갈래가 강도에 얹는 몫 */
export const TACKLING_INTENSITY_STEP = 0.08;
/** 더비 열기 한 단계가 곱하는 몫 (team.md §7) */
export const DERBY_INTENSITY_STEP = 0.06;
const INTENSITY_MIN = 0.7;
const INTENSITY_MAX = 1.3;

/** 더비가 양 팀에 곱하는 배수 — heat 0이면 1 */
export function derbyIntensityFactor(heat: number): number {
  return 1 + DERBY_INTENSITY_STEP * Math.max(0, heat);
}

/**
 * 경기 강도 0.70~1.30 × 더비 — 파울·카드·부상의 총량에 곱해진다 (match.md §4.1).
 * 압박·템포·태클 강도가 축이고 셋을 합친 폭이 clamp와 같아 잘리는 구간이 없다.
 */
export function matchIntensity(spec: TacticsSpec, derbyHeat = 0): number {
  const tackling = tacticToggleValue(spec, "tackling");
  const bite = tackling === "hard" ? 1 : tackling === "soft" ? -1 : 0;
  const tactical = Math.max(
    INTENSITY_MIN,
    Math.min(
      INTENSITY_MAX,
      1 +
        (spec.pressing - 3) * PRESSING_INTENSITY_STEP +
        (spec.tempo - 3) * TEMPO_INTENSITY_STEP +
        bite * TACKLING_INTENSITY_STEP,
    ),
  );
  return round2(tactical * derbyIntensityFactor(derbyHeat));
}

const round2 = (v: number) => Math.round(v * 100) / 100;
