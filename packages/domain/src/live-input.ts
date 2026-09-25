import { z } from "zod";
import { MatchSideSchema } from "./match";
import {
  BoardPointSchema,
  SetPieceRoutineSchema,
  SetPieceTakersSchema,
  TacticsSpecSchema,
} from "./tactics";
import { PointSchema, SheetLineSchema } from "./sheet";

/**
 * 실시간 경기의 **입력** — 감독이 멈춘 자리(확정된 tick)에서 서버가 묶음에 적용하는 것
 * (live-match.md §8.1). 선수 객체는 싣지 않는다 — id로 가리키고 실행기가 자기 명단에서 찾는다.
 */

export const LiveSlotSchema = z.object({
  playerId: z.string().min(1),
  position: z.string().min(1),
  point: BoardPointSchema.optional(),
  roleId: z.string().min(1).optional(),
  proficiency: z.number().min(0).max(99),
  familiarity: z.number().min(0).max(100),
});
export type LiveSlot = z.infer<typeof LiveSlotSchema>;

export const LiveInputPayloadSchema = z.discriminatedUnion("kind", [
  /** 전술·배치·역할·세트피스 지시가 바뀌었다 — 그 편의 판 전체를 다시 싣는다 */
  z.object({
    kind: z.literal("tactics"),
    side: MatchSideSchema,
    tactics: TacticsSpecSchema,
    slots: z.array(LiveSlotSchema),
    setPieceTakers: SetPieceTakersSchema.optional(),
    setPieceRoutine: SetPieceRoutineSchema.optional(),
  }),
  /** 판독기가 다시 쓴 전술 포인트와 시트 */
  z.object({
    kind: z.literal("reading"),
    points: z.array(PointSchema),
    sheet: z.array(SheetLineSchema),
  }),
  /** 감독의 교체 — 다음 중단에 실행된다 (휴식 중이면 즉시) */
  z.object({
    kind: z.literal("substitution"),
    side: MatchSideSchema,
    out: z.string().min(1),
    in: z.string().min(1),
  }),
  /** 휴식(하프타임·연장 개시)을 감독이 끝냈다 */
  z.object({ kind: z.literal("resume") }),
]);
export type LiveInputPayload = z.infer<typeof LiveInputPayloadSchema>;

/**
 * 체크포인트 — 클라이언트가 `fromTick`(마지막 확정)에서 `toTick`까지 굴린 결과의 digest.
 * 입력은 언제나 확정된 tick에서만 적용되므로(감독이 멈추면 먼저 체크포인트를 제출한다)
 * 그 사이에 재실행이 넣어야 할 입력은 없다 — 서버는 같은 틱 수를 굴려 digest만 비교한다.
 */
export const LiveCheckpointSchema = z.object({
  fromTick: z.number().int().min(0),
  toTick: z.number().int().min(0),
  digest: z.string().min(1),
});
export type LiveCheckpoint = z.infer<typeof LiveCheckpointSchema>;

/** 검증 결과 — 어긋났으면 서버의 상태가 이기고 클라이언트는 그 상태로 되돌아간다 */
export type LiveCheckpointVerdict =
  | { ok: true; toTick: number; digest: string }
  | { ok: false; reason: "digest" | "stale" | "finished"; toTick: number; digest: string };
