import { describe, expect, it } from "vitest";
import {
  MATCHDAY_SQUAD,
  NON_HOMEGROWN_MAX,
  SQUAD_LIST_LIMIT,
  isUnder21,
  positionGroupOfPlayer,
} from "@story-fm/domain";
import {
  advanceTime,
  playersOf,
  squadLevelOf,
  firstTeamPlayers,
  isTopFlight,
  playerCatalog,
  squadRegistrationOf,
  reservePlayers,
  developsByCore,
  setLineup,
  setSquadLevel,
  userPlayers,
  userTactics,
} from "../src";
import { createTestGame, playMockMatch } from "./helpers";

describe("1·2군 스쿼드", () => {
  it("새 게임의 1군은 **등록 규칙을 지킨 채** 짜인다 (25 + U21)", () => {
    const state = createTestGame();
    const first = userPlayers(state).filter((p) => p.squadLevel === "first");
    const reg = squadRegistrationOf(state, state.userTeamId);

    // 부임하자마자 위반 상태로 시작하지 않는다
    expect(reg.issues).toEqual([]);
    expect(reg.listed).toBeLessThanOrEqual(SQUAD_LIST_LIMIT);
    // 규칙은 "홈그로운 8명 이상"이 아니라 **"비홈그로운 17명 이하"** 다 —
    // 홈그로운이 7명뿐인 구단은 25가 아니라 24명만 올릴 수 있고, 그건 적법하다
    expect(reg.listed - reg.homegrown).toBeLessThanOrEqual(NON_HOMEGROWN_MAX);
    // 매치데이(선발 11 + 벤치 9)를 채울 수 있어야 한다
    expect(first.length).toBeGreaterThanOrEqual(MATCHDAY_SQUAD);
    // U21은 명단 밖이라 1군 인원은 25를 넘을 수 있다
    expect(first.length).toBe(reg.listed + reg.under21);
    expect(reservePlayers(state, state.userTeamId).length).toBeGreaterThanOrEqual(18);
  });

  it("모든 1부 구단이 적법한 등록 명단으로 시작한다 — 골키퍼 없는 명단은 없다", () => {
    const state = createTestGame();
    for (const team of state.teams) {
      if (!isTopFlight(team.id)) continue;
      const reg = squadRegistrationOf(state, team.id);
      expect(reg.issues, `${team.id}: ${reg.issues.join(" / ")}`).toEqual([]);
      const keepers = firstTeamPlayers(state, team.id).filter(
        (p) => positionGroupOfPlayer(p) === "GK",
      );
      expect(keepers.length, `${team.id} 1군 골키퍼`).toBeGreaterThanOrEqual(2);
    }
  });

  it("2군 선수는 승격 전 라인업에 들어갈 수 없고, 강등하면 배치에서 빠진다", () => {
    const state = createTestGame();
    // 등록 규칙(25인·홈그로운)에 막히지 않는 2군을 고른다 — 이 테스트가 보려는 건
    // 승격 여부가 아니라 "2군은 라인업에 못 들어간다"는 규칙이다
    const reserve = reservePlayers(state, state.userTeamId).find(
      (p) =>
        setSquadLevel(state, { playerId: p.id, level: "first" }).ok &&
        setSquadLevel(state, { playerId: p.id, level: "reserve" }).ok,
    )!;
    expect(reserve, "승격 가능한 2군이 없다").toBeDefined();
    const starters = userTactics(state)
      .assignments.filter((a) => a.role === "starting")
      .map((a) => ({ playerId: a.playerId, position: a.position }));
    starters[1] = { playerId: reserve.id, position: starters[1]!.position };

    expect(setLineup(state, { starting: starters }).ok).toBe(false);
    expect(setSquadLevel(state, { playerId: reserve.id, level: "first" }).ok).toBe(true);
    expect(setLineup(state, { starting: starters }).ok).toBe(true);
    expect(setSquadLevel(state, { playerId: reserve.id, level: "reserve" }).ok).toBe(true);
    expect(userTactics(state).assignments.some((a) => a.playerId === reserve.id)).toBe(false);
  });

  it("2군은 결산 판정 대신 코어의 월간 성장을 받는다", () => {
    const state = createTestGame();
    // 감독 팀 1군만 훈련·경기 결산이 판정한다. 2군은 타 팀 선수와 같은 코어 로직이다
    const first = userPlayers(state).find((p) => squadLevelOf(p) === "first")!;
    // 등록 규칙(25인·홈그로운)에 막히지 않는 2군을 고른다 — 이 테스트가 보려는 건
    // 승격 여부가 아니라 "2군은 라인업에 못 들어간다"는 규칙이다
    const reserve = reservePlayers(state, state.userTeamId).find(
      (p) =>
        setSquadLevel(state, { playerId: p.id, level: "first" }).ok &&
        setSquadLevel(state, { playerId: p.id, level: "reserve" }).ok,
    )!;
    expect(reserve, "승격 가능한 2군이 없다").toBeDefined();
    expect(developsByCore(state, first), "1군이 코어 성장 대상이 됐다").toBe(false);
    expect(developsByCore(state, reserve), "2군이 코어 성장에서 빠졌다").toBe(true);

    // 몇 달을 넘기면 2군에는 월간 성장 로그가 쌓인다
    for (let i = 0; i < 14; i++) {
      // 프리시즌에도 경기가 있다(친선) — 경기일에 멎으면 달이 넘어가지 않는다
      if (state.phase === "matchday") playMockMatch(state);
      else advanceTime(state, { days: 7 });
      state.issues = [];
    }
    const ours = new Set(reservePlayers(state, state.userTeamId).map((p) => p.id));
    expect(
      state.growthLog.some((g) => g.source === "development" && ours.has(g.gamePlayerId)),
      "몇 달이 지났는데 2군에 아무 변화도 없다",
    ).toBe(true);
    // 1군은 코어가 건드리지 않는다 (판정만이 움직인다)
    const firstIds = new Set(
      userPlayers(state)
        .filter((p) => squadLevelOf(p) === "first")
        .map((p) => p.id),
    );
    expect(
      state.growthLog.some((g) => g.source === "development" && firstIds.has(g.gamePlayerId)),
      "1군이 코어 월간 성장을 받았다",
    ).toBe(false);
  });
});

