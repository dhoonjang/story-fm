import { z } from "zod";
import {
  agentConfig,
  createGameLLM,
  type AgentName,
  type GameLLM,
  type GameToolSpec,
  type JsonObjectSchema,
} from "@story-fm/llm";
import { journal } from "@story-fm/engine";
import { ModelOutputError, readOutput, retryOnce } from "./retry";
import { toToolSchema } from "./tool-schema";

export const UnresolvedSchema = z.string().max(200).trim();

export function unresolvedProperty(description: string) {
  return toToolSchema(z.object({ unresolved: UnresolvedSchema.optional().describe(description) }))
    .properties!.unresolved;
}

/**
 * **받아쓰기 명령의 묶음 산출** — 해석기가 코어 명령의 인자를 대신 채운다 (agents.md §1).
 *
 * 인자가 값 몇 개인 명령(오퍼·재계약·훈련·멘토·보드 요청…)은 GM이 장면을 쓰는 왕복에서
 * 채우면 하나를 빠뜨린다. 그래서 감독의 말 원문을 받은 해석기가 채우는데, 그 스키마를
 * 여기서 **다시 적지 않는다** — 도구 정의(`buildToolSpecs`)의 JSON 스키마를 그대로
 * 호출 이름 아래 배열로 묶는다. 검증도 그 도구의 Zod가 한다. 한 벌이면 갈릴 데가 없다.
 *
 * 모양: `{ ops: { send_offer: [{...}], open_renewal: [{...}] } }` — 합집합(`anyOf`)을
 * 쓰지 않는 이유는 제공자마다 받는 스키마 부분집합이 달라서다 (tool-schema.ts).
 */

/**
 * **손잡이의 문** — 이번 턴 감독의 말을 쥐고, 손잡이 하나를 한 턴에 **한 번만** 연다
 * (agents.md §1).
 *
 * 손잡이는 인자가 없다: 부르는 것이 곧 라우팅이고 원문은 코어가 넘긴다 — GM이 옮겨 적은
 * 문장이 근거가 되면 받아쓰기 왕복에서 말이 갈린다. 그래서 같은 손잡이의 두 번째 호출은
 * 같은 말을 다시 옮기는 것이라 닫는다(오퍼가 두 번 나가고 「한 칸 올려」가 두 칸
 * 움직인다). 감독의 말이 없는 턴(손잡이 턴)에는 열리지 않는다. 문구 둘은 여기 하나다.
 */
export function ordersGate(
  said: string | undefined,
): (tool: string) => { ok: true; said: string } | { ok: false; message: string } {
  const routed = new Set<string>();
  return (tool) => {
    if (said === undefined || said.trim().length === 0) {
      return { ok: false, message: "이번 턴에 감독의 말이 없습니다 — 옮길 지시가 없습니다" };
    }
    if (routed.has(tool)) {
      return {
        ok: false,
        message: "이번 턴 감독의 말은 이미 옮겼습니다 — 결과는 앞의 호출에 있습니다",
      };
    }
    routed.add(tool);
    return { ok: true, said };
  };
}

/** 한 명령을 한 턴에 부를 수 있는 수 — 오퍼 셋은 있어도 여덟은 없다 */
export const OPS_PER_COMMAND = 4;

export type OpsInput = Record<string, unknown[]>;

/**
 * 명령마다 다른 상한 — **규칙이 정한 수가 있는 자리는 그 수를 쓴다.** 교체는 다섯,
 * 개인 지시는 열한 자리, 지역 플랜은 둘. 적지 않은 명령은 `OPS_PER_COMMAND`다.
 */
export type OpsCaps = Readonly<Record<string, number>>;

/**
 * `ops`의 JSON 스키마 — 호출 이름마다 그 도구의 입력 스키마를 배열로.
 *
 * ⚠️ **상한은 `maxItems`가 아니라 설명 문장으로 간다** (models.md §3-2). 제공자가 받는
 * 스키마 부분집합이 갈려 배열 크기 제약을 아예 받지 않는 자리가 있고(Anthropic), 스키마를
 * 문법으로 펼치는 자리는 `maxItems: n`이 항목 스키마 n벌이 되어 명령 열셋에 4를 걸면
 * 요청 전체가 400으로 떨어진다. 상한 자체는 `caps`(`TACTIC_CAPS`)가 여전히 한 벌로 쥐고,
 * 지키는 것은 `parseOps`다 — 모델은 문장으로 알고 코어가 잘라 낸다. 스키마에 못 적는
 * 제약은 이 자리가 처음이 아니다(`.nullable()`·`.default()` — tool-schema.ts).
 */
export function buildOpsSchema(
  specs: ReadonlyMap<string, GameToolSpec>,
  names: readonly string[],
  description: string,
  caps: OpsCaps = {},
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const name of names) {
    const spec = specs.get(name);
    if (!spec) continue;
    properties[name] = {
      type: "array",
      items: spec.inputSchema,
      description: `${spec.description} 최대 ${caps[name] ?? OPS_PER_COMMAND}건.`,
    };
  }
  return { type: "object", properties, description };
}

