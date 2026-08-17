import type { MatchRecord } from "@story-fm/domain";
import { addDays, dayOfWeek, tooClose } from "./calendar";
import { competitionShortName, isCup } from "../data/cup-catalog";
import { isTopLeague } from "../data/league-catalog";
import { reservedEuroDatesFor } from "./euro-knockout";
import { inCompetition } from "./friendly";
import { teamName, type GameState } from "../core/state";

/**
 * 일정 재편성 — **컵이 리그를 밀어낸다.**
 *
 * 처음엔 컵이 리그·대항전이 채운 달력의 틈으로만 들어갔다. 그러면 컵이 제 날짜를
 * 잃는다: FA컵 8강이 일요일에서 화요일로 밀리고, 결승이 리그 최종전 옆에 붙었다.
 * 실제 리그는 정반대로 움직인다 — **컵에 진출한 팀의 리그 경기를 연기**하고
 * 나중 주중으로 옮긴다("FA컵 진출로 인한 연기").
 *
 * 그래서 순서를 뒤집었다. 컵은 실제 대회 날짜를 우선 차지하고, 그 자리에 걸린
 * **리그 경기가 비켜준다**. 대항전·다른 컵 경기는 못 옮긴다 — 그쪽 날짜는 UEFA·협회가
 * 정한 계약이다. 리그 최종 라운드도 못 옮긴다 (전 경기 동시 킥오프가 규칙이다).
 */

/** 연기된 경기가 앉는 자리 — 실제 재편성도 주중(화·수)이 기본이다 */
const REARRANGED_WEEKDAYS = new Set([2, 3]);

/** 연기 대상 날짜를 찾는 창 */
const REARRANGE_SEARCH_DAYS = 80;

/**
 * 이 팀이 뛸 수 없는 날 — 이미 잡힌 경기 + (대항전 참가팀이면) 예약된 대항전 날짜.
 *
 * 대항전 녹아웃은 아직 편성되지 않았어도 **날짜가 이미 정해져 있다**
 * (`reservedEuroDatesFor`). 그 자리를 비워 두지 않으면 나중에 편성된 대항전 경기가
 * 컵 경기와 같은 날 겹친다 — 한 팀이 하루에 두 경기를 뛰게 된다.
 *
 * ⚠️ **그 팀에게 아직 유효한 예약만** 본다. 시즌 전체의 예약일을 대항전에 나갔던
 * 모든 팀에게 걸면 4~5월 주중이 통째로 잠겨, 연기할 자리가 없어진다.
 */
export function teamBusyDates(state: GameState, teamId: string): Set<string> {
  const dates = new Set<string>();
  for (const m of state.matches) {
    if (m.season !== state.season) continue;
    if (m.homeTeamId === teamId || m.awayTeamId === teamId) dates.add(m.date);
  }
  for (const d of reservedEuroDatesFor(state, teamId)) dates.add(d);
  return dates;
}

/** 이 대회의 마지막 라운드 번호 — 최종 라운드는 동시 킥오프라 옮기지 않는다 */
function lastRoundOf(state: GameState, competitionId: string): number {
  let max = 0;
  for (const m of state.matches) {
    if (m.season === state.season && m.competitionId === competitionId && m.round > max) {
      max = m.round;
    }
  }
  return max;
}

/**
 * 이 리그의 마지막 경기일 — 연기는 여기를 넘지 못한다.
 * 최종 라운드 뒤에 리그 경기가 남으면 "동시 킥오프로 시즌이 끝난다"는 규칙이
 * 무너지고, 우승·강등이 다 정해진 뒤에 순위가 다시 바뀐다.
 */
function seasonDeadline(state: GameState, competitionId: string): string {
  let last = "";
  for (const m of state.matches) {
    if (m.season === state.season && m.competitionId === competitionId && m.date > last) {
      last = m.date;
    }
  }
  return last;
}

/**
 * 이 경기를 연기할 수 있는가 — **옮길 수 있는 경기는 반드시 대회 경기다**.
 * 그 사실을 반환 타입에 실어, 대회 id가 필요한 뒷단계가 널을 만나지 않는다.
 */
export function isPostponable(
  state: GameState,
  match: MatchRecord,
): match is MatchRecord & { competitionId: string } {
  if (match.result) return false; // 이미 치른 경기
  if (match.date <= state.date) return false; // 오늘·과거는 못 옮긴다
  // 친선은 연기 대상이 아니다 — 비켜줄 컵이 없고, 프리시즌의 그 날짜가 곧 그 경기다
  if (!inCompetition(match)) return false;
  if (isCup(match.competitionId)) return false; // 컵·대항전 날짜는 계약이다
  if (!isTopLeague(match.competitionId)) return false;
  return match.round < lastRoundOf(state, match.competitionId);
}

/** 일정 축의 엔트리도 따라 옮긴다 (감독 달력에 오른 우리 경기) */
function moveScheduleEntry(state: GameState, match: MatchRecord): void {
  const entry = state.schedule.find((e) => e.type === "match" && e.refId === match.id);
  if (!entry) return;
  entry.date = match.date;
  entry.time = match.time ?? entry.time;
}

