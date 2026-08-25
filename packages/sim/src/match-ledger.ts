import type { MatchEvent, MatchPhase, MatchSide, MatchStatLine } from "@story-fm/domain";
import { PHASE_END, TEAM_EVENT_TYPES, isExtraTime } from "@story-fm/domain";

/**
 * 경기 장부 — 사건을 검증해 기록하는 결정적 코어 (match.md §5).
 *
 * **사건을 만드는 쪽도 코어다**(`match-engine.ts` 구간 시뮬 · 엔진의 간이 시뮬).
 * 그래서 여기 검증은 LLM 방어가 아니라 **시뮬레이터의 계약 검사**이고, 반려는
 * 시뮬레이터의 버그를 뜻한다. LLM은 이 장부가 기록한 것을 중계·연출할 뿐이다.
 */

export interface TeamLedger {
  onPitch: string[];
  bench: string[];
  subsUsed: number;
  /** 교체 기회(창) — 같은 분(分)의 연속 교체는 한 창, 휴식 정지점은 창 미소모 */
  subWindows: number;
  lastSubMinute: number | null;
  /** 선수별 경고 수 — 경고 2회는 자동 퇴장 */
  yellows: Record<string, number>;
}

export interface MatchLedgerState {
  minute: number;
  phase: MatchPhase;
  score: { home: number; away: number };
  events: MatchEvent[];
  home: TeamLedger;
  away: TeamLedger;
  sentOff: string[];
  /**
   * 선수별 누적 기록 — **사건이 아닌 것들**(패스·전진 패스·슛·xg·선방).
   *
   * 골·도움·카드는 여기 없다: 사건 목록이 원본이고 두 벌로 두면 조용히 갈린다.
   * 옛 세이브엔 없다(optional) — 없으면 빈 것으로 읽는다.
   */
  stats?: Record<string, MatchStatLine>;
}

/** 빈 기록 한 줄 — 누적 기록의 출발점이 한 곳이어야 칸이 늘 때 갈리지 않는다 */
export function emptyStatLine(): MatchStatLine {
  return {
    passes: 0,
    progressive: 0,
    shots: 0,
    xg: 0,
    scoringExpectation: 0,
    saves: 0,
    corners: 0,
    fouls: 0,
  };
}

/** 구간이 만든 증가분을 장부에 더한다 — 패스는 사건이 아니므로 이 경로로만 쌓인다 */
export function addStats(
  state: MatchLedgerState,
  add: Record<string, MatchStatLine>,
): MatchLedgerState {
  const stats = { ...(state.stats ?? {}) };
  for (const [id, line] of Object.entries(add)) {
    const before = stats[id] ?? emptyStatLine();
    stats[id] = {
      passes: before.passes + line.passes,
      progressive: before.progressive + line.progressive,
      shots: before.shots + line.shots,
      xg: round2(before.xg + line.xg),
      scoringExpectation: round2((before.scoringExpectation ?? 0) + line.scoringExpectation),
      saves: before.saves + line.saves,
      // 옛 세이브의 줄에는 없는 칸이라 0으로 읽는다 (SAVE_VERSION 유지)
      corners: (before.corners ?? 0) + line.corners,
      fouls: (before.fouls ?? 0) + line.fouls,
    };
  }
  return { ...state, stats };
}

/**
 * 시계만 앞으로 민다 — **사건 없이 흐른 구간의 유일한 경로.**
 *
 * 사건 배치는 빈 배열을 반려한다(`applyEvents`): 기록 없이 시계를 미는 길이 열려
 * 있으면 한 턴에 경기 전체를 밀어붙일 수 있다. 그래서 정말로 아무 일도 없는
 * 구간 — 감독이 말만 건 1분 — 만 여기로 지난다. 스코어·명단·국면·사건은 그대로고
 * 시각만 올라가며, 역행은 무시한다(장부의 시간은 되감기지 않는다).
 */
export function advanceClock(state: MatchLedgerState, minute: number): MatchLedgerState {
  return minute <= state.minute ? state : { ...state, minute };
}

export type ApplyResult = { ok: true; state: MatchLedgerState } | { ok: false; errors: string[] };

/** 하드 상한 — 비상식 방지 (match.md §5) */
export const LEDGER_LIMITS = {
  maxEventsPerBatch: 20,
  maxSubs: 5,
  maxSubWindows: 3,
} as const;

