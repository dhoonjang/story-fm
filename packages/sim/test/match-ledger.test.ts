import { describe, expect, it } from "vitest";
import type { MatchEvent } from "@story-fm/domain";
import {
  applyEvents,
  createLedger,
  finishingGoalProbability,
  samplePoisson,
  sampleShotXg,
  type ApplyResult,
  type MatchLedgerState,
} from "@story-fm/sim";
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

/**
 * 결과에서 값을 꺼내는 두 도구 — **꺼내는 순간 판정이 선다.**
 *
 * 원장은 순수 함수라 반려는 곧 셋업이 틀렸다는 뜻인데, `if (r.ok)`로 감싸거나
 * `if (!r.ok) return`으로 빠지면 그 뒤의 단언이 한 줄도 안 돌고 케이스는 초록으로
 * 남는다. 여기서 터뜨리면 무엇이 왜 반려됐는지가 그대로 보인다.
 */
function passed(result: ApplyResult): MatchLedgerState {
  if (!result.ok) throw new Error(`반려됐다: ${result.errors.join(" / ")}`);
  return result.state;
}

/** 반려를 요구하고 사유를 돌려준다 — 어느 규칙이 걸렸는지까지 한 줄에서 잰다 */
function refused(result: ApplyResult): string[] {
  if (result.ok) throw new Error("통과했다 — 반려됐어야 한다");
  return result.errors;
}

