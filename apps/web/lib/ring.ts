/**
 * 리그 고리 — 리그를 정n각형의 꼭짓점에 세운다.
 *
 * 리그는 다섯이라 지금은 오각형이지만 개수는 카탈로그가 정한다(어드민이 리그를
 * 더하거나 뺀다). 그래서 좌표는 개수에서 나온다 — 스켈레톤과 실제 고리가 **같은
 * 자리**에 서야 하므로 계산은 여기 한 곳뿐이다.
 *
 * 단위는 0~100 퍼센트. 판이 정사각형이라 SVG viewBox와 CSS `left/top`이 같은 수를 쓴다.
 */
export interface RingPoint {
  x: number;
  y: number;
}

/** 중심에서 꼭짓점까지 — 꼭짓점에 앉는 칩의 폭까지 판 안에 들어오는 거리 */
export const RING_RADIUS = 34;

/** 첫 꼭짓점은 정수리에 둔다 — 고리가 어디서 시작하는지 눈이 먼저 잡는다 */
export function ringPoints(count: number, radius = RING_RADIUS): RingPoint[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = (-90 + (360 / count) * i) * (Math.PI / 180);
    return { x: 50 + radius * Math.cos(angle), y: 50 + radius * Math.sin(angle) };
  });
}

/** `<polygon points>` 한 줄 — 꼭짓점을 잇는 테두리 */
export function ringPolygon(points: RingPoint[]): string {
  return points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}
