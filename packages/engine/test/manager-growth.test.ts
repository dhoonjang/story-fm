import { describe, expect, it } from "vitest";
import {
  TRAINING_ATTR_CAP,
  TRAINING_ATTR_CAP_MIN,
  TRAINING_XP_PER_SESSION,
  acceptDeal,
  advanceTime,
  applyTrainingOutcomes,
  assignmentsOf,
  buildTrainingBrief,
  cancelTrainingOn,
  financeOf,
  managerTrainingUptake,
  openNegotiationFor,
  pendingOffer,
  playerById,
  playersOf,
  respondOffer,
  scoutPlayer,
  sendOffer,
  setTraining,
  suggestTerms,
  askingPriceFor,
  wageExpectationOf,
  trainingAttrCap,
  type GameState,
  type TrainingBrief,
} from "@story-fm/engine";
import { MANAGER_ATTRIBUTES, SCOUT_DAYS, type ManagerAttributes } from "@story-fm/domain";
import { afterSquadReturn, completeDeal, createTestGame } from "./helpers";

/**
 * 감독은 쓰는 만큼 자란다 (docs/simulation/career.md §3).
 *
 * 여기서 고정하는 것은 셋이다:
 *   ① 훈련 축이 훈련 결산에 **실제로 걸린다** — 같은 판정이 감독에 따라 다른 결과를 남긴다
 *   ② 협상 타결·스카우트 보고서·훈련 세션이 각각 제 축의 XP를 올린다
 *   ③ 훈련 XP는 **세션 수**의 함수이고 그것을 주는 것은 결산이 아니라 코어다 —
 *      결산이 없어도 붙고, 결산이 두 번 와도 늘지 않고, 시간을 쪼개도 총합이 같다
 */

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** 축이 오르면 XP가 100씩 깎여 나가므로, 총 획득량은 둘을 합쳐야 보인다 */
function totalXP(state: GameState, axis: keyof ManagerAttributes, base: number): number {
  return state.managerXP[axis] + (state.manager.attributes[axis] - base) * 100;
}

function setManagerAxis(state: GameState, axis: keyof ManagerAttributes, value: number): void {
  state.manager.attributes[axis] = value;
}

/** 다음 날 오전에 훈련을 하나 걸고 하루 진행 — 브리프를 돌려준다 */
function trainOneDay(state: GameState, focus: string[], label = "훈련"): TrainingBrief {
  afterSquadReturn(state);
  const date = addDays(state.date, 1);
  setTraining(state, { sessions: [{ date, slot: "am", label, focus: focus as never }] });
  const from = state.date;
  const result = advanceTime(state, { days: 1 });
  const brief = buildTrainingBrief(state, result.trained?.sessions ?? [], {
    from,
    to: state.date,
  });
  if (!brief) throw new Error("훈련 브리프가 없다");
  return brief;
}

