"use client";

import { Fragment } from "react";
import type { MatchView } from "@story-fm/engine";
import {
  TACTIC_AXES,
  TACTIC_SCALE_NEUTRAL,
  TACTIC_TOGGLES,
  tacticToggleValue,
  tacticToggleWord,
  tacticWord,
} from "@story-fm/domain";
import { Crest } from "@/components/crest";
import { humanDate } from "@/lib/dateline";

type GateTeam = MatchView["home"];
type GateTactics = MatchView["tactics"]["home"];
type GatePlayer = MatchView["onPitch"]["home"][number];

/** 대진 문장의 크기 — 매치데이 프로그램의 머리 (match.md §8) */
const FIXTURE_CREST = 64;

/**
 * ── 킥오프 게이트 — 매치데이 프로그램 (match.md §8) ────────────
 *
 * **경기의 문.** `start_match`는 판을 세울 뿐이고 공은 감독이 들어갈 때 구른다.
 * 상주 버튼을 두면 그날의 대화가 무슨 이야기로 흐르든 화면이 늘 같은 손잡이 하나를
 * 들이민다 — GM이 문을 열었을 때만 이 창이 서고, 이것이 유일한 출구다. 닫는
 * 손잡이를 두면 되돌아간 자리에서 다시 열 방법이 없다.
 *
 * 경기장에 들어서기 전 감독이 마지막으로 읽는 한 장이라 오늘의 판이 통째로 선다:
 * 데이트라인 · 대진 · 팀시트 · 감독 노트 · 입장. 값은 전부 뷰가 이미 접어 온
 * 것이고 게이트가 새로 만드는 사실은 없다.
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
  const ours = match.home.ours ? "home" : "away";
  return (
    <div
      className="kickoff-gate"
      data-testid="kickoff-gate"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kickoff-heading"
    >
      <div className="kickoff-card">
        {/* 읽는 것만 스크롤한다 — 주 버튼이 이 안에 있으면 `autoFocus`가 카드를 끝까지
            밀어 내려 열리는 순간 대진이 화면 밖에 선다 */}
        <div className="kg-body">
          <span className="kg-dateline" id="kickoff-heading">
            {/* 친선은 단계가 없고 미등재 클럽은 경기장이 없다 — 가운뎃점이 홀로 남지 않게 */}
            {[match.competition, match.stage, match.stadium, humanDate(date)]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {/* 홈이 왼쪽·원정이 오른쪽 — 스코어보드·득점과 좌우가 늘 같다 (design-system §2 규칙 4) */}
          <div className="kg-fixture">
            <FixtureSide team={match.home} venue="홈" rating={match.xiRating.home} />
            <FixtureSide team={match.away} venue="원정" rating={match.xiRating.away} />
          </div>
          {/* 700 아래에서 팀시트가 접히는 손잡이 — 폈다 접는 상태를 CSS만으로 든다.
            넓은 화면에서는 둘 다 걷히고 팀시트가 늘 펼쳐져 있다 (match-gate.css) */}
          <input type="checkbox" id="kg-xi" className="kg-xi-toggle" />
          <label htmlFor="kg-xi" className="kg-xi-summary">
            선발 11명
          </label>
          <div className="kg-sheets">
            <TeamSheet team={match.home} players={match.onPitch.home} />
            <TeamSheet team={match.away} players={match.onPitch.away} />
          </div>
          <ManagerNotes tactics={match.tactics[ours]} exploiting={match.exploiting} />
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

/**
 * 대진 한쪽 — 문장·이름·홈원정·**XI 평균 전력**.
 *
 * 견줄 숫자는 이 하나뿐이다. 상대 쪽 값은 뷰가 안개를 지나 접어 둔 것이라
 * (`xiRating`) 화면이 열한 명을 다시 평균 내면 우리와 다른 자로 잰 값이 된다.
 */
function FixtureSide({ team, venue, rating }: { team: GateTeam; venue: string; rating: number }) {
  return (
    <div className={`kg-side ${team.ours ? "ours" : "theirs"}`}>
      <Crest id={team.id} shortName={team.short} colours={team.colours} size={FIXTURE_CREST} />
      <b className="kg-club">{team.name}</b>
      <span className="kg-side-foot">
        <span className="kg-venue">{venue}</span>
        {/* 「XI」가 라틴이라 스코어 서체가 한글 옆에 서지 않는다 (design-system §3) */}
        <span className="kg-rating">
          XI <b className="fig">{rating}</b>
        </span>
      </span>
    </div>
  );
}

/**
 * 팀시트 한 열 — **등번호 · 포지션 · 이름뿐이다.**
 *
 * 셋은 90분 동안 보이는 공개 사실이라 안개를 지나지 않지만 선수별 전력은 상대 쪽에서
 * 흐린 값이다 — 열한 줄에 흐린 숫자를 세우면 팀시트가 스카우팅 리포트가 된다
 * (match.md §8).
 */
function TeamSheet({ team, players }: { team: GateTeam; players: GatePlayer[] }) {
  return (
    <div className={`kg-sheet ${team.ours ? "ours" : "theirs"}`}>
      <b className="kg-sheet-head">{team.name}</b>
      <ol className="kg-xi-list">
        {players.map((p) => (
          <li className="kg-line" key={p.id}>
            <span className="kg-no fig">{p.squadNumber ?? "—"}</span>
            <span className="kg-pos">{p.position}</span>
            <span className="kg-player">{p.name}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** 노트 한 줄 — 이름과 그 이름이 든 값들 */
interface NoteRow {
  key: string;
  values: string[];
}

/**
 * 감독 노트 — **이 경기에 걸어 둔 것.**
 *
 * 전부 판세·전술판이 이미 세우는 값이라 게이트가 따로 만드는 문장이 없다.
 * **중립인 축과 갈래는 서지 않는다**: 지시하지 않은 것까지 세우면 무엇을 건 판인지
 * 읽히지 않는다 (match.md §1.2). 걸어 둔 것이 하나도 없으면 절 자체가 서지 않는다.
 */
function ManagerNotes({ tactics, exploiting }: { tactics: GateTactics; exploiting: string[] }) {
  const rows: NoteRow[] = [];
  if (tactics.formation) rows.push({ key: "포메이션", values: [tactics.formation] });
  for (const axis of TACTIC_AXES) {
    const value = tactics[axis.key];
    if (value === TACTIC_SCALE_NEUTRAL) continue;
    rows.push({ key: axis.label, values: [tacticWord(axis.key, value)] });
  }
  for (const toggle of TACTIC_TOGGLES) {
    const value = tacticToggleValue(tactics, toggle.key);
    if (value === null) continue;
    rows.push({ key: toggle.label, values: [tacticToggleWord(toggle.key, value)] });
  }
  if (exploiting.length > 0) rows.push({ key: "공략 중", values: exploiting });
  if (tactics.notes.length > 0) rows.push({ key: "전술 노트", values: tactics.notes });
  if (rows.length === 0) return null;
  return (
    <div className="kg-notes">
      <span className="kg-label">감독 노트</span>
      <dl className="kg-note-rows">
        {rows.map((row) => (
          <Fragment key={row.key}>
            <dt>{row.key}</dt>
            <dd>
              {row.values.map((value, i) => (
                <span key={i}>{value}</span>
              ))}
            </dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}
