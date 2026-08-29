import {
  PROMISE_KIND_KO,
  RELATION_TIER_KO,
  SQUAD_STATUS_KO,
  describeReputation,
  isPlayerDeal,
  mediaFactText,
  naturalPositionOf,
  seasonRating,
  type GamePlayer,
  type Negotiation,
} from "@story-fm/domain";
import {
  MANAGER_SUBJECT,
  betterAtPosition,
  competitionName,
  computeStandings,
  describeWindowState,
  diffDays,
  euroCompetitionOf,
  financeOf,
  formLabel,
  formatMoney,
  hasIssue,
  leagueOfTeamIn,
  moodOf,
  openInjury,
  openPromises,
  playerById,
  playersOf,
  relationTierOf,
  seasonStatOf,
  squadStatusOf,
  stageScaleOf,
  teamNameIn,
  weeklyWagesOf,
  type GameState,
} from "@story-fm/engine";

/**
 * `<situation>` — **테이블 건너편이 아는 주변 상황** (agents.md §4-1 · transfer.md §12-2).
 *
 * 서류(`<counterparty>`)는 이 협상의 사실이고, 여기는 그 협상을 둘러싼 세계다 — 시계,
 * 답하는 쪽의 처지, 선수의 지금, 우리 구단이 밖에서 어떻게 보이는가. 상대가 "급한 건
 * 그쪽"이라 말할 수 있으려면 마감까지 며칠인지 알아야 하고, "우리 팀에 그 자리 선수가
 * 넷"이라 말하려면 그 수를 알아야 한다. 사실만 싣고 지시문은 싣지 않는다 (prompts.md §5).
 *
 * ⚠️ **메인 채팅은 여기 없다.** 상대는 감독이 이사회나 라커룸에 한 말을 모른다 — 그것이
 * 테이블을 GM 턴 밖에 따로 세운 이유다.
 */

/** 최근 기사 수 — 배경이지 화제가 아니다 */
const SITUATION_MEDIA_LINES = 3;
/** 두 구단 사이의 지난 거래 — 최근 것부터 이만큼 */
const SITUATION_PAST_DEALS = 3;

/** 리그 순위 한 줄 — `프리미어리그 4위 (12경기 승점 25)` */
function standingLine(state: GameState, teamId: string): string | null {
  const leagueId = leagueOfTeamIn(state, teamId);
  const rows = computeStandings(state, leagueId);
  const index = rows.findIndex((r) => r.teamId === teamId);
  if (index < 0) return null;
  const row = rows[index]!;
  return `${competitionName(leagueId)} ${index + 1}위 (${row.played}경기 승점 ${row.points})`;
}

/** 유럽 무대 한 줄 — 나가지 않으면 없다 */
function euroLine(state: GameState, teamId: string): string | null {
  const cupId = euroCompetitionOf(state.euroEntrants, teamId);
  return cupId === null ? null : `유럽: ${competitionName(cupId)}`;
}

/** 우리와의 무대 격차 — 부호는 상대 기준이다 */
function stageLine(state: GameState, teamId: string): string {
  const gap = stageScaleOf(state).gapTo(teamId);
  if (Math.abs(gap) < 0.15) return "무대: 우리와 비슷하다";
  return gap > 0 ? "무대: 우리보다 크다" : "무대: 우리보다 작다";
}

/** 답하는 구단의 처지 — 순위·유럽·그 자리의 깊이·재정·무대 */
function clubBlock(state: GameState, teamId: string, player: GamePlayer): string[] {
  const position = naturalPositionOf(player).position;
  const atPosition = playersOf(state, teamId).filter(
    (p) => naturalPositionOf(p).position === position,
  ).length;
  const better = betterAtPosition(state, teamId, player);
  const finance = financeOf(state, teamId);
  return [
    `<club name="${teamNameIn(state, teamId)}">`,
    ...[standingLine(state, teamId), euroLine(state, teamId)].filter(
      (l): l is string => l !== null,
    ),
    `이 자리(${position}): 선수 ${atPosition}명 · 그중 ${player.name}보다 나은 사람 ${better}명`,
    `재정: 이적 예산 ${formatMoney(finance.transferBudget)} · 주급 총액 ${formatMoney(
      weeklyWagesOf(state, teamId),
    )}/주 · 잔고 ${formatMoney(finance.balance)}`,
    stageLine(state, teamId),
    `</club>`,
  ];
}

