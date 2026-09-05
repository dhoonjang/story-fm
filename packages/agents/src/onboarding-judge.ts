import { z } from "zod";
import {
  MANAGER_ATTRIBUTE_KO,
  MANAGER_ATTRIBUTES,
  OPENING_KINDS,
  OPENING_KIND_KO,
  OPENING_LINE_MAX,
  OPENING_TITLE_MAX,
  ageOf,
  naturalPositionOf,
  type ManagerAttributes,
} from "@story-fm/domain";
import {
  ATTRIBUTE_JUDGE_BAND,
  ATTRIBUTE_SUM_BAND,
  MAX_OPENINGS,
  START_MAX_WALLET,
  WALLET_JUDGE_BAND,
  clampJudgedAttributes,
  clampStartingWallet,
  clockOf,
  formatClock,
  headCoachOf,
  humanizePlayerIds,
  ownerOf,
  playersOf,
  seedOpenings,
  selectCharacters,
  startingWalletAnchor,
  teamNameIn,
  tierOfTeamIn,
  type GameState,
} from "@story-fm/engine";
import {
  agentConfig,
  createGameLLM,
  resolveLlmMode,
  type GameLLM,
  type GameToolSpec,
} from "@story-fm/llm";
import {
  buildGmStateNote,
  describeCharacters,
  parseSceneHeader,
  sanitizeSceneText,
} from "./gm-input";
import type { GmTurnResult } from "./gm-types";
import { buildOnboardingTurn } from "./mock-gm";
import { retryOnce, requireToolCall, ModelOutputError } from "./retry";
import { inputError, toToolSchema } from "./tool-schema";

/**
 * **온보딩** — 새 게임이 서기 전에 딱 한 번 도는 호출 (career.md §1 · agents.md §4-2).
 *
 * **판정과 첫 장면을 한 호출이 낸다.** 갈라 두면 장면을 쓰는 쪽은 방금 정해진 결이
 * 무엇인지 스냅샷으로만 알고, 시작 사건을 고른 쪽은 그것이 어떤 장면으로 열릴지 모른다 —
 * 같은 머리가 실마리를 고르고 그 실마리를 심는 장면을 쓰는 것이 온보딩의 자연스러운 꼴이다.
 * 순서는 경기 마감과 같다(§3): 산출 도구를 먼저 부르고, 그 뒤 본문으로 장면을 쓴다.
 *
 * 세 가지를 낸다 — 시작 지갑 · 능력치의 결(앵커에서 축당 ±8, 합 ±10) · 시작 사건(셋까지,
 * 그 줄이 이름을 부르는 실재하는 사람에게만 걸어서). 능력치의 총량은 앵커가 쥔다 — 판정이 옮기는 것은
 * "이 사람은 어느 축이 두꺼운가"뿐이다.
 */
