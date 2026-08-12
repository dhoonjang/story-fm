import { MANAGER_ATTRIBUTE_KO } from "@story-fm/domain";
import type {
  BoardPoint,
  ManagerAttributes,
  DrilledTactics,
  MarketCard,
  Player,
  ScheduleEntry,
  Slot,
  TacticAssignment,
  TacticsSpec,
  TeamTactics,
  TrainAttr,
} from "@story-fm/domain";
import {
  ATTRIBUTE_AXES,
  AXIS_KO,
  clampCondition,
  FAMILIARITY_MAX,
  tacticalUptake as uptakeOf,
  PLAYER_DIRECTIVE_KO,
  type PlayerDirectiveKind,
  MATCHDAY_SQUAD,
  POSITION_GROUPS,
  SCOUT_CONCURRENT_LIMIT,
  SCOUT_DAYS,
  SLOT_TIME,
  slotOfTime,
  TacticsSpecSchema,
  anchorOf,
  shapeOf,
  clampToBoard,
  movePoint,
  naturalPositionOf,
  positionAtPoint,
  positionGroupOf,
  defaultRoleOf,
  roleDistance,
  rolesFor,
  separateBoardPoints,
  familiarityForSetup,
  tacticsSignature,
  tacticsAffinityShift,
  tacticsDistance,
  withCurrentDrilled,
} from "@story-fm/domain";
import { addDays, diffDays, sortEntries, squadReturnOf } from "../competition/calendar";
import { clampForm, moraleToForm } from "../squad/form";
import { canRegisterFor, registrationLine, squadRegistrationOf } from "../squad/registration";
import { SCOUT_REPEAT_LIMIT, completedScoutReports } from "../squad/scouting";
import { creditSettling, settlingAnchor, settlingOf } from "../squad/settling";
import {
  assignmentsOf,
  groupOf,
  isInjured,
  isSuspended,
  playerById,
  playerName,
  proficiencyAt,
  pushNarrative,
  recomputeOverall,
  squadLevelOf,
  tacticsOf,
  teamName,
  userPlayerById,
  userPlayers,
  userTactics,
  FAMILIARITY_BASELINE,
  MATCHDAY_BENCH,
  type GameState,
} from "../core/state";

/**
 * 스킬 = 상태 변경의 유일한 통로 (overview §2.2·§5).
 * 판정형: LLM은 {outcome, intensity}만 정하고 변화량은 여기 공식이 정한다
 * (overview §7). 감독 능력치가 계수로 들어간다 (결정 #13).
 */

export interface SkillResult {
  ok: boolean;
  message: string;
  /**
   * 화면이 카드로 그릴 **구조화된 결과** — 채우는 스킬만 채운다.
   * 없으면 UI가 칩 + 요약으로 폴백하므로, 넣지 않는 것이 기본이다.
   */
  payload?: unknown;
  /** 결이 좋은가 — 대화형 스킬의 칩 색 (펼치지 않아도 알게) */
  tone?: "good" | "bad";
}

/**
 * 1·2군 이동 — 상한은 임의의 숫자가 아니라 **등록 명단 규칙**이다.
 * 만 21세 초과는 25명까지, 그중 홈그로운 8명(= 비홈그로운 17명 상한).
 * U21은 명단을 차지하지 않으므로 언제든 올릴 수 있다 (squad-rules.ts).
 * 강등의 하한은 매치데이 명단(선발 11 + 벤치 9 = 20명)에서 온다.
 */
export function setSquadLevel(
  state: GameState,
  input: { playerId: string; level: "first" | "reserve" },
): SkillResult {
  const player = userPlayerById(state, input.playerId);
  if (!player) return { ok: false, message: `"${input.playerId}"는 우리 팀 선수가 아닙니다` };
  if (squadLevelOf(player) === input.level) {
    return {
      ok: true,
      message: `${player.name}은(는) 이미 ${input.level === "first" ? "1군" : "2군"}입니다`,
    };
  }
  if (input.level === "first") {
    const allowed = canRegisterFor(state, player, state.userTeamId);
    if (!allowed.ok) return { ok: false, message: `${player.name}: ${allowed.reason}` };
    player.squadLevel = "first";
    pushNarrative(state, `${player.name} 1군 승격`, 2);
    const reg = squadRegistrationOf(state, state.userTeamId);
    return {
      ok: true,
      message: `${player.name}을(를) 1군으로 승격했습니다 — ${registrationLine(reg)}`,
    };
  }

  const first = userPlayers(state).filter((p) => squadLevelOf(p) === "first");
  if (first.length <= MATCHDAY_SQUAD) {
    return {
      ok: false,
      message: `1군은 매치데이 명단(선발 11 + 벤치 9)을 채울 ${MATCHDAY_SQUAD}명 이상이어야 합니다`,
    };
  }
  player.squadLevel = "reserve";
  userTactics(state).assignments = userTactics(state).assignments.filter(
    (a) => a.playerId !== player.id,
  );
  if (player.isCaptain) player.isCaptain = false;
  pushNarrative(state, `${player.name} 2군 이동`, 2);
  return { ok: true, message: `${player.name}을(를) 2군으로 이동했습니다` };
}

// 체력 클램프는 도메인이 단일 소스 (clampCondition)
// 폼 클램프는 form.ts가 단일 소스 — 소수를 살려야 매일 회귀가 반영된다
/** 적응도 전용 — 천장이 100이고 **소수를 자르지 않는다**(위쪽은 소수로 쌓인다) */
const clampFamiliarity = (x: number) => Math.max(0, Math.min(FAMILIARITY_MAX, x));

export const POSITION_CODES = Object.keys(POSITION_GROUPS);
export { positionGroupOf };

// ---- 감독 성장 (attribute-model.md §7) ----

const XP_PER_LEVEL = 100;
const ATTR_CAP = 90;

export function grantManagerXP(
  state: GameState,
  axis: keyof ManagerAttributes,
  amount: number,
): string | null {
  state.managerXP[axis] += amount;
  if (state.managerXP[axis] >= XP_PER_LEVEL && state.manager.attributes[axis] < ATTR_CAP) {
    state.managerXP[axis] -= XP_PER_LEVEL;
    state.manager.attributes[axis] += 1;
    return `감독 성장 — ${MANAGER_ATTRIBUTE_KO[axis]} ${state.manager.attributes[axis]}`;
  }
  return null;
}

// ---- 판정형: team_talk / talk_to_player ----

export const TEAM_TALK_OUTCOMES = [
  "inspired",
  "encouraged",
  "neutral",
  "flat",
  "backfired",
  "feared",
] as const;
export type TeamTalkOutcome = (typeof TEAM_TALK_OUTCOMES)[number];

export const TALK_OUTCOMES = [
  "reassured",
  "motivated",
  "neutral",
  "disappointed",
  "angered",
] as const;
export type TalkOutcome = (typeof TALK_OUTCOMES)[number];

const TEAM_TALK_BASE: Record<TeamTalkOutcome, number> = {
  inspired: 3,
  encouraged: 2,
  neutral: 0,
  flat: -1,
  backfired: -3,
  feared: 1,
};

const TALK_BASE: Record<TalkOutcome, number> = {
  reassured: 4,
  motivated: 5,
  neutral: 0,
  disappointed: -3,
  angered: -6,
};

/** 리더십 계수 — 같은 말도 리더십이 자라면 더 크게 울린다 */
function leadershipFactor(state: GameState): number {
  return 0.7 + (state.manager.attributes.leadership / 99) * 0.6;
}

export function applyTeamTalk(
  state: GameState,
  input: {
    occasion: "pre" | "half" | "post" | "daily";
    outcome: TeamTalkOutcome;
    intensity: 1 | 2 | 3;
    /** 이 말이 새 영입들의 적응에 남긴 무게 — 코어 앵커에서 EVENT_BAND만큼만 */
    settling?: number;
  },
): SkillResult {
  const base = TEAM_TALK_BASE[input.outcome];
  const delta = Math.round(base * (input.intensity / 2) * leadershipFactor(state));
  const bounded = Math.max(-6, Math.min(6, delta)); // 이벤트당 한도 (overview §7)
  for (const p of userPlayers(state)) {
    p.state.form = clampForm(p.state.form + moraleToForm(bounded));
  }
  // 라커룸 앞에서 한 말은 **아직 겉도는 새 영입**에게 특히 크게 남는다 (settling.ts)
  const settlingAnchorValue = settlingAnchor("team_talk", { intensity: input.intensity });
  const settled =
    base > 0
      ? userPlayers(state).filter(
          (p) =>
            creditSettling(state, p.id, "team_talk", {
              anchor: settlingAnchorValue,
              ...(input.settling === undefined ? {} : { proposed: input.settling }),
            }) > 0,
        ).length
      : 0;
  const xpMsg =
    base > 0
      ? grantManagerXP(state, "leadership", 8 * input.intensity)
      : grantManagerXP(state, "leadership", 2);
  pushNarrative(state, `팀토크(${input.outcome}) — 사기 ${bounded >= 0 ? "+" : ""}${bounded}`, 2);
  return {
    ok: true,
    // 펼치지 않아도 잘 풀렸는지는 알아야 한다 — 숫자는 펼쳤을 때만
    tone: bounded >= 0 ? ("good" as const) : ("bad" as const),
    message:
      `팀 전체 사기 ${bounded >= 0 ? "+" : ""}${bounded}` +
      (settled > 0 ? ` · 적응 중인 ${settled}명이 한 걸음 가까워졌습니다` : "") +
      (xpMsg ? ` · ${xpMsg}` : ""),
  };
}