/**
 * 연장에 얹히는 교체 — 실제 규정대로 **1명·1회**가 더 생긴다.
 *
 * 창(window)도 함께 늘려야 뜻이 있다: 명수만 늘리면 이미 세 번을 쓴 팀은
 * 그 한 장을 쓸 자리가 없다.
 */
export const EXTRA_TIME_SUBS = 1;

/** 한 선수가 이만큼 경고를 받으면 퇴장이다 */
const YELLOWS_TO_SEND_OFF = 2;

/** 장부 요약이 붙이는 최근 이벤트 수 — 프롬프트에 실리는 꼬리다 */
const LEDGER_RECENT_EVENTS = 8;

/** xG 는 소수 둘째 자리까지 — 장부에 쌓이는 값이라 자리수가 흔들리면 안 된다 */
const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * 이 국면의 교체 한도 — 90분은 5인/3회, 연장은 6인/4회.
 *
 * 장부 검증과 AI 판단(`planAiSubstitution`)이 **같은 함수**를 본다. 두 곳이 각자
 * 상수를 읽으면 AI가 쓸 수 있다고 여긴 교체를 장부가 반려해 경기가 멈춘다.
 */
export function subLimitsOf(phase: MatchPhase): { maxSubs: number; maxSubWindows: number } {
  const extra = isExtraTime(phase) ? EXTRA_TIME_SUBS : 0;
  return {
    maxSubs: LEDGER_LIMITS.maxSubs + extra,
    maxSubWindows: LEDGER_LIMITS.maxSubWindows + extra,
  };
}

/** 경기 시작 명단 — 전술 배치에서 조립해 넘긴다 (팀 엔티티가 라인업을 갖지 않는다) */
export interface LedgerSide {
  onPitch: string[];
  bench: string[];
}

export function createLedger(home: LedgerSide, away: LedgerSide): MatchLedgerState {
  const side = (t: LedgerSide): TeamLedger => ({
    onPitch: [...t.onPitch],
    bench: [...t.bench],
    subsUsed: 0,
    subWindows: 0,
    lastSubMinute: null,
    yellows: {},
  });
  return {
    minute: 0,
    phase: "first_half",
    score: { home: 0, away: 0 },
    events: [],
    home: side(home),
    away: side(away),
    sentOff: [],
  };
}

function deepClone(state: MatchLedgerState): MatchLedgerState {
  return structuredClone(state);
}

function label(i: number, ev: MatchEvent): string {
  return `이벤트 #${i + 1}(${ev.minute}′ ${ev.type})`;
}

/**
 * 경기가 멈춰 서는 사건 — 감독이 개입할 자리라 **여기서 배치가 끊긴다.**
 * 연장 개시도 같다: 90분이 끝난 그 자리에서 벤치가 판을 다시 짠다.
 */
const BREAK_KO: Record<string, string> = {
  half_time: "하프타임",
  extra_time_start: "연장 개시",
  extra_half_time: "연장 하프타임",
};
const BREAK_EVENTS: ReadonlySet<string> = new Set(Object.keys(BREAK_KO));

/**
 * 이 교체가 **휴식 정지점에 붙어 있는가** — 창 미소모의 판정 (match.md §5).
 *
 * 분으로 재면 안 된다: 정지 사건의 시각은 국면이 끝나는 분이고, 그 값이 조금만
 * 움직여도 "45′·46′면 면제"가 통째로 사라진다. 정지점 자체를 본다.
 *
 * 자리는 정지 사건의 **앞뒤 양쪽**이다 — 다음 배치에서 감독이 부르는 교체는 뒤에
 * 오고, 구간 시뮬이 정지 사건과 함께 올리는 AI 교체는 같은 배치의 앞에 온다
 * (`insertBeforeStop`). 경기가 재개되면 — 정지 사건 뒤에 교체가 아닌 사건이
 * 기록되거나 시계가 그 분을 지나면 — 다시 보통의 교체다.
 */
function atBreakStop(state: MatchLedgerState, incoming: MatchEvent[], i: number): boolean {
  const sub = incoming[i];
  if (!sub) return false;
  /** 교체를 건너뛰고 만나는 첫 사건 — 교체 여러 장은 한 정지점의 같은 자리다 */
  const around = (events: readonly MatchEvent[], from: number, step: number): MatchEvent | null => {
    for (let j = from; j >= 0 && j < events.length; j += step) {
      const found = events[j];
      if (!found || found.type === "substitution") continue;
      return found;
    }
    return null;
  };
  /** 그 정지 사건에 붙어 있는가 — 시계가 그 뒤로 움직였으면 경기가 재개된 것이다 */
  const attached = (event: MatchEvent | null) =>
    event !== null && BREAK_EVENTS.has(event.type) && event.minute === sub.minute;
  return (
    attached(around(incoming, i + 1, 1)) ||
    attached(around(state.events, state.events.length - 1, -1))
  );
}

