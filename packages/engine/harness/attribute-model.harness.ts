import { describe, expect, it } from "vitest";
import { ageOf, bestOverall, weightSlotOf, type WeightSlot } from "@story-fm/domain";
import { deriveAxes, type SeedAxes } from "../src/world/attributes";
import { CATALOG_AGE_REF, derivePositions } from "../src/world/catalog";
import { RETARGET_TOLERANCE, potentialGapBand, synthesizeSeed } from "../src/world/synthesis";
import { SQUAD_SEEDS } from "../src/data/squad-seeds";
import { TIER_BASE, strengthBase, teamCatalog } from "../src/data/team-catalog";
import { ATTRIBUTE_MODEL } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * **자체 산정 모델이 낸 세계와 지금 시드가 같은 눈금인가** (player.md §13.3).
 *
 * 밴드는 절대값이 아니라 **두 분포의 간격**에 걸린다 — "합성 평균이 72~74"라고
 * 적으면 시드를 갱신할 때마다 밴드가 낡지만, "합성과 시드의 차가 ±2 안"이면
 * 시드가 움직여도 묻는 것이 그대로다.
 *
 * 세계를 세우지 않는다 — 비교 대상인 시드 분포는 `SQUAD_SEEDS`를
 * `deriveAxes`+`bestOverall`로 그 자리에서 재고(카탈로그의 `entryFromSeed`와 같은
 * 경로), 합성 쪽은 그 명단과 **같은 체급·같은 스쿼드 크기·같은 자리 구성**으로 세운다.
 *
 *   pnpm balance attribute-model
 */

const clamp99 = (x: number) => Math.max(1, Math.min(99, Math.round(x)));

/** 한 사람에게서 읽는 것 — 시드 쪽과 합성 쪽이 같은 모양이어야 비교가 선다 */
interface Measured {
  tier: 1 | 2 | 3 | 4;
  /** 명단 안 순번 — 종합 내림차순, 0이 그 스쿼드 최고 */
  rank: number;
  position: string;
  slot: WeightSlot;
  overall: number;
  age: number;
  potential: number;
  /** 그 스쿼드 최고 대비 낙차 */
  drop: number;
}

/**
 * 시드 명단에서 읽는 것 — **시드 쪽 분포를 재는 데만 쓴다.**
 * 합성 쪽으로 넘어가는 것은 자리와 스쿼드 크기뿐이고 능력치는 한 축도 넘어가지 않는다.
 */
interface SeedRow extends SeedAxes {
  nameEn: string;
  birthdate: string;
  position: string;
  potential: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}

function meanOf(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN;
}

/** 한 스쿼드를 순번으로 세운다 — 낙차는 그 팀 최고 대비다 */
function ranked(squad: Omit<Measured, "rank" | "drop">[]): Measured[] {
  const sorted = [...squad].sort((a, b) => b.overall - a.overall);
  const apex = sorted[0]?.overall ?? 0;
  return sorted.map((p, rank) => ({ ...p, rank, drop: p.overall - apex }));
}

/** 시드 명단 하나를 카탈로그가 하는 것과 같은 경로로 잰다 (`entryFromSeed`) */
function seedSquad(tier: 1 | 2 | 3 | 4, seeds: readonly SeedRow[]): Measured[] {
  return ranked(
    seeds.map((s) => {
      const age = ageOf(s.birthdate, CATALOG_AGE_REF);
      const positions = derivePositions(s.nameEn, s.position);
      const overall = bestOverall(deriveAxes(s.nameEn, s.position, s, age), positions);
      return {
        tier,
        position: s.position,
        slot: weightSlotOf(s.position),
        overall,
        age,
        // 카탈로그와 같이 접는다 — 잠재력은 현재 실력 아래로 내려가지 않는다
        potential: Math.max(clamp99(s.potential), overall),
      };
    }),
  );
}

/** 되맞춤이 목표에 닿았는가 — 합성 쪽에서만 읽는 값 */
interface Retarget {
  passes: number[];
  missed: number;
}

/**
 * 같은 팀·같은 크기·같은 자리 구성의 합성 스쿼드.
 *
 * 자리 배치를 시드 명단에서 빌리는 이유는 **재는 것이 자리별 모양**이기 때문이다 —
 * 구성이 다르면 자리별 평균 비교가 성립하지 않는다. 모델이 읽는 것은 여전히 넷뿐
 * (체급·순번·자리·나이)이고, 시드의 능력치는 어느 것도 넘어오지 않는다.
 */
function syntheticSquad(
  teamId: string,
  tier: 1 | 2 | 3 | 4,
  secondDivision: boolean,
  byRank: readonly Measured[],
  retarget: Retarget,
): Measured[] {
  return ranked(
    byRank.map(({ rank, position }) => {
      const key = `${teamId}#${rank}`;
      const player = synthesizeSeed({
        key,
        tier,
        rank,
        positions: derivePositions(key, position),
        secondDivision,
      });
      retarget.passes.push(player.passes);
      if (Math.abs(player.target - player.overall) > RETARGET_TOLERANCE) retarget.missed++;
      return {
        tier,
        position,
        slot: weightSlotOf(position),
        overall: player.overall,
        age: player.age,
        potential: player.potential,
      };
    }),
  );
}

