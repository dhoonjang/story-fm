import type {
  CallUp,
  Contract,
  GamePlayer,
  MatchEventType,
  MatchRecord,
  MatchStage,
  ScheduleEntry,
  SeasonHistory,
  SeasonMatchRow,
  SeasonRecord,
  SeasonStat,
  SeasonTableRow,
  ShootoutOutcome,
  ShotOrigin,
  StrongFoot,
  Trophy,
  VisionReading,
  YouthCandidate,
} from "@story-fm/domain";
import {
  DERBY_HEAT_KO,
  VISION_CODE_KO,
  injuryRiskText,
  isReserveMatch,
  MatchStageSchema,
  packetTagText,
  PROMISE_KIND_KO,
  SQUAD_STATUS_KO,
  tacticsBrief,
} from "@story-fm/domain";
import {
  YELLOWS_PER_SUSPENSION,
  ageOf,
  anchorOf,
  associationName,
  capsOf,
  internationalGoalsOf,
  boardExpectationLine,
  boardExpectationText,
  conditionLabel,
  sharpnessLabel,
  sharpnessOf,
  describeReputation,
  familiarityLabel,
  footLabel,
  growthLabel,
  LEADER_ROLE_LABEL,
  milestoneTitle,
  physiqueLabel,
  naturalPositionOf,
  parseScorerEntry,
  roleFit,
  rolesFor,
  seasonRating,
  slotOfTime,
  strongFootOf,
  visionItemText,
} from "@story-fm/domain";
import { rankByName } from "../core/name-match";
import { formatMoney } from "../club/finance";
import { youthCandidateFog } from "../squad/scouting";
import { derbyRecordOf } from "../club/derby";
import { derbyOf } from "../data/derbies";
import { spendLine, transferFundRoom } from "../club/manager-wallet";
import {
  buildMatchReport,
  outcomeFor,
  outcomeLabel,
  pushRecordJournal,
  type CalendarEventView,
  type MatchReportEventView,
  type MatchReportPlayerView,
  type MatchReportView,
} from "./views";
import { addDays, dayOfWeek, diffDays, squadReturnOf } from "../competition/calendar";
import {
  daysUntilReturn,
  internationalBreaksOf,
  openCallUp,
  type InternationalBreak,
} from "../competition/international";
import { careerOf, careerTotalsOf, type CareerTotals } from "../squad/career";
import { leaderGroupOf } from "../squad/hierarchy";
import { formLabel } from "../squad/form";
import { INJURY_SEVERITY_KO, injuryRiskFor } from "../squad/injury";
import { ABSENT_REASON_KO, buildOpponentReport } from "../match/preview";
import { issueReasonText, moodAnchor, moodOf } from "../squad/mood";
import { numberLineageOf } from "../squad/numbers";
import { openPromises, squadStatusOf } from "../squad/promises";
import {
  isHomegrownFor,
  occupiesSquadList,
  registrationLine,
  squadRegistrationOf,
} from "../squad/registration";
import {
  competitionLabel,
  competitionName,
  competitionShortName,
  isCup,
  stageLabel,
} from "../data/cup-catalog";
import { DOMESTIC_STAGES, domesticStageLabel, isDomesticCup } from "../data/domestic-cup-catalog";
import {
  competitionHint,
  inPlayerPool,
  norm,
  playerPoolOf,
  resolveCompetition,
  resolveCompetitionId,
  type PlayerPool,
} from "../world/player-pool";
import { domesticStageMatches } from "../competition/domestic-cup";
import { drawParts, drawTitle } from "../competition/draw-schedule";
import { isClubTeam, teamCatalog } from "../data/team-catalog";
import { leagueOfTeamIn } from "../competition/promotion";
import { tierOfTeamIn } from "../core/club-tier";
import {
  achievementLine,
  awardLine,
  boardExpectation,
  computeStandings,
  ourYouthCandidates,
  youthIntakeDeadline,
} from "../competition/season";
import { visionOf, visionReadings, visionSpanOf, visionYearOf } from "../club/vision";
import {
  clubHonoursLine,
  clubRecordsOf,
  leagueTableOf,
  managerTenureOf,
  managerTrophiesOf,
  pastSeasonsOf,
  seasonHistoryOf,
  seasonLabelOf,
} from "../competition/records";
import { openManagerOffers, USER_WARNINGS_BEFORE_SACK } from "../market/manager-market";
import { observedMarketValue } from "../market/market";
import { interestLine } from "../market/interest";
import {
  attributeLine,
  KNOWLEDGE_RANK,
  knowledgeNote,
  knowledgeOf,
  observationOf,
  observedOverall,
  overallView,
  potentialBand,
  potentialView,
  readCondition,
  strengthsAndWeaknesses,
  type Knowledge,
} from "../squad/scouting";
import {
  activeContract,
  activeSuspension,
  assignmentFor,
  familiarityOf,
  groupOf,
  isAvailable,
  isOurPlayer,
  managedTeamId,
  onLoanFromUs,
  openInjury,
  ourPlayers,
  playerById,
  playerName,
  playersOf,
  proficiencyAt,
  resolvePlayerRef,
  seasonStatOf,
  squadFamiliarity,
  squadLevelOf,
  tacticsOf,
  teamNameIn,
  teamShortNameIn,
  type GameState,
} from "../core/state";
import { loanReportOf, loanedOut, type LoanReport } from "../market/departures";

/**
 * 읽기 전용 조회 (lookup) — GM이 온디맨드로 부르는 조회 도구의 엔진 구현.
 *
 * 왜 컨텍스트 대신 도구인가: 매 턴 스쿼드 표를 프롬프트에 밀어넣으면 (a) 캐시
 * 밖 토큰을 매번 다시 읽고 (b) 그래도 타 팀·순위·일정은 못 담는다. 조회를
 * 도구로 열면 필요할 때만 읽고, 안개(scouting.ts)를 같은 자리에서 적용할 수 있다.
 *
 * 규약: 상태를 절대 바꾸지 않는다. 타 팀 정보는 반드시 scouting.ts를 거친다 —
 * 여기서 참값 숫자를 흘리면 안개가 무의미해진다.
 */

export interface LookupResult {
  ok: boolean;
  message: string;
}

/** 결과 행 수 상한 — 컨텍스트 폭주 방지 */
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 15;

// ── 이름 해석 (팀·대회) ─────────────────────────────────
//
// 감독은 카탈로그 표기를 모른다 — "맨유", "레알", "챔스"로 말한다. 해석을 도구
// 입구에 두면 모델이 id를 외우거나 추측하지 않아도 되고, 못 찾았을 때 후보를
// 돌려줄 수 있다 (조용히 빈 결과를 주면 모델이 지어내기 시작한다).

/** 부분 일치로 닿지 않는 약칭만 둔다 ("맨유"는 "맨체스터 유나이티드"의 부분 문자열이 아니다) */
const TEAM_ALIASES: Record<string, string> = {
  맨유: "manutd",
  맨시티: "mancity",
  스퍼스: "tottenham",
  아스널: "arsenal",
  레알: "realmadrid",
  바르샤: "barcelona",
  앳마: "atletico",
  뮌헨: "bayern",
  바이언: "bayern",
  유베: "juventus",
  파리: "psg",
};

/** 우리 팀을 가리키는 말 */
const MINE = new Set(["mine", "우리", "우리팀", "our", "us"]);
/** 팀을 좁히지 말라는 말 — 대회 전체 일정 */
const EVERY_TEAM = new Set(["all", "전체", "리그", "리그전체", "모두", "everyone"]);

type Resolved = { ok: true; teamId: string } | { ok: false; message: string };

function resolveTeam(state: GameState, team?: string): Resolved {
  const q = (team ?? "").trim();
  const key = norm(q);
  if (key === "" || MINE.has(key)) return { ok: true, teamId: state.userTeamId };

  const alias = TEAM_ALIASES[key];
  if (alias) return { ok: true, teamId: alias };
  const exact = teamCatalog().find(
    (t) => t.id === key || norm(t.shortName) === key || norm(t.name) === key,
  );
  if (exact) return { ok: true, teamId: exact.id };

  const partial = teamCatalog().filter((t) => norm(t.name).includes(key) || t.id.includes(key));
  if (partial.length === 1) return { ok: true, teamId: partial[0]!.id };
  if (partial.length > 1) {
    const names = partial
      .slice(0, 6)
      .map((t) => `${t.name}(${t.id})`)
      .join(" / ");
    return { ok: false, message: `"${q}"는 여러 팀과 맞습니다 — ${names}` };
  }
  return { ok: false, message: `"${q}"라는 팀을 찾지 못했습니다` };
}

/** 이름 뒤의 완장 — 서열은 조회가 아니라 `get_squad`의 리더 줄이 말한다 */
function armband(p: GamePlayer): string {
  return p.isCaptain ? " (주장)" : p.isViceCaptain === true ? " (부주장)" : "";
}

/**
 * 우리 팀 선수 한 줄 — 정확 수치 (오피스 뷰가 이미 보여주는 정보).
 *
 * **임대 보낸 선수도 여기 선다** — 계약이 우리 것이라 지식 눈금이 `own`이다
 * (transfer.md §2). 다만 두 칸의 뜻이 갈린다:
 * - 역할 칸은 우리 배치가 아니라 **어디에 가 있는가**다. 임대 중에는 우리 전술판에
 *   그 선수의 자리가 없으므로(`assignmentFor`는 송출과 함께 지워졌다) `[1군]`으로
 *   서면 부릴 수 있는 인원으로 읽힌다.
 * - **전술 적응도는 빼고 그 구단의 연속 미출전을 적는다.** 우리 전술을 얼마나
 *   익혔는가는 남의 훈련장에 가 있는 동안 재는 값이 아니고, 그 자리에서 감독이
 *   알아야 하는 사실은 "뛰고 있는가"다 (`no-minutes`의 근거 수치).
 *
 * 시즌 기록(`statLine`)은 `seasonStatOf`가 **지금 소속의 행**을 읽으므로 빌린
 * 구단의 기록이 그대로 선다 — 갈아 끼울 것이 없다.
 */
function ourRow(state: GameState, p: GamePlayer): string {
  const loan = onLoanFromUs(state, p) ? loanReportOf(state, p.id) : null;
  const assignment = assignmentFor(state, p.id);
  const contract = activeContract(state, p.id);
  const stat = seasonStatOf(state, p.id);
  const injury = openInjury(state, p.id);
  const suspension = activeSuspension(state, p.id);
  const role = loan
    ? `[임대:${teamShortNameIn(state, loan.teamId)} ~${loan.until}]`
    : squadLevelOf(p) === "reserve"
      ? (state.developmentFocus?.includes(p.id) ?? false)
        ? "[2군·집중 육성]"
        : "[2군]"
      : assignment
        ? `[${assignment.role === "starting" ? "선발" : "벤치"}:${assignment.position}]`
        : "[1군]";
  const adaptation = loan ? "" : `적응${familiarityOf(state, p.id)} `;
  const benched = loan && loan.benchRun > 0 ? ` · 최근 ${loan.benchRun}경기 명단 밖` : "";
  const status = injury
    ? ` 부상(${injury.bodyPart}, ~${injury.expectedReturn})`
    : suspension
      ? ` 정지(${suspension.lengthMatches - suspension.served}경기)`
      : "";
  // 무엇에 대한 불만인지까지 낸다 — 사유가 여덟이라 "불만" 한 마디로는 할 일이 안 보인다
  const grievance = state.issues.find((i) => i.gamePlayerId === p.id);
  const reason = grievance ? issueReasonText(grievance) : null;
  // 사유 없는 옛 불만은 사유 없이 낸다
  const issue = grievance ? (reason ? ` ⚠불만(${reason})` : " ⚠불만") : "";
  /**
   * **등번호는 이 줄에 선다** — 화면의 명단 행은 이미 번호를 세우는데 GM 조회 줄에만
   * 없어서, 모델이 번호를 물으면 있지도 않은 번호를 지어냈다 (player.md §1.1).
   */
  const number = p.squadNumber === undefined ? "" : `${p.squadNumber}번 `;
  return (
    `${p.id} ${number}${p.name} ${ageOf(p.birthdate, state.date)}세 ${naturalPositionOf(p).position} ` +
    `${physiqueLabel(p.height, p.weight)}(${footLabel(p.foot)}) ` +
    `OVR${p.attributes.overall} 폼 ${formLabel(p.state.form)} ` +
    `체력${p.state.condition} ${adaptation}` +
    `${formatMoney(contract?.weeklyWage ?? 0)}${contractLabel(contract)} ` +
    `${role} ${statLine(stat)}${benched}${status}${issue}${armband(p)}` +
    // 홈그로운은 **우리 협회** 기준이다 — 임대 나간 선수를 빌린 구단 기준으로 재면
    // 같은 선수의 자격이 나가 있는 동안만 뒤집힌다 (searchPlayers의 필터와 같은 자)
    `${isHomegrownFor(p, state.userTeamId) ? " [홈그로운]" : ""}${occupiesSquadList(state, p) ? "" : " [U21·명단 밖]"}`
  );
}

/** 시즌 기록 축약 — 출전/득점/도움, 평점은 출전이 있을 때만. 2군 리그 기록은 따로 */
function statLine(
  stat: {
    apps: number;
    goals: number;
    assists?: number;
    ratingSum?: number;
    reserveApps?: number;
    reserveGoals?: number;
  } | null,
): string {
  const rating = seasonRating(stat);
  const reserve =
    (stat?.reserveApps ?? 0) > 0
      ? ` · 2군 출전${stat?.reserveApps}/득점${stat?.reserveGoals ?? 0}`
      : "";
  return (
    `출전${stat?.apps ?? 0}/득점${stat?.goals ?? 0}/도움${stat?.assists ?? 0}` +
    (rating === null ? "" : `/평점${rating.toFixed(2)}`) +
    reserve
  );
}

/**
 * 계약 만료 꼬리 — ` ~YYYY-MM-DD`, 계약이 없으면 빈 문자열. **안개를 걸지 않는다**:
 * 계약 만료일은 부상·징계·이적과 같은 공개 기록 계열이다 (player.md §10).
 */
function contractLabel(contract: Contract | null): string {
  // 주급 바로 뒤에 서므로 사이를 띄운다 — 붙이면 `£150k~2028-06-30`이 금액 구간으로 읽힌다
  return contract ? ` ~${contract.until}` : "";
}

/**
 * 타 팀 선수 한 줄 — 능력치는 안개, **값과 계약은 시장의 공개 정보**다.
 * 시장가는 `deal_odds`가 부르는 것과 같은 흐린 값이고, 계약 만료일은 흐리지 않는다.
 *
 * 등번호는 싣지 않는다 — 셔츠에 적힌 공개 사실이지만 이 줄이 답하는 물음은 값·계약·
 * 기량이고, 남의 구단 번호로 감독이 할 일은 없다. 우리 번호를 GM이 지어내던 것이
 * 이 이슈이지 남의 번호를 알려 주는 것이 아니다.
 */
function theirRow(state: GameState, p: GamePlayer): string {
  const stat = seasonStatOf(state, p.id);
  const knowledge = knowledgeOf(state, p.id);
  const source = knowledge === "scouted" ? "스카우팅" : knowledge === "seen" ? "직접 관전" : "평판";
  const injury = openInjury(state, p.id);
  const contract = activeContract(state, p.id);
  return (
    `${p.id} ${p.name} ${ageOf(p.birthdate, state.date)}세 ${naturalPositionOf(p).position} ` +
    `${teamShortNameIn(state, p.teamId)} · ${overallView(state, p)} (${source}) · ` +
    `값 ${formatMoney(observedMarketValue(state, p))} · ` +
    `계약 ${contract ? contract.until : "없음(자유계약)"} · ` +
    `${statLine(stat)}${injury ? ` · 부상 중(~${injury.expectedReturn})` : ""}`
  );
}

/** 우리 행인가 남의 행인가 — **소속이 아니라 계약이 가른다** (transfer.md §2) */
function playerRow(state: GameState, p: GamePlayer): string {
  return isOurPlayer(state, p) ? ourRow(state, p) : theirRow(state, p);
}

/**
 * **줄 세우는 값도 노출이다** (player.md §10) — 행이 라벨만 보여도 참값으로 세운
 * 순서는 그 값을 그대로 말한다. 정렬 키는 그 행이 찍는 관측값과 같아야 한다.
 */
function sortRating(state: GameState, p: GamePlayer): number {
  return observedOverall(p.attributes.overall, observationOf(state, p.id));
}

/**
 * 체력은 지식 5단계가 아니라 §9.2의 채널 — 경기 밖 **우리 선수**는 참값이고 타 팀은
 * 읽은 값이다. 임대 나간 선수도 우리 계약이라 참값이다(`ourRow`가 찍는 값과 같은 자다).
 */
function sortCondition(state: GameState, p: GamePlayer): number {
  return isOurPlayer(state, p)
    ? p.state.condition
    : readCondition(state, p.id, p.state.condition).value;
}

/**
 * 활성 계약 색인 — **원장을 한 번만 훑는다.** `activeContract`는 선수 하나에 원장
 * 전체를 훑으므로 5,700명에 그대로 부르면 그 선형 탐색이 5,700번 돈다. `find`가
 * 첫 줄을 고르므로 색인도 **먼저 만난 줄을 남긴다** — 같은 선수에 줄이 둘이어도
 * 고르는 값이 달라지지 않는다.
 */
function contractIndexOf(state: GameState): Map<string, Contract> {
  const index = new Map<string, Contract>();
  for (const c of state.contracts) {
    if (c.status !== "active") continue;
    if (!index.has(c.gamePlayerId)) index.set(c.gamePlayerId, c);
  }
  return index;
}

/**
 * 계약 잔여 일수 — **계약이 없으면 0일이다.** 자유계약 선수는 "이미 끝난 계약"이라
 * 잔여가 가장 짧은 쪽이고, 거르는 자와 세우는 자가 같은 규칙을 읽는다.
 */
function daysLeftOn(state: GameState, contract: Contract | undefined): number {
  return contract ? Math.max(0, diffDays(state.date, contract.until)) : 0;
}

/**
 * 풀 하나의 정렬 키 — **선수당 한 번만** 뽑는다.
 *
 * 원장에서 읽는 키(득점·출전·주급·계약)는 원장을 한 번 훑어 색인으로 세우고,
 * 안개에서 파생하는 키(평점·체력·값·잠재력)는 지식 수준을 다시 세지 않도록
 * 풀당 한 번 뽑아 둔다.
 */
function sortKeyOf(
  state: GameState,
  pool: readonly GamePlayer[],
  sortBy: NonNullable<SearchPlayersInput["sortBy"]>,
): (p: GamePlayer) => number {
  if (sortBy === "age") return () => 0;
  if (sortBy === "rating" || sortBy === "fatigue" || sortBy === "value" || sortBy === "potential") {
    // 안개 키는 지식 수준 파생이라 비싸다 — 풀당 한 번만 뽑고 비교는 그 값으로 한다
    const fogged = new Map(pool.map((p) => [p.id, foggedKeyOf(state, p, sortBy)] as const));
    return (p) => fogged.get(p.id) ?? 0;
  }
  if (sortBy === "wage" || sortBy === "contract") {
    const contracts = contractIndexOf(state);
    return sortBy === "wage"
      ? (p) => contracts.get(p.id)?.weeklyWage ?? 0
      : (p) => daysLeftOn(state, contracts.get(p.id));
  }
  // 스탯은 시즌·팀까지 같아야 그 선수의 줄이다 — 시즌 중 이적하면 팀별로 갈린다
  const stat = new Map<string, SeasonStat>();
  for (const s of state.seasonStats) {
    if (s.season !== state.season) continue;
    const k = `${s.gamePlayerId}\u0000${s.teamId}`;
    if (!stat.has(k)) stat.set(k, s);
  }
  const of = (p: GamePlayer) => stat.get(`${p.id}\u0000${p.teamId}`);
  switch (sortBy) {
    case "goals":
      return (p) => of(p)?.goals ?? 0;
    case "assists":
      return (p) => of(p)?.assists ?? 0;
    // 출전이 없으면 평점이 없다 — 0으로 두어 뛴 선수 뒤에 선다
    case "seasonRating":
      return (p) => seasonRating(of(p)) ?? 0;
    default:
      return (p) => of(p)?.apps ?? 0;
  }
}

