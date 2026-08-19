import { z } from "zod";

/**
 * 기자회견 (PRESS_CONFERENCE) — 세계가 감독에게 **대답을 요구하는 자리**.
 *
 * 감독의 다른 손잡이(훈련·전술·이적)는 전부 감독이 먼저 손을 뻗는 것이지만,
 * 회견은 **세계가 먼저 부른다.** 그래서 게임에서 하는 일이 다르다: 감독이 아무것도
 * 하지 않아도 사건이 생기고, 답하지 않는 것조차 하나의 답이 된다.
 *
 * ## 왜 상태에 남기나
 *
 * 회견은 "열렸다 → 감독이 답했거나 거절했다"라는 **두 시점 사이에 걸쳐 있다.**
 * 채팅 한 턴 안에서 끝나지 않으므로(감독이 다음 날 답할 수도 있다) 진행 중인
 * 협상(`NEGOTIATION`)처럼 세이브가 들고 있어야 한다.
 */

/** 무엇이 이 회견을 불렀나 — 질문의 결이 여기서 갈린다 */
export const PressTriggerSchema = z.enum([
  /** 경기 뒤 — 매 경기 붙는다 (실제 리그의 의무 회견) */
  "match",
  /** 큰 이적 — 영입·매각 성사, 또는 핵심 선수를 향한 오퍼 */
  "transfer",
  /** 연패·부진 등 감독 자리가 흔들릴 때 */
  "pressure",
]);
export type PressTrigger = z.infer<typeof PressTriggerSchema>;

/** 무엇에 대한 사실인가 — 기자가 그걸 어떻게 묻는지는 기자의 몫이다 */
export const PressFactKindSchema = z.enum([
  /** 방금 치른 경기의 결과 */
  "result",
  /** 최근 무승 */
  "winless",
  /** 폼이 바닥인 선수 */
  "slump",
  /** 라커룸에 불만이 쌓인 선수 */
  "unhappy",
  /** 영입 확정 */
  "arrival",
  /** 매각 확정 */
  "departure",
  /** 그 영입으로 자리가 겹치는 선수들 */
  "squeezed",
]);
/**
 * 회견의 재료 — **사실 한 줄.** 질문이 아니다.
 *
 * ⚠️ 코어가 질문 문장을 박아 두면 세 가지를 잃는다: ① 시즌 내내 같은 말이 반복되고
 * ② 화자의 성격이 문장에 닿지 못하며 ③ 맥락(더비인가, 감독이 어제 뭐라 했나)이
 * 반영되지 않는다. 코어가 지켜야 할 것은 **사실**이지 문장이 아니다 —
 * 무엇이 사실인지는 코어가 정하고, 그것을 어떻게 묻는지는 기자가 정한다
 * (→ docs/data/people.md §1).
 *
 * `about`이 있으면 **그 선수에 대한 사실**이다 — 감독의 답이 그 선수의 사기에
 * 직접 닿는다. 공개적으로 감쌀 수도, 공개적으로 자를 수도 있는 자리다.
 */
export const PressFactSchema = z.object({
  kind: PressFactKindSchema,
  /** 장부에서 읽은 한 줄 — **물음표도 평가어도 없다** ("웨스트햄전 1-3 패배") */
  text: z.string().min(1),
  /** 이 사실이 걸린 선수 (`GAME_PLAYER.id`) — 없으면 팀·감독에 대한 사실 */
  about: z.string().nullable(),
  /** 날 선 자리인가 — 답변의 파장(한도)을 키운다 */
  sharp: z.boolean(),
});
export type PressFact = z.infer<typeof PressFactSchema>;

export const PressStatusSchema = z.enum(["pending", "answered", "declined"]);

export const PressConferenceSchema = z.object({
  id: z.string().min(1),
  /** 열린 날 */
  date: z.string(),
  trigger: PressTriggerSchema,
  /** 한 줄 배경 — "3연패 뒤" 같은 맥락. 사실을 읽는 데 필요한 최소한만 */
  context: z.string(),
  /** 기자가 물을 수 있는 것의 **전부** — 이 밖의 사실은 세계에 없다 */
  facts: z.array(PressFactSchema).min(1),
  /**
   * 이 자리를 여는 기자 (`Persona.characterId`).
   *
   * **세계가 먼저 여는 자리는 키워드를 기다리지 않는다.** 회견은 감독이 기자
   * 이름을 말해서 열리는 게 아니라 세계가 부르는 것이므로, 그 기자의 인물지가
   * 실릴 근거도 감독의 말이 아니라 **코어가 지목한 사실**이어야 한다
   * (overview.md §1 철칙 4 — 코어는 사실만 낸다).
   *
   * 옛 세이브엔 없다 (optional) — 없다고 로드가 막히면 안 된다.
   */
  reporterId: z.string().min(1).optional(),
  status: PressStatusSchema,
  /**
   * 이 자리가 얼마나 큰가 (1~3). 실제로 파장이 다르다 — 평범한 주중 경기 뒤
   * 회견과 더비 참패 뒤 회견에 같은 무게를 주면 둘 다 의미를 잃는다.
   * 효과 한도가 이 값에 비례한다.
   */
  weight: z.number().int().min(1).max(3),
});
export type PressConference = z.infer<typeof PressConferenceSchema>;

/**
 * 감독이 취한 태도 — 자연어 답변을 LLM이 이 중 하나로 옮긴다.
 *
 * 스탠스를 **감독에게 고르게 하지 않는** 이유: 이 게임의 인터페이스는 말이다.
 * 감독은 하고 싶은 말을 하고, 그 말이 어떤 태도였는지는 세계가 읽는다.
 */
export const PRESS_STANCES = [
  /** 선수·팀을 감싼다 — 선수단이 오르고 언론은 시큰둥하다 */
  "defend",
  /** 책임을 진다 — 보드·선수단이 오르지만 언론 앞에서 약해 보인다 */
  "own",
  /** 공개적으로 날을 세운다 — 언론은 좋아하고 라커룸은 식는다 */
  "criticise",
  /** 도발·자신감 — 언론이 물고 보드는 불안해한다 */
  "bold",
  /** 말을 아낀다 — 아무것도 크게 움직이지 않는다 */
  "deflect",
] as const;
export type PressStance = (typeof PRESS_STANCES)[number];
