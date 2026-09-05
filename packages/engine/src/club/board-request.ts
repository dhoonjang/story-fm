import type {
  BoardCondition,
  BoardConditionKind,
  BoardRequest,
  BoardRequestKind,
} from "@story-fm/domain";
import { BOARD_REQUEST_LABEL, boardRequestAmountText } from "@story-fm/domain";
import type { GameState } from "../core/state";
import {
  clubProfileIn,
  financeOf,
  managedTeamId,
  playerById,
  pushNarrative,
  weeklyWagesOf,
} from "../core/state";
import { addDays, diffDays, seasonYear } from "../core/dates";
import { pickAnyPlayer } from "../core/player-ref";
import { touchOpenings } from "../world/openings";
import { ownerOf } from "../world/persona";
import { USER_WAGE_HEADROOM, clubWageBudget, wageRoomOf } from "../world/wages";
import {
  formatMoney,
  recordCapitalAsset,
  seasonBudgetBaseOf,
  seasonWageRatio,
  STADIUM_ASSET_MONTHS,
} from "./finance";
import { item } from "../commands/brief";
import type { CommandResult } from "../commands";

/**
 * 감독이 보드에 거는 요청 — **`board-demand.ts`와 방향이 반대인 별개 상태다**
 * (finance.md §9.6 · career.md §5.3).
 *
 * 저쪽은 구단주가 감독에게 조건을 걸고 이행 여부가 보드 평판을 옮긴다. 이쪽은
 * 감독이 거는 쪽이고, **답은 평판을 옮기지 않는다** — 보드 평판은 여기서 입력이지
 * 출력이다. 묻는 것에 값을 매기면 감독은 묻지 않게 되고 그러면 이 길이 없는 것과 같다.
 *
 * 코어는 접수(`requestBoard`)와 판정(`tickBoardRequests`)만 한다. 보드가 무슨 말로
 * 그렇게 답했는지는 GM이 쓴다 (overview.md §1 철칙 4).
 */
export const BOARD_REQUEST = {
  /** 답이 오는 데 걸리는 날 — 예산 한 줄은 재무이사가 답하고 구장은 이사회 안건이다 */
  RESPOND_DAYS: {
    "transfer-budget": 3,
    // 노리는 선수는 사흘을 기다려 주지 않는다 — 이사회 안건이 아니라 전화 한 통이다
    signing: 2,
    "wage-room": 5,
    stadium: 10,
  } as Record<BoardRequestKind, number>,
  /** 같은 종류를 다시 걸기까지 — 종류가 다르면 곧바로 걸 수 있다 */
  COOLDOWN_DAYS: 60,
  /** 신뢰 계수의 바닥 보드 평판 — 이 아래는 무엇을 물어도 0이다 */
  TRUST_FLOOR: 30,
  /** 신뢰 계수가 1.0에 닿는 눈금 폭 — 평판 80이 1.0이다 */
  TRUST_SPAN: 50,
  /** 신뢰 계수의 상한 — 평판 100이어도 여력의 1.2배까지다 */
  TRUST_MAX: 1.2,
  /** 살림 계수의 계단 — 시즌 급여 비중 (finance.md §9.3의 경고선 그대로) */
  WAGE_RATIO_CAUTION: 0.65,
  WAGE_RATIO_DANGER: 0.75,
  /**
   * 이적 예산 여력 = **시즌 예산 기준액**(`seasonBudgetBaseOf`) × 이것.
   *
   * 자가 잔고이면 현금이 불수록 물어서 받는 값이 함께 불어 요청이 화수분이 된다
   * (4시즌 뒤 £1,138M 잔고 → 한 번 물어 £275M — finance.md §9.6). 보드가 한 시즌에
   * 얹어 주는 돈은 그 구단이 원래 한 시즌에 쓰는 돈의 배수여야 체급을 타되 시간에
   * 불지 않는다.
   *
   * 0.6인 이유: 새 게임의 잔고는 기준액의 2.1~2.7배라(`TIER_FINANCE`) 옛 계수 0.25가
   * t=0에서 서 있던 자리가 기준액의 0.52~0.67배다 — 시작의 눈금은 그대로다.
   */
  BUDGET_OF_BASE: 0.6,
  /**
   * 건별 영입 여력 = 기준액 × 이것 − 걸려 있는 승인분.
   *
   * 총액 증액(0.6)보다 큰 것이 이 종류가 있는 이유다 — 백지수표와 이름 붙은 선수
   * 하나는 보드에게 다른 일이다. 대신 그 선수 밖으로는 한 푼도 못 나간다.
   * 옛 계수 0.40이 t=0에서 서 있던 자리가 기준액의 0.83~1.07배다.
   */
  SIGNING_OF_BASE: 1.0,
  /** 승인분이 그 선수 앞에 걸려 있는 기간 — 만료가 없으면 허가가 아니라 예산이다 */
  EARMARK_DAYS: 60,
  /** 되걸기가 서는 문턱 — 한도가 부른 값의 이만큼을 넘으면 조건 없이 그만큼 내준다 */
  CONDITION_GAP: 0.9,
  /** 되건 조건의 기한 — 같은 안건의 쿨다운(60)보다 짧아야 두 길이 겹치지 않는다 */
  CONDITION_DAYS: 30,
  /** `wage-cut` 조건이 요구하는 주급 총액 감축 폭 — 주전급 한 명이거나 백업 둘이다 */
  WAGE_CUT_RATIO: 0.05,
  /** 주급 한도 여력 = 구단 주간 임금 예산 × 이것 (시즌 누계 상한이기도 하다) */
  WAGE_LIFT_OF_BUDGET: 0.1,
  /** 구장 증설 여력 = 지금 수용인원 × 이것 */
  SEATS_OF_CAPACITY: 0.2,
  /** 좌석 하나를 얹는 공사비 — 신축(석당 £16k)보다 싼 증설의 값 */
  SEAT_COST: 8_000,
  /** 공사비가 잔고에서 가져갈 수 있는 몫 */
  BUILD_OF_BALANCE: 0.5,
  /** 착공에서 개장까지 — 한 시즌 안에는 열리지 않는다 */
  BUILD_DAYS: 270,
  /** 상태에 남기는 지난 요청 수 — 구단주 요청·다가옴과 같은 규약 */
  KEPT: 20,
} as const;

