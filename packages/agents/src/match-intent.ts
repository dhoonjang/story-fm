import type { GameState } from "@story-fm/engine";
import { agentConfig, createGameLLM, type GameLLM, type GameToolSpec } from "@story-fm/llm";
import { DIRECTIVE_INTENSITIES, PLAYER_DIRECTIVE_KINDS } from "@story-fm/domain";
import { buildLedgerNote } from "./gm-input";
import { MatchIntentSchema, type MatchIntent } from "./match-intent-schema";
import { retryOnce } from "./retry";

/**
 * 지시 해석 — **경기 중 감독의 말을 구조화된 의도 하나로 옮긴다** (agents.md §3).
 *
 * 이 에이전트는 장면도 대사도 쓰지 않는다. 중계는 다음 호출의 몫이고, 여기서
 * 나오는 것은 `MatchIntent` 하나뿐이다. 가른 이유는 두 일이 다른 것을 요구하기
 * 때문이다 — 해석은 구조와 정확도의 문제이고 중계는 문장의 문제다.
 *
 * ## 스킬을 부르지 않는다
 *
 * 산출은 `report_intent` 하나로만 나온다. 그것은 **구조화 출력을 강제하는 그릇**이지
 * 스킬이 아니다(`mood-rater`의 `report_mood`와 같은 자리). 상태를 바꾸는 것은 이
 * 객체를 받은 코어이고, 실재 확인(없는 선수·떠난 표적·우리 쪽 지점)도 거기서 한다.
 * 그래서 프롬프트는 코어가 이미 막는 것을 다시 지시하지 않는다.
 *
 * 반대로 **평시 도구 설명이 갖는 판정 근거는 이 프롬프트가 직접 가져야 한다** — 경기
 * 중에는 도구 표면이 0이라 `SKILL_CATALOG`의 설명이 실리지 않는다. 없으면 같은 판정이
 * 평시와 경기에서 다른 근거로 내려진다 (docs/llm/prompts.md §5).
 */
export const MATCH_INTENT_SYSTEM = `당신은 경기 중 감독의 말을 구조화된 의도로 옮기는 해석기다. 중계도 대사도 쓰지 않고 report_intent 하나로만 답한다.

# 무엇을 고르나
감독이 **명시한 것만** 싣는다. 말하지 않은 축·자리·역할은 보내지 않는다. 프리셋을 적용하거나 전원을 재배치하지 않는다.

# advance — 시계를 미는가
- 감독이 진행하라고 했을 때만 "segment"다. "계속", "봅시다", "돌려", 교체·전술을 지시하며 이어서 보자는 말이 그것이다.
- 선수나 코치를 부르기만 했거나 말만 건 턴은 "none"이다.

# 대화 (talk · teamTalk)
감독이 **그 사람에게 건넨 말**이 있을 때만 싣고, 그 말이 어떻게 닿았는지를 **라벨**로 고른다. 수치는 코어가 만든다.
- 이름을 부르기만 한 말("브루노 일루와봐", "잠깐 와봐")은 부름이지 면담이 아니다 — talk을 비운다.
- outcome은 감독 발화의 (a) 맥락 적합성 (b) 설득 근거 (c) 대상 수용성으로 판정한다.
- talk.outcome — reassured(다독임) · motivated(자극) · neutral · disappointed(실망을 드러냄) · angered(질책)
- teamTalk.outcome — inspired · encouraged · neutral · flat · backfired · feared
- intensity 1~3 — 말의 세기.
- teamTalk.occasion — 킥오프 전 pre · 하프타임 half · 종료 후 post · 그 밖 daily.

# 판을 바꾸는 것
- substitutions — 교체. out/in은 명단의 id.
- tactics — 6축(1~5) 중 감독이 말한 축만.
- playerTactics — 한 선수의 자리·역할·개인 지시.
  - 자리는 move로만 옮긴다: lane(left·center·right) × band(defense=우리 진영, midfield, attack=상대 진영). 지정하지 않은 축은 그대로 둔다. 좌표를 지어내지 않는다.
  - instruction.note는 감독의 말 그대로.
  - instruction.kind가 있어야 판이 움직인다: ${PLAYER_DIRECTIVE_KINDS.join(" · ")}. man_mark·press_target은 targetId가 필요하다.
  - instruction.intensity(${DIRECTIVE_INTENSITIES.join(" · ")}) — 감독이 세기를 말했을 때만. "붙어서 아예 지워버려"는 heavy, "따라가진 말고 견제만"은 light.
  - 다섯 갈래에 담기지 않는 말이면 지역 지시인지 보고 plans를 쓴다.
- plans — 선수 한 명으로 환원되지 않는 지역 지시. band × lane × intent(overload·press·protect·transition)와 감독의 표현 한 줄.
- exploits — 공략 목록에 있는 id만.

# unresolved
어느 갈래에도 담기지 않은 말은 감독의 표현 그대로 unresolved에 남긴다. 비워 두면 감독은 그 지시가 걸린 줄 안다.`;

