import type { OfficeViews } from "@story-fm/engine";

/**
 * 달력 상세의 일정 한 줄 — **뷰가 준 조각을 조각대로 놓는다.**
 *
 * 예전엔 `time · title — detail · result`로 이어 붙여 경기도 훈련도 휴식도 같은
 * 회색 한 줄이었다. 달력 칸은 이미 종류를 색과 모양으로 가르는데, 칸을 열면 그게
 * 다시 글자로 되돌아가 감독이 같은 것을 두 번 배웠다.
 *
 * 여기서 문자열을 만들지 않는다 — 자르지도 잇지도 않고, 화면은 조각을 배치만 한다.
 */

type CalEntry = OfficeViews["calendar"]["entries"][number];

/** 행의 아이콘 — 일지 블록(`EventIcon`)과 같은 체계를 쓴다 */
export type CalRowIcon = "match" | "training" | "rest" | "draw" | "window";

export interface CalScheduleRow {
  id: string;
  time: string;
  icon: CalRowIcon;
  /** 대회 약칭 — 리그 경기와 훈련엔 없다 */
  competition: string | null;
  /** 단계 — 리그는 라운드(`R7`), 컵은 `16강` */
  stage: string | null;
  /** 경기만 갖는다 */
  venue: "home" | "away" | "neutral" | null;
  /** 행의 이름 — 경기는 상대, 훈련은 세션 이름 */
  name: string;
  /** 스코어와 승패 — `2-1 승` */
  result: string | null;
  /** 결과의 색을 가른다 */
  win: "W" | "D" | "L" | null;
  /** 이름 옆에 붙는 작은 조각 — 훈련 축 */
  tags: string[];
  /** 이름 아래 붙는 잔글씨 — 득점자, 이적창 기간 */
  note: string | null;
  /** 날짜만 잡혀 있고 대진은 아직 없다 (`cup-round`) */
  pending: boolean;
  /** 다음 경기 */
  next: boolean;
}

const EMPTY = {
  competition: null,
  stage: null,
  venue: null,
  result: null,
  win: null,
  tags: [] as string[],
  note: null,
  pending: false,
  next: false,
} satisfies Omit<CalScheduleRow, "id" | "time" | "icon" | "name">;

export function scheduleRowOf(e: CalEntry): CalScheduleRow {
  const base = { ...EMPTY, id: e.id, time: e.time };

  if (e.type === "match" && e.match) {
    return {
      ...base,
      icon: "match",
      competition: e.match.competition,
      stage: e.match.stage,
      venue: e.match.venue,
      // 칸은 좁아 약칭을 쓰지만 상세는 자리가 있다
      name: e.match.opponentName,
      result: e.result,
      win: e.win,
      // 득점자 — 경기 엔트리의 `detail`이 그것 하나다
      note: e.detail,
      next: e.isNext,
    };
  }

  // 날짜는 공표됐고 상대만 추첨을 기다린다 — 칸의 `cal-fx.pending`과 같은 상태
  if (e.type === "cup-round" && e.cup) {
    return {
      ...base,
      icon: "match",
      competition: e.cup.competition,
      stage: e.cup.stage,
      name: "대진 미정",
      pending: true,
    };
  }

  if (e.type === "draw" && e.cup) {
    return {
      ...base,
      icon: "draw",
      competition: e.cup.competition,
      stage: e.cup.stage,
      name: "대진 추첨",
    };
  }

  /**
   * 훈련과 휴식은 뜻이 반대라 아이콘을 나눈다 — 달력 칸이 점 색을 나누는 것과 같다.
   * 훈련 성과(`result`)는 아래 `기록` 블록이 접었다 펼치며 말하므로 여기 두지 않는다.
   */
  if (e.type === "training") {
    return {
      ...base,
      icon: e.rest === true ? "rest" : "training",
      name: e.title,
      tags: e.detail === null ? [] : [e.detail],
    };
  }

  return { ...base, icon: "window", name: e.title, note: e.detail };
}
