import { z } from "zod";
import {
  AXIS_KO,
  ATTRIBUTE_AXES,
  PointSchema,
  SHEET_SHAPES,
  SHEET_SHAPE_KO,
  SheetLineSchema,
  normalizePacket,
  packetTagContext,
  packetTagText,
  roleVocabularyText,
  type AttributeAxis,
  type BoardMove,
  type Point,
  type SheetLine,
} from "@story-fm/domain";
import {
  POINTS_MAX,
  journal,
  managerTacticsOf,
  packetDigest,
  playerById,
  playerName,
  teamName,
  type GameState,
  type ReadingOccasion,
} from "@story-fm/engine";
import {
  agentConfig,
  createGameLLM,
  type GameLLM,
  type GameToolSpec,
  type JsonObjectSchema,
} from "@story-fm/llm";
import {
  buildBoardMovesBlock,
  buildLedgerNote,
  buildMatchBrief,
  buildMatchLogBlock,
} from "./gm-input";
import { buildSegmentMessage } from "./match-script";
import { mockReaderLlm } from "./mock-gm";
import { buildOpsSchema, parseOps, tagged, type OpsInput } from "./orders-ops";
import { TACTIC_CAPS } from "./tactic-orders";
import { ModelOutputError, readOutput, retryOnce } from "./retry";
import { toToolSchema } from "./tool-schema";

/**
 * 판독기 — **경기의 위층을 쓰는 하나의 저자** (agents.md §3 · match.md §1.6).
 *
 * 코어 로직이 역할·능력치·포메이션에서 판을 결정적으로 계산하고, 그 위에서 이 경기가
 * 지금 어떻게 읽히는가를 문장으로 든 것이 전술 포인트, 그 판독의 수치 독해가 시트다.
 * 이 호출은 그 둘을 매번 전체로 다시 쓰고, 감독이 말한 턴이면 그 말을 판독 위에서
 * 읽어 명령의 인자까지 함께 낸다.
 *
 * 산출은 도구가 아니라 **이 호출의 출력 스키마** 하나다 (models.md §3-2). 값을 매기는
 * 것은 코어다 — 실재 확인·한도·예산·소화율·포화는 패킷을 세울 때 걸리고, 여기서
 * 고르는 것은 누구를·어느 칸을·어느 쪽으로·얼마나까지다.
 */

/**
 * 판독기가 채우는 **경기의 명령** — `TACTIC_OPS`의 부분집합이고 **적용 순서**다.
 *
 * 교체를 먼저 넣고 그 위의 자리·역할이 온다 — 뒤이은 지시가 방금 들어온 선수를
 * 겨냥할 수 있기 때문이다. 대화는 판이 다 선 뒤에 남긴다. 라인업·1·2군·완장은 경기
 * 중에 설 자리가 없어 여기 없다.
 */
export const MATCH_OPS: readonly string[] = [
  "substitute",
  "set_tactics",
  "set_player_tactic",
  "set_set_piece_takers",
  "set_set_piece_routine",
  "set_shootout_order",
  "team_talk",
];

/** 한 포인트가 데리고 갈 수 있는 시트 줄 — 넘겨 와도 코어의 한도가 먼저 자른다 */
const SHEET_LINES_PER_POINT = 3;

/** 시트 줄의 상한 — 포인트 상한 × 포인트당 줄. 설명 문장으로 가고 코어가 자른다 */
const SHEET_MAX = POINTS_MAX * SHEET_LINES_PER_POINT;

/** 모양 넷의 부호가 무엇을 올리는가 — 낱말도 뜻도 `SHEET_SHAPES` 한 벌에서 온다 */
const SHEET_SIGN_KO: Record<(typeof SHEET_SHAPES)[number], string> = {
  edge: "그 칸이 두꺼워진다",
  temper: "카드·파울이 늘어난다",
  legs: "다리가 빨리 죽는다",
  cohesion: "지시가 잘 스민다",
};

const SHEET_SHAPE_LINES = SHEET_SHAPES.map(
  (shape) => `${shape}(${SHEET_SHAPE_KO[shape]}) — +면 ${SHEET_SIGN_KO[shape]}, −면 그 반대`,
).join("\n- ");