/**
 * 이벤트 배치를 검증하며 적용한다 — 원자적: 하나라도 실패하면 전체 반려.
 * 오류 메시지는 한국어로 — 반려는 시뮬레이터의 계약 위반이라 사람이 읽는다.
 */
export function applyEvents(state: MatchLedgerState, incoming: MatchEvent[]): ApplyResult {
  if (incoming.length === 0) {
    return { ok: false, errors: ["빈 이벤트 배치 — 기록할 사건이 없습니다"] };
  }
  if (incoming.length > LEDGER_LIMITS.maxEventsPerBatch) {
    return {
      ok: false,
      errors: [`한 번에 최대 ${LEDGER_LIMITS.maxEventsPerBatch}개 이벤트만 기록할 수 있습니다`],
    };
  }
  if (state.phase === "finished") {
    return { ok: false, errors: ["경기가 이미 종료되었습니다 — 추가 기록 불가"] };
  }

  const next = deepClone(state);

  for (let i = 0; i < incoming.length; i++) {
    const raw = incoming[i];
    if (!raw) continue;
    const ev = sanitizeEvent(next, raw);
    // 휴식 시간은 강제 정지점 — 같은 배치에 그 이후 사건이 오면 반려
    // (한 턴에 경기 전체를 밀어붙이는 것을 코어가 막는다, overview §4)
    const prev = i > 0 ? incoming[i - 1] : null;
    if (prev && BREAK_EVENTS.has(prev.type)) {
      return {
        ok: false,
        errors: [
          `${label(i, ev)}: ${BREAK_KO[prev.type]}은(는) 정지점입니다 — 이후 사건은 다음 진행에서 기록하세요`,
        ],
      };
    }
    const err = applyOne(next, ev, i, atBreakStop(next, incoming, i));
    if (err) return { ok: false, errors: [err] };
    next.events.push(ev);
    next.minute = Math.max(next.minute, ev.minute);
  }
  return { ok: true, state: next };
}

function teamOf(state: MatchLedgerState, side: MatchSide): TeamLedger {
  return side === "home" ? state.home : state.away;
}

/**
 * 시뮬레이터 출력 다듬기 — **골을 도움 때문에 무효로 만들지 않는다.**
 *
 * goal의 actors는 [득점자, (도움)]이다. 득점자는 장부의 뼈대라 그라운드 위에
 * 없으면 반려하지만, 도움은 연출의 부산물이다. 중계가 벤치 선수나 상대 선수를
 * 도움으로 적었다고 골까지 반려하면, 이미 유저에게 서술된 득점이 장부에서만
 * 사라진다 — 그게 훨씬 나쁜 상태다. 그래서 못 믿을 도움은 조용히 떨군다
 * (AGENTS.md 6-7 안전장치: 검증 레이어가 흡수하고 규칙은 안 깨진다).
 */
function sanitizeEvent(state: MatchLedgerState, ev: MatchEvent): MatchEvent {
  if (ev.type !== "goal" || ev.actors.length <= 1 || !ev.team) return ev;
  const side = teamOf(state, ev.team);
  const scorer = ev.actors[0];
  if (scorer === undefined) return ev;
  const assist = ev.actors[1];
  const credible =
    assist !== undefined &&
    assist !== scorer &&
    side.onPitch.includes(assist) &&
    !state.sentOff.includes(assist);
  return { ...ev, actors: credible && assist !== undefined ? [scorer, assist] : [scorer] };
}