export function applyTalkToPlayer(
  state: GameState,
  input: {
    playerId: string;
    outcome: TalkOutcome;
    intensity: 1 | 2 | 3;
    /**
     * 이 면담이 그 선수의 적응에 남긴 무게 — 생략하면 코어 앵커.
     * 같은 "격려"라도 통역을 붙여 준 이야기와 지나가며 한 말은 다르다.
     */
    settling?: number;
    /** 무게의 근거 한 줄 — 정착 원장에 남는다 */
    settlingNote?: string;
  },
): SkillResult {
  const player = userPlayerById(state, input.playerId);
  if (!player) return { ok: false, message: `"${input.playerId}"는 우리 팀 선수가 아닙니다` };

  const base = TALK_BASE[input.outcome];
  const delta = Math.round(base * (input.intensity / 2) * leadershipFactor(state));
  const bounded = Math.max(-8, Math.min(8, delta));
  player.state.form = clampForm(player.state.form + moraleToForm(bounded));

  // 면담은 방치 이슈를 해소한다 (game-loop §4-5)
  const hadIssue = state.issues.some((i) => i.gamePlayerId === player.id);
  state.issues = state.issues.filter((i) => i.gamePlayerId !== player.id);

  /**
   * 새 영입에게 면담은 **적응의 계기**다 — 아직 못 쓰는 선수에게도 감독이 할 수
   * 있는 일이 있어야 한다. 결과가 나쁘면 오히려 더 겉돈다(음수).
   */
  const settlingCredit = creditSettling(state, player.id, "talk", {
    anchor: settlingAnchor("talk", { direction: base > 0 ? 1 : -1, intensity: input.intensity }),
    ...(input.settling === undefined ? {} : { proposed: input.settling }),
    ...(input.settlingNote === undefined ? {} : { note: input.settlingNote }),
  });
  const settling = settlingCredit !== 0 ? settlingOf(state, player.id) : null;

  const xpMsg =
    base > 0
      ? grantManagerXP(state, "leadership", 6 * input.intensity)
      : grantManagerXP(state, "leadership", 2);
  pushNarrative(
    state,
    `${player.name} 면담(${input.outcome}) — 사기 ${bounded >= 0 ? "+" : ""}${bounded}`,
    2,
  );
  return {
    ok: true,
    tone: bounded >= 0 ? ("good" as const) : ("bad" as const),
    message:
      `${player.name} 사기 ${bounded >= 0 ? "+" : ""}${bounded}` +
      (hadIssue ? " · 불만 해소" : "") +
      (settling ? ` · 적응 ${Math.round(settling.progress * 100)}%` : "") +
      (xpMsg ? ` · ${xpMsg}` : ""),
  };
}

// ---- 설정형: 라인업 = 전술 배치 ----

export interface LineupSlotInput {
  playerId: string;
  /** 이 전술에서 맡는 포지션 — 생략 시 포메이션 슬롯 기본값 */
  position?: string;
  /**
   * 전술판 좌표 (자유 배치) — 주면 **포지션은 이 좌표에서 파생**하고 position은 무시한다.
   * 코드와 좌표가 어긋나는 배치를 애초에 만들지 않기 위해서다 (클라이언트를 믿지 않는다).
   */
  point?: BoardPoint;
}

/**
 * 배치의 좌표를 정한다 — **감독이 손대지 않은 자리는 건드리지 않는다.**
 *
 * 전술판에서 볼란치를 조금 올려 CM으로 만들어 놨는데, 채팅으로 다른 선수 하나를
 * 교체했다고 그 미세 조정이 프리셋으로 되돌아가면 안 된다. 그래서 우선순위를
 * "명시 → 유지 → 물려받기 → 프리셋" 순으로 둔다.
 *
 * 1. `point` — 전술판에서 찍은 점. 무조건 1순위.
 * 2. `position` — 코드로 자리를 지정했다. 그 선수가 **이미 그 코드**였다면 미세
 *    조정된 좌표를 지키고, 아니면 그 코드의 기본 좌표로 옮긴다.
 * 3. **아무것도 안 줬고 이미 선발이었다 → 기존 좌표 그대로.** 배열 순서도 프리셋도
 *    보지 않는다. 이게 "안 건드린다"의 실제 형태다.
 * 4. 새로 들어온 선수 → **빠진 선수의 자리를 물려받는다.** 교체는 자리를 잇는다.
 * 5. 그래도 자리가 없으면 프리셋, 마지막이 코드 기본 좌표.
 *
 * 포메이션 자체를 바꾸면 `setTactics`가 선발 좌표를 프리셋으로 되깔므로,
 * "명확한 포메이션 변경"일 때만 전면 재배치가 일어난다.
 */
function candidatePoint(
  slot: LineupSlotInput,
  prev: TacticAssignment | undefined,
  fallback: { inherited?: BoardPoint; preset?: BoardPoint; natural: string },
): BoardPoint {
  if (slot.point) return clampToBoard(slot.point);
  const wasStarter = prev?.role === "starting" && prev.point !== undefined;
  if (slot.position) {
    const code = slot.position.toUpperCase();
    // 이미 그 자리였다면 조정해 둔 좌표를 지킨다 (같은 코드로 다시 지시해도 안 튄다)
    if (wasStarter && prev!.position === code) return prev!.point!;
    return anchorOf(code);
  }
  if (wasStarter) return prev!.point!;
  if (fallback.inherited) return fallback.inherited;
  if (fallback.preset) return fallback.preset;
  return anchorOf(fallback.natural);
}

/** 한 항목에 이름을 몇 개까지 적나 — 넘치면 접는다 (요약은 한 줄이다) */
const NAMES_SHOWN = 3;

const nameList = (names: readonly string[]): string =>
  names.slice(0, NAMES_SHOWN).join(", ") +
  (names.length > NAMES_SHOWN ? ` 외 ${names.length - NAMES_SHOWN}명` : "");

/**
 * 배치가 **실제로 바꾼 것** — 포메이션 · 들고 나감 · 자리 이동.
 *
 * "라인업을 확정했습니다"는 감독이 이미 아는 것만 말한다. 무엇이 달라졌는지는
 * 앞뒤 배치를 견줘야 아는 사실이고 그건 코어만 안다 — 그러니 코어가 적는다.
 * 문장으로 엮지 않고 항목으로 끊는다: 화면이 ` · `로 갈라 세운다.
 */
function lineupChanges(
  state: GameState,
  prev: ReadonlyMap<string, TacticAssignment>,
  next: readonly TacticAssignment[],
): string[] {
  const nameOf = (id: string) => playerName(state, id);
  const was = [...prev.values()].filter((a) => a.role === "starting");
  const now = next.filter((a) => a.role === "starting");
  const pointOf = (a: TacticAssignment) => a.point ?? anchorOf(a.position);
  // 앞선 배치가 없다면(첫 편성) 견줄 것이 없다 — 지금의 모양만 말한다
  if (was.length === 0) return [`선발 ${now.length}명 편성 · ${shapeOf(now.map(pointOf))}`];

  const parts: string[] = [];
  const shapeBefore = shapeOf(was.map(pointOf));
  const shapeAfter = shapeOf(now.map(pointOf));
  if (shapeBefore !== shapeAfter) parts.push(`포메이션 ${shapeBefore} → ${shapeAfter}`);

  const startedBefore = new Set(was.map((a) => a.playerId));
  const startsNow = new Set(now.map((a) => a.playerId));
  const added = now.filter((a) => !startedBefore.has(a.playerId));
  const gone = was.filter((a) => !startsNow.has(a.playerId));
  if (added.length > 0) {
    parts.push(`선발 투입 ${nameList(added.map((a) => `${nameOf(a.playerId)} ${a.position}`))}`);
  }
  if (gone.length > 0) parts.push(`선발 제외 ${nameList(gone.map((a) => nameOf(a.playerId)))}`);

  /**
   * 남아 있는 선수의 **자리 이동** — 감독이 판에서 가장 자주 하는 조정이고,
   * 인원이 그대로라 다른 항목에는 아무 흔적도 남지 않는다.
   */
  const moved = now.filter((a) => {
    const old = prev.get(a.playerId);
    return old?.role === "starting" && old.position !== a.position;
  });
  if (moved.length > 0) {
    parts.push(
      `자리 이동 ${nameList(
        moved.map((a) => `${nameOf(a.playerId)} ${prev.get(a.playerId)!.position} → ${a.position}`),
      )}`,
    );
  }

  if (parts.length > 0) return parts;
  // 선발이 그대로면 남은 차이는 명단 쪽뿐이다 — 누가 오갔는지까지는 적지 않는다
  const squadBefore = new Set(prev.keys());
  const squadNow = new Set(next.map((a) => a.playerId));
  const sameSquad =
    squadBefore.size === squadNow.size && [...squadNow].every((id) => squadBefore.has(id));
  return [sameSquad ? "바뀐 것 없음" : "벤치 명단 조정"];
}

/**
 * 라인업 확정 — v6에서는 TACTIC_ASSIGNMENT를 갱신한다 (팀 엔티티에 배열이 없다).
 * 선발 11명·GK 1명·부상/정지 제외를 강제하고, 기존 적응도는 이어받는다.
 */
