import type { GamePlayer, Injury, TransferReason } from "@story-fm/domain";
import { ageOf, buildPaymentInstallments, seasonRating } from "@story-fm/domain";
import { contractUntil, seasonYear, windowOpenOn } from "../competition/calendar";
import { isClubTeam, leagueOfTeam } from "../data/team-catalog";
import { formatMoney, recordFinance, settleDuePayments } from "../club/finance";
import { buildDeparturePress, openPress } from "../club/press";
import { clampForm, moraleToForm } from "../squad/form";
import { leaderWeightOf } from "../squad/hierarchy";
import { closeMentoringsFor } from "../squad/mentoring";
import {
  firstInstallmentOf,
  loanLockOf,
  paymentYearsOf,
  squadShortfallText,
  transferWindowLabel,
  unilateralSeveranceOf,
  windowOpenForTeam,
} from "./market";
import { estimateWeeklyWage, wageSubjectOf } from "../world/wages";
// 떠남은 관계 줄을 걷고, 가까웠던 사람에게 자국을 남긴다 (people.md §6)
import { clearRelationsOf, closeTo, MANAGER_SUBJECT, moveRelation } from "../world/relations";
import { makeRng } from "../core/rng";
import { assignSquadNumber } from "../squad/numbers";
import { admitOnLoan, arrivingSquadLevel } from "../squad/registration";
import type { SkillResult } from "../skills";
import { forgetRoles } from "../skills/role-memory";
import { item, signed } from "../skills/brief";
import { pickAnyPlayer } from "../core/player-ref";
import {
  activeContract,
  benchRunOf,
  clearInterests,
  firstTeamPlayers,
  groupOf,
  onLoanFromUs,
  openInjury,
  pendingContractOf,
  playerById,
  playersOf,
  pushNarrative,
  releaseFromTactics,
  seasonStatOf,
  squadShortfall,
  teamName,
  withdrawTransferRequest,
  type GameState,
} from "../core/state";

/**
 * 팀을 떠나는 **다른 길들** — 방출과 임대.
 *
 * 매각만 있으면 나가는 문이 하나뿐이라 감독이 할 수 있는 게 "누가 사 주면"으로
 * 끝난다. 실제 구단은 안 팔리는 계약을 위약금을 물고 끊고, 못 쓰는 유망주를
 * 내보내 뛰게 한다. 둘 다 **대가가 분명한 선택**이라 밸런스가 흔들리지 않는다:
 * 해지는 돈을 잃고, 임대는 전력을 잃는다.
 *
 * 해지의 **값을 흥정하는 길**은 협상 테이블에 있다(`negotiation.ts`의 `openRelease`).
 * 여기 남은 것은 그 흥정의 종착지와, 흥정 없이 전액을 물고 끊는 바깥값이다.
 */

/**
 * 핵심 자원이 떠났을 때 남은 1군이 잃는 사기 — 폼으로는 닷새치 회귀에 해당한다.
 * 흔적이지 처벌이 아니다 (transfer.md §2). **리더 배수가 곱해진 값이 실제 폭이다.**
 */
export const DEPARTURE_SQUAD_MORALE = -3;

/**
 * 그 사람이 나갔을 때 라커룸이 잃는 사기 — 주장 −6 · 부주장 −5 · 리더 그룹 −4 ·
 * 나머지 −3 (people.md §5-1). 라커룸을 이끌던 사람이 나가는 것과 백업이 나가는
 * 것이 같은 값이면, 누구를 정리할지가 장부에서 갈리지 않는다.
 *
 * ⚠️ **선수가 무소속이 되기 전에 읽어야 한다** — 완장은 떠나는 문에서 벗겨진다.
 */
export function departureSquadMorale(state: GameState, player: GamePlayer): number {
  return -Math.round(-DEPARTURE_SQUAD_MORALE * leaderWeightOf(state, player));
}

/** 무소속 — 클럽이 아니라 클럽이 없는 상태 (team-catalog `freeagents`) */
export const FREE_AGENT_TEAM = "freeagents";

export function isFreeAgent(player: GamePlayer): boolean {
  return player.teamId === FREE_AGENT_TEAM;
}

/** 지금 무소속인 선수들 — 이적 시장의 공짜 자원 */
export function freeAgents(state: GameState): GamePlayer[] {
  return state.players.filter((p) => p.teamId === FREE_AGENT_TEAM);
}

