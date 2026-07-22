"use client";

import { Fragment } from "react";
import type { ChatTurn } from "@story-fm/engine";

/** *연출* 구간을 <em>으로 렌더 */
function renderStaging(text: string) {
  const parts = text.split(/(\*[^*]+\*)/g);
  return parts.map((part, i) =>
    part.startsWith("*") && part.endsWith("*") && part.length > 2 ? (
      <em key={i}>{part.slice(1, -1)}</em>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
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

export function ChatTurnView({ turn }: { turn: ChatTurn }) {
  if (turn.role === "user") {
    return <div className="turn-user">{turn.text}</div>;
  }
  return (
    <div className="turn-model" data-testid="model-turn">
      {turn.toolCalls.length > 0 && (
        <div>
          {turn.toolCalls.map((call, i) => (
            <span className="tool-chip" key={i} data-testid={`tool-${call.name}`}>
              ⚙ {call.name}
            </span>
          ))}
        </div>
      )}
      <div>
        {turn.text.split("\n").map((line, i) =>
          line.trim().length === 0 ? null : <ModelLine key={i} line={line} />,
        )}
      </div>
    </div>
  );
}
