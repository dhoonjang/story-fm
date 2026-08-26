import type {
  CharacterDepth,
  CharacterEntry,
  CharacterInjection,
  CharacterMemory,
  Negotiation,
  Persona,
  PersonaRelation,
} from "@story-fm/domain";
import { isDeeperThan } from "@story-fm/domain";
import type { GameState } from "../core/state";
import { pendingApproach } from "../club/approach";
import { pendingPress } from "../club/press";
import { knowledgeOf, type Knowledge } from "../squad/scouting";
import {
  generateVirtualManager,
  headCoachOf,
  isFamousPlayer,
  ownerOf,
  reportersOf,
  worldFigureByName,
  worldFigures,
} from "./persona";
import { generatePlayerPersona, retiredPersona } from "./player-persona";
import {
  mentoringRelations,
  personaRelations,
  RELATION_CARD_LIMIT,
  scoreRelations,
} from "./relations";

/**
 * 캐릭터북 — **「이 인물이 지금 필요하다」를 판정해 그 턴에만 싣는다** (people.md §6).
 *
 * 인물 카드에는 두 상태밖에 없었다: 레퍼런스 층에 늘 서 있거나(코치·구단주·기자단)
 * 아예 없거나(선수). 상주하는 쪽은 회견도 협상도 없는 턴에 매번 읽히고, 없는 쪽은
 * 같은 선수가 턴마다 다른 사람이 된다. 그 사이가 여기다.
 *
 * ⚠️ **레퍼런스에서 조건부로 넣었다 뺐다 하는 길은 막혀 있다** — 레퍼런스는 캐시
 * 프리픽스라 한 턴 카드를 끼우면 그 턴의 레퍼런스와 그 뒤 이력이 통째로 무효가 된다
 * (→ ../llm/agents.md §5). 그래서 카드는 **이번 턴 층**으로 들어가고 다음 턴부터
 * 이력의 일부가 된다 — 비용이 등장한 인물 수에 비례하지 턴 수에 비례하지 않는다.
 *
 * 여기 있는 것은 전부 결정적 순수 함수다. 난수도 시각도 LLM도 들어오지 않는다.
 */

/** 한 턴에 세울 수 있는 카드 — 넷째부터는 이번 턴 발화가 읽히기 전에 프롬프트를 채운다 */
export const CHARACTER_INJECTION_LIMIT = 3;

/**
 * 훑는 이력의 길이 — **직전 모델 턴 하나**다.
 *
 * 창이 짧아도 새는 것이 없다: 매 턴 훑고, 한 번 걸린 카드는 이력에 남아 이력 창이
 * 미끄러질 때까지 그대로 서 있다. 길게 잡으면 이미 서 있는 카드를 매 턴 다시 계산할 뿐이다.
 */
const HISTORY_WINDOW_TURNS = 1;

/** 한 글자짜리 키워드는 어느 문장에나 걸린다 — 키워드가 되지 못한다 (people.md §6) */
const MIN_KEYWORD_LENGTH = 2;

/**
 * 상한에 걸렸을 때 자르는 순서 — 작을수록 먼저 선다.
 *
 * 세계가 연 자리가 감독의 이번 발화보다 앞선다: 회견장에 앉은 기자는 감독이 이름을
 * 부르지 않아도 이번 턴에 말해야 하는 사람이다.
 */
const RANK_POINTED = 0;
const RANK_MESSAGE = 1;
const RANK_HISTORY = 2;

/**
 * 같은 자리 안의 순서 — **우리 사람이 먼저 선다** (people.md §6).
 *
 * 후보가 우리 선수단 밖으로 넓어지면서 한 턴 3장을 두고 겹이 다툰다. 자리가 먼저이고
 * (지목 → 이번 턴 발화 → 직전 턴), 자리가 같을 때 라커룸 쪽이 앞선다: 한 문장에
 * 우리 선수 셋과 남의 팀 이름 하나가 함께 있으면 감독이 매일 보는 셋이 선다.
 */
