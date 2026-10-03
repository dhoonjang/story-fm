import { TACTIC_OPS } from "../match/tactic-orders";
import { TRAINING_OPS } from "../story/training-orders";
import { FINANCE_OPS } from "../common/finance-orders";
import type { MatchEvent, ShootoutOutcome } from "@story-fm/domain";
import { eventCauseText, formatScore, shootoutTally } from "@story-fm/domain";
import {
  addDays,
  BIG_CHANCE_XG,
  clockOf,
  describeNextFixture,
  formatClock,
  minutesOfClock,
  managedTeamId,
  nextMatchFor,
  playerName,
  teamName,
  unseenEvents,
  type GameState,
} from "@story-fm/engine";
import type { ScriptedCall, ScriptedTurn } from "@story-fm/llm";
import { eventMinuteText, scoreBeforeEvents } from "../match/match-script";
import type { OpsInput } from "../common/orders-ops";
import { SUGGEST_REPLY_TAG } from "../common/suggest-reply";

/**
 * mock 모드는 감독 원문과 정확히 일치하는 대본 항목만 실행한다.
 * 각 항목이 GM 도구 호출과 해석기의 ops를 함께 지정한다. 등록하지 않은 원문은 도구를 부르지 않는다.
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

/**
 * **감독의 다음 말 하나** — 실모드의 GM이 장면 마지막 줄에 태그로 내는 것을 대본도 매 턴
 * 낸다 (agents.md §8 · prompts.md §1). 글은 전부 표의 키다: Tab으로 받아 그대로 보내면 그
 * 줄이 걸리므로 e2e가 자동완성을 그 길로 잰다.
 */
const suggestLine = (text: string): string =>
  `<${SUGGEST_REPLY_TAG}>${text}</${SUGGEST_REPLY_TAG}>`;

/** 평시의 제안 — 경기일에 닿았거나 닿을 턴이면 킥오프로, 아니면 하루를 넘기는 말 */
function peaceSuggestion(state: GameState, line: ScriptLine | null): string {
  return state.phase === "matchday" || line?.skip === "next_match"
    ? "경기 시작하자"
    : "하루 넘기자";
}

/** 요일 반복 훈련 한 벌 — 달력에 걸릴 제목과 효과 축은 표가 고른다 */
const weekly = (dows: readonly number[], label: string, focus: readonly string[]): OpsInput => ({
  set_training: [{ repeatWeekly: dows.map((dow) => ({ dow, slot: "am", label, focus })) }],
});

const WEEKDAYS = [1, 2, 3, 4, 5] as const;

/**
 * **표** — 위에서 아래로 훑어 처음 걸린 줄이 그 턴의 대본이다.
 *
 * 글자까지 같은 줄이 먼저 걸리고, 이름 자리를 둔 줄은 그다음이다. e2e가 채팅에 치는
 * 말은 이 표의 키와 같게 맞춘다 (`e2e/*.spec.ts`).
 */
