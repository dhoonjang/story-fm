"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { TurnTraceCall, TurnUsage } from "@story-fm/llm";

import {
  alreadyShown,
  compactJson,
  groupTraceMessages,
  previewLine,
  traceToolFlow,
  type TraceToolStep,
} from "../lib/turn-trace-view";

/**
 * 턴 원문 뷰어 — **개발 도구다.** 게임의 화자가 아니라 우리가 읽는 창이라
 * 문구도 픽션 밖의 말투를 쓴다.
 *
 * 한 채팅 턴은 LLM 호출 하나가 아니다 — 평시 턴은 `gm` + 결산 rater, 경기 턴은
 * `tactic-orders`·`match-gm`가 함께 돈다(종료 턴은 캐스터가 결산 왕복을 더 갖는다). 그 왕복 전부가
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
 *
 * ⚠️ **블록은 안에서 스크롤하지 않는다.** 펼친 것은 전문이고, 넘치는 몫은 창
 * 본문이 스크롤한다 — 블록마다 상한을 두면 프롬프트가 그 안에서 잘려 "여기까지가
 * 전부"로 읽힌다. 접힘이 이미 길이를 감당하므로 상한은 필요하지 않다.
 */
function TraceBlock({
  label,
  meta,
  open = false,
  /** JSON 덩어리인가 — 산문은 줄을 접어 다 보이게, JSON은 들여쓰기를 지킨다 */
  json = false,
  /** 이 블록만 방향이 다를 때 — 응답 꼬리에 섞여 있는 우리 발화가 그렇다 */
  tone,
  children,
}: {
  label: string;
  meta?: string;
  open?: boolean;
  json?: boolean;
  tone?: "in" | "out";
  children: string;
}) {
  return (
    <details className={tone === undefined ? "tt-block" : `tt-block ${tone}`} open={open}>
      <summary>
        <span className="tt-block-label">{label}</span>
        {meta !== undefined && <span className="tt-block-meta">{meta}</span>}
        <BlockCopy value={children} />
      </summary>
      <pre className={json ? "tt-pre json" : "tt-pre"}>{children}</pre>
    </details>
  );
}

/**
 * 이 블록만 복사 — 접기와 **같은 줄에 서므로 누르면 접히지 않아야 한다.**
 * `<summary>` 안의 클릭은 기본으로 열림을 뒤집으므로 여기서 막는다.
 */
function BlockCopy({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(timer);
  }, [done]);
  return (
    <button
      className="tt-block-copy"
      title="이 블록만 복사"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard.writeText(value).then(() => setDone(true));
      }}
    >
      {done ? "복사됨" : "복사"}
    </button>
  );
}

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

/** 밀리초 — 초 단위가 눈에 들어오는 길이부터 초로 적는다 */
function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

const num = (value: number) => value.toLocaleString("ko-KR");

/**
 * 그 조각을 누가 썼는가 — **모델이 쓴 것만 output이다.**
 *
 * `assistant`(Anthropic·OpenAI)와 `model`(Gemini)만 모델의 몫이고, 나머지는 전부
 * 모델에 **들어간** 것이다: 우리 발화도, 호출이 돌려준 `tool_result`도 이력에서는
 * user·tool 역할로 적힌다(Anthropic은 tool_result까지 `role:"user"`다).
 */
function wroteIt(role: string): "in" | "out" | "unknown" {
  if (role === "assistant" || role === "model") return "out";
  return role === "?" ? "unknown" : "in";
}

const WROTE_IT_KO: Record<"in" | "out" | "unknown", string> = {
  in: "모델에 들어간 것 — 발화 또는 tool_result",
  out: "모델이 쓴 것",
  unknown: "역할을 읽을 수 없다",
};

/** 이 호출이 보낸 글자 수 — "다 왔나"를 눈으로 확인하는 눈금이다 */
function requestChars(call: TurnTraceCall): number {
  const { system, user, stateNote, history, tools } = call.request;
  return (
    system.reduce((sum, block) => sum + block.length, 0) +
    user.length +
    (stateNote?.length ?? 0) +
    pretty(history).length +
    pretty(tools).length
  );
}

/**
 * 이 호출의 캐시가 살아 있는가 — 읽은 토큰과 **입력 대비 비**를 함께 적는다.
 *
 * 한 턴은 에이전트 여럿이 도니(창 머리) 이 줄이 곧 에이전트별 히트율이고, 세션
 * 누적 경고(models.md §4)가 세 번을 기다리는 동안 지금 이 턴의 프리픽스를 여기서
 * 읽는다.
 *
 * **문턱 아래 입력은 비율 대신 그렇게 적는다** — 그 제공자의 최소 캐시 프리픽스보다
 * 짧은 호출은 캐시가 애초에 안 걸린다. 0%로 적으면 깨진 프리픽스와 구분되지 않아,
 * 늘 0인 자리 옆에서 진짜 0이 묻힌다.
 */