export const MATCH_READER_SYSTEM = `당신은 경기를 읽는 판독기다. 이 경기가 지금 어떻게 돌아가는가를 전술 포인트로 쓰고, 그 판독의 수치 독해를 시트로 옮긴다. 감독이 말한 턴이면 그 말을 판독 위에서 읽어 명령의 인자도 함께 낸다. 중계도 대사도 쓰지 않는다.

# 무엇을 내나
- points — 이 경기의 전술 포인트 **전체**. 매번 처음부터 다시 쓴다. ${POINTS_MAX}줄까지.
- sheet — 포인트마다의 시트 줄. 한 포인트에 많아야 ${SHEET_LINES_PER_POINT}줄, 모두 합쳐 ${SHEET_MAX}줄까지.
- ops — 감독이 말한 턴에만. 부를 명령 이름 아래 그 인자를 배열로.
- unresolved — 어느 자리에도 담기지 않은 감독의 말.

# 전술 포인트
사실 몇 개를 하나의 뜻으로 묶은 한 줄이다 — "발 빠른 래쉬포드를 맨마킹하는 반다이크", "거친 플레이에 흔들리는 마이누", "왼쪽으로 몰리는 상대의 공격".
- 어느 팀의 메모가 아니라 **양 팀에 걸친 경기의 판독**이다. 상대 벤치의 작은 수 — 상대 센터백이 우리 윙어를 따라붙는 것, 한쪽 측면을 비우고 반대편에 몰리는 것 — 도 여기서 난다.
- 이어지는 판독은 **같은 id로** 남기고, 사라진 판독은 빼고, 새로 읽은 것은 새 id로 더한다.
- about에는 그 판독이 겨눈 선수의 id와 편(home·away)을 적는다. importance 1~3 — 이 경기를 가르는 정도.
- 근거 없는 줄은 쓰지 않는다. <facts>와 <segment>에 선 사실에서 읽는다.

# 시트
포인트 하나를 가리키는 줄이고, 코어가 읽는 것은 이것뿐이다. 고르는 것은 누구를·어느 칸을·어느 쪽으로·얼마나까지다.
- ${SHEET_SHAPE_LINES}
- target — edge는 선수 한 명(player)이거나 칸(side + band, 레인을 적지 않으면 그 줄 전체). temper·legs는 선수, cohesion은 팀(side).
- step 1~3은 눈금이지 수치가 아니다. 판독이 경기를 가르는 정도만큼.
- **이득만 있는 판독은 없다.** 마킹은 마커의 본업을 비우고, 오버랩은 뒤를 연다 — 이득 줄을 쓴 포인트에는 그 대가 줄도 쓴다.
- 포인트가 없으면 시트도 없다.

# 감독의 말
- 판을 움직이는 말은 명령이 아니다. "붙어서 지워" · "그 뒤를 덮어" · "왼쪽으로 몰아"는 새 포인트와 시트다 — 지시가 판독의 한 줄을 공략하거나 보완하면 그 줄이 바뀌고 시트가 따라간다.
- 자리·역할·교체·6축·키커·대화처럼 장부가 세는 것은 ops다. 감독이 정한 것만 — 말하지 않은 축·자리·역할은 보내지 않는다.
- 옮길 수 있는 것은 다 싣고 막힌 말만 unresolved에 남긴다. 감독이 정하지 않고 맡긴 말("알아서 하세요")에는 채울 것이 없다 — 지어내지 않고 unresolved에 남긴다.
- 훈련·육성·이적의 말은 여기서 옮기지 않고 unresolved에도 남기지 않는다.

# 판에서 이미 움직인 것
<board_moves>의 축·선수·자리를 가리키는 말은 그 줄의 앞 값에 대 본다.
판이 간 곳과 같으면 감독이 방금 판에서 한 일을 말로 설명한 것이다 — 그 명령을 싣지 않는다.
다른 곳을 가리키면(더 멀리·반대로) <standing>의 지금 값에서 움직여 싣는다.

# 대화 (team_talk)
감독이 그 사람에게 건넨 말이 있을 때만 싣고, 그 말이 어떻게 닿았는지를 라벨로 고른다.
- 판정은 의미 있는 대화가 마무리된 턴에 한 번이다 — 감독이 자리를 뜨거나 화제가 닫히거나 장면이 넘어갈 때. 대화 도중에는 싣지 않는다.
- 이름을 부르기만 한 말(“브루노 일루와봐”, “잠깐 와봐”)은 부름이지 대화가 아니다 — 비운다.
- players에 이름을 적으면 그 사람들, 비우면 선수단 전체다. 이름 없이 가리키면 <match_log>에서 가장 최근에 그 자리에 있던 사람이다. 지시가 앞 턴의 대화를 잇는 말이면 그 대화가 근거다.
- outcome은 감독 발화의 (a) 맥락 적합성 (b) 설득 근거 (c) 대상 수용성으로 판정한다. inspired는 드물다 — 말이 그 사람의 처지에 정확히 닿고 근거가 섰을 때만이고, 평범한 격려는 encouraged다.
- intensity 1~3 — 말의 세기. occasion은 킥오프 전 pre · 하프타임 half · 종료 후 post · 그 밖 daily · 굴러가던 중 정지점의 짧은 외침 shout(“정신 차려”, “머리 들어”).
- promise는 이번 턴에 감독이 그 사람에게 못 박은 약속(출전·이적 허용·재계약·주장·등번호)만. 지난 턴의 약속을 다시 싣지 않고, 이미 말해 뒀다는 말과 선발에서 빼는 말에는 약속이 없다.
- 그 사람의 심경이 한 줄로 남을 만하면 moods에 적는다.

# 판을 바꾸는 명령
- substitute — 교체 한 건. out/in은 <ledger>의 id. 여럿이면 배열에 여럿.
- set_tactics — 6축(1~5)과 갈래 중 감독이 말한 것만.
- set_player_tactic — 그라운드에 있는 한 선수의 자리와 역할.
  - 자리는 move로만 옮긴다: lane(left·center·right) × band(defense=우리 진영, midfield, attack=상대 진영). 지정하지 않은 축은 그대로 둔다. 좌표를 지어내지 않는다.
  - role은 그 자리의 역할이다 — 감독이 시키는 일이 「자리별 역할」의 한 종이면 그것을 적는다. 이름·id·약어 어느 표기든 걸린다. 표에 없는 말은 포인트와 시트로 옮긴다.
- set_set_piece_takers — 세트피스 키커. corner·freeKick·penalty 중 감독이 말한 자리만 싣고, 지정을 풀라는 말이면 그 자리에 null을 넣는다.
- set_set_piece_routine — 세트피스에 몇 명이 서는가. 감독이 말한 축만.
- set_shootout_order — 승부차기 키커 순서. 감독이 이름을 든 사람만.

# 입력
- <ledger> 스코어·시각·온필드와 벤치·교체 횟수 · <standing> 우리가 걸어 둔 전술 · <facts> 양 팀의 능력치와 격자·상성·피로·카드 · <points> 지금 서 있는 전술 포인트 · <match_log> 이 경기의 지난 턴 · <board_moves> 이번 턴 감독이 전술판에서 움직인 것.
- <segment> 방금 구른 구간의 사건. <pre_match> 경기 전 감독이 한 말.
- @감독: 이번 턴 감독의 말. 없으면 판독만 다시 쓴다.

# 자리별 역할 (set_player_tactic의 role)
${roleVocabularyText()}`;

