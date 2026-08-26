import type {
  GamePlayer,
  Persona,
  PersonaRelation,
  PressStance,
  RelationTier,
} from "@story-fm/domain";
import { RELATION_TIER_RANK, relationTier, stanceOfTier } from "@story-fm/domain";
import { playerById, playersOf, type GameState } from "../core/state";
import { diffDays } from "../core/dates";
import { isClubTeam } from "../data/team-catalog";
import { activeMentorings } from "../squad/mentoring";
import { headCoachOf, ownerOf, reportersOf } from "./persona";

/**
 * **관계 점수** — 사건이 사람 사이를 움직인다 (people.md §6 「관계 점수」).
 *
 * 세이브가 드는 값이지만 장부에 앉는 것은 **움직인 쌍뿐**이다: 줄이 없는 쌍의 값은
 * 원형 축과 원장이 결정적으로 답하는 **첫인상**이다. 그래서 옛 세이브는 빈 배열로
 * 열려도 오늘의 카드가 어제와 같다.
 *
 * 여기 있는 것은 전부 결정적 순수 함수다. 난수도 시각도 LLM도 들어오지 않는다.
 */

/** 감독의 고정 열쇠 — 선수 id도 `characterId`도 아닌 자리라 이름 하나가 필요하다 */
export const MANAGER_SUBJECT = "@manager";

/** 눈금의 양끝 — 0이 중립이다 */
const RELATION_MAX = 100;

const clampRelation = (v: number) => Math.max(-RELATION_MAX, Math.min(RELATION_MAX, Math.round(v)));

/**
 * 원형이 **먼저 보는 축** — 같은 사건을 두고 무엇부터 묻는가.
 *
 * 키는 `persona.ts`의 생성 표가 쓰는 원형 라벨이다. 기자의 `archetype`에는
 * `"타블로이드 · 데일리 버즈"`처럼 매체가 붙고 라벨 안에 공백이 있으므로, 열쇠는
 * 공백을 지운 앞머리다 (`axisOfArchetype`).
 */
const AXIS_OF_ARCHETYPE: Record<string, string> = {
  // 수석코치
  데이터분석가형: "근거",
  야전조련사형: "몸",
  인간관계형: "사람",
  유스육성형: "성장",
  노장전술가형: "경험",
  구단토박이형: "구단",
  // 구단주
  산업가형: "효율",
  투자자형: "자산",
  축구광형: "경기",
  국부펀드형: "위상",
  지역유지형: "연고",
  흥행가형: "화제",
  // 기자
  지역지베테랑: "연고",
  전국지전술기자: "경기",
  타블로이드: "화제",
};

/**
 * 축의 짝 — **무순서 쌍 하나에 한 줄**. 표는 여기 한 곳뿐이다.
 *
 * 나열되지 않은 짝은 중립이라 관계를 만들지 않는다 — 카드에 서는 것은 결이 통하거나
 * 부딪히는 사이뿐이고, 열두 축을 전부 적으면 카드가 목록이 된다.
 */
const ALIGNED_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["근거", "효율"],
  ["근거", "자산"],
  ["구단", "연고"],
  ["사람", "연고"],
  ["성장", "자산"],
  ["경험", "위상"],
  ["몸", "경기"],
  ["경험", "경기"],
];

const TENSE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["사람", "효율"],
  ["구단", "효율"],
  ["구단", "자산"],
  ["근거", "화제"],
  ["성장", "화제"],
  ["경험", "화제"],
];

/** 무순서 쌍의 열쇠 — 로케일에 기대지 않는 코드포인트 비교여야 어디서나 같다 */
function pairKey(a: string, b: string): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}

const STANCE_OF_PAIR = new Map<string, PersonaRelation["stance"]>([
  ...ALIGNED_PAIRS.map(([a, b]) => [pairKey(a, b), "aligned"] as const),
  ...TENSE_PAIRS.map(([a, b]) => [pairKey(a, b), "tense"] as const),
]);

/** 원형 라벨 → 축. 매체가 붙은 기자 원형은 앞머리만 보고, 라벨의 공백은 무시한다 */
function axisOfArchetype(archetype: string): string | undefined {
  const label = archetype.split("·")[0] ?? "";
  return AXIS_OF_ARCHETYPE[label.replace(/\s+/gu, "")];
}

