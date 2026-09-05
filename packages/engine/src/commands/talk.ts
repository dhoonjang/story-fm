/**
 * **판정형 — 감독의 말이 사기에 닿는 자리** (career.md §2 · people.md §6).
 *
 * 대화 하나(`applyTalk`)와 사건 기록(`recordIncident`), 그리고 그 둘이 쌓는 감독의
 * 성장(`grantManagerXP`). LLM은 판정 라벨만 내고 변화량은 여기 공식이 정한다
 * (AGENTS.md §4 결정성 경계).
 */
import { INCIDENT_KIND_KO, MANAGER_ATTRIBUTE_KO, PROMISE_KIND_KO } from "@story-fm/domain";
import type {
  GamePlayer,
  IncidentKind,
  ManagerAttributes,
  PromiseKind,
  TeamTalkOccasion,
} from "@story-fm/domain";
import { addDays } from "../competition/calendar";
import { clampForm, moraleToForm } from "../squad/form";

import { creditSettling, settlingAnchor, settlingOf } from "../squad/settling";
// 면담에서 한 약속은 장부에 선다 (people.md §5-2 · career.md §2)
import { openPromise, type PromiseOpened } from "../squad/promises";
// 감독이 지목한 번호는 코어가 배정하고, 사실만 돌려준다 (player.md §1.1)
// 면담의 사기는 감독과 그 선수 사이의 등급을 탄다 (people.md §6 「관계 등급」)
import { MANAGER_SUBJECT, relationFactor } from "../world/relations";
// 잔향 — 그 대화를 쥔 호출이 심경 한 문장을 남긴다 (people.md §5)
import { applyMoodNotes, TEAM_TALK_MOODS, type MoodNoteSubmission } from "../squad/mood";
// 판정은 수용성 앵커 ± 한 단계 안에서만 선다 (career.md §2)
import {
  RECEPTIVITY_ANCHOR,
  RECEPTIVITY_KO,
  receptivityLine,
  receptivityOf,
  receptivityTierOf,
  type Receptivity,
} from "../squad/receptivity";
import { applyCharacterMemories } from "../world/persona";
import { touchOpenings } from "../world/openings";
import { dressingRoomFactor, dressingRoomVoice, leadershipFactor } from "../squad/hierarchy";
import { pushNarrative, userPlayers, type GameState, type CommandBriefItem } from "../core/state";
import { pickOurPlayer } from "../core/player-ref";
import { briefNames, deltaItems, item, signed } from "./brief";
import type { CommandResult } from "./result";

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

// ---- 판정형: team_talk — 감독의 말이 사기에 닿는 유일한 자리 ----

/**
 * **결과 사다리는 하나다** (career.md §2).
 *
 * 한 명과 마주 앉은 말과 라커룸에 던진 말이 같은 판정을 지난다 — 낱말표가 둘이면
 * 모델이 대상에 따라 다른 표를 골라야 하고, 같은 대화가 대상만 바뀌어 다른 눈금으로
 * 선다. `feared`는 사다리 밖이라 수용성 앵커에 잘리지 않는다.
 */
export const TALK_OUTCOMES = [
  "inspired",
  "encouraged",
  "neutral",
  "flat",
  "backfired",
  "feared",
] as const;
export type TalkOutcome = (typeof TALK_OUTCOMES)[number];

/**
 * 결과의 기본값 — 강도 3에 `inspired`면 리더십·관계 계수가 1일 때 정확히 폭(±8)에 닿는다.
 *
 * **맨 위를 좁히는 대신 드물게 둔다** — 폭을 깎으면 최고의 대화도 지나가는 말과 같은
 * 크기로 끝난다. `inspired`를 언제 고르는가는 도구 설명이 든다 (career.md §2).
 */
const TALK_BASE: Record<TalkOutcome, number> = {
  inspired: 5,
  encouraged: 3,
  neutral: 0,
  flat: -2,
  backfired: -6,
  feared: 1,
};

/**
 * **불만을 푸는 판정** — 사기가 오른 것만으로는 부족하다 (career.md §2).
 *
 * `feared`도 사기를 올리지만 방치를 풀지는 않는다: 불만이 풀리는 것은 감독이 그를
 * **다시 본** 것이지 무서워한 것이 아니다.
 */
const RESOLVING_OUTCOMES: ReadonlySet<TalkOutcome> = new Set(["encouraged", "inspired"]);

