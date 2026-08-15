import { describe, expect, it } from "vitest";
import { mergeSlice } from "../lib/game-slice";
import type { GamePayload, GameSlice } from "../lib/store";

/**
 * 조각 응답의 병합 — issue #17. 전술판은 조작이 멎을 때마다 저장하므로 이 병합이
 * 3초마다 돈다. 바뀐 뷰만 갈아끼우고 나머지는 **화면이 쥔 것 그대로** 남아야 한다.
 */

/** 뷰의 정체를 표식 하나로만 가른다 — 이 테스트가 보는 건 어느 뷰가 살아남는가다 */
const payload = (mark: string) =>
  ({
    id: "g1",
    date: "2025-08-15",
    timeOfDay: "오후",
    season: 1,
    phase: "normal",
    teamName: "아스널",
    managerName: "감독",
    chat: [{ role: "model", text: "안녕", toolCalls: [], at: "2025-08-15" }],
    views: {
      match: null,
      squad: { formation: `4-4-2 ${mark}` },
      calendar: { today: mark },
      competitions: { list: [mark] },
      finance: { mark },
      career: { mark },
    },
    playerNames: {},
    speakerRoles: {},
    matchLogs: {},
  }) as unknown as GamePayload;

const squadSlice = (mark: string, chatLength: number): GameSlice => ({
  id: "g1",
  views: { squad: { formation: `4-2-3-1 ${mark}` } } as GameSlice["views"],
  chatLength,
});

describe("조각 응답 병합", () => {
  it("온 뷰만 갈아끼우고 나머지 뷰는 그대로 둔다", () => {
    const before = payload("before");
    const merged = mergeSlice(before, squadSlice("after", 1));

    expect(merged.views.squad.formation).toBe("4-2-3-1 after");
    // 저장이 건드리지 않은 뷰 — 응답에 없었으니 화면이 쥔 값이 여전히 최신이다
    expect(merged.views.calendar).toBe(before.views.calendar);
    expect(merged.views.competitions).toBe(before.views.competitions);
    expect(merged.views.finance).toBe(before.views.finance);
    expect(merged.views.career).toBe(before.views.career);
  });

  it("뷰 밖의 것은 조각이 건드리지 않는다 — 채팅·날짜·이름", () => {
    const before = payload("before");
    const merged = mergeSlice(before, squadSlice("after", 1));

    expect(merged.chat).toBe(before.chat);
    expect(merged.date).toBe(before.date);
    expect(merged.teamName).toBe(before.teamName);
    expect(merged.matchLogs).toBe(before.matchLogs);
  });

  it("원본을 고치지 않는다 — 화면은 새 payload를 받는다", () => {
    const before = payload("before");
    const merged = mergeSlice(before, squadSlice("after", 1));

    expect(merged).not.toBe(before);
    expect(before.views.squad.formation).toBe("4-4-2 before");
  });
});
