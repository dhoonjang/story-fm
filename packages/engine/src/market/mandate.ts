import type {
  Delegation,
  GamePlayer,
  MandateLimit,
  Negotiation,
  NegotiationKind,
  TickSink,
} from "@story-fm/domain";
import {
  interestStageRank,
  isMandated,
  isPlayerDeal,
  josaOf,
  mandateLimitText,
  pushEvent,
} from "@story-fm/domain";
import type { CommandResult } from "../commands";
import { formatMoney } from "../club/finance";
import { pickAnyPlayer } from "../core/player-ref";
import { playerById, pushNarrative, type GameState } from "../core/state";
import { directorOf } from "../world/persona";
import { outgoingCounterFloor, renewalYearsExpectation } from "./counter-bounds";
import { settleDueResponse } from "./counterparty";
import { renewalExpectation } from "./market";
import {
  acceptDeal,
  answerIncomingOffer,
  expiringContracts,
  listingOf,
  offerPlayerOut,
  incomingOffer,
  negotiationKindKo,
  openNegotiationFor,
  openRenewal,
  pendingOffer,
  quotedFee,
  sendOffer,
  standingCounter,
  suggestTerms,
} from "./negotiation";

/**
 * **위임 — 단장이 대신 앉는 협상** (docs/simulation/transfer.md §12-4).
 *
 * 경기에 앉고 싶은 감독이 나머지 업무를 넘기는 자리다. 맡긴 협상은 감독 턴 없이 굴러
 * 합의까지 가고, 단장이 더 할 수 없는 일이 생기면 위임이 끝나 협상은 감독에게 그냥
 * 돌아온다 — 되돌림이라는 상태를 따로 두지 않는다. 받고 되부르고 서명하는 명령은 감독이
 * 직접 부를 때의 것이라 위임이 여는 관문은 하나도 없다.
 *
 * **담당자는 저장하지 않는다** — 이적과 재계약의 실무는 우리 구단의 단장이 본다
 * (`directorOf` · people.md §2). 상대 테이블 건너편에 앉는 그 자리이고, 구단마다 한
 * 사람이라 시드에서 파생한다.
 */

/**
 * 재계약 방침이 하루에 여는 자리 — 한 건.
 *
 * 만료가 다가온 선수를 한꺼번에 열면 주급 여력이 하루에 빠지고, 반려된 제안이 같은 날
 * 무더기로 장부에 선다. 한 건씩이면 시즌의 달력 위로 흩어진다.
 */
const MANDATE_OPENS_PER_DAY = 1;

/** 우리 구단의 단장 — 맡은 일을 하는 사람 */
export function clubDirector(state: GameState) {
  return directorOf(state, state.userTeamId);
}

/** 내보내는 갈래 — 단장이 받아야 하는 값은 하한이다 */
function isOutgoing(kind: NegotiationKind): boolean {
  return kind === "sell" || kind === "loan_out";
}

/** 협상이 아직 없는 자리에서도 갈래의 이름을 부른다 */
function kindKo(kind: NegotiationKind): string {
  return negotiationKindKo({ kind } as Negotiation);
}

/** 감독이 부른 한도 — 비운 축은 한도가 없는 축이다 */
function limitOf(input: { fee?: number; weeklyWage?: number; years?: number }): MandateLimit {
  return {
    ...(input.fee === undefined ? {} : { fee: Math.round(input.fee) }),
    ...(input.weeklyWage === undefined ? {} : { weeklyWage: Math.round(input.weeklyWage) }),
    ...(input.years === undefined ? {} : { contractYears: input.years }),
  };
}

/** 한도 안으로 — 상한은 이하로 자른다 */
function capAt(value: number, ceiling?: number): number {
  return ceiling === undefined ? value : Math.min(value, ceiling);
}

/** 이 갈래에 선 방침 */
function delegationFor(state: GameState, kind: NegotiationKind): Delegation | undefined {
  return state.delegations.find((d) => d.kind === kind);
}

