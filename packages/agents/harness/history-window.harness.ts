import { describe, expect, it } from "vitest";
import {
  HISTORY_CHAR_KEEP,
  HISTORY_CHAR_LIMIT,
  HISTORY_STEP,
  applyHistoryDigest,
  createGame,
  historyEnd,
  historyStart,
  interpretBackgroundHeuristic,
  peaceTurns,
  planHistoryFold,
  type GameState,
} from "@story-fm/engine";
import { buildGmHistory } from "@story-fm/agents";
// 최소 캐시 프리픽스 — 눈금의 주인은 계측이다. 여기 숫자를 다시 적으면 둘이 갈린다
import { MIN_CACHEABLE_INPUT } from "@story-fm/llm";
import { HISTORY_WINDOW } from "../../engine/harness/catalog";
import { outOfBand, reportOf, type Readings } from "../../engine/harness/harness";

/**
 * 평시 이력의 창 — **상한과 잔량이 실제 대화에서 몇 턴인가**, 창이 얼마나 자주
 * 미끄러지는가, 압축이 약속한 잔량 안으로 들어오는가 (→ docs/llm/agents.md §5-1).
 *
 *   pnpm balance history-window
 *
 * 이력은 세계를 굴려서는 나오지 않는다 — GM이 쓴 문장이라 LLM 없이는 한 글자도
 * 없다. 그래서 여기서는 **실측한 턴 길이로 이력을 세우고**, 그 위에서 도는 것은
 * 전부 실제 코드다: 창의 시작점도, 압축 판정도, 프롬프트에 실리는 형태도.
 */

/**
 * 평시 턴의 길이 — **실제 세이브의 사이드카 트레이스에서 잰 값이다**
 * (`packages/llm/src/turn-trace.ts`가 남긴 원문).
 *
 * 하네스가 재는 값이 아니라 하네스에 **넣는** 값이다: 상한이 몇 턴인지 알려면
 * 한 턴이 몇 글자인지가 있어야 하고, 그것은 GM이 실제로 쓴 문장에서만 나온다.
 * 모델 턴이 이 폭인 이유는 시스템 프롬프트가 한 장면을 400~800자로 묶기 때문이다.
 */
const MODEL_TURN_CHARS = 412;
const USER_TURN_CHARS = 24;

/**
 * 한국어 산문의 글자↔토큰 — 같은 트레이스에서 원문 글자와 `inputTokens`를 대조해 얻었다.
 *
 * ⚠️ 도구 왕복마다 프롬프트 전체가 다시 세어지므로 **왕복 1회 호출만 골라** 재야 한다.
 * 섞어서 재면 왕복 수만큼 나뉜 값이 나온다.
 */
const CHARS_PER_TOKEN = 1.43;

/** 세계 하나 — 이력의 봉투(`@감독이름: `)를 실제 코드가 붙이려면 감독이 있어야 한다 */
function build(): GameState {
  const background = "K리그에서 뛰다 은퇴한 수비수 출신 분석가";
  return createGame({
    seed: 31,
    userTeamId: "arsenal",
    managerName: "김감독",
    background,
    attributes: interpretBackgroundHeuristic(background),
  });
}

const SENTENCE =
  "라커룸의 공기가 무겁다. 어제의 결과가 아직 가시지 않았고, 누구도 먼저 입을 열지 않는다. ";

/** 길이가 정확히 `chars`인 결정적 한국어 문장 — 분포가 아니라 길이를 재는 자리다 */
function filler(chars: number, i: number): string {
  const head = `${i}. `;
  return (head + SENTENCE.repeat(Math.ceil(chars / SENTENCE.length) + 1)).slice(0, chars);
}

/** 감독 한 마디에 장면 하나가 답한다 — 실측 길이 그대로 */
function pushTurn(state: GameState, i: number): void {
  const model = i % 2 === 1;
  state.chat.push({
    role: model ? "model" : "user",
    text: filler(model ? MODEL_TURN_CHARS : USER_TURN_CHARS, i),
    toolCalls: [],
    at: state.date,
  });
}

/** 창 안의 원문 글자 — 코어가 세는 것과 같은 눈금(`turn.text`)이다 */
function charsFrom(state: GameState, start: number): number {
  const turns = peaceTurns(state.chat);
  const upto = historyEnd(turns);
  return turns.slice(start, upto).reduce((sum, t) => sum + t.text.length, 0);
}

