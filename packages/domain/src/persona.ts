import { z } from "zod";

/**
 * 페르소나 — **코드가 아니라 데이터**로 다루는 인물 (AGENTS.md 4장 · people.md §1).
 *
 * 페르소나는 시뮬 숫자에 직접 손대지 않는다. 사기·관계 같은 **상태를 거쳐서만**
 * 세계에 영향을 준다. 여기 있는 것은 전부 "어떻게 말하고 무엇을 원하는가" —
 * LLM이 그 인물을 일관되게 연기하기 위한 재료다.
 *
 * 세이브에 저장되는 건 자리가 하나뿐인 인물 — 수석코치·구단주·기자단이다. **선수의
 * 페르소나는 저장하지 않고 (시드, 선수 id)에서 결정적으로 파생한다** (people.md §6).
 */

/**
 * 인물이 세계에서 맡은 자리 — 채팅 @태그의 뿌리이자 **열린 집합**이다.
 *
 * 자리를 하나 늘리는 데 세 곳(라벨·아이콘·화자 사전)을 함께 고쳐야 하면 늘지 않는다.
 * 그래서 라벨과 아이콘은 **아는 자리에만** 붙고, 모르는 자리에는 사람 아이콘이 선다 —
 * 틀린 직책을 다느니 "누군가 말한다"까지만 말한다 (people.md §3).
 */
export const PersonaRoleSchema = z.enum([
  "head_coach",
  "owner",
  "reporter",
  "player",
  /** 감독의 사람 — 구단 밖에서 그를 아는 이 */
  "friend",
  /**
   * 서포터 — ⚠️ **이름 있는 개인만이다.** `characterId`가 그 사람의 이름이고 전역
   * 유일이므로 집단은 페르소나가 될 수 없다. "관중석이 술렁였다"는 화자 없는 내레이션의 몫.
   */
  "supporter",
]);
export type PersonaRole = z.infer<typeof PersonaRoleSchema>;

/**
 * 말투 — 지문 하나로는 모델이 흉내만 내고 만다. **예시 대사**를 함께 줘야
 * 톤이 실제로 붙는다 (people.md §1).
 */
export const SpeechStyleSchema = z.object({
  /** 말투 지문 — 한 문장 */
  note: z.string().min(1),
  /** 이 인물이라면 이렇게 말한다 — 2~3개 */
  samples: z.array(z.string().min(1)).min(1),
});
export type SpeechStyle = z.infer<typeof SpeechStyleSchema>;

export const PersonaSchema = z.object({
  /**
   * 채팅 @태그와 1:1 (people.md §3) — **그 사람의 이름**이다.
   *
   * 선수가 `@손흥민:`으로 말하는데 코치만 `@수석코치:`로 말하면, 이름을 지어 준
   * 의미가 없고 화면에서도 그 사람이 아니라 직책이 말하는 것처럼 읽힌다.
   * 직책은 인물 카드가 따로 알려 준다.
   */
  characterId: z.string().min(1),
  name: z.string().min(1),
  role: PersonaRoleSchema,
  /** 원형 — 같은 자리라도 어떤 유형의 사람인가 (people.md §2) */
  archetype: z.string().min(1),
  /** 성격 3~5개 — "데이터 신봉자", "직설적" */
  traits: z.array(z.string().min(1)).min(1),
  /** 이 인물이 원하는 것 — 한 문장 */
  motivation: z.string().min(1),
  speechStyle: SpeechStyleSchema,
  /**
   * 이 인물이 불렸다고 볼 말들 — 캐릭터북이 이력과 이번 턴 발화에서 훑는다 (people.md §6).
   *
   * ⚠️ **나열된 것만 본다.** 성만 쓴 "홀란드"를 같은 사람으로 보는 부분 일치는 오탐을
   * 만든다는 `normalizeSpeaker`의 원칙이 여기도 그대로다 — 별칭이 필요하면 여기 적는다.
   * 옛 세이브엔 없다 (optional) — 로드가 채운다.
   */
  keywords: z.array(z.string().min(1)).optional(),
  /**
   * 소속 매체 — **기자에게만 있다.** 같은 질문도 어디 소속이냐가 결을 정한다:
   * 지역지는 구단의 내일을, 전국지는 리그 판도를, 타블로이드는 라커룸을 묻는다.
   * 옛 세이브엔 없다 (optional).
   */
  outlet: z.string().min(1).optional(),
  /**
   * 실존 인물인가 — 이름만 실제이고 성격·대사는 게임이 지어낸 것이다.
   * 서사 가드가 이 표식을 보고 **부정적 실명 서사를 막는다** (sources.md §7).
   * 가상 인물엔 없다(옵셔널).
   */
  real: z.boolean().optional(),
  /** 생성 재현용 — 같은 세이브는 같은 사람을 만난다 */
  seed: z.number().int(),
});
export type Persona = z.infer<typeof PersonaSchema>;

/**
 * 역할 → **직책 이름**. 화자 태그가 아니다(태그는 사람 이름이다).
 *
 * 두 곳이 같은 값을 쓴다: 인물 카드가 "이 사람의 자리"를 LLM에 밝힐 때, 그리고
 * 화면이 `스티브 홀랜드 (수석코치)`처럼 이름 옆에 붙일 때.
 *
 * ⚠️ **전부 채워야 하는 표가 아니다.** 자리가 열린 집합이므로(→ `PersonaRoleSchema`)
 * 라벨을 모르는 자리도 있고, 그 자리는 이름만으로 선다. 읽을 때는 `personaRoleLabel`을
 * 거쳐라 — 표를 직접 인덱싱하면 새 역할이 `undefined`를 문자열 자리에 세운다.
 */
