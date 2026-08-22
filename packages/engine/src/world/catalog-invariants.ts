import type { TeamCatalogEntry } from "../data/team-catalog";
import type { LeagueCatalogEntry } from "../data/league-catalog";
import type { CupCatalogEntry } from "../data/cup-catalog";
import { knockoutBracketSize } from "../data/cup-catalog";
import {
  DOMESTIC_CUP_SIZE,
  DOMESTIC_STAGES,
  type DomesticCupEntry,
} from "../data/domestic-cup-catalog";

/**
 * 카탈로그 불변식 — **새 게임이 시작할 수 있는가**를 저장 전에 묻는다.
 *
 * 구조 필드(리그 소속·컵 규모·티켓 배분)를 열어 두면 편집 한 번으로 세계가
 * 성립하지 않게 될 수 있다 — 홀수 팀 리그는 라운드로빈을 못 돌고(`buildMatches`가
 * 던진다), 2의 거듭제곱이 아닌 브래킷은 녹아웃이 끝나지 않는다. 그 실패는 편집한
 * 순간이 아니라 **한참 뒤 새 게임을 시작할 때** 터지므로 원인을 찾기 어렵다.
 * 그래서 저장하는 자리에서 막는다.
 *
 * 전부 순수 함수다 — 후보 카탈로그를 받아 위반 메시지를 돌려준다(빈 배열이면 통과).
 */

/**
 * 리그전을 도는 리그의 팀 수 상한 — 달력이 38라운드 골격이라
 * 20팀(38라운드)을 넘으면 배치할 매치위크가 모자란다 (`anchorsFor`).
 */
export const MAX_LEAGUE_TEAMS = 20;

/** 리그전 최소 인원 — 둘이면 홈·원정 두 경기라도 성립한다 */
export const MIN_LEAGUE_TEAMS = 2;

export function checkLeagueInvariants(
  leagues: readonly LeagueCatalogEntry[],
  teams: readonly TeamCatalogEntry[],
): string[] {
  const problems: string[] = [];
  const ids = new Set(leagues.map((l) => l.id));

  const duplicated = leagues.filter((l, i) => leagues.findIndex((x) => x.id === l.id) !== i);
  for (const league of duplicated) problems.push(`리그 id가 중복됩니다: ${league.id}`);

  /**
   * 팀 id 중복은 크래시가 아니라 **소실**이다 — `teamCatalogById`가 하나만 답해
   * 나머지 동명 클럽이 스쿼드·일정·순위표에서 통째로 사라진다 (team.md §8).
   */
  const duplicatedTeams = teams.filter((t, i) => teams.findIndex((x) => x.id === t.id) !== i);
  for (const team of duplicatedTeams) problems.push(`팀 id가 중복됩니다: ${team.id}`);

  for (const team of teams) {
    if (!ids.has(team.leagueId)) {
      problems.push(`${team.name}: 카탈로그에 없는 리그를 가리킵니다 (${team.leagueId})`);
    }
  }

  for (const league of leagues) {
    if (league.kind !== "playable") continue;
    const count = teams.filter((t) => t.leagueId === league.id).length;
    if (count < MIN_LEAGUE_TEAMS) {
      problems.push(
        `${league.name}: 리그전을 돌려면 ${MIN_LEAGUE_TEAMS}팀 이상이어야 합니다 (지금 ${count}팀)`,
      );
    } else if (count % 2 !== 0) {
      problems.push(`${league.name}: 팀 수가 홀수(${count})라 리그전을 편성할 수 없습니다`);
    } else if (count > MAX_LEAGUE_TEAMS) {
      problems.push(
        `${league.name}: 팀이 ${count}개라 시즌 달력(최대 ${MAX_LEAGUE_TEAMS}팀·38라운드)에 담기지 않습니다`,
      );
    }
  }
  return problems;
}

