import { describe, expect, it } from "vitest";
import {
  addDays,
  advanceTime,
  diffDays,
  MANAGER_SUBJECT,
  pendingApproach,
  pendingPress,
  playersOf,
  relationOf,
  relationTierOf,
  type GameState,
} from "@story-fm/engine";
import type { Approach, TransferRequestReason } from "@story-fm/domain";
import { RELATION_TIER_RANK } from "@story-fm/domain";
import { createMiniGame, keepSeat, playMockMatch } from "../test/helpers";
import { APPROACH_RATE } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * **세계가 얼마나 자주 먼저 말을 거는가** (→ `docs/data/people.md` §8).
 *
 *   pnpm balance approach-rate
 *
 * 감독은 아무것도 하지 않는다 — 찾아온 사람을 돌려보내지도 않고 그냥 지나친다.
 * 그것이 **소음의 상한**이다: 임계를 낮게 잡으면 여기서 건수가 폭발하고, 높게
 * 잡으면 한 시즌 내내 아무도 오지 않는다. 어느 쪽인지는 시즌을 굴려야 보인다.
 *
 * 문(하루 한 건 · 동시 하나 · 화자 쿨다운 · 회견과 겹치지 않기)은 밴드가 아니라
 * **guard**다 — 벗어나면 눈금 문제가 아니라 구현이 샌 것이다.
 */

/** 같은 화자가 다시 오기까지 — `approach.ts`의 문과 같은 값 */
const SPEAKER_COOLDOWN_DAYS = 7;

/** 회견이 자리를 다투는 기간 — `approach.ts`의 문과 같은 값 */
const PRESS_FRESH_DAYS = 3;

/**
 * 이적 요청이 서는 계단 — `APPROACH_MAX_STEP`과 같은 값.
 *
 * ⚠️ **채널로 세지 않는다.** 에이전트는 계약 만료·타 구단 관심도 들고 오므로
 * `channel === "agent"`는 이제 요청보다 넓다 (people.md §8).
 */
const TRANSFER_REQUEST_STEP = 5;

/** 시즌 하나를 못 끝내면 측정이 아니다 */
const ADVANCE_LIMIT = 480;

/**
 * 시즌 전환 뒤에 더 도는 날 — **시즌 리뷰 면담은 달력이 여는 자리다** (career.md §5).
 *
 * `season_end`에서 곧바로 멈추면 프리시즌 첫 주에 서는 그 자리를 한 번도 보지 못한다.
 * 창(`REVIEW_WINDOW_DAYS` 7일)만큼만 더 도므로 다른 측정값은 거의 움직이지 않는다 —
 * 불만도 순위도 새 시즌에서 다시 세는 자리라 프리시즌 초반에는 원인이 없다.
 */
const REVIEW_TAIL_DAYS = 7;

/** 시즌 끝에 감독과 `strained` 이하인 우리 선수 */
function sourPlayers(state: GameState) {
  return playersOf(state, state.userTeamId).filter(
    (p) => RELATION_TIER_RANK[relationTierOf(state, MANAGER_SUBJECT, p.id)] < 0,
  );
}

/** 감독이 누군가와 가장 멀어진 자리 — 아무도 없으면 0 */
function lowestRelation(state: GameState): number {
  return Math.min(
    0,
    ...playersOf(state, state.userTeamId).map((p) => relationOf(state, MANAGER_SUBJECT, p.id)),
  );
}

