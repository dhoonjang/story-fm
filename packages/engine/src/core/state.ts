import type {
  Achievement,
  AxisValues,
  Booking,
  Contract,
  FinanceReport,
  Formation,
  GamePlayer,
  GameTeam,
  GrowthEntry,
  Injury,
  Manager,
  ManagerAttributes,
  MatchRecord,
  NarrativeNote,
  Persona,
  PlayerIssue,
  SettlingEvent,
  TransferListing,
  PlayerTraining,
  PositionGroup,
  RoleMemory,
  ScheduleEntry,
  Negotiation,
  PressConference,
  ScoutReport,
  ScoutReportCard,
  SeasonRecord,
  SeasonStat,
  StrengthPacket,
  Suspension,
  TacticAssignment,
  TeamFinance,
  RegistrablePlayer,
  TeamTactics,
  TrainingSession,
  Transfer,
  TransferWindow,
  Trophy,
} from "@story-fm/domain";
import {
  ATTRIBUTE_AXES,
  DEFAULT_FORMATION,
  FORMATIONS,
  MATCHDAY_SQUAD,
  canRegister,
  isUnder21,
  FORMATION_LAYOUTS,
  FORMATION_SLOTS,
  naturalPositionOf,
  positionGroupOf,
  positionGroupOfPlayer,
  positionProficiency,
  weightSlotOf,
  roleFit,
} from "@story-fm/domain";
import { profFactor, type MatchLedgerState } from "@story-fm/sim";
import type { AiDeal } from "../market/ai-market";
import {
  buildScheduleEntries,
  buildSeasonCalendar,
  buildTransferWindows,
  seasonYear,
  type SeasonCalendar,
} from "../competition/calendar";
import { rankByName } from "./name-match";
import { defaultXiIds, overallFor, playerCatalog } from "../world/catalog";
import { estimateSquadWages, wageSubjectOf } from "../world/wages";
import { clubEconomyLevel } from "../data/league-economy";
import { generateYouthPlayer } from "../world/generate";
import { ensureSquadNumbers } from "../squad/numbers";
import { hasCups, scopedTeams, type WorldScope } from "../world/scope";
import {
  teamCatalog,
  type TeamCatalogEntry,
  countryOfTeam,
  formationOf,
  isTopFlight,
  tacticalStyleOf,
  teamCatalogById,
  isClubTeam,
} from "../data/team-catalog";
// 순환 참조로 보이지만 안전하다 — domestic-cup은 state의 함수를 **런타임에만** 부르고,
// 여기서도 모듈 로드가 끝난 뒤(createGame 호출 시점)에만 부른다.
import { advanceDomesticCups } from "../competition/domestic-cup";
import { buildEuroEntrants, type EuroEntry } from "../competition/europe";
import { buildSeasonFixtures, isUserFixture } from "../competition/fixtures";
import { seedInjuryHistory } from "../squad/injury";
import { generateHeadCoach, generateOwner, generateReporters } from "../world/persona";
import { makeRng, randInt } from "./rng";
// domestic-cup과 같은 이유로 안전하다 — training-plan은 state를 **타입으로만** 읽는다
import { installDefaultTraining } from "../squad/training-plan";

/** 채팅 턴 — 도구 호출 기록 포함 (UI가 스킬 칩으로 렌더) */
/** 감독이 화면에서 직접 바꾼 것 한 줄 — GM이 읽고 나면 사라진다 */
export interface PendingEdit {
  /** 접기 키 — 같은 키의 조작은 마지막 것만 남는다 (`role:p-123`, `lineup`) */
  key: string;
  text: string;
  at: string;
}

export interface ToolCallRecord {
  name: string;
  summary: string;
  input?: unknown;
  /**
   * 그 스킬이 남긴 **구조화된 결과** — 채팅이 카드로 그린다.
   *
   * `summary`(줄글)만으로는 화면이 표를 못 그린다. 그렇다고 문자열을 파싱하면
   * 문구가 바뀔 때마다 조용히 깨진다. 카드를 그리는 스킬만 채우고, 없으면 UI는
   * 지금처럼 칩 + 요약으로 폴백한다. 옛 세이브엔 없다(optional).
   */
  payload?: unknown;
  /**
   * 이 결과의 **결이 좋은가** — 대화형 스킬(면담·팀토크·기자회견)의 칩 색.
   *
   * 펼쳐 보지 않아도 잘 풀렸는지는 알아야 하지만, 사기 ±N을 카드로 박으면
   * "말했더니 숫자가 올랐다"가 화면에 남아 대화의 결이 깨진다. 색 하나가 그
   * 사이의 답이다.
   */
  tone?: "good" | "bad";
  /**
   * **화면에 칩으로 세우지 않는다** — 스킬 호출이 아니라 코어가 한 일의 기록.
   *
   * 시계 이동(장면 헤더가 민다)처럼 감독이 부른 적 없는 것이 칩으로 뜨면
   * 어드민 스킬 목록에 없는 스킬이 호출된 것처럼 읽힌다. 기록 자체는 남긴다 —
   * 무슨 일이 있었는지의 감사 흔적이고 그 안에 다이제스트가 들어 있다.
   *
   * 이름으로 거르지 않는 이유는 문자열이 바뀌면 조용히 깨지기 때문이다.
   */
  silent?: boolean;
  /**
   * **장면의 어디에서 불렸나** — 이 호출 직전까지 쓰인 본문 줄 수(헤더 포함).
   *
   * 스킬은 대화 한복판에서 불린다. 그 자리를 모르면 화면은 모든 칩을 턴 맨 앞에
   * 몰아 세우고, 감독은 결과를 먼저 본 뒤 장면을 거꾸로 읽는다 — 한 턴에 여러
   * 스킬이 걸린 장면에서는 어느 대사가 어느 지시였는지도 흐려진다.
   *
   * 줄 수로 세는 이유는 **본문이 저장 전에 손질되기 때문**이다(선수 id → 이름).
   * 글자 수는 그 손질에 밀리지만 줄은 그대로다. 코어가 스스로 밀어 넣은 기록
   * (시계 이동·경기 마감)에는 자리가 없다 — 모델이 쓴 문장과 짝이 없으므로.
   * 옛 세이브에도 없다(optional) — 없으면 화면은 지금까지처럼 맨 앞에 세운다.
   */
  line?: number;
}
export interface ChatTurn {
  /**
   * 누가 한 말인가.
   *
   * - `user` — **감독이 직접 친 말.** 모델에는 `@감독이름: …` 발화로 들어간다.
   * - `model` — GM이 쓴 장면.
   * - `operator` — **감독이 아니라 화면을 조작한 것** (시간 이동 손잡이 등).
   *   채팅에 그리지 않고, 모델 이력에도 **감독의 대사가 아니라 오퍼레이터 지시**로
   *   들어간다. 이 구분이 데이터에 없으면 `@감독: 하루만 넘기자`가 이력에 쌓여
   *   GM이 감독의 말투·의도를 그 문장에서 읽는다 — 감독은 그런 말을 한 적이 없다.
   *   지우지 않고 남기는 이유는 따로 있다: 없애면 GM이 왜 갑자기 사흘이 지났는지
   *   모른 채 다음 장면을 쓴다.
   *
   * 구 세이브에는 `operator`가 없다 — 값이 늘어난 것뿐이라 로드에 영향이 없다.
   */
  role: "user" | "model" | "operator";
  text: string;
  toolCalls: ToolCallRecord[];
  at: string;
  /**
   * 이 턴에 들어간 골 — **장부의 사건**이지 중계 문장에서 읽어낸 것이 아니다.
   *
   * 골은 판을 뒤집는 유일한 사건인데 중계 문단 한복판에 문장으로만 남으면
   * 스크롤에 묻힌다. 화면이 카드로 세울 수 있게 턴에 함께 남긴다.
   * 옛 세이브에는 없다 — optional이라 세이브 버전을 올리지 않는다.
   */
  goals?: GoalMark[];
  /** 이 턴에 나온 경고·퇴장 — 골과 같은 자리에 선다 */
  cards?: CardMark[];
  /**
   * 이 턴에 도착한 **스카우팅 보고서** — 채팅이 카드로 편다.
   *
   * 스카우트 완료는 스킬 호출이 아니라 tick의 사건이라, 예전엔 다이제스트 한 줄에
   * 묻혀 화면에 아예 뜨지 않았다. 며칠을 기다려 얻은 정보인데 보러 가려면 선수
   * 검색을 다시 해야 했다.
   */
  reports?: ScoutReportCard[];
  /**
   * **경기 중에 오간 말인가** — 이력에서 중계와 평시를 가르는 표식.
   *
   * 평시의 GM과 경기의 중계는 다른 에이전트이고 감독이 거는 말도 다르다(훈련·이적
   * 지시 vs 교체·팀토크). 지나고 나서 대화를 거슬러 읽을 때 그 경계가 없으면
   * 한 시즌치 이력이 한 덩어리로 흐른다.
   *
   * 화면에서 파생할 수도 있지만(그 턴에 `@중계:` 화자가 있는가) 그러면 킥오프
   * 직전 라인업 확인처럼 **경기 중이지만 중계가 말하지 않은 턴**이 빠진다.
   * 옛 세이브엔 없다 — optional이라 세이브 버전을 올리지 않는다.
   */
  inMatch?: boolean;
  /**
   * 어느 경기인가 (`MATCH.id`) — `inMatch`인 턴에만 있다.
   *
   * 경기가 끝나면 그 구간을 **한 장으로 접어** 결과만 남기는데, 어느 경기의
   * 기록인지 알아야 스코어를 붙이고 여러 경기가 이어져도 섞이지 않는다.
   */
  matchId?: string;
}

