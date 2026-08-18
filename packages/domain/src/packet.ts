/**
 * 전력 분석 패킷 — 코어가 결정적으로 계산하는 **경기의 판세**.
 *
 * 이 패킷은 "LLM에게 주는 힌트"가 아니라 **결과를 정하는 수치**다. 선수×경로
 * 슈팅 프로필(`guide.shotProfiles`)이 두 시뮬레이터의 발생률 원본이고, 사건은
 * 코어가 굴린다. LLM은 그 사건을 중계·연출한다
 * (match.md §1·§2). 숫자와 한국어 해석을 함께 담는 이유는 그대로다 —
 * 중계와 원인 태그가 같은 문장을 인용해야 "왜 그렇게 됐는지"가 설명된다.
 */

import type { MatchSide } from "./match";
import type { BoardPoint } from "./tactics";

export interface ZoneStrength {
  attack: number;
  midfield: number;
  defense: number;
}

/**
 * 세 전선 — **패킷 전체가 쓰는 한 낱말.** 존 전력·매치업·지역 전술의 밴드·공략이
 * 닿는 존이 모두 이 셋이고, 한 곳만 다른 이름으로 두면 같은 자리가 두 값이 된다.
 */
export type MatchupZone = "attack" | "midfield" | "defense";
export type EdgeSide = MatchSide | "even";
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
 * 소화율(`uptake`)은 **이득에 온전히, 대가에는 층마다 다르게** 걸린다 — 전술 6축과
 * 공략은 대가도 절반을 태우고 개인 지시·전술 상성은 대가를 온전히 문다
 * (match.md §1.2의 표).
 */
export interface TacticalRead {
  /** 지시 적용률 0.45~1.0 — 감독 전술 능력 + 팀 전술 적응도 */
  uptake: number;
  /** 이득·대가를 적은 한국어 한 줄들 (지시가 수치를 움직였을 때만) */
  notes: string[];
}

export type RegionalBand = MatchupZone;
/** 좌·중·우 — 지역 전술·판세 격자·공격 경로가 나눠 쓰는 눈금 */
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

/**
 * 개인 지시·공략이 판세 격자의 한 줄 안에서 기울인 몫 — **줄 합은 0이다.**
 *
 * 지시의 산출은 밴드×레인 아홉 칸이고, 그 줄 평균은 존 전력에 실린다. 여기 오는
 * 것은 평균을 뺀 나머지뿐이라 격자는 **배분만** 받는다 — 같은 전력이 존과 칸에
 * 두 번 세어지지 않게 하는 자리다 (match.md §1.7, sim `zone-grid.ts`).
 */
export interface LaneBias {
  band: RegionalBand;
  lane: RegionalLane;
  /** 존 전력 대비 비율 — 양수면 그 칸이 두꺼워지고 같은 줄 나머지가 얇아진다 */
  share: number;
}

export interface PacketPlayer {
  id: string;
  name: string;
  position: string;
  /** 실제 전술판 좌표 — 없으면 position의 기본 좌표를 사용한다. */
  point?: BoardPoint;
  /** 이 경기에서 수행하는 세부 역할. */
  roleId?: string;
  /** 이 자리에서 지금 내는 전력 (상태·적응도 반영) */
  effective: number;
  /**
   * 기회 생성에 쓰는 전력. 실제 결정력은 리그 기준값으로 치환하고 나머지
   * 역할·상태·적응도만 반영한다 — 결정력의 슈팅 접근 효과는 별도 항에서 한 번만 센다.
   */
  creationEffective?: number;
  fit: {
    /** 포지션 적응도 0~99 */
    position: number;
    /** 전술 적응도 0~100 */
    tactical: number;
    /** 이 자리가 전술 적응에 얼마나 민감한가 (0.6~1.4) */
    sensitivity: number;
  };
}

export type ShotRoute = RegionalLane;

/** 한 선수가 한 공격 경로에서 갖는 90분 슈팅 분포. */
export interface PlayerShotRoute {
  route: ShotRoute;
  /** 이 경로에서의 90분 기대 슈팅 수 — 포아송 강도. */
  expectedShots: number;
  /** 이 경로에서 만들어지는 슛 하나의 평균 기회 xG. */
  meanXg: number;
}

/** 팀 총량을 나누지 않고 선수×지역에서 직접 만든 슈팅 프로필. */
export interface PlayerShotProfile {
  playerId: string;
  routes: PlayerShotRoute[];
  expectedShots: number;
  /** 생성 레이어의 기대값 Σ(경로 기대 슈팅 × 평균 xG). */
  chanceXg: number;
  /** 결정력을 반영한 기대 득점. */
  expectedGoals: number;
}

export interface SidePacket {
  teamId: string;
  teamName: string;
  zones: ZoneStrength;
  /** 결정력을 중립화한 기회 생성용 존 전력. */
  creationZones?: ZoneStrength;
  /** 감독 전술 능력치가 만든 전술 소화율 계수 (career.md §2) */
  tacticalFit: number;
  /** 전술 지시의 반영 — 적용률과 이득·대가 (설명 가능성) */
  tactical: TacticalRead;
  /** 이 경기에만 유효한 지역별 세부 전술. */
  regional?: RegionalInstruction[];
  /**
   * 개인 지시·공략이 격자의 배분을 기울인 몫. 지시가 없거나 레인을 겨냥하지 않은
   * 경기에는 없고, **옛 세이브에도 없다** — 그때는 격자가 배치와 지역 플랜만 읽는다.
   */
  laneBias?: LaneBias[];
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
  side: MatchSide;
  /** 한 줄 설명 — 감독이 본 그 문장 (안개를 지난 뒤의 표현) */
  label: string;
  /** 공략이 닿는 존 */
  zone: MatchupZone;
  /**
   * 그 짝이 얼마나 벌어졌나 (`KeyPoint.weight`) — **공략의 이득이 이 값을 탄다.**
   * 크게 벌어진 약점이 문턱을 겨우 넘은 약점보다 크게 값을 해야 감독이 무엇을
   * 읽었는지가 결과에 남는다. 진행 중인 옛 세이브에는 없고, 그때는 기준 눈금으로
   * 본다(sim `exploits.ts`).
   */
  weight?: number;
  /**
   * 그 약점이 선 레인 — **약점을 가진 쪽의 방향**이다. 표적이 팀 전체인 지점
   * (백라인 조직·중원 활동량)에는 없고, 그때 공략은 세 레인에 고르게 실린다.
   */
  lane?: RegionalLane;
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
  keyPointSides?: MatchSide[];
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
    /** 선수별 프로필의 결정력 반영 기대 득점을 합친 90분 판독값. */
    expectedGoals: { home: number; away: number };
    /** 선수×경로 기대 슈팅의 합. 새 패킷은 항상 갖고, 진행 중인 옛 세이브에는 없다. */
    expectedShots?: { home: number; away: number };
    /** 결정력을 넣기 전 기회 xG의 합. */
    chanceXg?: { home: number; away: number };
    /** 선수별·공격 경로별 슈팅 분포 — 구간/간이 시뮬의 공통 원본. */
    shotProfiles?: { home: PlayerShotProfile[]; away: PlayerShotProfile[] };
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
}
