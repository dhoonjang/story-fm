import { describe, expect, it } from "vitest";
import {
  MATCH_ATTR_CAP,
  MATCH_FAMILIARITY_MAX,
  MATCH_FAMILIARITY_MIN,
  applyMatchAttributes,
  applyMatchFamiliarity,
  assignmentsOf,
  playerById,
  settleMatchRating,
  userPlayers,
} from "@story-fm/engine";
import { advanceToMatchday, createTestGame, playMockMatch } from "./helpers";

/**
 * 경기가 주는 전술 적응도 — **판정만이 올린다.**
 *
 * 코어는 경기 처리에서 아무것도 올리지 않고, 얼마나 오를지도 정하지 않는다.
 * 출전 시간은 판정에게 참고로만 넘어간다 — 90분을 뛰고도 늘 하던 대로만 했으면 남는
 * 게 없고, 20분을 뛰고도 새 요구를 겪었으면 남는다. 그 판단은 사건을 읽은 쪽의 몫이다.
 *
 * 코어가 지키는 건 **범위 하나**다.
 */
describe("경기 출전의 전술 적응도", () => {
  it("코어는 범위만 지킨다 — −2~8", () => {
    const state = createTestGame(7);
    const target = assignmentsOf(state, state.userTeamId, "starting")[0]!;
    const famOf = () =>
      assignmentsOf(state, state.userTeamId).find((a) => a.playerId === target.playerId)!
        .familiarity;

    target.familiarity = 50;
    applyMatchFamiliarity(state, [{ playerId: target.playerId, gain: 99 }]);
    // 판정은 8까지만 접히고, 그 8도 곡선·흡수율만큼 깎여 들어간다 —
    // **상한을 넘지 않는다**는 것이 계약이다
    expect(famOf() - 50, "상한을 넘었다").toBeLessThanOrEqual(MATCH_FAMILIARITY_MAX);
    expect(famOf() - 50, "아무것도 안 올랐다").toBeGreaterThan(0);

    // 못 따라간 경기는 오히려 흐트러진다 — 다만 폭은 하한까지다
    target.familiarity = 50;
    applyMatchFamiliarity(state, [{ playerId: target.playerId, gain: -99 }]);
    expect(famOf() - 50, "하한을 넘었다").toBe(MATCH_FAMILIARITY_MIN);
  });

  it("출전 시간은 코어가 강제하지 않는다 — 모델이 정한 값이 그대로 들어간다", () => {
    const state = createTestGame(7);
    const target = assignmentsOf(state, state.userTeamId, "starting")[0]!;
    target.familiarity = 50;
    // 예전엔 출전 시간으로 계산한 기준에서 ±3까지만 허용했다. 이제 그 울타리는 없다 —
    // "짧게 뛰었지만 새 요구를 정면으로 겪었다"를 판정이 말할 수 있어야 한다.
    // 값은 그 선수의 곡선·흡수율만큼만 깎이고, 판정끼리의 **순서는 뒤집히지 않는다**
    const after = (gain: number) => {
      target.familiarity = 50;
      applyMatchFamiliarity(state, [{ playerId: target.playerId, gain }]);
      return assignmentsOf(state, state.userTeamId).find((a) => a.playerId === target.playerId)!
        .familiarity;
    };
    expect(after(7)).toBeGreaterThan(after(3));
    expect(after(3)).toBeGreaterThan(after(1));
    expect(after(7)).toBeLessThanOrEqual(57);
  });

  it("판정이 없으면 그 경기는 적응도를 남기지 않는다", () => {
    const state = createTestGame(7);
    const target = assignmentsOf(state, state.userTeamId, "starting")[0]!;
    const before = target.familiarity;
    applyMatchFamiliarity(state, []);
    expect(
      assignmentsOf(state, state.userTeamId).find((a) => a.playerId === target.playerId)!
        .familiarity,
      "코어가 몰래 올렸다",
    ).toBe(before);
  });

  it("능력치도 같은 판정에서 나온다 — 경기는 최대 11명, 각 ±1", () => {
    const state = createTestGame(7);
    const squad = userPlayers(state).slice(0, MATCH_ATTR_CAP + 5);
    const before = new Map(squad.map((p) => [p.id, p.attributes.stamina]));

    // 전원에게 주려 해도 인원 상한에서 잘린다
    applyMatchAttributes(
      state,
      squad.map((p) => ({ playerId: p.id, attribute: "stamina" as const, attributeStep: 1 })),
    );
    const moved = squad.filter(
      (p) => playerById(state, p.id)!.attributes.stamina !== (before.get(p.id) ?? 0),
    );
    expect(moved.length).toBeLessThanOrEqual(MATCH_ATTR_CAP);
    for (const p of moved) {
      expect(playerById(state, p.id)!.attributes.stamina).toBe((before.get(p.id) ?? 0) + 1);
    }
  });

  it("능력치는 내려갈 수도 있다 — 나이는 훈련으로 못 이긴다", () => {
    const state = createTestGame(7);
    const player = userPlayers(state)[0]!;
    const before = player.attributes.pace;
    applyMatchAttributes(state, [{ playerId: player.id, attribute: "pace", attributeStep: -1 }]);
    expect(playerById(state, player.id)!.attributes.pace).toBe(before - 1);
  });

  it("명단 밖 선수는 무시한다 — 지어낸 id로 장부를 못 바꾼다", () => {
    const state = createTestGame(7);
    const before = assignmentsOf(state, state.userTeamId).map((a) => a.familiarity);
    applyMatchFamiliarity(state, [{ playerId: "없는-선수", gain: 8 }]);
    expect(assignmentsOf(state, state.userTeamId).map((a) => a.familiarity)).toEqual(before);
  });
});

