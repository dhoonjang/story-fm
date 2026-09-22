import { squadView, type GameState } from "@story-fm/engine";
import type { GameLLM, GameToolSpec } from "@story-fm/llm";
import {
  SET_PIECE_ROUTINE_AXES,
  SET_PIECE_ROUTINE_NEUTRAL,
  TACTIC_TOGGLES,
  roleVocabularyText,
  setPieceRoutineChoiceText,
  tacticToggleChoiceText,
  type BoardMove,
} from "@story-fm/domain";
import { buildBoardMovesBlock, buildRecentTurnsBlock, buildStandingBlock } from "./gm-input";
import { mockOrdersLlm } from "./mock-gm";
import { runOpsOrders, type OpsAgentSpec } from "./orders-ops";
import type { OpsCaps, OpsOrders } from "./orders-ops";

/**
 * 전술 해석 — **평시 감독의 판 지시를 명령의 인자로 옮긴다** (agents.md §1).
 *
 * 이 에이전트는 장면도 대사도 쓰지 않는다. 산출은 `{ ops, unresolved }` JSON 하나이고
 * (도구가 아니라 이 호출의 출력 스키마다 — models.md §3-2), 상태를 바꾸는 것은 그
 * 객체를 받은 코어다. 실재 확인(없는 선수·떠난 표적)도 거기서 하므로 프롬프트는 코어가
 * 이미 막는 것을 다시 지시하지 않는다.
 *
 * 반대로 **평시 도구 설명이 갖는 판정 근거는 이 프롬프트가 직접 가져야 한다** —
 * 해석기의 요청에는 `SKILL_CATALOG`의 설명이 실리지 않는다. 없으면 같은 판정이 자리마다
 * 다른 근거로 내려진다 (docs/llm/prompts.md §5).
 *
 * 경기 중의 판은 판독기가 쓴다 (`match-reader.ts`).
 */

/**
 * 해석기가 채우는 **판의 명령** — **적용 순서다.**
 *
 * 판을 먼저 세우고(라인업·1·2군·완장) 교체를 넣은 뒤에 그 위의 지시가 온다 — 뒤이은
 * 지시가 방금 들어온 선수를 겨냥할 수 있기 때문이다. 대화는 판이 다 선 뒤에 남긴다.
 */
export const TACTIC_OPS: readonly string[] = [
  "set_lineup",
  "set_squad_level",
  "set_captain",
  "substitute",
  "set_tactics",
  "set_player_tactic",
  "set_set_piece_takers",
  "set_set_piece_routine",
  "set_shootout_order",
  "team_talk",
];

/**
 * 명령마다 다른 상한 — **규칙이 정한 수가 있는 자리는 그 수를 쓴다** (match.md §5).
 * 교체는 한 경기 다섯, 자리·역할은 그라운드의 열한 자리. 판독기도 같은 자를 쓴다.
 */
export const TACTIC_CAPS: OpsCaps = {
  substitute: 5,
  set_player_tactic: 11,
  /**
   * 대화는 도구 하나가 `players`로 여럿을 담는다 — 한 턴에 셋이면 라커룸 하나와
   * 마주 앉은 둘까지다. 대상마다 한 건이던 넷은 도구가 갈려 있을 때의 수다.
   */
  team_talk: 3,
};

export type TacticOrders = OpsOrders;

export const PLAYER_POSITION_INSTRUCTION =
  "포지션 지정·맞교환은 position 코드로 옮긴다. 맞교환은 현재 두 선수의 position을 서로 바꾼 두 명령이다. 방향만 지정한 이동은 move(lane: left·center·right, band: defense·midfield·attack)를 쓰고 나머지 축은 유지한다. position과 move는 함께 보내지 않는다.";

