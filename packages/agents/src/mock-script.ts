import type { MatchEvent, ShootoutOutcome } from "@story-fm/domain";
import { packetTagText, shootoutTally } from "@story-fm/domain";
import {
  addDays,
  clockOf,
  describeNextFixture,
  expiringContracts,
  formatClock,
  minutesOfClock,
  nextMatchFor,
  playerName,
  renewalExpectation,
  suggestTerms,
  teamName,
  type GameState,
} from "@story-fm/engine";
import type { ScriptedCall, ScriptedTurn } from "@story-fm/llm";
import type { OpsInput } from "./orders-ops";

/**
 * **mock 모드의 대본** — 감독의 말 하나가 어느 도구를 어느 인자로 부르는지의 표다
 * (docs/llm/agents.md §8).
 *
 * ⚠️ **자연어를 해석하지 않는다.** 표의 키와 감독의 말이 글자까지 같을 때만 걸리고,
 * 표에 없는 말은 아무 도구도 부르지 않는다. 정규식으로 뜻을 짐작하던 자리가 실모드에
 * 없는 두 번째 해석 경로였다 — 도구가 하나 늘 때마다 두 번 짓게 되고, 한쪽이 빠지면
 * e2e가 실모드에 없는 동작을 통과시킨다.
 *
 * **한 줄이 두 걸음을 함께 정한다** — GM이 부르는 도구(`gm`)와, 그 도구가 해석기라면
 * 해석기가 채우는 명령(`ops`). 실모드에서 두 걸음을 각각 LLM이 맡으므로 대본도 같은
 * 자리를 채우고, 두 걸음이 한 줄에 있어 갈릴 데가 없다.
 */

/** 표의 한 줄이 인자를 채울 때 읽는 것 */
interface ScriptContext {
  state: GameState;
  /** 감독이 부른 이름 — 이름 자리(`<선수>`)를 둔 줄만 값을 갖는다 */
  named: string;
}

/** 이름 한 자리 — 표의 키에서 이 토큰이 선 곳에 감독이 부른 이름이 들어간다 */
const NAME_SLOT = "<선수>";

interface ScriptLine {
  /** 감독의 말. `<선수>` 한 자리는 이름이 들어갈 곳이다 */
  say: string;
  /**
   * 며칠을 넘기는 말인가 — 시계는 **시점 헤더가** 민다(실모드와 같은 입구다).
   * `"next_match"`면 다음 유저 경기의 날짜를 적고, 코어가 그 앞에서 멈춰 세운다.
   */
  skip?: number | "next_match";
  /** GM이 부르는 도구 시퀀스 */
  gm?: (ctx: ScriptContext) => ScriptedCall[];
  /** 해석기가 채우는 명령 — GM이 해석기 도구를 불렀을 때만 선다 */
  ops?: (ctx: ScriptContext) => OpsInput;
}

/** 감독의 말을 해석기에 그대로 넘기는 도구 하나 — 실모드의 GM이 하는 것과 같다 */
const orders = (tool: string, said: string): ScriptedCall[] => [{ tool, input: { orders: said } }];

/** 요일 반복 훈련 한 벌 — 달력에 걸릴 제목과 효과 축은 표가 고른다 */
const weekly = (dows: readonly number[], label: string, focus: readonly string[]): OpsInput => ({
  set_training: [{ repeatWeekly: dows.map((dow) => ({ dow, slot: "am", label, focus })) }],
});

const WEEKDAYS = [1, 2, 3, 4, 5] as const;

/** 재계약을 여는 자 — 대본이 「계약 만료 다가오는 선수」로 고르는 폭 */
const RENEWAL_HORIZON_DAYS = 365;
const RENEWAL_YEARS = 3;

/**
 * **표** — 위에서 아래로 훑어 처음 걸린 줄이 그 턴의 대본이다.
 *
 * 글자까지 같은 줄이 먼저 걸리고, 이름 자리를 둔 줄은 그다음이다. e2e가 채팅에 치는
 * 말은 이 표의 키와 같게 맞춘다 (`e2e/*.spec.ts`).
 */
