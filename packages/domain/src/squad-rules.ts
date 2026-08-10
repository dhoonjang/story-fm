import { ageOf } from "./player";

/**
 * 스쿼드 등록 규칙 — 실제 리그의 **등록 명단(registration list)** 을 그대로 옮긴다.
 *
 * 현실의 제약은 "1군에 몇 명까지 둘 수 있나"가 아니다. 훈련장 인원엔 상한이 없고,
 * 진짜 벽은 **시즌 명단에 몇 명을 올릴 수 있나**다. 프리미어리그는 만 21세 초과
 * 선수 25명까지만 올릴 수 있고 그중 8명은 홈그로운이어야 한다. U21은 명단과
 * 무관하게 무제한이라, 어린 선수는 언제든 뛸 수 있다.
 *
 * 그래서 스쿼드 관리의 긴장이 "몇 명 데리고 있나"가 아니라 **"누구를 명단에서
 * 빼나"** 가 된다 — 명단 밖으로 밀린 베테랑이 반년을 통째로 날리는 그 드라마.
 */

/** 만 21세 초과 선수의 등록 상한 */
export const SQUAD_LIST_LIMIT = 25;
/** 등록 명단 안에 있어야 하는 홈그로운 최소 인원 */
export const HOMEGROWN_MIN = 8;
/** 파생 — 홈그로운이 모자라면 그만큼 명단 자리가 비어도 못 채운다 */
export const NON_HOMEGROWN_MAX = SQUAD_LIST_LIMIT - HOMEGROWN_MIN;
/** 매치데이 명단 = 선발 11 + 벤치 9. 1군 최소 인원의 근거다 */
export const MATCHDAY_SQUAD = 20;

/**
 * U21 기준일 — 시즌 시작 연도 −21년의 1월 1일. 이 날 **이후 출생**이면
 * 그 시즌 내내 명단 밖이다 (PL 규정 그대로 — 시즌 도중 생일이 지나도 안 바뀐다).
 */
export function u21CutoffDate(seasonStartYear: number): string {
  return `${seasonStartYear - 21}-01-01`;
}

/** 이 시즌에 명단을 차지하지 않는가 (U21) */
export function isUnder21(birthdate: string, seasonStartYear: number): boolean {
  return birthdate >= u21CutoffDate(seasonStartYear);
}

/** 등록 대상 최소 정보 — 엔진의 GamePlayer도, 카탈로그 엔트리도 이 모양이면 된다 */
export interface RegistrablePlayer {
  id: string;
  birthdate: string;
  /** 이 팀 기준 홈그로운인가 — 협회가 다르면 같은 선수도 아닐 수 있다 */
  homegrown: boolean;
}

export interface SquadRegistration {
  /** 명단을 차지하는 인원 (만 21세 초과) */
  listed: number;
  limit: number;
  /** 명단 안 홈그로운 */
  homegrown: number;
  homegrownMin: number;
  /** 명단 밖 — 무제한으로 둘 수 있고 경기에도 나간다 */
  under21: number;
  total: number;
  /** 지금 더 올릴 수 있는 21세 초과 인원 (홈그로운 여부별) */
  openHomegrown: number;
  openNonHomegrown: number;
  /** 규정 위반 사유 — 빈 배열이면 적법한 명단 */
  issues: string[];
}

/**
 * 등록 현황 — 순수 계산. 저장하지 않고 1군 명단에서 매번 파생한다.
 * (지식 수준·포메이션과 같은 원칙: 파생할 수 있으면 저장하지 않는다)
 */
export function squadRegistration(
  squad: readonly RegistrablePlayer[],
  seasonStartYear: number,
): SquadRegistration {
  const listedPlayers = squad.filter((p) => !isUnder21(p.birthdate, seasonStartYear));
  const listed = listedPlayers.length;
  const homegrown = listedPlayers.filter((p) => p.homegrown).length;
  const nonHomegrown = listed - homegrown;

  const issues: string[] = [];
  if (listed > SQUAD_LIST_LIMIT) {
    issues.push(`등록 명단 초과 — ${listed}/${SQUAD_LIST_LIMIT}명`);
  }
  // 홈그로운은 "8명 미만이면 위반"이 아니라 **모자란 만큼 명단이 줄어드는** 규칙이다.
  // 실제로도 홈그로운 6명뿐인 구단은 25명이 아니라 23명만 올릴 수 있다.
  if (nonHomegrown > NON_HOMEGROWN_MAX) {
    issues.push(
      `홈그로운 부족 — 비홈그로운 ${nonHomegrown}명 (최대 ${NON_HOMEGROWN_MAX}명, 홈그로운 ${homegrown}/${HOMEGROWN_MIN})`,
    );
  }
  if (squad.length < MATCHDAY_SQUAD) {
    issues.push(`매치데이 명단 미달 — ${squad.length}/${MATCHDAY_SQUAD}명`);
  }

  return {
    listed,
    limit: SQUAD_LIST_LIMIT,
    homegrown,
    homegrownMin: HOMEGROWN_MIN,
    under21: squad.length - listed,
    total: squad.length,
    openHomegrown: Math.max(0, SQUAD_LIST_LIMIT - listed),
    openNonHomegrown: Math.max(
      0,
      Math.min(SQUAD_LIST_LIMIT - listed, NON_HOMEGROWN_MAX - nonHomegrown),
    ),
    issues,
  };
}

/**
 * 이 선수를 1군에 더 올릴 수 있는가 — 못 올리면 이유를 돌려준다.
 * U21은 언제나 가능하다 (명단을 차지하지 않는다).
 */
export function canRegister(
  squad: readonly RegistrablePlayer[],
  player: RegistrablePlayer,
  seasonStartYear: number,
): { ok: true } | { ok: false; reason: string } {
  if (isUnder21(player.birthdate, seasonStartYear)) return { ok: true };
  const reg = squadRegistration(squad, seasonStartYear);
  if (reg.listed >= SQUAD_LIST_LIMIT) {
    return {
      ok: false,
      reason: `등록 명단이 찼습니다 (${reg.listed}/${SQUAD_LIST_LIMIT}) — 21세 초과 선수를 먼저 내려야 합니다`,
    };
  }
  if (!player.homegrown && reg.openNonHomegrown <= 0) {
    return {
      ok: false,
      reason: `홈그로운이 모자랍니다 (${reg.homegrown}/${HOMEGROWN_MIN}) — 남은 자리는 홈그로운만 채울 수 있습니다`,
    };
  }
  return { ok: true };
}

/** 나이로 U21을 판정할 때 쓰는 보조 — 표시용 (규칙 판정은 birthdate 기준) */
export function isYouthAge(birthdate: string, onDate: string): boolean {
  return ageOf(birthdate, onDate) <= 21;
}