const SCRIPT: readonly ScriptLine[] = [
  {
    say: "테스트 이적 명단 등록",
    gm: ({ state }) => {
      const player = state.players.find(
        (p) =>
          p.teamId === managedTeamId(state) &&
          state.contracts.some((c) => c.gamePlayerId === p.id && c.status === "active"),
      );
      return player
        ? [
            {
              tool: "set_transfer_list",
              input: { playerId: player.id, listed: true, askingPrice: 10000000 },
            },
          ]
        : [];
    },
  },
  {
    say: "테스트 재계약 협상",
    gm: ({ state }) => {
      const player = state.players.find(
        (p) =>
          p.teamId === managedTeamId(state) &&
          state.contracts.some((c) => c.gamePlayerId === p.id && c.status === "active"),
      );
      return player
        ? [
            {
              tool: "start_negotiation",
              input: { playerId: player.id, kind: "renewal", background: "재계약 논의" },
            },
          ]
        : [];
    },
  },

  {
    say: "훈련 잡아줘",
    ops: () => weekly(WEEKDAYS, "빌드업", ["passing", "vision"]),
  },
  {
    say: "평일 오전은 세트피스 반복 훈련 잡아줘",
    ops: () => weekly(WEEKDAYS, "세트피스", ["kicking", "finishing"]),
  },
  {
    say: "월요일 오전은 세트피스 반복 훈련 잡아줘",
    ops: () => weekly([1], "세트피스", ["kicking", "finishing"]),
  },
  {
    say: "훈련 쉬자",
    ops: ({ state }) => ({ set_training: [{ clear: { from: state.date, rest: true } }] }),
  },
  {
    say: "4-4-2로 바꾸고 공격적으로 가자",
    ops: () => ({ set_tactics: [{ mentality: 4 }] }),
  },
  {
    say: "4-4-2로 수비적으로 가자",
    ops: () => ({ set_tactics: [{ mentality: 2 }] }),
  },
  {
    say: `${NAME_SLOT} 주장 시키자`,
    ops: ({ named }) => ({ set_captain: [{ playerId: named }] }),
  },
  {
    say: `${NAME_SLOT}에게 등번호 9번 줘`,
    gm: ({ named }) => [{ tool: "set_squad_number", input: { playerId: named, number: 9 } }],
  },
  { say: "다들 모여봐", gm: () => [] },
  { say: `${NAME_SLOT} 면담 좀 하자`, gm: () => [] },
  { say: "회견장 가자", gm: () => [] },
  { say: "경기 시작하자", gm: () => [{ tool: "start_match", input: {} }] },
  { say: "다음 경기로 가자", skip: "next_match" },
  { say: "하루 넘기자", skip: 1 },
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

/**
 * 대본이 여는 자리 — 감독의 하루는 여기서 시작한다. 실모드의 GM은 장면마다 장소를
 * 고르지만 대본에는 고를 사실이 없으므로 한 자리를 지킨다 (prompts.md §1).
 */
const SCRIPT_PLACE = "감독실";

/** 실모드와 같은 모양의 시점 헤더 — 이 한 줄이 코어의 시계를 민다 (agents.md §2) */
function sceneHeader(date: string, clock: string, place = SCRIPT_PLACE): string {
  return `[${date} ${formatClock(clock)} · ${place}]`;
}

/** 오늘의 한 걸음 뒤 — 장면 하나가 흘려보내는 시각 */
function steppedClock(state: GameState): string {
  const stepped = Math.min(
    minutesOfClock(clockOf(state)) + SCENE_STEP_MINUTES,
    minutesOfClock(LAST_CLOCK),
  );
  return clockOfMinutes(stepped);
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
  return sceneHeader(state.date, steppedClock(state));
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
  /** 이 턴에 코어가 이미 남긴 기록이 있는가 — 손잡이의 시간 이동 */
  options: { recorded: boolean },
): ScriptedTurn {
  const hit = findLine(said);
  const line = hit?.line ?? null;
  const header = pointOf(state, line);
  const calls = hit?.line.gm?.({ state, named: hit.named }) ?? [];
  const ops = hit?.line.ops?.({ state, named: hit.named }) ?? {};
  for (const [tool, names] of [
    ["tactic_orders", TACTIC_OPS],
    ["training_orders", TRAINING_OPS],
    ["finance_orders", FINANCE_OPS],
  ] as const) {
    if (names.some((name) => (ops[name]?.length ?? 0) > 0)) calls.unshift({ tool, input: {} });
  }
  const stands = options.recorded || calls.length > 0 || line?.skip !== undefined;
  // 제안 줄은 장면이 아니다 — 코어가 꺼내 가고 위생이 걷으므로 장면이 서는지는 앞 줄들이 정한다
  const suggested = suggestLine(peaceSuggestion(state, line));
  return stands
    ? { calls, text: `${header}\n${suggested}` }
    : { text: `${header}\n@: *${describeNextFixture(state)}*\n${suggested}` };
}

/** 해석기의 대본 — 같은 말이 같은 표의 같은 줄에서 명령의 인자를 받는다 */
export function ordersScript(state: GameState, said: string): ScriptedTurn {
  const hit = findLine(said);
  const ops = hit?.line.ops?.({ state, named: hit.named }) ?? {};
  // 실모드의 해석기와 같은 산출 — 도구가 아니라 `{ ops }` JSON 하나다 (models.md §3-2)
  return { output: { ops } };
}

/** 벤치의 다음 말 — 표에 없는 말이라 장면만 선다. 경기를 굴리는 것은 손잡이다 */
const MATCH_SUGGESTION = "계속 가자";

// ── 중계 ───────────────────────────────────────────────
//
// **장면을 대본이 쓰는 유일한 자리다.** 지난 턴 뒤의 사건은 장부에 있고(`unseenEvents`),
// 그것을 문장으로 옮기는 자가 없으면 경기 화면이 빈 채로 돈다. 실모드에서 이 자리를
// 맡는 것이 캐스터 LLM이다.

/** 스코어 한 줄 — 자는 `formatScore` 하나다 (design-system.md §3) */
function scoreLine(state: GameState, score: { home: number; away: number }): string {
  const match = state.pendingMatch;
  if (!match) return "";
  const record = state.matches.find((m) => m.id === match.matchId);
  if (!record) return "";
  return `${teamName(record.homeTeamId)} ${formatScore(score.home, score.away)} ${teamName(record.awayTeamId)}`;
}

/** 죽은 공에서 나온 슛인가 — 대본도 그 사실을 문장에 싣는다 (match.md §4) */
const SHOT_ORIGIN_KO: Record<string, string> = {
  corner: "코너에서 ",
  free_kick: "프리킥에서 ",
  penalty: "페널티킥 — ",
};

/**
 * **빗나간 슛의 갈래** — 장부가 슛마다 들고 있는 결과다(`shotOutcome`). 한 문형으로
 * 뭉뚱그리면 슛 일곱 개가 같은 문장으로 선다 (prompts.md §1) — 같은 갈래가 다시 오면
 * 다음 꼴로 넘어간다.
 */
const SHOT_KO: Record<string, ReadonlyArray<(who: string) => string>> = {
  saved: [
    (who) => `${who}의 슈팅, 골키퍼가 몸을 날려 쳐냅니다.`,
    (who) => `${who}의 노림수 — 골키퍼 손끝에 걸립니다.`,
  ],
  blocked: [
    (who) => `${who}의 슛, 수비 몸에 맞고 굴절됩니다.`,
    (who) => `${who}의 마무리 — 앞에 선 수비가 몸으로 막아 냅니다.`,
  ],
  off_target: [
    (who) => `${who}의 슛 — 골문을 크게 벗어납니다.`,
    (who) => `${who}의 감아 찬 공, 골대 옆으로 흐릅니다.`,
  ],
};

/** 한 문형이 한 턴에서 되풀이되지 않게 — 같은 갈래가 몇 번째로 오는지를 센다 */
function shapeTurns(): (key: string) => number {
  const used = new Map<string, number>();
  return (key) => {
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    return n;
  };
}

function renderEvent(
  state: GameState,
  ev: MatchEvent,
  /** 이 사건까지의 스코어 — 골 줄이 그 골 뒤의 값을 적는다 */
  score: { home: number; away: number },
  turnOf: (key: string) => number,
): string[] {
  const nameOf = (id: string) => playerName(state, id);
  const name = ev.actors[0] ? nameOf(ev.actors[0]) : "";
  const from = ev.shotOrigin ? (SHOT_ORIGIN_KO[ev.shotOrigin] ?? "") : "";
  const at = eventMinuteText(ev);
  switch (ev.type) {
    case "kickoff":
      return [`@중계: 킥오프! 경기가 시작됩니다.`];
    case "goal": {
      const cause = ev.causes[0] ? ` — ${eventCauseText(ev.causes[0], nameOf)}` : "";
      return [`@중계: 골! ${scoreLine(state, score)} (${from}${name} ${at})${cause}`.trimEnd()];
    }
    case "shot": {
      const big = (ev.xg ?? 0) >= BIG_CHANCE_XG ? "결정적인 장면! " : "";
      const shapes = ev.shotOutcome ? SHOT_KO[ev.shotOutcome] : undefined;
      const shape = shapes?.[turnOf(ev.shotOutcome ?? "shot") % shapes.length];
      return [
        `@중계: ${at} ${big}${shape ? shape(`${from}${name}`) : `${from}${name}의 슛이 이어집니다.`}`,
      ];
    }
    case "foul":
      return [`@중계: ${at} ${name}의 반칙 — 주심이 점을 가리킵니다!`];
    case "chance":
      return [`@중계: ${at} ${name}에게 기회가 왔지만 마무리가 아쉽습니다.`];
    case "save":
      return [`@중계: ${at} 골키퍼의 선방!`];
    case "yellow_card":
      return [`@중계: ${at} ${name}에게 옐로카드.`];
    case "red_card":
      return [`@중계: *${at} ${name} 퇴장!*`];
    case "injury":
      return [`@중계: ${at} ${name}, 그라운드에 쓰러집니다 — 의료진이 들어옵니다.`];
    case "half_time":
      return [`@중계: *하프타임 — 라커룸으로 향한다* ${scoreLine(state, score)}`];
    case "extra_time_start":
      return [`@중계: *90분 종료 — 승부는 연장으로 넘어갑니다.* ${scoreLine(state, score)}`];
    case "extra_half_time":
      return [`@중계: *연장 전반 종료.* ${scoreLine(state, score)}`];
    case "full_time":
      return [`@중계: *경기 종료 휘슬* 최종 스코어 ${scoreLine(state, score)}.`];
    case "substitution":
      return [
        `@: *교체 보드가 올라간다 — ${nameOf(ev.actors[0] ?? "")} OUT, ${nameOf(ev.actors[1] ?? "")} IN*`,
      ];
    // 상대 벤치가 판을 옮겼다 — 문장은 원인 렌더러가 만든다 (match.md §3.3)
    case "tactical_shift":
      return ev.causes[0]
        ? [`@중계: ${at} 상대 벤치가 움직입니다 — ${eventCauseText(ev.causes[0], nameOf)}.`]
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
 * **같은 분의 슛과 선방은 한 장면이다** (prompts.md §1) — 슛 줄이 이미 「골키퍼가
 * 쳐냅니다」를 말하므로 그 분의 선방 줄은 서지 않는다.
 */
function savesToldByShots(events: readonly MatchEvent[]): ReadonlySet<number> {
  return new Set(
    events.filter((ev) => ev.type === "shot" && ev.shotOutcome === "saved").map((ev) => ev.minute),
  );
}

/** 승부차기 한 발 — 코어가 굴린 그 발을 문장으로 옮긴다 (match.md §3.4) */
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
    `@중계: *승부차기 ${formatScore(tally.home, tally.away)}.*`,
  ];
}

/**
 * **경기 턴의 대본.** 시계를 미는 것은 클라이언트의 실행기이고 여기서 하는 일은 지난 턴
 * 뒤의 사건(`unseenEvents`)을 중계로 옮기는 것뿐이다. 마감도 코어가 부른다.
 */
export function matchScript(
  state: GameState,
  options: { kickoff: boolean; operator: boolean; message?: string },
): ScriptedTurn {
  const suggested = suggestLine(MATCH_SUGGESTION);
  const pending = state.pendingMatch;
  if (options.kickoff) {
    const record = state.matches.find((m) => m.id === pending?.matchId);
    const fixture = record
      ? `${teamName(record.homeTeamId)} 대 ${teamName(record.awayTeamId)}`
      : "양 팀";
    return {
      text: [
        `@: *터널을 나선 스물두 명이 자리를 잡는다*`,
        `@중계: ${fixture}, 곧 킥오프입니다.`,
        suggested,
      ].join("\n"),
    };
  }
  const now = pending?.live.ledger.score ?? { home: 0, away: 0 };
  const minute = pending?.live.ledger.minute ?? 0;
  if (pending?.shootout) return { text: [...shootoutLines(state), suggested].join("\n") };
  const events = unseenEvents(state);
  const running = scoreBeforeEvents(now, events);
  const told = savesToldByShots(events);
  const turnOf = shapeTurns();
  const lines = events.flatMap((ev) => {
    if (ev.type === "save" && told.has(ev.minute)) return [];
    if (ev.type === "goal" && ev.team) running[ev.team] += 1;
    return renderEvent(state, ev, running, turnOf);
  });
  // 사건 없이 멈춘 턴에도 한 줄은 선다 — 빈 장면은 턴이 취소되는 자리다
  if (lines.length === 0) lines.push(`@중계: ${minute}′ — ${scoreLine(state, now)}.`);
  lines.push(suggested);
  const hit = options.message ? findLine(options.message) : null;
  const commands = hit?.line.ops?.({ state, named: hit.named }) ?? {};
  return {
    text: lines.join("\n"),
    ...(!options.operator && Object.keys(commands).length > 0
      ? { calls: [{ tool: "tactic_orders", input: {} }] }
      : {}),
  };
}
