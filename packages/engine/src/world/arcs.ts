import type { ArcKind, ArcStage, Negotiation, NarrativeArc, PlayerIssue } from "@story-fm/domain";
import { ARC_STAGE_KO, ARC_STAGE_RANK, ARC_TITLE_MAX } from "@story-fm/domain";
import { diffDays } from "../core/dates";
import { managedTeamId, openInjury, playerName, playersOf, type GameState } from "../core/state";
import { issueReasonText } from "../squad/mood";
import { recentOutcomes, streakOf } from "../squad/slump";

/**
 * 서사 아크 — **기억을 이야기로 엮는 골격** (people.md §9).
 *
 * 개폐는 전부 장부의 사실에서 결정적으로 판정한다: 부상·불만·연속 기록·협상.
 * 난수도 시각도 모델도 여기 없다 — 같은 상태를 두 번 굴리면 같은 아크가 선다.
 *
 * ⚠️ **아크는 코어 상태를 바꾸지 않는다.** 데이터일 뿐 강제 이벤트가 아니라서,
 * 열려 있다고 폼이 움직이거나 장면이 열리지 않는다. GM이 시즌을 가로지르는
 * 흐름을 읽는 재료로만 선다.
 */

/** 동시에 설 수 있는 이야기 — 넘치면 새 아크는 열리지 않는다 (이미 선 것이 이긴다) */
export const MAX_ACTIVE_ARCS = 4;
/** 닫힌 아크의 보관 수 — 서사 메모리 200개와 같은 규약, 오래된 것부터 밀린다 */
export const ARC_RESOLVED_KEEP = 20;

/** 이야기가 되는 부상의 예상 결장 — 이 아래는 그냥 결장이다 */
const INJURY_MIN_OUT_DAYS = 30;
/** 복귀가 눈에 들어오는 눈금 — 선수 근황이 쓰는 자와 같다 (cues.ts) */
const INJURY_CLIMAX_DAYS = 14;

/** 불만이 이야기가 되는 날수 */
const GRIEVANCE_OPEN_DAYS = 7;
const GRIEVANCE_RISING_DAYS = 14;
const GRIEVANCE_CLIMAX_DAYS = 28;
/** 다가옴이 이 계단에 서면 날수와 무관하게 절정이다 — 그 선수가 이미 두 번 찾아왔다 */
const GRIEVANCE_CLIMAX_STEP = 2;

/** 연속 기록의 눈금 — 침체·상승세의 문턱(slump.ts)과 같은 3에서 시작한다 */
const STREAK_OPEN = 3;
const STREAK_RISING = 4;
const STREAK_CLIMAX = 5;

/** 사가가 되는 협상 라운드 — 한 방에 거절당한 오퍼는 사가가 아니다 */
const SAGA_OPEN_ROUNDS = 2;
const SAGA_RISING_ROUNDS = 3;

/**
 * 자리가 하나뿐일 때 누가 서는가 — **감독이 조치해야 하는 순서다** (people.md §9).
 * 연속 기록은 스스로 풀리지만 불만과 부상은 감독이 손을 대야 움직인다.
 */
const ARC_KIND_ORDER: readonly ArcKind[] = [
  "grievance",
  "injury-comeback",
  "transfer-saga",
  "losing-run",
  "winning-run",
];

/** 아직 닫히지 않은 단계 — 사실은 아크를 열고 올릴 뿐, 닫는 것은 사실의 부재다 */
type ActiveStage = Exclude<ArcStage, "resolved">;

interface ArcCandidate {
  kind: ArcKind;
  subjectId: string;
  stage: ActiveStage;
}

/** 같은 (갈래, 주인)의 활성 아크는 하나다 — 그 하나를 가리키는 열쇠 */
const arcKey = (kind: ArcKind, subjectId: string): string => `${kind}:${subjectId}`;

const asc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ── 오늘의 사실 → 후보 ──────────────────────────────────

/**
 * 진행 중인 협상 — 선수당 하나. 같은 선수 앞으로 여러 건이 열려 있으면 **가장
 * 늦게 열린 것**이 지금의 이야기다(옛 건은 기한이 지워 준다). 같은 날 열렸으면
 * id 사전순 — 무엇이든 하나로 정해져야 판정이 결정적이다.
 */
