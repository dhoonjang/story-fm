/**
 * 전술판 자동 저장의 **대기열** — 판과 채팅이 같은 순서를 공유하게 한다.
 *
 * 전술판 조작은 곧바로 서버로 가지 않는다(연속 조작을 한 요청으로 묶는다). 그런데
 * 턴 전송은 다른 경로라, 저장이 예약된 채로 턴이 나가면 서버는 **옛 배치·옛 전술**로
 * GM 입력을 만든다 — 화면에는 내가 바꾼 판이 그대로 보이는데 수석코치만 다른 전술을
 * 말하는 일이 그래서 생겼다.
 *
 * 그래서 예약·진행 중인 저장을 판이 아니라 **화면(GameScreen)이 쥔다**: 턴을 보내기
 * 전에 `flush()`로 대기열을 비우고 그 결과를 기다린다. 판이 접혀 언마운트돼도 예약이
 * 사라지지 않는 것은 덤이다.
 */

/**
 * 조작이 멈춘 뒤 이만큼 지나면 저장한다 — 연속 드래그·눈금 연타·역할 선택을 한 번으로
 * 묶는다. **판을 짜는 일은 한 번의 조작으로 끝나지 않는다**: 자리를 옮기고 역할을 고르고
 * 벤치를 바꾸는 것이 하나의 결정이라, 창을 짧게 잡으면 그 결정이 요청 여러 개로 쪼개지고
 * 전술 축 변경은 쪼갠 만큼 적응도 대가를 더 문다(`setTactics`는 부른 만큼 값을 매긴다).
 * 저장을 놓칠 걱정은 없다 — 턴을 보내기 전에 대기열이 먼저 비워진다.
 */
export const AUTOSAVE_MS = 3000;

/**
 * 한 번의 저장 시도 결과.
 * `keep`이면 그 편집은 대기열에 남는다 — 감독이 판에서 고쳐야 보낼 수 있는 배치다.
 */
export type LineupSaveOutcome = { ok: true } | { ok: false; error: string; keep?: boolean };

/** 대기열에 넣는 저장 한 건 — 실제 요청은 이 함수가 보낸다 */
export type LineupSave = () => Promise<LineupSaveOutcome>;

export interface LineupSaver {
  /** 편집 하나를 예약한다 — 조작이 멎으면 나간다 (앞선 예약은 최신 것으로 덮인다) */
  schedule(save: LineupSave): void;
  /**
   * 대기열을 지금 비우고 끝날 때까지 기다린다 — 마지막 저장 결과를 준다.
   * 보낼 것도 날고 있는 것도 없으면 `null`.
   */
  flush(): Promise<LineupSaveOutcome | null>;
  /** 아직 서버에 닿지 않은 편집이 있나 */
  dirty(): boolean;
}

export function createLineupSaver(delayMs: number = AUTOSAVE_MS): LineupSaver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: LineupSave | null = null;
  let inFlight: Promise<LineupSaveOutcome> | null = null;
  /** 지금 날고 있는 저장의 번호 — 뒤에 다른 저장이 떴으면 내 응답으로 자리를 비우지 않는다 */
  let seq = 0;

  const run = (save: LineupSave): Promise<LineupSaveOutcome> => {
    const mine = ++seq;
    const tracked = save()
      .catch((e): LineupSaveOutcome => ({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }))
      .then((outcome) => {
        if (mine === seq) inFlight = null;
        // 보낼 수 없는 배치는 대기열에 남는다 — 다음 flush가 다시 부딪히고, 그 턴이 막힌다
        if (!outcome.ok && outcome.keep === true && pending === null) pending = save;
        return outcome;
      });
    inFlight = tracked;
    return tracked;
  };

  return {
    schedule(save) {
      pending = save;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const next = pending;
        pending = null;
        if (next) void run(next);
      }, delayMs);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      let last: LineupSaveOutcome | null = null;
      // 먼저 날고 있는 저장부터 — 두 요청이 겹치면 나중 것이 먼저 닿을 수 있다
      while (inFlight) last = await inFlight;
      const next = pending;
      pending = null;
      if (next) last = await run(next);
      return last;
    },
    dirty() {
      return timer !== null || pending !== null || inFlight !== null;
    },
  };
}
