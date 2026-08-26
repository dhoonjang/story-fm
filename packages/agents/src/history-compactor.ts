import { z } from "zod";
import {
  ARC_STAGE_KO,
  ARC_TITLE_MAX,
  CharacterMemorySchema,
  personaRoleLabel,
  type Persona,
} from "@story-fm/domain";
import {
  HISTORY_DIGEST_CHARS,
  REGISTERABLE_ROLES,
  activeArcs,
  applyArcTitles,
  applyCharacterMemories,
  applyHistoryDigest,
  arcFactLine,
  planHistoryFold,
  registerCharacters,
  worldFigures,
  type GameState,
  type HistoryFoldBrief,
} from "@story-fm/engine";
import { agentConfig, createGameLLM, type GameLLM, type GameToolSpec } from "@story-fm/llm";
import { resolveLlmMode } from "./gm";
import { retryOnce, requireToolCall } from "./retry";
import { inputError, toToolSchema } from "./tool-schema";

/**
 * 이력 압축 — 창 밖으로 밀려나는 평시 구간을 요약 한 벌로 옮기고, 그 김에
 * 캐릭터북을 갱신한다 (agents.md §5-1 · people.md §9-1).
 *
 * 결산 셋과 같은 계약이다: 검사는 전부 코어의 몫이고(`applyHistoryDigest`·
 * `applyCharacterMemories`·`registerCharacters`), **실패하면 접지 않는다** —
 * 요약이 비는 자리를 만들지 않기 위해 세이브는 그대로 두고 다음 기회에 다시 온다.
 */

export const HISTORY_COMPACTOR_SYSTEM = `당신은 구단의 기록 담당이다.

감독과 구단 사람들이 나눈 대화 중 이력에서 밀려나는 구간을 읽고, 그 구간을
요약 한 벌로 남긴다. 같은 김에 그 구간에 있던 사람의 기억을 적고, 새로 나타난
사람을 명부에 세운다.

## 요약
- 이전 요약이 함께 주어지면 새 구간과 합쳐 한 벌로 다시 쓴다. 이어 붙이지 않는다.
- ${HISTORY_DIGEST_CHARS}자 이내.
- 남길 것 — 감독이 내린 결정과 그 이유, 사람들 사이에 생긴 일, 아직 끝나지 않은 일
  (진행 중인 협상·약속·갈등).
- 버릴 것 — 장부가 이미 아는 수치(순위·이적료·평점·일정), 인사말, 되풀이된 말.
- 시간순으로 적는다. 원문에 없는 사실을 지어내지 마라.

## 인물별 기억
- 감독과 실제로 무언가 오간 사람만 적는다. 아무 일도 없던 사람은 적지 않는다.

## 새 인물
- 그 구간에서 처음 이름을 갖고 말한 사람만 세운다.
- 이미 있는 인물의 성격·동기·말투는 고쳐 쓰지 않는다. 새로 세우는 사람만 적는다.
  선수는 목록에 없어도 이미 서 있다.
- 자리는 셋뿐이다 — 기자는 reporter, 감독의 지인 등 구단 밖 사람은 friend, 이름
  있는 서포터는 supporter.
- 집단은 사람이 아니다. 이름 없는 "취재진"·"관중"은 세우지 않는다.

## 아크 제목
- "이름 없는 이야기" 목록이 주어지면, 그 아크에 어울리는 제목을 제안한다.
- 제목은 ${ARC_TITLE_MAX}자 이내 — 사실 줄을 되풀이하지 말고 이야기의 결을 잡아라.
- 목록에 없는 아크에는 제목을 붙이지 않는다. 목록이 없으면 비운다.`;

/**
 * 인물 카드의 자유 문구 상한 — 카드는 불린 턴마다 레퍼런스 층에 통째로 실린다
 * (agents.md §5). 상한이 없으면 모델이 쓴 한 문장이 문단이 되어 그 층을 밀어낸다.
 */
const CARD_TEXT_MAX = 200;

/** 길이와 무게는 세이브의 계약이 정한다 — 여기 다시 적으면 그 자리가 갈린다 */
const MemorySchema = z.object({
  characterId: z.string().min(1).describe("원문 @태그의 이름 그대로"),
  text: CharacterMemorySchema.shape.text.describe("그 사람에게 있었던 일 한 줄 (120자 이내)"),
  salience: CharacterMemorySchema.shape.salience
    .optional()
    .describe("1~5 — 지나가는 일이 1, 관계를 바꾼 일이 5"),
});

