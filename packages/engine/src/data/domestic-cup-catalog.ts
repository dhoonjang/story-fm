/**
 * 국내 컵 카탈로그 — FA컵·리그컵·코파 델 레이·코파 이탈리아·DFB-포칼·쿠프 드 프랑스.
 *
 * 유럽 대항전(cup-catalog.ts)과 갈라 둔 이유: 두 대회군은 **모양이 다르다**.
 * 대항전은 리그 페이즈(순위표) + 녹아웃이고, 국내 컵은 처음부터 끝까지 순수
 * 녹아웃이라 순위표가 아예 없다. 참가 배정도 다르다 — 대항전 티켓은 지난 시즌
 * 리그 순위가 정하지만, 국내 컵은 **그 나라 전 클럽**이 그냥 나온다.
 *
 * ## 우리 대회는 **1부가 들어오는 라운드에서 시작한다**
 *
 * 실제 컵은 하부리그가 먼저 몇 달을 싸운다 — FA컵은 논리그까지 736팀, 리그컵은
 * EFL 70클럽이 1·2라운드를 치르고, 1부 클럽은 **한참 뒤에** 합류한다. 우리는
 * 나라별로 1부 + 2부 32클럽만 모델링하므로 그 앞부분이 없다. 그렇다고 32팀을
 * "1라운드"에 몰아넣으면 거짓말이 된다 — 아스날이 리그컵 1라운드에 나오고,
 * 맨유가 8월에 컵을 시작한다.
 *
 * 그래서 **우리의 첫 라운드는 실제로 1부가 들어오는 그 라운드**다. 리그컵은
 * 3라운드(9월 말), FA컵은 3라운드(1월), 코파 델 레이는 32강, 포칼은 1라운드다.
 * 이름도 날짜도 그 라운드의 실제 값을 쓴다.
 *
 * 그 결과 **리그컵과 코파 델 레이는 실제와 규모까지 같다** — 실제 리그컵 3라운드가
 * 32팀이고 코파 32강(dieciseisavos)도 32팀이다. FA컵 3라운드(64팀)·포칼
 * 1라운드(64팀)·쿠프 32강(64팀)은 우리가 절반이라, **같은 이름의 라운드에 절반의
 * 클럽**이 있다. 그래서 8강부터는 이름이 규모와 다시 맞는다(8·4·2).
 *
 * 남는 차이 둘 — ① 우리 2부 클럽은 앞 라운드를 치르지 않고 바로 이 라운드에
 * 들어온다(실제라면 대부분 그 전에 탈락한다) ② 코파 이탈리아의 시드 8팀은
 * 실제로 16강부터 나오지만 우리는 1라운드부터 뛴다. 둘 다 32클럽 규모의 대가다.
 *
 * 실제 대회에서 그대로 가져온 것: **라운드 이름과 날짜**, **2차전제를 쓰는 단계**
 * (리그컵·코파·코파 이탈리아의 준결승만), **중립 결승**, **추첨 방식**(라운드별 /
 * 대진표 확정형), **홈 배정 규정**, 그리고 **우승팀의 유럽 진출권**.
 */
import type { MatchStage } from "@story-fm/domain";

