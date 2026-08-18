/**
 * 구단 체급 재산정 — **시즌 롤오버에서 승강을 적용한 뒤** 한 번 (team.md §2.1).
 *
 * 체급은 세이브의 값이므로 게임 안에서 움직일 수 있다. 움직이지 않으면 승격팀이
 * 1부에서 영원히 tier 4로 남아 보드가 잔류만 요구하고, 강등된 빅클럽이 2부에서
 * tier 1로 남아 우승 경쟁을 요구받는다.
 */
import { playersOf, savedClubProfile, teamNameIn, type GameState } from "../core/state";
import { boardExpectationOfTier, tierOfTeamIn } from "../core/club-tier";
import { isCupOnlyLeague, isTopLeague } from "../data/league-catalog";
import { clubProfiles, type ClubProfile } from "../data/club-profile";
import { leagueOfTeamIn } from "./promotion";

// ── 눈금 ──────────────────────────────────────────────
// 밸런스를 만지려면 이 블록만 읽으면 된다.

/**
 * 세 축의 가중치 — 합은 1. **성적이 아니라 클럽의 크기가 주다** (team.md §2).
 * 성적이 0.20인 것은 의도다: 한 시즌 순위로는 컷을 넘지 못한다.
 */
const AXIS_WEIGHTS = { size: 0.5, squad: 0.3, recent: 0.2 } as const;

/** 규모 축 안에서 구장과 브랜드를 반씩 — 둘 다 클럽의 크기를 재는 자다 */
const SIZE_MIX = { capacity: 0.5, brand: 0.5 } as const;

/** 최근 성적으로 세는 시즌 수 */
const RECENT_SEASONS = 3;

/** 기록도 자료도 없을 때의 값 — 위로도 아래로도 밀지 않는다 */
const NEUTRAL = 0.5;

/**
 * 1부의 컷 — 리그 안 등수의 백분위 (team.md §2.1).
 * 상위 20%가 tier 1, ~40%가 2, ~75%가 3, 나머지가 4.
 */
const TOP_LEAGUE_CUTS: readonly { upTo: number; tier: 1 | 2 | 3 | 4 }[] = [
  { upTo: 0.2, tier: 1 },
  { upTo: 0.4, tier: 2 },
  { upTo: 0.75, tier: 3 },
  { upTo: 1, tier: 4 },
];

/**
 * 2부의 컷 — **1·2가 없다.** 컵 인원인 2부 클럽이 1부 빅클럽과 같은 이적 예산·보드
 * 기대를 받을 자리는 없다 (team.md §2.1).
 */
const SECOND_TIER_CUTS: readonly { upTo: number; tier: 1 | 2 | 3 | 4 }[] = [
  { upTo: 0.3, tier: 3 },
  { upTo: 1, tier: 4 },
];

/**
 * 구단 프로필이 없는 클럽(2부·어드민 추가)의 규모.
 *
 * ⚠️ `clubProfile(teamId, tier)`의 tier 폴백을 쓰지 않는다 — 미등재 클럽은 그 길로
 * **작년 체급이 올해 규모가 되어** 체급이 스스로를 재생산한다. 자료가 없으면
 * 없다고 두고, 미등재 클럽끼리는 규모 축에서 동률로 둔 뒤 스쿼드·성적이 가른다.
 * 진짜 구장을 가진 강등 클럽이 이 값 위로 올라서는 것이 이 축의 일이다.
 */
const UNLISTED_CLUB_SIZE: ClubProfile = {
  stadium: "",
  capacity: 0,
  commercialTier: 4,
};

// ── 축 ────────────────────────────────────────────────

/**
 * 리그 안 백분위 — 같은 값은 같은 백분위를 받는다(중간 순위법).
 * 한 팀짜리 리그도 0으로 나누지 않고 중립(0.5)이 된다.
 */
function percentileIn(values: readonly number[], value: number): number {
  if (values.length === 0) return NEUTRAL;
  let below = 0;
  let equal = 0;
  for (const v of values) {
    if (v < value) below += 1;
    else if (v === value) equal += 1;
  }
  return (below + equal / 2) / values.length;
}

/** 스쿼드 상위 열한 명의 평균 OVR — 전력 축의 자 */
function squadRating(state: GameState, teamId: string): number {
  const squad = playersOf(state, teamId);
  if (squad.length === 0) return 0;
  const top = [...squad].sort((a, b) => b.attributes.overall - a.attributes.overall).slice(0, 11);
  return top.reduce((sum, p) => sum + p.attributes.overall, 0) / top.length;
}

/**
 * 최근 성적 — 최근 세 시즌 리그 순위의 **리그 크기 대비 백분위** 평균 (1위가 1.0,
 * 꼴찌가 0.0). 기록이 없는 클럽(첫 시즌, 리그전을 돌지 않는 2부)은 중립이다.
 *
 * 이 축만은 따로 정규화하지 않는다 — 순위를 리그 크기로 나눈 값이 이미 백분위다.
 */
