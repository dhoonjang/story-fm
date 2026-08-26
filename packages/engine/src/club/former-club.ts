/**
 * 옛 구단 — **대진이 갖고 있는 사실이다** (people.md §4).
 *
 * 더비와 같은 결이다: 새 상태를 세우지 않고 **장부에서 파생한다.** 감독의 옛 구단은
 * 경질 이력(`state.dismissals` — 경질·계약 만료·사임이 전부 그 한 장을 지난다,
 * career.md §5.1)과 재임 시즌 수(`seasonRecords`)이고, 선수의 옛 구단은 이적 원장
 * (`state.transfers`)이다.
 *
 * 저장하지 않는 이유도 더비 전적과 같다: 저장한 사실은 원장을 고치는 자리(어드민·
 * 이적 취소)를 따라오지 못하고, 그때부터 회견이 커리어 화면과 다른 말을 한다.
 */

import type { Dismissal, GamePlayer, MatchRecord, PressFact } from "@story-fm/domain";
import { isReserveMatch, parseScorerEntry } from "@story-fm/domain";
import type { GameState } from "../core/state";
import { playerById, teamNameIn } from "../core/state";
import { diffDays } from "../core/dates";
import { isFriendly } from "../competition/friendly";

/**
 * 원장이 옛 구단을 사실로 드는 창 (년) — 그보다 오래된 이동은 그 라커룸에도 그
 * 벤치에도 같은 사람이 남아 있지 않다. 더비 전적이 세 시즌을 거슬러 세는 것
 * (`DERBY_RECORD_SEASONS`)과 같은 자다.
 */
export const FORMER_CLUB_YEARS = 3;

/** 그 창의 날 수 — 윤년은 세지 않는다. 하루가 갈려도 이 창의 뜻은 달라지지 않는다 */
const FORMER_CLUB_DAYS = FORMER_CLUB_YEARS * 365;

/**
 * 대진이 **이야기가 되는 창** (일) — 아크가 열리고 심경 카드가 서는 날.
 * 리그 한 라운드가 한 주이므로 두 라운드 앞에서 보이기 시작한다.
 */
export const RETURN_FIXTURE_DAYS = 14;

/**
 * 한 자리에 오르는 **선수** 카드의 상한 — 루머와 같은 규약이다 (people.md §4).
 * 셋을 실으면 그 회견이 이적 시장 브리핑이 된다. 감독 카드는 이 수에 들지 않는다:
 * 그것이 자리를 연 사실이다.
 */
const FORMER_CLUB_CARDS = 2;

/** 감독이 그 구단에 있었다 — 떠난 날의 갈래와 흐른 날, 재임 시즌 수 */
export interface ManagerReturn {
  teamId: string;
  kind: NonNullable<Dismissal["kind"]>;
  /** 떠난 뒤 흐른 날 */
  days: number;
  /** 그 구단에서 마친 시즌 수 — 한 시즌도 못 마쳤으면 0 */
  seasons: number;
}

/** 창 안의 이동인가 — 안이면 흐른 날, 밖이면 null. 미래의 줄은 세지 않는다 */
function within(state: GameState, date: string): number | null {
  const days = diffDays(date, state.date);
  return days >= 0 && days <= FORMER_CLUB_DAYS ? days : null;
}

/**
 * 옛 구단을 세는 경기인가 — **친선과 2군은 지나간다.** `derbyForMatch`와 같은 문이다
 * (season.md §2): 프리시즌 친선은 몸을 만드는 자리이고 2군 경기는 감독이 보지도 않는다.
 */
function counts(match: MatchRecord): boolean {
  return !isFriendly(match) && !isReserveMatch(match);
}

/** 이 경기의 상대 — 우리 경기가 아니면 null */
function opponentIn(state: GameState, match: MatchRecord): string | null {
  if (match.homeTeamId === state.userTeamId) return match.awayTeamId;
  if (match.awayTeamId === state.userTeamId) return match.homeTeamId;
  return null;
}

/**
 * 감독이 그 구단을 떠난 사실 — 창 밖이면 null.
 *
 * 경질장이 여럿이면 **가장 최근 것**이다: 두 번 몸담았던 구단이면 이번 이야기는
 * 마지막으로 떠난 그날의 것이다. 재임 시즌 수는 `seasonRecords`가 센다 — 잘린 시즌은
 * 그 표에 남지 않으므로(career.md §6) 여기 서는 것은 **마친 시즌**의 수다.
 */
