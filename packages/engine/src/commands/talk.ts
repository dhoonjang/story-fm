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
import { clampForm, moraleToForm } from "../squad/form";

import { creditSettling, settlingAnchor, settlingOf } from "../squad/settling";
// 면담에서 한 약속은 장부에 선다 (people.md §5-2 · career.md §2)
import { openPromise, type PromiseOpened } from "../squad/promises";
// 감독이 지목한 번호는 코어가 배정하고, 사실만 돌려준다 (player.md §1.1)
// 면담의 사기는 감독과 그 선수 사이의 등급을 탄다 (people.md §6 「관계 등급」)
import { MANAGER_SUBJECT, relationFactor } from "../world/relations";
// 잔향 — 그 대화를 쥔 호출이 심경 한 문장을 남긴다 (people.md §5)
import {
  applyMoodNotes,
  TEAM_TALK_MOODS,
  type MoodLine,
  type MoodNoteSubmission,
} from "../squad/mood";
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

/**
 * 판정 사다리 — 가운데가 `neutral`이고 수용성 앵커가 그 자리를 옮긴다 (career.md §2).
 * `feared`는 사다리 밖이라 그대로 선다.
 */
const TALK_LADDER: readonly TalkOutcome[] = [
  "angered",
  "disappointed",
  "neutral",
  "reassured",
  "motivated",
];
const TEAM_TALK_LADDER: readonly TeamTalkOutcome[] = [
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
function clampOutcome<T extends string>(ladder: readonly T[], outcome: T, tier: Receptivity): T {
  const at = ladder.indexOf(outcome);
  if (at < 0) return outcome;
  const centre = Math.floor(ladder.length / 2) + RECEPTIVITY_ANCHOR[tier];
  const idx = Math.max(centre - OUTCOME_BAND, Math.min(centre + OUTCOME_BAND, at));
  return ladder[idx] ?? outcome;
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

/** 팀토크의 앵커 — 그 말을 들은 명단의 수용성 점수 **중앙값**의 등급 (career.md §2) */
function roomReceptivity(state: GameState, heard: readonly GamePlayer[]): Receptivity {
  if (heard.length === 0) return "wary";
  const scores = heard.map((p) => receptivityOf(state, p.id).score).sort((a, b) => a - b);
  const mid = Math.floor(scores.length / 2);
  const median = scores.length % 2 === 1 ? scores[mid]! : (scores[mid - 1]! + scores[mid]!) / 2;
  return receptivityTierOf(median);
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
    /** 잔향 — 그 말을 들은 선수에게 남는 심경 한 문장, 최대 `TEAM_TALK_MOODS` (people.md §5) */
    moods?: MoodNoteSubmission[];
  },
): CommandResult {
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
     * (`tactic-apply.ts`), 문이 없으면 같은 말을 반복하는 것이 폼을 올리는 최적
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

  const present = matchSquadIds(state);
  /**
   * **외침은 그 경기의 명단에만 닿는다** — 벤치에서 그라운드로 가는 말이라 집에 있는
   * 선수단까지 울릴 수 없다. 라커룸의 팀토크는 선수단 전체의 것이다 (career.md §2).
   */
  const heard =
    shout && present ? userPlayers(state).filter((p) => present.has(p.id)) : userPlayers(state);
  // 방의 수용성이 앵커다 — 판정은 그 앵커 ± 한 단계 안에서만 선다 (career.md §2)
  const tier = roomReceptivity(state, heard);
  const outcome = clampOutcome(TEAM_TALK_LADDER, input.outcome, tier);
  const clipped = receptivityPiece(tier, input.outcome, outcome);
  const base = TEAM_TALK_BASE[outcome];
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
  for (const p of heard) {
    p.state.form = clampForm(p.state.form + moraleToForm(bounded));
  }
  // 잔향은 그 말을 들은 선수에게만, 셋까지 — 넘치면 앞의 셋이다
  applyMoodNotes(
    state,
    resolveMoods(state, (input.moods ?? []).slice(0, TEAM_TALK_MOODS)),
    new Set(heard.map((p) => p.id)),
  );
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
    `${shout ? "외침" : "팀토크"}(${outcome}) — 사기 ${bounded >= 0 ? "+" : ""}${bounded}`,
    // 하루 한 번의 라커룸 장면과 90분 사이의 한마디가 같은 무게로 남지는 않는다
    shout ? 1 : 2,
  );
  // 선수단에 한 말은 **걸린 사람 없는** 라커룸 실마리만 닫는다 (career.md §1)
  touchOpenings(state, { kinds: ["dressing-room"] });
  return {
    ok: true,
    // 펼치지 않아도 잘 풀렸는지는 알아야 한다 — 숫자는 펼쳤을 때만
    tone: bounded >= 0 ? ("good" as const) : ("bad" as const),
    message:
      `${shout ? "명단" : "팀"} 전체 사기 ${bounded >= 0 ? "+" : ""}${bounded}` +
      (clipped ? clipped.text : "") +
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
        ...(clipped ? [clipped.item] : []),
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
  item: CommandBriefItem;
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
    /** 잔향 — 이 면담이 그 선수에게 남긴 심경 한 문장 (people.md §5) */
    mood?: MoodLine;
  },
): CommandResult {
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

  /**
   * **앵커를 읽는 것이 먼저다** — 오늘의 말은 어제까지의 사이와 지금의 마음으로 울린다.
   * 잘린 outcome이 사기·관계·XP·불만 해소 전부의 근거다 (career.md §2).
   */
  const read = receptivityOf(state, player.id);
  const outcome = clampOutcome(TALK_LADDER, input.outcome, read.tier);
  const clipped = receptivityPiece(read.tier, input.outcome, outcome);
  const base = TALK_BASE[outcome];
  /**
   * **계수가 둘이다** (career.md §2) — 감독의 리더십이 말을 하는 사람이라면 관계는
   * 그 말을 듣는 사람이다. 부호를 가리지 않는 것은 리더십·라커룸 계수와 같은 규약이라,
   * 믿는 선수는 칭찬도 질책도 크게 듣는다.
   *
   * ⚠️ **면담이 사이를 옮기지는 않는다** — 오늘의 말은 어제까지의 사이로 울릴 뿐이고,
   * 등급을 매기는 자리는 이력이 접힐 때의 압축 하나뿐이다 (people.md §6 「관계 등급」).
   */
  const delta = Math.round(
    base *
      (input.intensity / TALK_INTENSITY_PIVOT) *
      leadershipFactor(state) *
      relationFactor(state, MANAGER_SUBJECT, player.id),
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
   * 잔향은 **불만이 풀린 뒤에** 선다 — 앞에 두면 방금 푼 불만을 안으라고 요구해
   * 잘 풀린 면담의 문장이 버려진다 (`applyMoodNotes`의 세 번째 문).
   */
  if (input.mood) {
    applyMoodNotes(state, [{ ...input.mood, playerId: player.id }], new Set([player.id]));
  }

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
    `${player.name} 면담(${outcome}) — 사기 ${bounded >= 0 ? "+" : ""}${bounded}`,
    2,
  );
  // 그 선수에게 걸린 시작 사건은 마주 앉은 것으로 닫힌다 (career.md §1)
  touchOpenings(state, { subjectIds: [player.id] });
  return {
    ok: true,
    tone: bounded >= 0 ? ("good" as const) : ("bad" as const),
    message:
      `${player.name} 사기 ${bounded >= 0 ? "+" : ""}${bounded}` +
      (clipped ? clipped.text : "") +
      (hadIssue ? " · 불만 해소" : "") +
      (settling ? ` · 적응 ${Math.round(settling.progress * 100)}%` : "") +
      (promised ? promised.text : "") +
      (xpMsg ? ` · ${xpMsg}` : "") +
      ` · ${receptivityLine(read)}`,
    brief: {
      head: `${player.name} 면담`,
      items: [
        item({ label: "사기", text: signed(bounded), delta: bounded }),
        ...(clipped ? [clipped.item] : []),
        ...(hadIssue ? [item({ text: "불만 해소" })] : []),
        ...(settling
          ? [item({ label: "적응", text: `${Math.round(settling.progress * 100)}%` })]
          : []),
        ...(promised ? [promised.item] : []),
      ],
    },
  };
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
