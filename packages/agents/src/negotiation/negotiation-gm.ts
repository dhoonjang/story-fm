import { z } from "zod";
import { CharacterUpdateSchema, NegotiationActionSchema, type Negotiation } from "@story-fm/domain";
import type { TextHistoryMessage } from "@story-fm/llm";
import { SCENE_OUTPUT_GRAMMAR } from "../common/scene-output";
import { toToolSchema } from "../common/tool-schema";

export const NEGOTIATION_GM_SYSTEM = `당신은 풋볼 매니저의 협상 GM이다. 하나의 협상 건에서 구단·선수·에이전트·내부 직원 모두를 연기한다. club/player/internal은 수신 범위이며 독립된 비밀 이력이 아니다.
이전 대화와 인물 기억을 이어 한국어로 답한다. 정확한 조건·동의·소속·부상·재정은 최신 장부가 유일한 근거다. 요약의 동의 표현은 집행 권한이 아니다.
negotiation_action에 실제 행동 당사자의 partyId를 붙인다. 수락·거절은 당사자의 필요·현실적 대안·조건·새 사실에 근거한다. 말의 횟수로 양보하지 않는다. 금액은 정수 £, 급여는 주급이다. 자유 약속으로 금전 조항을 우회하지 않는다.
감독은 자연어로 조건을 논의한다. 구체적으로 논의된 조건을 negotiation_action의 draft로 정리하되 이는 비구속 초안이다. 금액·기간·약속이 불명확하면 질문하고 감독의 재정 의도를 만들지 않는다. 유저 구단에는 draft만 가능하며 send·accept·sign은 할 수 없다. 감독의 대화 속 찬성도 유저의 동의가 아니다.
상대는 논의된 초안에 동의하거나 반대 제안을 할 때 자신의 partyId로 send하여 정확한 조건을 제시한다. 이 기록에는 발송한 상대의 동의만 있다. 유저 발송을 기다리지 말고 상대가 제안한 조건에 대해 감독의 화면상 명시적 합의를 기다린다. 초안만 있거나 필요한 조건이 불완전하면 합의된 것으로 말하지 않는다. 변경된 발송 조건은 새 제안이다. 감독이 명시적으로 합의한 정확한 제안은 새로운 사실이나 조건 변경 요청 없이 교체하지 않는다. 합의 뒤에는 다음 확인 단계로 진행한다.
재계약 시작일은 별도 논의가 없으면 오늘, 이적·자유계약 합류일은 구단 조건의 미래 합류일에 맞추고 없으면 최신 기본 날짜를 참고한다. 연 단위 종료일은 시작일의 N년 후 전날이며 제공된 계약 날짜를 참고한다. 재계약은 조건 동의가 완성되면 메디컬 없이 감독의 최종 서명을 기다린다. 이적·자유계약은 동의 뒤 감독이 메디컬 요청·실제 검사 결과 확인과 위험 감수·최종 서명을 직접 확인한다. 부상을 만들거나 결과를 재추첨하지 않는다.
AI끼리의 협상은 같은 도구와 검증으로 진행하고 단계별 다음 답변을 schedule_reply로 다음 게임 날짜에 예약한다. 현재 날짜보다 과거의 사건을 새로 작성하지 않는다.
새롭게 기억할 인물 정보는 update_character로 직접 요청한다. 다른 협상이나 메인 장면을 쓰지 않는다. 도구 결과 뒤 현재 수신 범위에 맞는 답변을 한 번 작성한다. 도구가 거부한 행동은 실행되었다고 말하지 않는다.

# 출력 문법
장면은 @로 연다. 시점은 코어가 기록한다.
${SCENE_OUTPUT_GRAMMAR}`;
export const NegotiationToolInputSchema = z
  .object({
    partyId: z.string().min(1),
    action: NegotiationActionSchema,
  })
  .strict();
export const ScheduleReplySchema = z
  .object({ on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
  .strict();
export const NEGOTIATION_ACTION_INPUT = toToolSchema(NegotiationToolInputSchema);
export const NEGOTIATION_CHARACTER_INPUT = toToolSchema(CharacterUpdateSchema);
export const NEGOTIATION_SCHEDULE_INPUT = toToolSchema(ScheduleReplySchema);
export const NegotiationDigestSchema = z
  .object({ text: z.string().trim().min(1).max(6000) })
  .strict();
export const NEGOTIATION_DIGEST_INPUT = toToolSchema(NegotiationDigestSchema);
export const NEGOTIATION_COMPACTOR_SYSTEM = `협상 원문과 이전 요약을 합쳐 이유·양보·미해결 쟁점·인물 반응을 요약한다. 조건 숫자·제안 id·동의·서명은 요약하지 않는다. 정확한 제안과 집행 권한은 장부가 소유한다. 원문에 없는 사실을 만들지 않는다. 6000자 이내 text 하나로 답한다.`;
export const NEGOTIATION_HISTORY_LIMIT = 24000;
export const NEGOTIATION_HISTORY_KEEP = 8;

export function negotiationHistory(n: Negotiation): TextHistoryMessage[] {
  const history: TextHistoryMessage[] = [];
  if (n.digest.text)
    history.push({
      role: "user",
      content: `<negotiation_digest>${n.digest.text}</negotiation_digest>`,
    });
  for (const message of n.messages.slice(n.digest.through))
    history.push({
      role: message.author === "gm" ? "assistant" : "user",
      content: `[${message.on} · ${message.channel} · ${message.author} · ${message.partyId ?? "system"}] ${message.text}`,
    });
  return history;
}
