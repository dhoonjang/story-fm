import type { GamePlayer, ManagerPromise, PromiseKind, SquadStatus } from "@story-fm/domain";
import {
  PROMISE_KIND_KO,
  SQUAD_STATUS_KO,
  ageOf,
  diffDays,
  isReserveMatch,
  promiseKept,
  startShortfall,
} from "@story-fm/domain";
import { isFriendly } from "../competition/friendly";
import { addDays } from "../core/dates";
import {
  activeContract,
  clampReputation,
  isSuspended,
  openInjury,
  playerById,
  playersOf,
  pushNarrative,
  squadLevelOf,
  type GameState,
} from "../core/state";
import { SQUAD_CORE_SIZE } from "../club/press";
import { clampForm, moraleToForm } from "./form";
import { betterAtPosition } from "./depth";

/**
 * **감독의 약속 — 갈래·기한·상태뿐인 장부** (→ docs/data/people.md §5-2).
 *
 * 이 게임의 인터페이스는 말이고 잘한 말은 잘 먹혀야 한다. 그런데 말이 공짜면 가장
 * 잘 먹히는 말이 가장 값싼 말이 된다 — 불만 선수를 면담 한 번의 "다음 경기 선발이다"로
 * 잠재우고 잊는 것이 최적 전략이 되고, "방치의 대가는 시간의 결과"라는 규약이
 * 약속 앞에서만 빈다.
 *
 * ⚠️ **여기 어디에도 문장이 없다.** 무슨 말로 약속했는지는 장면의 것이고, 이행
 * 판정은 전부 다른 장부에서 나온다 — 출전 명단 · 이적 리스트 · 열린 협상 · 완장.
 */

/** 지위·약속을 재는 창 — 여덟 경기는 한 시즌의 다섯 번째쯤이고 두 달 남짓이다 */
export const PROMISE_WINDOW_MATCHES = 8;

/**
 * 판정에 필요한 **최소 경기 수** — 창 안에서 그가 설 수 있었던 경기가 이보다 적으면
 * 비율이 표본이 아니다. 세울 경기가 없었던 것은 감독이 어긴 것이 아니다.
 */
export const PROMISE_MIN_MATCHES = 3;

/** 갈래별 기본 기한(일) — `transfer`만 날짜가 아니라 다음 창 마감이 정한다 */
const PROMISE_DEFAULT_DAYS: Record<PromiseKind, number> = {
  minutes: 56,
  transfer: 180,
  renewal: 30,
  captain: 90,
};

/** 감독이 기한을 좁힐 수 있는 폭 */
export const PROMISE_DAYS_MIN = 7;
export const PROMISE_DAYS_MAX = 365;

/**
 * 지킨 값과 어긴 값 — **한 표다** (people.md §5-2).
 *
 * 어긴 쪽이 큰 것은 규약이다: 지킨 약속은 감독이 **당연히 할 일**을 한 것이고, 어긴
 * 약속은 하지 않은 일이다. 값이 같으면 남발하고 절반만 지키는 것이 아무것도
 * 약속하지 않는 것보다 이득이 된다. 평판이 함께 움직이는 것은 약속이 **라커룸 전체가
 * 보는 일**이기 때문이다 — 한 사람에게 한 말이 지켜지는지를 나머지가 센다.
 */
export const PROMISE = {
  keptMorale: 6,
  keptSquad: 2,
  brokenMorale: -8,
  brokenSquad: -4,
} as const;

/** `key`로 서려면 스쿼드 안에서 이 순위 안에 들어야 한다 */
const KEY_SQUAD_RANK = 5;

/** 유망주로 보는 나이 — 만 21세 이하 (등록 명단이 가르는 자와 같은 눈금) */
const PROSPECT_AGE = 21;

/**
 * 계약에 지위가 없을 때 **지금 서열에서 파생하는 지위** (people.md §5-2).
 *
 * 파생은 **지금 실제로 서는 순서**라, 지위를 적지 않은 옛 세이브가 로드되며 없던
 * 불만을 만들어 내지 않는다 — 자기 자리에 맞는 지위를 받으므로 기대와 실제가
 * 처음부터 맞는다.
 */
