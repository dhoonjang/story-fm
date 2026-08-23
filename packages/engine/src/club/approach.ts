import type {
  Approach,
  ApproachChannel,
  ApproachContext,
  ApproachPressure,
  ApproachTopic,
  GamePlayer,
  PlayerIssue,
  PressFact,
  PressStance,
} from "@story-fm/domain";
import { isReserveMatch } from "@story-fm/domain";
import {
  APPROACH_AXES,
  APPROACH_CHANNEL_LABEL,
  APPROACH_LEAK_STEP,
  APPROACH_TOP_STEP,
  approachContextText,
  pressFactText,
} from "@story-fm/domain";
import type { GameState } from "../core/state";
import { playerById, pushNarrative, seasonStatOf, squadLevelOf, userPlayers } from "../core/state";
import { diffDays } from "../competition/calendar";
import { boardExpectation, computeStandings } from "../competition/season";
import { formLabel } from "../squad/form";
import { issueReasonText } from "../squad/mood";
import { recentOutcomes } from "../squad/slump";
import { agentForPlayer, ownerOf } from "../world/persona";
import { USER_WARNINGS_BEFORE_SACK } from "../market/manager-market";
import { boardDemandFact } from "./board-demand";
import { applyStanceOutcome, pendingPress, signed, stanceRow, STANCE_KO } from "./press";
import type { SkillResult } from "../skills";
import { deltaItems } from "../skills/brief";

/**
 * 다가옴 — **세계가 회견 밖에서 먼저 말을 건다** (→ docs/data/people.md §8).
 *
 * 회견은 경기·이적이라는 **사건**이 열지만 여기서 자리를 여는 것은 **시간**이다.
 * 불만이 걸린 채 며칠이 흐르고, 순위가 기대 아래에 머무르고, 라커룸이 식어 있는
 * 동안 압력이 쌓여 임계를 넘으면 그 일에 가장 가까운 사람이 감독을 찾아온다.
 *
 * 코어가 하는 일은 회견과 같은 셋이다:
 *   ① **누가 언제 오는가를 정한다** — 압력·임계·소음의 문. 결정적이다.
 *   ② **그 사람이 아는 사실을 넘긴다** — 문장도 대사도 코어가 쓰지 않는다.
 *   ③ **한도를 정한다** — 어떤 답이든 이 자리 하나가 옮길 수 있는 폭.
 *
 * ⚠️ **압력만이 저장된다.** 불만도 순위도 폼도 장부에서 파생하지만 "그것을 며칠째
 * 두었는가"는 원본이 없다 — 감독이 하지 **않은** 일의 누적이라서다.
 */

/** 첫 자리까지 채워야 하는 압력. 계단이 오르면 임계도 함께 오른다 */
export const APPROACH_THRESHOLD = 100;

/**
 * 원인이 서 있는 동안 하루에 쌓이는 압력 — 임계 100 기준으로 **처음까지 걸리는 날**이
 * 15 · 12 · 17 · 20 · 13 · 25일이다 (people.md §8의 표와 같은 숫자).
 *
 * 주제마다 다른 이유는 감독의 일상과의 거리다: 연패 속의 불만은 매일 라커룸에서
 * 마주치고, 2군에 내려간 선수는 몇 주에 한 번 눈에 띄며, 보드는 달 단위로 본다.
 */
const DAILY_GAIN: Record<ApproachTopic, number> = {
  minutes: 7,
  "losing-run": 9,
  "early-return": 6,
  demotion: 5,
  morale: 8,
  results: 4,
};

/** 원인이 사라진 뒤 하루에 식는 양 — 쌓는 것보다 빠르다. 풀린 일은 곧 지나간 일이다 */
const COOL_PER_DAY = 12;

/**
 * **벤치 불만은 선발로 세워야 진짜로 내려간다** (people.md §8).
 *
 * 최근 `STARTED_WINDOW`일 안에 선발로 섰으면 그날은 쌓이는 대신 빠진다. 이 예외가
 * `minutes`에만 붙는 이유는 나머지 주제가 출전으로 풀리지 않기 때문이다 — 2군 방치는
 * 승격이, 연패는 승점이, 순위는 순위가 푼다.
 */
const STARTED_RELIEF = 10;
const STARTED_WINDOW = 7;

/** 답하지 않은 자리가 남기는 압력 — 직전 임계의 몫. 무시가 다음 계단을 앞당긴다 */
const IGNORE_CARRY = 0.75;

/** 열린 자리가 답을 기다리는 날 — 이 뒤엔 감독이 지나친 것으로 닫힌다 */
const APPROACH_PATIENCE_DAYS = 3;

