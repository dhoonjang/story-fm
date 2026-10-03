import { z } from "zod";
import { toToolSchema } from "../common/tool-schema";

export const NegotiationOpeningSchema = z
  .object({ suggestion: z.string().trim().min(1).max(1000) })
  .strict();
export const NEGOTIATION_OPENING_OUTPUT = toToolSchema(NegotiationOpeningSchema);
export const NEGOTIATION_OPENING_SYSTEM = `감독이 새 협상에서 직접 보낼 첫 제안 문구를 한국어 suggestion 하나로 작성한다. 최신 장부와 협상 배경을 근거로 감독의 입장에서 상대에게 말을 건다. 상대의 답변이나 동의, 확정된 조건을 만들지 않는다. 문구는 아직 발송되지 않은 편집 가능한 제안이다. 화자 태그·지문 없이 입력창에 어울리는 짧은 1~2문장으로 감독이 보낼 말만 쓴다.`;
