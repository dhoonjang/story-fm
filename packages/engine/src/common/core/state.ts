import type { GameTables } from "../../app/save-schema";
import type {
  ManagerInterview,
  CallUp,
  MediaFact,
  Contract,
  GamePlayer,
  GrowthEntry,
  Injury,
  MatchSide,
  PositionGroup,
  TickEvent,
  SeasonStat,
  SeasonStatTotal,
  ShootoutKick,
  Suspension,
  TacticAssignment,
  TeamFinance,
  TeamTactics,
  TrainingReport,
} from "@story-fm/domain";
import {
  playerOverall,
  FAMILIARITY_BASELINE,
  MATCHDAY_BENCH,
  SET_PIECE_ROLES,
  competitionRowsOf,
  positionGroupOfPlayer,
  sumSeasonStats,
} from "@story-fm/domain";
import type { LiveMatch } from "@story-fm/sim";
import type { SeasonCalendar } from "./calendar";
import { rankByName } from "./name-match";
import { suspensionApplies } from "../data/discipline-catalog";
import type { WorldScope } from "../world/scope";
import { leagueOfTeam, teamCatalogById } from "../data/team-catalog";
import { clubProfile, type ClubProfile } from "../data/club-profile";
import type { EuroEntry } from "../views/europe";

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
export interface CommandBriefItem {
  /** 무엇에 대한 것인가 — 한 톤 낮춰 **앞에** 선다 (`선발 투입`, `포메이션`) */
  label?: string;
  /** 바뀐 값 — 항목에서 가장 또렷한 자리 (`김민재 외 2명`, `4-4-2 → 4-3-3`) */
  text: string;
  /** 그 값의 갈래·부연 — 한 톤 낮춰 **뒤에** 선다 (`패스·시야`, `적응도 62`) */
  note?: string;
  /**
   * 이 항목이 말하는 **증감** — 화면은 이 부호로 색을 준다 (`+2`는 이득, `−1`은 손해).
   *
   * 부호는 숫자로 온다. 화면이 `text`에서 `+`·`−`를 찾아 칠하면 포메이션(`4-2-3-1`)이
   * 같은 자를 지나고, 코어가 문구를 바꾸는 날 색이 조용히 꺼진다. 증감을 말하지 않는
   * 항목에는 달지 않는다 — 0은 "안 움직였다"는 사실이라 그것과 다르다.
   */
  delta?: number;
}

/**
 * **호출 결과의 구조화 요약** — 머리줄 하나와 항목 몇 개.
 *
 * 화면은 항목을 그대로 세우고 넘치면 접는다 (`PanelHint.more`) — 요약 문자열을
 * 되쪼개지 않는다. `summary`는 LLM에게 돌려주는 줄로 남는다.
 *
 * ⚠️ **항목 하나는 한 줄에 든다.** 건수와 갈래까지만 적고, LLM이 쓴 자유 문장은
 * 싣지 않는다 (그 문장은 장면과 서사 로그에 이미 있다).
 */
export interface CommandBrief {
  /** 무엇을 했나 — 그 행동의 이름 (`라인업` · `commands/brief.ts`) */
  head: string;
  /** 무엇이 바뀌었나 — 각 항목이 말풍선 한 줄이다 */
  items: CommandBriefItem[];
}

export interface ToolCallRecord {
  name: string;
  summary: string;
  /**
   * 화면이 항목으로 세우는 요약 — 없으면 `summary` 문자열로 폴백한다.
   */
  brief?: CommandBrief;
  input?: unknown;
  /**
   * 그 호출이 남긴 **구조화된 결과** — 채팅이 카드로 그린다.
   *
   * `summary`(줄글)만으로는 화면이 표를 못 그린다. 그렇다고 문자열을 파싱하면
   * 문구가 바뀔 때마다 조용히 깨진다. 카드를 그리는 호출만 채우고, 없으면 UI는
   * 칩 + 요약으로 폴백한다.
   */
  payload?: unknown;
  /**
   * 이 결과의 **결이 좋은가** — 대화형 스킬(대화·기자회견)의 칩 색.
   *
   * 펼쳐 보지 않아도 잘 풀렸는지는 알아야 하지만, 사기 ±N을 카드로 박으면
   * "말했더니 숫자가 올랐다"가 화면에 남아 대화의 결이 깨진다. 색 하나가 그
   * 사이의 답이다.
   */
  tone?: "good" | "bad";
  /**
   * **화면에 칩으로 세우지 않는다** — 호출이 아니라 코어가 한 일의 기록.
   *
   * 시계 이동(장면 헤더가 민다)처럼 감독이 부른 적 없는 것이 칩으로 뜨면
   * 어드민 도구 목록에 없는 이름이 호출된 것처럼 읽힌다. 기록 자체는 남긴다 —
   * 무슨 일이 있었는지의 감사 흔적이고 그 안에 다이제스트가 들어 있다.
   *
   * 이름으로 거르지 않는 이유는 문자열이 바뀌면 조용히 깨지기 때문이다.
   */
  silent?: boolean;
  /**
   * **장면의 어디에서 불렸나** — 이 호출 직전까지 쓰인 본문 줄 수(헤더 포함).
   *
   * 호출은 대화 한복판에서 불린다. 그 자리를 모르면 화면은 모든 칩을 턴 맨 앞에
   * 몰아 세우고, 감독은 결과를 먼저 본 뒤 장면을 거꾸로 읽는다 — 한 턴에 여러
   * 호출이 걸린 장면에서는 어느 대사가 어느 지시였는지도 흐려진다.
   *
   * 줄 수로 세는 이유는 **본문이 저장 전에 손질되기 때문**이다(선수 id → 이름).
   * 글자 수는 그 손질에 밀리지만 줄은 그대로다. 코어가 스스로 밀어 넣은 기록
   * (시계 이동·경기 마감)에는 자리가 없다 — 모델이 쓴 문장과 짝이 없으므로.
   * 없으면 화면은 턴 맨 앞에 세운다.
   */
  line?: number;
}