/**
 * 결산의 입구 — 출전 확인과 한 번 확인은 여기서만 걸린다 (agents.md §4).
 * 위의 두 적용기는 순수 적용기라 이 확인을 갖지 않는다.
 */
describe("경기 결산은 한 번만, 출전 선수만", () => {
  /** 유저 팀 경기를 하나 치른 상태 — 출전자는 `result.ratings`에 자리가 있다 */
  const settled = () => {
    const state = createTestGame();
    advanceToMatchday(state);
    playMockMatch(state);
    const match = state.matches.find(
      (m) =>
        m.result?.ratings &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    );
    const ratings = match?.result?.ratings;
    if (!match || !ratings) throw new Error("평점 없음");
    const starter = assignmentsOf(state, state.userTeamId).find(
      (a) => ratings[a.playerId] !== undefined,
    );
    const absent = assignmentsOf(state, state.userTeamId).find(
      (a) => ratings[a.playerId] === undefined,
    );
    if (!starter || !absent) throw new Error("출전·비출전 선수를 못 골랐다");
    return { state, matchId: match.id, starter, absent, anchor: ratings[starter.playerId]! };
  };

  const famOf = (state: ReturnType<typeof settled>["state"], playerId: string) =>
    assignmentsOf(state, state.userTeamId).find((a) => a.playerId === playerId)!.familiarity;

  it("비출전 선수는 적응도도 능력치도 못 가져간다 — 평점과 같은 확인을 받는다", () => {
    const { state, matchId, starter, absent, anchor } = settled();
    const beforeStarter = famOf(state, starter.playerId);
    const beforeAbsent = famOf(state, absent.playerId);
    const absentBefore = structuredClone(playerById(state, absent.playerId));

    const { applied, skipped } = settleMatchRating(state, matchId, [
      { playerId: starter.playerId, rating: anchor, drill: 8, attribute: "stamina" },
      { playerId: absent.playerId, rating: 9, drill: 8, attribute: "stamina", attributeStep: -1 },
    ]);

    expect(applied).toBe(1);
    expect(skipped).toBe(1);
    expect(famOf(state, starter.playerId), "출전 선수가 아무것도 못 받았다").toBeGreaterThan(
      beforeStarter,
    );
    expect(famOf(state, absent.playerId), "벤치가 적응도를 가져갔다").toBe(beforeAbsent);
    // 능력치는 성장 곡선이 캐리로 삼킬 수 있어 값만 봐서는 부족하다 — 선수 전체가 그대로여야 한다
    expect(playerById(state, absent.playerId), "벤치가 능력치를 가져갔다").toEqual(absentBefore);
  });

  it("같은 결산을 두 번 불러도 적응도는 한 번만 오른다", () => {
    const { state, matchId, starter, anchor } = settled();
    const entries = [{ playerId: starter.playerId, rating: anchor, drill: 8 }];

    const first = settleMatchRating(state, matchId, entries);
    expect(first.already).toBe(false);
    expect(first.applied).toBe(1);
    const once = famOf(state, starter.playerId);

    const again = settleMatchRating(state, matchId, entries);
    expect(again.already, "표식이 안 섰다").toBe(true);
    expect(again.applied).toBe(0);
    expect(famOf(state, starter.playerId), "적응도가 두 번 올랐다").toBe(once);
  });
});
