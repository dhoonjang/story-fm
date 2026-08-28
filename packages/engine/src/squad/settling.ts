import type {
  GamePlayer,
  Injury,
  SettlingEvent,
  TrainingSession,
  Transfer,
} from "@story-fm/domain";
import { ageOf, isReserveMatch, PLAYER_ARCHETYPE_LABEL } from "@story-fm/domain";
import type { PlayerArchetypeKey } from "@story-fm/domain";
import { diffDays } from "../competition/calendar";
import { countryOfTeam } from "../data/team-catalog";
import { archetypeTraitsOf, playerArchetypeOf } from "../world/player-persona";
import { leaderSettlingRelief } from "./hierarchy";
import { MENTOR_SETTLING, mentorPairOf } from "./mentoring";
import { playerById, playersOf, teamNameIn, type GameState } from "../core/state";

/**
 * 정착 — 새 팀에 녹아드는 일. **날짜가 아니라 겪은 양이다.**
 *
 * (전술·포지션 적응도(`adaptationOf` — domain)와 다른 축이다. 그건 "이 자리와
 * 이 전술을 아는가"이고, 여기는 "이 클럽 사람이 됐는가"다.)
 *
 * 영입 후 고정 일수로 재면 안 된다 — 매 경기 선발로 뛴 선수와 벤치에서 여섯
 * 주를 보낸 선수가 같은 날 적응을 마친다. 감독이 무엇을 하든 결과가 같으면
 * 그건 규칙이 아니라 타이머다.
 *
 * 진행도는 **감독이 하는 일**로 쌓인다: 경기에 내보내면 크게, 훈련에
 * 세우면 조금씩, 아무 데도 안 쓰면 그저 함께 지낸 나날만큼. 필요한 양은
 * **그 이적이 얼마나 큰 변화였는지**가 정한다 — 나라를 건넜는가, 라커룸에
 * 말이 통하는 사람이 있는가, 처음 겪는 무대인가.
 *
 * 대부분 저장하지 않는다. TRANSFER 원장(언제 왔나) · 경기 출전 명단(몇 번
 * 뛰었나) · 훈련 일정(며칠 함께 훈련했나)에서 파생하므로 세이브 버전이 오르지
 * 않고, 같은 상태면 언제나 같은 값이다. **면담·팀토크만 원장이 필요하다**
 * (`SETTLING_EVENT`) — 대화는 어디에도 기록이 남지 않아 파생할 원본이 없다.
 */

/** 적응을 마치는 데 필요한 기준 크레딧 (여기에 난이도 배수가 곱해진다) */
export const SETTLING_TARGET = 100;

/**
 * 경기 한 번 = 훈련 대엿새. 라커룸은 훈련장이 아니라 경기장에서 열린다 —
 * 감독이 쥔 가장 큰 손잡이가 출전이어야 "안 쓰면 안 녹아든다"가 성립한다.
 */
export const MATCH_CREDIT = 8;
/** 팀 훈련 하루 */
export const TRAINING_CREDIT = 1.5;
/** 그냥 함께 보낸 하루 — 바닥값이라 아무도 안 쓰는 선수도 언젠가는 적응한다 */
export const DAY_CREDIT = 0.5;

/**
 * 감독이 **말로** 앞당기는 몫 (`SETTLING_EVENT`).
 *
 * 출전이 가장 크지만, 아직 못 쓰는 선수에게 감독이 할 수 있는 일이 있어야 한다 —
 * 불러서 이야기하고, 라커룸 앞에서 이름을 부르고, 완장을 채우는 것. 크기는
 * 경기보다 작다: 말은 계기이고 녹아드는 건 그라운드에서다.
 *
 * ⚠️ **하루에 한 번만 쌓인다.** 같은 말을 열 번 해도 한 번이다 —
 * 안 그러면 면담을 연타하는 것이 최적 전략이 된다.
 */
export const EVENT_CREDIT: Record<SettlingEvent["kind"], number> = {
  /** 개인 면담 — 좋은 결과면 이만큼, 나쁘면 음수로 뒤집힌다 */
  talk: 5,
  /** 팀토크 — 팀 전체에 한 말이라 개인 면담보다 작다 */
  team_talk: 1.5,
  /**
   * 주장 지명 — 새 영입에게 완장을 채우는 건 라커룸 한가운데 세우는 일이다.
   * 지명은 되돌려도 다시 쌓이지 않는다(같은 날 한 번 · 같은 종류 한 번).
   */
  captain: 15,
  /** 감독이 말로 만든 사건(`care`·`reward`) — 마주 앉은 면담보다 작다 (people.md §6) */
  incident: 3,
};