/**
 * 원형 → 되걸기의 갈래 (people.md §2의 구단주 6종). **여섯 원형 밖의 카드는 되걸지
 * 않는다** — `DEMAND_OF_ARCHETYPE`과 같은 규약이다.
 *
 * 여기 없는 셋(축구광형·국부펀드형·흥행가형)은 부분 승인으로 답한다: 감정의 사람과
 * 자원이 넉넉한 사람과 즉흥적인 사람은 조건을 붙이고 기다리지 않는다.
 */
export const CONDITION_OF_ARCHETYPE: Record<string, BoardConditionKind> = {
  투자자형: "raise",
  "지역 유지형": "raise",
  산업가형: "wage-cut",
};

/**
 * **되걸 수 있는 종류** — 조건은 돈을 만들어 오라는 말이라 답도 돈이어야 한다.
 * 매각 대금은 주급 천장을 올리지도 벽돌을 쌓지도 않는다 (finance.md §9.6).
 */
const COUNTERABLE: ReadonlySet<BoardRequestKind> = new Set(["transfer-budget", "signing"]);

/**
 * **답이 끝나지 않은 요청** — 한 번에 하나라 언제나 하나뿐이다.
 *
 * 조건부 승인도 여기 든다: 되건 조건이 테이블에 있는데 다른 안건을 꺼내는 것은
 * 흥정이 아니라 화제를 바꾸는 것이다 (finance.md §9.6).
 */
export function openBoardRequest(state: GameState): BoardRequest | null {
  return (
    (state.boardRequests ?? []).find((r) => r.status === "pending" || r.status === "conditional") ??
    null
  );
}

/** 아직 좌석이 서지 않은 승인된 공사 — 있으면 구장을 다시 걸 수 없다 */
function buildingStadium(state: GameState): BoardRequest | null {
  return (
    (state.boardRequests ?? []).find(
      (r) => r.kind === "stadium" && r.status === "approved" && r.deliveredOn === undefined,
    ) ?? null
  );
}

// ── 한도 ───────────────────────────────────────────────────────

/**
 * 보드가 이 감독을 얼마나 믿는가 — 0 \~ 1.2.
 *
 * 평판 30 이하면 0이라 무엇을 물어도 거절이고, 80이면 여력 그대로, 100이면 1.2배다.
 */
export function boardTrustFactor(boardReputation: number): number {
  const raw = (boardReputation - BOARD_REQUEST.TRUST_FLOOR) / BOARD_REQUEST.TRUST_SPAN;
  return Math.min(BOARD_REQUEST.TRUST_MAX, Math.max(0, raw));
}

