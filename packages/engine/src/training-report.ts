import type { AttributeAxis, TrainAttr } from "@story-fm/domain";
import {
  ATTRIBUTE_AXES,
  AXIS_KO,
  ageOf,
  applyFamiliarityGain,
  naturalPositionOf,
  tacticalUptake,
} from "@story-fm/domain";
import { attributeDeclineScale, attributeGainScale } from "./attributes";
import { seasonRating } from "@story-fm/domain";
import { setPlayerPosition } from "./skills";
import {
  assignmentsOf,
  playerById,
  proficiencyAt,
  recomputeOverall,
  recordGrowth,
  seasonStatOf,
  squadLevelOf,
  teamName,
} from "./state";

/**
 * 전향 훈련이 한 결산에서 올릴 수 있는 최대 폭.
 * 경기 한 번이 +1이니 며칠치 훈련이 그보다 크게 오르지 않는다.
 */
export const POSITION_TRAIN_MAX = 2;

/** 이번 시즌 기록 — 훈련장 밖의 맥락 */
function statOf(state: GameState, playerId: string) {
  return seasonStatOf(state, playerId);
}
function ratingOf(state: GameState, playerId: string): number | null {
  const stat = seasonStatOf(state, playerId);
  return stat ? seasonRating(stat) : null;
}
import type { GameState } from "./state";

/**
 * 훈련 결산 — **코어가 앵커를 박고, LLM이 한 구간을 읽어 다듬는다.**
 *
 * `advance_time`은 하루가 아니라 **여러 날**을 넘긴다. 그 사이 훈련은 tick이 조용히
 * 소화하는데, 그러면 감독이 "그동안 훈련장에서 무슨 일이 있었나"를 알 길이 없고
 * 수치도 전원 같은 공식으로만 움직인다. 그래서 지나간 훈련을 **한 묶음으로** 모아
 * 한 번만 판정한다 — 세션마다 부르면 볼 거리도 없고 비용만 늘어난다.
 *
 * 판정에 쓰는 티어는 `chore`다. 자주 도는 일이라 싼 모델을 쓴다 (economy.md §2).
 *
 * ⚠️ **한 번에 게임을 크게 흔들면 안 된다.** 이 이벤트는 시즌에 수십 번 돈다.
 * 그래서 상한을 세 겹으로 둔다:
 *   ① 선수별 전술 적응도는 코어 앵커에서 ±`TACTIC_BAND`
 *   ② 한 구간에서 오르는 전술 적응도는 선수당 `TACTIC_WINDOW_CAP`까지
 *   ③ 능력치는 **구간당 `TRAINING_ATTR_CAP`명, 각 한 축 ±1**이 끝이다
 *      (그것도 그 구간에 실제로 훈련한 축만, 잠재력 상한 안에서)
 *
 * 판정이 실패하면(모델 오류·검증 탈락·mock 모드) 아무것도 하지 않는다 — tick이
 * 이미 앵커를 반영해 뒀으므로 훈련은 언제나 완결된다.
 */

/**
 * 한 구간의 훈련이 전술 적응도에 남기는 폭 — **−1 ~ 3 중 하나**.
 *
 * 눈금을 잘게 두는 이유는 빈도다. `advance_time`은 시즌에 수십 번 돌고, 한 번에 크게
 * 움직일 수 있으면 진행을 잘게 쪼개는 것만으로 적응도를 불릴 수 있다. **−1**을 둔 건
 * 훈련이 늘 남기는 건 아니기 때문이다 — 지친 선수를 굴리면 오히려 흐트러진다.
 */
export const TACTIC_GAIN_MIN = -1;
export const TACTIC_GAIN_MAX = 3;
/**
 * 능력치가 한 번에 움직이는 폭 — **−1 ~ +1**.
 *
 * 오르기만 하는 능력치는 없다. 서른을 넘긴 선수의 스피드는 훈련해도 내려가고,
 * 몇 주를 통째로 쉰 선수의 지구력도 그렇다. 그 판단을 결산이 한다.
 */
export const ATTR_STEP_MIN = -1;
export const ATTR_STEP_MAX = 1;

