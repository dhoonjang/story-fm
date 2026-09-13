import { describe, expect, it } from "vitest";
import { DEFAULT_TACTICS, type EdgeSize, type Matchup } from "@story-fm/domain";
import { buildStrengthPacket, type SideInput } from "@story-fm/sim";
import { isTopLeague, simSquadOf, type SimSquad } from "@story-fm/engine";
import { createTestGame } from "../test/helpers";
import { ZONE_BASELINE } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * **매치업 비율의 기준선이 1에 서 있는가** — 세계 하나의 리그 편성을 전부 킥오프
 * 패킷으로 세워 `우리 공격 / 상대 수비`를 잰다 (match.md §1.1).
 *
 * 세 존은 서로 다른 가중치(`ZONE_CONTRIBUTION`)로 만든 값이고, 그 위에 전술 6축과
 * 공략이 **구조적으로 공격 쪽에** 얹힌다. `ZONE_BASELINE`이 그 층의 리그 평균을
 * 상쇄해 비율이 1에 서게 하는데, 그 값은 실측에 묶여 있어 프리셋·공략 크기·역할
 * 가중치를 만질 때마다 다시 재야 한다. 재는 자리가 없으면 한 번 어긋난 채로 살고,
 * 그동안 판세는 어느 팀이든 「공격하는 쪽이 우위」로 기운다.
 *
 * **기하평균으로 읽는다.** 보정은 곱으로 얹히므로(`ZONE_BASELINE` 두 값의 곱이 1)
 * 산술평균은 비율의 꼬리에 끌려 1 위로 뜬다 — `a/b`와 `b/a`의 산술평균은 둘 다 1을
 * 넘는다. 기하평균은 두 방향이 정확히 서로의 역수라 기준선 1이 뜻을 갖는다.
 *
 * 같은 편성을 **층을 하나씩 끄고** 세 번 더 세운다 — 공략만, 전술만, 둘 다. 기준선과의
 * 간격이 곧 그 층의 크기라, 다음에 이 값을 옮길 사람이 무엇이 자랐는지 읽을 수 있다.
 *
 * 같은 패킷의 세 매치업 등급도 함께 센다 — 기준선이 기울면 「압도적」의 문턱이
 * 기본값 코앞에 서서 세 단계가 한 단계로 무너진다.
 *
 *   pnpm balance zone-baseline
 */

const SEEDS = [7, 11];

/** AI 벤치가 공략을 걸지 않는 등급 — `autoExploits`의 아래 문턱(58) 밑이면 된다 */
const NO_EXPLOIT_RATING = 50;

interface Layers {
  exploits: boolean;
  tactics: boolean;
}

function sideOf(squad: SimSquad, layers: Layers): SideInput {
  return {
    teamId: squad.teamId,
    teamName: squad.teamId,
    starters: squad.slots ?? [],
    bench: [],
    tactics: layers.tactics ? (squad.tactics ?? DEFAULT_TACTICS) : DEFAULT_TACTICS,
    managerTactics: layers.exploits ? (squad.managerTactics ?? 65) : NO_EXPLOIT_RATING,
  };
}

/** 로그 비율의 합 — 기하평균은 이것을 표본 수로 나눠 지수를 취한 값 */
interface LogMean {
  sum: number;
  n: number;
}

const geo = (m: LogMean) => Math.exp(m.sum / m.n);

interface Tally {
  fixtures: number;
  attack: LogMean;
  midfield: LogMean;
  noExploits: LogMean;
  noTactics: LogMean;
  bare: LogMean;
  /** 세 존 매치업의 등급 — 팽팽은 `edge === "even"`, 나머지는 `size`로 센다 */
  even: number;
  sized: Record<EdgeSize, number>;
  /** 공격·수비 두 존에서 편이 갈린 매치업 중 공격하는 쪽이 우위인 수 */
  attackerFavoured: number;
  defenderFavoured: number;
}

