import {
  MANAGER_ATTRIBUTE_KO,
  PROMISE_KIND_KO,
  numberGrievanceStands,
  registrationBlockText,
} from "@story-fm/domain";
import type {
  BoardPoint,
  GamePlayer,
  ManagerAttributes,
  DrilledTactics,
  MarketCard,
  Player,
  PromiseKind,
  ReserveTrainingPolicy,
  ScheduleEntry,
  Slot,
  TacticAssignment,
  TacticsSpec,
  SetPieceRole,
  SetPieceTakers,
  TeamTactics,
  TeamTalkOccasion,
  TrainAttr,
} from "@story-fm/domain";
import {
  ageOf,
  ATTRIBUTE_AXES,
  attributeAxisOf,
  AXIS_KO,
  clampCondition,
  tacticalUptake as uptakeOf,
  DIRECTIVE_INTENSITY_KO,
  type DirectiveIntensity,
  PLAYER_DIRECTIVE_KO,
  type PlayerDirectiveKind,
  MATCHDAY_SQUAD,
  POSITION_CODES,
  RATING_MAX,
  SET_PIECE_ROLES,
  reserveTrainingTitle,
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
  clampFamiliarity,
  defaultRoleOf,
  inheritedRole,
  storedProficiencyFor,
  rolesFor,
  separateBoardPoints,
  familiarityForSetup,
  tacticsSignature,
  tacticsAffinityShift,
  tacticsDistance,
  TACTIC_TOGGLES,
  tacticToggleValue,
  tacticToggleWord,
  withCurrentDrilled,
} from "@story-fm/domain";
import { DIRECTIVE_TUNING } from "@story-fm/sim";
import { settleRoleCost, shelveFamiliarity, unshelveFamiliarity } from "./familiarity-memory";
import { recallRole, rememberRole } from "./role-memory";
import { diffLineup, type LineupSide, type LineupSlotRef } from "./lineup-diff";
import { addDays, diffDays, sortEntries, squadReturnOf } from "../competition/calendar";
import {
  ourYouthCandidates,
  signYouthCandidates,
  youthIntakeDeadline,
} from "../competition/season";
import { clampForm, moraleToForm } from "../squad/form";
import { injuryRiskFor } from "../squad/injury";
import { DEVELOPMENT_FOCUS_LIMIT, pruneDevelopmentFocus } from "../squad/development";
import {
  closeMentorings,
  MENTEES_PER_MENTOR,
  mentorBlock,
  mentorBoost,
  menteeBlock,
  menteePairsOf,
  mentorPairOf,
  mentorStrength,
  pruneMentoring,
} from "../squad/mentoring";
import { reserveTrainingAxes } from "../squad/training-plan";
import {
  canRegisterAllFor,
  canRegisterFor,
  registrationLine,
  squadRegistrationOf,
} from "../squad/registration";
import {
  SCOUT_REPEAT_LIMIT,
  completedScoutReports,
  deferScout,
  dropDeferredScout,
} from "../squad/scouting";
import { creditSettling, settlingAnchor, settlingOf } from "../squad/settling";
// 면담에서 한 약속은 장부에 선다 (people.md §5-2 · career.md §2)
import { openPromise, type PromiseOpened } from "../squad/promises";
// 감독이 지목한 번호는 코어가 배정하고, 사실만 돌려준다 (player.md §1.1)
import { assignRequestedNumber, numberBlockText } from "../squad/numbers";
import { archetypeTraitsOf } from "../world/player-persona";
import { dressingRoomFactor, dressingRoomVoice, leaderGroupOf } from "../squad/hierarchy";
import {
  groupOf,
  isInjured,
  isSuspended,
  playerById,
  playerName,
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
  type SkillBrief,
  type SkillBriefItem,
} from "../core/state";
import { pickAnyPlayer, pickOurPlayer, pickPlayerAmong } from "../core/player-ref";
import { briefNames, deltaItems, item, signed } from "./brief";

/**
 * 스킬 = 상태 변경의 유일한 통로 (overview §2.2·§5).
 * 판정형: LLM은 {outcome, intensity}만 정하고 변화량은 여기 공식이 정한다
 * (overview §7). 감독 능력치가 계수로 들어간다 (career.md §2).
 */

export interface SkillResult {
  ok: boolean;
  /** LLM에게 돌려주는 줄 — 모델이 읽을 것이므로 길어도 된다 */
  message: string;
  /**
   * **화면이 항목으로 세우는 요약** (`SkillBrief`) — 말풍선과 칩이 이걸 읽는다.
   *
   * 손댄 것을 다 이어 붙인 `message`를 화면이 되쪼개면 한 줄이 글자 벽이 된다.
   *
   * ⚠️ **말풍선을 갖는 스킬(`PANEL_OF`)은 모두 채운다** — 비우면 그 호출은 말풍선에
   * 서지 않는다. `message`는 모델에게 돌려주는 줄이지 화면의 항목이 아니라서,
   * 화면이 그 줄을 갈라 세우면 코어가 쓴 문장의 첫 줄이 곧 UI가 된다
   * (→ docs/data/game-state.md §3.6).
   */
  brief?: SkillBrief;
  /**
   * 화면이 카드로 그릴 **구조화된 결과** — 채우는 스킬만 채운다.
   * 넣지 않는 것이 기본이고, 시장 스킬만은 `MarketSkillResult`로 강제된다.
   */
  payload?: unknown;
  /** 결이 좋은가 — 대화형 스킬의 칩 색 (펼치지 않아도 알게) */
  tone?: "good" | "bad";
  /**
   * **아무것도 달라지지 않은 성공** — 이미 그 자리, 이미 그 층.
   *
   * 부르는 쪽은 "바꾼 것"과 "이미 그랬던 것"을 갈라야 하는데, 반려 문구를
   * `includes("이미")`로 뒤지면 문장을 다듬는 것만으로 판정이 뒤집힌다
   * (→ docs/data/player.md §3.1).
   */
  unchanged?: boolean;
}

/**
 * **시장 스킬의 반환 계약** — 성공했으면 카드가 반드시 있다.
 *
 * 협상·스카우트는 갈 장부가 없어서 채팅 카드가 유일한 자리다(`CARD_SKILLS`).
 * `payload`를 optional로 풀면 빠뜨려도 컴파일이 통과하고, 화면이 조용히 칩으로
 * 폴백해 **금액·확률·기한이 줄글에 접힌 채** 지나간다 — 성공 경로에 카드가
 * 없으면 타입이 막아야 한다.
 *
 * 실패(`ok: false`)에는 카드가 없다 — 반려 메시지가 곧 결과다.
 */
export type MarketSkillResult =
  | { ok: true; payload: MarketCard; message: string; tone?: "good" | "bad" }
  /** 실패 분기의 `payload?: undefined`는 `SkillResult`와 구조를 맞추기 위한 것이다 */
  | { ok: false; payload?: undefined; message: string; tone?: "good" | "bad" };

// ── 선수 지목 ───────────────────────────────────────────
//
// 이름 해석은 코어가 한 벌만 갖는다 (`pickOurPlayer`·`pickAnyPlayer`, core/state.ts) —
// 이적·교체 스킬도 같은 것을 쓴다.

/** 라인업 한 자리 — 풀리면 id로 바뀐 자리, 아니면 그 이유 */
function ourSlot(state: GameState, slot: LineupSlotInput): LineupSlotInput | string {
  const pick = pickOurPlayer(state, slot.playerId);
  return pick.ok ? { ...slot, playerId: pick.player.id } : pick.message;
}

/** 옮길 것이 없다는 한 문장 — 두 입구가 같은 말을 해야 감독이 같은 답으로 읽는다 */
const alreadyAtLevel = (player: GamePlayer, level: "first" | "reserve"): string =>
  `${player.name}은(는) 이미 ${level === "first" ? "1군" : "2군"}입니다`;

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
  const pick = pickOurPlayer(state, input.playerId);
  if (!pick.ok) return pick;
  const player = pick.player;
  if (squadLevelOf(player) === input.level) {
    return {
      ok: true,
      // 바뀐 것이 없다는 사실은 **반환값이** 말한다 — 부르는 쪽이 문구를 뒤지지 않게
      unchanged: true,
      message: alreadyAtLevel(player, input.level),
    };
  }
  if (input.level === "first") {
    const allowed = canRegisterFor(state, player, state.userTeamId);
    if (!allowed.ok) {
      return { ok: false, message: `${player.name}: ${registrationBlockText(allowed.block)}` };
    }
    return { ok: true, message: applySquadLevel(state, player, "first") };
  }

  const first = userPlayers(state).filter((p) => squadLevelOf(p) === "first");
  if (first.length <= MATCHDAY_SQUAD) return { ok: false, message: matchdaySquadFloor() };
  return { ok: true, message: applySquadLevel(state, player, "reserve") };
}

/**
 * 층을 실제로 옮긴다 — **검증은 부르는 쪽이 이미 끝냈다.**
 *
 * 규칙을 여기서 다시 재지 않는 이유는 **여럿을 한 요청으로 옮길 때**다
 * (`setSquadLevels`). 스무 명짜리 1군에서 하나를 내리고 하나를 올리는 요청은 전체로
 * 보면 적법한데, 옮기는 순간마다 혼자 다시 재면 어느 순서로 놓아도 중간에 걸린다 —
 * 먼저 올리면 명단이 차 있고, 먼저 내리면 하한을 뚫는다. 그래서 잰 뒤에 옮기는 이
 * 두 걸음을 갈라 둔다.
 */
/**
 * **자리 훈련은 1군의 것이다** (→ docs/simulation/season.md §2). 자리를 올리는 문은
 * 훈련 결산 하나뿐인데 2군은 결산을 받지 않으므로, 내려간 선수의 자리 프로그램은
 * 여기서 거둔다 — 남겨 두면 감독이 걸어 둔 전향이 조용히 멈춘 채 서 있다.
 * 겨냥한 축은 남는다: 월간 성장이 그 축을 이어 받는다.
 *
 * @returns 감독에게 덧붙일 한 조각 (거둘 것이 없으면 빈 문자열)
 */
function dropPositionTraining(state: GameState, player: GamePlayer): string {
  const program = state.playerTraining.find((t) => t.gamePlayerId === player.id);
  if (!program?.position) return "";
  const position = program.position;
  if (program.axis) delete program.position;
  else state.playerTraining = state.playerTraining.filter((t) => t.gamePlayerId !== player.id);
  return ` · ${position} 전향 훈련은 거뒀습니다 (2군엔 훈련 결산이 없습니다)`;
}

function applySquadLevel(state: GameState, player: GamePlayer, level: "first" | "reserve"): string {
  if (level === "first") {
    player.squadLevel = "first";
    /**
     * **승격이 방치를 끝낸다** (→ docs/data/people.md §5). 내려간 날을 지우면 다시
     * 내릴 때 그날부터 새로 세고, 그 방치가 낳은 불만도 함께 풀린다 — 다른 사유의
     * 불만(`minutes` 등)은 남는다. 원인이 사라진 것은 강등뿐이다.
     */
    player.state.demotedOn = undefined;
    // 집중 육성은 2군의 것이다 — 올라온 선수는 결산 판정(LLM)이 움직인다 (season.md §2)
    if (state.developmentFocus?.includes(player.id)) {
      state.developmentFocus = state.developmentFocus.filter((id) => id !== player.id);
    }
    const freed = state.issues.some((i) => i.gamePlayerId === player.id && i.reason === "demotion");
    if (freed) {
      state.issues = state.issues.filter(
        (i) => !(i.gamePlayerId === player.id && i.reason === "demotion"),
      );
    }
    pushNarrative(state, `${player.name} 1군 승격`, 2);
    const reg = squadRegistrationOf(state, state.userTeamId);
    return (
      `${player.name}을(를) 1군으로 승격했습니다 — ${registrationLine(reg)}` +
      (freed ? " · 2군 불만이 풀렸습니다" : "")
    );
  }
  player.squadLevel = "reserve";
  /** 방치의 시작점 — 기간을 파생할 표가 없어 저장한다 (→ docs/data/people.md §5) */
  player.state.demotedOn = state.date;
  const tactics = userTactics(state);
  /**
   * **배치를 지우기 전에 적응도·기억을 선반으로** (→ docs/data/player.md §7.3).
   * 배치 안에만 두면 2군을 하루 다녀온 주전이 `min(60, 팀 적응도)`로 새로 시작하고,
   * 돌아올 통로 자체가 지워져 영영 못 찾는다.
   */
  const dropped = tactics.assignments.find((a) => a.playerId === player.id);
  if (dropped) shelveFamiliarity(tactics, dropped, state.date);
  tactics.assignments = tactics.assignments.filter((a) => a.playerId !== player.id);
  // 2군에는 완장이 없다 — 라커룸 서열의 후보도 1군뿐이다 (people.md §5-1)
  if (player.isCaptain) player.isCaptain = false;
  if (player.isViceCaptain === true) player.isViceCaptain = undefined;
  /**
   * **완장이 빠지듯 멘토도 빠진다** (people.md §5-3) — 라커룸의 아침이 갈렸으므로
   * 그가 맡던 아이들은 여기서 놓인다. ⚠️ 멘티로서 든 사이는 닫지 않는다: 멘티는 두
   * 층 어디에도 설 수 있다.
   */
  const released = closeMentorings(state, (pair) => pair.mentorId === player.id, "squad");
  pushNarrative(state, `${player.name} 2군 이동`, 2);
  /**
   * **배치에서 빠지는 것까지 결과로 말한다** (→ docs/data/team.md §6). 2군은 배치를
   * 갖지 않으므로 내리면 판에서도 빠지는데, 조용히 빼면 주전을 내린 감독이 열 명짜리
   * 선발을 모른 채 경기를 맞는다.
   */
  const startingLeft = tactics.assignments.filter((a) => a.role === "starting").length;
  const note =
    dropped?.role === "starting"
      ? ` — 선발에서 빠져 선발이 ${startingLeft}명입니다`
      : dropped?.role === "bench"
        ? " — 매치데이 벤치에서 함께 빠집니다"
        : "";
  /** 조용히 빼면 감독이 모른다 — 놓인 아이의 이름까지 결과가 말한다 */
  const releasedNote =
    released.length > 0
      ? ` · 멘토링이 풀렸습니다 (${released.map((pair) => playerName(state, pair.menteeId)).join(", ")})`
      : "";
  return `${player.name}을(를) 2군으로 이동했습니다${note}${releasedNote}${dropPositionTraining(state, player)}`;
}

/**
 * 1·2군 이동 — **여러 명을 한 번에, 배치는 건드리지 않는다.**
 *
 * 감독의 "저 선수 2군으로 내려"가 닿는 문이다. 층만 옮기므로 선발 열한 자리를 다시
 * 적게 하지 않는다 — 배치와 층이 **함께** 정해지는 자리는 전술판과 `set_lineup`의
 * `squadLevels`가 갖는다 (→ docs/data/team.md §5).
 *
 * 규칙은 `setSquadLevel` 한 벌이 갖고, 여기는 **여럿을 한 요청으로 받는 데서 생기는
 * 것만** 더한다: 누적 검증과 전부-아니면-전무. 한 명씩 재면 남은 한 자리에 둘이 함께
 * 들어간다고 답하고, 반쯤 적용된 요청은 반려를 읽은 감독의 스쿼드를 이미 바꿔 놓는다.
 */
