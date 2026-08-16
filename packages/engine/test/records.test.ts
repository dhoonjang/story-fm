import { describe, expect, it } from "vitest";
import { YELLOWS_PER_SUSPENSION } from "@story-fm/domain";
import {
  activeContract,
  activeSuspension,
  assignmentsOf,
  buildOfficeViews,
  isSuspended,
  seasonYellowsOf,
  userPlayers,
  weeklyWagesOf,
} from "@story-fm/engine";
import { advanceToMatchday, createTestGame, playMockMatch, playPreseason } from "./helpers";

/**
 * v6 기록 테이블 — 계약(주급)·징계(경고/정지)·성장 로그가
 * "현재 상태 = 닫히지 않은 row" 패턴으로 동작하는지 검증한다.
 */

describe("계약 (주급의 원본)", () => {
  it("선수당 활성 계약은 정확히 1건이고 현 소속과 일치한다", () => {
    const state = createTestGame();
    for (const p of state.players) {
      const active = state.contracts.filter(
        (c) => c.gamePlayerId === p.id && c.status === "active",
      );
      expect(active).toHaveLength(1);
      expect(active[0]?.teamId).toBe(p.teamId);
    }
  });

  it("주급은 OVR에 비례한다 (스타가 더 비싸다)", () => {
    const state = createTestGame();
    const squad = [...userPlayers(state)].sort(
      (a, b) => b.attributes.overall - a.attributes.overall,
    );
    const best = activeContract(state, squad[0]!.id)!;
    const worst = activeContract(state, squad[squad.length - 1]!.id)!;
    expect(best.weeklyWage).toBeGreaterThan(worst.weeklyWage);
  });

  it("팀 주급 총액은 저장되지 않고 계약에서 파생된다", () => {
    const state = createTestGame();
    const before = weeklyWagesOf(state, state.userTeamId);
    // 계약 하나를 종료하면 총액이 즉시 줄어든다 (파생값이므로)
    const contract = state.contracts.find(
      (c) => c.status === "active" && c.teamId === state.userTeamId,
    )!;
    contract.status = "ended";
    expect(weeklyWagesOf(state, state.userTeamId)).toBe(before - contract.weeklyWage);
    // 뷰도 파생값을 쓴다
    expect(buildOfficeViews(state).finance.weeklyWages).toBe(
      weeklyWagesOf(state, state.userTeamId),
    );
  });
});

describe("징계 — BOOKING + SUSPENSION", () => {
  it("시즌 경고 수는 저장되지 않고 BOOKING에서 파생된다", () => {
    const state = createTestGame();
    const player = userPlayers(state)[4]!;
    expect(seasonYellowsOf(state, player.id, state.season)).toBe(0);
    for (let i = 0; i < 3; i++) {
      state.bookings.push({
        gamePlayerId: player.id,
        matchId: `m-fake-${i}`,
        season: state.season,
        card: "yellow",
        minute: 30,
      });
    }
    expect(seasonYellowsOf(state, player.id, state.season)).toBe(3);
    // 다른 시즌 경고는 세지 않는다
    state.bookings.push({
      gamePlayerId: player.id,
      matchId: "m-old",
      season: state.season - 1,
      card: "yellow",
      minute: 10,
    });
    expect(seasonYellowsOf(state, player.id, state.season)).toBe(3);
  });

  it("정지는 active row로 표현되고 소화하면 done 이력이 된다", () => {
    const state = createTestGame();
    const player = userPlayers(state)[6]!;
    state.suspensions.push({
      id: "sus-1",
      gamePlayerId: player.id,
      cause: "red",
      issuedOn: state.date,
      lengthMatches: 1,
      served: 0,
      status: "active",
    });
    expect(isSuspended(state, player.id)).toBe(true);
    const sus = activeSuspension(state, player.id)!;
    sus.served = 1;
    sus.status = "done";
    expect(isSuspended(state, player.id)).toBe(false);
    // 이력은 남는다
    expect(state.suspensions.find((s) => s.id === "sus-1")?.status).toBe("done");
  });

  it("경고 5회 임계값이 상수로 정의된다", () => {
    expect(YELLOWS_PER_SUSPENSION).toBe(5);
  });

  it("정지 선수는 라인업 배치에서 자동 대체된다", () => {
    const state = createTestGame();
    // 정지는 대회 경기로만 소화된다 — 친선을 지나 리그 개막에서 잰다
    playPreseason(state);
    advanceToMatchday(state);
    const starter = assignmentsOf(state, state.userTeamId, "starting")[5]!;
    state.suspensions.push({
      id: "sus-2",
      gamePlayerId: starter.playerId,
      cause: "yellows",
      issuedOn: state.date,
      lengthMatches: 1,
      served: 0,
      status: "active",
    });
    playMockMatch(state);
    // 정지 선수는 출전하지 않았으므로 apps가 늘지 않는다
    const stat = state.seasonStats.find(
      (s) => s.gamePlayerId === starter.playerId && s.season === state.season,
    );
    expect(stat?.apps ?? 0).toBe(0);
    // 정지는 이 경기로 소화된다
    expect(state.suspensions.find((s) => s.id === "sus-2")?.served).toBe(1);
  });
});

describe("경기 성장·기록", () => {
  it("경기를 치르면 출전 기록·포지션 적응도가 로그와 함께 오른다", () => {
    const state = createTestGame(7);
    // 시즌 기록을 보는 시험이라 리그 개막까지 간다 — 친선은 장부에 남지 않는다
    playPreseason(state);
    advanceToMatchday(state);
    const before = new Map(
      assignmentsOf(state, state.userTeamId, "starting").map((a) => [a.playerId, a.familiarity]),
    );
    playMockMatch(state);

    // 시즌 스탯 (팀 키 포함)
    const apps = state.seasonStats.filter(
      (s) => s.teamId === state.userTeamId && s.season === state.season && s.apps > 0,
    );
    expect(apps.length).toBeGreaterThanOrEqual(11);

    // 전술 적응도는 **경기 처리에서 오르지 않는다** — 사건 목록을 읽은 평점 판정이
    // 함께 정한다(`applyMatchFamiliarity`). 코어만 돌린 이 테스트에선 그대로여야 한다
    for (const a of assignmentsOf(state, state.userTeamId, "starting")) {
      if (before.has(a.playerId)) {
        expect(a.familiarity, `${a.playerId}: 코어가 몰래 올렸다`).toBe(before.get(a.playerId)!);
      }
    }
    // 포지션 적응도 로그 (pos:CODE)
    expect(state.growthLog.some((g) => g.target.startsWith("pos:"))).toBe(true);
    // 모든 성장 로그는 출처 일정을 갖는다
    for (const g of state.growthLog) expect(g.date).toBeTruthy();
  });

  it("경기 결과가 MATCH에 기록되고 일정 엔트리가 닫힌다", () => {
    const state = createTestGame(9);
    advanceToMatchday(state);
    const match = state.matches.find(
      (m) => !m.result && (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    )!;
    playMockMatch(state);
    expect(match.result).not.toBeNull();
    const entry = state.schedule.find((e) => e.type === "match" && e.refId === match.id);
    expect(entry?.status).toBe("done");
  });
});
