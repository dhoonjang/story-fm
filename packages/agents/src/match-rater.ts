import { z } from "zod";
import {
  ATTR_STEP_MAX,
  ATTR_STEP_MIN,
  RATING_BAND,
  RATING_MAX,
  RATING_MIN,
  MATCH_ATTR_CAP,
  matchRated,
  settleMatchRating,
  MATCH_FAMILIARITY_MAX,
  MATCH_FAMILIARITY_MIN,
  type GameState,
  type MatchRatingBrief,
} from "@story-fm/engine";
import { ATTRIBUTE_AXES } from "@story-fm/domain";
import { agentConfig, createGameLLM, type GameLLM, type GameToolSpec } from "@story-fm/llm";
import { agingDeclineLine } from "./aging-line";
import { retryOnce, requireToolCall, anchorStands } from "./retry";
import { inputError, toToolSchema } from "./tool-schema";

/**
 * 경기 후 평점 — 코어가 장부 사실로 앵커를 박고, LLM이 사건 목록을 읽어
 * 앵커 ±RATING_BAND 안에서 다시 매긴다 (협상 판정과 같은 구조 — agents.md §4).
 * 실패하면 앵커가 그대로 남으므로 경기는 언제나 완결된다.
 */
export const MATCH_RATER_SYSTEM = `당신은 방금 끝난 축구 경기를 채점하는 분석가다.

출전한 선수마다 평점(${RATING_MIN}~${RATING_MAX})과 한 줄 근거를 매기고,
그 경기가 남긴 전술 적응도 변화와 능력치 성장을 함께 적는다.

## 무엇을 보는가
- 기록(골·도움·슛·선방·카드)은 이미 기준 평점에 반영돼 있다. 당신이 더할 것은
  기록에 안 남는 것이다 — 경기 사건 목록에서 읽히는 지배력, 위기 관리,
  실점 장면에서의 책임, 교체 투입 후의 영향, 짧게 뛰고도 흐름을 바꾼 순간.
- 출전 시간을 감안한다. 15분 뛴 교체 선수를 90분 뛴 선수와 같은 잣대로 재지 않는다.
- 자리를 감안한다. 수비수의 무실점과 공격수의 무득점은 같은 무게가 아니다.
- 팀 결과에 휩쓸리지 않는다.

## 전술 적응도 (drill)
이 경기를 통해 선수의 전술 적응도가 얼마나 올랐는지를 ${MATCH_FAMILIARITY_MIN}~${MATCH_FAMILIARITY_MAX}로 적는다.
출전 시간과 경기 사건을 참고해라. 빠뜨린 선수는 변화가 없는 것으로 본다.

## 능력치 (attribute / attributeStep)
이 경기로 한 축이 움직인 선수를 적는다. 0~${MATCH_ATTR_CAP}명, 각 한 축 +${ATTR_STEP_MAX} 또는 −${-ATTR_STEP_MIN}.
${agingDeclineLine()}

## 규칙
- 기준 평점에서 ±${RATING_BAND}를 넘지 않는다. 사건 목록에 실제로 나온 것만 이유로 삼는다.
- 명단에 있는 선수 전원을 매긴다.
- 근거는 한 문장, 40자 안팎. "무난했다" 같은 빈 말 대신 그 경기의 사실을 적는다.
- 선수 id는 그대로 돌려준다. 이름으로 쓰지 않는다.`;

/**
 * 스키마가 받아들이는 폭 — 코어 밴드(`RATING_MIN`~`RATING_MAX`,
 * `MATCH_FAMILIARITY_MIN`~`MATCH_FAMILIARITY_MAX`)보다 넓게 열어 둔다.
 * 벗어난 값은 파싱을 깨뜨리는 대신 코어가 자르므로(`settleMatchRating`),
 * 한 선수의 과한 숫자 하나로 경기 판정 전체가 버려지지 않는다.
 */
const ACCEPTED_RATING_MAX = 20;
const ACCEPTED_DRILL_BOUND = 20;

/** 한 번에 매기는 인원 상한 — 한 경기 명단(선발 + 벤치)보다 넉넉하다 */
const MAX_RATED_PLAYERS = 30;

/** 근거 한 줄의 길이 상한 — 프롬프트는 40자 안팎을 요구하고, 여기는 그 여유다 */
const NOTE_MAX = 200;

const RatingEntrySchema = z.object({
  playerId: z.string().min(1).describe("채점 대상 목록의 id 그대로"),
  rating: z
    .number()
    .min(0)
    .max(ACCEPTED_RATING_MAX)
    .describe(`${RATING_MIN}~${RATING_MAX}, 소수 첫째 자리. 기준 평점 ±${RATING_BAND} 안`),
  drill: z
    .number()
    .min(-ACCEPTED_DRILL_BOUND)
    .max(ACCEPTED_DRILL_BOUND)
    .optional()
    .describe(`전술 적응도 변화 — ${MATCH_FAMILIARITY_MIN}~${MATCH_FAMILIARITY_MAX}`),
  attribute: z
    .enum(ATTRIBUTE_AXES)
    .nullish()
    .describe(`움직일 능력치 축 (${MATCH_ATTR_CAP}명까지)`),
  attributeStep: z
    .number()
    .min(ATTR_STEP_MIN)
    .max(ATTR_STEP_MAX)
    .nullish()
    .describe(`그 축의 방향 — ${ATTR_STEP_MAX} 또는 ${ATTR_STEP_MIN}`),
  note: z.string().max(NOTE_MAX).optional().describe("한 문장 근거 (40자 안팎)"),
});
const RateInputSchema = z.object({
  ratings: z.array(RatingEntrySchema).min(1).max(MAX_RATED_PLAYERS),
});