/** 같은 화자가 다시 오기까지 — 어제 감독실에 왔던 사람이 오늘 또 오지 않는다 */
const SPEAKER_COOLDOWN_DAYS = 7;

/**
 * 이 자리 하나가 옮길 수 있는 기본 폭 — 계단에 비례해 3~9다.
 * 회견(`PRESS_BAND` 4)보다 좁은 이유는 자리가 좁기 때문이다 — 마이크 앞에서 한 말이
 * 복도에서 한 말보다 멀리 간다.
 */
const APPROACH_BAND = 3;

/**
 * 폭이 더는 넓어지지 않는 계단 — **위 계단이라고 사석의 말이 회견보다 멀리 가지는
 * 않는다** (people.md §8). 선수 사다리가 5까지 오르는 것은 무게이지 파급이 아니다.
 */
const BAND_STEP_CAP = 3;

/** 상태에 남기는 지난 다가옴 수 — 그 뒤는 서사에만 남는다 (회견과 같은 규약) */
const KEPT_APPROACHES = 20;

/** 라커룸이 식었다고 보는 1군 평균 폼 */
const MORALE_COLD = -0.2;

/** 보드가 순위를 문제 삼기 시작하는 경기 수 — `reviewUserSeat`의 유예와 같은 결 */
const RESULTS_MIN_MATCHES = 8;

/** 무승 계단을 재는 창 — 회견과 같은 자를 쓴다 */
const WINLESS_WINDOW = 4;

/**
 * 선수가 아닌 주제의 압력 열쇠 — **자리를 가리키지 사람을 가리키지 않는다.**
 * 주장이 바뀌어도 라커룸은 라커룸이고, 그 압력은 이어져야 한다.
 */
const SQUAD_SUBJECT = "squad";
const BOARD_SUBJECT = "board";

/** 주제가 어느 자리에서 오는가 — 선수 채널의 넷은 불만 사유 코드 그대로다 */
const CHANNEL_OF: Record<ApproachTopic, ApproachChannel> = {
  minutes: "player",
  "losing-run": "player",
  "early-return": "player",
  demotion: "player",
  morale: "captain",
  results: "owner",
};

/**
 * 이 주제의 사다리 꼭대기 — **채널마다 다르다** (선수 5 · 주장·구단주 3, people.md §8).
 * 주장·구단주가 3에 멈추는 것은 보드 경고가 3/3에 서는 것과 같은 규약이고, 위쪽 두
 * 계단(언론 유출·이적 요청)은 선수 한 사람의 불만에만 있는 자리라서다.
 */
function topStepOf(topic: ApproachTopic): number {
  return APPROACH_TOP_STEP[CHANNEL_OF[topic]];
}

/**
 * 답하지 않은 자리 — **무시가 공짜면 아무도 답하지 않는다.**
 *
 * 회견의 거절 행(`DECLINE`)을 쓰지 않는다: 그 행은 라커룸이 조금 오른다(감독이 총대를
 * 멨다). 찾아온 사람을 그냥 돌려보낸 것은 그 반대다.
 *
 * ⚠️ **명시적 거절과 사흘의 방치가 같은 값이다** — 답하지 않은 것은 답하지 않은 것이다.
 */
const IGNORED = { board: -0.5, media: 0, squad: -0.6, target: -1, team: -0.3 };

/** 이 계단에서 자리가 열리려면 채워야 하는 압력 — 한 번 말한 주제는 더 오래 참는다 */
export function approachThreshold(step: number): number {
  return APPROACH_THRESHOLD * (step + 1);
}

/** 압력 눈금 — 옛 세이브엔 없다 */
function pressures(state: GameState): ApproachPressure[] {
  state.approachPressure ??= [];
  return state.approachPressure;
}

function rowOf(state: GameState, subject: string, topic: ApproachTopic): ApproachPressure {
  const rows = pressures(state);
  const found = rows.find((r) => r.subject === subject && r.topic === topic);
  if (found) return found;
  const row: ApproachPressure = { subject, topic, value: 0, step: 0 };
  rows.push(row);
  return row;
}

/** 답을 기다리는 다가옴 — 언제나 하나뿐이다 */
export function pendingApproach(state: GameState): Approach | null {
  return (state.approaches ?? []).find((a) => a.status === "pending") ?? null;
}

// ── 오늘의 원인 ────────────────────────────────────────────────

/** 오늘 압력이 움직이는 자리 하나 — 양수면 쌓이고 음수면 빠진다 */
interface Cause {
  subject: string;
  topic: ApproachTopic;
  delta: number;
}

