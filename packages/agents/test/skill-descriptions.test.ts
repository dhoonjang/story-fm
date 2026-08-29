import { describe, expect, it } from "vitest";
import { z } from "zod";
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
  toToolSchema,
} from "@story-fm/agents";
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
   * 두 줄이 붙어도 아무 데서도 드러나지 않는다. 상한은 지금 총량(≈13,330자)에 한 도구
   * 몫의 여유를 얹은 값이다 — **도구가 늘 때만** 그만큼 올린다.
   */
  it("설명은 길이 예산 안에 있다", () => {
    const total = SKILL_CATALOG.reduce((sum, skill) => sum + skill.description.length, 0);
    for (const skill of SKILL_CATALOG) {
      expect(skill.description.length, skill.name).toBeLessThanOrEqual(600);
    }
    expect(total).toBeLessThanOrEqual(13_780);
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