/**
 * 살림이 새고 있는가 — 1.0 · 0.5 · 0.
 *
 * 시즌 급여 비중이 위험선(75%)을 넘은 구단에는 더 얹지 않는다. 경고선은 월간
 * 보고서 노트가 쓰는 그 값이다 (finance.md §9.3).
 */
export function boardThriftFactor(wageRatio: number): number {
  if (wageRatio >= BOARD_REQUEST.WAGE_RATIO_DANGER) return 0;
  if (wageRatio >= BOARD_REQUEST.WAGE_RATIO_CAUTION) return 0.5;
  return 1;
}

/**
 * 종류별 여력 — 계수가 걸리기 전의 날것.
 *
 * **돈의 두 종류는 기준액을, 구장은 잔고를 본다** (finance.md §9.6). 예산과 영입 허가는
 * 보드가 내주는 한도라 그 구단이 한 시즌에 쓰는 돈의 배수여야 하고, 좌석은 허가가
 * 아니라 공사비라 그날 현금이 실제로 나간다.
 */
function headroomOf(state: GameState, kind: BoardRequestKind): number {
  const teamId = state.userTeamId;
  const finance = financeOf(state, teamId);
  const balance = Math.max(0, finance.balance);
  const base = seasonBudgetBaseOf(state, teamId);
  switch (kind) {
    case "transfer-budget":
      return base * BOARD_REQUEST.BUDGET_OF_BASE;
    case "signing":
      /**
       * 이미 걸려 있는 승인분을 뺀다 — `wage-room`이 이번 시즌 누계를 빼는 것과 같은
       * 자다. 없으면 승인 하나마다 기준액만큼이 새로 서서 허가 셋이 세 시즌치 예산이 된다.
       */
      return Math.max(0, base * BOARD_REQUEST.SIGNING_OF_BASE - earmarkedTotal(state));
    case "wage-room":
      return Math.max(
        0,
        clubWageBudget(teamId, undefined, state) * BOARD_REQUEST.WAGE_LIFT_OF_BUDGET -
          wageLiftOf(state, state.userTeamId),
      );
    case "stadium": {
      const seats = clubProfileIn(state, teamId).capacity * BOARD_REQUEST.SEATS_OF_CAPACITY;
      // 공사비가 잔고의 절반을 넘지 못한다 — 여력이 좌석이어도 나가는 것은 현금이다
      const affordable = (balance * BOARD_REQUEST.BUILD_OF_BALANCE) / BOARD_REQUEST.SEAT_COST;
      return Math.min(seats, affordable);
    }
  }
}

/**
 * **보드가 이번에 내줄 수 있는 최대치** — 굴리지 않는다 (overview.md §1 철칙 2).
 *
 * `여력 × 신뢰 계수 × 살림 계수`. 이적 예산이 동결이면(PSR·부채 — §9.2·§9.4) 네
 * 종류 다 0이다: 돈의 문제가 아니라 규정의 문제라 물어서 풀리지 않는다.
 */
export function boardRequestCeiling(state: GameState, kind: BoardRequestKind): number {
  if (financeOf(state, state.userTeamId).budgetFrozen === true) return 0;
  const factor =
    boardTrustFactor(state.manager.reputation.board) * boardThriftFactor(seasonWageRatio(state));
  return Math.floor(headroomOf(state, kind) * factor);
}

// ── 접수 (명령) ────────────────────────────────────────────────

export interface RequestBoardInput {
  kind: BoardRequestKind;
  amount: number;
  /** `signing`만 — 감독이 부른 선수의 이름이나 id (다른 종류에는 실리지 않는다) */
  playerId?: string;
}

/**
 * `request_board` — 감독이 보드에 건다. **접수만 한다.**
 *
 * 물은 자리에서 답이 나오면 보드가 사람이 아니라 자판기가 된다. 판정은 답이
 * 도착하는 날의 tick이 그날의 장부로 한다 (`tickBoardRequests`).
 */