export interface DomesticCupEntry {
  id: string;
  name: string;
  /** 달력·일지에 붙는 짧은 표기 */
  short: string;
  /** 주최 나라 — 이 나라의 1·2부 클럽이 참가한다 (`clubsOfCountry`) */
  country: string;
  /** 컵 명성 — 같은 나라에 컵이 둘일 때 어느 쪽이 '메이저'인가 (1이 위) */
  prestige: 1 | 2;
  /**
   * 2차전제로 치르는 단계. 나머지는 전부 단판이고, 단판이 비기면 승부차기다
   * (우리 구현은 단판 동점이면 연장 30분을 먼저 치른다 (simulation/match.md)).
   */
  twoLegged: MatchStage[];
  /**
   * 추첨 방식 — 실제 대회는 두 갈래다.
   *
   * - `per-round` — 라운드마다 새로 뽑는다. FA컵·리그컵·코파·포칼·쿠프가 여기고,
   *   추첨은 TV로 중계되는 **사건**이라 달력에 오른다.
   * - `fixed-bracket` — 시즌 초에 대진표(tabellone) 전체가 확정된다. 코파 이탈리아가
   *   유일하다. 이후 라운드는 브래킷 자리가 정하므로 추첨이 없고, 그래서 개막부터
   *   "이기면 8강에서 누구" 같은 경로가 보인다.
   */
  drawStyle: "per-round" | "fixed-bracket";
  /** 1라운드(또는 대진표) 추첨일 `[월, 일]` — 실제 대회의 추첨 날짜 */
  firstDraw: [number, number];
  /**
   * 다음 라운드 추첨 — 직전 라운드 **마지막 경기로부터** 며칠 뒤인가.
   * FA컵·리그컵은 마지막 경기 직후 그 자리에서 뽑아 0, 포칼은 며칠 뒤에 뽑는다.
   */
  drawDelayDays: number;
  /**
   * 다른 부(部)의 두 팀이 만났을 때 홈 배정 — 대회마다 **규정이 다르다**.
   *
   * - `underdog` — 하부 클럽이 홈. 포칼·코파 델 레이·쿠프의 실제 규정이다.
   * - `seeded` — 시드(상위) 클럽이 홈. 코파 이탈리아가 그렇다.
   * - `draw` — 먼저 뽑힌 팀이 홈. FA컵·리그컵은 추첨 순서가 곧 홈이다.
   */
  homeRule: "underdog" | "seeded" | "draw";
  /**
   * 라운드별 목표 날짜 `[월, 일]` — 실제 대회 일정 골격.
   * 실제 배정은 이 날짜부터 **리그·대항전과 겹치지 않는 첫 날**을 찾아 잡는다
   * (`domestic-cup.ts`) — 목표일이 곧 경기일은 아니다.
   */
  windows: Record<MatchStage, [number, number]>;
  /**
   * 라운드 이름 — **대회마다 다르다.** 기본은 규모(32강·16강·8강)지만, 우리의 첫
   * 라운드는 실제로 1부가 들어오는 라운드라 그쪽 이름을 쓴다(리그컵·FA컵 3라운드,
   * 포칼 1라운드). 여기 없는 단계는 기본 이름을 쓴다.
   */
  stageNames?: Partial<Record<MatchStage, string>>;
  /**
   * 결승이 **주중 밤**인가 — 코파 이탈리아만 그렇다(로마 올림피코, 수요일 저녁).
   * 나머지 넷은 예외 없이 토·일이다(웸블리·베를린·라 카르투하·스타드 드 프랑스).
   */
  finalMidweek?: boolean;
  /**
   * 우승팀이 얻는 다음 시즌 유럽 대항전 티켓.
   * 실제로 5대 리그 국내 컵 우승팀은 모두 유로파리그 리그 페이즈에 직행하고,
   * 잉글랜드 리그컵 우승팀만 컨퍼런스리그로 간다.
   */
  europeanTicket: "uel" | "uecl";
  /**
   * 상금 (£) — 라운드 진출 + 우승/준우승.
   *
   * ⚠️ **밸런스 임시값.** 실제 국내 컵 상금은 유럽 대항전에 비해 아주 작다
   * (FA컵 우승 £2.1M · 카라바오컵 우승 £0.1M vs UCL 참가비만 £12M). 그 비율은
   * 지키되 매치데이 수입·서사 가치가 진짜 보상이 되게 뒀다.
   */
  prize: {
    round: Partial<Record<MatchStage, number>>;
    winner: number;
    runnerUp: number;
  };
}

/**
 * 국내 컵 단계 — 32강부터 결승까지 다섯 라운드. 전 대회가 같은 모양이다
 * (나라마다 1부 팀 수가 18~20으로 달라도 2부로 32를 맞췄다).
 */
