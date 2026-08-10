/**
 * **시장 카드** — 협상·스카우트가 채팅에 남기는 카드.
 *
 * 이 스킬들에는 갈 화면이 없다: 진행 중인 협상은 어느 장부에도 실리지 않고,
 * 파견한 스카우트는 아직 아무것도 바꾸지 않았다. 그렇다고 칩 속에 줄글로 접어
 * 두면 조건을 견주려 매번 펼쳐야 한다 — 금액·확률·기한은 다음 판단의 **입력**이라
 * 카드로 세운다.
 *
 * 값은 **숫자 그대로** 싣는다(원 단위). `£42M` 같은 표기는 화면의 것이다.
 */

/** 카드가 말하는 국면 */
export type MarketCardKind =
  /** 우리가 넣은 오퍼 — 답을 기다린다 */
  | "offer"
  /** 상대의 답 — 수락·거절·역제안 */
  | "verdict"
  /** 재계약 제안 */
  | "renewal"
  /** 협상을 접었다 */
  | "withdraw"
  /** 스카우트 파견 — 보고서는 며칠 뒤에 온다 */
  | "scout";

/** 조건 한 벌 — 없는 값은 싣지 않는다 (임대는 이적료가 임대료다) */
export interface MarketTerms {
  fee?: number;
  weeklyWage?: number;
  years?: number;
}

export interface MarketCard {
  kind: MarketCardKind;
  playerId: string;
  playerName: string;
  /** 선수의 지금 소속 — 매각이면 사려는 구단 */
  counterpart: string;
  /** 우리가 낸 조건 */
  terms?: MarketTerms;
  /** 상대가 부르는 조건 — 역제안일 때만 */
  counterTerms?: MarketTerms;
  verdict?: "accept" | "reject" | "counter";
  /**
   * 성사 가능성 — 이미 **읽을 수 있는 표기**다(`34%` 또는 `반반`).
   * 안개가 남은 선수는 퍼센트를 단정하지 않으므로(scouting) 코어가 그 판단까지 해서 보낸다.
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
}
