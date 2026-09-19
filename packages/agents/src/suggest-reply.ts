import { z } from "zod";
import { journal } from "@story-fm/engine";
import type { GameToolSpec } from "@story-fm/llm";
import { recordCall, type GmToolCall } from "./gm-types";
import { skillDescriptions } from "./skill-descriptions";
import { inputError, toToolSchema } from "./tool-schema";

/**
 * **감독의 다음 말 하나** — GM 셋(평시·경기·협상 방)이 함께 쥐는 도구다 (agents.md §2).
 *
 * 장면 밖에서 구조로 받는다: 본문 끝에 문장을 적게 하고 코드가 파싱하는 길은 AGENTS.md §4가
 * 막는다. 핸들러는 상태를 바꾸지 않고 장부에 `silent`로만 남기며, 턴 뒤가 그 값을
 * **꺼내**(`takeSuggestion`) `GmTurnResult.suggestion`으로 올린다 — 기록에 남기지 않는 것은
 * 그 문장이 감독이 한 말이 아니어서다. 이력·압축 브리프·해석기 입력 어디에도 실리지 않는다.
 */
export const SUGGEST_REPLY_TOOL = "suggest_reply";

/** 한 문장의 상한 — 입력창 한 줄에 서는 길이다 */
export const SUGGESTION_MAX_CHARS = 80;

export const SuggestReplySchema = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .max(SUGGESTION_MAX_CHARS)
    .describe(
      "감독이 이어 할 법한 말 한 문장 — 이력에 선 감독의 말투로, 감독이 손대지 않고 그대로 보낼 수 있게. 선택지·질문·안내가 아니다",
    ),
});

/** 이 턴의 제안 도구 — 기록은 턴의 장부(`calls`)에 남고, 한 턴에 하나다 */
export function suggestReplyTool(calls: GmToolCall[]): GameToolSpec {
  /** 한 턴에 하나 — 두 번째 호출은 같은 자리를 두 번 채운다 */
  let suggested = false;
  return {
    name: SUGGEST_REPLY_TOOL,
    description: skillDescriptions().suggest_reply,
    inputSchema: toToolSchema(SuggestReplySchema),
    handle(input: unknown) {
      const parsed = SuggestReplySchema.safeParse(input);
      if (!parsed.success) {
        const rejected = inputError(parsed.error);
        journal({
          kind: "command",
          name: SUGGEST_REPLY_TOOL,
          input,
          ok: false,
          message: rejected.message,
          source: "tool",
          blocked: "input",
        });
        return rejected;
      }
      if (suggested) {
        const refused = {
          ok: false as const,
          message: "이번 턴의 제안은 이미 받았습니다 — 한 턴에 하나입니다",
        };
        journal({
          kind: "command",
          name: SUGGEST_REPLY_TOOL,
          input: parsed.data,
          ok: false,
          message: refused.message,
          source: "tool",
        });
        return refused;
      }
      suggested = true;
      const result = { ok: true, message: parsed.data.text };
      journal({
        kind: "command",
        name: SUGGEST_REPLY_TOOL,
        input: parsed.data,
        ok: true,
        message: result.message,
        source: "tool",
      });
      return recordCall(calls, SUGGEST_REPLY_TOOL, result, { input: parsed.data, silent: true });
    },
  };
}

/**
 * 장부에서 제안을 **꺼낸다** — 값을 돌려주고 기록은 뺀다.
 *
 * 남겨 두면 세 자리가 그 문장을 감독의 말처럼 읽는다: 장면이 비어 돌아온 턴의 코어 기록
 * (`sceneFromToolCalls`)이 `@:` 지문으로 세우고, 압축 브리프의 `[장부]` 줄(`turnFactLines`)에
 * 오르고, 세이브의 `toolCalls`에 앉는다. 제안의 자리는 `ChatTurn.suggestion` 하나다.
 */
export function takeSuggestion(calls: GmToolCall[]): string | undefined {
  const at = calls.findIndex((call) => call.name === SUGGEST_REPLY_TOOL);
  if (at < 0) return undefined;
  const [taken] = calls.splice(at, 1);
  return taken?.summary;
}
