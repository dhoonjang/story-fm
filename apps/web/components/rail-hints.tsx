"use client";

import { Fragment } from "react";
import type { HintLine, PanelHint, PanelKey } from "@/lib/panel-hints";
import { abbreviateRoles, splitNote } from "@/lib/hint-text";
import {
  IconBoard,
  IconCalendar,
  IconCaptain,
  IconCareer,
  IconDay,
  IconFinance,
  IconInsight,
  IconJersey,
  IconMatch,
  IconPerson,
  IconSquad,
  IconTrophy,
} from "@/components/icons";

/**
 * **바뀐 장부를 알리는 말풍선** — 아이콘 줄 아래 한 장.
 *
 * 아이콘마다 따로 띄우지 않는다. 한 스킬이 두 장부를 건드리는 일이 흔해서
 * (계약 확정 = 선수 + 돈) 아이콘별로 세우면 말풍선끼리 겹친다. 대신 꼬리가
 * **첫 장부의 아이콘**을 가리켜 어디서 나온 말인지 잇는다.
 */

/** 아이콘 하나 — 크기는 CSS가 정하므로 인자 없이 세운다 */
type IconComponent = (props: { size?: number }) => React.ReactElement;

const PANEL_ICON: Record<PanelKey, IconComponent> = {
  스쿼드: IconSquad,
  달력: IconCalendar,
  재정: IconFinance,
  대회: IconTrophy,
  커리어: IconCareer,
};

/** 아이콘 줄에서의 자리 — 꼬리가 몇 칸 왼쪽을 가리킬지 정한다 */
const PANEL_ORDER: PanelKey[] = ["스쿼드", "달력", "재정", "대회", "커리어"];

/**
 * 스킬 → 아이콘 — **줄이 무엇에 관한 것인지 먼저 보인다.**
 *
 * 문장을 읽기 전에 갈래가 눈에 들어야 세 줄이 글자 벽으로 안 보인다.
 * 없는 스킬은 그 장부의 아이콘이 대신 선다.
 */
const SKILL_ICON: Record<string, IconComponent> = {
  // 판(팀 전술)과 사람(명단·개인)을 갈라 둔다 — 같은 그림이 반복되면 갈래가 안 읽힌다
  set_tactics: IconBoard,
  set_lineup: IconSquad,
  set_player_tactic: IconJersey,
  set_captain: IconCaptain,
  substitute: IconPerson,
  set_transfer_list: IconPerson,
  release_player: IconPerson,
  recall_loan: IconPerson,
  // 계약 확정은 재정 장부에도 서므로 사람 쪽으로 — 그 칸의 머리 아이콘이 이미 돈이다
  accept_deal: IconPerson,
  apply_narrative_event: IconInsight,
  rate_players: IconInsight,
  set_training: IconDay,
  clear_training: IconDay,
  start_match: IconMatch,
  finalize_match: IconTrophy,
  apply_finance_event: IconFinance,
  adjust_transfer_budget: IconFinance,
};

/**
 * 오르내린 수치에 색을 준다 — `+20`은 이득, `−1`은 손해.
 *
 * ASCII 하이픈은 잡지 않는다: 포메이션(`4-2-3-1`)과 구분되지 않는다.
 * 코어가 쓰는 감소 부호는 유니코드 −(U+2212)다.
 */
const DELTA = /([+−]\d[\d,.]*)/g;

function withDelta(text: string) {
  return text.split(DELTA).map((part, i) => {
    if (!/^[+−]\d/.test(part)) return <Fragment key={i}>{part}</Fragment>;
    return (
      <b key={i} className={part.startsWith("+") ? "up" : "down"}>
        {part}
      </b>
    );
  });
}

function HintRow({ line }: { line: HintLine }) {
  const Icon = SKILL_ICON[line.skill];
  // 사족 안에서도 수치는 보여야 한다 — 설명만 흐리게 눕힌다
  const note = line.note === undefined ? undefined : splitNote(abbreviateRoles(line.note));
  return (
    <span className="rail-hint-line">
      <span className="rail-hint-mark">{Icon ? <Icon /> : null}</span>
      <span className="rail-hint-what">
        {withDelta(abbreviateRoles(line.text))}
        {note && (
          <i>
            {note.fact !== "" && <em>{withDelta(note.fact)}</em>}
            {note.aside}
          </i>
        )}
      </span>
    </span>
  );
}

export function RailHints({
  hints,
  pinned = false,
}: {
  hints: readonly PanelHint[];
  /** 칩으로 되부른 말풍선인가 — 부른 것은 좁은 화면에서도 선다 (globals.css) */
  pinned?: boolean;
}) {
  if (hints.length === 0) return null;
  // 카드 안 순서를 아이콘 줄 순서에 맞춘다 — 위아래가 좌우와 어긋나면 꼬리가 헷갈린다
  const ordered = [...hints].sort(
    (a, b) => PANEL_ORDER.indexOf(a.panel) - PANEL_ORDER.indexOf(b.panel),
  );
  /** 꼬리가 가리킬 아이콘 — 줄 오른쪽 끝에서 몇 칸 왼쪽인가 (CSS가 폭을 안다) */
  const tail = PANEL_ORDER.length - 1 - PANEL_ORDER.indexOf(ordered[0]!.panel);
  return (
    <div
      className={`rail-hints${pinned ? " pinned" : ""}`}
      role="status"
      style={{ "--tail-slot": tail } as React.CSSProperties}
    >
      {ordered.map((hint) => {
        const Icon = PANEL_ICON[hint.panel];
        return (
          <div className="rail-hint" data-testid={`hint-${hint.panel}`} key={hint.panel}>
            <span className="rail-hint-head">
              <Icon />
              {hint.panel}
            </span>
            <span className="rail-hint-body">
              {hint.lines.map((line, i) => (
                <HintRow line={line} key={i} />
              ))}
              {hint.more > 0 && <i>외 {hint.more}건</i>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