/** 안개에서 파생하는 정렬 키 — 넷 다 그 행이 찍는 값과 같은 관측값이다 */
function foggedKeyOf(
  state: GameState,
  p: GamePlayer,
  sortBy: "rating" | "fatigue" | "value" | "potential",
): number {
  switch (sortBy) {
    case "rating":
      return sortRating(state, p);
    case "fatigue":
      return sortCondition(state, p);
    case "value":
      return observedMarketValue(state, p);
    // 구간이 없으면 성장 여력을 짐작할 근거가 없다 — 0으로 두어 맨 뒤에 선다
    default:
      return potentialBand(state, p)?.low ?? 0;
  }
}

// ── 검색 ────────────────────────────────────────────────

export interface SearchPlayersInput {
  /** "mine" | 팀 id | 팀 이름 — 생략하면 competition(그것도 없으면 1·2부 전 클럽) */
  team?: string;
  /**
   * 대회로 좁히기 — 리그면 소속 팀, 대항전이면 참가 팀.
   * 없으면 풀이 **5대 리그 1·2부 전체**라 "우리 리그 최고 스트라이커"의 답이 조용히 어긋난다.
   */
  competition?: string;
  /** 포지션 코드 (주 포지션 또는 소화 가능 포지션) */
  position?: string;
  /** 이름·id 부분 일치 */
  name?: string;
  minAge?: number;
  maxAge?: number;
  /** 1군·2군 — 우리 팀에서 유망주만 보기 */
  squadLevel?: "first" | "reserve";
  /** 부상·정지 제외 */
  availableOnly?: boolean;
  /**
   * 계약이 이 일수 안에 끝나는 선수 — "1년 남은 선수를 싸게"(transfer.md §6)의 축.
   * 무계약(자유계약)은 잔여 0일이라 언제나 걸린다.
   */
  contractEndsWithinDays?: number;
  /** 관측 시장가 상한 (£) — 참값이 아니라 흐린 값으로 거른다 (player.md §10) */
  maxValue?: number;
  /** 주급 상한 (£/주) — 계약서의 값 그대로, 흐리지 않는다 */
  maxWage?: number;
  /** 이적 리스트 등재 여부 — 리스트는 우리가 세운 것뿐이다 (AI 구단은 세우지 않는다) */
  listed?: boolean;
  /** 우리 협회 기준 홈그로운 — 등록 명단 8명 규칙(team.md §5)의 그 자격 */
  homegrown?: boolean;
  /** 관측 잠재력 구간의 **하한**이 이 값 이상. 구간이 없는 선수는 통과하지 못한다 */
  minPotential?: number;
  /** 최소 지식 수준 — `"scouted"`면 스카우팅을 마쳤거나 그보다 잘 아는 선수만 */
  knowledge?: Knowledge;
  /** 주발 — 행이 찍는 그 세 갈래 (`footLabel`과 같은 자) */
  foot?: StrongFoot;
  sortBy?:
    | "rating"
    | "age"
    | "fatigue"
    | "goals"
    | "apps"
    | "wage"
    | "value"
    | "contract"
    | "assists"
    | "seasonRating"
    | "potential";
  limit?: number;
}

export function searchPlayers(state: GameState, input: SearchPlayersInput): LookupResult {
  let teamId: string | null = null;
  if (input.team) {
    const team = resolveTeam(state, input.team);
    if (!team.ok) return team;
    teamId = team.teamId;
  }

  const competition = resolveCompetition(input.competition);
  if (!competition.ok) return competition;
  const competitionId = competition.competitionId;
  // 대회·자리·나이는 스카우트 임무와 **같은 자로** 거른다 (world/player-pool.ts)
  const poolFilter: PlayerPool = playerPoolOf(state, {
    competitionId,
    ...(input.position === undefined ? {} : { position: input.position }),
    ...(input.minAge === undefined ? {} : { minAge: input.minAge }),
    ...(input.maxAge === undefined ? {} : { maxAge: input.maxAge }),
  });

  // 원장·목록을 읽는 조건은 색인을 한 번 세워 둔다 — 선수마다 훑으면 5,700번이다
  const contracts =
    input.contractEndsWithinDays !== undefined || input.maxWage !== undefined
      ? contractIndexOf(state)
      : null;
  const listed =
    input.listed === undefined ? null : new Set(state.transferList.map((l) => l.gamePlayerId));

  /**
   * **싼 조건이 앞에 선다.** 안개에서 파생하는 셋(지식 수준·잠재력 구간·관측
   * 시장가)은 선수마다 기록을 훑으므로, 앞의 조건이 좁혀 준 만큼만 계산한다.
   */
  /**
   * 우리 팀을 물으면 풀은 **우리 계약**이다 — 임대 보낸 선수도 들어온다
   * (transfer.md §2). 남의 팀 풀은 그대로 소속(`playersOf`)이다: 그 구단이 빌려 간
   * 우리 선수는 그 구단 명단에 **실제로 있으므로** 거기서 빠지면 안 된다.
   */
  const ourPool = teamId !== null && teamId === state.userTeamId;
  const pool0 = teamId ? (ourPool ? ourPlayers(state) : playersOf(state, teamId)) : state.players;
  const narrowed = pool0.filter((p) => {
    if (!inPlayerPool(state, p, poolFilter)) return false;
    /**
     * 1군·2군은 **우리 명단의 층**을 묻는 조건이다. 임대 나간 선수가 달고 있는 층은
     * 빌린 구단의 것이라 우리 기준으로는 뜻이 없어, 우리 풀을 층으로 좁힐 때는 빠진다.
     * 남의 팀을 그 조건으로 물으면 답은 그 구단의 층이라 그대로 선다.
     */
    if (input.squadLevel) {
      if (ourPool && onLoanFromUs(state, p)) return false;
      if (squadLevelOf(p) !== input.squadLevel) return false;
    }
    if (input.foot !== undefined && strongFootOf(p.foot) !== input.foot) return false;
    // 홈그로운은 **우리 협회** 기준이다 — 지금 소속이 아니라 우리가 등록할 때의 자격
    if (input.homegrown !== undefined && isHomegrownFor(p, state.userTeamId) !== input.homegrown) {
      return false;
    }
    if (listed && listed.has(p.id) !== input.listed) return false;
    if (input.availableOnly && !isAvailable(state, p)) return false;
    if (contracts) {
      const contract = contracts.get(p.id);
      if (
        input.contractEndsWithinDays !== undefined &&
        daysLeftOn(state, contract) > input.contractEndsWithinDays
      ) {
        return false;
      }
      if (input.maxWage !== undefined && (contract?.weeklyWage ?? 0) > input.maxWage) return false;
    }
    if (
      input.knowledge !== undefined &&
      KNOWLEDGE_RANK[knowledgeOf(state, p.id)] < KNOWLEDGE_RANK[input.knowledge]
    ) {
      return false;
    }
    if (input.minPotential !== undefined) {
      // 짐작할 근거가 없는 선수를 통과시키면 모르는 것을 "넘는다"고 답하게 된다
      const band = potentialBand(state, p);
      if (band === null || band.low < input.minPotential) return false;
    }
    if (input.maxValue !== undefined && observedMarketValue(state, p) > input.maxValue)
      return false;
    return true;
  });
  // 이름은 마지막에 — 다른 조건으로 좁힌 만큼만 자모까지 내려가면 된다
  const pool = input.name ? rankByName(input.name, narrowed).matches : narrowed;

  const sortBy = input.sortBy ?? "rating";
  /**
   * **정렬 키는 비교자가 아니라 풀에서 뽑는다.**
   *
   * 비교자 안의 `seasonStatOf`·`activeContract`는 한 번이 원장 전체 훑기라,
   * 5,700명을 세우면 그 선형 탐색이 n·log n번 돈다(주급 정렬 실측 2.7초).
   * 키를 선수당 한 번만 뽑아 두면 비교는 숫자 대 숫자가 된다 — 순서는 그대로다.
   */
  const key = sortKeyOf(state, pool, sortBy);
  const sorted = [...pool].sort((a, b) => {
    switch (sortBy) {
      case "age":
        return ageOf(a.birthdate, state.date) - ageOf(b.birthdate, state.date);
      case "fatigue":
      case "contract":
        // 지친 순·계약이 먼저 끝나는 순 — 낮은 쪽이 앞
        return key(a) - key(b);
      default:
        return key(b) - key(a);
    }
  });

  // 무엇을 뒤졌는지 밝힌다 — 풀을 모르면 "리그 득점왕"이라는 답이 조용히 어긋난다
  // 무엇을 뒤졌는지에는 **임대까지 포함했다는 사실**도 든다 — 우리 팀을 물었는데
  // 남의 셔츠를 입은 이름이 서는 이유가 대상 줄에 없으면 그 줄이 곧 오독이 된다
  const loanedInPool = ourPool && !input.squadLevel ? loanedOut(state).length : 0;
  const scope =
    [
      teamId
        ? `${teamNameIn(state, teamId)}${loanedInPool > 0 ? ` (임대 ${loanedInPool}명 포함)` : ""}`
        : null,
      competitionId ? competitionName(competitionId) : null,
      input.squadLevel ? (input.squadLevel === "first" ? "1군" : "2군") : null,
    ]
      .filter((x): x is string => x !== null)
      .join(" · ") || "5대 리그 1·2부 전체 — 한 대회로 좁히려면 competition을 주라";

  if (sorted.length === 0) {
    return { ok: true, message: `[검색 결과] 대상: ${scope}\n조건에 맞는 선수가 없습니다` };
  }
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const shown = sorted.slice(0, limit);
  const head = `[검색 결과] 대상: ${scope} — ${sorted.length}명 중 ${shown.length}명 (정렬: ${sortBy})`;
  const tail =
    sorted.length > shown.length
      ? `\n…그 외 ${sorted.length - shown.length}명 — 조건을 좁히거나 limit을 올려라`
      : "";
  return { ok: true, message: [head, ...shown.map((p) => playerRow(state, p))].join("\n") + tail };
}

// ── 선수 상세 ───────────────────────────────────────────

/**
 * 그 날짜의 성장을 낸 훈련 결산의 **근거 한 줄** — 없으면 null.
 *
 * 카드는 구간(`from`~`to`)을 갖고 성장 로그는 그 구간 안의 훈련 날짜를 가리키므로,
 * 그 날짜를 품은 카드에서 이 선수의 줄을 찾는다. 링에서 밀려난 옛 구간의 근거는
 * 없다 — 그때는 눈금만 남는다 (docs/simulation/season.md §4).
 */
function trainingNoteFor(state: GameState, playerId: string, date: string): string | null {
  for (const report of state.trainingReports ?? []) {
    if (date < report.from || date > report.to) continue;
    const note = report.marks.find((m) => m.gamePlayerId === playerId)?.note;
    if (note !== undefined && note.length > 0) return note;
  }
  return null;
}

const CAUSE_KO: Record<string, string> = { match: "경기", training: "훈련", other: "기타" };
const TRANSFER_KO: Record<string, string> = {
  transfer: "이적",
  loan: "임대",
  free: "자유계약",
  youth: "유스 승격",
  retire: "은퇴",
};

/**
 * 카드에 세울 **시즌 행·팀 행의 상한.**
 *
 * 스무 시즌을 뛴 선수의 행을 전부 쏟으면 카드가 벽이 되는데, 모델이 판단에 쓰는
 * 것은 최근 몇 해다 — 계약이 보통 3~5년이라 다섯이면 "지금 이 선수가 어떤
 * 선수인가"를 가르는 구간이 통째로 들어온다. 잘린 앞쪽은 **통산 합이 말한다**:
 * 합은 전 시즌의 것이라, 적힌 행을 더해 통산이 안 나오면 그 차이가 곧 "더
 * 있다"는 뜻이다.
 */
const CAREER_ROWS_SHOWN = 5;

/**
 * 마일스톤 상한 — 문턱(50·100경기)은 드물지만 해트트릭은 시즌마다 쌓인다.
 * 고르기는 최근 것부터, 적기는 **오래된 것부터**다 (부상·이동 이력과 같은 결이고,
 * 한 경기가 여럿을 세웠을 때의 드문 순서도 장부에 적힌 그대로 남는다).
 */
const MILESTONES_SHOWN = 4;

/** 커리어 한 묶음의 수치 — 위 「시즌 기록」과 같은 낱말이라 여러 줄이 한 자로 읽힌다 */
function careerStatText(t: CareerTotals): string {
  return (
    `${t.apps}경기 ${t.goals}골 ${t.assists}도움` +
    (t.rating === null ? "" : ` · 평점 ${t.rating.toFixed(2)}`) +
    (t.reserveApps > 0 ? ` (2군 ${t.reserveApps}경기 ${t.reserveGoals}골)` : "")
  );
}

/**
 * 통산 · 팀별 · 시즌별 · 마일스톤 — 전부 `careerOf` **하나에서** 나온다
 * (player.md §10). 화면의 스쿼드 상세가 읽는 표와 같은 함수라, 감독이 채팅에서
 * 듣는 "우리 팀에서 132경기"와 상세의 행이 갈리지 않는다.
 *
 * **기록은 안개 밖이다** — 흐리는 것은 능력치이지 장부가 아니라 타 팀 선수도
 * 참값 그대로 낸다. 다만 원장은 게임 시작 뒤만 알아 **부임 전 커리어는 없다**:
 * 없는 것은 지어내지 않고 줄을 세우지 않는다.
 *
 * 마일스톤은 **감독 팀 선수의 장부**다 (game-state.md §3.4) — 남의 팀 선수에게는
 * 줄이 서지 않는 것이 정상이고, 그것이 "기록이 없다"는 뜻은 아니다.
 */
function careerLines(state: GameState, p: GamePlayer): string[] {
  const lines: string[] = [];
  const career = careerOf(state, p.id);
  // 출전이 0인 행은 세우지 않는다 — 빈 자리를 만들어 두면 카드가 길어지기만 한다
  const played = (t: CareerTotals) => t.apps > 0 || t.reserveApps > 0;
  const seasons = career.seasons.filter(played);
  /**
   * 이번 시즌 이 팀 한 행뿐이면 위의 「시즌 기록」이 이미 같은 값을 말했다 —
   * 같은 수를 두 낱말로 두 번 적으면 모델은 그것을 다른 사실 둘로 읽는다.
   */
  const only = seasons.length === 1 ? seasons[0]! : null;
  const onlyCurrent = only !== null && only.season === state.season && only.teamId === p.teamId;
  if (played(career.totals) && !onlyCurrent) {
    lines.push(`통산: ${careerStatText(career.totals)}`);
    // 팀이 하나면 통산이 곧 그 셔츠의 기록이라, 같은 줄을 한 번 더 적는 셈이다
    const teams = career.teams.filter(played);
    if (teams.length > 1) {
      lines.push(
        `팀별: ${teams
          .slice(-CAREER_ROWS_SHOWN)
          .map((t) => `${teamShortNameIn(state, t.teamId)}(${t.from}~${t.to}) ${careerStatText(t)}`)
          .join(" / ")}`,
      );
    }
    // 시즌 안에 팀을 옮겼으면 행도 팀별로 갈린다 — 합치면 어느 셔츠로 몇 경기를 뛰었는지가 사라진다
    if (seasons.length > 1) {
      lines.push(
        `시즌별: ${seasons
          .slice(-CAREER_ROWS_SHOWN)
          .map((s) => `${s.season} ${teamShortNameIn(state, s.teamId)} ${careerStatText(s)}`)
          .join(" / ")}`,
      );
    }
  }
  /** 클럽 단위의 사실이라 어느 셔츠로 세웠는지를 함께 적는다 (match.md §6) */
  const milestones = (state.milestones ?? [])
    .filter((m) => m.gamePlayerId === p.id)
    .slice(-MILESTONES_SHOWN)
    .map((m) => `${m.date} ${teamShortNameIn(state, m.teamId)} ${milestoneTitle(m.code, m.value)}`);
  if (milestones.length > 0) lines.push(`마일스톤: ${milestones.join(" / ")}`);
  return lines;
}

/**
 * 선수의 **이력** — 부상·징계·이동. 현재 상태만 보여주면 "유리몸인가",
 * "경고 몇 장이야(5장이면 자동 정지)" 같은 판단을 감독이 할 수 없다.
 * 부상·징계·이적은 공개 기록이라 타 팀 선수에게도 안개를 걸지 않는다.
 */
function historyLines(state: GameState, p: GamePlayer): string[] {
  const lines: string[] = [];

  const injuries = state.injuries.filter((i) => i.gamePlayerId === p.id);
  if (injuries.length > 0) {
    const daysOut = injuries.reduce(
      (sum, i) => sum + Math.max(0, diffDays(i.occurredOn, i.returnedOn ?? i.expectedReturn)),
      0,
    );
    const recent = injuries
      .slice(-3)
      .map(
        (i) =>
          `${i.occurredOn} ${i.bodyPart}(${INJURY_SEVERITY_KO[i.severity]}·${CAUSE_KO[i.cause] ?? i.cause})` +
          (i.returnedOn ? ` ~${i.returnedOn}` : " 복귀 전"),
      );
    lines.push(
      `부상 이력: 총 ${injuries.length}회 · 누적 결장 ${daysOut}일 — ${recent.join(" / ")}`,
    );
  }

  const bookings = state.bookings.filter(
    (b) => b.gamePlayerId === p.id && b.season === state.season,
  );
  const yellows = bookings.filter((b) => b.card === "yellow").length;
  const reds = bookings.filter((b) => b.card === "red").length;
  if (yellows > 0 || reds > 0) {
    const toBan = YELLOWS_PER_SUSPENSION - (yellows % YELLOWS_PER_SUSPENSION);
    lines.push(
      `징계 이력 (이번 시즌): 경고 ${yellows}장 · 퇴장 ${reds}회` +
        (yellows > 0 ? ` — 경고 ${toBan}장 더 받으면 출장 정지` : ""),
    );
  }

  const moves = state.transfers
    .filter((t) => t.gamePlayerId === p.id)
    .slice(-3)
    .map(
      (t) =>
        `${t.date} ${TRANSFER_KO[t.type] ?? t.type} ` +
        `${t.fromTeamId ? teamShortNameIn(state, t.fromTeamId) : "—"}→${t.toTeamId ? teamShortNameIn(state, t.toTeamId) : "—"}` +
        (t.fee > 0 ? ` ${formatMoney(t.fee)}` : ""),
    );
  if (moves.length > 0) lines.push(`이동 이력: ${moves.join(" / ")}`);

  return lines;
}

/**
 * GM이 읽는 심경 한 줄 — 결산이 다시 쓴 문장이 있으면 그것, 없으면 **사실 줄**.
 * 코어가 GM에게 넘기는 것은 사실뿐이다 (overview.md §1 철칙 4).
 */
function moodLine(state: GameState, player: GamePlayer): string {
  const mood = moodOf(state, player);
  return mood.note ?? moodAnchor(mood.facts);
}

/**
 * 시즌 표에 딸리는 **비전 조각** — 이름과 달성률뿐이다 (career.md §5).
 *
 * 시즌 행은 짧아야 한다: `visionItemText`를 그대로 붙이면 목표와 가중치까지 따라와
 * 열다섯 시즌짜리 커리어가 통째로 부푼다. 목표와 가중치는 재임 머리글의 비전 줄과
 * 커리어 화면이 이미 갖고 있다. **이 조각을 만드는 자리는 여기 하나다.**
 */
function visionRates(items: readonly VisionReading[]): string {
  return items.map((i) => `${VISION_CODE_KO[i.code]} ${Math.round(i.progress * 100)}%`).join("·");
}

