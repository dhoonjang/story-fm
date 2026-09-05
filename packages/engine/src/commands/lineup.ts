/**
 * **설정형 — 판을 세우는 명령** (player.md §3 · match.md §1).
 *
 * 1·2군 배치, 라인업과 팀 전술 6축, 선수의 자리·역할·개인 지시, 세트피스, 완장,
 * 등번호. 검증을 지나면 그대로 장부에 적히고 판정은 끼지 않는다.
 */
import { numberGrievanceStands, registrationBlockText } from "@story-fm/domain";
import type {
  BoardPoint,
  GamePlayer,
  DrilledTactics,
  Player,
  TacticAssignment,
  TacticsSpec,
  SetPieceRole,
  SetPieceRoutine,
  SetPieceRoutineKey,
  SetPieceRoutineLevel,
  SetPieceTakers,
  TeamTactics,
} from "@story-fm/domain";
import {
  clampCondition,
  tacticalUptake as uptakeOf,
  DIRECTIVE_INTENSITY_KO,
  type DirectiveIntensity,
  PLAYER_DIRECTIVE_KO,
  type PlayerDirectiveKind,
  MATCHDAY_SQUAD,
  POSITION_CODES,
  SET_PIECE_KO,
  SET_PIECE_ROLES,
  SET_PIECE_ROLE_KO,
  SET_PIECE_ROUTINE_KEYS,
  SET_PIECE_ROUTINE_NEUTRAL,
  setPieceRoutineAxisOf,
  setPieceRoutineLevel,
  setPieceRoutineWord,
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
  findRole,
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
import { nextMatchFor } from "../competition/calendar";
import { clampForm, moraleToForm } from "../squad/form";
import { injuryHistoryOf } from "../squad/injury";

/** 라인업 브리프가 「최근 복귀」로 세우는 창 — 심경 카드와 같은 자 (player.md §5.3) */
const RECENT_RETURN_DAYS = 30;
import { closeMentorings } from "../squad/mentoring";
import {
  canRegisterAllFor,
  canRegisterFor,
  registrationLine,
  squadRegistrationOf,
} from "../squad/registration";
import { creditSettling, settlingOf } from "../squad/settling";
// 면담에서 한 약속은 장부에 선다 (people.md §5-2 · career.md §2)
// 감독이 지목한 번호는 코어가 배정하고, 사실만 돌려준다 (player.md §1.1)
import { assignRequestedNumber, numberBlockText } from "../squad/numbers";
import { archetypeTraitsOf } from "../world/player-persona";
// 면담의 사기는 감독과 그 선수 사이의 등급을 탄다 (people.md §6 「관계 등급」)
// 잔향 — 그 대화를 쥔 호출이 심경 한 문장을 남긴다 (people.md §5)
// 판정은 수용성 앵커 ± 한 단계 안에서만 선다 (career.md §2)
import { leaderGroupOf } from "../squad/hierarchy";
import {
  isInjured,
  isSuspendedFor,
  playerById,
  playerName,
  pushNarrative,
  recomputeOverall,
  squadLevelOf,
  userPlayerById,
  userPlayers,
  userTactics,
  FAMILIARITY_BASELINE,
  MATCHDAY_BENCH,
  type GameState,
  type CommandBriefItem,
} from "../core/state";
import { pickAnyPlayer, pickOurPlayer } from "../core/player-ref";
import { briefNames, item } from "./brief";
import type { CommandResult } from "./result";

// ── 선수 지목 ───────────────────────────────────────────
//
// 이름 해석은 코어가 한 벌만 갖는다 (`pickOurPlayer`·`pickAnyPlayer`, core/state.ts) —
// 이적·교체 명령도 같은 것을 쓴다.

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
): CommandResult {
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
): CommandResult {
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

  const items: CommandBriefItem[] = [];
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

/** 1군 인원 하한을 말하는 한 문장 — 두 명령이 같은 말을 해야 감독이 같은 규칙으로 읽는다 */
function matchdaySquadFloor(): string {
  const starters = MATCHDAY_SQUAD - MATCHDAY_BENCH;
  return `1군은 매치데이 명단(선발 ${starters} + 벤치 ${MATCHDAY_BENCH})을 채울 ${MATCHDAY_SQUAD}명 이상이어야 합니다`;
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
): { notes: string[]; items: CommandBriefItem[] } {
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
  const items: CommandBriefItem[] = [];
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
): CommandResult {
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
  /**
   * **정지는 다음 경기의 대회로 묻는다** (match.md §6) — 컵 경고로 걸린 정지가
   * 리그 라인업을 반려하면 감독은 실제로 쓸 수 있는 선수를 못 세운다.
   */
  const nextCompetition =
    nextMatchFor(state.matches, state.userTeamId, state.date)?.competitionId ?? null;
  const suspended = starting.filter((s) => isSuspendedFor(state, s.playerId, nextCompetition));
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
   * **오늘 세운 열한 명 중 최근에 몸을 다쳤던 사람** (player.md §5.3) — 명단이
   * 확정되는 그 자리에서만 뜻이 있는 항목이라, 배치가 그대로여도 선다. 선발만 센다:
   * 벤치의 몸은 감독이 그를 넣기로 하는 그 순간의 사정이다.
   *
   * ⚠️ **등급을 세우지 않는다** — 코어가 「위험 높음」이라고 못 박는 대신 복귀한 지
   * 얼마 안 된 사실만 세우고, 그것을 어떻게 볼지는 감독과 GM이 정한다.
   */
  const atRisk = startingAssignments
    .map((a) => userPlayerById(state, a.playerId))
    .filter((p): p is GamePlayer => {
      if (p === null) return false;
      const last = injuryHistoryOf(state, p.id).last;
      return last !== null && !last.open && last.daysAgo <= RECENT_RETURN_DAYS;
    });
  if (atRisk.length > 0) {
    items.push(item({ label: "최근 복귀", text: briefNames(atRisk.map((p) => p.name)) }));
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
): CommandResult {
  const notes: string[] = [];
  /** 항목은 하위 명령이 각자 낸 것을 잇는다 — 세 조각이 한 줄로 엉키지 않게 */
  const items: CommandBriefItem[] = [];
  /** 이미 바꾼 것이 있는가 — 있으면 뒤따르는 반려는 되돌리지 않고 결과로 적는다 */
  let changed = false;
  const take = (res: CommandResult) => {
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
  const reject = (res: CommandResult): CommandResult | null => {
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
): CommandResult {
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
 * **표기는 이름·id·약어 셋 다 받는다**(`findRole`) — 전술판은 id를 보내고 감독의 말을
 * 옮기는 해석기는 이름을 적는다. 한쪽만 받으면 말로 건 역할만 반려되고, 한 번 부르는
 * 해석기에는 그 반려를 보고 다시 시도할 자리가 없다 (player.md §3.1).
 *
 * ⚠️ **선발만 자리를 갖는다** — 벤치 배치의 `position`은 좌표가 아니라 주 포지션이라,
 * 그걸로 검증하면 화면이 말하는 자리와 다른 목록으로 반려한다 (player.md §3.1).
 */
export function setPlayerRole(
  state: GameState,
  input: { playerId: string; role: string },
): CommandResult {
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
  // 감독이 부른 표기 그대로 견준다 — 화면은 id를, 해석기는 이름을 보낸다 (player.md §3.1)
  const def = findRole(assignment.position, input.role);
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
): CommandResult {
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

/**
 * **세트피스 키커 지정** — "코너는 사카가 차", "페널티는 네 거야" (match.md §1.4).
 *
 * 셋 중 말한 자리만 바뀐다. `null`을 주면 지정이 풀려 코어의 기본값(그라운드 위
 * 킥력 최고 · `penaltySkill` 최고)으로 돌아간다 — 감독이 손을 떼는 길이 있어야
 * 한 번 지정한 사람이 팔린 뒤에도 그 이름이 남지 않는다.
 *
 * 평시와 경기 중이 같은 명령을 지난다. 지정은 팀 전술에 남으므로 그라운드에 없는
 * 선수를 지목해도 반려하지 않는다 — 다음 경기의 선발일 수 있다. 그 경기에서만
 * 기본값이 설 뿐이다.
 */
export function setSetPieceTakers(
  state: GameState,
  input: Partial<Record<SetPieceRole, string | null>>,
): CommandResult {
  const tactics = userTactics(state);
  const next: SetPieceTakers = { ...(tactics.setPieceTakers ?? {}) };
  const notes: string[] = [];
  const items: CommandBriefItem[] = [];
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
    message: `${SET_PIECE_KO} 키커 — ${notes.join(" · ")}`,
    brief: { head: `${SET_PIECE_KO} 키커`, items },
  };
}

/**
 * **세트피스 지시** — 키커 말고 감독이 정하는 두 축 (match.md §1.4).
 *
 * 「코너에 사람 더 올려」·「저 팀 세트피스는 다 막아라」. 키커 지정과 같은 규약이다:
 * 말한 축만 바뀌고, `null`을 주면 그 축이 중립(`normal`)으로 돌아간다 — 감독이 손을
 * 떼는 길이 있어야 한 번 올린 인원이 영영 서 있지 않는다.
 *
 * 중립은 **저장하지 않는다.** 옛 세이브가 이 칸을 갖지 않는 것과 지시를 푼 판이 같은
 * 모양이어야, 「지시하지 않음」이 장부에 두 가지로 적히지 않는다.
 */
export function setSetPieceRoutine(
  state: GameState,
  input: Partial<Record<SetPieceRoutineKey, SetPieceRoutineLevel | null>>,
): CommandResult {
  const tactics = userTactics(state);
  const next: SetPieceRoutine = { ...(tactics.setPieceRoutine ?? {}) };
  const notes: string[] = [];
  const items: CommandBriefItem[] = [];
  let changed = false;
  for (const key of SET_PIECE_ROUTINE_KEYS) {
    const want = input[key];
    if (want === undefined) continue;
    const axis = setPieceRoutineAxisOf(key);
    const level: SetPieceRoutineLevel = want ?? SET_PIECE_ROUTINE_NEUTRAL;
    if (setPieceRoutineLevel(tactics.setPieceRoutine, key) === level) continue;
    // 중립은 칸을 비운다 — 「지시 없음」이 두 모양으로 적히지 않는다
    if (level === SET_PIECE_ROUTINE_NEUTRAL) delete next[key];
    else next[key] = level;
    changed = true;
    notes.push(`${axis.label} ${setPieceRoutineWord(key, level)}`);
    items.push(item({ label: axis.label, text: setPieceRoutineWord(key, level) }));
  }
  if (!changed) {
    return { ok: true, message: "바뀐 지시가 없습니다", unchanged: true };
  }
  // 두 축이 다 중립으로 돌아가면 칸 자체를 걷는다 — 옛 세이브와 같은 모양이 된다
  if (Object.keys(next).length === 0) delete tactics.setPieceRoutine;
  else tactics.setPieceRoutine = next;
  return {
    ok: true,
    message: `${SET_PIECE_KO} 인원 — ${notes.join(" · ")}`,
    brief: { head: `${SET_PIECE_KO} 인원`, items },
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
): CommandResult {
  const items: CommandBriefItem[] = [];
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
): CommandResult {
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
  const items: CommandBriefItem[] = [
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
export function setTactics(state: GameState, spec: Partial<TacticsSpec>): CommandResult {
  const tactics = userTactics(state);
  /**
   * 포메이션 이름은 **좌표의 파생값**이라 여기서 갈아 끼우지 않는다 (`shapeOf`).
   * 이름만 바꾸면 판은 그대로인데 장부의 모양이 달라져 화면과 갈라진다 — 판을
   * 바꾸는 것은 배치 명령(`setLineup`·`setPlayerTactic`)의 일이다.
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
): CommandResult {
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
