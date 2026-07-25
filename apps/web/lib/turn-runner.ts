import { loadGame, saveGame, type GameState } from "@story-fm/engine";
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
  | { ok: false; status: number; error: string };

/**
 * 유저 턴 → GM 실행 → 모델 턴 (ai-manager §2), 잠금·원자성 포함.
 * onDelta를 주면 GM 서사 텍스트를 스트리밍으로 흘려보낸다.
 *
 * 원자성 — GM 턴이 중간에 실패하면 부분 실행된 도구 효과를 버리고 턴 시작
 * 시점으로 복원한다 (리뷰 발견: 부분 커밋 + 재시도 유도 → 중복 실행).
 */
export function runTurnLocked(
  id: string,
  message: string,
  onDelta?: (text: string) => void,
): Promise<TurnOutcome> {
  return withGameLock(id, async () => {
    const state = loadGame(id);
    if (!state) return { ok: false as const, status: 404, error: "게임을 찾을 수 없습니다" };

    const backup: GameState = structuredClone(state);
    state.chat.push({ role: "user", text: message, toolCalls: [], at: state.date });
    try {
      const turn = await runGmTurn(state, message, onDelta);
      state.chat.push({ role: "model", text: turn.text, toolCalls: turn.toolCalls, at: state.date });
      saveGame(state);
      return { ok: true as const, payload: toPayload(state) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      backup.chat.push({ role: "user", text: message, toolCalls: [], at: backup.date });
      backup.chat.push({
        role: "model",
        text: `@수석코치: 죄송합니다, 방금 지시는 처리하지 못했습니다 — 아무것도 반영되지 않았으니 다시 말씀해 주십시오. (${detail})`,
        toolCalls: [],
        at: backup.date,
      });
      saveGame(backup);
      return { ok: true as const, payload: toPayload(backup) };
    }
  });
}
