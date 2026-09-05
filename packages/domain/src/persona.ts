import { z } from "zod";
import { DateString } from "./date-string";
import type { CharacterMemory } from "./records";

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
  /**
   * 구단이 고용한 사람들 — **수석코치와 같은 자리가 아니다** (people.md §2-2).
   * 수석코치는 감독 옆에 서는 한 사람이고, 이쪽은 훈련장·의무실·보고서를 맡은
   * 사람들이다. 셋만이 `employment`을 들고 감독이 고용·해고할 수 있다.
   */
  "coach",
  "medic",
  "scout",
  /** 감독의 사람 — 구단 밖에서 그를 아는 이 */
  "friend",
  /**
   * 서포터 — ⚠️ **이름 있는 개인만이다.** `characterId`가 그 사람의 이름이고 전역
   * 유일이므로 집단은 페르소나가 될 수 없다. "관중석이 술렁였다"는 화자 없는 내레이션의 몫.
   */
  "supporter",
  /**
   * 타 팀 감독 — 상대 벤치에 서는 사람이다. ⚠️ **`head_coach`가 아니다**: 그 자리는
   * 우리 구단의 수석코치, 감독(유저)이 매일 옆에 두는 사람이다 (people.md §2-1).
   */
  "manager",
  /** 에이전트 — 협상 테이블 건너편 */
  "agent",
  /** 해설 — 중계석과 스튜디오. 축구계에 남은 은퇴 인물이 대개 여기 선다 */
  "pundit",
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

/**
 * **고용 정보** — 구단이 급여를 주는 사람만 든다 (people.md §2-2).
 *
 * 수석코치·코치·의료진·스카우트가 갖고 **구단주는 갖지 않는다** — 그는 고용된 사람이
 * 아니라 고용하는 쪽이다. 선수의 계약(`Contract`)과 다른 표인 이유는 자리가 다르기
 * 때문이다: 스태프는 등록 명단에도 이적 시장에도 서지 않고, 장부에서 `staff_wages`로
 * 선다 (→ ../../../docs/simulation/finance.md §6.4-1).
 *
 * 옛 세이브엔 없다 (optional — 로드가 채운다, 세이브 버전 유지).
 */
export const EmploymentSchema = z.object({
  /** 어느 구단의 사람인가 — 감독이 이직해도 이 사람은 옛 구단에 남는다 */
  teamId: z.string().min(1),
  /** 그 사람의 직책 — 「피지컬 코치」. 역할 라벨(「코치」)보다 좁고, 화면 칩이 이것을 쓴다 */
  title: z.string().min(1),
  /** 부임일 — 카드의 「부임 2년째」가 여기서 나온다. 감독보다 앞설 수 있다 */
  since: DateString,
  /**
   * 연봉(£/년)과 만료일. **위약금의 근거이기도 하다** — 자르면 잔여 계약에 비례해
   * 문다(감독 경질과 같은 식 — career.md §5.4).
   */
  contract: z.object({ salary: z.number().int().min(0), until: DateString }),
  /** 데려온 곳 — 무직 풀에서 왔으면 그 사람의 옛 구단. 처음부터 있던 사람에겐 없다 */
  from: z.string().min(1).optional(),
});
export type Employment = z.infer<typeof EmploymentSchema>;

/**
 * 감독이 고용·해고할 수 있는 자리 — **수석코치는 여기 없다** (people.md §2-2).
 *
 * 그 자리가 비면 감독 옆에 아무도 없고, 경기 레퍼런스가 상주시키는 카드도 사라진다
 * (agents.md §5). 수석코치도 `employment`을 들되 고용 명령이 다루는 대상은 아니다.
 */
export const STAFF_ROLES = ["coach", "medic", "scout"] as const;
export const StaffRoleSchema = z.enum(STAFF_ROLES);
export type StaffRole = z.infer<typeof StaffRoleSchema>;

