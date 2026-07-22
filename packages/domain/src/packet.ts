/**
 * 전력 분석 패킷 — 코어가 결정적으로 계산해 매치 티어 LLM에 주입하는
 * "유일한 판단 근거" (match-sim.md §1). 숫자와 한국어 해석을 함께 담아
 * LLM이 중계·원인 태그에 그대로 인용할 수 있게 한다.
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

export interface SidePacket {
  teamId: string;
  teamName: string;
  zones: ZoneStrength;
  /** 감독 전술 능력치가 만든 전술 소화율 계수 (attribute-model.md §7) */
  tacticalFit: number;
  /** 그라운드 위 선수 명단 — LLM이 참조할 id·이름·포지션 */
  lineup: Array<{ id: string; name: string; position: string }>;
  bench: Array<{ id: string; name: string; position: string }>;
}

export interface StrengthPacket {
  home: SidePacket;
  away: SidePacket;
  matchups: Matchup[];
  /** 위협/약점 포인트 — 한국어 문장 (예: "사카(pace 88) vs 좌측 풀백(pace 61)") */
  keyPoints: string[];
  guide: {
    expectedGoals: { home: number; away: number };
    /** 약팀이 이길 확률 어림 0~1 — 참고 힌트, 강제 아님 */
    upsetChance: number;
  };
  /** 한국어 총평 한 단락 */
  summary: string;
}