/**
 * 그 시즌의 보드 평가 — 등급과 근거 수치. 옛 세이브는 평가 문장을 들고 있어
 * 그것이 폴백이다 (career.md §6).
 *
 * ⚠️ **기대는 코드가 원본이고 라벨은 옛 세이브의 폴백이다** (§6) — 코드를 두고
 * `expectation`만 읽으면 새 세이브에서는 `undefined`가 문장에 찍힌다.
 */
function boardLine(record: SeasonRecord): string {
  const board = record.board;
  if (board) {
    const met = board.grade === "met";
    // 순위는 바로 앞 `{target}위`가 이미 말한다 — 라벨에까지 달면 "6위(…6위 이내)"다
    const label = board.expectationCode
      ? boardExpectationText(board.expectationCode)
      : board.expectation;
    // 항목별 진행도 — 평판 폭을 만든 가중합이 무엇으로 이뤄졌는지가 여기 남는다 (§5)
    const rates = visionRates(board.items ?? []);
    return (
      ` — 보드 기대 ${board.target}위${label ? `(${label})` : ""} · ${met ? "달성" : "미달"}` +
      (rates ? ` · 비전 ${rates}` : "")
    );
  }
  return record.boardVerdict ? ` — 보드: "${record.boardVerdict}"` : "";
}

/** 그 자리에서 맡고 있는 세부 역할의 한글 이름 (미지정이면 기본 역할) */
function roleLabel(position: string, roleId?: string): string {
  const defs = rolesFor(position);
  return (defs.find((r) => r.id === roleId) ?? defs[0])?.ko ?? "기본";
}

/** 되물을 후보 줄 — 이름과 id를 함께 준다 (모델이 다음 호출에 쓸 것은 id다) */
const candidateLine = (players: readonly GamePlayer[]): string =>
  players
    .slice(0, CANDIDATES_SHOWN)
    .map((p) => `${p.name}(${p.id})`)
    .join(" / ");

const CANDIDATES_SHOWN = 6;

/**
 * 국적 한 칸 — 코드와 표기를 함께 낸다. 코드만 실으면 모델이 `KVX`를 읽고 말을
 * 지어내고, 표기만 실으면 규정을 논하는 자리에서 무엇으로 걸러야 할지가 사라진다.
 * 조사가 닿지 않은 선수는 없다고 적는다 — 지어내지 않는다.
 */
function nationalityText(p: Pick<GamePlayer, "nationality" | "secondNationality">): string {
  if (p.nationality === undefined) return "국적 정보 없음";
  const one = (code: string): string => `${associationName(code)}(${code})`;
  return `국적 ${one(p.nationality)}${p.secondNationality === undefined ? "" : ` · 둘째 국적 ${one(p.secondNationality)}`}`;
}

/** 그 소집이 선 창 — 키가 시즌을 들고 있어 날짜는 거기서 파생한다 */
function breakOfKey(breakKey: string): InternationalBreak | null {
  const season = Number(breakKey.split(":")[0]);
  if (!Number.isFinite(season)) return null;
  return internationalBreaksOf(season).find((w) => w.key === breakKey) ?? null;
}

/**
 * 정산이 끝난 가장 최근 소집 — 소집 표는 감독 팀 행만 남기므로 남의 선수에게는
 * 늘 없다 (competition.md §5-1). 행은 창 순서로 쌓이므로 뒤에서 찾는다.
 */
function lastReturnedCallUp(state: GameState, playerId: string): CallUp | null {
  const rows = (state.callUps ?? []).filter(
    (c) => c.gamePlayerId === playerId && c.returnedOn !== null,
  );
  return rows[rows.length - 1] ?? null;
}

/**
 * **통산 A매치 한 줄** (competition.md §5-1) — 통산 커리어와 같은 결로 선다.
 *
 * 캡이 0이면 줄을 세우지 않는다: 세계의 대다수가 그렇고, 카드의 규약이 「0인 칸은
 * 적지 않는다」다. 어느 협회인지는 머리글의 국적 줄이 이미 말하므로 두 번 적지
 * 않는다. 최근 소집이 남긴 출전·골은 어느 창의 것인지와 함께 조각으로 붙는다 —
 * 창 이름이 없으면 모델이 그 수를 통산 옆의 다른 통산으로 읽는다.
 *
 * **안개 밖의 사실이다** — 흐리는 것은 능력치이지 공개된 기록이 아니라 남의 팀
 * 선수도 통산 그대로 낸다 (`careerLines`와 같은 기준).
 */
function internationalLine(state: GameState, p: GamePlayer): string | null {
  const caps = capsOf(p.state);
  if (caps === 0) return null;
  const goals = internationalGoalsOf(p.state);
  const last = lastReturnedCallUp(state, p.id);
  const window = last === null ? null : breakOfKey(last.breakKey);
  // 첫 소집이어도 그 창에서 못 뛰었으면 데뷔가 아니다 — `debut`은 소집 시점의 캡이 0이었다는 표식이다
  const debut = last !== null && last.debut === true && last.apps > 0;
  return (
    `A매치: 통산 ${caps}경기${goals > 0 ? ` ${goals}골` : ""}` +
    (last !== null && window !== null
      ? ` · ${window.label} ${last.apps}경기${last.goals > 0 ? ` ${last.goals}골` : ""}${debut ? " (대표팀 데뷔)" : ""}`
      : "")
  );
}

/**
 * **지금 클럽을 떠나 있다** — 부상·정지와 같은 갈래의 사실이라 같은 자리에 선다
 * (competition.md §5-1 · season.md §8 불변식). 소집이든 여름 대회든 감독이 이번
 * 주에 그를 쓸 수 없다는 뜻은 하나다.
 */
function awayFromClubLine(state: GameState, p: GamePlayer): string | null {
  const callUp = openCallUp(state, p.id);
  if (callUp !== null) {
    const window = breakOfKey(callUp.breakKey);
    return (
      `대표팀 소집 중: ${associationName(callUp.country)}(${callUp.country})` +
      (window === null ? "" : ` — ${window.to} 복귀 (${daysUntilReturn(state, window)}일 남음)`)
    );
  }
  const summer = p.state.summerReturn;
  if (summer !== undefined && state.date < summer) {
    return `여름 대회 참가 중: ${summer} 합류 예정`;
  }
  return null;
}

export function playerCard(state: GameState, playerId: string): LookupResult {
  // id가 정확하지 않으면 이름으로 푼다 — 모델은 감독이 부른 이름을 그대로 넣는다
  const { player: p, candidates } = resolvePlayerRef(state.players, playerId);
  if (!p) {
    return {
      ok: false,
      message:
        candidates.length > 0
          ? `"${playerId}"는 여러 선수와 맞습니다 — ${candidateLine(candidates)}`
          : `"${playerId}"라는 선수를 찾지 못했습니다 — search_players로 id를 먼저 확인하라`,
    };
  }
  const knowledge: Knowledge = knowledgeOf(state, p.id);
  const stat = seasonStatOf(state, p.id);
  const contract = activeContract(state, p.id);
  const injury = openInjury(state, p.id);
  const suspension = activeSuspension(state, p.id);
  const lines: string[] = [
    `[선수 카드] ${p.name} — ${teamNameIn(state, p.teamId)} · ${ageOf(p.birthdate, state.date)}세 · ` +
      `${nationalityText(p)} · 주포지션 ${naturalPositionOf(p).position} (${groupOf(p)}) · id ${p.id}`,
    knowledgeNote(state, p.id),
    `능력치: ${attributeLine(state, p)}`,
    `종합: ${overallView(state, p)} · 잠재력: ${potentialView(state, p)}`,
  ];

  if (knowledge === "own") {
    const risk = injuryRiskFor(p);
    lines.push(
      `컨디션: 폼 ${formLabel(p.state.form)} · 체력 ${p.state.condition} (${conditionLabel(p.state.condition)})` +
        ` · 경기 감각 ${sharpnessLabel(sharpnessOf(p.state))}` +
        // 성향 배수는 싣지 않는다 — 감독이 읽을 눈금이 없는 수다 (player.md §10)
        ` · 부상 위험 ${injuryRiskText(risk.grade, risk.causes)}`,
      `심경: ${moodLine(state, p)}`,
      `소화 포지션: ${p.positions
        .map((x) => `${x.position}${x.isNatural ? "*" : ""}${x.proficiency}`)
        .join(" / ")}`,
    );
    const assignment = assignmentFor(state, p.id);
    /**
     * **임대 나간 선수에게 "배치 없음 (예비 스쿼드)"는 거짓이다** — 우리 전술판에
     * 자리가 없는 것이 아니라 남의 훈련장에 가 있다. 그 사실이 전술 칸을 대신하고,
     * 아래 리포트 한 줄이 그 구단에서 무슨 일이 있었는지를 잇는다 (transfer.md §2).
     */
    const loan = onLoanFromUs(state, p) ? loanReportOf(state, p.id) : null;
    lines.push(
      loan
        ? `전술: 임대 중 — ${teamNameIn(state, loan.teamId)} · ${loan.until} 복귀`
        : assignment
          ? `전술: ${assignment.role === "starting" ? "선발" : "벤치"} ${assignment.position}` +
            ` (${roleLabel(assignment.position, assignment.roleId)})` +
            ` · 전술적응 ${assignment.familiarity}` +
            (assignment.instruction ? ` · 개인지시 "${assignment.instruction}"` : "")
          : "전술: 배치 없음 (예비 스쿼드)",
    );
    if (loan) {
      /**
       * 임대 리포트 — **사실만.** `no-minutes`·`injury`는 리콜을 고민할 근거 코드이고
       * (`LoanConcern`), 여기 적히는 것은 그 코드가 뜻하는 수치다. 부상은 카드가
       * 이미 제 줄로 세우므로 여기서 두 번 적지 않는다.
       */
      const report = [
        `${teamShortNameIn(state, loan.teamId)} 출전${loan.apps}/득점${loan.goals}/도움${loan.assists}` +
          (loan.rating === null ? "" : `/평점${loan.rating.toFixed(2)}`),
        loan.reserveApps > 0 ? `2군 출전${loan.reserveApps}` : null,
        loan.benchRun > 0 ? `최근 ${loan.benchRun}경기 명단 밖` : null,
        `임대 이후 성장 +${loan.growth}`,
      ].filter((x): x is string => x !== null);
      lines.push(`임대 리포트: ${report.join(" · ")}`);
    }
    /**
     * 최근 성장 — **대상은 낱말로 싣는다.** `pos:CB`는 장부의 코드지 표기가
     * 아닌데, 그대로 실으면 모델이 그 코드를 그대로 감독에게 옮긴다.
     * 훈련 결산이 올린 줄에는 그 판정의 **근거 한 줄**이 함께 선다 — 근거가
     * 닿는 조회 자리는 여기 하나다 (docs/simulation/season.md §4).
     */
    const growth = state.growthLog
      .filter((g) => g.gamePlayerId === p.id)
      .slice(-5)
      .map((g) => {
        const head = `${g.date} ${growthLabel(g.target)} ${g.delta > 0 ? "+" : ""}${g.delta}`;
        const why =
          g.origin === "training-settlement" ? trainingNoteFor(state, p.id, g.date) : null;
        return why ? `${head} (${why})` : head;
      });
    if (growth.length > 0) lines.push(`최근 성장: ${growth.join(" / ")}`);
  } else {
    const { strengths, weaknesses } = strengthsAndWeaknesses(state, p);
    lines.push(`인상: 강점 ${strengths.join("·")} / 약점 ${weaknesses.join("·")}`);
  }

  /**
   * 계약 줄이 **장부를 함께 든다** — 지위와 열린 약속 (people.md §5-2).
   *
   * 지위는 우리 계약의 칸이라 남의 선수에게는 적지 않는다 — 안개 밖에서 지어낸
   * 사실이 된다. 약속도 마찬가지로 우리가 한 말만 장부에 선다.
   * ⚠️ 문장이 아니라 사실이다: 갈래와 기한, 그뿐이다.
   */
  const ledger =
    knowledge === "own"
      ? [
          `${SQUAD_STATUS_KO[squadStatusOf(state, p)]} 지위`,
          ...openPromises(state, p.id).map(
            (promise) => `${PROMISE_KIND_KO[promise.kind]} 약속 ${promise.dueOn}까지`,
          ),
        ]
      : [];
  /**
   * 등번호와 그 번호의 **계보** — 지위·약속과 같은 결의 장부 줄이다 (player.md §1.1).
   *
   * ⚠️ 문장이 아니라 사실이다: 지금 번호와, 앞서 그것을 달던 사람·시즌 수·몇 시즌
   * 만인가뿐이다. 계보는 시즌 기록에서 파생하므로 우리 선수 카드에서만 세운다 —
   * 남의 구단 번호의 계보는 감독이 조사한 적 없는 사실이다.
   */
  if (knowledge === "own" && p.squadNumber !== undefined) {
    const past = numberLineageOf(state, p.teamId, p.squadNumber).past;
    lines.push(
      `등번호: ${p.squadNumber}번` +
        (past.length === 0
          ? ""
          : ` — 앞서 ${past
              .map((entry, i) =>
                i === 0
                  ? `${entry.name} ${entry.seasons}시즌 · ${state.season - entry.lastSeason}시즌 만에`
                  : `${entry.name} ${entry.seasons}시즌`,
              )
              .join(" / ")}`),
    );
  }
  /**
   * 시즌 기록의 나머지 — **0인 칸은 적지 않는다** (match.md §6). 스트라이커의 카드에
   * "선방 0"이, 골키퍼의 카드에 "슛 0"이 서면 모델이 그 0을 사실로 옮겨 적는다.
   */
  const seasonMore = [
    stat?.minutes ? `${stat.minutes}분` : null,
    stat?.shots ? `슛 ${stat.shots}` : null,
    stat?.xg ? `xG ${stat.xg.toFixed(2)}` : null,
    stat?.saves ? `선방 ${stat.saves}` : null,
    stat?.cleanSheets ? `클린시트 ${stat.cleanSheets}` : null,
    stat?.yellows ? `경고 ${stat.yellows}` : null,
    stat?.reds ? `퇴장 ${stat.reds}` : null,
  ].filter((x): x is string => x !== null);
  const international = internationalLine(state, p);
  lines.push(
    `시즌 기록: ${stat?.apps ?? 0}경기 ${stat?.goals ?? 0}골 ${stat?.assists ?? 0}도움` +
      (seasonRating(stat) === null ? "" : ` · 평점 ${seasonRating(stat)!.toFixed(2)}`) +
      (seasonMore.length > 0 ? ` · ${seasonMore.join(" · ")}` : ""),
    ...careerLines(state, p),
    ...(international === null ? [] : [international]),
    [
      contract
        ? `계약: 주급 ${formatMoney(contract.weeklyWage)} · 만료 ${contract.until}`
        : "계약: 정보 없음",
      ...ledger,
    ].join(" · "),
  );
  /**
   * 오퍼 앞에 서 있는 관심 — 구단과 사다리의 칸뿐이다 (transfer.md §1-2).
   *
   * ⚠️ **안개를 견주지 않고 그대로 싣는다.** 장부에 관심 줄이 서는 선수는 둘뿐이라
   * (우리 선수와 우리가 협상을 열어 둔 남의 선수 — `tickInterests`) 어느 쪽이든
   * 감독이 알 자격이 있는 사실이다. 관심이 그 밖으로 번지는 날 가장 먼저 새는
   * 자리가 여기다 — 그때는 `knowledge`로 걸러야 한다.
   */
  const interest = interestLine(state, p.id);
  if (interest !== null) lines.push(`관심: ${interest}`);
  if (injury) {
    lines.push(
      `부상: ${injury.bodyPart} (${INJURY_SEVERITY_KO[injury.severity]}) — 복귀 예상 ${injury.expectedReturn}`,
    );
  }
  if (suspension) {
    lines.push(`징계: 출장 정지 ${suspension.lengthMatches - suspension.served}경기 남음`);
  }
  const away = awayFromClubLine(state, p);
  if (away !== null) lines.push(away);
  lines.push(...historyLines(state, p));
  return { ok: true, message: lines.join("\n") };
}

// ── 스쿼드·배치 (우리 팀 전용) ──────────────────────────

export interface SquadViewInput {
  /**
   * 1군 / 2군 / 임대 / 전체 — 기본 1군 (2군 18명까지 매번 읽을 이유가 없다).
   *
   * `loaned`는 우리가 **임대 보낸** 선수들이다. 계약이 우리 것이라 명단에 서지만
   * (transfer.md §2) 전술 배치의 대상이 아니라 층이 아니라 제 구획을 갖는다.
   */
  level?: "first" | "reserve" | "all" | "loaned";
  /** 배치 역할로 좁히기 — starting(선발 11) / bench / unassigned(예비) */
  role?: "starting" | "bench" | "unassigned";
}

/**
 * 배치 순서는 **전술판 좌표**에서 나온다 — 골문 쪽 라인부터, 라인 안에서는 왼쪽부터
 * (포지션 코드를 알파벳순으로 세우면 LB·LCB·RB·RCB로 뒤엉켜 라인업으로 읽히지 않는다).
 * y를 12 단위로 뭉쳐 같은 라인으로 묶고 그 안에서 x로 세운다.
 */
function boardOrder(state: GameState, playerId: string, position: string): [number, number] {
  const point = assignmentFor(state, playerId)?.point ?? anchorOf(position);
  return [-Math.round(point.y / 12), point.x];
}

/**
 * 배치 한 줄 — 그 **자리에서의** 적합도와 포지션 적응도를 함께 준다.
 * 자리를 바꿀지 판단하려면 "라이스가 좋은 선수인가"가 아니라 "이 자리에서
 * 좋은가"를 알아야 한다 (roleFit은 자리마다 다른 값을 낸다).
 */
function assignedRow(
  state: GameState,
  p: GamePlayer,
  position: string,
  familiarity: number,
  roleId?: string,
): string {
  const yellows = state.bookings.filter(
    (b) => b.gamePlayerId === p.id && b.season === state.season && b.card === "yellow",
  ).length;
  const injury = openInjury(state, p.id);
  const suspension = activeSuspension(state, p.id);
  const stat = seasonStatOf(state, p.id);
  const contract = activeContract(state, p.id);
  const grievance = state.issues.find((i) => i.gamePlayerId === p.id);
  const reason = grievance ? issueReasonText(grievance) : null;
  const flags = [
    injury ? `부상(${injury.bodyPart}, ~${injury.expectedReturn})` : null,
    suspension ? `정지 ${suspension.lengthMatches - suspension.served}경기` : null,
    yellows >= YELLOWS_PER_SUSPENSION - 1 ? `경고 ${yellows}장(정지 임박)` : null,
    // 사유 없는 옛 불만은 사유 없이 낸다
    grievance ? (reason ? `불만(${reason})` : "불만") : null,
    /**
     * **다치기 전에 서는 유일한 줄이다** (player.md §5.3) — 부상 플래그는 이미
     * 쓰러진 뒤의 사실이라, 이 줄이 없으면 라인업을 세우는 자리에서 감독이
     * 위험을 읽을 자리가 없다. `elevated`는 싣지 않는다: 스쿼드의 15%가 그 등급이라
     * 스물몇 줄이 통째로 ⚠를 달면 진짜 경고가 묻힌다.
     */
    injuryRiskFor(p).grade === "high" ? "부상 위험 높음" : null,
  ].filter((x): x is string => x !== null);
  return (
    `  ${position.padEnd(4)} ${p.name}${armband(p)} (${p.id}) ${ageOf(p.birthdate, state.date)}세 · ` +
    `${roleLabel(position, roleId)} · OVR${p.attributes.overall} 자리적합${roleFit(p.attributes, position, roleId)} 포지션적응${proficiencyAt(p, position)} ` +
    `전술적응${familiarity} · 폼 ${formLabel(p.state.form)} 체력${p.state.condition} 감각 ${sharpnessLabel(sharpnessOf(p.state))}` +
    // **라인업을 세우는 자리가 재계약을 판단하는 자리이기도 하다** (finance.md §8.3) —
    // 만료일이 없으면 감독은 여름에 사라질 주전을 붙박이로 세운다
    (contract ? ` · 계약${contractLabel(contract)}` : "") +
    ` · ${statLine(stat)}` +
    (flags.length > 0 ? ` · ⚠${flags.join(" · ")}` : "")
  );
}

