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
  headCoachOf,
  ownerOf,
  playersOf,
  seedOpenings,
  startingWalletAnchor,
  teamNameIn,
  tierOfTeamIn,
  type GameState,
} from "@story-fm/engine";
import { agentConfig, createGameLLM, type GameLLM, type GameToolSpec } from "@story-fm/llm";
import { resolveLlmMode } from "./gm";
import { retryOnce, requireToolCall, anchorStands } from "./retry";
import { inputError, toToolSchema } from "./tool-schema";

/**
 * **온보딩 판정** — 새 게임이 서기 전에 딱 한 번 돈다 (career.md §1 · agents.md §4-2).
 *
 * 결산·교섭과 같은 계약이다: 코어가 앵커를 박고(지갑은 커리어 등급, 능력치는 휴리스틱),
 * 판정이 그 위에서 값을 고르고, 코어가 ±한도로 자른다. **실패는 삼킨다** — 앵커가 그대로
 * 답이 되고 시작 사건은 비어 있을 뿐, 게임은 만들어진다.
 *
 * 세 가지를 낸다 — 시작 지갑 · 능력치의 결(앵커에서 축당 ±8, 합 ±10) · 시작 사건(셋까지,
 * 그 줄이 이름을 부르는 실재하는 사람에게만 걸어서). 능력치의 총량은 앵커가 쥔다 — 판정이 옮기는 것은
 * "이 사람은 어느 축이 두꺼운가"뿐이다.
 */
export const ONBOARDING_JUDGE_SYSTEM = `당신은 새로 부임하는 축구 감독의 이력을 읽는 사람이다.

배경 한 문단과 부임 구단의 사실을 읽고 셋을 판정한다 — 부임 전까지 모아 둔 개인 자산, 다섯 능력치의 결, 부임 첫 몇 주를 이끌 시작 사건.

# 입력
<anchor> — 코어가 박은 기준값: 지갑 앵커와 폭, 능력치 다섯 축의 앵커와 폭. 앵커가 이미 커리어 등급과 부임 구단의 격을 반영한다 — 당신이 읽는 것은 그 안에서의 결이다.
<club> — 부임 구단: 이름·격·구단주·수석코치·주장·핵심 선수·유망주. 시작 사건에 걸 수 있는 사람은 여기 적힌 id뿐이다.
<background> — 배경 문단.

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

/** 프롬프트 본문 — 앵커 · 구단 · 배경 */
export function buildOnboardingJudgePrompt(
  state: GameState,
  background: string,
  walletAnchor: number,
): string {
  return [
    buildAnchorBlock(walletAnchor, state.manager.attributes),
    buildClubBlock(state),
    `<background>`,
    background,
    `</background>`,
  ].join("\n");
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
 * 배경 → 시작 지갑 · 능력치의 결 · 시작 사건. **상태를 직접 고친다** — 게임은 이미
 * 휴리스틱 능력치로 서 있고(그것이 앵커다), 여기서 앵커 ± 한도로 옮긴다.
 *
 * 한 번 다시 시도하되 **실패는 삼킨다** — 그때는 앵커가 그대로 답이고 시작 사건은
 * 비어 있다. 같은 배경·같은 팀이면 그 폴백은 언제나 같은 값이다 (career.md §1).
 */
export async function judgeOnboarding(
  state: GameState,
  background: string,
  llm?: GameLLM,
): Promise<void> {
  const walletAnchor = startingWalletAnchor(background, state.userTeamId);
  const attributeAnchor = state.manager.attributes;
  // mock은 이 호출을 아예 하지 않는다 — 앵커가 그대로 답이다 (agents.md §4-2)
  if (resolveLlmMode() === "mock") {
    state.manager.wallet = clampStartingWallet(undefined, walletAnchor);
    return;
  }

  let judged: ReportInput | undefined;
  let client = llm;
  await retryOnce(
    "judge:onboarding",
    () =>
      requireToolCall(REPORT_ONBOARDING_TOOL, () => {
        client ??= createGameLLM(agentConfig("onboarding-judge"));
        return client.runTurn({
          system: ONBOARDING_JUDGE_SYSTEM,
          history: [],
          user: buildOnboardingJudgePrompt(state, background, walletAnchor),
          tools: [makeReportTool((r) => (judged = r))],
          toolChoice: { name: REPORT_ONBOARDING_TOOL },
        });
      }),
    () => judged !== undefined, // 이미 값을 받았으면 다시 부르지 않는다
  ).catch(anchorStands("judge:onboarding"));

  const report: ReportInput | undefined = judged;
  state.manager.wallet = clampStartingWallet(report?.wallet, walletAnchor);
  state.manager.attributes = clampJudgedAttributes(report?.attributes, attributeAnchor);
  if (report?.openings && report.openings.length > 0) seedOpenings(state, report.openings);
}
