import type {
  MatchEvent,
  Negotiation,
  NegotiationVerdict,
  PressConference,
} from "@story-fm/domain";
import {
  acceptDeal,
  acceptManagerOffer,
  fundTransferBudget,
  payPlayerBonus,
  resignPost,
  applyForManagerJob,
  counterManagerOffer,
  advanceSegment,
  advanceShootout,
  awaitingShootout,
  advanceTime,
  clockOf,
  formatClock,
  answerIncomingOffer,
  applyTeamTalk,
  applyTalkToPlayer,
  pendingApproach,
  pendingPress,
  respondToApproach,
  respondToMedia,
  declinePress,
  arrivedResponses,
  counterpartyAnchor,
  settleCounterparty,
  type CounterpartyRuling,
  type MarketSkillResult,
  buildOfficeViews,
  dealOdds,
  describeNegotiations,
  describeNextFixture,
  openManagerOffers,
  describeOdds,
  expiringContracts,
  digestLines,
  finalizeMatch,
  openRenewal,
  openTransferRequests,
  renewalExpectation,
  respondTransferRequest,
  incomingOffer,
  incomingOffers,
  pendingOffer,
  playerById,
  sendOffer,
  suggestTerms,
  setCaptain,
  setTactics,
  setTraining,
  clearTraining,
  addDays,
  diffDays,
  markEntered,
  startMatch,
  isInjured,
  headCoachOf,
  reportersOf,
  makeRng,
  pick,
  substitutePlayer,
  teamName,
  userPlayers,
  userSide,
  type GameState,
} from "@story-fm/engine";
import type { TrainAttr } from "@story-fm/domain";
import {
  MANAGER_TERMS_BY_TIER,
  positionGroupOfPlayer,
  shootoutTally,
  MANAGER_ATTRIBUTE_KO,
  matchupText,
  normalizePacket,
  packetTagContext,
  packetTagText,
  pressFactText,
  TRANSFER_REQUEST_REASON_KO,
} from "@story-fm/domain";
import type { ShootoutOutcome } from "@story-fm/domain";
import {
  MATCH_ADVANCED,
  TIME_PASSED,
  recordCall,
  type GmToolCall,
  type GmTurnResult,
  type TurnOperation,
} from "./gm-types";
import type { CardMark, GoalMark } from "@story-fm/engine";

/**
 * mock GM — LLM 없이 도는 결정적 오케스트레이터. e2e·오프라인 개발용이며,
 * 실모드 GM(gm.ts)과 같은 스킬 경로(엔진 함수)만 사용한다. 서사 품질이
 * 아니라 "시나리오가 끝까지 도는가"를 보장하는 것이 목적이다.
 */

/** mock 조정 — 이적료는 받은 오퍼의 1.25배로 되부른다 (감독이 답하는 자리다) */
const MOCK_COUNTER_FEE_RATE = 1.25;
/** mock 감독직 흥정 — 제시 조건의 1.2배를 되부른다 (천장은 코어가 자른다) */
const MOCK_MANAGER_COUNTER_RATE = 1.2;

/**
 * 우리 오퍼에 상대가 답한다 — **mock은 코어 앵커를 그대로 읽는다** (agents.md §4-1).
 *
 * 실모드의 폴백과 같은 함수(`settleCounterparty`)를 지나므로, mock이 자기 확률 구간을
 * 따로 들고 있다가 코어와 갈릴 자리가 없다. 판정도 금액도 코어가 정하고 mock이 더하는
 * 것은 감독에게 남길 한 줄뿐이다.
 */
function answerAsCounterparty(
  state: GameState,
  negotiation: Negotiation,
  notes: readonly [string, string],
): { input: CounterpartyRuling; result: MarketSkillResult; verdict: NegotiationVerdict } {
  const anchor = counterpartyAnchor(state, negotiation);
  if (!anchor) {
    return {
      input: { negotiationId: negotiation.id, verdict: "reject" },
      result: { ok: false, message: "답할 오퍼가 없습니다" },
      verdict: "reject",
    };
  }
  const note = anchor.verdict === "accept" ? notes[0] : notes[1];
  const { input, result } = settleCounterparty(state, anchor, { verdict: anchor.verdict, note });
  return { input, result, verdict: input.verdict };
}

/** 수석코치 화자 태그 — 직책이 아니라 그 사람의 이름이다 (people.md §3) */
function coach(state: GameState): string {
  return `@${headCoachOf(state).characterId}:`;
}

/** 회견장에 앉은 기자 — 회견마다 결정적으로 같은 사람이 묻는다 */
function reporter(state: GameState, press: PressConference): string {
  return `@${pick(makeRng(state.seed, `press-${press.id}`), reportersOf(state)).characterId}:`;
}

function playerName(state: GameState, id: string): string {
  return playerById(state, id)?.name ?? id;
}

function scoreLine(state: GameState): string {
  const match = state.pendingMatch;
  if (!match) return "";
  const record = state.matches.find((m) => m.id === match.matchId);
  if (!record) return "";
  const home = teamName(record.homeTeamId);
  const away = teamName(record.awayTeamId);
  return `${home} ${match.ledger.score.home} : ${match.ledger.score.away} ${away}`;
}

/** 구간 이벤트 → @문법 중계 텍스트 (실모드는 이 자리를 캐스터 LLM이 맡는다) */
function renderSegment(state: GameState, events: MatchEvent[], stop: string): string {
  const lines: string[] = [];
  for (const ev of events) {
    lines.push(...renderEvent(state, ev));
  }
  if (stop === "goal") {
    lines.push(`${coach(state)} 흐름이 우리 쪽인지 확인할 시점입니다. 이대로 갈까요?`);
  } else if (stop === "half_time") {
    lines.push(
      `@: *하프타임 — 라커룸으로 향한다*`,
      `${coach(state)} 현재 ${scoreLine(state)}. 후반 지시를 주시면 반영하겠습니다.`,
    );
  } else if (stop === "extra_time_start") {
    lines.push(
      `@중계: *90분 종료 — 승부는 연장으로 넘어갑니다.* ${scoreLine(state)}`,
      `${coach(state)} 30분이 더 남았습니다. 교체 한 장이 더 생겼습니다.`,
    );
  } else if (stop === "extra_half_time") {
    lines.push(`@중계: *연장 전반 종료.* ${scoreLine(state)}`);
  }
  return lines.join("\n");
}

/** 죽은 공에서 나온 슛인가 — 목 GM도 그 사실을 문장에 싣는다 (match.md §1.4) */
const MOCK_ORIGIN_KO: Record<string, string> = {
  corner: "코너에서 ",
  free_kick: "프리킥에서 ",
  penalty: "페널티킥 — ",
};