/** 산출 도구의 JSON 스키마 — Zod와 짝이다 (`MatchIntentSchema`) */
const REPORT_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    talk: {
      type: "array",
      description: "선수·코치와의 대화",
      items: {
        type: "object",
        properties: {
          playerId: { type: "string" },
          outcome: {
            type: "string",
            enum: ["reassured", "motivated", "neutral", "disappointed", "angered"],
          },
          intensity: { type: "integer", enum: [1, 2, 3] },
        },
        required: ["playerId", "outcome", "intensity"],
      },
    },
    teamTalk: {
      type: "object",
      description: "팀 전체를 향한 말",
      properties: {
        occasion: { type: "string", enum: ["pre", "half", "post", "daily"] },
        outcome: {
          type: "string",
          enum: ["inspired", "encouraged", "neutral", "flat", "backfired", "feared"],
        },
        intensity: { type: "integer", enum: [1, 2, 3] },
      },
      required: ["occasion", "outcome", "intensity"],
    },
    substitutions: {
      type: "array",
      items: {
        type: "object",
        properties: { out: { type: "string" }, in: { type: "string" } },
        required: ["out", "in"],
      },
    },
    tactics: {
      type: "object",
      description: "감독이 말한 축만",
      properties: Object.fromEntries(
        ["mentality", "defensiveLine", "pressing", "tempo", "width", "passStyle"].map((axis) => [
          axis,
          { type: "integer", minimum: 1, maximum: 5 },
        ]),
      ),
    },
    playerTactics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          playerId: { type: "string" },
          move: {
            type: "object",
            properties: {
              lane: { type: "string", enum: ["left", "center", "right"] },
              band: { type: "string", enum: ["defense", "midfield", "attack"] },
            },
          },
          position: { type: "string" },
          role: { type: "string" },
          instruction: {
            type: "object",
            properties: {
              note: { type: "string", maxLength: 160 },
              kind: { type: "string", enum: [...PLAYER_DIRECTIVE_KINDS] },
              targetId: { type: "string" },
              intensity: { type: "string", enum: [...DIRECTIVE_INTENSITIES] },
            },
            required: ["note"],
          },
        },
        required: ["playerId"],
      },
    },
    plans: {
      type: "array",
      items: {
        type: "object",
        properties: {
          band: { type: "string", enum: ["defense", "midfield", "attack"] },
          lane: { type: "string", enum: ["left", "center", "right"] },
          intent: { type: "string", enum: ["overload", "press", "protect", "transition"] },
          note: { type: "string", maxLength: 120 },
        },
        required: ["band", "lane", "intent", "note"],
      },
    },
    exploits: { type: "array", items: { type: "string" } },
    advance: { type: "string", enum: ["none", "segment"] },
    unresolved: { type: "string", description: "어느 갈래에도 담기지 않은 말", maxLength: 200 },
  },
  required: ["advance"],
};

function makeReportTool(onIntent: (intent: MatchIntent) => void): GameToolSpec {
  return {
    name: "report_intent",
    description: "감독의 말을 구조화된 의도로 제출한다. 이 도구로만 답한다.",
    inputSchema: REPORT_INPUT_SCHEMA,
    handle: (input: unknown) => {
      const parsed = MatchIntentSchema.safeParse(input);
      if (!parsed.success) {
        // 무엇이 틀렸는지 돌려줘야 모델이 같은 실수를 반복하지 않는다
        return { ok: false, message: `형식이 맞지 않습니다 — ${parsed.error.issues[0]?.message}` };
      }
      onIntent(parsed.data);
      return { ok: true, message: "의도를 받았습니다" };
    },
  };
}

/**
 * 감독의 말 → 의도 하나.
 *
 * **산출이 나온 뒤의 실패는 실패가 아니다** (agents.md §3 ②). `report_intent`가 의도를
 * 낸 다음 이어지는 요청이 깨져도 이 걸음의 산출은 이미 완성돼 있다 — 받은 의도로
 * 진행한다. 그래서 실패 판정은 오직 `intent`가 비었는가로 가른다.
 *
 * **의도 없이 두 번 실패하면 오류다** — 결산과 달리 삼키지 않는다(agents.md §1).
 * 해석하지 못한 턴에 무언가를 짐작해 적용하면 감독이 내리지 않은 지시가 판에 오르고,
 * 그것은 아무 일도 일어나지 않는 것보다 나쁘다.
 */
export async function runMatchIntent(
  state: GameState,
  message: string,
  llm?: GameLLM,
): Promise<{ ok: true; intent: MatchIntent } | { ok: false; message: string }> {
  let intent: MatchIntent | null = null;
  let client = llm;
  try {
    await retryOnce(
      "match:intent",
      () => {
        client ??= createGameLLM(agentConfig("match-intent"));
        return client.runTurn({
          system: MATCH_INTENT_SYSTEM,
          history: [],
          // 명단·현재 6축·걸린 지시·공략 표적이 여기 다 있다 — 중계가 읽는 것과 같은 블록
          user: [buildLedgerNote(state), ``, `[감독]`, message].join("\n"),
          tools: [makeReportTool((value) => (intent = value))],
        });
      },
      () => intent !== null,
    );
  } catch (error) {
    // 삼키는 것이 아니라 판정을 아래로 미룬다 — 무슨 일이 있었는지는 남아야 한다
    console.warn("[match:intent] 해석 호출이 실패했습니다:", error);
  }
  if (intent === null) {
    return { ok: false, message: "지시를 옮기지 못했습니다 — 다시 말씀해 주세요" };
  }
  return { ok: true, intent };
}
