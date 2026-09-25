import { describe, expect, it } from "vitest";
import {
  MATCH_REPUTATION_SWING,
  STANCE_SEASON_CAP,
  advanceTime,
  applyPressOutcome,
  clampReputation,
  eventTexts,
  matchReputationDelta,
  pendingPress,
  respondToMedia,
} from "@story-fm/engine";
import type { ManagerReputation, PressConference } from "@story-fm/domain";
import { REPUTATION_AXES } from "@story-fm/domain";
import { createMiniGame, keepSeat, playMockMatch } from "../test/helpers";
import { PRESS_REPUTATION } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * **한 시즌을 한 말투로 보낸 감독을 세계는 어떻게 보는가** (→ `docs/simulation/career.md` §4).
 *
 *   pnpm balance press-reputation
 *
 * 회견은 시즌에 마흔 번 넘게 열린다. 대가가 매번 온전히 쌓이면 말투가 평판을
 * 독점하고, 성적은 그 옆에서 눈금 하나를 차지할 뿐이다 — 리그 2위·21승 감독의 언론
 * 평판이 0에 앉은 세이브가 그것이었다. 목줄(`STANCE_SEASON_CAP`)이 그 독점을 끊고,
 * 성적이 언론 축에도 닿는다. 눈금이 맞는지는 시즌을 굴려야 보인다.
 *
 * 팔은 둘이다. **축소 세계 한 시즌**은 회견이 실제로 얼마나 자주 열리고 감독이
 * 어디에 서게 되는지를 재고, **1부 규모**는 축소 세계가 낼 수 없는 마흔여덟 번의
 * 회견과 서른여덟 경기를 같은 함수로 굴려 완료 조건을 묻는다.
 */

/** 1부 한 시즌의 회견 수 — 이슈 #787의 실측(45~48회) */
const SEASON_CONFERENCES = 48;

/**
 * 우승을 다툰 한 시즌 — 이슈가 든 세이브의 시즌 1(리그 2위)이다.
 * 목줄이 옳게 서면 이 성적이 스탠스의 대가를 덮고도 남아야 한다.
 */
const RUNNER_UP = { wins: 26, draws: 7, losses: 5 };

/** 시즌 하나를 못 끝내면 측정이 아니다 */
const ADVANCE_LIMIT = 480;

/** 손으로 세운 회견 하나 — 1부 규모 팔이 쓰는 자리. 무게 2는 실측의 중앙이다 */
const conferenceAt = (i: number): PressConference => ({
  id: `press-scale-${i}`,
  date: "2026-08-20",
  trigger: "match",
  context: "1부 규모 팔",
  facts: [
    {
      kind: "result",
      data: { name: "리그", values: { for: 2, against: 1 }, tags: ["win", "home"] },
      about: null,
      sharp: false,
    },
  ],
  reporterId: "reporter-scale",
  status: "pending",
  weight: 2,
});

const axesOf = (rep: ManagerReputation) => REPUTATION_AXES.map((a) => rep[a]);

describe("한 시즌의 기자회견과 평판", () => {
  it("시드 42 · 축소 세계 · 회견마다 감싸는 감독", () => {
    const state = createMiniGame(42);
    keepSeat(state);
    const opening = { ...state.manager.reputation };

    let conferences = 0;
    let matches = 0;
    /** 시즌 내내의 바닥 — 끝값만 보면 중간에 「뭇매」를 지나온 것을 놓친다 */
    const floor: ManagerReputation = { ...state.manager.reputation };

    function answer(): void {
      while (pendingPress(state)) {
        const answered = respondToMedia(state, { stance: "defend" });
        if (!answered.ok) break;
        conferences += 1;
      }
      for (const axis of REPUTATION_AXES) {
        floor[axis] = Math.min(floor[axis], state.manager.reputation[axis]);
      }
    }

    let finished = false;
    for (let i = 0; i < ADVANCE_LIMIT; i++) {
      let advanced = advanceTime(state, { days: 1 });
      if (!advanced.ok) throw new Error(eventTexts(advanced.events).join(" / "));
      if (advanced.stopped === "blocked") {
        advanced = advanceTime(state, "next_match");
        if (!advanced.ok) throw new Error(eventTexts(advanced.events).join(" / "));
      }
      answer();
      if (advanced.stopped === "matchday") {
        playMockMatch(state);
        matches += 1;
        answer();
      }
      if (advanced.stopped === "season_end") {
        finished = true;
        break;
      }
    }
    expect(finished).toBe(true);

    const stance = state.manager.stanceSeason;
    const mini = state.manager.reputation;

    // ── 1부 규모 팔 — 마흔여덟 번의 회견과 서른여덟 경기, 같은 함수로 ──
    const scale = createMiniGame(42);
    keepSeat(scale);
    scale.pressConferences = [];
    for (let i = 0; i < SEASON_CONFERENCES; i++) {
      applyPressOutcome(scale, conferenceAt(i), "defend");
    }
    const scaleStance = { ...scale.manager.stanceSeason };
    /**
     * 성적은 `matchReputationDelta`가 낸다 — 값이 두 곳에 적히면 언론 축이 성적을
     * 다시 놓치는 날 이 하네스가 그것을 못 본다.
     */
    const record: Array<["win" | "draw" | "loss", number]> = [
      ["win", RUNNER_UP.wins],
      ["draw", RUNNER_UP.draws],
      ["loss", RUNNER_UP.losses],
    ];
    for (const [outcome, times] of record) {
      const delta = matchReputationDelta(outcome);
      for (let i = 0; i < times; i++) {
        for (const axis of REPUTATION_AXES) {
          scale.manager.reputation[axis] = clampReputation(
            scale.manager.reputation[axis] + delta[axis],
          );
        }
      }
    }
    const scaled = scale.manager.reputation;

    const readings: Readings<typeof PRESS_REPUTATION> = {
      "축소 세계 시즌 회견 수": conferences,
      "축소 세계 경기당 회견 수": matches > 0 ? conferences / matches : Number.NaN,
      "축소 세계 시즌 끝 언론": mini.media,
      "축소 세계 시즌 중 세 축의 바닥": Math.min(...axesOf(floor)),
      "축소 세계 스탠스가 옮긴 최대 폭": Math.max(
        ...REPUTATION_AXES.map((a) => Math.abs(stance[a])),
      ),
      "1부 규모 스탠스가 옮긴 최대 폭": Math.max(
        ...REPUTATION_AXES.map((a) => Math.abs(scaleStance[a])),
      ),
      "1부 규모 스탠스 몫 — 언론": scaleStance.media,
      "1부 규모 성적 몫 — 축당": (RUNNER_UP.wins - RUNNER_UP.losses) * MATCH_REPUTATION_SWING,
      "1부 규모 시즌 끝 언론": scaled.media,
      "1부 규모 시즌 끝 세 축의 바닥": Math.min(...axesOf(scaled)),
    };

    console.log(
      reportOf(
        PRESS_REPUTATION,
        readings,
        `시드 42 · 축소 세계 ${matches}경기 · 부임 평판 ${axesOf(opening).join("·")} · ` +
          `목줄 ${STANCE_SEASON_CAP} · 1부 규모 ${SEASON_CONFERENCES}회 · ` +
          `${RUNNER_UP.wins}승 ${RUNNER_UP.draws}무 ${RUNNER_UP.losses}패 · ${state.date}`,
      ),
    );
    expect(outOfBand(PRESS_REPUTATION, readings)).toEqual([]);
  });
});