/**
 * 한 판정에서 능력치가 움직일 수 있는 **인원** 상한.
 *
 * 경기가 훨씬 넉넉한 이유는 하나다 — 90분은 열한 명 모두에게 무언가를 남긴다.
 * 훈련 며칠은 그렇지 않아서, 아무에게도 남지 않는 구간이 정상이다.
 */
export const TRAINING_ATTR_CAP = 5;
export const MATCH_ATTR_CAP = 11;

/** 이 구간에 소화된 훈련 세션 하나 */
export interface TrainedSession {
  /** 일정 축의 엔트리 id — 성장 로그가 출처를 가리킬 수 있게 */
  entryId: string;
  date: string;
  slot: "am" | "pm";
  label: string;
  focus: TrainAttr[];
  /** 감독이 직접 지시한 세션인가 — 기본 훈련과 구분해 판정 근거로 준다 */
  ordered: boolean;
}

/** 판정에 넘길 선수 한 명 */
export interface TrainingSubject {
  playerId: string;
  name: string;
  age: number;
  position: string;
  familiarity: number;
  condition: number;
  /** 폼 −1~1 — 지금 올라와 있나 */
  form: number;
  /** 잠재력까지 남은 여유 (overall 기준). 클수록 자랄 자리가 있다 */
  room: number;
  overall: number;
  /** 이번 시즌 출전·평점 — 훈련장 밖에서 무엇을 겪고 있나 */
  apps: number;
  rating: number | null;
  /** 감독이 걸어 둔 개인 지시 (없으면 null) */
  instruction: string | null;
  /**
   * 감독이 이 선수에게 건 **개인 훈련** (없으면 null).
   * `position`이 있으면 그 자리를 배우는 중이라 결산이 적응도를 움직일 수 있다.
   */
  program: { axis?: string; position?: string } | null;
}

/** 한 구간의 훈련 결산 브리프 — LLM 입력의 원본 */
export interface TrainingBrief {
  teamName: string;
  from: string;
  to: string;
  sessions: TrainedSession[];
  subjects: TrainingSubject[];
  /** 이 기간 감독과 나눈 대화 (최근 것부터 잘라 넣는다) */
  chat: Array<{ at: string; role: "user" | "model"; text: string }>;
  /** 이 구간에 훈련한 능력치 축 — 능력치 성장은 여기 있는 축만 허용된다 */
  trainedAxes: AttributeAxis[];
}

/** LLM이 돌려주는 선수 한 명의 결과 */
export interface TrainingOutcome {
  playerId: string;
  /** 이 구간의 전술 적응도 변화 — −1~3. 밖은 코어가 잘라 낸다 */
  tacticGain: number;
  /** 이 구간에 움직일 축 하나. 없으면 null */
  attribute: AttributeAxis | null;
  /** 그 축의 방향 — −1 또는 +1 */
  attributeStep?: number | null;
  /**
   * 배우는 자리의 적응도 변화 — **개인 훈련에 `position`이 걸린 선수만.**
   * 0~2로 가둔다. 자리는 커리어가 만드는 것이라 경기 한 번(+1)보다 크게 오르지
   * 않고, 훈련만으로 하루아침에 전향되지 않는다.
   */
  positionGain?: number | null;
  /** 한 줄 근거 — 감독이 읽는다 */
  note: string;
  /**
   * 이 변화가 나온 **훈련 날짜** — 목록의 세션 중 하나.
   *
   * 없거나 그 구간 밖이면 마지막 세션 날짜로 떨어진다. 이게 없으면 일주일치 훈련
   * 결과가 **판정을 돌린 하루에** 통째로 찍혀, 달력에서 "언제 뭐가 붙었나"를 볼 수 없다.
   */
  date?: string;
}

const CHAT_KEEP = 12;
const NOTE_MAX = 60;

/** 이 구간에 훈련한 능력치 축 (tactical·recovery는 능력치가 아니다) */
function axesOf(sessions: TrainedSession[]): AttributeAxis[] {
  const set = new Set<AttributeAxis>();
  for (const s of sessions) {
    for (const f of s.focus) {
      if ((ATTRIBUTE_AXES as readonly string[]).includes(f)) set.add(f as AttributeAxis);
    }
  }
  return [...set];
}

