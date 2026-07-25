import type { GamePlayer, MatchEvent, StrengthPacket } from "@story-fm/domain";
import { positionGroupOfPlayer } from "@story-fm/domain";
import type { MatchScriptSegment } from "./state";
import { makeRng, randInt } from "./rng";

/** 시뮬 입력 — 라인업은 전술 배치(TACTIC_ASSIGNMENT)에서 조립해 넘긴다 */
export interface SimSquad {
  teamId: string;
  /** 선발 11명 (이미 부상·정지 필터를 거친 상태) */
  starters: GamePlayer[];
}

/**
 * 간이 시뮬 — 타 팀 간 경기(결정 #5)와 mock 캐스터의 경기 스크립트 생성에
 * 쓰는 결정적 확률 모델. 유저 경기의 "진짜" 진행은 LLM(매치 티어)이지만,
 * mock 모드에선 이 스크립트가 사건의 원천이 된다.
 */

function squadStrength(squad: SimSquad): number {
  if (squad.starters.length === 0) return 60;
  return squad.starters.reduce((s, p) => s + p.attributes.overall, 0) / squad.starters.length;
}

/** 포아송 근사 샘플 (역변환) */
function samplePoisson(rng: () => number, lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L && k < 10);
  return k - 1;
}

function pickScorer(rng: () => number, squad: SimSquad): string {
  const candidates = squad.starters.filter((p) => positionGroupOfPlayer(p) !== "GK");
  if (candidates.length === 0) return squad.starters[0]?.id ?? `${squad.teamId}-unknown`;
  const weights = candidates.map((p) =>
    positionGroupOfPlayer(p) === "FW" ? p.attributes.shooting * 3 : p.attributes.shooting,
  );
  const total = weights.reduce((s, w) => s + w, 0);
  let roll = rng() * total;
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i] ?? 0;
    if (roll <= 0) return candidates[i]?.id ?? candidates[0]!.id;
  }
  return candidates[0]!.id;
}

export interface QuickResult {
  homeGoals: number;
  awayGoals: number;
  scorers: string[]; // "home:playerId" | "away:playerId" 순서 무관
}

/** 타 팀 간 경기 결과 — 결과·득점자만 (match-sim.md §7) */
export function quickSimulate(home: SimSquad, away: SimSquad, seed: number, channel: string): QuickResult {
  const rng = makeRng(seed, `quick:${channel}`);
  const sh = squadStrength(home) * 1.06; // 홈 어드밴티지
  const sa = squadStrength(away);
  const lambdaHome = Math.min(3.4, Math.max(0.35, 1.4 * Math.pow(sh / sa, 3)));
  const lambdaAway = Math.min(3.4, Math.max(0.35, 1.25 * Math.pow(sa / sh, 3)));
  const homeGoals = Math.min(6, samplePoisson(rng, lambdaHome));
  const awayGoals = Math.min(6, samplePoisson(rng, lambdaAway));
  const scorers: string[] = [];
  for (let i = 0; i < homeGoals; i++) scorers.push(`home:${pickScorer(rng, home)}`);
  for (let i = 0; i < awayGoals; i++) scorers.push(`away:${pickScorer(rng, away)}`);
  return { homeGoals, awayGoals, scorers };
}

/** 원인 태그 후보 — 패킷 매치업에서 인용 */
function causeFromPacket(packet: StrengthPacket, side: "home" | "away"): string[] {
  const relevant = packet.matchups.find(
    (m) => (side === "home" ? m.zone === "attack" : m.zone === "defense") && m.edge === side,
  );
  if (relevant) return [relevant.why];
  const key = packet.keyPoints.find((k) => k.includes(side === "home" ? "홈" : "어웨이"));
  return key ? [key] : ["중원 주도권 싸움"];
}

/**
 * mock 캐스터용 경기 스크립트 — 정지점(골/하프타임/종료) 단위 세그먼트로
 * 미리 생성한다. 기대 득점(guide)을 램다로 써서 패킷과 결과가 이어진다.
 */
export function generateMatchScript(
  packet: StrengthPacket,
  home: SimSquad,
  away: SimSquad,
  seed: number,
  channel: string,
): MatchScriptSegment[] {
  const rng = makeRng(seed, `script:${channel}`);
  const goalsHome = Math.min(5, samplePoisson(rng, packet.guide.expectedGoals.home));
  const goalsAway = Math.min(5, samplePoisson(rng, packet.guide.expectedGoals.away));

  const goals: MatchEvent[] = [];
  for (let i = 0; i < goalsHome; i++) {
    goals.push({
      minute: randInt(rng, 4, 89),
      type: "goal",
      team: "home",
      actors: [pickScorer(rng, home)],
      causes: causeFromPacket(packet, "home"),
    });
  }
  for (let i = 0; i < goalsAway; i++) {
    goals.push({
      minute: randInt(rng, 4, 89),
      type: "goal",
      team: "away",
      actors: [pickScorer(rng, away)],
      causes: causeFromPacket(packet, "away"),
    });
  }
  goals.sort((a, b) => a.minute - b.minute);

  // 골 사이에 슛/찬스 살을 붙인다 — 범위가 뒤집히면(연속 골 등) 건너뛴다
  const filler = (from: number, to: number): MatchEvent[] => {
    if (to < from) return [];
    const events: MatchEvent[] = [];
    const count = randInt(rng, 0, 2);
    for (let i = 0; i < count; i++) {
      const side = rng() < 0.5 ? "home" : "away";
      const team = side === "home" ? home : away;
      events.push({
        minute: randInt(rng, from, to),
        type: rng() < 0.6 ? "shot" : "chance",
        team: side,
        actors: [pickScorer(rng, team)],
        causes: [],
      });
    }
    return events.sort((a, b) => a.minute - b.minute);
  };

  const segments: MatchScriptSegment[] = [];
  let cursor = 0;
  let buffer: MatchEvent[] = [{ minute: 0, type: "kickoff", actors: [], causes: [] }];
  const flush = (stop: MatchScriptSegment["stop"], extra: MatchEvent[]) => {
    segments.push({ events: [...buffer, ...extra], stop });
    buffer = [];
  };

  const firstHalfGoals = goals.filter((g) => g.minute < 45);
  const secondHalfGoals = goals.filter((g) => g.minute >= 45);

  for (const goal of firstHalfGoals) {
    buffer.push(...filler(cursor + 1, goal.minute - 1));
    cursor = goal.minute;
    flush("goal", [goal]);
  }
  buffer.push(...filler(cursor + 1, 44));
  flush("half_time", [{ minute: 45, type: "half_time", actors: [], causes: [] }]);
  cursor = 46;

  for (const goal of secondHalfGoals) {
    const minute = Math.max(goal.minute, cursor);
    buffer.push(...filler(cursor, minute - 1));
    cursor = minute;
    flush("goal", [{ ...goal, minute }]);
  }
  buffer.push(...filler(cursor, 89));
  flush("full_time", [
    { minute: randInt(rng, 92, 96), type: "full_time", actors: [], causes: [] },
  ]);

  return segments;
}
