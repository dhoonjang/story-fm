/**
 * 개발 모드 기록 — **한 게임에 창고 하나, 한 턴에 타임라인 하나** (models.md §5).
 *
 * 계측은 토큰 수만 센다(`usage-meter.ts`). 게임을 고치려면 그 턴에 **무엇이 오갔고 코어가
 * 무엇을 했는가**를 봐야 한다 — 감독의 입력, 모델 호출의 요청과 응답, 해석기가 낸 명령,
 * 코어가 걸고 반려한 것, 판이 구른 패킷과 난수 채널, 굴러간 하루하루. 그 전부가 **한
 * 타임라인에 일어난 순서로** 선다. 모델 호출도 사실도 같은 줄의 항목이다 — 갈라 두면
 * 「해석기가 이렇게 답했는데 코어는 왜 저렇게 했나」를 두 창을 오가며 시각으로 맞춰야 한다.
 *
 * 네 가지가 경계다:
 *
 * 1. **항목은 일어나는 즉시 파일에 앉는다.** 타임라인은 jsonl이라 줄 하나가 항목 하나다 —
 *    시한을 넘긴 호출과 이력이 400을 맞은 호출이 가장 보고 싶은 자리인데, 그런 턴은 채팅에
 *    model 턴을 남기지 못한다. 턴이 끝날 때 한꺼번에 쓰면 그 턴이 통째로 사라진다.
 * 2. **호출의 원문은 따로 산다.** 시스템 프롬프트와 이력이 호출마다 수만 자라 타임라인에
 *    실으면 턴 하나가 수백 KB가 된다. 타임라인의 `llm.call` 항목은 요약(누가·무엇으로·
 *    얼마나·실패했나)이고 원문은 `calls/<호출 id>.json` 하나가 갖는다 — 이름이 잇는다.
 * 3. **세이브와 다른 곳에 살고, 세이브보다 오래 산다.** 기록은 게임의 부속물이 아니라
 *    **게임을 고치는 재료**다. 플레이 데이터가 사는 `.data`가 아니라 `.log` 창고에 살고,
 *    게임을 지워도 남는다. 디스크는 상한이 지킨다.
 * 4. **production에서는 아무 파일도 쓰지 않는다.** 라우트도 화면도 CLI도 같은 기준으로
 *    닫힌다.
 *
 * 사실을 내는 문은 엔진의 `journal`이다 — 이 패키지는 엔진을 모르므로(알면 순환이다) 창고는
 * `noteFact`로 받고, 둘을 잇는 것은 웹의 `turn-runner`다(`bindJournal`).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { agentMinCacheableInput, type AgentName, type LlmEnv } from "./config";
import { gameVersion } from "./game-version";
import {
  isStoredLlmHistory,
  type GameLLM,
  type GameToolSpec,
  type JsonObjectSchema,
  type StopReason,
  type TurnHistory,
  type TurnRequest,
  type TurnResult,
  type TurnUsage,
} from "./game-llm";

/**
 * 게임당 남는 **호출 원문** 수 — 넘치면 오래된 파일부터 지운다.
 *
 * 한 호출이 50~150KB다(시스템 프롬프트 + 이력). 두 시즌 플레이가 2,500호출 안팎이라
 * 5,000이면 **한 플레이가 통째로 남는** 폭이고, 게임당 수백 MB에서 멈춘다 — 플레이 도중에
 * 앞부분이 밀려나면 되짚을 것이 절반이 된다.
 */
export const MAX_TRACED_CALLS = 5_000;

/**
 * 게임당 남는 **턴 타임라인** 수.
 *
 * 타임라인은 원문이 아니라 사실이라 작다 — 경기 턴이 구간 하나의 패킷 요약을 들고
 * 10~50KB, 평시 턴은 몇 KB다. 20,000턴이면 스무 시즌이고 그래도 수백 MB에서 멈춘다.
 * 원문보다 넉넉한 이유는 되짚는 질문의 대부분이 원문이 아니라 여기에 답이 있기 때문이다.
 */
export const MAX_TRACED_TURNS = 20_000;

/**
 * 게임당 남는 **전술판 선반**의 타임라인 수 — 전술판 저장과 게임 삭제.
 *
 * 전술판은 바뀐 것이 있을 때 조작이 멎은 뒤 한 번 저장되므로(`lineup-saver.ts`) 판을
 * 짜는 한 번의 결정이 저장 한 건이다 — 채팅 턴보다 드물다. 상한이 따로인 것은 선반이
 * 따로이기 때문이지 양 때문이 아니다.
 */
export const MAX_TRACED_BOARD = 5_000;

/** 창고의 상한 — 테스트가 좁혀 쓴다. 게임은 언제나 위의 값으로 돈다 */
export interface TraceLimits {
  calls: number;
  turns: number;
  board: number;
}

export const TRACE_LIMITS: TraceLimits = {
  calls: MAX_TRACED_CALLS,
  turns: MAX_TRACED_TURNS,
  board: MAX_TRACED_BOARD,
};

/**
 * **선반** — 타임라인이 놓이는 자리. 모양은 같고 뜻이 다르다.
 *
 * - `turns` — 채팅 턴. 감독의 말이나 손잡이에 GM이 답하고 세계가 움직인 한 번의 실행 흐름.
 *   새 게임의 첫 장면도 여기다(model 턴을 채팅에 밀어 넣는다).
 * - `board` — 채팅 턴이 아닌 쓰기. 전술판 저장과 게임 삭제 — 잠금 한 번, 세이브 한 번의
 *   실행 흐름이되 GM도 채팅 자리도 없다.
 *
 * 이름의 앞자리가 선반을 말한다(`turn-…` · `board-…`) — 이름만 들고 와도 어느 선반에서
 * 열지 안다. **목록은 하나다**(`index.jsonl`) — 두 선반이 일어난 순서 그대로 한 줄씩 서서,
 * 「전술판을 고친 뒤 무슨 말을 했나」가 목록에서 읽힌다.
 */
export type TraceShelf = "turns" | "board";

/* ------------------------------------------------------------------ *
 * 호출 원문 — `calls/<호출 id>.json` 하나의 모양
 * ------------------------------------------------------------------ */

