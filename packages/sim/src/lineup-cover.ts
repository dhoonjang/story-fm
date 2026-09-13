import type { LineupSlot } from "./strength-packet";
import { anchorOf, PITCH_BANDS, pitchLines, type BoardPoint } from "@story-fm/domain";
import { GRID_BANDS, GRID_LANES, LANE_REACH, LANE_X, type GridBand } from "./zone-grid";

/**
 * **무너진 줄은 펴서 세운다** — 킥오프 직전의 마지막 손질 (match.md §1.7).
 *
 * 전술판은 감독의 것이고 좌표는 자유다. 그런데 자리를 **이름으로** 지시하는 길
 * (채팅 · 해석기 · 라인업 화면)은 그 자리의 기본 좌표를 그대로 준다
 * (`anchorOf` — `engine/commands/lineup.ts`의 `candidatePoint`). 두 선수에게 같은
 * 자리를 주면 **둘이 정확히 겹쳐 서고** 반대쪽 레인은 아무도 없이 남는다. 감독은
 * 판에서 그 일을 하지 않았는데 판이 그렇게 서는 것이다.
 *
 * ## 가르는 것은 밀도가 아니라 대칭이다
 *
 * "얇은 칸"으로는 가를 수 없다 — 5-3-2 프리셋의 넓은 공격 칸이 0.83이고, 오른쪽에
 * 윙어 둘이 겹쳐 선 판의 빈 왼쪽도 0.83이다. 둘을 가르는 것은 **같은 줄의 반대편**
 * 이다: 프리셋은 좌우가 예외 없이 같은 값이고(1.00), 무너진 판은 0.35다.
 *
 * 그래서 여기서 묻는 것은 한 줄의 좌우가 서로 닮았는가 하나뿐이고, 답이 아니면 그
 * 줄을 **좌우 순서를 지킨 채 x=50 대칭으로 다시 앉힌다.** 존 전력은 자리의 포지션군이
 * 정하므로(§1.1) 이 손질은 **전력을 한 점도 움직이지 않는다** — 움직이는 것은 줄 안의
 * 배분, 즉 격자와 슈팅 경로뿐이다.
 *
 * ## 의도한 과부하는 살아남는다
 *
 * 한쪽으로 사람을 모으는 것은 이 게임이 지원하는 수다(`REGIONAL_INTENT_WEIGHT`의
 * 과부하). 그래서 문턱은 「살짝 기운 것」이 아니라 **반대편이 사실상 비어 있는 것**에
 * 선다 — 중원 셋을 통째로 오른쪽에 밀어도 왼쪽 칸은 기본 배치의 6할을 넘게 남아
 * 손질에 걸리지 않는다.
 */

/**
 * 한 줄의 얇은 쪽이 두꺼운 쪽에 대해 지켜야 하는 몫 — ⚠️ 밸런스 값.
 *
 * 프리셋 일곱은 예외 없이 **1.00**이다(좌우가 거울이므로). 한쪽 측면을 노리고
 * 스트라이커 하나를 터치라인까지 끌어내는 것 — 이 게임이 지원하는 수이고
 * `zone-grid.test.ts`가 지키는 수 — 은 **0.55**다. 같은 자리를 두 번 지시받아
 * 겹쳐 선 줄은 **0.30**, 윙어 둘이 오른쪽에 함께 선 실제 판은 **0.35**다.
 *
 * 문턱은 그 사이에 선다: 얇은 쪽이 두꺼운 쪽의 절반도 못 되면 그건 기울어진 것이
 * 아니라 **한쪽이 비어 있는 것**이다.
 */
const COVER_BALANCE = 0.45;

/**
 * 무너진 줄을 펼 때의 최소 폭 — **좌우 칸 중심 사이**.
 *
 * 겹쳐 선 둘은 폭이 0이라 「지금 폭을 지킨다」만으로는 펴지지 않는다. 이 값이
 * 바닥이라, 무너진 줄은 적어도 양쪽 칸 중심에 닿는 자리까지는 벌어진다.
 */