/** 판독기가 내는 것 — 명령의 인자와, 이 경기의 포인트·시트 */
export interface MatchReaderOutput {
  ops: OpsInput;
  /** 상한에 걸려 자른 수 — 명령 이름별. `applyOps`가 한 줄로 되돌린다 */
  truncated?: Readonly<Record<string, number>>;
  points: Point[];
  sheet: SheetLine[];
  unresolved?: string;
}

/**
 * 이 호출이 요청에 싣는 출력 스키마 — `{ ops, points, sheet, unresolved }`.
 *
 * `ops`의 인자는 **명령의 도구 정의에서 그대로** 오고(`buildOpsSchema`), 포인트와
 * 시트는 도메인의 Zod에서 파생한다. 상한은 `maxItems`가 아니라 설명 문장으로 간다 —
 * 제공자가 받는 스키마 부분집합이 갈리고, 지키는 것은 코어다 (`orders-ops.ts`).
 */
export function matchReaderOutputSchema(
  specs: ReadonlyMap<string, GameToolSpec>,
): JsonObjectSchema {
  return {
    type: "object",
    properties: {
      ops: buildOpsSchema(specs, MATCH_OPS, "부를 명령과 그 인자 — 감독이 말한 것만", TACTIC_CAPS),
      points: {
        type: "array",
        items: toToolSchema(PointSchema),
        description: `이 경기의 전술 포인트 전체 — 최대 ${POINTS_MAX}줄. 이어지는 판독은 같은 id로 남긴다`,
      },
      sheet: {
        type: "array",
        items: toToolSchema(SheetLineSchema),
        description: `포인트마다의 시트 줄 — 한 포인트에 ${SHEET_LINES_PER_POINT}줄까지, 모두 합쳐 ${SHEET_MAX}줄까지`,
      },
      unresolved: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "어느 명령에도, 어느 포인트에도 담기지 않은 감독의 말",
      },
    },
  };
}

