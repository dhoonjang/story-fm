/**
 * 슈퍼컵 카탈로그 — 커뮤니티 실드·수페르코파·DFL-슈퍼컵·트로페 데 샹피옹·UEFA 슈퍼컵.
 *
 * **대회 하나가 경기 하나다.** 리그 페이즈도 브래킷도 없고, 지난 시즌이 낳은 두
 * 우승자가 중립 구장에서 한 번 붙어 그날 트로피가 나온다. 국내 컵·대항전 카탈로그와
 * 갈라 둔 이유가 그것이다 — 라운드가 없는 대회에 라운드 기계(진입 라운드·추첨·
 * 2차전제·단계별 목표일)를 붙이면 다섯 단계짜리 표에 빈 칸이 넷 생긴다.
 *
 * 대진은 카탈로그가 갖지 않는다. **지난 시즌의 사실**에서 나오므로(리그 우승·컵
 * 우승·대항전 우승) 여기 적을 수 있는 것은 "어느 두 자리인가"(`kind`)뿐이고, 그
 * 자리를 채우는 것은 `competition/super-cup.ts`다 (competition.md §4-1).
 *
 * 어드민 편집을 받지 않는 유일한 대회 표다 — 규모도 티켓도 목표일도 없어 조정할
 * 손잡이가 상금뿐이고, 그 상금은 한 경기의 몫이라 세계를 흔들지 않는다.
 */

export interface SuperCupEntry {
  id: string;
  name: string;
  /** 달력·일지에 붙는 짧은 표기 */
  short: string;
  /**
   * 대진이 어디서 오는가.
   *
   * - `domestic` — 그 나라 **1부 리그 우승** vs **메이저 컵(`prestige: 1`) 우승**.
   *   한 클럽이 둘 다 가지면 리그 준우승팀이 상대다 (실제 규정과 같다).
   * - `european` — **UCL 우승** vs **UEL 우승**.
   */
  kind: "domestic" | "european";
  /** `domestic`이 대진을 찾는 나라. `european`은 유럽 전체라 없다 */
  country?: string;
  /**
   * 상금 (£) — 한 경기의 몫이라 국내 컵 우승 상금보다도 작다. 스페인·이탈리아만
   * 높은 것은 그 둘이 실제로 해외(사우디)에 팔리는 대회이기 때문이다.
   */
  prize: { winner: number; runnerUp: number };
}

/** 슈퍼컵 카탈로그 — 국내 다섯 + 유럽 하나 */
export const SUPER_CUP_CATALOG: readonly SuperCupEntry[] = [
  {
    id: "communityshield",
    name: "커뮤니티 실드",
    short: "실드",
    kind: "domestic",
    country: "잉글랜드",
    // 실제 수익은 전액 자선 기부라 구단 몫이 상징적이다
    prize: { winner: 1_000_000, runnerUp: 500_000 },
  },
  {
    id: "supercopa",
    name: "수페르코파 데 에스파냐",
    short: "수페르코파",
    kind: "domestic",
    country: "스페인",
    // 사우디 개최 계약분 — 4팀 준결승제를 한 경기로 줄였어도 돈은 그 규모다
    prize: { winner: 4_000_000, runnerUp: 2_000_000 },
  },
  {
    id: "supercoppa",
    name: "수페르코파 이탈리아나",
    short: "수페르코파 이탈리아나",
    kind: "domestic",
    country: "이탈리아",
    prize: { winner: 4_000_000, runnerUp: 2_000_000 },
  },
  {
    id: "dflsupercup",
    name: "DFL-슈퍼컵",
    short: "슈퍼컵",
    kind: "domestic",
    country: "독일",
    prize: { winner: 1_000_000, runnerUp: 500_000 },
  },
  {
    id: "trophee",
    name: "트로페 데 샹피옹",
    short: "트로페",
    kind: "domestic",
    country: "프랑스",
    prize: { winner: 1_000_000, runnerUp: 500_000 },
  },
  {
    id: "uefasupercup",
    name: "UEFA 슈퍼컵",
    short: "UEFA 슈퍼컵",
    kind: "european",
    // 실제 UEFA 배분(양 팀 €5M + 우승 €1M)을 대항전 상금과 같은 눈금으로 눌렀다
    prize: { winner: 4_000_000, runnerUp: 3_000_000 },
  },
];

const byId = new Map(SUPER_CUP_CATALOG.map((c) => [c.id, c]));

export function superCupById(id: string | null): SuperCupEntry | null {
  return id === null ? null : (byId.get(id) ?? null);
}

/** 슈퍼컵인가 — 대회를 세는 자리가 "한 경기짜리"를 가려낼 때 쓴다 */
export function isSuperCup(competitionId: string | null): boolean {
  return competitionId !== null && byId.has(competitionId);
}
