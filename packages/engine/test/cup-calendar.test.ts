import { describe, expect, it } from "vitest";
import {
  domesticCupCatalog,
  advanceTime,
  allMatchesDone,
  domesticChampion,
  domesticStageMatches,
  finalWeekdays,
  stageTarget,
  type GameState,
} from "@story-fm/engine";
import { createTestGame, keepSeat, playMockMatch } from "./helpers";

/**
 * 컵 달력이 **시즌을 넘겨도** 성립하는가.
 *
 * 카탈로그의 대회 날짜는 고정 월·일이라 해가 바뀌면 요일이 밀린다. 시즌 1만 보면
 * 드러나지 않는 종류의 사고라 여기서는 여러 시즌을 본다.
 */

const dayOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

describe("결승 목표일은 그 시즌의 요일에 맞는다", () => {
  it("어느 시즌에도 대회가 허용한 요일에 앉는다", () => {
    for (let season = 1; season <= 8; season++) {
      for (const cup of domesticCupCatalog()) {
        const target = stageTarget(season, cup, "final");
        expect(finalWeekdays(cup), `${cup.id} S${season} 목표 ${target}`).toContain(dayOf(target));
      }
    }
  });

  it("옮기더라도 사흘 안이다 — 대회 골격은 그대로다", () => {
    for (let season = 1; season <= 8; season++) {
      for (const cup of domesticCupCatalog()) {
        const [month, day] = cup.windows.final;
        const target = stageTarget(season, cup, "final");
        const raw = Date.UTC(Number(target.slice(0, 4)), month - 1, day);
        const moved = Math.abs(Date.parse(`${target}T00:00:00Z`) - raw) / 86_400_000;
        expect(moved, `${cup.id} S${season} → ${target}`).toBeLessThanOrEqual(3);
      }
    }
  });
});

describe("두 시즌을 이어 돌려도 컵이 끝난다", () => {
  /**
   * 시즌 1만 보면 안 드러난다 — 2027년엔 쿠프 결승 5/22가 토요일이라 제자리에
   * 앉았지만, 2028년엔 월요일이라 앞으로만 훑다가 리그 최종 라운드와 대항전 결승을
   * 지나 **6월로 넘어갔다**. 그 자리는 시즌 종료 판정 밖이라 결승이 통째로 사라졌다.
   */
  const state = createTestGame(7);
  const run = (s: GameState) => {
    let guard = 420;
    while (guard-- > 0 && !allMatchesDone(s)) {
      const before = s.date;
      keepSeat(s);
      const a = advanceTime(s, { days: 1 });
      if (s.phase === "matchday") playMockMatch(s);
      if (s.date === before && a.stopped !== "matchday") return;
    }
  };
  run(state);
  // 시즌 2로 넘어간 뒤 다시 끝까지
  let guard = 500;
  while (guard-- > 0 && state.season === 1) {
    keepSeat(state);
    const before = state.date;
    const a = advanceTime(state, { days: 1 });
    if (state.phase === "matchday") playMockMatch(state);
    if (state.date === before && a.stopped !== "matchday") break;
  }
  run(state);

  it("두 번째 시즌도 남는 경기 없이 끝난다", () => {
    expect(state.season).toBe(2);
    const left = state.matches.filter((m) => m.season === state.season && m.result === null);
    expect(
      left.map((m) => `${m.competitionId}/${m.stage}@${m.date}`),
      `${state.date}에 미소화가 남았다`,
    ).toEqual([]);
  });

  it("여섯 국내 컵이 모두 우승 팀을 낸다 — 나라를 가리지 않는다", () => {
    // 우리 나라 컵만 기다리면 쿠프·포칼 결승이 안 치러진 채 시즌이 넘어가고,
    // 그 나라 유럽 티켓 한 장이 순위만으로 나간다
    for (const cup of domesticCupCatalog()) {
      expect(domesticChampion(state, cup.id), `${cup.id} 우승 팀 없음`).toBeTruthy();
    }
  });

  it("결승은 두 번째 시즌에도 규정 요일에 선다", () => {
    for (const cup of domesticCupCatalog()) {
      const final = domesticStageMatches(state, cup.id, "final")[0];
      expect(final, `${cup.id} 결승 없음`).toBeTruthy();
      expect(finalWeekdays(cup), `${cup.id} 결승 ${final!.date}`).toContain(dayOf(final!.date));
    }
  });
});
