import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_SKILL_DESCRIPTIONS,
  CORE_COMMANDS,
  FINANCE_OPS,
  MATCH_OPS,
  MATCH_TOOL_DEFINITIONS,
  TACTIC_CAPS,
  TACTIC_OPS,
  TRAINING_OPS,
  instructionCommands,
  applyOps,
  parseOps,
  FINALIZE_MATCH_RULES,
  REPORT_DIGEST_INPUT,
  REPORT_ONBOARDING_INPUT,
  SKILL_CATALOG,
  SKILL_NAMES,
  TRAINING_RATER_RULES,
  agingDeclineLine,
  buildGmTools,
  buildToolSpecs,
  outputAgents,
  toToolSchema,
  type OutputAgent,
} from "@story-fm/agents";
import {
  AGENT_NAMES,
  AnthropicGameLLM,
  GeminiGameLLM,
  OpenAiGameLLM,
  agentConfig,
  countOptionalProperties,
  providerTraits,
  type LlmProvider,
  type GameToolSpec,
} from "@story-fm/llm";
import {
  ATTRIBUTE_AXES,
  AXIS_KO,
  SET_PIECE_ROUTINE_AXES,
  SET_PIECE_ROUTINE_NEUTRAL,
  TACTIC_TOGGLES,
} from "@story-fm/domain";
import { AXIS_AGING, agingDelta, createGame } from "@story-fm/engine";

/** 세계는 한 번만 세운다 — 여기서는 아무도 상태를 고치지 않는다 (`createGame`은 판당 수 초) */
const STATE = (() => {
  const background = "전술 분석가";
  return createGame({
    seed: 17,
    userTeamId: "arsenal",
    managerName: "테스트",
    background,
  });
})();

const TOOLS = buildGmTools(STATE, []);
/** 코어 명령 전부 — 판을 세우는 것들은 GM에게 보이지 않고 해석이 부른다 (agents.md §1) */
const SKILL_TOOLS = buildToolSpecs(STATE, []);

describe("스킬 설명 — 코드가 유일한 원본이다", () => {
  /**
   * **양방향**이다 — 카탈로그에 없는 도구가 모델에게 가면 설명 없이 서고, 도구가
   * 되지 못한 카탈로그 항목은 아무 데도 닿지 않은 채 설명만 유지된다.
   */
  it("모델이 받는 도구 집합이 카탈로그와 같고, 설명도 그대로다", () => {
    const toolNames = TOOLS.map((t) => t.name).sort();
    expect(toolNames).toEqual([...SKILL_NAMES].sort());
    const described = new Map<string, string>(SKILL_CATALOG.map((s) => [s.name, s.description]));
    for (const tool of TOOLS) {
      expect(tool.description, tool.name).toBe(described.get(tool.name));
    }
  });

  it("빈 설명을 가진 스킬은 없다", () => {
    for (const name of SKILL_NAMES) {
      expect(DEFAULT_SKILL_DESCRIPTIONS[name].trim().length).toBeGreaterThan(0);
    }
  });
});

/**
 * 규칙이 사는 자리 — docs/common/llm/prompts.md §5.
 *
 * 한 도구의 사용법은 **그 도구의 설명에만** 있다. 프롬프트의 문구를 여기서 고정하면
 * 프롬프트를 고칠 수 없으므로(AGENTS.md §6-5) 재는 것은 문구가 아니라 **중복이
 * 생기지 않는다**는 것 하나다: 도구 이름이 시스템 프롬프트에 서면 같은 규칙이 두 곳에
 * 살아 한쪽만 고쳐지고, 경기 프롬프트에 서면 그 층에는 도구 표면이 아예 없어(§2) 부를
 * 수 없는 것을 부르라는 말이 된다.
 */
