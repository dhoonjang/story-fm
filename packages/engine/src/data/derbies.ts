/**
 * 더비 표 — **어느 대진이 더비인가는 표가 정한다.** 구단 프로필(club-profile.ts)·
 * 팀 카탈로그와 같은 성격의 **불변 초기치**이고 세이브에는 들어가지 않는다.
 *
 * ⚠️ 코드가 연고를 추론하지 않는다. 도시·리그·거리로 짐작하면 같은 도시의 아무
 * 두 팀이 더비가 되고(밀라노의 세 번째 팀), 도시가 다른 진짜 더비(데어 클라시커·
 * 노스웨스트)는 빠진다 — 더비는 지리가 아니라 **역사**라서 표 말고는 원본이 없다.
 *
 * 표를 비우면 라이벌 축이 통째로 사라질 뿐 다른 것은 그대로다 (team.md §3.2).
 */

export interface Derby {
  /** 회견의 맥락과 패킷 태그에 그대로 실리는 이름 */
  name: string;
  /** 두 팀의 카탈로그 id — **순서에 뜻이 없다** (`derbyOf`가 양쪽으로 맞춘다) */
  teams: readonly [string, string];
  /**
   * 얼마나 뜨거운가 — **연고를 얼마나 나눠 쓰는가지 명성이 아니다.** 같은 도시의
   * 두 팬은 같은 직장과 같은 식탁에 앉으므로 그 경기가 판을 가장 크게 흔든다.
   *
   * 3 한 도시(한 지역)를 반으로 가른다 · 2 도시는 달라도 서로를 최대 라이벌로
   * 본다 · 1 이웃 사이의 자존심. 강도·사기·관중·굿즈가 전부 이 값에 **비례**한다
   * (team.md §3.2의 표).
   */
  heat: DerbyHeat;
}

export type DerbyHeat = 1 | 2 | 3;

export const DERBIES: readonly Derby[] = [
  // ── 프리미어리그 ──
  { name: "맨체스터 더비", teams: ["manutd", "mancity"], heat: 3 },
  { name: "머지사이드 더비", teams: ["liverpool", "everton"], heat: 3 },
  { name: "북런던 더비", teams: ["arsenal", "tottenham"], heat: 3 },
  { name: "노스웨스트 더비", teams: ["liverpool", "manutd"], heat: 2 },

  // ── 라리가 ──
  { name: "엘 클라시코", teams: ["barcelona", "realmadrid"], heat: 2 },
  { name: "마드리드 더비", teams: ["atletico", "realmadrid"], heat: 3 },
  { name: "세비야 더비", teams: ["sevilla", "betis"], heat: 3 },
  // 두 팬이 함께 입장하는, 표에서 가장 우호적인 더비다
  { name: "바스크 더비", teams: ["athletic", "realsociedad"], heat: 1 },

  // ── 세리에 A ──
  { name: "밀라노 더비", teams: ["inter", "milan"], heat: 3 },
  { name: "데르비 디탈리아", teams: ["juventus", "inter"], heat: 2 },
  { name: "로마 더비", teams: ["roma", "lazio"], heat: 3 },

  // ── 분데스리가 ──
  { name: "데어 클라시커", teams: ["bayern", "dortmund"], heat: 2 },
  { name: "레비어 더비", teams: ["dortmund", "schalke"], heat: 3 },

  // ── 리그 1 ──
  { name: "르 클라시크", teams: ["psg", "marseille"], heat: 2 },
];

/** 이 대진이 더비인가 — 표의 줄을 주거나 `null`. 두 id의 순서는 상관없다 */
export function derbyOf(aTeamId: string, bTeamId: string): Derby | null {
  return (
    DERBIES.find(
      (d) =>
        (d.teams[0] === aTeamId && d.teams[1] === bTeamId) ||
        (d.teams[0] === bTeamId && d.teams[1] === aTeamId),
    ) ?? null
  );
}

/** 이 대진이 더비인가 — 이름만 필요한 자리 */
export function derbyNameOf(aTeamId: string, bTeamId: string): string | null {
  return derbyOf(aTeamId, bTeamId)?.name ?? null;
}