export function requestBoard(state: GameState, input: RequestBoardInput): CommandResult {
  if (managedTeamId(state) === null) {
    return { ok: false, message: "무직입니다 — 요청을 걸 보드가 없습니다" };
  }
  const amount = Math.floor(input.amount);
  if (amount <= 0) return { ok: false, message: "요청할 값이 0입니다" };

  const open = openBoardRequest(state);
  if (open) {
    return {
      ok: false,
      message: `이미 보드의 답을 기다리는 요청이 있습니다 — ${BOARD_REQUEST_LABEL[open.kind]} (${open.respondOn}에 답이 옵니다)`,
    };
  }

  const last = [...(state.boardRequests ?? [])]
    .reverse()
    .find((r) => r.kind === input.kind && r.resolvedOn !== undefined);
  if (last?.resolvedOn) {
    const left = BOARD_REQUEST.COOLDOWN_DAYS - diffDays(last.resolvedOn, state.date);
    if (left > 0) {
      return {
        ok: false,
        message: `${BOARD_REQUEST_LABEL[input.kind]}은 ${last.resolvedOn}에 답을 받았습니다 — 같은 안건은 ${left}일 뒤에 다시 걸 수 있습니다`,
      };
    }
  }

  if (input.kind === "stadium") {
    const building = buildingStadium(state);
    if (building?.deliversOn) {
      return {
        ok: false,
        message: `공사가 진행 중입니다 — ${building.granted ?? 0}석이 ${building.deliversOn}에 섭니다`,
      };
    }
  }

  /**
   * **`signing`은 이름 하나를 지목한다.** 감독이 부른 이름을 여기서 id로 옮긴다 —
   * 갈리면 후보를 돌려 GM이 되묻는다 (`core/player-ref.ts`). 우리 선수를 두고
   * 영입 승인을 물을 자리는 없다.
   */
  let playerId: string | undefined;
  if (input.kind === "signing") {
    if (!input.playerId) {
      return { ok: false, message: "영입 승인은 어느 선수인지 함께 말해야 합니다" };
    }
    const picked = pickAnyPlayer(state, input.playerId);
    if (!picked.ok) return { ok: false, message: picked.message };
    if (picked.player.teamId === state.userTeamId) {
      return { ok: false, message: `${picked.player.name}은(는) 이미 우리 선수입니다` };
    }
    playerId = picked.player.id;
  }

  const requests = (state.boardRequests ??= []);
  const respondOn = addDays(state.date, BOARD_REQUEST.RESPOND_DAYS[input.kind]);
  const request: BoardRequest = {
    id: `board-request-${state.date}-${input.kind}`,
    kind: input.kind,
    askedOn: state.date,
    respondOn,
    amount,
    ...(playerId !== undefined ? { playerId } : {}),
    status: "pending",
  };
  requests.push(request);

  const line = `보드 요청 — ${describeAsk(state, request)} · 답 ${respondOn}`;
  pushNarrative(state, line, 3);
  // 보드에 요청을 건 것이 구단주에게 걸린 실마리를 닫는다 (career.md §1)
  touchOpenings(state, { subjectIds: [ownerOf(state).characterId], kinds: ["board"] });
  return {
    ok: true,
    message: `${line}. 보드가 검토합니다 — 답은 ${respondOn}에 옵니다`,
    brief: {
      head: "보드 요청",
      items: [
        item({ label: BOARD_REQUEST_LABEL[input.kind], text: askText(state, request) }),
        item({ label: "답", text: respondOn }),
      ],
    },
  };
}

// ── 판정·반영 (tick) ───────────────────────────────────────────

/**
 * 하루치 보드 요청 — tick이 매일 부른다 (감독이 있는 날만).
 *
 * 두 일을 한다: 답이 도착한 요청을 판정해 그 자리에서 반영하고, 공기가 찬 공사의
 * 좌석을 세운다. 공사가 먼저다 — 오늘 좌석이 서야 오늘 거는 새 요청의 여력이
 * 늘어난 수용인원을 읽는다.
 */
export function tickBoardRequests(state: GameState, digest: string[]): void {
  const requests = (state.boardRequests ??= []);
  for (const request of requests) deliverStadium(state, request, digest);
  // 기한이 지난 영입 승인을 먼저 지운다 — 오늘 비는 몫이 오늘 거는 요청의 여력이다
  expireEarmarks(state, digest);
  const open = requests.find((r) => r.status === "pending" || r.status === "conditional");
  if (open?.status === "conditional") judgeCondition(state, open, digest);
  else if (open && state.date >= open.respondOn) judgeRequest(state, open, digest);
  if (requests.length > BOARD_REQUEST.KEPT) {
    state.boardRequests = requests.slice(-BOARD_REQUEST.KEPT);
  }
}