describe("훈련 축이 훈련 결산에 걸린다", () => {
  it("계수는 흡수율이라 1을 넘지 않는다 — 감독은 판정 밴드를 뚫지 못한다", () => {
    expect(managerTrainingUptake(0)).toBeCloseTo(0.75, 6);
    expect(managerTrainingUptake(99)).toBeCloseTo(1, 6);
    for (const axis of [0, 20, 50, 90, 99]) {
      expect(managerTrainingUptake(axis)).toBeGreaterThan(0);
      expect(managerTrainingUptake(axis)).toBeLessThanOrEqual(1);
    }
  });

  it("같은 판정에서 훈련 축이 높은 감독이 적응도를 더 남긴다", () => {
    const build = (training: number) => {
      const state = createTestGame(7);
      setManagerAxis(state, "training", training);
      const brief = trainOneDay(state, ["tactical"], "전술 조직 훈련");
      const target = brief.subjects[0]!;
      const famOf = () =>
        assignmentsOf(state, state.userTeamId).find((a) => a.playerId === target.playerId)!
          .familiarity;
      const before = famOf();
      applyTrainingOutcomes(state, brief, [
        { playerId: target.playerId, tacticGain: 3, attribute: null, note: "" },
      ]);
      return famOf() - before;
    };

    const poor = build(10);
    const great = build(95);
    expect(poor, "형편없는 감독도 아무것도 못 남기지는 않는다").toBeGreaterThan(0);
    expect(great, "훈련 축이 결산에 걸리지 않는다").toBeGreaterThan(poor);
  });

  it("하락은 감독이 건드리지 않는다 — 나쁜 감독 밑에서 덜 흐트러지면 거꾸로다", () => {
    const decline = (training: number) => {
      const state = createTestGame(7);
      setManagerAxis(state, "training", training);
      const brief = trainOneDay(state, ["tactical"], "전술 조직 훈련");
      const target = brief.subjects[0]!;
      const famOf = () =>
        assignmentsOf(state, state.userTeamId).find((a) => a.playerId === target.playerId)!
          .familiarity;
      const before = famOf();
      applyTrainingOutcomes(state, brief, [
        { playerId: target.playerId, tacticGain: -1, attribute: null, note: "" },
      ]);
      return famOf() - before;
    };
    expect(decline(10)).toBeCloseTo(decline(95), 9);
  });

  it("한 결산이 능력치를 남기는 인원은 훈련 축이 정한다 — 3~6", () => {
    expect(trainingAttrCap(0)).toBe(TRAINING_ATTR_CAP_MIN);
    expect(trainingAttrCap(99)).toBe(TRAINING_ATTR_CAP);

    /**
     * 성장 곡선(`growthCarry`)이 섞이지 않게 전원을 "한 칸 직전"에 세워 둔다 —
     * 그러면 실제로 움직이는 인원이 곧 상한이다.
     */
    const movers = (training: number) => {
      const state = createTestGame(7);
      setManagerAxis(state, "training", training);
      const brief = trainOneDay(state, ["stamina"], "러닝");
      const before = new Map<string, number>();
      for (const s of brief.subjects) {
        const player = playerById(state, s.playerId)!;
        player.attributes.potential = 99;
        player.growthCarry = { ...(player.growthCarry ?? {}), stamina: 0.99 };
        before.set(s.playerId, player.attributes.stamina);
      }
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
      return brief.subjects.filter(
        (s) => playerById(state, s.playerId)!.attributes.stamina > before.get(s.playerId)!,
      ).length;
    };

    expect(movers(10)).toBe(TRAINING_ATTR_CAP_MIN);
    expect(movers(99)).toBe(TRAINING_ATTR_CAP);
  });
});

