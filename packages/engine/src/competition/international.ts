import type { CallUp, CallUpReturnState, GamePlayer, PositionGroup } from "@story-fm/domain";
import {
  ageOf,
  capsOf,
  clampCondition,
  clampFatigue,
  clampSharpness,
  fatigueOf,
  internationalGoalsOf,
  isAssociation,
  sharpnessOf,
} from "@story-fm/domain";
import { fatigueFromMinutes, sharpnessAfterMinutes } from "@story-fm/sim";
import { addDays, diffDays, INTERNATIONAL_BREAKS, seasonYear } from "./calendar";
import { makeRng } from "../core/rng";
import { groupOf, isInjured, openInjury, type GameState } from "../core/state";
import { INJURY_CHANCE_PER_APPEARANCE, openInjuryFor, pronenessValue } from "../squad/injury";

/**
 * **대표팀 소집 — 휴식기는 빈 주말이 아니라 사건이다**
 * (→ [docs/data/competition.md](../../../../docs/data/competition.md) §5-1).
 *
 * A매치는 굴리지 않는다. 세계가 그 경기를 관측할 이유가 없기 때문이다 — 남는 것은
 * 「3경기 2골」이라는 사실 한 줄과 돌아온 몸이고, 그 둘은 결정적 추첨으로 충분하다.
 * 경기를 굴리면 5,700명을 나라별로 세우고 90분을 네 번 돌려야 하는데, 그 비용이
 * 사는 것은 이미 갖고 있는 두 개의 수뿐이다.
 *
 * 이 파일이 갖는 것은 넷이다 — 창(언제), 서열(누가), 추첨(무엇이 있었나),
 * 정산(어떤 몸으로 돌아오나). 문장은 하나도 쓰지 않는다.
 */

// ── 창 ────────────────────────────────────────────────

export interface InternationalBreak {
  /** `<시즌>:<MMDD>` — 세이브 안에서 이 창을 가리키는 유일한 키 */
  key: string;
  label: string;
  /** 소집일 (창의 첫날) */
  from: string;
  /** 복귀 정산일 (창의 마지막 날) */
  to: string;
}

