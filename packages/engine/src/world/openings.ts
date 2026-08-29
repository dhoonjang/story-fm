import type { Opening, OpeningClose, OpeningKind } from "@story-fm/domain";
import { OPENING_KIND_KO, OPENING_LINE_MAX, OPENING_TITLE_MAX } from "@story-fm/domain";
import { addDays } from "../competition/calendar";
import { playerById, playersOf, pushNarrative, type GameState } from "../core/state";

/**
 * **시작 사건** — 부임 첫 몇 주의 진행을 이끄는 실마리 (career.md §1 · agents.md §4-2).
 *
 * 온보딩 판정이 배경과 구단의 사실에서 제안하고, 여기서 검증해 앉힌다. 코어가 여는
 * 이야기(아크)와 달리 장부의 사실에서 나오지 않으므로 검증이 곧 한도다 — 갈래는 목록
 * 안에서, 걸린 사람은 실재하는 사람만, 수는 셋까지, 기한은 코어가 박는다.
 */

/** 한 게임이 갖는 시작 사건의 상한 — 셋이면 첫 주가 붐비고 넷이면 흩어진다 */
export const MAX_OPENINGS = 3;
/** 시작 사건이 살아 있는 날수 — 프리시즌과 개막 몇 경기 */
export const OPENING_DAYS = 45;

export interface OpeningDraft {
  kind: OpeningKind;
  title: string;
  line: string;
  subjectId?: string;
}

/** 걸린 사람이 실재하는가 — 우리 선수이거나 이 세이브의 인물 */
function subjectExists(state: GameState, id: string): boolean {
  const player = playerById(state, id);
  if (player && player.teamId === state.userTeamId) return true;
  return (state.personas ?? []).some((p) => p.characterId === id);
}

/**
 * 제안을 검증해 앉힌다 — 돌려주는 것은 **앉은 수**다. 실패는 조용히 떨어진다: 시작
 * 사건은 없어도 게임이 서는 것이고, 반려 사유를 되돌려 줄 상대가 없다.
 */
export function seedOpenings(state: GameState, drafts: readonly OpeningDraft[]): number {
  const seen = new Set<string>();
  const openings: Opening[] = [];
  for (const draft of drafts) {
    if (openings.length >= MAX_OPENINGS) break;
    const title = draft.title.trim().slice(0, OPENING_TITLE_MAX);
    const line = draft.line.trim().slice(0, OPENING_LINE_MAX);
    if (title.length === 0 || line.length === 0) continue;
    if (draft.subjectId !== undefined && !subjectExists(state, draft.subjectId)) continue;
    // 같은 갈래·같은 사람은 하나다 — 실마리가 둘이면 GM이 하나를 두 번 연다
    const key = `${draft.kind}:${draft.subjectId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    openings.push({
      id: `opening-${openings.length + 1}`,
      kind: draft.kind,
      title,
      line,
      ...(draft.subjectId === undefined ? {} : { subjectId: draft.subjectId }),
      openedOn: state.date,
      dueOn: addDays(state.date, OPENING_DAYS),
      resolvedOn: null,
    });
  }
  state.openings = openings;
  return openings.length;
}

/** 아직 열린 시작 사건 */
export function activeOpenings(state: GameState): Opening[] {
  return (state.openings ?? []).filter((o) => o.resolvedOn === null);
}

/** 닫힌 실마리가 서사 기억에 남는 무게 — 면담 한 건과 같은 줄이다 */
const OPENING_CLOSE_SALIENCE = 2;

/**
 * 실마리 하나를 닫는다 — **두 사유가 같은 문을 지난다** (career.md §1). 돌려주는 것은
 * 일지에 남길 줄이고, 그 자리에 열린 실마리가 없으면 null이다.
 */
export function resolveOpening(state: GameState, id: string, reason: OpeningClose): string | null {
  const opening = (state.openings ?? []).find((o) => o.id === id && o.resolvedOn === null);
  if (!opening) return null;
  opening.resolvedOn = state.date;
  opening.resolvedBy = reason;
  return reason === "handled"
    ? `${opening.title} — 감독이 매듭지었다`
    : `${opening.title} — 첫 몇 주가 지났다`;
}

/** 감독이 한 일이 어디에 닿았는가 — 사람과 갈래 (career.md §1의 표) */
export interface OpeningTouch {
  /** 이 일이 닿은 사람 — 우리 선수의 id 또는 인물의 characterId */
  subjectIds?: readonly string[];
  /** **걸린 사람이 없는** 실마리를 닫는 갈래 */
  kinds?: readonly OpeningKind[];
}

/**
 * 감독이 한 일이 실마리에 닿았으면 닫는다 — 돌려주는 것은 **닫힌 수**다 (career.md §1).
 *
 * **걸린 사람이 있으면 사람이 가른다.** 갈래는 걸린 사람이 없는 실마리에만 쓴다 —
 * 라야에게 걸린 라커룸 실마리가 선수단 전체에 한 말로 닫히면 「그 사람과의 일」이 아무
 * 뜻도 갖지 않는다.
 *
 * 닫힌 줄은 서사 기억으로 간다 — 명령에는 다이제스트가 없고, 다음 턴 GM이 그 사실을
 * 읽는 자리는 `<recent>`다. 기한이 닫는 길은 `tickOpenings`가 다이제스트로 나른다.
 */
export function touchOpenings(state: GameState, touch: OpeningTouch): number {
  const subjects = new Set(touch.subjectIds ?? []);
  const kinds = new Set(touch.kinds ?? []);
  let closed = 0;
  for (const opening of activeOpenings(state)) {
    const hit = opening.subjectId ? subjects.has(opening.subjectId) : kinds.has(opening.kind);
    if (!hit) continue;
    const line = resolveOpening(state, opening.id, "handled");
    if (line === null) continue;
    pushNarrative(state, line, OPENING_CLOSE_SALIENCE);
    closed += 1;
  }
  return closed;
}

/** 기한이 지난 실마리를 닫는다 — 첫 몇 주가 지나면 이야기는 장부의 아크가 잇는다 */
export function tickOpenings(state: GameState, digest: string[]): void {
  for (const opening of activeOpenings(state)) {
    if (state.date <= opening.dueOn) continue;
    const line = resolveOpening(state, opening.id, "expired");
    if (line !== null) digest.push(line);
  }
}

/** 걸린 사람의 이름 — 선수든 인물이든 */
function subjectName(state: GameState, id: string): string {
  const player = playersOf(state, state.userTeamId).find((p) => p.id === id);
  if (player) return player.name;
  return (state.personas ?? []).find((p) => p.characterId === id)?.name ?? id;
}

/** 상태 스냅샷 블록 — 열린 것이 없으면 null */
export function describeOpenings(state: GameState): string | null {
  const open = activeOpenings(state);
  if (open.length === 0) return null;
  return open
    .map(
      (o) =>
        `- [${OPENING_KIND_KO[o.kind]}] ${o.title} — ${o.line}` +
        (o.subjectId ? ` (${subjectName(state, o.subjectId)})` : "") +
        ` · ${o.dueOn}까지`,
    )
    .join("\n");
}
