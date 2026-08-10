import type { ChatTurn, ToolCallRecord } from "@story-fm/engine";

/**
 * **어느 장부가 바뀌었나** — 오른쪽 아이콘 줄에 붙는 말풍선.
 *
 * 아무 표시도 없으면 감독은 "지시가 먹혔나"를 확인하러 탭을 열어 봐야 한다. 그
 * 답이 **네비게이션에 붙는 알림**이다 — 달라진 화면 쪽에 점 하나와 한 줄을 세운다.
 *
 * 말풍선은 **다음 클릭에 닫힌다.** 읽었으면 할 일이 끝난 알림이라 쌓아 둘 이유가
 * 없고, 시간으로 지우면 잠깐 눈을 뗀 사이에 놓친다. 대신 그 지시는 채팅에 칩으로
 * 남아 있어서(`hasRailHint`) **눌러 다시 불러낼 수 있다** — 알림을 놓쳐도 무엇이
 * 바뀌었는지는 그 자리에 그대로 있다.
 */

/** 아이콘 줄의 키 — `PANELS`와 같은 값이어야 한다 */
export type PanelKey = "스쿼드" | "달력" | "재정" | "대회" | "커리어";

/**
 * 스킬이 바꾼 장부 — **스킬 하나에 화면 하나.**
 *
 * 여러 장부를 건드리는 스킬도 있지만(계약 확정은 선수도 옮기고 돈도 쓴다) 알림은
 * **감독이 확인하러 갈 화면**을 가리키는 것이지 바뀐 곳을 다 세는 장부가 아니다.
 * 둘에 걸치면 같은 문장이 두 칸에 서서, 한 번 벌어진 일이 두 번 일어난 것처럼 읽힌다.
 * 걸치는 스킬은 **감독이 먼저 볼 쪽**으로 보낸다 — 영입은 누가 왔는지가 먼저다.
 */
export const PANEL_OF: Record<string, PanelKey> = {
  // ── 스쿼드 — 선수단과 판이 바뀐 것 ──
  set_lineup: "스쿼드",
  set_tactics: "스쿼드",
  set_player_tactic: "스쿼드",
  set_captain: "스쿼드",
  substitute: "스쿼드",
  set_transfer_list: "스쿼드",
  release_player: "스쿼드",
  recall_loan: "스쿼드",
  accept_deal: "스쿼드",
  apply_narrative_event: "스쿼드",
  rate_players: "스쿼드",
  // 대화형 — 바뀌는 것은 사기·심경이고 그건 명단이 보여준다
  team_talk: "스쿼드",
  talk_to_player: "스쿼드",
  // ── 달력 — 일정과 훈련 ──
  set_training: "달력",
  clear_training: "달력",
  start_match: "달력",
  // ── 대회 — 끝난 경기가 순위와 기록으로 가는 곳 ──
  finalize_match: "대회",
  // ── 재정 ──
  apply_finance_event: "재정",
  adjust_transfer_budget: "재정",
  // ── 커리어 — 세계가 감독을 보는 눈 ──
  respond_to_media: "커리어",
};

/**
 * **카드로 서는 스킬** — 갈 장부가 없어서 채팅에 카드를 남긴다 (`MarketCard`).
 *
 * 진행 중인 흥정은 어느 장부에도 실리지 않고, 파견한 스카우트는 아직 아무것도
 * 바꾸지 않았다. 대신 금액·확률·기한이 다음 판단의 입력이라 카드로 정리해 세운다.
 *
 * 이 목록에도 `PANEL_OF`에도 없는 조작형 스킬은 **화면에 서는 길이 없다** —
 * 그런 스킬이 생기면 `skill-surface.test.ts`가 실패해 결정을 요구한다.
 */
export const CARD_SKILLS: ReadonlySet<string> = new Set([
  "send_offer",
  "respond_offer",
  "open_renewal",
  "withdraw_offer",
  "scout_player",
]);

/**
 * 말풍선 한 줄 — **무엇이 했고, 무엇이 바뀌었고, 그래서 어떻다.**
 *
 * 문장을 통째로 세우면 세 줄이 글자 벽이 된다. 갈래(`skill`)는 화면이 아이콘으로
 * 세우고, 끝에 괄호로 달린 사족(`note`)은 한 톤 낮춰 아래로 내린다.
 */
export interface HintLine {
  /** 어느 스킬이 남긴 줄인가 — 화면이 이걸로 아이콘을 고른다 */
  skill: string;
  /** 무슨 일이 있었나 */
  text: string;
  /** 문장 끝 괄호에 달린 부연 — 없으면 undefined */
  note?: string;
}

export interface PanelHint {
  panel: PanelKey;
  /** 그 화면에서 바뀐 것들 — 최근 순, 최대 `HINT_LINES`줄 */
  lines: HintLine[];
  /** 줄로 세우지 못하고 접은 나머지 */
  more: number;
}

/** 문장 끝에 괄호로 달린 사족 — "…적응도 60 (+20, 익혀 둔 전술)" */
const TRAILING_NOTE = /\s*\(([^()]+)\)\s*$/;

/** 말풍선 한 장에 세울 줄 수 — 넘치면 접는다 */
const HINT_LINES = 3;

/**
 * **레일 말풍선을 갖는 스킬인가** — 채팅 칩을 눌러 그 말풍선을 다시 부를 수 있다.
 *
 * 스킬 결과가 화면에 서는 길은 둘뿐이다: 갈 장부가 있으면 **칩 + 그 탭의 말풍선**,
 * 없으면 **채팅 카드**(협상·스카우트 — `MarketCard`). 어느 쪽도 아닌 것은 아예
 * 노출하지 않는다(조회 도구는 기록조차 남기지 않고, 코어가 한 일은 `silent`).
 */
export function hasRailHint(name: string): boolean {
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
  return hintsOfCalls(last.toolCalls);
}

/**
 * 스킬 하나가 세우는 말풍선 — **채팅 칩을 눌러 다시 불러낼 때** 쓴다.
 *
 * 자동 알림은 턴 전체를 모으지만 칩은 그 호출 하나를 가리킨다 — 감독이 누른 것만
 * 세워야 어느 지시의 결과인지가 분명하다.
 */
export function hintsOfCall(call: ToolCallRecord): PanelHint[] {
  return hintsOfCalls([call]);
}

function hintsOfCalls(calls: readonly ToolCallRecord[]): PanelHint[] {
  const byPanel = new Map<PanelKey, HintLine[]>();
  for (const call of calls) {
    if (!countable(call)) continue;
    // 요약 첫 줄만 — 여러 줄짜리는 말풍선에 담기지 않는다
    const summary = (call.summary.split("\n")[0] ?? call.summary).trim();
    if (summary.length === 0) continue;
    const note = TRAILING_NOTE.exec(summary)?.[1];
    const line: HintLine = {
      skill: call.name,
      text: summary.replace(TRAILING_NOTE, ""),
      ...(note === undefined ? {} : { note }),
    };
    const panel = PANEL_OF[call.name];
    if (panel === undefined) continue;
    const lines = byPanel.get(panel) ?? [];
    // 같은 문장이 두 번 오면(같은 스킬 반복) 한 번만 센다
    if (!lines.some((l) => l.skill === line.skill && l.text === line.text)) lines.push(line);
    byPanel.set(panel, lines);
  }
  return [...byPanel].map(([panel, all]) => ({
    panel,
    lines: all.slice(0, HINT_LINES),
    more: Math.max(0, all.length - HINT_LINES),
  }));
}