/** `MMDD` 한 수 → 그 시즌의 ISO 날짜. 7월 이후는 시즌 연도, 그 앞은 이듬해다 */
function dateOfMd(season: number, md: number): string {
  const month = Math.floor(md / 100);
  const day = md % 100;
  const year = seasonYear(season) + (month >= 7 ? 0 : 1);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** 이 시즌의 A매치 휴식기 넷 — 날짜가 붙은 창 (달력의 `INTERNATIONAL_BREAKS`에서 파생) */
export function internationalBreaksOf(season: number): InternationalBreak[] {
  return INTERNATIONAL_BREAKS.map((w) => ({
    key: `${season}:${String(w.from).padStart(4, "0")}`,
    label: w.label,
    from: dateOfMd(season, w.from),
    to: dateOfMd(season, w.to),
  }));
}

/** 오늘 소집이 서는 창 — 창의 **첫날**에만 답한다 */
export function breakStartingOn(season: number, date: string): InternationalBreak | null {
  return internationalBreaksOf(season).find((w) => w.from === date) ?? null;
}

/** 오늘 복귀 정산이 서는 창 — 창의 **마지막 날**에만 답한다 */
export function breakEndingOn(season: number, date: string): InternationalBreak | null {
  return internationalBreaksOf(season).find((w) => w.to === date) ?? null;
}

// ── 서열 ──────────────────────────────────────────────

/** 한 나라가 대표팀을 세우는 데 필요한 인원 — 이만큼 없으면 그 나라는 소집이 없다 */
export const CALL_UP_SQUAD_SIZE = 23;

/**
 * 자리 정원 — 합이 `CALL_UP_SQUAD_SIZE`다.
 *
 * 정원이 없으면 미드필더 스물셋을 부르는 나라가 생기고, 그러면 「수비수가 통째로
 * 빠졌다」는 사실이 감독에게 영영 오지 않는다.
 */
const SQUAD_QUOTA: Record<PositionGroup, number> = { GK: 3, DF: 8, MF: 7, FW: 5 };

/** 전성기 — 소집 서열의 나이 항이 여기서 멀어질수록 깎인다 */
const PEAK_AGE = 27;
/** 전성기에서 한 살 멀어질 때마다 깎이는 점수 */
const AGE_WEIGHT = 0.25;
/** 클럽 출전이 만점에 닿는 경기 수 — 이만큼 뛰면 「주전」이다 */
const APPS_FULL = 10;
/** 클럽에서 못 뛰는 선수가 잃는 폭 — 대표팀 감독이 가장 먼저 보는 사실이다 */
const APPS_WEIGHT = 4;
/** 폼(−1 ‥ +1)이 서열에 얹는 폭 */
const FORM_WEIGHT = 2;

/**
 * 소집 점수 — **주사위가 없다.** 같은 세이브·같은 날이면 언제나 같은 명단이다
 * (competition.md §5-1). 종합은 참값을 쓴다: 대표팀 감독은 세계의 눈이지 우리
 * 스카우트가 아니라, 안개는 이 자리의 사실이 아니다.
 */
export function callUpScore(state: GameState, player: GamePlayer, apps: number): number {
  const age = ageOf(player.birthdate, state.date);
  return (
    player.attributes.overall -
    AGE_WEIGHT * Math.abs(age - PEAK_AGE) +
    APPS_WEIGHT * Math.min(1, apps / APPS_FULL) +
    FORM_WEIGHT * player.state.form
  );
}

/**
 * 이번 시즌 출전 수 — 선수 id → 경기 수. **한 번만 훑는다.**
 *
 * `seasonStatOf`를 선수마다 부르면 그 안의 `playerById`가 5,700명을 매번 다시
 * 훑는다 — 나라 스물여섯 × 후보 수백이면 그것만으로 tick 하루가 무거워진다.
 * 시즌 중 이적한 선수는 팀별로 행이 갈리므로 합쳐서 센다.
 */
function appsIndexOf(state: GameState): Map<string, number> {
  const out = new Map<string, number>();
  for (const stat of state.seasonStats) {
    if (stat.season !== state.season) continue;
    out.set(stat.gamePlayerId, (out.get(stat.gamePlayerId) ?? 0) + stat.apps);
  }
  return out;
}

/**
 * **이 세계의 오늘 소집 명단 전부** — 협회 코드 → 서열대로 세운 23인.
 *
 * 소집·여름 대회·통산 시드가 전부 이 하나를 읽는다. 나라별로 따로 세우면 선수
 * 5,700명을 나라 수만큼 다시 훑게 되므로, 국적으로 한 번 나누고 그 안에서만 센다.
 * 정원(`SQUAD_QUOTA`)을 먼저 채우고 남는 자리를 점수 순으로 준다.
 */
export function callUpBoard(state: GameState): Map<string, GamePlayer[]> {
  const apps = appsIndexOf(state);
  const pools = new Map<string, Array<{ player: GamePlayer; score: number }>>();
  for (const player of state.players) {
    const code = player.nationality;
    if (code === undefined || !isAssociation(code)) continue;
    // 재활 중인 선수는 부르지 않는다
    if (isInjured(state, player.id)) continue;
    const pool = pools.get(code);
    const row = { player, score: callUpScore(state, player, apps.get(player.id) ?? 0) };
    if (pool) pool.push(row);
    else pools.set(code, [row]);
  }

  const board = new Map<string, GamePlayer[]>();
  for (const [code, pool] of pools) {
    if (pool.length < CALL_UP_SQUAD_SIZE) continue;
    // 동점은 id 사전순 — 명단 배열 순서를 읽으면 같은 세이브가 다른 명단을 낸다
    pool.sort((a, b) =>
      a.score === b.score ? (a.player.id < b.player.id ? -1 : 1) : b.score - a.score,
    );
    board.set(code, pickSquad(pool));
  }
  return board;
}

/** 점수 순으로 세운 후보에서 23인 — 정원을 먼저, 남는 자리는 점수 순으로 */
function pickSquad(ranked: ReadonlyArray<{ player: GamePlayer; score: number }>): GamePlayer[] {
  const taken = new Set<string>();
  const filled: Record<PositionGroup, number> = { GK: 0, DF: 0, MF: 0, FW: 0 };
  const picked: Array<{ player: GamePlayer; score: number }> = [];
  for (const row of ranked) {
    const group = groupOf(row.player);
    if (filled[group] >= SQUAD_QUOTA[group]) continue;
    filled[group]++;
    picked.push(row);
    taken.add(row.player.id);
  }
  for (const row of ranked) {
    if (picked.length >= CALL_UP_SQUAD_SIZE) break;
    if (taken.has(row.player.id)) continue;
    picked.push(row);
    taken.add(row.player.id);
  }
  // 정원 순회가 자리별로 담았으므로 마지막에 점수 순으로 다시 세운다 — 그 서열이
  // 곧 출전 추첨의 눈금이다 (`appsFor`)
  return picked
    .sort((a, b) =>
      a.score === b.score ? (a.player.id < b.player.id ? -1 : 1) : b.score - a.score,
    )
    .slice(0, CALL_UP_SQUAD_SIZE)
    .map((row) => row.player);
}

/** 나라 코드 사전순으로 세운 명단 판 — 순회가 배열 순서를 읽지 않게 한다 */
function sortedBoard(state: GameState): Array<[string, GamePlayer[]]> {
  return [...callUpBoard(state).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** 한 나라의 명단 — 여러 나라가 필요하면 `callUpBoard`를 한 번만 부른다 */
export function callUpSquad(state: GameState, country: string): GamePlayer[] {
  return callUpBoard(state).get(country) ?? [];
}

/** 이 세계에서 대표팀을 세울 수 있는 협회 — 코드 사전순(결정적) */
export function callUpCountries(state: GameState): string[] {
  return [...callUpBoard(state).keys()].sort();
}

// ── 추첨 ──────────────────────────────────────────────

/** 한 창의 A매치 수 — FIFA 창 하나에 둘이다 */
const MATCHES_PER_BREAK = 2;
/** 두 경기를 다 뛰는 서열 — 주전 열한 명 */
const STARTER_RANK = 11;
/** 한 경기는 확실한 서열의 끝 — 그 아래는 못 뛸 수도 있다 */
const ROTATION_RANK = 18;

/** 이 서열의 선수가 그 창에서 뛴 경기 수 */
function appsFor(rank: number, rng: () => number): number {
  if (rank < STARTER_RANK) return MATCHES_PER_BREAK;
  if (rank < ROTATION_RANK) return rng() < 0.6 ? 1 : MATCHES_PER_BREAK;
  return rng() < 0.35 ? 1 : 0;
}

/**
 * 출전 한 번의 기대 골 — 자리와 종합이 정한다.
 * 종합 88의 공격수는 출전당 0.59, 100캡이면 60골 언저리다(실제 대표팀 최상위권).
 */
const GOAL_RATE: Record<PositionGroup, number> = { GK: 0, DF: 0.05, MF: 0.14, FW: 0.45 };
/** 그 비율이 서 있는 기준 종합 */
const GOAL_RATE_REFERENCE = 80;
/** 한 경기에 둘 이상 — 첫 골 확률의 이만큼 */
const BRACE_SHARE = 0.2;

function goalsFor(player: GamePlayer, apps: number, rng: () => number): number {
  const lambda = (GOAL_RATE[groupOf(player)] * player.attributes.overall) / GOAL_RATE_REFERENCE;
  let goals = 0;
  for (let i = 0; i < apps; i++) {
    if (rng() < lambda) goals++;
    if (rng() < lambda * BRACE_SHARE) goals++;
  }
  return goals;
}

// ── 정산 ──────────────────────────────────────────────

/** 이동만으로 치르는 대가 — 원정 거리를 세지 않는다(세계가 그것을 모델링하지 않는다) */
export const CALL_UP_TRAVEL_FATIGUE = 6;
/** A매치 한 번이 남기는 피로 — 100에서 2경기면 66, 1경기면 80으로 돌아온다 */
export const CALL_UP_FATIGUE_PER_APP = 14;
/**
 * 대표팀 차출 구간의 부상 확률이 클럽 경기의 몇 배인가 — **상수 하나다.**
 *
 * UEFA 엘리트 클럽 연구가 재는 차출 구간의 부상 발생률이 클럽 경기의 1.3~1.7배다.
 * 원정 거리도 대륙도 세지 않는 이유는 세계가 그 이동을 갖고 있지 않기 때문이다 —
 * 아는 척하는 수치보다 클럽 확률에서 파생한 배수 하나가 정직하다.
 */
export const INTERNATIONAL_INJURY_MULTIPLIER = 1.5;
/** 그 창의 출전 한 번이 부상으로 이어질 확률의 바탕 */
export const INTERNATIONAL_INJURY_PER_APP =
  INJURY_CHANCE_PER_APPEARANCE * INTERNATIONAL_INJURY_MULTIPLIER;
/** A매치 한 경기의 출전 분 — 감각은 실제로 뛴 만큼 오른다 */
const MINUTES_PER_APP = 90;

/** 지금 클럽을 떠나 있는 소집 — 없으면 null */
export function openCallUp(state: GameState, playerId: string): CallUp | null {
  return (
    (state.callUps ?? []).find((c) => c.gamePlayerId === playerId && c.returnedOn === null) ?? null
  );
}

/** 그 창의 우리 팀 소집 — 화면·사실 카드가 읽는 자리 */
export function callUpsOfBreak(state: GameState, breakKey: string): CallUp[] {
  return (state.callUps ?? []).filter((c) => c.breakKey === breakKey);
}

/** 소집 행이 남는 시즌 수 — 사실 카드·낙마 판정이 읽는 창 */
const CALL_UP_SEASONS_KEPT = 2;

/** `<시즌>:<MMDD>` 키에서 시즌만 */
function seasonOfKey(key: string): number {
  return Number(key.split(":")[0]);
}

// ── 소집 ──────────────────────────────────────────────

/**
 * **휴식기 첫날 — 세계가 명단을 발표한다.**
 *
 * 나라별 23인의 행을 열고, 그 창에서 무엇이 있었나(출전·골)를 그 자리에서 굴린다.
 * 결과를 미리 적어 두는 이유는 정산일에 다시 굴리면 그 사이 움직인 폼·출전이
 * 명단을 바꾸기 때문이다 — 소집과 복귀는 같은 사실의 두 끝이어야 한다.
 *
 * 다이제스트에는 **우리 팀 선수만** 선다. 세계 전체의 명단은 감독이 읽을 사실이 아니다.
 */
export function openCallUps(state: GameState, window: InternationalBreak, digest: string[]): void {
  const rows: CallUp[] = [];
  for (const [country, squad] of sortedBoard(state)) {
    for (let rank = 0; rank < squad.length; rank++) {
      const player = squad[rank]!;
      const rng = makeRng(state.seed, `call-up:${window.key}:${player.id}`);
      const apps = appsFor(rank, rng);
      rows.push({
        gamePlayerId: player.id,
        country,
        breakKey: window.key,
        apps,
        goals: goalsFor(player, apps, rng),
        returnedOn: null,
        ...(capsOf(player.state) === 0 ? { debut: true } : {}),
      });
    }
  }
  state.callUps = [...(state.callUps ?? []), ...rows];

  const ours = rows.filter(
    (r) => state.players.find((p) => p.id === r.gamePlayerId)?.teamId === state.userTeamId,
  );
  if (ours.length > 0) {
    digest.push(`${window.label} — 우리 선수 ${ours.length}명 소집 (~${window.to})`);
  }
}

// ── 복귀 ──────────────────────────────────────────────

/**
 * **휴식기 마지막 날 — 돌아온 몸을 장부에 적는다.**
 *
 * 그날의 회복이 이미 얹힌 **뒤에** 부른다(tick의 계약). 체력은 열흘의 회복을
 * 되돌리지 않고 이동과 출전의 대가만 한 번에 낸다 — 소집된 선수도 매일 회복하되
 * 훈련장이 아니라 쉬는 날의 눈금을 받았기 때문이다.
 */
export function settleCallUps(
  state: GameState,
  window: InternationalBreak,
  digest: string[],
): void {
  for (const row of state.callUps ?? []) {
    if (row.breakKey !== window.key || row.returnedOn !== null) continue;
    const player = state.players.find((p) => p.id === row.gamePlayerId);
    row.returnedOn = state.date;
    if (!player) continue;

    player.state.caps = capsOf(player.state) + row.apps;
    if (row.goals > 0) {
      player.state.internationalGoals = internationalGoalsOf(player.state) + row.goals;
    }
    /**
     * **시즌의 잔고는 킥오프 체력으로 잰다** (player.md §5.5) — 클럽 경기 마감과
     * 같은 순서다(`finalizeMatch`): 체력을 깎기 **전**의 값으로 재야 「덜 회복된
     * 몸으로 뛴 90분이 더 남는다」는 연전 간격 항이 성립한다. 대표팀 출전만 이
     * 장부를 비켜 가면 9·10·11·3월의 A매치 여덟 경기가 시즌에 아무것도 쌓지 않는다.
     */
    player.state.fatigue = clampFatigue(
      fatigueOf(player.state) +
        fatigueFromMinutes(row.apps * MINUTES_PER_APP, player.state.condition),
    );
    player.state.condition = clampCondition(
      player.state.condition - CALL_UP_TRAVEL_FATIGUE - CALL_UP_FATIGUE_PER_APP * row.apps,
    );
    player.state.sharpness = clampSharpness(
      sharpnessAfterMinutes(sharpnessOf(player.state), row.apps * MINUTES_PER_APP),
    );

    const rng = makeRng(state.seed, `call-up-return:${window.key}:${player.id}`);
    let hurt = false;
    for (let i = 0; i < row.apps; i++) {
      if (isInjured(state, player.id)) break;
      if (rng() >= INTERNATIONAL_INJURY_PER_APP * pronenessValue(player)) continue;
      const { days, part } = openInjuryFor(state, player, "match", rng);
      hurt = true;
      if (player.teamId === state.userTeamId) {
        digest.push(
          `대표팀에서 부상: ${player.name} — ${part}, 약 ${days}일 결장 예상 (${row.country})`,
        );
      }
    }
    row.returnState = returnStateOf(row.apps, hurt);
  }
  trimCallUps(state);

  const ours = (state.callUps ?? []).filter(
    (r) =>
      r.breakKey === window.key &&
      state.players.find((p) => p.id === r.gamePlayerId)?.teamId === state.userTeamId,
  );
  if (ours.length > 0) {
    const played = ours.filter((r) => r.apps > 0);
    const goals = ours.reduce((s, r) => s + r.goals, 0);
    digest.push(
      `${window.label} 복귀 — ${ours.length}명 중 ${played.length}명 출전` +
        (goals > 0 ? ` · ${goals}골` : "") +
        ` · 지쳐 돌아온 선수 ${ours.filter((r) => r.returnState !== "fit").length}명`,
    );
  }
}

function returnStateOf(apps: number, hurt: boolean): CallUpReturnState {
  if (hurt) return "injured";
  return apps >= MATCHES_PER_BREAK ? "tired" : "fit";
}

/**
 * 표를 접는다 — **감독 팀 행만 최근 두 시즌**이 남는다.
 *
 * 남의 선수의 캡·골은 이미 그 선수 위로 들어갔고, 소집 중이 아닌 남의 행을 읽는
 * 자리가 없다. 접지 않으면 시즌마다 2,300행이 쌓인다.
 */
function trimCallUps(state: GameState): void {
  const floor = state.season - (CALL_UP_SEASONS_KEPT - 1);
  state.callUps = (state.callUps ?? []).filter((row) => {
    if (row.returnedOn === null) return true;
    if (seasonOfKey(row.breakKey) < floor) return false;
    return state.players.find((p) => p.id === row.gamePlayerId)?.teamId === state.userTeamId;
  });
}

// ── 여름 메이저 대회 ──────────────────────────────────

export type MajorTournament = "world-cup" | "continental";

/**
 * 그 시즌 앞의 여름에 선 대회 — 짝수 해마다 하나다 (홀수 해엔 없다).
 * 월드컵 2026·2030 · 대륙선수권 2028·2032가 실제 주기와 같은 자리에 선다.
 */
export function majorTournamentOf(season: number): MajorTournament | null {
  const year = seasonYear(season);
  if (year % 4 === 2) return "world-cup";
  if (year % 4 === 0) return "continental";
  return null;
}

/** 대회를 깊이 간 나라의 선수가 늦는 만큼 — 서열이 「얼마나 갔나」를 대신한다 */
const TOURNAMENT_DELAY_DAYS: ReadonlyArray<{ within: number; days: number }> = [
  { within: 8, days: 21 },
  { within: 16, days: 14 },
  { within: Number.POSITIVE_INFINITY, days: 7 },
];

/** 나라의 세기 — 상위 23인 종합 평균. 대회를 굴리지 않으므로 이것이 성적을 대신한다 */
function countryStrength(squad: readonly GamePlayer[]): number {
  if (squad.length === 0) return 0;
  return squad.reduce((s, p) => s + p.attributes.overall, 0) / squad.length;
}

/**
 * **여름 대회가 남기는 유일한 사실 — 누가 늦게 오나** (competition.md §5-1).
 *
 * 시즌 전환이 새 달력을 세운 뒤 부른다. 대회가 없는 해엔 지난해의 지연을 지우고
 * 아무것도 세우지 않는다 — 남겨 두면 대회 없는 프리시즌에 주전이 훈련장에 없다.
 */
export function applySummerTournament(
  state: GameState,
  season: number,
  squadReturn: string,
  digest: string[],
): void {
  for (const player of state.players) delete player.state.summerReturn;
  const tournament = majorTournamentOf(season);
  if (tournament === null) return;

  const squads = sortedBoard(state)
    .map(([country, squad]) => ({ country, squad, strength: countryStrength(squad) }))
    .sort((a, b) =>
      a.strength === b.strength ? (a.country < b.country ? -1 : 1) : b.strength - a.strength,
    );

  let late = 0;
  for (let rank = 0; rank < squads.length; rank++) {
    const days = TOURNAMENT_DELAY_DAYS.find((t) => rank < t.within)?.days ?? 7;
    for (const player of squads[rank]!.squad) {
      player.state.summerReturn = addDays(squadReturn, days);
      if (player.teamId === state.userTeamId) late++;
    }
  }
  if (late > 0) {
    const ko = tournament === "world-cup" ? "월드컵" : "대륙선수권";
    digest.push(`${ko}을 뛴 우리 선수 ${late}명은 소집일보다 늦게 합류한다`);
  }
}

// ── 세계 생성 ─────────────────────────────────────────

/** 한 시즌의 A매치 — 휴식기 4회 × 2경기 */
const CAPS_PER_SEASON = MATCHES_PER_BREAK * 4;
/** 주전이 소화하는 몫 · 로테이션 · 명단 끝 — `appsFor`의 기댓값과 같은 결 */
const SEED_APP_SHARE: ReadonlyArray<{ within: number; share: number }> = [
  { within: STARTER_RANK, share: 0.85 },
  { within: ROTATION_RANK, share: 0.5 },
  { within: CALL_UP_SQUAD_SIZE, share: 0.2 },
];
/** 대표팀에 처음 서는 나이의 대역 — 서열이 높을수록 이르다 */
const FIRST_CAP_AGE = { best: 19, worst: 26 } as const;
/** 통산에 얹는 흔들림 — 같은 서열·같은 나이가 전부 같은 수를 갖지 않게 */
const SEED_JITTER = 0.25;

/**
 * **새 게임의 통산 캡·골** (competition.md §5-1).
 *
 * 없으면 서른 살 주전이 첫 소집에서 데뷔하고 GM이 그 문장을 쓴다. 굴리는 것은
 * 나이와 지금의 서열뿐이다 — 지나간 열 시즌의 명단을 세계가 갖고 있지 않으므로,
 * 「지금 이 서열이면 그 나이까지 이만큼 뛰었을 것」을 결정적으로 세운다.
 */
export function seedInternationalCaps(state: GameState): void {
  for (const [, squad] of sortedBoard(state)) {
    for (let rank = 0; rank < squad.length; rank++) {
      const player = squad[rank]!;
      const share = SEED_APP_SHARE.find((s) => rank < s.within)?.share;
      if (share === undefined) continue;
      const debutAge =
        FIRST_CAP_AGE.best +
        ((FIRST_CAP_AGE.worst - FIRST_CAP_AGE.best) * rank) / CALL_UP_SQUAD_SIZE;
      const years = ageOf(player.birthdate, state.date) - debutAge;
      if (years <= 0) continue;
      const rng = makeRng(state.seed, `caps-seed:${player.id}`);
      const jitter = 1 - SEED_JITTER + rng() * SEED_JITTER * 2;
      const caps = Math.round(CAPS_PER_SEASON * years * share * jitter);
      if (caps <= 0) continue;
      player.state.caps = caps;
      const goals = goalsFor(player, caps, makeRng(state.seed, `caps-goals:${player.id}`));
      if (goals > 0) player.state.internationalGoals = goals;
    }
  }
}

/**
 * 지금 클럽을 떠나 있는가 — **A매치 소집도 여름 대회의 늦은 합류도 한 문이다**
 * (season.md §8 불변식). `isAvailable`이 부상·정지와 함께 이것을 묻는다.
 */
export function isAwayFromClub(state: GameState, player: GamePlayer): boolean {
  if (openCallUp(state, player.id) !== null) return true;
  const summer = player.state.summerReturn;
  return summer !== undefined && state.date < summer;
}

/**
 * 지금 클럽을 떠나 있는 선수 id 전부 — **한 번만 모은다.**
 *
 * 선수 전원을 도는 루프(`tickOtherClubs`)가 사람마다 `isAwayFromClub`을 부르면 그
 * 안에서 소집 표를 5,700번 다시 훑는다. 판정은 같고 자릿수만 다르다.
 */
export function awayFromClubIds(state: GameState): ReadonlySet<string> {
  const out = new Set<string>();
  for (const row of state.callUps ?? []) {
    if (row.returnedOn === null) out.add(row.gamePlayerId);
  }
  for (const player of state.players) {
    const summer = player.state.summerReturn;
    if (summer !== undefined && state.date < summer) out.add(player.id);
  }
  return out;
}

/** 그 선수가 다치지 않고 소집 중인가 — 진단 줄이 부상과 소집을 가르는 자리 */
export function callUpNoteOf(state: GameState, playerId: string): CallUp | null {
  return openInjury(state, playerId) === null ? openCallUp(state, playerId) : null;
}

/** 이 창의 명단에 대비해 지난 창에는 있었는데 이번엔 없는 우리 선수 — 낙마 */
export function droppedFrom(state: GameState, previousKey: string, currentKey: string): string[] {
  const now = new Set(callUpsOfBreak(state, currentKey).map((c) => c.gamePlayerId));
  return callUpsOfBreak(state, previousKey)
    .filter((c) => !now.has(c.gamePlayerId))
    .filter((c) => state.players.find((p) => p.id === c.gamePlayerId)?.teamId === state.userTeamId)
    .map((c) => c.gamePlayerId);
}

/** 이 창 바로 앞의 창 — 시즌 경계를 넘어 앞 시즌의 마지막 창으로 이어진다 */
export function previousBreakKey(key: string): string {
  const season = seasonOfKey(key);
  const windows = internationalBreaksOf(season);
  const i = windows.findIndex((w) => w.key === key);
  if (i > 0) return windows[i - 1]!.key;
  const prev = internationalBreaksOf(season - 1);
  return prev[prev.length - 1]!.key;
}

/** 오늘로부터 이 창의 복귀일까지 남은 날 — 화면·프롬프트가 읽는 사실 */
export function daysUntilReturn(state: GameState, window: InternationalBreak): number {
  return Math.max(0, diffDays(state.date, window.to));
}
