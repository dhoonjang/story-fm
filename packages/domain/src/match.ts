import { z } from "zod";

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
  /**
   * **벤치가 판을 옮겼다** — AI 팀의 6축 이동·모양 전환 (match.md §2·§4).
   *
   * 선수의 사건이 아니라 팀의 판단이라 `actors`는 비어 있다. 근거 태그
   * (`source: "ai-shift"`) 하나가 갈래와 옮긴 뒤의 축 값, 갈아 낀 모양을 싣는다.
   */
  "tactical_shift",
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
  "tactical_shift",
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

/**
 * 벤치가 교체를 낸 이유 — **코드다.** 중계가 인용하는 문장은 이 코드를 읽는 쪽이
 * 만든다 (match.md §4).
 */
export const SubCauseSchema = z.enum(["injury", "chase", "hold", "fatigue"]);
export type SubCause = z.infer<typeof SubCauseSchema>;

/**
 * **사건의 원인** — 그 사건을 만든 행동의 사슬 (match.md §4 · live-match.md §9.1).
 *
 * 코어가 말의 규칙에서 뽑는 코드다. 문장은 읽는 쪽(중계·리포트·GM)이 렌더러 하나로
 * 만들고, 감독의 전술 XP는 `marking`(시트의 `behavior`가 걸린 말이 관여했다)에만 걸리므로
 * 검증 없는 자유 문자열을 두지 않는다. **목록은 한 벌이다** — 실시간 경기와 간이 시뮬이
 * 같은 코드를 쓴다.
 */
export const EVENT_CAUSE_CODES = [
  // ── 골·슛이 나온 길 ──
  /** 스루패스로 라인 뒤를 뚫었다 — [패서, 침투자] */
  "through_ball",
  /** 상대 진영에서 공을 뺏은 뒤 짧은 시간 안에 나왔다 — [뺏은 말] */
  "high_turnover",
  /** 공격 전환 중에 나왔다 */
  "counter",
  /** 크로스에서 나왔다 — [크로서] */
  "cross",
  /** 컷백 — 박스 옆에서 뒤로 내준 공 */
  "cutback",
  /** 코너·프리킥 전달에서 나왔다 — [키커] */
  "set_piece",
  /** 직접 프리킥 */
  "direct_free_kick",
  /** 페널티 */
  "penalty",
  /** 드리블로 수비를 제쳤다 — [제친 말, 제쳐진 말] */
  "individual",
  /** 나쁜 터치·패스 실수로 잃은 공에서 나왔다 — [실수한 말] */
  "error",
  /** 나온 골키퍼가 닿지 못했다 — [골키퍼] */
  "keeper_out",
  /** 긴 공을 공중볼로 따냈다 — [킥한 말, 따낸 말] */
  "long_ball",
  /** 헤더 */
  "header",
  /** 흘러나온 공을 다시 찼다 */
  "rebound",
  /** 시트의 `behavior`가 걸린 말이 관여했다 — `pointId`가 그 포인트 문장을 가리킨다 */
  "marking",
  // ── 파울·카드·부상의 성질 ──
  /** 역습을 끊은 파울 */
  "cynical_foul",
  /** 늦은 태클 */
  "late_tackle",
  /** 공중볼 경합에서의 접촉 */
  "aerial_contact",
  /** 붙어 선 수비가 잡아채거나 민 파울 */
  "holding",
  /** 두 번째 경고 */
  "second_yellow",
  /** 명백한 득점 기회 저지 */
  "dogso",
  /** 위험한 태클 */
  "reckless",
  /** 접촉 부상 — [다친 말, 접촉한 말] */
  "contact_injury",
  /** 스프린트 중 근육 부상 */
  "sprint_injury",
  // ── 벤치의 판단 (`tactical_shift`) — `values`가 옮긴 뒤의 축 값 ──
  "bench_chase",
  "bench_hold",
  "bench_counter",
  "bench_press",
] as const;
export const EventCauseCodeSchema = z.enum(EVENT_CAUSE_CODES);
export type EventCauseCode = z.infer<typeof EventCauseCodeSchema>;

export const EventCauseSchema = z.object({
  code: EventCauseCodeSchema,
  /** 이름이 서는 말들 — 코드마다 순서가 뜻을 갖는다 (위 주석) */
  playerIds: z.array(z.string()).default([]),
  /** 코드에 딸린 수치 — 벤치 전환의 축 값, 스루패스의 거리 같은 것 */
  values: z.record(z.string(), z.number()).optional(),
  /** `marking`이 인용하는 전술 포인트 */
  pointId: z.string().optional(),
  /** 코드에 딸린 낱말 하나 — 벤치 전환이 갈아 낀 모양(`4-2-3-1`) */
  note: z.string().optional(),
});
export type EventCause = z.infer<typeof EventCauseSchema>;

