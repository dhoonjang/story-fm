import type { GameState } from "@story-fm/engine";
import { agentConfig, createGameLLM, type GameLLM, type GameToolSpec } from "@story-fm/llm";
import {
  DIRECTIVE_INTENSITIES,
  PLAYER_DIRECTIVE_KINDS,
  SET_PIECE_ROUTINE_AXES,
  SET_PIECE_ROUTINE_NEUTRAL,
  TACTIC_TOGGLES,
  setPieceRoutineChoiceText,
  tacticToggleChoiceText,
} from "@story-fm/domain";
import { buildLedgerNote, buildOperatorMessage } from "./gm-input";
import { MatchIntentSchema, type MatchIntent } from "./match-intent-schema";
import { ModelOutputError, retryOnce, requireToolCall } from "./retry";
import { toToolSchema } from "./tool-schema";

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
 * 스킬이 아니다(캐스터 종료 턴의 `settle_match`와 같은 자리). 상태를 바꾸는 것은 이
 * 객체를 받은 코어이고, 실재 확인(없는 선수·떠난 표적·우리 쪽 지점)도 거기서 한다.
 * 그래서 프롬프트는 코어가 이미 막는 것을 다시 지시하지 않는다.
 *
 * 반대로 **평시 도구 설명이 갖는 판정 근거는 이 프롬프트가 직접 가져야 한다** — 경기
 * 중에는 도구 표면이 0이라 `SKILL_CATALOG`의 설명이 실리지 않는다. 없으면 같은 판정이
 * 평시와 경기에서 다른 근거로 내려진다 (docs/llm/prompts.md §5).
 */
export const MATCH_INTENT_SYSTEM = `당신은 경기 중 감독의 말을 구조화된 의도 하나로 옮기는 해석기다. 중계도 대사도 쓰지 않는다.

# 입력
<ledger>(명단·시각·교체 횟수) · <standing>(걸려 있는 전술과 개인 지시) · <targets>(공략 목록) · <match_log>(이 경기의 지난 턴 전부 — 중계와 감독의 말) 뒤에 이번 턴 감독의 말이 @감독: 으로 온다.

# 무엇을 고르나
감독이 명시한 것만 싣는다. 말하지 않은 축·갈래·자리·역할은 보내지 않는다. 프리셋을 적용하거나 전원을 재배치하지 않는다.

# 대화 (talk · teamTalk)
감독이 그 사람에게 건넨 말이 있을 때만 싣고, 그 말이 어떻게 닿았는지를 라벨로 고른다.
- 이름을 부르기만 한 말("브루노 일루와봐", "잠깐 와봐")은 부름이지 면담이 아니다 — talk을 비운다.
- 이름 없이 가리키면 <match_log>에서 가장 최근에 그 자리에 있던 사람이다. 지시가 앞 턴의 대화를 잇는 말이면 그 대화가 근거다.
- outcome은 감독 발화의 (a) 맥락 적합성 (b) 설득 근거 (c) 대상 수용성으로 판정한다.
- talk.outcome — reassured(다독임) · motivated(자극) · neutral · disappointed(실망을 드러냄) · angered(질책)
- teamTalk.outcome — inspired · encouraged · neutral · flat · backfired · feared
- intensity 1~3 — 말의 세기.
- teamTalk.occasion — 킥오프 전 pre · 하프타임 half · 종료 후 post · 그 밖 daily · 굴러가던 중 정지점에서 팀 전체에 던진 짧은 말 shout("정신 차려", "머리 들어", "진정해").

# 판을 바꾸는 것
- substitutions — 교체. out/in은 <ledger>의 id.
- tactics — 6축(1~5)과 갈래 넷 중 감독이 말한 것만. 갈래는 눈금이 없다 — ${TACTIC_TOGGLES.map(tacticToggleChoiceText).join(" · ")}.
- playerTactics — 한 선수의 자리·역할·개인 지시.
  - 자리는 move로만 옮긴다: lane(left·center·right) × band(defense=우리 진영, midfield, attack=상대 진영). 지정하지 않은 축은 그대로 둔다. 좌표를 지어내지 않는다.
  - instruction.note는 감독의 말 그대로.
  - instruction.kind가 있어야 판이 움직인다: ${PLAYER_DIRECTIVE_KINDS.join(" · ")}. man_mark·press_target은 targetId가 필요하다.
  - instruction.intensity(${DIRECTIVE_INTENSITIES.join(" · ")}) — 감독이 세기를 말했을 때만. "붙어서 아예 지워버려"는 heavy, "따라가진 말고 견제만"은 light.
  - 갈래에 담기지 않는 말이면 지역 지시인지 보고 plans를 쓴다.
- plans — 선수 한 명으로 환원되지 않는 지역 지시. band × lane × intent(overload·press·protect·transition)와 감독의 표현 한 줄.
- exploits — <targets>의 id.
- setPieceTakers — 세트피스 키커. corner·freeKick·penalty 중 감독이 말한 자리만 싣고, 지정을 풀라는 말이면 그 자리에 null을 넣는다.
- setPieceRoutine — 세트피스에 몇 명이 서는가: ${SET_PIECE_ROUTINE_AXES.map(setPieceRoutineChoiceText).join(" · ")}. 감독이 말한 축만 싣고, 지시를 푸는 말이면 ${SET_PIECE_ROUTINE_NEUTRAL}을 넣는다.

# unresolved
어느 갈래에도 담기지 않은 말은 감독의 표현 그대로 unresolved에 남긴다.`;