/** 플레이오프 한 대진에 서는 팀 수 — 승자가 본선 한 자리를 가져간다 */
const PLAYOFF_TEAMS_PER_TIE = 2;

/** 2의 거듭제곱인가 — 녹아웃 브래킷은 부전승 없이 반씩 줄어야 한다 */
function isPowerOfTwo(n: number): boolean {
  return n >= 1 && Number.isInteger(n) && (n & (n - 1)) === 0;
}

export function checkEuroCupInvariants(
  cups: readonly CupCatalogEntry[],
  leagues: readonly LeagueCatalogEntry[],
): string[] {
  const problems: string[] = [];
  const leagueIds = new Set(leagues.map((l) => l.id));

  for (const cup of cups) {
    if (!Number.isInteger(cup.size) || cup.size < 2 || cup.size % 2 !== 0) {
      problems.push(`${cup.name}: 참가 팀 수는 2 이상의 짝수여야 합니다 (지금 ${cup.size})`);
    }
    if (
      !Number.isInteger(cup.matchesPerTeam) ||
      cup.matchesPerTeam < 2 ||
      cup.matchesPerTeam % 2 !== 0
    ) {
      problems.push(
        `${cup.name}: 팀당 리그 페이즈 경기 수는 2 이상의 짝수여야 합니다 (홈 절반·원정 절반)`,
      );
    } else if (cup.matchesPerTeam > cup.size - 1) {
      problems.push(
        `${cup.name}: 팀당 ${cup.matchesPerTeam}경기는 참가 ${cup.size}팀으로 채울 수 없습니다 (상대가 모자랍니다)`,
      );
    }
    if (cup.playoffSlots % 2 !== 0) {
      problems.push(`${cup.name}: 플레이오프 팀 수는 짝수여야 합니다 (지금 ${cup.playoffSlots})`);
    } else if (
      cup.playoffSlots > 0 &&
      cup.directSlots !== cup.playoffSlots / PLAYOFF_TEAMS_PER_TIE
    ) {
      /**
       * 본선 첫 단계는 **직행 팀 하나에 플레이오프 승자 하나**를 붙인다
       * (`euro-knockout.ts`의 `mainDrawPairs`). 어긋나면 승자 한 팀이 두 대진에
       * 서거나 직행 팀이 상대 없이 남아 결승이 만들어지지 않고 — 시즌이 끝나지
       * 않는다. 합만 보는 브래킷 검사로는 잡히지 않는 자리다.
       */
      problems.push(
        `${cup.name}: 직행 ${cup.directSlots}팀이 플레이오프 승자 ${cup.playoffSlots / PLAYOFF_TEAMS_PER_TIE}팀과 일대일로 맞지 않습니다`,
      );
    }
    const bracket = knockoutBracketSize(cup);
    if (!isPowerOfTwo(bracket)) {
      problems.push(
        `${cup.name}: 본선 대진 수(직행 ${cup.directSlots} + 플레이오프 ${cup.playoffSlots}/2 = ${bracket})가 2의 거듭제곱이 아닙니다`,
      );
    }
    if (cup.directSlots + cup.playoffSlots > cup.size) {
      problems.push(
        `${cup.name}: 통과 팀(${cup.directSlots + cup.playoffSlots})이 참가 팀(${cup.size})보다 많습니다`,
      );
    }
    const slotSum = Object.values(cup.slots).reduce((sum, n) => sum + n, 0);
    if (slotSum !== cup.size) {
      problems.push(`${cup.name}: 리그별 티켓 합(${slotSum})이 참가 팀 수(${cup.size})와 다릅니다`);
    }
    for (const leagueId of Object.keys(cup.slots)) {
      if (!leagueIds.has(leagueId)) {
        problems.push(`${cup.name}: 카탈로그에 없는 리그에 티켓을 줍니다 (${leagueId})`);
      }
    }
  }

  const duplicated = cups.filter((c, i) => cups.findIndex((x) => x.id === c.id) !== i);
  for (const cup of duplicated) problems.push(`대항전 id가 중복됩니다: ${cup.id}`);
  return problems;
}

