import { describe, expect, it } from "vitest";
import { DEFAULT_TACTICS, FIELD, type WeightSlot } from "@story-fm/domain";
import {
  SLOT_TENDENCY,
  advanceLive,
  heatmapDensity,
  heatmapMean,
  heatmapOf,
  makeRng,
  roleTendencyOf,
  sampleHeatmap,
  shapePosition,
  teamParamsOf,
  liveDigest,
  liveFinished,
  matchFatigueOf,
  possessionOf,
  LIVE_TICKS_PER_SECOND,
} from "@story-fm/sim";
import { makeLiveMatch } from "./helpers";

/** 한 경기를 끝까지 — 휴식은 바로 재개한다 */
function playOut(match: ReturnType<typeof makeLiveMatch>) {
  const rejected: string[] = [];
  const done = () => liveFinished(match);
  for (let guard = 0; guard < 400 && !done(); guard++) {
    const result = advanceLive(match, LIVE_TICKS_PER_SECOND * 60);
    rejected.push(...result.rejected);
    if (match.state.interval && !done()) match.state.interval = false;
  }
  return rejected;
}

describe("실시간 경기 — 결정성과 장부 계약 (live-match.md §8.2 · match.md §5)", () => {
  it("같은 시드·같은 입력이면 digest까지 같다", () => {
    const a = makeLiveMatch({ seed: 7 });
    const b = makeLiveMatch({ seed: 7 });
    advanceLive(a, LIVE_TICKS_PER_SECOND * 600);
    advanceLive(b, LIVE_TICKS_PER_SECOND * 600);
    expect(liveDigest(a.state, a.ledger)).toBe(liveDigest(b.state, b.ledger));
    expect(a.ledger.events.length).toBe(b.ledger.events.length);
  });

  it("나눠 굴려도 한 번에 굴린 것과 같다", () => {
    const a = makeLiveMatch({ seed: 11 });
    const b = makeLiveMatch({ seed: 11 });
    advanceLive(a, LIVE_TICKS_PER_SECOND * 300);
    for (let i = 0; i < 300; i++) advanceLive(b, LIVE_TICKS_PER_SECOND);
    expect(liveDigest(a.state, a.ledger)).toBe(liveDigest(b.state, b.ledger));
  });

  it("90분을 끝까지 굴리면 장부가 닫히고 반려는 없다", () => {
    const match = makeLiveMatch({ seed: 3 });
    const rejected = playOut(match);
    expect(rejected).toEqual([]);
    expect(match.ledger.phase).toBe("finished");
    const types = match.ledger.events.map((e) => e.type);
    expect(types).toContain("half_time");
    expect(types[types.length - 1]).toBe("full_time");
    // 스코어는 골 사건 수와 같다
    const goals = match.ledger.events.filter((e) => e.type === "goal");
    expect(goals.length).toBe(match.ledger.score.home + match.ledger.score.away);
    // 추가시간이 시계에 있다 — 하프의 끝 사건은 추가분을 싣는다
    const half = match.ledger.events.find((e) => e.type === "half_time");
    expect(half?.minute).toBe(45);
    expect(half?.added).toBeGreaterThanOrEqual(1);
  });

  it("말이 실제로 뛴 거리가 쌓이고 체력이 그만큼 준다", () => {
    const match = makeLiveMatch({ seed: 5 });
    playOut(match);
    const fatigue = matchFatigueOf(match);
    const homeStarters = match.setup.players;
    const ran = Object.values(match.ledger.stats).map((s) => s.distance);
    expect(Math.max(...ran)).toBeGreaterThan(5000);
    expect(Object.values(fatigue).some((f) => f > 20)).toBe(true);
    void homeStarters;
    const share = possessionOf(match);
    expect(share.home + share.away).toBeCloseTo(1, 6);
  });
});

