import type {
  AttributeAxis,
  ReserveTrainingPolicy,
  ScheduleEntry,
  Slot,
  TrainAttr,
  TrainingSession,
} from "@story-fm/domain";
import { ATTRIBUTE_AXES, SLOT_TIME, attributeAxisOf, isReserveMatch } from "@story-fm/domain";
import { addDays, dayOfWeek, diffDays, sortEntries, squadReturnOf } from "../competition/calendar";
import type { GameState } from "../core/state";

/**
 * 기본 훈련 — 달력에 깔려 있는 **보편적인 주간 리듬**.
 *
 * 어느 구단이나 도는 사이클이라 감독이 아무 지시도 하지 않아도 팀은 훈련한다
 * (season.md §4 "기본 훈련 — 달력에 미리 깔린다"). 실제 프로 구단의
 * 마이크로사이클(MD 표기)을 그대로 옮겼다:
 *
 *   MD+1 회복 · MD+2 **완전 휴식** · MD-2 전술 · MD-1 짧고 날카롭게 · 그 외 본훈련
 *
 * MD+2를 쉬는 건 취향이 아니라 근거다 — MD+2 휴식은 다른 배치보다 비접촉 부상률이
 * 2~3배 낮다(Buchheit 외, 마이크로사이클 주기화). 그래서 주중 경기가 끼면 본훈련이
 * 저절로 사라지고 회복·전술만 남는다. 연전 예외를 따로 두지 않아도 일정이 조절된다.
 *
 * 쉬는 날도 규칙의 일부다:
 *   - **여름 휴가** — 7월 1일 게임 시작 시점엔 선수단이 아직 쉬고 있다. 실제 EPL
 *     클럽의 복귀는 7월 초~중순이라, 나흘 넘게 지난 첫 월요일에 소집한다.
 *   - **주말 이틀 오프** — 경기가 없는 주는 평일 5일만 훈련한다("5일 연속 훈련 후
 *     오프"가 프리시즌 캠프의 표준이고, 시즌 중 주당 훈련도 5~6일이다).
 *
 * **능력치를 겨냥한 focus는 본훈련에만 둔다.** 경기 전후 세션까지 축을 얹으면 특정
 * 축(킥·위치선정)만 매주 반복돼 성장이 그쪽으로 쏠린다. 본훈련은 메뉴를 순환시켜
 * 16축을 골고루 훑는다.
 *
 * 두 가지 불변식으로 감독의 지시를 지킨다:
 *   ① 이미 훈련이 있는 슬롯은 건드리지 않는다 (감독 지시가 이긴다)
 *   ② 배치는 **날짜만으로 결정**된다 — 몇 번을 다시 깔아도 같은 결과다
 */

/**
 * 기본 배치가 한 주에 깔아 두는 **세션 수**.
 *
 * 경기가 없는 주는 평일 다섯(주말 이틀 오프), 경기가 낀 주는 회복(MD+1) ·
 * 본훈련 · 전술(MD−2) · 경기 준비(MD−1)에 MD+2 휴식과 경기일이 빠져 역시 다섯이다
 * — `planFor`의 분기를 한 주에 걸쳐 세면 나오는 수다.
 *
 * 훈련 결산이 이 수를 읽는다: 판정의 눈금은 **한 주치**이고, 코어가 반영할 때
 * `그 구간의 세션 수 ÷ 이 값`을 곱해 폭을 접는다. 그러지 않으면 성장 속도가
 * 훈련의 양이 아니라 감독이 턴을 몇 번 쳤는가로 정해진다
 * (`squad/training-report.ts` · docs/simulation/season.md §4).
 */
export const SESSIONS_PER_WEEK = 5;

/**
 * 메뉴 항목 — **id가 이 항목의 정체다.** 한국어 이름은 감독이 읽는 표시일 뿐이라
 * 문구를 고쳐도 대조(`syncDefaultTraining`)가 흔들리면 안 된다 (season.md §4).
 */