describe("규칙이 사는 자리", () => {
  /**
   * 설명은 고정층에 매 턴 실린다 — 길이 예산이 없으면 규칙 하나를 지울 때마다 설명
   * 두 줄이 붙어도 아무 데서도 드러나지 않는다. 상한은 지금 총량(≈5,300자)에 한 도구
   * 몫(600자)의 여유를 얹은 값이다 — **도구가 늘 때만** 그만큼 올린다. **도구가 줄면
   * 함께 내린다**: 상한이 총량의 두 배로 남으면 설명이 한 벌씩 더 붙어도 걸리지 않는다.
   */
  it("설명은 길이 예산 안에 있다", () => {
    const total = SKILL_CATALOG.reduce((sum, skill) => sum + skill.description.length, 0);
    for (const skill of SKILL_CATALOG) {
      expect(skill.description.length, skill.name).toBeLessThanOrEqual(600);
    }
    expect(total).toBeLessThanOrEqual(6_200);
  });

  it("GM은 직접 명령 대신 역할별 해석 스킬을 받는다", () => {
    for (const tool of [...TOOLS, ...MATCH_TOOL_DEFINITIONS]) {
      expect(CORE_COMMANDS.has(tool.name), tool.name).toBe(false);
    }
    expect(TOOLS.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["tactic_orders", "training_orders", "finance_orders"]),
    );
  });

  /**
   * 나이로 먼저 꺾이는 축과 그 나이는 코어의 노화 곡선이 갖는다 — 프롬프트가 손으로
   * 적으면 곡선을 조율해도 옛 나이를 계속 말하고, 두 결산이 서로 다른 나이를 믿는다.
   * 화면에 드러나지 않는 어긋남이라 여기서 잰다 (prompts.md §5).
   */
  it("결산 둘의 나이 문장은 코어의 노화 곡선에서 온다", () => {
    const early = ATTRIBUTE_AXES.filter((axis) => AXIS_AGING[axis] === "early");
    const line = agingDeclineLine();
    for (const axis of early) expect(line, axis).toContain(AXIS_KO[axis]);

    // 문장이 적은 나이가 곧 그 축들이 처음 꺾이는 해다 — 한 해 전까지는 꺾이지 않는다
    const age = Number(/^(\d+)세/.exec(line)?.[1]);
    expect(early.every((axis) => agingDelta(axis, age) < 0)).toBe(true);
    expect(early.every((axis) => agingDelta(axis, age - 1) < 0)).toBe(false);

    expect(FINALIZE_MATCH_RULES).toContain(line);
    expect(TRAINING_RATER_RULES).toContain(line);
  });
});

/**
 * 도구 입력의 계약 — docs/common/llm/prompts.md §2.
 *
 * 모델이 보는 JSON 스키마는 Zod 한 벌에서 나온다. 갈릴 자리가 없어야 같은 종류의
 * 인자가 어느 도구에서든 같은 검증을 지난다.
 */
