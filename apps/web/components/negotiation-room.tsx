"use client";

import type { NegotiationRoomView } from "@story-fm/engine";
import { formatMoney, type ProposalPrefill } from "@story-fm/domain";
import { Crest } from "@/components/crest";
import { IconPerson } from "@/components/icons";
import { Terms } from "@/components/market-card";
import { useProposal } from "@/components/proposal-form";
import { humanDate } from "@/lib/dateline";

/**
 * ── 협상 방 — 채팅 옆의 한 칸 (transfer.md §12-2 · design-system.md §7-1) ─────
 *
 * 경기가 판세를 갖듯 협상은 **조건서 · 인내 · 건너편**을 갖는다. 값은 전부 뷰
 * (`views.negotiation`)가 접어 온 것이고 여기서 새로 만드는 사실은 없다 — 인내의
 * 결(`tone`)도 뷰가 낸다. 화면이 숫자를 다시 자르지 않는다.
 *
 * 손잡이는 둘이고 둘 다 방에서만 산다: 「제안서 작성」은 폼을 방의 협상으로 미리 채워 열고,
 * 「협상 끝내기」는 협상을 열어 둔 채 방만 닫는다 — 오늘의 자리를 끝내는 것이고, 협상은
 * 코어가 굳히는 라운드로 이어지며 다시 나설 수 있다. 빈 입력에 눌리는 버튼이 물러나는
 * 문이면 실수가 협상을 끊는다 — 그래서 입력창이 아니라 여기 선다.
 */
export function NegotiationRoom({
  room,
  busy,
  onLeave,
}: {
  room: NegotiationRoomView;
  busy: boolean;
  onLeave: () => void;
}) {
  const proposal = useProposal();
  return (
    <div className="negotiation-room" data-testid="negotiation-room">
      <header className="nr-head">
        <span className="nr-kind">{room.kindLabel}</span>
        <b className="nr-who">{room.playerName}</b>
        {/* 상대가 선수 본인인 갈래(재계약·해지)는 같은 이름을 두 번 적지 않는다 */}
        {room.counterpart !== room.playerName && (
          <span className="nr-counterpart">{room.counterpart}</span>
        )}
      </header>

      <section className="nr-section">
        <span className="nr-label">건너편</span>
        <Voices voices={room.voices} />
      </section>

      <section className="nr-section">
        <span className="nr-label">인내</span>
        <PatienceMeter patience={room.patience} />
      </section>

      {hasTermSheet(room) && (
        <section className="nr-section">
          <span className="nr-label">조건서</span>
          <TermSheet room={room} />
        </section>
      )}

      <section className="nr-section">
        <span className="nr-label">성사</span>
        <Odds room={room} />
      </section>

      <div className="nr-handles">
        {proposal !== null && (
          <button
            type="button"
            className="nr-btn propose"
            disabled={busy}
            onClick={() => proposal.open(room.playerId, prefillOf(room))}
            data-testid="negotiation-propose"
          >
            제안서 작성
          </button>
        )}
        <button
          type="button"
          className="nr-btn leave"
          disabled={busy}
          onClick={onLeave}
          data-testid="negotiation-leave"
        >
          협상 끝내기
        </button>
      </div>
    </div>
  );
}

/**
 * 건너편의 목소리 — 구단이면 문장 + 구단, 선수 쪽이면 이름. 그 아래 **무엇을 답하는가**
 * (이적료 · 분할 · 기한 / 주급 · 연수 · 지위). 게이트와 방이 같은 줄을 세운다.
 */
