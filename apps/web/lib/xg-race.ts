/**
 * 누적 xG 계단선의 좌표 — 판세가 「언제 기울었나」를 그리는 자
 * (→ docs/simulation/match.md §8).
 *
 * 계산이 여기 모여 있는 이유는 JSX 안에 눈금 숫자가 흩어지지 않게 하는 것이고,
 * 경계의 성질(빈 장부·점 하나·연장·최대값 0)을 테스트가 잡을 수 있게 하는 것이다.
 * 값을 만드는 것은 코어(`MatchView.xgTimeline`)이고 여기서 하는 일은 **자리로
 * 옮기는 것**뿐이다 — 문턱도 반올림도 두지 않는다.
 */

/** 코어가 실어 보내는 한 점 — 그 시각까지의 **누적** xG (양 팀) */
export interface XgPoint {
  minute: number;
  home: number;
  away: number;
}

/** 계단선이 그려질 상자 — SVG `viewBox`의 단위이고 픽셀이 아니다 */
export const XG_BOX = { width: 320, height: 64 } as const;

/**
 * 정규 시간의 끝 — x축은 최소 여기까지 간다.
 *
 * 90′에 못 미치는 경기 중에도 축이 줄어들면 같은 45′ 골이 전반에는 오른쪽 끝에,
 * 종료 뒤에는 가운데에 서서 선의 모양이 시간과 무관해진다.
 */
const FULL_TIME = 90;

/** 하프타임 — 축에 서는 유일한 중간 눈금 */
const HALF_TIME = 45;

export interface XgRace {
  /** 계단선 두 벌 — SVG `path`의 `d` */
  home: string;
  away: string;
  /** 지금까지 쌓인 값 — 선 끝의 숫자 */
  total: { home: number; away: number };
  /** x축의 오른끝(분) — 연장으로 가면 90을 넘는다 */
  span: number;
  /** 하프타임 눈금의 x — 축이 90을 넘으면 왼쪽으로 옮겨 앉는다 */
  halfX: number;
  /** 90′ 눈금의 x — 연장이 아니면 오른끝과 같아 서지 않는다 */
  fullX: number | null;
}

/**
 * 계단선을 세운다 — **그릴 것이 없으면 `null`이고 화면은 자리를 비운다.**
 *
 * 점 사이는 값이 그대로이므로 「오른쪽으로 간 뒤 위로」의 계단이고(step-after),
 * 마지막 점부터 지금 분까지도 평평하게 잇는다 — 그 구간이 「아직 아무 슛도 없었다」는
 * 사실이다.
 */
export function xgRaceOf(timeline: readonly XgPoint[], minute: number): XgRace | null {
  const last = timeline[timeline.length - 1];
  if (!last) return null;
  const peak = Math.max(last.home, last.away);
  // xG가 전부 0인 장부(옛 세이브의 0짜리 슛)는 높이가 없다 — 평평한 선 둘은 값이 아니다
  if (peak <= 0) return null;

  const span = Math.max(FULL_TIME, last.minute, minute);
  const x = (m: number) => (Math.min(Math.max(m, 0), span) / span) * XG_BOX.width;
  const y = (v: number) => XG_BOX.height - (v / peak) * XG_BOX.height;

  const pathOf = (read: (p: XgPoint) => number): string => {
    // 출발은 0분 0xG — 첫 슛까지의 평평한 구간이 곧 「조용했다」다
    let d = `M ${x(0)} ${y(0)}`;
    for (const point of timeline) d += ` H ${x(point.minute)} V ${y(read(point))}`;
    // 마지막 점 뒤의 지금까지 — 값은 오르지 않는다
    if (minute > last.minute) d += ` H ${x(minute)}`;
    return d;
  };

  return {
    home: pathOf((p) => p.home),
    away: pathOf((p) => p.away),
    total: { home: last.home, away: last.away },
    span,
    halfX: x(HALF_TIME),
    fullX: span > FULL_TIME ? x(FULL_TIME) : null,
  };
}