interface MenuItem {
  menuId: string;
  label: string;
  focus: TrainAttr[];
}

interface SessionPlan extends MenuItem {
  slot: Slot;
}

/**
 * 본훈련 메뉴 — 순환하며 16축을 모두 훑는다. 요일 고정이 아닌 이유는, 경기 전후를
 * 걷어내고 나면 주에 두어 번밖에 남지 않아 요일로 묶으면 같은 축만 계속 훈련하게
 * 되기 때문이다. 10개라 7일 주기와 서로소여서 돌아 요일 편중도 없다.
 *
 * 넷은 한 축만 겨냥한다 — 10개가 모두 2축이면 네 축이 중복돼 그쪽만 빨리 자란다.
 *
 * **나열 순서에도 뜻이 있다.** 본훈련이 잡히는 날은 경기 일정이 정하므로 순환이
 * 고르게 돌지 않고, 한 자리는 시즌 내내 손에 꼽게 걸린다. 거기에는 프리시즌 기초
 * 체력기가 따로 채워 주는 체력 메뉴를 둔다 — 다른 축을 두면 그 축만 얇아진다
 * (`training-plan.test.ts`가 축별 최소 횟수로 못 박는다).
 */
const GENERAL_MENU: ReadonlyArray<MenuItem> = [
  {
    menuId: "general-possession",
    label: "볼 소유 — 론도·짧은 패스 연결",
    focus: ["passing", "vision"],
  },
  {
    menuId: "general-finishing",
    label: "마무리 훈련 — 박스 안 슈팅 반복",
    focus: ["finishing", "composure"],
  },
  {
    menuId: "general-defending",
    label: "수비 조직 — 라인 간격·커버",
    focus: ["tackling", "positioning"],
  },
  {
    menuId: "general-transition",
    label: "스피드·전환 — 역습 상황 반복",
    focus: ["pace", "dribbling"],
  },
  {
    menuId: "general-set-piece",
    label: "세트피스·제공권 — 코너·프리킥",
    focus: ["kicking", "aerial"],
  },
  { menuId: "general-pressing", label: "압박 강도 — 전방 압박 트리거", focus: ["aggression"] },
  {
    menuId: "general-conditioning",
    label: "체력 강화 — 인터벌 러닝·웨이트",
    focus: ["stamina", "strength"],
  },
  {
    menuId: "general-goalkeeping",
    label: "GK 전담 — 슈팅 스톱·크로스 대응",
    focus: ["goalkeeping"],
  },
  { menuId: "general-team-building", label: "팀 빌딩 — 소통·리더십 세션", focus: ["leadership"] },
  {
    menuId: "general-off-the-ball",
    label: "오프더볼 — 뒷공간 침투·마킹 이탈",
    focus: ["offTheBall"],
  },
];

/**
 * **복귀 주** — 소집 첫 주(월~금)는 훈련이 아니라 검사로 시작한다.
 *
 * 실제 클럽의 첫날은 메디컬과 체력 측정이고, 친선경기는 그다음 주부터다. 요일에
 * 하나씩 고정 배치하므로(소집일이 늘 월요일) 첫날은 반드시 메디컬이다.
 * 강도를 올리지 않는 주라 이중 세션도 없다.
 */
const RETURN_WEEK: ReadonlyArray<MenuItem> = [
  { menuId: "return-medical", label: "복귀 메디컬 — 신체 검사·체력 측정", focus: ["recovery"] },
  { menuId: "return-running", label: "가벼운 러닝 — 유산소 되찾기", focus: ["stamina"] },
  { menuId: "return-ball-feel", label: "볼 감각 회복 — 짧은 패스·터치", focus: ["passing"] },
  { menuId: "return-strength", label: "근력 재개 — 저강도 웨이트", focus: ["strength"] },
  { menuId: "return-fitness-test", label: "체력 테스트 — 요요 인터벌", focus: ["stamina"] },
];

