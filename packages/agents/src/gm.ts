import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  advanceTime,
  applyMatchEvents,
  applyNarrativeEvent,
  applyTalkToPlayer,
  applyTeamTalk,
  computeStandings,
  dayOfWeek,
  describeNextFixture,
  describeWindowState,
  financeOf,
  finalizeMatch,
  humanizePlayerIds,
  isSuspended,
  leagueView,
  openInjury,
  playerCard,
  playerName,
  refreshPacket,
  acceptDeal,
  answerIncomingOffer,
  dealOdds,
  describeNegotiation,
  describeNegotiations,
  describeOdds,
  expiringContracts,
  openRenewal,
  respondOffer,
  scoutPlayer,
  scoutingSummary,
  sendOffer,
  suggestTerms,
  withdrawOffer,
  searchPlayers,
  setCaptain,
  setLineup,
  setPlayerInstruction,
  setTactics,
  setTraining,
  squadFamiliarity,
  startMatch,
  substitutePlayer,
  tacticsOf,
  teamName,
  teamProfile,
  userPlayers,
  weeklyWagesOf,
  TALK_OUTCOMES,
  TEAM_TALK_OUTCOMES,
  type GameState,
} from "@story-fm/engine";
import { naturalPositionOf, slotOfTime, ATTRIBUTE_AXES } from "@story-fm/domain";
import { AnthropicGameLLM, TIERS, type GameLLM, type GameToolSpec } from "@story-fm/llm";
import { MATCH_CASTER_SYSTEM, makeLogMatchEventsTool } from "./match-caster";
import { buildOnboardingTurn, runMockGmTurn } from "./mock-gm";
import { resolveSystemPrompts } from "./prompt-store";
import { resolveSkillDescriptions } from "./skill-descriptions";
import type { GmToolCall, GmTurnResult } from "./gm-types";

/**
 * GM 오케스트레이터 (ai-manager.md) — 단일 GM, 장면 라우팅 (결정 #12).
 * 실모드: Opus tool loop. mock 모드: 규칙 기반 (mock-gm.ts).
 * 두 모드는 같은 엔진 스킬 경로만 사용한다 — 상태 변경의 유일한 통로.
 */

export const GM_SYSTEM = `당신은 스토리 기반 풋볼 매니저의 게임 마스터(GM)다. 유저는 축구팀 감독을 연기하고,
당신은 나머지 세계 전부 — 수석코치, 선수, 구단주, 기자 — 를 연기한다.

# 출력 문법 (반드시 준수)
- 화자 발화는 \`@수석코치:\` \`@손흥민:\` \`@기자:\` 처럼 @태그로 시작한다.
  선수 화자는 반드시 한글 이름을 쓴다 — id(예: tottenham-son) 금지.
- 화자 없는 내레이션은 \`@:\` 로 시작한다. 행동·연출은 *별표*.
- 모든 텍스트 줄은 @로 시작한다. GM은 감독을 절대 연기하지 않는다.
- 서사·대사에서 선수는 항상 이름으로 지칭한다. 선수 id는 도구 호출의
  입력값에만 쓴다.

# 철칙
1. 판정형 도구(team_talk, talk_to_player)의 outcome은 감독 발화의 (a) 맥락 적합성 (b) 설득 근거 (c) 대상 성향 수용성으로 판정하라. 말을 잘했을 때 좋은 변화가 발생해야한다.
2. 모호하거나 규칙 위반인 지시는 실행하지 말고 픽션 안에서 반문하라. 예) "@수석코치: 성호는 부상 중인데, 그래도 선발로 쓰시겠습니까?".
3. **모르는 것을 지어내지 마라.** 주어지는 것은 스쿼드 명부(id·이름·주포지션)와 상태 요약뿐이다. 그 밖의 사실 — 능력치·컨디션·계약·성장, 타 팀 선수, 순위표, 지난·앞으로의 일정 — 은 반드시 조회 도구로 확인한 뒤 답하라. 기억이나 인상으로 수치·이름을 만들어내는 것은 절대 하면 안된다.
4. 시간은 advance_time으로만 흐른다. 대화에 따라 시간이 적절히 흐르도록 advance_time을 사용해라.
5. **이적 협상의 판정은 확률에 근거하라.** 금액을 논하기 전에 deal_odds로 성사 확률과 근거를 확인하고, 감독에게는 그 근거를 말로 풀어 전하라("상대는 4200만을 기대합니다"). 우리 오퍼에 답할 때(respond_offer)는 **상대 구단 단장이 되어** 그 확률대로 판정하라 — 확률이 높으면 대체로 받아들이고, 낮으면 역제안하거나 거절한다. 확률을 무시한 판정은 하지 않는다.

# 진행
- 감독이 진행을 원하면 advance_time 을 사용하고 그동안 진행된 일들 중 중요한 내용을 골라서 보고하라.
- 방치된 불만 선수, 다가오는 일정 같은 긴장 요소를 자연스럽게 흘려라.

# 언어
한국어. 진지한 스포츠 드라마의 톤.
채팅에서는 능력치 숫자를 읊지 않는다 — 스카우트처럼 서술하라.
"슈팅 84" 대신 "리그 정상급 왼발".`;

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Anthropic.Tool.InputSchema => ({ type: "object" as const, properties, required });