function readings(
  synthetic: Measured[],
  seed: Measured[],
  retarget: Retarget,
  teams: number,
): Readings<typeof ATTRIBUTE_MODEL> {
  /** 두 분포에서 같은 값을 재고 차만 남긴다 — 밴드가 걸리는 것은 언제나 이 차다 */
  const gapOf = (read: (players: Measured[]) => number) => read(synthetic) - read(seed);
  const overalls = (players: Measured[]) => players.map((p) => p.overall).sort((a, b) => a - b);
  const inTier = (players: Measured[], tier: number) => players.filter((p) => p.tier === tier);
  const ages = (players: Measured[]) => players.map((p) => p.age).sort((a, b) => a - b);
  const roomOf = (players: Measured[]) =>
    players.map((p) => p.potential - p.overall).sort((a, b) => a - b);

  const tierP50 = (tier: number) => gapOf((p) => quantile(overalls(inTier(p, tier)), 0.5));
  const tierApex = (tier: number) =>
    gapOf((p) =>
      meanOf(
        inTier(p, tier)
          .filter((x) => x.rank === 0)
          .map((x) => x.overall),
      ),
    );
  const dropAt = (from: number, to: number) =>
    gapOf((p) => meanOf(p.filter((x) => x.rank >= from && x.rank <= to).map((x) => x.drop)));
  const slotMean = (slot: WeightSlot) =>
    gapOf((p) => meanOf(p.filter((x) => x.slot === slot).map((x) => x.overall)));

  const overBand = synthetic.filter(
    (p) => p.potential - p.overall > potentialGapBand(p.age).max,
  ).length;

  return {
    "팀 수": teams,
    "선수 수": synthetic.length,
    "종합 평균 차": gapOf((p) => meanOf(overalls(p))),
    "종합 p10 차": gapOf((p) => quantile(overalls(p), 0.1)),
    "종합 p50 차": gapOf((p) => quantile(overalls(p), 0.5)),
    "종합 p90 차": gapOf((p) => quantile(overalls(p), 0.9)),
    "체급1 종합 p50 차": tierP50(1),
    "체급2 종합 p50 차": tierP50(2),
    "체급3 종합 p50 차": tierP50(3),
    "체급4 종합 p50 차": tierP50(4),
    "체급1 꼭대기 평균 차": tierApex(1),
    "체급2 꼭대기 평균 차": tierApex(2),
    "체급3 꼭대기 평균 차": tierApex(3),
    "체급4 꼭대기 평균 차": tierApex(4),
    "낙차 순번0~4 차": dropAt(0, 4),
    "낙차 순번5~10 차": dropAt(5, 10),
    "낙차 순번11~17 차": dropAt(11, 17),
    "낙차 순번18~24 차": dropAt(18, 24),
    "낙차 순번25+ 차": dropAt(25, Number.POSITIVE_INFINITY),
    "자리 GK 평균 차": slotMean("GK"),
    "자리 CB 평균 차": slotMean("CB"),
    "자리 FB 평균 차": slotMean("FB"),
    "자리 DM 평균 차": slotMean("DM"),
    "자리 CM 평균 차": slotMean("CM"),
    "자리 AM 평균 차": slotMean("AM"),
    "자리 W 평균 차": slotMean("W"),
    "자리 CF 평균 차": slotMean("CF"),
    "자리 ST 평균 차": slotMean("ST"),
    "나이 평균 차": gapOf((p) => meanOf(ages(p))),
    "나이 p10 차": gapOf((p) => quantile(ages(p), 0.1)),
    "나이 p90 차": gapOf((p) => quantile(ages(p), 0.9)),
    "잠재력 여유 평균 차": gapOf((p) => meanOf(roomOf(p))),
    "잠재력 여유 p90 차": gapOf((p) => quantile(roomOf(p), 0.9)),
    "잠재력 대역 상한 초과 비율": overBand / Math.max(1, synthetic.length),
    "되맞춤 평균 반복": meanOf(retarget.passes),
    "되맞춤 목표 미달 비율": retarget.missed / Math.max(1, retarget.passes.length),
  };
}

describe("자체 산정 모델 — 합성 분포와 시드 분포의 간격", () => {
  it("시드가 있는 클럽 전체", () => {
    const synthetic: Measured[] = [];
    const seed: Measured[] = [];
    const retarget: Retarget = { passes: [], missed: 0 };
    let teams = 0;

    for (const team of teamCatalog()) {
      const seeds = SQUAD_SEEDS[team.id];
      if (!seeds || seeds.length === 0) continue;
      teams++;
      // 2부 판정은 스쿼드 생성이 쓰는 것 그것 — 감점이 걸렸는지로 되읽는다
      const secondDivision = strengthBase(team) < TIER_BASE[team.tier];
      const mine = seedSquad(team.tier, seeds);
      seed.push(...mine);
      synthetic.push(...syntheticSquad(team.id, team.tier, secondDivision, mine, retarget));
    }

    const measured = readings(synthetic, seed, retarget, teams);
    console.log(
      reportOf(
        ATTRIBUTE_MODEL,
        measured,
        `시드 ${seed.length.toLocaleString()}명 · ${teams}팀 — 합성 − 시드`,
      ),
    );
    expect(seed.length).toBeGreaterThan(0);
    expect(outOfBand(ATTRIBUTE_MODEL, measured)).toEqual([]);
  });
});