const SCRIPT: readonly ScriptLine[] = [
  {
    say: "훈련 잡아줘",
    gm: () => orders("training_orders", "훈련 잡아줘"),
    ops: () => weekly(WEEKDAYS, "빌드업", ["passing", "vision"]),
  },
  {
    say: "평일 오전은 세트피스 반복 훈련 잡아줘",
    gm: () => orders("training_orders", "평일 오전은 세트피스 반복 훈련 잡아줘"),
    ops: () => weekly(WEEKDAYS, "세트피스", ["kicking", "finishing"]),
  },
  {
    say: "월요일 오전은 세트피스 반복 훈련 잡아줘",
    gm: () => orders("training_orders", "월요일 오전은 세트피스 반복 훈련 잡아줘"),
    ops: () => weekly([1], "세트피스", ["kicking", "finishing"]),
  },
  {
    say: "훈련 쉬자",
    gm: () => orders("training_orders", "훈련 쉬자"),
    ops: ({ state }) => ({ set_training: [{ clear: { from: state.date, rest: true } }] }),
  },
  {
    say: "4-4-2로 바꾸고 공격적으로 가자",
    gm: () => orders("tactic_orders", "4-4-2로 바꾸고 공격적으로 가자"),
    ops: () => ({ set_tactics: [{ mentality: 4 }] }),
  },
  {
    say: "4-4-2로 수비적으로 가자",
    gm: () => orders("tactic_orders", "4-4-2로 수비적으로 가자"),
    ops: () => ({ set_tactics: [{ mentality: 2 }] }),
  },
  {
    say: `${NAME_SLOT} 주장 시키자`,
    gm: ({ named }) => orders("tactic_orders", `${named} 주장 시키자`),
    ops: ({ named }) => ({ set_captain: [{ playerId: named }] }),
  },
  {
    say: "다들 모여봐",
    gm: () => [
      { tool: "team_talk", input: { occasion: "daily", outcome: "encouraged", intensity: 2 } },
    ],
  },
  {
    say: `${NAME_SLOT} 면담 좀 하자`,
    gm: ({ named }) => [
      { tool: "talk_to_player", input: { playerId: named, outcome: "motivated", intensity: 2 } },
    ],
  },
  { say: "회견장 가자", gm: () => [{ tool: "respond_to_media", input: { stance: "defend" } }] },
  { say: "경기 시작하자", gm: () => [{ tool: "start_match", input: {} }] },
  { say: "다음 경기로 가자", skip: "next_match" },
  { say: "하루 넘기자", skip: 1 },
  {
    say: "계약 만료 다가오는 선수 재계약 하자",
    gm: () => orders("market_orders", "계약 만료 다가오는 선수 재계약 하자"),
    ops: ({ state }): OpsInput => {
      const who = expiringContracts(state, RENEWAL_HORIZON_DAYS)[0]?.player;
      if (!who) return {};
      return {
        open_renewal: [
          { playerId: who.id, weeklyWage: renewalExpectation(state, who), years: RENEWAL_YEARS },
        ],
      };
    },
  },
  {
    say: `${NAME_SLOT} 영입하자`,
    gm: ({ named }) => orders("market_orders", `${named} 영입하자`),
    /**
     * 이적료는 **코어가 부르는 자**를 그대로 쓴다(`suggestTerms`) — 감독이 액수를
     * 말하지 않은 오퍼는 실모드에서 나가지 않으므로(`missingFeeNote`), 대본이 그
     * 자리를 대신 채운다.
     */
    ops: ({ state, named }): OpsInput => {
      const wanted = state.players.find((p) => p.name === named && p.teamId !== state.userTeamId);
      const terms = wanted ? suggestTerms(state, wanted.id) : null;
      if (!wanted || !terms) return {};
      return {
        send_offer: [
          { playerId: wanted.id, fee: terms.fee, weeklyWage: terms.weeklyWage, years: terms.years },
        ],
      };
    },
  },
  {
    say: "이적 건 마무리하자",
    gm: () => orders("market_orders", "이적 건 마무리하자"),
    ops: ({ state }): OpsInput => {
      const agreed = state.negotiations.find((n) => n.status === "agreed");
      return agreed ? { accept_deal: [{ negotiationId: agreed.id }] } : {};
    },
  },
];

/** 표에 걸린 줄과, 이름 자리에 들어온 이름 */
interface ScriptHit {
  line: ScriptLine;
  named: string;
}

