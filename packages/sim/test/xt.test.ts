import { describe, expect, it } from "vitest";
import {
  XT_COLS,
  XT_GRID,
  XT_PITCH_LENGTH,
  XT_PITCH_WIDTH,
  XT_ROWS,
  xtCellOf,
  xThreatAt,
} from "../src/live/xt";

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const column = (col: number) => XT_GRID.map((row) => row[col]!);

describe("위협 격자 — 공개 xT 12×8을 그대로 든다", () => {
  it("8행 × 12열이 빠짐없이 서고 값은 확률이다", () => {
    expect(XT_GRID).toHaveLength(XT_ROWS);
    for (const row of XT_GRID) {
      expect(row).toHaveLength(XT_COLS);
      for (const v of row) {
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it("상대 골라인 쪽 열이 우리 골라인 쪽 열보다 위협이 크다", () => {
    expect(mean(column(XT_COLS - 1))).toBeGreaterThan(mean(column(0)));
    // 열 평균은 골문을 향해 한 칸도 내려가지 않는다
    for (let col = 1; col < XT_COLS; col += 1)
      expect(mean(column(col))).toBeGreaterThanOrEqual(mean(column(col - 1)));
  });

  it("가장 큰 칸은 마지막 열의 가운데 두 행이다", () => {
    let best = { row: -1, col: -1, v: -1 };
    XT_GRID.forEach((row, r) =>
      row.forEach((v, c) => {
        if (v > best.v) best = { row: r, col: c, v };
      }),
    );
    expect(best.col).toBe(XT_COLS - 1);
    expect([3, 4]).toContain(best.row);
    // 격자는 위아래 대칭이다 — 어느 터치라인을 0으로 잡아도 같은 값을 읽는다
    expect(XT_GRID[3]).toEqual(XT_GRID[4]);
    expect(XT_GRID[0]).toEqual(XT_GRID[7]);
  });

  it("좌표를 칸에 놓고, 경기장 밖은 가장자리 칸으로 잡는다", () => {
    expect(xtCellOf(0, 0)).toEqual({ col: 0, row: 0 });
    expect(xtCellOf(XT_PITCH_LENGTH / 2, XT_PITCH_WIDTH / 2)).toEqual({ col: 6, row: 4 });
    // 골라인·터치라인 위의 점은 넘치지 않고 마지막 칸이다
    expect(xtCellOf(XT_PITCH_LENGTH, XT_PITCH_WIDTH)).toEqual({
      col: XT_COLS - 1,
      row: XT_ROWS - 1,
    });
    expect(xThreatAt(-20, -20)).toBe(xThreatAt(0, 0));
    expect(xThreatAt(300, 300)).toBe(xThreatAt(XT_PITCH_LENGTH, XT_PITCH_WIDTH));
    expect(xThreatAt(104, 34)).toBe(XT_GRID[4][11]);
  });
});
