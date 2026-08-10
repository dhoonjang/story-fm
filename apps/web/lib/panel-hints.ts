import type { ChatTurn, ToolCallRecord } from "@story-fm/engine";

/**
 * **어느 장부가 바뀌었나** — 오른쪽 아이콘 줄에 붙는 말풍선.
 *
 * 라인업을 바꿨다는 사실을 채팅 카드로 그리면 무대의 주인이 서사에서 대시보드로
 * 넘어간다. 그렇다고 아무 표시도 없으면 감독은 "지시가 먹혔나"를 확인하러 탭을
 * 열어 봐야 한다. 그 사이의 답이 **네비게이션에 붙는 알림**이다 — 채팅은 그대로
 * 두고, 달라진 화면 쪽에 점 하나와 한 줄을 세운다.
 *
 * 힌트는 **그 화면을 열면 사라진다.** 읽었으면 할 일이 끝난 알림이라 쌓아 둘 이유가
 * 없고, 시간으로 지우면 잠깐 눈을 뗀 사이에 놓친다.
 */

/** 아이콘 줄의 키 — `PANELS`와 같은 값이어야 한다 */
export type PanelKey = "스쿼드" | "달력" | "재정" | "대회" | "커리어";

/**
 * 스킬이 바꾼 장부 — 한 스킬이 둘을 건드리기도 한다.
 * (계약 확정은 선수도 옮기고 돈도 쓴다)
 */
export const PANEL_OF: Record<string, PanelKey[]> = {
  // ── 스쿼드 — 선수단과 판이 바뀐 것 ──
  set_lineup: ["스쿼드"],
  set_tactics: ["스쿼드"],
  set_player_tactic: ["스쿼드"],
  set_captain: ["스쿼드"],
  substitute: ["스쿼드"],
  set_transfer_list: ["스쿼드"],
  release_player: ["스쿼드", "재정"],
  recall_loan: ["스쿼드"],
  accept_deal: ["스쿼드", "재정"],
  apply_narrative_event: ["스쿼드"],
  rate_players: ["스쿼드"],
  // ── 달력 — 일정과 경기 ──
  set_training: ["달력"],
  clear_training: ["달력"],
  start_match: ["달력"],
  finalize_match: ["달력", "대회"],
  // ── 재정 ──
  apply_finance_event: ["재정"],
  adjust_transfer_budget: ["재정"],
};

export interface PanelHint {
  panel: PanelKey;
  /** 그 화면에서 바뀐 것들 — 최근 순, 최대 `HINT_LINES`줄 */
  lines: string[];
  /** 줄로 세우지 못하고 접은 나머지 */
  more: number;
}

/** 말풍선 한 장에 세울 줄 수 — 넘치면 접는다 */
const HINT_LINES = 3;

/**
 * **채팅 칩에서 빠지는가** — 볼 화면이 있는 것은 레일이 알린다.
 *
 * 장부 변경을 채팅에도 칩으로 세우면 같은 사실이 두 곳에 나고, 무대의 주인이
 * 서사에서 조작 로그로 넘어간다. 채팅에 남는 것은 **볼 화면이 없는 것**뿐이다 —
 * 대화(면담·팀토크·기자회견), 진행 중인 협상, 스카우트 파견.
 */
export function movedToRail(name: string): boolean {
  return PANEL_OF[name] !== undefined;
}

/** 힌트로 세울 값이 없는 기록 — 코어 처리는 알림이 아니다 */
function countable(call: ToolCallRecord): boolean {
  return !call.silent && PANEL_OF[call.name] !== undefined;
}

/**
 * 마지막 GM 턴이 바꾼 장부들 — 패널당 한 줄.
 *
 * 마지막 턴만 보는 이유: 알림은 **방금 벌어진 일**이다. 이전 턴까지 모으면
 * 감독이 이미 확인한 변경이 계속 서 있고, 그러면 점이 상시 켜져 신호가 죽는다.
 */
export function panelHintsOf(chat: readonly ChatTurn[]): PanelHint[] {
  const last = [...chat].reverse().find((t) => t.role === "model");
  if (!last) return [];

  const byPanel = new Map<PanelKey, string[]>();
  for (const call of last.toolCalls) {
    if (!countable(call)) continue;
    // 요약 첫 줄만 — 여러 줄짜리는 말풍선에 담기지 않는다
    const text = (call.summary.split("\n")[0] ?? call.summary).trim();
    if (text.length === 0) continue;
    for (const panel of PANEL_OF[call.name] ?? []) {
      const lines = byPanel.get(panel) ?? [];
      // 같은 문장이 두 번 오면(같은 스킬 반복) 한 번만 센다
      if (!lines.includes(text)) lines.push(text);
      byPanel.set(panel, lines);
    }
  }
  return [...byPanel].map(([panel, all]) => ({
    panel,
    lines: all.slice(0, HINT_LINES),
    more: Math.max(0, all.length - HINT_LINES),
  }));
}