/**
 * **단장의 첫 제시** — 갈래마다 코어의 자를 한도 안으로 자른 값이다 (transfer.md §12-4).
 * 자는 코어가 아는 값이고 한도는 감독이 부른 숫자라, 지어낸 결정이 장부에 오르지 않는다.
 */
function openRenewalFor(state: GameState, player: GamePlayer, limit: MandateLimit): CommandResult {
  return openRenewal(state, {
    playerId: player.id,
    weeklyWage: capAt(renewalExpectation(state, player), limit.weeklyWage),
    years: limit.contractYears ?? renewalYearsExpectation(state, player),
  });
}

function openSigningFor(state: GameState, player: GamePlayer, limit: MandateLimit): CommandResult {
  const base = suggestTerms(state, player.id);
  if (!base) return { ok: false, message: "선수를 찾지 못했습니다" };
  return sendOffer(state, {
    playerId: player.id,
    fee: capAt(quotedFee(state, player, "buy"), limit.fee),
    weeklyWage: capAt(base.weeklyWage, limit.weeklyWage),
    years: limit.contractYears ?? base.years,
    kind: "buy",
  });
}

/**
 * **매각의 상대는 관심 사다리가 고른다** (§1-2) — 그 선수를 보고 있다고 장부에 선 구단 중
 * 가장 높이 오른 쪽이다. 단장이 구단을 지어내지 않고, 값은 감독이 등재하며 부른 호가다.
 */
function openSaleFor(state: GameState, player: GamePlayer, limit: MandateLimit): CommandResult {
  const suitor = state.interests
    .filter((i) => i.gamePlayerId === player.id && i.stage !== "watching")
    .sort(
      (a, b) =>
        interestStageRank(b.stage) - interestStageRank(a.stage) || a.teamId.localeCompare(b.teamId),
    )[0];
  if (!suitor) {
    return { ok: false, message: `${player.name}을 사겠다고 나선 구단이 아직 없습니다` };
  }
  return offerPlayerOut(state, {
    playerId: player.id,
    teamId: suitor.teamId,
    // 하한 위에서 부른다 — 등재 호가가 있으면 그것이 감독이 부른 값이다
    fee: Math.max(
      listingOf(state, player.id)?.askingPrice ?? quotedFee(state, player, "sell"),
      limit.fee ?? 0,
    ),
  });
}

/** 이 갈래를 단장이 먼저 열 수 있는가 — 열면 그 결과다 */
function openFor(
  state: GameState,
  player: GamePlayer,
  kind: NegotiationKind,
  limit: MandateLimit,
): CommandResult {
  if (kind === "renew") return openRenewalFor(state, player, limit);
  if (kind === "buy") return openSigningFor(state, player, limit);
  if (kind === "sell") return openSaleFor(state, player, limit);
  return {
    ok: false,
    message: `${kindKo(kind)}의 첫 제시는 감독의 결정입니다 — 협상을 연 뒤에 맡기세요`,
  };
}

/** 맡길 수 없는 자리 — 조항이 발동한 매각과 감독이 마주 앉은 협상 */
function unavailable(state: GameState, negotiation: Negotiation, who: string): string | null {
  if (negotiation.buyout) {
    return `${who} 건은 바이아웃 조항이 발동한 매각입니다 — 맡길 것이 없습니다`;
  }
  if (state.pendingNegotiation?.negotiationId === negotiation.id) {
    return `${who} 협상에는 감독이 마주 앉아 있습니다 — 먼저 일어서야 맡길 수 있습니다`;
  }
  return null;
}

export interface DelegateInput {
  /** 맡길 선수 — 비우면 갈래째 맡기는 **방침**이다 (transfer.md §12-4) */
  playerId?: string;
  /** 갈래 — 방침에서 비우면 여섯 갈래 전부 */
  kind?: NegotiationKind;
  fee?: number;
  weeklyWage?: number;
  years?: number;
}

/**
 * 협상을 단장에게 맡긴다 — 이름을 부르면 그 건 하나, 비우면 그 갈래의 방침이다.
 * `team_talk`이 대상을 비우면 선수단 전체인 것과 같은 규약이다 (prompts.md §2).
 */