/** 답이 도착했다 — 오늘의 한도와 부른 값을 견준다 */
function judgeRequest(state: GameState, request: BoardRequest, digest: string[]): void {
  const ceiling = boardRequestCeiling(state, request.kind);
  const granted = Math.min(request.amount, ceiling);

  if (granted <= 0) {
    reject(state, request, digest);
    return;
  }

  /**
   * **되걸기가 부분 승인 앞에 선다** (finance.md §9.6). 되거는 원형에게 절반을 내주는
   * 것은 그 사람의 답이 아니다 — 조건을 붙여 다 주거나, 조건을 못 채우면 아무것도.
   * `resolvedOn`은 아직 서지 않는다: 답이 끝나지 않은 요청이다.
   */
  const condition = counterCondition(state, request, ceiling);
  if (condition) {
    request.status = "conditional";
    request.condition = condition;
    const line = `보드 조건부 승인 — ${describeAsk(state, request)} · ${conditionText(condition)} · 기한 ${condition.until}`;
    digest.push(line);
    pushNarrative(state, line, 4);
    return;
  }

  approve(state, request, granted, digest);
}

/**
 * 되걸 조건 하나 — 없으면 `null`이고 그러면 부분 승인이다.
 *
 * 세 문이 다 열려야 선다: 되걸 수 있는 종류인가 · 한도가 부른 값에 한참 못 미치는가 ·
 * 이 구단주가 되거는 사람인가. 한도가 0인 자리는 여기 오지도 않는다 — 아무것도 못
 * 내주는 보드의 "판다면 준다"는 흥정이 아니라 빈말이다.
 */
function counterCondition(
  state: GameState,
  request: BoardRequest,
  ceiling: number,
): BoardCondition | null {
  if (!COUNTERABLE.has(request.kind)) return null;
  if (ceiling >= request.amount * BOARD_REQUEST.CONDITION_GAP) return null;
  const kind = CONDITION_OF_ARCHETYPE[ownerOf(state).archetype];
  if (!kind) return null;
  const amount =
    kind === "raise"
      ? // 모자란 만큼을 매각으로 만들어 오라는 말이다 — 굴리지 않는다
        Math.floor(request.amount - ceiling)
      : Math.floor(weeklyWagesOf(state, state.userTeamId) * (1 - BOARD_REQUEST.WAGE_CUT_RATIO));
  // 요구할 것이 없는 조건은 조건이 아니다 (주급이 0인 판·반올림에 사라지는 폭)
  if (amount <= 0) return null;
  return {
    kind,
    amount,
    since: state.date,
    until: addDays(state.date, BOARD_REQUEST.CONDITION_DAYS),
  };
}

/**
 * 되건 조건을 매일 본다 — 충족되면 **부른 값 그대로** 승인, 기한을 넘기면 거절.
 *
 * 충족된 날 한도를 다시 재지 않는다: 되건 것은 약속이다. 단 그날 예산이 동결이면
 * 거절이다 — PSR도 부채도 규정의 문제라 약속으로 풀리지 않는다 (finance.md §9.2).
 */
function judgeCondition(state: GameState, request: BoardRequest, digest: string[]): void {
  const condition = request.condition;
  if (!condition) return;
  if (conditionMet(state, condition)) {
    if (financeOf(state, state.userTeamId).budgetFrozen === true) reject(state, request, digest);
    else approve(state, request, request.amount, digest);
    return;
  }
  if (state.date > condition.until) reject(state, request, digest);
}

/** 조건이 장부에서 충족됐는가 — 문장을 읽는 자리가 없다 */
function conditionMet(state: GameState, condition: BoardCondition): boolean {
  switch (condition.kind) {
    case "raise":
      return raisedSince(state, condition.since) >= condition.amount;
    case "wage-cut":
      return weeklyWagesOf(state, state.userTeamId) <= condition.amount;
  }
}

/**
 * 되건 날부터 우리가 매각으로 만든 돈 — 이적 원장의 합이다.
 *
 * 임대료도 든다: 나가는 선수로 만든 현금이라는 점에서 매각과 같은 돈이고,
 * `net-profit` 구단주 요청이 세는 것과 같은 줄이다 (`windowTransfers`).
 */
function raisedSince(state: GameState, since: string): number {
  return state.transfers
    .filter(
      (t) =>
        t.fromTeamId === state.userTeamId &&
        t.date >= since &&
        (t.type === "transfer" || t.type === "loan"),
    )
    .reduce((sum, t) => sum + t.fee, 0);
}

/** 답이 끝났다 — 나온 값이 그 자리에서 장부에 앉는다 */
function approve(state: GameState, request: BoardRequest, granted: number, digest: string[]): void {
  request.status = "approved";
  request.granted = granted;
  request.resolvedOn = state.date;
  apply(state, request, granted);

  const partial = granted < request.amount;
  const line = partial
    ? `보드 요청 부분 승인 — ${describeAsk(state, request)} 중 ${boardRequestAmountText(request.kind, granted)}`
    : `보드 요청 승인 — ${describeAsk(state, request)}`;
  digest.push(line);
  pushNarrative(state, line, partial ? 3 : 4);
}