describe("승격·강등은 등록 규칙을 따른다", () => {
  it("21세 초과는 명단이 차면 못 올라온다 — U21은 올라온다", () => {
    const state = createTestGame();
    const reserves = reservePlayers(state, state.userTeamId);
    const seasonStart = 2026;

    const senior = reserves.find((p) => !isUnder21(p.birthdate, seasonStart));
    const young = reserves.find((p) => isUnder21(p.birthdate, seasonStart));
    expect(young, "2군에 U21이 없다").toBeDefined();

    // 명단을 25까지 채운다 (홈그로운 여유가 있는 만큼)
    for (const p of reserves) {
      if (isUnder21(p.birthdate, seasonStart)) continue;
      setSquadLevel(state, { playerId: p.id, level: "first" });
    }
    const after = squadRegistrationOf(state, state.userTeamId);
    expect(after.listed).toBeLessThanOrEqual(SQUAD_LIST_LIMIT);
    expect(after.listed - after.homegrown).toBeLessThanOrEqual(NON_HOMEGROWN_MAX);
    expect(after.issues).toEqual([]);

    // 명단이 닫힌 뒤에도 U21은 언제든 올라온다
    const stillReserve = reservePlayers(state, state.userTeamId).find((p) =>
      isUnder21(p.birthdate, seasonStart),
    );
    if (stillReserve) {
      expect(setSquadLevel(state, { playerId: stillReserve.id, level: "first" }).ok).toBe(true);
    }
    if (senior) {
      const blocked = reservePlayers(state, state.userTeamId).find(
        (p) => !isUnder21(p.birthdate, seasonStart),
      );
      // 남아 있는 21세 초과가 있다면 그건 규칙에 막힌 것이다
      if (blocked) {
        const res = setSquadLevel(state, { playerId: blocked.id, level: "first" });
        expect(res.ok).toBe(false);
        expect(res.message).toMatch(/등록 명단이 찼습니다|홈그로운이 모자랍니다/);
      }
    }
  });

  it("매치데이 20명 밑으로는 내릴 수 없다", () => {
    const state = createTestGame();
    let guard = 60;
    while (guard-- > 0) {
      const first = userPlayers(state).filter((p) => p.squadLevel === "first");
      if (first.length <= MATCHDAY_SQUAD) break;
      const victim = first[first.length - 1]!;
      if (!setSquadLevel(state, { playerId: victim.id, level: "reserve" }).ok) break;
    }
    const first = userPlayers(state).filter((p) => p.squadLevel === "first");
    expect(first.length).toBeGreaterThanOrEqual(MATCHDAY_SQUAD);
    const res = setSquadLevel(state, { playerId: first[0]!.id, level: "reserve" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("선발 11 + 벤치 9");
  });
});

describe("2군 — 합성 유스는 채움용이다", () => {
  it("어느 구단에서도 합성이 실명 유망주 위에 서지 않는다", () => {
    /**
     * `generateYouthPlayer`가 `TIER_BASE - 24`에서 출발하는 이유다 — 예전 기준선에선
     * 열여섯 살 합성 선수가 1군 최저보다 높게 나와 2군 상위를 이름 없는 선수들이
     * 독점했다.
     *
     * ⚠️ **재는 상대는 "2군에 있는 카탈로그 선수"가 아니라 그 구단의 실명 U21**이다.
     * 2군 배정은 별개 로직이고(`fillSlots`), 카탈로그의 아카데미 자리도 합성 가명이라
     * (people.md §2) 섞어 재면 이 테스트가 카탈로그 보충 기준선(`topUpBase`)을 따라
     * 흔들린다 — 그쪽은 attributes.test.ts가 따로 잰다.
     */
    const state = createTestGame();
    const seasonStartYear = Number(state.date.slice(0, 4));
    const realIds = new Set(
      playerCatalog()
        .filter((e) => !e.synthetic)
        .map((e) => e.id),
    );
    for (const teamId of ["manutd", "arsenal", "liverpool", "chelsea", "tottenham"]) {
      const squad = playersOf(state, teamId);
      const prospects = squad.filter(
        (p) =>
          p.catalogId !== null &&
          realIds.has(p.catalogId) &&
          isUnder21(p.birthdate, seasonStartYear),
      );
      const synthetic = squad.filter((p) => p.catalogId === null);
      if (prospects.length === 0 || synthetic.length === 0) continue;
      const bestProspect = Math.max(...prospects.map((p) => p.attributes.overall));
      const bestSynthetic = Math.max(...synthetic.map((p) => p.attributes.overall));
      expect(bestSynthetic, `${teamId}`).toBeLessThan(bestProspect);
    }
  });

  it("대신 잠재력은 넉넉하다 — 유스의 매력은 여지다", () => {
    const state = createTestGame();
    const synthetic = playersOf(state, "manutd").filter(
      (p) => squadLevelOf(p) === "reserve" && p.catalogId === null,
    );
    expect(synthetic.length).toBeGreaterThan(0);
    for (const p of synthetic) {
      expect(p.attributes.potential - p.attributes.overall, p.name).toBeGreaterThanOrEqual(8);
    }
  });
});
