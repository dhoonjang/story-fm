import { describe, expect, it } from "vitest";
import {
  POSITION_TRAIN_MAX,
  TRAINING_ATTR_CAP,
  TACTIC_GAIN_MAX,
  TACTIC_GAIN_MIN,
  advanceTime,
  applyTrainingOutcomes,
  assignmentsOf,
  buildTrainingBrief,
  playerById,
  setPlayerTraining,
  setTraining,
  userTactics,
  type GameState,
  type TrainedSession,
  type TrainingBrief,
} from "@story-fm/engine";
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

/**
 * 다음 구간의 결산이 온 것으로 친다 — 반영 표식(`ScheduleEntry.settled`)을 지운다.
 * 한 브리프는 한 번만 반영되므로, 여러 결산에 걸쳐 쌓이는 곡선은 이걸 지나야 보인다.
 */
function nextSettlement(state: GameState, brief: TrainingBrief): TrainingBrief {
  for (const s of brief.sessions) {
    const entry = state.schedule.find((e) => e.id === s.entryId);
    if (entry) entry.settled = false;
  }
  return brief;
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
    const dates = new Set(
      state.growthLog.filter((g) => g.origin === "training-settlement").map((g) => g.date),
    );
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
    const logged = state.growthLog.filter((g) => g.origin === "training-settlement");
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

    // 같은 판정을 계속 받으면 언젠가는 한 칸이 된다 — 구간마다 결산이 하나씩 온다
    for (let i = 0; i < 30 && player.attributes.stamina === before; i++) {
      applyTrainingOutcomes(state, nextSettlement(state, brief), [
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
      applyTrainingOutcomes(state, nextSettlement(state, brief), [
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
    applyTrainingOutcomes(state, nextSettlement(state, brief), [
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

  it("적응도가 99에 닿은 자리는 전향 훈련이 장부에 아무것도 남기지 않는다", () => {
    const state = afterSquadReturn(createTestGame(7));
    const target = assignmentsOf(state, state.userTeamId, "starting")[0]!.playerId;
    const player = playerById(state, target)!;
    // 본업도 천장에 둬 전향 완료 판정이 끼어들지 않게 한다
    player.positions.find((p) => p.isNatural)!.proficiency = 99;
    const taken = new Set(player.positions.map((p) => p.position));
    const learned = ["ST", "CB", "LB", "RB", "CM"].find((p) => !taken.has(p))!;
    player.positions.push({ position: learned, proficiency: 99, isNatural: false });
    setPlayerTraining(state, { playerId: target, position: learned });

    const brief = trainOneDay(state, ["tactical"])!;
    const lines = applyTrainingOutcomes(state, brief, [
      { playerId: target, tacticGain: 0, attribute: null, positionGain: 2, note: "" },
    ]);
    // 아무것도 오르지 않았으면 성장 로그에도 요약에도 그렇게 적힌다
    expect(state.growthLog.filter((g) => g.target === `pos:${learned}`)).toHaveLength(0);
    expect(
      lines.some((l) => l.includes("적응 +")),
      "천장에서 적응 +N이 남았다",
    ).toBe(false);
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
});

describe("한 결산은 장부를 한 번만 움직인다", () => {
  /** 픽스처는 describe당 하나 — 두 케이스가 각자 하루씩 훈련을 쌓아 쓴다 */
  const state = afterSquadReturn(createTestGame(7));

  it("같은 선수가 두 행으로 오면 첫 행만 받는다", () => {
    const brief = trainOneDay(state, ["stamina"], "러닝")!;
    const target = brief.subjects[0]!.playerId;
    const player = playerById(state, target)!;
    // 곡선이 확실히 한 칸을 내주는 자리 — 두 행이 다 들어가면 두 칸이 오른다
    player.birthdate = `${Number(state.date.slice(0, 4)) - 18}-01-01`;
    player.attributes.stamina = 60;
    player.attributes.potential = 85;
    // 적응도도 눈금을 확실히 넘는 자리에 세운다 — 소수로만 움직이면 장부에 안 남는다
    assignmentsOf(state, state.userTeamId).find((a) => a.playerId === target)!.familiarity = 30;
    const row = {
      playerId: target,
      tacticGain: TACTIC_GAIN_MAX,
      attribute: "stamina" as const,
      attributeStep: 1,
      note: "",
    };

    applyTrainingOutcomes(state, brief, [row, row]);

    expect(player.attributes.stamina, "같은 선수가 능력치를 두 번 가져갔다").toBe(61);
    const logged = state.growthLog.filter(
      (g) =>
        g.gamePlayerId === target && g.target === "tactical" && g.origin === "training-settlement",
    );
    expect(logged, "적응도가 행 수만큼 쌓였다").toHaveLength(1);
  });

  it("같은 브리프를 두 번 반영해도 장부는 한 번만 움직인다", () => {
    const brief = trainOneDay(state, ["stamina"], "러닝")!;
    const assignment = assignmentsOf(state, state.userTeamId, "starting")[0]!;
    const target = assignment.playerId;
    const player = playerById(state, target)!;
    player.birthdate = `${Number(state.date.slice(0, 4)) - 18}-01-01`;
    player.attributes.stamina = 60;
    player.attributes.potential = 85;
    assignment.familiarity = 30;
    // 본업이 새 자리보다 높아야 전향 완료 판정이 끼어들지 않는다
    player.positions.find((p) => p.isNatural)!.proficiency = 90;
    const taken = new Set(player.positions.map((p) => p.position));
    const learned = ["ST", "CB", "LB", "RB", "CM"].find((p) => !taken.has(p))!;
    player.positions.push({ position: learned, proficiency: 40, isNatural: false });
    setPlayerTraining(state, { playerId: target, position: learned });

    const outcome = {
      playerId: target,
      tacticGain: TACTIC_GAIN_MAX,
      attribute: "stamina" as const,
      attributeStep: 1,
      positionGain: POSITION_TRAIN_MAX,
      note: "",
    };
    const posOf = () => player.positions.find((p) => p.position === learned)!.proficiency;
    const famOf = () =>
      assignmentsOf(state, state.userTeamId).find((a) => a.playerId === target)!.familiarity;

    applyTrainingOutcomes(state, brief, [outcome]);
    const after = { fam: famOf(), pos: posOf(), stamina: player.attributes.stamina };
    expect(after.fam, "첫 결산이 적응도를 안 움직였다").toBeGreaterThan(30);
    expect(after.pos).toBe(40 + POSITION_TRAIN_MAX);
    expect(after.stamina).toBe(61);

    // 도구 루프가 같은 결산을 다시 제출한다 (docs/llm/agents.md §4)
    expect(
      applyTrainingOutcomes(state, brief, [outcome]),
      "두 번째 반영이 장부를 건드렸다",
    ).toEqual([]);
    expect(famOf(), "적응도가 두 번 반영됐다").toBe(after.fam);
    expect(posOf(), "자리 적응도가 두 번 반영됐다").toBe(after.pos);
    expect(player.attributes.stamina, "능력치가 두 번 반영됐다").toBe(after.stamina);
  });
});

describe("대상은 그 구간을 팀과 함께 보낸 선수다", () => {
  it("부상·정지 선수는 판정 대상이 아니다", () => {
    const state = afterSquadReturn(createTestGame(7));
    const starting = assignmentsOf(state, state.userTeamId, "starting");
    const hurt = starting[0]!.playerId;
    const banned = starting[1]!.playerId;
    state.injuries.push({
      id: "inj-training-report",
      gamePlayerId: hurt,
      bodyPart: "햄스트링",
      severity: "moderate",
      cause: "training",
      occurredOn: state.date,
      expectedReturn: addDays(state.date, 60),
      returnedOn: null,
    });
    state.suspensions.push({
      id: "sus-training-report",
      gamePlayerId: banned,
      cause: "red",
      issuedOn: state.date,
      lengthMatches: 2,
      served: 0,
      status: "active",
    });

    const brief = trainOneDay(state, ["stamina"], "러닝")!;
    const ids = new Set(brief.subjects.map((s) => s.playerId));
    expect(ids.has(hurt), "재활 중인 선수가 판정 대상에 있다").toBe(false);
    expect(ids.has(banned), "출장 정지 선수가 판정 대상에 있다").toBe(false);
    expect(ids.size, "대상이 통째로 비었다").toBeGreaterThan(0);
  });
});

describe("개인 훈련 축은 걸어 둔 선수에게만 열린다", () => {
  it("팀이 하지 않은 축도 개인 훈련이 걸린 선수는 오른다", () => {
    const state = afterSquadReturn(createTestGame(7));
    const starting = assignmentsOf(state, state.userTeamId, "starting");
    const target = starting[0]!.playerId;
    const other = starting[1]!.playerId;
    setPlayerTraining(state, { playerId: target, axis: "finishing" });

    // 팀은 러닝만 했다 — 결정력은 팀 세션에 없는 축이다
    const brief = trainOneDay(state, ["stamina"], "러닝")!;
    expect(brief.trainedAxes, "판정자에게 후보 축으로 보이지 않는다").toContain("finishing");

    // 둘 다 자랄 자리를 만들어 둔다 — 여기서 가르는 건 곡선이 아니라 허용 축이다
    for (const id of [target, other]) {
      const p = playerById(state, id)!;
      p.birthdate = `${Number(state.date.slice(0, 4)) - 18}-01-01`;
      p.attributes.finishing = 60;
      p.attributes.potential = 85;
    }

    applyTrainingOutcomes(
      state,
      brief,
      [target, other].map((playerId) => ({
        playerId,
        tacticGain: 0,
        attribute: "finishing" as const,
        attributeStep: 1,
        note: "슈팅을 따로 봤다",
      })),
    );

    expect(
      playerById(state, target)!.attributes.finishing,
      "개인 훈련 축이 장부에 닿지 않는다",
    ).toBe(61);
    expect(
      playerById(state, other)!.attributes.finishing,
      "남에게 걸린 개인 훈련 축이 전원에게 열렸다",
    ).toBe(60);
  });
});

/**
 * 전향 훈련 — **자리는 판정으로만 오르고, 새 자리가 본업을 넘으면 거기서 끝난다.**
 * 코어가 날짜를 세어 올리던 자리를 결산에 넘긴 뒤, 상한과 완료 전이가 이 경로의
 * 유일한 문이다 (player.md §8).
 */
describe("전향 훈련 — 상한과 완료 전이", () => {
  /** 픽스처는 describe당 하나 — 두 케이스가 각자 다른 선수를 골라 쓴다 */
  const state = afterSquadReturn(createTestGame(7));

  /** 이 선수가 아직 안 가진 자리 하나 */
  const freshPosition = (positions: ReadonlyArray<{ position: string }>) => {
    const taken = new Set(positions.map((p) => p.position));
    return ["ST", "CB", "LB", "RB", "CM"].find((p) => !taken.has(p))!;
  };

  it("판정이 폭주해도 한 결산에 두 칸까지고, 음수는 자리를 깎지 않는다", () => {
    const target = assignmentsOf(state, state.userTeamId, "starting")[0]!.playerId;
    const player = playerById(state, target)!;
    // 본업을 위에 둬 완료 전이가 끼어들지 않게 한다
    player.positions.find((p) => p.isNatural)!.proficiency = 90;
    const learned = freshPosition(player.positions);
    player.positions.push({ position: learned, proficiency: 40, isNatural: false });
    setPlayerTraining(state, { playerId: target, position: learned });
    const posOf = () => player.positions.find((p) => p.position === learned)!.proficiency;

    const brief = trainOneDay(state, ["tactical"])!;
    applyTrainingOutcomes(state, brief, [
      { playerId: target, tacticGain: 0, attribute: null, positionGain: 99, note: "" },
    ]);
    expect(posOf(), "상한을 넘었다").toBe(40 + POSITION_TRAIN_MAX);

    // 아래로는 문이 없다 — 훈련이 자리를 되돌리지는 않는다
    applyTrainingOutcomes(state, nextSettlement(state, brief), [
      { playerId: target, tacticGain: 0, attribute: null, positionGain: -5, note: "" },
    ]);
    expect(posOf(), "음수 판정이 자리를 깎았다").toBe(40 + POSITION_TRAIN_MAX);
    expect(
      state.growthLog.filter((g) => g.gamePlayerId === target && g.target === `pos:${learned}`),
    ).toHaveLength(1);
  });

  it("새 자리가 본업을 넘어서면 본업이 바뀌고 개인 훈련이 걷힌다", () => {
    const target = assignmentsOf(state, state.userTeamId, "starting")[1]!.playerId;
    const player = playerById(state, target)!;
    player.positions.find((p) => p.isNatural)!.proficiency = 90;
    const learned = freshPosition(player.positions);
    // 본업 바로 아래 — 이번 결산의 두 칸이 경계를 넘긴다
    player.positions.push({ position: learned, proficiency: 89, isNatural: false });
    setPlayerTraining(state, { playerId: target, position: learned });

    const brief = trainOneDay(state, ["tactical"])!;
    applyTrainingOutcomes(state, brief, [
      {
        playerId: target,
        tacticGain: 0,
        attribute: null,
        positionGain: POSITION_TRAIN_MAX,
        note: "",
      },
    ]);

    expect(player.positions.find((p) => p.position === learned)!.proficiency).toBe(91);
    expect(player.positions.find((p) => p.isNatural)!.position, "본업이 안 넘어갔다").toBe(learned);
    expect(
      state.playerTraining.some((t) => t.gamePlayerId === target),
      "전향이 끝났는데 개인 훈련이 남았다",
    ).toBe(false);
  });
});
