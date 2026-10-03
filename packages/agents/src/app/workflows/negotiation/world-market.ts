import { playerOverall, type Negotiation } from "@story-fm/domain";
import {
  squadRegistrationOf,
  journal,
  type JournalEntry,
  repairNegotiationSquads,
  openNegotiation,
  actNegotiation,
  reviewBoard,
  managedTeamId,
  addDays,
  FREE_AGENT_TEAM,
  type GameState,
} from "@story-fm/engine";
import {
  agentConfig,
  createGameLLM,
  resolveLlmMode,
  ScriptedGameLLM,
  type GameLLM,
} from "@story-fm/llm";
import { ModelOutputError, readOutput, retryOnce } from "../../../common/retry";
import {
  MARKET_PLANNER_SYSTEM,
  MARKET_PLAN_INPUT,
  MarketPlanSchema,
} from "../../../negotiation/market-planner";
import { runNegotiationTurn } from "./negotiation-turn";

export const MARKET_REVIEW_OLDEST_CLUBS = 10;
export const MARKET_REVIEW_URGENT_CLUBS = 2;
export const MARKET_REVIEW_INTERVAL_DAYS = 7;
export const MARKET_ALTERNATIVES_MAX = 120;
export const MARKET_ACTIVE_CASES_PER_BUYER = 2;
export const MARKET_AI_REPLIES_PER_DAY = 12;

export function marketAlternatives(state: GameState, teamIds: readonly string[]) {
  const chosen = new Set<string>();
  for (const teamId of teamIds) {
    const squad = state.players.filter((p) => p.teamId === teamId);
    const positions = new Set(squad.flatMap((p) => p.positions));
    const typicalOverall = squad.length
      ? squad.reduce((sum, p) => sum + playerOverall(p), 0) / squad.length
      : 60;
    const candidates = state.players
      .filter((p) => p.teamId !== teamId && p.positions.some((pos) => positions.has(pos)))
      .sort(
        (a, b) =>
          Math.abs(playerOverall(a) - typicalOverall) -
            Math.abs(playerOverall(b) - typicalOverall) || a.id.localeCompare(b.id),
      );
    for (const p of [
      ...candidates
        .filter((p) => state.transferListings.some((listing) => listing.gamePlayerId === p.id))
        .slice(0, 10),
      ...candidates.filter((p) => p.teamId === FREE_AGENT_TEAM).slice(0, 10),
      ...candidates
        .filter((p) =>
          state.contracts.some(
            (c) =>
              c.gamePlayerId === p.id &&
              c.status === "active" &&
              c.until <= addDays(state.date, 180),
          ),
        )
        .slice(0, 10),
      ...candidates.slice(0, 10),
    ])
      chosen.add(p.id);
  }
  return state.players
    .filter((p) => chosen.has(p.id))
    .slice(0, MARKET_ALTERNATIVES_MAX)
    .map((p) => ({
      id: p.id,
      name: p.name,
      teamId: p.teamId,
      positions: p.positions,
      overall: playerOverall(p),
      transferListing:
        state.transferListings.find((listing) => listing.gamePlayerId === p.id) ?? null,
      contract: state.contracts.find((c) => c.gamePlayerId === p.id && c.status === "active"),
    }));
}

function activeMarketCase(n: Negotiation): boolean {
  return (
    n.status === "open" ||
    n.status === "signed" ||
    (n.status === "completed" && n.registration !== "registered")
  );
}

export function marketClubFacts(state: GameState, teamId: string) {
  const players = state.players.filter((p) => p.teamId === teamId);
  const ids = new Set(players.map((p) => p.id));
  const contracts = state.contracts.filter((c) => ids.has(c.gamePlayerId) && c.status === "active");
  return {
    team: state.teams.find((t) => t.id === teamId),
    registration: squadRegistrationOf(state, teamId),
    squad: players.map((p) => ({
      id: p.id,
      name: p.name,
      positions: p.positions,
      level: p.squadLevel,
      overall: playerOverall(p),
      birthdate: p.birthdate,
    })),
    injuries: state.injuries.filter((i) => ids.has(i.gamePlayerId) && !i.returnedOn),
    contracts,
    transferListings: state.transferListings.filter((listing) => ids.has(listing.gamePlayerId)),
    finances: state.finances
      .filter((f) => f.teamId === teamId)
      .map((f) => ({ balance: f.balance })),
    payments: state.transferPayments.filter((p) => p.fromTeamId === teamId && !p.paidOn),
    matches: state.matches
      .filter((m) => !!m.result && (m.homeTeamId === teamId || m.awayTeamId === teamId))
      .slice(-8),
    vacancies: state.managerVacancies.filter((v) => v.teamId === teamId),
    previous: state.marketReview.clubs.find((c) => c.teamId === teamId)?.plan ?? null,
  };
}

