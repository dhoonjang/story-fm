import { describe, expect, it } from "vitest";
import { YELLOWS_PER_SUSPENSION, positionGroupOfPlayer } from "@story-fm/domain";
import {
  advanceTime,
  allMatchesDone,
  createGame,
  interpretBackgroundHeuristic,
  isSuspended,
  playersOf,
  quickMinuteOf,
  quickSimulate,
  quickStrengthFactor,
  seasonYellowsOf,
  simSquadOf,
  type GameState,
  type WorldScope,
} from "@story-fm/engine";
import { createTestGame, keepSeat, playMockMatch } from "./helpers";

/**
 * 간이 시뮬의 장부 — **리그가 우리 팀에만 있는 규칙으로 돌지 않는다.**
 *
 * 예전엔 타 팀 경기가 스코어와 득점자만 남겼다. 그래서 누적 경고 정지가 우리
 * 팀에만 걸리고, 남의 팀은 지친 선발이 90분을 뛰며, 3-1이 언제 만들어졌는지
 * 아무도 몰랐다. 이제 카드·퇴장·교체·골의 분이 여기서도 나온다.
 */

/**
 * 리그 하나만 도는 세계 — 20팀 38라운드, 컵·대항전·시장 리그 없음.
 *
 * 여기 검증은 **한 시즌치 카드가 쌓여야** 성립한다: 경고 다섯 장마다 정지 하나,
 * 시즌에 퇴장 몇십 건, 스쿼드 열대여섯 명 출전. 여덟 팀짜리 축소 세계는 14라운드에
 * 그쳐 그 눈금에 닿지 못하고, 전체 세계는 같은 38라운드를 위해 리그 다섯 개와 2부
 * 예순네 클럽까지 함께 굴린다. 라운드 수는 그대로 두고 굴리는 것만 5분의 1로 줄인다.
 */
const ONE_LEAGUE: WorldScope = {
  leagues: ["epl"],
  teamsPerLeague: 20,
  cups: false,
  markets: false,
};

/**
 * 한 시즌을 끝까지 돌린 세이브 — 시드마다 **한 번만** 굴리고 나눠 쓴다.
 * 여기 테스트들은 장부를 읽기만 하고, 시즌 한 바퀴는 이 파일에서 가장 비싼 일이다.
 */
const seasons = new Map<number, GameState>();

function seasonOf(seed: number): GameState {
  const cached = seasons.get(seed);
  if (cached) return cached;
  const background = "K리그에서 뛰다 은퇴한 수비수 출신 분석가";
  const state = createGame({
    seed,
    userTeamId: "arsenal",
    managerName: "김감독",
    background,
    attributes: interpretBackgroundHeuristic(background, "arsenal"),
    world: ONE_LEAGUE,
  });
  let guard = 420;
  while (guard-- > 0 && !allMatchesDone(state)) {
    const before = state.date;
    // 장부가 한 시즌치 쌓이는 것을 재는 동안 자리는 지킨다 — 경질은 시계를 멈춘다
    keepSeat(state);
    const advanced = advanceTime(state, { days: 1 });
    if (state.phase === "matchday") playMockMatch(state);
    if (state.date === before && advanced.stopped !== "matchday") break;
  }
  seasons.set(seed, state);
  return state;
}

