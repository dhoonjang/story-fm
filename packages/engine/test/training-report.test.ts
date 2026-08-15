import { describe, expect, it } from "vitest";
import {
  TRAINING_ATTR_CAP,
  TACTIC_GAIN_MAX,
  TACTIC_GAIN_MIN,
  advanceTime,
  applyTrainingOutcomes,
  assignmentsOf,
  buildTrainingBrief,
  playerById,
  setTraining,
  userTactics,
  type GameState,
  type TrainedSession,
  type TrainingBrief,
} from "@story-fm/engine";
import { familiarityGainScale, tacticalUptake } from "@story-fm/domain";
import { afterSquadReturn, createTestGame } from "./helpers";

/**
 * 훈련 결산 — **적응도를 올리는 유일한 경로**다. 코어는 훈련 중에 아무것도 올리지
 * 않고, 훈련량이 시사하는 기준값만 계산해 판정으로 넘긴다.
 *
 * 여기서 검증하는 건 **LLM이 무엇을 못 하는가**다. 시즌에 수십 번 도는 이벤트라
 * 한 번에 게임을 크게 흔들 수 있으면 안 된다.
 */

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** 다음 날 오전에 훈련을 하나 걸고 하루 진행 — 브리프를 돌려준다 */
function trainOneDay(state: GameState, focus: string[], label = "훈련"): TrainingBrief | null {
  afterSquadReturn(state); // 휴가 중이면 훈련을 걸 수 없다
  const date = addDays(state.date, 1);
  setTraining(state, {
    sessions: [{ date, slot: "am", label, focus: focus as never }],
  });
  const from = state.date;
  const result = advanceTime(state, { days: 1 });
  return buildTrainingBrief(state, result.trained?.sessions ?? [], { from, to: state.date });
}

describe("훈련 결산 브리프", () => {
  it("advance_time이 지나간 훈련을 묶어서 내보낸다", () => {
    const state = createTestGame(7);
    const brief = trainOneDay(state, ["tactical"], "전술 조직 훈련");
    expect(brief, "훈련이 있었는데 브리프가 없다").not.toBeNull();
    expect(brief!.sessions.length).toBeGreaterThan(0);
    expect(brief!.sessions.some((s) => s.label === "전술 조직 훈련")).toBe(true);
    // 감독이 직접 지시한 세션은 기본 훈련과 구분된다 — 판정의 근거가 다르다
    expect(brief!.sessions.find((s) => s.label === "전술 조직 훈련")!.ordered).toBe(true);
    // 판정 대상 명단이 함께 실린다
    // 전술 훈련만 했으면 능력치를 올릴 축이 없다
    expect(brief!.trainedAxes).toHaveLength(0);
  });

  it("훈련이 없던 구간은 브리프가 없다 — 부를 이유가 없다", () => {
    const state = createTestGame(7);
    const brief = buildTrainingBrief(state, [] as TrainedSession[], {
      from: state.date,
      to: state.date,
    });
    expect(brief).toBeNull();
  });
});

describe("결과는 훈련 날짜별로 남는다", () => {
  it("판정을 한 번에 돌려도 성장 로그는 그날그날 찍힌다", () => {
    const state = afterSquadReturn(createTestGame(7));
    const days = [1, 2, 3].map((n) => addDays(state.date, n));
    setTraining(state, {
      sessions: days.map((date) => ({
        date,
        slot: "am" as const,
        label: "전술 조직 훈련",
        focus: ["tactical" as const],
      })),
    });
    const from = state.date;
    const result = advanceTime(state, { days: 3 });
    const brief = buildTrainingBrief(state, result.trained?.sessions ?? [], {
      from,
      to: state.date,
    })!;
    expect(brief.sessions.length, "사흘치 세션이 한 브리프에 묶인다").toBeGreaterThanOrEqual(3);
    // 세션마다 일정 엔트리를 가리킨다 — 성장 로그의 출처가 된다
    for (const s of brief.sessions) expect(s.entryId).toBeTruthy();

    // 대상이 둘 이상이어야 날짜가 갈린다 — 스쿼드가 바뀌면 명단 길이도 바뀐다
    expect(brief.subjects.length, "판정 대상이 둘 미만이다").toBeGreaterThan(1);
    const targets = brief.subjects.slice(0, 3);
    applyTrainingOutcomes(
      state,
      brief,
      targets.map((t, i) => ({
        playerId: t.playerId,
        tacticGain: 1,
        attribute: null,
        note: "",
        date: days[i % days.length]!,
      })),
    );

    // 판정은 마지막 날 한 번 돌았지만 기록은 세 날에 나뉜다
    const dates = new Set(state.growthLog.filter((g) => g.note === "훈련 결산").map((g) => g.date));
    expect(dates.size, "결과가 하루에 몰렸다").toBeGreaterThan(1);
    for (const d of dates) expect(days).toContain(d);
  });

  it("판정이 엉뚱한 날짜를 대면 마지막 훈련일로 떨어진다", () => {
    const state = createTestGame(7);
    const brief = trainOneDay(state, ["tactical"])!;
    const target = brief.subjects[0]!;
    applyTrainingOutcomes(state, brief, [
      { playerId: target.playerId, tacticGain: 1, attribute: null, note: "", date: "1999-01-01" },
    ]);
    const logged = state.growthLog.filter((g) => g.note === "훈련 결산");
    expect(logged.length).toBeGreaterThan(0);
    for (const g of logged) {
      expect(brief.sessions.map((x) => x.date)).toContain(g.date);
    }
  });
});