export function delegateNegotiation(state: GameState, input: DelegateInput): CommandResult {
  const limit = limitOf(input);
  const director = clubDirector(state);
  if (input.playerId === undefined) {
    const kinds: NegotiationKind[] = input.kind
      ? [input.kind]
      : ["buy", "sell", "renew", "loan", "loan_out", "release"];
    const rest = state.delegations.filter((d) => !kinds.includes(d.kind));
    state.delegations = [
      ...rest,
      ...kinds.map((kind): Delegation => ({ kind, limit, since: state.date })),
    ];
    const label = kinds.length === 1 ? kindKo(kinds[0]!) : "이적·재계약";
    return {
      ok: true,
      message:
        `${label}${josaOf(label, "을/를")} ${director.name} 단장에게 맡겼습니다 — ` +
        `${mandateLimitText(limit, kinds[0]!)}. 앞으로 열리는 자리는 단장이 봅니다`,
    };
  }

  const pick = pickAnyPlayer(state, input.playerId);
  if (!pick.ok) return { ok: false, message: pick.message };
  const player = pick.player;
  const open = openNegotiationFor(state, player.id);
  const negotiation = open && (input.kind === undefined || open.kind === input.kind) ? open : null;
  let opened: string | null = null;
  let target = negotiation;
  if (target) {
    const blocked = unavailable(state, target, player.name);
    if (blocked) return { ok: false, message: blocked };
  } else {
    const kind = input.kind ?? (player.teamId === state.userTeamId ? "renew" : "buy");
    const first = openFor(state, player, kind, limit);
    if (!first.ok) return first;
    opened = first.message;
    target = openNegotiationFor(state, player.id);
    if (!target) return { ok: false, message: `${player.name} 협상이 열리지 않았습니다` };
  }
  target.mandate = limit;
  // 맡긴 자리에 답이나 조정이 이미 서 있으면 그 자리에서 한 번 굴린다
  const lines: string[] = [];
  runMandate(state, target, lines);
  return {
    ok: true,
    message:
      `${player.name} ${negotiationKindKo(target)} 협상을 ${director.name} 단장에게 맡겼습니다 — ` +
      `${mandateLimitText(limit, target.kind)}.` +
      (opened ? ` ${opened}` : "") +
      (lines.length > 0 ? ` ${lines.join(" ")}` : ""),
  };
}

/**
 * 맡긴 일을 감독이 도로 가져온다 — 이름을 부르면 그 건, 비우면 그 갈래의 방침과 그 갈래로
 * 맡겨 둔 협상까지. 도로 가져온 협상은 위임 전과 같은 장부다.
 */
export function revokeMandate(
  state: GameState,
  input: { playerId?: string; kind?: NegotiationKind },
): CommandResult {
  if (input.playerId !== undefined) {
    const pick = pickAnyPlayer(state, input.playerId);
    if (!pick.ok) return { ok: false, message: pick.message };
    const player = pick.player;
    const negotiation = openNegotiationFor(state, player.id);
    if (!negotiation || !isMandated(negotiation)) {
      return { ok: false, message: `${player.name} 협상은 지금 단장이 쥔 협상이 아닙니다` };
    }
    negotiation.mandate = null;
    return {
      ok: true,
      message: `${player.name} ${negotiationKindKo(negotiation)} 협상을 도로 가져왔습니다 — 이제 감독의 테이블입니다`,
    };
  }
  const kinds = input.kind ? [input.kind] : state.delegations.map((d) => d.kind);
  if (kinds.length === 0) return { ok: false, message: "단장에게 맡겨 둔 일이 없습니다" };
  state.delegations = state.delegations.filter((d) => !kinds.includes(d.kind));
  // 방침으로 맡겨 둔 협상도 함께 돌아온다 — 방침만 거두면 굴러가던 자리가 남는다
  for (const negotiation of state.negotiations) {
    if (isMandated(negotiation) && kinds.includes(negotiation.kind)) negotiation.mandate = null;
  }
  const label = kinds.length === 1 ? kindKo(kinds[0]!) : "이적·재계약";
  return {
    ok: true,
    message: `${label} 위임을 거뒀습니다 — 진행 중이던 자리도 감독에게 돌아옵니다`,
  };
}

