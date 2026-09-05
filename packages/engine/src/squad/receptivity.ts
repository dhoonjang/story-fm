import type { PlayerArchetypeKey, RelationTier } from "@story-fm/domain";
import {
  PLAYER_ARCHETYPE_LABEL,
  PLAYER_ARCHETYPE_TRAITS,
  RELATION_TIER_KO,
} from "@story-fm/domain";
import { playerById, type GameState } from "../core/state";
import { diffDays } from "../core/dates";
import { playerArchetypeOf } from "../world/player-persona";
import { MANAGER_SUBJECT, relationTierOf } from "../world/relations";

/**
 * **수용성 — 그 선수가 지금 감독의 말을 어떻게 듣는가** (career.md §2).
 *
 * 판정형 스킬의 outcome은 모델이 열거에서 고르는데, 그 판정의 근거 (c) 「대상 수용성」을
 * 읽을 사실이 카드의 관계 등급뿐이었다. 여기서 코어가 사실 넷을 한 눈금으로 모아
 * 셋(열림·경계·닫힘)으로 내고, 판정은 그 앵커 ± 한 단계 안에서만 선다.
 *
 * ⚠️ 코어는 사실만 낸다 — `reasons`는 코드이고 문장은 GM이 쓴다 (overview.md §1 철칙 4).
 * **눈금은 아직 가정이다** (people.md §10).
 */
export type Receptivity = "open" | "wary" | "closed";

export const RECEPTIVITY_KO: Record<Receptivity, string> = {
  open: "열림",
  wary: "경계",
  closed: "닫힘",
};

/** 판정 사다리의 앵커 — outcome은 `[anchor − 1, anchor + 1]` 안에서만 선다 */
export const RECEPTIVITY_ANCHOR: Record<Receptivity, -1 | 0 | 1> = {
  open: 1,
  wary: 0,
  closed: -1,
};

export interface ReceptivityRead {
  tier: Receptivity;
  /** 눈금의 합 — 팀토크가 명단의 중앙값을 낼 때 읽는다 */
  score: number;
  /** 근거 코드 — 사실만, 문장 아님 (`relation:strained` · `issue` · `last-match:loss` …) */
  reasons: string[];
}

/** 직전 경기가 아직 마음에 남아 있는 날수 */
export const RECEPTIVITY_MATCH_DAYS = 3;
/** 이 평점부터는 그 경기가 그 선수를 열어 둔다 */
export const RECEPTIVITY_HOT_RATING = 7.0;
/**
 * 열림·닫힘의 문턱 — 눈금 합이 이 값에 닿으면 앵커가 한 칸 움직인다.
 *
 * 1이면 불만 하나만으로 닫혀 **면담으로 불만을 풀 길이 없다** — 보통 사이의 선수가
 * 불만을 품는 순간 `reassured`가 `neutral`로 잘린다. 둘이면 불만은 경계까지이고, 닫히는
 * 것은 불만에 껄끄러운 사이나 패배나 원형이 겹칠 때다. 믿는 사이·틀어진 사이는 합과
 * 무관하게 열림·닫힘이다 (`receptivityOf`).
 */
const RECEPTIVITY_TIER_STEP = 2;
/**
 * 등급이 눈금에 얹는 값 — 순위(0~5)를 그대로 더하면 눈금이 통째로 위로 밀린다.
 *
 * 옛 다섯 칸의 −2~+2를 그대로 두고 가운데 둘을 0에 놓았다: 등급을 여섯으로 가르는 일이
 * 수용성의 밸런스까지 함께 옮기지 않게 한다.
 */
const RECEPTIVITY_RELATION_STEP: Record<RelationTier, number> = {
  hostile: -2,
  strained: -1,
  distant: 0,
  cordial: 0,
  close: 1,
  trusted: 2,
};

/**
 * 원형이 수용성에 거는 자리 — 계수 넷 중 **직업의식**을 읽는다: 코치의 말을 흡수하는
 * 축(`applyAttributeStep`)이라 감독의 말을 듣는 쪽에 가장 가깝다. 표(people.md §6)에서
 * 1.15 이상이 셋(장인·프로페셔널·영상 분석형), 0.9 이하가 둘(승부욕 과열·저울질하는 스타)이다.
 */
const ARCHETYPE_OPEN_AT = 1.15;
const ARCHETYPE_CLOSED_AT = 0.9;

