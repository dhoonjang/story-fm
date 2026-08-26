import type { GamePlayer, Interest } from "@story-fm/domain";
import { INTEREST_STAGE_KO } from "@story-fm/domain";
import { diffDays } from "../competition/calendar";
import { makeRng, pickWeighted } from "../core/rng";
import { squadDepthOf, betterAtPosition, type SquadDepth } from "../squad/depth";
import {
  clearInterests,
  hasIssue,
  interestOf,
  interestsOn,
  onLoanFromUs,
  playerById,
  playersOf,
  pushNarrative,
  teamNameIn,
  type GameState,
} from "../core/state";
import {
  deadlineRushOf,
  loanLockOf,
  marketValueOf,
  stageScaleOf,
  suitorWeightOf,
  suitorsOf,
  windowOpenForTeam,
  SUITORS_MANY,
} from "./market";

/**
 * **관심 — 오퍼 앞에 서는 사다리** (→ docs/simulation/transfer.md §1-2).
 *
 * 오퍼는 시장의 첫 사건이 아니라 마지막 사건이다. 어느 구단이 보고 있다는 사실이
 * 먼저 서고(`watching`), 문의가 오고(`enquired`), 그다음에 값을 부를 참이 된다
 * (`bidding`) — 오퍼는 그 마지막 칸에서만 나온다(`generateIncomingOffers`).
 *
 * ⚠️ **코어가 내놓는 것은 사실뿐이다.** "레알이 그를 보고 있다"는 문장은 GM과
 * 기자의 것이고, 여기서 나오는 것은 구단·선수·칸·날짜다 (overview.md §1 철칙 4).
 *
 * ⚠️ **장부를 고치는 곳은 이 파일 하나다.** 읽는 자(`interestsOn`·`interestOf`)는
 * `core/state.ts`에 있고 원본 row를 그대로 돌려주므로, 다른 자리에서 `stage`를
 * 만지면 사다리의 규칙이 두 벌이 된다.
 */

/** 하루에 우리 선수 하나에게 새 관심이 설 확률 — 한 시즌에 스물 몇 건 (`pnpm balance ai-market`) */
export const INTEREST_CHANCE = 0.1;

/** 우리 선수단에 동시에 설 수 있는 관심 줄 수 — 넘으면 스냅샷이 관심 목록이 된다 */
export const INTEREST_MAX = 6;

/** 한 선수를 두고 붙을 수 있는 구단 수 — 셋이면 「관심」이 아니라 「경매」다 */
export const INTEREST_PER_PLAYER = 2;

/** 한 칸에 최소로 머무는 날 — 하루 만에 값을 부르면 감독이 준비할 자리가 없다 */
export const INTEREST_STEP_DAYS = 5;

/** 그 뒤 하루에 한 칸 오를 확률 — 창이 열린 동안만 (`watching`→`bidding` 평균 스무 날) */
export const INTEREST_STEP_CHANCE = 0.15;

/** 우리가 노리는 선수에게 경쟁 구단이 붙을 하루 확률 — 협상이 2주짜리라 붙을까 말까 */
export const RIVAL_INTEREST_CHANCE = 0.12;

/** 한 칸도 못 오른 채 이만큼 지나면 걷힌다 — 창 하나를 흘려보낸 관심은 관심이 아니다 */
export const INTEREST_STALE_DAYS = 60;

/** 이 값 아래의 선수는 시장의 눈에 들지 않는다 — `generateIncomingOffers`와 같은 바닥 */
const INTEREST_VALUE_FLOOR = 1_000_000;

/** 눈에 띄는 상위 후보 — 늘 같은 선수만 노려지지 않게 이 안에서 시드로 뽑는다 */
const INTEREST_POOL = 8;

/**
 * 눈에 띄는 정도 — **값이 나가거나, 자리가 막혔거나, 라커룸에 불만이 선 선수.**
 * 오퍼가 쓰던 자를 그대로 옮겨 왔다: 「누가 눈에 띄는가」는 이제 오퍼가 아니라
 * 관심이 고른다.
 */
function appealOf(state: GameState, player: GamePlayer): number {
  return (
    marketValueOf(state, player) / 1_000_000 +
    (hasIssue(state, player.id) ? 12 : 0) +
    betterAtPosition(state, state.userTeamId, player) * 8
  );
}

/** 우리가 지금 데려오려는 남의 선수들 — 경쟁 관심이 서는 자리 */
function ourTargets(state: GameState): GamePlayer[] {
  const ids = new Set(
    state.negotiations
      .filter((n) => n.status === "open" && (n.kind === "buy" || n.kind === "loan"))
      .map((n) => n.gamePlayerId),
  );
  return [...ids]
    .map((id) => playerById(state, id))
    .filter((p): p is GamePlayer => p !== null && p.teamId !== state.userTeamId);
}

/** 이 구단이 이 값을 감당하는가 — `pickBuyer`와 같은 자 */
function affords(state: GameState, teamId: string, value: number): boolean {
  const finance = state.finances.find((f) => f.teamId === teamId);
  return finance !== undefined && finance.transferBudget >= value;
}