/** 이 역할이 고용·해고의 대상인가 — 표를 직접 인덱싱하는 자리를 한 곳으로 묶는다 */
export function isStaffRole(role: PersonaRole): role is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(role);
}

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
   * 이 인물이 불렸다고 볼 말들 — 인물 사전이 이력과 이번 턴 발화에서 훑는다 (people.md §6).
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
   * 실명 부채의 장부(sources.md §7)가 이 표식으로 센다. **프롬프트에는 실리지 않는다**
   * (docs/llm/prompts.md §5-3) — 사람됨은 원형이, 부정적 전개는 장부의 사실이 묶는다.
   * 가상 인물엔 없다(옵셔널).
   */
  real: z.boolean().optional(),
  /**
   * 구단이 이 사람에게 급여를 주는가 — 자리·부임일·계약 (people.md §2-2).
   * 수석코치·코치·의료진·스카우트에게만 있다. 옛 세이브엔 없다 (optional).
   */
  employment: EmploymentSchema.optional(),
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
  coach: "코치",
  medic: "의료진",
  scout: "스카우트",
  manager: "감독",
  agent: "에이전트",
  pundit: "해설위원",
};

/** 아는 자리면 직책 이름, 모르면 없다 — 없는 것이 곧 "이름까지만 말한다"는 뜻이다 */
export function personaRoleLabel(role: PersonaRole): string | undefined {
  return PERSONA_ROLE_LABEL[role];
}

/**
 * **무직 스태프 풀의 한 줄** — 자리를 찾는 코치·의료진·스카우트 (people.md §2-2).
 *
 * 감독 풀(`ManagerPoolEntry`)과 같은 패턴이되 셋이 다르다: 채우는 것이 경질이 아니라
 * **여름의 결정적 추첨**이고, 부르는 쪽이 AI 구단이 아니라 **감독뿐**이며, 요구 연봉을
 * 넘기면 흥정 없이 그 자리에서 계약된다.
 *
 * ⚠️ **사람됨은 줄이 들지 않는다.** 이름·역할·자리·원형만 있으면 원형 표에서 성격·동기·
 * 말투가 결정적으로 파생하므로(`staffPersonaOf`), 카드를 줄에 넣으면 같은 사실이 두 곳에
 * 산다. 옛 세이브엔 없다 (optional — 세이브 버전 유지).
 */
export const StaffPoolEntrySchema = z.object({
  /** 이름이 곧 `characterId`다 (people.md §1) */
  name: z.string().min(1),
  role: StaffRoleSchema,
  /** 그 사람이 맡을 자리 — 「피지컬 코치」 */
  title: z.string().min(1),
  /** 원형 라벨 — 표를 되짚어 성격·말투를 세운다 */
  archetype: z.string().min(1),
  /** 요구 연봉 (£/년) — 이 이상을 부르면 그 자리에서 계약된다 */
  ask: z.number().int().min(0),
  /** 이 줄이 선 시즌 — 여름 갱신이 「그해 자른 사람만 남긴다」를 판단하는 기준 */
  listedOn: z.number().int(),
  /** 직전 구단 — 감독이 자른 사람에게만 있다 */
  from: z.string().min(1).optional(),
});
export type StaffPoolEntry = z.infer<typeof StaffPoolEntrySchema>;

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
 * 주입 기록 — **어느 턴에 누구를, 어느 깊이로, 기억 몇 줄과 함께 실었는가**
 * (people.md §6).
 *
 * ⚠️ 카드 텍스트는 세이브에 넣지 않는다. 이력은 매 턴 `state.chat`에서 다시
 * 렌더링되므로, 남길 것은 이 기록뿐이고 카드는 그 턴을 렌더링할 때 다시 붙는다.
 * 채팅 화면은 깨끗하고 이력은 결정적으로 재현된다.
 */
export const CharacterInjectionSchema = z.object({
  characterId: z.string().min(1),
  depth: CharacterDepthSchema,
  /**
   * 그때 카드에 실린 기억 줄 수 — 기억은 이력의 카드에 서지 않으므로(§6), 늘어난
   * 것을 재주입으로 나르려면 그때의 수가 있어야 한다. **없으면 재주입하지 않는다** —
   * 이 자리가 생기기 전의 기록을 0으로 읽으면 옛 세이브의 카드가 한꺼번에 다시 선다.
   */
  memories: z.number().int().min(0).optional(),
});
export type CharacterInjection = z.infer<typeof CharacterInjectionSchema>;

/**
 * **관계 점수** — 무순서 쌍 하나에 한 줄 (people.md §6 「관계 점수」).
 *
 * 세이브가 든다. 감독이 무엇을 했는지의 누적이라 장부에서 파생할 수 없는 값이고,
 * 압력 눈금(§8)이 세이브를 드는 이유와 같다. 줄은 **사건이 처음 움직일 때** 생긴다 —
 * 안 움직인 쌍의 값은 첫인상이 결정적으로 답하므로 적어 둘 이유가 없다.
 */
