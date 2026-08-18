import type { GamePlayer, MatchRecord, ScheduleEntry, SeasonRecord } from "@story-fm/domain";
import {
  YELLOWS_PER_SUSPENSION,
  ageOf,
  anchorOf,
  conditionLabel,
  footLabel,
  physiqueLabel,
  naturalPositionOf,
  roleFit,
  rolesFor,
  seasonRating,
  slotOfTime,
} from "@story-fm/domain";
import { rankByName } from "../core/name-match";
import { addDays, dayOfWeek, diffDays, seasonYear, squadReturnOf } from "../competition/calendar";
import { entrantsOf } from "../competition/europe";
import { formLabel } from "../squad/form";
import { INJURY_SEVERITY_KO } from "../squad/injury";
import { moodAnchor, moodOf } from "../squad/mood";
import {
  isHomegrownFor,
  occupiesSquadList,
  registrationLine,
  squadRegistrationOf,
} from "../squad/registration";
import {
  cupCatalog,
  competitionLabel,
  competitionName,
  competitionShortName,
  isCup,
} from "../data/cup-catalog";
import {
  domesticCupCatalog,
  DOMESTIC_STAGES,
  domesticStageLabel,
  isDomesticCup,
} from "../data/domestic-cup-catalog";
import { marketLeagues, topLeagues } from "../data/league-catalog";
import { domesticCupEntrants, domesticStageMatches } from "../competition/domestic-cup";
import { drawParts, drawTitle } from "../competition/draw-schedule";
import { isClubTeam, teamCatalog } from "../data/team-catalog";
import { leagueOfTeamIn, teamsOfLeagueIn } from "../competition/promotion";
import { tierOfTeamIn } from "../core/club-tier";
import { computeStandings } from "../competition/season";
import { USER_WARNINGS_BEFORE_SACK } from "../market/manager-market";
import {
  attributeLine,
  knowledgeNote,
  knowledgeOf,
  observationOf,
  observedOverall,
  overallView,
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
  openInjury,
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

const money = (v: number) => `£${Math.round(v / 1000)}k`;

// ── 이름 해석 (팀·대회) ─────────────────────────────────
//
// 감독은 카탈로그 표기를 모른다 — "맨유", "레알", "챔스"로 말한다. 해석을 도구
// 입구에 두면 모델이 id를 외우거나 추측하지 않아도 되고, 못 찾았을 때 후보를
// 돌려줄 수 있다 (조용히 빈 결과를 주면 모델이 지어내기 시작한다).

/** 표기 흔들림 흡수 — 공백·중점·하이픈 제거 + 소문자 */
const norm = (q: string) => q.replace(/[\s·・\-_.]/g, "").toLowerCase();

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

const COMPETITION_ALIASES: Record<string, string> = {
  챔스: "ucl",
  챔피언스: "ucl",
  유로파: "uel",
  컨퍼런스: "uecl",
  프리미어: "epl",
  epl: "epl",
  // 국내 컵 — 감독이 실제로 부르는 이름들
  fa컵: "facup",
  fa: "facup",
  에미레이츠컵: "facup",
  리그컵: "eflcup",
  카라바오: "eflcup",
  카라바오컵: "eflcup",
  efl컵: "eflcup",
  국왕컵: "copadelrey",
  코파: "copadelrey",
  포칼: "dfbpokal",
  dfb: "dfbpokal",
  쿠프: "coupedefrance",
};

/**
 * 대회 이름·약어·id → 대회 id. 못 찾으면 null.
 * 나라 이름은 그 나라 **1부 리그**로 해석한다 (2부는 리그전이 없어 물어볼 게 없다).
 */
function resolveCompetitionId(competition: string): string | null {
  const key = norm(competition);
  if (key === "") return null;
  const alias = COMPETITION_ALIASES[key];
  if (alias) return alias;
  const pool = [
    ...topLeagues().map((l) => ({ id: l.id, name: l.name, short: l.name, country: l.country })),
    // 이적 시장 전용 리그 — 경기는 없지만 **선수를 찾을 수는 있어야 한다**.
    // 여기 없으면 "사우디에 누가 있지?"에 모델이 답할 방법이 없어 지어낸다
    ...marketLeagues().map((l) => ({ id: l.id, name: l.name, short: l.name, country: l.country })),
    ...cupCatalog().map((c) => ({ id: c.id, name: c.name, short: c.short, country: "" })),
    ...domesticCupCatalog().map((c) => ({ id: c.id, name: c.name, short: c.short, country: "" })),
  ];
  const exact = pool.find(
    (c) => c.id === key || norm(c.short) === key || norm(c.name) === key || norm(c.country) === key,
  );
  if (exact) return exact.id;
  const partial = pool.filter((c) => norm(c.name).includes(key));
  return partial.length === 1 ? partial[0]!.id : null;
}

/** 대회 id 힌트 — 카탈로그가 편집될 수 있으므로 부를 때 만든다 */
const competitionHint = () =>
  `리그(${topLeagues()
    .map((l) => l.id)
    .join("·")}) · 이적 시장 전용(${marketLeagues()
    .map((l) => l.id)
    .join("·")}) · 대항전(${cupCatalog()
    .map((c) => c.id)
    .join("·")}) · 국내 컵(${domesticCupCatalog()
    .map((c) => c.id)
    .join("·")})`;

/** 우리 팀 선수 한 줄 — 정확 수치 (오피스 뷰가 이미 보여주는 정보) */
function ourRow(state: GameState, p: GamePlayer): string {
  const assignment = assignmentFor(state, p.id);
  const contract = activeContract(state, p.id);
  const stat = seasonStatOf(state, p.id);
  const injury = openInjury(state, p.id);
  const suspension = activeSuspension(state, p.id);
  const role =
    squadLevelOf(p) === "reserve"
      ? "[2군]"
      : assignment
        ? `[${assignment.role === "starting" ? "선발" : "벤치"}:${assignment.position}]`
        : "[1군]";
  const status = injury
    ? ` 부상(${injury.bodyPart}, ~${injury.expectedReturn})`
    : suspension
      ? ` 정지(${suspension.lengthMatches - suspension.served}경기)`
      : "";
  const issue = state.issues.some((i) => i.gamePlayerId === p.id) ? " ⚠불만" : "";
  return (
    `${p.id} ${p.name} ${ageOf(p.birthdate, state.date)}세 ${naturalPositionOf(p).position} ` +
    `${physiqueLabel(p.height, p.weight)}(${footLabel(p.foot)}) ` +
    `OVR${p.attributes.overall} 폼 ${formLabel(p.state.form)} ` +
    `체력${p.state.condition} 적응${familiarityOf(state, p.id)} ${money(contract?.weeklyWage ?? 0)} ` +
    `${role} ${statLine(stat)}${status}${issue}${p.isCaptain ? " (주장)" : ""}` +
    `${isHomegrownFor(p, p.teamId) ? " [홈그로운]" : ""}${occupiesSquadList(state, p) ? "" : " [U21·명단 밖]"}`
  );
}

/** 시즌 기록 축약 — 출전/득점/도움, 평점은 출전이 있을 때만 */
function statLine(
  stat: { apps: number; goals: number; assists?: number; ratingSum?: number } | null,
): string {
  const rating = seasonRating(stat);
  return (
    `출전${stat?.apps ?? 0}/득점${stat?.goals ?? 0}/도움${stat?.assists ?? 0}` +
    (rating === null ? "" : `/평점${rating.toFixed(2)}`)
  );
}

/** 타 팀 선수 한 줄 — 안개 적용, 숫자 없음 */
function theirRow(state: GameState, p: GamePlayer): string {
  const stat = seasonStatOf(state, p.id);
  const knowledge = knowledgeOf(state, p.id);
  const source = knowledge === "scouted" ? "스카우팅" : knowledge === "seen" ? "직접 관전" : "평판";
  const injury = openInjury(state, p.id);
  return (
    `${p.id} ${p.name} ${ageOf(p.birthdate, state.date)}세 ${naturalPositionOf(p).position} ` +
    `${teamShortNameIn(state, p.teamId)} · ${overallView(state, p)} (${source}) · ` +
    `${statLine(stat)}${injury ? ` · 부상 중(~${injury.expectedReturn})` : ""}`
  );
}

export function playerRow(state: GameState, p: GamePlayer): string {
  return p.teamId === state.userTeamId ? ourRow(state, p) : theirRow(state, p);
}

/**
 * **줄 세우는 값도 노출이다** (player.md §10) — 행이 라벨만 보여도 참값으로 세운
 * 순서는 그 값을 그대로 말한다. 정렬 키는 그 행이 찍는 관측값과 같아야 한다.
 */
function sortRating(state: GameState, p: GamePlayer): number {
  return observedOverall(p.attributes.overall, observationOf(state, p.id));
}

/** 체력은 지식 5단계가 아니라 §9.2의 채널 — 우리 선수는 아침에 쟀고, 타 팀은 읽는다 */
function sortCondition(state: GameState, p: GamePlayer): number {
  return p.teamId === state.userTeamId
    ? p.state.condition
    : readCondition(state, p.id, p.state.condition).value;
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
  sortBy?: "rating" | "age" | "fatigue" | "goals" | "apps" | "wage";
  limit?: number;
}

export function searchPlayers(state: GameState, input: SearchPlayersInput): LookupResult {
  let teamId: string | null = null;
  if (input.team) {
    const team = resolveTeam(state, input.team);
    if (!team.ok) return team;
    teamId = team.teamId;
  }

  let competitionId: string | null = null;
  let inCompetition: Set<string> | null = null;
  if (input.competition) {
    competitionId = resolveCompetitionId(input.competition);
    if (!competitionId) {
      return {
        ok: false,
        message: `"${input.competition}"라는 대회를 찾지 못했습니다 — ${competitionHint()}`,
      };
    }
    inCompetition = new Set(
      isDomesticCup(competitionId)
        ? domesticCupEntrants(competitionId)
        : isCup(competitionId)
          ? entrantsOf(state.euroEntrants, competitionId)
          : teamsOfLeagueIn(state, competitionId),
    );
  }

  const position = input.position?.toUpperCase();
  const narrowed = (teamId ? playersOf(state, teamId) : state.players).filter((p) => {
    if (inCompetition && !inCompetition.has(p.teamId)) return false;
    if (input.squadLevel && squadLevelOf(p) !== input.squadLevel) return false;
    if (position && !p.positions.some((x) => x.position === position)) return false;
    const age = ageOf(p.birthdate, state.date);
    if (input.minAge !== undefined && age < input.minAge) return false;
    if (input.maxAge !== undefined && age > input.maxAge) return false;
    if (input.availableOnly && !isAvailable(state, p.id)) return false;
    return true;
  });
  // 이름은 마지막에 — 다른 조건으로 좁힌 만큼만 자모까지 내려가면 된다
  const pool = input.name ? rankByName(input.name, narrowed).matches : narrowed;

  const sortBy = input.sortBy ?? "rating";
  // 안개 키는 지식 수준 파생이라 비싸다 — 풀당 한 번만 뽑고 비교는 그 값으로 한다
  const fogged =
    sortBy === "rating" || sortBy === "fatigue"
      ? new Map(
          pool.map(
            (p) =>
              [p.id, sortBy === "rating" ? sortRating(state, p) : sortCondition(state, p)] as const,
          ),
        )
      : null;
  const fog = (p: GamePlayer) => fogged?.get(p.id) ?? 0;
  const sorted = [...pool].sort((a, b) => {
    switch (sortBy) {
      case "age":
        return ageOf(a.birthdate, state.date) - ageOf(b.birthdate, state.date);
      case "fatigue":
        // 지친 순 — 체력이 낮은 쪽이 앞
        return fog(a) - fog(b);
      case "goals":
        return (seasonStatOf(state, b.id)?.goals ?? 0) - (seasonStatOf(state, a.id)?.goals ?? 0);
      case "apps":
        return (seasonStatOf(state, b.id)?.apps ?? 0) - (seasonStatOf(state, a.id)?.apps ?? 0);
      case "wage":
        return (
          (activeContract(state, b.id)?.weeklyWage ?? 0) -
          (activeContract(state, a.id)?.weeklyWage ?? 0)
        );
      default:
        return fog(b) - fog(a);
    }
  });

  // 무엇을 뒤졌는지 밝힌다 — 풀을 모르면 "리그 득점왕"이라는 답이 조용히 어긋난다
  const scope =
    [
      teamId ? teamNameIn(state, teamId) : null,
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

const CAUSE_KO: Record<string, string> = { match: "경기", training: "훈련", other: "기타" };
const TRANSFER_KO: Record<string, string> = {
  transfer: "이적",
  loan: "임대",
  free: "자유계약",
  youth: "유스 승격",
  retire: "은퇴",
};

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
        (t.fee > 0 ? ` £${(t.fee / 1e6).toFixed(1)}M` : ""),
    );
  if (moves.length > 0) lines.push(`이동 이력: ${moves.join(" / ")}`);

  return lines;
}

/**
 * GM이 읽는 심경 한 줄 — 결산이 다시 쓴 문장이 있으면 그것, 없으면 **사실 줄**.
 * 코어가 GM에게 넘기는 것은 사실뿐이다 (overview.md §1 철칙 4).
 */
function moodLine(state: GameState, player: GamePlayer): string {
  return moodOf(state, player).note ?? moodAnchor(state, player);
}

/**
 * 그 시즌의 보드 평가 — 등급과 근거 수치. 옛 세이브는 평가 문장을 들고 있어
 * 그것이 폴백이다 (career.md §6).
 */
function boardLine(record: SeasonRecord): string {
  if (record.board) {
    const met = record.board.grade === "met";
    return ` — 보드 기대 ${record.board.target}위(${record.board.expectation}) · ${met ? "달성" : "미달"}`;
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
      `주포지션 ${naturalPositionOf(p).position} (${groupOf(p)}) · id ${p.id}`,
    knowledgeNote(state, p.id),
    `능력치: ${attributeLine(state, p)}`,
    `종합: ${overallView(state, p)} · 잠재력: ${potentialView(state, p)}`,
  ];

  if (knowledge === "own") {
    lines.push(
      `컨디션: 폼 ${formLabel(p.state.form)} · 체력 ${p.state.condition} (${conditionLabel(p.state.condition)})`,
      `심경: ${moodLine(state, p)}`,
      `소화 포지션: ${p.positions
        .map((x) => `${x.position}${x.isNatural ? "*" : ""}${x.proficiency}`)
        .join(" / ")}`,
    );
    const assignment = assignmentFor(state, p.id);
    lines.push(
      assignment
        ? `전술: ${assignment.role === "starting" ? "선발" : "벤치"} ${assignment.position}` +
            ` (${roleLabel(assignment.position, assignment.roleId)})` +
            ` · 전술적응 ${assignment.familiarity}` +
            (assignment.instruction ? ` · 개인지시 "${assignment.instruction}"` : "")
        : "전술: 배치 없음 (예비 스쿼드)",
    );
    const growth = state.growthLog
      .filter((g) => g.gamePlayerId === p.id)
      .slice(-5)
      .map((g) => `${g.date} ${g.target} ${g.delta > 0 ? "+" : ""}${g.delta}`);
    if (growth.length > 0) lines.push(`최근 성장: ${growth.join(" / ")}`);
  } else {
    const { strengths, weaknesses } = strengthsAndWeaknesses(state, p);
    lines.push(`인상: 강점 ${strengths.join("·")} / 약점 ${weaknesses.join("·")}`);
  }

  lines.push(
    `시즌 기록: ${stat?.apps ?? 0}경기 ${stat?.goals ?? 0}골 ${stat?.assists ?? 0}도움` +
      (seasonRating(stat) === null ? "" : ` · 평점 ${seasonRating(stat)!.toFixed(2)}`),
    contract
      ? `계약: 주급 ${money(contract.weeklyWage)} · 만료 ${contract.until}`
      : "계약: 정보 없음",
  );
  if (injury) {
    lines.push(
      `부상: ${injury.bodyPart} (${INJURY_SEVERITY_KO[injury.severity]}) — 복귀 예상 ${injury.expectedReturn}`,
    );
  }
  if (suspension) {
    lines.push(`징계: 출장 정지 ${suspension.lengthMatches - suspension.served}경기 남음`);
  }
  lines.push(...historyLines(state, p));
  return { ok: true, message: lines.join("\n") };
}

// ── 스쿼드·배치 (우리 팀 전용) ──────────────────────────

export interface SquadViewInput {
  /** 1군 / 2군 / 전체 — 기본 1군 (2군 18명까지 매번 읽을 이유가 없다) */
  level?: "first" | "reserve" | "all";
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
  const flags = [
    injury ? `부상(${injury.bodyPart}, ~${injury.expectedReturn})` : null,
    suspension ? `정지 ${suspension.lengthMatches - suspension.served}경기` : null,
    yellows >= YELLOWS_PER_SUSPENSION - 1 ? `경고 ${yellows}장(정지 임박)` : null,
    state.issues.some((i) => i.gamePlayerId === p.id) ? "불만" : null,
  ].filter((x): x is string => x !== null);
  return (
    `  ${position.padEnd(4)} ${p.name}${p.isCaptain ? "(주장)" : ""} (${p.id}) ${ageOf(p.birthdate, state.date)}세 · ` +
    `${roleLabel(position, roleId)} · OVR${p.attributes.overall} 자리적합${roleFit(p.attributes, position, roleId)} 포지션적응${proficiencyAt(p, position)} ` +
    `전술적응${familiarity} · 폼 ${formLabel(p.state.form)} 체력${p.state.condition}` +
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
export function squadView(state: GameState, input: SquadViewInput = {}): LookupResult {
  const teamId = state.userTeamId;
  const tactics = tacticsOf(state, teamId);
  const squad = playersOf(state, teamId);
  const level = input.level ?? "first";
  const assignments = new Map(tactics.assignments.map((a) => [a.playerId, a]));

  const inLevel = squad.filter((p) =>
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
      `선발 평균 적응 ${Math.round(squadFamiliarity(state, teamId))}`,
    `1군 ${firstCount}명 (선발 ${tactics.assignments.filter((a) => a.role === "starting").length} · ` +
      `벤치 ${tactics.assignments.filter((a) => a.role === "bench").length}) · ` +
      `2군 ${squad.length - firstCount}명 · 조회 대상: ${
        level === "all" ? "전체" : level === "reserve" ? "2군" : "1군"
      }`,
    // 등록 명단 — 영입·승격 판단의 전제라 스쿼드를 볼 때 항상 함께 읽힌다
    registrationLine(squadRegistrationOf(state, teamId)),
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
  if (shown === 0) {
    lines.push("조건에 맞는 선수가 없습니다 (level·role을 확인하라)");
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

  // 날짜순 정렬 — state.matches는 리그 뒤에 대항전이 붙은 순서라 그대로 자르면 섞인다
  const byDate = [...state.matches].sort((a, b) => (a.date < b.date ? -1 : 1));
  const recent = byDate
    .filter((m) => m.result && (m.homeTeamId === teamId || m.awayTeamId === teamId))
    .slice(-5)
    .map((m) => {
      const home = m.homeTeamId === teamId;
      const my = home ? m.result!.homeGoals : m.result!.awayGoals;
      const their = home ? m.result!.awayGoals : m.result!.homeGoals;
      return (
        `${competitionTag(m)} ${my}-${their} vs ${teamShortNameIn(state, home ? m.awayTeamId : m.homeTeamId)} ` +
        markOf(m, teamId)
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
    const mark = markOf(m, state.userTeamId);
    if (mark === "승") w++;
    else if (mark === "패") l++;
    else d++;
  }

  const keyPlayers = tactics.assignments
    .filter((a) => a.role === "starting")
    .map((a) => playerById(state, a.playerId))
    .filter((p): p is GamePlayer => p !== null)
    .sort((a, b) => sortRating(state, b) - sortRating(state, a))
    .slice(0, 6);

  const lines = [
    `[팀 프로필] ${teamNameIn(state, teamId)} — ${competitionName(leagueOfTeamIn(state, teamId))} ` +
      (row && row.played > 0
        ? `${rank || "?"}위 (${row.played}경기 ${row.wins}승 ${row.draws}무 ${row.losses}패 · 승점 ${row.points} · 득실 ${row.goalDiff >= 0 ? "+" : ""}${row.goalDiff})`
        : "순위 미정 (아직 경기 없음)"),
    `전술: ${tactics.spec.formation} · 멘탈리티${tactics.spec.mentality} 압박${tactics.spec.pressing} 템포${tactics.spec.tempo} 패스${tactics.spec.passStyle}`,
    `스쿼드: ${squad.length}명 · 평균 ${avgAge.toFixed(1)}세 · 구단 등급 ${tierOfTeamIn(state, teamId)}`,
    recent.length > 0 ? `최근 5경기: ${recent.join(" / ")}` : "최근 경기 없음",
  ];
  if (teamId !== state.userTeamId) {
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

/** "2026-27 시즌 (시즌 1)" — 날짜를 묻는 답에 시즌 번호만 주면 연도를 지어내게 된다 */
function seasonLabel(state: GameState): string {
  const year = seasonYear(state.season);
  return `${year}-${String((year + 1) % 100).padStart(2, "0")} 시즌 (시즌 ${state.season})`;
}

/** 대회·단계 태그 — "EPL R7", "UCL 8강 1차전", "친선" */
function competitionTag(m: MatchRecord): string {
  return competitionLabel(m.competitionId, m.stage ?? "league", m.round);
}

/** 기준 팀 시점의 승패 — 정규시간이 같으면 승부차기로 갈린다 */
function markOf(m: MatchRecord, teamId: string): "승" | "무" | "패" {
  const result = m.result!;
  const home = m.homeTeamId === teamId;
  const mine = home ? result.homeGoals : result.awayGoals;
  const theirs = home ? result.awayGoals : result.homeGoals;
  if (mine !== theirs) return mine > theirs ? "승" : "패";
  if (!result.penalties) return "무";
  const minePen = home ? result.penalties.home : result.penalties.away;
  const theirPen = home ? result.penalties.away : result.penalties.home;
  return minePen === theirPen ? "무" : minePen > theirPen ? "승" : "패";
}

function scorerNote(state: GameState, m: MatchRecord): string {
  const scorers = m.result?.scorers ?? [];
  if (scorers.length === 0) return "";
  const minutes = m.result?.goalMinutes ?? [];
  const named = scorers.map((entry, i) => {
    const [side, id] = entry.includes(":")
      ? (entry.split(":", 2) as [string, string])
      : ["", entry];
    const team = side === "home" ? m.homeTeamId : side === "away" ? m.awayTeamId : null;
    const at = minutes[i] !== undefined ? ` ${minutes[i]}′` : "";
    return `${playerName(state, id ?? entry)}${at}${team ? `(${teamShortNameIn(state, team)})` : ""}`;
  });
  return ` · 득점 ${named.join(", ")}`;
}

/**
 * 경기 한 줄. `teamId`가 있으면 그 팀 시점(홈/원정·승패), null이면 중립 서술.
 * `detail`이면 득점자까지 — 결과를 묻는 질문엔 스코어만으론 부족하다.
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
  const mark = teamId === null ? "" : ` ${markOf(m, teamId)}`;
  return `  지난 ${when} ${tag}${side} ${score}${mark}${detail ? scorerNote(state, m) : ""}`;
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
    .map((m) => markOf(m, teamId))
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
      `[${competitionName(cupId)} 대진] ${seasonLabel(state)} · ${state.date}`,
      ...lines,
    ].join("\n"),
  };
}

function standingsView(state: GameState, input: LeagueViewInput): LookupResult {
  let competitionId = leagueOfTeamIn(state, state.userTeamId);
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
    // 팀을 주면 그 팀이 속한 리그의 순위표를 본다
    const team = resolveTeam(state, input.team);
    if (!team.ok) return team;
    competitionId = leagueOfTeamIn(state, team.teamId);
  }

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
    message: [`${title} ${seasonLabel(state)} · ${state.date}`, ...rows].join("\n"),
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

  const pool = state.matches
    .filter((m) => {
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
    ` — 오늘 ${dateLabel(state.date)} · ${seasonLabel(state)}`;

  const lines: string[] = [head];

  if (opponentId && teamId) {
    if (played.length === 0) {
      lines.push(`이번 시즌 맞대결 기록 없음 (지난 시즌 결과는 장부에 남지 않는다)`);
    } else {
      let w = 0;
      let d = 0;
      let l = 0;
      let scored = 0;
      let conceded = 0;
      for (const m of played) {
        const mark = markOf(m, teamId);
        if (mark === "승") w++;
        else if (mark === "패") l++;
        else d++;
        const home = m.homeTeamId === teamId;
        scored += home ? m.result!.homeGoals : m.result!.awayGoals;
        conceded += home ? m.result!.awayGoals : m.result!.homeGoals;
      }
      lines.push(
        `이번 시즌 맞대결 ${played.length}경기 — ${w}승 ${d}무 ${l}패 (득 ${scored} · 실 ${conceded})` +
          ` ※ 지난 시즌 결과는 장부에 남지 않는다`,
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
  if (shown.length === 0) {
    lines.push("이 기간에 등록된 일정이 없습니다");
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
        ? ` — ${m.result.homeGoals}-${m.result.awayGoals} ${markOf(m, state.userTeamId)}`
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
  return { ok: true, message: lines.join("\n") };
}

// ── 감독 커리어 (지난 시즌·트로피·업적) ─────────────────

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

  const lines = [
    `[커리어] ${m.name} — ${teamNameIn(state, state.userTeamId)} 재임 · ${seasonLabel(state)}`,
    `평판: 보드${m.reputation.board} 미디어${m.reputation.media} 선수단${m.reputation.squad}`,
    warnings > 0
      ? `보드 경고: ${warnings}/${USER_WARNINGS_BEFORE_SACK}회` +
        (m.lastWarnedOn ? ` (마지막 ${m.lastWarnedOn})` : "") +
        ` — ${USER_WARNINGS_BEFORE_SACK}회째에 자리가 없어진다`
      : `보드 경고: 없음 (${USER_WARNINGS_BEFORE_SACK}회째에 자리가 없어진다)`,
    row && row.played > 0
      ? `이번 시즌 진행: ${competitionName(league)} ${rank}위 · ${row.played}경기 ${row.wins}승 ${row.draws}무 ${row.losses}패 · 승점 ${row.points} (득실 ${row.goalDiff >= 0 ? "+" : ""}${row.goalDiff})`
      : `이번 시즌 진행: 아직 리그 경기 없음`,
  ];

  const records = [...state.seasonRecords].sort((a, b) => b.season - a.season);
  if (records.length === 0) {
    lines.push("지난 시즌 기록: 없음 (첫 시즌이다)");
  } else {
    lines.push(`지난 시즌 기록 ${records.length}시즌:`);
    for (const r of records.slice(0, 10)) {
      const year = seasonYear(r.season);
      lines.push(
        `  시즌 ${r.season} (${year}-${String((year + 1) % 100).padStart(2, "0")}) ${teamNameIn(state, r.teamId)} ` +
          `${r.position}위 · ${r.wins}승 ${r.draws}무 ${r.losses}패 · 득 ${r.goalsFor} 실 ${r.goalsAgainst}` +
          boardLine(r),
      );
    }
    if (records.length > 10) lines.push(`  …그 외 ${records.length - 10}시즌`);
  }

  lines.push(
    state.trophies.length > 0
      ? // TROPHY.competition은 id가 아니라 **표시 이름**으로 기록된다 (season.ts)
        `트로피 ${state.trophies.length}개: ${state.trophies
          .map((t) => `${t.competition} (시즌 ${t.season}, ${teamShortNameIn(state, t.teamId)})`)
          .join(" / ")}`
      : "트로피: 없음",
  );
  if (state.achievements.length > 0) {
    lines.push(
      `업적 ${state.achievements.length}개: ${state.achievements
        .map((a) => `${a.name}(시즌 ${a.season})`)
        .join(" / ")}`,
    );
  }
  return { ok: true, message: lines.join("\n") };
}
