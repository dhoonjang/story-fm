import type {
  ApproachTopic,
  BoardExpectationCode,
  GamePlayer,
  ManagerContract,
  MatchRecord,
  MatchStage,
  PressAxis,
  PressConference,
  PressFact,
  PlayerIssueReason,
  PressStance,
  PressTrigger,
  RivalVoice,
} from "@story-fm/domain";
import {
  ageOf,
  interestStageRank,
  isNaturalAt,
  isReserveMatch,
  isSymbolicNumber,
  naturalPositionOf,
  PLAYER_ISSUE_REASONS,
  pressFactText,
  RATING_MAX,
  RENEWAL_NOTICE_DAYS,
} from "@story-fm/domain";
import type { GameState } from "../core/state";
import {
  activeContract,
  firstTeamPlayers,
  playerById,
  playersOf,
  pushNarrative,
  teamNameIn,
  userPlayers,
} from "../core/state";
import { pickPlayerAmong } from "../core/player-ref";
import { addDays, diffDays } from "../core/dates";
import { formatMoney } from "./finance";
import { makeRng, pick } from "../core/rng";
import { clampForm, formLabel, moraleToForm } from "../squad/form";
import { careerTotalsOf, matchMilestones } from "../squad/career";
import { managerCareerTotals } from "../competition/records";
import { numberLineageOf } from "../squad/numbers";
import { recentOutcomes } from "../squad/slump";
import { isFriendly } from "../competition/friendly";
import { boardExpectation, computeStandings, retirementJudgeDate } from "../competition/season";
import { leagueOfTeamIn } from "../competition/promotion";
import { derbyNameOf, derbyOf } from "../data/derbies";
import { derbyRecordOf } from "./derby";
import { reportersOf, rivalVoiceOf } from "../world/persona";
import { MANAGER_SUBJECT, moveRelation, stanceRelationEvent } from "../world/relations";
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
  defend: { board: -0.2, media: -0.4, squad: 1, target: 1, team: 0.5, rival: -0.3 },
  own: { board: 0.6, media: 0.2, squad: 0.6, target: 0.3, team: 0.25, rival: 0 },
  criticise: { board: 0.3, media: 0.8, squad: -0.9, target: -1, team: -0.5, rival: -0.8 },
  bold: { board: -0.3, media: 1, squad: 0.4, target: 0.4, team: 0.4, rival: -0.6 },
  deflect: { board: 0, media: -0.3, squad: 0, target: 0, team: 0, rival: 0 },
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
  // 답하지 않은 자리는 남의 라커룸에 닿지 않는다 — 겨눈 사람이 없다
  rival: 0,
};

// ── 상대 감독의 말 (people.md §4) ──────────────────────────────

/**
 * 상대 라커룸이 움직일 수 있는 폭 — **회견의 `weight`를 곱하지 않는다.**
 *
 * 남의 라커룸은 우리 회견이 얼마나 큰 자리였는지를 모른다. 최대치는 공개 비판의
 * 0.8 × 6 = 4.8 → 사기 5점이고, 폼으로는 0.139(유효 능력치 1.25%)다. 매일 평균으로
 * 0.0167씩 빠지므로 여드레면 사라진다 — **전야에 한 말이 그 경기에 닿고 시즌에는
 * 남지 않는다.**
 */
export const RIVAL_BAND = 6;

/**
 * 상대 감독을 겨눈 답이 **우리 라커룸**에 남기는 몫 — 표의 팀 사기 열을 갈아 끼운다.
 *
 * 어떤 스탠스든 같은 값인 이유: 그 말이 우리 선수를 향한 적이 없다. 라커룸이 읽는
 * 것은 「감독이 우리 편을 들었다」 하나뿐이라 공개 비판이 우리 방을 식히지 않는다.
 */
const RIVAL_TALK_LIFT = 0.3;

/**
 * **같은 말도 누구에게 하느냐로 방향이 뒤집힌다** (people.md §4).
 *
 * 표의 `rival` 열은 「도발이 먹히는 상대」 기준이고, 여기가 그 부호를 정한다.
 * 그래서 이 게임에서 설전은 도박이 아니라 판단이다 — 반대편 벤치가 누구인지는
 * 카드가 이미 들고 있다.
 */
const RIVAL_TEMPER: Record<RivalVoice, number> = {
  /** 되받아친다 — 찌르면 그 라커룸이 더 뛴다 */
  provoke: -1,
  respect: 1,
  patience: 1,
  defensive: 1,
  /** 흔들리지 않는다 — 경기를 구조로만 보는 사람이다 */
  analysis: 0,
};

/**
 * 더비가 그 말이 설 확률에 더하는 몫 — 원형이 정한 확률 위에 얹는다.
 * 더비 전야에 아무도 말하지 않으면 이 자리가 있을 이유가 없다.
 */
const RIVAL_VOICE_DERBY_BONUS = 0.25;

/**
 * 이 대진의 반대편 벤치가 마이크 앞에 서는가 — 서면 사실 한 장 (people.md §4).
 *
 * **친선과 2군 경기는 지나간다**: 친선 뒤에는 회견이 없고(season.md §2), 2군 경기는
 * 감독이 보지도 않는 자리다. 추첨은 `(시드, 경기, 자리)`라 전야와 경기 뒤가 독립이고,
 * 같은 세이브를 다시 지나도 같은 결과다.
 */
export function rivalQuoteFact(
  state: GameState,
  match: MatchRecord,
  seat: "eve" | "post",
): PressFact | null {
  if (isFriendly(match) || isReserveMatch(match)) return null;
  const opponentId = match.homeTeamId === state.userTeamId ? match.awayTeamId : match.homeTeamId;
  const voice = rivalVoiceOf(state, opponentId);
  if (!voice) return null;
  const chance =
    voice.chance + (derbyOf(state.userTeamId, opponentId) ? RIVAL_VOICE_DERBY_BONUS : 0);
  if (makeRng(state.seed, `rival-quote:${seat}:${match.id}`)() >= chance) return null;
  return {
    kind: "rival-quote",
    data: { refId: opponentId, name: voice.name, tags: [voice.code] },
    about: null,
    /** 찌르는 말만 날 선 자리다 — 나머지는 기자가 물어봐 줄 일이다 */
    sharp: voice.code === "provoke",
  };
}

