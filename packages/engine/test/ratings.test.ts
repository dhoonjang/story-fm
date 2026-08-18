import { describe, expect, it } from "vitest";
import { seasonRating } from "@story-fm/domain";
import {
  RATING_BAND,
  RATING_BASE,
  RATING_MAX,
  RATING_MIN,
  applyMatchRatings,
  buildRatingBrief,
  finalizeMatch,
  matchRating,
  quickSimulate,
  simSquadOf,
  startMatch,
  userPlayers,
  userSide,
  isFriendly,
} from "@story-fm/engine";
import { advanceToMatchday, createTestGame, playMockMatch, playPreseason } from "./helpers";

/** 경기 평점 — 장부 사실만으로 결정적으로 매긴다 (ratings.ts) */

const base = {
  group: "MF" as const,
  goals: 0,
  assists: 0,
  yellows: 0,
  reds: 0,
  conceded: 1,
  outcome: "draw" as const,
};

describe("경기 평점 공식", () => {
  it("아무 일도 없던 무승부 미드필더는 기준선에 선다", () => {
    expect(matchRating(base)).toBe(RATING_BASE);
  });

  it("승패가 평점을 흔들되 뒤집지는 않는다", () => {
    expect(matchRating({ ...base, outcome: "win" })).toBeGreaterThan(matchRating(base));
    expect(matchRating({ ...base, outcome: "loss" })).toBeLessThan(matchRating(base));
    // 결과만으로는 1점을 넘지 않는다 — 팀 성적이 개인 기여를 덮으면 안 된다
    expect(
      matchRating({ ...base, outcome: "win" }) - matchRating({ ...base, outcome: "loss" }),
    ).toBeLessThan(1);
  });

  it("같은 골이라도 뒷선일수록 크게 쳐준다", () => {
    const goal = { ...base, goals: 1 };
    const df = matchRating({ ...goal, group: "DF" });
    const mf = matchRating({ ...goal, group: "MF" });
    const fw = matchRating({ ...goal, group: "FW" });
    expect(df).toBeGreaterThan(mf);
    expect(mf).toBeGreaterThan(fw);
    // 그래도 9번의 골은 기준선보다 확실히 높다
    expect(fw).toBeGreaterThan(RATING_BASE);
  });

  it("도움도 가산이지만 골보다는 작다", () => {
    expect(matchRating({ ...base, assists: 1 })).toBeGreaterThan(RATING_BASE);
    expect(matchRating({ ...base, assists: 1 })).toBeLessThan(matchRating({ ...base, goals: 1 }));
  });

  it("무실점은 뒷선만 가져간다 — 공격수는 나눠 갖지 않는다", () => {
    const clean = { ...base, conceded: 0 };
    expect(matchRating({ ...clean, group: "GK" })).toBeGreaterThan(
      matchRating({ ...clean, group: "DF" }),
    );
    expect(matchRating({ ...clean, group: "FW" })).toBe(matchRating({ ...base, group: "FW" }));
  });

  it("대량 실점은 뒷선이 지고, 첫 골은 봐준다", () => {
    const gk = (conceded: number) => matchRating({ ...base, group: "GK", conceded });
    expect(gk(3)).toBeLessThan(gk(1));
    // 미드필더·공격수는 실점 수에 흔들리지 않는다
    expect(matchRating({ ...base, conceded: 4 })).toBe(matchRating({ ...base, conceded: 1 }));
  });

  it("카드는 감점이고 퇴장이 더 무겁다", () => {
    expect(matchRating({ ...base, yellows: 1 })).toBeLessThan(RATING_BASE);
    expect(matchRating({ ...base, reds: 1 })).toBeLessThan(matchRating({ ...base, yellows: 1 }));
  });

  it("범위를 벗어나지 않는다 — 해트트릭도 10을 넘지 않고 퇴장도 3 아래로 안 간다", () => {
    const hero = matchRating({
      ...base,
      group: "GK",
      goals: 5,
      assists: 5,
      conceded: 0,
      outcome: "win",
    });
    expect(hero).toBeLessThanOrEqual(RATING_MAX);
    const villain = matchRating({
      ...base,
      reds: 3,
      yellows: 3,
      conceded: 8,
      group: "GK",
      outcome: "loss",
    });
    expect(villain).toBeGreaterThanOrEqual(RATING_MIN);
  });

  it("같은 사실이면 같은 평점이다 — 난수가 없다", () => {
    const facts = { ...base, goals: 1, assists: 1, outcome: "win" as const };
    expect(matchRating(facts)).toBe(matchRating(facts));
  });
});

