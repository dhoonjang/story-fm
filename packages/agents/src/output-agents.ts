import type { AgentName, GameToolSpec, JsonObjectSchema } from "@story-fm/llm";
import { FINALIZE_MATCH_SYSTEM, SETTLE_MATCH_INPUT } from "./finalize-match";
import { HISTORY_COMPACTOR_SYSTEM, REPORT_DIGEST_INPUT } from "./history-compactor";
import { MARKET_ORDERS_SPEC } from "./market-orders";
import { NEGOTIATION_TABLE_SYSTEM, REPLY_INPUT } from "./negotiation-table";
import { ONBOARDING_JUDGE_SYSTEM, REPORT_ONBOARDING_INPUT } from "./onboarding-judge";
import { opsOutputSchema } from "./orders-ops";
import { REPORT_SCOUT_INPUT, SCOUT_RATER_SYSTEM } from "./scout-rater";
import { TABLE_ORDERS_SPEC } from "./table-orders";
import { TACTIC_ORDERS_SPEC } from "./tactic-orders";
import { TRAINING_ORDERS_SPEC } from "./training-orders";
import { REPORT_TRAINING_INPUT, TRAINING_RATER_SYSTEM } from "./training-rater";

/**
 * **도구 없이 출력 스키마로 답을 받는 호출 전부** — 해석기 넷과 결산·판정 여섯
 * (docs/llm/prompts.md §2 · models.md §3-2).
 *
 * 제공자가 받는 스키마 부분집합은 셋이 다르고, 옮기는 자리는 어댑터다. 그 폭이 지켜지는지
 * 묻는 자 둘(`skill-descriptions.test.ts`의 오프라인 불변식과 `live-schema` 하네스)이
 * **같은 목록을 읽어야** 재는 것과 나가는 것이 갈리지 않는다.
 *
 * ⚠️ 선언을 여기에 **다시 적지 않는다.** 시스템 프롬프트와 스키마는 그 호출이 실제로 싣는
 * 상수 그대로이고, 해석기 넷은 `runOpsOrders`와 같은 함수로 조립한다. 손으로 옮겨 적으면
 * 두 벌이 갈리는 날 재는 자가 나가지 않는 스키마를 재게 된다.
 *
 * 이름이 없다 — 설정·기록·재시도가 전부 `agent` 하나로 돈다. 도구 이름이 붙는 것은 GM
 * 둘의 카탈로그뿐이다.
 */
export interface OutputAgent {
  /** `config/llm.yml`의 키 — **어느 제공자로 나가는지가 여기서 정해진다** */
  readonly agent: AgentName;
  /** 그 호출의 시스템 프롬프트 — 실호출 스모크가 같은 요청을 세운다 */
  readonly system: string;
  /** 그 호출이 요청에 싣는 출력 스키마 — 그 산출의 Zod에서 파생한 그대로 */
  readonly schema: JsonObjectSchema;
}

/**
 * 출력 스키마 선언 열 — 해석기 넷과 결산·판정 여섯.
 *
 * 해석기의 `ops`가 코어 명령의 도구 스키마를 그대로 물어 오므로(agents.md §1) 명령
 * 스펙 맵이 필요하다 — `buildToolSpecs(state, [])`가 그것이다.
 */
export function outputAgents(specs: ReadonlyMap<string, GameToolSpec>): readonly OutputAgent[] {
  return [
    ...[TACTIC_ORDERS_SPEC, TRAINING_ORDERS_SPEC, MARKET_ORDERS_SPEC, TABLE_ORDERS_SPEC].map(
      (spec) => ({ agent: spec.agent, system: spec.system, schema: opsOutputSchema(spec, specs) }),
    ),
    { agent: "finalize-match", system: FINALIZE_MATCH_SYSTEM, schema: SETTLE_MATCH_INPUT },
    { agent: "training-rater", system: TRAINING_RATER_SYSTEM, schema: REPORT_TRAINING_INPUT },
    { agent: "scout-rater", system: SCOUT_RATER_SYSTEM, schema: REPORT_SCOUT_INPUT },
    { agent: "onboarding-judge", system: ONBOARDING_JUDGE_SYSTEM, schema: REPORT_ONBOARDING_INPUT },
    { agent: "history-compactor", system: HISTORY_COMPACTOR_SYSTEM, schema: REPORT_DIGEST_INPUT },
    { agent: "negotiation-table", system: NEGOTIATION_TABLE_SYSTEM, schema: REPLY_INPUT },
  ];
}