/**
 * 떠나는 선수가 **남기고 가는 것들** — 어느 문으로 나가든 같다.
 *
 * 전술 배치 · 이적 리스트 · 개인 훈련 · 역할 기억 · 주장 완장 · 라커룸 불만은 그
 * 선수가 이 팀에 있을 때만 뜻이 있는 값이다. 문 하나에만 적어 두면 판 선수의 훈련
 * 계획이 장부에 남아 다음 시즌 보고서까지 따라온다 (transfer.md §2). 불만도 같다 —
 * 팀을 떠나면 불만도 끝난다 (people.md §5). 호출부마다 따로 지우면 다음 이탈
 * 경로가 생길 때 또 샌다.
 */
export function clearDepartedState(state: GameState, player: GamePlayer, from: string): void {
  releaseFromTactics(state, from, player.id);
  state.transferList = state.transferList.filter((l) => l.gamePlayerId !== player.id);
  state.playerTraining = state.playerTraining.filter((t) => t.gamePlayerId !== player.id);
  state.issues = state.issues.filter((i) => i.gamePlayerId !== player.id);
  // 떠난 사람에게 한 약속은 지킬 자리가 없다 (people.md §5-2 — 불만과 같은 결)
  state.promises = (state.promises ?? []).filter((pr) => pr.gamePlayerId !== player.id);
  // 요청 장부도 같은 문을 지난다 — 떠난 선수의 요청에 감독이 답할 자리가 없다
  withdrawTransferRequest(state, player.id);
  // 관심도 같다 — 우리 라커룸에 없는 사람을 두고 나는 소문은 물을 자리가 없다 (§1-2)
  clearInterests(state, (i) => i.gamePlayerId === player.id);
  forgetRoles(state, player.id);
  player.isCaptain = false;
  player.isViceCaptain = undefined;
  /**
   * **떠나면 사이도 끝난다** (people.md §5-3) — 멘토로 든 것도 멘티로 든 것도 함께.
   * 지우지 않고 닫으므로 놓인 쪽의 심경이 며칠 그 줄을 읽는다.
   */
  closeMentoringsFor(state, player.id, "departure");
  /**
   * 관계 점수의 줄도 함께 걷는다 (people.md §6) — 불만·약속과 같은 문이다.
   *
   * 그 뒤 사흘의 심경 카드가 「가까웠는가」를 물으면 **첫인상이 답한다**: 함께 뛴
   * 해도 협회도 원장에 남아 있어 파생이 상하지 않는다.
   */
  clearRelationsOf(state, player.id);
}

/**
 * 팀을 잃은 선수를 무소속으로 보낸다 — 방출·계약 만료의 공통 종착지.
 * 계약은 여기서 끊기고, 새 팀은 시장이 찾아 준다(`signFreeAgents`).
 */
export function toFreeAgency(
  state: GameState,
  player: GamePlayer,
  reason: TransferReason,
  on = state.date,
): string {
  const contract = activeContract(state, player.id);
  if (contract) contract.status = "ended";
  const from = player.teamId;
  clearDepartedState(state, player, from);
  player.teamId = FREE_AGENT_TEAM;
  player.squadNumber = undefined;
  player.squadLevel = "first";
  player.loan = undefined;
  // 해지 정산의 지급 일정이 이 row를 근거(`transferId`)로 삼는다 (transfer.md §5-2)
  const id = `tr-free-${player.id}-${on}`;
  state.transfers.push({
    id,
    gamePlayerId: player.id,
    windowId: null,
    fromTeamId: from,
    toTeamId: FREE_AGENT_TEAM,
    date: on,
    type: "free",
    fee: 0,
    reason,
  });
  return id;
}

/**
 * 계약 해지 — **돈으로 자리를 비운다.** 두 길의 공통 종착지다.
 *
 * `severance`가 실려 오면 **합의 해지의 확정**이다(`executeRelease`) — 값은 협상이
 * 정했다. 안 실려 오면 **일방 해지**이고, 값은 잔여 급여 **전액**이다
 * (`unilateralSeveranceOf`).
 *
 * ⚠️ **일방의 길을 닫지 않는 것이 이 함수의 일이다.** 합의가 끝내 안 되면 감독이
 * 전액을 물고 끊을 수 있어야 해지 협상이 협상이 된다 — 그 바깥값이 없으면 선수는
 * 무엇도 받아들일 이유가 없다 (transfer.md §2·§11).
 *
 * 어느 길이든 지불액은 즉시 나가고 원장에 남아 PSR까지 가며, 주급 총액에서 사라진다.
 */
