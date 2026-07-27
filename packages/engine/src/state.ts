import type {
  Achievement,
  Booking,
  Contract,
  GamePlayer,
  GameTeam,
  GrowthEntry,
  Injury,
  Manager,
  ManagerAttributes,
  MatchRecord,
  NarrativeNote,
  PlayerIssue,
  PositionGroup,
  ScheduleEntry,
  Negotiation,
  ScoutReport,
  SeasonRecord,
  SeasonStat,
  StrengthPacket,
  Suspension,
  TacticAssignment,
  TeamFinance,
  TeamTactics,
  TrainingSession,
  Transfer,
  TransferWindow,
  Trophy,
} from "@story-fm/domain";
import {
  DEFAULT_TACTICS,
  FORMATION_SLOTS,
  naturalPositionOf,
  positionGroupOf,
  positionGroupOfPlayer,
  sameCluster,
} from "@story-fm/domain";
import type { MatchLedgerState } from "@story-fm/sim";
import {
  buildScheduleEntries,
  buildSeasonCalendar,
  buildTransferWindows,
  type SeasonCalendar,
} from "./calendar";
import { overallFor, playerCatalog } from "./catalog";
import { TEAM_CATALOG, teamCatalogById } from "./data/team-catalog";
import { buildEuroEntrants, type EuroEntry } from "./europe";
import { buildSeasonFixtures, isUserFixture } from "./fixtures";
import { makeRng, randInt } from "./rng";

/** 채팅 턴 — 도구 호출 기록 포함 (UI가 스킬 칩으로 렌더) */
export interface ToolCallRecord {
  name: string;
  summary: string;
  input?: unknown;
}
export interface ChatTurn {
  role: "user" | "model";
  text: string;
  toolCalls: ToolCallRecord[];
  at: string;
}

export interface PendingMatch {
  matchId: string;
  packet: StrengthPacket;
  ledger: MatchLedgerState;
  /** mock 캐스터용 사전 생성 스크립트 (실모드에선 미사용) */
  script: MatchScriptSegment[] | null;
  scriptCursor: number;
  /** 실모드 캐스터의 대화 이력 (JSON 직렬화 가능해야 함) */
  casterHistory: unknown[];
  /** 이번 경기 정지 소화 중인 선수 — 종료 시 served +1 */
  servingSuspension: string[];
}

export interface MatchScriptSegment {
  events: import("@story-fm/domain").MatchEvent[];
  stop: "goal" | "half_time" | "full_time" | "incident";
}

export type GamePhase = "idle" | "matchday" | "match";

/**
 * 게임 세이브 (v6) — 정규화된 테이블 집합.
 * 카탈로그(불변 초기치)는 코드에 있고, 여기엔 게임 중 변화하는 것만 담는다.
 * 선수 부속(부상·징계·계약·이적·성장·시즌기록)은 gamePlayerId로 참조하는 별도 배열.
 */
export interface GameState {
  id: string;
  seed: number;
  createdAt: string;
  season: number;
  /** 현재 날짜 — 게임 시작은 7월 1일 (프리시즌·여름 이적창 개장) */
  date: string;
  calendar: SeasonCalendar;
  userTeamId: string;
  phase: GamePhase;
  pendingMatch: PendingMatch | null;

  // ── 팀·선수 ──
  teams: GameTeam[];
  players: GamePlayer[];
  tactics: TeamTactics[];
  finances: TeamFinance[];
  contracts: Contract[];

  // ── 일정 ──
  schedule: ScheduleEntry[];
  matches: MatchRecord[];
  trainingSessions: TrainingSession[];
  windows: TransferWindow[];

  // ── 대회 ──
  /**
   * 이번 시즌 대항전 참가 팀 — **추첨은 이미 일어난 사실**이라 세이브에 남는다.
   * 첫 시즌은 구단 등급으로, 이후는 지난 시즌 리그 최종 순위로 배정된다
   * (`buildEuroEntrants`). 파생으로 되돌릴 수 없는 값이므로 저장한다.
   */
  euroEntrants: EuroEntry[];

