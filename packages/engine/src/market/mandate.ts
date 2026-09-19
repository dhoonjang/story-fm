import type {
  GamePlayer,
  MandateLimit,
  MarketCard,
  Negotiation,
  NegotiationKind,
  NegotiationMandate,
  Persona,
  TickSink,
} from "@story-fm/domain";
import {
  isMandated,
  isPlayerDeal,
  josa,
  josaOf,
  mandateLimitText,
  pushEvent,
} from "@story-fm/domain";
import type { CommandResult, MarketCommandResult } from "../commands";
import { diffDays } from "../competition/calendar";
import { formatMoney } from "../club/finance";
import { pickAnyPlayer } from "../core/player-ref";
import { playerById, pushNarrative, teamName, type GameState } from "../core/state";
import { delegateById, delegateByName, delegateTitleOf, headCoachOf } from "../world/persona";
import { renewalYearsExpectation } from "./counter-bounds";
import { counterpartyAnchor, personalAnchor, settleCounterparty } from "./counterparty";
import { renewalExpectation, severanceOf } from "./market";
import {
  acceptDeal,
  answerIncomingOffer,
  counterpartOf,
  directionField,
  incomingOffer,
  negotiationKindKo,
  offerPlayerOut,
  openNegotiationFor,
  openRelease,
  openRenewal,
  pendingOffer,
  personalAwaiting,
  proposePersonal,
  quotedFee,
  sendOffer,
  splitLabel,
  standingCounter,
  standingDeadlineOf,
  suggestTerms,
} from "./negotiation";

/**
 * **위임 — 담당자가 대신 앉는 협상** (docs/simulation/transfer.md §12-4).
 *
 * 감독이 협상 하나를 수석코치·코치·스카우트에게 **한도를 주고** 맡기면 그 협상에
 * 위임장(`Negotiation.mandate`)이 붙고, 그 뒤의 라운드는 감독 턴 없이 여기서 굴러
 * 합의·결렬·되돌림 중 하나로 끝난다. 담당자는 LLM이 아니다 — 상대의 답은 앵커로
 * 굳고(편지를 열지 않는다), 한도 안이면 받고, 넘으면 한도 쪽으로 반씩 다가가 되부르며,
 * 한도를 넘는 요구가 거듭되거나 상대가 기한을 당기면 감독에게 되돌린다. 받고 되부르고
 * 서명하는 명령은 감독이 직접 부를 때의 것이라 위임이 여는 관문은 하나도 없다.
 */

/** 한도를 넘는 요구가 이 횟수에 이르면 담당자가 감독에게 되돌린다 — 한 번은 되부른다 */
export const MANDATE_HAND_BACK_AT = 2;
/** 한도 쪽으로 반씩 다가갈 때 돈을 맞추는 단위 */
export const MANDATE_MONEY_STEP = 1_000;
/** 매듭·결렬·무산·되돌림이 담당자의 사실로 스냅샷에 남는 날수 */
export const MANDATE_REPORT_DAYS = 3;

/**
 * **한도 쪽으로 반씩** — 지금 값과 한도의 중간을 `unit`으로 맞춘 값.
 *
 * 한도를 넘지 않고, 한도의 반대쪽으로도 움직이지 않는다. 지금 값이 이미 한도면
 * 그대로다 — 부르는 쪽이 「움직이지 않았다」로 읽어 감독에게 되돌린다.
 */
export function stepToward(current: number, limit: number, unit = MANDATE_MONEY_STEP): number {
  const mid = current + (limit - current) / 2;
  const snapped = Math.round(mid / unit) * unit;
  return limit >= current
    ? Math.min(limit, Math.max(current, snapped))
    : Math.max(limit, Math.min(current, snapped));
}

export interface DelegateInput {
  /** 담당자 — 감독이 부른 이름 그대로, 또는 직책(수석코치·코치·스카우트) */
  to: string;
  negotiationId?: string;
  playerId?: string;
  kind?: NegotiationKind;
  /** 내보내는 딜을 새로 열 때의 상대 구단 */
  teamId?: string;
  /** 이적료·임대료·정산금의 한도 — 데려오는 딜·해지는 상한, 내보내는 딜은 하한 */
  fee?: number;
  weeklyWage?: number;
  years?: number;
}

export interface MandateFacts {
  /** 담당자의 이름 — 화자 태그의 속성이 된다 (people.md §3) */
  name: string;
  facts: string[];
}

/** 내보내는 갈래 — 담당자가 받아야 하는 값은 하한이다 */
function isOutgoing(kind: NegotiationKind): boolean {
  return kind === "sell" || kind === "loan_out";
}

/** 그 갈래의 돈 이름 — 요약 줄과 같은 낱말이다 */
function moneyKo(kind: NegotiationKind): string {
  if (kind === "release") return "정산금";
  return kind === "loan" || kind === "loan_out" ? "임대료" : "이적료";
}