export function releasePlayer(
  state: GameState,
  input: { playerId: string; severance?: number; paymentYears?: number },
): SkillResult {
  const pick = pickAnyPlayer(state, input.playerId);
  if (!pick.ok) return { ok: false, message: pick.message };
  const player = pick.player;
  // 임대 나간 선수는 `teamId`가 상대 팀이고 빌려 온 선수는 계약이 남의 것이다 —
  // 어느 쪽이든 소속 판정보다 이 안내가 먼저다 (transfer.md §2)
  const locked = loanLockOf(player);
  if (locked) return { ok: false, message: locked };
  if (player.teamId !== state.userTeamId) {
    return { ok: false, message: `${player.name}은(는) 우리 선수가 아닙니다` };
  }
  const short = squadShortfall(state, state.userTeamId, player);
  if (short) return { ok: false, message: `우리 ${squadShortfallText(short, "release")}` };

  const agreed = input.severance !== undefined;
  const severance = Math.max(
    0,
    Math.round(input.severance ?? unilateralSeveranceOf(state, player.id)),
  );
  /**
   * **일방 해지는 분할을 타지 않는다** — 전액 일시금이 협상의 바깥값(BATNA)이고,
   * 그 값이 누그러지면 합의 해지에 응할 이유가 함께 사라진다 (transfer.md §11).
   */
  const paymentYears = agreed ? paymentYearsOf(input.paymentYears) : undefined;
  const dueNow = firstInstallmentOf(severance, paymentYears);
  const finance = state.finances.find((f) => f.teamId === state.userTeamId);
  if (finance && dueNow > finance.balance) {
    return {
      ok: false,
      message: `${agreed ? "정산금" : "위약금"} ${formatMoney(dueNow)}을 감당할 잔고가 없습니다`,
    };
  }

  const wasCaptain = player.isCaptain;
  // 완장을 벗기기 전에 읽는다 — 떠나는 문이 곧 그 사람의 자리를 지운다
  const squadMorale = departureSquadMorale(state, player);
  /**
   * **가까웠던 사람들도 떠나는 문 앞에서 읽는다** (people.md §6) — 그 문이 그의 관계
   * 줄을 지운다. 남는 것은 감독을 보는 눈이다: 라커룸 전체가 아니라 그와 가까웠던
   * 사람만 이 값을 치른다.
   */
  const bereft = closeTo(state, player.id).map((mate) => mate.id);
  const transferId = toFreeAgency(state, player, agreed ? "release-agreed" : "release-unilateral");
  if (severance > 0) {
    if (paymentYears !== undefined) {
      // 받는 쪽이 선수 본인이라 표가 payee를 갖지 않는다 — 원장은 우리 지출만 적는다
      (state.paymentSchedules ??= []).push({
        id: `pay-${transferId}`,
        transferId,
        gamePlayerId: player.id,
        payerTeamId: state.userTeamId,
        payeeTeamId: null,
        kind: "severance",
        installments: buildPaymentInstallments(severance, paymentYears, state.date),
      });
      settleDuePayments(state);
    } else {
      recordFinance(state, state.userTeamId, {
        kind: "expense",
        category: "player_wages",
        label: `계약 해지 ${agreed ? "정산금" : "위약금"} — ${player.name}`,
        amount: severance,
        ref: { type: "player", id: player.id },
      });
    }
  }

  /**
   * **회견이 열릴 만한 자원이었는지가 사기의 문이기도 하다** — 회견을 여는 조건과
   * 같은 자를 쓴다. 백업 정리에도 라커룸이 상하면 정리 자체가 벌이 된다
   * (transfer.md §2). 회견 판정은 무소속이 된 **뒤에** 해야 남은 스쿼드와 견준다.
   */
  const press = buildDeparturePress(state, { playerId: player.id, severance, wasCaptain });
  if (press) {
    openPress(state, press);
    // 남은 1군만 — 떠난 당사자는 이미 무소속이라 자연히 빠진다
    for (const mate of firstTeamPlayers(state, state.userTeamId)) {
      mate.state.form = clampForm(mate.state.form + moraleToForm(squadMorale));
    }
  }

  /**
   * 가까웠던 사람들이 감독을 보는 눈 — **해지가 끝난 뒤에 옮긴다** (people.md §6).
   * 명단은 문 앞에서 읽어 두었다: 지금은 그의 관계 줄이 이미 걷혀 있다.
   */
  for (const mateId of bereft) moveRelation(state, MANAGER_SUBJECT, mateId, "teammate-gone");

  pushNarrative(state, `${player.name} 계약 해지`, wasCaptain ? 5 : 4);
  return {
    ok: true,
    brief: {
      head: "계약 해지",
      items: [
        item({ label: "해지", text: player.name, note: "무소속" }),
        item({
          label: agreed ? "정산금" : "위약금",
          text: formatMoney(severance),
          ...(paymentYears === undefined
            ? {}
            : { note: `${paymentYears}년 분할 · 첫 회분 ${formatMoney(dueNow)}` }),
        }),
        ...(wasCaptain ? [item({ text: "주장 공석" })] : []),
        ...(press
          ? [
              item({
                label: "1군 사기",
                text: signed(squadMorale),
                delta: squadMorale,
              }),
            ]
          : []),
      ],
    },
    message:
      `${player.name}과(와) 계약을 해지했습니다 — ${agreed ? "정산금" : "위약금 전액"} ${formatMoney(severance)}` +
      (paymentYears === undefined
        ? "."
        : ` (${paymentYears}년 분할 — 첫 회분 ${formatMoney(dueNow)}).`) +
      " 무소속이 됐습니다 — 다른 구단이 데려갈 수 있습니다." +
      (wasCaptain ? " 주장이 떠났습니다 — 새 주장을 지명하세요." : "") +
      (press ? ` 기자회견이 열렸습니다. 남은 1군 사기 ${squadMorale}.` : ""),
  };
}

