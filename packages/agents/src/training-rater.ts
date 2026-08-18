import { z } from "zod";
import {
  ATTR_STEP_MAX,
  ATTR_STEP_MIN,
  TACTIC_GAIN_MAX,
  TACTIC_GAIN_MIN,
  TRAINING_ATTR_CAP,
  POSITION_TRAIN_MAX,
  applyTrainingOutcomes,
  trainingSettled,
  type GameState,
  type TrainingBrief,
} from "@story-fm/engine";
import { ATTRIBUTE_AXES, AXIS_KO } from "@story-fm/domain";
import { agentConfig, createGameLLM, type GameLLM, type GameToolSpec } from "@story-fm/llm";
import { retryOnce, anchorStands } from "./retry";

/**
 * 훈련 결산 — advance_time이 넘긴 구간의 훈련을 한 묶음으로 판정한다.
 * 코어는 적응도를 건드리지 않는다 — 실제로 얼마나 스몄는지는 여기서만 정한다.
 * 세션마다 부르지 않는다 — 훈련엔 사건 목록이 없어 하루치로는 판단 거리가 없다.
 * 값의 폭은 코어가 좁게 물려 둬 모델이 무뎌도 게임이 흔들리지 않는다.
 *
 * ⚠️ **폭과 인원의 숫자는 전부 코어 상수에서 읽는다** — 프롬프트에도 스키마에도
 * 손으로 적지 않는다. 적으면 코어만 조여지고 판정자는 옛 밴드를 계속 믿는다
 * (docs/llm/agents.md §4).
 */
export const TRAINING_RATER_SYSTEM = `당신은 축구 구단의 훈련장을 지켜본 코치다.

지난 며칠의 훈련이 선수 각자에게 **얼마나 스몄는지**를 매긴다.

## 무엇을 보는가
훈련 내용, 선수의 자리·나이·컨디션, 감독이 그 기간에 한 말, 걸려 있는 개인 지시.

## 규칙
- 전술 적응도는 **${TACTIC_GAIN_MIN} ~ ${TACTIC_GAIN_MAX} 중 하나**다. 대부분은 0~1이고, ${TACTIC_GAIN_MIN}은
  지친 선수를 굴려 오히려 흐트러졌을 때다.
- 능력치는 **0~${TRAINING_ATTR_CAP}명**, 각 한 축 **+${ATTR_STEP_MAX} 또는 −${-ATTR_STEP_MIN}**, **그 기간에 실제로 훈련한 축만**.
  아무에게도 변화가 없는 구간이 정상이다. 서른을 넘긴 선수의 스피드·체력·드리블은
  훈련해도 내려간다.
- **개인 훈련으로 자리를 배우는 선수**(대상 표에 "전향 …"으로 표시)에게는
  positionGain을 **0~${POSITION_TRAIN_MAX}**으로 적는다. 전향이 걸리지 않은 선수에게는 적지 않는다.
- 대상 전원을 빠뜨리지 마라.
- **date에 그 변화가 나온 훈련 날짜**를 적는다. 위 훈련 목록의 날짜 중 하나여야 한다.
- 근거는 한 문장, 30자 안팎. 그 기간에 실제로 있었던 일만 적는다.
- 선수 id는 목록의 것을 그대로 쓴다. 이름으로 쓰지 않는다.
- 반드시 report_training 도구로만 답한다. 그 밖의 텍스트는 쓰지 않는다.`;

