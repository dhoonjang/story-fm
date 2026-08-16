import type {
  AssignmentRole,
  AxisValues,
  BoardPoint,
  LedgerEntry,
  MatchRecord,
  PacketPlayer,
  Foot,
  ScheduleType,
  SquadRegistration,
} from "@story-fm/domain";
import {
  ATTRIBUTE_AXES,
  AXIS_GROUPS,
  AXIS_GROUP_KO,
  AXIS_KO,
  FINANCE_CATEGORY_KO,
  TRAIN_ATTR_KO,
  ageOf,
  anchorOf,
  defaultRoleOf,
  naturalPositionOf,
  rolesFor,
  seasonRating,
  separateBoardPoints,
  slotOfTime,
} from "@story-fm/domain";
import { diffDays, nextMatchFor, seasonEndDate } from "../competition/calendar";
import { clubProfile } from "../data/club-profile";
import { tierOfTeamIn } from "../core/club-tier";
import {
  categoryOf,
  currentMonthSummary,
  formatMoney,
  isJournalMoney,
  monthOf,
  psrStatus,
  seasonWageRatio,
} from "../club/finance";
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
import { DOMESTIC_STAGES, domesticCupById } from "../data/domestic-cup-catalog";
import { domesticCupsOf } from "../competition/domestic-cup";
import { drawParts, drawTitle } from "../competition/draw-schedule";
import { euroCompetitionOf } from "../competition/europe";
import { formAngle, formLabel, formTone } from "../squad/form";
import { GAP_CONDITION, zoneGrid } from "@story-fm/sim";
import { moodOf } from "../squad/mood";
import { isHomegrownFor, occupiesSquadList, squadRegistrationOf } from "../squad/registration";
import {
  observationOf,
  observedFit,
  observedOverall,
  observedRating,
  knowledgeNote,
  observationMargin,
  potentialBand,
  ratingLabel,
  ratingTier,
  readCondition,
  scoutedAttributes,
  type ConditionRead,
  type Observation,
} from "../squad/scouting";
import type { ScoutGrade, ScoutReportCard } from "@story-fm/domain";
import { listingOf } from "../market/negotiation";
import { marketValueOf, wageExpectationOf } from "../market/market";
import { settlingPercent } from "../squad/settling";
import { computeStandings, type StandingRow } from "../competition/season";
import { RELEGATION_SLOTS, hasRelegation, leagueOfTeamIn } from "../competition/promotion";
import { isCupOnlyLeague } from "../data/league-catalog";
import {
  activeContract,
  activeSuspension,
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
  FAMILIARITY_BASELINE,
  tacticsOf,
  teamName,
  teamShortName,
  weeklyWagesOf,
  type GameState,
} from "../core/state";

/** 오피스 뷰 — 상태의 읽기 전용 프로젝션 (overview §2.4) */

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
    const label = g.target === "tactical" ? "전술" : (AXIS_KO[g.target as never] ?? g.target);
    const key = `${label} ${g.delta > 0 ? "+" : ""}${g.delta}`;
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
   * 명세가 무엇을 하나씩 세는지 — 묶인 엔트리가 모두 같은 `ref.type`일 때만.
   * 화면이 `45명`과 `2건`을 가르는 데 쓴다.
   */
  itemsRef?: "match" | "player" | "transfer" | "competition";
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
    refType: FinanceFeedRow["itemsRef"] | null;
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
      ...(refType ? { itemsRef: refType } : {}),
    };
  });
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

/** 스쿼드 행 = 메타 + 15축 (오피스 뷰는 우리 선수라 숫자를 그대로 준다) */
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
  potential: { low: number; high: number; margin: number } | null;
  squadLevel: "first" | "reserve";
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
  recentRatings: number[];
  /**
   * **체력** — 지금 이 선수의 상태 0~100 (몸과 마음이 한 축이다).
   * 왜 이 값인지는 `mood` 한 문장이 설명한다.
   */
  condition: number;
  /** 지금 심경 한 줄 — 코어 앵커(`describeMood`) 위에 결산이 다시 쓴 문장 (`moodOf`) */
  mood: string;
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
  seasonGoals: number;
  seasonApps: number;
  seasonAssists: number;
  /** 시즌 평균 평점 — 출전이 없으면 null (0.0과 "기록 없음"은 다르다) */
  seasonRating: number | null;
  hasIssue: boolean;
  /** 주급 (£/주) */
  weeklyWage: number;
  contractUntil: string | null;
  /** 현재 부상 (없으면 null) */
  injury: { bodyPart: string; severity: string; expectedReturn: string } | null;
  /** 출장 정지 잔여 경기 (0이면 정지 아님) */
  suspended: number;
  available: boolean;
}