export const RelationSchema = z.object({
  /** 쌍의 앞 열쇠 — `a < b`(코드포인트)로 정규화한다. 로케일에 기대면 세이브가 갈린다 */
  a: z.string().min(1),
  b: z.string().min(1),
  /** −100~100, 0이 중립 */
  score: z.number().int().min(-100).max(100),
  updatedOn: DateString,
});
export type Relation = z.infer<typeof RelationSchema>;

/**
 * 카드가 읽는 눈금 — **점수가 아니라 등급이 카드에 선다** (people.md §6).
 *
 * 순서가 곧 크기다(틀어짐 → 믿음). 숫자를 싣지 않는 것은 카드가 이력에 굳기
 * 때문이다: 매 턴 달라지는 값을 실으면 지난 턴들의 바이트가 함께 바뀌어 캐시
 * 프리픽스가 통째로 깨진다. 다섯 칸이라 경계를 넘는 날에만 그 줄이 바뀐다.
 */
export const RELATION_TIERS = ["hostile", "strained", "neutral", "close", "trusted"] as const;
export type RelationTier = (typeof RELATION_TIERS)[number];

/** 등급의 경계 — 음수 쪽은 대칭이다. 경계 하나가 두 방향을 함께 정한다 */
export const RELATION_TIER_BOUNDS = { close: 20, trusted: 55 } as const;

/** 등급의 순위 — 중립이 0이다. 계수와 비교는 전부 이 눈금을 탄다 */
export const RELATION_TIER_RANK: Record<RelationTier, number> = {
  hostile: -2,
  strained: -1,
  neutral: 0,
  close: 1,
  trusted: 2,
};

/** 카드에 서는 말 — 코어는 사실만 내고 문장은 GM이 쓴다 (people.md §6) */
export const RELATION_TIER_KO: Record<RelationTier, string> = {
  hostile: "틀어진 사이",
  strained: "껄끄러운 사이",
  neutral: "그저 그런 사이",
  close: "가까운 사이",
  trusted: "믿는 사이",
};

/** 점수 → 등급. 표는 여기 하나뿐이다 */
export function relationTier(score: number): RelationTier {
  if (score >= RELATION_TIER_BOUNDS.trusted) return "trusted";
  if (score >= RELATION_TIER_BOUNDS.close) return "close";
  if (score <= -RELATION_TIER_BOUNDS.trusted) return "hostile";
  if (score <= -RELATION_TIER_BOUNDS.close) return "strained";
  return "neutral";
}

/**
 * 등급 → 카드의 결. **중립은 결이 없다** — 카드에 서는 것은 통하거나 부딪히는
 * 사이뿐이라는 규칙이 여기 한 줄로 서 있다.
 */
export function stanceOfTier(tier: RelationTier): PersonaRelation["stance"] | null {
  if (tier === "close" || tier === "trusted") return "aligned";
  if (tier === "strained" || tier === "hostile") return "tense";
  return null;
}

/**
 * 인물지에 서는 관계 한 줄 — **지금의 등급**이다 (people.md §6).
 *
 * 원형이 깐 첫인상 위로 사건이 오르내린 결과이고, 중립은 줄이 되지 않는다.
 */
export interface PersonaRelation {
  characterId: string;
  name: string;
  /** 등급에서 파생한다 (`stanceOfTier`) — 두 벌이면 카드와 눈금이 갈린다 */
  stance: "aligned" | "tense";
  /**
   * 지금의 등급 — 카드가 읽는 것은 이쪽이고 `stance`는 그 요약이다.
   *
   * **중립이면 없다.** 점수에서 나온 줄은 중립이면 아예 서지 않으므로 언제나 있고,
   * `bond`가 세운 줄(멘토링 — §5-3)에는 그 쌍이 중립일 때 없다: 그 줄의 근거는
   * 등급이 아니라 감독이 그렇게 정했다는 사실이다.
   */
  tier?: RelationTier;
  /**
   * 내가 먼저 보는 것 · 상대가 먼저 보는 것 — 문장은 프롬프트가 쓴다.
   * **원형에서 뽑힌 첫인상에만 있다** — `bond`가 선 줄에는 없다.
   */
  ours?: string;
  theirs?: string;
  /**
   * **감독이 세운 사이** — 멘토링에서 내가 선 자리 (people.md §5-3).
   *
   * 원형 축을 들지 않는 것은 이 줄의 근거가 세계의 뽑기가 아니라 감독의 결정이기
   * 때문이다. ⚠️ 날짜도 수치도 싣지 않는다 — 카드는 이력에 굳으므로(people.md §6)
   * 변하는 값이 들어가면 3주 전 카드가 오늘의 사실인 척한다.
   */
  bond?: "mentor" | "mentee";
}

