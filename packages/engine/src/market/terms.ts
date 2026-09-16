import type {
  Contract,
  ContractTerm,
  DealTerm,
  DealTermKind,
  GamePlayer,
  Negotiation,
  TabledTerm,
  TickSink,
} from "@story-fm/domain";
import {
  DEAL_TERM_KO,
  ESCALATOR_TRIGGER_KO,
  MAX_TABLED_TERMS,
  MAX_TERM_ASKS,
  dealTermKindsFor,
  dealTermLabel,
  formatMoney,
  josa,
  normalizeDealTerm,
  normalizePositionCode,
  sameTermKind,
} from "@story-fm/domain";
import { recordFinance } from "../club/finance";
import {
  activeContract,
  financeOf,
  playerById,
  pushNarrative,
  type GameState,
} from "../core/state";
import { betterAtPosition } from "../squad/depth";
import { numberLineageOf } from "../squad/numbers";
import { openPromise } from "../squad/promises";
import { applyCharacterMemories } from "../world/persona";

/**
 * **조건서** — 협상에서 돈 말고 오가는 것의 장부 (docs/simulation/transfer.md §12-3).
 *
 * 감독이 올린 조건과 상대가 부른 조건이 한 장부(`Negotiation.terms`)에 서고, 코어가
 * 하는 일은 셋이다. ① **지금 확인한다** — 그 조건을 선수가 믿을 만한가를 장부의
 * 사실로 가린다(`verifyTerm`). 무게는 정하지 않는다 — 설득 논거와 같은 규약이다.
 * ② **서명 때 흩는다** — 약속 갈래는 약속 장부로, 조항은 계약의 칸으로, 문장은
 * 계약의 사본으로(`settleTermsOnSigning`). ③ **집행한다** — 조항의 사건이 오면
 * 장부를 움직인다(`settleEscalators`).
 *
 * ⚠️ 여기 어디에도 판정의 무게 표는 없다. 확인된 조건 하나가 확률에 무엇을 하는지는
 * `market.ts`가 지위 한 칸의 상수로 정하고, 그것이 이 사람에게 얼마나 큰지는 상대를
 * 연기하는 호출이 정한다.
 */

/** 상대가 부르는 인상 조항의 폭 — 이 사이만 조건이다 */
export const ESCALATOR_ASK_PCT = 20;
export const ESCALATOR_ASK_MIN = 10;
export const ESCALATOR_ASK_MAX = 30;
/** 상대가 부르는 사이닝 보너스 — 제시 주급의 몇 주치인가 */
export const BONUS_ASK_WEEKS = 12;
export const BONUS_ASK_WEEKS_MIN = 4;
export const BONUS_ASK_WEEKS_MAX = 26;

/** 이 협상에서 걸 수 있는 조건의 갈래 — 협상의 종류가 정한다 */
export function termKindsOf(
  negotiation: Pick<Negotiation, "kind" | "precontract">,
): readonly DealTermKind[] {
  return dealTermKindsFor(negotiation.kind, negotiation.precontract === true);
}

/** 조건서 — 없으면 빈 장부 */
export function termSheetOf(negotiation: Pick<Negotiation, "terms">): TabledTerm[] {
  return negotiation.terms ?? [];
}

/**
 * **감독이 건 조건 전부** — 올린 것과 들어준 요구. 서명되면 이것이 그대로 약속이다.
 * 라운드가 싣는 사본도, 확률이 재는 것도 이 목록이다.
 */
export function offeredTermsOf(negotiation: Pick<Negotiation, "terms">): DealTerm[] {
  return termSheetOf(negotiation)
    .filter((row) => row.by === "us" || row.answer === "granted")
    .map((row) => row.term);
}

/** 상대가 불렀는데 아직 답이 없는 요구 */
export function openAsksOf(negotiation: Pick<Negotiation, "terms">): TabledTerm[] {
  return termSheetOf(negotiation).filter((row) => row.by === "them" && row.answer === undefined);
}