export const ONBOARDING_JUDGE_SYSTEM = `당신은 새로 부임하는 축구 감독의 이력을 읽고, 그 감독의 부임 첫날을 여는 사람이다.

배경 한 문단과 부임 구단의 사실을 읽고 셋을 판정한다 — 부임 전까지 모아 둔 개인 자산, 다섯 능력치의 결, 부임 첫 몇 주를 이끌 시작 사건. 그다음 그 판정 위에서 부임 첫날의 첫 장면을 쓴다.

# 입력
<anchor> — 코어가 박은 기준값: 지갑 앵커와 폭, 능력치 다섯 축의 앵커와 폭. 앵커가 이미 커리어 등급과 부임 구단의 격을 반영한다 — 당신이 읽는 것은 그 안에서의 결이다.
<club> — 부임 구단: 이름·격·구단주·수석코치·주장·핵심 선수·유망주. 시작 사건에 걸 수 있는 사람은 여기 적힌 id뿐이다.
<background> — 배경 문단.
<characters> — 첫 장면에 세울 수석코치의 카드: 성격·말투·관계.
<snapshot> — 오늘 날짜와 선수단·일정의 사실. 첫 장면이 짚을 것이 여기 있다.

# 순서
판정 도구를 먼저 부르고, 그다음 첫 장면을 쓴다.

# 지갑
- 돈이 도는 일을 했으면 위로 — 에이전트, 단장, 사업, 광고, 방송, 스타 선수의 계약. 오래 벌었으면 위로.
- 짧거나 벌이가 얇은 이력은 아래로 — 유소년 코치, 무명, 부상 은퇴, 빚, 실패한 사업.
- 배경이 돈에 대해 말하지 않으면 앵커 그대로다.

# 능력치
- 앵커에서 축마다 폭 안에서만 움직인다. 합은 앵커의 합 근처다 — 한 축을 올리면 다른 축이 내려간다.
- 배경이 두껍게 적은 일이 그 축이다: 선수 시절·주장은 리더십, 전술 연구·코치는 전술, 피지컬·재활은 훈련, 에이전트·단장은 협상, 데이터·스카우트는 분석.
- 배경이 말하지 않은 축은 앵커 그대로다.

# 시작 사건
- 셋까지. 배경과 구단의 사실이 만나는 자리에서 고른다 — 낙하산 감독에게는 언론의 이름표가, 옛 선수 출신에게는 라커룸의 시선이, 빚을 진 감독에게는 개인사가 선다.
- 갈래는 ${OPENING_KINDS.map((k) => `${k}(${OPENING_KIND_KO[k]})`).join(" · ")}.
- title은 이름 하나, line은 사실의 꼴로 — 무엇이 걸려 있고 누가 지켜보는가. 결말을 적지 않는다. 문장은 GM이 쓴다.
- subjectId는 <club>에 적힌 id만, 그리고 그 사람의 이름을 title이나 line에 실제로 쓴 실마리에만 건다. 줄이 아무도 부르지 않으면 비운다 — 언론·보드는 사람 없이 서는 것이 자연스럽다.

# 첫 장면
오늘은 감독의 부임 첫날이다. **수석코치의 말로 연다** — 감독을 맞이하고, 오늘 감독이 정할 것을 앞에 놓는다.
- 방금 세운 시작 사건이 이 장면의 재료다. 실마리를 결말 없이 심는다 — 누가 기다리고 있고 무엇이 걸려 있는지까지.
- <snapshot>의 사실을 짚는다 — 소집일, 다음 일정, 몸이 성치 않은 선수. 없는 사실을 지어내지 않는다.
- 감독은 유저가 연기한다 — **감독의 말을 대신 쓰지 마라.** 장면은 감독이 답할 자리에서 닫는다.
- 4~10줄. 판정의 근거나 수치는 장면에 적지 않는다 — 능력치·지갑 액수·확률.

# 출력 문법
장면은 @로 연다 — 시각 줄은 코어가 붙인다.
- @이름: 사람의 말 — 수석코치는 <characters>의 id로 태그를 단다.
- @: 화자 없는 내레이션. *별표 하나*로 감싼 것이 행동·연출이다.
- 같은 화자가 이어 말하면 태그를 다시 적지 않는다.
- 한국어.

# 규칙
- 앵커에 없는 사실을 지어내지 마라. 근거는 배경에서 실제로 읽은 것만, 40자 안팎.
- 앵커에서 크게 벗어나도 코어가 잘라내므로 결을 정직하게 반영하는 것이 낫다.`;

const attribute = z.number().int().min(0).max(100);

const ReportInputSchema = z.object({
  wallet: z
    .number()
    .int()
    .min(0)
    .max(START_MAX_WALLET)
    .describe("이 감독이 부임 전까지 모아 둔 개인 자산 (£)"),
  reason: z.string().min(1).max(80).describe("배경에서 읽은 근거 한 줄 (40자 안팎)"),
  attributes: z
    .object({
      leadership: attribute,
      tactics: attribute,
      training: attribute,
      negotiation: attribute,
      analysis: attribute,
    })
    .partial()
    .optional()
    .describe("앵커에서 움직일 축만 — 말하지 않은 축은 앵커 그대로"),
  openings: z
    .array(
      z.object({
        kind: z.enum(OPENING_KINDS),
        title: z.string().min(1).max(OPENING_TITLE_MAX),
        line: z.string().min(1).max(OPENING_LINE_MAX).describe("사실의 꼴로 — 결말 없이"),
        subjectId: z
          .string()
          .min(1)
          .optional()
          .describe("<club>에 적힌 id만 — 그 이름이 title·line에 서지 않으면 코어가 뗀다"),
      }),
    )
    .max(MAX_OPENINGS)
    .optional(),
});
type ReportInput = z.infer<typeof ReportInputSchema>;

/** 이 호출의 산출은 이 도구 하나뿐이다 — 요청에 강제로 실린다 (agents.md §3) */
export const REPORT_ONBOARDING_TOOL = "report_onboarding";

export const REPORT_ONBOARDING_DESCRIPTION =
  "이 감독의 시작 자산·능력치의 결·시작 사건을 제출한다. 폭을 벗어난 값은 코어가 잘라낸다.";

/** 모델이 보는 입력 — 위 Zod 한 벌에서 파생한다 (prompts.md §2) */
export const REPORT_ONBOARDING_INPUT = toToolSchema(ReportInputSchema);

