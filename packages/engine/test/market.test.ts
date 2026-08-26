import { describe, expect, it } from "vitest";
import type { GamePlayer } from "@story-fm/domain";
import {
  AGENT_PROFILE,
  COMPETING_BID_LIFT,
  COUNTER_CEILING,
  MARKET_VALUE_AT_PEAK,
  NO_AGENT_PROFILE,
  PATIENCE_DECAY,
  activeContract,
  addDays,
  agentOfPlayer,
  agentProfileOf,
  askingPriceFor,
  baseValueOf,
  betterAtPosition,
  dealOdds,
  isClubTeam,
  knowledgeOf,
  marketValueOf,
  playersOf,
  precontractDaysLeft,
  precontractStartOf,
  renewalExpectation,
  responseDelayDays,
  sameTermsRepeats,
  squadDepthOf,
  competingBidLiftOf,
  wageByRating,
  wageExpectationOf,
  derivedSquadStatus,
} from "@story-fm/engine";
import { PRECONTRACT_DAYS, SQUAD_STATUSES, squadStatusRank } from "@story-fm/domain";
import { createTestGame } from "./helpers";

/**
 * 이적 시장 코어 — 시장가·요구액·딜 확률. 전부 결정적 순수 함수다.
 * LLM은 이 숫자를 앵커로 판정하므로, 숫자 자체가 흔들리면 판정도 흔들린다.
 */

/** 안개를 걷는다 — 완료된 보고서가 있으면 `knowledgeOf`가 `scouted`를 돌려준다 */
function scouted(state: ReturnType<typeof createTestGame>, player: GamePlayer): void {
  state.scoutReports.push({
    id: `scout-${player.id}`,
    gamePlayerId: player.id,
    requestedOn: state.date,
    dueOn: state.date,
    completedOn: state.date,
  });
}

function pick(state: ReturnType<typeof createTestGame>, overall: number): GamePlayer {
  const found = state.players.find(
    (p) => p.teamId !== state.userTeamId && p.attributes.overall === overall,
  );
  if (!found) throw new Error(`OVR ${overall} 선수를 찾지 못했습니다`);
  return found;
}

describe("시장가", () => {
  it("등급 곡선은 단조 증가하고 80 OVR이 기준값이다", () => {
    expect(baseValueOf(80)).toBe(MARKET_VALUE_AT_PEAK);
    for (let ovr = 56; ovr < 95; ovr++) {
      expect(baseValueOf(ovr), `${ovr}`).toBeLessThan(baseValueOf(ovr + 1));
    }
    // 하한 아래는 이적료가 붙지 않는다
    expect(baseValueOf(50)).toBe(0);
    // 최상급과 스쿼드 자원의 격차가 실제처럼 크게 벌어진다 (눈금이 좁아진 만큼 폭도 좁다)
    expect(baseValueOf(80) / Math.max(1, baseValueOf(62))).toBeGreaterThan(8);
  });

  it("나이·계약 잔여·리그가 값을 움직인다", () => {
    const state = createTestGame(42);
    const player = pick(state, 78);
    // 기준선은 **긴 계약**에서 잡는다 — 시드 계약이 1년 미만이면 아래 단축 비교가
    // 같은 계수(0.45)에 걸려 무의미해진다
    const contract = activeContract(state, player.id)!;
    contract.until = `${Number(state.date.slice(0, 4)) + 4}-06-30`;
    const year = Number(state.date.slice(0, 4));
    // **나이도 고정해서 재야 한다** — `pick`은 OVR만 보고 배열에서 처음 걸리는
    // 선수를 집으므로, 그 선수가 이미 서른이면 "서른셋과의 차이"가 나이 곡선이
    // 아니라 두 살 차이를 재게 된다. 실제로 라인업 배치가 바뀌어 등록 순서가
    // 흔들리자 이 테스트가 그렇게 깨졌다.
    const at = (age: number) => ({ ...player, birthdate: `${year - age}-01-01` });
    const baseline = marketValueOf(state, at(25));

    // 스물다섯 → 서른셋은 절반 이하
    expect(marketValueOf(state, at(33))).toBeLessThan(baseline * 0.6);

    // 계약이 곧 끝나면 값이 빠지고, 만료되면 이적료가 0이다
    contract.until = `${state.date.slice(0, 4)}-12-31`;
    expect(marketValueOf(state, at(25))).toBeLessThan(baseline);
    contract.until = state.date;
    expect(marketValueOf(state, at(25))).toBe(0);
  });

  it("유망주는 잠재력만큼 프리미엄이 붙는다", () => {
    const state = createTestGame(42);
    const player = pick(state, 70);
    const young = {
      ...player,
      birthdate: `${Number(state.date.slice(0, 4)) - 20}-01-01`,
      attributes: { ...player.attributes, potential: 88 },
    };
    const youngNoUpside = { ...young, attributes: { ...young.attributes, potential: 70 } };
    expect(marketValueOf(state, young)).toBeGreaterThan(marketValueOf(state, youngNoUpside) * 1.3);
  });

  it("요구액은 상대 사정을 반영한다 (대체 불가면 비싸다)", () => {
    const state = createTestGame(42);
    for (const ovr of [84, 78, 70]) {
      const player = pick(state, ovr);
      const asking = askingPriceFor(state, player);
      expect(asking, `${ovr}`).toBeGreaterThan(marketValueOf(state, player) * 0.6);
      expect(asking, `${ovr}`).toBeLessThan(marketValueOf(state, player) * 1.6);
    }
  });
});