/**
 * 달력 일지의 한 줄.
 *
 * 아이콘을 **문자열에 박지 않는다.** 예전엔 `"🏋️ 오전 훈련"`처럼 이모지를 앞에
 * 붙였는데, 그러면 ① 플랫폼마다 모양·너비가 달라 줄이 흔들리고 ② UI가 종류를 알 수
 * 없어 색·정렬로 구분할 방법이 없다. 종류는 데이터로 주고 그림은 화면이 그린다.
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
    | "money";
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
   * 여기서 조각을 주면 UI가 문자열을 잘라 쓰지 않아도 된다
   * (예전엔 `title.replace(/^R\d+\s/, "")` 같은 정규식으로 도려냈다).
   */
  match: {
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
  /** 순위 구역 — 챔스·유로파 진출권(리그) 또는 본선 직행·플레이오프(대항전) */
  zones: StandingZone[];
  /** 우리 순위 (0 = 순위표에 없음) */
  userPosition: number;
  /** 이 대회의 다음 우리 경기 요약 */
  next: string | null;
  rounds: CompetitionRoundView[];
  /** 녹아웃 단계별 대진 — 리그는 빈 배열 */
  bracket: BracketStageView[];
  /** 대항전 전용 — 리그 페이즈 통과 경계선 */
  europe: EuropeView | null;
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

/** 경기 중 한 선수 — 지금 내는 전력과 남은 다리 */
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
}

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
  /** 존별 전력 — 막대로 견준다 */
  zones: {
    zone: "attack" | "midfield" | "defense";
    label: string;
    home: number;
    away: number;
    edge: "home" | "away" | "even";
    size: string;
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
  /** 양팀 전술 6축 + 소화율 */
  tactics: {
    home: TacticsView & { uptake: number; notes: string[] };
    away: TacticsView & { uptake: number; notes: string[] };
  };
  onPitch: { home: MatchPlayerView[]; away: MatchPlayerView[] };
  bench: { home: MatchPlayerView[]; away: MatchPlayerView[] };
  subs: { home: { used: number; windows: number }; away: { used: number; windows: number } };
  sentOff: string[];
}

