import { squadView, type GameState } from "@story-fm/engine";
import type { GameLLM, GameToolSpec } from "@story-fm/llm";
import {
  DIRECTIVE_INTENSITIES,
  PLAYER_DIRECTIVE_KINDS,
  SET_PIECE_ROUTINE_AXES,
  SET_PIECE_ROUTINE_NEUTRAL,
  TACTIC_TOGGLES,
  setPieceRoutineChoiceText,
  tacticToggleChoiceText,
} from "@story-fm/domain";
import {
  buildLedgerNote,
  buildRecentTurnsBlock,
  buildStandingBlock,
  renderTurns,
} from "./gm-input";
import { runOpsOrders, type OpsAgentSpec } from "./orders-ops";
import type { OpsCaps, OpsOrders } from "./orders-ops";

/**
 * 지시 해석 — **경기 중 감독의 말을 구조화된 의도 하나로 옮긴다** (agents.md §3).
 *
 * 이 에이전트는 장면도 대사도 쓰지 않는다. 중계는 다음 호출의 몫이고, 여기서
 * 나오는 것은 `TacticOrders` 하나뿐이다. 가른 이유는 두 일이 다른 것을 요구하기
 * 때문이다 — 해석은 구조와 정확도의 문제이고 중계는 문장의 문제다.
 *
 * ## 도구를 들지 않는다
 *
 * 산출은 `report_tactic_orders` 하나로만 나온다. 그것은 도구가 아니라 **이 호출의 출력
 * 스키마**다(경기 마감의 `settle_match`와 같은 자리). 상태를 바꾸는 것은 이
 * 객체를 받은 코어이고, 실재 확인(없는 선수·떠난 표적·우리 쪽 지점)도 거기서 한다.
 * 그래서 프롬프트는 코어가 이미 막는 것을 다시 지시하지 않는다.
 *
 * 반대로 **평시 도구 설명이 갖는 판정 근거는 이 프롬프트가 직접 가져야 한다** — 경기
 * 중에는 도구 표면이 0이라 `SKILL_CATALOG`의 설명이 실리지 않는다. 없으면 같은 판정이
 * 평시와 경기에서 다른 근거로 내려진다 (docs/llm/prompts.md §5).
 */
/**
 * 전술 해석의 산출 — **다른 두 해석기와 같은 꼴이다** (agents.md §1).
 *
 * 예전에는 여기 코어 명령의 스키마를 손으로 한 벌 더 적었다. 같은 인자가 두 곳에 살면
 * 조용히 갈린다 — 실제로 공략 상한이 해석기 2·명령 4로 어긋나 감독이 부른 지점이 말없이
 * 잘렸고, 경기 중 대화만 정착·심경 인자를 실을 수 없었다. 지금은 `ops`의 스키마를
 * **명령의 도구 정의에서 그대로 묶고**(`buildOpsSchema`) 검증도 그 명령의 Zod가 한다.
 *
 * **숫자는 여기 없다.** 대화의 산출은 사기 델타가 아니라 판정 라벨이고, 변화량은 코어가
 * 표와 리더십 계수로 계산해 한도로 자른다. 실재 확인(없는 선수·떠난 표적·우리 쪽 공략
 * 지점)도 코어가 한다 — 해석은 감독이 **무엇을 말했는지**까지만 책임진다.
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
  "set_match_plan",
  "exploit_point",
  "set_set_piece_takers",
  "set_set_piece_routine",
  "set_shootout_order",
  "team_talk",
  "talk_to_player",
];

/**
 * 명령마다 다른 상한 — **규칙이 정한 수가 있는 자리는 그 수를 쓴다** (match.md §5).
 * 교체는 한 경기 다섯, 개인 지시는 그라운드의 열한 자리, 지역 플랜은 동시에 둘.
 */
export const TACTIC_CAPS: OpsCaps = {
  substitute: 5,
  set_player_tactic: 11,
  set_match_plan: 2,
  talk_to_player: 4,
};

export type TacticOrders = OpsOrders;

