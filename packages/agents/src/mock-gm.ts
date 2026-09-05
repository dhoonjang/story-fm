import {
  buildOfficeViews,
  clockOf,
  describeNextFixture,
  formatClock,
  headCoachOf,
  makeRng,
  pick,
  teamName,
  type GameState,
} from "@story-fm/engine";
import { MANAGER_ATTRIBUTE_KO } from "@story-fm/domain";
import {
  ScriptedGameLLM,
  agentConfig,
  resolveLlmMode,
  type AgentConfig,
  type AgentName,
  type GameLLM,
} from "@story-fm/llm";
import type { GmTurnResult } from "./gm-types";
import { matchScript, ordersScript, peaceScript } from "./mock-script";

/**
 * **mock 모드가 어느 어댑터를 세우는가** — 그것뿐인 층이다 (docs/llm/agents.md §8).
 *
 * 턴을 도는 것은 실모드와 같은 코드다(`runGmTurn` → `gm-tools.ts`). 여기 있는 함수는
 * 모델 자리에 대본 어댑터를 끼워 넣고, 실모드면 `undefined`를 돌려 부르는 쪽이 실
 * 팩토리(`createGameLLM`)로 넘어가게 한다.
 */

/** 이 턴이 대본에게 알려야 할 것 — 국면과 감독의 말 */
export interface MockTurnFacts {
  /** 감독이 친 말 원문 — 표의 키와 맞춘다 */
  message: string;
  inMatch: boolean;
  /** 첫 휘슬만 여는 턴 */
  kickoff: boolean;
  /** 손잡이가 보낸 턴 — 구간은 코어가 이미 굴렸다 */
  operator: boolean;
  /** 이 턴에 코어가 이미 남긴 기록이 있는가 — 그러면 장면은 그 기록이 세운다 */
  recorded: () => boolean;
}

/** GM·매치 GM 자리의 대본 어댑터 — 실모드면 `undefined` */
export function mockGmLlm(
  config: AgentConfig,
  state: GameState,
  turn: MockTurnFacts,
): GameLLM | undefined {
  if (resolveLlmMode() !== "mock") return undefined;
  return new ScriptedGameLLM(config, () =>
    turn.inMatch
      ? matchScript(state, { kickoff: turn.kickoff, operator: turn.operator })
      : peaceScript(state, turn.message, { recorded: turn.recorded() }),
  );
}

/**
 * 해석기(전술·훈련·시장) 자리의 대본 어댑터 — 실모드면 `undefined`.
 *
 * 감독의 말이 표의 **같은 줄**에서 명령의 인자를 받는다. GM이 그 말을 도구 인자로
 * 그대로 넘기므로(실모드와 같다) 두 걸음이 서로 다른 말을 볼 일이 없다.
 */
export function mockOrdersLlm(
  state: GameState,
  spec: { agent: AgentName; tool: string },
  said: string,
): GameLLM | undefined {
  if (resolveLlmMode() !== "mock") return undefined;
  return new ScriptedGameLLM(agentConfig(spec.agent), () => ordersScript(state, spec.tool, said));
}

/** 수석코치 화자 태그 — 직책이 아니라 그 사람의 이름이다 (people.md §3) */
function coachTag(state: GameState): string {
  return `@${headCoachOf(state).characterId}:`;
}

const ONBOARDING_SCENES = [
  (team: string) =>
    `@: *${team} 트레이닝 센터 정문. 새 감독을 기다리던 카메라 셔터가 일제히 터진다*`,
  (team: string) =>
    `@: *이른 아침의 ${team} 훈련장. 잔디에 물기가 남은 가운데 첫 출근 차량이 멈춰 선다*`,
  (team: string) =>
    `@: *${team} 홈구장 선수 통로. 아직 빈 관중석 너머로 새 시즌 준비 소리가 울린다*`,
  (team: string) =>
    `@: *${team} 구단 사무동. 벽을 채운 역대 시즌 사진 앞에서 새 감독의 첫날이 시작된다*`,
  (team: string) =>
    `@: *여름 이적시장 첫날, ${team} 구단 전화가 쉴 새 없이 울리는 가운데 감독실 문이 열린다*`,
] as const;