/** 임대 팀이 내는 주급 비율의 기본값 — 절반씩 나눈다 */
export const DEFAULT_LOAN_WAGE_SHARE = 0.5;

/**
 * 임대 — **전력을 내주고 성장을 산다.**
 *
 * 계약은 우리 것으로 남고 `GamePlayer.teamId`만 옮겨 간다(그래서 복귀가 원장
 * 없이도 `loan`에서 파생된다). 주급은 `wageShare`만큼 임대 팀이 낸다 —
 * 총액이 계약 합계에서 파생되므로 분담도 파생으로 반영된다(`weeklyWagesOf`).
 */
export function loanPlayer(
  state: GameState,
  input: { playerId: string; teamId: string; until?: string; wageShare?: number },
): SkillResult {
  const pick = pickAnyPlayer(state, input.playerId);
  if (!pick.ok) return { ok: false, message: pick.message };
  const player = pick.player;
  if (player.teamId !== state.userTeamId) {
    return { ok: false, message: `${player.name}은(는) 우리 선수가 아닙니다` };
  }
  if (player.loan) return { ok: false, message: `${player.name}은(는) 이미 임대 중입니다` };
  const destination = state.teams.find((t) => t.id === input.teamId);
  if (!destination) return { ok: false, message: `"${input.teamId}"라는 구단을 찾지 못했습니다` };
  if (destination.id === state.userTeamId) {
    return { ok: false, message: "우리 구단에 임대할 수는 없습니다" };
  }
  // 무소속은 구단이 아니라 구단이 없는 상태다 — 빌려 갈 스쿼드가 없다 (transfer.md §2)
  if (!isClubTeam(destination.id)) {
    return { ok: false, message: `${teamName(destination.id)}은(는) 구단이 아닙니다` };
  }
  // 임대 송출의 창도 **받는 쪽 협회**의 것이다 — 등록을 그쪽이 한다 (transfer.md §3)
  const window = windowOpenForTeam(state, destination.id);
  if (!window) {
    return {
      ok: false,
      message: `${transferWindowLabel(state, destination.id)}이 닫혀 있어 임대를 보낼 수 없습니다`,
    };
  }
  const short = squadShortfall(state, state.userTeamId, player);
  if (short) return { ok: false, message: `우리 ${squadShortfallText(short, "loan-out")}` };
  const contract = activeContract(state, player.id);
  if (!contract) return { ok: false, message: `${player.name}은(는) 계약이 없습니다` };

  /** 기본 복귀일은 **시즌 마감**이다 — 실제 임대의 기본 형태이기도 하다 */
  const until = input.until ?? `${seasonYear(state.season) + 1}-06-30`;
  if (until <= state.date) {
    return { ok: false, message: `복귀일(${until})이 오늘보다 앞섭니다` };
  }
  if (until > contract.until) {
    return { ok: false, message: `계약이 ${contract.until}에 끝나 그때까지만 보낼 수 있습니다` };
  }
  const wageShare = Math.max(0, Math.min(1, input.wageShare ?? DEFAULT_LOAN_WAGE_SHARE));

  clearDepartedState(state, player, state.userTeamId);
  player.teamId = destination.id;
  player.squadNumber = undefined;
  assignSquadNumber(state.players, player);
  /**
   * **임대는 언제나 그쪽 1군이다** — 명단이 차 있으면 빌린 구단이 자리를 낸다
   * (→ docs/simulation/season.md §2 임대). 2군에 들어가면 그쪽 2군 리그가 편성되지
   * 않아 한 경기도 못 뛴다 — 나가면 뛰던 경기까지 잃는 임대는 임대가 아니다.
   */
  admitOnLoan(state, player, destination.id);
  player.squadLevel = "first";
  player.loan = { fromTeamId: state.userTeamId, until, wageShare };
  state.transfers.push({
    id: `tr-loan-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    windowId: window.id,
    fromTeamId: state.userTeamId,
    toTeamId: destination.id,
    date: state.date,
    type: "loan",
    fee: 0,
  });

  pushNarrative(state, `${player.name} ${teamName(destination.id)} 임대 (복귀 ${until})`, 3);
  return {
    ok: true,
    message:
      `${player.name}을(를) ${teamName(destination.id)}에 임대 보냈습니다 — ${until} 복귀 · ` +
      `주급 ${Math.round(wageShare * 100)}%를 그쪽이 부담합니다`,
    brief: {
      head: "임대",
      items: [
        item({
          label: "임대",
          text: player.name,
          note: `${teamName(destination.id)} · ${until} 복귀`,
        }),
        item({ label: "그쪽 주급 부담", text: `${Math.round(wageShare * 100)}%` }),
      ],
    },
  };
}

/**
 * 임대 조기 종료 — 감독이 불러들인다(`recall_loan`).
 * 실제 임대에도 리콜 조항이 흔하다(부상 공백·성장 정체).
 */
export function recallLoan(state: GameState, input: { playerId: string }): SkillResult {
  const pick = pickAnyPlayer(state, input.playerId);
  if (!pick.ok) return { ok: false, message: pick.message };
  const player = pick.player;
  if (!player.loan || player.loan.fromTeamId !== state.userTeamId) {
    return { ok: false, message: `${player.name}은(는) 우리가 임대 보낸 선수가 아닙니다` };
  }
  const from = player.teamId;
  returnFromLoan(state, player);
  return {
    ok: true,
    message: `${player.name}을(를) ${teamName(from)}에서 불러들였습니다 — 2군으로 복귀했습니다`,
    brief: {
      head: "임대 복귀",
      items: [item({ label: "복귀", text: player.name, note: `${teamName(from)} · 2군` })],
    },
  };
}

/**
 * 임대 복귀 — 원소속으로 되돌린다. 자리는 감독이 정한다(2군으로 들어온다).
 *
 * **빌린 구단의 배치는 비운다** — 복귀도 그 구단에서 보면 나가는 문이라, 안 비우면
 * 떠난 선수의 id가 그 팀 라인업에 남는다 (transfer.md §2). 다만 `clearDepartedState`
 * 전체를 지나지는 않는다: 이적 리스트·개인 훈련·역할 기억은 **소유 구단**의 값이라
 * 우리가 내보낸 선수가 돌아오는 자리에서 지우면 우리 기억을 우리가 잃는다.
 */
function returnFromLoan(state: GameState, player: GamePlayer): void {
  const loan = player.loan;
  if (!loan) return;
  releaseFromTactics(state, player.teamId, player.id);
  const window = windowOpenOn(state.windows, state.date);
  state.transfers.push({
    id: `tr-loanback-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    windowId: window?.id ?? null,
    fromTeamId: player.teamId,
    toTeamId: loan.fromTeamId,
    date: state.date,
    type: "loan",
    fee: 0,
  });
  player.teamId = loan.fromTeamId;
  player.squadNumber = undefined;
  assignSquadNumber(state.players, player);
  player.squadLevel = "reserve";
  player.loan = undefined;
}