/** 두 원형 사이의 결 — 같은 축은 통하고, 표에 없는 짝은 중립이다 */
function stanceOf(ours: string, theirs: string): PersonaRelation["stance"] | undefined {
  if (ours === theirs) return "aligned";
  return STANCE_OF_PAIR.get(pairKey(ours, theirs));
}

/**
 * 관계가 서는 사람들 — **세이브의 페르소나뿐**이다 (코치 · 구단주 · 기자단).
 *
 * 선수와 세계 인물 명부는 대상이 아니다: 사이의 결은 매일 같은 건물에서 마주치는
 * 사람들의 것이고, 명부에는 원형 표가 없어 축이 나오지 않는다.
 *
 * 순서는 고정이다 — 코치 → 구단주 → 기자단. 카드에 실리는 줄의 순서가 세이브를 다시
 * 열 때마다 달라지면 같은 인물지가 두 판이 된다.
 */
function relationPersonas(state: GameState): Persona[] {
  return [headCoachOf(state), ownerOf(state), ...reportersOf(state)];
}

/**
 * 저장 페르소나끼리의 관계 줄 — **원형의 축을 함께 든다.**
 *
 * 등급은 점수가 정하고(`relationTierOf`), 축은 그 사이가 어디서 시작했는지를 말한다.
 * 중립은 서지 않는다: 카드에 오르는 것은 결이 통하거나 부딪히는 사이뿐이다.
 */
export function personaRelations(state: GameState, characterId: string): PersonaRelation[] {
  const personas = relationPersonas(state);
  const self = personas.find((p) => p.characterId === characterId);
  if (!self) return [];
  const ours = axisOfArchetype(self.archetype);
  if (ours === undefined) return [];

  const relations: PersonaRelation[] = [];
  for (const other of personas) {
    if (other.characterId === self.characterId) continue;
    const theirs = axisOfArchetype(other.archetype);
    if (theirs === undefined) continue;
    const tier = relationTierOf(state, self.characterId, other.characterId);
    const stance = stanceOfTier(tier);
    if (stance === null) continue;
    relations.push({
      characterId: other.characterId,
      name: other.name,
      stance,
      tier,
      ours,
      theirs,
    });
  }
  return relations;
}

/**
 * **감독이 세운 사이** — 서 있는 멘토링만 (people.md §5-3).
 *
 * `personaRelations`와 갈라져 있는 것은 근거가 다르기 때문이다. 저쪽은 원형 축에서
 * 뽑힌 첫인상이고 이쪽은 **감독이 그렇게 정했다**는 사실 하나라, `ours`·`theirs`가
 * 서지 않는다 — 선수에게는 결을 뽑을 원형 표가 없고 멘토링은 그 표를 필요로 하지도
 * 않는다. 선수에게 관계가 서는 첫 자리다.
 *
 * `characterId`는 선수의 경우 **이름**이므로(`personaFrom`) 우리 선수단에서 이름으로
 * 찾는다. 순서는 장부 순이라 세이브를 다시 열어도 같다.
 *
 * ⚠️ **날짜도 수치도 싣지 않는다** — 카드는 이력에 굳으므로(§6) 변하는 값이 들어가면
 * 3주 전 카드가 오늘의 사실인 척한다. 며칠째인가는 사실 카드가 매 턴 새로 낸다.
 */
export function mentoringRelations(state: GameState, characterId: string): PersonaRelation[] {
  const self = playersOf(state, state.userTeamId).find((p) => p.name === characterId);
  if (!self) return [];

  const relations: PersonaRelation[] = [];
  for (const pair of activeMentorings(state)) {
    const bond = pair.mentorId === self.id ? "mentor" : pair.menteeId === self.id ? "mentee" : null;
    if (bond === null) continue;
    const other = playerById(state, bond === "mentor" ? pair.menteeId : pair.mentorId);
    if (!other) continue;
    /**
     * `stance`는 등급이 아니라 **감독이 그렇게 정했다**는 사실이 정한다 — 그것이 이
     * 줄의 근거다. 등급은 중립이 아닐 때만 얹혀 「붙여 준 사이인데 틀어졌다」가 카드에
     * 설 수 있게 한다.
     */
    const tier = relationTierOf(state, self.id, other.id);
    relations.push({
      characterId: other.name,
      name: other.name,
      stance: "aligned",
      ...(tier === "neutral" ? {} : { tier }),
      bond,
    });
  }
  return relations;
}

