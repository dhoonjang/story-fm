import type {
  Negotiation,
  NegotiationTable,
  PitchClaim,
  TableLine,
  TableSpeaker,
  TableStance,
} from "@story-fm/domain";
import { PITCH_CLAIM_KO, TABLE_LINE_MAX, TABLE_STANCE_KO } from "@story-fm/domain";
import type { MarketCard } from "@story-fm/domain";
import { playerById, pushNarrative, type GameState } from "../core/state";
import { agentProfileOf } from "./agent-profile";
import {
  counterpartyAnchor,
  settleCounterparty,
  tableVoicesOf,
  type CounterpartyAnchor,
  type CounterpartyRulingInput,
  type CounterpartyVoice,
} from "./counterparty";
import { pendingOffer } from "./negotiation";
import { LATITUDE_PER_CLAIM, evaluatePitch } from "./persuasion";

/**
 * **테이블 — 협상 위에 서는 마주 앉은 대화**
 * (docs/simulation/transfer.md §12-2 · docs/llm/agents.md §4-1).
 *
 * 오퍼와 답은 그대로 협상의 라운드다. 테이블이 더하는 것은 셋이다 — 그 사이의 **말**,
 * 상대가 앉아 있을 **인내**, 그리고 답을 기다리는 오퍼가 **오늘** 답을 받는다는 것.
 * 상대의 대사는 모델이 쓰고, 여기 있는 것은 그 대사가 장부에 남길 수 있는 전부다.
 */

/** 앉을 때의 인내 — 대리인 원형의 `patience`가 곱해진다 (법률가형 5 · 제국형 4 · 승부사형 3) */
export const TABLE_PATIENCE_BASE = 4;
/** 인내의 하한 — 한 마디에 일어나는 상대는 없다 */
export const TABLE_PATIENCE_MIN = 2;

/** 이 선수의 상대가 테이블에 앉아 있을 인내 */
export function tablePatienceOf(state: GameState, playerId: string): number {
  return Math.max(
    TABLE_PATIENCE_MIN,
    Math.round(TABLE_PATIENCE_BASE * agentProfileOf(state, playerId).patience),
  );
}

/** 모델이 이번 답에서 들은 것 — 코어가 사실 대조하고 인내에 반영한다 */
export interface TableHeard {
  /** 감독의 말투 — 모욕·협박은 인내를 깎는다 */
  tone: "civil" | "hostile";
  /** 감독이 실제로 든 설득 논거 */
  claims: PitchClaim[];
}

/**
 * 상대가 말한 한 줄 — **화자가 붙는다** (transfer.md §12-1). 영입의 테이블에는 값을
 * 답하는 구단과 개인 조건을 답하는 선수 쪽이 함께 앉으므로, 한 답이 두 줄일 수 있다.
 */
export interface TableReplyLine {
  speaker: TableSpeaker;
  text: string;
}

/** 모델의 답 — 어느 값도 그대로 믿지 않는다 */
export interface TableReply {
  /** 화자가 붙은 말 — 서 있는 목소리마다 한 줄, 없는 화자는 코어가 접는다 */
  lines: readonly TableReplyLine[];
  /** **답 하나에 태도 하나** — 화자가 둘이어도 테이블의 온도는 한 자리에서 잰다 */
  stance: TableStance;
  heard: TableHeard;
  /** 테이블에 오퍼가 올라 있을 때만 — 앵커 ± 한도로 잘린다 (counterparty.ts) */
  ruling?: CounterpartyRulingInput;
}

