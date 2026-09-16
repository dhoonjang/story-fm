import type { GameState } from "@story-fm/engine";
import { GM_SYSTEM, buildGmTools } from "@story-fm/agents";

/**
 * GM의 고정층 — **매 턴 캐시 프리픽스의 맨 앞으로 나가는 것 전부** (pipeline.md §2-2 ①).
 *
 * 시스템 프롬프트와 도구 스펙(설명 + Zod에서 파생된 JSON 스키마)이고, 여기 한 글자라도
 * 세이브마다 달라지면 그 뒤가 통째로 정가로 읽힌다 (models.md §4).
 *
 * 하네스 둘이 같은 층을 잰다 — `prompt-regression`은 이 층의 글자와 안정성을,
 * `history-window`는 압축 직후 이 층 뒤에 얼마가 남는가를. 한쪽이 제 조립을 들면 두
 * 하네스가 다른 프리픽스를 재게 되므로 조립은 여기 하나다.
 */
export function gmFixedLayer(state: GameState): string {
  const tools = buildGmTools(state, []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  return `${GM_SYSTEM}\n${JSON.stringify(tools)}`;
}
