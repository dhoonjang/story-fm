import { useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { CHIP_SIZE, clampToBoard, type BoardPoint } from "@story-fm/domain";

/** 이만큼 못 움직였으면 드래그가 아니라 탭이다 */
const DRAG_THRESHOLD_PX = 4;

export type BoardDrag = {
  /** 끌고 있는 자리 — 없으면 null */
  index: number | null;
  /** 끌고 있는 칩의 미리보기 좌표 — 놓기 전까지 실제 배치는 그대로다 */
  point: BoardPoint | null;
  onPointerDown: (index: number, e: ReactPointerEvent) => void;
};

/**
 * 전술판 칩 끌기 — HTML5 드래그가 아니라 포인터 이벤트로 직접 처리한다.
 * 칩이 손가락을 실시간으로 따라오고(미리보기), 놓는 순간의 자리가 곧 결과다.
 * 움직임이 임계값 미만이면 드래그가 아니라 탭으로 보고 `onTap`에 넘긴다.
 *
 * 판의 상태는 갖지 않는다 — 끌린 결과를 `onDrop`으로 넘길 뿐이라, 저장이든
 * 경기 중 지시든 무엇으로 받을지는 부르는 쪽이 정한다.
 */
export function useBoardDrag({
  boardRef,
  points,
  occupants,
  enabled,
  onTap,
  onDrop,
}: {
  boardRef: RefObject<HTMLDivElement | null>;
  points: BoardPoint[];
  occupants: string[];
  /** 판을 만질 수 있는가 — 저장이든 지시든 */
  enabled: boolean;
  onTap: (index: number) => void;
  /** 놓았다 — `onto`는 다른 칩 위에 놓았을 때 그 자리, 빈 곳이면 null */
  onDrop: (index: number, point: BoardPoint, onto: number | null) => void;
}): BoardDrag {
  const [index, setIndex] = useState<number | null>(null);
  const [point, setPoint] = useState<BoardPoint | null>(null);

  /** 화면 좌표 → 전술판 좌표(%) */
  function pointFromClient(clientX: number, clientY: number): BoardPoint | null {
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * 100,
      y: ((clientY - rect.top) / rect.height) * 100,
    };
  }

  function onPointerDown(slot: number, e: ReactPointerEvent) {
    if (!enabled || e.button !== 0 || !occupants[slot]) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = points[slot]!;
    const from = pointFromClient(startX, startY);
    // 칩 중심과 커서의 차이 — 잡은 지점을 유지해야 칩이 튀지 않는다
    const grabOffset = from ? { x: origin.x - from.x, y: origin.y - from.y } : { x: 0, y: 0 };
    let dragging = false;
    let pending: BoardPoint | null = null;
    let frame: number | null = null;
    e.currentTarget.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      if (!dragging) {
        const far =
          Math.abs(ev.clientX - startX) > DRAG_THRESHOLD_PX ||
          Math.abs(ev.clientY - startY) > DRAG_THRESHOLD_PX;
        if (!far) return;
        dragging = true;
        setIndex(slot);
      }
      const p = pointFromClient(ev.clientX, ev.clientY);
      if (!p) return;
      const next = clampToBoard({ x: p.x + grabOffset.x, y: p.y + grabOffset.y });
      /**
       * 좌표 갱신을 **프레임에 한 번으로 합친다.** 포인터는 화면보다 자주 쏘는데
       * (120·240Hz 트랙패드) 매 이벤트마다 상태를 바꾸면 같은 프레임 안에서 화면을
       * 여러 번 그리게 된다 — 손은 빨라지지 않고 드래그만 무거워진다.
       */
      pending = next;
      if (frame === null) {
        frame = requestAnimationFrame(() => {
          frame = null;
          if (pending) setPoint(pending);
        });
      }
    };

    const up = (ev: PointerEvent) => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setIndex(null);
      setPoint(null);
      if (!dragging) return onTap(slot);
      const p = pointFromClient(ev.clientX, ev.clientY);
      if (!p) return;
      const dropPoint = clampToBoard({ x: p.x + grabOffset.x, y: p.y + grabOffset.y });
      // 다른 칩 위에 놓으면 자리 교환, 빈 곳이면 그 자리로 이동
      const onto = points.findIndex(
        (q, i) =>
          i !== slot &&
          occupants[i] &&
          Math.abs(q.x - dropPoint.x) < CHIP_SIZE.w / 2 &&
          Math.abs(q.y - dropPoint.y) < CHIP_SIZE.h / 2,
      );
      onDrop(slot, dropPoint, onto >= 0 ? onto : null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  return { index, point, onPointerDown };
}