// ── 점수 ──────────────────────────────────────────────────────

/** 원형 짝이 까는 첫인상의 폭 — `aligned`는 +, `tense`는 − 이 값이다 */
const ARCHETYPE_IMPRESSION = 30;

/** 같은 협회에서 자란 동포 — 첫날의 라커룸을 가르는 유일한 사실이다 */
const SAME_ASSOCIATION = 20;

/** 같은 구단에서 함께 보낸 **한 해**마다 붙는 폭과 그 상한 */
const TOGETHER_PER_YEAR = 8;
const TOGETHER_CAP = 24;
const DAYS_PER_YEAR = 365;

/**
 * **한 사건이 옮길 수 있는 폭** — 표의 어느 줄도 이것을 넘지 않는다 (people.md §6).
 *
 * 등급 한 칸이 20이므로 한 번으로는 칸을 건너지 못한다: 사이가 뒤집히려면 같은 일이
 * 두 번은 있어야 한다. 폭을 이름 하나로 잰다는 것이 곧 그 규약이다.
 */
export const RELATION_EVENT_BOUND = 12;

/**
 * 사건 → 점수. **표는 여기 하나뿐이다** (people.md §6 「사건 표」).
 *
 * 전부 코어가 이미 판정하는 자리다 — 새 판정을 세우지 않는다. 0인 줄을 지우지 않는
 * 이유는 「아무것도 아니었던 대화」가 사건 목록에서 빠지면 부르는 쪽이 그 자리에서
 * 무엇을 해야 하는지 다시 정해야 하기 때문이다.
 */
export const RELATION_EVENTS = {
  // 면담 — 결과가 폭을 정한다 (career.md §2)
  "talk-motivated": 6,
  "talk-reassured": 5,
  "talk-neutral": 0,
  "talk-disappointed": -5,
  "talk-angered": -10,
  // 스탠스 — 회견의 지목과 다가옴의 응대가 같은 표를 탄다 (people.md §4 · §8)
  "stance-defend": 8,
  "stance-own": 4,
  "stance-deflect": 0,
  "stance-bold": -2,
  "stance-criticise": -10,
  /** 답하지 않았다 — 방치도 돌려보냄도 그 사람이 겪은 일이다 */
  "stance-none": -7,
  // 감독의 결정
  "captain-named": 10,
  "promise-kept": 8,
  "promise-broken": -12,
  /** 가까운 동료가 팀을 떠났다 — 남은 사람이 감독을 보는 눈이다 */
  "teammate-gone": -6,
  // 보드 (career.md §5)
  "board-warned": -10,
  "board-eased": 6,
  "demand-met": 8,
  "demand-failed": -10,
} as const satisfies Record<string, number>;
export type RelationEvent = keyof typeof RELATION_EVENTS;

/**
 * 스탠스 한 줄이 관계 사건이 된다 — `null`은 답하지 않은 자리다.
 *
 * 이름을 붙여 넘기는 것이 곧 완결성 검사다: 스탠스가 하나 늘면 표에 줄이 없어
 * 컴파일이 멈춘다.
 */
export function stanceRelationEvent(stance: PressStance | null): RelationEvent {
  return stance === null ? "stance-none" : `stance-${stance}`;
}

/** 무순서 쌍의 정규형 — `a < b`(코드포인트)라야 어느 순서로 물어도 한 줄이다 */
function pairOf(a: string, b: string): { a: string; b: string } {
  return a < b ? { a, b } : { a: b, b: a };
}

/**
 * 선수별 **이 구단에 선 날**의 재료 — 원장과 계약을 각각 **한 번씩만** 훑는다.
 *
 * 쌍마다 원장을 다시 훑으면 카드 한 장이 스쿼드 크기만큼 원장을 훑는다. 이력을 다시
 * 그리는 턴에는 그 카드가 수십 장이라, 한 번의 프롬프트가 원장을 수백 번 훑게 된다.
 */
interface JoinIndex {
  /** 그 선수의 **마지막 이동** — 지금 소속이 곧 그 이동의 도착지다 (은퇴는 도착지가 없다) */
  lastMove: Map<string, { toTeamId: string | null; date: string }>;
  /** 그 선수의 **가장 이른 계약 시작일** — 한 번도 옮기지 않은 사람의 답이다 */
  firstContract: Map<string, string>;
}

