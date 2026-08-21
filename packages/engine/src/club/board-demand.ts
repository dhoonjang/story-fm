import type { BoardDemand, BoardDemandKind, PressFact, TransferWindow } from "@story-fm/domain";
import { BOARD_DEMAND_LABEL } from "@story-fm/domain";
import type { GameState } from "../core/state";
import {
  financeOf,
  playerById,
  pushNarrative,
  squadLevelOf,
  userPlayers,
  weeklyWagesOf,
} from "../core/state";
import { windowOpenForTeam } from "../market/market";
import { ownerOf } from "../world/persona";
import { formatMoney } from "./finance";
import { clampRep, signed } from "./press";

/**
 * 보드 요청 — **구단주 원형이 이적창마다 거는 조건 하나** (career.md §5.2).
 *
 * 순위 기대(§5)는 등급 표가 주는 구단의 자리이고, 이것은 **그 구단주라는 사람**이
 * 이 창에 거는 조건이다. 원형이 종류를 정하고 재정 상태가 발생과 판정에 걸리며,
 * 판정은 전부 코어 장부의 사실이다 — 이적 원장·잔고·주급 총액·선수 소속.
 * LLM은 관여하지 않는다.
 */
export const BOARD_DEMAND = {
  /** 이행 → 보드 평판. 불이행의 절반 폭 — 구단주는 이행을 당연으로 여긴다 */
  MET_BOARD: 3,
  /** 불이행 → 보드 평판 — 보드 경고 한 번과 같은 폭 (career.md §5) */
  FAILED_BOARD: -6,
  /** `wage-freeze`가 허용하는 주급 총액 상승 폭 — 재계약 잔물결까지 동결로 본다 */
  WAGE_TOLERANCE: 0.02,
  /** `sign-star`의 기준 이적료 = 발행 시점 이적 예산 × 이 비율 */
  STAR_FEE_OF_BUDGET: 0.4,
  /** `sign-star`가 서려면 필요한 이적 예산 하한 — 없는 돈으로 스타를 조르지 않는다 */
  SIGN_STAR_MIN_BUDGET: 20_000_000,
  /** 상태에 남기는 지난 요청 수 — 다가옴·회견과 같은 규약 */
  KEPT: 20,
} as const;

/**
 * 원형 → 요청의 결 (people.md §2의 구단주 6종). **여섯 원형 밖의 카드는 조건부
 * 요청을 걸지 않는다** — 옛 세이브의 커스텀 구단주에게 없는 성격을 지어내지 않는다.
 *
 * 국부펀드형만 여름 창에 한정하는 것은 인내의 표현이다 — 큰 그림의 사람은 겨울
 * 땜질을 조르지 않는다.
 */
export const DEMAND_OF_ARCHETYPE: Record<string, { kind: BoardDemandKind; summerOnly?: true }> = {
  산업가형: { kind: "wage-freeze" },
  투자자형: { kind: "net-profit" },
  축구광형: { kind: "keep-player" },
  국부펀드형: { kind: "sign-star", summerOnly: true },
  "지역 유지형": { kind: "stay-solvent" },
  흥행가형: { kind: "sign-star" },
};

/** 열린 보드 요청 — 창마다 최대 하나라 언제나 하나뿐이다 */
export function openBoardDemand(state: GameState): BoardDemand | null {
  return (state.boardDemands ?? []).find((d) => d.status === "open") ?? null;
}

/**
 * 하루치 보드 요청 — tick이 매일 부른다 (감독이 있는 날만).
 *
 * 순서가 뜻을 갖는다: **판정이 발행보다 먼저다** — 창이 닫혀 기한이 지난 요청을
 * 정산한 뒤라야, 다음 창이 열린 날 새 요청이 그 자리를 이어받는다.
 */
export function tickBoardDemands(state: GameState, digest: string[]): void {
  const demands = (state.boardDemands ??= []);
  const open = demands.find((d) => d.status === "open");
  if (open) judgeDemand(state, open, digest);
  if (!demands.some((d) => d.status === "open")) issueDemand(state, demands, digest);
  if (demands.length > BOARD_DEMAND.KEPT) state.boardDemands = demands.slice(-BOARD_DEMAND.KEPT);
}

// ── 발생 ───────────────────────────────────────────────────────

/** 이 창에 설 요청 하나 — 원형이 없거나 전제가 안 서면 아무 일도 없다 */
function issueDemand(state: GameState, demands: BoardDemand[], digest: string[]): void {
  const window = windowOpenForTeam(state, state.userTeamId);
  if (!window) return;
  // 창마다 최대 하나 — 일찍 닫힌 요청이 같은 창에 다시 서지 않는다
  if (demands.some((d) => d.windowId === window.id)) return;
  const rule = DEMAND_OF_ARCHETYPE[ownerOf(state).archetype];
  if (!rule) return;
  if (rule.summerOnly && window.kind !== "summer") return;
  const demand = buildDemand(state, window, rule.kind);
  if (!demand) return;
  demands.push(demand);
  digest.push(`구단주 요청 — ${describeDemand(state, demand)} · 기한 ${demand.deadline}`);
  pushNarrative(state, `구단주 요청 — ${describeDemand(state, demand)}`, 4);
}