/** 지금 감독의 차례를 만드는 상대의 요구 — 되부른 조정 · 개인 조건의 되부름 · 들어온 오퍼 */
function standingDemand(
  negotiation: Negotiation,
): { fee: number; weeklyWage: number; contractYears: number } | null {
  const counter = standingCounter(negotiation) ?? incomingOffer(negotiation);
  if (counter) {
    return {
      fee: counter.fee,
      weeklyWage: counter.weeklyWage,
      contractYears: counter.contractYears,
    };
  }
  const personal = negotiation.personal;
  if (personal?.counter && personal.agreedOn === undefined && !pendingOffer(negotiation)) {
    return {
      fee: 0,
      weeklyWage: personal.counter.weeklyWage,
      contractYears: personal.counter.contractYears,
    };
  }
  return null;
}

/**
 * **한도 밖인가** — 상한은 이하, 하한은 이상이 안이다. 한도를 정확히 맞춘 요구는 받는다.
 *
 * 한도를 말하지 않은 축은 코어의 합법 범위가 그대로 한도다(`counterBoundsOf`) — 상대가
 * 되부를 수 있는 값은 이미 그 안으로 잘려 있다. 내보내는 갈래만 자를 따로 읽는다: 들어온
 * 오퍼는 시장이 낸 값이라 코어의 조정 하한을 지나지 않는다.
 */
function overLimit(
  state: GameState,
  negotiation: Negotiation,
  player: GamePlayer,
  demand: { fee: number; weeklyWage: number; contractYears: number },
): string | null {
  const limit = negotiation.mandate ?? {};
  const kind = negotiation.kind;
  if (isOutgoing(kind)) {
    const floor = limit.fee ?? outgoingCounterFloor(state, kind, player);
    return demand.fee < floor ? `${formatMoney(demand.fee)} — 하한 ${formatMoney(floor)}` : null;
  }
  if (limit.fee !== undefined && kind !== "renew" && demand.fee > limit.fee) {
    return `${formatMoney(demand.fee)} — 상한 ${formatMoney(limit.fee)}`;
  }
  if (kind === "release") return null;
  if (limit.weeklyWage !== undefined && demand.weeklyWage > limit.weeklyWage) {
    return `주급 ${formatMoney(demand.weeklyWage)} — 상한 ${formatMoney(limit.weeklyWage)}`;
  }
  if (limit.contractYears !== undefined && demand.contractYears > limit.contractYears) {
    return `${demand.contractYears}년 — 상한 ${limit.contractYears}년`;
  }
  return null;
}

/**
 * **명령이 옮긴 뒤의 상태** — 지금 장부의 값이다. 함수를 지나는 이유는 타입이 좁혀지기
 * 때문이다: `agreed` 가지 안에서 서명하면 상태가 `completed`로 옮겨 가는데, 좁혀진 타입은
 * 그 비교를 겹치지 않는 것으로 읽는다.
 */
function statusAfter(negotiation: Negotiation): Negotiation["status"] {
  return negotiation.status;
}

/**
 * 맡긴 협상 하나를 오늘 굴린다 — tick과 맡기는 명령이 같은 문을 지난다.
 *
 * 순서가 뜻이다: 답할 날이 된 답을 앵커로 굳히고, 닫혔으면 결과를 알리고, 합의면 서명하고,
 * 서 있는 요구를 한도로 가르고, 아무것도 없으면 첫 제시를 넣는다.
 */