/** 복귀일이 지난 임대를 되돌린다 — tick이 매일 부른다 */
export function returnDueLoans(state: GameState, digest: string[]): void {
  for (const player of state.players) {
    if (!player.loan) continue;
    if (player.loan.until > state.date) continue;
    const from = player.teamId;
    const ours = player.loan.fromTeamId === state.userTeamId;
    returnFromLoan(state, player);
    if (ours) {
      digest.push(
        `${player.name}이(가) ${teamName(from)} 임대를 마치고 돌아왔습니다 (2군 · ${ageOf(player.birthdate, state.date)}세)`,
      );
      pushNarrative(state, `${player.name} 임대 복귀`, 3);
    }
  }
}

/** 우리가 임대 보낸 선수들 — 조회·서사용 */
export function loanedOut(state: GameState): GamePlayer[] {
  return state.players.filter((p) => onLoanFromUs(state, p));
}

// ── 임대 리포트 — 남의 경기장에서 무슨 일이 있었나 ──────

/**
 * 리콜을 고민할 근거 — **코드다.** "출전 기회를 못 얻고 있습니다"라는 문장은 GM이
 * 쓴다 (→ docs/overview.md §1 철칙 4).
 */
export type LoanConcern = "no-minutes" | "injury";

/**
 * 그 구단 최근 경기에서 이만큼 연속으로 명단 밖이면 사실로 짚는다.
 *
 * 넷은 한 달치 일정이다 — 둘이면 로테이션 한 번에 경보가 울리고, 여덟이면 리포트가
 * 두 달 늦게 온다. 리콜 창(이적 창)이 열려 있는 동안 감독이 판단할 시간이 남는 폭이다.
 */
