import type { GamePlayer, MatchRecord, MatchSide, ShootoutKick } from "@story-fm/domain";
import { nextShootoutKick, shootoutTally } from "@story-fm/domain";
import { makeRng } from "../core/rng";
import { finishingXi } from "./extra-time";
import { groupOf, type GameState } from "../core/state";

/**
 * 승부차기 — 녹아웃에서 승부가 갈리지 않았을 때. 유럽 대항전(2차전 합계 동점)과
 * 국내 컵(단판 무승부)이 같은 판정을 쓴다.
 *
 * **킥 하나가 사건 하나다** (`ShootoutKick`) — 누가 찼고, 누가 막아섰고, 들어갔는지
 * 나갔는지, 그 킥의 성공 확률까지 장부에 남는다. 중계도 화면도 그것을 인용한다
 * (→ docs/simulation/match.md §2).
 *
 * 조기 확정과 서든데스의 판정은 이 파일이 갖지 않는다 — `shootoutSettled` ·
 * `nextShootoutKick` 하나가 갖고 코어와 화면이 같은 함수를 읽는다.
 */

/** 성공률의 바닥 — 아무리 약한 키커도 이 아래로 내려가지 않는다 */
const PENALTY_FLOOR = 0.62;
/** 성공률의 천장 — 아무리 강한 키커도 이 위로 올라가지 않는다 */
const PENALTY_CEILING = 0.8;
/** 키커와 골키퍼의 기량이 같을 때의 성공률 — 대역의 가운데 */
const PENALTY_BASE = 0.71;
/** 기량 차 1당 오르내리는 폭 — 26점 차가 대역의 끝에 닿는다 */
const PENALTY_EDGE = 0.0035;

/** 키커의 승부차기 기량 — 결정력·침착성·킥력의 가중 평균 */
const PENALTY_WEIGHTS = { finishing: 0.5, composure: 0.3, kicking: 0.2 } as const;
/** 골키퍼의 승부차기 기량 — 골키핑·침착성의 가중 평균 */
const KEEPER_WEIGHTS = { goalkeeping: 0.7, composure: 0.3 } as const;
/**
 * 골키퍼가 없을 때 서는 기량 — 명단에 GK가 없는 옛 세이브에서만 쓰인다.
 * `PENALTY_BASE`가 그대로 서도록 평균적인 키커와 같은 자리에 둔다.
 */
const KEEPER_FALLBACK_SKILL = 60;

/** 실패한 킥이 **선방**일 비율 — 나머지는 골문을 벗어난다 */
const SAVED_SHARE_BASE = 0.5;
/** 그 비율이 `SAVED_SHARE_BASE`로 서는 골키퍼 기량 */
const SAVED_SHARE_BASE_SKILL = 60;
/** 골키퍼 기량 1당 선방 쪽으로 기우는 폭 */
const SAVED_SHARE_EDGE = 0.006;
const SAVED_SHARE_FLOOR = 0.3;
const SAVED_SHARE_CEILING = 0.75;

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** 키커의 승부차기 기량 — 결정력 0.5 · 침착성 0.3 · 킥력 0.2 */
export function penaltySkill(p: GamePlayer): number {
  const a = p.attributes;
  return (
    a.finishing * PENALTY_WEIGHTS.finishing +
    a.composure * PENALTY_WEIGHTS.composure +
    a.kicking * PENALTY_WEIGHTS.kicking
  );
}

/** 막아서는 골키퍼의 기량 — 골키핑 0.7 · 침착성 0.3. 골키퍼가 없으면 대체값 */
export function keeperSkill(p: GamePlayer | null): number {
  if (!p) return KEEPER_FALLBACK_SKILL;
  const a = p.attributes;
  return a.goalkeeping * KEEPER_WEIGHTS.goalkeeping + a.composure * KEEPER_WEIGHTS.composure;
}

/**
 * 이 킥의 성공 확률 — 키커와 골키퍼의 기량 차가 정한다.
 *
 * ⚠️ **양쪽 다 막는다.** 대역(0.62~0.80)은 문서가 쥔 값이고, 승부차기가 실력이 덜
 * 갈리는 무대라는 설계가 거기 들어 있다 (→ docs/data/competition.md §6).
 */
export function penaltyRate(taker: GamePlayer, keeper: GamePlayer | null): number {
  const edge = (penaltySkill(taker) - keeperSkill(keeper)) * PENALTY_EDGE;
  return clamp(PENALTY_BASE + edge, PENALTY_FLOOR, PENALTY_CEILING);
}

/** 실패한 킥이 선방으로 남을 비율 — 골키퍼가 좋을수록 `saved`, 나쁠수록 `missed` */
function savedShare(keeper: GamePlayer | null): number {
  const edge = (keeperSkill(keeper) - SAVED_SHARE_BASE_SKILL) * SAVED_SHARE_EDGE;
  return clamp(SAVED_SHARE_BASE + edge, SAVED_SHARE_FLOOR, SAVED_SHARE_CEILING);
}

/**
 * 그 팀의 골문에 선 골키퍼 — **경기를 끝낸 열한 명 중에서** 고른다.
 *
 * 교체돼 나간 주전 GK도, 퇴장당한 GK도 승부차기를 막지 않는다. GK가 없으면 null —
 * 명단에 골키퍼가 없는 옛 세이브에서만 그렇게 된다.
 */
export function shootoutKeeper(
  state: GameState,
  match: MatchRecord,
  side: MatchSide,
): GamePlayer | null {
  return finishingXi(state, match, side).find((p) => groupOf(p) === "GK") ?? null;
}