/** 최근 우리 경기에 **선발로** 섰는가 — 명단 제외가 아니라 출전이 기준이다 */
function startedRecently(state: GameState, playerId: string): boolean {
  return state.matches.some((m) => {
    if (!m.result) return false;
    // 2군 경기 출전은 출전 시간 불만을 풀지 못한다 — 그 불만의 자리는 1군이다
    if (isReserveMatch(m)) return false;
    const home = m.homeTeamId === state.userTeamId;
    if (!home && m.awayTeamId !== state.userTeamId) return false;
    if (diffDays(m.date, state.date) > STARTED_WINDOW) return false;
    return (m.result[home ? "homeLineup" : "awayLineup"] ?? []).includes(playerId);
  });
}

/** 1군 평균 폼 — 라커룸의 온도. 2군은 감독의 일상에 닿지 않아 세지 않는다 */
function firstTeamForm(state: GameState): number | null {
  const squad = userPlayers(state).filter((p) => squadLevelOf(p) === "first");
  if (squad.length === 0) return null;
  return squad.reduce((sum, p) => sum + p.state.form, 0) / squad.length;
}

/** 우리 리그 순위 — 아직 판단할 만큼 치르지 않았으면 없다 */
function leaguePlace(state: GameState): { position: number; played: number } | null {
  const standings = computeStandings(state);
  const index = standings.findIndex((row) => row.ours);
  const row = standings[index];
  if (!row || row.played < RESULTS_MIN_MATCHES) return null;
  return { position: index + 1, played: row.played };
}

/**
 * 오늘 압력이 움직이는 자리들. **원인이 서 있는 것만 나온다** — 나오지 않은 줄은
 * 부르는 쪽에서 식힌다.
 */
function causesToday(state: GameState): Cause[] {
  const causes: Cause[] = [];
  const ours = new Set(userPlayers(state).map((p) => p.id));
  /**
   * **이적 요청이 서 있는 동안 그 선수의 압력은 쌓이지 않는다** — 그 일은 이제
   * 시장의 것이다 (people.md §8). 원인으로 나오지 않은 줄은 하루 12씩 식는다.
   */
  const requested = new Set(
    userPlayers(state)
      .filter((p) => p.state.transferRequestedOn !== undefined)
      .map((p) => p.id),
  );

  for (const issue of state.issues) {
    if (!ours.has(issue.gamePlayerId)) continue;
    if (requested.has(issue.gamePlayerId)) continue;
    const topic = issue.reason;
    // 사유가 없는 옛 불만은 어느 주제로도 옮길 수 없다 — 사실이 없으면 자리도 없다
    if (topic === undefined) continue;
    const relieved = topic === "minutes" && startedRecently(state, issue.gamePlayerId);
    causes.push({
      subject: issue.gamePlayerId,
      topic,
      delta: relieved ? -STARTED_RELIEF : DAILY_GAIN[topic],
    });
  }

  const form = firstTeamForm(state);
  if (form !== null && form <= MORALE_COLD) {
    causes.push({ subject: SQUAD_SUBJECT, topic: "morale", delta: DAILY_GAIN.morale });
  }

  const place = leaguePlace(state);
  if (place && place.position > boardExpectation(state, state.userTeamId).target) {
    causes.push({ subject: BOARD_SUBJECT, topic: "results", delta: DAILY_GAIN.results });
  }
  return causes;
}

// ── 사실 카드 ──────────────────────────────────────────────────

/** 이 자리를 여는 재료 — 화자와 그가 아는 사실. 세울 수 없으면 `null` */
interface Scene {
  channel: ApproachChannel;
  speakerId: string;
  about: string | null;
  /** 한 줄 배경의 **카드** — 문장은 `approachContextText`가 만든다 */
  contextCard: ApproachContext;
  /** 폼 라벨처럼 코어만 아는 이름 — 카드에 적지 않고 문장을 만들 때만 쓴다 */
  formLabel?: string;
  facts: PressFact[];
}

/** 불만이 걸린 날부터 오늘까지 */
function issueDays(state: GameState, issue: PlayerIssue): number {
  return diffDays(issue.since, state.date);
}

/** 선수 채널의 사실 — 불만 한 조각과 지금의 폼. 그 밖은 이 사람이 말할 것이 아니다 */
function playerFacts(
  state: GameState,
  player: GamePlayer,
  issue: PlayerIssue,
  topic: ApproachTopic,
  sharp: boolean,
): PressFact[] {
  const days = issueDays(state, issue);
  const head: PressFact = ((): PressFact => {
    switch (topic) {
      case "minutes": {
        const apps = seasonStatOf(state, player.id)?.apps ?? 0;
        return {
          kind: "minutes",
          data: { values: { days, apps } },
          about: player.id,
          sharp,
        };
      }
      case "demotion": {
        const since = player.state.demotedOn;
        const down = since ? diffDays(since, state.date) : days;
        return {
          kind: "demoted",
          data: { values: { days: down, issueDays: days } },
          about: player.id,
          sharp,
        };
      }
      default:
        return {
          kind: "unhappy",
          data: {
            values: { days },
            tags: issue.reason ? ["grievance", issue.reason] : ["grievance"],
          },
          about: player.id,
          sharp,
        };
    }
  })();
  return [
    head,
    {
      kind: "slump",
      data: { tags: [formLabel(player.state.form)] },
      about: player.id,
      sharp: false,
    },
  ];
}

