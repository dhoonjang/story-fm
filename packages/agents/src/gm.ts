import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  advanceTime,
  applyMatchEvents,
  applyNarrativeEvent,
  applyTalkToPlayer,
  applyTeamTalk,
  buildOfficeViews,
  describeNextFixture,
  finalizeMatch,
  refreshPacket,
  setCaptain,
  setLineup,
  setPlayerInstruction,
  setTactics,
  setTrainingFocus,
  startMatch,
  substitutePlayer,
  userTeam,
  TALK_OUTCOMES,
  TEAM_TALK_OUTCOMES,
  type GameState,
} from "@story-fm/engine";
import { AnthropicGameLLM, TIERS, type GameToolSpec } from "@story-fm/llm";
import { MATCH_CASTER_SYSTEM, makeLogMatchEventsTool } from "./match-caster";
import { runMockGmTurn } from "./mock-gm";
import type { GmToolCall, GmTurnResult } from "./gm-types";

/**
 * GM 오케스트레이터 (ai-manager.md) — 단일 GM, 장면 라우팅 (결정 #12).
 * 실모드: Opus tool loop. mock 모드: 규칙 기반 (mock-gm.ts).
 * 두 모드는 같은 엔진 스킬 경로만 사용한다 — 상태 변경의 유일한 통로.
 */

export const GM_SYSTEM = `당신은 story-fm의 게임 마스터(GM)다. 유저는 프리미어리그 감독을 연기하고,
당신은 나머지 세계 전부 — 수석코치, 선수, 구단주, 기자 — 를 연기한다.

# 출력 문법 (반드시 준수)
- 화자 발화는 \`@수석코치:\` \`@<선수id>:\` \`@기자:\` 처럼 @태그로 시작한다.
- 화자 없는 내레이션은 \`@:\` 로 시작한다. 행동·연출은 *별표*.
- 모든 텍스트 줄은 @로 시작한다. GM은 감독을 절대 연기하지 않는다.

# 철칙
1. 자유 텍스트로는 게임 상태를 1비트도 바꿀 수 없다 — 모든 변경은 도구 호출.
2. 판정형 도구(team_talk, talk_to_player)의 outcome은 감독 발화의 (a) 맥락
   적합성 (b) 설득 근거 (c) 대상 성향 수용성으로 판정하라. 잘한 말은 잘
   먹혀야 한다 — 랜덤이 아니다. 변화량은 시스템이 계산한다.
3. 모호하거나 규칙 위반인 지시는 실행하지 말고 픽션 안에서 반문하라
   ("성호는 부상 중인데, 그래도 선발로 쓰시겠습니까?").
4. 도구가 오류를 돌려주면 이유에 맞게 수정하거나 감독에게 되물어라.
5. 조회 질문(명단·재정·일정)은 컨텍스트의 스냅샷으로 즉답한다 — 도구 불필요.
6. 시간은 advance_time으로만 흐른다. 대화가 길어져도 세계는 멈춰 있다.

# 진행
- 감독이 진행을 원하면 advance_time → 다이제스트를 서사 가치 순으로 골라
  보고하라 (전부 나열 금지). 경기일 도달 시 브리핑으로 마무리.
- 경기일에 감독이 준비되면 start_match. 이후 경기 장면은 별도 진행을 따른다.
- 방치된 불만 선수, 다가오는 일정 같은 긴장 요소를 자연스럽게 흘려라.

# 언어
한국어. 진지한 스포츠 드라마의 톤. 실존 인물 폄하 금지.
채팅에서는 능력치 숫자를 읊지 않는다 — 스카우트처럼 서술하라 (결정 #2).
"슈팅 84" 대신 "리그 정상급 왼발". 숫자는 오피스 뷰의 몫이다.`;

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Anthropic.Tool.InputSchema => ({ type: "object" as const, properties, required });

const str = { type: "string" };
const int = (min: number, max: number) => ({ type: "integer", minimum: min, maximum: max });