/** No prose or day counters in the fingerprint: only a change in actual facts creates priority. */
export function marketClubFingerprint(state: GameState, teamId: string): string {
  const facts = marketClubFacts(state, teamId);
  return JSON.stringify({
    team: facts.team && {
      id: facts.team.id,
      tier: facts.team.tier,
      managerName: facts.team.managerName,
      managerSince: facts.team.managerSince,
    },
    squad: facts.squad.map((p) => ({ id: p.id, positions: p.positions, level: p.level })),
    injuries: facts.injuries,
    transferListings: facts.transferListings,
    contracts: facts.contracts.map((c) => ({
      id: c.id,
      playerId: c.gamePlayerId,
      weeklyWage: c.weeklyWage,
      since: c.since,
      until: c.until,
      registrationStatus: c.registrationStatus,
    })),
    payments: facts.payments,
    vacancies: facts.vacancies,
  });
}

function worldClient(state: GameState, teamIds: readonly string[], llm?: GameLLM): GameLLM {
  if (llm) return llm;
  const config = agentConfig("market-planner");
  if (resolveLlmMode() !== "mock") return createGameLLM(config);
  return new ScriptedGameLLM(config, () => {
    const managed = managedTeamId(state);
    const negotiations = teamIds.flatMap((teamId) => {
      if (
        teamId === managed ||
        state.negotiations.filter((n) => n.buyerId === teamId && activeMarketCase(n)).length >=
          MARKET_ACTIVE_CASES_PER_BUYER
      )
        return [];
      const player = state.players.find(
        (p) =>
          p.teamId === teamId &&
          state.contracts.some(
            (c) =>
              c.gamePlayerId === p.id &&
              c.status === "active" &&
              c.until <= addDays(state.date, 180),
          ) &&
          !state.negotiations.some(
            (n) => n.playerId === p.id && n.buyerId === teamId && activeMarketCase(n),
          ),
      );
      return player
        ? [
            {
              playerId: player.id,
              buyerId: teamId,
              kind: "renewal",
              background: "만료가 다가오는 선수의 재계약을 검토합니다",
            },
          ]
        : [];
    });
    return {
      output: {
        clubs: teamIds.map((teamId) => ({
          teamId,
          plan: "현재 명단·계약·자금을 검토하고 만료 예정 선수의 재계약을 우선합니다",
        })),
        negotiations,
        board: [],
      },
    };
  });
}

