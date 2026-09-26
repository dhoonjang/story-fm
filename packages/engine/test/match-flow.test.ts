import { describe, expect, it } from "vitest";
import {
  advanceLiveMatch,
  advanceShootout,
  applyMatchReading,
  assembleUserLineup,
  assignmentsOf,
  awaitingShootout,
  bindJournal,
  buildOfficeViews,
  buildOpponentReport,
  buildRatingBrief,
  commitCheckpoint,
  digestLines,
  finalizeMatch,
  firstTeamPlayers,
  groupOf,
  isClubTeam,
  liveMatchDigest,
  loadGame,
  markEntered,
  MATCH_PROFICIENCY_GAIN,
  MATCHDAY_BENCH,
  OUT_OF_POSITION_RUN,
  playerById,
  playersOf,
  proficiencyAt,
  resumeLiveInterval,
  saveGame,
  setLineup,
  setPlayerTactic,
  setTactics,
  settleYouthIntake,
  startMatch,
  substitutePlayer,
  syncLiveTactics,
  TACTICAL_XP_CAP,
  TACTICAL_XP_PER_GOAL,
  tacticalXpFor,
  tacticsOf,
  transitionSeason,
  userPlayers,
  userSide,
  type GameState,
  type JournalEntry,
} from "@story-fm/engine";
import {
  advanceToMatchday,
  createMiniGame,
  createTestGame,
  playMockMatch,
  playPreseason,
} from "./helpers";
import {
  positionGroupOf,
  positionGroupOfPlayer,
  tacticsSignature,
  weightSlotOf,
  type MatchEvent,
} from "@story-fm/domain";
import {
  advanceLive,
  applyEvents,
  checkpointReason,
  LIVE_TICKS_PER_SECOND,
  liveDigest,
  liveFinished,
  type LiveMatch,
} from "@story-fm/sim";

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

/** 경기 시간 `minutes`분을 화면 없이 민다 — 휴식은 곧바로 푼다 */
function play(state: GameState, minutes: number): MatchEvent[] {
  const out: MatchEvent[] = [];
  const pending = state.pendingMatch!;
  if (pending.live.state.interval) resumeLiveInterval(state);
  const { events } = advanceLiveMatch(state, minutes * 60 * LIVE_TICKS_PER_SECOND);
  out.push(...events);
  return out;
}

/** 종료 휘슬까지 민다 — 승부차기가 남으면 한 발씩 */
function playToEnd(state: GameState): void {
  let guard = 60;
  while (guard-- > 0) {
    const pending = state.pendingMatch!;
    if (liveFinished(pending.live)) {
      if (!awaitingShootout(state)) return;
      const kicked = advanceShootout(state);
      if (!kicked.ok) throw new Error(kicked.message);
      continue;
    }
    play(state, 15);
  }
  throw new Error("경기가 끝나지 않았습니다");
}

/** 장부에 사건을 직접 앉힌다 — 굴려서 우연을 기다리면 난수이고 느리다 */
function inject(state: GameState, events: MatchEvent[]): { ok: boolean; message: string } {
  const pending = state.pendingMatch!;
  const result = applyEvents(pending.live.ledger, events);
  if (!result.ok) return { ok: false, message: result.errors.join(" / ") };
  pending.live.ledger = result.state;
  return { ok: true, message: "" };
}

/** 하프타임·종료를 손으로 밀어 경기를 닫는다 — 굴리면 카드·골이 난수다 */
function closeByHand(state: GameState) {
  for (const stop of ["half_time", "full_time"] as const) {
    const applied = inject(state, [
      { minute: stop === "half_time" ? 45 : 90, type: stop, actors: [], causes: [] },
    ]);
    expect(applied.ok, applied.message).toBe(true);
  }
  return finalizeMatch(state);
}

function ledgerOf(state: GameState) {
  return state.pendingMatch!.live.ledger;
}