function liveNegotiations(state: GameState): Map<string, Negotiation> {
  const live = new Map<string, Negotiation>();
  for (const n of state.negotiations) {
    if (n.status !== "open" && n.status !== "agreed") continue;
    const prev = live.get(n.gamePlayerId);
    if (!prev || n.openedOn > prev.openedOn || (n.openedOn === prev.openedOn && n.id < prev.id)) {
      live.set(n.gamePlayerId, n);
    }
  }
  return live;
}

/** 이 선수의 불만 중 **가장 오래 선 것** — 단계를 미는 것도 사실 줄이 읽는 것도 그것이다 */
function oldestIssue(state: GameState, playerId: string): PlayerIssue | null {
  let oldest: PlayerIssue | null = null;
  for (const issue of state.issues) {
    if (issue.gamePlayerId !== playerId) continue;
    if (!oldest || issue.since < oldest.since) oldest = issue;
  }
  return oldest;
}

/** 연속 n회가 어느 단계인가 — 문턱 아래면 이야기가 아니다 */
function streakStage(n: number): ActiveStage | null {
  if (n >= STREAK_CLIMAX) return "climax";
  if (n >= STREAK_RISING) return "rising";
  if (n >= STREAK_OPEN) return "open";
  return null;
}

/**
 * 오늘의 장부가 세우는 아크 후보 전부. **나오지 않은 열쇠는 닫힌다** —
 * 사실이 사라진 아크를 따로 찾아 지우지 않고, 여기 없다는 것으로 안다.
 */
function candidatesToday(state: GameState, teamId: string): Map<string, ArcCandidate> {
  const found = new Map<string, ArcCandidate>();
  const put = (candidate: ArcCandidate): void => {
    const key = arcKey(candidate.kind, candidate.subjectId);
    const prev = found.get(key);
    if (!prev || ARC_STAGE_RANK[candidate.stage] > ARC_STAGE_RANK[prev.stage]) {
      found.set(key, candidate);
    }
  };

  const squad = playersOf(state, teamId);

  // 부상 복귀 — 우리 선수의 미복귀 부상만. 복귀도 이적도 여기서 사라지는 것으로 닫힌다
  for (const player of squad) {
    const injury = openInjury(state, player.id);
    if (!injury) continue;
    const out = diffDays(injury.occurredOn, injury.expectedReturn);
    if (out < INJURY_MIN_OUT_DAYS) continue;
    const elapsed = diffDays(injury.occurredOn, state.date);
    const left = diffDays(state.date, injury.expectedReturn);
    put({
      kind: "injury-comeback",
      subjectId: player.id,
      stage:
        left <= INJURY_CLIMAX_DAYS
          ? "climax"
          : // 재활 반환점 — 반나절을 가르지 않으려고 2를 곱해 잰다
            elapsed * 2 >= out
            ? "rising"
            : "open",
    });
  }

  // 곪는 불만 — 남의 라커룸 불만은 우리 이야기가 아니다
  const ours = new Set(squad.map((p) => p.id));
  const pressed = new Set(
    (state.approachPressure ?? [])
      .filter((p) => p.step >= GRIEVANCE_CLIMAX_STEP)
      .map((p) => p.subject),
  );
  for (const issue of state.issues) {
    if (!ours.has(issue.gamePlayerId)) continue;
    const days = diffDays(issue.since, state.date);
    if (days < GRIEVANCE_OPEN_DAYS) continue;
    put({
      kind: "grievance",
      subjectId: issue.gamePlayerId,
      stage:
        days >= GRIEVANCE_CLIMAX_DAYS || pressed.has(issue.gamePlayerId)
          ? "climax"
          : days >= GRIEVANCE_RISING_DAYS
            ? "rising"
            : "open",
    });
  }

  /**
   * 연속 기록 — 리그전만 세는 `recentOutcomes`가 시즌으로도 자른다. 그래서 시즌이
   * 바뀌면 후보가 사라져 **연속 아크만 저절로 닫힌다** (people.md §9).
   * 절정의 눈금까지만 읽으면 되므로 창도 그만큼이다.
   */
  const outcomes = recentOutcomes(state, teamId, STREAK_CLIMAX);
  const wins = streakStage(streakOf(outcomes, "win"));
  if (wins) put({ kind: "winning-run", subjectId: teamId, stage: wins });
  const losses = streakStage(streakOf(outcomes, "loss"));
  if (losses) put({ kind: "losing-run", subjectId: teamId, stage: losses });

  // 이적 사가 — 주인은 선수다. 우리가 파는 쪽이든 사는 쪽이든 이야기는 그 사람의 것이다
  for (const [playerId, negotiation] of liveNegotiations(state)) {
    if (negotiation.rounds.length < SAGA_OPEN_ROUNDS) continue;
    put({
      kind: "transfer-saga",
      subjectId: playerId,
      stage:
        negotiation.status === "agreed"
          ? "climax"
          : negotiation.rounds.length >= SAGA_RISING_ROUNDS
            ? "rising"
            : "open",
    });
  }

  return found;
}