export const DOMESTIC_STAGES: MatchStage[] = ["r32", "r16", "qf", "sf", "final"];

/** 국내 컵 참가 규모 — 브래킷이 2의 거듭제곱이어야 부전승이 없다 */
export const DOMESTIC_CUP_SIZE = 32;

/** 기본 이름 — 브래킷 규모 그대로. 대회가 `stageNames`로 덮어쓸 수 있다 */
const STAGE_KO: Record<string, string> = {
  r32: "32강",
  r16: "16강",
  qf: "8강",
  sf: "준결승",
  final: "결승",
};

/**
 * 국내 컵 단계 표기 — 2차전제면 차수까지 (`준결승 2차전`).
 *
 * **대회를 알아야 이름을 안다** — 같은 `r32`가 리그컵에선 3라운드, 포칼에선
 * 1라운드, 코파에선 32강이다. 대회를 모르면(옛 호출) 규모 이름으로 떨어진다.
 */
export function domesticStageLabel(
  cup: DomesticCupEntry | string | null,
  stage: MatchStage,
  round = 1,
  twoLegged = false,
): string {
  const entry = typeof cup === "string" ? BY_ID.get(cup) : cup;
  const base = entry?.stageNames?.[stage] ?? STAGE_KO[stage] ?? stage;
  return twoLegged && stage !== "final" ? `${base} ${round}차전` : base;
}

