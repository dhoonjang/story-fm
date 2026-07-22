import { describe, expect, it } from "vitest";
import {
  advanceMockSegment,
  advanceTime,
  finalizeMatch,
  loadGame,
  saveGame,
  setTactics,
  startMatch,
  substitutePlayer,
  refreshPacket,
  userSide,
  userTeam,
} from "@story-fm/engine";
import { createTestGame, playMockMatch } from "./helpers";

describe("경기 흐름 (overview §4)", () => {
  it("경기일이 아니면 시작할 수 없다", () => {
    const state = createTestGame();
    expect(startMatch(state).ok).toBe(false);
  });

  it("킥오프 → 세그먼트 진행 → 종료 반영까지 완주한다", () => {
    const state = createTestGame();
    advanceTime(state, "next_match");
    const digest = playMockMatch(state);

    expect(state.phase).toBe("idle");
    expect(state.pendingMatch).toBeNull();
    const fixture = state.calendar.fixtures.find(
      (f) => f.round === 1 && (f.homeId === state.userTeamId || f.awayId === state.userTeamId),
    );
    expect(fixture?.result).not.toBeNull();
    expect(digest.some((d) => d.includes("최종 스코어"))).toBe(true);

    // 출전 선수 피로·시즌 스탯 반영
    const team = userTeam(state);
    const starters = team.startingXI.map((id) => team.players.find((p) => p.id === id));
    for (const p of starters) {
      expect(p?.state.fatigue ?? 0).toBeGreaterThan(20);
      expect(state.seasonStats[p?.id ?? ""]?.apps).toBe(1);
    }
  });

  it("경기 중 전술 변경은 패킷을 재계산한다", () => {
    const state = createTestGame();
    advanceTime(state, "next_match");
    startMatch(state);
    const before = state.pendingMatch?.packet.home.zones.attack ?? 0;
    setTactics(state, { mentality: 5 });
    refreshPacket(state);
    const after = state.pendingMatch?.packet;
    if (!after) throw new Error("packet 없음");
    const mySide = userSide(state);
    const myAttack = mySide === "home" ? after.home.zones.attack : after.away.zones.attack;
    // 유저가 홈이면 before는 홈 공격이므로 직접 비교, 원정이면 방향만 확인
    if (mySide === "home") expect(myAttack).toBeGreaterThan(before);
    else expect(myAttack).toBeGreaterThan(0);
  });

  it("경기 중 교체가 장부에 반영되고, 스크립트 득점자는 재매핑된다", () => {
    const state = createTestGame();
    advanceTime(state, "next_match");
    startMatch(state);
    const match = state.pendingMatch;
    if (!match) throw new Error("no match");

    const side = userSide(state);
    const myLedger = side === "home" ? match.ledger.home : match.ledger.away;
    const out = myLedger.onPitch.find((id) => {
      const p = userTeam(state).players.find((x) => x.id === id);
      return p?.positionGroup !== "GK";
    });
    const sub = myLedger.bench[0];
    if (!out || !sub) throw new Error("교체 대상 없음");

    const result = substitutePlayer(state, { out, in: sub });
    expect(result.ok).toBe(true);

    // 이후 세그먼트가 교체 아웃된 선수를 득점자로 갖고 있어도 재매핑으로 통과해야 한다
    let guard = 30;
    while (state.phase === "match" && guard-- > 0) {
      const step = advanceMockSegment(state);
      expect(step.ok).toBe(true);
      if (step.segment?.stop === "full_time") finalizeMatch(state);
    }
    expect(state.phase).toBe("idle");
  });

  it("저장/로드를 거쳐도 경기를 이어가고 결과가 캘린더에 남는다", () => {
    process.env.STORY_FM_DATA_DIR = `/tmp/story-fm-test-${Date.now()}`;
    const state = createTestGame(99);
    advanceTime(state, "next_match");
    startMatch(state);
    advanceMockSegment(state);
    saveGame(state);

    const loaded = loadGame(state.id);
    if (!loaded) throw new Error("로드 실패");
    expect(loaded.phase).toBe("match");

    let guard = 30;
    while (loaded.phase === "match" && guard-- > 0) {
      const step = advanceMockSegment(loaded);
      expect(step.ok).toBe(true);
      if (step.segment?.stop === "full_time") finalizeMatch(loaded);
    }
    const fixture = loaded.calendar.fixtures.find(
      (f) => f.round === 1 && (f.homeId === loaded.userTeamId || f.awayId === loaded.userTeamId),
    );
    expect(fixture?.result).not.toBeNull();
    delete process.env.STORY_FM_DATA_DIR;
  });
});
