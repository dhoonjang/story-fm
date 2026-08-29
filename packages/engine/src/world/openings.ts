import type { Opening, OpeningKind } from "@story-fm/domain";
import { OPENING_KIND_KO, OPENING_LINE_MAX, OPENING_TITLE_MAX } from "@story-fm/domain";
import { addDays } from "../competition/calendar";
import { playerById, playersOf, type GameState } from "../core/state";

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

/** 기한이 지난 실마리를 닫는다 — 첫 몇 주가 지나면 이야기는 장부의 아크가 잇는다 */
export function tickOpenings(state: GameState, digest: string[]): void {
  for (const opening of activeOpenings(state)) {
    if (state.date <= opening.dueOn) continue;
    opening.resolvedOn = state.date;
    digest.push(`${opening.title} — 첫 몇 주가 지났다`);
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