export const TACTIC_ORDERS_SYSTEM = `당신은 감독의 전술 지시를 명령의 인자로 옮기는 해석기다. 중계도 대사도 쓰지 않는다. 훈련·육성·이적은 다른 해석기의 몫이다.

# 무엇을 내나
ops에 부를 명령 이름을 적고 그 인자를 배열로 싣는다. 감독이 정한 것만 — 말하지 않은 축·자리·역할은 보내지 않는다.
한 문장이 명령 여럿을 담는다("베스트 11로 가고 수비 라인은 깊게"는 set_lineup과 set_tactics다). 옮길 수 있는 것은 다 싣고 막힌 말만 unresolved에 남긴다 — 하나를 못 옮기는 것이 나머지를 버릴 이유가 아니다.
감독이 정하지 않고 맡긴 말("알아서 짜세요", "당신이 판단해서")에는 채울 인자가 없다 — 지어내지 않고 unresolved에 남긴다.

# 입력
<standing>(지금 걸려 있는 것 전부 — 6축·갈래·세트피스 인원·자리별 역할·완장·세트피스 키커) · <squad>(선발·벤치·예비와 자리) · <recent_turns>(지난 다섯 턴) 뒤에 이번 턴 감독의 말이 @감독: 으로 온다. 바꾸라는 말은 <standing>의 지금 값에서 움직인다.
<board_moves>는 이번 턴 감독이 전술판에서 직접 움직인 것이고, 그 조작은 <standing>에 이미 반영돼 있다.

# 무엇을 고르나
프리셋을 적용하거나 전원을 재배치하지 않는다. 감독이 한 말의 범위 안에서만 움직인다.

# 판에서 이미 움직인 것
<board_moves>의 축·선수·자리를 가리키는 말은 감독의 말을 그 줄의 앞 값에 대 본다.
판이 간 곳과 같으면 감독이 방금 판에서 한 일을 말로 설명한 것이다 — 그 명령을 싣지 않는다.
다른 곳을 가리키면(더 멀리·반대로) <standing>의 지금 값에서 움직여 싣는다.

# 대화 (team_talk)
감독이 그 사람에게 건넨 말이 있을 때만 싣고, 그 말이 어떻게 닿았는지를 라벨로 고른다.
- 판정은 의미 있는 대화가 마무리된 턴에 한 번이다 — 감독이 자리를 뜨거나 화제가 닫히거나 장면이 넘어갈 때. 대화 도중에는 싣지 않는다.
- 이름을 부르기만 한 말(“브루노 일루와봐”, “잠깐 와봐”)은 부름이지 대화가 아니다 — 비운다.
- players에 이름을 적으면 그 사람들, 비우면 선수단 전체다. 이름 없이 가리키면 <recent_turns>에서 가장 최근에 그 자리에 있던 사람이다. 지시가 앞 턴의 대화를 잇는 말이면 그 대화가 근거다.
- outcome은 감독 발화의 (a) 맥락 적합성 (b) 설득 근거 (c) 대상 수용성으로 판정한다. inspired는 드물다 — 말이 그 사람의 처지에 정확히 닿고 근거가 섰을 때만이고, 평범한 격려는 encouraged다.
- intensity 1~3 — 말의 세기. occasion은 킥오프 전 pre · 하프타임 half · 종료 후 post · 그 밖 daily · 굴러가던 중 정지점의 짧은 외침 shout(“정신 차려”, “머리 들어”).
- promise는 이번 턴에 감독이 그 사람에게 못 박은 약속(출전·이적 허용·재계약·주장·등번호)만. 지난 턴의 약속을 다시 싣지 않고, 이미 말해 뒀다는 말과 선발에서 빼는 말에는 약속이 없다.
- 그 사람의 심경이 한 줄로 남을 만하면 moods에 적는다. 새 영입의 적응이 움직였으면 settling에.

# 판을 바꾸는 명령
- set_lineup — 선발을 바꾸는 말에. 바뀌는 자리만 싣는다 — 부르지 않은 자리는 지금 선발이 지킨다. 자리는 포지션 코드로, 2군 선수를 올리면 squadLevels에 first로 함께. 벤치에 앉은 선수를 그라운드에 세우는 것도 이 명령이다 — set_player_tactic은 이미 뛰는 선수의 자리만 옮긴다.
- set_squad_level — 층만 옮기는 1·2군 이동(moves).
- set_captain — 완장. 주장은 playerId, 부주장은 vice(풀라는 말이면 null). 감독이 말한 자리만.
- substitute — 교체 한 건. out/in은 선수 id. 여럿이면 배열에 여럿.
- set_tactics — 6축(1~5)과 갈래 넷 중 감독이 말한 것만. 갈래는 눈금이 없다 — ${TACTIC_TOGGLES.map(tacticToggleChoiceText).join(" · ")}.
- set_player_tactic — 한 선수의 자리와 역할.
  - ${PLAYER_POSITION_INSTRUCTION}
  - role은 그 자리의 역할이다 — 감독이 시키는 일이 「자리별 역할」의 한 종이면 그것을 적는다. 이름·id·약어 어느 표기든 걸린다. 표에 없는 말은 unresolved에 남긴다.
- set_set_piece_takers — 세트피스 키커. corner·freeKick·penalty 중 감독이 말한 자리만 싣고, 지정을 풀라는 말이면 그 자리에 null을 넣는다.
- set_set_piece_routine — 세트피스에 몇 명이 서는가: ${SET_PIECE_ROUTINE_AXES.map(setPieceRoutineChoiceText).join(" · ")}. 감독이 말한 축만 싣고, 지시를 푸는 말이면 ${SET_PIECE_ROUTINE_NEUTRAL}을 넣는다.
- set_shootout_order — 승부차기 키커 순서. 감독이 이름을 든 사람만.

# 자리별 역할 (set_player_tactic의 role)
${roleVocabularyText()}

# unresolved
어느 명령에도 담기지 않은 말은 감독의 표현 그대로 unresolved에 남긴다. 훈련·육성·이적의 말은 남기지 않는다.`;

