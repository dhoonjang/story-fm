import { describe, expect, it } from "vitest";
import type { MatchEvent } from "@story-fm/domain";
import { applyEvents, createLedger, describeLedger } from "@story-fm/sim";
import { makeTeam } from "./helpers";

const home = makeTeam("hm", 80);
const away = makeTeam("aw", 75);

const ev = (partial: Partial<MatchEvent> & Pick<MatchEvent, "minute" | "type">): MatchEvent => ({
  actors: [],
  causes: [],
  ...partial,
});

describe("경기 장부 검증 (match-sim.md §4)", () => {
  it("골을 적용하면 스코어가 오른다", () => {
    const r = applyEvents(createLedger(home, away), [
      ev({ minute: 12, type: "goal", team: "home", actors: ["hm-fw1"] }),
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.score).toEqual({ home: 1, away: 0 });
  });

  it("그라운드에 없는 선수의 골은 반려된다", () => {
    const r = applyEvents(createLedger(home, away), [
      ev({ minute: 12, type: "goal", team: "home", actors: ["hm-sub-fw"] }),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("그라운드 위 선수가 아닙니다");
  });

  it("퇴장당한 선수는 이후 행동할 수 없다 — 배치는 원자적으로 반려", () => {
    const r = applyEvents(createLedger(home, away), [
      ev({ minute: 30, type: "red_card", team: "home", actors: ["hm-fw1"] }),
      ev({ minute: 40, type: "goal", team: "home", actors: ["hm-fw1"] }),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("퇴장");
  });

  it("경고 2회는 자동 퇴장이다", () => {
    const first = applyEvents(createLedger(home, away), [
      ev({ minute: 20, type: "yellow_card", team: "away", actors: ["aw-df1"] }),
      ev({ minute: 55, type: "yellow_card", team: "away", actors: ["aw-df1"] }),
    ]);
    // 55분 이벤트가 전반(half_time 없음)에 오는 건 허용 — 시간 규칙만 본다
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.state.sentOff).toContain("aw-df1");
      expect(first.state.away.onPitch).not.toContain("aw-df1");
    }
  });

  it("시간 역행은 반려된다", () => {
    const r = applyEvents(createLedger(home, away), [
      ev({ minute: 30, type: "shot", team: "home", actors: ["hm-fw1"] }),
      ev({ minute: 20, type: "shot", team: "home", actors: ["hm-fw1"] }),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("시간 역행");
  });

  it("교체는 벤치 선수만, 5회까지 가능하다", () => {
    const ledger = createLedger(home, away);
    const bad = applyEvents(ledger, [
      ev({ minute: 60, type: "substitution", team: "home", actors: ["hm-fw1", "aw-sub-fw"] }),
    ]);
    expect(bad.ok).toBe(false);

    const good = applyEvents(ledger, [
      ev({ minute: 60, type: "substitution", team: "home", actors: ["hm-fw1", "hm-sub-fw"] }),
    ]);
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.state.home.onPitch).toContain("hm-sub-fw");
      expect(good.state.home.subsUsed).toBe(1);
      // 교체 아웃된 선수는 더 행동 불가
      const after = applyEvents(good.state, [
        ev({ minute: 70, type: "shot", team: "home", actors: ["hm-fw1"] }),
      ]);
      expect(after.ok).toBe(false);
    }
  });

  it("팀당 6골 상한 — 7번째 골은 반려된다", () => {
    let state = createLedger(home, away);
    for (let n = 0; n < 6; n++) {
      const r = applyEvents(state, [
        ev({ minute: 10 + n, type: "goal", team: "home", actors: ["hm-fw1"] }),
      ]);
      expect(r.ok).toBe(true);
      if (r.ok) state = r.state;
    }
    const seventh = applyEvents(state, [
      ev({ minute: 80, type: "goal", team: "home", actors: ["hm-fw1"] }),
    ]);
    expect(seventh.ok).toBe(false);
    if (!seventh.ok) expect(seventh.errors[0]).toContain("상한");
  });

  it("하프타임 없이 full_time은 불가하고, 순서를 지키면 종료된다", () => {
    const noHalf = applyEvents(createLedger(home, away), [
      ev({ minute: 92, type: "full_time" }),
    ]);
    expect(noHalf.ok).toBe(false);

    // 하프타임은 강제 정지점 — 별도 배치로 나눠야 한다
    const firstHalf = applyEvents(createLedger(home, away), [
      ev({ minute: 45, type: "half_time" }),
    ]);
    expect(firstHalf.ok).toBe(true);
    if (!firstHalf.ok) return;
    const proper = applyEvents(firstHalf.state, [ev({ minute: 93, type: "full_time" })]);
    expect(proper.ok).toBe(true);
    if (proper.ok) {
      expect(proper.state.phase).toBe("finished");
      const after = applyEvents(proper.state, [
        ev({ minute: 94, type: "shot", team: "home", actors: ["hm-fw1"] }),
      ]);
      expect(after.ok).toBe(false);
    }
  });

  it("하프타임 뒤에 같은 배치로 사건을 이어붙이면 반려된다 — 강제 정지점", () => {
    const r = applyEvents(createLedger(home, away), [
      ev({ minute: 45, type: "half_time" }),
      ev({ minute: 50, type: "shot", team: "home", actors: ["hm-fw1"] }),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("정지점");
  });

  it("교체 기회는 하프타임 제외 3회까지다", () => {
    let state = createLedger(home, away);
    const half = applyEvents(state, [ev({ minute: 45, type: "half_time" })]);
    if (!half.ok) throw new Error("half fail");
    state = half.state;

    const subs: Array<[number, string, string]> = [
      [50, "hm-df1", "hm-sub-gk"],
      [60, "hm-df2", "hm-sub-df"],
      [70, "hm-df3", "hm-sub-mf"],
    ];
    for (const [minute, out, into] of subs) {
      const r = applyEvents(state, [
        ev({ minute, type: "substitution", team: "home", actors: [out, into] }),
      ]);
      expect(r.ok).toBe(true);
      if (r.ok) state = r.state;
    }
    // 4번째 창은 반려 (선수 수는 4번째지만 기회가 소진)
    const fourth = applyEvents(state, [
      ev({ minute: 80, type: "substitution", team: "home", actors: ["hm-df4", "hm-sub-fw"] }),
    ]);
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.errors[0]).toContain("교체 기회");
  });

  it("킥오프는 한 경기에 한 번만 기록된다", () => {
    const first = applyEvents(createLedger(home, away), [ev({ minute: 0, type: "kickoff" })]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const dup = applyEvents(first.state, [ev({ minute: 1, type: "kickoff" })]);
    expect(dup.ok).toBe(false);
  });

  it("팀 귀속 이벤트에 team이 없으면 반려된다", () => {
    const r = applyEvents(createLedger(home, away), [
      ev({ minute: 10, type: "goal", actors: ["hm-fw1"] }),
    ]);
    expect(r.ok).toBe(false);
  });

  it("장부 요약은 스코어·페이즈를 담는다", () => {
    const r = applyEvents(createLedger(home, away), [
      ev({ minute: 12, type: "goal", team: "home", actors: ["hm-fw1"], causes: ["wing_overload"] }),
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const text = describeLedger(r.state, { home: "홈FC", away: "어웨이FC" });
      expect(text).toContain("홈FC 1 : 0 어웨이FC");
      expect(text).toContain("전반");
    }
  });
});