describe("딜 확률", () => {
  it("더 많이 제시하면 확률이 떨어지지 않는다 (단조성)", () => {
    const state = createTestGame(42);
    // 우리 선수를 하나 골라 오퍼 대상으로 쓴다 — 안개가 없어 순수 곡선을 본다
    const target = state.players.find((p) => p.teamId !== state.userTeamId)!;
    const wage = wageExpectationOf(state, target);
    const asking = askingPriceFor(state, target);
    let previous = -1;
    for (const ratio of [0.5, 0.7, 0.85, 1, 1.15, 1.4]) {
      const odds = dealOdds(state, {
        playerId: target.id,
        fee: Math.round(asking * ratio),
        weeklyWage: wage,
        years: 4,
      });
      expect(odds.probability, `${ratio}`).toBeGreaterThanOrEqual(previous);
      previous = odds.probability;
    }
  });

  it("주급을 올려도 확률이 떨어지지 않는다", () => {
    const state = createTestGame(42);
    const target = state.players.find((p) => p.teamId !== state.userTeamId)!;
    const asking = askingPriceFor(state, target);
    const wage = wageExpectationOf(state, target);
    let previous = -1;
    for (const ratio of [0.7, 0.9, 1, 1.2, 1.5]) {
      const odds = dealOdds(state, {
        playerId: target.id,
        fee: asking,
        weeklyWage: Math.round(wage * ratio),
        years: 4,
      });
      expect(odds.probability, `${ratio}`).toBeGreaterThanOrEqual(previous);
      previous = odds.probability;
    }
  });

  it("기대치를 그대로 맞추면 절반을 크게 넘는다", () => {
    const state = createTestGame(42);
    const target = pick(state, 76);
    const odds = dealOdds(state, {
      playerId: target.id,
      fee: askingPriceFor(state, target),
      weeklyWage: wageExpectationOf(state, target),
      years: 4,
    });
    expect(odds.probability).toBeGreaterThan(45);
    // 기준 항목은 두 관문을 다 맞췄을 때의 값이다
    const base = odds.factors.find((f) => f.label === "기준");
    expect(base?.delta).toBeGreaterThan(65);
  });

  it("근거 분해가 확률과 어긋나지 않는다 (합이 확률 근처)", () => {
    const state = createTestGame(42);
    const target = pick(state, 80);
    // 안개를 걷어 순수 곡선을 본다 — 흐린 표시 확률과 근거의 합을 견주면
    // 재는 것이 분해의 정확도가 아니라 안개의 폭이 된다
    scouted(state, target);
    const odds = dealOdds(state, {
      playerId: target.id,
      fee: Math.round(askingPriceFor(state, target) * 0.8),
      weeklyWage: wageExpectationOf(state, target),
      years: 4,
    });
    expect(odds.fuzzy).toBe(false);
    const sum = odds.factors.reduce((s, f) => s + f.delta, 0);
    // 곱셈 구조라 정확히 같지는 않지만, 한계 기여의 합은 확률 근처에 있어야 한다
    expect(
      Math.abs(sum - odds.probability),
      `합 ${sum} vs 확률 ${odds.probability}`,
    ).toBeLessThanOrEqual(12);
  });

  it("같은 조건을 반복하면 확률이 떨어진다 (인내심)", () => {
    const state = createTestGame(42);
    const target = pick(state, 74);
    // 안개를 걷어 순수 곡선을 본다 — 안개는 표시 확률에 ±%p로 더해지므로
    // 흐린 값끼리 비교하면 감쇠 배수가 정확히 맞지 않는다
    scouted(state, target);
    const terms = {
      playerId: target.id,
      fee: askingPriceFor(state, target),
      weeklyWage: wageExpectationOf(state, target),
      years: 4,
    };
    const first = dealOdds(state, terms).probability;

    // 같은 조건으로 두 번 제안한 협상을 만들어 둔다
    state.negotiations.push({
      id: "neg-test",
      gamePlayerId: target.id,
      kind: "buy",
      counterpartTeamId: target.teamId,
      windowId: state.windows[0]!.id,
      openedOn: state.date,
      expiresOn: state.windows[0]!.closesOn,
      status: "open",
      // 답을 **받은** 라운드만 반복으로 잡힌다 (`sameTermsRepeats`)
      rounds: [1, 2].map(() => ({
        date: state.date,
        by: "us" as const,
        fee: terms.fee,
        weeklyWage: terms.weeklyWage,
        contractYears: 4,
        respondsOn: state.date,
        probability: first,
        verdict: "counter" as const,
      })),
    });
    const repeated = dealOdds(state, terms);
    expect(repeated.probability).toBeLessThan(first);
    // 확률은 정수 %로 반올림돼 나오므로 한 칸(±1)까지는 감쇠 배수가 맞는 것으로 본다
    // (`toBeCloseTo(_, 0)`의 허용 오차 0.5로는 반올림 오차를 담지 못한다)
    // 감쇠의 지수는 대리인의 인내심으로 나뉜다 (transfer.md §3)
    const patience = agentProfileOf(state, target.id).patience;
    expect(
      Math.abs(repeated.probability - first * PATIENCE_DECAY ** (2 / patience)),
    ).toBeLessThanOrEqual(1);
    expect(repeated.factors.some((f) => f.label === "상대의 인내심")).toBe(true);

    // 조건을 유의미하게 올리면 감쇠가 초기화된다
    const raised = dealOdds(state, { ...terms, fee: Math.round(terms.fee * 1.2) });
    expect(raised.factors.some((f) => f.label === "상대의 인내심")).toBe(false);
    expect(raised.probability).toBeGreaterThan(repeated.probability);
  });

  /**
   * **감쇠는 영입 갈래에만 걸린다** — 매각·임대는 관문 계산이 통째로 다른 함수
   * (`sellOdds`·`loanOdds`)로 빠지고, 그 함수들은 확률에 곱하는 항(마감 임박·인내심)을
   * 아예 만들지 않는다. 그래서 같은 값을 몇 번을 되불러도 확률이 그대로다.
   *
   * 지금 동작을 못 박아 둔다: 감쇠를 이쪽에도 걸기로 한다면 그건 밸런스 결정이고,
   * 이 케이스가 그때 함께 움직여야 하는 자리다.
   */
  it("매각·임대에는 인내심 감쇠가 걸리지 않는다 — 영입 갈래만 닳는다", () => {
    const state = createTestGame(42);
    const ours = playersOf(state, state.userTeamId)[0]!;
    const target = pick(state, 74);
    const sell = {
      playerId: ours.id,
      fee: marketValueOf(state, ours),
      weeklyWage: wageExpectationOf(state, ours),
      years: 4,
      kind: "sell" as const,
      counterpartTeamId: target.teamId,
    };
    const loanIn = {
      playerId: target.id,
      fee: 0,
      weeklyWage: wageExpectationOf(state, target),
      years: 1,
      kind: "loan" as const,
    };
    const before = { sell: dealOdds(state, sell), loan: dealOdds(state, loanIn) };

    /** 답을 받은 라운드 둘 — 영입이라면 여기서 PATIENCE_DECAY²가 곱해진다 */
    const staged = (id: string, kind: "sell" | "loan", terms: typeof sell | typeof loanIn) => {
      state.negotiations.push({
        id,
        gamePlayerId: terms.playerId,
        kind,
        counterpartTeamId: target.teamId,
        windowId: state.windows[0]!.id,
        openedOn: state.date,
        expiresOn: state.windows[0]!.closesOn,
        status: "open",
        rounds: [1, 2].map(() => ({
          date: state.date,
          by: "us" as const,
          fee: terms.fee,
          weeklyWage: terms.weeklyWage,
          contractYears: terms.years,
          respondsOn: state.date,
          probability: 50,
          verdict: "counter" as const,
        })),
      });
    };
    staged("neg-sell", "sell", sell);
    staged("neg-loan", "loan", loanIn);

    // 반복은 세어지지만(같은 조건이다) 확률에도 근거에도 닿지 않는다
    expect(sameTermsRepeats(state, sell)).toBe(2);
    expect(sameTermsRepeats(state, loanIn)).toBe(2);
    for (const [label, terms, was] of [
      ["매각", sell, before.sell],
      ["임대", loanIn, before.loan],
    ] as const) {
      const again = dealOdds(state, terms);
      expect(again.probability, `${label} 확률이 반복으로 움직였다`).toBe(was.probability);
      expect(again.factors.some((f) => f.label === "상대의 인내심")).toBe(false);
    }
  });

  it("차단은 확률과 별개로 보고된다", () => {
    const state = createTestGame(42);
    const target = pick(state, 84);
    // 예산을 넘는 오퍼
    const odds = dealOdds(state, {
      playerId: target.id,
      fee: 500_000_000,
      weeklyWage: wageExpectationOf(state, target),
      years: 4,
    });
    expect(odds.blockers.some((b) => b.includes("예산"))).toBe(true);
    expect(odds.probability).toBeGreaterThan(0); // 확률 자체는 계산된다

    // 우리 선수는 살 수 없다
    const ours = playersOf(state, state.userTeamId)[0]!;
    expect(
      dealOdds(state, { playerId: ours.id, fee: 1, weeklyWage: 1, years: 4 }).blockers.join(),
    ).toContain("우리 선수");

    // 창이 닫히면 막힌다 (프리시즌 창을 닫아 본다)
    const window = state.windows[0]!;
    const opensOn = window.opensOn;
    window.opensOn = "2099-01-01";
    expect(
      dealOdds(state, { playerId: target.id, fee: 1, weeklyWage: 1, years: 4 }).blockers.join(),
    ).toContain("이적시장");
    window.opensOn = opensOn;
  });
});

