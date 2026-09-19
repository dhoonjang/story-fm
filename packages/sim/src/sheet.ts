import type { MatchSide, PacketTag, Point, RouteFocus, SheetLine } from "@story-fm/domain";
import {
  anchorOf,
  otherSide,
  positionGroupOf,
  positionGroupOfPlayer,
  RATING_MAX,
  sheetLineBenefits,
} from "@story-fm/domain";
import type { LineupSlot } from "./strength-packet";
import {
  addFocused,
  addLaneShift,
  laneOfX,
  zeroCells,
  type GridBand,
  type GridLane,
  type LaneCells,
} from "./zone-grid";

/**
 * 시트 — **판독의 수치 독해가 코어의 손잡이에 닿는 자리** (match.md §1.6).
 *
 * 판독기(agents `match-reader.ts`)는 누구를·어느 칸을·어느 쪽으로·얼마나(step)만
 * 고른다. 여기서 하는 것은 그 나머지 전부다 — 실재 확인, 한도와 예산, 대가, 소화율.
 * 모양 넷은 전부 이미 있는 손잡이다: `edge`는 칸의 전력(`LaneCells`), `temper`는
 * 카드·파울 가중(`bookingWeight`), `legs`는 체력 소모(`conditionDrain`), `cohesion`은
 * 지시 적용률(`uptake`).
 *
 * **능력은 다시 곱하지 않는다.** 판독기가 진짜 능력치를 보고 step을 골랐으므로 코어가
 * 소화력이나 듀얼로 이득을 또 깎으면 같은 능력 차를 두 번 센다.
 */

/** 판독기가 드는 전술 포인트 줄 수의 상한 */
export const POINTS_MAX = 8;

/**
 * 감독의 분석이 GM에게 넘기는 포인트 줄 수 — `clamp(round(1 + 분석/99 × 7), 1, 8)`
 * (career.md §2). 30이면 3줄, 85면 7줄. 중요한 줄부터 넘어가므로 눈이 어두워도 큰
 * 판독은 닿는다.
 */
export function pointsSeen(analysis: number): number {
  return Math.max(
    1,
    Math.min(POINTS_MAX, Math.round(1 + (analysis / RATING_MAX) * (POINTS_MAX - 1))),
  );
}

/**
 * 감독의 분석이 허락한 포인트 — 중요도 높은 줄부터 `pointsSeen`만큼.
 * 중요도가 같으면 판독기가 쓴 순서다 — 안개는 여기 하나에만 걸린다 (match.md §1.6).
 */
export function readPoints(points: readonly Point[], analysis: number): Point[] {
  return [...points].sort((a, b) => b.importance - a.importance).slice(0, pointsSeen(analysis));
}

// ── 밸런스 손잡이 — ⚠️ 전부 존 전력 대비 비율이다 (match.md §6의 표) ──────────

/** `edge` 한 step이 그 칸에 얹는 폭 — 상성 이득(2.5~8%)과 같은 대역 */
export const SHEET_STEP = [0.012, 0.024, 0.035] as const;
/** 표적 하나가 받는 `edge`의 상한 — step 3 하나와 같다 */
export const SHEET_TARGET_CAP = 0.035;
/** 한 팀의 `edge` 절대값 합의 상한 */
export const SHEET_TEAM_BUDGET = 0.08;
/**
 * 한 팀의 `edge` 부호 합의 위끝 — **이득만 있는 시트는 없다.** 마킹은 마커의 본업을
 * 비우고 오버랩은 뒤를 연다 — 판독기가 대가 줄을 함께 쓰지 않으면 이득 줄이 여기서 잘린다.
 */
export const SHEET_NET_CAP = 0.024;
/**
 * 밴드별로 `edge +`가 공격 배분을 그 레인으로 끌어오는 세기 × step × 소화율.
 * 우리 진영의 `edge`는 배분을 옮기지 않는다 — 뒷선을 두껍게 하는 것은 우리 슈팅의 일이 아니다.
 */
export const SHEET_ROUTE_FOCUS: Record<GridBand, number> = { attack: 1, midfield: 0.5, defense: 0 };
/** `temper`가 카드·파울 가중에 거는 밑 — `1.3^(±step)` */
export const SHEET_TEMPER_STEP = 1.3;
/** `legs`가 체력 소모에 거는 밑 — `1.1^(±step)` */
export const SHEET_LEGS_STEP = 1.1;
/** `cohesion` 한 step이 소화율에 더하는 몫 */
export const SHEET_COHESION_STEP = 0.04;
/** 결속이 깎아 내릴 수 있는 소화율의 바닥 — 말이 아예 안 통하는 팀은 없다 */
const COHESION_UPTAKE_MIN = 0.3;

