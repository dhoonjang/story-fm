import type { ToolCallRecord } from "./state";

/**
 * **한 턴의 장부 골격** — 그 턴에 실제로 일어난 일을 `[장부] …` 줄로 낸다
 * (→ [docs/llm/agents.md](../../../../docs/llm/agents.md) §4·§5-1).
 *
 * 읽는 것은 스킬 호출의 항목 요약(`brief`)과, 그것이 없는 기록의 요약 문자열이다.
 * 코어가 남긴 기록(시간 경과·경기 진행 — `silent`)도 든다: 그것이 「그 사이 며칠이
 * 흘렀다」·「구간이 굴렀다」라는 사실이고, 그 사실 없이는 요약이 대사에서 시간을
 * 짐작한다. **대사는 쓰지 않는다** — 장부가 이미 아는 사실만이다.
 *
 * 훈련 브리프(`buildTrainingBrief`)와 압축 브리프(`planHistoryFold`)가 같은 함수를
 * 읽고, 장면이 비어 돌아온 턴의 코어 기록(`gm.ts`)도 같은 줄을 세운다 — 세 자리가
 * 저마다 요약을 접으면 같은 호출이 자리마다 다른 문장으로 선다.
 */
export const FACT_PREFIX = "[장부]";

/** 기록 하나 → 한 줄. 세울 것이 없으면 빈 문자열 */
export function toolCallFactLine(call: Pick<ToolCallRecord, "brief" | "summary">): string {
  const brief = call.brief;
  const body = brief
    ? [
        brief.head,
        brief.items
          .map((item) =>
            [item.label, item.text, item.note ? `(${item.note})` : ""]
              .filter((part) => part && part.length > 0)
              .join(" "),
          )
          .join(" · "),
      ]
        .filter((part) => part.length > 0)
        .join(" — ")
    : call.summary
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join(" · ");
  return body.trim();
}

/** 한 턴의 기록 전부 → `[장부] …` 줄들. 기록이 없는 턴은 빈 배열 */
export function turnFactLines(turn: {
  toolCalls: ReadonlyArray<Pick<ToolCallRecord, "brief" | "summary">>;
}): string[] {
  return turn.toolCalls
    .map(toolCallFactLine)
    .filter((line) => line.length > 0)
    .map((line) => `${FACT_PREFIX} ${line}`);
}