export function derivedSquadStatus(
  state: GameState,
  player: GamePlayer,
  /**
   * 어느 스쿼드의 서열로 재는가 — 기본은 그의 소속이다. **영입은 우리 스쿼드로
   * 잰다**: 파는 구단에서의 자리는 우리가 제시하는 지위와 견줄 값이 아니다
   * (transfer.md §3).
   */
  teamId: string = player.teamId,
): SquadStatus {
  const better = playersOf(state, teamId).filter(
    (p) => p.id !== player.id && p.attributes.overall > player.attributes.overall,
  ).length;
  const young = ageOf(player.birthdate, state.date) <= PROSPECT_AGE;
  /**
   * **스쿼드의 핵심 밖이면 자리 깊이를 보지 않는다** — 등재·계약 불만이 쓰는 것과
   * 같은 자다(`SQUAD_CORE_SIZE` — people.md §5).
   *
   * 자리 깊이만 보면 서른 명짜리 1군이 열두어 자리로 나뉘어 **자리마다 둘째까지**
   * 로테이션이 되고, 여덟 경기에 여든여덟 자리뿐인 판에 감당할 수 없는 기대가
   * 스물여섯 개 선다. 백업 정리가 조용한 이유와 같은 이유로 여기서 끊는다.
   *
   * ⚠️ **계약에 적힌 지위에는 걸리지 않는다** — 서열 밖의 선수에게 감독이 자리를
   * 약속했다면 그것은 약속이지 파생이 아니다 (people.md §5-2).
   */
  if (better >= SQUAD_CORE_SIZE) return young ? "prospect" : "backup";
  const blocked = betterAtPosition(state, teamId, player);
  if (blocked === 0) return better < KEY_SQUAD_RANK ? "key" : "starter";
  if (blocked === 1) return "rotation";
  return young ? "prospect" : "backup";
}

/** 그가 **어떤 자리로 있는가** — 계약에 적힌 지위, 없으면 파생 */
export function squadStatusOf(state: GameState, player: GamePlayer): SquadStatus {
  return activeContract(state, player.id)?.squadStatus ?? derivedSquadStatus(state, player);
}

/** 그날 부상으로 빠져 있었나 — 원장의 기간으로 판정한다 (미복귀는 `returnedOn`이 없다) */
function injuredOn(state: GameState, playerId: string, date: string): boolean {
  return state.injuries.some(
    (i) =>
      i.gamePlayerId === playerId &&
      i.occurredOn <= date &&
      (i.returnedOn === null || i.returnedOn > date),
  );
}

/** 이 경기가 그 창에 드는가 — 우리 1군의 공식 경기만 (친선·2군은 출전 기회가 아니다) */
function countsForMinutes(state: GameState, match: (typeof state.matches)[number]): boolean {
  if (!match.result) return false;
  if (isReserveMatch(match)) return false;
  if (isFriendly(match)) return false;
  return match.homeTeamId === state.userTeamId || match.awayTeamId === state.userTeamId;
}

/** 그 경기에 선발로 섰는가 — 선발 칸이 없는 옛 장부는 「뛴 사람 전부」로 떨어진다 */
function startedIn(
  state: GameState,
  match: (typeof state.matches)[number],
  playerId: string,
): boolean {
  const result = match.result;
  if (!result) return false;
  const home = match.homeTeamId === state.userTeamId;
  const starters = home ? result.homeStarters : result.awayStarters;
  const list = starters ?? (home ? result.homeLineup : result.awayLineup) ?? [];
  return list.includes(playerId);
}