describe("경기 장부 검증 (match.md §5)", () => {
  it("골을 적용하면 스코어가 오른다", () => {
    const r = applyEvents(createLedger(home, away), [
      ev({ minute: 12, type: "goal", team: "home", actors: ["hm-fw1"] }),
    ]);
    expect(passed(r).score).toEqual({ home: 1, away: 0 });
  });

  it("그라운드에 없는 선수의 골은 반려된다", () => {
    const r = applyEvents(createLedger(home, away), [
      ev({ minute: 12, type: "goal", team: "home", actors: ["hm-sub-fw"] }),
    ]);
    expect(refused(r)[0]).toContain("그라운드 위 선수가 아닙니다");
  });

  it("도움이 실려도 골은 그대로 기록된다", () => {
    const r = applyEvents(createLedger(home, away), [
      ev({ minute: 12, type: "goal", team: "home", actors: ["hm-fw1", "hm-mf1"] }),
    ]);
    const state = passed(r);
    expect(state.score).toEqual({ home: 1, away: 0 });
    expect(state.events[0]?.actors).toEqual(["hm-fw1", "hm-mf1"]);
  });

  it("못 믿을 도움은 떨구되 **골은 살린다** — 이미 서술된 득점이 사라지면 안 된다", () => {
    for (const bogus of ["hm-sub-fw", "aw-fw1", "hm-fw1"]) {
      const r = applyEvents(createLedger(home, away), [
        ev({ minute: 12, type: "goal", team: "home", actors: ["hm-fw1", bogus] }),
      ]);
      expect(r.ok, `도움 "${bogus}"가 골을 반려시켰다`).toBe(true);
      const state = passed(r);
      expect(state.score).toEqual({ home: 1, away: 0 });
      // 득점자만 남는다 (자기 자신이 도움일 수도 없다)
      expect(state.events[0]?.actors).toEqual(["hm-fw1"]);
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
    expect(refused(r)[0]).toContain("퇴장");
  });

  it("경고 2회는 자동 퇴장이다", () => {
    const first = applyEvents(createLedger(home, away), [
      ev({ minute: 20, type: "yellow_card", team: "away", actors: ["aw-df1"] }),
      ev({ minute: 55, type: "yellow_card", team: "away", actors: ["aw-df1"] }),
    ]);
    // 55분 이벤트가 전반(half_time 없음)에 오는 건 허용 — 시간 규칙만 본다
    const twoYellows = passed(first);
    expect(twoYellows.sentOff).toContain("aw-df1");
    expect(twoYellows.away.onPitch).not.toContain("aw-df1");

    // 경고 한 줄 + 퇴장 한 줄 — 두 번째 경고 뒤의 red_card는 온필드를 요구하지 않는다.
    // 사건 목록에 red_card가 남아야 다음 경기 출장 정지가 걸린다 (match.md §7).
    const withRed = applyEvents(createLedger(home, away), [
      ev({ minute: 20, type: "yellow_card", team: "away", actors: ["aw-df1"] }),
      ev({ minute: 55, type: "yellow_card", team: "away", actors: ["aw-df1"] }),
      ev({ minute: 55, type: "red_card", team: "away", actors: ["aw-df1"] }),
    ]);
    const withRedState = passed(withRed);
    expect(withRedState.events.map((e) => e.type)).toEqual([
      "yellow_card",
      "yellow_card",
      "red_card",
    ]);
    // 퇴장은 한 번뿐이다 — 경고와 레드가 각각 밀어 넣으면 정지가 두 번 걸린다
    expect(withRedState.sentOff.filter((id) => id === "aw-df1")).toHaveLength(1);
    expect(withRedState.away.onPitch).not.toContain("aw-df1");
  });

  it("같은 퇴장에 red_card가 두 줄이면 뒷줄은 반려된다", () => {
    const r = applyEvents(createLedger(home, away), [
      ev({ minute: 20, type: "yellow_card", team: "away", actors: ["aw-df1"] }),
      ev({ minute: 55, type: "yellow_card", team: "away", actors: ["aw-df1"] }),
      ev({ minute: 55, type: "red_card", team: "away", actors: ["aw-df1"] }),
      ev({ minute: 56, type: "red_card", team: "away", actors: ["aw-df1"] }),
    ]);
    expect(refused(r)[0]).toContain("퇴장");
  });

  it("시간 역행은 반려된다", () => {
    const r = applyEvents(createLedger(home, away), [
      ev({ minute: 30, type: "shot", team: "home", actors: ["hm-fw1"] }),
      ev({ minute: 20, type: "shot", team: "home", actors: ["hm-fw1"] }),
    ]);
    expect(refused(r)[0]).toContain("시간 역행");
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
    const swapped = passed(good);
    expect(swapped.home.onPitch).toContain("hm-sub-fw");
    expect(swapped.home.subsUsed).toBe(1);
    // 교체 아웃된 선수는 더 행동 불가
    const after = applyEvents(swapped, [
      ev({ minute: 70, type: "shot", team: "home", actors: ["hm-fw1"] }),
    ]);
    expect(after.ok).toBe(false);
  });

  it("득점 결과를 임의 상한으로 자르지 않는다 — 7번째 골도 기록된다", () => {
    let state = createLedger(home, away);
    for (let n = 0; n < 6; n++) {
      const r = applyEvents(state, [
        ev({ minute: 10 + n, type: "goal", team: "home", actors: ["hm-fw1"] }),
      ]);
      state = passed(r);
    }
    const seventh = applyEvents(state, [
      ev({ minute: 80, type: "goal", team: "home", actors: ["hm-fw1"] }),
    ]);
    expect(passed(seventh).score.home).toBe(7);
  });

  it("하프타임 없이 full_time은 불가하고, 순서를 지키면 종료된다", () => {
    const noHalf = applyEvents(createLedger(home, away), [ev({ minute: 92, type: "full_time" })]);
    expect(noHalf.ok).toBe(false);

    // 하프타임은 강제 정지점 — 별도 배치로 나눠야 한다
    const firstHalf = applyEvents(createLedger(home, away), [
      ev({ minute: 45, type: "half_time" }),
    ]);
    const finished = passed(
      applyEvents(passed(firstHalf), [ev({ minute: 93, type: "full_time" })]),
    );
    expect(finished.phase).toBe("finished");
    const after = applyEvents(finished, [
      ev({ minute: 94, type: "shot", team: "home", actors: ["hm-fw1"] }),
    ]);
    expect(after.ok).toBe(false);
  });

  it("하프타임 뒤에 같은 배치로 사건을 이어붙이면 반려된다 — 강제 정지점", () => {
    const r = applyEvents(createLedger(home, away), [
      ev({ minute: 45, type: "half_time" }),
      ev({ minute: 50, type: "shot", team: "home", actors: ["hm-fw1"] }),
    ]);
    expect(refused(r)[0]).toContain("정지점");
  });

  it("교체 기회는 하프타임 제외 3회까지다", () => {
    let state = createLedger(home, away);
    state = passed(applyEvents(state, [ev({ minute: 45, type: "half_time" })]));

    const subs: Array<[number, string, string]> = [
      [50, "hm-df1", "hm-sub-gk"],
      [60, "hm-df2", "hm-sub-df"],
      [70, "hm-df3", "hm-sub-mf"],
    ];
    for (const [minute, out, into] of subs) {
      const r = applyEvents(state, [
        ev({ minute, type: "substitution", team: "home", actors: [out, into] }),
      ]);
      state = passed(r);
    }
    // 4번째 창은 반려 (선수 수는 4번째지만 기회가 소진)
    const fourth = applyEvents(state, [
      ev({ minute: 80, type: "substitution", team: "home", actors: ["hm-df4", "hm-sub-fw"] }),
    ]);
    expect(refused(fourth)[0]).toContain("교체 기회");
  });

  /**
   * 창 면제는 **정지점 종류가 정한다** — 분으로 재면(45′·46′) 추가시간이 얹힌
   * 하프타임과 연장의 두 휴식이 통째로 규칙 밖으로 나간다 (match.md §5).
   */
  it("휴식 정지점의 교체는 창을 쓰지 않는다 — 시각이 45′·46′가 아니어도", () => {
    const bench = Array.from({ length: 8 }, (_, i) => `b${i}`);
    const opening = createLedger({ onPitch: home.onPitch, bench }, away);

    const half = passed(applyEvents(opening, [ev({ minute: 47, type: "half_time" })]));
    const atHalf = passed(
      applyEvents(half, [
        ev({ minute: 47, type: "substitution", team: "home", actors: ["hm-df1", "b0"] }),
      ]),
    );
    expect(atHalf.home.subWindows).toBe(0);

    // 경기가 재개되면 같은 자리도 보통의 교체다
    let state = passed(
      applyEvents(atHalf, [
        ev({ minute: 50, type: "shot", team: "home", actors: ["hm-fw1"] }),
        ev({ minute: 50, type: "substitution", team: "home", actors: ["hm-df2", "b1"] }),
      ]),
    );
    expect(state.home.subWindows).toBe(1);

    // 연장의 두 휴식 — 면제 조건 자체가 없어 창을 먹던 자리다
    for (const [minute, type] of [
      [90, "extra_time_start"],
      [105, "extra_half_time"],
    ] as const) {
      const opened = passed(applyEvents(state, [ev({ minute, type })]));
      state = passed(
        applyEvents(opened, [
          ev({
            minute,
            type: "substitution",
            team: "home",
            actors: [minute === 90 ? "hm-df3" : "hm-df4", minute === 90 ? "b2" : "b3"],
          }),
        ]),
      );
      expect(state.home.subWindows, `${type}에서 창이 소모됐다`).toBe(1);
    }
  });

  /**
   * 구간 시뮬은 AI 교체를 정지 사건 **앞**에 끼워 한 배치로 올린다
   * (`insertBeforeStop`) — 같은 정지점의 같은 자리다.
   */
  it("정지 사건 앞에 붙은 교체도 창을 쓰지 않는다", () => {
    const bench = Array.from({ length: 8 }, (_, i) => `b${i}`);
    const r = applyEvents(createLedger({ onPitch: home.onPitch, bench }, away), [
      ev({ minute: 45, type: "substitution", team: "home", actors: ["hm-df1", "b0"] }),
      ev({ minute: 45, type: "half_time" }),
    ]);
    expect(passed(r).home.subWindows).toBe(0);
  });

  it("킥오프는 한 경기에 한 번만 기록된다", () => {
    const first = passed(
      applyEvents(createLedger(home, away), [ev({ minute: 0, type: "kickoff" })]),
    );
    const dup = applyEvents(first, [ev({ minute: 1, type: "kickoff" })]);
    expect(dup.ok).toBe(false);
  });

  it("팀 귀속 이벤트에 team이 없으면 반려된다", () => {
    const r = applyEvents(createLedger(home, away), [
      ev({ minute: 10, type: "goal", actors: ["hm-fw1"] }),
    ]);
    expect(r.ok).toBe(false);
  });

  it("리그처럼 연장이 없는 경기는 후반에서 바로 끝난다 — 국면이 하나 더 생겨도 그대로다", () => {
    const half = passed(
      applyEvents(createLedger(home, away), [ev({ minute: 46, type: "half_time" })]),
    );
    const end = applyEvents(half, [ev({ minute: 93, type: "full_time" })]);
    expect(passed(end).phase).toBe("finished");
  });
});

/**
 * 연장 — 90분이 승부를 못 가린 녹아웃은 장부가 **계속 열려 있어야** 한다.
 * `full_time` 자리를 `extra_time_start`가 대신하고, 그 뒤로 두 하프가 더 있다.
 */
describe("연장 장부 (match.md §2)", () => {
  /** 후반까지 흘려 놓은 장부 */
  function inSecondHalf(): MatchLedgerState {
    return passed(applyEvents(createLedger(home, away), [ev({ minute: 45, type: "half_time" })]));
  }

  it("후반 → 연장 전반 → 연장 후반 → 종료로 이어진다", () => {
    let state = passed(applyEvents(inSecondHalf(), [ev({ minute: 92, type: "extra_time_start" })]));
    expect(state.phase).toBe("extra_first");

    // 연장 전반에도 경기는 굴러간다
    state = passed(
      applyEvents(state, [ev({ minute: 98, type: "goal", team: "home", actors: ["hm-fw1"] })]),
    );
    expect(state.score).toEqual({ home: 1, away: 0 });

    state = passed(applyEvents(state, [ev({ minute: 105, type: "extra_half_time" })]));
    expect(state.phase).toBe("extra_second");

    expect(passed(applyEvents(state, [ev({ minute: 121, type: "full_time" })])).phase).toBe(
      "finished",
    );
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
    const start = passed(
      applyEvents(inSecondHalf(), [ev({ minute: 90, type: "extra_time_start" })]),
    );

    // 연장 전반에서 곧장 종료 — 연장 후반이 남아 있다
    const early = applyEvents(start, [ev({ minute: 105, type: "full_time" })]);
    expect(early.ok).toBe(false);

    const half = passed(applyEvents(start, [ev({ minute: 106, type: "extra_half_time" })]));
    const short = applyEvents(half, [ev({ minute: 115, type: "full_time" })]);
    expect(refused(short)[0]).toContain("120′");
  });

  it("연장 개시도 강제 정지점이다 — 같은 배치에 이후 사건을 이어붙일 수 없다", () => {
    const r = applyEvents(inSecondHalf(), [
      ev({ minute: 91, type: "extra_time_start" }),
      ev({ minute: 95, type: "shot", team: "home", actors: ["hm-fw1"] }),
    ]);
    expect(refused(r)[0]).toContain("정지점");
  });

  it("연장에는 교체 한 장·한 번이 더 있다 — 6인/4회", () => {
    // 벤치를 넉넉히 둔다 — 여기서 재는 것은 한도이지 벤치 깊이가 아니다
    const deepBench = {
      onPitch: home.onPitch,
      bench: Array.from({ length: 8 }, (_, i) => `b${i}`),
    };
    let state = passed(
      applyEvents(createLedger(deepBench, away), [ev({ minute: 45, type: "half_time" })]),
    );

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
      state = passed(r);
    }
    expect(state.home.subsUsed).toBe(5);
    expect(state.home.subWindows).toBe(3);

    // 여섯 번째는 아직 안 된다 — 90분의 한도는 5인이다
    const sixthInRegulation = applyEvents(state, [
      ev({ minute: 85, type: "substitution", team: "home", actors: ["hm-mf2", "b5"] }),
    ]);
    expect(sixthInRegulation.ok).toBe(false);

    state = passed(applyEvents(state, [ev({ minute: 92, type: "extra_time_start" })]));

    // 연장에 들어오면 한 장이 더 열린다 (네 번째 창)
    state = passed(
      applyEvents(state, [
        ev({ minute: 95, type: "substitution", team: "home", actors: ["hm-mf2", "b5"] }),
      ]),
    );
    expect(state.home.subsUsed).toBe(6);
    expect(state.home.subWindows).toBe(4);

    // 일곱 번째는 연장에서도 없다
    const seventh = applyEvents(state, [
      ev({ minute: 100, type: "substitution", team: "home", actors: ["hm-mf3", "b6"] }),
    ]);
    expect(refused(seventh)[0]).toContain("6명 소진");
  });
});