/**
 * **명령이 옮긴 뒤의 상태** — 지금 장부의 값이다.
 *
 * 함수를 지나는 이유는 좁히기 때문이다: `status === "agreed"` 가지 안에서 `acceptDeal`을
 * 부르면 그 명령이 상태를 `completed`로 옮기는데, 타입은 여전히 `"agreed"`로 좁혀져 있어
 * 그 뒤의 비교가 「겹치지 않는 비교」가 된다. 읽는 자리를 한 번 감싸면 장부가 답한다.
 */
function statusAfter(negotiation: Negotiation): Negotiation["status"] {
  return negotiation.status;
}

/** 위임장이 든 담당자 — 그 사람이 떠났으면 수석코치가 그 자리에 선다 (people.md §3) */
function delegateOf(state: GameState, mandate: NegotiationMandate): Persona {
  return delegateById(state, mandate.to) ?? headCoachOf(state);
}

/** 사건과 사실이 부르는 담당자 — 「코치 김철수」 */
function delegateLabel(person: Persona): string {
  const title = delegateTitleOf(person);
  return title.length > 0 ? `${title} ${person.name}` : person.name;
}

/**
 * 감독이 부른 한도를 갈래의 위임장으로 — 데려오는 딜·재계약·해지는 상한, 내보내는 딜은
 * 하한이고 하한은 돈 하나다. 비운 축은 한도가 없는 축이다.
 */
function limitsOf(
  kind: NegotiationKind,
  input: Pick<DelegateInput, "fee" | "weeklyWage" | "years">,
): Pick<NegotiationMandate, "ceiling" | "floor"> {
  if (isOutgoing(kind)) {
    return input.fee === undefined ? {} : { floor: { fee: Math.round(input.fee) } };
  }
  const ceiling: MandateLimit = {
    // 재계약에는 이적료가 없다 — 그 자리에 부른 값은 한도가 아니다
    ...(input.fee === undefined || kind === "renew" ? {} : { fee: Math.round(input.fee) }),
    // 해지에는 주급·연수의 축이 없다
    ...(input.weeklyWage === undefined || kind === "release"
      ? {}
      : { weeklyWage: Math.round(input.weeklyWage) }),
    ...(input.years === undefined || kind === "release" ? {} : { contractYears: input.years }),
  };
  return Object.keys(ceiling).length === 0 ? {} : { ceiling };
}

/**
 * **한도 없는 위임은 열리지 않는다** — 갈래마다 서야 하는 한도 하나가 비었으면 그 갈래의
 * 자를 한 줄로 돌려준다 (transfer.md §1 「액수는 감독이 부른 것만 실린다」와 같은 규약).
 */
function missingLimitOf(
  state: GameState,
  player: GamePlayer,
  kind: NegotiationKind,
  limits: Pick<NegotiationMandate, "ceiling" | "floor">,
): string | null {
  const who = player.name;
  if (isOutgoing(kind)) {
    if (limits.floor?.fee !== undefined) return null;
    return (
      `${who} ${negotiationKindOf(kind)}은 하한 없이 맡길 수 없습니다 — 얼마 아래로는 받지 않을지 말해야 합니다. ` +
      `자: ${kind === "sell" ? "호가" : "임대료"} ${formatMoney(quotedFee(state, player, kind))}`
    );
  }
  if (kind === "renew") {
    if (limits.ceiling?.weeklyWage !== undefined) return null;
    return (
      `${who} 재계약은 주급 상한 없이 맡길 수 없습니다 — 자: 재계약 기대 주급 ` +
      `${formatMoney(renewalExpectation(state, player))}`
    );
  }
  if (limits.ceiling?.fee !== undefined) return null;
  if (kind === "release") {
    return (
      `${who} 해지는 정산금 상한 없이 맡길 수 없습니다 — 자: 기대 정산금 ` +
      `${formatMoney(severanceOf(state, player.id))}`
    );
  }
  return (
    `${who} ${negotiationKindOf(kind)}은 ${moneyKo(kind)} 상한 없이 맡길 수 없습니다 — 자: ` +
    `${kind === "loan" ? "임대료" : "요구가"} ${formatMoney(quotedFee(state, player, kind))}`
  );
}

/** 갈래의 이름 — 협상이 아직 없어 `negotiationKindKo`를 부를 수 없는 자리 */
function negotiationKindOf(kind: NegotiationKind): string {
  return negotiationKindKo({ kind } as Negotiation);
}

/** 한도 안으로 — 상한은 이하, 하한은 이상 */
const capAt = (value: number, ceiling?: number) =>
  ceiling === undefined ? value : Math.min(value, ceiling);

/**
 * **담당자의 첫 제시** — 코어의 자를 한도 안으로 자른 값이다 (transfer.md §12-4). 한도는
 * 감독이 부른 숫자이고 자는 코어가 아는 값이라 지어낸 결정이 아니다. 협상이 없으면 이
 * 명령이 협상을 연다.
 */
