import type {
  Achievement,
  Approach,
  ApproachPressure,
  BoardDemand,
  PressLeak,
  AxisValues,
  Booking,
  CharacterInjection,
  CharacterMemory,
  Contract,
  DeferredScout,
  FinanceReport,
  Formation,
  GamePlayer,
  GameTeam,
  GrowthEntry,
  HistoryDigest,
  Injury,
  LeagueFinalTable,
  Dismissal,
  Manager,
  ManagerAttributes,
  ManagerOffer,
  ManagerVacancy,
  MatchRecord,
  MatchSide,
  NarrativeArc,
  NarrativeNote,
  PaymentSchedule,
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
  ShootoutKick,
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
  FAMILIARITY_BASELINE,
  MANAGER_TERMS_BY_TIER,
  FORMATIONS,
  FIRST_TEAM_LIMIT,
  MATCHDAY_BENCH,
  MATCHDAY_SQUAD,
  bestOverall,
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
  contractUntil,
  FIRST_SEASON,
  seasonYear,
  type SeasonCalendar,
} from "../competition/calendar";
import { rankByName } from "./name-match";
import { tierOfTeamIn } from "./club-tier";
import { defaultXiIds, playerCatalog } from "../world/catalog";
import { estimateSquadWages, wageSubjectOf } from "../world/wages";
import { clubEconomyLevel } from "../data/league-economy";
import { worldFigureManagerOf } from "../data/world-figures";
import { generateYouthPlayer } from "../world/generate";
import { ensureSquadNumbers } from "../squad/numbers";
import { hasCups, scopedTeams, type WorldScope } from "../world/scope";
import {
  TEAM_CATALOG_SEED,
  teamCatalog,
  type TeamCatalogEntry,
  countryOfTeam,
  formationOf,
  isTopFlight,
  leagueOfTeam,
  tacticalStyleOf,
  teamCatalogById,
  isClubTeam,
} from "../data/team-catalog";
import {
  CLUB_PROFILES_SEED,
  clubProfile,
  clubProfiles,
  type ClubProfile,
} from "../data/club-profile";
// 순환 참조로 보이지만 안전하다 — domestic-cup은 state의 함수를 **런타임에만** 부르고,
// 여기서도 모듈 로드가 끝난 뒤(createGame 호출 시점)에만 부른다.
import { advanceDomesticCups } from "../competition/domestic-cup";
import { buildEuroEntrants, type EuroEntry } from "../competition/europe";
import { buildSeasonFixtures, isUserFixture } from "../competition/fixtures";
import { seedInjuryHistory } from "../squad/injury";
import {
  generateHeadCoach,
  generateOwner,
  generateReporters,
  occupiedPersonNames,
  seededVirtualManagerName,
} from "../world/persona";
import { makeRng, randInt } from "./rng";
// domestic-cup과 같은 이유로 안전하다 — training-plan은 state를 **타입으로만** 읽는다
import { installDefaultTraining } from "../squad/training-plan";

/** 감독이 화면에서 직접 바꾼 것 한 줄 — GM이 읽고 나면 사라진다 */
export interface PendingEdit {
  /** 접기 키 — 같은 키의 조작은 마지막 것만 남는다 (`role:p-123`, `lineup`) */
  key: string;
  text: string;
  at: string;
}

/**
 * 항목 하나 — **값과 갈래를 갈라 낸다.**
 *
 * 붙여 쓰면(`매주 5회 × 6주 — 패스·시야`) 화면이 그걸 되쪼개야 하고, 안 쪼개면
 * 값도 갈래도 같은 굵기로 눌려 무엇이 바뀌었는지가 안 읽힌다. 무엇을 강조할지는
 * 화면이 정하되 **어디까지가 값인지는 코어만 안다** — 그래서 코어가 나눠 낸다.
 */
export interface SkillBriefItem {
  /** 무엇에 대한 것인가 — 한 톤 낮춰 **앞에** 선다 (`선발 투입`, `포메이션`) */
  label?: string;
  /** 바뀐 값 — 항목에서 가장 또렷한 자리 (`김민재 외 2명`, `4-4-2 → 4-3-3`) */
  text: string;
  /** 그 값의 갈래·부연 — 한 톤 낮춰 **뒤에** 선다 (`패스·시야`, `적응도 62`) */
  note?: string;
}

/**
 * **스킬 결과의 구조화 요약** — 머리줄 하나와 항목 몇 개.
 *
 * 화면은 항목을 그대로 세우고 넘치면 접는다 (`PanelHint.more`) — 요약 문자열을
 * 되쪼개지 않는다. `summary`는 LLM에게 돌려주는 줄로 남는다.
 *
 * ⚠️ **항목 하나는 한 줄에 든다.** 건수와 갈래까지만 적고, LLM이 쓴 자유 문장은
 * 싣지 않는다 (그 문장은 장면과 서사 로그에 이미 있다).
 */
export interface SkillBrief {
  /** 무엇을 했나 — 스킬 이름값의 짧은 머리줄 (`라인업 확정`) */
  head: string;
  /** 무엇이 바뀌었나 — 각 항목이 말풍선 한 줄이다 */
  items: SkillBriefItem[];
}

