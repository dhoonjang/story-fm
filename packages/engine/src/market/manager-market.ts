import { topLeagues } from "../data/league-catalog";
import { teamCatalogById } from "../data/team-catalog";
import { leagueOfTeamIn } from "../competition/promotion";
import { inventPersonName } from "../world/persona";
import { makeRng, randInt } from "../core/rng";
import { boardExpectation, computeStandings } from "../competition/season";
import { clampCondition } from "@story-fm/domain";
import { playersOf, pushNarrative, teamName, teamShortName, type GameState } from "../core/state";

/**
 * 감독 시장 — **벤치의 사람도 바뀐다.**
 *
 * 이게 없으면 리그의 감독은 시즌이 끝나도 그대로다. 12월에 6연패를 한 구단이
 * 이듬해 5월까지 같은 벤치로 앉아 있고, 감독이 겪는 세계에서 "라이벌이 감독을
 * 갈아치웠다"는 사건이 아예 일어나지 않는다.
 *
 * 판단은 단순하다 — **기대와 실제의 거리**. 구단 등급이 기대 순위를 정하고
 * (`boardExpectation`), 그보다 한참 아래로 처지면 자리가 흔들린다. 실제 경질도
 * 대개 그 계산이다.
 *
 * ## 감독 팀도 예외가 아니다
 *
 * 다만 **감독은 미리 안다.** AI 구단은 조용히 자르지만 감독에게는 경고가 먼저
 * 온다(보드 평판이 깎이고 브리핑에 줄이 선다). 아무 예고 없이 세이브가 끝나면
 * 그건 사건이 아니라 사고다.
 */

/** 이만큼은 치러야 판단한다 — 개막 직후의 순위는 순위가 아니다 */
const MIN_MATCHES = 8;
/** 부임 직후의 유예 (일) — 새 감독에게 시간을 준다 */
const GRACE_DAYS = 75;
/**
 * 등급별 문턱 — **위험한 순위와 잘리는 순위.**
 *
 * ⚠️ 기대 순위와의 **차이**로만 재면 하위 구단은 영원히 안 잘린다: 잔류가 기대인
 * 팀(tier 4, 목표 17위)은 꼴찌를 해도 차이가 3이다. 실제로도 강등권 팀 감독이
 * 가장 자주 잘리는데 그 반대가 됐다. 그래서 등급마다 자리를 직접 적는다.
 */
const SEAT: Record<number, { danger: number; sack: number }> = {
  1: { danger: 6, sack: 10 },
  2: { danger: 10, sack: 14 },
  3: { danger: 15, sack: 18 },
  4: { danger: 18, sack: 20 },
};

function seatOf(teamId: string): { danger: number; sack: number } {
  return SEAT[teamCatalogById(teamId)?.tier ?? 3]!;
}
/** 하루에 잘리는 감독 수 상한 — 리그가 하루아침에 뒤집히지 않게 */
const SACKINGS_PER_DAY = 2;
/** 문턱에 걸린 구단이 오늘 결단할 확률 — 시즌 96구단 중 30건 안팎이 되게 */
const SACK_CHANCE = 0.09;
/** 새 감독 효과 — 실제로 관측되는 반등(잠깐이지만 분명하다) */
const NEW_MANAGER_BOUNCE = 6;

/** 감독 팀의 경고 단계 — 이 횟수를 넘기면 경질된다 */
export const USER_WARNINGS_BEFORE_SACK = 3;
/**
 * 감독이 잘리는 순위 — **AI보다 훨씬 아래**다.
 *
 * 같은 문턱을 쓰면 우승 경쟁이 기대인 구단에서 10위만 해도 시즌 중에 자리가
 * 없어진다. 그건 규칙이라기보다 사고다 — 아직 **새 구단에 부임하는 길이 없어서**
 * 경질은 곧 세이브의 끝이다. 그래서 감독은 경고를 세 번 받고, 보드 신뢰가 바닥이고,
 * 그러고도 **리그 최하위권(19·20위)**일 때만 잘린다. 라이벌 구단이 12위에서 감독을
 * 바꾸는 것과는 다른 잣대인데, 그 비대칭은 의도한 것이다: 세계는 감독의 이야기를
 * 위해 돈다. (새 구단 부임이 생기면 이 문턱은 AI와 같아져야 한다.)
 */
const USER_SACK_BOTTOM = 19;
/** 감독 팀은 이만큼 치른 뒤에야 판단한다 — AI보다 늦게 본다 (경고를 먼저 주기 때문) */
const USER_MIN_MATCHES = 12;
/** 보드 평판이 이 아래로 내려가야 마지막 단계로 간다 */
const USER_BOARD_FLOOR = 25;

/** 그 팀이 리그에서 몇 위인가 (1부만 — 2부는 리그전이 없다) */
function positionOf(state: GameState, teamId: string): { position: number; played: number } | null {
  const leagueId = leagueOfTeamIn(state, teamId);
  if (!topLeagues().some((l) => l.id === leagueId)) return null;
  const table = computeStandings(state, leagueId);
  const index = table.findIndex((r) => r.teamId === teamId);
  if (index < 0) return null;
  return { position: index + 1, played: table[index]!.played };
}

/** 지금 자리 — 순위와 소화 경기 수 */
function seatStatus(
  state: GameState,
  teamId: string,
): { position: number; played: number } | null {
  return positionOf(state, teamId);
}

/** 부임한 지 얼마나 됐나 — 옛 세이브엔 없어 시즌 시작으로 본다 */
function daysInCharge(state: GameState, teamId: string): number {
  const team = state.teams.find((t) => t.id === teamId);
  const since = team?.managerSince ?? state.calendar.preseasonStart;
  return Math.max(0, Math.round((Date.parse(state.date) - Date.parse(since)) / 86_400_000));
}

