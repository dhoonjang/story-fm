"use client";
import { useEffect, useState, type RefObject } from "react";

/** Mobile browsers resize the visual viewport independently of the page when typing. */
export function useMatchViewport(active: boolean, input: RefObject<HTMLTextAreaElement | null>) {
  const [focused, setFocused] = useState(false);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    const mobile = window.matchMedia("(max-width: 1023px)");
    const viewport = window.visualViewport;
    let keyboardWasOpen = false;
    const update = () => {
      const editing = document.activeElement === input.current;
      const keyboardOpen = Boolean(viewport && window.innerHeight - viewport.height > 120);
      if (keyboardWasOpen && !keyboardOpen && editing) input.current?.blur();
      keyboardWasOpen = keyboardOpen;
      setFocused(mobile.matches && document.activeElement === input.current);
      setHeight(mobile.matches && viewport && viewport.scale === 1 ? viewport.height : null);
    };
    update();
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    viewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      viewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
    };
  }, [active, input]);
  return { focused: active && focused, height: active ? height : null };
}
