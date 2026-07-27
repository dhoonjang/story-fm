import type { MatchEvent } from "@story-fm/domain";
import {
  acceptDeal,
  advanceMockSegment,
  advanceTime,
  answerIncomingOffer,
  applyTeamTalk,
  applyTalkToPlayer,
  arrivedResponses,
  buildOfficeViews,
  dealOdds,
  describeNegotiations,
  describeNextFixture,
  describeOdds,
  expiringContracts,
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
  setTactics,
  setTraining,
  startMatch,
  isInjured,
  makeRng,
  pick,
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

  // 재계약 — 상대가 선수 본인이므로 이적 분기보다 먼저 본다
  if (/재계약|계약 연장|계약을 연장|잡아|남겨/u.test(msg)) {
    const who = detectPlayer(state, msg) ?? expiringContracts(state, 365)[0]?.player ?? null;
    if (!who) {
      return {
        text: `@수석코치: 지금 계약이 급한 선수는 없습니다.`,
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
        waiting.probability >= 50 ? "accept" : waiting.probability >= 25 ? "counter" : "reject";
      const input = {
        negotiationId: renewal.id,
        verdict,
        ...(verdict === "counter"
          ? { weeklyWage: Math.round(renewalExpectation(state, who) * 1.15) }
          : {}),
        note: verdict === "accept" ? "여기 남겠습니다" : "조건을 더 봐야겠습니다",
      } as const;
      const result = respondOffer(state, input);
      calls.push({ name: "respond_offer", summary: result.message, input });
      let text = `@${who.name}: ${result.message}`;
      if (result.ok && verdict === "accept") {
        const done = acceptDeal(state, renewal.id);
        calls.push({ name: "accept_deal", summary: done.message });
        text += `\n@수석코치: ${done.message}`;
      }
      return { text, toolCalls: calls };
    }
    const input = {
      playerId: who.id,
      weeklyWage: renewalExpectation(state, who),
      years: 3,
    };
    const result = openRenewal(state, input);
    calls.push({ name: "open_renewal", summary: result.message, input });
    return {
      text: result.ok
        ? `@: *${who.name}의 에이전트와 마주 앉는다*\n@수석코치: ${result.message}`
        : `@수석코치: ${result.message}`,
      toolCalls: calls,
    };
  }

  // ── 이적 협상 (mock) — 판정은 확률로 결정적으로 한다 (설계 §6) ──
  // 실모드에서는 LLM이 상대편이 되어 판정하지만, mock은 테스트가 재현 가능해야
  // 하므로 확률 구간으로 가른다: 50% 이상 수락 · 25% 이상 역제안 · 아니면 결렬.
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
        ...(verdict === "counter" ? { fee: Math.round(offer.fee * 1.25) } : {}),
      } as const;
      const result = answerIncomingOffer(state, input);
      calls.push({ name: "answer_incoming_offer", summary: result.message, input });
      let text = `@수석코치: ${result.message}`;
      if (result.ok && verdict === "accept") {
        const done = acceptDeal(state, incoming.id);
        calls.push({ name: "accept_deal", summary: done.message });
        text = `@수석코치: ${done.message}`;
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
        offer.probability >= 50 ? "accept" : offer.probability >= 25 ? "counter" : "reject";
      const input = {
        negotiationId: arrived.id,
        verdict,
        note: verdict === "accept" ? "그 값이면 놓아준다" : "그 값으로는 어렵다",
      } as const;
      const result = respondOffer(state, input);
      calls.push({ name: "respond_offer", summary: result.message, input });
      let text = `@수석코치: ${result.message}`;
      if (result.ok && verdict === "accept") {
        const done = acceptDeal(state, arrived.id);
        calls.push({ name: "accept_deal", summary: done.message });
        text += `\n@수석코치: ${done.message}`;
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
        calls.push({ name: "send_offer", summary: result.message, input: terms });
        return {
          text: result.ok
            ? `@수석코치: ${describeOdds(odds).split("\n")[0]}. ${result.message}`
            : `@수석코치: ${result.message}`,
          toolCalls: calls,
        };
      }
    }
    return {
      text: `@수석코치: ${describeNegotiations(state)}`,
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
      const issues = state.issues.map((i) => playerName(state, i.gamePlayerId)).join(", ");
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
      (issues.length > 0
        ? `\n@수석코치: ${issues.join(", ")}의 불만이 쌓이고 있습니다 — 면담을 권합니다.`
        : "") +
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
  (name: string) =>
    `@수석코치: ${name} 감독님, 기다리고 있었습니다. 오늘부터 제가 가장 가까운 자리에서 돕겠습니다.`,
  (name: string) =>
    `@수석코치: 어서 오십시오, ${name} 감독님. 수석코치입니다. 첫날부터 결정할 일이 적지 않습니다.`,
  (name: string) =>
    `@수석코치: ${name} 감독님, 드디어 뵙는군요. 이곳의 분위기와 선수단 사정은 제가 솔직하게 말씀드리겠습니다.`,
  (name: string) =>
    `@수석코치: 환영합니다, ${name} 감독님. 구단은 새 출발을 준비했고, 선수단은 감독님의 첫마디를 기다리고 있습니다.`,
] as const;

const ONBOARDING_CLOSERS = [
  `@수석코치: 먼저 선수단을 들여다보시겠습니까, 아니면 이번 주 훈련 방향부터 정하시겠습니까?`,
  `@수석코치: 이적시장, 훈련, 전술 가운데 무엇부터 손대시겠습니까?`,
  `@수석코치: 감독님의 첫 결정은 무엇입니까 — 선수단 점검부터 할까요, 훈련장으로 바로 나갈까요?`,
  `@수석코치: 개막까지 시간을 어떻게 쓰실지 말씀해 주십시오. 제가 바로 준비하겠습니다.`,
] as const;

/** 온보딩 폴백 — mock/LLM 실패에서도 월드 시드에 따라 첫 장면과 어조가 달라진다. */
export function buildOnboardingTurn(state: GameState): GmTurnResult {
  const views = buildOfficeViews(state);
  const attrs = state.manager.attributes;
  const rng = makeRng(state.seed, "onboarding-copy");
  const team = teamName(state.userTeamId);
  const topAxes = (Object.entries(attrs) as Array<[string, number]>)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([axis]) => AXIS_KO[axis] ?? axis);
  return {
    text: [
      pick(rng, ONBOARDING_SCENES)(team),
      pick(rng, ONBOARDING_WELCOMES)(state.manager.name),
      `@수석코치: "${state.manager.background}"이라는 이력도 검토했습니다. 보드는 특히 감독님의 ${topAxes.join("과 ")}을 높이 샀습니다.`,
      `@수석코치: 스쿼드의 축은 ${views.squad.players
        .slice(0, 3)
        .map((p) => p.name)
        .join(", ")}입니다. ${describeNextFixture(state)}`,
      pick(rng, ONBOARDING_CLOSERS),
    ].join("\n"),
    toolCalls: [],
  };
}