/** 답이 끝났다 — 아무것도 나오지 않았다 */
function reject(state: GameState, request: BoardRequest, digest: string[]): void {
  request.status = "rejected";
  request.granted = 0;
  request.resolvedOn = state.date;
  const line = `보드 요청 거절 — ${describeAsk(state, request)}`;
  digest.push(line);
  pushNarrative(state, line, 4);
}

/** 승인분이 실제로 앉는 자리 — 종류마다 하나씩이고 전부 이미 있던 축이다 */
function apply(state: GameState, request: BoardRequest, granted: number): void {
  const teamId = state.userTeamId;
  const finance = financeOf(state, teamId);
  switch (request.kind) {
    case "transfer-budget":
      /**
       * 원장에 넣지 않는다 — 보드의 증액은 매출이 아니라 자본이라 PSR에 들어가면
       * "돈을 넣으면 규정이 풀린다"가 된다 (`adjustTransferBudget`과 같은 자리).
       */
      finance.transferBudget += granted;
      return;
    case "signing": {
      /**
       * **이적 예산에 얹지 않는다** — 승인은 이름 하나에 대한 것이라 그 선수의 딜에만
       * 쓰인다 (finance.md §9.6). 얹는 순간 다른 영입이 그 돈을 쓸 수 있고, 그러면
       * 이 종류는 답이 빠른 총액 증액일 뿐이다.
       */
      if (!request.playerId) return;
      (finance.earmarked ??= []).push({
        requestId: request.id,
        gamePlayerId: request.playerId,
        amount: granted,
        until: addDays(state.date, BOARD_REQUEST.EARMARK_DAYS),
      });
      return;
    }
    case "wage-room":
      // 만료일을 스스로 든다 — 지우러 오는 tick이 없다 (finance.md §9.6)
      finance.wageLift = {
        amount: wageLiftOf(state, state.userTeamId) + granted,
        until: `${seasonYear(state.season) + 1}-06-30`,
      };
      return;
    case "stadium": {
      /**
       * 공사비는 **자본 지출**이다 — 현금은 오늘 나가지만 손익은 내용연수에 나눠 문다
       * (finance.md §6.1-1). 착공 달 하나가 PSR을 통째로 먹으면 그다음 아홉 시즌은
       * 좌석을 공짜로 쓰는 셈이 된다.
       */
      recordCapitalAsset(state, teamId, {
        id: `asset-${request.id}`,
        label: `구장 증설 (${granted.toLocaleString("en-US")}석)`,
        cost: granted * BOARD_REQUEST.SEAT_COST,
        months: STADIUM_ASSET_MONTHS,
      });
      request.deliversOn = addDays(state.date, BOARD_REQUEST.BUILD_DAYS);
      return;
    }
  }
}

// ── 건별 영입 승인분 (`earmarked`) ─────────────────────────────

/** 오늘 살아 있는 승인분 — 기한이 지난 줄은 tick이 지우기 전에도 세지 않는다 */
function liveEarmarks(state: GameState) {
  return (financeOf(state, state.userTeamId).earmarked ?? []).filter((e) => state.date <= e.until);
}

/** 지금 걸려 있는 승인분의 합 — `signing` 여력이 이것을 뺀다 */
function earmarkedTotal(state: GameState): number {
  return liveEarmarks(state).reduce((sum, e) => sum + e.amount, 0);
}

/** 그 선수 앞으로 걸려 있는 승인분 — 없으면 0 */
export function earmarkedFor(state: GameState, gamePlayerId: string): number {
  return liveEarmarks(state)
    .filter((e) => e.gamePlayerId === gamePlayerId)
    .reduce((sum, e) => sum + e.amount, 0);
}

/**
 * **그 선수를 살 수 있는 돈** — 관문 둘의 유일한 자다 (transfer.md §11).
 *
 * 딜 확률의 예산 항(`market.ts`)과 계약 확정의 관문(`negotiation.ts`)이 같은 값을
 * 봐야 한다: 갈리면 "가능하다"고 말한 오퍼가 도장 앞에서 막힌다. 주급 쪽에서
 * `userWageRoom`이 하는 일을 이적료 쪽에서 하는 자다.
 */
export function signingBudgetOf(state: GameState, gamePlayerId: string): number {
  return financeOf(state, state.userTeamId).transferBudget + earmarkedFor(state, gamePlayerId);
}