const str = { type: "string" };
const int = (min: number, max: number) => ({ type: "integer", minimum: min, maximum: max });

// 훈련 세션 스키마 (set_training) — 자유 label + focus 대상
const TRAIN_FOCUS = [...ATTRIBUTE_AXES, "tactical", "recovery"] as const;
const SLOT_ENUM = { type: "string", enum: ["am", "pm"] } as const;
const FOCUS_ARRAY = { type: "array", items: { type: "string", enum: [...TRAIN_FOCUS] } } as const;

/** 실모드 GM의 스킬 도구 바인딩 — 엔진 함수를 GameToolSpec으로 감싼다 */
export function buildGmTools(state: GameState, calls: GmToolCall[]): GameToolSpec[] {
  const descriptions = resolveSkillDescriptions().descriptions;
  const record = (name: string, result: { ok: boolean; message: string }, input?: unknown) => {
    if (result.ok) calls.push({ name, summary: result.message, input });
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
      return record(name, run(parsed.data), parsed.data);
    },
  });

  /**
   * 읽기 전용 조회 도구 — 상태를 바꾸지 않으므로 호출을 기록하지 않는다
   * (채팅이 조회 로그로 덮이면 감독이 정작 중요한 스킬 칩을 놓친다).
   */
  const read = <T>(
    name: string,
    description: string,
    inputSchema: Anthropic.Tool.InputSchema,
    schema: z.ZodType<T>,
    run: (input: T) => { ok: boolean; message: string },
  ): GameToolSpec => ({
    name,
    description,
    inputSchema,
    readOnly: true,
    handle(input: unknown) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          message: `입력 오류 — ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" / ")}`,
        };
      }
      return run(parsed.data);
    },
  });

  return [
    wrap(
      "advance_time",
      descriptions.advance_time,
      obj({ until: { type: "string", enum: ["next_match"] }, days: int(1, 30) }, []),
      z.object({
        until: z.literal("next_match").optional(),
        days: z.number().int().min(1).max(30).optional(),
      }),
      (input) => {
        const result = advanceTime(state, input.days ? { days: input.days } : "next_match");
        return { ok: result.ok, message: result.digest.join("\n") || "진행 완료" };
      },
    ),
    wrap("start_match", descriptions.start_match, obj({}, []), z.object({}), () =>
      startMatch(state),
    ),
    wrap(
      "set_lineup",
      descriptions.set_lineup,
      obj(
        {
          starting: {
            type: "array",
            minItems: 11,
            maxItems: 11,
            items: {
              type: "object",
              properties: { playerId: str, position: str },
              required: ["playerId"],
            },
          },
          bench: {
            type: "array",
            items: {
              type: "object",
              properties: { playerId: str, position: str },
              required: ["playerId"],
            },
          },
        },
        ["starting"],
      ),
      z.object({
        starting: z
          .array(z.object({ playerId: z.string(), position: z.string().optional() }))
          .length(11),
        bench: z
          .array(z.object({ playerId: z.string(), position: z.string().optional() }))
          .optional(),
      }),
      (input) => setLineup(state, input),
    ),
    wrap(
      "set_captain",
      descriptions.set_captain,
      obj({ playerId: str }, ["playerId"]),
      z.object({ playerId: z.string() }),
      (input) => setCaptain(state, input.playerId),
    ),
    wrap(
      "set_tactics",
      descriptions.set_tactics,
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
      descriptions.set_player_instruction,
      obj({ playerId: str, note: str }, ["playerId", "note"]),
      z.object({ playerId: z.string(), note: z.string().min(1) }),
      (input) => setPlayerInstruction(state, input),
    ),
    wrap(
      "set_training",
      descriptions.set_training,
      obj(
        {
          sessions: {
            type: "array",
            items: {
              type: "object",
              properties: { date: str, slot: SLOT_ENUM, label: str, focus: FOCUS_ARRAY },
              required: ["date", "slot", "label", "focus"],
            },
          },
          repeatWeekly: {
            type: "array",
            items: {
              type: "object",
              properties: {
                dow: int(0, 6),
                slot: SLOT_ENUM,
                label: str,
                focus: FOCUS_ARRAY,
              },
              required: ["dow", "slot", "label", "focus"],
            },
          },
          weeks: int(1, 20),
          clear: {
            type: "object",
            properties: { from: str, dow: int(0, 6), slot: SLOT_ENUM },
          },
        },
        [],
      ),
      z
        .object({
          sessions: z.array(
            z.object({
              date: z.string(),
              slot: z.enum(["am", "pm"]),
              label: z.string().min(1),
              focus: z.array(z.enum(TRAIN_FOCUS)),
            }),
          ),
          repeatWeekly: z.array(
            z.object({
              dow: z.number().int().min(0).max(6),
              slot: z.enum(["am", "pm"]),
              label: z.string().min(1),
              focus: z.array(z.enum(TRAIN_FOCUS)),
            }),
          ),
          weeks: z.number().int().min(1).max(20),
          clear: z.object({
            from: z.string().optional(),
            dow: z.number().int().min(0).max(6).optional(),
            slot: z.enum(["am", "pm"]).optional(),
          }),
        })
        .partial(),
      (input) => setTraining(state, input),
    ),
    wrap(
      "team_talk",
      descriptions.team_talk,
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
      descriptions.talk_to_player,
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
      descriptions.substitute,
      obj({ out: str, in: str }, ["out", "in"]),
      z.object({ out: z.string(), in: z.string() }),
      (input) => substitutePlayer(state, input),
    ),
    wrap(
      "apply_narrative_event",
      descriptions.apply_narrative_event,
      obj(
        {
          playerIds: { type: "array", items: str },
          moraleDelta: int(-5, 5),
          formDelta: int(-1, 1),
          note: str,
        },
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

    // ── 조회 (읽기 전용) — 컨텍스트에 없는 사실은 전부 여기로 ──
    read(
      "search_players",
      descriptions.search_players,
      obj(
        {
          team: str,
          position: str,
          name: str,
          minAge: int(15, 45),
          maxAge: int(15, 45),
          availableOnly: { type: "boolean" },
          sortBy: { type: "string", enum: ["rating", "age", "fatigue", "goals", "wage"] },
          limit: int(1, 15),
        },
        [],
      ),
      z
        .object({
          team: z.string(),
          position: z.string(),
          name: z.string(),
          minAge: z.number().int().min(15).max(45),
          maxAge: z.number().int().min(15).max(45),
          availableOnly: z.boolean(),
          sortBy: z.enum(["rating", "age", "fatigue", "goals", "wage"]),
          limit: z.number().int().min(1).max(15),
        })
        .partial(),
      (input) => searchPlayers(state, input),
    ),
    read(
      "get_player",
      descriptions.get_player,
      obj({ playerId: str }, ["playerId"]),
      z.object({ playerId: z.string().min(1) }),
      (input) => playerCard(state, input.playerId),
    ),
    read(
      "get_team",
      descriptions.get_team,
      obj({ team: str }, ["team"]),
      z.object({ team: z.string().min(1) }),
      (input) => teamProfile(state, input.team),
    ),
    read(
      "get_league",
      descriptions.get_league,
      obj(
        {
          view: { type: "string", enum: ["standings", "fixtures"] },
          team: str,
          count: int(1, 10),
        },
        ["view"],
      ),
      z.object({
        view: z.enum(["standings", "fixtures"]),
        team: z.string().optional(),
        count: z.number().int().min(1).max(10).optional(),
      }),
      (input) => leagueView(state, input),
    ),
    wrap(
      "scout_player",
      descriptions.scout_player,
      obj({ playerId: str }, ["playerId"]),
      z.object({ playerId: z.string().min(1) }),
      (input) => scoutPlayer(state, input.playerId),
    ),

    // ── 이적 협상 — 확률은 코어가, 판정은 GM이 (docs/design/transfers.md) ──
    read(
      "deal_odds",
      descriptions.deal_odds,
      obj(
        {
          playerId: str,
          fee: int(0, 500_000_000),
          weeklyWage: int(0, 2_000_000),
          years: int(1, 6),
          kind: { type: "string", enum: ["buy", "sell"] },
        },
        ["playerId"],
      ),
      z.object({
        playerId: z.string().min(1),
        fee: z.number().min(0).optional(),
        weeklyWage: z.number().min(0).optional(),
        years: z.number().int().min(1).max(6).optional(),
        kind: z.enum(["buy", "sell"]).optional(),
      }),
      (input) => {
        // 금액을 말하지 않았으면 기본값(요구액·주급 기대치)으로 본다
        const suggested = suggestTerms(state, input.playerId);
        if (!suggested) return { ok: false, message: `"${input.playerId}" 선수를 찾지 못했습니다` };
        const odds = dealOdds(state, {
          ...suggested,
          ...(input.fee !== undefined ? { fee: input.fee } : {}),
          ...(input.weeklyWage !== undefined ? { weeklyWage: input.weeklyWage } : {}),
          ...(input.years !== undefined ? { years: input.years } : {}),
          ...(input.kind ? { kind: input.kind } : {}),
        });
        return { ok: true, message: describeOdds(odds) };
      },
    ),
    read(
      "list_negotiations",
      descriptions.list_negotiations,
      obj({ negotiationId: str }, []),
      z.object({ negotiationId: z.string().min(1).optional() }),
      (input) => ({
        ok: true,
        message: input.negotiationId
          ? describeNegotiation(state, input.negotiationId)
          : describeNegotiations(state),
      }),
    ),
    wrap(
      "send_offer",
      descriptions.send_offer,
      obj(
        {
          playerId: str,
          fee: int(0, 500_000_000),
          weeklyWage: int(0, 2_000_000),
          years: int(1, 6),
        },
        ["playerId", "fee", "weeklyWage"],
      ),
      z.object({
        playerId: z.string().min(1),
        fee: z.number().min(0),
        weeklyWage: z.number().min(0),
        years: z.number().int().min(1).max(6).optional(),
      }),
      (input) =>
        sendOffer(state, {
          playerId: input.playerId,
          fee: input.fee,
          weeklyWage: input.weeklyWage,
          years: input.years ?? 4,
        }),
    ),
    wrap(
      "respond_offer",
      descriptions.respond_offer,
      obj(
        {
          negotiationId: str,
          verdict: { type: "string", enum: ["accept", "counter", "reject"] },
          fee: int(0, 500_000_000),
          weeklyWage: int(0, 2_000_000),
          note: str,
        },
        ["negotiationId", "verdict"],
      ),
      z.object({
        negotiationId: z.string().min(1),
        verdict: z.enum(["accept", "counter", "reject"]),
        fee: z.number().min(0).optional(),
        weeklyWage: z.number().min(0).optional(),
        note: z.string().max(200).optional(),
      }),
      (input) => respondOffer(state, input),
    ),
    wrap(
      "answer_incoming_offer",
      descriptions.answer_incoming_offer,
      obj(
        {
          negotiationId: str,
          verdict: { type: "string", enum: ["accept", "counter", "reject"] },
          fee: int(0, 500_000_000),
        },
        ["negotiationId", "verdict"],
      ),
      z.object({
        negotiationId: z.string().min(1),
        verdict: z.enum(["accept", "counter", "reject"]),
        fee: z.number().min(0).optional(),
      }),
      (input) => answerIncomingOffer(state, input),
    ),
    wrap(
      "accept_deal",
      descriptions.accept_deal,
      obj({ negotiationId: str }, ["negotiationId"]),
      z.object({ negotiationId: z.string().min(1) }),
      (input) => acceptDeal(state, input.negotiationId),
    ),
    wrap(
      "open_renewal",
      descriptions.open_renewal,
      obj({ playerId: str, weeklyWage: int(0, 2_000_000), years: int(1, 6) }, [
        "playerId",
        "weeklyWage",
        "years",
      ]),
      z.object({
        playerId: z.string().min(1),
        weeklyWage: z.number().min(0),
        years: z.number().int().min(1).max(6),
      }),
      (input) => openRenewal(state, input),
    ),
    wrap(
      "withdraw_offer",
      descriptions.withdraw_offer,
      obj({ negotiationId: str }, ["negotiationId"]),
      z.object({ negotiationId: z.string().min(1) }),
      (input) => withdrawOffer(state, input.negotiationId),
    ),
  ];
}

/**
 * 레퍼런스 블록 — **캐시되는 시스템 블록**. 감독 프로필 + 우리 팀 선수 명부.
 *
 * 능력치·컨디션은 일부러 넣지 않는다. GM이 매 턴 필요한 건 "누가 우리 팀에
 * 있고 도구에 어떤 id를 넣어야 하는가"이고, 상세는 조회 도구가 준다.
 * 정렬은 (포지션, id)로 고정한다 — OVR처럼 훈련으로 바뀌는 값으로 정렬하면
 * 순서가 흔들려 캐시 프리픽스가 매 턴 깨진다.
 */
export function buildGmReference(state: GameState): string {
  const rows = userPlayers(state)
    .map((p) => ({ p, pos: naturalPositionOf(p).position }))
    .sort((a, b) => (a.pos === b.pos ? (a.p.id < b.p.id ? -1 : 1) : a.pos < b.pos ? -1 : 1))
    .map(({ p, pos }) => `${p.id}|${p.name}|${pos}${p.isCaptain ? "|주장" : ""}`);
  const m = state.manager;
  return [
    `[감독 프로필]`,
    `이름: ${m.name}`,
    `배경: ${m.background}`,
    `능력: 리더십${m.attributes.leadership} 전술${m.attributes.tactics} 협상${m.attributes.negotiation} 미디어${m.attributes.media}`,
    `평판: 보드${m.reputation.board} 미디어${m.reputation.media} 선수단${m.reputation.squad}`,
    `감독 발화 화자 형식: @${m.name}: <발화> — 당신은 이 화자를 대신 연기하지 않는다.`,
    ``,
    `[${teamName(state.userTeamId)} 선수 명부] id|이름|주포지션 — 도구 입력엔 id, 서사엔 이름을 쓴다`,
    ...rows,
    ``,
    `이 명부에 능력치는 없다. 수치·컨디션·계약이 필요하면 get_player / search_players를 호출하라.`,
  ].join("\n");
}

/** 유저의 자연어를 모델이 읽는 감독 화자 형식으로 감싼다. */
export function buildManagerMessage(state: GameState, message: string): string {
  return `@${state.manager.name}: ${message}`;
}

/** 경기 캐시 레퍼런스 — 감독 화자 식별 + 현재 전력 분석 패킷. */
export function buildMatchReference(state: GameState): string {
  return [
    `[감독]`,
    `이름: ${state.manager.name}`,
    `감독 발화 화자 형식: @${state.manager.name}: <발화>`,
    ``,
    `[전력 분석 패킷 — 킥오프 시점 고정]`,
    JSON.stringify(state.pendingMatch?.packet),
  ].join("\n");
}

const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];

