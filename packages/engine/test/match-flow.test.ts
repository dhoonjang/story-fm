import { describe, expect, it } from "vitest";
import {
  advanceSegment,
  assignmentsOf,
  isClubTeam,
  finalizeMatch,
  groupOf,
  loadGame,
  refreshPacket,
  saveGame,
  setLineup,
  setPlayerInstruction,
  setTactics,
  tacticsOf,
  startMatch,
  substitutePlayer,
  transitionSeason,
  userPlayers,
  userSide,
} from "@story-fm/engine";
import { advanceToMatchday, createTestGame, playMockMatch } from "./helpers";

describe("경기 흐름 (overview §4)", () => {
  it("경기일이 아니면 시작할 수 없다", () => {
    const state = createTestGame();
    expect(startMatch(state).ok).toBe(false);
  });

  it("킥오프 → 세그먼트 진행 → 종료 반영까지 완주한다", () => {
    const state = createTestGame();
    advanceToMatchday(state);
    const digest = playMockMatch(state);

    expect(state.phase).toBe("idle");
    expect(state.pendingMatch).toBeNull();
    const match = state.matches.find(
      (m) =>
        m.round === 1 && (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    );
    expect(match?.result).not.toBeNull();
    expect(digest.some((d) => d.includes("최종 스코어"))).toBe(true);

    /**
     * 출전 선수 피로·시즌 스탯 반영 — **뛴 만큼, 자리마다 다르게** 깎인다
     * (`stamina.ts`). 상수 −34를 물리던 때는 골키퍼와 90분 뛴 윙백이 똑같이
     * 지쳤고, 다음 경기까지 사흘이면 전원이 100으로 돌아와 로테이션이 없었다.
     */
    const played = state.seasonStats.filter((s) => s.teamId === state.userTeamId && s.apps > 0);
    expect(played.length).toBeGreaterThanOrEqual(11);
    const conditions = played
      .map((s) => userPlayers(state).find((x) => x.id === s.gamePlayerId))
      .filter((p) => p !== undefined)
      .map((p) => p.state.condition);
    // 90분을 뛰고도 멀쩡한 선수는 없다 — 이 경기의 대가가 장부에 남는다
    expect(Math.max(...conditions)).toBeLessThan(80);
    // 자리마다 갈린다 (골키퍼는 덜, 중원·측면은 많이) — 하나로 뭉개지지 않는다
    expect(Math.max(...conditions) - Math.min(...conditions)).toBeGreaterThan(15);
  });

  it("경기 중 전술 변경은 패킷을 재계산한다", () => {
    const state = createTestGame();
    advanceToMatchday(state);
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
    advanceToMatchday(state);
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

  it("감독의 지시가 기대 득점을 바꾼다 — 결과에 닿는 경로는 패킷 하나뿐이다", () => {
    const state = createTestGame();
    advanceToMatchday(state);
    startMatch(state);
    const side = userSide(state);
    const xgOf = () => {
      refreshPacket(state);
      return state.pendingMatch!.packet.guide.expectedGoals;
    };
    const before = { ...xgOf() };

    // 전면 공격 — 우리 기대 득점이 오르고 **상대 기대 득점도 함께 오른다**(대가)
    expect(setTactics(state, { mentality: 5, tempo: 5, defensiveLine: 5 }).ok).toBe(true);
    const after = xgOf();
    const ours = side === "home" ? "home" : "away";
    const theirs = side === "home" ? "away" : "home";
    expect(after[ours]).toBeGreaterThan(before[ours]);
    expect(after[theirs]).toBeGreaterThan(before[theirs]);
  });

  it("경기 중 피로가 쌓여 후반 전력이 떨어진다", () => {
    const state = createTestGame();
    advanceToMatchday(state);
    startMatch(state);
    const side = userSide(state);
    const sum = (rows: ReadonlyArray<{ effective: number }>) =>
      rows.reduce((s, r) => s + r.effective, 0);
    const oursOf = () => {
      const packet = state.pendingMatch!.packet;
      return sum((side === "home" ? packet.home : packet.away).lineup);
    };
    const opening = oursOf();
    for (let i = 0; i < 4; i++) {
      if (state.phase !== "match") break;
      advanceSegment(state);
    }
    const worn = state.pendingMatch?.matchFatigue ?? {};
    expect(Object.values(worn).some((v) => v > 0)).toBe(true);
    if (state.pendingMatch) {
      /**
       * **개인 유효 전력의 합**으로 본다 — xg로 재면 안 된다. 상대도 함께 지치고
       * xg는 (우리 공격 ÷ 상대 수비)라, 상대가 더 지치면 우리 xg는 오히려 오른다.
       */
      expect(oursOf()).toBeLessThan(opening);
    }
  });

  it("경기 중 교체가 장부에 반영되고 경기가 끝까지 진행된다", () => {
    const state = createTestGame();
    advanceToMatchday(state);
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
      const step = advanceSegment(state);
      expect(step.ok).toBe(true);
      if (step.plan?.stop === "full_time") finalizeMatch(state);
    }
    expect(state.phase).toBe("idle");
  });

  it("저장/로드를 거쳐도 경기를 이어가고 결과가 남는다", () => {
    process.env.STORY_FM_DATA_DIR = `/tmp/story-fm-test-${Math.random().toString(36).slice(2)}`;
    const state = createTestGame(99);
    advanceToMatchday(state);
    startMatch(state);
    advanceSegment(state);
    if (!state.pendingMatch) throw new Error("경기 없음");
    state.pendingMatch.casterHistory = {
      version: 1,
      provider: "google",
      model: "gemini-test",
      messages: [
        {
          role: "model",
          parts: [{ thoughtSignature: "opaque", text: "@중계: 저장 테스트" }],
        },
      ],
    };
    saveGame(state);

    const loaded = loadGame(state.id);
    if (!loaded) throw new Error("로드 실패");
    expect(loaded.phase).toBe("match");
    expect(loaded.pendingMatch?.casterHistory).toEqual(state.pendingMatch.casterHistory);

    let guard = 30;
    while (loaded.phase === "match" && guard-- > 0) {
      const step = advanceSegment(loaded);
      expect(step.ok).toBe(true);
      if (step.plan?.stop === "full_time") finalizeMatch(loaded);
    }
    const match = loaded.matches.find(
      (m) =>
        m.round === 1 && (m.homeTeamId === loaded.userTeamId || m.awayTeamId === loaded.userTeamId),
    );
    expect(match?.result).not.toBeNull();
    delete process.env.STORY_FM_DATA_DIR;
  });
});

describe("회귀: 부상·정지 선수는 경기에 나설 수 없다", () => {
  it("킥오프 시 부상 선발은 자동 대체되고 벤치에서도 빠진다", () => {
    const state = createTestGame();
    advanceToMatchday(state);
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
    const ledger =
      side === "home" ? state.pendingMatch!.ledger.home : state.pendingMatch!.ledger.away;
    expect(ledger.onPitch).not.toContain(starter.playerId);
    expect(ledger.bench).not.toContain(starter.playerId);
    expect(ledger.onPitch).toHaveLength(11);
  });

  it("부상 선수 교체 투입은 반려된다", () => {
    const state = createTestGame();
    advanceToMatchday(state);
    startMatch(state);
    const side = userSide(state);
    const ledger =
      side === "home" ? state.pendingMatch!.ledger.home : state.pendingMatch!.ledger.away;
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
      if (!isClubTeam(team.id)) continue; // 무소속은 클럽이 아니다
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
  }, 90_000);

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

/**
 * 경기 중 조정은 그 경기에서 끝난다 — 하프타임에 올린 라인이 다음 주 훈련까지
 * 따라가면, 감독은 자기가 바꾼 적 없는 전술로 다음 경기에 들어간다.
 */
describe("경기 후 전술 복원", () => {
  it("경기 중 바꾼 전술·개인 지시가 킥오프 전으로 돌아온다", () => {
    const state = createTestGame(5);
    advanceToMatchday(state);
    startMatch(state);
    const tactics = () => tacticsOf(state, state.userTeamId);
    const before = { ...tactics().spec };

    setTactics(state, { mentality: 5, defensiveLine: 5, pressing: 5 });
    const marker = assignmentsOf(state, state.userTeamId, "starting")[3]!.playerId;
    const opponent = state.players.find(
      (p) =>
        p.teamId !== state.userTeamId && state.pendingMatch!.ledger.away.onPitch.includes(p.id),
    );
    if (opponent) {
      setPlayerInstruction(state, {
        playerId: marker,
        note: "달고 다녀",
        kind: "man_mark",
        targetId: opponent.id,
      });
    }
    expect(tactics().spec.mentality).toBe(5);

    let guard = 30;
    while (state.pendingMatch && state.pendingMatch.ledger.phase !== "finished" && guard-- > 0) {
      advanceSegment(state);
    }
    const digest = finalizeMatch(state);

    expect(tactics().spec).toEqual(before);
    expect(tactics().assignments.some((a) => a.directive)).toBe(false);
    expect(digest.some((d) => d.includes("되돌"))).toBe(true);
  });

  it("경기 중 전술 변경이 깎은 적응도도 함께 되돌린다", () => {
    const state = createTestGame(5);
    advanceToMatchday(state);
    startMatch(state);

    // 전술을 바꾸면 코어가 적응도를 깎는다 — 새 전술을 훈련해야 한다는 뜻이다.
    // 그 경기 한 번의 대응에 그 대가를 물리면 하프타임 조정이 영구 손해가 된다
    const target = assignmentsOf(state, state.userTeamId, "starting")[0]!;
    const before = target.familiarity;
    setTactics(state, { mentality: 5 });
    expect(target.familiarity).toBeLessThan(before);

    let guard = 30;
    while (state.pendingMatch && state.pendingMatch.ledger.phase !== "finished" && guard-- > 0) {
      advanceSegment(state);
    }
    finalizeMatch(state);

    const after = assignmentsOf(state, state.userTeamId, "starting").find(
      (a) => a.playerId === target.playerId,
    );
    expect(after?.familiarity).toBe(before);
  });
});
