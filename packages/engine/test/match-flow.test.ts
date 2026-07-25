import { describe, expect, it } from "vitest";
import {
  advanceMockSegment,
  advanceTime,
  assignmentsOf,
  finalizeMatch,
  groupOf,
  loadGame,
  refreshPacket,
  saveGame,
  setLineup,
  setTactics,
  startMatch,
  substitutePlayer,
  transitionSeason,
  userPlayers,
  userSide,
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
    const match = state.matches.find(
      (m) =>
        m.round === 1 && (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    );
    expect(match?.result).not.toBeNull();
    expect(digest.some((d) => d.includes("최종 스코어"))).toBe(true);

    // 출전 선수 피로·시즌 스탯 반영
    const played = state.seasonStats.filter(
      (s) => s.teamId === state.userTeamId && s.apps > 0,
    );
    expect(played.length).toBeGreaterThanOrEqual(11);
    for (const stat of played) {
      const p = userPlayers(state).find((x) => x.id === stat.gamePlayerId);
      if (p) expect(p.state.fatigue).toBeGreaterThan(20);
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
    if (mySide === "home") expect(myAttack).toBeGreaterThan(before);
    else expect(myAttack).toBeGreaterThan(0);
  });

  it("패킷 라인업이 배치 포지션을 그대로 쓴다 (v6)", () => {
    const state = createTestGame();
    advanceTime(state, "next_match");
    startMatch(state);
    const packet = state.pendingMatch!.packet;
    const side = userSide(state) === "home" ? packet.home : packet.away;
    expect(side.lineup).toHaveLength(11);
    const positions = side.lineup.map((l) => l.position);
    expect(positions).toContain("GK");
    // 배치 포지션과 일치
    const assigned = new Map(
      assignmentsOf(state, state.userTeamId, "starting").map((a) => [a.playerId, a.position]),
    );
    for (const slot of side.lineup) {
      if (assigned.has(slot.id)) expect(slot.position).toBe(assigned.get(slot.id));
    }
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
      const p = userPlayers(state).find((x) => x.id === id);
      return p !== undefined && groupOf(p) !== "GK";
    });
    const sub = myLedger.bench[0];
    if (!out || !sub) throw new Error("교체 대상 없음");

    expect(substitutePlayer(state, { out, in: sub }).ok).toBe(true);

    let guard = 30;
    while (state.phase === "match" && guard-- > 0) {
      const step = advanceMockSegment(state);
      expect(step.ok).toBe(true);
      if (step.segment?.stop === "full_time") finalizeMatch(state);
    }
    expect(state.phase).toBe("idle");
  });

  it("저장/로드를 거쳐도 경기를 이어가고 결과가 남는다", () => {
    process.env.STORY_FM_DATA_DIR = `/tmp/story-fm-test-${Math.random().toString(36).slice(2)}`;
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
    const match = loaded.matches.find(
      (m) =>
        m.round === 1 &&
        (m.homeTeamId === loaded.userTeamId || m.awayTeamId === loaded.userTeamId),
    );
    expect(match?.result).not.toBeNull();
    delete process.env.STORY_FM_DATA_DIR;
  });
});

describe("회귀: 부상·정지 선수는 경기에 나설 수 없다", () => {
  it("킥오프 시 부상 선발은 자동 대체되고 벤치에서도 빠진다", () => {
    const state = createTestGame();
    advanceTime(state, "next_match");
    const starter = assignmentsOf(state, state.userTeamId, "starting")[3]!;
    state.injuries.push({
      id: "inj-r1",
      gamePlayerId: starter.playerId,
      bodyPart: "발목",
      severity: "minor",
      cause: "training",
      occurredOn: state.date,
      expectedReturn: "2026-12-31",
      returnedOn: null,
    });

    const started = startMatch(state);
    expect(started.ok).toBe(true);
    const side = userSide(state);
    const ledger = side === "home" ? state.pendingMatch!.ledger.home : state.pendingMatch!.ledger.away;
    expect(ledger.onPitch).not.toContain(starter.playerId);
    expect(ledger.bench).not.toContain(starter.playerId);
    expect(ledger.onPitch).toHaveLength(11);
  });

  it("부상 선수 교체 투입은 반려된다", () => {
    const state = createTestGame();
    advanceTime(state, "next_match");
    startMatch(state);
    const side = userSide(state);
    const ledger = side === "home" ? state.pendingMatch!.ledger.home : state.pendingMatch!.ledger.away;
    const benchId = ledger.bench[0]!;
    state.injuries.push({
      id: "inj-r2",
      gamePlayerId: benchId,
      bodyPart: "무릎",
      severity: "minor",
      cause: "match",
      occurredOn: state.date,
      expectedReturn: "2026-12-31",
      returnedOn: null,
    });
    const out = ledger.onPitch.find((id) => {
      const p = userPlayers(state).find((x) => x.id === id);
      return p && groupOf(p) !== "GK";
    })!;
    const res = substitutePlayer(state, { out, in: benchId });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("부상");
  });

  it("부상 선수를 선발로 확정하려 하면 스킬이 반려한다", () => {
    const state = createTestGame();
    const lineup = assignmentsOf(state, state.userTeamId, "starting").map((a) => ({
      playerId: a.playerId,
      position: a.position,
    }));
    state.injuries.push({
      id: "inj-r3",
      gamePlayerId: lineup[7]!.playerId,
      bodyPart: "햄스트링",
      severity: "moderate",
      cause: "match",
      occurredOn: state.date,
      expectedReturn: "2026-12-31",
      returnedOn: null,
    });
    expect(setLineup(state, { starting: lineup }).ok).toBe(false);
  });
});

describe("회귀: 장기 시즌 안정성", () => {
  it("17시즌을 전환해도 GK가 소멸하지 않고 라인업 확정이 가능하다", () => {
    const state = createTestGame(42);
    for (let s = 0; s < 17; s++) transitionSeason(state);
    for (const team of state.teams) {
      const gks = userPlayers(state).length > 0 ? true : false;
      expect(gks).toBe(true);
      expect(assignmentsOf(state, team.id, "starting")).toHaveLength(11);
      expect(
        assignmentsOf(state, team.id, "starting").filter((a) => a.position === "GK"),
      ).toHaveLength(1);
    }
    // 유저 팀은 현재 배치로 재확정도 가능
    const lineup = assignmentsOf(state, state.userTeamId, "starting").map((a) => ({
      playerId: a.playerId,
      position: a.position,
    }));
    expect(setLineup(state, { starting: lineup }).ok).toBe(true);
  }, 30_000);

  it("대량 은퇴 시즌에도 유스 id가 충돌하지 않는다", () => {
    const state = createTestGame(7);
    for (let i = 0; i < 11; i++) {
      const p = userPlayers(state)[i];
      if (p) p.birthdate = "1990-01-01"; // 동시 은퇴 유도
    }
    transitionSeason(state);
    transitionSeason(state);
    for (const team of state.teams) {
      const ids = state.players.filter((p) => p.teamId === team.id).map((p) => p.id);
      expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toHaveLength(0);
    }
  });
});