/**
 * 프리시즌 **기초 체력기** 메뉴 — 복귀 주가 끝난 뒤 2주.
 *
 * 이 시기의 훈련장은 전술판이 아니라 러닝 트랙과 웨이트룸이다. 신체 4축
 * (지구력·몸싸움·스피드·공중볼)에만 집중하는 건 그래서고, 이중 세션도 이 구간에만
 * 둔다 — 실제 캠프도 강도를 앞에 싣고 개막이 가까울수록 전술로 옮겨 간다.
 */
const PRESEASON_BASE: ReadonlyArray<MenuItem> = [
  { menuId: "base-endurance", label: "기초 체력 — 장거리 러닝·유산소", focus: ["stamina"] },
  { menuId: "base-strength", label: "근력 서킷 — 웨이트룸", focus: ["strength"] },
  { menuId: "base-sprint", label: "스프린트·가속 — 반복 질주", focus: ["pace"] },
  { menuId: "base-duel", label: "경합 훈련 — 몸싸움·제공권", focus: ["aerial"] },
];

/** 복귀 주의 마지막 날 (소집일 = 월요일 기준 금요일) */
const RETURN_WEEK_DAYS = 4;
/** 기초 체력기의 마지막 날 — 복귀 주 다음 2주 */
const BUILD_UP_DAYS = 18;

const RECOVERY: SessionPlan = {
  slot: "am",
  menuId: "recovery",
  label: "회복 세션 — 가벼운 러닝·마사지",
  focus: ["recovery"],
};
const TACTICAL_DRILL: SessionPlan = {
  slot: "am",
  menuId: "tactical-drill",
  label: "전술 훈련 — 대형·압박 라인 점검",
  focus: ["tactical"],
};
const MATCH_PREP: SessionPlan = {
  slot: "am",
  menuId: "match-prep",
  label: "경기 준비 — 세트피스·상대 분석",
  focus: ["tactical"],
};

/** 마지막 경기 이후에도 이만큼은 훈련을 깔아 둔다 — 컵 결승처럼 나중에 잡히는 경기 몫 */
const TAIL_DAYS = 14;

function userMatchDates(state: GameState): string[] {
  const dates = new Set<string>();
  for (const m of state.matches) {
    if (m.homeTeamId !== state.userTeamId && m.awayTeamId !== state.userTeamId) continue;
    // 2군 경기는 1군 마이크로사이클의 경기일이 아니다 — 뛰는 스쿼드가 다르다
    if (isReserveMatch(m)) continue;
    dates.add(m.date);
  }
  return [...dates].sort();
}

/** 하루의 훈련 메뉴 — 프리시즌 시작일로부터의 날짜 수로만 정한다 (재설치해도 같다) */
function menuOf(
  state: GameState,
  date: string,
  offset: number,
  menu: ReadonlyArray<MenuItem>,
): MenuItem {
  const day = diffDays(state.calendar.preseasonStart, date) + offset;
  const index = ((day % menu.length) + menu.length) % menu.length;
  return menu[index]!;
}

/**
 * 하루치 기본 세션 — 휴가가 먼저, 그다음 경기와의 거리, 요일은 마지막.
 * @param since 직전 경기로부터 지난 일수 (경기가 아직 없으면 null)
 * @param until 다음 경기까지 남은 일수 (남은 경기가 없으면 null)
 */
