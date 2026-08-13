"use client";

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

/**
 * 어드민 공용 모달 — 목록에서 항목을 클릭했을 때 그 항목만 담는 창.
 *
 * 창이 서는 동안 뒤의 목록은 조작 대상이 아니다: Esc·배경 클릭으로 닫고,
 * Tab은 창 안에서만 돈다(포커스 트랩). 닫히면 원래 눌렀던 자리로 포커스를 돌린다.
 */

const FOCUSABLE_PARTS = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
];
const FOCUSABLE = FOCUSABLE_PARTS.join(", ");
const BODY_FOCUSABLE = FOCUSABLE_PARTS.map((s) => `.admin-modal-body ${s}`).join(", ");

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  testId,
  wide,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  testId?: string;
  wide?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

  useEffect(() => {
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // 첫 포커스는 본문의 첫 입력칸 — 헤더의 ✕에 걸리면 창이 "닫으라"고 말하는 셈이다
    const card = cardRef.current;
    const target =
      card?.querySelector<HTMLElement>(BODY_FOCUSABLE) ??
      card?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    const body = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Esc는 문서 수준에서 듣는다 — 포커스가 창 밖으로 새도 닫히게
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = body;
      restore?.focus();
    };
  }, [onClose]);

  function trapTab(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const nodes = Array.from(cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
      (n) => n.offsetParent !== null,
    );
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="admin-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={wide ? "admin-modal wide" : "admin-modal"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        data-testid={testId}
        ref={cardRef}
        onKeyDown={trapTab}
      >
        <header className="admin-modal-head">
          <div>
            <b className="admin-modal-title" id={headingId}>
              {title}
            </b>
            {subtitle && <span className="admin-modal-sub">{subtitle}</span>}
          </div>
          <button
            className="mini-btn"
            onClick={onClose}
            aria-label="닫기"
            data-testid={testId ? `${testId}-close` : undefined}
          >
            ✕
          </button>
        </header>
        <div className="admin-modal-body">{children}</div>
        {footer && <footer className="admin-modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}
