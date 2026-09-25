import type { MatchStage, TickSink } from "@story-fm/domain";
import { pushEvent } from "@story-fm/domain";
import type { GameState } from "../core/state";
import { formatMoney, payOnce } from "../club/finance";

/**
 * 대회 상금의 **공통 골격** — 멱등 키·표시 라벨·지급.
 *
 * 국내 컵(`domestic-cup.ts`)과 유럽 대항전(`euro-prize.ts`)이 같은 원장에 같은 모양의
 * 항목을 적는다. 금액과 "언제 누구에게"는 각 대회가 갖고, 여기서는 **키와 문장의
 * 모양**만 한 벌로 둔다 — 둘이 갈리면 원장이 갈린다.
 */

/**
 * 한 대회 한 시즌 안에서 상금을 가르는 축 — 라벨과 달리 표시에 쓰이지 않는다.
 * 국내 컵은 `stage:*`·`winner`·`runner-up`, 대항전은 `league-phase`·`stage:*`·`winner`를
 * 쓴다. 두 집합이 겹치므로 합집합 하나로 둔다 — 키 문자열의 모양이 하나여야 한다.
 */
export type PrizeKind = "league-phase" | `stage:${MatchStage}` | "winner" | "runner-up";

/** 상금이 필요로 하는 대회의 전부 — 원장의 ref(`id`)와 라벨의 약칭(`short`) */
export interface PrizeCup {
  readonly id: string;
  readonly short: string;
}

/**
 * 멱등 키 — `category + ref + 무엇 + season` (finance.md §4.1).
 *
 * 라벨은 언제든 고쳐 쓰는 문장이라 키로 쓸 수 없다. 컵 약칭이나 단계 이름 한 글자를
 * 고치는 순간 이미 지급한 상금이 새 키를 얻어 한 번 더 나간다.
 *
 * ⚠️ **이 문자열은 세이브에 남는다.** 모양을 바꾸면 `SAVE_VERSION`을 올린다 — 그대로
 * 두면 진행 중인 세이브의 지급 기록이 통째로 무효가 되어 전 대회 상금이 다시 나간다.
 */
export function prizeKey(cupId: string, kind: PrizeKind, season: number): string {
  return `prize:competition:${cupId}:${kind}:S${season}`;
}

/** 원장에 적히는 문장 — 키가 아니라 라벨이다 (`prizeKey`가 키다) */
export function prizeLabel(cup: PrizeCup, season: number, what: string): string {
  return `${cup.short} ${what} 상금 (S${season})`;
}

/** 상금 한 건 — `what`은 라벨의 가운데("우승" · "리그 페이즈" · "8강 진출") */
export interface PrizePayment {
  cup: PrizeCup;
  teamId: string;
  kind: PrizeKind;
  what: string;
  amount: number;
}

/**
 * 상금 한 건을 지급하고, 감독의 팀이면 다이제스트에 올린다.
 * 중복 지급은 `FINANCE.prizesPaid`의 키가 막는다 — 원장이 아니다 (finance.md §4.4·§4.5).
 *
 * **실제로 나갔는지를 돌려준다.** 그 불리언이 곧 "이 대회 이 시즌을 아직 결산하지
 * 않았다"는 사실이라, 매일 불리는 정산이 우승 보고를 되풀이하지 않는 문지기가 된다
 * (`advanceSuperCups`).
 */
export function payPrize(state: GameState, prize: PrizePayment, digest: TickSink): boolean {
  const label = prizeLabel(prize.cup, state.season, prize.what);
  const paid = payOnce(state, prize.teamId, prizeKey(prize.cup.id, prize.kind, state.season), {
    kind: "income",
    category: "prize",
    label,
    amount: prize.amount,
    ref: { type: "competition", id: prize.cup.id },
  });
  if (paid && prize.teamId === state.userTeamId) {
    // 상금은 추첨이 아니라 장부의 일이다 — 컵 패스가 추첨으로 잡혀 있어도 이 줄은 소식이다
    pushEvent(digest, "news", `${label} ${formatMoney(prize.amount)} 입금`);
  }
  return paid;
}