export const DOMESTIC_CUP_CATALOG: readonly DomesticCupEntry[] = [
  {
    id: "facup",
    name: "FA컵",
    short: "FA컵",
    country: "잉글랜드",
    prestige: 1,
    // 2024-25부터 재경기가 폐지돼 전 라운드 단판이다
    twoLegged: [],
    drawStyle: "per-round",
    // 3라운드 추첨 12월 8일 → 경기 1월 10일 (실제 2025-26)
    firstDraw: [12, 8],
    // 4라운드 추첨은 3라운드 **마지막 경기 직후** 그 경기장에서 (TNT Sports 생중계)
    drawDelayDays: 0,
    homeRule: "draw",
    // 3라운드(1/10) → 4라운드(2/7) → 8강(3/21) → 준결승(4/25, 웸블리)
    // → 결승(5/16, 웸블리) — 2025-26 실제 라운드 날짜 그대로.
    // 실제 5라운드(3월 초)는 없다 — 우리 필드가 절반이라 4라운드 뒤가 곧 8강이다.
    windows: {
      league: [1, 10],
      playoff: [1, 10],
      r32: [1, 10],
      r16: [2, 7],
      qf: [3, 21],
      sf: [4, 25],
      final: [5, 16],
    },
    // 1부·2부가 함께 들어오는 라운드가 실제로 3라운드다 (그 앞은 하부리그의 몫)
    stageNames: { r32: "3라운드", r16: "4라운드" },
    europeanTicket: "uel",
    prize: {
      round: { r16: 250_000, qf: 500_000, sf: 1_000_000 },
      winner: 3_000_000,
      runnerUp: 1_500_000,
    },
  },
  {
    id: "eflcup",
    name: "카라바오컵",
    short: "리그컵",
    country: "잉글랜드",
    prestige: 2,
    // 실제 리그컵은 준결승만 2차전제다
    twoLegged: ["sf"],
    drawStyle: "per-round",
    /**
     * 3라운드 추첨 — 2라운드 마지막 경기 직후(8월 말)에 뽑는다.
     *
     * 1·2라운드는 EFL 70클럽의 몫이라 우리 세계에 없다. 우리 32클럽(1부 20 +
     * 2부 12)은 **실제 3라운드와 규모까지 같다** — 그 라운드가 32팀이다.
     */
    firstDraw: [8, 27],
    // 3·4라운드 추첨도 직전 라운드 마지막 경기 종료 직후 (Sky Sports 생중계)
    drawDelayDays: 0,
    homeRule: "draw",
    // 9월 말 3라운드 → 10월 말 4라운드 → 12월 중순 8강 → 1월 준결승(2차전제)
    // → 3월 22일 웸블리 — 2025-26 카라바오컵 실제 라운드 주간
    windows: {
      league: [9, 23],
      playoff: [9, 23],
      r32: [9, 23],
      r16: [10, 28],
      qf: [12, 16],
      sf: [1, 13],
      final: [3, 22],
    },
    stageNames: { r32: "3라운드", r16: "4라운드" },
    europeanTicket: "uecl",
    prize: {
      round: { r16: 60_000, qf: 120_000, sf: 250_000 },
      winner: 1_000_000,
      runnerUp: 500_000,
    },
  },
  {
    id: "copadelrey",
    name: "코파 델 레이",
    short: "코파",
    country: "스페인",
    prestige: 1,
    twoLegged: ["sf"],
    drawStyle: "per-round",
    /**
     * 32강(dieciseisavos) 추첨은 12월, 경기는 1월 초 — 라리가 클럽이 들어오는
     * 라운드다. 앞의 두 라운드는 하부 112클럽의 몫이라 우리 세계에 없고,
     * **규모는 실제와 같다**(dieciseisavos = 32팀).
     */
    firstDraw: [12, 9],
    drawDelayDays: 2,
    // 규정: 하부 카테고리 팀이 홈에서 치른다
    homeRule: "underdog",
    // 1월 초 32강 → 1월 중순 16강 → 2월 초 8강 → 2월 말 준결승(2차전제) → 4월 말 결승(중립)
    windows: {
      league: [1, 7],
      playoff: [1, 7],
      r32: [1, 7],
      r16: [1, 14],
      qf: [2, 4],
      sf: [2, 25],
      final: [4, 25],
    },
    europeanTicket: "uel",
    prize: {
      round: { r16: 200_000, qf: 400_000, sf: 800_000 },
      winner: 2_500_000,
      runnerUp: 1_200_000,
    },
  },
  {
    id: "coppaitalia",
    name: "코파 이탈리아",
    short: "코파 이탈리아",
    country: "이탈리아",
    prestige: 1,
    twoLegged: ["sf"],
    // **유일한 대진표 확정형** — 시즌 초 tabellone이 전부 정해지고 이후 추첨이 없다
    drawStyle: "fixed-bracket",
    firstDraw: [8, 1],
    drawDelayDays: 0,
    // 규정: 시드(상위) 클럽이 단판 홈경기를 갖는다
    homeRule: "seeded",
    /**
     * 8월 중순 1라운드(primo turno) → 1월 16강(ottavi) → 2월 8강 → 3월 준결승
     * → 5월 중순 올림피코 결승.
     *
     * 준결승은 실제로 2월(2023-24)과 4월(2024-25) 사이를 오간다. 우리는 **3월**로
     * 잡는다 — 4월에 두면 밀려난 세리에 A 경기가 5월에 쌓여, 결승 전날 결승 팀이
     * 리그를 뛰는 자리가 생긴다(시드 42에서 실제로 그랬다).
     *
     * ⚠️ 실제로 **시드 8팀은 16강부터** 나온다(세리에 A 9~20위만 1라운드를 뛴다).
     * 우리는 32클럽뿐이라 시드도 1라운드부터 뛴다 — 이 대회의 유일한 규정 이탈이다.
     */
    windows: {
      league: [8, 16],
      playoff: [8, 16],
      r32: [8, 16],
      r16: [1, 13],
      qf: [2, 10],
      sf: [3, 3],
      final: [5, 12],
    },
    stageNames: { r32: "1라운드" },
    // 실제 코파 이탈리아 결승은 **수요일 밤 올림피코**다 (2024·2025 모두 수요일)
    finalMidweek: true,
    europeanTicket: "uel",
    prize: {
      round: { r16: 180_000, qf: 350_000, sf: 700_000 },
      winner: 2_200_000,
      runnerUp: 1_000_000,
    },
  },
  {
    id: "dfbpokal",
    name: "DFB-포칼",
    short: "포칼",
    country: "독일",
    prestige: 1,
    // 포칼은 준결승까지 전부 단판이다
    twoLegged: [],
    drawStyle: "per-round",
    // 실제 1라운드 추첨은 6월 15일(ZDF 생중계) — 게임 시작 직후로 옮겼다
    firstDraw: [7, 5],
    // 2라운드 추첨 8/31(1라운드 8/15~18) · 16강 추첨 11/2(2라운드 10/28~29) — 며칠 뒤에 뽑는다
    drawDelayDays: 4,
    // 규정: 부(部)가 다르면 하부 클럽이 홈이다 (포칼의 정체성)
    homeRule: "underdog",
    // 8월 중순 1라운드 → 10월 말 2라운드 → 2월 8강 → 4월 준결승 → 5월 말 베를린.
    // 분데스리가 클럽이 실제로 1라운드부터 나오는 대회라 이름·날짜가 그대로 맞는다
    // (실제 12월 16강은 없다 — 우리 필드가 절반이라 2라운드 뒤가 곧 8강이다).
    windows: {
      league: [8, 18],
      playoff: [8, 18],
      r32: [8, 18],
      r16: [10, 28],
      qf: [2, 3],
      sf: [4, 7],
      final: [5, 23],
    },
    stageNames: { r32: "1라운드", r16: "2라운드" },
    europeanTicket: "uel",
    prize: {
      round: { r16: 300_000, qf: 600_000, sf: 1_200_000 },
      winner: 3_500_000,
      runnerUp: 1_800_000,
    },
  },
  {
    id: "coupedefrance",
    name: "쿠프 드 프랑스",
    short: "쿠프",
    country: "프랑스",
    prestige: 1,
    twoLegged: [],
    drawStyle: "per-round",
    /**
     * 리그 1 클럽은 실제로 **64강(32es de finale, 12월 말)**부터 나오지만 그
     * 라운드는 64팀이라 우리 필드로는 못 채운다. 그래서 우리 첫 라운드는 그 다음
     * 라운드인 **32강(16es, 1월 중순)** — 규모가 정확히 맞는 자리다.
     * 추첨도 그 라운드의 실제 추첨(64강 경기 직후)을 따른다.
     */
    firstDraw: [1, 4],
    drawDelayDays: 3,
    // 규정: 하위 리그 팀이 홈에서 치른다
    homeRule: "underdog",
    // 1월 중순 32강 → 2월 초 16강 → 2월 말 8강 → 4월 초 준결승 → 5월 말 스타드 드 프랑스
    windows: {
      league: [1, 14],
      playoff: [1, 14],
      r32: [1, 14],
      r16: [2, 3],
      qf: [2, 25],
      sf: [4, 1],
      // 실제 결승은 5월 마지막 주 토요일이지만, 우리 리그 최종전이 5월 마지막
      // 일요일이라 그 앞 주말에 세운다 — 결승 전날 리그를 뛰게 할 수는 없다
      final: [5, 22],
    },
    europeanTicket: "uel",
    prize: {
      round: { r16: 120_000, qf: 250_000, sf: 500_000 },
      winner: 1_600_000,
      runnerUp: 800_000,
    },
  },
];

const BY_ID = new Map(DOMESTIC_CUP_CATALOG.map((c) => [c.id, c]));

export function domesticCupById(id: string): DomesticCupEntry | null {
  return BY_ID.get(id) ?? null;
}

export function isDomesticCup(competitionId: string): boolean {
  return BY_ID.has(competitionId);
}

/** 이 나라의 국내 컵 — 명성 순 (잉글랜드는 FA컵 → 리그컵) */
export function domesticCupsOfCountry(country: string): DomesticCupEntry[] {
  return DOMESTIC_CUP_CATALOG.filter((c) => c.country === country).sort(
    (a, b) => a.prestige - b.prestige,
  );
}
