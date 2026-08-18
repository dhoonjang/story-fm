import { describe, expect, it } from "vitest";
import type { GamePlayer, PitchClaim } from "@story-fm/domain";
import { ageOf, naturalPositionOf } from "@story-fm/domain";
import {
  countryOfTeam,
  dealOdds,
  evaluatePitch,
  playersOf,
  respondOffer,
  sendOffer,
  userPlayers,
  type GameState,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

/**
 * 설득 — 숫자로 못 넘는 벽을 넘는 수단 (persuasion.ts · transfer.md §4).
 * 경계선은 하나다: **코어가 사실 대조한 논거만 확률을 움직인다.**
 */

const claim = (kind: PitchClaim["kind"], note?: string): PitchClaim =>
  note === undefined ? { kind } : { kind, note };

/**
 * 시장 전용 리그의 노장 — 돈으로는 못 데려오는 대표 사례.
 *
 * 이름으로 집으면 시드가 한 줄만 바뀌어도 무너지고 지키는 것은 없다. 이 파일이
 * 필요로 하는 것은 **두 성질**이라 그것으로 고른다: 서른셋 이상(`last_chance`가
 * 사실)이고 우리 나라에서 자라지 않았다(`homecoming`이 거짓).
 */
function legendOf(state: GameState): GamePlayer {
  const ours = countryOfTeam(state.userTeamId);
  const found = [...playersOf(state, "alnassr")]
    .sort((a, b) => b.attributes.overall - a.attributes.overall)
    .find((p) => ageOf(p.birthdate, state.date) >= 33 && p.homegrownCountry !== ours);
  expect(found, "사우디에 33세 이상 외국 출신 선수가 없다").toBeDefined();
  return found!;
}

describe("사실 대조 — 말만 잘해서는 안 된다", () => {
  it("확인된 논거는 확률을 올리지 않고 **판정 여유**를 연다 — 무게는 LLM 몫", () => {
    const state = createTestGame();
    const legend = legendOf(state);

    // 서른셋을 넘겼다 — "마지막 기회"는 사실이다
    const truth = evaluatePitch(state, legend.id, [claim("last_chance")]);
    expect(truth.verdicts[0]?.verified).toBe(true);
    // 코어는 무게를 매기지 않는다 (표가 없다)
    expect(truth.score).toBe(0);
    expect(truth.latitude).toBeGreaterThan(0);

    // 우리 나라에서 자라지 않았으므로 "고향 복귀"는 거짓이고, 거짓에는 대가가 있다
    const lie = evaluatePitch(state, legend.id, [claim("homecoming")]);
    expect(lie.verdicts[0]?.verified).toBe(false);
    expect(lie.score).toBeLessThan(0);
  });

  it("코어가 확인할 수 없는 이야기(other)는 0점 — 서사로만 남는다", () => {
    const state = createTestGame();
    const out = evaluatePitch(state, legendOf(state).id, [
      claim("other", "아들이 이 도시에서 학교를 다니고 싶어 한다"),
    ]);
    expect(out.score).toBe(0);
    expect(out.verdicts[0]?.verified).toBe(false);
  });

  it("같은 논거를 반복하면 다시 쳐주지 않는다 — 반복은 설득이 아니다", () => {
    const state = createTestGame();
    const legend = legendOf(state);
    const first = evaluatePitch(state, legend.id, [claim("last_chance")]);
    expect(first.latitude).toBeGreaterThan(0);
    const again = evaluatePitch(state, legend.id, [claim("last_chance")], first.verified);
    expect(again.latitude).toBe(0);
  });

  it("결정적이다 — 같은 상태·같은 주장이면 같은 판정", () => {
    const state = createTestGame();
    const claims = [claim("last_chance"), claim("trophy_push"), claim("compatriot")];
    expect(evaluatePitch(state, legendOf(state).id, claims)).toEqual(
      evaluatePitch(state, legendOf(state).id, claims),
    );
  });

  /**
   * 자리를 세계에서 찾지 않고 **손으로 세운다** — 우리 최고 선수와 같은 자리에
   * 앉히면 주전 약속은 거짓이고, 그 위로 올려 세우면 사실이 된다. 시드가 어떤
   * 선수를 어디에 두든 두 방향이 다 돈다.
   */
  it("주전 보장은 **그 자리가 실제로 비어 있어야** 통한다", () => {
    const state = createTestGame();
    const ours = userPlayers(state).sort((a, b) => b.attributes.overall - a.attributes.overall)[0]!;
    const rival = state.players.find((p) => p.teamId !== state.userTeamId)!;
    rival.positions = ours.positions.map((slot) => ({ ...slot }));
    expect(naturalPositionOf(rival).position).toBe(naturalPositionOf(ours).position);

    rival.attributes = { ...rival.attributes, overall: ours.attributes.overall - 10 };
    expect(evaluatePitch(state, rival.id, [claim("starting_role")]).verdicts[0]?.verified).toBe(
      false,
    );

    // 그 자리의 누구보다 나으면 같은 약속이 사실이 된다
    rival.attributes = { ...rival.attributes, overall: 99 };
    expect(evaluatePitch(state, rival.id, [claim("starting_role")]).verdicts[0]?.verified).toBe(
      true,
    );
  });
});

describe("확률 — 설득에는 상한이 없다", () => {
  /** 노장의 기대 주급은 수백만 파운드대다 — 설득이 통해도 헐값에는 안 온다 */
  const buyTerms = (playerId: string, pitch?: PitchClaim[]) => ({
    playerId,
    fee: 20_000_000,
    weeklyWage: 3_200_000,
    years: 2,
    ...(pitch ? { pitch } : {}),
  });

  it("논거는 확률이 아니라 여유를 연다", () => {
    const state = createTestGame();
    state.date = "2026-08-01";
    const legend = legendOf(state);

    const bare = dealOdds(state, buyTerms(legend.id));
    const pitched = dealOdds(state, buyTerms(legend.id, [claim("last_chance")]));

    // 확률은 그대로 — 코어가 마음의 무게를 계산하지 않는다
    expect(pitched.probability).toBe(bare.probability);
    expect(bare.latitude).toBe(0);
    expect(pitched.latitude).toBeGreaterThan(0);
  });

  it("복귀 저항은 남아 있고, 그 위에 여유가 얹힌다 — 없앤 게 아니라 넘는 것", () => {
    const state = createTestGame();
    state.date = "2026-08-01";
    const legend = legendOf(state);

    const persuaded = dealOdds(state, buyTerms(legend.id, [claim("last_chance")]));
    expect(persuaded.latitude).toBeGreaterThan(0);
    expect(persuaded.factors.some((f) => f.label === "복귀 저항")).toBe(true);
  });
});

describe("**판정은 LLM이 한다** — 코어는 가능한 판정만 받는다", () => {
  /**
   * 확률이 바닥인 오퍼 — 수백만 파운드를 기대하는 노장에게 £20k를 부른다.
   * 답이 오는 날까지 시계를 돌려 판정 가능한 상태로 만든다.
   */
  const lowballOffer = (pitch?: PitchClaim[]) => {
    const state = createTestGame();
    state.date = "2026-08-01";
    const target = legendOf(state);
    const res = sendOffer(state, {
      playerId: target.id,
      fee: 1_000_000,
      weeklyWage: 20_000,
      years: 2,
      ...(pitch ? { pitch } : {}),
    });
    expect(res.ok, res.message).toBe(true);
    const negotiation = state.negotiations.find((n) => n.gamePlayerId === target.id)!;
    expect(negotiation, "오퍼가 협상을 열지 않았다").toBeDefined();
    const respondsOn = negotiation.rounds[0]?.respondsOn;
    if (respondsOn) state.date = respondsOn;
    return { state, target, negotiation };
  };

  it("논거가 없으면 바닥 확률의 수락을 코어가 막는다", () => {
    const { state, negotiation } = lowballOffer();
    expect(negotiation.rounds[0]!.probability).toBeLessThan(5);
    const verdict = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "accept",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("응할 구단은 없습니다");
  });

  it("**확인된 논거가 하나라도 있으면 코어는 더 막지 않는다** — 선수가 판단한다", () => {
    const { state, target, negotiation } = lowballOffer([claim("last_chance")]);
    // 서른셋을 넘긴 선수라 이 논거는 언제나 사실이다
    expect(evaluatePitch(state, target.id, [claim("last_chance")]).verdicts[0]?.verified).toBe(
      true,
    );
    expect(negotiation.pitched ?? []).toEqual(["last_chance"]);

    const verdict = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "accept",
      note: "마지막 기회라고 했다",
    });
    // 확률은 여전히 바닥이지만 판정은 선수의 몫이 된다
    expect(negotiation.rounds[0]!.probability).toBeLessThan(5);
    expect(verdict.ok, verdict.message).toBe(true);
  });

  it("거짓 논거로는 그 문이 열리지 않는다", () => {
    // `homecoming`은 legendOf가 거짓임을 보장하고, `other`는 코어가 절대 확인하지 못한다
    const { state, negotiation } = lowballOffer([
      claim("homecoming"),
      claim("other", "아들이 이 도시에서 학교를 다니고 싶어 한다"),
    ]);
    expect(negotiation.pitched ?? []).toEqual([]);
    const verdict = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "accept",
    });
    expect(verdict.ok).toBe(false);
  });
});

describe("오퍼에 실린 설득", () => {
  it("협상에 인정된 논거가 누적된다 — 다음 오퍼에서 재사용해도 안 오른다", () => {
    const state = createTestGame();
    state.date = "2026-08-01";
    const target = state.players.find(
      (p) => p.teamId !== state.userTeamId && p.attributes.overall < 70,
    )!;

    const res = sendOffer(state, {
      playerId: target.id,
      fee: 8_000_000,
      weeklyWage: 60_000,
      years: 3,
      pitch: [claim("starting_role", "네가 우리 1번 선택이다")],
    });
    expect(res.ok, res.message).toBe(true);

    const negotiation = state.negotiations.find((n) => n.gamePlayerId === target.id);
    expect(negotiation).toBeDefined();
    // 통한 논거만 누적된다
    const accepted = evaluatePitch(state, target.id, [claim("starting_role")]).verified;
    expect(negotiation?.pitched ?? []).toEqual(accepted);
  });
});
