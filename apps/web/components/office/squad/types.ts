import type { OfficeViews } from "@story-fm/engine";
import type { BoardPoint } from "@story-fm/domain";

// ── 스쿼드 화면이 함께 쓰는 이름들 (전술판 · 전술 · 명단 · 상세) ─────────────

/** 전술판 슬롯 하나 — 좌표가 원본, 포지션 코드는 `positionAtPoint`의 파생 (domain tactics.ts) */
export type BoardSlot = { playerId: string; point: BoardPoint } | null;

export type SquadRow = OfficeViews["squad"]["players"][number];
export type TacticsView = OfficeViews["squad"]["tactics"];
export type Selection = { kind: "slot"; index: number } | { kind: "bench"; id: string } | null;

/** 선수가 지금 속한 칸 — 화살표 교체는 이 둘을 맞바꾸는 일이다 */
export type Tier = "선발" | "벤치" | "예비" | "2군";

/** 칸 → CSS 클래스 이름 (행의 **왼쪽 선 색**이 칸을 말한다 — 배지 열을 없앤 자리) */
export const TIER_SLUG: Record<Tier, string> = {
  선발: "start",
  벤치: "bench",
  예비: "squad",
  "2군": "reserve",
};