function openingOffer(
  state: GameState,
  player: GamePlayer,
  kind: NegotiationKind,
  limits: Pick<NegotiationMandate, "ceiling" | "floor">,
  teamId: string | undefined,
): MarketCommandResult {
  const ceiling = limits.ceiling ?? {};
  if (kind === "renew") {
    return openRenewal(state, {
      playerId: player.id,
      weeklyWage: capAt(renewalExpectation(state, player), ceiling.weeklyWage),
      years: ceiling.contractYears ?? renewalYearsExpectation(state, player),
    });
  }
  if (kind === "release") {
    return openRelease(state, {
      playerId: player.id,
      severance: capAt(severanceOf(state, player.id), ceiling.fee),
    });
  }
  if (isOutgoing(kind)) {
    if (teamId === undefined) {
      return {
        ok: false,
        message: `${player.name}${josaOf(player.name, "을/를")} 내보내는 협상은 상대 구단이 있어야 맡길 수 있습니다`,
      };
    }
    return offerPlayerOut(state, {
      playerId: player.id,
      teamId,
      // 하한 아래로는 부르지 않는다 — 첫 제시가 곧 담당자가 받을 최저선 위다
      fee: Math.max(quotedFee(state, player, kind), limits.floor?.fee ?? 0),
      ...(kind === "loan_out" ? { loan: true } : {}),
    });
  }
  const base = suggestTerms(state, player.id);
  if (!base) return { ok: false, message: "선수를 찾지 못했습니다" };
  return sendOffer(state, {
    playerId: player.id,
    fee: capAt(quotedFee(state, player, kind), ceiling.fee),
    weeklyWage: capAt(base.weeklyWage, ceiling.weeklyWage),
    years: ceiling.contractYears ?? base.years,
    kind: kind === "loan" ? "loan" : "buy",
  });
}

/** 위임 카드 — 맡긴 날과 걷은 날 같은 꼴이다 (market-card.ts) */
function mandateCard(
  state: GameState,
  negotiation: Negotiation,
  player: GamePlayer,
  mandate: NegotiationMandate,
  revoked: boolean,
): MarketCard {
  const person = delegateOf(state, mandate);
  return {
    kind: "mandate",
    playerId: player.id,
    playerName: player.name,
    counterpart: counterpartOf(negotiation, player),
    ...directionField(negotiation.kind),
    ...(negotiation.kind === "loan" || negotiation.kind === "loan_out" ? { loan: true } : {}),
    ...(negotiation.precontract === true ? { precontract: true } : {}),
    dueOn: negotiation.expiresOn,
    mandate: {
      to: person.name,
      title: delegateTitleOf(person),
      limit: mandateLimitText(mandate, negotiation.kind),
      ...(revoked ? { revoked: true } : {}),
    },
  };
}

/**
 * 협상을 담당자에게 맡긴다 — `market_orders`의 `delegate_negotiation`.
 *
 * 이름을 수석코치·스태프에서 풀고, 한도 없으면 자를 돌려주고, 협상이 없으면 코어 자의 첫
 * 제시로 연다. 맡긴 자리에 답이나 조정이 이미 서 있으면 그 자리에서 한 번 굴린다 — 감독이
 * `❗`를 보고 맡긴 협상이 다음 tick까지 그대로 서 있으면 맡긴 뜻이 없다.
 */
