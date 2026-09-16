import type { Contract, GamePlayer } from "@story-fm/domain";
import { ageOf } from "@story-fm/domain";
import { diffDays } from "../core/dates";
import { makeRng } from "../core/rng";
import { leagueCatalogById } from "../data/league-catalog";
import { leagueEconomyLevel } from "../data/league-economy";
import { leagueOfTeam } from "../data/team-catalog";
import { playerValueOf } from "../world/valuation";

/**
 * **바이아웃 조항** — 이 금액 이상의 오퍼가 오면 구단이 막지 못한다
 * (docs/simulation/transfer.md §12-3).
 *
 * 감독이 흥정한 계약의 조항은 조건서에서 오고, 여기 있는 것은 **AI 구단의 계약**에
 * 코어가 붙이는 규칙이다. 우리 구단만 조항을 갖고 살면 세계에서 조항으로 살 수 있는
 * 선수가 하나도 없다 — 조항은 감독이 흥정 없이 값을 치르고 데려오는 길이고, 그 길은
 * 세계 쪽에 있어야 뜻이 있다.
 *
 * 값을 시장가에 걸고 **서는 날 굳히는** 이유: 조항은 계약서의 숫자라 그 뒤 선수가
 * 자라도 움직이지 않는다. 그것이 조항이 흥정과 다른 점이다 — 유망주가 커진 뒤 옛 값에
 * 데려오는 자리가 여기서 나온다.
 */

/**
 * 조항이 서는 **나라별 비율** — 스페인은 법이 모든 계약에 조항을 요구하고, 그 밖의
 * 리그에서는 드문 조항이다. 표에 없는 나라는 `BUYOUT_RATE_DEFAULT`다.
 */
export const BUYOUT_RATE_BY_COUNTRY: Readonly<Record<string, number>> = { 스페인: 1 };
export const BUYOUT_RATE_DEFAULT = 0.25;

/**
 * 조항의 값 — 서는 날 시장가의 몇 배인가. 이 사이에서 시드가 고른다.
 *
 * 하한이 호가의 자(시장가 × 대체 불가 배수 × 대리인 `askingLift`)보다 위인 것이
 * 규약이다: 조항이 호가 아래로 서면 흥정보다 조항이 싼 길이 되어 협상 테이블이 비고,
 * 위에 서면 조항은 「흥정 없이 확실히 데려오는 값」으로 남는다.
 */
export const BUYOUT_MULTIPLE_MIN = 1.8;
export const BUYOUT_MULTIPLE_MAX = 3;

/**
 * 상대가 조건으로 **부르는** 조항의 자 — 시장가 대비 (transfer.md §12-3).
 *
 * 선수 쪽이 원하는 것은 낮은 조항이고 구단이 원하는 것은 높은 조항이다. 앵커는
 * 그 사이, 폭은 코어가 잘라 준다 — 시장가 아래의 조항은 선수를 그냥 내주는 값이라
 * 부를 수 없고, 시장가의 두 배 반 위는 조항이 아니라 장식이다.
 */
export const BUYOUT_ASK_MULTIPLE = 1.5;
export const BUYOUT_ASK_MIN = 1;
export const BUYOUT_ASK_MAX = 2.5;

export interface AiBuyoutInput {
  seed: number;
  /** 계약 id — 같은 계약은 같은 조항이다 */
  key: string;
  leagueId: string | null;
  /** 서는 날의 시장가 */
  value: number;
}

/** 금액은 10만 단위 — 시장가·호가와 같은 눈금이다 */
function roundClause(amount: number): number {
  return Math.round(amount / 100_000) * 100_000;
}

/**
 * AI 계약에 서는 조항 — 서지 않으면 `undefined`. 시장가가 없는 선수(자유계약·하위
 * 등급)에게는 걸 값이 없다.
 */
export function aiBuyoutClauseOf(input: AiBuyoutInput): number | undefined {
  if (input.value <= 0) return undefined;
  const country = leagueCatalogById(input.leagueId)?.country ?? "";
  const rate = BUYOUT_RATE_BY_COUNTRY[country] ?? BUYOUT_RATE_DEFAULT;
  const rng = makeRng(input.seed, `buyout:${input.key}`);
  if (rng() >= rate) return undefined;
  const multiple = BUYOUT_MULTIPLE_MIN + rng() * (BUYOUT_MULTIPLE_MAX - BUYOUT_MULTIPLE_MIN);
  return roundClause(input.value * multiple);
}

/** 상대가 조건으로 부를 수 있는 조항의 구간과 기준 — 시장가 하나에서 나온다 */
export function buyoutAskOf(value: number): { anchor: number; min: number; max: number } {
  return {
    anchor: roundClause(value * BUYOUT_ASK_MULTIPLE),
    min: roundClause(value * BUYOUT_ASK_MIN),
    max: roundClause(value * BUYOUT_ASK_MAX),
  };
}

/** 이 오퍼가 조항을 채우는가 — 조항이 있는 계약에 그 값 이상을 불렀다 */
export function buyoutMet(contract: { buyoutClause?: number } | null, fee: number): boolean {
  return (
    contract !== null &&
    contract.buyoutClause !== undefined &&
    contract.buyoutClause > 0 &&
    fee >= contract.buyoutClause
  );
}

/**
 * 세계가 아는 것 중 이 규칙이 읽는 것 — 시드·날짜·승강 뒤의 소속. `GameState`를 통째로
 * 받지 않는 이유는 세계 생성(`core/state.ts`)이 아직 상태가 서기 전에 부르기 때문이다.
 */
export interface BuyoutWorld {
  seed: number;
  date: string;
  userTeamId?: string;
  leagueOf?: Record<string, string>;
}

/**
 * **AI 구단의 계약이 서는 자리마다 이 함수가 조항을 붙인다** — 세계 생성·AI 재계약·AI
 * 이적·자유계약·승격 보강·시즌 자동 갱신 (transfer.md §12-3). 우리 구단의 계약은 조건서가
 * 정하므로 여기서 건드리지 않는다. 값은 서는 날의 시장가로 굳는다.
 */
export function attachAiBuyout(world: BuyoutWorld, contract: Contract, player: GamePlayer): void {
  if (world.userTeamId !== undefined && contract.teamId === world.userTeamId) return;
  const leagueId = world.leagueOf?.[contract.teamId] ?? leagueOfTeam(contract.teamId);
  const value = playerValueOf({
    overall: player.attributes.overall,
    potential: player.attributes.potential,
    age: ageOf(player.birthdate, world.date),
    form: player.state.form,
    yearsLeft: Math.max(0, diffDays(contract.since, contract.until) / 365),
    economy: leagueEconomyLevel(leagueId ?? ""),
  });
  const clause = aiBuyoutClauseOf({ seed: world.seed, key: contract.id, leagueId, value });
  if (clause !== undefined) contract.buyoutClause = clause;
}
