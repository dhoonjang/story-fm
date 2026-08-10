import { describe, expect, it } from "vitest";
import { advanceTime, playersOf, seasonStatOf, type GameState } from "@story-fm/engine";
import { createTestGame, playMockMatch } from "./helpers";

/**
 * 도움은 **장부에서 결과까지 살아남아야 한다.**
 *
 * 코어는 골의 68%에 도움을 붙이는데(`pickAssister`), 경기가 끝날 때 `MatchResult`가
 * 득점자만 남기던 시절에는 그 사실이 사라졌다 — 시즌 합계 숫자 말고는 누가 도왔는지
 * 어디에도 없어서 "어시스트가 기록되지 않는다"로 보였다.
 */

/** 경기일까지 진행해 한 경기를 끝까지 치른다 */
function playOne(seed: number): GameState | null {
  const state = createTestGame(seed);
  let guard = 12;
  while (state.phase !== "matchday" && guard-- > 0) {
    const moved = advanceTime(state, "next_match");
    if (!moved.ok || moved.stopped === "season_end") return null;
  }
  if (state.phase !== "matchday") return null;
  playMockMatch(state);
  return state;
}

describe("도움이 사라지지 않는다", () => {
  it("경기 결과가 득점자와 **같은 길이**의 도움 배열을 갖는다", () => {
    for (const seed of [3, 7, 11]) {
      const state = playOne(seed);
      if (!state) continue;
      for (const m of state.matches) {
        if (!m.result) continue;
        expect(m.result.assists, `${m.id} 도움 배열이 없다`).toBeDefined();
        expect(m.result.assists!.length, `${m.id} 길이 불일치`).toBe(m.result.scorers.length);
      }
    }
  });

  it("여러 경기를 치르면 도움이 실제로 붙는다 — 전부 빈 칸일 수 없다", () => {
    let goals = 0;
    let assisted = 0;
    for (const seed of [1, 2, 3, 5, 7, 11]) {
      const state = playOne(seed);
      if (!state) continue;
      for (const m of state.matches) {
        if (!m.result) continue;
        goals += m.result.scorers.length;
        assisted += (m.result.assists ?? []).filter((a) => a !== "").length;
        expect(m.result.assists!.length, `${m.id} 길이`).toBe(m.result.scorers.length);
      }
    }
    expect(goals, "골이 하나도 없으면 시험이 성립하지 않는다").toBeGreaterThan(5);
    // 설계값 68% — 표본이 작으니 넉넉히 잡되 0은 아니어야 한다
    expect(assisted / goals).toBeGreaterThan(0.35);
  });

  it("시즌 기록에도 도움이 쌓인다", () => {
    for (const seed of [3, 7, 11]) {
      const state = playOne(seed);
      if (!state) continue;
      const ours = new Set(playersOf(state, state.userTeamId).map((p) => p.id));
      const assisted = state.matches
        .flatMap((m) => m.result?.assists ?? [])
        .filter((a) => a !== "")
        .map((a) => (a.includes(":") ? a.split(":", 2)[1]! : a))
        .filter((id) => ours.has(id))
        .filter((id, i, all) => all.indexOf(id) === i);
      for (const id of assisted) {
        expect(seasonStatOf(state, id)?.assists ?? 0, `${id} 시즌 도움`).toBeGreaterThan(0);
      }
    }
  });
});