export const MatchEventSchema = z.object({
  /** 규정분 — 그 하프의 끝(45·90·105·120)을 넘지 않는다 */
  minute: z.number().int().min(0).max(MATCH_MINUTE_MAX),
  /**
   * **추가시간의 분** — 규정분이 그 하프의 끝일 때만 선다 (`45+2′`의 2).
   * 각 하프의 추가시간은 그 하프의 중단에서 계산한다 (live-match.md §1).
   */
  added: z.number().int().min(1).optional(),
  type: MatchEventTypeSchema,
  team: MatchSideSchema.optional(),
  /** 선수 id — substitution은 [나가는 선수, 들어오는 선수] 순서 */
  actors: z.array(z.string()).default([]),
  /** 원인 — 이 사건을 만든 행동의 사슬 (`EventCause`) */
  causes: z.array(EventCauseSchema).default([]),
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
   * 팀 단위 기대 득점(`homeExpectedGoals`)은 선수 기대치의 합이고, 이건 **실제로 만든 장면**의
   * 값이다. 둘을 견주면 "기회를 얼마나 만들었나"와 "그걸 얼마나 넣었나"가 갈린다 —
   * 0.08짜리를 넣은 경기와 0.6을 놓친 경기는 같은 스코어라도 다른 이야기다.
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
   * `shot`·`goal`에만 붙고, 없으면 `open`으로 읽는다.
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
  /** 막아선 골키퍼 id — 온필드에 골키퍼가 없으면(퇴장) 빈다 */
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
  /** 성공한 패스 — 성공률의 분자 */
  passesCompleted: z.number().int().min(0),
  /** 전진 패스 — 상대 골문 쪽으로 라인을 넘긴 패스 */
  progressive: z.number().int().min(0),
  /** 슛 수 (골 포함) — 사건에서도 세지만 여기 두면 한 번에 읽힌다 */
  shots: z.number().int().min(0),
  shotsOnTarget: z.number().int().min(0),
  /** 그 선수가 만든 기대 득점의 합 */
  xg: z.number().min(0),
  /** 실제 슈터의 결정력을 반영한 골 확률 합 */
  scoringExpectation: z.number().min(0),
  saves: z.number().int().min(0),
  /** 그 선수가 **찬 코너** — 얻는 것은 팀이지만 차는 것은 한 사람이다 */
  corners: z.number().int().min(0),
  /** 그 선수가 **범한 파울** */
  fouls: z.number().int().min(0),
  tackles: z.number().int().min(0),
  tacklesWon: z.number().int().min(0),
  interceptions: z.number().int().min(0),
  dribbles: z.number().int().min(0),
  dribblesWon: z.number().int().min(0),
  crosses: z.number().int().min(0),
  /** 공중볼 경합 승 */
  aerialsWon: z.number().int().min(0),
  /** 오프사이드에 걸린 수 */
  offsides: z.number().int().min(0),
  /** 뛴 거리 (m) · 고속 주행 19.8~25.2 km/h (m) · 스프린트 >25.2 km/h (m) · 스프린트 횟수 */
  distance: z.number().min(0),
  highSpeed: z.number().min(0),
  sprint: z.number().min(0),
  sprints: z.number().int().min(0),
});
export type MatchStatLine = z.infer<typeof MatchStatLineSchema>;

/** 정규 경기의 길이 — 출전 시간의 분모다 */
export const FULL_TIME_MINUTES = 90;
/** 연장까지 간 경기의 길이 */
export const EXTRA_TIME_FULL_MINUTES = 120;

/**
 * 한 경기의 **출전 시간** — 사건 목록이 원본이다.
 *
 * 교체의 [나가는 선수, 들어오는 선수] 짝과 **퇴장**이 같은 자격으로 시간을 끊는다 —
 * 퇴장을 세지 않으면 20′에 나간 선수도 90분으로 남는다.
 *
 * 규칙이 여기 한 벌만 있는 이유는 읽는 자리가 둘이기 때문이다: 진행 중인 장부를
 * 읽는 평점 브리프(`match-flow.ts`)와 끝난 경기의 결과를 읽는 리포트·MOTM
 * (`views.ts`). 두 벌로 두면 같은 선수의 출전 시간이 화면과 판정에서 갈린다.
 */
export function matchMinutesOf(
  events: readonly MatchEvent[],
  aet: boolean,
): (playerId: string) => number {
  const full = aet ? EXTRA_TIME_FULL_MINUTES : FULL_TIME_MINUTES;
  const wentOff = new Map<string, number>();
  const cameOn = new Map<string, number>();
  for (const e of events) {
    const [first, second] = e.actors;
    if (e.type === "substitution") {
      if (first) wentOff.set(first, Math.min(wentOff.get(first) ?? e.minute, e.minute));
      if (second) cameOn.set(second, e.minute);
    } else if (e.type === "red_card" && first) {
      wentOff.set(first, Math.min(wentOff.get(first) ?? e.minute, e.minute));
    }
  }
  return (playerId) => {
    const from = Math.min(cameOn.get(playerId) ?? 0, full);
    const to = Math.min(wentOff.get(playerId) ?? full, full);
    return Math.max(0, to - from);
  };
}

export const MatchPhaseSchema = z.enum([
  "first_half",
  "second_half",
  "extra_first",
  "extra_second",
  "finished",
]);
export type MatchPhase = z.infer<typeof MatchPhaseSchema>;

/** 공이 굴러가는 국면 — 종료를 뺀 넷 */
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
