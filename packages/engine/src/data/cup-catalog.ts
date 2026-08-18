/**
 * 유럽 대항전 카탈로그 — 챔피언스리그·유로파리그·컨퍼런스리그.
 *
 * 리그처럼 대회(Competition)의 불변 정의이고 `MATCH.competitionId`가 이 id를 가리킨다.
 * 2024-25부터의 실제 포맷(단일 리그 페이즈 + 플레이오프 + 16강)을 따른다.
 *
 * ⚠️ **규모는 축소했다.** 실제 UCL 리그 페이즈는 36팀이지만 그중 12팀은 우리가
 * 모델링하지 않은 리그(에레디비시·프리메이라·스코티시 등)에서 온다. 5대 리그만
 * 있는 지금 36팀을 채우면 96클럽의 1/3이 UCL에 나가는 비현실이 된다. 그래서
 * **5대 리그 배정분만** 참가한다 (UCL 24 · UEL 16 · UECL 10 = 50클럽).
 * 하위 리그를 추가하면 아약스·벤피카·셀틱 같은 실제 참가 팀으로 36팀을 채운다.
 */
import type { MatchStage } from "@story-fm/domain";
import { domesticCupById, domesticStageLabel, isDomesticCup } from "./domestic-cup-catalog";
import { leagueName } from "./league-catalog";
import { catalogSource } from "./catalog-source";
import { readCupOverride } from "./cup-override";
import { FRIENDLY_LABEL } from "../competition/friendly";

export interface CupCatalogEntry {
  id: string;
  name: string;
  /** 달력·일지에 붙는 짧은 표기 */
  short: string;
  /** 리그 페이즈 참가 팀 수 */
  size: number;
  /** 팀당 리그 페이즈 경기 수 (홈 절반·원정 절반) */
  matchesPerTeam: number;
  /** 참가 팀 수는 **짝수**여야 한다 — 홀수면 라운드마다 한 팀이 쉬어 라운드가 늘어난다 */
  /**
   * 리그별 티켓 수 — 도메스틱 최종 순위 상위부터 배정한다.
   * UCL 5장(잉글랜드·스페인·이탈리아·독일) + 4장(프랑스)은 실제 배정과 같다.
   */
  slots: Record<string, number>;
  /**
   * 리그 페이즈 통과 — 상위 `directSlots`팀은 본선 직행, 그 아래 `playoffSlots`팀은
   * 플레이오프(2차전제)를 거친다. 나머지는 탈락이다.
   *
   * 본선 대진 수는 `directSlots + playoffSlots / 2`이고 **2의 거듭제곱**이어야
   * 한다 (테스트로 고정). 실제 UCL은 36팀 = 8직행 + 16플레이오프 + 12탈락이고,
   * 우리는 5대 리그 배정분만 참가하므로 24 = 8 + 16 + 0이다.
   */
  directSlots: number;
  playoffSlots: number;
  /**
   * 상금 (£) — 참가비 + 리그 페이즈 성적 + 단계 진출 + 우승.
   *
   * ⚠️ **밸런스 임시값.** 실제 UEFA 배분의 비율(UCL : UEL : UECL ≈ 1 : 0.2 : 0.1)을
   * 따르되 우리 경제 규모에 맞춰 눌렀다. 기준: tier 1 구단의 시즌 중계권+스폰서
   * 수입이 약 £228m이고, UCL 우승 경로 총액이 그것의 3분의 1 정도(£64m)가 되게
   * 잡았다. 실제 리그도 UCL 상금이 국내 중계권 수입에 근접하는 규모다.
   * 수치 조정은 이 표만 고치면 된다 (docs/data/competition.md).
   */
  prize: {
    participation: number;
    win: number;
    draw: number;
    /** 이 단계에 진출하면 받는 금액 (플레이오프 포함) */
    stage: Partial<Record<MatchStage, number>>;
    winner: number;
  };
}

