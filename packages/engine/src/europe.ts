import type { MatchRecord } from "@story-fm/domain";
import { addDays, dayOfWeek, firstHalfPairs } from "./calendar";
import { CUP_CATALOG, cupCatalogById } from "./data/cup-catalog";
import { teamCatalogById, teamsOfLeague } from "./data/team-catalog";
import { makeRng } from "./rng";
import { seasonYear } from "./calendar";

/**
 * 유럽 대항전 — 참가 배정 · 리그 페이즈 편성 (2024-25 이후 포맷).
 *
 * 리그 페이즈는 단일 순위표다. 팀마다 서로 다른 상대와 정해진 수의 경기를 치르고
 * (홈 절반·원정 절반) 하나의 표로 줄을 세운다. 상위는 16강 직행, 중위는 플레이오프.
 * 순위표는 리그와 같은 `computeStandings(state, cupId)`로 계산된다 — 대회 축이
 * 이미 competitionId로 갈라져 있으므로 컵도 그대로 얹힌다.
 */

/** 유럽 대항전 주중 — 리그가 비켜주는 자리 (실제 UCL 리그 페이즈 일정 골격) */
export const EURO_MATCHDAYS: Array<[number, number]> = [
  [9, 16],
  [9, 30],
  [10, 21],
  [11, 4],
  [11, 25],
  [12, 9],
  [1, 20],
  [1, 28],
];

/**
 * 대항전 경기일 — 시즌의 각 대항전 라운드 기준 날짜 (수요일로 스냅).
 * 실제로는 화·수·목에 흩어지는데, 경기 배정 시 대회별로 요일을 나눠 쓴다
 * (UCL 화·수 / UEL 목 / UECL 목) — 한 팀이 이틀 연속 뛰지 않게 된다.
 */
export function euroMatchdayDates(season: number): string[] {
  const year = seasonYear(season);
  const pad = (n: number) => String(n).padStart(2, "0");
  return EURO_MATCHDAYS.map(([m, d]) => {
    const y = m >= 8 ? year : year + 1;
    let date = `${y}-${pad(m)}-${pad(d)}`;
    while (dayOfWeek(date) !== 3) date = addDays(date, 1); // 수요일로 스냅
    return date;
  });
}