/**
 * **무게는 GM이 정하고, 경계는 코어가 쥔다** (경기 평점과 같은 구조).
 *
 * 같은 "격려"라도 통역을 붙여 준 이야기와 지나가며 한 말은 다르다. 그 차이는
 * outcome·intensity 두 눈금으로 표현되지 않으므로, GM이 그 대화가 실제로
 * 얼마짜리였는지를 스킬 인자로 적는다. 코어는 **앵커에서 이만큼까지만** 허용한다 —
 * 판정을 넘기되 눈금이 통째로 밀려나지는 않게.
 */
export const EVENT_BAND: Record<SettlingEvent["kind"], number> = {
  talk: 4,
  team_talk: 1.5,
  captain: 5,
  incident: 2,
};

/**
 * 난이도 배수 한 줄 — **코드와 수치다** (player.md §9.3).
 *
 * 저장되지 않는 파생값이지만, 연출어(`"스페인에서 건너왔다"`)를 여기서 지으면 화면과
 * 선수 카드가 그 문장을 그대로 실어 나르고 문구를 고치려면 엔진을 고쳐야 한다.
 * 문장은 `settlingFactorText`가 만든다 (overview.md §1 철칙 4).
 */
export interface SettlingFactor {
  code: "abroad" | "compatriot" | "mentor" | "young" | "veteran" | "archetype" | "leaders";
  multiplier: number;
  /** `abroad` — 건너온 나라 */
  from?: string;
  /** `compatriot` — 라커룸에 있는 같은 협회 출신 · `mentor` — 붙여 준 고참 */
  playerId?: string;
  /** `young`·`veteran` — 그때의 나이 */
  age?: number;
  /** `archetype` — 그 사람의 원형 코드 (people.md §6) */
  archetype?: PlayerArchetypeKey;
  /** `leaders` — 본인을 뺀 리더 그룹의 리더십 평균 (people.md §5-1) */
  leadership?: number;
}

export interface Settling {
  /** 우리 팀에 온 날 (TRANSFER 원장) */
  joinedOn: string;
  /** 0~1 */
  progress: number;
  credit: number;
  target: number;
  /** 무엇이 쌓았나 — 화면·서사가 그대로 읽는다 */
  matches: number;
  trainings: number;
  days: number;
  /** 면담·팀토크·주장 지명이 보탠 몫 (음수일 수 있다) */
  eventCredit: number;
  factors: SettlingFactor[];
  done: boolean;
}

/**
 * 원장이 말하는, 그 줄 시점의 우리와 이 선수의 사이.
 * `type:"loan"`이 네 가지 이동을 다 적기 때문에 필요하다 (`joinedUserTeamOn`).
 */
type Tie =
  /** 우리 팀 사람이 아니다 */
  | "none"
  /** 우리 소속으로 여기 있다 */
  | "signed"
  /** 임대로 와 있다 — 계약은 저쪽에 있다 */
  | "borrowed"
  /** 우리 선수인데 임대로 나가 있다 */
  | "lent";

/**
 * 이 선수가 우리 팀에 들어온 날 — TRANSFER 원장의 마지막 영입 기록.
 * 원소속(게임 시작 스쿼드)은 기록이 없으므로 null.
 * **유스 콜업과 임대 복귀는 적응이 없다** — 이미 이 클럽 사람이고 훈련장도 같다.
 *
 * ⚠️ **`type:"loan"` 한 종류가 네 가지 이동을 적는다** — 임대 영입 · 그 선수의
 * 반납 · 우리 선수 임대 송출 · 그 선수의 복귀. 방향만 봐서는 복귀와 영입이 같은
 * 모양(`toTeamId` = 우리)이라, 원장을 날짜 순으로 걸으며 **직전까지의 사이**로
 * 가른다: 나가 있던 우리 선수가 돌아온 줄은 온 날이 아니고, 임대로 데려온 선수의
 * 줄은 온 날이다.
 */
