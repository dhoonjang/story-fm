import {
  acquireSaveLock,
  loadGame,
  refreshPacket,
  saveGame,
  setPlayerTactic,
  setSetPieceTakers,
  setTactics,
  substitutePlayer,
  takeEdits,
  type GameState,
  type SaveLockHandle,
} from "@story-fm/engine";
import {
  GmTurnFailure,
  compactHistory,
  operationLabel,
  runGmTurn,
  type TurnOperation,
} from "@story-fm/agents";
import {
  beginGameUsage,
  bindTurnTrace,
  llmErrorKind,
  traceEnabled,
  traceTurn,
  type LlmErrorKind,
} from "@story-fm/llm";
import { NextResponse } from "next/server";
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
    case "setPiece":
      return setSetPieceTakers(state, { [order.role]: order.playerId });
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
 * ── 게임 잠금 ─────────────────────────────────────────────────────────────
 *
 * 같은 게임의 동시 요청(턴·전술판 저장·`settled=1` 재조회)이 서로의 저장을 덮지
 * 않게 **읽고 → 고치고 → 쓰는 구간 전체**를 하나로 묶는다. 두 겹이다:
 *
 * 1. **프로세스 안 뮤텍스** — 여기 도착한 요청을 도착 순서대로 줄 세운다.
 * 2. **세이브 파일 락** — `<id>.lock` (`@story-fm/engine`의 `acquireSaveLock`).
 *    `next start` 인스턴스가 둘이면 1번은 서로를 모른다.
 *
 * **기다림에는 상한이 있고, 잠금은 시간으로 풀리지 않는다.** 상한을 넘긴 요청은
 * 잠금을 빼앗는 대신 `GameBusyError`로 물러난다 — 아무것도 쓰지 않으므로 같은
 * 세이브에 쓰는 손은 여전히 하나다 (docs/llm/models.md §1-1).
 */

/**
 * 잠금을 기다리는 상한 — **부르는 자리마다 다르다.** 그 값의 근거는 models.md §1-1.
 */
export const LOCK_WAIT_MS = {
  /** 턴 — 도는 턴 뒤에 줄을 서 봐야 화면의 유휴 시계(60초)가 먼저 끊는다 */
  turn: 3_000,
  /** 전술판 저장 — 감독이 손을 놓고 기다리는 자리다. 물러나도 편집은 대기열에 남는다 */
  lineup: 3_000,
  /** `settled=1` 재조회 — 도는 턴이 커밋하기를 기다리는 것이 목적이라 넉넉하다 */
  settled: 30_000,
} as const;

/** 상한 안에 잠금을 얻지 못했다 — 라우트는 이걸 409로 옮긴다 */
export class GameBusyError extends Error {
  constructor(readonly gameId: string) {
    // 서버는 **사실만** 낸다 — "다시 시도하라"는 말은 화면의 `다시 시도`가 이미 하고
    // 있고, 다시 보내도 되는지는 응답의 `retry`가 데이터로 말한다
    super("턴이 진행 중입니다");
    this.name = "GameBusyError";
  }
}

/** 잠금을 놓는 함수 — 몇 번 불러도 한 번만 듣는다 */
type Release = () => void;

/** 줄 서 있는 요청 하나 — 상한이 먼저 오면 `timer`가 자기를 줄에서 빼낸다 */
interface Waiter {
  grant: (release: Release) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 잠긴 게임 → 그 뒤에 선 줄. **키가 있으면 잠긴 것이다** — 줄이 비어 있어도 키는
 * 남아 있고, 놓는 쪽이 지운다.
 */
const queues = new Map<string, Waiter[]>();

/** 소유권을 넘기는 함수 — 줄의 다음 사람에게 그대로 건네므로 그 사이가 없다 */
function releaseLocal(id: string): Release {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const queue = queues.get(id);
    if (!queue) return;
    const next = queue.shift();
    if (!next) {
      queues.delete(id);
      return;
    }
    clearTimeout(next.timer);
    next.grant(releaseLocal(id));
  };
}

/** 프로세스 안 뮤텍스 — 상한 안에 얻으면 놓는 함수, 못 얻으면 null */
function acquireLocal(id: string, waitMs: number): Promise<Release | null> {
  const queue = queues.get(id);
  if (!queue) {
    queues.set(id, []);
    return Promise.resolve(releaseLocal(id));
  }
  return new Promise<Release | null>((resolve) => {
    const waiter: Waiter = {
      grant: resolve,
      timer: setTimeout(() => {
        const line = queues.get(id);
        const at = line?.indexOf(waiter) ?? -1;
        if (line && at >= 0) line.splice(at, 1);
        resolve(null);
      }, waitMs),
    };
    queue.push(waiter);
  });
}

