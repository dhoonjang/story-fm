"use client";

import { Fragment, useMemo, useState } from "react";
import type { ChatTurn, ToolCallRecord } from "@story-fm/engine";

/**
 * *연출* 구간을 <em>으로 렌더.
 * 스트리밍 중 아직 닫히지 않은 트레일링 `*...`도 연출로 취급해
 * 별표가 그대로 노출되는 깜빡임을 막는다.
 */
function renderStaging(text: string) {
  const parts = text.split(/(\*[^*]+\*?)/g);
  return parts.map((part, i) => {
    if (part.startsWith("*") && part.length > 1) {
      const closed = part.endsWith("*") && part.length > 2;
      return <em key={i}>{closed ? part.slice(1, -1) : part.slice(1)}</em>;
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

/** 모델 턴 한 줄 — @화자 문법 파싱 (overview §2.1) */
function ModelLine({ line }: { line: string }) {
  const match = line.match(/^@([^:]*):\s?(.*)$/u);
  if (!match) {
    return <div className="line">{renderStaging(line)}</div>;
  }
  const speaker = match[1] ?? "";
  const content = match[2] ?? "";
  if (speaker === "") {
    return <div className="line narration">{renderStaging(content)}</div>;
  }
  const isBroadcast = speaker === "중계";
  return (
    <div className={`line${isBroadcast ? " broadcast" : ""}`}>
      <span className="speaker">{speaker}</span>
      {renderStaging(content)}
    </div>
  );
}

/** 스킬 칩 — 클릭하면 호출 파라미터·결과를 펼쳐 보여준다 */
function ToolChip({ call }: { call: ToolCallRecord }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="tool-chip-wrap">
      <button
        className={`tool-chip${open ? " open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        data-testid={`tool-${call.name}`}
        title="클릭하면 상세를 봅니다"
      >
        ⚙ {call.name}
      </button>
      {open && (
        <div className="tool-detail" data-testid={`tool-detail-${call.name}`}>
          <div className="tool-detail-summary">{call.summary}</div>
          {call.input !== undefined && (
            <pre className="tool-detail-input">{JSON.stringify(call.input, null, 2)}</pre>
          )}
        </div>
      )}
    </span>
  );
}

/** 텍스트 속 선수 id → 이름 (스트리밍 델타에 id가 흘러든 경우의 안전망) */
function humanize(text: string, names?: Record<string, string>): string {
  if (!names || !text.includes("-")) return text;
  let out = text;
  for (const id of Object.keys(names)) {
    if (out.includes(id)) out = out.split(id).join(names[id] ?? id);
  }
  return out;
}

export function ChatTurnView({
  turn,
  streaming = false,
  playerNames,
}: {
  turn: ChatTurn;
  /** 스트리밍 중인 미완성 턴 — 마지막 미완성 줄을 보류해 파싱 깨짐 방지 */
  streaming?: boolean;
  playerNames?: Record<string, string>;
}) {
  const text = useMemo(() => humanize(turn.text, playerNames), [turn.text, playerNames]);

  if (turn.role === "user") {
    return <div className="turn-user">{turn.text}</div>;
  }

  let lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (streaming && lines.length > 0) {
    // 아직 `@화자:`의 콜론이 도착하지 않은 마지막 줄은 다음 델타까지 보류
    const last = lines[lines.length - 1] ?? "";
    if (/^@[^:]*$/u.test(last)) lines = lines.slice(0, -1);
  }

  return (
    <div className={`turn-model${streaming ? " streaming" : ""}`} data-testid="model-turn">
      {turn.toolCalls.length > 0 && (
        <div className="tool-chips">
          {turn.toolCalls.map((call, i) => (
            <ToolChip call={call} key={i} />
          ))}
        </div>
      )}
      <div>
        {lines.map((line, i) => (
          <ModelLine key={i} line={line} />
        ))}
      </div>
    </div>
  );
}
