import type {
  ApproachTopic,
  GamePlayer,
  MatchRecord,
  PressAxis,
  PressConference,
  PressFact,
  PlayerIssueReason,
  PressStance,
  PressTrigger,
} from "@story-fm/domain";
import {
  isNaturalAt,
  naturalPositionOf,
  PLAYER_ISSUE_REASONS,
  pressFactText,
  RATING_MAX,
} from "@story-fm/domain";
import type { GameState } from "../core/state";
import { playerById, playersOf, pushNarrative, teamNameIn, userPlayers } from "../core/state";
import { pickPlayerAmong } from "../core/player-ref";
import { addDays } from "../core/dates";
import { formatMoney } from "./finance";
import { makeRng, pick } from "../core/rng";
import { clampForm, formLabel, moraleToForm } from "../squad/form";
import { matchMilestones } from "../squad/career";
import { recentOutcomes } from "../squad/slump";
import { isFriendly } from "../competition/friendly";
import { boardExpectation, computeStandings } from "../competition/season";
import { leagueOfTeamIn } from "../competition/promotion";
import { derbyNameOf } from "../data/derbies";
import { reportersOf } from "../world/persona";
import type { SkillResult } from "../skills";
import { deltaItems } from "../skills/brief";

/**
 * 기자회견 — **코어는 자리를 만들고 한도를 정하고, 판정은 LLM이 한다.**
 *
 * 협상(`market.ts`)·설득(`persuasion.ts`)과 같은 구조다. 코어가 하는 일은 둘뿐:
 *   ① **질문을 만든다** — 장부의 사실(결과·연패·부진·큰 이적)에서 결정적으로.
 *      모델이 질문까지 지으면 세계에 없던 사건이 회견장에서 태어난다.
 *   ② **한도를 정한다** — 어떤 답을 하든 회견 하나가 옮길 수 있는 폭.
 *
 * 태도(스탠스)를 감독에게 **고르게 하지 않는** 이유는 이 게임의 인터페이스가
 * 말이기 때문이다. 감독은 하고 싶은 말을 하고, 그것이 감싼 것인지 자른 것인지는
 * 세계(LLM)가 읽는다.
 */

/** 무승 계단을 재는 창과, 그 안에서 회견이 열리는 무승 경기 수 */
const WINLESS_WINDOW = 4;
const WINLESS_STREAK = 3;

/** 상태에 남기는 지난 회견 수 — 그 뒤는 서사에만 남는다 */
const KEPT_CONFERENCES = 20;

/** 회견 하나가 옮길 수 있는 기본 폭 — `weight`(1~3)에 비례한다 (overview §7) */
export const PRESS_BAND = 4;

/**
 * 스탠스별 방향 — 평판 3축과 사기.
 *
 * 표의 요점은 **공짜가 없다**는 것이다. 선수를 감싸면 라커룸을 얻고 언론을 잃고,
 * 날을 세우면 그 반대다. 어느 행도 전부 양수이지 않다 — 그러면 그 스탠스만 쓴다.
 */
const STANCE_TABLE: Record<PressStance, Record<PressAxis, number>> = {
  defend: { board: -0.2, media: -0.4, squad: 1, target: 1, team: 0.5 },
  own: { board: 0.6, media: 0.2, squad: 0.6, target: 0.3, team: 0.25 },
  criticise: { board: 0.3, media: 0.8, squad: -0.9, target: -1, team: -0.5 },
  bold: { board: -0.3, media: 1, squad: 0.4, target: 0.4, team: 0.4 },
  deflect: { board: 0, media: -0.3, squad: 0, target: 0, team: 0 },
};

/**
 * 회견을 **거절**했을 때. 실제로도 의무 회견 불참은 벌금과 비판을 부른다 —
 * 그래서 거절은 "아무 일 없음"이 아니라 **언론을 잃는 선택**이다. 라커룸이 조금
 * 오르는 건 감독이 총대를 멘 것으로 읽히기 때문이다.
 */
const DECLINE: Record<PressAxis, number> = {
  board: -0.3,
  media: -1,
  squad: 0.2,
  target: 0,
  team: 0,
};

/** 평판 눈금의 위끝 — 0~100 */
const REPUTATION_MAX = 100;

export const clampRep = (v: number) => Math.max(0, Math.min(REPUTATION_MAX, Math.round(v)));

/** 리더십 0이 갖는 울림 */
const LEADERSHIP_FACTOR_MIN = 0.7;
/** 리더십이 최고까지 더해 주는 몫 — 0.7~1.3 */
const LEADERSHIP_FACTOR_SPAN = 0.6;

/** 리더십 계수 — 같은 말도 리더십이 자라면 라커룸에 더 크게 울린다 (skills.ts와 같은 자) */
function leadershipFactor(state: GameState): number {
  return (
    LEADERSHIP_FACTOR_MIN +
    (state.manager.attributes.leadership / RATING_MAX) * LEADERSHIP_FACTOR_SPAN
  );
}