describe("선수 관문 — 버틸 이유와 나갈 이유", () => {
  const state = createTestGame(42);
  const year = Number(state.date.slice(0, 4));
  const ours = playersOf(state, state.userTeamId);
  const star = [...ours].sort((a, b) => b.attributes.overall - a.attributes.overall)[0]!;
  const factorOf = (odds: ReturnType<typeof dealOdds>, label: string) =>
    odds.factors.find((f) => f.label === label);
  const renew = (player: GamePlayer, years = 3, wage = renewalExpectation(state, player)) =>
    dealOdds(state, { kind: "renew", playerId: player.id, fee: 0, weeklyWage: wage, years });
  const buy = (player: GamePlayer) =>
    dealOdds(state, {
      playerId: player.id,
      fee: askingPriceFor(state, player),
      weeklyWage: wageExpectationOf(state, player),
      years: 4,
    });

  it("기대치를 맞춘 제안은 관문의 수와 무관하게 같은 곳에서 출발한다", () => {
    const base = (odds: ReturnType<typeof dealOdds>) => factorOf(odds, "기준")?.delta;
    const pair = base(buy(pick(state, 76)));
    const solo = base(renew(star));
    const release = base(
      dealOdds(state, { kind: "release", playerId: star.id, fee: 0, weeklyWage: 0, years: 0 }),
    );
    expect(pair).toBe(solo);
    expect(release).toBe(solo);
    // 곱셈이 사라진 갈래가 더 높은 데서 출발하지 않는다 — 72%
    expect(solo).toBeLessThan(75);
  });

  it("현 계약보다 깎아 부르면 항이 서고 확률이 내려간다", () => {
    const contract = activeContract(state, star.id)!;
    const original = contract.weeklyWage;
    const offered = renewalExpectation(state, star);
    try {
      contract.weeklyWage = offered;
      const level = renew(star, 3, offered);
      expect(factorOf(level, "현 계약 대비")).toBeUndefined();
      contract.weeklyWage = Math.round(offered * 1.5);
      const cut = renew(star, 3, offered);
      const factor = factorOf(cut, "현 계약 대비");
      expect(factor?.delta).toBeLessThan(0);
      expect(cut.probability).toBeLessThan(level.probability);
    } finally {
      contract.weeklyWage = original;
    }
  });

  it("커리어 시계 — 노장은 남고 젊으면 옮긴다", () => {
    const outsider = pick(state, 76);
    const birthdates = [star.birthdate, outsider.birthdate] as const;
    try {
      star.birthdate = `${year - 33}-01-01`;
      outsider.birthdate = `${year - 33}-01-01`;
      const renewOld = renew(star, 2);
      const buyOld = buy(outsider);
      star.birthdate = `${year - 23}-01-01`;
      outsider.birthdate = `${year - 23}-01-01`;
      const renewYoung = renew(star, 2);
      const buyYoung = buy(outsider);
      expect(factorOf(renewOld, "커리어 시계")?.delta).toBeGreaterThan(0);
      expect(factorOf(renewYoung, "커리어 시계")?.delta).toBeLessThan(0);
      expect(factorOf(buyOld, "커리어 시계")?.delta).toBeLessThan(0);
      expect(factorOf(buyYoung, "커리어 시계")?.delta).toBeGreaterThan(0);
    } finally {
      star.birthdate = birthdates[0];
      outsider.birthdate = birthdates[1];
    }
  });

  it("다른 구단의 관심이 재계약과 영입의 선수 관문에 함께 선다", () => {
    // 최상급 선수는 곧바로 주전으로 쓸 구단이 많다 — 남을 이유도 옮길 이유도 약해진다
    const top = state.players
      .filter((p) => p.teamId !== state.userTeamId)
      .sort((a, b) => b.attributes.overall - a.attributes.overall)[0]!;
    expect(factorOf(renew(star), "다른 구단의 관심")?.delta).toBeLessThan(0);
    expect(factorOf(buy(top), "다른 구단의 관심")?.delta).toBeLessThan(0);
  });
});