  // ── 기록 ──
  injuries: Injury[];
  bookings: Booking[];
  suspensions: Suspension[];
  transfers: Transfer[];
  growthLog: GrowthEntry[];
  seasonStats: SeasonStat[];
  issues: PlayerIssue[];
  /** 스카우트 파견·완료 이력 — 타 팀 선수 안개의 근거 (scouting.ts) */
  scoutReports: ScoutReport[];
  /** 진행 중 협상 — 며칠에 걸쳐 오퍼가 오가므로 파생으로 되돌릴 수 없다 */
  negotiations: Negotiation[];

  // ── 감독 ──
  manager: Manager;
  managerXP: Record<keyof ManagerAttributes, number>;
  seasonRecords: SeasonRecord[];
  trophies: Trophy[];
  achievements: Achievement[];

  // ── 서사 ──
  narrative: NarrativeNote[];
  chat: ChatTurn[];
}

// ── 팀·선수 조회 ────────────────────────────────────────

export function teamById(state: GameState, id: string): GameTeam {
  const team = state.teams.find((t) => t.id === id);
  if (!team) throw new Error(`팀 없음: ${id}`);
  return team;
}

export function userTeam(state: GameState): GameTeam {
  return teamById(state, state.userTeamId);
}

/** 팀 표시 이름 — 카탈로그에서 (게임 팀 엔티티는 이름을 갖지 않는다) */
export function teamName(teamId: string): string {
  return teamCatalogById(teamId)?.name ?? teamId;
}
export function teamShortName(teamId: string): string {
  return teamCatalogById(teamId)?.shortName ?? teamId;
}

export function playersOf(state: GameState, teamId: string): GamePlayer[] {
  return state.players.filter((p) => p.teamId === teamId);
}

export function userPlayers(state: GameState): GamePlayer[] {
  return playersOf(state, state.userTeamId);
}

export function playerById(state: GameState, id: string): GamePlayer | null {
  return state.players.find((p) => p.id === id) ?? null;
}

export function userPlayerById(state: GameState, id: string): GamePlayer | null {
  const p = playerById(state, id);
  return p && p.teamId === state.userTeamId ? p : null;
}

export function findPlayerByName(state: GameState, fragment: string): GamePlayer | null {
  return (
    state.players.find((p) => p.name.includes(fragment) || p.id.includes(fragment)) ?? null
  );
}

export function playerName(state: GameState, id: string): string {
  return playerById(state, id)?.name ?? id;
}

export function groupOf(player: GamePlayer): PositionGroup {
  return positionGroupOfPlayer(player);
}

/** 능력치 변경 후 overall 재계산 — 주 포지션 그룹 공식 */
export function recomputeOverall(player: GamePlayer): void {
  player.attributes.overall = overallFor(groupOf(player), player.attributes);
  if (player.attributes.potential < player.attributes.overall) {
    player.attributes.potential = player.attributes.overall;
  }
}

// ── 전술·배치 ───────────────────────────────────────────

export function tacticsOf(state: GameState, teamId: string): TeamTactics {
  const t = state.tactics.find((x) => x.teamId === teamId);
  if (!t) throw new Error(`전술 없음: ${teamId}`);
  return t;
}

export function userTactics(state: GameState): TeamTactics {
  return tacticsOf(state, state.userTeamId);
}

export function assignmentsOf(state: GameState, teamId: string, role?: TacticAssignment["role"]) {
  const list = tacticsOf(state, teamId).assignments;
  return role ? list.filter((a) => a.role === role) : list;
}

export function assignmentFor(state: GameState, playerId: string): TacticAssignment | null {
  const p = playerById(state, playerId);
  if (!p) return null;
  return tacticsOf(state, p.teamId).assignments.find((a) => a.playerId === playerId) ?? null;
}

