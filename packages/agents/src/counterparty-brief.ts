import {
  MAX_PAYMENT_YEARS,
  SQUAD_STATUS_KO,
  statusAtRank,
  type Negotiation,
} from "@story-fm/domain";
import {
  buildCounterpartyBrief,
  characterEntryOf,
  counterpartyAnchor,
  formatMoney,
  type CounterpartyAnchor,
  type GameState,
} from "@story-fm/engine";
import { describeCharacters } from "./gm-input";

/**
 * 교섭 서류 — **우리가 넣은 오퍼에 온 답을 GM이 상대가 되어 판정하는 자리**의 입력
 * (docs/llm/agents.md §4-1 · docs/simulation/transfer.md §12-1).
 *
 * 코어가 서류와 앵커를 내고, GM이 `rule_offer_response`로 답하며, 코어가 앵커 ± 한도로
 * 자른다. 감독 편으로 기우는 것을 막는 것은 별도 호출이 아니라 그 한도다. 여기 있는
 * 것은 사실을 문장으로 옮기는 것뿐이다 — 지시문은 도구 설명이 갖는다 (prompts.md §5-2).
 */

const moneyRange = (label: string, anchor: number, room: { min: number; max: number }): string =>
  `${label}: 기준 ${formatMoney(anchor)} — ${formatMoney(room.min)} ~ ${formatMoney(room.max)} 안에서만 부를 수 있다`;

const VERDICT_KO: Record<string, string> = {
  accept: "수락",
  counter: "조정",
  reject: "결렬",
};

/** 코어가 박은 자리 — 확률·기준 판정·움직일 수 있는 폭 */
export function describeAnchor(anchor: CounterpartyAnchor): string {
  return [
    `<anchor>`,
    `성사 확률 ${anchor.probability}%` +
      (anchor.latitude > 0 ? ` · 확인된 논거가 연 여유 +${anchor.latitude}%p` : ""),
    `기준 판정: ${VERDICT_KO[anchor.verdict]}`,
    `고를 수 있는 판정: ${anchor.allowed.map((v) => VERDICT_KO[v]).join(" · ")}`,
    ...(anchor.fee !== undefined && anchor.feeRoom
      ? [moneyRange("조정 금액", anchor.fee, anchor.feeRoom)]
      : []),
    ...(anchor.weeklyWage !== undefined && anchor.wageRoom
      ? [moneyRange("조정 주급", anchor.weeklyWage, anchor.wageRoom)]
      : []),
    ...(anchor.contractYears !== undefined && anchor.yearsRoom
      ? [
          `조정 연수: 기준 ${anchor.contractYears}년 — ${anchor.yearsRoom.min}~${anchor.yearsRoom.max}년 안에서만 부를 수 있다`,
        ]
      : []),
    ...(anchor.squadStatus !== undefined && anchor.statusRoom
      ? [
          `조정 지위: 기준 ${SQUAD_STATUS_KO[anchor.squadStatus]} — ` +
            `${SQUAD_STATUS_KO[statusAtRank(anchor.statusRoom.min)]}~` +
            `${SQUAD_STATUS_KO[statusAtRank(anchor.statusRoom.max)]} 안에서만 부를 수 있다`,
        ]
      : []),
    ...(anchor.splittable
      ? [`나눠 받겠다면 paymentYears로 연수를 적는다 (2~${MAX_PAYMENT_YEARS})`]
      : []),
    /**
     * **기한은 날짜가 아니라 참·거짓으로 온다** (transfer.md §12-1). 코어가 날짜를
     * 박아 두었으므로 모델이 고를 것은 「걸 것인가」뿐이고, 비우면 걸린다 — 답하지
     * 않은 자리·mock과 같은 사다리를 쓰기 위해서다.
     */
    ...(anchor.ultimatumOn === undefined
      ? []
      : [
          `조정에 걸 수 있는 기한: ${anchor.ultimatumOn} — 걸면 협상이 그날 끝난다. ` +
            `걸지 않으려면 ultimatum: false`,
        ]),
    `</anchor>`,
  ].join("\n");
}

/**
 * `<counterparty>` 블록 — 답이 도착한 협상 하나의 서류. 이번 턴 층에 선다 (agents.md §5).
 * 답할 자리가 아니면(앵커가 없으면) `null`.
 */
export function buildCounterpartyBlock(
  state: GameState,
  negotiation: Negotiation,
  /** 앵커를 함께 실을지 — 테이블은 앵커를 대화 뒤에 따로 세운다 (negotiation-table.ts) */
  options: { withAnchor?: boolean } = {},
): string | null {
  const withAnchor = options.withAnchor ?? true;
  const anchor = counterpartyAnchor(state, negotiation);
  if (withAnchor && !anchor) return null;
  const brief = buildCounterpartyBrief(state, negotiation);
  if (!brief) return null;
  // 데이터 블록은 영어 태그로 싼다 (prompts.md §5) — 서류의 줄 안 레이블은 그대로다
  const cards = describeCharacters(
    brief.characterIds
      .map((id) => characterEntryOf(state, id, "full"))
      .filter((entry) => entry !== null),
  );
  return [
    `<counterparty id="${negotiation.id}">`,
    `<negotiation>${brief.kindKo} · 답하는 쪽: ${brief.counterpart} · 상대: ${brief.ourClub}</negotiation>`,
    `<player>`,
    ...brief.playerFacts,
    `</player>`,
    `<dossier>`,
    ...brief.dossier,
    `</dossier>`,
    ...(cards !== null ? [cards] : []),
    ...(withAnchor && brief.anchor ? [describeAnchor(brief.anchor)] : []),
    `</counterparty>`,
  ].join("\n");
}
