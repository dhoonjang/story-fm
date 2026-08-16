import { describe, expect, it } from "vitest";
import {
  advanceSegment,
  assignmentsOf,
  buildOfficeViews,
  digestLines,
  isClubTeam,
  finalizeMatch,
  groupOf,
  loadGame,
  playersOf,
  refreshPacket,
  saveGame,
  setLineup,
  setRegionalPlan,
  setPlayerInstruction,
  setPlayerTactic,
  setTactics,
  tacticsOf,
  startMatch,
  substitutePlayer,
  transitionSeason,
  userPlayers,
  userSide,
  type GameState,
} from "@story-fm/engine";
import { advanceToMatchday, createTestGame, playMockMatch, playPreseason } from "./helpers";
import { tacticsSignature, weightSlotOf } from "@story-fm/domain";
import { zoneGrid } from "@story-fm/sim";

describe("경기 흐름 (overview §4)", () => {
  it("경기일이 아니면 시작할 수 없다", () => {
    const state = createTestGame();
    expect(startMatch(state).ok).toBe(false);
  });

  it("킥오프 → 세그먼트 진행 → 종료 반영까지 완주한다", () => {
    const state = createTestGame();
    // 시즌 기록을 보는 시험이라 리그 개막까지 간다 — 친선은 장부에 남지 않는다
    playPreseason(state);
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
    const participants = played
      .map((s) => userPlayers(state).find((x) => x.id === s.gamePlayerId))
      .filter((p) => p !== undefined);
    const conditions = participants.map((p) => p.state.condition);
    // 필드 플레이어는 90분의 대가가 남고, 골키퍼도 작지만 실제 소모가 있다.
    expect(
      Math.max(...participants.filter((p) => groupOf(p) !== "GK").map((p) => p.state.condition)),
    ).toBeLessThan(80);
    expect(
      Math.max(...participants.filter((p) => groupOf(p) === "GK").map((p) => p.state.condition)),
    ).toBeLessThan(95);
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

    const board = buildOfficeViews(state).squad.players;
    expect(board.find((player) => player.id === sub)?.role).toBe("선발");
    expect(board.find((player) => player.id === out)?.role).not.toBe("선발");

    let guard = 30;
    while (state.phase === "match" && guard-- > 0) {
      const step = advanceSegment(state);
      expect(step.ok).toBe(true);
      if (step.plan?.stop === "full_time") finalizeMatch(state);
    }
    expect(state.phase).toBe("idle");
  });

  it("자연어 지역 전술은 패킷 키포인트와 9칸 판세에 함께 반영된다", () => {
    const state = createTestGame();
    advanceToMatchday(state);
    startMatch(state);
    const side = userSide(state);
    const packetSide = () =>
      side === "home" ? state.pendingMatch!.packet.home : state.pendingMatch!.packet.away;
    // 격자는 홈 시점 좌표라 원정의 왼쪽 공격은 홈의 오른쪽 수비 칸에 나타난다.
    const gridBand = side === "home" ? "attack" : "defense";
    const gridLane = side === "home" ? "left" : "right";
    const beforeLeft = zoneGrid(state.pendingMatch!.packet).find(
      (cell) => cell.band === gridBand && cell.lane === gridLane,
    )![side];

    expect(
      setRegionalPlan(state, {
        band: "attack",
        lane: "left",
        intent: "overload",
        note: "왼쪽 하프스페이스에 수적 우위를 만든다",
      }).ok,
    ).toBe(true);

    const after = packetSide();
    expect(after.regional?.[0]?.note).toContain("하프스페이스");
    expect(
      state.pendingMatch!.packet.keyPoints.some((point) => point.includes("하프스페이스")),
    ).toBe(true);
    expect(
      zoneGrid(state.pendingMatch!.packet).find(
        (cell) => cell.band === gridBand && cell.lane === gridLane,
      )![side],
    ).toBeGreaterThan(beforeLeft);
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
    // 전술 복구는 우리 경기 사건이다 — 말풍선에 서는 갈래에 있어야 한다
    expect(digest.ours.some((d) => d.includes("되돌"))).toBe(true);
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

  it("경기 중 거친 전술은 익힌 전술로 남지 않는다", () => {
    const state = createTestGame(5);
    advanceToMatchday(state);
    startMatch(state);
    const tactics = () => tacticsOf(state, state.userTeamId);
    const kickoff = tacticsSignature(tactics().spec);

    // 경기 중 두 번 바꾼다 — 하프타임에 압박을 올리고 뒤에 멘탈리티까지 여는 전형
    setTactics(state, { pressing: 5 });
    const midMatch = [tacticsSignature(tactics().spec)];
    setTactics(state, { mentality: 5 });
    midMatch.push(tacticsSignature(tactics().spec));
    expect(new Set(midMatch).has(kickoff)).toBe(false);

    let guard = 30;
    while (state.pendingMatch && state.pendingMatch.ledger.phase !== "finished" && guard-- > 0) {
      advanceSegment(state);
    }
    finalizeMatch(state);

    // 그 경기의 대응은 그 경기에서 끝난다 — 기억에도 남지 않아야 한다
    for (const a of tactics().assignments) {
      const signatures = (a.drilled ?? []).map((d) => d.signature);
      expect(signatures.filter((s) => midMatch.includes(s))).toEqual([]);
    }
    // 킥오프 전술의 기억은 그대로다 (평시 `settleTactics`가 적어 둔 것)
    const starters = assignmentsOf(state, state.userTeamId, "starting");
    expect(starters.every((a) => (a.drilled ?? []).some((d) => d.signature === kickoff))).toBe(
      true,
    );
  });
});

describe("결산 요약의 갈래 (match.md §6)", () => {
  /** 경기를 끝까지 굴린 뒤 갈래를 그대로 받는다 — `playMockMatch`는 평탄화만 돌려준다 */
  const finishMatch = (state: GameState) => {
    startMatch(state);
    let guard = 60;
    while (state.pendingMatch && state.pendingMatch.ledger.phase !== "finished" && guard-- > 0) {
      advanceSegment(state);
    }
    return finalizeMatch(state);
  };

  it("우리 경기 결과와 재정·다른 경기가 섞이지 않는다", () => {
    const state = createTestGame();
    advanceToMatchday(state);
    const digest = finishMatch(state);

    // 스코어·전술 복구처럼 우리 경기 사건은 ours에만 선다 (말풍선이 싣는 갈래)
    expect(digest.ours.some((d) => d.includes("최종 스코어"))).toBe(true);
    expect(digest.finance.some((d) => d.includes("최종 스코어"))).toBe(false);
    expect(digest.others.some((d) => d.includes("최종 스코어"))).toBe(false);

    // 재정은 재정 화면의 몫 — 말풍선에 옮겨 적지 않는다
    expect(digest.ours.join("\n")).not.toMatch(/관중|입장 수입/u);
    // 같은 라운드의 다른 경기는 **사라지지 않는다** — 모델이 읽을 소식으로 남는다
    expect(digest.others.length).toBeGreaterThan(0);

    // 평탄화는 한 줄도 잃지 않는다 (모델 입력·테스트가 쓰는 경로)
    expect(digestLines(digest)).toEqual([...digest.ours, ...digest.finance, ...digest.others]);
  });

  it("말풍선에 서는 갈래는 항목마다 한 줄에 든다", () => {
    const state = createTestGame(5);
    advanceToMatchday(state);
    const digest = finishMatch(state);

    // 항목 하나가 말풍선 한 줄이다 — 건수와 갈래까지만 적는다
    for (const line of digest.ours) expect(line.length).toBeLessThanOrEqual(80);
    // 우리 경기 사건은 손에 꼽힌다. 라운드 전체가 실리던 예전엔 이 셈이 스무 줄이었다
    expect(digest.ours.length).toBeLessThanOrEqual(12);
    expect(digest.ours.length).toBeLessThan(digestLines(digest).length);
  });
});

/**
 * match 스킬 표면 점검에서 나온 다섯 가지 — **감독의 말이 판에 닿는 길**을 고정한다.
 * (docs/simulation/match.md의 분업: 무엇을 지시했는지는 LLM, 얼마나 먹히는지는 코어)
 */
describe("지시가 판에 닿는 길", () => {
  /**
   * `kind` 없는 개인 지시는 시뮬로 가지 않는다(`directivesOnPitch`가 `directive`만
   * 읽는다). 예전엔 그래도 성공으로 답해 GM이 "먹혔다"로 서사를 썼다 — 거짓 성공이다.
   */
  it("kind 없는 개인 지시는 판에 반영되지 않는다고 밝힌다", () => {
    const state = createTestGame();
    advanceToMatchday(state);
    startMatch(state);
    const starter = assignmentsOf(state, state.userTeamId, "starting")[0]!;

    const vague = setPlayerInstruction(state, {
      playerId: starter.playerId,
      note: "상황 봐서 알아서 움직여",
    });
    expect(vague.ok).toBe(true);
    expect(vague.message).toContain("반영되지 않습니다");
    expect(
      assignmentsOf(state, state.userTeamId).find((a) => a.playerId === starter.playerId)
        ?.directive,
      "판으로 가는 지시는 만들어지지 않는다",
    ).toBeUndefined();

    // kind가 붙으면 그 말이 판으로 간다
    const sharp = setPlayerInstruction(state, {
      playerId: starter.playerId,
      note: "앞으로 나가라",
      kind: "join_attack",
    });
    expect(sharp.ok).toBe(true);
    expect(sharp.message).not.toContain("반영되지 않습니다");
    expect(
      assignmentsOf(state, state.userTeamId).find((a) => a.playerId === starter.playerId)?.directive
        ?.kind,
    ).toBe("join_attack");
  });

  /**
   * **좌표를 지어내지 않고 자리를 옮긴다.** 지정하지 않은 축은 지금 자리를 그대로
   * 쓴다 — "왼쪽으로 벌려"가 앞뒤까지 바꾸면 감독이 하지 않은 지시가 된다.
   */
  it("이름으로 부르는 이동 — 지정한 축만 움직인다", () => {
    const state = createTestGame();
    advanceToMatchday(state);
    startMatch(state);
    // 중앙 미드필더 하나를 골라 왼쪽으로만 벌린다
    const mid = assignmentsOf(state, state.userTeamId, "starting").find((a) =>
      ["CM", "CDM", "CAM", "LCM", "RCM"].includes(a.position),
    );
    if (!mid) return;
    const before = mid.point ?? { x: 50, y: 50 };

    const moved = setPlayerTactic(state, { playerId: mid.playerId, move: { lane: "left" } });
    expect(moved.ok, moved.message).toBe(true);
    const after = assignmentsOf(state, state.userTeamId).find(
      (a) => a.playerId === mid.playerId,
    )!.point!;
    expect(after.x).toBeLessThan(before.x);
    expect(after.y, "앞뒤는 건드리지 않는다").toBe(before.y);
  });

  /**
   * **굴리기 직전에 판을 다시 계산한다.**
   *
   * 예전엔 `set_tactics`가 `refreshPacket`을 부르지 않아, 전술을 바꾸고 곧바로
   * 진행하면 그 구간이 옛 판으로 굴렀다. 결과 패킷만 보면 구간이 끝난 뒤의 갱신
   * 때문에 차이가 안 보이므로, **수동 갱신이 결과를 바꾸는지**로 잰다: 굴리기 전에
   * 이미 갱신하고 있다면 한 번 더 부르는 것은 아무것도 바꾸지 못한다.
   */
  it("전술을 바꾸고 곧바로 진행해도 그 구간이 새 전술로 구른다", () => {
    const play = (refreshFirst: boolean) => {
      const state = createTestGame(11);
      advanceToMatchday(state);
      startMatch(state);
      const spec = tacticsOf(state, state.userTeamId).spec;
      setTactics(state, { ...spec, defensiveLine: 5, pressing: 5, mentality: 5, tempo: 5 });
      if (refreshFirst) refreshPacket(state);
      const step = advanceSegment(state);
      return JSON.stringify({ stats: step.plan?.stats, score: state.pendingMatch?.ledger.score });
    };
    // 수동 갱신을 한 쪽과 안 한 쪽이 **같아야** 한다 — 안 그러면 굴리기 전 갱신이 없는 것이다
    expect(play(false)).toBe(play(true));
  });

  /** 자리가 모자라 밀려난 지역 전술은 그 사실을 말한다 */
  it("세 번째 지역 전술은 무엇이 밀렸는지 밝힌다", () => {
    const state = createTestGame();
    advanceToMatchday(state);
    startMatch(state);
    const plan = (lane: "left" | "center" | "right", note: string) =>
      setRegionalPlan(state, { band: "attack", lane, intent: "overload", note });

    expect(plan("left", "왼쪽에 사람을 더 붙여라").ok).toBe(true);
    expect(plan("right", "오른쪽도 밀어라").ok).toBe(true);
    const third = plan("center", "가운데로 모아라");
    expect(third.ok).toBe(true);
    expect(third.message).toContain("밀려났습니다");
    expect(third.message).toContain("왼쪽에 사람을 더 붙여라");
    expect(state.pendingMatch!.regionalPlans).toHaveLength(2);
  });
});

/**
 * **교체 투입은 자리를 잇고 역할은 자기 것을 쓴다** (match.md §2).
 *
 * 역할은 `roleFit`으로 전력에 그대로 닿는다 — 나간 선수의 역할을 물려주면 감독이
 * 그 선수에게 시킨 적 없는 값이 승부를 움직인다.
 */
describe("교체 투입의 역할 (match.md §2)", () => {
  /** 킥오프한 경기에서 [빈 자리를 만들 CB 선발, 벤치 필드 플레이어] */
  function kickoffWithCbSub(state: GameState) {
    advanceToMatchday(state);
    const started = startMatch(state);
    if (!started.ok) throw new Error(started.message);
    const side = userSide(state);
    const mine =
      side === "home" ? state.pendingMatch!.ledger.home : state.pendingMatch!.ledger.away;
    const assignments = assignmentsOf(state, state.userTeamId, "starting");
    const out = assignments.find(
      (a) => weightSlotOf(a.position) === "CB" && mine.onPitch.includes(a.playerId),
    );
    const sub = mine.bench.find((id) => {
      const player = userPlayers(state).find((p) => p.id === id);
      return player !== undefined && groupOf(player) !== "GK";
    });
    if (!out || !sub) throw new Error("CB 선발 또는 벤치 자원을 찾지 못했습니다");
    // 감독이 그 자리에 걸어 둔 역할 — 들어오는 선수가 물려받아선 안 되는 값
    out.roleId = "ball-playing-defender";
    const packetSide = () =>
      side === "home" ? state.pendingMatch!.packet.home : state.pendingMatch!.packet.away;
    return { out, sub, packetSide };
  }

  it("역할 기억이 있는 교체 선수는 자리를 잇고 자기 역할로 뛴다", () => {
    const state = createTestGame();
    const { out, sub, packetSide } = kickoffWithCbSub(state);
    // 이 선수는 그 자리에서 리베로를 맡던 사람이다 (경기 밖에서 적힌 기억)
    state.roleMemory.push({ gamePlayerId: sub, position: out.position, roleId: "libero" });

    expect(substitutePlayer(state, { out: out.playerId, in: sub }).ok).toBe(true);

    const slot = packetSide().lineup.find((p) => p.id === sub);
    expect(slot?.roleId, "감독이 그에게 시킨 역할로 뛴다").toBe("libero");
    // 자리·좌표는 나간 선수 것을 그대로 잇는다
    expect(slot?.position).toBe(out.position);
    expect(slot?.point).toEqual(out.point);
  });

  it("기억이 없는 교체 선수는 그 자리에 걸려 있던 역할을 잇는다", () => {
    const state = createTestGame();
    const { out, sub, packetSide } = kickoffWithCbSub(state);
    expect(state.roleMemory.some((m) => m.gamePlayerId === sub)).toBe(false);

    expect(substitutePlayer(state, { out: out.playerId, in: sub }).ok).toBe(true);

    const slot = packetSide().lineup.find((p) => p.id === sub);
    expect(slot?.roleId).toBe("ball-playing-defender");
    expect(slot?.position).toBe(out.position);
  });

  /** 다른 자리의 기억은 닿지 않는다 — 키는 (선수, 자리)다 (player.md §3.1) */
  it("다른 자리의 역할 기억은 교체 투입에 쓰이지 않는다", () => {
    const state = createTestGame();
    const { out, sub, packetSide } = kickoffWithCbSub(state);
    state.roleMemory.push({ gamePlayerId: sub, position: "DM", roleId: "anchor" });

    expect(substitutePlayer(state, { out: out.playerId, in: sub }).ok).toBe(true);

    expect(packetSide().lineup.find((p) => p.id === sub)?.roleId).toBe("ball-playing-defender");
  });

  /**
   * **상대 팀은 그대로다** — `slotsFor`는 양 팀에 쓰이고, 기억이 없는 팀의 판은
   * 이 변경 전과 같은 값이어야 한다.
   */
  it("역할 기억이 없으면 판이 달라지지 않는다", () => {
    const withMemory = createTestGame();
    const plain = createTestGame();
    for (const state of [withMemory, plain]) {
      advanceToMatchday(state);
      startMatch(state);
    }
    // 남의 팀 선수에게 기억을 심어도 교체 전 판은 같다 (선발은 배치가 원본이다)
    const opponentSide = userSide(withMemory) === "home" ? "away" : "home";
    const opponentId = withMemory.pendingMatch!.packet[opponentSide].teamId;
    for (const player of playersOf(withMemory, opponentId)) {
      withMemory.roleMemory.push({ gamePlayerId: player.id, position: "CB", roleId: "libero" });
    }
    refreshPacket(withMemory);
    expect(JSON.stringify(withMemory.pendingMatch!.packet[opponentSide].lineup)).toBe(
      JSON.stringify(plain.pendingMatch!.packet[opponentSide].lineup),
    );
  });
});
