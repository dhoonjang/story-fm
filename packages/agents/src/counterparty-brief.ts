import {
  MAX_PAYMENT_YEARS,
  SQUAD_STATUS_KO,
  statusAtRank,
  type Negotiation,
} from "@story-fm/domain";
import {
  buildCounterpartyBrief,
  characterEntryOf,
  formatMoney,
  type CounterpartyAnchor,
  type CounterpartyVoice,
  type GameState,
  type TableSeat,
  type TermAsk,
} from "@story-fm/engine";
import { describeCharacters } from "./gm-input";

/**
 * 교섭 서류 — **협상 상대가 읽는 입력** (docs/llm/agents.md §4-1 · docs/simulation/transfer.md
 * §12-1). 편지(`negotiation-table.ts`)는 한 요청에 서류 전부를 싣고, 협상 방
 * (`negotiation-gm.ts`)은 협상이 사는 동안 그대로인 부분을 레퍼런스에, 라운드마다 바뀌는
 * 부분을 `<table>` 스냅샷에 나눠 싣는다 — 같은 서류를 두 자리가 나눠 읽는다.
 *
 * 코어가 서류와 앵커를 내고, 그 호출이 답하며, 코어가 앵커 ± 한도로 자른다. 여기 있는
 * 것은 사실을 문장으로 옮기는 것뿐이다 — 지시문은 시스템 프롬프트가 갖는다 (prompts.md §5-2).
 */

const moneyRange = (label: string, anchor: number, room: { min: number; max: number }): string =>
  `${label}: 기준 ${formatMoney(anchor)} — ${formatMoney(room.min)} ~ ${formatMoney(room.max)} 안에서만 부를 수 있다`;

const VERDICT_KO: Record<string, string> = {
  accept: "수락",
  counter: "조정",
  reject: "결렬",
};

/**
 * **상대가 부를 수 있는 조건** — 갈래와, 값이 있는 갈래는 기준과 구간 (transfer.md §12-3).
 * 편지·테이블의 앵커와, 오퍼가 없는 테이블의 앵커 자리가 같은 줄을 읽는다 — 줄의 첫
 * 낱말이 곧 모델이 `asks`의 `kind`에 적는 토큰이다.
 */
export function describeAsks(asks: readonly TermAsk[]): string[] {
  if (asks.length === 0) return [];
  return [
    `부를 수 있는 조건 (한 답에 둘까지, 이 갈래 안에서만):`,
    ...asks.map((ask) => {
      const head = `- ${ask.kind}(${ask.label})`;
      if (ask.anchor === undefined || !ask.room) return head;
      return ask.kind === "escalator"
        ? `${head}: 기준 ${ask.anchor}% — ${ask.room.min}~${ask.room.max}% 안에서만`
        : `${head}: 기준 ${formatMoney(ask.anchor)} — ${formatMoney(ask.room.min)} ~ ${formatMoney(ask.room.max)} 안에서만`;
    }),
  ];
}

/** 코어가 박은 자리 — 확률·기준 판정·움직일 수 있는 폭 */
export function describeAnchor(anchor: CounterpartyAnchor): string {
  return [
    `<anchor>`,
    /**
     * **개인 조건 제안의 앵커**는 관문이 하나다 (transfer.md §12-3) — 이적료·분할·기한이
     * 없고, 판정의 축은 주급·지위뿐이다. 첫 줄이 그 사실을 말한다.
     */
    ...(anchor.personal
      ? [
          `개인 조건 제안에 답한다 — 선수 관문 ${anchor.playerOdds}%` +
            (anchor.latitude > 0 ? ` · 확인된 논거가 연 여유 +${anchor.latitude}%p` : ""),
        ]
      : [
          `성사 확률 ${anchor.probability}%` +
            (anchor.latitude > 0 ? ` · 확인된 논거가 연 여유 +${anchor.latitude}%p` : ""),
          /**
           * **관문별 확률** — 성사 확률 하나를 만든 두 조각이다 (transfer.md §12-1). 목소리가
           * 둘인 테이블에서 각자 자기 관문을 근거로 말하라고 싣는다. 판정을 가르는 것은
           * 여전히 위의 하나다.
           */
          (anchor.clubOdds === undefined ? "" : `구단 관문 ${anchor.clubOdds}% · `) +
            `선수 관문 ${anchor.playerOdds}%`,
        ]),
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
    ...describeAsks(anchor.asks),
    `</anchor>`,
  ].join("\n");
}

/**
 * `<voices>` — **누가 무엇을 답하나** (transfer.md §12-1). 줄의 첫 낱말이 곧 모델이 답의
 * 화자 칸에 적는 토큰이다: 적어 주지 않으면 모델이 그 자리에 이름을 적거나 갈래를
 * 짐작한다 (지위 낱말을 `SQUAD_STATUS_LINE`이 적어 주는 것과 같은 자리다 — prompts.md §2).
 * 목소리가 하나인 갈래는 줄도 하나다.
 */
function describeVoices(voices: readonly CounterpartyVoice[]): string[] {
  if (voices.length === 0) return [];
  return [
    `<voices>`,
    ...voices.map((v) => `${v.speaker} “${v.name}” — ${v.answers.join(" · ")}`),
    `</voices>`,
  ];
}

/**
 * `<counterparty>` 블록 — 협상 하나의 서류. 앵커는 싣지 않는다 — 그것은 대화 뒤에 따로
 * 선다(`describeSeatAnchor`). 열린 협상이 아니면 `null`.
 *
 * `dossier: false`면 라운드마다 바뀌는 `<dossier>`(오퍼 이력·값의 자·조건서·개인 조건)를
 * 뺀다 — 협상 방의 레퍼런스가 그 꼴이고, 뺀 것은 `<table>` 스냅샷이 싣는다 (agents.md §5).
 */
export function buildCounterpartyBlock(
  state: GameState,
  negotiation: Negotiation,
  options: { dossier?: boolean } = {},
): string | null {
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
    `<negotiation>${brief.kindKo} · 건너편: ${brief.counterpart} · 감독의 구단: ${brief.ourClub}</negotiation>`,
    ...describeVoices(brief.voices),
    `<player>`,
    ...brief.playerFacts,
    `</player>`,
    ...(options.dossier === false ? [] : [`<dossier>`, ...brief.dossier, `</dossier>`]),
    ...(cards !== null ? [cards] : []),
    `</counterparty>`,
  ].join("\n");
}

/**
 * `<anchor>` — 남은 인내와, 오퍼가 올라 있으면 코어가 박은 판정과 구간. 오퍼가 없어도
 * 「부를 수 있는 조건」은 선다 — 조건은 오퍼 없이도 부를 수 있다 (transfer.md §12-3).
 * 편지의 요청 끝과 방의 `<table>` 스냅샷이 같은 블록을 읽는다.
 */
export function describeSeatAnchor(seat: TableSeat): string {
  const patience = `남은 인내 ${seat.table.patience}/${seat.table.patienceMax}`;
  if (!seat.anchor) {
    return [
      `<anchor>`,
      patience,
      `테이블에 오퍼가 없다 — 판정할 것이 없다`,
      ...describeAsks(seat.asks),
      `</anchor>`,
    ].join("\n");
  }
  return describeAnchor(seat.anchor).replace(`<anchor>`, `<anchor>\n${patience}`);
}
