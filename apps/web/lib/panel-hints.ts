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
  set_squad_level: "스쿼드",
  set_tactics: "스쿼드",
  set_player_tactic: "스쿼드",
  set_captain: "스쿼드",
  set_development_focus: "스쿼드",
  substitute: "스쿼드",
  set_transfer_list: "스쿼드",
  release_player: "스쿼드",
  recall_loan: "스쿼드",
  accept_deal: "스쿼드",
  apply_narrative_event: "스쿼드",
  // 대화형 — 바뀌는 것은 사기·심경이고 그건 명단이 보여준다
  team_talk: "스쿼드",
  talk_to_player: "스쿼드",
  // ── 달력 — 일정과 훈련 ──
  set_training: "달력",
  start_match: "달력",
  // ── 대회 — 끝난 경기가 순위와 기록으로 가는 곳 ──
  finalize_match: "대회",
  // ── 재정 ──
  apply_finance_event: "재정",
  adjust_transfer_budget: "재정",
  // ── 커리어 — 세계가 감독을 보는 눈 ──
  respond_to_media: "커리어",
  // 다가옴도 옮기는 것이 평판 3축이다 — 사기 변화는 스쿼드에도 서지만 자리는 하나다
  respond_to_approach: "커리어",
  // 부임은 커리어의 사건이다 — 경질 카드가 지워지고 남은 제안이 사라지는 곳이 거기다
  accept_manager_offer: "커리어",
  // 흥정·지원도 같은 자리다 — 제안 카드의 조건과 공석 명부가 커리어 화면에 선다
  counter_manager_offer: "커리어",
  apply_manager_job: "커리어",
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
  "open_release",
  "withdraw_offer",
  "scout_player",
]);

/**
 * 말풍선 한 줄 — **세 자리로 읽힌다.**
 *
 * `label`(무엇에 대한 것) · `text`(바뀐 값) · `note`(그 값의 갈래). 셋을 한 문자열로
 * 붙여 세우면 값도 갈래도 같은 굵기로 눌려 정작 무엇이 달라졌는지가 안 읽힌다 —
 * 그래서 코어가 나눠 내고(`SkillBriefItem`) 화면은 자리마다 톤을 달리 준다.
 *
 * 갈래(`skill`)는 아이콘이 세우고, 여러 항목 중 **첫 줄에만** 머리줄(`head`)이 붙는다.
 */
export interface HintLine {
  /** 어느 스킬이 남긴 줄인가 — 화면이 이걸로 아이콘을 고른다 */
  skill: string;
  /** 무엇을 한 스킬인가 — 항목 여럿의 **첫 줄에만** 붙는 머리줄 */
  head?: string;
  /** 무엇에 대한 것인가 — 값 앞에 한 톤 낮춰 선다 (`선발 투입`) */
  label?: string;
  /** 바뀐 값 — 줄에서 가장 또렷한 자리 */
  text: string;
  /** 그 값의 갈래·부연 — 값 뒤에 한 톤 낮춰 선다 (`패스·시야`) */
  note?: string;
  /** 같은 스킬의 이어지는 항목 — 아이콘을 다시 세우지 않는다 */
  cont?: boolean;
}

export interface PanelHint {
  panel: PanelKey;
  /** 그 화면에서 바뀐 것들 — 최근 순, 최대 `HINT_LINES`줄 */
  lines: HintLine[];
  /** 줄로 세우지 못하고 접은 나머지 */
  more: number;
}

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

/**
 * 기록 하나가 세우는 줄들 — **코어가 항목으로 냈으면 항목마다 한 줄.**
 *
 * `brief`가 없는 것은 옛 세이브의 기록이다. 그때는 요약 문자열의 첫 줄을 통째로
 * 세운다 — 코어가 쓴 문장을 화면이 정규식으로 되쪼개 갈래를 만들지 않는다.
 */
function linesOfCall(call: ToolCallRecord): HintLine[] {
  const brief = call.brief;
  if (brief) {
    const head = brief.head.trim();
    const items = brief.items.filter((i) => i.text.trim().length > 0);
    // 바뀐 것을 코어가 못 적었으면 머리줄이 곧 그 줄이다 — 빈 줄을 세우지 않는다
    if (items.length === 0) return head.length === 0 ? [] : [{ skill: call.name, text: head }];
    return items.map((it, i) => ({
      skill: call.name,
      // 머리줄은 첫 항목에만 — 항목마다 되풀이하면 그게 글자 벽이다
      ...(i === 0 && head.length > 0 ? { head } : {}),
      ...(it.label ? { label: it.label } : {}),
      text: it.text.trim(),
      ...(it.note ? { note: it.note } : {}),
      ...(i === 0 ? {} : { cont: true }),
    }));
  }
  // 요약 첫 줄만 — 여러 줄짜리는 말풍선에 담기지 않는다
  const summary = (call.summary.split("\n")[0] ?? call.summary).trim();
  if (summary.length === 0) return [];
  return [{ skill: call.name, text: summary }];
}

/** 기록 하나의 지문 — 스킬 이름과 세운 줄들. 같은 지문은 두 번 세지 않는다 */
function signatureOf(name: string, lines: readonly HintLine[]): string {
  return [name, ...lines.map((l) => `${l.label ?? ""}${l.text}`)].join(" ");
}

function hintsOfCalls(calls: readonly ToolCallRecord[]): PanelHint[] {
  const byPanel = new Map<PanelKey, HintLine[]>();
  const signatures = new Set<string>();
  for (const call of calls) {
    if (!countable(call)) continue;
    const panel = PANEL_OF[call.name];
    if (panel === undefined) continue;
    const lines = byPanel.get(panel) ?? [];
    /**
     * 같은 결과가 두 번 오면(같은 스킬 반복) 한 번만 센다 — **기록 단위로** 거른다.
     * 줄 단위로 거르면 머리줄만 중복으로 걸리고 이어지는 `cont` 줄은 남아, 머리도
     * 아이콘도 없는 줄이 홀로 선다.
     */
    const next = linesOfCall(call);
    if (next.length === 0) continue;
    const seen = signatureOf(call.name, next);
    if (!signatures.has(seen)) {
      signatures.add(seen);
      lines.push(...next);
    }
    byPanel.set(panel, lines);
  }
  return [...byPanel].map(([panel, all]) => ({
    panel,
    lines: all.slice(0, HINT_LINES),
    more: Math.max(0, all.length - HINT_LINES),
  }));
}
