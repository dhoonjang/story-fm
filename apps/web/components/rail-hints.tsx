"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatTurn, ToolCallRecord } from "@story-fm/engine";
import { hintsOfCall, panelHintsOf } from "@/lib/panel-hints";
import type { HintLine, PanelHint, PanelKey } from "@/lib/panel-hints";
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
  type IconComponent,
} from "@/components/icons";

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
  // 1·2군 이동은 판이 아니라 사람이 오가는 일이다 — 라인업과 같은 그림을 쓰면 갈래가 겹친다
  set_squad_level: IconPerson,
  substitute: IconPerson,
  set_transfer_list: IconPerson,
  release_player: IconPerson,
  // 해지 제안도 사람이 오가는 일이다 — 일방 해지(release_player)와 같은 그림으로 한 갈래로 읽힌다
  open_release: IconPerson,
  recall_loan: IconPerson,
  // 계약 확정은 재정 장부에도 서므로 사람 쪽으로 — 그 칸의 머리 아이콘이 이미 돈이다
  accept_deal: IconPerson,
  apply_narrative_event: IconInsight,
  set_training: IconDay,
  start_match: IconMatch,
  finalize_match: IconTrophy,
  apply_finance_event: IconFinance,
  adjust_transfer_budget: IconFinance,
};

/**
 * 오르내림의 색 — **부호는 코어가 숫자로 낸다** (`SkillBriefItem.delta`).
 *
 * 값 문자열에서 `+`·`−`를 찾아 칠하던 자리다. 포메이션(`4-2-3-1`)이 같은 자를
 * 지나고, 코어가 문구를 바꾸는 날 색이 조용히 꺼졌다. `0`은 "안 움직였다"는
 * 사실이라 이득도 손해도 아니다 — 색이 붙지 않는다.
 */
function Delta({ delta, text }: { delta: number | undefined; text: string }) {
  if (delta === undefined || delta === 0) return <>{text}</>;
  return <b className={delta > 0 ? "up" : "down"}>{text}</b>;
}

/**
 * 한 줄 — **이름은 흐리게, 값은 또렷하게, 갈래는 뒤에 한 톤 낮춰.**
 *
 * 셋을 같은 톤으로 이어 붙이면 `훈련 지정 — 매주 5회 × 6주 — 패스·시야`처럼 줄표만
 * 두 번 나오고 무엇이 값인지 안 읽힌다. 코어가 자리를 나눠 주므로(`SkillBriefItem`)
 * 화면은 자리마다 톤만 정하면 된다.
 *
 * **코어가 쓴 문자열은 다시 가르지 않는다** — 역할도 코어가 판과 같은 약칭(`CF`)으로
 * 내고, `note`도 원자 하나이며, ±의 색은 `delta`가 나른다.
 */
function HintRow({ line }: { line: HintLine }) {
  const Icon = SKILL_ICON[line.skill];
  return (
    <span className="rail-hint-line">
      {/* 이어지는 항목은 같은 스킬의 계속이다 — 아이콘을 다시 세우면 건수가 부풀어 보인다 */}
      <span className="rail-hint-mark">{Icon && !line.cont ? <Icon /> : null}</span>
      <span className="rail-hint-what">
        {line.head !== undefined && <b className="rail-hint-lead">{line.head}</b>}
        {line.label !== undefined && <em className="rail-hint-label">{line.label}</em>}
        <span className="rail-hint-value">
          <Delta delta={line.delta} text={line.text} />
        </span>
        {line.note !== undefined && <em className="rail-hint-aside">{line.note}</em>}
      </span>
    </span>
  );
}

/**
 * ── 알림의 일생 — **선다 · 읽힌다 · 닫힌다 · 다시 불린다** ──────────────────
 *
 * 무대(`game-screen.tsx`)는 이 상태를 셋으로 나눠 들고 있었다(읽은 장부 · 닫았나 ·
 * 되부른 말풍선). 넷 다 같은 질문 하나에 답하는 값이라 한 자리에 모은다 —
 * 그리는 것은 아래 `RailHints`고, 여기는 **무엇을 그릴지**를 정한다.
 */
