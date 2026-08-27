import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_SKILL_DESCRIPTIONS,
  GM_SYSTEM,
  MATCH_INTENT_SYSTEM,
  RATE_PLAYERS_INPUT,
  RATE_PLAYERS_TOOL,
  REPORT_DIGEST_INPUT,
  REPORT_DIGEST_TOOL,
  REPORT_MOOD_INPUT,
  REPORT_MOOD_TOOL,
  REPORT_TRAINING_INPUT,
  REPORT_TRAINING_TOOL,
  MATCH_RATER_SYSTEM,
  MatchIntentSchema,
  SKILL_CATALOG,
  SKILL_NAMES,
  TRAINING_RATER_SYSTEM,
  agingDeclineLine,
  buildGmTools,
  toToolSchema,
} from "@story-fm/agents";
import {
  ATTRIBUTE_AXES,
  AXIS_KO,
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
      진행: 5,
      "전술·훈련": 15,
      "대화·서사": 5,
      경기: 1,
      이적: 13,
      재정: 6,
      조회: 11,
    });
    expect(SKILL_CATALOG.length).toBe(56);
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

  it("어느 프롬프트 층도 도구 이름을 적지 않는다", () => {
    for (const name of SKILL_NAMES) {
      expect(mentions(GM_SYSTEM, name), `GM_SYSTEM: ${name}`).toBe(false);
      expect(mentions(MATCH_INTENT_SYSTEM, name), `MATCH_INTENT_SYSTEM: ${name}`).toBe(false);
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

    expect(MATCH_RATER_SYSTEM).toContain(line);
    expect(TRAINING_RATER_SYSTEM).toContain(line);
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
    const setTactics = TOOLS.find((t) => t.name === "set_tactics")!.inputSchema.properties;
    const intent = toToolSchema(MatchIntentSchema).properties?.tactics as {
      properties?: Record<string, unknown>;
    };
    for (const toggle of TACTIC_TOGGLES) {
      for (const [where, props] of [
        ["set_tactics", setTactics],
        ["match-intent", intent.properties],
      ] as const) {
        expect(choices(props?.[toggle.key]), `${where}.${toggle.key}`).toContain(
          toggle.neutralValue,
        );
      }
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
    const routine = TOOLS.find((t) => t.name === "set_set_piece_routine")!;
    const intentRoutine = toToolSchema(MatchIntentSchema).properties?.setPieceRoutine as {
      properties?: Record<string, unknown>;
    };
    for (const axis of SET_PIECE_ROUTINE_AXES) {
      for (const [where, props] of [
        ["set_set_piece_routine", routine.inputSchema.properties],
        ["match-intent", intentRoutine.properties],
      ] as const) {
        expect(enumOf(props?.[axis.key]), `${where}.${axis.key}`).toContain(
          SET_PIECE_ROUTINE_NEUTRAL,
        );
      }
    }
    // 설명이 가르치는 토큰도 같은 것 하나다 — 손으로 적으면 낱말표를 고쳐도 남는다
    expect(routine.description).toContain(SET_PIECE_ROUTINE_NEUTRAL);
    expect(MATCH_INTENT_SYSTEM).toContain(SET_PIECE_ROUTINE_NEUTRAL);
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
 * 결산 넷은 GM 도구가 아니라 저마다의 호출이 강제하는 도구 하나다 — 카탈로그에도
 * `buildGmTools`에도 서지 않는다. 그래도 모델이 받는 입력이라 계약은 같다.
 */
const RATER_TOOLS = [
  { name: RATE_PLAYERS_TOOL, inputSchema: RATE_PLAYERS_INPUT },
  { name: REPORT_TRAINING_TOOL, inputSchema: REPORT_TRAINING_INPUT },
  { name: REPORT_MOOD_TOOL, inputSchema: REPORT_MOOD_INPUT },
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