/**
 * 잠금을 쥐고 `fn`을 돌린다. 상한 안에 못 얻으면 `GameBusyError`를 던진다.
 *
 * 두 겹은 **하나의 상한**을 나눠 쓴다 — 뮤텍스에서 쓴 시간은 파일 락이 기다릴 수
 * 있는 시간에서 빠진다. 그래야 부르는 쪽이 적은 값이 실제 최대 대기가 된다.
 */
export async function withGameLock<T>(
  id: string,
  waitMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + waitMs;
  const local = await acquireLocal(id, waitMs);
  if (!local) throw new GameBusyError(id);
  let file: SaveLockHandle | null;
  try {
    file = await acquireSaveLock(id, deadline - Date.now());
  } catch (error) {
    local();
    throw error;
  }
  if (!file) {
    local();
    throw new GameBusyError(id);
  }
  try {
    return await fn();
  } finally {
    file.release();
    local();
  }
}

/**
 * 잠금을 못 얻은 요청의 응답 — **409 + `retry`.** 그 밖의 실패는 그대로 올려보낸다.
 *
 * `retry`는 화면에게 "이 요청은 다시 보내면 통한다"는 뜻이다: 전술판은 편집을 대기열에
 * 남기고, `settled=1` 재조회는 몇 번 더 물어본다. 화면이 상태 코드를 냄새로 읽지 않게
 * 사실을 응답에 적는다.
 */
export function busyResponse(error: unknown): Response {
  if (!(error instanceof GameBusyError)) throw error;
  return NextResponse.json({ error: error.message, retry: true }, { status: 409 });
}

export type TurnOutcome =
  | { ok: true; payload: GamePayload }
  | { ok: false; status: number; error: string; detail?: string };

/**
 * LLM 실패를 감독에게 보일 한 줄로 — **게임 밖의 사건**이므로 픽션 밖 말투로.
 * 다시 걸어 보라는 말은 배너의 `다시 시도` 버튼이 이미 하고 있다.
 * 새 게임 첫 장면(`/api/games`)도 같은 문구를 쓴다 — 폴백 장면은 없다.
 *
 * **고르는 근거는 `kind` 하나다** (models.md §1-1). 오류 문자열에서 낱말을 찾던
 * 예전 분류는 제공자가 메시지 문안을 손보는 날 조용히 무너졌고, 그 낱말을 지키느라
 * 오류 문구까지 코드의 제약이 됐다.
 */
const TURN_ERROR_MESSAGE: Record<LlmErrorKind, string> = {
  overloaded: "모델 서버가 혼잡합니다",
  rate_limit: "요청 한도를 넘었습니다",
  timeout: "응답이 지연돼 턴을 취소했습니다",
  auth: "LLM 인증 정보가 올바르지 않습니다",
  filtered: "모델이 이 요청을 거절했습니다",
  budget: "이 게임의 토큰 예산 상한에 닿았습니다",
  unknown: "응답을 받지 못해 지시를 반영하지 못했습니다",
};

export function turnErrorMessage(kind: LlmErrorKind): string {
  return TURN_ERROR_MESSAGE[kind];
}

/**
 * 원인 문자열을 응답에 실을지 — **개발 모드에서만 싣는다** (models.md §1-1).
 *
 * 내부 예외 원문에는 프롬프트 조각·모델 ID·경로가 섞여 나온다. 프로덕션에서는
 * 서버 로그에만 남고, 화면이 받는 것은 `error` 한 줄뿐이다.
 */