/** 이 호출의 산출은 이 도구 하나뿐이다 — 요청에 강제로 실린다 (agents.md §3) */
export const RATE_PLAYERS_TOOL = "rate_players";

/** 모델이 보는 입력 — 위 Zod 한 벌에서 파생한다 (prompts.md §2) */
export const RATE_PLAYERS_INPUT = toToolSchema(RateInputSchema);

/** 브리프를 프롬프트 본문으로 — 표 한 장 + 사건 목록 */
export function buildRatingPrompt(brief: MatchRatingBrief): string {
  const outcome = { win: "승", draw: "무", loss: "패" }[brief.outcome];
  const rows = brief.players.map((p) => {
    const line = [
      `${p.playerId} | ${p.name} | ${p.position}`,
      p.started ? "선발" : "교체",
      `${p.minutes}분`,
      `기준 평점 ${p.anchor.toFixed(1)}`,
      `${p.age ?? "?"}세 · 성장 여지 ${p.room ?? 0} · 전술적응 ${p.familiarity ?? 0}`,
    ];
    const did: string[] = [];
    if (p.goals > 0) did.push(`${p.goals}골`);
    if (p.assists > 0) did.push(`${p.assists}도움`);
    if (p.shots > 0) did.push(`슛${p.shots}`);
    if (p.saves > 0) did.push(`선방${p.saves}`);
    if (p.yellows > 0) did.push(`경고${p.yellows}`);
    if (p.reds > 0) did.push("퇴장");
    line.push(did.length > 0 ? did.join(" ") : "기록 없음");
    return `- ${line.join(" | ")}`;
  });
  return [
    `최종 스코어: ${brief.scoreline} (우리 팀 ${outcome})`,
    "",
    "## 경기 사건",
    brief.timeline.length > 0 ? brief.timeline.join("\n") : "(기록된 사건 없음)",
    "",
    "## 채점 대상 (id | 이름 | 자리 | 선발/교체 | 출전시간 | 기준 평점 | 나이·성장 여지·전술적응 | 기록)",
    ...rows,
  ].join("\n");
}

function makeRateTool(
  state: GameState,
  matchId: string,
  onApplied: (applied: number) => void,
): GameToolSpec {
  return {
    name: RATE_PLAYERS_TOOL,
    description:
      "출전한 선수 전원의 경기 평점과 한 줄 근거를 **한 번에** 제출한다. 기준 평점에서 크게 벗어난 값은 코어가 잘라 낸다. 두 번째 제출은 반영되지 않는다.",
    inputSchema: RATE_PLAYERS_INPUT,
    handle(input: unknown) {
      const parsed = RateInputSchema.safeParse(input);
      if (!parsed.success) return inputError(parsed.error);
      // 평점·전술 적응도·능력치는 한 표식 아래 한 번만 — 코어가 두 번째 호출을 막는다
      const { applied, skipped, already } = settleMatchRating(state, matchId, parsed.data.ratings);
      if (already) {
        // ok: false로 답하면 모델이 도구 루프를 한 바퀴 더 돈다
        return {
          ok: true,
          message: "이 경기의 평점은 이미 반영됐습니다 — 다시 제출하지 마세요",
        };
      }
      if (applied === 0) {
        return {
          ok: false,
          message: "반영된 평점이 없습니다 — 채점 대상 목록의 id를 그대로 쓰세요",
        };
      }
      onApplied(applied);
      return {
        ok: true,
        message: `평점 ${applied}명 반영${skipped > 0 ? ` (${skipped}명은 대상이 아니라 무시)` : ""}`,
      };
    },
  };
}

/**
 * 경기 후 평점 매기기 — `finalizeMatch` **뒤에** 부른다(앵커가 이미 박혀 있어야 한다).
 * 한 번 다시 시도하되 **실패는 삼킨다** — 평점 하나 때문에 경기 결과가 막히면 안 된다.
 */
export async function rateMatchPerformances(
  state: GameState,
  brief: MatchRatingBrief,
  llm?: GameLLM,
): Promise<{ applied: number }> {
  if (brief.players.length === 0) return { applied: 0 };
  let applied = 0;
  // 이 에이전트의 값은 코어가 앵커 ±RATING_BAND로 좁게 물려 둔다.
  // 경기마다 도는 일이라 지연이 더 아프다
  let client = llm;
  await retryOnce(
    "rater:match",
    () =>
      requireToolCall(RATE_PLAYERS_TOOL, () => {
        client ??= createGameLLM(agentConfig("match-rater"));
        return client.runTurn({
          system: MATCH_RATER_SYSTEM,
          history: [],
          user: buildRatingPrompt(brief),
          tools: [makeRateTool(state, brief.matchId, (n) => (applied = n))],
          toolChoice: { name: RATE_PLAYERS_TOOL },
        });
      }),
    () => matchRated(state, brief.matchId), // 장부에 표식이 섰으면 다시 부르지 않는다
  ).catch(anchorStands("rater:match"));
  return { applied };
}