/**
 * 우리 공식 경기를 **최근 순으로** — 창을 여러 번 재는 호출이 원장을 한 번만 훑게
 * 하는 색인이다.
 *
 * `minutesShortfalls`는 월요일마다 1군 전원에게 창을 묻는다. 호출마다 원장을
 * 훑으면 멀티시즌 세이브의 한 주가 「선수 수 × 전체 경기 수」가 된다 — 스쿼드 깊이
 * 색인(`squadDepthOf`)이 있는 이유와 같은 자리다. **읽기 전용 파생**이라 원장이
 * 그대로인 동안만 유효하다: 한 번의 순회 안에서 세우고 버린다.
 */
export function matchWindowOf(state: GameState): (typeof state.matches)[number][] {
  return state.matches
    .filter((m) => countsForMinutes(state, m) && m.date <= state.date)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export interface StartRead {
  /** 그가 설 수 있었던 경기 수 — 부상으로 빠져 있던 날은 빠진다 */
  played: number;
  starts: number;
  /** `played`가 0이면 1로 읽는다 — 나눌 것이 없는 자리에서 비율은 뜻이 없다 */
  share: number;
}

/**
 * 창 안의 **선발 비율** — `from`이 있으면 그날 이후, 없으면 최근
 * `PROMISE_WINDOW_MATCHES`경기다.
 *
 * ⚠️ **분모는 그가 설 수 있었던 경기다** (people.md §5). 부상으로 빠져 있던 경기까지
 * 세면 복귀 첫 주에 불만이 선다 — 못 나온 것이 감독의 결정이 아닌 경기다.
 */
export function startsInWindow(
  state: GameState,
  player: GamePlayer,
  window: {
    from?: string;
    matches?: number;
    /** 미리 세운 최근 순 경기 색인 (`matchWindowOf`) — 없으면 그 자리에서 세운다 */
    pool?: readonly (typeof state.matches)[number][];
  } = {},
): StartRead {
  const limit = window.matches ?? PROMISE_WINDOW_MATCHES;
  const ours = (window.pool ?? matchWindowOf(state))
    .filter((m) => window.from === undefined || m.date >= window.from)
    .slice(0, limit);
  let played = 0;
  let starts = 0;
  for (const match of ours) {
    if (injuredOn(state, player.id, match.date)) continue;
    played += 1;
    if (startedIn(state, match, player.id)) starts += 1;
  }
  return { played, starts, share: played > 0 ? starts / played : 1 };
}

// ── 약속을 연다 ────────────────────────────────────────────────

/** 열려 있는 약속 — 판정 전인 것만 */
export function openPromises(state: GameState, playerId?: string): ManagerPromise[] {
  return (state.promises ?? []).filter(
    (p) => p.status === "open" && (playerId === undefined || p.gamePlayerId === playerId),
  );
}

/** 이 갈래의 기한 — `transfer`만 다음 이적창 마감을 본다 */
function dueDateOf(state: GameState, kind: PromiseKind, days?: number): string {
  if (days !== undefined) {
    const bounded = Math.max(PROMISE_DAYS_MIN, Math.min(PROMISE_DAYS_MAX, Math.round(days)));
    return addDays(state.date, bounded);
  }
  if (kind === "transfer") {
    const next = state.windows
      .filter((w) => w.leagueId === undefined && w.closesOn > state.date)
      .map((w) => w.closesOn)
      .sort()[0];
    if (next) return next;
  }
  return addDays(state.date, PROMISE_DEFAULT_DAYS[kind]);
}

/**
 * 이 약속을 지금 이 선수에게 할 수 있는가 — **지킬 것이 없는 약속은 장부에 서지
 * 않는다** (people.md §5-2). 막혔으면 감독에게 돌려줄 이유를 낸다.
 */
function promiseBlock(state: GameState, player: GamePlayer, kind: PromiseKind): string | null {
  if (player.teamId !== state.userTeamId || player.loan) {
    return `${player.name}은(는) 지금 우리가 쓰는 선수가 아닙니다`;
  }
  if (openPromises(state, player.id).some((p) => p.kind === kind)) {
    return `${player.name}에게 한 ${PROMISE_KIND_KO[kind]} 약속이 아직 기한 전입니다`;
  }
  switch (kind) {
    case "captain":
      return player.isCaptain ? `${player.name}은(는) 이미 주장입니다` : null;
    case "transfer":
      return state.transferList.some((l) => l.gamePlayerId === player.id)
        ? `${player.name}은(는) 이미 이적 리스트에 있습니다`
        : null;
    case "renewal": {
      if (!activeContract(state, player.id)) {
        return `${player.name}에게 열 계약이 없습니다`;
      }
      return state.negotiations.some(
        (n) => n.kind === "renew" && n.gamePlayerId === player.id && n.status === "open",
      )
        ? `${player.name}의 재계약 협상은 이미 열려 있습니다`
        : null;
    }
    case "minutes":
      return null;
  }
}

export interface PromiseOpened {
  ok: boolean;
  /** 열렸으면 장부에 선 줄 */
  promise?: ManagerPromise;
  /** 막혔으면 그 이유 한 줄 — 감독이 읽는다 */
  message?: string;
}

/**
 * 약속 하나를 장부에 세운다 — **같은 선수·같은 갈래는 하나다.**
 *
 * 열려 있는 동안 같은 약속을 다시 하면 반려된다. 기한이 매번 밀리면 약속이 다시
 * 공짜가 되기 때문이다. ⚠️ **반려는 그 대화를 무르지 않는다** — 면담의 사기·정착
 * 효과는 부르는 쪽이 이미 셈했고, 여기서 도는 것은 장부뿐이다.
 */
export function openPromise(
  state: GameState,
  playerId: string,
  kind: PromiseKind,
  days?: number,
): PromiseOpened {
  const player = playerById(state, playerId);
  if (!player) return { ok: false, message: "그런 선수가 없습니다" };
  const blocked = promiseBlock(state, player, kind);
  if (blocked) return { ok: false, message: blocked };
  const dueOn = dueDateOf(state, kind, days);
  const promise: ManagerPromise = {
    id: `pr-${kind}-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    kind,
    madeOn: state.date,
    dueOn,
    status: "open",
  };
  (state.promises ??= []).push(promise);
  pushNarrative(state, `${player.name}에게 ${PROMISE_KIND_KO[kind]} 약속 (${dueOn}까지)`, 3);
  return { ok: true, promise };
}

// ── 기한이 되면 장부가 판정한다 ────────────────────────────────

/** 그 약속을 지켰는가 — **전부 다른 장부에서 나온다.** 문장은 어디서도 읽지 않는다 */
function verdictOf(state: GameState, promise: ManagerPromise, player: GamePlayer): boolean {
  switch (promise.kind) {
    case "minutes": {
      const read = startsInWindow(state, player, { from: promise.madeOn });
      // 세울 경기가 없었던 것은 감독이 어긴 것이 아니다
      if (read.played < PROMISE_MIN_MATCHES) return true;
      return promiseKept(read.share, "starter");
    }
    case "transfer": {
      if (state.transferList.some((l) => l.gamePlayerId === player.id)) return true;
      return state.transfers.some(
        (t) =>
          t.gamePlayerId === player.id &&
          t.fromTeamId === state.userTeamId &&
          t.date >= promise.madeOn,
      );
    }
    case "renewal":
      return state.negotiations.some(
        (n) => n.kind === "renew" && n.gamePlayerId === player.id && n.openedOn >= promise.madeOn,
      );
    case "captain":
      return player.isCaptain === true;
  }
}

/**
 * 기한이 된 약속을 판정한다 — **tick이 매일 부른다.**
 *
 * 판정은 기한 **하루**뿐이다. 지난 약속은 `kept`·`broken`으로 남아 이력이 되고,
 * 같은 선수에게 다시 약속할 수 있는 것은 그때부터다.
 */
export function tickPromises(state: GameState, digest: string[]): void {
  const due = openPromises(state).filter((p) => p.dueOn <= state.date);
  if (due.length === 0) return;
  for (const promise of due) {
    const player = playerById(state, promise.gamePlayerId);
    if (!player || player.teamId !== state.userTeamId) {
      // 세계에서 사라진 상대의 약속은 판정하지 않고 걷는다 — 지킬 자리가 없다
      state.promises = (state.promises ?? []).filter((p) => p.id !== promise.id);
      continue;
    }
    const kept = verdictOf(state, promise, player);
    promise.status = kept ? "kept" : "broken";
    const morale = kept ? PROMISE.keptMorale : PROMISE.brokenMorale;
    player.state.form = clampForm(player.state.form + moraleToForm(morale));
    state.manager.reputation.squad = clampReputation(
      state.manager.reputation.squad + (kept ? PROMISE.keptSquad : PROMISE.brokenSquad),
    );
    const label = PROMISE_KIND_KO[promise.kind];
    if (kept) {
      digest.push(`${player.name} ${label} 약속을 지켰다 — 사기 +${PROMISE.keptMorale}`);
      pushNarrative(state, `${player.name} ${label} 약속 이행`, 3);
      continue;
    }
    /**
     * 어긴 약속은 **다른 사유와 같은 사다리를 탄다** (people.md §5·§8). 이미 불만이
     * 걸린 선수에게 한 줄을 더 얹지는 않는다 — 화면의 ⚠불만 줄이 같은 사람으로 찬다.
     */
    if (!state.issues.some((i) => i.gamePlayerId === player.id)) {
      state.issues.push({
        gamePlayerId: player.id,
        kind: "unhappy",
        reason: "promise",
        since: state.date,
      });
    }
    digest.push(
      `${player.name} ${label} 약속을 어겼다 — ${diffDays(promise.madeOn, state.date)}일 전의 약속`,
    );
    pushNarrative(state, `${player.name} ${label} 약속 파기`, 4);
  }
}

// ── 지위 대비 출전 — 불만이 서는 자리 ──────────────────────────

export interface MinutesShortfall {
  player: GamePlayer;
  status: SquadStatus;
  starts: number;
  played: number;
  /** 그 지위에 모자란 선발 수 — `PlayerIssue.count`가 든다 */
  short: number;
}

/**
 * 오늘 **출전 불만이 서는 선수들** — 주사위가 없다 (people.md §5).
 *
 * 지위가 부르는 선발 비율(`SQUAD_STATUS_STARTS`)에 최근 창이 못 미치면 걸린다.
 * 백업·유망주의 기대는 0이라 그 자리로 온 선수는 벤치에 앉아도 불만을 내지 않는다 —
 * 그가 어떤 자리로 왔는지가 계약에 적혀 있기 때문이다.
 */
export function minutesShortfalls(state: GameState): MinutesShortfall[] {
  const rows: MinutesShortfall[] = [];
  // 원장은 한 번만 훑는다 — 아래 루프가 1군 전원에게 같은 창을 묻는다
  const pool = matchWindowOf(state);
  for (const player of playersOf(state, state.userTeamId)) {
    if (squadLevelOf(player) !== "first") continue;
    if (player.loan) continue;
    // 뛸 수 없는 사람이 출전 기회를 따지지 않는다
    if (openInjury(state, player.id) || isSuspended(state, player.id)) continue;
    if (state.issues.some((i) => i.gamePlayerId === player.id)) continue;
    const status = squadStatusOf(state, player);
    const read = startsInWindow(state, player, { pool });
    // 창이 차기 전에는 비율이 표본이 아니다
    if (read.played < PROMISE_WINDOW_MATCHES) continue;
    if (promiseKept(read.share, status)) continue;
    rows.push({
      player,
      status,
      starts: read.starts,
      played: read.played,
      short: Math.max(1, startShortfall(read.starts, read.played, status)),
    });
  }
  return rows;
}

/** 불만 줄에 적히는 한 조각 — 지위와 실제 선발 수 */
export function shortfallText(row: MinutesShortfall): string {
  return `${row.player.name} 출전 기회 불만 — ${SQUAD_STATUS_KO[row.status]} 지위, 최근 ${row.played}경기 중 선발 ${row.starts}회`;
}