/** 강도의 중립점 — 2가 곧 1.0배라, 1은 절반으로 3은 1.5배로 울린다 */
const TALK_INTENSITY_PIVOT = 2;
/**
 * **한 명과 마주 앉은 말**이 사기를 움직일 수 있는 폭 — 이벤트당 한도 (career.md §2).
 * 대상이 하나라 방 전체에 던진 말보다 깊이 닿는다.
 */
const TALK_MORALE_BOUND = 8;
/**
 * **둘 이상이 들은 말**의 폭 — 한 사람을 부르는 것보다 좁다. 여기를 한 명의 폭과
 * 같게 두면 전원 소집이 면담을 완전히 대체한다.
 */
const ROOM_MORALE_BOUND = 6;
/**
 * 정지점의 외침이 사기를 움직일 수 있는 폭 — **라커룸의 한마디보다 좁다**
 * (career.md §2). 같은 무게로 두면 라커룸 장면이 뜻을 잃는다.
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
/** 잘 풀린 대화가 강도 한 칸당 주는 리더십 XP */
const TALK_XP_PER_INTENSITY = 6;
/** 잘 풀린 외침이 강도 한 칸당 주는 리더십 XP — 셋을 다 써도 라커룸 한마디보다 적다 */
const SHOUT_XP_PER_INTENSITY = 2;
/** 어긋난 말에도 남는 리더십 XP — 실패도 겪은 것이다 */
const TALK_XP_ON_FAILURE = 2;

/**
 * **한 선수가 대화로 하루에 움직일 수 있는 사기의 합계** (career.md §2).
 *
 * 날짜 게이트가 있던 자리다 — 게이트는 그날의 두 번째 대화를 통째로 없는 말로 만들어,
 * 경기일 아침의 격려와 경기 뒤의 위로 중 뒤의 것이 사라졌다. 상한은 대화를 막지 않고
 * 그 대화가 판에 남기는 몫만 자른다.
 */
const TALK_DAILY_BOUND = 8;
/** 이레 동안의 합계 상한 — 매일 최고 판정을 받아도 사흘째에 여기서 멈춘다 */
const TALK_WEEKLY_BOUND = 20;
/** 합계를 세는 창 — 오늘을 포함한 이레 */
const TALK_WINDOW_DAYS = 7;

/**
 * **그 말이 울리는 방** — 둘 이상이 들었을 때만 걸리는 계수 (people.md §5-1).
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

/** 말을 꺼낸 자리 — 결과 항목의 머리가 그 자리를 밝힌다 */
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

/**
 * 판정 사다리 — 가운데가 `neutral`이고 수용성 앵커가 그 자리를 옮긴다 (career.md §2).
 * `feared`는 사다리 밖이라 그대로 선다.
 */
const TALK_LADDER: readonly TalkOutcome[] = [
  "backfired",
  "flat",
  "neutral",
  "encouraged",
  "inspired",
];
/** 앵커에서 outcome이 벗어날 수 있는 칸 수 */
const OUTCOME_BAND = 1;

/**
 * 모델의 outcome을 앵커 ± 한 단계로 자른다 — 감독이 무슨 말을 했는지는 그대로이고,
 * 그 말이 어디까지 닿았는지를 코어가 정한다. 사다리 밖의 값은 건드리지 않는다.
 */
function clampOutcome(outcome: TalkOutcome, tier: Receptivity): TalkOutcome {
  const at = TALK_LADDER.indexOf(outcome);
  if (at < 0) return outcome;
  const centre = Math.floor(TALK_LADDER.length / 2) + RECEPTIVITY_ANCHOR[tier];
  const idx = Math.max(centre - OUTCOME_BAND, Math.min(centre + OUTCOME_BAND, at));
  return TALK_LADDER[idx] ?? outcome;
}

/** 잘린 판정이 도구 결과에 남기는 조각 — 잘리지 않았으면 없다 */
function receptivityPiece(
  tier: Receptivity,
  asked: string,
  stood: string,
): { text: string; item: CommandBriefItem } | null {
  if (asked === stood) return null;
  return {
    text: ` (수용성 ${RECEPTIVITY_KO[tier]} — ${asked}은 ${stood}으로)`,
    item: item({ label: "수용성", text: RECEPTIVITY_KO[tier] }),
  };
}