function addRatios(into: LogMean, home: SideInput, away: SideInput): Matchup[] {
  const packet = buildStrengthPacket(home, away);
  const h = packet.home.zones;
  const a = packet.away.zones;
  into.sum += Math.log(h.attack / a.defense) + Math.log(a.attack / h.defense);
  into.n += 2;
  return packet.matchups;
}

function countGrades(tally: Tally, matchups: readonly Matchup[]): void {
  for (const m of matchups) {
    if (m.edge === "even") tally.even += 1;
    else tally.sized[m.size] += 1;
    if (m.zone === "midfield" || m.edge === "even") continue;
    // attack 존은 홈이 공격하는 쪽, defense 존은 어웨이가 공격하는 쪽이다
    const attacker = m.zone === "attack" ? "home" : "away";
    if (m.edge === attacker) tally.attackerFavoured += 1;
    else tally.defenderFavoured += 1;
  }
}

function measure(seed: number, tally: Tally): void {
  const state = createTestGame(seed);
  for (const match of state.matches) {
    if (!isTopLeague(match.competitionId)) continue;
    const home = simSquadOf(state, match.homeTeamId, match.competitionId);
    const away = simSquadOf(state, match.awayTeamId, match.competitionId);
    const build = (layers: Layers) => [sideOf(home, layers), sideOf(away, layers)] as const;
    tally.fixtures += 1;

    const full = build({ exploits: true, tactics: true });
    const packet = buildStrengthPacket(full[0], full[1]);
    tally.attack.sum +=
      Math.log(packet.home.zones.attack / packet.away.zones.defense) +
      Math.log(packet.away.zones.attack / packet.home.zones.defense);
    tally.attack.n += 2;
    tally.midfield.sum += Math.log(packet.home.zones.midfield / packet.away.zones.midfield);
    tally.midfield.n += 1;
    countGrades(tally, packet.matchups);

    addRatios(tally.noExploits, ...build({ exploits: false, tactics: true }));
    addRatios(tally.noTactics, ...build({ exploits: true, tactics: false }));
    addRatios(tally.bare, ...build({ exploits: false, tactics: false }));
  }
}

describe("존 기준선 — 매치업 비율은 1에 선다", () => {
  it(`시드 ${SEEDS.join("·")}의 리그 편성 전부`, () => {
    const tally: Tally = {
      fixtures: 0,
      attack: { sum: 0, n: 0 },
      midfield: { sum: 0, n: 0 },
      noExploits: { sum: 0, n: 0 },
      noTactics: { sum: 0, n: 0 },
      bare: { sum: 0, n: 0 },
      even: 0,
      sized: { slight: 0, clear: 0, big: 0 },
      attackerFavoured: 0,
      defenderFavoured: 0,
    };
    for (const seed of SEEDS) measure(seed, tally);

    const matchups = tally.even + tally.sized.slight + tally.sized.clear + tally.sized.big;
    const decided = tally.attackerFavoured + tally.defenderFavoured;
    const readings: Readings<typeof ZONE_BASELINE> = {
      "편성 경기 수": tally.fixtures,
      "공격/상대 수비 기하평균": geo(tally.attack),
      "홈 중원/어웨이 중원 기하평균": geo(tally.midfield),
      "층 없이 — 공격/상대 수비": geo(tally.bare),
      "공략 없이 — 공격/상대 수비": geo(tally.noExploits),
      "전술 없이 — 공격/상대 수비": geo(tally.noTactics),
      "공격하는 쪽이 우위인 비율": tally.attackerFavoured / decided,
      "팽팽한 매치업 비율": tally.even / matchups,
      "근소한 우위 비율": tally.sized.slight / matchups,
      "뚜렷한 우위 비율": tally.sized.clear / matchups,
      "압도적 우위 비율": tally.sized.big / matchups,
    };
    console.log(
      reportOf(
        ZONE_BASELINE,
        readings,
        `시드 ${SEEDS.join("·")} · 리그 편성 ${tally.fixtures}경기 · 매치업 ${matchups}건`,
      ),
    );
    expect(outOfBand(ZONE_BASELINE, readings)).toEqual([]);
  });
});