function renderEvent(state: GameState, ev: MatchEvent): string[] {
  const name = ev.actors[0] ? playerName(state, ev.actors[0]) : "";
  const from = ev.shotOrigin ? (MOCK_ORIGIN_KO[ev.shotOrigin] ?? "") : "";
  switch (ev.type) {
    case "kickoff":
      return [`@중계: 킥오프! 경기가 시작됩니다.`];
    case "goal": {
      const cause = ev.causes[0] ? ` (${packetTagText(ev.causes[0])})` : "";
      return [`@중계: *${ev.minute}′ — ${from}${name}, 골입니다!* ${scoreLine(state)}${cause}`];
    }
    case "shot":
      return [`@중계: ${ev.minute}′ ${from}${name}의 슛 — 아깝게 빗나갑니다.`];
    case "foul":
      return [`@중계: ${ev.minute}′ ${name}의 반칙 — 주심이 점을 가리킵니다!`];
    case "chance":
      return [`@중계: ${ev.minute}′ ${name}에게 기회가 왔지만 마무리가 아쉽습니다.`];
    case "save":
      return [`@중계: ${ev.minute}′ 골키퍼의 선방!`];
    case "half_time":
      return [];
    case "full_time":
      return [`@중계: *경기 종료 휘슬* 최종 스코어 ${scoreLine(state)}.`];
    case "substitution":
      return [
        `@: *교체 보드가 올라간다 — ${playerName(state, ev.actors[0] ?? "")} OUT, ${playerName(state, ev.actors[1] ?? "")} IN*`,
      ];
    // 상대 벤치가 판을 옮겼다 — 문장은 근거 태그의 렌더러가 만든다 (match.md §2)
    case "tactical_shift":
      return ev.causes[0]
        ? [`@중계: ${ev.minute}′ 상대 벤치가 움직입니다 — ${packetTagText(ev.causes[0])}.`]
        : [];
    default:
      return [];
  }
}

const SHOOTOUT_KO: Record<ShootoutOutcome, string> = {
  scored: "성공입니다!",
  saved: "골키퍼가 막아냅니다!",
  missed: "골문을 벗어납니다!",
};

/**
 * 승부차기 — **mock은 한 턴에 끝까지 몬다.**
 *
 * 실모드는 한 발씩 끊어 감독에게 넘기지만(match.md §2), e2e·오프라인에는 진행
 * 손잡이를 다시 누를 사람이 없다. 여기서 한 발만 굴리고 멈추면 컵 경기가 그 자리에
 * 갇힌다. 킥을 굴리는 것은 두 모드가 같은 코어 함수다.
 */
function runShootoutTurn(state: GameState, calls: GmToolCall[]): string {
  const lines: string[] = ["@중계: *120분이 승부를 가르지 못했습니다 — 승부차기로 갑니다.*"];
  // 서든데스에는 상한이 없지만 성공률이 대역 안에 갇혀 있어 언젠가 갈린다.
  // 이 상한은 판정이 아니라 모의 GM이 무한히 돌지 않게 하는 빗장이다
  for (let i = 0; i < 60; i += 1) {
    const kicked = advanceShootout(state);
    if (!kicked.ok) {
      lines.push(`${coach(state)} ${kicked.message}`);
      return lines.join("\n");
    }
    const kick = kicked.kick;
    if (kick) {
      lines.push(
        `@중계: ${kick.round}번째 키커 ${playerName(state, kick.taker)} — ${SHOOTOUT_KO[kick.outcome]}`,
      );
    }
    if (kicked.done) break;
  }
  const tally = shootoutTally(state.pendingMatch?.shootout?.kicks ?? []);
  lines.push(`@중계: *승부차기 ${tally.home} : ${tally.away}.*`);
  calls.push({
    name: MATCH_ADVANCED,
    summary: `승부차기 ${tally.home}-${tally.away}`,
    silent: true,
  });
  const digest = finalizeMatch(state);
  lines.push(`${coach(state)} ${digestLines(digest).join(" · ")}`);
  return lines.join("\n");
}

/**
 * 경기 진행 — 실모드와 같은 코어 함수(`advanceSegment`)로 굴린다.
 * 두 모드의 차이는 화자뿐이다 — 여기선 템플릿, 실모드에선 캐스터 LLM.
 */
function advanceMatchTurn(
  state: GameState,
  calls: GmToolCall[],
  goals: GoalMark[],
  cards: CardMark[] = [],
): string {
  // 장부가 끝났어도 승부가 남은 경기 — 구간이 아니라 승부차기를 굴린다
  if (awaitingShootout(state)) return runShootoutTurn(state, calls);
  const before = { ...(state.pendingMatch?.ledger.score ?? { home: 0, away: 0 }) };
  const ourSide = userSide(state);
  const step = advanceSegment(state);
  if (!step.ok || !step.plan) {
    return `${coach(state)} ${step.message}`;
  }
  calls.push({ name: MATCH_ADVANCED, summary: step.message, silent: true });
  // 골 표식 — 실모드와 같은 자리에서 같은 사실을 만든다 (장부의 사건)
  const record = state.matches.find((m) => m.id === state.pendingMatch?.matchId);
  const running = { ...before };
  const bookedHere = new Set<string>();
  for (const ev of step.plan.events) {
    if (!ev.team || !record) continue;
    const sideName = teamName(ev.team === "home" ? record.homeTeamId : record.awayTeamId);
    if (ev.type === "goal") {
      running[ev.team] += 1;
      goals.push({
        minute: ev.minute,
        scorer: ev.actors[0] ? playerName(state, ev.actors[0]) : "",
        assist: ev.actors[1] ? playerName(state, ev.actors[1]) : null,
        ours: ev.team === ourSide,
        team: sideName,
        score: { ...running },
      });
      continue;
    }
    const who = ev.actors[0];
    if ((ev.type === "yellow_card" || ev.type === "red_card") && who) {
      const second = ev.type === "red_card" && bookedHere.has(who);
      if (ev.type === "yellow_card") bookedHere.add(who);
      cards.push({
        minute: ev.minute,
        player: playerName(state, who),
        kind: ev.type === "yellow_card" ? "yellow" : second ? "second_yellow" : "red",
        ours: ev.team === ourSide,
        team: sideName,
      });
    }
  }
  let text = renderSegment(state, step.plan.events, step.plan.stop);
  if (awaitingShootout(state)) {
    // 120분이 끝났는데 승부가 남았다 — 마감은 승부차기가 갈린 뒤다
    text += `\n${runShootoutTurn(state, calls)}`;
  } else if (step.plan.stop === "full_time") {
    // 모의 GM은 화면 장면이 곧 보고다 — 갈래를 나누지 않고 전부 싣는다
    const digest = finalizeMatch(state);
    text += `\n${coach(state)} ${digestLines(digest).join(" · ")}`;
  }
  return text;
}

// mock은 자연어를 정교히 해석하지 못하므로 키워드→focus로 간이 매핑 (e2e·오프라인용)
/**
 * 훈련 키워드 → 효과 축과 **세션 이름**.
 *
 * 이름을 여기서 함께 고른다 — label은 **달력에 걸릴 제목**이지 감독의 말이 아니다.
 */
