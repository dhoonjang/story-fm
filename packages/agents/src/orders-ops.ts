import type { GameToolSpec } from "@story-fm/llm";

/**
 * **받아쓰기 명령의 묶음 산출** — 해석기가 코어 명령의 인자를 대신 채운다 (agents.md §1).
 *
 * 인자가 값 몇 개인 명령(오퍼·재계약·훈련·멘토·보드 요청…)은 GM이 장면을 쓰는 왕복에서
 * 채우면 하나를 빠뜨린다. 그래서 감독의 말 원문을 받은 해석기가 채우는데, 그 스키마를
 * 여기서 **다시 적지 않는다** — 도구 정의(`buildSkillTools`)의 JSON 스키마를 그대로
 * 호출 이름 아래 배열로 묶는다. 검증도 그 도구의 Zod가 한다. 한 벌이면 갈릴 데가 없다.
 *
 * 모양: `{ ops: { send_offer: [{...}], open_renewal: [{...}] } }` — 합집합(`anyOf`)을
 * 쓰지 않는 이유는 제공자마다 받는 스키마 부분집합이 달라서다 (tool-schema.ts).
 */

/** 한 명령을 한 턴에 부를 수 있는 수 — 오퍼 셋은 있어도 여덟은 없다 */
export const OPS_PER_SKILL = 4;

export type OpsInput = Record<string, unknown[]>;

/** `ops`의 JSON 스키마 — 호출 이름마다 그 도구의 입력 스키마를 배열로 */
export function buildOpsSchema(
  specs: ReadonlyMap<string, GameToolSpec>,
  names: readonly string[],
  description: string,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const name of names) {
    const spec = specs.get(name);
    if (!spec) continue;
    properties[name] = {
      type: "array",
      items: spec.inputSchema,
      maxItems: OPS_PER_SKILL,
      description: spec.description,
    };
  }
  return { type: "object", properties, description };
}

/** 모델이 낸 `ops` — 목록에 있는 이름의 배열만 남긴다. 검증은 적용 때 도구가 한다 */
export function parseOps(raw: unknown, names: readonly string[]): OpsInput {
  const ops: OpsInput = {};
  if (typeof raw !== "object" || raw === null) return ops;
  for (const name of names) {
    const value = (raw as Record<string, unknown>)[name];
    if (Array.isArray(value) && value.length > 0) ops[name] = value.slice(0, OPS_PER_SKILL);
  }
  return ops;
}

/**
 * 순서대로 적용한다 — **동기 도구만**이다. 실패도 감독에게 돌아간다(반려 문장이 곧
 * 결과다). 순서는 `names`가 정한다: 답할 것을 먼저, 새로 여는 것을 뒤에.
 */
export function applyOps(
  specs: ReadonlyMap<string, GameToolSpec>,
  ops: OpsInput,
  names: readonly string[],
  notes: string[],
): void {
  for (const name of names) {
    const spec = specs.get(name);
    const inputs = ops[name];
    if (!spec || !inputs) continue;
    for (const input of inputs) {
      const result = spec.handle(input);
      if (result instanceof Promise) throw new Error(`${name}: 받아쓰기 적용은 동기 도구만 부른다`);
      if (result.message) notes.push(result.message);
    }
  }
}

/** 이 턴에 무엇 하나라도 부르는가 */
export function hasOps(ops: OpsInput): boolean {
  return Object.keys(ops).length > 0;
}
