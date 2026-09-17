import { z } from "zod";
import { DateString } from "./date-string";
import { formatMoney } from "./money";
import { POSITION_GROUPS, SQUAD_NUMBER_MAX } from "./player";
import { SQUAD_NUMBER_MIN } from "./squad-rules";

/**
 * 조건 — 협상 테이블에서 **돈 말고 오가는 것** (→ docs/simulation/transfer.md §12-3).
 *
 * 감독은 주급·연수·지위 말고도 걸 것이 있고("여름에 윙어를 데려오겠다" · "£40M 오퍼가
 * 오면 보내 주겠다"), 상대도 그것을 부른다. 자유 문장으로 두면 코어가 이행을 판정할 수
 * 없으므로 조건은 **닫힌 갈래**로 서고, 갈래마다 코어가 지금 확인하는 것 · 서명 뒤 서는
 * 자리 · 이행을 재는 장부가 정해져 있다. 표에 없는 조건은 `other`로 **문장 그대로**
 * 남는다 — 코어는 확인도 판정도 못 하지만, 상대를 연기하는 호출과 그 뒤의 판정 호출이
 * 읽는 사실로는 산다.
 *
 * 설득 논거(`persuasion.ts`)와 약속 장부(people.md §5-2)가 이미 이 꼴이다.
 */
export const DEAL_TERM_KINDS = [
  "signing",
  "captain",
  "number",
  "minutes",
  "buyout",
  "bonus",
  "points",
  "escalator",
  "other",
] as const;
export type DealTermKind = (typeof DEAL_TERM_KINDS)[number];

/** 갈래의 낱말 — 장부 줄·화면·서류가 같은 말을 쓴다 */
export const DEAL_TERM_KO: Record<DealTermKind, string> = {
  signing: "추가 영입",
  captain: "주장",
  number: "등번호",
  minutes: "출전 보장",
  buyout: "바이아웃 조항",
  bonus: "사이닝 보너스",
  points: "공격 포인트 보너스",
  escalator: "주급 인상 조항",
  other: "그 밖의 조건",
};

/** 주급 인상 조항이 걸리는 사건 — 시즌 전환에서 코어가 판정한다 */
export const ESCALATOR_TRIGGERS = ["europe", "title", "promotion"] as const;
export type EscalatorTrigger = (typeof ESCALATOR_TRIGGERS)[number];
export const ESCALATOR_TRIGGER_KO: Record<EscalatorTrigger, string> = {
  europe: "유럽 대항전 진출",
  title: "리그 우승",
  promotion: "승격",
};

/** 인상 폭(%) — 아래는 조항이 아니고 위는 재계약이다 */
export const ESCALATOR_PCT_MIN = 5;
export const ESCALATOR_PCT_MAX = 50;

/** 조건의 원문 한 줄 — `other`는 이것이 조건의 전부다 */
export const DEAL_TERM_NOTE_MAX = 160;

/**
 * 갈래가 **무슨 조건인가** — 감독의 말을 조건으로 옮기는 모델과 그것을 부르는 상대가
 * 읽는 표다. 주석이 아니라 데이터인 이유는 설득 논거와 같다: 도구 스키마는 JSDoc을
 * 싣지 않는다(`toToolSchema`). 어느 인자를 채우는지까지 여기 적는다 — 갈래마다 값의
 * 자리가 달라, 뜻만 적으면 모델이 `fee`에 등번호를 적는다.
 */
