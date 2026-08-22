import { isTopLeague, leagueCatalog, leagueCatalogById, leagueName } from "../data/league-catalog";
import { clubEconomyLevel } from "../data/league-economy";
import { tierOfTeamIn } from "../core/club-tier";
import { RELEGATION_SLOTS } from "../core/league-shape";
import { makeRng } from "../core/rng";
import { computeStandings } from "./season";
import { startParachute, stopParachute } from "../club/finance";
import {
  catalogLeagueIn,
  clubProfileIn,
  pushNarrative,
  teamNameIn,
  teamShortNameIn,
  type GameState,
} from "../core/state";
import { squadRating } from "../squad/depth";

/**
 * 승강 — 1부 하위 세 팀과 그 나라 2부 상위 세 팀이 자리를 바꾼다.
 *
 * 팀의 소속 리그는 카탈로그가 갖고 **불변**이므로(2-레이어 원칙) 승강은 세이브
 * 상태(`state.leagueOf`)로만 표현된다. "이 팀이 지금 어느 리그에 있는가"를 묻는
 * 자리는 전부 `leagueOfTeamIn`을 지나야 한다 — 일정·순위표·재정·이적 시장·조회
 * 도구. 소속에서 파생하는 판정도 같은 자리에 선다 — `isTopFlightIn`,
 * `clubEconomyLevelIn`. 카탈로그를 직접 읽어도 되는 것은 승강이 바꾸지 않는 축,
 * 곧 리그의 종류(시장 전용)와 나라, 그리고 세이브가 아직 없는 **세계 생성**뿐이다.
 *
 * 2부는 리그전을 돌지 않아 순위표가 없다(`league-catalog`의 `cup-only`). 그래서
 * 승격 팀은 **전력 + 시즌을 섞은 시드**로 뽑는다 — 다만 감독이 그 리그에 있으면
 * 그 시즌엔 진짜 순위표가 있으므로(`buildAllLeagueMatches`의 추가 리그) 표를 쓴다.
 */

/**
 * 승격 추첨의 폭 — 전력 **서열** 위에 얹히는 난수(자리 수).
 *
 * 전력을 점수 그대로 쓰면 안 된다: 방금 강등된 클럽은 실선수 스쿼드라 절차 생성
 * 2부 클럽보다 열다섯 점쯤 높아서, 어떤 난수를 얹어도 매년 그 셋이 그대로 올라온다.
 * 서열로 재면 눈금이 아니라 자리만 남아 4~5위도 올라올 수 있다.
 */
export const PROMOTION_LUCK = 4;

/**
 * 이 팀이 지금 속한 리그 — 세 층을 순서대로 본다.
 *
 * 승강 결과(`state.leagueOf`) → 게임 시작에 복사한 소속(`GAME_TEAM.leagueId`) →
 * 카탈로그. 가운데 층이 있어야 어드민이 팀의 리그를 옮겨도 진행 중인 세이브의
 * 순위표·일정이 흔들리지 않는다 (game-state.md §1).
 */
export function leagueOfTeamIn(state: GameState, teamId: string): string {
  return state.leagueOf?.[teamId] ?? catalogLeagueIn(state, teamId);
}

/**
 * 이 팀이 지금 1부인가 — `isTopFlight`의 상태 인지 판.
 *
 * 카탈로그판은 **세계 생성**(새 게임의 스쿼드 분류·절차 생성·축소 세계)이 계속
 * 쓴다. 그 자리엔 아직 세이브가 없고, 새 게임의 결과는 카탈로그만으로 정해져야
 * 재현된다. 게임이 시작한 뒤 도는 자리(AI 시장·국내 컵 시드)는 이쪽이다.
 */
export function isTopFlightIn(state: GameState, teamId: string): boolean {
  return isTopLeague(leagueOfTeamIn(state, teamId));
}

/**
 * 이 구단의 지금 살림 수준 — `clubEconomyLevel`의 상태 인지 판. 리그도 체급도
 * 세이브가 답한다.
 *
 * 승강이 이 값을 움직이는 축이다(2부는 그 나라 1부에서 파생한다). 카탈로그판을
 * 그대로 두면 강등한 구단이 2부 수입을 받으면서 1부 고정비를 내고 1부 시즌 예산을
 * 배정받는다 (finance.md §6.2).
 */
export function clubEconomyLevelIn(state: GameState, teamId: string): number {
  return clubEconomyLevel(
    teamId,
    tierOfTeamIn(state, teamId),
    leagueOfTeamIn(state, teamId),
    clubProfileIn(state, teamId).commercialTier,
  );
}

/** 지금 그 리그에 속한 클럽 (세이브 기준) */
export function teamsOfLeagueIn(state: GameState, leagueId: string): string[] {
  return state.teams.filter((t) => leagueOfTeamIn(state, t.id) === leagueId).map((t) => t.id);
}

/**
 * 이 팀이 속한 리그의 클럽 수 — 순위 문턱이 파생하는 두 재료 중 하나
 * (`core/league-shape.ts` · career.md §5). 승강이 옮긴 소속을 본다.
 */
export function leagueSizeIn(state: GameState, teamId: string): number {
  return teamsOfLeagueIn(state, leagueOfTeamIn(state, teamId)).length;
}

