import {
  awaitingShootout,
  advanceShootout,
  buildMatchView,
  commitCheckpoint,
  loadGame,
  resumeLiveInterval,
  saveGame,
  syncLiveTactics,
  type GameState,
} from "@story-fm/engine";
import { traceBoard } from "@story-fm/llm";
import { applyMatchBoardOrder, LOCK_WAIT_MS, withGameLock } from "./turn-runner";
import type { LiveAction, LiveSnapshot } from "./live-match-protocol";
import { toPayload } from "./store";

/**
 * 실시간 경기의 서버 쪽 — **체크포인트 검증과 확정** (live-match.md §8.1·§8.4).
 *
 * 서버는 상주 루프도 프레임 전송도 하지 않는다. 클라이언트가 굴린 구간을 같은 함수로
 * 다시 굴려 digest를 견주고(`commitCheckpoint`), 확정된 tick에 감독의 입력을 앉힌다.
 * 정지점의 판독과 중계는 턴(`match_stop`)의 몫이다. 세이브에 남는 것은 서버가 굴린 상태뿐이다.
 */

/**
 * 응답을 잃고 다시 보낸 조작을 가르는 표 — 게임마다 최근 명령 id. 프로세스 메모리다:
 * 세이브에 남길 사실이 아니라 한 연결의 되풀이를 막는 표일 뿐이다.
 */
const appliedCommands = new Map<string, string[]>();
const COMMANDS_KEPT = 64;

function snapshotOf(state: GameState): LiveSnapshot {
  const pending = state.pendingMatch;
  if (!pending || state.phase !== "match") throw new Error("진행 중인 경기가 없습니다");
  return {
    live: pending.live,
    view: buildMatchView(state),
    awaitingShootout: awaitingShootout(state),
  };
}

/** 확정 상태를 읽는다 — 화면이 이어받는 출발점 */
export async function readLiveMatch(id: string): Promise<LiveSnapshot> {
  return withGameLock(id, LOCK_WAIT_MS.turn, async () => {
    const state = loadGame(id);
    if (!state) throw new Error("게임을 찾을 수 없습니다");
    return snapshotOf(state);
  });
}

/** 클라이언트의 요청 하나를 확정 상태에 적용한다 — 잠금 안에서 읽고 고치고 쓴다 */
export async function handleLiveAction(id: string, action: LiveAction): Promise<LiveSnapshot> {
  return withGameLock(id, LOCK_WAIT_MS.turn, () =>
    traceBoard(id, async () => {
      const state = loadGame(id);
      if (!state) throw new Error("게임을 찾을 수 없습니다");
      if (!state.pendingMatch || state.phase !== "match")
        throw new Error("진행 중인 경기가 없습니다");
      switch (action.kind) {
        case "checkpoint": {
          const verdict = commitCheckpoint(state, action.checkpoint);
          const { events, ...rest } = verdict;
          // 판독과 중계는 정지점 턴의 몫이다 — 실행기가 곧이어 `match_stop` 턴을 연다
          saveGame(state);
          return { ...snapshotOf(state), verdict: rest, events };
        }
        case "orders": {
          const seen = appliedCommands.get(id) ?? [];
          if (!seen.includes(action.commandId)) {
            for (const order of action.orders) {
              const result = applyMatchBoardOrder(state, order);
              if (!result.ok) throw new Error(result.message);
            }
            // 바뀐 판을 실시간 경기의 우리 편에 싣는다 — 확정 tick에 적용된다
            syncLiveTactics(state);
            appliedCommands.set(id, [...seen, action.commandId].slice(-COMMANDS_KEPT));
            saveGame(state);
          }
          return { ...snapshotOf(state), slice: toPayload(state, ["squad", "match"]) };
        }
        case "resume": {
          resumeLiveInterval(state);
          saveGame(state);
          return snapshotOf(state);
        }
        case "shootout": {
          const kicked = advanceShootout(state);
          if (!kicked.ok) throw new Error(kicked.message);
          saveGame(state);
          return { ...snapshotOf(state), shootout: { message: kicked.message, done: kicked.done } };
        }
      }
    }),
  );
}
