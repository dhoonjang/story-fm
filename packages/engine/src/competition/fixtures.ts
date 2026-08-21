import type { MatchRecord } from "@story-fm/domain";
import {
  MIN_REST_HOURS,
  buildAllLeagueMatches,
  restHours,
  type LeagueMembership,
} from "./calendar";
import { leagueOfTeam } from "../data/team-catalog";
import { buildAllEuroMatches, type EuroEntry } from "./europe";
import { buildFriendlyMatches } from "./friendly";
import { buildReserveFixtures, isReserveMatch } from "./reserve";
import type { WorldScope } from "../world/scope";

/**
 * 시즌 편성의 단일 입구 — 프리시즌 친선 + 리그 + 대항전을 함께 만들고 충돌을 푼다.
 *
 * 두 일정을 따로 만들면 서로를 모른다. 리그 주중 라운드는 대항전 주를 비켜주지만
 * (calendar.ts `isEuroWeek`), **주말 라운드의 금·월 슬롯**은 여전히 대항전
 * 화요일·목요일과 하루 차이로 붙는다. 대항전에 나가는 팀에게 월→화, 목→금은
 * 실제 리그가 절대 내지 않는 일정이다. 그래서 편성 후 슬롯을 맞바꿔 푼다.
 *
 * 친선은 개막 전에만 있어 리그·대항전과 날짜가 겹칠 수 없으므로 충돌 해소에
 * 참여하지 않는다. 다만 **감독의 상대는 유저 팀을 알아야** 정해진다
 * (`buildFriendlyMatches` 점층 곡선) — `userTeamId`가 없으면 곡선 없이 전력이
 * 붙은 팀끼리만 묶인다.
 */
export function buildSeasonFixtures(
  season: number,
  seed: number,
  entrants: EuroEntry[],
  world?: WorldScope,
  membership?: LeagueMembership,
  userTeamId?: string,
): MatchRecord[] {
  const league = buildAllLeagueMatches(season, seed, world, membership);
  const euro = buildAllEuroMatches(season, seed, entrants);
  relaxEuroAdjacency(league, euro);
  const friendly = buildFriendlyMatches(season, seed, world, membership, userTeamId);
  // 2군 리그는 월요일 낮이라 리그·대항전과 휴식 충돌이 없다 — 해소에 참여하지 않는다
  const reserve = buildReserveFixtures(season, seed, world, membership, userTeamId);
  return [...friendly, ...league, ...euro, ...reserve];
}

/**
 * 감독의 달력(SCHEDULE_ENTRY)에 오를 경기 — **우리 리그 전체 + 우리 팀 대항전**.
 *
 * 우리 리그는 순위표를 읽기 위해 전 경기가 필요하고, 대항전은 우리 팀 경기만
 * 감독의 일정이다 (남의 UCL 경기는 장부에만 남는다).
 */
export function isUserFixture(
  match: MatchRecord,
  userTeamId: string,
  /** 감독이 지금 있는 리그 — 강등되면 카탈로그와 갈린다 (`leagueOfTeamIn`) */
  leagueId = leagueOfTeam(userTeamId),
): boolean {
  // 2군 경기는 감독 달력에 오르지 않는다 — 올리면 기본 훈련이 "다음 경기"로 읽는다
  if (isReserveMatch(match)) return false;
  return (
    match.competitionId === leagueId ||
    match.homeTeamId === userTeamId ||
    match.awayTeamId === userTeamId
  );
}

/** 편성 슬롯 — 날짜와 킥오프는 늘 함께 움직인다 */
interface Slot {
  date: string;
  time?: string;
}

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
  const euroSlots = new Map<string, Slot[]>();
  for (const m of euroMatches) {
    for (const teamId of [m.homeTeamId, m.awayTeamId]) {
      const slots = euroSlots.get(teamId);
      if (slots) slots.push({ date: m.date, time: m.time });
      else euroSlots.set(teamId, [{ date: m.date, time: m.time }]);
    }
  }
  if (euroSlots.size === 0) return 0;

  /**
   * 이 경기를 그 슬롯에 두면 얼마나 무리인가 — **모자란 시간의 합**.
   *
   * ① **날짜가 아니라 킥오프 시각으로 잰다.** 목요일 21:00 유로파를 뛴 팀에게 토요일
   *    12:30을 주면 날짜로는 이틀 뒤지만 실제 휴식은 39시간 30분이다 — 실제 리그가
   *    목요일 유럽 원정 클럽을 일요일로 미루는 이유가 그것이다.
   * ② **개수가 아니라 심각도로 센다.** 개수로 세면 23시간과 44시간이 똑같이 "1건"이라
   *    금요일 경기를 일요일로 옮기는 교환이 "개선 없음"으로 거절된다. 48시간에서
   *    모자란 만큼을 더하면 그리디가 **가장 나쁜 것부터** 푼다.
   */
  const clashes = (match: MatchRecord, slot: Slot): number => {
    let short = 0;
    for (const teamId of [match.homeTeamId, match.awayTeamId]) {
      for (const euro of euroSlots.get(teamId) ?? []) {
        short += Math.max(0, MIN_REST_HOURS - restHours(euro, slot));
      }
    }
    return short;
  };
  const slotOf = (m: MatchRecord): Slot => ({ date: m.date, time: m.time });

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
        if (clashes(a, slotOf(a)) === 0) continue;
        // ① 두 경기 맞교환
        const partner = group.find(
          (b) =>
            b !== a &&
            clashes(a, slotOf(b)) + clashes(b, slotOf(a)) <
              clashes(a, slotOf(a)) + clashes(b, slotOf(b)),
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
            const before = clashes(a, slotOf(a)) + clashes(b, slotOf(b)) + clashes(c, slotOf(c));
            const after = clashes(a, slotOf(b)) + clashes(b, slotOf(c)) + clashes(c, slotOf(a));
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
