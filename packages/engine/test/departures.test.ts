import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOAN_WAGE_SHARE,
  DEPARTURE_SQUAD_MORALE,
  SEVERANCE_RATE,
  SEVERANCE_WEEKS_CAP,
  activeContract,
  addDays,
  loanPlayer,
  loanedOut,
  moraleToForm,
  playersOf,
  recallLoan,
  releasePlayer,
  severanceOf,
  unilateralSeveranceOf,
  userPlayers,
  userTactics,
  weeklyWagesOf,
  type GameState,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

/**
 * 팀을 떠나는 다른 길들 — 방출·임대 (departures.ts).
 * 둘 다 **대가가 분명한 선택**이라 밸런스가 흔들리지 않는다:
 * 방출은 돈을 잃고, 임대는 전력을 잃는다.
 */

/** 주전이 아닌 선수 — 스쿼드 하한에 걸리지 않게 뒤에서 고른다 */
const spare = (state: GameState) => {
  const squad = userPlayers(state).sort((a, b) => a.attributes.overall - b.attributes.overall);
  return squad.find((p) => p.positions[0]?.position !== "GK") ?? squad[0]!;
};

describe("일방 해지 — 전액을 물고 자리를 비운다", () => {
  it("위약금을 물고 계약이 끝난다 — 주급 총액에서 사라진다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    const wagesBefore = weeklyWagesOf(state, state.userTeamId);
    const severance = severanceOf(state, target.id);
    expect(severance).toBeGreaterThan(0);

    const res = releasePlayer(state, { playerId: target.id });
    expect(res.ok, res.message).toBe(true);
    expect(activeContract(state, target.id)?.teamId).not.toBe(state.userTeamId);
    expect(weeklyWagesOf(state, state.userTeamId)).toBeLessThan(wagesBefore);
  });

  /**
   * **일방 해지의 값이 협상의 바깥값이다** (transfer.md §2·§11). 합의 앵커와 같은
   * 값을 물면 흥정할 이유가 사라지고, 선수가 무엇을 받아들일 까닭도 없어진다.
   */
  it("협상 없이 끊으면 잔여 급여 전액을 문다 — 합의 앵커의 두 배", () => {
    const state = createTestGame(11);
    const target = spare(state);
    const anchor = severanceOf(state, target.id);
    const full = unilateralSeveranceOf(state, target.id);
    expect(full).toBe(Math.round(anchor / SEVERANCE_RATE));

    const balanceBefore = state.finances.find((f) => f.teamId === state.userTeamId)!.balance;
    expect(releasePlayer(state, { playerId: target.id }).ok).toBe(true);
    const finance = state.finances.find((f) => f.teamId === state.userTeamId)!;
    expect(balanceBefore - finance.balance).toBe(full);
  });

  /** 협상이 정한 값으로도 같은 문을 지난다 — 종착지가 하나여야 원장이 한 벌이다 */
  it("합의된 정산금이 실려 오면 그 값만 나간다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    const agreed = Math.round(severanceOf(state, target.id) * 0.6);
    const balanceBefore = state.finances.find((f) => f.teamId === state.userTeamId)!.balance;

    expect(releasePlayer(state, { playerId: target.id, severance: agreed }).ok).toBe(true);
    const finance = state.finances.find((f) => f.teamId === state.userTeamId)!;
    expect(balanceBefore - finance.balance).toBe(agreed);
    expect(finance.ledger.some((e) => e.label.includes("계약 해지 정산금"))).toBe(true);
  });

  it("위약금이 원장에 남는다 — PSR까지 간다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    releasePlayer(state, { playerId: target.id });
    const finance = state.finances.find((f) => f.teamId === state.userTeamId)!;
    expect(finance.ledger.some((e) => e.label.includes("계약 해지 위약금"))).toBe(true);
  });

  it("떠난 선수는 우리 스쿼드에 없다 — 무소속으로 남기지 않는다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    releasePlayer(state, { playerId: target.id });
    expect(playersOf(state, state.userTeamId).some((p) => p.id === target.id)).toBe(false);
    expect(state.players.find((p) => p.id === target.id)!.teamId).not.toBe(state.userTeamId);
    expect(userTactics(state).assignments.some((a) => a.playerId === target.id)).toBe(false);
  });

  it("타 팀 선수는 방출할 수 없다", () => {
    const state = createTestGame(11);
    const theirs = playersOf(state, "chelsea").find((p) => p.teamId !== state.userTeamId)!;
    expect(releasePlayer(state, { playerId: theirs.id }).ok).toBe(false);
  });
});

