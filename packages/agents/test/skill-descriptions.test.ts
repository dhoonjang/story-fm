import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_SKILL_DESCRIPTIONS,
  GM_SYSTEM,
  SKILL_CATALOG,
  SKILL_NAMES,
  buildGmTools,
  toToolSchema,
} from "@story-fm/agents";
import { createGame, interpretBackgroundHeuristic } from "@story-fm/engine";

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
});

/**
 * 규칙이 사는 자리 — docs/llm/prompts.md §5.
 *
 * 한 도구의 사용법은 **그 도구의 설명에만** 있다. 프롬프트의 문구를 여기서 고정하면
 * 프롬프트를 고칠 수 없으므로(AGENTS.md §6-5) 재는 것은 문구가 아니라 **중복이
 * 생기지 않는다**는 것 하나다: 사용법이 설명으로 넘어간 도구를 시스템 프롬프트가
 * 다시 부르면, 같은 규칙이 두 곳에 살아 한쪽만 고쳐진다.
 */
describe("규칙이 사는 자리", () => {
  /**
   * 사용법이 설명으로 넘어간 도구들. (프롬프트가 이름을 부르는 도구가 아예 없지는
   * 않다 — 오퍼 판정처럼 **언제 부르는지**가 라우팅인 자리는 프롬프트의 몫이다.)
   */
  const MOVED = ["team_talk", "talk_to_player", "respond_to_media", "deal_odds", "send_offer"];

  it("시스템 프롬프트는 넘긴 도구의 사용법을 다시 적지 않는다", () => {
    for (const name of MOVED) {
      expect(GM_SYSTEM, name).not.toContain(name);
      expect(
        DEFAULT_SKILL_DESCRIPTIONS[name as (typeof SKILL_NAMES)[number]].length,
      ).toBeGreaterThan(0);
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

describe("같은 종류의 인자는 같은 검증을 지난다", () => {
  const args = TOOLS.flatMap((tool) =>
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
    for (const tool of TOOLS) {
      for (const [, node] of [["", tool.inputSchema] as const, ...walk(tool.inputSchema)]) {
        const declared = Object.keys((node.properties ?? {}) as Record<string, unknown>);
        for (const key of (node.required ?? []) as string[]) {
          expect(declared, `${tool.name}.${key}`).toContain(key);
        }
      }
    }
  });
});
