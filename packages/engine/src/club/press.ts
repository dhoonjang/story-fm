import type {
  GamePlayer,
  MatchRecord,
  PressConference,
  PressFact,
  PressStance,
  PressTrigger,
} from "@story-fm/domain";
import { isNaturalAt, naturalPositionOf } from "@story-fm/domain";
import type { GameState } from "../core/state";
import { playersOf, pushNarrative, teamNameIn, userPlayers } from "../core/state";
import { makeRng, pick } from "../core/rng";
import { clampForm, formLabel, moraleToForm } from "../squad/form";
import { recentOutcomes } from "../squad/slump";
import { isFriendly } from "../competition/friendly";
import type { SkillResult } from "../skills";

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

/** 회견 하나가 옮길 수 있는 기본 폭 — `weight`(1~3)에 비례한다 (overview §7) */
export const PRESS_BAND = 4;

/**
 * 스탠스별 방향 — 평판 3축과 사기.
 *
 * 표의 요점은 **공짜가 없다**는 것이다. 선수를 감싸면 라커룸을 얻고 언론을 잃고,
 * 날을 세우면 그 반대다. 어느 행도 전부 양수이지 않다 — 그러면 그 스탠스만 쓴다.
 */
const STANCE_TABLE: Record<
  PressStance,
  { board: number; media: number; squad: number; target: number; team: number }