function joinIndexOf(state: GameState): JoinIndex {
  const lastMove = new Map<string, { toTeamId: string | null; date: string }>();
  for (const move of state.transfers) {
    lastMove.set(move.gamePlayerId, { toTeamId: move.toTeamId, date: move.date });
  }
  const firstContract = new Map<string, string>();
  for (const contract of state.contracts) {
    const seen = firstContract.get(contract.gamePlayerId);
    if (seen === undefined || contract.since < seen) {
      firstContract.set(contract.gamePlayerId, contract.since);
    }
  }
  return { lastMove, firstContract };
}

/**
 * 그 사람이 이 구단에 선 날 — 원장의 마지막 이동, 없으면 **가장 이른 계약**의 시작일.
 *
 * ⚠️ **재계약이 이 날을 되돌리지 않게 하는 것이 두 번째 줄이다.** 재계약은 새 계약을
 * 쓰므로(`transfer.md` §5) 지금 계약의 `since`를 읽으면 십 년을 뛴 원클럽맨이 재계약한
 * 날 신입이 된다. 한 번도 옮기지 않은 사람의 계약은 전부 이 구단의 것이라 가장 이른
 * 것이 곧 그가 선 날이다.
 */
function joinedOn(player: GamePlayer, index: JoinIndex): string | null {
  const move = index.lastMove.get(player.id);
  if (move && move.toTeamId === player.teamId) return move.date;
  return index.firstContract.get(player.id) ?? null;
}

/**
 * 두 선수의 첫인상 — **같은 협회와 함께 보낸 해** (people.md §6).
 *
 * ⚠️ **지금 같은 구단일 때만이고, 함께 뛴 기간도 지금 구단에서만 센다.** 원장 이전은
 * 한 덩어리의 모름이라(`EPOCH` — transfer.md §4) 그것을 기간으로 읽으면 시드가 세운
 * 스쿼드 전원이 첫날부터 평생의 친구가 된다. 옛 구단에서 겹친 이력은 설득의
 * `reunion` 주장이 걷는다 — 거기서는 겹쳤는가만 물으므로 덩어리를 읽어도 상하지 않는다.
 */
function teammateImpression(
  state: GameState,
  a: GamePlayer,
  b: GamePlayer,
  index: JoinIndex,
): number {
  if (a.teamId !== b.teamId || !isClubTeam(a.teamId)) return 0;
  const association =
    a.homegrownCountry !== undefined && a.homegrownCountry === b.homegrownCountry
      ? SAME_ASSOCIATION
      : 0;
  const since = [joinedOn(a, index), joinedOn(b, index)].filter((d) => d !== null);
  if (since.length < 2) return association;
  const from = since[0]! > since[1]! ? since[0]! : since[1]!;
  const years = Math.floor(Math.max(0, diffDays(from, state.date)) / DAYS_PER_YEAR);
  return association + Math.min(TOGETHER_CAP, years * TOGETHER_PER_YEAR);
}

/**
 * 줄이 없는 쌍의 값 — **결정적으로 파생한 첫인상** (people.md §6).
 *
 * 감독은 어느 쪽으로도 0에서 시작한다: 방금 부임한 사람에게 첫인상을 지어 주면
 * 그가 아무것도 하지 않은 자리가 이미 사이가 된다.
 */
function initialRelation(state: GameState, a: string, b: string, index?: JoinIndex): number {
  if (a === MANAGER_SUBJECT || b === MANAGER_SUBJECT) return 0;

  const playerA = playerById(state, a);
  const playerB = playerById(state, b);
  if (playerA && playerB) {
    return teammateImpression(state, playerA, playerB, index ?? joinIndexOf(state));
  }
  if (playerA || playerB) return 0;

  const personas = relationPersonas(state);
  const self = personas.find((p) => p.characterId === a);
  const other = personas.find((p) => p.characterId === b);
  if (!self || !other) return 0;
  const ours = axisOfArchetype(self.archetype);
  const theirs = axisOfArchetype(other.archetype);
  if (ours === undefined || theirs === undefined) return 0;
  const stance = stanceOf(ours, theirs);
  if (stance === undefined) return 0;
  return stance === "aligned" ? ARCHETYPE_IMPRESSION : -ARCHETYPE_IMPRESSION;
}