function applyOne(
  state: MatchLedgerState,
  ev: MatchEvent,
  i: number,
  /** 이 사건이 휴식 정지점에 붙어 있는가 — 교체의 창 미소모가 여기서 갈린다 */
  atBreak: boolean,
): string | null {
  // 공통: 시간 순증 + 종료 이후 금지
  if (state.phase === "finished") {
    return `${label(i, ev)}: 경기 종료(full_time) 이후의 이벤트는 기록할 수 없습니다`;
  }
  if (ev.minute < state.minute) {
    return `${label(i, ev)}: 시간 역행 — 현재 ${state.minute}′보다 이른 시각입니다`;
  }

  // 팀 귀속 요구
  if (TEAM_EVENT_TYPES.has(ev.type) && !ev.team) {
    return `${label(i, ev)}: 이 이벤트 타입은 team("home"|"away")이 필요합니다`;
  }

  const side = ev.team ? teamOf(state, ev.team) : null;

  const requireOnPitch = (playerId: string): string | null => {
    if (!side || !ev.team) return null;
    if (state.sentOff.includes(playerId)) {
      return `${label(i, ev)}: "${playerId}"는 퇴장당해 그라운드에 없습니다`;
    }
    if (!side.onPitch.includes(playerId)) {
      return `${label(i, ev)}: "${playerId}"는 ${ev.team} 팀의 그라운드 위 선수가 아닙니다`;
    }
    return null;
  };

  switch (ev.type) {
    case "kickoff": {
      if (state.events.some((e) => e.type === "kickoff")) {
        return `${label(i, ev)}: 킥오프는 이미 기록되었습니다`;
      }
      break;
    }

    case "goal": {
      if (!side || !ev.team) return `${label(i, ev)}: goal은 team이 필요합니다`;
      const scorer = ev.actors[0];
      if (!scorer) return `${label(i, ev)}: 득점자(actors[0])가 필요합니다`;
      for (const actor of ev.actors) {
        const err = requireOnPitch(actor);
        if (err) return err;
      }
      state.score[ev.team] += 1;
      break;
    }

    case "shot":
    case "save":
    case "chance":
    case "foul":
    case "injury": {
      for (const actor of ev.actors) {
        const err = requireOnPitch(actor);
        if (err) return err;
      }
      break;
    }

    case "yellow_card": {
      const player = ev.actors[0];
      if (!player) return `${label(i, ev)}: 경고 대상(actors[0])이 필요합니다`;
      const err = requireOnPitch(player);
      if (err) return err;
      if (!side) return `${label(i, ev)}: team이 필요합니다`;
      side.yellows[player] = (side.yellows[player] ?? 0) + 1;
      if ((side.yellows[player] ?? 0) >= YELLOWS_TO_SEND_OFF) {
        // 경고 누적 퇴장
        side.onPitch = side.onPitch.filter((id) => id !== player);
        state.sentOff.push(player);
      }
      break;
    }

    case "red_card": {
      const player = ev.actors[0];
      if (!player) return `${label(i, ev)}: 퇴장 대상(actors[0])이 필요합니다`;
      if (!side) return `${label(i, ev)}: team이 필요합니다`;
      /**
       * 경고 누적 퇴장은 **경고 한 줄 + 퇴장 한 줄**로 남는다 (match.md §5).
       * 앞줄의 두 번째 경고가 이미 그라운드에서 뺐으니 온필드를 요구하면 뒷줄이
       * 반려되고, 그러면 사건 목록에 `red_card`가 없어 출장 정지가 걸리지 않는다.
       * 통과는 **직전 줄이 이 선수의 경고일 때만** — 같은 퇴장에 레드가 두 줄
       * 남거나 퇴장 뒤의 사건이 끼어드는 길은 그대로 막혀 있다.
       */
      const last = state.events[state.events.length - 1];
      const afterSecondYellow =
        last?.type === "yellow_card" && last.actors[0] === player && state.sentOff.includes(player);
      if (afterSecondYellow) break;
      const err = requireOnPitch(player);
      if (err) return err;
      side.onPitch = side.onPitch.filter((id) => id !== player);
      state.sentOff.push(player);
      break;
    }

    case "substitution": {
      if (!side || !ev.team) return `${label(i, ev)}: substitution은 team이 필요합니다`;
      const [out, into] = ev.actors;
      if (!out || !into) {
        return `${label(i, ev)}: actors는 [나가는 선수, 들어오는 선수] 2명이어야 합니다`;
      }
      // 연장이면 한 장이 더 있다 (6인/4회) — 국면이 한도를 정한다
      const limits = subLimitsOf(state.phase);
      if (side.subsUsed >= limits.maxSubs) {
        return `${label(i, ev)}: 교체 ${limits.maxSubs}명 소진 — 더 교체할 수 없습니다`;
      }
      // 교체 기회(창) 검증 — 같은 분의 연속 교체는 한 창, 휴식 정지점은 미소모
      const opensNewWindow = !atBreak && side.lastSubMinute !== ev.minute;
      if (opensNewWindow && side.subWindows >= limits.maxSubWindows) {
        return `${label(i, ev)}: 교체 기회 ${limits.maxSubWindows}회 소진 (휴식 정지점 제외)`;
      }
      const outErr = requireOnPitch(out);
      if (outErr) return outErr;
      if (!side.bench.includes(into)) {
        return `${label(i, ev)}: "${into}"는 ${ev.team} 벤치에 없습니다`;
      }
      if (state.sentOff.includes(into)) {
        return `${label(i, ev)}: "${into}"는 퇴장당해 투입할 수 없습니다`;
      }
      side.onPitch = side.onPitch.filter((id) => id !== out).concat(into);
      side.bench = side.bench.filter((id) => id !== into);
      side.subsUsed += 1;
      if (opensNewWindow) side.subWindows += 1;
      // 휴식 정지점의 교체는 창을 열지 않았으므로 그 분을 남기지도 않는다 —
      // 남기면 경기 재개 뒤 같은 분의 첫 교체가 창 없이 지나간다
      if (!atBreak) side.lastSubMinute = ev.minute;
      break;
    }

    case "half_time": {
      if (state.phase !== "first_half") {
        return `${label(i, ev)}: 하프타임은 전반에만 올 수 있습니다 (현재 ${state.phase})`;
      }
      if (ev.minute < PHASE_END.first_half) {
        return `${label(i, ev)}: 하프타임은 ${PHASE_END.first_half}′ 이후여야 합니다`;
      }
      state.phase = "second_half";
      break;
    }

    /**
     * 연장 개시 — 90분이 끝났지만 경기는 끝나지 않았다.
     * `full_time` 자리를 대신 차지하므로 후반에서만 올 수 있다.
     */
    case "extra_time_start": {
      if (state.phase !== "second_half") {
        return `${label(i, ev)}: 연장은 후반이 끝난 뒤에만 시작합니다 (현재 ${state.phase})`;
      }
      if (ev.minute < PHASE_END.second_half) {
        return `${label(i, ev)}: 연장 개시는 ${PHASE_END.second_half}′ 이후여야 합니다`;
      }
      state.phase = "extra_first";
      break;
    }

    case "extra_half_time": {
      if (state.phase !== "extra_first") {
        return `${label(i, ev)}: 연장 하프타임은 연장 전반에만 올 수 있습니다 (현재 ${state.phase})`;
      }
      if (ev.minute < PHASE_END.extra_first) {
        return `${label(i, ev)}: 연장 하프타임은 ${PHASE_END.extra_first}′ 이후여야 합니다`;
      }
      state.phase = "extra_second";
      break;
    }

    case "full_time": {
      if (state.phase !== "second_half" && state.phase !== "extra_second") {
        return `${label(i, ev)}: 경기 종료는 후반 또는 연장 후반에만 올 수 있습니다 (현재 ${state.phase} — 먼저 half_time을 기록하세요)`;
      }
      // 연장을 치른 경기의 종료는 120′ 이후다
      const earliest = PHASE_END[state.phase];
      if (ev.minute < earliest) {
        return `${label(i, ev)}: 경기 종료는 ${earliest}′ 이후여야 합니다`;
      }
      state.phase = "finished";
      break;
    }
  }
  return null;
}

