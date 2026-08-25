import { z } from "zod";
import type { PacketTag } from "./packet";

export const MatchSideSchema = z.enum(["home", "away"]);
export type MatchSide = z.infer<typeof MatchSideSchema>;

/** 반대편 — 이득과 대가, 약점을 가진 쪽과 이로운 쪽을 뒤집는 자리가 하나여야 한다 */
export const otherSide = (side: MatchSide): MatchSide => (side === "home" ? "away" : "home");

/** 경기 이벤트 타입 — 코어(구간·간이 시뮬)가 만들고 코어 장부가 검증한다 (match.md §5) */
export const MatchEventTypeSchema = z.enum([
  "kickoff",
  "goal",
  "shot",
  "save",
  "chance",
  "foul",
  "yellow_card",
  "red_card",
  "substitution",
  "injury",
  "half_time",
  /**
   * **연장 개시** — 정규 90분이 끝났는데 승부가 남았다.
   *
   * `full_time`을 대신한다: 90분이 끝났다는 사실은 같지만 경기는 끝나지 않았다.
   * 녹아웃의 마지막 다리에서 합계가 같을 때만 기록되고, 그 판정은 코어가 한다
   * (`engine/competition/extra-time.ts`의 `needsExtraTime`).
   */
  "extra_time_start",
  /** 연장 전반 종료 — 하프타임과 같은 정지점이다 */
  "extra_half_time",
  "full_time",
]);
export type MatchEventType = z.infer<typeof MatchEventTypeSchema>;

/** 팀 귀속이 필요한 이벤트 타입 */
export const TEAM_EVENT_TYPES: ReadonlySet<MatchEventType> = new Set([
  "goal",
  "shot",
  "save",
  "chance",
  "foul",
  "yellow_card",
  "red_card",
  "substitution",
  "injury",
]);

/**
 * 이벤트 분의 상한 — 연장 끝(`PHASE_END.extra_second` 120′)에 추가시간 여유를 더한 값.
 * 장부가 받아들이는 마지막 분이지, 경기가 끝나는 분이 아니다.
 */
export const MATCH_MINUTE_MAX = 130;

/**
 * **슛의 출처** — 열린 플레이 · 코너 · 프리킥 · 페널티 (match.md §1.4).
 *
 * 죽은 공은 열린 플레이와 **같은 총량 안의 별도 채널**이라, 무엇이 그 슛을 만들었는지가
 * 슛마다 붙는다. 세트피스 득점 비율은 이 칸 하나로 세어진다.
 */
export const SHOT_ORIGINS = ["open", "corner", "free_kick", "penalty"] as const;
export const ShotOriginSchema = z.enum(SHOT_ORIGINS);
export type ShotOrigin = z.infer<typeof ShotOriginSchema>;

/** 죽은 공에서 나온 슛인가 — 세트피스 몫을 세는 자리가 하나여야 한다 */
export function isSetPieceOrigin(origin: ShotOrigin | undefined): boolean {
  return origin !== undefined && origin !== "open";
}

/**
 * 벤치가 교체를 낸 이유 — **코드다.** 중계가 인용하는 문장은 이 코드를 읽는 쪽이
 * 만든다 (match.md §4).
 */
export const SubCauseSchema = z.enum(["injury", "chase", "hold", "fatigue"]);
export type SubCause = z.infer<typeof SubCauseSchema>;

/**
 * 장부에 실리는 사실 태그의 Zod 판 — 모양은 `PacketTag`(packet.ts)와 같다.
 *
 * 패킷 자체는 세이브 스키마의 검사 밖이지만(진행 중인 경기 한 덩어리) 장부의
 * 사건은 스키마를 지나므로 여기에 한 벌이 있어야 한다.
 */
/**
 * 사실 태그의 갈래 — **목록은 한 벌이다.** Zod 판과 `PacketTag`(packet.ts)가 같은
 * 배열을 읽는다: 두 벌로 두면 갈래를 하나 늘린 날 스키마만 옛 목록으로 남는다.
 */
export const PACKET_TAG_SOURCES = [
  "counter",
  "gap",
  "mismatch",
  "zone-plan",
  "directive",
  "directive-dropped",
  "exploit",
  "exploit-dropped",
  "tactical",
  /** 죽은 공에서 나온 골 — 키커와 마무리한 선수를 함께 싣는다 (match.md §1.4) */
  "set-piece",
  /**
   * 전력에서 나오지 않는, **이 경기가 무슨 경기인가** — 더비가 첫 갈래다.
   * 편이 없고(`favours: null`) 이름은 카탈로그의 것이라 `text`가 든다 (match.md §1).
   */
  "context",
  /** 진행 중인 옛 세이브가 들고 있던 문장 — `text`만 갖는다 */
  "legacy",
] as const;
export type PacketTagSource = (typeof PACKET_TAG_SOURCES)[number];

