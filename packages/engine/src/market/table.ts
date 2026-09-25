import type {
  DealTerm,
  Negotiation,
  NegotiationTable,
  PitchClaim,
  TableLine,
  TableSpeaker,
  TableStance,
} from "@story-fm/domain";
import {
  PITCH_CLAIM_KO,
  TABLE_LINE_MAX,
  TABLE_STANCE_KO,
  dealTermLabel,
  isPlayerDeal,
  josaOf,
} from "@story-fm/domain";
import type { MarketCard } from "@story-fm/domain";
import { playerById, pushNarrative, type GameState, type PendingNegotiation } from "../core/state";
import { journal } from "../core/journal";
import { agentProfileOf } from "./agent-profile";
import { directorArchetypeOf } from "../world/persona";
import {
  clampAsks,
  counterpartyAnchor,
  personalAnchor,
  settleCounterparty,
  tableVoicesOf,
  termAsksOf,
  type CounterpartyAnchor,
  type CounterpartyRulingInput,
  type CounterpartyVoice,
  type TermAsk,
} from "./counterparty";
import { isMandated } from "@story-fm/domain";
import { openTalks, pendingOffer, personalAwaiting, type TalksKind } from "./negotiation";
import { askTerms, askableKindsOf } from "./terms";
import { LATITUDE_PER_CLAIM, evaluatePitch } from "./persuasion";

/**
 * **협상 방 — 감독이 그 자리에 있는 것이 여는 모드**
 * (docs/simulation/transfer.md §12-2 · docs/llm/agents.md §4-1).
 *
 * 가르는 것은 매체가 아니다 — 사무실인지 전화인지 하루 동안 오간 메일인지는 장면의
 * 것이고, 방이 여는 것은 **감독이 그 라운드에 직접 나선다**는 사실 하나다. 감독이 나서지
 * 않은 라운드는 코어가 앵커로 굳힌다(`settleArrivedResponses` — §12-1).
 *
 * 오퍼와 답은 그대로 협상의 라운드다. 테이블이 더하는 것은 셋이다 — 그 사이의 **말**,
 * 상대가 앉아 있을 **인내**, 그리고 답을 기다리는 오퍼가 **오늘** 답을 받는다는 것.
 * 방이 더하는 것은 라우팅 하나다 — `phase: "negotiation"` · `pendingNegotiation`. 상대의
 * 대사는 방의 GM이 쓰고, 여기 있는 것은 그 대사가 장부에 남길 수 있는 전부다.
 */

/** 앉을 때의 인내 — 대리인 원형의 `patience`가 곱해진다 (법률가형 5 · 제국형 4 · 승부사형 3) */
export const TABLE_PATIENCE_BASE = 4;
/** 인내의 하한 — 한 마디에 일어나는 상대는 없다 */
export const TABLE_PATIENCE_MIN = 2;
/** 이만큼 남으면 다음 한 마디에 일어날 수 있다 — 화면이 색을 갈고 프롬프트가 말에 비친다 */
export const TABLE_PATIENCE_LOW = 1;

/** 테이블의 상대 — 구단 쪽(단장)인가 선수 쪽(에이전트)인가. 화자 토큰과 같은 낱말이다 */
export type TableParty = TableSpeaker;

/**
 * 이 자리의 상대가 테이블에 앉아 있을 인내 — 선수 쪽은 대리인 원형의 `patience`, 구단
 * 쪽은 단장 원형의 `patience`가 곱해진다 (transfer.md §12-2). 자리마다 따로 잰다.
 */
export function tablePatienceOf(
  state: GameState,
  negotiation: Pick<Negotiation, "gamePlayerId" | "counterpartTeamId">,
  party: TableParty,
): number {
  const factor =
    party === "club" && negotiation.counterpartTeamId
      ? directorArchetypeOf(state.seed, negotiation.counterpartTeamId).patience
      : agentProfileOf(state, negotiation.gamePlayerId).patience;
  return Math.max(TABLE_PATIENCE_MIN, Math.round(TABLE_PATIENCE_BASE * factor));
}

/**
 * **이 협상에 앉을 수 있는 상대들** — 열린 축의 주인이다 (`tableVoicesOf`). 영입·임대는 둘,
 * 재계약·해지는 선수 쪽 하나, 매각·임대 송출은 구단 쪽 하나.
 */
export function partiesOf(state: GameState, negotiation: Negotiation): TableParty[] {
  return tableVoicesOf(state, negotiation).map((v) => v.speaker);
}

