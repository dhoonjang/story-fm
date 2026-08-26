import {
  DEFAULT_XI,
  TEAM_CATALOG_SEED,
  teamCatalog,
  type TeamCatalogEntry,
} from "../data/team-catalog";
import {
  LEAGUE_CATALOG_SEED,
  leagueCatalog,
  type LeagueCatalogEntry,
} from "../data/league-catalog";
import { cupCatalog, knockoutBracketSize, type CupCatalogEntry } from "../data/cup-catalog";
import { disciplineOf } from "../data/discipline-catalog";
import {
  DOMESTIC_CUP_SIZE,
  DOMESTIC_STAGES,
  domesticCupCatalog,
  type DomesticCupEntry,
} from "../data/domestic-cup-catalog";
import { catalogSource } from "../data/catalog-source";
import { playerCatalog } from "./catalog";
import { SQUAD_SEEDS } from "../data/squad-seeds";
import { DERBIES } from "../data/derbies";
import { HEAD_COACH_NAMES } from "../data/coach-seeds";
import { OWNER_NAMES } from "../data/owner-seeds";
import { CLUB_PROFILES_SEED } from "../data/club-profile";
import { WORLD_FIGURE_SEEDS } from "../data/world-figures";
import { EURO_MATCHDAYS } from "../competition/europe";
import { isAssociation, type PlayerCatalogEntry } from "@story-fm/domain";
import { slugifyName } from "./player-id";