/** 핵심 선수 수 — 시작 사건이 걸 수 있는 이름의 수이지 스쿼드 목록이 아니다 */
const CLUB_KEY_PLAYERS = 4;
const CLUB_PROSPECTS = 2;

/** `<club>` — 시작 사건이 걸 수 있는 사람과 구단의 격. 사실만 (prompts.md §5) */
export function buildClubBlock(state: GameState): string {
  const squad = playersOf(state, state.userTeamId);
  const row = (p: (typeof squad)[number]): string =>
    `${p.id} ${p.name} · ${ageOf(p.birthdate, state.date)}세 ${naturalPositionOf(p).position} · 종합 ${p.attributes.overall}`;
  const captain = squad.find((p) => p.isCaptain);
  const key = [...squad]
    .sort((a, b) => b.attributes.overall - a.attributes.overall)
    .slice(0, CLUB_KEY_PLAYERS);
  const prospects = squad
    .filter((p) => ageOf(p.birthdate, state.date) <= 21)
    .sort((a, b) => b.attributes.potential - a.attributes.potential)
    .slice(0, CLUB_PROSPECTS);
  const owner = ownerOf(state);
  const coach = headCoachOf(state);
  return [
    `<club name="${teamNameIn(state, state.userTeamId)}">`,
    `격: tier ${tierOfTeamIn(state, state.userTeamId)}`,
    `구단주: ${owner.characterId} ${owner.name}`,
    `수석코치: ${coach.characterId} ${coach.name}`,
    `주장: ${captain ? row(captain) : "없음"}`,
    `핵심 선수:`,
    ...key.map((p) => `- ${row(p)}`),
    ...(prospects.length > 0 ? [`유망주:`, ...prospects.map((p) => `- ${row(p)}`)] : []),
    `</club>`,
  ].join("\n");
}

/** `<anchor>` — 지갑과 능력치의 앵커와 폭 */
export function buildAnchorBlock(walletAnchor: number, attributes: ManagerAttributes): string {
  const low = Math.round(walletAnchor * (1 - WALLET_JUDGE_BAND));
  const high = Math.round(walletAnchor * (1 + WALLET_JUDGE_BAND));
  return [
    `<anchor>`,
    `지갑: £${walletAnchor.toLocaleString("en-US")} — £${low.toLocaleString("en-US")} ~ £${high.toLocaleString("en-US")}`,
    `능력치 (축마다 ±${ATTRIBUTE_JUDGE_BAND}, 합은 ±${ATTRIBUTE_SUM_BAND}): ` +
      MANAGER_ATTRIBUTES.map((a) => `${MANAGER_ATTRIBUTE_KO[a]} ${attributes[a]}`).join(" · "),
    `</anchor>`,
  ].join("\n");
}

/**
 * 프롬프트 본문 — 앵커 · 구단 · 배경 · 수석코치 카드 · 스냅샷.
 *
 * ⚠️ **수석코치의 카드는 지목으로 세운다.** 이력도 지난 발화도 없어 키워드가 걸릴 문장
 * 자체가 없다 — 검증(`isValidOnboardingText`)이 요구하는 그 id가 프롬프트에 실리는
 * 자리가 여기뿐이다. 카드가 내려가면 모델은 직책으로 태그를 달고 첫 장면이 매번 반려된다.
 *
 * 스냅샷은 첫 장면이 짚을 사실(소집일·일정·몸 상태)을 갖는다. `<openings>`는 아직 비어
 * 있다 — 이 호출이 그것을 **정하는** 자리라, 장면의 재료는 스냅샷이 아니라 방금 부른
 * 도구의 인자다.
 */
export function buildOnboardingJudgePrompt(
  state: GameState,
  background: string,
  walletAnchor: number,
): string {
  const coach = describeCharacters(
    selectCharacters(state, { pointed: [headCoachOf(state).characterId] }),
  );
  return [
    buildAnchorBlock(walletAnchor, state.manager.attributes),
    buildClubBlock(state),
    `<background>`,
    background,
    `</background>`,
    ...(coach ? [coach] : []),
    buildGmStateNote(state),
  ].join("\n");
}

/**
 * 첫 장면 검사 — 문법과 화자(수석코치 등장·감독 미발화)까지만 본다. 내용은 보지 않는다.
 */