/** 이 선수의 전술 적응도 — 배치가 없으면 기준선 */
export const FAMILIARITY_BASELINE = 60;
export function familiarityOf(state: GameState, playerId: string): number {
  return assignmentFor(state, playerId)?.familiarity ?? FAMILIARITY_BASELINE;
}

/** 팀 평균 전술 적응도 (선발 기준) — 전력 패킷 입력 */
export function squadFamiliarity(state: GameState, teamId: string): number {
  const starters = assignmentsOf(state, teamId, "starting");
  if (starters.length === 0) return FAMILIARITY_BASELINE;
  return starters.reduce((s, a) => s + a.familiarity, 0) / starters.length;
}

/** 이 선수가 그 포지션에서 갖는 적응도 (없으면 그룹 인접도 기반 추정) */
export function proficiencyAt(player: GamePlayer, position: string): number {
  const code = position.toUpperCase();
  const exact = player.positions.find((p) => p.position === code);
  if (exact) return exact.proficiency;
  // 사실상 같은 자리(CB↔RCB/LCB 등)는 가진 적응도에서 살짝만 깎는다 — 좌우 분화는
  // 자리가 달라진 게 아니다. 목록에 묶음이 다 없는 선수(어드민 추가 등)를 위한 폴백.
  const cluster = player.positions.filter((p) => sameCluster(p.position, code));
  if (cluster.length > 0) {
    return Math.max(...cluster.map((p) => p.proficiency)) - 2;
  }
  const targetGroup = positionGroupOf(position);
  const natural = naturalPositionOf(player);
  const sameGroup = positionGroupOf(natural.position) === targetGroup;
  return sameGroup ? 55 : 35; // 같은 라인이면 어느 정도, 완전 생소하면 낮게
}

// ── 부상·징계·계약 ──────────────────────────────────────

export function openInjury(state: GameState, playerId: string): Injury | null {
  return (
    state.injuries.find((i) => i.gamePlayerId === playerId && i.returnedOn === null) ?? null
  );
}

export function isInjured(state: GameState, playerId: string): boolean {
  return openInjury(state, playerId) !== null;
}

export function activeSuspension(state: GameState, playerId: string): Suspension | null {
  return (
    state.suspensions.find((s) => s.gamePlayerId === playerId && s.status === "active") ?? null
  );
}

export function isSuspended(state: GameState, playerId: string): boolean {
  return activeSuspension(state, playerId) !== null;
}

/** 경기에 나설 수 있는가 — 부상·정지 없음 */
export function isAvailable(state: GameState, playerId: string): boolean {
  return !isInjured(state, playerId) && !isSuspended(state, playerId);
}

export function activeContract(state: GameState, playerId: string): Contract | null {
  return (
    state.contracts.find((c) => c.gamePlayerId === playerId && c.status === "active") ?? null
  );
}

/** 팀 주급 총액 — 활성 계약의 합 (저장하지 않는 파생값) */
export function weeklyWagesOf(state: GameState, teamId: string): number {
  return state.contracts
    .filter((c) => c.status === "active" && c.teamId === teamId)
    .reduce((s, c) => s + c.weeklyWage, 0);
}

/** 시즌 누적 경고 — BOOKING에서 파생 */
export function seasonYellowsOf(state: GameState, playerId: string, season: number): number {
  return state.bookings.filter(
    (b) => b.gamePlayerId === playerId && b.season === season && b.card === "yellow",
  ).length;
}

export function financeOf(state: GameState, teamId: string): TeamFinance {
  const f = state.finances.find((x) => x.teamId === teamId);
  if (!f) throw new Error(`재정 없음: ${teamId}`);
  return f;
}

export function userFinance(state: GameState): TeamFinance {
  return financeOf(state, state.userTeamId);
}

/** 한 경기의 피로 누적 — 유저 팀·AI 팀 모두 같은 값을 쓴다 (회복은 하루 8~14) */
export const MATCH_FATIGUE = 34;