describe("입력 스키마 — Zod 한 벌에서 파생한다", () => {
  it("객체 분기는 공통 필드와 각 분기의 필수 입력을 함께 전달한다", () => {
    const schema = z.discriminatedUnion("action", [
      z.object({ action: z.literal("dismiss"), team: z.string() }),
      z.object({ action: z.literal("appoint"), team: z.string(), name: z.string() }),
    ]);
    const derived = toToolSchema(schema);
    expect(derived.type).toBe("object");
    expect(derived.required).toEqual(["action", "team"]);
    expect(derived.properties?.name).toEqual({ type: "string" });
    expect(derived.anyOf).toEqual([
      expect.objectContaining({ required: ["action", "team"] }),
      expect.objectContaining({ required: ["action", "team", "name"] }),
    ]);
    expect(schema.safeParse({ action: "appoint", team: "arsenal" }).success).toBe(false);
    expect(schema.safeParse({ action: "dismiss", team: "arsenal" }).success).toBe(true);
  });

  it("문자·숫자·배열의 경계가 그대로 옮겨진다", () => {
    expect(
      toToolSchema(
        z.object({
          when: z
            .string()
            .min(2)
            .max(9)
            .regex(/^\d{4}-\d{2}$/),
          count: z.number().int().min(1).max(5),
          ratio: z.number().min(-3).max(3),
          ids: z.array(z.string().min(1)).min(1).max(4),
          eleven: z.array(z.string()).length(11),
          flag: z.boolean().optional(),
        }),
      ),
    ).toEqual({
      type: "object",
      properties: {
        when: { type: "string", minLength: 2, maxLength: 9, pattern: "^\\d{4}-\\d{2}$" },
        count: { type: "integer", minimum: 1, maximum: 5 },
        ratio: { type: "number", minimum: -3, maximum: 3 },
        ids: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 4 },
        eleven: { type: "array", items: { type: "string" }, minItems: 11, maxItems: 11 },
        flag: { type: "boolean" },
      },
      required: ["when", "count", "ratio", "ids", "eleven"],
    });
  });

  it("리터럴 합집합은 열거가 된다 — 1|2|3이 세 갈래 스키마로 보이지 않는다", () => {
    const derived = toToolSchema(
      z.object({ intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]) }),
    );
    expect(derived.properties?.intensity).toEqual({ type: "integer", enum: [1, 2, 3] });
  });

  it("설명은 바깥에 붙은 것이 이긴다", () => {
    const derived = toToolSchema(
      z.object({ note: z.string().describe("안쪽").optional().describe("바깥") }),
    );
    expect(derived.properties?.note).toEqual({ type: "string", description: "바깥" });
  });

  it("옮길 수 없는 갈래는 조용히 통과하지 않고 던진다", () => {
    expect(() => toToolSchema(z.object({ when: z.date() }))).toThrow();
  });

  /** `.partial()`은 모든 자리를 optional로 감싼다 — 필수가 하나도 남지 않는다 */
  it("partial은 required를 남기지 않는다", () => {
    const derived = toToolSchema(z.object({ a: z.string(), b: z.number() }).partial());
    expect(derived.required).toBeUndefined();
    expect(derived.properties?.a).toEqual({ type: "string" });
  });

  /**
   * `null`과 기본값은 Zod 쪽의 관용이라 모델이 볼 것은 안쪽 갈래 하나다 —
   * `type: ["string","null"]`을 내면 제공자마다 받는 부분집합이 갈린다.
   * 대신 **빼도 된다는 것**은 `required`가 말한다.
   */
  it("nullish와 기본값은 안쪽 갈래만 보이고 required에서 빠진다", () => {
    const derived = toToolSchema(
      z.object({
        axis: z.enum(["pace", "vision"]).nullish(),
        weight: z.number().int().min(1).max(5).default(3),
        kept: z.string(),
      }),
    );
    expect(derived.properties?.axis).toEqual({ type: "string", enum: ["pace", "vision"] });
    expect(derived.properties?.weight).toEqual({ type: "integer", minimum: 1, maximum: 5 });
    expect(derived.required).toEqual(["kept"]);
  });

  /**
   * **갈래의 중립은 모델이 낼 수 있는 값이어야 한다** (match.md §1.2 · prompts.md §2).
   *
   * 위 규칙 때문에 `.nullable()`은 안쪽 갈래만 모델에게 보인다 — 그래서 중립이 `null`인
   * 갈래는 열거에서 중립이 통째로 지워지고, 제공자가 열거를 강제하므로 감독의 "그만해"에
   * **반대쪽 값이 걸린다.** 걸린 갈래를 푸는 길이 이 토큰 하나뿐이라 여기서 고정한다.
   */
  it("갈래 넷의 중립 토큰이 모델이 보는 열거 안에 있다", () => {
    /** 모델이 그 자리에서 고를 수 있는 값 — 열거면 그 목록, 불린이면 참·거짓 둘 */
    const choices = (node: unknown): string[] => {
      const n = node as { enum?: unknown[]; type?: unknown };
      if (Array.isArray(n.enum)) return n.enum.map(String);
      return n.type === "boolean" ? ["true", "false"] : [];
    };
    const setTactics = SKILL_TOOLS.find((t) => t.name === "set_tactics")!.inputSchema.properties;
    for (const toggle of TACTIC_TOGGLES) {
      expect(choices(setTactics?.[toggle.key]), `set_tactics.${toggle.key}`).toContain(
        toggle.neutralValue,
      );
    }
  });

  /**
   * **세트피스 두 축도 같은 자리다** (match.md §1.4). 도구 설명과 해석 프롬프트가
   * 「지시를 푸는 값」으로 가르치는 토큰이 열거에 없으면, 감독의 "이제 그만 올려"에
   * 모델은 반대쪽 값을 건다 — 갈래 넷과 같은 실패고, 화면에는 드러나지 않는다.
   */
  it("세트피스 두 축의 중립 토큰이 모델이 보는 열거 안에 있다", () => {
    const enumOf = (node: unknown): string[] => {
      const n = node as { enum?: unknown[] };
      return Array.isArray(n.enum) ? n.enum.map(String) : [];
    };
    const routine = SKILL_TOOLS.find((t) => t.name === "set_set_piece_routine")!;
    for (const axis of SET_PIECE_ROUTINE_AXES) {
      expect(enumOf(routine.inputSchema.properties?.[axis.key]), axis.key).toContain(
        SET_PIECE_ROUTINE_NEUTRAL,
      );
    }
  });

  it("직접 지시의 명령은 코어 스키마를 공유하고 명령별 상한을 보존한다", () => {
    const specs = new Map(SKILL_TOOLS.map((tool) => [tool.name, tool] as const));
    const before = JSON.stringify(SKILL_TOOLS.map((tool) => tool.inputSchema));
    const names = [...TACTIC_OPS, ...TRAINING_OPS, ...FINANCE_OPS];
    const commands = instructionCommands(specs, names);
    expect(commands.map((command) => command.name)).toEqual(names);
    // 해제 목록의 명시성처럼 별도 구조가 필요한 명령을 제외한 스키마는 코어의 것을 그대로 쓴다.
    for (const name of ["substitute", "set_tactics", "set_training", "set_ticket_price"]) {
      const spec = specs.get(name)!;
      expect(commands.find((command) => command.name === name)?.inputSchema, name).toBe(
        spec.instructionSchema ?? spec.inputSchema,
      );
    }
    expect(JSON.stringify(SKILL_TOOLS.map((tool) => tool.inputSchema))).toBe(before);
    expect(commands.find((command) => command.name === "substitute")?.limit).toBe(
      TACTIC_CAPS.substitute,
    );
    const over = Array.from({ length: TACTIC_CAPS.substitute! + 2 }, () => ({}));
    const parsed = parseOps({ substitute: over }, TACTIC_OPS, TACTIC_CAPS);
    expect(parsed.ops.substitute).toHaveLength(TACTIC_CAPS.substitute!);
    expect(parsed.truncated.substitute).toBe(2);
  });

  /**
   * **받아쓰기는 동기 명령만 지난다** (`applyOps`). 해석기의 JSON은 한 번에 여럿을
   * 부르므로 프로미스를 돌려주는 손잡이(`tactic_orders`·`finance_orders`…)가 목록에 들면
   * 적용이 그 자리에서 터진다 — 이름 한 줄로 벌어지는 일이라 여기서 막는다.
   */
  it("ops 목록의 명령은 전부 동기다 — 손잡이는 목록에 들지 않는다", () => {
    const specs = new Map(SKILL_TOOLS.map((t) => [t.name, t] as const));
    for (const name of [...TACTIC_OPS, ...TRAINING_OPS, ...FINANCE_OPS]) {
      expect(specs.get(name)!.handle.constructor.name, name).not.toBe("AsyncFunction");
    }
  });

  /**
   * **부를 길이 없는 코어 명령은 없다.** GM에게 보이지 않는 명령(`CORE_COMMANDS`)은
   * 해석기의 목록에 정확히 한 번 서야 한다 — 빠지면 아무도 못 부르고, 둘에 서면 같은
   * 명령이 두 해석기에서 다른 문맥으로 채워진다.
   */
  it("코어 명령은 어느 해석기 목록에 정확히 한 번 선다", () => {
    const lists = [...TACTIC_OPS, ...TRAINING_OPS, ...FINANCE_OPS];
    for (const name of CORE_COMMANDS) {
      expect(
        lists.filter((n) => n === name),
        name,
      ).toHaveLength(1);
    }
    /**
     * 판독기도 판 해석의 부분집합이다 — 적용은 `TACTIC_OPS`의 순서를 지나므로
     * (`applyTacticOrders`), 그 목록에 없는 이름은 판독기가 채워도 조용히 버려진다.
     */
    for (const name of MATCH_OPS.filter((name) => CORE_COMMANDS.has(name))) {
      expect(TACTIC_OPS.includes(name), name).toBe(true);
    }
    // 거꾸로, 목록에 있는데 코어 명령도 카탈로그 스킬도 아닌 이름은 없다
    const known = new Set([...CORE_COMMANDS, ...SKILL_CATALOG.map((s) => s.name)]);
    for (const name of lists) expect(known.has(name), name).toBe(true);
  });

  /** 중첩된 객체·배열도 같은 규칙을 지난다 — 안쪽에서 제약이 사라지면 아무도 못 본다 */
  it("중첩된 객체와 배열 항목도 끝까지 옮겨진다", () => {
    const derived = toToolSchema(
      z.object({
        style: z.object({
          note: z.string().max(20),
          samples: z.array(z.object({ text: z.string().min(1), tone: z.enum(["dry", "warm"]) })),
        }),
      }),
    );
    expect(derived.properties?.style).toEqual({
      type: "object",
      properties: {
        note: { type: "string", maxLength: 20 },
        samples: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string", minLength: 1 },
              tone: { type: "string", enum: ["dry", "warm"] },
            },
            required: ["text", "tone"],
          },
        },
      },
      required: ["note", "samples"],
    });
  });
});