/** 상대를 적지 않았을 때 앉는 자리 — 돈의 축을 쥔 쪽이 먼저다 */
export function defaultPartyOf(state: GameState, negotiation: Negotiation): TableParty {
  return partiesOf(state, negotiation)[0] ?? "agent";
}

/** 그 자리의 테이블 — 아직 앉지 않았으면 `undefined` */
export function tableOf(negotiation: Negotiation, party: TableParty): NegotiationTable | undefined {
  return negotiation.tables?.[party];
}

/** 그 자리의 테이블을 세운다 — 처음 앉는 자리면 인내가 여기서 정해진다 */
function ensureTable(
  state: GameState,
  negotiation: Negotiation,
  party: TableParty,
): NegotiationTable {
  const standing = tableOf(negotiation, party);
  if (standing) return standing;
  const patience = tablePatienceOf(state, negotiation, party);
  const table: NegotiationTable = {
    openedOn: state.date,
    patience,
    patienceMax: patience,
    lines: [],
  };
  negotiation.tables = { ...(negotiation.tables ?? {}), [party]: table };
  return table;
}

/**
 * 그 자리의 상대가 답할 오퍼인가 — 구단 쪽은 구단이 받는 돈의 오퍼(영입·임대·매각·송출),
 * 선수 쪽은 선수가 상대인 오퍼(재계약·해지)다. 영입의 개인 조건 제안은 선수 쪽의 것이다.
 */
function partyAnswersOffer(negotiation: Negotiation, party: TableParty): boolean {
  return party === "club" ? !isPlayerDeal(negotiation.kind) : isPlayerDeal(negotiation.kind);
}

/** 앉으면 그 자리의 상대가 답할 것이 오늘로 당겨진다 — 다른 자리의 것은 그대로다 */
function pullDue(state: GameState, negotiation: Negotiation, party: TableParty): void {
  if (partyAnswersOffer(negotiation, party)) {
    const offer = pendingOffer(negotiation);
    if (offer && offer.respondsOn !== null && offer.respondsOn > state.date) {
      offer.respondsOn = state.date;
    }
  }
  if (party === "agent") {
    // 개인 조건 제안의 답도 마주 앉은 자리에서는 오늘이다 (§12-3)
    const personal = personalAwaiting(negotiation);
    if (personal && personal.respondsOn > state.date) personal.respondsOn = state.date;
  }
}

/** 모델이 이번 답에서 들은 것 — 코어가 사실 대조하고 인내에 반영한다 */
export interface TableHeard {
  /** 감독의 말투 — 모욕·협박은 인내를 깎는다 */
  tone: "civil" | "hostile";
  /** 감독이 실제로 든 설득 논거 */
  claims: PitchClaim[];
}

/** 모델의 답 — 어느 값도 그대로 믿지 않는다 */
export interface TableReply {
  /** **답 하나에 태도 하나** — 건너편이 한 사람이라 테이블의 온도도 한 자리에서 잰다 */
  stance: TableStance;
  /** 들은 것 — 감독이 그 자리에 있으므로 언제나 들을 말이 있다 */
  heard?: TableHeard;
  /** 테이블에 오퍼가 올라 있을 때만 — 앵커 ± 한도로 잘린다 (counterparty.ts) */
  ruling?: CounterpartyRulingInput;
  /**
   * **상대가 부르는 조건** — 서류가 적은 갈래와 구간 안에서, 한 답에 둘까지
   * (transfer.md §12-3). 오퍼가 없는 답에서도 부를 수 있다.
   */
  asks?: readonly DealTerm[];
}

export interface TableSeat {
  negotiation: Negotiation;
  /** 건너편 — 이 자리에 앉은 상대 */
  party: TableParty;
  table: NegotiationTable;
  /** 답할 오퍼가 올라 있으면 그 앵커 — 개인 조건 제안이면 그 앵커, 없으면 말만 오간다 */
  anchor: CounterpartyAnchor | null;
  /** 이 테이블에서 답하는 목소리 — 하나이거나 둘이다 (`tableVoicesOf`) */
  voices: CounterpartyVoice[];
  /** 상대가 지금 부를 수 있는 조건 — 갈래와 구간 (`termAsksOf`) */
  asks: TermAsk[];
}

export interface TableOutcome {
  ok: true;
  /** GM에게 돌아가는 줄 — 상대의 답과 장부가 적은 것 */
  message: string;
  /** 오퍼가 판정됐으면 그 카드 */
  payload?: MarketCard;
  /** 이 답으로 협상이 끝났는가 */
  closed: boolean;
}

