import { describe, expect, it } from "vitest";
import {
  advanceSegment,
  advanceTime,
  buildOfficeViews,
  playerById,
  startMatch,
  type GameState,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

/**
 * 중계 판세의 **실시간 기록** — 골 목록과 선수별 집계 (views.ts).
 * 둘 다 `ledger.events`의 파생이다: 저장하지 않으므로 장부와 갈릴 수 없다.
 */

/** 경기일까지 진행한 뒤 킥오프하고 몇 구간 굴린다 (끝내지는 않는다) */
function intoMatch(seed: number): GameState {
  const state = createTestGame(seed);
  let guard = 12;
  while (state.phase !== "matchday" && guard-- > 0) {
    const moved = advanceTime(state, "next_match");
    if (!moved.ok) throw new Error(moved.digest.join(" / "));
    if (moved.stopped === "season_end") throw new Error("시즌이 끝났다");
  }
  const started = startMatch(state);
  expect(started.ok, started.message).toBe(true);
  for (let i = 0; i < 40 && state.phase === "match"; i++) {
    const step = advanceSegment(state);
    if (!step.ok) throw new Error(step.message);
    if (step.plan?.stop === "full_time") break;
  }
  return state;
}

describe("경기 중 기록", () => {
  it("골 목록이 장부의 득점과 정확히 맞는다", () => {
    const state = intoMatch(11);
    const view = buildOfficeViews(state).match;
    if (!view) return; // 경기가 이미 끝났으면 볼 것이 없다

    const scored = state.pendingMatch!.ledger.events.filter((e) => e.type === "goal");
    expect(view.goals).toHaveLength(scored.length);
    expect(view.goals.length).toBe(view.score.home + view.score.away);
    for (const g of view.goals) {
      expect(g.scorer.length).toBeGreaterThan(0);
      expect(g.minute).toBeGreaterThanOrEqual(0);
    }
  });

  it("선수별 집계가 사건 목록과 어긋나지 않는다", () => {
    const state = intoMatch(7);
    const view = buildOfficeViews(state).match;
    if (!view) return;

    const rows = [...view.onPitch.home, ...view.onPitch.away, ...view.bench.home, ...view.bench.away];
    const events = state.pendingMatch!.ledger.events;
    const countOf = (type: string, id: string) =>
      events.filter((e) => e.type === type && e.actors[0] === id).length;

    for (const p of rows) {
      expect(p.tally.goals, `${p.name} 골`).toBe(countOf("goal", p.id));
      expect(p.tally.saves, `${p.name} 선방`).toBe(countOf("save", p.id));
      expect(p.tally.yellows, `${p.name} 경고`).toBe(countOf("yellow_card", p.id));
      expect(p.tally.red, `${p.name} 퇴장`).toBe(countOf("red_card", p.id) > 0);
      // 골도 슛으로 센다 — 시도 수가 사실과 어긋나면 안 된다
      expect(p.tally.shots, `${p.name} 슛`).toBe(countOf("shot", p.id) + countOf("goal", p.id));
    }
  });

  it("도움은 두 번째 행위자에게 붙는다", () => {
    const state = intoMatch(3);
    const view = buildOfficeViews(state).match;
    if (!view) return;
    const events = state.pendingMatch!.ledger.events;
    const assisted = events.filter((e) => e.type === "goal" && e.actors[1]);
    const rows = [...view.onPitch.home, ...view.onPitch.away, ...view.bench.home, ...view.bench.away];
    const total = rows.reduce((sum, p) => sum + p.tally.assists, 0);
    // 명단 밖(교체로 나간 선수)의 도움은 표에 없으므로 합이 더 클 수는 없다
    expect(total).toBeLessThanOrEqual(assisted.length);
  });
});

describe("흐름의 양 — 사건이 아닌 기록", () => {
  it("패스가 쌓이고 전진 패스는 그 일부다", () => {
    const state = intoMatch(5);
    const view = buildOfficeViews(state).match;
    if (!view) return;

    const rows = [...view.onPitch.home, ...view.onPitch.away];
    const passes = rows.reduce((s, p) => s + p.tally.passes, 0);
    expect(passes, "패스가 하나도 안 쌓였다").toBeGreaterThan(0);
    for (const p of rows) {
      expect(p.tally.progressive, `${p.name} 전진 패스`).toBeLessThanOrEqual(p.tally.passes);
    }
    // 중원이 가장 많이 만진다 — 자리에 따라 갈려야 배분이 뜻을 갖는다
    expect(new Set(rows.map((p) => p.tally.passes)).size).toBeGreaterThan(1);
  });

  it("전진 패스 비율은 선수마다 다르다 — 앞을 보는 선수가 더 찌른다", () => {
    const state = intoMatch(7);
    const view = buildOfficeViews(state).match;
    if (!view) return;

    const rows = [...view.onPitch.home, ...view.onPitch.away]
      .filter((p) => p.tally.passes >= 20 && p.position !== "GK")
      .map((p) => ({
        name: p.name,
        share: p.tally.progressive / p.tally.passes,
        drive: (() => {
          const a = playerById(state, p.id)!.attributes;
          return a.vision * 0.5 + a.kicking * 0.3 + a.composure * 0.2;
        })(),
      }));
    if (rows.length < 6) return;

    // 비율이 하나로 뭉쳐 있으면 성향이 안 걸린 것이다
    const shares = new Set(rows.map((r) => Math.round(r.share * 100)));
    expect(shares.size, "전진 패스 비율이 전원 같다").toBeGreaterThan(1);

    // 앞을 보는 쪽이 더 찌른다 — 상위 절반의 평균이 하위 절반보다 높다
    const sorted = [...rows].sort((a, b) => b.drive - a.drive);
    const half = Math.floor(sorted.length / 2);
    const mean = (xs: typeof rows) => xs.reduce((s, r) => s + r.share, 0) / xs.length;
    expect(mean(sorted.slice(0, half))).toBeGreaterThan(mean(sorted.slice(-half)));
  });

  it("슛에는 xG가 붙고, 합이 선수 기록과 맞는다", () => {
    const state = intoMatch(7);
    const view = buildOfficeViews(state).match;
    if (!view) return;
    const events = state.pendingMatch!.ledger.events;
    const shots = events.filter((e) => e.type === "shot" || e.type === "goal");
    if (shots.length === 0) return;
    for (const e of shots) {
      expect(e.xg, `${e.minute}' ${e.type} xg 없음`).toBeDefined();
      expect(e.xg!).toBeGreaterThan(0);
      expect(e.xg!).toBeLessThanOrEqual(1);
      expect(e.goalProbability).toBeDefined();
    }
    // 팀 xG 합 ≈ 사건 xg 합 (반올림 오차만큼만 어긋난다)
    const rows = [...view.onPitch.home, ...view.onPitch.away, ...view.bench.home, ...view.bench.away];
    const fromRows = rows.reduce((s, p) => s + p.tally.xg, 0);
    const fromEvents = shots.reduce((s, e) => s + (e.xg ?? 0), 0);
    expect(Math.abs(fromRows - fromEvents)).toBeLessThan(0.5);
  });

  it("골키퍼만 선방을 갖는다", () => {
    const state = intoMatch(11);
    const view = buildOfficeViews(state).match;
    if (!view) return;
    for (const p of [...view.onPitch.home, ...view.onPitch.away]) {
      if (p.tally.saves > 0) expect(p.position, `${p.name}`).toBe("GK");
    }
  });
});