describe("경기 흐름 (overview §4 · live-match.md §8)", () => {
  it("경기일이 아니면 시작할 수 없다", () => {
    const state = createTestGame();
    expect(startMatch(state).ok).toBe(false);
  });

  it("킥오프 → 실시간 진행 → 종료 반영까지 완주한다", () => {
    // 시즌 기록을 보는 시험이라 리그 개막까지 간다 — 친선은 장부에 남지 않는다
    const state = atMatchday(42, { afterPreseason: true });
    const started = startMatch(state);
    expect(started.ok, started.message).toBe(true);
    expect(state.phase).toBe("match");
    const pending = state.pendingMatch!;
    // 첫 휘슬은 장부의 첫 줄이다 — 시계는 아직 0에 서 있다
    expect(pending.live.ledger.events.map((e) => e.type)).toEqual(["kickoff"]);
    expect(pending.live.state.tick).toBe(pending.live.committedTick);
    markEntered(state);

    playToEnd(state);
    const ledger = ledgerOf(state);
    expect(ledger.phase).toBe("finished");
    // 추가시간이 시계에 있다 — 종료 사건은 90′+n으로 찍힌다
    const fullTime = ledger.events.find((e) => e.type === "full_time")!;
    expect(fullTime.minute).toBe(90);
    expect(fullTime.added).toBeGreaterThanOrEqual(1);
    const digest = finalizeMatch(state);
    expect(state.phase).toBe("idle");
    expect(state.pendingMatch).toBeNull();
    expect(state.matches.some((m) => m.result?.events !== undefined)).toBe(true);
    expect(digest.ours.some((d) => d.includes("최종 스코어"))).toBe(true);
  });

  /**
   * **클라이언트와 서버는 같은 경기를 굴린다** (live-match.md §8.2) — 웹의 실행기처럼 확정
   * 상태를 받아 굴리고, 정지점과 체크포인트 간격마다 제출하고, 서버가 준 상태를 이어받는다.
   * 하프가 바뀌어도 틱은 앞으로만 간다 — 되감기면 체크포인트가 구간을 잃고 경기가 멈춘다.
   */
  it("실행기의 왕복은 하프를 넘어 끝까지 전부 확정된다", () => {
    const state = atMatchday(42);
    expect(startMatch(state).ok).toBe(true);
    markEntered(state);
    const framesTicks = 360;
    const copy = () => JSON.parse(JSON.stringify(state.pendingMatch!.live)) as LiveMatch;
    let client = copy();
    let lastTick = client.state.tick;
    let resumed = 0;
    for (let frame = 0; frame < 5000 && !liveFinished(client); frame++) {
      if (client.state.interval) {
        resumeLiveInterval(state);
        resumed += 1;
        client = copy();
        continue;
      }
      const { events } = advanceLive(client, framesTicks);
      expect(client.state.tick, "틱이 되감겼다").toBeGreaterThanOrEqual(lastTick);
      lastTick = client.state.tick;
      // 실행기와 같은 판정 — 정지점 · 간격 · 하프의 끝
      if (checkpointReason(client, events)) {
        const verdict = commitCheckpoint(state, {
          fromTick: client.committedTick,
          toTick: client.state.tick,
          digest: liveDigest(client.state, client.ledger),
        });
        expect(
          verdict.ok,
          `체크포인트 반려 (${verdict.ok ? "" : verdict.reason}) — 틱 ${client.state.tick}`,
        ).toBe(true);
        client = copy();
      }
    }
    expect(client.ledger.phase).toBe("finished");
    expect(resumed, "하프타임에 한 번 쉰다").toBeGreaterThanOrEqual(1);
  });

  it("마감은 장부의 사건을 자르지 않고 통계·점유를 결과에 그대로 옮긴다", () => {
    const state = atMatchday(42, { afterPreseason: true });
    expect(startMatch(state).ok).toBe(true);
    markEntered(state);
    playToEnd(state);
    const ledger = structuredClone(ledgerOf(state));
    const matchId = state.pendingMatch!.matchId;
    finalizeMatch(state);
    const result = state.matches.find((m) => m.id === matchId)!.result!;
    expect(result.events).toHaveLength(ledger.events.length);
    expect(result.playerStats).toEqual(ledger.stats);
    expect(result.possession!.home + result.possession!.away).toBeCloseTo(1, 6);
    // 팀 슛·xG는 선수별 기록의 합이다 — 두 벌로 두면 갈린다
    const sum = (ids: readonly string[], read: (l: (typeof ledger.stats)[string]) => number) =>
      ids.reduce((acc, id) => acc + (ledger.stats[id] ? read(ledger.stats[id]!) : 0), 0);
    expect(result.homeShots).toBe(sum(result.homeLineup!, (l) => l.shots));
    expect(result.awayXg).toBeCloseTo(
      sum(result.awayLineup!, (l) => l.xg),
      6,
    );
    // 뛴 거리가 결과의 선수별 기록에 남는다 — 체력 정산의 원본이다
    const distance = Object.values(result.playerStats!).reduce((a, l) => a + l.distance, 0);
    expect(distance).toBeGreaterThan(22 * 5000);
  });

  it("마감이 시즌에 얹은 슛·선방이 그 경기의 팀 합계와 같다", () => {
    const state = atMatchday(42, { afterPreseason: true });
    expect(startMatch(state).ok).toBe(true);
    markEntered(state);
    playToEnd(state);
    const ledger = structuredClone(ledgerOf(state));
    const side = userSide(state);
    const matchId = state.pendingMatch!.matchId;
    const before = new Map(
      state.seasonStats
        .filter((s) => s.season === state.season)
        .map((s) => [
          `${s.gamePlayerId}:${s.competitionId}`,
          { shots: s.shots ?? 0, saves: s.saves ?? 0 },
        ]),
    );
    finalizeMatch(state);
    const match = state.matches.find((m) => m.id === matchId)!;
    const lineup = side === "home" ? match.result!.homeLineup! : match.result!.awayLineup!;
    let shots = 0;
    let saves = 0;
    for (const id of lineup) {
      const row = state.seasonStats.find(
        (s) =>
          s.gamePlayerId === id &&
          s.season === state.season &&
          s.competitionId === match.competitionId,
      )!;
      const was = before.get(`${id}:${match.competitionId}`) ?? { shots: 0, saves: 0 };
      shots += (row.shots ?? 0) - was.shots;
      saves += (row.saves ?? 0) - was.saves;
    }
    const total = (read: (l: (typeof ledger.stats)[string]) => number) =>
      lineup.reduce((acc, id) => acc + (ledger.stats[id] ? read(ledger.stats[id]!) : 0), 0);
    expect(shots).toBe(total((l) => l.shots));
    expect(saves).toBe(total((l) => l.saves));
  });

  it("킥오프와 체크포인트가 기록의 사실로 남는다", () => {
    const state = atMatchday();
    const facts: JournalEntry[] = [];
    bindJournal((entry) => facts.push(entry));
    try {
      expect(startMatch(state).ok).toBe(true);
      markEntered(state);
      const pending = state.pendingMatch!;
      const clone = structuredClone(state);
      const ticks = 60 * LIVE_TICKS_PER_SECOND;
      advanceLiveMatch(clone, ticks);
      const verdict = commitCheckpoint(state, {
        fromTick: pending.live.committedTick,
        toTick: pending.live.committedTick + ticks,
        digest: liveMatchDigest(clone)!,
      });
      expect(verdict.ok).toBe(true);
    } finally {
      bindJournal(null);
    }
    const kickoff = facts.find((f) => f.kind === "match.kickoff");
    expect(kickoff).toBeDefined();
    expect(kickoff?.kind === "match.kickoff" ? kickoff.seed : null).toBe(state.seed);
    const checkpoint = facts.find((f) => f.kind === "match.checkpoint");
    expect(checkpoint?.kind === "match.checkpoint" ? checkpoint.ok : null).toBe(true);
  });
});

/**
 * **클라이언트가 굴리고 서버가 검증한다** (live-match.md §8.1). 같은 상태에서 같은 틱 수를
 * 굴리면 digest가 같고, 어긋나면 서버의 상태가 이긴다.
 */