export function delegateNegotiation(state: GameState, input: DelegateInput): MarketCommandResult {
  const person = delegateByName(state, input.to);
  if (!person) {
    return {
      ok: false,
      message:
        `"${input.to}" — 담당자를 찾지 못했습니다. 협상을 맡을 수 있는 사람은 수석코치·코치·` +
        `스카우트입니다 (이름이나 직책으로)`,
    };
  }
  let negotiation: Negotiation | null;
  let player: GamePlayer | null;
  if (input.negotiationId !== undefined) {
    negotiation = state.negotiations.find((n) => n.id === input.negotiationId) ?? null;
    if (!negotiation) {
      return {
        ok: false,
        message: `협상 "${input.negotiationId}"${josaOf(input.negotiationId, "을/를")} 찾지 못했습니다`,
      };
    }
    player = playerById(state, negotiation.gamePlayerId);
  } else if (input.playerId !== undefined) {
    const pick = pickAnyPlayer(state, input.playerId);
    if (!pick.ok) return { ok: false, message: pick.message };
    player = pick.player;
    const open = openNegotiationFor(state, player.id);
    // 갈래를 불렀으면 그 갈래의 협상이어야 한다 — 다른 갈래가 열려 있으면 여는 명령이 갈등을 알린다
    negotiation = open && (input.kind === undefined || open.kind === input.kind) ? open : null;
  } else {
    return {
      ok: false,
      message: "누구의 협상을 맡기는지 알 수 없습니다 — negotiationId나 playerId가 필요합니다",
    };
  }
  if (!player) return { ok: false, message: "선수를 찾지 못했습니다" };
  if (negotiation) {
    if (negotiation.status !== "open") {
      return { ok: false, message: `이미 끝난 협상입니다 (${negotiation.status})` };
    }
    // 조항이 발동한 매각은 감독도 답할 것이 없다 — 맡길 것도 없다 (transfer.md §12-3)
    if (negotiation.buyout === true) {
      return {
        ok: false,
        message: `${player.name} 건은 바이아웃 조항이 발동한 매각입니다 — 맡길 것이 없습니다`,
      };
    }
    if (state.pendingNegotiation?.negotiationId === negotiation.id) {
      return {
        ok: false,
        message: `${player.name} 협상에는 감독이 마주 앉아 있습니다 — 먼저 일어서야 맡길 수 있습니다`,
      };
    }
  }
  const kind: NegotiationKind =
    negotiation?.kind ?? input.kind ?? (player.teamId === state.userTeamId ? "renew" : "buy");
  const limits = limitsOf(kind, input);
  const missing = missingLimitOf(state, player, kind, limits);
  if (missing) return { ok: false, message: missing };

  let opened: string | null = null;
  if (!negotiation) {
    const first = openingOffer(state, player, kind, limits, input.teamId);
    if (!first.ok) return first;
    opened = first.message;
    negotiation = openNegotiationFor(state, player.id);
    if (!negotiation) return { ok: false, message: `${player.name} 협상이 열리지 않았습니다` };
  }
  const mandate: NegotiationMandate = {
    to: person.characterId,
    ...limits,
    since: state.date,
    until: negotiation.expiresOn,
  };
  negotiation.mandate = mandate;
  // 맡긴 자리에 서 있던 답·조정은 그 자리에서 담당자가 굴린다
  const lines: string[] = [];
  runMandate(state, negotiation, lines);
  const label = delegateLabel(person);
  const card = mandateCard(state, negotiation, player, mandate, false);
  return {
    ok: true,
    payload: card,
    message:
      `${player.name} ${negotiationKindKo(negotiation)} 협상을 ${label}에게 맡겼습니다 — ` +
      `한도 ${mandateLimitText(mandate, negotiation.kind)}, ${negotiation.expiresOn}까지.` +
      (opened ? ` ${opened}` : "") +
      (lines.length > 0 ? ` ${lines.join(" ")}` : ""),
  };
}

/**
 * 맡긴 협상을 감독이 되가져온다 — `revoke_mandate`. 걷힌 협상은 위임 전과 같은 장부다:
 * 감독이 답할 차례면 그 자리에서 `❗`가 선다.
 */
export function revokeMandate(state: GameState, negotiationId: string): MarketCommandResult {
  const negotiation = state.negotiations.find((n) => n.id === negotiationId);
  if (!negotiation) {
    return {
      ok: false,
      message: `협상 "${negotiationId}"${josaOf(negotiationId, "을/를")} 찾지 못했습니다`,
    };
  }
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return { ok: false, message: "선수를 찾지 못했습니다" };
  const mandate = negotiation.mandate;
  if (!mandate || !isMandated(negotiation)) {
    return { ok: false, message: `${player.name} 협상은 지금 담당자에게 맡겨진 협상이 아닙니다` };
  }
  const card = mandateCard(state, negotiation, player, mandate, true);
  delete negotiation.mandate;
  return {
    ok: true,
    payload: card,
    message:
      `${delegateLabel(delegateOf(state, mandate))}에게 맡긴 ${player.name} ` +
      `${negotiationKindKo(negotiation)} 협상을 걷었습니다 — 이제 감독의 테이블입니다`,
  };
}

/** 상대가 지금 부르고 있는 값 — 되부른 조정 · 개인 조건의 되부름 · 매각에 들어온 오퍼 */
interface Demand {
  source: "counter" | "personal" | "incoming";
  fee: number;
  weeklyWage: number;
  contractYears: number;
  /** 라운드의 날짜 — 위임 뒤의 요구만 세는 자리가 읽는다 */
  on: string;
}

function demandsOf(negotiation: Negotiation): Demand[] {
  const out: Demand[] = [];
  for (const round of negotiation.rounds) {
    // 상대 라운드 중 값을 부른 것 — 되부른 조정과, 우리가 아직 답하지 않았거나 되불렀던 들어온 오퍼
    if (round.by !== "them" || round.verdict === "accept" || round.verdict === "reject") continue;
    out.push({
      source: round.verdict === "counter" && !isOutgoing(negotiation.kind) ? "counter" : "incoming",
      fee: round.fee,
      weeklyWage: round.weeklyWage,
      contractYears: round.contractYears,
      on: round.date,
    });
  }
  const personal = negotiation.personal?.counter;
  if (personal && negotiation.personal?.agreedOn === undefined) {
    out.push({
      source: "personal",
      fee: 0,
      weeklyWage: personal.weeklyWage,
      contractYears: personal.contractYears,
      on: personal.on,
    });
  }
  return out;
}

