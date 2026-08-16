import {
  loadGame,
  refreshPacket,
  saveGame,
  setPlayerTactic,
  setTactics,
  substitutePlayer,
  takeEdits,
  type GameState,
} from "@story-fm/engine";
import { runGmTurn } from "@story-fm/agents";
import { toPayload, type GamePayload } from "./store";
import type { MatchBoardOrder } from "./match-orders";

function applyMatchBoardOrder(state: GameState, order: MatchBoardOrder) {
  switch (order.kind) {
    case "position":
      return setPlayerTactic(state, {
        playerId: order.playerId,
        position: order.position,
        point: order.point,
      });
    case "role":
      return setPlayerTactic(state, { playerId: order.playerId, role: order.role });
    case "substitution":
      return substitutePlayer(state, { out: order.out, in: order.in });
    case "tactic":
      switch (order.axis) {
        case "mentality":
          return setTactics(state, { mentality: order.value });
        case "defensiveLine":
          return setTactics(state, { defensiveLine: order.value });
        case "pressing":
          return setTactics(state, { pressing: order.value });
        case "tempo":
          return setTactics(state, { tempo: order.value });
        case "width":
          return setTactics(state, { width: order.value });
        case "passStyle":
          return setTactics(state, { passStyle: order.value });
      }
  }
}

/**
 * 게임별 턴 직렬화 — 같은 게임의 동시 요청(턴·라인업 편집)이 저장을 서로
 * 덮어쓰지 않게 프로세스 내 뮤텍스로 순차 처리한다 (리뷰 발견: 저장 경합).
 * JSON 턴·스트리밍 턴·라인업 편집이 이 잠금을 공유한다.
 */
const locks = new Map<string, Promise<unknown>>();
export function withGameLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    id,
    next.catch(() => undefined),
  );
  return next;
}

export type TurnOutcome =
  | { ok: true; payload: GamePayload }
  | { ok: false; status: number; error: string; detail?: string };

/**
 * LLM 실패를 감독에게 보일 한 줄로 — **게임 밖의 사건**이므로 픽션 밖 말투로.
 * 원인 문자열은 서버 로그에만 남기고, 화면에는 대처 가능한 안내만 준다.
 * 새 게임 첫 장면(`/api/games`)도 같은 문구를 쓴다 — 폴백 장면은 없다.
 */
export function turnErrorMessage(detail: string): string {
  const d = detail.toLowerCase();
  if (d.includes("overloaded") || d.includes("529")) {
    return "모델 서버가 혼잡합니다 — 잠시 후 다시 시도해 주세요.";
  }
  if (d.includes("rate limit") || d.includes("429")) {
    return "요청 한도를 넘었습니다 — 잠시 후 다시 시도해 주세요.";
  }
  if (d.includes("timeout") || d.includes("etimedout") || d.includes("abort")) {
    return "응답이 지연돼 턴을 취소했습니다 — 다시 시도해 주세요.";
  }
  if (d.includes("api key") || d.includes("authentication") || d.includes("401")) {
    return "LLM 인증 정보가 올바르지 않습니다 — 서버 설정을 확인해 주세요.";
  }
  return "응답을 받지 못해 지시를 반영하지 못했습니다 — 다시 시도해 주세요.";
}

/**
 * 유저 턴 → GM 실행 → 모델 턴 (agents.md §2), 잠금·원자성 포함.
 * onDelta를 주면 GM 서사 텍스트를 스트리밍으로 흘려보낸다.
 *
 * 원자성 — 성공할 때만 저장한다. GM 턴이 중간에 실패하면 부분 실행된 도구
 * 효과는 이 메모리 상태에만 있었으므로 저장하지 않는 것이 곧 롤백이다
 * (리뷰 발견: 부분 커밋 + 재시도 유도 → 중복 실행).
 *
 * **실패는 채팅에 남기지 않는다.** LLM·API 오류는 픽션 밖의 사건이라 세계의
 * 화자(수석코치 등)가 알 수 없다 — 예전에는 수석코치가 "처리하지 못했습니다"
 * 라고 사과하며 오류 문자열까지 읊어 세계의 경계가 무너졌다. 유저 발화도
 * 기록하지 않는다: 턴 자체가 없었던 일이 되어야 다시 보내도 중복이 없다.
 */