describe("골의 분", () => {
  it("정규화 로그 분포라 전반 46% · 후반 54%에 가깝다", () => {
    const samples = Array.from({ length: 10_000 }, (_, i) => quickMinuteOf((i + 0.5) / 10_000));
    const firstHalf = samples.filter((minute) => minute <= 45).length / samples.length;
    expect(firstHalf).toBeCloseTo(0.46, 2);
  });

  it("득점자와 같은 길이로, 시간 순으로 남는다", () => {
    const state = createTestGame(3);
    // 스쿼드는 한 번만 세운다 — 루프 안에서 다시 세우면 그게 이 케이스의 값이 된다
    const squads = { home: simSquadOf(state, "mancity"), away: simSquadOf(state, "hull") };
    for (let i = 0; i < 60; i++) {
      const r = quickSimulate(squads.home, squads.away, 900 + i, `min:${i}`);
      expect(r.goalMinutes).toHaveLength(r.scorers.length);
      expect(r.assists).toHaveLength(r.scorers.length);
      expect(r.homeShots).toBeGreaterThanOrEqual(r.homeGoals);
      expect(r.awayShots).toBeGreaterThanOrEqual(r.awayGoals);
      for (const m of r.goalMinutes) {
        expect(m).toBeGreaterThanOrEqual(1);
        expect(m).toBeLessThanOrEqual(94);
      }
      const activeIds = (side: "home" | "away", minute: number) => {
        // 분 단위 기록에는 같은 분 안의 선후가 없다. 같은 분 교체는 나간 선수와
        // 들어온 선수 둘 다 득점 장면 후보일 수 있고, 퇴장도 그 장면 뒤일 수 있다.
        const sideSubs = r.subs.filter((sub) => sub.side === side);
        const off = new Set(sideSubs.filter((sub) => sub.minute < minute).map((sub) => sub.out));
        const on = new Set(sideSubs.filter((sub) => sub.minute <= minute).map((sub) => sub.in));
        const red = new Set(
          r.cards
            .filter((card) => card.side === side && card.card === "red" && card.minute < minute)
            .map((card) => card.playerId),
        );
        return new Set(
          [
            ...squads[side].starters
              .filter((player) => !off.has(player.id))
              .map((player) => player.id),
            ...(squads[side].bench ?? [])
              .filter((player) => on.has(player.id))
              .map((player) => player.id),
          ].filter((id) => !red.has(id)),
        );
      };
      for (let goal = 0; goal < r.scorers.length; goal++) {
        const [side, scorerId] = r.scorers[goal]!.split(":") as ["home" | "away", string];
        const active = activeIds(side, r.goalMinutes[goal]!);
        expect(active.has(scorerId)).toBe(true);
        const assistId = r.assists[goal]?.split(":")[1];
        if (assistId) expect(active.has(assistId)).toBe(true);
      }
      // 장부는 시간 순이다 — 화면이 "23′ 손흥민"을 순서대로 읽는다
      const sorted = [...r.goalMinutes].sort((a, b) => a - b);
      expect(r.goalMinutes).toEqual(sorted);
    }
  });

  it("시즌을 돌리면 모든 경기의 골에 분이 붙는다", () => {
    const state = seasonOf(7);
    const scoring = state.matches.filter(
      (m) => m.season === state.season && m.result && m.result.scorers.length > 0,
    );
    expect(scoring.length).toBeGreaterThan(100);
    for (const m of scoring) {
      expect(m.result!.goalMinutes, m.id).toHaveLength(m.result!.scorers.length);
    }
  });
});

describe("간이 시뮬 전력 로그", () => {
  it("대등하면 1이고 반대 전력비끼리 역수다", () => {
    expect(quickStrengthFactor(75, 75)).toBe(1);
    expect(quickStrengthFactor(90, 75) * quickStrengthFactor(75, 90)).toBeCloseTo(1, 10);
  });
});

