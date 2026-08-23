"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * 두 칸 사이의 손잡이 — **감독이 읽는 쪽에 폭을 준다.**
 *
 * 중계가 길게 흐르는 동안에는 채팅이, 교체를 고를 때는 명단이 넓어야 한다. 반반은
 * 그 둘 중 어느 쪽도 아니어서, 매번 시선이 좁은 칸 안에서 접힌 줄을 따라간다.
 *
 * 끄는 동안 폭을 재서 그리지는 않는다 — 자리를 정하는 것은 여전히 CSS이고
 * (`.stage-split.panel-split`), 여기서 갱신하는 것은 무대에 얹힌 값 하나
 * (`--split-user`)뿐이다. 그래서 격자 트랙도, 그 경계에 붙어 있는 것들(덮개·전술판
 * 서랍·밑막이)도 한 번에 따라온다.
 *
 * 값은 **React 상태가 아니라 DOM에 직접** 쓴다. 상태로 두면 포인터가 움직일 때마다
 * 무대 전체가 다시 그려져 손보다 늦게 따라온다.
 */

const STORE_KEY = "story-fm:stage-split";

/** 화살표 한 번에 옮기는 몫 — 스무 번이면 끝에서 끝이다 */
const KEY_STEP = 0.02;

/**
 * 오른쪽 칸의 몫을 무대 폭 안에서 조인다.
 *
 * 최소 폭은 트랙이 이미 지키지만(`--split-min`), 그 너머로 끄는 동안 값이 계속
 * 자라면 되돌아올 때 손이 한참 헛돈다 — 경계는 멈춰 있는데 숫자만 움직인 만큼이다.
 * 그래서 **같은 값을 CSS에서 읽어** 손잡이도 같은 자리에서 멈춘다.
 *
 * 최소 폭은 px인데 무대는 화면마다 다르므로, 무대가 그 두 배도 안 될 때는 하한이
 * 상한을 넘는다. 그런 폭에서는 반반이 곧 최소다.
 */
function clampSplit(fraction: number, stage: HTMLElement): number {
  const width = stage.getBoundingClientRect().width;
  if (width <= 0) return fraction;
  const min = parseFloat(getComputedStyle(stage).getPropertyValue("--split-min"));
  const floor = Math.min(0.5, (Number.isFinite(min) ? min : 0) / width);
  return Math.min(Math.max(fraction, floor), 1 - floor);
}

/** 브라우저가 저장을 막아 둔 창(사생활 보호 모드)에서도 끄는 것 자체는 되어야 한다 */
function remember(fraction: number): void {
  try {
    window.localStorage.setItem(STORE_KEY, fraction.toFixed(4));
  } catch {
    /* 기억하지 못할 뿐이다 */
  }
}

function recall(): number | null {
  try {
    const saved = Number(window.localStorage.getItem(STORE_KEY));
    return Number.isFinite(saved) && saved > 0 && saved < 1 ? saved : null;
  } catch {
    return null;
  }
}

export function StageSplitHandle() {
  const ref = useRef<HTMLDivElement>(null);
  /** 지금 서 있는 몫 — 끄는 동안의 원본이고, 손을 떼면 이 값이 저장된다 */
  const split = useRef(0.5);
  const dragging = useRef(false);

  /** 무대는 이 손잡이의 부모다 — 격자가 자리를 정하므로 참조를 따로 받을 게 없다 */
  const apply = useCallback((fraction: number) => {
    const stage = ref.current?.parentElement;
    if (!stage) return;
    split.current = fraction;
    stage.style.setProperty("--split-user", `${(fraction * 100).toFixed(3)}%`);
    ref.current?.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
  }, []);

  /**
   * 기억해 둔 비율은 **마운트 뒤에** 얹는다. 서버는 모르는 값이라 첫 렌더에 넣으면
   * 하이드레이션이 어긋난다 — 그 순간 오른쪽 칸은 어차피 닫혀 있어(폭 0) 얹히는
   * 것이 화면에 보이지 않는다.
   */
  useEffect(() => {
    const stage = ref.current?.parentElement;
    const saved = recall();
    if (!stage || saved === null) return;
    apply(clampSplit(saved, stage));
  }, [apply]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const stage = ref.current?.parentElement;
    if (!stage || e.button !== 0) return;
    /* 끄는 동안 글자가 선택되지 않게 — 경계를 잡은 손은 글을 긁는 손이 아니다 */
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    /* 여닫기용 전이가 걸린 채로 끌면 경계가 손보다 한 박자 늦게 온다 */
    stage.style.transition = "none";
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const stage = ref.current?.parentElement;
      if (!dragging.current || !stage) return;
      const box = stage.getBoundingClientRect();
      if (box.width <= 0) return;
      apply(clampSplit((box.right - e.clientX) / box.width, stage));
    },
    [apply],
  );

  const onPointerUp = useCallback(() => {
    const stage = ref.current?.parentElement;
    if (!dragging.current || !stage) return;
    dragging.current = false;
    stage.style.transition = "";
    remember(split.current);
  }, []);

  /**
   * 끌 수 있는 것은 **탭으로도 닿는다.** 왼쪽 화살표는 경계를 왼쪽으로 — 오른쪽
   * 칸이 그만큼 넓어진다.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.key === "ArrowLeft" ? KEY_STEP : e.key === "ArrowRight" ? -KEY_STEP : 0;
      const stage = ref.current?.parentElement;
      if (!step || !stage) return;
      e.preventDefault();
      const next = clampSplit(split.current + step, stage);
      apply(next);
      remember(next);
    },
    [apply],
  );

  return (
    <div
      ref={ref}
      className="split-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="채팅과 오른쪽 칸의 경계"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={50}
      tabIndex={0}
      data-testid="split-handle"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}