/**
 * 걷히는 자리 셋 — 그 선수가 우리 손을 떠났거나, 우리 협상이 끝났거나, 노화했다.
 * (넷째인 「오퍼가 됐다」는 `generateIncomingOffers`가 그 자리에서 걷는다.)
 *
 * 그리고 **창이 닫힌 구단은 묻기를 멈춘다** — 오른 칸이 `watching`으로 내려간다.
 * 구단은 계속 보지만 더는 묻지 않는다: 11월의 소문이 1월의 오퍼가 되는 길이다.
 */
function pruneInterests(state: GameState): void {
  const rows = state.interests ?? [];
  if (rows.length === 0) return;
  const ours = new Set(playersOf(state, state.userTeamId).map((p) => p.id));
  const targets = new Set(ourTargets(state).map((p) => p.id));
  clearInterests(
    state,
    (i) =>
      i.teamId === state.userTeamId ||
      (!ours.has(i.gamePlayerId) && !targets.has(i.gamePlayerId)) ||
      diffDays(i.lastMovedOn, state.date) >= INTEREST_STALE_DAYS,
  );
  for (const row of state.interests ?? []) {
    if (row.stage === "watching") continue;
    if (windowOpenForTeam(state, row.teamId) !== null) continue;
    row.stage = "watching";
    row.lastMovedOn = state.date;
    delete row.pressedOn;
  }
}

/** 사다리를 한 칸 올린다 — **창이 열린 구단만.** 오르는 순간이 곧 밖에 나는 순간이다 */
function climbInterests(state: GameState, digest: string[]): void {
  const rows = state.interests ?? [];
  if (rows.length === 0) return;
  const rng = makeRng(state.seed, `interest-step:${state.date}`);
  for (const row of rows) {
    if (row.stage === "bidding") continue;
    if (diffDays(row.lastMovedOn, state.date) < INTEREST_STEP_DAYS) continue;
    if (windowOpenForTeam(state, row.teamId) === null) continue;
    // **마감 주에는 사다리가 빨리 오른다** — 창이 닫히기 전에 묻던 구단이 값을 부른다
    // (transfer.md §1-3). 재는 창은 그 줄의 주인 것이다
    if (rng() >= INTEREST_STEP_CHANCE * deadlineRushOf(state, row.teamId)) continue;
    const player = playerById(state, row.gamePlayerId);
    if (!player) continue;
    row.stage = row.stage === "watching" ? "enquired" : "bidding";
    row.lastMovedOn = state.date;
    // 새 사실이라 회견이 다시 묻는다 — 「보고 있다」와 「값을 부를 참이다」는 다르다
    delete row.pressedOn;
    announce(state, row, player, digest);
  }
}

/** 칸이 오른 사실 한 줄 — 우리 선수인가 우리가 노리는 선수인가로 결이 갈린다 */
function announce(state: GameState, row: Interest, player: GamePlayer, digest: string[]): void {
  const club = teamNameIn(state, row.teamId);
  const ours = player.teamId === state.userTeamId;
  const line = ours
    ? row.stage === "enquired"
      ? `📰 ${club}에서 ${player.name}에 대해 문의가 왔습니다`
      : `📰 ${club}가 ${player.name} 영입을 준비하고 있습니다`
    : `📰 ${club}도 ${player.name}에게 ${INTEREST_STAGE_KO[row.stage]} 단계입니다 — 우리 협상과 겹칩니다`;
  digest.push(line);
  // 문의는 알아 둘 일이고 입찰 임박은 오늘 움직일 일이다 (오퍼 도착이 3 · people.md §9)
  pushNarrative(
    state,
    `${club} — ${player.name} ${INTEREST_STAGE_KO[row.stage]}`,
    row.stage === "bidding" ? 3 : 2,
  );
}

/**
 * 우리 선수에게 새 관심 하나 — **주사위가 선 뒤에 색인을 세운다.**
 * 하루 확률이 10%라, 그 날마다 5,000명짜리 색인을 세우면 시즌 하나가 색인 값이 된다
 * (`club/approach.ts`의 `bigger-club`과 같은 자리).
 */