export const PacketTagSchema = z.object({
  source: z.enum(PACKET_TAG_SOURCES),
  code: z.string().min(1),
  favours: MatchSideSchema.nullable(),
  /** 그 사실을 가진 쪽 — 미스매치만 싣는다. 없으면 이로운 편의 반대다 */
  holder: MatchSideSchema.optional(),
  sharp: z.boolean(),
  playerIds: z.array(z.string()).default([]),
  values: z.record(z.string(), z.number()).default({}),
  flags: z.array(z.string()).default([]),
  text: z.string().optional(),
});

/**
 * 옛 세이브의 문장 한 줄을 태그로 — **판정에는 쓰이지 않는 자리다.**
 *
 * 진행 중이던 경기의 장부와 패킷은 `causes: string[]`·`keyPoints: string[]`을 들고
 * 온다. 그 문장으로 다시 갈래를 가르면 이 구조가 뜻을 잃으므로, `code`는 통째로
 * `"legacy"` 하나이고 문장은 `text`에만 남는다 (match.md §4).
 */
export function legacyTag(text: string): PacketTag {
  return {
    source: "legacy",
    code: "legacy",
    favours: null,
    sharp: false,
    playerIds: [],
    values: {},
    flags: [],
    text,
  };
}

/**
 * 옛 장부의 원인 태그 — 문자열 배열이면 태그로 옮긴다.
 *
 * 진행 중이던 경기의 장부는 세이브 스키마의 검사 밖(passthrough)이라 옛 문장이
 * 그대로 실려 온다. 판정은 이 폴백을 보지 않지만(`subCause`와 태그의 코드로만
 * 갈린다) 문장을 만드는 렌더러가 태그를 기대하므로 읽는 자리에서 한 번 옮긴다.
 */
export function normalizeCauses(causes: (PacketTag | string)[]): PacketTag[] {
  if (!causes.some((c) => typeof c === "string")) return causes as PacketTag[];
  return causes.map((c) => (typeof c === "string" ? legacyTag(c) : c));
}

/** 문자열 한 줄로 적힌 옛 원인 태그를 읽을 때만 태그로 옮긴다 */
const CauseSchema = z.preprocess(
  (raw) => (typeof raw === "string" ? legacyTag(raw) : raw),
  PacketTagSchema,
);

export const MatchEventSchema = z.object({
  minute: z.number().int().min(0).max(MATCH_MINUTE_MAX),
  type: MatchEventTypeSchema,
  team: MatchSideSchema.optional(),
  /** 선수 id — substitution은 [나가는 선수, 들어오는 선수] 순서 */
  actors: z.array(z.string()).default([]),
  /**
   * 원인 태그 — 전력 분석 패킷 항목을 **그대로** 싣는다 (match.md §4).
   *
   * 감독의 전술 XP가 이 태그에 걸리므로 검증 없는 자유 문자열을 두지 않는다.
   * 진행 중인 옛 세이브의 장부는 문장 배열을 들고 있어, 읽을 때 `source: "legacy"`
   * 태그로 옮겨 본다.
   */
  causes: z.array(CauseSchema).default([]),
  /**
   * 교체의 **갈래** — 한 경기에 쓸 수 있는 승부수·굳히기 장수를 세고 부상 교체를
   * 먼저 세우는 것이 이 코드다. 근거 문구로 세던 자리라, 문구를 고치면 벤치의
   * 판단이 조용히 달라졌다 (match.md §4).
   */
  subCause: SubCauseSchema.optional(),
  detail: z.string().optional(),
  /**
   * **이 슛의 질** — 기대 득점 0~1. `shot`·`goal`에만 붙는다.
   *
   * 팀 단위 xg(`guide.expectedGoals`)는 경기 전 예측이고, 이건 **실제로 만든 장면**의
   * 값이다. 둘을 견주면 "기회를 얼마나 만들었나"와 "그걸 얼마나 넣었나"가 갈린다 —
   * 0.08짜리를 넣은 경기와 0.6을 놓친 경기는 같은 스코어라도 다른 이야기다.
   * 옛 세이브엔 없다 (optional).
   */
  xg: z.number().min(0).max(1).optional(),
  /** 결정력을 반영한 이 슛의 실제 골 확률. */
  goalProbability: z.number().min(0).max(1).optional(),
  /** 골도 독립 사건이 아니라 슈팅 결과다. */
  shotOutcome: z.enum(["goal", "saved", "blocked", "off_target"]).optional(),
  /**
   * **이 슛이 어디서 나왔나** — 열린 플레이인가 죽은 공인가 (match.md §1.4).
   *
   * 죽은 공을 사건으로 따로 적지 않는 이유는 §4의 원칙이다: 코너는 경기당
   * 스물한 개고 그것을 한 줄씩 적으면 구간 이벤트 상한에 훨씬 자주 닿아 벤치
   * 정지점과 교체 총량이 조용히 움직인다. 갈래는 **그 슛의 성질**이라 여기 산다.
   * 옛 세이브엔 없다 — 없으면 `open`으로 읽는다 (optional).
   */
  shotOrigin: ShotOriginSchema.optional(),
});
export type MatchEvent = z.infer<typeof MatchEventSchema>;