/** 이 자리가 얼마나 큰가 — 한도가 여기에 비례한다 */
function weightOf(trigger: PressTrigger, sharp: boolean): 1 | 2 | 3 {
  if (trigger === "pressure") return 3;
  if (trigger === "transfer") return 2;
  return sharp ? 2 : 1;
}

/**
 * 이 자리를 여는 기자 — **누가 묻는가는 자리의 성격이 정한다.**
 *
 * 경기 뒤는 장면과 전술을 캐는 **전국지**, 이적은 사람 사이를 캐는 **타블로이드**,
 * 무승·압박처럼 구단의 내일을 묻는 자리는 팬을 대신하는 **지역지**다. 같은 회견은
 * 언제나 같은 기자가 물어야 "저 친구는 늘 라커룸부터 캔다"가 성립한다.
 *
 * ⚠️ 배열 인덱스다 — `reportersOf`가 주는 순서는 언제나 `REPORTER_ARCHETYPES`의
 * 순서이고(persona.ts), 그것은 **0 지역지 베테랑 · 1 전국지 전술 기자 · 2 타블로이드**다.
 */
const REPORTER_AT: Record<PressTrigger, number> = {
  pressure: 0,
  match: 1,
  transfer: 2,
  // 전야 회견은 팬을 대신해 묻는 자리다 — 개막의 기대도 더비의 정서도 지역지의 것
  opening: 0,
  derby: 0,
};

/** 그 자리를 여는 기자의 `characterId` — 기자단이 짧으면 첫 기자가, 없으면 아무도 묻지 않는다 */
function reporterFor(state: GameState, trigger: PressTrigger): string | undefined {
  const reporters = reportersOf(state);
  return (reporters[REPORTER_AT[trigger]] ?? reporters[0])?.characterId;
}

/** 우리 시각의 결과 */
function outcomeOf(state: GameState, m: MatchRecord): "win" | "draw" | "loss" | null {
  if (!m.result) return null;
  const home = m.homeTeamId === state.userTeamId;
  const us = home ? m.result.homeGoals : m.result.awayGoals;
  const them = home ? m.result.awayGoals : m.result.homeGoals;
  return us === them ? "draw" : us > them ? "win" : "loss";
}

/** 그 선수의 불만 사유 코드 — 옛 세이브는 문장만 들고 있어 그때는 없다 */
function issueReasonOf(state: GameState, playerId: string): PlayerIssueReason | null {
  return state.issues.find((i) => i.gamePlayerId === playerId)?.reason ?? null;
}

/**
 * 지금 기자가 이름을 부를 만한 선수 — **장부가 고른다.**
 * 폼이 바닥인 선수, 없으면 불만이 쌓인 선수. 모델에게 "적당한 선수를 골라라"
 * 하면 없는 사연이 생긴다.
 */
/** 기자가 "폼이 떨어졌다"고 물을 만한 폼 — 이 아래면 화젯거리다 */
const SLUMPING_FORM = -0.35;

/** 그중 몇 명까지를 후보로 두는가 — 매번 최악의 한 명만 물으면 같은 이름이 반복된다 */
const SLUMP_CANDIDATES = 3;

function questionablePlayer(state: GameState, seed: number): GamePlayer | null {
  const squad = userPlayers(state);
  const slumping = squad
    .filter((p) => p.state.form < SLUMPING_FORM)
    .sort((a, b) => a.state.form - b.state.form)
    .slice(0, SLUMP_CANDIDATES);
  if (slumping.length > 0) return pick(makeRng(seed, "press"), slumping);
  // 첫 줄이 아니라 **스쿼드에 있는 첫 불만** — 옛 세이브의 유령이 진짜 불만을 가리지 않게 (people.md §5)
  const issue = state.issues.find((i) => squad.some((p) => p.id === i.gamePlayerId));
  if (issue) return squad.find((p) => p.id === issue.gamePlayerId) ?? null;
  return null;
}

/**
 * 경기 뒤 회견 — **매 경기 붙는다.**
 * 실제 리그의 의무 회견이 그렇고, 무엇보다 이겼을 때만 열리면 회견이 상이 된다.
 * 대신 평범한 승리 뒤는 `weight` 1짜리 가벼운 자리다.
 */