export interface OfficeViews {
  /** 경기 중에만 채워진다 — 그 밖에는 null */
  match: MatchView | null;
  squad: {
    manager: {
      name: string;
      background: string;
      attributes: Record<string, number>;
      reputation: Record<string, number>;
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
    boardExpectation: string;
    stadium: { name: string; capacity: number };
    /** 급여 비중 — **시즌 누계** (급여 ÷ 매출). 한 달만 보면 프리시즌에 튄다 */
    wageRatio: number;
    psr: { rolling3Season: number; headroom: number } | null;
    /** 진행 중인 이번 달 잠정 집계 */
    current: FinanceMonthView;
    /** 마감된 월간 보고서 — 최신 순 */
    reports: FinanceMonthView[];
    /** 실시간 재정 활동 — 최근 원장을 접은 줄 (최신 순, docs/simulation/finance.md §8.1) */
    feed: FinanceFeedRow[];
  };
  /** 대회 — 우리 리그 + 우리 대항전. 대회별 순위표와 일정이 한 자리에 (§2.4) */
  competitions: {
    /** 대회 무관 — 다음 경기 한 줄 요약 */
    next: string | null;
    /**
     * **우리 팀의 당장 다음 경기** — 경기 중에는 달력 대신 이것만 본다.
     *
     * 한 줄 문자열(`next`)과 나란히 두는 이유: 화면이 날짜·상대·홈원정을 각자
     * 배치하려면 조각이 필요하고, 무엇보다 **며칠 남았는지**가 있어야 한다.
     * 체력이 자리마다 다르게 깎이고 회복이 며칠에 걸리는 지금(match-sim §2.1.1),
     * "사흘 뒤"인지 "엿새 뒤"인지가 곧 로테이션 판단이다.
     */
    nextMatch: {
      date: string;
      /** 킥오프 시각 `20:00` */
      time: string;
      /** 대회 + 단계 (`프리미어리그 R2`) */
      label: string;
      /** 상대 팀 이름 (풀네임) */
      opponent: string;
      venue: "home" | "away" | "neutral";
      /** 오늘로부터 며칠 뒤인가 — 0이면 오늘이다 */
      inDays: number;
    } | null;
    recentResults: string[];
    /** 탭 순서: 우리 리그 → 우리 대항전 */
    list: CompetitionView[];
  };
  career: {
    trophies: Array<{ competition: string; season: number; teamName: string }>;
    achievements: Array<{ name: string; description: string; season: number }>;
    seasons: Array<{
      season: number;
      teamName: string;
      position: number;
      record: string;
      boardVerdict: string;
    }>;
  };
  transfers: {
    recent: Array<{
      date: string;
      type: string;
      playerName: string;
      from: string | null;
      to: string | null;
      fee: number;
      note: string | null;
    }>;
  };
}

const ROLE_KO: Record<AssignmentRole, "선발" | "벤치"> = { starting: "선발", bench: "벤치" };
const SEVERITY_KO: Record<string, string> = { minor: "경상", moderate: "중상", major: "장기" };

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
      const pair = /-p(\d+)-/.exec(m.id)?.[1] ?? "0";
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
      return { date: decider.date, home: teamName(home), away: teamName(away), score, ours, won };
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

/** 우리 경기의 승패 — 승부차기가 있으면 그것이 결론이다 */
function outcomeFor(state: GameState, match: MatchRecord): "W" | "D" | "L" | null {
  const home = match.homeTeamId === state.userTeamId;
  if (!match.result || (!home && match.awayTeamId !== state.userTeamId)) return null;
  const { homeGoals, awayGoals, penalties } = match.result;
  const mine = home ? homeGoals : awayGoals;
  const theirs = home ? awayGoals : homeGoals;
  if (mine !== theirs) return mine > theirs ? "W" : "L";
  if (penalties) {
    const myPens = home ? penalties.home : penalties.away;
    const theirPens = home ? penalties.away : penalties.home;
    if (myPens !== theirPens) return myPens > theirPens ? "W" : "L";
  }
  return "D";
}

/**
 * 최근 경기 평점 — 폼의 시간 축.
 *
 * 폼 숫자 하나로는 "지금 오르는 중인지 식는 중인지"를 알 수 없다. 평점은 이미
 * 경기별로 남아 있으므로(`MATCH.result.ratings`, 유저 팀 경기만) 날짜순으로
 * 훑어 마지막 다섯 개를 준다 — 화면이 추이를 그릴 수 있다.
 */
function recentRatingsOf(state: GameState, playerId: string, limit = 5): number[] {
  const rated = state.matches
    .filter((m) => m.result?.ratings?.[playerId] !== undefined)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rated.slice(-limit).map((m) => m.result!.ratings![playerId]!);
}

/**
 * 존 라벨 — **왼쪽이 언제나 홈**이다. 막대도 왼쪽이 홈이라 라벨과 그림이 어긋나면
 * 어느 쪽이 이기는지 거꾸로 읽힌다.
 */
const ZONE_KO: Record<"attack" | "midfield" | "defense", string> = {
  attack: "홈 공격 → 어웨이 수비",
  midfield: "중원",
  defense: "홈 수비 ← 어웨이 공격",
};

const EDGE_SIZE_KO: Record<string, string> = {
  slight: "근소",
  clear: "뚜렷",
  big: "압도적",
};
const MATCH_PHASE_KO: Record<string, string> = {
  first_half: "전반",
  second_half: "후반",
  extra_first: "연장 전반",
  extra_second: "연장 후반",
  finished: "종료",
};

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
  const packet = pending.packet;
  if (!match || !packet) return null;

