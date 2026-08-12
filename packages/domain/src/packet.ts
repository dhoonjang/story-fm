/**
 * 전력 분석 패킷 — 코어가 결정적으로 계산하는 **경기의 판세**.
 *
 * v2(2026-08-07)부터 이 패킷은 "LLM에게 주는 힌트"가 아니라 **결과를 정하는
 * 수치**다. 기대 득점(`guide.expectedGoals`)이 구간 시뮬레이터의 발생률이 되고,
 * 사건(골·카드·부상)은 코어가 굴린다. LLM은 그 사건을 중계·연출한다
 * (match-sim.md §1·§2). 숫자와 한국어 해석을 함께 담는 이유는 그대로다 —
 * 중계와 원인 태그가 같은 문장을 인용해야 "왜 그렇게 됐는지"가 설명된다.
 */

export interface ZoneStrength {
  attack: number;
  midfield: number;
  defense: number;
}

export type MatchupZone = "attack" | "midfield" | "defense";
export type EdgeSide = "home" | "away" | "even";
export type EdgeSize = "slight" | "clear" | "big";

export interface Matchup {
  /** 홈 팀 관점의 존 — attack = 홈 공격 vs 어웨이 수비 */
  zone: MatchupZone;
  edge: EdgeSide;
  size: EdgeSize;
  /** 한국어 근거 한 줄 — 원인 태그의 인용 원문 */
  why: string;
}

/**
 * 전술 지시가 존 전력에 남긴 흔적 — **감독의 결정이 어떻게 수치가 됐는가**.
 *
 * 이득과 대가를 함께 적는다. 지시는 공짜가 아니고(라인을 올리면 뒷공간이 열린다),
 * 소화율(`uptake`)이 낮으면 **이득만 깎이고 대가는 그대로** 남는다 — 그래서
 * 소화하지 못하는 팀의 과격한 지시는 순손실이 된다 (match-sim.md §1.1).
 */
export interface TacticalRead {
  /** 지시 적용률 0.45~1.0 — 감독 전술 능력 + 팀 전술 적응도 */
  uptake: number;
  /** 이득·대가를 적은 한국어 한 줄들 (지시가 수치를 움직였을 때만) */
  notes: string[];
}

export type RegionalBand = "defense" | "midfield" | "attack";
export type RegionalLane = "left" | "center" | "right";
export type RegionalIntent = "overload" | "press" | "protect" | "transition";

/** 자연어 세부 전술을 코어가 검증해 경기 패킷에 남긴 지역 플랜. */
export interface RegionalInstruction {
  id: string;
  band: RegionalBand;
  lane: RegionalLane;
  intent: RegionalIntent;
  note: string;
  /** 팀 전술 소화율이 적용된 실제 강도. */
  uptake: number;
}

export interface PacketPlayer {
  id: string;
  name: string;
  position: string;
  /** 실제 전술판 좌표 — 없으면 position의 기본 좌표를 사용한다. */
  point?: import("./tactics").BoardPoint;
  /** 이 경기에서 수행하는 세부 역할. */
  roleId?: string;
  /** 이 자리에서 지금 내는 전력 (상태·적응도 반영) */
  effective: number;
  fit: {
    /** 포지션 적응도 0~99 */
    position: number;
    /** 전술 적응도 0~99 */
    tactical: number;
    /** 이 자리가 전술 적응에 얼마나 민감한가 (0.6~1.4) */
    sensitivity: number;
  };
}

export interface SidePacket {
  teamId: string;
  teamName: string;
  zones: ZoneStrength;
  /** 감독 전술 능력치가 만든 전술 소화율 계수 (attribute-model.md §7) */
  tacticalFit: number;
  /** 전술 지시의 반영 — 적용률과 이득·대가 (설명 가능성) */
  tactical: TacticalRead;
  /** 이 경기에만 유효한 지역별 세부 전술. */
  regional?: RegionalInstruction[];
  /**
   * 그라운드 위 선수 명단 — id·이름·자리에 **그 선수가 지금 내는 전력**까지.
   *
   * `effective` = roleFit(15축 × 자리 가중치) × 상태(폼·사기·피로) × 포지션 적응도
   * × 전술 적응도. 존 전력은 이 값들의 평균일 뿐이라, "누가 안 돌아가는가"는
   * 여기서만 답할 수 있다. `fit`은 그 값이 왜 깎였는지의 분해다.
   */
  lineup: PacketPlayer[];
  bench: PacketPlayer[];
}

/**
 * 공략 표적 — 키포인트 하나를 지시로 겨냥할 수 있게 만든 형태.
 *
 * `id`는 **경기 안에서 안정적**이어야 한다(라인업이 그대로면 같은 id). 모델이
 * 이 목록에서 골라 부르고, 코어는 그 id가 지금도 실재하는지만 확인한다 —
 * 교체로 그 선수가 나가면 표적이 사라지고 공략도 함께 끝난다.
 */
export interface ExploitTarget {
  id: string;
  /** 어느 팀의 약점인가 — 우리가 노리는 쪽 */
  side: "home" | "away";
  /** 한 줄 설명 — 감독이 본 그 문장 (안개를 지난 뒤의 표현) */
  label: string;
  /** 공략이 닿는 존 */
  zone: "attack" | "midfield" | "defense";
}

export interface StrengthPacket {
  home: SidePacket;
  away: SidePacket;
  matchups: Matchup[];
  /** 위협/약점 포인트 — 한국어 문장 (예: "사카(pace 88) vs 좌측 풀백(pace 61)") */
  keyPoints: string[];
  /**
   * 각 키포인트가 **누구에게 이로운가** — `keyPoints`와 같은 순서.
   *
   * 문장은 팀 이름으로 시작할 뿐 유불리를 말하지 않는다("맨유 수비가 …
   * 강요당한다"와 "맨유 뒷공간 공략: …"은 정반대다). 화면이 문장을 되짚어
   * 추측하면 틀리므로 코어가 함께 싣는다. 진행 중인 경기를 담은 **옛 세이브에는
   * 없다** — 그때는 화면이 색 없이 세운다.
   */
  keyPointSides?: ("home" | "away")[];
  /**
   * **공략할 수 있는 지점** — 감독이 겨냥해 지시할 수 있는 키포인트.
   *
   * 위 `keyPoints`가 화면에 그대로 서는 문장(상성·구멍 포함)이라면 이쪽은
   * **표적**이다. id로 지목하면 코어가 실재를 대조하고 존 조정을 얹는다
   * (sim `key-points.ts` · `exploits.ts`). 남의 팀 약점도 들어 있다 —
   * 감독은 우리 약점을 메우는 쪽으로도 지시할 수 있어야 한다.
   */
  targets: ExploitTarget[];
  guide: {
    /**
     * 90분 기대 득점 — **구간 시뮬레이터의 분당 발생률 원본**이다(÷90).
     * 힌트가 아니라 결과를 만드는 수치다.
     */
    expectedGoals: { home: number; away: number };
    /**
     * 공을 쥐는 비율 (0.35~0.65) — **중원 우위가 정한다.**
     * 기대 득점에 실리고, 공 없는 팀의 체력 소모를 키운다.
     */
    possession: { home: number; away: number };
    /** 약팀이 이길 확률 어림 0~1 — 서술용 참고값 */
    upsetChance: number;
    /** 경기 강도 0.8~1.3 — 압박·템포에서 나온다. 피로·파울·부상률을 함께 움직인다 */
    intensity: { home: number; away: number };
  };
  /** 한국어 총평 한 단락 */
  summary: string;
}