/**
 * 상태 스냅샷 — **매 턴 새로 주입되는 휘발성 블록** (role:"system" 오퍼레이터 채널).
 * 날짜·국면·전술·재정·주의 신호처럼 "지금 이 순간"만 담는다.
 * phase 같은 내부 enum은 넣지 않는다 — 라우팅용 값이지 모델이 읽을 정보가 아니다.
 */
export function buildGmStateNote(state: GameState): string {
  const standings = computeStandings(state);
  const rank = standings.findIndex((r) => r.teamId === state.userTeamId) + 1;
  const tac = tacticsOf(state, state.userTeamId).spec;
  const finance = financeOf(state, state.userTeamId);
  const players = userPlayers(state);

  const injured = players
    .map((p) => {
      const inj = openInjury(state, p.id);
      return inj ? `${p.name} ${inj.bodyPart}~${inj.expectedReturn}` : null;
    })
    .filter((x): x is string => x !== null);
  const suspended = players.filter((p) => isSuspended(state, p.id)).map((p) => p.name);
  const unhappy = state.issues.map((i) => playerName(state, i.gamePlayerId));

  const training = state.schedule
    .filter((e) => e.type === "training" && e.status === "scheduled" && e.date >= state.date)
    .slice(0, 3)
    .map((e) => {
      const s = state.trainingSessions.find((x) => x.id === e.refId);
      return `${e.date.slice(5)} ${slotOfTime(e.time) === "am" ? "오전" : "오후"} ${s?.label ?? "훈련"}`;
    });
  const trainingCount = state.schedule.filter(
    (e) => e.type === "training" && e.status === "scheduled" && e.date >= state.date,
  ).length;

  const alerts = [
    injured.length > 0 ? `부상 ${injured.length} (${injured.join(", ")})` : null,
    suspended.length > 0 ? `정지 ${suspended.length} (${suspended.join(", ")})` : null,
    unhappy.length > 0 ? `불만 ${unhappy.length} (${unhappy.join(", ")})` : null,
    ...scoutingSummary(state),
    // 만료 임박 계약 — 재계약 서사의 씨앗. 놓치면 자유계약으로 떠난다
    (() => {
      const expiring = expiringContracts(state, 180);
      return expiring.length > 0
        ? `계약 만료 임박 ${expiring.length} (${expiring
            .slice(0, 3)
            .map((row) => `${row.player.name}~${row.contract.until}`)
            .join(", ")}${expiring.length > 3 ? " …" : ""})`
        : null;
    })(),
  ].filter((x): x is string => x !== null);

  const lines = [
    `[상태 스냅샷 — 이 블록은 매 턴 갱신된다]`,
    `${state.date} (${DOW_KO[dayOfWeek(state.date)]}) · 시즌 ${state.season} · 리그 ${rank || "-"}위 · ${describeWindowState(state)}`,
    describeNextFixture(state),
    `전술: ${tac.formation} · 멘탈${tac.mentality} 라인${tac.defensiveLine} 압박${tac.pressing} 템포${tac.tempo} 폭${tac.width} 패스${tac.passStyle} · 선발 평균 적응 ${Math.round(squadFamiliarity(state, state.userTeamId))}`,
    `재정: 잔고 £${(finance.balance / 1e6).toFixed(1)}M · 주급 £${(weeklyWagesOf(state, state.userTeamId) / 1e6).toFixed(2)}M/주 · 이적예산 £${(finance.transferBudget / 1e6).toFixed(1)}M`,
    trainingCount > 0
      ? `예정 훈련 ${trainingCount}건: ${training.join(" / ")}${trainingCount > training.length ? " …" : ""}`
      : `예정 훈련 없음 — 감독이 지시해야 등록된다`,
    alerts.length > 0 ? `주의: ${alerts.join(" · ")}` : `주의: 없음`,
  ];
  // 협상은 있을 때만 — 없으면 한 줄도 쓰지 않는다 (매 턴 정가로 읽히는 블록이다)
  const negotiations = describeNegotiations(state);
  if (!negotiations.startsWith("진행 중인 협상 없음")) {
    lines.push(`협상:\n${negotiations}`);
  }
  const recent = state.narrative.slice(-4).map((n) => `${n.date} ${n.text}`);
  if (recent.length > 0) lines.push(`최근 사건: ${recent.join(" / ")}`);
  return lines.join("\n");
}

