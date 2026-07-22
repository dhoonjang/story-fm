import { describe, expect, it } from "vitest";
import { makeRng } from "@story-fm/engine";

/**
 * 회귀 — 부상 RNG 채널에 시즌이 포함되어 시즌 간 난수열이 달라진다.
 * (리뷰 발견: `injury:${round}` 채널은 시즌이 달라도 같은 난수열)
 */
describe("회귀: 부상 RNG 채널 시즌 포함", () => {
  it("같은 라운드라도 시즌이 다르면 부상 난수열이 다르다", () => {
    const round = 1;
    const season1 = makeRng(42, `injury:1:${round}`)();
    const season2 = makeRng(42, `injury:2:${round}`)();
    expect(season1).not.toBe(season2);
  });
});