export function recordFinance(
  state: GameState,
  teamId: string,
  kind: "income" | "expense",
  label: string,
  amount: number,
): void {
  const f = financeOf(state, teamId);
  const value = Math.max(0, Math.round(amount));
  f.ledger.push({ date: state.date, kind, label, amount: value });
  f.balance += kind === "income" ? value : -value;
  if (f.ledger.length > 600) f.ledger.splice(0, f.ledger.length - 600);
}

export function seasonStatOf(
  state: GameState,
  playerId: string,
  season = state.season,
): SeasonStat | null {
  const p = playerById(state, playerId);
  if (!p) return null;
  return (
    state.seasonStats.find(
      (s) => s.gamePlayerId === playerId && s.season === season && s.teamId === p.teamId,
    ) ?? null
  );
}

/** 시즌·팀 단위 스탯 확보 (없으면 생성) — 시즌 중 이적하면 팀별로 분리된다 */
export function ensureSeasonStat(state: GameState, playerId: string, teamId: string): SeasonStat {
  let stat = state.seasonStats.find(
    (s) => s.gamePlayerId === playerId && s.season === state.season && s.teamId === teamId,
  );
  if (!stat) {
    stat = { gamePlayerId: playerId, season: state.season, teamId, apps: 0, goals: 0 };
    state.seasonStats.push(stat);
  }
  return stat;
}

// ── 성장·서사 ───────────────────────────────────────────

export function recordGrowth(
  state: GameState,
  playerId: string,
  entryId: string | null,
  source: GrowthEntry["source"],
  target: string,
  delta: number,
  note?: string,
): void {
  state.growthLog.push({
    gamePlayerId: playerId,
    entryId,
    date: state.date,
    source,
    target,
    delta,
    ...(note ? { note } : {}),
  });
  if (state.growthLog.length > 4000) state.growthLog.splice(0, state.growthLog.length - 4000);
}

/** 마지막 성장 이후 누적 세션 수 — trainXP 대체 (로그에서 파생) */
export function sessionsSinceGrowth(
  state: GameState,
  playerId: string,
  target: string,
  sinceDate: string,
): number {
  const last = [...state.growthLog]
    .reverse()
    .find((g) => g.gamePlayerId === playerId && g.target === target);
  const from = last ? last.date : sinceDate;
  return state.schedule.filter(
    (e) => e.type === "training" && e.status === "done" && e.date > from,
  ).length;
}

export function pushNarrative(state: GameState, text: string, salience = 2): void {
  state.narrative.push({ date: state.date, text, salience });
  if (state.narrative.length > 200) state.narrative.splice(0, state.narrative.length - 200);
}

/** 서사 텍스트의 선수 id를 이름으로 치환 — LLM 출력이 id를 흘릴 때 대비 */
export function humanizePlayerIds(state: GameState, text: string): string {
  let out = text;
  for (const p of state.players) {
    if (out.includes(p.id)) out = out.split(p.id).join(p.name);
  }
  return out;
}

// ── 게임 생성 ───────────────────────────────────────────

export interface CreateGameInput {
  seed?: number;
  userTeamId: string;
  managerName: string;
  background: string;
  attributes: ManagerAttributes;
}

/** OVR → 주급 어림 (£/주) — 계약 생성 시 사용. 스타는 기하급수적으로 비싸다 */
export function wageForOverall(overall: number): number {
  const base = Math.pow(Math.max(40, overall) / 40, 4.2) * 6_000;
  return Math.round(base / 1000) * 1000;
}

/** 팀 tier → 시작 잔고·이적 예산 */
const TIER_FINANCE: Record<number, { balance: number; budget: number }> = {
  1: { balance: 120_000_000, budget: 90_000_000 },
  2: { balance: 70_000_000, budget: 45_000_000 },
  3: { balance: 40_000_000, budget: 22_000_000 },
  4: { balance: 25_000_000, budget: 12_000_000 },
};

/**
 * 카탈로그 → 게임 선수 인스턴스화. 새 게임에서만 호출된다.
 * 카탈로그는 불변이므로 깊은 복사로 만들고 catalogId로 출처를 링크한다.
 */