/**
 * 해석기 하나가 요청에 싣는 **출력 스키마** — `{ ops, unresolved }` (models.md §3-2).
 *
 * `runOpsOrders`가 이것으로 답을 받고, 출력 스키마 선언 열(`outputAgents`)이 같은 함수를
 * 부른다. 선언을 두 벌로 적으면 재는 자가 실제로 나가는 것과 다른 것을 잰다.
 */
export function opsOutputSchema(
  spec: OpsAgentSpec,
  specs: ReadonlyMap<string, GameToolSpec>,
): JsonObjectSchema {
  return {
    type: "object",
    properties: {
      ops: buildOpsSchema(specs, spec.ops, spec.opsHint, spec.caps),
      unresolved: unresolvedProperty(spec.unresolvedHint),
    },
  };
}

/** 남은 것과 잘린 수 — 자르는 자리가 곧 그 사실을 아는 유일한 자리다 */
export interface ParsedOps {
  ops: OpsInput;
  /** 상한에 걸려 버린 수 — 명령 이름별. 자른 것이 없으면 빈 객체 */
  truncated: Record<string, number>;
}

/**
 * 모델이 낸 `ops` — 목록에 있는 이름의 배열만 남긴다. 검증은 적용 때 도구가 한다.
 *
 * **자른 수를 함께 낸다.** 상한은 스키마가 아니라 설명 문장으로 가므로(`buildOpsSchema`)
 * 디코더가 막아 주지 않고, 넘겨 온 것을 자르는 것은 여기다. 그 사실이 여기서 끝나면
 * 감독은 교체를 여섯 부르고 다섯만 걸린 판 위에 다음 판단을 쌓는다 — `applyOps`가 이
 * 수를 한 줄로 되돌린다.
 */
export function parseOps(raw: unknown, names: readonly string[], caps: OpsCaps = {}): ParsedOps {
  const ops: OpsInput = {};
  const truncated: Record<string, number> = {};
  if (typeof raw !== "object" || raw === null) return { ops, truncated };
  for (const name of names) {
    const value = (raw as Record<string, unknown>)[name];
    if (!Array.isArray(value) || value.length === 0) continue;
    const cap = caps[name] ?? OPS_PER_COMMAND;
    ops[name] = value.slice(0, cap);
    if (value.length > cap) truncated[name] = value.length - cap;
  }
  return { ops, truncated };
}

/**
 * 순서대로 적용한다 — **동기 도구만**이다. 실패도 감독에게 돌아간다(반려 문장이 곧
 * 결과다). 순서는 `names`가 정한다: 답할 것을 먼저, 새로 여는 것을 뒤에.
 */
export function applyOps(
  specs: ReadonlyMap<string, GameToolSpec>,
  orders: OpsOrders,
  names: readonly string[],
  notes: string[],
): void {
  const ops = orders.ops;
  for (const name of names) {
    const spec = specs.get(name);
    const inputs = ops[name];
    if (!spec || !inputs) continue;
    for (const input of inputs) {
      const result = spec.handle(input);
      if (result instanceof Promise) throw new Error(`${name}: 받아쓰기 적용은 동기 도구만 부른다`);
      if (result.message) notes.push(result.message);
    }
    // 자른 줄은 그 명령이 돌려준 답들 바로 뒤다 — 자리가 곧 무엇이 잘렸는지다
    const dropped = orders.truncated?.[name];
    if (dropped) notes.push(truncatedNote(inputs.length, dropped));
  }
  if (orders.unresolved) notes.push(unresolvedNote(orders.unresolved));
}

/** 이 턴에 무엇 하나라도 부르는가 */
export function hasOps(ops: OpsInput): boolean {
  return Object.keys(ops).length > 0;
}

/** 옮기지 못한 말이 감독에게 돌아가는 한 줄 — **문구는 여기 하나다** */
export function unresolvedNote(text: string): string {
  return `옮기지 못한 지시: “${text}”`;
}

/**
 * 상한에 잘린 지시가 감독에게 돌아가는 한 줄 — **문구는 여기 하나다.**
 *
 * 어느 명령인지는 이름으로 적지 않는다. 코어의 답은 명령 이름을 입에 담지 않고
 * (agents.md §0), 이 줄은 그 명령이 돌려준 답들 바로 뒤에 서므로 자리가 곧 무엇인지다.
 */
export function truncatedNote(kept: number, dropped: number): string {
  return `한 번에 ${kept}건까지 걸립니다 — 나머지 ${dropped}건은 걸지 못했습니다`;
}

/** 값이 있을 때만 서는 태그 블록 — 세 해석기의 입력이 같은 모양으로 조립된다 */
export function tagged(tag: string, body: string): string[] {
  return body.trim().length > 0 ? [`<${tag}>`, body, `</${tag}>`] : [];
}