export function runTurnLocked(
  id: string,
  message: string,
  onDelta?: (text: string) => void,
  /**
   * 감독의 발화가 아니라 **화면 조작**인가 (시간 이동 손잡이).
   * 채팅에 그리지 않고, 모델 이력에도 오퍼레이터 지시로 들어간다.
   */
  operator = false,
  /**
   * 전술판에서 쌓인 조작 — 감독의 말보다 **먼저** 들어간다.
   *
   * 조작할 때마다 턴을 태우지 않는 이유는 중계 중에도 판을 만질 수 있어야 하기
   * 때문이다(모델이 응답 중엔 턴을 보낼 수 없다). 대신 다음으로 말을 건네거나
   * 경기를 진행할 때 한 묶음으로 전달된다 — 그래서 **한 번의 LLM 호출**로 끝난다.
   */
  orders?: readonly MatchBoardOrder[],
): Promise<TurnOutcome> {
  return withGameLock(id, async () => {
    const state = loadGame(id);
    if (!state) return { ok: false as const, status: 404, error: "게임을 찾을 수 없습니다" };

    /**
     * 경기 중인가 — **턴을 시작할 때** 본다. 이 턴에서 경기가 끝나더라도
     * 감독이 말을 건 상대는 중계였으므로 그 턴은 경기 이력에 속한다.
     */
    const inMatch = state.phase === "match";
    const matchId = state.pendingMatch?.matchId;
    const mark = inMatch ? { inMatch: true as const, ...(matchId ? { matchId } : {}) } : {};
    // 판에서 쌓인 조작은 LLM이 다시 해석하지 않는다. 구조화된 ID·값을 코어 스킬로
    // 먼저 적용하고, 모델에는 이미 반영된 사실만 넘긴다.
    const appliedOrders: string[] = [];
    if (orders !== undefined && orders.length > 0) {
      for (const order of orders) {
        const result = applyMatchBoardOrder(state, order);
        if (!result.ok) {
          return {
            ok: false as const,
            status: 400,
            error: "전술판 지시를 반영하지 못했습니다",
            detail: result.message,
          };
        }
        appliedOrders.push(`전술판 적용 완료 — ${result.message} (다시 적용하지 말 것)`);
      }
      refreshPacket(state);
      state.chat.push({
        role: "operator",
        text: appliedOrders.join("\n"),
        toolCalls: [],
        at: state.date,
        ...mark,
      });
    }
    state.chat.push({
      role: operator ? "operator" : "user",
      text: message,
      toolCalls: [],
      at: state.date,
      ...(inMatch ? { inMatch: true, ...(matchId ? { matchId } : {}) } : {}),
    });
    try {
      const turn = await runGmTurn(state, message, onDelta, operator, appliedOrders);
      state.chat.push({
        role: "model",
        text: turn.text,
        toolCalls: turn.toolCalls,
        at: state.date,
        ...(turn.goals && turn.goals.length > 0 ? { goals: turn.goals } : {}),
        ...(turn.cards && turn.cards.length > 0 ? { cards: turn.cards } : {}),
        ...(turn.reports && turn.reports.length > 0 ? { reports: turn.reports } : {}),
        // 킥오프 턴은 시작할 땐 평시였지만 끝나면 경기 중이다 — 중계가 말한 턴이다.
        // 종료 턴은 반대로 시작할 때만 경기 중이므로 그때의 matchId를 들고 간다
        ...(inMatch || state.phase === "match"
          ? {
              inMatch: true,
              ...((matchId ?? state.pendingMatch?.matchId)
                ? { matchId: (matchId ?? state.pendingMatch?.matchId)! }
                : {}),
            }
          : {}),
      });
      /**
       * 화면 조작 기록은 **읽힌 뒤에** 비운다 — 턴이 실패하면 그대로 남아
       * 다음 발화 때 다시 읽힌다(실패한 턴은 없었던 일이 되어야 한다).
       */
      takeEdits(state);
      saveGame(state);
      return { ok: true as const, payload: toPayload(state) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[turn] GM 턴 실패 (game=${id}):`, error);
      return {
        ok: false as const,
        status: 502,
        error: turnErrorMessage(detail),
        detail,
      };
    }
  });
}