/**
 * **승부차기 한 발** — 코어가 굴리고 캐스터는 그것을 문장으로 옮긴다
 * (competition.md §6 · match.md §2).
 *
 * `MatchEvent`가 아닌 이유는 시계다: 장부의 사건은 분을 갖고 국면 안에 서지만
 * 승부차기는 120분이 끝난 뒤에 오고 분이라는 것이 없다. 그래서 결과에 매달린
 * 별도의 목록으로 남는다 (`MatchResult.penalties.kicks`).
 */
export const SHOOTOUT_OUTCOMES = ["scored", "saved", "missed"] as const;
export const ShootoutOutcomeSchema = z.enum(SHOOTOUT_OUTCOMES);
export type ShootoutOutcome = z.infer<typeof ShootoutOutcomeSchema>;

/** 정규 라운드 — 5킥씩 차고도 같으면 서든데스다 */
export const SHOOTOUT_ROUNDS = 5;

export const ShootoutKickSchema = z.object({
  /** 몇 번째 라운드인가 — 1부터. `SHOOTOUT_ROUNDS`를 넘으면 서든데스다 */
  round: z.number().int().min(1),
  team: MatchSideSchema,
  /** 찬 선수 id */
  taker: z.string().min(1),
  /** 막아선 골키퍼 id — 명단에 골키퍼가 없는 옛 세이브에서만 빈다 */
  keeper: z.string().min(1).optional(),
  outcome: ShootoutOutcomeSchema,
  /**
   * 이 킥의 성공 확률 — **"왜 그렇게 됐나"의 근거다** (설계 원칙 2).
   * 키커와 골키퍼의 기량이 만든 값이고, 중계·화면이 인용한다.
   */
  probability: z.number().min(0).max(1),
});
export type ShootoutKick = z.infer<typeof ShootoutKickSchema>;

/** 지금까지의 승부차기 합계 — 킥 목록이 원본이라 따로 세지 않는다 */
export function shootoutTally(kicks: readonly ShootoutKick[]): { home: number; away: number } {
  let home = 0;
  let away = 0;
  for (const kick of kicks) {
    if (kick.outcome !== "scored") continue;
    if (kick.team === "home") home += 1;
    else away += 1;
  }
  return { home, away };
}

/**
 * **승부가 갈렸는가** — 남은 킥으로 뒤집을 수 없으면 거기서 끝난다.
 *
 * 조기 확정의 규칙이 여기 한 벌만 있다: 코어가 킥을 굴릴 때도, 화면이 승부차기가
 * 끝났는지 물을 때도 이 함수를 읽는다. 5킥을 다 차기 전이면 **남은 킥 수**로 재고,
 * 다 찼으면 양 팀이 같은 수를 찬 자리에서만 갈린다(서든데스는 한 라운드가 통째로
 * 끝나야 판정한다).
 */
export function shootoutSettled(kicks: readonly ShootoutKick[]): boolean {
  const taken = {
    home: kicks.filter((k) => k.team === "home").length,
    away: kicks.filter((k) => k.team === "away").length,
  };
  const { home, away } = shootoutTally(kicks);
  const left = {
    home: Math.max(0, SHOOTOUT_ROUNDS - taken.home),
    away: Math.max(0, SHOOTOUT_ROUNDS - taken.away),
  };
  if (left.home > 0 || left.away > 0) {
    return home > away + left.away || away > home + left.home;
  }
  /**
   * 서든데스는 **한 라운드가 통째로 끝나야** 판정한다 — 남은 킥으로 재면 먼저 찬
   * 팀이 넣은 순간 갈렸다고 읽혀 상대가 차 보지도 못한다.
   */
  return taken.home === taken.away && home !== away;
}

