import { describe, expect, it } from "vitest";
import {
  advanceTime,
  cancelTrainingOn,
  clearTraining,
  domesticStageMatches,
  installDefaultTraining,
  isPostponable,
  postponeMatch,
  preseasonReturnDate,
  setTraining,
  syncDefaultTraining,
  type GameState,
  squadReturnOf,
  onSummerBreak,
  userPlayers,
} from "@story-fm/engine";
import { isReserveMatch } from "@story-fm/domain";
import { createTestGame, advanceAndPlay, playMockMatch } from "./helpers";

/** 그 날짜의 예정 훈련 label 목록 (오전→오후) */
function trainingOn(state: GameState, date: string): string[] {
  const byId = new Map(state.trainingSessions.map((s) => [s.id, s]));
  return state.schedule
    .filter((e) => e.type === "training" && e.date === date)
    .sort((a, b) => a.time.localeCompare(b.time))
    .map((e) => byId.get(e.refId)?.label ?? "?");
}

function userMatchDates(state: GameState): string[] {
  return [
    ...new Set(
      state.matches
        // 2군 경기일은 1군 마이크로사이클의 경기일이 아니다 — 본체와 같은 게이트
        .filter(
          (m) =>
            !isReserveMatch(m) &&
            (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
        )
        .map((m) => m.date),
    ),
  ].sort();
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function diffDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

describe("기본 훈련 — 시즌 달력에 미리 깔려 있다", () => {
  it("게임을 시작하면 시즌 내내 훈련이 잡혀 있다", () => {
    const state = createTestGame();
    expect(state.trainingSessions.length).toBeGreaterThan(150);
    // 모든 기본 세션은 auto 표식을 갖는다 — 감독 지시와 구분하는 근거
    expect(state.trainingSessions.every((s) => s.auto === true)).toBe(true);
  });

  it("7월 둘째 월요일에 소집 — 그 전 열흘 남짓은 여름 휴가다", () => {
    const state = createTestGame();
    const back = preseasonReturnDate(state.calendar.preseasonStart);
    // 실제 2026/27 EPL의 다수 클럽 복귀일과 같은 날이다
    expect(back).toBe("2026-07-13");
    expect(new Date(`${back}T00:00:00Z`).getUTCDay()).toBe(1);

    for (let d = state.date; d < back; d = addDays(d, 1)) {
      expect(trainingOn(state, d), `${d}는 휴가`).toHaveLength(0);
    }
    expect(trainingOn(state, back).length).toBeGreaterThan(0);
  });

  it("복귀 첫 주는 메디컬로 열고 강도를 올리지 않는다", () => {
    const state = createTestGame();
    const back = preseasonReturnDate(state.calendar.preseasonStart);
    // 문구가 아니라 규칙을 잰다 — 복귀 첫날은 검사 한 세션뿐이다
    expect(trainingOn(state, back)).toHaveLength(1);
    expect(trainingOn(state, back)[0]).toContain("메디컬");
    // 복귀 주 내내 단일 세션 (이중 세션은 그다음 주부터)
    for (let i = 0; i <= 4; i++) {
      expect(trainingOn(state, addDays(back, i)), `복귀 ${i}일차`).toHaveLength(1);
    }
    // 복귀 주 마지막 날은 **첫 친선의 전날**이다 — 경기 준비가 체력 테스트를 밀어낸다.
    // 경기와의 거리가 요일보다 먼저다(planFor)
    expect(trainingOn(state, addDays(back, 4)).join()).toContain("경기 준비");
  });

  it("복귀 주 다음 2주가 기초 체력기 — 러닝·웨이트에 이중 세션", () => {
    const state = createTestGame();
    const base = addDays(preseasonReturnDate(state.calendar.preseasonStart), 7); // 둘째 주 월요일
    const buildUp = trainingOn(state, base).concat(
      trainingOn(state, addDays(base, 1)),
      trainingOn(state, addDays(base, 2)),
    );
    for (const label of buildUp) {
      expect(label).toMatch(/체력|근력|스프린트|경합/);
    }
    // 화·목은 오전·오후
    expect(trainingOn(state, addDays(base, 1))).toHaveLength(2);
    // 체력기가 끝나면 전술·기술로 넘어가고 이중 세션도 사라진다
    const later = addDays(base, 15); // 그 2주가 지난 뒤
    expect(trainingOn(state, later)).toHaveLength(1);
    expect(trainingOn(state, later)[0]).not.toMatch(/기초 체력|근력 서킷/);
  });

  it("경기일엔 훈련이 없고, 다음날은 회복·전날은 경기 준비다", () => {
    const state = createTestGame();
    const dates = userMatchDates(state);
    // 개막 이후 열 경기를 표본으로 본다
    for (const date of dates.slice(0, 10)) {
      expect(trainingOn(state, date), `${date}는 경기일`).toHaveLength(0);

      const after = trainingOn(state, addDays(date, 1));
      // 다음날이 또 경기가 아니라면 회복 세션이다
      if (!dates.includes(addDays(date, 1))) {
        expect(after.join(), `${date} 다음날`).toContain("회복");
      }
      // 직전 경기가 이틀 이내면 회복이 우선한다 — 그때만 전날이 경기 준비가 아니다
      const before = trainingOn(state, addDays(date, -1));
      const backToBack = dates.includes(addDays(date, -1)) || dates.includes(addDays(date, -2));
      if (!backToBack && before.length > 0) {
        expect(before.join(), `${date} 전날`).toContain("경기 준비");
      }
    }
  });

  it("주중 경기가 끼면 본훈련이 사라지고 회복·전술만 남는다", () => {
    const state = createTestGame();
    const dates = userMatchDates(state);
    // 사흘 간격 연전을 찾는다 (경기 → D+1 회복 → D+2가 곧 D-1)
    const tight = dates.find((d, i) => i > 0 && dates[i - 1] === addDays(d, -3));
    expect(tight, "연전이 하나는 있다").toBeDefined();
    const prev = addDays(tight!, -3);
    expect(trainingOn(state, addDays(prev, 1)).join()).toContain("회복");
    expect(trainingOn(state, addDays(tight!, -1)).join()).toContain("경기 준비");
  });

  it("경기가 없는 주는 평일 5일만 훈련하고 주말은 쉰다", () => {
    const state = createTestGame();
    const dates = new Set(userMatchDates(state));
    // 프리시즌에도 경기가 있다(친선 — 7/18 토) — 그 주 평일은 훈련이 차 있다
    expect(trainingOn(state, "2026-07-18")).toHaveLength(0); // 토 = 경기일
    expect(trainingOn(state, "2026-07-19").join()).toContain("회복"); // 일 = MD+1
    for (const weekday of ["2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24"]) {
      expect(trainingOn(state, weekday).length, weekday).toBeGreaterThan(0);
    }
    expect(trainingOn(state, "2026-07-20")).toHaveLength(0); // 월 = MD+2 완전 휴식

    // 시즌 중에도 경기가 걸리지 않는 주말은 비어 있다 (A매치 휴식기 등)
    let checked = 0;
    for (let d = state.calendar.start; d < "2027-05-01"; d = addDays(d, 1)) {
      if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 6) continue; // 토요일만
      // 앞뒤 이틀에 경기가 없어야 "경기가 걸리지 않은 주말"이다
      if ([-2, -1, 0, 1, 2].some((off) => dates.has(addDays(d, off)))) continue;
      checked++;
      expect(trainingOn(state, d), `${d}(토)은 경기 없는 주말`).toHaveLength(0);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("보편 메뉴가 16축을 골고루 훑는다", () => {
    const state = createTestGame();
    const seen = new Map<string, number>();
    for (const s of state.trainingSessions) {
      for (const f of s.focus) seen.set(f, (seen.get(f) ?? 0) + 1);
    }
    // 능력치 16축이 모두 훈련 대상이 된다 — 영영 안 자라는 축은 없다
    const axes = [...seen.keys()].filter((k) => k !== "tactical" && k !== "recovery");
    expect(axes).toHaveLength(16);
    const counts = axes.map((a) => seen.get(a)!);
    expect(Math.min(...counts)).toBeGreaterThan(5);
    // 완전 균등은 아니다 — 본훈련이 잡히는 날은 경기 일정이 정하고, 프리시즌은
    // 신체 축에 몰린다. 다만 한 축이 다른 축의 세 배까지 벌어지지는 않는다
    expect(Math.max(...counts)).toBeLessThanOrEqual(Math.min(...counts) * 3);
  });

  it("날짜만으로 정해지므로 다시 깔아도 같은 일정이다", () => {
    const state = createTestGame();
    const before = state.schedule
      .filter((e) => e.type === "training")
      .map((e) => `${e.date}|${e.time}|${e.refId}`);
    installDefaultTraining(state);
    const after = state.schedule
      .filter((e) => e.type === "training")
      .map((e) => `${e.date}|${e.time}|${e.refId}`);
    expect(after).toEqual(before);
  });
});

describe("감독의 지시가 기본 훈련을 이긴다", () => {
  it("같은 슬롯에 지시하면 덮어쓰고, 기본 훈련은 다시 끼어들지 않는다", () => {
    const state = createTestGame();
    // 소집 이후여야 한다 — 휴가 기간엔 감독도 훈련을 걸 수 없다
    const day = addDays(squadReturnOf(state.calendar), 1);
    setTraining(state, {
      sessions: [{ date: day, slot: "am", label: "슈팅 특훈", focus: ["finishing"] }],
    });
    expect(trainingOn(state, day)).toEqual(["슈팅 특훈"]);

    installDefaultTraining(state);
    expect(trainingOn(state, day)).toEqual(["슈팅 특훈"]);
  });

  it("재조정은 기본 세션만 걷어낸다", () => {
    const state = createTestGame();
    const dates = userMatchDates(state);
    const matchday = dates[0]!;
    // 재조정은 눈앞의 경기만 본다 — 시계를 개막 열흘 전으로 옮긴다
    state.date = addDays(matchday, -10);
    // 감독이 경기 전날에 직접 지시를 넣어 둔다
    setTraining(state, {
      sessions: [{ date: addDays(matchday, -1), slot: "pm", label: "비디오 미팅", focus: [] }],
    });
    // 경기일에 기본 훈련이 남아 있는 상황을 만든다 (나중에 편성된 컵 경기 흉내)
    installDefaultTraining(state, { from: matchday, to: matchday });
    state.schedule.push({
      id: `se-fake-${matchday}`,
      date: matchday,
      time: "10:00",
      type: "training",
      refId: "ts-fake",
      teamId: state.userTeamId,
      status: "scheduled",
    });
    state.trainingSessions.push({ id: "ts-fake", label: "끼어든 훈련", focus: [], auto: true });

    syncDefaultTraining(state);
    expect(trainingOn(state, matchday)).toHaveLength(0);
    expect(trainingOn(state, addDays(matchday, -1)).join()).toContain("비디오 미팅");
  });
});

/**
 * 경기 하루의 마이크로사이클 — MD−1 준비 · 경기일 휴무 · MD+1 회복 · MD+2 완전 휴식.
 *
 * 옆에 다른 경기가 붙으면 그쪽 규칙이 이긴다(회복 → 경기 준비 → 전술 → 휴식 순).
 * 그래서 각 날짜는 **다른 경기에 물리지 않았을 때만** 확인한다.
 *
 * 단정이 아니라 위반 목록을 돌려준다 — 시즌을 굴리는 **도중에** 봐야 하는 것이라,
 * 굴리는 쪽은 모아 두고 단정은 각 케이스가 한다.
 */
function microcycleViolations(state: GameState, matchDate: string): string[] {
  const others = new Set(userMatchDates(state));
  others.delete(matchDate);
  const clear = (...offsets: number[]) => offsets.every((o) => !others.has(addDays(matchDate, o)));
  const out: string[] = [];

  if (trainingOn(state, matchDate).length > 0) out.push(`${matchDate}: 경기일에 훈련이 있다`);
  // MD−1 = 경기 준비. 단 이틀 전에 경기가 있었으면 그날은 회복이 이긴다
  if (clear(-1, -2) && !trainingOn(state, addDays(matchDate, -1)).join().includes("경기 준비")) {
    out.push(`${matchDate}: MD−1이 경기 준비가 아니다`);
  }
  if (clear(1) && !trainingOn(state, addDays(matchDate, 1)).join().includes("회복")) {
    out.push(`${matchDate}: MD+1이 회복이 아니다`);
  }
  // MD+2 = 완전 휴식. 단 사흘·나흘 뒤에 경기가 있으면 준비·전술이 이긴다
  if (clear(2, 3, 4) && trainingOn(state, addDays(matchDate, 2)).length > 0) {
    out.push(`${matchDate}: MD+2가 완전 휴식이 아니다`);
  }
  return out;
}

function expectMicrocycle(state: GameState, matchDate: string): void {
  expect(microcycleViolations(state, matchDate)).toEqual([]);
}

/** 그 컵 그 단계의 우리 경기 날짜 (없으면 "") */
function ourTieDate(state: GameState, cupId: string, stage: "r32"): string {
  return (
    domesticStageMatches(state, cupId, stage).find(
      (m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId,
    )?.date ?? ""
  );
}

describe("훈련 비우기 — 쉬는 날은 상태로 남는다", () => {
  /** 그 날짜에 훈련이 하나라도 있는 첫 날을 찾는다 (기본 배치는 주말·MD+2가 비어 있다) */
  function firstTrainingDay(state: GameState, from: string): string {
    for (let d = 0; d < 40; d++) {
      const date = addDays(from, d);
      if (trainingOn(state, date).length > 0) return date;
    }
    throw new Error("훈련이 있는 날을 찾지 못했습니다");
  }

  it("비운 자리는 tick을 넘겨도 되살아나지 않는다", () => {
    const state = createTestGame();
    const day = firstTrainingDay(state, addDays(state.date, 14));
    expect(trainingOn(state, day).length).toBeGreaterThan(0);

    const res = clearTraining(state, { from: day });
    expect(res.ok).toBe(true);
    // 달력에는 "휴식"이 선다 — 아무것도 안 보이면 감독이 지시가 먹혔는지 알 수 없다
    expect(trainingOn(state, day)).toEqual(["휴식"]);

    // 예전엔 여기서 기본 훈련이 도로 깔렸다 (빈자리 = 아직 안 깐 날)
    syncDefaultTraining(state);
    expect(trainingOn(state, day)).toEqual(["휴식"]);
    advanceTime(state, { days: 3 });
    expect(trainingOn(state, day)).toEqual(["휴식"]);
  });

  it("rest=false는 뜻이 다르다 — 자리를 비우면 기본 훈련이 돌아온다", () => {
    const state = createTestGame();
    const day = firstTrainingDay(state, addDays(state.date, 14));
    const before = trainingOn(state, day);

    clearTraining(state, { from: day, rest: false });
    expect(trainingOn(state, day)).toHaveLength(0);
    syncDefaultTraining(state);
    expect(trainingOn(state, day)).toEqual(before);
  });

  it("범위는 좁은 쪽이 기본 — to를 안 주면 하루만 비운다", () => {
    const state = createTestGame();
    const day = firstTrainingDay(state, addDays(state.date, 14));
    const next = firstTrainingDay(state, addDays(day, 1));
    const nextBefore = trainingOn(state, next);

    clearTraining(state, { from: day });
    expect(trainingOn(state, next)).toEqual(nextBefore);
  });

  it("기간·슬롯으로 좁혀 비운다", () => {
    const state = createTestGame();
    const from = addDays(state.date, 14);
    const to = addDays(from, 13);
    const res = clearTraining(state, { from, to, slot: "pm" });
    expect(res.ok).toBe(true);

    for (let d = 0; d <= 13; d++) {
      const date = addDays(from, d);
      const pm = state.schedule.filter(
        (e) => e.type === "training" && e.date === date && e.time === "15:00",
      );
      // 오후 자리는 전부 휴식이거나 비어 있다
      const labels = new Set(
        pm.map((e) => state.trainingSessions.find((s) => s.id === e.refId)?.label),
      );
      expect([...labels].every((l) => l === "휴식" || l === undefined)).toBe(true);
    }
  });

  it("휴식일의 회복은 훈련이 아예 없는 날과 같다", () => {
    // 같은 상황을 두 번 돌려 비교한다 — 절대값은 tick이 그날을 언제 소화하느냐에
    // 달려 있지만, "쉬면 더 회복한다"는 어느 시점에 재도 성립해야 한다
    const conditionAfter = (rest: boolean): number => {
      const state = createTestGame();
      const day = firstTrainingDay(state, addDays(state.date, 14));
      state.date = addDays(day, -1);
      for (const p of state.players) p.state.condition = 60;
      if (rest) clearTraining(state, { from: day });
      advanceTime(state, { days: 2 });
      return state.players.find((p) => p.teamId === state.userTeamId)!.state.condition;
    };
    // 훈련한 날은 +8, 쉬는 날은 +14 회복한다 (tick.ts의 idleDay)
    expect(conditionAfter(true)).toBeGreaterThan(conditionAfter(false));
  });

  it("지난 훈련은 이력이라 건드리지 않는다", () => {
    const state = createTestGame();
    advanceTime(state, { days: 20 });
    const past = state.schedule.filter((e) => e.type === "training" && e.status === "done").length;
    clearTraining(state, { from: state.calendar.start, to: addDays(state.date, 30) });
    expect(state.schedule.filter((e) => e.type === "training" && e.status === "done").length).toBe(
      past,
    );
  });
});

/**
 * 시즌을 **한 번만** 굴리고 세 검증이 나눠 쓴다.
 *
 * 셋 다 "컵 대진이 붙은 뒤의 달력"을 봐야 해서 시즌을 겨울까지 밀어야 하는데,
 * 예전엔 각자 제 세이브를 굴려 같은 아홉 달을 세 번 지났다. 보는 시점은 다르지만
 * 지나는 길은 하나다 — 한 번 굴리면서 각자의 시점에 위반을 모아 둔다.
 */
interface SeasonSweep {
  /** 리그컵 1라운드 — 경기 **전날**에 본 마이크로사이클 */
  eflcup: { date: string; violations: string[] };
  /** FA컵 1라운드 — **추첨된 그날** 본 마이크로사이클과 추첨~경기 간격(일) */
  facup: { date: string; gap: number; violations: string[] };
  /** 6주 간격 체크포인트마다 훑은 "아직 안 치른 경기" */
  sweep: { checked: number; violations: string[] };
}

let sweepCache: SeasonSweep | null = null;

function seasonSweep(): SeasonSweep {
  if (sweepCache) return sweepCache;
  const state = createTestGame(7);
  const out: SeasonSweep = {
    eflcup: { date: "", violations: [] },
    facup: { date: "", gap: 0, violations: [] },
    sweep: { checked: 0, violations: [] },
  };
  const checkpoints = new Set([45, 90, 135, 180, 225, 270]); // 6주 간격으로 시즌을 훑는다
  for (let day = 1; day <= 270; day++) {
    advanceTime(state, { days: 1 });
    if (state.phase === "matchday") playMockMatch(state);

    // 리그컵 — 경기 전날에는 재배치가 이미 끝나 있어야 한다
    const eflcup = ourTieDate(state, "eflcup", "r32");
    if (!out.eflcup.date && eflcup && state.date >= addDays(eflcup, -1)) {
      out.eflcup = { date: eflcup, violations: microcycleViolations(state, eflcup) };
    }
    // FA컵 — 시계를 더 밀지 않고 **추첨된 그날** 본다
    const facup = ourTieDate(state, "facup", "r32");
    if (!out.facup.date && facup) {
      out.facup = {
        date: facup,
        gap: diffDays(state.date, facup),
        violations: microcycleViolations(state, facup),
      };
    }
    if (!checkpoints.has(day)) continue;
    // 아직 안 치른 우리 경기 — 컵 대진이 붙고 리그가 연기된 뒤의 모습이다
    for (const date of userMatchDates(state).filter((d) => d > state.date)) {
      out.sweep.violations.push(...microcycleViolations(state, date));
      out.sweep.checked++;
    }
  }
  sweepCache = out;
  return out;
}

describe("일정이 바뀌면 훈련도 따라 바뀐다", () => {
  /**
   * 컵 대진은 **경기일 몇 주 전에** 편성된다. 예전엔 "경기 수가 늘어난 tick"에서만
   * 재배치를 검사해서, 편성 시점엔 3주 창 밖이라 아무 일도 없고 날짜가 다가와도
   * 다시 볼 계기가 없었다 — 리그컵 경기일에 본훈련이 그대로 남고 다음날도 회복이
   * 아니었다.
   */
  it("리그컵 경기 앞뒤가 마이크로사이클을 따른다", () => {
    const { eflcup } = seasonSweep();
    expect(eflcup.date, "리그컵 1라운드 대진을 찾지 못했다").not.toBe("");
    expect(eflcup.violations).toEqual([]);
  }, 120_000);

  it("한참 뒤에 잡힌 대진도 추첨된 그날 바로 반영된다", () => {
    // FA컵 1라운드는 12월 초에 추첨돼 1월에 열린다 — 3주 창으로는 못 잡는 간격이다
    const { facup } = seasonSweep();
    expect(facup.date, "FA컵 1라운드 대진을 찾지 못했다").not.toBe("");
    expect(facup.gap, "추첨과 경기가 3주 안이면 이 테스트가 무의미하다").toBeGreaterThan(21);
    expect(facup.violations).toEqual([]);
  }, 120_000);

  it("시즌 어느 시점에 멈춰도 남은 경기 전부가 사이클을 지킨다", () => {
    const { sweep } = seasonSweep();
    expect(sweep.violations).toEqual([]);
    expect(sweep.checked, "검사한 경기가 없다").toBeGreaterThan(50);
  }, 120_000);

  it("경기가 연기되면 옮겨 간 날에 사이클이 새로 선다", () => {
    const state = createTestGame(7);
    advanceTime(state, { days: 40 }); // 개막 뒤로 시계를 민다
    /**
     * **비워진 날이 평일이고 옆에 경기가 없는** 경기를 고른다 — 그래야 "경기가
     * 빠지면 훈련이 돌아온다"를 아래에서 조건 없이 잴 수 있다. 조건을 `if`로
     * 감싸 두면 조건이 안 맞는 날이 뽑혔을 때 케이스가 조용히 사라진다.
     */
    const dates = userMatchDates(state);
    const match = state.matches.find((m) => {
      if (m.homeTeamId !== state.userTeamId && m.awayTeamId !== state.userTeamId) return false;
      if (m.date <= addDays(state.date, 14) || !isPostponable(state, m)) return false;
      const dow = new Date(`${m.date}T00:00:00Z`).getUTCDay();
      if (dow === 0 || dow === 6) return false;
      return !dates.some((d) => d !== m.date && Math.abs(diffDays(m.date, d)) <= 2);
    });
    expect(match, "옮길 수 있는 평일 단독 경기를 찾지 못했다").toBeDefined();
    const emptied = match!.date;

    expect(postponeMatch(state, match!)).toBe(true);
    expect(match!.date, "경기가 다른 날로 옮겨졌어야 한다").not.toBe(emptied);

    syncDefaultTraining(state);
    expectMicrocycle(state, match!.date); // 새 날짜에 사이클이 선다
    // 비워진 날은 평범한 하루로 돌아간다
    expect(trainingOn(state, emptied), `${emptied}: 경기가 빠졌으면 훈련이 돌아온다`).not.toEqual(
      [],
    );
  }, 60_000);
});

describe("기본 훈련의 대조는 이름이 아니라 id로 한다", () => {
  /**
   * 메뉴의 한국어 이름을 고치는 것은 표시의 변경이지 일정의 변경이 아니다.
   * 이름으로 대조하던 때는 문구 한 글자만 고쳐도 남은 시즌의 기본 훈련이 통째로
   * 다시 깔렸다 (season.md §4).
   */
  it("메뉴 이름만 바꾸면 아무것도 다시 깔지 않는다", () => {
    const state = createTestGame(3);
    syncDefaultTraining(state);
    const autos = state.trainingSessions.filter((t) => t.auto === true);
    expect(autos.length, "기본 훈련이 깔려 있지 않다").toBeGreaterThan(0);
    for (const session of autos) session.label = `${session.label} (문구 수정)`;
    const ids = autos.map((t) => t.id).sort();

    syncDefaultTraining(state);

    expect(
      state.trainingSessions
        .filter((t) => t.auto === true)
        .map((t) => t.id)
        .sort(),
      "이름을 고쳤다고 훈련이 다시 깔렸다",
    ).toEqual(ids);
    // 고친 이름이 그대로 남아 있다 = 그 세션이 지워지지 않았다
    expect(state.trainingSessions.find((t) => t.id === ids[0])?.label).toContain("문구 수정");
  });

  it("옛 세이브의 세션은 id가 없어 이름으로 대조한다 — 열자마자 다시 깔리지 않는다", () => {
    const state = createTestGame(3);
    syncDefaultTraining(state);
    const autos = state.trainingSessions.filter((t) => t.auto === true);
    // 카드가 들어오기 전에 저장된 세이브 — 이름만 있고 `menuId`가 없다
    for (const session of autos) delete session.menuId;
    const ids = autos.map((t) => t.id).sort();

    syncDefaultTraining(state);

    expect(
      state.trainingSessions
        .filter((t) => t.auto === true)
        .map((t) => t.id)
        .sort(),
      "옛 세이브의 기본 훈련이 통째로 다시 깔렸다",
    ).toEqual(ids);
  });
});

describe("경기일 훈련은 취소된다", () => {
  it("cancelTrainingOn은 그날 예정 훈련을 세션까지 지운다", () => {
    const state = createTestGame();
    const date = preseasonReturnDate(state.calendar.preseasonStart); // 소집일 (휴가 뒤 첫 훈련)
    expect(trainingOn(state, date).length).toBeGreaterThan(0);
    const before = state.trainingSessions.length;
    cancelTrainingOn(state, date);
    expect(trainingOn(state, date)).toHaveLength(0);
    expect(state.trainingSessions.length).toBeLessThan(before);
  });

  it("경기를 치르면 그날 훈련은 소화되지 않는다", () => {
    const state = createTestGame();
    advanceAndPlay(state);
    const played = state.date;
    expect(state.schedule.filter((e) => e.type === "training" && e.date === played)).toHaveLength(
      0,
    );
  });
});

/**
 * 여름 휴가 — **선수단이 없는 기간에는 훈련을 걸 수 없다.**
 * 예전엔 기본 훈련 배치만 이 날짜를 알아서, 감독의 지시는 아무도 없는 훈련장에
 * 세션을 깔았다 (모델이 부임 첫날 훈련을 잡으면 그대로 통과했다).
 */
describe("여름 휴가", () => {
  it("소집일이 캘린더에 데이터로 있다", () => {
    const state = createTestGame();
    expect(state.calendar.squadReturn).toBe(squadReturnOf(state.calendar));
    expect(onSummerBreak(state.calendar, state.date)).toBe(true);
    expect(onSummerBreak(state.calendar, squadReturnOf(state.calendar))).toBe(false);
  });

  it("휴가 중인 날짜를 콕 집으면 거부하고 소집일을 알려준다", () => {
    const state = createTestGame();
    const res = setTraining(state, {
      sessions: [{ date: addDays(state.date, 2), slot: "am", label: "체력", focus: ["stamina"] }],
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain(squadReturnOf(state.calendar));
  });

  it("요일 반복은 휴가를 건너뛰고 소집일부터 센다", () => {
    const state = createTestGame();
    const back = squadReturnOf(state.calendar);
    const res = setTraining(state, {
      repeatWeekly: [{ dow: 1, slot: "am", label: "슈팅 반복", focus: ["finishing"] }],
      weeks: 3,
    });
    expect(res.ok).toBe(true);
    const mine = new Set(
      state.trainingSessions.filter((s) => !s.auto && s.label === "슈팅 반복").map((s) => s.id),
    );
    const dates = state.schedule.filter((e) => mine.has(e.refId)).map((e) => e.date);
    expect(dates.length).toBe(3);
    for (const d of dates) expect(d >= back, `${d}는 휴가 기간이다`).toBe(true);
  });

  it("휴가를 접고 부를 수 있다 — 막지 않고 값을 물린다", () => {
    const state = createTestGame();
    const before = squadReturnOf(state.calendar);
    const day = addDays(state.date, 2);
    const first = () => userPlayers(state).filter((p) => p.squadLevel !== "reserve");
    const avg = () => first().reduce((s, p) => s + p.state.condition, 0) / first().length;
    const conditionBefore = avg();

    const res = setTraining(state, {
      sessions: [{ date: day, slot: "am", label: "복귀 훈련", focus: ["stamina"] }],
      recallSquad: true,
    });
    expect(res.ok).toBe(true);
    // 소집일 자체가 앞당겨진다 — 그 뒤로는 정상적으로 훈련을 잡을 수 있다
    expect(squadReturnOf(state.calendar)).toBe(day);
    expect(day < before).toBe(true);
    // 대가 ① 쉬지 못한 몸
    expect(avg()).toBeLessThan(conditionBefore);
    // 대가 ② 라커룸의 반발
    expect(state.issues.length).toBeGreaterThan(0);
    expect(state.issues[0]?.reason).toBe("early-return");
  });

  it("조기 소집 뒤에는 그 날짜부터 훈련이 자유롭다", () => {
    const state = createTestGame();
    const day = addDays(state.date, 2);
    setTraining(state, {
      sessions: [{ date: day, slot: "am", label: "복귀 훈련", focus: ["stamina"] }],
      recallSquad: true,
    });
    const next = addDays(day, 1);
    expect(
      setTraining(state, {
        sessions: [{ date: next, slot: "pm", label: "전술", focus: ["tactical"] }],
      }).ok,
    ).toBe(true);
  });

  it("반발은 리더십이 높을수록 작다", () => {
    const weak = createTestGame();
    const strong = createTestGame();
    weak.manager.attributes.leadership = 20;
    strong.manager.attributes.leadership = 95;
    const day = addDays(weak.date, 2);
    const recall = (s: typeof weak) =>
      setTraining(s, {
        sessions: [{ date: day, slot: "am", label: "복귀 훈련", focus: ["stamina"] }],
        recallSquad: true,
      });
    recall(weak);
    recall(strong);
    expect(strong.issues.length).toBeLessThanOrEqual(weak.issues.length);
  });

  /**
   * 지난 날짜는 휴가와 다른 이유로 막힌다 — tick이 이미 지나가 엔트리가 영영
   * "예정"으로 남고, 같은 날짜가 조기 소집으로 흘러가면 대가가 부풀려 매겨진다.
   */
  it("지난 날짜에는 훈련을 잡지 못하고, 반려된 호출은 소집일을 옮기지 않는다", () => {
    const state = createTestGame();
    const before = squadReturnOf(state.calendar);
    const past = addDays(state.date, -1);
    const res = setTraining(state, {
      sessions: [{ date: past, slot: "am", label: "복귀 훈련", focus: ["stamina"] }],
      recallSquad: true,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain(past);
    expect(res.message).toContain(state.date);
    // 검증이 승격보다 먼저다 — 반려하고 나서 소집일이 앞당겨져 있으면 대가만 남는다
    expect(squadReturnOf(state.calendar)).toBe(before);
    expect(state.issues.some((i) => i.reason === "early-return")).toBe(false);
  });

  it("소집일 이후는 그대로 잡힌다", () => {
    const state = createTestGame();
    const date = addDays(squadReturnOf(state.calendar), 2);
    expect(
      setTraining(state, { sessions: [{ date, slot: "am", label: "전술", focus: ["tactical"] }] })
        .ok,
    ).toBe(true);
  });
});