/** 재편성 경기의 킥오프 — 주중 야간 */
const REARRANGED_KICKOFF = "19:45";

/**
 * 리그 경기 하나를 뒤로 연기한다 — 양 팀 모두 **48시간 휴식이 나오는** 주중으로.
 * 자리를 못 찾으면 아무것도 하지 않고 false (그 경우 컵이 대신 비켜준다).
 *
 * @param avoid 아직 장부에 없는 자리 — 컵이 차지하려고 리그를 비켜세우는 중이면
 *   그 컵의 슬롯을 넘겨야 한다. 안 넘기면 밀어낸 리그 경기가 **컵이 앉으려던 날로**
 *   옮겨 앉아 같은 팀이 하루에 두 경기를 갖는다 (실제로 그랬다 — 화요일로 연기된
 *   리그 경기가 그 화요일의 리그컵 1라운드와 겹쳤다).
 */
export function postponeMatch(
  state: GameState,
  match: MatchRecord,
  avoid?: { date: string; time?: string },
): boolean {
  if (!isPostponable(state, match)) return false;
  // 이 경기를 뺀 상태에서 빈 날을 찾는다 — 자기 자신 때문에 막히면 안 된다
  const teams = new Set([match.homeTeamId, match.awayTeamId]);
  const played = state.matches.filter(
    (m) =>
      m !== match &&
      m.season === state.season &&
      (teams.has(m.homeTeamId) || teams.has(m.awayTeamId)),
  );
  // 예약된 대항전 날짜는 시각을 모르니 하루를 통째로 막는다
  const blocked = new Set<string>();
  for (const teamId of teams) {
    for (const d of reservedEuroDatesFor(state, teamId)) blocked.add(d);
  }
  const ok = (date: string) => {
    const slot = { date, time: REARRANGED_KICKOFF };
    if (avoid && tooClose(avoid, slot)) return false;
    return (
      !played.some((m) => tooClose(m, slot)) &&
      ![-1, 0, 1].some((o) => blocked.has(addDays(date, o)))
    );
  };
  const deadline = seasonDeadline(state, match.competitionId);

  for (let i = 1; i <= REARRANGE_SEARCH_DAYS; i++) {
    const date = addDays(match.date, i);
    if (date > deadline) return false; // 최종 라운드 뒤로는 못 민다
    if (!REARRANGED_WEEKDAYS.has(dayOfWeek(date))) continue;
    if (!ok(date)) continue;
    match.date = date;
    match.time = REARRANGED_KICKOFF;
    moveScheduleEntry(state, match);
    return true;
  }
  return false;
}

/**
 * 컵 경기를 이 날 치르기 위해 비켜줘야 할 리그 경기들 — 두 팀의 D−1·D·D+1.
 * 하나라도 못 옮기면(대항전·최종 라운드·이미 치름) 빈 배열이 아니라 `null`을
 * 돌려준다 — 부분만 옮기면 달력만 흔들고 컵은 여전히 못 들어간다.
 */
export function clashesToClear(
  state: GameState,
  teams: string[],
  date: string,
): MatchRecord[] | null {
  const window = new Set([addDays(date, -1), date, addDays(date, 1)]);
  const teamSet = new Set(teams);
  const clashes = state.matches.filter(
    (m) =>
      m.season === state.season &&
      window.has(m.date) &&
      (teamSet.has(m.homeTeamId) || teamSet.has(m.awayTeamId)),
  );
  if (clashes.some((m) => !isPostponable(state, m))) return null;
  return clashes;
}

/**
 * 컵을 위해 리그를 비켜세운다 — 성공하면 옮긴 경기 목록.
 *
 * 실패는 전부 되돌린다. 절반만 옮기면 컵은 여전히 들어가지 못하는데 리그만
 * 흐트러진 최악의 상태가 된다.
 */
export function clearForCup(
  state: GameState,
  teams: string[],
  date: string,
  digest: string[],
  time?: string,
): boolean {
  const clashes = clashesToClear(state, teams, date);
  if (clashes === null) return false;
  if (clashes.length === 0) return true;

  const undo = clashes.map((m) => ({ match: m, date: m.date, time: m.time }));
  for (const m of clashes) {
    // 컵이 앉으려는 자리를 알려 준다 — 모르면 그 자리로 옮겨 앉는다
    if (postponeMatch(state, m, { date, time })) continue;
    // 하나라도 자리를 못 찾으면 전부 원위치 — 컵이 대신 비켜준다
    for (const u of undo) {
      u.match.date = u.date;
      u.match.time = u.time;
      moveScheduleEntry(state, u.match);
    }
    return false;
  }

  for (const m of clashes) {
    if (m.homeTeamId !== state.userTeamId && m.awayTeamId !== state.userTeamId) continue;
    const opponent = m.homeTeamId === state.userTeamId ? m.awayTeamId : m.homeTeamId;
    digest.push(
      `🗓️ ${competitionShortName(m.competitionId)} ${m.round}R vs ${teamName(opponent)} 경기가 ${m.date}로 연기됐다 — 컵 일정과 겹쳤다`,
    );
  }
  return true;
}
