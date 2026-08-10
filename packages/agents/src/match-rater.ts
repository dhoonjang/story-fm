import { z } from "zod";
import {
  RATING_BAND,
  RATING_MAX,
  RATING_MIN,
  MATCH_ATTR_CAP,
  applyMatchAttributes,
  applyMatchFamiliarity,
  applyMatchRatings,
  MATCH_FAMILIARITY_MAX,
  MATCH_FAMILIARITY_MIN,
  type GameState,
  type MatchRatingBrief,
} from "@story-fm/engine";
import { ATTRIBUTE_AXES } from "@story-fm/domain";
import { TIERS, createGameLLM, type GameLLM, type GameToolSpec } from "@story-fm/llm";

/**
 * 경기 후 평점 — 코어가 장부 사실로 앵커를 박고, LLM이 사건 목록을 읽어
 * 앵커 ±RATING_BAND 안에서 다시 매긴다 (협상 판정과 같은 구조 — ADR 0002).
 * 실패하면 앵커가 그대로 남으므로 경기는 언제나 완결된다.
 */
export const MATCH_RATER_SYSTEM = `당신은 방금 끝난 축구 경기를 채점하는 분석가다.

출전한 선수마다 **평점(${RATING_MIN}~${RATING_MAX})**과 **한 줄 근거**를 매기고,
그 경기가 남긴 **전술 적응도 변화**와 **능력치 성장**을 함께 적는다.

## 무엇을 보는가
- 기록(골·도움·슛·선방·카드)은 이미 기준 평점에 반영돼 있다. 당신이 더할 것은
  **기록에 안 남는 것**이다 — 경기 사건 목록에서 읽히는 지배력, 위기 관리,
  실점 장면에서의 책임, 교체 투입 후의 영향, 짧게 뛰고도 흐름을 바꾼 순간.
- 출전 시간을 감안한다. 15분 뛴 교체 선수를 90분 뛴 선수와 같은 잣대로 재지 않는다.
- 자리를 감안한다. 수비수의 무실점과 공격수의 무득점은 같은 무게가 아니다.
- 팀 결과에 휩쓸리지 않는다. 진 경기에도 잘한 선수가 있고 이긴 경기에도 못한 선수가 있다.

## 전술 적응도 (drill)
이 경기를 통해 선수의 전술 적응도가 얼마나 올랐는지를 **${MATCH_FAMILIARITY_MIN}~${MATCH_FAMILIARITY_MAX}**로 적는다.
출전 시간과 경기 사건을 참고해라. 빠뜨린 선수는 변화가 없는 것으로 본다.

## 능력치 (attribute / attributeStep)
이 경기로 한 축이 움직인 선수를 적는다. **0~${MATCH_ATTR_CAP}명**, 각 한 축 **+1 또는 −1**.
서른을 넘긴 선수는 내려가는 쪽이 자연스럽다 — 특히 스피드·체력·드리블.

## 규칙
- **기준 평점에서 ±${RATING_BAND}를 넘지 않는다.** 넘기면 코어가 잘라 낸다.
  근거 없이 크게 흔들지 말고, 사건 목록에 실제로 나온 것만 이유로 삼는다.
- 명단에 있는 선수 **전원**을 매긴다. 빠뜨린 선수는 기준 평점이 그대로 남는다.
- 근거는 한 문장, 40자 안팎. "무난했다" 같은 빈 말 대신 그 경기의 사실을 적는다.
- 선수 id는 그대로 돌려준다. 이름으로 쓰지 않는다.
- 반드시 rate_players 도구로만 답한다. 그 밖의 텍스트는 쓰지 않는다.`;

const RatingEntrySchema = z.object({
  playerId: z.string().min(1),
  rating: z.number().min(0).max(20),
  drill: z.number().min(-20).max(20).optional(),
  attribute: z.enum(ATTRIBUTE_AXES).nullish(),
  attributeStep: z.number().min(-1).max(1).nullish(),
  note: z.string().max(200).optional(),
});
const RateInputSchema = z.object({ ratings: z.array(RatingEntrySchema).min(1).max(30) });

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
    name: "rate_players",
    description:
      "출전한 선수 전원의 경기 평점과 한 줄 근거를 제출한다. 기준 평점에서 크게 벗어난 값은 코어가 잘라 낸다.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ratings: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              playerId: { type: "string", description: "채점 대상 목록의 id 그대로" },
              rating: {
                type: "number",
                description: `${RATING_MIN}~${RATING_MAX}, 소수 첫째 자리. 기준 평점 ±${RATING_BAND} 안`,
              },
              drill: {
                type: "number",
                description: `전술 적응도 변화 — ${MATCH_FAMILIARITY_MIN}~${MATCH_FAMILIARITY_MAX}`,
              },
              attribute: {
                type: "string",
                enum: [...ATTRIBUTE_AXES],
                description: `움직일 능력치 축 (${MATCH_ATTR_CAP}명까지)`,
              },
              attributeStep: { type: "number", description: "그 축의 방향 — 1 또는 -1" },
              note: { type: "string", description: "한 문장 근거 (40자 안팎)" },
            },
            required: ["playerId", "rating"],
          },
        },
      },
      required: ["ratings"],
    },
    handle(input: unknown) {
      const parsed = RateInputSchema.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join(" / ");
        return { ok: false, message: `평점 형식 오류 — ${issues}` };
      }
      const { applied, skipped } = applyMatchRatings(state, matchId, parsed.data.ratings);
      // 전술 체득 — 코어는 아무것도 올리지 않았다. 여기가 유일한 상승 경로다
      applyMatchFamiliarity(
        state,
        parsed.data.ratings
          .filter((r) => r.drill !== undefined)
          .map((r) => ({ playerId: r.playerId, gain: r.drill! })),
      );
      // 능력치 — 훈련 결산과 같은 규칙(`awardAttribute`)을 탄다
      applyMatchAttributes(
        state,
        parsed.data.ratings.map((r) => ({
          playerId: r.playerId,
          attribute: r.attribute ?? null,
          attributeStep: r.attributeStep ?? 1,
        })),
      );
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
 * 실패·타임아웃은 삼킨다. 평점 하나 때문에 경기 결과가 막히면 안 된다.
 */
export async function rateMatchPerformances(
  state: GameState,
  brief: MatchRatingBrief,
  llm?: GameLLM,
): Promise<{ applied: number }> {
  if (brief.players.length === 0) return { applied: 0 };
  let applied = 0;
  try {
    // 잡무 티어 — 값의 폭은 코어가 앵커 ±RATING_BAND로 좁게 물려 둔다.
    // 경기마다 도는 일이라 지연이 더 아프다
    const client = llm ?? createGameLLM(TIERS.chore);
    await client.runTurn({
      system: MATCH_RATER_SYSTEM,
      history: [],
      user: buildRatingPrompt(brief),
      tools: [makeRateTool(state, brief.matchId, (n) => (applied = n))],
    });
  } catch {
    // 앵커가 남는다 — 조용히 넘어간다
    return { applied: 0 };
  }
  return { applied };
}
