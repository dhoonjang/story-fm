import {
  ageOf,
  growthLabel,
  injuryHistoryText,
  isReserveMatch,
  TRAINING_MARK_KO,
  normalizeSpeaker,
  outcomeFor,
  outcomeLabel,
  seasonRating,
  tacticWord,
  TACTIC_AXES,
  type GamePlayer,
  type Injury,
  type MatchRecord,
  type TacticAxisKey,
  type TacticsSpec,
  type TrainingReport,
} from "@story-fm/domain";
import { injuryWeight } from "@story-fm/sim";
import { formLabel } from "./form";
import { injuryHistoryOf, pronenessValue } from "./injury";
import { isSettling } from "./settling";
import { CUE_ROTATION_TURNS, recentSpeakers, rotationDay } from "./cues";
import { diffDays, nextMatchFor } from "../competition/calendar";
import { boardExpectation, computeStandings } from "../competition/season";
import { leagueOfTeamIn } from "../competition/promotion";
import { matchdayRevenue } from "../club/finance";
import { tierOfTeamIn } from "../core/club-tier";
import { competitionLabel, competitionName } from "../data/cup-catalog";
import { derbyNameOf } from "../data/derbies";
import { coachArchetypeKeyOf, headCoachOf } from "../world/persona";
import { loanReports } from "../market/departures";
import {
  assignmentsOf,
  isInjured,
  latestTrainingReport,
  managedTeamId,
  playerById,
  playerName,
  playersOf,
  seasonStatOf,
  squadLevelOf,
  teamNameIn,
  teamShortNameIn,
  type GameState,
} from "../core/state";

/**
 * **수석코치의 눈 — 이 코치가 같은 장부에서 무엇을 먼저 보는가** (people.md §7-1).
 *
 * 근황(`cues.ts`)이 "세계에 지금 무슨 이야기가 있는가"라면 이쪽은 그중 **누구의
 * 눈으로 고르는가**다. 6원형은 여기가 서기 전까지 말투와 관계 초기값에만 닿아
 * 있었고, 그래서 데이터 분석가형과 야전 조련사형이 같은 스냅샷을 읽고 같은 것을
 * 말했다. 원형이 시뮬 숫자에 손대지 않고 **상태를 거쳐서만** 세계에 닿는 자리가
 * 이것이다 (people.md 요구 3).
 *
 * ⚠️ **새로 재는 값은 하나도 없다.** 여섯 갈래 전부 이미 장부에 있는 파생을 읽기만
 * 한다 — 코치의 눈이 만드는 것은 값이 아니라 **순서**다.
 *
 * ⚠️ **코어가 내놓는 것은 사실뿐이다** (overview.md §1 철칙 4 · `cues.ts`와 같은 결).
 * "체력 58"은 서고 "쉬게 하시죠"는 서지 않는다 — 그 사실로 무슨 말을 할지는 GM이
 * 이 코치의 말투로 쓴다.
 */

export interface CoachCue {
  /** 어느 갈래인가 — 문장이 아니라 코드다 (people.md §7-1의 표) */
  code: string;
  /** 장부에서 뽑은 사실 한 줄 */
  fact: string;
  /** 이름이 걸린 선수 — 회전이 이 이름으로 근황과 겹침을 피한다 */
  playerIds: string[];
}

/** 조련사가 "곧"이라고 보는 창 — 이 안이면 회복이 다음 경기에 걸린다 */
const FIXTURE_SOON_DAYS = 3;
/** 이 아래의 체력은 사실로 짚는다 — `conditionBand`의 "보통" 언저리다 */
const TIRED_CONDITION = 60;
/** 성장 로그를 "이달"로 보는 창 (일) */
const GROWTH_WINDOW_DAYS = 30;
/** 한 줄에 세우는 이름 수 — 그 이상은 카드가 표가 된다 */
const NAMES_SHOWN = 3;
/** 유망주 카드에 서는 2군 인원 */
const PROSPECTS_SHOWN = 2;
/** 한 유망주 줄에 세우는 성장 축 */
const GROWTH_AXES_SHOWN = 2;
/** 맞대결 이력에 세우는 경기 수 */
const H2H_SHOWN = 3;
/** 상대의 최근 경기 */
const OPPONENT_RECENT = 5;
/** 가장 벌어진 축 — 둘이면 갈래가 보이고 셋이면 표가 된다 */
const AXES_SHOWN = 2;
/**
 * 결산 카드가 "방금 일"로 서는 창 (일).
 *
 * 카드는 손잡이를 돌린 턴 **뒤에** 서므로 감독이 그 자리에서 몇 마디 더 나누는
 * 동안 남아 있어야 한다. 그 뒤로는 다음 결산이 대신 서고, 이 창을 넘긴 카드는
 * 소식이 아니라 기록이다 — 달력이 갖는다.
 */