/** 결산 브리프를 짓는다 — 없으면 null (훈련이 없었던 구간) */
export function buildTrainingBrief(
  state: GameState,
  sessions: TrainedSession[],
  window: { from: string; to: string },
): TrainingBrief | null {
  if (sessions.length === 0) return null;
  const assignments = new Map(
    assignmentsOf(state, state.userTeamId).map((a) => [a.playerId, a] as const),
  );
  const subjects: TrainingSubject[] = [];
  for (const player of state.players) {
    if (player.teamId !== state.userTeamId || squadLevelOf(player) !== "first") continue;
    const assignment = assignments.get(player.id);
    const program = state.playerTraining.find((t) => t.gamePlayerId === player.id);
    subjects.push({
      program: program
        ? {
            ...(program.axis ? { axis: program.axis } : {}),
            ...(program.position ? { position: program.position } : {}),
          }
        : null,
      playerId: player.id,
      name: player.name,
      age: ageOf(player.birthdate, state.date),
      position: assignment?.position ?? player.positions[0]?.position ?? "?",
      familiarity: assignment?.familiarity ?? 0,
      condition: player.state.condition,
      form: Math.round(player.state.form * 100) / 100,
      room: Math.max(0, player.attributes.potential - player.attributes.overall),
      overall: player.attributes.overall,
      apps: statOf(state, player.id)?.apps ?? 0,
      rating: ratingOf(state, player.id),
      instruction: assignment?.instruction ?? null,
    });
  }
  if (subjects.length === 0) return null;

  return {
    teamName: teamName(state.userTeamId),
    from: window.from,
    to: window.to,
    sessions,
    subjects,
    /**
     * 이 구간의 대화 — 판정자가 "감독이 무엇을 주문했나"를 읽는 자리다.
     * **화면 조작(`operator`)은 뺀다** — 시간 이동 손잡이는 감독의 말이 아니라
     * 훈련 의도와 아무 상관이 없는데, 섞이면 판정자가 그것도 지시로 읽는다.
     */
    chat: state.chat
      .filter((t) => t.at >= window.from && t.role !== "operator")
      .slice(-CHAT_KEEP)
      .map((t) => ({ at: t.at, role: t.role as "user" | "model", text: t.text.slice(0, 400) })),
    trainedAxes: axesOf(sessions),
  };
}

/**
 * 판정을 장부에 반영한다 — **검증은 여기서만** 한다.
 *
 * 모델이 무엇을 돌려주든 이 함수를 통과한 것만 게임 상태가 된다 (AGENTS.md 6-7).
 * 밴드 밖의 값, 훈련하지 않은 축, 잠재력을 넘는 성장, 팀 총량 초과는 조용히 잘린다.
 *
 * @returns 감독에게 보여줄 요약 줄
 */
