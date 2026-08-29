/**
 * 명령 인자의 구단 자리 — 감독이 부른 이름이 그대로 실려 온다.
 *
 * `player-ref.ts`와 같은 이유다 (docs/llm/agents.md §5): 컨텍스트에 구단 id가 없으므로
 * 해석기가 싣는 것은 「첼시」다. id만 받는 자리는 부를 수 없는 명령이 되고, 조회만
 * 이름을 풀면 같은 말이 조회에서는 닿고 명령에서는 말없이 반려된다.
 *
 * **애매하면 고르지 않는다** — 명령은 상태를 바꾸는 자리다. 갈리면 후보를 돌려
 * GM이 되묻게 한다.
 */
import { norm } from "../world/player-pool";
import { teamNameIn, teamShortNameIn, type GameState } from "./state";

/** 부분 일치로 닿지 않는 약칭만 둔다 ("맨유"는 "맨체스터 유나이티드"의 부분 문자열이 아니다) */
const TEAM_ALIASES: Record<string, string> = {
  맨유: "manutd",
  맨시티: "mancity",
  스퍼스: "tottenham",
  아스널: "arsenal",
  레알: "realmadrid",
  바르샤: "barcelona",
  앳마: "atletico",
  뮌헨: "bayern",
  바이언: "bayern",
  유베: "juventus",
  파리: "psg",
};

/** 되물을 때 늘어놓는 후보 수 — 그 이상은 감독이 고를 목록이 아니다 */
const CANDIDATES_SHOWN = 6;

export type TeamPickResult = { ok: true; teamId: string } | { ok: false; message: string };

interface NamedTeam {
  readonly id: string;
  readonly name: string;
  readonly shortName: string;
}

/**
 * 이름·약칭·id로 이 세계의 구단 하나 — 못 찾거나 갈리면 반려 문장.
 *
 * 뒤지는 것은 **세이브의 팀**이다(`teamNameIn`). 카탈로그를 직접 읽으면 어드민이 고친
 * 이름으로는 닿지 않고, 이 세계에 없는 팀(`scopedTeams`)이 풀려 명령이 한 겹 더 가서
 * 반려된다 (docs/data/game-state.md §1).
 */
export function pickTeam(state: GameState, ref: string): TeamPickResult {
  const said = ref.trim();
  const key = norm(said);
  if (key === "") return { ok: false, message: "어느 구단인지 말씀해 주세요" };

  const pool: NamedTeam[] = state.teams.map((t) => ({
    id: t.id,
    name: teamNameIn(state, t.id),
    shortName: teamShortNameIn(state, t.id),
  }));

  // 약칭표도 이 세계에 있을 때만 답한다 — 없는 팀의 id를 돌려주면 반려가 한 칸 뒤로 밀린다
  const alias = TEAM_ALIASES[key];
  if (alias !== undefined && pool.some((t) => t.id === alias)) {
    return { ok: true, teamId: alias };
  }

  const exact = pool.find((t) => t.id === key || norm(t.shortName) === key || norm(t.name) === key);
  if (exact) return { ok: true, teamId: exact.id };

  const partial = pool.filter((t) => norm(t.name).includes(key) || t.id.includes(key));
  if (partial.length === 1) return { ok: true, teamId: partial[0]!.id };
  if (partial.length > 1) {
    const names = partial
      .slice(0, CANDIDATES_SHOWN)
      .map((t) => `${t.name}(${t.id})`)
      .join(" / ");
    return { ok: false, message: `"${said}"는 여러 팀과 맞습니다 — ${names}` };
  }
  return { ok: false, message: `"${said}"라는 팀을 찾지 못했습니다` };
}