/** 도구 스펙 원문 — `handle`은 함수라 기록에 남기지 않는다 */
export interface TurnTraceTool {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
  /**
   * 읽기 전용 조회 도구인가 (`GameToolSpec.readOnly`).
   *
   * 팝업이 도구 흐름에서 조회와 스킬을 가르는 자리다 — 화면이 이름으로 다시
   * 가르면 `search_players`처럼 접두사가 다른 조회가 스킬로 선다 (models.md §5).
   */
  readOnly?: boolean;
}

/** 이 호출이 모델에 보낸 것 — `TurnRequest`를 직렬화 가능한 모양으로만 옮긴다 */
export interface TurnTraceRequest {
  /** 시스템 프롬프트 블록 — 문자열 하나로 온 것도 블록 하나로 적는다 */
  system: string[];
  /** 넘긴 이력 원문 (제공자 원형 메시지 또는 텍스트 이력) */
  history: unknown[];
  user: string;
  stateNote?: string;
  tools: TurnTraceTool[];
  /** 도구 없이 JSON 하나로 답을 강제한 스키마 — 산출 호출 열이 싣는다 (models.md §3-2) */
  outputSchema?: JsonObjectSchema;
  maxTokens?: number;
  /** 스트리밍으로 불렀는가 — 화면에 흘려보낸 턴인지 가른다 */
  streaming: boolean;
}

/** 이 호출이 받은 것 */
export interface TurnTraceResponse {
  text: string;
  /**
   * 이 호출이 이력에 **새로 붙인** 메시지 — `tool_use`·thinking 블록이 여기 있다.
   * 요청에 이미 적은 이력을 두 번 적지 않는다.
   */
  messages: unknown[];
  usage: TurnUsage;
  toolCallCount: number;
  stopReason: StopReason | null;
  /**
   * 출력 스키마로 받은 산출 — 어댑터가 본문에서 읽은 객체, 못 읽었으면 `null`. 스키마를
   * 실은 호출에만 있다. `text`가 원문이고 이것이 코어가 받은 것이다 (models.md §3-2).
   */
  output?: Record<string, unknown> | null;
}

export interface TurnTraceCall {
  /**
   * 이 호출의 이름 — `<에이전트>-<36진 시각>-<넉 자>`.
   *
   * 파일 이름이자 화면의 머리이자 CLI의 인자다. 셋이 같은 문자열이라 「이 응답이
   * 이상하다」가 화면 밖으로 나갈 수 있다. 36진 시각이 앞에 서므로 같은
   * 에이전트의 호출은 이름만으로 시간순이고, 넉 자는 같은 밀리초에 두 호출이
   * 나도 부딪히지 않게 한다.
   */
  id: string;
  /** 호출이 시작된 시각 (ISO) */
  at: string;
  /**
   * **이 호출이 돌던 게임 버전** — 모델이 받는 입력의 버전이다 (models.md §5-2).
   *
   * 반년 전 로그를 열었을 때 그 답이 지금과 같은 프롬프트·도구·모델에서 나온
   * 것인지 여기서 갈린다. 버전이 다르면 두 응답의 차이는 모델의 변덕이 아니라
   * 우리가 바꾼 입력의 결과다.
   */
  gameVersion: string;
  /** 타임라인의 자리 — 같은 턴의 사실과 한 눈금으로 선다 */
  seq: number;
  /**
   * **이 호출을 낳은 호출** — 없으면 턴이 직접 연 호출이다.
   *
   * 한 턴의 호출들은 나란히 도는 것이 아니라 **서로를 부른다**: 매치 GM이
   * `advance_match`를 부르면 그 도구 안에서 지시 해석과 마감이 돌고, 그 둘은 매치
   * GM의 응답을 기다리게 만든다(agents.md §3). 평면 목록으로 두면 그 셋이 우연히
   * 순서대로 선 것처럼 보여, 느린 턴의 범인이 어느 호출인지 읽을 수 없다.
   */
  parentId: string | null;
  /** 부모의 **어느 도구** 안에서 시작됐나 — 부모가 없으면 `null` */
  viaTool: string | null;
  agent: AgentName;
  /** 응답이 태그한 모델 — 실패한 호출은 `null`이다 */
  model: string | null;
  /**
   * 이 호출의 제공자에서 캐시가 걸리기 시작하는 입력 크기 (models.md §4).
   * 이보다 짧은 입력은 히트율 0이 신호가 아니라 당연한 값이라, 그 둘을 화면에서
   * 가르는 데 쓴다. 이 필드가 서기 전에 남은 기록에는 없다.
   */
  minCacheableInput?: number;
  durationMs: number;
  request: TurnTraceRequest;
  /** 실패한 호출은 `null` — 그때는 `error`가 이유를 갖는다 */
  response: TurnTraceResponse | null;
  error: string | null;
}

/* ------------------------------------------------------------------ *
 * 타임라인 — `turns/<턴 id>.jsonl` 한 줄의 모양
 * ------------------------------------------------------------------ */

/**
 * 타임라인의 항목 하나 — 갈래(`kind`)와 값에 순서·시각을 얹은 것.
 *
 * 갈래는 셋으로 갈린다: 코어의 사실(엔진의 `JournalEntry` — `match.segment`·`command` …),
 * 모델 호출(`llm.call` — 원문은 따로), 그리고 턴의 겉(`turn.open`·`turn.note`·`turn.close`).
 * 읽는 쪽은 겉을 기록의 필드로 접고 나머지를 `entries`로 세운다.
 */
export interface TurnEntry {
  seq: number;
  at: string;
  kind: string;
  data: unknown;
  /**
   * **어느 호출의 어느 도구 안에서 났나** — 도구 밖이면 없다.
   *
   * 매치 GM이 `advance_match`를 부르면 그 안에서 해석 호출·명령·구간이 돈다. 이 표식이
   * 있어야 타임라인을 나무로 읽을 수 있다 — 어느 응답이 어느 사실을 낳았는지.
   */
  via?: { call: string; tool: string };
}

/** `llm.call` 항목의 값 — 호출의 요약. 원문(`TurnTraceCall`)은 `calls/`가 갖는다 */
export interface LlmCallEntry {
  id: string;
  agent: AgentName;
  model: string | null;
  parentId: string | null;
  viaTool: string | null;
  durationMs: number;
  usage: TurnUsage | null;
  toolCallCount: number;
  stopReason: StopReason | null;
  error: string | null;
  /** 요청의 크기 — 원문을 열지 않고 읽는 눈금 */
  request: { chars: number; systemBlocks: number; historyMessages: number; tools: number };
  response: { chars: number; messages: number } | null;
}

