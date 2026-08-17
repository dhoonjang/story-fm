import { z } from "zod";

/**
 * 페르소나 — **코드가 아니라 데이터**로 다루는 인물 (AGENTS.md 4장 · people.md §1).
 *
 * 페르소나는 시뮬 숫자에 직접 손대지 않는다. 사기·관계 같은 **상태를 거쳐서만**
 * 세계에 영향을 준다. 여기 있는 것은 전부 "어떻게 말하고 무엇을 원하는가" —
 * LLM이 그 인물을 일관되게 연기하기 위한 재료다.
 *
 * 지금 채워지는 건 **수석코치와 구단주**(people.md §2의 핵심 계층)다.
 * 기자·핵심 선수는 같은 스키마로 뒤에 붙는다.
 */

/** 인물이 세계에서 맡은 자리 — 채팅 @태그의 뿌리 */
export const PersonaRoleSchema = z.enum(["head_coach", "owner", "reporter"]);
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
 */
export const PERSONA_ROLE_LABEL: Record<PersonaRole, string> = {
  head_coach: "수석코치",
  owner: "구단주",
  reporter: "기자",
};

/** 태그를 이름으로 옮기기 전 세이브를 알아보는 표식이기도 하다 */
export const HEAD_COACH_ROLE_LABEL = PERSONA_ROLE_LABEL.head_coach;
export const OWNER_ROLE_LABEL = PERSONA_ROLE_LABEL.owner;
export const REPORTER_ROLE_LABEL = PERSONA_ROLE_LABEL.reporter;

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
