"use client";

import type { NegotiationRoomView } from "@story-fm/engine";
import { humanDate } from "@/lib/dateline";
import {
  Odds,
  PatienceMeter,
  TermSheet,
  Voices,
  hasTermSheet,
} from "@/components/negotiation-room";

/**
 * ── 협상 게이트 — 자리에 앉는 문 (transfer.md §12-2 · design-system.md §7-1) ────
 *
 * 킥오프 게이트와 한 쌍이다. `start_negotiation`은 방을 세울 뿐이고 자리에 앉는 것은
 * 감독이다 — 그 턴부터 채팅의 주인이 협상 GM으로 바뀐다. 닫는 손잡이는 없다: 열린
 * 방은 앉거나 일어서는 길뿐이고, 일어서는 손잡이는 방 안에 선다.
 *
 * 앉기 전 마지막으로 읽는 한 장이라 방의 지금이 통째로 선다 — 데이트라인 · 건너편에
 * 앉을 사람들 · 지금의 조건서 · 성사 가능성 · 남은 인내. 값은 전부 뷰가 접어 온 것이다.
 */
export function NegotiationGate({
  room,
  date,
  busy,
  leaving = false,
  onEnter,
}: {
  room: NegotiationRoomView;
  /** 오늘 — 게이트의 데이트라인이 읽는 날짜 */
  date: string;
  busy: boolean;
  /** 감독이 지금 이 문을 지나는 중인가 — 무대는 이미 방이다(`GATE_LEAVE_MS`) */
  leaving?: boolean;
  onEnter: () => void;
}) {
  return (
    <div
      className={leaving ? "negotiation-gate leaving" : "negotiation-gate"}
      data-testid="negotiation-gate"
      role="dialog"
      aria-modal="true"
      aria-labelledby="negotiation-heading"
    >
      <div className="negotiation-card">
        <div className="ng-body">
          <span className="ng-dateline" id="negotiation-heading">
            {/* 상대가 선수 본인인 갈래는 이름이 아래 머리에 이미 선다 — 두 번 적지 않는다 */}
            {[
              room.kindLabel,
              room.counterpart === room.playerName ? null : room.counterpart,
              humanDate(date),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <b className="ng-who">{room.playerName}</b>

          <div className="ng-block">
            <span className="ng-label">건너편</span>
            <Voices voices={room.voices} />
          </div>

          {/* 위임장 — 앉는 순간 걷힌다 (transfer.md §12-4). 앉기 전의 마지막 한 장이 그 사실을 든다 */}
          {room.mandate && (
            <div className="ng-block" data-testid="negotiation-mandate">
              <span className="ng-label">위임</span>
              <span className="ng-mandate">
                <b>{room.mandate.to}</b>
                {[room.mandate.title, room.mandate.limit].filter(Boolean).map((part) => (
                  <span key={part}>{part}</span>
                ))}
                <i>앉으면 걷힌다</i>
              </span>
            </div>
          )}

          {/* 빈 협상(오퍼 없이 떠보는 자리)은 조건서가 없다 — 절 자체가 서지 않는다 */}
          {hasTermSheet(room) && (
            <div className="ng-block">
              <span className="ng-label">조건서</span>
              <TermSheet room={room} />
            </div>
          )}

          <div className="ng-row">
            <div className="ng-block">
              <span className="ng-label">성사</span>
              <Odds room={room} />
            </div>
            <div className="ng-block">
              <span className="ng-label">인내</span>
              <PatienceMeter patience={room.patience} />
            </div>
          </div>
        </div>
        <button
          className="primary-btn"
          autoFocus
          disabled={busy}
          /* 협상의 문도 손잡이다 — 무대는 누름과 함께 바뀌고, 그 턴이 앉는 턴인지는
             코어가 안다(`seated`) */
          onClick={onEnter}
          data-testid="negotiation-enter"
        >
          자리에 앉는다
        </button>
      </div>
    </div>
  );
}
