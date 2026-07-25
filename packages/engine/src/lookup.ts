import type { GamePlayer } from "@story-fm/domain";
import { ageOf, naturalPositionOf } from "@story-fm/domain";
import { TEAM_CATALOG, teamCatalogById } from "./data/team-catalog";
import { computeStandings } from "./season";
import {
  attributeLine,
  knowledgeNote,
  knowledgeOf,
  overallView,
  potentialView,
  strengthsAndWeaknesses,
  type Knowledge,
} from "./scouting";
import {
  activeContract,
  activeSuspension,
  assignmentFor,
  familiarityOf,
  groupOf,
  isAvailable,
  openInjury,
  playerById,
  playersOf,
  seasonStatOf,
  tacticsOf,
  teamName,
  teamShortName,
  type GameState,
} from "./state";

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

function resolveTeamId(state: GameState, team?: string): string | null {
  if (!team || team === "mine" || team === "우리") return state.userTeamId;
  const byId = TEAM_CATALOG.find((t) => t.id === team.toLowerCase());
  if (byId) return byId.id;
  const byName = TEAM_CATALOG.find(
    (t) => t.name.includes(team) || t.shortName.toLowerCase() === team.toLowerCase(),
  );
  return byName?.id ?? null;
}

/** 우리 팀 선수 한 줄 — 정확 수치 (오피스 뷰가 이미 보여주는 정보) */
function ourRow(state: GameState, p: GamePlayer): string {
  const assignment = assignmentFor(state, p.id);
  const contract = activeContract(state, p.id);
  const stat = seasonStatOf(state, p.id);
  const injury = openInjury(state, p.id);
  const suspension = activeSuspension(state, p.id);
  const role = assignment
    ? `[${assignment.role === "starting" ? "선발" : "벤치"}:${assignment.position}]`
    : "[예비]";
  const status = injury
    ? ` 부상(${injury.bodyPart}, ~${injury.expectedReturn})`
    : suspension
      ? ` 정지(${suspension.lengthMatches - suspension.served}경기)`
      : "";
  const issue = state.issues.some((i) => i.gamePlayerId === p.id) ? " ⚠불만" : "";
  return (
    `${p.id} ${p.name} ${ageOf(p.birthdate, state.date)}세 ${naturalPositionOf(p).position} ` +
    `OVR${p.attributes.overall} 폼${p.state.form >= 0 ? "+" : ""}${p.state.form} 사기${p.state.morale} ` +
    `피로${p.state.fatigue} 적응${familiarityOf(state, p.id)} ${money(contract?.weeklyWage ?? 0)} ` +
    `${role} 출전${stat?.apps ?? 0}/득점${stat?.goals ?? 0}${status}${issue}${p.isCaptain ? " (주장)" : ""}`
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
    `${teamShortName(p.teamId)} · ${overallView(state, p)} (${source}) · ` +
    `출전${stat?.apps ?? 0}/득점${stat?.goals ?? 0}${injury ? ` · 부상 중(~${injury.expectedReturn})` : ""}`
  );
}

export function playerRow(state: GameState, p: GamePlayer): string {
  return p.teamId === state.userTeamId ? ourRow(state, p) : theirRow(state, p);
}

// ── 검색 ────────────────────────────────────────────────

export interface SearchPlayersInput {
  /** "mine" | 팀 id | 팀 이름 — 생략하면 리그 전체 */
  team?: string;
  /** 포지션 코드 (주 포지션 또는 소화 가능 포지션) */
  position?: string;
  /** 이름·id 부분 일치 */
  name?: string;
  minAge?: number;
  maxAge?: number;
  /** 부상·정지 제외 */
  availableOnly?: boolean;
  sortBy?: "rating" | "age" | "fatigue" | "goals" | "wage";
  limit?: number;
}