export function setLineup(
  state: GameState,
  input: {
    starting: Array<string | LineupSlotInput>;
    bench?: Array<string | LineupSlotInput>;
    /**
     * 1·2군 이동을 **같은 요청으로** 처리한다 (승격 → 배치 → 강등 순).
     * 나눠 보내면 "승격은 됐는데 배치는 실패"한 반쪽 상태가 남는다 —
     * 웹 스쿼드 화면이 이미 한 요청으로 저장하는 것과 같은 이유다.
     */
    squadLevels?: Array<{ playerId: string; level: "first" | "reserve" }>;
  },
): SkillResult {
  // 승격 먼저 — 2군 선수를 선발에 넣으려면 올라와 있어야 한다
  const levelNotes: string[] = [];
  for (const move of input.squadLevels ?? []) {
    if (move.level !== "first") continue;
    const res = setSquadLevel(state, move);
    if (!res.ok) return res;
    levelNotes.push(res.message);
  }

  const tactics = userTactics(state);
  const norm = (x: string | LineupSlotInput): LineupSlotInput =>
    typeof x === "string" ? { playerId: x } : x;
  const starting = input.starting.map(norm);
  const bench = (input.bench ?? []).map(norm);

  if (starting.length !== 11) return { ok: false, message: "선발은 정확히 11명이어야 합니다" };
  if (new Set(starting.map((s) => s.playerId)).size !== 11) {
    return { ok: false, message: "선발에 중복 선수가 있습니다" };
  }
  const overlap = bench.filter((b) => starting.some((s) => s.playerId === b.playerId));
  if (overlap.length > 0) {
    return {
      ok: false,
      message: `선발과 벤치에 중복 등재: ${overlap.map((o) => o.playerId).join(", ")}`,
    };
  }
  if (new Set(bench.map((b) => b.playerId)).size !== bench.length) {
    return { ok: false, message: "벤치에 중복 선수가 있습니다" };
  }

  const all = [...starting, ...bench];
  const unknown = all.filter((s) => !userPlayerById(state, s.playerId));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `보유 선수가 아닙니다: ${unknown.map((u) => u.playerId).join(", ")}`,
    };
  }
  const reserves = all.filter((s) => {
    const player = userPlayerById(state, s.playerId);
    return player && squadLevelOf(player) === "reserve";
  });
  if (reserves.length > 0) {
    return {
      ok: false,
      message: `2군 선수는 먼저 1군으로 승격해야 합니다: ${reserves
        .map((s) => playerName(state, s.playerId))
        .join(", ")}`,
    };
  }
  // 기존 적응도·지시는 이어받는다 (배치가 바뀌어도 학습이 사라지지 않게)
  const prev = new Map(tactics.assignments.map((a) => [a.playerId, a]));

  // 명시된 포지션 코드는 먼저 검증한다 (좌표는 아래에서 정해진다)
  const unknownPos = starting
    .map((s) => s.position?.toUpperCase())
    .filter((code): code is string => code !== undefined && !positionGroupOf(code));
  if (unknownPos.length > 0) {
    return { ok: false, message: `알 수 없는 포지션: ${unknownPos.join(", ")}` };
  }

  /**
   * 빠진 선발의 자리 — 새로 들어온 선수가 물려받는다. 교체 지시에 좌표가 없어도
   * "나간 사람 자리에 들어간다"가 되어 전술판 모양이 유지된다.
   */
  const staying = new Set(starting.map((s) => s.playerId));
  const vacated = tactics.assignments
    .filter((a) => a.role === "starting" && !staying.has(a.playerId) && a.point !== undefined)
    .map((a) => a.point!);
  let nextVacant = 0;

  // 후보 좌표 → **겹침 해소** → 최종 코드.
  // 코드를 좌표보다 먼저 정하지 않는 이유: 밀어낸 뒤의 좌표가 코드의 유일한 원본이어야
  // "코드 = positionAtPoint(point)" 불변식이 깨지지 않는다. 밀려서 코드 표기가 바뀌는
  // 경우(CB 둘 → LCB/RCB, DM → CDM)는 모두 같은 자리라 전력에 영향이 없다.
  const startPoints = separateBoardPoints(
    starting.map((s) => {
      const before = prev.get(s.playerId);
      const isNewcomer = !s.point && !s.position && before?.role !== "starting";
      return candidatePoint(s, before, {
        ...(isNewcomer && vacated[nextVacant] ? { inherited: vacated[nextVacant++]! } : {}),
        natural: naturalPositionOf(userPlayerById(state, s.playerId)!).position,
      });
    }),
  );
  const startCodes = startPoints.map(positionAtPoint);

  const gkCount = startCodes.filter((code) => positionGroupOf(code) === "GK").length;
  if (gkCount !== 1) {
    return { ok: false, message: "선발에는 골키퍼 포지션이 정확히 1명 필요합니다" };
  }
  const injured = starting.filter((s) => isInjured(state, s.playerId));
  if (injured.length > 0) {
    return {
      ok: false,
      message: `부상 선수는 선발 불가: ${injured.map((s) => playerName(state, s.playerId)).join(", ")}`,
    };
  }
  const suspended = starting.filter((s) => isSuspended(state, s.playerId));
  if (suspended.length > 0) {
    return {
      ok: false,
      message: `출장 정지 선수는 선발 불가: ${suspended.map((s) => playerName(state, s.playerId)).join(", ")}`,
    };
  }

  // 처음 배치되는 선수(2군에서 올라왔거나 갓 영입된)는 이 전술을 훈련한 적이 없다.
  // 기준선(60)을 그냥 주면 **팀이 재적응 중일 때 신입이 고참보다 전술을 잘 아는**
  // 역전이 생긴다 — 팀 수준을 넘지 못하게 막는다.
  const teamLevel = currentFamiliarity(tactics);
  const newcomerFamiliarity = Math.min(FAMILIARITY_BASELINE, teamLevel);
  /**
   * 이전 배치에서 물려받는 것 — 적응도·개인 지시, 그리고 **자리가 같을 때만 역할**.
   * 자리가 바뀌면 그 역할은 존재하지 않는다(센터백의 리베로를 윙에 데려갈 수 없다).
   */
  const inherit = (playerId: string, code?: string) => {
    const old = prev.get(playerId);
    const keepRole = old?.roleId && code && rolesFor(code).some((role) => role.id === old.roleId);
    return {
      familiarity: old?.familiarity ?? newcomerFamiliarity,
      ...(old?.instruction ? { instruction: old.instruction } : {}),
      ...(old?.directive ? { directive: old.directive } : {}),
      ...(keepRole ? { roleId: old.roleId } : {}),
      /**
       * **오늘 역할을 손댄 흔적은 살려 둔다.** 전술판은 조작마다 배치를 다시
       * 쓰는데, 여기서 memo가 사라지면 저장할 때마다 "오늘 아침"이 새로 잡혀
       * 같은 결정에 값을 여러 번 치른다 — 자동 저장에 얹은 의미가 없어진다.
       * 자리가 바뀌면 역할도 바뀌므로 그때는 버린다.
       */
      ...(keepRole && old?.roleMemo ? { roleMemo: old.roleMemo } : {}),
    };
  };
  const startingAssignments: TacticAssignment[] = starting.map((s, i) => ({
    playerId: s.playerId,
    role: "starting",
    position: startCodes[i]!,
    point: startPoints[i]!,
    ...inherit(s.playerId, startCodes[i]!),
  }));
  // 벤치는 전술판에 없으므로 좌표를 두지 않는다 (선발만 자리를 갖는다)
  const benchAssignments: TacticAssignment[] = bench.map((s) => ({
    playerId: s.playerId,
    role: "bench",
    position: (
      s.position ?? naturalPositionOf(userPlayerById(state, s.playerId)!).position
    ).toUpperCase(),
    ...inherit(s.playerId),
  }));

  // 무엇이 달라졌나는 **덮어쓰기 전에** 견준다 (`prev`가 옛 배치를 들고 있다)
  const changes = lineupChanges(state, prev, [...startingAssignments, ...benchAssignments]);
  tactics.assignments = [...startingAssignments, ...benchAssignments];
  // 호환 필드는 실제 좌표에서 읽는다. 이 값으로 다시 프리셋을 적용하지 않는다.
  tactics.spec.formation = shapeOf(startPoints) as TacticsSpec["formation"];

  // 강등은 배치 뒤에 — 배치에서 빠진 뒤라야 2군으로 내려도 라인업이 안 깨진다
  for (const move of input.squadLevels ?? []) {
    if (move.level !== "reserve") continue;
    const res = setSquadLevel(state, move);
    if (!res.ok) return res;
    levelNotes.push(res.message);
  }
  return { ok: true, message: `라인업 확정 — ${[...changes, ...levelNotes].join(" · ")}` };
}

/**
 * 전술판 저장이 실제로 바꾼 것 — **결과만 한 줄로.**
 *
 * 감독은 판을 짜며 열 번을 만지고 그때마다 저장이 돈다. 그 하나하나가 아니라
 * "무엇이 달라졌나"가 모델이 반응할 거리다 (`recordEdit`가 접어 준다).
 */
/**
 * 지금 배치의 지문 — **선수·자리·좌표**를 한 문자열로.
 * 저장 전후를 이걸로 견주면 "정말 달라졌나"를 정확히 가른다 (좌표는 1 단위로
 * 접어 미세한 부동소수 차이를 무시한다).
 */
export function lineupSignature(state: GameState): string {
  return userTactics(state)
    .assignments.filter((a) => a.role === "starting")
    .map((a) => {
      const p = a.point ?? anchorOf(a.position);
      return `${a.playerId}@${a.position}:${Math.round(p.x)},${Math.round(p.y)}`;
    })
    .sort()
    .join("|");
}

/** 지금 선발인 선수들 (저장 전후 비교용) */
export function startingIdsOf(state: GameState): string[] {
  return userTactics(state)
    .assignments.filter((a) => a.role === "starting")
    .map((a) => a.playerId);
}

/** 지금 배치에서 읽히는 포메이션 — 좌표가 곧 모양이다 */
export function shapeOfTactics(state: GameState): string {
  return shapeOf(
    userTactics(state)
      .assignments.filter((a) => a.role === "starting")
      .map((a) => a.point ?? anchorOf(a.position)),
  );
}

export function lineupChangeNote(
  state: GameState,
  before: { starting: readonly string[]; shape: string; signature: string },
): string | null {
  const tactics = userTactics(state);
  const now = tactics.assignments.filter((a) => a.role === "starting").map((a) => a.playerId);
  const nameOf = (id: string) => playerById(state, id)?.name ?? id;
  const parts: string[] = [];

  const shape = shapeOfTactics(state);
  if (shape !== before.shape) parts.push(`포메이션 ${before.shape} → ${shape}`);

  const gone = before.starting.filter((id) => !now.includes(id));
  const added = now.filter((id) => !before.starting.includes(id));
  if (added.length > 0 || gone.length > 0) {
    parts.push(
      `선발 교체 — 들어옴: ${added.map(nameOf).join(", ") || "없음"} / 빠짐: ${gone.map(nameOf).join(", ") || "없음"}`,
    );
  } else if (parts.length === 0 && lineupSignature(state) !== before.signature) {
    // 인원도 모양도 그대로인데 지문이 다르다 — 자리를 미세 조정했다는 뜻
    parts.push("전술판에서 자리를 조정했다");
  }
  return parts.length > 0 ? `전술판: ${parts.join(" · ")}` : null;
}

/**
 * 한 선수의 **전술 설정**을 한 번에 — 자리·역할·개인 지시.
 *
 * 셋은 늘 함께 판단되는 것들인데(누구를 어디에 어떤 역할로 세우고 무엇을
 * 시키나) 도구가 셋으로 갈려 있었다. 감독의 한마디("6번을 레지스타로 내려")가
 * 도구 두세 번이 되면 GM이 하나를 빠뜨린다.
 */
export function setPlayerTactic(
  state: GameState,
  input: {
    playerId: string;
    position?: string;
    point?: BoardPoint;
    move?: { lane?: "left" | "center" | "right"; band?: "defense" | "midfield" | "attack" };
    role?: string;
    /** 개인 지시 — 자유 서술 + 선택적 종류·대상 */
    instruction?: { note: string; kind?: PlayerDirectiveKind; targetId?: string };
  },
): SkillResult {
  const notes: string[] = [];
  if (input.position !== undefined || input.point !== undefined || input.move !== undefined) {
    const res = movePlayerSlot(state, {
      playerId: input.playerId,
      ...(input.position ? { position: input.position } : {}),
      ...(input.point ? { point: input.point } : {}),
      ...(input.move ? { move: input.move } : {}),
    });
    // 이미 그 자리면 넘어간다 — 역할·지시만 바꾸는 호출을 막지 않는다
    if (!res.ok && !res.message.includes("이미")) return res;
    if (res.ok) notes.push(res.message);
  }
  if (input.role !== undefined) {
    const res = setPlayerRole(state, { playerId: input.playerId, role: input.role });
    if (!res.ok) return res;
    notes.push(res.message);
  }
  if (input.instruction !== undefined) {
    const res = setPlayerInstruction(state, { playerId: input.playerId, ...input.instruction });
    if (!res.ok) return res;
    notes.push(res.message);
  }
  if (notes.length === 0) return { ok: false, message: "바꿀 것을 하나는 지정해야 합니다" };
  return { ok: true, message: notes.join(" · ") };
}