function instantiatePlayers(seed: number): GamePlayer[] {
  const players: GamePlayer[] = [];
  for (const entry of playerCatalog()) {
    const rng = makeRng(seed, `inst:${entry.id}`);
    const player: GamePlayer = {
      id: entry.id,
      catalogId: entry.id,
      teamId: entry.teamId,
      name: entry.nameKo,
      birthdate: entry.birthdate,
      positions: entry.positions.map((p) => ({ ...p })),
      attributes: {
        pace: entry.pace,
        shooting: entry.shooting,
        passing: entry.passing,
        dribbling: entry.dribbling,
        defending: entry.defending,
        physical: entry.physical,
        goalkeeping: entry.goalkeeping,
        overall: 50,
        potential: entry.potential,
      },
      state: {
        form: randInt(rng, -1, 1),
        morale: randInt(rng, 55, 72),
        fatigue: randInt(rng, 0, 12), // 프리시즌 시작 — 피로 낮음
      },
      isCaptain: false,
    };
    recomputeOverall(player);
    players.push(player);
  }
  return players;
}

/** 포메이션 슬롯에 맞춰 선발 11 + 벤치 9 배치를 만든다 (적합도 우선) */
export function buildAssignments(
  squad: GamePlayer[],
  formation: keyof typeof FORMATION_SLOTS,
  familiarity: number,
  available: (id: string) => boolean = () => true,
): TacticAssignment[] {
  const slots = FORMATION_SLOTS[formation];
  const used = new Set<string>();
  const assignments: TacticAssignment[] = [];
  const pool = squad.filter((p) => available(p.id));

  for (const slot of slots) {
    const group = positionGroupOf(slot);
    // 슬롯 적합도: 정확 포지션 적응도 + OVR, 그룹 불일치는 큰 감점
    const best = pool
      .filter((p) => !used.has(p.id))
      .map((p) => {
        const prof = proficiencyAt(p, slot);
        const sameGroup = groupOf(p) === group;
        const gkPenalty = slot === "GK" && groupOf(p) !== "GK" ? -400 : 0;
        const nonGkPenalty = slot !== "GK" && groupOf(p) === "GK" ? -400 : 0;
        return {
          p,
          score: prof * 1.2 + p.attributes.overall + (sameGroup ? 40 : 0) + gkPenalty + nonGkPenalty,
        };
      })
      .sort((a, b) => b.score - a.score)[0];
    if (!best) continue;
    used.add(best.p.id);
    assignments.push({
      playerId: best.p.id,
      role: "starting",
      position: slot,
      familiarity,
    });
  }

  // 벤치 9 — GK 1명 포함 우선, 나머지는 OVR 상위
  const rest = pool.filter((p) => !used.has(p.id)).sort((a, b) => b.attributes.overall - a.attributes.overall);
  const benchGk = rest.find((p) => groupOf(p) === "GK");
  const bench: GamePlayer[] = [];
  if (benchGk) bench.push(benchGk);
  for (const p of rest) {
    if (bench.length >= MATCHDAY_BENCH) break;
    if (bench.some((b) => b.id === p.id)) continue;
    bench.push(p);
  }
  for (const p of bench) {
    assignments.push({
      playerId: p.id,
      role: "bench",
      position: naturalPositionOf(p).position,
      familiarity,
    });
  }
  return assignments;
}

/** 매치데이 벤치 규모 */
export const MATCHDAY_BENCH = 9;