/**
 * 이 회견에서 감독이 겨눌 수 있는 상대 감독 — **카드에 오른 그 사람이 전부다.**
 * 선수 지목과 같은 규약이다 (people.md §4).
 */
function cardManager(
  conference: PressConference,
): { name: string; teamId: string; code: RivalVoice } | null {
  for (const fact of conference.facts) {
    if (fact.kind !== "rival-quote") continue;
    const name = fact.data?.name;
    const teamId = fact.data?.refId;
    const code = fact.data?.tags?.[0] as RivalVoice | undefined;
    if (name !== undefined && teamId !== undefined && code !== undefined) {
      return { name, teamId, code };
    }
  }
  return null;
}

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

/**
 * 녹아웃 단계 — **경기 뒤 회견의 무게가 대회를 읽는 자리** (people.md §4).
 * 리그 페이즈만 도는 대항전 경기는 `stage`가 없어 평소 규칙 그대로다.
 */
const KNOCKOUT_STAGES: readonly MatchStage[] = ["playoff", "r32", "r16", "qf", "sf", "final"];

/**
 * 이 자리가 얼마나 큰가 — 한도가 여기에 비례한다.
 *
 * 결승을 3으로 두는 것은 시즌에서 가장 큰 하루가 리그 평일 경기와 같은 무게로
 * 지나가지 않게 하려는 것이고, 시즌 최종전이 3인 것도 같은 이유다 — 그 자리에서
 * 묻는 것은 그 경기가 아니라 그 시즌이다.
 */
function weightOf(trigger: PressTrigger, sharp: boolean, stage?: MatchStage): 1 | 2 | 3 {
  if (trigger === "pressure" || trigger === "season-end") return 3;
  if (stage === "final") return 3;
  if (trigger === "transfer" || trigger === "appointment") return 2;
  // 작별은 결과와 무관하게 구단의 자리다 — 더비 전야가 무게 2인 것과 같은 이유
  if (trigger === "farewell") return 2;
  if (stage !== undefined && KNOCKOUT_STAGES.includes(stage)) return 2;
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
  // 한 사람의 마지막 홈경기는 구단과 팬의 자리다 — 전술도 뒷이야기도 아니다
  farewell: 0,
  // 부임도 시즌 최종전도 구단의 내일을 묻는 자리다 — 팬을 대신하는 지역지의 몫
  appointment: 0,
  "season-end": 0,
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
  /**
   * **어긴 약속이 가장 먼저다** (people.md §5·§5-2) — 부진도 다른 불만도 세계가
   * 만든 일이지만, 어긴 약속은 **감독 자신이 세운 원인**이라 기자가 가장 먼저 묻는
   * 자리다. 폼보다 앞에 두는 것은 그래서다: 부진은 물어볼 일이고 약속 파기는
   * 해명을 요구할 일이다.
   */
  const promiseHolder = squad.find((p) =>
    state.issues.some((i) => i.gamePlayerId === p.id && i.reason === "promise"),
  );
  if (promiseHolder) return promiseHolder;
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
  /**
   * **더비는 끝난 뒤에도 자리를 남긴다** (people.md §4). 이기고도 묻는 것은 더비가
   * 결과와 무관하게 팬과 구단의 자리이기 때문이고(전야 회견이 무게 2인 것과 같은
   * 이유), 날 선 카드라 이 회견의 무게가 언제나 2가 된다.
   *
   * 전적은 **이번 경기를 빼고** 센다 — 넣으면 첫 더비가 이미 1승 0패로 시작한다.
   */
  const derby = derbyOf(state.userTeamId, opponentId);
  if (derby) {
    const record = derbyRecordOf(state, opponentId, matchId);
    facts.push({
      kind: "result",
      data: {
        refId: opponentId,
        name: opponent,
        values: { won: record.won, drawn: record.drawn, lost: record.lost, heat: derby.heat },
        tags: ["derby", derby.name],
      },
      about: null,
      sharp: true,
    });
  }
  /**
   * **상대 벤치도 그날 마이크 앞에 섰다** (people.md §4) — 자리를 열지 않고 이미
   * 열리는 자리에 얹힌다. 결과 카드 바로 뒤인 것은 그 말이 이 경기에 대한 것이라서다.
   */
  const rivalQuote = rivalQuoteFact(state, match, "post");
  if (rivalQuote) facts.push(rivalQuote);

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
    const reason = issueReasonOf(state, target.id);
    /**
     * ⚠️ **어긴 약속은 폼을 이긴다.** 약속 파기는 사기를 `PROMISE.brokenMorale`(−8)
     * 깎으므로 그 선수의 폼은 대개 함께 내려가 있다 — 폼으로 카드를 고르면 그를
     * 부른 이유가 지워지고 기자가 "폼이 떨어졌다"를 묻는다 (people.md §5-2).
     */
    const slumping = reason !== "promise" && target.state.form < SLUMPING_FORM;
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

  /**
   * 은퇴 예고와 작별 — 1월에 선 예고는 2주 안의 회견에, 마지막 홈경기의 결과는 그
   * 경기의 회견에 실린다 (season.md §6). 둘은 같은 자리에 함께 서지 않는다: 예고는
   * 1월이고 마지막 홈경기는 5월이다.
   */
  facts.push(...retirementFacts(state), ...farewellResultFacts(state, match));

  /** 감독 자신의 통산이 넘은 문턱 — 그 경기의 회견에만 실린다 (career.md §6) */
  const managerHit = managerMilestoneFact(state, match, outcome);
  if (managerHit) facts.push(managerHit);

  /**
   * **시즌 최종전이면 그 시즌을 묻는 자리로 갈린다** (people.md §4). 결과도
   * 마일스톤도 평소처럼 서고, 그 위에 지금 선 자리와 보드가 건 자리가 얹힌다.
   *
   * ⚠️ 순위는 **그날의 순위표**다 — 같은 라운드의 남은 경기가 아직 안 치러졌을 수
   * 있어, 최종 확정은 시즌 리뷰의 것이다 (career.md §6). 감독이 보는 표와 기자가
   * 아는 표가 같아야 하므로 여기서 미리 확정하지 않는다.
   */
  const seasonFinale = isSeasonFinale(state, match);
  if (seasonFinale) facts.push(...seasonEndFacts(state));

  const trigger: PressTrigger = seasonFinale ? "season-end" : winless ? "pressure" : "match";
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
      `${seasonFinale ? "시즌 최종전 · " : ""}${derby ? `${derby.name} · ` : ""}` +
      `${opponent}전 ${score} ${outcomeKo}` +
      (winless ? ` · 최근 ${recent.length}경기 무승` : ""),
    facts,
    status: "pending",
    weight: weightOf(
      trigger,
      facts.some((f) => f.sharp),
      match.stage,
    ),
  };
}