/** 지금 감독의 차례를 만드는 요구 — 없으면 null */
function standingDemand(negotiation: Negotiation): Demand | null {
  const counter = standingCounter(negotiation);
  if (counter) {
    return {
      source: isOutgoing(negotiation.kind) ? "incoming" : "counter",
      fee: counter.fee,
      weeklyWage: counter.weeklyWage,
      contractYears: counter.contractYears,
      on: counter.date,
    };
  }
  const incoming = incomingOffer(negotiation);
  if (incoming) {
    return {
      source: "incoming",
      fee: incoming.fee,
      weeklyWage: incoming.weeklyWage,
      contractYears: incoming.contractYears,
      on: incoming.date,
    };
  }
  const personal = negotiation.personal?.counter;
  if (personal && negotiation.personal?.agreedOn === undefined && !pendingOffer(negotiation)) {
    return {
      source: "personal",
      fee: 0,
      weeklyWage: personal.weeklyWage,
      contractYears: personal.contractYears,
      on: personal.on,
    };
  }
  return null;
}

type Axis = "fee" | "weeklyWage" | "contractYears";

/**
 * 요구가 한도를 넘은 축들 — 상한은 **이하**가 안, 하한은 **이상**이 안이다. 한도를 정확히
 * 맞춘 요구는 받는다. 재계약·해지의 라운드에 실린 0은 값이 아니라 빈 칸이다.
 */
function exceededAxes(demand: Demand, mandate: NegotiationMandate, kind: NegotiationKind): Axis[] {
  const out: Axis[] = [];
  if (mandate.floor?.fee !== undefined && demand.fee < mandate.floor.fee) out.push("fee");
  const ceiling = mandate.ceiling;
  if (!ceiling) return out;
  if (ceiling.fee !== undefined && kind !== "renew" && demand.fee > ceiling.fee) out.push("fee");
  if (
    ceiling.weeklyWage !== undefined &&
    kind !== "release" &&
    demand.weeklyWage > ceiling.weeklyWage
  ) {
    out.push("weeklyWage");
  }
  if (
    ceiling.contractYears !== undefined &&
    kind !== "release" &&
    demand.contractYears > ceiling.contractYears
  ) {
    out.push("contractYears");
  }
  return out;
}

/** 위임 뒤에 온 요구 중 한도를 넘은 것의 수 — 되돌림의 눈금이다 */
function overLimitCount(negotiation: Negotiation, mandate: NegotiationMandate): number {
  return demandsOf(negotiation).filter(
    (d) => d.on >= mandate.since && exceededAxes(d, mandate, negotiation.kind).length > 0,
  ).length;
}

/** 우리 마지막 제시 — 되부를 때 출발점이다. 없으면(들어온 오퍼가 첫 줄) 코어의 자다 */
function ourLastOf(
  state: GameState,
  negotiation: Negotiation,
  player: GamePlayer,
): {
  fee: number;
  weeklyWage: number;
  contractYears: number;
  round: Negotiation["rounds"][number] | null;
} {
  const round = [...negotiation.rounds].reverse().find((r) => r.by === "us") ?? null;
  if (round) {
    return {
      fee: round.fee,
      weeklyWage: round.weeklyWage,
      contractYears: round.contractYears,
      round,
    };
  }
  const personal = negotiation.personal;
  if (personal) {
    return {
      fee: 0,
      weeklyWage: personal.weeklyWage,
      contractYears: personal.contractYears,
      round: null,
    };
  }
  const base = suggestTerms(state, player.id);
  return {
    fee: quotedFee(state, player, negotiation.kind),
    weeklyWage: base?.weeklyWage ?? 0,
    contractYears: base?.years ?? 0,
    round: null,
  };
}

/** 이 갈래에서 한도의 값 — 넘은 축마다 다가갈 목표다 */
function limitOfAxis(mandate: NegotiationMandate, axis: Axis): number | undefined {
  if (mandate.floor) return axis === "fee" ? mandate.floor.fee : undefined;
  return mandate.ceiling?.[axis];
}

function handBack(
  state: GameState,
  negotiation: Negotiation,
  mandate: NegotiationMandate,
  player: GamePlayer,
  reason: string,
  digest: TickSink,
): void {
  mandate.handedBack = { on: state.date, reason };
  const kindKo = negotiationKindKo(negotiation);
  pushEvent(
    digest,
    isPlayerDeal(negotiation.kind) ? "contract" : "interest",
    `${delegateLabel(delegateOf(state, mandate))} — ${player.name} ${kindKo} 협상을 감독에게 되돌렸습니다: ${reason}`,
  );
  // 오늘 답해야 하는 일의 눈금 — 답 도착과 같은 3이다 (people.md §9)
  pushNarrative(state, `${player.name} ${kindKo} 위임 되돌아옴 — ${reason}`, 3);
}

