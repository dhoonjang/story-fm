import type {
  LiveBehavior,
  LiveLane,
  MatchSide,
  Point,
  SheetLine,
  SheetShape,
} from "@story-fm/domain";
import { RATING_MAX, sheetLineBenefits } from "@story-fm/domain";

/**
 * 시트 — **판독의 수치 독해가 말의 규칙에 닿는 자리** (live-match.md §6.2).
 *
 * 판독기(agents `match-reader.ts`)는 누구를·어느 쪽으로·얼마나(step)만 고른다. 여기서
 * 하는 것은 그 나머지 전부다 — 실재 확인, 한도와 예산, 대가, 소화율. 모양 여섯은 전부
 * 말의 규칙에 이미 있는 손잡이다: `behavior`는 개인 지시, `edge`는 경기 계수, `focus`는
 * 공격 방향 선호, `temper`는 파울 확률, `legs`는 부하 배율, `cohesion`은 형태 오차.
 *
 * **능력은 다시 곱하지 않는다.** 판독기가 진짜 능력치를 보고 step을 골랐으므로 코어가
 * 소화력으로 이득을 또 깎으면 같은 능력 차를 두 번 센다. 코어에 남는 것은 한도와 대가와
 * 소화율이다.
 */

/** 판독기가 드는 전술 포인트 줄 수의 상한 */
export const POINTS_MAX = 8;

/**
 * 감독의 분석이 GM에게 넘기는 포인트 줄 수 — `clamp(round(1 + 분석/99 × 7), 1, 8)`
 * (career.md §2). 중요한 줄부터 넘어가므로 눈이 어두워도 큰 판독은 닿는다.
 */
export function pointsSeen(analysis: number): number {
  return Math.max(
    1,
    Math.min(POINTS_MAX, Math.round(1 + (analysis / RATING_MAX) * (POINTS_MAX - 1))),
  );
}

/** 감독의 분석이 허락한 포인트 — 중요도 높은 줄부터 `pointsSeen`만큼 */
export function readPoints(points: readonly Point[], analysis: number): Point[] {
  return [...points].sort((a, b) => b.importance - a.importance).slice(0, pointsSeen(analysis));
}

// ── 한도 — ⚠️ 시작값이다. `edge` 3.5%가 xG를 얼마나 움직이는지는 하네스가 잰다 ──

/** `edge` 한 step이 그 말의 경기 계수에 얹는 폭 */
export const SHEET_STEP = [0.012, 0.024, 0.035] as const;
/** 표적 하나가 받는 `edge`의 절대값 상한 */
export const SHEET_TARGET_CAP = 0.035;
/** 한 팀 `edge` 절대값 합의 상한 */
export const SHEET_TEAM_BUDGET = 0.08;
/** 한 팀 `edge` 부호 합의 상한 — 이득만 있는 시트는 없다 */
export const SHEET_NET_CAP = 0.024;
/** `focus` 한 step이 그 레인의 선택 효용에 얹는 몫 */
export const SHEET_FOCUS_STEP = 0.12;
/** `temper` 한 step — 파울 확률의 배수 */
export const SHEET_TEMPER_STEP = 1.3;
/** `legs` 한 step — 부하 배율 */
export const SHEET_LEGS_STEP = 1.1;
/** `cohesion` 한 step — 형태 오차의 배율 (+면 오차가 준다) */
export const SHEET_COHESION_STEP = 0.15;

export type SheetDropCode =
  | "no-point"
  | "no-player"
  | "wrong-side"
  | "no-side"
  | "no-lane"
  | "no-action"
  | "duplicate"
  | "target-cap"
  | "team-budget"
  | "net-cap";

export interface SheetDrop {
  line: SheetLine;
  code: SheetDropCode;
}

