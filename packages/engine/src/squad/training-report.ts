import type { AttributeAxis, TrainAttr } from "@story-fm/domain";
import {
  ATTRIBUTE_AXES,
  AXIS_KO,
  ageOf,
  applyFamiliarityGain,
  naturalPositionOf,
  tacticalUptake,
} from "@story-fm/domain";
import { attributeDeclineScale, attributeGainScale } from "../world/attributes";
import { seasonRating } from "@story-fm/domain";
import { grantManagerXP, setPlayerPosition } from "../skills";
import {
  assignmentsOf,
  isAvailable,
  playerById,
  proficiencyAt,
  recomputeOverall,
  recordGrowth,
  seasonStatOf,
  squadLevelOf,
  teamNameIn,
} from "../core/state";

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
import type { GameState } from "../core/state";

/**
 * 훈련 결산 — **코어가 앵커를 박고, LLM이 한 구간을 읽어 다듬는다.**
 *
 * `advance_time`은 하루가 아니라 **여러 날**을 넘긴다. 그 사이 훈련은 tick이 조용히
 * 소화하는데, 그러면 감독이 "그동안 훈련장에서 무슨 일이 있었나"를 알 길이 없고
 * 수치도 전원 같은 공식으로만 움직인다. 그래서 지나간 훈련을 **한 묶음으로** 모아
 * 한 번만 판정한다 — 세션마다 부르면 볼 거리도 없고 비용만 늘어난다.
 *
 * 자주 도는 일이라 싼 모델을 쓴다 (docs/llm/models.md).
 *
 * ⚠️ **한 번에 게임을 크게 흔들면 안 된다.** 이 이벤트는 시즌에 수십 번 돈다.
 * 그래서 상한을 세 겹으로 둔다:
 *   ① 선수별 전술 적응도는 `TACTIC_GAIN_MIN`~`TACTIC_GAIN_MAX`로 잘린다
 *   ② 그 위에 코어의 흡수율(`tacticalUptake`)이 곱해져 실제로 남는 양이 정해진다
 *   ③ 능력치는 **구간당 `trainingAttrCap()`명, 각 한 축 ±1**이 끝이다
 *      (그것도 그 구간에 실제로 훈련한 축 — 개인 훈련이 걸린 선수는 그 축까지 —
 *      만, 잠재력 상한 안에서)
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
 * 한 판정에서 능력치가 움직일 수 있는 **인원** — 감독의 훈련 축이 정한다.
 *
 * 경기가 훨씬 넉넉한 이유는 하나다 — 90분은 열한 명 모두에게 무언가를 남긴다.
 * 훈련 며칠은 그렇지 않아서, 아무에게도 남지 않는 구간이 정상이다.
 *
 * `TRAINING_ATTR_CAP`은 그중 **천장**이다 — 판정자에게 알리는 값이라 감독이
 * 도달할 수 있는 최대여야 한다. 실제 상한은 `trainingAttrCap()`이 잘라 준다.
 */
export const TRAINING_ATTR_CAP_MIN = 3;
export const TRAINING_ATTR_CAP = 6;
export const MATCH_ATTR_CAP = 11;

/** 감독 축의 0~99를 0~1로 — 축값은 도메인이 이미 0~99로 가둔다 */
function axisRatio(value: number): number {
  return Math.max(0, Math.min(99, value)) / 99;
}

/**
 * 훈련 축이 정하는 **흡수율** — 판정이 낸 폭 중 실제로 남는 비율 (0.75~1.00).
 *
 * ⚠️ **1을 넘지 않는다.** 감독이 판정 밴드(적응도 −1~3 · 능력치 ±1)를 뚫으면
 * "한 번에 게임을 크게 흔들지 않는다"는 결산의 계약이 흐려진다 — 좋은 감독은
 * 더 많이 얻는 쪽이 아니라 **덜 흘리는** 쪽이다.
 */
export const TRAINING_UPTAKE_FLOOR = 0.75;
export const TRAINING_UPTAKE_SPAN = 0.25;
export function managerTrainingUptake(training: number): number {
  return TRAINING_UPTAKE_FLOOR + axisRatio(training) * TRAINING_UPTAKE_SPAN;
}

/** 이 감독의 한 결산이 능력치를 움직일 수 있는 인원 — 3~6 */
export function trainingAttrCap(training: number): number {
  const span = TRAINING_ATTR_CAP - TRAINING_ATTR_CAP_MIN;
  return Math.max(
    TRAINING_ATTR_CAP_MIN,
    Math.min(TRAINING_ATTR_CAP, Math.round(TRAINING_ATTR_CAP_MIN + axisRatio(training) * span)),
  );
}

