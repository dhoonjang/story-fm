import { describe, expect, it } from "vitest";
import { ATTRIBUTE_AXES, naturalPositionOf } from "@story-fm/domain";
import type { GamePlayer } from "@story-fm/domain";
import { assignSquadNumber, ensureSquadNumbers } from "@story-fm/engine";

/**
 * 등번호만 보는 최소 선수 — 자리·팀·번호가 전부다.
 *
 * 배정은 `positions`·`teamId`·`squadNumber`만 읽으므로 세계를 만들 이유가 없다
 * (`createTestGame`은 수천 명을 인스턴스화해 수 초를 쓴다).
 */
function player(id: string, teamId: string, position: string, squadNumber?: number): GamePlayer {
  const axes = Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, 70])) as Record<string, number>;
  return {
    id,
    catalogId: null,
    teamId,
    name: id,
    birthdate: "2000-01-01",
    positions: [{ position, proficiency: 90, isNatural: true }],
    attributes: { ...axes, overall: 70, potential: 75 } as GamePlayer["attributes"],
    state: { form: 0, condition: 75 },
    isCaptain: false,
    squadNumber,
  };
}

/**
 * 프리패스 이전의 배정 — 한 명마다 전 선수를 훑어 그 팀의 사용 번호를 다시 모은다.
 *
 * 최적화가 바꿔도 되는 것은 **비용뿐**이다. 등번호는 감독이 외우는 값이라 세이브를
 * 열 때마다 달라지면 안 되고, 그 "달라지지 않음"의 기준은 이 옛 구현이다.
 */
function ensureSquadNumbersNaive(players: readonly GamePlayer[]): void {
  const usedByTeam = new Map<string, Set<number>>();
  for (const one of players) {
    if (one.teamId === "freeagents") {
      one.squadNumber = undefined;
      continue;
    }
    const used = usedByTeam.get(one.teamId) ?? new Set<number>();
    usedByTeam.set(one.teamId, used);
    if (one.squadNumber !== undefined && !used.has(one.squadNumber)) {
      used.add(one.squadNumber);
      continue;
    }
    one.squadNumber = undefined;
    used.add(assignSquadNumber(players, one));
  }
}

const POSITIONS = ["GK", "RB", "LB", "CB", "DM", "CM", "AM", "RW", "LW", "ST"];

/** 시드 난수 — 같은 시드는 늘 같은 명단을 만든다 (LCG) */
function rng(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

/**
 * 뒤엉킨 명단 하나 — 배정이 밟는 갈래를 전부 담는다.
 *
 * 빈 번호, 같은 팀 안의 중복, **아직 차례가 오지 않은 뒤쪽 동료가 쥔 번호**,
 * 번호를 들고 있는 무소속. 마지막 둘이 프리패스가 틀리기 쉬운 자리다.
 */
function tangledSquad(seed: number): GamePlayer[] {
  const next = rng(seed);
  const teams = ["alpha", "beta", "gamma", "freeagents"];
  const players: GamePlayer[] = [];
  for (let i = 0; i < 120; i++) {
    const teamId = teams[Math.floor(next() * teams.length)]!;
    const position = POSITIONS[Math.floor(next() * POSITIONS.length)]!;
    const roll = next();
    const squadNumber =
      roll < 0.3
        ? undefined // 미배정 — 새로 받아야 한다
        : roll < 0.6
          ? 1 + Math.floor(next() * 12) // 좁은 구간 — 중복이 흔하게 난다
          : 1 + Math.floor(next() * 99);
    players.push(player(`p${i}`, teamId, position, squadNumber));
  }
  return players;
}

function numbersOf(players: readonly GamePlayer[]): Array<number | undefined> {
  return players.map((one) => one.squadNumber);
}

describe("등번호 배정 (squad/numbers.ts)", () => {
  it("프리패스 배정이 옛 O(n²) 배정과 한 명도 다르지 않다", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const naive = tangledSquad(seed);
      const fast = tangledSquad(seed);
      expect(numbersOf(fast), `seed ${seed}: 같은 입력인데 명단이 다르다`).toEqual(
        numbersOf(naive),
      );

      ensureSquadNumbersNaive(naive);
      ensureSquadNumbers(fast);

      expect(numbersOf(fast), `seed ${seed}`).toEqual(numbersOf(naive));
    }
  });

  it("한 번 채운 명단을 다시 채워도 번호가 그대로다 (멱등)", () => {
    const squad = tangledSquad(7);
    ensureSquadNumbers(squad);
    const settled = numbersOf(squad);
    ensureSquadNumbers(squad);
    expect(numbersOf(squad)).toEqual(settled);
  });

  it("클럽 소속은 팀 안에서 겹치지 않는 1~99를 갖고, 무소속은 번호를 잃는다", () => {
    const squad = tangledSquad(3);
    ensureSquadNumbers(squad);

    const byTeam = new Map<string, number[]>();
    for (const one of squad) {
      if (one.teamId === "freeagents") {
        expect(one.squadNumber).toBeUndefined();
        continue;
      }
      expect(one.squadNumber).toBeGreaterThanOrEqual(1);
      expect(one.squadNumber).toBeLessThanOrEqual(99);
      byTeam.set(one.teamId, [...(byTeam.get(one.teamId) ?? []), one.squadNumber!]);
    }
    for (const [teamId, numbers] of byTeam) {
      expect(new Set(numbers).size, teamId).toBe(numbers.length);
    }
  });

  it("자리 관례를 먼저 준다 — 골키퍼는 1번, 그다음 골키퍼는 13번", () => {
    const squad = [player("gk1", "alpha", "GK"), player("gk2", "alpha", "GK")];
    ensureSquadNumbers(squad);
    expect(numbersOf(squad)).toEqual([1, 13]);
    expect(naturalPositionOf(squad[0]!).position).toBe("GK");
  });
});
