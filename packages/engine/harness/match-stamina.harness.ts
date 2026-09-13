import { describe, expect, it } from "vitest";
import {
  CONDITION_MAX,
  DEFAULT_TACTICS,
  TACTIC_SCALE_MAX,
  type Player,
  type TacticsSpec,
} from "@story-fm/domain";
import {
  GAP_THRESHOLD,
  advanceClock,
  applyEvents,
  buildStrengthPacket,
  conditionDrain,
  createLedger,
  simulateSegment,
  type MatchLedgerState,
  type SideInput,
} from "@story-fm/sim";
import { leagueOfTeamIn, makeRng, simSquadOf, type SimSquad } from "@story-fm/engine";
import { createTestGame } from "../test/helpers";
import { MATCH_STAMINA } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * **구멍 문턱이 판단의 자리인가, 상수인가** — 풀타임 소모를 두 갈래로 잰다.
 *
 * `GAP_THRESHOLD`(78)를 넘긴 선수는 느려지는 게 아니라 **자리를 지키지 못하고**,
 * 그 라인 전체가 대가를 치른다(`GAP_PENALTY`). 그래서 그 주석은 이 값이 예외로
 * 남아야 한다고 못 박으면서 기준 케이스를 함께 적어 두었다 — 체력 100·기본 전술로
 * 출발한 중앙 미드필더는 **지구력 50이어도 풀타임 뒤 24가 남아** 문턱 밖(22)에
 * 서고, 체력 73 이하로 출발한 지구력 70이 비로소 걸린다.
 *
 * 그 기준 케이스만 재면 규격대로라는 답밖에 나오지 않는다. 문제는 **여유가 2점**
 * 이라는 것이다 — 그래서 두 번째 팔이 실제 스쿼드를 실제 구간 시뮬로 90분 굴려
 * 풀타임에 몇 명이 걸려 있는지 센다. 앞의 팔이 초록인데 뒤가 빨갛다면 소모 계수가
 * 아니라 **문턱의 자리**가 틀린 것이다.
 *
 *   pnpm balance match-stamina
 */

/** 기준 케이스의 자리 — 필드 플레이어 중 소모가 가장 큰 자리다 */
const PIVOT = "CM";
/**
 * **감독이 실제로 내리는 지시** — 압박·템포·라인을 끝까지 올린 판.
 *
 * 기본 전술만 재면 이 게임에서 아무도 서지 않는 자리를 재는 것이다. 「앞에서부터
 * 잡아라」는 감독이 가장 먼저 하는 말이고, `tacticalDrain`의 위끝(1.16)과
 * `positionalTacticWeight`의 압박 가산이 **함께** 얹히는 유일한 자리다.
 */
const HIGH_PRESS: TacticsSpec = {
  ...DEFAULT_TACTICS,
  pressing: TACTIC_SCALE_MAX,
  tempo: TACTIC_SCALE_MAX,
  defensiveLine: TACTIC_SCALE_MAX,
};
/** 실제 팔에 굴리는 경기 수 — 한 경기에 22명이라 표본은 그 배다 */
const MATCHES = 60;

function probe(stamina: number, condition: number): Player {
  return { attributes: { stamina }, state: { condition } } as unknown as Player;
}

/** 풀타임 한 경기 뒤 **남은 체력** — 균형 점유 · 개인 지시 없음 · 흔들림 없음 */
function conditionAfterFullMatch(
  stamina: number,
  condition = CONDITION_MAX,
  spec: TacticsSpec = DEFAULT_TACTICS,
): number {
  return condition - conditionDrain(probe(stamina, condition), PIVOT, spec, 90);
}

/**
 * 이 출발 체력부터 풀타임 뒤 구멍에 걸린다 — 걸리는 **가장 높은** 출발 체력.
 * 총 피로는 `100 - 출발 체력 + 그 경기의 소모`이므로 체력 축에서는 남은 체력이
 * `GAP_CONDITION`(22) 아래로 내려가는 자리와 같다.
 */