function planFor(
  state: GameState,
  date: string,
  since: number | null,
  until: number | null,
  returnDate: string,
): SessionPlan[] {
  // 여름 휴가 — 소집일 전엔 훈련장이 비어 있다
  if (date < returnDate) return [];

  if (since === 1) return [RECOVERY];
  if (until === 1) return [MATCH_PREP];
  if (until === 2) return [TACTICAL_DRILL];
  // 경기 이틀째는 완전 휴식(부상 예방), 경기가 걸리지 않는 주말도 쉰다 —
  // 실제 구단도 경기 없는 주엔 평일 5일만 훈련한다
  const dow = dayOfWeek(date);
  if (since === 2 || dow === 0 || dow === 6) return [];

  // 복귀 주 — 메디컬로 열고 강도를 올리지 않는다. 요일에 하나씩 고정 배치한다
  const sinceReturn = diffDays(returnDate, date);
  if (sinceReturn <= RETURN_WEEK_DAYS) {
    return [{ slot: "am", ...RETURN_WEEK[Math.min(sinceReturn, RETURN_WEEK.length - 1)]! }];
  }

  // 그다음 2주는 기초 체력기 — 몸을 만드는 동안엔 화·목 이중 세션까지 붙는다
  const buildUp = sinceReturn <= BUILD_UP_DAYS && date < state.calendar.start;
  const sessions: SessionPlan[] = [
    { slot: "am", ...menuOf(state, date, 0, buildUp ? PRESEASON_BASE : GENERAL_MENU) },
  ];
  if (buildUp && (dow === 2 || dow === 4)) {
    sessions.push({ slot: "pm", ...menuOf(state, date, 2, PRESEASON_BASE) });
  }
  return sessions;
}

function makeSession(
  state: GameState,
  date: string,
  plan: SessionPlan,
): { session: TrainingSession; entry: ScheduleEntry } {
  const id = `ts-${date}-${plan.slot}`;
  return {
    session: { id, label: plan.label, menuId: plan.menuId, focus: [...plan.focus], auto: true },
    entry: {
      id: `se-${id}`,
      date,
      time: SLOT_TIME[plan.slot],
      type: "training",
      refId: id,
      teamId: state.userTeamId,
      status: "scheduled",
    },
  };
}

/** 설치 범위 — 지난 훈련은 이력이라 오늘 이전으로 내려가지 않고, 시즌 꼬리에서 멈춘다 */
function rangeOf(state: GameState, range: { from?: string; to?: string }): [string, string] {
  const matchDates = userMatchDates(state);
  const lastMatch = matchDates[matchDates.length - 1] ?? state.calendar.start;
  const seasonEnd = addDays(lastMatch, TAIL_DAYS);
  return [
    range.from && range.from > state.date ? range.from : state.date,
    range.to && range.to < seasonEnd ? range.to : seasonEnd,
  ];
}

/**
 * from~to의 기본 배치 — **기대값의 단일 출처**.
 *
 * 설치(`installDefaultTraining`)와 검사(`syncDefaultTraining`)가 같은 계산을 쓴다.
 * 검사가 마이크로사이클 규칙을 따로 흉내 내면 규칙이 바뀔 때마다 두 곳이 어긋난다.
 */
function planWindow(
  state: GameState,
  from: string,
  to: string,
): { date: string; plan: SessionPlan }[] {
  const matchDates = userMatchDates(state);
  const matchDateSet = new Set(matchDates);
  const returnDate = squadReturnOf(state.calendar);
  const out: { date: string; plan: SessionPlan }[] = [];
  // 정렬된 경기 날짜를 포인터로 따라가며 앞뒤 경기를 읽는다 (날마다 다시 훑지 않는다)
  let cursor = matchDates.findIndex((d) => d >= from);
  if (cursor < 0) cursor = matchDates.length;
  for (let date = from; date <= to; date = addDays(date, 1)) {
    while (cursor < matchDates.length && matchDates[cursor]! < date) cursor++;
    if (matchDateSet.has(date)) continue;
    const prev = cursor > 0 ? matchDates[cursor - 1]! : null;
    const next = cursor < matchDates.length ? matchDates[cursor]! : null;
    for (const plan of planFor(
      state,
      date,
      prev === null ? null : diffDays(prev, date),
      next === null ? null : diffDays(date, next),
      returnDate,
    )) {
      out.push({ date, plan });
    }
  }
  return out;
}

/**
 * 기본 훈련을 달력에 깐다 — 기본은 오늘부터 시즌 마지막 경기까지, `range`로 좁힐 수 있다.
 *
 * 이미 훈련이 있는 슬롯은 건드리지 않으므로 여러 번 불러도 안전하고,
 * 배치가 날짜로만 결정되므로 언제 다시 불러도 같은 일정이 나온다.
 */