/** 감독이 거절한 요구의 수 — 확률에서 한 칸씩 빼는 자다 */
export function refusedTermsOf(negotiation: Pick<Negotiation, "terms">): number {
  return termSheetOf(negotiation).filter((row) => row.by === "them" && row.answer === "refused")
    .length;
}

/** 조건서에 이미 그 갈래가 있는가 — 누가 올렸든 같은 갈래는 하나다 */
function hasKind(negotiation: Pick<Negotiation, "terms">, term: DealTerm): boolean {
  return termSheetOf(negotiation).some((row) => sameTermKind(row.term, term));
}

/** 다음 이적창 마감 — 추가 영입 약속의 기한이자 그 약속이 믿을 만한 이유다 */
function nextWindowClose(state: GameState): string | null {
  return (
    state.windows
      .filter((w) => w.leagueId === undefined && w.closesOn > state.date)
      .map((w) => w.closesOn)
      .sort()[0] ?? null
  );
}

export type TermVerdict = "credible" | "doubtful" | "unverifiable";

export interface TermCheck {
  term: DealTerm;
  verdict: TermVerdict;
  /** 왜 믿을 만한지 · 왜 의심하는지 — 서류와 확률 근거에 그대로 선다 */
  why: string;
}

/**
 * 조건을 **장부와 대조한다** — 코어는 사실만 가린다 (transfer.md §12-3).
 *
 * 믿을 만한 조건은 확률에 지위 한 칸을 얹고, 의심스러운 조건은 얹지 않되 그 사실이
 * 서류에 서서 상대가 읽는다 — 「10번은 지금 주장이 달고 있다」는 줄이 그 자리다.
 * `other`는 확인할 수 없어 어느 쪽도 아니다: 문장만 선다.
 */
export function verifyTerm(state: GameState, player: GamePlayer, term: DealTerm): TermCheck {
  const us = state.userTeamId;
  switch (term.kind) {
    case "signing": {
      const code = term.position ? normalizePositionCode(term.position) : null;
      if (code === null) {
        return { term, verdict: "doubtful", why: `${term.position ?? "?"}은 자리가 아니다` };
      }
      const finance = financeOf(state, us);
      const close = nextWindowClose(state);
      if (finance.budgetFrozen) {
        return { term, verdict: "doubtful", why: "이적 예산이 동결돼 있다 — 데려올 돈이 없다" };
      }
      if (finance.transferBudget <= 0) {
        return { term, verdict: "doubtful", why: "이적 예산이 없다 — 데려올 돈이 없다" };
      }
      return {
        term,
        verdict: "credible",
        why:
          `이적 예산 ${formatMoney(finance.transferBudget)}` +
          (close ? ` · 다음 창 마감 ${close}까지` : ""),
      };
    }
    case "captain":
      return player.isCaptain && player.teamId === us
        ? { term, verdict: "doubtful", why: `${josa(player.name, "은/는")} 이미 주장이다` }
        : { term, verdict: "credible", why: "완장은 감독이 정한다" };
    case "number": {
      const number = term.number ?? 0;
      const holder = numberLineageOf(state, us, number).holder;
      if (holder === null || holder.playerId === player.id) {
        return { term, verdict: "credible", why: `${number}번은 비어 있다` };
      }
      return {
        term,
        verdict: "doubtful",
        why: `${number}번은 ${josa(holder.name, "이/가")} 달고 있다`,
      };
    }
    case "minutes": {
      const blocked = betterAtPosition(state, us, player);
      return blocked === 0
        ? { term, verdict: "credible", why: "그 자리에 그보다 나은 선수가 없다" }
        : { term, verdict: "doubtful", why: `그 자리에 이미 더 나은 선수가 ${blocked}명 있다` };
    }
    case "buyout":
      return {
        term,
        verdict: "credible",
        why: "조항은 계약서의 숫자다 — 감독의 뜻과 무관하게 선다",
      };
    case "bonus": {
      const budget = financeOf(state, us).transferBudget;
      return (term.fee ?? 0) <= budget
        ? { term, verdict: "credible", why: `이적 예산 ${formatMoney(budget)} 안이다` }
        : {
            term,
            verdict: "doubtful",
            why: `이적 예산 ${formatMoney(budget)}으로는 낼 수 없는 돈이다`,
          };
    }
    case "escalator":
      return {
        term,
        verdict: "credible",
        why: "조항은 계약서의 숫자다 — 사건이 오면 코어가 올린다",
      };
    case "other":
      return { term, verdict: "unverifiable", why: "코어가 확인할 수 없는 조건이다 — 말로만 선다" };
  }
}