describe("카드·퇴장", () => {
  it("두 번째 경고는 경고 한 장 + 퇴장으로 남는다 (실제 기록과 같다)", () => {
    const state = createTestGame(3);
    const home = simSquadOf(state, "mancity");
    const away = simSquadOf(state, "hull");
    let secondYellows = 0;
    for (let i = 0; i < 400; i++) {
      const r = quickSimulate(home, away, 4000 + i, `card:${i}`);
      for (const red of r.cards.filter((c) => c.card === "red")) {
        const yellows = r.cards.filter(
          (c) => c.playerId === red.playerId && c.card === "yellow",
        ).length;
        // 다이렉트면 경고 0장, 두 번째 경고면 정확히 2장(첫 장 + 그 장)
        expect([0, 2]).toContain(yellows);
        if (yellows === 2) secondYellows++;
      }
      // 퇴장한 선수는 그 뒤로 카드를 더 받지 않는다
      for (const red of r.cards.filter((c) => c.card === "red")) {
        const after = r.cards.filter((c) => c.playerId === red.playerId && c.minute > red.minute);
        expect(after).toHaveLength(0);
      }
    }
    expect(secondYellows).toBeGreaterThan(0);
  });

  it("타 팀 선수도 경고를 쌓고 정지를 받는다 — 우리만의 규칙이 아니다", () => {
    const state = seasonOf(7);
    const others = state.players.filter(
      (p) => p.teamId !== state.userTeamId && p.teamId !== "free",
    );
    const booked = state.bookings.filter((b) => others.some((p) => p.id === b.gamePlayerId));
    expect(booked.length).toBeGreaterThan(500);
    // 누적 정지도 남의 팀에 걸린다
    const theirSuspensions = state.suspensions.filter((s) =>
      others.some((p) => p.id === s.gamePlayerId),
    );
    expect(theirSuspensions.length).toBeGreaterThan(0);
    expect(theirSuspensions.some((s) => s.cause === "yellows")).toBe(true);
    expect(theirSuspensions.some((s) => s.cause === "red")).toBe(true);
  });

  it("경고 다섯 장마다 정지가 하나 — 눈금이 유저 경기와 같다", () => {
    const state = seasonOf(7);
    const bannedFor = new Map<string, number>();
    for (const s of state.suspensions.filter((x) => x.cause === "yellows")) {
      bannedFor.set(s.gamePlayerId, (bannedFor.get(s.gamePlayerId) ?? 0) + 1);
    }
    expect(bannedFor.size).toBeGreaterThan(0);
    // 시즌 경고 12장이면 정지 두 번(5·10장에서) — 넘긴 눈금 수와 정확히 같다
    for (const [playerId, bans] of bannedFor) {
      const yellows = seasonYellowsOf(state, playerId, state.season);
      expect(bans, playerId).toBe(Math.floor(yellows / YELLOWS_PER_SUSPENSION));
    }
  });

  it("정지된 선수는 라인업에서 빠진다 — AI 팀도", () => {
    const state = seasonOf(7);
    const banned = state.suspensions.find(
      (s) =>
        s.status === "active" &&
        state.players.some((p) => p.id === s.gamePlayerId && p.teamId !== state.userTeamId),
    );
    expect(banned).toBeTruthy();
    const player = state.players.find((p) => p.id === banned!.gamePlayerId)!;
    expect(isSuspended(state, player.id)).toBe(true);
    expect(simSquadOf(state, player.teamId).starters.map((p) => p.id)).not.toContain(player.id);
  });

  it("시즌마다 퇴장이 실제로 나온다 — 장부의 red가 경기와 이어진다", () => {
    const state = seasonOf(7);
    const played = new Set(
      state.matches.filter((m) => m.season === state.season && m.result).map((m) => m.id),
    );
    const reds = state.bookings.filter((b) => b.card === "red" && played.has(b.matchId));
    expect(reds.length).toBeGreaterThan(50);
  });

  /**
   * **퇴장은 승부에 닿는다** — 그런데 시즌 실점 평균으로는 그것이 보이지 않는다.
   *
   * 퇴장은 평균 50분쯤 나오고 남은 40분의 실점 증가는 0.1골 안팎인데, 경기당
   * 실점의 표준편차는 1골이 넘는다. 시즌 하나의 퇴장 예순 경기로 두 집단(퇴장이
   * 있던 경기 ↔ 없던 경기)의 평균을 비교하면 부호가 우연히 뒤집힌다 — 같은 코드로
   * 1.36 vs 1.36, 1.41 vs 1.43, 1.27 vs 1.30이 나왔다. 다른 팀·다른 상대·다른
   * 시간대가 섞인 비교라 표본을 늘려도 편향은 남는다.
   *
   * 그래서 **같은 판을 열한 명과 열 명으로 각각 돌린다.** 팀도 상대도 시드도 같고
   * 다른 것은 그라운드의 사람 수뿐이다.
   */
  it("퇴장이 스코어에 닿는다 — 한 명이 빠진 팀은 더 많이 내주고 덜 넣는다", () => {
    const state = createTestGame(3);
    /**
     * 판 수 — **방향이 결정적으로 잡히는 선**이다. 400판일 때 60초를 썼고, 150판으로
     * 줄여도 세 짝 모두 같은 방향이고 크기 문턱(±10%)도 그대로 넘는다. 시드가 같으니
     * 이 수는 흔들리는 표본이 아니라 고정된 판이다 — 늘려도 답이 달라지지 않는다.
     */
    const MATCHES = 150;
    const pairs: Array<[string, string]> = [
      ["mancity", "hull"],
      ["arsenal", "everton"],
      ["fulham", "wolves"],
    ];
    const totals = { eleven: { conceded: 0, scored: 0 }, ten: { conceded: 0, scored: 0 } };
    for (const [homeId, awayId] of pairs) {
      const away = simSquadOf(state, awayId);
      const eleven = simSquadOf(state, homeId);
      // 필드 플레이어 하나가 빠진 판 — 벤치는 그대로다(교체는 수를 메우지 않는다)
      const gone = eleven.starters.find((p) => positionGroupOfPlayer(p) === "MF")!;
      const ten = { ...eleven, starters: eleven.starters.filter((p) => p.id !== gone.id) };
      const run = (squad: typeof eleven) => {
        const sum = { conceded: 0, scored: 0 };
        for (let i = 0; i < MATCHES; i++) {
          const r = quickSimulate(squad, away, 10_000 + i, `red:${homeId}:${i}`);
          sum.conceded += r.awayGoals;
          sum.scored += r.homeGoals;
        }
        return sum;
      };
      const withEleven = run(eleven);
      const withTen = run(ten);
      // 판마다 방향이 같아야 한다 — 어떤 상대에게만 성립하는 규칙이 아니다
      expect(withTen.conceded, `${homeId} 실점`).toBeGreaterThan(withEleven.conceded);
      expect(withTen.scored, `${homeId} 득점`).toBeLessThan(withEleven.scored);
      totals.eleven.conceded += withEleven.conceded;
      totals.eleven.scored += withEleven.scored;
      totals.ten.conceded += withTen.conceded;
      totals.ten.scored += withTen.scored;
    }
    // 크기도 잰다 — 소수점 뒤에서만 움직이면 퇴장은 장부에만 남은 것이다
    expect(totals.ten.conceded).toBeGreaterThan(totals.eleven.conceded * 1.1);
    expect(totals.ten.scored).toBeLessThan(totals.eleven.scored * 0.9);
  });
});

