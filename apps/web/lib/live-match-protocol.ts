import { z } from "zod";
import type { LiveCheckpointVerdict, MatchEvent } from "@story-fm/domain";
import { LiveCheckpointSchema } from "@story-fm/domain";
import type { LiveMatch } from "@story-fm/sim";
import type { MatchView } from "@story-fm/engine";
import { MatchBoardOrderSchema } from "./match-orders";
import type { GameSlice } from "./store";

/**
 * 실시간 경기의 왕복 — **클라이언트가 굴리고 서버가 확정한다** (live-match.md §8).
 *
 * 클라이언트는 확정 상태(`LiveMatch`)를 받아 같은 함수로 시계를 밀고, 정지점과 5분마다
 * 체크포인트를 낸다. 서버는 같은 틱 수를 굴려 digest를 견주고 자기 상태를 돌려준다 —
 * 어느 쪽이든 클라이언트가 이어받는 것은 서버가 굴린 상태다.
 */
export const LiveActionSchema = z.discriminatedUnion("kind", [
  /** 굴린 구간의 확정 요청 */
  z.object({ kind: z.literal("checkpoint"), checkpoint: LiveCheckpointSchema }),
  /** 전술판의 조작 — 확정 tick에 적용된다. `commandId`는 응답을 잃고 다시 보낸 같은 명령을 가른다 */
  z.object({
    kind: z.literal("orders"),
    orders: z.array(MatchBoardOrderSchema).max(64),
    commandId: z.string().uuid(),
  }),
  /** 휴식(하프타임·연장 개시)을 감독이 끝냈다 */
  z.object({ kind: z.literal("resume") }),
  /** 승부차기 한 발 — 코어가 굴린다 */
  z.object({ kind: z.literal("shootout") }),
]);
export type LiveAction = z.infer<typeof LiveActionSchema>;

/** 서버가 돌려주는 것 — 언제나 확정 상태 전체다 */
export interface LiveSnapshot {
  live: LiveMatch;
  view: MatchView | null;
  /** 120분이 끝나고 승부차기가 남았다 — 마감은 승부가 갈린 뒤다 */
  awaitingShootout: boolean;
  /** 체크포인트의 판정 — 체크포인트 요청에만 */
  verdict?: LiveCheckpointVerdict;
  /** 이 구간에 장부에 앉은 사건 — 체크포인트 요청에만 */
  events?: MatchEvent[];
  /** 전술판 조작이 바꾼 화면 조각 — 조작 요청에만 */
  slice?: GameSlice;
  /** 승부차기 한 발의 결과 문장 — 승부차기 요청에만 */
  shootout?: { message: string; done: boolean };
}