/**
 * 평시의 판 — `<standing>`(지금 걸려 있는 것 전부: 6축·갈래·역할·완장·세트피스 키커 —
 * 경기 장부 노트와 같은 블록) · `<squad>`(선발·벤치·예비와 자리) ·
 * `<recent_turns>`(지난 다섯 턴).
 */
function buildPeaceContext(state: GameState): string[] {
  const squad = squadView(state, {});
  const recent = buildRecentTurnsBlock(state);
  return [
    ...buildStandingBlock(state),
    `<squad>`,
    squad.message,
    `</squad>`,
    ...(recent.length > 0 ? [`<recent_turns>`, recent, `</recent_turns>`] : []),
  ];
}

/** 이 해석기의 한 벌 — 출력 스키마 선언 열(`outputAgents`)도 이것을 읽는다 */
export const TACTIC_ORDERS_SPEC: OpsAgentSpec = {
  agent: "tactic-orders",
  system: TACTIC_ORDERS_SYSTEM,
  ops: TACTIC_OPS,
  caps: TACTIC_CAPS,
  opsHint: "부를 명령과 그 인자 — 감독이 말한 것만",
  unresolvedHint: "어느 명령에도 담기지 않은 말",
  emptyHint: "이 말에는 옮길 전술 지시가 없습니다",
};

/**
 * 감독의 말 → 부를 명령과 그 인자.
 *
 * **산출이 나온 뒤의 실패는 실패가 아니다** (agents.md §3 ②) — 산출은 이미 완성돼
 * 있으므로 받은 것으로 진행한다. **산출 없이 두 번 실패하면 도구가 반려로 답한다** —
 * 해석하지 못한 턴에 무언가를 짐작해 적용하면 감독이 내리지 않은 지시가 판에 오르고,
 * 그것은 아무 일도 일어나지 않는 것보다 나쁘다. 뼈대는 해석기 넷이 함께 쓴다.
 */
export async function runTacticOrders(
  state: GameState,
  specs: ReadonlyMap<string, GameToolSpec>,
  message: string,
  options: {
    llm?: GameLLM;
    /** 이번 턴 전술판이 이미 움직인 것 — `<board_moves>`가 된다 */
    boardMoves?: readonly BoardMove[];
  } = {},
): Promise<{ ok: true; intent: TacticOrders } | { ok: false; message: string }> {
  /**
   * 판이 이번 턴에 움직인 것은 **감독의 말 바로 앞**에 선다 — 되풀이를 가리는 판정이
   * 그 말을 읽는 자리에서 이뤄진다 (agents.md §3).
   */
  const boardMoves = buildBoardMovesBlock(state, options.boardMoves ?? []);
  // 해석기에는 감독의 이름이 없다 — 자리 태그 하나로 감독의 말을 세운다
  const user = [...buildPeaceContext(state), ...boardMoves, ``, `@감독: ${message}`].join("\n");
  const answered = await runOpsOrders(
    TACTIC_ORDERS_SPEC,
    specs,
    user,
    options.llm ?? mockOrdersLlm(state, TACTIC_ORDERS_SPEC, message),
    message,
  );
  return answered.ok ? { ok: true, intent: answered.orders } : answered;
}