// ── 감독의 통산 (career.md §6) ─────────────────────────

/**
 * 감독 통산의 눈금 — **경기와 승.** 밸런스를 손볼 자리가 이 표 하나다.
 *
 * 선수의 출전·득점 눈금(`MILESTONE_APP_STEPS`)과 값이 겹치지만 표를 나눠 두는 것은
 * 세는 것이 다르기 때문이다 — 한 표로 묶으면 감독의 300승을 손보려다 선수의 골
 * 문턱이 함께 움직인다.
 */
const MANAGER_MILESTONES: Record<"matches" | "wins", readonly number[]> = {
  matches: [50, 100, 200, 300, 400, 500],
  wins: [25, 50, 100, 150, 200, 300],
};

/** 그 사이에 넘은 눈금 — 없으면 null. 한 경기가 두 칸을 넘을 수는 없다 */
function crossedStep(steps: readonly number[], before: number, after: number): number | null {
  return steps.find((step) => before < step && after >= step) ?? null;
}

/**
 * 이 경기가 감독의 통산에서 넘은 문턱 — **하나만.** 경기 눈금과 승 눈금이 한 경기에
 * 함께 걸리면(100경기째의 50승) 승 쪽이 선다: 드문 쪽이 그 회견의 사실이다.
 *
 * 통산은 리그 경기로 세므로(career.md §6) 컵·대항전 뒤에는 넘을 문턱이 없다.
 * 날 선 자리가 아니다 — 선수 마일스톤과 같다: 캐물을 일이 아니라 물어봐 줄 일이다.
 */
function managerMilestoneFact(
  state: GameState,
  match: MatchRecord,
  outcome: "win" | "draw" | "loss",
): PressFact | null {
  if (match.competitionId !== leagueOfTeamIn(state, state.userTeamId)) return null;
  // 이 함수는 마감이 결과를 적은 **뒤**에 불린다 — 통산은 이미 이 경기를 세고 있다
  const after = managerCareerTotals(state);
  const wins =
    outcome === "win" ? crossedStep(MANAGER_MILESTONES.wins, after.wins - 1, after.wins) : null;
  const step =
    wins !== null
      ? { code: "wins", value: wins }
      : (() => {
          const hit = crossedStep(MANAGER_MILESTONES.matches, after.matches - 1, after.matches);
          return hit === null ? null : { code: "matches", value: hit };
        })();
  if (!step) return null;
  return {
    kind: "manager-milestone",
    data: { values: { value: step.value }, tags: [step.code] },
    about: null,
    sharp: false,
  };
}

// ── 시즌 최종전 (people.md §4) ─────────────────────────

/** 그 시즌 우리 **마지막 리그 경기**인가 — 달력이 시즌 초부터 아는 사실이다 */
function isSeasonFinale(state: GameState, match: MatchRecord): boolean {
  const leagueId = leagueOfTeamIn(state, state.userTeamId);
  if (match.competitionId !== leagueId) return false;
  const last = leagueMatchesOfSeason(state, leagueId).reduce<string | null>(
    (max, m) => (max === null || m.date > max ? m.date : max),
    null,
  );
  return last !== null && match.date === last;
}

/**
 * 시즌 최종전의 사실 — **지금 선 자리와 보드가 건 자리.** 기대에 못 미치면 날 선
 * 자리가 된다: 그 시즌을 묻는 자리에서 감독이 답해야 할 것이 그것이다.
 */