function cacheFact(usage: TurnUsage, minCacheable: number | undefined): string {
  const input = usage.inputTokens;
  if (minCacheable !== undefined && input < minCacheable) {
    return `in ${num(input)}토큰 (캐시 문턱 ${num(minCacheable)} 미만)`;
  }
  const rate = input > 0 ? Math.round((usage.cacheReadTokens / input) * 100) : 0;
  return `in ${num(input)}토큰 (캐시 읽기 ${num(usage.cacheReadTokens)} · ${rate}%)`;
}

/**
 * 어디까지가 보낸 것이고 어디부터가 받은 것인가.
 *
 * 블록을 한 줄로 죽 세우면 `tools` 다음의 `응답 텍스트`가 같은 모양으로 이어져,
 * **모델이 쓴 것과 우리가 보낸 것이 한 덩어리로 읽힌다.** 그 경계를 잘못 읽으면
 * 이 창의 용건("프롬프트가 잘못 나갔나, 모델이 이상하게 답했나")이 무너진다 —
 * 그래서 방향을 색과 표식으로 갈라 세우고, 그쪽의 크기도 그쪽 머리에 적는다.
 */
function TraceSide({
  dir,
  facts,
  children,
}: {
  dir: "in" | "out";
  facts: string;
  children: ReactNode;
}) {
  return (
    <section className={`tt-side ${dir}`}>
      <div className="tt-side-head">
        <span className="tt-arrow" aria-hidden>
          {dir === "in" ? "→" : "←"}
        </span>
        <b>{dir === "in" ? "보낸 것 (input)" : "받은 것 (output)"}</b>
        <span className="tt-side-facts">{facts}</span>
      </div>
      {children}
    </section>
  );
}

/**
 * 이력을 **대화록으로** 편다 (→ docs/llm/models.md §5).
 *
 * 이력은 제공자 원형 메시지 예순 개다. JSON 한 덩어리로 두면 6만 자짜리 들여쓰기가
 * 되어 무엇이 실려 나갔는지 창 안에서 세지 못한다. 이력이 실제로 담고 있는 것은
 * **대화**이므로 — 장면 하나, 감독의 말 하나가 번갈아 선다 — 줄마다 차례·화자·크기와
 * 첫 마디를 세우고 누르면 전문이 열린다.
 *
 * 본문이 없는 줄(도구 호출·결과)은 크기 대신 그 도구의 이름이 선다. 화자의 색은
 * 꼬리와 같은 규약이다 — 모델이 쓴 것만 초록이다.
 */