/** 실모드 GM의 스킬 도구 바인딩 — 엔진 함수를 GameToolSpec으로 감싼다 */
export function buildGmTools(state: GameState, calls: GmToolCall[]): GameToolSpec[] {
  const record = (name: string, result: { ok: boolean; message: string }) => {
    if (result.ok) calls.push({ name, summary: result.message });
    return result;
  };
  const wrap = <T>(
    name: string,
    description: string,
    inputSchema: Anthropic.Tool.InputSchema,
    schema: z.ZodType<T>,
    run: (input: T) => { ok: boolean; message: string },
  ): GameToolSpec => ({
    name,
    description,
    inputSchema,
    handle(input: unknown) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          message: `입력 오류 — ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" / ")}`,
        };
      }
      return record(name, run(parsed.data));
    },
  });

  return [
    wrap(
      "advance_time",
      "다음 경기일(next_match) 또는 지정 일수만큼 시간을 전진시킨다. 시간이 흐르는 유일한 경로.",
      obj({ until: { type: "string", enum: ["next_match"] }, days: int(1, 30) }, []),
      z.object({ until: z.literal("next_match").optional(), days: z.number().int().min(1).max(30).optional() }),
      (input) => {
        const result = advanceTime(state, input.days ? { days: input.days } : "next_match");
        return { ok: result.ok, message: result.digest.join("\n") || "진행 완료" };
      },
    ),
    wrap(
      "start_match",
      "경기일에 킥오프를 준비한다. 이후 advance_match로 경기가 진행된다.",
      obj({}, []),
      z.object({}),
      () => startMatch(state),
    ),
    wrap(
      "set_lineup",
      "선발 11명을 확정한다 (GK 1명 필수, 부상자 불가).",
      obj({ startingXI: { type: "array", items: str, minItems: 11, maxItems: 11 } }, ["startingXI"]),
      z.object({ startingXI: z.array(z.string()).length(11) }),
      (input) => setLineup(state, input),
    ),
    wrap(
      "set_captain",
      "주장을 지명한다.",
      obj({ playerId: str }, ["playerId"]),
      z.object({ playerId: z.string() }),
      (input) => setCaptain(state, input.playerId),
    ),
    wrap(
      "set_tactics",
      "팀 전술을 변경한다. 경기 중이면 다음 진행부터 반영된다.",
      obj(
        {
          formation: { type: "string", enum: ["4-4-2", "4-3-3", "4-2-3-1", "3-5-2", "5-4-1"] },
          mentality: int(1, 5),
          defensiveLine: int(1, 5),
          pressing: int(1, 5),
          tempo: int(1, 5),
          width: int(1, 5),
          passStyle: { type: "string", enum: ["short", "mixed", "direct"] },
        },
        [],
      ),
      z
        .object({
          formation: z.enum(["4-4-2", "4-3-3", "4-2-3-1", "3-5-2", "5-4-1"]),
          mentality: z.number().int().min(1).max(5),
          defensiveLine: z.number().int().min(1).max(5),
          pressing: z.number().int().min(1).max(5),
          tempo: z.number().int().min(1).max(5),
          width: z.number().int().min(1).max(5),
          passStyle: z.enum(["short", "mixed", "direct"]),
        })
        .partial(),
      (input) => {
        const result = setTactics(state, input);
        if (result.ok && state.phase === "match") refreshPacket(state);
        return result;
      },
    ),
    wrap(
      "set_player_instruction",
      "선수별 개인 지시를 준다.",
      obj({ playerId: str, note: str }, ["playerId", "note"]),
      z.object({ playerId: z.string(), note: z.string().min(1) }),
      (input) => setPlayerInstruction(state, input),
    ),
    wrap(
      "set_training_focus",
      "주간 훈련 계획(팀 테마·개인 훈련·회복조)을 정한다.",
      obj(
        {
          teamFocus: { type: "string", enum: ["set_pieces", "shooting", "defending", "passing", "fitness"] },
          individual: {
            type: "array",
            items: obj({ playerId: str, focus: { type: "string", enum: ["pace", "shooting", "passing", "dribbling", "defending", "physical"] } }, ["playerId", "focus"]),
          },
          recovery: { type: "array", items: str },
        },
        [],
      ),
      z
        .object({
          teamFocus: z.enum(["set_pieces", "shooting", "defending", "passing", "fitness"]),
          individual: z.array(
            z.object({
              playerId: z.string(),
              focus: z.enum(["pace", "shooting", "passing", "dribbling", "defending", "physical"]),
            }),
          ),
          recovery: z.array(z.string()),
        })
        .partial(),
      (input) => setTrainingFocus(state, input),
    ),
    wrap(
      "team_talk",
      "팀 전체에게 말한 감독 발화의 판정을 기록한다. outcome은 발화의 질에 대한 당신의 판정.",
      obj(
        {
          occasion: { type: "string", enum: ["pre", "half", "post", "daily"] },
          outcome: { type: "string", enum: [...TEAM_TALK_OUTCOMES] },
          intensity: int(1, 3),
        },
        ["occasion", "outcome", "intensity"],
      ),
      z.object({
        occasion: z.enum(["pre", "half", "post", "daily"]),
        outcome: z.enum(TEAM_TALK_OUTCOMES),
        intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      }),
      (input) => applyTeamTalk(state, input),
    ),
    wrap(
      "talk_to_player",
      "개인 면담 판정을 기록한다. 불만 이슈가 있으면 해소된다.",
      obj(
        {
          playerId: str,
          outcome: { type: "string", enum: [...TALK_OUTCOMES] },
          intensity: int(1, 3),
        },
        ["playerId", "outcome", "intensity"],
      ),
      z.object({
        playerId: z.string(),
        outcome: z.enum(TALK_OUTCOMES),
        intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      }),
      (input) => applyTalkToPlayer(state, input),
    ),
    wrap(
      "substitute",
      "경기 중 교체 (정지점에서만).",
      obj({ out: str, in: str }, ["out", "in"]),
      z.object({ out: z.string(), in: z.string() }),
      (input) => substitutePlayer(state, input),
    ),
    wrap(
      "apply_narrative_event",
      "서사 이벤트의 상태 반영 — 사기·폼만, 한도 내 (능력치 접근 불가).",
      obj(
        { playerIds: { type: "array", items: str }, moraleDelta: int(-5, 5), formDelta: int(-1, 1), note: str },
        ["playerIds", "note"],
      ),
      z.object({
        playerIds: z.array(z.string()),
        moraleDelta: z.number().int().min(-5).max(5).optional(),
        formDelta: z.number().int().min(-1).max(1).optional(),
        note: z.string().min(1),
      }),
      (input) => applyNarrativeEvent(state, input),
    ),
  ];
}