export const PERSONA_ROLE_LABEL: Partial<Record<PersonaRole, string>> = {
  head_coach: "수석코치",
  owner: "구단주",
  reporter: "기자",
  player: "선수",
};

/** 아는 자리면 직책 이름, 모르면 없다 — 없는 것이 곧 "이름까지만 말한다"는 뜻이다 */
export function personaRoleLabel(role: PersonaRole): string | undefined {
  return PERSONA_ROLE_LABEL[role];
}

/**
 * 인물지의 **깊이** — 감독이 그 사람을 얼마나 아는가 (people.md §6).
 *
 * 지식 눈금 다섯 단계(`Knowledge`)를 그대로 쓰지 않고 셋으로 접는 이유: `scouted`와
 * `seen`의 인물지가 같기 때문이다. 주입 기록이 눈금이 아니라 이 깊이를 남기므로,
 * **같은 판을 두 번 싣지 않고** 깊이가 실제로 달라졌을 때만 다시 싣는다.
 */
export const CHARACTER_DEPTHS = [
  /** 원형 · 성격 · 동기 · 말투 지문 · 예시 대사 — 전부 (`own` · `adapting`) */
  "full",
  /** 원형 · 성격 · 말투 지문 (`scouted` · `seen`) */
  "outline",
  /** 원형과 평판 한 줄 — 말투는 없다 (`rumoured`) */
  "rumour",
] as const;
export const CharacterDepthSchema = z.enum(CHARACTER_DEPTHS);
export type CharacterDepth = z.infer<typeof CharacterDepthSchema>;

/** 깊이의 서열 — 큰 쪽이 더 자세하다. 눈금이 올라 다시 실을지가 이 비교다 */
const DEPTH_RANK: Record<CharacterDepth, number> = { rumour: 0, outline: 1, full: 2 };

/** `b`가 `a`보다 자세한가 — 재주입의 두 조건 중 하나 (다른 하나는 이력 창 밖) */
export function isDeeperThan(b: CharacterDepth, a: CharacterDepth): boolean {
  return DEPTH_RANK[b] > DEPTH_RANK[a];
}

/**
 * 주입 기록 — **어느 턴에 누구를, 어느 깊이로 실었는가** (people.md §6).
 *
 * ⚠️ 카드 텍스트는 세이브에 넣지 않는다. 이력은 매 턴 `state.chat`에서 다시
 * 렌더링되므로, 남길 것은 이 기록뿐이고 카드는 그 턴을 렌더링할 때 다시 붙는다.
 * 채팅 화면은 깨끗하고 이력은 결정적으로 재현된다.
 */
export const CharacterInjectionSchema = z.object({
  characterId: z.string().min(1),
  depth: CharacterDepthSchema,
});
export type CharacterInjection = z.infer<typeof CharacterInjectionSchema>;

/**
 * 인물지 — 캐릭터북이 조립하는 **구조**다. 문장으로 옮기는 것은 프롬프트의 몫이고
 * (`describePersona`), 코어는 사실만 낸다 (overview.md §1 철칙 4).
 *
 * ⚠️ **변하는 값은 여기 없다** — 폼·컨디션·부상·심경·계약·관측 능력치는 주입한 카드가
 * 이력에 굳는 순간 낡은 사실이 된다. 그것들은 발화 직전의 조회가 낸다 (people.md §6).
 */
export interface CharacterEntry {
  characterId: string;
  name: string;
  role: PersonaRole;
  archetype: string;
  traits: string[];
  /** `full`에만 있다 — 원하는 것 한 문장 */
  motivation?: string;
  /** `rumour`에는 없다. `outline`은 지문만 오고 예시 대사가 비어 있다 */
  speechStyle?: SpeechStyle;
  outlet?: string;
  real?: boolean;
  depth: CharacterDepth;
}

/** 태그를 이름으로 옮기기 전 세이브를 알아보는 표식이기도 하다 */
export const HEAD_COACH_ROLE_LABEL = PERSONA_ROLE_LABEL.head_coach!;
export const OWNER_ROLE_LABEL = PERSONA_ROLE_LABEL.owner!;
export const REPORTER_ROLE_LABEL = PERSONA_ROLE_LABEL.reporter!;

/**
 * 주장 — 페르소나가 아니지만 대화에서 자리가 뜻을 갖는 유일한 선수다.
 * 사전을 만드는 코어와 아이콘을 고르는 화면이 **같은 문자열**을 봐야 한다.
 */
export const CAPTAIN_ROLE_LABEL = "주장";

/** 중계 — 무대 밖의 목소리. 이름이 곧 자리다 */
export const BROADCAST_SPEAKER = "중계";

/**
 * 화자 이름 정규화 — 사전을 만들 때와 찾을 때가 **같은 함수**를 써야 한다.
 *
 * 모델은 같은 사람을 "스티브 홀랜드"로도 "스티브홀랜드"로도 쓴다. 그 정도 흔들림은
 * 흡수하되 **추측은 하지 않는다** — 성만 쓴 "홀랜드"를 같은 사람으로 보는 부분 일치는
 * 오탐(동명이인·유사 이름)이 잘못된 직책을 붙이게 만든다. 확실할 때만 붙인다.
 */
export function normalizeSpeaker(name: string): string {
  return name.replace(/\s+/gu, "");
}