function TraceTranscript({
  messages,
  expandAll,
}: {
  messages: readonly unknown[];
  expandAll: boolean;
}) {
  const groups = groupTraceMessages(messages);
  const chars = groups.reduce((sum, g) => sum + (g.text?.length ?? 0), 0);
  return (
    <details className="tt-block" open={expandAll}>
      <summary>
        <span className="tt-block-label">history</span>
        <span className="tt-block-meta">{`${messages.length}개 · 본문 ${num(chars)}자`}</span>
        <BlockCopy value={pretty(messages)} />
      </summary>
      <ol className="tt-hist">
        {groups.map((group) => {
          const wrote = wroteIt(group.role);
          const tool =
            group.calls.length > 0
              ? `도구 ${group.calls.map((c) => c.name).join(" · ")}`
              : group.results.length > 0
                ? `결과 ${group.results.map((r) => r.name ?? "—").join(" · ")}`
                : null;
          return (
            <li className="tt-hist-row" key={group.from}>
              <details>
                <summary>
                  <i className="tt-hist-no">{group.from}</i>
                  <span className={wrote === "unknown" ? "tt-hist-role" : `tt-hist-role ${wrote}`}>
                    {group.role}
                  </span>
                  <span className="tt-hist-size">
                    {group.text === null ? "—" : `${num(group.text.length)}자`}
                  </span>
                  <span className="tt-hist-peek">
                    {tool ?? (group.text === null ? "" : previewLine(group.text))}
                  </span>
                </summary>
                <pre className={group.text === null ? "tt-pre json" : "tt-pre"}>
                  {group.text ?? pretty(group.raw.length === 1 ? group.raw[0] : group.raw)}
                </pre>
              </details>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

/**
 * 이 호출이 부른 도구를 **순서대로** 세운 줄 (→ docs/llm/models.md §5).
 *
 * 꼬리의 JSON 스무 덩어리 안에 흩어져 있던 것을 한 줄로 편다 — 무엇을 부르고 무엇이
 * 돌아왔는지가 이 창에서 가장 자주 찾는 것이고, 특히 **반려된 호출**이 그렇다:
 * 모델이 같은 스킬을 두 번 부르며 인자를 고쳐 잡은 흐름은 여기서만 보인다.
 *
 * 조회와 스킬은 도구 스펙이 가른다(`readOnly`) — 화면이 이름으로 다시 가르면
 * `search_players`처럼 접두사가 다른 조회가 스킬로 선다.
 */
function TraceFlow({ steps, readOnly }: { steps: TraceToolStep[]; readOnly: Set<string> }) {
  if (steps.length === 0) return null;
  const reads = steps.filter((s) => readOnly.has(s.name)).length;
  const failed = steps.filter((s) => s.failed || s.unanswered).length;
  const facts = [
    `${steps.length}회`,
    `조회 ${reads} · 스킬 ${steps.length - reads}`,
    ...(failed > 0 ? [`반려·미응답 ${failed}`] : []),
  ].join(" · ");
  return (
    <section className="tt-flow">
      <div className="tt-flow-head">
        <b>도구 흐름</b>
        <span className="tt-flow-facts">{facts}</span>
      </div>
      <ol className="tt-flow-list">
        {steps.map((step) => {
          const read = readOnly.has(step.name);
          return (
            <li
              className={step.failed || step.unanswered ? "tt-step bad" : "tt-step"}
              key={step.order}
            >
              <details>
                <summary>
                  <i className="tt-step-no">{step.order}</i>
                  <span className={read ? "tt-kind read" : "tt-kind skill"}>
                    {read ? "조회" : "스킬"}
                  </span>
                  <b className="tt-tool">{step.name}</b>
                  <span className="tt-args">{compactJson(step.input, 60)}</span>
                  <span className="tt-outcome">{step.summary}</span>
                </summary>
                <pre className="tt-pre json">
                  {pretty({ input: step.input, output: step.output })}
                </pre>
              </details>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** 호출 하나 — 머리(누가·무엇으로·얼마나)와 방향으로 갈린 원문 */
function TraceCallView({
  call,
  at,
  /** 접힌 것까지 전부 펼친 상태인가 — 창 머리의 손잡이가 정한다 */
  expandAll,
}: {
  call: TurnTraceCall;
  at: number;
  expandAll: boolean;
}) {
  const { request, response } = call;
  const usage = response?.usage;
  const inFacts = [
    `${num(requestChars(call))}자`,
    `system ${request.system.length}블록`,
    `history ${request.history.length}개`,
    `tools ${request.tools.length}개`,
    ...(usage ? [cacheFact(usage, call.minCacheableInput)] : []),
  ].join(" · ");
  /**
   * 창 위쪽에서 이미 선 글 — 꼬리에서 접을 판정의 기준이다 (models.md §5).
   *
   * 발화와 스냅샷은 어댑터마다 꼬리에 적히는 모양이 갈린다: 그대로 적는 곳도,
   * 둘을 이어 붙이는 곳도 있어(§3-3) 이어 붙인 꼴까지 함께 대 본다.
   */
  const shownAbove = [
    request.user,
    ...(request.stateNote === undefined
      ? []
      : [request.stateNote, `${request.user}\n\n${request.stateNote}`]),
    response?.text ?? "",
  ];
  const groups = groupTraceMessages(response?.messages ?? [])
    /**
     * 본문이 빈 덩어리는 서지 않는다 — `TraceBlock`의 규약 그대로다. Gemini는 도구
     * 왕복 사이에 `{ parts: [{ text: "" }] }`를 한 줄씩 적어, 그대로 세우면 빈 줄이
     * 호출과 결과 사이를 갈라 놓는다.
     */
    .filter((group) => group.text !== "");
  const fresh = groups.filter((group) => !alreadyShown(group.text, shownAbove));
  const folded = groups.length - fresh.length;
  const outFacts = response
    ? [
        `${num(response.text.length)}자`,
        `메시지 ${response.messages.length}개`,
        `tool_use ${response.toolCallCount}`,
        ...(folded > 0 ? [`위에 선 것 ${folded}덩어리 접음`] : []),
        ...(usage ? [`out ${num(usage.outputTokens)}토큰`] : []),
        response.stopReason ?? "종료 사유 미보고",
      ].join(" · ")
    : "응답 없음";

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
          {request.streaming && <span>streaming</span>}
        </span>
        <CopyButton value={pretty(call)} />
      </header>

      {/* 이 호출이 부른 도구 — 원문보다 앞이다. 무엇이 오갔는지가 먼저 읽혀야 한다 */}
      <TraceFlow
        steps={traceToolFlow(response?.messages ?? [])}
        readOnly={new Set(request.tools.filter((t) => t.readOnly === true).map((t) => t.name))}
      />

      {/**
       * 요청 안의 순서는 **모델이 읽는 순서**다 — 시스템 프롬프트가 맨 앞이고 발화가
       * 끝이다. 사람이 궁금한 것만 앞으로 끌어오면 무엇이 어느 자리에 실려 나갔는지가
       * 사라진다.
       *
       * ⚠️ **매 턴 달라지는 것만 펼쳐 둔다** — 발화와 스냅샷이다. 고정 프롬프트는
       * 턴마다 같은 글이 화면의 첫 세 뼘을 먹어, 정작 이 턴에 무엇이 달랐는지를
       * 스크롤 아래로 민다. 크기는 접힌 머리가 이미 적고, 창 머리의 손잡이가 한 번에
       * 전부 편다.
       */}
      <TraceSide dir="in" facts={inFacts}>
        {request.system.map((block, i) => (
          <TraceBlock
            key={i}
            label={`system #${i + 1}`}
            meta={`${num(block.length)}자${i === 0 ? " · 캐시 프리픽스 머리" : ""}`}
            open={expandAll}
          >
            {block}
          </TraceBlock>
        ))}
        {request.history.length > 0 && (
          <TraceTranscript messages={request.history} expandAll={expandAll} />
        )}
        <TraceBlock label="user" meta={`${num(request.user.length)}자`} open>
          {request.user}
        </TraceBlock>
        {/* 스냅샷은 발화 뒤다 — 어댑터가 그 자리에 붙인다 (models.md §3-3) */}
        {request.stateNote !== undefined && (
          <TraceBlock label="stateNote" meta={`${num(request.stateNote.length)}자`} open>
            {request.stateNote}
          </TraceBlock>
        )}
        {request.tools.length > 0 && (
          <TraceBlock label="tools" meta={`${request.tools.length}개`} open={expandAll} json>
            {pretty(request.tools)}
          </TraceBlock>
        )}
      </TraceSide>

      <TraceSide dir="out" facts={outFacts}>
        {call.error !== null && <div className="tt-error">{call.error}</div>}
        {response && (
          <TraceBlock label="응답 텍스트" meta={`${num(response.text.length)}자`} open>
            {response.text}
          </TraceBlock>
        )}
        {/**
         * 꼬리에서 **새로 온 것만** 세운다 — 도구 왕복과 thinking이 그것이다.
         *
         * 첫 메시지는 이번 턴의 우리 발화이고 합쳐진 model 덩어리는 응답 본문이라,
         * 둘 다 위에 제 이름을 달고 이미 서 있다(`alreadyShown`). 그대로 두면 창을
         * 한 번 내려 읽는 동안 같은 원문을 세 번 지나고, 그 사이에서 정작 새로 온
         * 도구 왕복이 묻힌다.
         *
         * ⚠️ **스트리밍 조각은 합쳐 센다.** Gemini SDK는 chunk마다 model content를
         * 따로 적어(models.md §5) 한 장면이 스무 줄이 넘는 목록이 된다.
         */}
        {fresh.map((group) => {
          const wrote = wroteIt(group.role);
          const count = group.to - group.from + 1;
          const span =
            count === 1 ? `messages[${group.from}]` : `messages[${group.from}–${group.to}]`;
          const meta = [
            ...(count === 1 ? [] : [`${count}조각 합침`]),
            ...(group.text === null ? [] : [`${num(group.text.length)}자`]),
            WROTE_IT_KO[wrote],
          ].join(" · ");
          return (
            <TraceBlock
              key={group.from}
              label={`${span} · ${group.role}`}
              meta={meta}
              tone={wrote === "unknown" ? undefined : wrote}
              open={expandAll}
              json={group.text === null}
            >
              {group.text ?? pretty(count === 1 ? group.raw[0] : group.raw)}
            </TraceBlock>
          );
        })}
        {/**
         * 접은 턴에만 서는 꼬리 원형 — **화면에서 닿지 못하는 기록은 남기지 않는다.**
         * 접은 판정이 빗나갔더라도 이 덩어리에 그대로 있고, 어댑터가 이력에 무엇을
         * 적었는지를 제공자 모양 그대로 봐야 할 때도 여기다.
         */}
        {folded > 0 && response && (
          <TraceBlock
            label="messages 원형"
            meta={`${response.messages.length}개 · 이력에 붙는 그대로`}
            open={expandAll}
            json
          >
            {pretty(response.messages)}
          </TraceBlock>
        )}
      </TraceSide>
    </section>
  );
}

/**
 * 원문을 밖으로 꺼내는 길 — 수만 자짜리 프롬프트는 편집기에서 읽고 diff를 떠야
 * 무엇이 달라졌는지 보인다. 개발 서버는 localhost라 클립보드가 열려 있다.
 */
function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(timer);
  }, [done]);
  return (
    <button
      className="tt-copy"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => setDone(true));
      }}
    >
      {done ? "복사됨" : "전문 복사"}
    </button>
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
  /**
   * 접힌 것(고정 프롬프트 · 이력 · 도구 스펙 · 응답 꼬리)까지 전부 펼칠 것인가.
   *
   * 손으로 접었다 편 것은 `<details>`가 쥐고 있으므로, 이 손잡이는 목록을 다시
   * 세워(`key`) 기본 상태를 바꾼다 — 블록마다 열림 상태를 리액트로 끌어오면 창
   * 하나가 스무 개의 상태를 들고 있어야 한다.
   */
  const [expandAll, setExpandAll] = useState(false);
  /**
   * 지금 읽는 호출 — 한 턴은 에이전트 여럿이 돈다(models.md §5).
   *
   * 셋을 세로로 이으면 `gm`의 프롬프트 하나가 수만 자라 뒤의 rater까지 스크롤로만
   * 닿는다. 다른 턴을 열면 첫 호출로 돌아간다 — 남아 있던 자리가 그 턴에는 없을 수
   * 있고, 있어도 다른 에이전트다.
   */
  const [active, setActive] = useState(0);

  useEffect(() => {
    setActive(0);
  }, [gameId, index]);

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

  // 탭이 가리키는 자리가 없을 수 있다 — 기록이 아직 안 왔거나 호출이 그보다 적다
  const activeIndex = trace === null ? 0 : Math.min(active, Math.max(0, trace.calls.length - 1));
  const activeCall = trace?.calls[activeIndex] ?? null;

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
          <div className="tt-head-tools">
            {trace && trace.calls.length > 0 && (
              <button
                className="tt-toggle"
                onClick={() => setExpandAll((on) => !on)}
                aria-pressed={expandAll}
              >
                {expandAll ? "모두 접기" : "모두 펼치기"}
              </button>
            )}
            <button className="tt-close" onClick={onClose} aria-label="닫기">
              ✕
            </button>
          </div>
        </header>
        {/**
         * 호출 탭 — **돈 순서 그대로**다. 그 순서가 곧 이 턴의 경로이므로
         * (gm → rater, intent → caster → rater) 이름으로 다시 정렬하지 않는다.
         * 하나뿐이면 탭 줄이 서지 않는다 — 고를 것이 없는 줄이 자리만 먹는다.
         */}
        {trace && trace.calls.length > 1 && (
          <div className="tt-tabs" role="tablist" aria-label="이 턴의 호출">
            {trace.calls.map((call, i) => (
              <button
                className={i === active ? "tt-tab on" : "tt-tab"}
                role="tab"
                aria-selected={i === active}
                key={i}
                onClick={() => setActive(i)}
              >
                <i>{i + 1}</i>
                {call.agent}
                {/**
                 * 탭은 **누구이고 무슨 일이 있었나**까지다 — 걸린 시간·모델·토큰은
                 * 바로 아래 머리가 적는다. 같은 값을 두 줄에 겹쳐 적으면 고르는
                 * 눈이 어느 쪽을 읽어야 할지 모른다.
                 */}
                {(call.response?.toolCallCount ?? 0) > 0 && (
                  <span className="tt-tab-facts">도구 {call.response?.toolCallCount}</span>
                )}
                {/* 실패한 호출은 탭에서 보인다 — 열어 봐야 아는 것이면 못 찾는다 */}
                {call.error !== null && <em className="tt-tab-bad">실패</em>}
              </button>
            ))}
          </div>
        )}
        {/**
         * 손잡이가 바뀌거나 탭을 옮기면 목록을 다시 세운다 — `<details>`의 기본
         * 열림을 그렇게 바꾼다.
         */}
        <div className="tt-body" key={`${active}-${expandAll ? "all" : "prose"}`}>
          {error !== null && <p className="tt-note">기록을 불러오지 못했다 — {error}</p>}
          {trace && trace.calls.length === 0 && <p className="tt-note">{emptyNote(trace.mode)}</p>}
          {activeCall && <TraceCallView call={activeCall} at={activeIndex} expandAll={expandAll} />}
        </div>
      </div>
    </div>
  );
}