/** 시트 줄이 닿지 못한 까닭 — 노트의 코드가 그대로 이 낱말이다 (`SHEET_DROPPED_KO`) */
export type SheetDropCode =
  "no-point" | "off-pitch" | "bad-target" | "duplicate" | "target-cap" | "budget" | "net-cap";

/** 한 팀에 실린 시트의 산출 */
export interface SheetSideOutcome {
  /** 아홉 칸의 조정 — 그 팀 자신의 방향으로 적힌다. 줄 평균은 존으로, 편차는 격자로 접힌다 */
  cells: LaneCells;
  /** `edge +`가 공격 배분을 끌어오는 레인 */
  routeFocus: RouteFocus[];
  /** 선수 id → 카드·파울 가중 배수 (1은 담지 않는다) */
  temper: Record<string, number>;
  /** 선수 id → 체력 소모 배수 (1은 담지 않는다) */
  legs: Record<string, number>;
  /** 판에 닿지 못한 줄 — `tactical.notes`로 간다 */
  notes: PacketTag[];
}

export interface SheetOutcome {
  home: SheetSideOutcome;
  away: SheetSideOutcome;
  /** 걸린 줄의 태그 — `keyPoints`에 실린다. `favours`는 부호와 표적의 편에서 파생했다 */
  tags: PacketTag[];
  /** `cohesion`을 반영한 소화율 — 6축·상성·시트의 이득이 전부 이 값을 탄다 */
  uptake: { home: number; away: number };
}

/** 시트가 실릴 칸 — 밴드는 맡은 자리가, 레인은 전술판 좌표가 정한다 */
interface Cell {
  band: GridBand;
  lane?: GridLane;
}

/**
 * 배치 → 칸. 선수의 주 포지션이 아니라 **맡은 자리**가 기준이다 (`slotGroup`과 같은 규칙).
 * 레인은 실제 전술판 x가 정한다 — 좌표가 없는 배치는 그 포지션의 기본 좌표로 읽는다.
 */
function cellOfSlot(slot: LineupSlot): Required<Cell> {
  const group = positionGroupOf(slot.position) ?? positionGroupOfPlayer(slot.player);
  const band: GridBand =
    group === "FW" ? "attack" : group === "DF" || group === "GK" ? "defense" : "midfield";
  return { band, lane: laneOfX(slot.point?.x ?? anchorOf(slot.position).x) };
}

/** 줄 하나가 판에서 어디에 서는가 — 실재 확인이 끝난 뒤의 모양 */
interface Resolved {
  line: SheetLine;
  point: Point;
  side: MatchSide;
  /** `edge`의 칸 — 다른 모양에는 없다 */
  cell?: Cell;
  playerId?: string;
  /** 표적당 한도를 세는 열쇠 */
  key: string;
}

type Resolution =
  { ok: true; at: Resolved } | { ok: false; code: SheetDropCode; side: MatchSide | null };

function resolve(
  line: SheetLine,
  points: ReadonlyMap<string, Point>,
  xi: { home: readonly LineupSlot[]; away: readonly LineupSlot[] },
  seen: Set<string>,
): Resolution {
  const point = points.get(line.pointId);
  if (!point) return { ok: false, code: "no-point", side: line.target.side ?? null };
  const { target, shape } = line;
  const slotOf = (id: string): { side: MatchSide; slot: LineupSlot } | null => {
    const home = xi.home.find((s) => s.player.id === id);
    if (home) return { side: "home", slot: home };
    const away = xi.away.find((s) => s.player.id === id);
    return away ? { side: "away", slot: away } : null;
  };
  const once = (key: string, at: Omit<Resolved, "key">): Resolution => {
    if (seen.has(key)) return { ok: false, code: "duplicate", side: at.side };
    seen.add(key);
    return { ok: true, at: { ...at, key } };
  };

  if (shape === "edge") {
    if (target.player) {
      const found = slotOf(target.player);
      if (!found) return { ok: false, code: "off-pitch", side: target.side ?? null };
      return {
        ok: true,
        at: {
          line,
          point,
          side: found.side,
          cell: cellOfSlot(found.slot),
          playerId: target.player,
          key: `edge:${target.player}`,
        },
      };
    }
    if (target.side && target.band) {
      return {
        ok: true,
        at: {
          line,
          point,
          side: target.side,
          cell: { band: target.band, ...(target.lane ? { lane: target.lane } : {}) },
          key: `edge:${target.side}:${target.band}:${target.lane ?? "*"}`,
        },
      };
    }
    return { ok: false, code: "bad-target", side: target.side ?? null };
  }
  if (shape === "cohesion") {
    if (!target.side) return { ok: false, code: "bad-target", side: null };
    return once(`cohesion:${target.side}`, { line, point, side: target.side });
  }
  // temper · legs — 사람 하나
  if (!target.player) return { ok: false, code: "bad-target", side: target.side ?? null };
  const found = slotOf(target.player);
  if (!found) return { ok: false, code: "off-pitch", side: target.side ?? null };
  return once(`${shape}:${target.player}`, {
    line,
    point,
    side: found.side,
    playerId: target.player,
  });
}