/** 이 날짜가 대항전 주중인가 — 리그 주중 라운드가 피해야 하는 자리 */
export function isEuroWeek(season: number, date: string): boolean {
  return euroMatchdayDates(season).some((d) => Math.abs(daysBetween(d, date)) <= 2);
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

// ── 참가 배정 ───────────────────────────────────────────

/**
 * 리그 내 서열 — 대항전 티켓 배정 기준.
 *
 * ⚠️ 현재는 **구단 등급(tier) + 시드 타이브레이크**로 줄을 세운다. 지난 시즌
 * 최종 순위로 배정하는 것이 옳지만, `endSeason`이 `state.matches`를 새 시즌으로
 * 교체하면서 지난 시즌 표가 사라진다. 리그별 최종 순위를 기록으로 남기는 작업이
 * 선행되어야 한다 (implementation-notes에 남김).
 */
function rankedTeams(leagueId: string, season: number, seed: number): string[] {
  const rng = makeRng(seed, `euro:${leagueId}:${season}`);
  return teamsOfLeague(leagueId)
    .map((t) => ({ id: t.id, key: t.tier * 100 + Math.floor(rng() * 90) }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.id);
}

/** 상위 대회가 이미 가져간 티켓 수 — 유로파는 UCL 다음 순위부터 받는다 */
function slotsAbove(cupId: string, leagueId: string): number {
  let above = 0;
  for (const cup of CUP_CATALOG) {
    if (cup.id === cupId) break;
    above += cup.slots[leagueId] ?? 0;
  }
  return above;
}

/** 이 대회의 참가 클럽 — 리그별 배정분을 순위 순으로 가져온다 */
export function europeanEntrants(cupId: string, season: number, seed: number): string[] {
  const cup = cupCatalogById(cupId);
  if (!cup) return [];
  const out: string[] = [];
  for (const [leagueId, count] of Object.entries(cup.slots)) {
    const ranked = rankedTeams(leagueId, season, seed);
    const from = slotsAbove(cupId, leagueId);
    out.push(...ranked.slice(from, from + count));
  }
  return out;
}

// ── 리그 페이즈 편성 ────────────────────────────────────

/**
 * 참가 클럽을 강약이 섞이도록 배열한다.
 *
 * 실제 대회는 4개 포트에서 각 2팀씩 뽑지만, 여기서는 등급순으로 정렬한 뒤
 * **강-약을 번갈아 끼워** 배치한다. 그러면 아래 서킬 편성이 자연스럽게 강팀과
 * 약팀을 섞는다. 진짜 포트 추첨과 같은 리그 회피 규칙은 다음 단계.
 */
function seedOrder(teamIds: string[], seed: number, cupId: string): string[] {
  const rng = makeRng(seed, `ring:${cupId}`);
  const byStrength = [...teamIds].sort((a, b) => {
    const ta = teamCatalogById(a)?.tier ?? 3;
    const tb = teamCatalogById(b)?.tier ?? 3;
    return ta - tb || (rng() < 0.5 ? -1 : 1);
  });
  const out: string[] = [];
  for (let i = 0, j = byStrength.length - 1; i <= j; i++, j--) {
    out.push(byStrength[i]!);
    if (i !== j) out.push(byStrength[j]!);
  }
  return out;
}

/**
 * 리그 페이즈 대진 — **서킬 메소드 라운드로빈의 앞부분을 잘라 쓴다**.
 *
 * 각 라운드가 완전 매칭이라 한 라운드에 같은 팀이 두 번 나오는 일이 구조적으로
 * 없고, 팀마다 서로 다른 상대와 정확히 `matchesPerTeam`경기를 치른다.
 *
 * (처음엔 "거리 d마다 i±d와 붙는" 원형 편성 + 그리디 라운드 배정으로 짰는데,
 *  그건 정규 그래프의 간선 색칠 문제라 최대 차수만으로 색칠이 보장되지 않는다 —
 *  UEL·UECL에서 라운드가 넘쳐 한 팀이 같은 날 두 경기를 하게 됐다. 라운드가
 *  처음부터 완전 매칭인 편성을 쓰면 그 문제 자체가 사라진다.)
 */
export function buildEuroLeaguePhase(
  cupId: string,
  season: number,
  seed: number,
): MatchRecord[] {
  const cup = cupCatalogById(cupId);
  if (!cup) return [];
  const entrants = europeanEntrants(cupId, season, seed);
  if (entrants.length % 2 !== 0) {
    throw new Error(`${cupId}: 참가 ${entrants.length}팀 — 리그 페이즈는 짝수여야 한다`);
  }
  const rounds = cup.matchesPerTeam;
  if (entrants.length < rounds + 1) return [];

  const allRounds = firstHalfPairs(seedOrder(entrants, seed, cupId));
  const dates = euroMatchdayDates(season);
  // 대회별 요일 — UCL은 화·수, 유로파·컨퍼런스는 하루 뒤 (한 팀이 이틀 연속 뛰지 않게)
  const dayOffset = cupId === "ucl" ? 0 : 1;

  const matches: MatchRecord[] = [];
  allRounds.slice(0, rounds).forEach((pairs, idx) => {
    const round = idx + 1;
    const anchor = dates[idx % dates.length]!;
    // 같은 대항전 주 안에서 절반은 하루 앞당겨 흩는다
    const date = addDays(anchor, dayOffset + (round % 2 === 0 ? -1 : 0));
    for (const [homeTeamId, awayTeamId] of pairs) {
      matches.push({
        id: `m-${cupId}-${season}-${round}-${homeTeamId}`,
        season,
        competitionId: cupId,
        round,
        date,
        homeTeamId,
        awayTeamId,
        result: null,
      });
    }
  });
  return matches;
}

/** 전 대항전 리그 페이즈 — 새 시즌 생성·전환에서 함께 만든다 */
export function buildAllEuroMatches(season: number, seed: number): MatchRecord[] {
  return CUP_CATALOG.flatMap((cup) => buildEuroLeaguePhase(cup.id, season, seed));
}

/** 이 팀이 이번 시즌 나가는 대항전 (없으면 null) — 브리핑·서사용 */
export function euroCompetitionOf(
  teamId: string,
  season: number,
  seed: number,
): string | null {
  for (const cup of CUP_CATALOG) {
    if (europeanEntrants(cup.id, season, seed).includes(teamId)) return cup.id;
  }
  return null;
}