/** The caller invokes this after date advancement, never for an inbox GET. */
export async function processWorldMarket(
  state: GameState,
  llm?: GameLLM,
  negotiationLlm?: GameLLM,
): Promise<{ reviewed: number; replied: number }> {
  const draft = structuredClone(state);
  const records: JournalEntry[] = [];
  const due = draft.marketReview.lastDate !== draft.date;
  let reviewed = 0;
  if (due) {
    const ids = draft.teams
      .filter((t) => t.id !== FREE_AGENT_TEAM && draft.finances.some((f) => f.teamId === t.id))
      .map((t) => t.id);
    ids.sort((a, b) => {
      const pa = draft.marketReview.clubs.find((c) => c.teamId === a);
      const pb = draft.marketReview.clubs.find((c) => c.teamId === b);
      return (pa?.reviewedOn ?? "").localeCompare(pb?.reviewedOn ?? "") || a.localeCompare(b);
    });
    const eligible = ids.filter((id) => {
      const previous = draft.marketReview.clubs.find((c) => c.teamId === id);
      return !previous || addDays(previous.reviewedOn, MARKET_REVIEW_INTERVAL_DAYS) <= draft.date;
    });
    const urgent = ids
      .filter((id) => {
        const previous = draft.marketReview.clubs.find((c) => c.teamId === id);
        return (
          previous &&
          previous.reviewedOn < draft.date &&
          previous.fingerprint !== marketClubFingerprint(draft, id)
        );
      })
      .slice(0, MARKET_REVIEW_URGENT_CLUBS);
    const cohort = [...new Set([...eligible.slice(0, MARKET_REVIEW_OLDEST_CLUBS), ...urgent])];
    for (let start = 0; start < cohort.length; start += 4) {
      const teamIds = cohort.slice(start, start + 4);
      const answer = await retryOnce("market-planner", async () => {
        const result = await worldClient(draft, teamIds, llm).runTurn({
          system: MARKET_PLANNER_SYSTEM,
          history: [],
          user: "현재 날짜에 구단의 계획과 필요한 협상·감독 고용을 검토하세요.",
          stateNote: JSON.stringify({
            date: draft.date,
            managedClub: managedTeamId(draft),
            clubs: teamIds.map((id) => marketClubFacts(draft, id)),
            alternatives: marketAlternatives(draft, teamIds),
            cases: draft.negotiations.filter(activeMarketCase).map((n) => ({
              id: n.id,
              playerId: n.playerId,
              buyerId: n.buyerId,
              sellerId: n.sellerId,
              status: n.status,
              registration: n.registration,
            })),
            managerPool: draft.managerPool,
          }),
          outputSchema: MARKET_PLAN_INPUT,
        });
        const answer = readOutput("market-planner", MarketPlanSchema, result);
        if (
          answer.clubs.length !== teamIds.length ||
          new Set(answer.clubs.map((c) => c.teamId)).size !== teamIds.length ||
          answer.clubs.some((c) => !teamIds.includes(c.teamId))
        )
          throw new ModelOutputError("검토 대상 구단의 계획이 모두 필요합니다");
        if (
          answer.negotiations.some(
            (n) => !teamIds.includes(n.buyerId) || n.buyerId === managedTeamId(draft),
          ) ||
          answer.board.some((b) => !teamIds.includes(b.team))
        )
          throw new ModelOutputError("검토 범위 밖의 구단 결정입니다");
        if (
          answer.board.some(
            (b) =>
              b.action === "appoint" && !draft.managerPool.some((m) => m.name === b.managerName),
          )
        )
          throw new ModelOutputError("실제 감독 후보에서 선임해야 합니다");
        for (const teamId of teamIds) {
          const active = draft.negotiations.filter(
            (n) => activeMarketCase(n) && n.buyerId === teamId,
          ).length;
          const newCases = answer.negotiations.filter(
            (n) =>
              n.buyerId === teamId &&
              !draft.negotiations.some(
                (existing) =>
                  existing.status === "open" &&
                  existing.buyerId === teamId &&
                  existing.playerId === n.playerId,
              ),
          ).length;
          if (active + newCases > MARKET_ACTIVE_CASES_PER_BUYER)
            throw new ModelOutputError("영입 구단의 진행 중인 협상은 두 건 이내로 계획하세요");
        }
        return answer;
      });
      records.push({
        kind: "command",
        name: "market_review",
        input: { on: draft.date, teamIds, decisions: answer },
        ok: true,
        message: "구단 시장 계획과 협상·고용 결정을 처리했습니다",
        source: "tool",
      });
      for (const input of answer.negotiations) {
        const outcome = openNegotiation(draft, input, "world");
        if (!outcome.ok) throw new ModelOutputError(outcome.message);
      }
      for (const input of answer.board) {
        const outcome = reviewBoard(draft, input);
        if (!outcome.ok) throw new ModelOutputError(outcome.message);
      }
      for (const club of answer.clubs) {
        draft.marketReview.clubs = draft.marketReview.clubs.filter((c) => c.teamId !== club.teamId);
        draft.marketReview.clubs.push({
          ...club,
          reviewedOn: draft.date,
          fingerprint: marketClubFingerprint(draft, club.teamId),
        });
        reviewed += 1;
      }
    }
    draft.marketReview.lastDate = draft.date;
  }
  let replied = 0;
  const managed = managedTeamId(draft);
  const pending = draft.negotiations
    .filter((n) => n.status === "open" && n.nextReplyOn !== null && n.nextReplyOn <= draft.date)
    .sort(
      (a, b) =>
        (a.nextReplyOn ?? "").localeCompare(b.nextReplyOn ?? "") ||
        (a.messages.filter((m) => m.author === "gm").at(-1)?.on ?? "").localeCompare(
          b.messages.filter((m) => m.author === "gm").at(-1)?.on ?? "",
        ) ||
        a.openedOn.localeCompare(b.openedOn) ||
        a.id.localeCompare(b.id),
    );
  const userCases = pending.filter((n) => n.buyerId === managed || n.sellerId === managed);
  const aiCases = pending.filter((n) => n.buyerId !== managed && n.sellerId !== managed);
  for (const n of [...userCases, ...aiCases.slice(0, MARKET_AI_REPLIES_PER_DAY)]) {
    const result = await runNegotiationTurn(
      draft,
      n.id,
      "internal",
      undefined,
      negotiationLlm,
      records,
    );
    if (result.ok) replied += 1;
  }
  for (const n of aiCases.slice(MARKET_AI_REPLIES_PER_DAY)) {
    const current = draft.negotiations.find((current) => current.id === n.id);
    if (current?.status === "open") current.nextReplyOn = addDays(draft.date, 1);
  }
  for (const n of draft.negotiations.filter(
    (n) =>
      n.status === "completed" &&
      n.registration !== "registered" &&
      n.buyerId !== managedTeamId(draft),
  )) {
    const result = actNegotiation(
      draft,
      n.id,
      { kind: "register" },
      { kind: "model", partyId: n.buyerId },
    );
    if (result.ok) {
      repairNegotiationSquads(draft, [n.buyerId]);
      records.push({
        kind: "command",
        name: "negotiation_registration",
        input: { negotiationId: n.id, buyerId: n.buyerId },
        ok: true,
        message: result.message,
        source: "tool",
      });
    }
  }
  Object.assign(state, draft);
  for (const record of records) journal(record);
  return { reviewed, replied };
}
