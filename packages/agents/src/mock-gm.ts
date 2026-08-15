import type { MatchEvent, PressConference } from "@story-fm/domain";
import {
  acceptDeal,
  advanceSegment,
  advanceTime,
  clockOf,
  formatClock,
  answerIncomingOffer,
  applyTeamTalk,
  applyTalkToPlayer,
  pendingPress,
  respondToMedia,
  declinePress,
  arrivedResponses,
  buildOfficeViews,
  dealOdds,
  describeNegotiations,
  describeNextFixture,
  describeOdds,
  expiringContracts,
  digestLines,
  finalizeMatch,
  openRenewal,
  renewalExpectation,
  incomingOffer,
  incomingOffers,
  pendingOffer,
  playerById,
  respondOffer,
  sendOffer,
  suggestTerms,
  setCaptain,
  setPlayerTactic,
  setTactics,
  setTraining,
  clearTraining,
  addDays,
  diffDays,
  markEntered,
  startMatch,
  isInjured,
  headCoachOf,
  makeRng,
  pick,
  substitutePlayer,
  teamName,
  userPlayers,
  userSide,
  type GameState,
  type SkillBrief,
} from "@story-fm/engine";
import type { TrainAttr } from "@story-fm/domain";
import { positionGroupOfPlayer, MANAGER_ATTRIBUTE_KO } from "@story-fm/domain";
import { TIME_PASSED, type GmToolCall, type GmTurnResult } from "./gm-types";
import type { CardMark, GoalMark } from "@story-fm/engine";

/**
 * mock GM — LLM 없이 도는 결정적 오케스트레이터. e2e·오프라인 개발용이며,
 * 실모드 GM(gm.ts)과 같은 스킬 경로(엔진 함수)만 사용한다. 서사 품질이
 * 아니라 "시나리오가 끝까지 도는가"를 보장하는 것이 목적이다.
 */

/** mock 협상 판정 문턱 — 성사 확률이 이 이상이면 수락, 다음 구간이면 역제안 */
const MOCK_ACCEPT_PROB = 50;
const MOCK_COUNTER_PROB = 25;
/** mock 역제안 — 이적료는 받은 오퍼의 1.25배로 되부른다 */
const MOCK_COUNTER_FEE_RATE = 1.25;
/** mock 재계약 역제안 — 선수가 주급 기대치의 1.15배를 부른다 */
const MOCK_RENEWAL_WAGE_RATE = 1.15;

/**
 * 카드를 그리는 스킬의 결과를 그대로 싣는다 — **실모드와 같은 자리에서 같은 것**.
 * mock이 payload를 떨어뜨리면 e2e에서만 카드가 사라져 화면 회귀를 못 잡는다.
 */
/**
 * 스킬 결과가 기록으로 **함께 실려 가야 하는 것들** — 카드(`payload`)와 항목 요약(`brief`).
 *
 * 빠뜨리면 화면이 조용히 폴백한다: 카드 없이 줄글로, 항목 없이 요약 문자열로.
 * 모의 GM은 실모드와 같은 코어 함수를 부르므로 **같은 것을 실어야** 화면이 같다.
 */
const carry = (result: { payload?: unknown; brief?: SkillBrief }) => ({
  ...(result.payload === undefined ? {} : { payload: result.payload }),
  ...(result.brief === undefined ? {} : { brief: result.brief }),
});