/** 조건서 전부를 대조한 결과 — 확률과 서류가 같은 목록을 읽는다 */
export function checkTerms(
  state: GameState,
  player: GamePlayer,
  terms: readonly DealTerm[],
): TermCheck[] {
  return terms.map((term) => verifyTerm(state, player, term));
}

export interface TermsTabled {
  /** 장부에 선 조건 */
  tabled: DealTerm[];
  /** 서지 못한 조건과 그 이유 — 감독이 읽는다 */
  notes: string[];
}

/**
 * 감독이 조건을 올린다 — **같은 갈래는 하나이고, 상대가 부른 갈래면 그 요구를 들어준
 * 것이다.** 갈래가 협상의 종류에 맞지 않거나 값이 비었으면 서지 않고 그 이유가 돌아간다.
 * 상한(`MAX_TABLED_TERMS`)은 `other`를 빼고 센다 — 문장은 흥정의 칸이 아니다.
 */
export function tableTerms(
  state: GameState,
  negotiation: Negotiation,
  terms: readonly DealTerm[],
): TermsTabled {
  const allowed = termKindsOf(negotiation);
  const sheet = (negotiation.terms ??= []);
  const tabled: DealTerm[] = [];
  const notes: string[] = [];
  for (const raw of terms) {
    const term = normalizeDealTerm(raw);
    if (term === null) {
      notes.push(`${DEAL_TERM_KO[raw.kind]} 조건은 값이 비어 서지 않았습니다`);
      continue;
    }
    if (!allowed.includes(term.kind)) {
      notes.push(`${dealTermLabel(term)} — 이 협상에서는 걸 수 없는 조건입니다`);
      continue;
    }
    if (term.kind === "signing") {
      const code = normalizePositionCode(term.position ?? "");
      if (code === null) {
        notes.push(`${term.position}은 자리 표기가 아닙니다 — 포지션 코드로 말해야 합니다`);
        continue;
      }
      term.position = code;
    }
    // 상대가 부른 갈래를 감독이 올리면 그 요구를 들어준 것이다 — 값은 감독이 부른 것으로
    const asked = sheet.find(
      (row) => row.by === "them" && row.answer === undefined && sameTermKind(row.term, term),
    );
    if (asked) {
      asked.answer = "granted";
      asked.term = term;
      tabled.push(term);
      continue;
    }
    const mine = sheet.findIndex((row) => row.by === "us" && sameTermKind(row.term, term));
    if (mine >= 0) {
      // 다시 올리는 것은 값을 고치는 것이다 — 조항을 올려 부르는 자리
      sheet[mine] = { term, by: "us", on: state.date };
      tabled.push(term);
      continue;
    }
    const counted = sheet.filter((row) => row.by === "us" && row.term.kind !== "other").length;
    if (term.kind !== "other" && counted >= MAX_TABLED_TERMS) {
      notes.push(
        `${dealTermLabel(term)} — 한 협상에 조건은 ${MAX_TABLED_TERMS}개까지입니다. 하나를 거두고 걸어야 합니다`,
      );
      continue;
    }
    sheet.push({ term, by: "us", on: state.date });
    tabled.push(term);
  }
  return { tabled, notes };
}