/**
 * 우리 스쿼드와 **현재 배치** — 라인업을 바꾸기 전에 지금 누가 어디에 서 있는지.
 *
 * 왜 별도 도구인가: 컨텍스트엔 선수단 이름뿐이라 배치가 없고 `search_players`는 상한이
 * 15명이라 43명 스쿼드의 선발 11·벤치 9를 한눈에 볼 방법이 없었다. 모르는 것을
 * 지어내지 않게 하려면 "현재 라인업"을 정확히 읽을 자리가 필요하다.
 *
 * 타 팀 스쿼드는 여기서 볼 수 없다 — 상대 라인업을 미리 아는 것은 안개 위반이다
 * (상대 전력은 `get_team`의 스카우팅 리포트로).
 */
/**
 * 임대 한 줄 — **그 구단의 장부다.** 우리 전술판의 자리·적응도가 없는 대신 어디에
 * 가 있고 언제 돌아오며 거기서 뛰고 있는지가 선다. 리콜의 근거는 코드가 아니라
 * **그 코드가 뜻하는 사실**로 적는다: "불러들이는 편이 좋겠습니다"는 GM의 몫이다
 * (overview.md §1 철칙 4).
 */
function loanRow(state: GameState, p: GamePlayer, report: LoanReport): string {
  const injury = report.injury;
  const facts = [
    `${teamShortNameIn(state, report.teamId)} · ~${report.until} 복귀`,
    `OVR${p.attributes.overall}`,
    statLine(seasonStatOf(state, p.id)),
    report.benchRun > 0 ? `최근 ${report.benchRun}경기 명단 밖` : null,
    report.growth > 0 ? `임대 이후 성장 +${report.growth}` : null,
    injury ? `⚠부상(${injury.bodyPart}, ~${injury.expectedReturn})` : null,
  ].filter((x): x is string => x !== null);
  return (
    `  ${naturalPositionOf(p).position.padEnd(4)} ${p.name} (${p.id}) ` +
    `${ageOf(p.birthdate, state.date)}세 · ${facts.join(" · ")}`
  );
}

export function squadView(state: GameState, input: SquadViewInput = {}): LookupResult {
  const teamId = state.userTeamId;
  const tactics = tacticsOf(state, teamId);
  const squad = playersOf(state, teamId);
  // 임대 나간 선수는 전술 배치의 대상이 아니라 위 배치 버킷과 섞지 않는다
  const loaned = loanedOut(state);
  const level = input.level ?? "first";
  const assignments = new Map(tactics.assignments.map((a) => [a.playerId, a]));

  const inLevel =
    level === "loaned"
      ? []
      : squad.filter((p) =>
          level === "all" ? true : squadLevelOf(p) === (level === "reserve" ? "reserve" : "first"),
        );
  const bucketOf = (p: GamePlayer): "starting" | "bench" | "unassigned" =>
    assignments.get(p.id)?.role ?? "unassigned";
  const sortRow = (a: GamePlayer, b: GamePlayer) => {
    const [lineA, xA] = boardOrder(
      state,
      a.id,
      assignments.get(a.id)?.position ?? naturalPositionOf(a).position,
    );
    const [lineB, xB] = boardOrder(
      state,
      b.id,
      assignments.get(b.id)?.position ?? naturalPositionOf(b).position,
    );
    return lineA !== lineB ? lineA - lineB : xA - xB;
  };
  const rowsFor = (bucket: "starting" | "bench" | "unassigned") =>
    inLevel
      .filter((p) => bucketOf(p) === bucket)
      .sort(sortRow)
      .map((p) => {
        const a = assignments.get(p.id);
        return assignedRow(
          state,
          p,
          a?.position ?? naturalPositionOf(p).position,
          a?.familiarity ?? familiarityOf(state, p.id),
          a?.roleId,
        );
      });

  const spec = tactics.spec;
  const firstCount = squad.filter((p) => squadLevelOf(p) !== "reserve").length;
  const lines = [
    `[스쿼드] ${teamNameIn(state, teamId)} — ${spec.formation} · 멘탈${spec.mentality} 라인${spec.defensiveLine} ` +
      `압박${spec.pressing} 템포${spec.tempo} 폭${spec.width} 패스${spec.passStyle} · ` +
      `선발 평균 적응 ${familiarityLabel(squadFamiliarity(state, teamId))}`,
    `1군 ${firstCount}명 (선발 ${tactics.assignments.filter((a) => a.role === "starting").length} · ` +
      `벤치 ${tactics.assignments.filter((a) => a.role === "bench").length}) · ` +
      `2군 ${squad.length - firstCount}명 · 임대 ${loaned.length}명 · 조회 대상: ${
        level === "all" ? "전체" : level === "reserve" ? "2군" : level === "loaned" ? "임대" : "1군"
      }`,
    // 등록 명단 — 영입·승격 판단의 전제라 스쿼드를 볼 때 항상 함께 읽힌다
    registrationLine(squadRegistrationOf(state, teamId)),
    /**
     * 라커룸 서열 — **화면과 같은 파생을 읽는다** (people.md §5-1). 완장이 어디
     * 있는지와 누가 그 옆에 서는지가 팀토크의 폭과 불만의 속도를 정하므로,
     * 스쿼드를 볼 때 함께 읽혀야 하는 줄이다.
     */
    `라커룸 서열: ${
      leaderGroupOf(state, teamId)
        .map(
          (row) =>
            `${playerName(state, row.playerId)}${
              row.role === "group" ? "" : `(${LEADER_ROLE_LABEL[row.role]})`
            } 리더십${row.leadership}`,
        )
        .join(" · ") || "없음"
    }`,
  ];

  const buckets: ReadonlyArray<["starting" | "bench" | "unassigned", string]> = [
    ["starting", "선발"],
    ["bench", "벤치"],
    ["unassigned", "예비 (배치 없음 — 라인업에 넣으려면 set_lineup)"],
  ];
  let shown = 0;
  for (const [bucket, label] of buckets) {
    if (input.role && input.role !== bucket) continue;
    const rows = rowsFor(bucket);
    if (rows.length === 0) continue;
    shown += rows.length;
    lines.push(`── ${label} ${rows.length}명 ──`, ...rows);
  }
  /**
   * 임대는 **자기 구획**이다 — 선발·벤치·예비는 전술판의 칸이고, 임대는 그 판에
   * 올릴 수 없는 사람들이라 같은 목록에 섞으면 부릴 수 있는 인원으로 읽힌다.
   * `role`로 좁힌 조회는 배치를 묻는 것이라 임대가 서지 않는다.
   */
  if ((level === "all" || level === "loaned") && !input.role && loaned.length > 0) {
    const rows = loaned
      .map((p) => ({ p, report: loanReportOf(state, p.id) }))
      .filter((x): x is { p: GamePlayer; report: LoanReport } => x.report !== null)
      .sort((a, b) => a.p.id.localeCompare(b.p.id))
      .map(({ p, report }) => loanRow(state, p, report));
    shown += rows.length;
    lines.push(`── 임대 ${rows.length}명 ──`, ...rows);
  }
  if (shown === 0) {
    lines.push("조건에 맞는 선수가 없습니다 (level·role을 확인하라)");
  }
  /**
   * **유스 후보도 자기 구획이다** — 아직 계약하지 않아 층도 배치도 없는 사람들이라
   * 명단에 섞으면 부릴 수 있는 인원으로 읽힌다 (season.md §6). 소집일이 지나면
   * 후보 줄 자체가 사라지므로 이 구획도 여름에만 선다.
   */
  const candidates = teamId === state.userTeamId ? ourYouthCandidates(state) : [];
  if (candidates.length > 0 && !input.role) {
    lines.push(
      `── 유스 후보 ${candidates.length}명 (${youthIntakeDeadline(state)}까지 sign_youth) ──`,
      ...candidates.map((row) => youthCandidateRow(state, row)),
    );
  }
  const personal = tactics.assignments.filter((a) => a.instruction);
  if (personal.length > 0 && !input.role) {
    lines.push(
      `개인 지시: ${personal
        .map((a) => `${playerName(state, a.playerId)} "${a.instruction}"`)
        .join(" / ")}`,
    );
  }
  return { ok: true, message: lines.join("\n") };
}

/**
 * 유스 후보 한 줄 — **안개가 낀 사실이다** (season.md §6 · player.md §9). 아직 우리
 * 선수가 아니라 종합도 잠재력도 참값이 아니고, GM 스냅샷의 오프시즌 블록·스쿼드 화면과
 * 같은 함수(`youthCandidateFog`)를 읽어 같은 숫자를 낸다.
 */
function youthCandidateRow(state: GameState, row: YouthCandidate): string {
  const { overall, potential } = youthCandidateFog(state.seed, row.player);
  const age = ageOf(row.player.birthdate, state.date);
  return (
    `${row.player.name} (${naturalPositionOf(row.player).position}) ${age}세 · ` +
    `종합 ~${overall} · 잠재력 ${potential.low}~${potential.high} ${potential.confidence} · ` +
    `주급 ${formatMoney(row.weeklyWage)}/주 ${row.years}년` +
    (row.autoSign ? " · 답이 없으면 구단이 계약" : "")
  );
}

// ── 팀 프로필 (상대 스카우팅 리포트) ───────────────────

export function teamProfile(state: GameState, team: string): LookupResult {
  const resolved = resolveTeam(state, team);
  if (!resolved.ok) return resolved;
  const teamId = resolved.teamId;
  // 무소속은 클럽이 아니다 — 순위도 배치도 없어 프로필이 성립하지 않는다 (team.md §4)
  if (!isClubTeam(teamId)) {
    return {
      ok: false,
      message: "무소속은 구단이 아닙니다 — 자유계약 선수는 선수 검색으로 봅니다",
    };
  }

  // 순위는 **그 팀의 리그** 기준 — 타 리그 팀에 우리 리그 표를 대면 순위가 없다
  const standings = computeStandings(state, leagueOfTeamIn(state, teamId));
  const row = standings.find((r) => r.teamId === teamId);
  const rank = standings.findIndex((r) => r.teamId === teamId) + 1;
  const squad = playersOf(state, teamId);
  const tactics = tacticsOf(state, teamId);
  const avgAge =
    squad.length > 0
      ? squad.reduce((s, p) => s + ageOf(p.birthdate, state.date), 0) / squad.length
      : 0;

  // 날짜순 정렬 — state.matches는 리그 뒤에 대항전이 붙은 순서라 그대로 자르면 섞인다.
  // 2군 경기는 팀 프로필의 최근 결과·전적·다음 맞대결 어디에도 서지 않는다
  const byDate = [...state.matches]
    .filter((m) => !isReserveMatch(m))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const recent = byDate
    .filter((m) => m.result && (m.homeTeamId === teamId || m.awayTeamId === teamId))
    .slice(-5)
    .map((m) => {
      const home = m.homeTeamId === teamId;
      const my = home ? m.result!.homeGoals : m.result!.awayGoals;
      const their = home ? m.result!.awayGoals : m.result!.homeGoals;
      return (
        `${competitionTag(m)} ${my}-${their} vs ${teamShortNameIn(state, home ? m.awayTeamId : m.homeTeamId)} ` +
        outcomeLabel(outcomeFor(m, teamId))
      );
    });

  // 우리와의 상대 전적
  const h2h = byDate.filter(
    (m) =>
      m.result &&
      ((m.homeTeamId === teamId && m.awayTeamId === state.userTeamId) ||
        (m.awayTeamId === teamId && m.homeTeamId === state.userTeamId)),
  );
  const nextH2h = byDate.find(
    (m) =>
      !m.result &&
      m.date >= state.date &&
      ((m.homeTeamId === teamId && m.awayTeamId === state.userTeamId) ||
        (m.awayTeamId === teamId && m.homeTeamId === state.userTeamId)),
  );
  let w = 0;
  let d = 0;
  let l = 0;
  for (const m of h2h) {
    const outcome = outcomeFor(m, state.userTeamId);
    if (outcome === "W") w++;
    else if (outcome === "L") l++;
    else d++;
  }

  const keyPlayers = tactics.assignments
    .filter((a) => a.role === "starting")
    .map((a) => playerById(state, a.playerId))
    .filter((p): p is GamePlayer => p !== null)
    .sort((a, b) => sortRating(state, b) - sortRating(state, a))
    .slice(0, 6);

  const managerName = state.teams.find((t) => t.id === teamId)?.managerName;
  const honours = clubHonoursLine(state, teamId);

  const lines = [
    `[팀 프로필] ${teamNameIn(state, teamId)} — ${competitionName(leagueOfTeamIn(state, teamId))} ` +
      (row && row.played > 0
        ? `${rank || "?"}위 (${row.played}경기 ${row.wins}승 ${row.draws}무 ${row.losses}패 · 승점 ${row.points} · 득실 ${row.goalDiff >= 0 ? "+" : ""}${row.goalDiff})`
        : "순위 미정 (아직 경기 없음)"),
    `전술: ${tactics.spec.formation} · 멘탈리티${tactics.spec.mentality} 압박${tactics.spec.pressing} 템포${tactics.spec.tempo} 패스${tactics.spec.passStyle}`,
    // 상대 벤치에 서는 사람 — 이름이 여기 나와야 캐릭터북이 그 인물지를 세운다
    // (people.md §2-1). 이름을 모르는 구단은 줄이 서지 않는다
    ...(managerName !== undefined ? [`감독: ${managerName}`] : []),
    `스쿼드: ${squad.length}명 · 평균 ${avgAge.toFixed(1)}세 · 구단 등급 ${tierOfTeamIn(state, teamId)}`,
    /**
     * **역대 한 줄** (team.md §1) — 카탈로그 시드와 게임 안의 우승을 더한 것이다.
     * 시드가 없고 게임 안의 우승도 없으면 줄이 서지 않는다: 없는 것은 0회가 아니라
     * 모르는 것이라 `null`이 온다.
     */
    ...(honours === null ? [] : [`역대: ${honours}`]),
    recent.length > 0 ? `최근 5경기: ${recent.join(" / ")}` : "최근 경기 없음",
  ];
  if (teamId !== state.userTeamId) {
    /**
     * **더비면 그 사실이 전적보다 먼저 선다** (team.md §3.2). 바로 아래의 맞대결
     * 전적과 수가 다른 것은 이쪽이 친선·2군을 세지 않기 때문이다 — 더비는 대회
     * 경기의 것이다.
     */
    const derby = derbyOf(state.userTeamId, teamId);
    if (derby) {
      const record = derbyRecordOf(state, teamId);
      lines.push(
        `더비: ${derby.name} — ${DERBY_HEAT_KO[derby.heat] ?? ""} · ` +
          `더비 전적 ${record.won}승 ${record.drawn}무 ${record.lost}패`,
      );
    }
    lines.push(
      `우리와의 전적 (이번 시즌): ${w}승 ${d}무 ${l}패` +
        (h2h.length > 0
          ? ` — ${h2h
              .slice(-3)
              .map((m) => `${competitionTag(m)} ${m.result!.homeGoals}-${m.result!.awayGoals}`)
              .join(" / ")}`
          : ""),
    );
    lines.push(
      nextH2h
        ? `다음 맞대결: ${competitionTag(nextH2h)} ${dateLabel(nextH2h.date)}${nextH2h.time ? ` ${nextH2h.time}` : ""} ` +
            `${nextH2h.neutral ? "중립" : nextH2h.homeTeamId === state.userTeamId ? "홈" : "원정"}`
        : "다음 맞대결: 남은 일정에 없음",
    );
    lines.push(
      `주력 선수 (안개 적용 — 정확한 수치는 스카우트 파견 후):`,
      ...keyPlayers.map((p) => `  ${theirRow(state, p)}`),
    );
  } else {
    lines.push(`주력 선수:`, ...keyPlayers.map((p) => `  ${ourRow(state, p)}`));
  }
  return { ok: true, message: lines.join("\n") };
}

// ── 리그 (순위·일정) ────────────────────────────────────

export interface LeagueViewInput {
  view: "standings" | "fixtures";
  /**
   * 기준 팀 — 생략하면 우리 팀. "all"이면 대회 전체 경기를 본다.
   * standings에서는 그 팀이 속한 리그의 순위표를 뜻한다.
   */
  team?: string;
  /** fixtures 전용 — 상대 팀. 주면 그 팀과의 맞대결만 (전적 요약 포함) */
  opponent?: string;
  /** 대회 이름·약어·id — 생략하면 모든 대회 (team이 "all"이면 우리 리그) */
  competition?: string;
  /**
   * 지나간 시즌 — 생략하면 지금 시즌이다. 순위표는 그 시즌의 **최종 표**를, 일정은
   * 결산 스냅샷에 남은 **감독 팀의 경기**를 낸다 (game-state.md §3.3: 지난 시즌은
   * 경기가 아니라 표로 남고, 경기는 감독 팀의 것만 남는다).
   */
  season?: number;
  /** 지난 경기만 / 예정만 / 둘 다 (기본 both) */
  when?: "past" | "upcoming" | "both";
  /** 날짜 범위 (YYYY-MM-DD, 포함) */
  from?: string;
  to?: string;
  /** 라운드 (리그는 R번호, 녹아웃은 차수) */
  round?: number;
  /** 방향별 최대 경기 수 (기본 5, 맞대결·대회 전체는 10) */
  count?: number;
}

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

function dateLabel(date: string): string {
  return `${date}(${WEEKDAY[dayOfWeek(date)]})`;
}

/**
 * "2026-27 시즌 (시즌 1)" — 날짜를 묻는 답에 시즌 번호만 주면 연도를 지어내게 된다.
 * 연도 표기는 `seasonLabelOf`가 갖는다 (역대 표와 같은 눈금).
 */
function seasonLabel(season: number): string {
  return `${seasonLabelOf(season)} 시즌 (시즌 ${season})`;
}

/** 대회·단계 태그 — "EPL R7", "UCL 8강 1차전", "친선" */
function competitionTag(m: MatchRecord): string {
  return competitionLabel(m.competitionId, m.stage ?? "league", m.round);
}

/** 기준 팀 시점의 승패 — 정규시간이 같으면 승부차기로 갈린다 */
function scorerNote(state: GameState, m: MatchRecord): string {
  const scorers = m.result?.scorers ?? [];
  if (scorers.length === 0) return "";
  const minutes = m.result?.goalMinutes ?? [];
  const named = scorers.map((entry, i) => {
    const goal = parseScorerEntry(entry);
    const team = goal.side === "home" ? m.homeTeamId : goal.side === "away" ? m.awayTeamId : null;
    const at = minutes[i] !== undefined ? ` ${minutes[i]}′` : "";
    return `${playerName(state, goal.playerId)}${at}${team ? `(${teamShortNameIn(state, team)})` : ""}`;
  });
  return ` · 득점 ${named.join(", ")}`;
}

/**
 * 슛·xG 한 마디 — **스코어만 남으면 진 경기가 다 같아 보인다** (match.md §8).
 * 슛 3·xG 0.4로 진 경기와 슛 18·xG 2.3으로 진 경기가 달력에서 같은 "1-2 패"였다.
 * 옛 경기에는 없는 칸이라 없으면 생략한다.
 */
function shotNote(m: MatchRecord): string {
  const r = m.result;
  if (!r) return "";
  const parts = [
    r.homeShots === undefined || r.awayShots === undefined
      ? null
      : `슛 ${r.homeShots}-${r.awayShots}`,
    r.homeXg === undefined || r.awayXg === undefined
      ? null
      : `xG ${r.homeXg.toFixed(2)}-${r.awayXg.toFixed(2)}`,
  ].filter((x): x is string => x !== null);
  return parts.length === 0 ? "" : ` · ${parts.join(" · ")}`;
}

/**
 * 경기 한 줄. `teamId`가 있으면 그 팀 시점(홈/원정·승패), null이면 중립 서술.
 * `detail`이면 슛·xG와 득점자까지 — 결과를 묻는 질문엔 스코어만으론 부족하다.
 */