function recentForm(state: GameState, teamId: string, leagueSizes: Map<string, number>): number {
  const records = state.seasonRecords
    .filter((r) => r.teamId === teamId)
    .sort((a, b) => b.season - a.season)
    .slice(0, RECENT_SEASONS);
  if (records.length === 0) return NEUTRAL;

  const scores = records.map((r) => {
    const leagueId = r.leagueId ?? leagueOfTeamIn(state, teamId);
    const size = leagueSizes.get(leagueId) ?? 0;
    if (size <= 1) return NEUTRAL;
    const fromBottom = (size - r.position) / (size - 1);
    return Math.max(0, Math.min(1, fromBottom));
  });
  return scores.reduce((sum, s) => sum + s, 0) / scores.length;
}

// ── 재산정 ────────────────────────────────────────────

function cutsFor(leagueId: string): readonly { upTo: number; tier: 1 | 2 | 3 | 4 }[] | null {
  if (isTopLeague(leagueId)) return TOP_LEAGUE_CUTS;
  if (isCupOnlyLeague(leagueId)) return SECOND_TIER_CUTS;
  // 이적 시장 전용·무소속은 리그전을 돌지 않는다 — 줄 세울 표가 없다
  return null;
}

function tierAt(fraction: number, cuts: readonly { upTo: number; tier: 1 | 2 | 3 | 4 }[]) {
  return (cuts.find((c) => fraction < c.upTo) ?? cuts[cuts.length - 1]!).tier;
}

/** 이 리그의 클럽들을 점수순으로 — 동점은 teamId 오름차순으로 깬다(결정성) */
function rankLeague(
  state: GameState,
  teamIds: readonly string[],
  leagueSizes: Map<string, number>,
) {
  const profiles = clubProfiles();
  // 세이브가 든 프로필이 먼저다 — 어드민의 수용인원 편집이 진행 중인 세이브의 체급을
  // 다시 매기면 안 된다 (game-state.md §1)
  const sizeOf = (id: string) => savedClubProfile(state, id) ?? profiles[id] ?? UNLISTED_CLUB_SIZE;

  const capacities = teamIds.map((id) => sizeOf(id).capacity);
  // 브랜드는 1등급이 가장 크다 — 부호를 뒤집어 "클수록 크다"로 맞춘다
  const brands = teamIds.map((id) => -sizeOf(id).commercialTier);
  const squads = teamIds.map((id) => squadRating(state, id));

  return teamIds
    .map((teamId, i) => {
      const size =
        SIZE_MIX.capacity * percentileIn(capacities, capacities[i]!) +
        SIZE_MIX.brand * percentileIn(brands, brands[i]!);
      const squad = percentileIn(squads, squads[i]!);
      const recent = recentForm(state, teamId, leagueSizes);
      return {
        teamId,
        score: AXIS_WEIGHTS.size * size + AXIS_WEIGHTS.squad * squad + AXIS_WEIGHTS.recent * recent,
      };
    })
    .sort((a, b) => b.score - a.score || (a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : 0));
}

/**
 * 리그마다 전 클럽을 다시 줄 세워 체급을 매긴다.
 *
 * @returns 유저 팀의 체급이 바뀌었으면 다이제스트 한 줄, 아니면 빈 배열
 */
export function recomputeClubTiers(state: GameState): string[] {
  // 리그별 소속 — 승강 **뒤**에 부르므로 이게 새 리그다
  const byLeague = new Map<string, string[]>();
  for (const team of state.teams) {
    const leagueId = leagueOfTeamIn(state, team.id);
    const bucket = byLeague.get(leagueId);
    if (bucket) bucket.push(team.id);
    else byLeague.set(leagueId, [team.id]);
  }
  const leagueSizes = new Map([...byLeague].map(([id, ids]) => [id, ids.length]));

  const before = tierOfTeamIn(state, state.userTeamId);

  for (const [leagueId, teamIds] of byLeague) {
    const cuts = cutsFor(leagueId);
    if (!cuts) continue; // 시장 전용·무소속은 기존 체급을 그대로 둔다
    const ranked = rankLeague(state, teamIds, leagueSizes);
    ranked.forEach((row, index) => {
      const team = state.teams.find((t) => t.id === row.teamId);
      if (team) team.tier = tierAt(index / ranked.length, cuts);
    });
  }

  const after = tierOfTeamIn(state, state.userTeamId);
  if (after === before) return [];
  return [
    `${teamNameIn(state, state.userTeamId)} 구단 체급 ${before} → ${after} — 보드 기대는 "${
      boardExpectationOfTier(after).label
    }"가 됐다`,
  ];
}