/** 종류별 전제와 기준값 — 세울 수 없으면 `null`. 기준값은 발행 순간의 사실이다 */
function buildDemand(
  state: GameState,
  window: TransferWindow,
  kind: BoardDemandKind,
): BoardDemand | null {
  const base: BoardDemand = {
    id: `board-demand-${window.id}`,
    kind,
    windowId: window.id,
    issuedOn: state.date,
    deadline: window.closesOn,
    status: "open",
  };
  switch (kind) {
    case "wage-freeze":
      return { ...base, baseline: weeklyWagesOf(state, state.userTeamId) };
    case "keep-player": {
      const star = starPlayer(state);
      return star ? { ...base, playerId: star } : null;
    }
    case "sign-star": {
      const finance = financeOf(state, state.userTeamId);
      if (finance.budgetFrozen === true) return null;
      if (finance.transferBudget < BOARD_DEMAND.SIGN_STAR_MIN_BUDGET) return null;
      return {
        ...base,
        baseline: Math.round(finance.transferBudget * BOARD_DEMAND.STAR_FEE_OF_BUDGET),
      };
    }
    default:
      return base;
  }
}

/** 1군 최고 능력치 선수 — 같으면 id 사전순. 축구광이 "그 선수"라 부르는 사람이다 */
function starPlayer(state: GameState): string | null {
  const firsts = userPlayers(state).filter((p) => squadLevelOf(p) === "first");
  if (firsts.length === 0) return null;
  firsts.sort((a, b) => b.attributes.overall - a.attributes.overall || (a.id < b.id ? -1 : 1));
  return firsts[0]!.id;
}

// ── 판정 ───────────────────────────────────────────────────────

/**
 * 열린 요청 하나를 오늘의 사실로 판정한다.
 *
 * `sign-star`는 닿는 순간 이행으로, `keep-player`는 선수가 떠나는 순간 불이행으로
 * **일찍 닫힌다** — 창이 닫힌 뒤에는 어차피 되돌릴 수 없는 사실이라서다. 나머지는
 * 기한이 지난 첫날 판정한다: 창이 닫히기 전의 순지출은 마지막 날의 매각 한 건으로
 * 뒤집힐 수 있다.
 */
function judgeDemand(state: GameState, demand: BoardDemand, digest: string[]): void {
  const expired = state.date > demand.deadline;
  const verdict = ((): boolean | null => {
    switch (demand.kind) {
      case "keep-player": {
        const player = demand.playerId ? playerById(state, demand.playerId) : null;
        if (!player || player.teamId !== state.userTeamId) return false;
        return expired ? true : null;
      }
      case "sign-star": {
        const landed = windowTransfers(state, demand.windowId).some(
          (t) =>
            t.toTeamId === state.userTeamId &&
            t.type === "transfer" &&
            t.fee >= (demand.baseline ?? 0),
        );
        return landed ? true : expired ? false : null;
      }
      case "net-profit": {
        if (!expired) return null;
        let net = 0;
        for (const t of windowTransfers(state, demand.windowId)) {
          if (t.fromTeamId === state.userTeamId) net += t.fee;
          if (t.toTeamId === state.userTeamId) net -= t.fee;
        }
        return net >= 0;
      }
      case "wage-freeze": {
        if (!expired) return null;
        const cap = (demand.baseline ?? 0) * (1 + BOARD_DEMAND.WAGE_TOLERANCE);
        return weeklyWagesOf(state, state.userTeamId) <= cap;
      }
      case "stay-solvent":
        return expired ? financeOf(state, state.userTeamId).balance >= 0 : null;
    }
  })();
  if (verdict === null) return;

  demand.status = verdict ? "met" : "failed";
  demand.resolvedOn = state.date;
  const delta = verdict ? BOARD_DEMAND.MET_BOARD : BOARD_DEMAND.FAILED_BOARD;
  const rep = state.manager.reputation;
  rep.board = clampRep(rep.board + delta);
  const line = `보드 요청 ${verdict ? "이행" : "불이행"} — ${describeDemand(state, demand)}`;
  digest.push(`${line} (${signed("보드", delta) ?? ""})`);
  pushNarrative(state, line, verdict ? 3 : 4);
}

/** 이 창의 이동 — 판정의 유일한 장부다 */
function windowTransfers(state: GameState, windowId: string) {
  return state.transfers.filter((t) => t.windowId === windowId);
}

// ── 사실 카드 ──────────────────────────────────────────────────

/** 요청 한 줄 — 라벨에 발행 시점의 기준을 붙인다. 문장은 읽는 쪽이 쓴다 */
function describeDemand(state: GameState, demand: BoardDemand): string {
  const label = BOARD_DEMAND_LABEL[demand.kind];
  switch (demand.kind) {
    case "keep-player": {
      const player = demand.playerId ? playerById(state, demand.playerId) : null;
      return player ? `${label} (${player.name})` : label;
    }
    case "sign-star":
      return `${label} (기준 ${formatMoney(demand.baseline ?? 0)})`;
    case "wage-freeze":
      return `${label} (기준 ${formatMoney(demand.baseline ?? 0)}/주)`;
    default:
      return label;
  }
}

/**
 * 구단주가 찾아온 자리에 싣는 요청 줄 (people.md §8) — **요청이 서는 것 자체는
 * 자리를 열지 않는다.** 자리는 순위 압력이 열고, 열린 자리가 조건을 함께 나른다.
 */
export function boardDemandFact(state: GameState): PressFact | null {
  const demand = openBoardDemand(state);
  if (!demand) return null;
  return {
    kind: "board-demand",
    text: `보드 요청 — ${describeDemand(state, demand)} · 기한 ${demand.deadline}`,
    about: demand.playerId ?? null,
    sharp: true,
  };
}