/**
 * 인물지 — 인물 사전이 조립하는 **구조**다. 문장으로 옮기는 것은 프롬프트의 몫이고
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
  /**
   * 그 사람에게 있었던 일 — 이력이 접힐 때만 갱신된다 (people.md §9-1). 변하는 값을
   * 카드에 넣지 않는다는 위의 ⚠️와 어긋나지 않는 이유가 그것이다: 더해지는 자리가
   * 압축 한 곳뿐이라 카드가 이력에 굳어도 뒤늦게 낡지 않는다.
   */
  memories?: CharacterMemory[];
  /**
   * 지금 이 사람이 누구와 어떤 사이인가 — **등급**이다 (people.md §6 「관계 점수」).
   * `full` 깊이에만 있다 — 사이의 결은 매일 보는 사람이나 안다.
   */
  relations?: PersonaRelation[];
}

/** 태그를 이름으로 옮기기 전 세이브를 알아보는 표식이기도 하다 */
export const HEAD_COACH_ROLE_LABEL = PERSONA_ROLE_LABEL.head_coach!;

/**
 * 주장 — 페르소나가 아니지만 대화에서 자리가 뜻을 갖는 유일한 선수다.
 * 사전을 만드는 코어와 아이콘을 고르는 화면이 **같은 문자열**을 봐야 한다.
 */
export const CAPTAIN_ROLE_LABEL = "주장";

/**
 * 라커룸에서 선 자리 — 감독이 채우는 완장 둘과 파생되는 리더 그룹
 * (→ docs/data/people.md §5-1). 사실 카드·화면·조회 도구가 **같은 문자열**을 읽는다.
 */
export const LEADER_ROLES = ["captain", "vice", "group"] as const;
export type LeaderRole = (typeof LEADER_ROLES)[number];
export const LeaderRoleSchema = z.enum(LEADER_ROLES);

export const LEADER_ROLE_LABEL: Record<LeaderRole, string> = {
  captain: CAPTAIN_ROLE_LABEL,
  vice: "부주장",
  group: "라커룸 리더",
};

/**
 * 다가옴의 채널 — **누가 감독에게 먼저 오는가** (people.md §8).
 *
 * 페르소나의 `role`을 그대로 쓰지 않는 이유는 주장 때문이다: 주장은 자리가 뜻을 갖되
 * 페르소나가 아니라 **선수**이고(`CAPTAIN_ROLE_LABEL`), 같은 `player` 역할이라도
 * 자기 문제로 오는 것과 라커룸을 대신해 오는 것은 다른 자리다. 채널은 그 자리를
 * 가리키고, 효과가 어느 축에 닿는지도 여기서 갈린다.
 */
export const APPROACH_CHANNELS = ["player", "captain", "owner", "agent"] as const;
export const ApproachChannelSchema = z.enum(APPROACH_CHANNELS);
export type ApproachChannel = z.infer<typeof ApproachChannelSchema>;

/**
 * 채널 → 그 자리에 온 사람의 **직책 이름**. 화자 태그가 아니다 — 태그는 언제나
 * 사람 이름이고(§1), 이 값은 코어가 사실 줄에 "누구로서 왔는가"를 적을 때 쓴다.
 */
export const APPROACH_CHANNEL_LABEL: Record<ApproachChannel, string> = {
  player: PERSONA_ROLE_LABEL.player!,
  captain: CAPTAIN_ROLE_LABEL,
  owner: PERSONA_ROLE_LABEL.owner!,
  agent: PERSONA_ROLE_LABEL.agent!,
};

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

// ── 에이전트 원형 — 협상 테이블 건너편의 세 사람 ────────────────

/**
 * 에이전트 원형의 코드 — **협상에서 무엇을 무기로 쓰는가**로 갈린다
 * (people.md §2-1).
 *
 * 명부(`engine/data/world-figures.ts`)는 사람의 이름과 라벨을 적고, 그 라벨이 무엇을
 * 뜻하는지는 이 키가 정한다. 키를 도메인에 두는 이유는 선수 원형과 같다 — 라벨을 두
 * 곳에 적으면 갈리고, 갈리는 순간 시장 프로필(`engine/market/agent-profile.ts`)이
 * 사람을 못 찾아 조용히 중립으로 떨어진다.
 *
 * ⚠️ **계수는 여기 없다.** 시장 프로필은 세계의 눈금이라 엔진의 것이다.
 */
