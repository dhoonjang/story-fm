import {
  type GameState,
  playerName,
  playersOf,
  financeOf,
  teamNameIn,
  teamShortNameIn,
} from "../common/core/state";
import {
  growthLabel,
  type ScheduleType,
  type TrainingReport,
  TRAINING_MARK_KO,
  type MatchRecord,
  slotOfTime,
  TRAIN_ATTR_KO,
  outcomeFor,
  outcomeLabel,
  parseScorerEntry,
  formatScore,
} from "@story-fm/domain";
import { formatMoney, monthOf, isJournalMoney, userReports } from "../common/finance/finance";
import { drawParts, drawTitle } from "../match/competition/draw-schedule";
import {
  isCup,
  competitionStageLabel,
  fixtureLabel,
  competitionShortName,
} from "../common/data/cup-catalog";
import { isFriendly } from "../common/core/match-kinds";
import { strengthOf } from "../match/views/competition";
import { seasonEndDate } from "../common/core/calendar";

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
export function growthSummary(state: GameState, date: string, entryId?: string): string | null {
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
    | "move"
    /** 큰 비정기 수입·지출 — 정액 항목은 서지 않는다 (docs/common/finance.md §8.2) */
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
    /** 상대 팀 id — 문장과 구단 색의 열쇠 */
    opponentId: string;
    /** 상대 팀 약칭 (`LIV`) — 좁은 칸에서 풀네임은 세 줄로 접힌다 */
    opponent: string;
    /** 상대 팀 이름 — 자리가 있는 상세 패널이 쓴다 */
    opponentName: string;
    venue: "home" | "away" | "neutral";
    /** 우리 관점 스코어 (`formatScore`) — 미진행이면 null */
    score: string | null;
    /**
     * 상대의 **전력 한 숫자** — 스쿼드 상위 열한 명의 평균 OVR
     * (`squadRating` → docs/common/team.md §2.2). 우리 팀의 값은 모든 줄에서 같아
     * 줄마다 적을 이유가 없으므로 상대만 싣는다. 스쿼드가 빈 팀은 `null`이다.
     */
    opponentStrength: number | null;
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

export function isUserMatch(state: GameState, matchId: string): boolean {
  const m = state.matches.find((x) => x.id === matchId);
  if (!m) return false;
  return m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId;
}

/** 결산 카드의 머리줄 — 구간·세션 수와 건수 */
export function trainingReportSummary(report: TrainingReport): string {
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
export function trainingReportLines(state: GameState, report: TrainingReport): string[] {
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
 * 기록 테이블 몫의 달력 일지 — 성장·부상·카드·선수단의 들고 남·돈, 그리고 서사 표의
 * **소식**.
 *
 * 일정 축(경기·훈련)은 부르는 쪽이 **먼저** 얹는다: 소식은 그 위에 겹치지
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
  // 일지는 **우리 스쿼드**의 일이다
  const ourPlayerIds = new Set(playersOf(state, state.userTeamId).map((p) => p.id));
  const userTeamId = state.userTeamId;
  // 카드는 경기 id만 갖는다 — 날짜는 그 경기가 안다
  const matchById = new Map(state.matches.map((m) => [m.id, m] as const));
  /**
   * 성장은 **날짜별로 묶는다** — 전술 훈련 한 번에 스무 줄이 나온다. 일지에 그대로
   * 펼치면 그날 있었던 다른 일(부상·경고)이 스크롤 밖으로 밀린다.
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
  for (const report of state.trainingReports) {
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
  for (const move of state.moves) {
    if (move.fromTeamId !== userTeamId && move.toTeamId !== userTeamId) continue;
    const name = playerName(state, move.gamePlayerId);
    const label = {
      retire: "은퇴",
      youth: "유스 승격",
      expiry: "계약 만료로 떠남",
      reinforcement: "합류",
      transfer: "이적",
      free: "자유계약 합류",
    }[move.kind];
    push(move.date, { kind: "move", text: `${name} ${label}` });
  }

  const finance = financeOf(state, userTeamId);

  /**
   * ⚠️ **정액 항목은 달력에 올리지 않는다.** 주급·중계권처럼 매달 같은 자리에 같은
   * 줄이 서면 그날 실제로 벌어진 일(부상·경고)을 덮는다. 서는 것은 문턱을 넘는
   * **비정기** 항목뿐이고, 그 판정은 코어가 한다 — `isJournalMoney`.
   *
   * 파생 원본이 둘이다: 원장은 3개월 뒤 잘리므로 **진행 중인 달만** 원장에서 읽고,
   * 마감된 달은 보고서의 `highlights`(절단 전에 옮겨 적은 것)에서 읽는다. 마감은
   * 지난달까지만 하므로 두 원본은 겹치지 않는다 (docs/common/finance.md §8.2).
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
    for (const h of r.highlights) {
      if (h.date > state.date) continue;
      push(h.date, { kind: "money", text: moneyText(h) });
    }
  }
}

export type CalendarView = {
  today: string;
  preseasonStart: string;
  seasonStart: string;
  seasonEnd: string;
  entries: CalendarEntryView[];
  /** 일자별 사건 일지 — 기록 테이블에서 파생 (저장하지 않는다) */
  events: Record<string, CalendarEventView[]>;
};

export function buildCalendarView(
  state: GameState,
  squadRatings: ReadonlyMap<string, number>,
  next: MatchRecord | null,
): CalendarView {
  const userTeamId = state.userTeamId;
  // ── 일정 뷰 (유저 팀 관련 경기 + 훈련 + 컵 추첨) ──
  const sessionById = new Map(state.trainingSessions.map((s) => [s.id, s] as const));
  const matchById = new Map(state.matches.map((m) => [m.id, m] as const));
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
          const assistIds = m.result.assists;
          const minutes = m.result.goalMinutes;
          const scorers = m.result.scorers.map((entry, i) => {
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
        const stage = competitionStageLabel(m.competitionId, m.stage, m.round);
        return {
          id: e.id,
          date: e.date,
          time: e.time,
          type: e.type,
          status: e.status,
          title: `${fixtureLabel(m.competitionId, m.stage, m.round)} ${m.neutral ? "중립" : home ? "홈" : "원정"} vs ${opponent}`,
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
            opponentId: home ? m.awayTeamId : m.homeTeamId,
            opponent: teamShortNameIn(state, home ? m.awayTeamId : m.homeTeamId),
            opponentName: opponent,
            venue: m.neutral ? "neutral" : home ? "home" : "away",
            // 칸이 좁아 정규시간 스코어만 — 승부차기 여부는 색(승/패)과 툴팁에 있다
            score: m.result
              ? formatScore(
                  home ? m.result.homeGoals : m.result.awayGoals,
                  home ? m.result.awayGoals : m.result.homeGoals,
                )
              : null,
            opponentStrength: strengthOf(squadRatings, home ? m.awayTeamId : m.homeTeamId),
          },
          cup: null,
        };
      }
      return null;
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
  }
  /**
   * 나머지 갈래(성장·부상·카드·들고 남·돈·소식)는 일정 축을 타지 않는다 — 조회
   * (`scheduleView`)도 같은 함수를 읽는다.
   */
  pushRecordJournal(state, events);

  return {
    today: state.date,
    preseasonStart: state.calendar.preseasonStart,
    seasonStart: state.calendar.start,
    seasonEnd: seasonEndDate(state.matches) ?? state.calendar.start,
    entries,
    events,
  };
}