/**
 * 킥오프 순서 — **12:30에 뛰는 감독은 17:30 경기 결과를 모른다.**
 *
 * 예전엔 tick이 하루치를 통째로 굴려서, 우리 킥오프 전에 그날 라운드가 이미
 * 끝나 있었다. 순위표를 열면 "이기면 몇 위"가 확정돼 있는 셈이다.
 */
describe("같은 날 경기는 킥오프 순서대로 굴러간다", () => {
  function matchdayWithLaterGames(seed: number): GameState | null {
    const state = createTestGame(seed);
    for (let guard = 0; guard < 60; guard++) {
      advanceTime(state, "next_match");
      if (state.phase !== "matchday") continue;
      const ours = state.matches.find(
        (m) =>
          m.date === state.date &&
          !m.result &&
          (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
      );
      const later = state.matches.filter(
        (m) => m.date === state.date && m !== ours && (m.time ?? "") >= (ours?.time ?? ""),
      );
      if (ours && later.length > 0) return state;
      playMockMatch(state);
    }
    return null;
  }

  it("우리보다 늦게 시작하는 경기는 킥오프 전에 결과가 없다", () => {
    const state = matchdayWithLaterGames(7);
    expect(state, "우리 경기 뒤에 다른 경기가 있는 날").toBeTruthy();
    const ours = state!.matches.find(
      (m) =>
        m.date === state!.date &&
        !m.result &&
        (m.homeTeamId === state!.userTeamId || m.awayTeamId === state!.userTeamId),
    )!;
    const today = state!.matches.filter((m) => m.date === state!.date && m.id !== ours.id);
    const earlier = today.filter((m) => (m.time ?? "15:00") < (ours.time ?? "15:00"));
    const later = today.filter((m) => (m.time ?? "15:00") >= (ours.time ?? "15:00"));
    expect(later.length).toBeGreaterThan(0);
    for (const m of earlier) expect(m.result, `${m.id} 먼저 끝났어야 한다`).not.toBeNull();
    for (const m of later) expect(m.result, `${m.id} 아직 안 끝났어야 한다`).toBeNull();

    // 우리 경기가 끝나면 나머지가 이어서 굴러간다
    playMockMatch(state!);
    for (const m of later) expect(m.result, `${m.id} 우리 경기 뒤에도 안 굴렀다`).not.toBeNull();
  }, 60_000);
});

describe("교체", () => {
  it("양 팀이 모두 교체한다 — 한도는 팀마다 따로다", () => {
    const state = createTestGame(3);
    const home = simSquadOf(state, "mancity");
    const away = simSquadOf(state, "hull");
    let homeSubs = 0;
    let awaySubs = 0;
    for (let i = 0; i < 60; i++) {
      const r = quickSimulate(home, away, 6000 + i, `sub:${i}`);
      homeSubs += r.subs.filter((s) => s.side === "home").length;
      awaySubs += r.subs.filter((s) => s.side === "away").length;
      expect(r.subs.filter((s) => s.side === "home").length).toBeLessThanOrEqual(4);
      expect(r.subs.filter((s) => s.side === "away").length).toBeLessThanOrEqual(4);
      // 같은 선수가 나갔다 들어오지 않는다
      const out = r.subs.map((s) => s.out);
      expect(new Set(out).size).toBe(out.length);
      for (const s of r.subs) expect(out).not.toContain(s.in);
    }
    expect(homeSubs).toBeGreaterThan(60);
    expect(awaySubs).toBeGreaterThan(60);
  });

  it("교체로 들어온 선수도 출전 기록이 남는다", () => {
    const state = seasonOf(7);
    const match = state.matches.find(
      (m) =>
        m.season === state.season &&
        m.result &&
        m.homeTeamId !== state.userTeamId &&
        m.awayTeamId !== state.userTeamId &&
        (m.result.homeLineup ?? []).length > 11,
    );
    expect(match, "교체가 있는 타 팀 경기").toBeTruthy();
    // 라인업이 11명을 넘는다 = 교체 투입 선수가 함께 적혔다
    expect(match!.result!.homeLineup!.length).toBeGreaterThan(11);
    // 그 선수들의 시즌 출전도 0이 아니다
    const subbed = match!.result!.homeLineup!.slice(11);
    for (const id of subbed) {
      const stat = state.seasonStats.find((s) => s.gamePlayerId === id);
      expect(stat?.apps ?? 0, id).toBeGreaterThan(0);
    }
  });

  it("한 시즌을 돌리면 벤치 자원도 출전이 쌓인다 — 열한 명이 다 뛰지 않는다", () => {
    const state = seasonOf(7);
    const squad = playersOf(state, "mancity");
    const withApps = squad.filter(
      (p) => (state.seasonStats.find((s) => s.gamePlayerId === p.id)?.apps ?? 0) > 0,
    );
    // 선발 11명만 뛰던 시절엔 이 수가 11~13에서 멈췄다
    expect(withApps.length).toBeGreaterThan(15);
  });
});