/**
 * 감독의 말 하나 → 표의 한 줄. **글자까지 같은 줄이 먼저다.**
 *
 * 이름 자리를 둔 줄은 앞뒤 고정 문구가 그대로 맞고 그 사이가 비어 있지 않을 때만
 * 걸린다 — 뜻을 짐작하는 자리가 아니라 자리 하나를 받는 틀이다.
 */
function findLine(said: string): ScriptHit | null {
  const message = said.trim();
  for (const line of SCRIPT) {
    if (!line.say.includes(NAME_SLOT) && line.say === message) return { line, named: "" };
  }
  for (const line of SCRIPT) {
    const slot = line.say.indexOf(NAME_SLOT);
    if (slot < 0) continue;
    const head = line.say.slice(0, slot);
    const tail = line.say.slice(slot + NAME_SLOT.length);
    if (!message.startsWith(head) || !message.endsWith(tail)) continue;
    const named = message.slice(head.length, message.length - tail.length).trim();
    if (named.length > 0) return { line, named };
  }
  return null;
}

/** 장면 하나가 흘려보내는 시간 — 대본이 하루 안에서 시계를 미는 유일한 눈금 */
const SCENE_STEP_MINUTES = 30;
/** 하루의 끝 — 날짜를 넘기는 것은 넘기겠다고 한 말뿐이다 */
const LAST_CLOCK = "23:00";

