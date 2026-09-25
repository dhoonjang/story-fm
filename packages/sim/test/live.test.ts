import { describe, expect, it } from "vitest";
import {
  advanceLive,
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
