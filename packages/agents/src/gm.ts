/**
 * GM 오케스트레이터 — 단일 GM, 장면 라우팅 (agents.md §1·§2).
 * 실모드: 설정된 제공자의 tool loop. mock 모드: 규칙 기반 (mock-gm.ts).
 * 두 모드는 같은 엔진 스킬 경로만 사용한다 — 상태 변경의 유일한 통로.
 */
import {
  advanceTime,
  applyScenePoint,
  awaitingShootout,
  buildMoodBrief,
  buildRatingBrief,
  buildTrainingBrief,
  clockOf,
  diffDays,
  finalizeMatch,
  formatClock,
  headCoachOf,
  humanizePlayerIds,
  markEntered,
  missionReportCard,
  minutesOfClock,
  arrivedResponses,
  pendingVerdicts,
  pushNews,
  scoutReportCard,
  selectCharacters,
  takeMedia,
  takeNews,
  takeReportCards,
  type AdvanceOutcome,
  type CardMark,
  type GameState,
  type GoalMark,
  type TrainingBrief,
} from "@story-fm/engine";
import type { MissionReportCard, ScoutReportCard } from "@story-fm/domain";
import { agentConfig, createGameLLM, hasKey, type GameLLM } from "@story-fm/llm";
import { rateMatchPerformances } from "./match-rater";
import { reportMood } from "./mood-rater";
import { reportTraining } from "./training-rater";
import { buildNoSegmentMessage, MATCH_CASTER_SYSTEM } from "./match-caster";
import { buildOnboardingTurn, runMockGmTurn } from "./mock-gm";
import { runNegotiator } from "./negotiator";
import { retryOnce, ModelOutputError } from "./retry";
import { GM_SYSTEM } from "./gm-prompt";
import { buildGmTools } from "./gm-tools";
import { runMatchIntent } from "./match-intent";
import { applyMatchIntent, type AppliedIntent } from "./match-intent-apply";
import {
  buildGmDigest,
  buildGmHistory,
  buildGmReference,
  buildGmStateNote,
  buildGmTurnMessage,
  injectedCharacters,
  recordCharacterInjection,
  buildLedgerNote,
  buildMatchReference,
  buildOperatorMessage,
  filterCasterStream,
  filterSceneStream,
  lastScenePoint,
  parseSceneHeader,
  renderTurnGroup,
  sanitizeCasterText,
  sanitizeSceneText,
  stampMatchScene,
  stampMatchStream,
} from "./gm-input";
import {
  GmTurnFailure,
  TIME_PASSED,
  noteSceneHeader,
  recordCall,
  type GmToolCall,
  type GmTurnResult,
  type TurnOperation,
} from "./gm-types";

// 분할 전 gm.ts의 export 표면 유지 — 프롬프트·도구·입력 빌더는 형제 파일에 있다
export * from "./gm-prompt";
export * from "./gm-tools";
export * from "./gm-input";

/** 진행이 멈춘 이유 — 선언한 시점에 못 미쳤을 때 다음 턴 상태에 실린다 */
const ADVANCE_STOP_KO: Record<string, string> = {
  reached: "요청한 만큼 진행했다",
  matchday: "경기일에 도착했다",
  attention: "오늘이 기한인 협상이 있어 멈췄다",
  season_end: "시즌이 끝났다",
  blocked: "진행하지 못했다",
};

/**
 * 손잡이가 가리키는 만큼 시계를 옮긴다 — **모델을 거치지 않는 유일한 시간 이동.**
 * 경기 중이거나 이미 지난 날짜면 아무것도 하지 않는다.
 *
 * 다음 경기는 날짜로 넘어온다(`skip_to_next_match`) — 화면이 달력에서 이미 아는
 * 값이라 코어가 일정을 다시 찾을 이유가 없고, 그 사이 일정이 바뀌었더라도
 * `advanceTime`이 경기일 앞에서 멈춰 세운다.
 */
function advanceForOperation(state: GameState, operation: TurnOperation): AdvanceOutcome | null {
  if (state.phase !== "idle") return null;
  if (operation.kind === "advance_match") return null;
  if (operation.kind === "skip_days") return advanceTime(state, { days: operation.days });
  const days = diffDays(state.date, operation.date);
  return days > 0 ? advanceTime(state, { days }) : null;
}

/** 장면이 섰는가 — 출력 문법이 요구하는 것은 `@`로 여는 줄 하나다 (prompts.md §1) */
function hasSceneLine(text: string): boolean {
  return text.split("\n").some((line) => line.trim().startsWith("@"));
}

/**
 * 장면이 비어 돌아온 턴을 세우는 **코어의 기록** — 스킬이 남긴 요약을 내레이션
 * (`@:`) 줄로 옮긴다.
 *
 * ⚠️ **대사는 쓰지 않는다.** 여기 서는 것은 장부가 이미 아는 사실뿐이고, 그래서
 * "장면을 대신 써 주지 않는다"와 어긋나지 않는다 (agents.md §2·§8). 세울 기록이
 * 없으면 null이다 — 그 턴은 아무것도 하지 않았다.
 */