const TRAINING_REPORT_FRESH_DAYS = 3;
/**
 * 임대 리포트가 "이달 소식"으로 서는 창 (일) — 결산 카드와 같은 결이다.
 *
 * 리포트는 매월 1일 다이제스트로 한 번 지나가므로, 감독이 그 자리에서 몇 마디 더
 * 나누는 동안만 남는다. 그 뒤로는 다음 달 1일이 새로 세운다.
 */
const LOAN_REPORT_FRESH_DAYS = 3;

/** 코치가 카드를 고르기 전에 한 번만 뽑아 두는 것 — 갈래마다 다시 훑지 않는다 */
interface CoachSight {
  /** 다음 경기 (2군 제외) — 없으면 시즌 끝자락이다 */
  next: MatchRecord | null;
  /** 그 경기의 상대 */
  opponentId: string | null;
  /** 오늘부터 그 경기까지의 날 수 */
  daysToNext: number | null;
}

/** 한 갈래의 눈 — 볼 것이 없으면 `null`이다. 자리를 채우려고 사실을 만들지 않는다 */
type CoachEye = (state: GameState, sight: CoachSight) => CoachCue | null;

// ── 장부에서 줄을 뽑는 잔손 ────────────────────────────

/** 경기 한 줄의 머리 — `EPL R12 원정 vs LIV` */
function fixtureHead(state: GameState, match: MatchRecord): string {
  const home = match.homeTeamId === state.userTeamId;
  const side = match.neutral === true ? "중립" : home ? "홈" : "원정";
  const opponent = teamShortNameIn(state, home ? match.awayTeamId : match.homeTeamId);
  return `${competitionLabel(match.competitionId, match.stage ?? "league", match.round)} ${side} vs ${opponent}`;
}

/** 끝난 경기 한 줄 — `EPL R12 3-0 승 vs EVE` (기준 팀 시점) */
function resultLine(state: GameState, match: MatchRecord, teamId: string): string {
  const home = match.homeTeamId === teamId;
  const mine = home ? match.result!.homeGoals : match.result!.awayGoals;
  const theirs = home ? match.result!.awayGoals : match.result!.homeGoals;
  const other = teamShortNameIn(state, home ? match.awayTeamId : match.homeTeamId);
  return (
    `${competitionLabel(match.competitionId, match.stage ?? "league", match.round)} ` +
    `${mine}-${theirs} ${outcomeLabel(outcomeFor(match, teamId))} vs ${other}`
  );
}

/**
 * 이 팀의 끝난 경기 — **날짜순**이다. `state.matches`는 날짜순이 아니라 컵·대항전
 * 대진이 뒤에 붙는 순서라, 배열 끝을 그대로 자르면 "최근 5경기"가 방금 편성된
 * 컵 경기가 된다 (`cues.ts`·`lookup.ts`도 같은 이유로 날짜순이다).
 */