describe("성장은 곡선을 타고 쌓인다 — 판정 한 번이 곧 한 칸은 아니다", () => {
  it("전성기를 지난 선수는 판정 한 번으로 오르지 않는다 — 대신 쌓인다", () => {
    const state = createTestGame(7);
    const brief = trainOneDay(state, ["stamina"], "러닝")!;
    // 나이·수준·잠재력을 곡선이 확실히 깎는 자리에 놓는다
    const target = brief.subjects[0]!;
    const player = playerById(state, target.playerId)!;
    player.birthdate = `${Number(state.date.slice(0, 4)) - 30}-01-01`;
    player.attributes.stamina = 85;
    player.attributes.potential = 88;
    const before = player.attributes.stamina;

    applyTrainingOutcomes(state, brief, [
      {
        playerId: target.playerId,
        tacticGain: 0,
        attribute: "stamina",
        attributeStep: 1,
        note: "",
      },
    ]);
    expect(player.attributes.stamina, "서른 살이 한 번에 올랐다").toBe(before);
    // 다만 없던 일이 되지는 않는다 — 못 채운 몫이 남는다
    expect(player.growthCarry?.stamina ?? 0).toBeGreaterThan(0);

    // 같은 판정을 계속 받으면 언젠가는 한 칸이 된다
    for (let i = 0; i < 30 && player.attributes.stamina === before; i++) {
      applyTrainingOutcomes(state, brief, [
        {
          playerId: target.playerId,
          tacticGain: 0,
          attribute: "stamina",
          attributeStep: 1,
          note: "",
        },
      ]);
    }
    expect(player.attributes.stamina, "아무리 훈련해도 안 올랐다").toBe(before + 1);
    // 한 칸이 된 뒤에는 남은 몫만 들고 간다
    expect(player.growthCarry?.stamina ?? 0).toBeLessThan(1);
  });

  it("유망주는 판정 한 번에 한 칸 오른다", () => {
    const state = createTestGame(7);
    const brief = trainOneDay(state, ["stamina"], "러닝")!;
    const target = brief.subjects[0]!;
    const player = playerById(state, target.playerId)!;
    player.birthdate = `${Number(state.date.slice(0, 4)) - 18}-01-01`;
    player.attributes.stamina = 60;
    player.attributes.potential = 85;

    applyTrainingOutcomes(state, brief, [
      {
        playerId: target.playerId,
        tacticGain: 0,
        attribute: "stamina",
        attributeStep: 1,
        note: "",
      },
    ]);
    expect(player.attributes.stamina).toBe(61);
  });

  it("잠재력에 닿은 선수는 아무리 받아도 오르지 않는다", () => {
    const state = createTestGame(7);
    const brief = trainOneDay(state, ["stamina"], "러닝")!;
    const target = brief.subjects[0]!;
    const player = playerById(state, target.playerId)!;
    player.attributes.potential = player.attributes.stamina;
    const before = player.attributes.stamina;

    for (let i = 0; i < 20; i++) {
      applyTrainingOutcomes(state, brief, [
        {
          playerId: target.playerId,
          tacticGain: 0,
          attribute: "stamina",
          attributeStep: 1,
          note: "",
        },
      ]);
    }
    expect(player.attributes.stamina).toBe(before);
  });
});