function rngOf(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) | 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

describe("결정력 — 기회의 질과 실현을 분리한다", () => {
  it("결정력 75는 기회 xG를 그대로 실현하고, 높고 낮음은 양방향으로 갈린다", () => {
    expect(finishingGoalProbability(0.1, 75)).toBeCloseTo(0.1, 10);
    expect(finishingGoalProbability(0.1, 90)).toBeGreaterThan(0.1);
    expect(finishingGoalProbability(0.1, 40)).toBeLessThan(0.1);
  });

  it("결과를 알기 전에 뽑는 xG 분포는 지정한 평균을 보존한다", () => {
    const rng = rngOf(17);
    const samples = Array.from({ length: 20_000 }, () => sampleShotXg(rng, 0.11));
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    expect(mean).toBeCloseTo(0.11, 2);
    expect(samples.every((value) => value > 0 && value < 1)).toBe(true);
  });
});

describe("슈팅 수 — 결과를 자르는 상·하한이 없다", () => {
  it("포아송 분포의 오른쪽 꼬리가 임의의 22회 경계에서 잘리지 않는다", () => {
    const samples = Array.from({ length: 2_000 }, (_, seed) => samplePoisson(rngOf(seed), 18));
    expect(Math.max(...samples)).toBeGreaterThan(22);
    expect(new Set(samples.filter((value) => value > 22)).size).toBeGreaterThan(3);
  });
});