export const TACTIC_ORDERS_SYSTEM = `당신은 감독의 전술 지시를 명령의 인자로 옮기는 해석기다. 중계도 대사도 쓰지 않는다. 훈련·육성·이적은 다른 해석기의 몫이다.

# 무엇을 내나
ops에 부를 명령 이름을 적고 그 인자를 배열로 싣는다. 감독이 정한 것만 — 말하지 않은 축·갈래·자리·역할은 보내지 않는다.

# 입력
경기 중에는 <ledger>(명단·시각·교체 횟수) · <standing>(걸려 있는 전술과 개인 지시) · <targets>(공략 목록) · <match_log>(이 경기의 지난 턴 전부 — 중계와 감독의 말), 평시에는 <standing>(지금 걸려 있는 것 전부 — 6축·갈래·세트피스 인원·지역 전술·개인 지시와 역할·완장·세트피스 키커) · <squad>(선발·벤치·예비와 자리) · <recent_turns>(지난 다섯 턴) 뒤에 이번 턴 감독의 말이 @감독: 으로 온다. 바꾸라는 말은 <standing>의 지금 값에서 움직인다.

# 무엇을 고르나
프리셋을 적용하거나 전원을 재배치하지 않는다. 감독이 한 말의 범위 안에서만 움직인다.

# 대화 (talk_to_player · team_talk)
감독이 그 사람에게 건넨 말이 있을 때만 싣고, 그 말이 어떻게 닿았는지를 라벨로 고른다.
- 이름을 부르기만 한 말("브루노 일루와봐", "잠깐 와봐")은 부름이지 면담이 아니다 — 비운다.
- 이름 없이 가리키면 <match_log>에서 가장 최근에 그 자리에 있던 사람이다. 지시가 앞 턴의 대화를 잇는 말이면 그 대화가 근거다.
- outcome은 감독 발화의 (a) 맥락 적합성 (b) 설득 근거 (c) 대상 수용성으로 판정한다.
- intensity 1~3 — 말의 세기. team_talk의 occasion은 킥오프 전 pre · 하프타임 half · 종료 후 post · 그 밖 daily · 굴러가던 중 정지점의 짧은 외침 shout("정신 차려", "머리 들어").
- 그 사람의 심경이 한 줄로 남을 만하면 mood(팀토크는 moods)에 적는다. 새 영입의 적응이 움직였으면 settling에.

# 판을 바꾸는 명령
- set_lineup — 평시에 선발을 새로 짜라는 말에만. 열한 명 전부와 자리(포지션 코드), 2군 선수를 올리면 squadLevels에 first로 함께. 한두 자리만 바꾸는 말은 set_player_tactic이다.
- set_squad_level — 층만 옮기는 1·2군 이동(moves).
- set_captain — 완장. 주장은 playerId, 부주장은 vice(풀라는 말이면 null). 감독이 말한 자리만.
- substitute — 경기 중의 교체 한 건. out/in은 <ledger>의 id. 여럿이면 배열에 여럿.
- set_tactics — 6축(1~5)과 갈래 넷 중 감독이 말한 것만. 갈래는 눈금이 없다 — ${TACTIC_TOGGLES.map(tacticToggleChoiceText).join(" · ")}.
- set_player_tactic — 한 선수의 자리·역할·개인 지시.
  - 자리는 move로만 옮긴다: lane(left·center·right) × band(defense=우리 진영, midfield, attack=상대 진영). 지정하지 않은 축은 그대로 둔다. 좌표를 지어내지 않는다.
  - instruction.note는 감독의 말 그대로. instruction.kind가 있어야 판이 움직인다: ${PLAYER_DIRECTIVE_KINDS.join(" · ")}. man_mark·press_target은 targetId가 필요하다.
  - instruction.intensity(${DIRECTIVE_INTENSITIES.join(" · ")}) — 감독이 세기를 말했을 때만. "붙어서 아예 지워버려"는 heavy, "따라가진 말고 견제만"은 light.
  - 갈래에 담기지 않는 말이면 지역 지시인지 보고 set_match_plan을 쓴다.
- set_match_plan — 선수 한 명으로 환원되지 않는 지역 지시. band × lane × intent(overload·press·protect·transition)와 감독의 표현 한 줄.
- exploit_point — <targets>의 id를 targetIds에.
- set_set_piece_takers — 세트피스 키커. corner·freeKick·penalty 중 감독이 말한 자리만 싣고, 지정을 풀라는 말이면 그 자리에 null을 넣는다.
- set_set_piece_routine — 세트피스에 몇 명이 서는가: ${SET_PIECE_ROUTINE_AXES.map(setPieceRoutineChoiceText).join(" · ")}. 감독이 말한 축만 싣고, 지시를 푸는 말이면 ${SET_PIECE_ROUTINE_NEUTRAL}을 넣는다.
- set_shootout_order — 승부차기 키커 순서. 감독이 이름을 든 사람만.

# unresolved
어느 명령에도 담기지 않은 말은 감독의 표현 그대로 unresolved에 남긴다.`;