export const DEAL_TERM_MEANING: Record<DealTermKind, string> = {
  signing: "그 포지션에 선수를 하나 더 데려오겠다 — position에 포지션 코드",
  captain: "주장을 맡기겠다",
  number: "그 등번호를 주겠다 — number에 번호",
  minutes:
    "임대 기간에 주전으로 세우겠다 — 임대에서만 조건이다. 영입·재계약의 주전 보장은 조건이 아니라 squadStatus다",
  buyout: "이 금액 이상의 오퍼가 오면 구단이 막지 않는다 — fee에 금액(£)",
  bonus: "서명하는 날 한 번 주는 돈 — fee에 금액(£)",
  points: "골이나 도움 하나마다 주는 돈 — fee에 포인트당 금액(£). 미드필더·공격수에게만 조건이다",
  escalator: "그 일이 이뤄지면 주급을 올린다 — trigger(europe·title·promotion)와 pct(%)",
  other:
    "표에 없는 조건 — note에 그 말 그대로. 코어는 확인도 이행 판정도 못 하고, 건너편이 읽는 사실로만 남는다",
};

const KIND_DESCRIPTION = [
  "조건의 갈래 — 돈·연수·지위 말고 걸린 것",
  ...DEAL_TERM_KINDS.map((kind) => `- ${kind}(${DEAL_TERM_KO[kind]}): ${DEAL_TERM_MEANING[kind]}`),
].join("\n");

export const DealTermKindSchema = z.enum(DEAL_TERM_KINDS).describe(KIND_DESCRIPTION);

/**
 * 조건 하나 — 갈래와 그 갈래가 쓰는 값. 갈래 밖의 값은 코어가 버린다(`normalizeDealTerm`).
 * 포지션 코드의 별칭은 코어가 읽으므로(`normalizePositionCode`) 여기서는 문자열이다.
 */
export const DealTermSchema = z.object({
  kind: DealTermKindSchema,
  position: z.string().min(1).max(8).optional().describe("signing — 데려올 자리의 포지션 코드"),
  number: z
    .number()
    .int()
    .min(SQUAD_NUMBER_MIN)
    .max(SQUAD_NUMBER_MAX)
    .optional()
    .describe("number — 약속한 등번호"),
  fee: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("buyout·bonus — 금액(£) · points — 포인트당 금액(£)"),
  pct: z
    .number()
    .int()
    .min(ESCALATOR_PCT_MIN)
    .max(ESCALATOR_PCT_MAX)
    .optional()
    .describe("escalator — 인상 폭(%)"),
  trigger: z.enum(ESCALATOR_TRIGGERS).optional().describe("escalator — 걸리는 사건"),
  note: z
    .string()
    .min(1)
    .max(DEAL_TERM_NOTE_MAX)
    .optional()
    .describe("그 조건을 말한 원문 한 줄 — other는 이것이 조건의 전부다"),
});
export type DealTerm = z.infer<typeof DealTermSchema>;

/**
 * 조건서의 한 줄 — **누가 올렸고 어떻게 됐나** (transfer.md §12-3).
 *
 * 감독이 올린 조건(`us`)은 서명되면 그대로 약속이라 답이 없다. 상대가 부른 조건
 * (`them`)은 감독이 들어주면 감독의 조건이 되고(`granted`), 거절하면 거절로 남는다
 * (`refused`) — 답이 없는 동안은 열린 요구다.
 */
export const TabledTermSchema = z.object({
  term: DealTermSchema,
  by: z.enum(["us", "them"]),
  on: DateString,
  answer: z.enum(["granted", "refused"]).optional(),
});
export type TabledTerm = z.infer<typeof TabledTermSchema>;

/**
 * 계약에 적힌 조건 — 합의된 조건서의 사본이다. 한 번 집행되는 조항(`bonus`·`escalator`)은
 * 집행된 날이 `settledOn`에 남아 두 번 집행되지 않는다. 약속 갈래의 이행은 약속 장부가
 * 판정하고(people.md §5-2), 여기 사본은 **무엇을 약속했는가**의 기록이다 — 감독도 상대를
 * 연기하는 호출도 그 계약을 볼 때 이 줄을 읽는다.
 */
export const ContractTermSchema = DealTermSchema.extend({ settledOn: DateString.optional() });
export type ContractTerm = z.infer<typeof ContractTermSchema>;

/** 감독이 한 협상에 올릴 수 있는 조건 수 — 전부 걸면 흥정이 아니라 나열이다 (`other`는 따로 센다) */
export const MAX_TABLED_TERMS = 5;