/** 걸린 줄 하나가 화면·중계에 서는 모양 — 문장은 포인트의 것이다 */
export interface SheetTag {
  pointId: string;
  shape: SheetShape;
  /** 이로운 편 */
  favours: MatchSide;
  playerIds: string[];
  value: number;
}

/** 말의 규칙이 읽는 것 — 시트가 접힌 결과 */
export interface LiveSheet {
  behaviors: LiveBehavior[];
  /** 선수 id → 경기 계수에 얹는 ± */
  edge: Record<string, number>;
  /** 편 → 레인 → 선택 효용에 얹는 ± */
  focus: Record<MatchSide, Record<LiveLane, number>>;
  /** 선수 id → 파울 확률 배수 */
  temper: Record<string, number>;
  /** 선수 id → 부하 배율 */
  legs: Record<string, number>;
  /** 편 → 형태 오차 배율 (1이 기본) */
  cohesion: Record<MatchSide, number>;
  applied: SheetTag[];
  dropped: SheetDrop[];
}

export interface SheetContext {
  points: readonly Point[];
  /** 지금 그라운드에 선 사람 — 편마다 */
  onPitch: Record<MatchSide, readonly string[]>;
  /** 편마다의 지시 적용률 — 이득(+)에만 곱한다 */
  uptake: Record<MatchSide, number>;
}

export function emptySheet(): LiveSheet {
  return {
    behaviors: [],
    edge: {},
    focus: { home: { left: 0, center: 0, right: 0 }, away: { left: 0, center: 0, right: 0 } },
    temper: {},
    legs: {},
    cohesion: { home: 1, away: 1 },
    applied: [],
    dropped: [],
  };
}

/**
 * 시트를 말의 규칙이 읽는 값으로 접는다 — 실재 · 한도 · 소화율.
 *
 * 걸리지 않은 줄은 `dropped`에 까닭과 함께 남는다 — 조용히 버리면 걸리지 않은 지시가
 * 걸린 줄 안다. 시트는 판독기가 매번 전체를 다시 쓰므로 선착순도 밀어내기도 없다.
 */
