import {
  NEGOTIATION_OPENING_OUTPUT,
  NEGOTIATION_OPENING_SYSTEM,
} from "../negotiation/negotiation-opening";
import { MARKET_PLANNER_SYSTEM, MARKET_PLAN_INPUT } from "../negotiation/market-planner";
import {
  NEGOTIATION_COMPACTOR_SYSTEM,
  NEGOTIATION_DIGEST_INPUT,
} from "../negotiation/negotiation-gm";
import { LOREBOOK_EDITOR_SYSTEM, LOREBOOK_EDITOR_OUTPUT } from "../story/lorebook-editor";
import type { GenerativeAgentName, JsonObjectSchema } from "@story-fm/llm";
import { HISTORY_COMPACTOR_SYSTEM, REPORT_DIGEST_INPUT } from "../story/history-compactor";
import { ONBOARDING_JUDGE_SYSTEM, REPORT_ONBOARDING_INPUT } from "../story/onboarding-judge";

/** 생성형 판정 호출의 실제 프롬프트·출력 스키마. 오프라인 검증과 실호출 하네스가 공유한다. */
export interface OutputAgent {
  /** `config/llm.yml`의 키 — **어느 제공자로 나가는지가 여기서 정해진다** */
  readonly agent: GenerativeAgentName;
  /** 그 호출의 시스템 프롬프트 — 실호출 스모크가 같은 요청을 세운다 */
  readonly system: string;
  /** 그 호출이 요청에 싣는 출력 스키마 — 그 산출의 Zod에서 파생한 그대로 */
  readonly schema: JsonObjectSchema;
}

export function outputAgents(): readonly OutputAgent[] {
  return [
    {
      agent: "negotiation-gm",
      system: NEGOTIATION_OPENING_SYSTEM,
      schema: NEGOTIATION_OPENING_OUTPUT,
    },
    { agent: "market-planner", system: MARKET_PLANNER_SYSTEM, schema: MARKET_PLAN_INPUT },
    {
      agent: "negotiation-compactor",
      system: NEGOTIATION_COMPACTOR_SYSTEM,
      schema: NEGOTIATION_DIGEST_INPUT,
    },
    {
      agent: "lorebook-editor",
      system: LOREBOOK_EDITOR_SYSTEM,
      schema: LOREBOOK_EDITOR_OUTPUT,
    },
    { agent: "onboarding-judge", system: ONBOARDING_JUDGE_SYSTEM, schema: REPORT_ONBOARDING_INPUT },
    { agent: "history-compactor", system: HISTORY_COMPACTOR_SYSTEM, schema: REPORT_DIGEST_INPUT },
  ];
}