/**
 * 카탈로그 불변식 — **새 게임이 시작할 수 있는가**를 저장 전에 묻는다.
 *
 * 구조 필드(리그 소속·컵 규모·티켓 배분)를 열어 두면 편집 한 번으로 세계가
 * 성립하지 않게 될 수 있다 — 홀수 팀 리그는 라운드로빈을 못 돌고(`buildMatches`가
 * 던진다), 2의 거듭제곱이 아닌 브래킷은 녹아웃이 끝나지 않는다. 그 실패는 편집한
 * 순간이 아니라 **한참 뒤 새 게임을 시작할 때** 터지므로 원인을 찾기 어렵다.
 * 그래서 저장하는 자리에서 막고, 새 게임을 세우는 자리에서 한 번 더 막는다
 * (`assertCatalogValid`) — 오버라이드 파일은 손으로도 고칠 수 있다.
 *
 * 전부 순수 함수다 — 후보 카탈로그를 받아 위반 메시지를 돌려준다(빈 배열이면 통과).
 *
 * ## 두 갈래 — 후보를 보는 검사와 시드를 보는 검사
 *
 * **편집할 수 있는 표는 후보를 본다**(리그·팀·컵). 어드민이 저장하려는 값이 곧
 * 검사 대상이라, 어긋난 편집이 그 자리에서 거절된다.
 *
 * **코드 시드끼리 맞물리는 표는 시드 팀 카탈로그를 본다**(`checkSeedInvariants`) —
 * 실선수 스쿼드(`SQUAD_SEEDS`) · 지정 선발(`DEFAULT_XI`) · 더비 · 코치 · 구단주 ·
 * 구단 프로필 · 세계 인물. 어드민이 편집할 수 없는 표들이라 후보 팀으로 재면 **고칠 수
 * 없는 이유로 정당한 편집이 막힌다** — 2부 클럽 하나를 지우려는데 코드의 구단주 표가
 * 거부하는 식이다. 어드민이 지운 팀을 가리키는 줄은 낡은 것이 아니라 그냥 안 쓰인다.
 * 잡아야 하는 것은 **시드가 갱신되면서 서로 어긋나는 것**이고, 그건 후보와 무관하다.
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
    } else if (cup.matchesPerTeam > EURO_MATCHDAYS.length) {
      /**
       * 리그 페이즈 한 라운드가 매치데이 하나를 쓴다 (`euroMatchdayDates`). 매치데이보다
       * 많은 경기를 잡으면 남는 경기가 이미 쓴 날로 되돌아가 **한 팀이 같은 날 두 경기**를
       * 뛴다 — 상대가 모자란 것과 달리 편성이 조용히 성립해 버리는 자리다.
       */
      problems.push(
        `${cup.name}: 팀당 ${cup.matchesPerTeam}경기는 대항전 매치데이 ${EURO_MATCHDAYS.length}일에 담기지 않습니다`,
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
   * **나라마다 유럽 티켓은 종류당 한 장이다.** 우승팀은 리그별 슬롯 하나에 담기므로
   * (`domesticCupWinners`가 `{ uel, uecl }` 한 칸에 쓴다) 같은 나라의 두 컵이 같은
   * 티켓을 주면 뒤에 처리된 컵이 앞 컵의 우승팀을 조용히 덮어쓴다 — 우승하고도
   * 대항전에 못 나가는 클럽이 생기고, 그 손실은 아무 데도 안 남는다.
   */
  const ticketOwner = new Map<string, DomesticCupEntry>();
  for (const cup of cups) {
    const key = `${cup.country}:${cup.europeanTicket}`;
    const owner = ticketOwner.get(key);
    if (owner) {
      problems.push(
        `${cup.country}의 ${cup.europeanTicket.toUpperCase()} 티켓을 ${owner.name}과 ${cup.name}이 함께 줍니다 (나라마다 한 장입니다)`,
      );
    } else {
      ticketOwner.set(key, cup);
    }
  }

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

/**
 * 리그전을 도는 리그의 클럽이 시드로 가져야 하는 최소 인원 — **선발 11인.**
 * 그보다 적으면 명단의 절반 이상이 가명이라 "실선수 시드"라는 말이 거짓이 된다.
 */
export const MIN_SEEDED_SQUAD = 11;

/**
 * 부분 시드(시장 전용 리그)의 하한 — **한 명.**
 *
 * 사우디·MLS 클럽은 경기를 하지 않으므로 스쿼드 전체가 필요 없다. 시드는
 * "감독이 데려올 만한 이름"만 담고 나머지는 절차 생성이 채운다
 * (`MARKET_LEAGUE_TEMPLATE`의 앞머리가 골키퍼 둘이라 시드에 GK가 없어도 명단이
 * 선다). 그래도 한 명은 있어야 그 리그의 `realSquads`가 사실이다 (team.md §4).
 */
export const MIN_PARTIAL_SEED = 1;

/** 선발 인원 — 지정 선발은 이만큼을 적는다 */
const STARTING_ELEVEN = 11;

/** 이 클럽의 시드 명단에 골키퍼가 몇인가 — 리그전을 도는 클럽은 하나는 있어야 한다 */
function seededGoalkeepers(teamId: string): number {
  return (SQUAD_SEEDS[teamId] ?? []).filter((s) => s.positionGroup === "GK").length;
}

/**
 * `teamId`를 가리키는 시드 표들 — 어긋난 줄은 크래시가 아니라 **조용히 안 쓰인다.**
 * 아스날 구단주가 가명이 되고, 아무도 이유를 모른다 (people.md §2).
 */
const SEED_TEAM_REFERENCES: ReadonlyArray<{ what: string; teamIds: readonly string[] }> = [
  { what: "더비 표", teamIds: DERBIES.flatMap((d) => [...d.teams]) },
  { what: "수석코치 시드", teamIds: Object.keys(HEAD_COACH_NAMES) },
  { what: "구단주 시드", teamIds: Object.keys(OWNER_NAMES) },
  { what: "구단 프로필 시드", teamIds: Object.keys(CLUB_PROFILES_SEED) },
  {
    what: "세계 인물 명부",
    teamIds: WORLD_FIGURE_SEEDS.map((f) => f.teamId).filter((id): id is string => id !== undefined),
  },
];

/**
 * 시드끼리 맞물리는 표들 — **팀은 언제나 코드 시드를 본다** (파일 상단 §두 갈래).
 *
 * 리그만 후보를 받는다: `realSquads`는 어드민이 켜고 끌 수 있는 값이라, 켜는 순간
 * 그 리그의 시드 클럽들이 그 주장을 뒷받침하는지 물어야 한다. 팀까지 후보로 재면
 * **고칠 수 없는 이유로 정당한 편집이 막힌다** — EPL에 클럽을 둘 더하면 실선수 시드가
 * 없다고 거절당하는데, 시드 없는 클럽의 스쿼드는 절차 생성이 멀쩡히 채운다.
 */
export function checkSeedInvariants(
  leagues: readonly LeagueCatalogEntry[] = LEAGUE_CATALOG_SEED,
): string[] {
  const problems: string[] = [];
  const teamIds = new Set(TEAM_CATALOG_SEED.map((t) => t.id));
  const teamName = new Map(TEAM_CATALOG_SEED.map((t) => [t.id, t.name]));

  // ── ① `realSquads`가 사실인가 — 세기는 `kind`가 정한다 (team.md §4)
  for (const league of leagues) {
    if (!league.realSquads) continue;
    if (league.kind !== "playable" && league.kind !== "market-only") {
      problems.push(
        `${league.name}: ${league.kind} 리그는 실선수 시드를 갖지 않습니다 (realSquads를 끄세요)`,
      );
      continue;
    }
    for (const team of TEAM_CATALOG_SEED) {
      if (team.leagueId !== league.id) continue;
      const seeded = (SQUAD_SEEDS[team.id] ?? []).length;
      if (league.kind === "market-only") {
        // 부분 시드 — 데려올 만한 이름만 있으면 된다 (나머지는 절차 생성)
        if (seeded < MIN_PARTIAL_SEED) {
          problems.push(`${team.name}: ${league.name}의 실선수 시드가 한 명도 없습니다`);
        }
      } else if (seeded < MIN_SEEDED_SQUAD) {
        problems.push(
          `${team.name}: ${league.name}는 실선수 시드 리그인데 시드가 ${seeded}명입니다 (${MIN_SEEDED_SQUAD}명 이상)`,
        );
      } else if (seededGoalkeepers(team.id) === 0) {
        problems.push(`${team.name}: 실선수 시드에 골키퍼가 없습니다`);
      }
    }
  }

  // ── ② 지정 선발의 슬러그가 그 클럽 시드에 실재하는가 (team.md §6)
  for (const [teamId, slugs] of Object.entries(DEFAULT_XI)) {
    const label = teamName.get(teamId) ?? teamId;
    if (!teamIds.has(teamId)) {
      problems.push(`지정 선발이 카탈로그에 없는 팀을 가리킵니다: ${teamId}`);
      continue;
    }
    if (slugs.length !== STARTING_ELEVEN) {
      problems.push(`${label}: 지정 선발이 ${slugs.length}명입니다 (${STARTING_ELEVEN}명)`);
    }
    if (new Set(slugs).size !== slugs.length) {
      problems.push(`${label}: 지정 선발에 같은 선수가 두 번 있습니다`);
    }
    const seeded = new Set((SQUAD_SEEDS[teamId] ?? []).map((s) => slugifyName(s.nameEn)));
    const missing = slugs.filter((slug) => !seeded.has(slug));
    if (missing.length > 0) {
      problems.push(`${label}: 지정 선발에 시드에 없는 이름이 있습니다 — ${missing.join(" · ")}`);
    }
  }

  // ── ③ 인물·프로필 시드가 가리키는 팀이 시드 카탈로그에 있는가
  for (const { what, teamIds: referenced } of SEED_TEAM_REFERENCES) {
    for (const teamId of referenced) {
      if (!teamIds.has(teamId)) {
        problems.push(`${what}가 카탈로그에 없는 팀을 가리킵니다: ${teamId}`);
      }
    }
  }
  for (const derby of DERBIES) {
    if (derby.teams[0] === derby.teams[1]) {
      problems.push(`${derby.name}: 한 팀이 자기 자신과 더비를 이룹니다`);
    }
  }
  return problems;
}

/** 위반을 몇 줄까지 이름으로 적을 것인가 — 5,300명이 통째로 어긋나면 메시지가 로그를 덮는다 */
const NAMED_VIOLATIONS = 5;

/**
 * **모든 선수에게 국적이 선다** — 등록 규정도 대표팀도 빈칸을 다룰 자리가 없다.
 *
 * 시드가 조사한 값이든 클럽 협회에서 온 파생이든(`deriveNationality`) 결과는 같아야
 * 한다: 한 명이라도 비면 그 위에 서는 규칙이 "국적 없는 선수"라는 갈래를 따로
 * 들어야 하고, 그 갈래는 아무도 유지하지 않는다. 아는 협회 코드인지도 함께 본다 —
 * 표에 없는 코드는 비어 있는 것과 똑같이 아무 규정도 읽지 못한다.
 */
export function checkPlayerNationality(
  entries: readonly Pick<PlayerCatalogEntry, "id" | "nationality" | "secondNationality">[],
): string[] {
  const missing = entries.filter((e) => e.nationality === undefined);
  const unknown = entries.filter(
    (e) =>
      (e.nationality !== undefined && !isAssociation(e.nationality)) ||
      (e.secondNationality !== undefined && !isAssociation(e.secondNationality)),
  );
  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(
      `국적이 없는 선수 ${missing.length}명 — ${missing
        .slice(0, NAMED_VIOLATIONS)
        .map((e) => e.id)
        .join(", ")}`,
    );
  }
  if (unknown.length > 0) {
    problems.push(
      `협회 표에 없는 국적 코드 ${unknown.length}건 — ${unknown
        .slice(0, NAMED_VIOLATIONS)
        .map(
          (e) => `${e.id}(${e.nationality}${e.secondNationality ? `·${e.secondNationality}` : ""})`,
        )
        .join(", ")}`,
    );
  }
  return problems;
}