const OutcomeSchema = z.object({
  playerId: z.string().min(1),
  tacticGain: z.number().min(-9).max(9).optional(),
  positionGain: z.number().min(0).max(9).optional(),
  attribute: z.enum(ATTRIBUTE_AXES).nullish(),
  attributeStep: z.number().min(ATTR_STEP_MIN).max(ATTR_STEP_MAX).nullish(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  note: z.string().max(200).optional(),
});
const ReportInputSchema = z.object({ results: z.array(OutcomeSchema).max(60) });

/** 브리프를 프롬프트 본문으로 — 훈련 일지 + 대화 + 대상 표 */
export function buildTrainingPrompt(brief: TrainingBrief): string {
  const sessions = brief.sessions.map((s) => {
    const focus = s.focus.map((f) => AXIS_KO[f as never] ?? f).join("·");
    return `- ${s.date} ${s.slot === "am" ? "오전" : "오후"} | ${s.label} | ${focus || "—"}${
      s.ordered ? " | 감독 지시" : ""
    }`;
  });
  const chat = brief.chat.map((t) => `- ${t.at} ${t.role === "user" ? "감독" : "코치"}: ${t.text}`);
  const rows = brief.subjects.map((p) => {
    const parts = [
      `${p.playerId} | ${p.name} | ${p.position} | ${p.age}세`,
      `OVR ${p.overall} (성장 여지 ${p.room})`,
      `전술적응 ${p.familiarity}`,
      `컨디션 ${p.condition} · 폼 ${p.form > 0.2 ? "좋음" : p.form < -0.2 ? "나쁨" : "보통"}`,
      p.apps > 0 ? `시즌 ${p.apps}경기 평점 ${p.rating?.toFixed(1) ?? "—"}` : "출전 없음",
    ];
    if (p.instruction) parts.push(`개인지시 "${p.instruction}"`);
    if (p.program?.position) parts.push(`전향 ${p.program.position} 훈련 중`);
    if (p.program?.axis)
      parts.push(`개인훈련 ${AXIS_KO[p.program.axis as never] ?? p.program.axis}`);
    return `- ${parts.join(" | ")}`;
  });
  const axes = brief.trainedAxes.map((a) => AXIS_KO[a]).join("·");
  return [
    `${brief.teamName} — ${brief.from} ~ ${brief.to}`,
    "",
    "## 이 기간의 훈련",
    ...sessions,
    "",
    `능력치를 올릴 수 있는 축: ${axes || "없음 (전술·회복만 했다)"}`,
    "",
    "## 감독과 나눈 대화",
    chat.length > 0 ? chat.join("\n") : "(없음)",
    "",
    "## 대상 (id | 이름 | 자리 | 나이 | OVR·성장 여지 | 전술적응 | 컨디션·폼 | 시즌 기록 | 개인지시)",
    ...rows,
  ].join("\n");
}

function makeReportTool(
  state: GameState,
  brief: TrainingBrief,
  onApplied: (lines: string[]) => void,
): GameToolSpec {
  return {
    name: "report_training",
    description:
      "이 기간 훈련의 결과를 제출한다. 기준에서 크게 벗어나거나 훈련하지 않은 축은 코어가 잘라 낸다.",
    inputSchema: {
      type: "object" as const,
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              playerId: { type: "string", description: "대상 목록의 id 그대로" },
              tacticGain: {
                type: "number",
                description: `전술 적응도 변화 — ${TACTIC_GAIN_MIN}~${TACTIC_GAIN_MAX} 중 하나`,
              },
              positionGain: {
                type: "number",
                description: `전향 훈련이 올린 자리 적응도 — 0~${POSITION_TRAIN_MAX} (전향 중인 선수만)`,
              },
              attribute: {
                type: "string",
                enum: [...ATTRIBUTE_AXES],
                description: `움직일 능력치 축 (그 기간에 훈련한 축만, ${TRAINING_ATTR_CAP}명까지)`,
              },
              attributeStep: {
                type: "number",
                description: `그 축의 방향 — ${ATTR_STEP_MAX} 또는 ${ATTR_STEP_MIN}`,
              },
              date: {
                type: "string",
                description: "이 변화가 나온 훈련 날짜 (YYYY-MM-DD, 위 훈련 목록 중 하나)",
              },
              note: { type: "string", description: "한 문장 근거 (30자 안팎)" },
            },
            required: ["playerId"],
          },
        },
      },
      required: ["results"],
    },
    handle(input: unknown) {
      /**
       * **한 구간은 한 번만 결산된다** — 도구 루프는 같은 도구를 여러 번 부를 수
       * 있다 (docs/llm/agents.md §4). `ok: false`로 답하면 모델이 명단을 고쳐 또
       * 부르므로, 성공으로 답하고 장부는 건드리지 않는다.
       */
      if (trainingSettled(state, brief)) {
        return {
          ok: true,
          message: "이 구간의 훈련 결산은 이미 반영됐습니다 — 다시 제출하지 마세요",
        };
      }
      const parsed = ReportInputSchema.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join(" / ");
        return { ok: false, message: `훈련 결산 형식 오류 — ${issues}` };
      }
      const lines = applyTrainingOutcomes(
        state,
        brief,
        parsed.data.results.map((r) => ({
          playerId: r.playerId,
          tacticGain: r.tacticGain ?? 0,
          positionGain: r.positionGain ?? null,
          attribute: r.attribute ?? null,
          attributeStep: r.attributeStep ?? 1,
          note: r.note ?? "",
          ...(r.date ? { date: r.date } : {}),
        })),
      );
      onApplied(lines);
      return { ok: true, message: `훈련 결산 반영 (${parsed.data.results.length}건 검토)` };
    },
  };
}

/**
 * 지나간 훈련을 결산한다 — `advanceTime` **뒤에** 부른다.
 * 한 번 다시 시도하되 **실패는 삼킨다** — 그 구간의 훈련 성과는 없던 일이 된다
 * (코어가 미리 올려 두지 않으므로).
 */
export async function reportTraining(
  state: GameState,
  brief: TrainingBrief,
  llm?: GameLLM,
): Promise<{ lines: string[] }> {
  if (brief.sessions.length === 0 || brief.subjects.length === 0) return { lines: [] };
  let lines: string[] = [];
  let client = llm;
  await retryOnce(
    "rater:training",
    () => {
      client ??= createGameLLM(agentConfig("training-rater"));
      return client.runTurn({
        system: TRAINING_RATER_SYSTEM,
        history: [],
        user: buildTrainingPrompt(brief),
        tools: [makeReportTool(state, brief, (l) => (lines = l))],
      });
    },
    // 이미 반영됐으면 다시 부르지 않는다 — 요약 줄이 비어도(소수로만 움직인 구간)
    // 장부는 이미 움직였으므로 반환값이 아니라 상태의 표식을 본다
    () => trainingSettled(state, brief),
  ).catch(anchorStands("rater:training"));
  return { lines };
}
