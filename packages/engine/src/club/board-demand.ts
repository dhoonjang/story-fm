import type {
  BoardDemand,
  BoardDemandCause,
  BoardDemandKind,
  PressFact,
  TransferWindow,
} from "@story-fm/domain";
import { boardDemandText } from "@story-fm/domain";
import type { GameState } from "../core/state";
import {
  financeOf,
  openBoardDemand,
  playerById,
  pushNarrative,
  squadLevelOf,
  userPlayers,
  weeklyWagesOf,
} from "../core/state";
import { windowOpenForTeam } from "../market/market";
import { ownerOf } from "../world/persona";
import {
  bookValueOf,
  budgetFreezeReason,
  debtLimitOf,
  debtOf,
  psrStatus,
  relegationGapOf,
} from "./finance";
import { clampRep, signed } from "./press";

/**
 * 보드 요청 — **구단주 원형이 이적창마다 거는 조건 하나** (career.md §5.2).
 *
 * 순위 기대(§5)는 등급 표가 주는 구단의 자리이고, 이것은 **그 구단주라는 사람**이
 * 이 창에 거는 조건이다. 원형이 종류를 정하고 재정 상태가 발생과 판정에 걸리며,
 * 판정은 전부 코어 장부의 사실이다 — 이적 원장·잔고·주급 총액·선수 소속.
 * LLM은 관여하지 않는다.
 *
 * **재정이 급한 창에는 그 조건이 매각 요구로 갈린다** (§5.2 「재정 갈래」) — 동결이
 * 서 있거나 강등 첫 시즌이면 원형의 평소 조건 대신 `raise-funds`·`sell-player`가
 * 그 창에 선다. 창마다 최대 하나는 그대로다.
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
  /**
   * 재정 갈래가 서려면 목표액이 넘어야 하는 문턱 — **한 달치 인건비**다
   * (career.md §5.2). PSR 여유가 £10만 모자란 창에 £10만을 조르는 것은 요청이
   * 아니라 소음이다. 자를 주급 총액에서 뽑는 것은 동결선(20주)과 같은 이유다 —
   * 금액이 아니라 주수라 구단 규모를 저절로 탄다.
   */
  FUNDS_MIN_WAGE_WEEKS: 4,
  /** 목표액이 앉는 눈금 — 호가(`askingPriceFor`)와 같은 10만 단위다 */
  FUNDS_ROUNDING: 100_000,
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

/**
 * 원형 → **재정 갈래**의 요청 (career.md §5.2 「재정 갈래」). 위 표를 덮는 것이 아니라
 * 재정이 급한 창에만 대신 선다.
 *
 * **사람을 지목하는 것은 선수를 자산·비용으로 읽는 둘뿐이다** (people.md §2) —
 * 투자자형은 회수를, 산업가형은 구조를 본다. 나머지 넷은 금액만 부른다: 화제성을 파는
 * 사람도 위상을 지키는 사람도 연고의 사람도 경기 내용을 보는 사람도 "그 선수를
 * 팔아라"라고는 말하지 않는다.
 *
 * 여섯 원형 밖의 카드는 여기서도 아무 요청을 걸지 않는다 — 위 표와 같은 규약이다.
 */
export const FINANCE_DEMAND_OF_ARCHETYPE: Record<string, BoardDemandKind> = {
  산업가형: "sell-player",
  투자자형: "sell-player",
  축구광형: "raise-funds",
  국부펀드형: "raise-funds",
  "지역 유지형": "raise-funds",
  흥행가형: "raise-funds",
};

/**
 * **마지막으로 판정이 끝난 요청** — 이행이든 불이행이든. 요청은 창 순서대로 쌓이므로
 * 뒤에서 첫 번째가 가장 최근의 판정이다.
 *
 * 보드 대치 아크가 절정을 가를 때 이것을 읽는다 (people.md §9). 지난 요청 전부에서
 * 불이행을 찾으면 세 시즌 전의 한 번이 대치를 영원히 절정에 묶어 둔다.
 */