export function buildMatchPress(state: GameState, matchId: string): PressConference | null {
  const match = state.matches.find((m) => m.id === matchId);
  const result = match?.result;
  if (!match || !result) return null;
  /**
   * **친선 뒤에는 회견이 없다** (season.md §2). 프리시즌은 감독이 판을 시험하는
   * 자리이고, 회견은 시험을 값으로 만든다 — 친선 3경기 무승이 `pressure` 회견(무게 3,
   * 폭 ±12)을 열어, 답하지 않고 다음 친선으로 가는 것만으로 언론 평판이 무너졌다.
   */
  if (isFriendly(match)) return null;
  const outcome = outcomeOf(state, match);
  if (!outcome) return null;
  const home = match.homeTeamId === state.userTeamId;
  const opponentId = home ? match.awayTeamId : match.homeTeamId;
  const opponent = teamNameIn(state, opponentId);
  const usGoals = home ? result.homeGoals : result.awayGoals;
  const themGoals = home ? result.awayGoals : result.homeGoals;
  const score = `${result.homeGoals}-${result.awayGoals}`;

  /**
   * 무승 계단은 **시즌의 것이다** — 친선도 지난 시즌도 세지 않는다(`recentOutcomes`,
   * slump.ts와 같은 자). 라커룸의 연패 판정과 기자의 무승 판정이 다른 경기를 세면
   * 같은 국면을 두 눈금으로 말하게 된다.
   */
  const recent = recentOutcomes(state, state.userTeamId, WINLESS_WINDOW);
  const winless = recent.length >= WINLESS_STREAK && recent.every((r) => r !== "win");

  /**
   * **사실만 넘긴다.** 기자의 질문은 GM이 이 카드들로 직접 쓴다 — 코어가 문장을
   * 박아 두면 시즌 내내 같은 말이 반복되고, 기자의 성격도 그날의 맥락도 문장에
   * 닿지 못한다 (overview.md §1 철칙 4).
   */
  const facts: PressFact[] = [
    {
      kind: "result",
      data: {
        refId: opponentId,
        name: opponent,
        values: { for: usGoals, against: themGoals },
        tags: ["match", outcome, home ? "home" : "away"],
      },
      about: null,
      sharp: outcome === "loss" || (outcome === "draw" && winless),
    },
  ];
  if (winless) {
    facts.push({
      kind: "winless",
      data: { values: { matches: recent.length }, tags: [...recent] },
      about: null,
      sharp: true,
    });
  }
  const target = questionablePlayer(state, state.seed + state.matches.length);
  if (target) {
    const slumping = target.state.form < SLUMPING_FORM;
    const reason = issueReasonOf(state, target.id);
    facts.push({
      kind: slumping ? "slump" : "unhappy",
      data: slumping
        ? { name: target.name, tags: [formLabel(target.state.form)] }
        : { name: target.name, tags: reason ? ["named", reason] : ["named"] },
      about: target.id,
      sharp: true,
    });
  }

  /**
   * **마일스톤은 그 경기의 회견에만 실린다** (people.md §4). 이 함수는 마감이
   * 정산을 끝낸 **뒤**에 불리므로(`finalizeMatch`) 그 경기의 기록이 이미 장부에 있다.
   *
   * 한 경기에 여럿이 서면 **드문 것 하나만** 오른다 — 셋을 다 실으면 그 회견이
   * 시상식이 된다. 목록은 이미 드문 순으로 온다(`compareMilestones`)므로 첫 줄이
   * 그 하나다. 나머지는 선수 상세와 서사 메모에 그대로 있다.
   *
   * 선수가 명부에서 잡히지 않으면 카드를 세우지 않는다 — 이름 자리에 id를 흘리면
   * 기자가 그것을 사람 이름으로 읽는다.
   */
  const milestone = matchMilestones(state, matchId)[0];
  const achiever = milestone ? playerById(state, milestone.gamePlayerId) : null;
  if (milestone && achiever) {
    facts.push({
      kind: "milestone",
      data: { name: achiever.name, values: { value: milestone.value }, tags: [milestone.code] },
      about: achiever.id,
      /** 날 선 자리가 아니다 — 기자가 캐물을 일이 아니라 물어봐 줄 일이다 (people.md §4) */
      sharp: false,
    });
  }

  const trigger: PressTrigger = winless ? "pressure" : "match";
  const outcomeKo = outcome === "win" ? "승리" : outcome === "draw" ? "무승부" : "패배";
  return {
    id: `press-${matchId}`,
    date: state.date,
    trigger,
    reporterId: reporterFor(state, trigger),
    /**
     * 자리의 국면 한 줄 — **기록은 여기 오지 않는다.** 사실 카드가 이름과 눈금을
     * 이미 들고 있어(`milestone`), 같은 사실을 국면에도 적으면 기자가 한 회견에서
     * 두 번 묻는다. 국면은 그 자리의 온도(스코어·무승 계단)이지 그날의 사건 목록이 아니다.
     */
    context:
      `${opponent}전 ${score} ${outcomeKo}` + (winless ? ` · 최근 ${recent.length}경기 무승` : ""),
    facts,
    status: "pending",
    weight: weightOf(
      trigger,
      facts.some((f) => f.sharp),
    ),
  };
}

/**
 * 이 영입에 자리를 위협받는 선수들 — 같은 자리를 자기 자리로 삼던 1군 자원.
 * 기자가 "누가 밀려납니까"를 물으려면 그 이름이 세계에 있어야 한다.
 */
function squeezedBy(state: GameState, arrival: GamePlayer): GamePlayer[] {
  const pos = naturalPositionOf(arrival).position;
  return playersOf(state, state.userTeamId)
    .filter((p) => p.id !== arrival.id && p.squadLevel === "first" && isNaturalAt(p, pos))
    .sort((a, b) => b.attributes.overall - a.attributes.overall)
    .slice(0, RIVAL_NAMES_SHOWN);
}