/**
 * 감독이 부른 이름들을 id로 편다 — 심경 문장의 `playerId`가 이름일 수 있어서다
 * (agents.md §7). 풀리지 않는 이름의 줄은 버린다: `applyMoodNotes`가 닿지 않은
 * 선수를 버리는 것과 같은 결이다.
 */
function resolveMoods(
  state: GameState,
  moods: readonly MoodNoteSubmission[],
): MoodNoteSubmission[] {
  const out: MoodNoteSubmission[] = [];
  for (const mood of moods) {
    const pick = pickOurPlayer(state, mood.playerId);
    if (pick.ok) out.push({ ...mood, playerId: pick.player.id });
  }
  return out;
}

/**
 * 판정의 앵커 — 한 명이면 그 선수의 등급, 둘 이상이면 들은 사람들의 수용성 점수
 * **중앙값**의 등급이다 (career.md §2).
 */
function heardReceptivity(state: GameState, heard: readonly GamePlayer[]): Receptivity {
  if (heard.length === 0) return "wary";
  if (heard.length === 1) return receptivityOf(state, heard[0]!.id).tier;
  const scores = heard.map((p) => receptivityOf(state, p.id).score).sort((a, b) => a - b);
  const mid = Math.floor(scores.length / 2);
  const median = scores.length % 2 === 1 ? scores[mid]! : (scores[mid - 1]! + scores[mid]!) / 2;
  return receptivityTierOf(median);
}

/**
 * **합계 상한을 지나 실제로 남는 사기** (career.md §2).
 *
 * 하루와 이레의 남은 여유 중 좁은 쪽까지만 통과시키고, 통과한 만큼을 장부에 적는다.
 * 부호 있는 누계라 +8까지 올린 뒤 질책하면 다시 아래로 갈 자리가 생긴다 — 되풀이가
 * 아니라 뒤집기이므로 막지 않는다.
 */
function creditTalkMorale(state: GameState, player: GamePlayer, delta: number): number {
  if (delta === 0) return 0;
  const from = addDays(state.date, -(TALK_WINDOW_DAYS - 1));
  const log = (player.state.talkMorale ?? []).filter((row) => row.on >= from);
  const today = log.find((row) => row.on === state.date);
  const week = log.reduce((sum, row) => sum + row.sum, 0);
  const dayRoom = (delta > 0 ? TALK_DAILY_BOUND : -TALK_DAILY_BOUND) - (today?.sum ?? 0);
  const weekRoom = (delta > 0 ? TALK_WEEKLY_BOUND : -TALK_WEEKLY_BOUND) - week;
  const applied =
    delta > 0
      ? Math.max(0, Math.min(delta, dayRoom, weekRoom))
      : Math.min(0, Math.max(delta, dayRoom, weekRoom));
  if (applied === 0) {
    // 창 밖의 줄은 여기서도 걷는다 — 상한에 걸린 대화가 장부를 자라게 두지 않는다
    player.state.talkMorale = log;
    return 0;
  }
  if (today) today.sum += applied;
  else log.push({ on: state.date, sum: applied });
  player.state.talkMorale = log;
  return applied;
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
  item: CommandBriefItem;
}

/**
 * 대화·응대가 연 약속을 **한 조각으로** 옮긴다 (people.md §5-2).
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

/** 대화의 인자 — 대상은 `players`가 정하고, 비우면 선수단 전체다 (career.md §2) */
export interface TalkInput {
  /** 그 말을 꺼낸 자리 — `shout`만 경기가 센다 */
  occasion: TeamTalkOccasion;
  /**
   * 감독이 이름을 부른 사람들 — **생략하면 선수단 전체다.**
   * 이름·id 어느 표기든 걸리고, 풀리지 않는 이름은 결과 줄이 그대로 돌려준다.
   */
  players?: readonly string[];
  outcome: TalkOutcome;
  intensity: 1 | 2 | 3;
  /**
   * 이 말이 새 영입들의 적응에 남긴 무게 — 코어 앵커에서 EVENT_BAND만큼만.
   * 같은 "격려"라도 통역을 붙여 준 이야기와 지나가며 한 말은 다르다.
   */
  settling?: number;
  /** 무게의 근거 한 줄 — 정착 원장에 남는다 */
  settlingNote?: string;
  /**
   * 감독이 이 대화에서 한 약속 — **상대가 한 명일 때만 장부에 선다**
   * (career.md §2 · people.md §5-2). 반려돼도 대화 자체는 그대로 성립한다.
   */
  promise?: PromiseInput;
  /** 잔향 — 그 말을 들은 선수에게 남는 심경 한 문장, 최대 `TEAM_TALK_MOODS` (people.md §5) */
  moods?: MoodNoteSubmission[];
}