// ── 사실 줄 ─────────────────────────────────────────────

/**
 * 아크 하나의 사실 줄 — **이름과 수치와 날짜뿐이다.** 평가어도 연출어도 물음표도
 * 없다 (overview.md §1 철칙 4): 문장은 GM이 쓴다.
 *
 * 닫힌 아크는 사실이 이미 장부에서 사라졌으므로 갈래 이름만 남는다.
 */
export function arcFactLine(state: GameState, arc: NarrativeArc): string {
  switch (arc.kind) {
    case "injury-comeback": {
      const name = playerName(state, arc.subjectId);
      const injury = openInjury(state, arc.subjectId);
      return injury
        ? `${name} ${injury.bodyPart} 부상 · 복귀 예정 ${injury.expectedReturn}`
        : `${name} 부상`;
    }
    case "grievance": {
      const name = playerName(state, arc.subjectId);
      const issue = oldestIssue(state, arc.subjectId);
      if (!issue) return `${name} 불만`;
      const reason = issueReasonText(issue);
      return `${name} 불만${reason === null ? "" : ` ${reason}`} · ${diffDays(issue.since, state.date)}일째`;
    }
    case "winning-run":
    case "losing-run": {
      const win = arc.kind === "winning-run";
      const word = win ? "연승" : "연패";
      const n = streakOf(recentOutcomes(state, arc.subjectId, STREAK_CLIMAX), win ? "win" : "loss");
      return n < STREAK_OPEN ? `리그 ${word}` : `리그 ${n}${word}`;
    }
    case "transfer-saga": {
      const name = playerName(state, arc.subjectId);
      const negotiation = liveNegotiations(state).get(arc.subjectId);
      if (!negotiation) return `${name} 협상`;
      const agreed = negotiation.status === "agreed" ? " · 합의" : "";
      return `${name} 협상 ${negotiation.rounds.length}라운드${agreed}`;
    }
  }
}

// ── 조회 ────────────────────────────────────────────────

/** 아직 닫히지 않은 아크 — 상태 스냅샷에 서는 것들 */
export function activeArcs(state: GameState): NarrativeArc[] {
  return (state.arcs ?? []).filter((arc) => arc.resolvedOn === null);
}

/**
 * 상태 스냅샷 블록 — 활성 아크가 없으면 null(빈 제목을 단 자리를 만들지 않는다).
 * 이름이 없는 아크는 **코어의 사실 줄이 그 자리를 대신한다** — 이름 짓기가
 * 실패해도 아크는 굴러간다 (people.md §9).
 */
export function describeActiveArcs(state: GameState): string | null {
  const arcs = activeArcs(state);
  if (arcs.length === 0) return null;
  return arcs
    .map((arc) => {
      const title = arc.title === undefined ? "" : `${arc.title} — `;
      return `- [${ARC_STAGE_KO[arc.stage]}] ${title}${arcFactLine(state, arc)}`;
    })
    .join("\n");
}

// ── 매일 tick ───────────────────────────────────────────

/**
 * 열고·올리고·닫는다. 단계가 움직인 아크만 다이제스트에 한 줄 남긴다 —
 * 그대로인 이야기는 소식이 아니다.
 *
 * ⚠️ **단계는 뒤로 가지 않는다.** 사실이 잠깐 물러났다고(불만이 하루 식는다,
 * 다가옴 계단이 내려간다) 되감기면 GM이 지난 턴과 다른 흐름을 읽는다. 물러난
 * 사실이 아크를 움직이는 길은 **닫히는 것** 하나뿐이다.
 */