/** 이 호출의 한 벌 — 출력 스키마 선언 열(`outputAgents`)도 이것을 읽는다 */
export const MATCH_READER_SPEC = {
  agent: "match-reader",
  system: MATCH_READER_SYSTEM,
  schema: matchReaderOutputSchema,
} as const;

/** 모델이 낸 판독 — 포인트와 시트는 도메인의 Zod가 그대로 잰다 */
const ReaderReportSchema = z.object({
  ops: z.record(z.unknown()).optional(),
  points: z.array(PointSchema).optional(),
  sheet: z.array(SheetLineSchema).optional(),
  unresolved: z.string().min(1).max(200).optional(),
});

// ── 입력 블록 ─────────────────────────────────────────────

/** 16축 가운데 그 자리가 쓰는 것 — 골키핑은 골문에 선 사람의 축이다 */
function axesFor(position: string): readonly AttributeAxis[] {
  return position === "GK"
    ? ATTRIBUTE_AXES
    : ATTRIBUTE_AXES.filter((axis) => axis !== "goalkeeping");
}

/** 한 선수의 진짜 능력치 한 줄 — 판독기에는 안개가 없다 (match.md §1.6) */
function attributeLine(state: GameState, id: string, position: string): string {
  const player = playerById(state, id);
  if (!player) return "";
  return axesFor(position)
    .map((axis) => `${AXIS_KO[axis]}${player.attributes[axis]}`)
    .join(" ");
}

/** 이 경기에서 그 사람에게 붙은 것 — 카드·파울·피로 */
function marksOf(
  state: GameState,
  id: string,
): { cards: string[]; fouls: number; fatigue: number | null } {
  const pending = state.pendingMatch;
  const events = pending?.ledger.events ?? [];
  const cards = events
    .filter((ev) => ev.actors[0] === id && (ev.type === "yellow_card" || ev.type === "red_card"))
    .map((ev) => (ev.type === "yellow_card" ? "경고" : "퇴장"));
  const fouls = events.filter((ev) => ev.type === "foul" && ev.actors[0] === id).length;
  const fatigue = pending?.matchFatigue?.[id];
  return { cards, fouls, fatigue: fatigue === undefined ? null : Math.round(fatigue) };
}

/**
 * `<facts>` — **판독기가 읽는 사실 전부.** 양 팀의 진짜 능력치와 유효 전력, 아홉 칸
 * 격자와 존, 발동한 상성과 구멍, 이 경기에서 쌓인 피로·파울·카드, 그리고 양 벤치의
 * 등급. 안개는 감독에게만 걸린다 (match.md §1.6).
 *
 * 사실만 싣는다 — 무엇을 하라는 말은 시스템 프롬프트의 것이다.
 */