/** 받아쓰기 해석기가 내는 것 — 부를 명령과 그 인자, 그리고 옮기지 못한 말 */
export interface OpsOrders {
  ops: OpsInput;
  /** 상한에 걸려 자른 수 — 명령 이름별. `applyOps`가 한 줄로 되돌린다 */
  truncated?: Readonly<Record<string, number>>;
  unresolved?: string;
}

/**
 * 해석기의 산출 — `ops`는 모양만 보고(`parseOps`가 목록의 이름과 배열만 남긴다) `unresolved`는
 * 여기서 잰다. 명령 인자의 검증은 적용 때 그 명령의 Zod가 한다.
 */
const OpsReportSchema = z.object({
  ops: z.record(z.unknown()).optional(),
  unresolved: UnresolvedSchema.optional(),
});

/** 한 해석기를 세우는 데 필요한 전부 — 프롬프트·명령 목록·문구 */
export interface OpsAgentSpec {
  /** `config/llm.yml`의 키이자 재시도 로그의 이름 — 기록·설정·재시도가 전부 이 이름으로 돈다 */
  agent: AgentName;
  system: string;
  /** 채울 명령과 그 순서 */
  ops: readonly string[];
  /** 명령마다 다른 상한 — 적지 않으면 `OPS_PER_COMMAND` */
  caps?: OpsCaps;
  opsHint: string;
  unresolvedHint: string;
  /** 옮길 것이 하나도 없을 때 감독에게 되묻는 말 */
  emptyHint: string;
}

/**
 * **받아쓰기 해석기의 한 벌** — 훈련과 시장이 같은 함수를 지난다 (agents.md §1).
 *
 * 도구 없이 출력 스키마로 답을 받으므로 요청은 하나다(models.md §3-2). 산출이 안 오거나
 * 스키마를 못 지나면 한 번 더 부르고, 그래도 없으면 도구가 반려로 답한다. 빈 산출도
 * 반려다 — 아무것도 부르지 않은 채 "걸었습니다"가 돌아가면 감독은 걸리지 않은 지시 위에
 * 다음 판단을 쌓는다.
 */
export async function runOpsOrders(
  spec: OpsAgentSpec,
  specs: ReadonlyMap<string, GameToolSpec>,
  user: string,
  llm?: GameLLM,
  /** 감독의 말 원문 — 기록에 `ops` 옆에 선다. 프롬프트(`user`)에는 맥락이 함께 실려 있다 */
  raw?: string,
): Promise<{ ok: true; orders: OpsOrders } | { ok: false; message: string }> {
  let orders: OpsOrders | null = null;
  let client = llm;
  /** 기록의 밑절미 — 호출이 몇 번 돌았는지는 `attempts`가 센다 (models.md §5-3) */
  let attempts = 0;
  const intent = (rest: Record<string, unknown>) =>
    journal({
      kind: "orders.intent",
      agent: spec.agent,
      raw: raw ?? null,
      retried: attempts > 1,
      ok: false,
      ...rest,
    } as Parameters<typeof journal>[0]);
  const schema = opsOutputSchema(spec, specs);
  try {
    await retryOnce(
      spec.agent,
      async () => {
        attempts += 1;
        client ??= createGameLLM(agentConfig(spec.agent));
        const result = await client.runTurn({
          system: spec.system,
          history: [],
          user,
          outputSchema: schema,
        });
        const report = readOutput(spec.agent, OpsReportSchema, result);
        const { ops, truncated } = parseOps(report.ops, spec.ops, spec.caps);
        orders = {
          ops,
          ...(Object.keys(truncated).length > 0 ? { truncated } : {}),
          ...(report.unresolved ? { unresolved: report.unresolved } : {}),
        };
      },
      () => orders !== null,
    );
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    if (orders === null && !(error instanceof ModelOutputError)) {
      intent({ failure });
      throw error;
    }
    console.warn(`[${spec.agent}] 해석 호출이 실패했습니다:`, error);
    if (orders === null) {
      intent({ failure, message: "지시를 옮기지 못했습니다 — 다시 말씀해 주세요" });
      return { ok: false, message: "지시를 옮기지 못했습니다 — 다시 말씀해 주세요" };
    }
  }
  if (orders === null) {
    intent({ message: "지시를 옮기지 못했습니다 — 다시 말씀해 주세요" });
    return { ok: false, message: "지시를 옮기지 못했습니다 — 다시 말씀해 주세요" };
  }
  const got: OpsOrders = orders;
  const shape = {
    ops: got.ops,
    ...(got.truncated ? { truncated: got.truncated } : {}),
    ...(got.unresolved ? { unresolved: got.unresolved } : {}),
  };
  if (!hasOps(got.ops) && !got.unresolved) {
    intent({ ...shape, message: spec.emptyHint });
    return { ok: false, message: spec.emptyHint };
  }
  intent({ ...shape, ok: true });
  return { ok: true, orders: got };
}