/**
 * 차는 순서 — 기본은 승부차기 기량 내림차순이고 **골키퍼가 맨 뒤**다.
 *
 * `preferred`는 감독의 지시다. 그 경기를 끝낸 열한 명 안에 있는 id만 살려 앞에
 * 세우고 나머지가 기본 순서로 뒤를 잇는다 — 뛰지도 않은 선수를 세울 수는 없다.
 */
export function shootoutOrder(
  state: GameState,
  match: MatchRecord,
  side: MatchSide,
  preferred?: readonly string[],
): GamePlayer[] {
  const takers = finishingXi(state, match, side);
  const byId = new Map(takers.map((p) => [p.id, p]));
  const base = [...takers].sort((a, b) => {
    const keeperA = groupOf(a) === "GK" ? 1 : 0;
    const keeperB = groupOf(b) === "GK" ? 1 : 0;
    if (keeperA !== keeperB) return keeperA - keeperB;
    return penaltySkill(b) - penaltySkill(a);
  });
  if (!preferred || preferred.length === 0) return base;

  const front: GamePlayer[] = [];
  const seen = new Set<string>();
  for (const id of preferred) {
    const player = byId.get(id);
    if (!player || seen.has(id)) continue;
    seen.add(id);
    front.push(player);
  }
  return [...front, ...base.filter((p) => !seen.has(p.id))];
}

/**
 * 먼저 차는 쪽 — 동전이 정한다.
 *
 * 홈으로 고정하면 조기 확정이 들어온 뒤로 홈에 체계적 이점이 생긴다. 시드에서
 * 떨어지는 결정적 동전이라 같은 세이브는 언제 물어도 같은 답이다.
 */
export function shootoutFirst(state: GameState, match: MatchRecord): MatchSide {
  return makeRng(state.seed, `pens:${match.id}:coin`)() < 0.5 ? "home" : "away";
}

/**
 * 한 발을 굴린다 — 이어 붙일 킥 하나. 이미 갈렸으면 null.
 *
 * **순수하다**: 장부를 건드리지 않고 킥만 돌려준다. 감독의 경기는 진행 턴마다 이
 * 함수를 한 번 부르고, 타 팀 경기는 `resolveShootout`이 이어 붙여 굴린다 —
 * **난수 채널에 킥 인덱스가 들어가므로 두 경로가 같은 결과를 낸다.**
 */
export function rollShootoutKick(
  state: GameState,
  match: MatchRecord,
  kicks: readonly ShootoutKick[],
  first: MatchSide,
  order?: { home?: readonly string[]; away?: readonly string[] },
): ShootoutKick | null {
  const next = nextShootoutKick(kicks, first);
  if (!next) return null;

  const takers = shootoutOrder(state, match, next.team, order?.[next.team]);
  // 찰 사람이 아무도 없는 명단 — 빈 팀에서만 생기고, 그때는 굴릴 것이 없다
  if (takers.length === 0) return null;
  // 열한 발을 다 쓰면 처음으로 돌아간다
  const taken = kicks.filter((k) => k.team === next.team).length;
  const taker = takers[taken % takers.length]!;
  const keeper = shootoutKeeper(state, match, next.team === "home" ? "away" : "home");
  const probability = penaltyRate(taker, keeper);

  // 성공 판정 하나, 실패의 갈래 하나 — 같은 rng에서 순서대로 뽑는다
  const rng = makeRng(state.seed, `pens:${match.id}:${kicks.length}`);
  const scored = rng() < probability;
  const failure = rng() < savedShare(keeper) ? "saved" : "missed";

  return {
    round: next.round,
    team: next.team,
    taker: taker.id,
    ...(keeper ? { keeper: keeper.id } : {}),
    outcome: scored ? "scored" : failure,
    probability,
  };
}

/**
 * 대진 하나를 끝까지 굴려 `decider.result.penalties`에 적는다 — **멱등**이다.
 *
 * 이미 적힌 승부차기는 다시 굴리지 않는다: 승자를 묻는 자리에서 새로 굴러가면
 * 화면이 브래킷을 그릴 때마다 결과가 바뀐다.
 *
 * ⚠️ **서든데스에 상한이 없다.** 성공률이 `PENALTY_FLOOR`~`PENALTY_CEILING`로
 * 클램프돼 0과 1 사이에 갇혀 있으므로 두 팀이 영원히 같이 넣거나 같이 놓칠 확률은
 * 0이다 — 종료가 확률 1로 보장된다. 옛 코드가 20라운드 뒤에 `h += 1`로 홈을
 * 이기게 한 자리이고, 그것은 장부에 없는 승자를 만드는 일이었다.
 */
export function resolveShootout(
  state: GameState,
  decider: MatchRecord,
): { home: number; away: number } {
  const result = decider.result;
  // 결과가 없는 경기는 승부차기의 자리가 아니다 — 장부에 아무것도 적지 않는다
  if (!result) return { home: 0, away: 0 };
  const written = result.penalties;
  if (written) return { home: written.home, away: written.away };

  const first = shootoutFirst(state, decider);
  const kicks: ShootoutKick[] = [];
  for (;;) {
    const kick = rollShootoutKick(state, decider, kicks, first);
    if (!kick) break;
    kicks.push(kick);
  }
  const tally = shootoutTally(kicks);
  result.penalties = { ...tally, kicks };
  return tally;
}