function runMandate(state: GameState, negotiation: Negotiation, digest: TickSink): void {
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return;
  const director = clubDirector(state);
  const kindKoName = negotiationKindKo(negotiation);
  const say = (text: string): void =>
    pushEvent(
      digest,
      isPlayerDeal(negotiation.kind) ? "contract" : "interest",
      `${director.name} 단장 — ${text}`,
    );
  /** 단장이 더 할 수 없다 — 위임이 끝나고 협상은 감독에게 그냥 돌아온다 */
  const handOff = (why: string): void => {
    negotiation.mandate = null;
    say(`${player.name} ${kindKoName} 협상을 감독에게 돌립니다: ${why}`);
    // 오늘 답해야 하는 일의 눈금 — 답 도착과 같은 3이다 (people.md §9)
    pushNarrative(state, `${player.name} ${kindKoName} 위임이 감독에게 돌아옴 — ${why}`, 3);
  };

  /**
   * ① 답할 날이 된 답은 앵커로 굳는다 — 판정 호출이 없다.
   *
   * **감독이 나서지 않은 모든 협상이 지나는 그 문이다**(`settleDueResponse` — §12-1).
   * tick은 위임이 구르기 전에 이미 그 문을 한 번 지나므로, 여기 남는 것은 맡기는 그날
   * 답이 서 있던 자리다.
   */
  const settled = settleDueResponse(state, negotiation);
  if (settled && !settled.result.ok) return handOff(settled.result.message);

  // ② 닫힌 협상 — 결과를 알리고 위임을 접는다
  if (negotiation.status !== "open" && negotiation.status !== "agreed") {
    negotiation.mandate = null;
    say(
      negotiation.status === "completed"
        ? `${player.name} ${kindKoName}${josaOf(kindKoName, "을/를")} 매듭지었습니다`
        : negotiation.status === "rejected"
          ? `${player.name} ${kindKoName} 협상이 결렬됐습니다`
          : `${player.name} ${kindKoName} 협상이 기한을 넘겨 무산됐습니다`,
    );
    return;
  }

  // ③ 합의 — 단장이 서명한다. 소견이 붙은 검진은 감독의 결정이다
  if (negotiation.status === "agreed") {
    if (negotiation.medical?.status === "flagged") {
      return handOff("메디컬 소견이 붙었습니다");
    }
    if (negotiation.medical?.status === "scheduled") return;
    const signed: CommandResult = acceptDeal(state, negotiation.id);
    if (!signed.ok) return handOff(signed.message);
    if (statusAfter(negotiation) === "completed") {
      negotiation.mandate = null;
      say(`${player.name} ${kindKoName}${josaOf(kindKoName, "을/를")} 매듭지었습니다`);
    } else {
      say(`${player.name} ${kindKoName}에 합의했습니다 — ${signed.message}`);
    }
    return;
  }

  // ④ 서 있는 요구 — 한도 안이면 받는다
  const demand = standingDemand(negotiation);
  if (demand) {
    const over = overLimit(state, negotiation, player, demand);
    if (over) return handOff(`상대가 ${over}${josaOf(over, "을/를")} 부릅니다`);
    const taken: CommandResult = incomingOffer(negotiation)
      ? answerIncomingOffer(state, { negotiationId: negotiation.id, verdict: "accept" })
      : acceptDeal(state, negotiation.id);
    if (!taken.ok) return handOff(taken.message);
    say(`${player.name} ${kindKoName} — 상대의 조건이 한도 안이라 그대로 받았습니다`);
    // 들어온 오퍼를 받으면 그 자리가 곧 합의다 — 서명도 같은 날이다
    if (statusAfter(negotiation) === "agreed") runMandate(state, negotiation, digest);
    return;
  }

  // ⑤ 값이 오간 적 없는 자리 — 재계약만 단장이 첫 제시를 넣는다
  if (negotiation.rounds.length === 0 && !negotiation.personal) {
    const first = openFor(state, player, negotiation.kind, negotiation.mandate ?? {});
    if (!first.ok) return handOff(first.message);
    say(`${player.name} ${kindKoName} — 첫 제시를 넣었습니다. ${first.message}`);
  }
}

/** 방침이 열린 협상을 맡는다 — 감독이 빼 둔 자리(`null`)와 조항·마주 앉은 자리는 건너뛴다 */
function adoptByPolicy(state: GameState): void {
  for (const negotiation of state.negotiations) {
    if (negotiation.status !== "open" || negotiation.mandate !== undefined) continue;
    const policy = delegationFor(state, negotiation.kind);
    if (!policy) continue;
    const player = playerById(state, negotiation.gamePlayerId);
    if (!player || unavailable(state, negotiation, player.name)) continue;
    negotiation.mandate = policy.limit ?? {};
  }
}