describe("팀×자리 색인 — 세는 규칙이 하나여야 한다", () => {
  /**
   * `squadDepthOf`는 `betterAtPosition`을 원장 한 번 훑기로 바꿔 놓은 것이다.
   * 두 벌이 되는 순간 재계약·오퍼 판단이 조용히 갈리므로 답이 같은지 못 박는다.
   */
  it("색인이 세는 수는 `betterAtPosition`과 같다", () => {
    const state = createTestGame(31);
    const depth = squadDepthOf(state);
    // 팀을 갈라 본다 — 우리 팀·라이벌·2부, 그리고 그 자리가 빈 조합까지
    for (const teamId of [state.userTeamId, "chelsea", "leeds"]) {
      for (const player of playersOf(state, teamId)) {
        expect(depth.betterThan(teamId, player)).toBe(betterAtPosition(state, teamId, player));
      }
      // 남의 팀 선수를 그 팀에 대 보는 것도 같은 답이어야 한다 (영입 검토가 그 모양이다)
      for (const player of playersOf(state, "arsenal").slice(0, 5)) {
        expect(depth.betterThan(teamId, player)).toBe(betterAtPosition(state, teamId, player));
      }
    }
    // 선수가 없는 팀은 0 — 색인에 칸 자체가 없다
    const anyone = playersOf(state, "chelsea")[0]!;
    expect(depth.betterThan("존재하지않는팀", anyone)).toBe(0);
  });
});

