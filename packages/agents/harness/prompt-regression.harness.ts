import { describe, expect, it } from "vitest";
import {
  GM_SYSTEM,
  SKILL_CATALOG,
  buildGmReference,
  buildGmStateNote,
  buildGmTools,
  parseSceneHeader,
  runMockGmTurn,
  sanitizeSceneText,
} from "@story-fm/agents";
import {
  advanceTime,
  createGame,
  interpretBackgroundHeuristic,
  userPlayers,
  type GameState,
} from "@story-fm/engine";
import { PROMPT_REGRESSION } from "../../engine/harness/catalog";
import { outOfBand, reportOf, type Readings } from "../../engine/harness/harness";

/**
 * 프롬프트 회귀 — **문구를 고치면 무엇이 움직였는가**를 LLM 없이 잰다
 * (→ docs/llm/prompts.md §7).
 *
 *   pnpm balance prompt-regression
 *
 * 재는 것은 둘이다: 프롬프트가 **실려 나가는 모양**(층의 글자·프리픽스 안정성)과,
 * 그 위에서 도는 **코어의 파서·위생**(장면 문법·스킬 선택). 둘 다 결정적이라 고정
 * 시드 하나면 재현된다.
 *
 * ⚠️ **모델을 부르지 않는다.** 세션은 모의 GM으로 돌므로 API 키가 필요 없고, 키가
 * 있어도 쓰지 않는다 — `LLM_MODE`를 여기서 직접 못 박는 이유다. 모의 GM의 문장
 * 품질은 프롬프트와 무관하므로(agents.md §8) 그 장면에서 읽는 것은 **실모드와 같은
 * 문법·같은 파서 경로를 지난다**는 사실뿐이다.
 *
 * 판정하지 않는 것도 분명히 해 둔다 — 판정의 일관성, 반문 빈도, 분량 준수는 실호출
 * 없이는 나오지 않는다 (prompts.md §8).
 */

process.env.LLM_MODE = "mock";

const BACKGROUND = "프리미어리그에서 뛰었던 주장 출신 수비수";
const OTHER_BACKGROUND = "K리그에서 뛰다 은퇴한 수비수 출신 분석가";

function build(seed: number, manager: string, background: string): GameState {
  return createGame({
    seed,
    userTeamId: "arsenal",
    managerName: manager,
    background,
    attributes: interpretBackgroundHeuristic(background),
  });
}

/**
 * 고정층 — **매 턴 캐시 프리픽스로 나가는 것 전부.** 시스템 프롬프트와 도구 스펙
 * (설명 + Zod에서 파생된 JSON 스키마)이고, 여기 한 글자라도 세이브마다 달라지면
 * 그 뒤가 통째로 정가로 읽힌다 (models.md §4).
 */
function fixedLayer(state: GameState): string {
  const tools = buildGmTools(state, []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  return `${GM_SYSTEM}\n${JSON.stringify(tools)}`;
}

/** 프리픽스 안정성 — 바이트까지 같으면 1, 아니면 0. 중간값이 없는 질문이다 */
function identical(a: string, b: string): number {
  return a === b ? 1 : 0;
}

/**
 * 감독 발화 코퍼스 — 발화 하나와 **그 발화가 겨냥한 스킬** 하나.
 *
 * 조회 도구는 호출 기록을 남기지 않으므로(prompts.md §2) 상태를 바꾸는 스킬만 겨눈다.
 * 선수 이름은 세계에서 꺼낸다 — 카탈로그가 바뀌어도 코퍼스가 따라온다.
 */
function corpusOf(state: GameState): ReadonlyArray<readonly [string, string]> {
  const who = userPlayers(state)[0]?.name ?? "";
  return [
    ["4-4-2로 바꾸자, 좀 더 공격적으로", "set_tactics"],
    ["훈련은 패스 위주로 화요일 오전에 넣자", "set_training"],
    ["수요일은 훈련 쉬자", "set_training"],
    [`주장은 ${who}으로 가자`, "set_captain"],
    ["다들 모여, 한마디 하겠다", "team_talk"],
    [`${who} 재계약 진행해줘`, "open_renewal"],
    [`${who} 좀 불러줘, 얘기 좀 하자`, "talk_to_player"],
    ["하루 넘어가자", "시간 경과"],
  ] as const;
}

/** 빈 줄을 뺀 줄 수 — 위생이 무엇을 걷었는지는 이 차이로 읽는다 */
function textLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim().length > 0);
}