/** 감독이 상대의 요구에 답한다 — 들어주거나 거절한다. 열린 요구가 없으면 반려다 */
export function answerTermAsk(
  negotiation: Negotiation,
  kind: DealTermKind,
  answer: "granted" | "refused",
): { ok: true; term: DealTerm } | { ok: false; message: string } {
  const row = openAsksOf(negotiation).find((r) => r.term.kind === kind);
  if (!row) return { ok: false, message: `답할 ${DEAL_TERM_KO[kind]} 요구가 없습니다` };
  row.answer = answer;
  return { ok: true, term: row.term };
}

/**
 * 상대가 조건을 부른다 — **부를 수 있는 갈래 안에서, 이미 조건서에 없는 갈래만, 한 답에
 * 둘까지.** 값은 부르는 쪽(`counterparty.ts`)이 구간으로 잘라 넘긴다.
 */
export function askTerms(
  state: GameState,
  negotiation: Negotiation,
  asks: readonly DealTerm[],
  askable: readonly DealTermKind[],
): DealTerm[] {
  const sheet = (negotiation.terms ??= []);
  const accepted: DealTerm[] = [];
  for (const raw of asks) {
    if (accepted.length >= MAX_TERM_ASKS) break;
    const term = normalizeDealTerm(raw);
    if (term === null || !askable.includes(term.kind)) continue;
    if (hasKind(negotiation, term)) continue;
    sheet.push({ term, by: "them", on: state.date });
    accepted.push(term);
  }
  return accepted;
}

/** 상대가 지금 부를 수 있는 갈래 — 협상의 갈래 중 조건서에 아직 없는 것. `other`는 늘 열려 있다 */
export function askableKindsOf(negotiation: Negotiation): DealTermKind[] {
  return termKindsOf(negotiation).filter(
    (kind) => kind === "other" || !termSheetOf(negotiation).some((row) => row.term.kind === kind),
  );
}

/** 조건서 한 줄 — 누가 올렸고 어떻게 됐나. 서류·요약·화면이 같은 문형을 쓴다 */
export function tabledTermLine(row: TabledTerm, us: string, them: string): string {
  const who = row.by === "us" ? us : them;
  const status =
    row.by === "us"
      ? ""
      : row.answer === "granted"
        ? ` — ${us}가 들어줬다`
        : row.answer === "refused"
          ? ` — ${us}가 거절했다`
          : " — 답을 기다린다";
  return `${who}: ${dealTermLabel(row.term)}${status}`;
}

/** 감독이 읽는 조건서 — 협상 요약이 붙인다 */
export function describeTermSheet(state: GameState, negotiation: Negotiation): string[] {
  const sheet = termSheetOf(negotiation);
  if (sheet.length === 0) return [];
  const player = playerById(state, negotiation.gamePlayerId);
  const checks = player ? checkTerms(state, player, offeredTermsOf(negotiation)) : [];
  return [
    "조건서:",
    ...sheet.map((row) => {
      const check = checks.find((c) => c.term === row.term || sameTermKind(c.term, row.term));
      const fact =
        row.by === "us" || row.answer === "granted"
          ? check && check.verdict !== "unverifiable"
            ? ` (${check.verdict === "credible" ? "믿을 만하다" : "의심한다"} — ${check.why})`
            : ""
          : "";
      return `  ${tabledTermLine(row, "우리", "상대")}${fact}`;
    }),
  ];
}

/** 합의 라운드의 조건에서 감독이 약속한 등번호 — 도착일 배정이 읽는다 */
export function promisedNumberOf(terms: readonly DealTerm[] | undefined): number | undefined {
  return terms?.find((t) => t.kind === "number")?.number;
}

/**
 * **서명 — 조건이 제자리로 흩어진다** (transfer.md §12-3).
 *
 * 약속 갈래(추가 영입·주장·등번호·출전)는 약속 장부에 서고, 조항(바이아웃·인상)은 계약의
 * 칸에, 보너스는 그날 나가며, 사본은 계약에 남는다. 문장(`other`)은 사본에만 산다.
 *
 * ⚠️ **선수가 이미 우리 소속인 뒤에 불러야 한다** — 약속 장부는 우리 선수에게만 선다.
 * 영입의 등번호는 도착일 배정이 따로 읽으므로(`promisedNumberOf`) 여기서는 재계약에서만
 * 약속으로 선다.
 */