export function buildFactsBlock(state: GameState): string[] {
  const pending = state.pendingMatch;
  if (!pending?.packet) return [];
  const packet = normalizePacket(pending.packet);
  const digest = packetDigest(packet);
  const tagCtx = packetTagContext(packet);
  const home = packet.home.teamName;
  const away = packet.away.teamName;
  const record = state.matches.find((m) => m.id === pending.matchId);
  /** AI 벤치의 등급 — 그 벤치의 수가 얼마나 날카로운지의 근거다 (match.md §1.6) */
  const bench = record
    ? [
        `벤치 등급: ${home} ${managerTacticsOf(state, record.homeTeamId)} · ` +
          `${away} ${managerTacticsOf(state, record.awayTeamId)}`,
      ]
    : [];
  const zones = (side: "home" | "away"): string =>
    `${side === "home" ? home : away} 공격 ${digest.zones[side].attack} 중원 ${digest.zones[side].midfield} 수비 ${digest.zones[side].defense}`;
  const grid = digest.grid.map(
    (cell) => `  ${cell.band}/${cell.lane} — ${home} ${cell.home} : ${cell.away} ${away}`,
  );
  const lineup = (side: "home" | "away"): string[] =>
    digest.lineup[side].map((p) => {
      const mark = marksOf(state, p.id);
      const tail = [
        ...(mark.fatigue !== null ? [`피로 ${mark.fatigue}`] : []),
        ...(mark.fouls > 0 ? [`파울 ${mark.fouls}`] : []),
        ...mark.cards,
      ];
      return (
        `  ${p.id}(${playerName(state, p.id)} ${p.position}${p.roleId ? ` ${p.roleId}` : ""}) ` +
        `전력 ${p.effective} · ${attributeLine(state, p.id, p.position)}` +
        (tail.length > 0 ? ` · ${tail.join(" · ")}` : "")
      );
    });
  const benchNames = (side: "home" | "away"): string =>
    packet[side].bench.map((p) => `${p.id}(${playerName(state, p.id)} ${p.position})`).join(", ");
  return [
    `<facts>`,
    ...bench,
    `기대 득점 ${digest.expectedGoals.home} : ${digest.expectedGoals.away} · 점유 ${digest.possession.home} : ${digest.possession.away}`,
    `존 — ${zones("home")} / ${zones("away")}`,
    `아홉 칸 (홈 기준 밴드/레인):`,
    ...grid,
    ...(digest.matchups.length > 0
      ? [
          `매치업: ${digest.matchups
            .map(
              (m) =>
                `${m.zone} ${m.edge} ${m.size}${m.homeValue !== undefined ? ` (${m.homeValue}:${m.awayValue})` : ""}`,
            )
            .join(" / ")}`,
        ]
      : []),
    ...digest.keyPoints.map((tag) => `· ${packetTagText(tag, tagCtx)}`),
    `${home} 전술 소화 ${Math.round(digest.tactical.home.uptake * 100)}%${
      digest.tactical.home.notes.length > 0
        ? ` — ${digest.tactical.home.notes.map((n) => packetTagText(n, tagCtx)).join(" / ")}`
        : ""
    }`,
    `${away} 전술 소화 ${Math.round(digest.tactical.away.uptake * 100)}%${
      digest.tactical.away.notes.length > 0
        ? ` — ${digest.tactical.away.notes.map((n) => packetTagText(n, tagCtx)).join(" / ")}`
        : ""
    }`,
    `${home} 온필드:`,
    ...lineup("home"),
    `${home} 벤치: ${benchNames("home")}`,
    `${away} 온필드:`,
    ...lineup("away"),
    `${away} 벤치: ${benchNames("away")}`,
    `</facts>`,
  ];
}

/**
 * `<points>` — **지금 서 있는 판독 전부.** 감독에게 가는 것과 달리 안개가 없다
 * (`pointsSeenBy`는 매치 GM의 블록이다 — match.md §1.6).
 */
export function buildPointsBlock(state: GameState): string[] {
  const points = state.pendingMatch?.points ?? [];
  if (points.length === 0) return [];
  return [
    `<points>`,
    ...points.map(
      (p) =>
        `- ${p.id} [중요도 ${p.importance}${p.about.length > 0 ? ` · ${p.about.join(", ")}` : ""}] ${p.text}`,
    ),
    `</points>`,
  ];
}

/** 방금 구른 구간의 대본 — 장부에 남은 마지막 구간 그대로다 */
function buildSegmentBlock(state: GameState): string[] {
  const pending = state.pendingMatch;
  const last = pending?.lastSegment;
  if (!pending || !last) return [];
  const packet = pending.packet ? normalizePacket(pending.packet) : null;
  const record = state.matches.find((m) => m.id === pending.matchId);
  const sideName = (side: "home" | "away"): string =>
    packet?.[side].teamName ??
    (record ? teamName(side === "home" ? record.homeTeamId : record.awayTeamId) : side);
  /** 구간이 열린 자리의 스코어 — 골 줄이 그 골 뒤의 스코어를 적는다 */
  const before = { ...pending.ledger.score };
  for (const ev of last.events) {
    if (ev.type === "goal" && ev.team) before[ev.team] -= 1;
  }
  return [
    buildSegmentMessage(last.events, last.stop, (id) => playerName(state, id), sideName, before),
  ];
}