export function installDefaultTraining(
  state: GameState,
  range: { from?: string; to?: string } = {},
): void {
  const [from, to] = rangeOf(state, range);
  const taken = new Set(
    state.schedule.filter((e) => e.type === "training").map((e) => `${e.date}|${e.time}`),
  );

  const added: ScheduleEntry[] = [];
  for (const { date, plan } of planWindow(state, from, to)) {
    const key = `${date}|${SLOT_TIME[plan.slot]}`;
    if (taken.has(key)) continue;
    taken.add(key);
    const { session, entry } = makeSession(state, date, plan);
    state.trainingSessions.push(session);
    added.push(entry);
  }

  if (added.length === 0) return;
  state.schedule = sortEntries([...state.schedule, ...added]);
}

function removeEntries(state: GameState, targets: ScheduleEntry[]): void {
  if (targets.length === 0) return;
  const ids = new Set(targets.map((e) => e.refId));
  const dropped = new Set(targets.map((e) => e.id));
  state.schedule = state.schedule.filter((e) => !dropped.has(e.id));
  state.trainingSessions = state.trainingSessions.filter((s) => !ids.has(s.id));
}

/**
 * 그 날짜의 예정 훈련을 걷어낸다 — 경기일에 호출한다.
 *
 * 경기일엔 훈련하지 않는다. 감독이 굳이 잡아 둔 세션이라도 경기가 이긴다 —
 * 하루에 훈련과 경기를 함께 소화하면 피로가 이중으로 붙는다.
 */
export function cancelTrainingOn(state: GameState, date: string): void {
  removeEntries(
    state,
    state.schedule.filter(
      (e) => e.type === "training" && e.date === date && e.status === "scheduled",
    ),
  );
}

/** 대조에 쓰는 세션의 정체 — id가 있으면 id가, 없으면(옛 세이브) 이름이 그 자리를 대신한다 */
type MenuRef = { menuId?: string | undefined; label: string };

/**
 * 깔린 세션이 기대한 그 메뉴인가 — **`menuId`로 가른다.**
 *
 * 옛 세이브의 `auto` 세션엔 id가 없어(§6 "문장에서 카드로") 그때만 이름으로 떨어진다.
 * 폴백이 없으면 세이브를 여는 순간 남은 시즌의 기본 훈련이 통째로 한 번 다시 깔린다 —
 * 결과는 같아도 감독의 달력이 이유 없이 전부 새 줄이 된다 (season.md §4).
 */
function sameMenu(actual: MenuRef | undefined, want: MenuRef): boolean {
  if (!actual) return false;
  return actual.menuId === undefined ? actual.label === want.label : actual.menuId === want.menuId;
}

/**
 * 일정이 바뀌면 기본 훈련을 그에 맞춰 다시 깐다 — 매 tick에서 부른다.
 *
 * 시즌 중에 경기 날짜는 계속 움직인다. 국내 컵·대항전 녹아웃은 직전 라운드가 끝나야
 * 대진이 정해지고, 컵에 자리를 내준 리그 경기는 **다른 날로 옮겨진다**
 * (`reschedule.ts`). 그때마다 마이크로사이클이 어긋난다 — 경기일에 본훈련이 남거나,
 * 다음날이 회복이 아니거나, 이틀 뒤가 휴식이 아니게 된다. 비워진 날 쪽도 마찬가지로
 * 경기 준비만 남고 본훈련이 돌아오지 않는다.
 *
 * 그래서 **남은 시즌 전체의 기대 배치를 다시 계산해 실제와 통째로 비교한다.**
 *  - 창을 좁히지 않는 이유: 감독의 달력은 시즌 끝까지 다 보인다. 3주만 보면
 *    두 달 뒤 컵 대진이 잡혀도 그 주는 한동안 틀린 채로 보인다.
 *  - 규칙을 흉내 낸 부분 검사를 쓰지 않는 이유: 검사가 규칙의 일부만 보면
 *    나머지(MD−1·MD−2·MD+2)를 놓치고, 마이크로사이클 규칙이 바뀌면 조용히
 *    어긋난다. 설치와 검사가 `planWindow` 하나를 공유하면 그럴 수 없다.
 *
 * 비용은 재 보고 넓혔다 — 시즌 한 바퀴에서 이 함수가 차지하는 몫은 무시할 수준이다.
 * 어긋난 날에만 다시 까므로 실제 재설치는 일정이 움직인 날에만 일어난다.
 *
 * 감독이 직접 지시한 세션(`auto=false`)과 이미 지난 세션은 자리를 선점한 것으로 보고
 * 기대값에서 빼므로, "이 날은 비워 둬" 같은 지시는 이 재배치에서도 살아남는다.
 */
