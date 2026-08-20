import { describe, expect, it } from "vitest";
import { DEFAULT_TACTICS, type StrengthPacket } from "@story-fm/domain";
import {
  advanceClock,
  applyEvents,
  buildStrengthPacket,
  createLedger,
  matchIntensity,
  simulateSegment,
  teamCardRate,
  teamInjuryRate,
  type MatchLedgerState,
  type SideInput,
} from "@story-fm/sim";
import { makeRng, playersOf, quickSimulate, simSquadOf, type SimSquad } from "@story-fm/engine";
import { createTestGame } from "../test/helpers";
import { INJURY_RATE } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * **두 시뮬이 같은 눈금으로 카드와 부상을 내는가** — 같은 두 팀을 간이 시뮬과
 * 구간 시뮬로 나란히 굴려 잰다 (match.md §7).
 *
 * 눈금이 갈리면 리그의 절반이 다른 규칙으로 돈다: 압박이 센 상대와 붙는 우리
 * 경기만 카드가 늘고, 같은 팀이 남의 경기에서는 강도 1로 산다. 그 어긋남은
 * **한 시즌으로는 안 보인다** — 감독의 리그 38경기에 실리는 카드는 130장뿐이라
 * 20%의 차이가 표본 잡음에 묻힌다(`world-season`이 그 갈래를 찍기만 하고
 * 판정하지 않는 이유다). 그래서 판정은 여기서, 표본을 키워서 한다.
 *
 * 성향이 값으로 어떻게 움직이는지(오름·내림·상하한·균형식)는
 * `packages/engine/test/injury.test.ts`가 결정적으로 못 박고 있다.
 *
 *   pnpm balance injury-rate
 */

/** 한 경기의 온필드 인원 (양팀) — 경기당 기대 건수를 개인 확률로 나눌 때의 분모 */
const ON_PITCH = 22;

/** 유리몸 성향 — 상한 근처의 값 하나로 "성향이 빈도에 닿는가"만 본다 */
const GLASS = 2.2;

/**
 * 팔마다 굴리는 경기 수 — **부상이 분모를 정한다.**
 *
 * 경기당 0.1건이라 12,000경기라야 1,300건이고 상대 표준편차가 2.8%, 두 팔의
 * 비로는 4%다. 4,000판에서는 그 잡음이 7%라 두 팔이 우연히 20% 벌어지는 것을
 * 봤다 — 밴드로 걸 수 없는 값이었다. 카드는 같은 표본에서 45,000장이라 0.5%로
 * 선다. 두 팔의 경기 수는 같아야 하므로 그 수를 여기 한 번만 적는다.
 */
const MATCHES = 12000;

const HOME = "chelsea";
const AWAY = "liverpool";