/**
 * **감독의 말 하나** — 팀토크와 면담이 같은 함수를 지난다 (career.md §2).
 *
 * 판정은 **대화가 마무리된 턴에 한 번** 선다. 그 판단은 도구 설명과 경기 중 해석기의
 * 대화 절이 함께 들고(prompts.md §2), 여기서는 그것이 이미 끝난 것으로 본다.
 *
 * ⚠️ **날짜 게이트가 없다.** 하루에 몇 번이든 대화가 끝날 때마다 판정이 서고, 되풀이는
 * 듣는 선수마다의 **사기 합계 상한**(`creditTalkMorale`)이 자른다.
 */
export function applyTalk(state: GameState, input: TalkInput): CommandResult {
  const shout = input.occasion === "shout";
  /**
   * **외침을 세는 것은 하루가 아니라 경기다** (career.md §2). 라커룸 밖의 말이라
   * 경기당 셋이고, 그 뒤로는 남은 말이 라커룸의 몫이다.
   */
  if (shout) {
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
  }

  const present = matchSquadIds(state);
  /**
   * **대상은 인자가 정한다** — 이름을 적으면 그 사람들, 비우면 선수단 전체다.
   * 외침만은 **그 경기의 명단**으로 한 번 더 좁힌다: 벤치에서 그라운드로 가는 말이라
   * 집에 있는 선수단까지 울릴 수 없다.
   */
  const squad = userPlayers(state);
  const named: GamePlayer[] = [];
  const unresolved: string[] = [];
  for (const ref of input.players ?? []) {
    const pick = pickOurPlayer(state, ref);
    if (pick.ok) {
      if (!named.some((p) => p.id === pick.player.id)) named.push(pick.player);
    } else unresolved.push(ref);
  }
  if ((input.players?.length ?? 0) > 0 && named.length === 0) {
    return { ok: false, message: `그 이름을 찾지 못했습니다 — ${unresolved.join(" · ")}` };
  }
  const addressed = input.players === undefined ? squad : named;
  const heard = shout && present ? addressed.filter((p) => present.has(p.id)) : addressed;
  if (heard.length === 0) {
    return { ok: true, message: "그 말을 들은 선수가 없습니다 — 명단에 없는 이름입니다" };
  }
  /**
   * 외침은 **들은 사람이 정해진 뒤에** 셈한다 — 아무에게도 닿지 않은 말이 경기당 셋
   * 중 하나를 먹으면 감독이 명단에 없는 이름을 부른 대가로 남은 외침을 잃는다.
   */
  if (shout && state.pendingMatch) {
    state.pendingMatch.shouts = (state.pendingMatch.shouts ?? 0) + 1;
  }
  /** 이름을 불렀는가 — 불만 해소·약속·정착 앵커가 갈리는 자리다 */
  const toEveryone = input.players === undefined;
  const alone = heard.length === 1;

  // 앵커는 들은 사람이 정한다 — 판정은 그 앵커 ± 한 단계 안에서만 선다 (career.md §2)
  const tier = heardReceptivity(state, heard);
  const outcome = clampOutcome(input.outcome, tier);
  const clipped = receptivityPiece(tier, input.outcome, outcome);
  const base = TALK_BASE[outcome];

  /**
   * **계수가 셋이다** (career.md §2) — 감독의 리더십이 말을 하는 사람, 관계가 그 말을
   * 듣는 사람, 라커룸이 그 말이 울리는 방이다. 방은 **둘 이상이 들었을 때만** 걸린다.
   * 셋 다 부호를 가리지 않는다 — 믿는 선수는 칭찬도 질책도 크게 듣는다.
   *
   * ⚠️ **이 대화가 사이를 옮기지는 않는다** — 오늘의 말은 어제까지의 사이로 울릴 뿐이고,
   * 등급을 매기는 자리는 이력이 접힐 때의 압축 하나뿐이다 (people.md §6 「관계 등급」).
   */
  const lead = leadershipFactor(state);
  const room = alone ? 1 : dressingRoomFactor(state, state.userTeamId, present);
  const voice = alone ? null : dressingRoomVoice(state, state.userTeamId, present);
  const bound = shout ? SHOUT_MORALE_BOUND : alone ? TALK_MORALE_BOUND : ROOM_MORALE_BOUND;
  const scale = (input.intensity / TALK_INTENSITY_PIVOT) * lead * room * (shout ? SHOUT_SCALE : 1);

  /** 실제로 남은 사기 — 상한에 걸린 사람은 0이다 */
  const applied = new Map<string, number>();
  for (const p of heard) {
    const raw = roundAwayFromZero(base * scale * relationFactor(state, MANAGER_SUBJECT, p.id));
    const bounded = Math.max(-bound, Math.min(bound, raw));
    const landed = creditTalkMorale(state, p, bounded);
    if (landed !== 0) p.state.form = clampForm(p.state.form + moraleToForm(landed));
    applied.set(p.id, landed);
  }
  const landed = [...applied.values()].filter((v) => v !== 0);
  const moved = landed.length;
  const low = moved > 0 ? Math.min(...landed) : 0;
  const high = moved > 0 ? Math.max(...landed) : 0;
  /** 감독이 읽는 한 줄 — 전원이 같은 값이면 한 수, 갈리면 폭이다 */
  const moraleText =
    moved === 0 ? "0" : low === high ? signed(low) : `${signed(low)}~${signed(high)}`;

  /**
   * **불만은 이름을 부른 사람에게만 풀린다** (career.md §2). 이름 없이 선수단 전체에
   * 한 말은 아무 불만도 풀지 않는다 — 라커룸에 던진 격려는 그와 마주 앉은 것이 아니다.
   * 따뜻하게 닿은 판정만 지운다: 결과와 무관하게 지우면 화를 내고 나오는 것도 불만
   * 해소책이 된다.
   */
  const resolves = !toEveryone && RESOLVING_OUTCOMES.has(outcome);
  const relieved = resolves
    ? heard.filter((p) => state.issues.some((i) => i.gamePlayerId === p.id))
    : [];
  if (relieved.length > 0) {
    const ids = new Set(relieved.map((p) => p.id));
    state.issues = state.issues.filter((i) => !ids.has(i.gamePlayerId ?? ""));
  }

  /**
   * 잔향은 **불만이 풀린 뒤에** 선다 — 앞에 두면 방금 푼 불만을 안으라고 요구해
   * 잘 풀린 대화의 문장이 버려진다 (`applyMoodNotes`의 세 번째 문).
   * 그 말을 들은 선수에게만, 셋까지 — 넘치면 앞의 셋이다.
   */
  applyMoodNotes(
    state,
    resolveMoods(state, (input.moods ?? []).slice(0, TEAM_TALK_MOODS)),
    new Set(heard.map((p) => p.id)),
  );

  /**
   * **정착 크레딧의 앵커는 대상 수가 가른다** (player.md §9.3) — 마주 앉아 들은 말이
   * `talk`(5±4), 라커룸 앞에서 이름이 불린 것이 `team_talk`(1.5±1.5)다.
   *
   * ⚠️ **사기가 움직이지 않은 대화(`neutral`)에는 방향이 없다** — 크레딧도 0이다.
   * 부호로 방향을 가르면 0이 음수 쪽에 떨어져, 나쁘지도 않았던 대화가 적응을 뒤로
   * 민다. 외침에는 크레딧이 아예 없다 — 새 영입을 라커룸으로 끌어들이는 것은 마주
   * 앉아 한 말의 몫이지 90분 사이에 던진 한마디가 아니다.
   */
  const settlingKind = alone ? ("talk" as const) : ("team_talk" as const);
  const settlingAnchorValue = settlingAnchor(settlingKind, {
    direction: base > 0 ? 1 : -1,
    intensity: input.intensity,
  });
  const settled =
    base === 0 || shout
      ? []
      : heard.filter(
          (p) =>
            creditSettling(state, p.id, settlingKind, {
              anchor: settlingAnchorValue,
              ...(input.settling === undefined ? {} : { proposed: input.settling }),
              ...(input.settlingNote === undefined ? {} : { note: input.settlingNote }),
            }) !== 0,
        );
  const settling = alone && settled.length > 0 ? settlingOf(state, heard[0]!.id) : null;

  /**
   * ── 약속은 **판정이 끝난 뒤에** 장부에 선다 ── (career.md §2 · people.md §5-2)
   *
   * **상대가 한 명일 때만 받는다** — 여럿에게 동시에 한 약속은 누가 그 약속의 주인인지
   * 장부가 가리지 못한다.
   *
   * ⚠️ 순서가 뒤집히면 방금 연 약속이 대화의 불만 해소에 쓸려 나갈 여지가 생긴다.
   * 지금 지우는 것은 `state.issues`뿐이라 실제로는 닿지 않지만, 그 안전이 지워지는
   * 자리와 열리는 자리의 **간격**에 기대고 있으므로 순서를 명시적으로 둔다.
   */
  const promised = !input.promise
    ? null
    : alone
      ? promisePiece(
          openPromise(
            state,
            heard[0]!.id,
            input.promise.kind,
            input.promise.days,
            input.promise.number,
          ),
        )
      : {
          text: " · 약속 반려 — 여럿에게 한 약속은 장부에 서지 않습니다",
          item: item({ label: "약속", text: "반려", note: "상대가 한 명일 때만" }),
        };

  /**
   * **리더십 XP도 같은 합계에 묶인다** (career.md §2) — 아무에게도 닿지 않은 대화에는
   * XP가 없다. 합계 상한이 다 먹은 대화도, 사기가 움직이지 않은 대화(`neutral`)도 같다.
   * 묶지 않으면 같은 선수를 하루 종일 부르는 것이 리더십을 올리는 최적 전략이 된다.
   */
  const xpPerIntensity = shout ? SHOUT_XP_PER_INTENSITY : TALK_XP_PER_INTENSITY;
  const xpMsg =
    moved === 0
      ? null
      : base > 0
        ? grantManagerXP(state, "leadership", xpPerIntensity * input.intensity)
        : grantManagerXP(state, "leadership", TALK_XP_ON_FAILURE);

  /** 감독이 읽는 대상 이름 — 전원이면 「팀」, 아니면 부른 이름들 */
  const whoKo = toEveryone
    ? shout
      ? "명단"
      : "팀"
    : alone
      ? heard[0]!.name
      : briefNames(heard.map((p) => p.name));
  const used = state.pendingMatch?.shouts ?? 0;
  pushNarrative(
    state,
    `${shout ? "외침" : "대화"}(${outcome}) — ${whoKo} 사기 ${moraleText}`,
    // 하루 한 번의 라커룸 장면과 90분 사이의 한마디가 같은 무게로 남지는 않는다
    shout ? 1 : 2,
  );
  /**
   * 실마리는 **이름을 불렀는가**가 가른다 (career.md §1) — 그 사람과 마주 앉은 것은
   * 그에게 걸린 실마리를 닫고, 선수단 전체에 한 말은 걸린 사람 없는 라커룸만 닫는다.
   */
  if (toEveryone) touchOpenings(state, { kinds: ["dressing-room"] });
  else touchOpenings(state, { subjectIds: heard.map((p) => p.id) });

  const capped = moved < heard.length;
  return {
    ok: true,
    // 펼치지 않아도 잘 풀렸는지는 알아야 한다 — 숫자는 펼쳤을 때만
    tone: (moved === 0 ? base >= 0 : high >= 0) ? ("good" as const) : ("bad" as const),
    message:
      `${whoKo} 사기 ${moraleText}` +
      (clipped ? clipped.text : "") +
      (capped ? ` · ${heard.length - moved}명은 대화 사기 상한에 닿아 그대로입니다` : "") +
      (relieved.length > 0 ? ` · 불만 해소 ${briefNames(relieved.map((p) => p.name))}` : "") +
      (shout ? ` · 이번 경기 외침 ${used}/${SHOUT_PER_MATCH}` : "") +
      (settling ? ` · 적응 ${Math.round(settling.progress * 100)}%` : "") +
      (!settling && settled.length > 0
        ? ` · 적응 중인 ${settled.length}명이 한 걸음 가까워졌습니다`
        : "") +
      (promised ? promised.text : "") +
      (xpMsg ? ` · ${xpMsg}` : "") +
      (unresolved.length > 0 ? ` · 찾지 못한 이름 ${unresolved.join(" · ")}` : "") +
      (alone ? ` · ${receptivityLine(receptivityOf(state, heard[0]!.id))}` : ""),
    /**
     * 사기 변화는 **항목 하나**다 — 부호는 `delta`가 나르고 화면이 색을 준다.
     * 감독이 무슨 말을 어떻게 했는지는 장면의 것이지 알림의 것이 아니다.
     */
    brief: {
      head: shout
        ? "정지점 외침"
        : toEveryone
          ? `${OCCASION_KO[input.occasion]} 팀토크`
          : alone
            ? `${heard[0]!.name} 대화`
            : `${heard.length}명 대화`,
      items: [
        ...(low === high
          ? [item({ label: `${whoKo} 사기`, text: moraleText, delta: low })]
          : [item({ label: `${whoKo} 사기`, text: moraleText })]),
        ...(clipped ? [clipped.item] : []),
        ...(capped ? [item({ label: "상한", text: `${heard.length - moved}명` })] : []),
        ...(relieved.length > 0
          ? [item({ text: "불만 해소", note: briefNames(relieved.map((p) => p.name)) })]
          : []),
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
                note: `${captainVoiceName(state, present) ?? "완장 공석"} · 리더십 ${Math.round(voice)}`,
              }),
            ]),
        ...(settling
          ? [item({ label: "적응", text: `${Math.round(settling.progress * 100)}%` })]
          : settled.length > 0
            ? [item({ label: "적응", text: `${settled.length}명` })]
            : []),
        ...(promised ? [promised.item] : []),
      ],
    },
  };
}