/** 골 하나 — 화면이 카드로 세우는 데 필요한 만큼 (`ChatTurn.goals`) */
/**
 * 경기 중 **문단 밖으로 꺼내 세우는 사건** — 골·경고·퇴장.
 *
 * 셋 다 판을 바꾸는데 중계 문단 한복판에 문장으로만 남으면 다음 턴 두어 개에
 * 밀려 스크롤에 묻힌다. 특히 경고는 **다음 판단의 입력**이다 — 경고를 받은 선수를
 * 계속 두느냐 빼느냐가 곧 교체 결정이라, 감독이 위로 훑을 때 눈에 걸려야 한다.
 */
export interface CardMark {
  minute: number;
  player: string;
  /** 두 번째 경고로 인한 퇴장인가 — 직접 퇴장과 이야기가 다르다 */
  kind: "yellow" | "red" | "second_yellow";
  ours: boolean;
  team: string;
}

export interface GoalMark {
  minute: number;
  scorer: string;
  assist: string | null;
  /** 우리 골인가 — 화면이 색을 가른다 */
  ours: boolean;
  /** 넣은 팀 이름 */
  team: string;
  /** 그 골이 들어간 **직후**의 스코어 */
  score: { home: number; away: number };
}

/**
 * 제공자 원형 경기 이력. packages/llm의 StoredLlmHistory와 구조적으로 같은
 * 세이브 계약이며 engine은 LLM SDK에 의존하지 않는다.
 */
export interface StoredCasterHistory {
  version: 1;
  /** `LlmProvider`와 같은 값 — engine은 LLM SDK를 import하지 않으므로 여기 적는다 */
  provider: "anthropic" | "google" | "openai";
  model: string;
  messages: unknown[];
}

export interface PendingMatch {
  matchId: string;
  packet: StrengthPacket;
  ledger: MatchLedgerState;
  /**
   * ⚠️ 폐기된 필드 — 구간 시뮬레이터(`advanceSegment`)가 사건을 그때그때 굴리므로
   * 경기 전체를 미리 만들지 않는다. 옛 세이브 호환으로만 남긴다 (읽지 않는다).
   */
  script: MatchScriptSegment[] | null;
  scriptCursor: number;
  /** 진행한 구간 수 — 난수 채널에 들어가 같은 경기가 재현된다 */
  segment?: number;
  /**
   * 감독이 경기장에 들어섰는가 — **킥오프는 두 걸음이다.**
   *
   * `start_match`는 판을 세울 뿐이고(입장 확인 창이 선다), 감독이 들어서면 캐스터가
   * 사건 없이 첫 휘슬만 여는 **킥오프 턴**을 한 번 갖는다. 구간이 굴러가는 것은
   * 그다음부터다. 옛 세이브엔 없다 — 없으면 아직 안 들어선 것으로 읽는다.
   */
  entered?: boolean;
  /**
   * 지금 노리고 있는 지점 (`ExploitTarget.id`) — 감독이 지시로 겨냥한 약점.
   *
   * 전술 6축이 "팀의 성향"이라면 이쪽은 **이 경기, 저 지점**이다. 교체로 그
   * 선수가 나가면 표적이 사라지고 공략도 조용히 끝난다 (코어가 대조한다).
   * 옛 세이브엔 없다 — optional이라 세이브 버전을 올리지 않는다.
   */
  exploits?: string[];
  /** 자연어로 지정한 경기 전용 지역 플랜 — 같은 지역은 마지막 지시가 이긴다. */
  regionalPlans?: Array<{
    band: import("@story-fm/domain").RegionalBand;
    lane: import("@story-fm/domain").RegionalLane;
    intent: import("@story-fm/domain").RegionalIntent;
    note: string;
  }>;
  /**
   * 경기 중 소모한 체력 (선수 id → 0~100). 경기 중에는 저장된 `state.condition`에서
   * 빼서 보고, **경기가 끝나면 이 값 그대로 정산된다**(`finalizeMatch`) — 화면에서
   * 보던 소모와 장부에 남는 소모가 같은 숫자여야 한다. 양 팀 것이 함께 쌓인다.
   */
  matchFatigue?: Record<string, number>;
  /**
   * 실모드 캐스터의 대화 이력. 새 이력은 제공자·모델 태그를 갖는다.
   * unknown[]은 태그 도입 전 Anthropic 세이브 호환용이다.
   */
  casterHistory: StoredCasterHistory | unknown[];
  /** 이번 경기 정지 소화 중인 선수 — 종료 시 served +1 */
  servingSuspension: string[];
  /**
   * **킥오프 시점의 전술** — 경기가 끝나면 여기로 되돌린다.
   *
   * 하프타임에 올린 라인, 후반에 붙인 대인 마크는 **그 경기의 대응**이지 팀의
   * 전술이 아니다. 되돌리지 않으면 다음 경기와 그 사이 훈련이 임시 조정을
   * 물려받고, 감독은 자기가 바꾼 적 없는 전술로 경기에 들어간다.
   *
   * 적응도(`familiarity`)도 함께 담는다. 전술을 바꾸면 코어가 적응도를 깎는데,
   * 그건 **새 전술을 훈련해야 한다**는 뜻이라 그 경기 한 번의 대응에는 맞지 않는다.
   * 담지 않으면 하프타임에 라인 한 번 올린 대가로 팀 적응도가 영구히 깎인다.
   * 적응도가 **쌓이는** 것은 경기가 아니라 날짜가 흐를 때다(`settleTactics`).
   */
  tacticsBefore?: {
    spec: import("@story-fm/domain").TacticsSpec;
    assignments: Array<{
      playerId: string;
      position: string;
      point?: import("@story-fm/domain").BoardPoint;
      roleId?: string;
      instruction?: string;
      directive?: import("@story-fm/domain").PlayerDirective;
      familiarity: number;
    }>;
  };
  /**
   * **이번 턴에 중계할 구간** — 캐스터가 입을 열기 전에 코어가 굴려 채운다.
   *
   * 사건을 먼저 확정해 입력에 실어야 캐스터가 무슨 일이 있었는지 알고 첫 줄의
   * 시각을 적을 수 있다. 반대로 캐스터가 목표를 선언하고 코어가 뒤따라가면,
   * 골이 60분에 났는데 헤더는 67분인 턴이 나온다 — 선언과 장부가 어긋난다.
   * 구 세이브엔 없다 (optional — SAVE_VERSION 유지).
   */
  lastSegment?: { events: import("@story-fm/domain").MatchEvent[]; stop: string };
  /**
   * **상대가 경기 중 바꾼 전술** — 이 경기에만 유효하다.
   *
   * 팀의 저장된 전술(`state.tactics`)은 건드리지 않는다. 리그 전체 AI가 경기마다
   * 전술을 흘리면 다음 경기의 상대가 왜 그런 모양인지 아무도 설명할 수 없다.
   * pendingMatch와 함께 사라지므로 되돌릴 것도 없다.
   */
  aiTactics?: import("@story-fm/domain").TacticsSpec;
}

export interface MatchScriptSegment {
  events: import("@story-fm/domain").MatchEvent[];
  stop: "goal" | "half_time" | "full_time" | "incident";
}

export type GamePhase = "idle" | "matchday" | "match";

/** 하루가 열리는 시각 — 아무 선언도 없으면 여기서 시작한다 */
export const DAY_START = "09:00";

/** 구 세이브는 시각이 없다 — 하루의 시작으로 본다 */
export function clockOf(state: GameState): string {
  return state.clock ?? DAY_START;
}

/** "HH:MM" → 분 (같은 날 안의 순서 비교용) */
export function minutesOfClock(clock: string): number {
  const [h, m] = clock.split(":");
  return Number(h ?? 0) * 60 + Number(m ?? 0);
}

/**
 * "HH:MM" → `AM 9:30` — 모델이 쓰고 화면이 읽는 표기.
 * 24시간 값을 저장하고 표시만 12시간제로 옮긴다 (정렬·비교는 저장값으로).
 */