/**
 * 지금 두 사람 사이의 점수 — 장부의 줄이 있으면 그것, 없으면 첫인상.
 *
 * `index`는 여러 쌍을 잇달아 묻는 자리가 원장을 한 번만 훑게 하는 재료다. 한 쌍만
 * 묻는 자리는 넘기지 않아도 된다 — 그때만 여기서 만든다.
 */
export function relationOf(state: GameState, a: string, b: string, index?: JoinIndex): number {
  if (a === b) return 0;
  const key = pairOf(a, b);
  const row = (state.relations ?? []).find((r) => r.a === key.a && r.b === key.b);
  return row?.score ?? initialRelation(state, key.a, key.b, index);
}

/** 지금 두 사람 사이의 등급 — 카드도 계수도 전부 이것을 읽는다 */
export function relationTierOf(
  state: GameState,
  a: string,
  b: string,
  index?: JoinIndex,
): RelationTier {
  return relationTier(relationOf(state, a, b, index));
}

/**
 * 사건 하나가 사이를 옮긴다 — **장부에 줄이 생기는 유일한 자리다.**
 *
 * 폭이 0인 사건은 아무것도 하지 않는다: 「아무것도 아니었던 대화」가 줄을 만들면
 * 세이브가 움직이지 않은 쌍으로 채워진다.
 */
export function moveRelation(state: GameState, a: string, b: string, event: RelationEvent): void {
  const delta = RELATION_EVENTS[event];
  if (delta === 0 || a === b) return;
  const key = pairOf(a, b);
  const rows = (state.relations ??= []);
  const row = rows.find((r) => r.a === key.a && r.b === key.b);
  const score = clampRelation((row?.score ?? initialRelation(state, key.a, key.b)) + delta);
  if (row) {
    row.score = score;
    row.updatedOn = state.date;
    return;
  }
  rows.push({ ...key, score, updatedOn: state.date });
}

/**
 * 그 사람이 나오는 줄을 전부 지운다 — 떠난 선수의 자리 (`clearDepartedState`).
 *
 * 그 뒤 사흘의 심경 카드가 「가까웠는가」를 물으면 첫인상이 답한다: 함께 뛴 해도
 * 협회도 원장에 남아 있어 파생이 상하지 않는다 (people.md §6).
 */
export function clearRelationsOf(state: GameState, subject: string): void {
  if (state.relations === undefined) return;
  state.relations = state.relations.filter((r) => r.a !== subject && r.b !== subject);
}

// ── 곱해지는 자리 (people.md §6) ───────────────────────────────

/** 사이가 최악일 때의 계수 — 말이 통하지 않아도 완전히 죽지는 않는다 */
export const RELATION_FACTOR_FLOOR = 0.7;
/** 사이가 가장 좋을 때 더해지는 폭 — 바닥과 합쳐 0.7~1.3, 리더십 계수와 같은 자다 */
export const RELATION_FACTOR_SPAN = 0.6;

/** 등급의 폭 — 순위 −2~+2를 0~1로 편다 */
const TIER_RANGE = RELATION_TIER_RANK.trusted - RELATION_TIER_RANK.hostile;

/**
 * **그 말을 듣는 사람** — 면담의 사기 델타에 곱해진다 (career.md §2).
 *
 * ⚠️ **부호를 가리지 않는다** — 리더십 계수·라커룸 계수와 같은 규약이다. 믿는 선수는
 * 칭찬도 질책도 크게 듣고, 틀어진 선수는 어느 쪽도 흘려 듣는다.
 */
export function relationFactor(state: GameState, a: string, b: string): number {
  const rank = RELATION_TIER_RANK[relationTierOf(state, a, b)];
  return (
    RELATION_FACTOR_FLOOR +
    ((rank - RELATION_TIER_RANK.hostile) / TIER_RANGE) * RELATION_FACTOR_SPAN
  );
}