/** 채팅 턴 — 도구 호출 기록 포함 (UI가 호출 칩으로 렌더) */
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
   */
  role: "user" | "model" | "operator";
  text: string;
  toolCalls: ToolCallRecord[];
  at: string;
  /**
   * 이 턴에 들어간 골 — **장부의 사건**이지 중계 문장에서 읽어낸 것이 아니다.
   *
   * 골은 판을 뒤집는 유일한 사건인데 중계 문단 한복판에 문장으로만 남으면
   * 스크롤에 묻힌다. 화면이 카드로 세울 수 있게 턴에 함께 남긴다. 골이 없던 턴엔 없다.
   */
  goals?: GoalMark[];
  /** 이 턴에 나온 경고·퇴장 — 골과 같은 자리에 선다 */
  cards?: CardMark[];
  /**
   * 이 턴 앞에서 **코어가 굴린 시간이 남긴 사건들** — 화면이 사건 하나를 카드 하나로
   * 세운다 (overview.md §2 · ui/design-system.md §6).
   *
   * tick의 사건이라 호출 칩이 없어 턴에 남는다. 한
   * 문자열로 이어 붙이면 화면이 되쪼갤 수 없다. 카드가 서는 자리는 장면보다 **앞**이다 —
   * 돌아온 감독이 먼저 읽을 것이 그 사이 벌어진 일이다. 시간이 구르지 않은 턴엔 없다.
   */
  events?: TickEvent[];
  /** Exact book snapshots sent with this input; UI does not render prompt metadata. */
  lorebook?: import("@story-fm/domain").LorebookInjection[];
  /**
   * **경기 중에 오간 말인가** — 이력에서 중계와 평시를 가르는 표식.
   *
   * 평시의 GM과 경기의 중계는 다른 에이전트이고 감독이 거는 말도 다르다(훈련·명단
   * 지시 vs 교체·팀토크). 지나고 나서 대화를 거슬러 읽을 때 그 경계가 없으면
   * 한 시즌치 이력이 한 덩어리로 흐른다.
   *
   * 화면에서 파생할 수도 있지만(그 턴에 `@중계:` 화자가 있는가) 그러면 킥오프
   * 직전 라인업 확인처럼 **경기 중이지만 중계가 말하지 않은 턴**이 빠진다.
   * 없으면 평시 턴이다.
   */
  inMatch?: boolean;
  /**
   * GM이 이 턴 끝에 낸 **감독의 다음 말 한 줄** — 입력창의 placeholder가 된다
   * (docs/common/llm/agents.md §2 · docs/common/ui/design-system.md §6).
   *
   * 감독이 한 말이 아니다. 그래서 `model` 턴에만 있고, 이력·압축 브리프·해석기 입력
   * 어디에서도 읽지 않는다 — 읽는 것은 화면 하나다. 세이브에 남는 이유는 재개한 화면이
   * 같은 자리에서 같은 문장을 세워야 하기 때문이다.
   */
  suggestion?: string;
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
  /**
   * **실시간 경기의 확정 상태** — 말·공·시계·장부·자리·전술·판독·벤치가 한 묶음이다
   * (live-match.md §8.4). 클라이언트가 굴린 구간은 체크포인트가 검증한 뒤에야 여기
   * 앉는다(`commitCheckpoint`) — 세이브에 남는 것은 서버가 같은 답을 낸 상태뿐이다.
   */
  live: LiveMatch;
  /**
   * **첫 휘슬에 선 열한 명** (양 팀) — 장부의 `onPitch`는 교체를 따라 움직이므로
   * 킥오프에 한 번 뜬다. 경기가 끝나면 결과의 `homeStarters`로 옮겨져 계약 지위가
   * 부르는 출전을 재는 자가 된다 (→ docs/story/people.md §5-2).
   */
  startingXI: { home: string[]; away: string[] };
  /**
   * 감독이 경기장에 들어섰는가 — **킥오프는 두 걸음이다** (match.md §3.1).
   * `start_match`는 판을 세울 뿐이고, 감독이 들어서면 매치 GM이 첫 휘슬만 여는
   * 킥오프 턴을 한 번 갖는다. 시계가 구르는 것은 그다음부터다.
   */
  entered: boolean;
  /**
   * **캐스터가 이미 서술한 사건 수** — 다음 턴의 `<events>`는 장부의 이 자리 뒤부터다.
   * 시계는 클라이언트가 밀므로 한 턴 사이에 몇 개가 쌓였는지는 이 수가 말한다.
   */
  eventsSeen: number;
  /**
   * 실모드 캐스터의 대화 이력 — 제공자·모델 태그를 든 원형이다. 킥오프 전에는
   * 빈 배열이고, 첫 중계 턴이 태그를 단 이력으로 바꾼다 (`gm.ts`).
   */
  casterHistory: StoredCasterHistory | [];
  /** 이번 경기 정지 소화 중인 선수 — 종료 시 served +1 */
  servingSuspension: string[];
  /**
   * **킥오프 시점의 전술** — 경기가 끝나면 여기로 되돌린다 (match.md §3.2).
   *
   * 하프타임에 올린 라인, 후반에 옮긴 자리는 **그 경기의 대응**이지 팀의 전술이
   * 아니다. 적응도(`familiarity`)와 역할 장부(`roleMemo`)도 함께 담는다 — 경기 중
   * 조정이 깎은 값을 그 경기 한 번의 대응으로 되돌리기 위해서다.
   */
  tacticsBefore: {
    spec: import("@story-fm/domain").TacticsSpec;
    assignments: Array<{
      playerId: string;
      position: string;
      point?: import("@story-fm/domain").BoardPoint;
      roleId?: string;
      familiarity: number;
      roleMemo?: import("@story-fm/domain").RoleMemo;
    }>;
  };
  /**
   * **우리와 같은 시각에 킥오프한 타 경기의 골** — 경기 중 라이브 스코어의 원본
   * (match.md §8.6). 킥오프에 한 번 굴려 골의 분과 편만 남기고, 뷰는 우리 장부의 분
   * 이하인 골만 센다 — 감독은 옆 구장의 **진행**만 보고 결과를 미리 알지 않는다.
   */
  otherScores: Array<{
    matchId: string;
    goals: Array<{ minute: number; side: MatchSide }>;
  }>;
  /**
   * **승부차기가 남았을 때만** — 장부는 `finished`지만 경기는 끝나지 않았다.
   * 킥 목록이 원본이고 합계는 세지 않는다(`shootoutTally`).
   */
  shootout?: {
    /** 먼저 차는 쪽 — 동전이 정한다 (`shootoutFirst`) */
    first: MatchSide;
    kicks: ShootoutKick[];
    /** 감독이 지시한 키커 순서 (선수 id) — 없으면 기본 순서 */
    order?: { home?: string[]; away?: string[] };
  };
}