describe("쓰는 만큼 오른다 — 세 축이 각자 자란다", () => {
  it("훈련 XP는 결산이 아니라 코어가 준다 — 세션 수 × 0.5", () => {
    const state = createTestGame(7);
    const brief = trainOneDay(state, ["stamina"], "러닝");
    const earned = brief.sessions.length * TRAINING_XP_PER_SESSION;
    /**
     * 결산은 아직 오지 않았다 — mock 모드나 예산 상한이면 영영 오지 않는다.
     * 그래도 훈련장은 감독을 길렀어야 한다 (docs/simulation/career.md §3).
     */
    expect(state.managerXP.training, "결산 없는 구간의 훈련이 감독을 안 길렀다").toBeCloseTo(
      earned,
      9,
    );
    // 다른 축은 훈련장에서 자라지 않는다
    for (const axis of MANAGER_ATTRIBUTES) {
      if (axis !== "training") expect(state.managerXP[axis]).toBe(0);
    }

    // 도구 루프가 같은 결산을 두 번 제출해도 XP는 그대로다 (docs/llm/agents.md §4)
    applyTrainingOutcomes(state, brief, []);
    applyTrainingOutcomes(state, brief, []);
    expect(state.managerXP.training, "결산이 XP를 또 줬다").toBeCloseTo(earned, 9);

    // 소수로 쌓인다 — 반올림하면 세션 하나가 통째로 사라지거나 두 배가 된다
    const before = state.managerXP.training;
    const date = addDays(state.date, 1);
    cancelTrainingOn(state, date); // 그날 훈련을 정확히 하나로 만든다
    setTraining(state, {
      sessions: [{ date, slot: "am", label: "러닝", focus: ["stamina"] as never }],
    });
    const solo = advanceTime(state, { days: 1 });
    expect(solo.trained?.sessions, "그날 훈련이 하나가 아니다").toHaveLength(1);
    expect(state.managerXP.training - before).toBe(TRAINING_XP_PER_SESSION);
  });

  it("시간을 쪼개도 훈련 XP 총합은 같다 — 결산 횟수가 아니라 세션 수다", () => {
    /** 하루씩 N번 진행하며 매번 결산까지 반영한다 — 결산 횟수가 갈리는 자리다 */
    const run = (step: number, days: number) => {
      const state = createTestGame(11);
      afterSquadReturn(state);
      let consumed = 0;
      let sessions = 0;
      while (consumed < days) {
        const chunk = Math.min(step, days - consumed);
        const from = state.date;
        const result = advanceTime(state, { days: chunk });
        const moved = Math.round(
          (Date.parse(`${state.date}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
        );
        const brief = buildTrainingBrief(state, result.trained?.sessions ?? [], {
          from,
          to: state.date,
        });
        if (brief) {
          sessions += brief.sessions.length;
          applyTrainingOutcomes(state, brief, []);
        }
        if (moved <= 0) break;
        consumed += moved;
      }
      return { xp: state.managerXP.training, sessions, days: consumed };
    };

    const whole = run(6, 6);
    const split = run(1, 6);
    expect(split.days, "두 진행이 같은 날짜를 소화하지 않았다").toBe(whole.days);
    expect(split.sessions, "세션 수가 갈렸다").toBe(whole.sessions);
    expect(whole.sessions).toBeGreaterThan(0);
    // 하루씩 쪼개 결산을 여섯 번 돌려도 XP는 불어나지 않는다
    expect(split.xp).toBeCloseTo(whole.xp, 9);
  });

  it("영입 타결이 협상 축의 XP를 올린다 — 오퍼가 아니라 타결에만", () => {
    const state = createTestGame(42);
    const budget = financeOf(state, state.userTeamId).transferBudget;
    const player = state.players.find((p) => {
      if (p.teamId === state.userTeamId) return false;
      const terms = suggestTerms(state, p.id);
      return terms !== null && terms.fee > 1_000_000 && terms.fee < budget * 0.6;
    })!;
    const terms = {
      playerId: player.id,
      fee: Math.round(askingPriceFor(state, player) * 1.1),
      weeklyWage: wageExpectationOf(state, player),
      years: 4,
    };
    expect(sendOffer(state, terms).ok).toBe(true);
    // 오퍼를 넣은 것만으로는 아무것도 오르지 않는다
    expect(state.managerXP.negotiation).toBe(0);

    const negotiation = openNegotiationFor(state, player.id)!;
    state.date = pendingOffer(negotiation)!.respondsOn!;
    expect(respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" }).ok).toBe(true);
    // 합의도 타결이 아니다 — 메디컬을 지나야 장부가 움직인다
    expect(acceptDeal(state, negotiation.id).ok).toBe(true);
    expect(state.managerXP.negotiation).toBe(0);

    const base = state.manager.attributes.negotiation;
    const done = completeDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    expect(negotiation.status).toBe("completed");
    expect(totalXP(state, "negotiation", base), "영입 타결이 협상을 기르지 않는다").toBe(15);
  });

  it("스카우트 보고서가 도착하면 분석 축의 XP가 오른다", () => {
    const state = createTestGame(42);
    const target = playersOf(state, "chelsea")[0]!;
    expect(scoutPlayer(state, target.id).ok).toBe(true);
    // 파견만으로는 오르지 않는다
    expect(state.managerXP.analysis).toBe(0);

    const base = state.manager.attributes.analysis;
    advanceTime(state, { days: SCOUT_DAYS });
    expect(state.scoutReports.some((r) => r.completedOn !== null)).toBe(true);
    expect(totalXP(state, "analysis", base), "보고서가 감독의 눈을 기르지 않는다").toBe(8);
  });
});