/**
 * 다음에 차는 사람이 선 자리 — 갈렸으면 `null`.
 *
 * 순서는 먼저 차는 쪽(`first`)부터 한 발씩 번갈아 간다. 누가 먼저인지는 동전이
 * 정하므로(shootout.ts) 목록만으로는 알 수 없어 인자로 받는다.
 */
export function nextShootoutKick(
  kicks: readonly ShootoutKick[],
  first: MatchSide,
): { round: number; team: MatchSide } | null {
  if (shootoutSettled(kicks)) return null;
  const index = kicks.length;
  const other: MatchSide = first === "home" ? "away" : "home";
  return { round: Math.floor(index / 2) + 1, team: index % 2 === 0 ? first : other };
}

/**
 * 선수 한 명의 **경기 중 누적 기록** — 사건으로 두지 않는 것들.
 *
 * 패스는 한 경기에 900회쯤 오간다. 그걸 전부 `MatchEvent`로 만들면 장부가
 * 폭발하고(LLM 입력에도 못 들어간다) 정작 골·카드가 묻힌다. 그래서 **사건이 될
 * 만한 것만 사건**이고(골·슛·선방·카드), 흐름의 양은 구간마다 굴려 여기 쌓는다.
 *
 * 골·도움·카드는 여기 두지 않는다 — 사건 목록이 원본이고, 두 벌로 두면 갈린다.
 */
export const MatchStatLineSchema = z.object({
  passes: z.number().int().min(0),
  /** 전진 패스 — 상대 골문 쪽으로 라인을 넘긴 패스 */
  progressive: z.number().int().min(0),
  /** 슛 수 (골 포함) — 사건에서도 세지만 여기 두면 한 번에 읽힌다 */
  shots: z.number().int().min(0),
  /** 그 선수가 만든 기대 득점의 합 */
  xg: z.number().min(0),
  /** 실제 슈터의 결정력을 반영한 골 확률 합. 옛 세이브는 0으로 읽는다. */
  scoringExpectation: z.number().min(0).default(0),
  saves: z.number().int().min(0),
  /**
   * 그 선수가 **찬 코너** — 얻는 것은 팀이지만 차는 것은 한 사람이다.
   * 사건이 아니라 굴리지 않고 나누는 양이다 (match.md §4). 옛 세이브는 0.
   */
  corners: z.number().int().min(0).default(0),
  /** 그 선수가 **범한 파울** — 같은 자리. 옛 세이브는 0. */
  fouls: z.number().int().min(0).default(0),
});
export type MatchStatLine = z.infer<typeof MatchStatLineSchema>;

/**
 * 경기의 국면 — 시계가 어디에 있는가.
 *
 * 연장 두 하프가 뒤에 붙어도 **옛 세이브는 그대로 읽힌다**: enum에 값을 더하는 것은
 * 이미 저장된 값의 유효성을 건드리지 않는다 (SAVE_VERSION 유지).
 */
export const MatchPhaseSchema = z.enum([
  "first_half",
  "second_half",
  "extra_first",
  "extra_second",
  "finished",
]);
export type MatchPhase = z.infer<typeof MatchPhaseSchema>;

/** 공이 굴러가는 국면 — 종료를 뺀 넷. 구간 시뮬레이터가 이 표로 시계를 민다 */
export type PlayPhase = Exclude<MatchPhase, "finished">;

/** 각 국면이 끝나는 시각(추가시간 전) — 45 · 90 · 105 · 120 */
export const PHASE_END: Record<PlayPhase, number> = {
  first_half: 45,
  second_half: 90,
  extra_first: 105,
  extra_second: 120,
};

/** 각 국면이 시작하는 시각 */
export const PHASE_START: Record<PlayPhase, number> = {
  first_half: 0,
  second_half: 45,
  extra_first: 90,
  extra_second: 105,
};

/** 연장 국면인가 — 교체 한도·발생률이 여기서 갈린다 */
export function isExtraTime(phase: MatchPhase): boolean {
  return phase === "extra_first" || phase === "extra_second";
}
