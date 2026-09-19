import { z } from "zod";
import { MatchSideSchema } from "./match";
import type { RegionalBand, RegionalLane } from "./packet";

/**
 * 전술 포인트와 시트 — 경기의 **위층** (match.md §1.6).
 *
 * 코어 로직은 역할·능력치·포메이션에서 판을 결정적으로 계산하고, 그 위에서 이 경기가
 * 지금 어떻게 읽히는가를 자연어로 든 것이 **전술 포인트**, 그 판독의 수치 독해가
 * **시트**다. 둘을 쓰는 저자는 판독기 하나이고(agents `match-reader.ts`), 값을 매기는
 * 것은 코어다(sim `sheet.ts`). 여기 있는 것은 그 둘이 오가는 **그릇의 모양**뿐이다.
 */

/** 포인트의 중요도 — 감독의 분석이 허락한 줄 수(`POINTS_SEEN`)는 이 순서로 넘어간다 */
export const PointImportanceSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type PointImportance = z.infer<typeof PointImportanceSchema>;

/** 포인트 문장의 길이 상한 — 한 줄로 읽히는 판독이다 */
export const POINT_TEXT_MAX = 120;

/**
 * 전술 포인트 하나 — **세계가 이 경기를 읽은 문장.**
 *
 * `id`는 판독기가 매기고 이어지는 판독은 같은 id로 남는다 — 화면과 기록이 무엇이
 * 바뀌었는지 안다. `about`은 그 판독이 겨눈 사람과 편이다.
 */
export const PointSchema = z.object({
  id: z.string().min(1).max(40),
  text: z.string().min(1).max(POINT_TEXT_MAX),
  about: z.array(z.string().min(1)).default([]),
  importance: PointImportanceSchema,
});
export type Point = z.infer<typeof PointSchema>;

/**
 * 시트의 모양 넷 — **전부 코어에 이미 있는 손잡이다** (match.md §1.6).
 *
 * `edge`는 칸의 전력, `temper`는 카드·파울 가중, `legs`는 체력 소모, `cohesion`은 지시
 * 적용률. 새 모양은 판에서 움직이는 자리가 넷과 다를 때만 선다.
 */
export const SHEET_SHAPES = ["edge", "temper", "legs", "cohesion"] as const;
export const SheetShapeSchema = z.enum(SHEET_SHAPES);
export type SheetShape = z.infer<typeof SheetShapeSchema>;

export const SHEET_SHAPE_KO: Record<SheetShape, string> = {
  edge: "칸 전력",
  temper: "거칠기",
  legs: "체력 소모",
  cohesion: "지시 소화",
};

/** 시트가 겨냥하는 밴드·레인 — 판세 격자와 같은 낱말이다 (`RegionalBand`·`RegionalLane`) */
export const SHEET_BANDS = [
  "defense",
  "midfield",
  "attack",
] as const satisfies readonly RegionalBand[];
export const SHEET_LANES = ["left", "center", "right"] as const satisfies readonly RegionalLane[];

/**
 * 한 줄의 표적 — 모양에 따라 채워지는 칸이 다르다.
 *
 * - `edge`: `player` **또는** `side`+`band`(+`lane`). 레인이 없으면 그 줄 전체다.
 * - `temper` · `legs`: `player`.
 * - `cohesion`: `side`.
 *
 * 합집합이 아니라 한 객체인 것은 제공자마다 받는 스키마 부분집합이 달라서다
 * (`anyOf`를 쓰지 않는다 — agents `tool-schema.ts`). 모양과 표적의 짝이 맞는지는 코어가
 * 확인하고 어긋난 줄은 노트로 남긴다 (sim `sheet.ts`).
 */
export const SheetTargetSchema = z.object({
  player: z.string().min(1).optional(),
  side: MatchSideSchema.optional(),
  band: z.enum(SHEET_BANDS).optional(),
  lane: z.enum(SHEET_LANES).optional(),
});
export type SheetTarget = z.infer<typeof SheetTargetSchema>;

export const SheetSignSchema = z.union([z.literal(1), z.literal(-1)]);
export type SheetSign = z.infer<typeof SheetSignSchema>;
export const SheetStepSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type SheetStep = z.infer<typeof SheetStepSchema>;

/**
 * 시트의 한 줄 — 포인트 하나의 수치 독해.
 *
 * `sign`은 **손잡이의 방향**이다: `edge` +는 그 칸이 두꺼워지고, `temper` +는 카드
 * 가중이 오르고, `legs` +는 소모가 늘고, `cohesion` +는 소화율이 오른다. 어느 편에
 * 이로운가는 부호와 표적의 편에서 코어가 파생한다 (match.md §1.6).
 */
export const SheetLineSchema = z.object({
  pointId: z.string().min(1).max(40),
  target: SheetTargetSchema,
  shape: SheetShapeSchema,
  sign: SheetSignSchema,
  step: SheetStepSchema,
});
export type SheetLine = z.infer<typeof SheetLineSchema>;

/** 어느 편이 이로운가 — **표적 편의 이득이 되는 부호**인가 (match.md §1.6) */
export function sheetLineBenefits(line: Pick<SheetLine, "shape" | "sign">): boolean {
  switch (line.shape) {
    case "edge":
    case "cohesion":
      return line.sign > 0;
    case "temper":
    case "legs":
      return line.sign < 0;
  }
}