/**
 * **방침이 자리를 여는 대상 — 감독이 이미 가리킨 사람뿐이다** (transfer.md §12-4).
 *
 * 단장은 선수를 고르지 않는다. 재계약은 만료가 다가온 우리 선수, 매각은 **감독이 이적
 * 리스트에 올린 선수**(§1), 영입은 **감독이 낸 스카우트 임무가 데려온 후보**(player.md §9.4)다.
 * 셋 다 감독이 먼저 말한 목록이고, 단장이 하는 일은 그 위에 값을 붙여 자리를 여는 것이다.
 *
 * **협상 기록이 한 번이라도 있는 선수는 건너뛴다.** 시장을 거르는 자리가 아니라 **단장이
 * 먼저 거는 자리**라서다 — 무산된 자리를 날마다 다시 열면 같은 오퍼가 달력을 채운다.
 * 감독이 직접 다시 여는 길은 그대로 열려 있다.
 */
function targetsFor(state: GameState, kind: NegotiationKind): GamePlayer[] {
  const fresh = (player: GamePlayer | null): player is GamePlayer =>
    player !== null && !state.negotiations.some((n) => n.gamePlayerId === player.id);
  if (kind === "renew") {
    return expiringContracts(state)
      .map(({ player }) => player)
      .filter(fresh);
  }
  if (kind === "sell") {
    return state.transferList
      .map((listing) => playerById(state, listing.gamePlayerId))
      .filter(fresh)
      .filter((player) => player.teamId === state.userTeamId);
  }
  if (kind === "buy") {
    // 임무가 세운 차례 그대로다 — 다시 줄을 세우면 카드가 보여 준 순서와 어긋난다
    return state.scoutMissions
      .filter((mission) => mission.completedOn !== null)
      .flatMap((mission) => mission.candidates ?? [])
      .map((id) => playerById(state, id))
      .filter(fresh)
      .filter((player) => player.teamId !== state.userTeamId);
  }
  return [];
}

/**
 * **방침이 하루에 여는 자리** — 갈래를 통틀어 한 건이다 (`MANDATE_OPENS_PER_DAY`).
 *
 * 순서는 급한 차례다: 재계약을 놓치면 자유계약으로 잃고, 등재한 선수는 창이 닫히면 남으며,
 * 영입은 그다음이다. 반려된 대상은 건너뛴다 — 예산이 없으면 그날은 아무것도 열리지 않는다.
 */
function openByPolicy(state: GameState, digest: TickSink): void {
  let opened = 0;
  for (const kind of ["renew", "sell", "buy"] as const) {
    if (opened >= MANDATE_OPENS_PER_DAY) return;
    const policy = delegationFor(state, kind);
    if (!policy) continue;
    const limit = policy.limit ?? {};
    for (const player of targetsFor(state, kind)) {
      const first = openFor(state, player, kind, limit);
      if (!first.ok) continue;
      const negotiation = openNegotiationFor(state, player.id);
      if (!negotiation) continue;
      negotiation.mandate = limit;
      opened += 1;
      pushEvent(
        digest,
        isPlayerDeal(kind) ? "contract" : "interest",
        `${clubDirector(state).name} 단장 — ${player.name} ${kindKo(kind)} 자리를 열었습니다. ${first.message}`,
      );
      break;
    }
  }
}

/**
 * **매일의 tick** — 방침이 자리를 맡고 열고, 맡은 협상이 하루치를 굴린다
 * (기한 처리 뒤, 답 도착 알림 앞).
 */
export function runMandates(state: GameState, digest: TickSink): void {
  adoptByPolicy(state);
  openByPolicy(state, digest);
  for (const negotiation of [...state.negotiations]) {
    if (isMandated(negotiation)) runMandate(state, negotiation, digest);
  }
}