/** 라운드 하나의 조건 한 줄 — 갈래의 돈으로 말한다 */
function termsText(
  kind: NegotiationKind,
  terms: { fee: number; weeklyWage: number; contractYears: number; paymentYears?: number },
): string {
  if (kind === "renew") return `주급 ${formatMoney(terms.weeklyWage)} · ${terms.contractYears}년`;
  if (kind === "release")
    return `정산금 ${formatMoney(terms.fee)}${splitLabel(terms.paymentYears)}`;
  const money = `${moneyKo(kind)} ${formatMoney(terms.fee)}${splitLabel(terms.paymentYears)}`;
  return isOutgoing(kind) ? money : `${money} · 주급 ${formatMoney(terms.weeklyWage)}`;
}

/**
 * **한도를 넘은 요구에 되부른다** — 넘은 축은 한도 쪽으로 반씩, 넘지 않은 축은 상대가 부른
 * 값 그대로. 지위·분할은 우리 마지막 제시의 것이다 — 담당자는 감독이 하지 않은 약속을
 * 걸지 않는다.
 */
function approach(
  state: GameState,
  negotiation: Negotiation,
  mandate: NegotiationMandate,
  player: GamePlayer,
  demand: Demand,
  exceeded: readonly Axis[],
): CommandResult {
  const ours = ourLastOf(state, negotiation, player);
  const next = {
    fee: demand.fee,
    weeklyWage: demand.weeklyWage,
    contractYears: demand.contractYears,
  };
  for (const axis of exceeded) {
    const limit = limitOfAxis(mandate, axis);
    if (limit === undefined) continue;
    // 하한은 아래로 다가가되 하한 아래로는 부르지 않는다 — 그 아래는 담당자가 받지 않는 값이다
    const stepped = stepToward(
      ours[axis],
      limit,
      axis === "contractYears" ? 1 : MANDATE_MONEY_STEP,
    );
    next[axis] = mandate.floor ? Math.max(limit, stepped) : stepped;
  }
  // 넘은 축이 하나도 움직이지 않았으면 부를 칸이 없다 — 되부르는 것은 같은 말의 반복이다
  const moved = ours.round === null || exceeded.some((axis) => next[axis] !== ours[axis]);
  if (!moved) {
    return {
      ok: false,
      message: `더 부를 칸이 없습니다 — 제시가 이미 한도(${mandateLimitText(mandate, negotiation.kind)})에 닿았습니다`,
    };
  }
  const paymentYears = ours.round?.paymentYears;
  const squadStatus = ours.round?.squadStatus;
  const kind = negotiation.kind;
  if (demand.source === "personal") {
    return proposePersonal(state, {
      negotiationId: negotiation.id,
      weeklyWage: next.weeklyWage,
      years: next.contractYears,
      ...(negotiation.personal?.squadStatus === undefined
        ? {}
        : { squadStatus: negotiation.personal.squadStatus }),
    });
  }
  if (kind === "renew") {
    return openRenewal(state, {
      playerId: player.id,
      weeklyWage: next.weeklyWage,
      years: next.contractYears,
      ...(squadStatus === undefined ? {} : { squadStatus }),
    });
  }
  if (kind === "release") {
    return openRelease(state, {
      playerId: player.id,
      severance: next.fee,
      ...(paymentYears === undefined ? {} : { paymentYears }),
    });
  }
  if (isOutgoing(kind)) {
    // 감독이 답할 차례의 들어온 오퍼면 그 오퍼에 되부르고, 우리 호가에 온 조정이면 호가를 다시 낸다
    if (incomingOffer(negotiation)) {
      return answerIncomingOffer(state, {
        negotiationId: negotiation.id,
        verdict: "counter",
        fee: next.fee,
      });
    }
    return offerPlayerOut(state, {
      playerId: player.id,
      teamId: negotiation.counterpartTeamId ?? "",
      fee: next.fee,
      ...(kind === "loan_out" ? { loan: true } : {}),
      ...(paymentYears === undefined ? {} : { paymentYears }),
    });
  }
  return sendOffer(state, {
    playerId: player.id,
    fee: next.fee,
    weeklyWage: next.weeklyWage,
    years: next.contractYears,
    kind: kind === "loan" ? "loan" : "buy",
    ...(paymentYears === undefined ? {} : { paymentYears }),
    ...(squadStatus === undefined ? {} : { squadStatus }),
  });
}

/**
 * 위임된 협상 하나를 오늘 굴린다 — tick과 맡기는 명령이 같은 문을 지난다.
 *
 * 순서가 뜻이다: 답할 날이 된 답을 앵커로 굳히고 → 닫혔으면 그날을 적고 → 합의면 서명하고
 * → 상대가 기한을 당겼으면 되돌리고 → 서 있는 요구를 한도로 가르고 → 아무것도 없으면
 * 첫 제시를 넣는다.
 */