const NEAR_OURS = 0;
const NEAR_WORLD = 1;

/**
 * 끝난 협상 — 나머지(`open`·`agreed`)는 아직 테이블에 사람이 앉아 있다.
 * `speakerRoles`와 같은 목록을 같은 방향(빼는 쪽)으로 든다 — 상태가 하나 늘어도
 * 화자가 조용히 사라지지 않는다.
 */
const CLOSED_NEGOTIATION = new Set<string>([
  "completed",
  "rejected",
  "expired",
] satisfies Negotiation["status"][]);

/**
 * 지식 눈금 → 인물지의 깊이 (people.md §6).
 *
 * 새 눈금을 만들지 않고 `Knowledge` 다섯을 셋으로 접는다 — `scouted`와 `seen`의
 * 인물지가 같기 때문이다. 주입 기록이 눈금이 아니라 깊이를 남기므로 **같은 판을 두 번
 * 싣지 않고**, 깊이가 실제로 달라졌을 때만 다시 싣는다.
 */
const DEPTH_OF_KNOWLEDGE: Record<Knowledge, CharacterDepth> = {
  own: "full",
  adapting: "full",
  scouted: "outline",
  seen: "outline",
  rumoured: "rumour",
};

export function characterDepthOf(knowledge: Knowledge): CharacterDepth {
  return DEPTH_OF_KNOWLEDGE[knowledge];
}

/**
 * 페르소나 → 인물지. **깊이가 무엇을 덜어낼지 정한다.**
 *
 * ⚠️ 변하는 값(폼·컨디션·부상·심경·계약·관측 능력치)은 한 톨도 들어오지 않는다 —
 * 주입한 카드는 이력에 굳으므로 3주 뒤 모델이 낡은 사실로 말하게 된다. 지금의 사실은
 * 발화 직전의 조회가 낸다 (people.md §6).
 */
export function characterEntry(
  persona: Persona,
  depth: CharacterDepth,
  memories: readonly CharacterMemory[] = [],
): CharacterEntry {
  const entry: CharacterEntry = {
    characterId: persona.characterId,
    name: persona.name,
    role: persona.role,
    archetype: persona.archetype,
    traits: [...persona.traits],
    depth,
  };
  if (persona.outlet !== undefined) entry.outlet = persona.outlet;
  if (persona.real !== undefined) entry.real = persona.real;
  // 기억은 깊이가 가르지 않는다 — 소문으로만 아는 사람이라도 **그 대화에 있었던 일**은
  // 감독이 겪은 것이다. 깊이가 정하는 것은 그 사람의 안쪽(동기·말투)까지 아는가다
  if (memories.length > 0) entry.memories = [...memories];
  // 소문으로만 아는 사람은 원형과 성격까지다 — 말투를 주면 모델이 만난 적 없는
  // 사람의 목소리를 낸다
  if (depth === "rumour") return entry;
  // 눈으로 본 사람은 말투 지문까지. 예시 대사와 동기는 라커룸에서 매일 보는 사이의 것이다
  entry.speechStyle = {
    note: persona.speechStyle.note,
    samples: depth === "full" ? [...persona.speechStyle.samples] : [],
  };
  if (depth === "full") entry.motivation = persona.motivation;
  return entry;
}