/** 턴이 어떻게 끝났나 — 성공이면 저장됐고, 실패면 상태는 버려졌다 */
export interface TurnOutcomeNote {
  ok: boolean;
  /** 세이브에 앉았는가 — 실패한 턴은 메모리의 상태가 버려진다 */
  saved: boolean;
  error?: string;
  /** 실패의 종류 (`LlmErrorKind`) */
  kind?: string;
  retry?: boolean;
  detail?: string;
}

/**
 * 턴 하나의 기록 — 타임라인을 읽어 접은 것.
 *
 * `input`·`before`·`after`의 모양은 부르는 쪽이 정한다(웹의 turn-runner가 엔진의
 * `turnDigestOf`를 쓴다) — 이 패키지는 엔진을 모르므로 여기서는 값으로만 든다.
 */
export interface TurnRecord {
  /** `turn-<36진 시각>-<넉 자>` — 파일 이름이자 목록의 키. 전술판 선반은 `board-…` */
  id: string;
  shelf: TraceShelf;
  at: string;
  gameVersion: string;
  /** `state.chat`의 자리 — 묶이지 못한 턴(실패)은 null */
  index: number | null;
  durationMs: number;
  /** 범위가 닫혔는가 — 아니면 프로세스가 도중에 죽은 턴이다 */
  closed: boolean;
  input: unknown;
  before: unknown;
  after: unknown;
  outcome: TurnOutcomeNote | null;
  /** 사실과 호출 — 턴의 겉(`turn.*`)은 위의 필드로 접혔다. 순서는 `seq` */
  entries: TurnEntry[];
  /** 이 턴에 돈 호출 — 시작 순서. 원문은 `calls/`가 갖는다 */
  callIds: string[];
}

/** 목록(`index.jsonl`) 한 줄 — 타임라인을 열지 않고도 어떤 턴이었는지. 두 선반이 한 목록에 선다 */
export interface TurnIndexLine {
  id: string;
  shelf: TraceShelf;
  at: string;
  gameVersion: string;
  index: number | null;
  /** 닫히지 않은 턴(프로세스가 죽었다)은 `null` */
  ok: boolean | null;
  error: string | null;
  durationMs: number;
  entries: number;
  /** 이 턴에 선 갈래 — 중복 없이. `llm.call`도 갈래다 */
  kinds: string[];
  callIds: string[];
  /** 한 줄 요약 — 감독의 말 첫 줄이나 조작의 이름 */
  head: string;
}

/** 호출 목록 한 줄 — 타임라인의 `llm.call` 항목에 턴의 자리를 얹은 것 */
export interface CallLine extends LlmCallEntry {
  at: string;
  gameVersion: string;
  seq: number;
  /** 이 호출이 선 턴 — 옛 창고(턴이 없던 시절)의 호출은 null */
  turn: string | null;
  index: number | null;
}

/** 개발 모드인가 — 기록·라우트·제스처·CLI가 모두 이 하나를 본다 */
export function traceEnabled(env: LlmEnv = process.env): boolean {
  return env.NODE_ENV !== "production";
}

/* ------------------------------------------------------------------ *
 * 원문으로 옮기기
 * ------------------------------------------------------------------ */

/** 시스템 프롬프트를 블록 배열로 — 문자열 하나도 블록 하나다 */
function systemBlocks(system: string | string[]): string[] {
  return Array.isArray(system) ? [...system] : [system];
}

/**
 * 이력을 메시지 배열로 — 제공자 원형 저장 이력이면 그 `messages`,
 * 텍스트 이력이면 그 배열이다.
 */
function historyMessages(history: TurnHistory): unknown[] {
  if (isStoredLlmHistory(history)) return [...history.messages];
  return Array.isArray(history) ? [...history] : [];
}

function traceRequest(req: TurnRequest): TurnTraceRequest {
  return {
    system: systemBlocks(req.system),
    history: historyMessages(req.history),
    user: req.user,
    ...(req.stateNote === undefined ? {} : { stateNote: req.stateNote }),
    tools: (req.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.readOnly === undefined ? {} : { readOnly: tool.readOnly }),
    })),
    ...(req.outputSchema === undefined ? {} : { outputSchema: req.outputSchema }),
    ...(req.maxTokens === undefined ? {} : { maxTokens: req.maxTokens }),
    streaming: req.onText !== undefined,
  };
}

/**
 * 응답이 이력에 새로 붙인 메시지.
 *
 * 앞의 이력은 요청에 이미 적혀 있으므로 그만큼 잘라 낸다. **자를 자리는 어댑터가
 * 돌려준 `historyBase`다** — 어댑터는 자기 제공자에 맞춰 이력을 정규화하며 메시지를
 * 더하거나 덜기 때문에(Gemini는 연결 user 턴 하나를 앞에 두고, Anthropic은 빈 텍스트
 * 메시지를 버리고, 태그가 다르면 통째로 새로 시작한다), 보낸 이력의 길이로 세면
 * 어긋난 만큼 이번 턴의 왕복이 잘리거나 지난 턴이 딸려 들어온다.
 */
function appendedMessages(result: TurnResult): unknown[] {
  return result.history.messages.slice(result.historyBase);
}