export type GamePhase = "idle" | "matchday" | "match";

/** 하루가 열리는 시각 — 아무 선언도 없으면 여기서 시작한다 */
export const DAY_START = "09:00";

/** 시각 — 선언된 적이 없으면 하루의 시작이다 */
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
 * 게임 세이브 — 정규화된 테이블 집합.
 * 카탈로그(불변 초기치)는 코드에 있고, 여기엔 게임 중 변화하는 것만 담는다.
 * 선수 부속(부상·징계·계약·이동·성장·시즌기록)은 gamePlayerId로 참조하는 별도 배열.
 */
export interface GameState extends GameTables {
  id: string;
  seed: number;
  createdAt: string;
  season: number;
  /** 현재 날짜 — 게임 시작은 7월 1일 (프리시즌) */
  date: string;
  /**
   * 하루 안의 시각 "HH:MM" — **장부의 시간(날짜)과 장면의 시간을 가른다.**
   *
   * 훈련·성장·부상·재정은 전부 하루 단위로 돌기 때문에 같은 날 안에서
   * 아침이 저녁이 되어도 굴릴 것이 없다. 그래서 이 축은 tick 없이 움직이고,
   * 날짜가 넘어갈 때 하루의 시작으로 돌아온다.
   *
   * 없으면 하루의 시작(09:00)이다 — 읽는 문은 `clockOf` 하나다.
   */
  clock?: string;
  /**
   * **첫 줄 헤더를 연달아 못 읽은 평시 턴 수** — 읽히면 지워진다.
   *
   * 모델이 적은 시점이 시계를 움직이는 유일한 자유 텍스트 경로라(agents.md §2)
   * 그 실패는 조용히 쌓인다. 세이브가 드는 이유는 "연달아"가 턴을 건너 세는
   * 값이라서다 — 어디에서도 파생할 수 없다. 없으면 0이다.
   */
  sceneHeaderMisses?: number;
  calendar: SeasonCalendar;
  userTeamId: string;
  phase: GamePhase;
  pendingMatch: PendingMatch | null;
  /**
   * 이 세계의 범위 — 없으면 카탈로그 전체다(실게임).
   * 테스트가 리그·팀 수를 줄인 작은 세계를 만들 때만 채워진다 (`world/scope.ts`).
   */
  world?: WorldScope;
  /**
   * **승강 결과** — 팀 → 지금 속한 리그. 카탈로그의 `leagueId`는 불변이므로
   * 강등·승격은 세이브 상태로만 표현된다 (`competition/promotion.ts`).
   * 카탈로그와 같은 리그면 항목을 두지 않는다. 없으면(아직 승강이 없었다) 전 클럽이
   * 시작할 때의 리그 그대로다.
   */
  leagueOf?: Record<string, string>;

