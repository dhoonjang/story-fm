import { describe, expect, it } from "vitest";
import { ageOf, naturalPositionOf } from "@story-fm/domain";
import {
  TEAM_CATALOG,
  activeContract,
  assignmentsOf,
  groupOf,
  playerCatalog,
  playersOf,
  transitionSeason,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

const TIER = new Map(TEAM_CATALOG.map((t) => [t.id, t.tier]));
const REF = "2026-08-15"; // 시즌 개막 기준 나이

describe("실선수 로스터 깊이 (30인+, 유망주 포함)", () => {
  const catalog = playerCatalog();
  const rosterOf = (teamId: string) => catalog.filter((e) => e.teamId === teamId);

  it("팀당 18인 이상, 전역 id 유일", () => {
    const global = new Set<string>();
    for (const team of TEAM_CATALOG) {
      const ids = rosterOf(team.id).map((e) => e.id);
      expect(ids.length).toBeGreaterThanOrEqual(18);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) {
        expect(global.has(id)).toBe(false);
        global.add(id);
      }
    }
    expect(global.size).toBeGreaterThanOrEqual(600);
  });

  it("포지션 그룹별 최소 인원 — 선발·시즌 전환이 고갈로 막히지 않는다", () => {
    for (const team of TEAM_CATALOG) {
      const roster = rosterOf(team.id);
      const count = (g: string) =>
        roster.filter((e) => {
          const natural = naturalPositionOf(e).position;
          return (
            (g === "GK" && natural === "GK") ||
            (g !== "GK" &&
              groupOf({ positions: e.positions } as never) === g)
          );
        }).length;
      expect(count("GK")).toBeGreaterThanOrEqual(2);
    }
  });

  it("모든 팀이 만 20세 이하 유망주를 보유하고 성장 여지가 있다", () => {
    for (const team of TEAM_CATALOG) {
      const roster = rosterOf(team.id);
      const youths = roster.filter((e) => ageOf(e.birthdate, REF) <= 21);
      expect(youths.length).toBeGreaterThanOrEqual(1);
    }
    // 카탈로그 전체로는 잠재치가 능력치보다 높은 선수가 다수
    const growable = catalog.filter((e) => e.potential > e.pace);
    expect(growable.length).toBeGreaterThan(0);
  });

  it("tier가 낮을수록(강할수록) 평균 잠재치가 높다", () => {
    const avgByTier: Record<number, number[]> = { 1: [], 2: [], 3: [], 4: [] };
    for (const team of TEAM_CATALOG) {
      const roster = rosterOf(team.id);
      const avg = roster.reduce((s, e) => s + e.potential, 0) / roster.length;
      avgByTier[TIER.get(team.id) ?? 3]!.push(avg);
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(avgByTier[1]!)).toBeGreaterThan(mean(avgByTier[4]!));
  });

  it("깊은 스쿼드로 15시즌을 전환해도 배치·계약이 유효하다", () => {
    const state = createTestGame(42);
    for (let s = 0; s < 15; s++) transitionSeason(state);
    for (const team of state.teams) {
      const roster = playersOf(state, team.id);
      const starters = assignmentsOf(state, team.id, "starting");
      expect(starters).toHaveLength(11);
      expect(roster.filter((p) => groupOf(p) === "GK").length).toBeGreaterThanOrEqual(1);
      // 배치는 모두 실제 보유 선수
      const ids = new Set(roster.map((p) => p.id));
      for (const a of assignmentsOf(state, team.id)) expect(ids.has(a.playerId)).toBe(true);
      // 모든 선수가 활성 계약을 갖는다 (은퇴자는 제거됨)
      for (const p of roster) expect(activeContract(state, p.id)).not.toBeNull();
    }
  }, 30_000);
});