export function formatClock(clock: string): string {
  const total = minutesOfClock(clock);
  const h24 = Math.floor(total / 60) % 24;
  const minute = total % 60;
  const suffix = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${suffix} ${h12}:${String(minute).padStart(2, "0")}`;
}

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
  /**
   * 하루 안의 시각 "HH:MM" — **장부의 시간(날짜)과 장면의 시간을 가른다.**
   *
   * 훈련·성장·부상·재정·협상 응답은 전부 하루 단위로 돌기 때문에 같은 날 안에서
   * 아침이 저녁이 되어도 굴릴 것이 없다. 그래서 이 축은 tick 없이 움직이고,
   * 날짜가 넘어갈 때 하루의 시작으로 돌아온다.
   *
   * 구 세이브엔 없다 — 읽을 때 09:00으로 본다 (`clockOf`).
   */
  clock?: string;
  calendar: SeasonCalendar;
  userTeamId: string;
  phase: GamePhase;
  pendingMatch: PendingMatch | null;
  /**
   * 이 세계의 범위 — 없으면 카탈로그 전체다(실게임·옛 세이브).
   * 테스트가 리그·팀 수를 줄인 작은 세계를 만들 때만 채워진다 (`world/scope.ts`).
   */
  world?: WorldScope;
  /**
   * **승강 결과** — 팀 → 지금 속한 리그. 카탈로그의 `leagueId`는 불변이므로
   * 강등·승격은 세이브 상태로만 표현된다 (`competition/promotion.ts`).
   * 카탈로그와 같은 리그면 항목을 두지 않는다. 옛 세이브엔 없다 — 없으면
   * 전 클럽이 카탈로그 그대로다 (optional — SAVE_VERSION 유지).
   */
  leagueOf?: Record<string, string>;

  // ── 팀·선수 ──
  teams: GameTeam[];
  players: GamePlayer[];
  tactics: TeamTactics[];
  finances: TeamFinance[];
  /**
   * 월간 재정 보고서 — 매월 1일에 지난달을 마감해 쌓인다 (유저 팀만).
   * 상세 원장은 3개월 롤링으로 잘리지만 이 요약은 영구 보존된다 (finance.ts).
   */
  financeReports: FinanceReport[];
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
  /**
   * 정착 이벤트 — 면담·팀토크·주장 지명이 새 영입의 적응에 남긴 것.
   * 나중에 추가된 테이블이라 옛 세이브엔 없다(로드 시 빈 배열).
   */
  settlingEvents: SettlingEvent[];
  /**
   * 이적 리스트 — 감독이 내놓은 선수와 호가. 등재 자체가 시장의 관심을 만든다
   * (`generateIncomingOffers`). 옛 세이브엔 없다(로드 시 빈 배열).
   */
  transferList: TransferListing[];
  /** 개인 훈련 프로그램 — 팀 훈련 위에 한 선수만 겨냥해 얹는다 */
  playerTraining: PlayerTraining[];
  /**
   * **역할 기억** — 선수 × 자리 → 마지막에 맡긴 역할.
   *
   * 배치(`TacticAssignment.roleId`)는 로테이션마다 다시 써지므로, 벤치로 한 번
   * 내려가면 감독의 결정이 지워진다. 배치 바깥에 두어 같은 자리로 돌아왔을 때
   * 기본값 대신 이 값에서 시작한다 (→ docs/data/player.md §3.1).
   * 옛 세이브엔 없다 (로드 시 빈 배열 — 세이브 버전을 올리지 않는다).
   */
  roleMemory: RoleMemory[];
  /**
   * **아직 성사되지 않은 AI 이적** — 이번 주에 정해진, 날짜가 흩어진 거래
   * (`ai-market.ts`). 계획은 주 1회 세우고 실행은 그 날짜의 tick이 한다.
   * 옛 세이브엔 없다 (로드 시 빈 배열 — 세이브 버전을 올리지 않는다).
   */
  aiDeals?: AiDeal[];
  /**
   * **경질됐다** — 있으면 감독은 더 이상 이 구단의 사람이 아니다.
   * 시계는 여기서 멈춘다 (`advanceTime`). 옛 세이브엔 없다.
   */
  dismissal?: { on: string; season: number; teamId: string; reason: string };
  /**
   * **아직 GM이 읽지 않은 화면 조작** — 전술판·명단·역할을 직접 만진 것.
   *
   * 이 조작들은 채팅 턴을 만들지 않는다(장부 편집이다). 그런데 감독은 판을
   * 짜면서 열 번을 만지고, 그 하나하나를 턴으로 만들면 채팅이 조작 로그가 된다.
   * 그렇다고 아무 말도 없으면 모델은 감독이 무엇을 바꿨는지 모른 채 이야기를
   * 잇는다 — 배치는 컨텍스트에 없고 조회 도구로만 알 수 있기 때문이다.
   *
   * 그래서 **모아 두었다가 다음 발화 때 한 번에** 읽힌다. 같은 대상의 조작은
   * 접히므로(`recordEdit`) 역할을 세 번 바꿔도 마지막 한 줄이다.
   * 옛 세이브엔 없다 (optional — SAVE_VERSION 유지).
   */
  pendingEdits?: PendingEdit[];
  /** 스카우트 파견·완료 이력 — 타 팀 선수 안개의 근거 (scouting.ts) */
  scoutReports: ScoutReport[];
  /** 진행 중 협상 — 며칠에 걸쳐 오퍼가 오가므로 파생으로 되돌릴 수 없다 */
  negotiations: Negotiation[];
  /**
   * 기자회견 — 열린 시점과 답한 시점이 갈리므로(감독이 다음 날 답할 수도 있다)
   * 협상처럼 세이브가 들고 있어야 한다. 옛 세이브엔 없다(로드 시 빈 배열).
   */
  pressConferences?: PressConference[];

  // ── 감독 ──
  manager: Manager;
  managerXP: Record<keyof ManagerAttributes, number>;
  seasonRecords: SeasonRecord[];
  trophies: Trophy[];
  achievements: Achievement[];

  // ── 서사 ──
  /**
   * 인물 — 데이터로 다루는 페르소나 (personas.md). 지금은 수석코치 하나이고,
   * 구단주·기자·핵심 선수가 같은 배열에 붙는다. 옛 세이브엔 없어 optional —
   * 로드 시 시드로 채운다(`ensurePersonas`)므로 세이브 버전을 올리지 않는다.
   */
  personas?: Persona[];
  /**
   * 폼 축이 −1~1로 바뀐 뒤의 세이브인가 — 로드 시 한 번만 옮기기 위한 마커
   * (`persistence.ts`). 없으면 옛 −3~3 세이브로 보고 3으로 나눈다.
   */
  formUnitScale?: boolean;
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

export type SquadLevel = "first" | "reserve";

/** 구 세이브의 미지정 선수는 1군으로 읽어 기존 라인업을 깨지 않는다. */
export function squadLevelOf(player: GamePlayer): SquadLevel {
  return player.squadLevel ?? "first";
}

export function firstTeamPlayers(state: GameState, teamId: string): GamePlayer[] {
  return playersOf(state, teamId).filter((p) => squadLevelOf(p) === "first");
}

export function reservePlayers(state: GameState, teamId: string): GamePlayer[] {
  return playersOf(state, teamId).filter((p) => squadLevelOf(p) === "reserve");
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

export interface PlayerPick {
  /** 확신이 **하나**일 때만 채워진다 */
  readonly player: GamePlayer | null;
  /** 되물을 후보 — 확신이 있으면 그 하나뿐이다 */
  readonly candidates: readonly GamePlayer[];
}

const NO_PLAYER: PlayerPick = { player: null, candidates: [] };

/**
 * id·이름으로 선수 하나를 집는다. id가 정확히 맞으면 그것, 아니면 표기 흔들림을
 * 견디는 이름 매칭 (name-match.ts). **애매하면 고르지 않는다** — 잘못 집으면
 * 그대로 잘못된 상태 전이가 되므로, 되묻는 편이 낫다.
 */
export function resolvePlayerRef(pool: readonly GamePlayer[], ref: string): PlayerPick {
  const key = ref.trim();
  if (key === "") return NO_PLAYER;
  const exact = pool.find((p) => p.id === key);
  if (exact) return { player: exact, candidates: [exact] };
  const { matches, best } = rankByName(key, pool);
  return { player: best, candidates: matches };
}

/** 이름으로 선수 하나 — 확신이 갈리면 null (후보까지 필요하면 resolvePlayerRef) */
export function findPlayerByName(state: GameState, name: string): GamePlayer | null {
  return resolvePlayerRef(state.players, name).player;
}

export function playerName(state: GameState, id: string): string {
  return playerById(state, id)?.name ?? id;
}

export function groupOf(player: GamePlayer): PositionGroup {
  return positionGroupOfPlayer(player);
}

/** 능력치 변경 후 overall 재계산 — 주 포지션 **가중치** 공식 */
export function recomputeOverall(player: GamePlayer): void {
  player.attributes.overall = overallFor(naturalPositionOf(player).position, player.attributes);
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

/**
 * 적응도 합산은 **domain**에 산다 — 클라이언트 전술판도 드래그 중에 같은 값을
 * 계산해야 하는데, 웹은 엔진(`node:fs` 의존)을 값으로 import할 수 없다.
 * 여기서 다시 내보내 엔진 소비자는 경로를 바꾸지 않는다.
 */
export {
  ADAPTATION_IMPACT,
  PROFICIENCY_FACTOR_FLOOR,
  PROFICIENCY_FLOOR,
  PROFICIENCY_LOG_SCALE,
  PROFICIENCY_MAX,
  PROFICIENCY_MIN,
  adaptationOf,
  adaptationWeightsOf,
  proficiencyReadiness,
} from "@story-fm/domain";

/**
 * 이 선수가 그 포지션에서 갖는 적응도. 규칙은 domain의 `positionProficiency` 하나뿐
 * — 엔진·웹 전술판이 같은 값을 봐야 한다.
 */
export function proficiencyAt(player: GamePlayer, position: string): number {
  // 주발까지 넘긴다 — 왼발 수비수는 LCB가 조금 편하다 (footAdjust ±3)
  return positionProficiency(player.positions, position, player.foot);
}

// ── 부상·징계·계약 ──────────────────────────────────────

export function openInjury(state: GameState, playerId: string): Injury | null {
  return state.injuries.find((i) => i.gamePlayerId === playerId && i.returnedOn === null) ?? null;
}

/**
 * **마음이 떠 있는가** — 라커룸 불만(`state.issues`)이 걸린 선수.
 *
 * ⚠️ 이 질문에 `condition`으로 답하지 마라. 그 축은 경기 한 판에 30~50이 빠지는
 * **몸의 예산**이라, "체력 45 미만 = 사기가 낮다"로 읽으면 90분을 뛴 다음 날
 * 선발 전원이 팀을 떠나고 싶어 하는 선수가 된다 — 실제로 이적 확률·재계약
 * 확률·들어오는 오퍼가 그렇게 굴러가고 있었다. 마음은 마음 쪽에서 읽는다.
 */
export function hasIssue(state: GameState, playerId: string): boolean {
  return state.issues.some((i) => i.gamePlayerId === playerId);
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
  return state.contracts.find((c) => c.gamePlayerId === playerId && c.status === "active") ?? null;
}

/** 팀 주급 총액 — 활성 계약의 합 (저장하지 않는 파생값) */
export function weeklyWagesOf(state: GameState, teamId: string): number {
  /**
   * **임대는 주급을 나눈다.** 계약은 원소속에 남으므로 합계는 여전히 우리 것인데,
   * 임대 팀이 `wageShare`만큼을 낸다 — 그만큼 우리 부담에서 빠지고 그쪽에 얹힌다.
   * 저장하지 않고 계약 + `GamePlayer.loan`에서 파생한다.
   */
  let total = 0;
  for (const c of state.contracts) {
    if (c.status === "active" && c.teamId === teamId) total += c.weeklyWage;
  }
  /**
   * 임대 보정 — **임대 중인 선수만 훑는다.** 계약마다 선수를 찾으면 O(계약×선수)라
   * 4,000명 세이브에서 주급 계산 한 번이 1,600만 번 비교가 된다(재정 tick이 팀마다
   * 부른다). 임대는 드무니 그쪽에서 시작하는 게 맞다.
   */
  for (const player of state.players) {
    const loan = player.loan;
    if (!loan) continue;
    if (loan.fromTeamId !== teamId && player.teamId !== teamId) continue;
    const contract = state.contracts.find(
      (c) => c.status === "active" && c.gamePlayerId === player.id,
    );
    if (!contract || contract.teamId !== loan.fromTeamId) continue;
    if (loan.fromTeamId === teamId) total -= contract.weeklyWage * loan.wageShare;
    else if (player.teamId === teamId) total += contract.weeklyWage * loan.wageShare;
  }
  return total;
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
  /** 실제로 그 일이 있었던 날 — 안 주면 오늘. 결산은 **지나간 훈련 날짜**를 준다 */
  on?: string,
): void {
  state.growthLog.push({
    gamePlayerId: playerId,
    entryId,
    date: on ?? state.date,
    source,
    target,
    delta,
    ...(note ? { note } : {}),
  });
  if (state.growthLog.length > 4000) state.growthLog.splice(0, state.growthLog.length - 4000);
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
  /** 세계의 범위 — 없으면 카탈로그 전체 (`world/scope.ts`) */
  world?: WorldScope;
}

/**
 * 초기 계약의 주급 — **카탈로그의 실제 주급이 원본**이고, 없으면 모델이 어림한다.
 *
 * 시드에 공개 주급이 있는 선수(EPL 1군)는 그 값을 쓴다. 실측이 모델보다 정확하고,
 * 무엇보다 **구단마다의 특수 사정**(장기 계약을 남긴 베테랑, 팔지 못한 고액자)은
 * 모델이 만들어낼 수 없는 사실이다. 그 왜곡이 곧 PSR·재계약 서사의 재료다.
 *
 * 나머지는 `estimateSquadWages` — 구단 예산을 스쿼드에 나눈다 (wages.ts).
 */
function initialWages(players: GamePlayer[], onDate: string): Map<string, number> {
  const seeded = new Map<string, number>();
  for (const entry of playerCatalog()) {
    if (entry.weeklyWage !== undefined) seeded.set(entry.id, entry.weeklyWage);
  }
  const out = new Map<string, number>();
  const byTeam = new Map<string, GamePlayer[]>();
  for (const p of players) byTeam.set(p.teamId, [...(byTeam.get(p.teamId) ?? []), p]);
  for (const [teamId, squad] of byTeam) {
    const modelled = estimateSquadWages(
      teamId,
      squad.map((p) => wageSubjectOf(p, onDate)),
    );
    for (const p of squad) {
      const real = p.catalogId === null ? undefined : seeded.get(p.catalogId);
      out.set(p.id, real ?? modelled.get(p.id) ?? 0);
    }
  }
  return out;
}

/**
 * 팀 tier → 시작 잔고·이적 예산. **EPL 기준이고 구단 경제 수준을 곱한다**
 * (`initialFinanceOf` — club-finance.md §12.1).
 *
 * 곱하지 않으면 PSG가 아스날과 똑같은 £120M/£90M로 시작해 6분의 1 중계 수입으로
 * 같은 살림을 산다. 수입만 리그를 알던 비대칭이 초기치에도 있던 자리다.
 */
const TIER_FINANCE: Record<number, { balance: number; budget: number }> = {
  1: { balance: 120_000_000, budget: 90_000_000 },
  2: { balance: 70_000_000, budget: 45_000_000 },
  3: { balance: 40_000_000, budget: 22_000_000 },
  4: { balance: 25_000_000, budget: 12_000_000 },
};

function initialFinanceOf(teamId: string, tier: number): { balance: number; budget: number } {
  const base = TIER_FINANCE[tier] ?? TIER_FINANCE[4]!;
  const level = clubEconomyLevel(teamId);
  return {
    balance: Math.round(base.balance * level),
    budget: Math.round(base.budget * level),
  };
}

/**
 * 카탈로그 → 게임 선수 인스턴스화. 새 게임에서만 호출된다.
 * 카탈로그는 불변이므로 깊은 복사로 만들고 catalogId로 출처를 링크한다.
 */
function instantiatePlayers(seed: number, only?: (teamId: string) => boolean): GamePlayer[] {
  const players: GamePlayer[] = [];
  for (const entry of playerCatalog()) {
    if (only && !only(entry.teamId)) continue;
    const rng = makeRng(seed, `inst:${entry.id}`);
    const player: GamePlayer = {
      id: entry.id,
      catalogId: entry.id,
      teamId: entry.teamId,
      squadLevel: "first",
      name: entry.nameKo,
      ...(entry.squadNumber === undefined ? {} : { squadNumber: entry.squadNumber }),
      birthdate: entry.birthdate,
      positions: entry.positions.map((p) => ({ ...p })),
      ...(entry.homegrownCountry === undefined ? {} : { homegrownCountry: entry.homegrownCountry }),
      ...(entry.foot === undefined ? {} : { foot: entry.foot }),
      ...(entry.height === undefined ? {} : { height: entry.height }),
      ...(entry.weight === undefined ? {} : { weight: entry.weight }),
      attributes: {
        // 카탈로그의 15축을 그대로 복사 (2-레이어 분리 — 이후 변화는 GAME_PLAYER에만)
        ...(Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, entry[a]])) as AxisValues),
        overall: 50, // 아래 recomputeOverall이 주 포지션 가중치로 채운다
        potential: entry.potential,
      },
      state: {
        /**
         * 프리시즌 시작이라 폼은 0 근처다 — 폼 축이 −1~1이 된 뒤로 `randInt(-1,1)`은
         * **바닥/절정**을 뜻하게 됐다(예전 −3~3 축에서는 약한 흔들림이었다).
         * 개인차만 남기고 평소 밴드 안에 둔다.
         */
        form: randInt(rng, -1, 1) * 0.15,
        // 프리시즌 시작 — 잘 쉬고 돌아왔다
        condition: randInt(rng, 70, 86),
      },
      isCaptain: false,
    };
    recomputeOverall(player);
    players.push(player);
  }
  return players;
}

const RESERVE_TEAM_SIZE = 18;
/**
 * 필수 자리를 채우고도 남는 U21을 1군에 몇 명까지 더 붙이나. 명단을 차지하지
 * 않으니 규정상 제한은 없지만, 실제로도 1군 훈련에 붙는 유망주는 소수고
 * 나머지는 2군에서 자란다.
 */
const U21_IN_FIRST = 3;
/**
 * 자리별 필수 확보 인원 — 등록 명단은 "잘하는 25명"이 아니라 **경기를 치를 수
 * 있는 25명**이다. 골키퍼 셋, 수비 여덟, 중원 여덟, 공격 다섯이 기준선.
 */
const ESSENTIAL_QUOTA: Record<string, number> = { GK: 3, DF: 8, MF: 8, FW: 5 };
/** 코어에 반드시 넣는 골키퍼 수 — 하나로는 시즌을 못 치른다 */
const CORE_GK = 2;

/**
 * 세이브에 없는 카탈로그 클럽을 채워 넣는다 — 진행 중인 게임에 새 클럽이 붙을 때.
 *
 * 2부 리그를 도입하면서 기존 세이브(1부 96팀만 있는)엔 컵 참가 클럽 64개가
 * 없어졌다. 그대로 두면 국내 컵이 존재하지 않는 팀으로 대진을 짜거나(장부가
 * 깨진다) 아예 돌지 않는다. 세이브 버전을 올려 로드를 거부하는 대신, 빠진
 * 클럽만 새로 인스턴스화해 붙인다 — 기존 진행에는 아무 영향이 없다
 * (이 클럽들은 리그전을 돌지 않고 컵에만 나온다).
 *
 * @returns 추가된 클럽 수 (0이면 최신 세이브)
 */
export function addMissingClubs(state: GameState): number {
  const present = new Set(state.teams.map((t) => t.id));
  // 축소 세계는 빠진 게 아니라 원래 없는 것이다 — 채워 넣으면 세계가 커진다
  const missing = scopedTeams(state.world).filter((t) => !present.has(t.id));
  if (missing.length === 0) return 0;

  const rng = makeRng(state.seed, "backfill:ai-managers");
  // 빠진 클럽만 인스턴스화한다 — 게임 목록은 세이브마다 로드하므로
  // 전 카탈로그(6,000명+)를 매번 만들면 목록 화면이 눈에 띄게 느려진다
  const added = instantiatePlayers(state.seed, (teamId) => !present.has(teamId));
  const wages = initialWages(added, state.date);

  for (const team of missing) {
    state.teams.push({ id: team.id, aiManagerTacticsRating: randInt(rng, 55, 82) });
    // 무소속은 스쿼드도 배치도 갖지 않는다 — 팀 엔티티만 있으면 된다
    if (!isClubTeam(team.id)) continue;
    const squad = added.filter((p) => p.teamId === team.id);
    ensureSquadNumbers(squad);
    for (const player of squad) player.squadLevel = "first";
    state.players.push(...squad);
    state.contracts.push(
      ...squad.map((p) => ({
        id: `c-${p.id}`,
        gamePlayerId: p.id,
        teamId: team.id,
        weeklyWage: wages.get(p.id) ?? 0,
        since: state.date,
        until: `${seasonYear(state.season) + 1 + (squad.indexOf(p) % 3)}-06-30`,
        status: "active" as const,
      })),
    );
    const finance = initialFinanceOf(team.id, team.tier);
    state.finances.push({
      teamId: team.id,
      balance: finance.balance,
      transferBudget: finance.budget,
      ledger: [],
      prizesPaid: [],
    });
    state.tactics.push({
      teamId: team.id,
      spec: initialTactics(team.id, pickFormation(squad, team.formation, defaultXiIds(team.id))),
      assignments: buildAssignments(
        squad,
        pickFormation(squad, team.formation, defaultXiIds(team.id)),
        FAMILIARITY_BASELINE,
        undefined,
        defaultXiIds(team.id),
      ),
    });
  }
  return missing.length;
}

/**
 * 새 게임의 구단별 1·2군을 구성한다 — **등록 규칙을 지키며** 전력순으로 채운다.
 *
 * 상위 25명을 그냥 자르면 홈그로운 8명 조건을 어긴 명단이 만들어져, 감독이
 * 부임하자마자 위반 상태에서 시작한다. 그래서 위에서부터 훑되 `canRegister`가
 * 허락할 때만 1군에 올린다 — 홈그로운이 부족한 구단은 25명을 다 못 채우고
 * 시작하는데, 그것이 현실이고 그 자체가 첫 시즌의 과제가 된다.
 */
function buildInitialSquads(
  players: GamePlayer[],
  seed: number,
  formations: Map<string, Formation>,
  teams: readonly TeamCatalogEntry[] = teamCatalog(),
): void {
  const seasonStartYear = 2026;
  // 2군을 메울 유스가 여기서 태어난다 — id는 세계 전체에서 유일해야 한다
  const takenIds = new Set(players.map((p) => p.id));
  for (const team of teams) {
    const squad = players
      .filter((p) => p.teamId === team.id)
      .sort((a, b) => b.attributes.overall - a.attributes.overall);
    // 2부 클럽은 컵에만 나온다 — 2군 개발 스쿼드를 둘 이유가 없다 (전원 1군)
    if (!isTopFlight(team.id)) {
      for (const player of squad) player.squadLevel = "first";
      continue;
    }
    /**
     * **자리부터 채운다.** 전력순으로만 훑으면 홈그로운 상한에 걸려 골키퍼가
     * 통째로 명단 밖으로 밀리는 일이 생긴다(실제로 그렇게 짜는 구단은 없다).
     * 그룹별 필수 인원을 먼저 확보하고, 남은 자리를 전력순으로 메운다.
     */
    /**
     * **코어** — 이들이 빠지면 경기를 못 치른다. 구단 지정 선발 XI와, 그것으로
     * 못 채운 자리의 최적 선수. 나이가 어려도 1군이다(골키퍼가 전부 19살인
     * 구단도 있다).
     */
    const core = new Set<string>();
    for (const id of defaultXiIds(team.id)) {
      if (squad.some((p) => p.id === id)) core.add(id);
    }
    for (const slot of FORMATION_SLOTS[formations.get(team.id) ?? formationOf(team.id)]) {
      if (
        [...core].some(
          (id) =>
            proficiencyAt(
              squad.find((p) => p.id === id)!,
              slot,
            ) >= 70,
        )
      ) {
        continue;
      }
      const best = squad
        .filter((p) => !core.has(p.id))
        .reduce<GamePlayer | null>(
          (top, p) => (top === null || proficiencyAt(p, slot) > proficiencyAt(top, slot) ? p : top),
          null,
        );
      if (best) core.add(best.id);
    }
    // 백업 골키퍼도 코어다 — 키퍼 하나로 시즌을 치를 수는 없다
    for (const p of squad.filter((x) => positionGroupOfPlayer(x) === "GK").slice(0, CORE_GK)) {
      core.add(p.id);
    }
    /** 코어 + 자리별 뎁스 — 등록 순서의 우선권만 갖는다 (로테이션·부상 대비) */
    const essential = new Set(core);
    for (const [group, quota] of Object.entries(ESSENTIAL_QUOTA)) {
      const inGroup = squad.filter((p) => positionGroupOfPlayer(p) === group);
      for (const p of inGroup.slice(0, quota)) essential.add(p.id);
    }
    /**
     * **코어를 맨 앞에 세워 등록한다.** 뎁스 자원이 전력순으로 앞질러 등록되면
     * 홈그로운 상한(25명 중 비홈그로운 17)에 걸려 정작 지정 선발이 2군에 남는다
     * — 실제로 노팅엄의 지정 공격형 미드필더가 그렇게 밀렸다. 코어는 11~13명이라
     * 먼저 등록해도 상한에 닿지 않으므로, 순서만 바꾸면 규칙을 어기지 않고
     * "지정 선발은 반드시 1군"이 보장된다.
     */
    const rank = (p: GamePlayer) => (core.has(p.id) ? 0 : essential.has(p.id) ? 1 : 2);
    const ordered = [...squad].sort(
      (a, b) => rank(a) - rank(b) || b.attributes.overall - a.attributes.overall,
    );

    const registered: RegistrablePlayer[] = [];
    let youngInFirst = 0;
    for (const player of ordered) {
      const entry: RegistrablePlayer = {
        id: player.id,
        birthdate: player.birthdate,
        homegrown: player.homegrownCountry === countryOfTeam(team.id),
      };
      if (isUnder21(player.birthdate, seasonStartYear)) {
        // U21은 명단 밖이라 규정이 막지 않는다 — 몇 명을 붙일지는 운영 판단이다.
        // 단 **코어는 쿼터에서 뺀다** — 골키퍼가 전부 19살인 구단도 있고
        // (스트라스부르), 그 팀의 골키퍼는 어려도 1군 골키퍼다.
        if (core.has(player.id) || youngInFirst < U21_IN_FIRST) {
          player.squadLevel = "first";
          registered.push(entry);
          if (!core.has(player.id)) youngInFirst += 1;
        } else {
          player.squadLevel = "reserve";
        }
        continue;
      }
      const allowed = canRegister(registered, entry, seasonStartYear);
      player.squadLevel = allowed.ok ? "first" : "reserve";
      if (allowed.ok) registered.push(entry);
    }
    /**
     * 매치데이(20명)를 못 채우면 **U21로 메운다.** 홈그로운이 모자라 명단을 25까지
     * 못 채운 구단이 실제로 하는 일이 이것이다 — 명단을 차지하지 않는 어린 선수로
     * 벤치를 채운다. 21세 초과는 규정이 막으므로 여기서 올릴 수 없다.
     */
    let firstCount = squad.filter((p) => p.squadLevel === "first").length;
    if (firstCount < MATCHDAY_SQUAD) {
      for (const player of ordered) {
        if (firstCount >= MATCHDAY_SQUAD) break;
        if (player.squadLevel === "first") continue;
        if (!isUnder21(player.birthdate, seasonStartYear)) continue;
        player.squadLevel = "first";
        firstCount += 1;
      }
    }
    const reserveCount = squad.filter((p) => p.squadLevel === "reserve").length;
    for (let i = reserveCount; i < RESERVE_TEAM_SIZE; i++) {
      const youth = generateYouthPlayer(
        seed + 17,
        team.id,
        0,
        i,
        team.tier,
        takenIds,
        undefined,
        2026,
      );
      youth.squadLevel = "reserve";
      players.push(youth);
    }
  }
}

/** 슬롯 전체의 적합도 합이 최대가 되게 선수를 배치한다 (직사각형 Hungarian). */
function fillSlots(
  pool: GamePlayer[],
  slots: readonly string[],
  score: (p: GamePlayer, slot: string) => number,
): GamePlayer[] {
  const rowCount = Math.min(slots.length, pool.length);
  if (rowCount === 0) return [];
  const maxScore = Math.max(
    ...slots.slice(0, rowCount).flatMap((slot) => pool.map((player) => score(player, slot))),
  );
  const u = Array<number>(rowCount + 1).fill(0);
  const v = Array<number>(pool.length + 1).fill(0);
  const matchedRow = Array<number>(pool.length + 1).fill(0);
  const previousColumn = Array<number>(pool.length + 1).fill(0);

  for (let row = 1; row <= rowCount; row++) {
    matchedRow[0] = row;
    let column = 0;
    const minimum = Array<number>(pool.length + 1).fill(Infinity);
    const used = Array<boolean>(pool.length + 1).fill(false);
    do {
      used[column] = true;
      const currentRow = matchedRow[column]!;
      let delta = Infinity;
      let nextColumn = 0;
      for (let candidate = 1; candidate <= pool.length; candidate++) {
        if (used[candidate]) continue;
        const cost =
          maxScore -
          score(pool[candidate - 1]!, slots[currentRow - 1]!) -
          u[currentRow]! -
          v[candidate]!;
        if (cost < minimum[candidate]!) {
          minimum[candidate] = cost;
          previousColumn[candidate] = column;
        }
        if (minimum[candidate]! < delta) {
          delta = minimum[candidate]!;
          nextColumn = candidate;
        }
      }
      for (let candidate = 0; candidate <= pool.length; candidate++) {
        if (used[candidate]) {
          const matched = matchedRow[candidate]!;
          u[matched] = u[matched]! + delta;
          v[candidate] = v[candidate]! - delta;
        } else {
          minimum[candidate] = minimum[candidate]! - delta;
        }
      }
      column = nextColumn;
    } while (matchedRow[column] !== 0);

    do {
      const previous = previousColumn[column]!;
      matchedRow[column] = matchedRow[previous]!;
      column = previous;
    } while (column !== 0);
  }

  const result = Array<GamePlayer>(rowCount);
  for (let column = 1; column <= pool.length; column++) {
    const row = matchedRow[column]!;
    if (row > 0) result[row - 1] = pool[column - 1]!;
  }
  return result;
}

/**
 * **주 포지션에 서는 값** — 감독은 자리를 존중한다.
 *
 * 포지션군 가산(`SAME_GROUP_BONUS`)만으로는 부족했다. 4-2-3-1의 볼란치와 10번은
 * 둘 다 미드필더군이라 그 가산이 상쇄돼, 남는 건 적응도와 OVR뿐이다. 그런데
 * 적응도는 **파생값이 보유값을 넘을 수 있어**(마이누의 CM 95에서 파생된 CAM 89가
 * 페르난데스가 실제 보유한 CAM 88보다 높다) 10번이 6번 자리로 밀려났다.
 *
 * "그 선수의 본업인가"는 그런 눈금 흔들림과 무관한 사실이라 따로 센다.
 * 좌우 분화는 같은 자리로 본다 — LCB의 본업은 CB다 (`weightSlotOf`).
 *
 * ⚠️ **그 자리를 볼 수는 있을 때만 준다** (`NATURAL_BONUS_FLOOR`). `weightSlotOf`는
 * 요구 역량이 같아서 좌우를 합치는데, "본업인가"에는 좌우가 중요하다 — 문턱이
 * 없으면 주 RB가 반대쪽 LWB에서도 가산을 받아(적응도 56) 진짜 왼쪽 자원을
 * 밀어낸다. 지정 선발 가산이 `XI_BONUS_FLOOR`를 두는 것과 같은 이유다.
 *
 * 40(포지션군)보다 작게 잡은 이유: 이 가산이 OVR 차이를 통째로 덮으면 주 포지션
 * 백업이 타 포지션 특급을 밀어낸다. 실제 감독은 충분히 좋은 선수라면 자리를
 * 옮겨서라도 쓴다.
 */
const NATURAL_SLOT_BONUS = 30;
/** 본업 가산이 붙는 최소 적응도 — 기본 배치 가드(70)와 같은 눈금 */
const NATURAL_BONUS_FLOOR = 70;
/** 포지션군이 맞을 때 — "그 라인의 선수인가" */
const SAME_GROUP_BONUS = 40;

/**
 * 슬롯 적합도 — **누구를 어디에 세울지**의 단일 기준.
 * 정확 포지션 적응도 + OVR, 포지션군·주 포지션이 맞으면 가산,
 * 골키퍼 자리는 서로 못 넘본다.
 */
function lineupFit(p: GamePlayer, slot: string, prof = proficiencyAt(p, slot)): number {
  const sameGroup = groupOf(p) === positionGroupOf(slot);
  const onNatural =
    prof >= NATURAL_BONUS_FLOOR &&
    weightSlotOf(naturalPositionOf(p).position) === weightSlotOf(slot);
  const gkPenalty = slot === "GK" && groupOf(p) !== "GK" ? -400 : 0;
  const nonGkPenalty = slot !== "GK" && groupOf(p) === "GK" ? -400 : 0;
  return (
    prof * 1.2 +
    p.attributes.overall +
    (sameGroup ? SAME_GROUP_BONUS : 0) +
    (onNatural ? NATURAL_SLOT_BONUS : 0) +
    gkPenalty +
    nonGkPenalty
  );
}

/**
 * 맡은 자리에서의 실제 기여 — 시뮬의 존 기여 점수와 **같은 잣대**.
 * 적응도 팩터는 sim에서 가져온다 (예전엔 같은 식이 양쪽에 복제돼 있었다 —
 * 한쪽만 고치면 배치가 고른 자리와 경기가 계산하는 자리가 조용히 갈린다).
 */
function slotStrength(p: GamePlayer, slot: string): number {
  return roleFit(p.attributes, slot) * profFactor(proficiencyAt(p, slot));
}

/**
 * 이 스쿼드로 그 모양을 세우면 나오는 **전력**.
 *
 * ⚠️ 채점 전에 **자리를 제대로 배치해야** 한다. `roleFit`만 보고 그리디로 채우면
 * 라이스가 라이트백에, 요케레스가 윙에 서는 라인업이 나오고 — 그 엉터리 배치의
 * 합으로 모양을 고르니 96팀 중 40팀이 5-4-1이 됐다. 배치는 실제 라인업과 같은
 * 기준(`lineupFit`: 포지션 적응도 + OVR + 포지션군)으로 뽑고, **전력 합은**
 * 그렇게 뽑힌 11명의 존 기여로 낸다.
 *
 * 모든 모양이 11자리라 자리별 기준선은 합에서 상쇄된다 — 따로 정규화하지 않는다.
 */
function shapeStrength(
  squad: GamePlayer[],
  formation: Formation,
  fit: (p: GamePlayer, slot: string) => number,
): number {
  const slots = FORMATION_SLOTS[formation];
  const chosen = fillSlots(squad, slots, fit);
  return chosen.reduce((sum, p, i) => sum + slotStrength(p, slots[i]!), 0);
}

/**
 * (선수 × 슬롯) 점수 캐시 — 프리셋 5개를 훑으면 같은 조합을 몇 번씩 다시 잰다.
 * `proficiencyAt`이 포지션 배열을 훑으므로 그대로 두면 새 게임 하나에 100만 번
 * 가까이 불린다 (게임 생성이 0.4초 → mock GM 테스트가 타임아웃까지 갔다).
 */
function memoFit(): (p: GamePlayer, slot: string) => number {
  const cache = new Map<string, number>();
  return (p, slot) => {
    const key = `${p.id}|${slot}`;
    let v = cache.get(key);
    if (v === undefined) {
      v = lineupFit(p, slot);
      cache.set(key, v);
    }
    return v;
  };
}

/** 포메이션이 의도하는 공간 사용과 모순되지 않는 초기 운용값. */
function initialTactics(
  teamId: string,
  formation: Formation,
): import("@story-fm/domain").TacticsSpec {
  switch (tacticalStyleOf(teamId)) {
    case "possession":
      return {
        formation,
        mentality: 4,
        defensiveLine: 4,
        pressing: 4,
        tempo: 3,
        width: 4,
        passStyle: 2,
      };
    case "high-press":
      return {
        formation,
        mentality: 4,
        defensiveLine: 4,
        pressing: 5,
        tempo: 4,
        width: 3,
        passStyle: 3,
      };
    case "transition":
      return {
        formation,
        mentality: 3,
        defensiveLine: 3,
        pressing: 3,
        tempo: 4,
        width: 4,
        passStyle: 4,
      };
    case "direct":
      return {
        formation,
        mentality: 3,
        defensiveLine: 3,
        pressing: 3,
        tempo: 4,
        width: 4,
        passStyle: 5,
      };
    case "low-block":
      return {
        formation,
        mentality: 2,
        defensiveLine: 2,
        pressing: 2,
        tempo: 3,
        width: 3,
        passStyle: 4,
      };
    case "balanced":
      break;
  }
  switch (formation) {
    case "4-3-3":
      return {
        formation,
        mentality: 4,
        defensiveLine: 4,
        pressing: 4,
        tempo: 3,
        width: 4,
        passStyle: 2,
      };
    case "4-2-3-1":
      return {
        formation,
        mentality: 3,
        defensiveLine: 3,
        pressing: 4,
        tempo: 3,
        width: 3,
        passStyle: 2,
      };
    case "4-4-2":
      return {
        formation,
        mentality: 3,
        defensiveLine: 3,
        pressing: 3,
        tempo: 4,
        width: 4,
        passStyle: 4,
      };
    case "3-5-2":
      return {
        formation,
        mentality: 3,
        defensiveLine: 3,
        pressing: 3,
        tempo: 3,
        width: 4,
        passStyle: 3,
      };
    case "5-4-1":
      return {
        formation,
        mentality: 2,
        defensiveLine: 2,
        pressing: 3,
        tempo: 3,
        width: 3,
        passStyle: 4,
      };
  }
}

/**
 * 구단이 **어떤 모양으로 서야 가장 센가** — 5개 프리셋을 채워 보고 고른다.
 *
 * 채점 풀은 **지정 선발 11인**이다(있으면). 모양은 결국 "이 열한 명을 어떻게
 * 세울까"의 답이라, 스쿼드 전체로 재면 4백 명단을 가진 팀이 5백으로 서는 답이
 * 나온다(본머스가 그랬다) — 백업 수비수까지 세어 버리기 때문이다. 지정 선발이
 * 없는 팀만 스쿼드 전체로 잰다.
 *
 * 카탈로그의 리서치 값(`TeamCatalogEntry.formation`)은 **선입견**으로 얹는다:
 * 실제 감독이 쓰는 시스템이라는 근거가 있으니 다른 모양이 **뚜렷하게** 셀 때만
 * 뒤집힌다. 그래서 스쿼드가 리서치 값을 감당하는 팀은 그대로 가고, 감당 못 하는
 * 팀(백3인데 센터백이 둘, 윙어가 없는데 4-3-3)만 제 모양을 찾아간다.
 */
export function pickFormation(
  squad: GamePlayer[],
  prior?: Formation,
  preferred?: readonly string[],
): Formation {
  const wanted = new Set(preferred ?? []);
  const xi = squad.filter((p) => wanted.has(p.id));
  const pool = xi.length >= 10 ? xi : squad;
  const fit = memoFit();
  if (prior) {
    const placed = fillSlots(pool, FORMATION_SLOTS[prior], fit);
    const feasible = placed.every(
      (player, index) => proficiencyAt(player, FORMATION_SLOTS[prior][index]!) >= XI_BONUS_FLOOR,
    );
    if (feasible) return prior;
  }
  let best: Formation = prior ?? DEFAULT_FORMATION;
  let bestScore = -Infinity;
  for (const formation of FORMATIONS) {
    const score = shapeStrength(pool, formation, fit);
    if (score > bestScore) {
      bestScore = score;
      best = formation;
    }
  }
  return best;
}

/** 지정 선발 가산이 붙는 최소 적응도 — "그 자리를 볼 수는 있다"의 문턱.
 *  기본 배치 가드(적응도 70 미만 금지)와 같은 눈금이다 — 가산이 그 가드를 뚫으면
 *  안 된다 (사우스햄프턴의 마테우스 페르난데스가 적응도 64로 레프트백에 섰다). */
const XI_BONUS_FLOOR = 70;

/**
 * 포메이션 슬롯에 맞춰 선발 11 + 벤치 9 배치를 만든다 (적합도 우선).
 *
 * `preferred`를 주면 그 선수들이 선발에 **크게 가산**된다 — 팀 카탈로그의
 * 기본 선발(`DEFAULT_XI`)이 이 경로로 들어온다. 배제가 아니라 가산인 이유는
 * 포지션군 감점(-400)이 여전히 이겨야 하기 때문이다: 지정 명단에 GK가 없거나
 * 그 GK가 2군이면, 강제로 채우는 순간 필드 플레이어가 골문에 선다.
 * 11명이 안 되거나 부상·징계로 빠진 자리는 평소대로 적합도 상위가 메운다.
 */
export function buildAssignments(
  squad: GamePlayer[],
  formation: keyof typeof FORMATION_SLOTS,
  familiarity: number,
  available: (id: string) => boolean = () => true,
  preferred?: readonly string[],
  customLayout?: {
    slots: readonly string[];
    points: readonly import("@story-fm/domain").BoardPoint[];
  },
): TacticAssignment[] {
  // 프리셋은 새 게임 초기화 전용이다. 시즌 중 재구성은 저장된 실제 좌표를 넘긴다.
  const slots = customLayout?.slots ?? FORMATION_SLOTS[formation];
  const layout = customLayout?.points ?? FORMATION_LAYOUTS[formation];
  const used = new Set<string>();
  const assignments: TacticAssignment[] = [];
  const pool = squad.filter((p) => available(p.id));
  const wanted = new Set(preferred ?? []);

  // 지정 선발 가산 — 적합도·OVR 차이(최대 ~110)를 확실히 덮는다.
  //
  // **그 자리를 실제로 볼 수 있을 때만** 준다: 카탈로그의 기본 선발은 그 구단의
  // 실제 포메이션에서 뽑힌 11명이라, 프리셋으로 접힌 다른 모양(4백 명단 →
  // 3-5-2)에 그대로 밀어 넣으면 스트라이커가 윙백에 선다. 못 서는 자리는
  // 스쿼드에서 제대로 된 자원이 채우고 밀린 선수는 벤치로 간다 — 감독이 백3로
  // 바꿀 때 실제로 하는 일이다.
  //
  // 포지션군 일치로 재면 안 된다. 4-2-3-1의 넓은 공격 3인은 좌표상 RM/AM/LM이라
  // **미드필더군**인데 그 자리에 서는 건 윙어(FW군)다 — 군으로 막으면 풀럼의
  // 보브·케빈 같은 지정 선발이 통째로 밀려난다. 적응도로 재면 같은 질문에
  // 정확히 답하면서(스트라이커의 윙백 적응도는 40대라 여전히 막힌다) 이 오탐이
  // 사라진다.
  const fit = (p: GamePlayer, slot: string): number => {
    // 적응도는 한 번만 — `fillSlots`가 쌍 교환을 세 번 돌며 이 함수를 수만 번 부른다
    const prof = proficiencyAt(p, slot);
    return lineupFit(p, slot, prof) + (wanted.has(p.id) && prof >= XI_BONUS_FLOOR ? 200 : 0);
  };

  const chosen = fillSlots(pool, slots, fit);
  for (const p of chosen) used.add(p.id);

  chosen.forEach((p, i) => {
    assignments.push({
      playerId: p.id,
      role: "starting",
      position: slots[i]!,
      familiarity,
      point: layout[i],
    });
  });

  // 벤치 9 — GK 1명 포함 우선, 나머지는 OVR 상위
  const rest = pool
    .filter((p) => !used.has(p.id))
    .sort((a, b) => b.attributes.overall - a.attributes.overall);
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
  if (!teamCatalog().some((t) => t.id === input.userTeamId)) {
    throw new Error(`알 수 없는 팀: ${input.userTeamId}`);
  }
  const season = 1;
  const calendar = buildSeasonCalendar(season);
  const rng = makeRng(seed, "ai-managers");
  const world = input.world;
  const catalogTeams = scopedTeams(world);
  const inThisWorld = new Set(catalogTeams.map((t) => t.id));
  if (!inThisWorld.has(input.userTeamId)) {
    throw new Error(`이 세계에 없는 팀: ${input.userTeamId}`);
  }

  const teams: GameTeam[] = catalogTeams.map((t) => ({
    id: t.id,
    aiManagerTacticsRating: randInt(rng, 55, 82),
    // 부임일 — 감독 시장이 "얼마나 됐나"를 여기서 잰다 (`manager-market.ts`)
    managerSince: calendar.preseasonStart,
  }));
  const players = instantiatePlayers(seed, (teamId) => inThisWorld.has(teamId));
  // 구단마다 **자기 스쿼드에 맞는 모양**을 먼저 고른다 — 1·2군 분할도 이 모양의
  // 자리를 기준으로 코어를 잡으므로 순서가 여기여야 한다
  const formations = new Map<string, Formation>(
    catalogTeams.map((t) => [
      t.id,
      pickFormation(
        players.filter((p) => p.teamId === t.id),
        t.formation,
        defaultXiIds(t.id),
      ),
    ]),
  );
  buildInitialSquads(players, seed, formations, catalogTeams);
  ensureSquadNumbers(players);

  // 전술·배치 — 구단의 기본 포메이션과 기본 선발로 시작한다 (팀 카탈로그)
  const tactics: TeamTactics[] = teams.map((t) => {
    const formation = formations.get(t.id) ?? formationOf(t.id);
    return {
      teamId: t.id,
      spec: initialTactics(t.id, formation),
      assignments: buildAssignments(
        players.filter((p) => p.teamId === t.id && squadLevelOf(p) === "first"),
        formation,
        FAMILIARITY_BASELINE,
        undefined,
        defaultXiIds(t.id),
      ),
    };
  });

  // 주장 — 유저 팀은 선발 중 최고 OVR 필드 플레이어
  const userSquad = players.filter((p) => p.teamId === input.userTeamId);
  const captain = [...userSquad]
    .filter((p) => groupOf(p) !== "GK")
    .sort((a, b) => b.attributes.overall - a.attributes.overall)[0];
  if (captain) captain.isCaptain = true;

  // 재정 + 계약(주급의 원본)
  const finances: TeamFinance[] = catalogTeams.map((t) => {
    const f = initialFinanceOf(t.id, t.tier);
    return {
      teamId: t.id,
      balance: f.balance,
      transferBudget: f.budget,
      ledger: [],
      prizesPaid: [],
    };
  });
  const wages = initialWages(players, calendar.preseasonStart);
  const contracts: Contract[] = players.map((p, i) => ({
    id: `c-${p.id}`,
    gamePlayerId: p.id,
    teamId: p.teamId,
    weeklyWage: wages.get(p.id) ?? 0,
    since: calendar.preseasonStart,
    // 계약 만료를 1~4년 뒤로 분산 (재계약 서사의 씨앗)
    until: `${2026 + (1 + (i % 4))}-06-30`,
    status: "active",
  }));

  // 일정 — 전 리그 + 유럽 대항전 경기 + 이적창 개장/폐장
  const windows = buildTransferWindows(season);
  // 다른 리그도 같은 캘린더 골격으로 동시에 진행된다
  const euroEntrants = hasCups(world) ? buildEuroEntrants(season, seed) : [];
  const matches = buildSeasonFixtures(season, seed, euroEntrants, world);
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
  const state: GameState = {
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
    ...(world ? { world } : {}),

    teams,
    players,
    tactics,
    finances,
    financeReports: [],
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
    settlingEvents: [],
    transferList: [],
    playerTraining: [],
    roleMemory: [],
    aiDeals: [],
    negotiations: [],
    pressConferences: [],

    manager: {
      name: input.managerName,
      background: input.background,
      attributes: input.attributes,
      reputation: { board: 50, media: 50, squad: 50 },
    },
    managerXP: { leadership: 0, tactics: 0, training: 0, negotiation: 0, analysis: 0 },
    // 부임하면 사람이 먼저 기다린다 — 수석코치는 시드로 결정되므로
    // 같은 세이브는 언제 열어도 같은 사람이다 (persona.ts)
    personas: [
      generateHeadCoach(seed, input.userTeamId),
      generateOwner(seed, input.userTeamId),
      // 기자단 — 회견은 세계가 먼저 부르는 자리라 부를 사람이 세이브에 있어야 한다
      ...generateReporters(seed, input.userTeamId),
    ],
    formUnitScale: true,
    seasonRecords: [],
    trophies: [],
    achievements: [],

    narrative: [],
    chat: [],
  };

  // 국내 컵 1라운드 추첨일을 미리 달력에 올린다 — tick을 기다리면 부임 첫날의
  // 달력이 비어 보인다 ("리그컵 추첨이 7월 말"이라는 사실은 시작부터 알 수 있다)
  if (hasCups(world)) advanceDomesticCups(state, []);
  // 기본 훈련 — 감독이 부임하기 전부터 팀은 훈련하고 있었다 (training-plan.ts)
  installDefaultTraining(state);
  /**
   * 부임 전 부상 이력 — 선수들에겐 감독을 만나기 전의 몸이 있다 (injury.ts).
   * 조사된 선수만 채워지고, 복귀일이 아직 안 온 선수는 다친 채로 인계된다.
   */
  seedInjuryHistory(state);
  return state;
}

// ── 스쿼드 하한·배치 정리 — 떠남을 다루는 모든 경로가 함께 쓴다 ──

/** 매각·방출·임대 뒤 유지해야 하는 최소 인원 */
export const MIN_SQUAD_AFTER_SALE = 18;

/**
 * 이 선수가 빠지면 스쿼드가 무너지는가 — 무너지면 그 이유를 돌려준다.
 * `negotiation`·`departures`가 함께 쓰므로 여기 둔다(둘이 서로를 import하면 순환).
 */
export function squadShortfall(
  state: GameState,
  teamId: string,
  leaving: { id: string },
): string | null {
  const remaining = playersOf(state, teamId).filter((p) => p.id !== leaving.id);
  if (remaining.length < MIN_SQUAD_AFTER_SALE) {
    return `스쿼드가 ${MIN_SQUAD_AFTER_SALE}명 아래로 내려가 팔 수 없습니다`;
  }
  if (remaining.filter((p) => groupOf(p) === "GK").length < 2) {
    return "골키퍼가 2명 아래로 내려가 팔 수 없습니다";
  }
  return null;
}

/** 떠난 선수를 전술 배치에서 뺀다 */
export function releaseFromTactics(state: GameState, teamId: string, playerId: string): void {
  const tactics = tacticsOf(state, teamId);
  tactics.assignments = tactics.assignments.filter((a) => a.playerId !== playerId);
}

// ── 화면 조작 모으기 ────────────────────────────────────

/** 한 턴에 모델이 읽는 조작 줄 수 상한 — 프롬프트가 조작 로그로 덮이지 않게 */
export const PENDING_EDIT_LIMIT = 12;

/**
 * 화면 조작을 한 줄 남긴다 — **같은 대상은 접힌다.**
 *
 * 감독이 역할을 A→B→C로 눌러 보면 남는 건 "→ C" 하나다. 과정이 아니라
 * **결과**가 모델이 반응할 거리이기 때문이다.
 */
export function recordEdit(state: GameState, key: string, text: string): void {
  const edits = (state.pendingEdits ??= []);
  const entry = { key, text, at: state.date };
  const index = edits.findIndex((e) => e.key === key);
  if (index >= 0) edits[index] = entry;
  else edits.push(entry);
  if (edits.length > PENDING_EDIT_LIMIT) edits.splice(0, edits.length - PENDING_EDIT_LIMIT);
}

/** 모아 둔 조작을 꺼내 비운다 — 턴이 성공적으로 끝날 때 부른다 */
export function takeEdits(state: GameState): PendingEdit[] {
  const edits = state.pendingEdits ?? [];
  state.pendingEdits = [];
  return edits;
}