/** JSON 스키마를 훑으며 (이름, 노드) 쌍을 모은다 — 중첩된 배열 항목까지 */
function walk(node: unknown, name = ""): Array<[string, Record<string, unknown>]> {
  if (typeof node !== "object" || node === null) return [];
  const self = node as Record<string, unknown>;
  const found: Array<[string, Record<string, unknown>]> = name === "" ? [] : [[name, self]];
  for (const [key, value] of Object.entries((self.properties ?? {}) as Record<string, unknown>)) {
    found.push(...walk(value, key));
  }
  // 배열 항목은 이름을 물려받지 않는다 — `targetIds[]`는 문자열이지 목록이 아니다
  if (self.items !== undefined) found.push(...walk(self.items, `${name}[]`));
  return found;
}

/**
 * 출력 스키마 둘은 GM 도구가 아니라 저마다의 호출이 요청에 싣는 산출의 꼴이다 — 카탈로그에도
 * `buildGmTools`에도 서지 않고 이름은 에이전트의 것이다. 그래도 모델이 받는 입력이라 계약은 같다.
 */
const OUTPUT_SCHEMAS = [
  { name: "onboarding-judge", inputSchema: REPORT_ONBOARDING_INPUT },
  { name: "history-compactor", inputSchema: REPORT_DIGEST_INPUT },
];