describe("정보 비대칭", () => {
  it("우리 선수·스카우팅 완료는 정확하고, 평판뿐이면 흐려진다", () => {
    const state = createTestGame(42);
    const target = state.players.find(
      (p) => p.teamId !== state.userTeamId && knowledgeOf(state, p.id) === "rumoured",
    )!;
    const odds = dealOdds(state, {
      playerId: target.id,
      fee: askingPriceFor(state, target),
      weeklyWage: wageExpectationOf(state, target),
      years: 4,
    });
    expect(odds.fuzzy).toBe(true);
    // 같은 질문에 같은 답 (결정적)
    expect(
      dealOdds(state, {
        playerId: target.id,
        fee: askingPriceFor(state, target),
        weeklyWage: wageExpectationOf(state, target),
        years: 4,
      }).probability,
    ).toBe(odds.probability);

    // 스카우팅을 끝내면 안개가 걷힌다
    state.scoutReports.push({
      id: `scout-${target.id}`,
      gamePlayerId: target.id,
      requestedOn: state.date,
      dueOn: state.date,
      completedOn: state.date,
    });
    const clear = dealOdds(state, {
      playerId: target.id,
      fee: askingPriceFor(state, target),
      weeklyWage: wageExpectationOf(state, target),
      years: 4,
    });
    expect(clear.fuzzy).toBe(false);
  });
});

describe("응답 지연 — 상황에서 나온다", () => {
  it("같은 조건은 같은 답, 반복하면 상대가 미룬다", () => {
    const state = createTestGame(42);
    const target = pick(state, 78);
    const terms = { playerId: target.id, fee: 1_000_000, weeklyWage: 10_000, years: 4 };
    const once = responseDelayDays(state, terms, 45);
    expect(responseDelayDays(state, terms, 45)).toBe(once);
    expect(responseDelayDays(state, terms, 45, 2)).toBe(once + 1);
  });

  /**
   * 답신 시점이 한 값에 고정되면 모든 협상이 "내일 답 옴"으로 균질해진다.
   * 실제로는 그 자리에서 끝나는 전화도 있고, 몇 주째 소식 없는 오퍼도 있다.
   */
  it("즉답도 있고 한참 늦는 답도 있다", () => {
    const state = createTestGame(42);
    const days = Array.from({ length: 300 }, (_, i) =>
      responseDelayDays(
        state,
        { playerId: `p-${i}`, fee: 20_000_000 + i * 130_000, weeklyWage: 90_000, years: 4 },
        45,
      ),
    );
    // 답신일이 오늘보다 앞설 수는 없다 (해시를 부호 있는 시프트로 자르면 음수가 나왔다)
    expect(Math.min(...days)).toBeGreaterThanOrEqual(0);
    expect(new Set(days).size).toBeGreaterThan(3);
    expect(days.some((d) => d >= 7)).toBe(true);
  });

  it("헐값은 볼 것도 없이 차이고, 매력적인 오퍼는 그날 답이 오기도 한다", () => {
    const state = createTestGame(42);
    const terms = (i: number) => ({
      playerId: `p-${i}`,
      fee: 1_000_000 + i * 90_000,
      weeklyWage: 10_000,
      years: 4,
    });
    const cheap = Array.from({ length: 200 }, (_, i) => responseDelayDays(state, terms(i), 5));
    const eager = Array.from({ length: 200 }, (_, i) => responseDelayDays(state, terms(i), 85));

    expect(cheap.filter((d) => d <= 1).length / cheap.length).toBeGreaterThan(0.7);
    expect(cheap.some((d) => d === 0)).toBe(true);
    expect(eager.some((d) => d === 0)).toBe(true);
  });

  it("창 마감이 임박하면 절반으로 줄어든다", () => {
    const state = createTestGame(42);
    const target = pick(state, 78);
    const terms = (i: number) => ({
      playerId: target.id,
      fee: 20_000_000 + i * 250_000,
      weeklyWage: 90_000,
      years: 4,
    });
    /**
     * **한 건씩 견줄 수 없다** — 날짜가 해시에 들어가므로 마감일의 한 건은 평시의
     * 그 건과 다른 뽑기다. 절반은 분포의 성질이라 분포로 잰다.
     */
    const sample = 200;
    const normal = Array.from({ length: sample }, (_, i) => responseDelayDays(state, terms(i), 45));
    state.date = state.windows[0]!.closesOn;
    const rushed = Array.from({ length: sample }, (_, i) => responseDelayDays(state, terms(i), 45));
    const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // 버림이 걸려 실제로는 절반보다 조금 적다 — 반올림 한 칸만 여유를 둔다
    expect(mean(rushed)).toBeLessThanOrEqual(mean(normal) / 2 + 0.5);
    expect(Math.min(...rushed)).toBeGreaterThanOrEqual(0);
  });
});