export function setSquadLevels(
  state: GameState,
  input: { moves: Array<{ playerId: string; level: "first" | "reserve" }> },
): SkillResult {
  if (input.moves.length === 0) return { ok: false, message: "누구를 옮길지 알려주세요" };

  // ── 검증 ───────────────────────────────────────────────
  // 여기서는 아무것도 바꾸지 않는다. 하나라도 걸리면 상태는 부른 그대로다.
  const promoting: GamePlayer[] = [];
  const demoting: GamePlayer[] = [];
  /** 이미 그 층인 선수 — 옮길 것이 없다는 사실도 감독에게는 답이다 */
  const already: GamePlayer[] = [];
  const asked = new Map<string, "first" | "reserve">();
  for (const move of input.moves) {
    const pick = pickOurPlayer(state, move.playerId);
    if (!pick.ok) return pick;
    const player = pick.player;
    const before = asked.get(player.id);
    if (before !== undefined) {
      // 같은 선수를 양쪽으로 부르는 요청은 어느 쪽을 따라도 감독의 뜻이 아니다
      if (before !== move.level) {
        return { ok: false, message: `${player.name}을(를) 1군과 2군 양쪽으로 옮길 수 없습니다` };
      }
      continue; // 같은 지시를 두 번 적은 것뿐이다
    }
    asked.set(player.id, move.level);
    if (squadLevelOf(player) === move.level) already.push(player);
    else (move.level === "first" ? promoting : demoting).push(player);
  }

  /**
   * 승격 가능 여부는 **누적으로** 잰다 — 한 명씩 재면 마지막 한 자리를 여럿에게 준다.
   * 이번에 내리는 선수가 비우는 자리도 함께 셈한다: "하나 내리고 하나 올려"는 명단이
   * 찬 팀이 가장 흔히 하는 교대다.
   */
  if (promoting.length > 0) {
    const leaving = new Set(demoting.map((p) => p.id));
    const allowed = canRegisterAllFor(state, promoting, state.userTeamId, leaving);
    if (!allowed.ok) {
      return {
        ok: false,
        message: `${playerName(state, allowed.playerId)}: ${registrationBlockText(allowed.block)}`,
      };
    }
  }
  /** 하한도 이번에 오르내리는 인원을 다 셈한 뒤의 1군 수로 잰다 */
  if (demoting.length > 0) {
    const firstAfter =
      userPlayers(state).filter((p) => squadLevelOf(p) === "first").length +
      promoting.length -
      demoting.length;
    if (firstAfter < MATCHDAY_SQUAD) return { ok: false, message: matchdaySquadFloor() };
  }

  // ── 적용 ───────────────────────────────────────────────
  // 여기서부터는 실패하지 않는다 — 잰 것은 위에서 다 쟀다 (`applySquadLevel`).
  // 강등 먼저: 등록 한 줄과 남은 선발 수를 끝난 뒤의 명단으로 적게 된다.
  const notes = [
    ...demoting.map((p) => applySquadLevel(state, p, "reserve")),
    ...promoting.map((p) => applySquadLevel(state, p, "first")),
    ...already.map((p) => alreadyAtLevel(p, asked.get(p.id)!)),
  ];

  const items: SkillBriefItem[] = [];
  if (promoting.length > 0) {
    items.push(item({ label: "1군 승격", text: briefNames(promoting.map((p) => p.name)) }));
  }
  if (demoting.length > 0) {
    items.push(item({ label: "2군 이동", text: briefNames(demoting.map((p) => p.name)) }));
  }
  /**
   * **판이 열 명이 된 것은 말풍선도 말한다** (→ docs/data/team.md §6). 2군은 배치를
   * 갖지 않으므로 주전을 내리면 선발이 빈다 — 줄글에만 적으면 칩을 펴 보지 않은
   * 감독이 모자란 선발로 경기를 맞는다.
   */
  const startersNeeded = MATCHDAY_SQUAD - MATCHDAY_BENCH;
  const starting = userTactics(state).assignments.filter((a) => a.role === "starting").length;
  if (demoting.length > 0 && starting < startersNeeded) {
    items.push(item({ label: "선발", text: `${starting}명`, note: "자리가 빕니다" }));
  }
  const message = notes.join(" · ");
  // 아무도 층을 옮기지 않았으면 세울 항목이 없다 — 그 사실은 줄글이 이미 말한다
  if (items.length === 0) return { ok: true, unchanged: true, message };
  return { ok: true, message, brief: { head: "1·2군 이동", items } };
}

/** 1군 인원 하한을 말하는 한 문장 — 두 스킬이 같은 말을 해야 감독이 같은 규칙으로 읽는다 */
function matchdaySquadFloor(): string {
  const starters = MATCHDAY_SQUAD - MATCHDAY_BENCH;
  return `1군은 매치데이 명단(선발 ${starters} + 벤치 ${MATCHDAY_BENCH})을 채울 ${MATCHDAY_SQUAD}명 이상이어야 합니다`;
}

/**
 * 집중 육성 — 감독이 코치진의 눈을 둘 2군 유망주를 지정한다 (season.md §2 2군 리그).
 *
 * **목록 교체다** — 부를 때마다 지정 전체를 다시 적고, 목록을 생략하면 해제다. 더하기·
 * 빼기를 따로 받으면 감독이 지금 명단을 모른 채 상한에 걸린다. 우리 2군만 지정할
 * 수 있고, 승격하면 풀린다(`applySquadLevel`) — 1군은 결산 판정(LLM)의 몫이라
 * 코어 배율이 닿을 자리가 없다.
 */
export function setDevelopmentFocus(
  state: GameState,
  input: { playerIds?: string[] },
): SkillResult {
  const players: GamePlayer[] = [];
  for (const id of input.playerIds ?? []) {
    const pick = pickOurPlayer(state, id);
    if (!pick.ok) return pick;
    const player = pick.player;
    if (squadLevelOf(player) !== "reserve") {
      return {
        ok: false,
        message: `${player.name}은(는) 1군입니다 — 집중 육성은 2군 유망주에게 겁니다`,
      };
    }
    if (!players.some((p) => p.id === player.id)) players.push(player);
  }
  if (players.length > DEVELOPMENT_FOCUS_LIMIT) {
    return {
      ok: false,
      message: `집중 육성은 ${DEVELOPMENT_FOCUS_LIMIT}명까지입니다 — 코치진의 눈은 거기까지 닿습니다`,
    };
  }

  const before = pruneDevelopmentFocus(state);
  const after = players.map((p) => p.id);
  if (before.length === after.length && before.every((id) => after.includes(id))) {
    return {
      ok: true,
      unchanged: true,
      message:
        players.length === 0
          ? "집중 육성 지정이 없습니다"
          : `이미 그 명단입니다 — ${briefNames(players.map((p) => p.name))}`,
    };
  }
  state.developmentFocus = after;
  if (players.length === 0) {
    return {
      ok: true,
      message: "집중 육성 지정을 해제했습니다",
      brief: { head: "집중 육성", items: [item({ text: "해제" })] },
    };
  }
  pushNarrative(state, `집중 육성 지정 — ${players.map((p) => p.name).join(", ")}`, 1);
  return {
    ok: true,
    message: `집중 육성: ${players.map((p) => p.name).join(", ")} — 2군 경기 출전이 성장을 끌어올립니다`,
    brief: {
      head: "집중 육성",
      items: [item({ label: "지정", text: briefNames(players.map((p) => p.name)) })],
    },
  };
}

/** 멘토를 고른 근거 한 줄 — 나이와 리더십이 결과 항목에 그대로 선다 (`armbandNote`와 같은 결) */
function mentorNote(state: GameState, mentor: GamePlayer): string {
  return `${ageOf(mentor.birthdate, state.date)}세 · 리더십 ${mentor.attributes.leadership}`;
}

/** 이 짝의 멘토 항 한 조각 — 저장하지 않고 그때그때 다시 매긴다 (people.md §5-3) */
function menteeNote(state: GameState, mentor: GamePlayer, mentee: GamePlayer): string {
  return `정신 6축 ×${mentorBoost(mentorStrength(mentor, mentee, state.date)).toFixed(2)}`;
}

/**
 * 멘토링 — 감독이 고참에게 유망주를 맡긴다 (→ docs/data/people.md §5-3).
 *
 * **목록 교체다** — 집중 육성과 같은 규약(`set_development_focus`). 부를 때마다 그
 * 멘토의 멘티 전체를 다시 적고, 목록을 비우면 그 멘토의 사이가 다 닫힌다. 더하기·
 * 빼기를 따로 받으면 감독이 지금 명단을 모른 채 상한에 걸린다.
 *
 * 자격은 `mentorBlock`·`menteeBlock` 한 벌이 갖는다 — 반려 문구를 여기서 다시 지으면
 * 같은 규칙이 자리마다 다른 말로 선다.
 */
export function setMentor(
  state: GameState,
  input: { mentorId: string; menteeIds?: string[] },
): SkillResult {
  /**
   * **장부를 먼저 추린다** — 스킬과 월간 성장이 같은 문을 지나야 어느 쪽이 먼저 와도
   * 명단이 같다 (`pruneDevelopmentFocus`가 그런 것과 같은 이유). 나이를 넘긴 멘티가
   * 남아 있으면 감독이 상한에 걸리지 않을 자리에서 걸린다.
   */
  pruneMentoring(state);

  const picked = pickOurPlayer(state, input.mentorId);
  if (!picked.ok) return picked;
  const mentor = picked.player;
  const blocked = mentorBlock(state, mentor);
  if (blocked) return { ok: false, message: blocked };

  const mentees: GamePlayer[] = [];
  for (const ref of input.menteeIds ?? []) {
    const pick = pickOurPlayer(state, ref);
    if (!pick.ok) return pick;
    const mentee = pick.player;
    if (mentee.id === mentor.id) {
      return { ok: false, message: `${mentor.name}을(를) 자기 자신에게 맡길 수 없습니다` };
    }
    const block = menteeBlock(state, mentee);
    if (block) return { ok: false, message: block };
    /**
     * **한 선수는 한 멘토다.** 누구에게 가 있는지를 말해야 감독이 다음 수를 둔다 —
     * 이름 없이 반려하면 그 아이를 데려오려고 장부를 뒤져야 한다.
     */
    const held = mentorPairOf(state, mentee.id);
    if (held && held.mentorId !== mentor.id) {
      return {
        ok: false,
        message:
          `${mentee.name}은(는) 이미 ${playerName(state, held.mentorId)}에게 맡겨져 있습니다 — ` +
          `한 선수는 한 멘토입니다`,
      };
    }
    if (!mentees.some((p) => p.id === mentee.id)) mentees.push(mentee);
  }
  if (mentees.length > MENTEES_PER_MENTOR) {
    return {
      ok: false,
      message: `한 멘토는 ${MENTEES_PER_MENTOR}명까지입니다 — 고참 하나의 눈은 거기까지 닿습니다`,
    };
  }

  const before = menteePairsOf(state, mentor.id).map((pair) => pair.menteeId);
  const after = mentees.map((p) => p.id);
  if (before.length === after.length && before.every((id) => after.includes(id))) {
    return {
      ok: true,
      unchanged: true,
      message:
        mentees.length === 0
          ? `${mentor.name}이(가) 맡은 유망주가 없습니다`
          : `이미 그 명단입니다 — ${mentor.name}: ${briefNames(mentees.map((p) => p.name))}`,
    };
  }

  /**
   * **그 멘토의 빠진 짝만 닫는다** — `closeMentoringsFor`는 그가 멘티로 든 사이까지
   * 함께 닫는다. 그리고 닫는 것이지 지우는 것이 아니다: 놓인 아이의 심경이 며칠
   * 그 줄을 읽는다 (people.md §5-3).
   */
  const released = closeMentorings(
    state,
    (pair) => pair.mentorId === mentor.id && !after.includes(pair.menteeId),
    "manager",
  );
  state.mentoring ??= [];
  for (const mentee of mentees) {
    if (before.includes(mentee.id)) continue;
    state.mentoring.push({ mentorId: mentor.id, menteeId: mentee.id, since: state.date });
  }

  const releasedNames = released.map((pair) => playerName(state, pair.menteeId));
  if (mentees.length === 0) {
    pushNarrative(state, `멘토링 해제 — ${mentor.name}`, 1);
    return {
      ok: true,
      message: `${mentor.name}이(가) 맡고 있던 유망주를 모두 풀었습니다 — ${releasedNames.join(", ")}`,
      brief: {
        head: "멘토링",
        items: [
          item({ label: "멘토", text: mentor.name, note: mentorNote(state, mentor) }),
          item({ label: "해제", text: briefNames(releasedNames) }),
        ],
      },
    };
  }

  const items: SkillBriefItem[] = [
    item({ label: "멘토", text: mentor.name, note: mentorNote(state, mentor) }),
    ...mentees.map((mentee) =>
      item({ label: "멘티", text: mentee.name, note: menteeNote(state, mentor, mentee) }),
    ),
  ];
  if (releasedNames.length > 0) {
    items.push(item({ label: "해제", text: briefNames(releasedNames) }));
  }
  const names = mentees.map((p) => p.name).join(", ");
  pushNarrative(state, `멘토링 — ${mentor.name}에게 ${names}`, 1);
  return {
    ok: true,
    message:
      `${mentor.name}에게 ${names}을(를) 맡겼습니다 — 멘티의 정신 6축 성장이 빨라집니다` +
      (releasedNames.length > 0 ? ` · ${releasedNames.join(", ")}은(는) 풀렸습니다` : ""),
    brief: { head: "멘토링", items },
  };
}

/**
 * 2군 훈련 방침 — 코치진이 어느 축을 겨냥해 유망주를 기르는가 (season.md §2).
 *
 * **총량을 옮길 뿐 늘리지 않는다** — 겨냥한 축이 빨라지는 만큼 나머지 필드 축이
 * 느려진다. 그래서 메시지는 얻는 것과 함께 포기하는 것도 말한다: 무엇을
 * 포기했는지가 이 손잡이의 값이다. `balanced`가 기본값이자 해제고, 상태에 남는
 * 것은 코드 하나라 옛 세이브도 그대로 읽힌다.
 */
export function setReserveTraining(
  state: GameState,
  input: { policy: ReserveTrainingPolicy },
): SkillResult {
  const { policy } = input;
  const title = reserveTrainingTitle(policy);
  const current = state.reserveTraining ?? "balanced";
  if (current === policy) {
    return {
      ok: true,
      unchanged: true,
      message:
        policy === "balanced"
          ? "2군 훈련 방침이 없습니다 — 어느 축도 겨냥하지 않습니다"
          : `이미 ${title} 방침입니다`,
    };
  }

  state.reserveTraining = policy;
  if (policy === "balanced") {
    pushNarrative(state, "2군 훈련 방침 해제 — 겨냥하는 축 없음", 1);
    return {
      ok: true,
      message: "2군 훈련 방침을 해제했습니다 — 유망주는 다시 고르게 자랍니다",
      brief: { head: "2군 훈련 방침", items: [item({ text: "해제" })] },
    };
  }

  const aimed = reserveTrainingAxes(policy)
    .map((axis) => AXIS_KO[axis])
    .join("·");
  pushNarrative(state, `2군 훈련 방침 — ${title}`, 1);
  return {
    ok: true,
    message: `2군 훈련 방침을 ${title}으로 잡았습니다 — ${aimed}이(가) 빨리 자라는 대신 나머지 필드 축은 그만큼 느려집니다`,
    brief: {
      head: "2군 훈련 방침",
      items: [
        item({ label: "겨냥", text: title }),
        item({ label: "축", text: aimed, note: "나머지 필드 축은 느려집니다" }),
      ],
    },
  };
}

/**
 * **첫 프로 계약** — 여름의 유스 후보 중 감독이 고른 이름이 계약을 받는다
 * (season.md §6 유스 인테이크).
 *
 * **한 번의 확정이다** — 고른 이름이 계약하고 **나머지 후보는 사라진다.** 목록을
 * 고쳐 가며 여러 번 부르는 자리가 아니고, 이름을 하나도 주지 않으면 전원 돌려보낸다:
 * 스쿼드 크기의 결정권이 감독에게 있다는 것이 이 손잡이의 값이다.
 *
 * ⚠️ **소프트락 방지는 감독의 결정 밖이다** — 고른 뒤에도 포지션군이 최소 인원
 * 아래면 코어가 남은 후보에서 그 자리를 채우고, 무엇을 채웠는지 답에 적는다.
 */