/** 그 압력 줄이 지금 세울 수 있는 자리 — 사람이 없거나 사실이 사라졌으면 `null` */
function sceneFor(state: GameState, row: ApproachPressure, step: number): Scene | null {
  const channel = CHANNEL_OF[row.topic];
  const sharp = step >= 2;

  if (channel === "player") {
    const player = playerById(state, row.subject);
    const issue = state.issues.find(
      (i) => i.gamePlayerId === row.subject && i.reason === row.topic,
    );
    if (!player || player.teamId !== state.userTeamId || !issue) return null;
    /**
     * 꼭대기 계단 — **에이전트가 대리로 온다.** 선수가 같은 말을 네 번 하러 오지
     * 않는다. 자리를 여는 사실은 이적 요청 그 자체라 맨 앞에 sharp로 선다.
     */
    if (step === topStepOf(row.topic)) {
      const agent = agentForPlayer(state, player.id);
      const request: PressFact = {
        kind: "transfer-request",
        data: {
          name: player.name,
          values: { days: issueDays(state, issue) },
          ...(issue.reason ? { tags: [issue.reason] } : {}),
        },
        about: player.id,
        sharp: true,
      };
      return {
        // 명부를 비운 세계에서는 대리할 사람이 없으니 선수 본인이 온다 — 없는 사람을
        // 세우는 대신 자리를 한 칸 낮춘다.
        channel: agent ? "agent" : "player",
        speakerId: agent?.characterId ?? player.name,
        about: player.id,
        contextCard: {
          code: "transfer-request",
          ...(issue.reason ? { reason: issue.reason } : {}),
        },
        facts: [request, ...playerFacts(state, player, issue, row.topic, sharp)],
      };
    }
    return {
      channel,
      speakerId: player.name,
      about: player.id,
      contextCard: {
        code: "grievance",
        ...(issue.reason ? { reason: issue.reason } : {}),
        value: issueDays(state, issue),
      },
      facts: playerFacts(state, player, issue, row.topic, sharp),
    };
  }

  if (channel === "captain") {
    const squad = userPlayers(state);
    const captain = squad.find((p) => p.isCaptain);
    const form = firstTeamForm(state);
    // 주장이 없으면 라커룸을 대신할 사람도 없다 — 코어가 화자를 지어내지 않는다
    if (!captain || form === null) return null;
    const facts: PressFact[] = [
      { kind: "morale", data: { tags: [formLabel(form)] }, about: null, sharp },
    ];
    const recent = recentOutcomes(state, state.userTeamId, WINLESS_WINDOW);
    if (recent.length > 0 && recent.every((r) => r !== "win")) {
      facts.push({
        kind: "winless",
        data: { values: { matches: recent.length }, tags: [...recent] },
        about: null,
        sharp: true,
      });
    }
    // 옛 세이브의 유령 방어 — 떠난 선수의 불만을 주장이 세지 않는다 (people.md §5)
    const unhappy = state.issues.filter((i) => squad.some((p) => p.id === i.gamePlayerId)).length;
    if (unhappy > 0) {
      facts.push({
        kind: "unhappy",
        data: { values: { count: unhappy }, tags: ["count"] },
        about: null,
        sharp: false,
      });
    }
    return {
      channel,
      speakerId: captain.name,
      about: null,
      contextCard: { code: "dressing-room-form", value: form },
      formLabel: formLabel(form),
      facts,
    };
  }

  const place = leaguePlace(state);
  if (!place) return null;
  const expectation = boardExpectation(state, state.userTeamId);
  const facts: PressFact[] = [
    {
      kind: "standing",
      data: { values: { rank: place.position, played: place.played }, tags: ["place"] },
      about: null,
      sharp,
    },
    {
      kind: "standing",
      data: { values: { rank: expectation.target }, tags: ["board-target", expectation.code] },
      about: null,
      sharp: false,
    },
  ];
  const warnings = state.manager.boardWarnings ?? 0;
  if (warnings > 0) {
    facts.push({
      kind: "standing",
      data: { values: { count: warnings, limit: USER_WARNINGS_BEFORE_SACK }, tags: ["warnings"] },
      about: null,
      sharp: true,
    });
  }
  /**
   * 열린 보드 요청은 구단주가 아는 사실이다 (career.md §5.2) — 순위 이야기를 하러
   * 온 자리라도 자기가 건 조건을 빼놓고 말하지 않는다.
   */
  const demand = boardDemandFact(state);
  if (demand) facts.push(demand);
  return {
    channel: "owner",
    speakerId: ownerOf(state).characterId,
    about: null,
    contextCard: { code: "standing", value: place.position, limit: expectation.target },
    facts,
  };
}

