import { z } from "zod";
import {
  MOOD_BATCH,
  MOOD_NOTE_MAX,
  applyMoodNotes,
  type GameState,
  type MoodBrief,
} from "@story-fm/engine";
import { agentConfig, createGameLLM, type GameLLM, type GameToolSpec } from "@story-fm/llm";
import { retryOnce, requireToolCall, anchorStands } from "./retry";
import { inputError, toToolSchema } from "./tool-schema";

/**
 * 심경 결산 — 코어가 낸 앵커 한 줄을 그 선수의 맥락(경기·불만·정착·폼)에 맞는
 * 결로 다시 쓴다. 다른 결산과 같은 계약: 실패하면 앵커가 남아 빈 줄이 생기지
 * 않는다. 사실 검증은 코어가 한다(`applyMoodNotes`).
 */
export const MOOD_RATER_SYSTEM = `당신은 선수단을 매일 보는 구단 사람이다.

주어진 선수 각자의 **지금 심경 한 줄**을 다시 쓴다.

## 무엇을 보는가
코어가 적어 둔 기준 문장(앵커)과 그 선수에게 실제로 있었던 일 — 직전 경기의
결과와 평점, 불만, 정착, 폼, 체력, 주장 여부. 그 사람의 처지에 맞는 결로 옮긴다.

## 규칙
- **한 문장.** 60자 안팎, 마침표 하나로 끝난다.
- **불만이 걸린 선수는 그 사실을 문장에 담고 acknowledgesIssue를 true로 적는다.**
- 앵커에 없는 사실을 지어내지 마라. 부상·이적·발언·사건을 새로 만들지 않는다.
- **체력이 낮다는 것만으로 풀이 죽었다고 쓰지 마라.**
- 수치를 문장에 적지 마라 (평점·체력·퍼센트). 사람의 말로 옮긴다.
- 대상 전원에 대해 적는다.
- 선수 id는 목록의 것을 그대로 쓴다.
- 반드시 report_mood 도구로만 답한다. 그 밖의 텍스트는 쓰지 않는다.`;

const NoteSchema = z.object({
  playerId: z.string().min(1).describe("대상 목록의 id 그대로"),
  text: z.string().min(1).max(MOOD_NOTE_MAX).describe("그 선수의 심경 한 문장 (60자 안팎)"),
  /** 그 문장이 불만을 담았는가 — 코어는 낱말을 세지 않는다 (people.md §5) */
  acknowledgesIssue: z.boolean().describe("그 문장이 이 선수의 불만을 담았는가"),
});
const ReportInputSchema = z.object({ notes: z.array(NoteSchema).max(MOOD_BATCH) });

/** 이 호출의 산출은 이 도구 하나뿐이다 — 요청에 강제로 실린다 (agents.md §3) */
export const REPORT_MOOD_TOOL = "report_mood";

/** 모델이 보는 입력 — 위 Zod 한 벌에서 파생한다 (prompts.md §2) */
export const REPORT_MOOD_INPUT = toToolSchema(ReportInputSchema);

/** 브리프를 프롬프트 본문으로 — 앵커 + 그 선수에게 있었던 일 */
export function buildMoodPrompt(brief: MoodBrief): string {
  const rows = brief.targets.map(
    (t) => `- ${t.playerId} | ${t.name}\n    앵커: ${t.anchor}\n    사실: ${t.facts.join(" · ")}`,
  );
  return [`${brief.from} ~ ${brief.to}`, "", "## 대상", ...rows].join("\n");
}

function makeReportTool(
  state: GameState,
  brief: MoodBrief,
  onApplied: (count: number) => void,
): GameToolSpec {
  return {
    name: REPORT_MOOD_TOOL,
    description:
      "선수별 심경 한 줄을 제출한다. 규칙을 어긴 문장은 코어가 버리고 기준 문장을 남긴다.",
    inputSchema: REPORT_MOOD_INPUT,
    handle: (input: unknown) => {
      const parsed = ReportInputSchema.safeParse(input);
      if (!parsed.success) return inputError(parsed.error);
      const applied = applyMoodNotes(state, brief, parsed.data.notes);
      onApplied(applied);
      return { ok: true, message: `심경 ${applied}명 반영` };
    },
  };
}

/**
 * 그 구간의 심경을 결산한다 — 훈련·평점 결산과 같은 자리에서 부른다.
 * 한 번 다시 시도하되 **실패는 삼킨다** — 그때는 코어 앵커가 그대로 화면에 남는다.
 */
export async function reportMood(
  state: GameState,
  brief: MoodBrief,
  llm?: GameLLM,
): Promise<{ applied: number }> {
  if (brief.targets.length === 0) return { applied: 0 };
  let applied = 0;
  let client = llm;
  await retryOnce(
    "rater:mood",
    () =>
      requireToolCall(REPORT_MOOD_TOOL, () => {
        client ??= createGameLLM(agentConfig("mood-rater"));
        return client.runTurn({
          system: MOOD_RATER_SYSTEM,
          history: [],
          user: buildMoodPrompt(brief),
          tools: [makeReportTool(state, brief, (n) => (applied = n))],
          toolChoice: { name: REPORT_MOOD_TOOL },
        });
      }),
    () => applied > 0, // 이미 심경이 반영됐으면 다시 부르지 않는다
  ).catch(anchorStands("rater:mood"));
  return { applied };
}