describe("히트맵 — 역할의 연속 분포 (live-match.md §3.3)", () => {
  const SLOTS: WeightSlot[] = ["GK", "CB", "FB", "DM", "CM", "AM", "W", "CF", "ST"];
  const at = (ballDepth: number, attacking: boolean) => ({ attacking, ballDepth, commit: 1 });
  const normal = (rng: () => number) => () => (rng() + rng() + rng() + rng() - 2) * 1.73;

  it("밀도는 경기장 어디서나 0보다 크다 — 안과 밖을 가르는 경계가 없다", () => {
    for (const slot of SLOTS) {
      for (const attacking of [true, false]) {
        const h = heatmapOf(
          slot,
          SLOT_TENDENCY[slot],
          { depth: 40, lateral: 12 },
          at(50, attacking),
        );
        for (let depth = 0; depth <= FIELD.length; depth += 7.5) {
          for (let lateral = 0; lateral <= FIELD.width; lateral += 8.5) {
            expect(heatmapDensity(h, depth, lateral)).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("성분 하나의 분포는 중심에서 멀어질수록 매끄럽게 준다", () => {
    const h = heatmapOf("ST", SLOT_TENDENCY.ST, { depth: 60, lateral: 34 }, at(40, false));
    let previous = Infinity;
    for (let d = 0; d <= 40; d += 1) {
      const rho = heatmapDensity(h, 60 + d, 34);
      expect(rho).toBeLessThan(previous);
      previous = rho;
    }
  });

  it("중심을 옮기면 분포의 평균이 같은 만큼 옮는다 — 전술판이 히트맵을 끈다", () => {
    for (const slot of SLOTS) {
      const a = heatmapMean(
        heatmapOf(slot, SLOT_TENDENCY[slot], { depth: 30, lateral: 10 }, at(60, true)),
      );
      const b = heatmapMean(
        heatmapOf(slot, SLOT_TENDENCY[slot], { depth: 42, lateral: 16 }, at(60, true)),
      );
      expect(b.depth - a.depth).toBeCloseTo(12, 6);
      expect(b.lateral - a.lateral).toBeCloseTo(6, 6);
    }
  });

  it("뽑은 점의 평균이 분포의 평균에 선다 — 표본과 밀도가 같은 분포다", () => {
    const h = heatmapOf("FB", SLOT_TENDENCY.FB, { depth: 40, lateral: 8 }, at(70, true));
    const rng = makeRng(1, "heatmap-sample");
    let depth = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) depth += sampleHeatmap(h, rng, normal(rng)).depth;
    expect(depth / n).toBeCloseTo(heatmapMean(h).depth, 0);
  });

  it("풀백의 무게는 공이 전진할수록 연속으로 앞으로 옮고, 범위는 자기 박스부터 상대 마무리 지역까지다", () => {
    const params = teamParamsOf(DEFAULT_TACTICS, 1, 1);
    const slot = { position: "LB", point: { x: 12, y: 78 } };
    const zoneAt = (ballDepth: number, attacking: boolean, roleId?: string) => {
      const tendency = roleTendencyOf("LB", roleId);
      const center = shapePosition(slot, tendency, {
        side: "home",
        params,
        attacking,
        phase: attacking ? "progression" : "organised_defence",
        ballDepth,
        ballLateral: 20,
        backLine: 20,
        frontLimit: attacking ? 95 : ballDepth - 8,
      });
      return heatmapOf(
        "FB",
        tendency,
        { depth: center.x, lateral: center.y },
        at(ballDepth, attacking),
      );
    };
    const quantile = (h: ReturnType<typeof zoneAt>, q: number) => {
      const rng = makeRng(3, "fb-range");
      const xs = Array.from({ length: 4000 }, () => sampleHeatmap(h, rng, normal(rng)).depth).sort(
        (a, b) => a - b,
      );
      return xs[Math.floor(q * xs.length)]!;
    };
    // 공이 오를수록 평균이 앞으로 — 끊기지 않고
    let previous = -Infinity;
    for (let ball = 40; ball <= 95; ball += 5) {
      const mean = heatmapMean(zoneAt(ball, true)).depth;
      expect(mean).toBeGreaterThan(previous);
      previous = mean;
    }
    expect(quantile(zoneAt(12, false), 0.1)).toBeLessThan(FIELD.boxDepth);
    expect(quantile(zoneAt(85, true), 0.9)).toBeGreaterThan(FIELD.length * (2 / 3));
    // 윙백은 같은 공에서 풀백보다 앞에, 노-넌센스 풀백은 뒤에 무게를 둔다
    const mid = (roleId: string) => heatmapMean(zoneAt(70, true, roleId)).depth;
    expect(mid("wing-back")).toBeGreaterThan(mid("full-back"));
    expect(mid("full-back")).toBeGreaterThan(mid("no-nonsense-fb"));
  });
});