function playedByDate(state: GameState, teamId: string): MatchRecord[] {
  return state.matches
    .filter(
      (m) =>
        m.result !== null &&
        !isReserveMatch(m) &&
        (m.homeTeamId === teamId || m.awayTeamId === teamId),
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** 이 부상으로 빠진 우리 경기 수 — 다친 날 다음부터 복귀 전날까지 */
function missedMatches(state: GameState, injury: Injury): number {
  return state.matches.filter(
    (m) =>
      m.result !== null &&
      !isReserveMatch(m) &&
      (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId) &&
      m.date > injury.occurredOn &&
      (injury.returnedOn === null || m.date < injury.returnedOn),
  ).length;
}

/** 시즌 기록 한 조각 — `12경기 5골 평점 7.4`. 출전이 없으면 "출전 없음" */
function seasonLine(state: GameState, playerId: string): string {
  const stat = seasonStatOf(state, playerId);
  if (!stat || stat.apps === 0) return "출전 없음";
  const rating = seasonRating(stat);
  return `${stat.apps}경기 ${stat.goals}골${rating !== null ? ` 평점 ${rating.toFixed(1)}` : ""}`;
}

/** 사람 수와 이름 — `2 (손흥민 · 케인)`. 이름은 앞에서부터 셋까지 */
function counted(names: string[]): string {
  const shown = names.slice(0, NAMES_SHOWN).join(" · ");
  return `${names.length} (${shown}${names.length > NAMES_SHOWN ? " …" : ""})`;
}

// ── 여섯 원형의 눈 ─────────────────────────────────────

/** 3일 안 경기인데 선발 후보의 다리가 안 도는가 */
const tiredStarters: CoachEye = (state, sight) => {
  const { next, daysToNext } = sight;
  if (next === null || daysToNext === null || daysToNext > FIXTURE_SOON_DAYS) return null;
  const tired = assignmentsOf(state, state.userTeamId, "starting")
    .map((a) => playerById(state, a.playerId))
    .filter((p): p is GamePlayer => p !== null && p.state.condition <= TIRED_CONDITION)
    .sort((a, b) => a.state.condition - b.state.condition || (a.id < b.id ? -1 : 1))
    .slice(0, NAMES_SHOWN);
  if (tired.length === 0) return null;
  return {
    code: "tired",
    fact:
      `${fixtureHead(state, next)} D-${daysToNext} · 선발 중 체력 ${TIRED_CONDITION} 이하: ` +
      tired.map((p) => `${p.name} ${p.state.condition}`).join(" · "),
    playerIds: tired.map((p) => p.id),
  };
};

/** 이번 시즌 몸이 몇 번 무너졌고 그동안 몇 경기가 지나갔는가 */
const injuryLog: CoachEye = (state) => {
  const since = state.calendar.preseasonStart;
  const rows = playersOf(state, state.userTeamId)
    .filter((p) => squadLevelOf(p) === "first")
    .map((p) => {
      const spells = state.injuries.filter((i) => i.gamePlayerId === p.id && i.occurredOn >= since);
      return {
        player: p,
        spells: spells.length,
        missed: spells.reduce((sum, i) => sum + missedMatches(state, i), 0),
      };
    })
    .filter((r) => r.spells > 0)
    .sort((a, b) => b.missed - a.missed || (a.player.id < b.player.id ? -1 : 1))
    .slice(0, NAMES_SHOWN);
  if (rows.length === 0) return null;
  return {
    code: "injury-log",
    fact:
      "이번 시즌 부상 이력: " +
      rows.map((r) => `${r.player.name} ${r.spells}회 ${r.missed}경기 결장`).join(" · "),
    playerIds: rows.map((r) => r.player.id),
  };
};

/**
 * 지금 이 몸으로 세우면 위험한 사람 — **다치기 전에 서는 눈이다** (player.md §5.3).
 *
 * `injury-log`가 이미 쓰러진 뒤의 장부라면 이쪽은 그 앞이다. 다친 선수는 빼고
 * (그 사실은 주의 줄이 이미 말한다) 등급이 오른 1군만, 저울이 무거운 순으로 셋까지.
 */
const injuryRisk: CoachEye = (state) => {
  const rows = playersOf(state, state.userTeamId)
    .filter((p) => squadLevelOf(p) === "first" && !isInjured(state, p.id))
    .map((p) => ({
      player: p,
      history: injuryHistoryOf(state, p.id),
      // 순서는 코어의 저울이 정한다 — 무엇을 말할지는 읽는 쪽이 정한다
      weight: injuryWeight(p, 0, pronenessValue(p)),
    }))
    .filter((r) => r.history.count > 0)
    .sort((a, b) => b.weight - a.weight || (a.player.id < b.player.id ? -1 : 1))
    .slice(0, NAMES_SHOWN);
  if (rows.length === 0) return null;
  return {
    code: "injury-risk",
    fact:
      "부상 이력: " +
      rows.map((r) => `${r.player.name} ${injuryHistoryText(r.history)}`).join(" · "),
    playerIds: rows.map((r) => r.player.id),
  };
};

/** 다음 상대가 표의 어디에 서 있는가 */
const opponentTable: CoachEye = (state, sight) => {
  const { opponentId } = sight;
  if (opponentId === null) return null;
  const league = leagueOfTeamIn(state, opponentId);
  const standings = computeStandings(state, league);
  const row = standings.find((r) => r.teamId === opponentId);
  const rank = standings.findIndex((r) => r.teamId === opponentId) + 1;
  const head = `다음 상대 ${teamNameIn(state, opponentId)} — 구단 등급 ${tierOfTeamIn(state, opponentId)}`;
  // 0경기 순위는 정렬 순서일 뿐이다 — 스냅샷의 우리 순위와 같은 규칙이다
  if (!row || row.played === 0 || rank === 0) {
    return { code: "opponent-table", fact: `${head} · 아직 리그 경기 없음`, playerIds: [] };
  }
  return {
    code: "opponent-table",
    fact:
      `${head} · ${competitionName(league)} ${rank}위 ` +
      `(${row.played}경기 ${row.wins}승 ${row.draws}무 ${row.losses}패 · 승점 ${row.points} · ` +
      `득실 ${row.goalDiff >= 0 ? "+" : ""}${row.goalDiff})`,
    playerIds: [],
  };
};

/** 다음 상대가 최근 어떻게 걸어왔는가 */
const opponentForm: CoachEye = (state, sight) => {
  const { opponentId } = sight;
  if (opponentId === null) return null;
  const recent = playedByDate(state, opponentId).slice(-OPPONENT_RECENT);
  if (recent.length === 0) return null;
  return {
    code: "opponent-form",
    fact:
      `${teamNameIn(state, opponentId)} 최근 ${recent.length}경기: ` +
      recent.map((m) => resultLine(state, m, opponentId)).join(" / "),
    playerIds: [],
  };
};

/** 여섯 축에서 두 팀이 가장 벌어진 곳 — 전력 패킷이 소화력으로 읽는 그 축이다 */
const matchupAxis: CoachEye = (state, sight) => {
  const { opponentId } = sight;
  if (opponentId === null) return null;
  const ours = state.tactics.find((t) => t.teamId === state.userTeamId)?.spec;
  const theirs = state.tactics.find((t) => t.teamId === opponentId)?.spec;
  if (!ours || !theirs) return null;
  const them = teamShortNameIn(state, opponentId);
  const shape = `${teamNameIn(state, opponentId)} ${theirs.formation} / 우리 ${ours.formation}`;
  const gaps = TACTIC_AXES.map((axis) => ({
    axis,
    gap: Math.abs(value(theirs, axis.key) - value(ours, axis.key)),
  }))
    // 벌어진 순 — 같으면 표의 순서다(멘탈리티부터). 축마다 흔들리면 매일 다른 축이 선다
    .filter((g) => g.gap > 0)
    .sort((a, b) => b.gap - a.gap)
    .slice(0, AXES_SHOWN);
  if (gaps.length === 0) {
    return { code: "matchup-axis", fact: `전술 대비 — ${shape} · 여섯 축이 같다`, playerIds: [] };
  }
  return {
    code: "matchup-axis",
    fact:
      `전술 대비 — ${shape} · 가장 벌어진 축: ` +
      gaps
        .map(
          ({ axis }) =>
            `${axis.brief} ${them} ${tacticWord(axis.key, value(theirs, axis.key))} / ` +
            `우리 ${tacticWord(axis.key, value(ours, axis.key))}`,
        )
        .join(" · "),
    playerIds: [],
  };
};

/** 축 하나의 눈금 — 모양(`formation`)은 눈금이 아니라 이 표에 서지 않는다 */
function value(spec: TacticsSpec, key: TacticAxisKey): number {
  return spec[key];
}

/** 2군에서 위를 보고 있는 아이들 — 잠재력 순 둘 */
function prospectsOf(state: GameState): GamePlayer[] {
  return playersOf(state, state.userTeamId)
    .filter((p) => squadLevelOf(p) === "reserve")
    .sort((a, b) => b.attributes.potential - a.attributes.potential || (a.id < b.id ? -1 : 1))
    .slice(0, PROSPECTS_SHOWN);
}

/** 이달 이 선수가 무엇을 얼마나 올렸나 — 오른 축만, 큰 순으로 */
function monthlyGrowth(state: GameState, playerId: string): string {
  const byTarget = new Map<string, number>();
  for (const entry of state.growthLog) {
    if (entry.gamePlayerId !== playerId) continue;
    if (diffDays(entry.date, state.date) > GROWTH_WINDOW_DAYS) continue;
    byTarget.set(entry.target, (byTarget.get(entry.target) ?? 0) + entry.delta);
  }
  const risen = [...byTarget.entries()]
    .filter(([, delta]) => delta > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, GROWTH_AXES_SHOWN);
  if (risen.length === 0) return "이달 변화 없음";
  return `이달 ${risen.map(([target, delta]) => `${growthLabel(target)} +${delta}`).join(" · ")}`;
}

/** 2군의 잠재력 상위 둘이 어디까지 왔는가 */
const prospects: CoachEye = (state) => {
  const young = prospectsOf(state);
  if (young.length === 0) return null;
  return {
    code: "prospects",
    fact:
      "2군 잠재력 상위: " +
      young
        .map(
          (p) =>
            `${p.name} ${ageOf(p.birthdate, state.date)}세 종합 ${p.attributes.overall} ` +
            `잠재력 ${p.attributes.potential} · ${monthlyGrowth(state, p.id)}`,
        )
        .join(" / "),
    playerIds: young.map((p) => p.id),
  };
};

/** 그 둘이 2군 리그에서 실제로 뛴 기록 — 1군 기록과 섞지 않는다 */
const reserveRecord: CoachEye = (state) => {
  const young = prospectsOf(state);
  if (young.length === 0) return null;
  const rows = young.map((p) => {
    const stat = seasonStatOf(state, p.id);
    const apps = stat?.reserveApps ?? 0;
    if (apps === 0) return `${p.name} 2군 리그 출전 없음`;
    const rating = seasonRating({ apps, ratingSum: stat?.reserveRatingSum });
    return (
      `${p.name} ${apps}경기 ${stat?.reserveGoals ?? 0}골` +
      (rating !== null ? ` 평점 ${rating.toFixed(1)}` : "")
    );
  });
  return {
    code: "reserve-record",
    fact: `2군 리그: ${rows.join(" · ")}`,
    playerIds: young.map((p) => p.id),
  };
};

/** 라커룸에 지금 걸려 있는 것 — 불만과 아직 녹지 않은 새 얼굴 */
const dressingRoom: CoachEye = (state) => {
  const unhappy = state.issues
    .map((i) => playerById(state, i.gamePlayerId))
    .filter((p): p is GamePlayer => p !== null);
  const settling = playersOf(state, state.userTeamId).filter((p) => isSettling(state, p.id));
  if (unhappy.length === 0 && settling.length === 0) return null;
  const parts = [
    unhappy.length > 0 ? `불만 ${counted(unhappy.map((p) => p.name))}` : null,
    settling.length > 0 ? `정착 미완 ${counted(settling.map((p) => p.name))}` : null,
  ].filter((x): x is string => x !== null);
  return {
    code: "dressing-room",
    fact: parts.join(" · "),
    playerIds: [...unhappy, ...settling].map((p) => p.id).slice(0, NAMES_SHOWN),
  };
};

/** 라커룸을 대신 지고 있는 한 사람 */
const captain: CoachEye = (state) => {
  const who = playersOf(state, state.userTeamId).find((p) => p.isCaptain);
  if (!who) return null;
  return {
    code: "captain",
    fact:
      `주장 ${who.name} — 폼 ${formLabel(who.state.form)} · 체력 ${who.state.condition} · ` +
      `이번 시즌 ${seasonLine(state, who.id)}`,
    playerIds: [who.id],
  };
};

/** 이 상대와 지난번에 무슨 일이 있었나 */
const headToHead: CoachEye = (state, sight) => {
  const { opponentId } = sight;
  if (opponentId === null) return null;
  const them = teamNameIn(state, opponentId);
  const past = playedByDate(state, state.userTeamId).filter(
    (m) => m.homeTeamId === opponentId || m.awayTeamId === opponentId,
  );
  if (past.length === 0) {
    return { code: "head-to-head", fact: `vs ${them} — 장부에 맞대결 기록 없음`, playerIds: [] };
  }
  const recent = past.slice(-H2H_SHOWN).reverse();
  return {
    code: "head-to-head",
    fact:
      `vs ${them} 최근 맞대결: ` +
      recent.map((m) => `${m.date} ${resultLine(state, m, state.userTeamId)}`).join(" / "),
    playerIds: [],
  };
};

/** 이 상대에게 장부가 기억하는 전적 전부 */
const h2hTally: CoachEye = (state, sight) => {
  const { opponentId } = sight;
  if (opponentId === null) return null;
  const past = playedByDate(state, state.userTeamId).filter(
    (m) => m.homeTeamId === opponentId || m.awayTeamId === opponentId,
  );
  if (past.length === 0) return null;
  const tally = { W: 0, D: 0, L: 0 };
  for (const m of past) tally[outcomeFor(m, state.userTeamId) ?? "D"] += 1;
  return {
    code: "h2h-tally",
    fact: `vs ${teamNameIn(state, opponentId)} 장부 통산 ${tally.W}승 ${tally.D}무 ${tally.L}패 (${past.length}경기)`,
    playerIds: [],
  };
};

/** 다음 경기가 이 도시가 한 해 내내 기다린 그 경기인가 */
const derby: CoachEye = (state, sight) => {
  const { next } = sight;
  if (next === null) return null;
  const name = derbyNameOf(next.homeTeamId, next.awayTeamId);
  if (name === null) return null;
  return {
    code: "derby",
    fact: `다음 경기 = ${name} (${next.date} ${fixtureHead(state, next)})`,
    playerIds: [],
  };
};

/** 다음 홈경기에 관중석이 얼마나 차는가 — 다음 경기가 원정이면 그 뒤의 홈경기다 */
const gate: CoachEye = (state) => {
  const home = state.matches
    .filter(
      (m) =>
        m.result === null &&
        !isReserveMatch(m) &&
        m.neutral !== true &&
        m.homeTeamId === state.userTeamId &&
        m.date >= state.date,
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))[0];
  if (!home) return null;
  const revenue = matchdayRevenue(state, home);
  return {
    code: "gate",
    fact:
      `다음 홈경기 ${home.date} ${fixtureHead(state, home)} — 예상 관중 ` +
      `${revenue.attendance.toLocaleString("en-US")} / ${revenue.capacity.toLocaleString("en-US")} ` +
      `(점유율 ${Math.round(revenue.occupancy * 100)}%)`,
    playerIds: [],
  };
};

/** 보드가 건 기대와 지금 서 있는 자리 */
const expectation: CoachEye = (state) => {
  const be = boardExpectation(state, state.userTeamId);
  const standings = computeStandings(state);
  const row = standings.find((r) => r.teamId === state.userTeamId);
  const rank = standings.findIndex((r) => r.teamId === state.userTeamId) + 1;
  const head = `보드 기대 ${be.target}위 이내`;
  if (!row || row.played === 0 || rank === 0) {
    return { code: "expectation", fact: `${head} · 아직 리그 경기 없음`, playerIds: [] };
  }
  /**
   * **간격이 이 카드의 몫이다.** 기대 순위는 `<manager>`가, 지금 순위는 `<now>`가
   * 이미 싣는다 — 두 수를 다시 적기만 하면 카드가 아무것도 더하지 않는다.
   * 계단 수는 뺄셈이지 평가가 아니다 (좋다·나쁘다는 코어의 말이 아니다).
   */
  const gap = rank - be.target;
  const stand = gap > 0 ? `${gap}계단 아래` : gap === 0 ? "기대선" : `${-gap}계단 위`;
  return {
    code: "expectation",
    fact: `${head} · 지금 ${rank}위 (${row.played}경기 · 승점 ${row.points}) · ${stand}`,
    playerIds: [],
  };
};

/**
 * 지난 구간의 **훈련 결산** — 원형이 고르지 않는 한 장 (people.md §7-1).
 *
 * 훈련장은 갈래를 가릴 것 없이 이 코치가 여는 자리다. 여섯 눈 중 하나로 넣으면
 * 원형 하나에게만 닿아, 분석가를 쓰는 감독은 자기 훈련의 결과를 영영 듣지 못한다.
 * 그래서 눈의 표 밖에 서고 2장 상한도 지지 않는다.
 *
 * ⚠️ **싣는 것은 건수와 이름까지다.** 근거 한 줄과 낱낱의 수치는 달력 일지와
 * `get_player`가 갖는다 — 스냅샷은 매 턴 정가로 읽히는 층이라, 스물몇 줄짜리
 * 판정을 그대로 부으면 이 블록 하나가 그 층의 절반을 먹는다 (agents.md §6).
 */
function trainingReportCue(state: GameState): CoachCue | null {
  const report = latestTrainingReport(state);
  if (report === null) return null;
  if (diffDays(report.to, state.date) > TRAINING_REPORT_FRESH_DAYS) return null;
  const window = report.from === report.to ? report.to : `${report.from}~${report.to}`;
  const head = `${window} 훈련 ${report.sessions}회 결산`;
  const grew = [...new Set(report.moved.map((m) => m.gamePlayerId))];
  const parts = [
    grew.length > 0 ? `성장 ${counted(grew.map((id) => playerName(state, id)))}` : null,
    ...markCounts(state, report),
  ].filter((x): x is string => x !== null);
  return {
    code: "training-report",
    // 아무것도 움직이지 않은 구간도 사실이다 — 그 자리를 비우면 지어낸다
    fact: `${head} — ${parts.length > 0 ? parts.join(" · ") : "장부에 남은 변화 없음"}`,
    playerIds: [...grew, ...report.marks.map((m) => m.gamePlayerId)],
  };
}

/**
 * 이달 **임대 리포트** — 훈련 결산과 같이 원형이 고르지 않는 한 장
 * (season.md §2 임대 · people.md §7-1).
 *
 * 임대 보낸 유망주의 소식을 여섯 눈 중 하나로 넣으면 유스형 코치를 쓰는 감독에게만
 * 닿는다. 리콜은 이적 창이 열려 있는 동안에만 가능한 결정이라, 그 한 원형을 안
 * 쓴 감독은 근거 없이 복귀일을 맞는다.
 *
 * ⚠️ **싣는 것은 이름과 한 토막씩이다.** 낱낱의 수치는 조회가 갖는다 — 스냅샷은
 * 매 턴 정가로 읽히는 층이라 임대 인원만큼 줄을 부으면 안 된다 (agents.md §6).
 */
function loanReportCue(state: GameState): CoachCue | null {
  // 세이브에 새로 적는 것은 없다 — 이달 1일과 장부에서 파생한다
  const monthStart = `${state.date.slice(0, 7)}-01`;
  if (diffDays(monthStart, state.date) > LOAN_REPORT_FRESH_DAYS) return null;
  const reports = loanReports(state);
  if (reports.length === 0) return null;
  /**
   * **근거가 붙은 건이 앞에 선다** — 자리는 세 토막인데 리포트가 그보다 많으면
   * 뛰지 못하는 선수가 이름 순서에 밀려 잘린다. 정렬은 안정적이라 나머지는
   * `loanReports`의 id 순서 그대로다(결정적).
   */
  const ordered = [...reports].sort(
    (a, b) => Number(b.concerns.length > 0) - Number(a.concerns.length > 0),
  );
  const shown = ordered.slice(0, NAMES_SHOWN).map((r) => {
    const bits = [
      r.apps > 0
        ? `${r.apps}경기 ${r.goals}골${r.rating !== null ? ` 평점 ${r.rating.toFixed(1)}` : ""}`
        : "1군 출전 없음",
      // 근거 코드는 코드가 아니라 그것이 **뜻하는 사실**로 적는다 (`LoanConcern`)
      r.concerns.includes("no-minutes") ? `최근 ${r.benchRun}경기 명단 밖` : null,
      r.injury ? `부상 ${r.injury.bodyPart}` : null,
    ].filter((x): x is string => x !== null);
    return `${r.name}(${teamShortNameIn(state, r.teamId)}) ${bits.join(" · ")}`;
  });
  return {
    code: "loan-report",
    fact:
      `${state.date.slice(0, 7)} 임대 ${reports.length}건 — ` +
      `${shown.join(" / ")}${reports.length > shown.length ? " …" : ""}`,
    playerIds: reports.map((r) => r.playerId),
  };
}

/** 갈래별 인원과 이름 — 갈래 표의 순서를 따른다(날마다 순서가 흔들리지 않게) */
function markCounts(state: GameState, report: TrainingReport): string[] {
  const rows: string[] = [];
  for (const code of Object.keys(TRAINING_MARK_KO) as Array<keyof typeof TRAINING_MARK_KO>) {
    const names = report.marks
      .filter((m) => m.code === code)
      .map((m) => playerName(state, m.gamePlayerId));
    if (names.length > 0) rows.push(`${TRAINING_MARK_KO[code]} ${counted(names)}`);
  }
  return rows;
}

/**
 * 원형 키 → 그 코치가 먼저 보는 것 (people.md §7-1의 표).
 *
 * ⚠️ **키는 `world/persona.ts`의 원형 키다.** 세이브에 남는 것은 라벨이므로
 * `coachArchetypeKeyOf`가 되짚어 찾는다. 이 표에 없는 원형은 빈손이 된다 —
 * 다른 코치의 눈이 대신 서지는 않는다.
 */
const COACH_EYE: Readonly<Record<string, readonly CoachEye[]>> = {
  drill_sergeant: [tiredStarters, injuryLog, injuryRisk],
  analyst: [opponentTable, opponentForm, matchupAxis],
  youth_developer: [prospects, reserveRecord],
  man_manager: [dressingRoom, captain],
  veteran_tactician: [headToHead, h2hTally],
  club_loyalist: [derby, gate, expectation],
};

/** 눈을 가진 원형 전수 — 테스트가 6원형이 다 서 있는지 훑을 때 쓴다 */
export const COACH_EYE_KEYS: readonly string[] = Object.keys(COACH_EYE);

/**
 * 오늘 이 코치가 먼저 짚는 사실 — 최대 `limit`장.
 *
 * **재직 중에만 선다** — 맡은 팀이 없으면 벤치에 함께 앉는 사람도 없다.
 * 결정적이다: 같은 날 같은 세이브면 같은 목록이다.
 */
export function coachCues(state: GameState, limit = 2): CoachCue[] {
  if (managedTeamId(state) === null) return [];
  /**
   * 훈련 결산과 임대 리포트는 **원형 앞에** 선다 — 눈이 없는 원형(표에서 되찾지
   * 못한 라벨)에게도 이 두 장은 간다. 자리도 따로 갖는다: `limit`은 원형이 고르는
   * 장수다.
   */
  const settlement = trainingReportCue(state);
  const loan = loanReportCue(state);
  const first = [settlement, loan].filter((cue): cue is CoachCue => cue !== null);
  const key = coachArchetypeKeyOf(headCoachOf(state));
  const eyes = key !== null ? COACH_EYE[key] : undefined;
  if (!eyes) return first;

  const next = nextMatchFor(state.matches, state.userTeamId, state.date);
  const sight: CoachSight = {
    next,
    opponentId: next
      ? next.homeTeamId === state.userTeamId
        ? next.awayTeamId
        : next.homeTeamId
      : null,
    daysToNext: next ? diffDays(state.date, next.date) : null,
  };

  const cues = eyes.map((eye) => eye(state, sight)).filter((cue): cue is CoachCue => cue !== null);
  if (cues.length === 0) return first;

  /**
   * **최근에 말한 이름이 걸린 사실은 뒤로 민다** — 근황과 같은 창(`recentSpeakers`)을
   * 본다. 지우지 않고 미는 이유도 같다: 어제 말한 선수라도 오늘 새로 다쳤으면
   * 그게 더 큰 사건이다. 이름이 걸리지 않은 사실(상대·구단)은 밀 근거가 없어
   * 늘 앞자리 후보다.
   */
  const spoke = recentSpeakers(state, CUE_ROTATION_TURNS);
  const said = (cue: CoachCue) =>
    cue.playerIds.length > 0 &&
    cue.playerIds.every((id) => {
      const name = playerById(state, id)?.name;
      return name !== undefined && spoke.has(normalizeSpeaker(name));
    });

  const fresh = cues.filter((c) => !said(c));
  const spoken = cues.filter((c) => said(c));
  /**
   * 남은 후보를 **날짜로 굴린다** — 갈래가 셋인 원형은 자리가 둘이라 이 회전이
   * 없으면 셋째 사실이 영영 서지 않는다.
   */
  const day = rotationDay(state.date);
  const rotated = fresh.length > 0 ? fresh.map((_, i) => fresh[(i + day) % fresh.length]!) : fresh;
  return [...first, ...[...rotated, ...spoken].slice(0, limit)];
}