/**
 * 기록된 주입을 인물지로 되돌린다 — **이력을 다시 렌더링할 때의 입구**다.
 *
 * 세이브에는 카드 텍스트가 아니라 기록(`characterId` + 깊이)만 남으므로, 그 턴을
 * 다시 그릴 때 같은 인물지를 여기서 되찾는다. 깊이는 **그때의 것**을 쓴다 — 지금
 * 눈금으로 다시 접으면 3주 전 이력이 오늘의 지식으로 소급해 자세해진다.
 *
 * ⚠️ **기억은 붙이지 않는다.** 여기 붙는 것은 세이브당 불변인 것뿐이어야 한다 —
 * 압축이 더하는 기억을(§9-1) 지금 값으로 붙이면 압축 한 번에 지난 턴들의 바이트가
 * 함께 달라져, 요약 블록만 무효가 되면 될 것이 이력 전체로 번진다
 * (→ ../../../../docs/llm/agents.md §5). 기억은 카드가 실리는 그 턴 층에만 서고
 * (`selectCharacters`), 늘어난 기억은 재주입이 나른다.
 *
 * 이름이 세계에서 사라졌으면(방출된 선수) `null`이다 — 그 턴은 카드 없이 그려진다.
 */
export function characterEntryOf(
  state: GameState,
  characterId: string,
  depth: CharacterDepth,
): CharacterEntry | null {
  const persona = personaOf(state, characterId);
  if (!persona) return null;
  return withRelations(state, characterEntry(persona, depth));
}

/**
 * 인물지에 관계를 붙인다 — **`full` 깊이에만** (people.md §6 · §5-3).
 *
 * `characterEntry`가 아니라 여기서 붙이는 이유는 관계가 세이브의 다른 사람을 봐야
 * 나오기 때문이다 — 순수 함수인 그쪽은 상대가 누구인지 모른다. 비면 필드 자체를
 * 두지 않는다: 중립뿐인 사이는 카드에 서지 않는다.
 *
 * 세 벌이 이어 붙되 **한 상대에 한 줄이고, 먼저 온 줄이 자리를 지킨다.** 근거가
 * 풍부한 순서다: 원형 축을 든 저장 페르소나끼리 → 감독이 세운 멘토링 → 점수만 든
 * 나머지(감독과의 사이 · 우리 선수). 같은 쌍이 두 벌에 걸리면 축이나 `bond`를 든
 * 앞줄이 남고, 등급은 어느 줄이든 같은 점수에서 나오므로 갈리지 않는다.
 */
function withRelations(state: GameState, entry: CharacterEntry): CharacterEntry {
  if (entry.depth !== "full") return entry;
  const rows = new Map<string, PersonaRelation>();
  for (const relation of [
    ...personaRelations(state, entry.characterId),
    ...mentoringRelations(state, entry.characterId),
    ...scoreRelations(state, entry.characterId),
  ]) {
    if (!rows.has(relation.characterId)) rows.set(relation.characterId, relation);
  }
  const relations = [...rows.values()].slice(0, RELATION_CARD_LIMIT);
  return relations.length > 0 ? { ...entry, relations } : entry;
}

/**
 * 그 인물의 기억 — 압축이 남긴 것들 (people.md §9-1).
 *
 * **이번 턴에 세우는 카드만 읽는다.** 이력을 다시 그리는 `characterEntryOf`는 여기
 * 오지 않는다 — 지난 턴의 카드에 지금의 기억을 붙이면 압축이 지난 턴들의 바이트를
 * 함께 바꾼다 (agents.md §5).
 */
function memoriesOf(state: GameState, characterId: string): CharacterMemory[] {
  return (state.characterMemories ?? []).filter((m) => m.characterId === characterId);
}

/**
 * 이름으로 페르소나를 찾는다 — 저장된 인물이 먼저, 그다음이 파생하는 선수다.
 *
 * ⚠️ **찾는 순서가 곧 이름 충돌의 답이다** (people.md §6). `characterId`는 전역
 * 유일이므로 명부의 이름이 세이브의 현역과 같으면 한 사람만 남는데, 선수를 먼저 보는
 * 이 순서가 `candidatesOf`가 후보를 모으는 순서와 같아야 이력이 그때 실은 카드를
 * 그대로 되찾는다.
 */