/**
 * **자리 이동 — 교체 없이 선발 안에서만.**
 *
 * 경기 중 감독이 가장 자주 하는 조정인데(윙어를 반대편으로, 풀백을 센터백으로)
 * 경기 중 도구가 `substitute`뿐이라 표현할 길이 없었다. `set_lineup`을 경기에
 * 열어 주면 벤치 선수를 교체 기록 없이 그라운드에 세울 수 있어 위험하다 —
 * 그래서 **이미 뛰고 있는 선수의 자리만** 바꾸는 도구를 따로 둔다.
 */
export function movePlayerSlot(
  state: GameState,
  input: {
    playerId: string;
    position?: string;
    /** 전술판 좌표 — **화면의 드래그**가 쓴다 */
    point?: BoardPoint;
    /** 이름으로 부르는 이동 — 말로 지시하는 쪽(LLM)이 쓴다 */
    move?: { lane?: "left" | "center" | "right"; band?: "defense" | "midfield" | "attack" };
  },
): SkillResult {
  const player = userPlayerById(state, input.playerId);
  if (!player) return { ok: false, message: `"${input.playerId}"는 우리 팀 선수가 아닙니다` };
  const named = input.move && (input.move.lane || input.move.band) ? input.move : undefined;
  if (!input.position && !input.point && !named) {
    return { ok: false, message: "옮길 자리(position)나 방향(move)이 필요합니다" };
  }
  const tactics = userTactics(state);
  const assignment = tactics.assignments.find((a) => a.playerId === player.id);
  if (!assignment || assignment.role !== "starting") {
    return {
      ok: false,
      message: `${player.name}은(는) 지금 그라운드에 없습니다 — 교체(substitute)로 넣어야 합니다`,
    };
  }
  const from = assignment.point ?? anchorOf(assignment.position);
  // 지정하지 않은 축은 지금 자리를 그대로 쓴다 — "왼쪽으로"는 앞뒤를 안 건드린다
  const point = named
    ? movePoint(from, named)
    : input.point
      ? clampToBoard(input.point)
      : anchorOf(input.position!);
  const code = input.position && !named ? input.position.toUpperCase() : positionAtPoint(point);
  if (!positionGroupOf(code)) {
    return { ok: false, message: `알 수 없는 포지션: ${input.position}` };
  }
  const currentPoint = from;
  if (assignment.position === code && currentPoint.x === point.x && currentPoint.y === point.y) {
    return { ok: false, message: `${player.name}은(는) 이미 ${code}입니다` };
  }
  const before = assignment.position;
  if (
    assignment.position !== code &&
    assignment.roleId &&
    !rolesFor(code).some((role) => role.id === assignment.roleId)
  ) {
    delete assignment.roleId;
  }
  assignment.position = code;
  assignment.point = point;
  tactics.spec.formation = shapeOf(
    tactics.assignments
      .filter((a) => a.role === "starting")
      .map((a) => a.point ?? anchorOf(a.position)),
  ) as TacticsSpec["formation"];
  const fit = player.positions.find((p) => p.position === code)?.proficiency ?? null;
  return {
    ok: true,
    message:
      `${player.name} ${before} → ${code}` +
      (fit === null ? " (해 본 적 없는 자리입니다)" : ` (자리 적응도 ${fit})`),
  };
}

/**
 * 개인 훈련 — **팀 훈련 위에 한 선수만 겨냥해 얹는다.**
 *
 * 축(`axis`)은 훈련 결산(LLM)의 입력이 되고, 자리(`position`)는 코어가
 * 결정적으로 적응도를 올린다 — **실전보다 느리게**(경기 1회 = +1, 훈련
 * `POSITION_TRAINING_SESSIONS`일 = +1). "자리는 커리어가 만든다"를 지키되
 * 전향이라는 판단이 가능해진다.
 */
export function setPlayerTraining(
  state: GameState,
  input: { playerId: string; axis?: string; position?: string; clear?: boolean },
): SkillResult {
  const player = userPlayerById(state, input.playerId);
  if (!player) return { ok: false, message: `"${input.playerId}"는 우리 팀 선수가 아닙니다` };
  const index = state.playerTraining.findIndex((t) => t.gamePlayerId === player.id);

  if (input.clear || (!input.axis && !input.position)) {
    if (index < 0) return { ok: false, message: `${player.name}에게 걸린 개인 훈련이 없습니다` };
    state.playerTraining.splice(index, 1);
    return { ok: true, message: `${player.name}의 개인 훈련을 거뒀습니다` };
  }

  const axis = input.axis?.trim();
  if (axis && !ATTRIBUTE_AXES.includes(axis as (typeof ATTRIBUTE_AXES)[number])) {
    return { ok: false, message: `알 수 없는 능력치 축: ${axis}` };
  }
  const position = input.position?.toUpperCase();
  if (position && !positionGroupOf(position)) {
    return { ok: false, message: `알 수 없는 포지션: ${input.position}` };
  }

  const program = {
    gamePlayerId: player.id,
    ...(axis ? { axis } : {}),
    ...(position ? { position } : {}),
    since: state.date,
    sessions: 0,
  };
  if (index >= 0) state.playerTraining[index] = program;
  else state.playerTraining.push(program);

  const parts: string[] = [];
  if (axis) parts.push(AXIS_KO[axis as (typeof ATTRIBUTE_AXES)[number]]);
  if (position) {
    const fit = player.positions.find((p) => p.position === position)?.proficiency ?? 0;
    parts.push(`${position} 전향 (지금 적응도 ${fit})`);
  }
  return { ok: true, message: `${player.name} 개인 훈련 — ${parts.join(" · ")}` };
}

/**
 * 주 포지션 변경 — PLAYER_POSITION의 isNatural을 옮긴다. 새 포지션이 목록에
 * 없으면 낮은 적응도로 추가한다(생소한 자리에서 시작). 주 포지션 그룹이 바뀌면
 * overall 공식도 바뀌므로 재산정한다.
 */
/**
 * 이 선수가 그 자리에서 맡을 **세부 역할**을 정한다 (볼 플레잉 디펜더, 레지스타…).
 *
 * 역할은 자리 위에 얹히는 축이다 — 같은 센터백이라도 노넌센스와 볼 플레잉은 요구
 * 역량이 다르고, 그 차이는 `roleFit`이 낸다. 그 자리에 없는 역할은 받지 않는다.
 */
/** 역할 거리 1당 적응도 손실 — 슬라이더 한 칸(1.5~4)과 같은 눈금에 놓는다 (초안) */
const ROLE_CHANGE_LOSS = 0.6;

export function setPlayerRole(
  state: GameState,
  input: { playerId: string; role: string },
): SkillResult {
  const player = userPlayerById(state, input.playerId);
  if (!player) return { ok: false, message: `"${input.playerId}"는 우리 팀 선수가 아닙니다` };
  const tactics = userTactics(state);
  const assignment = tactics.assignments.find((a) => a.playerId === player.id);
  if (!assignment) {
    return { ok: false, message: `${player.name}은 배치가 없습니다 — 먼저 선발·벤치에 넣으세요` };
  }
  const options = rolesFor(assignment.position);
  const def = options.find((r) => r.id === input.role || r.abbr === input.role);
  if (!def) {
    return {
      ok: false,
      message: `${assignment.position}에 없는 역할입니다 — ${options.map((r) => `${r.ko}(${r.id})`).join(" / ")}`,
    };
  }
  const from = assignment.roleId ?? defaultRoleOf(assignment.position);
  if (from === def.id) {
    return { ok: true, message: `${player.name}은 이미 ${def.ko}입니다` };
  }

  /**
   * 역할을 바꾸면 **그 선수의 전술 적응도가 깎인다** — 자리는 그대로여도 하는 일이
   * 달라지기 때문이다. 대가는 하드코딩하지 않고 **역할 델타의 거리**에서 뽑는다
   * (`roleDistance`): 볼 플레잉 → 리베로는 둘 다 발로 푸는 수비수라 싸고,
   * 볼 플레잉 → 노넌센스는 요구가 정반대라 비싸다.
   *
   * 팀 전체가 아니라 **그 선수만** 깎인다. 옆 사람의 역할이 바뀌었다고 내 적응도가
   * 떨어질 이유가 없다 (전술 6축을 바꿀 때와 다른 점이다).
   */
  /**
   * ⚠️ **고르는 동안은 벌하지 않는다.** 감독은 알약을 눌러 보며 정하는데,
   * 누를 때마다 매기면 결정 하나에 값을 여러 번 치른다 — 아직 그 역할로 훈련도
   * 경기도 하지 않았는데. 기준은 **그날 아침의 역할**이고, 이미 낸 만큼과의
   * 차액만 가감한다(`roleMemo`). 되돌아오면 복구되고, 그 사이 훈련으로 오른
   * 값은 남는다. 하루가 지나면 기준이 새로 잡힌다 — 몸에 밴 것이기 때문이다.
   */
  const memo =
    assignment.roleMemo?.date === state.date
      ? assignment.roleMemo
      : { date: state.date, role: from, paid: 0 };
  const cost = Math.round(roleDistance(assignment.position, memo.role, def.id) * ROLE_CHANGE_LOSS);
  const before = assignment.familiarity;
  assignment.roleId = def.id;
  // 오늘 이미 낸 것과의 차액만 — 왔다 갔다 해도 누적되지 않는다
  assignment.familiarity = clampFamiliarity(before - (cost - memo.paid));
  assignment.roleMemo = { ...memo, paid: cost };

  const moved = Math.round(before) - Math.round(assignment.familiarity);
  return {
    ok: true,
    message:
      `${player.name} ${assignment.position} 역할 → ${def.ko}` +
      (moved > 0
        ? ` (전술 적응도 −${moved} — 하는 일이 달라진다)`
        : moved < 0
          ? ` (전술 적응도 +${-moved} — 원래 하던 일로 돌아왔다)`
          : ""),
  };
}