/**
 * 평시의 판 — `<standing>`(지금 걸려 있는 것 전부: 6축·갈래·개인 지시·역할·지역 전술·
 * 완장·세트피스 키커 — 경기 장부 노트와 같은 블록) · `<squad>`(선발·벤치·예비와
 * 자리) · `<recent_turns>`(지난 다섯 턴).
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

/**
 * `<match_log>` — **이 경기의 지난 턴 전부** (agents.md §3). 감독의 지시는 앞 턴의
 * 대화를 잇는 말일 때가 많다 — "걔 빼", "아까 말한 대로", "그 자리로 다시". 직전
 * 한두 턴만 실으면 세 턴 전에 부른 선수를 가리키는 말이 `unresolved`로 떨어진다.
 * 없으면 빈 문자열.
 */
export function buildMatchLogBlock(state: GameState): string {
  const matchId = state.pendingMatch?.matchId;
  const turns = state.chat.filter(
    (t) => t.inMatch === true && (t.matchId === undefined || t.matchId === matchId),
  );
  if (turns.length === 0) return "";
  return ["<match_log>", ...renderTurns(turns), "</match_log>"].join("\n");
}

/** 이 해석기의 한 벌 — 강제 선언 목록(`forcedTools`)도 이것을 읽는다 */
export const TACTIC_ORDERS_SPEC: OpsAgentSpec = {
  agent: "tactic-orders",
  tool: "report_tactic_orders",
  system: TACTIC_ORDERS_SYSTEM,
  ops: TACTIC_OPS,
  caps: TACTIC_CAPS,
  opsHint: "부를 명령과 그 인자 — 감독이 말한 것만",
  unresolvedHint: "어느 명령에도 담기지 않은 말",
  emptyHint: "옮길 지시가 없습니다 — 무엇을 바꿀지 감독에게 물어보세요",
};

/**
 * 감독의 말 → 부를 명령과 그 인자.
 *
 * **산출이 나온 뒤의 실패는 실패가 아니다** (agents.md §3 ②) — 산출은 이미 완성돼
 * 있으므로 받은 것으로 진행한다. **산출 없이 두 번 실패하면 도구가 반려로 답한다** —
 * 해석하지 못한 턴에 무언가를 짐작해 적용하면 감독이 내리지 않은 지시가 판에 오르고,
 * 그것은 아무 일도 일어나지 않는 것보다 나쁘다. 뼈대는 세 해석기가 함께 쓴다.
 */
export async function runTacticOrders(
  state: GameState,
  specs: ReadonlyMap<string, GameToolSpec>,
  message: string,
  llm?: GameLLM,
): Promise<{ ok: true; intent: TacticOrders } | { ok: false; message: string }> {
  const matchLog = buildMatchLogBlock(state);
  // 명단·현재 6축과 갈래·걸린 지시·공략 표적만 — 분류에 쓰이지 않는 판세는 빠진다
  // 해석기에는 감독의 이름이 없다 — 자리 태그 하나로 감독의 말을 세운다
  const user = [
    ...(state.pendingMatch
      ? [buildLedgerNote(state), ...(matchLog.length > 0 ? [matchLog] : [])]
      : buildPeaceContext(state)),
    ``,
    `@감독: ${message}`,
  ].join("\n");
  const answered = await runOpsOrders(TACTIC_ORDERS_SPEC, specs, user, llm);
  return answered.ok ? { ok: true, intent: answered.orders } : answered;
}
