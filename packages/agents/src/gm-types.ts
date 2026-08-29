import type { MissionReportCard, ScoutReportCard } from "@story-fm/domain";
import type { CardMark, GoalMark, SkillBrief } from "@story-fm/engine";

/** GM 턴 결과 — mock/실모드 공통 계약 */
export interface GmToolCall {
  name: string;
  summary: string;
  /** 화면이 항목으로 세우는 요약 (`ToolCallRecord.brief`) — 없으면 요약 문자열로 폴백 */
  brief?: SkillBrief;
  /** 호출 파라미터 — 채팅에서 칩을 펼치면 보여준다 */
  input?: unknown;
  /** 구조화된 결과 — 채팅이 카드로 그린다 (`ToolCallRecord.payload`) */
  payload?: unknown;
  /** 결이 좋은가 — 대화형 스킬의 칩 색 (`ToolCallRecord.tone`) */
  tone?: "good" | "bad";
  /**
   * 호출이 아니라 **코어가 한 일**의 기록 — 화면에 칩으로 세우지 않는다
   * (`ToolCallRecord.silent`와 같은 뜻). 시계 이동이 대표적이다.
   */
  silent?: boolean;
  /**
   * 이 호출이 불린 **장면 속 자리** — 그때까지 쓰인 본문 줄 수
   * (`ToolCallRecord.line`). 화면이 그 지점에 칩을 세운다.
   */
  line?: number;
}

/** 엔진 명령이 돌려주는 것 — `SkillResult`와 같은 모양이되 GM 쪽에서 좁게 읽는다 */
export type SkillReturn = {
  ok: boolean;
  message: string;
  brief?: SkillBrief;
  payload?: unknown;
  tone?: "good" | "bad";
};

/**
 * 호출을 턴의 기록에 세운다 — **두 모드가 같은 함수를 쓴다** (agents.md §8).
 *
 * - **성공한 호출만 남긴다.** 실패한 호출은 세계를 움직이지 않았으니 칩도 말풍선도
 *   설 자리가 없다. 갈라져 있던 시절 mock에만 실패 칩이 서서, e2e가 실모드에는 없는
 *   칩을 보고 통과했다.
 * - **함께 실려야 하는 것을 빠뜨리지 않는다** — 카드(`payload`)·항목(`brief`)·결(`tone`).
 *   없으면 화면이 조용히 폴백한다: 카드 없이 줄글로, 항목 없이 요약 문자열로.
 */
export function recordCall(
  calls: GmToolCall[],
  name: string,
  result: SkillReturn,
  extra?: { input?: unknown; line?: number; silent?: boolean },
): SkillReturn {
  if (!result.ok) return result;
  calls.push({
    name,
    summary: result.message,
    ...(extra?.input === undefined ? {} : { input: extra.input }),
    // 항목 요약은 코어가 낸 그대로 실어 보낸다 — 여기서 문자열로 접으면 화면이 도로 쪼갠다
    ...(result.brief === undefined ? {} : { brief: result.brief }),
    ...(result.payload === undefined ? {} : { payload: result.payload }),
    ...(result.tone === undefined ? {} : { tone: result.tone }),
    // 이 호출이 불린 자리 — 화면이 장면 중간에 칩을 세운다
    ...(extra?.line === undefined ? {} : { line: extra.line }),
    ...(extra?.silent === true ? { silent: true } : {}),
  });
  return result;
}

export interface GmTurnResult {
  /** 모델 턴 텍스트 — @문법 (overview.md §3) */
  text: string;
  toolCalls: GmToolCall[];
  /** 이번 턴에 들어간 골 (경기 턴에만) */
  goals?: GoalMark[];
  /** 이번 턴의 경고·퇴장 — 골과 같은 자리에 선다 */
  cards?: CardMark[];
  /** 이번 턴에 도착한 스카우팅 보고서 — 채팅이 카드로 편다 */
  reports?: ScoutReportCard[];
  /** 이번 턴에 도착한 스카우트 임무 보고 — 채팅이 후보 목록 카드로 편다 */
  missions?: MissionReportCard[];
  /**
   * **시계가 멎은 채로 이어진 평시 턴 수** — 첫 줄 헤더를 연달아 못 읽었다
   * (`STALLED_CLOCK_TURNS` 이상일 때만 실린다).
   *
   * 턴이 실패한 것은 아니므로 배너가 아니고 장면도 아니다. 화면이 띠로 세워
   * "세계가 오늘에 머물러 있다"를 사실로 알린다 — 그러지 않으면 이 정지는
   * `console.warn` 한 줄로만 쌓인다.
   */
  clockStalled?: number;
  /**
   * 토큰 사용량 (실모드만). Anthropic은 명시적 캐시 read/write를, Gemini는
   * implicit cached content를 cacheRead에 매핑한다. 제공자별 캐시 적중 조건과
   * 최소 프리픽스가 다르므로 같은 수치를 직접 비교하지 않는다.
   */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}

