import type { BoardRequest, BoardRequestKind } from "@story-fm/domain";
import { BOARD_REQUEST_LABEL, BOARD_REQUEST_UNIT } from "@story-fm/domain";
import type { GameState } from "../core/state";
import {
  clubProfileIn,
  financeOf,
  managedTeamId,
  pushNarrative,
  weeklyWagesOf,
} from "../core/state";
import { addDays, diffDays, seasonYear } from "../core/dates";
import { USER_WAGE_HEADROOM, clubWageBudget, wageRoomOf } from "../world/wages";
import { formatMoney, recordCapitalAsset, seasonWageRatio, STADIUM_ASSET_MONTHS } from "./finance";
import { item } from "../skills/brief";
import type { SkillResult } from "../skills";

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
  /** 이적 예산 여력 = 잔고 × 이것 */
  BUDGET_OF_BALANCE: 0.25,
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

/** 답을 기다리는 요청 — 한 번에 하나라 언제나 하나뿐이다 */
export function openBoardRequest(state: GameState): BoardRequest | null {
  return (state.boardRequests ?? []).find((r) => r.status === "pending") ?? null;
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

/** 종류별 여력 — 계수가 걸리기 전의 날것 */
function headroomOf(state: GameState, kind: BoardRequestKind): number {
  const teamId = state.userTeamId;
  const finance = financeOf(state, teamId);
  const balance = Math.max(0, finance.balance);
  switch (kind) {
    case "transfer-budget":
      return balance * BOARD_REQUEST.BUDGET_OF_BALANCE;
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
 * `여력 × 신뢰 계수 × 살림 계수`. 이적 예산이 동결이면(PSR·부채 — §9.2·§9.4) 세
 * 종류 다 0이다: 돈의 문제가 아니라 규정의 문제라 물어서 풀리지 않는다.
 */
export function boardRequestCeiling(state: GameState, kind: BoardRequestKind): number {
  if (financeOf(state, state.userTeamId).budgetFrozen === true) return 0;
  const factor =
    boardTrustFactor(state.manager.reputation.board) * boardThriftFactor(seasonWageRatio(state));
  return Math.floor(headroomOf(state, kind) * factor);
}

// ── 접수 (스킬) ────────────────────────────────────────────────

export interface RequestBoardInput {
  kind: BoardRequestKind;
  amount: number;
}

/**
 * `request_board` — 감독이 보드에 건다. **접수만 한다.**
 *
 * 물은 자리에서 답이 나오면 보드가 사람이 아니라 자판기가 된다. 판정은 답이
 * 도착하는 날의 tick이 그날의 장부로 한다 (`tickBoardRequests`).
 */
export function requestBoard(state: GameState, input: RequestBoardInput): SkillResult {
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

  const requests = (state.boardRequests ??= []);
  const respondOn = addDays(state.date, BOARD_REQUEST.RESPOND_DAYS[input.kind]);
  const request: BoardRequest = {
    id: `board-request-${state.date}-${input.kind}`,
    kind: input.kind,
    askedOn: state.date,
    respondOn,
    amount,
    status: "pending",
  };
  requests.push(request);

  const line = `보드 요청 — ${describeAsk(request)} · 답 ${respondOn}`;
  pushNarrative(state, line, 3);
  return {
    ok: true,
    message: `${line}. 보드가 검토합니다 — 답은 ${respondOn}에 옵니다`,
    brief: {
      head: "보드 요청",
      items: [
        item({ label: BOARD_REQUEST_LABEL[input.kind], text: amountText(request.kind, amount) }),
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
  const pending = requests.find((r) => r.status === "pending");
  if (pending && state.date >= pending.respondOn) judgeRequest(state, pending, digest);
  if (requests.length > BOARD_REQUEST.KEPT) {
    state.boardRequests = requests.slice(-BOARD_REQUEST.KEPT);
  }
}

/** 답이 도착했다 — 오늘의 한도와 부른 값을 견준다 */
function judgeRequest(state: GameState, request: BoardRequest, digest: string[]): void {
  const ceiling = boardRequestCeiling(state, request.kind);
  const granted = Math.min(request.amount, ceiling);
  request.resolvedOn = state.date;

  if (granted <= 0) {
    request.status = "rejected";
    request.granted = 0;
    const line = `보드 요청 거절 — ${describeAsk(request)}`;
    digest.push(line);
    pushNarrative(state, line, 4);
    return;
  }

  request.status = "approved";
  request.granted = granted;
  apply(state, request, granted);

  const partial = granted < request.amount;
  const line = partial
    ? `보드 요청 부분 승인 — ${describeAsk(request)} 중 ${amountText(request.kind, granted)}`
    : `보드 요청 승인 — ${describeAsk(request)}`;
  digest.push(line);
  pushNarrative(state, line, partial ? 3 : 4);
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

/** 값 한 덩이 — 단위가 금액인지 좌석인지는 종류가 안다 */
function amountText(kind: BoardRequestKind, value: number): string {
  switch (BOARD_REQUEST_UNIT[kind]) {
    case "money":
      return formatMoney(value);
    case "weekly":
      return `${formatMoney(value)}/주`;
    case "seats":
      return `${value.toLocaleString("en-US")}석`;
  }
}

/** 요청 한 줄 — 라벨에 부른 값을 붙인다. 문장은 읽는 쪽이 쓴다 */
function describeAsk(request: BoardRequest): string {
  return `${BOARD_REQUEST_LABEL[request.kind]} ${amountText(request.kind, request.amount)}`;
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
  if (request) {
    lines.push(
      `- 답 대기: ${describeAsk(request)} · ${request.askedOn} 접수 · ${request.respondOn}에 답이 온다 ` +
        `(아직 답은 없다 — 결과를 앞질러 쓰지 마라)`,
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