> = {
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
const DECLINE = { board: -0.3, media: -1, squad: 0.2, target: 0, team: 0 };

const clampRep = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

/** 리더십 계수 — 같은 말도 리더십이 자라면 라커룸에 더 크게 울린다 (skills.ts와 같은 자) */
function leadershipFactor(state: GameState): number {
  return 0.7 + (state.manager.attributes.leadership / 99) * 0.6;
}

/** 이 자리가 얼마나 큰가 — 한도가 여기에 비례한다 */
function weightOf(trigger: PressTrigger, sharp: boolean): 1 | 2 | 3 {
  if (trigger === "pressure") return 3;
  if (trigger === "transfer") return 2;
  return sharp ? 2 : 1;
}

/** 우리 시각의 결과 */
function outcomeOf(state: GameState, m: MatchRecord): "win" | "draw" | "loss" | null {
  if (!m.result) return null;
  const home = m.homeTeamId === state.userTeamId;
  const us = home ? m.result.homeGoals : m.result.awayGoals;
  const them = home ? m.result.awayGoals : m.result.homeGoals;
  return us === them ? "draw" : us > them ? "win" : "loss";
}

/**
 * 지금 기자가 이름을 부를 만한 선수 — **장부가 고른다.**
 * 폼이 바닥인 선수, 없으면 불만이 쌓인 선수. 모델에게 "적당한 선수를 골라라"
 * 하면 없는 사연이 생긴다.
 */
function questionablePlayer(state: GameState, seed: number): GamePlayer | null {
  const squad = userPlayers(state);
  const slumping = squad
    .filter((p) => p.state.form < -0.35)
    .sort((a, b) => a.state.form - b.state.form)
    .slice(0, 3);
  if (slumping.length > 0) return pick(makeRng(seed, "press"), slumping);
  const issue = state.issues[0];
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
  const opponent = teamNameIn(state, home ? match.awayTeamId : match.homeTeamId);
  const score = `${result.homeGoals}-${result.awayGoals}`;

  /**
   * 무승 계단은 **시즌의 것이다** — 친선도 지난 시즌도 세지 않는다(`recentOutcomes`,
   * slump.ts와 같은 자). 라커룸의 연패 판정과 기자의 무승 판정이 다른 경기를 세면
   * 같은 국면을 두 눈금으로 말하게 된다.
   */
  const recent = recentOutcomes(state, state.userTeamId, 4);
  const winless = recent.length >= 3 && recent.every((r) => r !== "win");

  /**
   * **사실만 넘긴다.** 기자의 질문은 GM이 이 카드들로 직접 쓴다 — 코어가 문장을
   * 박아 두면 시즌 내내 같은 말이 반복되고, 기자의 성격도 그날의 맥락도 문장에
   * 닿지 못한다 (overview.md §1 철칙 4).
   */
  const facts: PressFact[] = [
    {
      kind: "result",
      text: `${opponent}전 ${score} ${outcome === "win" ? "승리" : outcome === "draw" ? "무승부" : "패배"} (${home ? "홈" : "원정"})`,
      about: null,
      sharp: outcome === "loss" || (outcome === "draw" && winless),
    },
  ];
  if (winless) {
    facts.push({
      kind: "winless",
      text: `최근 ${recent.length}경기 무승 (${recent.map((r) => (r === "draw" ? "무" : "패")).join("")})`,
      about: null,
      sharp: true,
    });
  }
  const target = questionablePlayer(state, state.seed + state.matches.length);
  if (target) {
    const slumping = target.state.form < -0.35;
    facts.push({
      kind: slumping ? "slump" : "unhappy",
      text: slumping
        ? `${target.name} 폼 ${formLabel(target.state.form)}`
        : `${target.name} 라커룸 불만 (${state.issues.find((i) => i.gamePlayerId === target.id)?.note ?? "사유 불명"})`,
      about: target.id,
      sharp: true,
    });
  }

  const trigger: PressTrigger = winless ? "pressure" : "match";
  const outcomeKo = outcome === "win" ? "승리" : outcome === "draw" ? "무승부" : "패배";
  return {
    id: `press-${matchId}`,
    date: state.date,
    trigger,
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
    .slice(0, 2);
}

/** 회견이 열릴 만한 이적료 — 이 아래는 1군 상위 자원일 때만 */
const BIG_FEE = 25_000_000;

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
  const better = playersOf(state, state.userTeamId).filter(
    (p) => p.id !== player.id && p.attributes.overall > player.attributes.overall,
  ).length;
  if (better >= 14 && input.fee < BIG_FEE) return null;

  const pos = naturalPositionOf(player).position;
  const fee = input.fee > 0 ? ` · 이적료 £${(input.fee / 1e6).toFixed(1)}M` : " · 이적료 없음";
  const facts: PressFact[] =
    input.kind === "in"
      ? [
          {
            kind: "arrival",
            text: `${player.name} 영입 확정 (${pos})${fee}`,
            about: player.id,
            sharp: false,
          },
          /**
           * 밀려나는 선수 — 영입은 언제나 누군가의 자리를 뺏는다. 이름을 코어가
           * 짚어 줘야 기자가 없는 선수를 지어내지 않는다.
           */
          ...squeezedBy(state, player).map((p): PressFact => ({
            kind: "squeezed",
            text: `${p.name}이(가) 같은 자리(${pos})를 봐 왔다`,
            about: p.id,
            sharp: true,
          })),
        ]
      : [
          {
            kind: "departure",
            text: `${player.name} 매각 확정 (${pos})${fee}`,
            about: player.id,
            sharp: true,
          },
        ];

  return {
    id: `press-transfer-${input.playerId}-${state.date}`,
    date: state.date,
    trigger: "transfer",
    context:
      `${player.name} ${input.kind === "in" ? "영입" : "매각"}` +
      (input.fee > 0 ? ` · £${(input.fee / 1e6).toFixed(1)}M` : ""),
    facts,
    status: "pending",
    weight: 2,
  };
}

/** 답을 기다리는 회견 — 언제나 하나뿐이다 */
export function pendingPress(state: GameState): PressConference | null {
  return (state.pressConferences ?? []).find((c) => c.status === "pending") ?? null;
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
  state.pressConferences.push(conference);
  // 지나간 회견은 서사에 남지 상태로 쌓일 이유가 없다
  if (state.pressConferences.length > 20) {
    state.pressConferences = state.pressConferences.slice(-20);
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
  const row = stance === null ? DECLINE : STANCE_TABLE[stance];
  const band = PRESS_BAND * conference.weight;
  const lead = leadershipFactor(state);

  const board = Math.round(row.board * band);
  const media = Math.round(row.media * band);
  const squad = Math.round(row.squad * band);
  const rep = state.manager.reputation;
  rep.board = clampRep(rep.board + board);
  rep.media = clampRep(rep.media + media);
  rep.squad = clampRep(rep.squad + squad);

  // 팀 전체 — 라커룸도 회견을 본다
  const team = Math.round(row.team * band * lead);
  if (team !== 0) {
    for (const p of userPlayers(state)) p.state.form = clampForm(p.state.form + moraleToForm(team));
  }

  /**
   * 지목된 선수 — **팀 전체 위에 더 얹는다.** 공개적으로 감싸이거나 잘린 당사자는
   * 같은 말을 남의 이야기로 듣지 않는다. 이름을 부른 질문이 없으면 없다.
   */
  const askedAbout =
    targetPlayerId ?? conference.facts.find((f) => f.about !== null)?.about ?? null;
  const targetPlayer = askedAbout
    ? (userPlayers(state).find((p) => p.id === askedAbout) ?? null)
    : null;
  const target = targetPlayer ? Math.round(row.target * band * lead) : 0;
  if (targetPlayer && target !== 0) {
    targetPlayer.state.form = clampForm(targetPlayer.state.form + moraleToForm(target));
  }

  return { board, media, squad, target, targetName: targetPlayer?.name ?? null, team };
}

/** 부호를 붙인 한 줄 — 0은 쓰지 않는다 */
const signed = (label: string, v: number) => (v === 0 ? null : `${label} ${v > 0 ? "+" : ""}${v}`);

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

  const effect = applyPressOutcome(state, conference, input.stance, input.targetPlayerId ?? null);
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
  };
}

const STANCE_KO: Record<PressStance, string> = {
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
    `기자회견 대기 (${c.id}) — ${c.context}${c.weight >= 3 ? " · 큰 자리다" : ""}`,
    `  기자가 아는 사실 (이 밖은 묻지 못한다):`,
    ...c.facts.map((f) => `  · ${f.text}${f.about ? ` [${f.about}]` : ""}${f.sharp ? " ⚡" : ""}`),
  ].join("\n");
}
