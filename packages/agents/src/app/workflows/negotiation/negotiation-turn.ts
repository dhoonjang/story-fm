import { compactNegotiationHistory } from "./negotiation-compactor";
export { compactNegotiationHistory } from "./negotiation-compactor";
import { CharacterUpdateSchema, type NegotiationChannel } from "@story-fm/domain";
import {
  stampLorebook,
  journal,
  type JournalEntry,
  repairNegotiationSquads,
  actNegotiation,
  appendNegotiationMessage,
  requestCharacterUpdate,
  managedTeamId,
  addDays,
  directorOf,
  agentForPlayer,
  personaBookOf,
  type GameState,
} from "@story-fm/engine";
import { agentConfig, createGameLLM, type GameLLM, type GameToolSpec } from "@story-fm/llm";
import { ModelOutputError, retryOnce } from "../../../common/retry";
import { inputError } from "../../../common/tool-schema";
import {
  NEGOTIATION_GM_SYSTEM,
  NEGOTIATION_ACTION_INPUT,
  NEGOTIATION_CHARACTER_INPUT,
  NEGOTIATION_SCHEDULE_INPUT,
  NegotiationToolInputSchema,
  ScheduleReplySchema,
  negotiationHistory,
} from "../../../negotiation/negotiation-gm";
import {
  negotiationLorebookEntries,
  negotiationReference,
  negotiationSnapshot,
} from "../../../negotiation/context";
import { mockNegotiationLlm } from "./mock-negotiation";

/** A failed provider/tool loop commits neither partial consent nor character jobs. */
export async function runNegotiationTurn(
  state: GameState,
  id: string,
  channel: NegotiationChannel = "internal",
  message?: string,
  llm?: GameLLM,
  stagedJournal?: JournalEntry[],
): Promise<{ ok: boolean; message: string }> {
  if (!state.negotiations.some((n) => n.id === id && n.status === "open"))
    return { ok: false, message: "진행 중인 협상을 찾을 수 없습니다" };
  const draft = structuredClone(state);
  await compactNegotiationHistory(draft, id);
  const n = draft.negotiations.find((n) => n.id === id)!;
  const tools: GameToolSpec[] = [
    {
      name: "negotiation_action",
      description:
        "정확한 제안을 초안·발송·수락·거절하고 메디컬·확인·서명·철회를 검증된 당사자로 수행한다. 유저 구단에는 초안만 가능하다.",
      inputSchema: NEGOTIATION_ACTION_INPUT,
      handle(raw) {
        const parsed = NegotiationToolInputSchema.safeParse(raw);
        if (!parsed.success) return inputError(parsed.error);
        if (["open", "read", "message"].includes(parsed.data.action.kind))
          return { ok: false, message: "협상 응답 도구에서 이 행동은 지원하지 않습니다" };
        const result = actNegotiation(draft, id, parsed.data.action, {
          kind: "model",
          partyId: parsed.data.partyId,
        });
        return {
          ...result,
          message: JSON.stringify({
            result: result.message,
            status: n.status,
            drafts: n.drafts,
            proposals: n.proposals.filter((p) => p.status === "open"),
            medical: n.medical,
            signed: n.signed,
          }),
        };
      },
    },
    {
      name: "update_character",
      description: "인물의 새 기억을 기존 비동기 로어북 편집자에게 직접 요청한다.",
      inputSchema: NEGOTIATION_CHARACTER_INPUT,
      handle(raw) {
        const parsed = CharacterUpdateSchema.safeParse(raw);
        return parsed.success
          ? requestCharacterUpdate(draft, parsed.data)
          : inputError(parsed.error);
      },
    },
    {
      name: "schedule_reply",
      description: "후속 답변을 오늘보다 이후의 게임 날짜로 예약한다.",
      inputSchema: NEGOTIATION_SCHEDULE_INPUT,
      handle(raw) {
        const parsed = ScheduleReplySchema.safeParse(raw);
        if (!parsed.success) return inputError(parsed.error);
        if (parsed.data.on <= draft.date || parsed.data.on > addDays(draft.date, 30))
          return { ok: false, message: "답변은 다음 30일 안의 미래 날짜여야 합니다" };
        n.nextReplyOn = parsed.data.on;
        return { ok: true, message: `${n.nextReplyOn} 답변 예약` };
      },
    },
  ];
  const counterparts = [
    directorOf(draft, n.buyerId),
    ...(n.kind === "transfer" ? [directorOf(draft, n.sellerId)] : []),
    agentForPlayer(draft, n.playerId),
    ...draft.personas.filter(
      (p) => p.role === "owner" && [n.buyerId, n.sellerId].includes(draft.userTeamId),
    ),
  ]
    .filter((p) => p !== null)
    .map((p) => ({
      id: "lorebookId" in p ? p.lorebookId : `person:${p.characterId}`,
      name: p.name,
      information: personaBookOf(draft, p).information,
    }));
  const config = agentConfig("negotiation-gm");
  const client = llm ?? mockNegotiationLlm(config, draft, n) ?? createGameLLM(config);
  const records: JournalEntry[] = [];
  let touched = false;
  for (const tool of tools) {
    const handle = tool.handle;
    tool.handle = async (raw, context) => {
      const outcome = await handle(raw, context);
      records.push({
        kind: "command",
        name: tool.name,
        input: { negotiationId: id, request: raw },
        ok: outcome.ok,
        message: outcome.message,
        source: "tool",
      });
      if (outcome.ok) touched = true;
      return outcome;
    };
  }
  const result = await retryOnce(
    "negotiation-gm",
    async () => {
      const result = await client.runTurn({
        system: [
          NEGOTIATION_GM_SYSTEM,
          negotiationReference(
            n,
            stampLorebook(draft, negotiationLorebookEntries(draft, n, counterparts)),
            counterparts,
          ),
        ],
        history: negotiationHistory(n),
        user: message ?? `[${channel}] 현재 협상 장부와 예정된 답변에 반응하세요.`,
        stateNote: negotiationSnapshot(draft, n),
        tools,
      });
      if (result.stopReason === "truncated" || !result.text.trim() || result.text.length > 20000)
        throw new ModelOutputError("협상 답변이 완성되지 않았습니다");
      return result;
    },
    () => touched,
  );
  const managed = managedTeamId(draft);
  const userInvolved = [n.buyerId, n.sellerId].includes(managed ?? "");
  appendNegotiationMessage(
    draft,
    n,
    channel,
    "gm",
    result.text,
    channel === "internal"
      ? userInvolved
        ? managed
        : n.buyerId
      : channel === "player"
        ? n.playerId
        : managed === n.sellerId
          ? n.buyerId
          : n.sellerId,
  );
  if (n.status === "open" && (!n.nextReplyOn || n.nextReplyOn <= draft.date)) {
    const managed = managedTeamId(draft);
    n.nextReplyOn = [n.buyerId, n.sellerId].includes(managed ?? "") ? null : addDays(draft.date, 1);
  }
  n.revision += 1;
  if (n.status === "completed") repairNegotiationSquads(draft, [n.sellerId]);
  Object.assign(state, draft);
  if (stagedJournal) stagedJournal.push(...records);
  else for (const record of records) journal(record);
  return { ok: true, message: result.text };
}
