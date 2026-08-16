import { describe, expect, it } from "vitest";
import { buildOfficeViews } from "@story-fm/engine";
import { createTestGame } from "./helpers";

/**
 * 커리어 화면이 **경질을 실제로 정하는 값**을 싣는가.
 *
 * 경고 카운터는 이 세이브가 끝나는 유일한 길의 눈금이다 (career.md §5).
 * 경고를 세는 일은 `reviewUserSeat`의 몫이고 뷰는 상태에서 파생만 한다.
 */
describe("커리어 뷰 — 보드 경고", () => {
  it("옛 세이브(경고 필드 없음)는 0으로 읽힌다", () => {
    const state = createTestGame(42);
    delete state.manager.boardWarnings;
    delete state.manager.lastWarnedOn;

    const views = buildOfficeViews(state);
    expect(views.squad.manager.boardWarnings).toBe(0);
    expect(views.squad.manager.lastWarnedOn).toBeNull();
  });
});

describe("커리어 뷰 — 감독 XP", () => {
  it("소수로 쌓인 XP(훈련 세션당 0.5)는 반올림해서 싣는다", () => {
    const state = createTestGame(44);
    state.managerXP.training = 87.5;

    expect(buildOfficeViews(state).squad.manager.xp.training).toBe(88);
  });
});