export function settleTermsOnSigning(
  state: GameState,
  contract: Contract,
  player: GamePlayer,
  terms: readonly DealTerm[],
  /**
   * `renewal` — 재계약이라 등번호가 약속 장부로 간다. `pending` — 사전 계약이라 조항과
   * 사본만 서고 약속은 합류일에 연다(`openPromisesFromContract`).
   */
  options: { renewal?: boolean; pending?: boolean } = {},
): string[] {
  const notes: string[] = [];
  if (terms.length === 0) return notes;
  const copy: ContractTerm[] = terms.map((term) => ({ ...term }));
  for (const term of copy) {
    if (options.pending && term.kind !== "buyout") continue;
    switch (term.kind) {
      case "buyout":
        contract.buyoutClause = term.fee;
        break;
      case "bonus": {
        const amount = term.fee ?? 0;
        if (amount <= 0) break;
        recordFinance(state, state.userTeamId, {
          kind: "expense",
          category: "signing_bonus",
          label: `사이닝 보너스 — ${player.name}`,
          amount,
          ref: { type: "player", id: player.id },
        });
        // 이적료와 같은 주머니에서 나간다 — 예산 관문이 잰 자리가 여기다 (transfer.md §11)
        const finance = financeOf(state, state.userTeamId);
        finance.transferBudget = Math.max(0, finance.transferBudget - amount);
        term.settledOn = state.date;
        notes.push(`사이닝 보너스 ${formatMoney(amount)} 지급`);
        break;
      }
      case "signing":
      case "captain":
      case "minutes": {
        const opened = openPromise(
          state,
          player.id,
          term.kind,
          undefined,
          undefined,
          term.position,
        );
        notes.push(
          opened.ok && opened.promise
            ? `${DEAL_TERM_KO[term.kind]} 약속 — ${opened.promise.dueOn}까지`
            : `${DEAL_TERM_KO[term.kind]} 약속은 장부에 서지 않았습니다 — ${opened.message ?? ""}`,
        );
        break;
      }
      case "number": {
        if (!options.renewal) break;
        const opened = openPromise(state, player.id, "number", undefined, term.number);
        notes.push(
          opened.ok && opened.promise
            ? `등번호 ${term.number}번 약속 — ${opened.promise.dueOn}까지`
            : `등번호 약속은 장부에 서지 않았습니다 — ${opened.message ?? ""}`,
        );
        break;
      }
      case "escalator":
      case "other":
        break;
    }
  }
  contract.terms = copy;
  rememberTerms(state, player, terms);
  return notes;
}

/** 서명 때의 조건이 그 선수의 기억에 남는 무게 — 사건 기록의 보통 세기와 같다 */
const TERMS_MEMORY_SALIENCE = 3;

/**
 * **조건은 그 선수의 기억이다** (people.md §9-1) — 서명하는 날 한 줄로 선다. 표 밖의
 * 조건(`other`)이 뒤의 면담·다가옴·재계약 테이블에 닿는 길이 이것이다: 장부에는 이행을 잴
 * 자가 없어도, 그가 "그때 감독이 겨울 휴가를 약속했다"는 것을 기억하고 말한다.
 */
function rememberTerms(state: GameState, player: GamePlayer, terms: readonly DealTerm[]): void {
  if (terms.length === 0) return;
  applyCharacterMemories(state, [
    {
      characterId: player.name,
      text: `계약 조건 — ${terms.map(dealTermLabel).join(" · ")}`,
      salience: TERMS_MEMORY_SALIENCE,
    },
  ]);
}

/**
 * **사전 계약이 발효하는 날 약속이 선다** (transfer.md §12-3) — 계약의 사본에 적힌 약속
 * 갈래를 그날 장부에 연다. 반년 전에 한 약속의 기한을 서명일부터 세면 합류하기도 전에
 * 판정이 떨어진다.
 */