/** 같은 자리를 두고 다투는 선수를 이름으로 몇까지 넘기는가 */
const RIVAL_NAMES_SHOWN = 2;

/** 회견이 열릴 만한 이적료 — 이 아래는 1군 상위 자원일 때만 */
const BIG_FEE = 25_000_000;

/**
 * 핵심 자원의 경계 — 스쿼드에서 그보다 나은 선수가 이만큼 있으면 핵심이 아니다.
 * 선발 열하나에 로테이션 몇을 더한 수다.
 */
export const SQUAD_CORE_SIZE = 14;

/**
 * 이적 회견 — **큰 이동에만** 붙는다.
 * 백업 자원의 임대까지 회견이 열리면 회견이 흔해져 무게를 잃는다.
 */
export function buildTransferPress(
  state: GameState,
  input: { playerId: string; kind: "in" | "out"; fee: number },
): PressConference | null {
  const player = state.players.find((p) => p.id === input.playerId);
  if (!player) return null;
  /**
   * 핵심 자원인가 — **방향과 무관하게** 센다. 매각이 확정되면 그 선수는 이미
   * 우리 명단에 없으므로 "명단 상위 14명"으로 물으면 팔린 순간 아무도 핵심이 아니다.
   * 대신 우리 스쿼드에서 그보다 나은 선수가 몇인지를 센다.
   */
  if (betterThanInSquad(state, player) >= SQUAD_CORE_SIZE && input.fee < BIG_FEE) return null;

  const pos = naturalPositionOf(player).position;
  const facts: PressFact[] =
    input.kind === "in"
      ? [
          {
            kind: "arrival",
            data: { name: player.name, values: { fee: input.fee }, tags: ["signed", pos] },
            about: player.id,
            sharp: false,
          },
          /**
           * 밀려나는 선수 — 영입은 언제나 누군가의 자리를 뺏는다. 이름을 코어가
           * 짚어 줘야 기자가 없는 선수를 지어내지 않는다.
           */
          ...squeezedBy(state, player).map((p): PressFact => ({
            kind: "squeezed",
            data: { name: p.name, tags: [pos] },
            about: p.id,
            sharp: true,
          })),
        ]
      : [
          {
            kind: "departure",
            data: { name: player.name, values: { fee: input.fee }, tags: ["sold", pos] },
            about: player.id,
            sharp: true,
          },
        ];

  return {
    id: `press-transfer-${input.playerId}-${state.date}`,
    date: state.date,
    trigger: "transfer",
    reporterId: reporterFor(state, "transfer"),
    context:
      `${player.name} ${input.kind === "in" ? "영입" : "매각"}` +
      (input.fee > 0 ? ` · ${formatMoney(input.fee)}` : ""),
    facts,
    status: "pending",
    weight: 2,
  };
}

/**
 * 우리 스쿼드에서 그보다 나은 선수가 몇인가 — **명단 순위가 아니라 스쿼드 대비다.**
 * 나간 선수는 이미 우리 명단에 없으므로 "상위 14명 안"으로 물으면 떠난 순간
 * 아무도 핵심이 아니다 (people.md §4).
 */
function betterThanInSquad(state: GameState, player: GamePlayer): number {
  return playersOf(state, state.userTeamId).filter(
    (p) => p.id !== player.id && p.attributes.overall > player.attributes.overall,
  ).length;
}

/**
 * 계약 해지 회견 — **주장이었거나 핵심 자원이었을 때만.**
 * 백업 정리까지 회견이 붙으면 회견이 흔해져 무게를 잃는다 (transfer.md §2).
 */
export function buildDeparturePress(
  state: GameState,
  input: { playerId: string; severance: number; wasCaptain: boolean },
): PressConference | null {
  const player = state.players.find((p) => p.id === input.playerId);
  if (!player) return null;
  if (!input.wasCaptain && betterThanInSquad(state, player) >= SQUAD_CORE_SIZE) return null;

  const pos = naturalPositionOf(player).position;
  return {
    id: `press-release-${player.id}-${state.date}`,
    date: state.date,
    trigger: "transfer",
    reporterId: reporterFor(state, "transfer"),
    context: `${player.name} 계약 해지`,
    facts: [
      {
        kind: "departure",
        data: {
          name: player.name,
          values: { severance: input.severance },
          tags: ["released", pos],
        },
        about: player.id,
        sharp: true,
      },
    ],
    status: "pending",
    weight: 2,
  };
}

// ── 언론 유출 ──────────────────────────────────────────────────

/**
 * 유출된 주제의 **사유 코드** — 라커룸 불만과 같은 표를 쓴다(`ISSUE_REASON_KO`).
 * 유출은 선수 주제에서만 나므로(people.md §8) 팀 주제는 코드가 없고, 없으면 `null`이다.
 */
function leakReasonOf(topic: ApproachTopic): PlayerIssueReason | null {
  return PLAYER_ISSUE_REASONS.find((r) => r === topic) ?? null;
}