export const LOAN_BENCH_RUN_ALERT = 4;

/** 임대 한 건의 결산 — 저장하지 않는다. 장부에서 파생한다 */
export interface LoanReport {
  playerId: string;
  name: string;
  /** 빌린 구단 */
  teamId: string;
  /** 복귀일 */
  until: string;
  /** 그 구단에서의 이번 시즌 1군 기록 (`SEASON_STAT`의 그 팀 행) */
  apps: number;
  goals: number;
  assists: number;
  /** 평균 평점 — 출전이 없으면 null (0.00과 "기록 없음"은 다르다) */
  rating: number | null;
  /** 그 구단 2군 리그 출전 — 1군 기록과 섞지 않는다 (season.md §2) */
  reserveApps: number;
  /** 그 구단 최근 경기의 **연속 미출전 수** — 명단에 든 경기가 나오면 멈춘다 */
  benchRun: number;
  /** 임대를 나간 뒤 오른 능력치 칸 수 (`growthLog`의 합) */
  growth: number;
  injury: Injury | null;
  concerns: LoanConcern[];
}

/**
 * 이 임대가 언제 시작됐나 — 원장의 임대 이적 줄에서 파생한다. 줄이 없는 옛 세이브는
 * 시즌 시작으로 본다(성장 칸 수가 과하게 잡히는 쪽이지, 빠지는 쪽이 아니다).
 */
function loanStartOf(state: GameState, player: GamePlayer): string {
  const rows = state.transfers.filter(
    (t) => t.gamePlayerId === player.id && t.type === "loan" && t.toTeamId === player.teamId,
  );
  return rows.length > 0
    ? rows.reduce((latest, t) => (t.date > latest ? t.date : latest), rows[0]!.date)
    : state.calendar.preseasonStart;
}

/**
 * 임대 한 건의 결산 — 우리가 임대 보낸 선수가 아니면 null.
 *
 * ⚠️ **사실만 낸다.** 출전·평점·연속 미출전·성장 칸 수와 근거 **코드**뿐이고,
 * "불러들이시죠"는 이 자리의 것이 아니다.
 */
export function loanReportOf(state: GameState, playerId: string): LoanReport | null {
  const player = playerById(state, playerId);
  if (!player?.loan || !onLoanFromUs(state, player)) return null;
  const stat = seasonStatOf(state, player.id);
  const since = loanStartOf(state, player);
  const growth = state.growthLog
    .filter((g) => g.gamePlayerId === player.id && g.date >= since && g.delta > 0)
    .reduce((sum, g) => sum + g.delta, 0);
  const injury = openInjury(state, player.id);
  const benchRun = benchRunOf(state, player);
  return {
    playerId: player.id,
    name: player.name,
    teamId: player.teamId,
    until: player.loan.until,
    apps: stat?.apps ?? 0,
    goals: stat?.goals ?? 0,
    assists: stat?.assists ?? 0,
    rating: seasonRating(stat),
    reserveApps: stat?.reserveApps ?? 0,
    benchRun,
    growth,
    injury,
    concerns: [
      ...(benchRun >= LOAN_BENCH_RUN_ALERT ? (["no-minutes"] as const) : []),
      ...(injury ? (["injury"] as const) : []),
    ],
  };
}