export function errorDetail(error: unknown): { detail?: string } {
  if (!traceEnabled()) return {};
  return { detail: error instanceof Error ? error.message : String(error) };
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
 * 화자(수석코치 등)가 알 수 없다 — 수석코치가 오류 문자열을 읊는 순간 세계의
 * 경계가 무너진다. 유저 발화도
 * 기록하지 않는다: 턴 자체가 없었던 일이 되어야 다시 보내도 중복이 없다.
 */
export function runTurnLocked(
  id: string,
  /** 감독이 친 말 — 조작 턴에는 없다 (`operation`이 문장을 만든다) */
  message: string | undefined,
  onDelta?: (text: string) => void,
  /**
   * 감독의 발화가 아니라 **화면 조작**인가 (시간 이동·경기 진행 손잡이).
   * 채팅에 그리지 않고, 모델 이력에도 오퍼레이터 지시로 들어간다.
   *
   * **구조체로 온다.** 모델이 읽을 `<operator>…</operator>` 문장은 여기서 만들므로
   * (`operationLabel`) 화면의 문구가 계약이 아니다 — 되읽는 코드가 없다.
   */
  operation?: TurnOperation,
  /**
   * 전술판에서 쌓인 조작 — 감독의 말보다 **먼저** 들어간다.
   *
   * 조작할 때마다 턴을 태우지 않는 이유는 중계 중에도 판을 만질 수 있어야 하기
   * 때문이다(모델이 응답 중엔 턴을 보낼 수 없다). 대신 다음으로 말을 건네거나
   * 경기를 진행할 때 한 묶음으로 전달된다 — 그래서 **한 번의 LLM 호출**로 끝난다.
   */
  orders?: readonly MatchBoardOrder[],
): Promise<TurnOutcome> {
  // 이 턴에 오간 원문은 model 턴을 채팅에 밀어 넣는 자리에서 그 인덱스에 묶인다
  return withGameLock(id, LOCK_WAIT_MS.turn, () =>
    traceTurn(async (): Promise<TurnOutcome> => {
      // 토큰 예산의 단위는 게임이다 — 다른 게임의 턴이면 여기서 장부를 비운다
      // (models.md §4). 잠금 안이라 한 프로세스에서 두 게임이 겹치지 않는다.
      beginGameUsage(id);
      const state = loadGame(id);
      if (!state) return { ok: false as const, status: 404, error: "게임을 찾을 수 없습니다" };

      /**
       * 경기 턴인가 — **턴을 시작할 때** 본다. 이 턴에서 경기가 끝나더라도 감독이
       * 말을 건 상대는 중계였으므로 그 턴은 경기 이력에 속하고, 반대로 이 턴에
       * `start_match`로 경기가 열렸어도 화자는 아직 평시 GM이라 평시 이력에 남는다
       * (agents.md §5) — 중계는 그다음 턴(킥오프)부터다.
       */
      const inMatch = state.phase === "match";
      const matchId = state.pendingMatch?.matchId;
      const mark = inMatch ? { inMatch: true as const, ...(matchId ? { matchId } : {}) } : {};
      // 판에서 쌓인 조작은 LLM이 다시 해석하지 않는다. 구조화된 ID·값을 코어 명령로
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
      /**
       * 모델이 읽을 한 줄 — 조작이면 **구조체에서 만든다.** 감독이 친 말이 아니라
       * 손잡이라, 이 문장은 표시일 뿐이고 되읽는 코드가 없다 (agents.md §2).
       */
      const said = operation ? operationLabel(operation) : (message ?? "");
      state.chat.push({
        role: operation ? "operator" : "user",
        text: said,
        toolCalls: [],
        at: state.date,
        ...mark,
      });
      try {
        const turn = await runGmTurn(state, said, onDelta, operation, appliedOrders);
        state.chat.push({
          role: "model",
          text: turn.text,
          toolCalls: turn.toolCalls,
          at: state.date,
          ...(turn.goals && turn.goals.length > 0 ? { goals: turn.goals } : {}),
          ...(turn.cards && turn.cards.length > 0 ? { cards: turn.cards } : {}),
          ...(turn.reports && turn.reports.length > 0 ? { reports: turn.reports } : {}),
          ...(turn.missions && turn.missions.length > 0 ? { missions: turn.missions } : {}),
          // 유저 턴과 같은 표식 — 한 턴의 두 줄이 서로 다른 이력으로 갈리면 안 된다
          ...mark,
        });
        bindTurnTrace(id, state.chat.length - 1);
        /**
         * 화면 조작 기록은 **읽힌 뒤에** 비운다 — 턴이 실패하면 그대로 남아
         * 다음 발화 때 다시 읽힌다(실패한 턴은 없었던 일이 되어야 한다).
         */
        takeEdits(state);
        /**
         * 이력 압축은 **저장 직전**이다 — 모델 턴이 채팅에 들어간 뒤라야 판정이
         * 이번 턴을 포함하고, 저장 전이라 접힌 지점과 요약이 같은 세이브에 함께
         * 굳는다 (agents.md §5-1). 실패는 삼킨다: 접지 않은 이력이 그대로 남을
         * 뿐 이번 턴은 성공으로 끝난다.
         */
        await compactHistory(state).catch((error: unknown) => {
          console.warn(`[turn] 이력 압축을 건너뜁니다 (game=${id}):`, error);
        });
        saveGame(state);
        return { ok: true as const, payload: toPayload(state) };
      } catch (error) {
        const kind = llmErrorKind(error);
        console.error(`[turn] GM 턴 실패 (game=${id}, kind=${kind}):`, error);
        return {
          ok: false as const,
          status: 502,
          /**
           * `GmTurnFailure`는 감독에게 보일 문구를 이미 들고 온다 — 원인을 짐작해
           * 바꿔 쓰면 "지시를 옮기지 못했다"가 "응답을 받지 못했다"로 둔갑한다.
           */
          error: error instanceof GmTurnFailure ? error.message : turnErrorMessage(kind),
          ...errorDetail(error),
        };
      }
    }),
  ).catch((error: unknown) => {
    /**
     * 이미 도는 턴이 있다 — **줄을 서지 않는다.** 화면의 유휴 시계(60초)가 그 턴보다
     * 먼저 끝나므로 기다려 봐야 감독은 답을 못 본다. 이 턴은 없었던 일이 되고
     * (`runTurnLocked`는 성공할 때만 저장한다) 전술판 지시는 대기열로 돌아간다.
     */
    if (error instanceof GameBusyError)
      return { ok: false as const, status: 409, error: error.message };
    throw error;
  });
}