export function setPlayerPosition(
  state: GameState,
  input: { playerId: string; position: string },
): SkillResult {
  const player = userPlayerById(state, input.playerId);
  if (!player) return { ok: false, message: `"${input.playerId}"는 우리 팀 선수가 아닙니다` };
  const code = input.position.toUpperCase();
  if (!positionGroupOf(code)) {
    return {
      ok: false,
      message: `알 수 없는 포지션: ${input.position} (${POSITION_CODES.join("/")})`,
    };
  }
  for (const p of player.positions) p.isNatural = false;
  const existing = player.positions.find((p) => p.position === code);
  if (existing) {
    existing.isNatural = true;
  } else {
    // 처음 맡는 자리 — 인접도 기반 초기 적응도로 시작한다
    player.positions.push({
      position: code,
      proficiency: proficiencyAt(player, code),
      isNatural: true,
    });
  }
  recomputeOverall(player);
  return {
    ok: true,
    message: `${player.name} 주 포지션 → ${code} (OVR ${player.attributes.overall})`,
  };
}

export function setCaptain(state: GameState, playerId: string): SkillResult {
  const player = userPlayerById(state, playerId);
  if (!player) return { ok: false, message: `"${playerId}"는 우리 팀 선수가 아닙니다` };
  // 팀당 1명 — 기존 주장 해제
  for (const p of userPlayers(state)) p.isCaptain = false;
  player.isCaptain = true;
  player.state.condition = clampCondition(player.state.condition + 4);
  // 새 영입에게 완장을 채우는 건 라커룸 한가운데 세우는 일이다 (settling.ts)
  const settled = creditSettling(state, player.id, "captain") > 0;
  return {
    ok: true,
    message:
      `${player.name}을(를) 주장으로 지명했습니다` +
      (settled ? " — 새 영입에게는 라커룸의 자리를 준 셈입니다" : ""),
  };
}

// ── 전술 적응도 (docs/data/player.md) ──────
//
// 적응도는 "이 전술을 팀이 얼마나 손에 익혔나"다. 세 가지가 이 값을 움직인다:
//   ① 시간 — 같은 전술을 유지하면 매일 조금씩 몸에 붙는다 (훈련·경기는 더 크게)
//   ② 기억 — 드릴해 둔 전술로 되돌아가면 그때의 숙련도를 되찾는다
//   ③ 전이 — 처음 쓰는 전술도 비슷한 전술을 익혔다면 그만큼 덜 낯설다
// 예전 모델은 ②③이 없어 바꿀 때마다 일방적으로 깎였고, 되돌려도 또 깎였다.

/** 기억해 두는 전술 수 — 최근 것 위주로 (세이브 비대화 방지) */
const DRILLED_LIMIT = 8;

/** 지금 전술의 선발 평균 적응도 — 기억에 적어 둘 값 */
function currentFamiliarity(tactics: TeamTactics): number {
  const starters = tactics.assignments.filter((a) => a.role === "starting");
  if (starters.length === 0) return FAMILIARITY_BASELINE;
  return Math.round(starters.reduce((s, a) => s + a.familiarity, 0) / starters.length);
}

/**
 * 하루가 지나면 지금 숙련도를 기억에 적어 둔다.
 *
 * ⚠️ **시간만으로는 적응도가 오르지 않는다.** 예전엔 매일 +1씩 붙였는데(상한 80),
 * 그러면 아무것도 안 해도 전술이 몸에 붙는다 — 훈련장에서 시간을 쓰는 선택과
 * 달력을 넘기는 선택이 같아진다. 이제 적응도는 **훈련과 실전에서만** 온다.
 *
 * 기억 갱신은 남는다 — 나중에 다른 전술을 거쳐 되돌아와도 쌓아 둔 값을 되찾는
 * 통로가 이것이다.
 */
export function settleTactics(state: GameState, on: string): void {
  rememberTactics(userTactics(state), on);
}

/** 현재 전술의 숙련도를 기억에 적어 둔다 (같은 지문이면 갱신) */
export function rememberTactics(tactics: TeamTactics, on: string): void {
  /**
   * **기억은 선수마다 따로다.** 팀 평균 한 숫자로 적던 때는 개인 보정이 평균을
   * 벗어나면 그 값이 기억돼 왕복마다 적응도가 불어났다. 각자 자기가 도달한 값을
   * 적으면 되돌아왔을 때 **자기 값**을 되찾으므로 그 문제가 원천적으로 없다.
   *
   * 개인 기억이 없는 옛 세이브는 팀 기억을 출발점으로 승계한다.
   */
  for (const a of tactics.assignments) {
    a.drilled = withCurrentDrilled(
      a.drilled ?? tactics.drilled,
      tactics.spec,
      a.familiarity,
      on,
    ).slice(0, DRILLED_LIMIT);
  }
}

/**
 * 전술 이해가 빠른 선수 — **시야·위치선정·침착성**이 새 지시를 덜 흔든다.
 *
 * 세 축을 고른 이유: 시야는 그림을 그리는 힘, 위치선정은 그 그림에서 제 자리를 찾는
 * 힘, 침착성은 익숙지 않은 상황에서도 판단이 무너지지 않는 힘이다. 셋 다
 * **판단 계열**이라 스카우팅으로도 오차가 남는 축이고(attribute-model.md),
 * 그래서 "왜 쟤만 못 따라오지"가 감독에게 흥미로운 질문이 된다.
 */
export function tacticalUptake(player: Player): number {
  return uptakeOf(player.attributes);
}

/** 변화 폭의 개인 배수 — 40이면 1.4배 흔들리고, 90이면 0.6배만 흔들린다 */
function shiftFactor(player: Player | null): number {
  if (!player) return 1;
  return Math.max(0.6, Math.min(1.4, 1.4 - (tacticalUptake(player) - 40) * 0.016));
}

/**
 * ⚠️ 적합도를 **점수로 환산해 더하던 계수는 없앴다** (`DIRECTION_WEIGHT`·
 * `TRANSFER_LOSS`). 이제 적합도는 `personalDistance`에서 **거리를 늘리거나 줄이는
 * 비율**로 들어간다 — 더하기로 얹으면 도착 수준이 기억과 어긋나 왕복이 샌다.
 */

/**
 * 경기 중 전술 변경이 치르는 적응도 대가의 비율 — 훈련장에서 바꿀 때의 몇 배인가.
 * ⚠️ 밸런스 값 (아래 시뮬레이션으로 잡았다 — balance.md).
 */
const IN_MATCH_FAMILIARITY_LOSS = 0.25;

/**
 * 팀 수준의 변화량을 배치된 선수들에게 나눠 얹는다 — **두 가지가 갈린다**.
 *
 * ① **얼마나 흔들리나** (`shiftFactor`) — 전술을 잘 읽는 선수는 덜 흔들린다.
 * ② **어느 쪽으로 갔나** (`tacticsAffinityShift`) — 킥이 좋은 선수에게 "더 길게
 *    가자"는 익숙한 축구다. 자기 축구에 가까워졌으면 덜 잃고, 잘하면 **오른다**.
 *
 * 둘 다 **선발 평균 기준으로 정규화**한다. 안 그러면 팀 적응도(선발 평균)가
 * `familiarityForSetup`이 계산한 값에서 어긋나고, 전술을 왔다 갔다 하면 그 오차가
 * 쌓여 되돌아와도 제 수준을 못 찾는다. 정규화하면 **팀이 내는 값은 그대로고 누가
 * 그 대가를 치르는지만 갈린다** — 팀 전체가 롱볼에 능하면 그건 축의 비용
 * (`tacticsDistance`)이 아니라 시뮬의 이득으로 돌아온다.
 */
/**
 * 적합도가 거리를 줄이는 한계 — **1을 넘는다.**
 *
 * 1을 넘어야 거리가 **음수**가 되고, 그래야 "그 방향이 내 축구라 기억보다도
 * 편해졌다"가 성립한다. 1로 막으면 잘 맞아 봐야 손실이 0이다.
 */
const AFFINITY_EASE_MAX = 1.6;
/** 안 맞는 방향이면 거리가 이만큼까지 늘어난다 */
const AFFINITY_EASE_MIN = -1.6;
/**
 * 적합도 비율에 곱하는 배율.
 *
 * `affinityShift / base`는 구조상 −1~1이라(축별 쏠림의 가중 평균) 그대로 쓰면
 * 아무리 잘 맞아도 거리가 0까지밖에 안 줄어든다 — **오르는 일이 영영 없다.**
 */
const AFFINITY_PULL = 1.4;

/**
 * **이 선수에게 이 변경이 얼마나 먼가** — 전이 손실을 재는 개인의 자.
 *
 * 팀 눈금의 거리(`tacticsDistance`)에 그 선수의 사정을 곱한다. 보정을 결과에
 * **더하지 않고 거리에 넣는** 것이 요점이다: 더하면 도착 수준이 기억과 어긋나
 * 왕복이 새지만, 거리에 넣으면 되돌아올 때 기억이 그대로 복원돼 정확히 닫힌다.
 */
function personalDistance(player: Player | null, from: TacticsSpec, to: TacticsSpec): number {
  const base = tacticsDistance(from, to);
  if (base <= 0) return 0;
  const uptake = shiftFactor(player);
  const ease = player
    ? Math.max(
        AFFINITY_EASE_MIN,
        Math.min(
          AFFINITY_EASE_MAX,
          (tacticsAffinityShift(player.attributes, from, to) / base) * AFFINITY_PULL,
        ),
      )
    : 0;
  // 음수까지 허용한다 — 자기 축구로 가는 변경은 기억보다 나은 자리일 수 있다
  return base * uptake * (1 - ease);
}

/**
 * **기억을 붙잡는 힘** — 1이 기준, 클수록 오래 간다.
 *
 * 습득과 같은 축(`tacticalUptake` — 시야·위치선정·침착성)을 쓴다. 그림을 빨리
 * 그리는 선수가 그 그림을 오래 갖고 있는 게 자연스럽고, 축을 새로 만들면 "왜
 * 쟤만 못 따라오지"라는 질문이 둘로 갈려 흐려진다.
 *
 * 이해 40이면 주기가 0.7배(열흘이면 흐릿해진다), 90이면 1.3배(석 달을 안 써도
 * 남아 있다). 습득이 빠른 선수가 잊기도 빨랐다면 두 효과가 상쇄돼 개인차가
 * 사라진다 — 같은 방향으로 걸어야 "전술을 아는 선수"라는 상이 선다.
 */
export function memoryRetention(player: Player | null): number {
  if (!player) return 1;
  return Math.max(0.7, Math.min(1.5, 0.7 + (tacticalUptake(player) - 40) * 0.012));
}