export function joinedUserTeamOn(state: GameState, playerId: string): string | null {
  // 원장에 줄이 없는 선수가 대부분이다 — 정렬은 걸을 줄이 있을 때만 한다
  const ledger: Transfer[] = [];
  for (const t of state.transfers) if (t.gamePlayerId === playerId) ledger.push(t);
  if (ledger.length === 0) return null;
  ledger.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let tie: Tie = "none";
  let joined: string | null = null;
  for (const t of ledger) {
    if (t.toTeamId === state.userTeamId) {
      if (t.type === "youth") {
        tie = "signed"; // 콜업 — 이미 이 클럽 사람이라 온 날이 없다
        joined = null;
      } else if (t.type !== "loan") {
        tie = "signed";
        joined = t.date;
      } else if (tie === "lent") {
        tie = "signed"; // 우리가 내보낸 임대의 복귀 — 처음 온 날이 그대로 남는다
      } else {
        tie = "borrowed";
        joined = t.date;
      }
    } else if (t.fromTeamId === state.userTeamId) {
      if (t.type !== "loan") {
        tie = "none"; // 이적·방출·은퇴로 떠났다
        joined = null;
      } else if (tie === "borrowed") {
        tie = "none"; // 임대로 와 있던 선수를 원소속에 돌려보냈다
        joined = null;
      } else {
        tie = "lent"; // 우리 선수를 임대로 내보냈다 — 계약은 우리에게 남는다
      }
    }
  }
  return joined;
}

/** 그 날 부상 중이었나 — 부상 기간의 훈련은 적응에 쌓이지 않는다 */
function injuredOn(injuries: readonly Injury[], date: string): boolean {
  return injuries.some((i) => i.occurredOn <= date && date < (i.returnedOn ?? i.expectedReturn));
}

/** 영입 이후 우리 팀에서 그라운드를 밟은 횟수 */
function matchesSince(state: GameState, playerId: string, since: string): number {
  let count = 0;
  for (const match of state.matches) {
    if (!match.result || match.date < since) continue;
    // 정착은 1군 무대의 것이다 — 2군 경기로는 새 팀에 녹아들었다고 말하지 않는다
    if (isReserveMatch(match)) continue;
    const lineup =
      match.homeTeamId === state.userTeamId
        ? match.result.homeLineup
        : match.awayTeamId === state.userTeamId
          ? match.result.awayLineup
          : undefined;
    if (lineup?.includes(playerId)) count += 1;
  }
  return count;
}

/**
 * 영입 이후 실제로 치른 팀 훈련 일수 (휴식 세션·부상 기간 제외).
 *
 * 세션과 부상은 **하루마다가 아니라 한 번** 추린다 — 일정 × 세션 × 부상이던
 * 자리다. `find`가 첫 줄을 고르므로 색인도 먼저 만난 줄을 남긴다.
 */
function trainingsSince(state: GameState, playerId: string, since: string): number {
  const sessions = new Map<string, TrainingSession>();
  for (const session of state.trainingSessions) {
    if (!sessions.has(session.id)) sessions.set(session.id, session);
  }
  const injuries = state.injuries.filter((i) => i.gamePlayerId === playerId);
  let count = 0;
  for (const entry of state.schedule) {
    if (entry.type !== "training" || entry.status !== "done") continue;
    if (entry.date < since || entry.date > state.date) continue;
    if (sessions.get(entry.refId)?.rest) continue; // 쉬는 날은 함께한 훈련이 아니다
    if (injuredOn(injuries, entry.date)) continue;
    count += 1;
  }
  return count;
}

/** 라커룸에 같은 협회에서 자란 선수가 있는가 */
function compatriotIn(state: GameState, player: GamePlayer): GamePlayer | null {
  if (player.homegrownCountry === undefined) return null;
  return (
    playersOf(state, state.userTeamId).find(
      (p) => p.id !== player.id && p.homegrownCountry === player.homegrownCountry,
    ) ?? null
  );
}

/**
 * 얼마나 큰 변화였나 — 필요 크레딧에 곱해진다.
 * 여기 없는 것(감독이 하는 일)은 배수가 아니라 **쌓는 속도**로 들어간다.
 */