/** 그 방에 선 완장 — 주장이 없는 자리에서는 부주장이 그 이름이다 */
function captainVoiceName(
  state: GameState,
  present: ReadonlySet<string> | undefined,
): string | undefined {
  const wearing = userPlayers(state).filter((p) => present === undefined || present.has(p.id));
  return (wearing.find((p) => p.isCaptain) ?? wearing.find((p) => p.isViceCaptain === true))?.name;
}

// ---- 사건 기록: 감독이 말로 만든 사건이 장부에 서는 자리 (people.md §6) ----

/** 하루에 세울 수 있는 사건 수 — 서사 줄의 갈래(`incident`)로 센다 */
export const MAX_INCIDENTS_PER_DAY = 3;
/** 한 사건이 당사자의 사기를 움직일 수 있는 폭 — 면담 한 번(±8)보다 좁다 */
export const INCIDENT_MORALE_BOUND = 6;
/** 요약의 상한 — `IncidentSchema.summary`와 같은 수 */
const INCIDENT_SUMMARY_MAX = 200;
/** 인물 기억 한 줄의 상한 — `CharacterMemorySchema.text`와 같은 수. 요약이 길면 여기서 접는다 */
const INCIDENT_MEMORY_MAX = 120;

/**
 * 갈래 → 효과의 모양 (people.md §6 「사건 기록」) — 당사자 사기는 세기 2의 값이고,
 * 팀 사기는 세기와 무관하다. **사이는 여기서 움직이지 않는다** (career.md §2) — 그 일이
 * 두 사람 사이에 무엇을 했는지는 이력이 접힐 때의 압축이 읽는다.
 */