/** 문자 수 — 원문을 열지 않고 크기를 읽는 눈금 */
function charsOf(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** 호출 원문에서 타임라인 항목의 값을 — 원문을 열지 않고 읽을 것만 */
function callEntryOf(call: TurnTraceCall): LlmCallEntry {
  return {
    id: call.id,
    agent: call.agent,
    model: call.model,
    parentId: call.parentId,
    viaTool: call.viaTool,
    durationMs: call.durationMs,
    usage: call.response?.usage ?? null,
    toolCallCount: call.response?.toolCallCount ?? 0,
    stopReason: call.response?.stopReason ?? null,
    error: call.error,
    request: {
      chars:
        charsOf(call.request.system) +
        charsOf(call.request.history) +
        call.request.user.length +
        (call.request.stateNote?.length ?? 0),
      systemBlocks: call.request.system.length,
      historyMessages: call.request.history.length,
      tools: call.request.tools.length,
    },
    response:
      call.response === null
        ? null
        : { chars: call.response.text.length, messages: call.response.messages.length },
  };
}

/**
 * 이름 — 갈래가 앞, 36진 시각이 가운데, 무작위 넉 자가 꼬리.
 *
 * 갈래가 앞에 서는 이유는 목록에서 눈으로 훑기 위해서다(`gm-…`은 호출, `turn-…`은 턴).
 * 시각은 36진이라 여덟 자에 들고(2059년까지), 그 덕에 같은 갈래의 파일은 이름만으로
 * 시간순에 선다. 꼬리는 같은 밀리초에 둘이 나는 경우를 가른다.
 */
function nameOf(prefix: string, now: number): string {
  return `${prefix}-${now.toString(36)}-${randomBytes(2).toString("hex")}`;
}

/* ------------------------------------------------------------------ *
 * 어느 항목이 이 턴의 것인가 — **실행 문맥이 정한다.**
 *
 * 시각이나 전역 큐로 가르면 두 게임이 같은 프로세스에서 동시에 턴을 돌릴 때 남의
 * 항목이 섞인다. `traceTurn` 안에서 일어난 것만 그 턴에 쌓인다.
 * ------------------------------------------------------------------ */

/** 열린 턴 범위 — 어느 게임의 턴인지, 지금까지 쌓인 것 */
interface TraceScope {
  gameId: string;
  shelf: TraceShelf;
  /** 이 턴의 이름 — 타임라인 파일의 이름이다 */
  id: string;
  startedAt: number;
  index: number | null;
  /** 타임라인의 자리 — 사실도 호출도 한 눈금 */
  seq: number;
  callIds: string[];
  kinds: Set<string>;
  entries: number;
  input: unknown;
  before: unknown;
  after: unknown;
  outcome: TurnOutcomeNote | null;
}

const collecting = new AsyncLocalStorage<TraceScope>();

/**
 * 지금 **어느 호출의 도구 안**인가 — 자식 호출과 도구 안의 사실이 제 부모를 아는 길.
 *
 * 도구 핸들러는 어댑터가 모델의 `tool_use`를 받아 부르는 자리이고, 그 안에서 다른
 * 에이전트를 부르는 도구가 있다(`GameToolSpec.handle`의 계약 · agents.md §3). 그
 * 핸들러가 도는 동안만 이 문맥이 서 있으므로, 그때 난 항목은 부모와 경유한 도구를
 * 그 자리에서 알게 된다 — 시각으로 짐작하거나 어댑터 셋을 고치지 않는다.
 */
interface RunningCall {
  id: string;
  tool: string;
}

const running = new AsyncLocalStorage<RunningCall>();

/**
 * 도구 스펙을 감싸 **실행 구간에 문맥을 깐다** — 스펙의 계약은 그대로다.
 *
 * 기록이 도구의 답을 바꾸지 않도록 `handle`의 반환을 그대로 돌려준다(동기 답도
 * 프로미스도 있다). 감싼 배열은 새 객체라 부르는 쪽의 스펙은 손대지 않는다.
 */
function tapTools(tools: readonly GameToolSpec[], callerId: string): GameToolSpec[] {
  return tools.map((spec) => ({
    ...spec,
    handle: (input: unknown, context?: Parameters<GameToolSpec["handle"]>[1]) =>
      running.run({ id: callerId, tool: spec.name }, () => spec.handle(input, context)),
  }));
}

/* ------------------------------------------------------------------ *
 * 저장소 — **`.log` 창고**. 플레이 데이터(`.data`)와 다른 디렉터리다.
 *
 *   .log/<gameId>/
 *     index.jsonl           목록 — 두 선반의 타임라인 하나가 한 줄, 닫힐 때 쓴다
 *     turns/<턴 id>.jsonl   채팅 턴의 타임라인 — 항목 하나가 한 줄, 일어나는 즉시
 *     board/<id>.jsonl      전술판 저장·게임 삭제의 타임라인 — 채팅 턴과 같은 모양
 *     calls/<호출 id>.json  호출 하나의 원문 — 타임라인의 `llm.call`이 가리킨다
 *     calls.jsonl · <턴 인덱스>.json   (옛 창고 — 읽기만 한다)
 *
 * ⚠️ **세이브와 한 디렉터리를 쓰지 않는다.** 둘은 수명도 주인도 다르다 — 세이브는
 * 유저의 게임이고 지우면 끝이지만, 기록은 우리가 게임을 고치는 재료라 그 판이
 * 사라진 뒤에 더 필요해진다. 자리가 갈려 있으면 세이브를 지우는 어떤 경로도 기록에
 * 닿지 않고, 세이브 목록(`.json`을 세는 규칙)과 섞이지도 않는다.
 * ------------------------------------------------------------------ */

/**
 * 로그 창고 — 게임별 디렉터리가 이 아래 나란히 선다.
 *
 * 자리를 옮기는 손잡이는 `STORY_FM_LOG_DIR`이다(검증·테스트가 쓴다). 기본값이
 * `.data`와 같은 규칙(실행 디렉터리 기준)인 이유는 dev 서버가 `apps/web`에서 돌기
 * 때문이다 — 세이브가 `apps/web/.data`면 기록은 `apps/web/.log`다.
 */
export function logDir(): string {
  return process.env.STORY_FM_LOG_DIR ?? path.join(process.cwd(), ".log");
}

export function traceDir(gameId: string): string {
  return path.join(logDir(), gameId);
}

function callsDir(gameId: string): string {
  return path.join(traceDir(gameId), "calls");
}

/** 호출 원문이 사는 파일 — CLI가 경로만 묻는 자리이기도 하다 (`pnpm log <id> --path`) */
export function traceCallFile(gameId: string, id: string): string {
  return path.join(callsDir(gameId), `${id}.json`);
}

function shelfDir(gameId: string, shelf: TraceShelf): string {
  return path.join(traceDir(gameId), shelf);
}

/** 목록 — 두 선반이 한 파일에, 닫힌 순서(= 잠금이 서로 이어 준 실제 순서)로 */
function indexFile(gameId: string): string {
  return path.join(traceDir(gameId), "index.jsonl");
}

/** 이름이 말하는 선반 — `board-…`만 전술판 선반이고 나머지는 채팅 턴이다 */
export function shelfOf(id: string): TraceShelf {
  return id.startsWith("board-") ? "board" : "turns";
}

/** 타임라인이 사는 파일 — 이름의 앞자리가 선반을 정한다 */
export function turnRecordFile(gameId: string, id: string): string {
  return path.join(shelfDir(gameId, shelfOf(id)), `${id}.jsonl`);
}

/** 옛 창고 — 호출 목록 한 줄씩. 더 쓰지 않는다 */
function legacyCallsFile(gameId: string): string {
  return path.join(traceDir(gameId), "calls.jsonl");
}

/** 옛 창고 — `<턴 인덱스>.json` 묶음. 더 쓰지 않는다 */
const LEGACY_TURN_FILE = /^(\d+)\.json$/;

function legacyTurnFile(gameId: string, index: number): string {
  return path.join(traceDir(gameId), `${index}.json`);
}

/** tmp에 완전히 쓴 뒤 rename — 쓰다 죽어도 반쪽 파일이 이름을 갖지 않는다 */
function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, contents, "utf8");
  renameSync(tmp, file);
}