describe("같은 종류의 인자는 같은 검증을 지난다", () => {
  const args = [...TOOLS, ...OUTPUT_SCHEMAS].flatMap((tool) =>
    walk(tool.inputSchema).map(([name, node]) => ({ tool: tool.name, name, node })),
  );
  const only = (names: readonly string[]) => args.filter((a) => names.includes(a.name));
  const where = (a: { tool: string; name: string }) => `${a.tool}.${a.name}`;

  /** 장부·피드에 영구히 남는 자유 문구 — 상한이 없으면 감독 발화가 통째로 실린다 */
  it("자유 문구에는 길이 상한이 있다", () => {
    const notes = only(["note", "label"]);
    expect(notes.length).toBeGreaterThan(0);
    for (const a of notes) expect(a.node.maxLength, where(a)).toBeTypeOf("number");
  });

  it("금액은 정수이고 상한을 갖는다", () => {
    const money = only(["fee", "weeklyWage", "amount", "delta"]);
    expect(money.length).toBeGreaterThan(0);
    for (const a of money) {
      expect(a.node.type, where(a)).toBe("integer");
      expect(a.node.maximum, where(a)).toBeTypeOf("number");
    }
  });

  it("날짜는 형식을 갖는다", () => {
    const dates = only(["date", "from", "to", "month"]);
    expect(dates.length).toBeGreaterThan(0);
    for (const a of dates) expect(a.node.pattern, where(a)).toBeTypeOf("string");
  });

  it("필수 인자는 전부 선언된 인자다", () => {
    for (const tool of [...TOOLS, ...OUTPUT_SCHEMAS]) {
      for (const [, node] of [["", tool.inputSchema] as const, ...walk(tool.inputSchema)]) {
        const declared = Object.keys((node.properties ?? {}) as Record<string, unknown>);
        for (const key of (node.required ?? []) as string[]) {
          expect(declared, `${tool.name}.${key}`).toContain(key);
        }
      }
    }
  });
});

/**
 * **출력 스키마로 나가는 산출 선언** — docs/common/llm/models.md §3-2.
 *
 * 제공자가 받는 스키마 부분집합은 셋이 다르다 — Anthropic은 수치·길이·배열 크기 제약을
 * 400으로 거절하고 모든 객체에 `additionalProperties: false`를 요구한다. 스위트의 LLM은
 * 전부 목이라 스키마가 제공자의 문을 지나는지 묻는 자리는 여기뿐이다.
 *
 * **자는 어댑터를 지난 뒤의 선언이다.** 제공자의 부분집합을 흡수하는 자리가 어댑터라
 * (AGENTS.md §6-1) 산출을 세우는 쪽은 제공자를 몰라도 된다 — 소스의 Zod는 `.max()`를
 * 들고 있어 **소스 선언에는 `maxLength`·`maxItems`가 서 있다.** 소스에 자를 대면 합법인
 * 것을 금지하면서 정작 나가는 것은 못 본다.
 *
 * **열 선언 × 어댑터 셋을 전부 잰다.** `config/llm.yml`의 한 줄이 어느 자리든 다른
 * 제공자로 옮길 수 있으므로, 지금 어디로 나가는가가 아니라 어디로 나가도 지나는가를 본다.
 */