  // ── 대회 ──
  /**
   * 이번 시즌 대항전 참가 팀 — **추첨은 이미 일어난 사실**이라 세이브에 남는다.
   * 첫 시즌은 구단 등급으로, 이후는 지난 시즌 리그 최종 순위로 배정된다
   * (`buildEuroEntrants`). 파생으로 되돌릴 수 없는 값이므로 저장한다.
   */
  euroEntrants: EuroEntry[];
  /**
   * **아직 GM이 읽지 않은 화면 조작** — 전술판·명단·역할을 직접 만진 것.
   *
   * 이 조작들은 채팅 턴을 만들지 않는다(장부 편집이다). 그런데 감독은 판을
   * 짜면서 열 번을 만지고, 그 하나하나를 턴으로 만들면 채팅이 조작 로그가 된다.
   * 그렇다고 아무 말도 없으면 모델은 감독이 무엇을 바꿨는지 모른 채 이야기를
   * 잇는다 — 배치는 컨텍스트에 없고 조회 도구로만 알 수 있기 때문이다.
   *
   * 그래서 **모아 두었다가 다음 발화 때 한 번에** 읽힌다. 같은 대상의 조작은
   * 접히므로(`recordEdit`) 역할을 세 번 바꿔도 마지막 한 줄이다. 없으면 빈 줄이다.
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
   * 비워진다(`takeNews`). 없으면 빈 줄이다.
   */
  pendingNews?: string[];
  chat: ChatTurn[];
}

/**
 * **전부 되거나 아무것도 안 된다** — 복제본 위에서 돌리고, 끝까지 성공했을 때만
 * 원본에 옮겨 붙인다.
 *
 * 시즌 전환처럼 **되돌릴 수 없는 걸음을 여럿 밟은 끝에 던질 수 있는** 전이가 쓴다
 * (→ docs/common/season.md §6). 예외가 그대로 나가면 세이브는 반만 넘어간 채
 * 남고, 그 상태에는 회복 경로가 없다.
 *
 * 옮겨 붙이기는 `state`가 가리키는 **그 객체를 고친다** — 호출부가 쥔 참조가
 * 그대로 새 값을 본다. 다만 그 안의 배열·객체는 통째로 갈리므로, 이 경계를 넘어
 * 선수 하나를 붙들고 있던 참조는 낡은 것이 된다.
 *
 * 값은 전이 하나당 깊은 복제 하나다. 시즌 전환은 시즌에 한 번이고 그 자체가
 * 전 클럽의 명단과 편성을 다시 짜는 걸음이라, 복제 한 번은 그 안에 묻힌다.
 */
export function inTransaction<T>(state: GameState, run: (draft: GameState) => T): T {
  const draft = structuredClone(state);
  const result = run(draft);
  const target = state as unknown as Record<string, unknown>;
  // 초안이 지운 필드는 원본에서도 지운다 — `Object.assign`은 덮기만 한다
  for (const key of Object.keys(target)) {
    if (!(key in draft)) delete target[key];
  }
  Object.assign(target, draft as unknown as Record<string, unknown>);
  return result;
}

// ── 팀·선수 조회 ────────────────────────────────────────

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
 * 이 팀의 **지금** 이름 — 세이브가 갖고, 세이브에 없는 팀이면 카탈로그가 답한다.
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
 * 이 구단의 **지금** 구장·브랜드 — 세이브가 갖고, 없으면(미등재 클럽)
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
 * 이 팀이 **게임이 시작할 때** 속해 있던 리그 — 세이브가 갖고, 세이브 없이 묻거나
 * 세이브에 없는 팀이면 카탈로그가 답한다.
 *
 * `leagueOfTeamIn`과 갈리는 것은 승강이다 — 이쪽은 승강 **전**의 원 소속이라,
 * "이 구단이 원래 어느 리그의 클럽인가"를 묻는 자리(브랜드 보정)가 쓴다. 지금
 * 어디 있는가는 언제나 `leagueOfTeamIn`이다 (game-state.md §1).
 *
 * ⚠️ **세이브에도 카탈로그에도 없는 팀이면 던진다.** 폴백할 옳은 값이 없다 —
 * 리그를 하나 지어내면 그 팀이 남의 리그 상금과 경제 수준을 받는다 (team.md §1).
 */