/**
 * **경기를 여는 대회는 징계 규정을 가져야 한다**
 * (→ ../../../../docs/simulation/match.md §6).
 *
 * 규정이 없으면 그 대회의 카드는 장부에 남지도 정지를 부르지도 않는다
 * (`recordCard`가 조용히 돌아선다). 크래시가 아니라 **없는 규칙**이라, 새 대회를
 * 더한 사람이 알아채는 자리는 여기뿐이다.
 */
export function checkDisciplineCoverage(
  leagues: readonly LeagueCatalogEntry[],
  euroCups: readonly CupCatalogEntry[],
  domesticCups: readonly DomesticCupEntry[],
): string[] {
  const playing = [
    // 2부도 센다 — 감독이 강등되면 그 리그가 일정을 돌고 클럽은 국내 컵에 나온다
    ...leagues.filter((l) => l.kind === "playable" || l.kind === "cup-only").map((l) => l.id),
    ...euroCups.map((c) => c.id),
    ...domesticCups.map((c) => c.id),
  ];
  return playing
    .filter((id) => disciplineOf(id) === null)
    .map((id) => `${id}: 징계 규정 없음 (data/discipline-catalog.ts)`);
}

/** 네 층을 한 번에 — 팀·리그가 함께 바뀌는 편집(팀 이동·리그 삭제)의 관문 */
export function checkCatalogInvariants(input: CatalogCandidate): string[] {
  return [
    ...checkLeagueInvariants(input.leagues, input.teams),
    ...checkEuroCupInvariants(input.euroCups, input.leagues),
    ...checkDomesticCupInvariants(input.domesticCups),
    ...checkSeedInvariants(input.leagues),
    ...checkDisciplineCoverage(input.leagues, input.euroCups, input.domesticCups),
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

/**
 * 지금 유효한 카탈로그가 성립하는가 — **새 게임을 세우기 전에 한 번.**
 *
 * 저장 시점의 검사만으로는 부족하다. 오버라이드 파일은 손으로도 고칠 수 있고,
 * 코드의 시드도 사람이 고친다 — 둘 다 어드민의 저장 문을 지나지 않는다. 어긋난
 * 카탈로그로 세운 세계는 실패가 몇 시즌 뒤 엉뚱한 자리에서 터지므로, 세계가 서는
 * 자리에서 위반을 **전부 모아** 던진다 (team.md §1).
 *
 * ⚠️ **조회는 막지 않는다.** 어드민 화면은 깨진 카탈로그도 읽어야 고칠 수 있으므로
 * 문이 걸리는 자리는 `createGame` 하나다.
 */
export function assertCatalogValid(): void {
  const problems = catalogProblems();
  if (problems.length > 0) {
    throw new Error(`카탈로그가 성립하지 않습니다 — ${problems.join(" · ")}`);
  }
}

/** 편집 세대마다 한 번만 센다 — 새 게임마다 169팀을 다시 훑지 않는다 */
const catalogProblems = catalogSource(() => [
  ...checkCatalogInvariants({
    leagues: leagueCatalog(),
    teams: teamCatalog(),
    euroCups: cupCatalog(),
    domesticCups: domesticCupCatalog(),
  }),
  // 선수 표는 후보로 들어오지 않는다 — 어드민이 저장한 뒤의 카탈로그를 그대로 본다
  ...checkPlayerNationality(playerCatalog()),
]);
