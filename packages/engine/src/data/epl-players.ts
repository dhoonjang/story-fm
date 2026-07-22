import type { PositionGroup } from "@story-fm/domain";

/**
 * 2024-25 EPL 실선수 스냅샷 (EA FC25 능력치 기준) — data-sourcing.md §4 MVP 레시피.
 * 멀티에이전트 워크플로우로 생성·적대적 검증됨 (팀별 생성→검증→팀 간 중복 해소).
 *
 * ⚠️ 라이선스 부채 (data-sourcing.md §7): 능력치 원천은 EA IP, 실명은 NIL 대상.
 * MVP 한정 사용 — 정식 출시 전 자체 산정 능력치·가명 전환으로 청산한다.
 *
 * 세계관 주의: 이 데이터는 2024-25 시즌 스냅샷이고 인게임 연도는 가상으로
 * 진행된다 (나이는 FC25 등재 기준). 유스는 계속 합성 가명 생성 — 실존
 * 유소년에게 가상 서사를 입히는 리스크 회피 (narrative.md §7).
 */
export interface RealPlayerSeed {
  /** 로마자 통용 표기 — id 슬러그·외부 데이터 매핑용 */
  nameEn: string;
  /** 한국 축구 언론 통용 한글 표기 — 게임 내 표시명 */
  nameKo: string;
  /** FC25 등재 나이 (2024-25 시즌 기준) */
  age: number;
  position: string;
  positionGroup: PositionGroup;
  pace: number;
  shooting: number;
  passing: number;
  dribbling: number;
  defending: number;
  physical: number;
  /** GK 전용 — FC25 overall 수준 */
  goalkeeping?: number;
  potential: number;
}

/** teamId(team-catalog.ts) → 16인 스쿼드 (GK2·DF5·MF5·FW4). 비어 있으면 합성 폴백. */
export const REAL_SQUADS: Record<string, readonly RealPlayerSeed[]> = {};