function gapEntryCondition(stamina: number): number {
  for (let start = CONDITION_MAX; start >= 0; start -= 1) {
    if (CONDITION_MAX - conditionAfterFullMatch(stamina, start) >= GAP_THRESHOLD) return start;
  }
  return 0;
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

interface Worn {
  /** 풀타임에 구멍 난 선발 수 */
  gassed: number;
  /** 선발 수 */
  players: number;
  /** 구멍이 처음 난 분 — 끝까지 아무도 안 걸리면 90 */
  firstGap: number;
  startCondition: number;
  endCondition: number;
}

/**
 * 한 경기를 끝까지 굴리며 **경기 중 피로를 이어 준다** — 패킷은 고정이다.
 * 재는 것은 소모 곡선이지 교체·재편성이 아니라서, 벤치를 쓰지 않고 열한 명이
 * 90분을 다 뛴 경우를 본다. 감독이 손을 대지 않은 가장 너그러운 경우다.
 */
function playMatch(
  packet: ReturnType<typeof buildStrengthPacket>,
  squads: Parameters<typeof simulateSegment>[0]["squads"],
  fresh: MatchLedgerState,
  seed: number,
  spec: TacticsSpec,
): Worn {
  // 지시를 받는 것은 감독의 팀뿐이다 — 상대는 기본 전술로 선다
  const onPitch = squads.home.onPitch;
  const accumulated: Record<string, number> = {};
  const worn: Worn = {
    gassed: 0,
    players: onPitch.length,
    firstGap: 90,
    startCondition: 0,
    endCondition: 0,
  };
  let ledger = fresh;
  let clock: number | undefined;
  for (let segment = 0; segment < 200 && ledger.phase !== "finished"; segment++) {
    const plan = simulateSegment({
      packet,
      ledger,
      squads,
      tactics: { home: spec, away: DEFAULT_TACTICS },
      accumulatedFatigue: accumulated,
      staminaKey: `match-stamina:${seed}`,
      ...(clock !== undefined ? { clock } : {}),
      rng: makeRng(seed, `match-stamina:${segment}`),
    });
    clock = plan.clock;
    for (const [id, gained] of Object.entries(plan.fatigue)) {
      accumulated[id] = (accumulated[id] ?? 0) + gained;
    }
    if (worn.firstGap === 90) {
      const caught = onPitch.some(
        (p) => CONDITION_MAX - p.state.condition + (accumulated[p.id] ?? 0) >= GAP_THRESHOLD,
      );
      if (caught) worn.firstGap = plan.minute;
    }
    // 짧게 부른 구간은 빈 배치로 끝날 수 있다 — 장부가 반려하므로 시계만 민다
    if (plan.events.length === 0) {
      ledger = advanceClock(ledger, plan.minute);
      continue;
    }
    const applied = applyEvents(ledger, plan.events);
    if (!applied.ok) throw new Error(`구간 ${segment} 반려: ${applied.errors.join(" / ")}`);
    ledger = applied.state;
  }
  for (const p of onPitch) {
    const left = p.state.condition - (accumulated[p.id] ?? 0);
    worn.startCondition += p.state.condition;
    worn.endCondition += left;
    if (CONDITION_MAX - left >= GAP_THRESHOLD) worn.gassed += 1;
  }
  return worn;
}

describe("경기 체력 — 구멍 문턱은 예외의 자리다", () => {
  it("풀타임 뒤에도 문턱 밖에 선다", () => {
    const state = createTestGame(11);
    const home = simSquadOf(state, "chelsea", leagueOfTeamIn(state, "chelsea"));
    const away = simSquadOf(state, "liverpool", leagueOfTeamIn(state, "liverpool"));
    const packet = buildStrengthPacket(sideOf(home, "Chelsea"), sideOf(away, "Liverpool"));
    const squads = {
      home: { onPitch: home.starters, bench: [] },
      away: { onPitch: away.starters, bench: [] },
    };
    const ids = (squad: SimSquad) => ({
      onPitch: squad.starters.map((p) => p.id),
      bench: [] as string[],
    });
    // 장부는 불변이라(`applyEvents`가 복제한다) 한 번 세워 두고 나눠 쓴다
    const fresh = createLedger(ids(home), ids(away));

    const runArm = (spec: TacticsSpec): Worn => {
      const sum: Worn = { gassed: 0, players: 0, firstGap: 0, startCondition: 0, endCondition: 0 };
      for (let m = 0; m < MATCHES; m++) {
        const one = playMatch(packet, squads, fresh, 9100 + m, spec);
        sum.gassed += one.gassed;
        sum.players += one.players;
        sum.firstGap += one.firstGap;
        sum.startCondition += one.startCondition;
        sum.endCondition += one.endCondition;
      }
      return sum;
    };
    const plain = runArm(DEFAULT_TACTICS);
    const pressed = runArm(HIGH_PRESS);

    const readings: Readings<typeof MATCH_STAMINA> = {
      "기준 — 풀타임 뒤 남은 체력 (지구력 50)": conditionAfterFullMatch(50),
      "기준 — 풀타임 뒤 남은 체력 (지구력 70)": conditionAfterFullMatch(70),
      "기준 — 풀타임 뒤 남은 체력 (지구력 90)": conditionAfterFullMatch(90),
      "기준 — 구멍에 걸리는 출발 체력 (지구력 70)": gapEntryCondition(70),
      "기본 — 선발 출발 체력": plain.startCondition / plain.players,
      "기본 — 풀타임 뒤 남은 체력": plain.endCondition / plain.players,
      "기본 — 풀타임에 구멍 난 선발 비율": plain.gassed / plain.players,
      "기본 — 구멍이 처음 난 분": plain.firstGap / MATCHES,
      "고압박 — 기준 풀타임 뒤 남은 체력 (지구력 70)": conditionAfterFullMatch(
        70,
        CONDITION_MAX,
        HIGH_PRESS,
      ),
      "고압박 — 풀타임 뒤 남은 체력": pressed.endCondition / pressed.players,
      "고압박 — 풀타임에 구멍 난 선발 비율": pressed.gassed / pressed.players,
      "고압박 — 구멍이 처음 난 분": pressed.firstGap / MATCHES,
    };
    console.log(reportOf(MATCH_STAMINA, readings, `교체 없음 · 팔당 ${MATCHES}경기`));
    expect(outOfBand(MATCH_STAMINA, readings)).toEqual([]);
  });
});
