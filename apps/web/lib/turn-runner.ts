import { loadGame, saveGame } from "@story-fm/engine";
import { runGmTurn } from "@story-fm/agents";
import { toPayload, type GamePayload } from "./store";

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
 */
function turnErrorMessage(detail: string): string {
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
 * 유저 턴 → GM 실행 → 모델 턴 (ai-manager §2), 잠금·원자성 포함.
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
): Promise<TurnOutcome> {
  return withGameLock(id, async () => {
    const state = loadGame(id);
    if (!state) return { ok: false as const, status: 404, error: "게임을 찾을 수 없습니다" };

    state.chat.push({ role: "user", text: message, toolCalls: [], at: state.date });
    try {
      const turn = await runGmTurn(state, message, onDelta);
      state.chat.push({ role: "model", text: turn.text, toolCalls: turn.toolCalls, at: state.date });
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
