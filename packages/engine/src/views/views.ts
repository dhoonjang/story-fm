import type {
  AssignmentRole,
  AxisValues,
  BoardPoint,
  EdgeSize,
  LedgerEntry,
  MatchEventType,
  MatchRecord,
  MatchSide,
  MilestoneCode,
  PacketPlayer,
  Foot,
  PromiseKind,
  ScheduleType,
  SeasonStat,
  ShootoutOutcome,
  ShotOrigin,
  SquadRegistration,
  SquadStatus,
  TacticalRead,
  TransitionMode,
  TacklingLevel,
  KeeperDistribution,
  TrainingReport,
  BoardExpectationCode,
  VisionCode,
  VisionReading,
} from "@story-fm/domain";
import {
  BOARD_CONDITION_LABEL,
  SET_PIECE_ROLES,
  BOARD_REQUEST_LABEL,
  VISION_CODE_KO,
  boardConditionAmountText,
  boardExpectationText,
  boardRequestAmountText,
  visionTargetText,
  isReserveMatch,
  matchMinutesOf,
  normalizeCauses,
  normalizePacket,
  packetTagContext,
  packetTagText,
  subCauseText,
} from "@story-fm/domain";
import {
  ATTRIBUTE_AXES,
  AXIS_GROUPS,
  AXIS_GROUP_KO,
  FINANCE_CATEGORY_KO,
  MANAGER_SPEND_KIND_KO,
  TRAIN_ATTR_KO,
  TRAINING_MARK_KO,
  ageOf,
  anchorOf,
  associationName,
  capsOf,
  internationalGoalsOf,
  clampCondition,
  conditionLabel,
  fatigueBand,
  fatigueLabel,
  fatigueOf,
  sharpnessBand,
  sharpnessLabel,
  sharpnessOf,
  type FatigueBand,
  type SharpnessBand,
  defaultRoleOf,
  growthLabel,
  naturalPositionOf,
  outcomeFor,
  outcomeLabel,
  pairOfMatchId,
  competitionRowsOf,
  parseScorerEntry,
  pickMotm,
  rolesFor,
  seasonRating,
  separateBoardPoints,
  shootoutTally,
  slotOfTime,
} from "@story-fm/domain";
import { DEFAULT_KICKOFF, diffDays, nextMatchFor, seasonEndDate } from "../competition/calendar";
import { internationalBreaksOf, openCallUp } from "../competition/international";
import {
  categoryOf,
  currentMonthSummary,
  financeNoteTexts,
  formatMoney,
  isJournalMoney,
  monthOf,
  psrStatus,
  seasonWageRatio,
  ticketPriceOf,
  userReports,
  wageRatioTone,
  type WageRatioTone,
} from "../club/finance";
import { openBoardRequest } from "../club/board-request";
import {
  financeOutlook,
  type DebtView,
  type ExpiringContractView,
  type FinanceOutlook,
} from "./finance-outlook";
import { MANAGER_WALLET, walletOf } from "../club/manager-wallet";
import {
  cupCatalog,
  competitionLabel,
  competitionName,
  competitionShortName,
  competitionStageLabel,
  cupCatalogById,
  fixtureLabel,
  isCup,
  isEuroCup,
  knockoutStages,
} from "../data/cup-catalog";
import { isFriendly } from "../competition/friendly";
import {
  championOf,
  clubRecordsOf,
  leagueTableOf,
  managerTenureOf,
  managerTrophiesOf,
  pastSeasonsOf,
  seasonLabelOf,
} from "../competition/records";
import { DOMESTIC_STAGES, domesticCupById } from "../data/domestic-cup-catalog";
import { domesticCupsOf, userStillIn } from "../competition/domestic-cup";
import { drawParts, drawTitle } from "../competition/draw-schedule";
import { euroCompetitionOf } from "../competition/europe";
import { careerSeasonRowsOf, foldCareer, type CareerTotals } from "../squad/career";
import { formAngle, formLabel, formTone } from "../squad/form";
import { leaderGroupOf } from "../squad/hierarchy";
import { ratingTone, type RatingTone } from "../match/ratings";
import { buildOpponentReport, type AbsentReason } from "../match/preview";
import {
  GAP_CONDITION,
  edgeOf,
  setPieceTakersOf,
  subLimitsOf,
  zoneGrid,
  type InjuryRisk,
  type TakerSlot,
} from "@story-fm/sim";
import { moodOf, type MoodRead } from "../squad/mood";
import { openPromises, squadStatusOf } from "../squad/promises";
import { isHomegrownFor, occupiesSquadList, squadRegistrationOf } from "../squad/registration";
import {
  observationOf,
  observedFit,
  observedOverall,
  observedRating,
  knowledgeNote,
  missionBrief,
  missionScope,
  observationMargin,
  potentialBand,
  ratingLabel,
  ratingTier,
  readCondition,
  scoutedAttributes,
  youthCandidateFog,
  type ConditionRead,
  type Observation,
} from "../squad/scouting";
import type {
  GamePlayer,
  MissionReportCard,
  ScoutGrade,
  ScoutReportCard,
  SetPieceProfile,
  SetPieceRole,
  SetPieceTakers,
  TacticAssignment,
} from "@story-fm/domain";
import { listingOf } from "../market/negotiation";
import { openManagerOffers, USER_WARNINGS_BEFORE_SACK } from "../market/manager-market";
import { MANAGER_ATTR_CAP, MANAGER_XP_PER_LEVEL } from "../skills";
import {
  askingPriceFor,
  marketValueOf,
  observedMarketValue,
  wageExpectationOf,
} from "../market/market";
import { settlingPercent } from "../squad/settling";
import { INJURY_SEVERITY_KO, injuryRiskFor } from "../squad/injury";
import {
  boardExpectation,
  computeStandings,
  ourYouthCandidates,
  standingsBySplit,
  youthIntakeDeadline,
  type StandingRow,
} from "../competition/season";
import {
  leaderboardsOf,
  teamStatsOf,
  type LeaderBoard,
  type TeamStatRow,
} from "../competition/leaderboard";
import { hasRelegation, leagueOfTeamIn } from "../competition/promotion";
import { RELEGATION_SLOTS } from "../core/league-shape";
import { tierOfTeamIn } from "../core/club-tier";
import { isCupOnlyLeague, leagueName } from "../data/league-catalog";
import {
  activeContract,
  activeSuspensionFor,
  isAvailableFor,
  assignmentsOf,
  financeOf,
  groupOf,
  openInjury,
  playerName,
  playersOf,
  seasonStatOf,
  squadLevelOf,
  squadFamiliarity,
  playerById,
  proficiencyAt,
  adaptationOf,
  ourPlayers,
  FAMILIARITY_BASELINE,
  tacticsOf,
  clubProfileIn,
  managedTeamId,
  teamNameIn,
  teamShortNameIn,
  weeklyWagesOf,
  type GameState,
} from "../core/state";
import { loanReports } from "../market/departures";
import { visionOf, visionReadings, visionSpanOf, visionYearOf } from "../club/vision";

/**
 * 비전 항목 한 칸 — **코드가 이름과 목표 문장을 정한다** (career.md §5).
 *
 * 코어가 코드를 문장으로 옮기는 자리는 도메인의 `VISION_CODE_KO`·`visionTargetText`
 * 하나다. 달성률은 0~1 그대로 내려가고 %는 화면이 만든다.
 */
export interface VisionItemView {
  code: VisionCode;
  label: string;
  target: string;
  progress: number;
}

const visionItemViews = (items: readonly VisionReading[]): VisionItemView[] =>
  items.map((item) => ({
    code: item.code,
    label: VISION_CODE_KO[item.code],
    target: visionTargetText(item),
    progress: item.progress,
  }));

/**
 * 그날 훈련이 남긴 것 — **집계 한 줄**.
 *
 * 선수를 하나하나 늘어놓지 않는다. 그 목록은 아래 "기록" 블록이 이미 갖고 있어서,
 * 여기서 또 쓰면 같은 화면이 같은 말을 두 번 한다. 여기 필요한 건 "이 날 훈련에
 * 성과가 있었나"뿐이다. 없으면 null — 아무것도 안 남은 날은 그렇게 보여야 한다.
 *
 * **세션 단위로 거른다** — 결산은 며칠치를 한 번에 판정하지만 결과는 그 변화가
 * 나온 훈련 엔트리에 찍힌다. 날짜만 보면 오전·오후 두 세션이 같은 요약을 두 번
 * 내건다. entryId가 없는 옛 로그는 날짜만으로 붙인다.
 */
