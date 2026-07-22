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
  setTrainingFocus,
  startMatch,
  substitutePlayer,
  teamById,
  userSide,
  userTeam,
  type GameState,
  type MatchScriptSegment,
  type TrainingPlan,
} from "@story-fm/engine";
import type { GmToolCall, GmTurnResult } from "./gm-types";

/**
 * mock GM — LLM 없이 도는 결정적 오케스트레이터. e2e·오프라인 개발용이며,
 * 실모드 GM(gm.ts)과 같은 스킬 경로(엔진 함수)만 사용한다. 서사 품질이
 * 아니라 "시나리오가 끝까지 도는가"를 보장하는 것이 목적이다.
 */

function playerName(state: GameState, id: string): string {
  const player = playerById(userTeam(state), id);
  if (player) return player.name;
  for (const team of state.teams) {
    const p = playerById(team, id);
    if (p) return p.name;
  }
  return id;
}

function scoreLine(state: GameState): string {
  const match = state.pendingMatch;
  if (!match) return "";
  const home = teamById(state, match.fixture.homeId).name;
  const away = teamById(state, match.fixture.awayId).name;
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

const FOCUS_KEYWORDS: Array<[RegExp, TrainingPlan["teamFocus"]]> = [
  [/세트\s?피스/u, "set_pieces"],
  [/슈팅|골\s?결정력|마무리/u, "shooting"],
  [/수비|조직력/u, "defending"],
  [/패스|점유|빌드업/u, "passing"],
  [/체력|피지컬|피트니스/u, "fitness"],
];

function detectPlayer(state: GameState, message: string) {
  const team = userTeam(state);
  // 이름 조각(2자 이상)으로 탐색 — 성/이름 어느 쪽이든
  for (const player of team.players) {
    const parts = [player.name, ...player.name.split(" ")];
    if (parts.some((part) => part.length >= 2 && message.includes(part))) return player;
  }
  return null;
}

export function runMockGmTurn(state: GameState, message: string): GmTurnResult {
  const calls: GmToolCall[] = [];
  const msg = message.trim();

  // ── 경기 중 ──────────────────────────────────────────
  if (state.phase === "match") {
    if (/교체/u.test(msg)) {
      const team = userTeam(state);
      const side = userSide(state);
      const ledgerSide = side === "home" ? state.pendingMatch?.ledger.home : state.pendingMatch?.ledger.away;
      const onPitch = ledgerSide?.onPitch ?? [];
      const bench = ledgerSide?.bench ?? [];
      const mentioned = team.players.filter((p) =>
        p.name.split(" ").some((part) => part.length >= 2 && msg.includes(part)),
      );
      const out = mentioned.find((p) => onPitch.includes(p.id));
      const sub = mentioned.find((p) => bench.includes(p.id)) ?? null;
      // 폴백은 필드 플레이어 우선 — bench[0]이 백업 GK일 수 있다 (리뷰 발견)
      const benchOutfield = bench.find((id) => {
        const p = team.players.find((x) => x.id === id);
        return p !== undefined && p.positionGroup !== "GK" && p.state.injury === "none";
      });
      const subId = sub?.id ?? benchOutfield ?? bench[0];
      if (out && subId) {
        const result = substitutePlayer(state, { out: out.id, in: subId });
        calls.push({ name: "substitute", summary: result.message });
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
      const result = applyTeamTalk(state, { occasion: "half", outcome: "encouraged", intensity: 2 });
      calls.push({ name: "team_talk", summary: result.message });
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
    const result = setTactics(state, { formation, ...(mentality ? { mentality } : {}) });
    calls.push({ name: "set_tactics", summary: result.message });
    return {
      text: result.ok
        ? `@수석코치: *전술 보드를 고쳐 세운다* ${result.message}. 선수들에게 전달하겠습니다.`
        : `@수석코치: ${result.message}`,
      toolCalls: calls,
    };
  }

  if (/훈련/u.test(msg)) {
    const focus = FOCUS_KEYWORDS.find(([re]) => re.test(msg))?.[1];
    const target = detectPlayer(state, msg);
    const plan: Partial<TrainingPlan> = {};
    if (focus) plan.teamFocus = focus;
    if (target && focus) plan.individual = [{ playerId: target.id, focus: FOCUS_TO_ATTR[focus] }];
    const result = setTrainingFocus(state, plan);
    calls.push({ name: "set_training_focus", summary: result.message });
    return {
      text: result.ok
        ? `@수석코치: *수첩에 받아 적는다* ${result.message}${target ? ` — ${target.name} 개인 훈련 포함` : ""}. 이번 주 세션에 반영합니다.`
        : `@수석코치: ${result.message}`,
      toolCalls: calls,
    };
  }

  if (/팀토크|미팅|다들 모여|한마디/u.test(msg)) {
    const result = applyTeamTalk(state, { occasion: "daily", outcome: "encouraged", intensity: 2 });
    calls.push({ name: "team_talk", summary: result.message });
    return {
      text: `@: *훈련장 한가운데, 선수단이 감독을 둘러싼다*\n@수석코치: ${result.message}`,
      toolCalls: calls,
    };
  }

  if (/면담|얘기 좀|불러/u.test(msg)) {
    const target = detectPlayer(state, msg);
    if (!target) {
      const issues = state.issues
        .map((i) => playerName(state, i.playerId))
        .join(", ");
      return {
        text: `@수석코치: 누구와 면담할까요?${issues ? ` 지금 불만이 쌓인 선수: ${issues}` : ""}`,
        toolCalls: calls,
      };
    }
    const result = applyTalkToPlayer(state, { playerId: target.id, outcome: "motivated", intensity: 2 });
    calls.push({ name: "talk_to_player", summary: result.message });
    return {
      text: `@: *감독실 문이 닫힌다*\n@${target.id}: 믿어주셔서 감사합니다. 훈련으로 보여드리겠습니다.\n@수석코치: ${result.message}`,
      toolCalls: calls,
    };
  }

  if (/주장/u.test(msg)) {
    const target = detectPlayer(state, msg);
    if (target) {
      const result = setCaptain(state, target.id);
      calls.push({ name: "set_captain", summary: result.message });
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
  const issues = state.issues.map((i) => playerName(state, i.playerId));
  return {
    text:
      `@수석코치: ${describeNextFixture(state)}` +
      (issues.length > 0 ? `\n@수석코치: ${issues.join(", ")}의 불만이 쌓이고 있습니다 — 면담을 권합니다.` : "") +
      `\n@수석코치: 훈련 지시, 전술 변경, 면담, 아니면 "다음 경기로 가자"라고 말씀해 주세요.`,
    toolCalls: calls,
  };
}

const FOCUS_TO_ATTR: Record<TrainingPlan["teamFocus"], "pace" | "shooting" | "passing" | "dribbling" | "defending" | "physical"> = {
  set_pieces: "shooting",
  shooting: "shooting",
  defending: "defending",
  passing: "passing",
  fitness: "physical",
};

const AXIS_KO: Record<string, string> = {
  leadership: "리더십",
  tactics: "전술 이해",
  negotiation: "협상력",
  media: "미디어 감각",
};

/** 온보딩 첫 모델 턴 — 부임 첫날 (game-loop §1). 숫자 대신 서술 (결정 #2) */
export function buildOnboardingTurn(state: GameState): GmTurnResult {
  const team = userTeam(state);
  const views = buildOfficeViews(state);
  const attrs = state.manager.attributes;
  const topAxes = (Object.entries(attrs) as Array<[string, number]>)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([axis]) => AXIS_KO[axis] ?? axis);
  return {
    text: [
      `@: *${team.name} 트레이닝 센터. 새 감독의 첫 출근길, 카메라 플래시가 터진다*`,
      `@수석코치: 어서 오십시오, ${state.manager.name} 감독님. 수석코치입니다. 함께 일하게 되어 영광입니다.`,
      `@수석코치: 배경을 들었습니다 — "${state.manager.background}". 보드는 특히 감독님의 ${topAxes.join("과 ")}을 높이 샀습니다. 정확한 평가는 오피스 커리어 탭에서 보실 수 있습니다.`,
      `@수석코치: 스쿼드의 축은 ${views.squad.players.slice(0, 3).map((p) => p.name).join(", ")}입니다. ${describeNextFixture(state)}`,
      `@수석코치: 훈련 방향부터 잡을까요, 아니면 바로 개막전 준비로 갈까요?`,
    ].join("\n"),
    toolCalls: [],
  };
}