/** 이번 턴 이력이 프롬프트에 실리는 형태 대 원문 — 봉투와 주입된 인물지가 그 차이다 */
function renderRatio(state: GameState): number | null {
  const rendered = buildGmHistory(state);
  if (rendered.length === 0) return null;
  const turns = peaceTurns(state.chat);
  const upto = historyEnd(turns);
  const raw = turns
    .slice(Math.max(0, upto - rendered.length), upto)
    .reduce((sum, t) => sum + t.text.length, 0);
  if (raw === 0) return null;
  return rendered.reduce((sum, m) => sum + m.content.length, 0) / raw;
}

/** 400턴이면 상한(≈164턴)을 지나 두 번째 압축(≈109턴 뒤)까지 본다 */
const TURNS = 400;

describe("평시 이력의 창", () => {
  it("상한·잔량이 실제 턴 길이에서 몇 턴이고, 압축이 잔량 안으로 들어온다", () => {
    const state = build();
    state.chat = [];

    let slid = 0;
    let previousStart = 0;
    let folds = 0;
    /** 압축이 걸린 턴 번호 — 사이 간격이 압축 주기다 */
    const foldAt: number[] = [];
    /** 처음 접히기 직전의 창 — 상한이 몇 턴인가 */
    let windowTurns = 0;
    let keptTurns = 0;
    let keptChars = 0;
    const ratios: number[] = [];

    for (let i = 0; i < TURNS; i += 1) {
      pushTurn(state, i);

      const start = historyStart(state);
      if (start !== previousStart) {
        slid += 1;
        previousStart = start;
      }

      const brief = planHistoryFold(state);
      if (brief) {
        const turns = peaceTurns(state.chat);
        if (folds === 0) windowTurns = historyEnd(turns) - start;

        // 접은 지점은 언제나 6턴 경계다 — 벗어나면 압축 뒤 이력 캐시가 한 번도 적중하지 않는다
        expect(brief.through % HISTORY_STEP, "접은 지점이 STEP 경계를 벗어났다").toBe(0);
        expect(brief.through, "접는 지점이 앞으로 가지 않는다").toBeGreaterThan(brief.from);

        // 같은 상태를 두 번 판정하면 같은 지점 — 결정적이어야 세이브가 재현된다
        expect(planHistoryFold(state)?.through).toBe(brief.through);

        const chatBefore = state.chat.length;
        expect(applyHistoryDigest(state, brief, `${folds + 1}번째 요약.`)).toBe(true);
        expect(state.chat.length, "압축은 state.chat을 줄이지 않는다").toBe(chatBefore);

        folds += 1;
        foldAt.push(i);
        keptTurns = historyEnd(peaceTurns(state.chat)) - historyStart(state);
        keptChars = charsFrom(state, historyStart(state));
        previousStart = historyStart(state);
      }

      const ratio = renderRatio(state);
      if (ratio !== null) ratios.push(ratio);
    }

    expect(folds, "400턴을 밀어도 한 번도 접히지 않으면 상한이 창 밖에 있다").toBeGreaterThan(1);

    const cycles = foldAt.slice(1).map((at, k) => at - foldAt[k]!);
    const readings: Readings<typeof HISTORY_WINDOW> = {
      "이력 창 (턴)": windowTurns,
      "압축 뒤 이력 (턴)": keptTurns,
      "압축 주기 (턴)": cycles.reduce((a, b) => a + b, 0) / Math.max(1, cycles.length),
      "압축 뒤 이력 글자": keptChars,
      "창이 미끄러진 턴 비율": slid / TURNS,
      "렌더 배율": ratios.reduce((a, b) => a + b, 0) / Math.max(1, ratios.length),
      "잔량의 최소 캐시 프리픽스 배수": HISTORY_CHAR_KEEP / CHARS_PER_TOKEN / MIN_CACHEABLE_INPUT,
    };

    console.log(
      reportOf(
        HISTORY_WINDOW,
        readings,
        `상한 ${HISTORY_CHAR_LIMIT}자 · 잔량 ${HISTORY_CHAR_KEEP}자 · ${TURNS}턴 · 압축 ${folds}회`,
      ),
    );
    expect(outOfBand(HISTORY_WINDOW, readings)).toEqual([]);
  });
});