/** 경기 장부 스냅샷 — 매 턴 갱신되는 휘발성 블록 (패킷은 캐시 블록으로 따로 간다) */
export function buildLedgerNote(state: GameState): string {
  const ledger = state.pendingMatch?.ledger;
  if (!ledger) return "";
  const withNames = (ids: readonly string[] | undefined): string =>
    (ids ?? []).map((id) => `${id}(${playerName(state, id)})`).join(", ");
  return [
    `[경기 장부 — 매 턴 갱신]`,
    `스코어 ${ledger.score.home}:${ledger.score.away} · ${ledger.minute}′ · ${ledger.phase}`,
    `홈 온필드: ${withNames(ledger.home.onPitch)}`,
    `홈 벤치: ${withNames(ledger.home.bench)} (교체 ${ledger.home.subsUsed}/5, 기회 ${ledger.home.subWindows}/3)`,
    `어웨이 온필드: ${withNames(ledger.away.onPitch)}`,
    `어웨이 벤치: ${withNames(ledger.away.bench)} (교체 ${ledger.away.subsUsed}/5)`,
    ledger.sentOff.length > 0 ? `퇴장: ${withNames(ledger.sentOff)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 대화 이력 창 — 시작점을 STEP 단위로만 옮긴다.
 * 매 턴 한 칸씩 미끄러지면 프리픽스가 계속 달라져 이력 캐시가 한 번도 적중하지
 * 않는다. STEP턴 동안 시작점을 고정하면 그 구간 내내 캐시가 살아 있다.
 */
const HISTORY_KEEP = 12;
const HISTORY_STEP = 6;

export function buildGmHistory(
  state: GameState,
): Array<{ role: "user" | "assistant"; content: string }> {
  const upto = Math.max(0, state.chat.length - 1); // 방금 push된 이번 발화는 제외
  const start = Math.max(
    0,
    Math.floor(Math.max(0, upto - HISTORY_KEEP) / HISTORY_STEP) * HISTORY_STEP,
  );
  return state.chat.slice(start, upto).map((turn) => ({
    role: turn.role === "user" ? ("user" as const) : ("assistant" as const),
    content: turn.role === "user" ? buildManagerMessage(state, turn.text) : turn.text,
  }));
}

export type LlmMode = "mock" | "real";

export function resolveLlmMode(): LlmMode {
  const forced = process.env.LLM_MODE;
  if (forced === "mock" || forced === "real") return forced;
  return process.env.ANTHROPIC_API_KEY ? "real" : "mock";
}

const ONBOARDING_INSTRUCTION = [
  `[오퍼레이터 지시 — 새 게임 첫 장면]`,
  `지금은 감독의 부임 첫날이다. 아래 상태와 레퍼런스를 바탕으로 매번 새롭게 4~7줄의 도입 장면을 써라.`,
  `- 구단의 공간·날씨·현장 분위기 중 하나로 짧게 시작하고, 이전과 같은 상투적 문구를 반복하지 마라.`,
  `- @수석코치가 자신을 소개하되 감독의 배경을 그대로 길게 인용하지 말고 자연스럽게 반영하라.`,
  `- 여름 이적시장 또는 프리시즌, 스쿼드에서 확인되는 인물, 다음 경기 중 최소 두 가지를 짚어라.`,
  `- 마지막은 훈련·전술·선수단 점검·이적 중 무엇부터 할지 감독에게 열린 질문을 던져라.`,
  `- 감독의 대사나 속마음을 대신 쓰지 말고, 도구를 호출하거나 상태를 바꾸지 마라.`,
].join("\n");

function isValidOnboardingText(state: GameState, text: string): boolean {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return (
    lines.length >= 3 &&
    lines.length <= 12 &&
    lines.every((line) => line.startsWith("@")) &&
    lines.some((line) => line.startsWith("@수석코치:")) &&
    !lines.some((line) => line.startsWith(`@${state.manager.name}:`))
  );
}

/**
 * 새 게임 첫 장면.
 * 실모드는 현재 어드민 GM 프롬프트로 매번 생성하고, mock/호출 실패/문법 위반은
 * 시드 기반 규칙 장면으로 폴백해 새 게임 생성 자체가 실패하지 않게 한다.
 */
export async function runOnboardingTurn(state: GameState, llm?: GameLLM): Promise<GmTurnResult> {
  const fallback = buildOnboardingTurn(state);
  if (resolveLlmMode() === "mock") return fallback;

  try {
    const activePrompts = resolveSystemPrompts({
      gm: GM_SYSTEM,
      match: MATCH_CASTER_SYSTEM,
    }).prompts;
    const result = await (llm ?? new AnthropicGameLLM(TIERS.gm)).runTurn({
      system: [activePrompts.gm, buildGmReference(state)],
      history: [],
      user: buildManagerMessage(state, "*새 감독으로서 구단에 첫 출근한다*"),
      stateNote: `${ONBOARDING_INSTRUCTION}\n\n${buildGmStateNote(state)}`,
      maxTokens: 1_200,
    });
    const text = humanizePlayerIds(state, result.text.trim());
    if (!isValidOnboardingText(state, text)) return fallback;
    return { text, toolCalls: [], usage: result.usage };
  } catch {
    return fallback;
  }
}

/** 실모드 — 일상은 GM 티어, 경기 장면은 매치 캐스터 프롬프트로 라우팅 */
async function runRealGmTurn(
  state: GameState,
  message: string,
  onText?: (delta: string) => void,
): Promise<GmTurnResult> {
  const calls: GmToolCall[] = [];
  const inMatch = state.phase === "match";
  const llm = new AnthropicGameLLM(inMatch ? TIERS.match : TIERS.gm);

  const tools = buildGmTools(state, calls);
  if (inMatch) {
    tools.push(
      makeLogMatchEventsTool((events) => {
        const result = applyMatchEvents(state, events);
        if (result.ok)
          calls.push({ name: "log_match_events", summary: result.message, input: { events } });
        return result;
      }),
    );
  }

  /**
   * 입력 구성 — 안정성 순으로 3층. 앞 두 층은 캐시 프리픽스(0.1×)이고
   * 마지막 층만 매 턴 정가로 읽힌다 (docs/design/llm-io.md).
   *   ① 고정 프롬프트           ② 레퍼런스(명부·패킷)     ③ 발화 + 상태 스냅샷
   */
  const activePrompts = resolveSystemPrompts({
    gm: GM_SYSTEM,
    match: MATCH_CASTER_SYSTEM,
  }).prompts;
  const system = inMatch
    ? [activePrompts.match, buildMatchReference(state)]
    : [activePrompts.gm, buildGmReference(state)];
  const stateNote = inMatch ? buildLedgerNote(state) : buildGmStateNote(state);
  const history = inMatch
    ? ((state.pendingMatch?.casterHistory ?? []) as never)
    : (buildGmHistory(state) as never);

  const result = await llm.runTurn({
    system,
    history,
    user: buildManagerMessage(state, message),
    stateNote,
    tools,
    onText,
  });

  if (inMatch && state.pendingMatch) {
    state.pendingMatch.casterHistory = result.history as unknown[];
    if (state.pendingMatch.ledger.phase === "finished") {
      const digest = finalizeMatch(state);
      calls.push({ name: "finalize_match", summary: digest.join(" · ") });
    }
  }
  // 서사에 흘러든 선수 id를 이름으로 — 유저에게 id는 절대 노출하지 않는다
  return { text: humanizePlayerIds(state, result.text), toolCalls: calls, usage: result.usage };
}

/**
 * GM 턴 실행 — 모드 자동 해석 (env LLM_MODE 우선).
 * onText를 주면 서사 텍스트를 스트리밍으로 흘려보낸다 (실모드는 진짜 델타,
 * mock은 완성 텍스트를 청크로 쪼개 즉시 방출).
 */
export async function runGmTurn(
  state: GameState,
  message: string,
  onText?: (delta: string) => void,
): Promise<GmTurnResult> {
  if (resolveLlmMode() === "mock") return runMockGmTurn(state, message, onText);
  return runRealGmTurn(state, message, onText);
}