export function managerReturnOf(state: GameState, teamId: string): ManagerReturn | null {
  let last: Dismissal | null = null;
  for (const card of state.dismissals ?? []) {
    if (card.teamId !== teamId) continue;
    if (!last || card.on > last.on) last = card;
  }
  if (!last) return null;
  const days = within(state, last.on);
  if (days === null) return null;
  return {
    teamId,
    // 갈래가 없는 옛 카드는 전부 경질이다 (`DismissalSchema.kind`)
    kind: last.kind ?? "sacked",
    days,
    seasons: state.seasonRecords.filter((r) => r.teamId === teamId).length,
  };
}

/** 창 안에 이 두 구단 사이를 오간 선수 하나 */
interface FormerMove {
  player: GamePlayer;
  /** 우리 선수의 친정 대결인가, 우리가 내보낸 선수가 그 셔츠로 서는가 */
  side: "player" | "rival-player";
  /** 어떻게 떠났나 — 원장의 사유 코드, 없으면 갈래 코드 */
  exit: string;
  days: number;
  fee: number;
}

/**
 * 두 구단 사이를 오간 선수들 — **큰 이적이 먼저다.**
 *
 * 한 선수는 한 번만 선다(가장 최근의 그 이동). 정렬이 결정적인 것은 상한
 * (`FORMER_CLUB_CARDS`)이 여기서 잘리기 때문이다 — 순서가 흔들리면 같은 세이브가
 * 두 번 다른 카드를 낸다.
 */
function formerMovesOf(state: GameState, opponentId: string): FormerMove[] {
  const moves: FormerMove[] = [];
  const seen = new Set<string>();
  const ledger = [...state.transfers].sort((a, b) =>
    a.date > b.date ? -1 : a.date < b.date ? 1 : a.id > b.id ? -1 : 1,
  );
  for (const row of ledger) {
    const days = within(state, row.date);
    if (days === null) continue;
    const player = playerById(state, row.gamePlayerId);
    if (!player) continue;
    /**
     * **지금 어느 셔츠를 입고 있는가까지가 사실이다.** 우리가 판 선수가 그 뒤 또
     * 팔려 갔으면 이 대진에 그는 없다 — 원장만 읽으면 그라운드에 없는 사람이
     * 회견 카드에 선다.
     */
    const ours = row.fromTeamId === opponentId && player.teamId === state.userTeamId;
    const theirs =
      row.fromTeamId === state.userTeamId &&
      row.toTeamId === opponentId &&
      player.teamId === opponentId;
    if (!ours && !theirs) continue;
    if (seen.has(player.id)) continue;
    seen.add(player.id);
    moves.push({
      player,
      side: ours ? "player" : "rival-player",
      exit: row.reason ?? row.type,
      days,
      fee: row.fee,
    });
  }
  return moves.sort(
    (a, b) => b.fee - a.fee || a.days - b.days || (a.player.id < b.player.id ? -1 : 1),
  );
}

/** 그 선수가 이 경기에 넣은 골 */
function goalsOf(match: MatchRecord, playerId: string): number {
  return (match.result?.scorers ?? []).filter((e) => parseScorerEntry(e).playerId === playerId)
    .length;
}

/**
 * 이 대진에 서는 옛 구단의 사실 카드 — 감독 하나와 선수 최대 둘 (people.md §4).
 *
 * @param seat 전야인가 경기 뒤인가 — 경기 뒤에만 **그가 넣은 골**이 서고, 그때
 *   카드가 날 선다. 전야에는 아직 아무 일도 일어나지 않았다.
 */
export function formerClubFactsOf(
  state: GameState,
  match: MatchRecord,
  seat: "eve" | "post",
): PressFact[] {
  if (!counts(match)) return [];
  const opponentId = opponentIn(state, match);
  if (opponentId === null) return [];

  const facts: PressFact[] = [];
  const back = managerReturnOf(state, opponentId);
  if (back) {
    facts.push({
      kind: "former-club",
      data: {
        refId: opponentId,
        name: teamNameIn(state, opponentId),
        tags: ["manager", back.kind],
        values: { days: back.days, ...(back.seasons > 0 ? { seasons: back.seasons } : {}) },
      },
      about: null,
      /**
       * 계약이 그냥 끝난 자리는 물어봐 줄 일이다 — 잘린 자리와 스스로 물고 나온
       * 자리만 감독이 답해야 하는 자리다.
       */
      sharp: back.kind !== "expired",
    });
  }
  for (const move of formerMovesOf(state, opponentId).slice(0, FORMER_CLUB_CARDS)) {
    const goals = seat === "post" ? goalsOf(match, move.player.id) : 0;
    facts.push({
      kind: "former-club",
      data: {
        refId: opponentId,
        name: move.player.name,
        tags: [move.side, move.exit],
        values: {
          days: move.days,
          ...(move.fee > 0 ? { fee: move.fee } : {}),
          ...(goals > 0 ? { goals } : {}),
        },
      },
      /**
       * ⚠️ **남의 라커룸 선수는 지목의 자리에 오르지 않는다** (people.md §4) —
       * 지목은 그 선수의 사기를 움직이는 자리인데, 우리 회견이 상대 선수를 감싸거나
       * 자를 수는 없다.
       */
      about: move.side === "player" ? move.player.id : null,
      sharp: goals > 0,
    });
  }
  return facts;
}