/**
 * 판독기 한 호출의 사용자 층 — 때마다 무엇이 실리는가는 이 함수 하나가 정한다
 * (agents.md §3). 감독의 말은 맨 뒤 `@감독:` 한 줄이다.
 */
export function buildReaderInput(
  state: GameState,
  options: {
    occasion: ReadingOccasion;
    said?: string;
    boardMoves?: readonly BoardMove[];
  },
): string {
  const matchLog = buildMatchLogBlock(state);
  return [
    buildLedgerNote(state),
    ...buildFactsBlock(state),
    ...buildPointsBlock(state),
    ...(options.occasion === "segment" ? buildSegmentBlock(state) : []),
    ...(options.occasion === "kickoff"
      ? tagged("pre_match", stripTag(buildMatchBrief(state)))
      : []),
    ...(matchLog.length > 0 ? [matchLog] : []),
    ...buildBoardMovesBlock(state, options.boardMoves ?? []),
    ...(options.said ? [``, `@감독: ${options.said}`] : []),
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/** `<pre_match>` 안쪽만 — 블록을 세우는 자리는 `tagged` 하나다 */
function stripTag(block: string): string {
  return block
    .split("\n")
    .filter((line) => !line.startsWith("<"))
    .join("\n");
}

// ── 호출 ─────────────────────────────────────────────────

/**
 * 경기를 읽는다 — **킥오프 · 지시 턴 · 구간 뒤** (agents.md §3).
 *
 * 산출 없이 두 번 실패하면 `ok: false`다. 그 뒤가 때마다 갈린다: 지시 턴은 도구가
 * 반려로 답하고, 구간 뒤는 삼켜 지난 시트가 남고, 킥오프는 빈 포인트로 시작한다 —
 * 그 판정은 부르는 쪽이 한다. 여기서 하는 일은 한 번 다시 부르고 그 사실을 기록에
 * 남기는 것까지다 (models.md §5).
 */
export async function runMatchReader(
  state: GameState,
  specs: ReadonlyMap<string, GameToolSpec>,
  options: {
    occasion: ReadingOccasion;
    /** 이번 턴 감독의 말 — 지시 턴에만 선다 */
    said?: string;
    /** 이번 턴 전술판이 이미 움직인 것 — 되풀이를 가릴 근거다 */
    boardMoves?: readonly BoardMove[];
    llm?: GameLLM;
  },
): Promise<{ ok: true; reading: MatchReaderOutput } | { ok: false; message: string }> {
  const { occasion } = options;
  let reading: MatchReaderOutput | null = null;
  let client = options.llm ?? mockReaderLlm(state, options);
  let attempts = 0;
  const user = buildReaderInput(state, options);
  const schema = matchReaderOutputSchema(specs);
  const record = (rest: { ok: boolean; failure?: string }): void =>
    journal({
      kind: "match.reading",
      occasion,
      points: reading?.points ?? [],
      sheet: reading?.sheet ?? [],
      retried: attempts > 1,
      ...rest,
    });
  try {
    await retryOnce(
      "match-reader",
      async () => {
        attempts += 1;
        client ??= createGameLLM(agentConfig("match-reader"));
        const result = await client.runTurn({
          system: MATCH_READER_SYSTEM,
          history: [],
          user,
          outputSchema: schema,
        });
        const report = readOutput("match-reader", ReaderReportSchema, result);
        const { ops, truncated } = parseOps(report.ops, MATCH_OPS, TACTIC_CAPS);
        reading = {
          ops,
          ...(Object.keys(truncated).length > 0 ? { truncated } : {}),
          points: report.points ?? [],
          sheet: report.sheet ?? [],
          ...(report.unresolved ? { unresolved: report.unresolved } : {}),
        };
      },
      () => reading !== null,
    );
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    if (reading === null && !(error instanceof ModelOutputError)) {
      record({ ok: false, failure });
      throw error;
    }
    console.warn(`[match-reader] 판독 호출이 실패했습니다:`, error);
    if (reading === null) {
      record({ ok: false, failure });
      return { ok: false, message: FAILED_NOTE };
    }
  }
  if (reading === null) {
    record({ ok: false });
    return { ok: false, message: FAILED_NOTE };
  }
  record({ ok: true });
  return { ok: true, reading };
}

/** 판독이 오지 않은 자리의 한 줄 — 문구는 여기 하나다 */
export const FAILED_NOTE = "경기를 읽지 못했습니다 — 다시 말씀해 주세요";
