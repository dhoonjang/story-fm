import { describe, expect, it } from "vitest";
import type { MatchEvent } from "@story-fm/domain";
import { applyEvents, createLedger } from "@story-fm/sim";
import { makeLedgerSide, makeSquad } from "./helpers";

const homeSquad = makeSquad("hm", 80);
const awaySquad = makeSquad("aw", 75);
const home = makeLedgerSide(homeSquad);
const away = makeLedgerSide(awaySquad);

const ev = (partial: Partial<MatchEvent> & Pick<MatchEvent, "minute" | "type">): MatchEvent => ({
  actors: [],
  causes: [],
  ...partial,
});

describe("경기 장부 검증 (match.md §5)", () => {
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

  it("도움이 실려도 골은 그대로 기록된다", () => {
    const r = applyEvents(createLedger(home, away), [
      ev({ minute: 12, type: "goal", team: "home", actors: ["hm-fw1", "hm-mf1"] }),
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.score).toEqual({ home: 1, away: 0 });
      expect(r.state.events[0]?.actors).toEqual(["hm-fw1", "hm-mf1"]);
    }
  });

  it("못 믿을 도움은 떨구되 **골은 살린다** — 이미 서술된 득점이 사라지면 안 된다", () => {
    for (const bogus of ["hm-sub-fw", "aw-fw1", "hm-fw1"]) {
      const r = applyEvents(createLedger(home, away), [
        ev({ minute: 12, type: "goal", team: "home", actors: ["hm-fw1", bogus] }),
      ]);
      expect(r.ok, `도움 "${bogus}"가 골을 반려시켰다`).toBe(true);
      if (r.ok) {
        expect(r.state.score).toEqual({ home: 1, away: 0 });
        // 득점자만 남는다 (자기 자신이 도움일 수도 없다)
        expect(r.state.events[0]?.actors).toEqual(["hm-fw1"]);
      }
    }
  });

  it("득점자 자체가 그라운드 밖이면 여전히 반려다 — 관용은 도움 슬롯에만", () => {
    const r = applyEvents(createLedger(home, away), [
      ev({ minute: 12, type: "goal", team: "home", actors: ["hm-sub-fw", "hm-mf1"] }),
    ]);
    expect(r.ok).toBe(false);
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

  it("득점 결과를 임의 상한으로 자르지 않는다 — 7번째 골도 기록된다", () => {
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
    expect(seventh.ok).toBe(true);
    if (seventh.ok) expect(seventh.state.score.home).toBe(7);
  });

  it("하프타임 없이 full_time은 불가하고, 순서를 지키면 종료된다", () => {
    const noHalf = applyEvents(createLedger(home, away), [ev({ minute: 92, type: "full_time" })]);
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

  it("리그처럼 연장이 없는 경기는 후반에서 바로 끝난다 — 국면이 하나 더 생겨도 그대로다", () => {
    const half = applyEvents(createLedger(home, away), [ev({ minute: 46, type: "half_time" })]);
    if (!half.ok) throw new Error("half fail");
    const end = applyEvents(half.state, [ev({ minute: 93, type: "full_time" })]);
    expect(end.ok).toBe(true);
    if (end.ok) expect(end.state.phase).toBe("finished");
  });
});

/**
 * 연장 — 90분이 승부를 못 가린 녹아웃은 장부가 **계속 열려 있어야** 한다.
 * `full_time` 자리를 `extra_time_start`가 대신하고, 그 뒤로 두 하프가 더 있다.
 */
describe("연장 장부 (match.md §2)", () => {
  /** 후반까지 흘려 놓은 장부 */
  function inSecondHalf() {
    const half = applyEvents(createLedger(home, away), [ev({ minute: 45, type: "half_time" })]);
    if (!half.ok) throw new Error("half fail");
    return half.state;
  }

  it("후반 → 연장 전반 → 연장 후반 → 종료로 이어진다", () => {
    let state = inSecondHalf();
    const start = applyEvents(state, [ev({ minute: 92, type: "extra_time_start" })]);
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(start.state.phase).toBe("extra_first");
    state = start.state;

    // 연장 전반에도 경기는 굴러간다
    const goal = applyEvents(state, [
      ev({ minute: 98, type: "goal", team: "home", actors: ["hm-fw1"] }),
    ]);
    expect(goal.ok).toBe(true);
    if (!goal.ok) return;
    expect(goal.state.score).toEqual({ home: 1, away: 0 });
    state = goal.state;

    const breakTime = applyEvents(state, [ev({ minute: 105, type: "extra_half_time" })]);
    expect(breakTime.ok).toBe(true);
    if (!breakTime.ok) return;
    expect(breakTime.state.phase).toBe("extra_second");
    state = breakTime.state;

    const end = applyEvents(state, [ev({ minute: 121, type: "full_time" })]);
    expect(end.ok).toBe(true);
    if (end.ok) expect(end.state.phase).toBe("finished");
  });

  it("연장 개시는 후반 90′ 이후에만 — 전반에서도, 89′에도 올 수 없다", () => {
    const tooEarly = applyEvents(createLedger(home, away), [
      ev({ minute: 92, type: "extra_time_start" }),
    ]);
    expect(tooEarly.ok).toBe(false);

    const beforeNinety = applyEvents(inSecondHalf(), [
      ev({ minute: 89, type: "extra_time_start" }),
    ]);
    expect(beforeNinety.ok).toBe(false);
  });

  it("연장 중의 종료는 120′ 이후여야 한다 — 연장 전반에서는 끝낼 수 없다", () => {
    const start = applyEvents(inSecondHalf(), [ev({ minute: 90, type: "extra_time_start" })]);
    if (!start.ok) throw new Error("extra fail");

    // 연장 전반에서 곧장 종료 — 연장 후반이 남아 있다
    const early = applyEvents(start.state, [ev({ minute: 105, type: "full_time" })]);
    expect(early.ok).toBe(false);

    const half = applyEvents(start.state, [ev({ minute: 106, type: "extra_half_time" })]);
    if (!half.ok) throw new Error("extra half fail");
    const short = applyEvents(half.state, [ev({ minute: 115, type: "full_time" })]);
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.errors[0]).toContain("120′");
  });

  it("연장 개시도 강제 정지점이다 — 같은 배치에 이후 사건을 이어붙일 수 없다", () => {
    const r = applyEvents(inSecondHalf(), [
      ev({ minute: 91, type: "extra_time_start" }),
      ev({ minute: 95, type: "shot", team: "home", actors: ["hm-fw1"] }),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("정지점");
  });

  it("연장에는 교체 한 장·한 번이 더 있다 — 6인/4회", () => {
    // 벤치를 넉넉히 둔다 — 여기서 재는 것은 한도이지 벤치 깊이가 아니다
    const deepBench = { onPitch: home.onPitch, bench: Array.from({ length: 8 }, (_, i) => `b${i}`) };
    let state = createLedger(deepBench, away);
    const half = applyEvents(state, [ev({ minute: 45, type: "half_time" })]);
    if (!half.ok) throw new Error("half fail");
    state = half.state;

    // 정규시간 — 5인/3회가 한계다
    const regulation: Array<[number, string, string]> = [
      [55, "hm-df1", "b0"],
      [55, "hm-df2", "b1"], // 같은 분 = 한 창
      [65, "hm-df3", "b2"],
      [65, "hm-df4", "b3"],
      [75, "hm-mf1", "b4"],
    ];
    for (const [minute, out, into] of regulation) {
      const r = applyEvents(state, [
        ev({ minute, type: "substitution", team: "home", actors: [out, into] }),
      ]);
      expect(r.ok, `${minute}′ 교체가 반려됐다`).toBe(true);
      if (r.ok) state = r.state;
    }
    expect(state.home.subsUsed).toBe(5);
    expect(state.home.subWindows).toBe(3);

    // 여섯 번째는 아직 안 된다 — 90분의 한도는 5인이다
    const sixthInRegulation = applyEvents(state, [
      ev({ minute: 85, type: "substitution", team: "home", actors: ["hm-mf2", "b5"] }),
    ]);
    expect(sixthInRegulation.ok).toBe(false);

    const start = applyEvents(state, [ev({ minute: 92, type: "extra_time_start" })]);
    if (!start.ok) throw new Error("extra fail");
    state = start.state;

    // 연장에 들어오면 한 장이 더 열린다 (네 번째 창)
    const sixth = applyEvents(state, [
      ev({ minute: 95, type: "substitution", team: "home", actors: ["hm-mf2", "b5"] }),
    ]);
    expect(sixth.ok).toBe(true);
    if (!sixth.ok) return;
    state = sixth.state;
    expect(state.home.subsUsed).toBe(6);
    expect(state.home.subWindows).toBe(4);

    // 일곱 번째는 연장에서도 없다
    const seventh = applyEvents(state, [
      ev({ minute: 100, type: "substitution", team: "home", actors: ["hm-mf3", "b6"] }),
    ]);
    expect(seventh.ok).toBe(false);
    if (!seventh.ok) expect(seventh.errors[0]).toContain("6명 소진");
  });
});