function sceneFromToolCalls(calls: readonly GmToolCall[]): string | null {
  const lines = calls
    .map((call) => {
      const brief = call.brief;
      const body = brief
        ? [
            brief.head,
            brief.items
              .map((item) =>
                [item.label, item.text, item.note ? `(${item.note})` : ""]
                  .filter((part) => part && part.length > 0)
                  .join(" "),
              )
              .join(" · "),
          ]
            .filter((part) => part.length > 0)
            .join(" — ")
        : call.summary
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .join(" · ");
      return body.trim();
    })
    .filter((line) => line.length > 0)
    .map((line) => `@: *${line}*`);
  return lines.length > 0 ? lines.join("\n") : null;
}

/** 한 턴에 세우는 스카우팅 보고서 카드 상한 — 화면이 카드로 덮이면 장면이 안 읽힌다 */
const MAX_REPORT_CARDS = 3;

/** 이번 턴에 도착한 카드 — 지목의 보고서와 임무의 후보 목록이 한 줄에서 나온다 */
interface ArrivedCards {
  reports: ScoutReportCard[];
  missions: MissionReportCard[];
}

/** 꺼낼 줄이 없는 턴 — 경기 중이거나 시계가 안 돌았다 */
const NO_CARDS: ArrivedCards = { reports: [], missions: [] };

/**
 * 카드로 세울 보고서를 줄에서 꺼낸다 — **꺼낸 그 턴의 입력이 같은 값을 싣는다.**
 *
 * 코어가 장면보다 먼저 구른 턴(손잡이)은 그 사이 벌어진 일이, 장면 뒤에 구른
 * 턴(모델 헤더)은 다음 턴의 도착 블록이 그 값을 싣는다. 어느 쪽이든 카드가 붙은
 * 턴의 모델은 금액을 읽었다 (agents.md §6).
 *
 * ⚠️ **줄은 한 번만 꺼내고 여기서 가른다.** 도착 줄(`pendingReportCards`)에는 지목의
 * 선수 id와 임무 id가 섞여 온다 — 갈래마다 따로 꺼내면 앞의 호출이 줄을 비워 뒤는
 * 언제나 빈손이다. 임무 표(`state.scoutMissions`)에서 찾히는 id가 임무다.
 */
function takeArrivedReports(state: GameState, limit: number): ArrivedCards {
  const missionIds = new Set((state.scoutMissions ?? []).map((m) => m.id));
  const cards: ArrivedCards = { reports: [], missions: [] };
  for (const id of takeReportCards(state, limit)) {
    if (missionIds.has(id)) {
      const card = missionReportCard(state, id);
      if (card) cards.missions.push(card);
    } else {
      const card = scoutReportCard(state, id);
      if (card) cards.reports.push(card);
    }
  }
  return cards;
}

/**
 * 평시 시스템 블록 — 고정 · 레퍼런스 · **요약**(압축된 세이브에만) 순
 * (agents.md §5). 경기 쪽은 이력이 갈려 있어 요약을 싣지 않는다.
 */
function peaceSystem(state: GameState): string[] {
  const digest = buildGmDigest(state);
  return digest
    ? [GM_SYSTEM, buildGmReference(state), digest]
    : [GM_SYSTEM, buildGmReference(state)];
}

export type LlmMode = "mock" | "real";

export function resolveLlmMode(): LlmMode {
  const forced = process.env.LLM_MODE;
  if (forced === "mock" || forced === "real") return forced;
  return hasKey(agentConfig("gm").provider) ? "real" : "mock";
}

/**
 * 첫 장면 지시 — 누가 여는지만 정한다. ⚠️ 소재·구성 체크리스트를 덧붙이지 마라 —
 * 모델은 항목 수만큼 문단으로 갚아 모든 세이브의 첫 장면이 같은 골격이 된다.
 */
const ONBOARDING_INSTRUCTION = buildOperatorMessage(
  "새 게임 첫 장면 — 오늘은 감독의 부임 첫날이다. 상태와 인물 카드를 읽고 수석코치의 말로 첫 장면을 열어라.",
);

/** 첫 장면 검사 — 문법과 화자(수석코치 등장·감독 미발화)까지만 본다. 내용은 보지 않는다. */
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

/**
 * 새 게임 첫 장면 — 실모드는 GM 프롬프트로 매번 생성한다.
 *
 * **폴백은 없다.** 호출 실패·잘린 응답·문법 위반은 한 번 다시 시도하고, 그래도
 * 안 되면 오류를 올린다 — 규칙 장면으로 대신 채우면 실모드가 도는 줄 알고
 * 넘어간다. `buildOnboardingTurn`은 mock 모드 전용이다.
 */
