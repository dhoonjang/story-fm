import type { OfficeViews } from "@story-fm/engine";
import type { BoardPoint } from "@story-fm/domain";

// ── 스쿼드 화면이 함께 쓰는 이름들 (전술판 · 전술 · 명단 · 상세) ─────────────

/** 전술판 슬롯 하나 — 좌표가 원본, 포지션 코드는 `positionAtPoint`의 파생 (domain tactics.ts) */
export type BoardSlot = { playerId: string; point: BoardPoint } | null;

export type SquadRow = OfficeViews["squad"]["players"][number];
/**
 * 스태프 한 줄 — 구단이 고용한 사람 (docs/data/people.md §2-2). 명단 행과 나란히
 * 두지 않는 이유는 유스 후보와 같다: 판에 올릴 수 있는 인원이 아니다.
 */
export type OfficeStaff = OfficeViews["squad"]["staff"][number];
export type TacticsView = OfficeViews["squad"]["tactics"];
/**
 * 죽은 공 키커 셋 — 자리마다 **지정**과 **지금 실제로 설 사람** (match.md §1.4).
 * 둘이 갈리는 것이 곧 "이름은 남았는데 차지는 않는다"는 사실이라, 화면은 두 칸을
 * 함께 그린다.
 */
export type SetPieceTakersView = OfficeViews["squad"]["setPieces"];
/**
 * 죽은 공 지시 두 축 — 가담·수비 (match.md §1.4). 키커가 "누가 차는가"라면 이쪽은
 * "몇 명이 서는가"다. 지시하지 않은 축도 **뷰가 중립을 펴서** 주므로 화면은 늘
 * 두 축의 값을 손에 쥐고 있다.
 */
export type SetPieceRoutineView = OfficeViews["squad"]["setPieceRoutine"];
export type Selection = { kind: "slot"; index: number } | { kind: "bench"; id: string } | null;

/**
 * 선수가 지금 속한 칸 — 화살표 교체는 이 둘을 맞바꾸는 일이다.
 *
 * **`임대`만은 맞바꿀 수 없는 칸이다** — 계약은 우리 것이라 명단에 서지만
 * (transfer.md §2) 그 선수는 남의 훈련장에 있어 판에 올릴 수도, 층을 옮길 수도 없다.
 */
export type Tier = "선발" | "벤치" | "예비" | "2군" | "임대";

/** 칸 → CSS 클래스 이름 (행의 **왼쪽 선 색**이 칸을 말한다 — 배지 열을 없앤 자리) */
export const TIER_SLUG: Record<Tier, string> = {
  선발: "start",
  벤치: "bench",
  예비: "squad",
  "2군": "reserve",
  임대: "loan",
};