/**
 * 앉는다 — 협상 위에 테이블을 세우고 감독의 말을 적는다.
 *
 * **답을 기다리던 오퍼는 오늘로 당겨진다.** 감독 없이 넣어 둔 오퍼는 며칠 뒤에 답이 오지만
 * 감독이 그 자리에 붙으면 상대는 그 자리에서 답한다 — 그것이 테이블에 앉는 값이다. 그
 * 답은 이어지는 `settleTableReply`가 같은 턴에 낸다.
 */
export function sitAtTable(
  state: GameState,
  negotiationId: string,
  line: string,
  party?: TableParty,
): { ok: false; message: string } | { ok: true; seat: TableSeat } {
  const negotiation = state.negotiations.find((n) => n.id === negotiationId);
  if (!negotiation)
    return {
      ok: false,
      message: `협상 "${negotiationId}"${josaOf(negotiationId, "을/를")} 찾지 못했습니다`,
    };
  if (negotiation.status !== "open") {
    return { ok: false, message: `이미 끝난 협상입니다 (${negotiation.status})` };
  }
  const text = line.trim().slice(0, TABLE_LINE_MAX);
  if (text.length === 0) return { ok: false, message: "감독의 말이 비어 있습니다" };
  const who = party ?? defaultPartyOf(state, negotiation);
  ensureTable(state, negotiation, who).lines.push({ date: state.date, by: "us", text });
  pullDue(state, negotiation, who);
  return { ok: true, seat: seatOf(state, negotiation, who) };
}

/**
 * **말 없이 앉은 자리** — 방의 GM이 상대의 답을 판정할 때 읽는 자리다 (`counterparty_reply`).
 * 감독의 말은 턴이 열릴 때 코어가 이미 적었으므로(`sitAtTable`) 여기서는 줄을 더하지
 * 않고, 테이블이 아직 없으면(제안 폼으로만 오퍼를 넣고 앉은 자리) 인내만 세운다.
 */
export function seatAt(
  state: GameState,
  negotiationId: string,
  party?: TableParty,
): { ok: false; message: string } | { ok: true; seat: TableSeat } {
  const negotiation = state.negotiations.find((n) => n.id === negotiationId);
  if (!negotiation)
    return {
      ok: false,
      message: `협상 "${negotiationId}"${josaOf(negotiationId, "을/를")} 찾지 못했습니다`,
    };
  if (negotiation.status !== "open") {
    return { ok: false, message: `이미 끝난 협상입니다 (${negotiation.status})` };
  }
  const who = party ?? defaultPartyOf(state, negotiation);
  ensureTable(state, negotiation, who);
  pullDue(state, negotiation, who);
  return { ok: true, seat: seatOf(state, negotiation, who) };
}

/**
 * **자리를 읽기만 한다** — 스냅샷 빌더가 장부를 움직이지 않고 앵커·목소리·인내를 본다.
 * 테이블이 아직 없으면(첫 말 전) 앉을 때의 인내가 선다.
 */
export function seatViewOf(
  state: GameState,
  negotiation: Negotiation,
  party: TableParty,
): TableSeat {
  const standing = tableOf(negotiation, party);
  const patience = tablePatienceOf(state, negotiation, party);
  return {
    ...seatOf(state, negotiation, party),
    table: standing ?? { openedOn: state.date, patience, patienceMax: patience, lines: [] },
  };
}

/**
 * 자리 하나 — 협상·테이블·앵커·목소리를 한 자리에서 세운다. **자리가 앵커를 가른다**
 * (transfer.md §12-2): 구단 쪽은 구단 관문으로 오퍼를, 선수 쪽은 선수 관문으로 오퍼(재계약·
 * 해지)나 개인 조건 제안을 판정한다. 목소리는 앉은 한 사람이고, 조건은 선수 쪽만 부른다.
 */
function seatOf(state: GameState, negotiation: Negotiation, party: TableParty): TableSeat {
  const anchor = partyAnswersOffer(negotiation, party)
    ? counterpartyAnchor(state, negotiation, party === "club" ? "club" : "player")
    : party === "agent"
      ? personalAnchor(state, negotiation)
      : null;
  return {
    negotiation,
    party,
    table: tableOf(negotiation, party)!,
    anchor,
    voices: tableVoicesOf(state, negotiation).filter((v) => v.speaker === party),
    asks: party === "agent" ? termAsksOf(state, negotiation) : [],
  };
}

