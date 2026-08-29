/**
 * 턴이 모델과 주고받은 원문 (models.md §5).
 *
 * 계측은 토큰 수만 센다(`usage-meter.ts`) — 프롬프트가 잘못 나갔는지, 모델이
 * 이상하게 답했는지, 코어가 그걸 잘못 옮겼는지를 가르려면 **그 턴에 무엇이
 * 오갔는가**를 봐야 한다. 그때마다 서버에 `console.log`를 심어 재현하던 왕복을
 * 없애는 것이 이 모듈의 전부다.
 *
 * 세 가지가 경계다:
 *
 * 1. **세이브에 넣지 않는다.** 시스템 프롬프트와 이력 원문은 턴마다 수만 토큰이고
 *    세이브는 이미 수 MB다. 세이브 옆의 게임별 사이드카 디렉터리에 턴 하나를 파일
 *    하나로 두고 최근 N턴만 남긴다 — 프로세스 메모리가 아니라 디스크라 dev 서버가
 *    재시작해도 이전 턴이 그대로 열린다.
 * 2. **production에서는 아무 파일도 쓰지 않는다.** 라우트도 화면도 같은 기준으로
 *    닫힌다.
 * 3. **키는 호출이 아니라 채팅 턴이다.** 한 채팅 턴은 LLM 호출 하나가 아니다 —
 *    평시 턴은 `gm` + 결산 raters, 경기 턴은 `match-gm`과 그 도구 뒤의
 *    `tactic-orders`·`finalize-match`가 함께 돈다. 그 왕복
 *    전부가 턴 하나 아래 순서대로 붙는다.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { agentMinCacheableInput, type AgentName, type LlmEnv } from "./config";
import {
  isStoredLlmHistory,
  type GameLLM,
  type JsonObjectSchema,
  type StopReason,
  type TurnHistory,
  type TurnRequest,
  type TurnResult,
  type TurnUsage,
} from "./game-llm";

/**
 * 게임당 남는 채팅 턴 수 — 넘치면 오래된 턴 파일부터 지운다.
 *
 * 한 턴이 수백 KB다(시스템 프롬프트 + 이력). 개발 중 되짚는 범위는 방금 벌어진
 * 몇 턴이라, 상한을 키워 디스크를 무는 대신 짧게 자른다.
 */
export const MAX_TRACED_TURNS = 20;

/** 도구 스펙 원문 — `handle`은 함수라 기록에 남기지 않는다 */
export interface TurnTraceTool {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
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
}

/** 호출 하나의 왕복 */
export interface TurnTraceCall {
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

/** 개발 모드인가 — 기록·라우트·제스처가 모두 이 하나를 본다 */
export function traceEnabled(env: LlmEnv = process.env): boolean {
  return env.NODE_ENV !== "production";
}

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
    })),
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

/* ------------------------------------------------------------------ *
 * 어느 호출이 이 턴의 것인가 — **실행 문맥이 정한다.**
 *
 * 시각이나 전역 큐로 가르면 두 게임이 같은 프로세스에서 동시에 턴을 돌릴 때 남의
 * 호출이 섞인다. `traceTurn` 안에서 일어난 호출만 그 턴에 쌓인다.
 * ------------------------------------------------------------------ */

const collecting = new AsyncLocalStorage<TurnTraceCall[]>();

/**
 * 한 채팅 턴의 범위를 연다 — 이 안에서 일어난 모델 호출이 모인다.
 *
 * 모아 둔 것을 턴 인덱스에 묶는 것은 `bindTurnTrace`이고, 부르지 않으면 범위가
 * 끝날 때 그대로 버려진다 (실패한 턴은 채팅에 남지 않으므로 묶을 자리도 없다).
 */
export function traceTurn<T>(run: () => Promise<T>, env: LlmEnv = process.env): Promise<T> {
  if (!traceEnabled(env)) return run();
  return collecting.run([], run);
}

/* ------------------------------------------------------------------ *
 * 저장소 — 게임별 사이드카 디렉터리에 턴 하나가 파일 하나다.
 *
 *   <데이터 디렉터리>/<gameId>.trace/<index>.json
 *
 * 세이브 본체(`<gameId>.json`)와 같은 자리에 두되 **디렉터리**라, 세이브 목록이
 * `.json` 파일만 세는 규칙에 걸리지 않고 게임을 지울 때 통째로 지운다. 파일 하나가
 * 턴 하나라 새 턴을 묶을 때 그 턴만 쓰고, 오래된 턴은 파일만 지운다.
 * ------------------------------------------------------------------ */

/**
 * 데이터 디렉터리 — 엔진의 `paths.ts`와 같은 규칙이다. 이 패키지는 엔진에 기대지
 * 않으므로 규칙만 같이 든다; 세이브가 사는 곳에 사이드카가 산다.
 */
function dataDir(): string {
  return process.env.STORY_FM_DATA_DIR ?? path.join(process.cwd(), ".data");
}

