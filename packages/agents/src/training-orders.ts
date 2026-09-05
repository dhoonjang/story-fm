import { playerName, squadView, type GameState } from "@story-fm/engine";
import type { GameLLM, GameToolSpec } from "@story-fm/llm";
import { buildRecentTurnsBlock } from "./gm-input";
import { mockOrdersLlm } from "./mock-gm";
import { runOpsOrders, tagged, type OpsAgentSpec, type OpsOrders } from "./orders-ops";

/**
 * 훈련·육성 지시 해석 — **감독의 말을 선수단 운영 명령의 인자로 옮긴다** (agents.md §1).
 *
 * 전술 해석(`tactic-orders`)과 가른 이유는 읽는 것이 다르기 때문이다. 전술은 지금 걸린
 * 판(`<standing>`)에서 움직이고, 훈련은 주간 일정과 지금 걸린 목록(멘토·집중 육성·2군
 * 방침·유스 후보)에서 움직인다. 한 해석기에 둘을 얹으면 경기 중에도 훈련 갈래가 스키마에
 * 서고, 전술 한마디에 훈련 목록이 딸려 바뀐다.
 *
 * 호출의 뼈대는 시장 해석과 한 벌이다(`runOpsOrders`) — 여기 있는 것은 프롬프트와
 * 명령 목록과 입력뿐이다.
 */
export const TRAINING_ORDERS_SYSTEM = `당신은 감독의 훈련·육성 지시를 선수단 운영 명령의 인자로 옮기는 해석기다. 장면도 대사도 판정도 쓰지 않는다. 전술·라인업은 다른 해석기의 몫이다.

# 입력
<schedule>(이번 주 훈련 일정) · <squad_ops>(지금 걸린 멘토링·집중 육성·2군 방침·유스 후보) · <squad>(1·2군 명단과 자리) · <recent_turns>(지난 다섯 턴) 뒤에 이번 턴 감독의 말이 @감독: 으로 온다.

# 무엇을 고르나
감독이 정한 것만 싣는다. 대상·날짜·갈래를 말하지 않았으면 지어내지 않고 unresolved에 남긴다. 이름 없이 가리키면 <recent_turns>에서 가장 최근의 그 사람이다. 선수 인자에는 감독이 부른 이름을 그대로 적는다.

# 명령
- set_training — 훈련의 단일 입구. 감독이 말한 훈련만 등록하고 빈 세션을 임의로 채우지 않는다. 특정 날짜는 sessions, 요일 반복은 repeatWeekly에 오전(am)·오후(pm)·자연어 label·효과 대상 focus(능력치 축 또는 tactical·recovery). 없애는 지시는 clear — rest=true(기본)면 그 자리를 쉬는 날로 못 박고, rest=false면 감독이 잡은 특별 훈련만 걷어 평소 일정으로 돌린다. from·to·dow·slot으로 범위를 좁힌다. 한 선수만 겨냥한 개인 훈련은 player(axis 또는 position, clear=true면 거둔다). 여름 휴가 중에는 감독이 휴가를 접겠다고 했을 때만 recallSquad를 함께 보낸다.
- set_development_focus — 2군 유망주 집중 육성(최대 3). **목록 교체다** — <squad_ops>의 지금 목록에 더하거나 빼서 전체를 다시 적는다. playerIds를 생략하면 해제.
- set_mentor — 고참(1군 30세 이상·리더십 55 이상)에게 23세 이하를 맡긴다(멘토당 3). 그 멘토의 멘티 전체를 다시 적는다. menteeIds 생략은 그 멘토의 사이를 다 푸는 것.
- set_reserve_training — 2군이 겨냥할 축: physical(신체) · technical(기술) · mental(정신) · balanced(해제).
- set_squad_number — 등번호 1~99. 동료가 달고 있으면 반려되고 누가 달았는지가 돌아온다 — 감독이 넘겨받으라고 분명히 말했을 때만 take=true.
- sign_youth — 유스 후보 중 첫 계약을 줄 이름. **한 번의 확정이다** — 감독이 정했을 때만 싣는다. playerIds 생략은 전원 방출.

# unresolved
어느 명령에도 담기지 않은 말, 대상이 빠진 지시는 감독의 표현 그대로 unresolved에 남긴다.`;