export function checkDomesticCupInvariants(cups: readonly DomesticCupEntry[]): string[] {
  const problems: string[] = [];
  const duplicated = cups.filter((c, i) => cups.findIndex((x) => x.id === c.id) !== i);
  for (const cup of duplicated) problems.push(`국내 컵 id가 중복됩니다: ${cup.id}`);

  /**
   * 시드 진입 라운드의 산수 (competition.md §3.2-1·§7) — 첫 라운드 뒤·결승 앞이고,
   * 시드 수는 정원의 절반 이하여야 시드가 진입 라운드에서 서로 만나지 않는다.
   * 어긋나면 시드가 앉을 자리가 없거나 앞 라운드가 비어 결승이 만들어지지 않는다.
   */
  for (const cup of cups) {
    const entry = cup.seedEntry;
    if (!entry) continue;
    const stageIdx = DOMESTIC_STAGES.indexOf(entry.stage);
    if (stageIdx < 1 || entry.stage === "final") {
      problems.push(`${cup.name}: 시드 진입 라운드는 첫 라운드 뒤·결승 앞이어야 합니다`);
      continue;
    }
    const capacity = DOMESTIC_CUP_SIZE >> stageIdx;
    if (!Number.isInteger(entry.count) || entry.count < 1 || entry.count > capacity / 2) {
      problems.push(
        `${cup.name}: 시드 수는 1 이상, 진입 라운드 정원의 절반(${capacity / 2}) 이하여야 합니다 (지금 ${entry.count})`,
      );
    }
  }
  return problems;
}

/** 세 층을 한 번에 — 팀·리그가 함께 바뀌는 편집(팀 이동·리그 삭제)의 관문 */
export function checkCatalogInvariants(input: CatalogCandidate): string[] {
  return [
    ...checkLeagueInvariants(input.leagues, input.teams),
    ...checkEuroCupInvariants(input.euroCups, input.leagues),
    ...checkDomesticCupInvariants(input.domesticCups),
  ];
}

export interface CatalogCandidate {
  leagues: readonly LeagueCatalogEntry[];
  teams: readonly TeamCatalogEntry[];
  euroCups: readonly CupCatalogEntry[];
  domesticCups: readonly DomesticCupEntry[];
}

/**
 * 막지는 않지만 알려야 하는 것 — **대회가 조용히 사라지는** 편집.
 *
 * 국내 컵은 그 나라 전 클럽(1부 + 2부)이 나오고 정확히 32팀이어야 브래킷이
 * 부전승 없이 돈다. 어긋나면 크래시가 아니라 대회가 그냥 열리지 않으므로
 * (`domestic-cup.ts`가 규모를 보고 편성을 건너뛴다) 저장은 허락하되 말해 준다 —
 * 여기서 막으면 클럽을 한 팀도 더하거나 뺄 수 없다.
 */
export function catalogWarnings(input: CatalogCandidate): string[] {
  const warnings: string[] = [];
  for (const cup of input.domesticCups) {
    const countryLeagues = new Set(
      input.leagues.filter((l) => l.country === cup.country).map((l) => l.id),
    );
    const clubs = input.teams.filter((t) => countryLeagues.has(t.leagueId)).length;
    if (clubs !== DOMESTIC_CUP_SIZE) {
      warnings.push(
        `${cup.name}이 열리지 않습니다 — ${cup.country}의 클럽이 ${clubs}개입니다 (${DOMESTIC_CUP_SIZE}팀 필요)`,
      );
    }
    if (!input.leagues.some((l) => l.country === cup.country && l.kind === "playable")) {
      warnings.push(`${cup.name}: ${cup.country}에 리그전을 도는 1부 리그가 없습니다`);
    }
  }
  return warnings;
}
