/**
 * 징계 규정 카탈로그 — **대회마다 다른 눈금, 협회마다 다른 범위**
 * (→ docs/simulation/match.md §6 · docs/data/competition.md §1).
 *
 * 리그·컵 카탈로그 항목의 필드가 아니라 id로 여는 **별도의 표**다. 더비 표
 * (`derbies.ts`)와 같은 결이고, 이유도 같다: 퇴장 정지의 범위는 대회가 아니라
 * **협회**의 규정이라 잉글랜드의 리그와 두 컵이 한 값(`eng`)을 나눠 가져야 하고,
 * 항목마다 복사해 두면 어드민 편집 한 번이 규정이 묶어 둔 것을 갈라놓는다.
 *
 * 값은 실제 규정을 그대로 옮긴 것이다 — 근거는 match.md §6에 적혀 있다.
 */
import { YELLOWS_PER_SUSPENSION, type DisciplineRule, type Suspension } from "@story-fm/domain";
import { competitionShortName } from "./cup-catalog";

/** 관할 — 이 키를 나눠 갖는 대회들이 퇴장 정지를 함께 진다 */
export const DISCIPLINE_JURISDICTIONS = ["eng", "esp", "ita", "ger", "fra", "uefa"] as const;
export type DisciplineJurisdiction = (typeof DISCIPLINE_JURISDICTIONS)[number];

/**
 * 유럽 대부분의 리그·컵이 쓰는 꼴 — **5장마다 1경기, 그 대회 안에서만.**
 * 라리가·분데스리가·리그 1과 네 나라 국내 컵이 이 모양이다.
 */
const everyFive = (jurisdiction: DisciplineJurisdiction): DisciplineRule => ({
  jurisdiction,
  steps: [{ at: YELLOWS_PER_SUSPENSION, matches: 1 }],
  cycle: YELLOWS_PER_SUSPENSION,
  redScope: "competition",
});

/**
 * 단판 슈퍼컵 — 한 경기짜리 대회라 누적이 설 자리가 없다. 퇴장 정지는 그 나라의
 * 다음 국내 경기로 간다(잉글랜드는 관할, 나머지는 그 대회뿐이라 사실상 소멸).
 */
const oneOff = (
  jurisdiction: DisciplineJurisdiction,
  redScope: DisciplineRule["redScope"],
): DisciplineRule => ({ jurisdiction, steps: [], cycle: null, redScope });

/**
 * 잉글랜드 리그 — **매치위크 문턱이 있는 유일한 나라다.** FA 규정의 5장은 "첫
 * 19경기 안"이라 20라운드에 닿은 5장은 정지가 아니고, 눈금이 올라갈수록 정지도
 * 길어진다. 20장이 끝이라 되풀이 주기가 없다.
 */
const ENGLISH_LEAGUE: DisciplineRule = {
  jurisdiction: "eng",
  steps: [
    { at: 5, matches: 1, by: 19 },
    { at: 10, matches: 2, by: 32 },
    { at: 15, matches: 3, by: 38 },
    { at: 20, matches: 4 },
  ],
  cycle: null,
  redScope: "jurisdiction",
};

/**
 * 세리에 A — 눈금 사이가 **점점 좁아진다**(5·9·13·16·18). 19장부터는 한 장마다
 * 정지라 주기가 1이다.
 */
const ITALIAN_LEAGUE: DisciplineRule = {
  jurisdiction: "ita",
  steps: [5, 9, 13, 16, 18].map((at) => ({ at, matches: 1 })),
  cycle: 1,
  redScope: "competition",
};

const SPANISH_LEAGUE = everyFive("esp");
const GERMAN_LEAGUE = everyFive("ger");
/**
 * 리그 1 — 2025/26부터 「10경기 안 3장」의 창 규칙을 버리고 시즌 5장이 되었다.
 * 그래서 코어에 창 규칙이 없다: 옛 규정을 넣으면 감독이 아는 지금의 규정과 어긋난다.
 */
const FRENCH_LEAGUE = everyFive("fra");