/**
 * 방치된 불만이 신문에 실렸다 — **다음에 열리는 회견이 그것을 싣는다** (people.md §4).
 *
 * ⚠️ 빌더가 아니라 `openPress`에 있다. 회견은 어느 트리거든 이 문 하나를 지나므로,
 * 여기 두면 나중에 생기는 빌더가 유출을 조용히 빠뜨릴 수 없다. 유출이 스스로 자리를
 * 열지 않는 것도 같은 이유다 — 회견은 이미 경기마다 열린다.
 */
function loadLeaks(state: GameState, conference: PressConference): void {
  const leaks = state.pressLeaks ?? [];
  if (leaks.length === 0) return;
  let loaded = false;
  for (const leak of leaks) {
    const player = playerById(state, leak.playerId);
    // 떠난 선수의 유출은 조용히 버린다 — 우리 라커룸에 없는 사람의 불만은 물을 자리가 아니다
    if (!player || player.teamId !== state.userTeamId) continue;
    const reason = leakReasonOf(leak.topic);
    conference.facts.push({
      kind: "leak",
      data: { name: player.name, ...(reason ? { tags: [reason] } : {}) },
      about: player.id,
      sharp: true,
    });
    loaded = true;
  }
  // 실렸든 버려졌든 유출은 이 자리를 지나면 없다 — 다음 회견이 같은 사실을 다시 묻지 않는다
  state.pressLeaks = [];
  if (loaded) conference.weight = Math.max(conference.weight, 2);
}

// ── 전야 회견 ──────────────────────────────────────────────────

/** 전야에 실리는 최근 폼의 창 — 경기 뒤 회견의 무승 창과 같은 자 */
const FORM_WINDOW = WINLESS_WINDOW;