// ── 하루 ───────────────────────────────────────────────────────

/**
 * 하루치 압력과, 임계를 넘은 자리 하나 — **tick이 매일 부른다.**
 *
 * 순서가 뜻을 갖는다: 사흘을 넘긴 자리를 먼저 닫고(그 대가를 치르게 한 뒤), 압력을
 * 움직이고, 마지막에 하나를 연다. 닫기 전에 열면 감독 앞에 두 자리가 선다.
 */
export function tickApproaches(state: GameState, digest: string[]): boolean {
  withdrawRequests(state, digest);
  const gaveUp = expireApproach(state, digest);
  driftPressure(state);
  /**
   * **감독이 지나친 날에는 다음 사람이 오지 않는다.** 하루 한 건의 문과 같은 뜻이다 —
   * 한 대화가 답 없이 닫힌 그날 다른 대화가 열리면, 방치의 결과가 소음으로 읽힌다.
   */
  return gaveUp ? false : openApproach(state, digest);
}

/**
 * 자리의 배경 한 줄 — **카드에서 만든다** (people.md §8).
 *
 * 이름과 폼 라벨은 코어만 아는 것이라 여기서 채워 넘긴다. 옛 세이브는 카드 없이
 * 문장만 들고 있어 그때만 그 문장으로 떨어진다 — **보여 주는 자리의 폴백이다**.
 */
function contextTextOf(
  state: GameState,
  a: { about: string | null; contextCard?: ApproachContext; context?: string },
): string {
  if (!a.contextCard) return a.context ?? "";
  const subject = a.about === null ? undefined : (playerById(state, a.about)?.name ?? undefined);
  const form = a.contextCard.code === "dressing-room-form" ? firstTeamForm(state) : null;
  return approachContextText(a.contextCard, {
    ...(subject ? { subject } : {}),
    ...(form === null ? {} : { form: formLabel(form) }),
  });
}

/** 사흘 동안 답이 없으면 감독이 지나친 것이다 — 거절과 같은 값을 치른다 */
function expireApproach(state: GameState, digest: string[]): boolean {
  const open = pendingApproach(state);
  if (!open || diffDays(open.date, state.date) < APPROACH_PATIENCE_DAYS) return false;
  const effect = closeApproach(state, open, null);
  open.status = "declined";
  const line = contextTextOf(state, open);
  digest.push(`${line} — 감독이 답하지 않았다${effectSuffix(effect)}`);
  pushNarrative(state, `${line} (응답 없음)`, open.step >= 3 ? 4 : 3);
  return true;
}

/**
 * **불만이 전부 풀리면 요청이 걷힌다** — 면담·승격·선발이 원인을 지운 자리다
 * (people.md §8). 감독의 스탠스는 이 필드를 건드리지 못하고, 팀을 떠난 선수의 요청은
 * `clearDepartedState`가 다른 상태와 함께 지운다.
 */
function withdrawRequests(state: GameState, digest: string[]): void {
  for (const player of userPlayers(state)) {
    if (player.state.transferRequestedOn === undefined) continue;
    if (state.issues.some((i) => i.gamePlayerId === player.id)) continue;
    player.state.transferRequestedOn = undefined;
    digest.push(`${player.name} 이적 요청 철회 — 불만이 남아 있지 않다`);
    pushNarrative(state, `${player.name} 이적 요청 철회`, 4);
  }
}

/** 원인이 선 줄은 쌓이고 나머지는 식는다. 압력이 0이고 계단도 0인 줄은 사라진다 */
function driftPressure(state: GameState): void {
  const causes = causesToday(state);
  for (const cause of causes) rowOf(state, cause.subject, cause.topic);
  const rows = pressures(state);
  for (const row of rows) {
    const cause = causes.find((c) => c.subject === row.subject && c.topic === row.topic);
    row.value = Math.max(0, row.value + (cause ? cause.delta : -COOL_PER_DAY));
  }
  /**
   * 세계에서 사라진 주인의 줄은 버린다 — 판 선수의 압력이 남아 있으면 그 이름으로
   * 자리가 열릴 수 없는데도 눈금만 계속 자란다.
   */
  const ours = new Set(userPlayers(state).map((p) => p.id));
  state.approachPressure = rows.filter((row) => {
    if (CHANNEL_OF[row.topic] === "player" && !ours.has(row.subject)) return false;
    return row.value > 0 || row.step > 0;
  });
}