const ONBOARDING_WELCOMES = [
  (name: string, tag: string, coach: string) =>
    `${tag} ${name} 감독님, 기다리고 있었습니다. 수석코치 ${coach}입니다. 오늘부터 제가 가장 가까운 자리에서 돕겠습니다.`,
  (name: string, tag: string, coach: string) =>
    `${tag} 어서 오십시오, ${name} 감독님. ${coach}입니다. 첫날부터 결정할 일이 적지 않습니다.`,
  (name: string, tag: string, coach: string) =>
    `${tag} ${name} 감독님, 드디어 뵙는군요. ${coach}라고 합니다 — 이곳의 분위기와 선수단 사정은 제가 솔직하게 말씀드리겠습니다.`,
  (name: string, tag: string, coach: string) =>
    `${tag} 환영합니다, ${name} 감독님. 수석코치 ${coach}입니다. 구단은 새 출발을 준비했고, 선수단은 감독님의 첫마디를 기다리고 있습니다.`,
] as const;

const ONBOARDING_CLOSERS = [
  (tag: string) =>
    `${tag} 먼저 선수단을 들여다보시겠습니까, 아니면 이번 주 훈련 방향부터 정하시겠습니까?`,
  (tag: string) => `${tag} 이적시장, 훈련, 전술 가운데 무엇부터 손대시겠습니까?`,
  (tag: string) =>
    `${tag} 감독님의 첫 결정은 무엇입니까 — 선수단 점검부터 할까요, 훈련장으로 바로 나갈까요?`,
  (tag: string) =>
    `${tag} 개막까지 시간을 어떻게 쓰실지 말씀해 주십시오. 제가 바로 준비하겠습니다.`,
] as const;

/**
 * mock 모드의 첫 장면 — 월드 시드에 따라 장면과 어조가 달라진다 (실모드 폴백 아님).
 *
 * **대본이 글자를 쓰는 유일한 자리다** (agents.md §4-2). 다른 턴은 코어의 기록이
 * 장면을 세우지만, 부임 첫날에는 장부에 아직 기록이 한 줄도 없다.
 */
export function buildOnboardingTurn(state: GameState): GmTurnResult {
  const views = buildOfficeViews(state);
  const attrs = state.manager.attributes;
  const rng = makeRng(state.seed, "onboarding-copy");
  const team = teamName(state.userTeamId);
  const persona = headCoachOf(state);
  const tag = coachTag(state);
  const topAxes = (Object.entries(attrs) as Array<[string, number]>)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([axis]) => MANAGER_ATTRIBUTE_KO[axis as keyof typeof MANAGER_ATTRIBUTE_KO] ?? axis);
  return {
    text: [
      // 첫 장면도 시점을 세우고 연다 — 실모드와 같은 문법이다
      `[${state.date} ${formatClock(clockOf(state))}]`,
      pick(rng, ONBOARDING_SCENES)(team),
      pick(rng, ONBOARDING_WELCOMES)(state.manager.name, tag, persona.name),
      // 코치의 사람됨을 첫 만남에 밝힌다 — motivation은 3인칭 서술이라 대사로 옮기지 않는다
      `${tag} 저에 대해서는 ${persona.traits.join(" · ")} — 그렇게들 말합니다.`,
      `${tag} "${state.manager.background}"이라는 이력도 검토했습니다. 보드는 특히 감독님의 ${topAxes.join("과 ")}을 높이 샀습니다.`,
      `${tag} 스쿼드의 축은 ${views.squad.players
        .slice(0, 3)
        .map((p) => p.name)
        .join(", ")}입니다. ${describeNextFixture(state)}`,
      pick(rng, ONBOARDING_CLOSERS)(tag),
    ].join("\n"),
    toolCalls: [],
  };
}
