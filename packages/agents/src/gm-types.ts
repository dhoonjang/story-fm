import type { ScoutReportCard } from "@story-fm/domain";
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
   * 스킬 호출이 아니라 **코어가 한 일**의 기록 — 화면에 칩으로 세우지 않는다
   * (`ToolCallRecord.silent`와 같은 뜻). 시계 이동이 대표적이다.
   */
  silent?: boolean;
  /**
   * 이 스킬이 불린 **장면 속 자리** — 그때까지 쓰인 본문 줄 수
   * (`ToolCallRecord.line`). 화면이 그 지점에 칩을 세운다.
   */
  line?: number;
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
 * 시계가 움직였다는 기록의 이름 — **스킬이 아니라 코어의 처리 결과**다.
 *
 * 모델이 첫 줄에 적은 시점을 코어가 받아 시계를 옮긴다(`applyScenePoint`).
 * 화면의 칩은 이름을 그대로 보여 주므로, `advance_time`이라고 적으면 어드민
 * 스킬 목록에 없는 스킬이 호출된 것처럼 읽힌다 — 그 스킬은 헤더 방식으로
 * 바뀌며 사라졌다. 한글이라 영문 스킬 이름들과 한눈에 갈린다.
 *
 * gm.ts가 아니라 여기 두는 이유는 순환 참조다 — gm이 mock-gm을 부르는데
 * mock-gm도 이 이름을 쓴다.
 */
export const TIME_PASSED = "시간 경과";

/**
 * 시간 이동 손잡이가 보내는 조작 — `[조작: 시간 진행 — 일주일]` (`TIME_SKIPS`).
 *
 * **이것만은 모델을 거치지 않는다.** 다른 시간 이동은 모델이 첫 줄 헤더에 시점을
 * 적고 코어가 따라가지만(`applyScenePoint`), 손잡이는 감독이 얼마를 넘길지 이미
 * 정해서 누른 것이라 물어볼 것이 없다. 코어가 **먼저** 그만큼을 굴리고, 모델은
 * 도착한 자리에서 "그동안 무슨 일이 있었는지"를 읽고 장면을 연다 — 그래야
 * 모델이 자기가 넘긴 일주일에 무엇이 있었는지 모르는 채로 쓰지 않는다.
 */
export type TimeSkip =
  { kind: "days"; days: number } | { kind: "date"; date: string } | { kind: "next_match" };

/** 조작 문장에서 목표를 읽는다 — 손잡이가 보낸 것이 아니면 null */
export function parseTimeSkip(message: string): TimeSkip | null {
  if (!/시간 진행/u.test(message)) return null;
  const dated = /\((\d{4}-\d{2}-\d{2})\)/u.exec(message)?.[1];
  if (dated) return { kind: "date", date: dated };
  if (/하루|내일/u.test(message)) return { kind: "days", days: 1 };
  if (/일주일|한 ?주/u.test(message)) return { kind: "days", days: 7 };
  return { kind: "next_match" };
}