function seasonEndFacts(state: GameState): PressFact[] {
  const expectation = boardExpectation(state, state.userTeamId);
  const standings = computeStandings(state);
  const index = standings.findIndex((row) => row.ours);
  const row = standings[index];
  const facts: PressFact[] = [];
  if (row) {
    facts.push({
      kind: "standing",
      data: { values: { rank: index + 1, played: row.played }, tags: [] },
      about: null,
      sharp: index + 1 > expectation.target,
    });
  }
  facts.push({
    kind: "standing",
    data: { values: { rank: expectation.target }, tags: ["board-target", expectation.code] },
    about: null,
    sharp: false,
  });
  return facts;
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

/**
 * **번호를 물려받았다** — 계보가 있는 번호를 지금 달고 있을 때만 (player.md §1.1).
 *
 * 앞서 아무도 뛰지 않은 번호에는 물려받을 것이 없어 카드가 서지 않는다 — 없는 계보를
 * 카드로 세우면 기자가 그 없음을 사실로 옮겨 적는다.
 */
function numberInheritedFact(state: GameState, player: GamePlayer): PressFact | null {
  const number = player.squadNumber;
  if (number === undefined) return null;
  const after = numberLineageOf(state, player.teamId, number).past[0];
  if (!after) return null;
  return {
    kind: "number-inherited",
    data: {
      name: after.name,
      values: { number, seasons: after.seasons, since: state.season - after.lastSeason },
      tags: [],
    },
    about: player.id,
    sharp: false,
  };
}

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
          // 새 셔츠가 누구의 것이었나 — 계보가 없는 번호에는 서지 않는다
          ...[numberInheritedFact(state, player)].filter((f): f is PressFact => f !== null),
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
 *
 * 회견이 열릴 자격(§4)과 라커룸 불만이 걸릴 자격(§5 — 등재·계약)이 **같은 자를
 * 쓴다.** 둘이 갈리면 회견은 열리는데 불만은 안 서는 선수가 생긴다.
 */
export function betterThanInSquad(state: GameState, player: GamePlayer): number {
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

// ── 부임 회견 (career.md §5.1) ─────────────────────────

/**
 * 부임 회견 — **부임한 날의 자리.** 새 게임의 첫날(`createGame`)과 이직·부임
 * (`acceptManagerOffer`)이 같은 문을 지난다 (people.md §4).
 *
 * 앞 구단의 열린 회견은 부임이 이미 `expired`로 닫은 뒤라(career.md §5.1) 이 자리가
 * 그것을 거절로 읽지 않는다 — 순서가 뒤집히면 이직 하나로 언론 평판이 깎인다.
 *
 * ⚠️ **이적 예산의 숫자는 이 자리에 서지 않는다.** 회견에서 밝힌 금액은 약속이 되고,
 * 예산은 감독이 답할 사실이 아니라 감독이 쓰는 값이다 — 계약과 함께 온 약속만
 * 계약 카드에 붙는다.
 *
 * @param predecessor 전임이 물러난 자리 — 제안이 들고 온 사실이다. 없으면 카드도 없다.
 */
export function buildAppointmentPress(
  state: GameState,
  predecessor?: { position?: number; target: number; expectationCode: BoardExpectationCode },
): PressConference {
  const facts: PressFact[] = [];
  if (predecessor) {
    facts.push({
      kind: "sacking",
      data: {
        refId: state.userTeamId,
        name: teamNameIn(state, state.userTeamId),
        values: {
          target: predecessor.target,
          ...(predecessor.position === undefined ? {} : { position: predecessor.position }),
        },
        tags: ["predecessor", predecessor.expectationCode],
      },
      about: null,
      sharp: false,
    });
  }
  const expectation = boardExpectation(state, state.userTeamId);
  facts.push({
    kind: "standing",
    data: { values: { rank: expectation.target }, tags: ["board-target", expectation.code] },
    about: null,
    sharp: false,
  });
  /**
   * 지금 선 자리는 **시즌 중 부임일 때만**이다 — 한 경기도 안 치른 구단의 "1위"는
   * 사실이 아니라 알파벳 순이다.
   */
  const standings = computeStandings(state);
  const index = standings.findIndex((row) => row.ours);
  const row = standings[index];
  if (row && row.played > 0) {
    facts.push({
      kind: "standing",
      data: { values: { rank: index + 1, played: row.played }, tags: [] },
      about: null,
      sharp: index + 1 > expectation.target,
    });
  }
  const key = keyPlayerFact(state);
  if (key) facts.push(key);
  const contract = state.manager.contract;
  if (contract) {
    facts.push({
      kind: "manager-contract",
      data: {
        values: {
          years: Math.max(
            1,
            Math.round(diffDays(contract.signedOn, contract.until) / DAYS_PER_YEAR),
          ),
          salary: contract.salary,
        },
        tags: ["signed"],
      },
      about: null,
      sharp: false,
    });
  }
  return {
    id: `press-appointment-${state.userTeamId}-${state.date}`,
    date: state.date,
    trigger: "appointment",
    reporterId: reporterFor(state, "appointment"),
    context: `${teamNameIn(state, state.userTeamId)} 부임`,
    facts,
    status: "pending",
    weight: weightOf("appointment", false),
  };
}

/** 계약 연수를 되짚는 자 — 체결일과 만료일 사이의 해 (`contractUntil`의 역) */
const DAYS_PER_YEAR = 365;

/**
 * 부임 회견을 연다 — **하루에 한 번.** 같은 날을 다시 지나도 자리가 둘이 되지 않는다.
 */
export function openAppointmentPress(
  state: GameState,
  predecessor?: { position?: number; target: number; expectationCode: BoardExpectationCode },
  digest?: string[],
): void {
  const conference = buildAppointmentPress(state, predecessor);
  if ((state.pressConferences ?? []).some((c) => c.id === conference.id)) return;
  openPress(state, conference, digest);
}

/**
 * 이 선수단의 중심 — **1군 최고 종합 자원.** 감독이 부임 회견에서 이름을 부를 수 있는
 * 유일한 자리라 `about`이 걸린다 (people.md §4).
 *
 * 드는 사실은 자리·나이·계약 만료일이다 — 부임 전 커리어는 장부에 없으므로
 * (`careerTotalsOf`) 통산 출전은 새 게임의 첫날에 0경기로 선다. 없는 것은 묻지 않는다.
 */
function keyPlayerFact(state: GameState): PressFact | null {
  const best = userPlayers(state)
    .filter((p) => p.squadLevel === "first")
    .reduce<GamePlayer | null>(
      (top, p) => (top === null || p.attributes.overall > top.attributes.overall ? p : top),
      null,
    );
  if (!best) return null;
  const contract = activeContract(state, best.id);
  return {
    kind: "key-player",
    data: {
      name: best.name,
      tags: [naturalPositionOf(best).position],
      values: {
        age: ageOf(best.birthdate, state.date),
        ...(contract ? { contractDays: Math.max(0, diffDays(state.date, contract.until)) } : {}),
      },
    },
    about: best.id,
    sharp: false,
  };
}

// ── 감독 자신의 거취 (career.md §5.4) ──────────────────

/**
 * 만료 90일 안이면 **어느 회견이든** 감독의 거취가 선다 (people.md §4).
 *
 * ⚠️ 유출과 달리 **소비되지 않는다.** 원인이 계약 그 자체라 만료일까지 사라지지
 * 않고, 보드의 판정이 갈리면 다음 회견이 새 코드로 다시 묻는다.
 */
function loadManagerContract(state: GameState, conference: PressConference): void {
  // 부임 회견은 새로 선 계약을 이미 들고 있다 — 같은 사실을 두 줄로 묻지 않는다
  if (conference.trigger === "appointment") return;
  const contract = state.manager.contract;
  if (!contract || state.dismissal) return;
  const days = diffDays(state.date, contract.until);
  if (days < 0 || days > RENEWAL_NOTICE_DAYS) return;
  conference.facts.push({
    kind: "manager-contract",
    data: { values: { days }, tags: [renewalCode(contract)] },
    about: null,
    sharp: true,
  });
  conference.weight = Math.max(conference.weight, 2);
}

/** 보드의 판정 코드 — 판정 전인가, 재계약 제안인가, 비갱신 통보인가 (career.md §5.4) */
function renewalCode(contract: ManagerContract): string {
  if (contract.renewalDecidedOn === undefined) return "undecided";
  return contract.renewalOffered ? "renewal" : "no-renewal";
}

// ── 라이벌의 경질 (people.md §4) ───────────────────────

/**
 * 라이벌 구단이 감독을 잘랐다 — **유출과 같은 문을 지난다.** 다음에 열리는 회견이
 * 싣고 대기열을 비운다. 자리를 따로 열지 않는 이유도 같다: 회견은 이미 경기마다 열린다.
 *
 * 날 선 자리가 아니다 — 남의 집 벤치는 감독을 몰아세우는 사실이 아니라 기자가
 * 곁들여 묻는 사실이다.
 */
function loadSackings(state: GameState, conference: PressConference): void {
  const rows = state.pressSackings ?? [];
  if (rows.length === 0) return;
  for (const row of rows) {
    // 이직하면 앞 구단의 라이벌은 라이벌이 아니다 — 남의 더비를 새 구단 기자가 묻지 않는다
    if (!derbyOf(state.userTeamId, row.teamId)) continue;
    conference.facts.push({
      kind: "sacking",
      data: {
        refId: row.teamId,
        name: teamNameIn(state, row.teamId),
        values: {
          days: diffDays(row.date, state.date),
          ...(row.position === undefined ? {} : { position: row.position }),
        },
        tags: ["rival"],
      },
      about: null,
      sharp: false,
    });
  }
  // 실렸든 아니든 이 자리를 지나면 없다 — 다음 회견이 같은 사실을 다시 묻지 않는다
  state.pressSackings = [];
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

// ── 이적 요청 ──────────────────────────────────────────────────

/**
 * 선수가 나가겠다고 말했다 — **유출과 같은 문을 지난다** (people.md §4 ·
 * transfer.md §1-1). 요청이 선 날과 감독이 답한 날, 다음에 열리는 회견이 그 사실을
 * sharp로 싣고 그 자리의 무게는 최소 2가 된다.
 *
 * ⚠️ **요청 장부는 유출과 달리 소비되지 않는다.** 실어 간 자리(`pressedOn`)만
 * 적어 같은 사실을 두 번 묻지 않게 하고, 줄 자체는 원인이 사라질 때까지 남는다 —
 * 감독이 답하면 그 칸이 비워져 답한 사실이 다음 회견에 다시 실린다.
 */
function loadTransferRequests(state: GameState, conference: PressConference): void {
  let loaded = false;
  for (const request of state.transferRequests ?? []) {
    if (request.pressedOn !== undefined) continue;
    const player = playerById(state, request.gamePlayerId);
    // 떠난 선수의 요청은 조용히 건너뛴다 — 우리 라커룸에 없는 사람에게 물을 자리가 아니다
    if (!player || player.teamId !== state.userTeamId) continue;
    conference.facts.push({
      kind: "transfer-request",
      data: {
        name: player.name,
        values: { days: diffDays(request.since, state.date) },
        tags: [request.reason, ...(request.answer ? [request.answer] : [])],
      },
      about: player.id,
      sharp: true,
    });
    request.pressedOn = state.date;
    loaded = true;
  }
  if (loaded) conference.weight = Math.max(conference.weight, 2);
}

// ── 이적 루머 ──────────────────────────────────────────────────

/**
 * 한 회견에 오르는 루머 카드 수 — 셋을 실으면 그 자리가 이적 시장 브리핑이 된다
 * (people.md §4).
 */
const RUMOURS_PER_CONFERENCE = 2;

/**
 * 타 구단의 관심이 문의 이상으로 올랐다 — **유출·이적 요청과 같은 문을 지난다**
 * (people.md §4 · transfer.md §1-2).
 *
 * ⚠️ **관심 장부는 요청과 같이 소비되지 않는다.** 실어 간 자리(`pressedOn`)만
 * 적어 같은 사실을 두 번 묻지 않게 하고, 줄 자체는 사다리가 걷힐 때까지 남는다 —
 * 칸이 오르면 `market/interest.ts`가 그 자리를 비워, 「보고 있다」와 「값을 부를
 * 참이다」가 각각 한 번씩 회견에 선다.
 */
function loadRumours(state: GameState, conference: PressConference): void {
  const rows = (state.interests ?? [])
    .filter((row) => row.stage !== "watching" && row.pressedOn === undefined)
    // 우리 선수의 줄만 회견에 선다 — 떠난 선수도, 우리가 노리는 남의 선수도 물을 자리가 아니다
    .filter((row) => playerById(state, row.gamePlayerId)?.teamId === state.userTeamId)
    // 위 칸이 먼저다 — 값을 부를 참인 구단이 문의만 한 구단에 밀리지 않는다.
    // 같은 칸끼리는 id로 세운다: 같은 날 같은 세이브면 같은 두 장이어야 한다
    .sort((a, b) => {
      const byStage = interestStageRank(b.stage) - interestStageRank(a.stage);
      if (byStage !== 0) return byStage;
      if (a.gamePlayerId !== b.gamePlayerId) return a.gamePlayerId < b.gamePlayerId ? -1 : 1;
      return a.teamId < b.teamId ? -1 : 1;
    })
    .slice(0, RUMOURS_PER_CONFERENCE);
  if (rows.length === 0) return;
  for (const row of rows) {
    conference.facts.push({
      kind: "rumour",
      data: {
        name: teamNameIn(state, row.teamId),
        refId: row.teamId,
        values: { days: diffDays(row.since, state.date) },
        tags: [row.stage],
      },
      about: row.gamePlayerId,
      sharp: true,
    });
    row.pressedOn = state.date;
  }
  conference.weight = Math.max(conference.weight, 2);
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
  const inherited = summerNumberInheritance(state);
  if (inherited) facts.push(inherited);

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

/**
 * 이번 여름 감독이 **새로 물려준 상징 번호** — 없으면 카드도 없다 (player.md §1.1).
 *
 * 프리시즌 이후 번호가 움직인 사람만 본다(`squadNumberOn`) — 시즌 내내 같은 셔츠를
 * 입어 온 10번은 개막 전야에 물을 일이 아니다. **한 장뿐이다**: 여름에 번호가 여럿
 * 움직였다고 개막 회견이 번호 명부가 되지는 않는다.
 */
function summerNumberInheritance(state: GameState): PressFact | null {
  for (const player of userPlayers(state)) {
    const on = player.state.squadNumberOn;
    if (on === undefined || on < state.calendar.preseasonStart) continue;
    if (player.squadNumber === undefined || !isSymbolicNumber(player.squadNumber)) continue;
    const fact = numberInheritedFact(state, player);
    if (fact) return fact;
  }
  return null;
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

  /**
   * **전야의 자리는 하나다** (people.md §4). 더비·개막이 그날을 이미 잡았으면 작별은
   * 자리를 빼앗지 않고 카드만 얹힌다 — 같은 날 회견 둘을 열면 하나가 방치로 닫힌다.
   */
  const farewell = farewellFacts(state, match);
  const conference = derby
    ? buildDerbyPress(state, match, { derby, opponentId, opponent, home })
    : isSeasonOpener(state, match, leagueId)
      ? buildOpeningPress(state, { opponent, home })
      : farewell.length > 0
        ? buildFarewellPress(state, { opponent, facts: farewell })
        : null;
  if (!conference) return;
  if (conference.trigger !== "farewell") conference.facts.push(...farewell);
  /**
   * 전야의 상대 감독 — 경기 뒤와 **다른 채널로 뽑는다** (people.md §4). 찌르는 말은
   * 유출·루머와 같은 규약으로 자리를 키운다.
   */
  const rivalQuote = rivalQuoteFact(state, match, "eve");
  if (rivalQuote) {
    conference.facts.push(rivalQuote);
    if (rivalQuote.sharp) conference.weight = Math.max(conference.weight, 2);
  }
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

// ── 은퇴 예고와 작별 (season.md §6) ────────────────────

/**
 * 예고가 회견에 실리는 창 — 지나면 그 사실은 근황·심경의 것이다 (people.md §4).
 * 반년을 회견마다 다시 물으면 그 자리가 매번 같은 질문으로 채워진다.
 */
const RETIREMENT_PRESS_DAYS = 14;

/** 한 자리에 세우는 이름의 수 — 회견이 명단 낭독이 되지 않게 하는 상한 */
const FAREWELL_NAMES_SHOWN = 2;

/**
 * 예고가 선 우리 선수 — **우리 셔츠로 오래 뛴 순서다.** 자리가 하나뿐일 때 서는 사람은
 * 그 구단에서 가장 오래 있은 사람이고, 같으면 id가 가른다(명단 순서가 정하면 같은
 * 세이브가 두 번 다른 답을 낸다 — season.md §6 시상의 마지막 칸과 같은 규약).
 */
function retiringPlayers(state: GameState): GamePlayer[] {
  return userPlayers(state)
    .filter((p) => p.state.retiringAfterSeason !== undefined)
    .map((p) => ({ player: p, apps: careerTotalsOf(state, p.id, state.userTeamId).apps }))
    .sort((a, b) => b.apps - a.apps || (a.player.id < b.player.id ? -1 : 1))
    .map((row) => row.player);
}

/**
 * 방금 선 은퇴 예고 — 경기 뒤 회견이 싣는다 (people.md §4).
 *
 * 날 선 자리가 아니다: 감독을 몰아세우는 사실이 아니라 그 자리에 있는 사람의 마지막
 * 시즌이다. 사유 코드를 함께 드는 것은 서른다섯의 은퇴와 뛰지 못한 서른넷의 은퇴가
 * 기자에게 다른 질문이기 때문이다.
 */
function retirementFacts(state: GameState): PressFact[] {
  const judgeDate = retirementJudgeDate(state.season);
  const facts: PressFact[] = [];
  for (const player of retiringPlayers(state)) {
    const declared = player.state.retiringAfterSeason;
    if (!declared || diffDays(declared.on, state.date) > RETIREMENT_PRESS_DAYS) continue;
    const ours = careerTotalsOf(state, player.id, state.userTeamId);
    facts.push({
      kind: "retirement",
      data: {
        name: player.name,
        values: {
          age: ageOf(player.birthdate, judgeDate),
          apps: ours.apps,
          goals: ours.goals,
        },
        tags: [declared.reason],
        date: declared.on,
      },
      about: player.id,
      sharp: false,
    });
    if (facts.length >= FAREWELL_NAMES_SHOWN) break;
  }
  return facts;
}

/**
 * 그 시즌 우리 **마지막 홈 리그 경기** — 달력이 이미 아는 사실이다 (season.md §6).
 * 컵·대항전을 세지 않는 것은 그쪽이 대진에 따라 홈이 될지도 모르는 자리여서다:
 * 리그 일정만이 시즌 초부터 "그날이 마지막"이라고 말할 수 있다.
 */
function lastHomeLeagueMatch(state: GameState): MatchRecord | null {
  const leagueId = leagueOfTeamIn(state, state.userTeamId);
  return leagueMatchesOfSeason(state, leagueId)
    .filter((m) => m.homeTeamId === state.userTeamId)
    .reduce<MatchRecord | null>(
      (best, m) => (best === null || m.date > best.date ? m : best),
      null,
    );
}

/**
 * 작별의 카드 — 전야에는 날짜만 (people.md §4).
 *
 * ⚠️ **코어는 그를 세우지 않는다.** 선발은 감독의 결정이고, 코어가 하는 일은 그날이
 * 그의 마지막 홈경기라는 사실을 킥오프 **전에** 감독 앞에 세우는 것까지다.
 */
function farewellFacts(state: GameState, match: MatchRecord): PressFact[] {
  if (lastHomeLeagueMatch(state)?.id !== match.id) return [];
  return retiringPlayers(state)
    .slice(0, FAREWELL_NAMES_SHOWN)
    .map((player) => ({
      kind: "farewell" as const,
      data: { name: player.name, tags: ["eve"], date: match.date },
      about: player.id,
      sharp: false,
    }));
}

/**
 * 경기 뒤의 작별 — **그가 뛰었는가**가 사실이다 (people.md §4).
 *
 * 뛰지 않았으면 날 선 자리가 된다: 은퇴하는 선수를 마지막 홈경기에 세우지 않은 것은
 * 감독의 결정이고, 회견은 결정을 묻는 자리다.
 */
function farewellResultFacts(state: GameState, match: MatchRecord): PressFact[] {
  if (lastHomeLeagueMatch(state)?.id !== match.id) return [];
  const played = new Set(match.result?.homeLineup ?? []);
  return retiringPlayers(state)
    .slice(0, FAREWELL_NAMES_SHOWN)
    .map((player) => {
      const on = played.has(player.id);
      return {
        kind: "farewell" as const,
        data: { name: player.name, tags: [on ? "played" : "unused"] },
        about: player.id,
        sharp: !on,
      };
    });
}

/** 작별 전야 — 더비도 개막도 아닌 날, 마지막 홈경기가 여는 자리 */
function buildFarewellPress(
  state: GameState,
  input: { opponent: string; facts: PressFact[] },
): PressConference {
  return {
    id: `press-farewell-${state.season}`,
    date: state.date,
    trigger: "farewell",
    reporterId: reporterFor(state, "farewell"),
    context: `시즌 마지막 홈경기 전야 · ${input.opponent}전`,
    facts: input.facts,
    status: "pending",
    weight: weightOf("farewell", false),
  };
}

/** 답을 기다리는 회견 — 언제나 하나뿐이다 */
export function pendingPress(state: GameState): PressConference | null {
  return (state.pressConferences ?? []).find((c) => c.status === "pending") ?? null;
}

/**
 * 답을 기다리던 회견을 **거절로** 닫는다 — 시즌 전환이 유일한 자리다 (people.md §4).
 *
 * `expirePendingPress`와 갈리는 지점: 그 자리는 물을 구단이 없어진 것이라 대가가
 * 없지만, 시즌이 넘어가는 것은 감독이 답하지 않은 것이다. 그대로 두면 다음 시즌
 * 개막 전야 회견이 지난 시즌의 자리를 방치로 읽어, 새 시즌 첫날에 지난 시즌의
 * 대가가 청구된다.
 */
export function declinePendingPress(state: GameState, digest?: string[]): void {
  const open = pendingPress(state);
  if (!open) return;
  applyPressOutcome(state, open, null);
  open.status = "declined";
  digest?.push(`${open.context} 회견에 감독이 나타나지 않았다 — 언론 평판 하락`);
  pushNarrative(state, `기자회견 불참 (${open.context})`, 2);
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
  declinePendingPress(state, digest);
  loadLeaks(state, conference);
  loadTransferRequests(state, conference);
  loadRumours(state, conference);
  loadSackings(state, conference);
  loadManagerContract(state, conference);
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
  /** 상대 선수단 사기 변화 — 상대 감독을 겨눴을 때만 있다 (people.md §4) */
  rival?: number;
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
  /** 감독이 상대 감독을 겨눴나 — 카드에 오른 그 사람이어야 한다 (`cardManager`) */
  targetManager?: { teamId: string; code: RivalVoice } | null,
): PressEffect {
  if (stance !== null && targetManager) {
    return applyStanceOutcome(state, {
      row: rivalRow(stance, targetManager.code),
      band: PRESS_BAND * conference.weight,
      /** 지목된 선수는 없다 — 감독이 부른 이름이 남의 벤치다 */
      targetPlayerId: null,
      stance,
      rivalTeamId: targetManager.teamId,
    });
  }
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
    stance,
  });
}

/**
 * 상대 감독을 겨눈 답의 한 줄 — **표의 세 열이 갈린다** (people.md §4).
 *
 * 보드·언론은 표 그대로(도발은 언론이 물고 보드는 불안해한다), 우리 선수단과 지목
 * 선수 열은 죽고(우리 선수를 향한 말이 아니다), 팀 사기는 `RIVAL_TALK_LIFT` 하나로
 * 선다. 상대 열은 그 사람의 결이 부호를 뒤집는다.
 */
function rivalRow(stance: PressStance, code: RivalVoice): Record<PressAxis, number> {
  const row = STANCE_TABLE[stance];
  return {
    board: row.board,
    media: row.media,
    squad: 0,
    target: 0,
    team: RIVAL_TALK_LIFT,
    rival: row.rival * RIVAL_TEMPER[code],
  };
}

/** 스탠스 한 줄 — `null`이면 답하지 않은 것이다. 표를 여는 유일한 문 */
export function stanceRow(stance: PressStance | null): Record<PressAxis, number> {
  return stance === null ? DECLINE : STANCE_TABLE[stance];
}

/** 자리가 닿을 수 있는 축 전부 — 회견은 마이크 앞이라 하나도 죽지 않는다 */
const ALL_AXES: readonly PressAxis[] = ["board", "media", "squad", "target", "team", "rival"];

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
    /**
     * 감독이 취한 태도 — **관계를 옮기는 것은 이 값이다** (people.md §6 「관계 점수」).
     * `null`은 답하지 않은 자리이고, 생략하면 관계가 움직이지 않는다.
     */
    stance?: PressStance | null;
    /**
     * 이 자리에서 감독의 맞은편에 있던 사람 — 생략하면 지목된 선수다.
     * 다가옴의 주장·구단주 자리처럼 선수가 아닌 상대가 있을 때 채운다.
     */
    relationWith?: string;
    /**
     * 감독의 말이 닿은 **남의 라커룸** — 회견에서 상대 감독을 겨눴을 때만 선다
     * (people.md §4). 없으면 `rival` 축은 죽는다: 겨눈 사람이 없으면 닿을 방도 없다.
     */
    rivalTeamId?: string;
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

  /**
   * **사이도 함께 움직인다** (people.md §6). 회견의 지목과 다가옴의 응대가 같은 표를
   * 타는 자리가 여기이므로 관계도 여기 한 곳에서 움직인다 — 두 자리가 표를 따로 들면
   * 「감싸기가 사이를 얼마나 올리는가」가 두 값이 된다.
   *
   * 답하지 않은 자리도 값을 치른다: 이름이 불렸는데 감독이 아무 말도 하지 않은 것
   * 역시 그 사람이 겪은 일이다.
   */
  const counterpart = input.relationWith ?? targetPlayer?.id ?? null;
  if (input.stance !== undefined && counterpart !== null) {
    moveRelation(state, MANAGER_SUBJECT, counterpart, stanceRelationEvent(input.stance));
  }

  /**
   * **남의 라커룸** — 폭은 `RIVAL_BAND` 한 값이고 자리의 무게도 우리 감독의 리더십도
   * 곱하지 않는다 (people.md §4). 저쪽 방은 이 회견이 얼마나 큰 자리였는지도,
   * 우리 감독이 어떤 사람인지도 모른다.
   */
  const rival = input.rivalTeamId ? Math.round(on("rival") * RIVAL_BAND) : 0;
  if (input.rivalTeamId && rival !== 0) {
    for (const p of firstTeamPlayers(state, input.rivalTeamId)) {
      p.state.form = clampForm(p.state.form + moraleToForm(rival));
    }
  }

  return {
    board,
    media,
    squad,
    target,
    targetName: targetPlayer?.name ?? null,
    team,
    ...(rival === 0 ? {} : { rival }),
  };
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
  input: { stance: PressStance; targetPlayerId?: string | null; targetManager?: string | null },
): SkillResult {
  const conference = pendingPress(state);
  if (!conference) return { ok: false, message: "지금 답할 기자회견이 없습니다" };

  /**
   * **상대 감독 지목** — 선수 지목과 같은 규약이다 (people.md §4): 카드에 오른 그
   * 사람만 겨눌 수 있고, 밖을 겨누면 반려한다. 이름 하나뿐이라 후보를 고를 일이
   * 없어 `pickPlayerAmong`을 지나지 않는다.
   */
  const onCard = cardManager(conference);
  const managerRef = input.targetManager?.trim() ?? "";
  if (managerRef !== "" && (!onCard || !sameManager(onCard.name, managerRef))) {
    return {
      ok: false,
      message: onCard
        ? `이 회견에서 겨눌 수 있는 상대 감독은 ${onCard.name}뿐입니다`
        : "이 회견에는 상대 감독의 말이 서지 않았습니다",
    };
  }
  const targetManager = managerRef === "" ? null : onCard;
  /**
   * ⚠️ **한 자리에서 겨누는 사람은 하나다.** 둘을 다 받으면 표의 어느 줄을 타야 하는지가
   * 코드의 선택이 되고, 감독이 겨눈 줄 알았던 선수의 사기가 조용히 움직이지 않는다.
   */
  if (targetManager && (input.targetPlayerId?.trim() ?? "") !== "") {
    return { ok: false, message: "한 자리에서 선수와 상대 감독을 함께 겨눌 수는 없습니다" };
  }

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

  const effect = applyPressOutcome(state, conference, input.stance, target, targetManager);
  conference.status = "answered";

  const parts = [
    signed("보드", effect.board),
    signed("언론", effect.media),
    signed("선수단", effect.squad),
    effect.targetName ? signed(`${effect.targetName} 사기`, effect.target) : null,
    signed("팀 사기", effect.team),
    targetManager
      ? signed(`${teamNameIn(state, targetManager.teamId)} 사기`, effect.rival ?? 0)
      : null,
  ].filter((x): x is string => x !== null);

  pushNarrative(
    state,
    `기자회견 — ${conference.context} (${STANCE_KO[input.stance]})`,
    conference.weight >= 3 ? 4 : 3,
  );
  // 여러 축이 갈리므로 **합**으로 결을 읽는다 — 보드는 올랐는데 라커룸이 상했으면
  // 좋은 회견이 아니다. 색 하나가 그 종합이고, 항목별 숫자는 펼쳤을 때 보인다
  const net =
    effect.board + effect.media + effect.squad + effect.team + effect.target - (effect.rival ?? 0);
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
        targetManager
          ? [`${teamNameIn(state, targetManager.teamId)} 사기`, effect.rival ?? 0]
          : null,
      ]),
    },
  };
}

/**
 * 감독이 부른 이름이 그 사람인가 — 전체 이름이거나 **성**이면 같은 사람이다.
 * 카드에 선 이름이 하나뿐이라 `normalizeSpeaker`의 동명이인 문제가 여기엔 없다.
 */
function sameManager(name: string, ref: string): boolean {
  const needle = ref.toLowerCase();
  const parts = name.toLowerCase().split(/\s+/u);
  return name.toLowerCase() === needle || parts[parts.length - 1] === needle;
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