/**
 * 계약 지위 — **약속이 흥정의 손잡이가 되는 자리** (transfer.md §3 · people.md §5-2).
 * 「출전 기회」가 사실(그 자리가 막혀 있는가)을 재고, 이 축이 약속(뭐라고 부르며
 * 제시했는가)을 잰다.
 */
describe("계약 지위가 관문에 선다", () => {
  const state = createTestGame(42);
  const ours = playersOf(state, state.userTeamId);
  const factorOf = (odds: ReturnType<typeof dealOdds>, label: string) =>
    odds.factors.find((f) => f.label === label);
  const renewAs = (player: GamePlayer, squadStatus?: (typeof SQUAD_STATUSES)[number]) =>
    dealOdds(state, {
      kind: "renew",
      playerId: player.id,
      fee: 0,
      weeklyWage: renewalExpectation(state, player),
      years: 3,
      ...(squadStatus ? { squadStatus } : {}),
    });

  /** 지위가 실제 자리와 갈릴 여지가 가장 큰 자원 — 자리가 막힌 선수다 */
  const blocked = [...ours].sort(
    (a, b) =>
      betterAtPosition(state, state.userTeamId, b) - betterAtPosition(state, state.userTeamId, a),
  )[0]!;

  it("한 칸 올려 부를수록 확률이 오른다 — 단조롭다", () => {
    const odds = SQUAD_STATUSES.map((status) => renewAs(blocked, status).probability);
    for (let i = 1; i < odds.length; i += 1) {
      expect(odds[i]!, `${SQUAD_STATUSES[i]} < ${SQUAD_STATUSES[i - 1]}`).toBeGreaterThanOrEqual(
        odds[i - 1]!,
      );
    }
    // 사다리의 양끝은 실제로 갈라져야 한다 — 전부 같으면 축이 죽은 것이다
    expect(odds[odds.length - 1]!).toBeGreaterThan(odds[0]!);
  });

  it("말하지 않은 것은 약속이 아니다 — 제시가 없으면 축이 서지 않는다", () => {
    expect(factorOf(renewAs(blocked), "계약 지위")).toBeUndefined();
    // 실제 자리를 그대로 부른 것도 거리가 0이라 서지 않는다
    const actual = derivedSquadStatus(state, blocked, state.userTeamId);
    expect(factorOf(renewAs(blocked, actual), "계약 지위")).toBeUndefined();
    expect(renewAs(blocked, actual).probability).toBe(renewAs(blocked).probability);
  });

  it("올려 부르면 +, 낮춰 부르면 − — 부호가 자리를 따른다", () => {
    const actual = derivedSquadStatus(state, blocked, state.userTeamId);
    const rank = squadStatusRank(actual);
    const up = SQUAD_STATUSES[Math.min(rank + 1, SQUAD_STATUSES.length - 1)]!;
    const down = SQUAD_STATUSES[Math.max(rank - 1, 0)]!;
    if (up !== actual)
      expect(factorOf(renewAs(blocked, up), "계약 지위")!.delta).toBeGreaterThan(0);
    if (down !== actual) {
      expect(factorOf(renewAs(blocked, down), "계약 지위")!.delta).toBeLessThan(0);
    }
  });
});