describe("시즌 평점 파생", () => {
  it("출전이 없으면 null — 0.00과 '기록 없음'은 다르다", () => {
    expect(seasonRating(null)).toBeNull();
    expect(seasonRating({ apps: 0, ratingSum: 0 })).toBeNull();
    // 구 세이브(필드 없음)도 null
    expect(seasonRating({ apps: 3, ratingSum: undefined })).toBeNull();
  });

  it("합계 ÷ 출전 — 소수 둘째 자리", () => {
    expect(seasonRating({ apps: 3, ratingSum: 21.4 })).toBe(7.13);
  });
});

describe("경기가 기록으로 남는다", () => {
  it("유저 경기 — 출전 선수마다 평점이 남고 시즌 합계로 쌓인다", () => {
    const state = createTestGame();
    advanceToMatchday(state);
    playMockMatch(state);

    const match = state.matches.find(
      (m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId,
    );
    const ratings = match?.result?.ratings;
    expect(ratings).toBeDefined();
    expect(Object.keys(ratings ?? {}).length).toBeGreaterThanOrEqual(11);
    for (const value of Object.values(ratings ?? {})) {
      expect(value).toBeGreaterThanOrEqual(RATING_MIN);
      expect(value).toBeLessThanOrEqual(RATING_MAX);
    }

    // 시즌 합계 = 그 경기 평점 (첫 경기라 1경기치)
    for (const stat of state.seasonStats.filter(
      (s) => s.teamId === state.userTeamId && s.apps > 0,
    )) {
      expect(stat.ratingSum).toBeCloseTo(ratings?.[stat.gamePlayerId] ?? -1, 5);
      expect(seasonRating(stat)).not.toBeNull();
    }
  });

  it("골 이벤트의 두 번째 선수는 도움이다 — 득점으로 세지 않는다", () => {
    const state = createTestGame();
    // 시즌 기록을 보는 시험이라 리그 개막까지 간다 — 친선은 장부에 남지 않는다
    playPreseason(state);
    advanceToMatchday(state);
    expect(startMatch(state).ok).toBe(true);
    const pending = state.pendingMatch;
    if (!pending) throw new Error("경기 없음");

    const side = userSide(state);
    const onPitch = side === "home" ? pending.ledger.home.onPitch : pending.ledger.away.onPitch;
    const [scorer, assister] = onPitch.filter((id) => userPlayers(state).some((p) => p.id === id));
    if (!scorer || !assister) throw new Error("선수 부족");

    pending.ledger.events.push({
      minute: 30,
      type: "goal",
      team: side,
      actors: [scorer, assister],
      causes: [],
    });
    pending.ledger.score[side] += 1;
    finalizeMatch(state);

    const of = (id: string) => state.seasonStats.find((s) => s.gamePlayerId === id);
    expect(of(scorer)?.goals).toBe(1);
    expect(of(scorer)?.assists ?? 0).toBe(0);
    expect(of(assister)?.goals).toBe(0);
    expect(of(assister)?.assists).toBe(1);
  });

  it("타 팀 경기 — 퀵심도 도움을 낸다 (득점자 본인은 아니다)", () => {
    const state = createTestGame();
    const teams = [...new Set(state.players.map((p) => p.teamId))].filter(
      (t) => t !== state.userTeamId,
    );
    const [a, b] = teams;
    if (!a || !b) throw new Error("상대 팀 부족");
    const home = simSquadOf(state, a);
    const away = simSquadOf(state, b);

    let goals = 0;
    let assists = 0;
    for (let i = 0; i < 60; i++) {
      const r = quickSimulate(home, away, 7000 + i, `assist:${i}`);
      goals += r.scorers.length;
      assists += r.assists.filter((x) => x !== "").length;
      /**
       * 도움은 **골마다 한 칸**이다 — 짝이 맞아야 화면이 `assists[i]`로 그 골의
       * 도움을 찾는다. 단독 득점은 빈 칸으로 남는다(길이는 그대로).
       */
      expect(r.assists.length).toBe(r.scorers.length);
      for (const s of r.assists) if (s !== "") expect(s).toMatch(/^(home|away):/);
    }
    expect(goals).toBeGreaterThan(0);
    expect(assists).toBeGreaterThan(0);
    // 모든 골에 도움이 붙지는 않는다
    expect(assists).toBeLessThan(goals);
  });
});

describe("평점 브리프 — LLM 채점의 입력 (코어가 만든다)", () => {
  it("장부가 살아 있을 때만 만들 수 있다 — 경기 전후엔 null", () => {
    const state = createTestGame();
    expect(buildRatingBrief(state)).toBeNull(); // 경기 전
    advanceToMatchday(state);
    playMockMatch(state);
    expect(buildRatingBrief(state)).toBeNull(); // 경기 후
  });

  it("출전 선수마다 자리·선발 여부·출전 시간·기준 평점을 담는다", () => {
    const state = createTestGame();
    advanceToMatchday(state);
    expect(startMatch(state).ok).toBe(true);
    const brief = buildRatingBrief(state);
    if (!brief) throw new Error("brief 없음");

    expect(brief.players.length).toBe(11);
    expect(brief.players.filter((p) => p.started).length).toBe(11);
    for (const p of brief.players) {
      expect(p.minutes).toBe(90);
      expect(p.position.length).toBeGreaterThan(0);
      expect(p.anchor).toBeGreaterThanOrEqual(RATING_MIN);
      expect(p.anchor).toBeLessThanOrEqual(RATING_MAX);
    }
  });

  it("교체 투입 선수는 뛴 시간만 갖는다", () => {
    const state = createTestGame();
    advanceToMatchday(state);
    expect(startMatch(state).ok).toBe(true);
    const pending = state.pendingMatch;
    if (!pending) throw new Error("경기 없음");
    const side = userSide(state);
    const mine = side === "home" ? pending.ledger.home : pending.ledger.away;
    const out = mine.onPitch[5];
    const into = mine.bench[0];
    if (!out || !into) throw new Error("교체 대상 없음");

    mine.onPitch = mine.onPitch.filter((id) => id !== out).concat(into);
    pending.ledger.events.push({
      minute: 60,
      type: "substitution",
      team: side,
      actors: [out, into],
      causes: [],
    });

    const brief = buildRatingBrief(state);
    const byId = new Map((brief?.players ?? []).map((p) => [p.playerId, p] as const));
    expect(byId.get(out)?.minutes).toBe(60);
    expect(byId.get(into)?.minutes).toBe(30);
    expect(byId.get(into)?.started).toBe(false);
    // 나간 선수도 채점 대상이다 — 뛰었으니까
    expect(byId.get(out)?.started).toBe(true);
  });

  it("finalizeMatch가 박는 앵커와 브리프의 앵커가 같다 — 어긋나면 정산이 깨진다", () => {
    const state = createTestGame();
    advanceToMatchday(state);
    expect(startMatch(state).ok).toBe(true);
    const brief = buildRatingBrief(state);
    finalizeMatch(state);
    const match = state.matches.find(
      (m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId,
    );
    for (const p of brief?.players ?? []) {
      expect(match?.result?.ratings?.[p.playerId]).toBe(p.anchor);
    }
  });
});

describe("LLM 평점 반영 — 코어는 가능한 판정만 받는다", () => {
  const played = () => {
    const state = createTestGame();
    // 보정분이 시즌 합계를 따라 움직이는지 보는 시험이라 리그 경기여야 한다 —
    // 친선은 앵커도 보정분도 시즌 합계에 안 들어간다 (season.md §2)
    playPreseason(state);
    advanceToMatchday(state);
    playMockMatch(state);
    const match = state.matches.find(
      (m) =>
        m.result !== null &&
        !isFriendly(m) &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    );
    if (!match?.result?.ratings) throw new Error("평점 없음");
    const [playerId, anchor] = Object.entries(match.result.ratings)[0] as [string, number];
    return { state, matchId: match.id, playerId, anchor, match };
  };

  it("밴드 안의 보정은 그대로 들어가고 시즌 합계도 따라 움직인다", () => {
    const { state, matchId, playerId, anchor } = played();
    const before = state.seasonStats.find((s) => s.gamePlayerId === playerId)?.ratingSum ?? 0;
    const target = Math.min(RATING_MAX, anchor + 0.5);
    const { applied } = applyMatchRatings(state, matchId, [
      { playerId, rating: target, note: "상대 10번을 90분 내내 지웠다" },
    ]);
    expect(applied).toBe(1);
    const match = state.matches.find((m) => m.id === matchId);
    expect(match?.result?.ratings?.[playerId]).toBe(target);
    expect(match?.result?.ratingNotes?.[playerId]).toContain("90분");
    const after = state.seasonStats.find((s) => s.gamePlayerId === playerId)?.ratingSum ?? 0;
    expect(after - before).toBeCloseTo(target - anchor, 5);
  });

  it("밴드를 벗어나면 잘라 낸다 — LLM이 10점을 줘도 앵커에서 멀어질 수 없다", () => {
    const { state, matchId, playerId, anchor } = played();
    applyMatchRatings(state, matchId, [{ playerId, rating: 10 }]);
    const match = state.matches.find((m) => m.id === matchId);
    const value = match?.result?.ratings?.[playerId] ?? 0;
    expect(value).toBeLessThanOrEqual(Math.min(RATING_MAX, anchor + RATING_BAND) + 1e-9);
    expect(value).toBeGreaterThan(anchor);
  });

  it("두 번 불러도 앵커 ±RATING_BAND 안이다 — 둘째 호출은 장부를 더 움직이지 않는다", () => {
    const { state, matchId, playerId, anchor } = played();
    const ceiling = Math.min(RATING_MAX, anchor + RATING_BAND);
    const valueOf = () =>
      state.matches.find((m) => m.id === matchId)?.result?.ratings?.[playerId] ?? 0;
    const sumOf = () => state.seasonStats.find((s) => s.gamePlayerId === playerId)?.ratingSum ?? 0;

    const first = applyMatchRatings(state, matchId, [{ playerId, rating: 10 }]);
    expect(first.applied).toBe(1);
    expect(first.already).toBe(false);
    expect(valueOf()).toBeCloseTo(ceiling, 5);
    const once = sumOf();

    // 도구 루프가 같은 판정을 다시 제출한 자리 — 보정된 값에서 밴드를 다시 재면 앵커에서 2배 벗어난다
    const again = applyMatchRatings(state, matchId, [{ playerId, rating: 10 }]);
    expect(again.already, "표식이 안 섰다").toBe(true);
    expect(again.applied).toBe(0);
    expect(valueOf(), "앵커에서 밴드보다 멀어졌다").toBeCloseTo(ceiling, 5);
    expect(sumOf(), "시즌 합계가 두 번 움직였다").toBeCloseTo(once, 5);
  });

  it("같은 호출 안에 같은 선수가 두 줄로 오면 첫 줄만 받는다", () => {
    const { state, matchId, playerId, anchor } = played();
    const target = anchor <= RATING_MAX - 0.4 ? anchor + 0.4 : anchor - 0.4;
    const before = state.seasonStats.find((s) => s.gamePlayerId === playerId)?.ratingSum ?? 0;

    const { applied, skipped } = applyMatchRatings(state, matchId, [
      { playerId, rating: target, note: "첫 줄" },
      { playerId, rating: 10, note: "둘째 줄" },
    ]);
    expect(applied).toBe(1);
    expect(skipped).toBe(1);
    const match = state.matches.find((m) => m.id === matchId);
    expect(match?.result?.ratings?.[playerId]).toBeCloseTo(target, 5);
    expect(match?.result?.ratingNotes?.[playerId]).toBe("첫 줄");
    const after = state.seasonStats.find((s) => s.gamePlayerId === playerId)?.ratingSum ?? 0;
    expect(after - before).toBeCloseTo(target - anchor, 5);
  });

  it("출전하지 않은 선수·모르는 id는 버린다", () => {
    const { state, matchId } = played();
    const { applied, skipped } = applyMatchRatings(state, matchId, [
      { playerId: "없는-선수", rating: 8 },
    ]);
    expect(applied).toBe(0);
    expect(skipped).toBe(1);
  });
});
