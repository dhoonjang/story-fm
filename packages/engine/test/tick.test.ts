import { describe, expect, it } from "vitest";
import { ageOf } from "@story-fm/domain";
import type { GamePlayer, PositionGroup } from "@story-fm/domain";
import type { GameState } from "@story-fm/engine";
import {
  addDays,
  advanceTime,
  contractGrievanceDue,
  diffDays,
  dueExpiryStage,
  listedGrievanceDue,
  listedPatienceDaysOf,
  wageByRating,
  seasonYear,
  assignmentsOf,
  financeOf,
  groupOf,
  simSquadOf,
  LOAN_REST_LIMIT,
  LOAN_ROTATION_OVR_DROP,
  ROTATION_FATIGUE,
  openInjury,
  pendingApproach,
  pendingVerdicts,
  playersOf,
  setTraining,
  clockOf,
  userPlayers,
  weeklyWagesOf,
} from "@story-fm/engine";
import {
  advanceDays,
  advanceToMatchday,
  createMiniGame,
  createTestGame,
  drillUserTactics,
  playMockMatch,
} from "./helpers";

describe("advance_time — 시간은 스킬로만 흐른다 (season.md §5)", () => {
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

  /**
   * **tick은 우리 킥오프 앞까지만 굴린다** — 예전엔 하루치를 통째로 굴려서,
   * 순위표를 열면 "이기면 몇 위"가 이미 확정돼 있었다.
   *
   * 예전 이 케이스는 **리그 1라운드**를 훑었다. 그런데 시즌 첫 경기일은 프리시즌
   * 친선(7/18)이고 1라운드는 한 달 뒤라, `if (m.date > state.date) continue` 가
   * 그 전부를 걸러 **단언이 한 줄도 돌지 않았다.** 그날 실제로 잡혀 있는 경기로 본다.
   */
  it("우리 킥오프와 같은 시각의 남의 경기는 미리 굴러 있지 않다", () => {
    const state = createTestGame();
    advanceToMatchday(state);
    const kickoff = (m: { time?: string }) => m.time ?? "15:00";
    const ours = state.matches.find(
      (m) =>
        m.date === state.date &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    )!;
    expect(ours, "경기일인데 우리 경기가 없다").toBeDefined();
    expect(ours.result, "유저 경기를 tick이 굴렸다").toBeNull();

    // 프리시즌 친선은 온 세계가 같은 날 같은 시각에 치른다 — 전부 우리 뒤에 선다
    const notEarlier = state.matches.filter(
      (m) => m.id !== ours.id && m.date === state.date && kickoff(m) >= kickoff(ours),
    );
    expect(notEarlier.length, "같은 날 남의 경기가 없다").toBeGreaterThan(10);
    for (const m of notEarlier) expect(m.result, `${m.id} 우리보다 먼저 굴렀다`).toBeNull();
    // 지난 날짜에 미소화가 남지도 않았다
    expect(state.matches.filter((m) => m.date < state.date && !m.result)).toEqual([]);

    /**
     * 리그 1라운드 편성은 손대지 않은 채 남아 있다 — 우리 리그의 나머지 아홉 경기.
     * (우리 킥오프 뒤에 남의 경기가 굴러가는지는 `quick-sim-events.test.ts`가
     * 실제 리그 경기일을 찾아 잰다 — 프리시즌에는 앞선 킥오프가 존재하지 않는다.)
     */
    const round1 = state.matches.filter(
      (m) =>
        m.competitionId === "epl" &&
        m.round === 1 &&
        m.homeTeamId !== state.userTeamId &&
        m.awayTeamId !== state.userTeamId,
    );
    expect(round1).toHaveLength(9);
  });

  /**
   * 훈련 일정은 코어가 깔지만 **능력치는 코어가 올리지 않는다** — 상승은 결산(LLM)이
   * 낸다(`settleTraining`). 예전 이 자리는 `>= before`만 재고 진짜 단언을
   * `if (오른 경우)` 안에 두어, 코어가 몰래 올려도 초록이었다.
   *
   * 우리 팀 1군은 월간 성장(`developsByCore`)에서도 빠지므로, 훈련만 소화한
   * 두 달은 이 선수의 축을 한 칸도 움직이지 못한다.
   */
  it("훈련 일정은 깔리지만 코어가 능력치를 올리지는 않는다", () => {
    const state = createTestGame(11);
    // 1군만 팀 훈련 일정을 소화한다 — 2군을 고르면 성장 출처가 개발 프로그램(reserve)이 된다
    const young = userPlayers(state).find(
      (p) => p.squadLevel !== "reserve" && ageOf(p.birthdate, state.date) <= 21,
    )!;
    expect(young, "1군 유망주가 없다").toBeDefined();
    const before = { ...young.attributes };
    // 평일 오전·오후 슈팅 훈련 등록 (기본 훈련 없음 → 스킬이 일정을 만든다)
    setTraining(state, {
      repeatWeekly: [1, 2, 3, 4, 5].flatMap((dow) => [
        { dow, slot: "am" as const, label: "슈팅 마무리", focus: ["finishing" as const] },
        { dow, slot: "pm" as const, label: "슈팅 마무리", focus: ["finishing" as const] },
      ]),
      weeks: 3,
    });
    expect(state.schedule.filter((e) => e.type === "training").length).toBeGreaterThan(10);

    for (let i = 0; i < 20; i++) {
      const r = advanceTime(state, { days: 3 });
      if (!r.ok || r.stopped === "matchday") break;
    }
    // 일정은 실제로 소화됐다 — 날짜가 훈련 구간을 지났다
    expect(state.date > "2026-07-13").toBe(true);
    expect(young.attributes, "코어가 훈련만으로 능력치를 올렸다").toEqual(before);
    expect(
      state.growthLog.filter((g) => g.gamePlayerId === young.id && g.source === "training"),
      "결산 없이 훈련 성장 로그가 생겼다",
    ).toEqual([]);
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
    // 유저 팀 원장은 선수별로 적힌다 (§4.2) — 한 날짜의 합이 계약 합이다
    const paid = finance.ledger.filter((l) => l.category === "player_wages");
    const byDate = new Map<string, number>();
    for (const e of paid) byDate.set(e.date, (byDate.get(e.date) ?? 0) + e.amount);
    expect(byDate.size).toBeGreaterThanOrEqual(1);
    for (const [date, sum] of byDate) {
      // 항목마다 반올림하므로 합계가 계약 합에서 항목 수만큼 어긋날 수 있다
      const lines = paid.filter((e) => e.date === date).length;
      expect(Math.abs(sum - wages), date).toBeLessThanOrEqual(lines);
    }
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

  it("멈춘 날에는 반드시 오늘이 기한인 협상이거나 오늘 찾아온 사람이 있다", () => {
    /**
     * **축소 세계로 민다** — 시계가 서는 규칙은 세계의 크기와 무관하다(`tick.ts`의
     * 같은 갈래를 탄다). 전체 세계로 한 시즌을 밀면 이 한 케이스가 30초를 넘게 쓴다.
     */
    const state = createMiniGame(5);
    /**
     * 한 시즌을 통째로 밀면서 **멈춘 이유를 전부 확인**한다. 부상이 나고 불만이
     * 생기고 오퍼가 들어와도 시계는 지나가야 하고, 섰다면 그 자리엔 반드시
     * 오늘이 마지막 날인 결정 — 기한인 협상이거나 오늘 열린 다가옴 — 이 있어야 한다
     * (people.md §8 · season.md §5의 표).
     */
    let injuries = 0;
    let stops = 0;
    for (let i = 0; i < 120; i++) {
      const r = advanceTime(state, { days: 3 });
      if (r.stopped === "attention") {
        stops++;
        const due = pendingVerdicts(state).filter((v) => v.negotiation.expiresOn === state.date);
        const came = pendingApproach(state)?.date === state.date;
        expect(due.length + (came ? 1 : 0), `${state.date}에 이유 없는 멈춤`).toBeGreaterThan(0);
      }
      if (r.stopped === "matchday") state.phase = "idle";
      if (r.stopped === "season_end") break;
      injuries = state.injuries.length;
    }
    // 부상은 실제로 났는데도 그것만으로는 서지 않았다는 것이 이 테스트의 요점이다
    expect(injuries).toBeGreaterThan(0);
    // 한 번도 서지 않았다면 위 검사는 한 줄도 돌지 않은 것이다
    expect(stops, "시계가 한 번도 서지 않아 멈춤의 이유를 확인하지 못했다").toBeGreaterThan(0);
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

/**
 * 등재·계약의 불만 문턱 — **결정적이다** (→ docs/data/people.md §5).
 *
 * 추첨이 없어 감독이 날짜를 셀 수 있는 자리라, 경계가 하루·한 명 어긋나면 화면이
 * "180일 남았다"고 적어 놓고 불만은 서지 않는다.
 */
describe("불만의 문턱 — 등재와 계약 만료", () => {
  /** 스쿼드에 서로 다른 종합을 매긴다 — 동점이 있으면 상위 14명 경계를 잴 수 없다 */
  function rankedSquad(state: GameState) {
    const squad = [...userPlayers(state)].sort(
      (a, b) => b.attributes.overall - a.attributes.overall,
    );
    squad.forEach((p, i) => {
      p.attributes.overall = 90 - i;
    });
    return squad;
  }

  /** 그 선수의 활성 계약을 오늘로부터 `days` 뒤에 끝나게 하고, 주급을 서열 대비로 놓는다 */
  function contractOf(state: GameState, player: GamePlayer, days: number, paid: boolean) {
    const contract = state.contracts.find(
      (c) => c.gamePlayerId === player.id && c.status === "active",
    )!;
    contract.until = addDays(state.date, days);
    const rate = wageByRating(player.attributes.overall);
    contract.weeklyWage = Math.round(paid ? rate * 1.1 : rate * 0.5);
    return contract;
  }

  it("계약 만료 — 서열 대비 밀려 있으면 181일엔 서지 않고 180일에 선다", () => {
    const state = createMiniGame();
    const target = rankedSquad(state)[0]!;

    contractOf(state, target, 181, false);
    expect(contractGrievanceDue(state, target)).toBe(false);
    contractOf(state, target, 180, false);
    expect(contractGrievanceDue(state, target)).toBe(true);
  });

  it("계약 만료 — 서열대로 받고 있으면 문턱이 절반이다 (91/90일)", () => {
    const state = createMiniGame();
    const target = rankedSquad(state)[0]!;

    contractOf(state, target, 180, true);
    expect(contractGrievanceDue(state, target)).toBe(false);
    contractOf(state, target, 91, true);
    expect(contractGrievanceDue(state, target)).toBe(false);
    contractOf(state, target, 90, true);
    expect(contractGrievanceDue(state, target)).toBe(true);
  });

  it("계약 만료 — 이미 만료된 계약에는 서지 않고, 열린 재계약이 있으면 멈춘다", () => {
    const state = createMiniGame();
    const target = rankedSquad(state)[0]!;

    contractOf(state, target, -1, false);
    expect(contractGrievanceDue(state, target)).toBe(false);

    contractOf(state, target, 100, false);
    expect(contractGrievanceDue(state, target)).toBe(true);
    state.negotiations.push({
      id: `neg-renew-${target.id}`,
      gamePlayerId: target.id,
      kind: "renew",
      counterpartTeamId: null,
      windowId: null,
      openedOn: state.date,
      expiresOn: addDays(state.date, 14),
      status: "open",
      rounds: [],
    });
    expect(contractGrievanceDue(state, target)).toBe(false);
  });

  it("자격은 상위 14명이다 — 열넷째는 서고 열다섯째는 서지 않는다", () => {
    const state = createMiniGame();
    const squad = rankedSquad(state);
    const core = squad[13]!; // 그보다 나은 선수 13명 — 안
    const fringe = squad[14]!; // 14명 — 밖

    contractOf(state, core, 180, false);
    contractOf(state, fringe, 180, false);
    expect(contractGrievanceDue(state, core)).toBe(true);
    expect(contractGrievanceDue(state, fringe)).toBe(false);
  });

  it("등재 — 문턱은 그 사람의 것이고, 하루 전에는 서지 않는다", () => {
    const state = createMiniGame();
    const target = rankedSquad(state)[0]!;
    const threshold = listedPatienceDaysOf(state, target);
    expect(threshold).toBeGreaterThan(0);

    state.transferList.push({
      gamePlayerId: target.id,
      askingPrice: 1_000_000,
      listedOn: addDays(state.date, -(threshold - 1)),
    });
    expect(listedGrievanceDue(state, target)).toBe(false);

    state.transferList[state.transferList.length - 1]!.listedOn = addDays(state.date, -threshold);
    expect(listedGrievanceDue(state, target)).toBe(true);
  });

  it("등재 — 이미 불만이 있는 선수에게 사유를 하나 더 얹지 않는다", () => {
    const state = createMiniGame();
    const target = rankedSquad(state)[0]!;
    state.transferList.push({
      gamePlayerId: target.id,
      askingPrice: 1_000_000,
      listedOn: addDays(state.date, -60),
    });
    expect(listedGrievanceDue(state, target)).toBe(true);

    state.issues.push({
      gamePlayerId: target.id,
      kind: "unhappy",
      reason: "minutes",
      since: state.date,
    });
    expect(listedGrievanceDue(state, target)).toBe(false);
  });
});

describe("계약 만료 예고 — 문턱마다 한 번 (season.md §5)", () => {
  it("넘어선 문턱 중 가장 낮은 것만, 이미 낸 단계는 다시 내지 않는다", () => {
    expect(dueExpiryStage(181, undefined)).toBeNull();
    expect(dueExpiryStage(180, undefined)).toBe(180);
    // 하루로 재지 않는다 — 문턱 날에 tick이 없었어도 다음 날 선다
    expect(dueExpiryStage(179, undefined)).toBe(180);
    expect(dueExpiryStage(100, 180)).toBeNull();
    expect(dueExpiryStage(89, 180)).toBe(90);
    // 최종전이 5월 말인 시즌 — 30일 문턱(05-31)에 닿는 날이 아예 없다
    expect(dueExpiryStage(31, 90)).toBeNull();
    // 시즌이 끝나는 tick은 남은 문턱을 소진한다
    expect(dueExpiryStage(0, 90)).toBe(30);
    expect(dueExpiryStage(0, 30)).toBeNull();
  });

  it("최종전 뒤 30일 문턱에 tick이 없는 시즌에도 세 문턱이 한 번씩 나간다", () => {
    const state = createMiniGame();
    const player = userPlayers(state)[0]!;
    const contract = state.contracts.find(
      (c) => c.gamePlayerId === player.id && c.status === "active",
    )!;
    const expiresOn = `${seasonYear(state.season) + 1}-06-30`;
    contract.until = expiresOn;

    const warnings: string[] = [];
    let lastTicked = state.date;
    for (let i = 0; i < 400; i++) {
      const result = advanceTime(state, "next_match");
      expect(result.ok, result.digest.join(" / ")).toBe(true);
      warnings.push(...result.digest.filter((d) => d.includes(`${player.name}의 계약이`)));
      if (result.stopped === "season_end") break;
      lastTicked = state.date;
      if (result.stopped === "matchday") {
        drillUserTactics(state, 7);
        playMockMatch(state);
      }
    }

    // 이 시즌은 30일 문턱을 지나지 않는다 — 최종전이 05-31보다 앞이다
    expect(diffDays(lastTicked, expiresOn)).toBeGreaterThan(30);
    expect(warnings.map((line) => line.match(/계약이 (\d+)일/)?.[1])).toEqual([
      "180",
      "90",
      String(diffDays(lastTicked, expiresOn)),
    ]);
  });
});

/**
 * 빌린 구단이 임대 자원에게 치르는 값 — `simSquadOf`의 문 둘
 * (→ docs/simulation/season.md §2 임대).
 *
 * 재는 것은 **경계**다: 주전이 멀쩡할 때 서지 않고, 연속 미출전이 상한에 닿으면
 * 서고, 기량 창 밖이면 상한에 닿아도 서지 않는다. 화면이 드러내는 값이 아니라
 * AI 전 구단의 선발을 정하는 규칙이라 조용히 어긋난다.
 */
describe("임대 자원이 서는 자리 (season.md §2 임대)", () => {
  /** 감독 팀이 아닌 클럽 하나 — AI 라인업은 이쪽에서만 짜인다 */
  function hostOf(state: GameState): string {
    return state.teams.find((t) => t.id !== state.userTeamId)!.id;
  }

  /**
   * 그 구단 1군에 임대로 들어온 선수 하나를 만든다 — 다른 클럽의 2군에서 데려와
   * 종합만 원하는 값으로 맞춘다. 포지션군은 원본 선수의 것을 그대로 쓴다.
   */
  function lendInto(
    state: GameState,
    hostId: string,
    pick: (p: GamePlayer) => boolean,
    overall: number,
  ): GamePlayer {
    const lender = state.teams.find((t) => t.id !== hostId && t.id !== state.userTeamId)!.id;
    const player = playersOf(state, lender).find(pick)!;
    player.teamId = hostId;
    player.squadLevel = "first";
    player.attributes.overall = overall;
    player.state.condition = 100;
    player.loan = { fromTeamId: lender, until: "2027-06-30", wageShare: 0.5 };
    return player;
  }

  /** 그 구단이 치른 경기 `count`개를 장부에 얹는다 — 명단에는 아무도 넣지 않는다 */
  function pastMatches(state: GameState, hostId: string, count: number): void {
    for (let i = 0; i < count; i++) {
      state.matches.push({
        id: `past-${hostId}-${i}`,
        season: state.season,
        competitionId: "test-league",
        round: i + 1,
        date: addDays("2026-08-01", i),
        homeTeamId: hostId,
        awayTeamId: state.userTeamId,
        result: { homeGoals: 0, awayGoals: 0, scorers: [], homeLineup: [], awayLineup: [] },
      });
    }
  }

  /** 그 포지션군에서 가장 약한 선발 */
  function weakestStarter(state: GameState, hostId: string, group: PositionGroup): GamePlayer {
    return assignmentsOf(state, hostId, "starting")
      .map((a) => playersOf(state, hostId).find((p) => p.id === a.playerId)!)
      .filter((p) => groupOf(p) === group)
      .sort((a, b) => a.attributes.overall - b.attributes.overall)[0]!;
  }

  it("주전이 멀쩡하고 앉은 경기가 상한 아래면 임대 자원은 서지 않는다", () => {
    const state = createMiniGame(42);
    const host = hostOf(state);
    const seat = weakestStarter(state, host, "MF");
    const loanee = lendInto(state, host, (p) => groupOf(p) === "MF", seat.attributes.overall);
    pastMatches(state, host, LOAN_REST_LIMIT - 1);

    expect(simSquadOf(state, host).starters.map((p) => p.id)).not.toContain(loanee.id);
  });

  it("연속 미출전이 상한에 닿으면 같은 포지션군의 가장 약한 선발과 자리를 바꾼다", () => {
    const state = createMiniGame(42);
    const host = hostOf(state);
    const seat = weakestStarter(state, host, "MF");
    const loanee = lendInto(state, host, (p) => groupOf(p) === "MF", seat.attributes.overall);
    pastMatches(state, host, LOAN_REST_LIMIT);

    const squad = simSquadOf(state, host);
    const ids = squad.starters.map((p) => p.id);
    expect(ids).toContain(loanee.id);
    expect(ids).not.toContain(seat.id);
    expect(squad.starters).toHaveLength(11);
    // 자리는 판의 것이다 — 좌표는 그대로고 숙련도만 들어온 선수의 것으로 다시 선다
    const slot = (squad.slots ?? []).find((s) => s.player.id === loanee.id)!;
    expect(slot.position).toBe(
      assignmentsOf(state, host, "starting")[ids.indexOf(loanee.id)]!.position,
    );
  });

  it("기량 창 밖이면 상한에 닿아도 서지 않는다 — 임대처 선택이 판단인 자리", () => {
    const state = createMiniGame(42);
    const host = hostOf(state);
    const seat = weakestStarter(state, host, "MF");
    const loanee = lendInto(
      state,
      host,
      (p) => groupOf(p) === "MF",
      seat.attributes.overall - LOAN_ROTATION_OVR_DROP - 1,
    );
    pastMatches(state, host, LOAN_REST_LIMIT + 5);

    expect(simSquadOf(state, host).starters.map((p) => p.id)).not.toContain(loanee.id);
    // 창의 경계 — 딱 그만큼 낮으면 선다
    loanee.attributes.overall = seat.attributes.overall - LOAN_ROTATION_OVR_DROP;
    expect(simSquadOf(state, host).starters.map((p) => p.id)).toContain(loanee.id);
  });

  it("임대 자원끼리는 자리를 뺏지 않는다 — 자리가 하나뿐이면 하나만 선다", () => {
    const state = createMiniGame(42);
    const host = hostOf(state);
    // 골문은 선발 자리가 하나뿐이라, 서로의 자리를 뺏는지가 여기서만 드러난다
    const seat = weakestStarter(state, host, "GK");
    const first = lendInto(state, host, (p) => groupOf(p) === "GK", seat.attributes.overall);
    const second = lendInto(
      state,
      host,
      (p) => p.id !== first.id && groupOf(p) === "GK",
      seat.attributes.overall,
    );
    pastMatches(state, host, LOAN_REST_LIMIT);

    const ids = simSquadOf(state, host).starters.map((p) => p.id);
    // 앞사람이 자리를 얻은 뒤 뒷사람이 그 자리를 다시 가져가지는 않는다
    expect(ids.filter((id) => id === first.id || id === second.id)).toHaveLength(1);
    expect(ids).not.toContain(seat.id);
  });

  it("로테이션 자리는 기량이 더 나은 스쿼드 자원보다 임대 자원이 먼저 받는다", () => {
    const state = createMiniGame(42);
    const host = hostOf(state);
    const tired = weakestStarter(state, host, "MF");
    tired.state.condition = 100 - ROTATION_FATIGUE - 5;
    // 임대 자원은 그 자리를 놓고 겨루는 스쿼드 자원보다 약하다 — 그래도 먼저 선다
    const loanee = lendInto(state, host, (p) => groupOf(p) === "MF", tired.attributes.overall - 5);
    const rival = playersOf(state, host).find(
      (p) =>
        p.id !== loanee.id &&
        groupOf(p) === "MF" &&
        !assignmentsOf(state, host, "starting").some((a) => a.playerId === p.id),
    )!;
    rival.attributes.overall = tired.attributes.overall;
    rival.state.condition = 100;
    // 앉은 경기는 상한 아래다 — 서는 문은 로테이션 하나뿐이다
    pastMatches(state, host, LOAN_REST_LIMIT - 1);

    const ids = simSquadOf(state, host).starters.map((p) => p.id);
    expect(ids).toContain(loanee.id);
    expect(ids).not.toContain(rival.id);
  });
});