export function signYouth(state: GameState, input: { playerIds?: string[] }): SkillResult {
  const rows = ourYouthCandidates(state);
  if (rows.length === 0) {
    return {
      ok: false,
      message: `지금 서 있는 유스 후보가 없습니다 — 인테이크는 여름 프리시즌에 한 번뿐이고 소집일(${youthIntakeDeadline(state)})에 닫힙니다`,
    };
  }
  const pool = rows.map((row) => row.player);
  const chosen: GamePlayer[] = [];
  for (const ref of input.playerIds ?? []) {
    const pick = pickPlayerAmong(state, pool, ref, "유스 후보");
    if (!pick.ok) return pick;
    if (!chosen.some((p) => p.id === pick.player.id)) chosen.push(pick.player);
  }

  const released = rows.length - chosen.length;
  const { signed: joined, filled } = signYouthCandidates(
    state,
    chosen.map((p) => p.id),
  );
  const names = (players: readonly GamePlayer[]) => briefNames(players.map((p) => p.name));

  if (joined.length === 0 && filled.length === 0) {
    pushNarrative(state, `유스 인테이크 — 후보 ${rows.length}명 전원 방출`, 2);
    return {
      ok: true,
      message: `유스 후보 ${rows.length}명을 전원 돌려보냈습니다 — 이번 여름 아카데미에서 올라오는 선수는 없습니다`,
      brief: { head: "유스 인테이크", items: [item({ label: "방출", text: `${rows.length}명` })] },
    };
  }

  const items = [item({ label: "계약", text: names([...joined, ...filled]) })];
  if (filled.length > 0) {
    items.push(
      item({
        label: "구단 보충",
        text: names(filled),
        note: "포지션군 최소 인원이 무너져 구단이 채웠습니다",
      }),
    );
  }
  if (released > 0) items.push(item({ label: "방출", text: `${released}명` }));
  pushNarrative(
    state,
    `유스 인테이크 — ${[...joined, ...filled].map((p) => p.name).join(", ")} 첫 프로 계약`,
    3,
  );
  return {
    ok: true,
    message:
      `${names([...joined, ...filled])} — 첫 프로 계약을 맺고 2군 개발 스쿼드에 들어왔습니다` +
      (filled.length > 0
        ? ` (${names(filled)}은(는) 포지션군 최소 인원이 무너져 구단이 함께 올렸습니다)`
        : "") +
      (released > 0 ? ` · 나머지 ${released}명은 돌려보냈습니다` : ""),
    brief: { head: "유스 인테이크", items },
  };
}

// 체력 클램프는 도메인이 단일 소스 (clampCondition)
// 폼 클램프는 form.ts가 단일 소스 — 소수를 살려야 매일 회귀가 반영된다
// 적응도 클램프도 도메인이 단일 소스 (clampFamiliarity) — 기억을 적는 자리와
// 되찾는 자리가 같은 천장을 써야 왕복이 닫힌다

export { POSITION_CODES, positionGroupOf };

// ---- 감독 성장 (career.md §3) ----

/** 한 칸에 필요한 XP · 성장 상한 — 뷰가 진행을 그리려면 같은 값을 읽어야 한다 */
export const MANAGER_XP_PER_LEVEL = 100;
export const MANAGER_ATTR_CAP = 90;