  const ledger = pending.ledger;
  const worn = pending.matchFatigue ?? {};

  /**
   * 선수별 기록 — 사건 목록을 한 번 훑어 접는다. 저장하지 않는 이유는 원본이
   * `ledger.events`이기 때문이다: 두 벌로 두면 조용히 갈린다.
   */
  const tallies = new Map<string, MatchTally>();
  const tallyOf = (id: string): MatchTally => {
    const found = tallies.get(id);
    if (found) return found;
    const fresh: MatchTally = {
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
    };
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
    // 경기 중 소모(worn)를 저장된 체력에서 뺀 지금 값 — 화면과 시뮬이 같은 축을 본다
    const drain = worn[entry.id] ?? 0;
    const truth = Math.max(0, (p?.state.condition ?? 0) - drain);
    // 다리는 눈으로 읽는다 — 코어는 참값으로 계산하고 여기서만 흐려진다.
    // 뛴 만큼 폭이 벌어지므로 소모량을 함께 넘긴다
    const condition = readCondition(state, entry.id, truth, drain, match.id);
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
      tally: tallies.get(entry.id) ?? {
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
      },
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

  const tacticsOfSide = (teamId: string, tactical: { uptake: number; notes: string[] }) => ({
    ...(teamId !== state.userTeamId && pending.aiTactics
      ? pending.aiTactics
      : tacticsOf(state, teamId).spec),
    uptake: tactical.uptake,
    notes: tactical.notes,
  });

  return {
    matchId: match.id,
    competition: competitionShortName(match.competitionId),
    stage: competitionStageLabel(match.competitionId, match.stage ?? "league", match.round),
    home: {
      name: teamName(match.homeTeamId),
      short: teamShortName(match.homeTeamId),
      ours: match.homeTeamId === state.userTeamId,
    },
    away: {
      name: teamName(match.awayTeamId),
      short: teamShortName(match.awayTeamId),
      ours: match.awayTeamId === state.userTeamId,
    },
    score: { ...ledger.score },
    minute: ledger.minute,
    phase: MATCH_PHASE_KO[ledger.phase] ?? ledger.phase,
    beforeKickoff: pending.entered !== true,
    /**
     * 매치업은 **맞붙는 두 값**을 견준다 — 공격 존은 우리 공격 대 상대 **수비**다.
     * 같은 존끼리 비교하면(공격 vs 공격) 아무 뜻이 없다.
     */
    zones: packet.matchups.map((m) => ({
      zone: m.zone,
      label: ZONE_KO[m.zone],
      home:
        m.zone === "attack"
          ? packet.home.zones.attack
          : m.zone === "midfield"
            ? packet.home.zones.midfield
            : packet.home.zones.defense,
      away:
        m.zone === "attack"
          ? packet.away.zones.defense
          : m.zone === "midfield"
            ? packet.away.zones.midfield
            : packet.away.zones.attack,
      edge: m.edge,
      size: EDGE_SIZE_KO[m.size] ?? m.size,
    })),
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
      return {
        band: c.band,
        lane: c.lane,
        ours: weAreHome ? c.home : c.away,
        theirs: weAreHome ? c.away : c.home,
      };
    }),
    /**
     * 유불리는 **우리 편 기준**으로 접어서 넘긴다 — 화면이 홈/원정 중 어느 쪽이
     * 우리인지 다시 따지지 않아도 되게. 편을 모르는 옛 세이브는 `null`이다.
     */
    keyPoints: packet.keyPoints.map((text, i) => {
      const favours = packet.keyPointSides?.[i];
      const ourSide = match.homeTeamId === state.userTeamId ? "home" : "away";
      return { text, ours: favours === undefined ? null : favours === ourSide };
    }),
    exploiting: (pending.exploits ?? [])
      .map((id) => packet.targets.find((t) => t.id === id)?.label)
      .filter((x): x is string => x !== undefined),
    tactics: {
      home: tacticsOfSide(match.homeTeamId, packet.home.tactical),
      away: tacticsOfSide(match.awayTeamId, packet.away.tactical),
    },
    onPitch: {
      home: rowsOf(packet.home.lineup, ledger.home.onPitch, match.homeTeamId),
      away: rowsOf(packet.away.lineup, ledger.away.onPitch, match.awayTeamId),
    },
    bench: {
      home: rowsOf(packet.home.bench, ledger.home.bench, match.homeTeamId),
      away: rowsOf(packet.away.bench, ledger.away.bench, match.awayTeamId),
    },
    subs: {
      home: { used: ledger.home.subsUsed, windows: ledger.home.subWindows },
      away: { used: ledger.away.subsUsed, windows: ledger.away.subWindows },
    },
    sentOff: ledger.sentOff.map((id) => playerName(state, id)),
  };
}