export interface ToolCallRecord {
  name: string;
  summary: string;
  /**
   * 화면이 항목으로 세우는 요약 — 없으면 `summary` 문자열로 폴백한다
   * (옛 세이브의 기록에는 없다).
   */
  brief?: SkillBrief;
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
/** 채팅 턴 — 도구 호출 기록 포함 (UI가 스킬 칩으로 렌더) */
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
   * 이 턴에 실린 **인물지** — 카드 텍스트가 아니라 **기록**이다 (people.md §6).
   *
   * 이력은 매 턴 `state.chat`에서 다시 렌더링되므로 남길 것은 누구를 어느 깊이로
   * 실었는가뿐이고, 카드는 그 턴을 렌더링할 때 다시 붙는다. 텍스트를 저장하면
   * 채팅 화면에 프롬프트가 새고, 이력이 세이브 시점의 문장으로 굳는다.
   * 옛 세이브엔 없다 — optional이라 세이브 버전을 올리지 않는다.
   */
  characters?: CharacterInjection[];
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
   * **실제로 밟은 자리** (선수 id → 포지션 코드) — 양 팀 것이 함께 쌓인다.
   *
   * 자리를 정하는 곳은 패킷을 세우는 `slotsFor` 하나다(교체는 빈 자리를 잇고,
   * 로테이션은 사람과 함께 자리를 옮긴다). 그래서 그때 남기고, 경기 뒤 포지션
   * 적응도가 이 값을 읽는다 — 저장된 배치를 읽으면 교체 투입자가 그라운드에서
   * 서 본 적 없는 벤치 배치의 자리로 오른다 (match.md §6).
   * 옛 세이브엔 없다 — 없으면 배치·주 포지션으로 읽는다 (optional).
   */
  positionsPlayed?: Record<string, string>;
  /**
   * **구간 시뮬의 연속 시계** — 앞 구간이 사건을 굴리다 멈춘 소수 시각.
   *
   * 장부의 분은 정수라 사건이 실릴 때 소수가 잘린다. 그 잘린 분에서 다음 구간이
   * 출발하면 정지점마다 최대 1분이 두 번 굴려져 한 경기의 슈팅이 패킷 기대치를
   * 넘는다(match.md §1.4). 여기 이어 두면 구간이 몇 번으로 끊기든 총량이 같다.
   * 옛 세이브엔 없다 — 없으면 장부의 분에서 잇는다 (optional).
   */
  segmentClock?: number;
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
   * 적응도가 **쌓이는** 것은 훈련·경기 결산 판정이지 경기 중의 조정이 아니다.
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
      /**
       * 오늘 낸 역할 대가의 장부도 함께 담는다 — 적응도만 되돌리고 `paid`를 두면
       * 경기 뒤에 "낸 적 없는 값"을 환불받는다 (player.md §7.2). 옛 세이브엔 없다.
       */
      roleMemo?: import("@story-fm/domain").RoleMemo;
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
   * **승부차기가 남았을 때만** — 장부는 `finished`지만 경기는 끝나지 않았다.
   *
   * 120분이 끝났는데 승부가 남은 감독의 경기에서만 선다(`advanceMatchTo`가 세운다).
   * 킥 목록이 원본이고 합계는 세지 않는다(`shootoutTally`). 옛 세이브엔 없다
   * (optional — SAVE_VERSION 유지).
   */
  shootout?: {
    /** 먼저 차는 쪽 — 동전이 정한다 (`shootoutFirst`) */
    first: MatchSide;
    kicks: ShootoutKick[];
    /** 감독이 지시한 키커 순서 (선수 id) — 없으면 기본 순서 */
    order?: { home?: string[]; away?: string[] };
  };
  /**
   * **상대가 경기 중 바꾼 전술** — 이 경기에만 유효하다.
   *
   * 팀의 저장된 전술(`state.tactics`)은 건드리지 않는다. 리그 전체 AI가 경기마다
   * 전술을 흘리면 다음 경기의 상대가 왜 그런 모양인지 아무도 설명할 수 없다.
   * pendingMatch와 함께 사라지므로 되돌릴 것도 없다.
   */
  aiTactics?: import("@story-fm/domain").TacticsSpec;
  /**
   * **상대가 경기 중 갈아 깐 판의 모양** — 이 경기에만 유효하다 (match.md §2).
   *
   * 저장된 배치(`state.tactics`)는 건드리지 않는다. 여기 이름 하나만 남기고
   * 좌표는 패킷을 세울 때마다 다시 앉히므로(`reseatOnAiShape`), 교체로 사람이
   * 바뀌어도 판은 갈아 깐 그 모양 그대로다. 되돌릴 자리가 필요 없는 이유이기도
   * 하다 — pendingMatch와 함께 사라진다. 옛 세이브엔 없다 (optional).
   */
  aiShape?: {
    formation: import("@story-fm/domain").Formation;
    /** 어느 쪽으로 던진 판인가 — 경기당 한 번이라 이 값이 서면 다시 묻지 않는다 */
    intent: "chase" | "hold";
  };
  /**
   * **상대 벤치가 마지막으로 판단한 분.**
   *
   * 짧게 부른 구간(`maxMinutes`)이 판단 자리를 여는 간격을 여기서 잰다
   * (`AI_BRIEF_GAP`). 구간 횟수로 세면 감독이 말을 걸수록 상대가 빨라지거나
   * 얼어붙는다. 옛 세이브엔 없다 (optional).
   */
  aiDecidedAt?: number;
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
  /**
   * 지난 시즌들의 리그 최종 순위 — 구단 체급 재산정의 성적 축이 읽는다
   * (team.md §2.1). 시즌 전환에서 승강을 적용하기 **전에** 그해 리그전을 돈 리그마다
   * 한 줄씩 남기고 최근 세 시즌만 든다. 새 시즌의 일정이 옛 경기를 밀어내므로
   * (`state.matches` 교체) 순위표로 되돌릴 수 없는 값이다.
   * 옛 세이브엔 없다 (optional — SAVE_VERSION 유지).
   */
  leagueHistory?: LeagueFinalTable[];

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
   * 기본값 대신 이 값에서 시작한다 (→ docs/data/player.md §3.2).
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
   * **AI 이적 계획이 덮은 마지막 날.** 이 날에 이르러야 다음 주치를 세운다
   * (`ai-market.ts`) — 큐가 비었는지로 재면 성사가 없는 주에 매일 다시 계획한다.
   * 옛 세이브엔 없다 (없으면 그날 바로 한 번 계획한다 — 세이브 버전은 그대로).
   */
  aiPlannedThrough?: string;
  /**
   * **경질됐다** — 있으면 감독은 더 이상 이 구단의 사람이 아니다. 시계는 그대로
   * 흐르고(무직), 새 자리에 부임하면 지워진다 (career.md §5.1). 옛 세이브엔 없다.
   */
  dismissal?: Dismissal;
  /**
   * **경질 이력** — 부임이 `dismissal` 카드를 지울 때 여기로 옮겨 남는다 (career.md §6).
   * 잘린 시즌은 `SEASON_RECORD`가 없으므로 커리어 표가 그 해의 경질 줄을 여기서
   * 읽는다. 옛 세이브엔 없다 (optional — SAVE_VERSION 유지).
   */
  dismissals?: Dismissal[];
  /**
   * **감독직 제안** — 공석이 된 구단이 무직 감독을 부른 기록 (career.md §5.1).
   * 만료·수락한 것도 남는다 — 같은 무직 기간에 같은 구단이 다시 부르지 않게 하는
   * 근거다. 옛 세이브엔 없다 (optional — SAVE_VERSION 유지).
   */
  managerOffers?: ManagerOffer[];
  /**
   * **공석 명부** — AI 구단이 감독을 자른 자리, 무직인 동안만 쌓인다
   * (career.md §5.1). 무직 감독이 먼저 지원하는(`apply_manager_job`) 문이고,
   * 14일 뒤 지워진다. 옛 세이브엔 없다 (optional — SAVE_VERSION 유지).
   */
  managerVacancies?: ManagerVacancy[];
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
  /**
   * **아직 GM이 읽지 않은 경기 밖 소식** — 우리 경기 결산이 함께 굴린 것들.
   *
   * 경기 하나가 끝나면 코어는 그 라운드의 다른 경기·대항전 대진·재정까지 굴린다
   * (`finalizeMatch`). 그건 감독이 확인하러 갈 화면(대회·재정)이 이미 갖고 있는
   * 내용이라 **알림에는 싣지 않는다** — 대신 모델은 알아야 한다. 순위가 뒤집힌
   * 걸 모른 채 다음 장면을 쓰면 세계가 감독의 경기 하나로 멈춘 것처럼 읽힌다.
   *
   * `pendingEdits`와 같은 규약이다 — 모아 두었다가 다음 평시 턴에 한 번 읽히고
   * 비워진다(`takeNews`). 옛 세이브엔 없다 (optional — SAVE_VERSION 유지).
   */
  pendingNews?: string[];
  /**
   * **아직 카드로 세우지 않은 스카우트 보고서** — 도착한 선수의 id.
   *
   * 카드는 모델이 그 값을 읽은 턴에만 선다. 시계가 도는 자리가 둘이라 그렇다 —
   * 손잡이로 넘긴 턴은 코어가 장면보다 **먼저** 굴러 같은 턴에 읽히지만, 모델이
   * 장면 헤더로 옮긴 턴은 코어가 장면 **뒤에** 구른다. 뒤쪽에서 그냥 카드를
   * 붙이면 모델은 못 읽은 금액을 지어내고, 카드와 대사가 갈린다
   * (→ [docs/llm/agents.md](../../../../docs/llm/agents.md) §6).
   *
   * `pendingNews`와 같은 규약이다 — 모아 두었다가 스냅샷에 실린 턴에 비워진다
   * (`takeReportCards`). 옛 세이브엔 없다 (optional — SAVE_VERSION 유지).
   */
  pendingReportCards?: string[];
  /** 스카우트 파견·완료 이력 — 타 팀 선수 안개의 근거 (scouting.ts) */
  scoutReports: ScoutReport[];
  /**
   * **못 나간 파견 요청** — 감독이 지목했으나 동시 한도가 차서 나가지 못한 이름.
   *
   * 반려 문구는 그 턴에만 살아 있고 다음 턴 입력에는 남지 않는다. 그 자리가
   * 비면 모델은 "넷째는 어떻게 됐나"를 기억으로 메우고, 부르지 않은 파견을
   * 완료형으로 말한다 — 그래서 사실로 남긴다
   * (→ [docs/data/player.md](../../../../docs/data/player.md) §9.4).
   *
   * 코어는 자리가 나도 대신 보내지 않는다 — 상태 전이는 스킬 한 경로뿐이다.
   * 지우는 것은 `scoutingSummary`를 읽는 쪽이 아니라 파견·만료다
   * (`dropDeferredScout`·`pruneDeferredScouts`). 옛 세이브엔 없다
   * (optional — SAVE_VERSION 유지).
   */
  deferredScouts?: DeferredScout[];
  /** 진행 중 협상 — 며칠에 걸쳐 오퍼가 오가므로 파생으로 되돌릴 수 없다 */
  negotiations: Negotiation[];
  /**
   * 기자회견 — 열린 시점과 답한 시점이 갈리므로(감독이 다음 날 답할 수도 있다)
   * 협상처럼 세이브가 들고 있어야 한다. 옛 세이브엔 없다(로드 시 빈 배열).
   */
  pressConferences?: PressConference[];
  /**
   * 다가옴 — 압력이 임계를 넘어 코어가 연 자리 (people.md §8). 회견과 같은 이유로
   * 세이브가 든다: 열린 시점과 감독이 답한 시점이 갈린다.
   * 옛 세이브엔 없다 (optional — SAVE_VERSION 유지).
   */
  approaches?: Approach[];
  /**
   * **압력 눈금** — 주제별 누적과 계단 (people.md §8).
   *
   * 세이브가 드는 값 중 장부에서 파생할 수 없는 유일한 것이다. 불만도 순위도 폼도
   * 지금의 사실이지만, 감독이 그것을 **며칠째 그대로 두었는가**는 어디에도 원본이
   * 없다. 옛 세이브엔 없다 (optional — SAVE_VERSION 유지).
   */
  approachPressure?: ApproachPressure[];
  /**
   * 언론 유출 — 사다리 계단 4의 사건 (people.md §8). **다음 회견이 실어 갈 때까지만**
   * 남는다: `openPress`가 소비해 사실 카드로 옮긴다.
   * 옛 세이브엔 없다 (optional — SAVE_VERSION 유지).
   */
  pressLeaks?: PressLeak[];
  /**
   * 보드 요청 — 구단주 원형이 이적창마다 거는 조건 (career.md §5.2). 발행 시점과
   * 판정 시점이 갈리고 발행 순간의 기준값(주급 총액·기준 이적료)을 들므로 세이브가
   * 든다. 옛 세이브엔 없다 (optional — SAVE_VERSION 유지).
   */
  boardDemands?: BoardDemand[];