/**
 * 겹쳤을 때의 순서 — 넘친 정도가 같으면 이 순서다. 자기 일로 온 사람이 먼저이고
 * 구단 전체의 일이 나중인 것은, 앞의 것이 뒤의 것보다 시급해서가 아니라 **결정적인
 * 순서가 하나 있어야** 하기 때문이다.
 */
const APPROACH_TOPIC_ORDER: Record<ApproachTopic, number> = {
  minutes: 0,
  demotion: 1,
  "losing-run": 2,
  "early-return": 3,
  morale: 4,
  results: 5,
};

/**
 * 계단 4 — **언론에 말한다.** 자리가 아니라 **사건**이라 감독이 답할 곳이 따로 없고,
 * 값은 그 유출을 실어 갈 다음 회견에서 치른다 (`state.pressLeaks` → 회견의 사실 카드).
 *
 * ⚠️ **유출은 압력을 풀지 않는다** — 말한 것은 신문이지 감독이 아니다. 직전 임계의
 * 75%가 남아 다음 계단(이적 요청)을 앞당긴다 (people.md §8).
 */
function leakToPress(state: GameState, row: ApproachPressure, digest: string[]): boolean {
  const player = playerById(state, row.subject);
  const issue = state.issues.find((i) => i.gamePlayerId === row.subject && i.reason === row.topic);
  if (!player || player.teamId !== state.userTeamId || !issue) return false;

  const leaks = (state.pressLeaks ??= []);
  // 아직 회견이 실어 가지 않은 유출이 있으면 같은 불만이 두 번 새지 않는다
  if (!leaks.some((l) => l.playerId === player.id && l.topic === row.topic)) {
    leaks.push({ playerId: player.id, topic: row.topic, date: state.date });
  }
  row.step = APPROACH_LEAK_STEP;
  row.value = approachThreshold(APPROACH_LEAK_STEP - 1) * IGNORE_CARRY;

  const reason = issueReasonText(issue) ?? "불만";
  digest.push(`${player.name}의 ${reason} 불만이 언론에 흘러나왔다`);
  pushNarrative(state, `${player.name} ${reason} 불만 언론 유출`, 4);
  return true;
}

/**
 * 임계를 넘은 자리 하나를 연다 — **소음을 막는 네 개의 문**을 지나서만 (people.md §8).
 *
 * 겹치면 **가장 많이 넘친 것**이 선다. 절대값이 아니라 임계 대비인 이유는 계단마다
 * 임계가 다르기 때문이다 — 300을 채운 3계단은 100을 채운 1계단보다 급하지 않다.
 */
