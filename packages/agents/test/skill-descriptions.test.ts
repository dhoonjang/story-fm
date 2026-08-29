import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as agents from "@story-fm/agents";
import {
  DEFAULT_SKILL_DESCRIPTIONS,
  GM_SYSTEM,
  CORE_COMMANDS,
  MARKET_OPS,
  TACTIC_CAPS,
  TACTIC_OPS,
  TRAINING_OPS,
  buildOpsSchema,
  parseOps,
  TACTIC_ORDERS_SYSTEM,
  REPORT_DIGEST_INPUT,
  REPORT_DIGEST_TOOL,
  REPORT_TRAINING_INPUT,
  REPORT_ONBOARDING_INPUT,
  REPORT_ONBOARDING_TOOL,
  REPORT_TRAINING_TOOL,
  SETTLE_MATCH_DESCRIPTION,
  SETTLE_MATCH_INPUT,
  SETTLE_MATCH_TOOL,
  SKILL_CATALOG,
  SKILL_NAMES,
  TRAINING_RATER_SYSTEM,
  agingDeclineLine,
  buildGmTools,
  buildToolSpecs,
  forcedTools,
  toToolSchema,
  type ForcedTool,
} from "@story-fm/agents";
import { GeminiGameLLM, agentConfig, type GameToolSpec, type LlmProvider } from "@story-fm/llm";
import {
  ATTRIBUTE_AXES,
  AXIS_KO,
  INCIDENT_KIND_KO,
  INCIDENT_KINDS,
  SET_PIECE_ROUTINE_AXES,
  SET_PIECE_ROUTINE_NEUTRAL,
  TACTIC_TOGGLES,
} from "@story-fm/domain";
import { AXIS_AGING, agingDelta, createGame, interpretBackgroundHeuristic } from "@story-fm/engine";

