import { describe, expect, it } from "vitest";
import type { PitchClaim } from "@story-fm/domain";
import {
  dealOdds,
  evaluatePitch,
  playersOf,
  respondOffer,
  sendOffer,
  userPlayers,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

/**
 * 설득 — 숫자로 못 넘는 벽을 넘는 수단 (persuasion.ts · transfer.md §4).
 * 경계선은 하나다: **코어가 사실 대조한 논거만 확률을 움직인다.**
 */

const claim = (kind: PitchClaim["kind"], note?: string): PitchClaim =>
  note === undefined ? { kind } : { kind, note };

/** 사우디 레전드 — 돈으로는 못 데려오는 대표 사례 */
const legendOf = (state: ReturnType<typeof createTestGame>) =>
  playersOf(state, "alnassr").find((p) => p.name.includes("호날두"))!;

describe("사실 대조 — 말만 잘해서는 안 된다", () => {
  it("확인된 논거는 확률을 올리지 않고 **판정 여유**를 연다 — 무게는 LLM 몫", () => {
    const state = createTestGame();
    const legend = legendOf(state);

    // 41세 — "마지막 기회"는 사실이다
    const truth = evaluatePitch(state, legend.id, [claim("last_chance")]);
    expect(truth.verdicts[0]?.verified).toBe(true);
    // 코어는 무게를 매기지 않는다 (표가 없다)
    expect(truth.score).toBe(0);
    expect(truth.latitude).toBeGreaterThan(0);

    // 잉글랜드에서 자라지 않았다면 "고향 복귀"는 거짓이다
    const lie = evaluatePitch(state, legend.id, [claim("homecoming")]);
    if (!lie.verdicts[0]?.verified) {
      expect(lie.score).toBeLessThan(0);
    }
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

  it("주전 보장은 **그 자리가 실제로 비어 있어야** 통한다", () => {
    const state = createTestGame();
    // 우리 최고 선수와 같은 자리의 약한 선수 — 주전 약속이 거짓이 되는 경우
    const ours = userPlayers(state).sort((a, b) => b.attributes.overall - a.attributes.overall)[0]!;
    const weakSamePosition = state.players.find(
      (p) =>
        p.teamId !== state.userTeamId &&
        p.positions[0]?.position === ours.positions[0]?.position &&
        p.attributes.overall < ours.attributes.overall - 10,
    );
    if (!weakSamePosition) return;
    const out = evaluatePitch(state, weakSamePosition.id, [claim("starting_role")]);
    expect(out.verdicts[0]?.verified).toBe(false);
  });
});

describe("확률 — 설득에는 상한이 없다", () => {
  /** 레전드 주급은 £3.9M대다 — 설득이 통해도 헐값에는 안 온다 */
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
    const truthful = truthfulClaimsFor(state, legend.id);
    expect(truthful.length, "사실인 논거가 하나도 없다").toBeGreaterThan(0);

    const persuaded = dealOdds(state, buyTerms(legend.id, truthful));
    expect(persuaded.latitude).toBeGreaterThan(0);
    expect(persuaded.factors.some((f) => f.label === "복귀 저항")).toBe(true);
  });
});

/** 그 선수에게 실제로 사실인 논거만 고른다 */
function truthfulClaimsFor(
  state: ReturnType<typeof createTestGame>,
  playerId: string,
): PitchClaim[] {
  const candidates: PitchClaim["kind"][] = [
    "last_chance",
    "trophy_push",
    "european_football",
    "project_lead",
    "starting_role",
    "compatriot",
    "manager_reputation",
    "homecoming",
    "reunion",
  ];
  return candidates
    .filter((kind) => evaluatePitch(state, playerId, [claim(kind)]).verdicts[0]?.verified)
    .map((kind) => claim(kind));
}

describe("**판정은 LLM이 한다** — 코어는 가능한 판정만 받는다", () => {
  /**
   * 확률이 바닥인 오퍼 — 주급 £3.9M을 기대하는 레전드에게 £20k를 부른다.
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
    const negotiation = state.negotiations.find((n) => n.gamePlayerId === target.id);
    const respondsOn = negotiation?.rounds[0]?.respondsOn;
    if (respondsOn) state.date = respondsOn;
    return { state, target, res, negotiation };
  };

  it("논거가 없으면 바닥 확률의 수락을 코어가 막는다", () => {
    const { state, negotiation, res } = lowballOffer();
    expect(res.ok, res.message).toBe(true);
    const verdict = respondOffer(state, {
      negotiationId: negotiation!.id,
      verdict: "accept",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("응할 구단은 없습니다");
  });

  it("**확인된 논거가 하나라도 있으면 코어는 더 막지 않는다** — 선수가 판단한다", () => {
    const seed = lowballOffer();
    const truthful = truthfulClaimsFor(seed.state, seed.target.id);
    if (truthful.length === 0) return;

    const { state, negotiation, res } = lowballOffer([truthful[0]!]);
    expect(res.ok, res.message).toBe(true);
    expect((negotiation?.pitched ?? []).length).toBeGreaterThan(0);

    const verdict = respondOffer(state, {
      negotiationId: negotiation!.id,
      verdict: "accept",
      note: "고향으로 돌아가고 싶다고 했다",
    });
    // 확률은 여전히 바닥이지만 판정은 선수의 몫이 된다
    expect(negotiation!.rounds[0]!.probability).toBeLessThan(5);
    expect(verdict.ok, verdict.message).toBe(true);
  });

  it("거짓 논거로는 그 문이 열리지 않는다", () => {
    const state = createTestGame();
    state.date = "2026-08-01";
    // 확인되지 않는 주장만 골라 던진다
    const target = legendOf(state);
    const bogus = (["homecoming", "reunion", "other"] as const)
      .map((kind) => claim(kind))
      .filter((c) => !evaluatePitch(state, target.id, [c]).verdicts[0]?.verified);
    if (bogus.length === 0) return;

    sendOffer(state, {
      playerId: target.id,
      fee: 1_000_000,
      weeklyWage: 20_000,
      years: 2,
      pitch: bogus,
    });
    const negotiation = state.negotiations.find((n) => n.gamePlayerId === target.id)!;
    if (negotiation.rounds[0]?.respondsOn) state.date = negotiation.rounds[0].respondsOn;
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