/** 이 호출의 산출은 이 도구 하나뿐이다 — 요청에 강제로 실린다 (agents.md §3) */
const REPORT_INTENT_TOOL = "report_intent";

/**
 * 중계 턴 본문 하나의 상한 — 지시를 해석하는 데 필요한 것은 누가 무슨 말을 했고 무슨
 * 일이 있었는가이지 중계의 문장 전부가 아니다.
 */
const MATCH_INTENT_TURN_CHARS = 1200;

/**
 * `<match_log>` — **이 경기의 지난 턴 전부** (agents.md §3). 감독의 지시는 앞 턴의
 * 대화를 잇는 말일 때가 많다 — "걔 빼", "아까 말한 대로", "그 자리로 다시". 직전
 * 한두 턴만 실으면 세 턴 전에 부른 선수를 가리키는 말이 `unresolved`로 떨어진다.
 * 모델 턴은 본문(잘라서), 감독 턴은 `@감독:` 봉투, 손잡이 턴은 오퍼레이터 봉투다.
 * 없으면 빈 문자열.
 */
export function buildMatchLogBlock(state: GameState): string {
  const matchId = state.pendingMatch?.matchId;
  const turns = state.chat.filter(
    (t) => t.inMatch === true && (t.matchId === undefined || t.matchId === matchId),
  );
  if (turns.length === 0) return "";
  const lines = turns.map((t) => {
    if (t.role === "user") return `@감독: ${t.text}`;
    if (t.role === "operator") return buildOperatorMessage(t.text);
    return t.text.slice(0, MATCH_INTENT_TURN_CHARS);
  });
  return ["<match_log>", ...lines, "</match_log>"].join("\n");
}

function makeReportTool(onIntent: (intent: MatchIntent) => void): GameToolSpec {
  return {
    name: REPORT_INTENT_TOOL,
    description: "감독의 말을 구조화된 의도로 제출한다. 이 도구로만 답한다.",
    inputSchema: toToolSchema(MatchIntentSchema),
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
  const matchLog = buildMatchLogBlock(state);
  try {
    await retryOnce(
      "match:intent",
      () =>
        requireToolCall(REPORT_INTENT_TOOL, () => {
          client ??= createGameLLM(agentConfig("match-intent"));
          return client.runTurn({
            system: MATCH_INTENT_SYSTEM,
            history: [],
            // 명단·현재 6축과 갈래·걸린 지시·공략 표적만 — 분류에 쓰이지 않는 판세는 빠진다
            // 분류기에는 감독의 이름이 없다 — 자리 태그 하나로 감독의 말을 세운다
            user: [
              buildLedgerNote(state),
              ...(matchLog.length > 0 ? [matchLog] : []),
              ``,
              `@감독: ${message}`,
            ].join("\n"),
            tools: [makeReportTool((value) => (intent = value))],
            toolChoice: { name: REPORT_INTENT_TOOL },
          });
        }),
      () => intent !== null,
    );
  } catch (error) {
    /**
     * **쓸 수 없는 산출만 삼킨다** (agents.md §8). 시한·예산·인증·혼잡·차단은 그대로
     * 올라가 화면이 무슨 일인지 안내한다 — 그것을 "다시 말씀해 주세요"로 바꾸면
     * 감독은 자기 말이 잘못된 줄 알고 같은 말을 다시 쳐서 같은 시한을 한 번 더
     * 기다린다.
     *
     * 단, **의도가 이미 나왔으면 이 걸음은 끝났다** — 그 뒤에 깨진 요청은 위 규칙대로
     * 실패가 아니다.
     */
    if (intent === null && !(error instanceof ModelOutputError)) throw error;
    // 삼키는 것이 아니라 판정을 아래로 미룬다 — 무슨 일이 있었는지는 남아야 한다
    console.warn("[match:intent] 해석 호출이 실패했습니다:", error);
  }
  if (intent === null) {
    return { ok: false, message: "지시를 옮기지 못했습니다 — 다시 말씀해 주세요" };
  }
  return { ok: true, intent };
}
