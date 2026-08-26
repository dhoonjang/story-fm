import type { Persona, PersonaRelation } from "@story-fm/domain";
import { playerById, playersOf, type GameState } from "../core/state";
import { activeMentorings } from "../squad/mentoring";
import { headCoachOf, ownerOf, reportersOf } from "./persona";

/**
 * 페르소나 사이의 관계 초기값 — **원형 조합에서 결정적으로 나온다** (people.md §6).
 *
 * 세이브에 저장하지 않는다: 원형이 세이브당 불변이므로 관계도 파생이다. 사건이
 * 관계를 움직이는 점수는 아직 없다 — 이 값은 **첫인상**이고, 그 뒤에 있었던 일은
 * 인물별 기억이 갖는다 (§9-1).
 *
 * 여기 있는 것은 전부 결정적 순수 함수다. 난수도 시각도 LLM도 들어오지 않는다.
 */

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

/** characterId의 페르소나가 다른 저장 페르소나(코치·구단주·기자단)와 갖는 비중립 관계 — 결정적 */
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
    const stance = stanceOf(ours, theirs);
    if (stance === undefined) continue;
    relations.push({ characterId: other.characterId, name: other.name, stance, ours, theirs });
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
    relations.push({ characterId: other.name, name: other.name, stance: "aligned", bond });
  }
  return relations;
}
