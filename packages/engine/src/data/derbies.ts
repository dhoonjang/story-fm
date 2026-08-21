/**
 * 더비 표 — **어느 대진이 더비인가는 표가 정한다.** 구단 프로필(club-profile.ts)·
 * 팀 카탈로그와 같은 성격의 **불변 초기치**이고 세이브에는 들어가지 않는다.
 *
 * ⚠️ 코드가 연고를 추론하지 않는다. 도시·리그·거리로 짐작하면 같은 도시의 아무
 * 두 팀이 더비가 되고(밀라노의 세 번째 팀), 도시가 다른 진짜 더비(데어 클라시커·
 * 노스웨스트)는 빠진다 — 더비는 지리가 아니라 **역사**라서 표 말고는 원본이 없다.
 *
 * 표를 비우면 더비 전야 회견이 사라질 뿐 다른 것은 그대로다 (people.md §4).
 */

export interface Derby {
  /** 회견의 맥락에 그대로 실리는 이름 */
  name: string;
  /** 두 팀의 카탈로그 id — **순서에 뜻이 없다** (`derbyNameOf`가 양쪽으로 맞춘다) */
  teams: readonly [string, string];
}

export const DERBIES: readonly Derby[] = [
  // ── 프리미어리그 ──
  { name: "맨체스터 더비", teams: ["manutd", "mancity"] },
  { name: "머지사이드 더비", teams: ["liverpool", "everton"] },
  { name: "북런던 더비", teams: ["arsenal", "tottenham"] },
  { name: "노스웨스트 더비", teams: ["liverpool", "manutd"] },

  // ── 라리가 ──
  { name: "엘 클라시코", teams: ["barcelona", "realmadrid"] },
  { name: "마드리드 더비", teams: ["atletico", "realmadrid"] },
  { name: "세비야 더비", teams: ["sevilla", "betis"] },
  { name: "바스크 더비", teams: ["athletic", "realsociedad"] },

  // ── 세리에 A ──
  { name: "밀라노 더비", teams: ["inter", "milan"] },
  { name: "데르비 디탈리아", teams: ["juventus", "inter"] },
  { name: "로마 더비", teams: ["roma", "lazio"] },

  // ── 분데스리가 ──
  { name: "데어 클라시커", teams: ["bayern", "dortmund"] },
  { name: "레비어 더비", teams: ["dortmund", "schalke"] },

  // ── 리그 1 ──
  { name: "르 클라시크", teams: ["psg", "marseille"] },
];

/** 이 대진이 더비인가 — 이름을 주거나 `null`. 두 id의 순서는 상관없다 */
export function derbyNameOf(aTeamId: string, bTeamId: string): string | null {
  const derby = DERBIES.find(
    (d) =>
      (d.teams[0] === aTeamId && d.teams[1] === bTeamId) ||
      (d.teams[0] === bTeamId && d.teams[1] === aTeamId),
  );
  return derby?.name ?? null;
}