export async function runOnboardingTurn(state: GameState, llm?: GameLLM): Promise<GmTurnResult> {
  const config = agentConfig("gm");
  if (resolveLlmMode() === "mock") return buildOnboardingTurn(state);
  const client = llm ?? createGameLLM(config);

  /**
   * 첫 장면의 수석코치는 **지목으로 선다** — 이력도 지난 발화도 없어 키워드가 걸릴
   * 문장 자체가 없고, 레퍼런스에도 인물 카드는 없다(people.md §6). 검증
   * (`isValidOnboardingText`)이 요구하는 이름이 프롬프트에 실리는 자리가 여기뿐이다.
   */
  const characters = selectCharacters(state, { pointed: [headCoachOf(state).characterId] });

  // 도구도 스트리밍도 없는 호출이라 다시 불러도 남는 자국이 없다
  return retryOnce("gm:onboarding", async () => {
    const result = await client.runTurn({
      system: peaceSystem(state),
      history: [],
      // 평시 턴과 같은 모양이다 — 카드 → 발화, 그 뒤에 어댑터가 스냅샷을 붙인다.
      // 이 발화는 채팅에 남지 않으므로 꼬리가 아니라 여기서 만든다
      user: renderTurnGroup(
        state,
        [{ role: "user", text: "*새 감독으로서 구단에 첫 출근한다*" }],
        characters,
      ),
      // 첫 장면 지시는 그 턴만의 오퍼레이터 지시라 스냅샷과 함께 발화 뒤에 선다
      stateNote: `${ONBOARDING_INSTRUCTION}\n\n${buildGmStateNote(state)}`,
      // ⚠️ maxTokens를 좁히지 않는다 — 상한은 사고(thinking)+본문 합산이라
      // 장면 길이만 보고 잡으면 본문이 문장 한복판에서 잘린다
    });
    // 상한에 걸린 응답은 문장이 끊겨 있다 — 문법 검사를 통과해도 걸러낸다
    if (result.stopReason === "truncated") {
      throw new ModelOutputError("첫 장면이 출력 상한에 걸려 문장이 잘렸습니다");
    }
    const text = humanizePlayerIds(state, result.text.trim());
    if (!isValidOnboardingText(state, text)) {
      throw new ModelOutputError(`첫 장면이 출력 문법을 어겼습니다:\n${text}`);
    }
    // 첫 장면은 시계를 옮기지 않는다 — 헤더가 없으면 세워 준다
    const stamped = parseSceneHeader(text).point
      ? text
      : `[${state.date} ${formatClock(clockOf(state))}]\n${text}`;
    return { text: stamped, toolCalls: [], usage: result.usage };
  });
}

/**
 * 심경 결산 (mood-rater) — 다른 결산과 같은 계약: 대상이 없으면 부르지 않고,
 * 실패하면 앵커가 남는다. 감독이 부른 적 없는 내부 판정이라 칩으로 세우지 않는다.
 */
/**
 * 오늘 답이 도착한 협상을 **상대가 판정한다** — GM 턴이 시작하기 전이다 (agents.md §4-1).
 *
 * 협상 하나에 호출 하나이고, 실패해도 코어 앵커가 반영되므로 여기서 턴이 막히지
 * 않는다. 반영된 판정은 스킬 기록(`respond_offer`)으로 서고, 감독이 읽을 한 줄은
 * 상태 스냅샷의 맨 앞으로 간다 — 장면은 그것을 전한다.
 */
async function answerCounterparties(state: GameState, calls: GmToolCall[]): Promise<string[]> {
  const lines: string[] = [];
  // 목록을 먼저 굳힌다 — 판정이 협상의 상태를 바꾸므로 도중에 다시 재면 안 된다
  for (const negotiation of [...arrivedResponses(state)]) {
    const answered = await runNegotiator(state, negotiation);
    if (!answered) continue;
    recordCall(calls, "respond_offer", answered.result, { input: answered.input });
    if (answered.result.ok) lines.push(answered.result.message);
  }
  return lines;
}

async function rateMood(state: GameState, from: string): Promise<void> {
  const brief = buildMoodBrief(state, from, state.date);
  if (brief) await reportMood(state, brief);
}

