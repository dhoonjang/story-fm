/**
 * 도구 입력 스키마 — **Zod 하나에서 JSON 스키마를 파생한다** (prompts.md §5).
 *
 * 모델이 보는 것과 코어가 검증하는 것이 손으로 맞춘 두 벌이면 언젠가 갈리고, 갈리는
 * 방향마다 값이 다르다. JSON이 느슨하면 모델은 통과할 줄 알고 보낸 입력을 반려당하고,
 * Zod에만 있는 상한은 모델이 모르는 채로 그 도구를 계속 실패시킨다. 그래서 원본은
 * Zod 한 벌이고 JSON은 여기서 나온다.
 *
 * ## 왜 라이브러리를 넣지 않았나
 *
 * 어댑터가 이 객체를 **제공자에게 그대로 넘긴다**(`GameToolSpec.inputSchema`). 범용
 * 변환기는 `$schema`·`additionalProperties`·재사용 스키마의 `$ref`를 함께 내고 1~3의
 * 리터럴 합집합을 `anyOf`/`const`로 펴므로, 서른두 도구의 스키마 모양이 한꺼번에 바뀐다
 * — 제공자마다 어디서 걸리는지는 런타임에야 드러난다. 여기 있는 것은 도구가 실제로 쓰는
 * Zod 갈래뿐이고, 내는 모양은 손으로 적던 것과 같다. 모르는 갈래를 만나면 조용히 빈
 * 스키마를 내는 대신 **던진다** — 검증만 하고 모델은 모르는 인자가 생기는 자리다.
 */
import { z } from "zod";
import type { JsonObjectSchema } from "@story-fm/llm";

type JsonSchemaNode = Record<string, unknown>;

/** 도구 하나의 입력 — 최상위는 항상 객체다 (제공자 계약) */
export function toToolSchema(schema: z.ZodTypeAny): JsonObjectSchema {
  const node = derive(schema);
  if (node.type !== "object") {
    throw new Error(`도구 입력은 객체여야 합니다 — ${JSON.stringify(node.type)}`);
  }
  return node as JsonObjectSchema;
}

/** 바깥 설명이 이긴다 — `.optional().describe()`는 감싼 쪽에 붙는다 */
function described(node: JsonSchemaNode, schema: z.ZodTypeAny): JsonSchemaNode {
  return schema.description === undefined ? node : { ...node, description: schema.description };
}

function derive(schema: z.ZodTypeAny): JsonSchemaNode {
  if (schema instanceof z.ZodOptional) return described(derive(schema.unwrap()), schema);
  if (schema instanceof z.ZodString) return described(stringNode(schema), schema);
  if (schema instanceof z.ZodNumber) return described(numberNode(schema), schema);
  if (schema instanceof z.ZodBoolean) return described({ type: "boolean" }, schema);
  if (schema instanceof z.ZodEnum) {
    return described({ type: "string", enum: [...schema.options] }, schema);
  }
  if (schema instanceof z.ZodArray) return described(arrayNode(schema), schema);
  if (schema instanceof z.ZodObject) return described(objectNode(schema), schema);
  if (schema instanceof z.ZodUnion) return described(unionNode(schema), schema);
  if (schema instanceof z.ZodLiteral) return described(literalNode(schema.value), schema);
  throw new Error(`도구 스키마로 옮길 수 없는 갈래입니다: ${schema.constructor.name}`);
}

function stringNode(schema: z.ZodString): JsonSchemaNode {
  const node: JsonSchemaNode = { type: "string" };
  if (schema.minLength !== null) node.minLength = schema.minLength;
  if (schema.maxLength !== null) node.maxLength = schema.maxLength;
  // 정규식만 공개 게터가 없다 — 날짜 형식(`^\d{4}-\d{2}-\d{2}$`)이 모델에게 닿는 자리다
  for (const check of schema._def.checks) {
    if (check.kind === "regex") node.pattern = check.regex.source;
  }
  return node;
}

function numberNode(schema: z.ZodNumber): JsonSchemaNode {
  const node: JsonSchemaNode = { type: schema.isInt ? "integer" : "number" };
  if (schema.minValue !== null) node.minimum = schema.minValue;
  if (schema.maxValue !== null) node.maximum = schema.maxValue;
  return node;
}

function arrayNode(schema: z.ZodArray<z.ZodTypeAny>): JsonSchemaNode {
  const node: JsonSchemaNode = { type: "array", items: derive(schema.element) };
  const def = schema._def;
  if (def.exactLength !== null) {
    node.minItems = def.exactLength.value;
    node.maxItems = def.exactLength.value;
    return node;
  }
  if (def.minLength !== null) node.minItems = def.minLength.value;
  if (def.maxLength !== null) node.maxItems = def.maxLength.value;
  return node;
}

function objectNode(schema: z.ZodObject<z.ZodRawShape>): JsonSchemaNode {
  const properties: Record<string, JsonSchemaNode> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(schema.shape)) {
    properties[key] = derive(value);
    if (!(value instanceof z.ZodOptional)) required.push(key);
  }
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

/**
 * 리터럴만 모인 합집합은 **열거**다 — `intensity: 1|2|3`이 그것이다. `anyOf`로 펴면
 * 같은 제약이 모델에게 세 갈래 스키마로 보인다.
 */
function unionNode(schema: z.ZodUnion<readonly [z.ZodTypeAny, ...z.ZodTypeAny[]]>): JsonSchemaNode {
  const options: readonly z.ZodTypeAny[] = schema.options;
  const literals = options.filter((o): o is z.ZodLiteral<unknown> => o instanceof z.ZodLiteral);
  if (literals.length !== options.length) return { anyOf: options.map(derive) };
  const values = literals.map((l) => l.value);
  const first = literalNode(values[0]);
  return { type: first.type, enum: values };
}

function literalNode(value: unknown): JsonSchemaNode {
  if (typeof value === "string") return { type: "string", const: value };
  if (typeof value === "boolean") return { type: "boolean", const: value };
  if (typeof value === "number") {
    return { type: Number.isInteger(value) ? "integer" : "number", const: value };
  }
  throw new Error(`도구 스키마로 옮길 수 없는 리터럴입니다: ${String(value)}`);
}