function openApproach(state: GameState, digest: string[]): boolean {
  if (pendingApproach(state)) return false;
  /**
   * **한 번에 답을 요구하는 자리는 하나다.** 회견장에 앉혀 놓고 감독실 문까지
   * 두드리면 감독은 둘 중 하나를 버리게 되고, 버린 쪽의 대가만 조용히 쌓인다.
   *
   * ⚠️ **아직 살아 있는 회견만 자리를 다툰다.** 회견은 다음 회견이 열릴 때까지 닫히지
   * 않으므로(`openPress`), 감독이 며칠째 지나친 회견 하나가 시즌 내내 다가옴을 막을
   * 수 있다 — 실제로 그랬다. 다가옴이 감독을 기다리는 것과 같은 사흘까지만 센다.
   */
  const press = pendingPress(state);
  if (press && diffDays(press.date, state.date) < APPROACH_PATIENCE_DAYS) return false;
  const opened = state.approaches ?? [];
  // 하루 한 건 — 답한 날에도 그날 안에 다음 자리가 열리지 않는다
  if (opened.some((a) => a.date === state.date)) return false;

  const ranked = pressures(state)
    .filter((row) => row.value >= approachThreshold(row.step))
    .map((row) => ({ row, over: row.value / approachThreshold(row.step) }))
    .sort(
      (a, b) =>
        b.over - a.over ||
        APPROACH_TOPIC_ORDER[a.row.topic] - APPROACH_TOPIC_ORDER[b.row.topic] ||
        (a.row.subject < b.row.subject ? -1 : 1),
    );

  for (const { row } of ranked) {
    const step = Math.min(row.step + 1, topStepOf(row.topic));
    /**
     * 계단 4에서는 문이 열리는 대신 신문이 열린다 — **하루에 세계가 움직이는 것은
     * 한 번**이라는 규약은 그대로라, 유출이 섰으면 오늘은 여기서 끝난다.
     *
     * ⚠️ 그래도 **시계는 세우지 않는다**(false). 시계가 서는 날엔 반드시 오늘 답해야
     * 할 것이 있어야 하는데(season.md §5 — 기한인 협상·찾아온 사람), 유출은 자리가
     * 아니라 사건이라 감독이 답할 곳이 없다 — 값은 다음 회견에서 치른다.
     */
    if (CHANNEL_OF[row.topic] === "player" && step === APPROACH_LEAK_STEP) {
      if (leakToPress(state, row, digest)) return false;
      continue;
    }
    const scene = sceneFor(state, row, step);
    if (!scene) continue;
    // 같은 화자 7일 쿨다운 — 계단이 올랐어도 그 사람은 아직 복도에 있다
    const spokeRecently = opened.some(
      (a) =>
        a.speakerId === scene.speakerId && diffDays(a.date, state.date) < SPEAKER_COOLDOWN_DAYS,
    );
    if (spokeRecently) continue;

    const approach: Approach = {
      id: `approach-${row.topic}-${row.subject}-${state.date}`,
      date: state.date,
      channel: scene.channel,
      topic: row.topic,
      speakerId: scene.speakerId,
      about: scene.about,
      contextCard: scene.contextCard,
      facts: scene.facts,
      step,
      status: "pending",
    };
    row.openedOn = state.date;
    state.approaches = [...opened, approach].slice(-KEPT_APPROACHES);
    const sceneLine = approachContextText(scene.contextCard, {
      ...(scene.about === null ? {} : { subject: playerById(state, scene.about)?.name ?? "" }),
      ...(scene.formLabel === undefined ? {} : { form: scene.formLabel }),
    });
    digest.push(
      `${scene.speakerId}(${APPROACH_CHANNEL_LABEL[scene.channel]})이(가) 감독을 찾아왔다 — ${sceneLine}`,
    );
    pushNarrative(state, `${scene.speakerId} 면담 요청 (${sceneLine})`, step >= 3 ? 4 : 3);
    /**
     * **자리가 열리는 순간 요청이 선다.** 감독의 답은 압력만 되돌릴 뿐 요청을 지우지
     * 못한다 — 답이 원인을 지우지 않는 규칙 그대로다 (people.md §8).
     */
    if (CHANNEL_OF[row.topic] === "player" && step === topStepOf(row.topic)) {
      const player = scene.about === null ? null : playerById(state, scene.about);
      if (player && player.state.transferRequestedOn === undefined) {
        player.state.transferRequestedOn = state.date;
        digest.push(`${player.name} 이적 요청 — 에이전트가 구단에 전달했다`);
        pushNarrative(state, `${player.name} 이적 요청`, 4);
      }
    }
    return true;
  }
  return false;
}

// ── 응답 ───────────────────────────────────────────────────────

interface ApproachEffect {
  board: number;
  media: number;
  squad: number;
  target: number;
  targetName: string | null;
  team: number;
}

/**
 * 자리를 닫고 값을 치른다 — `stance`가 `null`이면 답하지 않은 것이다.
 *
 * ⚠️ 이 함수는 `status`를 건드리지 않는다 — 라벨은 부르는 쪽이 정한다(방치와 거절이
 * 같은 값을 치르되 장부에 남는 이름은 다를 수 있다). `press.ts`의 `applyPressOutcome`과
 * 같은 규약이다.
 */
function closeApproach(
  state: GameState,
  approach: Approach,
  stance: PressStance | null,
): ApproachEffect {
  const effect = applyStanceOutcome(state, {
    row: stance === null ? IGNORED : stanceRow(stance),
    band: APPROACH_BAND * Math.min(approach.step, BAND_STEP_CAP),
    targetPlayerId: approach.about,
    axes: APPROACH_AXES[approach.channel],
  });

  const row = pressures(state).find(
    (r) => r.topic === approach.topic && r.subject === subjectOf(approach),
  );
  if (row) {
    /**
     * **답한 것과 답하지 않은 것의 차이는 남는 압력이다.** 무시하면 직전 임계의
     * 75%가 남아 다음 계단이 그만큼 앞당겨진다 — 같은 사람이 더 빨리 더 크게 온다.
     *
     * ⚠️ **그 채널의 꼭대기에서는 앞당길 것이 없다.** 더 오를 칸이 없으면 남기는 몫도
     * 0이다. 안 그러면 마지막 임계의 75%가 늘 깔려 있어 얼마 안 채우고 다시 오고,
     * 만성 불만 다섯이 2주에 한 번씩 문을 두드린다 — 사다리의 끝이 가장 시끄러운
     * 자리가 된다.
     */
    const exhausted = row.step >= APPROACH_TOP_STEP[approach.channel];
    row.value = stance === null && !exhausted ? approachThreshold(row.step) * IGNORE_CARRY : 0;
    row.step = approach.step;
  }
  return effect;
}