function loadFactors(state: GameState, player: GamePlayer, from: string | null): SettlingFactor[] {
  const factors: SettlingFactor[] = [];

  if (from) {
    const before = countryOfTeam(from);
    const here = countryOfTeam(state.userTeamId);
    if (before && here && before !== here) {
      factors.push({ code: "abroad", multiplier: 1.3, from: before });
    }
  }

  const mate = compatriotIn(state, player);
  if (mate) factors.push({ code: "compatriot", multiplier: 0.85, playerId: mate.id });

  /**
   * **감독이 데리고 다니라고 붙여 준 고참은 같은 협회 출신과 같은 무게다**
   * (people.md §5-3). 사이가 닫히면 그 자리에서 빠진다 — 배수는 저장하지 않고
   * 장부에서 다시 매기므로, 멘토가 떠난 다음 날의 목표는 이미 다른 값이다.
   */
  const pair = mentorPairOf(state, player.id);
  if (pair) factors.push({ code: "mentor", multiplier: MENTOR_SETTLING, playerId: pair.mentorId });

  const age = ageOf(player.birthdate, state.date);
  if (age <= 21) factors.push({ code: "young", multiplier: 1.2, age });
  else if (age >= 30) factors.push({ code: "veteran", multiplier: 0.9, age });

  /**
   * 사람됨도 한 항이다 — 라커룸 리더는 첫 주에 이름을 부르고 다니고, 불안한 유망주는
   * 몇 달을 겉돈다 (people.md §6). **배수가 1인 원형에는 서지 않는다** — 아무것도
   * 곱하지 않는 줄은 이유가 아니다.
   */
  const archetype = playerArchetypeOf(state.seed, player);
  const multiplier = archetypeTraitsOf(state.seed, player).settling;
  if (multiplier !== 1) factors.push({ code: "archetype", multiplier, archetype });

  /**
   * **리더가 선 라커룸은 새 사람을 더 빨리 받아들인다** (people.md §5-1). 본인은
   * 빼고 센다 — "라커룸에 리더가 서 있다"는 다른 사람들에 대한 말이다.
   */
  const leaders = leaderSettlingRelief(state, state.userTeamId, player.id);
  if (leaders) {
    factors.push({
      code: "leaders",
      multiplier: leaders.multiplier,
      leadership: leaders.leadership,
    });
  }

  return factors;
}

/**
 * 배수 한 줄의 **문장** — 코드와 수치를 읽어 여기서만 짓는다.
 * 이름을 잃은 선수(이미 떠났다)는 그 줄을 내지 않는다.
 */
export function settlingFactorText(state: GameState, factor: SettlingFactor): string | null {
  switch (factor.code) {
    case "abroad":
      return factor.from ? `${factor.from}에서 건너왔다` : null;
    case "compatriot": {
      const mate = factor.playerId ? playerById(state, factor.playerId) : null;
      return mate ? `라커룸에 ${mate.name}이(가) 있다` : null;
    }
    case "mentor": {
      const mentor = factor.playerId ? playerById(state, factor.playerId) : null;
      return mentor ? `${mentor.name}이(가) 멘토로 붙어 있다` : null;
    }
    case "young":
      return factor.age === undefined ? null : `${factor.age}세 — 처음 겪는 무대다`;
    case "veteran":
      return factor.age === undefined ? null : `${factor.age}세 — 여러 팀을 겪어 봤다`;
    /** 원형은 **이름**만 낸다 — 그 사람이 왜 빨리 녹아드는지는 인물 카드가 이미 안다 */
    case "archetype":
      return factor.archetype === undefined ? null : PLAYER_ARCHETYPE_LABEL[factor.archetype];
    case "leaders":
      return factor.leadership === undefined
        ? null
        : `라커룸에 리더가 서 있다 (리더십 ${factor.leadership})`;
  }
}

/**
 * 지금 이 선수의 적응 상태 — 적응 대상이 아니면 null
 * (원소속 선수 · 유스 콜업 · 타 팀 선수).
 */
export function settlingOf(state: GameState, playerId: string): Settling | null {
  const player = playerById(state, playerId);
  if (!player || player.teamId !== state.userTeamId) return null;
  const joinedOn = joinedUserTeamOn(state, playerId);
  if (joinedOn === null) return null;

  const days = Math.max(0, diffDays(joinedOn, state.date));
  const matches = matchesSince(state, playerId, joinedOn);
  const trainings = trainingsSince(state, playerId, joinedOn);
  // 이번 소속 기간의 이벤트만 — 예전에 우리 팀에 있던 시절의 면담은 남의 이야기다
  const eventCredit = state.settlingEvents
    .filter((e) => e.gamePlayerId === playerId && e.date >= joinedOn)
    .reduce((sum, e) => sum + e.credit, 0);
  const credit = Math.max(
    0,
    matches * MATCH_CREDIT + trainings * TRAINING_CREDIT + days * DAY_CREDIT + eventCredit,
  );

  const from = state.transfers
    .filter((t) => t.gamePlayerId === playerId && t.date === joinedOn)
    .map((t) => t.fromTeamId)
    .find((id): id is string => id !== null);
  const factors = loadFactors(state, player, from ?? null);
  const target = SETTLING_TARGET * factors.reduce((mult, f) => mult * f.multiplier, 1);

  const progress = Math.min(1, credit / target);
  return {
    joinedOn,
    progress,
    credit,
    target,
    matches,
    trainings,
    days,
    eventCredit,
    factors,
    done: progress >= 1,
  };
}