/**
 * **에이전트 원형 → 시장 프로필** (→ docs/simulation/transfer.md §3).
 *
 * 재는 것은 표의 성질과 배선이다: 세 열의 평균이 1인가(밀리면 원형이 아니라 세계의
 * 눈금을 옮긴 것이다), 대리인이 없는 자리가 정확히 중립인가, 그리고 `askingLift`가
 * 선수마다 **그 원형의 배수 그대로** 값에 걸리는가.
 */
describe("에이전트 원형이 시장의 숫자에 걸린다", () => {
  const profiles = Object.values(AGENT_PROFILE);
  const mean = (pick: (p: (typeof profiles)[number]) => number) =>
    profiles.reduce((acc, p) => acc + pick(p), 0) / profiles.length;

  it("곱해지는 세 열의 평균이 1이다 — 원형은 눈금을 옮기지 않는다", () => {
    // 대리인은 시드로 균등하게 뽑히므로(`agentForPlayer`) 평균이 곧 세계의 눈금이다
    expect(mean((p) => p.askingLift)).toBeCloseTo(1, 2);
    expect(mean((p) => p.patience)).toBeCloseTo(1, 2);
    expect(mean((p) => p.delayDays)).toBeCloseTo(1, 2);
  });

  it("대리인이 없으면 전부 중립이다 — 명부를 비운 세이브는 지금과 같은 숫자다", () => {
    expect(NO_AGENT_PROFILE).toEqual({
      askingLift: 1,
      patience: 1,
      delayDays: 1,
      ultimatumDays: 0,
      competingBidRate: 0,
    });
  });

  it("선수 쪽 주급 기대가 그 원형의 배수만큼 갈린다", () => {
    const state = createTestGame(42);
    const seen = new Set<string>();
    for (const player of playersOf(state, state.userTeamId)) {
      const agent = agentOfPlayer(state, player.id);
      if (!agent) continue;
      seen.add(agent.archetype);
      const lift = agentProfileOf(state, player.id).askingLift;
      expect(lift).toBe(AGENT_PROFILE[agent.archetype].askingLift);
      // 원형을 걷어 낸 값 — `wageExpectationOf`가 그 위에 배수만 얹는다
      const neutral = Math.max(
        (activeContract(state, player.id)?.weeklyWage ?? 0) * 1.15,
        wageByRating(player.attributes.overall),
      );
      const want = wageExpectationOf(state, player);
      expect(want).toBe(Math.round((neutral * lift) / 1_000) * 1_000);
      // 배수가 크면 더 부르고 작으면 덜 부른다 — 단조성
      const plain = Math.round(neutral / 1_000) * 1_000;
      if (lift > 1) expect(want).toBeGreaterThanOrEqual(plain);
      if (lift < 1) expect(want).toBeLessThanOrEqual(plain);
    }
    // 스쿼드 하나면 세 원형이 다 나온다 — 하나만 나오면 추첨이 죽은 것이다
    expect(seen.size).toBeGreaterThan(1);
  });

  it("응답 지연이 원형의 배수만큼 갈린다 — 표본의 합으로", () => {
    const state = createTestGame(42);
    const total = new Map<string, { sum: number; n: number }>();
    for (const player of state.players.slice(0, 600)) {
      const agent = agentOfPlayer(state, player.id);
      if (!agent) continue;
      const days = responseDelayDays(
        state,
        { playerId: player.id, fee: 20_000_000, weeklyWage: 90_000, years: 4 },
        45,
      );
      const row = total.get(agent.archetype) ?? { sum: 0, n: 0 };
      total.set(agent.archetype, { sum: row.sum + days, n: row.n + 1 });
    }
    const avg = (key: keyof typeof AGENT_PROFILE) => {
      const row = total.get(key)!;
      return row.sum / row.n;
    };
    // 원형이 지연에 곱해지므로 표본 평균의 순서가 표의 순서를 따른다
    expect(avg("empire")).toBeLessThan(avg("lawyer"));
    expect(avg("lawyer")).toBeLessThan(avg("hardballer"));
  });
});

/**
 * **경쟁 입찰이 호가를 올린다 — 그러나 조정 구간 밖으로는 못 민다**
 * (→ docs/simulation/transfer.md §1-2).
 *
 * 상한이 `COUNTER_CEILING`인 것이 규칙이다: 그 위로 밀면 상대가 부를 수 있는 값이
 * 자기 호가보다 낮아진다.
 */