function ledgerLine(state: GameState, text: string): TableLine {
  return { date: state.date, by: "ledger", text };
}

/**
 * 상대의 답을 장부에 반영한다 — **실모드·폴백이 모두 이 문을 지난다.**
 *
 * 순서가 뜻이다: 논거는 이번 답의 앵커를 움직이지 않고 **다음 답의 문턱**을 내린다
 * (모델은 논거를 듣기 전의 앵커를 보고 말했다). 인내는 말투와 거짓에 깎이고 새로
 * 확인된 논거에 한 칸 돌아온다. 오퍼가 올라 있었으면 판정은 앵커 ± 한도로 잘려
 * `respondOffer`에 들어간다. 인내가 바닥나면 상대가 일어나고 협상은 이번 창에서 결렬이다.
 *
 * `reply`가 없으면(호출 실패) 상대는 말없이 서류대로 움직인다 — 앵커가 그대로 판정이다.
 */
export function settleTableReply(
  state: GameState,
  seat: TableSeat,
  reply?: TableReply,
): TableOutcome {
  const { negotiation, table } = seat;
  const player = playerById(state, negotiation.gamePlayerId);
  const name = player?.name ?? negotiation.gamePlayerId;
  const ledger: string[] = [];

  // ── 논거 — 사실만 가린다 (persuasion.ts) ──
  const claims = reply?.heard?.claims ?? [];
  if (claims.length > 0) {
    const outcome = evaluatePitch(state, negotiation.gamePlayerId, claims, negotiation.pitched);
    negotiation.pitched = [...new Set([...negotiation.pitched, ...outcome.verified])];
    for (const v of outcome.verdicts) {
      const label = PITCH_CLAIM_KO[v.kind];
      ledger.push(
        v.verified
          ? v.repeated
            ? `${label} — 이미 한 이야기다`
            : `${label} — 사실이다 (판정 여유 +${LATITUDE_PER_CLAIM}%p, 다음 답부터)`
          : `${label} — ${v.why}`,
      );
    }
    const fresh = outcome.verdicts.filter((v) => v.verified && !v.repeated).length;
    const lies = outcome.verdicts.filter((v) => !v.verified && v.kind !== "other").length;
    // 거짓은 하나면 충분히 상한다 — 개수로 곱하면 한 마디에 테이블이 뒤집힌다
    if (lies > 0) table.patience = Math.max(0, table.patience - 1);
    if (fresh > 0) table.patience = Math.min(table.patienceMax, table.patience + 1);
  }
  if (reply?.heard?.tone === "hostile") {
    table.patience = Math.max(0, table.patience - 1);
    ledger.push("말투가 상대를 상하게 했다");
  }

  // ── 상대가 부른 조건 — 갈래와 구간 안으로 잘라 조건서에 올린다 (§12-3) ──
  const asked = askTerms(
    state,
    negotiation,
    clampAsks(reply?.asks, seat.asks),
    askableKindsOf(negotiation),
  );
  for (const term of asked)
    ledger.push(`상대의 요구 — ${dealTermLabel(term)} (들어주거나 거절해야 한다)`);

  // ── 오퍼가 올라 있었으면 판정 — 앵커 ± 한도 ──
  let payload: MarketCard | undefined;
  if (seat.anchor) {
    /**
     * 라운드의 메모는 비어 있다 — 상대의 대사는 방의 장면이라 장부로 오는 줄이 없다
     * (transfer.md §12-2). 라운드에 남는 것은 판정과 값뿐이다.
     */
    const ruling: CounterpartyRulingInput | undefined = reply?.ruling
      ? reply.ruling
      : reply
        ? { verdict: seat.anchor.verdict }
        : undefined;
    const settled = settleCounterparty(state, seat.anchor, ruling);
    if (settled.result.ok) {
      payload = settled.result.payload;
      ledger.push(`판정 ${settled.input.verdict} — ${settled.result.message}`);
    } else {
      ledger.push(`판정을 반영하지 못했다 — ${settled.result.message}`);
    }
  }

  // ── 인내가 바닥나면 상대가 일어난다 ──
  if (table.patience <= 0 && negotiation.status === "open") {
    negotiation.status = "rejected";
    ledger.push("상대가 일어났다 — 협상은 이번 창에서 끝났다");
    pushNarrative(state, `${name} 협상 결렬 — 테이블에서 상대가 일어났다`, 4);
  }
  const closed = negotiation.status !== "open";
  // 협상이 끝났으면 열려 있던 방도 같은 자리에서 닫힌다 — 끝난 협상에 앉아 있는 방은 없다
  if (closed && state.pendingNegotiation?.negotiationId === negotiation.id) {
    closeNegotiation(state);
  }

  // ── 줄을 적는다 — 일어나는 것은 장부가 정했다 ──
  const stance: TableStance | undefined = reply
    ? reply.stance === "leaving" && !closed
      ? "cooling"
      : reply.stance
    : undefined;
  if (!reply) ledger.unshift("상대는 말없이 서류대로 움직였다");
  for (const text of ledger) table.lines.push(ledgerLine(state, text));

  const message = [
    ...ledger.map((l) => `[장부] ${l}`),
    `인내 ${table.patience}/${table.patienceMax}` +
      (stance ? ` · ${TABLE_STANCE_KO[stance]}` : "") +
      (closed ? ` · 협상 ${negotiation.status}` : ""),
  ].join("\n");
  return { ok: true, message, ...(payload ? { payload } : {}), closed };
}