/** GM 컨텍스트 스냅샷 — 상태 서술의 유일한 근거 (ai-manager §4·§6) */
export function buildGmContext(state: GameState): string {
  const views = buildOfficeViews(state);
  const team = userTeam(state);
  const squadLines = views.squad.players
    .slice(0, 18)
    .map(
      (p) =>
        `${p.id} ${p.name} ${p.position} OVR${p.overall} 폼${p.form} 사기${p.morale} 피로${p.fatigue}${p.injury !== "none" ? " 부상" : ""}${p.hasIssue ? " ⚠불만" : ""} [${p.role}]`,
    );
  const recentNarrative = state.narrative.slice(-6).map((n) => `${n.date} ${n.text}`);
  return [
    `[세계 스냅샷]`,
    `날짜 ${state.date} · 시즌 ${state.season} · 리그 ${views.schedule.userPosition}위 · phase ${state.phase}`,
    describeNextFixture(state),
    `재정: 잔고 £${(state.finance.balance / 1e6).toFixed(1)}M · 주급 £${(state.finance.weeklyWages / 1e6).toFixed(1)}M/주`,
    `감독: ${state.manager.name} — 리더십${state.manager.attributes.leadership} 전술${state.manager.attributes.tactics} 협상${state.manager.attributes.negotiation} 미디어${state.manager.attributes.media}`,
    `[${team.name} 스쿼드]`,
    ...squadLines,
    `[최근 서사]`,
    ...recentNarrative,
  ].join("\n");
}

export type LlmMode = "mock" | "real";

export function resolveLlmMode(): LlmMode {
  const forced = process.env.LLM_MODE;
  if (forced === "mock" || forced === "real") return forced;
  return process.env.ANTHROPIC_API_KEY ? "real" : "mock";
}

/** 실모드 — 일상은 GM 티어, 경기 장면은 매치 캐스터 프롬프트로 라우팅 */
async function runRealGmTurn(state: GameState, message: string): Promise<GmTurnResult> {
  const calls: GmToolCall[] = [];
  const inMatch = state.phase === "match";
  const llm = new AnthropicGameLLM(inMatch ? TIERS.match : TIERS.gm);

  const tools = buildGmTools(state, calls);
  if (inMatch) {
    tools.push(
      makeLogMatchEventsTool((events) => {
        const result = applyMatchEvents(state, events);
        if (result.ok) calls.push({ name: "log_match_events", summary: result.message });
        return result;
      }),
    );
  }

  const system = inMatch ? MATCH_CASTER_SYSTEM : GM_SYSTEM;
  const ledger = state.pendingMatch?.ledger;
  const context = inMatch
    ? [
        `[전력 분석 패킷]`,
        JSON.stringify(state.pendingMatch?.packet),
        `[경기 장부]`,
        `스코어 ${ledger?.score.home}:${ledger?.score.away} · ${ledger?.minute}′ · ${ledger?.phase}`,
        `홈 온필드: ${ledger?.home.onPitch.join(", ")}`,
        `홈 벤치: ${ledger?.home.bench.join(", ")} (교체 ${ledger?.home.subsUsed}/5, 기회 ${ledger?.home.subWindows}/3)`,
        `어웨이 온필드: ${ledger?.away.onPitch.join(", ")}`,
        `어웨이 벤치: ${ledger?.away.bench.join(", ")} (교체 ${ledger?.away.subsUsed}/5)`,
        (ledger?.sentOff.length ?? 0) > 0 ? `퇴장: ${ledger?.sentOff.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    : buildGmContext(state);

  // 일상 GM의 대화 연속성 — 최근 채팅을 이력으로 재구성 (리뷰 발견: 이력 미전달)
  const history = inMatch
    ? ((state.pendingMatch?.casterHistory ?? []) as never)
    : (state.chat.slice(-12, -1).map((turn) => ({
        role: turn.role === "user" ? ("user" as const) : ("assistant" as const),
        content: turn.text,
      })) as never);

  const result = await llm.runTurn({
    system,
    history,
    user: `${context}\n\n[감독]\n${message}`,
    tools,
  });

  if (inMatch && state.pendingMatch) {
    state.pendingMatch.casterHistory = result.history as unknown[];
    if (state.pendingMatch.ledger.phase === "finished") {
      const digest = finalizeMatch(state);
      calls.push({ name: "finalize_match", summary: digest.join(" · ") });
    }
  }
  return { text: result.text, toolCalls: calls };
}

/** GM 턴 실행 — 모드 자동 해석 (env LLM_MODE 우선) */
export async function runGmTurn(state: GameState, message: string): Promise<GmTurnResult> {
  if (resolveLlmMode() === "mock") return runMockGmTurn(state, message);
  return runRealGmTurn(state, message);
}