export function Voices({ voices }: { voices: NegotiationRoomView["voices"] }) {
  return (
    <ul className="nr-voices">
      {voices.map((voice) => (
        <li className="nr-voice" key={`${voice.speaker}-${voice.name}`}>
          {voice.team ? (
            <Crest
              id={voice.team.id}
              shortName={voice.team.short}
              colours={voice.team.colours}
              size={24}
            />
          ) : (
            <span className="nr-voice-mark" aria-hidden>
              <IconPerson size={16} />
            </span>
          )}
          <span className="nr-voice-who">
            <b className="nr-voice-name">{voice.name}</b>
            <em className="nr-voice-title">
              {voice.team ? `${voice.team.name} ${voice.title}` : voice.title}
            </em>
          </span>
          {voice.answers.length > 0 && (
            <span className="nr-voice-answers">
              {voice.answers.map((answer) => (
                <span key={answer}>{answer}</span>
              ))}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * 인내 — 방의 시계 (transfer.md §12-2). 칸 `max`개, 남은 만큼 채워지고 숫자가 옆에 선다.
 * 색이 갈리는 문턱은 여기 없다 — `data-tone`은 뷰가 낸 값이고 CSS가 그것만 읽는다.
 */
export function PatienceMeter({ patience }: { patience: NegotiationRoomView["patience"] }) {
  const { left, max, tone } = patience;
  return (
    <div
      className="patience"
      data-tone={tone}
      role="img"
      aria-label={`인내 ${left}/${max}`}
      data-testid="negotiation-patience"
    >
      <span className="patience-cells">
        {Array.from({ length: max }, (_, i) => (
          <i key={i} className={i < left ? "on" : ""} />
        ))}
      </span>
      <b className="fig">
        {left}/{max}
      </b>
    </div>
  );
}

/** 걸린 조건 한 줄의 답 — 코어가 낸 값 셋을 화면의 낱말로 */
const ANSWER_KO = { granted: "수락", refused: "거절" } as const;

/** 조건서에 세울 것이 하나라도 있는가 — 없으면 절 자체가 서지 않는다 (감독 노트와 같은 규약) */
export function hasTermSheet(room: NegotiationRoomView): boolean {
  return (
    room.ours !== null ||
    room.theirs !== null ||
    room.terms.length > 0 ||
    room.personal !== null ||
    room.feeAgreed !== null ||
    room.pitched.length > 0
  );
}

/**
 * 조건서 — 시장 카드의 표와 같은 격자 (`.mc-table`). 「제시」 한 줄과 「조정」 한 줄, 그
 * 아래 걸린 조건 목록(누가 · 갈래 · 답)과 개인 조건 선합의. 값의 자는 `formatMoney`다.
 */
export function TermSheet({ room }: { room: NegotiationRoomView }) {
  return (
    <div className="nr-sheet">
      {(room.ours || room.theirs) && (
        <div className="mc-table">
          {room.ours && (
            <div className="mc-terms">
              <em className="mc-side">제시</em>
              <div className="mc-vals">
                <Terms terms={room.ours} loan={room.loan} />
              </div>
            </div>
          )}
          {room.theirs && (
            <div className="mc-terms demand">
              <em className="mc-side">조정</em>
              <div className="mc-vals">
                <Terms terms={room.theirs} loan={room.loan} />
              </div>
            </div>
          )}
        </div>
      )}
      {room.feeAgreed && (
        <div className="nr-personal" data-agreed>
          <em className="mc-side">이적료 합의</em>
          <div className="mc-vals">
            <span>
              <em>이적료</em>
              <b>{formatMoney(room.feeAgreed.fee)}</b>
            </span>
          </div>
        </div>
      )}
      {room.personal && (
        <div className="nr-personal" data-agreed={room.personal.agreed || undefined}>
          <em className="mc-side">
            {room.personal.agreed
              ? "개인 조건 합의"
              : room.personal.countered
                ? "개인 조건 조정"
                : "개인 조건"}
          </em>
          <div className="mc-vals">
            <span>
              <em>주급</em>
              <b>{formatMoney(room.personal.weeklyWage)}</b>
            </span>
            <span>
              <em>기간</em>
              <b>{room.personal.years}년</b>
            </span>
          </div>
        </div>
      )}
      {room.terms.length > 0 && (
        <ul className="nr-terms">
          {room.terms.map((term, i) => (
            <li key={i} data-by={term.by} data-answer={term.answer ?? "pending"}>
              <span className="nr-term-by">{term.by === "us" ? "우리" : "상대"}</span>
              <b className="nr-term-label">{term.label}</b>
              {term.answer && <em className="nr-term-answer">{ANSWER_KO[term.answer]}</em>}
            </li>
          ))}
        </ul>
      )}
      {room.pitched.length > 0 && (
        <div className="mc-pitch">
          {room.pitched.map((claim) => (
            <span className="on" key={claim}>
              {claim}
            </span>
          ))}
        </div>
      )}
      {room.awaiting && <span className="nr-awaiting">답 대기</span>}
    </div>
  );
}

/** 성사 가능성(코어가 낸 표기 그대로)과 기한 — 상대가 건 기한이면 그렇게 적힌다 */
export function Odds({ room }: { room: NegotiationRoomView }) {
  return (
    <div className="nr-odds">
      {room.odds !== null && (
        <span className="nr-odds-val">
          <em>성사 가능성</em>
          <b>{room.odds}</b>
        </span>
      )}
      <span className="nr-deadline" data-ultimatum={room.deadline.ultimatum || undefined}>
        <em>{room.deadline.ultimatum ? "상대가 건 기한" : "기한"}</em>
        <b>{humanDate(room.deadline.on)}</b>
      </span>
    </div>
  );
}

/**
 * 방이 폼에 미리 채우는 값 — 상대의 조정안이 있으면 그것, 없으면 우리 마지막 오퍼다
 * (시장 카드와 같은 규약 · transfer.md §12-3). 폼이 갖는 갈래(영입·임대 영입·재계약)에
 * 드는 방만 갈래를 적고, 나머지는 폼이 스스로 고른다.
 */
function prefillOf(room: NegotiationRoomView): ProposalPrefill {
  const terms = room.theirs ?? room.ours;
  const kind =
    room.kind === "renew"
      ? "renew"
      : room.kind === "loan"
        ? "loan"
        : room.kind === "buy"
          ? "buy"
          : undefined;
  return {
    ...(kind === undefined ? {} : { kind }),
    ...(terms?.fee === undefined ? {} : { fee: terms.fee }),
    ...(terms?.paymentYears === undefined ? {} : { paymentYears: terms.paymentYears }),
    ...(terms?.weeklyWage === undefined ? {} : { weeklyWage: terms.weeklyWage }),
    ...(terms?.years === undefined ? {} : { years: terms.years }),
  };
}
