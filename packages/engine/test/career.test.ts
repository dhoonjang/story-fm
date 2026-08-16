import { describe, expect, it } from "vitest";
import { buildOfficeViews, careerView } from "@story-fm/engine";
import { createTestGame } from "./helpers";

/**
 * 커리어 화면이 **경질을 실제로 정하는 값**을 싣는가.
 *
 * 경고 카운터는 이 세이브가 끝나는 유일한 길의 눈금이라(career.md §5) 어느 뷰에도
 * 없으면 끝이 예고 없이 온다. 여기서 검증하는 것은 계산이 아니라 **닿는지**다 —
 * 경고를 세는 일은 `reviewUserSeat`의 몫이고 뷰는 상태에서 파생만 한다.
 */
describe("커리어 뷰 — 보드 경고", () => {
  it("경고가 선 세이브는 뷰와 get_career 양쪽에 그 숫자가 닿는다", () => {
    const state = createTestGame(41);
    state.manager.boardWarnings = 2;
    state.manager.lastWarnedOn = "2026-11-03";

    const views = buildOfficeViews(state);
    expect(views.squad.manager.boardWarnings).toBe(2);
    expect(views.squad.manager.lastWarnedOn).toBe("2026-11-03");
    expect(views.squad.manager.warningLimit).toBe(3);

    const res = careerView(state);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("보드 경고: 2/3회");
    expect(res.message).toContain("2026-11-03");
  });

  it("옛 세이브(경고 필드 없음)는 0으로 읽힌다", () => {
    const state = createTestGame(42);
    delete state.manager.boardWarnings;
    delete state.manager.lastWarnedOn;

    const views = buildOfficeViews(state);
    expect(views.squad.manager.boardWarnings).toBe(0);
    expect(views.squad.manager.lastWarnedOn).toBeNull();

    expect(careerView(state).message).toContain("보드 경고: 없음");
  });
});

describe("커리어 뷰 — 감독 XP", () => {
  it("축별 XP가 뷰에 실린다", () => {
    const state = createTestGame(43);
    state.managerXP.leadership = 40;
    state.managerXP.tactics = 0;

    const manager = buildOfficeViews(state).squad.manager;
    expect(manager.xp.leadership).toBe(40);
    expect(manager.xp.tactics).toBe(0);
    // 성장 상한은 화면이 "자라는 중"을 그릴지 정하는 값이라 함께 실린다
    expect(manager.attrCap).toBe(90);
  });

  it("소수로 쌓인 XP(훈련 세션당 0.5)는 반올림해서 싣는다", () => {
    const state = createTestGame(44);
    state.managerXP.training = 87.5;

    expect(buildOfficeViews(state).squad.manager.xp.training).toBe(88);
  });
});
