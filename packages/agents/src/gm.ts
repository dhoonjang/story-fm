/**
 * GM 오케스트레이터 — 단일 GM, 장면 라우팅 (agents.md §1·§2).
 *
 * **모드로 갈리지 않는다.** 실모드는 설정된 제공자의 tool loop이고, `LLM_MODE=mock`은
 * 그 모델 자리에 대본 어댑터를 세운다(`mock-gm.ts` — agents.md §8) — 도구도 입력 조립도
 * 기록도 같은 코드다. 상태 변경의 유일한 통로는 엔진 명령 하나뿐이다.
 *
 * 실모드 한 턴은 **앞·호출·뒤** 셋이다 (agents.md §2 「턴은 앞·호출·뒤 셋이다」) —
 * `openTurn`이 모델보다 먼저 코어를 굴리고, `callGm`이 3층 입력을 조립해 부르고,
 * `closeTurn`이 장면·시계·결산을 받아 적는다. 세 단계가 주고받는 것은 이번 턴의
 * 장부(`TurnLedger`)와 턴 앞이 남긴 것(`TurnOpening`)뿐이다.
 */
import {
  advanceForOperation,
  applyScenePoint,
  awaitingShootout,
  buildTrainingBrief,
  clockOf,
  formatClock,
  humanizePlayerIds,
  markEntered,
  minutesOfClock,
  arrivedResponses,
  pendingVerdicts,
  selectCharacters,
  takeMedia,
  takeNews,
  toolCallFactLine,
  type AdvanceOutcome,
  type CardMark,
  type ClockSource,
  type GameState,
  type GoalMark,
  type TrainingBrief,
} from "@story-fm/engine";
import type { CharacterEntry } from "@story-fm/domain";
import { agentConfig, createGameLLM, resolveLlmMode, type TurnResult } from "@story-fm/llm";
import { MAX_REPORT_CARDS, NO_CARDS, takeArrivedReports, type ArrivedCards } from "./report-cards";
import { reportTraining } from "./training-rater";
import { buildMatchTools, KICKOFF_BLOCK, MATCH_GM_SYSTEM, type MatchToolContext } from "./match-gm";
import { finalizeMatchTurn } from "./finalize-match";
import { runTableReply } from "./negotiation-table";
import { openLetter, settleTableReply } from "@story-fm/engine";
import { mockGmLlm } from "./mock-gm";
import { retryOnce } from "./retry";
import { GM_SYSTEM } from "./gm-prompt";
import { buildGmTools } from "./gm-tools";
import { applyTacticOrders, type AppliedTacticOrders } from "./tactic-apply";
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

/** 장면이 섰는가 — 출력 문법이 요구하는 것은 `@`로 여는 줄 하나다 (prompts.md §1) */
function hasSceneLine(text: string): boolean {
  return text.split("\n").some((line) => line.trim().startsWith("@"));
}

/**
 * 장면이 비어 돌아온 턴을 세우는 **코어의 기록** — 호출이 남긴 요약을 내레이션
 * (`@:`) 줄로 옮긴다.
 *
 * ⚠️ **대사는 쓰지 않는다.** 여기 서는 것은 장부가 이미 아는 사실뿐이고, 그래서
 * "장면을 대신 써 주지 않는다"와 어긋나지 않는다 (agents.md §2·§8). 세울 기록이
 * 없으면 null이다 — 그 턴은 아무것도 하지 않았다.
 */
