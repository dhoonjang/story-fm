"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { IconHelp } from "@/components/icons";

/**
 * **도움말 표식** — 라벨 옆 `?` 하나와 그 뒤에 접힌 규칙 한두 문장.
 *
 * 화면에 상시로 서는 안내 문구는 0곳이다(design-system.md §8). 그러나 적기 **전에**
 * 알아야 손해를 보지 않는 규칙은 지울 수도 없다 — 그래서 지우는 대신 **묻는 사람에게만
 * 여는** 자리를 준다. 여기 들어가는 것은 세계의 규칙이지 조작법이 아니다.
 *
 * ⚠️ **hover로 열지 않는다.** 터치에는 hover가 없어서 손가락만 있는 감독은 규칙을
 * 영영 못 본다. 누르면 열리고, 같은 표식·바깥·Esc로 닫힌다.
 */
export function HelpPopover({
  label,
  children,
}: {
  /** 표식이 무엇에 붙은 도움말인지 — 화면에 글자로 서지 않으므로 이것이 그 이름이다 */
  label: string;
  children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const mark = useRef<HTMLButtonElement>(null);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) mark.current?.focus();
  }, []);

  /**
   * 바깥을 누르면 닫힌다. 표식 자신의 클릭은 예외다 — 그 클릭은 여닫는 손잡이라,
   * 여기서 먼저 닫으면 `onClick`이 곧바로 다시 열어 한 번 눌러서는 닫히지 않는다.
   *
   * Esc는 포커스를 표식에 돌려놓는다. 키보드로 연 사람은 돌아갈 자리가 그곳뿐이다.
   */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const el = e.target instanceof Node ? e.target : null;
      if (el !== null && root.current?.contains(el) === true) return;
      close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  return (
    <span className="help" ref={root}>
      <button
        type="button"
        className="help-mark"
        ref={mark}
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <IconHelp />
      </button>
      {open && (
        <span className="help-pop" id={id} role="note">
          {children}
        </span>
      )}
    </span>
  );
}
