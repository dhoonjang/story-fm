import type {
  CharacterDepth,
  CharacterEntry,
  CharacterInjection,
  CharacterMemory,
  Negotiation,
  Persona,
} from "@story-fm/domain";
import { isDeeperThan } from "@story-fm/domain";
import type { GameState } from "../core/state";
import { pendingApproach } from "../club/approach";
import { pendingPress } from "../club/press";
import { knowledgeOf, type Knowledge } from "../squad/scouting";
import { headCoachOf, ownerOf, reportersOf } from "./persona";
import { generatePlayerPersona } from "./player-persona";

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
 * 이름이 세계에서 사라졌으면(방출된 선수) `null`이다 — 그 턴은 카드 없이 그려진다.
 */
export function characterEntryOf(
  state: GameState,
  characterId: string,
  depth: CharacterDepth,
): CharacterEntry | null {
  const persona = personaOf(state, characterId);
  return persona ? characterEntry(persona, depth, memoriesOf(state, characterId)) : null;
}

/**
 * 그 인물의 기억 — 압축이 남긴 것들 (people.md §9-1).
 *
 * ⚠️ 이력을 다시 그릴 때도 **지금의** 기억이 붙는다. 그래서 압축이 도는 턴에는 이력의
 * 카드도 함께 달라지지만, 요약 블록이 이력 앞에 서므로(agents.md §5-1) 그 턴은 어차피
 * 그 뒤가 통째로 무효다 — 캐시로는 공짜이고, 대신 한 인물의 기억이 두 자리에서 갈리지
 * 않는다.
 */
function memoriesOf(state: GameState, characterId: string): CharacterMemory[] {
  return (state.characterMemories ?? []).filter((m) => m.characterId === characterId);
}

/** 이름으로 페르소나를 찾는다 — 저장된 인물이 먼저, 그다음이 파생하는 선수다 */
function personaOf(state: GameState, characterId: string): Persona | null {
  const saved = (state.personas ?? []).find((p) => p.characterId === characterId);
  if (saved) return saved;
  for (const persona of [headCoachOf(state), ownerOf(state), ...reportersOf(state)]) {
    if (persona.characterId === characterId) return persona;
  }
  const player = state.players.find((p) => p.name === characterId);
  return player ? generatePlayerPersona(state.seed, player) : null;
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

/** 후보 한 명 — 페르소나와 **지금 감독이 아는 만큼** */
interface Candidate {
  persona: Persona;
  depth: CharacterDepth;
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
  const standing = deepestInjected(input.injected ?? []);

  const picked: Array<{ rank: number; candidate: Candidate }> = [];
  for (const candidate of candidatesOf(state)) {
    const rank = rankOf(candidate.persona, message, history, pointed);
    if (rank === null) continue;
    const shown = standing.get(candidate.persona.characterId);
    // 창 안에 이미 서 있으면 다시 싣지 않는다. 눈금이 올라 더 자세한 판이 된 경우만 예외다
    if (shown !== undefined && !isDeeperThan(candidate.depth, shown)) continue;
    picked.push({ rank, candidate });
  }
  picked.sort(
    (a, b) =>
      a.rank - b.rank ||
      compareIds(a.candidate.persona.characterId, b.candidate.persona.characterId),
  );
  return picked
    .slice(0, CHARACTER_INJECTION_LIMIT)
    .map(({ candidate }) =>
      characterEntry(
        candidate.persona,
        candidate.depth,
        memoriesOf(state, candidate.persona.characterId),
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
 * 후보 — 세이브의 페르소나 + **우리 선수단** + 협상 테이블에 앉은 상대 선수.
 *
 * 리그 4,000명을 훑지 않는 이유는 `speakerRoles`가 사전에 전원을 담지 않는 이유와
 * 같다 (people.md §3 원칙 ③): 남의 팀 3군까지 넣으면 동명이인이 늘어 정작 우리
 * 선수가 사라진다.
 */
function candidatesOf(state: GameState): Candidate[] {
  const byId = new Map<string, Candidate>();
  const add = (persona: Persona, depth: CharacterDepth) => {
    if (!byId.has(persona.characterId)) byId.set(persona.characterId, { persona, depth });
  };

  // 자리가 하나뿐인 인물 — 감독이 매일 보는 사람이라 언제나 `full`이다.
  // 옛 세이브라 비어 있으면 이 함수들이 시드로 그 자리에서 만든다
  add(headCoachOf(state), "full");
  add(ownerOf(state), "full");
  for (const reporter of reportersOf(state)) add(reporter, "full");
  for (const persona of state.personas ?? []) {
    if (persona.role !== "player") add(persona, "full");
  }

  // 선수 — 페르소나는 저장되지 않고 (시드, 선수 id)에서 파생하고, 깊이는 지식 눈금이 정한다
  const negotiating = new Set(
    state.negotiations.filter((n) => !CLOSED_NEGOTIATION.has(n.status)).map((n) => n.gamePlayerId),
  );
  for (const player of state.players) {
    if (player.teamId !== state.userTeamId && !negotiating.has(player.id)) continue;
    add(generatePlayerPersona(state.seed, player), characterDepthOf(knowledgeOf(state, player.id)));
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
  const reporterId = pendingPress(state)?.reporterId;
  if (reporterId !== undefined) ids.add(reporterId);
  // 감독실 문 앞에 서 있는 사람 — 감독이 이름을 부르기를 기다리지 않는다 (people.md §8)
  const speakerId = pendingApproach(state)?.speakerId;
  if (speakerId !== undefined) ids.add(speakerId);
  return ids;
}

/** 창 안에 서 있는 카드 중 **가장 자세한 판** — 재주입은 그것보다 깊어야 한다 */
function deepestInjected(injected: readonly CharacterInjection[]): Map<string, CharacterDepth> {
  const deepest = new Map<string, CharacterDepth>();
  for (const record of injected) {
    const shown = deepest.get(record.characterId);
    if (shown === undefined || isDeeperThan(record.depth, shown)) {
      deepest.set(record.characterId, record.depth);
    }
  }
  return deepest;
}

/** 같은 순위 안의 순서 — 로케일에 기대지 않는 코드포인트 비교여야 어디서나 같다 */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
