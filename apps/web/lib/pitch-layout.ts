import { PITCH_BANDS, type BoardPoint } from "@story-fm/domain";

/**
 * 전술판 배치 → **경기장 위의 자리.**
 *
 * 전술판은 두 팀이 각자 자기 골문을 아래(y=100)에 두고 보는 판이다. 경기장은 그
 * 둘을 마주 붙인 것이라 홈은 왼쪽에서 오른쪽으로, 원정은 그 거울로 눕는다.
 *
 * ## 왜 그냥 절반으로 누르지 않나
 *
 * 자기 진영 절반(0~50%)에 통째로 압축하면 **공격수가 중앙선을 못 넘는다.**
 * 판세 격자는 상대 진영을 오른쪽 1/3로 잡는데 최전방이 45%에 서니, 밀리는 칸과
 * 거기 선 선수가 다른 자리에 그려졌다. 그래서 전선 경계(`PITCH_BANDS.edge`)를
 * 격자와 **같은 값으로** 두고 구간마다 나눠 편다 — 공격수는 상대 진영 칸에,
 * 미드필더는 중원 칸에 앉는다.
 */

export interface PitchPoint {
  /** 왼쪽에서의 거리 % — 0이 홈 골문, 100이 원정 골문 */
  left: number;
  /** 위에서의 거리 % */
  top: number;
}

/** 화면 비율 탓에 가로·세로의 1%가 서로 다른 길이다 — 겹침도 그만큼 다르게 잰다 */
const MIN_GAP = { x: 3.4, y: 8 };
/** 밀어내기 횟수 — 스물두 명이면 서너 번에 잦아든다 */
const SPREAD_PASSES = 14;

/** 셋으로 끊긴 구간을 화면 1/3씩에 편다 */
function bandedLeft(y: number): number {
  const { defenseMid, midAttack } = PITCH_BANDS.edge;
  if (y >= defenseMid) return ((100 - y) / (100 - defenseMid)) * (100 / 3);
  if (y >= midAttack) return 100 / 3 + ((defenseMid - y) / (defenseMid - midAttack)) * (100 / 3);
  return 200 / 3 + ((midAttack - y) / midAttack) * (100 / 3);
}

/** 마커가 경기장 밖으로 잘리지 않게 안쪽으로 들이는 여백(%) */
const INSET = { x: 3.5, y: 7 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 전술판 한 점 → 경기장 한 점. 원정은 좌우·상하가 모두 뒤집힌 거울이다 */
export function pitchPointOf(point: BoardPoint, side: "home" | "away"): PitchPoint {
  const along = bandedLeft(point.y);
  const left = side === "home" ? along : 100 - along;
  const top = side === "home" ? point.x : 100 - point.x;
  return {
    left: clamp(left, INSET.x, 100 - INSET.x),
    top: clamp(top, INSET.y, 100 - INSET.y),
  };
}

/**
 * 겹친 마커를 밀어낸다 — **상대 선수와도 겹치지 않게** 스물두 개를 한 번에 본다.
 *
 * 서로 반대 방향으로 절반씩 물러나되, 미는 방향은 **덜 움직여도 되는 축**을
 * 고른다(전술판의 `separateBoardPoints`와 같은 원리). 그래야 배치의 모양이
 * 덜 망가진다. 어느 쪽도 자기 전선 밖으로는 나가지 않는다.
 */
export function spreadMarkers(points: readonly PitchPoint[]): PitchPoint[] {
  const out = points.map((p) => ({ ...p }));
  for (let pass = 0; pass < SPREAD_PASSES; pass++) {
    let moved = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!;
        const b = out[j]!;
        const overlapX = MIN_GAP.x - Math.abs(b.left - a.left);
        const overlapY = MIN_GAP.y - Math.abs(b.top - a.top);
        if (overlapX <= 0 || overlapY <= 0) continue;
        moved = true;
        // 겹친 비율이 작은 축으로 민다 — 적게 움직여야 모양이 남는다
        if (overlapX / MIN_GAP.x <= overlapY / MIN_GAP.y) {
          const push = (overlapX / 2 + 0.05) * (a.left <= b.left ? -1 : 1);
          a.left = clamp(a.left + push, INSET.x, 100 - INSET.x);
          b.left = clamp(b.left - push, INSET.x, 100 - INSET.x);
        } else {
          const push = (overlapY / 2 + 0.05) * (a.top <= b.top ? -1 : 1);
          a.top = clamp(a.top + push, INSET.y, 100 - INSET.y);
          b.top = clamp(b.top - push, INSET.y, 100 - INSET.y);
        }
      }
    }
    if (!moved) break;
  }
  return out;
}