export function searchPlayers(state: GameState, input: SearchPlayersInput): LookupResult {
  const teamId = input.team ? resolveTeamId(state, input.team) : null;
  if (input.team && !teamId) {
    return { ok: false, message: `"${input.team}"라는 팀을 찾지 못했습니다` };
  }
  const position = input.position?.toUpperCase();
  const pool = (teamId ? playersOf(state, teamId) : state.players).filter((p) => {
    if (position && !p.positions.some((x) => x.position === position)) return false;
    if (input.name && !p.name.includes(input.name) && !p.id.includes(input.name.toLowerCase())) {
      return false;
    }
    const age = ageOf(p.birthdate, state.date);
    if (input.minAge !== undefined && age < input.minAge) return false;
    if (input.maxAge !== undefined && age > input.maxAge) return false;
    if (input.availableOnly && !isAvailable(state, p.id)) return false;
    return true;
  });

  const sortBy = input.sortBy ?? "rating";
  const sorted = [...pool].sort((a, b) => {
    switch (sortBy) {
      case "age":
        return ageOf(a.birthdate, state.date) - ageOf(b.birthdate, state.date);
      case "fatigue":
        return b.state.fatigue - a.state.fatigue;
      case "goals":
        return (seasonStatOf(state, b.id)?.goals ?? 0) - (seasonStatOf(state, a.id)?.goals ?? 0);
      case "wage":
        return (activeContract(state, b.id)?.weeklyWage ?? 0) - (activeContract(state, a.id)?.weeklyWage ?? 0);
      default:
        return b.attributes.overall - a.attributes.overall;
    }
  });

  if (sorted.length === 0) return { ok: true, message: "조건에 맞는 선수가 없습니다" };
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const shown = sorted.slice(0, limit);
  const head = `[검색 결과] ${sorted.length}명 중 ${shown.length}명 (정렬: ${sortBy})`;
  const tail =
    sorted.length > shown.length
      ? `\n…그 외 ${sorted.length - shown.length}명 — 조건을 좁히거나 limit을 올려라`
      : "";
  return { ok: true, message: [head, ...shown.map((p) => playerRow(state, p))].join("\n") + tail };
}

// ── 선수 상세 ───────────────────────────────────────────

export function playerCard(state: GameState, playerId: string): LookupResult {
  const p = playerById(state, playerId);
  if (!p) {
    return {
      ok: false,
      message: `"${playerId}"라는 선수를 찾지 못했습니다 — search_players로 id를 먼저 확인하라`,
    };
  }
  const knowledge: Knowledge = knowledgeOf(state, p.id);
  const stat = seasonStatOf(state, p.id);
  const contract = activeContract(state, p.id);
  const injury = openInjury(state, p.id);
  const suspension = activeSuspension(state, p.id);
  const lines: string[] = [
    `[선수 카드] ${p.name} — ${teamName(p.teamId)} · ${ageOf(p.birthdate, state.date)}세 · ` +
      `주포지션 ${naturalPositionOf(p).position} (${groupOf(p)}) · id ${p.id}`,
    knowledgeNote(state, p.id),
    `능력치: ${attributeLine(state, p)}`,
    `종합: ${overallView(state, p)} · 잠재력: ${potentialView(state, p)}`,
  ];

  if (knowledge === "own") {
    lines.push(
      `컨디션: 폼 ${p.state.form >= 0 ? "+" : ""}${p.state.form} · 사기 ${p.state.morale} · 피로 ${p.state.fatigue}`,
      `소화 포지션: ${p.positions
        .map((x) => `${x.position}${x.isNatural ? "*" : ""}${x.proficiency}`)
        .join(" / ")}`,
    );
    const assignment = assignmentFor(state, p.id);
    lines.push(
      assignment
        ? `전술: ${assignment.role === "starting" ? "선발" : "벤치"} ${assignment.position} · 전술적응 ${assignment.familiarity}` +
            (assignment.instruction ? ` · 개인지시 "${assignment.instruction}"` : "")
        : "전술: 배치 없음 (예비 스쿼드)",
    );
    const growth = state.growthLog
      .filter((g) => g.gamePlayerId === p.id)
      .slice(-3)
      .map((g) => `${g.date} ${g.target} ${g.delta > 0 ? "+" : ""}${g.delta}`);
    if (growth.length > 0) lines.push(`최근 성장: ${growth.join(" / ")}`);
  } else {
    const { strengths, weaknesses } = strengthsAndWeaknesses(state, p);
    lines.push(`인상: 강점 ${strengths.join("·")} / 약점 ${weaknesses.join("·")}`);
  }

  lines.push(
    `시즌 기록: ${stat?.apps ?? 0}경기 ${stat?.goals ?? 0}골`,
    contract
      ? `계약: 주급 ${money(contract.weeklyWage)} · 만료 ${contract.until}`
      : "계약: 정보 없음",
  );
  if (injury) {
    lines.push(`부상: ${injury.bodyPart} (${injury.severity}) — 복귀 예상 ${injury.expectedReturn}`);
  }
  if (suspension) {
    lines.push(`징계: 출장 정지 ${suspension.lengthMatches - suspension.served}경기 남음`);
  }
  return { ok: true, message: lines.join("\n") };
}

// ── 팀 프로필 (상대 스카우팅 리포트) ───────────────────

