import type {
  EdgeSide,
  EdgeSize,
  Matchup,
  MatchupZone,
  Player,
  PositionGroup,
  SidePacket,
  StrengthPacket,
  TacticsSpec,
  ZoneStrength,
} from "@story-fm/domain";
import { positionGroupOf, positionGroupOfPlayer, roleFit } from "@story-fm/domain";
import { stateModifier } from "./state-modifier";

/** 배치된 선수 — 전술 배치(TACTIC_ASSIGNMENT)에서 조립해 넘긴다 */
export interface LineupSlot {
  player: Player;
  /** 이 경기에서 맡는 포지션 (주 포지션과 다를 수 있다) */
  position: string;
  /** 그 포지션 적응도 0~99 — 낯선 자리면 기여가 깎인다 */
  proficiency: number;
}

export interface SideInput {
  teamId: string;
  teamName: string;
  /** 선발 11 — 이미 부상·정지 필터를 거친 상태 */
  starters: LineupSlot[];
  bench: LineupSlot[];
  tactics: TacticsSpec;
  /** 감독 전술 능력치 (0~99) → 전술 소화율 (attribute-model.md §7) */
  managerTactics: number;
  /** 선수단 전술 적응도 팩터 (0~1, 기본 1) — 낮으면 전력이 소폭 깎인다 */
  familiarity?: number;
}

/**
 * 존 기여 점수 — **맡은 자리의 가중치**로 계산한 15축 가중합 × 상태 보정.
 * 포지션군별 하드코딩 공식이 아니라 POSITION_WEIGHTS(도메인) 하나에서 나온다
 * (attribute-model.md §2 — overall·roleFit·존 점수의 단일 소스).
 */
