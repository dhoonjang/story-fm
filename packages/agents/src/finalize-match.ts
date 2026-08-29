import { z } from "zod";
import { ATTRIBUTE_AXES } from "@story-fm/domain";
import {
  ATTR_STEP_MAX,
  ATTR_STEP_MIN,
  MATCH_ATTR_CAP,
  MATCH_FAMILIARITY_MAX,
  MATCH_FAMILIARITY_MIN,
  MOOD_BATCH,
  MOOD_NOTE_MAX,
  RATING_BAND,
  RATING_MAX,
  RATING_MIN,
  applyMoodNotes,
  buildRatingBrief,
  finalizeMatch,
  matchRated,
  pushNews,
  settleMatchRating,
  type GameState,
  type MatchRatingBrief,
} from "@story-fm/engine";
import { agentConfig, createGameLLM, type GameLLM, type GameToolSpec } from "@story-fm/llm";
import { agingDeclineLine } from "./aging-line";
import { sanitizeCasterText } from "./gm-input";
import type { GmToolCall } from "./gm-types";
import { anchorStands, requireToolCall, retryOnce } from "./retry";
import { inputError, toToolSchema } from "./tool-schema";

/**
 * 경기 마감 — **매치 GM의 `finalize_match` 도구 뒤에서 도는 에이전트** (agents.md §3
 * 「경기 마감」). 이 경기의 중계 전부(`<commentary>`)와 기준 평점 표(`<settlement>`)를
 * 읽고, 첫 왕복에 강제된 `settle_match`로 평점·적응도·능력치·심경을 낸 뒤 마무리
 * 중계를 쓴다. 앵커는 코어가 `finalizeMatch`로 먼저 박아 두고 한도로 자른다 —
 * 실패하면 앵커가 남고 마무리는 매치 GM이 쓴다.
 */
export const FINALIZE_MATCH_SYSTEM = `당신은 방금 끝난 축구 경기를 결산하고 마무리 중계를 쓰는 분석가다.

# 입력
- <commentary> — 이 경기의 중계 전부. 흐름·라커룸·벤치의 말이 여기 있다.
- <settlement> — 출전 선수의 기준 평점 표. 결산 도구의 입력이다.

# 순서
결산 도구를 먼저 부르고, 그다음 마무리 중계를 쓴다.

# 마무리 중계
- 경기의 결과와 흐름을 4~8줄로 닫는다 — 결정적인 장면, 경기를 가른 사람, 마지막 휘슬.
- 장면은 @로 연다. @중계: 중계. @: 화자 없는 내레이션, *별표 하나*가 연출. 시각 줄은 쓰지 않는다.
- 한국어. 국내 축구 중계의 관용 표현으로.
- 화자는 게임 내부의 수치를 입에 담지 않는다 — 능력치·전력 점수·확률·평점.`;

/** 이 호출의 산출 — 첫 왕복이 강제한다 (agents.md §3) */
export const SETTLE_MATCH_TOOL = "settle_match";

export const SETTLE_MATCH_DESCRIPTION = `출전한 선수 전원의 경기 결산을 한 번에 제출한다 — 평점과 한 줄 근거, 전술 적응도, 능력치, 심경.
- 기록(골·도움·슛·선방·카드)은 이미 기준 평점에 반영돼 있다. 더할 것은 기록에 안 남는 것이다 — 중계가 그린 지배력, 위기 관리, 실점 장면에서의 책임, 교체 투입 후의 영향, 짧게 뛰고도 흐름을 바꾼 순간.
- 출전 시간을 감안한다. 15분 뛴 교체 선수를 90분 뛴 선수와 같은 잣대로 재지 않는다. 자리를 감안한다. 수비수의 무실점과 공격수의 무득점은 같은 무게가 아니다. 팀 결과에 휩쓸리지 않는다.
- rating — ${RATING_MIN}~${RATING_MAX}, 기준 평점에서 ±${RATING_BAND}를 넘지 않는다. note는 한 문장 40자 안팎 — "무난했다" 같은 빈 말 대신 그 경기의 사실을 적는다.
- drill — 이 경기로 전술 적응도가 얼마나 올랐는가, ${MATCH_FAMILIARITY_MIN}~${MATCH_FAMILIARITY_MAX}. 빠뜨린 선수는 변화가 없는 것으로 본다.
- attribute · attributeStep — 이 경기로 한 축이 움직인 선수만, 0~${MATCH_ATTR_CAP}명, 각 한 축 +${ATTR_STEP_MAX} 또는 −${-ATTR_STEP_MIN}. ${agingDeclineLine()}
- moods — 그 경기가 남긴 심경 한 문장(60자 안팎), ${MOOD_BATCH}명까지. 불만이 걸린 선수는 그 사실을 문장에 담고 acknowledgesIssue를 true로 적는다. 수치(평점·체력·퍼센트)는 문장에 적지 않는다.
- 선수 id는 표의 것을 그대로 돌려준다. 두 번째 제출은 반영되지 않는다.`;