export function useRailHints({
  chat,
  panel,
}: {
  chat?: readonly ChatTurn[];
  panel: string | null;
}) {
  /** 읽은 장부 알림 — 그 화면을 연 순간부터 다시 세우지 않는다 (다음 턴에 풀린다) */
  const [seen, setSeen] = useState<string[]>([]);
  /**
   * 알림을 닫았나 — **다음 클릭 한 번**이면 닫힌다.
   *
   * 알림은 지나가는 것이지 화면에 상주하는 것이 아니다. 놓쳐도 그 지시는 채팅에
   * 칩으로 남아 있어서 눌러 다시 부를 수 있다(`pinned`).
   */
  const [closed, setClosed] = useState(false);
  /** 채팅 칩이 다시 불러낸 말풍선 — 자동 알림과 같은 자리에 선다 */
  const [pinned, setPinned] = useState<{ call: ToolCallRecord; hints: PanelHint[] } | null>(null);

  /**
   * 마지막 턴이 바꾼 장부 — 아이콘 줄에 말풍선으로 선다.
   * 이미 연 화면은 빼고(`seen`), 지금 보고 있는 화면도 뺀다.
   */
  const hints = useMemo(
    () =>
      chat ? panelHintsOf(chat).filter((h) => h.panel !== panel && !seen.includes(h.panel)) : [],
    [chat, panel, seen],
  );
  /**
   * **GM이 말한 횟수** — 알림이 새로 서는 기준이다.
   *
   * 채팅 길이로 재면 안 된다: 감독이 보내는 순간 낙관적 유저 턴이 먼저 들어가고
   * (`send`), 턴이 실패하면 도로 빠진다. 그때마다 리셋이 돌면 **닫아 둔 직전
   * 알림이 되살아났다가** 답이 오면 다시 바뀐다 — 그게 말풍선이 깜빡이는 이유다.
   * 알림은 세계가 무언가 한 뒤에만 새로 선다.
   */
  const modelTurns = useMemo(
    () => chat?.reduce((n, t) => n + (t.role === "model" ? 1 : 0), 0) ?? 0,
    [chat],
  );
  /**
   * 새 턴이 오면 알림은 처음부터 — 방금 벌어진 일은 다시 알려야 한다.
   * 이전 턴에 읽은 표식(`seen`)도 여기서 풀린다: 그건 그 알림을 읽었다는
   * 뜻이었고, 새 지시는 새 알림이다.
   *
   * 이걸 `useEffect`로 미루면 리셋 전 한 프레임이 그려진다 — 지난 턴에 읽은
   * 알림이 잠깐 사라졌다 다시 뜬다. 렌더 중에 맞추면 그 프레임이 없다.
   */
  const [hintTurn, setHintTurn] = useState(0);
  if (hintTurn !== modelTurns) {
    setHintTurn(modelTurns);
    setClosed(false);
    setPinned(null);
    setSeen([]);
  }
  /**
   * **다른 쪽을 누르면 닫힌다.** 말풍선은 조작 대상이 아니라 지나가는 알림이라
   * 닫는 ✕를 달지 않는다 — 감독이 다음 무엇을 누르든 그게 곧 "읽었다"다.
   * 칩(`data-hint-keep`)만 예외다: 그 클릭은 말풍선을 부르는 손잡이다.
   */
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest("[data-hint-keep]")) return;
      setPinned((p) => (p === null ? p : null));
      setClosed((c) => (c ? c : true));
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);

  /** 칩을 눌렀다 — 같은 칩을 다시 누르면 닫는다 (칩이 곧 손잡이다) */
  const reveal = useCallback((call: ToolCallRecord) => {
    setClosed(true);
    setPinned((prev) => (prev?.call === call ? null : { call, hints: hintsOfCall(call) }));
  }, []);
  /** 그 장부를 열었다 — 이번 턴 동안은 그 알림을 다시 세우지 않는다 */
  const markSeen = useCallback((key: string) => {
    setSeen((cur) => (cur.includes(key) ? cur : [...cur, key]));
  }, []);

  return {
    /** 이번 턴에 바뀐 장부 — 아이콘 위의 점이 이걸 읽는다 (닫아도 남는다) */
    hints,
    /** 지금 말풍선으로 세울 것 — 되부른 게 있으면 그것만, 닫았으면 없다 */
    shown: pinned ? pinned.hints : closed ? [] : hints,
    /** 되부른 말풍선인가 — 좁은 화면에서도 선다 */
    pinned: pinned !== null,
    /** 지금 펼쳐 둔 칩 — 그 칩이 눌린 채로 남는다 */
    revealedCall: pinned?.call ?? null,
    reveal,
    markSeen,
  };
}

/**
 * **바뀐 장부를 알리는 말풍선** — 아이콘 줄 아래 한 장.
 *
 * ⚠️ 아이콘마다 따로 띄우지 않는다. 한 스킬이 두 장부를 건드리는 일이 흔해서
 * (계약 확정 = 선수 + 돈) 아이콘별로 세우면 말풍선끼리 겹친다. 대신 꼬리가
 * **첫 장부의 아이콘**을 가리켜 어디서 나온 말인지 잇는다.
 */
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