function matchLine(
  state: GameState,
  m: MatchRecord,
  teamId: string | null,
  detail: boolean,
): string {
  const when = `${dateLabel(m.date)}${m.time ? ` ${m.time}` : ""}`;
  const tag = competitionTag(m);
  if (!m.result) {
    const side =
      teamId === null ? "" : m.neutral ? "중립 " : m.homeTeamId === teamId ? "홈 " : "원정 ";
    const versus =
      teamId === null
        ? `${teamNameIn(state, m.homeTeamId)} vs ${teamNameIn(state, m.awayTeamId)}`
        : `vs ${teamNameIn(state, m.homeTeamId === teamId ? m.awayTeamId : m.homeTeamId)}`;
    return `  예정 ${when} ${tag} ${side}${versus}`;
  }
  const pens = m.result.penalties
    ? ` (승부차기 ${m.result.penalties.home}-${m.result.penalties.away})`
    : "";
  const score =
    `${teamShortNameIn(state, m.homeTeamId)} ${m.result.homeGoals}-${m.result.awayGoals} ` +
    `${teamShortNameIn(state, m.awayTeamId)}${pens}`;
  const side = teamId === null ? "" : ` ${m.homeTeamId === teamId ? "홈" : "원정"}`;
  const mark = teamId === null ? "" : ` ${outcomeLabel(outcomeFor(m, teamId))}`;
  return (
    `  지난 ${when} ${tag}${side} ${score}${mark}` +
    `${detail ? `${shotNote(m)}${scorerNote(state, m)}` : ""}`
  );
}

/**
 * 최근 5경기 폼 — 오래된 것부터 "승승무패승". 순위표에 붙여 `get_team`을 20번
 * 부르지 않아도 흐름을 읽게 한다 (승점만 보면 무너지는 팀과 오르는 팀이 같다).
 */
function recentForm(state: GameState, teamId: string, competitionId: string): string {
  return state.matches
    .filter(
      (m) =>
        m.result &&
        m.competitionId === competitionId &&
        (m.homeTeamId === teamId || m.awayTeamId === teamId),
    )
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-5)
    .map((m) => outcomeLabel(outcomeFor(m, teamId)))
    .join("");
}

/**
 * 국내 컵 대진표 — 순위표를 대신한다.
 * 아직 안 열린 라운드는 없는 것이고, 우리 대진은 화살표로 표시한다.
 */
function cupBracketView(state: GameState, cupId: string): LookupResult {
  const lines: string[] = [];
  for (const stage of DOMESTIC_STAGES) {
    const matches = domesticStageMatches(state, cupId, stage);
    if (matches.length === 0) continue;
    lines.push(`· ${domesticStageLabel(cupId, stage)}`);
    for (const m of matches) {
      const ours = m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId;
      const pens = m.result?.penalties;
      const score = m.result
        ? `${m.result.homeGoals}-${m.result.awayGoals}${pens ? ` (승부차기 ${pens.home}-${pens.away})` : ""}`
        : "예정";
      lines.push(
        `  ${m.date} ${teamShortNameIn(state, m.homeTeamId)} ${score} ${teamShortNameIn(state, m.awayTeamId)}` +
          `${ours ? " ←우리" : ""}`,
      );
    }
  }
  if (lines.length === 0) {
    return { ok: true, message: `${competitionName(cupId)}는 아직 추첨 전입니다` };
  }
  return {
    ok: true,
    message: [
      `[${competitionName(cupId)} 대진] ${seasonLabel(state.season)} · ${state.date}`,
      ...lines,
    ].join("\n"),
  };
}

/** 그 시즌 그 팀이 뛴 리그 — 결산 스냅샷의 표가 답한다. 모르면 null */
function leagueOfTeamInSeason(state: GameState, season: number, teamId: string): string | null {
  const snapshot = seasonHistoryOf(state, season);
  return snapshot?.leagues.find((l) => l.rows.some((r) => r.teamId === teamId))?.leagueId ?? null;
}

/**
 * 지나간 시즌의 순위표 한 행 — **이관된 행은 순위와 이름만 안다** (game-state.md §3.3).
 * 없는 수를 0으로 세우면 그 시즌이 그 구단의 최저 승점으로 읽힌다.
 */
function historyTableRow(
  state: GameState,
  row: SeasonTableRow,
  rank: number,
  mineTeamId?: string,
): string {
  const mark = row.teamId === mineTeamId ? " ←우리" : "";
  const head = `${String(rank).padStart(2)} ${teamNameIn(state, row.teamId)}`;
  const r = row.record;
  if (!r) return `${head}${mark}`;
  const diff = r.goalsFor - r.goalsAgainst;
  return (
    `${head} ${r.played}경기 ${r.wins}승 ${r.draws}무 ${r.losses}패 ` +
    `${r.points}점 (${diff >= 0 ? "+" : ""}${diff})${mark}`
  );
}

/** 그 시즌 그 대회의 트로피 — 표가 없는 녹아웃 대회는 이 원장이 답한다 (§3.3) */
function trophyOf(state: GameState, season: number, competitionId: string): Trophy | null {
  return (
    state.trophies.find((t) => t.season === season && t.competitionId === competitionId) ?? null
  );
}

/** 우승 팀과 준우승 팀 — 준우승은 그 우승이 누구를 꺾은 것인가라는 사실이다 */
function championText(state: GameState, trophy: Trophy): string {
  return (
    teamNameIn(state, trophy.teamId) +
    (trophy.runnerUpTeamId ? ` (준우승 ${teamNameIn(state, trophy.runnerUpTeamId)})` : "")
  );
}

/**
 * 지나간 시즌 그 대회의 결과 — 리그면 최종 순위표, 녹아웃이면 우승·준우승 한 줄.
 * **둘 다 없으면 없다고 말한다**: 장부에 남는 것은 표와 감독 팀의 경기뿐이다.
 */
function pastCompetitionView(
  state: GameState,
  season: number,
  competitionId: string,
): LookupResult {
  const head = `[역대] ${seasonLabel(season)} · ${competitionName(competitionId)}`;
  const table = leagueTableOf(state, season, competitionId);
  if (table) {
    const mine = seasonHistoryOf(state, season)?.teamId;
    return {
      ok: true,
      message: [
        `${head} 최종 순위`,
        ...table.map((row, i) => historyTableRow(state, row, i + 1, mine)),
      ].join("\n"),
    };
  }
  const trophy = trophyOf(state, season, competitionId);
  if (trophy) {
    return { ok: true, message: [head, `우승 ${championText(state, trophy)}`].join("\n") };
  }
  return {
    ok: true,
    message: `${head} — 장부에 없습니다 (그 시즌 그 대회의 순위표도 우승 기록도 남지 않았습니다)`,
  };
}

function standingsView(state: GameState, input: LeagueViewInput): LookupResult {
  const past = input.season !== undefined && input.season !== state.season ? input.season : null;
  let competitionId =
    (past === null ? null : leagueOfTeamInSeason(state, past, state.userTeamId)) ??
    leagueOfTeamIn(state, state.userTeamId);
  if (input.competition) {
    const resolved = resolveCompetitionId(input.competition);
    if (!resolved) {
      return {
        ok: false,
        message: `"${input.competition}"라는 대회를 찾지 못했습니다 — ${competitionHint()}`,
      };
    }
    competitionId = resolved;
  } else if (input.team && !EVERY_TEAM.has(norm(input.team))) {
    // 팀을 주면 그 팀이 속한 리그의 순위표를 본다 — 지나간 시즌은 **그때의** 소속이다
    const team = resolveTeam(state, input.team);
    if (!team.ok) return team;
    competitionId =
      (past === null ? null : leagueOfTeamInSeason(state, past, team.teamId)) ??
      leagueOfTeamIn(state, team.teamId);
  }

  // 지나간 시즌은 결산 스냅샷이 답한다 — 지금 경기로 세우는 표가 아니다 (§3.3)
  if (past !== null) return pastCompetitionView(state, past, competitionId);

  // 국내 컵은 순수 녹아웃이라 순위표가 없다 — 대신 대진표를 돌려준다
  if (isDomesticCup(competitionId)) return cupBracketView(state, competitionId);

  const table = computeStandings(state, competitionId);
  if (table.length === 0) {
    return {
      ok: true,
      message: `${competitionName(competitionId)} 순위표가 없습니다 — 아직 참가 팀이 배정되지 않았습니다`,
    };
  }
  const rows = table.map((r, i) => {
    const mark = r.teamId === state.userTeamId ? " ←우리" : "";
    const form = recentForm(state, r.teamId, competitionId);
    return (
      `${String(i + 1).padStart(2)} ${r.name} ${r.played}경기 ${r.wins}승 ${r.draws}무 ${r.losses}패 ` +
      `${r.points}점 (${r.goalDiff >= 0 ? "+" : ""}${r.goalDiff})${form ? ` 폼 ${form}` : ""}${mark}`
    );
  });
  const title = isCup(competitionId)
    ? `[${competitionShortName(competitionId)} 리그 페이즈 순위]`
    : `[리그 순위] ${competitionName(competitionId)}`;
  return {
    ok: true,
    message: [`${title} ${seasonLabel(state.season)} · ${state.date}`, ...rows].join("\n"),
  };
}

/** 지난 시즌 맞대결 줄의 상한 — 한 상대와 한 시즌에 넷까지 붙으므로 셋이면 흐름이 보인다 */
const PAST_H2H_SHOWN = 4;

/** 결산 스냅샷의 경기 한 줄이 남긴 승패·스코어 요약 */
interface PastHeadToHead {
  played: number;
  wins: number;
  draws: number;
  losses: number;
  scored: number;
  conceded: number;
  /** 최근 것부터 — "시즌 3 FA컵 결승 2-1" */
  lines: string[];
}

/**
 * 지난 시즌들의 맞대결 — **장부에 남는 것은 감독 팀의 경기뿐이다**
 * (game-state.md §3.3). 그 시즌 감독이 그 팀에 있었을 때의 줄만 세므로, 남의 팀끼리의
 * 지난 시즌 스코어는 여기서도 나오지 않는다 — 그 물음에는 없다는 것이 답이다.
 */
function pastHeadToHead(state: GameState, teamId: string, opponentId: string): PastHeadToHead {
  const tally: PastHeadToHead = {
    played: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    scored: 0,
    conceded: 0,
    lines: [],
  };
  for (const snapshot of pastSeasonsOf(state)) {
    if (snapshot.teamId !== teamId) continue;
    for (const row of [...snapshot.matches].reverse()) {
      if (row.opponentTeamId !== opponentId) continue;
      // 승패는 지금 시즌의 경기와 **같은 자**를 지난다 — 연장·승부차기의 규칙이 하나다
      const outcome = outcomeFor(asMatchRecord(snapshot.season, row, teamId), teamId);
      tally.played += 1;
      tally.scored += row.goalsFor;
      tally.conceded += row.goalsAgainst;
      if (outcome === "W") tally.wins += 1;
      else if (outcome === "L") tally.losses += 1;
      else tally.draws += 1;
      tally.lines.push(
        `시즌 ${snapshot.season} ${pastMatchLabel(row)} ` +
          `${row.goalsFor}-${row.goalsAgainst}` +
          (row.penalties ? ` (승부차기 ${row.penalties.for}-${row.penalties.against})` : ""),
      );
    }
  }
  return tally;
}

/** 스냅샷이 든 단계 문자열을 대회 라벨이 아는 갈래로 — 모르는 값은 리그 경기다 */
function stageOf(stage: string | undefined): MatchStage {
  const parsed = MatchStageSchema.safeParse(stage);
  return parsed.success ? parsed.data : "league";
}

/**
 * 스냅샷의 경기가 서는 대회 표기 — **라운드도 차수도 남지 않는다** (§3.3).
 * 없는 것을 `R1`·`1차전`으로 지어내지 않으므로 단계 이름까지만 붙인다.
 */
function pastMatchLabel(row: SeasonMatchRow): string {
  const stage = stageOf(row.stage);
  const name = competitionShortName(row.competitionId);
  if (stage === "league") return name;
  const label = isDomesticCup(row.competitionId)
    ? domesticStageLabel(row.competitionId, stage)
    : stageLabel(stage, 1, false);
  return label ? `${name} ${label}` : name;
}

/**
 * 결산 스냅샷의 경기 한 줄을 **경기 레코드의 모양으로** — 승패 판정이 지금 시즌의
 * 경기와 같은 함수를 지나게 하는 자리다. 스냅샷은 감독 팀 시점으로 적히므로 그 팀을
 * 홈에 세운다 (실제 홈·원정은 `venue`가 따로 답한다 — 승패는 그것을 보지 않는다).
 */
function asMatchRecord(season: number, row: SeasonMatchRow, teamId: string): MatchRecord {
  return {
    id: `${season}:${row.date}:${row.opponentTeamId}`,
    season,
    competitionId: row.competitionId,
    round: 1,
    date: row.date,
    homeTeamId: teamId,
    awayTeamId: row.opponentTeamId,
    result: {
      homeGoals: row.goalsFor,
      awayGoals: row.goalsAgainst,
      scorers: [],
      ...(row.penalties
        ? { penalties: { home: row.penalties.for, away: row.penalties.against } }
        : {}),
    },
  };
}

/**
 * 지나간 시즌의 경기 — `state.matches`는 새 시즌 일정으로 갈아 끼워지므로 여기 답할
 * 것은 결산 스냅샷에 남은 **감독 팀의 경기**뿐이다 (game-state.md §3.3).
 *
 * 그 밖의 물음(남의 팀의 지난 시즌 일정, 대회 전체)에는 **없다고 말한다** — 이 자리가
 * 조용히 이번 시즌의 경기를 내면 모델은 그것을 지난 시즌의 일로 옮겨 적는다.
 */
function pastFixturesView(
  state: GameState,
  season: number,
  query: { teamId: string | null; opponentId: string | null; competitionId: string | null },
): LookupResult {
  const head = `[일정] ${seasonLabel(season)} — 지나간 시즌`;
  const snapshot = seasonHistoryOf(state, season);
  const mine = snapshot?.teamId;
  if (snapshot === null || mine === undefined) {
    return {
      ok: true,
      message: `${head}\n장부에 그 시즌의 경기가 없습니다 — 남는 것은 감독 팀의 경기뿐입니다`,
    };
  }
  if (query.teamId !== mine) {
    const asked = query.teamId === null ? "대회 전체" : teamNameIn(state, query.teamId);
    return {
      ok: true,
      message:
        `${head}\n${asked}의 그 시즌 경기는 장부에 없습니다 —` +
        ` 남는 것은 그때 감독이 맡은 ${teamNameIn(state, mine)}의 경기뿐입니다`,
    };
  }
  const rows = snapshot.matches.filter(
    (row) =>
      (query.opponentId === null || row.opponentTeamId === query.opponentId) &&
      (query.competitionId === null || row.competitionId === query.competitionId),
  );
  if (rows.length === 0) {
    return { ok: true, message: `${head}\n조건에 맞는 경기가 없습니다` };
  }
  return {
    ok: true,
    message: [
      `${head} · ${teamNameIn(state, mine)} ${rows.length}경기`,
      ...rows.map((row) => {
        const pens = row.penalties
          ? ` (승부차기 ${row.penalties.for}-${row.penalties.against})`
          : "";
        const outcome = outcomeFor(asMatchRecord(season, row, mine), mine);
        return (
          `  ${dateLabel(row.date)} ${pastMatchLabel(row)} ` +
          `${VENUE_KO[row.venue]} ${row.goalsFor}-${row.goalsAgainst}${pens} ` +
          `vs ${teamNameIn(state, row.opponentTeamId)} ${outcomeLabel(outcome)}`
        );
      }),
    ].join("\n"),
  };
}

/**
 * 일정 검색 — 팀·상대·대회·라운드·날짜 범위·방향으로 좁힌다.
 *
 * 왜 "가까운 N경기"로는 부족한가: 감독은 "다음 맨유전 언제야", "토트넘과 지난
 * 맞대결 어떻게 됐지"처럼 **특정 경기**를 묻는다. 창을 넓히는 대신 조건으로
 * 찾게 해야 모델이 지어내지 않는다. 절단은 항상 남은 수를 함께 알린다.
 */
function fixturesView(state: GameState, input: LeagueViewInput): LookupResult {
  const everyTeam = input.team !== undefined && EVERY_TEAM.has(norm(input.team));
  let teamId: string | null = null;
  if (!everyTeam) {
    const team = resolveTeam(state, input.team);
    if (!team.ok) return team;
    teamId = team.teamId;
  }

  let opponentId: string | null = null;
  if (input.opponent) {
    const opponent = resolveTeam(state, input.opponent);
    if (!opponent.ok) return opponent;
    opponentId = opponent.teamId;
    // 맞대결의 기준은 언제나 한 팀이어야 한다 — 팀을 안 줬으면 우리 팀
    teamId ??= state.userTeamId;
    if (opponentId === teamId) {
      return { ok: false, message: "기준 팀과 상대 팀이 같습니다 — 상대를 다시 지정하라" };
    }
  }

  let competitionId: string | null = null;
  if (input.competition) {
    competitionId = resolveCompetitionId(input.competition);
    if (!competitionId) {
      return {
        ok: false,
        message: `"${input.competition}"라는 대회를 찾지 못했습니다 — ${competitionHint()}`,
      };
    }
  } else if (teamId === null) {
    // 팀을 안 좁혔으면 5대 리그 전 경기가 쏟아진다 — 우리 리그로 기본을 잡는다
    competitionId = leagueOfTeamIn(state, state.userTeamId);
  }

  // 지나간 시즌은 일정 장부에 없다 — 결산 스냅샷이 답한다 (§3.3)
  if (input.season !== undefined && input.season !== state.season) {
    return pastFixturesView(state, input.season, { teamId, opponentId, competitionId });
  }

  const pool = state.matches
    .filter((m) => {
      // 2군 경기는 일정 조회에 서지 않는다 — 달력과 같은 답이어야 한다 (season.md §2)
      if (isReserveMatch(m)) return false;
      if (teamId && m.homeTeamId !== teamId && m.awayTeamId !== teamId) return false;
      if (opponentId && m.homeTeamId !== opponentId && m.awayTeamId !== opponentId) return false;
      if (competitionId && m.competitionId !== competitionId) return false;
      if (input.round !== undefined && m.round !== input.round) return false;
      if (input.from && m.date < input.from) return false;
      if (input.to && m.date > input.to) return false;
      return true;
    })
    .sort((a, b) =>
      a.date === b.date ? (a.time ?? "").localeCompare(b.time ?? "") : a.date < b.date ? -1 : 1,
    );

  const when = input.when ?? "both";
  const played = pool.filter((m) => m.result);
  const upcoming = pool.filter((m) => !m.result);
  const count = Math.min(Math.max(input.count ?? (opponentId || everyTeam ? 10 : 5), 1), 20);
  // 지난 경기는 **최근**부터, 예정 경기는 **가까운 것**부터 잘라낸다
  const shownPast = when === "upcoming" ? [] : played.slice(-count);
  const shownUpcoming = when === "past" ? [] : upcoming.slice(0, count);
  const detail = shownPast.length <= 8;

  const scopeName = teamId
    ? teamNameIn(state, teamId)
    : `${competitionName(competitionId!)} 전체 (모든 팀)`;
  const filters = [
    opponentId ? `vs ${teamNameIn(state, opponentId)}` : null,
    competitionId && teamId ? competitionName(competitionId) : null,
    input.round !== undefined ? `${input.round}라운드` : null,
    input.from || input.to ? `${input.from ?? "시즌 시작"}~${input.to ?? "시즌 끝"}` : null,
    when === "past" ? "지난 경기만" : when === "upcoming" ? "예정만" : null,
  ].filter((x): x is string => x !== null);
  const head =
    `[일정] ${scopeName}${filters.length > 0 ? ` · ${filters.join(" · ")}` : ""}` +
    ` — 오늘 ${dateLabel(state.date)} · ${seasonLabel(state.season)}`;

  const lines: string[] = [head];

  if (opponentId && teamId) {
    if (played.length === 0) {
      lines.push(`이번 시즌 맞대결 기록 없음`);
    } else {
      let w = 0;
      let d = 0;
      let l = 0;
      let scored = 0;
      let conceded = 0;
      for (const m of played) {
        const outcome = outcomeFor(m, teamId);
        if (outcome === "W") w++;
        else if (outcome === "L") l++;
        else d++;
        const home = m.homeTeamId === teamId;
        scored += home ? m.result!.homeGoals : m.result!.awayGoals;
        conceded += home ? m.result!.awayGoals : m.result!.homeGoals;
      }
      lines.push(
        `이번 시즌 맞대결 ${played.length}경기 — ${w}승 ${d}무 ${l}패 (득 ${scored} · 실 ${conceded})`,
      );
    }
    /**
     * **지난 시즌도 남는다 — 다만 감독 팀의 경기만이다** (game-state.md §3.3).
     * 남의 팀끼리의 지난 시즌 스코어는 시즌이 넘어가며 사라졌고, 그 물음에는 없다는
     * 것이 답이다. 두 답을 가르는 것은 장부에 그 팀의 시즌이 남았는가다.
     */
    const past = pastHeadToHead(state, teamId, opponentId);
    const kept = pastSeasonsOf(state).some((h) => h.teamId === teamId);
    if (past.played > 0) {
      const shown = past.lines.slice(0, PAST_H2H_SHOWN);
      lines.push(
        `지난 시즌 맞대결 ${past.played}경기 — ${past.wins}승 ${past.draws}무 ${past.losses}패` +
          ` (득 ${past.scored} · 실 ${past.conceded}) — ${shown.join(" / ")}` +
          (past.lines.length > shown.length
            ? ` …그 외 ${past.lines.length - shown.length}경기`
            : ""),
      );
    } else {
      lines.push(
        kept
          ? `지난 시즌 맞대결 없음 — 장부에 남은 지난 시즌 경기에 이 상대가 없다`
          : `지난 시즌 맞대결은 장부에 없다 — 남는 것은 감독 팀의 경기뿐이다`,
      );
    }
  }

  if (shownPast.length === 0 && shownUpcoming.length === 0) {
    lines.push("조건에 맞는 경기가 없습니다 — 조건을 넓혀라 (상대·대회·라운드·날짜 범위 확인)");
    return { ok: true, message: lines.join("\n") };
  }

  if (played.length > shownPast.length && when !== "upcoming") {
    lines.push(
      `  …더 이전 경기 ${played.length - shownPast.length}건 (count를 올리거나 날짜 범위를 주라)`,
    );
  }
  lines.push(...shownPast.map((m) => matchLine(state, m, teamId, detail)));
  lines.push(...shownUpcoming.map((m) => matchLine(state, m, teamId, detail)));
  if (upcoming.length > shownUpcoming.length && when !== "past") {
    lines.push(`  …더 뒤의 예정 경기 ${upcoming.length - shownUpcoming.length}건`);
  }
  return { ok: true, message: lines.join("\n") };
}