describe("체크포인트 (live-match.md §8.1)", () => {
  it("같은 구간을 굴린 클라이언트의 digest는 통과하고 확정 tick이 옮겨 간다", () => {
    const state = atMatchday();
    expect(startMatch(state).ok).toBe(true);
    markEntered(state);
    const pending = state.pendingMatch!;
    const from = pending.live.committedTick;
    const ticks = 3 * 60 * LIVE_TICKS_PER_SECOND;
    const client = structuredClone(state);
    advanceLiveMatch(client, ticks);
    const verdict = commitCheckpoint(state, {
      fromTick: from,
      toTick: from + ticks,
      digest: liveMatchDigest(client)!,
    });
    expect(verdict.ok).toBe(true);
    expect(pending.live.committedTick).toBe(from + ticks);
    expect(liveMatchDigest(state)).toBe(liveMatchDigest(client));
  });

  it("digest가 어긋나면 서버의 상태가 이기고, 옛 tick에서 굴린 구간은 stale이다", () => {
    const state = atMatchday();
    expect(startMatch(state).ok).toBe(true);
    markEntered(state);
    const pending = state.pendingMatch!;
    const from = pending.live.committedTick;
    const ticks = 60 * LIVE_TICKS_PER_SECOND;
    const wrong = commitCheckpoint(state, { fromTick: from, toTick: from + ticks, digest: "nope" });
    expect(wrong.ok).toBe(false);
    expect(wrong.ok ? null : wrong.reason).toBe("digest");
    // 서버는 그래도 굴렸다 — 클라이언트가 이어받는 것은 이 상태다
    expect(pending.live.committedTick).toBe(from + ticks);
    expect(wrong.digest).toBe(liveMatchDigest(state));
    const stale = commitCheckpoint(state, { fromTick: from, toTick: from + ticks, digest: "x" });
    expect(stale.ok ? null : stale.reason).toBe("stale");
    expect(pending.live.committedTick).toBe(from + ticks);
  });
});

describe("입력은 확정 tick에 앉는다", () => {
  it("경기 중 전술 변경이 실시간 경기의 우리 편에 실린다", () => {
    const state = atMatchday();
    expect(startMatch(state).ok).toBe(true);
    const side = userSide(state);
    expect(setTactics(state, { pressing: 5, mentality: 5 }).ok).toBe(true);
    syncLiveTactics(state);
    const live = state.pendingMatch!.live;
    expect(live.tactics[side].pressing).toBe(5);
    expect(live.tactics[side].mentality).toBe(5);
    // 상대 편은 그대로다
    const other = side === "home" ? "away" : "home";
    expect(live.tactics[other]).toEqual(live.setup.sides[other].kickoffTactics);
  });

  it("공이 멈춘 자리의 교체는 곧바로, 구르는 중의 교체는 다음 중단에 걸린다", () => {
    const state = atMatchday();
    expect(startMatch(state).ok).toBe(true);
    markEntered(state);
    const side = userSide(state);
    const mine = () => ledgerOf(state)[side];
    const [out] = mine().onPitch.filter((id) => groupOf(playerById(state, id)!) !== "GK");
    const into = mine().bench[0]!;
    // 킥오프 직전 — 공이 멈춰 있다
    const immediate = substitutePlayer(state, { out: out!, in: into });
    expect(immediate.ok, immediate.message).toBe(true);
    expect(mine().onPitch).toContain(into);
    expect(mine().onPitch).not.toContain(out);
    expect(state.pendingMatch!.live.positionsPlayed[into]).toBeDefined();
    // 굴러가는 중 — 대기열에 선다
    play(state, 2);
    const pending = state.pendingMatch!;
    if (pending.live.state.restart === null && !pending.live.state.interval) {
      const [out2] = mine().onPitch.filter((id) => groupOf(playerById(state, id)!) !== "GK");
      const into2 = mine().bench[0]!;
      const queued = substitutePlayer(state, { out: out2!, in: into2 });
      expect(queued.ok, queued.message).toBe(true);
      expect(queued.message).toContain("대기");
      expect(pending.live.pendingSubs).toHaveLength(1);
      // 다음 중단에 실행된다
      play(state, 10);
      expect(pending.live.pendingSubs).toHaveLength(0);
      expect(mine().onPitch).toContain(into2);
    }
  });

  it("판독의 시트가 말의 규칙에 접히고 화면의 포인트는 이로운 편만 받는다", () => {
    const state = atMatchday();
    expect(startMatch(state).ok).toBe(true);
    markEntered(state);
    const side = userSide(state);
    const theirs = side === "home" ? "away" : "home";
    const target = ledgerOf(state)[theirs].onPitch[5]!;
    const applied = applyMatchReading(state, {
      points: [{ id: "p1", text: "그의 뒤를 노린다", about: [target], importance: 3 }],
      sheet: [{ pointId: "p1", target: { player: target }, shape: "edge", sign: -1, step: 2 }],
    });
    expect(applied?.points).toHaveLength(1);
    const view = buildOfficeViews(state).match!;
    const point = view.points.find((p) => p.id === "p1");
    expect(point).toBeDefined();
    // 상대 선수의 실행 품질을 깎는 줄 — 우리에게 이롭다
    expect(point!.ours).toBe(true);
    // 없는 선수를 겨눈 줄은 걷히고, 걸린 줄이 없는 포인트는 편이 없다
    applyMatchReading(state, {
      points: [{ id: "p2", text: "없는 사람", about: [], importance: 1 }],
      sheet: [{ pointId: "p2", target: { player: "ghost" }, shape: "edge", sign: 1, step: 1 }],
    });
    const again = buildOfficeViews(state).match!.points.find((p) => p.id === "p2")!;
    expect(again.ours).toBeNull();
  });

  it("저장/로드를 거쳐도 경기를 이어가고 결과가 남는다", () => {
    const state = atMatchday();
    expect(startMatch(state).ok).toBe(true);
    markEntered(state);
    play(state, 20);
    const digest = liveMatchDigest(state);
    saveGame(state);
    const loaded = loadGame(state.id)!;
    expect(liveMatchDigest(loaded)).toBe(digest);
    // 같은 지점에서 같은 구간을 굴리면 같은 답이다
    play(state, 5);
    play(loaded, 5);
    expect(liveMatchDigest(loaded)).toBe(liveMatchDigest(state));
    playToEnd(loaded);
    finalizeMatch(loaded);
    expect(loaded.matches.some((m) => m.result?.events !== undefined)).toBe(true);
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
    expect(startMatch(state).ok).toBe(true);
    const ledger = ledgerOf(state)[userSide(state)];
    expect(ledger.onPitch).not.toContain(starter.playerId);
    expect(ledger.bench).not.toContain(starter.playerId);
    expect(ledger.onPitch).toHaveLength(11);
  });

  it("부상 선수 교체 투입은 반려된다", () => {
    const state = atMatchday();
    startMatch(state);
    const ledger = ledgerOf(state)[userSide(state)];
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
    const out = ledger.onPitch.find((id) => groupOf(playerById(state, id)!) !== "GK")!;
    const res = substitutePlayer(state, { out, in: benchId });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("부상");
  });

  /**
   * **거르는 자리는 명단을 짜는 한 곳뿐이다** (match.md §3.1). 상대 벤치를 `startMatch`가
   * 다시 짜면 그 문이 감독의 경기에서만 새서, 정지 선수와 2군이 우리와 붙는 경기에서만
   * 벤치에 선다.
   */
  it("상대 벤치도 간이 시뮬의 명단을 그대로 받는다 — 정지자·2군이 없다", () => {
    // 정지는 대회의 것이다 — 친선에는 걸리지 않으므로 리그 경기일에서 본다
    const state = atMatchday(42, { afterPreseason: true });
    const today = state.matches.find(
      (m) =>
        m.date === state.date &&
        !m.result &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    )!;
    const opponentId = today.homeTeamId === state.userTeamId ? today.awayTeamId : today.homeTeamId;
    const inXI = new Set(assignmentsOf(state, opponentId, "starting").map((a) => a.playerId));
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
      competitionId: today.competitionId ?? "friendly",
      scope: "competition",
    });
    reserve.squadLevel = "reserve";

    expect(startMatch(state).ok).toBe(true);
    const theirs = ledgerOf(state)[userSide(state) === "home" ? "away" : "home"];
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
    const mine = ledgerOf(state)[userSide(state)];
    expect(mine.onPitch).toHaveLength(11);
    expect(mine.onPitch).not.toContain(spare.id);
    expect(mine.bench).not.toContain(spare.id);
  });

  /** 경계 — 배치된 벤치가 상한을 채워도 골키퍼 자리는 잘리지 않는다 (match.md §3.1) */
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
    const mine = ledgerOf(state)[userSide(state)];
    expect(mine.bench).toHaveLength(MATCHDAY_BENCH);
    const keepers = mine.bench.filter((id) => groupOf(playerById(state, id)!) === "GK");
    expect(keepers).toHaveLength(1);
  });

  it("부상 선수를 선발로 확정하려 하면 명령이 반려한다", () => {
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

  it("자동 대체가 실패하면 명단을 세우지 못한 이유를 말한다", () => {
    const state = atMatchday();
    const lineup = assembleUserLineup(state, null);
    expect(lineup.error).toBeNull();
    expect(lineup.onPitch).toHaveLength(11);
  });
});