/** 우리가 내보낸 임대 전부의 결산 — 이름 순서가 아니라 id 순서다(결정적) */
export function loanReports(state: GameState): LoanReport[] {
  return loanedOut(state)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => loanReportOf(state, p.id))
    .filter((r): r is LoanReport => r !== null);
}

// ── 무소속 시장 — 남의 팀이 데려간다 ────────────────────

/** 무소속 선수 한 명이 하루에 팀을 찾을 기본 확률 */
export const FREE_AGENT_SIGN_CHANCE = 0.06;
/** 하루에 성사되는 자유계약 수의 상한 — 리그가 하루아침에 재편되지 않게 */
export const FREE_AGENT_SIGNINGS_PER_DAY = 2;
/** 자리가 얇다고 보는 기준 — 그 포지션군 인원이 이 아래면 급하다 */
const THIN_GROUP = 5;
/**
 * 이름값을 재는 기준 등급 — 이 등급이면 배수 1.0이다.
 * ⚠️ 종합의 눈금을 탄다 (player.md §4 — 평균 67.5 → 65.9).
 */
const FREE_AGENT_PAR_RATING = 67;
/** 구단과 선수의 수준이 맞다고 보는 폭 — 같은 이유로 눈금을 탄다 (8 → 7) */
const SUITOR_LEVEL_BAND = 7;
/**
 * 그 포지션군이 포화라고 보는 인원 — 이만큼 있으면 데려가지 않고, 이 아래로
 * 모자란 만큼 뽑기에 이름을 더 넣는다. **두 자리가 같은 수를 읽어야 한다** —
 * 문턱과 가중치가 갈리면 아무도 뽑히지 않는 구간이 생긴다.
 */
const SUITOR_GROUP_CROWD = THIN_GROUP + 3;
/** 팀 수준을 재는 표본 — 전력 상위 이만큼의 평균이 그 구단의 눈금이다 */
const SUITOR_LEVEL_SAMPLE = 15;
/** 나이가 이름값에 곱하는 몫 — 나이가 많을수록 팀을 더디게 찾는다 */
const FREE_AGENT_OLD_AGE = 34;
const FREE_AGENT_OLD_APPEAL = 0.35;
const FREE_AGENT_VETERAN_AGE = 31;
const FREE_AGENT_VETERAN_APPEAL = 0.7;
/**
 * 무소속을 더 받지 않는 **전체 인원**(1군·2군·유스 합) — 이만큼 데리고 있는 구단은
 * 공짜라도 한 명을 더 얹지 않는다.
 *
 * ⚠️ 스쿼드 상한이 아니다. 규정의 등록 상한(`SQUAD_LIST_LIMIT`)도, 1군 운영 상한
 * (`FIRST_TEAM_LIMIT`)도, AI 시장의 전체 최후 상한(`MAX_SQUAD` = 52)도 아니고
 * 그보다 이른 자리다 — 그 상한까지 무소속으로 채우면 감독이 시장에 나가기 전에
 * 세계의 남는 선수가 전부 소화된다.
 */
const FREE_AGENT_SUITOR_SQUAD_CAP = 40;

/**
 * 무소속 선수를 다른 구단이 데려간다 — tick이 **이적창이 열린 날** 부른다.
 *
 * 아무 데나 가지 않는다. **자리가 얇고 수준이 비슷한** 구단이 데려간다:
 * 그 포지션군이 부족할수록, 팀의 스쿼드 수준과 선수의 실력이 가까울수록 확률이
 * 오른다. 좋은 선수일수록 빨리 팔리고, 나이가 많을수록 더디다.
 *
 * **우리 팀은 이 경로로 선수를 받지 않는다** — 감독이 직접 데려와야 한다.
 * 안 그러면 아무것도 안 해도 스쿼드가 채워진다.
 */
