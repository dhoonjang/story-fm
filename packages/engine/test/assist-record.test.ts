import { describe, expect, it } from "vitest";
import { advanceTime, isFriendly, playersOf, seasonStatOf, type GameState } from "@story-fm/engine";
import { createMiniGame, playMockMatch, playPreseason } from "./helpers";

/**
 * 도움은 **장부에서 결과까지 살아남아야 한다.**
 *
 * 코어는 골의 68%에 도움을 붙이는데(`pickAssister`), 경기가 끝날 때 `MatchResult`가
 * 득점자만 남기던 시절에는 그 사실이 사라졌다 — 시즌 합계 숫자 말고는 누가 도왔는지
 * 어디에도 없어서 "어시스트가 기록되지 않는다"로 보였다.
 */

/**
 * 경기일까지 진행해 한 경기를 끝까지 치른다.
 * 프리시즌 친선을 먼저 흘려보낸다 — 친선은 시즌 기록에 도움을 쌓지 않는다.
 *
 * **축소 세계(8팀·컵 없음)로 돈다.** 도움이 장부에 남는 길은 유저 경기의 구간
 * 시뮬과 AI 경기의 간이 시뮬 둘뿐이고, 둘 다 세계의 크기와 무관하게 같은 함수다.
 * 전체 세계는 같은 것을 보려고 한 시드마다 리그 다섯 개를 굴렸다.
 *
 * 시드마다 **한 번만** 굴리고 나눠 쓴다 — 아래 검증들은 장부를 읽기만 한다.
 */
const played = new Map<number, GameState | null>();

function playOne(seed: number): GameState | null {
  if (played.has(seed)) return played.get(seed) ?? null;
  const state = createMiniGame(seed);
  playPreseason(state);
  let guard = 12;
  while (state.phase !== "matchday" && guard-- > 0) {
    const moved = advanceTime(state, "next_match");
    if (!moved.ok || moved.stopped === "season_end") {
      played.set(seed, null);
      return null;
    }
  }
  if (state.phase !== "matchday") {
    played.set(seed, null);
    return null;
  }
  playMockMatch(state);
  played.set(seed, state);
  return state;
}

describe("도움이 사라지지 않는다", () => {
  it("경기 결과가 득점자와 **같은 길이**의 도움 배열을 갖는다", () => {
    let assisted = 0;
    for (const seed of [3, 7, 11]) {
      const state = playOne(seed);
      if (!state) continue;
      for (const m of state.matches) {
        if (!m.result) continue;
        expect(m.result.assists, `${m.id} 도움 배열이 없다`).toBeDefined();
        expect(m.result.assists!.length, `${m.id} 길이 불일치`).toBe(m.result.scorers.length);
        assisted += m.result.assists!.filter((a) => a !== "").length;
      }
    }
    // 길이만 맞고 전부 빈 칸이면 도움은 여전히 사라진 것이다 — 0이 아님을 못 박는다
    expect(assisted, "도움이 한 건도 붙지 않았다").toBeGreaterThan(0);
  });

  it("시즌 기록에도 도움이 쌓인다", () => {
    for (const seed of [3, 7, 11]) {
      const state = playOne(seed);
      if (!state) continue;
      const ours = new Set(playersOf(state, state.userTeamId).map((p) => p.id));
      // 친선의 도움은 경기에만 남고 시즌 합계에는 안 들어간다 (season.md §2)
      const assisted = state.matches
        .filter((m) => !isFriendly(m))
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