const INCIDENT_EFFECTS: Record<IncidentKind, { morale: number; team: number }> = {
  discipline: { morale: -4, team: 1 },
  reward: { morale: 4, team: 1 },
  care: { morale: 3, team: 0 },
  "public-praise": { morale: 3, team: 1 },
  "public-criticism": { morale: -4, team: -1 },
  apology: { morale: 2, team: 0 },
  mediation: { morale: 1, team: 0 },
  rule: { morale: -1, team: 0 },
  outing: { morale: 2, team: 2 },
  other: { morale: 0, team: 0 },
};

/** 정착 크레딧이 붙는 갈래 — 겉도는 새 영입에게 감독이 손을 뻗은 일 */
const INCIDENT_SETTLING_KINDS: ReadonlySet<IncidentKind> = new Set(["care", "reward"]);

/** 세기 → 서사·기억의 무게 (1→2 · 2→3 · 3→4) */
const incidentSalience = (intensity: 1 | 2 | 3): number => intensity + 1;

/**
 * `record_incident` — 벌금·포상·병문안·공개 칭찬과 질책·사과·중재·규칙·회식.
 * 코어가 만들지도 읽지도 못하는 사건을 GM이 그 턴에 세운다. 코어는 갈래·당사자·
 * 세기만 들고, 무슨 일이었는지는 `summary`와 장면의 것이다.
 *
 * 검증이 전부 앞에 선다 — 없는 이름이 하나라도 있으면 아무것도 움직이지 않는다.
 */