/**
 * **공격 포인트 보너스가 서는 자리** — 골·도움을 재는 조항이라 미드필더·공격수에게만이다
 * (docs/simulation/transfer.md §12-3). 수비수·골키퍼에게 걸면 코어가 반려하고 폼은 칩을 세우지
 * 않는다 — 같은 자를 둘이 읽는다.
 */
export function pointsBonusEligible(position: string): boolean {
  const group = POSITION_GROUPS[position.toUpperCase()];
  return group === "MF" || group === "FW";
}
/** 상대가 한 답에서 부를 수 있는 조건 수 */
export const MAX_TERM_ASKS = 2;

/** 조건이 서는 갈래 — 협상의 종류가 정한다. 내보내는 갈래에는 우리가 걸 조건이 없다 */
export function dealTermKindsFor(
  kind: "buy" | "sell" | "renew" | "loan" | "loan_out" | "release",
  precontract = false,
): readonly DealTermKind[] {
  switch (kind) {
    case "buy":
      return precontract
        ? ["signing", "captain", "number", "buyout", "points", "escalator", "other"]
        : ["signing", "captain", "number", "buyout", "bonus", "points", "escalator", "other"];
    case "renew":
      return ["signing", "captain", "number", "buyout", "bonus", "points", "escalator", "other"];
    case "loan":
      return ["minutes", "other"];
    default:
      return [];
  }
}

/**
 * 갈래 밖의 값을 버린다 — 모델이 `number` 조건에 `fee`를 얹어도 장부에는 그 갈래의 값만
 * 남는다. 갈래가 요구하는 값이 비었으면 `null` — 서지 못하는 조건이다.
 */
export function normalizeDealTerm(term: DealTerm): DealTerm | null {
  const note = term.note?.trim();
  const base: DealTerm = { kind: term.kind, ...(note ? { note } : {}) };
  switch (term.kind) {
    case "signing":
      return term.position ? { ...base, position: term.position.toUpperCase() } : null;
    case "number":
      return term.number === undefined ? null : { ...base, number: term.number };
    case "buyout":
    case "bonus":
    case "points":
      return term.fee === undefined || term.fee <= 0 ? null : { ...base, fee: term.fee };
    case "escalator":
      return term.trigger === undefined || term.pct === undefined
        ? null
        : { ...base, trigger: term.trigger, pct: term.pct };
    case "other":
      return note ? base : null;
    case "captain":
    case "minutes":
      return base;
  }
}

/** 조건 한 줄 — 갈래의 낱말에 그 갈래의 값을 붙인다. `other`는 원문이 곧 줄이다 */
export function dealTermLabel(term: DealTerm): string {
  switch (term.kind) {
    case "signing":
      return `${DEAL_TERM_KO.signing} — ${term.position ?? "?"}`;
    case "number":
      return `${DEAL_TERM_KO.number} ${term.number ?? "?"}번`;
    case "buyout":
    case "bonus":
      return `${DEAL_TERM_KO[term.kind]} ${formatMoney(term.fee ?? 0)}`;
    case "points":
      return `${DEAL_TERM_KO.points} 포인트당 ${formatMoney(term.fee ?? 0)}`;
    case "escalator":
      return `${DEAL_TERM_KO.escalator} — ${term.trigger ? ESCALATOR_TRIGGER_KO[term.trigger] : "?"} 시 +${term.pct ?? 0}%`;
    case "other":
      return `${DEAL_TERM_KO.other} — “${term.note ?? ""}”`;
    case "captain":
    case "minutes":
      return DEAL_TERM_KO[term.kind];
  }
}

/** 같은 갈래는 하나다 — 다시 올리면 값을 고치는 것이지 둘을 거는 것이 아니다 */
export function sameTermKind(a: DealTerm, b: DealTerm): boolean {
  return a.kind === b.kind && (a.kind !== "other" || a.note === b.note);
}