  // ── 감독 ──
  manager: Manager;
  managerXP: Record<keyof ManagerAttributes, number>;
  seasonRecords: SeasonRecord[];
  trophies: Trophy[];
  achievements: Achievement[];

  // ── 서사 ──
  /**
   * 인물 — 데이터로 다루는 페르소나 (people.md §1). 수석코치·구단주·기자가 한
   * 배열에 붙는다. 옛 세이브엔 없어 optional —
   * 로드 시 시드로 채운다(`ensurePersonas`)므로 세이브 버전을 올리지 않는다.
   */
  personas?: Persona[];
  /**
   * 폼 축이 −1~1로 바뀐 뒤의 세이브인가 — 로드 시 한 번만 옮기기 위한 마커
   * (`persistence.ts`). 없으면 옛 −3~3 세이브로 보고 3으로 나눈다.
   */
  formUnitScale?: boolean;
  /**
   * 미러 자리에 적혀 있던 주발 보정을 이미 벗긴 세이브인가 — 로드 시 한 번만
   * 벗기기 위한 마커 (`core/migrations.ts`). 벗기기는 묶음을 주 포지션 값으로
   * 평평하게 미는 일이라, 마커 없이 매번 돌면 경기·훈련이 LCB·RCB에 쌓은
   * 적응도까지 같이 지운다 (player.md §8).
   */
  mirrorProficiencyStripped?: boolean;
  narrative: NarrativeNote[];
  chat: ChatTurn[];
  /**
   * 이력 압축의 자국 — 없으면 아직 한 번도 접지 않았다
   * (→ [docs/llm/agents.md](../../../../docs/llm/agents.md) §5-1).
   *
   * 접는 것은 프롬프트 조립뿐이라 `chat`은 그대로 남는다. 판정은
   * `core/history-window.ts`의 순수 함수가 한다. 옛 세이브엔 없다
   * (optional — SAVE_VERSION 유지).
   */
  historyDigest?: HistoryDigest;
  /**
   * 인물이 소유하는 기억 — 압축이 남긴다
   * (→ [docs/data/people.md](../../../../docs/data/people.md) §9-1).
   * 옛 세이브엔 없다 (optional — SAVE_VERSION 유지).
   */
  characterMemories?: CharacterMemory[];
  /**
   * 서사 아크 — 기억을 이야기로 엮는 골격 (people.md §9). 개폐는 장부에서
   * 결정적으로 판정한다(`world/arcs.ts`). 옛 세이브엔 없다
   * (optional — SAVE_VERSION 유지).
   */
  arcs?: NarrativeArc[];
  /**
   * 지급 일정 표 — 분할로 합의된 이적료·해지 정산금의 미래 회분
   * (transfer.md §5-2). 옛 세이브엔 없다 (optional — SAVE_VERSION 유지).
   */
  paymentSchedules?: PaymentSchedule[];
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

/**
 * 팀 표시 이름 — **세이브가 없는 문맥**에서만 (새 게임 생성·어드민 미리보기·부임 전
 * 팀 목록). 게임이 진행 중이면 `teamNameIn`을 써야 한다.
 */
export function teamName(teamId: string): string {
  return teamCatalogById(teamId)?.name ?? teamId;
}
export function teamShortName(teamId: string): string {
  return teamCatalogById(teamId)?.shortName ?? teamId;
}

/**
 * 이 팀의 **지금** 이름 — 세이브가 갖고, 없으면(옛 세이브) 카탈로그가 답한다.
 * `tierOfTeamIn`·`leagueOfTeamIn`과 같은 모양이다 (game-state.md §1).
 *
 * 카탈로그를 직접 읽으면 어드민의 이름 편집이 **진행 중인 세이브**의 화면·피드·
 * 서사에 그대로 들어간다 — 감독이 지난주에 상대한 클럽의 이름이 바뀐다.
 */
export function teamNameIn(state: GameState, teamId: string): string {
  return state.teams.find((t) => t.id === teamId)?.name ?? teamName(teamId);
}
export function teamShortNameIn(state: GameState, teamId: string): string {
  return state.teams.find((t) => t.id === teamId)?.shortName ?? teamShortName(teamId);
}

/**
 * 이 구단의 **지금** 구장·브랜드 — 세이브가 갖고, 없으면(옛 세이브·미등재 클럽)
 * 카탈로그가 체급 폴백으로 답한다 (team.md §3).
 *
 * 매치데이 수입과 상업 수입의 기준이라, 카탈로그를 직접 읽으면 어드민의 수용인원
 * 편집이 진행 중인 세이브의 장부를 그 자리에서 바꾼다.
 */
export function clubProfileIn(state: GameState, teamId: string): ClubProfile {
  const team = state.teams.find((t) => t.id === teamId);
  if (team?.capacity !== undefined && team.commercialTier !== undefined) {
    return {
      stadium: team.stadium ?? "",
      capacity: team.capacity,
      commercialTier: team.commercialTier,
    };
  }
  return clubProfile(teamId, team?.tier ?? teamCatalogById(teamId)?.tier ?? 3);
}

/**
 * 이 팀이 **게임이 시작할 때** 속해 있던 리그 — 세이브가 갖고, 없으면(옛 세이브)
 * 카탈로그가 답한다.
 *
 * `leagueOfTeamIn`과 갈리는 것은 승강이다 — 이쪽은 승강 **전**의 원 소속이라,
 * "이 구단이 원래 어느 리그의 클럽인가"를 묻는 자리(브랜드 보정)가 쓴다. 지금
 * 어디 있는가는 언제나 `leagueOfTeamIn`이다 (game-state.md §1).
 */
export function catalogLeagueIn(state: GameState | undefined, teamId: string): string {
  return state?.teams.find((t) => t.id === teamId)?.leagueId ?? leagueOfTeam(teamId);
}

/**
 * 이 클럽의 **세이브에 실린 프로필** — 없으면 null.
 *
 * `clubProfileIn`과 갈리는 것은 폴백이다. 시즌 롤오버의 체급 재산정은 미등재 클럽에
 * 체급 폴백을 쓰면 안 되므로(작년 체급이 올해 규모가 되어 스스로를 재생산한다 —
 * `competition/club-tier-recompute.ts`) "값이 없다"를 그대로 받아야 한다.
 */
export function savedClubProfile(state: GameState, teamId: string): ClubProfile | null {
  const team = state.teams.find((t) => t.id === teamId);
  if (team?.capacity === undefined || team.commercialTier === undefined) return null;
  return {
    stadium: team.stadium ?? "",
    capacity: team.capacity,
    commercialTier: team.commercialTier,
  };
}

/**
 * 카탈로그 팀 하나를 `GAME_TEAM`의 사본 필드로 — 새 게임과 로드 시 보충이 같은
 * 목록을 쓴다. 프로필은 **등재된 클럽만** 싣는다 (team.md §1).
 */
function copiedTeamFields(
  team: TeamCatalogEntry,
  profile: ClubProfile | undefined,
): Pick<
  GameTeam,
  "name" | "shortName" | "leagueId" | "tier" | "stadium" | "capacity" | "commercialTier"
> {
  return {
    name: team.name,
    shortName: team.shortName,
    leagueId: team.leagueId,
    tier: team.tier,
    ...(profile === undefined
      ? {}
      : {
          stadium: profile.stadium,
          capacity: profile.capacity,
          commercialTier: profile.commercialTier,
        }),
  };
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

/**
 * **감독이 지금 맡고 있는 팀** — 경질돼 무직이면 없다 (career.md §5.1).
 *
 * `userTeamId`는 경질된 뒤에도 옛 구단을 가리킨다. 그 구단의 선수단과 장부는
 * 그대로 돌아야 하기 때문이다 — 세계가 감독을 따라 사라지지는 않는다. 그래서
 * **감독에게 무언가를 적립하는 자리**(트로피·시즌 기록·평판)는 `userTeamId`가
 * 아니라 이것을 물어야 한다. 안 그러면 잘린 뒤 옛 팀이 든 컵이 감독의 것이 된다.
 */
export function managedTeamId(state: GameState): string | null {
  return state.dismissal ? null : state.userTeamId;
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

export function playerName(state: GameState, id: string): string {
  return playerById(state, id)?.name ?? id;
}

export function groupOf(player: GamePlayer): PositionGroup {
  return positionGroupOfPlayer(player);
}

/**
 * 능력치 변경 후 overall 재계산 — **표시용 종합의 단일 공식** `bestOverall`.
 *
 * ⚠️ 보유 자리 목록을 반드시 넘긴다 — 주 포지션 하나로 내면 어드민 표와 게임의
 * OVR이 갈린다 (player.md §4).
 */
export function recomputeOverall(player: GamePlayer): void {
  player.attributes.overall = bestOverall(player.attributes, player.positions);
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
  // 무소속엔 전술이 없다 — 배치가 없는 것이지 오류가 아니다 (team.md §4)
  const tactics = state.tactics.find((t) => t.teamId === p.teamId);
  return tactics?.assignments.find((a) => a.playerId === playerId) ?? null;
}

/** 이 선수의 전술 적응도 — 배치가 없으면 기준선(`FAMILIARITY_BASELINE`, domain) */
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
  FAMILIARITY_BASELINE,
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
/** 이번 주 주급 한 줄 — 선수 한 명이 이 구단에 지우는 부담 */
export interface WeeklyWageLine {
  gamePlayerId: string;
  weekly: number;
}

/**
 * 이 구단의 **선수별 주급 부담** — 합계(`weeklyWagesOf`)와 원장 명세가 같은 값을 본다.
 *
 * **임대는 주급을 나눈다.** 계약은 원소속에 남으므로 합계는 여전히 우리 것인데,
 * 임대 팀이 `wageShare`만큼을 낸다 — 그만큼 우리 부담에서 빠지고 그쪽에 얹힌다.
 * 저장하지 않고 계약 + `GamePlayer.loan`에서 파생한다.
 */
export function weeklyWageLinesOf(state: GameState, teamId: string): WeeklyWageLine[] {
  const byPlayer = new Map<string, number>();
  for (const c of state.contracts) {
    if (c.status === "active" && c.teamId === teamId) byPlayer.set(c.gamePlayerId, c.weeklyWage);
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
    const share = contract.weeklyWage * loan.wageShare;
    if (loan.fromTeamId === teamId) {
      byPlayer.set(player.id, (byPlayer.get(player.id) ?? 0) - share);
    } else if (player.teamId === teamId) {
      byPlayer.set(player.id, (byPlayer.get(player.id) ?? 0) + share);
    }
  }
  const lines: WeeklyWageLine[] = [];
  for (const [gamePlayerId, weekly] of byPlayer) {
    if (weekly > 0) lines.push({ gamePlayerId, weekly });
  }
  return lines;
}

export function weeklyWagesOf(state: GameState, teamId: string): number {
  return weeklyWageLinesOf(state, teamId).reduce((sum, l) => sum + l.weekly, 0);
}

/**
 * 시즌 누적 경고 — BOOKING에서 파생.
 *
 * **한 경기에서 두 장을 받은 경기의 경고는 세지 않는다** — 경고 2회 퇴장은 그 자리에서
 * 퇴장 정지 한 건으로 값을 치렀고, 그 두 장까지 누적에 넣으면 한 사건에 정지가 두 번
 * 걸린다 (match.md §5). 장부의 두 줄은 그대로 둔다 — 경기 기록은 실제로 그랬다.
 */
export function seasonYellowsOf(state: GameState, playerId: string, season: number): number {
  const perMatch = new Map<string, number>();
  for (const b of state.bookings) {
    if (b.gamePlayerId !== playerId || b.season !== season || b.card !== "yellow") continue;
    perMatch.set(b.matchId, (perMatch.get(b.matchId) ?? 0) + 1);
  }
  let counted = 0;
  for (const inMatch of perMatch.values()) if (inMatch < 2) counted += inMatch;
  return counted;
}

export function financeOf(state: GameState, teamId: string): TeamFinance {
  const f = state.finances.find((x) => x.teamId === teamId);
  if (!f) throw new Error(`재정 없음: ${teamId}`);
  return f;
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

/** 성장 원장 보관 한도 — 서사와 같은 이유로 오래된 것부터 버린다 */
const GROWTH_LOG_LIMIT = 4000;

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
  if (state.growthLog.length > GROWTH_LOG_LIMIT) {
    state.growthLog.splice(0, state.growthLog.length - GROWTH_LOG_LIMIT);
  }
}

/**
 * 서사 노트 보관 한도 — 넘치면 **오래된 것부터** 버린다.
 *
 * 세이브에 통째로 담기고 GM 프롬프트의 이력 층이 여기서 나오므로, 한도가 곧
 * 세이브 크기이자 컨텍스트 비용이다.
 */
const NARRATIVE_LIMIT = 200;

export function pushNarrative(state: GameState, text: string, salience = 2): void {
  state.narrative.push({ date: state.date, text, salience });
  if (state.narrative.length > NARRATIVE_LIMIT) {
    state.narrative.splice(0, state.narrative.length - NARRATIVE_LIMIT);
  }
}

/**
 * 무게의 반감기 — 이 일수가 지날 때마다 사건의 무게가 절반이 된다.
 *
 * salience 5는 반감기를 네 번 지나야 오늘의 1 아래로 내려간다 — 지난주의 경질
 * 임박이 어제의 스카우트 한 줄에 밀리지 않는 눈금이다 (people.md §9).
 */
const NARRATIVE_HALF_LIFE_DAYS = 7;

/**
 * 스냅샷에 실을 서사 기억 — **salience×recency 가중 상위 `limit`건** (people.md §9).
 *
 * 최신순이 아니다: `slice(-4)`는 무게 5의 사건을 나흘 만에 밀어냈다. 가중치가
 * 같으면 최신이 이기고, 뽑힌 뒤에는 시간순으로 선다 — GM이 읽는 것은 순위가 아니라
 * 흐름이다. 결정적이다 — 같은 날 같은 세이브면 같은 목록.
 */
export function topNarrative(state: GameState, limit: number): NarrativeNote[] {
  const day = (d: string) => new Date(`${d}T00:00:00Z`).getTime() / 86400000;
  const today = day(state.date);
  return state.narrative
    .map((note, index) => ({
      note,
      index,
      weight:
        note.salience *
        Math.pow(0.5, Math.max(0, today - day(note.date)) / NARRATIVE_HALF_LIFE_DAYS),
    }))
    .sort((a, b) => b.weight - a.weight || b.index - a.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map((x) => x.note);
}

/** id를 이룰 수 있는 문자 — 앞뒤에 이것이 붙어 있으면 그 id가 아니라 더 긴 id의 일부다 */
const ID_EDGE = "[\\w-]";

/**
 * 서사 텍스트의 선수 id를 이름으로 치환 — LLM 출력이 id를 흘릴 때 대비.
 *
 * ⚠️ **낱말 경계에서만 바꾼다.** 부분 문자열까지 치우면 `rodri`가 `rodrigo-muniz`를
 * 반쪽만 먹어 "로드리go-muniz"가 되고, 동명이인을 가르는 `-<생년>` 꼬리가 붙은 id는
 * 전부 다른 사람 이름으로 바뀐다. 한 번에 지나가며 긴 id를 먼저 보는 것도 같은 이유다 —
 * 이미 바꾼 자리를 다음 id가 다시 훑지 않는다.
 */
export function humanizePlayerIds(state: GameState, text: string): string {
  const hits = state.players
    .filter((p) => text.includes(p.id))
    .sort((a, b) => b.id.length - a.id.length);
  if (hits.length === 0) return text;
  const names = new Map(hits.map((p) => [p.id, p.name]));
  const ids = hits.map((p) => p.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`(?<!${ID_EDGE})(?:${ids})(?!${ID_EDGE})`, "g");
  return text.replace(pattern, (id) => names.get(id) ?? id);
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
 * (`initialFinanceOf` — finance.md §6.2).
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
 * ⚠️ **채워 넣는 것은 코드의 시드 카탈로그에 있는 클럽뿐이고, 값도 시드에서
 * 복사한다.** 지금 유효한 카탈로그는 어드민 오버라이드일 수 있으므로, 그것을 읽으면
 * 어드민이 팀 하나를 추가할 때마다 **열려 있는 모든 옛 세이브**에 그 클럽과 스쿼드가
 * 주입된다 — 편집이 새 게임에만 반영된다는 약속이 로드 경로로 뚫린다
 * (game-state.md §6).
 *
 * @returns 추가된 클럽 수 (0이면 최신 세이브)
 */
/**
 * 세계 인물 명부가 이 벤치에 세운 감독 — 없으면 빈 객체다 (people.md §2-1).
 *
 * **명부가 이름을 심는 자리는 여기 하나뿐이다.** 심고 나면 그 사람이 어디에 있는지는
 * 명부가 아니라 `managerName`이 답한다 — 경질과 선임은 감독 시장의 일이고
 * (`market/manager-market.ts`), 인물지에 변하는 값을 넣지 않는다는 원칙이 여기서도 같다.
 *
 * **유저가 맡은 팀은 비운다** — 그 자리를 감독(유저)이 받았으므로 명부의 그 사람은
 * 이 세계에 부임한 적이 없다 (`worldFigures`가 후보에서도 뺀다).
 */
function seededManagerName(
  teamId: string,
  state: { userTeamId: string },
): { managerName?: string } {
  if (teamId === state.userTeamId) return {};
  const figure = worldFigureManagerOf(teamId);
  return figure ? { managerName: figure.name } : {};
}

/**
 * 이름 없는 벤치를 전부 채운다 — 명부의 감독이 먼저, 나머지는 가상 이름이다
 * (people.md §2). 세계 생성과 로드 보정이 같은 길을 지난다.
 *
 * 옛 세이브의 AI 구단은 감독 이름이 없을 수 있다(명부 밖 구단은 경질이 한 번 돌기
 * 전까지 없었다). `ensurePersonas`와 같은 결의 보정이라 **세이브 버전을 올리지
 * 않는다** — 없던 필드를 채우는 것이고, 가상 이름이 (시드, 팀) 채널로 결정적이라
 * 채워도 그 세이브의 사람은 같다.
 *
 * ⚠️ **이미 이름이 있으면 건드리지 않는다.** 그 벤치는 감독 시장이 한 번 다녀간
 * 자리일 수 있고, 덮으면 경질된 사람이 로드할 때마다 되살아난다.
 *
 * ⚠️ **유저 팀 벤치는 채우지 않는다** — 그 자리는 유저의 것이다. 로드 순서상
 * `ensurePersonas` 뒤에 돌아야 우리 구단 인물의 이름을 피해서 뽑는다
 * (`persistence.ts`).
 */
export function ensureSeededManagers(state: GameState): void {
  const taken = occupiedPersonNames(state);
  for (const team of state.teams) {
    if (team.managerName !== undefined || !isClubTeam(team.id)) continue;
    if (team.id === state.userTeamId) continue;
    const name =
      worldFigureManagerOf(team.id)?.name ?? seededVirtualManagerName(state.seed, team.id, taken);
    team.managerName = name;
    taken.add(name);
  }
}

export function addMissingClubs(state: GameState): number {
  const present = new Set(state.teams.map((t) => t.id));
  const seed = new Map(TEAM_CATALOG_SEED.map((t) => [t.id, t]));
  // 축소 세계는 빠진 게 아니라 원래 없는 것이다 — 채워 넣으면 세계가 커진다
  const missing = scopedTeams(state.world)
    .map((t) => seed.get(t.id))
    .filter((t): t is TeamCatalogEntry => t !== undefined && !present.has(t.id));
  if (missing.length === 0) return 0;

  const rng = makeRng(state.seed, "backfill:ai-managers");
  // 빠진 클럽만 인스턴스화한다 — 게임 목록은 세이브마다 로드하므로
  // 전 카탈로그(6,000명+)를 매번 만들면 목록 화면이 눈에 띄게 느려진다
  const added = instantiatePlayers(state.seed, (teamId) => !present.has(teamId));
  const wages = initialWages(added, state.date);

  for (const team of missing) {
    state.teams.push({
      id: team.id,
      ...copiedTeamFields(team, CLUB_PROFILES_SEED[team.id]),
      // 감독은 클럽에만 있다 — 무소속은 클럽이 아니다 (team.md §4)
      ...(isClubTeam(team.id)
        ? { aiManagerTacticsRating: randInt(rng, 55, 82), ...seededManagerName(team.id, state) }
        : {}),
    });
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
  const seasonStartYear = seasonYear(FIRST_SEASON);
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
     * **1군 상한에서 끊는다.** 등록 명단(25)은 만 21세 초과만 세므로 U21을 붙이는
     * 만큼 1군이 불어난다 — 말라가가 등록 25 + U21 7명으로 서른둘이었다.
     * 우선순위가 낮은 쪽부터 2군으로 내리되 **코어는 건드리지 않는다**: 코어를
     * 내리면 선발 XI를 세울 수 없다.
     */
    let over = squad.filter((p) => p.squadLevel === "first").length - FIRST_TEAM_LIMIT;
    for (let i = ordered.length - 1; i >= 0 && over > 0; i--) {
      const player = ordered[i];
      if (!player || player.squadLevel !== "first" || core.has(player.id)) continue;
      player.squadLevel = "reserve";
      over -= 1;
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
    // 이름도 팀 안에서 유일해야 한다 — 1군 명단을 쥐고 시작한다 (people.md §2)
    const takenNames = new Set(squad.map((p) => p.name));
    for (let i = reserveCount; i < RESERVE_TEAM_SIZE; i++) {
      const youth = generateYouthPlayer(
        seed + 17,
        team.id,
        0,
        i,
        team.tier,
        takenIds,
        undefined,
        seasonStartYear,
        takenNames,
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
 * ⚠️ 적응도 팩터는 sim에서 가져온다. 여기에 같은 식을 다시 쓰면 배치가 고른
 * 자리와 경기가 계산하는 자리가 조용히 갈린다.
 */
function slotStrength(p: GamePlayer, slot: string): number {
  return roleFit(p.attributes, slot) * profFactor(proficiencyAt(p, slot));
}

/**
 * 이 스쿼드로 그 모양을 세우면 나오는 **전력**.
 *
 * ⚠️ 채점 전에 **자리를 제대로 배치해야** 한다. `roleFit`만 보고 그리디로 채우면
 * 라이스가 라이트백에, 요케레스가 윙에 서는 라인업이 나오고, 그 배치의 합으로
 * 모양이 정해진다. 배치는 실제 라인업과 같은 기준(`lineupFit`: 포지션 적응도 +
 * OVR + 포지션군)으로 뽑고, **전력 합은** 그렇게 뽑힌 11명의 존 기여로 낸다.
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
 * `proficiencyAt`이 포지션 배열을 훑으므로 캐시가 없으면 새 게임 하나에 100만 번
 * 가까이 불린다.
 *
 * `preferred`를 주면 지정 선발 가산까지 얹은 **실제 라인업과 같은 잣대**가 된다 —
 * 모양을 고르는 쪽과 자리를 앉히는 쪽이 다른 점수를 쓰면, 세울 수 있는 모양인데도
 * 시험 배치에서만 미달자가 나온다.
 */
function memoFit(preferred?: ReadonlySet<string>): (p: GamePlayer, slot: string) => number {
  const cache = new Map<string, number>();
  return (p, slot) => {
    const key = `${p.id}|${slot}`;
    let v = cache.get(key);
    if (v === undefined) {
      // 적응도는 한 번만 — `fillSlots`의 헝가리안이 이 함수를 수만 번 부른다
      const prof = proficiencyAt(p, slot);
      v =
        lineupFit(p, slot, prof) + (preferred?.has(p.id) && prof >= XI_BONUS_FLOOR ? XI_BONUS : 0);
      cache.set(key, v);
    }
    return v;
  };
}

/**
 * 포메이션이 의도하는 공간 사용과 모순되지 않는 초기 운용값.
 *
 * ⚠️ **여섯 축의 리그 평균이 3에 서야 한다.** 3이 중립이고 전술 델타는 3에서의
 * 편차로 계산되므로(`tacticalDeltas`), 프리셋이 한쪽으로 쏠리면 **리그 전체가
 * 같은 방향의 이득과 대가를 달고 선다** — 판세 3×3이 상대와 무관하게 한 방향만
 * 되풀이한다.
 *
 * 그래서 각 스타일은 **올린 축만큼 내린 축을 갖는다** — 점유는 라인과 폭을 올리는
 * 대신 템포와 패스 길이를 내리고, 역습·롱볼은 라인과 압박을 내린다. 프리셋을
 * 고칠 때는 리그 평균을 다시 재라(`docs/simulation/match.md` §1.2).
 */
function initialTactics(
  teamId: string,
  formation: Formation,
): import("@story-fm/domain").TacticsSpec {
  switch (tacticalStyleOf(teamId)) {
    // 라인을 올려 압축하되 천천히 넓게 짧은 패스로 돌린다
    case "possession":
      return {
        formation,
        mentality: 3,
        defensiveLine: 4,
        pressing: 3,
        tempo: 2,
        width: 4,
        passStyle: 2,
      };
    // 앞으로 무게를 싣고 라인을 올려 빠르게 — 대신 좁게 압축한다
    case "high-press":
      return {
        formation,
        mentality: 4,
        defensiveLine: 4,
        pressing: 5,
        tempo: 4,
        width: 2,
        passStyle: 3,
      };
    // 내려서서 기다리다 빠르고 넓게 나간다
    case "transition":
      return {
        formation,
        mentality: 3,
        defensiveLine: 2,
        pressing: 2,
        tempo: 4,
        width: 4,
        passStyle: 4,
      };
    // 내려서서 길게 찬다 — 폭보다 타깃이 먼저다
    case "direct":
      return {
        formation,
        mentality: 3,
        defensiveLine: 2,
        pressing: 2,
        tempo: 4,
        width: 3,
        passStyle: 5,
      };
    // 전부 내린다
    case "low-block":
      return {
        formation,
        mentality: 2,
        defensiveLine: 2,
        pressing: 2,
        tempo: 2,
        width: 2,
        passStyle: 4,
      };
    case "balanced":
      break;
  }
  switch (formation) {
    case "4-3-3":
      return {
        formation,
        mentality: 3,
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
    // 두 줄 넷이 **모양으로** 폭을 만들고 길게 갈 자리를 낸다 — 지시로 더 얹지
    // 않는다(3-5-2와 같은 규칙). 얹어 두면(템포·폭·패스 전부 4) 이 프리셋을 쓰는
    // 구단이 늘어날 때 리그 평균이 통째로 그쪽으로 밀린다. 남기는 것은 두 줄이
    // 내려서 기다린다는 것 하나다.
    case "4-4-2":
      return {
        formation,
        mentality: 3,
        defensiveLine: 2,
        pressing: 3,
        tempo: 3,
        width: 3,
        passStyle: 3,
      };
    // 윙백이 폭을 만드는 모양이라 지시로 더 벌리지 않는다 — 여섯 축 전부 중립
    case "3-5-2":
      return {
        formation,
        mentality: 3,
        defensiveLine: 3,
        pressing: 3,
        tempo: 3,
        width: 3,
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
  const fit = memoFit(wanted);
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

/**
 * **이 선수들이 가장 잘 서는 모양** — 후보 중에서 고른다 (`pickFormation`과 같은 잣대).
 *
 * 경기 중 상대 벤치가 판을 갈아 깔 때 부른다(match.md §2). 어느 프리셋인지는
 * 구간 시뮬이 정할 수 없다 — 센터백이 둘뿐인 팀을 백3에 세우지 않으려면 명단과
 * 적응도를 봐야 하고, 그건 코어만 안다.
 */
export function bestShapeFor(
  players: GamePlayer[],
  candidates: readonly Formation[],
): Formation | null {
  const fit = memoFit();
  let best: Formation | null = null;
  let bestScore = -Infinity;
  for (const formation of candidates) {
    const score = shapeStrength(players, formation, fit);
    if (score > bestScore) {
      bestScore = score;
      best = formation;
    }
  }
  return best;
}

/** 그 모양의 한 자리 — 누가 어느 좌표에 서는가 */
export interface ShapeSeat {
  playerId: string;
  position: string;
  point: import("@story-fm/domain").BoardPoint;
}

/**
 * 프리셋 좌표에 이 선수들을 앉힌다 — **라인업을 짜는 것과 같은 잣대**(`fillSlots`).
 *
 * 인원이 열한 명보다 적으면(퇴장) 앞선 자리부터 채우고 남는 자리는 비운다.
 * 좌표가 원본이고 모양 이름은 그 파생이다 (`shapeOf`).
 */
export function seatOnShape(players: GamePlayer[], formation: Formation): ShapeSeat[] {
  const slots = FORMATION_SLOTS[formation];
  const layout = FORMATION_LAYOUTS[formation];
  return fillSlots(players, slots, memoFit()).flatMap((player, index) =>
    player ? [{ playerId: player.id, position: slots[index]!, point: layout[index]! }] : [],
  );
}

/** 지정 선발 가산이 붙는 최소 적응도 — "그 자리를 볼 수는 있다"의 문턱.
 *  기본 배치 가드(적응도 70 미만 금지)와 같은 눈금이다 — 가산이 그 가드를 뚫으면
 *  안 된다 (사우스햄프턴의 마테우스 페르난데스가 적응도 64로 레프트백에 섰다). */
const XI_BONUS_FLOOR = 70;

/** 지정 선발 가산 — 적합도·OVR 차이(최대 ~110)를 확실히 덮는다. */
const XI_BONUS = 200;

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

  // 지정 선발 가산(`XI_BONUS`)은 **그 자리를 실제로 볼 수 있을 때만** 준다:
  // 카탈로그의 기본 선발은 그 구단의 실제 포메이션에서 뽑힌 11명이라, 프리셋으로
  // 접힌 다른 모양(4백 명단 → 3-5-2)에 그대로 밀어 넣으면 스트라이커가 윙백에
  // 선다. 못 서는 자리는 스쿼드에서 제대로 된 자원이 채우고 밀린 선수는 벤치로
  // 간다 — 감독이 백3로 바꿀 때 실제로 하는 일이다.
  //
  // 포지션군 일치로 재면 안 된다. 4-2-3-1의 넓은 공격 3인은 좌표상 RM/AM/LM이라
  // **미드필더군**인데 그 자리에 서는 건 윙어(FW군)다 — 군으로 막으면 풀럼의
  // 보브·케빈 같은 지정 선발이 통째로 밀려난다. 적응도로 재면 같은 질문에
  // 정확히 답하면서(스트라이커의 윙백 적응도는 40대라 여전히 막힌다) 이 오탐이
  // 사라진다.
  const fit = memoFit(wanted);

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

/** 매치데이 벤치 규모 — 값은 도메인이 하나만 갖는다 (`squad-rules.ts`) */
export { MATCHDAY_BENCH };

export function createGame(input: CreateGameInput): GameState {
  const seed = input.seed ?? randInt(makeRng(Date.now() % 2 ** 31, "seed"), 1, 2 ** 30);
  if (!teamCatalog().some((t) => t.id === input.userTeamId)) {
    throw new Error(`알 수 없는 팀: ${input.userTeamId}`);
  }
  const season = FIRST_SEASON;
  const calendar = buildSeasonCalendar(season);
  const rng = makeRng(seed, "ai-managers");
  const world = input.world;
  const catalogTeams = scopedTeams(world);
  const inThisWorld = new Set(catalogTeams.map((t) => t.id));
  if (!inThisWorld.has(input.userTeamId)) {
    throw new Error(`이 세계에 없는 팀: ${input.userTeamId}`);
  }

  // 카탈로그의 정체성은 여기서 **복사된다** — 이후 어드민이 카탈로그를 고쳐도
  // 이 세이브의 이름·소속·체급·살림은 흔들리지 않는다 (team.md §1)
  const profiles = clubProfiles();
  /**
   * **무소속은 클럽이 아니다** — 팀 엔티티 한 줄만 서고 AI 감독도 부임일도 갖지
   * 않는다 (team.md §4). 로드의 `addMissingClubs`가 만드는 모양과 같다.
   */
  const teams: GameTeam[] = catalogTeams.map((t) => ({
    id: t.id,
    ...copiedTeamFields(t, profiles[t.id]),
    ...(isClubTeam(t.id)
      ? {
          aiManagerTacticsRating: randInt(rng, 55, 82),
          // 부임일 — 감독 시장이 "얼마나 됐나"를 여기서 잰다 (`manager-market.ts`)
          managerSince: calendar.preseasonStart,
          ...seededManagerName(t.id, { userTeamId: input.userTeamId }),
        }
      : {}),
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

  // 전술·배치 — 구단의 기본 포메이션과 기본 선발로 시작한다 (팀 카탈로그).
  // 무소속은 스쿼드도 배치도 없으므로 전술을 만들지 않는다.
  const tactics: TeamTactics[] = teams
    .filter((t) => isClubTeam(t.id))
    .map((t) => {
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

  // 재정 + 계약(주급의 원본) — 무소속은 장부를 갖지 않는다 (team.md §4)
  const finances: TeamFinance[] = catalogTeams
    .filter((t) => isClubTeam(t.id))
    .map((t) => {
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
    until: contractUntil(calendar.preseasonStart, 1 + (i % 4)),
    status: "active",
  }));

  // 일정 — 전 리그 + 유럽 대항전 경기 + 이적창 개장/폐장
  const windows = buildTransferWindows(season);
  // 다른 리그도 같은 캘린더 골격으로 동시에 진행된다
  const euroEntrants = hasCups(world) ? buildEuroEntrants(season, seed) : [];
  const matches = buildSeasonFixtures(
    season,
    seed,
    euroEntrants,
    world,
    undefined,
    input.userTeamId,
  );
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
    approaches: [],
    approachPressure: [],
    pressLeaks: [],
    boardDemands: [],

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
    // 카탈로그는 읽을 때 이미 벗겨져 들어온다(`world/catalog.ts`) — 새 세이브에
    // 벗길 것은 없고, 여기서 서는 자리부터 적립이 쌓인다
    mirrorProficiencyStripped: true,
    leagueHistory: [],
    seasonRecords: [],
    trophies: [],
    achievements: [],

    narrative: [],
    chat: [],
  };

  // 명부 밖 벤치의 가상 감독 — 페르소나 다섯이 선 뒤에 채워야 그 이름들을 피해서
  // 뽑는다. 로드 보정과 같은 채널이라 새 게임과 옛 세이브가 같은 사람을 만난다
  ensureSeededManagers(state);
  // 감독도 계약으로 서 있다 (career.md §5.1) — 부임 구단 등급의 기본 조건.
  // 체급은 세이브가 가지므로 state가 선 뒤에야 읽을 수 있다
  {
    const terms = MANAGER_TERMS_BY_TIER[tierOfTeamIn(state, input.userTeamId)];
    state.manager.contract = {
      salary: terms.salary,
      signedOn: state.date,
      until: contractUntil(state.date, terms.years),
    };
  }
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

/**
 * 떠난 선수를 전술 배치에서 뺀다 — **선반도 함께 비운다.**
 * 적응도는 이 팀의 전술에 대한 값이라 다른 팀에서 뜻이 없다 (player.md §7.3).
 */
export function releaseFromTactics(state: GameState, teamId: string, playerId: string): void {
  // 무소속처럼 전술이 없는 자리에서 오는 선수는 뺄 배치도 없다 (team.md §4)
  const tactics = state.tactics.find((t) => t.teamId === teamId);
  if (!tactics) return;
  tactics.assignments = tactics.assignments.filter((a) => a.playerId !== playerId);
  if (tactics.shelved) tactics.shelved = tactics.shelved.filter((s) => s.playerId !== playerId);
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

/** 모델이 읽을 소식 줄 수 상한 — 한 라운드가 다 실려도 스냅샷이 목록이 되지 않게 */
export const PENDING_NEWS_LIMIT = 20;

/** 경기 밖 소식을 모아 둔다 — 다음 평시 턴의 GM 입력에 실린다 */
export function pushNews(state: GameState, lines: readonly string[]): void {
  if (lines.length === 0) return;
  const news = (state.pendingNews ??= []);
  news.push(...lines);
  if (news.length > PENDING_NEWS_LIMIT) news.splice(0, news.length - PENDING_NEWS_LIMIT);
}

/** 모아 둔 소식을 꺼내 비운다 — `takeEdits`와 같은 자리에서 부른다 */
export function takeNews(state: GameState): string[] {
  const news = state.pendingNews ?? [];
  state.pendingNews = [];
  return news;
}

/**
 * 카드를 기다리는 보고서 수 상한 — 아무도 꺼내지 않는 경로(mock)에서 줄이 무한히
 * 자라지 않게. 실모드는 매 평시 턴 꺼내므로 파견 한도(3) 위로 잘 가지 않는다.
 */
export const PENDING_REPORT_CARD_LIMIT = 12;

/** 아직 카드로 세우지 않은 보고서를 줄에 세운다 — 도착한 순서대로 */
export function pushReportCards(state: GameState, playerIds: readonly string[]): void {
  if (playerIds.length === 0) return;
  const queue = (state.pendingReportCards ??= []);
  for (const id of playerIds) if (!queue.includes(id)) queue.push(id);
  if (queue.length > PENDING_REPORT_CARD_LIMIT) {
    queue.splice(0, queue.length - PENDING_REPORT_CARD_LIMIT);
  }
}

/**
 * 카드로 세울 보고서를 앞에서 `limit`개만 꺼내 비운다.
 *
 * 남은 것은 줄에 그대로 둔다 — 잘라 버리면 며칠을 기다려 산 보고서가 화면에
 * 한 번도 안 뜬다. 다음 턴이 이어서 세운다.
 */
export function takeReportCards(state: GameState, limit: number): string[] {
  const take = Math.max(0, limit);
  const queue = state.pendingReportCards ?? [];
  state.pendingReportCards = queue.slice(take);
  return queue.slice(0, take);
}