/**
 * **사이가 나쁜 선수의 불만이 더 빨리 쌓인다** — 압력의 하루 증가량에 곱해진다
 * (people.md §8). 리더 배수와 같은 자리에 함께 곱해지고 같은 규약을 지킨다:
 * 식는 쪽에도, 불만이 아닌 주제에도 걸리지 않는다.
 *
 * 계수를 뒤집어 쓰지 않고 표를 따로 두는 것은 방향이 반대이기 때문이다 — 잘 통하는
 * 사이는 말이 크게 울리되(위) 불만은 늦게 쌓인다(아래).
 */
export const RELATION_PRESSURE_WEIGHT: Record<RelationTier, number> = {
  hostile: 1.3,
  strained: 1.15,
  neutral: 1,
  close: 0.9,
  trusted: 0.8,
};

export function relationPressureWeight(state: GameState, playerId: string): number {
  return RELATION_PRESSURE_WEIGHT[relationTierOf(state, MANAGER_SUBJECT, playerId)];
}

/**
 * 떠난 사람과 **`close` 이상**이던 우리 선수들 — 계약 해지의 심경 카드가 걸리는 범위
 * (people.md §5). 라커룸 전원이 같은 무게로 드는 사실이 아니다.
 */
export function closeTo(state: GameState, subject: string): GamePlayer[] {
  const index = joinIndexOf(state);
  return playersOf(state, state.userTeamId).filter(
    (p) => p.id !== subject && RELATION_TIER_RANK[relationTierOf(state, subject, p.id, index)] > 0,
  );
}

// ── 카드에 서는 줄 (people.md §6) ─────────────────────────────

/**
 * 한 인물 카드에 서는 관계 줄의 상한 — 넷.
 *
 * 관계가 선수에게까지 서면서 후보가 스쿼드 전체로 늘었다. 자르지 않으면 인물지가
 * 관계 목록이 되고, 성격도 말투도 그 아래로 밀린다.
 */
export const RELATION_CARD_LIMIT = 4;

/** 이 인물이 점수 장부에서 갖는 열쇠 — 저장 페르소나는 `characterId`, 우리 선수는 id */
function subjectOfCharacter(state: GameState, characterId: string): string | null {
  if (relationPersonas(state).some((p) => p.characterId === characterId)) return characterId;
  return playersOf(state, state.userTeamId).find((p) => p.name === characterId)?.id ?? null;
}

/** 이 카드에서 상대가 불리는 이름 — 카드의 열쇠는 선수의 경우 **이름**이다 */
interface Counterpart {
  subject: string;
  characterId: string;
  name: string;
}

function counterpartsOf(state: GameState): Counterpart[] {
  const rows: Counterpart[] = [
    { subject: MANAGER_SUBJECT, characterId: state.manager.name, name: state.manager.name },
  ];
  for (const persona of relationPersonas(state)) {
    rows.push({
      subject: persona.characterId,
      characterId: persona.characterId,
      name: persona.name,
    });
  }
  for (const player of playersOf(state, state.userTeamId)) {
    rows.push({ subject: player.id, characterId: player.name, name: player.name });
  }
  return rows;
}

/**
 * 점수가 세운 관계 줄 — **감독과의 사이가 맨 앞이다** (people.md §6).
 *
 * 그 뒤는 사이가 센 순서이고, 같으면 열쇠의 코드포인트 순이라 세이브를 다시 열어도
 * 같은 카드가 나온다. 중립은 서지 않는다.
 */
export function scoreRelations(state: GameState, characterId: string): PersonaRelation[] {
  const self = subjectOfCharacter(state, characterId);
  if (self === null) return [];

  const index = joinIndexOf(state);
  const rows: { row: PersonaRelation; score: number; subject: string }[] = [];
  for (const other of counterpartsOf(state)) {
    if (other.subject === self) continue;
    const score = relationOf(state, self, other.subject, index);
    const tier = relationTier(score);
    const stance = stanceOfTier(tier);
    if (stance === null) continue;
    rows.push({
      row: { characterId: other.characterId, name: other.name, stance, tier },
      score,
      subject: other.subject,
    });
  }

  const manager = rows.find((r) => r.subject === MANAGER_SUBJECT);
  const rest = rows
    .filter((r) => r.subject !== MANAGER_SUBJECT)
    .sort(
      (x, y) =>
        Math.abs(y.score) - Math.abs(x.score) ||
        (x.subject < y.subject ? -1 : x.subject > y.subject ? 1 : 0),
    );
  return [...(manager ? [manager] : []), ...rest].map((r) => r.row);
}