export function applyTrainingOutcomes(
  state: GameState,
  brief: TrainingBrief,
  outcomes: readonly TrainingOutcome[],
): string[] {
  /**
   * 판정이 가리킨 훈련 날짜 → 그 세션 (없으면 마지막 세션).
   * 하루에 두 세션이면 **먼저 있던 쪽**(오전)에 붙인다 — 판정은 날짜까지만 답한다.
   */
  const sessionsByDate = new Map<string, TrainedSession>();
  for (const s of brief.sessions) if (!sessionsByDate.has(s.date)) sessionsByDate.set(s.date, s);
  const fallback = brief.sessions[brief.sessions.length - 1]!;
  const sessionFor = (date?: string) => (date && sessionsByDate.get(date)) || fallback;
  const assignments = new Map(
    assignmentsOf(state, state.userTeamId).map((a) => [a.playerId, a] as const),
  );
  const allowed = new Set(brief.trainedAxes);
  const subjects = new Map(brief.subjects.map((s) => [s.playerId, s] as const));
  const lines: string[] = [];
  let attrSpent = 0;

  for (const outcome of outcomes) {
    const subject = subjects.get(outcome.playerId);
    const player = playerById(state, outcome.playerId);
    if (!subject || !player) continue; // 명단 밖 선수는 무시한다

    // ① 전술 적응도 — **여기가 유일한 변화 경로다.** 코어는 훈련 중에 아무것도
    //    올리지 않았다. 얼마나 스몄는지는 이 판정이 정하고, 코어는 −1~3으로 가둔다.
    const assignment = assignments.get(outcome.playerId);
    // 이 변화가 나온 훈련 날짜 — 판정이 가리킨 세션 (없으면 마지막)
    const session = sessionFor(outcome.date);
    if (assignment) {
      const gain = clampGain(outcome.tacticGain);
      if (gain !== 0) {
        const before = assignment.familiarity;
        // 상승은 **위로 갈수록 깎이고, 잘 읽는 선수가 더 가져간다** — 소수로 쌓인다
        assignment.familiarity = applyFamiliarityGain(
          before,
          gain,
          "training",
          tacticalUptake(player.attributes),
        );
        // 장부·요약은 **눈금이 실제로 넘어갔을 때만** 남긴다 (성장 로그는 정수다).
        // 87.4 → 87.7은 감독의 화면에서 아무 일도 아니므로 일지에도 없다
        const moved = Math.round(assignment.familiarity) - Math.round(before);
        if (moved !== 0) {
          recordGrowth(
            state,
            player.id,
            session.entryId,
            "training",
            "tactical",
            moved,
            "훈련 결산",
            session.date,
          );
          lines.push(`${player.name} 전술 ${moved > 0 ? "+" : ""}${moved}`);
        }
      }
    }

    // ② 자리 — **개인 훈련으로 배우는 중일 때만.** 코어가 날짜를 세어 올리던
    //    자리를 결산에 넘겼다: 전술 적응도·능력치와 같은 눈으로 판정한다.
    const program = state.playerTraining.find((t) => t.gamePlayerId === player.id);
    if (program?.position && outcome.positionGain) {
      const gain = Math.max(0, Math.min(POSITION_TRAIN_MAX, Math.round(outcome.positionGain)));
      if (gain > 0) {
        const slot = player.positions.find((x) => x.position === program.position);
        if (!slot) {
          player.positions.push({
            position: program.position,
            proficiency: Math.min(99, proficiencyAt(player, program.position) + gain),
            isNatural: false,
          });
        } else if (slot.proficiency < 99) {
          slot.proficiency = Math.min(99, slot.proficiency + gain);
        }
        recordGrowth(
          state,
          player.id,
          session.entryId,
          "training",
          `pos:${program.position}`,
          gain,
          "전향 훈련",
          session.date,
        );
        lines.push(`${player.name} ${program.position} 적응 +${gain}`);
        // 새 자리가 본업을 넘어서면 전향이 끝난 것이다 (장부 정리는 코어 몫)
        const natural = naturalPositionOf(player);
        const learned = player.positions.find((x) => x.position === program.position);
        if (
          learned &&
          learned.proficiency > natural.proficiency &&
          natural.position !== learned.position
        ) {
          setPlayerPosition(state, { playerId: player.id, position: learned.position });
          state.playerTraining = state.playerTraining.filter((t) => t.gamePlayerId !== player.id);
          lines.push(`${player.name} 전향 완료 — 이제 ${learned.position}가 본업이다`);
        }
      }
    }

    // ③ 능력치 — 그 구간에 훈련한 축만 (공용 규칙)
    const moved = applyAttributeStep(state, player, outcome.attribute, outcome.attributeStep, {
      allowed,
      spent: attrSpent,
      cap: TRAINING_ATTR_CAP,
      source: "training",
      note: "훈련 결산",
      entryId: session.entryId,
      on: session.date,
    });
    if (moved) {
      attrSpent += 1;
      const sign = moved.step > 0 ? "+" : "−";
      lines.push(
        `${player.name} ${AXIS_KO[moved.axis]} ${sign}1 → ${moved.value} — ${trim(outcome.note)}`,
      );
    }
  }
  return lines;
}

