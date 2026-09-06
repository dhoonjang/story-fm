/**
 * 움직임을 줄여 달라고 한 브라우저인가 — **CSS 뿐 아니라 JS 타이머도 함께 0이다**
 * (ui/design-system.md §5.8). 애니메이션만 끄고 타이머를 그대로 두면 아무것도
 * 움직이지 않는 채로 그 시간만큼 화면이 멎어 있는다.
 */
export function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
