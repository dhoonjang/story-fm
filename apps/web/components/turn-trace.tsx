"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { TurnTraceCall } from "@story-fm/llm";

/**
 * 턴 원문 뷰어 — **개발 도구다.** 게임의 화자가 아니라 우리가 읽는 창이라
 * 문구도 픽션 밖의 말투를 쓴다.
 *
 * 한 채팅 턴은 LLM 호출 하나가 아니다 — 평시 턴은 `gm` + 결산 rater, 경기 턴은
 * `match-intent`·`match-caster` + `match-rater`가 함께 돈다. 그 왕복 전부가
 * 라우트가 준 **순서 그대로** 선다 (docs/llm/models.md §5).
 */

/** `GET /api/games/[id]/trace/[index]`의 응답 */
interface TurnTracePayload {
  index: number;
  mode: "real" | "mock";
  calls: TurnTraceCall[];
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * 접었다 펴는 블록 하나.
 *
 * `<details>`를 쓴다 — 열림 상태를 리액트가 쥐면 창 하나에 스무 개씩 서는 블록의
 * 상태를 전부 들고 있어야 하고, 키보드 조작도 직접 만들어야 한다.
 *
 * 비어 있는 블록은 아예 서지 않는다 — 열어 봐야 빈 칸인 줄이 열 개면 무엇이
 * 실제로 오갔는지가 그 사이에 묻힌다.
 */
function TraceBlock({
  label,
  meta,
  open = false,
  children,
}: {
  label: string;
  meta?: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="tt-block" open={open}>
      <summary>
        <span className="tt-block-label">{label}</span>
        {meta !== undefined && <span className="tt-block-meta">{meta}</span>}
      </summary>
      <pre className="tt-pre">{children}</pre>
    </details>
  );
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** 밀리초 — 초 단위가 눈에 들어오는 길이부터 초로 적는다 */
function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** 호출 하나 — 헤더(누가·무엇으로·얼마나·얼마어치)와 접힌 블록들 */
function TraceCallView({ call, at }: { call: TurnTraceCall; at: number }) {
  const usage = call.response?.usage;
  return (
    <section className="tt-call">
      <header className="tt-call-head">
        <b className="tt-agent">
          <i>{at + 1}</i>
          {call.agent}
        </b>
        <span className="tt-model">{call.model ?? "—"}</span>
        <span className="tt-facts">
          <span>{duration(call.durationMs)}</span>
          {usage && (
            <span title="입력 / 출력 / 캐시 읽기 / 캐시 쓰기">
              in {usage.inputTokens} · out {usage.outputTokens} · cache r{usage.cacheReadTokens}/w
              {usage.cacheWriteTokens}
            </span>
          )}
          {call.response && <span>{call.response.stopReason ?? "stop 미보고"}</span>}
          {call.request.streaming && <span>streaming</span>}
        </span>
      </header>
      {call.error !== null && <div className="tt-error">{call.error}</div>}

      {/* 사람이 가장 먼저 보는 것부터 — 요청의 끝(user·stateNote)과 응답 텍스트가 펼쳐진 채로 선다 */}
      <TraceBlock label="user" open>
        {call.request.user}
      </TraceBlock>
      {call.request.stateNote !== undefined && (
        <TraceBlock label="stateNote" open>
          {call.request.stateNote}
        </TraceBlock>
      )}
      {call.response && (
        <TraceBlock label="응답 텍스트" meta={`${call.response.text.length}자`} open>
          {call.response.text}
        </TraceBlock>
      )}
      {call.response && call.response.messages.length > 0 && (
        <TraceBlock
          label="응답 messages"
          meta={`${call.response.messages.length}개 · tool_use ${call.response.toolCallCount}`}
        >
          {json(call.response.messages)}
        </TraceBlock>
      )}

      {/* 프롬프트 쪽은 접힌 채로 — 열자마자 수만 토큰이 쏟아지면 아무것도 못 읽는다 */}
      {call.request.system.map((block, i) => (
        <TraceBlock
          key={i}
          label={`system #${i + 1}`}
          meta={`${block.length}자${i === 0 ? " · 캐시 프리픽스 머리" : ""}`}
        >
          {block}
        </TraceBlock>
      ))}
      {call.request.history.length > 0 && (
        <TraceBlock label="history" meta={`${call.request.history.length}개`}>
          {json(call.request.history)}
        </TraceBlock>
      )}
      {call.request.tools.length > 0 && (
        <TraceBlock label="tools" meta={`${call.request.tools.length}개`}>
          {json(call.request.tools)}
        </TraceBlock>
      )}
    </section>
  );
}

/** 기록이 비었다 — 고장이 아닌 경우가 둘이라 어느 쪽인지 말해 준다 */
function emptyNote(mode: TurnTracePayload["mode"]): string {
  return mode === "mock"
    ? "모의 GM(LLM_MODE=mock)은 모델을 부르지 않는다 — 기록이 없는 것이 정상이다."
    : "이 턴의 기록이 없다. 원문은 서버 프로세스 메모리에만 남아, 마지막 재시작 이후의 최근 턴만 볼 수 있다.";
}

/**
 * 창 — Esc·배경 클릭으로 닫고 Tab은 안에서만 돈다.
 * (어드민 모달과 같은 결이지만 그쪽은 어드민 전용이라 여기서 따로 세운다)
 */
export function TurnTracePopup({
  gameId,
  index,
  onClose,
}: {
  gameId: string;
  index: number;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const [trace, setTrace] = useState<TurnTracePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    setTrace(null);
    setError(null);
    fetch(`/api/games/${gameId}/trace/${index}`, { signal: abort.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        setTrace((await res.json()) as TurnTracePayload);
      })
      .catch((e: unknown) => {
        if (abort.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => abort.abort();
  }, [gameId, index]);

  useEffect(() => {
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cardRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
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
    const nodes = Array.from(
      cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
    ).filter((n) => n.offsetParent !== null);
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (!first || !last) return;
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
      className="tt-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="tt-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        data-testid="turn-trace"
        ref={cardRef}
        onKeyDown={trapTab}
      >
        <header className="tt-head">
          <div>
            <b className="tt-title" id={headingId}>
              턴 원문 #{index}
            </b>
            <span className="tt-sub">
              {trace
                ? `${trace.mode} · 호출 ${trace.calls.length}개`
                : error !== null
                  ? "불러오지 못했다"
                  : "불러오는 중…"}
            </span>
          </div>
          <button className="tt-close" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </header>
        <div className="tt-body">
          {error !== null && <p className="tt-note">기록을 불러오지 못했다 — {error}</p>}
          {trace && trace.calls.length === 0 && <p className="tt-note">{emptyNote(trace.mode)}</p>}
          {trace?.calls.map((call, i) => (
            <TraceCallView call={call} at={i} key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}
