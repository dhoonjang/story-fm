import type { MatchRecord } from "@story-fm/domain";
import { buildAllLeagueMatches, diffDays } from "./calendar";
import { leagueOfTeam } from "./data/team-catalog";
import { buildAllEuroMatches } from "./europe";

/**
 * 시즌 편성의 단일 입구 — 리그 + 대항전을 함께 만들고 충돌을 푼다.
 *
 * 두 일정을 따로 만들면 서로를 모른다. 리그 주중 라운드는 대항전 주를 비켜주지만
 * (calendar.ts `isEuroWeek`), **주말 라운드의 금·월 슬롯**은 여전히 대항전
 * 화요일·목요일과 하루 차이로 붙는다. 대항전에 나가는 팀에게 월→화, 목→금은
 * 실제 리그가 절대 내지 않는 일정이다. 그래서 편성 후 슬롯을 맞바꿔 푼다.
 */
export function buildSeasonFixtures(season: number, seed: number): MatchRecord[] {
  const league = buildAllLeagueMatches(season, seed);
  const euro = buildAllEuroMatches(season, seed);
  relaxEuroAdjacency(league, euro);
  return [...league, ...euro];
}

/**
 * 감독의 달력(SCHEDULE_ENTRY)에 오를 경기 — **우리 리그 전체 + 우리 팀 대항전**.
 *
 * 우리 리그는 순위표를 읽기 위해 전 경기가 필요하고, 대항전은 우리 팀 경기만
 * 감독의 일정이다 (남의 UCL 경기는 장부에만 남는다).
 */
export function isUserFixture(match: MatchRecord, userTeamId: string): boolean {
  return (
    match.competitionId === leagueOfTeam(userTeamId) ||
    match.homeTeamId === userTeamId ||
    match.awayTeamId === userTeamId
  );
}

/** 경기 사이 최소 간격 — 이틀(=하루 이상 휴식). 같은 날·연속 이틀이 충돌이다 */
const MIN_REST_DAYS = 2;

/**
 * 대항전과 붙은 리그 슬롯을 **같은 라운드 안에서 맞바꿔** 푼다.
 *
 * 라운드를 유지한 채 (날짜, 킥오프) 쌍만 두 경기 사이에서 교환하므로 편성 불변식이
 * 그대로 남는다 — 라운드마다 각 팀이 정확히 한 경기, 홈/원정 배정 불변, 라운드 간
 * 최소 간격은 이미 라운드 스팬 단위로 보장(`wellSpaced`)되어 있어 스팬 안에서
 * 날짜를 옮기는 것은 안전하다.
 *
 * 개선되는 첫 교환을 그대로 취하는 그리디이고 순서가 고정이라 결정적이다.
 * 반환값은 교환 횟수 (테스트·진단용).
 */
export function relaxEuroAdjacency(
  leagueMatches: MatchRecord[],
  euroMatches: MatchRecord[],
): number {
  const euroDates = new Map<string, string[]>();
  for (const m of euroMatches) {
    for (const teamId of [m.homeTeamId, m.awayTeamId]) {
      const dates = euroDates.get(teamId);
      if (dates) dates.push(m.date);
      else euroDates.set(teamId, [m.date]);
    }
  }
  if (euroDates.size === 0) return 0;

  /** 이 경기를 그 날짜에 두면 대항전과 몇 번 부딪히는가 */
  const clashes = (match: MatchRecord, date: string): number => {
    let n = 0;
    for (const teamId of [match.homeTeamId, match.awayTeamId]) {
      for (const euroDate of euroDates.get(teamId) ?? []) {
        if (Math.abs(diffDays(euroDate, date)) < MIN_REST_DAYS) n += 1;
      }
    }
    return n;
  };

  const rounds = new Map<string, MatchRecord[]>();
  for (const m of leagueMatches) {
    const key = `${m.competitionId}:${m.round}`;
    const group = rounds.get(key);
    if (group) group.push(m);
    else rounds.set(key, [m]);
  }

  const swap = (a: MatchRecord, b: MatchRecord): void => {
    const date = a.date;
    const time = a.time;
    a.date = b.date;
    a.time = b.time;
    b.date = date;
    b.time = time;
  };

  let swaps = 0;
  for (const group of rounds.values()) {
    // 교환이 새 충돌을 만들 수 있으니 더 나아지지 않을 때까지 반복한다
    for (let pass = 0; pass < 4; pass++) {
      let moved = 0;
      for (const a of group) {
        if (clashes(a, a.date) === 0) continue;
        // ① 두 경기 맞교환
        const partner = group.find(
          (b) =>
            b !== a &&
            clashes(a, b.date) + clashes(b, a.date) < clashes(a, a.date) + clashes(b, b.date),
        );
        if (partner) {
          swap(a, partner);
          moved += 1;
          continue;
        }
        // ② 맞교환이 없으면 3자 회전 — 한 라운드의 안전한 슬롯이 서로 물려 있을 때
        //    (예: 월요일 슬롯을 받을 수 있는 팀이 금요일 슬롯에만 있는 경우)
        const rotated = group.some((b) =>
          group.some((c) => {
            if (b === a || c === a || c === b) return false;
            const before = clashes(a, a.date) + clashes(b, b.date) + clashes(c, c.date);
            const after = clashes(a, b.date) + clashes(b, c.date) + clashes(c, a.date);
            if (after >= before) return false;
            swap(a, b); // a↔b 뒤 a는 b의 옛 슬롯, b는 a의 옛 슬롯
            swap(b, c); // b는 c의 옛 슬롯, c는 a의 옛 슬롯 — 3자 회전 완성
            return true;
          }),
        );
        if (rotated) moved += 1;
      }
      swaps += moved;
      if (moved === 0) break;
    }
  }
  return swaps;
}
