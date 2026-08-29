import { z } from "zod";
import {
  agentConfig,
  createGameLLM,
  type AgentName,
  type GameLLM,
  type GameToolSpec,
} from "@story-fm/llm";
import { ModelOutputError, requireToolCall, retryOnce } from "./retry";
import { inputError } from "./tool-schema";

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
 * 손잡이가 받는 인자 — **감독의 말 원문 하나뿐이다.** 네 손잡이(전술·훈련·시장)와 매치
 * GM의 지시 도구가 같은 스키마를 쓴다. 상한은 오타를 막는 폭이지 요약을 시키는 자리가
 * 아니다 — 요약하면 해석기가 감독이 하지 않은 말을 옮긴다.
 */
export const ORDERS_MAX = 2000;
export const OrdersArgsSchema = z.object({
  orders: z
    .string()
    .min(1)
    .max(ORDERS_MAX)
    .describe("감독이 이번 턴에 한 말 — 요약하지 않고 원문 그대로"),
});

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
 * ⚠️ **상한은 `maxItems`가 아니라 설명 문장으로 간다** (models.md §3-2). 해석기는
 * 강제 도구로 부르는데(`toolChoice`), Gemini는 그 모드에서 스키마를 **펼쳐** 디코딩
 * 문법을 만든다 — `maxItems: n`은 항목 스키마를 n벌 복제한 문법이 되어, 명령 열셋에
 * 4를 걸면 문법이 한도를 넘어 요청 전체가 400 `INVALID_ARGUMENT`으로 떨어진다.
 * 오류 본문은 `Request contains an invalid argument.` 한 줄뿐이라 어느 칸이 문제인지
 * 말하지 않고, §1-1의 표에서 `unknown`이라 화면에는 "응답을 받지 못해"만 선다.
 *
 * 상한 자체는 `caps`(`TACTIC_CAPS`)가 여전히 한 벌로 쥐고, 지키는 것은 `parseOps`다 —
 * 모델은 문장으로 알고 코어가 잘라 낸다. 스키마에 못 적는 제약은 이 자리가 처음이
 * 아니다(`.nullable()`·`.default()` — tool-schema.ts).
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
 * 해석기 하나가 **강제로 거는 산출 도구의 선언** — 이름·설명·입력 스키마.
 *
 * `runOpsOrders`가 여기에 핸들러를 붙여 쓰고, 강제 선언 목록(`forcedTools`)이 같은
 * 함수를 부른다. 선언을 두 벌로 적으면 재는 자가 실제로 나가는 것과 다른 것을 잰다.
 */
export function opsToolDeclaration(
  spec: OpsAgentSpec,
  specs: ReadonlyMap<string, GameToolSpec>,
): Pick<GameToolSpec, "name" | "description" | "inputSchema"> {
  return {
    name: spec.tool,
    description: "감독의 말을 명령의 인자로 제출한다. 이 도구로만 답한다.",
    inputSchema: {
      type: "object",
      properties: {
        ops: buildOpsSchema(specs, spec.ops, spec.opsHint, spec.caps),
        unresolved: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: spec.unresolvedHint,
        },
      },
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
  return `옮기지 못한 지시: "${text}"`;
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

const ReportSchema = z.object({
  unresolved: z.string().min(1).max(200).optional(),
});

/** 한 해석기를 세우는 데 필요한 전부 — 프롬프트·명령 목록·문구 */
export interface OpsAgentSpec {
  /** `config/llm.yml`의 키이자 재시도 로그의 이름 */
  agent: AgentName;
  /** 출력 스키마의 이름 — 요청에 강제로 실린다 */
  tool: string;
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
 * 산출이 나온 뒤의 실패는 실패가 아니고(이미 완성된 산출을 버리지 않는다), 산출 없이
 * 두 번 실패하면 도구가 반려로 답한다. 빈 산출도 반려다 — 아무것도 부르지 않은 채
 * "걸었습니다"가 돌아가면 감독은 걸리지 않은 지시 위에 다음 판단을 쌓는다.
 */
export async function runOpsOrders(
  spec: OpsAgentSpec,
  specs: ReadonlyMap<string, GameToolSpec>,
  user: string,
  llm?: GameLLM,
): Promise<{ ok: true; orders: OpsOrders } | { ok: false; message: string }> {
  let orders: OpsOrders | null = null;
  let client = llm;
  const tool: GameToolSpec = {
    ...opsToolDeclaration(spec, specs),
    handle: (input: unknown) => {
      const parsed = ReportSchema.safeParse(input);
      // 무엇이 틀렸는지 자리까지 돌려줘야 재시도가 같은 실수를 반복하지 않는다
      if (!parsed.success) return inputError(parsed.error);
      const { ops, truncated } = parseOps((input as { ops?: unknown }).ops, spec.ops, spec.caps);
      orders = {
        ops,
        ...(Object.keys(truncated).length > 0 ? { truncated } : {}),
        ...(parsed.data.unresolved ? { unresolved: parsed.data.unresolved } : {}),
      };
      return { ok: true, message: "지시를 받았습니다" };
    },
  };
  try {
    await retryOnce(
      spec.agent,
      () =>
        requireToolCall(spec.tool, () => {
          client ??= createGameLLM(agentConfig(spec.agent));
          return client.runTurn({
            system: spec.system,
            history: [],
            user,
            tools: [tool],
            toolChoice: { name: spec.tool },
          });
        }),
      () => orders !== null,
    );
  } catch (error) {
    if (orders === null && !(error instanceof ModelOutputError)) throw error;
    console.warn(`[${spec.agent}] 해석 호출이 실패했습니다:`, error);
  }
  if (orders === null) {
    return { ok: false, message: "지시를 옮기지 못했습니다 — 다시 말씀해 주세요" };
  }
  const got: OpsOrders = orders;
  if (!hasOps(got.ops) && !got.unresolved) return { ok: false, message: spec.emptyHint };
  return { ok: true, orders: got };
}