/**
 * **새 영입은 기억을 갖고 온다** — 직전 소속 팀의 전술과 그 팀이 익힌 수준.
 *
 * 처음엔 이걸 거리 보정으로 넣었다("아는 축구면 덜 낯설다"). 그러면 손실이 0까지
 * 줄 뿐 **오르지는 못한다** — 곱셈이라 아무리 가까워도 기억 위로 올라갈 길이 없다.
 * 그런데 사실은 단순하다: 첼시에서 온 선수는 **첼시 축구를 이미 안다.** 그건
 * 보정이 아니라 **기억**이고, 우리가 그 전술로 바꾸면 그는 그 값을 되찾는다.
 *
 * 정착이 끝나면 더는 얹지 않는다 — 그때쯤이면 자기 기억이 쌓여 있고, 우리 축구가
 * 그의 축구가 된다 (settling.ts).
 */
function memoriesOf(
  state: GameState,
  assignment: TacticAssignment,
  tactics: TeamTactics,
): readonly DrilledTactics[] {
  const own = assignment.drilled ?? tactics.drilled ?? [];
  const settling = settlingOf(state, assignment.playerId);
  if (!settling || settling.done) return own;
  const from = state.transfers.find(
    (t) =>
      t.gamePlayerId === assignment.playerId &&
      t.date === settling.joinedOn &&
      t.fromTeamId !== null,
  )?.fromTeamId;
  if (!from) return own;
  const theirs = state.tactics.find((t) => t.teamId === from);
  if (!theirs) return own;
  const signature = tacticsSignature(theirs.spec);
  if (own.some((d) => d.signature === signature)) return own;
  return [
    ...own,
    {
      signature,
      // 그 팀이 그 전술을 익힌 수준 — 그가 몸으로 겪은 값이다
      familiarity: currentFamiliarity(theirs),
      lastUsedOn: settling.joinedOn,
    },
  ];
}

/**
 * 전술이 바뀌면 **각자 자기 기억에서 새 수준을 찾는다.**
 *
 * 예전엔 팀 평균의 변화량을 개인에게 배분했다(정규화·재분배). 기억이 팀 값
 * 하나였기 때문인데, 그 구조가 "적응도는 남들보다 맞나"라는 상대 평가를 강요했다.
 * 이제 각자 자기 기억을 가지므로 **개인의 도착 수준을 직접** 구한다 — 팀 적응도는
 * 그 값들의 평균(파생)이고, 왕복은 기억이 닫는다.
 */
function retuneFamiliarity(
  state: GameState,
  tactics: TeamTactics,
  before: TacticsSpec,
  after: TacticsSpec,
  scale: number,
): void {
  for (const a of tactics.assignments) {
    const player = playerById(state, a.playerId);
    const arrival = familiarityForSetup(memoriesOf(state, a, tactics), after, state.date, {
      distanceOf: (memory, next) => personalDistance(player, memory, next),
      retention: memoryRetention(player),
    });
    void before;
    a.familiarity = clampFamiliarity(a.familiarity + (arrival - a.familiarity) * scale);
  }
}