export function createGame(input: CreateGameInput): GameState {
  const seed = input.seed ?? randInt(makeRng(Date.now() % 2 ** 31, "seed"), 1, 2 ** 30);
  if (!TEAM_CATALOG.some((t) => t.id === input.userTeamId)) {
    throw new Error(`알 수 없는 팀: ${input.userTeamId}`);
  }
  const season = 1;
  const calendar = buildSeasonCalendar(season);
  const rng = makeRng(seed, "ai-managers");

  const teams: GameTeam[] = TEAM_CATALOG.map((t) => ({
    id: t.id,
    aiManagerTacticsRating: randInt(rng, 55, 82),
  }));
  const players = instantiatePlayers(seed);

  // 전술·배치 — 팀마다 기본 전술로 시작
  const tactics: TeamTactics[] = teams.map((t) => ({
    teamId: t.id,
    spec: { ...DEFAULT_TACTICS },
    assignments: buildAssignments(
      players.filter((p) => p.teamId === t.id),
      DEFAULT_TACTICS.formation,
      FAMILIARITY_BASELINE,
    ),
  }));

  // 주장 — 유저 팀은 선발 중 최고 OVR 필드 플레이어
  const userSquad = players.filter((p) => p.teamId === input.userTeamId);
  const captain = [...userSquad]
    .filter((p) => groupOf(p) !== "GK")
    .sort((a, b) => b.attributes.overall - a.attributes.overall)[0];
  if (captain) captain.isCaptain = true;

  // 재정 + 계약(주급의 원본)
  const finances: TeamFinance[] = TEAM_CATALOG.map((t) => {
    const f = TIER_FINANCE[t.tier] ?? TIER_FINANCE[3]!;
    return { teamId: t.id, balance: f.balance, transferBudget: f.budget, ledger: [] };
  });
  const contracts: Contract[] = players.map((p, i) => ({
    id: `c-${p.id}`,
    gamePlayerId: p.id,
    teamId: p.teamId,
    weeklyWage: wageForOverall(p.attributes.overall),
    since: calendar.preseasonStart,
    // 계약 만료를 1~4년 뒤로 분산 (재계약 서사의 씨앗)
    until: `${2026 + (1 + (i % 4))}-06-30`,
    status: "active",
  }));

  // 일정 — 전 리그 + 유럽 대항전 경기 + 이적창 개장/폐장
  const windows = buildTransferWindows(season);
  // 다른 리그도 같은 캘린더 골격으로 동시에 진행된다
  const euroEntrants = buildEuroEntrants(season, seed);
  const matches = buildSeasonFixtures(season, seed, euroEntrants);
  // 일정 축(SCHEDULE_ENTRY)은 **감독의 달력**이다 — 유저 리그 전체 + 유저 팀
  // 대항전 경기만 등록한다. 타 리그·타 팀 대항전은 state.matches에만 있고
  // tick이 간이 시뮬로 소화한다.
  const schedule = buildScheduleEntries(
    matches.filter((m) => isUserFixture(m, input.userTeamId)),
    windows,
    input.userTeamId,
  );
  // 게임은 여름 창이 열린 7/1에 시작한다 — 그 개장 엔트리는 이미 소화된 상태
  for (const entry of schedule) {
    if (entry.type === "window-open" && entry.date === calendar.preseasonStart) {
      entry.status = "done";
    }
  }

  const uniqueSuffix = Math.random().toString(36).slice(2, 8);
  return {
    id: `game-${seed.toString(36)}-${uniqueSuffix}`,
    seed,
    createdAt: new Date().toISOString(),
    season,
    // 게임 시작 = 7월 1일, 여름 이적창 개장과 동시 (프리시즌)
    date: calendar.preseasonStart,
    calendar,
    userTeamId: input.userTeamId,
    phase: "idle",
    pendingMatch: null,

    teams,
    players,
    tactics,
    finances,
    contracts,

    schedule,
    matches,
    trainingSessions: [],
    windows,

    euroEntrants,

    injuries: [],
    bookings: [],
    suspensions: [],
    transfers: [],
    growthLog: [],
    seasonStats: [],
    issues: [],
    scoutReports: [],
    negotiations: [],

    manager: {
      name: input.managerName,
      background: input.background,
      attributes: input.attributes,
      reputation: { board: 50, media: 50, squad: 50 },
    },
    managerXP: { leadership: 0, tactics: 0, negotiation: 0, media: 0 },
    seasonRecords: [],
    trophies: [],
    achievements: [],

    narrative: [],
    chat: [],
  };
}
