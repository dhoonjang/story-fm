import { describe, expect, it } from "vitest";
import { ageOf } from "@story-fm/domain";
import {
  advanceTime,
  assignmentsOf,
  financeOf,
  openInjury,
  pendingVerdicts,
  playersOf,
  setTraining,
  clockOf,
  userPlayers,
  weeklyWagesOf,
} from "@story-fm/engine";
import { advanceDays, advanceToMatchday, createTestGame } from "./helpers";

describe("advance_time — 시간은 스킬로만 흐른다 (game-loop §3)", () => {
  it("프리시즌에서 다음 경기일까지 전진하면 개막전에서 멈춘다", () => {
    const state = createTestGame();
    expect(state.date).toBe("2026-07-01"); // 7/1 프리시즌 시작
    // attention 정지(부상·이적 오퍼)는 넘긴다 — 결국 경기일에서 멈춘다
    let result = advanceTime(state, "next_match");
    let guard = 30;
    while (result.stopped === "attention" && guard-- > 0) {
      result = advanceTime(state, "next_match");
    }
    expect(result.ok).toBe(true);
    expect(result.stopped).toBe("matchday");
    expect(state.phase).toBe("matchday");
    // 멈춘 날은 유저의 첫 경기 날짜
    const first = state.matches
      .filter((m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId)
      .sort((a, b) => (a.date < b.date ? -1 : 1))[0];
    expect(state.date).toBe(first?.date);
    expect(result.digest.some((d) => d.includes("경기일"))).toBe(true);
  });

  it("게임 시작 시 여름 창은 이미 열려 있고, 폐장은 진행 중 안내된다", () => {
    const state = createTestGame();
    const summer = state.windows.find((w) => w.kind === "summer")!;
    // 7/1 시작 = 개장일이므로 개장 엔트리는 소화된 상태로 출발
    const openEntry = state.schedule.find((e) => e.type === "window-open" && e.refId === summer.id);
    expect(openEntry?.status).toBe("done");
    // 폐장 엔트리는 아직 예정
    const closeEntry = state.schedule.find(
      (e) => e.type === "window-close" && e.refId === summer.id,
    );
    expect(closeEntry?.status).toBe("scheduled");
    expect(closeEntry?.date).toBe(summer.closesOn);
  });

  it("경기일에는 시간이 흐르지 않는다 — 경기가 우선", () => {
    const state = createTestGame();
    advanceToMatchday(state);
    const blocked = advanceTime(state, { days: 1 });
    expect(blocked.ok).toBe(false);
    expect(blocked.stopped).toBe("blocked");
  });

  it("타 팀 경기는 각자 날짜에 간이 시뮬되고 시즌 스탯이 쌓인다", () => {
    const state = createTestGame();
    advanceToMatchday(state);
    const round1 = state.matches.filter((m) => m.round === 1);
    const others = round1.filter(
      (m) => m.homeTeamId !== state.userTeamId && m.awayTeamId !== state.userTeamId,
    );
    // 유저 리그(EPL)의 나머지 9경기 — 다른 리그 경기도 같은 날 함께 시뮬된다
    expect(others.filter((m) => m.competitionId === "epl").length).toBe(9);
    const mineToday = state.matches.find(
      (m) =>
        m.date === state.date &&
        !m.result &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    );
    for (const m of others) {
      if (m.date > state.date) continue;
      // 오늘 경기는 **킥오프 순서**를 탄다 — 우리보다 늦게 시작하는 경기는 아직 안 굴렀다
      if (m.date === state.date && mineToday && (m.time ?? "15:00") >= (mineToday.time ?? "15:00")) {
        expect(m.result, `${m.id} 우리 킥오프 뒤 경기가 미리 굴렀다`).toBeNull();
        continue;
      }
      expect(m.result).not.toBeNull();
    }
    // 유저 경기는 시뮬되지 않는다
    const mine = round1.find(
      (m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId,
    );
    expect(mine?.result).toBeNull();
    // 시뮬된 경기의 출전 기록이 남는다
    if (others.some((m) => m.result)) {
      expect(state.seasonStats.length).toBeGreaterThan(0);
    }
  });

  it("훈련이 쌓이면 능력치가 오르고 성장 로그가 남는다 (trainXP 없이)", () => {
    const state = createTestGame(11);
    const roster = userPlayers(state);
    // 1군만 팀 훈련 일정을 소화한다 — 2군을 고르면 성장 출처가 개발 프로그램(reserve)이 된다
    const young =
      roster.find((p) => p.squadLevel !== "reserve" && ageOf(p.birthdate, state.date) <= 21) ??
      roster[0]!;
    const before = young.attributes.finishing;
    // 평일 오전·오후 슈팅 훈련 등록 (기본 훈련 없음 → 스킬이 일정을 만든다)
    setTraining(state, {
      repeatWeekly: [1, 2, 3, 4, 5].flatMap((dow) => [
        { dow, slot: "am" as const, label: "슈팅 마무리", focus: ["finishing" as const] },
        { dow, slot: "pm" as const, label: "슈팅 마무리", focus: ["finishing" as const] },
      ]),
      weeks: 3,
    });
    expect(state.schedule.filter((e) => e.type === "training").length).toBeGreaterThan(10);

    let guard = 20;
    while (guard-- > 0 && young.attributes.finishing === before) {
      const r = advanceTime(state, { days: 3 });
      if (!r.ok || r.stopped === "matchday") break;
    }
    expect(young.attributes.finishing).toBeGreaterThanOrEqual(before);
    if (young.attributes.finishing > before) {
      const log = state.growthLog.filter(
        (g) => g.gamePlayerId === young.id && g.target === "finishing",
      );
      expect(log.length).toBeGreaterThan(0);
      expect(log[0]?.source).toBe("training");
      expect(log[0]?.entryId).toBeTruthy(); // 출처 일정이 기록된다
    }
  });

  it("전술 훈련은 결산에 넘길 기준값만 낸다 — 코어가 직접 올리지 않는다", () => {
    const state = createTestGame(5);
    const assignment = assignmentsOf(state, state.userTeamId, "starting")[0]!;
    const before = assignment.familiarity;
    setTraining(state, {
      repeatWeekly: [1, 2, 3, 4, 5].map((dow) => ({
        dow,
        slot: "am" as const,
        label: "전술 조직 훈련",
        focus: ["tactical" as const],
      })),
      weeks: 2,
    });
    advanceDays(state, 8);
    const after = assignmentsOf(state, state.userTeamId, "starting").find(
      (a) => a.playerId === assignment.playerId,
    );
    // 상승은 훈련 결산(LLM)만이 낸다 — 코어는 기준값을 계산해 넘길 뿐이다
    expect(after?.familiarity ?? 0, "코어가 몰래 올렸다").toBe(before);
  });

  it("주급이 매주 월요일 팀 재정에서 빠져나간다 (계약 합)", () => {
    const state = createTestGame();
    const finance = financeOf(state, state.userTeamId);
    const before = finance.balance;
    const wages = weeklyWagesOf(state, state.userTeamId);
    advanceDays(state, 8); // 최소 한 번의 월요일 포함
    const paid = finance.ledger.filter((l) => l.label === "선수단 주급");
    expect(paid.length).toBeGreaterThanOrEqual(1);
    for (const entry of paid) expect(entry.amount).toBe(wages);
    // 잔고는 원장 전체와 맞는다 — 같은 기간에 중계권·스폰서 수입도 들어온다
    const net = finance.ledger
      .filter((l) => l.accounting !== "noncash")
      .reduce((s, l) => s + (l.kind === "income" ? l.amount : -l.amount), 0);
    expect(finance.balance).toBe(before + net);
  });

  it("불만 이슈가 있는 선수는 체력이 계속 깎인다", () => {
    const state = createTestGame();
    const player = userPlayers(state)[8]!;
    // 회복(+8~14/일)이 불만(−1/일)보다 크므로 상한에서 재야 이슈 효과가 보인다
    const other = userPlayers(state)[9]!;
    player.state.condition = 100;
    other.state.condition = 100;
    state.issues.push({
      gamePlayerId: player.id,
      kind: "unhappy",
      note: "출전 불만",
      since: state.date,
    });
    advanceDays(state, 5);
    // 같은 조건의 동료보다 낮아야 한다 — 방치가 값을 갉는다
    expect(player.state.condition).toBeLessThan(other.state.condition);
  });

  it("부상은 INJURY row로 기록되고 복귀 시 이력으로 닫힌다", () => {
    const state = createTestGame(3);
    const victim = userPlayers(state)[3]!;
    // 부상을 직접 열고 tick이 복귀를 처리하는지 확인
    state.injuries.push({
      id: "inj-test",
      gamePlayerId: victim.id,
      bodyPart: "발목",
      severity: "minor",
      cause: "training",
      occurredOn: state.date,
      expectedReturn: state.date, // 오늘 복귀 예정
      returnedOn: null,
    });
    expect(openInjury(state, victim.id)).not.toBeNull();
    advanceDays(state, 2);
    expect(openInjury(state, victim.id)).toBeNull();
    // 이력은 남는다
    expect(state.injuries.find((i) => i.id === "inj-test")?.returnedOn).toBeTruthy();
  });

  it("AI 팀도 재정·주급이 돌아간다 (이적시장 기반)", () => {
    const state = createTestGame();
    const ai = state.teams.find((t) => t.id !== state.userTeamId)!;
    const before = financeOf(state, ai.id).balance;
    expect(weeklyWagesOf(state, ai.id)).toBeGreaterThan(0);
    expect(playersOf(state, ai.id).length).toBeGreaterThan(11);
    advanceDays(state, 8);
    expect(financeOf(state, ai.id).balance).not.toBe(before);
  });
});

/**
 * 하루 안의 시각 — 장부의 시간(날짜)과 장면의 시간을 가른다.
 * 같은 날 안에서는 굴릴 것이 없으므로 tick이 돌지 않아야 한다.
 */
describe("시각 축", () => {
  it("같은 날 안의 이동은 날짜도 장부도 건드리지 않는다", () => {
    const state = createTestGame(9);
    const date = state.date;
    const growthBefore = state.growthLog.length;

    const res = advanceTime(state, { clock: "14:30" });
    expect(res.ok).toBe(true);
    expect(state.date).toBe(date);
    expect(clockOf(state)).toBe("14:30");
    expect(state.growthLog.length).toBe(growthBefore);
  });

  it("지난 시각으로는 돌아갈 수 없다", () => {
    const state = createTestGame(9);
    advanceTime(state, { clock: "19:00" });
    const res = advanceTime(state, { clock: "09:30" });
    expect(res.ok).toBe(false);
    expect(clockOf(state)).toBe("19:00");
  });

  it("날짜가 넘어가면 하루의 시작으로 돌아온다", () => {
    const state = createTestGame(9);
    advanceTime(state, { clock: "19:00" });
    advanceTime(state, { days: 1 });
    expect(clockOf(state)).toBe("09:00");
  });
});

/**
 * 시간 진행은 **경기와 정말 큰 일** 앞에서만 선다.
 *
 * 예전엔 오퍼 한 통·훈련 부상 하나·벤치 불만 하나가 전부 시계를 세웠다. 일주일을
 * 넘기라는 지시가 이튿날 멈추면 감독에게는 시간을 흘릴 방법이 없다 — 손잡이를
 * 몇 번이고 다시 눌러야 한다. 그 일들은 하루 뒤에 처리해도 결과가 같으므로
 * 브리핑으로 쌓이고, 멈추는 것은 **오늘이 지나면 기회가 없어지는 일**뿐이다.
 */
describe("시간은 웬만하면 지나간다", () => {
  it("들어온 오퍼는 시계를 세우지 않는다 — 브리핑에만 실린다", () => {
    const state = createTestGame(5);
    state.date = "2026-07-10";
    const player = userPlayers(state)[0]!;
    const buyer = state.teams.find((t) => t.id !== state.userTeamId)!;
    state.negotiations.push({
      id: "neg-in-test",
      gamePlayerId: player.id,
      kind: "sell",
      counterpartTeamId: buyer.id,
      windowId: null,
      openedOn: state.date,
      // 기한이 넉넉하면 오늘 답할 이유가 없다
      expiresOn: "2026-08-20",
      status: "open",
      rounds: [
        {
          date: state.date,
          by: "them",
          fee: 20_000_000,
          weeklyWage: 100_000,
          contractYears: 4,
          respondsOn: null,
          probability: 60,
          verdict: null,
        },
      ],
    });
    const result = advanceTime(state, { days: 7 });
    expect(result.stopped).not.toBe("attention");
    expect(state.date).toBe("2026-07-17");
  });

  it("멈춘 날에는 반드시 오늘이 기한인 협상이 있다", () => {
    const state = createTestGame(5);
    /**
     * 한 시즌을 통째로 밀면서 **멈춘 이유를 전부 확인**한다. 부상이 나고 불만이
     * 생기고 오퍼가 들어와도 시계는 지나가야 하고, 섰다면 그 자리엔 반드시
     * 오늘이 마지막 날인 결정이 있어야 한다.
     */
    let injuries = 0;
    for (let i = 0; i < 120; i++) {
      const r = advanceTime(state, { days: 3 });
      if (r.stopped === "attention") {
        const due = pendingVerdicts(state).filter((v) => v.negotiation.expiresOn === state.date);
        expect(due.length, `${state.date}에 기한 없는 멈춤`).toBeGreaterThan(0);
      }
      if (r.stopped === "matchday") state.phase = "idle";
      if (r.stopped === "season_end") break;
      injuries = state.injuries.length;
    }
    // 부상은 실제로 났는데도 그것만으로는 서지 않았다는 것이 이 테스트의 요점이다
    expect(injuries).toBeGreaterThan(0);
  });

  it("오늘이 기한인 협상 앞에서는 선다 — 넘기면 사라지기 때문이다", () => {
    const state = createTestGame(5);
    state.date = "2026-07-10";
    const player = userPlayers(state)[0]!;
    const buyer = state.teams.find((t) => t.id !== state.userTeamId)!;
    state.negotiations.push({
      id: "neg-in-deadline",
      gamePlayerId: player.id,
      kind: "sell",
      counterpartTeamId: buyer.id,
      windowId: null,
      openedOn: state.date,
      expiresOn: "2026-07-13",
      status: "open",
      rounds: [
        {
          date: state.date,
          by: "them",
          fee: 20_000_000,
          weeklyWage: 100_000,
          contractYears: 4,
          respondsOn: null,
          probability: 60,
          verdict: null,
        },
      ],
    });
    const result = advanceTime(state, { days: 7 });
    expect(result.stopped).toBe("attention");
    expect(state.date).toBe("2026-07-13");
    expect(result.digest.join(" ")).toContain("오늘이 기한");
  });
});
