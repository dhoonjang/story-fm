/**
 * 코어 명령 — 도구와 함께 **상태 변경의 유일한 통로**다 (overview §2.2·§5).
 *
 * 이 파일은 **재수출만 한다.** 명령은 갈래마다 한 파일에 산다:
 *
 * | 파일          | 무엇                                                        |
 * | ------------- | ----------------------------------------------------------- |
 * | `talk.ts`     | 감독 성장 · 대화 판정(`applyTalk`) · 사건 기록              |
 * | `lineup.ts`   | 1·2군 · 라인업 · 팀 전술과 개인 지시 · 완장 · 등번호        |
 * | `training.ts` | 훈련 일정 · 개인 훈련 · 집중 육성 · 멘토링 · 유스 첫 계약   |
 * | `scouting.ts` | 스카우트 파견과 임무                                        |
 *
 * 부르는 쪽은 전부 `../commands`를 읽으므로 갈래가 늘어도 import가 움직이지 않는다.
 */

// 체력 클램프는 도메인이 단일 소스 (clampCondition)
// 폼 클램프는 form.ts가 단일 소스 — 소수를 살려야 매일 회귀가 반영된다
// 적응도 클램프도 도메인이 단일 소스 (clampFamiliarity) — 기억을 적는 자리와
// 되찾는 자리가 같은 천장을 써야 왕복이 닫힌다

export { POSITION_CODES, positionGroupOf } from "@story-fm/domain";
export { MATCHDAY_BENCH, groupOf, tacticsOf } from "../core/state";
export { forgetRoles, recallRole, rememberRole } from "./role-memory";

export type { CommandResult, MarketCommandResult } from "./result";
export * from "./talk";
export * from "./lineup";
export * from "./training";
export * from "./scouting";