// ── 협상 방 — 모드의 문 (transfer.md §12-2) ─────────────────────────

export interface RoomResult {
  ok: boolean;
  message: string;
}

/**
 * **방을 세운다** — 경기의 `startMatch`와 같은 자리다. 협상이 없으면 선수와 갈래로 오퍼
 * 없는 빈 협상을 연다(`openTalks`). 판을 세울 뿐이고 감독은 게이트를 지나 앉는다
 * (`markSeated`). 경기 중에는 열리지 않고, 방은 한 번에 하나다.
 */
export function startNegotiation(
  state: GameState,
  input: { negotiationId?: string; playerId?: string; kind?: TalksKind; party?: TableParty },
): RoomResult & { negotiationId?: string } {
  if (state.phase === "match") {
    return { ok: false, message: "경기 중에는 협상 자리에 앉을 수 없습니다" };
  }
  if (state.phase === "negotiation" && state.pendingNegotiation) {
    const open = state.pendingNegotiation.negotiationId;
    return {
      ok: false,
      message: `이미 협상 자리가 열려 있습니다 (${open}) — 먼저 일어서야 합니다`,
    };
  }
  let negotiation: Negotiation | undefined;
  let opened = false;
  if (input.negotiationId !== undefined) {
    negotiation = state.negotiations.find((n) => n.id === input.negotiationId);
    if (!negotiation) {
      return {
        ok: false,
        message: `협상 "${input.negotiationId}"${josaOf(input.negotiationId, "을/를")} 찾지 못했습니다`,
      };
    }
  } else if (input.playerId !== undefined) {
    const talks = openTalks(state, {
      playerId: input.playerId,
      ...(input.kind === undefined ? {} : { kind: input.kind }),
    });
    if (!talks.ok) return talks;
    negotiation = talks.negotiation;
    opened = talks.opened;
  } else {
    return {
      ok: false,
      message: "누구와 마주 앉는지 알 수 없습니다 — negotiationId나 playerId가 필요합니다",
    };
  }
  if (negotiation.status !== "open") {
    return { ok: false, message: `이미 끝난 협상입니다 (${negotiation.status})` };
  }
  /**
   * **누구와 앉는가** — 이 협상에 앉을 수 있는 상대 중 하나다 (transfer.md §12-2). 적지
   * 않으면 돈의 축을 쥔 쪽이 먼저다. 재계약에 구단 쪽을 부르거나 매각에 선수 쪽을 부르면
   * 앉을 사람이 없다.
   */
  const parties = partiesOf(state, negotiation);
  const party = input.party ?? parties[0];
  if (party === undefined || !parties.includes(party)) {
    return {
      ok: false,
      message: `이 협상에는 ${party === "club" ? "구단 쪽" : "선수 쪽"} 자리가 없습니다 — 앉을 수 있는 상대: ${parties.map((p) => (p === "club" ? "구단 쪽(단장)" : "선수 쪽(에이전트)")).join(" · ")}`,
    };
  }
  const phaseBefore: PendingNegotiation["phaseBefore"] =
    state.phase === "matchday" ? "matchday" : "idle";
  state.pendingNegotiation = {
    negotiationId: negotiation.id,
    seated: false,
    party,
    phaseBefore,
    openedOn: state.date,
  };
  state.phase = "negotiation";
  const name = playerById(state, negotiation.gamePlayerId)?.name ?? negotiation.gamePlayerId;
  const across = tableVoicesOf(state, negotiation).find((v) => v.speaker === party);
  const who = across ? `${across.name}(${across.title})` : party === "club" ? "구단 쪽" : "선수 쪽";
  journal({
    kind: "command",
    name: "start_negotiation",
    input,
    ok: true,
    message: `${name} — ${who}과 마주 앉을 자리를 마련했다 (${negotiation.id})`,
    source: "tool",
  });
  return {
    ok: true,
    negotiationId: negotiation.id,
    message:
      `${name} 건으로 ${who}${josaOf(who, "과/와")} 마주 앉을 자리를 마련했다` +
      (opened ? " — 오퍼는 없다" : "") +
      ` (${negotiation.id}). 감독에게 입장 확인 창이 뜬다`,
  };
}