function personaOf(state: GameState, characterId: string): Persona | null {
  const saved = (state.personas ?? []).find((p) => p.characterId === characterId);
  if (saved) return saved;
  for (const persona of [headCoachOf(state), ownerOf(state), ...reportersOf(state)]) {
    if (persona.characterId === characterId) return persona;
  }
  const player = state.players.find((p) => p.name === characterId);
  if (player) return generatePlayerPersona(state.seed, player);
  // 은퇴한 사람 — 명단에는 없어도 명부가 그를 안다 (season.md §6). 순서는 `candidatesOf`와 같다
  const retired = (state.retired ?? []).find((r) => r.name === characterId);
  if (retired) return retiredPersona(state.seed, retired);
  const figure = worldFigureByName(state, characterId);
  if (figure) return figure;
  // 타 팀 벤치의 가상 감독 — 후보를 모으는 순서(candidatesOf)의 마지막 겹 그대로
  const bench = state.teams.find((t) => t.id !== state.userTeamId && t.managerName === characterId);
  if (bench?.managerName !== undefined) {
    return generateVirtualManager(state.seed, bench.id, bench.managerName);
  }
  return null;
}

export interface CharacterBookInput {
  /** 이번 턴 감독 발화 — 아직 이력에 없다. "홀란드 불러줘"는 그 턴에 걸려야 한다 */
  message?: string;
  /**
   * 호출자가 지목한 인물 — 세이브가 여는 자리(회견)와 **같은 `RANK_POINTED` 자리**로
   * 합류해 상한·중복 제거·정렬을 그대로 탄다 (people.md §6).
   *
   * 이력도 발화도 없는 턴이 여기를 쓴다: 새 게임 첫 장면은 감독이 코치를 부른 적
   * 없어도 수석코치가 반드시 서는 자리라, 키워드가 걸릴 문장 자체가 없다.
   */
  pointed?: readonly string[];
  /**
   * 이력 창 **안에** 이미 서 있는 카드 — 창 밖으로 밀려난 것은 넘어오지 않는다.
   * 만료 규칙을 따로 두지 않는 자리다: 이력 창이 미끄러지면 여기서 저절로 빠지고,
   * 빠진 카드는 그 순간 다시 주입 대상이 된다.
   */
  injected?: readonly CharacterInjection[];
}

/** 후보 한 명 — 페르소나와 **어느 겹의 사람인가** (people.md §6) */
interface Candidate {
  persona: Persona;
  /** `NEAR_OURS` | `NEAR_WORLD` — 같은 자리에서 상한을 다툴 때의 순서 */
  near: number;
  /**
   * 지금 감독이 아는 만큼 — **뽑힌 뒤에 묻는다.**
   *
   * `knowledgeOf`가 세이브의 경기 기록을 통째로 훑으므로 후보 전원에게 물으면 그
   * 비용이 후보 수에 비례한다. 카드가 되는 것은 최대 세 장이고, 그전에 깊이가
   * 필요한 자리는 이미 서 있는 카드를 다시 실을지 판단할 때뿐이다.
   */
  depthOf: () => CharacterDepth;
}

/**
 * 이번 턴에 실을 인물지 — 최대 `CHARACTER_INJECTION_LIMIT`장.
 *
 * 같은 상태·같은 입력이면 같은 목록, 같은 순서다.
 */
export function selectCharacters(
  state: GameState,
  input: CharacterBookInput = {},
): CharacterEntry[] {
  const message = input.message ?? "";
  const history = historyWindow(state);
  const pointed = pointedIds(state, input.pointed);
  const standing = standingOf(input.injected ?? []);

  const picked: Array<{ rank: number; candidate: Candidate }> = [];
  for (const candidate of candidatesOf(state)) {
    const rank = rankOf(candidate.persona, message, history, pointed);
    if (rank === null) continue;
    const shown = standing.get(candidate.persona.characterId);
    // 창 안에 이미 서 있으면 다시 싣지 않는다. 눈금이 올랐거나 기억이 늘었을 때만 예외다
    if (
      shown !== undefined &&
      !isDeeperThan(candidate.depthOf(), shown.depth) &&
      !hasNewMemories(state, candidate.persona.characterId, shown.memories)
    ) {
      continue;
    }
    picked.push({ rank, candidate });
  }
  // 자리가 먼저, **같은 자리에서는 우리 사람이 먼저** — 상한이 셋이라 이 순서가 곧
  // 누가 밀려나는가다 (people.md §6)
  picked.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.candidate.near - b.candidate.near ||
      compareIds(a.candidate.persona.characterId, b.candidate.persona.characterId),
  );
  return picked
    .slice(0, CHARACTER_INJECTION_LIMIT)
    .map(({ candidate }) =>
      withRelations(
        state,
        characterEntry(
          candidate.persona,
          candidate.depthOf(),
          memoriesOf(state, candidate.persona.characterId),
        ),
      ),
    );
}