/** 대항전 카탈로그 시드 — 편집 전 원본. 읽는 자리는 `cupCatalog()`를 쓴다 */
export const CUP_CATALOG_SEED: readonly CupCatalogEntry[] = [
  {
    id: "ucl",
    name: "UEFA 챔피언스리그",
    short: "UCL",
    size: 24,
    matchesPerTeam: 8,
    slots: { epl: 5, laliga: 5, seriea: 5, bundesliga: 5, ligue1: 4 },
    directSlots: 8,
    playoffSlots: 16,
    prize: {
      participation: 12_000_000,
      win: 1_500_000,
      draw: 500_000,
      stage: {
        playoff: 2_000_000,
        r16: 6_000_000,
        qf: 8_000_000,
        sf: 10_000_000,
        final: 12_000_000,
      },
      winner: 8_000_000,
    },
  },
  {
    id: "uel",
    name: "UEFA 유로파리그",
    short: "UEL",
    size: 16,
    matchesPerTeam: 6,
    slots: { epl: 4, laliga: 3, seriea: 3, bundesliga: 3, ligue1: 3 },
    directSlots: 4,
    playoffSlots: 8,
    prize: {
      participation: 3_500_000,
      win: 500_000,
      draw: 150_000,
      stage: { playoff: 700_000, qf: 2_000_000, sf: 3_000_000, final: 3_500_000 },
      winner: 3_000_000,
    },
  },
  {
    id: "uecl",
    name: "UEFA 컨퍼런스리그",
    short: "UECL",
    size: 10,
    matchesPerTeam: 6,
    slots: { epl: 2, laliga: 2, seriea: 2, bundesliga: 2, ligue1: 2 },
    directSlots: 2,
    playoffSlots: 4,
    prize: {
      participation: 2_000_000,
      win: 300_000,
      draw: 100_000,
      stage: { playoff: 400_000, sf: 1_200_000, final: 1_600_000 },
      winner: 2_000_000,
    },
  },
];

const cups = catalogSource<readonly CupCatalogEntry[]>(
  () => readCupOverride()?.europe ?? CUP_CATALOG_SEED,
);

/** 지금 유효한 대항전 카탈로그 — 오버라이드가 있으면 그것, 없으면 시드 */
export function cupCatalog(): readonly CupCatalogEntry[] {
  return cups();
}

const byId = catalogSource(() => new Map(cupCatalog().map((c) => [c.id, c])));

export function cupCatalogById(id: string): CupCatalogEntry | null {
  return byId().get(id) ?? null;
}

/**
 * 대회 id를 묻는 문들은 **널을 받는다** — 널은 어느 대회에도 속하지 않는 경기,
 * 곧 프리시즌 친선이다(`isFriendly` — competition/friendly.ts). 널을 여기서
 * 막지 않으면 조회가 `leagueName(null)`까지 흘러 **친선이 리그 이름을 달고 나온다**.
 */

/** 유럽 대항전인가 — 유럽 원정비·리그 페이즈 순위표처럼 **대항전 고유**의 판단에 쓴다 */
export function isEuroCup(competitionId: string | null): boolean {
  return competitionId !== null && byId().has(competitionId);
}

/** 컵인가 (유럽 대항전 + 국내 컵) — "리그가 아니다"를 물을 때 쓴다. 친선은 컵도 아니다 */
export function isCup(competitionId: string | null): boolean {
  return competitionId !== null && (byId().has(competitionId) || isDomesticCup(competitionId));
}

/** 대회 표시명 — 리그든 컵이든 competitionId 하나로 이름을 얻는다 */
export function competitionName(competitionId: string | null): string {
  if (competitionId === null) return FRIENDLY_LABEL;
  return (
    byId().get(competitionId)?.name ??
    domesticCupById(competitionId)?.name ??
    leagueName(competitionId)
  );
}

export function competitionShortName(competitionId: string | null): string {
  if (competitionId === null) return FRIENDLY_LABEL;
  return (
    byId().get(competitionId)?.short ??
    domesticCupById(competitionId)?.short ??
    leagueName(competitionId)
  );
}