export function setTactics(state: GameState, spec: Partial<TacticsSpec>): SkillResult {
  const tactics = userTactics(state);
  const { formation: _catalogPreset, ...axes } = spec;
  void _catalogPreset;
  const parsed = TacticsSpecSchema.safeParse({ ...tactics.spec, ...axes });
  if (!parsed.success) {
    return {
      ok: false,
      message: `전술 형식 오류: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
    };
  }
  const before = tactics.spec;
  const unchanged = tacticsSignature(before) === tacticsSignature(parsed.data);
  if (unchanged) {
    tactics.spec = parsed.data;
    return { ok: true, message: `전술 유지 — ${parsed.data.formation}` };
  }

  const wasAt = currentFamiliarity(tactics);
  // 떠나기 전에 각자 지금까지 쌓은 숙련도를 기억에 남긴다 (되돌아올 때 되찾는다)
  rememberTactics(tactics, state.date);
  tactics.spec = parsed.data;

  /**
   * 새 수준은 **선수마다 자기 기억에서** 나온다 — 되돌아온 전술이면 자기가 도달했던
   * 값을 그대로 되찾고(그래서 왕복은 정확히 닫힌다), 처음 쓰는 전술이면 가장 비슷한
   * 기억에서 **자기 자로 잰 거리**만큼 깎아 물려받는다(`personalDistance`).
   *
   * 팀 적응도는 이 값들의 평균(파생)이다 — 전원을 같은 값으로 덮지 않으므로
   * 개인차가 보존되고, 새 영입은 자기가 하던 축구 쪽 변경에서 덜 잃는다.
   */
  /**
   * **경기 중 조정은 새 전술을 배우는 것이 아니다.**
   *
   * 벤치에서 "라인 올려, 압박 세게"라고 외치는 것은 훈련장에서 시스템을 바꾸는
   * 일과 다르다. 선수들은 이미 아는 틀 안에서 무게중심만 옮기고, 그 경기가
   * 끝나면 원래 전술로 돌아간다(`restoreTactics`). 하락 폭을 그대로 물리면
   * 소화율까지 떨어져 **어떤 경기 중 지시도 손해**가 되고, 감독이 벤치에서 할
   * 수 있는 일이 교체뿐인 게임이 된다.
   *
   * 그래도 0은 아니다 — 갑자기 바뀐 지시를 못 따라가는 선수는 늘 있고,
   * 좌표·역할 변경은 각 배치와 역할 적합도 경로에서 별도로 값을 치른다.
   */
  const inMatch = state.phase === "match";
  retuneFamiliarity(state, tactics, before, parsed.data, inMatch ? IN_MATCH_FAMILIARITY_LOSS : 1);

  // 감독에게 보이는 건 팀 눈금이다 — 개인값의 평균(파생)
  const now = currentFamiliarity(tactics);
  const delta = now - wasAt;
  const note =
    delta < 0
      ? ` · 전술 적응도 ${now} (${delta}, 재적응 필요)`
      : delta > 0
        ? ` · 전술 적응도 ${now} (+${delta}, 익혀 둔 전술)`
        : ` · 전술 적응도 ${now} (그대로)`;
  return {
    ok: true,
    message: `전술 변경 — ${parsed.data.formation}, 멘탈리티 ${parsed.data.mentality}${note}`,
  };
}

/**
 * 개인 지시 — 자연어(`note`)는 서사로, 구조화된 `directive`는 장부로 간다.
 *
 * 코어가 하는 일은 **사실 확인**뿐이다: 우리 선수인가, 배치돼 있는가, 겨냥한
 * 상대가 실재하는가. 얼마나 먹히는지는 시뮬이 정하고(`applyDirectives`), 무슨
 * 말을 어떤 지시로 옮길지는 LLM이 정한다 — 이적 설득과 같은 분업이다.
 */
export function setPlayerInstruction(
  state: GameState,
  input: { playerId: string; note: string; kind?: PlayerDirectiveKind; targetId?: string },
): SkillResult {
  const player = userPlayerById(state, input.playerId);
  if (!player) return { ok: false, message: `"${input.playerId}"는 우리 팀 선수가 아닙니다` };
  const assignment = userTactics(state).assignments.find((a) => a.playerId === input.playerId);
  if (!assignment) {
    return { ok: false, message: `${player.name}은(는) 현재 전술에 배치되어 있지 않습니다` };
  }

  let targetNote = "";
  if (input.kind) {
    const needsTarget = input.kind === "man_mark" || input.kind === "press_target";
    if (needsTarget) {
      const target = input.targetId ? playerById(state, input.targetId) : null;
      if (!target) {
        return {
          ok: false,
          message: `${PLAYER_DIRECTIVE_KO[input.kind]}는 겨냥할 상대 선수가 필요합니다 — targetId를 주세요`,
        };
      }
      if (target.teamId === state.userTeamId) {
        return { ok: false, message: `${target.name}은(는) 우리 선수입니다 — 상대를 겨냥하세요` };
      }
      targetNote = ` → ${target.name}`;
    }
    assignment.directive = {
      kind: input.kind,
      ...(needsTarget && input.targetId ? { targetId: input.targetId } : {}),
    };
  }

  assignment.instruction = input.note;
  if (!input.kind) {
    /**
     * **`kind` 없는 지시는 판에 닿지 않는다** — 그러면 그렇다고 말해야 한다.
     *
     * 시뮬로 가는 것은 `directive.kind`뿐이고(`match-flow.ts`의 `directivesOnPitch`)
     * `instruction`은 화면과 스냅샷에만 남는다. 예전엔 이 갈래도 그냥 성공으로
     * 답해서, GM이 "지시가 먹혔다"로 서사를 쓰고 판은 아무것도 안 하는 **거짓
     * 성공**이 됐다. 감독이 원인을 알 수 없는 종류의 어긋남이다.
     */
    return {
      ok: true,
      message:
        `${player.name}에게 "${input.note}" — 말로 전했습니다. ` +
        `이 지시는 판에 반영되지 않습니다: 판을 움직이려면 kind를 함께 보내세요 ` +
        `(${Object.values(PLAYER_DIRECTIVE_KO).join(" · ")}). ` +
        `자리를 옮기는 지시라면 move, 지역을 겨냥한 지시라면 set_match_plan입니다`,
    };
  }
  return {
    ok: true,
    message: `${player.name} 개인 지시 — "${input.note}" [${PLAYER_DIRECTIVE_KO[input.kind]}${targetNote}]`,
  };
}

// ---- 훈련: 스킬이 일정 엔트리를 직접 생성한다 (규칙 테이블 없음) ----

const TRAIN_ATTRS: TrainAttr[] = [...ATTRIBUTE_AXES, "tactical", "recovery"];
const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];
const TRAIN_ATTR_KO: Record<string, string> = {
  ...AXIS_KO,
  tactical: "전술",
  recovery: "회복",
};

export interface TrainingPlanInput {
  /** 특정 날짜 세션 */
  sessions?: Array<{ date: string; slot: Slot; label: string; focus: TrainAttr[] }>;
  /** 요일 반복 — 지정 주 수만큼 엔트리를 펼쳐서 만든다 (기본 6주) */
  repeatWeekly?: Array<{ dow: number; slot: Slot; label: string; focus: TrainAttr[] }>;
  /** 반복 생성 주 수 (기본 6) */
  weeks?: number;
  /** 미래 훈련 비우기 — 날짜/요일 지정 시 그 대상만, 없으면 전부 */
  clear?: { from?: string; to?: string; dow?: number; slot?: Slot; rest?: boolean } | true;
  /**
   * **휴가를 접고 선수단을 조기 소집한다.** 감독이 명시적으로 그러겠다고 했을 때만.
   * 소집일 자체가 앞당겨지고, 선수단은 체력을 잃고 일부는 불만을 품는다.
   */
  recallSquad?: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validFocus(focus: TrainAttr[]): string | null {
  for (const f of focus) {
    if (!TRAIN_ATTRS.includes(f)) return `훈련 focus가 잘못됨: ${f} (${TRAIN_ATTRS.join("/")})`;
  }
  return null;
}

function focusKo(focus: TrainAttr[]): string {
  return focus.length > 0 ? `(${focus.map((f) => TRAIN_ATTR_KO[f] ?? f).join("·")})` : "";
}

/** 미래(오늘 포함) 예정 훈련 엔트리만 조작 대상 — 지난 훈련은 이력이다 */
function futureTraining(state: GameState): ScheduleEntry[] {
  return state.schedule.filter(
    (e) => e.type === "training" && e.status === "scheduled" && e.date >= state.date,
  );
}

function addTrainingEntry(
  state: GameState,
  date: string,
  slot: Slot,
  label: string,
  focus: TrainAttr[],
): void {
  const time = SLOT_TIME[slot];
  // 같은 날 같은 슬롯은 덮어쓴다
  const dupes = new Set(
    state.schedule
      .filter(
        (e) =>
          e.type === "training" && e.date === date && e.time === time && e.status === "scheduled",
      )
      .map((e) => e.refId),
  );
  state.schedule = state.schedule.filter(
    (e) =>
      !(e.type === "training" && e.date === date && e.time === time && e.status === "scheduled"),
  );
  state.trainingSessions = state.trainingSessions.filter((s) => !dupes.has(s.id));

  const sessionId = `ts-${date}-${slot}`;
  state.trainingSessions.push({ id: sessionId, label, focus: [...focus] });
  state.schedule.push({
    id: `se-${sessionId}`,
    date,
    time,
    type: "training",
    refId: sessionId,
    teamId: state.userTeamId,
    status: "scheduled",
  });
}

/**
 * 훈련 지정 — 자연어 label + focus(효과 대상). 특정 날짜(sessions) 또는
 * 요일 반복(repeatWeekly)으로 받고, 스킬이 그 즉시 SCHEDULE_ENTRY를 생성한다.
 * 반복은 규칙으로 남지 않고 실제 일정으로 펼쳐진다 (v6 — 일정이 단일 원본).
 */
/**
 * **휴가를 접고 선수단을 조기 소집한다** — 감독이 치를 값이 있는 선택.
 *
 * 코어는 길을 막지 않고 **대가를 물린다**. 무엇이 대가인가:
 *   ① 쉬지 못한 몸 — 당긴 날수만큼 체력이 깎인 채로 프리시즌을 시작한다
 *   ② 라커룸의 반발 — 일부 선수에게 불만이 남는다 (방치하면 매일 갉힌다)
 * 둘 다 감독이 **되돌릴 수 있는** 것이다 — 회복 훈련으로 몸을, 면담·팀토크로
 * 마음을 되찾는다. 그게 이 게임에서 강행이 "금지"가 아니라 "선택"인 이유다.
 *
 * 리더십이 반발의 크기를 정한다. 같은 통보라도 선수단이 믿는 감독이면 덜 흔들린다 —
 * 부임 첫 주에 휴가를 깨는 것과 3년 함께한 감독이 그러는 것은 다른 일이다.
 */
function recallSquadEarly(state: GameState, date: string): string {
  const was = squadReturnOf(state.calendar);
  const early = Math.max(1, diffDays(date, was));
  state.calendar.squadReturn = date;

  // 리더십이 높을수록 덜 흔들린다 (0.7~1.3의 역방향)
  const resistance = 2 - leadershipFactor(state);
  const drain = Math.round(early * 1.2 * resistance);
  const players = userPlayers(state).filter((p) => squadLevelOf(p) === "first");
  for (const p of players) {
    p.state.condition = clampCondition(p.state.condition - drain);
  }

  /**
   * 반발하는 선수 — 당긴 날수에 비례하되 스쿼드의 절반을 넘지 않는다.
   * 대상은 시드가 아니라 **가장 지친 선수부터**다. 쉬어야 할 사람이 먼저 화낸다.
   */
  const upset = Math.min(
    Math.floor(players.length / 2),
    Math.max(0, Math.round((early / 3) * resistance)),
  );
  const already = new Set(state.issues.map((i) => i.gamePlayerId));
  const angry = [...players]
    .sort((a, b) => a.state.condition - b.state.condition)
    .filter((p) => !already.has(p.id))
    .slice(0, upset);
  for (const p of angry) {
    state.issues.push({
      gamePlayerId: p.id,
      kind: "unhappy",
      note: "휴가를 반납하고 소집됐다",
      since: state.date,
    });
  }

  pushNarrative(state, `휴가를 접고 ${date}로 소집을 앞당겼다 — 선수단이 술렁인다`, 4);
  return (
    `소집을 ${early}일 앞당겼습니다 (${was} → ${date}) — 선수단 체력 −${drain}` +
    (angry.length > 0 ? `, ${angry.length}명이 불만을 품었습니다` : ", 큰 반발은 없었습니다")
  );
}

export function setTraining(state: GameState, input: TrainingPlanInput): SkillResult {
  const applied: string[] = [];

  /**
   * 1) 비우기 먼저 — "월요일 훈련 다 지우고 새로" 같은 지시를 한 번에 처리.
   *
   * **`clearTraining`과 같은 규칙을 쓴다** — 예전엔 도구가 둘로 갈려 있어서
   * "쉬게 하자"와 "훈련 빼줘"가 서로 다른 코드로 처리됐고, 한쪽만 휴식 세션을
   * 남겼다(그래서 다음 tick이 기본 훈련을 도로 깔았다).
   */
  if (input.clear) {
    const opt = input.clear === true ? {} : input.clear;
    /**
     * 범위의 기본값이 다르다 — 여기 `clear`는 **그 뒤 전부**를 비우는 뜻이고
     * (`clear: true` = "당분간 훈련 없다"), 날짜를 콕 집는 쪽은 `to`를 준다.
     * 그대로 넘기면 하루만 지워져 "전부 비우기"가 조용히 하루짜리가 된다.
     */
    const cleared = clearTraining(state, { ...opt, to: opt.to ?? addDays(state.date, 400) });
    if (!cleared.ok) return cleared;
    applied.push(cleared.message);
  }

  /**
   * **여름 휴가엔 훈련이 없다 — 감독이 소집을 앞당기지 않는 한.**
   *
   * 소집일 전까지 선수단은 구단에 없다. 실수로 그 자리에 세션이 깔리는 것은
   * 막아야 하지만(부임 첫날 "월·수·금 훈련"이 그대로 통과하던 문제), **막는 것과
   * 못 하게 하는 것은 다르다.** 휴가를 깨고 부르는 것은 실제 감독이 할 수 있는
   * 일이고, 대가는 선수단의 반발이다 — 코어는 가능하게 하고 값을 물린다
   * (이적 설득과 같은 태도: 확률이 낮다고 길을 막지 않는다).
   *
   * 그래서 `recallSquad` 없이는 거부하고, 있으면 소집일 자체를 앞당긴다.
   */
  const squadReturn = squadReturnOf(state.calendar);
  const wanted = [
    ...(input.sessions ?? []).map((x) => x.date),
    ...((input.repeatWeekly ?? []).length > 0 ? [state.date] : []),
  ].filter((d) => DATE_RE.test(d));
  const earliest = wanted.sort()[0];

  if (input.recallSquad && earliest !== undefined && earliest < squadReturn) {
    const recall = recallSquadEarly(state, earliest);
    applied.push(recall);
  }
  const effectiveReturn = squadReturnOf(state.calendar);

  // 2) 특정 날짜 세션
  for (const s of input.sessions ?? []) {
    if (!DATE_RE.test(s.date)) return { ok: false, message: `날짜 형식이 잘못됨: ${s.date}` };
    if (!s.label?.trim()) return { ok: false, message: "훈련 설명(label)이 필요합니다" };
    const err = validFocus(s.focus);
    if (err) return { ok: false, message: err };
    if (s.date < effectiveReturn) {
      return {
        ok: false,
        message:
          `${s.date}은 선수단 여름 휴가 기간입니다 — 훈련은 소집일(${effectiveReturn})부터 잡을 수 있습니다. ` +
          `감독이 휴가를 접고 조기 소집하겠다고 했다면 recallSquad를 함께 보내세요 (선수단이 반발합니다).`,
      };
    }
    addTrainingEntry(state, s.date, s.slot, s.label.trim(), s.focus);
    applied.push(`${s.date} ${s.slot === "am" ? "오전" : "오후"}=${s.label}${focusKo(s.focus)}`);
  }

  // 3) 요일 반복 — 오늘부터 weeks주만큼 엔트리를 펼친다
  const weeks = Math.max(1, Math.min(20, input.weeks ?? 6));
  for (const r of input.repeatWeekly ?? []) {
    if (!Number.isInteger(r.dow) || r.dow < 0 || r.dow > 6) {
      return { ok: false, message: `요일이 잘못됨: ${r.dow} (0~6)` };
    }
    if (!r.label?.trim()) return { ok: false, message: "훈련 설명(label)이 필요합니다" };
    const err = validFocus(r.focus);
    if (err) return { ok: false, message: err };
    let made = 0;
    let skipped = 0;
    // 휴가 중이면 소집일부터 센다 — "3주간 반복"은 훈련할 수 있는 3주를 뜻한다
    const from = state.date < effectiveReturn ? effectiveReturn : state.date;
    if (state.date < effectiveReturn) skipped = diffDays(state.date, effectiveReturn);
    for (let d = 0; d < weeks * 7 && made < weeks; d++) {
      const date = addDays(from, d);
      if (new Date(`${date}T00:00:00Z`).getUTCDay() !== r.dow) continue;
      addTrainingEntry(state, date, r.slot, r.label.trim(), r.focus);
      made++;
    }
    applied.push(
      `매주 ${WEEKDAY_KO[r.dow]}요일 ${r.slot === "am" ? "오전" : "오후"}=${r.label}${focusKo(r.focus)} × ${made}주` +
        (skipped > 0 ? ` (휴가 ${skipped}일을 건너뛰고 ${from}부터)` : ""),
    );
  }

  state.schedule = sortEntries(state.schedule);
  return {
    ok: true,
    message: applied.length > 0 ? `훈련 지정 — ${applied.join(", ")}` : "변경할 훈련이 없습니다",
  };
}

/**
 * 훈련 비우기 — **"이 날은 쉬자"를 상태로 남긴다.**
 *
 * 지우기만 해서는 지시가 하루도 못 간다: 휴식은 원래 엔트리 부재로 표현되므로
 * (기본 훈련의 MD+2·주말) 비운 자리를 `syncDefaultTraining`이 "아직 안 깐 날"로
 * 읽고 다음 tick에 기본 훈련을 도로 깐다. 그래서 기본값은 **휴식 세션을 남기는
 * 것**이고(`rest`), 그 자리는 기본 배치가 못 들어오는 자리가 된다.
 *
 * `rest: false`는 뜻이 다르다 — "내가 잡은 훈련 취소하고 원래대로"다. 자리를
 * 비우기만 하므로 기본 훈련이 제자리로 돌아온다.
 *
 * 범위는 **좁은 쪽이 기본**이다: `to`를 안 주면 `from` 하루만, `from`도 안 주면
 * 오늘 하루. 훈련 일정은 시즌 전체가 깔려 있어서, 기본이 넓으면 "내일 쉬자"
 * 한마디에 시즌이 통째로 비워진다.
 */
export interface ClearTrainingInput {
  /** 시작일 (기본 오늘) */
  from?: string;
  /** 종료일 (기본 from과 같은 날 — 하루만) */
  to?: string;
  /** 이 요일만 (0=일 ~ 6=토) */
  dow?: number;
  /** 이 슬롯만 — 없으면 그날 전부 */
  slot?: Slot;
  /** 쉬는 날로 못 박을 것인가 (기본 true). false면 기본 훈련이 다시 들어온다 */
  rest?: boolean;
}

export function clearTraining(state: GameState, input: ClearTrainingInput): SkillResult {
  const from = input.from ?? state.date;
  const to = input.to ?? from;
  if (!DATE_RE.test(from)) return { ok: false, message: `날짜 형식이 잘못됨: ${from}` };
  if (!DATE_RE.test(to)) return { ok: false, message: `날짜 형식이 잘못됨: ${to}` };
  if (to < from) return { ok: false, message: `종료일이 시작일보다 빠릅니다: ${from} ~ ${to}` };
  if (input.dow !== undefined && (!Number.isInteger(input.dow) || input.dow < 0 || input.dow > 6)) {
    return { ok: false, message: `요일이 잘못됨: ${input.dow} (0~6)` };
  }
  // 지난 훈련은 이력이라 건드리지 않는다 — 오늘 이전은 조용히 잘라낸다
  const start = from < state.date ? state.date : from;
  const asRest = input.rest !== false;

  const targets = futureTraining(state).filter((e) => {
    if (e.date < start || e.date > to) return false;
    if (input.dow !== undefined && new Date(`${e.date}T00:00:00Z`).getUTCDay() !== input.dow) {
      return false;
    }
    if (input.slot !== undefined && e.time !== SLOT_TIME[input.slot]) return false;
    return true;
  });

  const ids = new Set(targets.map((e) => e.refId));
  const removed = new Set(targets);
  state.schedule = state.schedule.filter((e) => !removed.has(e));
  state.trainingSessions = state.trainingSessions.filter((s) => !ids.has(s.id));

  /**
   * 휴식 표식은 **비운 자리마다** 세운다. 원래 훈련이 없던 날(주말·MD+2)에는
   * 세우지 않는다 — 이미 쉬는 날이라 표식이 없어도 기본 배치가 안 들어온다.
   */
  const days = new Set<string>();
  if (asRest) {
    for (const e of targets) {
      const sessionId = `ts-rest-${e.date}-${slotOfTime(e.time)}`;
      state.trainingSessions.push({ id: sessionId, label: "휴식", focus: [], rest: true });
      state.schedule.push({
        id: `se-${sessionId}`,
        date: e.date,
        time: e.time,
        type: "training",
        refId: sessionId,
        teamId: state.userTeamId,
        status: "scheduled",
      });
      days.add(e.date);
    }
  }

  state.schedule = sortEntries(state.schedule);
  if (targets.length === 0) {
    return { ok: true, message: "그 기간에 예정된 훈련이 없습니다" };
  }
  const span = start === to ? start : `${start}~${to}`;
  return {
    ok: true,
    message: asRest
      ? `${span} 훈련 ${targets.length}건을 휴식으로 (${days.size}일)`
      : `${span} 훈련 ${targets.length}건 취소 — 기본 훈련이 다시 편성됩니다`,
  };
}

// ---- 창발 보조: 서사 이벤트 (GM 전용, 능력치 접근 불가 — overview §7) ----

const NARRATIVE_EVENT_MARKER = "[서사]";
const MAX_NARRATIVE_EVENTS_PER_DAY = 3;

export function applyNarrativeEvent(
  state: GameState,
  input: { playerIds: string[]; conditionDelta?: number; formDelta?: number; note: string },
): SkillResult {
  const todayCount = state.narrative.filter(
    (n) => n.date === state.date && n.text.startsWith(NARRATIVE_EVENT_MARKER),
  ).length;
  if (todayCount >= MAX_NARRATIVE_EVENTS_PER_DAY) {
    return {
      ok: false,
      message: `오늘의 서사 이벤트 한도(${MAX_NARRATIVE_EVENTS_PER_DAY}회)를 초과했습니다`,
    };
  }

  const condition = Math.max(-5, Math.min(5, Math.round(input.conditionDelta ?? 0)));
  /**
   * 서사 이벤트의 폼 변화 — 모델은 −1/0/+1의 **단계**로 말하고, 코어가 폼 축의
   * 폭으로 옮긴다. 폼은 −1~1이라 ±1을 그대로 더하면 한 장면이 선수를 곧바로
   * 절정·바닥에 꽂는다 (경기 한 판의 변화가 0.3 안팎이다).
   */
  const NARRATIVE_FORM_STEP = 0.12;
  const form = Math.max(-1, Math.min(1, Math.round(input.formDelta ?? 0))) * NARRATIVE_FORM_STEP;
  // 검증 먼저, 적용은 전원 유효할 때만 — 원자성 (장부 applyEvents와 동일 패턴)
  const resolved = input.playerIds.map((id) => ({ id, player: userPlayerById(state, id) }));
  const missing = resolved.filter((r) => !r.player);
  if (missing.length > 0) {
    return {
      ok: false,
      message: `우리 팀 선수가 아닙니다: ${missing.map((r) => r.id).join(", ")}`,
    };
  }
  const touched: string[] = [];
  for (const { player } of resolved) {
    if (!player) continue;
    player.state.condition = clampCondition(player.state.condition + condition);
    player.state.form = clampForm(player.state.form + form);
    touched.push(player.name);
  }
  pushNarrative(state, `${NARRATIVE_EVENT_MARKER} ${input.note}`, 3);
  return { ok: true, message: `서사 이벤트 반영(${touched.join(", ")}) — ${input.note}` };
}

/** 현재 전술·배치 요약 — GM이 읽는 컨텍스트 */
// ---- 스카우팅 (정보 비대칭 해제) ----

/**
 * 스카우트 파견 — 타 팀 선수 한 명을 지목해 보고서를 요청한다.
 * SCOUT_DAYS 뒤 tick이 완료 처리하고, 그때부터 능력치 안개가 걷힌다.
 *
 * **거듭 보낼 수 있다.** 첫 리포트가 능력치를 열어 준다면, 두 번째·세 번째는
 * 잠재력 추정을 좁힌다 — 한 번 보고 성장 여력을 단정하는 스카우트는 없다
 * (SCOUT_REPEAT_LIMIT까지 · scouting.ts 규약).
 */
export function scoutPlayer(state: GameState, playerId: string): SkillResult {
  const player = playerById(state, playerId);
  if (!player) return { ok: false, message: `"${playerId}"라는 선수를 찾지 못했습니다` };
  if (player.teamId === state.userTeamId) {
    return { ok: false, message: `${player.name}은(는) 우리 선수입니다 — 이미 다 알고 있습니다` };
  }
  const pending = state.scoutReports.find(
    (r) => r.gamePlayerId === playerId && r.completedOn === null,
  );
  if (pending) {
    return {
      ok: false,
      message: `${player.name}에게는 이미 스카우트를 보냈습니다 — 보고 예정 ${pending.dueOn}`,
    };
  }
  const done = completedScoutReports(state, playerId);
  if (done >= SCOUT_REPEAT_LIMIT) {
    return {
      ok: false,
      message: `${player.name}은(는) ${done}번 살펴봤습니다 — 더 보내도 새로 알 게 없습니다`,
    };
  }
  const inFlight = state.scoutReports.filter((r) => r.completedOn === null).length;
  if (inFlight >= SCOUT_CONCURRENT_LIMIT) {
    return {
      ok: false,
      message: `동시에 보낼 수 있는 스카우트는 ${SCOUT_CONCURRENT_LIMIT}명까지입니다 — 보고를 기다리세요`,
    };
  }
  const dueOn = addDays(state.date, SCOUT_DAYS);
  state.scoutReports.push({
    // 재파견이 있으므로 날짜만으로는 id가 겹칠 수 있다
    id: `scout-${playerId}-${state.date}-${state.scoutReports.length}`,
    gamePlayerId: playerId,
    requestedOn: state.date,
    dueOn,
    completedOn: null,
  });
  /**
   * 파견은 아직 아무 장부도 바꾸지 않았다 — 갈 화면이 없으므로 **카드**로 선다.
   * 며칠 뒤 도착하는 보고서 카드와 같은 흐름에 놓여 "보냈다 → 왔다"가 이어진다.
   */
  const card: MarketCard = {
    kind: "scout",
    playerId,
    playerName: player.name,
    counterpart: teamName(player.teamId),
    dueOn,
    ...(done > 0 ? { note: `${done + 1}번째 — 잠재력 추정을 좁힌다` } : {}),
  };
  return {
    ok: true,
    payload: card,
    message:
      `${player.name}(${teamName(player.teamId)}) 스카우트 파견 — 보고 예정 ${dueOn}` +
      (done > 0 ? ` (${done + 1}번째 · 잠재력 추정을 좁힌다)` : ""),
  };
}

export function describeTactics(state: GameState): string {
  const t = userTactics(state);
  const starters = assignmentsOf(state, state.userTeamId, "starting");
  const avgFam =
    starters.length > 0
      ? Math.round(starters.reduce((s, a) => s + a.familiarity, 0) / starters.length)
      : 60;
  const lineup = starters.map((a) => `${a.position} ${playerName(state, a.playerId)}`).join(", ");
  return (
    `${t.spec.formation} · 멘탈리티 ${t.spec.mentality} · 압박 ${t.spec.pressing} · 템포 ${t.spec.tempo} · ` +
    `패스 ${t.spec.passStyle} · 평균 전술 적응도 ${avgFam}\n선발: ${lineup}`
  );
}

export { MATCHDAY_BENCH, groupOf, tacticsOf };