/** 걸렸는가, 어느 자리에서 걸렸는가 — 걸리지 않았으면 `null` */
function rankOf(
  persona: Persona,
  message: string,
  history: string,
  pointed: ReadonlySet<string>,
): number | null {
  if (pointed.has(persona.characterId)) return RANK_POINTED;
  if (mentions(message, persona)) return RANK_MESSAGE;
  if (mentions(history, persona)) return RANK_HISTORY;
  return null;
}

/**
 * 후보 — **세 겹**이다 (people.md §6).
 *
 * | 겹              | 누구                                                                    |
 * | --------------- | ----------------------------------------------------------------------- |
 * | 우리 사람       | 세이브의 페르소나 · 우리 선수단 · 협상 테이블에 앉은 상대 선수          |
 * | 이름난 현역     | 종합 `FAMOUS_PLAYER_OVERALL` 이상 · 시장 전용 리그 시드 명단의 이름     |
 * | 세계 인물 명부  | 타 팀 감독(명부 + 가상) · 에이전트 · 해설 (`data/world-figures.ts` · people.md §2) |
 *
 * 리그 4,000명을 **전부** 훑지 않는 이유는 `speakerRoles`가 사전에 전원을 담지 않는
 * 이유와 같다 (people.md §3 원칙 ③): 남의 팀 3군까지 넣으면 동명이인이 늘어 정작
 * 우리 선수가 사라진다. 그래서 이름난 이들만 담고, 담긴 뒤에도 두 장치가 우리 쪽을
 * 지킨다 — **이름이 겹치면 먼저 들어온 쪽이 자리를 지키고**(우리 사람이 먼저다),
 * 상한을 다투면 `near`가 우리 쪽을 앞세운다.
 */