/** 걸린 줄의 태그 — 코드는 모양, 문장은 포인트의 것, 편은 부호와 표적에서 (match.md §1.6) */
function sheetTag(at: Resolved): PacketTag {
  const benefits = sheetLineBenefits(at.line);
  return {
    source: "sheet",
    code: at.line.shape,
    favours: benefits ? at.side : otherSide(at.side),
    holder: at.side,
    sharp: true,
    playerIds: at.playerId ? [at.playerId] : [],
    values: { step: at.line.step, sign: at.line.sign },
    flags: [
      `point:${at.point.id}`,
      ...(at.cell ? [`band:${at.cell.band}`] : []),
      ...(at.cell?.lane ? [`lane:${at.cell.lane}`] : []),
    ],
    text: at.point.text,
  };
}

/** 닿지 못한 줄의 노트 — 조용히 버리면 걸리지 않은 지시가 걸린 줄 안다 (match.md §2) */
function droppedTag(line: SheetLine, code: SheetDropCode, point: Point | undefined): PacketTag {
  return {
    source: "sheet-dropped",
    code,
    favours: null,
    sharp: true,
    playerIds: line.target.player ? [line.target.player] : [],
    values: { step: line.step, sign: line.sign },
    flags: [`point:${line.pointId}`, `shape:${line.shape}`],
    ...(point ? { text: point.text } : {}),
  };
}

/** 시트 태그가 가리키는 포인트 id — 화면이 허락된 포인트의 줄만 세울 때 읽는다 */
export function sheetTagPointId(tag: PacketTag): string | undefined {
  const flag = tag.flags.find((f) => f.startsWith("point:"));
  return flag?.slice("point:".length);
}

const emptySide = (): SheetSideOutcome => ({
  cells: zeroCells(),
  routeFocus: [],
  temper: {},
  legs: {},
  notes: [],
});

/**
 * 시트 → 코어의 손잡이. **LLM이 고르고 코어가 값을 매긴다** (match.md §1.6).
 *
 * 순서가 뜻을 갖는다. `cohesion`이 먼저 소화율을 옮기고, 그 소화율을 `edge`의 이득이
 * 탄다. `edge`는 줄 순서대로 한도를 채우고 넘는 줄은 뒤에 온 것부터 버린다 — 표적
 * 하나 `SHEET_TARGET_CAP`, 한 팀 절대값 합 `SHEET_TEAM_BUDGET`, 한 팀 부호 합
 * `SHEET_NET_CAP`. `temper`·`legs`·`cohesion`은 표적당 한 줄이다.
 *
 * **이득에만 소화율이 걸린다** — 표적 편에 이로운 부호(`sheetLineBenefits`)만이다.
 * 대가는 판독기가 이미 그 줄에 적은 사실이라 소화하지 못한다고 비운 자리가 닫히지 않는다.
 *
 * @param uptake 시트를 반영하기 전의 소화율 — 반영한 값이 산출로 돌아간다
 */
