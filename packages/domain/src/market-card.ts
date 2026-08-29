/**
 * **시장 카드** — 협상·스카우트가 채팅에 남기는 카드.
 *
 * 이 호출들에는 갈 화면이 없다: 진행 중인 협상은 어느 장부에도 실리지 않고,
 * 파견한 스카우트는 아직 아무것도 바꾸지 않았다. 그렇다고 칩 속에 줄글로 접어
 * 두면 조건을 견주려 매번 펼쳐야 한다 — 금액·확률·기한은 다음 판단의 **입력**이라
 * 카드로 세운다.
 *
 * 값은 **숫자 그대로** 싣는다(원 단위). `£42M` 같은 표기는 화면의 것이다.
 */

/**
 * **거래의 방향** — 선수가 우리 쪽으로 오는가(`in`), 우리에게서 나가는가(`out`).
 *
 * `loan`만으로는 갈리지 않는다: 빌려오는 것도 빌려주는 것도 임대다. 방향과 임대
 * 여부가 함께 갈래 하나를 정한다.
 */
export type MarketDirection = "in" | "out";

/** 갈래의 이름 — 요약 줄·주의 줄·카드 배지가 한 낱말을 함께 쓴다 */
export function marketDirectionKo(direction: MarketDirection, loan = false): string {
  if (direction === "in") return loan ? "임대 영입" : "영입";
  return loan ? "임대 송출" : "매각";
}

/** 카드가 말하는 국면 */
export type MarketCardKind =
  /** 우리가 넣은 오퍼 — 답을 기다린다 */
  | "offer"
  /** 상대의 답 — 수락·거절·조정 */
  | "verdict"
  /** 재계약 제안 */
  | "renewal"
  /** 상호 계약 해지 제안 — 정산금을 부른다 */
  | "release"
  /** 협상을 접었다 */
  | "withdraw"
  /** 스카우트 파견 — 보고서는 며칠 뒤에 온다 */
  | "scout";

/** 조건 한 벌 — 없는 값은 싣지 않는다 (임대는 이적료가 임대료다) */
export interface MarketTerms {
  fee?: number;
  weeklyWage?: number;
  years?: number;
  /**
   * 해지 정산금 — **이적료 자리를 빌리지 않는다.** 같은 숫자를 `fee`에 실으면
   * 화면이 `이적료`라 이름 붙여, 나가는 선수에게 우리가 이적료를 낸 것으로 읽힌다.
   */
  severance?: number;
  /** 분할 지급 연수 — 2 이상일 때만 싣는다 (일시금은 조건이 아니다 · transfer.md §5-2) */
  paymentYears?: number;
}

export interface MarketCard {
  kind: MarketCardKind;
  /**
   * 이 카드가 가리키는 것 — 대개 선수 id다. **스카우트 임무만 임무 id를 든다**:
   * 조건으로 나가는 파견에는 선수가 없다 (`scout_mission` — docs/data/player.md §9.4).
   * 카드를 그리는 쪽은 이 값을 열쇠로만 쓰고 선수로 되풀지 않는다.
   */
  playerId: string;
  /** 누구인가 — 임무 카드에서는 **무엇을 찾는가**(조건 한 줄)가 그 자리에 선다 */
  playerName: string;
  /**
   * 거래 상대 구단 — 데려오는 거래면 선수의 지금 소속, 내보내는 거래면 사려는 구단.
   * 임무 카드에서는 **뒤지는 곳**(대회)이다.
   */
  counterpart: string;
  /** 우리가 낸 조건 */
  terms?: MarketTerms;
  /** 상대가 부르는 조건 — 조정일 때만 */
  counterTerms?: MarketTerms;
  verdict?: "accept" | "reject" | "counter";
  /**
   * 성사 가능성 — 이미 **읽을 수 있는 표기**다(`34%` 또는 `반반이다`).
   * 안개가 남은 선수는 퍼센트를 단정하지 않으므로(scouting) 코어가 그 판단까지 해서 보낸다.
   *
   * **답이 남은 카드에만 싣는다** — 오퍼·조정·재계약. 끝난 판정(수락·거절)에서
   * 사전 확률은 다음 판단의 입력이 아니다 (transfer.md §3).
   */
  odds?: string;
  /** 답이 오는 날 · 보고가 오는 날 */
  dueOn?: string;
  /** 설득 논거와 그 결과 — 통한 것만이 협상의 여유를 넓힌다 */
  pitch?: Array<{ label: string; verified: boolean }>;
  /** 상대의 한마디 — LLM이 쓴 문장 */
  note?: string;
  /** 임대인가 — 같은 금액이 이적료가 아니라 임대료다 */
  loan?: boolean;
  /**
   * **방향** — 데려오는 거래인가(`in`) 내보내는 거래인가(`out`).
   *
   * 카드만 봐서는 사는 건지 파는 건지 알 수 없어서 생긴 축이다. 재계약처럼 방향이
   * 없는 카드에는 서지 않고, 이 축이 생기기 전에 남은 카드에도 없다 — 그래서 optional.
   */
  direction?: MarketDirection;
  /**
   * **사전 계약인가** — 이적료 없이 다음 7월 1일 합류를 미리 약속하는 영입
   * (→ docs/simulation/transfer.md §1-4).
   *
   * 방향(`in`)만으로는 평범한 영입과 갈리지 않는데, 감독이 읽어야 하는 사실은
   * "지금 오는 게 아니라 여름에 온다"는 것이다 — 배지가 그 낱말을 든다.
   */
  precontract?: boolean;
}
