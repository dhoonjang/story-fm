"use client";

import type { MatchView } from "@story-fm/engine";
import { humanDate } from "@/lib/dateline";

/**
 * ── 킥오프 게이트 — 매치데이 프로그램 (match.md §8) ────────────
 *
 * **경기의 문.** `start_match`는 판을 세울 뿐이고 공은 감독이 들어갈 때 구른다.
 * 상주 버튼을 두면 그날의 대화가 무슨 이야기로 흐르든 화면이 늘 같은 손잡이 하나를
 * 들이민다 — GM이 문을 열었을 때만 이 창이 서고, 이것이 유일한 출구다. 닫는
 * 손잡이를 두면 되돌아간 자리에서 다시 열 방법이 없다.
 */
export function KickoffGate({
  match,
  date,
  busy,
  onEnter,
}: {
  match: MatchView;
  /** 오늘 — 게이트의 데이트라인이 읽는 날짜 */
  date: string;
  busy: boolean;
  onEnter: () => void;
}) {
  return (
    <div
      className="kickoff-gate"
      data-testid="kickoff-gate"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kickoff-heading"
    >
      <div className="kickoff-card">
        <span className="kickoff-tag" id="kickoff-heading">
          {/* 친선은 단계가 없다 — 가운뎃점이 홀로 남지 않게 */}
          {[match.competition, match.stage, match.stadium, humanDate(date)]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <div className="kickoff-teams">
          <b className={match.home.ours ? "ours" : undefined}>{match.home.name}</b>
          <i>vs</i>
          <b className={match.away.ours ? "ours" : undefined}>{match.away.name}</b>
        </div>
        <button
          className="primary-btn"
          autoFocus
          disabled={busy}
          /* 경기의 문도 손잡이다 — 킥오프 턴인지는 장부가 안다(`beforeKickoff`) */
          onClick={onEnter}
          data-testid="kickoff-enter"
        >
          경기장 입장
        </button>
      </div>
    </div>
  );
}