function zoneScore(p: Player, position: string): number {
  return roleFit(p.attributes, position) * stateModifier(p.state);
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** 배치 포지션 → 존 그룹. 선수의 주 포지션이 아니라 "맡은 자리"가 기준이다 */
function slotGroup(slot: LineupSlot): PositionGroup {
  return positionGroupOf(slot.position) ?? positionGroupOfPlayer(slot.player);
}

/** 포지션 적응도 팩터 — 90+ 온전, 낮으면 최대 12%까지 깎인다 */
function profFactor(proficiency: number): number {
  return 0.88 + Math.min(1, Math.max(0, proficiency) / 90) * 0.12;
}

/** 전술 소화율 — 같은 지시도 감독에 따라 팀에 스며드는 정도가 다르다 (0.92~1.08) */
export function tacticalFit(managerTactics: number): number {
  return round2(0.92 + (managerTactics / 99) * 0.16);
}

function buildZones(slots: LineupSlot[], tactics: TacticsSpec, fit: number): ZoneStrength {
  const scoreOf = (s: LineupSlot) => zoneScore(s.player, s.position) * profFactor(s.proficiency);
  const inGroup = (g: PositionGroup) => slots.filter((s) => slotGroup(s) === g).map(scoreOf);
  const gk = inGroup("GK");
  const df = inGroup("DF");
  const mf = inGroup("MF");
  const fw = inGroup("FW");

  // mentality가 공수 무게를, pressing이 중원 강도를 옮긴다 (초안 계수 — balance.md)
  const mentalityShift = (tactics.mentality - 3) * 0.03;
  const pressingBoost = (tactics.pressing - 3) * 0.02;

  const attack = mean(fw) * (1 + mentalityShift) * fit;
  const midfield = mean(mf) * (1 + pressingBoost) * fit;
  const defense = (mean(df) * 0.85 + mean(gk) * 0.15) * (1 - mentalityShift) * fit;

  return { attack: round2(attack), midfield: round2(midfield), defense: round2(defense) };
}

function edgeOf(ratio: number): { edge: EdgeSide; size: EdgeSize } {
  const abs = ratio >= 1 ? ratio : 1 / ratio;
  const size: EdgeSize = abs >= 1.1 ? "big" : abs >= 1.04 ? "clear" : "slight";
  const edge: EdgeSide = abs < 1.015 ? "even" : ratio > 1 ? "home" : "away";
  return { edge, size };
}

const SIZE_KO: Record<EdgeSize, string> = {
  slight: "근소한",
  clear: "뚜렷한",
  big: "압도적인",
};

function matchupLine(zone: MatchupZone, edge: EdgeSide, size: EdgeSize, h: string, a: string) {
  const zoneKo = zone === "attack" ? "홈 공격 vs 어웨이 수비" : zone === "defense" ? "어웨이 공격 vs 홈 수비" : "중원";
  if (edge === "even") return `${zoneKo}: 팽팽하다 (${h} vs ${a})`;
  const side = edge === "home" ? "홈" : "어웨이";
  return `${zoneKo}: ${side}의 ${SIZE_KO[size]} 우위 (${h} vs ${a})`;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function roster(slots: LineupSlot[]) {
  return slots.map((s) => ({ id: s.player.id, name: s.player.name, position: s.position }));
}

function keyPoints(homeXI: LineupSlot[], awayXI: LineupSlot[]): string[] {
  const points: string[] = [];
  const fastestFw = (xi: LineupSlot[]) =>
    xi.filter((s) => slotGroup(s) === "FW").sort((x, y) => y.player.attributes.pace - x.player.attributes.pace)[0]?.player;
  const slowestDf = (xi: LineupSlot[]) =>
    xi.filter((s) => slotGroup(s) === "DF").sort((x, y) => x.player.attributes.pace - y.player.attributes.pace)[0]?.player;

  const pairs: Array<[LineupSlot[], LineupSlot[], string]> = [
    [homeXI, awayXI, "홈"],
    [awayXI, homeXI, "어웨이"],
  ];
  for (const [atkXI, defXI, label] of pairs) {
    const fw = fastestFw(atkXI);
    const df = slowestDf(defXI);
    if (fw && df && fw.attributes.pace - df.attributes.pace >= 10) {
      points.push(
        `${label} 측면 스피드 미스매치: ${fw.name}(pace ${fw.attributes.pace}) vs ${df.name}(pace ${df.attributes.pace})`,
      );
    }
  }
  return points;
}

/**
 * 전력 분석 패킷 생성 — 결정적 순수 함수. 같은 입력이면 항상 같은 패킷.
 * LLM(매치 티어)의 유일한 판단 근거가 된다 (match-sim.md §1).
 */
export function buildStrengthPacket(homeIn: SideInput, awayIn: SideInput): StrengthPacket {
  const homeFit = tacticalFit(homeIn.managerTactics);
  const awayFit = tacticalFit(awayIn.managerTactics);

  // 전술 적응도가 낮으면 존 전력이 소폭 깎인다 (소화율 fit에 팩터로 합성)
  const homeZoneFit = homeFit * (homeIn.familiarity ?? 1);
  const awayZoneFit = awayFit * (awayIn.familiarity ?? 1);
  const homeXI = homeIn.starters;
  const awayXI = awayIn.starters;

  const home: SidePacket = {
    teamId: homeIn.teamId,
    teamName: homeIn.teamName,
    zones: buildZones(homeXI, homeIn.tactics, homeZoneFit),
    tacticalFit: homeFit,
    lineup: roster(homeIn.starters),
    bench: roster(homeIn.bench),
  };
  const away: SidePacket = {
    teamId: awayIn.teamId,
    teamName: awayIn.teamName,
    zones: buildZones(awayXI, awayIn.tactics, awayZoneFit),
    tacticalFit: awayFit,
    lineup: roster(awayIn.starters),
    bench: roster(awayIn.bench),
  };

  const zonesDef: Array<[MatchupZone, number, number]> = [
    ["attack", home.zones.attack, away.zones.defense],
    ["midfield", home.zones.midfield, away.zones.midfield],
    ["defense", away.zones.attack, home.zones.defense],
  ];
  const matchups: Matchup[] = zonesDef.map(([zone, hv, av]) => {
    // 홈 관점 ratio: >1 이면 홈 우위. defense 존은 (홈 수비 av) / (어웨이 공격 hv)
    const homePerspective = zone === "defense" ? av / hv : hv / av;
    const { edge, size } = edgeOf(homePerspective);
    return {
      zone,
      edge,
      size,
      why: matchupLine(zone, edge, size, String(round2(hv)), String(round2(av))),
    };
  });

  // 기대 득점 — 공격/수비 비율의 멱함수 매핑 (초안, 분포 하네스로 보정)
  const xg = (atk: number, def: number) =>
    round2(Math.min(3.4, Math.max(0.3, 1.35 * Math.pow(atk / def, 1.6))));
  const expectedGoals = {
    home: xg(home.zones.attack, away.zones.defense),
    away: xg(away.zones.attack, home.zones.defense),
  };

  const overallGap =
    Math.abs(
      home.zones.attack + home.zones.midfield + home.zones.defense -
        (away.zones.attack + away.zones.midfield + away.zones.defense),
    ) / 3;
  const upsetChance = round2(Math.min(0.45, Math.max(0.05, 0.35 - overallGap * 0.01)));

  const xgGap = expectedGoals.home - expectedGoals.away;
  const verdict =
    Math.abs(xgGap) < 0.15
      ? "박빙 판세"
      : `${xgGap > 0 ? home.teamName : away.teamName} 우세 판세`;
  const summary =
    `${home.teamName}(홈) vs ${away.teamName}. ` +
    matchups.map((m) => m.why).join(" / ") +
    ` — 기대 득점 ${expectedGoals.home} : ${expectedGoals.away}, ${verdict}.`;

  return { home, away, matchups, keyPoints: keyPoints(homeXI, awayXI), guide: { expectedGoals, upsetChance }, summary };
}
