/**
 * 출력 스키마로 받은 답을 읽는다 — **제공자 셋이 같은 자리다** (models.md §3-2).
 *
 * 셋 다 스키마에 맞춘 JSON을 본문 텍스트로 돌려준다. 어댑터는 여기까지고, 그 객체가
 * 스키마를 지키는지는 부르는 쪽의 Zod가 본다 — 제공자가 스키마를 얼마나 강제하는지가
 * 다르기 때문이다(OpenAI는 `strict: false`라 안내일 뿐이다).
 *
 * 최상위는 객체여야 한다(`JsonObjectSchema`). 잘린 응답의 반쪽 JSON, 거절 문장, 산문은 전부
 * `null`이다 — 그것이 "산출이 오지 않았다"의 유일한 신호다.
 */
export function parseOutput(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * 스키마의 **선택 속성 수** — `properties`에 있으되 `required`에 없는 자리를 스키마 전체에서
 * 센다. 스키마를 문법으로 펼치는 제공자는 이 수에 한도를 둔다(Anthropic 24 — 2026-09 실측,
 * `ANTHROPIC_OUTPUT_SCHEMA_LIMITS`). 산출을 세우는 쪽이 제공자를 고를 때 그 문을 지나는지
 * 미리 아는 자리다 — 실호출로 400을 맞아 알아내지 않는다 (models.md §3-2).
 */
export function countOptionalProperties(schema: unknown): number {
  if (Array.isArray(schema))
    return schema.reduce<number>((sum, n) => sum + countOptionalProperties(n), 0);
  if (schema === null || typeof schema !== "object") return 0;
  const node = schema as Record<string, unknown>;
  let count = 0;
  const properties = node.properties;
  if (properties !== null && typeof properties === "object") {
    const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
    for (const [name, sub] of Object.entries(properties as Record<string, unknown>)) {
      if (!required.has(name)) count += 1;
      count += countOptionalProperties(sub);
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties") continue;
    count += countOptionalProperties(value);
  }
  return count;
}