/**
 * 능력치를 한 칸 움직인다 — **훈련 결산과 경기 결산이 같은 규칙을 쓴다.**
 *
 * 어느 판정이든 한 번에 움직이는 건 **한 축 ±1**이고, 인원 상한과 잠재력 상한을
 * 넘지 못한다. 규칙을 두 곳에 복제하면 한쪽만 조여지고 다른 쪽이 샌다.
 *
 * **잠재력은 오를 때만 막는다.** 내려가는 데는 천장이 무의미하고(이미 넘은 선수도
 * 늙는다), 대신 1 아래로는 안 내려간다.
 *
 * @param allowed 허용 축 (훈련은 그 구간에 훈련한 축만, 경기는 제한 없음 → null)
 * @returns 실제로 움직인 축·방향·결과값, 못 움직였으면 null
 */
export function applyAttributeStep(
  state: GameState,
  player: {
    id: string;
    name: string;
    birthdate?: string;
    attributes: Record<string, number> & { potential: number };
    growthCarry?: Record<string, number>;
  },
  axis: AttributeAxis | null,
  step: number | null | undefined,
  opts: {
    allowed: ReadonlySet<AttributeAxis> | null;
    spent: number;
    cap: number;
    source: "training" | "match";
    note: string;
    /** 출처 일정·날짜 — 결산은 지나간 훈련 날짜를 가리킨다 */
    entryId?: string;
    on?: string;
  },
): { axis: AttributeAxis; step: number; value: number } | null {
  if (!axis) return null;
  if (opts.allowed && !opts.allowed.has(axis)) return null;
  if (opts.spent >= opts.cap) return null;
  const raw = typeof step === "number" && Number.isFinite(step) ? Math.round(step) : 1;
  const move = Math.max(ATTR_STEP_MIN, Math.min(ATTR_STEP_MAX, raw));
  if (move === 0) return null;

  const attrs = player.attributes as unknown as Record<string, number>;
  const value = attrs[axis] ?? 0;
  if (move > 0 && (value >= player.attributes.potential || value >= 99)) return null;
  if (move < 0 && value <= 1) return null;

  /**
   * 판정이 "한 칸"이라고 해도 그대로 오르지는 않는다 — 잠재력 여유·나이·현재
   * 수준이 정한 만큼만 남고, 못 채운 몫은 `growthCarry`에 쌓인다. 이게 없으면
   * 서른의 주전은 아무리 훈련해도 그대로이고(곡선이 늘 1보다 작다) 열여덟은
   * 판정 한 번에 한 칸씩 오른다.
   */
  const age = player.birthdate !== undefined ? ageOf(player.birthdate, state.date) : 24;
  const scale =
    move > 0
      ? attributeGainScale(axis, value, player.attributes.potential, age)
      : attributeDeclineScale(axis, age);
  if (scale <= 0) return null;

  const carry = (player.growthCarry?.[axis] ?? 0) + move * scale;
  // 한 칸을 채웠나 — 0 쪽으로 자른다(−0.7은 아직 −1이 아니다)
  const whole = Math.trunc(carry);
  if (whole === 0) {
    player.growthCarry = { ...(player.growthCarry ?? {}), [axis]: carry };
    return null;
  }

  // 한 번에 한 칸까지만 — 캐리가 밀려 있어도 장부가 갑자기 두 칸 뛰지 않는다
  const applied = Math.sign(whole);
  player.growthCarry = { ...(player.growthCarry ?? {}), [axis]: carry - applied };

  attrs[axis] = value + applied;
  recomputeOverall(player as never);
  recordGrowth(
    state,
    player.id,
    opts.entryId ?? null,
    opts.source,
    axis,
    applied,
    opts.note,
    opts.on,
  );
  return { axis, step: applied, value: attrs[axis]! };
}

/** 판정값을 −1~3으로 접는다 — 값이 없거나 숫자가 아니면 0 */
function clampGain(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(TACTIC_GAIN_MIN, Math.min(TACTIC_GAIN_MAX, Math.round(value)));
}

function trim(note: string): string {
  const clean = note.replace(/\s+/g, " ").trim();
  return clean.length > NOTE_MAX ? `${clean.slice(0, NOTE_MAX)}…` : clean;
}