/**
 * 스키마가 받아들이는 폭 — 코어 밴드(`RATING_MIN`~`RATING_MAX`,
 * `MATCH_FAMILIARITY_MIN`~`MATCH_FAMILIARITY_MAX`)보다 넓게 열어 둔다.
 * 벗어난 값은 파싱을 깨뜨리는 대신 코어가 자르므로(`settleMatchRating`),
 * 한 선수의 과한 숫자 하나로 경기 결산 전체가 버려지지 않는다.
 */
const ACCEPTED_RATING_MAX = 20;
const ACCEPTED_DRILL_BOUND = 20;

/** 한 번에 매기는 인원 상한 — 한 경기 명단(선발 + 벤치)보다 넉넉하다 */
const MAX_RATED_PLAYERS = 30;

/** 근거 한 줄의 길이 상한 — 설명은 40자 안팎을 요구하고, 여기는 그 여유다 */
const NOTE_MAX = 200;

const RatingEntrySchema = z.object({
  playerId: z.string().min(1).describe("<settlement> 표의 id 그대로"),
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
const MoodEntrySchema = z.object({
  playerId: z.string().min(1).describe("<settlement> 표의 id 그대로"),
  text: z.string().min(1).max(MOOD_NOTE_MAX).describe("그 선수의 심경 한 문장 (60자 안팎)"),
  /** 그 문장이 불만을 담았는가 — 코어는 낱말을 세지 않는다 (people.md §5) */
  acknowledgesIssue: z.boolean().optional().describe("그 문장이 이 선수의 불만을 담았는가"),
});
const SettleInputSchema = z.object({
  ratings: z.array(RatingEntrySchema).min(1).max(MAX_RATED_PLAYERS),
  moods: z.array(MoodEntrySchema).max(MOOD_BATCH).optional(),
});

/** 모델이 보는 입력 — 위 Zod 한 벌에서 파생한다 (prompts.md §2) */
export const SETTLE_MATCH_INPUT = toToolSchema(SettleInputSchema);

/**
 * 결산 표 — 기준 평점과 기록, 그리고 장부의 사건 줄. 중계는 `<commentary>`가 갖지만
 * 마지막 구간은 아직 중계되기 전에 마감이 불리므로(GM이 도구 뒤에 쓴다) 사건 줄이
 * 그 빈자리를 메운다.
 */
export function buildSettlementMessage(brief: MatchRatingBrief): string {
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
    "<settlement>",
    `최종 스코어: ${brief.scoreline} (우리 팀 ${outcome})`,
    "사건:",
    ...(brief.timeline.length > 0 ? brief.timeline : ["(기록된 사건 없음)"]),
    "채점 대상 (id | 이름 | 자리 | 선발/교체 | 출전시간 | 기준 평점 | 나이·성장 여지·전술적응 | 기록)",
    ...rows,
    "</settlement>",
  ].join("\n");
}

/**
 * 이 경기의 중계 전부 — 저장된 경기 턴의 본문이다. 마감 에이전트가 읽는 흐름의 원본이고,
 * 한 턴이 이 길이를 넘으면 앞머리만 싣는다 (결산에 필요한 것은 장면의 요지다).
 */
const COMMENTARY_TURN_CHARS = 1500;

export function buildCommentaryBlock(state: GameState, matchId: string): string {
  const lines = state.chat
    .filter(
      (t) =>
        t.inMatch === true &&
        t.role === "model" &&
        (t.matchId === undefined || t.matchId === matchId),
    )
    .map((t) => t.text.slice(0, COMMENTARY_TURN_CHARS));
  return ["<commentary>", ...(lines.length > 0 ? lines : ["(중계가 없다)"]), "</commentary>"].join(
    "\n",
  );
}

/**
 * 결산 도구 — 평점·적응도·능력치는 `settleMatchRating`이 한 표식 아래 한 번만 받고,
 * 심경은 출전 선수로 좁혀 `applyMoodNotes`가 검사한다 (agents.md §4-3).
 */
export function makeSettleTool(
  state: GameState,
  brief: MatchRatingBrief,
  onApplied: (applied: number) => void,
): GameToolSpec {
  const allowed = new Set(brief.players.map((p) => p.playerId));
  return {
    name: SETTLE_MATCH_TOOL,
    description: SETTLE_MATCH_DESCRIPTION,
    inputSchema: SETTLE_MATCH_INPUT,
    handle(input: unknown) {
      const parsed = SettleInputSchema.safeParse(input);
      if (!parsed.success) return inputError(parsed.error);
      // 평점·전술 적응도·능력치는 한 표식 아래 한 번만 — 코어가 두 번째 호출을 막는다
      const { applied, skipped, already } = settleMatchRating(
        state,
        brief.matchId,
        parsed.data.ratings,
      );
      if (already) {
        // ok: false로 답하면 모델이 도구 루프를 한 바퀴 더 돈다
        return { ok: true, message: "이 경기의 결산은 이미 반영됐습니다 — 다시 제출하지 마세요" };
      }
      if (applied === 0) {
        return { ok: false, message: "반영된 평점이 없습니다 — 표의 id를 그대로 쓰세요" };
      }
      const moods = applyMoodNotes(state, parsed.data.moods ?? [], allowed);
      onApplied(applied);
      return {
        ok: true,
        message:
          `평점 ${applied}명 반영${skipped > 0 ? ` (${skipped}명은 대상이 아니라 무시)` : ""}` +
          (moods > 0 ? ` · 심경 ${moods}명` : ""),
      };
    },
  };
}

/** 마감 에이전트가 돌려주는 것 — 반영한 인원과 마무리 중계(비면 매치 GM이 쓴다) */
export interface FinalizeOutcome {
  settled: number;
  closing: string;
}

/**
 * 결산과 마무리 중계 — `finalizeMatch` **뒤에** 부른다(앵커가 이미 박혀 있어야 한다).
 * 한 번 다시 시도하되 **실패는 삼킨다** — 결산 하나 때문에 경기 결과가 막히면 안 된다.
 */
export async function runFinalizeMatch(
  state: GameState,
  brief: MatchRatingBrief,
  llm?: GameLLM,
): Promise<FinalizeOutcome> {
  if (brief.players.length === 0) return { settled: 0, closing: "" };
  let settled = 0;
  let closing = "";
  let client = llm;
  await retryOnce(
    "finalize:match",
    () =>
      requireToolCall(SETTLE_MATCH_TOOL, async () => {
        client ??= createGameLLM(agentConfig("finalize-match"));
        const result = await client.runTurn({
          system: FINALIZE_MATCH_SYSTEM,
          history: [],
          user: [
            buildCommentaryBlock(state, brief.matchId),
            ``,
            buildSettlementMessage(brief),
          ].join("\n"),
          tools: [makeSettleTool(state, brief, (n) => (settled = n))],
          toolChoice: { name: SETTLE_MATCH_TOOL },
        });
        closing = sanitizeCasterText(result.text).trim();
        return result;
      }),
    // 장부에 표식이 섰으면 다시 부르지 않는다 — 두 번째 호출은 결산을 두 번 쌓는다
    () => matchRated(state, brief.matchId),
  ).catch(anchorStands("finalize:match"));
  return { settled, closing };
}

/**
 * **경기 마감 한 걸음** — `finalize_match` 도구의 핸들러이자, GM이 마감을 부르지 않은
 * 턴에 코어가 대신 도는 안전망이다 (agents.md §3 「경기 마감」).
 *
 * 순서가 계약이다: 평점 브리프(장부가 살아 있을 때) → `finalizeMatch`(앵커) → 마감
 * 에이전트. 마감 기록은 말풍선(**대회 · "경기 종료"**)으로 서고, 결산은 감독이 부른
 * 적 없는 내부 판정이라 칩으로 세우지 않는다. `null`이면 마감할 장부가 없었다.
 */
export async function finalizeMatchTurn(
  state: GameState,
  calls: GmToolCall[],
  llm?: GameLLM,
): Promise<FinalizeOutcome | null> {
  const brief = buildRatingBrief(state);
  if (!brief) return null;
  const digest = finalizeMatch(state);
  /**
   * 말풍선에는 **우리 경기만** 선다 — 재정과 같은 라운드 다른 경기는 감독이
   * 확인하러 갈 화면(재정·대회)이 이미 갖고 있다. 대신 모델은 다음 평시 턴에
   * 셋을 다 읽는다 (`pendingNews` → `buildGmStateNote`).
   */
  calls.push({
    name: "finalize_match",
    summary: digest.ours.join(" · "),
    brief: { head: "경기 종료", items: digest.ours.map((text) => ({ text })) },
  });
  pushNews(state, [...digest.finance, ...digest.others]);
  const outcome = await runFinalizeMatch(state, brief, llm);
  if (outcome.settled > 0) {
    calls.push({
      name: SETTLE_MATCH_TOOL,
      summary: `경기 결산 ${outcome.settled}명`,
      silent: true,
    });
  }
  return outcome;
}
