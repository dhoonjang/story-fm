import type { MatchEvent } from "@story-fm/domain";
import {
  advanceMockSegment,
  advanceTime,
  applyTeamTalk,
  applyTalkToPlayer,
  buildOfficeViews,
  describeNextFixture,
  finalizeMatch,
  playerById,
  setCaptain,
  setTactics,
  setTraining,
  startMatch,
  isInjured,
  substitutePlayer,
  teamName,
  userPlayers,
  userSide,
  type GameState,
  type MatchScriptSegment,
} from "@story-fm/engine";
import type { TrainAttr } from "@story-fm/domain";
import { positionGroupOfPlayer } from "@story-fm/domain";
import type { GmToolCall, GmTurnResult } from "./gm-types";

/**
 * mock GM — LLM 없이 도는 결정적 오케스트레이터. e2e·오프라인 개발용이며,
 * 실모드 GM(gm.ts)과 같은 스킬 경로(엔진 함수)만 사용한다. 서사 품질이
 * 아니라 "시나리오가 끝까지 도는가"를 보장하는 것이 목적이다.
 */

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

/** 세그먼트 이벤트 → @문법 중계 텍스트 */
function renderSegment(state: GameState, segment: MatchScriptSegment): string {
  const lines: string[] = [];
  for (const ev of segment.events) {
    lines.push(...renderEvent(state, ev));
  }
  if (segment.stop === "goal") {
    lines.push(`@수석코치: 흐름이 우리 쪽인지 확인할 시점입니다. 이대로 갈까요?`);
  } else if (segment.stop === "half_time") {
    lines.push(
      `@: *하프타임 — 라커룸으로 향한다*`,
      `@수석코치: 현재 ${scoreLine(state)}. 후반 지시를 주시면 반영하겠습니다.`,
    );
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

function advanceMatchTurn(state: GameState, calls: GmToolCall[]): string {
  const step = advanceMockSegment(state);
  if (!step.ok || !step.segment) {
    return `@수석코치: ${step.message}`;
  }
  calls.push({ name: "advance_match", summary: step.message });
  let text = renderSegment(state, step.segment);
  if (step.segment.stop === "full_time") {
    const digest = finalizeMatch(state);
    calls.push({ name: "log_match_events", summary: "경기 장부 마감" });
    text += `\n@수석코치: ${digest.join(" · ")}`;
  }
  return text;
}

// mock은 자연어를 정교히 해석하지 못하므로 키워드→focus로 간이 매핑 (e2e·오프라인용)
const FOCUS_KEYWORDS: Array<[RegExp, TrainAttr[]]> = [
  [/세트\s?피스|프리킥|코너/u, ["kicking", "finishing"]],
  [/슈팅|골\s?결정력|마무리/u, ["finishing"]],
  [/공중볼|헤더|제공권/u, ["aerial"]],
  [/수비|조직력/u, ["tackling", "positioning", "tactical"]],
  [/전술/u, ["tactical"]],
  [/크로스|측면|롱볼|전환/u, ["kicking", "passing"]],
  [/패스|점유|빌드업/u, ["passing", "vision"]],
  [/드리블|돌파|1대1/u, ["dribbling"]],
  [/스피드|스프린트|가속/u, ["pace"]],
  [/체력|피지컬|피트니스|러닝/u, ["stamina", "strength"]],
  [/회복|휴식|리커버리/u, ["recovery"]],
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

function detectPlayer(state: GameState, message: string) {
  // 이름 조각(2자 이상)으로 탐색 — 성/이름 어느 쪽이든
  for (const player of userPlayers(state)) {
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
  const result = computeMockGmTurn(state, message);
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
    if (/교체/u.test(msg)) {
      const roster = userPlayers(state);
      const side = userSide(state);
      const ledgerSide = side === "home" ? state.pendingMatch?.ledger.home : state.pendingMatch?.ledger.away;
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
        calls.push({ name: "substitute", summary: result.message, input: { out: out.id, in: subId } });
        return {
          text: result.ok
            ? `@: *교체 준비 — ${out.name} OUT, ${playerName(state, subId)} IN*\n@수석코치: 반영했습니다. "계속"이라고 하시면 경기를 진행합니다.`
            : `@수석코치: ${result.message}`,
          toolCalls: calls,
        };
      }
      return {
        text: `@수석코치: 누구를 빼고 누구를 넣을까요? 벤치: ${bench.map((id) => playerName(state, id)).join(", ")}`,
        toolCalls: calls,
      };
    }
    if (/팀토크|한마디|외쳐/u.test(msg)) {
      const input = { occasion: "half", outcome: "encouraged", intensity: 2 } as const;
      const result = applyTeamTalk(state, input);
      calls.push({ name: "team_talk", summary: result.message, input });
      return {
        text: `@: *감독의 목소리가 라커룸을 울린다*\n@수석코치: ${result.message}. "계속"으로 후반을 시작하시죠.`,
        toolCalls: calls,
      };
    }
    return { text: advanceMatchTurn(state, calls), toolCalls: calls };
  }

  // ── 경기일 (킥오프 전) ────────────────────────────────
  if (state.phase === "matchday") {
    // 명시적 킥오프 의사만 — "라인업 점검하러 가자" 같은 발화로 오발동 금지 (리뷰 발견)
    if (/경기 시작|킥오프|시작하자|시작해|들어가자/u.test(msg)) {
      const started = startMatch(state);
      if (!started.ok) return { text: `@수석코치: ${started.message}`, toolCalls: calls };
      calls.push({ name: "start_match", summary: started.message });
      const packet = state.pendingMatch?.packet;
      const briefing = packet
        ? [
            `@수석코치: 전력 분석입니다 — ${packet.summary}`,
            ...packet.keyPoints.map((k) => `@수석코치: ★ ${k}`),
          ].join("\n")
        : "";
      const first = advanceMatchTurn(state, calls);
      return { text: [briefing, first].filter(Boolean).join("\n"), toolCalls: calls };
    }
    return {
      text: `@수석코치: 오늘은 경기일입니다. "경기 시작"이라고 하시면 킥오프합니다. 라인업·전술 변경도 지금 가능합니다.`,
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
    calls.push({ name: "set_tactics", summary: result.message, input });
    return {
      text: result.ok
        ? `@수석코치: *전술 보드를 고쳐 세운다* ${result.message}. 선수들에게 전달하겠습니다.`
        : `@수석코치: ${result.message}`,
      toolCalls: calls,
    };
  }

  if (/훈련|트레이닝/u.test(msg)) {
    const focus = FOCUS_KEYWORDS.find(([re]) => re.test(msg))?.[1] ?? ["passing"];
    const label = msg.replace(/[.!?]/g, "").slice(0, 40);
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
    calls.push({ name: "set_training", summary: result.message, input });
    return {
      text: result.ok
        ? `@수석코치: *수첩에 받아 적는다* ${result.message}. 세션에 반영합니다.`
        : `@수석코치: ${result.message}`,
      toolCalls: calls,
    };
  }

  if (/팀토크|미팅|다들 모여|한마디/u.test(msg)) {
    const input = { occasion: "daily", outcome: "encouraged", intensity: 2 } as const;
    const result = applyTeamTalk(state, input);
    calls.push({ name: "team_talk", summary: result.message, input });
    return {
      text: `@: *훈련장 한가운데, 선수단이 감독을 둘러싼다*\n@수석코치: ${result.message}`,
      toolCalls: calls,
    };
  }

  if (/면담|얘기 좀|불러/u.test(msg)) {
    const target = detectPlayer(state, msg);
    if (!target) {
      const issues = state.issues
        .map((i) => playerName(state, i.gamePlayerId))
        .join(", ");
      return {
        text: `@수석코치: 누구와 면담할까요?${issues ? ` 지금 불만이 쌓인 선수: ${issues}` : ""}`,
        toolCalls: calls,
      };
    }
    const input = { playerId: target.id, outcome: "motivated", intensity: 2 } as const;
    const result = applyTalkToPlayer(state, input);
    calls.push({ name: "talk_to_player", summary: result.message, input });
    return {
      text: `@: *감독실 문이 닫힌다*\n@${target.name}: 믿어주셔서 감사합니다. 훈련으로 보여드리겠습니다.\n@수석코치: ${result.message}`,
      toolCalls: calls,
    };
  }

  if (/주장/u.test(msg)) {
    const target = detectPlayer(state, msg);
    if (target) {
      const result = setCaptain(state, target.id);
      calls.push({ name: "set_captain", summary: result.message, input: { playerId: target.id } });
      return { text: `@수석코치: ${result.message}`, toolCalls: calls };
    }
  }

  if (/명단|스쿼드|상태 보여|선수단/u.test(msg)) {
    // 채팅에서는 숫자를 읊지 않는다 — 서술로 (결정 #2)
    const views = buildOfficeViews(state);
    const top = views.squad.players.slice(0, 4).map((p) => p.name);
    return {
      text: `@수석코치: 팀의 축은 ${top.join(", ")}입니다. 수치가 필요하시면 오피스의 스쿼드 명단을 열어보시죠.`,
      toolCalls: calls,
    };
  }

  // 진행은 명령형 발화만 — "다음 경기 언제야?" 같은 조회가 시간을 흘리면 안 된다 (리뷰 발견)
  const isQuestion = /언제|뭐|누구|얼마|어때|\?/u.test(msg);
  const wantsAdvance = /가자|진행해|진행하자|넘어가|넘기자|스킵|보내자|경기일로/u.test(msg);
  if (wantsAdvance && !isQuestion) {
    const result = advanceTime(state, "next_match");
    calls.push({
      name: "advance_time",
      summary: result.stopped === "season_end" ? "시즌 종료 처리" : `${state.date}까지 진행`,
      input: { until: "next_match" },
    });
    const digestText = result.digest.map((d) => `@수석코치: ${d}`).join("\n");
    const closer =
      result.stopped === "matchday"
        ? `\n@수석코치: 라인업과 전술을 점검하시고, "경기 시작"으로 킥오프하시죠.`
        : result.stopped === "attention"
          ? `\n@수석코치: 여기서 잠시 멈췄습니다 — 감독님 판단이 필요해 보여서요. "계속 가자"고 하시면 더 진행합니다.`
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
      `@수석코치: ${describeNextFixture(state)}` +
      (issues.length > 0 ? `\n@수석코치: ${issues.join(", ")}의 불만이 쌓이고 있습니다 — 면담을 권합니다.` : "") +
      `\n@수석코치: 훈련 지시, 전술 변경, 면담, 아니면 "다음 경기로 가자"라고 말씀해 주세요.`,
    toolCalls: calls,
  };
}

const AXIS_KO: Record<string, string> = {
  leadership: "리더십",
  tactics: "전술 이해",
  negotiation: "협상력",
  media: "미디어 감각",
};

/** 온보딩 첫 모델 턴 — 부임 첫날 (game-loop §1). 숫자 대신 서술 (결정 #2) */
export function buildOnboardingTurn(state: GameState): GmTurnResult {
  const views = buildOfficeViews(state);
  const attrs = state.manager.attributes;
  const topAxes = (Object.entries(attrs) as Array<[string, number]>)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([axis]) => AXIS_KO[axis] ?? axis);
  return {
    text: [
      `@: *${teamName(state.userTeamId)} 트레이닝 센터. 새 감독의 첫 출근길, 카메라 플래시가 터진다*`,
      `@수석코치: 어서 오십시오, ${state.manager.name} 감독님. 수석코치입니다. 함께 일하게 되어 영광입니다.`,
      `@수석코치: 배경을 들었습니다 — "${state.manager.background}". 보드는 특히 감독님의 ${topAxes.join("과 ")}을 높이 샀습니다. 정확한 평가는 오피스 커리어 탭에서 보실 수 있습니다.`,
      `@수석코치: 스쿼드의 축은 ${views.squad.players.slice(0, 3).map((p) => p.name).join(", ")}입니다. ${describeNextFixture(state)}`,
      `@수석코치: 훈련 방향부터 잡을까요, 아니면 바로 개막전 준비로 갈까요?`,
    ].join("\n"),
    toolCalls: [],
  };
}