describe("출력 스키마는 제공자의 문을 지난다", () => {
  const DECLARED = outputAgents();

  /**
   * 제공자가 **구조화 출력에서 받지 못하는 스키마 열쇠** — 한 줄이 한 제공자다.
   *
   * 비어 있다는 것은 "좁아지는 열쇠를 아직 만나지 않았다"이지 "무엇이든 받는다"가 아니다.
   * 제공자가 하나 늘면 이 표가 컴파일에서 먼저 걸린다.
   */
  const FORBIDDEN: Record<LlmProvider, readonly string[]> = {
    // 수치·길이·배열 크기 제약은 400이다 — 어댑터가 걷는다 (models.md §3-2)
    anthropic: [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
      "minLength",
      "maxLength",
      "maxItems",
    ],
    // 구조화 출력에서도 스키마를 문법으로 펼쳐 `maxItems: n`이 항목 스키마 n벌이 된다 —
    // 2026-09 실측: 이 열쇠 하나만 걷으면 열 선언이 전부 지난다 (models.md §3-2)
    google: ["maxItems"],
    // `strict: false`로 나간다 — 무엇도 거절하지 않는다
    openai: [],
  };

  /**
   * 열은 전부 도구 없이 답한다 — GM 둘을 뺀 에이전트 이름과 목록이 하나씩 맞는다.
   * 에이전트가 하나 늘면 설정(`AGENT_NAMES`)과 이 목록 중 하나가 먼저 빨개진다.
   */
  it("출력 스키마를 사용하는 에이전트가 선언된다", () => {
    const GMS = new Set(["gm", "match-gm"]);
    const expected = AGENT_NAMES.filter((name) => !GMS.has(name));
    expect(DECLARED.map((entry) => entry.agent).sort()).toEqual([...expected].sort());
    for (const entry of DECLARED) expect(entry.schema.type, entry.agent).toBe("object");
  });

  /**
   * **크기의 문은 어댑터가 넘어 줄 수 없다** — 선택 속성이 한도를 넘는 선언은 걷어서 지날
   * 수 없고, 그 선언을 그 제공자로 보내는 설정은 실호출로 400을 맞기 전에 여기서 빨개진다
   * (models.md §3-2). 해석기 넷이 Anthropic으로 옮겨지는 날의 자다.
   */
  it("설정이 보내는 제공자의 선택 속성 한도 안에 선언이 든다", () => {
    for (const entry of DECLARED) {
      const { provider } = agentConfig(entry.agent);
      const limit = providerTraits(provider).outputOptionalLimit;
      if (limit === null) continue;
      expect(
        countOptionalProperties(entry.schema),
        `${entry.agent} → ${provider}: 선택 속성 한도 ${limit}`,
      ).toBeLessThanOrEqual(limit);
    }
  });

  /** 한도가 재는 것이 정확히 「required에 없는 properties」다 — 세는 자가 어긋나면 위 자도 어긋난다 */
  it("선택 속성은 required에 없는 properties를 스키마 전체에서 센다", () => {
    expect(
      countOptionalProperties({
        type: "object",
        properties: {
          a: { type: "string" },
          b: {
            type: "array",
            items: { type: "object", properties: { c: {}, d: {} }, required: ["c"] },
          },
        },
        required: ["a"],
      }),
    ).toBe(2);
  });

  /** 어댑터의 설정 — 제공자만 갈아 끼운다. 모델 문자열은 스텁이 읽지 않는다 */
  function baseOf(agent: OutputAgent["agent"]) {
    const { agent: name, model, maxTokens, timeoutMs, maxRetries } = agentConfig(agent);
    // 오퍼레이터 채널은 이 자리와 무관하다 — 스냅샷이 없는 호출이다
    return { agent: name, model, maxTokens, timeoutMs, maxRetries, operatorChannel: false };
  }

  const request = (entry: OutputAgent) => ({
    system: entry.system,
    history: [],
    user: "감독의 말",
    outputSchema: entry.schema,
  });

  /** Anthropic — `messages.stream`에 넘어간 `output_config.format.schema` */
  async function anthropicSchemas(entry: OutputAgent): Promise<unknown[]> {
    const sent: unknown[] = [];
    const client = {
      messages: {
        stream: (params: { output_config?: { format?: { schema?: unknown } } }) => {
          sent.push(params.output_config?.format?.schema);
          return {
            on() {
              return this;
            },
            finalMessage: () =>
              Promise.resolve({
                stop_reason: "end_turn",
                content: [{ type: "text", text: "{}" }],
                usage: {
                  input_tokens: 1,
                  output_tokens: 1,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                },
              }),
          };
        },
      },
    };
    await new AnthropicGameLLM(
      { ...baseOf(entry.agent), provider: "anthropic" },
      client as never,
    ).runTurn(request(entry));
    return sent;
  }

  /** 어댑터가 읽는 자리만 세운 Gemini 응답 — `@google/genai`는 여기서 부르지 않는다 */
  function geminiReply(parts: unknown[]): unknown {
    return {
      candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
      usageMetadata: {},
    };
  }

  /** Google — `chats.create`의 config에 넘어간 `responseJsonSchema` */
  async function geminiSchemas(entry: OutputAgent): Promise<unknown[]> {
    const sent: unknown[] = [];
    const history: unknown[] = [];
    const chat = {
      sendMessage: () => {
        history.push(
          { role: "user", parts: [{ text: "감독의 말" }] },
          { role: "model", parts: [{ text: "{}" }] },
        );
        return Promise.resolve(geminiReply([{ text: "{}" }]));
      },
      sendMessageStream: () => Promise.reject(new Error("이 자리는 스트리밍하지 않는다")),
      getHistory: () => history,
    };
    const client = {
      chats: {
        create: (params: { config?: { responseJsonSchema?: unknown } }) => {
          sent.push(params.config?.responseJsonSchema);
          return chat;
        },
      },
    };
    await new GeminiGameLLM(
      { ...baseOf(entry.agent), provider: "google", thinkingLevel: "minimal" },
      client as never,
    ).runTurn(request(entry));
    return sent;
  }

  /** OpenAI — `responses.create`에 넘어간 `text.format.schema` */
  async function openaiSchemas(entry: OutputAgent): Promise<unknown[]> {
    const sent: unknown[] = [];
    const client = {
      responses: {
        create: (body: { text?: { format?: { schema?: unknown } } }) => {
          sent.push(body.text?.format?.schema);
          return Promise.resolve({
            id: "resp",
            object: "response",
            status: "completed",
            error: null,
            incomplete_details: null,
            output: [
              {
                id: "msg",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "{}", annotations: [] }],
              },
            ],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              total_tokens: 2,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          });
        },
      },
    };
    await new OpenAiGameLLM(
      { ...baseOf(entry.agent), provider: "openai" },
      client as never,
    ).runTurn(request(entry));
    return sent;
  }

  /** 선언을 꺼내는 자 — **제공자마다 그 어댑터의 stub이다.** 제공자가 늘면 여기가 컴파일에서 걸린다 */
  const PROBES: Record<LlmProvider, (entry: OutputAgent) => Promise<unknown[]>> = {
    anthropic: anthropicSchemas,
    google: geminiSchemas,
    openai: openaiSchemas,
  };

  /** 뿌리까지 포함한 (자리, 노드) 쌍 — `walk`는 뿌리를 세우지 않는다 */
  function nodesOf(schema: unknown): Array<[string, Record<string, unknown>]> {
    return [["(뿌리)", schema as Record<string, unknown>], ...walk(schema)];
  }

  it.each(Object.keys(PROBES) as LlmProvider[])(
    "%s 어댑터를 지나 나가는 선언에 그 제공자가 못 받는 열쇠가 없다",
    async (provider) => {
      const offenders: string[] = [];
      for (const entry of DECLARED) {
        const schemas = (await PROBES[provider](entry)).filter((schema) => schema !== undefined);
        // 꺼낸 것이 없으면 아무것도 재지 않은 채 초록이 된다
        expect(schemas.length, `${provider}: ${entry.agent}`).toBeGreaterThan(0);
        for (const schema of schemas) {
          for (const [where, node] of nodesOf(schema)) {
            for (const key of FORBIDDEN[provider]) {
              if (key in node) offenders.push(`${entry.agent}.${where}: ${key}`);
            }
          }
        }
      }
      expect([...new Set(offenders)]).toEqual([]);
    },
  );

  /**
   * Anthropic만의 요구 둘 — 모든 객체에 `additionalProperties: false`, `minItems`는 0과 1만
   * (models.md §3-2). 걷기만으로는 안 되는 자리라 따로 잰다.
   */
  it("anthropic 어댑터는 모든 객체를 닫고 minItems를 1 아래로 둔다", async () => {
    for (const entry of DECLARED) {
      for (const schema of await anthropicSchemas(entry)) {
        for (const [where, node] of nodesOf(schema)) {
          const at = `${entry.agent}.${where}`;
          if (node.type === "object") expect(node.additionalProperties, at).toBe(false);
          if (node.minItems !== undefined) expect(Number(node.minItems), at).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  /** 어댑터는 부르는 쪽의 스키마를 고치지 않는다 — 소스의 Zod가 지키는 상한이 여기서 사라지면 안 된다 */
  it("어댑터가 걷어도 소스 선언은 그대로다", async () => {
    for (const entry of DECLARED) {
      const before = JSON.stringify(entry.schema);
      for (const probe of Object.values(PROBES)) await probe(entry);
      expect(JSON.stringify(entry.schema), entry.agent).toBe(before);
    }
  });

  /**
   * **목록에 서지 않은 출력 스키마 요청은 위의 자가 재지 못한다.** 그래서 소스를 읽어 짝을
   * 못 박는다(선례: `packages/engine/test/app/harness-catalog.test.ts`). 양방향이다 — 소스에만
   * 있는 자리는 아무도 재지 않은 채 실호출로 나가고, 목록에만 있는 선언은 나가지 않는 것을
   * 재게 한다. 이름이 없으므로 짝은 **에이전트 이름**이다 — `agentConfig("…")`가 그 자리다.
   */
  const SRC = join(import.meta.dirname, "..", "..", "src");
  it("출력 스키마를 요청하는 자리마다 그 에이전트가 목록에 있고, 목록의 에이전트는 전부 요청한다", () => {
    const listed = new Set<string>(DECLARED.map((entry) => entry.agent));
    const seen = new Set<string>();
    const unread: string[] = [];
    for (const file of readdirSync(SRC, { recursive: true, encoding: "utf8" })) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(join(SRC, file), "utf8");
      if (!source.includes("outputSchema:")) continue;
      const names = [...source.matchAll(/agentConfig\("([a-z-]+)"\)/g)].map((m) => m[1]!);
      // 주입받은 클라이언트를 쓰는 판독 파이프라인은 출력 검증의 호출 이름을 따른다.
      if (names.length === 0) {
        names.push(...[...source.matchAll(/readOutput\("([a-z-]+)"/g)].map((match) => match[1]!));
      }
      // 못 읽은 자리는 목록에 있는지조차 말할 수 없다 — 재지 못한 자리다
      if (names.length === 0) unread.push(basename(file));
      for (const name of names) seen.add(name);
    }
    expect(unread).toEqual([]);
    expect([...seen].filter((name) => !listed.has(name)).sort()).toEqual([]);
    expect([...listed].filter((name) => !seen.has(name)).sort()).toEqual([]);
  });
});

describe("명령 결과 집계", () => {
  it("반려된 명령만 있으면 성공으로 세지 않고 부분 적용을 구분한다", () => {
    const notes: string[] = [];
    const spec: GameToolSpec = {
      name: "edit",
      description: "",
      inputSchema: { type: "object", properties: {} },
      handle: (input) => ({ ok: input === "valid", message: String(input) }),
    };
    const specs = new Map([[spec.name, spec]]);
    expect(applyOps(specs, { ops: { edit: ["invalid"] } }, ["edit"], notes)).toEqual({
      applied: 0,
      rejected: 1,
    });
    expect(applyOps(specs, { ops: { edit: ["valid", "invalid"] } }, ["edit"], notes)).toEqual({
      applied: 1,
      rejected: 1,
    });
  });
});

describe("GM financial decisions and staff agreements", () => {
  it("exposes executable structured board adjudication and negotiated staff hiring directly", async () => {
    const state = structuredClone(STATE);
    const tools = buildGmTools(state, []);
    const board = tools.find((tool) => tool.name === "request_board")!;
    const staff = tools.find((tool) => tool.name === "hire_staff")!;
    const finance = state.finances.find((row) => row.teamId === state.userTeamId)!;
    finance.balance = 200_000_000;
    const before = finance.balance;
    await board.handle({
      kind: "stadium",
      amount: 1000,
      deliversOn: `${Number(state.date.slice(0, 4)) + 1}-03-17`,
      decision: "approved",
      authorizedBy: state.personas.find((p) => p.role === "owner")!.characterId,
    });
    expect(finance.balance).toBe(before - 1000 * 8000);
    const name = "합의한 새 코치";
    await staff.handle({
      name,
      role: "coach",
      title: "기술 코치",
      salary: 1000,
      until: `${Number(state.date.slice(0, 4)) + 1}-03-17`,
      lorebook: {
        name,
        keywords: [name],
        description: "기술 코치",
        information: "감독과 계약 조건을 합의했다.",
      },
    });
    expect(state.personas.find((p) => p.name === name)?.employment?.contract.salary).toBe(1000);
  });
});