/** 세계는 한 번만 세운다 — 여기서는 아무도 상태를 고치지 않는다 (`createGame`은 판당 수 초) */
const STATE = (() => {
  const background = "전술 분석가";
  return createGame({
    seed: 17,
    userTeamId: "arsenal",
    managerName: "테스트",
    background,
    attributes: interpretBackgroundHeuristic(background),
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

  /**
   * **문서가 세는 수는 코드가 늘 때 조용히 어긋난다** — docs/llm/prompts.md §2의 표는
   * 도구를 그룹째 열거하고 수를 함께 적는다. 도구 하나가 붙어도 화면도 프롬프트도
   * 아무 말을 하지 않으므로, 어긋남이 드러나는 자리는 여기뿐이다. **수를 고칠 때는
   * 그 표도 함께 고친다.**
   */
  it("도구 수·그룹별 수·읽기 전용 수가 문서의 표와 같다", () => {
    const perGroup: Record<string, number> = {};
    for (const skill of SKILL_CATALOG) perGroup[skill.group] = (perGroup[skill.group] ?? 0) + 1;
    expect(perGroup).toEqual({
      진행: 2,
      "전술·훈련": 2,
      "대화·서사": 5,
      이적: 4,
      재정: 1,
      조회: 11,
    });
    expect(SKILL_CATALOG.length).toBe(25);
    expect(SKILL_CATALOG.filter((s) => s.readOnly).length).toBe(11);
  });
});

/**
 * 규칙이 사는 자리 — docs/llm/prompts.md §5.
 *
 * 한 도구의 사용법은 **그 도구의 설명에만** 있다. 프롬프트의 문구를 여기서 고정하면
 * 프롬프트를 고칠 수 없으므로(AGENTS.md §6-5) 재는 것은 문구가 아니라 **중복이
 * 생기지 않는다**는 것 하나다: 도구 이름이 시스템 프롬프트에 서면 같은 규칙이 두 곳에
 * 살아 한쪽만 고쳐지고, 경기 프롬프트에 서면 그 층에는 도구 표면이 아예 없어(§2) 부를
 * 수 없는 것을 부르라는 말이 된다.
 */
describe("규칙이 사는 자리", () => {
  /** `substitutions`가 `substitute`로 잡히지 않게 — 이름 전체가 서야 중복이다 */
  const mentions = (prompt: string, name: string) => new RegExp(`\\b${name}\\b`).test(prompt);

  it("어느 프롬프트 층도 부를 수 없는 도구의 이름을 적지 않는다", () => {
    /**
     * GM의 프롬프트에는 도구 이름이 한 번도 서지 않는다 — 언제 부르고 인자를 어떻게
     * 채우는지는 그 도구의 `description`이 갖는다 (prompts.md §5).
     *
     * 해석기는 다르다: **자기가 채울 명령의 이름은 적어야 한다**(`ops`의 열쇠다).
     * 그래서 여기서 막는 것은 «그 해석기가 부를 수 없는 이름»뿐이다 — 적혀 있으면
     * 모델은 낼 수 없는 자리를 배운다.
     */
    for (const name of SKILL_NAMES) {
      expect(mentions(GM_SYSTEM, name), `GM_SYSTEM: ${name}`).toBe(false);
      if (TACTIC_OPS.includes(name)) continue;
      expect(mentions(TACTIC_ORDERS_SYSTEM, name), `TACTIC_ORDERS_SYSTEM: ${name}`).toBe(false);
    }
  });

  /**
   * 설명은 고정층에 매 턴 실린다 — 길이 예산이 없으면 규칙 하나를 지울 때마다 설명
   * 두 줄이 붙어도 아무 데서도 드러나지 않는다. 상한은 지금 총량(≈6,770자)에 한 도구
   * 몫(600자)의 여유를 얹은 값이다 — **도구가 늘 때만** 그만큼 올린다. **도구가 줄면
   * 함께 내린다**: 상한이 총량의 두 배로 남으면 설명이 한 벌씩 더 붙어도 걸리지 않는다.
   */
  it("설명은 길이 예산 안에 있다", () => {
    const total = SKILL_CATALOG.reduce((sum, skill) => sum + skill.description.length, 0);
    for (const skill of SKILL_CATALOG) {
      expect(skill.description.length, skill.name).toBeLessThanOrEqual(600);
    }
    expect(total).toBeLessThanOrEqual(7_400);
  });

  /**
   * **설명이 이름으로 부르는 인자는 스키마에 있어야 한다.** 인자가 빠지거나 이름이
   * 바뀌어도 설명은 그대로 남고, 모델은 없는 자리를 채우다 반려당한다 — 화면에는
   * 도구가 답하지 않은 것으로만 보인다. 한 도구가 다른 도구의 인자를 부르는 자리가
   * 있어(`set_squad_level` → `set_lineup`의 `squadLevels`) 대조는 도구 집합 전체로 한다.
   */
  it("설명이 이름으로 부르는 인자가 스키마에 있다", () => {
    /**
     * 낙타등 낱말만 인자로 읽는다 — 스탠스·갈래 토큰은 한 낱말이라 열거값과 갈리지
     * 않고, `xG` 같은 약어는 대문자 뒤에 소문자가 붙지 않는다.
     */
    const ARG = /\b[a-z]+[A-Z][a-z][A-Za-z]*\b/g;
    const names = (node: unknown, into: Set<string>): Set<string> => {
      if (node === null || typeof node !== "object") return into;
      const n = node as { properties?: Record<string, unknown>; items?: unknown };
      for (const [key, child] of Object.entries(n.properties ?? {})) {
        into.add(key);
        names(child, into);
      }
      return names(n.items, into);
    };
    const known = TOOLS.reduce((set, tool) => names(tool.inputSchema, set), new Set<string>());
    for (const tool of TOOLS) {
      for (const word of tool.description.match(ARG) ?? []) {
        expect(known.has(word), `${tool.name}: ${word}`).toBe(true);
      }
    }
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

    expect(SETTLE_MATCH_DESCRIPTION).toContain(line);
    expect(TRAINING_RATER_SYSTEM).toContain(line);
  });

  /**
   * 사건의 갈래는 효과의 모양이고 그 낱말표는 코어의 것이다 (people.md §6). 설명이
   * 손으로 적으면 갈래가 늘어도 모델은 옛 표를 믿고, 표에 없는 갈래는 부를 길이 없다 —
   * 세트피스 낱말표와 같은 결이다.
   */
  it("사건 기록의 설명은 코어 갈래표의 낱말을 전부 싣는다", () => {
    const incident = TOOLS.find((t) => t.name === "record_incident")!;
    const kinds = (incident.inputSchema.properties?.kind as { enum?: string[] }).enum ?? [];
    expect([...kinds].sort()).toEqual([...INCIDENT_KINDS].sort());
    for (const kind of INCIDENT_KINDS) {
      expect(incident.description, kind).toContain(kind);
      expect(incident.description, kind).toContain(INCIDENT_KIND_KO[kind]);
    }
  });
});

/**
 * 도구 입력의 계약 — docs/llm/prompts.md §2.
 *
 * 모델이 보는 JSON 스키마는 Zod 한 벌에서 나온다. 갈릴 자리가 없어야 같은 종류의
 * 인자가 어느 도구에서든 같은 검증을 지난다.
 */
describe("입력 스키마 — Zod 한 벌에서 파생한다", () => {
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
    // 낱말을 가르치는 것은 해석 프롬프트 하나다 — 손으로 적으면 낱말표를 고쳐도 남는다
    expect(TACTIC_ORDERS_SYSTEM).toContain(SET_PIECE_ROUTINE_NEUTRAL);
  });

  /**
   * **인자 스키마는 한 벌이다** (agents.md §1). 해석기가 모델에게 보이는 `ops`의 항목은
   * 그 명령의 도구 정의 그대로다 — 손으로 한 벌 더 적던 시절에 공략 상한이 2와 4로
   * 갈려 감독이 부른 지점이 말없이 잘렸다.
   */
  it("해석기의 ops 항목은 그 명령의 입력 스키마 그대로다", () => {
    const specs = new Map(SKILL_TOOLS.map((t) => [t.name, t] as const));
    for (const [label, list, caps] of [
      ["tactic", TACTIC_OPS, TACTIC_CAPS],
      ["training", TRAINING_OPS, {}],
      ["market", MARKET_OPS, {}],
    ] as const) {
      const ops = buildOpsSchema(specs, list, "인자", caps).properties as Record<
        string,
        { items?: unknown; maxItems?: number; description?: string }
      >;
      for (const name of list) {
        // 이름이 어긋나면 그 자리가 스키마에서 조용히 사라져 모델이 부를 길을 잃는다
        expect(specs.has(name), `${label}: ${name}`).toBe(true);
        expect(ops[name]?.items, `${label}: ${name}`).toBe(specs.get(name)!.inputSchema);
        /**
         * ⚠️ **상한은 `maxItems`로 가지 않는다** (models.md §3-2). 해석기는 강제 도구로
         * 부르는데 Gemini는 그 모드에서 `maxItems: n`을 항목 스키마 n벌로 펼쳐 디코딩
         * 문법을 만들고, 명령 열셋이면 그 문법이 한도를 넘어 요청이 통째로 400이 된다.
         */
        expect(ops[name]?.maxItems, `${label}: ${name}`).toBeUndefined();
      }
    }
    // 상한은 한 벌(`TACTIC_CAPS`)이고, 모델에는 문장으로 가고 코어(`parseOps`)가 자른다
    const tactic = buildOpsSchema(specs, TACTIC_OPS, "판", TACTIC_CAPS).properties as Record<
      string,
      { description?: string }
    >;
    expect(tactic.substitute?.description).toContain(`최대 ${TACTIC_CAPS.substitute}건`);
    const over = Array.from({ length: TACTIC_CAPS.substitute! + 2 }, () => ({}));
    const parsed = parseOps({ substitute: over }, TACTIC_OPS, TACTIC_CAPS);
    expect(parsed.ops.substitute).toHaveLength(TACTIC_CAPS.substitute!);
    // 자른 것은 조용히 사라지지 않는다 — 잘린 수가 `applyOps`의 줄로 돌아간다 (§1)
    expect(parsed.truncated.substitute).toBe(2);
  });

  /**
   * **받아쓰기는 동기 명령만 지난다** (`applyOps`). 해석기의 JSON은 한 번에 여럿을
   * 부르므로 프로미스를 돌려주는 손잡이(`tactic_orders`·`market_orders`…)가 목록에 들면
   * 적용이 그 자리에서 터진다 — 이름 한 줄로 벌어지는 일이라 여기서 막는다.
   */
  it("ops 목록의 명령은 전부 동기다 — 손잡이는 목록에 들지 않는다", () => {
    const specs = new Map(SKILL_TOOLS.map((t) => [t.name, t] as const));
    for (const name of [...TACTIC_OPS, ...TRAINING_OPS, ...MARKET_OPS]) {
      expect(specs.get(name)!.handle.constructor.name, name).not.toBe("AsyncFunction");
    }
  });

  /**
   * **부를 길이 없는 코어 명령은 없다.** GM에게 보이지 않는 명령(`CORE_COMMANDS`)은
   * 해석기의 목록에 정확히 한 번 서야 한다 — 빠지면 아무도 못 부르고, 둘에 서면 같은
   * 명령이 두 해석기에서 다른 문맥으로 채워진다.
   */
  it("코어 명령은 어느 해석기 목록에 정확히 한 번 선다", () => {
    const lists = [...TACTIC_OPS, ...TRAINING_OPS, ...MARKET_OPS];
    for (const name of CORE_COMMANDS) {
      expect(
        lists.filter((n) => n === name),
        name,
      ).toHaveLength(1);
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
 * 출력 스키마 넷은 GM 도구가 아니라 저마다의 호출이 강제하는 도구 하나다 — 카탈로그에도
 * `buildGmTools`에도 서지 않는다. 그래도 모델이 받는 입력이라 계약은 같다.
 */
const RATER_TOOLS = [
  { name: SETTLE_MATCH_TOOL, inputSchema: SETTLE_MATCH_INPUT },
  { name: REPORT_ONBOARDING_TOOL, inputSchema: REPORT_ONBOARDING_INPUT },
  { name: REPORT_TRAINING_TOOL, inputSchema: REPORT_TRAINING_INPUT },
  { name: REPORT_DIGEST_TOOL, inputSchema: REPORT_DIGEST_INPUT },
];

describe("같은 종류의 인자는 같은 검증을 지난다", () => {
  const args = [...TOOLS, ...RATER_TOOLS].flatMap((tool) =>
    walk(tool.inputSchema).map(([name, node]) => ({ tool: tool.name, name, node })),
  );
  const only = (names: readonly string[]) => args.filter((a) => names.includes(a.name));
  const where = (a: { tool: string; name: string }) => `${a.tool}.${a.name}`;

  /** 장부·피드에 영구히 남는 자유 문구 — 상한이 없으면 감독 발화가 통째로 실린다 */
  it("자유 문구에는 길이 상한이 있다", () => {
    const notes = only(["note", "label", "settlingNote"]);
    expect(notes.length).toBeGreaterThan(0);
    for (const a of notes) expect(a.node.maxLength, where(a)).toBeTypeOf("number");
  });

  it("금액은 정수이고 상한을 갖는다", () => {
    const money = only(["fee", "weeklyWage", "askingPrice", "amount", "delta"]);
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

  /** 빈 목록은 아무에게도 닿지 않으면서 하루 한도만 쓴다 */
  it("대상 목록은 빈 배열을 받지 않는다", () => {
    const lists = only(["playerIds", "targetIds"]);
    expect(lists.length).toBeGreaterThan(0);
    for (const a of lists) expect(a.node.minItems, where(a)).toBeGreaterThanOrEqual(1);
  });

  it("필수 인자는 전부 선언된 인자다", () => {
    for (const tool of [...TOOLS, ...RATER_TOOLS]) {
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
 * **감독이 부르지 않은 액수는 코어에 닿지 않는다** (docs/simulation/transfer.md §1).
 *
 * `send_offer`의 `fee`가 스키마에서 필수이던 자리다 — 해석기는 명령을 부르는 순간
 * 숫자를 만들어야 했고, 지어낸 0이 **£0 매각 오퍼**가 되어 코어를 지났다. 프롬프트가
 * 지어내지 말라고 적어도 규칙이 두 곳에서 반대로 서면 모델은 스키마를 따른다.
 */
describe("액수는 감독이 부른 것만 실린다", () => {
  /** 받아쓰기가 코어를 부르는 그 문 — `applyOps`와 같은 자리다 (동기 명령만) */
  function call(name: string, input: unknown): { ok: boolean; message: string } {
    const spec = SKILL_TOOLS.find((t) => t.name === name);
    if (!spec) throw new Error(`${name} 명령이 없다`);
    const result = spec.handle(input);
    if (result instanceof Promise) throw new Error(`${name}: 동기 명령이 아니다`);
    return result;
  }

  const ours = STATE.players.find((p) => p.teamId === STATE.userTeamId)!;
  const theirs = STATE.players.find((p) => p.teamId !== STATE.userTeamId)!;
  const buyer = STATE.teams.find((t) => t.id !== STATE.userTeamId)!.id;

  it("이적료가 빠지면 협상이 열리지 않고, 코어의 자가 한 줄로 돌아온다", () => {
    const before = STATE.negotiations.length;
    for (const input of [
      { playerId: theirs.name },
      { playerId: ours.name, kind: "sell", teamId: buyer },
      { playerId: ours.name, kind: "loan_out", teamId: buyer },
    ]) {
      const result = call("send_offer", input);
      expect(result.ok, JSON.stringify(input)).toBe(false);
      // 스키마 반려가 아니라 코어의 답이다 — 무엇이 비었는지와 그 갈래의 자를 든다
      expect(result.message).toContain("부르지 않았습니다");
      expect(result.message).toMatch(/£/);
    }
    expect(STATE.negotiations, "액수 없는 오퍼는 협상을 남기지 않는다").toHaveLength(before);
  });

  /**
   * 반려는 **코어의 판단**이어야 한다 — 스키마가 필수로 걸면 해석기는 액수를 비운
   * 채로는 명령을 부를 수조차 없어, 「감독이 말하지 않았다」가 어디에도 남지 않는다.
   */
  it("액수 자리를 스키마가 필수로 걸지 않는다", () => {
    const spec = SKILL_TOOLS.find((t) => t.name === "send_offer")!;
    const required = ((spec.inputSchema as Record<string, unknown>).required ?? []) as string[];
    expect(required).toContain("playerId");
    expect(required).not.toContain("fee");
    expect(required).not.toContain("weeklyWage");
  });
});

/**
 * **강제 도구로 나가는 산출 스키마** — docs/llm/models.md §3-2.
 *
 * 강제 모드(`toolChoice: { name }`)에서 제공자가 받아 주는 스키마는 한 겹 더 좁다.
 * Gemini는 그 모드에서 스키마를 **펼쳐** 디코딩 문법을 만들어 `maxItems: n`이 항목
 * 스키마 n벌이 되고, 자유 모드로는 지나던 선언이 400 하나로 떨어진다 — 본문은 어느
 * 칸이 문제인지 말하지 않아(§1-1의 표에서 `unknown`) 화면에는 턴 취소나 침묵으로만
 * 선다. 스위트의 LLM은 전부 목이라 스키마가 제공자의 문을 지나는지 묻는 자리는
 * 여기뿐이다.
 *
 * **자는 어댑터를 지난 뒤의 선언이다.** 제공자의 부분집합을 흡수하는 자리가 어댑터라
 * (AGENTS.md §6-1) 도구를 세우는 쪽은 제공자를 몰라도 된다 — `reply_at_table`의 Zod는
 * `.max()`를 들고 있어 **소스 선언에는 `maxItems`가 서 있다.** 소스에 자를 대면 합법인
 * 것을 금지하면서 정작 나가는 것은 못 본다.
 */
describe("강제 산출 스키마는 제공자의 문을 지난다", () => {
  const FORCED = forcedTools(new Map(SKILL_TOOLS.map((tool) => [tool.name, tool] as const)));

  /**
   * 제공자가 **강제 모드에서 받지 못하는 스키마 열쇠** — 한 줄이 한 제공자다.
   *
   * 비어 있다는 것은 "이 제공자에서 좁아지는 열쇠를 아직 만나지 않았다"이지 "무엇이든
   * 받는다"가 아니다. 제공자가 하나 늘면 이 표가 컴파일에서 먼저 걸린다.
   */
  const FORBIDDEN: Record<LlmProvider, readonly string[]> = {
    // 강제 모드가 스키마를 펼쳐 디코딩 문법을 만든다 — `maxItems: n`이 항목 스키마
    // n벌이 되어 요청 전체가 400 `INVALID_ARGUMENT`으로 떨어진다 (models.md §3-2).
    // 어댑터가 강제 턴 전체에서 걷어 낸다(`withoutMaxItems`).
    google: ["maxItems"],
    // 스키마는 `input_schema`로 그대로 가고, 강제(`tool_choice: { type:"tool" }`)가
    // 검사를 좁힌다고 알려진 열쇠가 없다
    anthropic: [],
    // 도구가 `strict: false`로 나간다 — strict 모드의 좁은 부분집합을 지나지 않는다
    openai: [],
  };

  /** 어댑터가 읽는 자리만 세운 Gemini 응답 — `@google/genai`는 여기서 부르지 않는다 */
  function geminiReply(parts: unknown[]): unknown {
    return {
      candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
      usageMetadata: {},
    };
  }

  /** SDK로 넘어간 payload 어디에 있든 함수 선언의 스키마를 전부 모은다 */
  function declaredSchemas(node: unknown, into: unknown[] = []): unknown[] {
    if (Array.isArray(node)) {
      for (const item of node) declaredSchemas(item, into);
      return into;
    }
    if (node === null || typeof node !== "object") return into;
    for (const [key, value] of Object.entries(node)) {
      if (key === "parametersJsonSchema") into.push(value);
      else declaredSchemas(value, into);
    }
    return into;
  }

  /**
   * 그 선언을 강제로 걸고 어댑터를 stub 클라이언트로 한 턴 돌린 뒤, **SDK에 실제로
   * 넘어간 함수 선언**을 꺼낸다 — chat 설정과 첫 요청의 per-request config 둘 다 도구를
   * 실으므로 둘 다 모은다.
   */
  async function geminiDeclarations(entry: ForcedTool): Promise<unknown[]> {
    const config = agentConfig(entry.agent);
    // 아래 표가 제공자로 골라 부르므로 걸릴 일이 없다 — 설정을 좁히는 자리다
    if (config.provider !== "google") throw new Error(`${entry.agent}는 google이 아니다`);
    const payloads: unknown[] = [];
    const history: unknown[] = [];
    let round = 0;
    const chat = {
      sendMessage: (params: { config?: unknown }) => {
        payloads.push(params.config);
        // 첫 왕복은 그 도구를 부르고, 결과를 받은 다음 왕복이 문장으로 턴을 닫는다
        const parts =
          round++ === 0
            ? [{ functionCall: { id: "call-1", name: entry.name, args: {} } }]
            : [{ text: "확인했습니다." }];
        history.push({ role: "user", parts: [{ text: "감독의 말" }] }, { role: "model", parts });
        return Promise.resolve(geminiReply(parts));
      },
      sendMessageStream: () => Promise.reject(new Error("이 자리는 스트리밍하지 않는다")),
      getHistory: () => history,
    };
    const client = {
      chats: {
        create: (params: { config?: unknown }) => {
          payloads.push(params.config);
          return chat;
        },
      },
    };
    const tool: GameToolSpec = {
      name: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
      handle: () => ({ ok: true, message: "받았습니다" }),
    };
    await new GeminiGameLLM(config, client as never).runTurn({
      system: entry.system,
      history: [],
      user: "감독의 말",
      tools: [tool],
      toolChoice: { name: entry.name },
    });
    return declaredSchemas(payloads);
  }

  /**
   * 선언을 꺼내는 자 — **제공자마다 그 어댑터의 stub이 필요하다.** 여기 없는 제공자로
   * 강제 호출이 옮겨 가면 재는 자가 없다는 뜻이고, 그 사실은 아래 케이스가 말한다.
   */
  const PROBES: Partial<Record<LlmProvider, (entry: ForcedTool) => Promise<unknown[]>>> = {
    google: geminiDeclarations,
  };

  it("어댑터를 지나 나가는 선언에 그 제공자가 못 받는 열쇠가 없다", async () => {
    const offenders: string[] = [];
    for (const entry of FORCED) {
      const { provider } = agentConfig(entry.agent);
      const probe = PROBES[provider];
      // 자가 없는 제공자는 아래 케이스가 잡는다 — 여기서 조용히 지나가지 않는다
      if (!probe) continue;
      const schemas = await probe(entry);
      // 꺼낸 것이 없으면 아무것도 재지 않은 채 초록이 된다
      expect(schemas.length, entry.name).toBeGreaterThan(0);
      for (const schema of schemas) {
        const nodes: Array<[string, Record<string, unknown>]> = [
          ["(뿌리)", schema as Record<string, unknown>],
          ...walk(schema),
        ];
        for (const [where, node] of nodes) {
          for (const key of FORBIDDEN[provider]) {
            if (key in node) offenders.push(`${entry.name}.${where}: ${key}`);
          }
        }
      }
    }
    // 같은 스키마가 두 자리로 나가므로 이름을 접는다 — 세는 것이 아니라 있고 없고다
    expect([...new Set(offenders)]).toEqual([]);
  });

  /**
   * **자를 댈 수 없는 제공자로 옮기면 빨개진다.** 지금 강제 호출 여덟은 전부 google이라
   * 위 케이스가 여덟을 다 재지만, `config/llm.yml`의 한 줄이 바뀌는 순간 그 선언은
   * 아무도 재지 않는 채로 나간다 — 옮기는 사람이 여기에 그 제공자의 자를 세우게 한다.
   */
  it("강제 호출이 나가는 제공자마다 선언을 꺼낼 자가 서 있다", () => {
    for (const entry of FORCED) {
      const { provider } = agentConfig(entry.agent);
      expect(PROBES[provider], `${entry.name}: ${entry.agent} → ${provider}`).toBeTypeOf(
        "function",
      );
    }
  });

  /**
   * **목록에 서지 않은 강제 호출은 위의 자가 재지 못한다.** 그래서 소스를 읽어 짝을 못
   * 박는다(선례: `packages/engine/test/harness-catalog.test.ts`). 양방향이다 — 소스에만
   * 있는 이름은 아무도 재지 않은 채 실호출로 나가고, 목록에만 있는 선언은 나가지 않는
   * 것을 재게 한다.
   */
  const SRC = join(import.meta.dirname, "..", "src");
  const FORCED_AT = /toolChoice:\s*\{\s*name:\s*([\w$.]+)\s*[,}]/g;
  const EXPORTED = new Map<string, unknown>(Object.entries(agents));

  /** 해석기 스펙 — 강제 이름을 파라미터로 받는 자리(`runOpsOrders`)가 도는 것들 */
  function isOpsSpec(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null) return false;
    const spec = value as { agent?: unknown; tool?: unknown; ops?: unknown };
    return (
      typeof spec.agent === "string" && typeof spec.tool === "string" && Array.isArray(spec.ops)
    );
  }

  /**
   * 소스에 적힌 이름 식이 실제로 거는 도구 이름들 — 읽지 못하면 `null`이다.
   *
   * 상수면 그 값 하나다. `spec.tool`처럼 파라미터를 타고 오는 자리는 **그 함수를 지나는
   * 스펙 전부**로 편다 — 해석기 셋이 한 함수를 지나므로, 스펙이 하나 늘면 그 이름도
   * 여기서 함께 늘어 목록과 대조된다.
   */
  function forcedNames(expression: string): string[] | null {
    const constant = EXPORTED.get(expression);
    if (typeof constant === "string") return [constant];
    if (!expression.includes(".")) return null;
    const property = expression.slice(expression.lastIndexOf(".") + 1);
    const names = [...EXPORTED.values()]
      .filter(isOpsSpec)
      .map((spec) => spec[property])
      .filter((name): name is string => typeof name === "string");
    return names.length > 0 ? names : null;
  }

  it("소스가 강제로 거는 이름과 목록이 같다", () => {
    const listed = new Set(FORCED.map((entry) => entry.name));
    const seen = new Set<string>();
    const unread: string[] = [];
    const unlisted: string[] = [];
    for (const file of readdirSync(SRC, { recursive: true, encoding: "utf8" })) {
      if (!file.endsWith(".ts")) continue;
      for (const match of readFileSync(join(SRC, file), "utf8").matchAll(FORCED_AT)) {
        const expression = match[1];
        const names = expression ? forcedNames(expression) : null;
        // 못 읽은 자리는 목록에 있는지조차 말할 수 없다 — 재지 못한 자리다
        if (!names) {
          unread.push(`${basename(file)}: ${expression ?? match[0]}`);
          continue;
        }
        for (const name of names) {
          seen.add(name);
          if (!listed.has(name)) unlisted.push(`${basename(file)}: ${name}`);
        }
      }
    }
    expect(unread).toEqual([]);
    expect(unlisted).toEqual([]);
    expect([...listed].filter((name) => !seen.has(name))).toEqual([]);
  });
});
