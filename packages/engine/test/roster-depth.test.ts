import { describe, expect, it } from "vitest";
import {
  ageOf,
  FORMATION_SLOTS,
  positionGroupOf,
  positionGroupOfPlayer,
  type PositionGroup,
} from "@story-fm/domain";
import { teamCatalog, isClubTeam, playerCatalog } from "@story-fm/engine";

const TIER = new Map(teamCatalog().map((t) => [t.id, t.tier]));
/** 스쿼드를 갖는 클럽만 — 무소속은 방출·계약 만료로만 사람이 들어온다 */
const CLUBS = teamCatalog().filter((t) => isClubTeam(t.id));
const REF = "2026-08-15"; // 시즌 개막 기준 나이
const GROUPS: readonly PositionGroup[] = ["GK", "DF", "MF", "FW"];

/** 골키퍼만 슬롯 하나를 넘겨 잡는다 — 부상·정지로 주전이 빠져도 골문은 비지 않는다 */
const GK_FLOOR = 2;

describe("실선수 로스터 깊이 (30인+, 유망주 포함)", () => {
  const catalog = playerCatalog();
  const rosterOf = (teamId: string) => catalog.filter((e) => e.teamId === teamId);

  it("팀당 18인 이상, 전역 id 유일", () => {
    const global = new Set<string>();
    for (const team of CLUBS) {
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
    for (const team of CLUBS) {
      const roster = rosterOf(team.id);
      const count = (g: PositionGroup) =>
        roster.filter((e) => positionGroupOfPlayer(e) === g).length;
      /**
       * 엔진이 요구하는 것은 **프리셋 하나를 제자리 선수로 채울 수 있는가**뿐이다 —
       * `pickFormation`은 스쿼드가 감당하는 모양을 고르지 특정 모양을 강요하지 않는다.
       * 수비수가 넷인 구단은 5백을 안 설 뿐 깨진 것이 아니다.
       */
      const fillable = Object.values(FORMATION_SLOTS).some((slots) =>
        GROUPS.every((g) => count(g) >= slots.filter((s) => positionGroupOf(s) === g).length),
      );
      expect(fillable, `${team.id}: 어떤 프리셋도 제자리 선수로 채울 수 없다`).toBe(true);
      expect(count("GK"), `${team.id}: 백업 골키퍼가 없다`).toBeGreaterThanOrEqual(GK_FLOOR);
    }
  });

  it("모든 팀이 21세 이하 유망주를 보유한다", () => {
    for (const team of CLUBS) {
      const roster = rosterOf(team.id);
      const youths = roster.filter((e) => ageOf(e.birthdate, REF) <= 21);
      expect(youths.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("tier가 낮을수록(강할수록) 평균 잠재치가 높다", () => {
    const avgByTier: Record<number, number[]> = { 1: [], 2: [], 3: [], 4: [] };
    for (const team of CLUBS) {
      const roster = rosterOf(team.id);
      const avg = roster.reduce((s, e) => s + e.potential, 0) / roster.length;
      avgByTier[TIER.get(team.id) ?? 3]!.push(avg);
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(avgByTier[1]!)).toBeGreaterThan(mean(avgByTier[4]!));
  });
});
