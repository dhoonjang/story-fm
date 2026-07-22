import type {
  Manager,
  ManagerAttributes,
  StrengthPacket,
  TacticsSpec,
  Team,
} from "@story-fm/domain";
import { DEFAULT_TACTICS } from "@story-fm/domain";
import type { MatchLedgerState } from "@story-fm/sim";
import { buildSeasonCalendar, type Fixture, type SeasonCalendar } from "./calendar";
import { generateLeague } from "./generate";
import { TEAM_CATALOG } from "./data/team-catalog";
import { makeRng, randInt } from "./rng";

export interface FinanceState {
  /** £ 단위 간이 재정 (overview §10 — 단순 모델) */
  balance: number;
  weeklyWages: number;
  transferBudget: number;
}

export interface Trophy {
  name: string;
  season: number;
}

export interface Achievement {
  id: string;
  name: string;
  description: string;
  season: number;
}

export interface CareerSeasonRecord {
  season: number;
  teamId: string;
  position: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  boardVerdict: string;
}

export interface CareerState {
  trophies: Trophy[];
  achievements: Achievement[];
  seasons: CareerSeasonRecord[];
}

export interface NarrativeNote {
  date: string;
  text: string;
  salience: number; // 1~5
}

export interface PlayerIssue {
  playerId: string;
  kind: "unhappy";
  note: string;
  since: string;
}

export interface ToolCallRecord {
  name: string;
  summary: string;
}

export interface ChatTurn {
  role: "user" | "model";
  text: string;
  toolCalls: ToolCallRecord[];
  at: string; // 게임 내 날짜
}

export interface TrainingPlan {
  teamFocus: "set_pieces" | "shooting" | "defending" | "passing" | "fitness";
  individual: Array<{ playerId: string; focus: "pace" | "shooting" | "passing" | "dribbling" | "defending" | "physical" }>;
  recovery: string[];
}

export interface PendingMatch {
  fixture: Fixture;
  packet: StrengthPacket;
  ledger: MatchLedgerState;
  /** mock 캐스터용 사전 생성 스크립트 — 정지점 단위 세그먼트 (실모드에선 미사용) */
  script: MatchScriptSegment[] | null;
  scriptCursor: number;
  /** 실모드 캐스터의 대화 이력 (JSON 직렬화 가능해야 함) */
  casterHistory: unknown[];
  /** 이번 경기 출장 정지로 결장 중인 선수 — 종료 시 정지 1경기 차감 */
  servingSuspension: string[];
}

export interface MatchScriptSegment {
  events: import("@story-fm/domain").MatchEvent[];
  /** 세그먼트 끝 정지 이유 — 연출 힌트 */
  stop: "goal" | "half_time" | "full_time" | "incident";
}

export type GamePhase = "idle" | "matchday" | "match";

export interface GameState {
  id: string;
  seed: number;
  createdAt: string;
  season: number;
  date: string;
  calendar: SeasonCalendar;
  teams: Team[];
  userTeamId: string;
  manager: Manager;
  managerXP: Record<keyof ManagerAttributes, number>;
  captainId: string | null;
  tactics: Record<string, TacticsSpec>;
  /** 상대 AI 감독의 전술 수치 — 패킷 소화율 입력 */
  aiManagerTactics: Record<string, number>;
  training: TrainingPlan;
  playerXP: Record<string, Partial<Record<string, number>>>;
  /** 부상 잔여 일수 */
  injuryDays: Record<string, number>;
  /** 시즌 누적 경고 — 5회당 1경기 출장 정지 (game-loop §5) */
  seasonYellows: Record<string, number>;
  /** 출장 정지 잔여 경기 수 */
  suspensions: Record<string, number>;
  issues: PlayerIssue[];
  finance: FinanceState;
  seasonStats: Record<string, { goals: number; apps: number }>;
  narrative: NarrativeNote[];
  chat: ChatTurn[];
  career: CareerState;
  phase: GamePhase;
  pendingMatch: PendingMatch | null;
}

export function teamById(state: GameState, id: string): Team {
  const team = state.teams.find((t) => t.id === id);
  if (!team) throw new Error(`팀 없음: ${id}`);
  return team;
}

export function userTeam(state: GameState): Team {
  return teamById(state, state.userTeamId);
}

export function playerById(team: Team, id: string) {
  return team.players.find((p) => p.id === id) ?? null;
}

export function findPlayerByName(team: Team, nameFragment: string) {
  return (
    team.players.find((p) => p.name.includes(nameFragment) || p.id.includes(nameFragment)) ?? null
  );
}

export interface CreateGameInput {
  seed?: number;
  userTeamId: string;
  managerName: string;
  background: string;
  attributes: ManagerAttributes;
}

export function createGame(input: CreateGameInput): GameState {
  const seed = input.seed ?? randInt(makeRng(Date.now() % 2 ** 31, "seed"), 1, 2 ** 30);
  const teams = generateLeague(seed);
  if (!TEAM_CATALOG.some((t) => t.id === input.userTeamId)) {
    throw new Error(`알 수 없는 팀: ${input.userTeamId}`);
  }
  const calendar = buildSeasonCalendar(1, teams.map((t) => t.id));
  const rng = makeRng(seed, "ai-managers");

  const tactics: Record<string, TacticsSpec> = {};
  const aiManagerTactics: Record<string, number> = {};
  for (const team of teams) {
    tactics[team.id] = { ...DEFAULT_TACTICS, playerInstructions: [] };
    aiManagerTactics[team.id] = randInt(rng, 55, 82);
  }

  const userSquad = teams.find((t) => t.id === input.userTeamId);
  // id는 시드와 독립적으로 유일해야 한다 — 같은 시드 재사용 시 세이브 덮어쓰기 방지
  const uniqueSuffix = Math.random().toString(36).slice(2, 8);
  return {
    id: `game-${seed.toString(36)}-${uniqueSuffix}`,
    seed,
    createdAt: new Date().toISOString(),
    season: 1,
    // 시즌 시작 1주 전 — 첫 advance로 개막을 맞는다 (프리시즌 생략, game-loop §2)
    date: "2026-08-08",
    calendar,
    teams,
    userTeamId: input.userTeamId,
    manager: {
      name: input.managerName,
      background: input.background,
      attributes: input.attributes,
      reputation: { board: 50, media: 50, squad: 50 },
    },
    managerXP: { leadership: 0, tactics: 0, negotiation: 0, media: 0 },
    captainId: userSquad?.startingXI[3] ?? null,
    tactics,
    aiManagerTactics,
    training: { teamFocus: "passing", individual: [], recovery: [] },
    playerXP: {},
    injuryDays: {},
    seasonYellows: {},
    suspensions: {},
    issues: [],
    finance: { balance: 40_000_000, weeklyWages: 2_200_000, transferBudget: 30_000_000 },
    seasonStats: {},
    narrative: [],
    chat: [],
    career: { trophies: [], achievements: [], seasons: [] },
    phase: "idle",
    pendingMatch: null,
  };
}

export function pushNarrative(state: GameState, text: string, salience = 2): void {
  state.narrative.push({ date: state.date, text, salience });
  if (state.narrative.length > 200) state.narrative.splice(0, state.narrative.length - 200);
}