/**
 * AI 구단의 경질·선임 — tick이 매일 부른다.
 *
 * 새 감독은 **전술 역량치를 새로 뽑고**(직전보다 조금 높게 나오는 쪽으로 기울인다 —
 * 구단은 더 나은 사람을 데려오려 한다) 선수단에 짧은 반등을 남긴다.
 */
export function runManagerMarket(state: GameState, digest: string[]): void {
  const rng = makeRng(state.seed, `manager-market:${state.date}`);
  let sacked = 0;
  const ourLeague = leagueOfTeamIn(state, state.userTeamId);

  for (const team of state.teams) {
    if (sacked >= SACKINGS_PER_DAY) break;
    if (team.id === state.userTeamId) continue;
    if (daysInCharge(state, team.id) < GRACE_DAYS) continue;
    const standing = seatStatus(state, team.id);
    if (!standing || standing.played < MIN_MATCHES) continue;
    if (standing.position < seatOf(team.id).sack) continue;
    /**
     * 같은 처지라고 다 잘리지는 않는다 — 구단마다 인내가 다르고, 그래야 리그가
     * 한 라운드에 우르르 감독을 바꾸지 않는다.
     */
    if (rng() > SACK_CHANCE) continue;

    const before = team.aiManagerTacticsRating;
    team.aiManagerTacticsRating = Math.min(
      92,
      Math.max(50, before + randInt(rng, -4, 10)),
    );
    team.managerName = inventPersonName(rng, team.id);
    team.managerSince = state.date;
    sacked += 1;

    /**
     * **새 감독 효과** — 실제로 관측되는 짧은 반등이다. 선수단이 다시 뛴다:
     * 폼과 컨디션이 조금 오르고, 그 덕에 다음 몇 경기의 결과가 달라진다.
     */
    for (const player of playersOf(state, team.id)) {
      player.state.condition = clampCondition(player.state.condition + NEW_MANAGER_BOUNCE);
      player.state.form = Math.min(1, player.state.form + 0.1);
    }

    // 우리 리그의 일만 브리핑한다 — 5대 리그 전체를 올리면 소음이다
    if (leagueOfTeamIn(state, team.id) === ourLeague) {
      digest.push(
        `📰 ${teamShortName(team.id)}가 감독을 경질했다 — 후임은 ${team.managerName}`,
      );
      pushNarrative(state, `${teamName(team.id)} 감독 경질`, 3);
    }
  }
}

/**
 * 감독 팀의 자리 — **경고가 먼저, 경질은 나중.**
 *
 * 예고 없이 끝나면 사건이 아니라 사고다. 그래서 기대에 못 미치는 상태가
 * 이어지면 보드가 먼저 말하고(`state.manager.boardWarnings`), 그 뒤에도 나아지지
 * 않으면 자리가 없어진다.
 *
 * @returns 오늘 경질됐으면 true — tick이 시계를 세운다
 */
export function reviewUserSeat(state: GameState, digest: string[]): boolean {
  if (state.dismissal) return true;
  const standing = seatStatus(state, state.userTeamId);
  if (!standing || standing.played < USER_MIN_MATCHES) return false;
  const seat = seatOf(state.userTeamId);
  const manager = state.manager;
  const warnings = manager.boardWarnings ?? 0;

  // 기대 위로 올라섰으면 경고가 하나 지워진다 — 되돌릴 수 있어야 압박이 이야기가 된다
  if (standing.position <= boardExpectation(state.userTeamId).target) {
    if (warnings > 0) {
      manager.boardWarnings = warnings - 1;
      digest.push(`보드가 한숨 돌렸다 — 경고 하나가 지워졌다 (${manager.boardWarnings}/3)`);
    }
    return false;
  }
  if (standing.position < seat.danger) return false;
  // 경고는 **한 달에 한 번까지** — 매일 같은 말을 반복하지 않는다
  if (manager.lastWarnedOn && daysBetween(manager.lastWarnedOn, state.date) < 30) return false;

  const board = manager.reputation.board;
  const next = warnings + 1;
  manager.lastWarnedOn = state.date;

  const sackable = standing.position >= USER_SACK_BOTTOM;
  if (next < USER_WARNINGS_BEFORE_SACK || !sackable || board > USER_BOARD_FLOOR) {
    manager.boardWarnings = next;
    manager.reputation.board = Math.max(0, board - 6);
    const expectation = boardExpectation(state.userTeamId);
    digest.push(
      `⚠️ 보드가 성적을 문제 삼았다 — 기대는 ${expectation.label}인데 현재 ${standing.position}위다` +
        ` (경고 ${next}/${USER_WARNINGS_BEFORE_SACK})`,
    );
    pushNarrative(state, `보드 경고 ${next}회`, 4);
    return false;
  }

  state.dismissal = {
    on: state.date,
    season: state.season,
    teamId: state.userTeamId,
    reason: `기대(${boardExpectation(state.userTeamId).label})에 한참 못 미쳤다`,
  };
  digest.push(`💼 경질 — ${teamName(state.userTeamId)}가 감독 계약을 해지했다`);
  pushNarrative(state, `${teamName(state.userTeamId)} 경질`, 5);
  return true;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/** 그 팀의 현재 감독 이름 — 우리 팀은 감독 본인, AI는 선임된 사람(없으면 null) */
export function managerNameOf(state: GameState, teamId: string): string | null {
  if (teamId === state.userTeamId) return state.manager.name;
  return state.teams.find((t) => t.id === teamId)?.managerName ?? null;
}