const MIN_SPAN = LANE_X.right - LANE_X.left;

/** 전술판 x의 양 끝 — 터치라인 밖으로 나가지 않는다 */
const X_MIN = 2;
const X_MAX = 98;

/** 이 선수가 선 줄 — 경계는 화면·격자와 나눠 쓴다 (`PITCH_BANDS.edge`) */
function bandOfY(y: number): GridBand {
  if (y >= PITCH_BANDS.edge.defenseMid) return "defense";
  if (y >= PITCH_BANDS.edge.midAttack) return "midfield";
  return "attack";
}

/** 그 칸에 붙은 사람의 무게 합 — `zoneGrid`의 `presence`와 같은 커널이다 */
function density(points: readonly BoardPoint[], band: GridBand, lane: (typeof GRID_LANES)[number]) {
  return points.reduce(
    (w, p) =>
      w +
      Math.max(0, 1 - Math.hypot(p.x - LANE_X[lane], p.y - PITCH_BANDS.center[band]) / LANE_REACH),
    0,
  );
}

/** 이 줄의 좌우가 서로 닮았는가 */
function balanced(points: readonly BoardPoint[], band: GridBand): boolean {
  const left = density(points, band, "left");
  const right = density(points, band, "right");
  const thick = Math.max(left, right);
  // 양쪽이 다 비었으면 이 줄에는 펼 사람이 없다 — 그건 배치가 아니라 포메이션이다
  if (thick <= 0) return true;
  return Math.min(left, right) / thick >= COVER_BALANCE;
}

/**
 * 킥오프에 세우는 열한 명 — 무너진 줄만 펴서 돌려준다.
 *
 * 손질할 것이 없으면 **받은 배열을 그대로** 돌려준다: 대부분의 경기가 그 길이고,
 * 좌표가 새 객체가 되면 같은 배치의 패킷이 호출마다 달라진다.
 */
export function coverLineup(slots: LineupSlot[]): LineupSlot[] {
  if (slots.length === 0) return slots;
  const at = slots.map((s) => s.point ?? anchorOf(s.position));
  // 골키퍼는 줄이 아니다 — 자리를 펴는 대상에서 빼되 밀도에는 그대로 선다
  const movable = slots.map((s) => s.position.toUpperCase() !== "GK");
  const moved = new Map<number, BoardPoint>();

  /**
   * ⚠️ **펴는 단위는 줄이지 밴드가 아니다** (`pitchLines`). 밴드로 묶으면 2선과
   * 최전방이 한 줄로 취급돼 손질이 스트라이커를 측면으로 밀어낸다 — 판세 표는
   * 나아지고 축구는 나빠지는 자리다.
   */
  const lines = pitchLines(
    at.map((p, i) => ({ i, p })).filter(({ i }) => movable[i]),
    ({ p }) => p.y,
  );

  for (const band of GRID_BANDS) {
    if (balanced(at, band)) continue;
    for (const line of lines) {
      // 그 줄이 이 밴드의 줄인가 — 줄의 중심이 선 자리로 가른다
      const mid = line.reduce((sum, { p }) => sum + p.y, 0) / line.length;
      if (line.length < 2 || bandOfY(mid) !== band) continue;

      const order = [...line].sort((a, b) => a.p.x - b.p.x);
      const span = Math.max(MIN_SPAN, order[order.length - 1]!.p.x - order[0]!.p.x);
      const step = span / (order.length - 1);
      order.forEach(({ i, p }, k) => {
        const x = Math.max(X_MIN, Math.min(X_MAX, 50 + (k - (order.length - 1) / 2) * step));
        if (x !== p.x) moved.set(i, { x, y: p.y });
      });
    }
  }

  if (moved.size === 0) return slots;
  return slots.map((s, i) => {
    const point = moved.get(i);
    return point ? { ...s, point } : s;
  });
}