describe("한 시즌의 다가옴", () => {
  it("시드 42 · 축소 세계 · 아무것도 하지 않는 감독", () => {
    const state = createMiniGame(42);
    keepSeat(state);
    const start = state.date;

    const seen = new Map<string, Approach>();
    /** 하루에 열린 수 — 문이 실제로 서는지는 열린 날짜로만 알 수 있다 */
    const openedOn = new Map<string, number>();
    let concurrent = 0;
    let withPress = 0;
    /**
     * 유출은 **사건**이라 시즌 끝의 상태로는 셀 수 없다 — 다음 회견이 실어 가면
     * `pressLeaks`에서 지워지고, 요청까지 간 선수는 시장이 데려가며 압력 줄도 함께
     * 사라진다. 매일 훑어 모으는 수밖에 없다.
     */
    const leaks = new Set<string>();
    /**
     * 요청도 같은 이유로 매일 모은다 — 불만이 풀리거나 창이 닫히면 걷히고
     * (transfer.md §1-1), 요청까지 간 선수는 시장이 데려가며 줄도 함께 사라진다.
     */
    const requests = new Set<string>();

    function sample(): void {
      for (const leak of state.pressLeaks ?? []) {
        leaks.add(`${leak.playerId}:${leak.topic}:${leak.date}`);
      }
      for (const request of state.transferRequests ?? []) {
        requests.add(`${request.gamePlayerId}:${request.reason}:${request.since}`);
      }
      const open = pendingApproach(state);
      if (!open) return;
      if (!seen.has(open.id)) {
        seen.set(open.id, { ...open });
        openedOn.set(open.date, (openedOn.get(open.date) ?? 0) + 1);
        /**
         * **갓 열린 회견과 겹쳤는가** — 열린 그 순간에만 셀 수 있다. 사흘이 지난
         * 회견은 감독이 지나친 것이라 자리를 다투지 않는다 (people.md §8의 다섯째 문).
         */
        const press = pendingPress(state);
        if (press && diffDays(press.date, state.date) < PRESS_FRESH_DAYS) withPress += 1;
      }
      // 열려 있는 자리가 둘이면 `pendingApproach`가 하나만 돌려주므로 장부를 직접 본다
      const pending = (state.approaches ?? []).filter((a) => a.status === "pending").length;
      if (pending > 1) concurrent += 1;
    }

    for (let i = 0; i < ADVANCE_LIMIT; i++) {
      const advanced = advanceTime(state, { days: 1 });
      sample();
      if (advanced.stopped === "matchday") {
        playMockMatch(state);
        sample();
      }
      if (advanced.stopped === "season_end") {
        // 프리시즌 며칠 — 시즌 리뷰 면담이 서는 창이 여기다
        for (let d = 0; d < REVIEW_TAIL_DAYS; d++) {
          const day = advanceTime(state, { days: 1 });
          if (!day.ok) break;
          sample();
          if (day.stopped === "matchday") {
            playMockMatch(state);
            sample();
          }
        }
        break;
      }
      if (advanced.stopped === "blocked") {
        // 안 치른 경기가 시계를 막으면 그 경기까지 간다 (demotion-grievance와 같은 손잡이)
        const jumped = advanceTime(state, "next_match");
        if (!jumped.ok) break;
        sample();
        if (jumped.stopped === "matchday") {
          playMockMatch(state);
          sample();
        }
      }
    }

    const opened = [...seen.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    const byChannel = (channel: Approach["channel"]) =>
      opened.filter((a) => a.channel === channel).length;

    /** 같은 화자가 쿨다운 안에 다시 왔는가 */
    let cooldownBreaks = 0;
    const lastSeen = new Map<string, string>();
    for (const approach of opened) {
      const before = lastSeen.get(approach.speakerId);
      if (before && diffDays(before, approach.date) < SPEAKER_COOLDOWN_DAYS) cooldownBreaks += 1;
      lastSeen.set(approach.speakerId, approach.date);
    }

    const byTopic = (topic: Approach["topic"]) => opened.filter((a) => a.topic === topic).length;

    /** 키가 `선수:사유:날짜`라 가운데 칸이 사유다 — 사유 코드에는 `:`가 없다 */
    const byReason = (reason: TransferRequestReason) =>
      [...requests].filter((key) => key.split(":")[1] === reason).length;

    const readings: Readings<typeof APPROACH_RATE> = {
      "시즌 다가옴 건수": opened.length,
      "선수 채널": byChannel("player"),
      "에이전트 채널": byChannel("agent"),
      "주장 채널": byChannel("captain"),
      "구단주 채널": byChannel("owner"),
      "시즌 리뷰 자리": byTopic("season-review"),
      "출전 기회(minutes)": byTopic("minutes"),
      "어긴 약속(promise)": byTopic("promise"),
      "등번호(number)": byTopic("number"),
      "계약 만료(contract)": byTopic("contract"),
      "타 구단 관심(interest)": byTopic("interest"),
      "언론 유출(계단 4)": leaks.size,
      "이적 요청(계단 5)": opened.filter((a) => a.step === TRANSFER_REQUEST_STEP).length,
      "이적 요청(장부)": requests.size,
      "요청 사유 grievance": byReason("grievance"),
      "요청 사유 blocked-move": byReason("blocked-move"),
      "요청 사유 bigger-club": byReason("bigger-club"),
      "하루 두 건이 열린 날": [...openedOn.values()].filter((n) => n > 1).length,
      "동시에 열린 자리": concurrent,
      "같은 화자 7일 내 재개": cooldownBreaks,
      "갓 열린 회견과 겹친 자리": withPress,
      "가장 높이 오른 계단": Math.max(0, ...opened.map((a) => a.step)),
      "첫 자리까지 걸린 날": opened[0] ? diffDays(start, opened[0].date) : Number.NaN,
      /**
       * **관계는 되먹임이다** (people.md §6) — 답하지 않은 자리마다 사이가 내려가고,
       * 사이가 내려가면 압력이 빨리 쌓여 자리가 더 자주 열린다. 그 고리가 눈덩이가
       * 되는지는 시즌을 굴려야만 보인다.
       */
      "사이가 상한 선수": sourPlayers(state).length,
      "가장 낮은 관계 점수": lowestRelation(state),
      "관계 줄": (state.relations ?? []).length,
    };
    console.log(
      reportOf(
        APPROACH_RATE,
        readings,
        `시드 42 · ${start} ~ ${state.date} (${diffDays(start, addDays(state.date, 0))}일)`,
      ),
    );
    expect(outOfBand(APPROACH_RATE, readings)).toEqual([]);
  });
});
