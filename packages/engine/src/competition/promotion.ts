import type { PositionGroup } from "@story-fm/domain";
import { isTopLeague, leagueCatalog, leagueCatalogById, leagueName } from "../data/league-catalog";
import { clubEconomyLevel } from "../data/league-economy";
import { tierOfTeamIn } from "../core/club-tier";
import { RELEGATION_SLOTS } from "../core/league-shape";
import { makeRng } from "../core/rng";
import { contractUntil, seasonYear } from "../core/dates";
import { computeStandings } from "./season";
import { startParachute, stopParachute } from "../club/finance";
import { generatePromotionSigning } from "../world/generate";
import { assignSquadNumber } from "../squad/numbers";
import { estimateWeeklyWage, wageSubjectOf } from "../world/wages";
import {
  catalogLeagueIn,
  clubProfileIn,
  groupOf,
  playersOf,
  pushNarrative,
  teamNameIn,
  teamShortNameIn,
  type GameState,
} from "../core/state";

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

/** 판에 서는 인원 — 스쿼드의 힘은 이만큼의 평균으로 잰다 */
const STARTING_XI = 11;

/** 스쿼드 상위 열한 명의 평균 OVR — 2부 클럽을 줄 세우는 잣대 */
function squadRating(state: GameState, teamId: string): number {
  const squad = playersOf(state, teamId);
  if (squad.length === 0) return 0;
  const top = [...squad]
    .sort((a, b) => b.attributes.overall - a.attributes.overall)
    .slice(0, STARTING_XI);
  return top.reduce((s, p) => s + p.attributes.overall, 0) / top.length;
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
): string[] {
  const ourLeague = leagueOfTeamIn(state, state.userTeamId);
  /** 올라간 팀 — 보강이 이 목록을 받는다 (`reinforcePromotedSquads`) */
  const promoted: string[] = [];
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
      promoted.push(teamId);
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
  return promoted;
}

/**
 * 승격 팀이 1부 첫 시즌을 시작하는 **자리별 목표 인원**.
 *
 * 등록 뎁스 쿼터(`core/state.ts`의 `ESSENTIAL_QUOTA` — team.md §5)에 공격수 하나를
 * 얹은 표다. 인원만 세면 골키퍼 둘짜리 팀이 공격수를 다섯 받는다.
 */
const PROMOTED_QUOTA: Record<PositionGroup, number> = { GK: 3, DF: 8, MF: 8, FW: 6 };

/**
 * 승격 팀 명단의 하한 — **목표의 합이다**(25). 매치데이 정원(20)에 로테이션·부상
 * 몫 다섯을 얹은 수이고, 등록 명단 상한도 25라 하한이 상한을 밀지 않는다.
 * 같은 숫자를 두 곳에 적지 않으려고 표에서 낸다.
 */
const PROMOTED_SQUAD_FLOOR = Object.values(PROMOTED_QUOTA).reduce((sum, n) => sum + n, 0);

/**
 * 보강이 서는 분위 — 그 클럽 **주전 열한 명 평균에서 이만큼 아래**.
 *
 * 체급 상수(`TIER_BASE`)를 쓰면 갓 올라온 팀이 1부 눈금의 선수를 다섯 공짜로 받아
 * 첫 시즌부터 중위권이 된다. 승격이 팀을 강하게 만드는 것이 아니라 **두껍게**
 * 만들어야 하므로, 기준선은 그 팀 자신의 명단에서 파생한다 (team.md §5).
 */
const REINFORCEMENT_DROP = 4;

/** 보강 계약 기간 — 유스 콜업과 같은 3년 */
const REINFORCEMENT_YEARS = 3;

/** 자리를 고르는 순서 — 부족분이 같으면 앞의 자리가 먼저다 (결정적) */
const GROUP_ORDER: readonly PositionGroup[] = ["GK", "DF", "MF", "FW"];