/** 본선 대진 수 — 직행 + 플레이오프 승자 */
export function knockoutBracketSize(cup: CupCatalogEntry): number {
  return cup.directSlots + cup.playoffSlots / 2;
}

/**
 * 이 대회가 치르는 단계 순서 — 플레이오프부터 결승까지.
 * 본선 대진 수가 대회 규모마다 달라서(UCL 16 · UEL 8 · UECL 4) 시작 단계도 다르다.
 */
export function knockoutStages(cup: CupCatalogEntry): MatchStage[] {
  const bracket = knockoutBracketSize(cup);
  const main: MatchStage[] = [];
  if (bracket >= 16) main.push("r16");
  if (bracket >= 8) main.push("qf");
  if (bracket >= 4) main.push("sf");
  main.push("final");
  return cup.playoffSlots > 0 ? ["playoff", ...main] : main;
}

const STAGE_KO: Record<MatchStage, string> = {
  league: "리그 페이즈",
  playoff: "플레이오프",
  r32: "1라운드",
  r16: "16강",
  qf: "8강",
  sf: "준결승",
  final: "결승",
};

/** 단계 표기 — 달력·일지·브리핑에 쓴다 (2차전제는 차수까지) */
export function stageLabel(stage: MatchStage, round = 1, twoLegged = true): string {
  if (stage === "league") return `R${round}`;
  if (stage === "final" || !twoLegged) return STAGE_KO[stage];
  return `${STAGE_KO[stage]} ${round}차전`;
}

/**
 * 대회에 맞는 단계 표기 — 국내 컵은 대회마다 2차전제 단계가 달라서
 * (리그컵·코파는 준결승만) 대회를 알아야 "1차전"을 붙일지 정할 수 있다.
 * 리그 경기(`stage` 없음)는 `R3`처럼 라운드 번호가 곧 표기다.
 */
export function competitionStageLabel(
  competitionId: string | null,
  stage: MatchStage,
  round = 1,
): string {
  // 친선엔 단계가 없다 — 이름(`competitionShortName`)만으로 다 말한 경기다
  if (competitionId === null) return "";
  const domestic = domesticCupById(competitionId);
  if (domestic) {
    return domesticStageLabel(domestic, stage, round, domestic.twoLegged.includes(stage));
  }
  // 대항전 녹아웃은 결승만 단판이다
  return stageLabel(stage, round, stage !== "final");
}

/**
 * 단계 **이름**만 — 차수를 붙이지 않는다.
 * 추첨처럼 "준결승 1차전"이 아니라 "준결승"이라고 해야 맞는 자리에 쓴다.
 */
/**
 * 대회 이름까지 붙인 경기 표기 — `EPL R3` · `FA컵 16강 1차전` · `친선`.
 * 단계가 없는 경기(친선)는 이름만 남는다 — 빈 단계가 공백으로 새지 않게.
 */
export function competitionLabel(
  competitionId: string | null,
  stage: MatchStage,
  round = 1,
): string {
  const name = competitionShortName(competitionId);
  const label = competitionStageLabel(competitionId, stage, round);
  return label ? `${name} ${label}` : name;
}

/**
 * 감독의 달력·요약에 서는 표기 — `R3` · `FA컵 16강` · `친선`.
 *
 * `competitionLabel`과 갈리는 곳은 **리그**다. 감독은 자기 리그가 무엇인지 알고
 * 있으므로 일정의 매 줄에 리그 이름을 붙이지 않는다. 컵과 친선은 어느 경기인지가
 * 곧 정보라 이름이 선다.
 */
export function fixtureLabel(competitionId: string | null, stage: MatchStage, round = 1): string {
  if (competitionId === null) return FRIENDLY_LABEL;
  return isCup(competitionId)
    ? competitionLabel(competitionId, stage, round)
    : competitionStageLabel(competitionId, stage, round);
}

export function competitionStageName(competitionId: string | null, stage: MatchStage): string {
  if (competitionId === null) return "";
  const domestic = domesticCupById(competitionId);
  return domestic ? domesticStageLabel(domestic, stage) : stageLabel(stage, 1, false);
}
