import { z } from "zod";
import {
  arrivedScoutReport,
  playerById,
  recordScoutVerdict,
  strengthsAndWeaknesses,
  type GameState,
} from "@story-fm/engine";
import { formatMoney, SCOUT_VERDICT_MAX, type ScoutReportCard } from "@story-fm/domain";
import {
  agentConfig,
  createGameLLM,
  resolveLlmMode,
  type GameLLM,
  type GameToolSpec,
} from "@story-fm/llm";
import { retryOnce, requireToolCall, anchorStands } from "./retry";
import { inputError, toToolSchema } from "./tool-schema";

/**
 * 스카우팅 평 — 도착한 보고서 한 장에 **한 줄 평**을 붙인다.
 *
 * 코어가 내는 것은 안개 수준·강점·약점·금액이라는 사실뿐이고, 그 표를 「지금 지를까
 * 더 볼까」로 옮기는 문장은 코어가 쓸 수 없다 (docs/llm/agents.md §4-4).
 *
 * ⚠️ **입력은 코어의 사실뿐이다** — 대화도 장부도 읽지 않는다. 이 문장이 답하는 것은
 * 감독이 그 주에 무슨 말을 했는가가 아니라 이 선수가 어떤 선수인가다.
 */
export const SCOUT_RATER_SYSTEM = `당신은 구단이 파견한 스카우트다.

일주일 지켜본 선수를 감독에게 **한 줄 평**으로 보고한다.

## 무엇을 보는가
보고서에 적힌 사실뿐이다 — 종합과 그 오차폭, 잠재력 구간, 강점과 약점, 나이와 자리,
요구액과 기대 주급.

## 규칙
- 한 선수에 한 문장, ${SCOUT_VERDICT_MAX}자 안.
- 「지금 지를까, 더 볼까」에 답한다 — 나이·폭·값을 견준 판단 하나.
- 숫자를 그대로 옮겨 적지 않는다. 감독은 같은 화면에서 그 표를 이미 보고 있다.
- 주어진 사실 밖을 지어내지 않는다. 경기도 훈련도 감독의 말도 본 적 없다.
- 목록의 선수를 빠뜨리지 않는다. 선수 id는 목록의 것을 그대로 쓴다.`;

/**
 * 스키마가 받아들이는 길이 — 코어 상한(`SCOUT_VERDICT_MAX`)보다 넓게 열어 둔다.
 * 넘긴 문장은 파싱을 깨뜨리는 대신 코어가 자르므로(`recordScoutVerdict`), 한 줄이
 * 길다고 그 턴의 평 전부가 버려지지 않는다.
 */
const ACCEPTED_VERDICT_MAX = SCOUT_VERDICT_MAX * 3;

const VerdictSchema = z.object({
  playerId: z.string().min(1).describe("대상 목록의 id 그대로"),
  verdict: z
    .string()
    .min(1)
    .max(ACCEPTED_VERDICT_MAX)
    .describe(`한 줄 평 (${SCOUT_VERDICT_MAX}자 안)`),
});
/**
 * 건수에 상한을 걸지 않는다 — 목록 밖의 id는 핸들러가 말없이 버리므로 상한의 몫을
 * 이미 한다. 상한에 걸려 반려되면 그 턴에 도착한 평이 **통째로** 사라진다.
 */
const VerdictInputSchema = z.object({ verdicts: z.array(VerdictSchema) });

/** 이 호출의 산출은 이 도구 하나뿐이다 — 요청에 강제로 실린다 (agents.md §3) */
export const REPORT_SCOUT_TOOL = "report_scout_verdicts";

export const REPORT_SCOUT_DESCRIPTION =
  "도착한 보고서마다 한 줄 평을 제출한다. 상한을 넘긴 문장은 코어가 자른다.";

/** 모델이 보는 입력 — 위 Zod 한 벌에서 파생한다 (prompts.md §2) */
export const REPORT_SCOUT_INPUT = toToolSchema(VerdictInputSchema);

/** 보고서 한 장을 사실 줄로 — 카드가 이미 조립한 값에 강점·약점만 더한다 */
function subjectRow(state: GameState, card: ScoutReportCard): string {
  const player = playerById(state, card.playerId);
  const observed = player ? strengthsAndWeaknesses(state, player) : null;
  const parts = [
    `${card.playerId} | ${card.name} (${card.team}) | ${card.age}세 ${card.position}`,
    `종합 ${card.overall.value}${card.overall.margin > 0 ? `±${card.overall.margin}` : ""} (${card.overall.label})`,
    // 잠재력은 끝까지 폭으로만 안다 — 한 숫자로 적으면 모델이 그걸 단정한다 (player.md §9.1)
    card.potential
      ? `잠재력 ${card.potential.low.value}~${card.potential.high.value}`
      : "잠재력 미지",
    ...(observed
      ? [`강점 ${observed.strengths.join("·")}`, `약점 ${observed.weaknesses.join("·")}`]
      : []),
    `요구액 ${formatMoney(card.askingPrice)}`,
    `기대 주급 ${formatMoney(card.wageExpectation)}`,
    ...(card.contractUntil ? [`계약 ${card.contractUntil}까지`] : []),
  ];
  return `- ${parts.join(" · ")}`;
}

