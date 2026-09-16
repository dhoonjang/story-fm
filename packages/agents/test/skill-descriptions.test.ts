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
  MATCH_TOOL_DEFINITIONS,
  TACTIC_CAPS,
  TACTIC_OPS,
  TABLE_OPS,
  TABLE_ORDERS_SYSTEM,
  TRAINING_OPS,
  buildOpsSchema,
  parseOps,
  TACTIC_ORDERS_SYSTEM,
  FINALIZE_MATCH_SYSTEM,
  REPLY_INPUT,
  REPORT_DIGEST_INPUT,
  REPORT_TRAINING_INPUT,
  REPORT_ONBOARDING_INPUT,
  SETTLE_MATCH_INPUT,
  NEGOTIATION_TABLE_SYSTEM,
  ONBOARDING_JUDGE_SYSTEM,
  SKILL_CATALOG,
  SKILL_NAMES,
  TRAINING_RATER_SYSTEM,
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
} from "@story-fm/llm";
import {
  ATTRIBUTE_AXES,
  AXIS_KO,
  INCIDENT_KIND_KO,
  INCIDENT_KINDS,
  OPENING_KIND_KO,
  OPENING_KINDS,
  PITCH_CLAIM_KINDS,
  PITCH_CLAIM_KO,
  PITCH_CLAIM_MEANING,
  DIRECTIVE_INTENSITIES,
  DIRECTIVE_INTENSITY_KO,
  PLAYER_DIRECTIVE_KINDS,
  PLAYER_DIRECTIVE_KO,
  POSITION_CODES,
  PROMISE_KIND_KO,
  PROMISE_KIND_MEANING,
  PROMISE_KINDS,
  SET_PIECE_ROUTINE_AXES,
  SET_PIECE_ROUTINE_NEUTRAL,
  SQUAD_STATUS_KO,
  SQUAD_STATUSES,
  TABLE_STANCE_KO,
  TABLE_STANCES,
  TACTIC_TOGGLES,
  TRAINING_MARK_KO,
  TRAINING_MARKS,
  roleVocabularyText,
  rolesFor,
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
      "대화·서사": 4,
      이적: 4,
      재정: 1,
      조회: 11,
    });
    expect(SKILL_CATALOG.length).toBe(24);
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
     *
     * **코어 명령의 이름도 센다.** GM은 `accept_deal`·`send_offer`를 도구로 갖지
     * 않고 `market_orders`에 감독의 말을 넘길 뿐이다 — 코어의 결과 줄이 그 이름으로
     * 다음에 할 일을 적으므로(`describePending`) 규칙을 적는 자리에도 같은 이름을
     * 적고 싶어지는데, 그러면 GM이 부를 수 없는 도구를 아는 것이 된다.
     */
    for (const name of [...SKILL_NAMES, ...CORE_COMMANDS]) {
      expect(mentions(GM_SYSTEM, name), `GM_SYSTEM: ${name}`).toBe(false);
      // 테이블 해석기도 자기 목록 밖의 이름은 적지 않는다 (transfer.md §12-2)
      if (!TABLE_OPS.includes(name)) {
        expect(mentions(TABLE_ORDERS_SYSTEM, name), `TABLE_ORDERS_SYSTEM: ${name}`).toBe(false);
      }
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
   * **손잡이 셋은 인자가 없다** (agents.md §1). 인자가 하나라도 서면 GM이 감독의 말을
   * 옮겨 적을 자리가 생기고, 그 문장이 해석기의 근거가 된다 — 화면에는 걸린 지시만 보여
   * 갈린 말은 아무도 보지 못한다. 경기 도구의 지시 손잡이도 같다.
   */
  it("손잡이 셋은 인자가 없다 — 감독의 말은 코어가 넘긴다", () => {
    for (const name of ["tactic_orders", "training_orders", "market_orders"]) {
      const tool = TOOLS.find((t) => t.name === name)!;
      expect(Object.keys(tool.inputSchema.properties ?? {}), name).toEqual([]);
    }
    const match = MATCH_TOOL_DEFINITIONS.find((t) => t.name === "tactic_orders")!;
    expect(Object.keys(match.inputSchema.properties ?? {})).toEqual([]);
    // 테이블의 말은 남는다 — 상대에게 그대로 건네지는 발화라 턴 발화 전체와 같지 않다
    const table = TOOLS.find((t) => t.name === "speak_at_table")!;
    expect(Object.keys(table.inputSchema.properties ?? {})).toContain("line");
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

    expect(FINALIZE_MATCH_SYSTEM).toContain(line);
    expect(TRAINING_RATER_SYSTEM).toContain(line);
  });

  /**
   * **코어가 갈래표를 들면 그 표가 모델에게 닿아야 한다** (prompts.md §2).
   *
   * 열거가 내는 것은 토큰뿐이고 `toToolSchema`는 JSDoc을 싣지 않는다 — 뜻이 주석에만
   * 있으면 모델은 **뜻 없는 낱말 열**을 받고, 잘못 고른 갈래를 코어가 사실 대조해 조용히
   * 벌한다. 설득 논거가 그 자리였다: 감독이 자기 오퍼를 두고 한 "정말 마지막입니다"가
   * 그 **선수**의 사정을 뜻하는 `last_chance`로 옮겨져 거짓이 되고 인내가 깎였다.
   *
   * 뜻이 서는 자리는 셋 중 하나다 — 그 도구의 설명 · 그 인자의 `description` · 그 호출의
   * 시스템 프롬프트. 어디에 서든 **낱말은 코어의 표에서 와야 한다**: 손으로 적으면 갈래가
   * 늘어도 모델은 옛 표를 믿고, 표에 없는 갈래는 부를 길이 없다.
   */
  it("코어가 갈래표를 든 열거는 그 표가 모델에게 닿는다", () => {
    const reply = { name: "negotiation-table", inputSchema: REPLY_INPUT };
    const rows = [
      {
        where: "record_incident.kind",
        node: enumArg(TOOLS, "record_incident", "kind"),
        kinds: INCIDENT_KINDS as readonly string[],
        tables: [INCIDENT_KIND_KO as Record<string, string>],
        reads: TOOLS.find((t) => t.name === "record_incident")!.description,
      },
      {
        where: "onboarding-judge.openings[].kind",
        node: enumArg(OUTPUT_SCHEMAS, "onboarding-judge", "kind"),
        kinds: OPENING_KINDS as readonly string[],
        tables: [OPENING_KIND_KO as Record<string, string>],
        reads: ONBOARDING_JUDGE_SYSTEM,
      },
      {
        where: "negotiation-table.heard.claims[].kind",
        node: enumArg([reply], reply.name, "kind"),
        kinds: PITCH_CLAIM_KINDS as readonly string[],
        /**
         * 여기만 표가 둘이다. 낱말은 장부 줄이 쓰는 것과 같아야 하고(다음 답을 쓰는
         * 모델이 `<table_log>`에서 그 낱말을 다시 읽는다), **뜻**은 갈래를 가르는
         * 문장이라 낱말만으로는 「마지막 기회」가 누구의 것인지 서지 않는다.
         */
        tables: [PITCH_CLAIM_KO, PITCH_CLAIM_MEANING] as Array<Record<string, string>>,
        reads: "",
      },
      {
        where: "negotiation-table.stance",
        node: enumArg([reply], reply.name, "stance"),
        kinds: TABLE_STANCES as readonly string[],
        tables: [TABLE_STANCE_KO as Record<string, string>],
        reads: NEGOTIATION_TABLE_SYSTEM,
      },
      {
        /** 대화와 다가옴의 응대가 **같은 인자 하나**를 쓴다 — 한 자리를 재면 둘 다 잰다 */
        where: "team_talk.promise.kind",
        node: enumArg(TOOLS, "team_talk", "kind"),
        kinds: PROMISE_KINDS as readonly string[],
        /**
         * 여기도 표가 둘이다. 낱말은 장부 줄과 화면이 쓰는 이름이고(「출전」),
         * **뜻**은 기한 날 장부가 무엇을 재는지를 가르는 문장이라(선발 비율)
         * 낱말만으로는 감독의 말이 어느 갈래인지 서지 않는다 (people.md §5-2).
         */
        tables: [PROMISE_KIND_KO, PROMISE_KIND_MEANING] as Array<Record<string, string>>,
        reads: "",
      },
      {
        where: "training-rater.results[].mark",
        node: enumArg(OUTPUT_SCHEMAS, "training-rater", "mark"),
        kinds: TRAINING_MARKS as readonly string[],
        tables: [TRAINING_MARK_KO as Record<string, string>],
        reads: TRAINING_RATER_SYSTEM,
      },
      {
        /**
         * 오퍼·재계약이 싣는 지위와 조정이 되부르는 지위는 **같은 줄**을 읽는다
         * (`SQUAD_STATUS_LINE`) — 서류는 지위를 낱말로 적고 모델은 토큰으로 답한다.
         */
        where: "send_offer.squadStatus",
        node: enumArg(SKILL_TOOLS, "send_offer", "squadStatus"),
        kinds: SQUAD_STATUSES as readonly string[],
        tables: [SQUAD_STATUS_KO as Record<string, string>],
        reads: "",
      },
      {
        where: "negotiation-table.ruling.squadStatus",
        node: enumArg([reply], reply.name, "squadStatus"),
        kinds: SQUAD_STATUSES as readonly string[],
        tables: [SQUAD_STATUS_KO as Record<string, string>],
        reads: "",
      },
      {
        /** 개인 지시는 해석기가 고른다 — 뜻은 그 호출의 시스템 프롬프트에 선다 */
        where: "set_player_tactic.instruction.kind",
        node: enumArg(SKILL_TOOLS, "set_player_tactic", "kind"),
        kinds: PLAYER_DIRECTIVE_KINDS as readonly string[],
        tables: [PLAYER_DIRECTIVE_KO as Record<string, string>],
        reads: TACTIC_ORDERS_SYSTEM,
      },
      {
        where: "set_player_tactic.instruction.intensity",
        node: enumArg(SKILL_TOOLS, "set_player_tactic", "intensity"),
        kinds: DIRECTIVE_INTENSITIES as readonly string[],
        tables: [DIRECTIVE_INTENSITY_KO as Record<string, string>],
        reads: TACTIC_ORDERS_SYSTEM,
      },
    ];
    for (const row of rows) {
      expect([...(row.node.enum ?? [])].sort(), row.where).toEqual([...row.kinds].sort());
      const read = `${row.reads}\n${row.node.description ?? ""}`;
      for (const kind of row.kinds) {
        expect(read, `${row.where}: ${kind}`).toContain(kind);
        for (const table of row.tables) {
          expect(read, `${row.where}: ${kind}`).toContain(table[kind]);
        }
      }
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
   * **역할 50종의 낱말도 해석 프롬프트가 든다** (agents.md §3). `set_player_tactic.role`은
   * 자리마다 목록이 달라 열거로 서지 못하는 자유 문자열이라, 표가 빠지면 "안쪽으로
   * 파고들어"가 어느 명령에도 담기지 못하고 `unresolved`로 떨어진다 — 갈래 넷과 같은
   * 실패고, 화면에는 드러나지 않는다.
   */
  it("해석 프롬프트가 자리별 역할 표를 통째로 싣는다", () => {
    expect(TACTIC_ORDERS_SYSTEM).toContain(roleVocabularyText());
    // 표가 비어도 위 줄은 통과한다 — 50종이 실제로 실렸는지는 역할마다 본다
    for (const position of POSITION_CODES) {
      for (const def of rolesFor(position)) {
        expect(TACTIC_ORDERS_SYSTEM, `${position}: ${def.id}`).toContain(def.id);
      }
    }
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
    // 테이블 해석기는 시장 해석의 부분집합을 이 협상의 문맥으로 다시 채운다 — 새 이름은 없다 (§12-2)
    for (const name of TABLE_OPS) expect(MARKET_OPS.includes(name), name).toBe(true);
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

/** 모델이 받는 열거 노드 하나 — `walk`가 붙인 이름으로 찾는다 (배열 안쪽의 `kind`도 `kind`다) */
function enumArg(
  tools: ReadonlyArray<{ name: string; inputSchema: unknown }>,
  tool: string,
  arg: string,
): { enum?: unknown[]; description?: string } {
  const found = tools.find((t) => t.name === tool)!;
  const [, node] = walk(found.inputSchema).find(([name]) => name === arg)!;
  return node as { enum?: unknown[]; description?: string };
}

/**
 * 출력 스키마 넷은 GM 도구가 아니라 저마다의 호출이 요청에 싣는 산출의 꼴이다 — 카탈로그에도
 * `buildGmTools`에도 서지 않고 이름은 에이전트의 것이다. 그래도 모델이 받는 입력이라 계약은 같다.
 */
const OUTPUT_SCHEMAS = [
  { name: "finalize-match", inputSchema: SETTLE_MATCH_INPUT },
  { name: "onboarding-judge", inputSchema: REPORT_ONBOARDING_INPUT },
  { name: "training-rater", inputSchema: REPORT_TRAINING_INPUT },
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
   * 재계약과 해지도 같은 규약이다 — 협상을 여는 셋이 한 절 아래 있다 (transfer.md §1).
   * 여기서 기대치를 대신 싣는 것이 특히 조용한 것은, 첫 제시액이 되부르기 상한과 선수
   * 관문을 함께 정하기 때문이다: 지어낸 값 하나가 협상 전체의 폭이 된다.
   */
  it("재계약의 주급과 해지의 정산금도 빠지면 협상이 열리지 않는다", () => {
    const before = STATE.negotiations.length;
    for (const [name, input] of [
      ["open_renewal", { playerId: ours.name }],
      ["open_renewal", { playerId: ours.name, years: 3 }],
      ["open_release", { playerId: ours.name }],
    ] as const) {
      const result = call(name, input);
      expect(result.ok, JSON.stringify(input)).toBe(false);
      expect(result.message).toContain("부르지 않았습니다");
      // 그 갈래의 자가 함께 온다 — 감독이 값을 부르려 확률 조회를 한 번 더 거치지 않게
      expect(result.message).toMatch(/£/);
    }
    expect(STATE.negotiations, "액수 없는 제안은 협상을 남기지 않는다").toHaveLength(before);
  });

  /**
   * 반려는 **코어의 판단**이어야 한다 — 스키마가 필수로 걸면 해석기는 액수를 비운
   * 채로는 명령을 부를 수조차 없어, 「감독이 말하지 않았다」가 어디에도 남지 않는다.
   */
  it("액수 자리를 스키마가 필수로 걸지 않는다", () => {
    for (const [name, amounts] of [
      ["send_offer", ["fee", "weeklyWage"]],
      // 연수도 비울 수 있다 — 코어가 아는 기대 연수가 실린다
      ["open_renewal", ["weeklyWage", "years"]],
      ["open_release", ["severance"]],
    ] as const) {
      const spec = SKILL_TOOLS.find((t) => t.name === name)!;
      const required = ((spec.inputSchema as Record<string, unknown>).required ?? []) as string[];
      expect(required, name).toContain("playerId");
      for (const amount of amounts) expect(required, `${name}.${amount}`).not.toContain(amount);
    }
  });
});

/**
 * **출력 스키마로 나가는 산출 선언** — docs/llm/models.md §3-2.
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
  const DECLARED = outputAgents(new Map(SKILL_TOOLS.map((tool) => [tool.name, tool] as const)));

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
  it("GM 둘을 뺀 에이전트 전부가 출력 스키마로 답한다 — 도구 이름은 없다", () => {
    const expected = AGENT_NAMES.filter((name) => name !== "gm" && name !== "match-gm");
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
    // 해석기 넷은 한도 밖이고 나머지 여섯은 안이다 — 실측(2026-09)과 같은 그림이어야 한다
    const over = DECLARED.filter((entry) => countOptionalProperties(entry.schema) > 24).map(
      (entry) => entry.agent,
    );
    expect(over.sort()).toEqual([
      "market-orders",
      "table-orders",
      "tactic-orders",
      "training-orders",
    ]);
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
   * 못 박는다(선례: `packages/engine/test/harness-catalog.test.ts`). 양방향이다 — 소스에만
   * 있는 자리는 아무도 재지 않은 채 실호출로 나가고, 목록에만 있는 선언은 나가지 않는 것을
   * 재게 한다. 이름이 없으므로 짝은 **에이전트 이름**이다 — `agentConfig("…")`가 그 자리다.
   */
  const SRC = join(import.meta.dirname, "..", "src");
  const EXPORTED = new Map<string, unknown>(Object.entries(agents));

  /** 해석기 스펙 — 에이전트 이름을 파라미터로 받는 자리(`runOpsOrders`)가 도는 것들 */
  function isOpsSpec(value: unknown): value is { agent: string } {
    if (typeof value !== "object" || value === null) return false;
    const spec = value as { agent?: unknown; ops?: unknown };
    return typeof spec.agent === "string" && Array.isArray(spec.ops);
  }
  const OPS_AGENTS = [...EXPORTED.values()].filter(isOpsSpec).map((spec) => spec.agent);

  it("출력 스키마를 요청하는 자리마다 그 에이전트가 목록에 있고, 목록의 에이전트는 전부 요청한다", () => {
    const listed = new Set<string>(DECLARED.map((entry) => entry.agent));
    const seen = new Set<string>();
    const unread: string[] = [];
    for (const file of readdirSync(SRC, { recursive: true, encoding: "utf8" })) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(join(SRC, file), "utf8");
      if (!source.includes("outputSchema:")) continue;
      const names = [...source.matchAll(/agentConfig\("([a-z-]+)"\)/g)].map((m) => m[1]!);
      // 해석기 넷은 한 함수를 지난다 — 스펙이 하나 늘면 그 이름도 여기서 함께 늘어 목록과 대조된다
      if (/agentConfig\(spec\.agent\)/.test(source)) names.push(...OPS_AGENTS);
      // 못 읽은 자리는 목록에 있는지조차 말할 수 없다 — 재지 못한 자리다
      if (names.length === 0) unread.push(basename(file));
      for (const name of names) seen.add(name);
    }
    expect(unread).toEqual([]);
    expect([...seen].filter((name) => !listed.has(name)).sort()).toEqual([]);
    expect([...listed].filter((name) => !seen.has(name)).sort()).toEqual([]);
  });
});
