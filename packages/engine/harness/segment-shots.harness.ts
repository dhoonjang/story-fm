import { describe, expect, it } from "vitest";
import { DEFAULT_TACTICS, type MatchStatLine, type StrengthPacket } from "@story-fm/domain";
import {
  advanceClock,
  applyEvents,
  buildStrengthPacket,
  createLedger,
  simulateSegment,
  type MatchLedgerState,
  type SideInput,
} from "@story-fm/sim";
import { makeRng, simSquadOf, type SimSquad } from "@story-fm/engine";
import { createTestGame } from "../test/helpers";
import { SEGMENT_SHOTS } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * **패킷이 슈팅 총량의 원본인가** — 구간 시뮬을 경기 하나씩 이어 굴려 잰다.
 *
 * 발생률은 패킷의 선수×경로 기대 슈팅을 `/90`으로 나눈 값이라(match.md §1.4), 90분을
 * 정확히 한 번 굴리면 실측 슈팅이 그 기대치로 모여야 한다. 정지점에서 연속 시계가
 * 장부의 정수 분으로 되감기면 같은 시간이 두 번 굴려져 총량이 부푼다 — 감독이 멈춰
 * 선 횟수가 곧 경기의 슈팅 수가 되는 것이다.
 *
 * 그래서 **끊는 횟수를 바꿔 두 번 잰다**: 정지점까지 가는 보통의 진행과, 5분마다
 * 끊어 구간을 서너 배로 쪼갠 진행. 두 값이 같은 자리에 서야 시계가 이어져 있다.
 *
 *   pnpm balance segment-shots
 */

/** 한 팔에 굴리는 경기 수 — 경기당 ~24슛이라 1σ ≈ 0.7%, 밴드(±1.5%)의 절반이다 */
const MATCHES = 800;
/** 잘게 끊는 쪽의 구간 길이 — 90분이 스무 구간 넘게 쪼개진다 */
const CHOP = 5;

interface Tally {
  shots: number;
  goals: number;
  xg: number;
  cards: number;
  segments: number;
}

function sideOf(squad: SimSquad, teamName: string): SideInput {
  return {
    teamId: squad.teamId,
    teamName,
    starters: squad.slots ?? [],
    bench: [],
    tactics: squad.tactics ?? DEFAULT_TACTICS,
    managerTactics: squad.managerTactics ?? 65,
  };
}

/**
 * 한 경기를 끝까지 굴린다 — **패킷은 고정이다.**
 *
 * 실제 진행(`advanceSegment`)은 구간마다 패킷을 다시 세워 피로·교체를 반영하지만,
 * 여기서 재는 것은 "패킷 하나가 90분에 몇 개를 내는가"라 그 움직임을 빼야 한다.
 */
function playMatch(
  packet: StrengthPacket,
  squads: Parameters<typeof simulateSegment>[0]["squads"],
  fresh: MatchLedgerState,
  seed: number,
  maxMinutes?: number,
): Tally {
  const tally: Tally = { shots: 0, goals: 0, xg: 0, cards: 0, segments: 0 };
  let ledger = fresh;
  let clock: number | undefined;
  for (let segment = 0; segment < 200 && ledger.phase !== "finished"; segment++) {
    const plan = simulateSegment({
      packet,
      ledger,
      squads,
      tactics: { home: DEFAULT_TACTICS, away: DEFAULT_TACTICS },
      ...(maxMinutes !== undefined ? { maxMinutes } : {}),
      ...(clock !== undefined ? { clock } : {}),
      rng: makeRng(seed, `segment-shots:${segment}`),
    });
    tally.segments += 1;
    clock = plan.clock;
    for (const line of Object.values(plan.stats) as MatchStatLine[]) tally.xg += line.xg;
    // 짧게 부른 구간은 빈 배치로 끝날 수 있다 — 장부가 반려하므로 시계만 민다
    if (plan.events.length === 0) {
      ledger = advanceClock(ledger, plan.minute);
      continue;
    }
    const applied = applyEvents(ledger, plan.events);
    if (!applied.ok) throw new Error(`구간 ${segment} 반려: ${applied.errors.join(" / ")}`);
    ledger = applied.state;
  }
  for (const event of ledger.events) {
    if (event.type === "shot" || event.type === "goal") tally.shots += 1;
    if (event.type === "goal") tally.goals += 1;
    if (event.type === "yellow_card" || event.type === "red_card") tally.cards += 1;
  }
  return tally;
}

describe("구간 시뮬 — 슈팅 총량의 원본은 패킷이다", () => {
  it("끊는 횟수가 총량을 바꾸지 않는다", () => {
    const state = createTestGame(11);
    const home = simSquadOf(state, "chelsea");
    const away = simSquadOf(state, "liverpool");
    const packet = buildStrengthPacket(sideOf(home, "Chelsea"), sideOf(away, "Liverpool"));
    const expected =
      (packet.guide.expectedShots?.home ?? 0) + (packet.guide.expectedShots?.away ?? 0);
    const squads = {
      home: { onPitch: home.starters, bench: home.bench ?? [] },
      away: { onPitch: away.starters, bench: away.bench ?? [] },
    };
    const ids = (squad: SimSquad) => ({
      onPitch: squad.starters.map((p) => p.id),
      bench: (squad.bench ?? []).map((p) => p.id),
    });
    // 장부는 불변이라(`applyEvents`가 복제한다) 한 번 세워 두고 나눠 쓴다
    const fresh = createLedger(ids(home), ids(away));

    const runArm = (maxMinutes?: number): Tally => {
      const sum: Tally = { shots: 0, goals: 0, xg: 0, cards: 0, segments: 0 };
      for (let m = 0; m < MATCHES; m++) {
        const one = playMatch(packet, squads, fresh, 7000 + m, maxMinutes);
        sum.shots += one.shots;
        sum.goals += one.goals;
        sum.xg += one.xg;
        sum.cards += one.cards;
        sum.segments += one.segments;
      }
      return sum;
    };
    const open = runArm();
    const chopped = runArm(CHOP);

    const readings: Readings<typeof SEGMENT_SHOTS> = {
      "패킷 기대 슈팅": expected,
      "경기당 슈팅": open.shots / MATCHES,
      "패킷 대비 배율": open.shots / MATCHES / expected,
      "5분씩 끊었을 때 배율": chopped.shots / MATCHES / expected,
      "경기당 구간 수": open.segments / MATCHES,
      "경기당 득점": open.goals / MATCHES,
      "경기당 기회 xG": open.xg / MATCHES,
      "경기당 카드": open.cards / MATCHES,
    };
    console.log(
      reportOf(
        SEGMENT_SHOTS,
        readings,
        `구간 시뮬 ${MATCHES}경기 × 2 (정지점 · ${CHOP}분) · 첼시 vs 리버풀`,
      ),
    );
    expect(outOfBand(SEGMENT_SHOTS, readings)).toEqual([]);
  });
});