/** 이번 시즌 우리 리그 경기 — 개막이 언제였는지도, 순위도 여기서 센다 */
function leagueMatchesOfSeason(state: GameState, leagueId: string): MatchRecord[] {
  return state.matches.filter(
    (m) =>
      m.season === state.season &&
      m.competitionId === leagueId &&
      (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
  );
}

/** 지금 리그에서 우리와 상대가 선 자리 — 한 경기도 안 치렀으면 순위가 없다 */
function placeFact(state: GameState, opponentId: string, opponent: string): PressFact | null {
  const standings = computeStandings(state);
  const us = standings.findIndex((row) => row.ours);
  const them = standings.findIndex((row) => row.teamId === opponentId);
  if (us < 0 || them < 0 || standings[us]!.played === 0) return null;
  return {
    kind: "standing",
    data: {
      refId: opponentId,
      name: opponent,
      values: { rank: us + 1, opponentRank: them + 1 },
      tags: ["versus"],
    },
    about: null,
    sharp: false,
  };
}

/**
 * 더비 전야 — **어느 대진이 더비인가는 표가 정한다** (`data/derbies.ts`).
 * 무게 2인 것은 더비가 결과와 무관하게 팬과 구단의 자리이기 때문이다.
 */
function buildDerbyPress(
  state: GameState,
  match: MatchRecord,
  input: { derby: string; opponentId: string; opponent: string; home: boolean },
): PressConference {
  const facts: PressFact[] = [
    {
      kind: "fixture",
      data: {
        refId: input.opponentId,
        name: input.opponent,
        tags: ["derby", input.derby, input.home ? "home" : "away"],
      },
      about: null,
      sharp: true,
    },
  ];
  // 시즌 첫 더비면 아직 센 경기가 없다 — 없는 폼을 "최근 0경기"로 쓰지 않는다
  const recent = recentOutcomes(state, state.userTeamId, FORM_WINDOW);
  if (recent.length > 0) {
    facts.push({
      kind: "result",
      data: { values: { matches: recent.length }, tags: ["recent", ...recent] },
      about: null,
      sharp: false,
    });
  }
  const place = placeFact(state, input.opponentId, input.opponent);
  if (place) facts.push(place);

  return {
    id: `press-derby-${match.id}`,
    date: state.date,
    trigger: "derby",
    reporterId: reporterFor(state, "derby"),
    context: `${input.derby} 전야 · ${input.opponent}전`,
    facts,
    status: "pending",
    weight: 2,
  };
}

/**
 * 시즌 개막 전야 — 한 시즌에 한 번뿐인 자리라 id도 시즌으로 잡는다.
 * 무게 1인 것은 아직 아무 일도 일어나지 않았기 때문이다 — 물을 수 있는 것은 기대뿐이다.
 */
function buildOpeningPress(
  state: GameState,
  input: { opponent: string; home: boolean },
): PressConference {
  const expectation = boardExpectation(state, state.userTeamId);
  const facts: PressFact[] = [
    {
      kind: "fixture",
      data: { name: input.opponent, tags: ["opening", input.home ? "home" : "away"] },
      about: null,
      sharp: false,
    },
    {
      kind: "standing",
      data: { values: { rank: expectation.target }, tags: ["board-target", expectation.code] },
      about: null,
      sharp: false,
    },
  ];
  const signing = biggestSigning(state);
  if (signing) {
    facts.push({
      kind: "arrival",
      data: { name: signing.player.name, values: { fee: signing.fee }, tags: ["summer-top"] },
      about: signing.player.id,
      sharp: false,
    });
  }

  return {
    id: `press-opening-${state.season}`,
    date: state.date,
    trigger: "opening",
    reporterId: reporterFor(state, "opening"),
    context: `시즌 개막 전야 · ${input.opponent}전`,
    facts,
    status: "pending",
    weight: 1,
  };
}

/** 이번 시즌 우리가 가장 크게 지른 영입 — 없으면 없는 대로 (이적료 0은 지른 것이 아니다) */
function biggestSigning(state: GameState): { player: GamePlayer; fee: number } | null {
  let best: { player: GamePlayer; fee: number } | null = null;
  for (const t of state.transfers) {
    if (t.toTeamId !== state.userTeamId || t.date < state.calendar.preseasonStart) continue;
    if (t.fee <= 0 || (best && t.fee <= best.fee)) continue;
    const player = playerById(state, t.gamePlayerId);
    if (player) best = { player, fee: t.fee };
  }
  return best;
}

/**
 * 전야 회견 — **경기 전날에 선다** (people.md §4). tick이 하루에 한 번 부른다.
 *
 * 경기를 치르고 나면 경기 뒤 회견이 이 자리를 밀어내므로(`openPress`) 전야가
 * 아니면 자리가 없다. 트리거는 둘이고 **더비가 개막을 이긴다** — 개막전이 더비면
 * 물어야 할 것은 더비 쪽이다.
 */
export function openEvePress(state: GameState, digest?: string[]): void {
  const leagueId = leagueOfTeamIn(state, state.userTeamId);
  const tomorrow = addDays(state.date, 1);
  /**
   * **우리 리그 경기만이다.** 친선은 회견이 없고(season.md §2), 컵과 대항전은
   * 대회 id로 갈린다 — 대항전 리그 페이즈는 `stage`가 없어 단계로는 리그와
   * 구분되지 않는다.
   */
  const match = state.matches.find(
    (m) =>
      m.date === tomorrow &&
      !m.result &&
      m.competitionId === leagueId &&
      !isFriendly(m) &&
      (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
  );
  if (!match) return;

  const home = match.homeTeamId === state.userTeamId;
  const opponentId = home ? match.awayTeamId : match.homeTeamId;
  const opponent = teamNameIn(state, opponentId);
  const derby = derbyNameOf(state.userTeamId, opponentId);

  const conference = derby
    ? buildDerbyPress(state, match, { derby, opponentId, opponent, home })
    : isSeasonOpener(state, match, leagueId)
      ? buildOpeningPress(state, { opponent, home })
      : null;
  if (!conference) return;
  // 하루에 한 번 — 같은 날을 다시 지나도 자리가 둘이 되지 않는다
  if ((state.pressConferences ?? []).some((c) => c.id === conference.id)) return;
  openPress(state, conference, digest);
}

/** 이 경기가 이번 시즌 우리 첫 리그 경기인가 */
function isSeasonOpener(state: GameState, match: MatchRecord, leagueId: string): boolean {
  const first = leagueMatchesOfSeason(state, leagueId).reduce<string | null>(
    (min, m) => (min === null || m.date < min ? m.date : min),
    null,
  );
  return first !== null && match.date === first;
}

/** 답을 기다리는 회견 — 언제나 하나뿐이다 */
export function pendingPress(state: GameState): PressConference | null {
  return (state.pressConferences ?? []).find((c) => c.status === "pending") ?? null;
}

/**
 * 열린 회견을 **대가 없이** 닫는다 — 이직이 유일한 자리다 (career.md §5.1).
 *
 * `openPress`의 방치와 갈리는 지점: 감독이 답하지 않은 것이 아니라 **물을 구단이
 * 없어진 것**이다. 그대로 두면 새 구단의 첫 회견이 앞 구단의 자리를 거절로 닫아
 * 이유 없이 언론 평판이 깎인다.
 */
export function expirePendingPress(state: GameState): void {
  const open = pendingPress(state);
  if (open) open.status = "expired";
}

/**
 * 회견을 상태에 올린다.
 *
 * ⚠️ **앞의 회견이 열린 채로 새 회견이 오면 앞의 것은 거절로 닫힌다.** 감독이
 * 답하지 않고 다음 경기로 가버린 것이고, 실제로도 그 자리는 지나간 것이다.
 * 대가도 거절과 같아야 한다 — 무시가 공짜면 아무도 답하지 않는다.
 */
export function openPress(state: GameState, conference: PressConference, digest?: string[]): void {
  state.pressConferences ??= [];
  const stale = pendingPress(state);
  if (stale) {
    applyPressOutcome(state, stale, null);
    stale.status = "declined";
    digest?.push(`${stale.context} 회견에 감독이 나타나지 않았다 — 언론 평판 하락`);
    pushNarrative(state, `기자회견 불참 (${stale.context})`, 2);
  }
  loadLeaks(state, conference);
  state.pressConferences.push(conference);
  // 지나간 회견은 서사에 남지 상태로 쌓일 이유가 없다
  if (state.pressConferences.length > KEPT_CONFERENCES) {
    state.pressConferences = state.pressConferences.slice(-KEPT_CONFERENCES);
  }
  digest?.push(`기자회견 — ${conference.context}`);
}

export interface PressEffect {
  board: number;
  media: number;
  squad: number;
  /** 지목된 선수의 사기 변화 */
  target: number;
  targetName: string | null;
  /** 팀 전체 사기 변화 */
  team: number;
}

/**
 * 답변(또는 거절)의 효과를 반영한다 — **한도 안에서만.** `stance`가 null이면 거절.
 *
 * 이 함수는 회견의 `status`를 건드리지 않는다 — 라벨은 부르는 쪽이 정한다
 * (`openPress`가 방치를 거절로 닫을 때도 이 함수를 쓴다).
 */
export function applyPressOutcome(
  state: GameState,
  conference: PressConference,
  stance: PressStance | null,
  targetPlayerId?: string | null,
): PressEffect {
  /**
   * 지목된 선수 — **팀 전체 위에 더 얹는다.** 공개적으로 감싸이거나 잘린 당사자는
   * 같은 말을 남의 이야기로 듣지 않는다. 이름을 부른 질문이 없으면 없다.
   */
  const askedAbout =
    targetPlayerId ?? conference.facts.find((f) => f.about !== null)?.about ?? null;
  return applyStanceOutcome(state, {
    row: stanceRow(stance),
    band: PRESS_BAND * conference.weight,
    targetPlayerId: askedAbout,
  });
}

/** 스탠스 한 줄 — `null`이면 답하지 않은 것이다. 표를 여는 유일한 문 */
export function stanceRow(stance: PressStance | null): Record<PressAxis, number> {
  return stance === null ? DECLINE : STANCE_TABLE[stance];
}

/** 자리가 닿을 수 있는 축 전부 — 회견은 마이크 앞이라 하나도 죽지 않는다 */
const ALL_AXES: readonly PressAxis[] = ["board", "media", "squad", "target", "team"];

/**
 * 스탠스 한 줄을 실제 변화로 옮긴다 — **표도 리더십 계수도 여기 하나뿐이다.**
 *
 * 회견과 다가옴이 같은 함수를 쓰는 이유가 그것이다(people.md §8): 두 자리가 표를
 * 따로 들면 "감싸기가 라커룸을 얼마나 올리는가"가 두 값이 되고, 한쪽만 고쳐진 채
 * 오래 산다.
 *
 * @param axes 이 자리가 닿는 축. 없으면 전부 — 사석의 대화는 언론 축을 뺀다.
 */
export function applyStanceOutcome(
  state: GameState,
  input: {
    row: Record<PressAxis, number>;
    /** 한도 — 이 자리가 옮길 수 있는 폭 */
    band: number;
    targetPlayerId?: string | null;
    axes?: readonly PressAxis[];
  },
): PressEffect {
  const live = new Set(input.axes ?? ALL_AXES);
  const on = (axis: PressAxis) => (live.has(axis) ? input.row[axis] : 0);
  const band = input.band;
  const lead = leadershipFactor(state);

  const board = Math.round(on("board") * band);
  const media = Math.round(on("media") * band);
  const squad = Math.round(on("squad") * band);
  const rep = state.manager.reputation;
  rep.board = clampRep(rep.board + board);
  rep.media = clampRep(rep.media + media);
  rep.squad = clampRep(rep.squad + squad);

  // 팀 전체 — 라커룸도 회견을 본다
  const team = Math.round(on("team") * band * lead);
  if (team !== 0) {
    for (const p of userPlayers(state)) p.state.form = clampForm(p.state.form + moraleToForm(team));
  }

  const targetPlayer = input.targetPlayerId
    ? (userPlayers(state).find((p) => p.id === input.targetPlayerId) ?? null)
    : null;
  const target = targetPlayer ? Math.round(on("target") * band * lead) : 0;
  if (targetPlayer && target !== 0) {
    targetPlayer.state.form = clampForm(targetPlayer.state.form + moraleToForm(target));
  }

  return { board, media, squad, target, targetName: targetPlayer?.name ?? null, team };
}

/** 반려에서 후보 목록을 가리키는 이름 — 감독에게 할 말이 아니라 어디를 봤는지의 사실이다 */
const PRESS_CARD = "이 회견의 사실 카드";

/** 이 회견에서 이름을 부를 수 있는 선수 — **카드에 오른 이름이 전부다** */
function cardPlayers(state: GameState, conference: PressConference): GamePlayer[] {
  const named = new Set(conference.facts.map((f) => f.about).filter((id) => id !== null));
  return [...named].map((id) => playerById(state, id)).filter((p) => p !== null);
}

/** 부호를 붙인 한 줄 — 0은 쓰지 않는다 */
export const signed = (label: string, v: number) =>
  v === 0 ? null : `${label} ${v > 0 ? "+" : ""}${v}`;

/**
 * `respond_to_media` — 감독이 회견에 답한다. **판정형**이다.
 * LLM은 스탠스와 (있다면) 겨눈 선수만 정하고, 변화량은 이 파일의 표가 정한다.
 */
export function respondToMedia(
  state: GameState,
  input: { stance: PressStance; targetPlayerId?: string | null },
): SkillResult {
  const conference = pendingPress(state);
  if (!conference) return { ok: false, message: "지금 답할 기자회견이 없습니다" };

  /**
   * 지목은 **사실 카드 안에서만** 선다 — 기자가 묻지 못한 사실(people.md §4)에
   * 감독의 답이 닿을 수는 없다. 밖을 겨누면 되돌린다: 감독이 부르지 않은 선수의
   * 사기가 회견 한 번에 움직이는 것이 반려보다 나쁘다.
   */
  const ref = input.targetPlayerId?.trim() ?? "";
  let target: string | null = null;
  if (ref !== "") {
    const picked = pickPlayerAmong(state, cardPlayers(state, conference), ref, PRESS_CARD);
    if (!picked.ok) return picked;
    target = picked.player.id;
  }

  const effect = applyPressOutcome(state, conference, input.stance, target);
  conference.status = "answered";

  const parts = [
    signed("보드", effect.board),
    signed("언론", effect.media),
    signed("선수단", effect.squad),
    effect.targetName ? signed(`${effect.targetName} 사기`, effect.target) : null,
    signed("팀 사기", effect.team),
  ].filter((x): x is string => x !== null);

  pushNarrative(
    state,
    `기자회견 — ${conference.context} (${STANCE_KO[input.stance]})`,
    conference.weight >= 3 ? 4 : 3,
  );
  // 여러 축이 갈리므로 **합**으로 결을 읽는다 — 보드는 올랐는데 라커룸이 상했으면
  // 좋은 회견이 아니다. 색 하나가 그 종합이고, 항목별 숫자는 펼쳤을 때 보인다
  const net = effect.board + effect.media + effect.squad + effect.team + effect.target;
  return {
    ok: true,
    tone: net >= 0 ? ("good" as const) : ("bad" as const),
    message:
      `기자회견 대응(${STANCE_KO[input.stance]})` +
      (parts.length > 0 ? ` — ${parts.join(" · ")}` : ""),
    /**
     * 축마다 한 줄이다 — `delta` 하나가 그 줄의 부호라, 여럿을 한 항목에 묶으면
     * 화면이 다시 갈라야 한다. 감독이 무슨 말을 했는지는 장면의 것이다.
     */
    brief: {
      head: `기자회견 대응(${STANCE_KO[input.stance]})`,
      items: deltaItems([
        ["보드", effect.board],
        ["언론", effect.media],
        ["선수단", effect.squad],
        effect.targetName ? [`${effect.targetName} 사기`, effect.target] : null,
        ["팀 사기", effect.team],
      ]),
    },
  };
}

/**
 * 회견 거절 — **하나의 답이다.** 감독이 마이크를 잡지 않는 것도 세계가 읽는다.
 * 실제로도 의무 회견 불참은 벌금과 비판을 부른다.
 */
export function declinePress(state: GameState): SkillResult {
  const conference = pendingPress(state);
  if (!conference) return { ok: false, message: "지금 열린 기자회견이 없습니다" };
  const effect = applyPressOutcome(state, conference, null);
  conference.status = "declined";
  pushNarrative(state, `기자회견 거절 (${conference.context})`, 3);
  const parts = [
    signed("보드", effect.board),
    signed("언론", effect.media),
    signed("선수단", effect.squad),
  ].filter((x): x is string => x !== null);
  return {
    ok: true,
    message: `기자회견에 응하지 않았습니다` + (parts.length > 0 ? ` — ${parts.join(" · ")}` : ""),
    brief: {
      head: "기자회견 거절",
      items: deltaItems([
        ["보드", effect.board],
        ["언론", effect.media],
        ["선수단", effect.squad],
      ]),
    },
  };
}

export const STANCE_KO: Record<PressStance, string> = {
  defend: "감싸기",
  own: "책임 인정",
  criticise: "공개 비판",
  bold: "도발",
  deflect: "말 아끼기",
};

/**
 * 스냅샷 블록 — 답을 기다리는 회견이 있을 때만 (매 턴 정가로 읽히는 블록이다).
 *
 * **질문이 아니라 사실을 넘긴다.** 기자의 말은 GM이 이 카드들로 직접 쓴다.
 */
export function describePendingPress(state: GameState): string | null {
  const c = pendingPress(state);
  if (!c) return null;
  return [
    `${c.context}${c.weight >= 3 ? " · 큰 자리다" : ""}`,
    `기자가 아는 사실 (이 밖은 묻지 못한다):`,
    ...c.facts.map(
      (f) => `- ${pressFactText(f)}${f.about ? ` [${f.about}]` : ""}${f.sharp ? " ⚡" : ""}`,
    ),
  ].join("\n");
}