export function tickArcs(state: GameState, digest: string[]): void {
  const arcs = (state.arcs ??= []);
  const teamId = managedTeamId(state);

  const move = (arc: NarrativeArc, stage: ArcStage): void => {
    arc.stage = stage;
    arc.updatedOn = state.date;
    if (stage === "resolved") arc.resolvedOn = state.date;
    digest.push(`${arcFactLine(state, arc)} — ${ARC_STAGE_KO[stage]}`);
  };

  /**
   * 무직이면 후보가 없다 — 선수단도 순위도 협상도 이제 남의 것이라, 옛 구단의
   * 이야기가 전부 닫힌다 (불만을 비우는 것과 같은 결, career.md §5.1).
   */
  const found = teamId === null ? new Map<string, ArcCandidate>() : candidatesToday(state, teamId);

  let active = 0;
  for (const arc of arcs) {
    if (arc.resolvedOn !== null) continue;
    const key = arcKey(arc.kind, arc.subjectId);
    const candidate = found.get(key);
    if (!candidate) {
      move(arc, "resolved");
      continue;
    }
    found.delete(key); // 이 후보는 이미 선 아크의 것이다 — 두 번 열지 않는다
    if (ARC_STAGE_RANK[candidate.stage] > ARC_STAGE_RANK[arc.stage]) move(arc, candidate.stage);
    active++;
  }

  // 빈 자리만 채운다 — 이미 선 아크는 우선순위가 높은 후보에게도 밀려나지 않는다
  const fresh = [...found.values()].sort(
    (a, b) =>
      ARC_KIND_ORDER.indexOf(a.kind) - ARC_KIND_ORDER.indexOf(b.kind) ||
      asc(a.subjectId, b.subjectId),
  );
  for (const candidate of fresh) {
    if (active >= MAX_ACTIVE_ARCS) break;
    const id = `arc:${candidate.kind}:${candidate.subjectId}:${state.date}`;
    // 같은 날 닫힌 같은 이야기가 다시 서면 id가 겹친다 — 겹친 자리엔 세우지 않는다
    if (arcs.some((arc) => arc.id === id)) continue;
    const opened: NarrativeArc = {
      id,
      kind: candidate.kind,
      subjectId: candidate.subjectId,
      stage: candidate.stage,
      openedOn: state.date,
      updatedOn: state.date,
      resolvedOn: null,
    };
    arcs.push(opened);
    active++;
    digest.push(`${arcFactLine(state, opened)} — ${ARC_STAGE_KO[candidate.stage]}`);
  }

  pruneResolved(state, arcs);
}

/** 닫힌 아크는 보관 수까지만 — 오래 닫힌 것부터 밀린다 */
function pruneResolved(state: GameState, arcs: NarrativeArc[]): void {
  const resolved = arcs.filter((arc) => arc.resolvedOn !== null);
  if (resolved.length <= ARC_RESOLVED_KEEP) return;
  const drop = new Set(
    [...resolved]
      .sort((a, b) => asc(a.resolvedOn ?? "", b.resolvedOn ?? ""))
      .slice(0, resolved.length - ARC_RESOLVED_KEEP)
      .map((arc) => arc.id),
  );
  state.arcs = arcs.filter((arc) => !drop.has(arc.id));
}

// ── 이름 짓기 ───────────────────────────────────────────

export interface ArcTitleDraft {
  arcId: string;
  title: string;
}

/**
 * 압축 에이전트의 제목 제안을 검증해 반영한다 — `registerCharacters`와 같은 계약
 * (people.md §9): 아크가 실제로 있고 · 아직 활성이며 · **이름이 없어야** 받는다.
 * 한 번 붙은 이름은 시즌 내내 같은 이야기를 가리켜야 하므로 덮어쓰지 않는다.
 * 걸린 항목만 버리고 나머지는 반영한다.
 *
 * @returns 실제로 이름이 붙은 아크 수
 */
export function applyArcTitles(state: GameState, drafts: readonly ArcTitleDraft[]): number {
  const arcs = state.arcs ?? [];
  let applied = 0;
  for (const draft of drafts) {
    const arc = arcs.find((a) => a.id === draft.arcId);
    if (!arc || arc.resolvedOn !== null || arc.title !== undefined) continue;
    const title = draft.title.trim();
    if (title.length === 0 || title.length > ARC_TITLE_MAX) continue;
    arc.title = title;
    applied++;
  }
  return applied;
}