export function syncDefaultTraining(state: GameState): void {
  const [from, to] = rangeOf(state, {});
  if (to < from) return;

  const sessionById = new Map(state.trainingSessions.map((s) => [s.id, s] as const));
  const blocked = new Set<string>(); // 감독 지시·완료된 세션 — 기본 배치가 못 들어가는 자리
  const actual = new Map<string, MenuRef>(); // 자리 → 지금 깔린 기본 세션
  const mine: ScheduleEntry[] = [];
  for (const e of state.schedule) {
    if (e.type !== "training" || e.date < from || e.date > to) continue;
    const session = sessionById.get(e.refId);
    const key = `${e.date}|${e.time}`;
    if (session?.auto === true && e.status === "scheduled") {
      actual.set(key, { menuId: session.menuId, label: session.label });
      mine.push(e);
    } else {
      blocked.add(key);
    }
  }

  const expected = new Map<string, MenuRef>();
  for (const { date, plan } of planWindow(state, from, to)) {
    const key = `${date}|${SLOT_TIME[plan.slot]}`;
    if (blocked.has(key) || expected.has(key)) continue;
    expected.set(key, { menuId: plan.menuId, label: plan.label });
  }

  if (
    expected.size === actual.size &&
    [...expected].every(([key, want]) => sameMenu(actual.get(key), want))
  ) {
    return;
  }
  removeEntries(state, mine);
  installDefaultTraining(state, { to });
}

// ── 2군 훈련 방침 (season.md §2 "2군 훈련 방침") ─────────────────────

/**
 * 방침이 겨냥하는 축 — **능력치 카탈로그의 갈래를 그대로 쓴다**(player.md §2).
 * `goalkeeping`은 어디에도 들지 않는다: 한 축뿐인 갈래라 겨냥 대상으로 두면 그
 * 방침만 배율이 극단으로 튀고, 눌리게 두면 골키퍼 유망주가 감독이 고른 방침
 * 때문에 굳는다. 방침이 닿는 자리는 필드 15축이다.
 */
const RESERVE_TRAINING_AXES: Record<ReserveTrainingPolicy, readonly AttributeAxis[]> = {
  balanced: [],
  physical: ["pace", "stamina", "strength", "aerial"],
  technical: ["finishing", "dribbling", "passing", "kicking", "tackling"],
  mental: ["vision", "positioning", "offTheBall", "composure", "aggression", "leadership"],
};

/** 방침이 닿지 않는 축 — 겨냥 대상도, 눌리는 대상도 아니다 */
const UNTOUCHED_AXIS: AttributeAxis = "goalkeeping";

/** 방침이 나누는 몫의 분모 — 축 목록에서 파생한다(축이 늘면 여기가 따라온다) */
const FIELD_AXIS_COUNT = ATTRIBUTE_AXES.filter((axis) => axis !== UNTOUCHED_AXIS).length;

/** 겨냥한 축의 성장 확률 배율 */
export const RESERVE_TRAINING_AIM = 1.6;

/** 이 방침이 겨냥하는 축 — 축 묶음을 읽는 유일한 문 */
export function reserveTrainingAxes(policy: ReserveTrainingPolicy): readonly AttributeAxis[] {
  return RESERVE_TRAINING_AXES[policy];
}