export function applySheet(lines: readonly SheetLine[], ctx: SheetContext): LiveSheet {
  const out = emptySheet();
  const pointIds = new Set(ctx.points.map((p) => p.id));
  const sideOf = (id: string): MatchSide | null =>
    ctx.onPitch.home.includes(id) ? "home" : ctx.onPitch.away.includes(id) ? "away" : null;
  const seen = new Set<string>();
  const drop = (line: SheetLine, code: SheetDropCode) => out.dropped.push({ line, code });
  const budget: Record<MatchSide, { abs: number; net: number }> = {
    home: { abs: 0, net: 0 },
    away: { abs: 0, net: 0 },
  };

  for (const line of lines) {
    if (!pointIds.has(line.pointId)) {
      drop(line, "no-point");
      continue;
    }
    const step = line.step;
    switch (line.shape) {
      case "behavior": {
        const player = line.target.player;
        const side = player ? sideOf(player) : null;
        if (!player || !side) {
          drop(line, "no-player");
          break;
        }
        if (!line.action) {
          drop(line, "no-action");
          break;
        }
        const key = `behavior:${player}`;
        if (seen.has(key)) {
          drop(line, "duplicate");
          break;
        }
        // 대상 선수는 실재해야 한다 — 없으면 대상 없는 지시로 건다
        const target =
          line.targetPlayer && sideOf(line.targetPlayer) ? line.targetPlayer : undefined;
        seen.add(key);
        out.behaviors.push({
          player,
          action: line.action,
          when: line.when ?? "always",
          ...(target ? { targetPlayer: target } : {}),
          ...(line.target.lane ? { lane: line.target.lane } : {}),
          ...(line.band ? { band: line.band } : {}),
        });
        out.applied.push({
          pointId: line.pointId,
          shape: "behavior",
          favours: side,
          playerIds: target ? [player, target] : [player],
          value: 1,
        });
        break;
      }
      case "edge":
      case "temper":
      case "legs": {
        const player = line.target.player;
        const side = player ? sideOf(player) : null;
        if (!player || !side) {
          drop(line, "no-player");
          break;
        }
        const key = `${line.shape}:${player}`;
        if (line.shape !== "edge" && seen.has(key)) {
          drop(line, "duplicate");
          break;
        }
        const benefits = sheetLineBenefits(line);
        const favours: MatchSide = benefits ? side : side === "home" ? "away" : "home";
        if (line.shape === "edge") {
          const raw = (SHEET_STEP[step - 1] ?? SHEET_TARGET_CAP) * line.sign;
          // 이득에는 소화율이 곱해지고 대가는 온전하다
          const scaled = raw > 0 ? raw * ctx.uptake[side] : raw;
          const current = out.edge[player] ?? 0;
          if (Math.abs(current + scaled) > SHEET_TARGET_CAP + 1e-9) {
            drop(line, "target-cap");
            break;
          }
          if (budget[side].abs + Math.abs(scaled) > SHEET_TEAM_BUDGET + 1e-9) {
            drop(line, "team-budget");
            break;
          }
          if (budget[side].net + scaled > SHEET_NET_CAP + 1e-9) {
            drop(line, "net-cap");
            break;
          }
          budget[side].abs += Math.abs(scaled);
          budget[side].net += scaled;
          out.edge[player] = round4(current + scaled);
          out.applied.push({
            pointId: line.pointId,
            shape: "edge",
            favours,
            playerIds: [player],
            value: scaled,
          });
          break;
        }
        seen.add(key);
        const base = line.shape === "temper" ? SHEET_TEMPER_STEP : SHEET_LEGS_STEP;
        const factor = powInt(base, step * line.sign);
        if (line.shape === "temper") out.temper[player] = factor;
        else out.legs[player] = factor;
        out.applied.push({
          pointId: line.pointId,
          shape: line.shape,
          favours,
          playerIds: [player],
          value: factor,
        });
        break;
      }
      case "focus": {
        const side = line.target.side;
        if (!side) {
          drop(line, "no-side");
          break;
        }
        const lane = line.target.lane;
        if (!lane) {
          drop(line, "no-lane");
          break;
        }
        const key = `focus:${side}:${lane}`;
        if (seen.has(key)) {
          drop(line, "duplicate");
          break;
        }
        seen.add(key);
        const raw = SHEET_FOCUS_STEP * step * line.sign;
        out.focus[side][lane] = round4(raw > 0 ? raw * ctx.uptake[side] : raw);
        out.applied.push({
          pointId: line.pointId,
          shape: "focus",
          favours: side,
          playerIds: [],
          value: out.focus[side][lane],
        });
        break;
      }
      case "cohesion": {
        const side = line.target.side;
        if (!side) {
          drop(line, "no-side");
          break;
        }
        const key = `cohesion:${side}`;
        if (seen.has(key)) {
          drop(line, "duplicate");
          break;
        }
        seen.add(key);
        // +면 오차가 준다 — 배율은 1 − step×0.15 (0.55까지), −면 1 + step×0.15
        const factor = 1 - SHEET_COHESION_STEP * step * line.sign;
        out.cohesion[side] = round4(Math.max(0.4, factor));
        out.applied.push({
          pointId: line.pointId,
          shape: "cohesion",
          favours: line.sign > 0 ? side : side === "home" ? "away" : "home",
          playerIds: [],
          value: out.cohesion[side],
        });
        break;
      }
    }
  }
  return out;
}

/** 정수 거듭제곱 — `**`·`Math.pow`는 실시간 경기 안에서 쓰지 않는다 (live-match.md §8.2) */
function powInt(base: number, exponent: number): number {
  let result = 1;
  const n = Math.abs(exponent);
  for (let i = 0; i < n; i++) result *= base;
  return exponent < 0 ? 1 / result : result;
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;