export function leagueView(state: GameState, input: LeagueViewInput): LookupResult {
  return input.view === "standings" ? standingsView(state, input) : fixturesView(state, input);
}

// ── 감독의 달력 (경기 + 훈련 + 이적창) ──────────────────

export interface ScheduleViewInput {
  /** 시작일 — 기본 오늘 */
  from?: string;
  /** 종료일 — 없으면 from + days */
  to?: string;
  /** to가 없을 때의 창 길이 (기본 14일) */
  days?: number;
  /** 종류로 좁히기 */
  type?: "match" | "training" | "window";
  /** 최대 엔트리 수 (기본 25) */
  limit?: number;
}

const SCHEDULE_LIMIT = 25;

/**
 * 일지 줄의 이름 — 화면은 도형으로 갈라 읽지만(`views.ts` `CalendarEventView`) 조회는
 * 글자로 가른다. 갈래를 데이터로 주는 규약은 그대로다: 이름을 붙이는 자리가 여기 하나다.
 */
const JOURNAL_KIND_KO: Record<CalendarEventView["kind"], string> = {
  match: "경기",
  training: "훈련",
  rest: "휴식",
  growth: "성장",
  injury: "부상",
  return: "복귀",
  yellow: "경고",
  red: "퇴장",
  transfer: "이적",
  window: "이적창",
  money: "돈",
  news: "소식",
};

/**
 * 한 번의 조회가 낼 일지 줄의 상한.
 *
 * 일정의 `limit`과 **묶지 않는다** — 석 달치 일정을 부르는 것과 석 달치 일지를 통째로
 * 모델 컨텍스트에 붓는 것은 다른 값이다. 넘치면 뒤를 자르고 몇 건이 남았는지 말한다.
 * 2주치 일지가 대개 이 아래라 "지난주에 무슨 일 있었나"는 잘리지 않는다.
 */
const JOURNAL_LIMIT = 40;

/**
 * 지나간 날의 일지 — 화면의 달력이 세우는 것과 **같은 표**다(`pushRecordJournal`).
 *
 * 일정 축(경기·훈련·이적창)은 위의 일정 줄이 이미 세우므로 여기 다시 서지 않는다.
 * 남는 것은 기록 테이블과 서사 표 몫 — 성장·부상·카드·이적·돈·소식이고, 손잡이로
 * 며칠을 넘긴 턴에 다이제스트로만 흘러간 사건이 여기 있다 (people.md §9).
 */
function pastJournalLines(state: GameState, from: string, to: string): string[] {
  if (from >= state.date) return [];
  const journal: Record<string, CalendarEventView[]> = {};
  pushRecordJournal(state, journal);
  const last = to < state.date ? to : state.date;
  const dates = Object.keys(journal)
    .filter((d) => d >= from && d <= last)
    .sort();

  const out: string[] = [];
  let shown = 0;
  let dropped = 0;
  for (const date of dates) {
    const events = journal[date] ?? [];
    const room = JOURNAL_LIMIT - shown;
    if (room <= 0) {
      dropped += events.length;
      continue;
    }
    out.push(`  ${dateLabel(date)}`);
    for (const e of events.slice(0, room)) {
      out.push(`    ${JOURNAL_KIND_KO[e.kind]} ${e.text}`);
    }
    shown += Math.min(events.length, room);
    dropped += Math.max(0, events.length - room);
  }
  if (out.length === 0) return [];
  if (dropped > 0) out.push(`  …그 외 ${dropped}건 — 범위를 좁혀라`);
  return [`[일지] ${dateLabel(from)} ~ ${dateLabel(last)} — 그 사이 벌어진 일`, ...out];
}

/**
 * 감독의 달력 — 경기만 보는 `get_league`와 달리 **훈련·이적창까지** 한 축에 놓는다.
 * 일정 축이 `SCHEDULE_ENTRY` 하나로 정규화돼 있으니(v6) 조회도 한 곳에서 한다.
 *
 * 우리 팀 일정만 담는다 — 같은 리그 타 팀 경기도 엔트리로는 존재하지만(순위표
 * 계산용) 그건 감독의 달력이 아니다. 리그 전체 편성은 `get_league`가 답한다.
 */
export function scheduleView(state: GameState, input: ScheduleViewInput = {}): LookupResult {
  const from = input.from ?? state.date;
  const days = Math.min(Math.max(input.days ?? 14, 1), 365);
  const to = input.to ?? addDays(from, days);
  if (to < from) return { ok: false, message: `날짜 범위가 뒤집혀 있습니다 (${from} ~ ${to})` };

  const matchById = new Map(state.matches.map((m) => [m.id, m]));
  const sessionById = new Map(state.trainingSessions.map((s) => [s.id, s]));
  const windowById = new Map(state.windows.map((w) => [w.id, w]));
  const wanted = (e: ScheduleEntry) => {
    if (!input.type) return true;
    return input.type === "window" ? e.type.startsWith("window") : e.type === input.type;
  };

  const entries = state.schedule
    .filter((e) => e.date >= from && e.date <= to && wanted(e))
    .filter((e) => {
      // 경기는 우리 팀 경기만 (teamId=null은 리그 타 팀 경기 — 달력에 올리지 않는다)
      if (e.type === "match") return e.teamId !== null;
      return true;
    })
    .sort((a, b) => (a.date === b.date ? a.time.localeCompare(b.time) : a.date < b.date ? -1 : 1));

  const limit = Math.min(Math.max(input.limit ?? SCHEDULE_LIMIT, 1), 60);
  const shown = entries.slice(0, limit);
  const lines = [
    `[달력] ${dateLabel(from)} ~ ${dateLabel(to)} — ${teamNameIn(state, state.userTeamId)} · 오늘 ${dateLabel(state.date)}`,
  ];
  /**
   * 여름 휴가는 **일정이 없는 기간**이라 엔트리로는 보이지 않는다. 그런데 "훈련을
   * 언제부터 잡을 수 있나"는 감독이 달력에서 가장 먼저 묻는 것이라, 비어 있는
   * 이유를 여기서 한 줄로 말한다 (`setTraining`이 거부하기 전에 알 수 있게).
   */
  const squadReturn = squadReturnOf(state.calendar);
  if (from < squadReturn) {
    lines.push(
      `  ${dateLabel(from)} ~ ${dateLabel(addDays(squadReturn, -1))} 선수단 여름 휴가 — 훈련 없음 (소집 ${dateLabel(squadReturn)})`,
    );
  }
  /**
   * 지나간 날은 일정만으로 답이 되지 않는다 — 오퍼 답이 언제 왔고 계약 경고가 언제
   * 섰는지는 일정 축이 아니라 일지에 있다. 앞날만 묻는 창(`from`이 오늘 이후)에는
   * 일지가 없으므로 한 줄도 붙지 않는다.
   */
  const journal = pastJournalLines(state, from, to);
  if (shown.length === 0) {
    lines.push("이 기간에 등록된 일정이 없습니다");
    lines.push(...journal);
    return { ok: true, message: lines.join("\n") };
  }

  for (const e of shown) {
    const when = `  ${dateLabel(e.date)} ${e.time}`;
    if (e.type === "match") {
      const m = matchById.get(e.refId);
      if (!m) continue;
      const home = m.homeTeamId === state.userTeamId;
      const versus = teamNameIn(state, home ? m.awayTeamId : m.homeTeamId);
      const side = m.neutral ? "중립" : home ? "홈" : "원정";
      const score = m.result
        ? ` — ${m.result.homeGoals}-${m.result.awayGoals} ${outcomeLabel(outcomeFor(m, state.userTeamId))}`
        : "";
      lines.push(`${when} 경기 ${competitionTag(m)} ${side} vs ${versus}${score}`);
      continue;
    }
    if (e.type === "training") {
      const s = sessionById.get(e.refId);
      const slot = slotOfTime(e.time) === "am" ? "오전" : "오후";
      lines.push(
        `${when} 훈련 (${slot}) ${s?.label ?? "훈련"}` +
          (s && s.focus.length > 0 ? ` · 효과 ${s.focus.join("·")}` : "") +
          (e.status === "done" ? " [완료]" : ""),
      );
      continue;
    }
    if (e.type === "draw") {
      lines.push(`${when} ${drawTitle(e.refId)}${e.status === "done" ? " [완료]" : ""}`);
      continue;
    }
    if (e.type === "cup-round") {
      // 상대는 추첨에서 정해진다 — 날짜만 공표된 자리다
      const { competition, stage } = drawParts(e.refId);
      lines.push(`${when} ${competition} ${stage} 예정 (상대 미정)`);
      continue;
    }
    const w = windowById.get(e.refId);
    const kind = w?.kind === "winter" ? "겨울" : "여름";
    lines.push(
      `${when} ${kind} 이적시장 ${e.type === "window-open" ? "개장" : "마감"}` +
        (w ? ` (${w.opensOn} ~ ${w.closesOn})` : ""),
    );
  }
  if (entries.length > shown.length) {
    lines.push(`  …그 외 ${entries.length - shown.length}건 — 범위를 좁히거나 limit을 올려라`);
  }
  lines.push(...journal);
  return { ok: true, message: lines.join("\n") };
}

// ── 감독 커리어 (지난 시즌·트로피·업적·시상) ────────────

/** 커리어 카드에 세우는 시상 줄의 수 — 스무 시즌이면 상만 여든 줄이다 */
const AWARDS_SHOWN = 6;

/**
 * 감독 커리어 — 지난 시즌 성적·트로피·업적. 멀티시즌 게임인데 과거를 읽을 자리가
 * 없으면 "작년엔 어땠지"에 답할 수 없다 (경기 장부는 시즌마다 교체되므로
 * `SEASON_RECORD`가 과거의 유일한 원본이다).
 */
export function careerView(state: GameState): LookupResult {
  const league = leagueOfTeamIn(state, state.userTeamId);
  const table = computeStandings(state, league);
  const row = table.find((r) => r.teamId === state.userTeamId);
  const rank = table.findIndex((r) => r.teamId === state.userTeamId) + 1;
  const m = state.manager;

  // 경고는 세이브가 끝나는 길의 카운터다 — 평판 바로 아래에 세워 압박이 읽히게 한다
  const warnings = m.boardWarnings ?? 0;

  /**
   * **무직이면 머리글부터 다르다** (career.md §5.1) — 옛 구단의 순위·경고를 재임
   * 중인 것처럼 세우면 모델이 그 구단의 감독으로 장면을 쓴다. 잘린 사실과 지금
   * 열린 제안이 그 자리에 선다.
   */
  const card = state.dismissal;
  const lines = card
    ? [
        `[커리어] ${m.name} — 무직 (${card.on} ${teamNameIn(state, card.teamId)}에서 ${
          card.kind === "expired" ? "계약 만료" : "경질"
        }) · ${seasonLabel(state.season)}`,
        `평판: ${describeReputation(m.reputation)}`,
        card.expectation && card.position
          ? `자리를 잃은 자리: 기대 ${card.expectation}(${card.target}위) · 당시 ${card.position}위`
          : `자리를 잃은 자리: ${card.reason ?? "기록 없음"}`,
        ...(card.severance ? [`위약금 ${formatMoney(card.severance)}`] : []),
        ...(openManagerOffers(state).length > 0
          ? [
              `받은 감독직 제안:`,
              ...openManagerOffers(state).map(
                (o) =>
                  `  ${o.id} · ${teamNameIn(state, o.teamId)} (${o.tier}티어) · 기대 ${o.expectation}(${o.target}위)` +
                  (o.position ? ` · 현재 ${o.position}위` : "") +
                  (o.salary
                    ? ` · 연봉 ${formatMoney(o.salary)}·${o.years ?? "-"}년·이적 예산 약속 ${formatMoney(o.budgetPledge ?? 0)}`
                    : "") +
                  (o.counteredOn ? ` · 흥정 완료` : "") +
                  ` · ${o.expiresOn}까지`,
              ),
            ]
          : [`받은 감독직 제안: 없음`]),
        ...((state.managerVacancies ?? []).length > 0
          ? [
              `최근 공석 (지원할 수 있는 자리):`,
              ...(state.managerVacancies ?? []).map(
                (v) =>
                  `  ${teamNameIn(state, v.teamId)} (${tierOfTeamIn(state, v.teamId)}티어)` +
                  (v.position ? ` · 현재 ${v.position}위` : "") +
                  ` · ${v.on} 공석`,
              ),
            ]
          : []),
      ]
    : [
        `[커리어] ${m.name} — ${teamNameIn(state, state.userTeamId)} 재임 · ${seasonLabel(state.season)}`,
        // 경고 수와 진행 순위가 겨루는 상대다 — 기대를 모르면 아래 두 줄은 숫자일 뿐이다
        (() => {
          const e = boardExpectation(state, state.userTeamId);
          return boardExpectationLine(e.code, e.target);
        })(),
        /**
         * **구단주가 건 다년 계획** (career.md §5) — 위 기대가 감독의 자리를 재는
         * 그 시즌의 자라면 이쪽은 구단이 몇 년에 걸쳐 가려는 자리다. 진행도는
         * 오늘의 장부에서 매긴 값이라 시즌 중에도 읽힌다.
         */
        (() => {
          const vision = visionOf(state);
          // 0경기 순위는 팀 id 정렬일 뿐이다 — 아직 자리가 없으면 코어에 0을 넘긴다
          const seat = { position: row && row.played > 0 ? rank : 0, leagueSize: table.length };
          const items = visionReadings(state, seat).map(visionItemText);
          return (
            `구단 비전: ${visionYearOf(vision, state.season)}년차/${visionSpanOf(vision)}년 계획` +
            ` · ${items.join(" / ")}`
          );
        })(),
        ...(m.contract
          ? [
              `계약: 연봉 ${formatMoney(m.contract.salary)} · ${m.contract.until}까지` +
                ` (${diffDays(state.date, m.contract.until)}일)` +
                // 비갱신 통보는 만료일이 곧 끝이라는 사실이다 (career.md §5.4)
                (m.contract.renewalOffered === false ? ` · 보드는 재계약하지 않기로 했다` : ""),
            ]
          : []),
        `지갑: ${formatMoney(m.wallet ?? 0)}` +
          // 지갑은 눈금이 아니라 쓸 수 있는 돈이다 — 남은 문이 그 자리에 함께 선다 (career.md §5.4)
          (managedTeamId(state) === null
            ? ""
            : ` · 이번 시즌 사재 출연 여력 ${formatMoney(transferFundRoom(state))}`),
        ...((m.spending ?? []).length > 0
          ? [
              `최근 사재 지출: ${[...(m.spending ?? [])].reverse().slice(0, 5).map(spendLine).join(" / ")}`,
            ]
          : []),
        // 재직 중에 서는 제안은 재계약 하나다 — 답할 자리라 여기 선다 (career.md §5.4)
        ...openManagerOffers(state)
          .filter((o) => o.via === "renewal")
          .map(
            (o) =>
              `보드의 재계약 제안: ${o.id} · 연봉 ${formatMoney(o.salary ?? 0)}·${o.years ?? "-"}년` +
              `·이적 예산 약속 ${formatMoney(o.budgetPledge ?? 0)}` +
              (o.counteredOn ? ` · 흥정 완료` : "") +
              ` · ${o.expiresOn}까지`,
          ),
        `평판: ${describeReputation(m.reputation)}`,
        warnings > 0
          ? `보드 경고: ${warnings}/${USER_WARNINGS_BEFORE_SACK}회` +
            (m.lastWarnedOn ? ` (마지막 ${m.lastWarnedOn})` : "") +
            ` — ${USER_WARNINGS_BEFORE_SACK}회째에 자리가 없어진다`
          : `보드 경고: 없음 (${USER_WARNINGS_BEFORE_SACK}회째에 자리가 없어진다)`,
        row && row.played > 0
          ? `이번 시즌 진행: ${competitionName(league)} ${rank}위 · ${row.played}경기 ${row.wins}승 ${row.draws}무 ${row.losses}패 · 승점 ${row.points} (득실 ${row.goalDiff >= 0 ? "+" : ""}${row.goalDiff})`
          : `이번 시즌 진행: 아직 리그 경기 없음`,
      ];

  /**
   * 시즌 기록과 경질 이력을 한 표로 잇는다 (career.md §6) — 잘린 시즌은
   * `SEASON_RECORD`가 없으므로 경질 줄이 그 해를 채운다. 최신 시즌이 앞이고,
   * 같은 시즌 안에서는 시즌 결산(시즌 끝)이 경질(시즌 중)보다 앞이다.
   */
  const sackings = state.dismissals ?? [];
  const rows = [
    ...state.seasonRecords.map((r) => ({
      season: r.season,
      atEnd: 1,
      on: "",
      text:
        `  시즌 ${r.season} (${seasonLabelOf(r.season)}) ${teamNameIn(state, r.teamId)} ` +
        `${r.position}위 · ${r.wins}승 ${r.draws}무 ${r.losses}패 · 득 ${r.goalsFor} 실 ${r.goalsAgainst}` +
        boardLine(r),
    })),
    ...sackings.map((d) => ({
      season: d.season,
      atEnd: 0,
      on: d.on,
      text:
        `  시즌 ${d.season} (${seasonLabelOf(d.season)}) ${teamNameIn(state, d.teamId)} — ${d.on} ` +
        `${d.kind === "expired" ? "계약 만료" : "경질"}` +
        (d.expectation && d.position
          ? ` (기대 ${d.expectation} ${d.target}위 · 당시 ${d.position}위)`
          : ""),
    })),
  ].sort((a, b) => b.season - a.season || b.atEnd - a.atEnd || b.on.localeCompare(a.on));
  if (rows.length === 0) {
    lines.push("지난 시즌 기록: 없음 (첫 시즌이다)");
  } else {
    lines.push(
      `지난 시즌 기록 ${state.seasonRecords.length}시즌:` +
        (sackings.length > 0 ? ` (자리를 잃은 것 ${sackings.length}회)` : ""),
    );
    for (const r of rows.slice(0, 10)) lines.push(r.text);
    if (rows.length > 10) lines.push(`  …그 외 ${rows.length - 10}줄`);
  }

  /**
   * **보관함은 원장이 아니다** (career.md §6). `TROPHY`는 전 구단의 우승을 드는
   * 세계의 원장이라, 그대로 세우면 AI 구단이 든 컵이 감독의 보관함에 선다 —
   * 재임 여부는 `managerTrophiesOf`가 `SEASON_RECORD`의 (시즌, 팀)으로 가른다.
   */
  const trophies = managerTrophiesOf(state);
  lines.push(
    trophies.length > 0
      ? // TROPHY는 대회 id로 남는다 — 이름은 여기서 카탈로그가 만든다 (career.md §6)
        `트로피 ${trophies.length}개: ${trophies
          .map(
            (t) =>
              `${t.competitionId ? competitionName(t.competitionId) : (t.competition ?? "")} ` +
              `(시즌 ${t.season}, ${teamShortNameIn(state, t.teamId)})`,
          )
          .join(" / ")}`
      : "트로피: 없음",
  );
  /**
   * **시상은 선수의 것이지만 어느 해에 우리 선수가 리그의 상을 들었는가는 감독의
   * 이력이다** (career.md §6). 그래서 세우는 것은 감독이 그 시즌 맡고 있던 팀의
   * 상뿐이고, 남의 리그 득점왕은 여기 서지 않는다 — 트로피와 같은 자로 가른다.
   */
  // 감독이 그 시즌 그 팀에 있었나 — 트로피 보관함과 **같은 자**로 잰다 (career.md §6)
  const managedThen = managerTenureOf(state);
  const awards = (state.awards ?? [])
    .filter((a) => managedThen(a.season, a.teamId))
    .sort((a, b) => b.season - a.season || a.code.localeCompare(b.code));
  if (awards.length > 0) {
    const shown = awards.slice(0, AWARDS_SHOWN);
    lines.push(
      `우리 선수의 리그 시상 ${awards.length}건:`,
      ...shown.map((a) => `  시즌 ${a.season} ${awardLine(a)}`),
    );
    if (awards.length > shown.length) lines.push(`  …그 외 ${awards.length - shown.length}건`);
  }
  if (state.achievements.length > 0) {
    lines.push(
      `업적 ${state.achievements.length}개: ${state.achievements
        .map((a) => `${achievementLine(a)} (시즌 ${a.season})`)
        .join(" / ")}`,
    );
  }
  /**
   * **은퇴 명부** — 감독이 데리고 있다 보낸 사람들 (season.md §6). 명단에서 사라진
   * 이름을 되찾을 수 있는 유일한 자리라 통산과 함께 선다 — 통산은 명부가 아니라
   * `seasonStats`에서 온다(`careerTotalsOf`), 한 값을 두 곳에 적지 않는다.
   */
  const retired = [...(state.retired ?? [])].sort((a, b) => b.season - a.season);
  if (retired.length > 0) {
    lines.push(`은퇴 ${retired.length}명 (우리 팀에서):`);
    for (const r of retired.slice(0, RETIRED_SHOWN)) {
      const totals = careerTotalsOf(state, r.gamePlayerId, r.teamId);
      lines.push(
        `  시즌 ${r.season} ${r.name} (${r.position}) — 만 ${ageOf(r.birthdate, r.on)}세 · ` +
          `${teamShortNameIn(state, r.teamId)}에서 ${totals.apps}경기 ${totals.goals}골 ${totals.assists}도움`,
      );
    }
    if (retired.length > RETIRED_SHOWN) {
      lines.push(`  …그 외 ${retired.length - RETIRED_SHOWN}명`);
    }
  }
  return { ok: true, message: lines.join("\n") };
}