/**
 * 턴을 끝내지 못한 실패 — **장면이 아니라 배너다** (agents.md §8).
 *
 * 감독에게 보일 한 줄을 들고 오지만 그것은 픽션 밖의 안내라 모델 턴으로 저장되지
 * 않는다. 채팅에 남기면 화자도 시점 헤더도 없는 줄이 장면들 사이에 서고, 그 턴은
 * 되돌릴 수도 없다. 실패는 아무것도 저장하지 않는 것이 곧 롤백이다.
 */
export class GmTurnFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmTurnFailure";
  }
}

/**
 * 시계가 움직였다는 기록의 이름 — **도구 호출이 아니라 코어의 처리 결과**다.
 *
 * 모델이 첫 줄에 적은 시점을 코어가 받아 시계를 옮긴다(`applyScenePoint`).
 * 화면의 칩은 이름을 그대로 보여 주므로, `advance_time`이라고 적으면 어드민
 * 목록에 없는 이름이 호출된 것처럼 읽힌다 — 그 기록은 헤더 방식으로
 * 바뀌며 사라졌다. 한글이라 영문 호출 이름들과 한눈에 갈린다.
 *
 * gm.ts가 아니라 여기 두는 이유는 순환 참조다 — gm이 mock-gm을 부르는데
 * mock-gm도 이 이름을 쓴다.
 */
export const TIME_PASSED = "시간 경과";

/**
 * 경기가 한 구간 굴렀다는 기록의 이름 — **시계 이동과 같은 자리**다.
 *
 * 구간을 미는 것은 감독이 부른 도구가 아니라 코어가 한 일이라(`advanceSegment`)
 * 스킬 카탈로그에 이름이 없다. `advance_match`라고 적으면 영문 호출 이름들 사이에
 * 섞여 트레이스에 미등록 호출이 불린 것처럼 남으므로, `TIME_PASSED`와 같은 규약으로
 * 한글 이름을 쓴다. 화면에 세우지 않는 것은 이름이 아니라 `silent`가 정한다.
 */
export const MATCH_ADVANCED = "경기 진행";

/**
 * 시간 이동 손잡이가 보내는 조작 — `{ kind: "skip_days", days: 1 }`
 * (→ `TurnOperation`, packages/domain).
 *
 * **이것만은 모델을 거치지 않는다.** 다른 시간 이동은 모델이 첫 줄 헤더에 시점을
 * 적고 코어가 따라가지만(`applyScenePoint`), 손잡이는 감독이 얼마를 넘길지 이미
 * 정해서 누른 것이라 물어볼 것이 없다. 코어가 **먼저** 그만큼을 굴리고, 모델은
 * 도착한 자리에서 "그동안 무슨 일이 있었는지"를 읽고 장면을 연다 — 그래야
 * 모델이 자기가 넘긴 일주일에 무엇이 있었는지 모르는 채로 쓰지 않는다.
 *
 * 화면도 코어도 같은 것을 쓰므로 정의는 도메인에 있고 여기서 다시 낸다 —
 * 조작을 다루는 코드는 이 파일에서 GM 계약을 읽는다.
 */
export {
  MAX_SKIP_DAYS,
  operationLabel,
  TurnOperationSchema,
  type TurnOperation,
} from "@story-fm/domain";

/**
 * 헤더를 못 읽은 평시 턴이 이만큼 연달으면 **화면이 알아야 한다.**
 *
 * 모델의 첫 줄이 시계를 움직이는 유일한 자유 텍스트 경로라(agents.md §2), 그
 * 실패는 로그 한 줄로만 남고 감독에게는 "세계가 오늘에 머문다"로만 보였다.
 * 한 턴은 이어지는 대화일 수 있어 세지 않고, 셋이면 우연이 아니다.
 */
export const STALLED_CLOCK_TURNS = 3;

/**
 * 이번 턴의 헤더를 읽었는가를 장부에 적고, **알려야 할 만큼 쌓였으면** 그 수를 낸다.
 *
 * 세는 것은 평시 턴뿐이다 — 경기의 시각은 장부가 주고 코어가 찍는다. 손잡이가
 * 시계를 옮긴 턴도 읽힌 것으로 친다: 그 턴의 헤더는 날짜를 또 밀지 못하는 것이
 * 정상이라, 실패로 세면 손잡이만 누르는 감독에게 없는 경고가 선다.
 */
export function noteSceneHeader(
  state: { sceneHeaderMisses?: number },
  read: boolean,
): number | null {
  if (read) {
    delete state.sceneHeaderMisses;
    return null;
  }
  const misses = (state.sceneHeaderMisses ?? 0) + 1;
  state.sceneHeaderMisses = misses;
  return misses >= STALLED_CLOCK_TURNS ? misses : null;
}