/** 그 자리의 압력 열쇠 — 선수 채널만 사람을 가리킨다 */
function subjectOf(approach: Approach): string {
  // 에이전트는 대리로 왔을 뿐이라 압력 줄은 그가 대리한 선수의 것이다
  if (approach.channel === "player" || approach.channel === "agent") return approach.about ?? "";
  return approach.channel === "captain" ? SQUAD_SUBJECT : BOARD_SUBJECT;
}

/** 움직인 값들을 사실 줄로 — 0인 축은 쓰지 않는다 */
function effectSuffix(effect: ApproachEffect): string {
  const parts = [
    signed("보드", effect.board),
    signed("선수단", effect.squad),
    effect.targetName ? signed(`${effect.targetName} 사기`, effect.target) : null,
    signed("팀 사기", effect.team),
  ].filter((x): x is string => x !== null);
  return parts.length > 0 ? ` — ${parts.join(" · ")}` : "";
}

/**
 * `respond_to_approach` — 감독이 찾아온 사람에게 답한다. **판정형**이다.
 * LLM은 스탠스 하나만 정하고, 변화량은 이 파일과 `press.ts`의 표가 정한다.
 *
 * ⚠️ **답이 원인을 지우지는 않는다.** 압력만 되돌아간다 — 불만을 실제로 푸는 길은
 * 면담·승격·선발이고 순위를 되돌리는 길은 승점뿐이다 (people.md §8).
 */
export function respondToApproach(
  state: GameState,
  input: { stance?: PressStance; decline?: boolean },
): SkillResult {
  const approach = pendingApproach(state);
  if (!approach) return { ok: false, message: "지금 답할 자리가 없습니다" };
  /**
   * **거절은 감독이 거절했을 때만이다.** 둘 다 비운 호출을 거절로 읽으면 감독이 하지
   * 않은 결정이 장부에 남는다 — 모델이 다시 부르게 하는 편이 낫다 (press.ts와 같은 결).
   */
  if (input.decline !== true && !input.stance) {
    return { ok: false, message: "답이면 stance가, 돌려보냈으면 decline: true가 필요합니다" };
  }
  const stance = input.decline === true ? null : (input.stance ?? null);
  const effect = closeApproach(state, approach, stance);
  approach.status = stance === null ? "declined" : "answered";

  const label = stance === null ? "돌려보냄" : STANCE_KO[stance];
  pushNarrative(
    state,
    `${approach.speakerId} 면담 (${contextTextOf(state, approach)} · ${label})`,
    approach.step >= 3 ? 4 : 3,
  );
  const net = effect.board + effect.squad + effect.team + effect.target;
  return {
    ok: true,
    tone: net >= 0 ? ("good" as const) : ("bad" as const),
    message: `${approach.speakerId} 응대(${label})${effectSuffix(effect)}`,
    brief: {
      head: `${approach.speakerId} 응대(${label})`,
      items: deltaItems([
        ["보드", effect.board],
        ["선수단", effect.squad],
        effect.targetName ? [`${effect.targetName} 사기`, effect.target] : null,
        ["팀 사기", effect.team],
      ]),
    },
  };
}

/**
 * 스냅샷 블록 — 답을 기다리는 자리가 있을 때만 (매 턴 정가로 읽히는 블록이다).
 *
 * **대사가 아니라 사실을 넘긴다.** 화자를 이름으로 지목하되 그가 무슨 말을 어떻게
 * 꺼내는지는 GM이 쓴다 (overview.md §1 철칙 4 · `describePendingPress`와 같은 결).
 */
export function describePendingApproach(state: GameState): string | null {
  const a = pendingApproach(state);
  if (!a) return null;
  const waited = diffDays(a.date, state.date);
  return [
    `${a.speakerId}(${APPROACH_CHANNEL_LABEL[a.channel]}) · ${contextTextOf(state, a)}` +
      ` · 계단 ${a.step}/${APPROACH_TOP_STEP[a.channel]}${a.step >= 3 ? " · 큰 자리다" : ""}` +
      (waited > 0 ? ` · ${waited}일째 기다린다` : ""),
    `그가 아는 사실 (이 밖은 말하지 못한다):`,
    ...a.facts.map(
      (f) => `- ${pressFactText(f)}${f.about ? ` [${f.about}]` : ""}${f.sharp ? " ⚡" : ""}`,
    ),
  ].join("\n");
}