/**
 * 훈련 XP — **세션 하나당** 이만큼. 결산 횟수가 아니라 세션 수로 세는 것이
 * 핵심이다: `advance_time`을 하루씩 쪼개도 총 세션 수는 같아 XP를 불릴 수 없다.
 * 소수로 쌓이고 100에서 한 칸이 된다 (`grantManagerXP`).
 */
export const TRAINING_XP_PER_SESSION = 0.5;

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
   *
   * `position`이 있으면 그 자리를 배우는 중이라 결산이 적응도를 움직일 수 있고,
   * `axis`가 있으면 팀 세션이 그 축을 하지 않은 구간에도 **이 선수만** 그 축을
   * 가져갈 수 있다 (`allowedAxesFor`).
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
  /**
   * 이 구간에 훈련한 능력치 축 — 팀 세션의 축 + 대상들에게 걸린 개인 훈련 축.
   *
   * 판정자에게는 이 합집합을 후보로 보이고, **누가 어느 축을 가져갈 수 있는지는
   * 코어가 선수마다 다시 자른다** (`allowedAxesFor`) — 개인 훈련 축은 걸어 둔
   * 그 한 명에게만 열린다.
   */
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

/** 능력치 축인가 — 개인 훈련의 `axis`는 자유 문자열로 저장된다 */
function attributeAxis(value: string | undefined | null): AttributeAxis | null {
  if (!value) return null;
  return (ATTRIBUTE_AXES as readonly string[]).includes(value) ? (value as AttributeAxis) : null;
}

/** 팀 세션이 겨냥한 능력치 축 (tactical·recovery는 능력치가 아니다) */
function teamAxesOf(sessions: readonly TrainedSession[]): Set<AttributeAxis> {
  const set = new Set<AttributeAxis>();
  for (const s of sessions) {
    for (const f of s.focus) {
      const axis = attributeAxis(f);
      if (axis) set.add(axis);
    }
  }
  return set;
}

/**
 * 이 선수의 허용 축 — **팀 세션의 축 + 자기에게 걸린 개인 훈련 축.**
 *
 * 개인 훈련은 팀 메뉴 위에 한 명만 겨냥해 얹는 것이라(`set_player_training`),
 * 팀이 그 축을 하지 않은 구간에도 열려야 지시가 장부에 닿는다. 대신 **그 한
 * 명에게만** 연다 — 전원에게 열면 한 선수의 개인 훈련이 팀 전체의 성장 축을
 * 넓힌다 (docs/data/player.md §6.1).
 */