function clockOfMinutes(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** 실모드와 같은 모양의 시점 헤더 — 이 한 줄이 코어의 시계를 민다 (agents.md §2) */
function sceneHeader(date: string, clock: string): string {
  return `[${date} ${formatClock(clock)}]`;
}

/** 이 줄이 가리키는 시점 — 넘기는 말이면 그 날짜, 아니면 오늘의 한 걸음 뒤 */
function pointOf(state: GameState, line: ScriptLine | null): string {
  if (line?.skip === "next_match") {
    const next = nextMatchFor(state.matches, state.userTeamId, state.date);
    return sceneHeader(next?.date ?? addDays(state.date, 7), "09:00");
  }
  if (typeof line?.skip === "number") {
    return sceneHeader(addDays(state.date, line.skip), "09:00");
  }
  const stepped = Math.min(
    minutesOfClock(clockOf(state)) + SCENE_STEP_MINUTES,
    minutesOfClock(LAST_CLOCK),
  );
  return sceneHeader(state.date, clockOfMinutes(stepped));
}

/**
 * **평시 턴의 대본.**
 *
 * 본문은 비운다 — 도구가 남긴 기록으로 코어가 장면을 세우므로(gm.ts) 대본이 대사를
 * 지어낼 자리가 없다. **기록도 장면도 없는 턴만** 한 줄을 세운다: 장면이 통째로 비면
 * 턴이 취소되고, 그때 감독은 자기 말이 사라진 화면을 본다.
 */
export function peaceScript(
  state: GameState,
  said: string,
  /** 이 턴에 코어가 이미 남긴 기록이 있는가 — 손잡이의 시간 이동·도착한 편지 */
  options: { recorded: boolean },
): ScriptedTurn {
  const hit = findLine(said);
  const header = pointOf(state, hit?.line ?? null);
  const calls = hit?.line.gm?.({ state, named: hit.named }) ?? [];
  const stands = options.recorded || calls.length > 0 || hit?.line.skip !== undefined;
  return stands
    ? { calls, text: header }
    : { text: `${header}\n@: *${describeNextFixture(state)}*` };
}

/** 해석기의 대본 — 같은 말이 같은 표의 같은 줄에서 명령의 인자를 받는다 */
export function ordersScript(state: GameState, tool: string, said: string): ScriptedTurn {
  const hit = findLine(said);
  const ops = hit?.line.ops?.({ state, named: hit.named }) ?? {};
  return { calls: [{ tool, input: { ops } }] };
}

// ── 중계 ───────────────────────────────────────────────
//
// **장면을 대본이 쓰는 유일한 자리다.** 구간의 사건은 장부에 있고(`lastSegment`),
// 그것을 문장으로 옮기는 자가 없으면 경기 화면이 빈 채로 돈다. 실모드에서 이 자리를
// 맡는 것이 캐스터 LLM이다.

function scoreLine(state: GameState): string {
  const match = state.pendingMatch;
  if (!match) return "";
  const record = state.matches.find((m) => m.id === match.matchId);
  if (!record) return "";
  return `${teamName(record.homeTeamId)} ${match.ledger.score.home} : ${match.ledger.score.away} ${teamName(record.awayTeamId)}`;
}

/** 죽은 공에서 나온 슛인가 — 대본도 그 사실을 문장에 싣는다 (match.md §1.4) */
const SHOT_ORIGIN_KO: Record<string, string> = {
  corner: "코너에서 ",
  free_kick: "프리킥에서 ",
  penalty: "페널티킥 — ",
};

function renderEvent(state: GameState, ev: MatchEvent): string[] {
  const name = ev.actors[0] ? playerName(state, ev.actors[0]) : "";
  const from = ev.shotOrigin ? (SHOT_ORIGIN_KO[ev.shotOrigin] ?? "") : "";
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
    case "yellow_card":
      return [`@중계: ${ev.minute}′ ${name}에게 옐로카드.`];
    case "red_card":
      return [`@중계: *${ev.minute}′ ${name} 퇴장!*`];
    case "injury":
      return [`@중계: ${ev.minute}′ ${name}이 쓰러집니다 — 의료진이 들어옵니다.`];
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

/** 구간이 멈춘 자리 — 감독의 차례라는 것을 중계가 밝힌다 */
const STOP_KO: Record<string, string> = {
  half_time: "*하프타임 — 라커룸으로 향한다*",
  extra_time_start: "*90분 종료 — 승부는 연장으로 넘어갑니다.*",
  extra_half_time: "*연장 전반 종료.*",
};

const SHOOTOUT_KO: Record<ShootoutOutcome, string> = {
  scored: "성공입니다!",
  saved: "골키퍼가 막아냅니다!",
  missed: "골문을 벗어납니다!",
};

/** 승부차기 한 발 — 코어가 굴린 그 발을 문장으로 옮긴다 (match.md §2) */
function shootoutLines(state: GameState): string[] {
  const kicks = state.pendingMatch?.shootout?.kicks ?? [];
  const last = kicks.at(-1);
  const tally = shootoutTally(kicks);
  return [
    ...(last
      ? [
          `@중계: ${last.round}번째 키커 ${playerName(state, last.taker)} — ${SHOOTOUT_KO[last.outcome]}`,
        ]
      : [`@중계: *120분이 승부를 가르지 못했습니다 — 승부차기로 갑니다.*`]),
    `@중계: *승부차기 ${tally.home} : ${tally.away}.*`,
  ];
}

/**
 * **경기 턴의 대본.** 구간을 굴리는 것은 코어이고(`applyTacticOrders` — gm.ts) 여기서
 * 하는 일은 그 구간의 사건을 중계로 옮기는 것뿐이다. 마감도 코어가 부른다.
 */
export function matchScript(
  state: GameState,
  options: { kickoff: boolean; operator: boolean },
): ScriptedTurn {
  if (options.kickoff) {
    const record = state.matches.find((m) => m.id === state.pendingMatch?.matchId);
    const fixture = record
      ? `${teamName(record.homeTeamId)} 대 ${teamName(record.awayTeamId)}`
      : "양 팀";
    return {
      text: [
        `@: *터널을 나선 스물두 명이 자리를 잡는다*`,
        `@중계: ${fixture}, 곧 킥오프입니다.`,
      ].join("\n"),
    };
  }
  // 굴린 것이 없는 턴 — 감독이 말만 건 자리다. 장부의 지금만 읽어 준다
  if (!options.operator) {
    return { text: `@중계: ${state.pendingMatch?.ledger.minute ?? 0}′ — ${scoreLine(state)}.` };
  }
  const segment = state.pendingMatch?.lastSegment;
  if (!segment) return { text: shootoutLines(state).join("\n") };
  const lines = segment.events.flatMap((ev) => renderEvent(state, ev));
  const stop = STOP_KO[segment.stop];
  if (stop) lines.push(`@중계: ${stop} ${scoreLine(state)}`);
  // 사건 없이 흐른 구간에도 한 줄은 선다 — 빈 장면은 턴이 취소되는 자리다
  if (lines.length === 0) {
    lines.push(`@중계: ${state.pendingMatch?.ledger.minute ?? 0}′ — ${scoreLine(state)}.`);
  }
  return { text: lines.join("\n") };
}