describe("프롬프트 회귀", () => {
  it("층의 글자·프리픽스 안정성 · 모의 세션의 문법과 스킬 적중률", () => {
    const state = build(7, "김감독", BACKGROUND);
    const other = build(21, "박감독", OTHER_BACKGROUND);

    const fixed = fixedLayer(state);
    const reference = buildGmReference(state);
    const stateNote = buildGmStateNote(state);

    // 레퍼런스층은 **같은 세이브**에서 날짜가 흘러도 같아야 한다 (세계가 다르면
    // 감독이 다르므로 당연히 갈린다 — 그건 안정성이 아니다)
    const later = structuredClone(state);
    advanceTime(later, { days: 30 });

    const corpus = corpusOf(state);
    const session = structuredClone(state);
    let hits = 0;
    let rawLines = 0;
    let keptLines = 0;
    let headers = 0;
    let sceneChars = 0;
    let grammatical = 0;
    const called = new Set<string>();

    for (const [said, want] of corpus) {
      const turn = runMockGmTurn(session, said);
      const names = turn.toolCalls.map((call) => call.name);
      for (const name of names) called.add(name);
      if (names.includes(want)) hits += 1;

      const text = turn.text ?? "";
      sceneChars += text.length;
      const raw = textLines(text);
      const kept = textLines(sanitizeSceneText(text));
      rawLines += raw.length;
      keptLines += kept.length;

      const parsed = parseSceneHeader(text);
      if (parsed.header !== null) headers += 1;
      // 문법 — 헤더를 뗀 본문은 `@` 줄로 연다. 그 뒤의 태그 없는 줄은 직전 화자의
      // 이어쓰기라 세지 않는다 (prompts.md §1)
      if ((textLines(parsed.body)[0] ?? "").startsWith("@")) grammatical += 1;
    }

    const layers = fixed.length + reference.length + stateNote.length;
    const readings: Readings<typeof PROMPT_REGRESSION> = {
      "고정층 글자": fixed.length,
      "시스템 프롬프트 글자": GM_SYSTEM.length,
      "도구 스펙 글자": fixed.length - GM_SYSTEM.length,
      "도구 설명 총 글자": SKILL_CATALOG.reduce((sum, skill) => sum + skill.description.length, 0),
      "가장 긴 도구 설명 글자": Math.max(...SKILL_CATALOG.map((s) => s.description.length)),
      "레퍼런스층 글자": reference.length,
      "매 턴 층 글자": stateNote.length,
      "고정층 비중": fixed.length / layers,
      "고정층 프리픽스 안정성": identical(fixed, fixedLayer(other)),
      "레퍼런스층 프리픽스 안정성": identical(reference, buildGmReference(later)),
      "장면 문법 준수율": grammatical / corpus.length,
      "위생이 걷어낸 줄 비율": (rawLines - keptLines) / Math.max(1, rawLines),
      "시점 헤더 파싱 성공률": headers / corpus.length,
      "평균 장면 글자": sceneChars / corpus.length,
      "스킬 적중률": hits / corpus.length,
      "불린 스킬 가짓수": called.size,
    };

    console.log(
      reportOf(
        PROMPT_REGRESSION,
        readings,
        `도구 ${SKILL_CATALOG.length}개 · 발화 ${corpus.length}건 · 층 합계 ${layers.toLocaleString()}자`,
      ),
    );
    expect(outOfBand(PROMPT_REGRESSION, readings)).toEqual([]);
  });
});