export function lastJudgedDemand(state: GameState): BoardDemand | null {
  const judged = (state.boardDemands ?? []).filter((d) => d.status !== "open");
  return judged[judged.length - 1] ?? null;
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

/**
 * 이 창에 설 요청 하나 — 원형이 없거나 전제가 안 서면 아무 일도 없다.
 *
 * **재정 갈래가 먼저 묻는다** (career.md §5.2): 동결·강등이 서 있고 목표액이 문턱을
 * 넘으면 그 창의 조건은 매각 요구다. 문턱 아래면 평소 조건이 그대로 선다.
 */
function issueDemand(state: GameState, demands: BoardDemand[], digest: string[]): void {
  const window = windowOpenForTeam(state, state.userTeamId);
  if (!window) return;
  // 창마다 최대 하나 — 일찍 닫힌 요청이 같은 창에 다시 서지 않는다
  if (demands.some((d) => d.windowId === window.id)) return;
  const archetype = ownerOf(state).archetype;
  const demand =
    financeDemand(state, window, archetype) ?? archetypeDemand(state, window, archetype);
  if (!demand) return;
  demands.push(demand);
  digest.push(`구단주 요청 — ${describeDemand(state, demand)} · 기한 ${demand.deadline}`);
  pushNarrative(state, `구단주 요청 — ${describeDemand(state, demand)}`, 4);
}

/** 원형의 평소 조건 — 국부펀드형의 여름 한정이 여기 걸린다 */
function archetypeDemand(
  state: GameState,
  window: TransferWindow,
  archetype: string,
): BoardDemand | null {
  const rule = DEMAND_OF_ARCHETYPE[archetype];
  if (!rule) return null;
  if (rule.summerOnly && window.kind !== "summer") return null;
  return buildDemand(state, window, rule.kind);
}

/**
 * 재정이 세우는 요청 — 사유가 없거나 목표액이 문턱 아래면 `null`이다 (평소 조건이 선다).
 *
 * **여름 한정은 여기서 풀린다** — 곤란은 겨울을 기다려 주지 않는다. 큰 그림의 사람이
 * 겨울 땜질을 조르지 않는 것과, 지갑이 닫힌 겨울에 아무 말도 하지 않는 것은 다르다.
 */
function financeDemand(
  state: GameState,
  window: TransferWindow,
  archetype: string,
): BoardDemand | null {
  const kind = FINANCE_DEMAND_OF_ARCHETYPE[archetype];
  if (!kind) return null;
  const cause = demandCause(state);
  if (!cause) return null;
  const target = fundsTargetOf(state);
  const floor = weeklyWagesOf(state, state.userTeamId) * BOARD_DEMAND.FUNDS_MIN_WAGE_WEEKS;
  if (target < floor) return null;

  const base = { ...baseDemand(state, window, kind), cause };
  if (kind === "sell-player") {
    const named = priciestAsset(state);
    // 장부에 값이 남은 선수가 하나도 없으면 지목할 것이 없다 — 금액 요청으로 떨어진다
    if (named) return { ...base, playerId: named };
    return { ...base, kind: "raise-funds", baseline: target };
  }
  return { ...base, baseline: target };
}

/**
 * 요청을 부른 재정 사유 — **동결 사유가 먼저다.** 지갑이 이미 닫혔다는 것이 절벽이
 * 서 있다는 것보다 앞선 사실이고, 둘 다 참인 창에서 감독이 들어야 하는 것도 그쪽이다.
 */
function demandCause(state: GameState): BoardDemandCause | null {
  const frozen = budgetFreezeReason(state, state.userTeamId);
  if (frozen) return frozen;
  const parachute = financeOf(state, state.userTeamId).parachute;
  return parachute?.startSeason === state.season ? "relegation" : null;
}

/**
 * 매각 목표액 — **세 구멍 중 가장 큰 것** (career.md §5.2). 어느 하나만 메워도
 * 나머지가 남으므로 최대이고, 호가와 같은 10만 단위로 올린다.
 */
export function fundsTargetOf(state: GameState): number {
  const teamId = state.userTeamId;
  const target = Math.max(
    0,
    debtOf(state, teamId) - debtLimitOf(state, teamId),
    -psrStatus(state).headroom,
    relegationGapOf(state, teamId),
  );
  const step = BOARD_DEMAND.FUNDS_ROUNDING;
  return Math.ceil(target / step) * step;
}

/**
 * 장부 잔존가가 가장 큰 우리 선수 — 같으면 id 사전순. 값이 남은 선수가 없으면 `null`.
 *
 * 시장가가 아니라 잔존가인 이유는 구단주가 보는 것이 **처분 이익**이기 때문이다
 * (finance.md §6.1) — 장부의 구멍을 메우는 것은 잔존가가 큰 선수의 매각이다.
 */
function priciestAsset(state: GameState): string | null {
  let best: { id: string; value: number } | null = null;
  for (const player of userPlayers(state)) {
    const value = bookValueOf(state, state.userTeamId, player.id);
    if (value <= 0) continue;
    if (!best || value > best.value || (value === best.value && player.id < best.id)) {
      best = { id: player.id, value };
    }
  }
  return best?.id ?? null;
}

/** 종류가 무엇이든 같은 껍데기 — id·창·기한은 창이 정한다 */
function baseDemand(state: GameState, window: TransferWindow, kind: BoardDemandKind): BoardDemand {
  return {
    id: `board-demand-${window.id}`,
    kind,
    windowId: window.id,
    issuedOn: state.date,
    deadline: window.closesOn,
    status: "open",
  };
}

/** 종류별 전제와 기준값 — 세울 수 없으면 `null`. 기준값은 발행 순간의 사실이다 */
function buildDemand(
  state: GameState,
  window: TransferWindow,
  kind: BoardDemandKind,
): BoardDemand | null {
  const base = baseDemand(state, window, kind);
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
 * **닿는 순간 닫히는 것이 넷이다** — `sign-star`·`raise-funds`는 이행으로,
 * `keep-player`는 불이행으로, 그 거울인 `sell-player`는 선수가 떠나는 순간 이행으로.
 * 창이 닫힌 뒤에는 어차피 되돌릴 수 없는 사실이라서다. 나머지는 기한이 지난 첫날
 * 판정한다: 창이 닫히기 전의 순지출은 마지막 날의 매각 한 건으로 뒤집힐 수 있다.
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
          (t) => t.toTeamId === state.userTeamId && t.fee >= (demand.baseline ?? 0),
        );
        return landed ? true : expired ? false : null;
      }
      case "raise-funds": {
        let raised = 0;
        for (const t of windowTransfers(state, demand.windowId)) {
          if (t.fromTeamId === state.userTeamId) raised += t.fee;
        }
        return raised >= (demand.baseline ?? 0) ? true : expired ? false : null;
      }
      case "sell-player": {
        /**
         * **소속 하나로 갈린다** — `keep-player`의 정확한 거울이다 (career.md §5.2).
         * 값이 오간 이동만 세지 않는 것은 그 자를 `raise-funds`가 이미 쥐고 있어서다:
         * 하나는 돈을, 하나는 그 사람이 남았는가를 본다. 세계에서 사라진 선수(은퇴)도
         * 구단주가 원한 자리가 빈 것은 같다.
         */
        const player = demand.playerId ? playerById(state, demand.playerId) : null;
        if (!player || player.teamId !== state.userTeamId) return true;
        return expired ? false : null;
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

/**
 * 이 창의 **값이 오간 이동** — 판정의 유일한 장부다.
 *
 * 이적과 임대를 가르지 않는다: 임대료도 이적 예산에서 빠져나가는 같은 돈이라
 * 스타 영입에도 순이익에도 같은 셈으로 잡힌다 (career.md §5.2). 자유계약·유스·
 * 은퇴는 오간 값이 없어 어느 셈도 움직이지 않는다.
 */
function windowTransfers(state: GameState, windowId: string) {
  return state.transfers.filter(
    (t) => t.windowId === windowId && (t.type === "transfer" || t.type === "loan"),
  );
}

// ── 사실 카드 ──────────────────────────────────────────────────

/**
 * 요청 한 줄 — 라벨에 발행 시점의 기준을 붙인다. 문장은 읽는 쪽이 쓴다.
 *
 * 자는 도메인이 갖는다(`boardDemandText`) — 사실 카드가 같은 것을 부르므로, 두 벌이면
 * 같은 요청이 감독의 브리핑과 구단주의 입에서 다른 값으로 선다.
 */
function describeDemand(state: GameState, demand: BoardDemand): string {
  const player = demand.playerId ? playerById(state, demand.playerId) : null;
  return boardDemandText(demand.kind, player?.name ?? "", demand.baseline);
}

/**
 * 구단주가 찾아온 자리에 싣는 요청 줄 (people.md §8) — **요청이 서는 것 자체는
 * 자리를 열지 않는다.** 자리는 순위 압력이 열고, 열린 자리가 조건을 함께 나른다.
 */
export function boardDemandFact(state: GameState): PressFact | null {
  const demand = openBoardDemand(state);
  if (!demand) return null;
  const player = demand.playerId ? playerById(state, demand.playerId) : null;
  return {
    kind: "board-demand",
    data: {
      // 사유는 재정 갈래에만 있다 — `tags[1]`이 그 자리다 (career.md §5.2)
      tags: demand.cause ? [demand.kind, demand.cause] : [demand.kind],
      date: demand.deadline,
      ...(player ? { name: player.name } : {}),
      ...(demand.baseline === undefined ? {} : { values: { baseline: demand.baseline } }),
    },
    about: demand.playerId ?? null,
    sharp: true,
  };
}