const FOCUS_KEYWORDS: Array<[RegExp, TrainAttr[], string]> = [
  [/세트\s?피스|프리킥|코너/u, ["kicking", "finishing"], "세트피스"],
  [/슈팅|골\s?결정력|마무리/u, ["finishing"], "마무리"],
  [/공중볼|헤더|제공권/u, ["aerial"], "제공권"],
  [/수비|조직력/u, ["tackling", "positioning", "tactical"], "수비 조직"],
  [/전술/u, ["tactical"], "전술 훈련"],
  [/크로스|측면|롱볼|전환/u, ["kicking", "passing"], "측면 전환"],
  [/패스|점유|빌드업/u, ["passing", "vision"], "빌드업"],
  [/드리블|돌파|1대1/u, ["dribbling"], "1대1 돌파"],
  [/스피드|스프린트|가속/u, ["pace"], "스프린트"],
  [/지구력|체력|피지컬|피트니스|러닝/u, ["stamina", "strength"], "피지컬"],
  [/회복|휴식|리커버리/u, ["recovery"], "회복 훈련"],
  // 침투는 수비 위치선정과 다른 축이다 — 위 줄들과 겹치는 낱말이 없어 맨 뒤에 선다
  [/침투|뒷공간|오프더볼/u, ["offTheBall"], "오프더볼 침투"],
];
const WEEKDAY_KEYWORDS: Array<[RegExp, string]> = [
  [/일요일/u, "0"],
  [/월요일/u, "1"],
  [/화요일/u, "2"],
  [/수요일/u, "3"],
  [/목요일/u, "4"],
  [/금요일/u, "5"],
  [/토요일/u, "6"],
];

function detectPlayer(state: GameState, message: string, scope: "ours" | "all" = "ours") {
  // 이름 조각(2자 이상)으로 탐색 — 성/이름 어느 쪽이든.
  // 이적 이야기는 타 팀 선수를 지목하므로 scope="all"로 전체를 본다.
  const pool = scope === "all" ? [...userPlayers(state), ...state.players] : userPlayers(state);
  for (const player of pool) {
    const parts = [player.name, ...player.name.split(" ")];
    if (parts.some((part) => part.length >= 2 && message.includes(part))) return player;
  }
  return null;
}

/**
 * 감독의 말에서 금액 한 덩이 — mock이 읽는 눈금은 **숫자와 단위 하나**다.
 *
 * 못 읽으면 `null`이고, 부르는 쪽은 지어내는 대신 되묻는다 — 실모드의 도구 설명도
 * "액수를 말하지 않았으면 지어내지 말고 물어라"이므로 두 모드가 같은 결이어야 한다.
 */