/** 이번에 도착한 보고서들을 프롬프트 본문으로 */
export function buildScoutPrompt(state: GameState, cards: readonly ScoutReportCard[]): string {
  return [
    "## 오늘 도착한 보고서",
    "(id | 이름(소속) | 나이·자리 | 종합±오차 | 잠재력 구간 | 강점 | 약점 | 요구액 | 기대 주급 | 계약)",
    ...cards.map((card) => subjectRow(state, card)),
  ].join("\n");
}

function makeVerdictTool(
  state: GameState,
  subjects: readonly ScoutReportCard[],
  onRated: () => void,
): GameToolSpec {
  const byId = new Map(subjects.map((card) => [card.playerId, card]));
  return {
    name: REPORT_SCOUT_TOOL,
    description: REPORT_SCOUT_DESCRIPTION,
    inputSchema: REPORT_SCOUT_INPUT,
    handle(input: unknown) {
      const parsed = VerdictInputSchema.safeParse(input);
      if (!parsed.success) return inputError(parsed.error);
      let stood = 0;
      for (const { playerId, verdict } of parsed.data.verdicts) {
        const card = byId.get(playerId);
        // 이번 턴에 도착하지 않은 id — 모델이 지어냈거나 옛 보고서다
        if (!card) continue;
        // 덮어쓰지 않는다 — 이미 평이 있으면 코어가 거절한다 (scouting.ts)
        if (!recordScoutVerdict(state, playerId, verdict)) continue;
        // ⚠️ 화면에 서는 문장은 **서류에 남은 것**이다 — 길이를 자른 것은 코어라,
        // 모델이 보낸 원문을 카드에 실으면 모달과 카드가 다른 문장을 말한다
        card.verdict = arrivedScoutReport(state, playerId)?.verdict ?? null;
        stood += 1;
      }
      if (stood > 0) onRated();
      return { ok: true, message: `한 줄 평 ${stood}건을 보고서에 남겼습니다` };
    },
  };
}

/**
 * 도착한 보고서에 한 줄 평을 붙인다 — 카드가 **선 뒤에** 부른다.
 *
 * 한 턴에 도착한 것 전부를 **한 호출로** 처리한다 — 선수마다 부르면 같은 규칙을 세 번
 * 읽고 기다림도 세 배다.
 *
 * ⚠️ **실패는 삼킨다** — 평이 없는 보고서는 숫자에서 그대로 닫히고, 카드가 서는 것도
 * 줄에서 빠지는 것도 막지 않는다 (agents.md §4-4 · §9). 넘겨받은 카드의 `verdict`를
 * 채우는 것이 이 함수의 유일한 부수효과다.
 */
export async function rateScoutReports(
  state: GameState,
  cards: ScoutReportCard[],
  llm?: GameLLM,
): Promise<void> {
  // 이미 평이 선 보고서는 다시 묻지 않는다 — 두 번 물으면 두 문장이 갈린다
  const subjects = cards.filter((card) => card.verdict === null);
  if (subjects.length === 0) return;
  // mock 모드에는 부를 모델이 없다 — 평 없이 사실 줄만 남는다 (agents.md §8)
  if (llm === undefined && resolveLlmMode() === "mock") return;
  let rated = false;
  let client = llm;
  await retryOnce(
    "rater:scout",
    () =>
      requireToolCall(REPORT_SCOUT_TOOL, () => {
        client ??= createGameLLM(agentConfig("scout-rater"));
        return client.runTurn({
          system: SCOUT_RATER_SYSTEM,
          history: [],
          user: buildScoutPrompt(state, subjects),
          tools: [makeVerdictTool(state, subjects, () => (rated = true))],
          toolChoice: { name: REPORT_SCOUT_TOOL },
          // 산출은 이 도구 하나다 — 결과를 돌려주는 두 번째 요청은 같은 입력을
          // 한 번 더 읽고 아무도 읽지 않는 답을 받아 온다 (models.md §3-4)
          outputOnly: true,
        });
      }),
    // 평이 하나라도 서류에 남았으면 다시 부르지 않는다 — 코어가 덮어쓰기를 거절하므로
    // 두 번째 호출은 남은 자리에도 같은 결과를 낸다
    () => rated,
  ).catch(anchorStands("rater:scout"));
}