function runMandate(state: GameState, negotiation: Negotiation, digest: TickSink): void {
  const mandate = negotiation.mandate;
  if (!mandate || mandate.handedBack !== undefined || mandate.settledOn !== undefined) return;
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return;
  const label = delegateLabel(delegateOf(state, mandate));
  const kindKo = negotiationKindKo(negotiation);
  const eventKind = isPlayerDeal(negotiation.kind) ? "contract" : "interest";
  const say = (text: string) => pushEvent(digest, eventKind, `${label} — ${text}`);

  // ① 답할 날이 된 답은 앵커로 굳는다 — 편지를 열지 않는다
  if (negotiation.status === "open") {
    const offer = pendingOffer(negotiation);
    const personal = offer === null ? personalAwaiting(negotiation) : null;
    const due =
      (offer !== null && offer.respondsOn !== null && offer.respondsOn <= state.date) ||
      (personal !== null && personal.respondsOn <= state.date);
    if (due) {
      const anchor = counterpartyAnchor(state, negotiation) ?? personalAnchor(state, negotiation);
      if (anchor) {
        const settled = settleCounterparty(state, anchor);
        if (!settled.result.ok) {
          handBack(state, negotiation, mandate, player, settled.result.message, digest);
          return;
        }
      }
    }
  }

  // ② 닫힌 협상 — 그날을 적는다. 결렬과 무산은 감독이 앉았을 때와 같은 값이다
  if (negotiation.status === "rejected" || negotiation.status === "expired") {
    mandate.settledOn = state.date;
    say(
      negotiation.status === "rejected"
        ? `${player.name} ${kindKo} 협상이 결렬됐습니다 — 상대가 문을 닫았습니다`
        : `${player.name} ${kindKo} 협상이 기한을 넘겨 무산됐습니다`,
    );
    return;
  }
  if (negotiation.status === "completed") {
    mandate.settledOn = state.date;
    const last = [...negotiation.rounds].reverse().find((r) => r.by === "us");
    say(
      `${player.name} ${kindKo}${josa(kindKo, "을/를")} 매듭지었습니다` +
        (last ? ` — ${termsText(negotiation.kind, last)}` : ""),
    );
    return;
  }

  // ③ 합의 — 담당자가 서명한다. 소견이 붙은 검진은 감독의 결정이다
  if (negotiation.status === "agreed") {
    if (negotiation.medical?.status === "flagged") {
      handBack(
        state,
        negotiation,
        mandate,
        player,
        "메디컬 소견이 붙었습니다 — 강행할지는 감독의 결정입니다",
        digest,
      );
      return;
    }
    if (negotiation.medical?.status === "scheduled") return;
    const signed = acceptDeal(state, negotiation.id);
    if (!signed.ok) {
      handBack(state, negotiation, mandate, player, signed.message, digest);
      return;
    }
    // 서명이 계약까지 갔는지는 명령이 옮긴 상태로 읽는다 — 재계약은 그날 서고 이적은 검진이 잡힌다
    if (statusAfter(negotiation) === "completed") {
      mandate.settledOn = state.date;
      const last = [...negotiation.rounds].reverse().find((r) => r.by === "us");
      say(
        `${player.name} ${kindKo}${josa(kindKo, "을/를")} 매듭지었습니다` +
          (last ? ` — ${termsText(negotiation.kind, last)}` : ""),
      );
    } else {
      say(`${player.name} ${kindKo}에 합의했습니다 — ${signed.message}`);
    }
    return;
  }
  if (negotiation.status !== "open") return;

  // ④ 상대가 기한을 당겼다 — 시계를 세울 일은 감독의 것이다
  const deadline = standingDeadlineOf(negotiation);
  if (deadline !== null) {
    handBack(state, negotiation, mandate, player, `상대가 기한을 ${deadline}로 당겼습니다`, digest);
    return;
  }

  // ⑤ 서 있는 요구 — 한도 안이면 받고, 넘으면 반씩 다가가고, 거듭되면 되돌린다
  const demand = standingDemand(negotiation);
  if (demand) {
    const exceeded = exceededAxes(demand, mandate, negotiation.kind);
    if (exceeded.length === 0) {
      const taken =
        demand.source === "incoming" && incomingOffer(negotiation)
          ? answerIncomingOffer(state, { negotiationId: negotiation.id, verdict: "accept" })
          : acceptDeal(state, negotiation.id);
      if (!taken.ok) {
        handBack(state, negotiation, mandate, player, taken.message, digest);
        return;
      }
      say(
        `${player.name} ${kindKo} — 상대의 조건(${termsText(negotiation.kind, demand)})이 한도 안이라 그대로 받았습니다`,
      );
      // 들어온 오퍼를 받으면 합의다 — 서명은 같은 자리에서 한다
      if (statusAfter(negotiation) === "agreed") runMandate(state, negotiation, digest);
      return;
    }
    if (overLimitCount(negotiation, mandate) >= MANDATE_HAND_BACK_AT) {
      handBack(
        state,
        negotiation,
        mandate,
        player,
        `한도(${mandateLimitText(mandate, negotiation.kind)})를 넘는 요구가 거듭됐습니다 — 마지막 요구 ${termsText(negotiation.kind, demand)}`,
        digest,
      );
      return;
    }
    const resent = approach(state, negotiation, mandate, player, demand, exceeded);
    if (!resent.ok) {
      handBack(state, negotiation, mandate, player, resent.message, digest);
      return;
    }
    const ours = [...negotiation.rounds].reverse().find((r) => r.by === "us");
    say(
      `${player.name} ${kindKo} — 상대가 ${termsText(negotiation.kind, demand)}${josa("", "을/를").trim()} 불러 한도를 넘었습니다. ` +
        (ours ? `${termsText(negotiation.kind, ours)}로 되불렀습니다` : "다시 제안했습니다"),
    );
    return;
  }

  // ⑥ 오퍼도 개인 조건도 없는 자리 — 담당자가 첫 제시를 넣는다
  if (negotiation.rounds.length === 0 && !negotiation.personal) {
    const first = openingOffer(
      state,
      player,
      negotiation.kind,
      mandate,
      negotiation.counterpartTeamId ?? undefined,
    );
    if (!first.ok) {
      handBack(state, negotiation, mandate, player, first.message, digest);
      return;
    }
    say(`${player.name} ${kindKo} — 첫 제시를 넣었습니다. ${first.message}`);
  }
}