/** 이 종류의 앵커 — outcome·강도로 코어가 계산하는 기본 무게 */
export function settlingAnchor(
  kind: SettlingEvent["kind"],
  { direction = 1, intensity = 2 }: { direction?: 1 | -1; intensity?: number } = {},
): number {
  return EVENT_CREDIT[kind] * direction * (intensity / 2);
}

/** 앵커에서 GM이 벗어날 수 있는 한계로 자른다 */
export function clampSettlingCredit(
  kind: SettlingEvent["kind"],
  anchor: number,
  proposed: number,
): number {
  const band = EVENT_BAND[kind];
  return Math.max(anchor - band, Math.min(anchor + band, proposed));
}

/**
 * 감독이 한 일을 정착 원장에 남긴다 — 실제로 쌓인 크레딧을 돌려준다(0이면 무시됐다).
 *
 * 정착이 끝난 선수·정착 대상이 아닌 선수에겐 아무것도 하지 않고,
 * **하루에 한 번**만 쌓인다(주장 지명은 소속 기간에 한 번). 말을 반복하는 것이
 * 최적 전략이 되면 감독은 면담 버튼을 연타하게 된다.
 *
 * `proposed`는 **GM이 매긴 무게**다 — 앵커에서 `EVENT_BAND`만큼만 벗어날 수 있다.
 */
export function creditSettling(
  state: GameState,
  playerId: string,
  kind: SettlingEvent["kind"],
  input: { anchor?: number; proposed?: number; note?: string } = {},
): number {
  const settling = settlingOf(state, playerId);
  if (!settling || settling.done) return 0;

  const joinedOn = settling.joinedOn;
  const repeated = state.settlingEvents.some(
    (e) =>
      e.gamePlayerId === playerId &&
      e.kind === kind &&
      e.date >= joinedOn &&
      (kind === "captain" || e.date === state.date),
  );
  if (repeated) return 0;

  const anchor = input.anchor ?? settlingAnchor(kind);
  const credit =
    input.proposed === undefined ? anchor : clampSettlingCredit(kind, anchor, input.proposed);
  if (credit === 0) return 0;
  state.settlingEvents.push({
    gamePlayerId: playerId,
    date: state.date,
    kind,
    credit,
    ...(input.note === undefined ? {} : { note: input.note }),
  });
  return credit;
}

/** 아직 적응 중인가 */
export function isSettling(state: GameState, playerId: string): boolean {
  const a = settlingOf(state, playerId);
  return a !== null && !a.done;
}

/** 적응 진행도(0~100 정수) — 적응 대상이 아니거나 끝났으면 null */
export function settlingPercent(state: GameState, playerId: string): number | null {
  const a = settlingOf(state, playerId);
  if (!a || a.done) return null;
  return Math.round(a.progress * 100);
}

/**
 * 적응 상태 한 줄 — **남은 일수를 약속하지 않는다.**
 * 얼마나 걸릴지는 감독이 앞으로 무엇을 하느냐에 달렸으므로, 지금까지 무엇이
 * 쌓였는지만 말한다.
 */
export function settlingNote(state: GameState, playerId: string): string | null {
  const a = settlingOf(state, playerId);
  if (!a || a.done) return null;
  const done: string[] = [];
  if (a.matches > 0) done.push(`${a.matches}경기 출전`);
  if (a.trainings > 0) done.push(`팀 훈련 ${a.trainings}일`);
  if (a.eventCredit !== 0) done.push(a.eventCredit > 0 ? "감독의 대화" : "감독과의 마찰");
  const from = state.transfers.find(
    (t) => t.gamePlayerId === playerId && t.date === a.joinedOn && t.fromTeamId !== null,
  );
  const origin = from?.fromTeamId ? `${teamNameIn(state, from.fromTeamId)}에서 온 뒤 ` : "";
  const load = a.factors
    .map((f) => settlingFactorText(state, f))
    .filter((t): t is string => t !== null)
    .join(" · ");
  return (
    `적응 ${Math.round(a.progress * 100)}% — ${origin}${done.length > 0 ? done.join(" · ") : "아직 경기도 훈련도 없다"}` +
    (load ? ` (${load})` : "")
  );
}