/**
 * 방출이 라커룸에 남기는 것 — **돈으로만 끝나지 않는다** (transfer.md §2).
 * 회견이 열리느냐와 사기가 움직이느냐가 **같은 문**을 지나므로, 한쪽만 움직이면
 * 조용히 어긋난다.
 */
describe("방출의 여파 — 회견과 남은 선수단", () => {
  /** 스쿼드에서 가장 좋은 선수 — 회견이 열리는 쪽 */
  const core = (state: GameState) =>
    [...userPlayers(state)].sort((a, b) => b.attributes.overall - a.attributes.overall)[0]!;

  /** 남은 1군의 폼을 선수별로 — 순서에 기대지 않는다 */
  const formsById = (state: GameState) =>
    new Map(
      userPlayers(state)
        .filter((p) => p.squadLevel !== "reserve")
        .map((p) => [p.id, p.state.form] as const),
    );

  it("핵심 자원이 나가면 회견이 열리고 남은 1군의 사기가 내려간다", () => {
    const state = createTestGame(11);
    const target = core(state);
    const before = formsById(state);

    expect(releasePlayer(state, { playerId: target.id }).ok).toBe(true);

    const press = state.pressConferences?.find((c) => c.status === "pending");
    expect(press?.facts[0]?.kind).toBe("departure");
    expect(press?.facts[0]?.about).toBe(target.id);
    // 카드는 장부 한 줄이다 — 물음표도 평가어도 없다
    expect(press?.facts[0]?.text).not.toContain("?");

    const after = formsById(state);
    expect(after.has(target.id)).toBe(false);
    const drop = moraleToForm(DEPARTURE_SQUAD_MORALE);
    for (const [id, form] of after) expect(form).toBeCloseTo(before.get(id)! + drop, 10);
  });

  it("백업 정리는 회견도 사기도 움직이지 않는다 — 회견이 흔해지면 무게를 잃는다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    const before = formsById(state);

    expect(releasePlayer(state, { playerId: target.id }).ok).toBe(true);

    expect(state.pressConferences?.some((c) => c.status === "pending")).toBeFalsy();
    const after = formsById(state);
    expect(after.has(target.id)).toBe(false);
    for (const [id, form] of after) expect(form).toBeCloseTo(before.get(id)!, 10);
  });
});

describe("임대 — 전력을 내주고 성장을 산다", () => {
  it("보내면 상대 팀 선수가 되고 복귀일이 남는다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    target.squadNumber = 77;
    const res = loanPlayer(state, { playerId: target.id, teamId: "chelsea" });
    expect(res.ok, res.message).toBe(true);
    const after = state.players.find((p) => p.id === target.id)!;
    expect(after.teamId).toBe("chelsea");
    expect(after.squadNumber).toBeTypeOf("number");
    expect(
      playersOf(state, "chelsea").filter((p) => p.squadNumber === after.squadNumber),
    ).toHaveLength(1);
    expect(after.loan!.fromTeamId).toBe(state.userTeamId);
    expect(after.loan!.wageShare).toBe(DEFAULT_LOAN_WAGE_SHARE);
    expect(loanedOut(state).some((p) => p.id === target.id)).toBe(true);
    expect(state.transfers.some((t) => t.gamePlayerId === target.id && t.type === "loan")).toBe(
      true,
    );
  });

  it("주급을 나눠 낸다 — 계약은 우리 것으로 남는다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    const wage = activeContract(state, target.id)!.weeklyWage;
    const before = weeklyWagesOf(state, state.userTeamId);
    loanPlayer(state, { playerId: target.id, teamId: "chelsea", wageShare: 0.5 });
    expect(activeContract(state, target.id)!.teamId).toBe(state.userTeamId);
    expect(weeklyWagesOf(state, state.userTeamId)).toBeCloseTo(before - wage * 0.5, 0);
  });

  it("계약보다 길게 보낼 수 없다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    const res = loanPlayer(state, {
      playerId: target.id,
      teamId: "chelsea",
      until: "2099-06-30",
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("계약이");
  });

  it("불러들이면 2군으로 돌아온다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    loanPlayer(state, { playerId: target.id, teamId: "chelsea" });
    target.squadNumber = 88;
    const res = recallLoan(state, { playerId: target.id });
    expect(res.ok, res.message).toBe(true);
    const after = state.players.find((p) => p.id === target.id)!;
    expect(after.teamId).toBe(state.userTeamId);
    expect(after.squadNumber).toBeTypeOf("number");
    expect(
      playersOf(state, state.userTeamId).filter((p) => p.squadNumber === after.squadNumber),
    ).toHaveLength(1);
    expect(after.squadLevel).toBe("reserve");
    expect(after.loan).toBeUndefined();
  });

  it("임대 중인 선수는 방출할 수 없다 — 먼저 불러들여야 한다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    loanPlayer(state, { playerId: target.id, teamId: "chelsea" });
    const res = releasePlayer(state, { playerId: target.id });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("임대 중");
  });
});

