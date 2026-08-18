"use client";

import { formatMoney, type MarketCard, type MarketTerms } from "@story-fm/domain";
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
  withdraw: IconTrash,
  scout: IconInsight,
} as const;

const VERDICT_KO = { accept: "수락", reject: "거절", counter: "역제안" } as const;

/** 카드 머리의 표식 — 무슨 국면인지 한 낱말로 */
function badgeOf(card: MarketCard): string {
  switch (card.kind) {
    case "offer":
      return card.loan === true ? "임대 요청" : "오퍼";
    case "verdict":
      return card.verdict ? VERDICT_KO[card.verdict] : "판정";
    case "renewal":
      return "재계약 제안";
    case "withdraw":
      return "협상 철회";
    case "scout":
      return "스카우트 파견";
  }
}

/** 조건 한 벌 — 이적료·주급·연수 중 있는 것만 (임대료는 이적료 자리를 쓴다) */
function Terms({ terms, loan = false }: { terms: MarketTerms; loan?: boolean }) {
  return (
    <>
      {terms.fee !== undefined && (
        <span>
          <em>{loan ? "임대료" : "이적료"}</em>
          <b>{formatMoney(terms.fee)}</b>
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
   * 답의 결이 카드의 색을 정한다 — 수락은 강조색, 거절은 경고색, 역제안은 그 사이.
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

      {card.terms && (
        <div className="mc-terms">
          <em className="mc-side">제시</em>
          <Terms terms={card.terms} loan={card.loan === true} />
        </div>
      )}
      {card.counterTerms && (
        <div className="mc-terms demand">
          <em className="mc-side">요구</em>
          <Terms terms={card.counterTerms} loan={card.loan === true} />
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