export function teamProfile(state: GameState, team: string): LookupResult {
  const teamId = resolveTeamId(state, team);
  if (!teamId) return { ok: false, message: `"${team}"라는 팀을 찾지 못했습니다` };

  const standings = computeStandings(state);
  const row = standings.find((r) => r.teamId === teamId);
  const rank = standings.findIndex((r) => r.teamId === teamId) + 1;
  const squad = playersOf(state, teamId);
  const tactics = tacticsOf(state, teamId);
  const avgAge =
    squad.length > 0
      ? squad.reduce((s, p) => s + ageOf(p.birthdate, state.date), 0) / squad.length
      : 0;

  const recent = state.matches
    .filter((m) => m.result && (m.homeTeamId === teamId || m.awayTeamId === teamId))
    .slice(-5)
    .map((m) => {
      const home = m.homeTeamId === teamId;
      const my = home ? m.result!.homeGoals : m.result!.awayGoals;
      const their = home ? m.result!.awayGoals : m.result!.homeGoals;
      const mark = my > their ? "승" : my < their ? "패" : "무";
      return `R${m.round} ${my}-${their} vs ${teamShortName(home ? m.awayTeamId : m.homeTeamId)} ${mark}`;
    });

  // 우리와의 상대 전적
  const h2h = state.matches.filter(
    (m) =>
      m.result &&
      ((m.homeTeamId === teamId && m.awayTeamId === state.userTeamId) ||
        (m.awayTeamId === teamId && m.homeTeamId === state.userTeamId)),
  );
  let w = 0;
  let d = 0;
  let l = 0;
  for (const m of h2h) {
    const userHome = m.homeTeamId === state.userTeamId;
    const mine = userHome ? m.result!.homeGoals : m.result!.awayGoals;
    const theirs = userHome ? m.result!.awayGoals : m.result!.homeGoals;
    if (mine > theirs) w++;
    else if (mine < theirs) l++;
    else d++;
  }

  const keyPlayers = tactics.assignments
    .filter((a) => a.role === "starting")
    .map((a) => playerById(state, a.playerId))
    .filter((p): p is GamePlayer => p !== null)
    .sort((a, b) => b.attributes.overall - a.attributes.overall)
    .slice(0, 6);

  const lines = [
    `[팀 프로필] ${teamName(teamId)} — 리그 ${rank || "?"}위` +
      (row
        ? ` (${row.played}경기 ${row.wins}승 ${row.draws}무 ${row.losses}패 · 승점 ${row.points} · 득실 ${row.goalDiff >= 0 ? "+" : ""}${row.goalDiff})`
        : " (아직 경기 없음)"),
    `전술: ${tactics.spec.formation} · 멘탈리티${tactics.spec.mentality} 압박${tactics.spec.pressing} 템포${tactics.spec.tempo} 패스${tactics.spec.passStyle}`,
    `스쿼드: ${squad.length}명 · 평균 ${avgAge.toFixed(1)}세 · 구단 등급 ${teamCatalogById(teamId)?.tier ?? "?"}`,
    recent.length > 0 ? `최근 5경기: ${recent.join(" / ")}` : "최근 경기 없음",
  ];
  if (teamId !== state.userTeamId) {
    lines.push(`우리와의 전적: ${w}승 ${d}무 ${l}패`);
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
  /** fixtures 전용 — 생략하면 우리 팀 */
  team?: string;
  /** fixtures에서 보여줄 경기 수 (기본 5) */
  count?: number;
}

export function leagueView(state: GameState, input: LeagueViewInput): LookupResult {
  if (input.view === "standings") {
    const rows = computeStandings(state).map((r, i) => {
      const mark = r.teamId === state.userTeamId ? " ←우리" : "";
      return (
        `${String(i + 1).padStart(2)} ${r.name} ${r.played}경기 ${r.wins}승 ${r.draws}무 ${r.losses}패 ` +
        `${r.points}점 (${r.goalDiff >= 0 ? "+" : ""}${r.goalDiff})${mark}`
      );
    });
    return { ok: true, message: [`[리그 순위] ${state.season}시즌 · ${state.date}`, ...rows].join("\n") };
  }

  const teamId = resolveTeamId(state, input.team);
  if (!teamId) return { ok: false, message: `"${input.team}"라는 팀을 찾지 못했습니다` };
  const count = Math.min(Math.max(input.count ?? 5, 1), 10);
  const mine = state.matches
    .filter((m) => m.homeTeamId === teamId || m.awayTeamId === teamId)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const past = mine.filter((m) => m.result).slice(-count);
  const future = mine.filter((m) => !m.result).slice(0, count);
  const label = (id: string) => teamShortName(id);
  return {
    ok: true,
    message: [
      `[일정] ${teamName(teamId)}`,
      ...past.map(
        (m) =>
          `  지난 R${m.round} ${m.date} ${label(m.homeTeamId)} ${m.result!.homeGoals}-${m.result!.awayGoals} ${label(m.awayTeamId)}`,
      ),
      ...future.map(
        (m) =>
          `  예정 R${m.round} ${m.date} ${m.homeTeamId === teamId ? "홈" : "원정"} vs ${label(m.homeTeamId === teamId ? m.awayTeamId : m.homeTeamId)}`,
      ),
    ].join("\n"),
  };
}
