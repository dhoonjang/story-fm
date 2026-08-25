"use client";

import {
  formatMoney,
  marketDirectionKo,
  type MarketCard,
  type MarketTerms,
} from "@story-fm/domain";
import { IconFinance, IconInsight, IconPerson, IconTrash } from "@/components/icons";

/**
 * **협상·스카우트 카드** — 갈 화면이 없는 스킬의 결과가 서는 자리.
 *
 * 진행 중인 협상은 어느 장부에도 실리지 않아서 레일이 알릴 수 없고, 칩 속에 줄글로
 * 접어 두면 조건을 견주려 매번 펼쳐야 했다. 금액·확률·기한은 **다음 판단의 입력**이라
 * 문단 밖으로 꺼내 한 줄씩 세운다 — 골 카드가 그런 것처럼.
 *
 * 내용은 전부 코어가 실어 보낸 사실이다(`MarketCard`) — 중계 문장을 되읽지 않는다.
 * 상대의 한마디만 LLM의 것이고, 그건 인용으로 따로 앉힌다.
 */

const KIND_ICON = {
  offer: IconFinance,
  verdict: IconFinance,
  renewal: IconPerson,
  release: IconPerson,
  withdraw: IconTrash,
  scout: IconInsight,
} as const;

/**
 * 배지의 판정 낱말 — 방향 뒤에 붙어 한 낱말이 되므로 명사형이다. `조정`을 그대로
 * 붙이면 `매각 조정`이 "매각을 손본다"는 행위로 읽힌다; 상대가 낸 것은 조정된 조건,
 * 곧 조정안이다.
 */
const VERDICT_KO = { accept: "수락", reject: "거절", counter: "조정안" } as const;

/** 조건의 축 — 상대 줄의 이름표가 고르는 순서이자 `Terms`가 세우는 순서다 */
const AXIS_KO: ReadonlyArray<[keyof MarketTerms, string]> = [
  ["fee", "이적료"],
  ["severance", "정산금"],
  ["paymentYears", "분할"],
  ["weeklyWage", "주급"],
  ["years", "연수"],
];

/**
 * 상대 줄의 이름표 — **움직인 축의 이름**이다 (`이적료 조정` · `주급·연수 조정`).
 *
 * 배지는 방향을 싣고 이 줄은 무엇이 움직였는지를 싣는다. 우리 조건과 대조해 달라진
 * 축만 고르므로 낱말이 숫자와 어긋나지 않는다; 대조할 우리 조건이 없으면 `조정`만 선다.
 */
function demandLabelOf(card: MarketCard, loan: boolean): string {
  const ours = card.terms;
  const theirs = card.counterTerms;
  if (!ours || !theirs) return "조정";
  const moved = AXIS_KO.filter(
    ([key]) => theirs[key] !== undefined && theirs[key] !== ours[key],
  ).map(([key, label]) => (key === "fee" && loan ? "임대료" : label));
  return moved.length > 0 ? `${moved.join("·")} 조정` : "조정";
}

/**
 * 카드 머리의 표식 — **무슨 국면인가에 앞서 어느 방향인가.**
 *
 * 방향은 협상에서 가장 큰 사실이고 채팅이 유일한 인터페이스라, 배지가 말하지
 * 않으면 카드만 봐서는 사는 건지 파는 건지 알 길이 없다. 낱말은 `marketDirectionKo`
 * 하나에서 나온다 — 요약 줄·주의 줄과 같은 말을 써야 같은 거래로 읽힌다.
 *
 * 방향이 없는 카드(재계약, 이 축이 생기기 전의 옛 카드)에서는 국면만 선다.
 */
function badgeOf(card: MarketCard): string {
  const way = card.direction && marketDirectionKo(card.direction, card.loan === true);
  switch (card.kind) {
    case "offer":
      if (way) return `${way} 오퍼`;
      return card.loan === true ? "임대 요청" : "오퍼";
    case "verdict": {
      const phase = card.verdict ? VERDICT_KO[card.verdict] : "판정";
      return way ? `${way} ${phase}` : phase;
    }
    case "renewal":
      return "재계약 제안";
    case "release":
      return "해지 제안";
    case "withdraw":
      return way ? `${way} 철회` : "협상 철회";
    case "scout":
      return "스카우트 파견";
  }
}