export function applySheet(
  reading: { points: readonly Point[]; sheet: readonly SheetLine[] } | undefined,
  xi: { home: readonly LineupSlot[]; away: readonly LineupSlot[] },
  uptake: { home: number; away: number },
): SheetOutcome {
  const out: SheetOutcome = {
    home: emptySide(),
    away: emptySide(),
    tags: [],
    uptake: { ...uptake },
  };
  if (!reading || reading.sheet.length === 0) return out;

  const points = new Map(reading.points.map((p) => [p.id, p] as const));
  const seen = new Set<string>();
  const resolved: Resolved[] = [];
  for (const line of reading.sheet) {
    const res = resolve(line, points, xi, seen);
    if (res.ok) resolved.push(res.at);
    // 편을 모르는 줄(없는 선수·모양이 안 맞는 표적)은 홈의 노트에 선다 — 판독은 경기의 것이다
    else out[res.side ?? "home"].notes.push(droppedTag(line, res.code, points.get(line.pointId)));
  }

  // ① 결속 — 소화율이 먼저 선다. 시트 자신이 소화율을 타지 않는 유일한 모양이다
  for (const at of resolved) {
    if (at.line.shape !== "cohesion") continue;
    const next = out.uptake[at.side] + at.line.sign * at.line.step * SHEET_COHESION_STEP;
    out.uptake[at.side] = Math.max(COHESION_UPTAKE_MIN, Math.min(1, next));
    out.tags.push(sheetTag(at));
  }

  // ② 칸 — 한도는 소화율 전의 눈금으로 센다. 소화율은 이득의 크기이고 예산이 아니다
  const targetAbs = new Map<string, number>();
  const sideAbs: Record<MatchSide, number> = { home: 0, away: 0 };
  const sideNet: Record<MatchSide, number> = { home: 0, away: 0 };
  const EPS = 1e-9;
  for (const at of resolved) {
    if (at.line.shape !== "edge" || !at.cell) continue;
    const size = SHEET_STEP[at.line.step - 1] ?? SHEET_STEP[0];
    const signed = at.line.sign * size;
    const drop = (code: SheetDropCode) =>
      out[at.side].notes.push(droppedTag(at.line, code, at.point));
    if ((targetAbs.get(at.key) ?? 0) + size > SHEET_TARGET_CAP + EPS) {
      drop("target-cap");
      continue;
    }
    if (sideAbs[at.side] + size > SHEET_TEAM_BUDGET + EPS) {
      drop("budget");
      continue;
    }
    /**
     * **칸을 직접 겨냥한 줄은 줄 안의 재배분이다** — "왼쪽으로 몰아"는 사람을 더하는 것이
     * 아니라 옮기는 것이라 존 전력은 그대로고 배분만 기운다(`addLaneShift`). 그래서 부호
     * 합에도 들지 않는다: 팀이 얻은 것이 없다. 선수를 겨냥한 줄과 줄 전체를 겨냥한 줄은
     * 그 자리의 전력이 실제로 움직이는 것이라 평균이 존으로 간다 (match.md §1.7).
     */
    const lane = at.playerId === undefined ? at.cell.lane : undefined;
    if (lane === undefined && signed > 0 && sideNet[at.side] + signed > SHEET_NET_CAP + EPS) {
      drop("net-cap");
      continue;
    }
    targetAbs.set(at.key, (targetAbs.get(at.key) ?? 0) + size);
    sideAbs[at.side] += size;
    if (lane === undefined) sideNet[at.side] += signed;

    const digest = signed > 0 ? out.uptake[at.side] : 1;
    if (lane !== undefined) addLaneShift(out[at.side].cells, at.cell.band, lane, signed * digest);
    else addFocused(out[at.side].cells, at.cell.band, at.cell.lane, signed * digest);
    /**
     * 공을 그쪽으로 더 보내야 "그쪽을 파고들어라"가 성립한다 (match.md §1.7) —
     * 격자는 줄 합이 보존되므로 칸만 두껍게 해서는 배분이 그대로다.
     */
    const pull = SHEET_ROUTE_FOCUS[at.cell.band];
    if (signed > 0 && at.cell.lane && pull > 0) {
      const focus = out[at.side].routeFocus;
      const weight = pull * at.line.step * out.uptake[at.side];
      const had = focus.find((f) => f.lane === at.cell?.lane);
      if (had) had.weight += weight;
      else focus.push({ lane: at.cell.lane, weight });
    }
    out.tags.push(sheetTag(at));
  }

  // ③ 사람의 거칠기와 다리 — 표적당 한 줄이라 이미 `resolve`가 겹침을 걸렀다
  for (const at of resolved) {
    if ((at.line.shape !== "temper" && at.line.shape !== "legs") || !at.playerId) continue;
    const base = at.line.shape === "temper" ? SHEET_TEMPER_STEP : SHEET_LEGS_STEP;
    const digest = sheetLineBenefits(at.line) ? out.uptake[at.side] : 1;
    const scale = Math.pow(base, at.line.sign * at.line.step * digest);
    if (scale !== 1) out[at.side][at.line.shape][at.playerId] = scale;
    out.tags.push(sheetTag(at));
  }

  return out;
}