/** 선수의 지금 — 시즌 기록·폼·부상·지위·심경·약속·감독과의 관계 */
function playerBlock(state: GameState, negotiation: Negotiation, player: GamePlayer): string[] {
  const ours = player.teamId === state.userTeamId;
  const stat = seasonStatOf(state, player.id);
  const rating = seasonRating(stat);
  const injury = openInjury(state, player.id);
  const mood = moodOf(state, player).note;
  const promises = ours ? openPromises(state, player.id) : [];
  return [
    `<player_now>`,
    stat
      ? `이번 시즌: 출전 ${stat.apps} · 골 ${stat.goals} · 도움 ${stat.assists ?? 0}` +
        (rating === null ? "" : ` · 평점 ${rating}`)
      : `이번 시즌: 출전 없음`,
    `폼 ${formLabel(player.state.form)}` +
      (injury ? ` · 부상 중` : "") +
      ` · 지위 ${SQUAD_STATUS_KO[squadStatusOf(state, player)]}` +
      (hasIssue(state, player.id) ? " · 라커룸에 불만이 서 있다" : ""),
    ...(mood ? [`심경: ${mood}`] : []),
    ...(promises.length > 0
      ? [
          `감독의 약속: ${promises.map((p) => `${PROMISE_KIND_KO[p.kind]} (${p.dueOn}까지)`).join(" · ")}`,
        ]
      : []),
    ...(ours || isPlayerDeal(negotiation.kind)
      ? [`감독과의 관계: ${RELATION_TIER_KO[relationTierOf(state, MANAGER_SUBJECT, player.id)]}`]
      : []),
    `</player_now>`,
  ];
}

/** 두 구단 사이의 지난 거래 — 상대가 "지난번엔"이라 말할 수 있는 사실 */
function pastDealsLine(state: GameState, otherTeamId: string): string | null {
  const us = state.userTeamId;
  const deals = state.transfers
    .filter(
      (t) =>
        (t.fromTeamId === us && t.toTeamId === otherTeamId) ||
        (t.fromTeamId === otherTeamId && t.toTeamId === us),
    )
    .slice(-SITUATION_PAST_DEALS)
    .reverse();
  if (deals.length === 0) return null;
  return (
    `지난 거래: ` +
    deals
      .map((t) => {
        const name = playerById(state, t.gamePlayerId)?.name ?? t.gamePlayerId;
        const arrow = t.toTeamId === us ? "→ 우리" : "→ 그쪽";
        return `${t.date} ${name} ${arrow} ${formatMoney(t.fee)}`;
      })
      .join(" · ")
  );
}

/** 우리 구단이 밖에서 보이는 모습 — 순위·유럽·감독 평판·무대·지난 거래 */
function ourClubBlock(state: GameState, otherTeamId: string | null): string[] {
  const us = state.userTeamId;
  return [
    `<our_club name="${teamNameIn(state, us)}">`,
    ...[standingLine(state, us), euroLine(state, us)].filter((l): l is string => l !== null),
    `감독 평판: ${describeReputation(state.manager.reputation)}`,
    ...(otherTeamId === null ? [] : [pastDealsLine(state, otherTeamId)].filter((l) => l !== null)),
    `</our_club>`,
  ];
}

/** 시계 — 이적창과 협상 기한 */
function clockLine(state: GameState, negotiation: Negotiation): string {
  const left = diffDays(state.date, negotiation.expiresOn);
  return (
    `<clock>${describeWindowState(state)} · 협상 기한 ${negotiation.expiresOn}` +
    (left > 0 ? ` (${left}일 남음)` : " (오늘)") +
    `</clock>`
  );
}

/** 회견 밖의 기사 — 그날의 배경 */
function pressBlock(state: GameState): string[] {
  const facts = (state.media ?? []).slice(-SITUATION_MEDIA_LINES);
  if (facts.length === 0) return [];
  return [`<press>`, ...facts.map((f) => `- ${f.date} · ${mediaFactText(f)}`), `</press>`];
}

/**
 * 답하는 쪽의 구단 — 선수 본인이 답하는 갈래(재계약·해지·사전 계약)에는 없다.
 * 매각·임대 송출의 상대는 선수의 소속이 아니라 사려는 구단이다 (transfer.md §1).
 */
function answeringClubOf(negotiation: Negotiation, player: GamePlayer): string | null {
  if (isPlayerDeal(negotiation.kind) || negotiation.precontract === true) return null;
  const selling = negotiation.kind === "sell" || negotiation.kind === "loan_out";
  return selling ? (negotiation.counterpartTeamId ?? null) : player.teamId;
}

export function buildSituationBlock(state: GameState, negotiation: Negotiation): string | null {
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return null;
  const club = answeringClubOf(negotiation, player);
  return [
    `<situation date="${state.date}">`,
    clockLine(state, negotiation),
    ...(club === null ? [] : clubBlock(state, club, player)),
    ...playerBlock(state, negotiation, player),
    ...ourClubBlock(state, club),
    ...pressBlock(state),
    `</situation>`,
  ].join("\n");
}