const DISCIPLINE: Readonly<Record<string, DisciplineRule>> = {
  epl: ENGLISH_LEAGUE,
  laliga: SPANISH_LEAGUE,
  seriea: ITALIAN_LEAGUE,
  bundesliga: GERMAN_LEAGUE,
  ligue1: FRENCH_LEAGUE,

  /**
   * **2부도 규정을 갖는다.** 리그전은 돌지 않지만(국내 컵 인원이다) 감독이 강등되면
   * 그 리그가 일정을 돌고, 어드민이 `playable`로 바꿀 수도 있다. 규정은 협회의
   * 것이므로 1부와 **한 값을 나눠 갖는다** — 복사본이 아니라 같은 객체다.
   */
  championship: ENGLISH_LEAGUE,
  segunda: SPANISH_LEAGUE,
  serieb: ITALIAN_LEAGUE,
  bundesliga2: GERMAN_LEAGUE,
  ligue2: FRENCH_LEAGUE,

  /**
   * 잉글랜드 두 컵 — 3라운드 진입 클럽(우리 세계의 1부 전부)은 **2장**이면 정지고,
   * 그 뒤로도 두 장마다다. 누적은 8강까지만 센다.
   */
  facup: {
    jurisdiction: "eng",
    steps: [{ at: 2, matches: 1 }],
    cycle: 2,
    amnestyAfter: "qf",
    redScope: "jurisdiction",
  },
  eflcup: {
    jurisdiction: "eng",
    steps: [{ at: 2, matches: 1 }],
    cycle: 2,
    amnestyAfter: "qf",
    redScope: "jurisdiction",
  },
  copadelrey: everyFive("esp"),
  coppaitalia: everyFive("ita"),
  dfbpokal: everyFive("ger"),
  coupedefrance: everyFive("fra"),

  /**
   * 대항전 셋은 한 관할이다 — UEFA의 정지는 UCL·UEL·UECL을 가리지 않는다.
   * 3장에서 걸리고 그 뒤로는 홀수 장(5·7·9)마다, 8강이 끝나면 지워진다.
   */
  ucl: {
    jurisdiction: "uefa",
    steps: [{ at: 3, matches: 1 }],
    cycle: 2,
    amnestyAfter: "qf",
    redScope: "jurisdiction",
  },
  uel: {
    jurisdiction: "uefa",
    steps: [{ at: 3, matches: 1 }],
    cycle: 2,
    amnestyAfter: "qf",
    redScope: "jurisdiction",
  },
  uecl: {
    jurisdiction: "uefa",
    steps: [{ at: 3, matches: 1 }],
    cycle: 2,
    amnestyAfter: "qf",
    redScope: "jurisdiction",
  },

  communityshield: oneOff("eng", "jurisdiction"),
  supercopa: oneOff("esp", "competition"),
  supercoppa: oneOff("ita", "competition"),
  dflsupercup: oneOff("ger", "competition"),
  trophee: oneOff("fra", "competition"),
  uefasupercup: oneOff("uefa", "jurisdiction"),
};

const byId = new Map<string, DisciplineRule>(Object.entries(DISCIPLINE));

/**
 * 이 대회의 규정 — **널이면 대회가 아니다.** 친선(`competitionId: null`)과 2군
 * 리그(`reserve:*`)가 그렇고, 카드가 쌓이지도 정지가 소화되지도 않는다.
 */
export function disciplineOf(competitionId: string | null): DisciplineRule | null {
  return competitionId === null ? null : (byId.get(competitionId) ?? null);
}

/**
 * 관할의 이름 — **감독이 읽을 「어느 경기가 막히는가」**다 (match.md §6).
 *
 * 퇴장 정지가 관할 전체에 걸리면 대회 이름으로는 뜻이 서지 않는다: FA컵에서 받은
 * 퇴장이 막는 것은 FA컵이 아니라 다음 국내 경기다.
 */
export const JURISDICTION_KO: Readonly<Record<string, string>> = {
  eng: "잉글랜드 국내 대회",
  esp: "스페인 국내 대회",
  ita: "이탈리아 국내 대회",
  ger: "독일 국내 대회",
  fra: "프랑스 국내 대회",
  uefa: "유럽 대항전",
};

/** 이 대회가 속한 관할 — 규정을 모르는 대회는 널이다 */
export function disciplineJurisdictionOf(competitionId: string | null): string | null {
  return disciplineOf(competitionId)?.jurisdiction ?? null;
}

/**
 * 이 정지가 **이 경기에 걸리는가** (match.md §6).
 *
 * 대회를 모르는 줄은 전 대회다 — 옛 세이브가 들고 있는 정지는 대회가 적히기 전의
 * 것이라, 어느 경기든 막고 어느 경기로든 소화된다.
 */
export function suspensionApplies(
  suspension: { competitionId?: string; scope?: string },
  competitionId: string | null,
): boolean {
  if (suspension.competitionId === undefined) return true;
  if (suspension.competitionId === competitionId) return true;
  if (suspension.scope !== "jurisdiction") return false;
  const here = disciplineJurisdictionOf(competitionId);
  return here !== null && here === disciplineJurisdictionOf(suspension.competitionId);
}

/**
 * 이 정지가 **막는 것의 이름** — 감독이 "어느 경기를 못 나오나"를 읽는 자리다
 * (match.md §6). 라인업 줄·선수 카드·GM 스냅샷이 같은 낱말을 써야 감독이 같은
 * 사실로 읽는다. 대회를 모르는 옛 줄은 전 대회다.
 */
export function suspensionScopeName(suspension: Suspension): string {
  const { competitionId, scope } = suspension;
  if (competitionId === undefined) return "전 대회";
  if (scope !== "jurisdiction") return competitionShortName(competitionId);
  const jurisdiction = disciplineJurisdictionOf(competitionId);
  return (
    (jurisdiction === null ? undefined : JURISDICTION_KO[jurisdiction]) ??
    competitionShortName(competitionId)
  );
}