/** jsonl 한 파일 — 없거나 읽지 못하면 빈 배열이다. 깨진 줄은 건너뛴다 */
function readLines<T>(file: string): T[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines: T[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      lines.push(JSON.parse(raw) as T);
    } catch {
      // 덧붙이다 죽은 마지막 줄이 이렇게 남는다 — 줄 하나 때문에 전부를 버리지 않는다
    }
  }
  return lines;
}

/**
 * 타임라인에 항목 하나를 앉힌다 — **일어나는 즉시.** 쓰지 못해도(디스크·권한) 턴은
 * 그대로 간다: 기록은 턴의 결과가 아니다.
 */
function appendEntry(scope: TraceScope, entry: TurnEntry): void {
  try {
    appendFileSync(turnRecordFile(scope.gameId, scope.id), `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    console.warn(`[turn-trace] ${scope.gameId} 턴 ${scope.id}의 항목을 쓰지 못했습니다:`, error);
  }
}

/** 지금 도구 안이면 그 호출과 도구 — 항목이 나무의 어느 가지인지 */
function viaOf(): { via: { call: string; tool: string } } | Record<never, never> {
  const parent = running.getStore();
  return parent === undefined ? {} : { via: { call: parent.id, tool: parent.tool } };
}

/** 다음 항목의 자리와 시각 */
function place(scope: TraceScope): { seq: number; at: string } {
  return { seq: scope.seq++, at: new Date().toISOString() };
}

/* ------------------------------------------------------------------ *
 * 턴 범위
 * ------------------------------------------------------------------ */

/**
 * 한 채팅 턴의 범위를 연다 — 이 안에서 일어난 항목이 **그 게임의 타임라인으로** 쌓인다.
 *
 * ⚠️ **게임 id를 여기서 받는다.** 항목은 일어나는 즉시 디스크에 앉아야 하고(턴이
 * 죽어도 남아야 하므로) 그러려면 어느 게임의 창고에 쓸지를 그때 알아야 한다. 턴
 * 인덱스는 그때까지 정해지지 않으므로 나중에 `bindTurnTrace`가 이어 붙인다.
 *
 * 범위가 닫히면 겉을 마감 항목으로 앉히고 목록에 한 줄을 붙인 뒤, 상한을 넘긴 기록을
 * 턴 하나에 한 번 정리한다. 성공한 턴도 실패한 턴도 모델을 부르지 않은 턴도 같은
 * 자리를 지난다.
 */
export async function traceTurn<T>(
  gameId: string,
  run: () => Promise<T>,
  env: LlmEnv = process.env,
  limits: TraceLimits = TRACE_LIMITS,
): Promise<T> {
  return traceScope("turns", gameId, run, env, limits);
}

/**
 * 채팅 턴이 아닌 쓰기의 범위 — 전술판 저장·게임 삭제 (`board` 선반).
 *
 * 같은 타임라인이 같은 규칙으로 선다 — 명령과 반려, 앞뒤 상태 요약, 결과 — 그리고 같은
 * 목록에 선다. 다른 것은 선반뿐이다: 채팅 자리가 없고, 파일이 다른 디렉터리에 살고,
 * 상한이 따로다. 「턴」이라는 말이 채팅 턴만을 가리키게 하려는 것이다.
 */
export async function traceBoard<T>(
  gameId: string,
  run: () => Promise<T>,
  env: LlmEnv = process.env,
  limits: TraceLimits = TRACE_LIMITS,
): Promise<T> {
  return traceScope("board", gameId, run, env, limits);
}

async function traceScope<T>(
  shelf: TraceShelf,
  gameId: string,
  run: () => Promise<T>,
  env: LlmEnv,
  limits: TraceLimits,
): Promise<T> {
  if (!traceEnabled(env)) return run();
  const startedAt = Date.now();
  const scope: TraceScope = {
    gameId,
    shelf,
    id: nameOf(shelf === "board" ? "board" : "turn", startedAt),
    startedAt,
    index: null,
    seq: 0,
    callIds: [],
    kinds: new Set(),
    entries: 0,
    input: null,
    before: null,
    after: null,
    outcome: null,
  };
  try {
    mkdirSync(shelfDir(gameId, shelf), { recursive: true });
  } catch (error) {
    console.warn(`[turn-trace] ${gameId}의 창고를 열지 못했습니다:`, error);
  }
  appendEntry(scope, {
    ...place(scope),
    kind: "turn.open",
    data: { id: scope.id, shelf, gameVersion: gameVersion() },
  });
  try {
    return await collecting.run(scope, run);
  } catch (error) {
    // 범위 안에서 잡히지 않고 올라온 예외 — 턴은 없던 일이 되지만 기록에는 남는다
    scope.outcome ??= {
      ok: false,
      saved: false,
      error: error instanceof Error ? error.message : String(error),
    };
    throw error;
  } finally {
    closeTurn(scope);
    pruneTraces(gameId, limits);
  }
}

/**
 * 이 범위의 턴을 채팅 턴 인덱스에 묶는다 — **model 턴을 `state.chat`에 밀어 넣는 그
 * 자리에서** 부른다. 인덱스가 그 턴의 자리와 어긋나면 화면은 남의 턴을 연다.
 *
 * 타임라인은 이미 디스크에 있으므로 여기서 하는 것은 **자리를 적어 두는 것뿐**이다.
 * 그래서 이 함수를 부르지 못한 턴(실패한 턴)도 기록을 잃지 않는다 — 화면에서 열리지
 * 않을 뿐이고 CLI가 이름으로 연다.
 */
export function bindTurnTrace(gameId: string, index: number): void {
  const scope = collecting.getStore();
  if (scope === undefined || scope.gameId !== gameId || scope.shelf !== "turns") return;
  scope.index = index;
}

/**
 * 사실 하나를 열린 턴에 앉힌다 — 엔진의 `journal`이 여기로 이어진다 (models.md §5-3).
 * 열린 턴이 없으면(CLI·테스트·하네스) 버린다 — 호출과 같은 규칙이다. 값은 그 순간
 * 직렬화된다 — 장부가 뒤에서 같은 객체를 고쳐 써도 기록은 그 순간의 것이다.
 */
export function noteFact(kind: string, data: unknown): void {
  const scope = collecting.getStore();
  if (scope === undefined) return;
  scope.kinds.add(kind);
  scope.entries += 1;
  appendEntry(scope, { ...place(scope), kind, data, ...viaOf() });
}

/** 턴의 겉 — 입력·앞뒤 상태 요약·결과. 부르는 자리마다 제 몫만 적는다 */
export function noteTurn(note: {
  input?: unknown;
  before?: unknown;
  after?: unknown;
  outcome?: TurnOutcomeNote;
}): void {
  const scope = collecting.getStore();
  if (scope === undefined) return;
  if (note.input !== undefined) scope.input = note.input;
  if (note.before !== undefined) scope.before = note.before;
  if (note.after !== undefined) scope.after = note.after;
  if (note.outcome !== undefined) scope.outcome = { ...note.outcome };
  appendEntry(scope, { ...place(scope), kind: "turn.note", data: note });
}

/**
 * 목록 한 줄의 머리 — 감독의 말이면 첫 줄, 조작이면 그 이름.
 * 입력의 모양은 부르는 쪽의 것이라 여기서는 흔한 칸만 더듬는다.
 */
function headOf(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const value = input as { text?: unknown; operation?: { kind?: unknown }; kind?: unknown };
  if (typeof value.text === "string" && value.text.trim() !== "") {
    return value.text.trim().split("\n")[0]!.slice(0, 80);
  }
  if (typeof value.operation?.kind === "string") return value.operation.kind;
  if (typeof value.kind === "string") return value.kind;
  return "";
}

/** 범위가 닫히는 자리 — 마감 항목과 목록 한 줄 */
function closeTurn(scope: TraceScope): void {
  const durationMs = Date.now() - scope.startedAt;
  appendEntry(scope, {
    ...place(scope),
    kind: "turn.close",
    data: { index: scope.index, durationMs, outcome: scope.outcome },
  });
  const line: TurnIndexLine = {
    id: scope.id,
    shelf: scope.shelf,
    at: new Date(scope.startedAt).toISOString(),
    gameVersion: gameVersion(),
    index: scope.index,
    ok: scope.outcome?.ok ?? null,
    error: scope.outcome?.error ?? null,
    durationMs,
    entries: scope.entries,
    kinds: [...scope.kinds],
    callIds: [...scope.callIds],
    head: headOf(scope.input),
  };
  try {
    appendFileSync(indexFile(scope.gameId), `${JSON.stringify(line)}\n`, "utf8");
  } catch (error) {
    console.warn(`[turn-trace] ${scope.gameId} 턴 ${scope.id}의 목록 줄을 쓰지 못했습니다:`, error);
  }
}

/* ------------------------------------------------------------------ *
 * 호출을 따는 문
 * ------------------------------------------------------------------ */

/**
 * 원문을 따는 `GameLLM` — 계약이 같으므로 부르는 쪽은 감싼 줄 모른다.
 *
 * 계측·시한과 같은 자리(`createGameLLM`)에 붙는다. 모든 실호출이 그 문 하나를
 * 지나므로 어댑터 세 곳을 건드리지 않는다.
 *
 * **실패한 호출도 적는다** — 시한을 넘긴 호출, 이력이 400을 맞은 호출이 원문을 가장
 * 보고 싶은 자리다. 적는 때는 성공이든 실패든 **그 호출이 끝나는 즉시**다: 원문은 제
 * 파일에, 요약은 타임라인의 `llm.call` 항목으로. 항목의 자리(`seq`)는 호출이 **시작된**
 * 때의 것이라, 그 호출의 도구 안에서 난 사실들보다 앞에 선다.
 */
export function tapLlm(llm: GameLLM, agent: AgentName, env: LlmEnv = process.env): GameLLM {
  if (!traceEnabled(env)) return llm;
  return {
    async runTurn(req: TurnRequest): Promise<TurnResult> {
      const scope = collecting.getStore();
      // 턴 범위 밖의 호출은 앉을 게임이 없다 (CLI·테스트) — 기록하지 않는다
      if (scope === undefined) return llm.runTurn(req);

      const startedAt = Date.now();
      const parent = running.getStore();
      const at = place(scope);
      const call: TurnTraceCall = {
        id: nameOf(agent, startedAt),
        at: at.at,
        gameVersion: gameVersion(),
        seq: at.seq,
        parentId: parent?.id ?? null,
        viaTool: parent?.tool ?? null,
        agent,
        model: null,
        minCacheableInput: agentMinCacheableInput(agent),
        durationMs: 0,
        request: traceRequest(req),
        response: null,
        error: null,
      };
      // 시작하는 자리에서 이름을 잡는다 — 한 턴의 호출 순서가 타임라인의 순서다
      scope.callIds.push(call.id);
      const via = viaOf();
      try {
        /**
         * 도구 뒤에서 도는 호출과 사실이 이 호출을 부모로 알도록, **이 호출이 쥔
         * 도구**에만 문맥을 깐다 — 모델을 기다리는 동안에는 문맥이 서지 않으므로 같은
         * 턴의 이웃 호출이 자식으로 잘못 묶이지 않는다.
         */
        const traced =
          req.tools === undefined || req.tools.length === 0
            ? req
            : { ...req, tools: tapTools(req.tools, call.id) };
        const result = await llm.runTurn(traced);
        call.model = result.history.model;
        call.response = {
          text: result.text,
          messages: appendedMessages(result),
          usage: result.usage,
          toolCallCount: result.toolCallCount,
          stopReason: result.stopReason,
          ...(result.output === undefined ? {} : { output: result.output }),
        };
        return result;
      } catch (error) {
        call.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        call.durationMs = Date.now() - startedAt;
        writeCall(scope, call, via);
      }
    },
  };
}

/** 원문은 제 파일에, 요약은 타임라인에 — 호출이 끝나는 그 자리에서 */
function writeCall(scope: TraceScope, call: TurnTraceCall, via: ReturnType<typeof viaOf>): void {
  try {
    mkdirSync(callsDir(scope.gameId), { recursive: true });
    writeAtomic(traceCallFile(scope.gameId, call.id), JSON.stringify(call));
  } catch (error) {
    console.warn(`[turn-trace] ${scope.gameId} 호출 ${call.id}의 원문을 쓰지 못했습니다:`, error);
  }
  scope.kinds.add("llm.call");
  scope.entries += 1;
  appendEntry(scope, {
    seq: call.seq,
    at: call.at,
    kind: "llm.call",
    data: callEntryOf(call),
    ...via,
  });
}

/* ------------------------------------------------------------------ *
 * 읽기
 * ------------------------------------------------------------------ */

/** 그 호출의 원문 — 상한 밖으로 밀렸거나 없는 이름이면 `null` */
export function traceCall(gameId: string, id: string): TurnTraceCall | null {
  const file = traceCallFile(gameId, id);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as TurnTraceCall;
  } catch {
    return null;
  }
}

/**
 * 기록이 있는 게임들 — CLI가 게임을 지목받지 않았을 때 훑는 자리다.
 *
 * **세이브가 아니라 창고를 센다.** 지워진 게임의 기록도 여기 그대로 서고, 그게 이
 * 창고가 세이브 옆을 떠난 이유다.
 */
export function tracedGames(): string[] {
  try {
    return readdirSync(logDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** 타임라인 한 파일을 기록으로 접는다 — 겉(`turn.*`)은 필드로, 나머지는 `entries`로 */
function foldTimeline(id: string, lines: readonly TurnEntry[]): TurnRecord | null {
  if (lines.length === 0) return null;
  const record: TurnRecord = {
    id,
    shelf: shelfOf(id),
    at: lines[0]!.at,
    gameVersion: "0.0.0",
    index: null,
    durationMs: 0,
    closed: false,
    input: null,
    before: null,
    after: null,
    outcome: null,
    entries: [],
    callIds: [],
  };
  for (const line of [...lines].sort((a, b) => a.seq - b.seq)) {
    const data = (line.data ?? {}) as Record<string, unknown>;
    switch (line.kind) {
      case "turn.open":
        record.at = line.at;
        if (typeof data.gameVersion === "string") record.gameVersion = data.gameVersion;
        break;
      case "turn.note":
        if (data.input !== undefined) record.input = data.input;
        if (data.before !== undefined) record.before = data.before;
        if (data.after !== undefined) record.after = data.after;
        if (data.outcome !== undefined) record.outcome = data.outcome as TurnOutcomeNote;
        break;
      case "turn.close":
        record.closed = true;
        if (typeof data.index === "number") record.index = data.index;
        if (typeof data.durationMs === "number") record.durationMs = data.durationMs;
        if (data.outcome !== undefined && data.outcome !== null) {
          record.outcome = data.outcome as TurnOutcomeNote;
        }
        break;
      case "llm.call":
        record.entries.push(line);
        if (typeof data.id === "string") record.callIds.push(data.id);
        break;
      default:
        record.entries.push(line);
    }
  }
  if (!record.closed) {
    // 닫히지 못한 턴 — 마지막 항목까지가 그 턴이 살았던 시간이다
    const last = lines[lines.length - 1]!;
    record.durationMs = Math.max(0, new Date(last.at).getTime() - new Date(record.at).getTime());
  }
  return record;
}

/** 그 이름의 턴 기록 — 상한 밖으로 밀렸거나 없는 이름이면 `null` */
export function turnRecordById(gameId: string, id: string): TurnRecord | null {
  return foldTimeline(id, readLines<TurnEntry>(turnRecordFile(gameId, id)));
}

/** 기록에서 목록 한 줄을 — 닫히지 못한 턴이 목록에 서는 길 */
function indexLineOf(record: TurnRecord): TurnIndexLine {
  return {
    id: record.id,
    shelf: record.shelf,
    at: record.at,
    gameVersion: record.gameVersion,
    index: record.index,
    ok: record.closed ? (record.outcome?.ok ?? null) : null,
    error: record.outcome?.error ?? null,
    durationMs: record.durationMs,
    entries: record.entries.length,
    kinds: [...new Set(record.entries.map((entry) => entry.kind))],
    callIds: record.callIds,
    head: headOf(record.input),
  };
}

/**
 * 목록 — 두 선반이 닫힌 순서 그대로. `shelf`를 주면 그 선반만.
 *
 * **닫히지 못한 턴도 선다**: 목록에는 없지만 타임라인 파일이 있는 턴(프로세스가 도중에
 * 죽었다)은 그 파일을 접어 세운다. 기록이 없는 것과 기록이 끊긴 것이 갈려야 한다.
 */
export function tracedTurns(gameId: string, shelf?: TraceShelf): TurnIndexLine[] {
  const listed = readLines<TurnIndexLine>(indexFile(gameId));
  const known = new Set(listed.map((line) => line.id));
  const orphans: TurnIndexLine[] = [];
  for (const dir of ["turns", "board"] as const) {
    let files: string[];
    try {
      files = readdirSync(shelfDir(gameId, dir));
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      if (known.has(id)) continue;
      const record = turnRecordById(gameId, id);
      if (record !== null) orphans.push(indexLineOf(record));
    }
  }
  const all =
    orphans.length === 0
      ? listed
      : [...listed, ...orphans].sort((a, b) => a.at.localeCompare(b.at));
  return shelf === undefined ? all : all.filter((line) => line.shelf === shelf);
}

/**
 * 그 채팅 자리의 턴 기록 — 같은 자리에 둘 이상이면 **마지막 것**이다.
 *
 * 실패한 턴은 자리를 갖지 않으므로(`index: null`) 그다음 성공한 턴이 같은 자리에
 * 앉는다 — 실패한 기록은 이름으로만 열린다 (`turnRecordById`).
 */
export function turnRecord(gameId: string, index: number): TurnRecord | null {
  const line = tracedTurns(gameId, "turns")
    .filter((entry) => entry.index === index)
    .at(-1);
  return line === undefined ? null : turnRecordById(gameId, line.id);
}

/** 옛 묶음 파일이 남긴 턴 인덱스들 */
function legacyIndexes(gameId: string): number[] {
  try {
    return readdirSync(traceDir(gameId))
      .map((name) => LEGACY_TURN_FILE.exec(name)?.[1])
      .filter((digits): digits is string => digits !== undefined)
      .map(Number);
  } catch {
    return [];
  }
}

/** 옛 묶음 파일이 든 호출 이름들 — 없으면 빈 배열이다 */
function legacyBundle(gameId: string, index: number): string[] {
  const file = legacyTurnFile(gameId, index);
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const ids = (parsed as { callIds?: unknown }).callIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 그 채팅 턴에 오간 호출의 원문들 — 기록이 없으면 빈 배열이다 (상한 밖으로 밀린 턴,
 * 묶이지 못한 턴, 모의 GM의 턴이 그렇다). 원문이 밀린 호출은 **건너뛴다** — 이름만
 * 남은 자리를 빈 껍데기로 세우면 창이 열리긴 하는데 읽을 것이 없다.
 */
export function turnTrace(gameId: string, index: number): TurnTraceCall[] {
  const record = turnRecord(gameId, index);
  const ids = record === null ? legacyBundle(gameId, index) : record.callIds;
  const calls: TurnTraceCall[] = [];
  for (const id of ids) {
    const call = traceCall(gameId, id);
    if (call !== null) calls.push(call);
  }
  return calls;
}

/**
 * 호출 이름 → 그 호출이 선 채팅 턴. 묶이지 못한 호출(실패한 턴)은 없다.
 * 옛 묶음이 먼저, 턴 목록이 그 위에 — 같은 호출이 둘 다에 있으면 목록이 이긴다.
 */
export function tracedTurnOf(gameId: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const index of legacyIndexes(gameId)) {
    for (const id of legacyBundle(gameId, index)) map.set(id, index);
  }
  for (const line of tracedTurns(gameId, "turns")) {
    if (line.index === null) continue;
    for (const id of line.callIds) map.set(id, line.index);
  }
  return map;
}

/** 옛 창고의 호출 목록 한 줄 — `calls.jsonl`이 들던 모양. 읽기만 한다 */
interface LegacyCallLine {
  id: string;
  at: string;
  gameVersion: string;
  seq: number;
  parentId: string | null;
  viaTool: string | null;
  agent: AgentName;
  model: string | null;
  durationMs: number;
  usage: TurnUsage | null;
  toolCallCount: number;
  error: string | null;
}

/**
 * 호출 목록 — 타임라인의 `llm.call` 항목 전부에 턴의 자리를 얹은 것, 시간순.
 * 옛 창고(`calls.jsonl`)의 호출도 함께 선다 — 턴은 모른 채로.
 */
export function tracedCalls(gameId: string): CallLine[] {
  const rows = new Map<string, CallLine>();
  for (const legacy of readLines<LegacyCallLine>(legacyCallsFile(gameId))) {
    rows.set(legacy.id, {
      ...legacy,
      stopReason: null,
      request: { chars: 0, systemBlocks: 0, historyMessages: 0, tools: 0 },
      response: null,
      turn: null,
      index: null,
    });
  }
  for (const line of tracedTurns(gameId)) {
    const record = turnRecordById(gameId, line.id);
    if (record === null) continue;
    for (const entry of record.entries) {
      if (entry.kind !== "llm.call") continue;
      const data = entry.data as LlmCallEntry;
      rows.set(data.id, {
        ...data,
        at: entry.at,
        gameVersion: record.gameVersion,
        seq: entry.seq,
        turn: record.id,
        index: record.index,
      });
    }
  }
  return [...rows.values()].sort((a, b) => a.at.localeCompare(b.at));
}

/* ------------------------------------------------------------------ *
 * 상한
 * ------------------------------------------------------------------ */

/** 디렉터리의 파일을 **오래된 순**으로 — 상한은 최근 것을 남긴다 */
function oldestFirst(dir: string, suffix: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(suffix));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const file = path.join(dir, name);
      let mtime = 0;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        // 지우는 사이에 사라진 파일 — 가장 오래된 것으로 친다
      }
      return { file, mtime };
    })
    .sort((a, b) => a.mtime - b.mtime)
    .map((entry) => entry.file);
}

/**
 * 상한을 넘긴 기록을 지운다 — **턴 범위가 닫힐 때 한 번.**
 *
 * 순서는 파일의 시각이 정한다 — 목록이 아니라. 목록에 없는 파일(닫히지 못한 턴, 쓰다 만
 * 원문)도 같은 눈금으로 늙어 나가므로 방금 죽은 턴의 기록이 다음 턴에 지워지지 않는다.
 */
function pruneTraces(gameId: string, limits: TraceLimits): void {
  try {
    const calls = oldestFirst(callsDir(gameId), ".json");
    for (const file of calls.slice(0, Math.max(0, calls.length - limits.calls))) {
      rmSync(file, { force: true });
    }
    let pruned = false;
    for (const shelf of ["turns", "board"] as const) {
      const cap = shelf === "turns" ? limits.turns : limits.board;
      const files = oldestFirst(shelfDir(gameId, shelf), ".jsonl");
      for (const file of files.slice(0, Math.max(0, files.length - cap))) {
        rmSync(file, { force: true });
        pruned = true;
      }
    }
    // 목록은 파일을 따른다 — 지운 뒤에만 다시 쓰고, 파일이 남은 줄만 남긴다
    if (pruned) {
      const kept = readLines<TurnIndexLine>(indexFile(gameId)).filter((line) =>
        existsSync(turnRecordFile(gameId, line.id)),
      );
      writeAtomic(indexFile(gameId), `${kept.map((line) => JSON.stringify(line)).join("\n")}\n`);
    }
    // 옛 묶음 파일 — 더 쓰지는 않지만 남아 있는 것은 같은 상한으로 민다
    const legacy = legacyIndexes(gameId).sort((a, b) => a - b);
    for (const index of legacy.slice(0, Math.max(0, legacy.length - limits.turns))) {
      rmSync(legacyTurnFile(gameId, index), { force: true });
    }
  } catch (error) {
    console.warn(`[turn-trace] ${gameId}의 지난 기록을 정리하지 못했습니다:`, error);
  }
}

/**
 * ⚠️ **기록을 지우는 함수는 없다.** 게임을 지우는 자리에서 기록까지 지우면, 되짚어
 * 고치는 일이 게임을 지우는 순간 끝난다 — 개선의 재료를 게임의 수명에 묶지 않는다.
 * 디스크를 쥐는 것은 상한뿐이고(`pruneTraces`), 창고를 통째로 비우는 것은 사람이
 * 디렉터리를 지우는 일이다 (`pnpm log --games`가 어디에 얼마나 쌓였는지 적는다).
 */
