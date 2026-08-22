import { describe, expect, it } from "vitest";
import type { SubCause } from "@story-fm/domain";
import type { GameState } from "@story-fm/engine";
import { createTestGame, keepSeat } from "../test/helpers";
import { AI_BENCH } from "./catalog";
import { playSeason } from "./season";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * **상대 벤치가 경기를 쫓는가** — 감독의 경기를 한 시즌 치르며 AI가 쓴 교체를 센다
 * (match.md §2).
 *
 * 재는 것은 손잡이(`SUB_CHASE_MINUTE`·`SUB_HOLD_MINUTE`·장수 상한)가 실제 경기
 * 분포로 번역됐는가다. 문턱을 여기에 다시 적지 않는다 — 갈래를 가르는 열쇠는
 * 구간 시뮬이 쥔 `subCause` 그것이고, 밴드는 서술자가 쥔다.
 *
 *   pnpm balance ai-bench
 */

const SEEDS = [7, 11];
/** 후반 교체가 몰리는 구간의 시작 — 분포를 읽는 눈금이지 문턱이 아니다 */
const LATE = 60;

interface Tally {
  matches: number;
  subs: number[];
  chase: number;
  hold: number;
  fatigue: number;
  injury: number;
  /** 끝까지 뒤진 경기 · 그중 승부수를 던진 경기 */
  trailed: number;
  trailedChased: number;
  led: number;
  ledHeld: number;
  reshaped: number;
}

function collect(state: GameState, tally: Tally): void {
  const pending = state.pendingMatch;
  if (!pending) return;
  const match = state.matches.find((m) => m.id === pending.matchId);
  if (!match) return;
  const aiSide = match.homeTeamId === state.userTeamId ? "away" : "home";
  const score = pending.ledger.score;
  const diff = aiSide === "home" ? score.home - score.away : score.away - score.home;

  const subs = pending.ledger.events.filter((e) => e.type === "substitution" && e.team === aiSide);
  const of = (cause: SubCause) => subs.filter((e) => e.subCause === cause).length;

  tally.matches += 1;
  for (const sub of subs) tally.subs.push(sub.minute);
  tally.chase += of("chase");
  tally.hold += of("hold");
  tally.fatigue += of("fatigue");
  tally.injury += of("injury");
  if (pending.aiShape) tally.reshaped += 1;
  if (diff < 0) {
    tally.trailed += 1;
    if (of("chase") > 0) tally.trailedChased += 1;
  }
  if (diff > 0) {
    tally.led += 1;
    if (of("hold") > 0) tally.ledHeld += 1;
  }
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

describe("상대 벤치가 스코어와 남은 시간을 읽는가", () => {
  it(`시드 ${SEEDS.join("·")}`, () => {
    const tally: Tally = {
      matches: 0,
      subs: [],
      chase: 0,
      hold: 0,
      fatigue: 0,
      injury: 0,
      trailed: 0,
      trailedChased: 0,
      led: 0,
      ledHeld: 0,
      reshaped: 0,
    };
    for (const seed of SEEDS) {
      const state = createTestGame(seed);
      // 경질은 시계를 멈춘다 — 한 시즌을 다 돌아야 분포가 선다
      keepSeat(state);
      playSeason(state, (s) => collect(s, tally));
    }

    const per = (n: number) => n / (tally.matches || 1);
    const readings: Readings<typeof AI_BENCH> = {
      "AI 교체/경기": per(tally.subs.length),
      "승부수 교체/경기": per(tally.chase),
      "굳히기 교체/경기": per(tally.hold),
      "체력 교체/경기": per(tally.fatigue),
      "부상 교체/경기": per(tally.injury),
      "끝까지 뒤진 경기에서 승부수를 던진 비율": tally.trailedChased / (tally.trailed || 1),
      "끝까지 앞선 경기에서 굳힌 비율": tally.ledHeld / (tally.led || 1),
      "AI 교체의 60′ 이후 비율":
        tally.subs.filter((m) => m >= LATE).length / (tally.subs.length || 1),
      "AI 교체 중앙 분": median(tally.subs),
      "판의 모양을 바꾼 경기 비율": tally.reshaped / (tally.matches || 1),
      "잰 경기 수": tally.matches,
    };
    console.log(
      reportOf(
        AI_BENCH,
        readings,
        `시드 ${SEEDS.join("·")} · 뒤진 경기 ${tally.trailed} · 앞선 경기 ${tally.led}`,
      ),
    );
    expect(outOfBand(AI_BENCH, readings)).toEqual([]);
  });
});