/** 수석코치 화자 태그 — 직책이 아니라 그 사람의 이름이다 (personas.md) */
function coach(state: GameState): string {
  return `@${headCoachOf(state).characterId}:`;
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

function renderEvent(state: GameState, ev: MatchEvent): string[] {
  const name = ev.actors[0] ? playerName(state, ev.actors[0]) : "";
  switch (ev.type) {
    case "kickoff":
      return [`@중계: 킥오프! 경기가 시작됩니다.`];
    case "goal": {
      const cause = ev.causes[0] ? ` (${ev.causes[0]})` : "";
      return [`@중계: *${ev.minute}′ — ${name}, 골입니다!* ${scoreLine(state)}${cause}`];
    }
    case "shot":
      return [`@중계: ${ev.minute}′ ${name}의 슛 — 아깝게 빗나갑니다.`];
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
    default:
      return [];
  }
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
  const before = { ...(state.pendingMatch?.ledger.score ?? { home: 0, away: 0 }) };
  const ourSide = userSide(state);
  const step = advanceSegment(state);
  if (!step.ok || !step.plan) {
    return `${coach(state)} ${step.message}`;
  }
  calls.push({ name: "advance_match", summary: step.message, silent: true });
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
  if (step.plan.stop === "full_time") {
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
 * 이름을 여기서 함께 고르는 이유: 예전엔 감독의 발화를 40자로 잘라 label에 넣어서
 * `매주 월요일 오전=응 그리고 훈련 싹다 갈아엎자 체력 훈련 싹 지우고, 패스 훈련에 집중하`가
 * 달력에도 요약에도 그대로 박혔다. label은 **달력에 걸릴 제목**이지 감독의 말이 아니다.
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
 * mock GM 턴 — 규칙 기반. onText를 주면 완성된 서사 텍스트를 청크로 쪼개
 * 즉시 방출한다 (실모드의 진짜 스트리밍과 동일한 인터페이스를 흉내).
 */
export function runMockGmTurn(
  state: GameState,
  message: string,
  onText?: (delta: string) => void,
): GmTurnResult {
  const computed = computeMockGmTurn(state, message);
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

function computeMockGmTurn(state: GameState, message: string): GmTurnResult {
  const calls: GmToolCall[] = [];
  const msg = message.trim();

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
    const positionOrders = [...msg.matchAll(/자리 변경 — (.+?)을\(를\) ([A-Z]+)로/gu)];
    const roleOrders = [...msg.matchAll(/역할 변경 — (.+?)을\(를\) .+?\(([a-z0-9_-]+)\)로/gu)];
    if (positionOrders.length > 0 || roleOrders.length > 0) {
      const roster = userPlayers(state);
      const positionResults = positionOrders.map((order) => {
        const name = order[1]?.trim() ?? "";
        const position = order[2] ?? "";
        const player = roster.find((candidate) => candidate.name === name);
        if (!player) return `${name}: 선수를 찾을 수 없습니다`;
        const input = { playerId: player.id, position };
        const result = setPlayerTactic(state, input);
        calls.push({ name: "set_player_tactic", summary: result.message, input, ...carry(result) });
        return result.message;
      });
      const roleResults = roleOrders.map((order) => {
        const name = order[1]?.trim() ?? "";
        const role = order[2] ?? "";
        const player = roster.find((candidate) => candidate.name === name);
        if (!player) return `${name}: 선수를 찾을 수 없습니다`;
        const input = { playerId: player.id, role };
        const result = setPlayerTactic(state, input);
        calls.push({ name: "set_player_tactic", summary: result.message, input, ...carry(result) });
        return result.message;
      });
      const results = [...positionResults, ...roleResults];
      return {
        text: `${coach(state)} 전술판 변경을 반영했습니다. ${results.join(" · ")}`,
        toolCalls: calls,
      };
    }
    const formationMatch = msg.match(/([345])-\d(-\d)?(-\d)?/u);
    if (formationMatch && /전술|포메이션|바꾸|변경|가자|쓰자/u.test(msg)) {
      const input = { formation: formationMatch[0] as never };
      const result = setTactics(state, input);
      calls.push({ name: "set_tactics", summary: result.message, input, ...carry(result) });
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
        calls.push({
          name: "substitute",
          summary: result.message,
          input: { out: out.id, in: subId },
        });
        return {
          text: result.ok
            ? `@: *교체 준비 — ${out.name} OUT, ${playerName(state, subId)} IN*\n${coach(state)} 반영했습니다. "계속"이라고 하시면 경기를 진행합니다.`
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
      calls.push({
        name: "team_talk",
        summary: result.message,
        ...(result.tone ? { tone: result.tone } : {}),
        input,
        line: 1,
      });
      return {
        text: `@: *감독의 목소리가 라커룸을 울린다*\n${coach(state)} ${result.message}. "계속"으로 후반을 시작하시죠.`,
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
      // `startMatch`는 `FlowResult`라 실을 카드도 항목도 없다
      calls.push({ name: "start_match", summary: started.message });
      const packet = state.pendingMatch?.packet;
      // 킥오프는 여기서 굴리지 않는다 — 공은 감독이 입장 확인 창을 누를 때 구른다
      const briefing = packet
        ? [
            `${coach(state)} 전력 분석입니다 — ${packet.summary}`,
            ...packet.keyPoints.map((k) => `${coach(state)} ★ ${k}`),
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

  // ── 일상 ─────────────────────────────────────────────
  const formationMatch = msg.match(/([345])-\d(-\d)?(-\d)?/u);
  if (formationMatch && /전술|포메이션|바꾸|변경|가자|쓰자/u.test(msg)) {
    const formation = formationMatch[0] as never;
    const mentality = /공격적/u.test(msg) ? 4 : /수비적/u.test(msg) ? 2 : undefined;
    const input = { formation, ...(mentality ? { mentality } : {}) };
    const result = setTactics(state, input);
    calls.push({ name: "set_tactics", summary: result.message, input, ...carry(result) });
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
    calls.push({ name: "set_training", summary: result.message, input, ...carry(result) });
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
    calls.push({ name: "set_training", summary: result.message, input, ...carry(result) });
    return {
      text: result.ok
        ? `${coach(state)} *수첩에 받아 적는다* ${result.message}. 세션에 반영합니다.`
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
      const verdict =
        waiting.probability >= MOCK_ACCEPT_PROB
          ? "accept"
          : waiting.probability >= MOCK_COUNTER_PROB
            ? "counter"
            : "reject";
      const input = {
        negotiationId: renewal.id,
        verdict,
        ...(verdict === "counter"
          ? { weeklyWage: Math.round(renewalExpectation(state, who) * MOCK_RENEWAL_WAGE_RATE) }
          : {}),
        note: verdict === "accept" ? "여기 남겠습니다" : "조건을 더 봐야겠습니다",
      } as const;
      const result = respondOffer(state, input);
      calls.push({ name: "respond_offer", summary: result.message, input, ...carry(result) });
      let text = `@${who.name}: ${result.message}`;
      if (result.ok && verdict === "accept") {
        const done = acceptDeal(state, renewal.id);
        calls.push({ name: "accept_deal", summary: done.message, ...carry(done) });
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
    calls.push({ name: "open_renewal", summary: result.message, input, ...carry(result) });
    return {
      text: result.ok
        ? `@: *${who.name}의 에이전트와 마주 앉는다*\n${coach(state)} ${result.message}`
        : `${coach(state)} ${result.message}`,
      toolCalls: calls,
    };
  }

  // ── 이적 협상 (mock) — 실모드는 LLM이 상대편이 되어 판정하지만 mock은 테스트
  // 재현성을 위해 확률 구간으로 가른다 (수락 / 역제안 / 결렬)
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
      calls.push({ name: "respond_offer", summary: result.message, input, ...carry(result) });
      let text = `${coach(state)} ${result.message}`;
      if (result.ok && verdict === "accept") {
        const done = acceptDeal(state, incoming.id);
        calls.push({ name: "accept_deal", summary: done.message, ...carry(done) });
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
      const offer = pendingOffer(arrived)!;
      const verdict =
        offer.probability >= MOCK_ACCEPT_PROB
          ? "accept"
          : offer.probability >= MOCK_COUNTER_PROB
            ? "counter"
            : "reject";
      const input = {
        negotiationId: arrived.id,
        verdict,
        note: verdict === "accept" ? "그 값이면 놓아준다" : "그 값으로는 어렵다",
      } as const;
      const result = respondOffer(state, input);
      calls.push({ name: "respond_offer", summary: result.message, input, ...carry(result) });
      let text = `${coach(state)} ${result.message}`;
      if (result.ok && verdict === "accept") {
        const done = acceptDeal(state, arrived.id);
        calls.push({ name: "accept_deal", summary: done.message, ...carry(done) });
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
        calls.push({ name: "send_offer", summary: result.message, input: terms, ...carry(result) });
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
      calls.push({
        name: "respond_to_media",
        summary: result.message,
        input: { decline: true },
        line: 1,
      });
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
    calls.push({
      name: "respond_to_media",
      summary: result.message,
      ...(result.tone ? { tone: result.tone } : {}),
      input,
      line: 2,
    });
    return {
      text: `@: *플래시가 터지는 회견장*\n@기자: ${mockQuestion(press)}\n${coach(state)} ${result.message}`,
      toolCalls: calls,
    };
  }
  if (press) {
    return {
      text: `@: *회견장 문 앞*\n${coach(state)} 기자단이 기다리고 있습니다 — ${press.context}.\n@기자: ${mockQuestion(press)}`,
      toolCalls: calls,
    };
  }

  if (/팀토크|미팅|다들 모여|한마디/u.test(msg)) {
    const input = { occasion: "daily", outcome: "encouraged", intensity: 2 } as const;
    const result = applyTeamTalk(state, input);
    calls.push({
      name: "team_talk",
      summary: result.message,
      ...(result.tone ? { tone: result.tone } : {}),
      input,
      line: 1,
    });
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
    calls.push({
      name: "talk_to_player",
      summary: result.message,
      ...(result.tone ? { tone: result.tone } : {}),
      input,
      line: 2,
    });
    return {
      text: `@: *감독실 문이 닫힌다*\n@${target.name}: 믿어주셔서 감사합니다. 훈련으로 보여드리겠습니다.\n${coach(state)} ${result.message}`,
      toolCalls: calls,
    };
  }

  if (/주장/u.test(msg)) {
    const target = detectPlayer(state, msg);
    if (target) {
      const result = setCaptain(state, target.id);
      calls.push({
        name: "set_captain",
        summary: result.message,
        input: { playerId: target.id },
        ...carry(result),
      });
      return { text: `${coach(state)} ${result.message}`, toolCalls: calls };
    }
  }

  if (/명단|스쿼드|상태 보여|선수단/u.test(msg)) {
    // 채팅에서는 숫자를 읊지 않는다 — 서술로 (결정 #2)
    const views = buildOfficeViews(state);
    const top = views.squad.players.slice(0, 4).map((p) => p.name);
    return {
      text: `${coach(state)} 팀의 축은 ${top.join(", ")}입니다. 수치가 필요하시면 오피스의 스쿼드 명단을 열어보시죠.`,
      toolCalls: calls,
    };
  }

  // 진행은 명령형 발화만 — "다음 경기 언제야?" 같은 조회가 시간을 흘리면 안 된다 (리뷰 발견)
  const isQuestion = /언제|뭐|누구|얼마|어때|\?/u.test(msg);
  // "시간 진행 — 하루"는 화면의 시간 이동 손잡이가 보내는 조작 문장이다
  // (`TIME_SKIPS`) — 감독의 구어체 지시와 함께 여기서 받는다
  const wantsAdvance = /가자|진행해|진행하자|넘어가|넘기자|스킵|보내자|경기일로|시간 진행/u.test(
    msg,
  );
  if (wantsAdvance && !isQuestion) {
    // 얼마나 넘기는지도 말에서 읽는다 — 버튼 문장을 그대로 받으므로 전부
    // next_match로 처리하면 프리시즌에 하루를 누른 감독이 개막까지 날아간다.
    // 날짜가 적혀 오면 그날까지 간다 (실모드에선 applyScenePoint가 하는 일)
    const dated = /\((\d{4}-\d{2}-\d{2})\)/u.exec(msg)?.[1] ?? null;
    const days = dated
      ? Math.max(1, diffDays(state.date, dated))
      : /하루|내일/u.test(msg)
        ? 1
        : /일주일|한 ?주/u.test(msg)
          ? 7
          : null;
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
          ? `\n${coach(state)} 오늘이 기한인 협상이 있어 여기서 멈췄습니다. 정리하고 나서 "계속 가자"고 하시면 더 진행합니다.`
          : result.stopped === "season_end"
            ? `\n@: *한 시즌이 막을 내렸다*`
            : "";
    return {
      text: `@: *시간이 흐른다 — ${state.date}*\n${digestText}${closer}`,
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
        : "") +
      `\n${coach(state)} 훈련 지시, 전술 변경, 면담, 아니면 "다음 경기로 가자"라고 말씀해 주세요.`,
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
  return fact ? `${fact.text} — 한 말씀 해주시죠.` : "한 말씀 해주시죠.";
}