export interface TableSeat {
  negotiation: Negotiation;
  table: NegotiationTable;
  /** 답할 오퍼가 올라 있으면 그 앵커 — 없으면 말만 오간다 */
  anchor: CounterpartyAnchor | null;
  /** 이 테이블에서 답하는 목소리 — 하나이거나 둘이다 (`tableVoicesOf`) */
  voices: CounterpartyVoice[];
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
 * **답을 기다리던 오퍼는 오늘로 당겨진다.** 편지로 보낸 오퍼는 며칠 뒤에 답이 오지만
 * 마주 앉으면 그 자리에서 답한다 — 그것이 테이블에 앉는 값이다. 그 답은 이어지는
 * `settleTableReply`가 같은 턴에 낸다.
 */
export function sitAtTable(
  state: GameState,
  negotiationId: string,
  line: string,
): { ok: false; message: string } | { ok: true; seat: TableSeat } {
  const negotiation = state.negotiations.find((n) => n.id === negotiationId);
  if (!negotiation) return { ok: false, message: `협상 "${negotiationId}"을 찾지 못했습니다` };
  if (negotiation.status !== "open") {
    return { ok: false, message: `이미 끝난 협상입니다 (${negotiation.status})` };
  }
  const text = line.trim().slice(0, TABLE_LINE_MAX);
  if (text.length === 0) return { ok: false, message: "감독의 말이 비어 있습니다" };
  const patience = tablePatienceOf(state, negotiation.gamePlayerId);
  negotiation.table ??= {
    openedOn: state.date,
    patience,
    patienceMax: patience,
    lines: [],
  };
  negotiation.table.lines.push({ date: state.date, by: "us", text });
  const offer = pendingOffer(negotiation);
  if (offer && offer.respondsOn !== null && offer.respondsOn > state.date) {
    offer.respondsOn = state.date;
  }
  return { ok: true, seat: seatOf(state, negotiation) };
}

/** 자리 하나 — 협상·테이블·앵커·목소리를 한 자리에서 세운다 */
function seatOf(state: GameState, negotiation: Negotiation): TableSeat {
  return {
    negotiation,
    table: negotiation.table!,
    anchor: counterpartyAnchor(state, negotiation),
    voices: tableVoicesOf(state, negotiation),
  };
}

/**
 * 편지 — **마주 앉지 않고 온 답**. 감독이 보낸 오퍼에 답할 날이 됐을 때(`arrivedResponses`)
 * 코어가 여는 자리다. 감독의 말이 없으므로 `us` 줄 대신 장부 줄이 서고, 답은 같은
 * 상대(`negotiation-table`)가 같은 서류로 낸다 — 편지와 테이블이 다른 머리로 답하면
 * 같은 대리인이 자리마다 다른 것을 아는 사람이 된다.
 */
export function openLetter(
  state: GameState,
  negotiationId: string,
): { ok: false; message: string } | { ok: true; seat: TableSeat } {
  const negotiation = state.negotiations.find((n) => n.id === negotiationId);
  if (!negotiation) return { ok: false, message: `협상 "${negotiationId}"을 찾지 못했습니다` };
  if (negotiation.status !== "open") {
    return { ok: false, message: `이미 끝난 협상입니다 (${negotiation.status})` };
  }
  const offer = pendingOffer(negotiation);
  if (!offer || offer.respondsOn === null || offer.respondsOn > state.date) {
    return { ok: false, message: "답할 날이 된 오퍼가 없습니다" };
  }
  const patience = tablePatienceOf(state, negotiation.gamePlayerId);
  negotiation.table ??= { openedOn: state.date, patience, patienceMax: patience, lines: [] };
  negotiation.table.lines.push(ledgerLine(state, "감독의 오퍼가 서면으로 왔다 — 마주 앉지 않았다"));
  return { ok: true, seat: seatOf(state, negotiation) };
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
  /**
   * **화자를 서 있는 목소리로 접는다** — 모델이 이 테이블에 없는 사람을 적어도 장부에는
   * 앉아 있는 사람만 남는다 (transfer.md §12-1). 목소리가 하나인 갈래는 그 하나로 접히고,
   * 그래서 재계약·매각의 줄은 지금까지와 똑같이 읽힌다.
   */
  const spoken = (reply?.lines ?? []).map((line) => ({
    speaker: seat.voices.some((v) => v.speaker === line.speaker)
      ? line.speaker
      : (seat.voices[0]?.speaker ?? line.speaker),
    text: line.text.trim().slice(0, TABLE_LINE_MAX),
  }));

  // ── 논거 — 사실만 가린다 (persuasion.ts) ──
  const claims = reply?.heard.claims ?? [];
  if (claims.length > 0) {
    const outcome = evaluatePitch(
      state,
      negotiation.gamePlayerId,
      claims,
      negotiation.pitched ?? [],
    );
    negotiation.pitched = [...new Set([...(negotiation.pitched ?? []), ...outcome.verified])];
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
  if (reply?.heard.tone === "hostile") {
    table.patience = Math.max(0, table.patience - 1);
    ledger.push("말투가 상대를 상하게 했다");
  }

  // ── 오퍼가 올라 있었으면 판정 — 앵커 ± 한도 ──
  let payload: MarketCard | undefined;
  if (seat.anchor) {
    // 두 목소리가 왔으면 메모도 둘의 말을 잇는다 — 라운드에 적히는 것은 한 줄이다
    const note = spoken
      .map((l) => l.text)
      .join(" ")
      .slice(0, 200);
    const ruling: CounterpartyRulingInput | undefined = reply?.ruling
      ? { ...reply.ruling, ...(note ? { note } : {}) }
      : reply
        ? { verdict: seat.anchor.verdict, ...(note ? { note } : {}) }
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

  // ── 줄을 적는다 — 일어나는 것은 장부가 정했다 ──
  const stance: TableStance | undefined = reply
    ? reply.stance === "leaving" && !closed
      ? "cooling"
      : reply.stance
    : undefined;
  /**
   * **한 답의 태도는 모든 줄에 같이 선다** — 답 하나에 태도가 하나라서다. 줄마다 다른
   * 온도를 적으면 인내를 재는 자리가 둘이 된다 (transfer.md §12-2).
   */
  for (const line of spoken) {
    table.lines.push({
      date: state.date,
      by: "them",
      text: line.text,
      speaker: line.speaker,
      ...(stance ? { stance } : {}),
    });
  }
  if (!reply) ledger.unshift("상대는 말없이 서류대로 움직였다");
  for (const text of ledger) table.lines.push(ledgerLine(state, text));

  const message = [
    ...spoken.map(
      (line) =>
        `<reply speaker="${line.speaker}" name="${speakerName(seat, line.speaker)}" ` +
        `stance="${stance ?? "steady"}">\n${line.text}\n</reply>`,
    ),
    ...ledger.map((l) => `[장부] ${l}`),
    `인내 ${table.patience}/${table.patienceMax}` +
      (stance ? ` · ${TABLE_STANCE_KO[stance]}` : "") +
      (closed ? ` · 협상 ${negotiation.status}` : ""),
  ].join("\n");
  return { ok: true, message, ...(payload ? { payload } : {}), closed };
}

/** 그 화자의 이름 — 서류가 부르는 이름 그대로다 (`tableVoicesOf`) */
export function speakerName(seat: TableSeat, speaker: TableSpeaker): string {
  return seat.voices.find((v) => v.speaker === speaker)?.name ?? "상대";
}
