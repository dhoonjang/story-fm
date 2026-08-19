import type { GamePayload } from "@/lib/store";
import type { MatchBoardOrder } from "@/lib/match-orders";

/**
 * ── 턴 스트림 — **화면과 서버 사이의 줄 하나** ────────────────────────────
 *
 * `POST /api/games/:id/turn/stream`은 NDJSON을 흘린다: 한 줄이 이벤트 하나다.
 * 줄 모양·이벤트 이름·하트비트·무응답 시한은 **여기와 그 라우트만** 안다.
 * 화면은 글자가 오면 흘리고, 끝나면 앉힐 뿐이다.
 */

/** 서버가 흘려보내는 이벤트 — 모르는 `type`은 조용히 흘려보낸다 */
type TurnStreamEvent = {
  type: string;
  text?: string;
  payload?: GamePayload;
  error?: string;
  detail?: string;
};

/** 턴 하나가 실어 보내는 것 — 감독의 말과, 전술판에서 쌓인 지시 */
export type TurnStreamBody = {
  message: string;
  /** 감독이 친 말이 아니라 손잡이를 누른 것인가 */
  operator: boolean;
  orders?: readonly MatchBoardOrder[];
};

/**
 * 턴이 실패했다 — 이유는 감독에게, 자세한 것은 배너 툴팁에.
 *
 * `settled`는 **서버가 이 턴을 확실히 버렸는가**다. 서버 쪽 턴은 연결이 끊겨도 끝까지
 * 돌아 저장하므로(turn/stream 라우트), 화면이 기다리기를 멈춘 것과 서버가 실패한 것은
 * 서로 다른 사건이다. 참이면 그 턴은 없었던 일이고, 거짓이면 지시가 이미 반영됐을 수
 * 있어 화면이 서버 상태를 다시 받아야 한다 (models.md §1-1).
 */
export type TurnStreamFailure = { reason: string; detail?: string; settled: boolean };

export type TurnStreamHandlers = {
  /** 글자가 왔다 — 화면의 공개 펌프가 받는다 */
  onDelta: (text: string) => void;
  /**
   * 턴이 끝났다. **여기서 화면에 앉히지는 않는다** — 흘러오던 글자가 다 공개된
   * 뒤에 앉아야 중계가 중간에 끊기지 않는다.
   */
  onDone: (payload: GamePayload) => void;
};

/**
 * 아무것도 오지 않은 채로 이만큼 지나면 **기다리기를 그만둔다.**
 *
 * 서버는 도구만 도는 조용한 구간에도 하트비트를 흘리므로(turn/stream 라우트,
 * 10초 간격) 이 시계가 끝까지 도는 것은 **연결이 죽었을 때뿐**이다. 값이 하트비트
 * 간격보다 넉넉해야 느린 네트워크가 멀쩡한 턴을 끊지 않는다. 서버 쪽 턴과 잠금은
 * 모델 호출마다 걸린 시한이 푼다 (docs/llm/models.md §1-1) — 여기서 끊는 것은
 * 화면의 기다림뿐이고, 그 턴은 서버에서 계속 돌아 저장까지 마친다.
 */
const IDLE_TIMEOUT_MS = 60_000;

/**
 * 기다리기를 멈춘 턴 — **"취소"가 아니다.** 서버의 `turnErrorMessage`는 모델 호출이
 * 시한을 넘겨 턴이 실제로 버려졌을 때 쓰는 문구라, 여기서 같은 말을 하면 거짓이 된다.
 */
export const TURN_TIMEOUT_MESSAGE =
  "응답이 늦어 기다리기를 멈췄습니다 — 결과는 곧 화면에 반영됩니다";

/**
 * 턴 하나를 흘려 받는다 — 성공이면 `null`, 아니면 실패 이유. **던지지 않는다.**
 *
 * 도착한 글자는 그때그때 `onDelta`로 나가고, 마지막 payload는 `onDone`으로 간다.
 */
export async function streamTurn(
  gameId: string,
  body: TurnStreamBody,
  handlers: TurnStreamHandlers,
): Promise<TurnStreamFailure | null> {
  const abort = new AbortController();
  let idle: ReturnType<typeof setTimeout> | null = null;
  const stopWatch = () => {
    if (idle) clearTimeout(idle);
    idle = null;
  };
  const armWatch = () => {
    stopWatch();
    idle = setTimeout(() => abort.abort(), IDLE_TIMEOUT_MS);
  };

  try {
    armWatch();
    const res = await fetch(`/api/games/${gameId}/turn/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: body.message,
        operator: body.operator,
        ...(body.orders && body.orders.length > 0 ? { orders: body.orders } : {}),
      }),
      signal: abort.signal,
    });
    if (!res.ok || !res.body) {
      const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      // 라우트가 턴을 돌리기 전에 반려했다 — 저장된 것이 없다
      return {
        reason: data.error ?? "턴을 처리하지 못했습니다",
        detail: data.detail,
        settled: true,
      };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let failure: TurnStreamFailure | null = null;
    let closed = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      // 하트비트도 여기로 온다 — 무엇이 왔는지 가리지 않고 시계를 되감는다
      armWatch();
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let evt: TurnStreamEvent;
        try {
          evt = JSON.parse(line);
        } catch {
          continue; // 불완전한 조각은 건너뛴다 — 다음 줄에서 회복
        }
        if (evt.type === "delta" && evt.text) {
          handlers.onDelta(evt.text);
        } else if (evt.type === "done" && evt.payload) {
          handlers.onDone(evt.payload);
          closed = true;
          /**
           * 답이 다 왔으니 시계를 내린다. 켜 둔 채로 남은 줄을 읽다 시한이 지나면
           * 요청이 끊기고 **이미 끝난 턴 위로 실패 띠가 뜬다.**
           */
          stopWatch();
        } else if (evt.type === "error") {
          // 서버가 스스로 실패를 알렸다 — `runTurnLocked`는 성공할 때만 저장한다
          failure = {
            reason: evt.error ?? "턴을 처리하지 못했습니다",
            detail: evt.detail,
            settled: true,
          };
          closed = true;
          stopWatch();
        }
      }
    }
    /**
     * 스트림이 `done`도 `error`도 없이 끊겼다 — 연결이 잘렸거나 서버가 중간에 죽었다.
     * **저장됐는지는 여기서 알 수 없다**: 라우트는 큐가 닫혀도 턴을 끝까지 돌린다.
     */
    if (!closed)
      return {
        reason: TURN_TIMEOUT_MESSAGE,
        detail: "스트림이 done 없이 끊겼습니다",
        settled: false,
      };
    return failure;
  } catch (e) {
    // 시한을 넘겨 우리가 끊은 것과 연결이 안 된 것은 감독에게 다른 사건이다.
    // 어느 쪽도 서버가 무엇을 했는지 말해 주지 않으므로 `settled`는 거짓이다 —
    // 요청이 닿지 않았을 뿐인 경우까지 여기 섞이지만, 되돌려 두 번 태우는 쪽이
    // 화면을 한 번 더 받아 오는 쪽보다 비싸다.
    return {
      reason: abort.signal.aborted ? TURN_TIMEOUT_MESSAGE : "서버에 연결하지 못했습니다",
      detail: e instanceof Error ? e.message : String(e),
      settled: false,
    };
  } finally {
    stopWatch();
  }
}