function isValidOnboardingText(state: GameState, text: string): boolean {
  // 첫 줄의 시점 헤더는 문법의 일부다 — 본문만 떼어 검사한다
  const lines = parseSceneHeader(text)
    .body.split("\n")
    .filter((line) => line.trim().length > 0);
  const coachTag = `@${headCoachOf(state).characterId}:`;
  return (
    lines.length >= 2 &&
    lines.length <= 12 &&
    // 장면은 `@`로 연다 — 그 뒤의 태그 없는 줄은 이어쓰기다 (prompts.md §1)
    (lines[0] ?? "").startsWith("@") &&
    lines.some((line) => line.startsWith(coachTag)) &&
    // 감독은 유저의 몫이다 — GM이 대신 말하면 첫 턴부터 규약이 깨진다
    !lines.some((line) => line.startsWith(`@${state.manager.name}:`))
  );
}

function makeReportTool(onReport: (report: ReportInput) => void): GameToolSpec {
  return {
    name: REPORT_ONBOARDING_TOOL,
    description: REPORT_ONBOARDING_DESCRIPTION,
    inputSchema: REPORT_ONBOARDING_INPUT,
    handle: (input: unknown) => {
      const parsed = ReportInputSchema.safeParse(input);
      if (!parsed.success) return inputError(parsed.error);
      onReport(parsed.data);
      return { ok: true, message: "판정 접수" };
    },
  };
}

/**
 * **새 게임 한 호출** — 배경 → 지갑 · 능력치의 결 · 시작 사건, 그리고 부임 첫날의 첫
 * 장면. 상태를 직접 고치고 장면을 돌려준다 (career.md §1 · agents.md §4-2).
 *
 * ⚠️ **폴백이 없다 — 실패하면 게임을 만들지 않는다.** 판정만 있을 때는 앵커가 답이 될 수
 * 있었지만, 첫 장면에는 답을 대신할 앵커가 없다. 규칙 장면으로 열어 두면 유저는 그것이
 * 이 게임의 첫 장면인 줄 알고 다시 시작할 기회를 잃는다. 호출 실패·잘린 응답·문법 위반은
 * 한 번 다시 시도하고, 그래도 안 되면 오류를 올린다.
 *
 * 다시 불러도 남는 자국이 없다 — 도구는 지역 변수에 담기만 하고, 장부는 호출이 끝난
 * 뒤에 한 번 움직인다. `buildOnboardingTurn`은 mock 모드 전용이다.
 */
export async function runOnboarding(
  state: GameState,
  background: string,
  llm?: GameLLM,
): Promise<GmTurnResult> {
  const walletAnchor = startingWalletAnchor(background, state.userTeamId);
  const attributeAnchor = state.manager.attributes;
  // mock은 이 호출을 아예 하지 않는다 — 앵커가 그대로 답이다 (agents.md §4-2)
  if (resolveLlmMode() === "mock") {
    state.manager.wallet = clampStartingWallet(undefined, walletAnchor);
    return buildOnboardingTurn(state);
  }

  let judged: ReportInput | undefined;
  let client = llm;
  const turn = await retryOnce("onboarding", () =>
    requireToolCall(REPORT_ONBOARDING_TOOL, async () => {
      client ??= createGameLLM(agentConfig("onboarding-judge"));
      const result = await client.runTurn({
        system: ONBOARDING_JUDGE_SYSTEM,
        history: [],
        user: buildOnboardingJudgePrompt(state, background, walletAnchor),
        tools: [makeReportTool((r) => (judged = r))],
        toolChoice: { name: REPORT_ONBOARDING_TOOL },
        // ⚠️ maxTokens를 좁히지 않는다 — 상한은 사고(thinking)+본문 합산이라
        // 장면 길이만 보고 잡으면 본문이 문장 한복판에서 잘린다
      });
      // 상한에 걸린 응답은 문장이 끊겨 있다 — 문법 검사를 통과해도 걸러낸다
      if (result.stopReason === "truncated") {
        throw new ModelOutputError("첫 장면이 출력 상한에 걸려 문장이 잘렸습니다");
      }
      const text = humanizePlayerIds(state, sanitizeSceneText(result.text).trim());
      if (!isValidOnboardingText(state, text)) {
        throw new ModelOutputError(`첫 장면이 출력 문법을 어겼습니다:\n${text}`);
      }
      return { ...result, text };
    }),
  );

  const report: ReportInput | undefined = judged;
  state.manager.wallet = clampStartingWallet(report?.wallet, walletAnchor);
  state.manager.attributes = clampJudgedAttributes(report?.attributes, attributeAnchor);
  if (report?.openings && report.openings.length > 0) seedOpenings(state, report.openings);

  // 첫 장면은 시계를 옮기지 않는다 — 헤더가 없으면 세워 준다
  const stamped = parseSceneHeader(turn.text).point
    ? turn.text
    : `[${state.date} ${formatClock(clockOf(state))}]\n${turn.text}`;
  return { text: stamped, toolCalls: [], usage: turn.usage };
}