/**
 * 해석기가 채우는 **선수단 운영 명령** — **적용 순서다.** 층·번호를 먼저 정하고 그 위에
 * 훈련과 육성을 얹는다: 갓 승격한 선수에게 그날의 개인 훈련이 걸릴 수 있다.
 */
export const TRAINING_OPS: readonly string[] = [
  "sign_youth",
  "set_squad_number",
  "set_reserve_training",
  "set_development_focus",
  "set_mentor",
  "set_training",
];

/** 이 해석기의 한 벌 — 강제 선언 목록(`forcedTools`)도 이것을 읽는다 */
export const TRAINING_ORDERS_SPEC: OpsAgentSpec = {
  agent: "training-orders",
  tool: "report_training_orders",
  system: TRAINING_ORDERS_SYSTEM,
  ops: TRAINING_OPS,
  opsHint: "부를 명령과 그 인자 — 감독이 정한 것만",
  unresolvedHint: "어느 명령에도 담기지 않은 말, 대상이 빠진 지시",
  emptyHint: "옮길 지시가 없습니다 — 무엇을 훈련할지 감독에게 물어보세요",
};

export type TrainingOrders = OpsOrders;

/** `<squad_ops>` — 목록 교체 명령이 지금 목록을 알아야 한다 */
export function buildSquadOpsBlock(state: GameState): string[] {
  const name = (id: string): string => playerName(state, id);
  const mentoring = (state.mentoring ?? []).filter((m) => m.until === undefined);
  const byMentor = new Map<string, string[]>();
  for (const m of mentoring)
    byMentor.set(m.mentorId, [...(byMentor.get(m.mentorId) ?? []), m.menteeId]);
  const focus = state.developmentFocus ?? [];
  const youth = (state.youthCandidates ?? []).filter((c) => c.teamId === state.userTeamId);
  return tagged(
    "squad_ops",
    [
      `멘토링: ${
        byMentor.size > 0
          ? [...byMentor].map(([m, ids]) => `${name(m)} → ${ids.map(name).join("·")}`).join(" / ")
          : "없음"
      }`,
      `집중 육성: ${focus.length > 0 ? focus.map(name).join("·") : "없음"}`,
      `2군 훈련 방침: ${state.reserveTraining ?? "balanced"}`,
      ...(youth.length > 0
        ? [
            `유스 후보 (${youth[0]!.deadline}까지): ${youth
              .map((c) => `${c.player.id} ${c.player.name}`)
              .join(" · ")}`,
          ]
        : []),
    ].join("\n"),
  );
}

/** 해석기의 입력 — 이번 주 일정·지금 걸린 목록·명단·지난 다섯 턴 */
export function buildTrainingContext(state: GameState, schedule: string): string[] {
  return [
    ...tagged("schedule", schedule),
    ...buildSquadOpsBlock(state),
    ...tagged("squad", squadView(state, { level: "all" }).message),
    ...tagged("recent_turns", buildRecentTurnsBlock(state)),
  ];
}

/**
 * 감독의 말 → 선수단 운영 명령의 인자. 전술 해석과 같은 계약이다(agents.md §1) —
 * 산출이 나온 뒤의 실패는 실패가 아니고, 산출 없이 두 번 실패하면 도구가 반려로 답한다.
 */
export async function runTrainingOrders(
  state: GameState,
  specs: ReadonlyMap<string, GameToolSpec>,
  schedule: string,
  message: string,
  llm?: GameLLM,
): Promise<{ ok: true; orders: TrainingOrders } | { ok: false; message: string }> {
  const user = [...buildTrainingContext(state, schedule), ``, `@감독: ${message}`].join("\n");
  return runOpsOrders(
    TRAINING_ORDERS_SPEC,
    specs,
    user,
    llm ?? mockOrdersLlm(state, TRAINING_ORDERS_SPEC, message),
  );
}