export function openPromisesFromContract(
  state: GameState,
  contract: Contract,
  player: GamePlayer,
): string[] {
  const notes: string[] = [];
  for (const term of contract.terms ?? []) {
    if (term.kind === "signing" || term.kind === "captain" || term.kind === "minutes") {
      const opened = openPromise(state, player.id, term.kind, undefined, undefined, term.position);
      if (opened.ok && opened.promise) {
        notes.push(`${DEAL_TERM_KO[term.kind]} 약속 — ${opened.promise.dueOn}까지`);
      }
    }
  }
  return notes;
}

/**
 * **임대의 조건** — 우리 계약이 없는 자리라 사본이 설 곳이 없고, 설 수 있는 것은 출전
 * 약속뿐이다 (transfer.md §12-3). 빌려 온 선수에게 열 수 있는 약속이 그 하나다.
 */
export function settleLoanTerms(
  state: GameState,
  player: GamePlayer,
  terms: readonly DealTerm[],
): string[] {
  const notes: string[] = [];
  rememberTerms(state, player, terms);
  for (const term of terms) {
    if (term.kind !== "minutes") continue;
    const opened = openPromise(state, player.id, "minutes");
    notes.push(
      opened.ok && opened.promise
        ? `출전 보장 약속 — ${opened.promise.dueOn}까지`
        : `출전 보장 약속은 장부에 서지 않았습니다 — ${opened.message ?? ""}`,
    );
  }
  return notes;
}

/** 시즌 전환이 넘기는 사실 — 조항의 사건이 이번 시즌에 있었는가 */
export interface EscalatorFacts {
  europe: boolean;
  title: boolean;
  promotion: boolean;
}

/**
 * **주급 인상 조항의 집행** — 시즌 전환에서 한 번 (transfer.md §12-3).
 *
 * 우리 구단의 활성 계약 중 아직 집행되지 않은 조항의 사건이 이번 시즌에 있었으면 주급이
 * 그만큼 오르고 `settledOn`이 찍힌다 — 같은 조항이 다음 시즌에 다시 오르지 않는다.
 */
export function settleEscalators(state: GameState, facts: EscalatorFacts, digest: TickSink): void {
  for (const contract of state.contracts) {
    if (contract.status !== "active" || contract.teamId !== state.userTeamId) continue;
    for (const term of contract.terms ?? []) {
      if (term.kind !== "escalator" || term.settledOn !== undefined) continue;
      if (term.trigger === undefined || term.pct === undefined) continue;
      if (!facts[term.trigger]) continue;
      const before = contract.weeklyWage;
      contract.weeklyWage = Math.round(before * (1 + term.pct / 100));
      term.settledOn = state.date;
      const player = playerById(state, contract.gamePlayerId);
      const name = player?.name ?? contract.gamePlayerId;
      digest.push(
        `${name} 주급 인상 조항 발동 — ${ESCALATOR_TRIGGER_KO[term.trigger]}으로 ` +
          `${formatMoney(before)} → ${formatMoney(contract.weeklyWage)}`,
      );
      pushNarrative(state, `${name} 주급 인상 조항 발동 (+${term.pct}%)`, 3);
    }
  }
}

/** 계약에 적힌 조건의 줄 — 카드·조회가 같은 문형을 쓴다. 조항 칸이 있으면 함께 든다 */
export function contractTermLines(contract: Pick<Contract, "buyoutClause" | "terms">): string[] {
  const lines: string[] = [];
  if (contract.buyoutClause !== undefined && contract.buyoutClause > 0) {
    lines.push(`바이아웃 조항 ${formatMoney(contract.buyoutClause)}`);
  }
  for (const term of contract.terms ?? []) {
    if (term.kind === "buyout") continue;
    lines.push(dealTermLabel(term) + (term.settledOn ? ` (${term.settledOn} 집행)` : ""));
  }
  return lines;
}

/** 이 선수의 계약에 적힌 조건 — 없으면 빈 배열 */
export function contractTermsOf(state: GameState, playerId: string): string[] {
  const contract = activeContract(state, playerId);
  return contract ? contractTermLines(contract) : [];
}