function archetypeShift(key: PlayerArchetypeKey): -1 | 0 | 1 {
  const professionalism = PLAYER_ARCHETYPE_TRAITS[key].professionalism;
  if (professionalism >= ARCHETYPE_OPEN_AT) return 1;
  if (professionalism <= ARCHETYPE_CLOSED_AT) return -1;
  return 0;
}

/** 직전 `RECEPTIVITY_MATCH_DAYS`일 안의 우리 경기 — 같은 날이 둘이면 원장 뒤쪽이 이긴다 */
function recentMatchOf(state: GameState) {
  let found: (typeof state.matches)[number] | undefined;
  for (const match of state.matches) {
    if (match.result === null) continue;
    if (match.homeTeamId !== state.userTeamId && match.awayTeamId !== state.userTeamId) continue;
    const ago = diffDays(match.date, state.date);
    if (ago < 0 || ago > RECEPTIVITY_MATCH_DAYS) continue;
    if (found === undefined || match.date >= found.date) found = match;
  }
  return found;
}

export function receptivityTierOf(score: number): Receptivity {
  if (score >= RECEPTIVITY_TIER_STEP) return "open";
  if (score <= -RECEPTIVITY_TIER_STEP) return "closed";
  return "wary";
}

/**
 * 눈금 넷의 합 — 감독과의 관계 등급(−2~+2) · 열린 불만(−1) · 직전 경기(자기 평점
 * 호조 +1 · 팀 패배 −1) · 원형(±1).
 */
export function receptivityOf(state: GameState, playerId: string): ReceptivityRead {
  const reasons: string[] = [];
  let score = 0;

  const relation: RelationTier = relationTierOf(state, MANAGER_SUBJECT, playerId);
  const step = RECEPTIVITY_RELATION_STEP[relation];
  score += step;
  // 기여가 0인 가운데 둘은 근거가 아니다 — 매 줄에 「무난한 사이」가 서면 사실 줄이 잡음이 된다
  if (step !== 0) reasons.push(`relation:${relation}`);

  if (state.issues.some((i) => i.gamePlayerId === playerId)) {
    score -= 1;
    reasons.push("issue");
  }

  const match = recentMatchOf(state);
  if (match?.result) {
    const rating = match.result.ratings?.[playerId];
    if (rating !== undefined && rating >= RECEPTIVITY_HOT_RATING) {
      score += 1;
      reasons.push("rating:hot");
    }
    const home = match.homeTeamId === state.userTeamId;
    const ours = home ? match.result.homeGoals : match.result.awayGoals;
    const theirs = home ? match.result.awayGoals : match.result.homeGoals;
    if (ours < theirs) {
      score -= 1;
      reasons.push("last-match:loss");
    }
  }

  const player = playerById(state, playerId);
  if (player) {
    const key = playerArchetypeOf(state.seed, player);
    const shift = archetypeShift(key);
    if (shift !== 0) {
      score += shift;
      reasons.push(`archetype:${key}`);
    }
  }

  /**
   * 관계의 양 끝은 눈금의 합을 이긴다 — 틀어진 선수가 직전 경기의 평점 하나로
   * 「경계」까지 오르면, 사이를 뒤집으려면 두 번은 있어야 한다는 관계 표의 규약
   * (people.md §6)이 여기서 새로 뚫린다.
   */
  const tier =
    relation === "trusted" ? "open" : relation === "hostile" ? "closed" : receptivityTierOf(score);
  return { tier, score, reasons };
}

/** 근거 코드 → 사람이 읽는 말 — 프롬프트·도구 결과의 사실 줄이 읽는다 */
function reasonKo(code: string): string {
  if (code === "issue") return "불만";
  if (code === "rating:hot") return "직전 경기 평점 호조";
  if (code === "last-match:loss") return "직전 경기 패배";
  const [head, tail] = code.split(":");
  if (head === "relation" && tail !== undefined && tail in RELATION_TIER_KO) {
    return RELATION_TIER_KO[tail as RelationTier];
  }
  if (head === "archetype" && tail !== undefined && tail in PLAYER_ARCHETYPE_LABEL) {
    return PLAYER_ARCHETYPE_LABEL[tail as PlayerArchetypeKey];
  }
  return code;
}

/** 프롬프트·도구 결과에 싣는 한 줄 — 예: `수용성 경계 (불만 · 껄끄러운 사이)` */
export function receptivityLine(read: ReceptivityRead): string {
  const why = read.reasons.map(reasonKo).join(" · ");
  return `수용성 ${RECEPTIVITY_KO[read.tier]}${why === "" ? "" : ` (${why})`}`;
}