/** 국면의 한국어 이름 — 장부 요약이 읽는 이름이자 화면이 쓰는 이름과 같은 눈금 */
const PHASE_KO: Record<MatchPhase, string> = {
  first_half: "전반",
  second_half: "후반",
  extra_first: "연장 전반",
  extra_second: "연장 후반",
  finished: "경기 종료",
};

/** 장부 요약 — 매치 티어 LLM 컨텍스트용 한국어 스냅샷 (match.md §2) */
export function describeLedger(
  state: MatchLedgerState,
  names: { home: string; away: string },
): string {
  const phaseKo = PHASE_KO[state.phase] ?? "경기 종료";
  const limits = subLimitsOf(state.phase);
  const lines = [
    `[경기 장부] ${names.home} ${state.score.home} : ${state.score.away} ${names.away} — ${state.minute}′ (${phaseKo})`,
    `교체: 홈 ${state.home.subsUsed}/${limits.maxSubs}, 어웨이 ${state.away.subsUsed}/${limits.maxSubs}` +
      (state.sentOff.length > 0 ? ` · 퇴장: ${state.sentOff.join(", ")}` : ""),
  ];
  const recent = state.events.slice(-LEDGER_RECENT_EVENTS);
  if (recent.length > 0) {
    lines.push(
      "최근 이벤트: " +
        recent
          .map((e) => `${e.minute}′ ${e.type}${e.actors.length ? `(${e.actors.join("→")})` : ""}`)
          .join(", "),
    );
  }
  return lines.join("\n");
}
