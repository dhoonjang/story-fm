/**
 * 개인 지시를 판정으로 옮기는 자리 — 배치에 걸린 지시 → 시뮬 입력 → **지금 걸렸는가.**
 *
 * 판정 자체는 시뮬의 `foldDirectives` 하나가 하고(match.md §2), 여기가 하는 일은 그
 * 판정에 넣을 목록을 세우고 답을 감독이 읽을 꼴로 되돌리는 것뿐이다. 화면·경기 중
 * 스냅샷·지시 명령의 결과가 **같은 함수**를 읽어야 하므로 명령 층도 부를 수 있는
 * 자리에 둔다 — `match-flow`에 두면 `commands/`가 그것을 부를 수 없다.
 */
import type { DirectiveIntensity, PlayerDirective, PlayerDirectiveKind } from "@story-fm/domain";
import type { TacticAssignment } from "@story-fm/domain";
import {
  DIRECTIVE_TUNING,
  foldDirectives,
  type DirectiveDropCode,
  type DirectiveInput,
} from "@story-fm/sim";
import { assignmentsOf, type GameState } from "../core/state";

/** 배치에 걸린 개인 지시 하나 → 시뮬 입력. 차례(`order`)까지 같이 건넨다 */
function directiveInputOf(a: TacticAssignment, directive: PlayerDirective): DirectiveInput {
  return {
    by: a.playerId,
    kind: directive.kind,
    ...(directive.targetId ? { targetId: directive.targetId } : {}),
    // 세기를 여기서 빠뜨리면 감독이 고른 정도가 저장만 되고 결과에 닿지 않는다
    ...(directive.intensity ? { intensity: directive.intensity } : {}),
    // 차례를 빠뜨리면 밀어내기가 배치 순서로 되돌아간다 (match.md §2)
    ...(directive.order !== undefined ? { order: directive.order } : {}),
  };
}

/** 그라운드에 선 선수의 개인 지시 — 교체로 나간 선수의 지시는 따라 나간다 */
export function directivesOnPitch(
  state: GameState,
  teamId: string,
  onPitch: readonly string[],
): DirectiveInput[] {
  return assignmentsOf(state, teamId).flatMap((a) =>
    a.directive && onPitch.includes(a.playerId) ? [directiveInputOf(a, a.directive)] : [],
  );
}

/**
 * 닿지 못한 까닭 — **화면과 스냅샷이 같은 낱말을 쓴다.**
 *
 * 사실만 적는다. 화면에 "다시 내려 보세요"를 세우면 그것은 조작 안내가 되고,
 * 무엇을 할지는 감독이 사실을 읽고 정할 일이다 — 다시 내릴 길이 있다는 것은 지시의
 * 결과 메시지와 노트(`DROPPED_KO`)가 말한다.
 */
export const DIRECTIVE_DROP_KO: Record<DirectiveDropCode, string> = {
  "off-pitch": "벤치라 닿지 않는다",
  "gone-target": "표적이 그라운드를 떠났다",
  overflow: "나중 지시에 밀려났다",
};

/**
 * 세 자리의 지금 — **쓴 자리와 한도까지 코어가 센다.** 읽는 쪽이 셋(화면·스냅샷·
 * 지시 결과)이라 각자 세면 한 곳만 고쳐졌을 때 같은 판이 두 수로 읽힌다.
 */
export interface DirectiveSlots {
  /** 지금 판에 닿고 있는 지시 수 */
  used: number;
  /** 한 경기에 걸리는 지시 수 (`MAX_EFFECTIVE`) */
  limit: number;
  /** 감독이 내린 순서 그대로 — 걸린 것도 닿지 않은 것도 */
  rows: DirectiveStanding[];
}

/** 지시 하나의 지금 — 걸렸는가, 아니라면 왜 (`DirectiveDropCode`) */
export interface DirectiveStanding {
  playerId: string;
  kind: PlayerDirectiveKind;
  targetId?: string;
  intensity?: DirectiveIntensity;
  /** 이 지시가 지금 판에 닿고 있는가 */
  taken: boolean;
  /** 닿지 않는다면 그 까닭 — 걸린 지시엔 없다 */
  code?: DirectiveDropCode;
}

/**
 * **지금 우리 지시가 어떻게 서 있는가** — 감독에게 되돌려 줄 유일한 판정
 * (match.md §2).
 *
 * 화면(`views.ts`)·경기 중 스냅샷(`<standing>`)·지시 명령의 결과가 이 함수 하나를
 * 읽는다. 각자 세면 화면이 걸렸다고 적은 지시가 판에서는 밀려나 있고, 감독은 둘 중
 * 어느 쪽을 믿어야 할지 알 수 없다.
 *
 * **벤치까지 넣어 센다.** 벤치의 지시는 자리를 먹지 않으므로 그라운드 위 판정은
 * 패킷이 내는 것과 같고(`directivesOnPitch`), 대신 "벤치라 지금은 닿지 않는다"가
 * 같은 목록에 선다 — 감독이 내린 지시가 목록에서 통째로 사라지지 않는다.
 *
 * **평시에도 답한다.** 경기가 없으면 그라운드 대신 선발이 자리를 다투고, 표적은
 * 상대가 정해지지 않았으므로 따지지 않는다. 밀어내기는 경기 전에 세우는 지시에도
 * 그대로 걸리므로, 여기서 답하지 않으면 킥오프 전 넷째 지시만 판정이 달라진다.
 */
export function directiveStandingOf(state: GameState, teamId: string): DirectiveSlots {
  const pending = state.pendingMatch;
  const match = pending ? state.matches.find((m) => m.id === pending.matchId) : undefined;
  const side =
    pending && match?.homeTeamId === teamId
      ? pending.ledger.home
      : pending && match?.awayTeamId === teamId
        ? pending.ledger.away
        : null;
  const rival =
    !pending || !side
      ? null
      : side === pending.ledger.home
        ? pending.ledger.away
        : pending.ledger.home;
  const assignments = assignmentsOf(state, teamId);
  const starting = new Set(assignments.filter((a) => a.role === "starting").map((a) => a.playerId));
  const inputs = assignments.flatMap((a) =>
    a.directive ? [directiveInputOf(a, a.directive)] : [],
  );
  const rows: DirectiveStanding[] = foldDirectives(
    inputs,
    (id) => (side ? side.onPitch.includes(id) : starting.has(id)),
    (id) => (rival ? rival.onPitch.includes(id) : true),
  ).map((entry) => ({
    playerId: entry.d.by,
    kind: entry.d.kind,
    ...(entry.d.targetId ? { targetId: entry.d.targetId } : {}),
    ...(entry.d.intensity ? { intensity: entry.d.intensity } : {}),
    ...(entry.taken ? { taken: true } : { taken: false, code: entry.code }),
  }));
  return { used: rows.filter((d) => d.taken).length, limit: DIRECTIVE_TUNING.MAX_EFFECTIVE, rows };
}

/**
 * **감독이 다음에 내릴 지시의 차례** — 지금 걸린 것 중 가장 큰 수의 다음.
 *
 * 차례가 커야 자리를 다툴 때 이긴다(match.md §2 밀어내기). 같은 선수에게 다시
 * 내리는 것도 새 차례를 받는다 — 덮어쓰는 것이지 자리를 새로 먹는 것이 아니라,
 * 밀려나 있던 지시를 **다시 내려 도로 가져오는** 길이 이것이다.
 */
export function nextDirectiveOrder(assignments: readonly TacticAssignment[]): number {
  return assignments.reduce((max, a) => Math.max(max, a.directive?.order ?? 0), 0) + 1;
}
