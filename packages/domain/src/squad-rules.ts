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
/** 선발 인원 — 축구의 규칙이라 조정 대상이 아니다 */
const STARTING_XI = 11;
/**
 * 매치데이 벤치 정원 — **이 숫자의 원본은 여기 하나뿐이다.**
 * 라인업 스킬(`setLineup`)·라인업 라우트·전술판이 전부 이것을 읽는다. 같은 값을 여러
 * 곳에 적어 두면 한 곳만 늘렸을 때 화면이 담을 수 있다고 말한 벤치를 서버가 반려한다.
 */
export const MATCHDAY_BENCH = 9;
/** 매치데이 명단 = 선발 11 + 벤치 9. 1군 최소 인원의 근거다 */
export const MATCHDAY_SQUAD = STARTING_XI + MATCHDAY_BENCH;

/**
 * 1군 인원 상한 — **리그 규정이 아니라 구단 운영의 상한이다.**
 *
 * 등록 명단(25)은 만 21세 초과에만 걸리므로 U21을 붙이는 만큼 1군은 얼마든지
 * 불어난다. 규정이 안 막는다고 서른 명을 넘겨 데리고 다니는 1군은 없다 —
 * 훈련도 로테이션도 성립하지 않는다. 그래서 여기서 끊는다.
 *
 * 이 값은 **두 곳이 함께 지킨다.** 세계를 세울 때 등록이 이 선에서 U21 붙이기를
 * 멈추고(`core/state.ts`), AI 시장이 이 선에서 사는 것을 멈춘다
 * (`market/ai-market.ts`). 한쪽만 지키면 다른 쪽이 넘긴다.
 */
export const FIRST_TEAM_LIMIT = 30;

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
 * 등록이 막힌 이유 — **코드와 수치다** (overview.md §1 철칙 4).
 *
 * 조언 문장("먼저 내려야 합니다")을 코어가 돌려주면 그 문구를 고치려고 규칙 파일을
 * 열어야 하고, 문장을 읽어 갈래를 가르는 자리가 생긴다. 문장은
 * `registrationBlockText`가 한 자리에서 만든다.
 */
export type RegistrationBlock =
  /** 등록 명단이 찼다 — `listed`가 지금 등록 인원, `limit`이 상한 */
  | { code: "list-full"; listed: number; limit: number }
  /** 홈그로운이 모자라 남은 자리를 못 쓴다 — `homegrown`이 지금 수, `limit`이 최소 */
  | { code: "homegrown-short"; homegrown: number; limit: number };

/**
 * 이 선수를 1군에 더 올릴 수 있는가 — 못 올리면 막은 이유를 카드로 돌려준다.
 * U21은 언제나 가능하다 (명단을 차지하지 않는다).
 */
export function canRegister(
  squad: readonly RegistrablePlayer[],
  player: RegistrablePlayer,
  seasonStartYear: number,
): { ok: true } | { ok: false; block: RegistrationBlock } {
  if (isUnder21(player.birthdate, seasonStartYear)) return { ok: true };
  const reg = squadRegistration(squad, seasonStartYear);
  if (reg.listed >= SQUAD_LIST_LIMIT) {
    return {
      ok: false,
      block: { code: "list-full", listed: reg.listed, limit: SQUAD_LIST_LIMIT },
    };
  }
  if (!player.homegrown && reg.openNonHomegrown <= 0) {
    return {
      ok: false,
      block: { code: "homegrown-short", homegrown: reg.homegrown, limit: HOMEGROWN_MIN },
    };
  }
  return { ok: true };
}

/** 막힌 이유를 사람 말로 — 문구는 여기 한 자리에만 있다 */
export function registrationBlockText(block: RegistrationBlock): string {
  switch (block.code) {
    case "list-full":
      return `등록 명단이 찼습니다 (${block.listed}/${block.limit}) — 21세 초과 선수를 먼저 내려야 합니다`;
    case "homegrown-short":
      return `홈그로운이 모자랍니다 (${block.homegrown}/${block.limit}) — 남은 자리는 홈그로운만 채울 수 있습니다`;
  }
}

// ── 계약 지위 — 어떤 자리로 왔는가 ────────────────────

/**
 * 스쿼드 지위 — **계약에 적히는 약속**이다 (→ docs/data/people.md §5-2).
 *
 * 배열 순서가 곧 서열이라 `squadStatusRank`가 인덱스를 그대로 쓴다. 순서를 바꾸면
 * 흥정의 지위 항(transfer.md §3)과 되부르기의 상한이 함께 뒤집힌다.
 */
export const SQUAD_STATUSES = ["prospect", "backup", "rotation", "starter", "key"] as const;
export type SquadStatus = (typeof SQUAD_STATUSES)[number];

/** 서열 — 큰 쪽이 위다. 한 칸 차이가 흥정의 한 칸이다 */
export function squadStatusRank(status: SquadStatus): number {
  return SQUAD_STATUSES.indexOf(status);
}

/** 지위의 이름 — 화면·카드·프롬프트가 같은 말을 쓴다 */
export const SQUAD_STATUS_KO: Record<SquadStatus, string> = {
  key: "핵심",
  starter: "주전",
  rotation: "로테이션",
  backup: "백업",
  prospect: "유망주",
};

/**
 * 그 지위가 부르는 **선발 비율** — 이 표가 약속의 눈금이다.
 *
 * ⚠️ **백업·유망주가 0인 것은 눈금이 아니라 규약이다.** 그 자리로 온 선수에게는
 * 벤치가 곧 약속의 이행이라 출전 불만이 서지 않는다 — 이 줄이 없으면 백업 영입이
 * 곧 반란이 되어 스쿼드를 채우는 일 자체가 손해가 된다 (people.md §5-2).
 *
 * 8경기 창에서 정수 경계에 떨어지도록 고른 값이다: 핵심 6 · 주전 4 · 로테이션 2.
 */
export const SQUAD_STATUS_STARTS: Record<SquadStatus, number> = {
  key: 0.7,
  starter: 0.5,
  rotation: 0.25,
  backup: 0,
  prospect: 0,
};

/**
 * 그 지위가 부르는 만큼 세웠는가 — **약속 이행 판정과 출전 불만이 쓰는 하나의 자**
 * (people.md §5·§5-2). 자를 둘 두면 "약속은 지켰는데 불만이 서는" 상태가 생긴다.
 *
 * @param startShare 창 안에서 그가 설 수 있었던 경기 중 실제 선발 비율 (0~1)
 */
export function promiseKept(startShare: number, status: SquadStatus): boolean {
  return startShare >= SQUAD_STATUS_STARTS[status];
}

/**
 * 그 지위에 모자란 **선발 수** — 창 안에서 몇 번을 더 세웠어야 했나.
 * 이행했으면 0이다. `PlayerIssue.count`가 이 값을 든다.
 */
export function startShortfall(starts: number, played: number, status: SquadStatus): number {
  if (played <= 0) return 0;
  const need = Math.ceil(SQUAD_STATUS_STARTS[status] * played);
  return Math.max(0, need - starts);
}
