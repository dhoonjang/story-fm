import { describe, expect, it } from "vitest";
import {
  advanceSegment,
  applyMatchEvents,
  assignmentsOf,
  buildOfficeViews,
  buildOpponentReport,
  buildRatingBrief,
  digestLines,
  firstTeamPlayers,
  isClubTeam,
  finalizeMatch,
  groupOf,
  loadGame,
  MATCH_PROFICIENCY_GAIN,
  OUT_OF_POSITION_RUN,
  MATCHDAY_BENCH,
  tacticalXpFor,
  TACTICAL_XP_CAP,
  TACTICAL_XP_PER_GOAL,
  playerById,
  playersOf,
  proficiencyAt,
  refreshPacket,
  saveGame,
  setLineup,
  settleYouthIntake,
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
import {
  advanceToMatchday,
  createMiniGame,
  createTestGame,
  playMockMatch,
  playPreseason,
} from "./helpers";
import {
  EXTRA_TIME_FULL_MINUTES,
  FULL_TIME_MINUTES,
  normalizeCauses,
  positionGroupOf,
  positionGroupOfPlayer,
  tacticsSignature,
  weightSlotOf,
} from "@story-fm/domain";
import type { MatchEvent, PacketTag } from "@story-fm/domain";
import { zoneGrid } from "@story-fm/sim";

/**
 * 킥오프 직전 상태 — 시드마다 **한 번만** 만들고 복제해 나눠 쓴다.
 *
 * 경기일까지 미는 값(그 사이 세계의 경기를 다 소화한다)은 0.8초쯤인데 이 파일은
 * 그 자리를 스무 번 넘게 만든다. 같은 시드·같은 지점이면 결과도 같으므로 원본은
 * 한 번만 세우고 매번 복제한다 — `helpers.ts`가 세계를 다루는 방식과 같다.
 */
const kickoffCache = new Map<string, GameState>();
let clones = 0;

function atMatchday(seed = 42, opts?: { afterPreseason?: boolean }): GameState {
  const key = `${seed}:${opts?.afterPreseason ? "league" : "first"}`;
  let origin = kickoffCache.get(key);
  if (!origin) {
    origin = createTestGame(seed);
    // 리그 개막까지 가려면 프리시즌 친선을 먼저 흘려보내야 한다
    if (opts?.afterPreseason) playPreseason(origin);
    advanceToMatchday(origin);
    kickoffCache.set(key, origin);
  }
  const copy = structuredClone(origin);
  // 세이브는 id로 갈린다 — 복제본이 같은 id를 쓰면 두 게임이 한 파일을 밟는다
  copy.id = `${copy.id}-c${++clones}`;
  return copy;
}

describe("경기 흐름 (overview §4)", () => {
  it("경기일이 아니면 시작할 수 없다", () => {
    const state = createTestGame();
    expect(startMatch(state).ok).toBe(false);
  });

  it("킥오프 → 세그먼트 진행 → 종료 반영까지 완주한다", () => {
    // 시즌 기록을 보는 시험이라 리그 개막까지 간다 — 친선은 장부에 남지 않는다
    const state = atMatchday(42, { afterPreseason: true });
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

  /**
   * **종료 휘슬이 장부를 걷어 가지 않는다** (match.md §4).
   *
   * `pendingMatch`가 지워질 때 사건·선수별 기록도 함께 사라지던 자리다. 몇 줄만
   * 골라 남기면 그 기준이 두 번째 원본이 되므로 **수가 같아야** 한다 — 세우는 것을
   * 고르는 일은 읽는 쪽(리포트 뷰)의 몫이다.
   */
  it("마감은 장부의 사건을 자르지 않는다 — 저장된 사건 수가 원장 사건 수와 같다", () => {
    const state = atMatchday(42, { afterPreseason: true });
    const fixture = state.matches.find(
      (m) =>
        m.date === state.date &&
        !m.result &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    );
    if (!fixture) throw new Error("오늘 경기를 찾지 못했습니다");

    // 결산 **직전**의 원장을 잡아 둔다 — 마감이 지나면 볼 수 없다
    let ledgerEvents = -1;
    let ledgerStatIds: string[] = [];
    playMockMatch(state, (s) => {
      const ledger = s.pendingMatch?.ledger;
      if (!ledger) throw new Error("종료 시각에 장부가 없습니다");
      ledgerEvents = ledger.events.length;
      ledgerStatIds = Object.keys(ledger.stats ?? {}).sort();
    });
    // 국면 표식(하프타임·종료)만 해도 여럿이라 빈 장부로는 시험이 되지 않는다
    expect(ledgerEvents).toBeGreaterThan(2);
    expect(ledgerStatIds.length).toBeGreaterThanOrEqual(22);

    const result = state.matches.find((m) => m.id === fixture.id)?.result;
    if (!result) throw new Error("결과가 남지 않았습니다");
    expect(result.events?.length).toBe(ledgerEvents);
    expect(Object.keys(result.playerStats ?? {}).sort()).toEqual(ledgerStatIds);

    // 점유도 함께 건너온다 — 두 몫의 합은 1이다
    const possession = result.possession;
    if (!possession) throw new Error("점유가 결과에 남지 않았습니다");
    expect(possession.home + possession.away).toBeCloseTo(1, 6);
  });

  /**
   * **시즌 기록은 그 경기가 낸 수 그대로 쌓인다** (match.md §6).
   *
   * 마감이 선수별 기록을 팀 합계로만 접고 버리던 자리다. 리더보드(#556)가 읽는
   * 것이 이 합이므로, 여기서 한 칸이라도 새면 "슛 대비 골"이 조용히 틀린다.
   * 양 팀 모두 본다 — 우리 것만 적으면 리그가 우리 팀만의 규칙으로 돈다.
   */
  it("마감이 시즌에 얹은 슛·선방이 그 경기의 팀 합계와 같다", () => {
    const state = atMatchday(42, { afterPreseason: true });
    const fixture = state.matches.find(
      (m) =>
        m.date === state.date &&
        !m.result &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    );
    if (!fixture) throw new Error("오늘 경기를 찾지 못했습니다");
    // 마감이 얹은 몫만 본다 — 이 경기 앞의 행은 그대로 두고 차이를 잰다
    const before = new Map(
      state.seasonStats.map((s) => [`${s.gamePlayerId}\u0000${s.teamId}`, { ...s }] as const),
    );
    playMockMatch(state);

    const result = state.matches.find((m) => m.id === fixture.id)?.result;
    if (!result) throw new Error("결과가 남지 않았습니다");
    const added = (playerId: string, teamId: string, key: "shots" | "saves" | "minutes") => {
      const row = state.seasonStats.find(
        (s) => s.gamePlayerId === playerId && s.teamId === teamId && s.season === state.season,
      );
      return (row?.[key] ?? 0) - (before.get(`${playerId}\u0000${teamId}`)?.[key] ?? 0);
    };
    const sumOver = (
      lineup: readonly string[],
      teamId: string,
      key: "shots" | "saves" | "minutes",
    ) => lineup.reduce((total, id) => total + added(id, teamId, key), 0);

    const home = result.homeLineup ?? [];
    const away = result.awayLineup ?? [];
    expect(home.length).toBeGreaterThanOrEqual(11);
    expect(sumOver(home, fixture.homeTeamId, "shots")).toBe(result.homeShots ?? 0);
    expect(sumOver(away, fixture.awayTeamId, "shots")).toBe(result.awayShots ?? 0);
    // 선방은 골키퍼의 칸이다 — 상대의 유효슈팅이 그 수의 상한이다
    expect(sumOver(home, fixture.homeTeamId, "saves")).toBeLessThanOrEqual(result.awayShots ?? 0);
    /**
     * 출전 분의 합은 **셔츠 열한 장 × 경기 길이**에서 퇴장이 비운 시간을 뺀 값이다 —
     * 교체는 짝으로 시간을 이어받고, 퇴장은 그 자리를 끝까지 비운다.
     */
    const fullMinutes = result.aet ? EXTRA_TIME_FULL_MINUTES : FULL_TIME_MINUTES;
    const emptied = (which: "home" | "away") =>
      (result.events ?? [])
        .filter((e) => e.type === "red_card" && e.team === which)
        .reduce((sum, e) => sum + Math.max(0, fullMinutes - e.minute), 0);
    expect(sumOver(home, fixture.homeTeamId, "minutes")).toBe(11 * fullMinutes - emptied("home"));
    expect(sumOver(away, fixture.awayTeamId, "minutes")).toBe(11 * fullMinutes - emptied("away"));
  });

  it("경기 중 전술 변경은 패킷을 재계산한다", () => {
    const state = atMatchday();
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
    const state = atMatchday();
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
    const state = atMatchday();
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
    const state = atMatchday();
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
    const state = atMatchday();
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
    const state = atMatchday();
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
      state.pendingMatch!.packet.keyPoints.some(
        (tag) => tag.source === "zone-plan" && tag.text?.includes("하프스페이스"),
      ),
    ).toBe(true);
    expect(
      zoneGrid(state.pendingMatch!.packet).find(
        (cell) => cell.band === gridBand && cell.lane === gridLane,
      )![side],
    ).toBeGreaterThan(beforeLeft);
  });

  it("저장/로드를 거쳐도 경기를 이어가고 결과가 남는다", () => {
    process.env.STORY_FM_DATA_DIR = `/tmp/story-fm-test-${Math.random().toString(36).slice(2)}`;
    const state = atMatchday(99);
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
    const state = atMatchday();
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
    const state = atMatchday();
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

  /**
   * 부상 정지점에서 교체를 미루는 결정에 코어가 값을 매긴다 (match.md §2).
   * 장부는 `injury`로 명단을 바꾸지 않으므로, 이 감산이 없으면 다친 선수가 온전한
   * 전력으로 남은 시간을 뛰고 교체하지 않는 쪽이 이득이 된다.
   */
  it("교체하지 않은 부상 선수는 남은 시간을 구멍으로 뛴다", () => {
    const state = atMatchday();
    startMatch(state);
    const side = userSide(state);
    const pending = state.pendingMatch!;
    const ours = () => (side === "home" ? pending.packet.home : pending.packet.away);
    const onPitch = () => (side === "home" ? pending.ledger.home : pending.ledger.away).onPitch;
    // 수비수를 고른다 — 구멍의 대가가 어느 줄에 실리는지 함께 보기 위해
    const victim = onPitch().find((id) => {
      const player = userPlayers(state).find((x) => x.id === id);
      return player !== undefined && groupOf(player) === "DF";
    });
    if (!victim) throw new Error("수비수를 찾지 못했다");
    const effectiveOfVictim = () => ours().lineup.find((row) => row.id === victim)!.effective;
    const before = effectiveOfVictim();
    const defenseBefore = ours().zones.defense;

    const hurt = applyMatchEvents(state, [
      { minute: 20, type: "injury", team: side, actors: [victim], causes: [] },
    ]);
    expect(hurt.ok).toBe(true);
    refreshPacket(state);

    // 그라운드에는 그대로 서 있다 — 빼는 것은 교체뿐이다 (match.md §5)
    expect(onPitch()).toContain(victim);
    expect(effectiveOfVictim()).toBeLessThan(before);
    // 구멍 하나의 대가는 그 라인 전체가 치른다
    expect(ours().zones.defense).toBeLessThan(defenseBefore);
    // 경기 후 체력 정산이 읽는 누적 피로는 건드리지 않는다 — 부상은 결장 일수로 치른다
    expect(pending.matchFatigue?.[victim] ?? 0).toBe(0);
  });

  /**
   * **거르는 자리는 명단을 짜는 한 곳뿐이다** (match.md §7). 상대 벤치를 `startMatch`가
   * 다시 짜면 그 문이 감독의 경기에서만 새서, 정지 선수와 2군이 우리와 붙는 경기에서만
   * 벤치에 선다.
   */
  it("상대 벤치도 간이 시뮬의 명단을 그대로 받는다 — 정지자·2군이 없다", () => {
    const state = atMatchday();
    const today = state.matches.find(
      (m) =>
        m.date === state.date &&
        !m.result &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    )!;
    const opponentId = today.homeTeamId === state.userTeamId ? today.awayTeamId : today.homeTeamId;
    const inXI = new Set(assignmentsOf(state, opponentId, "starting").map((a) => a.playerId));
    // 배치 밖 최상위 둘 — 걸러지지 않으면 OVR 순 벤치의 맨 위에 선다
    const spare = playersOf(state, opponentId)
      .filter((p) => !inXI.has(p.id))
      .sort((a, b) => b.attributes.overall - a.attributes.overall);
    const banned = spare[0]!;
    const reserve = spare[1]!;
    state.suspensions.push({
      id: "susp-bench",
      gamePlayerId: banned.id,
      cause: "red",
      issuedOn: state.date,
      lengthMatches: 1,
      served: 0,
      status: "active",
    });
    reserve.squadLevel = "reserve";

    expect(startMatch(state).ok).toBe(true);
    const theirs =
      userSide(state) === "home"
        ? state.pendingMatch!.ledger.away
        : state.pendingMatch!.ledger.home;
    expect(theirs.bench.length).toBeGreaterThan(0);
    expect(theirs.bench).not.toContain(banned.id);
    expect(theirs.bench).not.toContain(reserve.id);
    expect(theirs.onPitch).not.toContain(banned.id);
    expect(theirs.onPitch).not.toContain(reserve.id);
  });

  /** 2군은 승격 후에만 배치된다 (team.md §5) — 코어가 대신 채우는 자리도 같다 */
  it("우리 자동 대체는 2군을 세우지 않는다", () => {
    const state = atMatchday();
    const teamId = state.userTeamId;
    const starter = assignmentsOf(state, teamId, "starting")[3]!;
    const assigned = new Set(assignmentsOf(state, teamId).map((a) => a.playerId));
    /** 그 자리의 적응도를 천장에 두면 1군만 보지 않는 한 반드시 뽑힌다 */
    const spare = playersOf(state, teamId).find((p) => !assigned.has(p.id))!;
    spare.squadLevel = "reserve";
    spare.positions = [{ position: starter.position, proficiency: 99, isNatural: true }];
    state.injuries.push({
      id: "inj-r4",
      gamePlayerId: starter.playerId,
      bodyPart: "종아리",
      severity: "minor",
      cause: "training",
      occurredOn: state.date,
      expectedReturn: "2026-12-31",
      returnedOn: null,
    });

    expect(startMatch(state).ok).toBe(true);
    const mine =
      userSide(state) === "home"
        ? state.pendingMatch!.ledger.home
        : state.pendingMatch!.ledger.away;
    expect(mine.onPitch).toHaveLength(11);
    expect(mine.onPitch).not.toContain(spare.id);
    expect(mine.bench).not.toContain(spare.id);
  });

  /** 경계 — 배치된 벤치가 상한을 채워도 골키퍼 자리는 잘리지 않는다 (match.md §2) */
  it("벤치가 전원 필드 선수로 차 있어도 골키퍼 한 자리가 남는다", () => {
    const state = atMatchday();
    const teamId = state.userTeamId;
    const starting = assignmentsOf(state, teamId, "starting").map((a) => ({
      playerId: a.playerId,
      position: a.position,
    }));
    const inXI = new Set(starting.map((s) => s.playerId));
    const outfield = firstTeamPlayers(state, teamId)
      .filter((p) => !inXI.has(p.id) && groupOf(p) !== "GK")
      .slice(0, MATCHDAY_BENCH);
    expect(outfield).toHaveLength(MATCHDAY_BENCH);
    expect(
      setLineup(state, { starting, bench: outfield.map((p) => ({ playerId: p.id })) }).ok,
    ).toBe(true);

    expect(startMatch(state).ok).toBe(true);
    const mine =
      userSide(state) === "home"
        ? state.pendingMatch!.ledger.home
        : state.pendingMatch!.ledger.away;
    expect(mine.bench).toHaveLength(MATCHDAY_BENCH);
    const keepers = mine.bench.filter((id) => {
      const player = playersOf(state, teamId).find((p) => p.id === id);
      return player !== undefined && groupOf(player) === "GK";
    });
    expect(keepers).toHaveLength(1);
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
    /**
     * **축소 세계로 넘긴다** — 여기서 보는 것은 열일곱 번의 전환을 지나도 구단마다
     * 골키퍼 하나가 남느냐다. 그 규칙은 구단 단위라 세계에 클럽이 여덟이든
     * 백예순이든 같은 코드를 지난다 (전체 세계로는 이 한 케이스가 12초를 썼다).
     */
    const state = createMiniGame(42);
    for (let s = 0; s < 17; s++) {
      transitionSeason(state);
      /**
       * **인테이크 정리를 함께 굴린다** — 전환은 우리 팀에 후보를 세울 뿐이고 계약은
       * 소집일이 쓴다 (season.md §6). 빼면 감독 팀만 열일곱 여름 동안 아무도 받지
       * 못해, 재는 것이 골키퍼의 수지가 아니라 그 한 구단의 고갈이 된다.
       */
      settleYouthIntake(state, []);
    }
    expect(userPlayers(state).length).toBeGreaterThan(0);
    for (const team of state.teams) {
      if (!isClubTeam(team.id)) continue; // 무소속은 클럽이 아니다
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
  });

  it("대량 은퇴 시즌에도 유스 id가 충돌하지 않는다", () => {
    const state = createTestGame(7);
    for (let i = 0; i < 11; i++) {
      const p = userPlayers(state)[i];
      if (p) p.birthdate = "1990-01-01"; // 동시 은퇴 유도
    }
    transitionSeason(state);
    settleYouthIntake(state, []);
    transitionSeason(state);
    settleYouthIntake(state, []);
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
/**
 * 자리 밖 기용 — **선발로 센다** (→ docs/data/people.md §5). 원장은 누가 뛰었는지만
 * 알고 어느 자리에 섰는지는 모르므로, 연속을 세는 눈금은 `PlayerState`가 든다.
 */
describe("자리 밖 기용의 눈금 (people.md §5)", () => {
  it("주 포지션 묶음 밖 선발이 이어지면 네 경기째에 불만이 선다", () => {
    const state = atMatchday(5);
    const starters = assignmentsOf(state, state.userTeamId, "starting");
    const back = starters.find((a) => positionGroupOf(a.position) === "DF")!;
    const front = starters.find((a) => positionGroupOf(a.position) === "FW")!;
    // 자리를 맞바꾼다 — 판의 모양은 그대로이고 두 사람만 묶음 밖에 선다
    const backSlot = back.position;
    back.position = front.position;
    front.position = backSlot;

    const misplaced = playerById(state, back.playerId)!;
    expect(positionGroupOfPlayer(misplaced)).not.toBe(positionGroupOf(back.position));
    const inPlace = starters.find((a) => {
      const p = playerById(state, a.playerId);
      return (
        a !== back && a !== front && p && positionGroupOfPlayer(p) === positionGroupOf(a.position)
      );
    })!;

    // 문턱 직전까지 이미 서 있던 선수 — 이 경기가 네 번째다
    misplaced.state.outOfPositionRun = OUT_OF_POSITION_RUN - 1;
    playMockMatch(state);

    expect(misplaced.state.outOfPositionRun).toBe(OUT_OF_POSITION_RUN);
    expect(
      state.issues.some((i) => i.gamePlayerId === misplaced.id && i.reason === "out-of-position"),
    ).toBe(true);
    // 제자리에 선 선수에게는 눈금이 서지 않는다
    expect(playerById(state, inPlace.playerId)!.state.outOfPositionRun).toBeUndefined();
  });

  it("제자리에 선발로 서면 눈금이 지워진다", () => {
    const state = atMatchday(5);
    const starters = assignmentsOf(state, state.userTeamId, "starting");
    const inPlace = starters.find((a) => {
      const p = playerById(state, a.playerId);
      return p && positionGroupOfPlayer(p) === positionGroupOf(a.position);
    })!;
    const player = playerById(state, inPlace.playerId)!;
    player.state.outOfPositionRun = OUT_OF_POSITION_RUN - 1;

    playMockMatch(state);

    expect(player.state.outOfPositionRun).toBeUndefined();
    expect(state.issues.some((i) => i.reason === "out-of-position")).toBe(false);
  });
});

describe("경기 후 전술 복원", () => {
  it("경기 중 바꾼 전술·개인 지시가 킥오프 전으로 돌아온다", () => {
    const state = atMatchday(5);
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
    const state = atMatchday(5);
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
    const state = atMatchday(5);
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
    const state = atMatchday();
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
    const state = atMatchday(5);
    const digest = finishMatch(state);

    // 항목 하나가 말풍선 한 줄이다 — 건수와 갈래까지만 적는다
    for (const line of digest.ours) expect(line.length).toBeLessThanOrEqual(80);
    // 우리 경기 사건은 손에 꼽힌다. 라운드 전체가 실리던 예전엔 이 셈이 스무 줄이었다
    expect(digest.ours.length).toBeLessThanOrEqual(12);
    expect(digest.ours.length).toBeLessThan(digestLines(digest).length);
  });
});

/**
 * **두 번째 경고는 다음 경기 정지로 이어진다** (match.md §5·§7).
 *
 * 장부는 경고 2장을 자동 퇴장으로 바꾸지만(온필드에서 빼고 `sentOff`에 넣는다) 경기 후
 * 반영(`finalizeMatch`)은 **사건 타입만** 읽는다. `red_card` 줄이 없으면 `cause:"red"`
 * 정지가 생기지 않아, 같은 사건이 우리 경기에선 정지가 없고 타 팀 간이 시뮬에선 있는
 * 세계가 된다 — 리그가 우리 팀만의 규칙으로 도는 것이다.
 */
describe("경고 누적 퇴장의 장부 (match.md §5)", () => {
  it("두 번째 경고는 퇴장 정지 한 건과 경고·퇴장 두 줄로 남는다", () => {
    // **친선의 카드는 어느 대회에도 쌓이지 않는다** — 리그 개막 뒤에서 봐야 장부가 움직인다
    const state = atMatchday(42, { afterPreseason: true });
    expect(startMatch(state).ok).toBe(true);
    const side = userSide(state);
    const mine = () =>
      side === "home" ? state.pendingMatch!.ledger.home : state.pendingMatch!.ledger.away;
    const matchId = state.pendingMatch!.matchId;
    const target = mine().onPitch[0]!;
    const name = userPlayers(state).find((p) => p.id === target)!.name;

    /** 카드 사건을 직접 넣는다 — 구간을 굴려 우연히 경고 2장을 기다리면 난수이고 느리다 */
    const SECOND = 38;
    const card = (minute: number, types: ReadonlyArray<"yellow_card" | "red_card">) =>
      applyMatchEvents(
        state,
        types.map((type) => ({ minute, type, team: side, actors: [target], causes: [] })),
      );

    expect(card(20, ["yellow_card"]).ok).toBe(true);
    // 구간 시뮬이 두 번째 경고 자리에 넣는 그 쌍 — 경고 한 줄 + 퇴장 한 줄
    const second = card(SECOND, ["yellow_card", "red_card"]);
    expect(second.ok, second.message).toBe(true);
    expect(mine().onPitch).not.toContain(target);

    /**
     * 카드를 넣고 **곧바로** 끝낸다 — 구간을 더 굴리면 시뮬이 같은 선수에게 카드를 더 줘
     * 셈이 흔들린다. 하프타임은 정지점이라 같은 배치에 뒤 사건을 붙이면 반려된다.
     */
    for (const stop of ["half_time", "full_time"] as const) {
      const applied = applyMatchEvents(state, [
        { minute: stop === "half_time" ? 45 : 90, type: stop, actors: [], causes: [] },
      ]);
      expect(applied.ok, applied.message).toBe(true);
    }

    const digest = finalizeMatch(state);

    // 정지는 **정확히 하나** — 퇴장 한 건이다 (경고 누적 눈금은 아직 안 걸린다)
    const suspensions = state.suspensions.filter((s) => s.gamePlayerId === target);
    expect(suspensions).toHaveLength(1);
    expect(suspensions[0]?.cause).toBe("red");
    expect(suspensions[0]?.lengthMatches).toBe(1);
    expect(suspensions[0]?.status).toBe("active");

    // 퇴장이 일어난 그 분의 BOOKING은 yellow 한 줄 + red 한 줄
    // (레드가 경고로 세어지지도, 레드 두 줄로 남지도 않는다)
    const atSecond = state.bookings.filter(
      (b) => b.gamePlayerId === target && b.matchId === matchId && b.minute === SECOND,
    );
    expect([...atSecond.map((b) => b.card)].sort()).toEqual(["red", "yellow"]);
    // 경기 전체로는 경고 2장 + 퇴장 1장 — 간이 시뮬(§7)과 같은 모양이다
    const ofTarget = state.bookings.filter((b) => b.gamePlayerId === target);
    expect(ofTarget.filter((b) => b.card === "yellow")).toHaveLength(2);
    expect(ofTarget.filter((b) => b.card === "red")).toHaveLength(1);

    // 우리 선수의 정지는 감독이 바로 알아야 한다 — 말풍선에 서는 갈래에 선다
    expect(digest.ours.some((d) => d.includes(name) && d.includes("정지"))).toBe(true);
  });
});

/**
 * 출전 시간은 **그라운드를 떠난 시각**에서 나온다 — 교체로 나간 것과 퇴장당한 것이
 * 같은 자격이다 (match.md §6). 퇴장을 세지 않으면 20′에 나간 선수도 90분으로 남아,
 * 평점의 기준값과 LLM 채점의 입력이 "풀타임을 뛰고 퇴장까지 당한 선수"가 된다.
 * 화면에는 그 숫자가 서지 않으므로 아무도 알아채지 못한다.
 */
describe("출전 시간의 끝 — 교체와 퇴장이 같은 자격이다", () => {
  it("퇴장 분이 출전 시간을 끊고, 교체 투입자는 들어온 시각부터 센다", () => {
    const state = atMatchday(42, { afterPreseason: true });
    expect(startMatch(state).ok).toBe(true);
    const side = userSide(state);
    const mine = () =>
      side === "home" ? state.pendingMatch!.ledger.home : state.pendingMatch!.ledger.away;
    const [sentOff, goingOff, fullMatch] = mine().onPitch as [string, string, string];
    const comingOn = mine().bench[0]!;

    const apply = (...events: Parameters<typeof applyMatchEvents>[1]) => {
      const res = applyMatchEvents(state, events);
      expect(res.ok, res.message).toBe(true);
    };
    apply({ minute: 20, type: "red_card", team: side, actors: [sentOff], causes: [] });
    apply({ minute: 45, type: "half_time", actors: [], causes: [] });
    apply({
      minute: 60,
      type: "substitution",
      team: side,
      actors: [goingOff, comingOn],
      causes: [],
    });
    // 들어온 선수가 그 뒤에 퇴장한다 — 두 끝이 함께 걸리는 자리다
    apply({ minute: 75, type: "red_card", team: side, actors: [comingOn], causes: [] });

    // 장부가 살아 있을 때만 만들 수 있다 — `finalizeMatch`보다 먼저다
    const brief = buildRatingBrief(state)!;
    const minutesOf = (id: string) => brief.players.find((p) => p.playerId === id)?.minutes;
    expect(minutesOf(sentOff)).toBe(20);
    expect(minutesOf(goingOff)).toBe(60);
    expect(minutesOf(comingOn)).toBe(15); // 60′ 투입 → 75′ 퇴장
    expect(minutesOf(fullMatch)).toBe(90);
  });
});

/**
 * **상대 벤치가 판을 갈아 까는 것은 경기당 한 번이다** (match.md §2). 정지점마다 다시
 * 고르면 스코어가 아니라 **정지점 횟수**의 함수가 되고, 감독이 말만 거는 턴이 이어질수록
 * 상대의 모양이 계속 흔들린다 — 판이 바뀌는 것은 화면에 보이지만 "몇 번째인지"는 보이지
 * 않는다.
 */
describe("상대 벤치의 모양 변경 (match.md §2)", () => {
  it("한 번 갈아 깐 판은 남은 정지점에서 다시 바뀌지 않는다", () => {
    const state = atMatchday(42, { afterPreseason: true });
    expect(startMatch(state).ok).toBe(true);
    const run = () => {
      const step = advanceSegment(state);
      expect(step.ok, step.message).toBe(true);
      return step.plan?.stop;
    };

    // 상대가 판을 갈아 깔 때까지 굴린다
    let guard = 60;
    while (state.pendingMatch?.aiShape === undefined && guard-- > 0) {
      if (run() === "full_time") break;
    }
    const shape = state.pendingMatch!.aiShape;
    expect(shape, "상대가 이 경기에서 한 번도 판을 갈아 깔지 않았다").toBeDefined();

    /**
     * 감독이 고를 리 없는 모양을 손으로 박아 둔다 — 상대는 크게 지고 있어서 남은
     * 정지점마다 "던지는 모양"(`CHASE_SHAPES`)을 다시 고르려 한다. 관문이 없으면
     * 이 값이 그 모양으로 덮인다.
     */
    const pending = state.pendingMatch!;
    pending.aiShape = { formation: "5-4-1", intent: "hold" };
    if (pending.aiTactics) pending.aiTactics = { ...pending.aiTactics, formation: "5-4-1" };
    guard = 60;
    while (state.phase === "match" && guard-- > 0) {
      if (run() === "full_time") break;
    }
    expect(state.pendingMatch!.aiShape).toEqual({ formation: "5-4-1", intent: "hold" });
  });

  /**
   * 구간이 정지 사건(골·하프타임·종료)과 **함께** 올리는 AI 교체는 그 사건 **앞에**
   * 끼워지고, 분은 앞뒤 사건 사이로 잘린다(`insertBeforeStop`). 뒤에 붙으면 장부가
   * 배치를 통째로 반려해 경기가 그 자리에서 멈추고, 분이 잘리지 않으면 "시간 역행"으로
   * 같은 일이 일어난다.
   */
  it("정지 사건과 함께 올라온 AI 교체가 장부의 시각을 되감지 않는다", () => {
    const state = atMatchday(42, { afterPreseason: true });
    let aiSide: "home" | "away" = "home";
    let events: readonly { minute: number; type: string; team?: string }[] = [];
    // 장부는 `finalizeMatch`가 걷어 가므로 종료 직전에 읽는다 (`userSide`도 그때 선다)
    playMockMatch(state, (s) => {
      aiSide = userSide(s) === "home" ? "away" : "home";
      events = s.pendingMatch!.ledger.events.map((e) => ({
        minute: e.minute,
        type: e.type,
        ...(e.team ? { team: e.team } : {}),
      }));
    });

    // 장부의 시각은 되감기지 않는다
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.minute, `#${i} ${events[i]!.type}`).toBeGreaterThanOrEqual(
        events[i - 1]!.minute,
      );
    }
    // 상대 벤치가 실제로 교체를 넣었고, 종료 사건이 장부의 마지막이다
    const subs = events.filter((e) => e.type === "substitution" && e.team === aiSide);
    expect(subs.length).toBeGreaterThan(0);
    const last = events[events.length - 1]!;
    expect(last.type).toBe("full_time");
    for (const sub of subs) expect(sub.minute).toBeLessThanOrEqual(last.minute);
  });

  /**
   * **판을 갈아 낀 줄은 한 경기에 하나다** (match.md §2·§4). 모양 전환은 경기당 한
   * 번인데 사건이 정지점마다 서면 중계는 상대가 판을 계속 갈아엎는 것으로 읽고, 화면의
   * 전환 표식은 마지막 정지점만 가리킨다 — 어느 쪽도 장부가 아는 사실이 아니다.
   * 축만 옮긴 줄은 여러 번 설 수 있다: 상한(`AI_SHIFT_BOUND`)에 닿을 때까지가 판단이다.
   */
  it("모양을 갈아 낀 전환 사건은 한 경기에 한 줄뿐이다", () => {
    const state = atMatchday(42, { afterPreseason: true });
    expect(startMatch(state).ok).toBe(true);
    const aiSide = userSide(state) === "home" ? "away" : "home";
    // 장부는 `finalizeMatch`가 걷어 가므로 종료 사건까지만 굴리고 그 자리에서 읽는다
    let guard = 60;
    while (state.phase === "match" && guard-- > 0) {
      const step = advanceSegment(state);
      expect(step.ok, step.message).toBe(true);
      if (step.plan?.stop === "full_time") break;
    }
    const pending = state.pendingMatch!;
    const shifts = pending.ledger.events.filter((e) => e.type === "tactical_shift");
    const tagOf = (e: MatchEvent): PacketTag | undefined => normalizeCauses(e.causes)[0];

    expect(shifts.length, "상대 벤치가 이 경기에서 한 번도 판을 옮기지 않았다").toBeGreaterThan(0);
    for (const shift of shifts) {
      // 전환은 상대 벤치의 것뿐이다 — 감독의 전술 변경은 스킬이지 사건이 아니다
      expect(shift.team).toBe(aiSide);
      // 근거 태그 하나가 갈래를 싣는다 — 문장은 읽는 쪽이 만든다
      expect(tagOf(shift)?.source).toBe("ai-shift");
      expect(["chase", "hold"]).toContain(tagOf(shift)?.code);
    }
    /**
     * 모양을 갈아 낀 줄은 **상태와 같은 수**여야 한다 — `aiShape`가 섰으면 한 줄,
     * 안 섰으면 없다. 사건이 상태보다 많으면 중계는 상대가 판을 계속 갈아엎는 것으로
     * 읽고, 적으면 감독이 본 판의 모양이 어디서 왔는지 장부가 답하지 못한다.
     */
    const reshaped = shifts.filter((e) =>
      (tagOf(e)?.flags ?? []).some((f) => f.startsWith("formation:")),
    );
    // 이 시드의 상대는 실제로 판을 갈아 낀다 — 아니면 아래 불변식이 0을 세고 만다
    expect(pending.aiShape, "상대가 이 경기에서 한 번도 판을 갈아 깔지 않았다").toBeDefined();
    expect(reshaped).toHaveLength(1);
    expect(tagOf(reshaped[0]!)?.flags).toContain(`formation:${pending.aiShape!.formation}`);
  });
});

/**
 * **한 경기는 양 팀 장부에 같은 흔적을 남긴다** (match.md §6).
 *
 * 마감이 우리 명단만 돌던 때는 상대가 우리를 상대로 두 골을 넣어도 시즌 득점이
 * 그대로였고, 퇴장당한 상대는 다음 경기에 정상 출전했다. 정지를 소화하러 결장한
 * 상대 선수는 `served`가 오르지 않아 한 경기를 더 쉬었다 — 득점왕·평점 순위가
 * 우리 경기만큼 어긋나는 것이다.
 */
describe("감독 경기 마감의 대칭 (match.md §6)", () => {
  /** 하프타임·종료를 손으로 밀어 경기를 닫는다 — 구간을 굴리면 카드·골이 난수다 */
  function closeMatch(state: GameState) {
    for (const stop of ["half_time", "full_time"] as const) {
      const applied = applyMatchEvents(state, [
        { minute: stop === "half_time" ? 45 : 90, type: stop, actors: [], causes: [] },
      ]);
      expect(applied.ok, applied.message).toBe(true);
    }
    return finalizeMatch(state);
  }

  it("상대의 출전·득점·도움·카드·정지가 우리와 같은 장부에 남는다", () => {
    // **친선은 장부에 남지 않는다** — 리그 개막 뒤에서 봐야 시즌 기록이 움직인다
    const state = atMatchday(42, { afterPreseason: true });
    const fixture = state.matches.find(
      (m) =>
        m.date === state.date &&
        !m.result &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    );
    if (!fixture) throw new Error("오늘 경기를 찾지 못했습니다");
    const oppTeamId =
      fixture.homeTeamId === state.userTeamId ? fixture.awayTeamId : fixture.homeTeamId;

    /** 정지 중인 상대 선수 — 이 경기에 결장하고, 그 결장이 소화로 세어져야 한다 */
    const banned = firstTeamPlayers(state, oppTeamId)[0];
    if (!banned) throw new Error("상대 1군 선수를 찾지 못했습니다");
    state.suspensions.push({
      id: `sus-test-${banned.id}`,
      gamePlayerId: banned.id,
      cause: "red",
      issuedOn: state.date,
      lengthMatches: 1,
      served: 0,
      status: "active",
    });

    expect(startMatch(state).ok).toBe(true);
    const oppSide = userSide(state) === "home" ? "away" : "home";
    const matchId = state.pendingMatch!.matchId;
    const onPitch = state.pendingMatch!.ledger[oppSide].onPitch;
    expect(onPitch, "정지 중인 선수는 그라운드에 없다").not.toContain(banned.id);
    const [keeper, booked, sentOff, assister, scorer] = [
      onPitch[0]!,
      onPitch[1]!,
      onPitch[2]!,
      onPitch[9]!,
      onPitch[10]!,
    ];
    const sentOffName = playersOf(state, oppTeamId).find((p) => p.id === sentOff)!.name;

    /** 상대 쪽 사건을 직접 넣는다 — 구간을 굴려 우연을 기다리면 난수이고 느리다 */
    const events = applyMatchEvents(state, [
      { minute: 20, type: "yellow_card", team: oppSide, actors: [booked], causes: [] },
      { minute: 30, type: "red_card", team: oppSide, actors: [sentOff], causes: [] },
      { minute: 40, type: "goal", team: oppSide, actors: [scorer, assister], causes: [] },
    ]);
    expect(events.ok, events.message).toBe(true);

    /** 그 시즌 그 팀의 기록 — 이 경기가 더한 몫만 보려면 앞뒤를 견줘야 한다 */
    const statOf = (id: string) =>
      state.seasonStats.find(
        (s) => s.gamePlayerId === id && s.season === state.season && s.teamId === oppTeamId,
      );
    const appsBefore = (id: string) => statOf(id)?.apps ?? 0;
    const before = {
      keeper: appsBefore(keeper),
      sentOff: appsBefore(sentOff),
      banned: appsBefore(banned.id),
      goals: statOf(scorer)?.goals ?? 0,
      assists: statOf(assister)?.assists ?? 0,
      ratingSum: statOf(scorer)?.ratingSum ?? 0,
    };

    const digest = closeMatch(state);

    // 출전 — 퇴장당한 선수도 그라운드를 밟았다
    expect(statOf(keeper)?.apps).toBe(before.keeper + 1);
    expect(statOf(sentOff)?.apps).toBe(before.sentOff + 1);
    expect(appsBefore(banned.id), "결장한 정지자는 출전이 늘지 않는다").toBe(before.banned);
    // 득점·도움 — 상대의 득점왕 셈이 우리 경기에서도 이어진다
    expect(statOf(scorer)?.goals).toBe(before.goals + 1);
    expect(statOf(assister)?.assists).toBe(before.assists + 1);
    // 평점은 경기별로 남지 않고 시즌 합계로만 쌓인다 (간이 시뮬과 같은 규칙, §7)
    expect(statOf(scorer)?.ratingSum ?? 0).toBeGreaterThan(before.ratingSum);
    expect(state.matches.find((m) => m.id === matchId)?.result?.ratings?.[scorer]).toBeUndefined();

    // 카드 → BOOKING, 퇴장 → 다음 경기 정지 (간이 시뮬과 같은 문)
    const bookings = state.bookings.filter((b) => b.matchId === matchId);
    expect(bookings.filter((b) => b.gamePlayerId === booked && b.card === "yellow")).toHaveLength(
      1,
    );
    expect(bookings.filter((b) => b.gamePlayerId === sentOff && b.card === "red")).toHaveLength(1);
    const red = state.suspensions.find((s) => s.gamePlayerId === sentOff);
    expect(red?.cause).toBe("red");
    expect(red?.status).toBe("active");
    // 정지 소화 — 결장한 한 경기가 차감된다 (안 세면 한 경기를 더 쉰다)
    const served = state.suspensions.find((s) => s.gamePlayerId === banned.id);
    expect(served?.served).toBe(1);
    expect(served?.status).toBe("done");

    // 남의 팀 정지·무드는 브리핑하지 않는다 — 조회 도구가 알려 준다
    expect(digest.ours.some((d) => d.includes(sentOffName))).toBe(false);
  });

  /**
   * 마일스톤은 **문턱을 넘는 그 경기의 것**이고 **감독 팀 선수의 것**이다
   * (match.md §6 · game-state.md §3.4). 둘 다 조용히 어긋나는 종류라 고정한다 —
   * 상대 쪽에도 행이 쌓이면 시즌마다 수백 행이 우리 기록을 묻고, 문턱을 나중에
   * 훑어 세면 "언제 넘었나"가 사라진다.
   */
  it("문턱을 넘는 경기에만, 그리고 우리 선수에게만 마일스톤이 선다", () => {
    const state = atMatchday(42, { afterPreseason: true });
    expect(startMatch(state).ok).toBe(true);
    const mySide = userSide(state);
    const oppSide = mySide === "home" ? "away" : "home";
    const mine = state.pendingMatch!.ledger[mySide].onPitch;
    const theirs = state.pendingMatch!.ledger[oppSide].onPitch;
    const matchId = state.pendingMatch!.matchId;
    const [ours, theirScorer] = [mine[10]!, theirs[10]!];
    const oppTeamId = playerById(state, theirScorer)!.teamId;

    /**
     * 두 선수를 각자 팀에서 99경기에 세운다 — 지난 시즌 행을 하나 얹는다.
     * 이 경기 하나로 정확히 100이 되므로 경계가 이 경기에 걸린다.
     */
    const standAt99 = (playerId: string, teamId: string) => {
      const already = state.seasonStats
        .filter((x) => x.gamePlayerId === playerId && x.teamId === teamId)
        .reduce((sum, x) => sum + x.apps, 0);
      state.seasonStats.push({
        gamePlayerId: playerId,
        season: state.season - 1,
        teamId,
        apps: 99 - already,
        goals: 0,
      });
    };
    standAt99(ours, state.userTeamId);
    standAt99(theirScorer, oppTeamId);

    /** 양쪽에 세 골씩, 전반 안에 — 해트트릭도 같은 자리에서 갈린다 */
    const goal = (minute: number, team: "home" | "away", scorer: string) => ({
      minute,
      type: "goal" as const,
      team,
      actors: [scorer],
      causes: [],
    });
    const goals = [10, 20, 30].flatMap((minute) => [
      goal(minute, mySide, ours),
      goal(minute + 2, oppSide, theirScorer),
    ]);
    expect(applyMatchEvents(state, goals).ok).toBe(true);

    const digest = closeMatch(state);

    const rows = state.milestones ?? [];
    const mineRows = rows.filter((m) => m.gamePlayerId === ours && m.matchId === matchId);
    // 100번째 경기이자 그 구단에서의 첫 골이다 — 데뷔는 서지 않는다(이미 99경기다)
    expect(mineRows.map((m) => `${m.code}:${m.value}`).sort()).toEqual([
      "apps:100",
      "first-goal:1",
      "hat-trick:3",
    ]);
    expect(mineRows.every((m) => m.teamId === state.userTeamId)).toBe(true);
    // 상대는 같은 경기에서 같은 문턱을 넘었지만 장부에는 남지 않는다
    expect(rows.filter((m) => m.gamePlayerId === theirScorer)).toHaveLength(0);
    // 그 경기의 말풍선이 한 줄로 그것을 말한다 — 선수마다 나누지 않는다
    expect(digest.ours.filter((d) => d.startsWith("기록: "))).toHaveLength(1);
  });

  /**
   * **적응도는 그 경기에 선 자리에 쌓인다.** 벤치 배치의 자리로 올리던 때는,
   * 90분 동안 센터백으로 뛴 공격수의 최전방 적응도가 올랐다.
   */
  it("교체 투입자는 물려받은 자리의 적응도가 오른다", () => {
    const state = atMatchday(42, { afterPreseason: true });
    expect(startMatch(state).ok).toBe(true);
    const mine =
      userSide(state) === "home"
        ? state.pendingMatch!.ledger.home
        : state.pendingMatch!.ledger.away;
    const roster = userPlayers(state);
    const out = assignmentsOf(state, state.userTeamId, "starting").find(
      (a) => weightSlotOf(a.position) === "CB" && mine.onPitch.includes(a.playerId),
    );
    /** 센터백이 아닌 벤치 자원 — 물려받은 자리와 자기 자리가 갈려야 시험이 성립한다 */
    const sub = mine.bench
      .map((id) => roster.find((p) => p.id === id))
      .find((p) => p !== undefined && (groupOf(p) === "MF" || groupOf(p) === "FW"));
    if (!out || !sub) throw new Error("CB 선발 또는 벤치 자원을 찾지 못했습니다");
    const benchPosition = assignmentsOf(state, state.userTeamId).find(
      (a) => a.playerId === sub.id,
    )?.position;
    expect(benchPosition).not.toBe(out.position);

    expect(substitutePlayer(state, { out: out.playerId, in: sub.id }).ok).toBe(true);
    expect(state.pendingMatch!.positionsPlayed?.[sub.id]).toBe(out.position);
    const seatBefore = proficiencyAt(sub, out.position);
    const benchBefore = benchPosition ? proficiencyAt(sub, benchPosition) : null;

    closeMatch(state);

    const player = userPlayers(state).find((p) => p.id === sub.id)!;
    // 저장된 값이 아니라 **조회한 값**으로 잰다 — 주발 보정은 저장에 들어가지 않고
    // `positionProficiency`가 읽을 때 얹는다 (player.md §8). 저장값으로 재면 좌우
    // 자리(RCB·LCB)에서 그 보정만큼 어긋난다
    expect(proficiencyAt(player, out.position)).toBe(seatBefore + MATCH_PROFICIENCY_GAIN);
    // 벤치에 걸려 있던 자리는 그대로다 — 그 자리에서 뛰지 않았다
    if (benchPosition && benchBefore !== null) {
      expect(proficiencyAt(player, benchPosition)).toBe(benchBefore);
    }
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
    const state = atMatchday();
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
    const state = atMatchday();
    startMatch(state);
    // 중앙 미드필더 하나를 골라 왼쪽으로만 벌린다
    const mid = assignmentsOf(state, state.userTeamId, "starting").find((a) =>
      ["CM", "CDM", "CAM", "LCM", "RCM"].includes(a.position),
    );
    // 어떤 프리셋에도 중원은 있다 — 없으면 셋업이 깨진 것이지 넘어갈 일이 아니다
    expect(mid, "선발에 중앙 미드필더가 없다").toBeDefined();
    const before = mid!.point ?? { x: 50, y: 50 };

    const moved = setPlayerTactic(state, { playerId: mid!.playerId, move: { lane: "left" } });
    expect(moved.ok, moved.message).toBe(true);
    const after = assignmentsOf(state, state.userTeamId).find(
      (a) => a.playerId === mid!.playerId,
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
      const state = atMatchday(11);
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
    const state = atMatchday();
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
    const state = atMatchday();
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
    const state = atMatchday();
    const { out, sub, packetSide } = kickoffWithCbSub(state);
    expect(state.roleMemory.some((m) => m.gamePlayerId === sub)).toBe(false);

    expect(substitutePlayer(state, { out: out.playerId, in: sub }).ok).toBe(true);

    const slot = packetSide().lineup.find((p) => p.id === sub);
    expect(slot?.roleId).toBe("ball-playing-defender");
    expect(slot?.position).toBe(out.position);
  });

  /** 다른 자리의 기억은 닿지 않는다 — 키는 (선수, 자리)다 (player.md §3.1) */
  it("다른 자리의 역할 기억은 교체 투입에 쓰이지 않는다", () => {
    const state = atMatchday();
    const { out, sub, packetSide } = kickoffWithCbSub(state);
    state.roleMemory.push({ gamePlayerId: sub, position: "DM", roleId: "anchor" });

    expect(substitutePlayer(state, { out: out.playerId, in: sub }).ok).toBe(true);

    expect(packetSide().lineup.find((p) => p.id === sub)?.roleId).toBe("ball-playing-defender");
  });

  /**
   * **어느 자리를 잇는지는 교체 사건이 정한다.** 두 자리가 함께 비어 있으면 적응도로
   * 고르는 판단은 둘을 맞바꾼다 — 감독이 뺀 자리와 들어간 자리가 어긋난다.
   */
  it("두 자리가 비어도 각자 나간 선수의 자리를 잇는다", () => {
    const state = atMatchday();
    const started = startMatch(state);
    expect(started.ok).toBe(true);
    const side = userSide(state);
    const mine =
      side === "home" ? state.pendingMatch!.ledger.home : state.pendingMatch!.ledger.away;
    const roster = userPlayers(state);
    const groupAt = (id: string) => groupOf(roster.find((p) => p.id === id)!);
    const xi = assignmentsOf(state, state.userTeamId, "starting").filter((a) =>
      mine.onPitch.includes(a.playerId),
    );
    const outDf = xi.find((a) => groupAt(a.playerId) === "DF")!;
    const outFw = xi.find((a) => groupAt(a.playerId) === "FW")!;
    // 자리를 가로질러 넣는다 — 수비수 자리에 공격수를, 공격수 자리에 수비수를
    const inFw = mine.bench.find((id) => groupAt(id) === "FW")!;
    const inDf = mine.bench.find((id) => groupAt(id) === "DF")!;

    expect(substitutePlayer(state, { out: outDf.playerId, in: inFw }).ok).toBe(true);
    expect(substitutePlayer(state, { out: outFw.playerId, in: inDf }).ok).toBe(true);

    const lineup = (
      side === "home" ? state.pendingMatch!.packet.home : state.pendingMatch!.packet.away
    ).lineup;
    expect(lineup.find((p) => p.id === inFw)?.position).toBe(outDf.position);
    expect(lineup.find((p) => p.id === inDf)?.position).toBe(outFw.position);
  });

  /**
   * **상대 팀은 그대로다** — `slotsFor`는 양 팀에 쓰이고, 기억이 없는 팀의 판은
   * 이 변경 전과 같은 값이어야 한다.
   */
  it("역할 기억이 없으면 판이 달라지지 않는다", () => {
    const withMemory = atMatchday();
    const plain = atMatchday();
    for (const state of [withMemory, plain]) startMatch(state);
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

describe("전술 XP는 천장이 있다", () => {
  it("태그 없는 경기는 0, 골 하나부터 골당 같은 폭으로 쌓인다", () => {
    expect(tacticalXpFor(0)).toBe(0);
    expect(tacticalXpFor(1)).toBe(TACTICAL_XP_PER_GOAL);
    expect(tacticalXpFor(2)).toBe(TACTICAL_XP_PER_GOAL * 2);
  });

  /** 천장이 없으면 약체 상대 대승 한 판이 전술 축을 통째로 앞당긴다 */
  it("천장을 넘어서면 더 넣어도 같다", () => {
    expect(tacticalXpFor(3)).toBe(TACTICAL_XP_CAP);
    expect(tacticalXpFor(9)).toBe(TACTICAL_XP_CAP);
  });
});

/**
 * 경기 전 상대 분석 (match.md §1.8) — **정답을 흘리지 않는가**와
 * **경기 전에 읽은 지점이 킥오프에 그대로 있는가**, 둘뿐이다.
 * 카드에 무엇이 서는가는 화면이 깨지는 순간 보이는 것이라 여기서 재지 않는다.
 */
describe("경기 전 상대 분석 (match.md §1.8)", () => {
  it("예상 XI에 부상·정지 선수는 서지 않고 결장 명단으로 간다", () => {
    const state = atMatchday();
    const first = buildOpponentReport(state);
    if (!first) throw new Error("상대 분석을 세우지 못했다");
    expect(first.expectedXI).toHaveLength(11);

    const [hurt, banned] = first.expectedXI;
    if (!hurt || !banned) throw new Error("예상 XI가 모자란다");
    state.injuries.push({
      id: "inj-preview",
      gamePlayerId: hurt.id,
      bodyPart: "발목",
      severity: "minor",
      cause: "match",
      occurredOn: state.date,
      expectedReturn: "2026-12-31",
      returnedOn: null,
    });
    state.suspensions.push({
      id: "susp-preview",
      gamePlayerId: banned.id,
      cause: "red",
      lengthMatches: 1,
      served: 0,
      status: "active",
      issuedOn: state.date,
    });

    const after = buildOpponentReport(state);
    if (!after) throw new Error("상대 분석을 세우지 못했다");
    const ids = after.expectedXI.map((p) => p.id);
    expect(ids).not.toContain(hurt.id);
    expect(ids).not.toContain(banned.id);
    // 빈자리는 메워진다 — 열 명으로 나오는 팀은 없다
    expect(after.expectedXI).toHaveLength(11);
    expect(after.absent.find((a) => a.id === hurt.id)?.reason).toBe("injury");
    expect(after.absent.find((a) => a.id === banned.id)?.reason).toBe("suspension");
  });

  /**
   * **경기 전에 노린 지점을 경기 중에 그대로 부를 수 있어야 한다** — 표적 id가
   * `축:선수id`라(§1.6) 이 등식이 곧 그 뜻이다. 라인업이 갈리면 성립할 이유가
   * 없으므로 XI가 같은지를 먼저 세운다.
   */
  it("라인업이 그대로면 리포트의 표적 id가 킥오프 패킷의 표적 id다", () => {
    const state = atMatchday();
    const report = buildOpponentReport(state);
    if (!report) throw new Error("상대 분석을 세우지 못했다");

    expect(startMatch(state).ok).toBe(true);
    const pending = state.pendingMatch!;
    const side = userSide(state);
    const startingXI = pending.startingXI!;
    const theirXI = side === "home" ? startingXI.away : startingXI.home;
    // 전제 — 상대가 예상대로 나왔다 (로테이션이 없으면 매치데이 1은 늘 이 자리다)
    expect([...theirXI].sort()).toEqual(report.expectedXI.map((p) => p.id).sort());

    const idsOf = (targets: readonly { id: string }[]) => targets.map((t) => t.id).sort();
    expect(idsOf(report.targets)).toEqual(idsOf(pending.packet.targets));
  });

  it("경기 중에는 다음 상대의 분석을 세우지 않는다", () => {
    const state = atMatchday();
    expect(startMatch(state).ok).toBe(true);
    expect(buildOpponentReport(state)).toBeNull();
    expect(buildOfficeViews(state).competitions.preview).toBeNull();
  });
});