/** 커리어 카드에 세우는 은퇴 이름의 수 — 스무 시즌이면 명부가 카드를 통째로 덮는다 */
const RETIRED_SHOWN = 8;

// ── 역대 (지나간 시즌 · 구단 역사 · 선수 통산) ──────────

/**
 * 세계의 기억을 읽는 자리 — **장부에 남은 것만** 답한다 (game-state.md §3.3).
 *
 * 시즌이 넘어가면 경기는 사라지고 표가 남는다: 리그별 최종 순위표(`state.history`),
 * 전 구단의 우승(`TROPHY` + 카탈로그 `honours`), 그리고 **감독 팀의 경기**뿐이다.
 * 남의 팀끼리의 지난 시즌 스코어는 없고, 그 물음에는 없다고 말한다 — 답할 도구가
 * 조용히 빈 답을 주면 모델이 지어낸다.
 */
export interface HistoryViewInput {
  /** 시즌 번호 — 주면 그 시즌 하나를 본다 */
  season?: number;
  /** 대회 이름·약어·id — `season`과 함께면 그 시즌 그 대회의 결과다 */
  competition?: string;
  /** 구단 이름·약칭·id — `season` 없이 주면 그 구단의 역대 기록이다 */
  team?: string;
  /** 선수 이름 또는 id — 은퇴한 선수도 찾는다 */
  player?: string;
  /** 목록의 최대 행 수 (기본 8) — 순위표는 자르지 않는다 */
  count?: number;
}

/** 그 시즌 감독 팀의 성적 한 줄 — 스냅샷이 어느 팀의 것인지 모르면 서지 않는다 */
function ourSeasonLine(state: GameState, snapshot: SeasonHistory): string | null {
  const teamId = snapshot.teamId;
  if (teamId === undefined) return null;
  for (const league of snapshot.leagues) {
    const index = league.rows.findIndex((r) => r.teamId === teamId);
    if (index < 0) continue;
    const record = league.rows[index]!.record;
    return (
      `우리: ${teamNameIn(state, teamId)} ${competitionShortName(league.leagueId)} ${index + 1}위` +
      (record
        ? ` · ${record.played}경기 ${record.wins}승 ${record.draws}무 ${record.losses}패` +
          ` · 승점 ${record.points} (득 ${record.goalsFor} 실 ${record.goalsAgainst})`
        : "") +
      (snapshot.matches.length > 0 ? ` · 장부에 남은 경기 ${snapshot.matches.length}건` : "")
    );
  }
  return null;
}

/**
 * 그 시즌의 우승자 전부 — **리그는 표의 1위, 녹아웃은 트로피**다 (§3.3).
 * 리그 우승도 트로피 원장에 한 줄이 있으므로 표가 이미 답한 대회는 다시 세우지 않는다.
 */
function championLines(state: GameState, snapshot: SeasonHistory): string[] {
  const fromTable = snapshot.leagues
    .map((league) => {
      const champion = league.rows[0];
      return champion === undefined
        ? null
        : `  ${competitionName(league.leagueId)} — ${teamNameIn(state, champion.teamId)}`;
    })
    .filter((line): line is string => line !== null);
  const covered = new Set(snapshot.leagues.map((l) => l.leagueId));
  const fromTrophies = state.trophies
    .filter(
      (t) =>
        t.season === snapshot.season &&
        t.competitionId !== undefined &&
        !covered.has(t.competitionId),
    )
    .map((t) => `  ${competitionName(t.competitionId ?? null)} — ${championText(state, t)}`)
    .sort();
  return [...fromTable, ...fromTrophies];
}

/** 지나간 시즌 한 줄 — 시즌·우리 순위·리그 챔피언 */
function pastSeasonLine(state: GameState, snapshot: SeasonHistory): string {
  const ourLeague =
    snapshot.teamId === undefined
      ? null
      : (snapshot.leagues.find((l) => l.rows.some((r) => r.teamId === snapshot.teamId)) ?? null);
  const ours =
    ourLeague === null || snapshot.teamId === undefined
      ? ""
      : ` ${teamShortNameIn(state, snapshot.teamId)} ${competitionShortName(ourLeague.leagueId)} ` +
        `${ourLeague.rows.findIndex((r) => r.teamId === snapshot.teamId) + 1}위`;
  // 감독의 리그를 모르는 행(이관된 행)도 표의 1위는 안다 — 그 표의 챔피언을 세운다
  const league = ourLeague ?? snapshot.leagues[0];
  const champion = league?.rows[0];
  const crown =
    league === undefined || champion === undefined
      ? ""
      : ` · ${competitionShortName(league.leagueId)} 챔피언 ${teamNameIn(state, champion.teamId)}`;
  return `  시즌 ${snapshot.season} (${seasonLabelOf(snapshot.season)})${ours}${crown}`;
}

/**
 * 그 구단의 역대 — 전부 `clubRecordsOf` 하나에서 나온다 (career.md §6).
 * 우승 줄은 시드가 없고 게임 안의 우승도 없으면 서지 않는다: **없는 것은 0회가
 * 아니라 모르는 것이다** (team.md §1).
 */
function clubHistoryView(state: GameState, teamId: string, limit: number): LookupResult {
  const records = clubRecordsOf(state, teamId);
  const honours = clubHonoursLine(state, teamId);
  const at = (best: { season: number; leagueId: string }) =>
    `(시즌 ${best.season} · ${competitionShortName(best.leagueId)})`;
  const lines = [
    `[역대] ${teamNameIn(state, teamId)} — 장부가 아는 ${records.seasons}시즌 · 오늘 ${state.date}`,
    ...(honours === null ? [] : [`우승: ${honours}`]),
    ...(records.bestPoints === null
      ? []
      : [`한 시즌 최다 승점: ${records.bestPoints.value}점 ${at(records.bestPoints)}`]),
    ...(records.mostGoals === null
      ? []
      : [`한 시즌 최다 득점: ${records.mostGoals.value}골 ${at(records.mostGoals)}`]),
    ...(records.bestPosition === null
      ? []
      : [`역대 최고 순위: ${records.bestPosition.value}위 ${at(records.bestPosition)}`]),
  ];
  if (records.awards.length > 0) {
    const shown = records.awards.slice(0, limit);
    lines.push(
      `이 구단 소속의 리그 시상 ${records.awards.length}건:`,
      ...shown.map((a) => `  시즌 ${a.season} ${awardLine(a)}`),
    );
    if (records.awards.length > shown.length) {
      lines.push(`  …그 외 ${records.awards.length - shown.length}건`);
    }
  }
  if (lines.length === 1) {
    lines.push(`장부에 남은 기록이 없습니다 — 지나간 시즌도 우승도 아직 없습니다`);
  }
  return { ok: true, message: lines.join("\n") };
}

/** 역대를 물을 수 있는 사람 — 현역과 **은퇴한 사람**이 한 명부에 선다 */
interface HistoryPerson {
  id: string;
  name: string;
  note: string;
}

/**
 * 이름으로 사람을 찾는다 — 은퇴하면 `state.players`에서 빠지므로 명부(`state.retired`)도
 * 함께 뒤진다. 역대 득점왕을 물었는데 그 사람이 그만뒀다는 이유로 못 찾으면 안 된다.
 */
function resolveHistoryPerson(state: GameState, ref: string): readonly HistoryPerson[] {
  const pool: HistoryPerson[] = [
    ...state.players.map((p) => ({
      id: p.id,
      name: p.name,
      note: `${naturalPositionOf(p).position} · ${teamShortNameIn(state, p.teamId)}`,
    })),
    ...(state.retired ?? []).map((r) => ({
      id: r.gamePlayerId,
      name: r.name,
      note: `${r.position} · ${r.on} 은퇴`,
    })),
  ];
  const key = ref.trim();
  const exact = pool.find((p) => p.id === key);
  if (exact) return [exact];
  return rankByName(key, pool).matches;
}

/** 그 선수의 통산과 받은 상 — 통산은 `careerOf` 하나에서 나온다 (game-state.md §5) */
function playerHistoryView(state: GameState, person: HistoryPerson): LookupResult {
  const career = careerOf(state, person.id);
  const awards = (state.awards ?? [])
    .filter((a) => a.gamePlayerId === person.id)
    .sort((a, b) => b.season - a.season || a.code.localeCompare(b.code));
  const played = (t: CareerTotals) => t.apps > 0 || t.reserveApps > 0;
  const lines = [`[역대] ${person.name} (${person.note})`];
  lines.push(
    played(career.totals)
      ? `통산: ${careerStatText(career.totals)}`
      : `통산: 장부에 출전 기록이 없습니다 (게임이 시작되기 전의 커리어는 장부에 없습니다)`,
  );
  const teams = career.teams.filter(played);
  if (teams.length > 0) {
    lines.push(
      `팀별: ${teams
        .map((t) => `${teamShortNameIn(state, t.teamId)}(${t.from}~${t.to}) ${careerStatText(t)}`)
        .join(" / ")}`,
    );
  }
  const seasons = career.seasons.filter(played);
  if (seasons.length > 1) {
    lines.push(
      `시즌별: ${seasons
        .map((s) => `${s.season} ${teamShortNameIn(state, s.teamId)} ${careerStatText(s)}`)
        .join(" / ")}`,
    );
  }
  if (awards.length > 0) {
    lines.push(
      `받은 상 ${awards.length}건:`,
      ...awards.map(
        (a) => `  시즌 ${a.season} ${competitionShortName(a.leagueId)} ${awardLine(a)}`,
      ),
    );
  }
  return { ok: true, message: lines.join("\n") };
}

/**
 * 역대 조회 — 시즌·대회·팀·선수로 좁혀 답한다.
 *
 * 좁힌 것이 없으면 지나간 시즌의 목록이 최근 것부터 온다. 절단은 언제나 남은 수를
 * 함께 알린다 (이 파일의 다른 뷰와 같은 규약) — 순위표만은 자르지 않는다: 표는
 * 잘리면 표가 아니다.
 */