/**
 * 방침이 이 축의 성장 확률에 곱하는 배율 — **총량을 옮길 뿐 늘리지 않는다.**
 *
 * 겨냥한 n축이 `RESERVE_TRAINING_AIM`만큼 오르면 나머지 필드 축이 그만큼 내려가
 * 필드 15축의 배율 합은 어느 방침에서나 15다(season.md §8 불변식). 공짜 상향이면
 * 고르는 일이 아니라 켜는 일이 된다.
 */
export function reserveTrainingMultiplier(
  policy: ReserveTrainingPolicy,
  axis: AttributeAxis,
): number {
  const aimed = reserveTrainingAxes(policy);
  if (aimed.length === 0 || axis === UNTOUCHED_AXIS) return 1;
  if (aimed.includes(axis)) return RESERVE_TRAINING_AIM;
  const rest = FIELD_AXIS_COUNT - aimed.length;
  return (FIELD_AXIS_COUNT - aimed.length * RESERVE_TRAINING_AIM) / rest;
}

/**
 * 개인 훈련이 겨냥한 축의 배율 — 방침보다 날카롭다. 방침은 갈래 하나(4~6축)를
 * 겨냥하지만 개인 훈련은 **한 축**을 겨냥하므로, 같은 폭으로 얹으면 손잡이 둘의
 * 값이 같아진다. 걷는 몫도 그만큼 크다(방침 없이 겨냥하면 나머지 14축 ×13/14).
 */
export const PERSONAL_TRAINING_AIM = 2;

/** 이 선수에게 걸린 개인 훈련의 축 — 없거나 이름을 모르면 null */
export function personalTrainingAxis(state: GameState, playerId: string): AttributeAxis | null {
  return attributeAxisOf(state.playerTraining.find((t) => t.gamePlayerId === playerId)?.axis);
}

/**
 * 월간 성장이 이 축에 곱하는 배율 — **2군 훈련 방침과 개인 훈련을 합성한다**
 * (season.md §2). 둘이 같은 축을 두고 겹치는 자리가 여기 하나다.
 *
 * 규약은 방침의 것을 그대로 쓴다: **총량을 옮길 뿐 늘리지 않는다.** 개인 훈련이
 * 겨냥한 축이 오른 만큼을 나머지 필드 축에서 **비례로**(방침이 이미 얹은 배율에
 * 비례해) 걷으므로, 합성해도 필드 15축의 배율 합은 15로 남는다.
 *
 * 개인 축이 `goalkeeping`이면 제 갈래에 걷을 자리가 없어 필드 15축에서 걷는다 —
 * 그때는 필드 합이 `16 − PERSONAL_TRAINING_AIM`으로 내려가고 **16축 합이 16**이다.
 * 골키퍼 유망주가 겨냥할 축을 잃지 않으면서 규약도 지키는 쪽 (season.md §8 불변식).
 */
export function monthlyGrowthMultiplier(
  axis: AttributeAxis,
  aim: { policy?: ReserveTrainingPolicy | undefined; personal?: AttributeAxis | null },
): number {
  const byPolicy = (a: AttributeAxis): number =>
    aim.policy ? reserveTrainingMultiplier(aim.policy, a) : 1;
  const base = byPolicy(axis);
  const personal = aim.personal;
  if (!personal) return base;
  if (axis === personal) return base * PERSONAL_TRAINING_AIM;
  // 걷는 자리는 필드 축뿐이다 — 개인 축이 필드 축이면 `goalkeeping`은 그대로 둔다
  if (axis === UNTOUCHED_AXIS) return base;
  const aimed = byPolicy(personal);
  // 방침이 필드 15축 합을 15로 지키므로 걷을 몫의 분모가 여기서 파생된다
  const pool = FIELD_AXIS_COUNT - (personal === UNTOUCHED_AXIS ? 0 : aimed);
  const moved = aimed * (PERSONAL_TRAINING_AIM - 1);
  return (base * (pool - moved)) / pool;
}