export const AGENT_ARCHETYPE_KEYS = ["empire", "lawyer", "hardballer"] as const;
export const AgentArchetypeSchema = z.enum(AGENT_ARCHETYPE_KEYS);
export type AgentArchetype = z.infer<typeof AgentArchetypeSchema>;

/** 코드 → 명부와 인물 카드에 서는 이름. 페르소나의 `archetype`이 드는 값이다 */
export const AGENT_ARCHETYPE_LABEL: Record<AgentArchetype, string> = {
  empire: "제국형",
  lawyer: "법률가형",
  hardballer: "승부사형",
};

/**
 * 라벨 → 코드. 페르소나가 드는 것은 라벨이라(`Persona.archetype`은 열린 문자열이다)
 * 시장 프로필이 그 사람을 찾을 때 지나는 문이 여기다.
 *
 * **표에 없는 라벨은 `null`이다** — 명부를 비웠거나 다른 원형이 선 자리이고, 그런
 * 대리인은 숫자에 아무것도 얹지 않는다.
 */
export function agentArchetypeOf(archetype: string): AgentArchetype | null {
  return AGENT_ARCHETYPE_KEYS.find((key) => AGENT_ARCHETYPE_LABEL[key] === archetype) ?? null;
}

// ── 선수 원형 — 라벨과 계수는 여기 한 표에 있다 ────────────────

/**
 * 선수 원형 10종의 코드 — **감독 앞에서 무엇을 먼저 말하는가**로 갈린다
 * (people.md §6).
 *
 * 원형은 (시드, 선수 id)에서 결정적으로 파생하고 세이브에 저장되지 않는다. 코드가
 * 도메인에 있는 이유는 **화면과 코어가 같은 표를 읽어야** 하기 때문이다 — 사실 카드는
 * 코드를 싣고 문장은 화면·GM이 쓰므로, 코드 → 라벨을 두 곳에 적으면 갈린다
 * (AGENTS.md §5 — 한 규칙 한 정의). 추첨의 무게와 말투·동기는 세계의 것이라
 * `engine/world/player-persona.ts`에 남는다.
 */
export const PLAYER_ARCHETYPE_KEYS = [
  "ambitious",
  "team_first",
  "quiet_craftsman",
  "fierce_competitor",
  "anxious_prospect",
  "dressing_room_leader",
  "professional",
  "weighing_star",
  "homegrown_heart",
  "film_reader",
] as const;
export const PlayerArchetypeKeySchema = z.enum(PLAYER_ARCHETYPE_KEYS);
export type PlayerArchetypeKey = z.infer<typeof PlayerArchetypeKeySchema>;

/** 코드 → 사람이 읽는 이름. 인물 카드의 `원형:` 줄과 사실 카드가 같은 값을 쓴다 */
export const PLAYER_ARCHETYPE_LABEL: Record<PlayerArchetypeKey, string> = {
  ambitious: "야심가형",
  team_first: "팀 우선 베테랑",
  quiet_craftsman: "조용한 장인",
  fierce_competitor: "승부욕 과열형",
  anxious_prospect: "불안한 유망주",
  dressing_room_leader: "라커룸 리더",
  professional: "프로페셔널",
  weighing_star: "저울질하는 스타",
  homegrown_heart: "구단 애착형",
  film_reader: "영상 분석형",
};

/**
 * 원형이 **상태 전이에 거는 계수 다섯** (people.md §6 · 요구사항 3).
 *
 * 페르소나는 시뮬 숫자에 직접 손대지 않는다 — 여기 있는 다섯이 닿는 곳은 불만이 서는
 * 날 · 정착 목표 · 성장 확률 · 선수 관문의 점수까지이고, **전력 패킷과 xG는 원형을
 * 읽지 않는다.** 경기 결과가 사람됨을 읽기 시작하면 같은 스쿼드가 같은 전술로 다른
 * 점수를 내고, 그 차이를 감독이 되짚을 자리가 없다.
 *
 * 히든 능력치가 아니다 — 선수에 새 축을 심는 대신 이미 있는 원형을 읽는다
 * (player.md §1). 파생이므로 옛 세이브도 로드만으로 같은 계수를 얻는다.
 */