export function historyView(state: GameState, input: HistoryViewInput = {}): LookupResult {
  const limit = Math.min(Math.max(input.count ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  if (input.player !== undefined) {
    const matches = resolveHistoryPerson(state, input.player);
    if (matches.length === 0) {
      return { ok: false, message: `"${input.player}"라는 선수를 찾지 못했습니다` };
    }
    if (matches.length > 1) {
      const names = matches
        .slice(0, 6)
        .map((p) => `${p.name}(${p.id})`)
        .join(" / ");
      return { ok: false, message: `"${input.player}"는 여러 선수와 맞습니다 — ${names}` };
    }
    return playerHistoryView(state, matches[0]!);
  }

  let teamId: string | null = null;
  if (input.team !== undefined) {
    const resolved = resolveTeam(state, input.team);
    if (!resolved.ok) return resolved;
    teamId = resolved.teamId;
  }

  let competitionId: string | null = null;
  if (input.competition !== undefined) {
    competitionId = resolveCompetitionId(input.competition);
    if (competitionId === null) {
      return {
        ok: false,
        message: `"${input.competition}"라는 대회를 찾지 못했습니다 — ${competitionHint()}`,
      };
    }
  }

  if (input.season !== undefined) {
    const season = input.season;
    if (season >= state.season) {
      return {
        ok: true,
        message:
          `시즌 ${season}은 아직 지나가지 않았습니다 — 결산 스냅샷은 시즌이 넘어갈 때 남습니다.` +
          ` 진행 중인 시즌은 순위표와 일정이 답합니다`,
      };
    }
    // 대회를 주면 그 대회 하나, 팀을 주면 **그때** 그 팀이 뛴 리그의 표
    const narrowed =
      competitionId ?? (teamId === null ? null : leagueOfTeamInSeason(state, season, teamId));
    if (narrowed !== null) return pastCompetitionView(state, season, narrowed);

    const snapshot = seasonHistoryOf(state, season);
    if (snapshot === null) {
      return { ok: true, message: `시즌 ${season}의 결산이 장부에 없습니다` };
    }
    const champions = championLines(state, snapshot);
    const ours = ourSeasonLine(state, snapshot);
    return {
      ok: true,
      message: [
        `[역대] ${seasonLabel(season)} 결산`,
        ...(champions.length > 0 ? [`우승:`, ...champions] : [`우승: 장부에 남은 것이 없습니다`]),
        ...(ours === null ? [] : [ours]),
      ].join("\n"),
    };
  }

  if (teamId !== null) return clubHistoryView(state, teamId, limit);

  // 대회만 주면 그 대회의 역대 우승 — 시즌마다 한 줄이다
  if (competitionId !== null) {
    const cup = competitionId;
    const rows = pastSeasonsOf(state)
      .map((snapshot) => {
        const at = `  시즌 ${snapshot.season} (${seasonLabelOf(snapshot.season)})`;
        const champion = snapshot.leagues.find((l) => l.leagueId === cup)?.rows[0];
        if (champion) return `${at} ${teamNameIn(state, champion.teamId)}`;
        const trophy = trophyOf(state, snapshot.season, cup);
        return trophy === null ? null : `${at} ${championText(state, trophy)}`;
      })
      .filter((line): line is string => line !== null);
    if (rows.length === 0) {
      return {
        ok: true,
        message: `[역대] ${competitionName(cup)} — 장부에 지나간 시즌의 우승이 없습니다`,
      };
    }
    const shown = rows.slice(0, limit);
    return {
      ok: true,
      message: [
        `[역대] ${competitionName(cup)} 우승 ${rows.length}시즌 (최근부터)`,
        ...shown,
        ...(rows.length > shown.length ? [`  …그 외 ${rows.length - shown.length}시즌`] : []),
      ].join("\n"),
    };
  }

  const seasons = pastSeasonsOf(state);
  if (seasons.length === 0) {
    return {
      ok: true,
      message: `[역대] 장부에 지나간 시즌이 없습니다 — ${seasonLabel(state.season)}이 첫 시즌입니다`,
    };
  }
  const shown = seasons.slice(0, limit);
  return {
    ok: true,
    message: [
      `[역대] 지나간 ${seasons.length}시즌 (최근부터) · 오늘 ${state.date}`,
      ...shown.map((snapshot) => pastSeasonLine(state, snapshot)),
      ...(seasons.length > shown.length ? [`  …그 외 ${seasons.length - shown.length}시즌`] : []),
    ].join("\n"),
  };
}

// ── 끝난 경기 리포트 (match.md §8) ──────────────────────

/**
 * 리포트가 고를 경기 — **전부 optional**이고, 아무것도 없으면 가장 최근에 끝난
 * 우리 경기다. 감독은 "지난 리버풀전"이라고 부르지 경기 id를 모른다.
 */
export interface MatchReportInput {
  /** 경기 id — 주면 나머지 조건은 보지 않는다 */
  matchId?: string;
  /** 상대 팀 이름·약칭 */
  opponent?: string;
  /** 대회 이름·약칭·id */
  competition?: string;
  /** 그날 치른 경기 — YYYY-MM-DD */
  date?: string;
}

/**
 * 타임라인 상한 — 골·카드·교체·부상·국면 표식 넷이 다 서고도 여유가 남는 폭.
 * 넘치면 **큰 기회부터** 걷어낸다: 슛의 총량은 이미 팀 스탯의 숫자이고, 골이
 * 큰 기회 스무 줄 사이에 묻히면 리포트가 답하는 것이 없다.
 */
const REPORT_TIMELINE_LIMIT = 30;
/** 우리 선수 줄 상한 — 한 경기의 출전 명단 (선발 11 + 교체 6, 연장까지) */
const REPORT_OUR_LIMIT = 17;
/** 상대 선수 줄 상한 — 이름이 남은 선수만 서므로 이 위로 갈 일이 드물다 */
const REPORT_THEIR_LIMIT = DEFAULT_LIMIT;

/** 사건의 이름 — 화면은 아이콘으로, 조회는 말로 가른다 (`MatchReportEventView.type`) */
const REPORT_EVENT_KO: Record<MatchEventType, string> = {
  kickoff: "킥오프",
  goal: "골",
  shot: "큰 기회",
  save: "선방",
  chance: "기회",
  foul: "파울",
  yellow_card: "경고",
  red_card: "퇴장",
  substitution: "교체",
  injury: "부상",
  tactical_shift: "전술 전환",
  half_time: "하프타임",
  extra_time_start: "연장 개시",
  extra_half_time: "연장 전반 종료",
  full_time: "종료",
};

const REPORT_ORIGIN_KO: Record<ShotOrigin, string> = {
  open: "열린 플레이",
  corner: "코너",
  free_kick: "프리킥",
  penalty: "페널티",
};

const SHOOTOUT_KO: Record<ShootoutOutcome, string> = {
  scored: "성공",
  saved: "막힘",
  missed: "실축",
};

const VENUE_KO: Record<"home" | "away" | "neutral", string> = {
  home: "홈",
  away: "원정",
  neutral: "중립",
};

/** 끝난 우리 경기 — 오래된 것부터. 2군 경기는 서지 않는다 (일정 조회와 같은 답) */
function finishedOurMatches(state: GameState): MatchRecord[] {
  return state.matches
    .filter(
      (m) =>
        m.result &&
        !isReserveMatch(m) &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    )
    .sort((a, b) =>
      a.date === b.date ? (a.time ?? "").localeCompare(b.time ?? "") : a.date < b.date ? -1 : 1,
    );
}

/** 못 찾았을 때 돌려주는 후보 — 조용히 빈 결과를 주면 모델이 지어낸다 (파일 머리 규약) */
function reportCandidates(state: GameState): string[] {
  const recent = finishedOurMatches(state).slice(-DEFAULT_LIMIT).reverse();
  if (recent.length === 0) return ["  끝난 우리 경기가 아직 없다"];
  return recent.map(
    (m) =>
      `  ${m.id} · ${dateLabel(m.date)} ${competitionTag(m)} ` +
      `${teamShortNameIn(state, m.homeTeamId)} ${m.result?.homeGoals}-${m.result?.awayGoals} ` +
      `${teamShortNameIn(state, m.awayTeamId)}`,
  );
}

type PickedMatch = { ok: true; matchId: string } | { ok: false; message: string };

function pickReportMatch(state: GameState, input: MatchReportInput): PickedMatch {
  if (input.matchId) {
    const m = state.matches.find((x) => x.id === input.matchId);
    if (!m) {
      return {
        ok: false,
        message: [`"${input.matchId}"라는 경기를 찾지 못했습니다 — 최근 우리 경기:`]
          .concat(reportCandidates(state))
          .join("\n"),
      };
    }
    if (!m.result) {
      return {
        ok: false,
        message: `${dateLabel(m.date)} ${competitionTag(m)} 경기는 아직 치르지 않았습니다 — 리포트는 끝난 경기에만 있습니다`,
      };
    }
    return { ok: true, matchId: m.id };
  }

  let pool = finishedOurMatches(state);
  const filters: string[] = [];
  if (input.opponent) {
    const opponent = resolveTeam(state, input.opponent);
    if (!opponent.ok) return opponent;
    if (opponent.teamId === state.userTeamId) {
      return { ok: false, message: "상대가 우리 팀입니다 — 상대를 다시 지정하라" };
    }
    pool = pool.filter((m) => m.homeTeamId === opponent.teamId || m.awayTeamId === opponent.teamId);
    filters.push(`vs ${teamNameIn(state, opponent.teamId)}`);
  }
  if (input.competition) {
    const competitionId = resolveCompetitionId(input.competition);
    if (!competitionId) {
      return {
        ok: false,
        message: `"${input.competition}"라는 대회를 찾지 못했습니다 — ${competitionHint()}`,
      };
    }
    pool = pool.filter((m) => m.competitionId === competitionId);
    filters.push(competitionName(competitionId));
  }
  if (input.date) {
    pool = pool.filter((m) => m.date === input.date);
    filters.push(input.date);
  }

  const last = pool[pool.length - 1];
  if (!last) {
    return {
      ok: false,
      message: [
        `${filters.length > 0 ? `조건(${filters.join(" · ")})에 ` : ""}맞는 끝난 경기가 없습니다 — 최근 우리 경기:`,
      ]
        .concat(reportCandidates(state))
        .join("\n"),
    };
  }
  return { ok: true, matchId: last.id };
}

/** 팀 스탯 한 칸 — **양쪽 다 0이면 서지 않는다**: 사건 없는 경기의 빈칸이 0으로 읽힌다 */
function statPair(label: string, home: number, away: number, digits = 0): string | null {
  if (home === 0 && away === 0) return null;
  return `${label} ${home.toFixed(digits)}-${away.toFixed(digits)}`;
}

/** 타임라인 한 줄 — 뷰가 이미 고른 사건을 말로 옮기기만 한다 */
function timelineLine(e: MatchReportEventView, report: MatchReportView): string {
  const team =
    e.side === null ? "" : ` ${e.side === "home" ? report.home.short : report.away.short}`;
  const who =
    e.type === "goal"
      ? ` ${e.actors[0] ?? "?"}${e.actors[1] ? ` (도움 ${e.actors[1]})` : ""}`
      : e.type === "substitution"
        ? ` ${e.actors[0] ?? "?"} 나가고 ${e.actors[1] ?? "?"} 들어옴`
        : e.actors.length > 0
          ? ` ${e.actors.join(", ")}`
          : "";
  const tail = [
    e.origin === null ? null : REPORT_ORIGIN_KO[e.origin],
    e.xg === null ? null : `xG ${e.xg.toFixed(2)}`,
    e.subCause,
    ...e.causes,
  ].filter((x): x is string => x !== null && x !== "");
  return (
    `  ${e.minute}′ ${REPORT_EVENT_KO[e.type]}${team}${who}` +
    `${tail.length > 0 ? ` · ${tail.join(" · ")}` : ""}`
  );
}

/** 선수 한 줄 — 평점과 그 **한 줄 근거**까지. 근거는 결산 LLM이 남긴 경우에만 있다 */
function playerReportRow(p: MatchReportPlayerView, teamShort: string): string {
  const stats = [
    p.goals > 0 ? `골 ${p.goals}` : null,
    p.assists > 0 ? `도움 ${p.assists}` : null,
    p.shots > 0 ? `슛 ${p.shots}` : null,
    p.xg > 0 ? `xG ${p.xg.toFixed(2)}` : null,
    p.saves > 0 ? `선방 ${p.saves}` : null,
    p.passes > 0 ? `패스 ${p.passes}(전진 ${p.progressive})` : null,
    p.corners > 0 ? `코너 ${p.corners}` : null,
    p.fouls > 0 ? `파울 ${p.fouls}` : null,
    p.yellows > 0 ? `경고 ${p.yellows}` : null,
    p.red ? "퇴장" : null,
  ].filter((x): x is string => x !== null);
  return (
    `  ${p.rating === null ? "" : `평점 ${p.rating.toFixed(1)} · `}` +
    `${p.squadNumber === null ? "" : `${p.squadNumber} `}${p.name}` +
    `${teamShort === "" ? "" : `(${teamShort})`} ${p.minutes}′ ${p.started ? "선발" : "교체 투입"}` +
    `${stats.length > 0 ? ` · ${stats.join(" · ")}` : ""}` +
    `${p.note === null ? "" : ` — ${p.note}`}`
  );
}

/**
 * 끝난 경기 하나 — **사실은 뷰가 세고 여기서는 옮기기만 한다** (`buildMatchReport`).
 *
 * 스코어만 들고 답하면 "그 경기 왜 졌지"에 모델이 나머지를 지어낸다: 슛 3·xG 0.4로
 * 진 경기와 슛 18·xG 2.3으로 진 경기는 같은 1-2 패가 아니다 (match.md §8).
 *
 * 끝난 경기에서 **실제로 일어난 일**은 공개 사실이라 상대 쪽도 흐리지 않는다 —
 * 90분 동안 화면에 이미 서 있던 것들이다. 능력치는 여기 서지 않는다.
 */
export function matchReport(state: GameState, input: MatchReportInput = {}): LookupResult {
  const picked = pickReportMatch(state, input);
  if (!picked.ok) return picked;
  const report = buildMatchReport(state, picked.matchId);
  if (!report) return { ok: false, message: `${picked.matchId} 경기의 결과를 읽지 못했습니다` };

  const shootout = report.penalties;
  const lines: string[] = [
    `[경기 리포트] ${dateLabel(report.date)} ${report.label} — ` +
      `${report.home.name} ${report.home.goals}-${report.away.goals} ${report.away.name}` +
      `${report.aet ? " (연장)" : ""}` +
      `${shootout ? ` (승부차기 ${shootout.home}-${shootout.away})` : ""}`,
  ];

  const ourTeam = report.home.ours ? report.home : report.away.ours ? report.away : null;
  lines.push(
    ourTeam
      ? `우리 ${ourTeam.name}(${ourTeam.short}) · ${VENUE_KO[report.venue ?? "neutral"]} · ` +
          `${outcomeLabel(report.outcome)}`
      : "우리 경기가 아니다 — 평점과 MOTM은 우리 경기에만 남는다",
  );
  if (!report.hasDetail) {
    lines.push(
      "※ 사건 기록이 없는 경기다 (타 팀 간이 시뮬 또는 옛 세이브) — 타임라인은 득점 줄뿐이고 " +
        "선수별 기록도 없다. 빈 타임라인이 조용했던 경기라는 뜻이 아니다",
    );
  }

  const teamStats = [
    report.home.possession === null || report.away.possession === null
      ? null
      : `점유 ${Math.round(report.home.possession * 100)}%-${Math.round(report.away.possession * 100)}%`,
    statPair("슛", report.home.shots, report.away.shots),
    statPair("xG", report.home.xg, report.away.xg, 2),
    statPair("기대 득점", report.home.expectedGoals, report.away.expectedGoals, 2),
    statPair("패스", report.home.passes, report.away.passes),
    statPair("전진 패스", report.home.progressive, report.away.progressive),
    statPair("코너", report.home.corners, report.away.corners),
    statPair("파울", report.home.fouls, report.away.fouls),
    statPair("경고", report.home.yellows, report.away.yellows),
    statPair("퇴장", report.home.reds, report.away.reds),
  ].filter((x): x is string => x !== null);
  if (teamStats.length > 0) {
    lines.push(`스탯 (${report.home.short}-${report.away.short}): ${teamStats.join(" · ")}`);
  }

  // 넘치면 큰 기회를 먼저 걷고, 그래도 넘치면 뒤(경기 후반)를 남긴다
  const trimmed =
    report.timeline.length <= REPORT_TIMELINE_LIMIT
      ? report.timeline
      : report.timeline.filter((e) => e.type !== "shot");
  const shownEvents = trimmed.slice(-REPORT_TIMELINE_LIMIT);
  if (shownEvents.length === 0) {
    lines.push("타임라인: 남은 사건이 없다");
  } else {
    if (report.timeline.length > shownEvents.length) {
      lines.push(
        `타임라인 (세우지 않은 사건 ${report.timeline.length - shownEvents.length}건 — 큰 기회부터 걷어냈다):`,
      );
    } else {
      lines.push("타임라인:");
    }
    lines.push(...shownEvents.map((e) => timelineLine(e, report)));
  }

  if (shootout && shootout.kicks.length > 0) {
    lines.push(`승부차기 ${shootout.home}-${shootout.away}:`);
    lines.push(
      ...shootout.kicks.map(
        (k) =>
          `  ${k.round} ${k.team} ${k.taker} ${SHOOTOUT_KO[k.outcome]}` +
          `${k.keeper === null ? "" : ` (GK ${k.keeper})`}`,
      ),
    );
  }

  const ourRows = report.players
    .filter((p) => p.ours)
    .sort(
      (a, b) =>
        (b.rating ?? -1) - (a.rating ?? -1) || b.minutes - a.minutes || a.id.localeCompare(b.id),
    );
  if (ourRows.length > 0) {
    lines.push("우리 선수 (평점 높은 순):");
    lines.push(...ourRows.slice(0, REPORT_OUR_LIMIT).map((p) => playerReportRow(p, "")));
    if (ourRows.length > REPORT_OUR_LIMIT) {
      lines.push(`  …그 외 ${ourRows.length - REPORT_OUR_LIMIT}명`);
    }
  }
  // 상대는 이름이 남은 선수만 — 스물두 명을 다 세우면 리포트가 명단표가 된다
  const theirRows = report.players.filter(
    (p) => !p.ours && (p.goals > 0 || p.assists > 0 || p.red),
  );
  if (theirRows.length > 0) {
    lines.push(`${ourTeam ? "상대" : "그 밖의"} 선수 (득점·도움·퇴장만):`);
    lines.push(
      ...theirRows
        .slice(0, REPORT_THEIR_LIMIT)
        .map((p) => playerReportRow(p, p.side === "home" ? report.home.short : report.away.short)),
    );
    if (theirRows.length > REPORT_THEIR_LIMIT) {
      lines.push(`  …그 외 ${theirRows.length - REPORT_THEIR_LIMIT}명`);
    }
  }

  if (report.motm) {
    lines.push(`MOTM: ${report.motm.name} 평점 ${report.motm.rating.toFixed(1)}`);
  }
  return { ok: true, message: lines.join("\n") };
}

export interface OpponentReportInput {
  /** 경기 id — 주면 나머지 조건은 보지 않는다 */
  matchId?: string;
  /** 상대 팀 이름·약칭 */
  opponent?: string;
  /** 대회 이름·약칭·id */
  competition?: string;
  /** 그날 치를 경기 — YYYY-MM-DD */
  date?: string;
}

/** 아직 치르지 않은 우리 경기 — 가까운 것부터. 2군 경기는 서지 않는다 */
function upcomingOurMatches(state: GameState): MatchRecord[] {
  return state.matches
    .filter(
      (m) =>
        !m.result &&
        !isReserveMatch(m) &&
        m.date >= state.date &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    )
    .sort((a, b) =>
      a.date === b.date ? (a.time ?? "").localeCompare(b.time ?? "") : a.date < b.date ? -1 : 1,
    );
}

/** 못 찾았을 때 돌려주는 후보 — 조용히 빈 결과를 주면 모델이 지어낸다 (파일 머리 규약) */
function previewCandidates(state: GameState): string[] {
  const upcoming = upcomingOurMatches(state).slice(0, DEFAULT_LIMIT);
  if (upcoming.length === 0) return ["  남은 우리 경기가 없다"];
  return upcoming.map(
    (m) =>
      `  ${m.id} · ${dateLabel(m.date)} ${competitionTag(m)} ` +
      `vs ${teamShortNameIn(state, m.homeTeamId === state.userTeamId ? m.awayTeamId : m.homeTeamId)}`,
  );
}

function pickUpcomingMatch(state: GameState, input: OpponentReportInput): PickedMatch {
  if (input.matchId) {
    const m = state.matches.find((x) => x.id === input.matchId);
    if (!m) return { ok: false, message: `${input.matchId} 경기를 찾지 못했습니다` };
    if (m.result) return { ok: false, message: `${input.matchId}는 이미 끝난 경기입니다` };
    return { ok: true, matchId: m.id };
  }
  let list = upcomingOurMatches(state);
  const filters: string[] = [];
  if (input.opponent) {
    const resolved = resolveTeam(state, input.opponent);
    if (!resolved.ok) return { ok: false, message: resolved.message };
    list = list.filter((m) => m.homeTeamId === resolved.teamId || m.awayTeamId === resolved.teamId);
    filters.push(teamNameIn(state, resolved.teamId));
  }
  if (input.competition) {
    const id = resolveCompetitionId(input.competition);
    if (id === null) return { ok: false, message: `${input.competition} 대회를 찾지 못했습니다` };
    list = list.filter((m) => m.competitionId === id);
    filters.push(competitionName(id));
  }
  if (input.date) {
    list = list.filter((m) => m.date === input.date);
    filters.push(input.date);
  }
  const picked = list[0];
  if (!picked) {
    return {
      ok: false,
      message: [
        filters.length > 0
          ? `${filters.join(" · ")} 조건에 맞는 예정 경기를 찾지 못했습니다`
          : "예정된 우리 경기가 없습니다",
        "예정 경기:",
        ...previewCandidates(state),
      ].join("\n"),
    };
  }
  return { ok: true, matchId: picked.id };
}

/**
 * 경기 전 상대 분석 (`get_opponent_report`) — 예정된 우리 경기 하나
 * (→ docs/simulation/match.md §1.8).
 *
 * **예상 XI에 능력치는 서지 않는다.** 이름과 자리뿐이고, 그 열한 명을 대조해 나온
 * 수치는 이미 감독의 눈(`readKeyPoints`)을 지나 아래 지점 줄에 있다. 여기에 OVR을
 * 얹으면 안개를 지나지 않은 값이 명단표로 새어 나온다 (player.md §10).
 */
export function opponentReport(state: GameState, input: OpponentReportInput = {}): LookupResult {
  const picked = pickUpcomingMatch(state, input);
  if (!picked.ok) return picked;
  const report = buildOpponentReport(state, { matchId: picked.matchId });
  if (!report) {
    return {
      ok: false,
      message:
        state.pendingMatch !== null
          ? "경기 중에는 다음 상대의 분석을 세우지 않습니다 — 지금 판은 판세 화면이 들고 있습니다"
          : `${picked.matchId} 경기의 상대 분석을 세우지 못했습니다 (배치·전술을 읽지 못했습니다)`,
    };
  }

  const venue = VENUE_KO[report.venue];
  const when = report.inDays === 0 ? "오늘" : `D-${report.inDays}`;
  const lines: string[] = [
    `[상대 분석] ${dateLabel(report.date)} ${report.time} (${when}) ` +
      `${report.label} · ${venue} vs ${report.opponent.name}`,
  ];

  /**
   * 근거가 없으면 **열한 명이 다 추정이다** — 그때 이름마다 `?`를 붙이는 것은
   * 머리줄이 이미 한 말의 되풀이다. 표시는 관측과 추정이 섞였을 때만 뜻을 갖는다.
   */
  const guessed = report.basis === null ? 0 : report.expectedXI.filter((p) => !p.carried).length;
  const basis =
    report.basis === null
      ? "직전 경기가 없다 — 배치에서 세운 추정이다"
      : `직전 ${dateLabel(report.basis.date)} ${report.basis.label} 선발에서 투영` +
        (guessed > 0 ? ` · ?는 추정으로 메운 ${guessed}자리` : "");
  lines.push(
    `예상 XI (${basis}):`,
    "  " +
      report.expectedXI
        .map((p) => `${p.name}(${p.position})${guessed > 0 && !p.carried ? "?" : ""}`)
        .join(" · "),
  );

  lines.push(
    report.absent.length === 0
      ? "결장: 없다"
      : "결장: " +
          report.absent
            .map((a) => `${a.name}(${a.position}) ${ABSENT_REASON_KO[a.reason]}(${a.note})`)
            .join(" · "),
  );

  lines.push(`상대 전술: ${tacticsBrief(report.shape)}`);

  if (report.notes.length === 0) {
    lines.push("읽어 낸 지점: 없다 — 두 판이 맞물리는 곳이 보이지 않는다");
  } else {
    lines.push("읽어 낸 지점:");
    lines.push(
      ...report.notes.map((tag) => {
        const side =
          tag.favours === null ? "  · " : tag.favours === report.ourSide ? "  + " : "  - ";
        return side + packetTagText(tag, report.tagContext);
      }),
    );
  }

  lines.push("※ 예상 XI는 직전 경기 선발에서 투영한 것이다 — 상대가 로테이션을 돌리면 갈린다");
  return { ok: true, message: lines.join("\n") };
}