/**
 * 대회 하나의 뷰 — 순위표 + 라운드별 일정.
 *
 * 라운드 묶음은 `(stage, round)`로 만든다. 리그는 stage가 없어 `R3`이 곧 라운드고,
 * 대항전은 리그 페이즈(R1~8) 뒤에 2차전제 녹아웃 단계가 붙는다. `current`는 오늘
 * 이후 첫 라운드(전부 끝났으면 마지막)로, UI가 여기서부터 보여준다.
 */
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
  const grouped = new Map<string, CompetitionRoundView>();
  for (const m of matches) {
    const stage = m.stage ?? "league";
    const key = `${stage}:${m.round}`;
    const label = cup
      ? stage === "league"
        ? `리그 페이즈 ${m.round}R`
        : competitionStageLabel(competitionId, stage, m.round)
      : `${m.round}라운드`;
    const round = grouped.get(key) ?? { key, label, date: m.date, matches: [], current: false };
    round.matches.push({
      id: m.id,
      date: m.date,
      time: m.time ?? "15:00",
      homeName: teamName(m.homeTeamId),
      awayName: teamName(m.awayTeamId),
      homeShort: teamShortName(m.homeTeamId),
      awayShort: teamShortName(m.awayTeamId),
      score: scoreOf(m),
      ours: m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId,
      win: outcomeFor(state, m),
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
  const nextOurs = matches.find(
    (m) => !m.result && (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
  );
  return {
    id: competitionId,
    name: competitionName(competitionId),
    short: competitionShortName(competitionId),
    kind: cup ? "cup" : "league",
    standings,
    zones: buildStandingZones(state, competitionId, standings.length),
    userPosition: standings.findIndex((r) => r.teamId === state.userTeamId) + 1,
    next: nextOurs
      ? `${nextOurs.date} ${nextOurs.neutral ? "중립" : nextOurs.homeTeamId === state.userTeamId ? "홈" : "원정"} vs ${teamName(nextOurs.homeTeamId === state.userTeamId ? nextOurs.awayTeamId : nextOurs.homeTeamId)}`
      : null,
    rounds,
    bracket: cup ? buildBracket(state, competitionId) : [],
    // 통과 경계선은 리그 페이즈가 있는 대항전에만 있다 (국내 컵은 순위표가 없다)
    europe: isEuroCup(competitionId) ? buildEuropeView(state, competitionId) : null,
  };
}

export function buildOfficeViews(state: GameState): OfficeViews {
  const userTeamId = state.userTeamId;
  const squad = playersOf(state, userTeamId);
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

  // 선발의 전술판 좌표 — 좌표 없는 배치(구 세이브·채팅 지시)는 코드 기본 좌표로 그리는데,
  // 같은 코드가 둘이면 정확히 같은 점이 되므로 겹침을 풀어 준다. 저장하면 이 좌표가
  // 그대로 기록되어(setLineup) 다음 로드부터는 안정된다.
  const starters = tactics.assignments.filter((a) => a.role === "starting");
  const starterPoints = separateBoardPoints(starters.map((a) => a.point ?? anchorOf(a.position)));
  const pointOf = new Map(starters.map((a, i) => [a.playerId, starterPoints[i]!] as const));

  const roleRank: Record<SquadViewRow["role"], number> = { 선발: 0, 벤치: 1, 스쿼드: 2 };
  const players: SquadViewRow[] = squad
    .map((p) => {
      const assignment = assignments.get(p.id);
      const liveSlot = liveSlots.get(p.id);
      const injury = openInjury(state, p.id);
      const suspension = activeSuspension(state, p.id);
      const contract = activeContract(state, p.id);
      const stat = seasonStatOf(state, p.id);
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
      const assignedRoleId = slotted
        ? (liveSlot?.entry.roleId ?? assignment?.roleId)
        : undefined;
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
         * 예전엔 "자리 묶음이 주 포지션과 다를 때"만 냈다. 그러면 센터백이 센터백
         * 자리에 선 채로 **역할만 바꿨을 때** 화면의 숫자가 꿈쩍도 하지 않는다 —
         * 볼 플레잉 디펜더와 노넌센스는 요구 역량이 다른데도. 자리든 역할이든
         * 기본과 달라지면 그 값을 보여주는 게 맞다.
         */
        slotOverall: slotValue !== null && slotValue !== shownOverall ? slotValue : null,
        // 오피스는 우리 선수의 숫자를 그대로 보여준다 (결정 #2). 단 **적응 중인 새
        // 영입**은 스카우트 수준의 오차가 남는다 — 훈련장에서 본 게 전부다.
        ...observed,
        potential: potentialBand(state, p),
        homegrown: isHomegrownFor(p, userTeamId),
        foot: p.foot ?? { left: 3, right: 3 },
        height: p.height ?? null,
        weight: p.weight ?? null,
        occupiesList: occupiesSquadList(state, p),
        settling: settlingPercent(state, p.id),
        transferListed: listingOf(state, p.id)?.askingPrice ?? null,
        squadLevel: squadLevelOf(p),
        form: Math.round(p.state.form * 100) / 100,
        formLabel: formLabel(p.state.form),
        formAngle: formAngle(p.state.form),
        formTone: formTone(p.state.form),
        recentRatings: recentRatingsOf(state, p.id),
        condition: p.state.condition,
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
        familiarity: Math.round(assignment?.familiarity ?? 60),
        familiarityIfSlotted: Math.round(assignment?.familiarity ?? ifSlotted(p.id)),
        positionFit: proficiencyAt(p, assignedSlot ?? natural.position),
        adaptation: adaptationOf(
          proficiencyAt(p, assignedSlot ?? natural.position),
          assignment?.familiarity ?? FAMILIARITY_BASELINE,
          assignedSlot ?? natural.position,
        ),
        instruction: assignment?.instruction ?? null,
        isCaptain: p.isCaptain,
        seasonGoals: stat?.goals ?? 0,
        seasonApps: stat?.apps ?? 0,
        seasonAssists: stat?.assists ?? 0,
        seasonRating: seasonRating(stat),
        hasIssue: issues.has(p.id),
        weeklyWage: contract?.weeklyWage ?? 0,
        contractUntil: contract?.until ?? null,
        injury: injury
          ? {
              bodyPart: injury.bodyPart,
              severity: SEVERITY_KO[injury.severity] ?? injury.severity,
              expectedReturn: injury.expectedReturn,
            }
          : null,
        suspended: suspension ? suspension.lengthMatches - suspension.served : 0,
        available: !injury && !suspension,
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
        const opponent = teamName(home ? m.awayTeamId : m.homeTeamId);
        let result: string | null = null;
        let win: CalendarEntryView["win"] = null;
        let detail: string | null = null;
        if (m.result) {
          const my = home ? m.result.homeGoals : m.result.awayGoals;
          const their = home ? m.result.awayGoals : m.result.homeGoals;
          // 승부차기로 갈린 컵 경기를 "무"로 칠하면 안 된다 — 그 날 우리는
          // 이겼거나 떨어졌다 (`outcomeFor`와 같은 규칙)
          win = outcomeFor(state, m);
          const pens = m.result.penalties;
          const pensLabel = pens
            ? ` (승부차기 ${home ? pens.home : pens.away}-${home ? pens.away : pens.home})`
            : "";
          result = `${my}-${their}${pensLabel} ${win === "W" ? "승" : win === "L" ? "패" : "무"}`;
          const mySide = home ? "home" : "away";
          /**
           * 득점자 — **도움까지 함께 읽는다.** 장부는 골의 68%에 도움을 붙이는데
           * 결과에 안 남기던 때는 "어시스트가 기록되지 않는다"로 보였다
           * (`MatchResult.assists` — 득점자와 같은 순서, 없는 골은 빈 칸).
           */
          const assistIds = m.result.assists ?? [];
          const minutes = m.result.goalMinutes ?? [];
          const scorers = (m.result.scorers ?? []).map((s, i) => {
            const [sSide, id] = s.includes(":") ? (s.split(":", 2) as [string, string]) : ["", s];
            const name = playerName(state, id ?? s);
            const rawAssist = assistIds[i] ?? "";
            const assistId = rawAssist.includes(":") ? rawAssist.split(":", 2)[1] : rawAssist;
            const withAssist = assistId ? `${name} (${playerName(state, assistId)})` : name;
            // 분이 붙으면 스코어가 이야기가 된다 — 87분 동점골과 5분 선제골은 다르다
            const at = minutes[i] !== undefined ? `${withAssist} ${minutes[i]}′` : withAssist;
            return sSide === mySide || sSide === "" ? at : `${at} (상대)`;
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
            // 리그 경기는 이름을 생략한다(감독은 자기 리그를 안다). 컵과 친선은
            // 어느 경기인지가 곧 정보다
            competition: cup || isFriendly(m) ? competitionShortName(m.competitionId) : null,
            // 친선은 단계가 없어 빈 문자열이다 — 화면이 빈 칩을 그리지 않는다
            stage,
            opponent: teamShortName(home ? m.awayTeamId : m.homeTeamId),
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
  const ourPlayers = new Set(squad.map((p) => p.id));
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
   * 성장은 **날짜별로 묶는다** — 전술 훈련 한 번에 스무 줄이 나온다. 일지에 그대로
   * 펼치면 그날 있었던 다른 일(부상·경고·이적)이 스크롤 밖으로 밀린다.
   * 요약 한 줄만 세우고 명단은 접어 둔다.
   */
  const growthByDate = new Map<string, { counts: Map<string, number>; lines: string[] }>();
  for (const g of state.growthLog) {
    if (!ourPlayers.has(g.gamePlayerId)) continue;
    const label = g.target.startsWith("pos:")
      ? `${g.target.slice(4)} 적응도`
      : g.target === "tactical"
        ? "전술 적응도"
        : (AXIS_KO[g.target as never] ?? g.target);
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
  for (const inj of state.injuries) {
    if (!ourPlayers.has(inj.gamePlayerId)) continue;
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
    if (!ourPlayers.has(b.gamePlayerId)) continue;
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
  for (const r of state.financeReports) {
    if (r.teamId !== userTeamId) continue;
    // highlights는 마감 때 이미 걸러진 것이라 문턱을 다시 재지 않는다
    for (const h of r.highlights ?? []) {
      if (h.date > state.date) continue;
      push(h.date, { kind: "money", text: moneyText(h) });
    }
  }

  // ── 재정 (유저 팀) ──
  const line = (l: { category: string; amount: number }) => ({
    category: l.category,
    label: FINANCE_CATEGORY_KO[l.category as keyof typeof FINANCE_CATEGORY_KO] ?? l.category,
    amount: l.amount,
  });
  const reports: FinanceMonthView[] = [...state.financeReports]
    .filter((r) => r.teamId === userTeamId)
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
      notes: r.notes,
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
    notes: [],
  };
  // 실시간 활동 피드 — 접은 뒤 최근 30줄 (§8.1). 자르고 접으면 접기 전과 같아진다
  const feed = foldFinanceFeed(finance.ledger);
  const stadium = clubProfile(userTeamId, tierOfTeamIn(state, userTeamId));

  const recentResults = state.matches
    .filter((m) => m.result && (m.homeTeamId === userTeamId || m.awayTeamId === userTeamId))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-5)
    .map(
      (m) =>
        `${fixtureLabel(m.competitionId, m.stage ?? "league", m.round)} ${teamShortName(m.homeTeamId)} ${m.result?.homeGoals}-${m.result?.awayGoals} ${teamShortName(m.awayTeamId)}${m.result?.penalties ? ` (승부차기 ${m.result.penalties.home}-${m.result.penalties.away})` : ""}`,
    );

  const lastRecord = state.seasonRecords[state.seasonRecords.length - 1];

  return {
    match: buildMatchView(state),
    squad: {
      manager: {
        name: state.manager.name,
        background: state.manager.background,
        attributes: { ...state.manager.attributes },
        reputation: { ...state.manager.reputation },
      },
      players,
      formation: tactics.spec.formation,
      tactics: { ...tactics.spec },
      familiarity: Math.round(squadFamiliarity(state, userTeamId)),
      editable: state.phase !== "match",
      firstTeamCount: players.filter((p) => p.squadLevel === "first").length,
      reserveCount: players.filter((p) => p.squadLevel === "reserve").length,
      registration: squadRegistrationOf(state, userTeamId),
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
      boardExpectation: lastRecord?.boardVerdict ?? "시즌 목표 달성",
      stadium: { name: stadium.stadium, capacity: stadium.capacity },
      // 시즌 누계 기준 — 한 달만 보면 프리시즌에 100%를 넘어 무의미하다
      wageRatio: seasonWageRatio(state),
      psr: state.financeReports.length > 0 ? psrStatus(state) : null,
      current,
      reports,
      feed,
    },
    competitions: {
      next: next
        ? `${fixtureLabel(next.competitionId, next.stage ?? "league", next.round)} ${next.date} ${next.neutral ? "중립" : next.homeTeamId === userTeamId ? "홈" : "원정"} vs ${teamName(next.homeTeamId === userTeamId ? next.awayTeamId : next.homeTeamId)}`
        : null,
      nextMatch: next
        ? {
            date: next.date,
            time: next.time ?? "15:00",
            // 대회 이름을 **언제나** 붙인다 — 이 카드 하나가 유일한 일정 정보라
            // "R2"만 적으면 무슨 대회의 2라운드인지 화면 어디에도 없다
            label: competitionLabel(next.competitionId, next.stage ?? "league", next.round),
            opponent: teamName(next.homeTeamId === userTeamId ? next.awayTeamId : next.homeTeamId),
            venue: next.neutral ? "neutral" : next.homeTeamId === userTeamId ? "home" : "away",
            inDays: Math.max(0, diffDays(state.date, next.date)),
          }
        : null,
      recentResults,
      list: competitionList,
    },
    career: {
      trophies: state.trophies.map((t) => ({
        competition: t.competition,
        season: t.season,
        teamName: teamName(t.teamId),
      })),
      achievements: state.achievements.map(({ name, description, season }) => ({
        name,
        description,
        season,
      })),
      seasons: state.seasonRecords.map((s) => ({
        season: s.season,
        teamName: teamName(s.teamId),
        position: s.position,
        record: `${s.wins}승 ${s.draws}무 ${s.losses}패`,
        boardVerdict: s.boardVerdict,
      })),
    },
    transfers: {
      recent: state.transfers
        .filter((t) => t.fromTeamId === userTeamId || t.toTeamId === userTeamId)
        .slice(-20)
        .reverse()
        .map((t) => ({
          date: t.date,
          type: t.type,
          playerName: playerName(state, t.gamePlayerId),
          from: t.fromTeamId ? teamName(t.fromTeamId) : null,
          to: t.toTeamId ? teamName(t.toTeamId) : null,
          fee: t.fee,
          note: t.note ?? null,
        })),
    },
  };
}

export { assignmentsOf };

// ── 스카우팅 보고서 — 채팅이 카드로 그린다 ──────────────

/**
 * 스카우트가 가져온 **보고서 한 장**.
 *
 * 예전엔 "스카우트 보고서 도착: 홀란 — 능력치를 정확히 파악했다" 한 줄이
 * 다이제스트에 묻혀 화면에 아예 뜨지 않았다. 며칠을 기다려 얻은 정보인데
 * 감독은 그걸 보러 선수 검색을 다시 해야 했다.
 *
 * **한 번 읽고 넘어갈 정보가 아니다** — 능력치 15축·주발·잠재력 구간·몸값이
 * 한자리에 있어야 "지금 지를까, 더 볼까"가 판단된다. 그래서 카드다.
 */

/** 보고서 한 장을 조립한다 — 안개는 `observedRating`이 이미 씌운다 */
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
    team: teamName(p.teamId),
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