function sceneFromToolCalls(calls: readonly GmToolCall[]): string | null {
  const lines = calls
    .map(toolCallFactLine)
    .filter((line) => line.length > 0)
    .map((line) => `@: *${line}*`);
  return lines.length > 0 ? lines.join("\n") : null;
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

/**
 * 모드 해석은 `packages/llm`이 갖는다 — 키를 읽는 자리와 같은 파일이다
 * (models.md §2). 여기서 다시 내보내는 것은 화면·에이전트가 부르던 자리를
 * 그대로 두기 위해서다.
 */
export { resolveLlmMode, type LlmMode } from "@story-fm/llm";

/**
 * **편지의 답 — 답할 날이 된 오퍼는 턴이 열리기 전에 상대가 답한다** (agents.md §4-1).
 * 답하는 것은 테이블과 같은 호출(`negotiation-table`)이고 GM이 아니다 — GM은 감독의
 * 말을 전부 읽으므로 상대가 되면 감독의 속을 다 본 사람이 된다. 호출이 실패해도 앵커가
 * 판정이라 답이 도착한 자리가 비지 않는다. 기록은 `respond_offer`로 남고(장부가
 * 움직였다), 상대의 말은 `<letters>`로 이번 턴 층에 실려 GM이 장면으로 옮긴다.
 */
async function answerLetters(state: GameState, calls: GmToolCall[]): Promise<string[]> {
  const letters: string[] = [];
  for (const negotiation of [...arrivedResponses(state)]) {
    const opened = openLetter(state, negotiation.id);
    if (!opened.ok) continue;
    /**
     * **편지도 화자를 싣는다** — 답한 목소리가 둘일 수 있다 (transfer.md §12-1). 누가
     * 어느 말을 했는지는 `outcome.message`의 `<reply speaker name>` 줄이 들고, 여기
     * `from`은 그 사람들을 이름으로 부른다.
     */
    const from = opened.seat.voices.map((v) => v.name).join(" · ") || "상대";
    const reply = await runTableReply(state, opened.seat, null);
    const outcome = settleTableReply(state, opened.seat, reply ?? undefined);
    recordCall(calls, "respond_offer", outcome, { input: { negotiationId: negotiation.id } });
    letters.push(
      `<letter negotiation="${negotiation.id}" from="${from}">\n${outcome.message}\n</letter>`,
    );
  }
  return letters;
}

/** 이 턴이 어떤 턴인가 — 세 단계가 같은 것을 읽는다 */
interface TurnShape {
  /** 경기 장면인가 — 라우팅이 `match-gm`으로 갈린다 */
  inMatch: boolean;
  /**
   * 킥오프 턴 — **경기의 첫 호흡.** 감독이 경기장에 들어선 그 한 턴이다.
   *
   * 도구를 주지 않아 구간이 굴러갈 수 없고, 패킷도 싣지 않는다. 대신 평시 이력을
   * 그대로 넘겨(`relevantTurns`) 라커룸에서 이어지는 목소리로 첫 휘슬만 연다.
   */
  kickoff: boolean;
  /** 손잡이 턴인가 — 감독이 친 말이 아니다 (`message`는 표시 문구다) */
  operator: boolean;
}

/**
 * 세 단계가 함께 채우는 **이번 턴의 장부** — 호출 기록·표식·결산 대기.
 * 도구 핸들러도 같은 배열에 적으므로 참조로 돌아다닌다.
 */
interface TurnLedger {
  calls: GmToolCall[];
  /** 이번 턴에 들어간 골 — 장부의 사건에서 만든다 (중계 문장을 되읽지 않는다) */
  goals: GoalMark[];
  /** 이번 턴의 경고·퇴장 — 같은 경로다. 경고는 다음 교체 판단의 입력이다 */
  cards: CardMark[];
  /** 굴러간 구간에 소화된 훈련 — 턴 뒤에서 한 번에 결산한다 */
  training: TrainingBrief[];
  /** 마감이 지운 장부의 마지막 분 — 화면의 시각 줄이 읽는다 (agents.md §3) */
  finalMinute: number | null;
}

/** 턴 앞이 남긴 것 — 호출과 턴 뒤가 함께 읽는다 */
interface TurnOpening {
  /**
   * 이 턴이 시작한 날짜·시각 — **손잡이보다도, 장면보다도 먼저** 잡는다.
   *
   * 결산(훈련·심경)이 보는 구간의 시작이 `from`이다. 시계가 도는 자리가 둘이라
   * (손잡이는 장면 앞, 헤더는 장면 뒤 — agents.md §2) 장면 뒤에 잡으면 손잡이 턴의
   * 구간이 길이 0이 되어 결산이 아예 돌지 않는다. `clockFrom`은 "시계가 제자리인가"를
   * 재는 자리다.
   */
  from: string;
  clockFrom: string;
  /** 손잡이가 굴린 결과 — 굴릴 것이 없었거나 손잡이 턴이 아니면 null */
  skipped: AdvanceOutcome | null;
  /** 답할 날이 된 편지 — 이번 턴 층에 실린다 */
  letters: string[];
  /**
   * 지난 턴이 **장면 뒤에** 받아 둔 보고서 — 이번 턴 스냅샷이 값을 싣고 카드도 이번
   * 턴에 선다.
   */
  carried: ArrivedCards;
  /** 손잡이가 굴려 도착한 보고서 — 그 값은 「그 사이 벌어진 일」이 이미 싣는다 */
  skippedCards: ArrivedCards;
  /** 시간 이동 중 새로 생긴 오퍼 — 이번 장면에서 보고만 하고 감독의 답을 기다린다 */
  deferNegotiationIds: Set<string>;
  /** 손잡이 턴에 코어가 먼저 굴린 구간 — GM은 그 대본을 받아 중계만 쓴다 */
  applied: AppliedTacticOrders | null;
  /** 호출 직전 장부의 분 — 평시는 null. 경기 장면의 시각이 여기서 온다 (agents.md §3 ④) */
  matchMinute: number | null;
}

/**
 * 코어가 시계를 옮긴 자국 — **호출이 아니라 코어가 한 일**이라 조용히 남는다
 * (`TIME_PASSED` 주석). 시계가 도는 두 자리가 같은 함수로 적는다.
 */
function noteTimePassed(ledger: TurnLedger, head: string, digest: readonly string[]): void {
  ledger.calls.push({ name: TIME_PASSED, summary: [head, ...digest].join("\n"), silent: true });
}

/** 굴러간 구간의 훈련 결산 — 소화된 세션이 없으면 브리핑이 서지 않는다 */
function noteTraining(
  state: GameState,
  ledger: TurnLedger,
  moved: AdvanceOutcome,
  from: string,
): void {
  const brief = buildTrainingBrief(state, moved.trained?.sessions ?? [], { from, to: state.date });
  if (brief) ledger.training.push(brief);
}

/** 지금 장부의 분 — 도구가 시계를 옮겼으면 옮긴 뒤의 것, 마감 뒤면 마지막 분 */
function minuteNow(state: GameState, ledger: TurnLedger, opening: TurnOpening): number {
  return ledger.finalMinute ?? state.pendingMatch?.ledger.minute ?? opening.matchMinute ?? 0;
}

/**
 * **턴 앞 — 모델보다 먼저 코어가 하는 일.**
 *
 * 답할 날이 된 편지, 손잡이의 시간 이동, 지난 턴이 받아 둔 보고서, 손잡이 턴의
 * 전술판 적용. 여기서 바뀐 상태가 그대로 이번 턴의 입력이 되므로 **모델은 도착한
 * 자리에서 보고한다**.
 */
async function openTurn(
  state: GameState,
  shape: TurnShape,
  operation: TurnOperation | null | undefined,
  ledger: TurnLedger,
): Promise<TurnOpening> {
  const { inMatch, kickoff, operator } = shape;
  const from = state.date;
  const clockFrom = clockOf(state);
  /**
   * 이번 턴에 조립이 안 된 보고서 — 줄에는 그대로 남아 있다. 아래에서 줄을 한 번 더
   * 보므로(손잡이가 시계를 옮긴 턴) 적어 두지 않으면 두 번째 호출이 같은 자리에서
   * 다시 멎어, 그 뒤에 서 있던 카드가 이번 턴에도 못 선다.
   */
  const stuckCards = new Set<string>();
  /**
   * ⚠️ 손잡이가 시계를 옮기기 **전에** 꺼낸다: 그 뒤에 도착하는 것은 「그 사이 벌어진
   * 일」이 따로 실으므로, 여기 섞이면 한 프롬프트에 같은 값이 두 번 실린다 (agents.md §6).
   */
  const carried = inMatch ? NO_CARDS : takeArrivedReports(state, MAX_REPORT_CARDS, stuckCards);
  // 손잡이로 넘긴 시간은 모델보다 먼저 흐른다 — 코어가 먼저 굴리고 "그 사이
  // 벌어진 일"을 상태에 실어, 모델은 도착한 자리에서 보고한다
  const pendingBeforeSkip = new Set(pendingVerdicts(state).map((v) => v.negotiation.id));
  const skipped = !inMatch && operation ? advanceForOperation(state, operation) : null;
  if (skipped) {
    noteTimePassed(
      ledger,
      `${from} → ${state.date} — ${ADVANCE_STOP_KO[skipped.stopped] ?? "진행했다"}`,
      skipped.digest,
    );
    noteTraining(state, ledger, skipped, from);
  }
  const skippedCards = skipped
    ? takeArrivedReports(
        state,
        MAX_REPORT_CARDS - carried.reports.length - carried.missions.length,
        stuckCards,
      )
    : NO_CARDS;
  const deferNegotiationIds = new Set(
    skipped
      ? pendingVerdicts(state)
          .map((v) => v.negotiation.id)
          .filter((id) => !pendingBeforeSkip.has(id))
      : [],
  );
  // 답할 날이 된 편지는 상대가 먼저 답한다 — 이번 턴의 장면은 그 답 뒤에 선다 (agents.md §4-1)
  const letters = inMatch ? [] : await answerLetters(state, ledger.calls);
  /**
   * **손잡이로 온 경기 턴은 모델이 결정할 것이 없다** — 화면의 대기 중 교체·좌표·역할·
   * 전술 축은 코어가 이미 적용했고(match.md §2), `계속`이 뜻하는 것은 진행 하나뿐이다.
   * 코어가 먼저 굴려 대본을 이번 턴 층에 싣고, GM은 그 턴에 마감 도구만 쥔다.
   *
   * 킥오프 턴은 지나간다 — 감독이 아직 아무것도 지시하지 않았고, 첫 휘슬만 여는
   * 자리라 구간이 굴러가면 안 된다.
   */
  const applied =
    inMatch && !kickoff && operator
      ? applyTacticOrders(state, { ops: {} }, ledger.calls, ledger.goals, ledger.cards, {
          roll: true,
        })
      : null;
  return {
    from,
    clockFrom,
    skipped,
    letters,
    carried,
    skippedCards,
    deferNegotiationIds,
    applied,
    // 구간이 굴러간 뒤이자 `finalizeMatch`가 장부를 지우기 전인 지금이 읽을 수 있는 유일한 자리다
    matchMinute: inMatch ? (state.pendingMatch?.ledger.minute ?? null) : null,
  };
}

/** 호출이 낸 것 — 턴 뒤가 읽는다 */
interface GmCall {
  result: TurnResult;
  /** 이번 턴에 세운 인물 카드 — 턴 뒤가 기록으로 남긴다 */
  characters: CharacterEntry[];
}

/**
 * **호출 — 3층 입력을 조립해 한 번 부른다** (agents.md §5).
 *
 * 입력은 안정성 순 3층이다: ① 고정 프롬프트 ② 레퍼런스 ③ 발화+상태 스냅샷.
 * 앞 두 층만 캐시 프리픽스(0.1×)다.
 */
async function callGm(
  state: GameState,
  message: string,
  shape: TurnShape,
  opening: TurnOpening,
  ledger: TurnLedger,
  matchCtx: MatchToolContext,
  onText: ((delta: string) => void) | undefined,
  operatorOrders: readonly string[] | undefined,
): Promise<GmCall> {
  const { inMatch, kickoff, operator } = shape;
  const config = agentConfig(inMatch ? "match-gm" : "gm");
  /**
   * **모델 자리에 서는 것** — mock 모드면 대본 어댑터다 (agents.md §8). 턴 앞이 이미
   * 남긴 기록(손잡이의 시간 이동·도착한 편지)이 있으면 대본은 장면을 비워 낸다:
   * 그 기록이 아래에서 장면을 세운다.
   */
  const llm =
    mockGmLlm(config, state, {
      message,
      inMatch,
      kickoff,
      operator,
      recorded: () => ledger.calls.length > 0,
    }) ?? createGameLLM(config);
  /**
   * 경기 중 도구는 **경기 도구 셋**뿐이다 — 코어를 부르는 손잡이이고 경기를 바꾸지
   * 못한다 (agents.md §3). 손잡이 턴은 마감 하나, 킥오프 턴은 없다. 도구 정의는
   * 고정층이지만 셋뿐이라 평시의 56개와는 눈금이 다르다 (agents.md §5).
   */
  const tools = inMatch
    ? kickoff
      ? []
      : buildMatchTools(state, matchCtx, { operator })
    : buildGmTools(state, ledger.calls, { deferNegotiationIds: opening.deferNegotiationIds });
  const system = inMatch ? [MATCH_GM_SYSTEM, buildMatchReference(state)] : peaceSystem(state);
  /**
   * **패킷은 구간이 굴러간 뒤에만 싣는다.** 선수를 부른 한 마디에 패킷 전체를 실으면
   * GM이 읽지도 않을 판세를 매 턴 정가로 읽는다 (agents.md §5). GM이 굴린 구간의
   * 패킷은 도구 결과가 싣고, 여기서 싣는 것은 손잡이가 먼저 굴린 턴의 것이다. 킥오프
   * 턴도 판이 없다 — 아직 아무 일도 일어나지 않았는데 판세를 쥐여 주면 첫 마디부터
   * 우열을 읊는다.
   */
  const stateNote = inMatch
    ? buildLedgerNote(state, { withPacket: opening.applied?.segment != null })
    : buildGmStateNote(
        state,
        opening.skipped
          ? {
              from: opening.from,
              stopped: ADVANCE_STOP_KO[opening.skipped.stopped] ?? "진행했다",
              digest: opening.skipped.digest,
            }
          : null,
        opening.carried.reports,
        opening.carried.missions,
      ) +
      (opening.letters.length > 0
        ? `\n\n<letters>\n${opening.letters.join("\n")}\n</letters>`
        : "");
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
   * 경기의 첫 줄은 코어가 쓴다 — 모델이 적은 시각은 화면에 닿기 전에 걷힌다.
   * 위생은 두 국면에 다 걸린다 — 걸러질 줄이 화면에 잠깐 떴다 사라지면 그것대로
   * 눈에 띄므로 저장과 화면에 같은 것이 선다 (agents.md §2). 중계가 읽는 것은
   * 꺾쇠 규칙 하나뿐이고, 코어의 시각 줄은 그 체를 지나 화면에 선다.
   */
  const streamText = !trackText
    ? undefined
    : inMatch
      ? opening.matchMinute !== null
        ? stampMatchStream(() => minuteNow(state, ledger, opening), filterCasterStream(trackText))
        : filterCasterStream(trackText)
      : filterSceneStream(trackText);
  /** 이 호출이 남긴 자국 — 그 전에 코어가 남긴 기록(손잡이의 구간)은 세지 않는다 */
  const callsBefore = ledger.calls.length;
  const result = await retryOnce(
    inMatch ? "gm:match" : "gm:turn",
    () =>
      llm.runTurn({
        system,
        history,
        user: [
          turnMessage,
          // 킥오프 턴의 표식 — 도구도 대본도 없는 턴이 첫 휘슬이라는 것을 입력이 말한다
          ...(inMatch && kickoff ? [``, KICKOFF_BLOCK] : []),
          // 손잡이가 먼저 굴린 구간 — GM은 이 대본을 받아 중계만 쓴다
          ...(inMatch && !kickoff && operator
            ? [
                ``,
                opening.applied?.segment ?? "<segment>\n- (진행 없음)\n</segment>",
                ...(opening.applied && opening.applied.notes.length > 0
                  ? [
                      `<core_replies>`,
                      ...opening.applied.notes.map((n) => `- ${n}`),
                      `</core_replies>`,
                    ]
                  : []),
              ]
            : []),
        ].join("\n"),
        stateNote,
        tools,
        onText: streamText,
      }),
    /**
     * 자국은 **이 호출이 남긴 것만** 센다 — 도구가 돌았거나(구간·마감) 델타가 나갔으면
     * 다시 부르지 않는다. 손잡이가 이 호출 **앞에** 굴린 구간은 이 호출의 자국이
     * 아니다 — 그것까지 세면 손잡이 턴이 첫 실패에 그대로 무너진다 (agents.md §3·§8).
     */
    () => streamed || ledger.calls.slice(callsBefore).some((c) => c.name !== TIME_PASSED),
  );
  // 출력 상한에 잘린 턴은 이미 스트리밍으로 나가 되돌릴 수 없다 — 원인만 로그에 남긴다
  if (result.stopReason === "truncated") {
    console.error(
      `[gm] 응답이 출력 상한(${config.maxTokens})에 걸려 잘렸습니다 — config/llm.yml의 max_tokens를 올려야 합니다`,
    );
  }
  return { result, characters };
}

/**
 * 이번 턴 **날짜의 주인** — 시계를 옮기는 코어 호출이 이것 하나로 갈린다
 * (agents.md §2 「시계」). 규칙 자체는 `applyScenePoint`가 갖는다.
 */
function clockSourceOf(shape: TurnShape, opening: TurnOpening): ClockSource {
  if (shape.inMatch) return "ledger";
  return opening.skipped ? "operator" : "header";
}

/**
 * **턴 뒤 — 모델이 낸 것을 코어가 받아 적는다.**
 *
 * 장면 위생 · 헤더 파싱 · **시계 한 줄** · 코어의 마감 · 훈련 결산 · 저장할 본문 조립.
 */
async function closeTurn(
  state: GameState,
  shape: TurnShape,
  opening: TurnOpening,
  ledger: TurnLedger,
  call: GmCall,
): Promise<GmTurnResult> {
  const { inMatch, kickoff } = shape;
  const { result } = call;
  /**
   * **GM이 마감을 부르지 않았으면 코어가 대신 부른다** (agents.md §3 「경기 마감」) —
   * 경기가 끝났는데 열려 있는 세이브는 없다. 마무리 중계는 장면 끝에 붙는다.
   */
  let closingTail = "";
  if (
    inMatch &&
    state.pendingMatch &&
    state.pendingMatch.ledger.phase === "finished" &&
    !awaitingShootout(state)
  ) {
    ledger.finalMinute = state.pendingMatch.ledger.minute;
    const outcome = await finalizeMatchTurn(state, ledger.calls);
    if (outcome && outcome.closing.length > 0) closingTail = outcome.closing;
  }

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
  if (
    opening.matchMinute !== null &&
    scene.minute !== null &&
    scene.minute !== minuteNow(state, ledger, opening)
  ) {
    console.warn(
      `[gm] 중계의 시각 ${scene.minute}′ — 장부(${minuteNow(state, ledger, opening)}′)로 세웁니다`,
    );
  }
  /**
   * 헤더를 못 읽으면 시계가 멈춘다 — 첫 줄을 로그에 남기고 **연달은 횟수를 센다.**
   * 로그만으로는 정지가 조용히 쌓이므로, 셋이 되면 그 수가 턴 결과로 올라가
   * 화면이 띠를 세운다 (`GmTurnResult.clockStalled` — agents.md §2).
   * 손잡이가 이미 시계를 옮긴 턴은 헤더가 날짜를 또 밀지 못하는 것이 정상이다.
   */
  let clockStalled: number | null = null;
  if (!inMatch) {
    clockStalled = noteSceneHeader(state, scenePoint !== null || opening.skipped !== null);
    if (!scenePoint) {
      const first = sceneText.split("\n").find((line) => line.trim().length > 0) ?? "";
      console.warn(
        `[gm] 장면 헤더를 읽지 못해 시계가 멈춥니다: ${JSON.stringify(first.slice(0, 80))}`,
      );
    }
  }
  // 헤더는 읽혔는데 시각이 안 움직인 턴 — 이어지는 대화면 정상이지만 몇 턴이고
  // 반복되면 세계가 정지하므로 로그로 드러낸다
  if (
    !inMatch &&
    !opening.skipped &&
    scenePoint &&
    scenePoint.date === opening.from &&
    minutesOfClock(scenePoint.clock) <= minutesOfClock(opening.clockFrom)
  ) {
    // 헤더가 여럿이면 시계를 정하는 것은 마지막 것이라, 읽어낸 시점을 그대로 적는다
    console.warn(
      `[gm] 시계가 제자리입니다 (${opening.from} ${opening.clockFrom}) — 헤더가 닿은 곳: ${scenePoint.date} ${scenePoint.clock}`,
    );
  }
  // ⚠️ 시계를 옮기는 자리는 여기 하나다 — 날짜를 미는지 고정하는지는 출처가 정한다
  if (scenePoint) {
    const moved = applyScenePoint(state, scenePoint, clockSourceOf(shape, opening));
    if (moved.digest.length > 0 || moved.short) {
      noteTimePassed(
        ledger,
        `${state.date} ${formatClock(clockOf(state))}${
          moved.short ? ` — ${ADVANCE_STOP_KO[moved.stopped] ?? "멈췄다"}` : ""
        }`,
        moved.digest,
      );
    }
    noteTraining(state, ledger, moved, opening.from);
  }
  /**
   * 훈련 결산 — 코어 앵커 위에 LLM이 맥락을 더한다 (실패해도 앵커가 남는다).
   *
   * 내부 판정이라 칩으로 세우지 않는다. 결과는 **장부의 결산 카드**가 갖는다
   * (`state.trainingReports`) — 달력 일지가 그 카드를 문장으로 펼치고, 다음 턴의
   * 스냅샷 `<coach>` 첫 줄이 구간과 이름을 싣는다
   * (docs/simulation/season.md §4 · docs/llm/agents.md §6).
   */
  for (const brief of ledger.training) {
    await reportTraining(state, brief);
  }

  // 마감된 경기는 장부가 지워졌다 — 이 경기의 중계 이력은 더 쓰이지 않는다
  if (inMatch && state.pendingMatch) {
    state.pendingMatch.casterHistory = result.history;
    // 첫 휘슬을 불었다 — 이 뒤로는 경기 도구 셋을 쥔 보통의 진행 턴이다
    if (kickoff) markEntered(state);
  }
  // 선수 id를 이름으로 바꾸고 헤더를 되붙여 저장한다 — ⚠️ 헤더를 떼면 화면
  // (scene-stamp)의 시각이 스트리밍이 끝나는 순간 사라진다.
  // 경기 장면의 헤더는 모델의 것이 아니라 장부의 분이다 (스트리밍에 나간 것과 같다)
  let body = humanizePlayerIds(state, scene.body);
  let header = scene.header;
  // 코어가 대신 마감한 턴 — 마감 에이전트의 마무리 중계가 장면 끝에 선다
  if (closingTail.length > 0) body = `${body.trimEnd()}\n${humanizePlayerIds(state, closingTail)}`;
  /**
   * **장면이 비어 돌아온 턴** — 왕복 상한을 도구로 채우면(`stopReason === "tool_use"`)
   * 모델은 "확인하겠습니다" 한 줄만 남기거나 아무것도 쓰지 못한다. 도구는 이미 돌아
   * 라인업과 훈련이 바뀐 뒤라 되돌릴 수 없으므로, 코어가 이번 턴의 기록으로 세운다
   * (agents.md §2·§8). 기록도 장면도 없으면 저장하지 않고 턴을 되돌린다.
   */
  if (!inMatch && !hasSceneLine(body)) {
    const record = sceneFromToolCalls(ledger.calls);
    if (record) {
      // mock 모드에서는 이것이 계약이다 — 대본은 장면을 쓰지 않는다 (agents.md §8)
      if (resolveLlmMode() !== "mock") {
        console.warn(
          `[gm] 장면이 비어 코어 기록으로 세웁니다 — 종료 사유: ${result.stopReason ?? "없음"}`,
        );
      }
      body = record;
      // 모델이 헤더도 못 썼으면 코어가 지금 시각을 세운다 — 헤더가 없으면 화면의
      // 시각이 스트리밍이 끝나는 순간 사라진다
      header ??= `[${state.date} ${formatClock(clockOf(state))}]`;
    } else if (body.trim().length === 0) {
      throw new GmTurnFailure("모델이 아무 장면도 내지 않아 턴을 취소했습니다.");
    }
  }
  const text =
    opening.matchMinute !== null
      ? stampMatchScene(body, minuteNow(state, ledger, opening))
      : header
        ? `${header}\n${body}`
        : body;
  /**
   * 카드는 **모델이 값을 읽은 것만** 선다. 장면 헤더가 시계를 옮긴 턴은 코어가 방금
   * 굴렀으므로 그 도착은 줄에 남아 다음 턴에 선다 (`pendingReportCards`) — 이번 턴에
   * 조립이 안 된 것도 마찬가지로 줄에 남는다 (player.md §9.4-1).
   */
  const reports = [...opening.carried.reports, ...opening.skippedCards.reports];
  const missions = [...opening.carried.missions, ...opening.skippedCards.missions];
  // 실은 카드를 그 턴에 기록한다 — 다음 턴부터 이력이 같은 카드를 다시 그린다.
  // 턴이 실패하면 상태가 통째로 버려지므로 기록도 함께 없던 일이 된다
  recordCharacterInjection(state, call.characters);
  return {
    text,
    toolCalls: ledger.calls,
    ...(ledger.goals.length > 0 ? { goals: ledger.goals } : {}),
    ...(ledger.cards.length > 0 ? { cards: ledger.cards } : {}),
    ...(reports.length > 0 ? { reports } : {}),
    ...(missions.length > 0 ? { missions } : {}),
    ...(clockStalled !== null ? { clockStalled } : {}),
    usage: result.usage,
  };
}

/**
 * **GM 턴 실행** — 일상은 `gm`, 경기 장면은 `match-gm` 설정으로 라우팅한다.
 *
 * 모드로 갈리지 않는다: `LLM_MODE=mock`이면 모델 자리에 대본 어댑터가 서고 나머지는
 * 그대로다 (agents.md §8). `onText`를 주면 서사 텍스트가 스트리밍으로 흐른다 —
 * 실모드는 진짜 델타, 대본은 완성 텍스트를 줄로 쪼개 즉시 방출한다.
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
  /** 전술판 조작 — 코어가 **이미 적용한** 것의 기록이다 */
  operatorOrders?: readonly string[],
): Promise<GmTurnResult> {
  const inMatch = state.phase === "match";
  const shape: TurnShape = {
    inMatch,
    kickoff: inMatch && state.pendingMatch?.entered !== true,
    operator: operation != null,
  };
  const ledger: TurnLedger = {
    calls: [],
    goals: [],
    cards: [],
    training: [],
    finalMinute: null,
  };
  const matchCtx: MatchToolContext = {
    calls: ledger.calls,
    goals: ledger.goals,
    cards: ledger.cards,
    onFinalized: (minute) => (ledger.finalMinute = minute),
  };
  const opening = await openTurn(state, shape, operation, ledger);
  const call = await callGm(
    state,
    message,
    shape,
    opening,
    ledger,
    matchCtx,
    onText,
    operatorOrders,
  );
  return closeTurn(state, shape, opening, ledger, call);
}