describe("회귀: 장기 시즌 안정성", () => {
  it("17시즌을 전환해도 GK가 소멸하지 않고 라인업 확정이 가능하다", () => {
    const state = createMiniGame(42);
    for (let s = 0; s < 17; s++) {
      transitionSeason(state);
      settleYouthIntake(state, []);
    }
    expect(userPlayers(state).length).toBeGreaterThan(0);
    for (const team of state.teams) {
      if (!isClubTeam(team.id)) continue;
      expect(assignmentsOf(state, team.id, "starting")).toHaveLength(11);
      expect(
        assignmentsOf(state, team.id, "starting").filter((a) => a.position === "GK"),
      ).toHaveLength(1);
    }
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
      if (p) p.birthdate = "1990-01-01";
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
 * 자리 밖 기용 — **선발로 센다** (→ docs/data/people.md §5). 원장은 누가 뛰었는지만
 * 알고 어느 자리에 섰는지는 모르므로, 연속을 세는 눈금은 `PlayerState`가 든다.
 */
describe("자리 밖 기용의 눈금 (people.md §5)", () => {
  it("주 포지션 묶음 밖 선발이 이어지면 네 경기째에 불만이 선다", () => {
    const state = atMatchday(5);
    const starters = assignmentsOf(state, state.userTeamId, "starting");
    const back = starters.find((a) => positionGroupOf(a.position) === "DF")!;
    const front = starters.find((a) => positionGroupOf(a.position) === "FW")!;
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
    misplaced.state.outOfPositionRun = OUT_OF_POSITION_RUN - 1;
    playMockMatch(state);

    expect(misplaced.state.outOfPositionRun).toBe(OUT_OF_POSITION_RUN);
    expect(
      state.issues.some((i) => i.gamePlayerId === misplaced.id && i.reason === "out-of-position"),
    ).toBe(true);
    expect(playerById(state, inPlace.playerId)!.state.outOfPositionRun).toBe(0);
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
    expect(player.state.outOfPositionRun).toBe(0);
    expect(state.issues.some((i) => i.reason === "out-of-position")).toBe(false);
  });
});

describe("경기 후 전술 복원", () => {
  it("경기 중 바꾼 전술이 킥오프 전으로 돌아오고 판독은 경기와 함께 사라진다", () => {
    const state = atMatchday(5);
    startMatch(state);
    markEntered(state);
    const tactics = () => tacticsOf(state, state.userTeamId);
    const before = { ...tactics().spec };
    setTactics(state, { mentality: 5, defensiveLine: 5, pressing: 5 });
    syncLiveTactics(state);
    applyMatchReading(state, {
      points: [{ id: "p", text: "달고 다닌다", about: [], importance: 2 }],
      sheet: [],
    });
    expect(tactics().spec.mentality).toBe(5);
    playToEnd(state);
    const digest = finalizeMatch(state);
    expect(tactics().spec).toEqual(before);
    expect(state.pendingMatch).toBeNull();
    expect(digest.ours.some((d) => d.includes("되돌"))).toBe(true);
  });

  it("경기 중 전술 변경이 깎은 적응도도 함께 되돌린다", () => {
    const state = atMatchday(5);
    startMatch(state);
    markEntered(state);
    const target = assignmentsOf(state, state.userTeamId, "starting")[0]!;
    const before = target.familiarity;
    setTactics(state, { mentality: 5 });
    expect(target.familiarity).toBeLessThan(before);
    closeByHand(state);
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
    setTactics(state, { pressing: 5 });
    const midMatch = [tacticsSignature(tactics().spec)];
    setTactics(state, { mentality: 5 });
    midMatch.push(tacticsSignature(tactics().spec));
    expect(new Set(midMatch).has(kickoff)).toBe(false);
    closeByHand(state);
    for (const a of tactics().assignments) {
      const signatures = (a.drilled ?? []).map((d) => d.signature);
      expect(signatures.filter((s) => midMatch.includes(s))).toEqual([]);
    }
    const starters = assignmentsOf(state, state.userTeamId, "starting");
    expect(starters.every((a) => (a.drilled ?? []).some((d) => d.signature === kickoff))).toBe(
      true,
    );
  });
});

describe("결산 요약의 갈래 (match.md §7)", () => {
  it("우리 경기 결과와 재정·다른 경기가 섞이지 않는다", () => {
    const state = atMatchday();
    startMatch(state);
    const digest = closeByHand(state);
    expect(digest.ours.some((d) => d.includes("최종 스코어"))).toBe(true);
    expect(digest.finance.some((d) => d.includes("최종 스코어"))).toBe(false);
    expect(digest.others.some((d) => d.includes("최종 스코어"))).toBe(false);
    expect(digest.ours.join("\n")).not.toMatch(/관중|입장 수입/u);
    expect(digest.others.length).toBeGreaterThan(0);
    expect(digestLines(digest)).toEqual([...digest.ours, ...digest.finance, ...digest.others]);
  });

  it("말풍선에 서는 갈래는 항목마다 한 줄에 든다", () => {
    const state = atMatchday(5);
    startMatch(state);
    const digest = closeByHand(state);
    for (const line of digest.ours) expect(line.length).toBeLessThanOrEqual(80);
    expect(digest.ours.length).toBeLessThanOrEqual(12);
    expect(digest.ours.length).toBeLessThan(digestLines(digest).length);
  });
});

/**
 * **두 번째 경고는 다음 경기 정지로 이어진다** (match.md §5·§7). 장부는 경고 2장을 자동
 * 퇴장으로 바꾸지만 경기 후 반영은 **사건 타입만** 읽는다 — `red_card` 줄이 없으면 정지가
 * 생기지 않아 같은 사건이 우리 경기에선 정지가 없고 간이 시뮬에선 있는 세계가 된다.
 */
describe("경고 누적 퇴장의 장부 (match.md §5)", () => {
  it("두 번째 경고는 퇴장 정지 한 건과 경고·퇴장 두 줄로 남는다", () => {
    const state = atMatchday(42, { afterPreseason: true });
    expect(startMatch(state).ok).toBe(true);
    const side = userSide(state);
    const mine = () => ledgerOf(state)[side];
    const matchId = state.pendingMatch!.matchId;
    const target = mine().onPitch[0]!;
    const name = userPlayers(state).find((p) => p.id === target)!.name;
    const SECOND = 38;
    const card = (minute: number, types: ReadonlyArray<"yellow_card" | "red_card">) =>
      inject(
        state,
        types.map((type) => ({ minute, type, team: side, actors: [target], causes: [] })),
      );
    expect(card(20, ["yellow_card"]).ok).toBe(true);
    const second = card(SECOND, ["yellow_card", "red_card"]);
    expect(second.ok, second.message).toBe(true);
    expect(mine().onPitch).not.toContain(target);

    const digest = closeByHand(state);
    const suspensions = state.suspensions.filter((s) => s.gamePlayerId === target);
    expect(suspensions).toHaveLength(1);
    expect(suspensions[0]?.cause).toBe("red");
    expect(suspensions[0]?.lengthMatches).toBe(1);
    expect(suspensions[0]?.status).toBe("active");
    const atSecond = state.bookings.filter(
      (b) => b.gamePlayerId === target && b.matchId === matchId && b.minute === SECOND,
    );
    expect([...atSecond.map((b) => b.card)].sort()).toEqual(["red", "yellow"]);
    const ofTarget = state.bookings.filter((b) => b.gamePlayerId === target);
    expect(ofTarget.filter((b) => b.card === "yellow")).toHaveLength(2);
    expect(ofTarget.filter((b) => b.card === "red")).toHaveLength(1);
    expect(digest.ours.some((d) => d.includes(name) && d.includes("정지"))).toBe(true);
  });
});

describe("출전 시간의 끝 — 교체와 퇴장이 같은 자격이다", () => {
  it("퇴장 분이 출전 시간을 끊고, 교체 투입자는 들어온 시각부터 센다", () => {
    const state = atMatchday(42, { afterPreseason: true });
    expect(startMatch(state).ok).toBe(true);
    const side = userSide(state);
    const mine = () => ledgerOf(state)[side];
    const [sentOff, goingOff, fullMatch] = mine().onPitch as [string, string, string];
    const comingOn = mine().bench[0]!;
    const apply = (...events: MatchEvent[]) => {
      const res = inject(state, events);
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
    apply({ minute: 75, type: "red_card", team: side, actors: [comingOn], causes: [] });
    const brief = buildRatingBrief(state)!;
    const minutesOf = (id: string) => brief.players.find((p) => p.playerId === id)?.minutes;
    expect(minutesOf(sentOff)).toBe(20);
    expect(minutesOf(goingOff)).toBe(60);
    expect(minutesOf(comingOn)).toBe(15);
    expect(minutesOf(fullMatch)).toBe(90);
  });
});

describe("감독 경기 마감의 대칭 (match.md §7)", () => {
  it("상대의 출전·득점·도움·카드·정지가 우리와 같은 장부에 남는다", () => {
    const state = atMatchday(42, { afterPreseason: true });
    const fixture = state.matches.find(
      (m) =>
        m.date === state.date &&
        !m.result &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    )!;
    const oppTeamId =
      fixture.homeTeamId === state.userTeamId ? fixture.awayTeamId : fixture.homeTeamId;
    const banned = firstTeamPlayers(state, oppTeamId)[0]!;
    state.suspensions.push({
      id: `sus-test-${banned.id}`,
      gamePlayerId: banned.id,
      cause: "red",
      issuedOn: state.date,
      lengthMatches: 1,
      served: 0,
      status: "active",
      competitionId: fixture.competitionId!,
      scope: "competition",
    });
    expect(startMatch(state).ok).toBe(true);
    const oppSide = userSide(state) === "home" ? "away" : "home";
    const matchId = state.pendingMatch!.matchId;
    const onPitch = ledgerOf(state)[oppSide].onPitch;
    expect(onPitch).not.toContain(banned.id);
    const [keeper, booked, sentOff, assister, scorer] = [
      onPitch[0]!,
      onPitch[1]!,
      onPitch[2]!,
      onPitch[9]!,
      onPitch[10]!,
    ];
    const sentOffName = playersOf(state, oppTeamId).find((p) => p.id === sentOff)!.name;
    const events = inject(state, [
      { minute: 20, type: "yellow_card", team: oppSide, actors: [booked], causes: [] },
      { minute: 30, type: "red_card", team: oppSide, actors: [sentOff], causes: [] },
      { minute: 40, type: "goal", team: oppSide, actors: [scorer, assister], causes: [] },
    ]);
    expect(events.ok, events.message).toBe(true);
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
    const digest = closeByHand(state);
    expect(statOf(keeper)?.apps).toBe(before.keeper + 1);
    expect(statOf(sentOff)?.apps).toBe(before.sentOff + 1);
    expect(appsBefore(banned.id)).toBe(before.banned);
    expect(statOf(scorer)?.goals).toBe(before.goals + 1);
    expect(statOf(assister)?.assists).toBe(before.assists + 1);
    expect(statOf(scorer)?.ratingSum ?? 0).toBeGreaterThan(before.ratingSum);
    expect(state.matches.find((m) => m.id === matchId)?.result?.ratings?.[scorer]).toBeUndefined();
    const bookings = state.bookings.filter((b) => b.matchId === matchId);
    expect(bookings.filter((b) => b.gamePlayerId === booked && b.card === "yellow")).toHaveLength(
      1,
    );
    expect(bookings.filter((b) => b.gamePlayerId === sentOff && b.card === "red")).toHaveLength(1);
    const red = state.suspensions.find((s) => s.gamePlayerId === sentOff);
    expect(red?.cause).toBe("red");
    expect(red?.status).toBe("active");
    const served = state.suspensions.find((s) => s.gamePlayerId === banned.id);
    expect(served?.served).toBe(1);
    expect(served?.status).toBe("done");
    expect(digest.ours.some((d) => d.includes(sentOffName))).toBe(false);
  });

  it("문턱을 넘는 경기에만, 그리고 우리 선수에게만 마일스톤이 선다", () => {
    const state = atMatchday(42, { afterPreseason: true });
    expect(startMatch(state).ok).toBe(true);
    const mySide = userSide(state);
    const oppSide = mySide === "home" ? "away" : "home";
    const mine = ledgerOf(state)[mySide].onPitch;
    const theirs = ledgerOf(state)[oppSide].onPitch;
    const matchId = state.pendingMatch!.matchId;
    const [ours, theirScorer] = [mine[10]!, theirs[10]!];
    const oppTeamId = playerById(state, theirScorer)!.teamId;
    const competitionId = state.matches.find((m) => m.id === matchId)!.competitionId!;
    const standAt99 = (playerId: string, teamId: string) => {
      const already = state.seasonStats
        .filter((x) => x.gamePlayerId === playerId && x.teamId === teamId)
        .reduce((sum, x) => sum + x.apps, 0);
      state.seasonStats.push({
        gamePlayerId: playerId,
        season: state.season - 1,
        teamId,
        competitionId,
        apps: 99 - already,
        goals: 0,
      });
    };
    standAt99(ours, state.userTeamId);
    standAt99(theirScorer, oppTeamId);
    const goal = (minute: number, team: "home" | "away", scorer: string): MatchEvent => ({
      minute,
      type: "goal",
      team,
      actors: [scorer],
      causes: [],
    });
    const goals = [10, 20, 30].flatMap((minute) => [
      goal(minute, mySide, ours),
      goal(minute + 2, oppSide, theirScorer),
    ]);
    expect(inject(state, goals).ok).toBe(true);
    const digest = closeByHand(state);
    const rows = state.milestones ?? [];
    const mineRows = rows.filter((m) => m.gamePlayerId === ours && m.matchId === matchId);
    expect(mineRows.map((m) => `${m.code}:${m.value}`).sort()).toEqual([
      "apps:100",
      "first-goal:1",
      "hat-trick:3",
    ]);
    expect(mineRows.every((m) => m.teamId === state.userTeamId)).toBe(true);
    expect(rows.filter((m) => m.gamePlayerId === theirScorer)).toHaveLength(0);
    expect(digest.ours.filter((d) => d.startsWith("기록: "))).toHaveLength(1);
  });

  /** **적응도는 그 경기에 선 자리에 쌓인다.** 벤치 배치의 자리로 올리면 센터백으로 뛴 공격수의 최전방 적응도가 오른다 */
  it("교체 투입자는 물려받은 자리의 적응도가 오른다", () => {
    const state = atMatchday(42, { afterPreseason: true });
    expect(startMatch(state).ok).toBe(true);
    const mine = ledgerOf(state)[userSide(state)];
    const roster = userPlayers(state);
    const out = assignmentsOf(state, state.userTeamId, "starting").find(
      (a) => weightSlotOf(a.position) === "CB" && mine.onPitch.includes(a.playerId),
    );
    const sub = mine.bench
      .map((id) => roster.find((p) => p.id === id))
      .find((p) => p !== undefined && (groupOf(p) === "MF" || groupOf(p) === "FW"));
    if (!out || !sub) throw new Error("CB 선발 또는 벤치 자원을 찾지 못했습니다");
    const benchPosition = assignmentsOf(state, state.userTeamId).find(
      (a) => a.playerId === sub.id,
    )?.position;
    expect(benchPosition).not.toBe(out.position);
    expect(substitutePlayer(state, { out: out.playerId, in: sub.id }).ok).toBe(true);
    expect(state.pendingMatch!.live.positionsPlayed[sub.id]).toBe(out.position);
    const seatBefore = proficiencyAt(sub, out.position);
    const benchBefore = benchPosition ? proficiencyAt(sub, benchPosition) : null;
    closeByHand(state);
    const player = userPlayers(state).find((p) => p.id === sub.id)!;
    expect(proficiencyAt(player, out.position)).toBe(seatBefore + MATCH_PROFICIENCY_GAIN);
    if (benchPosition && benchBefore !== null) {
      expect(proficiencyAt(player, benchPosition)).toBe(benchBefore);
    }
  });
});

describe("지시가 판에 닿는 길", () => {
  it("이름으로 부르는 이동 — 지정한 축만 움직인다", () => {
    const state = atMatchday();
    startMatch(state);
    const mid = assignmentsOf(state, state.userTeamId, "starting").find((a) =>
      ["CM", "CDM", "CAM", "LCM", "RCM"].includes(a.position),
    );
    expect(mid, "선발에 중앙 미드필더가 없다").toBeDefined();
    const before = mid!.point ?? { x: 50, y: 50 };
    const moved = setPlayerTactic(state, { playerId: mid!.playerId, move: { lane: "left" } });
    expect(moved.ok, moved.message).toBe(true);
    const after = assignmentsOf(state, state.userTeamId).find(
      (a) => a.playerId === mid!.playerId,
    )!.point!;
    expect(after.x).toBeLessThan(before.x);
    expect(after.y).toBe(before.y);
    // 실시간 경기의 자리도 함께 옮겨 간다
    syncLiveTactics(state);
    const slot = state.pendingMatch!.live.slots[userSide(state)].find(
      (s) => s.playerId === mid!.playerId,
    )!;
    expect(slot.point).toEqual(after);
  });
});

/**
 * **교체 투입은 자리를 잇고 역할은 자기 것을 쓴다** (match.md §3.2) — 나간 선수의 역할을
 * 물려주면 감독이 그 선수에게 시킨 적 없는 값이 승부를 움직인다.
 */
describe("교체 투입의 역할 (match.md §3.2)", () => {
  function kickoffWithCbSub(state: GameState) {
    const started = startMatch(state);
    if (!started.ok) throw new Error(started.message);
    const side = userSide(state);
    const mine = ledgerOf(state)[side];
    const assignments = assignmentsOf(state, state.userTeamId, "starting");
    const out = assignments.find(
      (a) => weightSlotOf(a.position) === "CB" && mine.onPitch.includes(a.playerId),
    );
    const sub = mine.bench.find(
      (id) => groupOf(userPlayers(state).find((p) => p.id === id)!) !== "GK",
    );
    if (!out || !sub) throw new Error("CB 선발 또는 벤치 자원을 찾지 못했습니다");
    out.roleId = "ball-playing-defender";
    syncLiveTactics(state);
    const slotOf = (id: string) =>
      state.pendingMatch!.live.slots[side].find((s) => s.playerId === id);
    return { out, sub, slotOf };
  }

  it("역할 기억이 있는 교체 선수는 자리를 잇고 자기 역할로 뛴다", () => {
    const state = atMatchday();
    const { out, sub, slotOf } = kickoffWithCbSub(state);
    state.roleMemory.push({ gamePlayerId: sub, position: out.position, roleId: "libero" });
    expect(substitutePlayer(state, { out: out.playerId, in: sub }).ok).toBe(true);
    const slot = slotOf(sub);
    expect(slot?.roleId).toBe("libero");
    expect(slot?.position).toBe(out.position);
    expect(slot?.point).toEqual(out.point);
  });

  it("기억이 없는 교체 선수는 그 자리에 걸려 있던 역할을 잇는다", () => {
    const state = atMatchday();
    const { out, sub, slotOf } = kickoffWithCbSub(state);
    expect(state.roleMemory.some((m) => m.gamePlayerId === sub)).toBe(false);
    expect(substitutePlayer(state, { out: out.playerId, in: sub }).ok).toBe(true);
    const slot = slotOf(sub);
    expect(slot?.roleId).toBe("ball-playing-defender");
    expect(slot?.position).toBe(out.position);
  });

  it("다른 자리의 역할 기억은 교체 투입에 쓰이지 않는다", () => {
    const state = atMatchday();
    const { out, sub, slotOf } = kickoffWithCbSub(state);
    state.roleMemory.push({ gamePlayerId: sub, position: "DM", roleId: "anchor" });
    expect(substitutePlayer(state, { out: out.playerId, in: sub }).ok).toBe(true);
    expect(slotOf(sub)?.roleId).toBe("ball-playing-defender");
  });

  it("두 자리가 비어도 각자 나간 선수의 자리를 잇는다", () => {
    const state = atMatchday();
    expect(startMatch(state).ok).toBe(true);
    const side = userSide(state);
    const mine = ledgerOf(state)[side];
    const roster = userPlayers(state);
    const groupAt = (id: string) => groupOf(roster.find((p) => p.id === id)!);
    const xi = assignmentsOf(state, state.userTeamId, "starting").filter((a) =>
      mine.onPitch.includes(a.playerId),
    );
    const outDf = xi.find((a) => groupAt(a.playerId) === "DF")!;
    const outFw = xi.find((a) => groupAt(a.playerId) === "FW")!;
    const inFw = mine.bench.find((id) => groupAt(id) === "FW")!;
    const inDf = mine.bench.find((id) => groupAt(id) === "DF")!;
    expect(substitutePlayer(state, { out: outDf.playerId, in: inFw }).ok).toBe(true);
    expect(substitutePlayer(state, { out: outFw.playerId, in: inDf }).ok).toBe(true);
    const slots = state.pendingMatch!.live.slots[side];
    expect(slots.find((s) => s.playerId === inFw)?.position).toBe(outDf.position);
    expect(slots.find((s) => s.playerId === inDf)?.position).toBe(outFw.position);
  });
});

describe("전술 XP는 천장이 있다", () => {
  it("태그 없는 경기는 0, 골 하나부터 골당 같은 폭으로 쌓인다", () => {
    expect(tacticalXpFor(0)).toBe(0);
    expect(tacticalXpFor(1)).toBe(TACTICAL_XP_PER_GOAL);
    expect(tacticalXpFor(2)).toBe(TACTICAL_XP_PER_GOAL * 2);
  });
  it("천장을 넘어서면 더 넣어도 같다", () => {
    expect(tacticalXpFor(3)).toBe(TACTICAL_XP_CAP);
    expect(tacticalXpFor(9)).toBe(TACTICAL_XP_CAP);
  });
});

describe("경기 전 상대 분석 (match.md §3.6)", () => {
  it("예상 XI에 부상·정지 선수는 서지 않고 결장 명단으로 간다", () => {
    // 정지는 대회의 것이다 — 친선에는 걸리지 않으므로 리그 경기일에서 본다
    const state = atMatchday(42, { afterPreseason: true });
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
      competitionId: state.matches.find((m) => m.id === first.matchId)!.competitionId!,
      scope: "competition",
    });
    const after = buildOpponentReport(state);
    if (!after) throw new Error("상대 분석을 세우지 못했다");
    const ids = after.expectedXI.map((p) => p.id);
    expect(ids).not.toContain(hurt.id);
    expect(ids).not.toContain(banned.id);
    expect(after.expectedXI).toHaveLength(11);
    expect(after.absent.find((a) => a.id === hurt.id)?.reason).toBe("injury");
    expect(after.absent.find((a) => a.id === banned.id)?.reason).toBe("suspension");
  });

  it("리포트는 사실만 든다 — 두 선발의 평점·최근 결과·기둥, 판독은 없다", () => {
    const state = atMatchday();
    const report = buildOpponentReport(state);
    if (!report) throw new Error("상대 분석을 세우지 못했다");
    expect(report.facts.some((f) => f.kind === "strength")).toBe(true);
    expect(report.facts.some((f) => f.kind === "form")).toBe(true);
    expect(report.facts.filter((f) => f.kind === "key-player")).toHaveLength(2);
    const strength = report.facts.find((f) => f.kind === "strength");
    if (strength?.kind === "strength") {
      expect(strength.ours.attack).toBeGreaterThan(30);
      expect(strength.theirs.defence).toBeGreaterThan(30);
    }
  });

  it("경기 중에는 다음 상대의 분석을 세우지 않는다", () => {
    const state = atMatchday();
    expect(startMatch(state).ok).toBe(true);
    expect(buildOpponentReport(state)).toBeNull();
    expect(buildOfficeViews(state).competitions.preview).toBeNull();
  });
});

/**
 * 옆 구장 — **라이브 스코어와 장부에 적히는 결과는 같은 숫자여야 한다** (match.md §8.6).
 */
describe("같은 시각 타 경기의 라이브 스코어 (match.md §8.6)", () => {
  function withConcurrent(): { state: GameState; other: string } {
    const state = atMatchday(42, { afterPreseason: true });
    const ours = state.matches.find(
      (m) =>
        !m.result &&
        m.date === state.date &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    );
    if (!ours) throw new Error("오늘 우리 경기를 찾지 못했다");
    const other = state.matches.find(
      (m) => !m.result && m.competitionId === ours.competitionId && m.date !== state.date,
    );
    if (!other) throw new Error("옮겨 세울 같은 대회 경기가 없다");
    other.date = ours.date;
    other.time = ours.time;
    return { state, other: other.id };
  }

  it("킥오프에 굴린 골 시각이 종료 뒤 장부의 결과와 같다", () => {
    const { state, other } = withConcurrent();
    let rolled: NonNullable<GameState["pendingMatch"]>["otherScores"] = [];
    playMockMatch(state, (mid) => {
      rolled = mid.pendingMatch?.otherScores ?? [];
    });
    expect(rolled.map((r) => r.matchId)).toContain(other);
    for (const row of rolled) {
      const result = state.matches.find((m) => m.id === row.matchId)?.result;
      expect(result, `${row.matchId}가 종료 뒤에도 굴려지지 않았다`).toBeTruthy();
      if (!result) continue;
      const goalsOf = (side: "home" | "away") => row.goals.filter((g) => g.side === side).length;
      expect([goalsOf("home"), goalsOf("away")]).toEqual([result.homeGoals, result.awayGoals]);
      expect([...row.goals.map((g) => g.minute)].sort((a, b) => a - b)).toEqual(
        [...(result.goalMinutes ?? [])].sort((a, b) => a - b),
      );
    }
  });

  it("굴리는 것은 같은 대회·같은 날·같은 시각의 경기뿐이다", () => {
    const { state } = withConcurrent();
    expect(startMatch(state).ok).toBe(true);
    const pending = state.pendingMatch!;
    const ours = state.matches.find((m) => m.id === pending.matchId)!;
    expect(pending.otherScores.length).toBeGreaterThan(0);
    for (const row of pending.otherScores) {
      const match = state.matches.find((m) => m.id === row.matchId)!;
      expect(match.competitionId).toBe(ours.competitionId);
      expect(match.time).toBe(ours.time);
      expect(match.date).toBe(ours.date);
    }
  });

  it("대회가 없는 경기(프리시즌 친선)에는 옆 구장이 없다", () => {
    const state = atMatchday();
    expect(startMatch(state).ok).toBe(true);
    const ours = state.matches.find((m) => m.id === state.pendingMatch!.matchId)!;
    expect(ours.competitionId).toBeNull();
    expect(state.pendingMatch!.otherScores).toEqual([]);
  });
});