export interface PlayerArchetypeTraits {
  /**
   * 출전 인내 — 2군 방치 불만의 문턱 일수에 곱하고, 벤치 불만 추첨에는 **역수**로
   * 걸린다. 크면 늦게 서고 덜 뽑힌다.
   */
  patience: number;
  /**
   * 구단 애착 — 선수 관문의 「다른 구단의 관심」·「선수의 마음」에 걸린다.
   * **남을 이유는 곱하고 떠날 이유는 나눈다** (transfer.md §3).
   */
  loyalty: number;
  /**
   * 직업의식 — 월간 성장 확률과 결산 판정의 **상승** 흡수에 곱한다.
   * ⚠️ 노화 하락에는 붙지 않는다 (player.md §6).
   */
  professionalism: number;
  /** 정착 목표 배수 — 크면 새 라커룸에 녹아드는 데 더 걸린다 (player.md §9.3) */
  settling: number;
  /**
   * 등번호 애착 — **계수가 아니라 문턱을 만드는 값이다** (people.md §5).
   *
   * 나머지 넷은 눈금에 곱해지지만 이것은 번호의 무게·재적 시즌과 함께 점수를 만들어
   * 「번호를 뺏겼을 때 불만이 서는가 서지 않는가」를 그 자리에서 가른다 — 굴림이
   * 없어 감독이 그 결정의 대가를 미리 셀 수 있다. 자를 쥔 것은
   * `numberGrievanceStands` (squad-rules.ts) 하나다.
   */
  number: number;
}

/**
 * 원형 → 계수. **밴드 숫자가 적히는 자리는 여기 하나다.**
 *
 * 다섯 열 모두 평균이 1 근처(1.05 · 1.04 · 1.06 · 0.98 · 1.02)다 — 계수는 세계의
 * 눈금을 옮기는 것이 아니라 같은 눈금 위에서 사람을 가른다. 평균이 밀리면 원형을 붙인
 * 값이 아니라 문턱을 통째로 조정한 값이 된다.
 */
// prettier-ignore
export const PLAYER_ARCHETYPE_TRAITS: Record<PlayerArchetypeKey, PlayerArchetypeTraits> = {
  ambitious:            { patience: 0.70, loyalty: 0.75, professionalism: 1.05, settling: 1.00, number: 1.10 },
  team_first:           { patience: 1.45, loyalty: 1.25, professionalism: 1.10, settling: 0.85, number: 1.30 },
  quiet_craftsman:      { patience: 1.15, loyalty: 1.10, professionalism: 1.25, settling: 1.15, number: 0.65 },
  fierce_competitor:    { patience: 0.75, loyalty: 0.95, professionalism: 0.90, settling: 1.05, number: 0.90 },
  anxious_prospect:     { patience: 1.20, loyalty: 1.10, professionalism: 0.95, settling: 1.25, number: 1.00 },
  dressing_room_leader: { patience: 1.25, loyalty: 1.20, professionalism: 1.05, settling: 0.80, number: 1.15 },
  professional:         { patience: 1.10, loyalty: 1.00, professionalism: 1.25, settling: 0.85, number: 0.60 },
  weighing_star:        { patience: 0.60, loyalty: 0.60, professionalism: 0.85, settling: 1.10, number: 1.20 },
  homegrown_heart:      { patience: 1.30, loyalty: 1.45, professionalism: 1.00, settling: 0.80, number: 1.45 },
  film_reader:          { patience: 1.00, loyalty: 1.00, professionalism: 1.15, settling: 0.95, number: 0.80 },
};

/**
 * 충성이 그 항의 점수를 기울인다 — **남을 이유는 곱하고 떠날 이유는 나눈다.**
 *
 * 축을 하나 늘리지 않는 이유: 「구단 애착」을 따로 세우면 갈 곳이 없는 선수에게도
 * 애착 점수가 붙어 두 사실이 따로 논다. 애착은 **밖의 관심이 있을 때 비로소 값을
 * 하는 것**이라 그 줄의 무게여야 한다 (transfer.md §3).
 *
 * @param means 그 항이 성사시키려는 쪽 — `stay`는 이 구단에 남는 쪽, `leave`는 나가는 쪽
 */
export function byLoyalty(score: number, loyalty: number, means: "stay" | "leave"): number {
  return means === "stay" ? score * loyalty : score / loyalty;
}