/** 국내 컵을 채우는 2부들 — 승강의 상대 리그 */
const secondTiers = () => leagueCatalog().filter((l) => l.kind === "cup-only");

/** 그 리그의 아래 — 같은 나라의 2부 (없으면 null) */
export function secondTierOf(leagueId: string): string | null {
  const country = leagueCatalogById(leagueId)?.country;
  if (!country) return null;
  return secondTiers().find((l) => l.country === country)?.id ?? null;
}

/** 이 리그에 승강이 있는가 — 아래 리그가 세이브에 실제로 있어야 한다(축소 세계엔 없다) */
export function hasRelegation(state: GameState, leagueId: string): boolean {
  const second = secondTierOf(leagueId);
  if (!second) return false;
  return teamsOfLeagueIn(state, second).length >= RELEGATION_SLOTS;
}

/** 이 리그가 이번 시즌 실제로 경기를 했는가 — 안 뛴 리그는 강등도 없다 */
function played(state: GameState, leagueId: string): boolean {
  return state.matches.some(
    (m) => m.season === state.season && m.competitionId === leagueId && m.result !== null,
  );
}

/** 올라올 세 팀 — 순위표가 있으면 그것으로, 없으면 전력 + 시즌 시드 */
function promotedFrom(state: GameState, secondTier: string): string[] {
  const pool = teamsOfLeagueIn(state, secondTier);
  if (played(state, secondTier)) {
    return computeStandings(state, secondTier)
      .slice(0, RELEGATION_SLOTS)
      .map((r) => r.teamId);
  }
  // 시즌을 채널에 섞는다 — 안 그러면 한 세이브에서 매년 같은 팀이 올라온다
  const rng = makeRng(state.seed, `promotion:${secondTier}:${state.season}`);
  const byStrength = [...pool].sort((a, b) => squadRating(state, b) - squadRating(state, a));
  return byStrength
    .map((teamId, rank) => ({ teamId, score: pool.length - rank + rng() * PROMOTION_LUCK }))
    .sort((a, b) => b.score - a.score)
    .slice(0, RELEGATION_SLOTS)
    .map((x) => x.teamId);
}

function setLeague(state: GameState, teamId: string, leagueId: string): void {
  const map = (state.leagueOf ??= {});
  // 세이브가 복사한 원 소속과 같으면 항목을 두지 않는다 — 지금 카탈로그와 견주면
  // 어드민의 리그 이동 편집이 진행 중인 세이브의 승강 기록을 지운다
  if (catalogLeagueIn(state, teamId) === leagueId) delete map[teamId];
  else map[teamId] = leagueId;
}

/**
 * 승강 처리 — **시즌 전환에서 새 일정을 짜기 전에** 한 번.
 *
 * @param finalTables 방금 끝난 시즌의 리그별 최종 순위 (팀 id 순서).
 *   대항전 티켓과 같은 표를 쓴다 — 순위가 두 곳에서 갈리면 안 된다.
 */
export function applyPromotionRelegation(
  state: GameState,
  finalTables: Record<string, string[]>,
  digest: string[],
): void {
  const ourLeague = leagueOfTeamIn(state, state.userTeamId);
  for (const [leagueId, table] of Object.entries(finalTables)) {
    if (!hasRelegation(state, leagueId)) continue;
    if (!played(state, leagueId)) continue;
    if (table.length <= RELEGATION_SLOTS) continue;
    const second = secondTierOf(leagueId)!;
    // 두 목록을 **먼저** 정한다 — 방금 강등된 팀이 그 자리에서 다시 올라오지 않게
    const down = table.slice(-RELEGATION_SLOTS);
    const up = promotedFrom(state, second);
    for (const teamId of down) {
      setLeague(state, teamId, second);
      // 낙하산 — 강등의 완충이자 챔피언십 재정 기준선의 정체 (finance.md §9-1)
      startParachute(state, teamId, leagueId);
    }
    for (const teamId of up) {
      setLeague(state, teamId, leagueId);
      // 승격하면 1부 배분을 다시 받으므로 낙하산은 끝난다 (이중 수령 금지)
      stopParachute(state, teamId);
    }

    if (leagueId !== ourLeague && second !== ourLeague) continue;
    digest.push(
      `⬇️ ${leagueName(leagueId)} 강등: ${down.map((id) => teamShortNameIn(state, id)).join(" · ")}`,
      `⬆️ ${leagueName(leagueId)} 승격: ${up.map((id) => teamShortNameIn(state, id)).join(" · ")}`,
    );
    if (down.includes(state.userTeamId)) {
      digest.push(
        `${teamNameIn(state, state.userTeamId)}이(가) 강등됐다 — 다음 시즌은 ${leagueName(second)}다`,
      );
      pushNarrative(state, `${leagueName(leagueId)} 강등 — ${leagueName(second)}로`, 5);
    } else if (up.includes(state.userTeamId)) {
      digest.push(
        `${teamNameIn(state, state.userTeamId)} 승격! 다음 시즌은 ${leagueName(leagueId)}다`,
      );
      pushNarrative(state, `${leagueName(leagueId)} 승격`, 5);
    }
  }
}
