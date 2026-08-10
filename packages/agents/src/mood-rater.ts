import { z } from "zod";
import { MOOD_BATCH, applyMoodNotes, type GameState, type MoodBrief } from "@story-fm/engine";
import { TIERS, createGameLLM, type GameLLM, type GameToolSpec } from "@story-fm/llm";

/**
 * 심경 결산 — **코어가 낸 한 줄을 맥락으로 다시 쓴다.**
 *
 * 코어의 `describeMood`는 상태 테이블에서 가장 말이 되는 이유 하나를 고르는
 * 규칙이라 정확하지만 늘 같은 문장을 낸다. 같은 "불만"도 벤치에서 반 시즌을
 * 보낸 고참과 이적 요청을 넣은 주전이 다르고, 같은 "승리의 여운"도 결승골을
 * 넣은 선수와 후반에 들어가 5분 뛴 선수가 다르다 — 그 차이는 공식이 아니라
 * **그 구간에 무슨 일이 있었나**에서 나온다.
 *
 * 다른 결산들과 같은 계약을 쓴다 (`training-rater`·`match-rater`):
 * **코어가 앵커를 박고 실패하면 앵커가 남는다.** 그래서 이 호출이 죽어도 화면에
 * 빈 줄이 생기지 않고, 시간 진행이 막히지도 않는다.
 *
 * 티어는 `chore` — 결산마다 도는 일이라 싼 모델을 쓴다. 사실 검증은 코어가
 * 하므로(`applyMoodNotes`) 모델이 무뎌도 장부가 흔들리지 않는다.
 */
export const MOOD_RATER_SYSTEM = `당신은 선수단을 매일 보는 구단 사람이다.

주어진 선수 각자의 **지금 심경 한 줄**을 다시 쓴다.

## 무엇을 보는가
코어가 적어 둔 기준 문장(앵커)과 그 선수에게 실제로 있었던 일 — 직전 경기의
결과와 평점, 불만, 정착, 폼, 체력, 주장 여부. 앵커는 사실이 맞지만 누구에게나
같은 말이라, 그 사람의 처지에 맞는 결로 옮기는 것이 당신 일이다.

## 규칙 (어기면 코어가 버리고 앵커를 남긴다)
- **한 문장.** 60자 안팎, 마침표 하나로 끝난다.
- **불만이 걸린 선수는 그 사실을 반드시 문장에 남긴다** — "불만"이라는 말이
  들어가야 한다. 감독이 손을 써야 하는 일이 결에 묻히면 안 된다.
- 앵커에 없는 사실을 지어내지 마라. 부상·이적·발언·사건을 새로 만들지 않는다.
- **체력이 낮다는 것만으로 풀이 죽었다고 쓰지 마라.** 경기 다음 날은 누구나
  지쳐 있다 — 지친 것과 마음이 뜬 것은 다른 사실이다.
- 수치를 문장에 적지 마라 (평점·체력·퍼센트). 사람의 말로 옮긴다.
- 대상 전원에 대해 적는다. 적지 않은 선수는 앵커가 그대로 남는다.
- 선수 id는 목록의 것을 그대로 쓴다.
- 반드시 report_mood 도구로만 답한다. 그 밖의 텍스트는 쓰지 않는다.`;

const NoteSchema = z.object({ playerId: z.string().min(1), text: z.string().min(1).max(120) });
const ReportInputSchema = z.object({ notes: z.array(NoteSchema).max(MOOD_BATCH) });

/** 브리프를 프롬프트 본문으로 — 앵커 + 그 선수에게 있었던 일 */
export function buildMoodPrompt(brief: MoodBrief): string {
  const rows = brief.targets.map(
    (t) => `- ${t.playerId} | ${t.name}\n    앵커: ${t.anchor}\n    사실: ${t.facts.join(" · ")}`,
  );
  return [
    `${brief.from} ~ ${brief.to}`,
    "",
    "## 대상",
    ...rows,
  ].join("\n");
}

function makeReportTool(
  state: GameState,
  brief: MoodBrief,
  onApplied: (count: number) => void,
): GameToolSpec {
  return {
    name: "report_mood",
    description:
      "선수별 심경 한 줄을 제출한다. 규칙을 어긴 문장은 코어가 버리고 기준 문장을 남긴다.",
    inputSchema: {
      type: "object" as const,
      properties: {
        notes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              playerId: { type: "string", description: "대상 목록의 id 그대로" },
              text: { type: "string", description: "그 선수의 심경 한 문장 (60자 안팎)" },
            },
            required: ["playerId", "text"],
          },
        },
      },
      required: ["notes"],
    },
    handle: (input: unknown) => {
      const parsed = ReportInputSchema.safeParse(input);
      if (!parsed.success) return { ok: false, message: "형식이 맞지 않습니다" };
      const applied = applyMoodNotes(state, brief, parsed.data.notes);
      onApplied(applied);
      return { ok: true, message: `심경 ${applied}명 반영` };
    },
  };
}

/**
 * 그 구간의 심경을 결산한다 — 훈련·평점 결산과 **같은 자리에서** 부른다.
 *
 * 실패·타임아웃은 삼킨다. 문장 하나 때문에 시간 진행이나 경기 종료가 막히면
 * 안 된다 — 그때는 코어 앵커가 그대로 화면에 남는다.
 */
export async function reportMood(
  state: GameState,
  brief: MoodBrief,
  llm?: GameLLM,
): Promise<{ applied: number }> {
  if (brief.targets.length === 0) return { applied: 0 };
  let applied = 0;
  try {
    const client = llm ?? createGameLLM(TIERS.chore);
    await client.runTurn({
      system: MOOD_RATER_SYSTEM,
      history: [],
      user: buildMoodPrompt(brief),
      tools: [makeReportTool(state, brief, (n) => (applied = n))],
    });
  } catch {
    // 앵커가 남는다 — 화면에 빈 줄이 생기지 않는다
    return { applied: 0 };
  }
  return { applied };
}