export function grantManagerXP(
  state: GameState,
  axis: keyof ManagerAttributes,
  amount: number,
): string | null {
  state.managerXP[axis] += amount;
  // 한 번에 여러 칸치가 들어오면 그 한 번에 다 오른다 — 나눠 받은 것과 같아야 한다
  let grown = false;
  while (
    state.managerXP[axis] >= MANAGER_XP_PER_LEVEL &&
    state.manager.attributes[axis] < MANAGER_ATTR_CAP
  ) {
    state.managerXP[axis] -= MANAGER_XP_PER_LEVEL;
    state.manager.attributes[axis] += 1;
    grown = true;
  }
  // 상한에 닿은 축은 더 갈 칸이 없다 — 장부가 무한히 커지지 않게 한 칸 직전에서 멈춘다
  if (state.manager.attributes[axis] >= MANAGER_ATTR_CAP) {
    state.managerXP[axis] = Math.min(state.managerXP[axis], MANAGER_XP_PER_LEVEL - 1);
  }
  return grown
    ? `감독 성장 — ${MANAGER_ATTRIBUTE_KO[axis]} ${state.manager.attributes[axis]}`
    : null;
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

/** 강도의 중립점 — 2가 곧 1.0배라, 1은 절반으로 3은 1.5배로 울린다 */
const TALK_INTENSITY_PIVOT = 2;
/**
 * 팀토크가 사기를 움직일 수 있는 폭 — **이벤트당 한도** (overview §7). 라커룸
 * 전체에 한 번에 걸리므로 한 사람을 부르는 면담보다 좁다.
 */
const TEAM_TALK_MORALE_BOUND = 6;
/** 면담이 한 선수의 사기를 움직일 수 있는 폭 — 대상이 하나라 팀토크보다 넓다 */
const TALK_MORALE_BOUND = 8;
/**
 * 정지점의 외침이 사기를 움직일 수 있는 폭 — **라커룸의 한마디보다 좁다**
 * (career.md §2). 같은 무게로 두면 하루 한 번의 팀토크가 뜻을 잃는다.
 */
const SHOUT_MORALE_BOUND = 2;
/**
 * 외침이 결과 표에서 줄어드는 배수.
 *
 * 한도만 좁히면 강도도 결과 라벨도 전부 그 한도에 붙어 감독이 **무슨 말을 했는지**가
 * 폭에서 사라진다. 표를 통째로 줄이고 한도는 꼬리만 자르게 둔다.
 */
const SHOUT_SCALE = 1 / 3;
/**
 * 한 경기가 셈하는 외침의 수 (`PendingMatch.shouts`) — 정지점마다 외칠 수는 없다.
 * 셋을 다 써야 라커룸 한마디 한 번의 폭에 닿는다 (career.md §2).
 */
const SHOUT_PER_MATCH = 3;
/** 잘 풀린 팀토크가 강도 한 칸당 주는 리더십 XP */
const TEAM_TALK_XP_PER_INTENSITY = 8;
/** 잘 풀린 외침이 강도 한 칸당 주는 리더십 XP — 셋을 다 써도 라커룸 한마디보다 적다 */
const SHOUT_XP_PER_INTENSITY = 2;
/** 잘 풀린 면담이 강도 한 칸당 주는 리더십 XP */
const TALK_XP_PER_INTENSITY = 6;
/** 어긋난 말에도 남는 리더십 XP — 실패도 겪은 것이다 */
const TALK_XP_ON_FAILURE = 2;

/** 리더십이 0일 때의 계수 — 말은 통하지 않아도 완전히 죽지는 않는다 */
const LEADERSHIP_FACTOR_FLOOR = 0.7;
/** 리더십이 눈금 끝까지 올랐을 때 더해지는 폭 — 바닥과 합쳐 0.7~1.3이다 */
const LEADERSHIP_FACTOR_SPAN = 0.6;

/** 리더십 계수 — 같은 말도 리더십이 자라면 더 크게 울린다 */
function leadershipFactor(state: GameState): number {
  return (
    LEADERSHIP_FACTOR_FLOOR +
    (state.manager.attributes.leadership / RATING_MAX) * LEADERSHIP_FACTOR_SPAN
  );
}

/**
 * **그 말이 울리는 방** — 팀토크의 계수는 둘이다 (career.md §2 · people.md §5-1).
 * 감독의 리더십이 말을 하는 사람이라면 이쪽은 라커룸이고, 완장과 리더 그룹의
 * 리더십이 정한다.
 *
 * 경기 중에는 **그 경기의 명단**이 방이다 — 주장이 결장한 경기의 하프타임은
 * 부주장의 리더십이 계수를 정한다.
 */
function matchSquadIds(state: GameState): ReadonlySet<string> | undefined {
  const pending = state.pendingMatch;
  if (!pending) return undefined;
  const side =
    pending.packet.home.teamId === state.userTeamId ? pending.ledger.home : pending.ledger.away;
  return new Set([...side.onPitch, ...side.bench]);
}

/** 팀토크를 꺼낸 자리 — 이미 했다는 말이 어느 자리를 가리키는지 밝힌다 */
const OCCASION_KO: Record<TeamTalkOccasion, string> = {
  pre: "경기 전",
  half: "하프타임",
  post: "경기 후",
  daily: "평시",
  shout: "정지점",
};

/**
 * 0에서 멀어지는 쪽으로 반올림.
 *
 * `Math.round`는 절반을 위로 올려 `-0.5`를 0으로 만든다 — 같은 크기의 질책만 한 칸씩
 * 무뎌진다는 뜻이고, 폭이 ±2뿐인 외침에서는 그 비대칭이 라벨을 통째로 죽인다.
 */
function roundAwayFromZero(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

export function applyTeamTalk(
  state: GameState,
  input: {
    /** 그 말을 꺼낸 자리 — **하루 한 번을 세는 단위다** (career.md §2) */
    occasion: TeamTalkOccasion;
    outcome: TeamTalkOutcome;
    intensity: 1 | 2 | 3;
    /** 이 말이 새 영입들의 적응에 남긴 무게 — 코어 앵커에서 EVENT_BAND만큼만 */
    settling?: number;
  },
): SkillResult {
  const shout = input.occasion === "shout";
  /**
   * **외침을 세는 것은 하루가 아니라 경기다** (career.md §2). 라커룸 밖의 말이라
   * `teamTalkedOn`에 얹으면 벤치의 한마디가 그날 남은 자리를 먹고, 게이트가 없으면
   * 정지점마다 외치는 것이 폼을 올리는 최적 전략이 된다.
   */
  if (input.occasion === "shout") {
    const pending = state.pendingMatch;
    // 벤치가 없으면 외칠 자리도 없다 — 라커룸의 한마디는 pre·half·post·daily다
    if (!pending) {
      return { ok: false, message: "외침은 경기 중 정지점에서만 나옵니다" };
    }
    const used = pending.shouts ?? 0;
    if (used >= SHOUT_PER_MATCH) {
      return {
        ok: true,
        message: `이번 경기의 외침 ${SHOUT_PER_MATCH}번을 다 썼습니다 — 남은 말은 라커룸의 몫입니다`,
      };
    }
    pending.shouts = used + 1;
  } else {
    /**
     * **자리마다 하루 한 번** (career.md §2) — 사기도 정착도 XP도 서사도 그 자리의 첫
     * 팀토크만 셈한다. 경기 중에는 정지점마다 `team_talk`이 의도로 옮겨질 수 있어
     * (`match-intent-apply.ts`), 문이 없으면 같은 말을 반복하는 것이 폼을 올리는 최적
     * 전략이 된다.
     *
     * 하루 한 번으로 묶지 않고 자리로 가른 것은 경기 전의 한마디와 하프타임의 한마디가
     * 서로 다른 순간이기 때문이다 — 묶으면 연타를 막는 대신 장면 하나가 사라진다.
     */
    const talkedOn = state.manager.teamTalkedOn ?? {};
    if (talkedOn[input.occasion] === state.date) {
      return {
        ok: true,
        message: `${OCCASION_KO[input.occasion]} 팀토크는 오늘 이미 했습니다 — 같은 말이 두 번 남지는 않습니다`,
      };
    }
    state.manager.teamTalkedOn = { ...talkedOn, [input.occasion]: state.date };
  }

  const base = TEAM_TALK_BASE[input.outcome];
  const present = matchSquadIds(state);
  const room = dressingRoomFactor(state, state.userTeamId, present);
  const voice = dressingRoomVoice(state, state.userTeamId, present);
  // 그 방에 선 완장 — 주장이 없는 자리에서는 부주장이 그 이름이다
  const wearing = userPlayers(state).filter((p) => present === undefined || present.has(p.id));
  const captainName = (
    wearing.find((p) => p.isCaptain) ?? wearing.find((p) => p.isViceCaptain === true)
  )?.name;
  const delta = roundAwayFromZero(
    base *
      (input.intensity / TALK_INTENSITY_PIVOT) *
      leadershipFactor(state) *
      room *
      (shout ? SHOUT_SCALE : 1),
  );
  const bound = shout ? SHOUT_MORALE_BOUND : TEAM_TALK_MORALE_BOUND;
  const bounded = Math.max(-bound, Math.min(bound, delta));
  /**
   * **외침은 그 경기의 명단에만 닿는다** — 벤치에서 그라운드로 가는 말이라 집에 있는
   * 선수단까지 울릴 수 없다. 라커룸의 팀토크는 선수단 전체의 것이다 (career.md §2).
   */
  const heard =
    shout && present ? userPlayers(state).filter((p) => present.has(p.id)) : userPlayers(state);
  for (const p of heard) {
    p.state.form = clampForm(p.state.form + moraleToForm(bounded));
  }
  // 라커룸 앞에서 한 말은 **아직 겉도는 새 영입**에게 특히 크게 남는다 (settling.ts)
  const settlingAnchorValue = settlingAnchor("team_talk", { intensity: input.intensity });
  /**
   * **외침에는 정착 크레딧이 없다** — 겉도는 새 영입을 라커룸으로 끌어들이는 것은
   * 마주 앉아 한 말의 몫이지 90분 사이에 던진 한마디가 아니다 (player.md §9.3).
   */
  const settled =
    base > 0 && !shout
      ? userPlayers(state).filter(
          (p) =>
            creditSettling(state, p.id, "team_talk", {
              anchor: settlingAnchorValue,
              ...(input.settling === undefined ? {} : { proposed: input.settling }),
            }) > 0,
        ).length
      : 0;
  const xpPerIntensity = shout ? SHOUT_XP_PER_INTENSITY : TEAM_TALK_XP_PER_INTENSITY;
  const xpMsg =
    base > 0
      ? grantManagerXP(state, "leadership", xpPerIntensity * input.intensity)
      : grantManagerXP(state, "leadership", TALK_XP_ON_FAILURE);
  const used = state.pendingMatch?.shouts ?? 0;
  pushNarrative(
    state,
    `${shout ? "외침" : "팀토크"}(${input.outcome}) — 사기 ${bounded >= 0 ? "+" : ""}${bounded}`,
    // 하루 한 번의 라커룸 장면과 90분 사이의 한마디가 같은 무게로 남지는 않는다
    shout ? 1 : 2,
  );
  return {
    ok: true,
    // 펼치지 않아도 잘 풀렸는지는 알아야 한다 — 숫자는 펼쳤을 때만
    tone: bounded >= 0 ? ("good" as const) : ("bad" as const),
    message:
      `${shout ? "명단" : "팀"} 전체 사기 ${bounded >= 0 ? "+" : ""}${bounded}` +
      (shout ? ` · 이번 경기 외침 ${used}/${SHOUT_PER_MATCH}` : "") +
      (settled > 0 ? ` · 적응 중인 ${settled}명이 한 걸음 가까워졌습니다` : "") +
      (xpMsg ? ` · ${xpMsg}` : ""),
    /**
     * 사기 변화는 **항목 하나**다 — 부호는 `delta`가 나르고 화면이 색을 준다.
     * 감독이 무슨 말을 어떻게 했는지는 장면의 것이지 알림의 것이 아니다.
     */
    brief: {
      head: shout ? "정지점 외침" : `${OCCASION_KO[input.occasion]} 팀토크`,
      items: [
        item({ label: shout ? "명단 사기" : "팀 사기", text: signed(bounded), delta: bounded }),
        // 몇 번 남았는지는 감독이 아껴 쓸지 정하는 값이다 — 안내 문구가 아니라 눈금
        ...(shout ? [item({ label: "외침", text: `${used}/${SHOUT_PER_MATCH}` })] : []),
        /**
         * **폭이 왜 그만큼이었는지가 그 자리에 남는다** — 라커룸 계수는 감독이
         * 완장을 어디에 채웠는지의 결과라, 숫자만 돌려주면 주장 지명이 다시
         * 서사에서만 뜻을 갖는 값이 된다 (people.md §5-1).
         */
        ...(voice === null
          ? []
          : [
              item({
                label: "라커룸",
                text: `×${room.toFixed(2)}`,
                note: `${captainName ?? "완장 공석"} · 리더십 ${Math.round(voice)}`,
              }),
            ]),
        ...(settled > 0 ? [item({ label: "적응", text: `${settled}명` })] : []),
      ],
    },
  };
}

/** 감독이 그 자리에서 한 약속 — 갈래와, 감독이 좁힌 기한 */
export interface PromiseInput {
  kind: PromiseKind;
  /**
   * 기한(일) — 생략하면 갈래의 기본 기한이다. 날수가 아닌 갈래가 둘이다:
   * `transfer`는 다음 창 마감, `number`는 다음 시즌 개막일 (people.md §5-2).
   */
  days?: number;
  /**
   * 약속한 등번호 — **`number` 갈래에만 뜻이 있고, 그 갈래에는 없으면 반려된다.**
   * 번호가 곧 약속의 내용이라 그것 없이는 이행을 판정할 자가 없다.
   */
  number?: number;
}

/** 장부에 선 약속 한 조각 — 감독이 읽는 줄과 말풍선 항목 */
interface PromisePiece {
  text: string;
  item: SkillBriefItem;
}

/**
 * 면담·응대가 연 약속을 **한 조각으로** 옮긴다 (people.md §5-2).
 *
 * ⚠️ **반려도 조각이 된다.** 감독은 자기가 한 말이 장부에 섰는지를 알아야 하고,
 * 반려는 그 대화를 무르지 않는다 — 사기·정착·압력은 이미 셈이 끝난 뒤다.
 * 두 자리가 같은 함수를 부르는 것은 같은 말이 자리마다 다른 줄로 서지 않게 하기
 * 위해서다.
 */
export function promisePiece(opened: PromiseOpened): PromisePiece {
  const promise = opened.promise;
  if (opened.ok && promise) {
    // `number` 약속만 숫자를 든다 — 갈래 이름만 세우면 어느 번호였는지가 사라진다
    const label =
      PROMISE_KIND_KO[promise.kind] + (promise.number === undefined ? "" : ` ${promise.number}번`);
    return {
      text: ` · ${label} 약속 (${promise.dueOn}까지)`,
      item: item({ label: "약속", text: label, note: `${promise.dueOn}까지` }),
    };
  }
  const why = opened.message ?? "약속을 세울 수 없습니다";
  return { text: ` · 약속 반려 — ${why}`, item: item({ label: "약속", text: "반려", note: why }) };
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
    /**
     * 감독이 이 면담에서 한 약속 — **장부에 선다** (career.md §2 · people.md §5-2).
     * 반려돼도 면담 자체는 그대로 성립한다.
     */
    promise?: PromiseInput;
  },
): SkillResult {
  const pick = pickOurPlayer(state, input.playerId);
  if (!pick.ok) return pick;
  const player = pick.player;

  /**
   * **하루 한 번** (career.md §2) — 사기도 정착도 XP도 서사도 그날 첫 면담만 셈한다.
   * 경기 하나가 하루 안에서 끝나므로 이 문이 곧 "경기당 한 번"이고, 정지점마다 같은
   * 선수를 부르는 것이 폼을 올리는 최적 전략이 되던 자리를 막는다.
   */
  if (player.state.talkedOn === state.date) {
    return {
      ok: true,
      message: `${player.name}과는 오늘 이미 이야기했습니다 — 같은 말이 두 번 남지는 않습니다`,
    };
  }
  player.state.talkedOn = state.date;

  const base = TALK_BASE[input.outcome];
  const delta = Math.round(
    base * (input.intensity / TALK_INTENSITY_PIVOT) * leadershipFactor(state),
  );
  const bounded = Math.max(-TALK_MORALE_BOUND, Math.min(TALK_MORALE_BOUND, delta));
  player.state.form = clampForm(player.state.form + moraleToForm(bounded));

  /**
   * 면담은 방치 이슈를 해소한다 — **잘 풀렸을 때만** (career.md §2). 결과와 무관하게
   * 지우면 화를 내고 나오는 것도 불만 해소책이 되고, 판정이 무엇이 됐든 부르기만 하면
   * 되는 일이 된다.
   */
  const resolvesIssue = base > 0;
  const hadIssue = resolvesIssue && state.issues.some((i) => i.gamePlayerId === player.id);
  if (resolvesIssue) state.issues = state.issues.filter((i) => i.gamePlayerId !== player.id);

  /**
   * 새 영입에게 면담은 **적응의 계기**다 — 아직 못 쓰는 선수에게도 감독이 할 수
   * 있는 일이 있어야 한다. 결과가 나쁘면 오히려 더 겉돈다(음수).
   *
   * ⚠️ **사기가 움직이지 않은 대화(`neutral`)에는 방향이 없다** — 크레딧도 0이다.
   * 부호로 방향을 가르면 0이 음수 쪽에 떨어져, 나쁘지도 않았던 면담이 적응을 뒤로
   * 민다. GM이 매긴 무게(`settling`)도 이 문 앞에서 멈춘다 (player.md §9.3).
   */
  const settlingCredit =
    base === 0
      ? 0
      : creditSettling(state, player.id, "talk", {
          anchor: settlingAnchor("talk", {
            direction: base > 0 ? 1 : -1,
            intensity: input.intensity,
          }),
          ...(input.settling === undefined ? {} : { proposed: input.settling }),
          ...(input.settlingNote === undefined ? {} : { note: input.settlingNote }),
        });
  const settling = settlingCredit !== 0 ? settlingOf(state, player.id) : null;

  /**
   * ── 약속은 **판정이 끝난 뒤에** 장부에 선다 ── (career.md §2 · people.md §5-2)
   *
   * ⚠️ 순서가 뒤집히면 방금 연 약속이 면담의 불만 해소에 쓸려 나갈 여지가 생긴다.
   * 지금 지우는 것은 `state.issues`뿐이라 실제로는 닿지 않지만, 그 안전이 지워지는
   * 자리와 열리는 자리의 **간격**에 기대고 있으므로 순서를 명시적으로 둔다.
   */
  const promised = input.promise
    ? promisePiece(
        openPromise(state, player.id, input.promise.kind, input.promise.days, input.promise.number),
      )
    : null;

  const xpMsg =
    base > 0
      ? grantManagerXP(state, "leadership", TALK_XP_PER_INTENSITY * input.intensity)
      : grantManagerXP(state, "leadership", TALK_XP_ON_FAILURE);
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
      (promised ? promised.text : "") +
      (xpMsg ? ` · ${xpMsg}` : ""),
    brief: {
      head: `${player.name} 면담`,
      items: [
        item({ label: "사기", text: signed(bounded), delta: bounded }),
        ...(hadIssue ? [item({ text: "불만 해소" })] : []),
        ...(settling
          ? [item({ label: "적응", text: `${Math.round(settling.progress * 100)}%` })]
          : []),
        ...(promised ? [promised.item] : []),
      ],
    },
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
 *
 * 같은 사실을 두 폭으로 낸다: `notes`는 모델이 읽는 `message`용(자리 코드까지),
 * `items`는 말풍선 한 줄짜리 요약용(이름과 건수까지).
 */
function lineupChanges(
  state: GameState,
  prev: ReadonlyMap<string, TacticAssignment>,
  next: readonly TacticAssignment[],
): { notes: string[]; items: SkillBriefItem[] } {
  const nameOf = (id: string) => playerName(state, id);
  const pointOf = (a: TacticAssignment) => a.point ?? anchorOf(a.position);
  const sideOf = (list: readonly TacticAssignment[]): LineupSide => {
    const starting = list.filter((a) => a.role === "starting");
    return {
      shape: shapeOf(starting.map(pointOf)),
      starting: starting.map((a) => ({ playerId: a.playerId, position: a.position })),
      squad: list.map((a) => a.playerId),
    };
  };
  const diff = diffLineup(sideOf([...prev.values()]), sideOf(next));

  // 앞선 배치가 없다면(첫 편성) 견줄 것이 없다 — 지금의 모양만 말한다
  if (diff.firstSetup) {
    return {
      notes: [`선발 ${diff.added.length}명 편성 · ${diff.shapeAfter}`],
      items: [item({ label: "선발 편성", text: diff.shapeAfter })],
    };
  }

  const notes: string[] = [];
  const items: SkillBriefItem[] = [];
  if (diff.shapeChanged) {
    const move = `${diff.shapeBefore} → ${diff.shapeAfter}`;
    notes.push(`포메이션 ${move}`);
    items.push(item({ label: "포메이션", text: move }));
  }

  if (diff.added.length > 0) {
    notes.push(
      `선발 투입 ${nameList(
        diff.added.map((s) =>
          s.position ? `${nameOf(s.playerId)} ${s.position}` : nameOf(s.playerId),
        ),
      )}`,
    );
    // 항목에는 포지션 코드를 붙이지 않는다 — 누가 어디에 섰는지는 전술판이 그림으로 갖고 있다
    items.push(
      item({ label: "선발 투입", text: briefNames(diff.added.map((s) => nameOf(s.playerId))) }),
    );
  }
  if (diff.gone.length > 0) {
    const names = diff.gone.map((s) => nameOf(s.playerId));
    notes.push(`선발 제외 ${nameList(names)}`);
    items.push(item({ label: "선발 제외", text: briefNames(names) }));
  }

  /**
   * 남아 있는 선수의 **자리 이동** — 감독이 판에서 가장 자주 하는 조정이고,
   * 인원이 그대로라 다른 항목에는 아무 흔적도 남지 않는다.
   */
  if (diff.moved.length > 0) {
    const moves = diff.moved.map((m) => `${nameOf(m.playerId)} ${m.from} → ${m.to}`);
    notes.push(`자리 이동 ${nameList(moves)}`);
    // 한 명이면 어디서 어디로까지 한 줄에 든다. 여럿이면 이름만 — 자리는 판이 보여준다
    const one = moves[0]!;
    const many = briefNames(diff.moved.map((m) => nameOf(m.playerId)));
    items.push(item({ label: "자리 이동", text: diff.moved.length === 1 ? one : many }));
  }

  if (notes.length > 0) return { notes, items };
  // 선발이 그대로면 남은 차이는 명단 쪽뿐이다 — 누가 오갔는지까지는 적지 않는다
  const line = diff.squadChanged ? "벤치 명단 조정" : "바뀐 것 없음";
  return { notes: [line], items: [item({ text: line })] };
}

/**
 * 라인업 확정 — v6에서는 TACTIC_ASSIGNMENT를 갱신한다 (팀 엔티티에 배열이 없다).
 * 선발 11명·GK 1명·부상/정지 제외를 강제하고, 기존 적응도는 이어받는다.
 *
 * ⚠️ **검증이 전부 끝난 뒤에 적용한다** (→ docs/data/team.md §6). 승격을 먼저
 * 적용하고 배치를 나중에 검증하던 때는 반려된 요청이 승격만 남겼다 — GM 경로는 턴이
 * 끝날 때 저장하므로, "반려했습니다"를 읽은 감독의 스쿼드가 이미 달라져 있었다.
 */
export function setLineup(
  state: GameState,
  input: {
    starting: Array<string | LineupSlotInput>;
    /** 생략하면 **지금 벤치를 지킨다** — 빈 배열이 "비운다"이고 없는 것은 "그대로"다 */
    bench?: Array<string | LineupSlotInput>;
    /**
     * 1·2군 이동을 **같은 요청으로** 처리한다 (승격 → 배치 → 강등 순).
     * 나눠 보내면 "승격은 됐는데 배치는 실패"한 반쪽 상태가 남는다 —
     * 웹 스쿼드 화면이 이미 한 요청으로 저장하는 것과 같은 이유다.
     */
    squadLevels?: Array<{ playerId: string; level: "first" | "reserve" }>;
  },
): SkillResult {
  const tactics = userTactics(state);
  const norm = (x: string | LineupSlotInput): LineupSlotInput =>
    typeof x === "string" ? { playerId: x } : x;

  // ── 검증 ───────────────────────────────────────────────
  // 여기서는 아무것도 바꾸지 않는다. 하나라도 걸리면 상태는 부른 그대로다.

  /** 1·2군 이동 대상 — **실제로 층을 옮기는 선수만** (이미 그 층이면 아무 일도 없다) */
  const promoting: GamePlayer[] = [];
  const demoting: GamePlayer[] = [];
  for (const move of input.squadLevels ?? []) {
    const pick = pickOurPlayer(state, move.playerId);
    if (!pick.ok) return pick;
    if (squadLevelOf(pick.player) === move.level) continue;
    (move.level === "first" ? promoting : demoting).push(pick.player);
  }
  const promotingIds = new Set(promoting.map((p) => p.id));
  const demotingIds = new Set(demoting.map((p) => p.id));

  // 이름으로 부른 자리를 먼저 id로 바꾼다 — 아래 검증(중복·2군·부상)이 전부 id로 돈다
  const resolve = (slots: Array<string | LineupSlotInput>) =>
    slots.map((x) => ourSlot(state, norm(x)));
  const startingPicked = resolve(input.starting);
  const startingFailed = startingPicked.filter((p) => typeof p === "string");
  if (startingFailed.length > 0) return { ok: false, message: startingFailed.join(" · ") };
  const starting = startingPicked.filter((p): p is LineupSlotInput => typeof p !== "string");
  const startingIds = new Set(starting.map((s) => s.playerId));

  /**
   * **벤치를 생략하면 지금 벤치를 지킨다.** 자리 하나만 바꾸는 지시가 벤치를 통째로
   * 지우면 다음 경기의 교체 카드가 통째로 사라진다. 이어받을 때는 이번에 선발이 된
   * 선수와 이번에 내리는 선수를 뺀다 — 그 둘은 감독이 방금 벤치에서 뺀 것이다.
   */
  const inheritedBench = tactics.assignments
    .filter(
      (a) =>
        a.role === "bench" &&
        !startingIds.has(a.playerId) &&
        !demotingIds.has(a.playerId) &&
        // 팀을 떠난 선수의 배치가 남아 있어도 그것 때문에 저장이 막히지는 않는다
        userPlayerById(state, a.playerId) !== undefined,
    )
    .map((a) => ({ playerId: a.playerId, position: a.position }));
  const benchPicked = resolve(input.bench ?? inheritedBench);
  const benchFailed = benchPicked.filter((p) => typeof p === "string");
  if (benchFailed.length > 0) return { ok: false, message: benchFailed.join(" · ") };
  const bench = benchPicked.filter((p): p is LineupSlotInput => typeof p !== "string");

  if (starting.length !== 11) return { ok: false, message: "선발은 정확히 11명이어야 합니다" };
  if (startingIds.size !== 11) {
    return { ok: false, message: "선발에 중복 선수가 있습니다" };
  }
  const overlap = bench.filter((b) => startingIds.has(b.playerId));
  if (overlap.length > 0) {
    return {
      ok: false,
      message: `선발과 벤치에 중복 등재: ${overlap.map((o) => o.playerId).join(", ")}`,
    };
  }
  if (new Set(bench.map((b) => b.playerId)).size !== bench.length) {
    return { ok: false, message: "벤치에 중복 선수가 있습니다" };
  }
  // 벤치 정원 — 화면·라우트와 같은 값 하나를 읽는다 (→ docs/data/team.md §6)
  if (bench.length > MATCHDAY_BENCH) {
    return { ok: false, message: `벤치는 ${MATCHDAY_BENCH}명까지입니다 (${bench.length}명)` };
  }

  const all = [...starting, ...bench];
  // 이 요청이 함께 올리는 선수는 이미 1군인 셈으로 본다 — 승격은 배치보다 앞에 적용된다
  const reserves = all.filter((s) => {
    const player = userPlayerById(state, s.playerId);
    return player && squadLevelOf(player) === "reserve" && !promotingIds.has(s.playerId);
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

  // 명시된 포지션 코드는 먼저 검증한다 — **벤치도 함께**. 벤치 코드는 좌표를 갖지
  // 않을 뿐 배치에 그대로 적히므로, 안 보면 알 수 없는 코드가 명단에 남는다
  const unknownPos = all
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

  /**
   * 승격 가능 여부는 **누적으로** 잰다 — 한 명씩 따로 재면 남은 한 자리에 둘이 함께
   * 들어간다고 답한다. 실제로 올리는 것은 검증이 다 끝난 뒤다.
   *
   * 이번에 내리는 선수가 비우는 자리도 함께 셈한다(`demotingIds`) — `set_squad_level`이
   * 쓰는 셈과 같은 것이다(→ docs/data/team.md §6). 여기만 빼면 명단이 찬 팀의 "하나
   * 내리고 하나 올려"가 전술판에서만 반려된다.
   */
  if (promoting.length > 0) {
    const allowed = canRegisterAllFor(state, promoting, state.userTeamId, demotingIds);
    if (!allowed.ok) {
      return {
        ok: false,
        message: `${playerName(state, allowed.playerId)}: ${registrationBlockText(allowed.block)}`,
      };
    }
  }
  /**
   * **이번 배치에 앉힌 선수는 이번에 내리지 못한다.** 강등은 배치보다 뒤에 적용되므로
   * 그냥 통과시키면 방금 세운 선발에서 다시 빠져 열 명짜리 라인업이 남는다.
   */
  const seated = demoting.filter(
    (p) => startingIds.has(p.id) || bench.some((b) => b.playerId === p.id),
  );
  if (seated.length > 0) {
    return {
      ok: false,
      message: `이번 배치에 든 선수는 2군으로 내릴 수 없습니다: ${seated.map((p) => p.name).join(", ")}`,
    };
  }
  if (demoting.length > 0) {
    const firstAfter =
      userPlayers(state).filter((p) => squadLevelOf(p) === "first").length +
      promoting.length -
      demoting.length;
    if (firstAfter < MATCHDAY_SQUAD) {
      return { ok: false, message: matchdaySquadFloor() };
    }
  }

  // ── 적용 ───────────────────────────────────────────────
  // 여기서부터는 실패하지 않는다 — 실패할 수 있는 것은 위에서 전부 걸렀다.
  const levelNotes: string[] = [];
  const levelMoved: Record<"first" | "reserve", string[]> = { first: [], reserve: [] };
  /**
   * 승격 먼저 — 2군 선수를 선발에 넣으려면 올라와 있어야 한다.
   *
   * **재는 걸음과 옮기는 걸음을 갈라 둔다**(`applySquadLevel` — team.md §5). 옮기는
   * 순간마다 `setSquadLevel`로 혼자 다시 재면, 강등이 배치 뒤에 오는 이 순서에서는
   * 올릴 때 명단이 아직 차 있다 — 위에서 통과시킨 교대가 적용 중에 걸린다.
   */
  for (const player of promoting) {
    levelNotes.push(applySquadLevel(state, player, "first"));
    levelMoved.first.push(player.name);
  }

  // 처음 배치되는 선수(2군에서 올라왔거나 갓 영입된)는 이 전술을 훈련한 적이 없다.
  // 기준선(60)을 그냥 주면 **팀이 재적응 중일 때 신입이 고참보다 전술을 잘 아는**
  // 역전이 생긴다 — 팀 수준을 넘지 못하게 막는다.
  const teamLevel = currentFamiliarity(tactics);
  const newcomerFamiliarity = Math.min(FAMILIARITY_BASELINE, teamLevel);
  /**
   * **덮어쓰기 전에 지금의 역할을 기억으로 넘긴다** (→ docs/data/player.md §3.2).
   * 배치는 여기서 통째로 다시 써지므로, 벤치·예비로 내려가는 선수의 역할은 이
   * 한 줄이 아니면 사라진다. 자리를 지키는 선수까지 함께 적는 건 같은 값을 다시
   * 쓰는 것뿐이다 — 기억은 언제나 "그 자리에서 마지막에 맡긴 것"이다.
   */
  for (const old of prev.values()) {
    if (old.roleId) rememberRole(state, old.playerId, old.position, old.roleId);
  }
  /**
   * 이전 배치에서 물려받는 것 — 적응도·개인 기억·개인 지시, 그리고 **자리가 같을
   * 때만 역할**. 자리가 바뀌면 그 역할은 존재하지 않는다(센터백의 리베로를 윙에
   * 데려갈 수 없다). 대신 그 자리의 **기억**이 기본 역할을 갈아끼운다 — 감독이 새로
   * 고르면 그게 이긴다. 벤치는 자리를 갖지 않으므로 역할도 들지 않는다 (위에서
   * 기억이 받아 갔다).
   *
   * 직전 배치가 없으면 **선반**을 본다 — 2군을 다녀왔거나 매치데이 명단 밖에 있던
   * 선수의 적응도·기억이 거기 있다 (→ docs/data/player.md §7.3).
   */
  const inherit = (playerId: string, position: string, slotted: boolean) => {
    /** 배치가 들고 있던 것과 선반이 들고 있던 것의 공통분모 — 선반엔 자리가 없다 */
    const old: Partial<TacticAssignment> | undefined =
      prev.get(playerId) ?? unshelveFamiliarity(tactics, playerId);
    /**
     * 되찾기 3단은 **도메인이 하나로 갖는다**(`inheritedRole`) — 전술판이 저장을
     * 기다리는 동안 부르는 그 함수다. 여기서 순서를 따로 밟으면 감독이 누른 적 없는
     * 역할 변경이 자동 저장 응답과 함께 혼자 일어난다.
     */
    const roleId = !slotted
      ? undefined
      : inheritedRole(position, old?.roleId, recallRole(state, playerId, position));
    /**
     * **오늘 역할을 손댄 흔적은 살려 둔다.** 전술판은 조작마다 배치를 다시
     * 쓰는데, 여기서 memo가 사라지면 저장할 때마다 "오늘 아침"이 새로 잡혀
     * 같은 결정에 값을 여러 번 치른다 — 자동 저장에 얹은 의미가 없어진다.
     * 장부의 기준은 (선수·오늘)이라 **자리를 옮겨도 따라간다** — 낸 값을 되돌릴
     * 통로가 이것뿐이라, 여기서 버리면 왕복이 환불이 아니라 두 배가 된다.
     * 지금 자리에 맞춘 정산은 배치가 다 선 뒤에 한 번에 한다(`settleRoleCost`).
     */
    return {
      familiarity: old?.familiarity ?? newcomerFamiliarity,
      // 개인 기억은 배치보다 오래 산다 — 여기서 흘리면 저장 한 번에 통째로 사라진다
      ...(old?.drilled ? { drilled: old.drilled } : {}),
      ...(old?.instruction ? { instruction: old.instruction } : {}),
      ...(old?.directive ? { directive: old.directive } : {}),
      ...(roleId ? { roleId } : {}),
      ...(old?.roleMemo ? { roleMemo: old.roleMemo } : {}),
    };
  };
  const startingAssignments: TacticAssignment[] = starting.map((s, i) => ({
    playerId: s.playerId,
    role: "starting",
    position: startCodes[i]!,
    point: startPoints[i]!,
    ...inherit(s.playerId, startCodes[i]!, true),
  }));
  // 벤치는 전술판에 없으므로 좌표를 두지 않는다 (선발만 자리를 갖는다)
  const benchAssignments: TacticAssignment[] = bench.map((s) => {
    const position = (
      s.position ?? naturalPositionOf(userPlayerById(state, s.playerId)!).position
    ).toUpperCase();
    return {
      playerId: s.playerId,
      role: "bench" as const,
      position,
      ...inherit(s.playerId, position, false),
    };
  });

  /**
   * 오늘 낸 역할 대가를 **지금 자리 기준으로** 정산한다 — 선발은 그 자리의 역할로,
   * 벤치는 자리가 없으므로 환불이다. 정산이 없으면 자리를 옮겼다 되돌리는 것만으로
   * 같은 대가를 두 번 문다 (→ docs/data/player.md §7.2).
   */
  for (const a of startingAssignments) settleRoleCost(a, state.date, a);
  for (const a of benchAssignments) settleRoleCost(a, state.date, null);

  /**
   * 명단에서 빠진 선수의 적응도·기억은 **선반으로** — 매치데이 명단 밖(예비)은
   * 배치를 갖지 않으므로, 여기서 옮기지 않으면 다음에 뽑힐 때 신입 취급을 받는다.
   */
  const assigned = new Set([...startingAssignments, ...benchAssignments].map((a) => a.playerId));
  for (const old of prev.values()) {
    if (!assigned.has(old.playerId)) shelveFamiliarity(tactics, old, state.date);
  }

  // 무엇이 달라졌나는 **덮어쓰기 전에** 견준다 (`prev`가 옛 배치를 들고 있다)
  const changes = lineupChanges(state, prev, [...startingAssignments, ...benchAssignments]);
  tactics.assignments = [...startingAssignments, ...benchAssignments];
  // 모양 이름은 실제 좌표에서 읽는다 — 프리셋 다섯 밖의 숫자도 그대로 담긴다
  tactics.spec.formation = shapeOf(startPoints);

  // 강등은 배치 뒤에 — 배치에서 빠진 뒤라야 2군으로 내려도 라인업이 안 깨진다.
  // 여기도 다시 재지 않는다: 하한은 오르내리는 인원을 다 셈한 뒤의 수로 위에서 쟀다
  for (const player of demoting) {
    levelNotes.push(applySquadLevel(state, player, "reserve"));
    levelMoved.reserve.push(player.name);
  }
  const items = [...changes.items];
  /**
   * **오늘 세운 열한 명 중 위험이 높은 사람** (player.md §5.3) — 명단이 확정되는
   * 그 자리에서만 뜻이 있는 항목이라, 배치가 그대로여도 선다. 선발만 센다:
   * 벤치의 위험은 감독이 그를 넣기로 하는 그 순간의 결정이다.
   */
  const atRisk = startingAssignments
    .map((a) => userPlayerById(state, a.playerId))
    .filter((p): p is GamePlayer => p !== null && injuryRiskFor(p).grade === "high");
  if (atRisk.length > 0) {
    items.push(item({ label: "부상 위험", text: briefNames(atRisk.map((p) => p.name)) }));
  }
  if (levelMoved.first.length > 0) {
    items.push(item({ label: "1군 승격", text: briefNames(levelMoved.first) }));
  }
  if (levelMoved.reserve.length > 0) {
    items.push(item({ label: "2군 이동", text: briefNames(levelMoved.reserve) }));
  }
  return {
    ok: true,
    message: `라인업 확정 — ${[...changes.notes, ...levelNotes].join(" · ")}`,
    brief: { head: "라인업 확정", items },
  };
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
  const nameOf = (id: string) => playerById(state, id)?.name ?? id;
  const diff = diffLineup(
    {
      shape: before.shape,
      starting: before.starting.map((playerId) => ({ playerId })),
      signature: before.signature,
    },
    {
      shape: shapeOfTactics(state),
      starting: userTactics(state)
        .assignments.filter((a) => a.role === "starting")
        .map((a) => ({ playerId: a.playerId, position: a.position })),
      signature: lineupSignature(state),
    },
  );

  const parts: string[] = [];
  if (diff.shapeChanged) parts.push(`포메이션 ${diff.shapeBefore} → ${diff.shapeAfter}`);
  const names = (slots: readonly LineupSlotRef[]) =>
    slots.map((s) => nameOf(s.playerId)).join(", ") || "없음";
  if (diff.added.length > 0 || diff.gone.length > 0) {
    parts.push(`선발 교체 — 들어옴: ${names(diff.added)} / 빠짐: ${names(diff.gone)}`);
  } else if (parts.length === 0 && diff.pointsChanged === true) {
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
    /** 개인 지시 — 자유 서술 + 선택적 종류·대상·세기 */
    instruction?: {
      note: string;
      kind?: PlayerDirectiveKind;
      targetId?: string;
      intensity?: DirectiveIntensity;
    };
  },
): SkillResult {
  const notes: string[] = [];
  /** 항목은 하위 스킬이 각자 낸 것을 잇는다 — 세 조각이 한 줄로 엉키지 않게 */
  const items: SkillBriefItem[] = [];
  /** 이미 바꾼 것이 있는가 — 있으면 뒤따르는 반려는 되돌리지 않고 결과로 적는다 */
  let changed = false;
  const take = (res: SkillResult) => {
    notes.push(res.message);
    items.push(...(res.brief?.items ?? []));
    if (res.unchanged !== true) changed = true;
  };
  /**
   * **부분 성공은 반려가 아니라 결과다** (→ docs/data/player.md §3.1).
   * 아직 아무것도 안 바꿨으면 통째로 반려하고, 이미 바꿨으면 반려 사유를 결과에 싣는다
   * — `ok: false`로 답하면 화면이 칩도 말풍선도 세우지 않아, 자리는 옮겨졌는데
   * 감독은 아무 일도 없었다고 읽는다.
   */
  const rejected: string[] = [];
  /** 반려를 어디로 보낼지 — 통째로 반려면 그 결과를, 결과에 실을 것이면 null을 낸다 */
  const reject = (res: SkillResult): SkillResult | null => {
    if (!changed) return res;
    rejected.push(res.message);
    return null;
  };

  if (input.position !== undefined || input.point !== undefined || input.move !== undefined) {
    const res = movePlayerSlot(state, {
      playerId: input.playerId,
      ...(input.position ? { position: input.position } : {}),
      ...(input.point ? { point: input.point } : {}),
      ...(input.move ? { move: input.move } : {}),
    });
    if (!res.ok) {
      const stop = reject(res);
      if (stop) return stop;
    } else take(res);
  }
  if (input.role !== undefined) {
    const res = setPlayerRole(state, { playerId: input.playerId, role: input.role });
    if (!res.ok) {
      const stop = reject(res);
      if (stop) return stop;
    } else take(res);
  }
  if (input.instruction !== undefined) {
    const res = setPlayerInstruction(state, { playerId: input.playerId, ...input.instruction });
    if (!res.ok) {
      const stop = reject(res);
      if (stop) return stop;
    } else take(res);
  }
  if (notes.length === 0) return { ok: false, message: "바꿀 것을 하나는 지정해야 합니다" };
  if (rejected.length > 0) {
    notes.push(`반려 ${rejected.join(" · ")}`);
    items.push(item({ label: "반려", text: rejected.join(" · ") }));
  }
  // 머리줄은 선수 하나 — 세 항목이 누구 이야기인지는 한 번만 적으면 된다
  const named = pickOurPlayer(state, input.playerId);
  return {
    ok: true,
    message: notes.join(" · "),
    ...(changed ? {} : { unchanged: true }),
    ...(items.length > 0
      ? { brief: { head: named.ok ? named.player.name : input.playerId, items } }
      : {}),
  };
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
  const pick = pickOurPlayer(state, input.playerId);
  if (!pick.ok) return pick;
  const player = pick.player;
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
    // 옮길 것이 없었던 것은 실패가 아니다 — 역할·지시만 바꾸는 호출을 막지 않는다
    return { ok: true, unchanged: true, message: `${player.name}은(는) 이미 ${code}입니다` };
  }
  const before = assignment.position;
  if (
    assignment.position !== code &&
    !(assignment.roleId && rolesFor(code).some((role) => role.id === assignment.roleId))
  ) {
    // 버려지는 역할은 **옛 자리 기준으로** 기억에 남는다 (→ docs/data/player.md §3.2)
    if (assignment.roleId) rememberRole(state, player.id, assignment.position, assignment.roleId);
    /**
     * 새 자리의 기억이 그 자리의 기본 역할을 갈아끼운다. 배치에 적어 두는 이유:
     * 화면·전력·경기가 모두 `assignment.roleId`를 읽으므로, 기억이 배치 밖에만
     * 남으면 같은 선수의 역할이 두 값으로 갈린다.
     */
    const recalled = recallRole(state, player.id, code);
    if (recalled) assignment.roleId = recalled;
    else delete assignment.roleId;
  }
  assignment.position = code;
  assignment.point = point;
  /**
   * 자리가 바뀌었으니 오늘 낸 역할 대가를 다시 정산한다 — `setLineup`과 같은 함수다
   * (→ docs/data/player.md §7.2). 두 경로가 memo를 다르게 다루면, 화면이 어느 쪽으로
   * 저장했느냐에 따라 같은 조작의 값이 달라진다.
   */
  settleRoleCost(assignment, state.date, assignment);
  tactics.spec.formation = shapeOf(
    tactics.assignments
      .filter((a) => a.role === "starting")
      .map((a) => a.point ?? anchorOf(a.position)),
  );
  const fit = player.positions.find((p) => p.position === code)?.proficiency ?? null;
  return {
    ok: true,
    message:
      `${player.name} ${before} → ${code}` +
      (fit === null ? " (해 본 적 없는 자리입니다)" : ` (자리 적응도 ${fit})`),
    brief: {
      head: player.name,
      // 머리줄이 이미 이름을 들고 있다 — 항목은 자리만, 적응도는 갈래로 뒤에
      items: [
        item({
          label: "자리",
          text: `${before} → ${code}`,
          note: fit === null ? "해 본 적 없음" : `적응도 ${fit}`,
        }),
      ],
    },
  };
}

/**
 * 개인 훈련 — **팀 훈련 위에 한 선수만 겨냥해 얹는다.**
 *
 * 축(`axis`)도 자리(`position`)도 훈련 결산(LLM)의 입력이고, 자리는 결산 한 번에
 * `POSITION_TRAIN_MAX`까지만 오른다 — **실전보다 느리게**(경기 1회 = +1).
 * "자리는 커리어가 만든다"를 지키되 전향이라는 판단이 가능해진다.
 *
 * ⚠️ **층마다 닿는 것이 다르다** (season.md §2). 2군은 결산을 받지 않으므로 축은
 * 월간 성장의 겨냥으로 넘어가고, **자리는 갈 곳이 없어 반려한다** — 걸어 두고
 * 기다리게 하는 것이 거짓 성공이다.
 */
export function setPlayerTraining(
  state: GameState,
  input: { playerId: string; axis?: string; position?: string; clear?: boolean },
): SkillResult {
  const pick = pickOurPlayer(state, input.playerId);
  if (!pick.ok) return pick;
  const player = pick.player;
  const index = state.playerTraining.findIndex((t) => t.gamePlayerId === player.id);

  if (input.clear || (!input.axis && !input.position)) {
    if (index < 0) return { ok: false, message: `${player.name}에게 걸린 개인 훈련이 없습니다` };
    state.playerTraining.splice(index, 1);
    return {
      ok: true,
      message: `${player.name}의 개인 훈련을 거뒀습니다`,
      brief: { head: `${player.name} 개인 훈련`, items: [item({ text: "거둠" })] },
    };
  }

  const axis = attributeAxisOf(input.axis?.trim());
  if (input.axis?.trim() && !axis) {
    return { ok: false, message: `알 수 없는 능력치 축: ${input.axis.trim()}` };
  }
  const position = input.position?.toUpperCase();
  if (position && !positionGroupOf(position)) {
    return { ok: false, message: `알 수 없는 포지션: ${input.position}` };
  }
  // 반려는 요청 전체에 걸린다 — 자리만 떼고 축만 걸면 감독이 시킨 적 없는 훈련이 선다
  if (position && squadLevelOf(player) === "reserve") {
    return {
      ok: false,
      message: `${player.name}은(는) 2군이라 자리를 배울 수 없습니다 — 자리는 훈련 결산이 올리고 2군은 결산을 받지 않습니다. 1군으로 올린 뒤에 거세요`,
    };
  }

  const program = {
    gamePlayerId: player.id,
    ...(axis ? { axis } : {}),
    ...(position ? { position } : {}),
    since: state.date,
  };
  if (index >= 0) state.playerTraining[index] = program;
  else state.playerTraining.push(program);

  const parts: string[] = [];
  const items: SkillBriefItem[] = [];
  if (axis) {
    const ko = AXIS_KO[axis];
    parts.push(ko);
    items.push(item({ label: "능력치", text: ko }));
  }
  if (position) {
    const fit = player.positions.find((p) => p.position === position)?.proficiency ?? 0;
    parts.push(`${position} 전향 (지금 적응도 ${fit})`);
    items.push(item({ label: "전향", text: position, note: `적응도 ${fit}` }));
  }
  // 어디에 닿는지까지 답한다 — 층에 따라 경로가 갈린다 (season.md §2)
  const where = squadLevelOf(player) === "reserve" ? " (2군 — 월간 성장의 축 배율)" : "";
  return {
    ok: true,
    message: `${player.name} 개인 훈련 — ${parts.join(" · ")}${where}`,
    brief: { head: `${player.name} 개인 훈련`, items },
  };
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
 *
 * ⚠️ **선발만 자리를 갖는다** — 벤치 배치의 `position`은 좌표가 아니라 주 포지션이라,
 * 그걸로 검증하면 화면이 말하는 자리와 다른 목록으로 반려한다 (player.md §3.1).
 */
export function setPlayerRole(
  state: GameState,
  input: { playerId: string; role: string },
): SkillResult {
  const pick = pickOurPlayer(state, input.playerId);
  if (!pick.ok) return pick;
  const player = pick.player;
  const tactics = userTactics(state);
  const assignment = tactics.assignments.find((a) => a.playerId === player.id);
  if (!assignment) {
    return { ok: false, message: `${player.name}은 배치가 없습니다 — 먼저 선발·벤치에 넣으세요` };
  }
  if (assignment.role !== "starting") {
    return { ok: false, message: `${player.name}은 자리가 없습니다 — 먼저 선발로 세우세요` };
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
    // 바뀐 것이 없다는 사실은 **반환값이** 말한다 (→ docs/data/player.md §3.1) —
    // 표식이 없으면 `setPlayerTactic`이 이 걸음을 "바꿨다"로 세어 뒤따르는 반려를 접는다
    return { ok: true, unchanged: true, message: `${player.name}은 이미 ${def.ko}입니다` };
  }

  /**
   * 역할을 바꾸면 **그 선수의 전술 적응도가 깎인다** — 자리는 그대로여도 하는 일이
   * 달라지기 때문이다. 대가는 하드코딩하지 않고 **역할 델타의 거리**에서 뽑는다
   * (`roleChangeCost`): 볼 플레잉 → 리베로는 둘 다 발로 푸는 수비수라 싸고,
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
  assignment.roleMemo =
    assignment.roleMemo?.date === state.date
      ? assignment.roleMemo
      : { date: state.date, position: assignment.position, role: from, paid: 0 };
  assignment.roleId = def.id;
  // 감독이 고른 것이 그 자리의 새 기억이다 — 벤치를 다녀와도 이 결정이 남는다
  rememberRole(state, player.id, assignment.position, def.id);
  // 오늘 이미 낸 것과의 차액만 — 왔다 갔다 해도 누적되지 않는다
  settleRoleCost(assignment, state.date, assignment);

  /**
   * 결과는 **무엇을 시키기로 했는지**만 말한다 (player.md §7.2). 적응도 증감을
   * 붙이면 역할 선택이 가장 싼 역할 고르기가 된다 — 하루면 기준이 다시 잡히는
   * 값이라 그 대가가 화면에서 가장 눈에 띌 이유가 없다. 명단의 적응도 게이지가
   * 지금 상태를 말한다.
   */
  return {
    ok: true,
    message: `${player.name} ${assignment.position} 역할 → ${def.ko}`,
    brief: {
      head: player.name,
      // 역할 이름은 **전술판 칩과 같은 표기로** 낸다 — 화면이 긴 이름을 줄이면
      // 그 치환이 코어 문구를 되쪼개는 일이 되고, 표가 바뀌면 조용히 어긋난다
      items: [item({ label: `${assignment.position} 역할`, text: def.abbr })],
    },
  };
}

export function setPlayerPosition(
  state: GameState,
  input: { playerId: string; position: string },
): SkillResult {
  const pick = pickOurPlayer(state, input.playerId);
  if (!pick.ok) return pick;
  const player = pick.player;
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
    // 처음 맡는 자리 — 인접도 기반 초기 적응도로 시작한다. 저장은 **주발을 벗긴
    // 원값**이다: 보정을 적어 두면 조회가 다시 얹는다 (player.md §8)
    player.positions.push({
      position: code,
      proficiency: storedProficiencyFor(player.positions, code),
      isNatural: true,
    });
  }
  recomputeOverall(player);
  return {
    ok: true,
    message: `${player.name} 주 포지션 → ${code} (OVR ${player.attributes.overall})`,
  };
}

/** 죽은 공 자리의 이름 — 감독에게 되돌아가는 말이 여기 한 벌 산다 */
const SET_PIECE_ROLE_KO: Record<SetPieceRole, string> = {
  corner: "코너",
  freeKick: "프리킥",
  penalty: "페널티",
};

/**
 * **죽은 공 키커 지정** — "코너는 사카가 차", "페널티는 네 거야" (match.md §1.4).
 *
 * 셋 중 말한 자리만 바뀐다. `null`을 주면 지정이 풀려 코어의 기본값(그라운드 위
 * 킥력 최고 · `penaltySkill` 최고)으로 돌아간다 — 감독이 손을 떼는 길이 있어야
 * 한 번 지정한 사람이 팔린 뒤에도 그 이름이 남지 않는다.
 *
 * 평시와 경기 중이 같은 스킬을 지난다. 지정은 팀 전술에 남으므로 그라운드에 없는
 * 선수를 지목해도 반려하지 않는다 — 다음 경기의 선발일 수 있다. 그 경기에서만
 * 기본값이 설 뿐이다.
 */
export function setSetPieceTakers(
  state: GameState,
  input: Partial<Record<SetPieceRole, string | null>>,
): SkillResult {
  const tactics = userTactics(state);
  const next: SetPieceTakers = { ...(tactics.setPieceTakers ?? {}) };
  const notes: string[] = [];
  const items: SkillBriefItem[] = [];
  let changed = false;
  for (const role of SET_PIECE_ROLES) {
    const ref = input[role];
    if (ref === undefined) continue;
    if (ref === null) {
      if (next[role] === undefined) continue;
      delete next[role];
      changed = true;
      notes.push(`${SET_PIECE_ROLE_KO[role]} 키커 지정 해제`);
      items.push(item({ label: SET_PIECE_ROLE_KO[role], text: "지정 해제" }));
      continue;
    }
    const pick = pickOurPlayer(state, ref);
    if (!pick.ok) return pick;
    next[role] = pick.player.id;
    changed = true;
    notes.push(`${SET_PIECE_ROLE_KO[role]} — ${pick.player.name}`);
    items.push(item({ label: SET_PIECE_ROLE_KO[role], text: pick.player.name }));
  }
  if (!changed) {
    return { ok: true, message: "바뀐 키커가 없습니다", unchanged: true };
  }
  tactics.setPieceTakers = next;
  return {
    ok: true,
    message: `죽은 공 키커 — ${notes.join(" · ")}`,
    brief: { head: "세트피스 키커", items },
  };
}

/** 완장을 **처음** 채운 날의 체력 — 라커룸 한가운데 서는 일이다 (career.md §2) */
const CAPTAIN_FIRST_LIFT = 4;

/** 완장을 채운 사람의 근거 한 줄 — 리더십과 재적이 결과 항목에 그대로 선다 */
function armbandNote(state: GameState, player: GamePlayer): string {
  const row = leaderGroupOf(state, player.teamId).find((r) => r.playerId === player.id);
  const tenure = row && row.seasons > 0 ? ` · ${row.seasons}시즌 ${row.apps}경기` : "";
  return `리더십 ${player.attributes.leadership}${tenure}`;
}

/**
 * **완장은 둘이다** — 주장과 부주장 (→ docs/data/people.md §5-1).
 *
 * 서열은 저장하지 않고 파생하지만 이 둘만은 저장한다: 장부 어디에서도 파생되지 않는
 * **감독의 결정**이기 때문이다. 한 요청이 둘 다 옮길 수 있고, 말한 자리만 바뀐다 —
 * `vice: null`은 부주장 지정을 푼다.
 */
export function setCaptain(
  state: GameState,
  input: { playerId?: string | null; vice?: string | null },
): SkillResult {
  const items: SkillBriefItem[] = [];
  const notes: string[] = [];

  if (input.playerId !== undefined && input.playerId !== null) {
    const pick = pickOurPlayer(state, input.playerId);
    if (!pick.ok) return pick;
    const player = pick.player;
    // 팀당 1명 — 기존 주장 해제. 부주장이 완장을 올려 받으면 그 자리는 빈다
    for (const p of userPlayers(state)) p.isCaptain = false;
    player.isCaptain = true;
    if (player.isViceCaptain === true) player.isViceCaptain = undefined;
    /**
     * **체력 보너스는 선수당 첫 지명에만** (career.md §2). 완장은 몇 번이고 오가지만
     * 처음 채워지는 순간의 무게는 한 번뿐이다 — 문이 없으면 두 선수를 번갈아 지명하는
     * 것만으로 둘 다 체력이 100이 된다.
     */
    if (player.state.captainedOn === undefined) {
      player.state.captainedOn = state.date;
      player.state.condition = clampCondition(player.state.condition + CAPTAIN_FIRST_LIFT);
    }
    // 새 영입에게 완장을 채우는 건 라커룸 한가운데 세우는 일이다 (settling.ts)
    const settled = creditSettling(state, player.id, "captain") > 0;
    const settling = settled ? settlingOf(state, player.id) : null;
    notes.push(`${player.name}을(를) 주장으로 지명했습니다`);
    items.push(item({ label: "주장", text: player.name, note: armbandNote(state, player) }));
    if (settling) {
      const percent = Math.round(settling.progress * 100);
      notes.push(`적응 ${percent}%`);
      items.push(item({ label: "적응", text: `${percent}%` }));
    }
  }

  if (input.vice !== undefined) {
    if (input.vice === null) {
      const before = userPlayers(state).find((p) => p.isViceCaptain === true);
      if (before) {
        before.isViceCaptain = undefined;
        notes.push("부주장 지정을 해제했습니다");
        items.push(item({ label: "부주장", text: "지정 해제" }));
      }
    } else {
      const pick = pickOurPlayer(state, input.vice);
      if (!pick.ok) return pick;
      const vice = pick.player;
      if (vice.isCaptain) {
        return {
          ok: false,
          message: `${vice.name}은(는) 이미 주장입니다 — 완장은 한 사람에 하나입니다`,
        };
      }
      for (const p of userPlayers(state)) p.isViceCaptain = undefined;
      vice.isViceCaptain = true;
      /**
       * **부주장에는 체력도 정착 크레딧도 붙지 않는다** (career.md §2) — 완장 둘에
       * 같은 값을 매기면 감독이 두 번 받으려고 두 자리를 채운다.
       */
      notes.push(`${vice.name}을(를) 부주장으로 지명했습니다`);
      items.push(item({ label: "부주장", text: vice.name, note: armbandNote(state, vice) }));
    }
  }

  if (items.length === 0) return { ok: true, message: "바뀐 완장이 없습니다", unchanged: true };
  return {
    ok: true,
    message: notes.join(" · "),
    brief: { head: "완장", items },
  };
}

// ── 등번호 — 감독이 주고, 선수가 뜻을 둔다 (docs/data/player.md §1.1) ──

/**
 * 번호를 잃은 선수의 사기 — **곁들임이라 폭이 작다** (people.md §5).
 *
 * 그 일이 라커룸에 남는가는 불만이 정하고(`numberGrievanceStands`), 이 값은 불만이
 * 서든 안 서든 얹힌다 — 셔츠가 바뀐 날은 애착 없는 사람에게도 있다. 어긴 약속(−8)과
 * 같은 폭을 주면 번호 하나를 옮기는 것이 감독이 한 말을 뒤집는 것과 같은 무게가 된다.
 */
const NUMBER_LOST_MORALE = -3;

/**
 * 번호를 물려받은 선수의 사기 — **앞사람이 있을 때만 선다** (player.md §1.1).
 * 빈 번호를 받는 것은 사건이 아니라 배정이고, 계보에는 실제로 그 셔츠를 입고 뛴
 * 사람만 서기 때문이다.
 */
const NUMBER_INHERIT_MORALE = 4;

/**
 * **감독이 지목한 등번호** (`set_squad_number` — player.md §1.1).
 *
 * 배정과 반려는 코어가 하고(`assignRequestedNumber`), 여기서 하는 일은 그 사실을
 * 라커룸에 옮기는 것뿐이다: 번호를 잃은 선수의 불만과 사기, 계보를 물려받은
 * 선수의 사기. 중복은 기본이 반려라 `take` 없이 동료의 번호를 조용히 가져가지
 * 않는다 — 감독이 모르는 사이에 라커룸이 움직이지 않게.
 */
export function setSquadNumber(
  state: GameState,
  input: { playerId: string; number: number; take?: boolean },
): SkillResult {
  const pick = pickOurPlayer(state, input.playerId);
  if (!pick.ok) return pick;
  const player = pick.player;

  const assigned = assignRequestedNumber(state, player, input.number, { take: input.take });
  if (!assigned.ok) return { ok: false, message: numberBlockText(assigned.block) };
  const { number, from, displaced, after } = assigned.assignment;

  if (from === number && displaced === null) {
    // 바뀐 것이 없다는 사실은 **반환값이** 말한다 — 부르는 쪽이 문구를 뒤지지 않게
    return { ok: true, unchanged: true, message: `${player.name}은(는) 이미 ${number}번입니다` };
  }

  const notes: string[] = [
    from === null ? `${player.name} ${number}번` : `${player.name} ${from}번 → ${number}번`,
  ];
  const items: SkillBriefItem[] = [
    item({
      label: "등번호",
      text: `${number}번`,
      ...(from === null ? {} : { note: `${from}번 → ${number}번` }),
    }),
  ];

  if (after) {
    /**
     * 물려받음은 **계보가 있을 때만 사건이다.** 지난 시즌 그 셔츠를 입고 뛴 사람이
     * 있다는 것이 이 번호에 무게가 실려 있다는 뜻이고, 그것을 감독이 지목했다.
     */
    player.state.form = clampForm(player.state.form + moraleToForm(NUMBER_INHERIT_MORALE));
    const gap = state.season - after.lastSeason;
    notes.push(`${after.name}의 번호를 잇는다`);
    items.push(
      item({
        label: "계보",
        text: `${after.name} 뒤`,
        note: `${after.seasons}시즌 · ${gap > 0 ? `${gap}시즌 만에` : "이번 시즌"}`,
      }),
    );
  }

  if (displaced) {
    const other = displaced.player;
    /**
     * **불만이 서는가는 원형이 정한다** (people.md §5) — 애착 없는 사람에게 10번은
     * 그냥 옷이고, 애착 있는 사람에게도 어제 받은 34번은 아무것도 아니다. 굴림은
     * 없다: 감독이 무엇을 건드렸는지 셀 수 있어야 손잡이가 된다.
     */
    const stands = numberGrievanceStands(
      archetypeTraitsOf(state.seed, other).number,
      displaced.lost,
      displaced.seasons,
    );
    // 한 선수의 불만 줄은 하나다 — 약속 판정이 세울 때와 같은 문 (squad/promises.ts)
    if (stands && !state.issues.some((i) => i.gamePlayerId === other.id)) {
      state.issues.push({
        gamePlayerId: other.id,
        kind: "unhappy",
        reason: "number",
        count: displaced.lost,
        since: state.date,
      });
    }
    other.state.form = clampForm(other.state.form + moraleToForm(NUMBER_LOST_MORALE));
    notes.push(`${other.name} ${displaced.lost}번 → ${displaced.gained}번`);
    items.push(
      item({
        label: "내준 선수",
        text: `${other.name} ${displaced.lost}번 → ${displaced.gained}번`,
      }),
    );
    pushNarrative(
      state,
      `${other.name}의 ${displaced.lost}번을 ${player.name}에게 — ${other.name}은(는) ${displaced.gained}번`,
      3,
    );
  }

  return { ok: true, message: notes.join(" · "), brief: { head: "등번호", items } };
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
 * ⚠️ **시간만으로는 적응도가 오르지 않는다.** 날마다 그냥 올리면 아무것도 안
 * 해도 전술이 몸에 붙는다 — 훈련장에서 시간을 쓰는 선택과 달력을 넘기는 선택이
 * 같아진다. 적응도는 **훈련과 실전에서만** 온다.
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
 * **판단 계열**이라 스카우팅으로도 오차가 남는 축이고(player.md §9),
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
 * 경기 중 전술 변경이 치르는 적응도 대가의 비율 — 훈련장에서 바꿀 때의 몇 배인가.
 * ⚠️ 밸런스 값. AI 벤치가 판을 갈아 깔 때의 대가도 여기서 파생한다
 * (`match-flow`의 `AI_SHAPE_FAMILIARITY_COST`) — 두 벤치가 다른 값을 치르지 않는다.
 */
export const IN_MATCH_FAMILIARITY_LOSS = 0.25;

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
 * 각자 자기 기억을 가지므로 **개인의 도착 수준을 직접** 구한다 — 팀 적응도는
 * 그 값들의 평균(파생)이고, 왕복은 기억이 닫는다.
 */
function retuneFamiliarity(
  state: GameState,
  tactics: TeamTactics,
  after: TacticsSpec,
  scale: number,
): void {
  for (const a of tactics.assignments) {
    const player = playerById(state, a.playerId);
    const arrival = familiarityForSetup(memoriesOf(state, a, tactics), after, state.date, {
      distanceOf: (memory, next) => personalDistance(player, memory, next),
      retention: memoryRetention(player),
    });
    a.familiarity = clampFamiliarity(a.familiarity + (arrival - a.familiarity) * scale);
  }
}

/**
 * 팀 전술 — **여섯 축과 갈래 넷을 한 자리에서 받는다.**
 *
 * 축(멘탈리티·라인·압박·템포·폭·패스)뿐 아니라 `TacticsSpec`의 optional 토글
 * 넷(전환·오프사이드 트랩·태클 강도·GK 배급)도 같은 스프레드로 지나가고 같은
 * 스키마가 검증한다 (→ docs/simulation/match.md §1.2). 주지 않은 필드는 지금 값을
 * 그대로 잇고, `null`은 그 갈래의 지시를 푸는 자리다.
 */
export function setTactics(state: GameState, spec: Partial<TacticsSpec>): SkillResult {
  const tactics = userTactics(state);
  /**
   * 포메이션 이름은 **좌표의 파생값**이라 여기서 갈아 끼우지 않는다 (`shapeOf`).
   * 이름만 바꾸면 판은 그대로인데 장부의 모양이 달라져 화면과 갈라진다 — 판을
   * 바꾸는 것은 배치 스킬(`setLineup`·`setPlayerTactic`)의 일이다.
   */
  const { formation: _shapeName, ...axes } = spec;
  void _shapeName;
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
    return { ok: true, unchanged: true, message: `전술 유지 — ${parsed.data.formation}` };
  }

  const wasAt = currentFamiliarity(tactics);
  const inMatch = state.phase === "match";
  /**
   * 떠나기 전에 각자 지금까지 쌓은 숙련도를 기억에 남긴다 (되돌아올 때 되찾는다).
   *
   * ⚠️ **경기 중에는 적지 않는다.** 경기 중 조정은 새 전술을 배우는 것이 아니라서
   * (아래 주석·`restoreTactics`) 적응도를 되돌리는데, 기억만 남으면 그 경기에서
   * 잠깐 거친 조합이 **익힌 전술로 영구히** 남는다 — 나중에 평시에 그 조합으로
   * 바꾸면 재적응 없이 그때 값을 되찾고, `DRILLED_LIMIT`을 잠식해 진짜 훈련한
   * 기억을 밀어낸다. 킥오프 전술의 숙련도는 매일 `settleTactics`가 적고, 경기가
   * 끝나면 전술이 킥오프 상태로 돌아오므로 다음 날 다시 적힌다 — 잃는 기억은 없다.
   */
  if (!inMatch) rememberTactics(tactics, state.date);
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
  retuneFamiliarity(state, tactics, parsed.data, inMatch ? IN_MATCH_FAMILIARITY_LOSS : 1);

  // 감독에게 보이는 건 팀 눈금이다 — 개인값의 평균(파생)
  const now = currentFamiliarity(tactics);
  const delta = now - wasAt;
  const note =
    delta < 0
      ? ` · 전술 적응도 ${now} (${delta}, 재적응 필요)`
      : delta > 0
        ? ` · 전술 적응도 ${now} (+${delta}, 익혀 둔 전술)`
        : ` · 전술 적응도 ${now} (그대로)`;
  /**
   * 감독이 실제로 세운 갈래만 — **중립인 갈래는 세우지 않는다.**
   *
   * "역습으로 가자"가 결과에 없으면 감독은 걸린 줄 모른다. 반대로 넷이 늘 붙어
   * 있으면 무엇을 지시했는지가 묻히므로, 중립은 빼고 선 것만 낸다 (`tacticsBrief`와
   * 같은 규칙). 중립인지는 `tacticToggleValue` 하나가 답한다.
   */
  const toggles = TACTIC_TOGGLES.flatMap((toggle) => {
    const value = tacticToggleValue(parsed.data, toggle.key);
    return value === null ? [] : [{ toggle, word: tacticToggleWord(toggle.key, value) }];
  });
  const toggleNote = toggles.map(({ toggle, word }) => ` · ${toggle.brief} ${word}`).join("");
  return {
    ok: true,
    message: `전술 변경 — ${parsed.data.formation}, 멘탈리티 ${parsed.data.mentality}${toggleNote}${note}`,
    brief: {
      head: "전술 변경",
      items: [
        item({ label: "포메이션", text: parsed.data.formation }),
        item({ label: "멘탈리티", text: `${parsed.data.mentality}` }),
        ...toggles.map(({ toggle, word }) => item({ label: toggle.label, text: word })),
        /**
         * 적응도는 **도달한 값이 값이고 움직인 폭이 부호다** — `delta`가 0이어도
         * 싣는다. "그대로다"는 이 항목이 말하는 사실이지 증감을 말하지 않는 것이 아니다.
         */
        item({
          label: "전술 적응도",
          text: `${now}`,
          note: delta < 0 ? "재적응 필요" : delta > 0 ? "익혀 둔 전술" : "그대로",
          delta,
        }),
      ],
    },
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
  input: {
    playerId: string;
    note: string;
    kind?: PlayerDirectiveKind;
    targetId?: string;
    /** 얼마나 세게 — 없으면 `normal`이라 세기를 안 보내는 호출이 그대로 선다 */
    intensity?: DirectiveIntensity;
  },
): SkillResult {
  const pick = pickOurPlayer(state, input.playerId);
  if (!pick.ok) return pick;
  const player = pick.player;
  const assignment = userTactics(state).assignments.find((a) => a.playerId === player.id);
  if (!assignment) {
    return { ok: false, message: `${player.name}은(는) 현재 전술에 배치되어 있지 않습니다` };
  }

  let targetNote = "";
  let target: Player | null = null;
  if (input.kind) {
    const needsTarget = input.kind === "man_mark" || input.kind === "press_target";
    if (needsTarget) {
      const found = input.targetId ? pickAnyPlayer(state, input.targetId) : null;
      if (!found) {
        return {
          ok: false,
          message: `${PLAYER_DIRECTIVE_KO[input.kind]}는 겨냥할 상대 선수가 필요합니다 — targetId를 주세요`,
        };
      }
      if (!found.ok) return found;
      target = found.player;
      if (target.teamId === state.userTeamId) {
        return { ok: false, message: `${target.name}은(는) 우리 선수입니다 — 상대를 겨냥하세요` };
      }
      targetNote = ` → ${target.name}`;
    }
    assignment.directive = {
      kind: input.kind,
      ...(target ? { targetId: target.id } : {}),
      ...(input.intensity ? { intensity: input.intensity } : {}),
    };
  }

  assignment.instruction = input.note;
  if (!input.kind) {
    /**
     * **`kind` 없는 지시는 판에 닿지 않는다** — 그러면 그렇다고 말해야 한다.
     *
     * 시뮬로 가는 것은 `directive.kind`뿐이고(`match-flow.ts`의 `directivesOnPitch`)
     * `instruction`은 화면과 스냅샷에만 남는다. 이 갈래를 그냥 성공으로 답하면
     * GM이 "지시가 먹혔다"로 서사를 쓰고 판은 아무것도 안 하는 **거짓 성공**이
     * 된다 — 감독이 원인을 알 수 없는 종류의 어긋남이다.
     */
    return {
      ok: true,
      message:
        `${player.name}에게 "${input.note}" — 말로 전했습니다. ` +
        `이 지시는 판에 반영되지 않습니다: 판을 움직이려면 kind를 함께 보내세요 ` +
        `(${Object.values(PLAYER_DIRECTIVE_KO).join(" · ")}). ` +
        `자리를 옮기는 지시라면 move, 지역을 겨냥한 지시라면 set_match_plan입니다`,
      // 긴 안내는 모델 몫이다 — 감독이 알아야 할 것은 "판에 안 닿았다" 하나
      brief: {
        head: `${player.name} 개인 지시`,
        items: [item({ text: "말로만 전함", note: "판에 반영되지 않음" })],
      },
    };
  }
  /** 세기는 **보통이 아닐 때만** 적는다 — 기본값을 매번 적으면 그게 선택으로 읽힌다 */
  const intensityKo =
    input.intensity && input.intensity !== "normal"
      ? ` ${DIRECTIVE_INTENSITY_KO[input.intensity]}`
      : "";
  const kindKo = `${PLAYER_DIRECTIVE_KO[input.kind]}${intensityKo}`;
  /**
   * **`kind`가 있어도 판에 닿지 않는 두 갈래** — 그것도 말해야 한다.
   *
   * 시뮬로 가는 것은 그라운드 위 선수의 지시뿐이고(`directivesOnPitch`) 그중에서도
   * 앞선 `MAX_EFFECTIVE`개까지다(`applyDirectives`). 저장은 되니 **거절이 아니라
   * 고지다** — 교체로 들어가거나 다른 지시를 거두면 그대로 걸린다. 조용히 버리면
   * `kind` 없는 지시를 성공으로 답하던 것과 같은 거짓 성공이 된다.
   */
  const withDirective = userTactics(state).assignments.filter(
    (a) => a.role === "starting" && a.directive,
  );
  const order = withDirective.findIndex((a) => a.playerId === player.id);
  const unreached =
    assignment.role !== "starting"
      ? { text: "벤치", why: "벤치라 지금은 판에 닿지 않습니다 — 교체로 들어가면 걸립니다" }
      : order >= DIRECTIVE_TUNING.MAX_EFFECTIVE
        ? {
            text: `지시 ${order + 1}번째`,
            why:
              `이미 지시 ${DIRECTIVE_TUNING.MAX_EFFECTIVE}개가 걸려 판에 닿지 않습니다 — ` +
              `하나를 거두면 걸립니다`,
          }
        : null;
  return {
    ok: true,
    message:
      `${player.name} 개인 지시 — "${input.note}" [${kindKo}${targetNote}]` +
      (unreached ? ` · ${unreached.why}` : ""),
    /**
     * 항목에는 **지시의 갈래와 대상만** 싣는다. `note`는 감독의 말 그대로라
     * 길이에 상한이 없다 — 그 문장은 `message`를 타고 장면으로 간다.
     */
    brief: {
      head: `${player.name} 개인 지시`,
      items: [
        item({
          text: kindKo,
          ...(target ? { note: `겨냥 ${target.name}` } : {}),
        }),
        ...(unreached ? [item({ text: unreached.text, note: "판에 반영되지 않음" })] : []),
      ],
    },
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

const slotKo = (slot: Slot): string => (slot === "am" ? "오전" : "오후");

/** 항목에 적는 날짜 — 연도를 뗀다 (`2026-09-03` → `9-03`). 어느 해인지는 달력이 안다 */
function briefDate(date: string): string {
  return `${Number(date.slice(5, 7))}-${date.slice(8, 10)}`;
}

/**
 * 항목에 적는 **기간** — 연도를 떼되 **해를 넘으면 뒤에 해를 붙인다.**
 *
 * `clear: true`는 400일 뒤까지 비운다. 연도를 그냥 떼면 `7-01~8-05`가 되어 다섯 주로
 * 읽히는데 실제로는 열세 달이다 — 짧게 적으려다 거짓을 적는 자리다.
 */
function briefSpanOf(from: string, to: string): string {
  if (from === to) return briefDate(from);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${briefDate(from)}~${sameYear ? "" : `'${to.slice(2, 4)} `}${briefDate(to)}`;
}

/** 항목에 적는 훈련 갈래 — 둘에서 접는다. 닫힌 enum이라 길이가 예측된다(자유 label은 안 쓴다) */
const FOCUS_SHOWN = 2;

function briefFocus(focus: Iterable<TrainAttr>): string {
  const kinds = [...new Set(focus)].map((f) => TRAIN_ATTR_KO[f] ?? f);
  if (kinds.length === 0) return "";
  const shown = kinds.slice(0, FOCUS_SHOWN).join("·");
  return `${shown}${kinds.length > FOCUS_SHOWN ? ` 외 ${kinds.length - FOCUS_SHOWN}` : ""}`;
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
/**
 * 리더십 계수를 반발의 크기로 뒤집는 축 — 계수 1.0(리그 평균)이 저항 1.0이다.
 * 믿는 감독일수록 계수가 크고, 그만큼 저항이 작아진다.
 */
const LEADERSHIP_RESISTANCE_PIVOT = 2;
/** 하루를 당길 때마다 깎이는 체력 — 저항이 곱해진다 */
const RECALL_DRAIN_PER_DAY = 1.2;
/** 며칠을 당겨야 한 명이 등을 돌리는가 */
const RECALL_DAYS_PER_UPSET = 3;
/** 반발이 번질 수 있는 1군의 최대 비율 — 라커룸 전체가 등을 돌리지는 않는다 */
const RECALL_UPSET_CAP_SHARE = 0.5;

function recallSquadEarly(state: GameState, date: string): string {
  const was = squadReturnOf(state.calendar);
  const early = Math.max(1, diffDays(date, was));
  state.calendar.squadReturn = date;

  // 리더십이 높을수록 덜 흔들린다 (0.7~1.3의 역방향)
  const resistance = LEADERSHIP_RESISTANCE_PIVOT - leadershipFactor(state);
  const drain = Math.round(early * RECALL_DRAIN_PER_DAY * resistance);
  const players = userPlayers(state).filter((p) => squadLevelOf(p) === "first");
  for (const p of players) {
    p.state.condition = clampCondition(p.state.condition - drain);
  }

  /**
   * 반발하는 선수 — 당긴 날수에 비례하되 스쿼드의 절반을 넘지 않는다.
   * 대상은 시드가 아니라 **가장 지친 선수부터**다. 쉬어야 할 사람이 먼저 화낸다.
   */
  const upset = Math.min(
    Math.floor(players.length * RECALL_UPSET_CAP_SHARE),
    Math.max(0, Math.round((early / RECALL_DAYS_PER_UPSET) * resistance)),
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
      reason: "early-return",
      since: state.date,
    });
  }

  pushNarrative(state, `휴가 반납 소집 ${was}→${date} · 불만 ${angry.length}명`, 4);
  return (
    `소집을 ${early}일 앞당겼습니다 (${was} → ${date}) — 선수단 체력 −${drain}` +
    (angry.length > 0 ? `, ${angry.length}명이 불만을 품었습니다` : ", 큰 반발은 없었습니다")
  );
}

/**
 * "훈련 다 지워"가 미치는 앞날 — 끝 날짜를 주지 않은 비우기의 지평이다.
 * 한 시즌보다 넉넉해 "전부"로 읽히면서도, 일정 전체를 훑지는 않는 폭.
 */
const CLEAR_TRAINING_HORIZON_DAYS = 400;
/** 요일 반복을 펼치는 주 수 — 말하지 않으면 이만큼, 그 아래·위로는 자른다 */
const REPEAT_WEEKS_DEFAULT = 6;
const REPEAT_WEEKS_MIN = 1;
const REPEAT_WEEKS_MAX = 20;

export function setTraining(state: GameState, input: TrainingPlanInput): SkillResult {
  const applied: string[] = [];
  /**
   * 말풍선 항목 — **건수와 갈래까지만.** 세션 하나하나를 적으면(월·수·금이면 셋)
   * 알림이 달력 화면을 옮겨 적는 자리가 된다. 조기 소집 대가·휴가 건너뜀은
   * `message`에 남아 GM이 장면으로 푼다.
   */
  const items: SkillBriefItem[] = [];
  const sessions = input.sessions ?? [];
  const repeats = input.repeatWeekly ?? [];

  // ── 검증 ───────────────────────────────────────────────
  // 여기서는 아무것도 바꾸지 않는다. 하나라도 걸리면 상태는 부른 그대로다
  // (→ docs/simulation/season.md §4). 조기 소집은 체력을 깎고 불만을 남기고 소집일을
  // 옮기는 **되돌릴 수 없는** 걸음이라, 그 뒤에서 세션 하나가 걸리면 "반려했습니다"를
  // 읽은 감독의 선수단이 이미 지쳐 있었다.

  /**
   * **지난 날짜에는 훈련을 잡지 못한다.**
   *
   * 그 자리의 tick은 이미 지나갔으므로 엔트리가 영영 `scheduled`로 남아 달력에
   * "예정"으로 서고, 같은 날짜가 조기 소집으로 흘러가면 대가(`recallSquadEarly`)가
   * 오늘까지의 날수만큼 부풀려 매겨진다.
   */
  for (const s of sessions) {
    if (!DATE_RE.test(s.date)) return { ok: false, message: `날짜 형식이 잘못됨: ${s.date}` };
    if (s.date < state.date) {
      return {
        ok: false,
        message: `${s.date}은 이미 지난 날입니다 — 훈련은 오늘(${state.date})부터 잡을 수 있습니다`,
      };
    }
    if (!s.label?.trim()) return { ok: false, message: "훈련 설명(label)이 필요합니다" };
    const err = validFocus(s.focus);
    if (err) return { ok: false, message: err };
  }
  for (const r of repeats) {
    if (!Number.isInteger(r.dow) || r.dow < 0 || r.dow > 6) {
      return { ok: false, message: `요일이 잘못됨: ${r.dow} (0~6)` };
    }
    if (!r.label?.trim()) return { ok: false, message: "훈련 설명(label)이 필요합니다" };
    const err = validFocus(r.focus);
    if (err) return { ok: false, message: err };
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
   * 그래서 `recallSquad` 없이는 거부하고, 있으면 소집일 자체를 앞당긴다. 여기서는
   * **앞당겼다고 치면 언제인가**만 구한다 — 옮기는 것은 아래 적용 단계다.
   */
  const squadReturn = squadReturnOf(state.calendar);
  const wanted = [...sessions.map((x) => x.date), ...(repeats.length > 0 ? [state.date] : [])];
  const earliest = [...wanted].sort()[0];
  const recallTo =
    input.recallSquad === true && earliest !== undefined && earliest < squadReturn
      ? earliest
      : undefined;
  const effectiveReturn = recallTo ?? squadReturn;
  for (const s of sessions) {
    if (s.date < effectiveReturn) {
      return {
        ok: false,
        message:
          `${s.date}은 선수단 여름 휴가 기간입니다 — 훈련은 소집일(${effectiveReturn})부터 잡을 수 있습니다. ` +
          `감독이 휴가를 접고 조기 소집하겠다고 했다면 recallSquad를 함께 보내세요 (선수단이 반발합니다).`,
      };
    }
  }

  // ── 적용 ───────────────────────────────────────────────

  /**
   * 1) 비우기 먼저 — "월요일 훈련 다 지우고 새로" 같은 지시를 한 번에 처리.
   *
   * **`clearTraining`과 같은 규칙을 쓴다** — 두 경로가 갈리면 "쉬게 하자"와
   * "훈련 빼줘"가 서로 다르게 처리되고, 휴식 세션을 남기지 않은 쪽은 다음 tick이
   * 기본 훈련을 도로 깐다.
   *
   * 적용의 **첫 걸음**이라 여기 반려는 아직 아무것도 바꾸지 않았다 — `clearTraining`
   * 자신도 검증을 다 끝낸 뒤에 지운다.
   */
  if (input.clear) {
    const opt = input.clear === true ? {} : input.clear;
    /**
     * 범위의 기본값이 다르다 — 여기 `clear`는 **그 뒤 전부**를 비우는 뜻이고
     * (`clear: true` = "당분간 훈련 없다"), 날짜를 콕 집는 쪽은 `to`를 준다.
     * 그대로 넘기면 하루만 지워져 "전부 비우기"가 조용히 하루짜리가 된다.
     */
    const cleared = clearTraining(state, {
      ...opt,
      to: opt.to ?? addDays(state.date, CLEAR_TRAINING_HORIZON_DAYS),
    });
    if (!cleared.ok) return cleared;
    applied.push(cleared.message);
    items.push(...(cleared.brief?.items ?? []));
  }

  if (recallTo !== undefined) applied.push(recallSquadEarly(state, recallTo));

  // 2) 특정 날짜 세션
  const dated: Array<{ date: string; slot: Slot }> = [];
  const datedFocus = new Set<TrainAttr>();
  for (const s of sessions) {
    addTrainingEntry(state, s.date, s.slot, s.label.trim(), s.focus);
    applied.push(`${s.date} ${slotKo(s.slot)}=${s.label}${focusKo(s.focus)}`);
    dated.push({ date: s.date, slot: s.slot });
    for (const f of s.focus) datedFocus.add(f);
  }
  const firstDated = dated[0];
  if (firstDated) {
    // 날짜 세션은 첫 자리 + 나머지 건수로 접는다 — 어느 날 무엇을 하는지는 달력이 갖고 있다
    items.push(
      // 이름표를 달지 않는다 — `9-03 오전`도 `매주 3회`도 어느 갈래인지를 값이 이미 말한다
      item({
        text:
          `${briefDate(firstDated.date)} ${slotKo(firstDated.slot)}` +
          (dated.length > 1 ? ` 외 ${dated.length - 1}건` : ""),
        note: briefFocus(datedFocus),
      }),
    );
  }

  // 3) 요일 반복 — 오늘부터 weeks주만큼 엔트리를 펼친다
  const weeks = Math.max(
    REPEAT_WEEKS_MIN,
    Math.min(REPEAT_WEEKS_MAX, input.weeks ?? REPEAT_WEEKS_DEFAULT),
  );
  /** 요일 반복은 **하나로 묶는다** — 월·수·금이 항목 셋이 되면 그게 글자 벽이다 */
  let repeatPerWeek = 0;
  let repeatWeeks = 0;
  const repeatFocus = new Set<TrainAttr>();
  for (const r of repeats) {
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
      `매주 ${WEEKDAY_KO[r.dow]}요일 ${slotKo(r.slot)}=${r.label}${focusKo(r.focus)} × ${made}주` +
        (skipped > 0 ? ` (휴가 ${skipped}일을 건너뛰고 ${from}부터)` : ""),
    );
    repeatPerWeek++;
    repeatWeeks = Math.max(repeatWeeks, made);
    for (const f of r.focus) repeatFocus.add(f);
  }
  if (repeatPerWeek > 0) {
    items.push(
      item({
        text: `매주 ${repeatPerWeek}회 × ${repeatWeeks}주`,
        note: briefFocus(repeatFocus),
      }),
    );
  }

  state.schedule = sortEntries(state.schedule);
  return {
    ok: true,
    message: applied.length > 0 ? `훈련 지정 — ${applied.join(", ")}` : "변경할 훈련이 없습니다",
    ...(items.length > 0 ? { brief: { head: "훈련 지정", items } } : {}),
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
  const briefSpan = briefSpanOf(start, to);
  return {
    ok: true,
    message: asRest
      ? `${span} 훈련 ${targets.length}건을 휴식으로 (${days.size}일)`
      : `${span} 훈련 ${targets.length}건 취소 — 기본 훈련이 다시 편성됩니다`,
    brief: {
      head: "훈련 비우기",
      items: [
        item({
          label: asRest ? "휴식" : "취소",
          text: `${briefSpan} ${targets.length}건`,
        }),
      ],
    },
  };
}

// ---- 창발 보조: 서사 이벤트 (GM 전용, 능력치 접근 불가 — overview §7) ----

const MAX_NARRATIVE_EVENTS_PER_DAY = 3;
/**
 * 서사 이벤트 한 번이 컨디션을 움직일 수 있는 폭 — GM이 쓴 장면 하나가
 * 경기 한 판(±10 안팎)을 덮어쓰지 않게 하는 문 (overview §7의 앵커±폭).
 */
const NARRATIVE_CONDITION_BOUND = 5;
/** 모델이 말할 수 있는 폼 **단계**의 폭 — −1/0/+1 이며 코어가 폼 축으로 옮긴다 */
const NARRATIVE_FORM_STEP_BOUND = 1;

export function applyNarrativeEvent(
  state: GameState,
  input: { playerIds: string[]; conditionDelta?: number; formDelta?: number; note: string },
): SkillResult {
  /**
   * 하루 한도는 **갈래로 센다.** 접두 문장(`"[서사]"`)으로 가르면 그 문구를 고치는
   * 순간 한도가 사라진다 (records.ts `NarrativeKind`, overview.md §1 철칙 4).
   * 갈래가 없는 옛 세이브의 줄은 세지 않는다 — 한도는 그날 쌓인 줄만 본다.
   */
  const todayCount = state.narrative.filter(
    (n) => n.date === state.date && n.kind === "gm-event",
  ).length;
  if (todayCount >= MAX_NARRATIVE_EVENTS_PER_DAY) {
    return {
      ok: false,
      message: `오늘의 서사 이벤트 한도(${MAX_NARRATIVE_EVENTS_PER_DAY}회)를 초과했습니다`,
    };
  }

  const condition = Math.max(
    -NARRATIVE_CONDITION_BOUND,
    Math.min(NARRATIVE_CONDITION_BOUND, Math.round(input.conditionDelta ?? 0)),
  );
  /**
   * 서사 이벤트의 폼 변화 — 모델은 −1/0/+1의 **단계**로 말하고, 코어가 폼 축의
   * 폭으로 옮긴다. 폼은 −1~1이라 ±1을 그대로 더하면 한 장면이 선수를 곧바로
   * 절정·바닥에 꽂는다 (경기 한 판의 변화가 0.3 안팎이다).
   */
  const NARRATIVE_FORM_STEP = 0.12;
  const formStep = Math.max(
    -NARRATIVE_FORM_STEP_BOUND,
    Math.min(NARRATIVE_FORM_STEP_BOUND, Math.round(input.formDelta ?? 0)),
  );
  const form = formStep * NARRATIVE_FORM_STEP;
  // 검증 먼저, 적용은 전원 유효할 때만 — 원자성 (장부 applyEvents와 동일 패턴)
  const resolved = input.playerIds.map((ref) => pickOurPlayer(state, ref));
  const missing = resolved.filter((r) => !r.ok);
  if (missing.length > 0) {
    return { ok: false, message: missing.map((r) => (r.ok ? "" : r.message)).join(" · ") };
  }
  const touched: string[] = [];
  for (const r of resolved) {
    if (!r.ok) continue;
    const player = r.player;
    player.state.condition = clampCondition(player.state.condition + condition);
    player.state.form = clampForm(player.state.form + form);
    touched.push(player.name);
  }
  pushNarrative(state, input.note, 3, "gm-event");
  /**
   * 항목은 **대상과 수치까지만.** `note`는 LLM이 쓴 자유 문장이라 상한이 없고,
   * 이미 서사 로그와 장면에 남아 있다 — 알림이 그것을 다시 옮겨 적을 자리가 아니다.
   * 폼은 모델이 말한 단계(−1/0/+1)로 적는다 — 화면에 0.12는 뜻이 없다.
   *
   * 축은 **한 줄에 하나씩** 선다 — 항목 하나가 한 줄이고 `delta` 하나가 그 줄의
   * 부호라, 컨디션과 폼을 한 `note`에 묶으면 부호가 둘인 줄이 된다.
   */
  const moved = deltaItems([
    ["컨디션", condition],
    ["폼", formStep],
  ]);
  return {
    ok: true,
    message: `서사 이벤트 반영(${touched.join(", ")}) — ${input.note}`,
    brief: {
      head: "서사 이벤트",
      items: [
        item({
          text: briefNames(touched),
          ...(moved.length === 0 ? { note: "수치 변화 없음" } : {}),
        }),
        ...moved,
      ],
    },
  };
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
export function scoutPlayer(state: GameState, ref: string): MarketSkillResult {
  const pick = pickAnyPlayer(state, ref);
  if (!pick.ok) return pick;
  const player = pick.player;
  const playerId = player.id;
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
  const inFlight = state.scoutReports.filter((r) => r.completedOn === null);
  if (inFlight.length >= SCOUT_CONCURRENT_LIMIT) {
    /**
     * **무엇이 나갔고 무엇이 안 나갔는지 이름으로 말한다.** 한도만 알려 주면
     * 감독은 지목한 넷 중 누가 빠졌는지 알 수 없다.
     *
     * 그리고 못 나갔다는 사실을 대기로 남긴다 — 이 문구는 이 턴에만 살아 있어,
     * 남기지 않으면 다음 턴의 모델에는 넷째를 읽을 자리가 없다
     * (→ [docs/data/player.md](../../../../docs/data/player.md) §9.4).
     */
    deferScout(state, playerId);
    const busy = inFlight
      .map((r) => `${playerName(state, r.gamePlayerId)} 보고 ${r.dueOn}`)
      .join(", ");
    const earliest = inFlight.reduce(
      (min, r) => (r.dueOn < min ? r.dueOn : min),
      inFlight[0]!.dueOn,
    );
    return {
      ok: false,
      message:
        `${player.name}(${teamName(player.teamId)})은(는) 보내지 못했습니다 — 동시 파견 한도 ` +
        `${SCOUT_CONCURRENT_LIMIT}명이 차 있습니다 (파견 중: ${busy}). ` +
        `${earliest} 보고가 들어오면 자리가 납니다. ` +
        `${player.name} 요청은 대기로 남습니다 — 자리가 난 뒤 다시 불러야 나갑니다`,
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
  // 대기하던 요청이 드디어 나갔다 — 남겨 두면 나간 파견이 "안 나갔다"로 읽힌다
  dropDeferredScout(state, playerId);
  /**
   * 파견은 아직 아무 장부도 바꾸지 않았다 — 갈 화면이 없으므로 **카드**로 선다.
   * 며칠 뒤 도착하는 보고서 카드와 같은 흐름에 놓여 "보냈다 → 왔다"가 이어진다.
   */
  const card: MarketCard = {
    kind: "scout",
    playerId,
    playerName: player.name,
    counterpart: teamName(player.teamId),
    // 우리 선수는 위에서 걸러졌다 — 파견이 나갔다면 데려올 선수를 본 것이다
    direction: "in",
    dueOn,
    ...(done > 0 ? { note: `${done + 1}번째 파견` } : {}),
  };
  return {
    ok: true,
    payload: card,
    message:
      `${player.name}(${teamName(player.teamId)}) 스카우트 파견 — 보고 예정 ${dueOn}` +
      (done > 0 ? ` (${done + 1}번째 파견)` : ""),
  };
}

export { MATCHDAY_BENCH, groupOf, tacticsOf };
export { forgetRoles, recallRole, rememberRole } from "./role-memory";