describe("판정의 상한 — 한 번에 게임을 크게 흔들 수 없다", () => {
  it("전술 적응도 판정은 −1~3 중 하나로 접힌다", () => {
    const state = createTestGame(7);
    const brief = trainOneDay(state, ["tactical"])!;
    const target = brief.subjects[0]!;
    const famOf = () =>
      assignmentsOf(state, state.userTeamId).find((a) => a.playerId === target.playerId)!
        .familiarity;

    const before = famOf();
    applyTrainingOutcomes(state, brief, [
      { playerId: target.playerId, tacticGain: 99, attribute: null, note: "폭주" },
    ]);
    // 판정은 3까지만 접히고, 그 3도 지금 위치에 따라 깎여서 들어간다
    expect(famOf() - before, "상한을 넘었다").toBeLessThanOrEqual(TACTIC_GAIN_MAX);
    expect(famOf() - before, "아무것도 안 올랐다").toBeGreaterThan(0);

    // 아래로도 마찬가지 — 훈련이 늘 남기는 건 아니지만 폭은 −1이다
    const mid = famOf();
    applyTrainingOutcomes(state, brief, [
      { playerId: target.playerId, tacticGain: -99, attribute: null, note: "망침" },
    ]);
    // 내려가는 건 깎지 않는다 — 판정 그대로다
    expect(famOf() - mid, "하한을 넘었다").toBe(TACTIC_GAIN_MIN);
  });

  it("훈련하지 않은 축은 오르지 않는다", () => {
    const state = createTestGame(7);
    const brief = trainOneDay(state, ["stamina"], "러닝")!;
    const target = brief.subjects[0]!;
    const player = playerById(state, target.playerId)!;
    const before = player.attributes.finishing;

    // 러닝만 했는데 결정력을 올리려 들면 코어가 자른다
    applyTrainingOutcomes(state, brief, [
      { playerId: target.playerId, tacticGain: 0, attribute: "finishing", note: "슛이 좋았다" },
    ]);
    expect(player.attributes.finishing).toBe(before);
  });

  it("능력치는 구간당 몇 명까지만 — 전원에게 줄 수 없다", () => {
    const state = createTestGame(7);
    const brief = trainOneDay(state, ["stamina"], "러닝")!;
    const before = new Map(
      brief.subjects.map((s) => [s.playerId, playerById(state, s.playerId)!.attributes.stamina]),
    );

    // 모델이 전원에게 +1을 주려 해도
    applyTrainingOutcomes(
      state,
      brief,
      brief.subjects.map((s) => ({
        playerId: s.playerId,
        tacticGain: 0,
        attribute: "stamina" as const,
        attributeStep: 1,
        note: "잘 뛰었다",
      })),
    );
    const grown = brief.subjects.filter(
      (s) => playerById(state, s.playerId)!.attributes.stamina > (before.get(s.playerId) ?? 0),
    );
    expect(grown.length).toBeLessThanOrEqual(TRAINING_ATTR_CAP);
    // 오른 선수도 딱 1점이다
    for (const s of grown) {
      expect(playerById(state, s.playerId)!.attributes.stamina).toBe(
        (before.get(s.playerId) ?? 0) + 1,
      );
    }
  });

  it("명단 밖 선수는 무시한다 — 모델이 지어낸 id로 장부를 못 바꾼다", () => {
    const state = createTestGame(7);
    const brief = trainOneDay(state, ["stamina"], "러닝")!;
    const famBefore = userTactics(state).assignments.map((a) => a.familiarity);
    applyTrainingOutcomes(state, brief, [
      { playerId: "존재하지-않는-선수", tacticGain: 3, attribute: "stamina", note: "?" },
    ]);
    expect(userTactics(state).assignments.map((a) => a.familiarity)).toEqual(famBefore);
  });

  it("판정이 없으면 그 구간의 훈련은 아무것도 남기지 않는다", () => {
    const state = createTestGame(7);
    const before = assignmentsOf(state, state.userTeamId, "starting")[0]!.familiarity;
    const brief = trainOneDay(state, ["tactical"])!;
    // 결산을 부르지 않는다 (mock 모드·모델 실패와 같은 상황).
    // **코어는 훈련 중에 아무것도 올리지 않는다** — 상승은 판정만이 낸다
    const after = assignmentsOf(state, state.userTeamId, "starting")[0]!.familiarity;
    expect(after, "코어가 몰래 올렸다").toBe(before);
    // 다만 그 구간의 훈련은 판정 대상으로 넘어간다
    expect(brief.subjects.length).toBeGreaterThan(0);
  });

  it("판정이 오면 그때 그만큼 움직인다", () => {
    const state = createTestGame(7);
    const brief = trainOneDay(state, ["tactical"])!;
    const target = brief.subjects[0]!;
    const before = assignmentsOf(state, state.userTeamId).find(
      (a) => a.playerId === target.playerId,
    )!.familiarity;

    applyTrainingOutcomes(state, brief, [
      { playerId: target.playerId, tacticGain: 2, attribute: null, note: "" },
    ]);
    const after = assignmentsOf(state, state.userTeamId).find(
      (a) => a.playerId === target.playerId,
    )!.familiarity;
    // 판정 2가 그대로 들어오지는 않는다 — 지금 위치의 곡선과 그 선수의 흡수율만큼 깎인다
    const player = playerById(state, target.playerId)!;
    expect(after - before).toBeCloseTo(
      2 * familiarityGainScale(before, "training", tacticalUptake(player.attributes)),
      6,
    );
  });
});