/**
 * 딜이 확정되는 날 — 오늘 나갈 만큼을 예산으로 옮기고 **줄을 지운다.**
 *
 * 남은 몫이 예산으로 남으면 다음 영입이 그 돈을 쓴다. 허가는 그 영입에 대한 것이었고
 * 영입은 일어났다 (finance.md §9.6). 분할의 남은 회분은 다른 이적과 똑같이 예산에서
 * 나간다.
 *
 * @returns 이적 예산에 얹힌 금액 — 검사한 값과 빠지는 값을 맞추는 자다
 */
export function consumeEarmark(state: GameState, gamePlayerId: string, dueNow: number): number {
  const finance = financeOf(state, state.userTeamId);
  const rows = finance.earmarked;
  if (!rows || rows.length === 0) return 0;
  const mine = rows.filter((e) => e.gamePlayerId === gamePlayerId);
  if (mine.length === 0) return 0;
  finance.earmarked = rows.filter((e) => e.gamePlayerId !== gamePlayerId);
  const live = mine.filter((e) => state.date <= e.until).reduce((sum, e) => sum + e.amount, 0);
  const used = Math.max(0, Math.min(dueNow, live));
  finance.transferBudget += used;
  return used;
}

/** 기한이 지난 승인분을 지운다 — 만료가 없으면 허가가 아니라 예산이다 */
function expireEarmarks(state: GameState, digest: string[]): void {
  const finance = financeOf(state, state.userTeamId);
  const rows = finance.earmarked;
  if (!rows || rows.length === 0) return;
  const gone = rows.filter((e) => state.date > e.until);
  if (gone.length === 0) return;
  finance.earmarked = rows.filter((e) => state.date <= e.until);
  for (const row of gone) {
    const line = `보드 영입 승인 만료 — ${playerName(state, row.gamePlayerId)} ${formatMoney(row.amount)}`;
    digest.push(line);
    pushNarrative(state, line, 3);
  }
}

/**
 * 공기가 찬 공사의 좌석을 세운다 — `state.teams[].capacity`가 오르는 유일한 자리.
 *
 * 세이브의 구단 카드는 셋(구장·수용인원·상업 등급)이 함께 있어야 카탈로그를
 * 덮으므로(`clubProfileIn`), 지금 값 그대로 셋을 다 적는다.
 */
function deliverStadium(state: GameState, request: BoardRequest, digest: string[]): void {
  if (request.kind !== "stadium" || request.status !== "approved") return;
  if (request.deliveredOn !== undefined || !request.deliversOn) return;
  if (state.date < request.deliversOn) return;
  const seats = request.granted ?? 0;
  const team = state.teams.find((t) => t.id === state.userTeamId);
  if (!team) return;
  const profile = clubProfileIn(state, state.userTeamId);
  team.stadium = profile.stadium;
  team.commercialTier = profile.commercialTier;
  team.capacity = profile.capacity + seats;
  request.deliveredOn = state.date;
  const line = `구장 증설 완공 — ${seats.toLocaleString("en-US")}석 · 수용인원 ${team.capacity.toLocaleString("en-US")}`;
  digest.push(line);
  pushNarrative(state, line, 4);
}

// ── 사실 카드 ──────────────────────────────────────────────────

/** 이름이 사라진 선수도 있다 — 카드가 빈칸을 내지 않게 id를 폴백으로 든다 */
function playerName(state: GameState, gamePlayerId: string): string {
  return playerById(state, gamePlayerId)?.name ?? gamePlayerId;
}

/** 부른 값 한 덩이 — `signing`만 선수 이름이 앞에 붙는다 */
function askText(state: GameState, request: BoardRequest): string {
  const amount = boardRequestAmountText(request.kind, request.amount);
  if (request.kind !== "signing" || !request.playerId) return amount;
  return `${playerName(state, request.playerId)} ${amount}`;
}

/** 요청 한 줄 — 라벨에 부른 값을 붙인다. 문장은 읽는 쪽이 쓴다 */
function describeAsk(state: GameState, request: BoardRequest): string {
  return `${BOARD_REQUEST_LABEL[request.kind]} ${askText(state, request)}`;
}

/** 되건 조건 한 줄 — 갈래와 금액뿐이다. "판다면 준다"는 GM이 쓴다 */
function conditionText(condition: BoardCondition): string {
  switch (condition.kind) {
    case "raise":
      return `매각으로 ${formatMoney(condition.amount)}를 만들면 승인`;
    case "wage-cut":
      return `주급 총액을 ${formatMoney(condition.amount)}/주 아래로 내리면 승인`;
  }
}