/**
 * 감독이 자리에 앉았다 — 게이트가 닫히고 **자리에 앉는 턴**이 열린다. 그 턴에는
 * 도구가 없다: 방과 건너편 사람들, 상대의 첫 말까지다.
 */
export function markSeated(state: GameState): void {
  const room = state.pendingNegotiation;
  if (!room) return;
  room.seated = true;
  /**
   * **감독이 마주 앉으면 위임은 걷힌다** (transfer.md §12-4) — 단장과 감독이 한 테이블에
   * 함께 앉지 않는다. 방침이 그 자리를 다시 맡지 않도록 감독의 것으로 표시하고, 그 사실이
   * 테이블의 줄로 남는다.
   */
  const negotiation = state.negotiations.find((n) => n.id === room.negotiationId);
  if (!negotiation || !isMandated(negotiation)) return;
  negotiation.mandate = null;
  const table = tableOf(negotiation, room.party);
  table?.lines.push(ledgerLine(state, "감독이 마주 앉아 위임을 걷었다"));
}

/** 지금 열린 방의 협상 — 방이 없으면 null */
export function roomNegotiationOf(state: GameState): Negotiation | null {
  const id = state.pendingNegotiation?.negotiationId;
  if (state.phase !== "negotiation" || id === undefined) return null;
  return state.negotiations.find((n) => n.id === id) ?? null;
}

/** 지금 열린 방의 상대 — 방이 없으면 null. 상대를 적지 않은 옛 방은 기본 자리다 */
export function roomPartyOf(state: GameState): TableParty | null {
  const negotiation = roomNegotiationOf(state);
  if (!negotiation) return null;
  return state.pendingNegotiation?.party ?? defaultPartyOf(state, negotiation);
}

/**
 * **방을 닫는다** — `phase`는 들어서기 전의 것으로 돌아간다. 협상 자체는 건드리지 않는다:
 * 합의·결렬은 이미 장부가 적었고, 자리 뜨기(`left`)는 협상을 `open`으로 둔다 — 그 뒤의
 * 라운드는 코어가 앵커로 굳히고, 다시 앉으면 남은 인내 그대로다.
 */
export function closeNegotiation(
  state: GameState,
  reason: "left" | "closed" = "closed",
): RoomResult {
  const room = state.pendingNegotiation;
  if (!room || state.phase !== "negotiation") {
    return { ok: false, message: "열린 협상 자리가 없습니다" };
  }
  const negotiation = state.negotiations.find((n) => n.id === room.negotiationId);
  if (reason === "left" && negotiation && negotiation.status === "open") {
    const table = tableOf(negotiation, room.party);
    table?.lines.push(ledgerLine(state, "감독이 자리에서 일어났다 — 협상은 열려 있다"));
  }
  state.phase = room.phaseBefore;
  state.pendingNegotiation = null;
  const name = negotiation
    ? (playerById(state, negotiation.gamePlayerId)?.name ?? negotiation.gamePlayerId)
    : room.negotiationId;
  const status = negotiation?.status ?? "open";
  journal({
    kind: "command",
    name: "close_negotiation",
    input: { negotiationId: room.negotiationId, reason },
    ok: true,
    message: `${name} — 자리를 닫았다 (${reason === "left" ? "일어섰다" : status})`,
    source: "tool",
  });
  return {
    ok: true,
    message:
      reason === "left"
        ? `${name}${josaOf(name, "과/와")}의 자리에서 일어났다 — 협상은 열려 있다`
        : `${name} 협상이 끝나 자리가 닫혔다 (${status})`,
  };
}