/**
 * **이번 시즌 그 구단과 처음 만나는 자리인가** (people.md §4).
 *
 * 이미 치른 대진이 있으면 전야의 자리는 서지 않고 카드만 얹힌다 — 한 시즌에 두 번
 * 만나는 리그에서 같은 복귀전을 두 번 열면 그 자리가 무게를 잃는다.
 * 원장은 시즌 전환에서 갈리므로(season.md §5) 이 물음은 이번 시즌 안의 것이다.
 */
export function isFirstMeeting(state: GameState, match: MatchRecord, opponentId: string): boolean {
  return !state.matches.some(
    (m) =>
      m.id !== match.id &&
      m.result !== null &&
      m.season === state.season &&
      counts(m) &&
      opponentIn(state, m) === opponentId,
  );
}

/** 창 안에 들어온 다음 대진 하나 */
export interface ReturnFixture {
  match: MatchRecord;
  teamId: string;
  /** 경기까지 남은 날 — 0이면 오늘이다 */
  days: number;
}

/**
 * `RETURN_FIXTURE_DAYS` 안의 아직 안 치른 우리 경기들 — 가까운 것이 앞이다.
 * 같은 날 둘이면 id가 가른다: 무엇이든 하나로 정해져야 판정이 결정적이다.
 */
export function upcomingFixtures(state: GameState): ReturnFixture[] {
  const rows: ReturnFixture[] = [];
  for (const match of state.matches) {
    if (match.result !== null || !counts(match)) continue;
    const teamId = opponentIn(state, match);
    if (teamId === null) continue;
    const days = diffDays(state.date, match.date);
    if (days < 0 || days > RETURN_FIXTURE_DAYS) continue;
    rows.push({ match, teamId, days });
  }
  return rows.sort((a, b) => a.days - b.days || (a.match.id < b.match.id ? -1 : 1));
}

/**
 * 감독의 옛 구단과의 **다음 대진** — 없으면 null. 아크가 이 자리를 읽는다 (§9).
 * 옛 구단이 둘인 감독이면 가장 가까운 대진 하나다.
 */
export function nextManagerReturn(state: GameState): ReturnFixture | null {
  return upcomingFixtures(state).find((row) => managerReturnOf(state, row.teamId) !== null) ?? null;
}

/**
 * 그 선수의 옛 소속 구단과의 **다음 대진** — 심경 카드가 읽는 자리 (people.md §5).
 *
 * 우리 선수에게만 선다: 스카우트가 보는 남의 선수에게 우리 대진의 D-일이 걸리면
 * 그 카드는 거짓말이다.
 */
export function playerReturnFixture(
  state: GameState,
  player: GamePlayer,
): { teamId: string; days: number } | null {
  if (player.teamId !== state.userTeamId) return null;
  /**
   * ⚠️ **원장을 먼저 읽는다.** 이 함수는 심경을 읽을 때마다 스쿼드 인원수만큼 불리는데,
   * 대부분의 선수에게는 이적 줄이 아예 없다 — 대진부터 훑으면 카드 한 장을 세우려고
   * 세계의 모든 경기를 마흔여섯 번 다시 훑는다.
   */
  const from = new Set<string>();
  for (const row of state.transfers) {
    if (row.gamePlayerId !== player.id || row.fromTeamId === null) continue;
    if (within(state, row.date) !== null) from.add(row.fromTeamId);
  }
  if (from.size === 0) return null;
  for (const row of upcomingFixtures(state)) {
    if (from.has(row.teamId)) return { teamId: row.teamId, days: row.days };
  }
  return null;
}
