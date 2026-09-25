/**
 * **방향키가 고르는 다음 마커.**
 *
 * 판 위의 자리는 줄이 아니라 **평면**이다. 스물두 마커를 배열 순서대로 훑으면
 * 오른쪽을 눌렀을 때 왼쪽 끝으로 뛴다 — 홈은 자기 골문에서 앞으로, 원정은 그
 * 거울로 담기므로 배열 순서와 화면의 좌우가 애초에 같지 않다. 그래서 고르는 것은
 * **그 방향에 실제로 서 있는 가장 가까운 마커**다.
 *
 * 값은 화면에서 잰 픽셀 중심이다 — 눕힌 판(`PITCH_ASPECT`)과 세워 둔 전술판은
 * 가로세로 비가 다르고, 그 비를 여기 적어 두면 CSS와 두 벌이 된다. 게다가 마커의
 * %좌표는 겹침을 푼 뒤의 값이라 컴포넌트가 쥔 숫자와 실제로 그려진 자리가 어긋날
 * 수 있다. 눌린 순간의 픽셀이 두 사정을 한 번에 지운다.
 */
export type MarkerCenter = { x: number; y: number };

export type MarkerDirection = "left" | "right" | "up" | "down";

/**
 * 옆으로 새는 거리에 물리는 값 — 그 방향 거리보다 두 배로 친다.
 *
 * 1이면 순수한 거리라, 오른쪽을 눌렀을 때 살짝 오른쪽에 있는 반대편 라인의
 * 선수가 바로 옆 동료를 이긴다. 방향키가 자리를 설명하려면 **축에서 벗어난
 * 것부터 진다.**
 */
const CROSS_BIAS = 2;

/** 같은 자리로 치는 폭(px) — 반올림 오차로 제자리 마커가 후보가 되지 않게 */
const SAME_SPOT = 0.5;

/**
 * `from` 에서 `dir` 쪽으로 한 칸 — 그 방향에 아무도 없으면 `null`(판의 끝이다).
 *
 * 감아 돌지 않는다: 오른쪽 끝에서 오른쪽을 누르면 왼쪽 끝으로 튀는 대신 그대로
 * 선다 — 판의 가장자리는 화면에 보이는 사실이라 손이 그것을 배운다.
 */
export function nextInDirection(
  centers: readonly MarkerCenter[],
  from: number,
  dir: MarkerDirection,
): number | null {
  const origin = centers[from];
  if (!origin) return null;
  let best: number | null = null;
  let bestCost = Infinity;
  for (let i = 0; i < centers.length; i++) {
    if (i === from) continue;
    const c = centers[i]!;
    const dx = c.x - origin.x;
    const dy = c.y - origin.y;
    const along = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
    if (along <= SAME_SPOT) continue;
    const cross = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    const cost = along + CROSS_BIAS * cross;
    if (cost < bestCost) {
      bestCost = cost;
      best = i;
    }
  }
  return best;
}