function standOnOurs(state: GameState, rng: () => number, depthOf: () => SquadDepth): void {
  const rows = state.interests ?? [];
  const ours = new Set(playersOf(state, state.userTeamId).map((p) => p.id));
  if (rows.filter((i) => ours.has(i.gamePlayerId)).length >= INTEREST_MAX) return;

  const candidates = playersOf(state, state.userTeamId)
    .filter(
      (p) =>
        // 임대는 어느 방향이든 남의 계약이 걸린 자리라 관심이 붙지 않는다
        !onLoanFromUs(state, p) &&
        loanLockOf(p) === null &&
        marketValueOf(state, p) > INTEREST_VALUE_FLOOR &&
        interestsOn(state, p.id).length < INTEREST_PER_PLAYER,
    )
    .map((p) => ({ player: p, appeal: appealOf(state, p) }))
    .sort((a, b) =>
      b.appeal === a.appeal ? (a.player.id < b.player.id ? -1 : 1) : b.appeal - a.appeal,
    );
  if (candidates.length === 0) return;

  const pool = candidates.slice(0, INTEREST_POOL);
  const chosen = pool[Math.floor(rng() * pool.length)]!.player;
  const value = marketValueOf(state, chosen);
  const options = suitorsOf(state, chosen, depthOf()).filter(
    (id) => affords(state, id, value) && interestOf(state, id, chosen.id) === undefined,
  );
  if (options.length === 0) return;
  /**
   * **주인은 무대로 뽑힌다** — 균등이 아니다 (`suitorWeightOf` — transfer.md §1-3).
   * 관심에서 나오는 오퍼는 구단을 다시 고르지 않으므로(`generateIncomingOffers`),
   * 「누가 우리 선수를 노리는가」가 실질적으로 정해지는 자리가 여기다.
   */
  const scale = stageScaleOf(state);
  const blockedHere = betterAtPosition(state, state.userTeamId, chosen);
  const teamId = pickWeighted(rng, options, (id) =>
    suitorWeightOf(state, id, chosen, scale, blockedHere),
  );
  (state.interests ??= []).push({
    teamId,
    gamePlayerId: chosen.id,
    since: state.date,
    stage: "watching",
    lastMovedOn: state.date,
  });
}

/**
 * 우리가 노리는 선수에게 경쟁 구단 하나 — **`enquired`에서 선다.**
 *
 * 우리가 이미 문의를 넣은 선수다. 그 구단은 시장에 나와 있고, 경쟁자가 붙었다는
 * 사실은 그 구단이 우리에게 알리는 방식으로 온다 — 아무도 모르는 관심이었다면
 * 협상 서류에 실릴 자리가 없다.
 */
function standOnTarget(
  state: GameState,
  rng: () => number,
  depthOf: () => SquadDepth,
  digest: string[],
): void {
  const targets = ourTargets(state);
  if (targets.length === 0) return;
  const chosen = targets[Math.floor(rng() * targets.length)]!;
  if (interestsOn(state, chosen.id).length >= INTEREST_PER_PLAYER) return;
  // 갈 곳이 많은 선수여야 경쟁이 붙는다 — 딜 확률이 쓰는 것과 같은 문턱
  const suitors = suitorsOf(state, chosen, depthOf()).filter((id) => id !== chosen.teamId);
  if (suitors.length < SUITORS_MANY) return;
  const value = marketValueOf(state, chosen);
  const options = suitors.filter(
    (id) =>
      affords(state, id, value) &&
      interestOf(state, id, chosen.id) === undefined &&
      windowOpenForTeam(state, id) !== null,
  );
  if (options.length === 0) return;
  const teamId = options[Math.floor(rng() * options.length)]!;
  const row: Interest = {
    teamId,
    gamePlayerId: chosen.id,
    since: state.date,
    stage: "enquired",
    lastMovedOn: state.date,
  };
  (state.interests ??= []).push(row);
  announce(state, row, chosen, digest);
}

/**
 * 하루치 관심 — tick이 `generateIncomingOffers` **앞에서** 부른다.
 * 걷고, 올리고, 세운다. 오늘 선 줄은 오늘 오르지 않는다(`INTEREST_STEP_DAYS`).
 */
export function tickInterests(state: GameState, digest: string[]): void {
  pruneInterests(state);
  climbInterests(state, digest);

  const rng = makeRng(state.seed, `interest:${state.date}`);
  let depth: SquadDepth | null = null;
  const depthOf = (): SquadDepth => (depth ??= squadDepthOf(state));
  if (rng() < INTEREST_CHANCE) standOnOurs(state, rng, depthOf);
  if (rng() < RIVAL_INTEREST_CHANCE) standOnTarget(state, rng, depthOf, digest);
}

/**
 * 관심 한 줄의 표기 — **화면·스냅샷·조회·협상 서류가 같은 함수를 부른다.**
 * 「구단 (칸)」뿐이다. 문장은 읽는 쪽이 만든다.
 */
export function interestLabel(state: GameState, interest: Interest): string {
  return `${teamNameIn(state, interest.teamId)} (${INTEREST_STAGE_KO[interest.stage]})`;
}

/** 이 선수에게 서 있는 관심을 한 줄로 — 없으면 `null` */
export function interestLine(state: GameState, playerId: string): string | null {
  const rows = interestsOn(state, playerId);
  return rows.length === 0 ? null : rows.map((row) => interestLabel(state, row)).join(" · ");
}

/**
 * 상태 스냅샷의 `<interest>` 블록 — 우리 선수와 우리가 노리는 선수, 두 결이다
 * (→ docs/llm/agents.md §6). 없으면 빈 배열이라 덩어리가 서지 않는다.
 */
export function describeInterests(state: GameState): string[] {
  const seen = new Map<string, GamePlayer>();
  for (const row of state.interests ?? []) {
    const player = playerById(state, row.gamePlayerId);
    if (player) seen.set(player.id, player);
  }
  const lines: string[] = [];
  for (const player of [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const label = interestLine(state, player.id);
    if (label === null) continue;
    const ours = player.teamId === state.userTeamId;
    lines.push(`- ${player.name}${ours ? "" : " (영입 대상)"} ← ${label}`);
  }
  return lines;
}