export function catalogLeagueIn(state: GameState | undefined, teamId: string): string {
  const leagueId = state?.teams.find((t) => t.id === teamId)?.leagueId ?? leagueOfTeam(teamId);
  if (leagueId === null) throw new Error(`세이브에도 카탈로그에도 없는 팀: ${teamId}`);
  return leagueId;
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

export function playersOf(state: GameState, teamId: string): GamePlayer[] {
  return state.players.filter((p) => p.teamId === teamId);
}

export type SquadLevel = "first" | "reserve";

export function squadLevelOf(player: GamePlayer): SquadLevel {
  return player.squadLevel;
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
 * **감독이 자기 선수로 세는 사람** — 우리 스쿼드에 있다.
 *
 * 안개(지식 눈금) · 월간 성장 · 조회 도구 · 명단 화면이 전부 이 문을 지난다.
 */
export function isOurPlayer(state: GameState, player: GamePlayer): boolean {
  return player.teamId === state.userTeamId;
}

/** 그 사람들 전부 */
export function ourPlayers(state: GameState): GamePlayer[] {
  return state.players.filter((p) => isOurPlayer(state, p));
}

/**
 * **감독이 지금 맡고 있는 팀** — 커리어가 끝났으면 없다 (career.md §5.1).
 *
 * `userTeamId`는 경질된 뒤에도 옛 구단을 가리킨다. 그 구단의 선수단과 장부는
 * 그대로 돌아야 하기 때문이다 — 세계가 감독을 따라 사라지지는 않는다. 그래서
 * **감독에게 무언가를 적립하는 자리**(트로피·시즌 기록)는 `userTeamId`가
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

/**
 * 이름 하나 — **세계를 떠난 사람도 부를 수 있어야 한다.** id가 화면이나 프롬프트에
 * 그대로 실리면 감독은 그것이 누구였는지 알 길이 없다.
 *
 * 명단에서 빠진 사람을 찾는 자리는 둘이고 순서가 있다: 우리 팀에서 그만둔 사람은
 * **은퇴 명부**(`retired` — 감독 팀만 담는다), 남의 팀 사람은 **시즌 기록**의
 * `playerName`(사라진 이름을 위해 적어 두는 칸 — records.ts). 둘 다 없으면 id다.
 */
export function playerName(state: GameState, id: string): string {
  return (
    playerById(state, id)?.name ??
    state.retired.find((r) => r.gamePlayerId === id)?.name ??
    state.seasonStats.find((s) => s.gamePlayerId === id && s.playerName !== undefined)
      ?.playerName ??
    id
  );
}

export function groupOf(player: GamePlayer): PositionGroup {
  return positionGroupOfPlayer(player);
}

/** 잠재력은 현재 기량보다 낮아질 수 없다. */
export function ensurePotentialFloor(player: GamePlayer): void {
  player.attributes.potential = Math.max(player.attributes.potential, playerOverall(player));
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

/** 팀 평균 전술 적응도 (선발 기준) */
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
export { FAMILIARITY_BASELINE, adaptationOf } from "@story-fm/domain";

/**
 * 이 선수가 그 포지션에서 갖는 적응도. 규칙은 domain의 `positionProficiency` 하나뿐
 * — 엔진·웹 전술판이 같은 값을 봐야 한다.
 */
export { proficiencyAt } from "@story-fm/domain";

// ── 부상·징계·계약 ──────────────────────────────────────

export function openInjury(state: GameState, playerId: string): Injury | null {
  return state.injuries.find((i) => i.gamePlayerId === playerId && i.returnedOn === null) ?? null;
}

/**
 * 지금 부상 중인 선수 id 전부 — **세계 전체를 하루에 한 번 훑는 자리**를 위한 것이다.
 *
 * `isInjured`를 선수마다 부르면 장부를 선수 수만큼 다시 훑는다. 한 번 만들어 두고
 * 묻는 쪽이 재사용한다. 열린 부상의 정의(`returnedOn === null`)는 위와 같은 자다.
 */
export function openInjuryIds(state: GameState): Set<string> {
  const ids = new Set<string>();
  for (const injury of state.injuries) {
    if (injury.returnedOn === null) ids.add(injury.gamePlayerId);
  }
  return ids;
}

export function isInjured(state: GameState, playerId: string): boolean {
  return openInjury(state, playerId) !== null;
}

/**
 * 지금 걸려 있는 정지 — **대회를 묻지 않는다.** 「이 선수에게 정지가 있는가」를
 * 묻는 자리(카드·이력·서사)만 쓴다. 경기에 세울 수 있는지는 대회가 정하므로
 * `activeSuspensionFor`를 불러라 (match.md §6).
 */
export function activeSuspension(state: GameState, playerId: string): Suspension | null {
  return (
    state.suspensions.find((s) => s.gamePlayerId === playerId && s.status === "active") ?? null
  );
}

/**
 * **이 대회 경기에 걸리는 정지** — 소화도 결장도 이 문을 지난다 (match.md §6).
 *
 * 정지가 둘일 수 있다(리그 누적 + 대항전 퇴장). 그중 이 경기에 걸리는 첫 줄만
 * 답한다 — 한 경기는 정지 하나를 갚는다.
 */
export function activeSuspensionFor(
  state: GameState,
  playerId: string,
  competitionId: string | null,
): Suspension | null {
  return (
    state.suspensions.find(
      (s) =>
        s.gamePlayerId === playerId && s.status === "active" && suspensionApplies(s, competitionId),
    ) ?? null
  );
}

export function isSuspended(state: GameState, playerId: string): boolean {
  return activeSuspension(state, playerId) !== null;
}

export function isSuspendedFor(
  state: GameState,
  playerId: string,
  competitionId: string | null,
): boolean {
  return activeSuspensionFor(state, playerId, competitionId) !== null;
}

/** 경기에 나설 수 있는가 — 부상·정지 없음 */
/**
 * **지금 우리를 위해 뛸 수 있는가** — 다치지 않았고, 정지가 아니고, 클럽에 있는가.
 *
 * 셋째 문이 A매치 소집과 여름 대회의 늦은 합류다
 * (→ [docs/match/competition.md](../../../../docs/match/competition.md) §5-1). 훈련
 * 결산·2군 경기·경기 명단이 저마다 판단하면 소집된 선수가 어느 하나에는 그대로
 * 서므로, 세 사실이 한 문을 지난다 (season.md §8 불변식).
 */
export function isAvailable(state: GameState, player: GamePlayer): boolean {
  return (
    activeContract(state, player.id)?.registrationStatus !== "pending" &&
    !isInjured(state, player.id) &&
    !isSuspended(state, player.id) &&
    !isAwayFromClub(state, player)
  );
}

/**
 * **이 경기에 세울 수 있는가** — 같은 셋을 묻되 정지는 그 경기의 대회로 잰다
 * (match.md §6). 컵 경고로 걸린 정지는 리그 명단을 막지 않는다.
 *
 * 라인업을 세우는 자리는 전부 이 문이다: 감독의 자동 대체도, 간이 시뮬의
 * `simSquadOf`도, 경기 전 예상 XI도 같은 답을 내야 한다 (§2·§7).
 */
export function isAvailableFor(
  state: GameState,
  player: GamePlayer,
  competitionId: string | null,
): boolean {
  return (
    activeContract(state, player.id)?.registrationStatus !== "pending" &&
    !isInjured(state, player.id) &&
    !isSuspendedFor(state, player.id, competitionId) &&
    !isAwayFromClub(state, player)
  );
}

/**
 * 같은 판정을 **id로** 묻는 자리 — 선수를 손에 들지 않은 호출부만 쓴다.
 *
 * ⚠️ 사람을 이미 들고 있으면 `isAvailable`을 불러라. 여기는 5,700명을 훑어 그를
 * 찾는다(`playerById`) — 간이 시뮬의 스쿼드 구성처럼 경기마다 수백 번 지나는
 * 자리에서 그 스캔은 한 시즌을 분 단위로 늘린다.
 */
export function isAvailableById(
  state: GameState,
  playerId: string,
  competitionId: string | null,
): boolean {
  const player = playerById(state, playerId);
  return player === null
    ? !isInjured(state, playerId) && !isSuspendedFor(state, playerId, competitionId)
    : isAvailableFor(state, player, competitionId);
}

export function activeContract(state: GameState, playerId: string): Contract | null {
  return state.contracts.find((c) => c.gamePlayerId === playerId && c.status === "active") ?? null;
}

/** 이번 주 주급 한 줄 — 선수 한 명이 이 구단에 지우는 부담 */
export interface WeeklyWageLine {
  gamePlayerId: string;
  weekly: number;
}

/** 이 구단의 **선수별 주급 부담** — 합계(`weeklyWagesOf`)와 원장 명세가 같은 값을 본다 */
export function weeklyWageLinesOf(state: GameState, teamId: string): WeeklyWageLine[] {
  const lines: WeeklyWageLine[] = [];
  for (const c of state.contracts) {
    if (c.status === "active" && c.teamId === teamId && c.weeklyWage > 0)
      lines.push({ gamePlayerId: c.gamePlayerId, weekly: c.weeklyWage });
  }
  return lines;
}

/** 팀 주급 총액 — 활성 계약의 합 (저장하지 않는 파생값) */
export function weeklyWagesOf(state: GameState, teamId: string): number {
  return weeklyWageLinesOf(state, teamId).reduce((sum, l) => sum + l.weekly, 0);
}

/**
 * 시즌 누적 경고 — BOOKING에서 파생. **대회를 주면 그 대회의 것만 센다**
 * (match.md §6) — 누적은 대회 안에서만 쌓인다.
 *
 * **한 경기에서 두 장을 받은 경기의 경고는 세지 않는다** — 경고 2회 퇴장은 그 자리에서
 * 퇴장 정지 한 건으로 값을 치렀고, 그 두 장까지 누적에 넣으면 한 사건에 정지가 두 번
 * 걸린다 (match.md §6). 장부의 두 줄은 그대로 둔다 — 경기 기록은 실제로 그랬다.
 */
export function seasonYellowsOf(
  state: GameState,
  playerId: string,
  season: number,
  competitionId?: string | null,
): number {
  const perMatch = new Map<string, number>();
  for (const b of state.bookings) {
    if (b.gamePlayerId !== playerId || b.season !== season || b.card !== "yellow") continue;
    if (competitionId !== undefined && b.competitionId !== competitionId) continue;
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

/** Closed interview history is bounded; pending discussions remain available. */
export const KEPT_MANAGER_INTERVIEWS = 20;

export function pendingManagerInterviews(state: GameState): ManagerInterview[] {
  return state.managerInterviews.filter((interview) => interview.status === "pending");
}

/** Without a club selector, only an unambiguous pending interview is returned. */
export function pendingManagerInterview(
  state: GameState,
  teamId?: string,
): ManagerInterview | null {
  const pending = pendingManagerInterviews(state);
  if (teamId !== undefined) return pending.find((interview) => interview.teamId === teamId) ?? null;
  return pending.length === 1 ? pending[0]! : null;
}

export function pushManagerInterview(state: GameState, interview: ManagerInterview): void {
  const interviews = [...state.managerInterviews, interview];
  const retained = new Set(
    interviews.filter((entry) => entry.status !== "pending").slice(-KEPT_MANAGER_INTERVIEWS),
  );
  state.managerInterviews = interviews.filter(
    (entry) => entry.status === "pending" || retained.has(entry),
  );
}

export function expireManagerInterview(state: GameState): void {
  for (const interview of pendingManagerInterviews(state)) interview.status = "expired";
}

/**
 * 그 선수의 **지금 소속** 시즌 기록 — 대회를 묻지 않으면 대회 행을 모두 접은 합계다
 * (→ docs/common/game-state.md §3.4 · §5 파생). 합계는 저장하지 않는다.
 *
 * ⚠️ **접어 낸 행은 읽기 전용이다** (`sumSeasonStats`) — 얹는 자리는 언제나
 * `ensureSeasonStat` 하나이므로, 여기서 받은 행에 값을 쓰면 다음 파생에서 사라진다.
 *
 * `competition`을 주면 그 대회의 행 하나다.
 */
export function seasonStatOf(
  state: GameState,
  playerId: string,
  opts: { season?: number; competition?: string } = {},
): SeasonStatTotal | null {
  const p = playerById(state, playerId);
  if (!p) return null;
  const season = opts.season ?? state.season;
  const rows: SeasonStat[] = [];
  for (const s of state.seasonStats) {
    if (s.gamePlayerId !== playerId || s.season !== season || s.teamId !== p.teamId) continue;
    if (opts.competition !== undefined) {
      if (s.competitionId === opts.competition) return s;
      continue;
    }
    rows.push(s);
  }
  return opts.competition === undefined ? sumSeasonStats(rows) : null;
}

/**
 * 그 선수의 이번 시즌 **대회별 1군 기록** — 지금 소속의 행만.
 * 무엇이 서고 무엇이 빠지는가는 `competitionRowsOf`가 갖는다 (game-state.md §3.4).
 */
export function seasonStatsByCompetitionOf(
  state: GameState,
  playerId: string,
  season = state.season,
): SeasonStat[] {
  const p = playerById(state, playerId);
  if (!p) return [];
  return competitionRowsOf(
    state.seasonStats.filter(
      (s) => s.gamePlayerId === playerId && s.season === season && s.teamId === p.teamId,
    ),
  );
}

/**
 * 시즌·팀·**대회** 단위 스탯 확보 (없으면 생성) — 시즌 중 소속이 바뀌면 팀별로도 갈린다.
 *
 * `competitionId`가 열쇠의 넷째다 (game-state.md §3.4): 리그 경기는 리그 행에, 컵
 * 경기는 컵 행에 쌓인다. 대회가 없는 경기(친선)는 애초에 이 문을 지나지 않으므로
 * 인자가 널을 받지 않는다 — 대회 축이 없는 행은 무엇의 합인지 말할 수 없다.
 *
 * `player`를 넘기면 그 자리에서 등번호를 읽는다. 부르는 자리는 대부분 이미 그 선수를
 * 손에 들고 있고, 여기서 다시 명부를 훑으면 **경기마다 선수 수만큼** 4,000명 배열을
 * 지나간다 — 원장 훑기가 이미 하나 있는 함수라 그 위에 하나를 더 얹지 않는다.
 */
export function ensureSeasonStat(
  state: GameState,
  playerId: string,
  teamId: string,
  competitionId: string,
  player?: Pick<GamePlayer, "squadNumber" | "name">,
): SeasonStat {
  let stat = state.seasonStats.find(
    (s) =>
      s.gamePlayerId === playerId &&
      s.season === state.season &&
      s.teamId === teamId &&
      s.competitionId === competitionId,
  );
  if (!stat) {
    stat = {
      gamePlayerId: playerId,
      season: state.season,
      teamId,
      competitionId,
      apps: 0,
      goals: 0,
    };
    state.seasonStats.push(stat);
  }
  /**
   * **그 시즌 그 셔츠의 등번호** — 번호 계보가 읽는 유일한 원본이다 (player.md §1.1).
   * 부를 때마다 덮어쓴다: 시즌 중에 번호가 바뀌면 마지막 번호가 그 시즌의 번호다.
   */
  const known = player ?? playerById(state, playerId);
  if (known?.squadNumber !== undefined) stat.squadNumber = known.squadNumber;
  /**
   * **그때의 이름** — 은퇴하면 선수가 `state.players`에서 빠져 id로는 더 못 찾는다
   * (records.ts `SeasonStat.playerName`). 역대 득점왕과 통산 표가 사라진 이름을
   * 되찾는 유일한 자리라, 등번호와 같은 자리에서 같은 규약으로 덮어쓴다.
   */
  if (known?.name !== undefined) stat.playerName = known.name;
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
  /** 어느 경로로 올랐나 — 문장이 아니라 코드다 (records.ts `GrowthOrigin`) */
  origin: GrowthEntry["origin"],
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
    origin,
  });
  if (state.growthLog.length > GROWTH_LOG_LIMIT) {
    state.growthLog.splice(0, state.growthLog.length - GROWTH_LOG_LIMIT);
  }
}

/**
 * 훈련 결산 카드 보관 한도 — **40장.**
 *
 * 결산은 시즌에 백 번 넘게 돈다. 전부 들고 있으면 세이브가 읽히지 않는 카드로
 * 불어나는데, 감독이 되짚어 읽는 것은 최근 몇 주고 **낱낱의 성장은 `growthLog`가
 * 최근 GROWTH_LOG_LIMIT건까지 따로 갖는다** — 여기서 잘리는 것은 근거 한 줄과 갈래뿐이다.
 */
const TRAINING_REPORT_LIMIT = 40;

/** 한 구간의 결산 카드를 장부에 남긴다 — 오래된 것부터 밀려난다 */
export function recordTrainingReport(state: GameState, report: TrainingReport): void {
  const ring = state.trainingReports;
  ring.push(report);
  if (ring.length > TRAINING_REPORT_LIMIT) {
    ring.splice(0, ring.length - TRAINING_REPORT_LIMIT);
  }
}

/** 가장 최근의 결산 카드 — 없으면 null */
export function latestTrainingReport(state: GameState): TrainingReport | null {
  const ring = state.trainingReports;
  return ring[ring.length - 1] ?? null;
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

/** 매치데이 벤치 규모 — 값은 도메인이 하나만 갖는다 (`squad-rules.ts`) */
export { MATCHDAY_BENCH };

/**
 * 떠난 선수를 전술 배치에서 뺀다 — **선반과 죽은 공 지정도 함께 비운다.**
 * 적응도는 이 팀의 전술에 대한 값이라 다른 팀에서 뜻이 없다 (player.md §7.3).
 *
 * **키커 지정은 완장과 같은 결이다** (match.md §2 키커 지정 · people.md §5-1) —
 * 우리 판에 설 수 없게 된 사람이 우리 코너를 차는 장부는 남지 않는다. 배치가 걷히는
 * 문 하나가 지정도 함께 걷는다.
 *
 * ⚠️ **2군 강등은 이 문이 아니다.** 내려간 선수는 여전히 우리 선수고, 지정은 한
 * 경기의 명단이 지우지 못하는 값이다 — 그 경기에만 기본값이 설 뿐이다 (match.md §1.4).
 */
export function releaseFromTactics(state: GameState, teamId: string, playerId: string): void {
  // 무소속처럼 전술이 없는 자리에서 오는 선수는 뺄 배치도 없다 (team.md §4)
  const tactics = state.tactics.find((t) => t.teamId === teamId);
  if (!tactics) return;
  tactics.assignments = tactics.assignments.filter((a) => a.playerId !== playerId);
  if (tactics.shelved) tactics.shelved = tactics.shelved.filter((s) => s.playerId !== playerId);
  const takers = tactics.setPieceTakers;
  if (takers) {
    for (const role of SET_PIECE_ROLES) {
      if (takers[role] === playerId) delete takers[role];
    }
  }
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
 * 모델이 읽을 기사 수 상한 — 아무도 꺼내지 않는 경로(mock)에서 줄이 무한히 자라지
 * 않게 하는 자리지 보관 기간이 아니다 (people.md §4-1).
 */
export const MEDIA_LIMIT = 30;

/** 회견 밖의 기사를 모아 둔다 — 다음 평시 턴의 GM 입력에 실린다 */
export function pushMedia(state: GameState, facts: readonly MediaFact[]): void {
  if (facts.length === 0) return;
  const media = state.media;
  media.push(...facts);
  if (media.length > MEDIA_LIMIT) media.splice(0, media.length - MEDIA_LIMIT);
}

/** 모아 둔 기사를 꺼내 비운다 — `takeNews`와 같은 자리에서 부른다 */
export function takeMedia(state: GameState): MediaFact[] {
  const media = state.media;
  state.media = [];
  return media;
}

/** 지금 클럽을 떠나 있는 소집 — 없으면 null */
export function openCallUp(state: GameState, playerId: string): CallUp | null {
  return state.callUps.find((c) => c.gamePlayerId === playerId && c.returnedOn === null) ?? null;
}

/**
 * 지금 클럽을 떠나 있는가 — **A매치 소집도 여름 대회의 늦은 합류도 한 문이다**
 * (season.md §8 불변식). `isAvailable`이 부상·정지와 함께 이것을 묻는다.
 */
export function isAwayFromClub(state: GameState, player: GamePlayer): boolean {
  if (openCallUp(state, player.id) !== null) return true;
  const summer = player.state.summerReturn;
  return summer !== undefined && state.date < summer;
}

/**
 * 지금 클럽을 떠나 있는 선수 id 전부 — **한 번만 모은다.**
 *
 * 선수 전원을 도는 루프(`tickOtherClubs`)가 사람마다 `isAwayFromClub`을 부르면 그
 * 안에서 소집 표를 5,700번 다시 훑는다. 판정은 같고 자릿수만 다르다.
 */
export function awayFromClubIds(state: GameState): ReadonlySet<string> {
  const out = new Set<string>();
  for (const row of state.callUps) {
    if (row.returnedOn === null) out.add(row.gamePlayerId);
  }
  for (const player of state.players) {
    const summer = player.state.summerReturn;
    if (summer !== undefined && state.date < summer) out.add(player.id);
  }
  return out;
}
