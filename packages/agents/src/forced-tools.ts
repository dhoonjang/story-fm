import type { AgentName, GameToolSpec, JsonObjectSchema } from "@story-fm/llm";
import {
  FINALIZE_MATCH_SYSTEM,
  SETTLE_MATCH_DESCRIPTION,
  SETTLE_MATCH_INPUT,
  SETTLE_MATCH_TOOL,
} from "./finalize-match";
import {
  HISTORY_COMPACTOR_SYSTEM,
  REPORT_DIGEST_DESCRIPTION,
  REPORT_DIGEST_INPUT,
  REPORT_DIGEST_TOOL,
} from "./history-compactor";
import { MARKET_ORDERS_SPEC } from "./market-orders";
import {
  NEGOTIATION_TABLE_SYSTEM,
  REPLY_DESCRIPTION,
  REPLY_INPUT,
  REPLY_TOOL,
} from "./negotiation-table";
import {
  ONBOARDING_JUDGE_SYSTEM,
  REPORT_ONBOARDING_DESCRIPTION,
  REPORT_ONBOARDING_INPUT,
  REPORT_ONBOARDING_TOOL,
} from "./onboarding-judge";
import { opsToolDeclaration } from "./orders-ops";
import { TACTIC_ORDERS_SPEC } from "./tactic-orders";
import { TRAINING_ORDERS_SPEC } from "./training-orders";
import {
  REPORT_TRAINING_DESCRIPTION,
  REPORT_TRAINING_INPUT,
  REPORT_TRAINING_TOOL,
  TRAINING_RATER_SYSTEM,
} from "./training-rater";

/**
 * **도구 하나를 강제로 걸고 부르는 산출 호출 전부** (docs/llm/prompts.md §2).
 *
 * 강제 모드(`toolChoice: { name }`)는 제공자가 받아 주는 스키마가 한 겹 더 좁은
 * 자리다 — Gemini는 그 모드에서 스키마를 펼쳐 디코딩 문법을 만들어, 자유 모드로는
 * 지나던 선언이 400 하나로 떨어진다 (docs/llm/models.md §3-2). 그 폭이 지켜지는지
 * 묻는 자 둘(`skill-descriptions.test.ts`의 오프라인 불변식과 `live-schema` 하네스)이
 * **같은 목록을 읽어야** 재는 것과 나가는 것이 갈리지 않는다.
 *
 * ⚠️ 선언을 여기에 **다시 적지 않는다.** 이름·설명·스키마는 그 호출이 실제로 싣는
 * 상수 그대로이고, 해석기 셋은 `runOpsOrders`와 같은 함수로 조립한다. 손으로 옮겨
 * 적으면 두 벌이 갈리는 날 재는 자가 나가지 않는 스키마를 재게 된다.
 */
export interface ForcedTool {
  /** `config/llm.yml`의 키 — **어느 제공자로 나가는지가 여기서 정해진다** */
  readonly agent: AgentName;
  /** 그 호출의 시스템 프롬프트 — 실호출 스모크가 같은 요청을 세운다 */
  readonly system: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObjectSchema;
}

/**
 * 강제 선언 여덟 — 해석기 셋과 결산·판정 다섯.
 *
 * 해석기의 `ops`가 코어 명령의 도구 스키마를 그대로 물어 오므로(agents.md §1) 명령
 * 스펙 맵이 필요하다 — `buildToolSpecs(state, [])`가 그것이다.
 */
export function forcedTools(specs: ReadonlyMap<string, GameToolSpec>): readonly ForcedTool[] {
  return [
    ...[TACTIC_ORDERS_SPEC, TRAINING_ORDERS_SPEC, MARKET_ORDERS_SPEC].map((spec) => ({
      agent: spec.agent,
      system: spec.system,
      ...opsToolDeclaration(spec, specs),
    })),
    {
      agent: "finalize-match",
      system: FINALIZE_MATCH_SYSTEM,
      name: SETTLE_MATCH_TOOL,
      description: SETTLE_MATCH_DESCRIPTION,
      inputSchema: SETTLE_MATCH_INPUT,
    },
    {
      agent: "training-rater",
      system: TRAINING_RATER_SYSTEM,
      name: REPORT_TRAINING_TOOL,
      description: REPORT_TRAINING_DESCRIPTION,
      inputSchema: REPORT_TRAINING_INPUT,
    },
    {
      agent: "onboarding-judge",
      system: ONBOARDING_JUDGE_SYSTEM,
      name: REPORT_ONBOARDING_TOOL,
      description: REPORT_ONBOARDING_DESCRIPTION,
      inputSchema: REPORT_ONBOARDING_INPUT,
    },
    {
      agent: "history-compactor",
      system: HISTORY_COMPACTOR_SYSTEM,
      name: REPORT_DIGEST_TOOL,
      description: REPORT_DIGEST_DESCRIPTION,
      inputSchema: REPORT_DIGEST_INPUT,
    },
    {
      agent: "negotiation-table",
      system: NEGOTIATION_TABLE_SYSTEM,
      name: REPLY_TOOL,
      description: REPLY_DESCRIPTION,
      inputSchema: REPLY_INPUT,
    },
  ];
}