function allowedAxesFor(
  teamAxes: ReadonlySet<AttributeAxis>,
  personal: AttributeAxis | null,
): ReadonlySet<AttributeAxis> {
  return personal ? new Set([...teamAxes, personal]) : teamAxes;
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
  const axes = teamAxesOf(sessions);
  for (const player of state.players) {
    if (player.teamId !== state.userTeamId || squadLevelOf(player) !== "first") continue;
    /**
     * **못 뛰는 선수는 훈련도 함께하지 않았다** — 재활 중이거나 출장 정지인 선수를
     * 실으면 판정이 그 구간의 전술 적응도·능력치를 그대로 얹는다. 심경 결산도
     * 같은 선을 긋는다 (docs/data/player.md §6.1).
     */
    if (!isAvailable(state, player.id)) continue;
    const assignment = assignments.get(player.id);
    const program = state.playerTraining.find((t) => t.gamePlayerId === player.id);
    // 개인 훈련 축은 팀 세션에 없어도 그 선수의 허용 축이다 — 판정자에게도 알린다
    const personal = attributeAxis(program?.axis);
    if (personal) axes.add(personal);
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
    teamName: teamNameIn(state, state.userTeamId),
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
    trainedAxes: [...axes],
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
  // 팀 세션의 축 — 개인 훈련 축은 걸어 둔 선수에게만 얹는다 (`allowedAxesFor`)
  const teamAxes = teamAxesOf(brief.sessions);
  const subjects = new Map(brief.subjects.map((s) => [s.playerId, s] as const));
  const lines: string[] = [];
  let attrSpent = 0;
  // 감독의 훈련 축 — 흡수율과 인원 상한을 함께 정한다 (docs/simulation/career.md §2)
  const training = state.manager.attributes.training;
  const uptake = managerTrainingUptake(training);
  const attrCap = trainingAttrCap(training);

  for (const outcome of outcomes) {
    const subject = subjects.get(outcome.playerId);
    const player = playerById(state, outcome.playerId);
    if (!subject || !player) continue; // 명단 밖 선수는 무시한다
    /**
     * 판정을 받는 사이에 **팀을 떠난 선수**는 더 이상 우리 장부의 대상이 아니다.
     * 브리프는 구간이 끝난 자리에서 짓지만 판정은 그 뒤에 돌아오므로, 그 사이의
     * 이적·임대가 남긴 선수를 여기서 다시 걸러 낸다.
     */
    if (player.teamId !== state.userTeamId) continue;

    // ① 전술 적응도 — **여기가 유일한 변화 경로다.** 코어는 훈련 중에 아무것도
    //    올리지 않았다. 얼마나 스몄는지는 이 판정이 정하고, 코어는 −1~3으로 가둔다.
    const assignment = assignments.get(outcome.playerId);
    // 이 변화가 나온 훈련 날짜 — 판정이 가리킨 세션 (없으면 마지막)
    const session = sessionFor(outcome.date);
    if (assignment) {
      const gain = clampGain(outcome.tacticGain);
      if (gain !== 0) {
        const before = assignment.familiarity;
        // 상승은 **위로 갈수록 깎이고, 잘 읽는 선수가 더 가져간다** — 소수로 쌓인다.
        // 감독의 흡수율은 **상승에만** 곱한다: 하락에까지 곱하면 나쁜 감독 밑에서
        // 흐트러짐이 더뎌지는 거꾸로 된 결과가 된다
        assignment.familiarity = applyFamiliarityGain(
          before,
          gain > 0 ? gain * uptake : gain,
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
        const before = slot?.proficiency ?? proficiencyAt(player, program.position);
        const after = Math.min(99, before + gain);
        /**
         * **실제로 넘어간 만큼만 장부에 적는다.** 99에 닿은 자리는 판정이 +2를
         * 내도 아무것도 오르지 않는데, 그 구간마다 "적응 +2"가 성장 로그와
         * 요약에 남아 감독은 오르고 있다고 읽는다.
         */
        const gained = after - before;
        if (gained > 0) {
          if (slot) slot.proficiency = after;
          else
            player.positions.push({
              position: program.position,
              proficiency: after,
              isNatural: false,
            });
          recordGrowth(
            state,
            player.id,
            session.entryId,
            "training",
            `pos:${program.position}`,
            gained,
            "전향 훈련",
            session.date,
          );
          lines.push(`${player.name} ${program.position} 적응 +${gained}`);
        }
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

    // ③ 능력치 — 그 구간에 훈련한 축 + 이 선수에게 걸린 개인 훈련 축 (공용 규칙)
    const moved = applyAttributeStep(state, player, outcome.attribute, outcome.attributeStep, {
      allowed: allowedAxesFor(teamAxes, attributeAxis(program?.axis)),
      spent: attrSpent,
      cap: attrCap,
      factor: uptake,
      source: "training",
      note: "훈련 결산",
      entryId: session.entryId,
      on: session.date,
    });
    if (moved) {
      attrSpent += 1;
      const sign = moved.step > 0 ? "+" : "−";
      lines.push(
        `${player.name} ${AXIS_KO[moved.axis]} ${sign}1 → ${moved.value} — ${oneLine(outcome.note)}`,
      );
    }
  }

  /**
   * 훈련장이 감독을 기른다 — **소화된 세션 수**만큼 (결산 횟수가 아니다).
   * 판정이 아무것도 남기지 않은 구간도 훈련은 있었으므로 XP는 붙는다.
   */
  const grown = grantManagerXP(state, "training", brief.sessions.length * TRAINING_XP_PER_SESSION);
  if (grown) lines.push(grown);
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
    /**
     * 감독 계수 (기본 1) — **상승에만** 곱한다. 하락에 곱하면 나쁜 감독 밑에서
     * 노화가 느려지는 거꾸로 된 결과가 된다. 경기 결산은 주지 않는다.
     */
    factor?: number;
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
      ? attributeGainScale(axis, value, player.attributes.potential, age) * (opts.factor ?? 1)
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

/**
 * 근거 한 줄을 한 줄로 편다 — **자르지는 않는다.**
 *
 * 길이는 판정자 쪽에서 이미 두 겹으로 잡혀 있다(프롬프트가 30자 안팎을 요구하고
 * 스키마가 200자에서 튕긴다). 코어가 그 위에 또 `…`를 붙이면 감독이 읽는 건
 * 문장이 아니라 잘린 토막이고, 왜 잘렸는지는 화면 어디에도 없다.
 */
function oneLine(note: string): string {
  return note.replace(/\s+/g, " ").trim();
}