interface Tally {
  cards: number;
  injuries: number;
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
 * **성향을 1로 눕힌 스쿼드** — 두 시뮬을 나란히 세울 때 쓴다.
 *
 * 부상 기대치는 성향 평균을 타는데(`teamInjuryRate`) 그 평균을 세는 명단이
 * 양쪽에서 다르다: 간이 쪽은 뛴 선수 전원(선발 + 투입된 교체), 구간 쪽은 온필드
 * 열한 명이다. 성향을 살려 두면 그 명단 차이가 비에 그대로 실려 **눈금이 갈린 것**
 * 처럼 보인다 — 실제로 잰 값은 16%였다. 성향이 빈도에 닿는지는 아래 유리몸
 * 두 지표가 따로 재므로, 여기서는 눕히고 발생률만 본다.
 */
function flat(squad: SimSquad): SimSquad {
  return { ...squad, proneness: {} };
}

function quickArm(home: SimSquad, away: SimSquad, runs: number, channel: string): Tally {
  const tally: Tally = { cards: 0, injuries: 0 };
  for (let i = 0; i < runs; i++) {
    const one = quickSimulate(home, away, 2000 + i, `${channel}:${i}`);
    tally.cards += one.cards.length;
    tally.injuries += one.injuries.length;
  }
  return tally;
}

/**
 * 구간 시뮬로 90분을 끝까지 굴린다 — **패킷은 고정이다.**
 *
 * 실제 진행(`advanceSegment`)은 구간마다 패킷을 다시 세우지만, 여기서 재는 것은
 * "같은 발생률이 90분에 몇 건을 내는가"라 그 움직임을 빼야 한다
 * (`segment-shots` 하네스와 같은 이유·같은 모양).
 */
function playSegments(
  packet: StrengthPacket,
  squads: Parameters<typeof simulateSegment>[0]["squads"],
  tactics: Parameters<typeof simulateSegment>[0]["tactics"],
  proneness: Record<string, number>,
  fresh: MatchLedgerState,
  seed: number,
): Tally {
  let ledger = fresh;
  let clock: number | undefined;
  for (let segment = 0; segment < 200 && ledger.phase !== "finished"; segment++) {
    const plan = simulateSegment({
      packet,
      ledger,
      squads,
      tactics,
      proneness,
      ...(clock !== undefined ? { clock } : {}),
      rng: makeRng(seed, `injury-rate:${segment}`),
    });
    clock = plan.clock;
    if (plan.events.length === 0) {
      ledger = advanceClock(ledger, plan.minute);
      continue;
    }
    const applied = applyEvents(ledger, plan.events);
    if (!applied.ok) throw new Error(`구간 ${segment} 반려: ${applied.errors.join(" / ")}`);
    ledger = applied.state;
  }
  const tally: Tally = { cards: 0, injuries: 0 };
  for (const event of ledger.events) {
    if (event.type === "yellow_card" || event.type === "red_card") tally.cards += 1;
    if (event.type === "injury") tally.injuries += 1;
  }
  return tally;
}

function segmentArm(home: SimSquad, away: SimSquad, runs: number): Tally {
  const packet = buildStrengthPacket(sideOf(home, "Chelsea"), sideOf(away, "Liverpool"));
  const squads = {
    home: { onPitch: home.starters, bench: home.bench ?? [] },
    away: { onPitch: away.starters, bench: away.bench ?? [] },
  };
  const tactics = {
    home: home.tactics ?? DEFAULT_TACTICS,
    away: away.tactics ?? DEFAULT_TACTICS,
  };
  // 성향은 **양쪽 팔에 같은 지도**로 들어간다 (`flat`이면 양쪽 다 빈 지도 = 전원 1)
  const proneness = { ...(home.proneness ?? {}), ...(away.proneness ?? {}) };
  const ids = (squad: SimSquad) => ({
    onPitch: squad.starters.map((p) => p.id),
    bench: (squad.bench ?? []).map((p) => p.id),
  });
  // 장부는 불변이라(`applyEvents`가 복제한다) 한 번 세워 두고 나눠 쓴다
  const fresh = createLedger(ids(home), ids(away));

  const tally: Tally = { cards: 0, injuries: 0 };
  for (let i = 0; i < runs; i++) {
    const one = playSegments(packet, squads, tactics, proneness, fresh, 8000 + i);
    tally.cards += one.cards;
    tally.injuries += one.injuries;
  }
  return tally;
}

describe("간이 시뮬과 구간 시뮬은 같은 눈금으로 카드와 부상을 낸다", () => {
  it("경기당 건수 · 두 시뮬의 비 · 성향이 닿는 폭", () => {
    const state = createTestGame(11);
    const home = simSquadOf(state, HOME);
    const away = simSquadOf(state, AWAY);
    const intensity = {
      home: matchIntensity(home.tactics ?? DEFAULT_TACTICS),
      away: matchIntensity(away.tactics ?? DEFAULT_TACTICS),
    };
    /**
     * 기대치는 **손잡이에서 유도한다** — 눈금을 조정해도 하네스가 따라온다.
     * 성향은 두 팔 모두 1이므로(`flat`) 강도만 실린다.
     */
    const expected = {
      cards: teamCardRate(intensity.home) + teamCardRate(intensity.away),
      injuries: teamInjuryRate(intensity.home) + teamInjuryRate(intensity.away),
    };

    const quick = quickArm(flat(home), flat(away), MATCHES, "rate");
    const segment = segmentArm(flat(home), flat(away), MATCHES);

    // 유리몸 두 지표는 성향을 살린 세계에서 잰다 — 기준선도 같은 세계여야 한다
    const healthy = quickArm(home, away, MATCHES, "healthy");
    const fragileState = createTestGame(11);
    for (const p of playersOf(fragileState, HOME)) p.state.injuryProneness = GLASS;
    const fragile = quickArm(
      simSquadOf(fragileState, HOME),
      simSquadOf(fragileState, AWAY),
      MATCHES,
      "healthy",
    );

    const shareState = createTestGame(11);
    const glass = simSquadOf(shareState, HOME).starters[3]!;
    glass.state.injuryProneness = GLASS;
    const shareHome = simSquadOf(shareState, HOME);
    const shareAway = simSquadOf(shareState, AWAY);
    let hisShare = 0;
    let homeInjuries = 0;
    for (let i = 0; i < MATCHES; i++) {
      const r = quickSimulate(shareHome, shareAway, 5000 + i, `share:${i}`);
      for (const tag of r.injuries) {
        if (!tag.startsWith("home:")) continue;
        homeInjuries++;
        if (tag === `home:${glass.id}`) hisShare++;
      }
    }

    const per = (n: number) => n / MATCHES;
    const readings: Readings<typeof INJURY_RATE> = {
      "경기 강도 (양 팀 평균)": (intensity.home + intensity.away) / 2,
      "경기당 부상 건수 (간이)": per(quick.injuries),
      "경기당 부상 건수 (구간)": per(segment.injuries),
      "부상 기대 대비 배율 (간이)": per(quick.injuries) / expected.injuries,
      "부상 기대 대비 배율 (구간)": per(segment.injuries) / expected.injuries,
      "부상 — 간이/구간": quick.injuries / Math.max(1, segment.injuries),
      "경기당 카드 (간이)": per(quick.cards),
      "경기당 카드 (구간)": per(segment.cards),
      "카드 기대 대비 배율 (간이)": per(quick.cards) / expected.cards,
      "카드 기대 대비 배율 (구간)": per(segment.cards) / expected.cards,
      "카드 — 간이/구간": quick.cards / Math.max(1, segment.cards),
      "유리몸 팀 배율": fragile.injuries / Math.max(1, healthy.injuries),
      "유리몸 한 명의 부상 점유율": hisShare / Math.max(1, homeInjuries),
    };
    console.log(
      reportOf(
        INJURY_RATE,
        readings,
        `${HOME} vs ${AWAY} · 간이 ${(MATCHES * 4).toLocaleString()}판 · 구간 ${MATCHES.toLocaleString()}판 · 기대 부상 ${expected.injuries.toFixed(3)}건 · 기대 카드 ${expected.cards.toFixed(2)}장 (개인 확률 ${(expected.injuries / ON_PITCH).toFixed(4)})`,
      ),
    );
    expect(outOfBand(INJURY_RATE, readings)).toEqual([]);
  });
});