function candidatesOf(state: GameState): Candidate[] {
  const byId = new Map<string, Candidate>();
  const add = (persona: Persona, near: number, depthOf: () => CharacterDepth) => {
    if (!byId.has(persona.characterId)) byId.set(persona.characterId, { persona, near, depthOf });
  };
  const always = (depth: CharacterDepth) => () => depth;
  const asKnown = (playerId: string) => () => characterDepthOf(knowledgeOf(state, playerId));

  // ── 우리 사람 ──
  // 자리가 하나뿐인 인물 — 감독이 매일 보는 사람이라 언제나 `full`이다.
  // 옛 세이브라 비어 있으면 이 함수들이 시드로 그 자리에서 만든다
  add(headCoachOf(state), NEAR_OURS, always("full"));
  add(ownerOf(state), NEAR_OURS, always("full"));
  for (const reporter of reportersOf(state)) add(reporter, NEAR_OURS, always("full"));
  for (const persona of state.personas ?? []) {
    if (persona.role !== "player") add(persona, NEAR_OURS, always("full"));
  }

  // 선수 — 페르소나는 저장되지 않고 (시드, 선수 id)에서 파생하고, 깊이는 지식 눈금이 정한다
  const negotiating = new Set(
    state.negotiations.filter((n) => !CLOSED_NEGOTIATION.has(n.status)).map((n) => n.gamePlayerId),
  );
  for (const player of state.players) {
    if (player.teamId !== state.userTeamId && !negotiating.has(player.id)) continue;
    add(generatePlayerPersona(state.seed, player), NEAR_OURS, asKnown(player.id));
  }

  /**
   * **은퇴한 사람도 우리 사람이다** (people.md §6 · season.md §6). 명단에 없다는 것이
   * 부를 수 없다는 뜻이면 열 해를 뛴 주장이 은퇴한 이튿날 세계에서 사라진다. 깊이는
   * 언제나 `full`이다 — 감독이 몇 해를 데리고 있던 사람이라 안개가 남을 자리가 없고,
   * 지식 눈금은 명단에 있는 선수에게만 답한다. 현역을 먼저 담은 뒤라 이름이 겹치면
   * 현역이 자리를 지킨다.
   */
  for (const retired of state.retired ?? []) {
    add(retiredPersona(state.seed, retired), NEAR_OURS, always("full"));
  }

  // ── 이름난 현역 ── 우리 선수단을 먼저 담은 **뒤**여야 동명이인 자리를 우리가 지킨다
  for (const player of state.players) {
    if (!isFamousPlayer(player.attributes.overall, player.name)) continue;
    add(generatePlayerPersona(state.seed, player), NEAR_WORLD, asKnown(player.id));
  }

  // ── 세계 인물 명부 ── 선수가 아니라 `knowledgeOf`가 답하지 않는 자리다.
  // 원형으로 뽑을 수 없어 성격·말투를 표가 직접 적으므로 깊이는 언제나 `full`이다
  for (const figure of worldFigures(state)) add(figure, NEAR_WORLD, always("full"));

  // ── 가상 감독 ── 명부가 답하지 않는 벤치 — (시드, 팀, 이름)에서 파생한다
  // (people.md §2). 명부 감독의 벤치는 같은 이름이 위에서 이미 자리를 지켰다.
  // 감독은 스카우팅으로 알게 되는 상대가 아니라 깊이는 명부와 같이 `full`이다
  for (const team of state.teams) {
    if (team.id === state.userTeamId || team.managerName === undefined) continue;
    add(generateVirtualManager(state.seed, team.id, team.managerName), NEAR_WORLD, always("full"));
  }

  return [...byId.values()];
}

/**
 * 키워드 일치 — **나열된 것만 본다.**
 *
 * 성만 쓴 "홀란드"를 같은 사람으로 보는 부분 일치는 오탐(동명이인·유사 이름)을
 * 만든다는 `normalizeSpeaker`의 원칙이 여기도 그대로다 — 별칭이 필요하면 페르소나가
 * 키워드로 적는다. 키워드가 없는 페르소나는 이름으로만 걸린다.
 */
function mentions(text: string, persona: Persona): boolean {
  if (text === "") return false;
  const haystack = text.toLowerCase();
  const listed = (persona.keywords ?? []).filter((k) => k.length >= MIN_KEYWORD_LENGTH);
  const terms = listed.length > 0 ? listed : [persona.name];
  return terms.some((t) => t.length >= MIN_KEYWORD_LENGTH && haystack.includes(t.toLowerCase()));
}

/**
 * 훑을 이력 — 직전 모델 턴들의 텍스트.
 *
 * 감독의 이번 발화는 여기 없다: 아직 이력이 아니라 `input.message`로 들어오고,
 * 그 자리가 상한을 자를 때 더 앞선다.
 */
function historyWindow(state: GameState): string {
  const texts: string[] = [];
  for (let i = state.chat.length - 1; i >= 0 && texts.length < HISTORY_WINDOW_TURNS; i -= 1) {
    const turn = state.chat[i];
    if (turn?.role === "model") texts.push(turn.text);
  }
  return texts.join("\n");
}

