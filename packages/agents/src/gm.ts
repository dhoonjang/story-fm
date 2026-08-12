/**
 * GM 오케스트레이터 (ai-manager.md) — 단일 GM, 장면 라우팅 (결정 #12).
 * 실모드: 설정된 제공자의 tool loop. mock 모드: 규칙 기반 (mock-gm.ts).
 * 두 모드는 같은 엔진 스킬 경로만 사용한다 — 상태 변경의 유일한 통로.
 */
import {
  advanceTime,
  applyScenePoint,
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
  minutesOfClock,
  pendingVerdicts,
  scoutReportCard,
  type AdvanceOutcome,
  type CardMark,
  type GameState,
  type GoalMark,
  type TrainingBrief,
} from "@story-fm/engine";
import type { ScoutReportCard } from "@story-fm/domain";
import { agentConfig, createGameLLM, hasKey, type GameLLM } from "@story-fm/llm";
import { rateMatchPerformances } from "./match-rater";
import { reportMood } from "./mood-rater";
import { reportTraining } from "./training-rater";
import { MATCH_CASTER_SYSTEM } from "./match-caster";
import { buildOnboardingTurn, runMockGmTurn } from "./mock-gm";
import { retryOnce } from "./retry";
import { GM_SYSTEM } from "./gm-prompt";
import { buildGmTools, buildMatchTools } from "./gm-tools";
import {
  buildGmHistory,
  buildGmReference,
  buildGmStateNote,
  buildLedgerNote,
  buildManagerMessage,
  buildMatchReference,
  buildOperatorMessage,
  parseSceneHeader,
} from "./gm-input";
import {
  TIME_PASSED,
  parseTimeSkip,
  type GmToolCall,
  type GmTurnResult,
  type TimeSkip,
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
 */
function advanceForSkip(state: GameState, skip: TimeSkip): AdvanceOutcome | null {
  if (state.phase !== "idle") return null;
  if (skip.kind === "next_match") return advanceTime(state, "next_match");
  if (skip.kind === "days") return advanceTime(state, { days: skip.days });
  const days = diffDays(state.date, skip.date);
  return days > 0 ? advanceTime(state, { days }) : null;
}

/** 한 턴에 세우는 스카우팅 보고서 카드 상한 — 화면이 카드로 덮이면 장면이 안 읽힌다 */
const MAX_REPORT_CARDS = 3;

/** 이 턴에 도착한 스카우팅 보고서 — 시간 이동 전에 미완이던 것 중 완료된 것 */
function arrivedReports(state: GameState, before: ReadonlySet<string>): ScoutReportCard[] {
  const arrived = state.scoutReports.filter(
    (r) => r.completedOn !== null && before.has(r.gamePlayerId),
  );
  return arrived
    .slice(0, MAX_REPORT_CARDS)
    .map((r) => scoutReportCard(state, r.gamePlayerId))
    .filter((c): c is ScoutReportCard => c !== null);
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
const ONBOARDING_INSTRUCTION = [
  `[오퍼레이터 지시 — 새 게임 첫 장면]`,
  `오늘은 감독의 부임 첫날이다. 상태와 레퍼런스를 읽고 수석코치의 말로 첫 장면을 열어라.`,
].join("\n");

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
    lines.every((line) => line.startsWith("@")) &&
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
 * 넘어간다(실제로 SDK가 비스트리밍 요청을 거부하는 동안 모든 첫 장면이 규칙
 * 장면이었다). `buildOnboardingTurn`은 이제 mock 모드 전용이다.
 */
export async function runOnboardingTurn(state: GameState, llm?: GameLLM): Promise<GmTurnResult> {
  const config = agentConfig("gm");
  if (resolveLlmMode() === "mock") return buildOnboardingTurn(state);
  const client = llm ?? createGameLLM(config);

  // 도구도 스트리밍도 없는 호출이라 다시 불러도 남는 자국이 없다
  return retryOnce("gm:onboarding", async () => {
    const result = await client.runTurn({
      system: [GM_SYSTEM, buildGmReference(state)],
      history: [],
      user: buildManagerMessage(state, "*새 감독으로서 구단에 첫 출근한다*"),
      stateNote: `${ONBOARDING_INSTRUCTION}\n\n${buildGmStateNote(state)}`,
      // ⚠️ maxTokens를 좁히지 않는다 — 상한은 사고(thinking)+본문 합산이라
      // 장면 길이만 보고 잡으면 본문이 문장 한복판에서 잘린다
    });
    // 상한에 걸린 응답은 문장이 끊겨 있다 — 문법 검사를 통과해도 걸러낸다
    if (result.stopReason === "max_tokens") {
      throw new Error("첫 장면이 출력 상한에 걸려 문장이 잘렸습니다");
    }
    const text = humanizePlayerIds(state, result.text.trim());
    if (!isValidOnboardingText(state, text)) {
      throw new Error(`첫 장면이 출력 문법을 어겼습니다:\n${text}`);
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
async function rateMood(state: GameState, from: string): Promise<void> {
  const brief = buildMoodBrief(state, from, state.date);
  if (brief) await reportMood(state, brief);
}

/** 실모드 — 일상은 GM, 경기 장면은 매치 캐스터 설정으로 라우팅 */
async function runRealGmTurn(
  state: GameState,
  message: string,
  onText?: (delta: string) => void,
  operator = false,
  operatorOrders?: readonly string[],
): Promise<GmTurnResult> {
  const calls: GmToolCall[] = [];
  const inMatch = state.phase === "match";
  /**
   * 킥오프 턴 — **경기의 첫 호흡.** 감독이 경기장에 들어선 그 한 턴이다.
   *
   * 도구를 주지 않아 구간이 굴러갈 수 없고, 패킷도 싣지 않는다. 대신 평시 이력을
   * 그대로 넘겨(`relevantTurns`) 라커룸에서 이어지는 목소리로 첫 휘슬만 연다.
   * 예전엔 입장과 동시에 20분이 지나가 감독이 킥오프를 본 적이 없었다.
   */
  const kickoff = inMatch && state.pendingMatch?.entered !== true;
  const config = agentConfig(inMatch ? "match-caster" : "gm");
  const llm = createGameLLM(config);

  const pendingTraining: TrainingBrief[] = [];
  /** 이번 턴에 들어간 골 — 장부의 사건에서 만든다 (중계 문장을 되읽지 않는다) */
  const goals: GoalMark[] = [];
  /** 이번 턴의 경고·퇴장 — 같은 경로다. 경고는 다음 교체 판단의 입력이다 */
  const cards: CardMark[] = [];
  // 시간이 흐르기 전에 미완이던 보고서 — 스카우트 완료는 tick의 사건이라
  // 전후 비교로만 "이 턴에 도착했다"를 안다
  const pendingReports = new Set(
    state.scoutReports.filter((r) => r.completedOn === null).map((r) => r.gamePlayerId),
  );
  // 손잡이로 넘긴 시간은 모델보다 먼저 흐른다 — 코어가 먼저 굴리고 "그 사이
  // 벌어진 일"을 상태에 실어, 모델은 도착한 자리에서 보고한다
  const pendingBeforeSkip = new Set(pendingVerdicts(state).map((v) => v.negotiation.id));
  const skip = !inMatch && operator ? parseTimeSkip(message) : null;
  const skipFrom = state.date;
  const skipped = skip ? advanceForSkip(state, skip) : null;
  if (skipped) {
    calls.push({
      name: TIME_PASSED,
      summary: [
        `${skipFrom} → ${state.date} — ${ADVANCE_STOP_KO[skipped.stopped] ?? "진행했다"}`,
        ...skipped.digest,
      ].join("\n"),
      silent: true,
    });
    const brief = buildTrainingBrief(state, skipped.trained?.sessions ?? [], {
      from: skipFrom,
      to: state.date,
    });
    if (brief) pendingTraining.push(brief);
  }
  /** 시간 이동 중 새로 생긴 오퍼는 이번 장면에서 보고만 하고 감독의 답을 기다린다. */
  const deferNegotiationIds = new Set(
    skipped
      ? pendingVerdicts(state)
          .map((v) => v.negotiation.id)
          .filter((id) => !pendingBeforeSkip.has(id))
      : [],
  );
  const tools = kickoff
    ? // 첫 호흡엔 손이 없다 — 도구를 주면 모델은 곧장 구간을 굴려 킥오프를 지나친다
      []
    : inMatch
      ? buildMatchTools(state, calls, goals, cards, { progressionOnly: operator })
      : buildGmTools(state, calls, { deferNegotiationIds });

  // 입력은 안정성 순 3층 — ① 고정 프롬프트 ② 레퍼런스 ③ 발화+상태 스냅샷.
  // 앞 두 층만 캐시 프리픽스(0.1×)다 (docs/design/llm-io.md)
  const system = inMatch
    ? [MATCH_CASTER_SYSTEM, buildMatchReference(state)]
    : [GM_SYSTEM, buildGmReference(state)];
  const stateNote = inMatch
    ? buildLedgerNote(state, { withPacket: !kickoff })
    : buildGmStateNote(
        state,
        skipped
          ? {
              from: skipFrom,
              stopped: ADVANCE_STOP_KO[skipped.stopped] ?? "진행했다",
              digest: skipped.digest,
            }
          : null,
      );
  // 킥오프 턴의 이력은 경기 전 대화다 — `relevantTurns`가 그 한 턴만 평시로 읽는다
  const history =
    inMatch && !kickoff ? (state.pendingMatch?.casterHistory ?? []) : buildGmHistory(state);

  // 헤더가 날짜를 옮기기 전의 시점 — 훈련 결산이 "어느 구간이었나"를 알아야 한다
  const sceneFrom = state.date;
  const clockFrom = clockOf(state);
  /**
   * 재시도의 조건 — **아직 아무 자국도 남지 않았을 때만.** 도구가 돌았으면 상태가
   * 이미 바뀌었고(이중 반영), 글자가 나갔으면 화면에 장면이 두 번 그려진다.
   * 대부분의 실패(인증·혼잡·한도·연결)는 첫 글자보다 먼저 온다.
   */
  let streamed = false;
  const trackText = onText
    ? (delta: string) => {
        streamed = true;
        onText(delta);
      }
    : undefined;
  const result = await retryOnce(
    inMatch ? "gm:match" : "gm:turn",
    () =>
      llm.runTurn({
        system,
        history,
        user: [
          ...(operatorOrders ?? []).map((order) => buildOperatorMessage(`전술판 조작 — ${order}`)),
          operator ? buildOperatorMessage(message) : buildManagerMessage(state, message),
        ].join("\n"),
        stateNote,
        tools,
        onText: trackText,
      }),
    () => streamed || calls.some((c) => c.name !== TIME_PASSED),
  );

  // 첫 줄 헤더가 시계를 움직인다 — 모델의 선언을 코어가 따라가되 그대로 믿지 않고,
  // 경기일·기한 앞에서 멈춘 뒤 그 사실을 기록으로 남긴다
  const scene = parseSceneHeader(result.text);
  // 헤더를 못 읽으면 시계가 멈춘다 — 조용히 지나가지 않게 첫 줄을 로그에 남긴다
  if (!inMatch && !scene.point) {
    const first = result.text.split("\n").find((line) => line.trim().length > 0) ?? "";
    console.warn(
      `[gm] 장면 헤더를 읽지 못해 시계가 멈춥니다: ${JSON.stringify(first.slice(0, 80))}`,
    );
  }
  // 헤더는 읽혔는데 시각이 안 움직인 턴 — 이어지는 대화면 정상이지만 몇 턴이고
  // 반복되면 세계가 정지하므로 로그로 드러낸다
  if (!inMatch && !skipped && scene.point && scene.point.date === sceneFrom) {
    if (minutesOfClock(scene.point.clock) <= minutesOfClock(clockFrom)) {
      console.warn(
        `[gm] 시계가 제자리입니다 (${sceneFrom} ${clockFrom}) — 헤더: ${JSON.stringify(
          (scene.header ?? "").slice(0, 60),
        )}`,
      );
    }
  }
  if (inMatch && scene.point) {
    // 경기 중엔 날짜를 막고 그날 안의 시각만 따라간다 — 안 그러면 상단 시계가
    // 킥오프 시각에 얼어붙는다
    applyScenePoint(state, { date: state.date, clock: scene.point.clock });
  } else if (!inMatch && scene.point && skipped) {
    // 손잡이가 이미 시계를 옮긴 턴 — 헤더의 날짜까지 따르면 하루를 눌렀는데 이틀이 간다
    applyScenePoint(state, { date: state.date, clock: scene.point.clock });
  } else if (!inMatch && scene.point) {
    const moved = applyScenePoint(state, scene.point);
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
      from: sceneFrom,
      to: state.date,
    });
    if (brief) pendingTraining.push(brief);
  }
  // 훈련 결산 — 코어 앵커 위에 LLM이 맥락을 더한다 (실패해도 앵커가 남는다).
  // 내부 판정이라 칩으로 세우지 않는다 — 결과는 달력의 훈련 기록이 갖는다
  for (const brief of pendingTraining) {
    await reportTraining(state, brief);
  }

  if (inMatch && state.pendingMatch) {
    state.pendingMatch.casterHistory = result.history;
    // 첫 휘슬을 불었다 — 이 뒤로는 패킷과 도구를 쥔 보통의 진행 턴이다
    if (kickoff) markEntered(state);
    if (state.pendingMatch.ledger.phase === "finished") {
      // 브리프는 장부가 살아 있을 때만 만들 수 있다 — finalizeMatch가 지우기 전에
      const brief = buildRatingBrief(state);
      const digest = finalizeMatch(state);
      calls.push({ name: "finalize_match", summary: digest.join(" · ") });
      // 평점 — 코어 앵커 위에 LLM이 입체를 더한다. 실패해도 앵커가 남는다
      if (brief) {
        const rated = await rateMatchPerformances(state, brief);
        if (rated.applied > 0) {
          calls.push({ name: "rate_players", summary: `경기 평점 ${rated.applied}명` });
        }
      }
      // 심경 — **평점이 매겨진 뒤에** 읽어야 "잘하고도 졌다"가 문장에 담긴다
      await rateMood(state, sceneFrom);
    }
  }
  // 시간이 흐른 턴의 심경 — 그 구간에 실제로 무슨 일이 있었던 선수만 다시 쓴다
  if (!inMatch && state.date !== sceneFrom) await rateMood(state, sceneFrom);
  // 출력 상한에 잘린 턴은 이미 스트리밍으로 나가 되돌릴 수 없다 — 원인만 로그에 남긴다
  if (result.stopReason === "max_tokens") {
    console.error(
      `[gm] 응답이 출력 상한(${config.maxTokens})에 걸려 잘렸습니다 — config/llm.yml의 max_tokens를 올려야 합니다`,
    );
  }
  // 선수 id를 이름으로 바꾸고 헤더를 되붙여 저장한다 — ⚠️ 헤더를 떼면 화면
  // (scene-stamp)의 시각이 스트리밍이 끝나는 순간 사라진다
  const body = humanizePlayerIds(state, scene.body);
  const text = scene.header ? `${scene.header}\n${body}` : body;
  return {
    text,
    toolCalls: calls,
    ...(goals.length > 0 ? { goals } : {}),
    ...(cards.length > 0 ? { cards } : {}),
    ...(arrivedReports(state, pendingReports).length > 0
      ? { reports: arrivedReports(state, pendingReports) }
      : {}),
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
  /** 감독의 발화가 아니라 화면 조작인가 (시간 이동 손잡이) */
  operator = false,
  /** 전술판 조작 — mock도 실제 GM처럼 이번 턴의 오퍼레이터 지시를 읽는다. */
  operatorOrders?: readonly string[],
): Promise<GmTurnResult> {
  if (resolveLlmMode() === "mock") {
    const mockMessage =
      !operator && operatorOrders && operatorOrders.length > 0
        ? `${operatorOrders.join("\n")}\n${message}`
        : message;
    return runMockGmTurn(state, mockMessage, onText);
  }
  return runRealGmTurn(state, message, onText, operator, operatorOrders);
}