export function recordIncident(
  state: GameState,
  input: {
    kind: IncidentKind;
    /** 당사자 — 감독이 부른 이름 그대로 올 수 있다 (`pickOurPlayer`) */
    playerIds: string[];
    intensity: 1 | 2 | 3;
    /** 무슨 일이었나 — 한 줄 */
    summary: string;
    /** 잔향 — 당사자에게 남는 심경 문장. `playerId`는 이름일 수 있다 */
    moods?: MoodNoteSubmission[];
  },
): CommandResult {
  const todayCount = state.narrative.filter(
    (n) => n.date === state.date && n.kind === "incident",
  ).length;
  if (todayCount >= MAX_INCIDENTS_PER_DAY) {
    return { ok: false, message: `오늘의 사건 한도(${MAX_INCIDENTS_PER_DAY}건)를 넘었습니다` };
  }
  const summary = input.summary.trim();
  if (summary.length === 0 || summary.length > INCIDENT_SUMMARY_MAX) {
    return { ok: false, message: `요약은 1~${INCIDENT_SUMMARY_MAX}자여야 합니다` };
  }
  const resolved = input.playerIds.map((ref) => pickOurPlayer(state, ref));
  const missing = resolved.filter((r) => !r.ok);
  if (missing.length > 0) {
    return { ok: false, message: missing.map((r) => (r.ok ? "" : r.message)).join(" · ") };
  }
  const parties: GamePlayer[] = [];
  for (const r of resolved) {
    if (r.ok && !parties.some((p) => p.id === r.player.id)) parties.push(r.player);
  }
  if (parties.length === 0) return { ok: false, message: "당사자가 없습니다" };

  const effect = INCIDENT_EFFECTS[input.kind];
  // 면담과 같은 세기 배수 — 리더십·관계 계수는 곱하지 않는다 (people.md §6)
  const morale = Math.max(
    -INCIDENT_MORALE_BOUND,
    Math.min(
      INCIDENT_MORALE_BOUND,
      Math.round(effect.morale * (input.intensity / TALK_INTENSITY_PIVOT)),
    ),
  );
  for (const p of parties) p.state.form = clampForm(p.state.form + moraleToForm(morale));
  if (effect.team !== 0) {
    for (const p of userPlayers(state)) {
      p.state.form = clampForm(p.state.form + moraleToForm(effect.team));
    }
  }

  const settled = INCIDENT_SETTLING_KINDS.has(input.kind)
    ? parties.filter(
        (p) =>
          creditSettling(state, p.id, "incident", {
            anchor: settlingAnchor("incident", { intensity: input.intensity }),
          }) > 0,
      ).length
    : 0;

  const salience = incidentSalience(input.intensity);
  // 인물 기억이 즉시 선다 — 선수의 characterId는 이름이다 (people.md §6 · §9-1)
  applyCharacterMemories(
    state,
    parties.map((p) => ({
      characterId: p.name,
      text: summary.slice(0, INCIDENT_MEMORY_MAX),
      salience,
    })),
  );
  pushNarrative(state, summary, salience, "incident");
  // 당사자에게 걸린 시작 사건은 그 사건이 닫는다 (career.md §1)
  touchOpenings(state, { subjectIds: parties.map((p) => p.id) });
  (state.incidents ??= []).push({
    date: state.date,
    kind: input.kind,
    playerIds: parties.map((p) => p.id),
    intensity: input.intensity,
    summary,
  });
  applyMoodNotes(state, resolveMoods(state, input.moods ?? []), new Set(parties.map((p) => p.id)));

  const names = parties.map((p) => p.name);
  const head = INCIDENT_KIND_KO[input.kind];
  return {
    ok: true,
    tone: morale >= 0 ? ("good" as const) : ("bad" as const),
    message:
      `${head} — ${names.join(", ")}` +
      ` · 사기 ${signed(morale)}` +
      (effect.team === 0 ? "" : ` · 팀 사기 ${signed(effect.team)}`) +
      (settled > 0 ? ` · 적응 중인 ${settled}명이 한 걸음 가까워졌습니다` : ""),
    brief: {
      head,
      items: [
        item({ text: briefNames(names) }),
        ...deltaItems([
          ["사기", morale],
          ["팀 사기", effect.team],
        ]),
        ...(settled > 0 ? [item({ label: "적응", text: `${settled}명` })] : []),
      ],
    },
  };
}