function growthSummary(state: GameState, date: string, entryId?: string): string | null {
  const rows = state.growthLog.filter(
    (g) =>
      g.date === date &&
      g.source === "training" &&
      (!entryId || g.entryId === null || g.entryId === entryId),
  );
  if (rows.length === 0) return null;
  const counts = new Map<string, number>();
  for (const g of rows) {
    const key = `${growthLabel(g.target)} ${g.delta > 0 ? "+" : ""}${g.delta}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `${key} ${n}명`)
    .join(" · ");
}

/** 재정의 한 달 — 마감된 보고서와 진행 중인 달이 같은 모양을 쓴다 */
export interface FinanceMonthView {
  month: string;
  /** 마감 전이면 false — UI가 "진행 중"으로 표시한다 */
  closed: boolean;
  income: Array<{ category: string; label: string; amount: number }>;
  expense: Array<{ category: string; label: string; amount: number }>;
  incomeTotal: number;
  expenseTotal: number;
  /** 통장의 변화 (상각 제외) */
  cashNet: number;
  /** 장부의 변화 (이적료 지출 제외, 상각 포함) */
  pnlNet: number;
  wageRatio: number;
  /** 그 비중이 선 구간 — 색의 경계는 `finance.ts`가 갖는다 */
  wageTone: WageRatioTone;
  notes: string[];
}

/**
 * 재정 활동 피드의 한 줄 — 원장 한 건일 수도, 접힌 묶음일 수도 있다
 * (docs/simulation/finance.md §8.1).
 */
export interface FinanceFeedRow {
  id: string;
  date: string;
  kind: "income" | "expense";
  category: string;
  categoryLabel: string;
  /**
   * **항목명** — 접힌 줄이면 `매각 잔존가`처럼 묶음을 부르는 이름, 한 건이면 원장
   * 라벨. 카테고리로만 묶인 줄(선수별 상각)은 빈 문자열이고 카테고리 이름이 대신
   * 말한다 — 같은 말을 한 행에 두 번 세우지 않는다.
   */
  label: string;
  /** 접힌 줄이면 묶음의 합계 */
  amount: number;
  noncash: boolean;
  /** 2건 이상 접혔을 때만 — 펼치면 나오는 대상별 명세. 금액이 큰 것부터 */
  items?: Array<{ label: string; amount: number }>;
  /**
   * 명세를 **무엇으로 세는가** — 묶인 엔트리가 모두 선수를 가리키면 `명`, 아니면 `건`.
   * 세는 단위는 무엇이 묶였는지가 정하므로 코어가 안다. 화면은 이 낱말과 `items.length`로
   * "손흥민 외 44명"을 조립한다 (문장은 코어가 만들지 않는다).
   */
  unit?: "명" | "건";
}

/** 피드가 세우는 줄 수 — 원장 건수가 아니라 **접은 뒤의** 줄 수다 */
const FINANCE_FEED_ROWS = 30;

/** 원장 라벨의 `<항목명> — <대상>` 구분자 */
const LEDGER_LABEL_SPLIT = " — ";

/**
 * 항목명 자리에 앉은 **카테고리 이름의 옛 표시명**. 라벨 규약 이전 세이브의 원장에
 * 남아 있어, 접으면 한 행에 같은 말이 두 번 선다. 원장은 3개월 롤링이라 그만큼 지나면
 * 저절로 빠진다 — 세이브를 고치지 않는다.
 */
const LEGACY_CATEGORY_HEADS = new Set(["이적료 상각"]);

/**
 * 원장을 피드 줄로 접는다 — 최신 순.
 *
 * 상각처럼 **한 사건이 대상마다 한 줄**로 앉는 항목이 30칸을 통째로 덮지 않게,
 * `날짜 · 수입/지출 · 카테고리 · 현금/장부 · 항목명`이 같은 엔트리를 한 줄로 묶는다.
 * 원장 자체는 손대지 않는다 — PSR과 처분 이익이 선수별 값을 읽는다.
 *
 * **대상이 있는 줄만 묶는다.** `이자·세금`과 `시설·아카데미 운영`은 카테고리가 같아도
 * 서로 다른 사건이라 각자 서야 한다 — 접히면 라벨이 사라지고 두 항목이 한 금액이 된다.
 */
function foldFinanceFeed(ledger: readonly LedgerEntry[]): FinanceFeedRow[] {
  type Group = {
    key: string;
    row: FinanceFeedRow;
    head: string;
    items: Array<{ label: string; amount: number }>;
    /** 묶인 엔트리의 `ref.type` — 하나로 모이지 않으면 null */
    refType: NonNullable<LedgerEntry["ref"]>["type"] | null;
  };
  const groups = new Map<string, Group>();
  const order: Group[] = [];
  // 최신부터 — 같은 날은 나중 기록이 위로
  for (const [i, e] of [...ledger].reverse().entries()) {
    const category = categoryOf(e);
    const categoryLabel = FINANCE_CATEGORY_KO[category];
    const cut = e.label.indexOf(LEDGER_LABEL_SPLIT);
    const item = cut < 0 ? e.label : e.label.slice(cut + LEDGER_LABEL_SPLIT.length);
    // 항목명이 카테고리 이름을 되풀이하면 없는 것으로 본다
    const raw = cut < 0 ? "" : e.label.slice(0, cut);
    const head = raw === categoryLabel || LEGACY_CATEGORY_HEADS.has(raw) ? "" : raw;
    const noncash = e.accounting === "noncash";
    // 대상이 있는 줄(항목명이 붙었거나 `ref`가 가리키는 줄)만 다른 줄과 묶인다
    const groupable = cut >= 0 || e.ref !== undefined;
    const key = groupable ? `${e.date}|${e.kind}|${category}|${noncash}|${head}` : `solo|${i}`;
    const found = groups.get(key);
    if (found) {
      found.row.amount += e.amount;
      found.items.push({ label: item, amount: e.amount });
      if (found.refType !== (e.ref?.type ?? null)) found.refType = null;
      continue;
    }
    const group: Group = {
      key,
      head,
      refType: e.ref?.type ?? null,
      items: [{ label: item, amount: e.amount }],
      row: {
        id: e.id ?? `led-${e.date}-${i}`,
        date: e.date,
        kind: e.kind,
        category,
        categoryLabel,
        // 되풀이로 걷어 낸 항목명은 한 건짜리 줄에서도 다시 세우지 않는다
        label: head ? e.label : item,
        amount: e.amount,
        noncash,
      },
    };
    groups.set(key, group);
    order.push(group);
  }
  return order.slice(0, FINANCE_FEED_ROWS).map(({ key, row, head, items, refType }) => {
    if (items.length < 2) return row;
    // 접힌 줄은 항목명만 남기고 원래 라벨은 명세로 내려간다 — 큰 금액이 위로
    return {
      ...row,
      id: `fold-${key}`,
      label: head,
      items: [...items].sort((a, b) => b.amount - a.amount),
      ...(refType ? { unit: refType === "player" ? ("명" as const) : ("건" as const) } : {}),
    };
  });
}

/** 경기 화면의 전술 카드가 6축 위에 더 싣는 것 — 소화율·노트·전환 표식 */
interface MatchTacticsExtra {
  uptake: number;
  notes: string[];
  shift: { minute: number; note: string } | null;
}

/** 팀 전술 (TACTICS) — 스쿼드 탭에서 보고 편집한다 */
export interface TacticsView {
  formation: string;
  /** 1(수비적) ~ 5(공격적) */
  mentality: number;
  defensiveLine: number;
  pressing: number;
  tempo: number;
  /** 1(중앙) ~ 5(측면) */
  width: number;
  /** 1(짧게) ~ 5(길게) */
  passStyle: number;
  /**
   * ── 갈래 넷 — 눈금이 아니라 둘 중 하나다 (→ docs/simulation/match.md §1.2).
   * **옛 세이브이거나 감독이 그 갈래에 서지 않았으면 없다** — 중립인지는 화면이
   * 다시 재지 않고 `tacticToggleValue`가 답한다.
   */
  transition?: TransitionMode | null;
  offsideTrap?: boolean;
  tackling?: TacklingLevel;
  keeperDistribution?: KeeperDistribution | null;
}

/**
 * 죽은 공 키커 한 자리 — **감독의 지정과 지금 실제로 설 사람이 나란히 선다**
 * (→ docs/simulation/match.md §1.4 · §2 키커 지정).
 *
 * 둘을 함께 싣는 이유는 둘이 **갈릴 수 있기 때문**이다. 지정은 전술에 남고 한 경기의
 * 명단이 그것을 지우지 않으므로, 지정한 선수를 2군으로 내리거나 선발에서 빼면 이름은
 * 남은 채 그 경기에는 기본값이 선다. 한 칸만 실으면 감독은 그 갈림을 볼 자리가 없다.
 *
 * 이름이 아니라 id다 — 명단 행이 이미 이름을 들고 있어, 뷰가 한 벌 더 적으면 같은
 * 선수의 표기가 두 곳에서 갈린다.
 */
export interface SetPieceTakerView {
  /**
   * 감독이 지정한 선수 — 없으면 `null`.
   *
   * **우리 명단에 없는 id는 싣지 않는다.** 지정이 걷히는 문(`releaseFromTactics`)이
   * 생기기 전의 세이브에는 이미 떠난 선수의 id가 남아 있을 수 있는데, 그것을 그대로
   * 내면 화면이 이름을 찾지 못해 빈칸이 선다.
   */
  designated: string | null;
  /**
   * 지금 선발로 치면 **실제로 차는 사람** — 지정이 없거나 그가 선발 밖이면 코어의
   * 기본값(코너·프리킥은 킥력 최고, 페널티는 `penaltySkill` 최고)이다. 선발이 비면
   * `null`.
   *
   * 경기 중에는 **그 경기의 패킷이 정한 값**이다(`guide.setPieces`) — 교체로 나간
   * 키커 대신 누가 서 있는지를 뷰가 명단에서 다시 고르면 화면과 90분이 갈린다.
   */
  taker: string | null;
}

export interface SquadPositionView {
  position: string;
  proficiency: number;
  isNatural: boolean;
  /**
   * **그 자리에 세웠을 때의 전력** — 적응도와는 다른 축이다. 적응도는 "자리를
   * 아는가", 이 값은 "그 자리가 요구하는 능력을 갖췄는가"다 (`roleFit`).
   * 둘은 갈릴 수 있다 — 라이트백을 오래 본 선수라 적응도는 높은데 발이 느려
   * 그 자리 전력은 낮을 수 있다.
   */
  overall: number;
}

/** 최근 경기 평점 한 점 — 색의 경계는 `ratings.ts`가 갖는다 (화면이 다시 자르지 않는다) */
export interface RecentRatingView {
  value: number;
  tone: RatingTone;
}

/**
 * 커리어 한 묶음 — 시즌 행과 통산 행이 **같은 모양**이다. 표의 마지막 줄이
 * 위의 행들과 같은 열을 쓰므로, 화면이 통산만 따로 그리지 않아도 된다.
 *
 * 저장하지 않는다 — `SEASON_STAT` 전 행을 `foldCareer`로 접은 값이다
 * (→ docs/data/game-state.md §5). 평점은 **합계가 아니라 평균**을 싣는다:
 * 화면이 나눗셈을 다시 하면 코어와 다른 자리에서 반올림한다.
 */
export interface CareerTotalsView {
  apps: number;
  goals: number;
  assists: number;
  /** 평균 평점 — 출전이 없으면 null (0.00과 "기록 없음"은 다르다) */
  rating: number | null;
  /**
   * 2군 리그 — 1군과 **섞지 않는다** (season.md §2). 섞으면 표의 "출전 38"이
   * 1·2군 혼합값이 되고, 마일스톤이 세는 수와도 갈린다.
   */
  reserveApps: number;
  reserveGoals: number;
}

/** 시즌 한 줄 — 시즌 안에 팀을 옮겼으면 **행도 팀별로 갈린다** (player.md §10) */
export interface CareerSeasonView extends CareerTotalsView {
  season: number;
  teamId: string;
  /** 팀 약칭 — 화면은 카탈로그를 못 읽는다 (엔진을 타입으로만 import한다) */
  team: string;
}

/**
 * 상세에 세울 마일스톤 수 — 표 옆의 **곁줄**이라 한 줄을 크게 넘기면 그 자체가
 * 또 하나의 목록이 된다. 문턱(50·100경기)은 드물지만 해트트릭은 시즌마다 쌓인다.
 */
const SQUAD_MILESTONES_SHOWN = 6;

/**
 * 그 선수가 세운 기록 한 건 — **코드와 수치뿐이다.** 문장은 화면이
 * `milestoneTitle`로 만든다 (match.md §6 · overview.md §1 철칙 4).
 *
 * `season`은 싣지 않는다 — `date`가 이미 그것을 말하고, 화면이 세우는 것은
 * 날짜 옆의 라벨 한 줄이다.
 */
export interface MilestoneView {
  code: MilestoneCode;
  value: number;
  date: string;
  /** 어느 셔츠로 세웠나 — 문턱은 클럽 안에서만 센다 */
  teamId: string;
}

/** 스쿼드 행 = 메타 + 16축 (오피스 뷰는 우리 선수라 숫자를 그대로 준다) */
/**
 * **여름의 유스 후보 한 줄** — 아직 계약하지 않은 사람이라 `SquadViewRow`가 아니다
 * (season.md §6). 층도 배치도 등번호도 없고, 대신 첫 프로 계약의 조건이 붙는다.
 */
export interface YouthCandidateView {
  /** 후보의 선수 id — `sign_youth`가 받는 그 값이다 */
  id: string;
  name: string;
  age: number;
  position: string;
  /** **관측** 종합 — 참값이 아니다 (player.md §9) */
  overall: number;
  /** 잠재력 추정 구간 — 후보는 언제나 구간이 선다 (`adapting` 눈금) */
  potential: { low: number; high: number; confidence: string };
  weeklyWage: number;
  years: number;
  /** 답이 없으면 구단이 데려가는 자리인가 */
  autoSign: boolean;
}

/** 이번 여름의 인테이크 — 후보가 없으면 이 구획 자체가 서지 않는다 */
export interface YouthIntakeView {
  /** 감독의 답을 기다리는 마지막 날 = 선수단 소집일 */
  deadline: string;
  candidates: YouthCandidateView[];
}

export type SquadViewRow = SquadViewRowMeta & AxisValues;
interface SquadViewRowMeta {
  id: string;
  name: string;
  /** 현재 소속팀 등번호. 아직 배정되지 않았으면 null */
  squadNumber: number | null;
  age: number;
  /** 주 포지션 */
  position: string;
  positionGroup: string;
  /** 가능 포지션 전체 + 적응도 */
  positions: SquadPositionView[];
  /** 표시용 종합 — **관측된 축**에서 파생된 값 (`observedOverall`) */
  overall: number;
  /**
   * **감독이 이 선수를 얼마나 정확히 아는가** (scouting.ts).
   *
   * 화면이 자리를 옮겨 보며 같은 규칙으로 전력을 다시 낼 수 있도록 안개 자체를
   * 실어 보낸다 — 참값은 보내지 않는다. `margin`은 그 값이 얼마나 흐린지이고,
   * 화면은 이것으로 정확도를 함께 보여준다.
   */
  observation: Observation;
  /**
   * **지금 맡은 자리 기준 전력** — 배치가 없거나 주 포지션과 요구 역량이 같으면
   * null이다.
   *
   * `overall`은 주 포지션 가중치로만 계산되므로, 센터백을 윙에 세워도 그 숫자는
   * 움직이지 않는다. 그런데 경기에서 쓰이는 값은 **배치된 자리**의 `roleFit`이라
   * (`slotStrength`) 화면과 시뮬이 갈렸다 — 감독이 그 간극을 못 보면 자리를
   * 옮긴 대가가 결과에만 나타난다.
   *
   * 같은 `WeightSlot`이면(LCB↔CB↔RCB) `roleFit`이 정확히 같은 값이라 null로 둔다 —
   * 같은 숫자를 두 번 보여주는 건 정보가 아니라 잡음이다. 좌우 차이는 적응도가 말한다.
   */
  slotOverall: number | null;
  /** 이 팀 기준 홈그로운인가 — 등록 명단의 8명 조건을 채우는 선수 */
  homegrown: boolean;
  /**
   * 국적 — 협회 코드 (`domain/nationality.ts`). 홈그로운과 다른 축이다: 홈그로운은
   * 어디서 자랐는가이고 이것은 누구인가라, 같은 줄에 나란히 선다.
   */
  nationality: string | null;
  /** 둘째 국적 — 없으면 null */
  secondNationality: string | null;
  /**
   * **통산 A매치 출전·골** (→ docs/data/competition.md §5-1) — 국적 바로 옆이다:
   * 같은 사실의 앞뒤라(어느 나라 사람인가 · 그 나라로 몇 번 뛰었나) 떨어져 서면
   * 화면이 둘을 다른 축으로 다룬다. 없으면 0이고, 0을 어떻게 보일지는 화면이 정한다.
   */
  caps: number;
  internationalGoals: number;
  /** 두 발 숙련도 (각 1~5) — 좌우 분화 자리의 적응도를 가른다 */
  foot: Foot;
  /** 키(cm) · 체중(kg) — 묘사용 (전력 계산에는 안 들어간다) */
  height: number | null;
  weight: number | null;
  /** 등록 명단을 차지하는가 (만 21세 초과). U21은 명단 밖이라 언제든 뛴다 */
  occupiesList: boolean;
  /** 이적 리스트에 올라 있으면 호가, 아니면 null */
  transferListed: number | null;
  /**
   * 새 팀 정착 진행도(0~100) — 끝났거나 원소속이면 null.
   * 이 값이 있는 동안 위 능력치는 **참값이 아니다**(settling.ts).
   */
  settling: number | null;
  /**
   * 잠재력 **추정 구간** — 참값은 노출하지 않는다. 우리 선수도 단정할 수 없고
   * (출전이 쌓이면 좁아진다), 근거가 없으면 null이다 (scouting.ts §잠재력).
   */
  potential: { low: number; high: number; margin: number; confidence: string } | null;
  squadLevel: "first" | "reserve";
  /**
   * **우리가 임대 보낸 선수인가** — 아니면 null (`market/departures.ts`의 리포트).
   *
   * 계약이 우리 것이라 명단에 서지만 `squadLevel`은 **빌린 구단의 값**이고 우리
   * 전술판에는 자리가 없다. 그래서 층(1군·2군)으로 가르는 자리는 전부 이 칸을
   * 먼저 봐야 한다 — 안 그러면 임대 선수가 엉뚱한 탭에 서고 승격·강등 diff에 실린다.
   *
   * `team`은 **약칭**이다 — 화면은 카탈로그를 못 읽는다 (`CareerSeasonView.team`과
   * 같은 이유).
   */
  loan: {
    teamId: string;
    team: string;
    /** 복귀일 */
    until: string;
    /** 그 구단에서의 이번 시즌 1군 기록 */
    apps: number;
    goals: number;
    /** 평균 평점 — 출전이 없으면 null (0.00과 "기록 없음"은 다르다) */
    rating: number | null;
    /** 그 구단 최근 경기의 연속 미출전 수 */
    benchRun: number;
    /** 임대 이후 오른 능력치 칸 수 */
    growth: number;
  } | null;
  /**
   * **지금 클럽을 떠나 있는가** — A매치 소집이거나 여름 대회에서 아직 안 돌아왔다
   * (→ docs/data/competition.md §5-1 · season.md §8 불변식). 아니면 null.
   *
   * 임대와 다른 갈래다: 임대는 계약이 남의 훈련장에 가 있는 것이고 이건 열흘 뒤
   * 돌아온다. 부상·정지와 **같은** 갈래라 `available`이 셋을 함께 닫는다 —
   * 화면이 이 칸을 안 보면 소집된 주전이 선발 가능한 얼굴로 명단에 선다.
   *
   * ⚠️ **문장이 아니라 사실이다.** 「잉글랜드 소집 중 (2경기 1골)」을 여기서 이으면
   * 화면이 그 문자열을 다시 갈라야 한다 (competition.md §7 불변식). 나라 **표기**만
   * 뷰가 붙인다 — 화면은 카탈로그를 못 읽는다 (`loan.team`이 약칭인 것과 같은 이유).
   */
  away: {
    /** A매치 소집인가, 여름 메이저 대회의 늦은 합류인가 */
    reason: "call-up" | "tournament";
    /** 그를 데려간 협회 — FIFA 3자 코드. 국적을 모르는 선수는 null */
    country: string | null;
    /** 그 협회의 한글 표기 — 코드가 없으면 null */
    countryName: string | null;
    /** 클럽으로 돌아오는 날 */
    returnsOn: string;
    /**
     * 이 창의 A매치 출전·골 — **여름 대회는 null이다.** 대회는 굴리지 않으므로
     * (competition.md §5-1) 0을 적으면 「0경기 뛰었다」는 없는 사실이 된다.
     */
    apps: number | null;
    goals: number | null;
  } | null;
  form: number;
  /** 폼의 말 — "절정"·"상승세"·"평소"·"침체"·"바닥" (form.ts와 같은 경계) */
  formLabel: string;
  /**
   * 폼 화살표의 각도(도, 시계 방향 · 0이 12시). **절정(+1)에서만 12시를 본다.**
   * 눈금으로 끊지 않고 연속으로 돌린다 — 경계는 UI가 아니라 form.ts가 정한다.
   */
  formAngle: number;
  /** 화살표 색 계열 */
  formTone: "up" | "flat" | "down";
  /**
   * 최근 경기 평점 — **오래된 것부터** 최대 5개. 폼이 어디서 왔는지 보여주는
   * 시간 축이다 (숫자 하나로는 "오르는 중인지 식는 중인지"를 알 수 없다).
   * 유저 팀 경기에만 평점이 남으므로 그 범위다.
   */
  recentRatings: RecentRatingView[];
  /**
   * **체력** — 지금 이 선수의 상태 0~100 (몸과 마음이 한 축이다).
   * 왜 이 값인지는 `mood` 한 문장이 설명한다.
   *
   * 경기 밖에서는 아침에 잰 값 그대로라 폭이 0이고, **경기 중 출전 명단의 선수는
   * 판세 탭과 같은 읽은 값**이다(`readCondition` · player.md §9.2). 한쪽만 참값을
   * 쓰면 감독이 두 탭을 견주는 것만으로 안개가 걷힌다.
   */
  condition: ConditionRead;
  /**
   * **경기 감각 0~100** — 최근에 뛰었는가 (player.md §5.4). 체력과 다른 축이다:
   * 하루 쉬어서 돌아오는 것이 아니라 출전 분이 올리고 결장이 깎는다.
   *
   * 안개를 지나지 않는다 — 원본이 출전 기록과 부상이고 둘 다 공개 사실이다.
   */
  sharpness: number;
  /** 경기 감각의 말 — "실전"·"올라옴"·"무딤"·"굳음" (player.ts와 같은 경계) */
  sharpnessLabel: string;
  /** 등급 자체 — 화면이 색과 정렬을 이 경계로 맞춘다 */
  sharpnessBand: SharpnessBand;
  /**
   * **누적 피로의 말** — "가뿐"·"쌓임"·"지침"·"과부하" (player.md §5.5).
   *
   * 체력 막대와 다른 축이다: 저건 오늘 아침의 예산이고 이건 시즌이 쌓아 둔 잔고라,
   * 경기 다음 날 바닥인 선수와 12월까지 쉬지 못한 선수가 여기서 갈린다. **숫자는
   * 싣지 않는다** — 감독이 관측하는 것은 출전 기록과 일정이다.
   */
  fatigueLabel: string;
  /** 등급 자체 — 화면이 색과 정렬을 이 경계로 맞춘다 */
  fatigueBand: FatigueBand;
  /**
   * **부상 위험 등급과 그 원인** (player.md §5.3) — 경기가 누가 다칠지 고를 때 쓰는
   * 저울(`injuryWeight`)을 그대로 읽은 값이다. 체력 막대와 다른 축이다: 잘 쉰
   * 유리몸도 여기서는 위로 선다.
   *
   * 성향 배수는 싣지 않는다 — 감독이 읽을 눈금이 없는 수다 (§10). 라벨은 화면이
   * 도메인 표에서 붙인다(`INJURY_RISK_GRADE_KO`) — 여기서 문장을 만들면 GM 조회와
   * 화면이 같은 등급을 두 낱말로 부른다.
   */
  injuryRisk: InjuryRisk;
  /**
   * 지금 심경 — **코어가 고른 사실 카드**와, 결산(LLM)이 다시 쓴 한 줄(`moodOf`).
   * 문장은 화면이 쓴다 (`apps/web/lib/mood.ts` · overview.md §1 철칙 4).
   */
  mood: MoodRead;
  /** 배치 역할 — 없으면 예비(스쿼드) */
  role: "선발" | "벤치" | "스쿼드";
  /** 이 전술에서 맡는 포지션 (배치가 있을 때) */
  assignedPosition: string | null;
  /**
   * 그 자리에서 맡는 **세부 역할** — 감독이 고른 것, 없으면 그 자리의 기본 역할.
   * `roleOptions`가 고를 수 있는 목록이고, 자리를 옮기면 목록이 통째로 바뀐다.
   *
   * **자리가 있어야 역할이 있다** (player.md §3.1) — 벤치·예비는 `null`에 빈
   * 목록이다. 주 포지션은 자리가 아니라서, 그 자리 기준의 역할을 켜 두면 화면이
   * 코어가 받지 않는 값을 고르게 한다.
   */
  roleId: string | null;
  roleOptions: Array<{ id: string; ko: string; abbr: string; desc: string }>;
  /**
   * **그 선수가 자리마다 마지막에 맡던 역할** — 자리 코드 → 역할 id
   * (`GameState.roleMemory` → player.md §3.2).
   *
   * 화면이 코어 `inherit`와 **같은 순서로** 되찾기를 재현하는 근거다. 없으면
   * 전술판은 벤치에서 올린 선수에게 기본 역할을 걸어 두었다가 자동 저장 응답이
   * 와서야 기억한 역할로 튄다 — 감독이 누른 적 없는 변경이다.
   *
   * 자리 목록에서 사라진 역할은 싣지 않는다 (`recallRole`과 같은 기준).
   */
  roleMemory: Record<string, string>;
  /**
   * 오늘 역할을 손댄 흔적 (`TacticAssignment.roleMemo`) — **화면이 대가를 저장 전에
   * 낼 수 있게** 함께 보낸다. `role`은 그날 아침의 역할(대가의 기준)이고 `paid`는
   * 오늘 이미 깎인 총량이다. 오늘 손대지 않았으면 null이고 기준은 `roleId`다.
   *
   * **자리 없는 행에도 싣는다** — 코어의 장부는 (선수·오늘)이라 벤치를 다녀와도
   * 흔적이 이어지는데, 선발 행에만 실으면 돌아온 선수의 적응도 미리보기가 서버와
   * 다른 자로 잰 값이 된다. 기준이 되는 자리는 `assignedPosition`이다.
   *
   * **아침의 자리를 벗어나 있으면 null이다** — 역할 목록은 자리마다 다르므로 옛
   * 자리의 역할을 기준으로 재면 화면이 서버와 다른 값을 예고한다 (player.md §7.2).
   */
  roleToday: { role: string; paid: number } | null;
  /** 전술판 좌표 (배치가 있을 때) — 자유 배치 UI의 그리기 기준 */
  assignedPoint: BoardPoint | null;
  /** 전술 적응도 — 이 전술을 얼마나 익혔나 */
  familiarity: number;
  /**
   * **판에 올리면 될 적응도** — 배치가 없는 행에서만 `familiarity`와 다르다.
   *
   * 코어는 배치되는 순간 선반(2군·예비를 다녀온 값)을 먼저 보고, 없을 때만
   * `min(기준선, 팀 적응도)`를 준다 (`newcomerFamiliarity` → player.md §7.3).
   * 화면이 그 규칙을 스스로 계산하면 돌아온 주전을 60으로 예고했다가 저장 뒤
   * 제 값으로 튄다 — 감독이 만들지 않은 상승이다. 규칙은 여기 하나만 둔다.
   */
  familiarityIfSlotted: number;
  /** 지금 맡은 자리의 포지션 적응도 (배치가 없으면 주 포지션 기준) */
  positionFit: number;
  /**
   * **적응도 하나로 합친 값** — 포지션 적응 + 전술 적응 (`adaptationOf`).
   * 명단은 칸이 하나뿐이라 둘 중 하나만 보이면 "왜 낮은지"를 늘 절반만 안다.
   */
  adaptation: number;
  instruction: string | null;
  isCaptain: boolean;
  isViceCaptain: boolean;
  /**
   * 라커룸 서열 — 리더 그룹 안의 순위(1부터), 그룹 밖이면 `null`
   * (→ docs/data/people.md §5-1). 화면과 조회 도구가 **같은 값**을 읽어야 해서
   * 여기 하나에서만 파생한다.
   */
  leaderRank: number | null;
  seasonGoals: number;
  seasonApps: number;
  seasonAssists: number;
  /**
   * 이번 시즌 **대회별** 1군 기록 — 위 세 칸은 대회 합이라 "리그 12경기 3골"을
   * 말할 자리가 없었다 (→ docs/data/game-state.md §3.4). 많이 뛴 대회부터 서고,
   * 대회가 하나뿐이면 합계가 이미 같은 수를 말했으므로 빈 배열이다.
   *
   * 대회 이름은 여기서 푼다 — 화면은 카탈로그를 읽지 못한다(`CareerSeasonView.team`과
   * 같은 이유). **옛 세이브의 축 없는 행은 어느 대회인지 모르므로 서지 않는다.**
   */
  seasonByCompetition: Array<{
    competitionId: string;
    /** 약칭 — 한 줄에 서너 대회가 나란히 선다 */
    name: string;
    apps: number;
    goals: number;
    assists: number;
  }>;
  /** 시즌 평균 평점 — 출전이 없으면 null (0.0과 "기록 없음"은 다르다) */
  seasonRating: number | null;
  /**
   * 경기가 남긴 나머지 — 출전 분·슛·xG·선방·클린시트·카드 (match.md §6).
   * 위 넷과 같은 "이번 시즌 이 팀" 한 행이고, 두 시뮬이 같은 눈금으로 얹은 값이라
   * 리그의 어느 선수든 같은 자로 읽힌다. 골키퍼가 아니면 선방·클린시트는 0이다.
   */
  seasonMinutes: number;
  seasonShots: number;
  seasonXg: number;
  seasonSaves: number;
  seasonCleanSheets: number;
  seasonYellows: number;
  seasonReds: number;
  /**
   * **시즌별과 통산** — 위 `season*` 칸들은 "이번 시즌 이 팀" 한 행이라, 3년 함께한
   * 주장이 우리 팀에서 몇 경기를 뛰었는지가 화면 어디에도 없었다.
   *
   * 시즌 행은 **자르지 않는다** — 카드(GM)는 상한을 두지만 상세는 스크롤이 되는
   * 자리고, 표는 전체 이력이 서라고 있는 물건이다. 출전이 0인 행은 애초에 빼므로
   * 개막 전에는 빈 배열이고, 화면은 그때 표를 세우지 않는다.
   *
   * 시즌 오름차순, 같은 시즌 안에서는 팀 id 순 (`careerOf`와 같은 순서).
   */
  career: { seasons: CareerSeasonView[]; totals: CareerTotalsView };
  /**
   * 마일스톤 — **최근 것 몇 건**만 (`SQUAD_MILESTONES_SHOWN`). 장부는 감독 팀
   * 선수만 담으므로 스쿼드 행에는 늘 온전히 있다 (game-state.md §3.4).
   * 오래된 것부터 적는다 — 표의 시즌 행과 같은 방향이다.
   */
  milestones: MilestoneView[];
  hasIssue: boolean;
  /** 주급 (£/주) */
  weeklyWage: number;
  contractUntil: string | null;
  /**
   * **어떤 자리로 왔는가** — 계약에 적힌 지위, 없으면 지금 서열에서 파생
   * (`squadStatusOf` → docs/data/people.md §5-2). 그 지위가 부르는 선발 비율이
   * 출전 불만과 약속 이행을 함께 재므로, 화면과 GM이 **같은 값**을 읽어야 한다.
   */
  squadStatus: SquadStatus;
  /**
   * 아직 기한 전인 **감독의 약속** — 갈래와 기한뿐이다 (people.md §5-2).
   * 무슨 말로 약속했는지는 장면의 것이라 여기 오지 않는다.
   */
  promises: Array<{ kind: PromiseKind; dueOn: string }>;
  /** 현재 부상 (없으면 null) */
  injury: { bodyPart: string; severity: string; expectedReturn: string } | null;
  /** 출장 정지 잔여 경기 (0이면 정지 아님) */
  suspended: number;
  available: boolean;
}

/**
 * 달력 일지의 한 줄.
 *
 * ⚠️ 아이콘을 **문자열에 박지 않는다.** 이모지를 앞에 붙이면 ① 플랫폼마다 모양·
 * 너비가 달라 줄이 흔들리고 ② UI가 종류를 알 수 없어 색·정렬로 구분할 방법이 없다.
 * 종류는 데이터로 주고 그림은 화면이 그린다.
 */
export interface CalendarEventView {
  kind:
    | "match"
    | "training"
    | "rest"
    | "growth"
    | "injury"
    | "return"
    | "yellow"
    | "red"
    | "transfer"
    | "window"
    /** 큰 비정기 수입·지출 — 정액 항목은 서지 않는다 (docs/simulation/finance.md §8.2) */
    | "money"
    /**
     * 소식 — **서사 표(`state.narrative`)가 그대로 선 줄** (people.md §9).
     *
     * 시간을 넘긴 턴에 코어가 굴린 일은 다이제스트로만 가고 화면에는 서지 않는다.
     * 그 사건의 원본은 이미 서사 표에 있으니 여기서 날짜에 세운다 — 코어가 새 문장을
     * 쓰는 것이 아니다.
     */
    | "news";
  text: string;
  /**
   * 접어 둔 상세 — 있으면 UI가 눌러서 펼친다. 성장처럼 **한 날에 스무 줄이 나오는**
   * 기록은 요약만 세우고 목록은 여기 둔다.
   */
  details?: string[];
}

export interface CalendarEntryView {
  id: string;
  date: string;
  time: string;
  type: ScheduleType;
  status: "scheduled" | "done";
  /** 한 줄 전체 설명 — 상세 패널·툴팁용 */
  title: string;
  detail: string | null;
  result: string | null;
  win: "W" | "D" | "L" | null;
  isNext: boolean;
  /**
   * 경기 전용 조각 — 달력 칸은 좁아서 제목을 통째로 쓸 수 없다.
   * 여기서 조각을 주면 UI가 `title`을 정규식으로 도려내지 않아도 된다.
   */
  match: {
    /**
     * 어느 경기인가 (`MATCH.id`) — 달력 행이 **경기 리포트를 열 열쇠**다 (match.md §8).
     *
     * 엔트리 id로 대신할 수 없다: 그러면 리포트를 부르는 자리가 종료 카드(경기 id)와
     * 달력(엔트리 id) 둘로 갈리고, 한 라우트가 두 가지 id를 받게 된다.
     */
    matchId: string;
    /** 대회 약칭 — 리그는 null (기본값이라 칸에 적지 않는다) */
    competition: string | null;
    /** 단계 표기 — 리그는 라운드(`R7`), 컵은 `16강 1차전` */
    stage: string;
    /** 상대 팀 약칭 (`LIV`) — 좁은 칸에서 풀네임은 세 줄로 접힌다 */
    opponent: string;
    /** 상대 팀 이름 — 자리가 있는 상세 패널이 쓴다 */
    opponentName: string;
    venue: "home" | "away" | "neutral";
    /** 우리 관점 스코어 `2-1` — 미진행이면 null */
    score: string | null;
  } | null;
  /**
   * 컵 조각 — 추첨(`draw`)과 예정 라운드(`cup-round`)가 함께 쓴다.
   * 좁은 달력 칸이 제목을 자르지 않도록 대회 약칭과 단계를 나눠서 준다.
   */
  cup: { competition: string; stage: string } | null;
  /**
   * 훈련 엔트리가 **휴식**인가 (`TRAINING_SESSION.rest`).
   * 달력은 이걸로 점 색을 가른다 — 같은 노란 점이면 "쉬는 날"과 "훈련하는 날"이
   * 한눈에 구분되지 않아, 감독이 비워 둔 주를 훑을 수 없다.
   */
  rest?: boolean;
}

/** 대회 일정의 한 경기 */
export interface CompetitionMatchView {
  id: string;
  date: string;
  time: string;
  homeName: string;
  awayName: string;
  homeShort: string;
  awayShort: string;
  /** 결과 — 미진행이면 null. 승부차기는 괄호로 붙는다 */
  score: string | null;
  /** 우리 팀 경기 */
  ours: boolean;
  /** 우리 경기의 결과 (아니면 null) */
  win: "W" | "D" | "L" | null;
  neutral: boolean;
}

/** 라운드/단계 하나 — 대회 일정의 묶음 단위 */
export interface CompetitionRoundView {
  key: string;
  label: string;
  /** 이 라운드의 시작일 (표시·정렬용) */
  date: string;
  matches: CompetitionMatchView[];
  /** 오늘에 가장 가까운 라운드 — UI가 기본으로 펼친다 */
  current: boolean;
}

/**
 * 다음 경기 한 칸 — **팀 단위와 대회 단위가 같은 조각을 쓴다.**
 *
 * 조각으로 싣는 이유: 화면이 날짜·상대·홈원정을 각자 배치하려면 조각이 필요하고,
 * 무엇보다 **며칠 남았는지**가 있어야 한다. 체력이 자리마다 다르게 깎이고 회복이
 * 며칠에 걸리는 지금(match.md §3), "사흘 뒤"인지 "엿새 뒤"인지가 곧 로테이션 판단이다.
 */
export interface NextMatchView {
  /**
   * 어느 경기인가 (`MATCH.id`) — 카드가 **그 경기의 상대 분석**을 집을 열쇠다
   * (match.md §1.8). 대회 탭이 세우는 경기와 팀의 다음 경기가 갈릴 수 있으므로
   * 이름·날짜로 맞춰 보게 두면 같은 날 두 경기가 있는 주에 엉뚱한 판이 붙는다.
   */
  matchId: string;
  date: string;
  /** 킥오프 시각 `20:00` */
  time: string;
  /** 어느 경기인가 — 팀 단위는 대회까지(`프리미어리그 R2`), 대회 단위는 그 대회의 라운드 */
  label: string;
  /** 상대 팀 이름 (풀네임) */
  opponent: string;
  venue: "home" | "away" | "neutral";
  /** 오늘로부터 며칠 뒤인가 — 0이면 오늘이다 */
  inDays: number;
}

/**
 * 경기 전 상대 분석 — **다음 경기 카드에 접혀 붙는다** (match.md §1.8 · §8).
 *
 * 조립은 코어 한 곳(`buildOpponentReport`)이고 여기서 하는 일은 문장으로 옮기는
 * 것뿐이다: 태그는 `packetTagText`가, 6축의 낱말은 화면이 `TACTIC_AXES`로 만든다.
 * 조회 도구(`get_opponent_report`)와 GM 입력의 브리핑도 같은 리포트를 읽는다 —
 * 셋이 각자 세우면 같은 상대가 세 가지로 읽힌다.
 */
export interface MatchPreviewView {
  matchId: string;
  /**
   * 상대 예상 XI — **직전 경기 선발에서 투영**한 것이라 예상이다 (match.md §1.8).
   * `carried`가 `false`인 줄은 코어가 메운 자리다.
   */
  expectedXI: {
    id: string;
    name: string;
    position: string;
    squadNumber: number | null;
    carried: boolean;
  }[];
  /** 투영의 근거가 된 상대의 직전 경기 — 없으면 개막전이다 */
  basis: { date: string; label: string } | null;
  /** 직전 경기 선발에서 이어지지 못해 코어가 메운 인원 — 예상의 흐릿한 정도다 */
  guessed: number;
  /** 부상·정지·대표팀 소집으로 못 나오는 상대 선수 (`AbsentReason` — `match/preview.ts`) */
  absent: { name: string; position: string; reason: AbsentReason; note: string }[];
  /** 상대가 세워 둔 모양과 6축 — 전술판과 같은 조각이라 화면이 같은 낱말을 쓴다 */
  shape: TacticsView;
  /**
   * 상성·키포인트 — `ours`는 **우리 편에 이로운 줄인가**다.
   * 판세 화면의 `keyPoints`와 같은 계약이라 화면이 같은 색 규칙을 쓴다.
   */
  keyPoints: { text: string; ours: boolean | null }[];
}

/**
 * 최근 결과 한 줄 — **사실만** (competition.md §7).
 *
 * `"EPL R7 TOT 2-1 ARS (승부차기 4-3)"`처럼 붙여 내면 화면은 승패 색을 칠하려고 그
 * 문자열을 도로 가르고, 승부차기 괄호 규칙이 코어의 템플릿 문자열 안에 숨는다.
 * 조각으로 내려가면 화면이 스코어를 굵게, 우리 편을 진하게, 승패를 색으로 세운다.
 */
export interface RecentResultView {
  /** 어느 경기인가 — `EPL R7` · `FA컵 8강` · `친선` */
  label: string;
  /** 홈 팀 약칭 — 우리 편이 어느 쪽인지는 `venue`가 말한다 */
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
  /** 승부차기로 갈린 경기만 — 스코어를 바꾸지 않고 옆에 선다 (competition.md §6) */
  penalties: { home: number; away: number } | null;
  /** 우리가 어느 쪽이었나 — 중립 결승도 있다 */
  venue: "home" | "away" | "neutral";
  /** 우리 시점의 결과 */
  outcome: "W" | "D" | "L";
}

/**
 * 그 대회에서 **우리 구단**의 역대 우승 — 시드와 게임 안의 우승을 더한 것
 * (career.md §6 · `clubRecordsOf`).
 *
 * ⚠️ **없으면 이 조각 자체가 `null`이다.** 카탈로그에 `honours`가 없는 구단은
 * 0회가 아니라 **모르는** 것이라(team.md §1) 화면에 `0회`를 세우면 안 된다.
 * `"3년 만의 우승"` 같은 문장도 여기 없다 — 사실만 내고 문장은 화면이 잇는다.
 */
export interface CompetitionHonoursView {
  /** 시드 + 게임 안 = 역대 */
  count: number;
  /** 게임이 시작되기 전의 몫 (카탈로그 `honours`) */
  seeded: number;
  /** 게임 안에서 든 우승 — 최근이 앞 */
  won: { season: number; label: string }[];
  /** 카탈로그가 든 마지막 연도 — `won`이 있으면 그쪽이 더 최신이다 */
  lastYear: number | null;
}

/**
 * 지난 시즌 순위표의 한 줄 — **이름은 코어가 붙여 내린다.**
 *
 * 결산 스냅샷은 팀 id만 들고(game-state.md §3.3) 이름은 카탈로그·세이브가 갖는데,
 * 화면이 그걸 뒤지면 엔진을 값으로 import하게 된다 (AGENTS.md §5).
 */
export interface SeasonTableRowView {
  /** 1부터 — 스냅샷의 행 순서가 곧 순위다 */
  position: number;
  teamId: string;
  name: string;
  short: string;
  /** 우리 구단인가 — 지금 맡은 구단 기준이다 (아래 `pastSeasons`) */
  ours: boolean;
  /**
   * 그 시즌 성적 — **옛 세이브에서 이관된 행은 `null`이다.** 그런 행이 아는 것은
   * 순서뿐이라(game-state.md §3.3) 승점 칸을 0으로 채우면 없는 사실이 생긴다.
   */
  record: {
    played: number;
    wins: number;
    draws: number;
    losses: number;
    goalsFor: number;
    goalsAgainst: number;
    goalDiff: number;
    points: number;
  } | null;
}

/**
 * 그 시즌 그 리그의 시상 한 건 — **코드와 근거 수치만** (season.md §6 · 철칙 4).
 * 상의 이름은 `awardTitle(code)`가 주고 문장은 화면이 쓴다.
 */
export interface CompetitionAwardView {
  code: string;
  playerName: string;
  teamName: string;
  teamShort: string;
  apps: number;
  goals: number;
  assists: number;
  /** 시즌 평점 — 출전이 없으면 없다 */
  rating?: number;
  /** `young-player`가 센 나이 */
  age?: number;
}

/** 역대 절에 서는 팀 한 칸 — 우승·준우승이 같은 조각을 쓴다 */
export interface SeasonTeamView {
  teamId: string;
  name: string;
  short: string;
  /** 우리 구단인가 — 컵은 순위표가 없어 이 칸만이 "우리 해였나"를 말한다 */
  ours: boolean;
}

/**
 * 지나간 시즌 한 줄 — 그 시즌 이 대회가 남긴 것 (season.md §6).
 *
 * 우승·준우승은 **표와 트로피에서 파생한다**: 리그는 순위표의 1위·2위, 녹아웃은
 * `TROPHY`의 우승 팀·결승에서 진 팀. 우승자를 따로 적지 않는 이유가 그것이다
 * (game-state.md §3.3).
 *
 * ⚠️ **우리**는 언제나 **지금 맡은 구단**이다. 감독이 옮겨 다녀도 대회 탭의 역대
 * 절은 이 구단의 역사이고, 감독의 이력은 커리어 화면이 따로 든다 (career.md §6).
 */
export interface CompetitionSeasonView {
  season: number;
  /** `2026-27` — 시즌 번호를 연도로 읽는 한 자리 (`seasonLabelOf`) */
  label: string;
  champion: SeasonTeamView | null;
  /** 준우승 — 리그는 표의 2위, 녹아웃은 결승에서 진 팀. 옛 트로피엔 없다 */
  runnerUp: SeasonTeamView | null;
  /** 그 시즌 우리 구단의 순위 — 그 리그에 없었으면 null (다른 리그·컵) */
  ourPosition: number | null;
  /** 그 시즌 최종 순위표 — 리그전을 돈 대회만. 컵은 빈 배열이다 */
  table: SeasonTableRowView[];
  /**
   * 그 시즌 **이 대회의** 시상 (season.md §6) — 리그는 넷, 컵·대항전은 득점왕과
   * 결승 MOM 둘. 옛 세이브의 컵에는 상이 없어 빈 배열이다.
   */
  awards: CompetitionAwardView[];
}

/**
 * 대회 하나 — 순위표 + 라운드별 일정 (+ 대항전이면 브래킷).
 * 우리가 나가는 대회만 만든다 (감독의 관심 범위 = 우리 리그 + 우리 대항전).
 */
export interface CompetitionView {
  id: string;
  name: string;
  short: string;
  kind: "league" | "cup";
  /** 순위표 — 국내 컵은 순수 녹아웃이라 **빈 배열**이다 (표 대신 브래킷을 본다) */
  standings: StandingRow[];
  /**
   * 홈 소계·원정 소계로 다시 세운 표 — **같은 행이고 순서만 다르다**
   * (competition.md §2). 화면은 셋 중 하나를 고를 뿐 순서를 만들지 않는다
   * (overview.md §5) — 정렬 규칙이 화면에 서면 순위표가 두 곳에서 정의된다.
   */
  homeTable: StandingRow[];
  awayTable: StandingRow[];
  /**
   * 개인 순위와 팀 열 — 순위표가 없는 국내 컵은 null.
   *
   * ⚠️ **개인 순위는 리그에만 선다** — 기록은 대회별로 갈리지만 평점 축의 출전
   * 문턱이 순위표에서 나오고 컵에는 순위표가 없다 (season.md §9). 팀 열은 경기
   * 결과에서 나오므로 대항전 리그 페이즈에도 선다.
   */
  leaders: CompetitionLeadersView | null;
  /** 순위 구역 — 챔스·유로파 진출권(리그) 또는 본선 직행·플레이오프(대항전) */
  zones: StandingZone[];
  /** 우리 순위 (0 = 순위표에 없음) */
  userPosition: number;
  /**
   * **이 대회의** 다음 우리 경기 — 남은 경기가 없으면 null(탈락·일정 종료·추첨 전).
   * 팀 단위 `competitions.nextMatch`와 같은 조각이고, 무엇을 세울지는 화면이 고른다
   * (메인 UI는 보고 있는 대회, 경기 중 탭은 팀 — overview §5 · match.md §8).
   */
  nextMatch: NextMatchView | null;
  rounds: CompetitionRoundView[];
  /** 녹아웃 단계별 대진 — 리그는 빈 배열 */
  bracket: BracketStageView[];
  /** 컵에서 우리가 어디까지 갔나 — 순위표가 없는 대회의 "현재 위치" */
  cupProgress: CupProgressView;
  /** 대항전 전용 — 리그 페이즈 통과 경계선 */
  europe: EuropeView | null;
  /**
   * 이 대회에서 **우리 구단**의 역대 우승 — 시드도 게임 안의 우승도 없으면 null.
   * 없는 것은 0회가 아니라 모르는 것이다 (team.md §1).
   */
  honours: CompetitionHonoursView | null;
  /**
   * 지나간 시즌 — 최근이 앞. 첫 시즌엔 빈 배열이고, 그 시즌 이 대회에 대해 아는
   * 것이 하나도 없는 해는 줄을 세우지 않는다.
   */
  pastSeasons: CompetitionSeasonView[];
}

/** 대회 화면의 개인 순위·팀 열 (competition.md §2 「개인 순위」) */
export interface CompetitionLeadersView {
  /** 축별 상위 열 — 줄이 하나도 없는 축은 빠진다. 대항전은 빈 배열 */
  players: LeaderBoard[];
  /** 팀 열 — 순위표와 같은 순서다 */
  teams: TeamStatRow[];
}

/**
 * 컵 진행 — **브래킷 해석은 코어가 한다.**
 *
 * 화면이 대진을 뒤져 "우리가 마지막으로 선 단계"를 찾으면 같은 장부를 두 곳에서
 * 읽게 되고, 그 규칙이 갈리면 순위표 없는 대회의 머리줄만 조용히 틀린다.
 * 코어는 단계와 결말만 내고 "8강 탈락"이라는 문장은 화면이 잇는다.
 */
export interface CupProgressView {
  /** 우리 대진이 마지막으로 선 단계 이름 — 아직 서 본 적이 없으면 null */
  stage: string | null;
  /**
   * 그 단계에서 무슨 일이 있었나.
   * `undrawn` 추첨 전 · `out` 대진에 우리가 없다 · `eliminated` 그 단계에서 졌다 ·
   * `champion` 결승에서 이겼다 · `through` 통과해 다음을 기다린다
   */
  outcome: "undrawn" | "out" | "eliminated" | "champion" | "through";
}

/** 브래킷에서 우리 자리를 읽는다 — `cupProgress`의 단일 규칙 */
export function cupProgressOf(bracket: readonly BracketStageView[]): CupProgressView {
  const ours = bracket.filter((stage) => stage.ties.some((t) => t.ours));
  const last = ours[ours.length - 1];
  if (!last) return { stage: null, outcome: bracket.length === 0 ? "undrawn" : "out" };
  const tie = last.ties.find((t) => t.ours)!;
  if (tie.won === false) return { stage: last.label, outcome: "eliminated" };
  if (tie.won === true && last.stage === "final") return { stage: last.label, outcome: "champion" };
  return { stage: last.label, outcome: "through" };
}

export interface BracketStageView {
  stage: string;
  label: string;
  ties: Array<{
    /** 마지막 경기 날짜 — 순수 녹아웃 대회는 브래킷이 곧 일정표다 */
    date: string;
    home: string;
    away: string;
    score: string | null;
    ours: boolean;
    won: boolean | null;
  }>;
}

/**
 * 순위표 구역 — 그 순위에 무슨 뜻이 붙는가 (챔스 진출·본선 직행 등).
 * 대회 카탈로그의 티켓 수에서 파생되고, 강등·승격 구역은 승강 규칙에서 나온다.
 */
export interface StandingZone {
  /** 이 구역이 끝나는 순위 (1부터, 포함) */
  through: number;
  label: string;
  /** 색 키 — 리그는 대회 id(`ucl`·`uel`·`uecl`), 대항전은 통과 방식(`direct`·`playoff`) */
  kind: string;
}

/** 대항전 뷰 — 리그 페이즈 순위표에 긋는 통과 경계선 (우리 팀 대회만) */
export interface EuropeView {
  competitionId: string;
  competition: string;
  short: string;
  standings: StandingRow[];
  ourPosition: number;
  /** 리그 페이즈 통과 기준 — 직행 / 플레이오프 경계 (순위표에 선을 긋는다) */
  directSlots: number;
  playoffCutoff: number;
}

/**
 * 그 선수가 **이 경기에서 한 일** — 장부 사건(`ledger.events`)에서 파생한다.
 *
 * 감독이 중계를 보며 묻는 것은 셋이다: 누가 넣었나, 누가 위험한가(경고),
 * 누가 계속 때리는데 안 들어가나. 저장하지 않는다 — 사건 목록이 원본이다.
 */
export interface MatchTally {
  goals: number;
  assists: number;
  shots: number;
  saves: number;
  yellows: number;
  red: boolean;
  /** 주고받은 패스 — 사건이 아니라 구간마다 쌓이는 양 (`MatchStatLine`) */
  passes: number;
  /** 그중 전진 패스 */
  progressive: number;
  /** 그 선수가 만든 기대 득점의 합 — 슛의 질이다 */
  xg: number;
  /** 실제 슈터의 결정력을 반영한 골 확률 합. */
  scoringExpectation: number;
  /** 그 선수가 찬 코너 — 죽은 공을 누가 올리는지가 여기 남는다 (match.md §4) */
  corners: number;
  /** 그 선수가 범한 파울 */
  fouls: number;
}

/** 경기 중 한 선수 — 지금 내는 전력과 남은 다리 */
export interface MatchPlayerView {
  id: string;
  name: string;
  /** 현재 소속팀 등번호. 아직 배정되지 않았으면 null */
  squadNumber: number | null;
  /** 나이 — 안개를 지나지 않는다 (등번호와 같이 90분 동안 보이는 사실) */
  age: number;
  /** 이번 시즌 평점, 출전이 없으면 null — 공개 기록이라 상대도 같은 값이다 */
  seasonRating: number | null;
  position: string;
  /** 경기 패킷이 계산에 사용한 실제 전술판 좌표. */
  point?: import("@story-fm/domain").BoardPoint;
  /**
   * 이 자리에서 지금 내는 전력 (상태·적응도 반영) — **정수로 반올림해 넘긴다.**
   * 코어는 소수로 셈하지만 감독이 89.7과 89.6을 견줄 일은 없고, 명단의 OVR·
   * `slotOverall`이 전부 정수라 소수 한 자리만 다른 눈금을 쓰면 같은 값으로
   * 안 읽힌다.
   *
   * **상대 선수는 안개를 지난 값**이다 — 명단 화면의 OVR과 **같은 채널**
   * (`observationOf`의 `overallOffset`)을 쓴다. 채널이 갈리면 같은 상대 선수가
   * 스쿼드 화면과 경기 화면에서 다른 숫자로 보인다.
   */
  effective: number;
  /** 그 전력의 오차 폭 (±) — 0이면 정확히 아는 선수다 (우리 선수·스카우팅 완료) */
  margin: number;
  /**
   * 지금 남은 체력 0~100, 높을수록 좋다 (저장값 − 경기 중 소모).
   * **상대 선수는 감독이 읽은 값**이다 — 참값은 `low~high` 안에 있다 (scouting.ts).
   */
  condition: ConditionRead;
  /** 다리가 멈췄나 — 이 자리에 구멍이 나 있다 (stamina.ts). 상대는 읽은 값 기준 */
  gassed: boolean;
  /** 우리 팀 선수인가 — 교체 대상을 가린다 */
  ours: boolean;
  /** 이 경기에서 한 일 — 사건 목록의 파생 */
  tally: MatchTally;
}

/** 선발 평균 전력 — 그라운드 위 열한 명의 평균(정수). 빈 명단이면 0 */
function xiRatingOf(players: readonly MatchPlayerView[]): number {
  if (players.length === 0) return 0;
  return Math.round(players.reduce((sum, p) => sum + p.effective, 0) / players.length);
}

/** 팀 합계 — 선수별 `tally`를 더한다. 경고·퇴장은 사람 단위라 세지 않는다 */
function tallyTotal(players: readonly MatchPlayerView[]): MatchTally {
  return players.reduce<MatchTally>(
    (acc, p) => ({
      goals: acc.goals + p.tally.goals,
      assists: acc.assists + p.tally.assists,
      shots: acc.shots + p.tally.shots,
      saves: acc.saves + p.tally.saves,
      yellows: acc.yellows + p.tally.yellows,
      red: acc.red || p.tally.red,
      passes: acc.passes + p.tally.passes,
      progressive: acc.progressive + p.tally.progressive,
      xg: acc.xg + p.tally.xg,
      scoringExpectation: acc.scoringExpectation + p.tally.scoringExpectation,
      corners: acc.corners + p.tally.corners,
      fouls: acc.fouls + p.tally.fouls,
    }),
    {
      goals: 0,
      assists: 0,
      shots: 0,
      saves: 0,
      yellows: 0,
      red: false,
      passes: 0,
      progressive: 0,
      xg: 0,
      scoringExpectation: 0,
      corners: 0,
      fouls: 0,
    },
  );
}

/**
 * 우열 — **우리 편 기준으로 접은 `EdgeSide`.**
 *
 * 코어의 판정은 홈/원정 축이지만 판세 화면이 묻는 것은 "우리가 이기고 있나"뿐이고,
 * 화면이 그 접기를 스스로 하면 홈일 때와 원정일 때 색이 뒤집힌다.
 */
export type MatchEdge = "ours" | "theirs" | "even";

/**
 * 두 전력의 우열 — **문턱은 코어(`edgeOf`)가 갖는다.**
 *
 * 여기서 하는 일은 홈 기준 판정을 우리 기준으로 옮기는 것뿐이다. 비율의 분모가
 * 0인 칸은 견줄 것이 없으므로 팽팽한 것으로 둔다.
 */
function edgeFor(ours: number, theirs: number): { edge: MatchEdge; size: EdgeSize } {
  const { edge, size } = edgeOf(theirs > 0 ? ours / theirs : 1);
  return { edge: edge === "even" ? "even" : edge === "home" ? "ours" : "theirs", size };
}

/**
 * 경기 화면 — **중계 채팅 밖에서도 판세가 보여야 한다.**
 *
 * 채팅은 흘러가고, 감독은 "지금 어디가 밀리는지 · 무엇이 통하고 있는지 · 누구를
 * 빼야 하는지"를 한눈에 봐야 한다. 전부 이미 코어가 계산해 둔 값이고 여기서는
 * 화면이 읽을 모양으로만 옮긴다.
 */
export interface MatchView {
  /** 어느 경기인가 (`MATCH.id`) — 화면이 종료 시점을 잡고 기록을 찾는 데 쓴다 */
  matchId: string;
  competition: string;
  stage: string;
  home: { name: string; short: string; ours: boolean };
  away: { name: string; short: string; ours: boolean };
  score: { home: number; away: number };
  minute: number;
  /** "전반" · "후반" · "종료" */
  phase: string;
  /**
   * 아직 경기장에 들어서기 전인가 — `start_match`는 준비만 하고 **감독이 문을 지날 때**
   * 화면이 경기로 넘어간다. 화면은 이 값으로 입장 확인 창을 세운다.
   */
  beforeKickoff: boolean;
  /**
   * 세 전선의 매치업 — **격자 줄 머리**가 읽는 값.
   *
   * 맞붙는 두 값을 견준다: 공격 존의 상대 값은 상대 **수비**다. 값도 우열도
   * 격자와 같은 축(`ours`/`theirs`)으로 접혀 있고, `label`은 홈이 왼쪽인 판에서
   * 그 줄이 누구의 진영인지를 이미 말한다 — 화면이 홈/우리를 다시 따지지 않는다.
   */
  zones: {
    zone: "attack" | "midfield" | "defense";
    /** "우리 진영" · "중원" · "상대 진영" */
    label: string;
    ours: number;
    theirs: number;
    edge: MatchEdge;
    size: EdgeSize;
  }[];
  /**
   * 득점 기록 — **스코어 옆에 이름이 서야 한다.**
   * 숫자만 보고 누가 넣었는지 중계를 거슬러 올라가 찾게 두지 않는다.
   */
  goals: {
    minute: number;
    side: "home" | "away";
    scorer: string;
    assist: string | null;
    /** 우리 골인가 — 색으로 가른다 */
    ours: boolean;
  }[];
  /** 90분 기대 득점 — 지금 판세의 요약 숫자 */
  expectedGoals: { home: number; away: number };
  /**
   * 판세 격자 — 세 전선을 좌·중·우로 쪼갠 9칸.
   *
   * **자리는 홈 기준**이다: `defense`가 홈의 진영, `attack`이 홈이 공격하는 쪽.
   * 화면이 홈을 왼쪽에 두므로 스코어보드·득점과 좌우가 늘 같다.
   * **값은 우리 편 기준**이라 색은 우리가 이기는 칸에서 밝아진다.
   * 각 줄 세 칸의 평균은 그 줄의 존 전력과 같다 (sim `zone-grid.ts`).
   */
  grid: {
    band: "defense" | "midfield" | "attack";
    lane: "left" | "center" | "right";
    ours: number;
    theirs: number;
    /**
     * 그 칸의 우열 — **문턱은 코어가 갖는다**(`sim`의 `edgeOf`, 매치업 문장과 같은
     * 밴드). 화면이 비율을 다시 재면 한쪽만 고쳐질 때 같은 판이 두 색으로 보인다.
     */
    edge: MatchEdge;
    size: EdgeSize;
  }[];
  /**
   * 발동한 상성·구멍·미스매치 — 감독이 지금 손볼 자리.
   * `ours`는 **우리 편에 이로운 줄인가**다 (모르면 `null` — 옛 세이브의 진행 중 경기).
   */
  keyPoints: { text: string; ours: boolean | null }[];
  /**
   * 지금 노리고 있는 지점의 설명 — 화면이 "공략 중"으로 표시한다.
   * 감독이 지시한 것이 판에 반영되고 있다는 유일한 증거다.
   */
  exploiting: string[];
  /**
   * 양팀 전술 6축 + 소화율. `shift`는 그 팀 벤치가 **이 경기에서 마지막으로 판을
   * 옮긴 정지점** — 장부의 `tactical_shift` 사건에서 파생한다 (match.md §4·§8).
   */
  tactics: {
    home: TacticsView & MatchTacticsExtra;
    away: TacticsView & MatchTacticsExtra;
  };
  onPitch: { home: MatchPlayerView[]; away: MatchPlayerView[] };
  bench: { home: MatchPlayerView[]; away: MatchPlayerView[] };
  /**
   * 선발 평균 전력 — 그라운드 위 열한 명의 `effective` 평균(정수).
   * 상대 쪽은 안개를 지난 값이라 **화면이 다시 평균 내면** 우리 쪽과 다른 자로 잰 값이 된다.
   */
  xiRating: { home: number; away: number };
  /** 팀 합계 — 선수별 `tally`의 합. 표에 열을 더 세우지 않고 한 줄로 세운다 */
  totals: { home: MatchTally; away: MatchTally };
  /**
   * 교체 사용량과 **국면의 한도** — 한도는 장부의 `subLimitsOf`가 정한다(연장 6인/4회).
   * 화면이 5/3을 다시 적어 두면 연장에서 여섯 번째 카드가 없는 것처럼 읽힌다.
   */
  subs: {
    home: { used: number; windows: number };
    away: { used: number; windows: number };
    limit: { subs: number; windows: number };
  };
  sentOff: string[];
  /**
   * 승부차기 — 120분이 승부를 못 가른 경기에만 선다.
   *
   * 합계는 킥 목록에서 다시 센다(`shootoutTally`) — 두 벌로 두면 조용히 갈린다.
   */
  shootout: { tally: { home: number; away: number }; kicks: MatchShootoutKickView[] } | null;
}

/**
 * 승부차기 한 발 — **찬 순서 그대로** 화면에 남는다 (match.md §8).
 *
 * 감독이 다음 키커를 정하려면 누가 찼고 들어갔는지 막혔는지가 보여야 한다.
 * 성공 확률은 넘기지 않는다 — 화면이 입에 담지 않는 게임 내부 수치다.
 */
export interface MatchShootoutKickView {
  round: number;
  side: "home" | "away";
  /** 팀 약칭 — 우리 편 색만으로는 두 줄이 갈리지 않는다 */
  team: string;
  taker: string;
  /** 막아선 골키퍼 — 명단에 골키퍼가 없는 옛 세이브에서만 빈다 */
  keeper: string | null;
  outcome: ShootoutOutcome;
  ours: boolean;
}

/** 오피스 뷰 — 상태의 읽기 전용 프로젝션 (overview §5) */
export interface OfficeViews {
  /** 경기 중에만 채워진다 — 그 밖에는 null */
  match: MatchView | null;
  squad: {
    manager: {
      name: string;
      background: string;
      attributes: Record<string, number>;
      reputation: Record<string, number>;
      /**
       * 보드 경고 — 한도에 닿으면 자리가 없어진다(`market/manager-market.ts`).
       * 경질은 이 세이브가 끝나는 유일한 길이라 카운터가 화면에 서 있어야 한다:
       * 끝이 예고 없이 오면 사건이 아니라 사고다.
       */
      boardWarnings: number;
      warningLimit: number;
      /** 마지막 경고일 — 압박의 시계 (경고를 받은 적이 없으면 null) */
      lastWarnedOn: string | null;
      /** 축별 누적 XP — 훈련은 세션당 0.5라 소수로 쌓인다 (뷰는 반올림해 싣는다) */
      xp: Record<string, number>;
      /** 한 칸에 필요한 XP · 성장 상한 — 규칙 숫자의 원본은 `grantManagerXP`다 */
      xpPerLevel: number;
      attrCap: number;
    };
    players: SquadViewRow[];
    formation: string;
    tactics: TacticsView;
    /** 선발 평균 전술 적응도 — 전술을 바꾸면 떨어진다 */
    familiarity: number;
    editable: boolean;
    firstTeamCount: number;
    reserveCount: number;
    /** 등록 명단 현황 — 1군에서 파생 (저장하지 않는다) */
    registration: SquadRegistration;
    /**
     * **죽은 공 키커** — 자리 셋 각각의 지정과 지금 실제로 설 사람 (`SetPieceTakerView`).
     * 승부의 4분의 1이 세트피스에서 나오는데(match.md §1.4) 감독이 화면에서 만질 수
     * 있는 유일한 자리다.
     */
    setPieces: Record<SetPieceRole, SetPieceTakerView>;
    /**
     * **여름의 유스 후보** — 아직 계약하지 않은 사람들이라 명단 행이 아니라 제 구획을
     * 갖는다 (season.md §6). 소집일이 지나면 null이다.
     *
     * ⚠️ 종합도 잠재력도 **관측값**이다 (`youthCandidateFog` — player.md §9). 화면이
     * 참값을 그리면 안개가 뚫린다.
     */
    youthIntake: YouthIntakeView | null;
  };
  calendar: {
    today: string;
    preseasonStart: string;
    seasonStart: string;
    seasonEnd: string;
    entries: CalendarEntryView[];
    /** 일자별 사건 일지 — 기록 테이블에서 파생 (저장하지 않는다) */
    events: Record<string, CalendarEventView[]>;
    windows: Array<{ kind: string; opensOn: string; closesOn: string; open: boolean }>;
  };
  finance: {
    balance: number;
    weeklyWages: number;
    transferBudget: number;
    budgetFrozen: boolean;
    /**
     * **감독이 보드에 건 것** (finance.md §9.6) — 답이 끝나지 않은 요청 하나와,
     * 이름 하나 앞에 걸려 있는 영입 승인분.
     *
     * 값과 라벨만 낸다. 보드가 무슨 말로 그렇게 답했는지는 GM이 쓴다.
     */
    board: {
      /** 답을 기다리거나(`pending`) 조건이 걸린(`conditional`) 요청 — 한 번에 하나다 */
      request: {
        /** 종류 이름 — `BOARD_REQUEST_LABEL` */
        label: string;
        /** 감독이 부른 값 — 단위(금액·주급·좌석)는 종류가 안다 */
        amount: string;
        /** 영입 승인만 — 보드에 물은 선수. 나머지 셋은 총액이라 null이다 */
        playerName: string | null;
        status: "pending" | "conditional";
        askedOn: string;
        /** 답이 오는 날 */
        respondOn: string;
        /** 조건부 승인만 — 보드가 되건 조건 */
        condition: {
          /** 조건의 갈래 이름 */
          label: string;
          /** 요구하는 값 — 단위는 갈래가 안다 */
          amount: string;
          /** 이 날까지 못 채우면 거절이다 */
          until: string;
        } | null;
      } | null;
      /** 걸려 있는 영입 승인분 — 그 선수 영입에만 쓰이고 기한이 지나면 지워진다 */
      earmarked: Array<{ playerName: string; amount: number; until: string }>;
    };
    /**
     * **보드가 지금 이 구단에 지고 있는 기대** — 체급이 정한다 (`boardExpectation`).
     * 지난 시즌의 **평가**가 아니다: 그 둘을 한 칸에 겹쳐 두면 첫 시즌의 감독이
     * 아무도 매기지 않은 평가를 읽는다.
     */
    boardExpectation: {
      target: number;
      label: string;
      /**
       * 지금 서 있는 **다년 계획** — 구단주 원형이 건 것이다 (career.md §5).
       * 시즌의 기대가 감독의 자리를 재는 자라면 이쪽은 구단이 몇 년에 걸쳐 가려는
       * 자리라, 한 칸에 나란히 선다. 무직이면 걸린 계획이 없다 — `null`.
       */
      vision: { year: number; span: number; items: VisionItemView[] } | null;
    };
    stadium: { name: string; capacity: number };
    /**
     * **감독이 매긴 티켓 값과 기준가** (finance.md §5.2) — 기준가와 나란히 서야
     * 지금 값이 비싼지 싼지 읽힌다. 기준가는 리그 평균가에 리그 폭이 걸린 값이다.
     */
    ticket: { price: number; base: number };
    /** 급여 비중 — **시즌 누계** (급여 ÷ 매출). 한 달만 보면 프리시즌에 튄다 */
    wageRatio: number;
    /** 시즌 누계 비중이 선 구간 — 경계는 `finance.ts` */
    wageTone: WageRatioTone;
    psr: { rolling3Season: number; headroom: number } | null;
    /**
     * **영입 관문 넷의 첫째** — 주급 총액 위에 이번 창에 더 얹을 수 있는 돈이다.
     * 음수면 이미 천장을 넘었다.
     *
     * 넷(`wageRoom`·`debt`·`payments`·`expiringContracts`)은 전부 장부의 파생값이고
     * `get_finance`가 읽는 것과 **같은 함수**(`financeOutlook`)에서 나온다
     * (finance.md §8.3). 여력과 부채는 한 수로 접히고 회분·만료는 사람과 날짜가
     * 붙는다 — 화면에서 앞의 둘이 지표 줄, 뒤의 둘이 목록으로 서는 이유다.
     */
    wageRoom: number;
    /** 빚 — 없으면 null (PSR이 첫 시즌에 서지 않는 것과 같은 규약) */
    debt: DebtView | null;
    /** 미지급 분할 회분 — 나갈 것과 들어올 것 */
    payments: FinanceOutlook["payments"];
    /** 1년 안에 끝나는 우리 계약 — 전원, 만료일 순 */
    expiringContracts: ExpiringContractView[];
    /** 진행 중인 이번 달 잠정 집계 */
    current: FinanceMonthView;
    /** 마감된 월간 보고서 — 최신 순 */
    reports: FinanceMonthView[];
    /** 실시간 재정 활동 — 최근 원장을 접은 줄 (최신 순, docs/simulation/finance.md §8.1) */
    feed: FinanceFeedRow[];
  };
  /** 대회 — 우리 리그 + 우리 대항전. 대회별 순위표와 일정이 한 자리에 (overview §5) */
  competitions: {
    /**
     * **우리 팀의 당장 다음 경기** — 대회를 가리지 않는다. 경기 중 대회 탭이
     * 세우는 것이 이것이다(match.md §8): 90분 안에 묻는 것은 이 경기가 끝난 뒤
     * 언제 누구인가지 그 대회의 다음 라운드가 아니다.
     */
    nextMatch: NextMatchView | null;
    /**
     * 그 경기의 **상대 분석** — 위 `nextMatch`와 같은 경기다 (match.md §1.8).
     * 경기 중에는 `null`이다: 90분 안에 다음 상대를 분석하는 자리는 없고, 지금
     * 판은 판세 탭이 이미 들고 있다.
     */
    preview: MatchPreviewView | null;
    /** 최근 다섯 경기 — **사실만**. 문장은 화면이 잇는다 (competition.md §7) */
    recentResults: RecentResultView[];
    /** 탭 순서: 우리 리그 → 우리 대항전 */
    list: CompetitionView[];
  };
  career: {
    /**
     * **경질 카드** — 서 있으면 감독은 무직이다 (career.md §5.1). 코어는 사실만
     * 넘기고("어느 구단에서 몇 위, 기대는 무엇") 문장은 화면이 쓴다.
     * 옛 세이브는 카드 대신 평가 문장(`reason`)을 들고 있어 그것이 폴백이다.
     */
    dismissal: {
      on: string;
      season: number;
      /** 경질·만료·사임·이적 — 무직은 상태지 사유가 아니다 (career.md §5.4) */
      kind: "sacked" | "expired" | "resigned" | "moved";
      /**
       * 위약금 — 경질이면 구단이 문 돈, 사임이면 감독이 문 돈, 이적이면 새 구단이
       * 옛 구단에 문 보상금이다 (career.md §5.4 · §5.1)
       */
      severance: number | null;
      teamName: string;
      tier: number | null;
      position: number | null;
      target: number | null;
      expectation: string | null;
      reason: string | null;
    } | null;
    /**
     * **경질 이력** — 부임이 카드를 옮겨 남긴 지난 경질들 (career.md §6).
     * 잘린 시즌은 `SEASON_RECORD`가 없으므로 시즌 표가 이 줄로 그 해를 채운다.
     */
    dismissals: Array<{
      on: string;
      season: number;
      /** 경질·만료·사임·이적 — 옛 이력엔 없어 경질로 읽는다 (career.md §5.4) */
      kind: "sacked" | "expired" | "resigned" | "moved";
      teamName: string;
      position: number | null;
      target: number | null;
      expectation: string | null;
    }>;
    /**
     * **지금 답할 수 있는 감독직 제안** — 만료가 가까운 것이 앞이다.
     * 수락은 채팅으로 한다(`accept_manager_offer`) — 화면은 무엇이 걸려 있는지만 세운다.
     */
    offers: Array<{
      id: string;
      /**
       * 어떻게 선 제안인가 — `vacancy`만 무직에게 붙는다. 재계약(`renewal`)과 이직
       * 제안(`poach` · 재직 중의 `knock`)은 재직 중에 선다 (career.md §5.1 · §5.4)
       */
      via: "vacancy" | "knock" | "renewal" | "poach";
      teamName: string;
      tier: number;
      expiresOn: string;
      position: number | null;
      target: number;
      expectation: string;
      /** 제시 조건 — 옛 세이브의 제안엔 없다 (career.md §5.1) */
      salary: number | null;
      years: number | null;
      budgetPledge: number | null;
      /** 서 있으면 흥정은 끝났다 — 한 차례뿐이다 */
      counteredOn: string | null;
      /**
       * 새 구단이 지금 구단에 물 **이적 보상금** — 재직 중에 온 제안에만 있다
       * (career.md §5.1)
       */
      compensation: number | null;
    }>;
    /**
     * **공석 명부** — 감독이 먼저 지원할 수 있는 자리 (career.md §5.1). 재직 중에도
     * 쌓인다 — 계약을 남기고 떠나는 길이 열려 있다.
     * 지원은 채팅으로 한다(`apply_manager_job`) — 화면은 어느 문이 열려 있는지만 세운다.
     */
    vacancies: Array<{ teamName: string; tier: number; on: string; position: number | null }>;
    /**
     * 감독 계약 — 옛 세이브엔 없다 (career.md §5.1 · §5.4). `renewal`은 보드가 만료
     * 90일 전에 내린 판정이다: 재계약 제안이 섰거나(`offered`), 비갱신 통보(`declined`).
     */
    contract: {
      salary: number;
      until: string;
      daysLeft: number;
      renewal: "offered" | "declined" | null;
    } | null;
    /** 감독의 **개인 지갑** — 연봉과 위약금이 쌓인 돈, 구단 잔고와 다르다 (career.md §5.4) */
    wallet: number;
    /**
     * 감독이 쓴 돈 — 최근 것이 먼저다 (career.md §5.4). 구단 원장이 아니라 **감독의
     * 이력**이라 커리어 뷰가 지갑 옆에서 읽는다. 갈래의 이름은 코어가 준다
     * (`MANAGER_SPEND_KIND_KO`) — 화면이 코드를 문장으로 옮기지 않는다.
     */
    spending: Array<{ on: string; kind: string; amount: number; playerName: string | null }>;
    trophies: Array<{ competition: string; season: number; teamName: string }>;
    /**
     * 업적 — **코드와 근거 수치**다. 세이브가 문장을 갖지 않으므로(career.md §6)
     * 이름과 근거 문장은 화면이 코드로 쓴다(`achievementTitle`). 여기서 하는 일은
     * id를 표시명으로 푸는 것까지다 — 화면은 리그·대회 카탈로그를 읽지 못한다.
     */
    achievements: Array<{
      code: string;
      season: number;
      position?: number;
      leagueName?: string;
      competitionName?: string;
      playerName?: string;
      goals?: number;
      matches?: number;
    }>;
    /**
     * 시상 — 업적과 같은 규약이다: **코드와 근거 수치**만 내려가고 상의 이름은
     * 화면이 코드로 만든다(`awardTitle` — career.md §6). 세계 전체에 쌓이는 상
     * 중에서 **감독이 그 시즌 맡고 있던 팀의 것**만 선다 — 남의 리그 득점왕은
     * 감독의 이력이 아니다. 대회는 리그만이 아니다: 컵·대항전의 득점왕과 결승
     * MOM도 같은 자로 걸린다. id를 표시명으로 푸는 것까지가 여기 몫이다.
     */
    awards: Array<{
      code: string;
      season: number;
      playerName: string;
      teamName: string;
      /** 어느 대회의 상인가 — 리그도 컵·대항전도 온다 (season.md §6) */
      competitionName: string;
      apps: number;
      goals: number;
      assists: number;
      /** 출전이 없으면 없다 (`seasonRating`) */
      rating?: number;
      /** `young-player`가 센 나이 — 시즌 종료일 기준 */
      age?: number;
    }>;
    seasons: Array<{
      season: number;
      teamName: string;
      position: number;
      /** 그 시즌의 전적 — `"20승 8무 10패"`는 화면이 잇는다 (career.md §6) */
      record: { wins: number; draws: number; losses: number };
      /**
       * 그 시즌에 대한 **보드 평가 카드** — 등급과 근거 수치 (career.md §6).
       * 순위와 전적이 말하지 않는 것이 여기 있다: 같은 4위가 어느 구단에서는
       * 성공이고 어느 구단에서는 실패인 이유가 `target`에 남는다. 문장은 화면이 쓴다.
       */
      board: {
        grade: "met" | "missed";
        target: number;
        expectation: string;
        /**
         * 그 시즌 **클럽 비전의 항목별 진행도** (career.md §5) — 순위 한 칸이
         * 말하지 못하는 것이 여기 있다. 비전이 서기 전의 시즌은 빈 배열이다.
         */
        items: VisionItemView[];
      } | null;
      /** 옛 세이브가 들고 있는 평가 문장 — `board`가 없을 때만 선다 */
      boardVerdict: string | null;
    }>;
  };
}

const ROLE_KO: Record<AssignmentRole, "선발" | "벤치"> = { starting: "선발", bench: "벤치" };

function isUserMatch(state: GameState, matchId: string): boolean {
  const m = state.matches.find((x) => x.id === matchId);
  if (!m) return false;
  return m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId;
}

/**
 * 녹아웃 브래킷 — 유럽 대항전과 국내 컵이 같은 모양을 쓴다.
 *
 * 읽기 전용이다. 승부차기는 이미 장부에 기록된 것만 읽는다 (여기서 판정하면
 * 뷰를 여는 것이 게임 상태를 바꾸는 셈이 된다 — 판정은 tick·경기 종료가 한다).
 */
function buildBracket(state: GameState, competitionId: string): BracketStageView[] {
  const domestic = domesticCupById(competitionId);
  const euroCup = cupCatalogById(competitionId);
  const stages = domestic ? DOMESTIC_STAGES : euroCup ? knockoutStages(euroCup) : [];
  const bracket: BracketStageView[] = [];

  for (const stage of stages) {
    const matches = state.matches
      .filter(
        (m) => m.season === state.season && m.competitionId === competitionId && m.stage === stage,
      )
      .sort((a, b) => a.id.localeCompare(b.id) || a.round - b.round);
    if (matches.length === 0) continue;
    const byPair = new Map<string, typeof matches>();
    for (const m of matches) {
      const pair = pairOfMatchId(m.id);
      const legs = byPair.get(pair);
      if (legs) legs.push(m);
      else byPair.set(pair, [m]);
    }
    const ties = [...byPair.values()].map((legs) => {
      const decider = legs[legs.length - 1]!;
      const home = decider.homeTeamId;
      const away = decider.awayTeamId;
      const ours = home === state.userTeamId || away === state.userTeamId;
      const played = legs.filter((m) => m.result);
      let score: string | null = null;
      let won: boolean | null = null;
      if (played.length === legs.length) {
        const agg = new Map<string, number>();
        for (const leg of played) {
          agg.set(leg.homeTeamId, (agg.get(leg.homeTeamId) ?? 0) + leg.result!.homeGoals);
          agg.set(leg.awayTeamId, (agg.get(leg.awayTeamId) ?? 0) + leg.result!.awayGoals);
        }
        const h = agg.get(home) ?? 0;
        const a = agg.get(away) ?? 0;
        const pens = decider.result?.penalties;
        score = pens ? `${h}-${a} (승부차기 ${pens.home}-${pens.away})` : `${h}-${a}`;
        const winner = pens
          ? pens.home > pens.away
            ? home
            : away
          : h === a
            ? null
            : h > a
              ? home
              : away;
        if (ours && winner) won = winner === state.userTeamId;
      } else if (played.length > 0) {
        // 1차전만 끝난 대진 — 진행 중임을 스코어로 보인다
        const leg = played[0]!;
        score = `1차전 ${leg.result!.homeGoals}-${leg.result!.awayGoals}`;
      }
      return {
        date: decider.date,
        home: teamNameIn(state, home),
        away: teamNameIn(state, away),
        score,
        ours,
        won,
      };
    });
    bracket.push({ stage, label: competitionStageLabel(competitionId, stage), ties });
  }
  return bracket;
}

/** 대항전 뷰 — 우리 팀이 나가는 대회의 리그 페이즈 통과 경계선 */
function buildEuropeView(state: GameState, cupId: string): EuropeView | null {
  const cup = cupCatalogById(cupId);
  if (!cup) return null;
  const standings = computeStandings(state, cupId);
  return {
    competitionId: cupId,
    competition: competitionName(cupId),
    short: competitionShortName(cupId),
    standings,
    ourPosition: standings.findIndex((r) => r.teamId === state.userTeamId) + 1,
    directSlots: cup.directSlots,
    playoffCutoff: cup.directSlots + cup.playoffSlots,
  };
}

/**
 * 순위표에 긋는 구역 — "이 순위가 무슨 뜻인가".
 *
 * 감독이 순위표를 볼 때 알고 싶은 건 등수가 아니라 **경계**다. 4위와 5위의 차이는
 * 한 계단이 아니라 챔피언스리그와 유로파리그의 차이다. 그래서 구역은 UI가 고르는
 * 장식이 아니라 **대회 카탈로그에서 파생되는 사실**이다 — 리그별 티켓 수가 바뀌면
 * 표의 선도 따라 움직인다.
 *
 * ⚠️ **구역은 1위부터 빈틈없이 이어져야 한다** — 화면이 "이 순위 이하"로 구역을
 * 찾기 때문이다(`zoneAt`). 그래서 강등선 위의 중위권도 `잔류`로 이름을 갖는다.
 * 구멍을 두면 7위가 강등 구역으로 읽힌다.
 *
 * 리그의 마지막 자리는 **국내 컵 우승팀이 순위 밖일 때 바뀔 수 있다**(europe.ts의
 * 연쇄 배정) — 경계선은 규정이고, 자리의 주인은 시즌이 끝나고 정해진다.
 */
function buildStandingZones(
  state: GameState,
  competitionId: string,
  /** 그 대회의 팀 수 — 강등선은 아래에서 세므로 필요하다 */
  size: number,
): StandingZone[] {
  // 대항전 리그 페이즈 — 통과 기준이 곧 구역이다
  if (isEuroCup(competitionId)) {
    const cup = cupCatalogById(competitionId);
    if (!cup) return [];
    const zones: StandingZone[] = [
      { through: cup.directSlots, label: "본선 직행", kind: "direct" },
    ];
    if (cup.playoffSlots > 0) {
      zones.push({
        through: cup.directSlots + cup.playoffSlots,
        label: "플레이오프",
        kind: "playoff",
      });
    }
    return zones;
  }
  if (isCup(competitionId)) return []; // 국내 컵은 순위표가 없다
  // 2부 — 티켓도 강등도 없고 위로 가는 문만 있다 (`promotion.ts`)
  if (isCupOnlyLeague(competitionId)) {
    return size > RELEGATION_SLOTS
      ? [{ through: RELEGATION_SLOTS, label: "승격", kind: "promotion" }]
      : [];
  }
  // 리그 — 유럽 진출 티켓을 상위부터 채운다 (europe.ts의 배정 순서와 같은 규칙)
  const zones: StandingZone[] = [];
  let cursor = 0;
  for (const cup of cupCatalog()) {
    const count = cup.slots[competitionId] ?? 0;
    if (count === 0) continue;
    cursor += count;
    zones.push({ through: cursor, label: competitionName(cup.id), kind: cup.id });
  }
  // 강등 — 아래 리그가 이 세계에 실제로 있을 때만 선을 긋는다 (축소 세계엔 없다)
  const cut = size - RELEGATION_SLOTS;
  if (hasRelegation(state, competitionId) && cut > cursor) {
    zones.push({ through: cut, label: "잔류", kind: "safe" });
    zones.push({ through: size, label: "강등", kind: "relegation" });
  }
  return zones;
}

/** 경기 결과 표기 — 승부차기까지 (미진행이면 null) */
function scoreOf(match: MatchRecord): string | null {
  if (!match.result) return null;
  const { homeGoals, awayGoals, penalties } = match.result;
  const pens = penalties ? ` (승부차기 ${penalties.home}-${penalties.away})` : "";
  return `${homeGoals}-${awayGoals}${pens}`;
}

/**
 * 이 팀의 승패와 그 한글 표기는 **도메인의 것**이다 — 경기 기록 하나만 보면 답이
 * 나오는 규칙이라 화면·조회·코치의 눈이 같은 판정을 쓴다 (AGENTS.md §5 「한 규칙,
 * 한 정의」). 여기서 다시 내보내므로 코어 쪽 호출자는 자리를 옮기지 않는다.
 */
export { outcomeFor, outcomeLabel };
/**
 * 최근 경기 평점 — 폼의 시간 축.
 *
 * 폼 숫자 하나로는 "지금 오르는 중인지 식는 중인지"를 알 수 없다. 평점은 이미
 * 경기별로 남아 있으므로(`MATCH.result.ratings`, 유저 팀 경기만) 날짜순으로
 * 훑어 마지막 다섯 개를 준다 — 화면이 추이를 그릴 수 있다.
 */
function recentRatingsOf(state: GameState, playerId: string, limit = 5): RecentRatingView[] {
  const rated = state.matches
    .filter((m) => m.result?.ratings?.[playerId] !== undefined)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rated.slice(-limit).map((m) => {
    const value = m.result!.ratings![playerId]!;
    return { value, tone: ratingTone(value) };
  });
}

/**
 * 줄 이름 — **홈이 왼쪽인 판**에서 그 줄이 누구의 진영인가.
 *
 * 격자의 자리는 홈 기준이라(스코어보드와 좌우가 같아야 한다) 홈 수비 줄이 곧
 * 왼쪽이다. 우리가 원정이면 그 왼쪽이 상대의 진영이 된다.
 */
function zoneLabel(zone: "attack" | "midfield" | "defense", weAreHome: boolean): string {
  if (zone === "midfield") return "중원";
  return (zone === "defense") === weAreHome ? "우리 진영" : "상대 진영";
}

const MATCH_PHASE_KO: Record<string, string> = {
  first_half: "전반",
  second_half: "후반",
  extra_first: "연장 전반",
  extra_second: "연장 후반",
  finished: "종료",
};

/**
 * 화면에 서는 체력 — **판세 탭과 팀 탭이 이 함수 하나를 지난다.**
 *
 * 경기 중이면 저장값에서 이 경기가 가져간 만큼을 뺀 지금 값에 안개를 씌운다
 * (`readCondition` · player.md §9.2) — 뛰는 동안 남은 다리는 아무도 못 재기
 * 때문이다. 두 탭이 같은 인자로 이 문을 지나므로 같은 선수가 두 숫자로 보이지
 * 않고, 팀 탭이 참값을 쓰던 시절처럼 **두 탭을 견줘 안개를 걷을 수도 없다.**
 *
 * `live`가 없으면(경기 밖 · 출전 명단 밖) 아침에 잰 값 그대로라 폭이 0이다 —
 * 그때는 읽은 값이 아니라 잰 값이다.
 */
function conditionShown(
  state: GameState,
  playerId: string,
  saved: number,
  live: { drain: number; matchId: string } | null,
): ConditionRead {
  if (!live) {
    const value = clampCondition(saved);
    return { value, low: value, high: value, margin: 0, label: conditionLabel(value) };
  }
  return readCondition(state, playerId, Math.max(0, saved - live.drain), live.drain, live.matchId);
}

/**
 * 경기 화면 — 코어가 이미 계산한 값을 화면이 읽을 모양으로 옮긴다.
 *
 * 채팅은 흘러가지만 판세는 남아 있어야 한다. 감독이 정지점에서 보고 싶은 건
 * "어디가 밀리나 · 무엇이 통하나 · 누구를 빼야 하나" 셋이다.
 */
function buildMatchView(state: GameState): MatchView | null {
  const pending = state.pendingMatch;
  if (!pending || state.phase !== "match") return null;
  const match = state.matches.find((m) => m.id === pending.matchId);
  /** 진행 중이던 옛 세이브의 패킷은 문장 배열을 들고 온다 — 여기서 한 번 태그로 옮긴다 */
  const packet = pending.packet ? normalizePacket(pending.packet) : null;
  if (!match || !packet) return null;
  const tagCtx = packetTagContext(packet);

  const ledger = pending.ledger;
  const worn = pending.matchFatigue ?? {};
  const shootout = pending.shootout;

  /**
   * 선수별 기록 — 사건 목록을 한 번 훑어 접는다. 저장하지 않는 이유는 원본이
   * `ledger.events`이기 때문이다: 두 벌로 두면 조용히 갈린다.
   */
  const tallies = new Map<string, MatchTally>();
  /** 아무것도 하지 않은 선수의 한 줄 — 빈 값을 세우는 자리가 하나여야 칸이 늘 때 갈리지 않는다 */
  const emptyTally = (): MatchTally => ({
    goals: 0,
    assists: 0,
    shots: 0,
    saves: 0,
    yellows: 0,
    red: false,
    passes: 0,
    progressive: 0,
    xg: 0,
    scoringExpectation: 0,
    corners: 0,
    fouls: 0,
  });
  const tallyOf = (id: string): MatchTally => {
    const found = tallies.get(id);
    if (found) return found;
    const fresh = emptyTally();
    tallies.set(id, fresh);
    return fresh;
  };
  /**
   * 슛·선방·패스·xg는 **누적 기록**이 원본이다 (`ledger.stats`) — 사건에서 다시
   * 세면 두 벌이 되어 갈린다. 사건에서 오는 건 골·도움·카드뿐이다.
   */
  for (const [id, line] of Object.entries(ledger.stats ?? {})) {
    const t = tallyOf(id);
    t.shots = line.shots;
    t.saves = line.saves;
    t.passes = line.passes;
    t.progressive = line.progressive;
    t.xg = line.xg;
    t.scoringExpectation = line.scoringExpectation ?? 0;
    // 옛 세이브의 줄에는 없는 칸이다 (SAVE_VERSION 유지)
    t.corners = line.corners ?? 0;
    t.fouls = line.fouls ?? 0;
  }
  for (const event of ledger.events) {
    const [first, second] = event.actors;
    switch (event.type) {
      case "goal":
        if (first) tallyOf(first).goals += 1;
        if (second) tallyOf(second).assists += 1;
        break;
      case "shot":
      case "save":
        break; // 슛·선방 수는 누적 기록이 갖는다 (아래에서 합친다)
      case "yellow_card":
        if (first) tallyOf(first).yellows += 1;
        break;
      case "red_card":
        if (first) tallyOf(first).red = true;
        break;
      default:
        break;
    }
  }
  const player = (
    entry: {
      id: string;
      name: string;
      position: string;
      point?: import("@story-fm/domain").BoardPoint;
      effective: number;
    },
    teamId: string,
  ): MatchPlayerView => {
    const p = playerById(state, entry.id);
    // 경기 중 소모(worn)를 저장된 체력에서 뺀 지금 값 — 화면과 시뮬이 같은 축을 본다.
    // 다리는 눈으로 읽는다 — 코어는 참값으로 계산하고 여기서만 흐려진다
    const condition = conditionShown(state, entry.id, p?.state.condition ?? 0, {
      drain: worn[entry.id] ?? 0,
      matchId: match.id,
    });
    /**
     * 전력도 안개를 지난다 — **명단 화면과 같은 채널**(`observationOf`)이라
     * 같은 상대 선수가 두 화면에서 다른 숫자로 보이지 않는다. 우리 선수는
     * 오프셋 0이라 참값 그대로다.
     */
    const observation = observationOf(state, entry.id);
    return {
      id: entry.id,
      name: entry.name,
      squadNumber: p?.squadNumber ?? null,
      age: p ? ageOf(p.birthdate, state.date) : 0,
      seasonRating: seasonRating(seasonStatOf(state, entry.id)),
      position: entry.position,
      ...(entry.point ? { point: entry.point } : {}),
      effective: Math.max(1, Math.round(entry.effective) + observation.overallOffset),
      margin: observation.margin,
      condition,
      // 읽은 값으로 판정해도 참값과 갈리지 않는다 — 구간이 문턱을 넘지 않는다
      gassed: condition.value <= GAP_CONDITION,
      ours: teamId === state.userTeamId,
      tally: tallies.get(entry.id) ?? emptyTally(),
    };
  };
  const rowsOf = (
    entries: ReadonlyArray<{
      id: string;
      name: string;
      position: string;
      point?: import("@story-fm/domain").BoardPoint;
      effective: number;
    }>,
    ids: readonly string[],
    teamId: string,
  ) => entries.filter((e) => ids.includes(e.id)).map((e) => player(e, teamId));

  const onPitch = {
    home: rowsOf(packet.home.lineup, ledger.home.onPitch, match.homeTeamId),
    away: rowsOf(packet.away.lineup, ledger.away.onPitch, match.awayTeamId),
  };

  const subLimits = subLimitsOf(ledger.phase);

  /**
   * **판을 옮긴 정지점의 표식** — 장부의 마지막 `tactical_shift`에서 파생한다
   * (match.md §4·§8). 화면이 따로 기억하는 상태가 아니라 사건이 원본이므로, 표식과
   * 중계가 같은 한 줄에서 나온다. 표식이 없으면 감독은 정지점마다 여섯 축의 점
   * 눈금을 외워 견줘야 상대의 승부수를 안다.
   */
  const shiftOfSide = (side: MatchSide) => {
    const found = [...ledger.events]
      .reverse()
      .find((e) => e.type === "tactical_shift" && e.team === side);
    const tag = found ? normalizeCauses(found.causes)[0] : undefined;
    return found && tag ? { minute: found.minute, note: packetTagText(tag, tagCtx) } : null;
  };

  const tacticsOfSide = (teamId: string, tactical: TacticalRead) => ({
    ...(teamId !== state.userTeamId && pending.aiTactics
      ? pending.aiTactics
      : tacticsOf(state, teamId).spec),
    uptake: tactical.uptake,
    notes: tactical.notes.map((tag) => packetTagText(tag, tagCtx)),
    shift: shiftOfSide(teamId === match.homeTeamId ? "home" : "away"),
  });

  return {
    matchId: match.id,
    competition: competitionShortName(match.competitionId),
    stage: competitionStageLabel(match.competitionId, match.stage ?? "league", match.round),
    home: {
      name: teamNameIn(state, match.homeTeamId),
      short: teamShortNameIn(state, match.homeTeamId),
      ours: match.homeTeamId === state.userTeamId,
    },
    away: {
      name: teamNameIn(state, match.awayTeamId),
      short: teamShortNameIn(state, match.awayTeamId),
      ours: match.awayTeamId === state.userTeamId,
    },
    score: { ...ledger.score },
    minute: ledger.minute,
    // 승부차기는 장부가 `finished`인 채로 진행된다 — "종료"로 적으면 화면이 끝난
    // 경기를 말하고, 감독은 아직 키커를 세우는 중이다 (match.md §2)
    phase: shootout ? "승부차기" : (MATCH_PHASE_KO[ledger.phase] ?? ledger.phase),
    beforeKickoff: pending.entered !== true,
    /**
     * 매치업은 **맞붙는 두 값**을 견준다 — 공격 존은 우리 공격 대 상대 **수비**다.
     * 같은 존끼리 비교하면(공격 vs 공격) 아무 뜻이 없다.
     *
     * 우열은 코어가 이미 매긴 것(`Matchup.edge`)을 우리 편으로 접기만 한다 —
     * GM이 읽는 매치업 문장과 화면의 줄 머리가 같은 판정에서 나와야 한다.
     */
    zones: packet.matchups.map((m) => {
      const weAreHome = match.homeTeamId === state.userTeamId;
      const homeValue =
        m.zone === "attack"
          ? packet.home.zones.attack
          : m.zone === "midfield"
            ? packet.home.zones.midfield
            : packet.home.zones.defense;
      const awayValue =
        m.zone === "attack"
          ? packet.away.zones.defense
          : m.zone === "midfield"
            ? packet.away.zones.midfield
            : packet.away.zones.attack;
      return {
        zone: m.zone,
        label: zoneLabel(m.zone, weAreHome),
        ours: weAreHome ? homeValue : awayValue,
        theirs: weAreHome ? awayValue : homeValue,
        edge:
          m.edge === "even"
            ? ("even" as const)
            : (m.edge === "home") === weAreHome
              ? ("ours" as const)
              : ("theirs" as const),
        size: m.size,
      };
    }),
    goals: ledger.events
      .filter((e) => e.type === "goal")
      .map((e) => {
        const side = e.team === "away" ? ("away" as const) : ("home" as const);
        const teamId = side === "home" ? match.homeTeamId : match.awayTeamId;
        const nameOf = (id: string | undefined) =>
          id ? (playerById(state, id)?.name ?? id) : null;
        return {
          minute: e.minute,
          side,
          scorer: nameOf(e.actors[0]) ?? "미상",
          assist: nameOf(e.actors[1]),
          ours: teamId === state.userTeamId,
        };
      }),
    expectedGoals: { ...packet.guide.expectedGoals },
    /**
     * 자리는 홈 기준 그대로 두고 **값만 우리 편으로 접는다.**
     *
     * 좌우까지 우리 기준으로 돌리면 같은 화면 안에서 스코어보드(홈-원정)와
     * 경기장(우리-상대)의 방향이 어긋난다 — 0:1이 어느 쪽 골인지 다시 따져야 한다.
     */
    grid: zoneGrid(packet).map((c) => {
      const weAreHome = match.homeTeamId === state.userTeamId;
      const ours = weAreHome ? c.home : c.away;
      const theirs = weAreHome ? c.away : c.home;
      return { band: c.band, lane: c.lane, ours, theirs, ...edgeFor(ours, theirs) };
    }),
    /**
     * 유불리는 **우리 편 기준**으로 접어서 넘긴다 — 화면이 홈/원정 중 어느 쪽이
     * 우리인지 다시 따지지 않아도 되게. 편을 모르는 옛 세이브는 `null`이다.
     */
    keyPoints: packet.keyPoints.map((tag) => {
      const ourSide = match.homeTeamId === state.userTeamId ? "home" : "away";
      return {
        text: packetTagText(tag, tagCtx),
        ours: tag.favours === null ? null : tag.favours === ourSide,
      };
    }),
    exploiting: (pending.exploits ?? [])
      .map((id) => packet.targets.find((t) => t.id === id))
      .filter((t): t is NonNullable<typeof t> => t !== undefined)
      .map((t) => packetTagText(t.tag, tagCtx)),
    tactics: {
      home: tacticsOfSide(match.homeTeamId, packet.home.tactical),
      away: tacticsOfSide(match.awayTeamId, packet.away.tactical),
    },
    onPitch: onPitch,
    xiRating: { home: xiRatingOf(onPitch.home), away: xiRatingOf(onPitch.away) },
    totals: { home: tallyTotal(onPitch.home), away: tallyTotal(onPitch.away) },
    bench: {
      home: rowsOf(packet.home.bench, ledger.home.bench, match.homeTeamId),
      away: rowsOf(packet.away.bench, ledger.away.bench, match.awayTeamId),
    },
    subs: {
      home: { used: ledger.home.subsUsed, windows: ledger.home.subWindows },
      away: { used: ledger.away.subsUsed, windows: ledger.away.subWindows },
      limit: { subs: subLimits.maxSubs, windows: subLimits.maxSubWindows },
    },
    sentOff: ledger.sentOff.map((id) => playerName(state, id)),
    shootout: shootout
      ? {
          tally: shootoutTally(shootout.kicks),
          kicks: shootout.kicks.map((kick) => {
            const teamId = kick.team === "home" ? match.homeTeamId : match.awayTeamId;
            return {
              round: kick.round,
              side: kick.team,
              team: teamShortNameIn(state, teamId),
              taker: playerName(state, kick.taker),
              keeper: kick.keeper ? playerName(state, kick.keeper) : null,
              outcome: kick.outcome,
              ours: teamId === state.userTeamId,
            };
          }),
        }
      : null,
  };
}

/**
 * 경기 하나를 "다음 경기" 조각으로 — 팀 단위와 대회 단위가 같은 함수를 쓴다.
 * 갈리는 것은 **무엇을 골랐는가**와 표기(`label`)뿐이라, 같은 경기를 두 자리에서
 * 다르게 적을 길이 없다.
 */
/**
 * 경기 전 상대 분석 한 장 — 코어의 리포트를 화면 조각으로 옮긴다 (match.md §1.8).
 * 태그를 문장으로 바꾸는 자리는 여기 하나다(`packetTagText`) — 판세 화면의
 * 키포인트와 같은 렌더러이므로 같은 지점이 두 화면에서 두 문장이 되지 않는다.
 */
function matchPreviewView(state: GameState, matchId: string): MatchPreviewView | null {
  const report = buildOpponentReport(state, { matchId });
  if (!report) return null;
  return {
    matchId: report.matchId,
    expectedXI: report.expectedXI.map((p) => ({ ...p })),
    basis: report.basis ? { date: report.basis.date, label: report.basis.label } : null,
    /**
     * 근거가 없으면 **열한 명이 다 추정이라** 세는 뜻이 없다 — 그때 0이다.
     * 표시는 관측과 추정이 섞였을 때만 값을 하고, 화면은 이 수로 그것을 가른다.
     */
    guessed: report.basis === null ? 0 : report.expectedXI.filter((p) => !p.carried).length,
    absent: report.absent.map((a) => ({
      name: a.name,
      position: a.position,
      reason: a.reason,
      note: a.note,
    })),
    shape: { ...report.shape },
    keyPoints: report.notes.map((tag) => ({
      text: packetTagText(tag, report.tagContext),
      ours: tag.favours === null ? null : tag.favours === report.ourSide,
    })),
  };
}

function nextMatchView(state: GameState, m: MatchRecord, label: string): NextMatchView {
  const userTeamId = state.userTeamId;
  return {
    matchId: m.id,
    date: m.date,
    time: m.time ?? DEFAULT_KICKOFF,
    label,
    opponent: teamNameIn(state, m.homeTeamId === userTeamId ? m.awayTeamId : m.homeTeamId),
    venue: m.neutral ? "neutral" : m.homeTeamId === userTeamId ? "home" : "away",
    inDays: Math.max(0, diffDays(state.date, m.date)),
  };
}

/**
 * 대회 하나의 뷰 — 순위표 + 라운드별 일정.
 *
 * 라운드 묶음은 `(stage, round)`로 만든다. 리그는 stage가 없어 `R3`이 곧 라운드고,
 * 대항전은 리그 페이즈(R1~8) 뒤에 2차전제 녹아웃 단계가 붙는다. `current`는 오늘
 * 이후 첫 라운드(전부 끝났으면 마지막)로, UI가 여기서부터 보여준다.
 */
/**
 * 역대 절 — **원장을 접는 자리는 `competition/records.ts` 하나다.**
 *
 * 여기서 하는 일은 그 파생값에 이름을 붙여 화면으로 내리는 것뿐이다: 화면이
 * 카탈로그를 뒤지면 엔진을 값으로 import하게 되고, 그 순간 `next build`가 죽는다
 * (AGENTS.md §5). 문장은 만들지 않는다 — `"3년 만의 우승"`은 화면이 잇는다.
 */
function competitionHonoursOf(
  state: GameState,
  competitionId: string,
): CompetitionHonoursView | null {
  const title = clubRecordsOf(state, state.userTeamId).titles.find(
    (t) => t.competitionId === competitionId,
  );
  // 시드도 게임 안의 우승도 없다 — 0회가 아니라 **모른다** (team.md §1)
  if (!title) return null;
  return {
    count: title.count,
    seeded: title.seeded,
    won: title.seasons.map((season) => ({ season, label: seasonLabelOf(season) })),
    lastYear: title.lastYear ?? null,
  };
}

/** 지난 시즌 표·트로피에 서는 팀 한 칸 — 이름은 그때가 아니라 지금 것이다 */
function seasonTeamView(state: GameState, teamId: string): SeasonTeamView {
  return {
    teamId,
    name: teamNameIn(state, teamId),
    short: teamShortNameIn(state, teamId),
    ours: teamId === state.userTeamId,
  };
}

/**
 * 지나간 시즌들 — 결산 스냅샷(`state.history`)에서 이 대회의 몫만 접는다.
 *
 * ⚠️ **이 대회에 대해 아는 것이 하나도 없는 해는 줄을 세우지 않는다.** 다른 리그에
 * 있었거나 그해 이 컵이 열리지 않았으면 표도 우승자도 없고, 빈 줄은 "우승 없음"이라는
 * 없는 사실이 된다.
 */
function competitionSeasonsOf(state: GameState, competitionId: string): CompetitionSeasonView[] {
  const awards = state.awards ?? [];
  const seasons: CompetitionSeasonView[] = [];
  for (const history of pastSeasonsOf(state)) {
    const season = history.season;
    const rows = leagueTableOf(state, season, competitionId);
    const champion = championOf(state, season, competitionId);
    if (!rows && champion === null) continue;
    // 녹아웃은 트로피가 준우승까지 한 줄에 든다. 리그는 결승이 없어 2위가 그 자리다
    const runnerUp = rows
      ? (rows[1]?.teamId ?? null)
      : (state.trophies.find((t) => t.season === season && t.competitionId === competitionId)
          ?.runnerUpTeamId ?? null);
    const table = (rows ?? []).map((row, i): SeasonTableRowView => {
      const record = row.record;
      return {
        position: i + 1,
        teamId: row.teamId,
        name: teamNameIn(state, row.teamId),
        short: teamShortNameIn(state, row.teamId),
        ours: row.teamId === state.userTeamId,
        // 이관된 행은 순서만 안다 — 없는 수를 0으로 지어내지 않는다 (game-state.md §3.3)
        record: record ? { ...record, goalDiff: record.goalsFor - record.goalsAgainst } : null,
      };
    });
    const ourRow = table.findIndex((r) => r.ours);
    seasons.push({
      season,
      label: seasonLabelOf(season),
      champion: champion === null ? null : seasonTeamView(state, champion),
      runnerUp: runnerUp === null ? null : seasonTeamView(state, runnerUp),
      ourPosition: ourRow < 0 ? null : ourRow + 1,
      table,
      // 대회마다 상이 선다 — 컵 탭에는 그 컵의 득점왕과 결승 MOM이 걸린다 (season.md §6)
      awards: awards
        .filter((a) => a.season === season && a.competitionId === competitionId)
        .map((a) => ({
          code: a.code,
          playerName: a.playerName,
          teamName: teamNameIn(state, a.teamId),
          teamShort: teamShortNameIn(state, a.teamId),
          apps: a.apps,
          goals: a.goals,
          assists: a.assists,
          ...(a.rating === undefined ? {} : { rating: a.rating }),
          ...(a.age === undefined ? {} : { age: a.age }),
        })),
    });
  }
  return seasons;
}

function buildCompetitionView(state: GameState, competitionId: string): CompetitionView {
  const cup = isCup(competitionId);
  const matches = state.matches
    .filter((m) => m.competitionId === competitionId && m.season === state.season)
    .sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : (a.time ?? "").localeCompare(b.time ?? ""),
    );

  const order = new Map<string, number>();
  for (const stage of ["league", "playoff", "r32", "r16", "qf", "sf", "final"]) {
    order.set(stage, order.size);
  }
  // 라운드 표기는 한 번만 적는다 — 묶음 머리와 "다음 경기" 카드가 같은 문장을 쓴다
  const roundLabelOf = (m: MatchRecord): string => {
    const stage = m.stage ?? "league";
    return cup
      ? stage === "league"
        ? `리그 페이즈 ${m.round}R`
        : competitionStageLabel(competitionId, stage, m.round)
      : `${m.round}라운드`;
  };
  const grouped = new Map<string, CompetitionRoundView>();
  for (const m of matches) {
    const stage = m.stage ?? "league";
    const key = `${stage}:${m.round}`;
    const label = roundLabelOf(m);
    const round = grouped.get(key) ?? { key, label, date: m.date, matches: [], current: false };
    round.matches.push({
      id: m.id,
      date: m.date,
      time: m.time ?? DEFAULT_KICKOFF,
      homeName: teamNameIn(state, m.homeTeamId),
      awayName: teamNameIn(state, m.awayTeamId),
      homeShort: teamShortNameIn(state, m.homeTeamId),
      awayShort: teamShortNameIn(state, m.awayTeamId),
      score: scoreOf(m),
      ours: m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId,
      win: outcomeFor(m, state.userTeamId),
      neutral: m.neutral === true,
    });
    if (m.date < round.date) round.date = m.date;
    grouped.set(key, round);
  }

  const rounds = [...grouped.values()].sort((a, b) => {
    const [aStage, aRound] = a.key.split(":") as [string, string];
    const [bStage, bRound] = b.key.split(":") as [string, string];
    return (order.get(aStage) ?? 9) - (order.get(bStage) ?? 9) || Number(aRound) - Number(bRound);
  });
  // 오늘 이후 첫 라운드 = 지금 보고 싶은 라운드 (전부 끝났으면 마지막)
  const currentIndex = rounds.findIndex((r) => r.matches.some((m) => m.date >= state.date));
  const current = rounds[currentIndex >= 0 ? currentIndex : rounds.length - 1];
  if (current) current.current = true;

  const standings = computeStandings(state, competitionId);
  // 개인 순위는 리그의 것이다 — 대항전은 팀 열만 선다 (competition.md §2)
  const leaders: CompetitionLeadersView | null =
    standings.length === 0
      ? null
      : {
          players: cup ? [] : leaderboardsOf(state, competitionId),
          teams: teamStatsOf(state, competitionId),
        };
  /**
   * 이 대회의 다음 우리 경기 — **팀 단위와 같은 함수로 고른다.**
   *
   * 결과가 없는 첫 경기를 그냥 집으면 경기 중에는 그게 **지금 이 경기**다(결과는
   * 종료 시점에 쓰인다). 그러면 대회 머리줄이 "다음 · 오늘 · 지금 상대"가 된다.
   */
  const nextOurs = nextMatchFor(
    matches,
    state.userTeamId,
    state.date,
    state.pendingMatch?.matchId ?? null,
  );
  const bracket = cup ? buildBracket(state, competitionId) : [];
  const progress = cupProgressOf(bracket);
  // 시드는 진입 라운드 전까지 대진에 없어도 탈락이 아니다 — 아직 안 뽑힌 것으로 읽는다
  const cupProgress =
    progress.outcome === "out" &&
    domesticCupById(competitionId) !== null &&
    userStillIn(state, competitionId)
      ? { stage: null, outcome: "undrawn" as const }
      : progress;
  return {
    id: competitionId,
    name: competitionName(competitionId),
    short: competitionShortName(competitionId),
    kind: cup ? "cup" : "league",
    standings,
    homeTable: standingsBySplit(standings, "home"),
    awayTable: standingsBySplit(standings, "away"),
    leaders,
    zones: buildStandingZones(state, competitionId, standings.length),
    userPosition: standings.findIndex((r) => r.teamId === state.userTeamId) + 1,
    nextMatch: nextOurs ? nextMatchView(state, nextOurs, roundLabelOf(nextOurs)) : null,
    rounds,
    bracket,
    cupProgress,
    // 통과 경계선은 리그 페이즈가 있는 대항전에만 있다 (국내 컵은 순위표가 없다)
    europe: isEuroCup(competitionId) ? buildEuropeView(state, competitionId) : null,
    honours: competitionHonoursOf(state, competitionId),
    pastSeasons: competitionSeasonsOf(state, competitionId),
  };
}

/**
 * 보드 기대의 이름 — **코드가 원본이고 옛 세이브의 라벨은 폴백이다** (career.md §6).
 * 코드도 라벨도 없는 카드는 기대를 모르는 카드라 `null`이다.
 */
function expectationTextOf(card: {
  expectationCode?: BoardExpectationCode;
  expectation?: string;
  target?: number;
}): string | null {
  if (card.expectationCode) return boardExpectationText(card.expectationCode, card.target);
  return card.expectation ?? null;
}

/** 결산 카드의 머리줄 — 구간·세션 수와 건수 */
function trainingReportSummary(report: TrainingReport): string {
  const window = report.from === report.to ? report.to : `${report.from}~${report.to}`;
  const grew = new Set(report.moved.map((m) => m.gamePlayerId)).size;
  const tail = grew > 0 ? `${grew}명 성장` : "장부에 남은 변화 없음";
  return `훈련 결산 ${window} · ${report.sessions}회 — ${tail}`;
}

/**
 * 카드가 펼쳐지는 줄 — 한 선수당 하나. 움직인 눈금 · 갈래 · 근거 한 줄 순이다.
 *
 * 판정을 받은 선수 전원이 아니라 **무언가 남은 선수만** 선다 (카드가 이미 그렇게
 * 걸러져 있다 — `applyTrainingOutcomes`).
 */
function trainingReportLines(state: GameState, report: TrainingReport): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const id of [
    ...report.moved.map((m) => m.gamePlayerId),
    ...report.marks.map((m) => m.gamePlayerId),
  ]) {
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  return order.map((id) => {
    const parts = report.moved
      .filter((m) => m.gamePlayerId === id)
      .map((m) => `${growthLabel(m.target)} ${m.delta > 0 ? "+" : ""}${m.delta}`);
    const mark = report.marks.find((m) => m.gamePlayerId === id);
    if (mark?.code) parts.push(TRAINING_MARK_KO[mark.code]);
    const head = `${playerName(state, id)} ${parts.join(" · ")}`.trim();
    return mark && mark.note.length > 0 ? `${head} — ${mark.note}` : head;
  });
}

/**
 * 기록 테이블 몫의 달력 일지 — 성장·부상·카드·이적·돈, 그리고 서사 표의 **소식**.
 *
 * 일정 축(경기·훈련·이적창)은 부르는 쪽이 **먼저** 얹는다: 소식은 그 위에 겹치지
 * 않으므로(같은 날 같은 문장은 한 번만) 순서가 규약이다.
 *
 * 화면(`buildOfficeViews`)과 조회(`scheduleView`)가 같은 표를 읽는다 — 두 벌로 두면
 * 감독이 달력에서 본 줄과 GM이 답한 줄이 조용히 갈린다.
 */
export function pushRecordJournal(
  state: GameState,
  events: Record<string, CalendarEventView[]>,
): void {
  const push = (date: string, event: CalendarEventView) => {
    (events[date] ??= []).push(event);
  };
  // 일지는 **우리 스쿼드**의 일이다 — 임대 나가 있는 동안 남의 경기장에서 난 일은
  // 달력이 아니라 매월 리포트로 온다 (transfer.md §2)
  const ourPlayerIds = new Set(playersOf(state, state.userTeamId).map((p) => p.id));
  const userTeamId = state.userTeamId;
  // 카드는 경기 id만 갖는다 — 날짜는 그 경기가 안다
  const matchById = new Map(state.matches.map((m) => [m.id, m] as const));
  /**
   * 성장은 **날짜별로 묶는다** — 전술 훈련 한 번에 스무 줄이 나온다. 일지에 그대로
   * 펼치면 그날 있었던 다른 일(부상·경고·이적)이 스크롤 밖으로 밀린다.
   * 요약 한 줄만 세우고 명단은 접어 둔다.
   */
  const growthByDate = new Map<string, { counts: Map<string, number>; lines: string[] }>();
  for (const g of state.growthLog) {
    if (!ourPlayerIds.has(g.gamePlayerId)) continue;
    const label = growthLabel(g.target);
    const sign = g.delta > 0 ? "+" : "";
    const day = growthByDate.get(g.date) ?? {
      counts: new Map<string, number>(),
      lines: [] as string[],
    };
    day.counts.set(
      `${label} ${sign}${g.delta}`,
      (day.counts.get(`${label} ${sign}${g.delta}`) ?? 0) + 1,
    );
    day.lines.push(`${playerName(state, g.gamePlayerId)} ${label} ${sign}${g.delta}`);
    growthByDate.set(g.date, day);
  }
  for (const [date, day] of growthByDate) {
    const summary = [...day.counts]
      .sort((a, b) => b[1] - a[1])
      .map(([key, n]) => `${key} ${n}명`)
      .join(" · ");
    push(date, { kind: "growth", text: summary, details: day.lines });
  }
  /**
   * 훈련 결산 카드 — **카드를 문장으로 옮긴다** (season.md §4).
   *
   * 성장 줄(위)은 "그날 장부의 어느 눈금이 움직였나"를 날짜에 세우고, 이 줄은
   * "그 구간의 훈련이 무엇을 남겼나"를 **근거와 함께** 세운다. 성장 줄만으로는
   * 감독이 왜 늘었는지 읽을 자리가 없다 — 판정의 근거 한 줄은 카드에만 있다.
   */
  for (const report of state.trainingReports ?? []) {
    push(report.to, {
      kind: "training",
      text: trainingReportSummary(report),
      details: trainingReportLines(state, report),
    });
  }
  for (const inj of state.injuries) {
    if (!ourPlayerIds.has(inj.gamePlayerId)) continue;
    push(inj.occurredOn, {
      kind: "injury",
      text: `${playerName(state, inj.gamePlayerId)} ${inj.bodyPart} 부상 — 복귀 예상 ${inj.expectedReturn}`,
    });
    if (inj.returnedOn) {
      push(inj.returnedOn, {
        kind: "return",
        text: `${playerName(state, inj.gamePlayerId)} 부상 복귀`,
      });
    }
  }
  for (const b of state.bookings) {
    if (!ourPlayerIds.has(b.gamePlayerId)) continue;
    const m = matchById.get(b.matchId);
    if (m) {
      push(m.date, {
        kind: b.card === "yellow" ? "yellow" : "red",
        text: `${playerName(state, b.gamePlayerId)} ${b.minute}′`,
      });
    }
  }
  for (const t of state.transfers) {
    if (t.fromTeamId !== userTeamId && t.toTeamId !== userTeamId) continue;
    const name = playerName(state, t.gamePlayerId);
    const label =
      t.type === "retire"
        ? `${name} 은퇴`
        : t.type === "youth"
          ? `${name} 유스 승격`
          : t.toTeamId === userTeamId
            ? `${name} 영입`
            : `${name} 이적`;
    // 이적료는 이 줄이 말한다 — 돈 줄을 따로 세우면 한 거래가 세 줄이 된다 (§8.2).
    // 자유계약·유스·은퇴는 fee가 0이라 붙지 않는다.
    push(t.date, {
      kind: "transfer",
      text: t.fee > 0 ? `${label} · ${formatMoney(t.fee)}` : label,
    });
  }

  const finance = financeOf(state, userTeamId);

  /**
   * ⚠️ **정액 항목은 달력에 올리지 않는다.** 주급·중계권처럼 매달 같은 자리에 같은
   * 줄이 서면 그날 실제로 벌어진 일(부상·경고·이적)을 덮는다. 서는 것은 문턱을 넘는
   * **비정기** 항목뿐이고, 그 판정은 코어가 한다 — `isJournalMoney`.
   *
   * 파생 원본이 둘이다: 원장은 3개월 뒤 잘리므로 **진행 중인 달만** 원장에서 읽고,
   * 마감된 달은 보고서의 `highlights`(절단 전에 옮겨 적은 것)에서 읽는다. 마감은
   * 지난달까지만 하므로 두 원본은 겹치지 않는다 (docs/simulation/finance.md §8.2).
   */
  const moneyText = (m: { kind: "income" | "expense"; label: string; amount: number }) =>
    `${m.label} ${m.kind === "income" ? "+" : "−"}${formatMoney(m.amount)}`;
  const openMonth = monthOf(state.date);
  for (const e of finance.ledger) {
    if (e.date > state.date) continue;
    if (monthOf(e.date) !== openMonth) continue;
    if (!isJournalMoney(e, finance.balance)) continue;
    push(e.date, { kind: "money", text: moneyText(e) });
  }
  for (const r of userReports(state)) {
    // highlights는 마감 때 이미 걸러진 것이라 문턱을 다시 재지 않는다
    for (const h of r.highlights ?? []) {
      if (h.date > state.date) continue;
      push(h.date, { kind: "money", text: moneyText(h) });
    }
  }

  /**
   * 소식 — **서사 표가 원본이다** (people.md §9). 저장된 줄을 날짜에 세우는 것이라
   * 코어가 새 문장을 쓰지 않는다.
   *
   * `match` 갈래는 빼놓는다 — 그날의 경기 줄은 일정 축이 이미 세운다. 갈래가 없는
   * 옛 세이브의 줄은 `other`로 본다(무엇인지 모르는 줄이지 경기 줄이 아니다).
   * 한 날에 여럿이면 무게 내림차순, 같으면 적힌 순서다 — 전역 정렬이라 날짜 안의
   * 순서도 그대로 따라온다.
   */
  const news = state.narrative
    .map((note, index) => ({ note, index }))
    .filter(({ note }) => (note.kind ?? "other") !== "match")
    .sort((a, b) => b.note.salience - a.note.salience || a.index - b.index);
  for (const { note } of news) {
    // 기록에서 이미 파생된 줄(이적창 개폐 같은)을 서사 표가 다시 세우지 않는다
    if ((events[note.date] ?? []).some((e) => e.text === note.text)) continue;
    push(note.date, { kind: "news", text: note.text });
  }
}

/**
 * 접힌 합계에서 **표가 쓰는 것만** — 평점은 합계가 아니라 평균을 싣는다.
 * `ratingSum`을 보내고 화면이 나누면 코어와 다른 자리에서 반올림한다.
 */
function careerTotalsView(t: CareerTotals): CareerTotalsView {
  return {
    apps: t.apps,
    goals: t.goals,
    assists: t.assists,
    rating: t.rating,
    reserveApps: t.reserveApps,
    reserveGoals: t.reserveGoals,
  };
}

/**
 * **보드에 걸려 있는 것** — 열린 요청 하나와 영입 승인분.
 *
 * 기한이 지난 승인분은 세지 않는다. tick이 그날 지우므로 화면에 남을 자리는 없지만,
 * 만료를 읽는 자가 두 곳이면 하루 어긋난 날 유령 한 줄이 선다.
 */
function boardView(state: GameState): OfficeViews["finance"]["board"] {
  const open = openBoardRequest(state);
  const earmarked = (financeOf(state, state.userTeamId).earmarked ?? []).filter(
    (row) => state.date <= row.until,
  );
  return {
    request:
      open && (open.status === "pending" || open.status === "conditional")
        ? {
            label: BOARD_REQUEST_LABEL[open.kind],
            amount: boardRequestAmountText(open.kind, open.amount),
            playerName: open.playerId ? playerName(state, open.playerId) : null,
            status: open.status,
            askedOn: open.askedOn,
            respondOn: open.respondOn,
            condition: open.condition
              ? {
                  label: BOARD_CONDITION_LABEL[open.condition.kind],
                  amount: boardConditionAmountText(open.condition),
                  until: open.condition.until,
                }
              : null,
          }
        : null,
    earmarked: earmarked.map((row) => ({
      playerName: playerName(state, row.gamePlayerId),
      amount: row.amount,
      until: row.until,
    })),
  };
}

/**
 * 유스 후보 구획 — **안개는 조회·GM 스냅샷과 같은 함수를 지난다**
 * (`youthCandidateFog`). 화면이 참값을 그리면 같은 후보가 두 숫자로 갈린다.
 */
function youthIntakeView(state: GameState): YouthIntakeView | null {
  const rows = ourYouthCandidates(state);
  if (rows.length === 0) return null;
  return {
    deadline: youthIntakeDeadline(state),
    candidates: rows.map((row) => {
      const { overall, potential } = youthCandidateFog(state.seed, row.player);
      return {
        id: row.player.id,
        name: row.player.name,
        age: ageOf(row.player.birthdate, state.date),
        position: naturalPositionOf(row.player).position,
        overall,
        potential: { low: potential.low, high: potential.high, confidence: potential.confidence },
        weeklyWage: row.weeklyWage,
        years: row.years,
        autoSign: row.autoSign,
      };
    }),
  };
}

/**
 * 클럽을 떠나 있는 한 칸 (`SquadViewRow.away`) — **소집이 먼저다.** 여름 대회의
 * 늦은 합류는 A매치 창과 겹치지 않지만, 겹치는 날이 온다면 지금 그를 데려간 쪽이
 * 소집이다.
 *
 * 복귀일은 창에서 나온다 — 소집 행은 키만 들고 있고 날짜는 시즌에서 파생한다
 * (`internationalBreaksOf` · competition.md §5-1). `available`은 이 칸이 아니라
 * 코어의 `isAvailable`을 읽으므로, 창을 못 찾은 행이 여기서 빠져도 명단 판정은 갈리지 않는다.
 */
/**
 * 죽은 공 키커 셋 — **지정과 지금 실제로 설 사람** (`SetPieceTakerView`).
 *
 * 기본값을 내는 것은 코어의 함수 하나다(`setPieceTakersOf` — 패킷이 부르는 바로
 * 그것). 여기서 「킥력 최고」를 다시 재면 명단이 예고한 키커와 90분이 세우는 키커가
 * 갈리고, 그때 감독이 믿는 것은 화면이지 판정이 아니다.
 *
 * 경기 중이면 `live`가 그 경기의 패킷이 이미 고른 값이라 그것이 이긴다 (match.md §8).
 */
function setPieceTakerViews(
  squad: readonly GamePlayer[],
  designated: SetPieceTakers | undefined,
  starters: readonly TacticAssignment[],
  live: SetPieceProfile["takers"] | null,
): Record<SetPieceRole, SetPieceTakerView> {
  const byId = new Map(squad.map((p) => [p.id, p] as const));
  /** 우리 명단에 없는 id는 싣지 않는다 — 화면이 이름을 찾지 못해 빈칸이 선다 */
  const ours = (id: string | null | undefined): string | null =>
    id !== null && id !== undefined && byId.has(id) ? id : null;
  const slots: TakerSlot[] = starters.flatMap((a) => {
    const player = byId.get(a.playerId);
    return player ? [{ player, position: a.position }] : [];
  });
  const standing = live ?? setPieceTakersOf(slots, designated);
  return Object.fromEntries(
    SET_PIECE_ROLES.map((role) => [
      role,
      {
        designated: ours(designated?.[role]),
        taker: ours(standing[role]),
      } satisfies SetPieceTakerView,
    ]),
  ) as Record<SetPieceRole, SetPieceTakerView>;
}

function awayViewOf(state: GameState, player: GamePlayer): SquadViewRow["away"] {
  const callUp = openCallUp(state, player.id);
  if (callUp !== null) {
    const season = Number(callUp.breakKey.split(":")[0]);
    const window = Number.isFinite(season)
      ? internationalBreaksOf(season).find((w) => w.key === callUp.breakKey)
      : undefined;
    return window === undefined
      ? null
      : {
          reason: "call-up",
          country: callUp.country,
          countryName: associationName(callUp.country),
          returnsOn: window.to,
          apps: callUp.apps,
          goals: callUp.goals,
        };
  }
  const summer = player.state.summerReturn;
  if (summer === undefined || state.date >= summer) return null;
  return {
    reason: "tournament",
    country: player.nationality ?? null,
    countryName: player.nationality === undefined ? null : associationName(player.nationality),
    returnsOn: summer,
    apps: null,
    goals: null,
  };
}

export function buildOfficeViews(state: GameState): OfficeViews {
  const userTeamId = state.userTeamId;
  /** 감독의 것을 가르는 자 — 보관함과 시상 줄이 같은 판정을 쓴다 (career.md §6) */
  const managedThen = managerTenureOf(state);
  /**
   * 명단 표는 **우리 계약**을 센다 — 임대 보낸 선수도 우리 선수다 (transfer.md §2).
   * 넓히는 것은 이 표 하나뿐이다: 재정·등록 명단·전술은 **부릴 수 있는 인원**을
   * 세는 자리라 소속(`playersOf`) 그대로다.
   */
  const squad = ourPlayers(state);
  const loanById = new Map(loanReports(state).map((r) => [r.playerId, r] as const));
  const tactics = tacticsOf(state, userTeamId);
  const assignments = new Map(tactics.assignments.map((a) => [a.playerId, a] as const));
  /**
   * 배치가 없는 선수를 판에 올리면 코어가 줄 적응도 — **선반이 기준선을 이긴다**
   * (→ player.md §7.3). 화면이 `min(기준선, 팀)`을 스스로 계산하면 2군을 다녀온
   * 선수를 60으로 예고했다가 저장 응답에서 제 값으로 튄다.
   */
  const shelf = new Map((tactics.shelved ?? []).map((s) => [s.playerId, s] as const));
  const ifSlotted = (playerId: string) =>
    shelf.get(playerId)?.familiarity ??
    Math.min(FAMILIARITY_BASELINE, squadFamiliarity(state, userTeamId));
  const livePacket =
    state.phase === "match" && state.pendingMatch
      ? state.pendingMatch.packet.home.teamId === userTeamId
        ? state.pendingMatch.packet.home
        : state.pendingMatch.packet.away
      : null;
  /**
   * 경기 중 실제로 차는 사람 — **이 경기의 패킷이 이미 고른 값**이다 (match.md §8).
   * 패킷의 선수 칸(`PacketPlayer`)에는 능력치가 없어 뷰가 다시 고를 수도 없지만,
   * 다시 골라서도 안 된다: 교체로 나간 키커 대신 누가 서 있는지는 90분이 아는 사실이다.
   * 옛 세이브의 패킷에는 `setPieces`가 없다 — 그때는 저장된 선발에서 낸다.
   */
  const livePacketTakers =
    state.phase === "match" && state.pendingMatch
      ? (state.pendingMatch.packet.guide.setPieces?.[
          state.pendingMatch.packet.home.teamId === userTeamId ? "home" : "away"
        ]?.takers ?? null)
      : null;
  const liveSlots = new Map<string, { entry: PacketPlayer; role: "starting" | "bench" }>(
    livePacket
      ? [
          ...livePacket.lineup.map(
            (entry) => [entry.id, { entry, role: "starting" as const }] as const,
          ),
          ...livePacket.bench.map(
            (entry) => [entry.id, { entry, role: "bench" as const }] as const,
          ),
        ]
      : [],
  );
  /**
   * 경기 중이면 체력은 **지금 값**이다 — 킥오프의 저장값에서 이 경기가 가져간
   * 만큼(`pendingMatch.matchFatigue`)을 뺀다. 그 값이 판세 탭과 **같은 문**
   * (`conditionShown`)을 지나므로 같은 선수가 두 탭에서 다른 숫자로 보이지 않는다 —
   * 출전 명단에 든 선수는 양쪽 모두 읽은 값이다.
   */
  const worn = livePacket ? (state.pendingMatch?.matchFatigue ?? {}) : {};
  const liveMatchId = livePacket ? (state.pendingMatch?.matchId ?? null) : null;
  const issues = new Set(state.issues.map((i) => i.gamePlayerId));

  /**
   * 역할 기억 — 선수마다 (자리 → 역할). 화면이 코어 `inherit`의 되찾기를 같은
   * 순서로 재현하는 근거다 (player.md §3.2). 자리 목록에서 사라진 역할은 없는
   * 것으로 본다 — `recallRole`과 같은 기준이라 화면과 코어가 갈리지 않는다.
   */
  const roleMemoryOf = new Map<string, Record<string, string>>();
  for (const memory of state.roleMemory ?? []) {
    if (!rolesFor(memory.position).some((r) => r.id === memory.roleId)) continue;
    const byPosition = roleMemoryOf.get(memory.gamePlayerId) ?? {};
    byPosition[memory.position] = memory.roleId;
    roleMemoryOf.set(memory.gamePlayerId, byPosition);
  }

  /**
   * 커리어 · 마일스톤 — **원장을 한 번씩만 훑는다.**
   *
   * 선수마다 `careerOf`를 부르면 마흔 몇 명 × 원장 전체 훑기가 된다 — 비교자
   * 안의 `seasonStatOf`가 그랬던 것과 같은 함정을(위 정렬 주석) 행 만들기에서
   * 다시 밟는 셈이다. 선수 → 행으로 한 번에 갈라 두고 접는 것은 `foldCareer`에
   * 맡긴다: 카드(GM)와 **같은 함수**라 채팅에서 듣는 합과 표의 합이 갈리지 않는다.
   *
   * 스쿼드 선수로 좁혀 담는다 — 원장에는 리그 전체의 행이 있고 여기서 쓰는 것은
   * 우리 명단뿐이다.
   */
  /**
   * 라커룸 서열 — **한 번만 파생한다** (people.md §5-1). 행마다 부르면 마흔 몇 명이
   * 각자 원장을 훑는다.
   */
  const leaderRank = new Map<string, number>();
  leaderGroupOf(state, state.userTeamId).forEach((row, index) => {
    leaderRank.set(row.playerId, index + 1);
  });

  const squadIds = new Set(squad.map((p) => p.id));
  const statsOfPlayer = new Map<string, SeasonStat[]>();
  for (const stat of state.seasonStats) {
    if (!squadIds.has(stat.gamePlayerId)) continue;
    const rows = statsOfPlayer.get(stat.gamePlayerId);
    if (rows) rows.push(stat);
    else statsOfPlayer.set(stat.gamePlayerId, [stat]);
  }
  const milestonesOfPlayer = new Map<string, MilestoneView[]>();
  for (const milestone of state.milestones ?? []) {
    if (!squadIds.has(milestone.gamePlayerId)) continue;
    const rows = milestonesOfPlayer.get(milestone.gamePlayerId) ?? [];
    rows.push({
      code: milestone.code,
      value: milestone.value,
      date: milestone.date,
      teamId: milestone.teamId,
    });
    milestonesOfPlayer.set(milestone.gamePlayerId, rows);
  }
  /**
   * 시즌 행 + 통산 — **출전이 0인 시즌은 행을 세우지 않는다.** 원장은 명단에 든
   * 것만으로도 행을 갖고 있어, 걸러 내지 않으면 한 경기도 못 뛴 시즌이 표에
   * 0으로 늘어선다. 통산은 그래도 **전 행**을 접는다 (더해 봐야 같은 값이다).
   */
  const careerViewOf = (playerId: string): SquadViewRow["career"] => {
    const rows = statsOfPlayer.get(playerId) ?? [];
    // 시즌 × 팀 하나가 한 줄이다 — 대회별로 갈린 행을 접는 것은 커리어 표와 **같은
    // 함수**의 몫이다(`careerSeasonRowsOf`), 안 그러면 컵을 뛴 시즌이 두 줄로 선다
    const seasons = careerSeasonRowsOf(rows)
      .map((row) => ({ row, totals: careerTotalsView(row) }))
      .filter(({ totals }) => totals.apps > 0 || totals.reserveApps > 0)
      .map(({ row, totals }) => ({
        season: row.season,
        teamId: row.teamId,
        team: teamShortNameIn(state, row.teamId),
        ...totals,
      }));
    return { seasons, totals: careerTotalsView(foldCareer(rows)) };
  };

  // 선발의 전술판 좌표 — 좌표 없는 배치(구 세이브·채팅 지시)는 코드 기본 좌표로 그리는데,
  // 같은 코드가 둘이면 정확히 같은 점이 되므로 겹침을 풀어 준다. 저장하면 이 좌표가
  // 그대로 기록되어(setLineup) 다음 로드부터는 안정된다.
  const starters = tactics.assignments.filter((a) => a.role === "starting");
  const starterPoints = separateBoardPoints(starters.map((a) => a.point ?? anchorOf(a.position)));
  const pointOf = new Map(starters.map((a, i) => [a.playerId, starterPoints[i]!] as const));

  const roleRank: Record<SquadViewRow["role"], number> = { 선발: 0, 벤치: 1, 스쿼드: 2 };
  /**
   * **명단 화면이 답하는 것은 「다음 경기」다** — 정지는 대회의 것이라(match.md §6)
   * 컵 정지 선수가 리그 명단에서 빨갛게 서면 감독이 쓸 수 있는 선수를 잃는다.
   */
  const nextCompetition =
    nextMatchFor(state.matches, userTeamId, state.date)?.competitionId ?? null;
  const players: SquadViewRow[] = squad
    .map((p) => {
      const assignment = assignments.get(p.id);
      const liveSlot = liveSlots.get(p.id);
      const injury = openInjury(state, p.id);
      const suspension = activeSuspensionFor(state, p.id, nextCompetition);
      const contract = activeContract(state, p.id);
      const stat = seasonStatOf(state, p.id);
      /**
       * 대회별 줄 — **위에서 갈라 둔 행에서 고른다.** `seasonStatsByCompetitionOf`를
       * 부르면 마흔 몇 명이 각자 원장을 한 번 더 훑는다(위 커리어 주석과 같은 함정).
       * 무엇이 서고 무엇이 빠지는가는 선수 카드와 **같은 함수**가 갖는다.
       */
      const byCompetition = competitionRowsOf(
        (statsOfPlayer.get(p.id) ?? []).filter(
          (s) => s.season === state.season && s.teamId === p.teamId,
        ),
      ).map((row) => ({
        competitionId: row.competitionId,
        name: competitionShortName(row.competitionId),
        apps: row.apps,
        goals: row.goals,
        assists: row.assists ?? 0,
      }));
      const natural = naturalPositionOf(p);
      /**
       * **안개는 축에만 씌운다.** 종합·자리 전력은 그 관측된 축에서 파생시킨다
       * (`observedFit`) — 값마다 따로 오차를 굴리면 자리끼리 앞뒤가 안 맞고,
       * 무엇보다 **화면이 같은 계산을 재현할 수 없다**(참값이 없으므로). 그래서
       * 자리를 옮겨 보는 전술판은 "서버 값에 차이만 얹는" 보정을 해야 했고,
       * 그 보정이 명단과 갈려 같은 선수의 OVR이 두 숫자로 보였다.
       *
       * 이제 규칙은 하나다 — **관측된 축 + 하나의 오프셋**. 서버와 화면이 같은
       * 함수를 부르므로 어디서 계산해도 같은 값이 나온다.
       */
      const observation = observationOf(state, p.id);
      const observed = Object.fromEntries(
        ATTRIBUTE_AXES.map((a) => [a, observedRating(state, p.id, a, p.attributes[a])]),
      ) as AxisValues;
      // 역할을 함께 넘긴다 — 같은 센터백이라도 노넌센스와 볼 플레잉은 요구가 다르다.
      // 그래야 감독이 역할을 바꿨을 때 화면의 숫자가 그 자리에서 곧바로 답한다.
      const slotFit = (position: string, role?: string) =>
        observedFit(observed, observation, position, role);
      const assignedSlot = liveSlot?.entry.position ?? assignment?.position ?? null;
      /**
       * **자리가 있는가** — 역할이 성립하는 조건이다 (player.md §3.1).
       *
       * 벤치·예비 배치에는 좌표가 없어 `position`이 주 포지션으로 채워지는데, 그걸
       * 자리로 치면 화면은 그 자리의 역할 목록을 켜고 코어는 그 역할을 받지 않는다 —
       * 화면은 CF라 말하고 오류는 ST라 답하던 지점이다.
       *
       * 역할 기억(§3.2)은 여기서 보지 않는다 — 되찾기는 코어가 배치에 적어 넣는
       * 일이고(`setLineup`의 승계), 화면이 따로 기억을 읽으면 배치에 없는 역할을
       * 화면만 말하게 된다. 기억은 다시 선발이 될 때 `roleId`로 서서 온다.
       */
      const slotted = (liveSlot?.role ?? assignment?.role) === "starting";
      const assignedRoleId = slotted ? (liveSlot?.entry.roleId ?? assignment?.roleId) : undefined;
      const shownOverall = observedOverall(p.attributes.overall, observation);
      const slotValue = assignedSlot ? slotFit(assignedSlot, assignedRoleId) : null;
      return {
        id: p.id,
        name: p.name,
        squadNumber: p.squadNumber ?? null,
        age: ageOf(p.birthdate, state.date),
        position: natural.position,
        positionGroup: groupOf(p),
        positions: p.positions.map((x) => ({ ...x, overall: slotFit(x.position) })),
        overall: shownOverall,
        observation,
        /**
         * 이 자리·이 **역할**에서 내는 전력 — 기본값과 다를 때만 채운다.
         *
         * ⚠️ 자리 묶음만 보지 않는다. 센터백이 센터백 자리에 선 채로 **역할만**
         * 바꿔도(볼 플레잉 디펜더 ↔ 노넌센스) 요구 역량이 달라지므로, 자리든
         * 역할이든 기본과 달라지면 그 값을 낸다.
         */
        slotOverall: slotValue !== null && slotValue !== shownOverall ? slotValue : null,
        // 오피스는 우리 선수의 숫자를 그대로 보여준다 (player.md §10). 단 **적응 중인 새
        // 영입**은 스카우트 수준의 오차가 남는다 — 훈련장에서 본 게 전부다.
        ...observed,
        potential: potentialBand(state, p),
        homegrown: isHomegrownFor(p, userTeamId),
        nationality: p.nationality ?? null,
        secondNationality: p.secondNationality ?? null,
        caps: capsOf(p.state),
        internationalGoals: internationalGoalsOf(p.state),
        foot: p.foot ?? { left: 3, right: 3 },
        height: p.height ?? null,
        weight: p.weight ?? null,
        occupiesList: occupiesSquadList(state, p),
        settling: settlingPercent(state, p.id),
        transferListed: listingOf(state, p.id)?.askingPrice ?? null,
        squadLevel: squadLevelOf(p),
        loan: (() => {
          const report = loanById.get(p.id);
          return report
            ? {
                teamId: report.teamId,
                team: teamShortNameIn(state, report.teamId),
                until: report.until,
                apps: report.apps,
                goals: report.goals,
                rating: report.rating,
                benchRun: report.benchRun,
                growth: report.growth,
              }
            : null;
        })(),
        away: awayViewOf(state, p),
        form: Math.round(p.state.form * 100) / 100,
        formLabel: formLabel(p.state.form),
        formAngle: formAngle(p.state.form),
        formTone: formTone(p.state.form),
        recentRatings: recentRatingsOf(state, p.id),
        condition: conditionShown(
          state,
          p.id,
          p.state.condition,
          liveSlot && liveMatchId ? { drain: worn[p.id] ?? 0, matchId: liveMatchId } : null,
        ),
        sharpness: Math.round(sharpnessOf(p.state)),
        sharpnessLabel: sharpnessLabel(sharpnessOf(p.state)),
        sharpnessBand: sharpnessBand(sharpnessOf(p.state)),
        fatigueLabel: fatigueLabel(fatigueOf(p.state)),
        fatigueBand: fatigueBand(fatigueOf(p.state)),
        injuryRisk: injuryRiskFor(p),
        mood: moodOf(state, p),
        role: (livePacket
          ? liveSlot
            ? ROLE_KO[liveSlot.role]
            : "스쿼드"
          : assignment
            ? ROLE_KO[assignment.role]
            : "스쿼드") as SquadViewRow["role"],
        assignedPosition: assignedSlot,
        roleId: slotted && assignedSlot ? (assignedRoleId ?? defaultRoleOf(assignedSlot)) : null,
        roleOptions:
          slotted && assignedSlot
            ? rolesFor(assignedSlot).map((r) => ({
                id: r.id,
                ko: r.ko,
                abbr: r.abbr,
                desc: r.desc,
              }))
            : [],
        roleMemory: roleMemoryOf.get(p.id) ?? {},
        /**
         * **자리가 없어도 싣는다.** 코어의 장부는 (선수·오늘)이라 벤치를 다녀와도
         * 흔적이 이어진다. 선발 행에만 실으면 돌아온 선수의 적응도 미리보기가
         * 서버와 다른 자로 잰 값이 된다.
         *
         * 다만 **아침의 자리가 아니면 싣지 않는다** — 코어는 그 자리에서만 아침의
         * 역할과 견주고 나머지 자리에서는 낸 값을 되돌린다(`settleRoleCost`).
         * 옛 자리의 역할을 기준으로 재면 화면이 서버가 매기지 않을 값을 예고한다.
         * 어느 자리의 흔적인지는 `assignedPosition`이 말한다.
         */
        roleToday:
          assignment?.roleMemo?.date === state.date &&
          (assignment.roleMemo.position ?? assignedSlot) === assignedSlot
            ? { role: assignment.roleMemo.role, paid: assignment.roleMemo.paid }
            : null,
        assignedPoint: liveSlot?.entry.point ?? pointOf.get(p.id) ?? null,
        // 저장은 소수지만 화면은 눈금이다 — 87.4와 87.7을 감독이 구분할 일은 없다
        familiarity: Math.round(assignment?.familiarity ?? FAMILIARITY_BASELINE),
        familiarityIfSlotted: Math.round(assignment?.familiarity ?? ifSlotted(p.id)),
        positionFit: proficiencyAt(p, assignedSlot ?? natural.position),
        adaptation: adaptationOf(
          proficiencyAt(p, assignedSlot ?? natural.position),
          assignment?.familiarity ?? FAMILIARITY_BASELINE,
          assignedSlot ?? natural.position,
        ),
        instruction: assignment?.instruction ?? null,
        isCaptain: p.isCaptain,
        isViceCaptain: p.isViceCaptain === true,
        leaderRank: leaderRank.get(p.id) ?? null,
        seasonGoals: stat?.goals ?? 0,
        seasonApps: stat?.apps ?? 0,
        seasonByCompetition: byCompetition.length < 2 ? [] : byCompetition,
        seasonAssists: stat?.assists ?? 0,
        seasonRating: seasonRating(stat),
        seasonMinutes: stat?.minutes ?? 0,
        seasonShots: stat?.shots ?? 0,
        seasonXg: stat?.xg ?? 0,
        seasonSaves: stat?.saves ?? 0,
        seasonCleanSheets: stat?.cleanSheets ?? 0,
        seasonYellows: stat?.yellows ?? 0,
        seasonReds: stat?.reds ?? 0,
        career: careerViewOf(p.id),
        milestones: (milestonesOfPlayer.get(p.id) ?? []).slice(-SQUAD_MILESTONES_SHOWN),
        hasIssue: issues.has(p.id),
        weeklyWage: contract?.weeklyWage ?? 0,
        contractUntil: contract?.until ?? null,
        squadStatus: squadStatusOf(state, p),
        promises: openPromises(state, p.id).map((pr) => ({ kind: pr.kind, dueOn: pr.dueOn })),
        injury: injury
          ? {
              bodyPart: injury.bodyPart,
              severity: INJURY_SEVERITY_KO[injury.severity],
              expectedReturn: injury.expectedReturn,
            }
          : null,
        suspended: suspension ? suspension.lengthMatches - suspension.served : 0,
        /**
         * **코어의 문을 그대로 읽는다** — 부상·정지에 더해 소집·여름 대회까지
         * 한 자리에서 판정한다 (`isAvailableFor` → season.md §8 불변식). 여기서
         * 조건을 다시 세면 소집된 주전이 화면에서만 선발 가능한 얼굴로 선다.
         */
        available: isAvailableFor(state, p, nextCompetition),
      } satisfies SquadViewRow;
    })
    .sort((a, b) =>
      a.role === b.role ? b.overall - a.overall : roleRank[a.role] - roleRank[b.role],
    );

  // 대회 탭 — 우리 리그 → 우리가 나가는 대항전 → 우리 나라 국내 컵 (명성 순)
  // 리그는 **지금 뛰는 리그**다 — 강등되면 카탈로그와 갈린다 (`promotion.ts`)
  const ourLeague = leagueOfTeamIn(state, userTeamId);
  const ourEuroCup = euroCompetitionOf(state.euroEntrants, userTeamId);
  const competitionList = [
    ourLeague,
    ...(ourEuroCup ? [ourEuroCup] : []),
    ...domesticCupsOf(userTeamId).map((c) => c.id),
  ].map((id) => buildCompetitionView(state, id));
  /**
   * 다음 경기 — **지금 치르는 경기는 빼고 본다.**
   *
   * `nextMatchFor`는 결과가 없는 첫 경기를 고르는데, 경기 중에는 그게 **지금 이
   * 경기**다(결과는 종료 시점에 쓰인다). 경기 화면에서 감독이 "다음 경기"로
   * 알고 싶은 건 이 90분이 끝난 뒤이므로 그 하나를 건너뛴다 — 안 그러면
   * 대회 탭 아래에 "오늘 · 지금 상대"가 뜬다.
   */
  const next = nextMatchFor(
    state.matches,
    userTeamId,
    state.date,
    state.pendingMatch?.matchId ?? null,
  );

  // ── 일정 뷰 (유저 팀 관련 경기 + 훈련 + 이적창) ──
  const sessionById = new Map(state.trainingSessions.map((s) => [s.id, s] as const));
  const matchById = new Map(state.matches.map((m) => [m.id, m] as const));
  const windowById = new Map(state.windows.map((w) => [w.id, w] as const));
  const entries: CalendarEntryView[] = state.schedule
    .filter((e) => e.type !== "match" || isUserMatch(state, e.refId))
    // 추첨 엔트리는 대회마다 남지만(진행 상태 기계), 달력엔 우리와 상관있는 것만
    .filter((e) => e.type !== "draw" || e.teamId !== null)
    .map((e): CalendarEntryView | null => {
      if (e.type === "cup-round") {
        const { competition, stage } = drawParts(e.refId);
        return {
          id: e.id,
          date: e.date,
          time: e.time,
          type: e.type,
          status: e.status,
          // 제목이 다 말한다 — "상대는 추첨에서 정해진다" 같은 부연은 붙이지 않는다
          title: `${competition} ${stage} 예정`,
          detail: null,
          result: null,
          win: null,
          isNext: false,
          match: null,
          cup: { competition, stage },
        };
      }
      if (e.type === "draw") {
        return {
          id: e.id,
          date: e.date,
          time: e.time,
          type: e.type,
          status: e.status,
          title: drawTitle(e.refId),
          detail: null,
          result: null,
          win: null,
          isNext: false,
          match: null,
          cup: drawParts(e.refId),
        };
      }
      if (e.type === "training") {
        const s = sessionById.get(e.refId);
        const slotKo = slotOfTime(e.time) === "am" ? "오전" : "오후";
        return {
          id: e.id,
          date: e.date,
          time: e.time,
          type: e.type,
          status: e.status,
          /**
           * 휴식은 훈련이 아니다 — "오전 훈련 — 휴식"이라고 쓰면 한 줄 안에서
           * 스스로를 부정한다. 자리(오전/오후)만 남기고 그대로 "휴식"이라 적는다.
           */
          title: s?.rest === true ? `${slotKo} 휴식` : `${slotKo} 훈련 — ${s?.label ?? "훈련"}`,
          rest: s?.rest === true,
          // 축은 감독이 읽는 이름으로 — `tactical·aggression`은 장부의 id지 표기가 아니다
          detail:
            s && s.focus.length > 0 ? s.focus.map((f) => TRAIN_ATTR_KO[f] ?? f).join("·") : null,
          /**
           * 소화한 훈련은 **무엇이 남았는지**를 함께 보여준다 — 그날 결산이 매긴
           * 성장 로그를 그대로 읽는다. 훈련이 달력에서 점 하나로만 지나가면
           * 감독은 훈련장에 시간을 쓴 보람을 확인할 자리가 없다.
           */
          result: e.status === "done" ? growthSummary(state, e.date, e.id) : null,
          win: null,
          isNext: false,
          match: null,
          cup: null,
        };
      }
      if (e.type === "match") {
        const m = matchById.get(e.refId);
        if (!m) return null;
        const home = m.homeTeamId === userTeamId;
        const opponent = teamNameIn(state, home ? m.awayTeamId : m.homeTeamId);
        let result: string | null = null;
        let win: CalendarEntryView["win"] = null;
        let detail: string | null = null;
        if (m.result) {
          const my = home ? m.result.homeGoals : m.result.awayGoals;
          const their = home ? m.result.awayGoals : m.result.homeGoals;
          win = outcomeFor(m, userTeamId);
          const pens = m.result.penalties;
          const pensLabel = pens
            ? ` (승부차기 ${home ? pens.home : pens.away}-${home ? pens.away : pens.home})`
            : "";
          result = `${my}-${their}${pensLabel} ${outcomeLabel(win)}`;
          const mySide = home ? "home" : "away";
          /**
           * 득점자 — **도움까지 함께 읽는다.** 장부는 골 대부분에 도움을 붙이므로
           * 여기서 빠뜨리면 화면에는 "어시스트가 기록되지 않는다"로 보인다
           * (`MatchResult.assists` — 득점자와 같은 순서, 없는 골은 빈 칸).
           */
          const assistIds = m.result.assists ?? [];
          const minutes = m.result.goalMinutes ?? [];
          const scorers = (m.result.scorers ?? []).map((entry, i) => {
            const goal = parseScorerEntry(entry);
            const name = playerName(state, goal.playerId);
            const assist = parseScorerEntry(assistIds[i] ?? "");
            const withAssist = assist.playerId
              ? `${name} (${playerName(state, assist.playerId)})`
              : name;
            // 분이 붙으면 스코어가 이야기가 된다 — 87분 동점골과 5분 선제골은 다르다
            const at = minutes[i] !== undefined ? `${withAssist} ${minutes[i]}′` : withAssist;
            // 편이 붙지 않은 옛 칸은 기준 팀의 골로 읽는다
            return goal.side === null || goal.side === mySide ? at : `${at} (상대)`;
          });
          detail = scorers.length > 0 ? `득점: ${scorers.join(", ")}` : null;
        }
        const cup = isCup(m.competitionId);
        const stage = competitionStageLabel(m.competitionId, m.stage ?? "league", m.round);
        return {
          id: e.id,
          date: e.date,
          time: e.time,
          type: e.type,
          status: e.status,
          title: `${fixtureLabel(m.competitionId, m.stage ?? "league", m.round)} ${m.neutral ? "중립" : home ? "홈" : "원정"} vs ${opponent}`,
          detail,
          result,
          win,
          isNext: next !== null && m.id === next.id,
          match: {
            matchId: m.id,
            // 리그 경기는 이름을 생략한다(감독은 자기 리그를 안다). 컵과 친선은
            // 어느 경기인지가 곧 정보다
            competition: cup || isFriendly(m) ? competitionShortName(m.competitionId) : null,
            // 친선은 단계가 없어 빈 문자열이다 — 화면이 빈 칩을 그리지 않는다
            stage,
            opponent: teamShortNameIn(state, home ? m.awayTeamId : m.homeTeamId),
            opponentName: opponent,
            venue: m.neutral ? "neutral" : home ? "home" : "away",
            // 칸이 좁아 정규시간 스코어만 — 승부차기 여부는 색(승/패)과 툴팁에 있다
            score: m.result
              ? `${home ? m.result.homeGoals : m.result.awayGoals}-${home ? m.result.awayGoals : m.result.homeGoals}`
              : null,
          },
          cup: null,
        };
      }
      const w = windowById.get(e.refId);
      const kindKo = w?.kind === "winter" ? "겨울" : "여름";
      return {
        id: e.id,
        date: e.date,
        time: e.time,
        type: e.type,
        status: e.status,
        title: `${kindKo} 이적시장 ${e.type === "window-open" ? "개장" : "마감"}`,
        detail: w ? `${w.opensOn} ~ ${w.closesOn}` : null,
        result: null,
        win: null,
        isNext: false,
        match: null,
        cup: null,
      };
    })
    .filter((x): x is CalendarEntryView => x !== null);

  // ── 일자별 일지 — 기록 테이블에서 파생 (diary 저장 없음) ──
  const events: Record<string, CalendarEventView[]> = {};
  const push = (date: string, event: CalendarEventView) => {
    (events[date] ??= []).push(event);
  };
  for (const e of entries) {
    // 일지는 "지나간 일"만 — 미래 일정은 달력 엔트리로 따로 보인다
    if (e.date > state.date) continue;
    if (e.type === "match" && e.result) {
      push(e.date, {
        kind: "match",
        text: `${e.title} ${e.result}${e.detail ? ` · ${e.detail}` : ""}`,
      });
    }
    if (e.type === "training" && e.status === "done") {
      // 지나간 날의 기록 — 휴식도 감독이 정한 일이라 남기되 역기를 달지 않는다
      push(e.date, { kind: e.rest ? "rest" : "training", text: e.title });
    }
    if (e.type === "window-open" || e.type === "window-close") {
      push(e.date, { kind: "window", text: e.title });
    }
  }
  /**
   * 나머지 갈래(성장·부상·카드·이적·돈·소식)는 일정 축을 타지 않는다 — 조회
   * (`scheduleView`)도 같은 함수를 읽는다.
   */
  pushRecordJournal(state, events);

  const finance = financeOf(state, userTeamId);

  // ── 재정 (유저 팀) ──
  const line = (l: { category: string; amount: number }) => ({
    category: l.category,
    label: FINANCE_CATEGORY_KO[l.category as keyof typeof FINANCE_CATEGORY_KO] ?? l.category,
    amount: l.amount,
  });
  const reports: FinanceMonthView[] = [...userReports(state)]
    .sort((a, b) => (a.month < b.month ? 1 : -1))
    .map((r) => ({
      month: r.month,
      closed: true,
      income: r.income.map(line),
      expense: r.expense.map(line),
      incomeTotal: r.incomeTotal,
      expenseTotal: r.expenseTotal,
      cashNet: r.cashNet,
      pnlNet: r.pnlNet,
      wageRatio: r.wageRatio,
      wageTone: wageRatioTone(r.wageRatio),
      notes: financeNoteTexts(r),
    }));
  const now = currentMonthSummary(state);
  const current: FinanceMonthView = {
    month: now.month,
    closed: false,
    income: now.income.map(line),
    expense: now.expense.map(line),
    incomeTotal: now.incomeTotal,
    expenseTotal: now.expenseTotal,
    cashNet: now.cashNet,
    pnlNet: now.pnlNet,
    wageRatio: now.wageRatio,
    wageTone: wageRatioTone(now.wageRatio),
    notes: [],
  };
  // 실시간 활동 피드 — 접은 뒤 최근 30줄 (§8.1). 자르고 접으면 접기 전과 같아진다
  const feed = foldFinanceFeed(finance.ledger);
  // 영입 관문 넷 — `get_finance`와 같은 자를 읽는다 (§8.3)
  const outlook = financeOutlook(state);
  const stadium = clubProfileIn(state, userTeamId);

  const recentResults = state.matches
    // 2군 경기는 1군의 최근 결과가 아니다 — 다이제스트와 선수 기록으로만 보인다
    .filter(
      (m) =>
        m.result &&
        !isReserveMatch(m) &&
        (m.homeTeamId === userTeamId || m.awayTeamId === userTeamId),
    )
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-5)
    .map((m): RecentResultView | null => {
      const result = m.result;
      const outcome = outcomeFor(m, userTeamId);
      // 위 필터가 결과 있는 우리 경기만 남긴다 — 타입을 좁히는 자리다
      if (!result || !outcome) return null;
      return {
        label: fixtureLabel(m.competitionId, m.stage ?? "league", m.round),
        home: teamShortNameIn(state, m.homeTeamId),
        away: teamShortNameIn(state, m.awayTeamId),
        homeGoals: result.homeGoals,
        awayGoals: result.awayGoals,
        penalties: result.penalties
          ? { home: result.penalties.home, away: result.penalties.away }
          : null,
        venue: m.neutral ? "neutral" : m.homeTeamId === userTeamId ? "home" : "away",
        outcome,
      };
    })
    .filter((r): r is RecentResultView => r !== null);

  return {
    match: buildMatchView(state),
    squad: {
      manager: {
        name: state.manager.name,
        background: state.manager.background,
        attributes: { ...state.manager.attributes },
        reputation: { ...state.manager.reputation },
        // 옛 세이브엔 경고 필드가 없다 — 없으면 아직 한 번도 안 받은 것이다
        boardWarnings: state.manager.boardWarnings ?? 0,
        warningLimit: USER_WARNINGS_BEFORE_SACK,
        lastWarnedOn: state.manager.lastWarnedOn ?? null,
        // 훈련 XP가 0.5씩 쌓여 소수가 된다 — 화면이 87.5를 보일 이유가 없다
        xp: Object.fromEntries(
          Object.entries(state.managerXP).map(([axis, value]) => [axis, Math.round(value)]),
        ),
        xpPerLevel: MANAGER_XP_PER_LEVEL,
        attrCap: MANAGER_ATTR_CAP,
      },
      players,
      formation: tactics.spec.formation,
      tactics: { ...tactics.spec },
      familiarity: Math.round(squadFamiliarity(state, userTeamId)),
      // 경기 중과 무직에 꺼진다 — 무직의 판은 옛 구단의 것이라 읽기 전용이다 (career.md §5.1)
      editable: state.phase !== "match" && !state.dismissal,
      // 인원은 **부릴 수 있는 사람**을 센다 — 임대 나간 선수가 달고 있는 층은
      // 빌린 구단의 값이라 우리 1군·2군 수에 들면 안 된다
      firstTeamCount: players.filter((p) => p.loan === null && p.squadLevel === "first").length,
      reserveCount: players.filter((p) => p.loan === null && p.squadLevel === "reserve").length,
      registration: squadRegistrationOf(state, userTeamId),
      setPieces: setPieceTakerViews(squad, tactics.setPieceTakers, starters, livePacketTakers),
      youthIntake: youthIntakeView(state),
    },
    calendar: {
      today: state.date,
      preseasonStart: state.calendar.preseasonStart,
      seasonStart: state.calendar.start,
      seasonEnd: seasonEndDate(state.matches) ?? state.calendar.start,
      entries,
      events,
      windows: state.windows.map((w) => ({
        kind: w.kind === "summer" ? "여름" : "겨울",
        opensOn: w.opensOn,
        closesOn: w.closesOn,
        open: state.date >= w.opensOn && state.date <= w.closesOn,
      })),
    },
    finance: {
      balance: finance.balance,
      weeklyWages: weeklyWagesOf(state, userTeamId),
      transferBudget: finance.transferBudget,
      budgetFrozen: finance.budgetFrozen === true,
      board: boardView(state),
      boardExpectation: (() => {
        const be = boardExpectation(state, userTeamId);
        const label = boardExpectationText(be.code, be.target);
        // 무직이면 걸린 계획이 없다 — 옛 구단의 것은 감독의 것이 아니다 (career.md §5.1)
        if (managedTeamId(state) === null) return { target: be.target, label, vision: null };
        const table = computeStandings(state, leagueOfTeamIn(state, userTeamId));
        const seat = table.findIndex((r) => r.teamId === userTeamId) + 1;
        // 0경기 순위는 팀 id 정렬일 뿐이다 — 아직 자리가 없으면 코어에 0을 넘긴다
        const played = table[seat - 1]?.played ?? 0;
        const vision = visionOf(state);
        return {
          target: be.target,
          label,
          vision: {
            year: visionYearOf(vision, state.season),
            span: visionSpanOf(vision),
            items: visionItemViews(
              visionReadings(state, {
                position: played > 0 ? seat : 0,
                leagueSize: table.length,
              }),
            ),
          },
        };
      })(),
      stadium: { name: stadium.stadium, capacity: stadium.capacity },
      ticket: (() => {
        const { price, base } = ticketPriceOf(state, userTeamId);
        return { price, base };
      })(),
      // 시즌 누계 기준 — 한 달만 보면 프리시즌에 100%를 넘어 무의미하다
      wageRatio: seasonWageRatio(state),
      wageTone: wageRatioTone(seasonWageRatio(state)),
      psr: reports.length > 0 ? psrStatus(state) : null,
      ...outlook,
      current,
      reports,
      feed,
    },
    competitions: {
      // 대회 이름을 **언제나** 붙인다 — 이 카드 하나가 유일한 일정 정보라
      // "R2"만 적으면 무슨 대회의 2라운드인지 화면 어디에도 없다
      nextMatch: next
        ? nextMatchView(
            state,
            next,
            competitionLabel(next.competitionId, next.stage ?? "league", next.round),
          )
        : null,
      // 같은 경기의 상대 분석 — 코어가 경기 중에는 빈손을 낸다 (`buildOpponentReport`)
      preview: next ? matchPreviewView(state, next.id) : null,
      recentResults,
      list: competitionList,
    },
    career: {
      dismissal: state.dismissal
        ? {
            on: state.dismissal.on,
            season: state.dismissal.season,
            /** 경질인가 계약 만료인가 — 옛 카드엔 없어 경질로 읽는다 (career.md §5.4) */
            kind: state.dismissal.kind ?? ("sacked" as const),
            severance: state.dismissal.severance ?? null,
            teamName: teamNameIn(state, state.dismissal.teamId),
            tier: state.dismissal.tier ?? null,
            position: state.dismissal.position ?? null,
            target: state.dismissal.target ?? null,
            expectation: expectationTextOf(state.dismissal),
            reason: state.dismissal.reason ?? null,
          }
        : null,
      dismissals: (state.dismissals ?? []).map((d) => ({
        on: d.on,
        season: d.season,
        kind: d.kind ?? ("sacked" as const),
        teamName: teamNameIn(state, d.teamId),
        position: d.position ?? null,
        target: d.target ?? null,
        expectation: expectationTextOf(d),
      })),
      offers: openManagerOffers(state).map((o) => ({
        id: o.id,
        /** 어떻게 선 제안인가 — 옛 세이브의 제안엔 없어 공석이 부른 것으로 읽는다 */
        via: o.via ?? ("vacancy" as const),
        teamName: teamNameIn(state, o.teamId),
        tier: o.tier,
        expiresOn: o.expiresOn,
        position: o.position ?? null,
        target: o.target,
        expectation: expectationTextOf(o) ?? "",
        salary: o.salary ?? null,
        years: o.years ?? null,
        budgetPledge: o.budgetPledge ?? null,
        counteredOn: o.counteredOn ?? null,
        compensation: o.compensation ?? null,
      })),
      // 재직 중에도 문이다 — 명부는 14일이 지나면 코어가 내린다 (career.md §5.1)
      vacancies: (state.managerVacancies ?? []).map((v) => ({
        teamName: teamNameIn(state, v.teamId),
        tier: tierOfTeamIn(state, v.teamId),
        on: v.on,
        position: v.position ?? null,
      })),
      /**
       * 계약 — **수치와 기간만** 내려간다 (career.md §5.4 · overview.md §1 철칙 4).
       * `renewal`은 보드가 만료 90일 전에 내린 판정이고, 문장은 화면과 GM이 쓴다.
       */
      contract: state.manager.contract
        ? {
            salary: state.manager.contract.salary,
            until: state.manager.contract.until,
            daysLeft: Math.max(0, diffDays(state.date, state.manager.contract.until)),
            renewal:
              state.manager.contract.renewalDecidedOn === undefined
                ? null
                : state.manager.contract.renewalOffered
                  ? ("offered" as const)
                  : ("declined" as const),
          }
        : null,
      /** 감독의 지갑 — 구단 잔고와 다른 돈이고 이직을 따라간다 (career.md §5.4) */
      wallet: walletOf(state),
      spending: [...(state.manager.spending ?? [])]
        .reverse()
        .slice(0, MANAGER_WALLET.KEPT)
        .map((s) => ({
          on: s.on,
          kind: MANAGER_SPEND_KIND_KO[s.kind],
          amount: s.amount,
          playerName:
            s.kind === "player-bonus" && s.ref ? (playerById(state, s.ref)?.name ?? null) : null,
        })),
      /**
       * 보관함은 **감독의 것만** — 원장은 전 구단의 우승을 든다 (career.md §6).
       * 그대로 실으면 AI 구단의 우승이 감독의 보관함에 선다.
       */
      trophies: managerTrophiesOf(state).map((t) => ({
        competition: t.competitionId ? competitionName(t.competitionId) : (t.competition ?? ""),
        season: t.season,
        teamName: teamNameIn(state, t.teamId),
      })),
      achievements: state.achievements.map((a) => ({
        code: a.code,
        season: a.season,
        position: a.position,
        leagueName: a.leagueId ? leagueName(a.leagueId) : undefined,
        competitionName: a.competitionId ? competitionName(a.competitionId) : undefined,
        playerName: a.playerName,
        goals: a.goals,
        matches: a.matches,
      })),
      // 감독이 그 시즌 그 팀에 있었는가 — 트로피 보관함과 **같은 자**로 잰다 (career.md §6)
      awards: (state.awards ?? [])
        .filter((a) => managedThen(a.season, a.teamId))
        .map((a) => ({
          code: a.code,
          season: a.season,
          playerName: a.playerName,
          teamName: teamNameIn(state, a.teamId),
          competitionName: competitionName(a.competitionId),
          apps: a.apps,
          goals: a.goals,
          assists: a.assists,
          rating: a.rating,
          age: a.age,
        })),
      seasons: state.seasonRecords.map((s) => ({
        season: s.season,
        teamName: teamNameIn(state, s.teamId),
        position: s.position,
        record: { wins: s.wins, draws: s.draws, losses: s.losses },
        board: s.board
          ? {
              grade: s.board.grade,
              target: s.board.target,
              expectation: expectationTextOf(s.board) ?? "",
              // 비전이 서기 전의 시즌엔 없다 (career.md §6 — optional)
              items: visionItemViews(s.board.items ?? []),
            }
          : null,
        boardVerdict: s.boardVerdict ?? null,
      })),
    },
  };
}

export { assignmentsOf };

// ── 스카우팅 보고서 — 채팅이 카드로 그린다 ──────────────

/**
 * 스카우트가 가져온 **보고서 한 장**을 조립한다 — 안개는 `observedRating`이 이미 씌운다.
 *
 * **한 번 읽고 넘어갈 정보가 아니다** — 능력치 16축·주발·잠재력 구간·몸값이
 * 한자리에 있어야 "지금 지를까, 더 볼까"가 판단된다. 그래서 카드다.
 */
export function scoutReportCard(state: GameState, playerId: string): ScoutReportCard | null {
  const p = playerById(state, playerId);
  if (!p) return null;
  const grade = (value: number): ScoutGrade => ({
    label: ratingLabel(value),
    tier: ratingTier(value),
    value,
  });
  // 필드 플레이어의 골키핑은 어디에도 쓰이지 않는다 — 보고서에 두면 줄만 잡아먹는다
  const isKeeper = naturalPositionOf(p).position === "GK";
  const band = potentialBand(state, p);
  const groupOfAxis = (axis: string): string => {
    for (const [key, axes] of Object.entries(AXIS_GROUPS)) {
      if ((axes as readonly string[]).includes(axis)) {
        return AXIS_GROUP_KO[key as keyof typeof AXIS_GROUPS];
      }
    }
    return "";
  };
  return {
    playerId: p.id,
    name: p.name,
    team: teamNameIn(state, p.teamId),
    age: ageOf(p.birthdate, state.date),
    position: naturalPositionOf(p).position,
    positions: p.positions.map((x) => ({
      position: x.position,
      proficiency: x.proficiency,
      natural: x.isNatural === true,
    })),
    foot: p.foot ?? { left: 3, right: 3 },
    height: p.height ?? null,
    weight: p.weight ?? null,
    overall: {
      ...grade(observedRating(state, p.id, "overall", p.attributes.overall)),
      margin: observationMargin(state, p.id, "overall"),
    },
    potential: band ? { low: grade(band.low), high: grade(band.high) } : null,
    attributes: scoutedAttributes(state, p)
      .filter((a) => a.key !== "goalkeeping" || isKeeper)
      .map((a) => {
        const value = a.exact ?? observedRating(state, p.id, a.key, p.attributes[a.key] as number);
        return {
          key: a.key,
          ko: a.ko,
          value,
          tier: ratingTier(value),
          exact: a.exact !== null,
          margin: observationMargin(state, p.id, a.key),
          group: groupOfAxis(a.key),
        };
      }),
    marketValue: marketValueOf(state, p),
    wageExpectation: wageExpectationOf(state, p),
    contractUntil: activeContract(state, p.id)?.until ?? null,
    note: knowledgeNote(state, p.id),
  };
}

/**
 * 보고서 한 장을 **사실 한 줄로** — 도착 다이제스트가 모델에 넘기는 통로.
 *
 * 카드는 모델이 장면을 **쓴 뒤에** 붙어 화면에만 간다. 그래서 도착한 턴의 모델은
 * 금액을 어디서도 읽지 못하고, 읽지 못하면 지어낸다 — 카드는 £34.9M인데 대사는
 * 4,000만이 된다. 한 화면이 두 말을 하는 순간 둘 다 못 믿는다.
 *
 * ⚠️ **카드에서 파생한다.** 같은 값을 두 번 조립하면 한쪽만 고쳐질 때 다시 갈린다.
 * 코어는 사실만 내고 문장은 GM이 쓴다 (선수 근황 cues와 같은 결).
 */
export function scoutReportLine(state: GameState, playerId: string): string | null {
  const card = scoutReportCard(state, playerId);
  const player = playerById(state, playerId);
  if (!card || !player) return null;
  const overall =
    `종합 ${card.overall.value}` +
    (card.overall.margin > 0 ? `±${card.overall.margin}` : "") +
    ` (${card.overall.label})`;
  return [
    `${card.name} (${card.team}) ${card.age}세 ${card.position}`,
    overall,
    // 잠재력은 끝까지 폭으로만 안다 — 한 숫자로 적으면 모델이 그걸 단정한다 (player.md §9.1)
    card.potential
      ? `잠재력 ${card.potential.low.value}~${card.potential.high.value}`
      : "잠재력 미지",
    `시장가 ${formatMoney(card.marketValue)}`,
    `요구액 ${formatMoney(askingPriceFor(state, player))}`,
    `기대 주급 ${formatMoney(card.wageExpectation)}`,
    ...(card.contractUntil ? [`계약 ${card.contractUntil}까지`] : []),
  ].join(" · ");
}

// ── 스카우트 임무 보고 — 조건 한 벌이 데려온 후보 (player.md §9.4) ──

/**
 * 임무가 데려온 **후보 다섯 장**을 조립한다.
 *
 * 보고서 카드(`scoutReportCard`)와 다른 물음에 답한다 — 저쪽은 「이 선수가 어떤가」라
 * 16축을 펴고, 이쪽은 「누가 있나」라 다섯 줄이 나란히 선다.
 *
 * ⚠️ **금액도 흐린 값이다.** 후보는 `seen` 눈금이라 시장가의 흐림 폭이 0이 아니다
 * (player.md §10). 보고서 카드가 참값을 쓰는 것은 카드라서가 아니라 스카우팅을
 * 마친 선수의 폭이 0이기 때문이고, 임무의 후보는 아직 그 자리가 아니다.
 *
 * ⚠️ **줄을 세운 값과 같은 값을 찍는다** — 종합은 `observedOverall`, 곧
 * `rankMissionCandidates`가 읽은 그 숫자다.
 */
export function missionReportCard(state: GameState, missionId: string): MissionReportCard | null {
  const mission = (state.scoutMissions ?? []).find((m) => m.id === missionId);
  if (!mission || mission.completedOn === null) return null;
  const candidates = (mission.candidates ?? [])
    .map((id) => playerById(state, id))
    .filter((p): p is GamePlayer => p !== null)
    .map((p) => {
      const value = observedOverall(p.attributes.overall, observationOf(state, p.id));
      const band = potentialBand(state, p);
      return {
        playerId: p.id,
        name: p.name,
        team: teamNameIn(state, p.teamId),
        age: ageOf(p.birthdate, state.date),
        position: naturalPositionOf(p).position,
        overall: {
          label: ratingLabel(value),
          tier: ratingTier(value),
          value,
          margin: observationMargin(state, p.id, "overall"),
        },
        potential: band ? { low: band.low, high: band.high } : null,
        marketValue: observedMarketValue(state, p),
        contractUntil: activeContract(state, p.id)?.until ?? null,
      };
    });
  return {
    missionId: mission.id,
    brief: missionBrief(mission),
    scope: missionScope(mission),
    requestedOn: mission.requestedOn,
    completedOn: mission.completedOn,
    candidates,
  };
}

/**
 * 임무 보고를 **사실 한 줄로** — 도착 다이제스트가 모델에 넘기는 통로.
 *
 * ⚠️ **카드에서 파생한다** (`scoutReportLine`과 같은 규약). 카드는 프롬프트에 가지
 * 않으므로, 이 줄이 없으면 도착한 턴의 모델은 후보의 값을 어디서도 읽지 못하고
 * 지어낸다 — 그러면 카드의 다섯과 대사의 다섯이 다른 선수가 된다.
 */
export function missionReportLine(state: GameState, missionId: string): string | null {
  const card = missionReportCard(state, missionId);
  if (!card) return null;
  const label = `${card.scope} · ${card.brief}`;
  if (card.candidates.length === 0) return `${label} → 조건에 맞는 선수를 찾지 못했다`;
  const rows = card.candidates.map((c) =>
    [
      `${c.name} (${c.team}) ${c.age}세 ${c.position}`,
      `종합 ${c.overall.value}${c.overall.margin > 0 ? `±${c.overall.margin}` : ""}`,
      // 잠재력은 끝까지 폭으로만 안다 — 한 숫자로 적으면 모델이 그걸 단정한다
      c.potential ? `잠재력 ${c.potential.low}~${c.potential.high}` : "잠재력 미지",
      `시장가 ${formatMoney(c.marketValue)}`,
      ...(c.contractUntil ? [`계약 ${c.contractUntil}까지`] : []),
    ].join(" "),
  );
  return `${label} → 후보 ${card.candidates.length}명: ${rows.join(" / ")}`;
}

// ── 경기 리포트 — 끝난 경기 하나를 통째로 (match.md §8) ─────────────

/**
 * **큰 기회의 문턱** — 이 xG 이상인 슛만 타임라인에 선다.
 *
 * 슛 하나의 기본 xG가 `BASE_SHOT_XG`(0.10)이므로 그 세 배다. 문턱이 없으면 슛
 * 스무 개가 한 줄씩 서서 골이 그 안에 묻히고, 문턱을 두지 않고 슛을 통째로 버리면
 * "0.6짜리를 놓친 경기"가 사라진다. 슛의 **총량**은 이미 팀 스탯의 숫자다.
 */
export const BIG_CHANCE_XG = 0.3;

/**
 * 리포트의 소수는 **여기서 자른다** — 읽는 곳이 셋이라(화면 둘 · 조회 하나) 각자
 * 반올림하면 같은 경기의 xG가 세 숫자로 보인다. xG는 두 자리, 점유는 세 자리다.
 */
const roundTo = (value: number, digits: number): number => {
  const unit = 10 ** digits;
  return Math.round(value * unit) / unit;
};

/** 타임라인에 서는 사건 — 저장은 전부 하고(match.md §4) 세우는 것만 고른다 */
const TIMELINE_TYPES: ReadonlySet<MatchEventType> = new Set([
  "goal",
  "yellow_card",
  "red_card",
  "substitution",
  "injury",
  "tactical_shift",
  "half_time",
  "extra_time_start",
  "extra_half_time",
  "full_time",
]);

/** 타임라인 한 줄 — 사건 하나를 이름과 문장으로 옮긴 것 */
export interface MatchReportEventView {
  minute: number;
  /** 무엇이 일어났나 — 화면이 아이콘을, 조회가 말을 고른다 */
  type: MatchEventType;
  /** 어느 편의 사건인가 — 국면 표식은 편이 없다 */
  side: "home" | "away" | null;
  /** 우리 편의 사건인가 — 우리 경기가 아니면 null */
  ours: boolean | null;
  /** 주체의 이름 — goal은 [득점자, (도움)], substitution은 [아웃, 인] */
  actors: string[];
  /** 골·큰 기회가 어디서 나왔나 (열린 플레이·코너·프리킥·페널티) */
  origin: ShotOrigin | null;
  /** 그 슛의 질 — 골과 큰 기회에만 */
  xg: number | null;
  /**
   * **왜 그 골이 났나** — 패킷 태그를 문장으로 (match.md §4).
   * 감독의 전술 XP가 이 태그에 걸리는데 다시 볼 자리가 없었다.
   */
  causes: string[];
  /** 교체의 갈래 한 마디 — 승부수인가 굳히기인가 */
  subCause: string | null;
}

/** 한 팀의 경기 스탯 — 선수별 기록과 사건의 합, 두 벌로 두지 않는다 */
export interface MatchReportTeamView {
  name: string;
  short: string;
  ours: boolean;
  goals: number;
  shots: number;
  /** 기회 xG의 합 */
  xg: number;
  /** 결정력을 반영한 기대 득점 */
  expectedGoals: number;
  /** 공을 쥔 몫 0~1 — 옛 경기엔 없다 */
  possession: number | null;
  passes: number;
  progressive: number;
  corners: number;
  fouls: number;
  yellows: number;
  reds: number;
}

/** 선수 한 명의 경기 기록 — 평점과 그 근거까지 */
export interface MatchReportPlayerView {
  id: string;
  name: string;
  side: "home" | "away";
  ours: boolean;
  /** 등번호 — 지금 달고 있는 번호다 */
  squadNumber: number | null;
  /** 뛴 시간 — 사건 목록이 원본이다 (`matchMinutesOf`) */
  minutes: number;
  /** 선발이었나 — 교체로 들어온 선수가 아니면 선발이다 */
  started: boolean;
  goals: number;
  assists: number;
  shots: number;
  xg: number;
  saves: number;
  passes: number;
  progressive: number;
  corners: number;
  fouls: number;
  yellows: number;
  red: boolean;
  /** 평점 — 감독 팀 경기의 우리 선수만 갖는다 (match.md §6) */
  rating: number | null;
  /** 평점의 색 — 문턱은 코어가 갖는다 (`ratingTone`) */
  tone: RatingTone | null;
  /** 평점 한 줄 근거 — 결산 LLM이 남긴 경우에만 */
  note: string | null;
}

/**
 * 끝난 경기 한 장 — **읽는 곳이 셋이라 만드는 곳은 하나다** (match.md §8).
 *
 * 달력 상세의 접이식 · 종료 카드 · GM 조회(`get_match_report`)가 이 한 벌을 읽는다.
 * 셋이 각자 접으면 같은 경기가 세 가지로 보인다.
 */
export interface MatchReportView {
  matchId: string;
  date: string;
  /** 어느 경기인가 — `프리미어리그 R7` · `FA컵 8강 1차전` */
  label: string;
  /** 대회 약칭 */
  competition: string;
  stage: string;
  home: MatchReportTeamView;
  away: MatchReportTeamView;
  /** 우리가 어느 쪽이었나 — 우리 경기가 아니면 null */
  venue: "home" | "away" | "neutral" | null;
  /** 우리 시점의 결과 — 우리 경기가 아니면 null */
  outcome: "W" | "D" | "L" | null;
  /** 연장을 치렀다 */
  aet: boolean;
  /** 승부차기 — 갈린 경기만. 킥이 원본이라 합계도 거기서 센다 */
  penalties: {
    home: number;
    away: number;
    kicks: MatchShootoutKickView[];
  } | null;
  timeline: MatchReportEventView[];
  players: MatchReportPlayerView[];
  /** 최우수 선수 — 평점에서 파생한다 (`motmOf`) */
  motm: { id: string; name: string; rating: number } | null;
  /**
   * **사건이 남아 있는 경기인가.** 타 팀 간이 시뮬과 옛 세이브에는 사건이 없어
   * 타임라인이 득점 줄뿐이다 — 읽는 쪽이 그것을 "조용했던 경기"로 읽지 않게 한다.
   */
  hasDetail: boolean;
}

/**
 * **최우수 선수 — 평점이 원본이다** (game-state.md §5 파생).
 *
 * 저장하지 않는 이유는 평점이 두 번 정해지기 때문이다: 코어가 앵커를 박고 결산
 * 판정이 그 위에서 다듬는다(match.md §6). 저장하면 다듬어진 뒤에도 MOTM만 옛
 * 값으로 남는다.
 *
 * 동점 사슬은 **도메인이 갖는다**(`compareMotm`) — 대회의 결승 MOM 시상이 같은
 * 사슬을 쓰기 때문이다 (season.md §6). 두 벌로 두면 같은 결승의 최우수 선수가
 * 화면과 시상에서 다른 사람이 된다.
 */
export function motmOf(players: readonly MatchReportPlayerView[]): MatchReportPlayerView | null {
  return pickMotm(players);
}

/** 사건이 없는 옛 경기·간이 시뮬의 타임라인 — 결과에 남은 득점 줄만 세운다 */
function goalTimelineOf(
  state: GameState,
  result: NonNullable<MatchRecord["result"]>,
  ourSide: "home" | "away" | null,
): MatchReportEventView[] {
  const assists = result.assists ?? [];
  const minutes = result.goalMinutes ?? [];
  const origins = result.goalOrigins ?? [];
  return result.scorers.map((entry, i) => {
    const goal = parseScorerEntry(entry);
    const assist = parseScorerEntry(assists[i] ?? "");
    return {
      minute: minutes[i] ?? 0,
      type: "goal" as const,
      side: goal.side,
      ours: ourSide === null || goal.side === null ? null : goal.side === ourSide,
      actors: [
        playerName(state, goal.playerId),
        ...(assist.playerId ? [playerName(state, assist.playerId)] : []),
      ],
      origin: origins[i] ?? null,
      xg: null,
      causes: [],
      subCause: null,
    };
  });
}

/**
 * 끝난 경기 한 장을 세운다 — 결과가 없으면 null.
 *
 * 진행 중인 경기는 여기서 만들지 않는다: 90분 동안 감독이 보는 것은 판세 화면
 * (`buildMatchView`)이고, 그 화면은 장부를 직접 읽는다.
 */
export function buildMatchReport(state: GameState, matchId: string): MatchReportView | null {
  const match = state.matches.find((m) => m.id === matchId);
  const result = match?.result;
  if (!match || !result) return null;

  const ourSide: "home" | "away" | null =
    match.homeTeamId === state.userTeamId
      ? "home"
      : match.awayTeamId === state.userTeamId
        ? "away"
        : null;
  const events = result.events ?? [];
  const stats = result.playerStats ?? {};
  const lineups = { home: result.homeLineup ?? [], away: result.awayLineup ?? [] } as const;
  /**
   * **선발은 장부가 든다** — 킥오프에 뜬 명단이다 (`homeStarters` — people.md §5-2).
   * 사건 목록에서 「교체로 들어오지 않은 사람」으로 되짚는 것은 사건이 온전한 경기에만
   * 참이라, 사건을 남기지 않는 간이 시뮬의 경기는 벤치까지 선발로 읽힌다. 지위 대비
   * 출전을 재는 자와 리포트가 **같은 값**을 읽어야 감독이 본 선발과 라커룸이 센 선발이
   * 갈리지 않는다. 옛 장부에는 칸이 없어 그때만 사건으로 되짚는다.
   */
  const starters = { home: result.homeStarters, away: result.awayStarters } as const;
  const teamIdOf = { home: match.homeTeamId, away: match.awayTeamId } as const;
  const sideOfPlayer = new Map<string, "home" | "away">();
  for (const side of ["home", "away"] as const) {
    for (const id of lineups[side]) sideOfPlayer.set(id, side);
  }

  /**
   * 원인 태그를 문장으로 — 패킷은 이미 사라졌으므로 이름표를 상태에서 다시 세운다.
   * `packetTagContext`가 패킷에서 만드는 것과 같은 모양이다.
   */
  const tagCtx = {
    home: teamNameIn(state, match.homeTeamId),
    away: teamNameIn(state, match.awayTeamId),
    player: (id: string) => {
      const p = playerById(state, id);
      return p ? { name: p.name, position: naturalPositionOf(p).position } : undefined;
    },
  };

  const minutesOf = matchMinutesOf(events, result.aet === true);
  const countOf = (id: string, type: MatchEventType, slot = 0) =>
    events.filter((e) => e.type === type && e.actors[slot] === id).length;
  const cameOn = new Set(
    events.filter((e) => e.type === "substitution").map((e) => e.actors[1] ?? ""),
  );

  const players: MatchReportPlayerView[] = [];
  for (const side of ["home", "away"] as const) {
    for (const id of lineups[side]) {
      const p = playerById(state, id);
      const line = stats[id];
      const rating = result.ratings?.[id] ?? null;
      players.push({
        id,
        name: playerName(state, id),
        side,
        ours: teamIdOf[side] === state.userTeamId,
        squadNumber: p?.squadNumber ?? null,
        minutes: minutesOf(id),
        started: starters[side]?.includes(id) ?? !cameOn.has(id),
        goals: countOf(id, "goal"),
        assists: countOf(id, "goal", 1),
        shots: line?.shots ?? 0,
        xg: roundTo(line?.xg ?? 0, 2),
        saves: line?.saves ?? 0,
        passes: line?.passes ?? 0,
        progressive: line?.progressive ?? 0,
        corners: line?.corners ?? 0,
        fouls: line?.fouls ?? 0,
        yellows: countOf(id, "yellow_card"),
        red: countOf(id, "red_card") > 0,
        rating,
        tone: rating === null ? null : ratingTone(rating),
        note: result.ratingNotes?.[id] ?? null,
      });
    }
  }
  /** 선발이 먼저, 그다음 오래 뛴 순 — 리포트를 위에서부터 읽으면 그게 그 경기의 열한 명이다 */
  players.sort(
    (a, b) =>
      (a.side === b.side ? 0 : a.side === "home" ? -1 : 1) ||
      Number(b.started) - Number(a.started) ||
      b.minutes - a.minutes ||
      a.id.localeCompare(b.id),
  );

  const sumOf = (side: "home" | "away", read: (p: MatchReportPlayerView) => number) =>
    players.reduce((sum, p) => (p.side === side ? sum + read(p) : sum), 0);
  const teamOf = (side: "home" | "away"): MatchReportTeamView => ({
    name: teamNameIn(state, teamIdOf[side]),
    short: teamShortNameIn(state, teamIdOf[side]),
    ours: teamIdOf[side] === state.userTeamId,
    goals: side === "home" ? result.homeGoals : result.awayGoals,
    // 팀 합계는 마감이 이미 적어 두었다 — 옛 경기만 선수별 기록에서 다시 센다
    shots: (side === "home" ? result.homeShots : result.awayShots) ?? sumOf(side, (p) => p.shots),
    xg: roundTo((side === "home" ? result.homeXg : result.awayXg) ?? sumOf(side, (p) => p.xg), 2),
    expectedGoals: roundTo(
      (side === "home" ? result.homeExpectedGoals : result.awayExpectedGoals) ?? 0,
      2,
    ),
    possession: result.possession === undefined ? null : roundTo(result.possession[side], 3),
    passes: sumOf(side, (p) => p.passes),
    progressive: sumOf(side, (p) => p.progressive),
    corners: sumOf(side, (p) => p.corners),
    fouls: sumOf(side, (p) => p.fouls),
    yellows: sumOf(side, (p) => p.yellows),
    reds: sumOf(side, (p) => (p.red ? 1 : 0)),
  });

  const timeline: MatchReportEventView[] =
    events.length === 0
      ? goalTimelineOf(state, result, ourSide)
      : events
          .filter(
            (e) =>
              TIMELINE_TYPES.has(e.type) || (e.type === "shot" && (e.xg ?? 0) >= BIG_CHANCE_XG),
          )
          .map((e) => ({
            minute: e.minute,
            type: e.type,
            side: e.team ?? null,
            ours: ourSide === null || !e.team ? null : e.team === ourSide,
            actors: e.actors.map((id) => playerName(state, id)),
            origin: e.shotOrigin ?? null,
            xg: e.xg === undefined ? null : roundTo(e.xg, 2),
            causes: normalizeCauses(e.causes).map((tag) => packetTagText(tag, tagCtx)),
            subCause: e.subCause ? subCauseText(e.subCause) : null,
          }));

  const kicks = result.penalties?.kicks ?? [];
  const motm = motmOf(players);
  return {
    matchId: match.id,
    date: match.date,
    label: competitionLabel(match.competitionId, match.stage ?? "league", match.round),
    competition: competitionShortName(match.competitionId),
    stage: competitionStageLabel(match.competitionId, match.stage ?? "league", match.round),
    home: teamOf("home"),
    away: teamOf("away"),
    venue: ourSide === null ? null : match.neutral ? "neutral" : ourSide,
    outcome: ourSide === null ? null : outcomeFor(match, state.userTeamId),
    aet: result.aet === true,
    penalties: result.penalties
      ? {
          // 킥이 원본이라 합계도 거기서 센다 — 킥 없는 옛 승부차기만 저장된 합계를 쓴다
          ...(kicks.length > 0
            ? shootoutTally(kicks)
            : { home: result.penalties.home, away: result.penalties.away }),
          kicks: kicks.map((k) => ({
            round: k.round,
            side: k.team,
            team: teamShortNameIn(state, teamIdOf[k.team]),
            taker: playerName(state, k.taker),
            keeper: k.keeper ? playerName(state, k.keeper) : null,
            outcome: k.outcome,
            ours: teamIdOf[k.team] === state.userTeamId,
          })),
        }
      : null,
    timeline,
    players,
    motm: motm ? { id: motm.id, name: motm.name, rating: motm.rating ?? 0 } : null,
    hasDetail: events.length > 0,
  };
}