/**
 * 이번 턴에 지목된 인물 — 세계가 연 자리(열린 회견의 기자, 찾아온 사람)와 호출자가
 * 연 자리(첫 장면의 수석코치). 셋 다 키워드를 기다리지 않는다.
 *
 * ⚠️ 회견의 지목은 나중에 생긴 필드라 **옛 세이브의 회견엔 없다** — 없으면 아무도
 * 지목하지 않은 것이고, 그 회견의 기자는 일반 키워드 경로로만 선다.
 */
function pointedIds(
  state: GameState,
  byCaller: readonly string[] | undefined,
): ReadonlySet<string> {
  const ids = new Set<string>(byCaller ?? []);
  const conference = pendingPress(state);
  const reporterId = conference?.reporterId;
  if (reporterId !== undefined) ids.add(reporterId);
  /**
   * **회견 카드에 오른 상대 감독** — 기자와 같은 자리다 (people.md §4). 그 사람의
   * 말을 인용하라고 카드가 요구해 놓고 인물지를 싣지 않으면, GM이 그 이름으로
   * 즉흥의 말투를 지어낸다 — 캐릭터북이 풀었던 그 문제다.
   */
  for (const fact of conference?.facts ?? []) {
    if (fact.kind !== "rival-quote") continue;
    const name = fact.data?.name;
    if (name !== undefined) ids.add(name);
  }
  // 감독실 문 앞에 서 있는 사람 — 감독이 이름을 부르기를 기다리지 않는다 (people.md §8)
  const speakerId = pendingApproach(state)?.speakerId;
  if (speakerId !== undefined) ids.add(speakerId);
  return ids;
}

/** 창 안에 서 있는 카드가 **이미 보여 준 것** — 재주입은 이보다 깊거나 많아야 한다 */
interface StandingCard {
  /** 가장 자세한 판 */
  depth: CharacterDepth;
  /** 그때 실린 기억 줄 수 — 이 자리가 생기기 전의 기록에는 없다 */
  memories?: number;
}

function standingOf(injected: readonly CharacterInjection[]): Map<string, StandingCard> {
  const standing = new Map<string, StandingCard>();
  for (const record of injected) {
    const shown = standing.get(record.characterId);
    const depth =
      shown === undefined || isDeeperThan(record.depth, shown.depth) ? record.depth : shown.depth;
    // 가장 많이 실린 판이 기준이다 — 재주입이 남긴 기록이 앞선 기록보다 뒤에 온다
    const memories = maxOf(shown?.memories, record.memories);
    standing.set(record.characterId, memories === undefined ? { depth } : { depth, memories });
  }
  return standing;
}

/** 둘 다 없으면 없는 것 — 없는 자리는 0이 아니다 (아래 `hasNewMemories`) */
function maxOf(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * 창 안의 카드가 모르는 기억이 생겼는가 — 재주입의 세 번째 조건 (people.md §6).
 *
 * 기억은 카드가 실리는 그 턴 층에만 서므로(`characterEntryOf`), 카드가 창 안에 서
 * 있는 동안 압축이 적은 기억은 다시 세우지 않으면 모델에 닿지 않는다.
 *
 * ⚠️ **기억 수가 없는 기록은 없는 것으로 둔다.** 0으로 읽으면 이 자리가 생기기 전의
 * 세이브에서 카드가 한꺼번에 다시 선다.
 *
 * 보관 상한(`CHARACTER_MEMORY_KEEP`)에 닿은 인물은 새 기억이 와도 수가 늘지 않아
 * 여기 걸리지 않는다 — 그 갱신은 카드가 창 밖으로 밀려나 다시 서는 자리(재주입의
 * 첫 조건)가 받는다. 그러자고 텍스트를 세이브에 남기지는 않는다 (people.md §6).
 */
function hasNewMemories(state: GameState, characterId: string, shown: number | undefined): boolean {
  return shown !== undefined && memoriesOf(state, characterId).length > shown;
}

/** 같은 순위 안의 순서 — 로케일에 기대지 않는 코드포인트 비교여야 어디서나 같다 */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
