import type {
  EdgeSide,
  EdgeSize,
  Matchup,
  MatchupZone,
  Player,
  SidePacket,
  StrengthPacket,
  TacticsSpec,
  Team,
  ZoneStrength,
} from "@story-fm/domain";
import { stateModifier } from "./state-modifier";

export interface SideInput {
  team: Team;
  tactics: TacticsSpec;
  /** 감독 전술 능력치 (0~99) → 전술 소화율 (attribute-model.md §7) */
  managerTactics: number;
}

/** 포지션 그룹별 존 기여 점수 — 유효 능력치의 가중합 */
function zoneScore(p: Player): number {
  const m = stateModifier(p.state);
  const a = p.attributes;
  switch (p.positionGroup) {
    case "GK":
      return (a.goalkeeping ?? a.overall) * m;
    case "DF":
      return (a.defending * 0.5 + a.physical * 0.25 + a.pace * 0.25) * m;
    case "MF":
      return (a.passing * 0.4 + a.dribbling * 0.2 + a.physical * 0.2 + a.defending * 0.2) * m;
    case "FW":
      return (a.shooting * 0.35 + a.pace * 0.3 + a.dribbling * 0.25 + a.physical * 0.1) * m;
  }
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

function starters(team: Team): Player[] {
  const byId = new Map(team.players.map((p) => [p.id, p]));
  return team.startingXI.flatMap((id) => {
    const p = byId.get(id);
    return p ? [p] : [];
  });
}

/** 전술 소화율 — 같은 지시도 감독에 따라 팀에 스며드는 정도가 다르다 (0.92~1.08) */
export function tacticalFit(managerTactics: number): number {
  return round2(0.92 + (managerTactics / 99) * 0.16);
}

function buildZones(players: Player[], tactics: TacticsSpec, fit: number): ZoneStrength {
  const gk = players.filter((p) => p.positionGroup === "GK");
  const df = players.filter((p) => p.positionGroup === "DF");
  const mf = players.filter((p) => p.positionGroup === "MF");
  const fw = players.filter((p) => p.positionGroup === "FW");

  // mentality가 공수 무게를, pressing이 중원 강도를 옮긴다 (초안 계수 — balance.md)
  const mentalityShift = (tactics.mentality - 3) * 0.03;
  const pressingBoost = (tactics.pressing - 3) * 0.02;

  const attack = mean(fw.map(zoneScore)) * (1 + mentalityShift) * fit;
  const midfield = mean(mf.map(zoneScore)) * (1 + pressingBoost) * fit;
  const defense =
    (mean(df.map(zoneScore)) * 0.85 + mean(gk.map(zoneScore)) * 0.15) * (1 - mentalityShift) * fit;

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

function roster(team: Team, ids: string[]) {
  const byId = new Map(team.players.map((p) => [p.id, p]));
  return ids.flatMap((id) => {
    const p = byId.get(id);
    return p ? [{ id: p.id, name: p.name, position: p.position }] : [];
  });
}

function keyPoints(home: Team, away: Team): string[] {
  const points: string[] = [];
  const fastestFw = (t: Team) =>
    starters(t)
      .filter((p) => p.positionGroup === "FW")
      .sort((x, y) => y.attributes.pace - x.attributes.pace)[0];
  const slowestDf = (t: Team) =>
    starters(t)
      .filter((p) => p.positionGroup === "DF")
      .sort((x, y) => x.attributes.pace - y.attributes.pace)[0];

  const pairs: Array<[Team, Team, string]> = [
    [home, away, "홈"],
    [away, home, "어웨이"],
  ];
  for (const [atkTeam, defTeam, label] of pairs) {
    const fw = fastestFw(atkTeam);
    const df = slowestDf(defTeam);
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

  const home: SidePacket = {
    teamId: homeIn.team.id,
    teamName: homeIn.team.name,
    zones: buildZones(starters(homeIn.team), homeIn.tactics, homeFit),
    tacticalFit: homeFit,
    lineup: roster(homeIn.team, homeIn.team.startingXI),
    bench: roster(homeIn.team, homeIn.team.bench),
  };
  const away: SidePacket = {
    teamId: awayIn.team.id,
    teamName: awayIn.team.name,
    zones: buildZones(starters(awayIn.team), awayIn.tactics, awayFit),
    tacticalFit: awayFit,
    lineup: roster(awayIn.team, awayIn.team.startingXI),
    bench: roster(awayIn.team, awayIn.team.bench),
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

  return { home, away, matchups, keyPoints: keyPoints(homeIn.team, awayIn.team), guide: { expectedGoals, upsetChance }, summary };
}