export function signFreeAgents(state: GameState, digest: string[]): void {
  const pool = freeAgents(state);
  if (pool.length === 0) return;
  const rng = makeRng(state.seed, `freeagents:${state.date}`);
  let signed = 0;

  for (const player of pool) {
    if (signed >= FREE_AGENT_SIGNINGS_PER_DAY) return;
    /**
     * **이미 갈 곳을 정한 사람은 시장이 데려가지 않는다** (transfer.md §1-4).
     * 무소속이 되어도 예약은 살아 있다 — 계약이 끝난 것과 발효를 기다리는 것은
     * 다른 사실이라, 여기서 새 활성 계약을 쓰면 예약이 조용히 덮인다.
     */
    if (pendingContractOf(state, player.id)) continue;
    const age = ageOf(player.birthdate, state.date);
    // 이름값이 클수록 빨리, 나이가 많을수록 더디게 (기준 등급은 종합 눈금을 탄다)
    const appeal =
      (player.attributes.overall / FREE_AGENT_PAR_RATING) *
      (age >= FREE_AGENT_OLD_AGE
        ? FREE_AGENT_OLD_APPEAL
        : age >= FREE_AGENT_VETERAN_AGE
          ? FREE_AGENT_VETERAN_APPEAL
          : 1);
    if (rng() > FREE_AGENT_SIGN_CHANCE * appeal) continue;

    const suitor = pickSuitor(state, player, rng);
    if (!suitor) continue;
    signWithClub(state, player, suitor, rng);
    signed += 1;
    digest.push(`무소속 ${player.name}이(가) ${teamName(suitor)}와 계약했습니다`);
    pushNarrative(state, `${player.name} ${teamName(suitor)} 자유계약`, 2);
  }
}

/** 그 선수를 데려갈 만한 구단 — 자리가 얇고 수준이 맞는 곳 */
function pickSuitor(state: GameState, player: GamePlayer, rng: () => number): string | null {
  const group = groupOf(player);
  const candidates: string[] = [];
  for (const team of state.teams) {
    if (team.id === state.userTeamId) continue; // 감독이 직접 데려와야 한다
    if (team.id === FREE_AGENT_TEAM) continue;
    if (leagueOfTeam(team.id) === "free") continue;
    const squad = playersOf(state, team.id);
    if (squad.length === 0 || squad.length >= FREE_AGENT_SUITOR_SQUAD_CAP) continue;

    // 자리가 얇은가
    const atGroup = squad.filter((p) => groupOf(p) === group).length;
    if (atGroup >= SUITOR_GROUP_CROWD) continue;

    // 수준이 비슷한가 — 팀 상위 몇 명의 평균과 견준다 (`SUITOR_LEVEL_SAMPLE`)
    const level =
      squad
        .map((p) => p.attributes.overall)
        .sort((a, b) => b - a)
        .slice(0, SUITOR_LEVEL_SAMPLE)
        .reduce((sum, v) => sum + v, 0) / Math.min(SUITOR_LEVEL_SAMPLE, squad.length);
    const gap = Math.abs(level - player.attributes.overall);
    if (gap > SUITOR_LEVEL_BAND) continue;

    // 급할수록 여러 번 이름을 넣는다 (결정적 rng 하나로 뽑기 위해)
    const weight = Math.max(1, SUITOR_GROUP_CROWD - atGroup);
    for (let i = 0; i < weight; i++) candidates.push(team.id);
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rng() * candidates.length)] ?? null;
}

/** 자유계약 체결 — 이적료 없이 계약만 새로 쓴다 */
function signWithClub(
  state: GameState,
  player: GamePlayer,
  teamId: string,
  rng: () => number,
): void {
  const squad = playersOf(state, teamId);
  const wage = estimateWeeklyWage(
    teamId,
    wageSubjectOf(player, state.date),
    [...squad, player].map((p) => wageSubjectOf(p, state.date)),
    state,
  );
  const years = 1 + Math.floor(rng() * 3);
  state.transfers.push({
    id: `tr-fa-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    windowId: windowOpenOn(state.windows, state.date)?.id ?? null,
    fromTeamId: FREE_AGENT_TEAM,
    toTeamId: teamId,
    date: state.date,
    type: "free",
    fee: 0,
  });
  // 남은 활성 계약을 끝내고 쓴다 — 안 끝내면 한 선수의 주급이 두 구단에서 세어진다
  const previous = activeContract(state, player.id);
  if (previous) previous.status = "ended";
  state.contracts.push({
    id: `c-fa-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    teamId,
    weeklyWage: wage,
    since: state.date,
    until: contractUntil(state.date, years),
    status: "active",
  });
  player.teamId = teamId;
  player.squadNumber = undefined;
  assignSquadNumber(state.players, player);
  player.squadLevel = arrivingSquadLevel(state, player, teamId);
}