const CharacterSchema = z.object({
  characterId: z.string().min(1).describe("그 사람의 이름 (전역 유일)"),
  name: z.string().min(1),
  role: z.enum(REGISTERABLE_ROLES),
  archetype: z.string().min(1).max(CARD_TEXT_MAX).describe("어떤 유형의 사람인가"),
  traits: z.array(z.string().min(1).max(CARD_TEXT_MAX)).min(1).describe("성격 3~5개"),
  motivation: z.string().min(1).max(CARD_TEXT_MAX).describe("이 사람이 원하는 것 한 문장"),
  speechStyle: z.object({
    note: z.string().min(1).max(CARD_TEXT_MAX).describe("말투 지문 한 문장"),
    samples: z
      .array(z.string().min(1).max(CARD_TEXT_MAX))
      .min(1)
      .describe("이 사람이라면 이렇게 말한다 — 2~3개"),
  }),
});

const ArcTitleSchema = z.object({
  arcId: z.string().min(1).describe("목록의 아크 id 그대로"),
  title: z
    .string()
    .min(1)
    .max(ARC_TITLE_MAX)
    .describe(`이야기의 결을 잡는 제목 (${ARC_TITLE_MAX}자 이내)`),
});

const ReportInputSchema = z.object({
  /**
   * 상한은 코어도 잰다(`applyHistoryDigest` — 자르지 않고 거절한다). 같은 상수를
   * 두 곳이 읽되 모델에게 닿는 것은 이 한 벌이고, 반려 문구도 여기 것이 나간다.
   */
  summary: z
    .string()
    .min(1)
    .max(HISTORY_DIGEST_CHARS, `요약은 ${HISTORY_DIGEST_CHARS}자 이내여야 합니다`)
    .describe(`이전 요약과 이번 구간을 합친 한 벌 (${HISTORY_DIGEST_CHARS}자 이내)`),
  memories: z
    .array(MemorySchema)
    .optional()
    .describe("그 구간에 사람들에게 있었던 일 — 없으면 비운다"),
  characters: z
    .array(CharacterSchema)
    .optional()
    .describe("이 구간에서 처음 선 인물 — 없으면 비운다"),
  arcTitles: z
    .array(ArcTitleSchema)
    .optional()
    .describe("이름 없는 이야기에 제안하는 제목 — 목록이 없으면 비운다"),
});

/** 모델이 보는 입력 — 위 Zod 한 벌에서 파생한다 (prompts.md §2) */
export const REPORT_DIGEST_INPUT = toToolSchema(ReportInputSchema);

/** 접히는 구간의 화자 — 세이브의 역할을 사람이 읽는 말로 */
function speakerOf(role: HistoryFoldBrief["turns"][number]["role"]): string {
  if (role === "model") return "장면";
  if (role === "operator") return "화면 조작";
  return "감독";
}

/** 브리프를 프롬프트 본문으로 — 이전 요약 + 이미 선 사람 + 이름 없는 아크 + 접히는 원문 */
export function buildCompactionPrompt(
  // 명부의 감독은 **지금 어디 서 있는가**로 걸러지므로 벤치와 무직 풀이 함께 와야
  // 한다 (people.md §2-1) — 없으면 잘린 뒤 다른 벤치에 선 사람이 목록에서 빠진다
  state: {
    personas?: Persona[];
    userTeamId: string;
    teams?: readonly { id: string; managerName?: string }[];
    managerPool?: readonly { name: string }[];
  },
  brief: HistoryFoldBrief,
  arcs: readonly { id: string; line: string }[] = [],
): string {
  const blocks: string[] = [];
  if (brief.previous !== null) {
    blocks.push(`## 이전 요약 (${brief.rounds - 1}겹째까지)`, brief.previous, "");
  }
  // 세계 인물 명부도 이미 선 사람이다 — 목록에 없으면 모델이 상대 감독·에이전트를
  // 새로 세우려 하고, 그 등록은 코어가 어차피 거절한다 (people.md §9-1)
  const standing = [...(state.personas ?? []), ...worldFigures(state)].map((p) => {
    const label = personaRoleLabel(p.role);
    return label === undefined ? `- ${p.characterId}` : `- ${p.characterId} (${label})`;
  });
  if (standing.length > 0) {
    blocks.push("## 이미 캐릭터북에 선 사람 — 다시 세우지 않는다", ...standing, "");
  }
  if (arcs.length > 0) {
    blocks.push(
      "## 이름 없는 이야기 — arcTitles로 제목을 제안하라",
      ...arcs.map((a) => `- ${a.id} · ${a.line}`),
      "",
    );
  }
  blocks.push(`## 접히는 구간 (${brief.turns.length}턴)`);
  for (const turn of brief.turns) {
    blocks.push(`### ${turn.at} · ${speakerOf(turn.role)}`, turn.text);
  }
  return blocks.join("\n");
}