function traceDir(gameId: string): string {
  return path.join(dataDir(), `${gameId}.trace`);
}

/** 턴 파일 이름 — 인덱스가 곧 이름이라 목록에서 오래된 쪽을 셀 수 있다 */
const TURN_FILE = /^(\d+)\.json$/;

function turnFile(gameId: string, index: number): string {
  return path.join(traceDir(gameId), `${index}.json`);
}

/** tmp에 완전히 쓴 뒤 rename — 쓰다 죽어도 반쪽 파일이 이름을 갖지 않는다 */
function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, contents, "utf8");
  renameSync(tmp, file);
}

/** 디렉터리에 남은 턴 인덱스들 — 없거나 읽지 못하면 빈 배열이다 */
function tracedIndexes(gameId: string): number[] {
  try {
    return readdirSync(traceDir(gameId))
      .map((name) => TURN_FILE.exec(name)?.[1])
      .filter((digits): digits is string => digits !== undefined)
      .map(Number);
  } catch {
    return [];
  }
}

/** 상한을 넘긴 만큼 낮은 인덱스부터 지운다 — 채팅은 앞으로만 자라므로 낮은 쪽이 오래된 턴이다 */
function dropOldest(gameId: string): void {
  const indexes = tracedIndexes(gameId).sort((a, b) => a - b);
  for (const index of indexes.slice(0, Math.max(0, indexes.length - MAX_TRACED_TURNS))) {
    rmSync(turnFile(gameId, index), { force: true });
  }
}

/**
 * 이 범위에 쌓인 호출을 채팅 턴 인덱스에 묶는다 — **model 턴을 `state.chat`에
 * 밀어 넣는 그 자리에서** 부른다. 인덱스가 그 턴의 자리와 어긋나면 화면은 남의
 * 턴을 연다.
 *
 * 같은 자리를 다시 묶으면 최신 것이 남는다. 쓰지 못해도(디스크·권한) 턴은 그대로
 * 간다 — 기록은 턴의 결과가 아니다.
 */
export function bindTurnTrace(gameId: string, index: number): void {
  const calls = collecting.getStore();
  if (calls === undefined || calls.length === 0) return;
  try {
    mkdirSync(traceDir(gameId), { recursive: true });
    writeAtomic(turnFile(gameId, index), JSON.stringify(calls));
    dropOldest(gameId);
  } catch (error) {
    console.warn(`[turn-trace] ${gameId} 턴 ${index}의 원문을 쓰지 못했습니다:`, error);
  }
}

/** 그 턴에 오간 호출들 — 기록이 없으면 빈 배열이다 (상한 밖으로 밀린 턴, 모의 GM의 턴이 그렇다) */
export function turnTrace(gameId: string, index: number): TurnTraceCall[] {
  const file = turnFile(gameId, index);
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? (parsed as TurnTraceCall[]) : [];
  } catch {
    // 쓰다 만 파일은 rename 전이라 이 이름을 갖지 않는다 — 여기 오면 밖에서 손댄 파일이다
    return [];
  }
}

/** 그 게임의 기록을 통째로 지운다 — 게임을 지우는 자리에서 함께 부른다 */
export function deleteTurnTraces(gameId: string): void {
  rmSync(traceDir(gameId), { recursive: true, force: true });
}

/**
 * 원문을 따는 `GameLLM` — 계약이 같으므로 부르는 쪽은 감싼 줄 모른다.
 *
 * 계측·시한과 같은 자리(`createGameLLM`)에 붙는다. 모든 실호출이 그 문 하나를
 * 지나므로 어댑터 세 곳을 건드리지 않는다.
 *
 * **실패한 호출도 적는다** — 시한을 넘긴 턴, 이력이 400을 맞은 턴이 원문을 가장
 * 보고 싶은 자리다.
 */
export function tapLlm(llm: GameLLM, agent: AgentName, env: LlmEnv = process.env): GameLLM {
  if (!traceEnabled(env)) return llm;
  return {
    async runTurn(req: TurnRequest): Promise<TurnResult> {
      const calls = collecting.getStore();
      // 턴 범위 밖의 호출은 묶을 자리가 없다 (CLI·테스트) — 기록하지 않는다
      if (calls === undefined) return llm.runTurn(req);

      const request = traceRequest(req);
      const startedAt = Date.now();
      const call: TurnTraceCall = {
        agent,
        model: null,
        minCacheableInput: agentMinCacheableInput(agent),
        durationMs: 0,
        request,
        response: null,
        error: null,
      };
      // 응답을 기다리기 전에 자리를 잡는다 — 한 턴의 호출 순서가 기록의 순서다
      calls.push(call);
      try {
        const result = await llm.runTurn(req);
        call.model = result.history.model;
        call.response = {
          text: result.text,
          messages: appendedMessages(result),
          usage: result.usage,
          toolCallCount: result.toolCallCount,
          stopReason: result.stopReason,
        };
        return result;
      } catch (error) {
        call.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        call.durationMs = Date.now() - startedAt;
      }
    },
  };
}