/**
 * 해지 값의 눈금 — 합의의 앵커는 **잔여 계약 주급의 절반**, 일방 해지는 전액이고,
 * 세는 데 양 끝이 있다. 상한이 없으면 5년 계약 하나가 구단을 파산시키고, 하한이
 * 없으면 이미 끝난 계약이 음수 주 수로 돈을 만든다.
 */
describe("해지 값의 양 끝", () => {
  /** 픽스처는 describe당 하나 — 세 케이스가 같은 선수의 계약 만료일만 옮겨 쓴다 */
  const state = createTestGame(11);
  const target = spare(state);
  const contract = activeContract(state, target.id)!;

  const severanceWith = (until: string) => {
    contract.until = until;
    return severanceOf(state, target.id);
  };

  it("잔여 주 수 × 주급 × 절반이다", () => {
    expect(severanceWith(addDays(state.date, 70))).toBe(
      Math.round(contract.weeklyWage * 10 * SEVERANCE_RATE),
    );
  });

  it("아무리 긴 계약도 104주까지만 센다", () => {
    const capped = Math.round(contract.weeklyWage * SEVERANCE_WEEKS_CAP * SEVERANCE_RATE);
    expect(severanceWith(addDays(state.date, 7 * SEVERANCE_WEEKS_CAP))).toBe(capped);
    // 그 너머는 한 푼도 더 붙지 않는다
    expect(severanceWith(addDays(state.date, 7 * SEVERANCE_WEEKS_CAP * 3))).toBe(capped);
  });

  it("이미 끝난 계약은 0이다 — 음수 주 수가 돈을 만들지 않는다", () => {
    expect(severanceWith(state.date)).toBe(0);
    expect(severanceWith(addDays(state.date, -700))).toBe(0);
  });

  it("일방 해지도 같은 양 끝을 쓴다 — 비율만 다르다", () => {
    contract.until = addDays(state.date, 70);
    expect(unilateralSeveranceOf(state, target.id)).toBe(contract.weeklyWage * 10);
    contract.until = addDays(state.date, 7 * SEVERANCE_WEEKS_CAP * 3);
    expect(unilateralSeveranceOf(state, target.id)).toBe(contract.weeklyWage * SEVERANCE_WEEKS_CAP);
    contract.until = addDays(state.date, -700);
    expect(unilateralSeveranceOf(state, target.id)).toBe(0);
  });
});

describe("불만의 수명 — 팀을 떠나면 불만도 끝난다 (people.md §5)", () => {
  /** 픽스처는 describe당 하나 — 문마다 다른 선수를 내보내며 같은 불변식을 잰다 */
  const state = createTestGame(11);
  const gripe = (playerId: string) =>
    state.issues.push({
      gamePlayerId: playerId,
      kind: "unhappy",
      reason: "minutes",
      since: state.date,
    });
  /** 불변식 — 장부의 불만이 전부 지금 우리 스쿼드의 것인가 */
  const noGhosts = () => {
    const ours = new Set(userPlayers(state).map((p) => p.id));
    return state.issues.every((i) => ours.has(i.gamePlayerId));
  };

  it("방출 — 일방 해지 뒤 그 선수의 불만이 장부에 없다", () => {
    const target = spare(state);
    gripe(target.id);
    const res = releasePlayer(state, { playerId: target.id });
    expect(res.ok, res.message).toBe(true);
    expect(state.issues.some((i) => i.gamePlayerId === target.id)).toBe(false);
    expect(noGhosts()).toBe(true);
  });

  it("해지 — 합의 정산도 같은 문을 지나 불만을 지운다", () => {
    const target = spare(state);
    gripe(target.id);
    const res = releasePlayer(state, { playerId: target.id, severance: 0 });
    expect(res.ok, res.message).toBe(true);
    expect(state.issues.some((i) => i.gamePlayerId === target.id)).toBe(false);
    expect(noGhosts()).toBe(true);
  });

  it("임대 송출 — 라커룸을 떠나면 불만도 따라가지 않는다", () => {
    const target = spare(state);
    gripe(target.id);
    const res = loanPlayer(state, { playerId: target.id, teamId: "chelsea" });
    expect(res.ok, res.message).toBe(true);
    expect(state.issues.some((i) => i.gamePlayerId === target.id)).toBe(false);
    expect(noGhosts()).toBe(true);
  });
});