/** 조건이 지금 어디까지 찼는가 — 사실이지 평가가 아니다 */
function conditionProgress(state: GameState, condition: BoardCondition): string {
  switch (condition.kind) {
    case "raise":
      return `지금까지 매각 ${formatMoney(raisedSince(state, condition.since))}`;
    case "wage-cut":
      return `지금 주급 총액 ${formatMoney(weeklyWagesOf(state, state.userTeamId))}/주`;
  }
}

/**
 * GM 스냅샷의 블록 — **지금 서 있는 것이 있을 때만 선다.**
 *
 * 답을 기다리는 요청과, 보드가 이미 내준 주급 한도 상향 둘이다. 이 줄이 없으면
 * 모델은 요청이 걸려 있다는 사실 자체를 모르고, 감독이 "그건 어떻게 됐나"라고
 * 물을 때 기억으로 메운다. 답이 도착한 날은 digest가 나른다.
 */
export function describeBoardRequests(state: GameState): string | null {
  const lines: string[] = [];
  const request = openBoardRequest(state);
  if (request?.status === "pending") {
    lines.push(
      `- 답 대기: ${describeAsk(state, request)} · ${request.askedOn} 접수 · ${request.respondOn}에 답이 온다 ` +
        `(아직 답은 없다 — 결과를 앞질러 쓰지 마라)`,
    );
  }
  if (request?.status === "conditional" && request.condition) {
    lines.push(
      `- 조건부 승인: ${describeAsk(state, request)} — ${conditionText(request.condition)} · ` +
        `기한 ${request.condition.until} · ${conditionProgress(state, request.condition)}`,
    );
  }
  for (const row of liveEarmarks(state)) {
    lines.push(
      `- 영입 승인분: ${playerName(state, row.gamePlayerId)} ${formatMoney(row.amount)} ` +
        `(${row.until}까지 · 그 선수 영입에만 쓴다)`,
    );
  }
  const building = buildingStadium(state);
  if (building?.deliversOn) {
    lines.push(
      `- 공사 중: 구장 ${(building.granted ?? 0).toLocaleString("en-US")}석 · ${building.deliversOn} 완공`,
    );
  }
  const lift = wageLiftLine(state);
  if (lift) lines.push(`- ${lift}`);
  return lines.length > 0 ? lines.join("\n") : null;
}

// ── 주급 천장에 얹히는 몫 ──────────────────────────────────────

/**
 * 감독의 구단에 얹혀 있는 주급 한도 — 만료됐으면 0이다.
 *
 * `wageRoomOf`가 곱으로 재는 천장 **위에 더해지는 절대액**이다. 감독이 부른 값이
 * 주급이었으므로 나온 것도 주급이어야 한다 — 배수로 돌려주면 같은 승인이 구단
 * 규모에 따라 다른 값이 된다. AI 구단에는 걸리지 않는다.
 */
export function wageLiftOf(state: GameState, teamId: string): number {
  if (teamId !== state.userTeamId) return 0;
  const lift = financeOf(state, teamId).wageLift;
  if (!lift || state.date > lift.until) return 0;
  return lift.amount;
}

/**
 * **감독의 구단이 지금 주급 총액 위에 더 얹을 수 있는 돈** — 관문 둘의 유일한 자다.
 *
 * 영입 확률(`market.ts`)과 계약 확정(`negotiation.ts`)이 같은 값을 봐야 한다:
 * 갈리면 "가능하다"고 말한 오퍼가 도장 앞에서 막힌다.
 */
export function userWageRoom(state: GameState): number {
  return (
    wageRoomOf(
      state.userTeamId,
      weeklyWagesOf(state, state.userTeamId),
      USER_WAGE_HEADROOM,
      state,
    ) + wageLiftOf(state, state.userTeamId)
  );
}

/** 주급 여력 한 줄 — 보드가 내준 상향이 열려 있을 때만 (`get_finance`가 싣는다) */
export function wageLiftLine(state: GameState): string | null {
  const lift = wageLiftOf(state, state.userTeamId);
  if (lift <= 0) return null;
  const until = financeOf(state, state.userTeamId).wageLift?.until ?? "";
  return `보드 승인 주급 한도 상향 ${formatMoney(lift)}/주 (${until}까지) · 남은 주급 여력 ${formatMoney(Math.max(0, userWageRoom(state)))}/주`;
}