function detectMoney(message: string): number | null {
  const m = message.match(/([\d,]+(?:\.\d+)?)\s*(백만|만|[mM]\b)?/u);
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(/,/gu, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (m[2] === "만") return Math.round(n * 10_000);
  if (m[2] !== undefined && m[2] !== "만") return Math.round(n * 1_000_000);
  return Math.round(n);
}

/**
 * mock GM 턴 — 규칙 기반. onText를 주면 완성된 서사 텍스트를 청크로 쪼개
 * 즉시 방출한다 (실모드의 진짜 스트리밍과 동일한 인터페이스를 흉내).
 */
export function runMockGmTurn(
  state: GameState,
  message: string,
  onText?: (delta: string) => void,
  /**
   * 손잡이가 보낸 조작 — **말이 아니라 구조체다.** 있으면 아래의 자연어 해석을
   * 지나친다. mock이 실모드와 갈라지던 자리가 여기였다: 화면이 보낸 문장을
   * 정규식으로 되읽었기 때문에 문구가 바뀌면 mock만 조용히 멎었다.
   */
  operation?: TurnOperation | null,
): GmTurnResult {
  const computed = computeMockGmTurn(state, message, operation);
  // 실모드와 같은 모양으로 첫 줄에 시점을 세운다 — mock은 시계를 직접 옮기므로
  // (advanceTime) 헤더는 파싱 대상이 아니라 표시일 뿐이다
  const stamp =
    state.phase === "match"
      ? `[${state.pendingMatch?.ledger.minute ?? 0}']`
      : `[${state.date} ${formatClock(clockOf(state))}]`;
  const result: GmTurnResult = {
    ...computed,
    text: computed.text ? `${stamp}\n${computed.text}` : computed.text,
    // ⚠️ 스킬 자리(line)는 본문 기준이다 — 여기서 헤더가 붙으므로 한 줄씩 밀어야
    // 실모드(헤더 포함 셈)와 눈금이 같다
    toolCalls: computed.toolCalls.map((call) =>
      call.line === undefined || !computed.text ? call : { ...call, line: call.line + 1 },
    ),
  };
  if (onText && result.text) {
    // 줄 단위로 흘려보낸다 — 채팅 UI가 점진적으로 렌더된다
    const lines = result.text.split("\n");
    lines.forEach((line, i) => onText(i === 0 ? line : `\n${line}`));
  }
  return result;
}

function computeMockGmTurn(
  state: GameState,
  message: string,
  operation?: TurnOperation | null,
): GmTurnResult {
  const calls: GmToolCall[] = [];
  const msg = message.trim();

  /**
   * ── 손잡이 — **아래의 자연어보다 먼저 갈린다** ────────────────────────
   *
   * `message`는 조작에서 만든 표시 문구일 뿐이라 여기서 되읽지 않는다. 아래로
   * 흘려보내면 그 문구가 다른 갈래의 정규식에 걸려 손잡이 하나가 엉뚱한 스킬을
   * 부른다 — mock이 실모드와 갈라지던 자리가 여기였다 (agents.md §2).
   *
   * 시간 이동은 **평시에만** 뜻이 있다 — 실모드의 `advanceForOperation`과 같은
   * 문이다. 경기 중에는 시간을 달력이 아니라 경기가 밀고(아래 경기 블록), 경기일엔
   * 넘길 곳이 오늘뿐이라 코어가 손잡이를 받지 않는다.
   */
  if (operation != null && operation.kind !== "advance_match" && state.phase === "idle") {
    return mockAdvance(
      state,
      calls,
      operation.kind === "skip_days"
        ? operation.days
        : operation.kind === "skip_to_next_match"
          ? Math.max(1, diffDays(state.date, operation.date))
          : null,
    );
  }

  // ── 경기 중 ──────────────────────────────────────────
  if (state.phase === "match") {
    /**
     * 킥오프 턴 — **첫 휘슬만.** 감독이 들어선 그 한 턴은 사건을 굴리지 않는다.
     * 실모드에서 캐스터가 도구 없이 여는 자리와 같은 자리다 (gm.ts의 `kickoff`).
     */
    if (state.pendingMatch?.entered !== true) {
      markEntered(state);
      const record = state.matches.find((m) => m.id === state.pendingMatch?.matchId);
      const fixture = record
        ? `${teamName(record.homeTeamId)} 대 ${teamName(record.awayTeamId)}`
        : "양 팀";
      return {
        text: [
          `@: *터널을 나선 스물두 명이 자리를 잡는다*`,
          `@중계: ${fixture}, 곧 킥오프입니다.`,
          `@중계: 주심이 휘슬을 입에 뭅니다.`,
        ].join("\n"),
        toolCalls: calls,
      };
    }
    /**
     * 손잡이로 온 진행 — **해석할 것이 없다.** 전술판 조작은 코어가 이미
     * 적용했고(turn-runner), `advance_match`가 뜻하는 것은 한 구간 더뿐이다.
     * 여기서 문구를 정규식으로 되읽어 스킬을 다시 걸면 **이미 반영된 교체
     * 문구**가 아래 `/교체/`에 걸려 같은 교체가 두 번 일어난다 (실모드에는
     * 없는 갈래다).
     *
     * 조작의 종류를 가리지 않는 것은 실모드와 같다 — 경기 중 손잡이가 뜻하는
     * 것은 진행 하나뿐이다 (gm.ts의 `advance: "segment"`).
     */
    if (operation != null) {
      const goals: GoalMark[] = [];
      const cards: CardMark[] = [];
      const text = advanceMatchTurn(state, calls, goals, cards);
      return {
        text,
        toolCalls: calls,
        ...(goals.length > 0 ? { goals } : {}),
        ...(cards.length > 0 ? { cards } : {}),
      };
    }
    const formationMatch = msg.match(/([345])-\d(-\d)?(-\d)?/u);
    if (formationMatch && /전술|포메이션|바꾸|변경|가자|쓰자/u.test(msg)) {
      const input = { formation: formationMatch[0] as never };
      const result = setTactics(state, input);
      recordCall(calls, "set_tactics", result, { input });
      return {
        text: result.ok
          ? `${coach(state)} 전술판에 새 배치를 올렸습니다. 자리와 역할을 확인하신 뒤 진행해 주십시오.`
          : `${coach(state)} ${result.message}`,
        toolCalls: calls,
      };
    }
    if (/교체/u.test(msg)) {
      const roster = userPlayers(state);
      const side = userSide(state);
      const ledgerSide =
        side === "home" ? state.pendingMatch?.ledger.home : state.pendingMatch?.ledger.away;
      const onPitch = ledgerSide?.onPitch ?? [];
      const bench = ledgerSide?.bench ?? [];
      const mentioned = roster.filter((p) =>
        p.name.split(" ").some((part) => part.length >= 2 && msg.includes(part)),
      );
      const out = mentioned.find((p) => onPitch.includes(p.id));
      const sub = mentioned.find((p) => bench.includes(p.id)) ?? null;
      // 폴백은 필드 플레이어 우선 — bench[0]이 백업 GK일 수 있다 (리뷰 발견)
      const benchOutfield = bench.find((id) => {
        const p = roster.find((x) => x.id === id);
        return p !== undefined && positionGroupOfPlayer(p) !== "GK" && !isInjured(state, p.id);
      });
      const subId = sub?.id ?? benchOutfield ?? bench[0];
      if (out && subId) {
        const result = substitutePlayer(state, { out: out.id, in: subId });
        recordCall(calls, "substitute", result, { input: { out: out.id, in: subId } });
        return {
          text: result.ok
            ? `@: *교체 준비 — ${out.name} OUT, ${playerName(state, subId)} IN*\n${coach(state)} 반영했습니다.`
            : `${coach(state)} ${result.message}`,
          toolCalls: calls,
        };
      }
      return {
        text: `${coach(state)} 누구를 빼고 누구를 넣을까요? 벤치: ${bench.map((id) => playerName(state, id)).join(", ")}`,
        toolCalls: calls,
      };
    }
    if (/팀토크|한마디|외쳐/u.test(msg)) {
      const input = { occasion: "half", outcome: "encouraged", intensity: 2 } as const;
      const result = applyTeamTalk(state, input);
      recordCall(calls, "team_talk", result, { input, line: 1 });
      return {
        text: `@: *감독의 목소리가 라커룸을 울린다*\n${coach(state)} ${result.message}`,
        toolCalls: calls,
      };
    }
    const goals: GoalMark[] = [];
    const cards: CardMark[] = [];
    const text = advanceMatchTurn(state, calls, goals, cards);
    return {
      text,
      toolCalls: calls,
      ...(goals.length > 0 ? { goals } : {}),
      ...(cards.length > 0 ? { cards } : {}),
    };
  }

  // ── 경기일 (킥오프 전) ────────────────────────────────
  if (state.phase === "matchday") {
    // 명시적 킥오프 의사만 — "라인업 점검하러 가자" 같은 발화로 오발동 금지 (리뷰 발견)
    if (/경기 시작|킥오프|시작하자|시작해|들어가자/u.test(msg)) {
      const started = startMatch(state);
      if (!started.ok) return { text: `${coach(state)} ${started.message}`, toolCalls: calls };
      // `startMatch`는 `FlowResult`라 실을 카드도 항목도 없다 (실패는 위에서 갈렸다)
      recordCall(calls, "start_match", started);
      const packet = state.pendingMatch?.packet
        ? normalizePacket(state.pendingMatch.packet)
        : undefined;
      const tagCtx = packet ? packetTagContext(packet) : undefined;
      // 킥오프는 여기서 굴리지 않는다 — 공은 감독이 입장 확인 창을 누를 때 구른다
      const briefing = packet
        ? [
            `${coach(state)} 전력 분석입니다 — ${packet.home.teamName}(홈) vs ${packet.away.teamName}, 기대 득점 ${packet.guide.expectedGoals.home} : ${packet.guide.expectedGoals.away}`,
            ...packet.matchups.map((m) => `${coach(state)} · ${matchupText(m)}`),
            ...packet.keyPoints.map((k) => `${coach(state)} ★ ${packetTagText(k, tagCtx)}`),
          ].join("\n")
        : "";
      return {
        text: [`@: *터널 앞, 선수단이 도열한다*`, briefing].filter(Boolean).join("\n"),
        toolCalls: calls,
      };
    }
    return {
      text: `${coach(state)} 오늘은 경기일입니다. 라인업·전술을 점검하시고 준비되면 말씀하십시오.`,
      toolCalls: calls,
    };
  }

  /**
   * ── 무직 ─────────────────────────────────────────────
   *
   * 맡은 팀이 없으면 아래 분기는 전부 남의 구단을 만지는 일이라(실모드는
   * `buildGmTools`가 같은 자리에서 막는다) 여기서 끝난다. 할 수 있는 것은
   * **셋뿐**이다 — 받은 제안을 수락하거나, 한 차례 조건을 되부르거나, 공석에
   * 먼저 지원하는 것 (career.md §5.1). 실모드가 여는 도구도 그 셋이다.
   *
   * **화자는 아무도 아니다.** 수석코치는 옛 구단의 사람이라 무직인 감독 옆에
   * 없다 — 그를 세우면 잘린 구단의 직원이 새 자리를 함께 고르는 장면이 된다.
   * 그래서 이 분기만 내레이션(`@:`)으로 흐른다.
   */
  if (state.dismissal) {
    const offers = openManagerOffers(state);
    const vacancies = state.managerVacancies ?? [];
    const named = offers.find((o) => msg.includes(teamName(o.teamId)) || msg.includes(o.id));

    // ① 노크 — 부르는 곳이 없을 때 먼저 두드린다. 열린 제안이 있으면 코어가 막는다
    if (/지원|노크|두드|먼저 연락|이력서/u.test(msg)) {
      const wanted = vacancies.find((v) => msg.includes(teamName(v.teamId))) ?? vacancies[0];
      if (!wanted) {
        return { text: `@: *지금 두드릴 공석이 없다*`, toolCalls: calls };
      }
      const result = applyForManagerJob(state, wanted.teamId);
      recordCall(calls, "apply_manager_job", result, { input: { team: wanted.teamId } });
      return {
        text: `@: *${teamName(wanted.teamId)} 사무국에 이력서가 닿는다*\n@: *${result.message}*`,
        toolCalls: calls,
      };
    }

    // ② 흥정 — 수락보다 먼저 본다. "아스날 조건 더 받아내자"의 구단 이름은 수락이 아니다
    const haggling = /흥정|되불|더 받|올려|깎|조건을 더|연봉|예산/u.test(msg);
    if (haggling && (named ?? offers[0])) {
      const offer = named ?? offers[0]!;
      const base = MANAGER_TERMS_BY_TIER[offer.tier as 1 | 2 | 3 | 4];
      // 무엇을 되부를지는 감독의 말이 정한다 — 예산 이야기가 아니면 연봉이다
      const ask = /예산|보강|영입 자금/u.test(msg)
        ? {
            transferBudget: Math.round(
              (offer.budgetPledge ?? base.budgetPledge) * MOCK_MANAGER_COUNTER_RATE,
            ),
          }
        : { salary: Math.round((offer.salary ?? base.salary) * MOCK_MANAGER_COUNTER_RATE) };
      const result = counterManagerOffer(state, offer.id, ask);
      recordCall(calls, "counter_manager_offer", result, { input: { offer: offer.id, ...ask } });
      return {
        text: `@: *${teamName(offer.teamId)}와의 전화가 길어진다*\n@: *${result.message}*`,
        toolCalls: calls,
      };
    }

    // ③ 수락 — 감독이 받겠다고 했거나 구단을 지목했을 때만
    const taking = /수락|받겠|받아|가겠|맡겠|부임|간다|하겠/u.test(msg);
    const target = named ?? (taking ? offers[0] : undefined);
    if (target) {
      const result = acceptManagerOffer(state, target.id);
      recordCall(calls, "accept_manager_offer", result);
      return {
        text: `@: *새 구단의 회장실, 계약서가 놓인다*\n@: *${result.message}*`,
        toolCalls: calls,
      };
    }

    const waiting =
      offers.length > 0
        ? `들어온 자리 — ${offers
            .map((o) => `${teamName(o.teamId)} (${o.expiresOn}까지)`)
            .join(" · ")}`
        : vacancies.length > 0
          ? `부르는 곳은 아직 없다. 비어 있는 자리 — ${vacancies
              .map((v) => teamName(v.teamId))
              .join(" · ")}`
          : `부르는 곳도, 비어 있는 자리도 아직 없다`;
    return { text: `@: *${waiting}*`, toolCalls: calls };
  }

  /**
   * ── 사재 — 감독의 지갑에서 나가는 셋 (career.md §5.4) ───
   *
   * 무직 분기 뒤에 선다 — 셋 다 맡은 팀이 있어야 하는 일이고, 실모드도 같은 자리에서
   * 막는다(`buildGmTools`).
   */
  if (/사임|사퇴|그만두겠|물러나겠/u.test(msg)) {
    const result = resignPost(state);
    recordCall(calls, "resign", result);
    return { text: `@: *${result.message}*`, toolCalls: calls };
  }
  if (/사재|내 돈|개인 돈|지갑/u.test(msg) && /예산|보강|영입|출연/u.test(msg)) {
    const amount = detectMoney(msg);
    if (amount === null) {
      return { text: `${coach(state)} 얼마를 넣으시겠습니까?`, toolCalls: calls };
    }
    const result = fundTransferBudget(state, { amount });
    recordCall(calls, "fund_transfer_budget", result, { input: { amount } });
    return { text: `${coach(state)} ${result.message}`, toolCalls: calls };
  }
  if (/보너스|포상/u.test(msg)) {
    const who = detectPlayer(state, msg);
    if (!who) {
      return { text: `${coach(state)} 누구에게 주시겠습니까?`, toolCalls: calls };
    }
    const amount = detectMoney(msg);
    if (amount === null) {
      return { text: `${coach(state)} ${who.name}에게 얼마를 주시겠습니까?`, toolCalls: calls };
    }
    const result = payPlayerBonus(state, { playerId: who.id, amount });
    recordCall(calls, "pay_player_bonus", result, { input: { playerId: who.id, amount } });
    return { text: `${coach(state)} ${result.message}`, toolCalls: calls };
  }

  // ── 일상 ─────────────────────────────────────────────
  const formationMatch = msg.match(/([345])-\d(-\d)?(-\d)?/u);
  if (formationMatch && /전술|포메이션|바꾸|변경|가자|쓰자/u.test(msg)) {
    const formation = formationMatch[0] as never;
    const mentality = /공격적/u.test(msg) ? 4 : /수비적/u.test(msg) ? 2 : undefined;
    const input = { formation, ...(mentality ? { mentality } : {}) };
    const result = setTactics(state, input);
    recordCall(calls, "set_tactics", result, { input });
    return {
      text: result.ok
        ? `${coach(state)} *전술 보드를 고쳐 세운다* ${result.message}. 선수들에게 전달하겠습니다.`
        : `${coach(state)} ${result.message}`,
      toolCalls: calls,
    };
  }

  // 훈련을 없애는 지시가 먼저다 — "훈련 쉬자"는 /훈련/에도 걸려, 순서를 뒤집으면
  // "휴식"이라는 이름의 훈련이 등록된다
  if (/쉬|휴식|훈련\s*(취소|빼|없애|지워)/u.test(msg)) {
    const dows = WEEKDAY_KEYWORDS.filter(([re]) => re.test(msg)).map(([, d]) => Number(d));
    // "내일"이 없으면 오늘 하루 — 범위는 좁은 쪽이 기본이다 (clearTraining)
    const from = /내일/u.test(msg) ? addDays(state.date, 1) : state.date;
    const input = {
      from,
      ...(dows.length > 0 ? { to: addDays(from, 13), dow: dows[0] } : {}),
      ...(/오후/u.test(msg) ? { slot: "pm" as const } : {}),
    };
    const result = clearTraining(state, input);
    recordCall(calls, "set_training", result, { input });
    return {
      text: `${coach(state)} ${result.message}`,
      toolCalls: calls,
    };
  }

  if (/훈련|트레이닝/u.test(msg)) {
    const matched = FOCUS_KEYWORDS.find(([re]) => re.test(msg));
    const focus = matched?.[1] ?? ["passing"];
    // 세션 이름은 키워드가 정한다 — 감독의 말을 잘라 넣으면 그게 달력의 제목이 된다
    const label = matched?.[2] ?? "빌드업";
    const slot: "am" | "pm" = /오후|오후에/u.test(msg) ? "pm" : "am"; // 기본 오전
    const session = { label, focus };
    const dows = WEEKDAY_KEYWORDS.filter(([re]) => re.test(msg)).map(([, d]) => d);
    // 요일 명시 없으면 평일(월~금)에 등록. 스킬이 일정 엔트리를 직접 펼친다 (v6)
    const targetDows = dows.length > 0 ? dows : ["1", "2", "3", "4", "5"];
    const input = {
      repeatWeekly: targetDows.map((d) => ({
        dow: Number(d),
        slot,
        label: session.label,
        focus: session.focus,
      })),
    };
    const result = setTraining(state, input);
    recordCall(calls, "set_training", result, { input });
    /**
     * 장면은 **도구 결과를 인용하지 않는다.** `message`는 모델이 읽고 소화할 줄이고,
     * 무엇이 잡혔는지는 칩과 말풍선이 이미 항목으로 세운다 — 대사가 그걸 옮겨 적으면
     * 같은 사실이 두 번, 그것도 한쪽은 글자 벽으로 선다.
     */
    const kinds = [...new Set(input.repeatWeekly.map((r) => r.label))].join("·");
    return {
      text: result.ok
        ? `${coach(state)} *수첩에 받아 적는다* ${kinds} 세션으로 주 ${input.repeatWeekly.length}회 잡았습니다.`
        : `${coach(state)} ${result.message}`,
      toolCalls: calls,
    };
  }

  // 재계약 — 상대가 선수 본인이므로 이적 분기보다 먼저 본다
  if (/재계약|계약 연장|계약을 연장|잡아|남겨/u.test(msg)) {
    const who = detectPlayer(state, msg) ?? expiringContracts(state, 365)[0]?.player ?? null;
    if (!who) {
      return {
        text: `${coach(state)} 지금 계약이 급한 선수는 없습니다.`,
        toolCalls: calls,
      };
    }
    const renewal = state.negotiations.find(
      (n) => n.gamePlayerId === who.id && n.kind === "renew" && n.status === "open",
    );
    const waiting = renewal ? pendingOffer(renewal) : null;
    // 답이 도착했으면 선수 본인이 되어 확률대로 판정한다
    if (renewal && waiting && waiting.respondsOn !== null && waiting.respondsOn <= state.date) {
      const { input, result, verdict } = answerAsCounterparty(state, renewal, [
        "여기 남겠습니다",
        "조건을 더 봐야겠습니다",
      ]);
      recordCall(calls, "respond_offer", result, { input });
      let text = `@${who.name}: ${result.message}`;
      if (result.ok && verdict === "accept") {
        const done = acceptDeal(state, renewal.id);
        recordCall(calls, "accept_deal", done);
        text += `\n${coach(state)} ${done.message}`;
      }
      return { text, toolCalls: calls };
    }
    const input = {
      playerId: who.id,
      weeklyWage: renewalExpectation(state, who),
      years: 3,
    };
    const result = openRenewal(state, input);
    recordCall(calls, "open_renewal", result, { input });
    return {
      text: result.ok
        ? `@: *${who.name}의 에이전트와 마주 앉는다*\n${coach(state)} ${result.message}`
        : `${coach(state)} ${result.message}`,
      toolCalls: calls,
    };
  }

  /**
   * 이적 요청에 답한다 — **이적 분기보다 먼저 본다.** 요청을 말하는 문장에는
   * 「이적」이 들어 있어 뒤에 두면 협상 분기가 먼저 삼킨다.
   *
   * 기본은 거부다 — mock은 세계를 최소로 움직인다.
   */
  const request = openTransferRequests(state)[0];
  if (request && /이적 요청|요청.*(수락|받아들|거부|거절)|안 판다|못 판다|보낸다/u.test(msg)) {
    const input = {
      playerId: request.gamePlayerId,
      answer: /수락|받아들|보낸다|보내겠/u.test(msg) ? ("accept" as const) : ("refuse" as const),
    } as const;
    const result = respondTransferRequest(state, input);
    recordCall(calls, "respond_transfer_request", result, { input, line: 2 });
    return {
      text: `@: *책상 위에 놓인 요청서 한 장*\n@${playerName(state, request.gamePlayerId)}: ${TRANSFER_REQUEST_REASON_KO[request.reason]} 때문입니다. 보내 주십시오.\n${coach(state)} ${result.message}`,
      toolCalls: calls,
    };
  }

  // ── 이적 협상 (mock) — 실모드는 LLM이 상대편이 되어 판정하지만 mock은 테스트
  // 재현성을 위해 확률 구간으로 가른다 (수락 / 조정 / 결렬)
  if (/협상|오퍼|이적|영입|매각|팔|사자|데려/u.test(msg)) {
    const incoming = incomingOffers(state)[0];
    // ① 받은 오퍼가 있으면 그것부터 — 감독의 뜻을 읽는다
    if (incoming) {
      const offer = incomingOffer(incoming)!;
      const player = playerById(state, incoming.gamePlayerId);
      const verdict = /거절|안 팔|안팔|거부/u.test(msg)
        ? "reject"
        : /더|올려|비싸|높여/u.test(msg)
          ? "counter"
          : "accept";
      const input = {
        negotiationId: incoming.id,
        verdict,
        ...(verdict === "counter" ? { fee: Math.round(offer.fee * MOCK_COUNTER_FEE_RATE) } : {}),
        note:
          verdict === "accept"
            ? "그 값이면 보내겠습니다"
            : verdict === "reject"
              ? "팔 생각이 없습니다"
              : "그 값으로는 못 보냅니다",
      } as const;
      const result = answerIncomingOffer(state, input);
      recordCall(calls, "respond_offer", result, { input });
      let text = `${coach(state)} ${result.message}`;
      if (result.ok && verdict === "accept") {
        const done = acceptDeal(state, incoming.id);
        recordCall(calls, "accept_deal", done);
        text = `${coach(state)} ${done.message}`;
      }
      return {
        text: `@: *${player?.name ?? ""} 건으로 사무실 전화가 울린다*\n${text}`,
        toolCalls: calls,
      };
    }

    // ② 답이 도착한 우리 오퍼가 있으면 상대편이 되어 판정한다
    const arrived = arrivedResponses(state)[0];
    if (arrived) {
      const { input, result, verdict } = answerAsCounterparty(state, arrived, [
        "그 값이면 놓아준다",
        "그 값으로는 어렵다",
      ]);
      recordCall(calls, "respond_offer", result, { input });
      let text = `${coach(state)} ${result.message}`;
      if (result.ok && verdict === "accept") {
        const done = acceptDeal(state, arrived.id);
        recordCall(calls, "accept_deal", done);
        text += `\n${coach(state)} ${done.message}`;
      }
      return { text, toolCalls: calls };
    }

    // ③ 감독이 지목한 선수에게 오퍼를 넣는다 — 금액은 코어의 기본값
    const wanted = detectPlayer(state, msg, "all");
    if (wanted && wanted.teamId !== state.userTeamId) {
      const terms = suggestTerms(state, wanted.id);
      if (terms) {
        const odds = dealOdds(state, terms);
        const result = sendOffer(state, terms);
        recordCall(calls, "send_offer", result, { input: terms });
        return {
          text: result.ok
            ? `${coach(state)} ${describeOdds(odds).split("\n")[0]}. ${result.message}`
            : `${coach(state)} ${result.message}`,
          toolCalls: calls,
        };
      }
    }
    return {
      text: `${coach(state)} ${describeNegotiations(state)}`,
      toolCalls: calls,
    };
  }

  // 기자회견 — 열려 있으면 답하거나 거절한다 (press.ts)
  const press = pendingPress(state);
  if (press && /회견|기자|인터뷰|언론/u.test(msg)) {
    if (/거절|안 하|안하|취소|피하|생략/u.test(msg)) {
      const result = declinePress(state);
      recordCall(calls, "respond_to_media", result, { input: { decline: true }, line: 1 });
      return {
        text: `@: *감독은 회견장을 지나쳐 버스에 올랐다*\n${coach(state)} ${result.message}`,
        toolCalls: calls,
      };
    }
    const stance = /비판|질책|문제|책임을 물/u.test(msg)
      ? "criticise"
      : /내 탓|내 책임|제 책임/u.test(msg)
        ? "own"
        : /자신|반드시|이긴다|도발/u.test(msg)
          ? "bold"
          : /말을 아끼|노코멘트|언급하지/u.test(msg)
            ? "deflect"
            : "defend";
    const input = { stance } as const;
    const result = respondToMedia(state, input);
    recordCall(calls, "respond_to_media", result, { input, line: 2 });
    return {
      text: `@: *플래시가 터지는 회견장*\n${reporter(state, press)} ${mockQuestion(press)}\n${coach(state)} ${result.message}`,
      toolCalls: calls,
    };
  }
  /**
   * 찾아온 사람 — 열려 있으면 답하거나 돌려보낸다 (approach.ts).
   *
   * 회견처럼 **잡아 두지는 않는다**: 다가옴은 감독이 부르지 않아도 사흘 뒤 코어가
   * 닫으므로, 열려 있다는 이유만으로 mock의 모든 턴을 가로채면 다른 지시가 막힌다.
   */
  const approach = pendingApproach(state);
  if (approach && /면담|찾아|만나|불만|들어보|얘기|이야기/u.test(msg)) {
    const decline = /거절|돌려보|나중|안 만나|안만나|바쁘/u.test(msg);
    const input = decline
      ? ({ decline: true } as const)
      : ({
          stance: /비판|질책|문제/u.test(msg)
            ? ("criticise" as const)
            : /내 탓|내 책임|제 책임/u.test(msg)
              ? ("own" as const)
              : /말을 아끼|노코멘트/u.test(msg)
                ? ("deflect" as const)
                : ("defend" as const),
        } as const);
    const result = respondToApproach(state, input);
    recordCall(calls, "respond_to_approach", result, { input, line: 2 });
    return {
      text: `@: *감독실 문이 열린다*\n@${approach.speakerId}: ${pressFactText(approach.facts[0]!)}\n${coach(state)} ${result.message}`,
      toolCalls: calls,
    };
  }

  if (/팀토크|미팅|다들 모여|한마디/u.test(msg)) {
    const input = { occasion: "daily", outcome: "encouraged", intensity: 2 } as const;
    const result = applyTeamTalk(state, input);
    recordCall(calls, "team_talk", result, { input, line: 1 });
    return {
      text: `@: *훈련장 한가운데, 선수단이 감독을 둘러싼다*\n${coach(state)} ${result.message}`,
      toolCalls: calls,
    };
  }

  if (/면담|얘기 좀|불러/u.test(msg)) {
    const target = detectPlayer(state, msg);
    if (!target) {
      const issues = state.issues.map((i) => playerName(state, i.gamePlayerId)).join(", ");
      return {
        text: `${coach(state)} 누구와 면담할까요?${issues ? ` 지금 불만이 쌓인 선수: ${issues}` : ""}`,
        toolCalls: calls,
      };
    }
    const input = { playerId: target.id, outcome: "motivated", intensity: 2 } as const;
    const result = applyTalkToPlayer(state, input);
    recordCall(calls, "talk_to_player", result, { input, line: 2 });
    return {
      text: `@: *감독실 문이 닫힌다*\n@${target.name}: 믿어주셔서 감사합니다. 훈련으로 보여드리겠습니다.\n${coach(state)} ${result.message}`,
      toolCalls: calls,
    };
  }

  if (/주장/u.test(msg)) {
    const target = detectPlayer(state, msg);
    if (target) {
      const result = setCaptain(state, { playerId: target.id });
      recordCall(calls, "set_captain", result, { input: { playerId: target.id } });
      return { text: `${coach(state)} ${result.message}`, toolCalls: calls };
    }
  }

  if (/명단|스쿼드|상태 보여|선수단/u.test(msg)) {
    // 채팅에서는 숫자를 읊지 않는다 — 서술로 (prompts.md §1)
    const views = buildOfficeViews(state);
    const top = views.squad.players.slice(0, 4).map((p) => p.name);
    return {
      text: `${coach(state)} 팀의 축은 ${top.join(", ")}입니다. 수치가 필요하시면 오피스의 스쿼드 명단을 열어보시죠.`,
      toolCalls: calls,
    };
  }

  // 진행은 명령형 발화만 — "다음 경기 언제야?" 같은 조회가 시간을 흘리면 안 된다 (리뷰 발견)
  const isQuestion = /언제|뭐|누구|얼마|어때|\?/u.test(msg);
  /**
   * 감독의 **구어체** 지시만 여기서 읽는다 — mock이 LLM 대신 서는 자리다.
   * 손잡이는 말이 아니라 구조체로 오고(`operation`) 위에서 이미 갈렸다.
   *
   * 얼마나 넘기는지도 말에서 읽는다 — 전부 next_match로 처리하면 프리시즌에
   * "하루만 넘기자"고 한 감독이 개막까지 날아간다.
   */
  const wantsAdvance = /가자|진행해|진행하자|넘어가|넘기자|스킵|보내자|경기일로/u.test(msg);
  if (wantsAdvance && !isQuestion) {
    const days = /하루|내일/u.test(msg) ? 1 : /일주일|한 ?주/u.test(msg) ? 7 : null;
    return mockAdvance(state, calls, days);
  }

  /**
   * 열린 회견은 **아무 지시도 걸리지 않은 턴에만** 감독을 부른다 — 다가옴과 같은
   * 규약이다. 열려 있다는 이유만으로 모든 턴을 가로채면 다른 지시가 막히는데,
   * 회견은 경기 뒤에만 열리는 자리가 아니다: 부임 첫날부터 하나가 서 있다
   * (people.md §4). 답하지 않은 회견은 다음 회견이 올 때 거절로 닫힌다.
   */
  if (press) {
    return {
      text: `@: *회견장 문 앞*\n${coach(state)} 기자단이 기다리고 있습니다 — ${press.context}.\n${reporter(state, press)} ${mockQuestion(press)}`,
      toolCalls: calls,
    };
  }

  // 기본 응답 — 조회/대화
  const issues = state.issues.map((i) => playerName(state, i.gamePlayerId));
  return {
    text:
      `${coach(state)} ${describeNextFixture(state)}` +
      (issues.length > 0
        ? `\n${coach(state)} ${issues.join(", ")}의 불만이 쌓이고 있습니다 — 면담을 권합니다.`
        : ""),
    toolCalls: calls,
  };
}

/**
 * 시계를 옮기고 그 사이의 일을 장면으로 낸다 — 손잡이도 감독의 말도 여기로 모인다.
 * `days`가 null이면 다음 경기일까지.
 */
function mockAdvance(state: GameState, calls: GmToolCall[], days: number | null): GmTurnResult {
  const input = days === null ? ({ until: "next_match" } as const) : { days };
  const result = advanceTime(state, days === null ? "next_match" : { days });
  calls.push({
    name: TIME_PASSED,
    summary: result.stopped === "season_end" ? "시즌 종료 처리" : `${state.date}까지 진행`,
    input,
    silent: true,
  });
  const digestText = result.digest.map((d) => `${coach(state)} ${d}`).join("\n");
  const closer =
    result.stopped === "matchday"
      ? `\n${coach(state)} 오늘이 경기일입니다. 라인업과 전술을 점검하시죠.`
      : result.stopped === "attention"
        ? `\n${coach(state)} 오늘이 기한인 협상이 있어 여기서 멈췄습니다.`
        : result.stopped === "season_end"
          ? `\n@: *한 시즌이 막을 내렸다*`
          : "";
  return {
    text: `@: *시간이 흐른다 — ${state.date}*\n${digestText}${closer}`,
    toolCalls: calls,
  };
}

const ONBOARDING_SCENES = [
  (team: string) =>
    `@: *${team} 트레이닝 센터 정문. 새 감독을 기다리던 카메라 셔터가 일제히 터진다*`,
  (team: string) =>
    `@: *이른 아침의 ${team} 훈련장. 잔디에 물기가 남은 가운데 첫 출근 차량이 멈춰 선다*`,
  (team: string) =>
    `@: *${team} 홈구장 선수 통로. 아직 빈 관중석 너머로 새 시즌 준비 소리가 울린다*`,
  (team: string) =>
    `@: *${team} 구단 사무동. 벽을 채운 역대 시즌 사진 앞에서 새 감독의 첫날이 시작된다*`,
  (team: string) =>
    `@: *여름 이적시장 첫날, ${team} 구단 전화가 쉴 새 없이 울리는 가운데 감독실 문이 열린다*`,
] as const;

const ONBOARDING_WELCOMES = [
  (name: string, tag: string, coach: string) =>
    `${tag} ${name} 감독님, 기다리고 있었습니다. 수석코치 ${coach}입니다. 오늘부터 제가 가장 가까운 자리에서 돕겠습니다.`,
  (name: string, tag: string, coach: string) =>
    `${tag} 어서 오십시오, ${name} 감독님. ${coach}입니다. 첫날부터 결정할 일이 적지 않습니다.`,
  (name: string, tag: string, coach: string) =>
    `${tag} ${name} 감독님, 드디어 뵙는군요. ${coach}라고 합니다 — 이곳의 분위기와 선수단 사정은 제가 솔직하게 말씀드리겠습니다.`,
  (name: string, tag: string, coach: string) =>
    `${tag} 환영합니다, ${name} 감독님. 수석코치 ${coach}입니다. 구단은 새 출발을 준비했고, 선수단은 감독님의 첫마디를 기다리고 있습니다.`,
] as const;

const ONBOARDING_CLOSERS = [
  (tag: string) =>
    `${tag} 먼저 선수단을 들여다보시겠습니까, 아니면 이번 주 훈련 방향부터 정하시겠습니까?`,
  (tag: string) => `${tag} 이적시장, 훈련, 전술 가운데 무엇부터 손대시겠습니까?`,
  (tag: string) =>
    `${tag} 감독님의 첫 결정은 무엇입니까 — 선수단 점검부터 할까요, 훈련장으로 바로 나갈까요?`,
  (tag: string) =>
    `${tag} 개막까지 시간을 어떻게 쓰실지 말씀해 주십시오. 제가 바로 준비하겠습니다.`,
] as const;

/** mock 모드의 첫 장면 — 월드 시드에 따라 장면과 어조가 달라진다 (실모드 폴백 아님). */
export function buildOnboardingTurn(state: GameState): GmTurnResult {
  const views = buildOfficeViews(state);
  const attrs = state.manager.attributes;
  const rng = makeRng(state.seed, "onboarding-copy");
  const team = teamName(state.userTeamId);
  const persona = headCoachOf(state);
  const tag = coach(state);
  const topAxes = (Object.entries(attrs) as Array<[string, number]>)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([axis]) => MANAGER_ATTRIBUTE_KO[axis as keyof typeof MANAGER_ATTRIBUTE_KO] ?? axis);
  return {
    text: [
      // 첫 장면도 시점을 세우고 연다 — 실모드와 같은 문법이다
      `[${state.date} ${formatClock(clockOf(state))}]`,
      pick(rng, ONBOARDING_SCENES)(team),
      pick(rng, ONBOARDING_WELCOMES)(state.manager.name, tag, persona.name),
      // 코치의 사람됨을 첫 만남에 밝힌다 — motivation은 3인칭 서술이라 대사로 옮기지 않는다
      `${tag} 저에 대해서는 ${persona.traits.join(" · ")} — 그렇게들 말합니다.`,
      `${tag} "${state.manager.background}"이라는 이력도 검토했습니다. 보드는 특히 감독님의 ${topAxes.join("과 ")}을 높이 샀습니다.`,
      `${tag} 스쿼드의 축은 ${views.squad.players
        .slice(0, 3)
        .map((p) => p.name)
        .join(", ")}입니다. ${describeNextFixture(state)}`,
      pick(rng, ONBOARDING_CLOSERS)(tag),
    ].join("\n"),
    toolCalls: [],
  };
}

/**
 * mock 기자의 질문 — 사실 카드를 그대로 되읽는다. mock이 그럴듯한 기사 문장을
 * 흉내 내면 실모드의 출력 품질을 가늠할 때 착시가 생긴다.
 */
function mockQuestion(press: PressConference): string {
  const fact = press.facts.find((f) => f.sharp) ?? press.facts[0];
  return fact ? `${pressFactText(fact)} — 한 말씀 해주시죠.` : "한 말씀 해주시죠.";
}