/** 실모드 — 일상은 GM, 경기 장면은 매치 캐스터 설정으로 라우팅 */
async function runRealGmTurn(
  state: GameState,
  message: string,
  onText?: (delta: string) => void,
  operation?: TurnOperation | null,
  operatorOrders?: readonly string[],
): Promise<GmTurnResult> {
  /** 이 턴이 손잡이인가 — 감독이 친 말이 아니다 (`message`는 표시 문구다) */
  const operator = operation != null;
  const calls: GmToolCall[] = [];
  const inMatch = state.phase === "match";
  /**
   * 킥오프 턴 — **경기의 첫 호흡.** 감독이 경기장에 들어선 그 한 턴이다.
   *
   * 도구를 주지 않아 구간이 굴러갈 수 없고, 패킷도 싣지 않는다. 대신 평시 이력을
   * 그대로 넘겨(`relevantTurns`) 라커룸에서 이어지는 목소리로 첫 휘슬만 연다.
   */
  const kickoff = inMatch && state.pendingMatch?.entered !== true;
  const config = agentConfig(inMatch ? "match-caster" : "gm");
  const llm = createGameLLM(config);

  const pendingTraining: TrainingBrief[] = [];
  /** 이번 턴에 들어간 골 — 장부의 사건에서 만든다 (중계 문장을 되읽지 않는다) */
  const goals: GoalMark[] = [];
  /** 이번 턴의 경고·퇴장 — 같은 경로다. 경고는 다음 교체 판단의 입력이다 */
  const cards: CardMark[] = [];
  /**
   * 지난 턴이 **장면 뒤에** 받아 둔 보고서 — 이번 턴 스냅샷이 값을 싣고 카드도 이번
   * 턴에 선다. ⚠️ 손잡이가 시계를 옮기기 **전에** 꺼낸다: 그 뒤에 도착하는 것은
   * 「그 사이 벌어진 일」이 따로 실으므로, 여기 섞이면 한 프롬프트에 같은 값이 두 번
   * 실린다 (agents.md §6).
   */
  const carriedCards = inMatch ? NO_CARDS : takeArrivedReports(state, MAX_REPORT_CARDS);
  // 손잡이로 넘긴 시간은 모델보다 먼저 흐른다 — 코어가 먼저 굴리고 "그 사이
  // 벌어진 일"을 상태에 실어, 모델은 도착한 자리에서 보고한다
  const pendingBeforeSkip = new Set(pendingVerdicts(state).map((v) => v.negotiation.id));
  /**
   * 이 턴이 시작한 날짜 — **손잡이보다도, 장면보다도 먼저** 잡는다.
   *
   * 결산(훈련·심경)이 보는 구간의 시작이 여기다. 시계가 도는 자리가 둘이라
   * (손잡이는 장면 앞, 헤더는 장면 뒤 — agents.md §2) 장면 뒤에 잡으면 손잡이 턴의
   * 구간이 길이 0이 되어 결산이 아예 돌지 않는다.
   */
  const turnFrom = state.date;
  const skipped = !inMatch && operation ? advanceForOperation(state, operation) : null;
  if (skipped) {
    calls.push({
      name: TIME_PASSED,
      summary: [
        `${turnFrom} → ${state.date} — ${ADVANCE_STOP_KO[skipped.stopped] ?? "진행했다"}`,
        ...skipped.digest,
      ].join("\n"),
      silent: true,
    });
    const brief = buildTrainingBrief(state, skipped.trained?.sessions ?? [], {
      from: turnFrom,
      to: state.date,
    });
    if (brief) pendingTraining.push(brief);
  }
  // 손잡이가 굴려 도착한 보고서 — 그 값은 바로 위 다이제스트가 이미 싣는다
  const skippedCards = skipped
    ? takeArrivedReports(
        state,
        MAX_REPORT_CARDS - carriedCards.reports.length - carriedCards.missions.length,
      )
    : NO_CARDS;
  /** 시간 이동 중 새로 생긴 오퍼는 이번 장면에서 보고만 하고 감독의 답을 기다린다. */
  const deferNegotiationIds = new Set(
    skipped
      ? pendingVerdicts(state)
          .map((v) => v.negotiation.id)
          .filter((id) => !pendingBeforeSkip.has(id))
      : [],
  );
  /**
   * **협상의 상대는 GM이 아니다** (agents.md §4-1).
   *
   * 오늘 답이 도착한 협상은 장면보다 먼저, 별도 호출로 판정된다. 여기서 끝내 두는
   * 덕에 아래 GM 턴에는 그 협상이 판정 대기로 서지 않고, GM은 이미 일어난 일을
   * 전한다 — 감독의 뜻을 읽어야 하는 **들어온 오퍼**만 도구로 남는다.
   */
  const counterpartyReplies = inMatch ? [] : await answerCounterparties(state, calls);
  /**
   * **경기 턴의 ②·③** — 해석이 먼저, 중계가 나중이다 (docs/llm/agents.md §3).
   *
   * 감독의 말을 의도 하나로 옮기고 코어가 스킬로 적용한 뒤 구간까지 굴려 둔다.
   * 그래서 아래 중계 호출은 **이번 턴에 바뀐 판**을 처음부터 쥐고 시작한다.
   *
   * 킥오프 턴은 지나간다 — 감독이 아직 아무것도 지시하지 않았고, 첫 휘슬만 여는
   * 자리라 구간이 굴러가면 안 된다.
   */
  let applied: AppliedIntent | null = null;
  if (inMatch && !kickoff) {
    /**
     * 손잡이로 온 턴은 해석할 것이 없다 — 화면의 대기 중 교체·좌표·역할·전술 축은
     * 코어가 이미 적용했고(match.md §2), `계속`이 뜻하는 것은 진행 하나뿐이다.
     * 버튼 한 번에 모델을 부르지 않는다.
     */
    const parsed = operator
      ? ({ ok: true, intent: { advance: "segment" } } as const)
      : await runMatchIntent(state, message);
    // 두 번 실패하면 아무것도 바꾸지 않고 되돌린다 — 짐작해 적용하면 감독이 내리지
    // 않은 지시가 판에 오르고, 그건 아무 일도 안 일어나는 것보다 나쁘다.
    // 안내 문구는 장면이 아니라 배너다 — 턴 결과로 돌려주면 화자도 헤더도 없는 줄이
    // 채팅에 저장되고 그 턴은 되돌릴 수도 없다 (agents.md §8)
    if (!parsed.ok) throw new GmTurnFailure(parsed.message);
    applied = applyMatchIntent(state, parsed.intent, calls, goals, cards);
  }

  /**
   * 경기 중에는 도구 표면이 **0**이다 — 해석은 이미 끝났고 중계는 문장만 쓴다.
   * 도구 정의는 고정층이라 캐시 프리픽스를 부풀리는데, 경기 중에 그 값을 치를
   * 이유가 사라졌다 (agents.md §5).
   */
  const tools = inMatch ? [] : buildGmTools(state, calls, { deferNegotiationIds });

  // 입력은 안정성 순 3층 — ① 고정 프롬프트 ② 레퍼런스 ③ 발화+상태 스냅샷.
  // 앞 두 층만 캐시 프리픽스(0.1×)다 (docs/llm/agents.md §5)
  const system = inMatch ? [MATCH_CASTER_SYSTEM, buildMatchReference(state)] : peaceSystem(state);
  /**
   * **대화만 건 턴은 판을 싣지 않는다.** 선수를 부른 한 마디에 패킷 전체를 실으면
   * 중계가 읽지도 않을 판세를 매 턴 정가로 읽는다 (agents.md §5). 킥오프 턴도 같은
   * 이유로 판이 없다 — 아직 아무 일도 일어나지 않았는데 판세를 쥐여 주면 첫 마디부터
   * 우열을 읊는다.
   */
  const stateNote = inMatch
    ? buildLedgerNote(state, { withPacket: !kickoff && applied?.touched !== false })
    : buildGmStateNote(
        state,
        skipped
          ? {
              from: turnFrom,
              stopped: ADVANCE_STOP_KO[skipped.stopped] ?? "진행했다",
              digest: skipped.digest,
            }
          : null,
        carriedCards.reports,
        carriedCards.missions,
        counterpartyReplies,
      );
  /**
   * 이번 장면에 설 인물 — **평시만이다.** 경기 중에는 벤치의 코치 한 사람이
   * 레퍼런스에 상주하고(`buildMatchReference`), 중계가 읽을 것은 판이지 인물지가 아니다.
   *
   * 카드는 감독 발화와 같은 층으로 들어가고, 기록이 남아 다음 턴부터 **이력**에서
   * 같은 자리에 다시 선다 — 그래서 레퍼런스(캐시 프리픽스)가 흔들리지 않는다
   * (people.md §6 · agents.md §5).
   */
  const characters = inMatch
    ? []
    : selectCharacters(state, { message, injected: injectedCharacters(state) });
  /**
   * 이번 턴의 유저 메시지 — **평시는 채팅 꼬리에서 그린다.** 다음 턴 이력이 같은 꼬리를
   * 같은 함수로 다시 그리므로 둘이 글자까지 같고, 캐시 프리픽스가 이 발화를 지나
   * 이어진다 (agents.md §5). 경기 턴은 이력이 제공자 원형(`casterHistory`)이라
   * 어댑터가 보낸 것을 그대로 남기므로 여기서 만든다 — 킥오프 턴의 발화는 경기
   * 이력으로 갈려 평시 꼬리에 없기도 하다. 전술판 조작은 채팅에 선 그 문장 그대로다.
   */
  const turnMessage = inMatch
    ? renderTurnGroup(
        state,
        [
          ...(operatorOrders && operatorOrders.length > 0
            ? [{ role: "operator" as const, text: operatorOrders.join("\n") }]
            : []),
          { role: operator ? ("operator" as const) : ("user" as const), text: message },
        ],
        [],
      )
    : buildGmTurnMessage(state, characters);
  /**
   * 소식은 **스냅샷에 실린 그 턴에 비워진다** — `pendingEdits`와 같은 규약이다.
   * 경기 중 스냅샷은 장부(`buildLedgerNote`)라 소식을 읽지 않으므로 그때는 남겨 둔다.
   */
  if (!inMatch) {
    takeNews(state);
    // 기사도 같은 규약이다 — 스냅샷과 캐릭터북이 둘 다 읽은 뒤에 비운다 (people.md §4-1)
    takeMedia(state);
  }
  // 킥오프 턴의 이력은 경기 전 대화다 — `relevantTurns`가 그 한 턴만 평시로 읽는다
  const history =
    inMatch && !kickoff ? (state.pendingMatch?.casterHistory ?? []) : buildGmHistory(state);

  // 헤더가 옮기기 전의 시각 — "시계가 제자리인가"를 재는 자리다 (날짜는 `turnFrom`)
  const clockFrom = clockOf(state);
  /**
   * 재시도의 조건 — **이 호출이 아직 아무 자국도 남기지 않았을 때만.** 도구가
   * 돌았으면 상태가 이미 바뀌었고(이중 반영), 글자가 나갔으면 화면에 장면이 두 번
   * 그려진다. 대부분의 실패(인증·혼잡·한도·연결)는 첫 글자보다 먼저 온다.
   */
  let streamed = false;
  const trackText = onText
    ? (delta: string) => {
        streamed = true;
        onText(delta);
      }
    : undefined;
  /**
   * **경기 장면의 시각** — 이 턴의 장부가 준다 (agents.md §3 ④). 구간이 굴러간
   * 뒤이자 `finalizeMatch`가 장부를 지우기 전인 지금이 읽을 수 있는 유일한 자리다.
   */
  const matchMinute = inMatch ? (state.pendingMatch?.ledger.minute ?? null) : null;
  /**
   * 경기의 첫 줄은 코어가 쓴다 — 모델이 적은 시각은 화면에 닿기 전에 걷힌다.
   * 위생은 두 국면에 다 걸린다 — 걸러질 줄이 화면에 잠깐 떴다 사라지면 그것대로
   * 눈에 띄므로 저장과 화면에 같은 것이 선다 (agents.md §2). 중계가 읽는 것은
   * 꺾쇠 규칙 하나뿐이고, 코어의 시각 줄은 그 체를 지나 화면에 선다.
   */
  const streamText = !trackText
    ? undefined
    : inMatch
      ? matchMinute !== null
        ? stampMatchStream(matchMinute, filterCasterStream(trackText))
        : filterCasterStream(trackText)
      : filterSceneStream(trackText);
  const result = await retryOnce(
    inMatch ? "gm:match" : "gm:turn",
    () =>
      llm.runTurn({
        system,
        history,
        user: [
          turnMessage,
          // 코어가 이미 굴린 구간.
          // 진행이 없는 턴도 그 사실을 싣는다 — 안 실으면 킥오프 턴과 입력이 같아져
          // 캐스터가 첫 휘슬 대신 지어낸 시각과 슛을 중계한다
          ...(inMatch && !kickoff
            ? [``, applied?.segment ?? buildNoSegmentMessage(matchMinute ?? 0)]
            : []),
          // 스킬이 돌려준 말 — 걸린 지시도, 걸리지 않은 지시도 중계의 근거가 된다
          ...(applied && applied.notes.length > 0
            ? [``, `<core_replies>`, ...applied.notes.map((n) => `- ${n}`), `</core_replies>`]
            : []),
        ].join("\n"),
        stateNote,
        tools,
        onText: streamText,
      }),
    /**
     * 자국은 **이 호출이 남긴 것만** 센다. 캐스터는 도구가 없어 판을 바꾸지 못하고,
     * 판을 바꾼 것은 앞 걸음의 코어다 — 그 기록을 자국으로 세면 구간을 굴린 모든
     * 경기 턴이 첫 실패에 그대로 무너진다 (agents.md §3 ④·§8).
     */
    inMatch ? () => streamed : () => streamed || calls.some((c) => c.name !== TIME_PASSED),
  );

  // 도구 앞에 흘린 작업 서술과 값이 같은 반복 헤더를 걷어낸다 — 중계에는 헤더 규칙을
  // 걸지 않는다(구간마다 헤더를 새로 찍는 것이 정상이다 — prompts.md §1). 남는 것은
  // 두 국면이 함께 읽는 꺾쇠 규칙 하나다
  const sceneText = inMatch ? sanitizeCasterText(result.text) : sanitizeSceneText(result.text);
  // 첫 줄 헤더가 본문과 갈린다 — 저장할 때 되붙일 것이고, 경기 턴은 분을 여기서 읽는다
  const scene = parseSceneHeader(sceneText);
  /**
   * 시계를 움직이는 것은 **턴이 닿은 시각**, 곧 마지막 시점 헤더다 — 모델의 선언을
   * 코어가 따라가되 그대로 믿지 않고, 경기일·기한 앞에서 멈춘 뒤 그 사실을 기록으로
   * 남긴다. 한 턴이 오전 훈련에서 오후 면담으로 넘어갔으면 채팅에도 오후가 서므로,
   * 첫 헤더로만 밀면 상단 띠와 채팅이 갈린다 (agents.md §2).
   */
  const scenePoint = lastScenePoint(sceneText);
  // 중계가 적은 분은 쓰이지 않지만, 장부와 갈렸다는 사실은 프롬프트가 흔들린 신호다
  if (matchMinute !== null && scene.minute !== null && scene.minute !== matchMinute) {
    console.warn(`[gm] 중계의 시각 ${scene.minute}′ — 장부(${matchMinute}′)로 세웁니다`);
  }
  /**
   * 헤더를 못 읽으면 시계가 멈춘다 — 첫 줄을 로그에 남기고 **연달은 횟수를 센다.**
   * 로그만으로는 정지가 조용히 쌓이므로, 셋이 되면 그 수가 턴 결과로 올라가
   * 화면이 띠를 세운다 (`GmTurnResult.clockStalled` — agents.md §2).
   * 손잡이가 이미 시계를 옮긴 턴은 헤더가 날짜를 또 밀지 못하는 것이 정상이다.
   */
  let clockStalled: number | null = null;
  if (!inMatch) {
    clockStalled = noteSceneHeader(state, scenePoint !== null || skipped !== null);
    if (!scenePoint) {
      const first = sceneText.split("\n").find((line) => line.trim().length > 0) ?? "";
      console.warn(
        `[gm] 장면 헤더를 읽지 못해 시계가 멈춥니다: ${JSON.stringify(first.slice(0, 80))}`,
      );
    }
  }
  // 헤더는 읽혔는데 시각이 안 움직인 턴 — 이어지는 대화면 정상이지만 몇 턴이고
  // 반복되면 세계가 정지하므로 로그로 드러낸다
  if (!inMatch && !skipped && scenePoint && scenePoint.date === turnFrom) {
    if (minutesOfClock(scenePoint.clock) <= minutesOfClock(clockFrom)) {
      // 헤더가 여럿이면 시계를 정하는 것은 마지막 것이라, 읽어낸 시점을 그대로 적는다
      console.warn(
        `[gm] 시계가 제자리입니다 (${turnFrom} ${clockFrom}) — 헤더가 닿은 곳: ${scenePoint.date} ${scenePoint.clock}`,
      );
    }
  }
  if (inMatch && scenePoint) {
    // 경기 중엔 날짜를 막고 그날 안의 시각만 따라간다 — 안 그러면 상단 시계가
    // 킥오프 시각에 얼어붙는다
    applyScenePoint(state, { date: state.date, clock: scenePoint.clock });
  } else if (!inMatch && scenePoint && skipped) {
    // 손잡이가 이미 시계를 옮긴 턴 — 헤더의 날짜까지 따르면 하루를 눌렀는데 이틀이 간다
    applyScenePoint(state, { date: state.date, clock: scenePoint.clock });
  } else if (!inMatch && scenePoint) {
    const moved = applyScenePoint(state, scenePoint);
    if (moved.digest.length > 0 || moved.short) {
      const head = `${state.date} ${formatClock(clockOf(state))}${
        moved.short ? ` — ${ADVANCE_STOP_KO[moved.stopped] ?? "멈췄다"}` : ""
      }`;
      // 스킬 호출이 아니라 코어가 시계를 옮긴 결과다 (`TIME_PASSED` 주석 참고)
      calls.push({
        name: TIME_PASSED,
        summary: [head, ...moved.digest].join("\n"),
        silent: true,
      });
    }
    const brief = buildTrainingBrief(state, moved.trained?.sessions ?? [], {
      from: turnFrom,
      to: state.date,
    });
    if (brief) pendingTraining.push(brief);
  }
  /**
   * 훈련 결산 — 코어 앵커 위에 LLM이 맥락을 더한다 (실패해도 앵커가 남는다).
   *
   * 내부 판정이라 칩으로 세우지 않는다. 결과는 **장부의 결산 카드**가 갖는다
   * (`state.trainingReports`) — 달력 일지가 그 카드를 문장으로 펼치고, 다음 턴의
   * 스냅샷 `<coach>` 첫 줄이 구간과 이름을 싣는다
   * (docs/simulation/season.md §4 · docs/llm/agents.md §6).
   */
  for (const brief of pendingTraining) {
    await reportTraining(state, brief);
  }

  if (inMatch && state.pendingMatch) {
    state.pendingMatch.casterHistory = result.history;
    // 첫 휘슬을 불었다 — 이 뒤로는 패킷과 도구를 쥔 보통의 진행 턴이다
    if (kickoff) markEntered(state);
    /**
     * 승부차기가 남았으면 마감하지 않는다 — 장부는 `finished`지만 승부는 아직
     * 갈리지 않았다 (match.md §2). 여기서 마감하면 킥을 한 발도 차지 않은 경기가
     * 결과로 굳는다.
     */
    if (state.pendingMatch.ledger.phase === "finished" && !awaitingShootout(state)) {
      // 브리프는 장부가 살아 있을 때만 만들 수 있다 — finalizeMatch가 지우기 전에
      const brief = buildRatingBrief(state);
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
      // 평점 — 코어 앵커 위에 LLM이 입체를 더한다. 실패해도 앵커가 남는다
      if (brief) {
        const rated = await rateMatchPerformances(state, brief);
        if (rated.applied > 0) {
          // 결산은 감독이 부른 적 없는 내부 판정이라 칩으로 세우지 않는다 (agents.md §4).
          // 평점은 명단과 종료 화면이 이미 갖고 있다
          calls.push({
            name: "rate_players",
            summary: `경기 평점 ${rated.applied}명`,
            silent: true,
          });
        }
      }
      // 심경 — **평점이 매겨진 뒤에** 읽어야 "잘하고도 졌다"가 문장에 담긴다
      await rateMood(state, turnFrom);
    }
  }
  // 시간이 흐른 턴의 심경 — 그 구간에 실제로 무슨 일이 있었던 선수만 다시 쓴다
  if (!inMatch && state.date !== turnFrom) await rateMood(state, turnFrom);
  // 출력 상한에 잘린 턴은 이미 스트리밍으로 나가 되돌릴 수 없다 — 원인만 로그에 남긴다
  if (result.stopReason === "truncated") {
    console.error(
      `[gm] 응답이 출력 상한(${config.maxTokens})에 걸려 잘렸습니다 — config/llm.yml의 max_tokens를 올려야 합니다`,
    );
  }
  // 선수 id를 이름으로 바꾸고 헤더를 되붙여 저장한다 — ⚠️ 헤더를 떼면 화면
  // (scene-stamp)의 시각이 스트리밍이 끝나는 순간 사라진다.
  // 경기 장면의 헤더는 모델의 것이 아니라 장부의 분이다 (스트리밍에 나간 것과 같다)
  let body = humanizePlayerIds(state, scene.body);
  let header = scene.header;
  /**
   * **장면이 비어 돌아온 턴** — 왕복 상한을 도구로 채우면(`stopReason === "tool_use"`)
   * 모델은 "확인하겠습니다" 한 줄만 남기거나 아무것도 쓰지 못한다. 도구는 이미 돌아
   * 라인업과 훈련이 바뀐 뒤라 되돌릴 수 없으므로, 코어가 이번 턴의 기록으로 세운다
   * (agents.md §2·§8). 기록도 장면도 없으면 저장하지 않고 턴을 되돌린다.
   */
  if (!inMatch && !hasSceneLine(body)) {
    const record = sceneFromToolCalls(calls);
    if (record) {
      console.warn(
        `[gm] 장면이 비어 코어 기록으로 세웁니다 — 종료 사유: ${result.stopReason ?? "없음"}`,
      );
      body = record;
      // 모델이 헤더도 못 썼으면 코어가 지금 시각을 세운다 — 헤더가 없으면 화면의
      // 시각이 스트리밍이 끝나는 순간 사라진다
      header ??= `[${state.date} ${formatClock(clockOf(state))}]`;
    } else if (body.trim().length === 0) {
      throw new GmTurnFailure("모델이 아무 장면도 내지 않아 턴을 취소했습니다.");
    }
  }
  const text =
    matchMinute !== null
      ? stampMatchScene(body, matchMinute)
      : header
        ? `${header}\n${body}`
        : body;
  /**
   * 카드는 **모델이 값을 읽은 것만** 선다. 장면 헤더가 시계를 옮긴 턴은 코어가 방금
   * 굴렀으므로 그 도착은 줄에 남아 다음 턴에 선다 (`pendingReportCards`).
   */
  const reports = [...carriedCards.reports, ...skippedCards.reports];
  const missions = [...carriedCards.missions, ...skippedCards.missions];
  // 실은 카드를 그 턴에 기록한다 — 다음 턴부터 이력이 같은 카드를 다시 그린다.
  // 턴이 실패하면 상태가 통째로 버려지므로 기록도 함께 없던 일이 된다
  recordCharacterInjection(state, characters);
  return {
    text,
    toolCalls: calls,
    ...(goals.length > 0 ? { goals } : {}),
    ...(cards.length > 0 ? { cards } : {}),
    ...(reports.length > 0 ? { reports } : {}),
    ...(missions.length > 0 ? { missions } : {}),
    ...(clockStalled !== null ? { clockStalled } : {}),
    usage: result.usage,
  };
}

/**
 * GM 턴 실행 — 모드 자동 해석 (env LLM_MODE 우선).
 * onText를 주면 서사 텍스트를 스트리밍으로 흘려보낸다 (실모드는 진짜 델타,
 * mock은 완성 텍스트를 청크로 쪼개 즉시 방출).
 */
export async function runGmTurn(
  state: GameState,
  message: string,
  onText?: (delta: string) => void,
  /**
   * 손잡이가 보낸 조작 — 있으면 이 턴은 감독의 발화가 아니다. `message`는 그
   * 구조체에서 만든 **표시 문구**이므로 아무도 되읽지 않는다 (agents.md §2).
   */
  operation?: TurnOperation | null,
  /**
   * 전술판 조작 — 코어가 **이미 적용한** 것의 기록이다. mock에는 넘기지 않는다:
   * 규칙 기반이라 그 문장을 지시로 되읽어 같은 교체를 두 번 걸었다.
   */
  operatorOrders?: readonly string[],
): Promise<GmTurnResult> {
  if (resolveLlmMode() === "mock") return runMockGmTurn(state, message, onText, operation);
  return runRealGmTurn(state, message, onText, operation, operatorOrders);
}