/**
 * **매일의 tick** — 위임된 협상마다 담당자의 수를 굴린다 (기한 처리 뒤, 답 도착 알림 앞).
 * 닫힌 협상도 한 번은 지난다 — 매듭·결렬·무산의 날을 위임장에 적어야 며칠 동안 담당자의
 * 사실로 선다.
 */
export function runMandates(state: GameState, digest: TickSink): void {
  for (const negotiation of state.negotiations) {
    const mandate = negotiation.mandate;
    if (!mandate || mandate.handedBack !== undefined || mandate.settledOn !== undefined) continue;
    runMandate(state, negotiation, digest);
  }
}

/** 며칠 안의 날인가 — 결과가 담당자의 사실로 서는 창 */
function recent(state: GameState, on: string | undefined): boolean {
  return on !== undefined && diffDays(on, state.date) <= MANDATE_REPORT_DAYS;
}

/**
 * **담당자의 사실** — 그 사람이 쥔 협상의 지금과 며칠 안의 결과, 이름별로 (people.md §3 화자
 * 표 · agents.md §6 `<mandates name>`). 사실만이다 — 지시문도 도구 이름도 없다.
 */
export function mandateFacts(state: GameState): MandateFacts[] {
  const byName = new Map<string, string[]>();
  for (const negotiation of state.negotiations) {
    const mandate = negotiation.mandate;
    if (!mandate) continue;
    const live = isMandated(negotiation);
    if (!live && !recent(state, mandate.handedBack?.on) && !recent(state, mandate.settledOn)) {
      continue;
    }
    const player = playerById(state, negotiation.gamePlayerId);
    if (!player) continue;
    const person = delegateOf(state, mandate);
    const fact = factOf(state, negotiation, mandate, player);
    byName.set(person.name, [...(byName.get(person.name) ?? []), fact]);
  }
  return [...byName].map(([name, facts]) => ({ name, facts }));
}

function factOf(
  state: GameState,
  negotiation: Negotiation,
  mandate: NegotiationMandate,
  player: GamePlayer,
): string {
  const kind = negotiation.kind;
  const who = isPlayerDeal(kind)
    ? player.name
    : `${player.name}(${teamName(negotiation.counterpartTeamId ?? player.teamId)})`;
  const head = `${who} ${negotiationKindKo(negotiation)} — 한도 ${mandateLimitText(mandate, kind)}`;
  if (mandate.handedBack) {
    return `${head} · ${mandate.handedBack.on} 감독에게 되돌림: ${mandate.handedBack.reason}`;
  }
  const last = [...negotiation.rounds].reverse().find((r) => r.by === "us");
  if (negotiation.status === "completed") {
    return `${head} · ${mandate.settledOn ?? state.date} 매듭${last ? ` — ${termsText(kind, last)}` : ""}`;
  }
  if (negotiation.status === "rejected") return `${head} · ${mandate.settledOn ?? state.date} 결렬`;
  if (negotiation.status === "expired") {
    return `${head} · ${mandate.settledOn ?? state.date} 기한을 넘겨 무산`;
  }
  if (negotiation.status === "agreed") {
    return `${head} · 합의${last ? ` ${termsText(kind, last)}` : ""} — 메디컬 ${negotiation.medical?.onDate ?? "대기"}`;
  }
  const offer = pendingOffer(negotiation);
  if (offer) {
    return `${head} · 우리 제시 ${termsText(kind, offer)} · 답 ${offer.respondsOn ?? state.date}`;
  }
  const personal = personalAwaiting(negotiation);
  if (personal) {
    return `${head} · 개인 조건 제안 주급 ${formatMoney(personal.weeklyWage)} · ${personal.contractYears}년 · 답 ${personal.respondsOn}`;
  }
  return `${head} · 진행 중 (${negotiation.expiresOn}까지)`;
}