describe("경쟁 입찰과 호가", () => {
  it("한 줄마다 오르고, 누적은 COUNTER_CEILING에서 멈춘다", () => {
    const state = createTestGame(42);
    const target = pick(state, 78);
    const base = askingPriceFor(state, target);
    const rivals = state.teams.filter((t) => t.id !== state.userTeamId).slice(0, 6);
    let previous = base;
    for (const [i, rival] of rivals.entries()) {
      (state.competingBids ??= []).push({
        gamePlayerId: target.id,
        teamId: rival.id,
        date: state.date,
        lift: COMPETING_BID_LIFT,
      });
      const now = askingPriceFor(state, target);
      expect(now, `${i + 1}번째 입찰`).toBeGreaterThanOrEqual(previous);
      if (i === 0) expect(now).toBeGreaterThan(base);
      previous = now;
      expect(competingBidLiftOf(state, target.id)).toBeLessThanOrEqual(COUNTER_CEILING);
    }
    // 여섯 줄이 서도 호가는 상한 안이다 (10만 단위 반올림 한 칸까지)
    expect(previous).toBeLessThanOrEqual(Math.round(base * COUNTER_CEILING) + 100_000);
  });

  it("입찰이 없으면 호가는 그대로다", () => {
    const state = createTestGame(42);
    const target = pick(state, 78);
    expect(competingBidLiftOf(state, target.id)).toBe(1);
  });
});

/**
 * 사전 계약 — 창이 아니라 **계약의 만료일**이 여는 시장 (transfer.md §1-4).
 * 재는 것은 그 창의 경계와, 창 안에서 관문이 하나로 줄었다는 사실이다.
 */
describe("사전 계약 — 반년 앞의 시장", () => {
  const state = createTestGame(42);
  // 이 갈래가 창과 무관하다는 것이 재는 대상이므로 픽스처의 창은 전부 닫아 둔다
  for (const w of state.windows) w.opensOn = "2099-01-01";
  const target = state.players.find(
    (p) => p.teamId !== state.userTeamId && isClubTeam(p.teamId) && activeContract(state, p.id),
  )!;
  const contract = activeContract(state, target.id)!;
  const leaving = (days: number) => {
    contract.until = addDays(state.date, days);
  };
  const offer = (fee: number) =>
    dealOdds(state, { kind: "buy", playerId: target.id, fee, weeklyWage: 1, years: 3 });
  const factorOf = (odds: ReturnType<typeof dealOdds>, label: string) =>
    odds.factors.find((f) => f.label === label);

  it("창의 경계는 잔여 PRECONTRACT_DAYS다 — 하루 더면 밖이다", () => {
    leaving(PRECONTRACT_DAYS);
    expect(precontractDaysLeft(state, target.id)).toBe(PRECONTRACT_DAYS);
    leaving(PRECONTRACT_DAYS + 1);
    expect(precontractDaysLeft(state, target.id)).toBeNull();
    // 만료 당일은 아직 남의 선수라 창 안이고, 하루 지나면 무소속 영입이다
    leaving(0);
    expect(precontractDaysLeft(state, target.id)).toBe(0);
    leaving(-1);
    expect(precontractDaysLeft(state, target.id)).toBeNull();
  });

  it("창 안의 이적료 0은 창도 이적 예산도 묻지 않는다", () => {
    leaving(PRECONTRACT_DAYS);
    const blockers = offer(0).blockers.join();
    expect(blockers).not.toContain("이적시장이 닫혀 있습니다");
    expect(blockers).not.toContain("이적 예산을 넘습니다");
  });

  it("관문이 하나다 — 파는 구단이 근거에 서지 않는다", () => {
    leaving(PRECONTRACT_DAYS);
    const odds = offer(0);
    expect(factorOf(odds, "제시 이적료")).toBeUndefined();
    expect(factorOf(odds, "상대 사정")).toBeUndefined();
    // 이 판이 무엇인지 말하는 줄은 선다 — 확률을 움직이는 항이 아니라 delta는 0이다
    const line = factorOf(odds, "사전 계약");
    expect(line?.delta).toBe(0);
    expect(line?.why).toContain(precontractStartOf(state));
  });

  it("창 밖의 이적료 0은 그냥 헐값 오퍼다 — 창 관문이 그대로 선다", () => {
    leaving(PRECONTRACT_DAYS + 1);
    expect(offer(0).blockers.join()).toContain("이적시장이 닫혀 있습니다");
    expect(offer(0).factors.find((f) => f.label === "제시 이적료")).toBeDefined();
  });

  it("이미 다른 구단과 예약한 선수는 막힌다", () => {
    leaving(PRECONTRACT_DAYS);
    const rivalTeamId = state.players.find(
      (p) => p.teamId !== state.userTeamId && p.teamId !== target.teamId && isClubTeam(p.teamId),
    )!.teamId;
    const startsOn = precontractStartOf(state);
    state.contracts.push({
      id: "contract-precontract-test",
      gamePlayerId: target.id,
      teamId: rivalTeamId,
      weeklyWage: 10_000,
      since: startsOn,
      until: addDays(startsOn, 364),
      status: "pending",
    });
    expect(offer(0).blockers.join()).toContain("사전 계약을 맺었습니다");
  });
});