/** 지금 가장 모자란 자리 — 부족분이 가장 큰 포지션군 */
function neediestGroup(have: Record<PositionGroup, number>): PositionGroup {
  return GROUP_ORDER.reduce((best, group) =>
    PROMOTED_QUOTA[group] - have[group] > PROMOTED_QUOTA[best] - have[best] ? group : best,
  );
}

/**
 * 승격 팀 명단 보강 — **승강과 체급 재산정 뒤, 새 일정을 짜기 전에** 한 번.
 *
 * 2부 클럽은 컵에만 나오므로 스무 명으로 만들어진다(team.md §4). 그대로 올라가면
 * 매치데이 정원(20)과 명단이 같아 부상 하나에 벤치가 빈다. 그래서 하한까지 채운다
 * — 40명대로 올라온 팀(강등됐다 돌아온 클럽)은 이미 하한 위라 한 명도 받지 않는다.
 *
 * 난수는 `(세이브 시드, promotion-signing:팀:시즌:번호)`에서만 나온다 — 같은
 * 세이브를 다시 굴리면 같은 사람이 온다.
 */
export function reinforcePromotedSquads(
  state: GameState,
  promoted: readonly string[],
  digest: string[],
): void {
  // id는 세계 전체에서 유일해야 한다 — 한 번 쥐고 팀을 돌며 등록한다
  const takenIds = new Set(state.players.map((p) => p.id));
  for (const teamId of promoted) {
    const squad = playersOf(state, teamId);
    /**
     * **하한이 재는 것은 1군이다.** 2군은 매치데이 명단에 설 수 없으므로(team.md §5)
     * 전체 인원으로 재면, 유스가 쌓인 2부 클럽이 1군 열다섯 명으로 올라가면서도
     * "이미 하한 위"로 읽힌다.
     */
    const firstTeam = squad.filter((p) => p.squadLevel !== "reserve");
    const short = PROMOTED_SQUAD_FLOOR - firstTeam.length;
    if (short <= 0) continue;
    const base = Math.round(squadRating(state, teamId)) - REINFORCEMENT_DROP;
    const have: Record<PositionGroup, number> = { GK: 0, DF: 0, MF: 0, FW: 0 };
    for (const player of firstTeam) have[groupOf(player)] += 1;
    // 이름은 **팀 전체**에서 유일해야 한다 — 2군까지 쥐고 뽑는다 (people.md §2)
    const takenNames = new Set(squad.map((p) => p.name));
    for (let i = 0; i < short; i++) {
      const group = neediestGroup(have);
      have[group] += 1;
      const signing = generatePromotionSigning(
        state.seed,
        teamId,
        state.season,
        i,
        base,
        group,
        takenIds,
        seasonYear(state.season),
        takenNames,
      );
      state.players.push(signing);
      assignSquadNumber(state.players, signing);
      /**
       * **창 밖 이동이다** — 이 자리는 새 시즌 이적창이 아직 세워지기 전이고
       * (`buildTransferWindows`는 뒤에 온다), 자유계약이라 창에 걸리지 않는다.
       * 유스 콜업이 `windowId: null`을 쓰는 것과 같은 자리다.
       */
      state.transfers.push({
        id: `tr-promo-${signing.id}`,
        gamePlayerId: signing.id,
        windowId: null,
        fromTeamId: null,
        toTeamId: teamId,
        date: state.date,
        type: "free",
        fee: 0,
      });
      state.contracts.push({
        id: `c-${signing.id}`,
        gamePlayerId: signing.id,
        teamId,
        weeklyWage: estimateWeeklyWage(
          teamId,
          wageSubjectOf(signing, state.date),
          playersOf(state, teamId).map((p) => wageSubjectOf(p, state.date)),
          state,
        ),
        since: state.date,
        until: contractUntil(state.date, REINFORCEMENT_YEARS),
        status: "active",
      });
    }
    if (teamId === state.userTeamId) {
      digest.push(`승격 보강: 자유계약으로 ${short}명을 더해 1군이 ${PROMOTED_SQUAD_FLOOR}명이다`);
    }
  }
}