/** 조건 한 벌 — 정산금·이적료·분할·주급·연수 중 있는 것만 (임대료는 이적료 자리를 쓴다) */
function Terms({ terms, loan = false }: { terms: MarketTerms; loan?: boolean }) {
  return (
    <>
      {terms.fee !== undefined && (
        <span>
          <em>{loan ? "임대료" : "이적료"}</em>
          <b>{formatMoney(terms.fee)}</b>
        </span>
      )}
      {terms.severance !== undefined && (
        <span>
          <em>정산금</em>
          <b>{formatMoney(terms.severance)}</b>
        </span>
      )}
      {/* 분할은 금액에 붙은 조건이라 이적료·정산금 바로 뒤에 선다 — 계약 `기간`과 붙여 두면 어느 연수인지 헷갈린다 */}
      {terms.paymentYears !== undefined && (
        <span>
          <em>지급</em>
          <b>{terms.paymentYears}년 분할</b>
        </span>
      )}
      {terms.weeklyWage !== undefined && (
        <span>
          <em>주급</em>
          <b>{formatMoney(terms.weeklyWage)}</b>
        </span>
      )}
      {terms.years !== undefined && (
        <span>
          <em>기간</em>
          <b>{terms.years}년</b>
        </span>
      )}
    </>
  );
}

export function MarketCardView({ card }: { card: MarketCard }) {
  const Icon = KIND_ICON[card.kind];
  /**
   * 답의 결이 카드의 색을 정한다 — 수락은 강조색, 거절은 경고색, 조정은 그 사이.
   * 금액을 읽기 전에 잘 됐는지가 보여야 스크롤을 훑을 때 눈이 걸린다.
   */
  const tone =
    card.kind === "verdict" && card.verdict
      ? ` ${card.verdict}`
      : card.kind === "withdraw"
        ? " reject"
        : "";
  return (
    <div className={`market-card${tone}`} data-testid={`market-${card.kind}`}>
      <div className="mc-head">
        <span className="mc-icon" aria-hidden>
          <Icon size={14} />
        </span>
        <span className="mc-badge">{badgeOf(card)}</span>
        <b className="mc-who">{card.playerName}</b>
        {/* 재계약은 상대가 선수 본인이라 같은 이름을 두 번 적지 않는다 */}
        {card.counterpart !== card.playerName && (
          <span className="mc-counterpart">{card.counterpart}</span>
        )}
        {/* 답이 남은 카드에만 선다 — 값이 없으면 이름표도 서지 않는다 */}
        {card.odds && (
          <span className="mc-odds">
            <em>성사 가능성</em>
            <b>{card.odds}</b>
          </span>
        )}
      </div>

      {/* 두 줄이 한 그리드다 — 이름표 열이 가장 긴 이름표에 맞춰 늘어나 값이 같은 자리에서 시작한다 */}
      {(card.terms || card.counterTerms) && (
        <div className="mc-table">
          {card.terms && (
            <div className="mc-terms">
              <em className="mc-side">제시</em>
              <div className="mc-vals">
                <Terms terms={card.terms} loan={card.loan === true} />
              </div>
            </div>
          )}
          {card.counterTerms && (
            <div className="mc-terms demand">
              <em className="mc-side">{demandLabelOf(card, card.loan === true)}</em>
              <div className="mc-vals">
                <Terms terms={card.counterTerms} loan={card.loan === true} />
              </div>
            </div>
          )}
        </div>
      )}

      {card.pitch && card.pitch.length > 0 && (
        <div className="mc-pitch">
          {card.pitch.map((p, i) => (
            <span className={p.verified ? "on" : ""} key={i}>
              {p.label}
            </span>
          ))}
        </div>
      )}

      <div className="mc-foot">
        {card.dueOn && (
          <span className="mc-due">
            <em>{card.kind === "scout" ? "보고 예정" : "답"}</em>
            <b>{card.dueOn}</b>
          </span>
        )}
        {/**
         * 상대의 답에 붙은 한마디는 **사람의 말**이라 인용으로 앉힌다. 나머지(현 계약
         * 만료일·몇 번째 파견인가)는 코어가 적은 사실이므로 따옴표를 달지 않는다.
         */}
        {card.note &&
          (card.kind === "verdict" ? (
            <q className="mc-note said">{card.note}</q>
          ) : (
            <span className="mc-note">{card.note}</span>
          ))}
      </div>
    </div>
  );
}