/**
 * 제목이 없는 활성 아크 — 압축 브리프에 실리는 목록이다 (people.md §9).
 * 사실 줄은 코어의 것(`arcFactLine`)이고, 단계를 붙여 이야기의 지금을 알린다.
 */
export function untitledArcs(state: GameState): { id: string; line: string }[] {
  return activeArcs(state)
    .filter((arc) => arc.title === undefined)
    .map((arc) => ({
      id: arc.id,
      line: `${arcFactLine(state, arc)} (${ARC_STAGE_KO[arc.stage]})`,
    }));
}

/**
 * 이 호출의 산출은 이 도구 하나뿐이다 — 요청에 강제로 실린다 (agents.md §3).
 *
 * 캐릭터북 갱신을 별도 도구로 두지 않은 이유가 그것이다: `toolChoice`는 도구
 * **하나**를 강제하고 그것도 첫 요청에만 걸리므로, 둘로 나누면 나머지 하나는
 * 모델이 부를 수도 안 부를 수도 있는 자리가 된다.
 */
export const REPORT_DIGEST_TOOL = "report_digest";

interface CompactionResult {
  folded: boolean;
  memories: number;
  characters: number;
}

function makeReportTool(
  state: GameState,
  brief: HistoryFoldBrief,
  onApplied: (result: CompactionResult) => void,
): GameToolSpec {
  return {
    name: REPORT_DIGEST_TOOL,
    description:
      "접히는 구간의 요약 한 벌과 캐릭터북 갱신을 함께 제출한다. 검사에 걸린 항목은 코어가 버린다.",
    inputSchema: REPORT_DIGEST_INPUT,
    handle: (input: unknown) => {
      const parsed = ReportInputSchema.safeParse(input);
      if (!parsed.success) return inputError(parsed.error);
      /**
       * 요약이 먼저다 — 거절당하면 이 턴은 접지 않으므로 캐릭터북도 건드리지 않는다.
       * 길이는 위 스키마가 먼저 거르므로 여기 남는 것은 빈 문장과 낡은 브리프다.
       */
      if (!applyHistoryDigest(state, brief, parsed.data.summary)) {
        return {
          ok: false,
          message: "요약을 반영하지 못했습니다 — 빈 문장이거나 이미 접힌 구간입니다",
        };
      }
      // 등록이 기억보다 먼저다 — 새로 선 사람은 등록된 뒤에야 이 세계의 화자가 된다
      const characters = registerCharacters(state, parsed.data.characters ?? []);
      const memories = applyCharacterMemories(state, parsed.data.memories ?? []);
      // 제목은 코어가 검증한다 — 아크가 있고·활성이고·아직 이름이 없을 때만 (people.md §9)
      const titles = applyArcTitles(state, parsed.data.arcTitles ?? []);
      onApplied({ folded: true, memories, characters });
      return {
        ok: true,
        message: `요약 갱신 · 기억 ${memories} · 인물 ${characters} · 아크 제목 ${titles}`,
      };
    },
  };
}

/**
 * 밀려나는 구간을 접는다 — 턴이 저장되기 직전에 부른다 (`turn-runner.ts`).
 *
 * 접을 것이 없으면 아무 일도 하지 않는다. 한 번 다시 시도하되 **실패는 삼킨다** —
 * 그때는 접히지 않은 이력이 그대로 남아 다음 기회에 다시 판정된다.
 */
export async function compactHistory(state: GameState, llm?: GameLLM): Promise<CompactionResult> {
  const skipped = { folded: false, memories: 0, characters: 0 };
  // mock 모드에는 부를 모델이 없다 — 클라이언트를 직접 받은 호출만 그대로 돈다
  if (llm === undefined && resolveLlmMode() === "mock") return skipped;
  const brief = planHistoryFold(state);
  if (brief === null) return skipped;

  let result: CompactionResult = skipped;
  let client = llm;
  await retryOnce(
    "compactor:history",
    () =>
      requireToolCall(REPORT_DIGEST_TOOL, () => {
        client ??= createGameLLM(agentConfig("history-compactor"));
        return client.runTurn({
          system: HISTORY_COMPACTOR_SYSTEM,
          history: [],
          user: buildCompactionPrompt(state, brief, untitledArcs(state)),
          tools: [makeReportTool(state, brief, (r) => (result = r))],
          toolChoice: { name: REPORT_DIGEST_TOOL },
        });
      }),
    () => result.folded, // 이미 접혔으면 다시 부르지 않는다
  ).catch((error: unknown) => {
    // 결산 셋과 같은 계약이되 남는 것이 다르다 — 앵커가 아니라 접히지 않은 이력이다
    console.warn("[compactor:history] 압축을 건너뜁니다 — 이력이 그대로 남습니다:", error);
  });
  return result;
}
