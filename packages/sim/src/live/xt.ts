/**
 * 위협 격자 — Expected Threat(xT), 12열 × 8행 (live-match.md §5.1).
 *
 * 한 칸의 값은 **공이 그 칸에 있을 때 다음 몇 번의 행동 안에 골이 날 확률**이다. 공을
 * 가진 말은 선택지가 공을 옮겨 놓을 자리의 값을 읽어 "전진이 왜 좋은가"를 수치로 안다.
 *
 * 숫자는 Karun Singh의 공개 모델을 그대로 옮긴 것이다:
 *   https://karun.in/blog/data/open_xt_12x8_v1.json
 *   (설명: https://karun.in/blog/expected-threat.html)
 *
 * **실측 모델이라 밸런스 손잡이가 아니다.** 위협의 눈금을 옮기고 싶으면 이 표가 아니라
 * 그것을 읽는 효용식 쪽에서 옮긴다. 표를 손대는 날은 출처가 바뀐 날뿐이다.
 *
 * 방향 규약 — 원본과 같다:
 *   - 공격 방향이 왼쪽→오른쪽. **열 0이 우리 골라인, 열 11이 상대 골라인.**
 *   - 바깥 배열이 행(y), 안쪽 배열이 열(x). 행 0이 y=0 터치라인, 행 7이 y=68 터치라인.
 *     격자는 위아래 대칭이라 어느 터치라인을 0으로 잡아도 값이 같다.
 *   - 값을 읽는 쪽은 `xThreatAt(x, y)`에 **공격 방향 기준 좌표**를 넘긴다. 시뮬의
 *     절대 좌표를 쓰는 팀은 부르는 쪽에서 `105 - x`로 뒤집어야 한다.
 */

export const XT_COLS = 12;
export const XT_ROWS = 8;

/** 격자가 덮는 경기장 — 길이(공격 방향, m)와 폭(m). 표준 105 × 68 */
export const XT_PITCH_LENGTH = 105;
export const XT_PITCH_WIDTH = 68;

type XtRow = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** open_xt_12x8_v1 — 8행 × 12열, 원본 그대로 */
export const XT_GRID: readonly [XtRow, XtRow, XtRow, XtRow, XtRow, XtRow, XtRow, XtRow] = [
  [
    0.00638303, 0.00779616, 0.00844854, 0.00977659, 0.01126267, 0.01248344, 0.01473596, 0.0174506,
    0.02122129, 0.02756312, 0.03485072, 0.0379259,
  ],
  [
    0.00750072, 0.00878589, 0.00942382, 0.0105949, 0.01214719, 0.0138454, 0.01611813, 0.01870347,
    0.02401521, 0.02953272, 0.04066992, 0.04647721,
  ],
  [
    0.0088799, 0.00977745, 0.01001304, 0.01110462, 0.01269174, 0.01429128, 0.01685596, 0.01935132,
    0.0241224, 0.02855202, 0.05491138, 0.06442595,
  ],
  [
    0.00941056, 0.01082722, 0.01016549, 0.01132376, 0.01262646, 0.01484598, 0.01689528, 0.0199707,
    0.02385149, 0.03511326, 0.10805102, 0.25745362,
  ],
  [
    0.00941056, 0.01082722, 0.01016549, 0.01132376, 0.01262646, 0.01484598, 0.01689528, 0.0199707,
    0.02385149, 0.03511326, 0.10805102, 0.25745362,
  ],
  [
    0.0088799, 0.00977745, 0.01001304, 0.01110462, 0.01269174, 0.01429128, 0.01685596, 0.01935132,
    0.0241224, 0.02855202, 0.05491138, 0.06442595,
  ],
  [
    0.00750072, 0.00878589, 0.00942382, 0.0105949, 0.01214719, 0.0138454, 0.01611813, 0.01870347,
    0.02401521, 0.02953272, 0.04066992, 0.04647721,
  ],
  [
    0.00638303, 0.00779616, 0.00844854, 0.00977659, 0.01126267, 0.01248344, 0.01473596, 0.0174506,
    0.02122129, 0.02756312, 0.03485072, 0.0379259,
  ],
];

/** 경기장 위의 한 점 — 공격 방향 기준 좌표(m) */
export interface XtPoint {
  x: number;
  y: number;
}

/** 격자 칸 번호 — 열은 공격 방향(x), 행은 폭(y) */
export interface XtCell {
  col: number;
  row: number;
}

const clampIndex = (i: number, size: number) => Math.min(size - 1, Math.max(0, i));

/**
 * 좌표 → 칸. 격자 밖(경기장 밖, 골라인 너머)은 **가장 가까운 가장자리 칸**으로 잡는다 —
 * 골라인 위의 공(x = 105)이 열 12로 넘치지 않고 열 11에 선다.
 */
export function xtCellOf(x: number, y: number): XtCell {
  const col = Math.floor((x / XT_PITCH_LENGTH) * XT_COLS);
  const row = Math.floor((y / XT_PITCH_WIDTH) * XT_ROWS);
  return { col: clampIndex(col, XT_COLS), row: clampIndex(row, XT_ROWS) };
}

/**
 * 그 자리의 위협 — 칸의 값 그대로다. **보간하지 않는다**: 원본 모델이 칸 단위로 추정된
 * 값이라 칸 안의 기울기는 모델이 아는 것이 아니고, 계단 하나의 크기(수비 진영 0.001,
 * 박스 앞 0.15)는 효용식의 잡음보다 작거나 그 자체가 뜻이다.
 *
 * `x`는 공격 방향 기준 0..105(105가 상대 골라인), `y`는 0..68. 범위 밖은 가장자리로 잡는다.
 */
export function xThreatAt(x: number, y: number): number {
  const { col, row } = xtCellOf(x, y);
  // 두 인덱스가 방금 잘렸으므로 칸은 언제나 있다
  return XT_GRID[row]![col]!;
}

/**
 * 그 자리의 위협을 칸 중심 사이로 보간한 값 — 공 없는 말의 가치장(`step.ts`)이 쓴다. 가치장은
 * 연속이어야 해서(한 걸음 차이로 값이 계단처럼 뛰면 말이 칸 경계에 몰린다) 칸 값 그대로인
 * `xThreatAt`과 따로 둔다. 공을 가진 말의 판단은 칸 값 그대로를 쓴다.
 */
export function xThreatSmooth(x: number, y: number): number {
  const cw = XT_PITCH_LENGTH / XT_COLS;
  const rh = XT_PITCH_WIDTH / XT_ROWS;
  const fx = Math.min(XT_COLS - 1, Math.max(0, x / cw - 0.5));
  const fy = Math.min(XT_ROWS - 1, Math.max(0, y / rh - 0.5));
  const c0 = Math.floor(fx);
  const r0 = Math.floor(fy);
  const c1 = Math.min(XT_COLS - 1, c0 + 1);
  const r1 = Math.min(XT_ROWS - 1, r0 + 1);
  const tx = fx - c0;
  const ty = fy - r0;
  const at = (r: number, c: number) => XT_GRID[r]![c]!;
  return (
    at(r0, c0) * (1 - tx) * (1 - ty) +
    at(r0, c1) * tx * (1 - ty) +
    at(r1, c0) * (1 - tx) * ty +
    at(r1, c1) * tx * ty
  );
}
