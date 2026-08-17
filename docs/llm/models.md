# 모델과 제공자 — 설정 · 어댑터 · 예산

**에이전트마다 제공자와 모델을 따로 정한다.** 한 회사가 모든 자리에서 가장 좋거나
가장 싸지는 않아서, 자리마다 맞는 곳으로 보낸다. 그 배치는 코드가 아니라
**`config/llm.yml` 하나**가 갖는다 — 모델을 바꾸는 데 코드 diff가 필요 없다.

누가 무엇을 하는지는 [agents.md](./agents.md), 모델에게 무엇을 어떻게 말하는지는
[prompts.md](./prompts.md).

## 1. 설정 파일 (`config/llm.yml`)

```yaml
version: 1
agents:
  gm:            { provider: google, model: gemini-3.6-flash,      max_tokens: 64000, timeout_ms: 180000 }
  match-intent:  { provider: google, model: gemini-3.5-flash-lite, max_tokens: 16000, timeout_ms: 60000 }
  match-caster:  { provider: google, model: gemini-3.6-flash,      max_tokens: 64000, timeout_ms: 180000 }
  match-rater:   { provider: google, model: gemini-3.5-flash-lite, max_tokens: 8000,  timeout_ms: 30000 }
  training-rater:{ provider: google, model: gemini-3.5-flash-lite, max_tokens: 8000,  timeout_ms: 30000 }
  mood-rater:    { provider: google, model: gemini-3.5-flash-lite, max_tokens: 8000,  timeout_ms: 30000 }
```

| 에이전트 | 담당 | 출력 상한 | 시한 |
| --- | --- | --- | --- |
| `gm` | 평시 서사 · 의도 해석 · 판정 | 64,000 | 180초 |
| `match-intent` | 경기 중 감독의 말 → 의도 | 16,000 | 60초 |
| `match-caster` | 경기 중계 · 벤치 대화 | 64,000 | 180초 |
| `match-rater` | 경기 평점 재채점 | 8,000 | 30초 |
| `training-rater` | 훈련 결산 | 8,000 | 30초 |
| `mood-rater` | 심경 한 줄 | 8,000 | 30초 |

- **해석이 싼 자리로 가는 이유는 그 일이 판단이 아니라 분류이기 때문**이다 — 무엇을
  하라는 말인지 고르는 것이고, 그것이 사실인지와 얼마나 먹히는지는 코어가 정한다.
  경기 한 턴이 두 호출이 됐으므로(agents.md §3) 여기서 지연을 갚아야 한다.
- **중계가 가벼운 이유는 사건을 코어가 정하기 때문**이다 — 모델은 xg가 굴린 결과를
  문장으로 옮길 뿐인데 90분에 스무 번 도니 지연이 곧 게임 속도다
  ([../simulation/match.md](../simulation/match.md) §2).
- **결산 셋이 싼 자리로 가는 이유는 값이 아니라 빈도**다. 출력이 코어 앵커 ± 한도
  안에서만 움직여서 모델이 무뎌도 장부가 흔들리지 않는다 (agents.md §4).
- **결산 셋을 따로 적는다** — 셋을 하나로 묶으면 그중 하나만 다른 모델로 보낼 수
  없다. 지금은 심경만 더 싼 곳으로 옮기는 것이 YAML 한 줄이다.
- 제공자별 옵션(thinking level 등)은 그 에이전트 항목이 함께 갖는다.

## 1-1. 시한 (`timeout_ms`)

**`timeout_ms`는 `runTurn` 한 번 전체의 시한이다** — 도구 왕복 8회까지 포함한 한 턴이
그 안에 끝나거나 실패한다. 제공자 SDK의 기본값에 맡기지 않는다: 셋이 서로 다르고
어느 문서에도 적혀 있지 않아, 같은 설정으로 도는 세 어댑터가 서로 다른 계약을 지키게
된다.

- **시한은 팩토리가 건다** — 계측과 같은 자리다(`createGameLLM`). 모든 실호출이 그 문
  하나를 지나므로 어댑터 셋에 같은 코드가 복제되지 않는다.
- **어댑터는 같은 `AbortSignal`을 SDK에 넘긴다** — 거는 방식은 제공자마다 다르다
  (Anthropic·OpenAI는 요청 옵션의 `signal`·`timeout`, Gemini는 설정의 `abortSignal`·
  `httpOptions.timeout`). 넘기지 않으면 시한이 지나도 소켓이 그대로 살아 남는다.
- ⚠️ **시한이 지나면 팩토리가 그 자리에서 실패를 만든다** — SDK가 신호를 무시해도
  `runTurn`의 프로미스는 반드시 끝난다. 이것이 없으면 시한은 있으나 마나다.
- **넘긴 호출은 이미 있는 실패 경로로 간다.** 새 상태를 만들지 않는다 — GM·중계는
  오류가 올라가 화면이 배너로 알리고, 결산 셋은 삼키고 **코어 앵커가 남는다**
  (agents.md §1·§4). 오류 문구는 `turnErrorMessage`의 "응답이 지연돼 턴을 취소했습니다".

**왜 시한이 없으면 게임이 멎는가** — 한 게임의 턴·전술판 저장·스쿼드 편집은 프로세스
안 뮤텍스 하나를 나눠 쓴다(`withGameLock`). 그 뮤텍스에는 시한이 없어서, 끝나지 않는
LLM 호출 **하나**가 그 세이브의 모든 후속 요청을 영영 붙든다. 잠금에 시한을 거는 것은
답이 아니다 — 두 요청이 같은 세이브를 동시에 쓰는 길이 열린다. 호출이 반드시 끝나면
사슬은 저절로 풀린다.

**라우트는 응답을 반드시 마감한다** — 턴 라우트 둘 다 `maxDuration`을 갖고, 스트리밍
턴은 조용한 동안 `{"type":"ping"}`을 흘려 연결이 살아 있음을 알린다. 화면은 그 신호가
끊기면 요청을 끊고 같은 실패 배너를 세운다 — 기다림이 끝나지 않는 자리는 없다.

## 2. 설정을 읽는 규칙

- **시작할 때 Zod로 검증한다**(`parseLlmConfig`) — 빠졌거나 잘못된 설정은 첫 호출
  전에 실패한다. 알 수 없는 에이전트 이름도 여기서 걸린다.
- ⚠️ **키가 없으면 다른 제공자로 폴백하지 않는다** — 그 에이전트는 그 자리에서
  실패한다(`createGameLLM`). 조용한 폴백이 있으면 설정과 실제로 도는 모델이 갈려
  "GM은 멀쩡한데 중계만 무뎌진" 이유를 알 수 없다.
- ⚠️ **제공자 선택 환경변수는 없다.** 환경변수로 남는 것은 **키**와 `LLM_MODE`,
  토큰 예산뿐이다 — 배치는 전부 YAML이 갖는다.

| 제공자 | 키 |
| --- | --- |
| anthropic | `ANTHROPIC_API_KEY` |
| google | `GOOGLE_API_KEY` \| `GEMINI_API_KEY` |
| openai | `OPENAI_API_KEY` |

**`LLM_MODE=mock|real`** — 미지정이면 GM 에이전트의 제공자 키가 있는지로 정한다.
mock은 폴백이 아니라 **모드**이고 규칙 기반 오케스트레이터가 대신 돈다 (agents.md §8).

## 3. 어댑터 — 제공자 중립 계약 하나 (`GameLLM`)

```
runTurn({ system, history, user, stateNote?, tools?, maxTokens?, onText?, signal? })
  → { text, history: StoredLlmHistory, usage, toolCallCount, stopReason }
```

- `system`은 **블록 배열**이다 — 앞이 더 안정적인 순서로 배치해 캐시 프리픽스를 만든다.
- 도구는 `GameToolSpec` — 제공자 중립 JSON Schema + `handle()`. 검증 실패·규칙 위반은
  한국어 메시지로 돌아가 모델이 고쳐 다시 부른다.
- 한 턴의 도구 왕복 상한은 셋 다 **8회**(`MAX_TOOL_ITERATIONS`).
- `signal`은 **팩토리가 시한에서 만들어 넣는다** — 호출하는 쪽(agents)이 주는 값이
  아니다. 어댑터는 그 신호를 자기 SDK가 아는 자리로 옮기기만 한다 (§1-1).
- 이력은 **제공자·모델로 태깅해 저장**한다(`StoredLlmHistory`). 태그가 다르면 그 이력은
  버리고 새로 시작한다 — 장부와 패킷이 남아 있어 경기는 이어진다.
- `stateNote`(휘발 상태 스냅샷)는 어느 어댑터에서든 **저장 이력에 남기지 않는다**.

| 어댑터 | 캐싱 | 상태 스냅샷 자리 | 사고 | 시한을 거는 자리 |
| --- | --- | --- | --- | --- |
| Anthropic | `cache_control` 브레이크포인트(요청당 4개) | `role:"system"` 오퍼레이터 채널 | `thinking: disabled` | `messages.stream(body, { signal, timeout })` |
| Gemini | implicit (동일 프리픽스) | 유저 발화 앞에 접어 넣음 | `ThinkingLevel.MINIMAL` | `chats.create`의 `config.abortSignal`·`httpOptions.timeout` |
| OpenAI | 자동 프롬프트 캐시 | `role:"developer"` | `reasoning_effort: "none"` | `chat.completions.create(body, { signal, timeout })` |

**Anthropic** — ⚠️ **화면에 흘릴 곳이 없어도 스트리밍으로 부른다.** SDK가
`max_tokens > 21,333`인 비스트리밍 요청을 보내기도 전에 거부한다
(`calculateNonstreamingTimeout`). `onText`는 델타를 받을지만 가르고 최종 메시지는 같다.
`input_tokens`가 캐시분을 빼고 오므로 어댑터가 되돌려 놓는다(§4). 미해결 `tool_use`가
마지막 턴에 남으면 합성 `tool_result`로 닫는다 — 안 닫으면 그 이력을 재사용하는 다음
요청이 400이다. `role:"system"` 중간 메시지를 거부하는 모델은 한 번 400을 맞은 뒤
유저 발화에 접어 넣는 폴백으로 고정된다.

**Gemini** — thought signature와 function call id를 위치까지 그대로 보존해야 해서 SDK
Chat 이력을 원형으로 저장한다. 스트리밍은 chunk마다 model content를 따로 남기므로
이번 응답의 **모든** model content에서 함수 호출을 훑는다.

**OpenAI** — ⚠️ **Chat Completions에서 함수 도구와 추론을 함께 쓰지 못한다** —
`reasoning_effort: "none"`이라야 한다(아니면 `/v1/responses`). 사고를 최소로 두는 결산
자리에서는 어긋나지 않지만, 서사를 이쪽으로 보내면 Responses API로 갈아타야 하고 그때
저장 이력의 모양이 통째로 바뀐다(`messages[]` → input item[]).
스트리밍의 도구 호출은 **`index`가 자리를 정하고**(id·이름은 첫 조각에만, 인자는 문자
단위로 쪼개져 온다), 사용량은 `stream_options.include_usage`가 붙여 주는 마지막
chunk에만 실린다 — 그 옵션이 없으면 계측이 이 에이전트를 못 본다.

## 4. 계측과 예산 (`usage-meter.ts`)

계측은 **팩토리 한 곳에 붙는다** — 모든 실호출이 `createGameLLM`을 지나므로 어댑터 셋에
같은 코드를 복제하지 않고도 세션 누적과 상한이 빠짐없이 걸린다. 누적 자체는 순수 함수라
장부를 손으로 굴려 검증한다.

| 무엇 | 값 |
| --- | --- |
| 예산이 세는 것 | `inputTokens + outputTokens` (세션 누적) |
| 상한 | `LLM_TOKEN_BUDGET` — 없거나 0 이하면 무제한 |
| 상한 초과 시 끊기는 에이전트 | 결산 셋뿐 — GM·중계는 계속 돈다 |
| 캐시 히트율 | `cacheReadTokens ÷ inputTokens` |
| 히트율 경고 문턱 | 평균 입력 1,024 토큰 이상 × 3회 이상 호출 × 히트율 0 |
| 장부의 키 | **에이전트 이름** — 설정의 이름이 그대로 계측 키가 된다 |
| 세션 = 프로세스 | `resetLlmUsage()` · 읽기는 `llmUsage()` · 한 줄 요약은 `describeUsage()` |

- ⚠️ **`inputTokens`는 캐시분을 포함한 입력 전부**다. Gemini·OpenAI는 프롬프트 합계에
  이미 포함하지만 Anthropic은 빼고 보고하므로 어댑터가 되돌려 놓는다 — 안 그러면 캐시가
  잘 먹을수록 분모가 줄어 히트율이 1을 넘는다.
- **히트율 0은 프리픽스가 조용히 무효화됐다는 신호다** — 고정층에 날짜·id가 섞이면 매 턴
  앞이 바뀌어 뒤가 전부 정가로 읽히는데, 화면엔 아무 증상이 없고 요금만 오른다. 결산의
  짧은 프롬프트는 애초에 캐시가 안 걸려 신호가 아니라서 문턱을 둔다.
- ⚠️ **상한은 게임을 멈추지 않는다.** 넘겨도 GM·중계는 계속 돌고 경고 한 번만 남는다 —
  그 자리에는 대신 세울 값이 없다. 끊기는 것은 결산 셋뿐이고, 그들은 원래 실패하면 앵커가
  남는 계약이라 건너뛴 자리에 이미 코어의 값이 서 있다. 건너뛴 횟수도 장부에 적는다 —
  안 적으면 결산이 왜 비었는지 알 수 없다.

## 5. 개발 모드 원문 열람 (`turn-trace.ts`)

**한 턴이 모델에 보낸 것과 받은 것을 그 자리에서 읽는다.** 채팅에서 턴을 **길게
누르면**(500ms) 그 턴의 호출들이 요청(system 블록 · 이력 · 발화 · 상태 스냅샷 ·
도구 스펙)과 응답(본문 · 이력에 새로 붙은 메시지 · 사용량)까지 원문으로 열린다.
계측이 세는 것은 토큰 수뿐이라(§4), 프롬프트가 잘못 나갔는지 모델이 이상하게
답했는지 코어가 그걸 잘못 옮겼는지를 가를 눈이 없었다.

| 무엇 | 값 |
| --- | --- |
| 기록을 따는 자리 | **팩토리 하나** — `createGameLLM`의 `tapLlm` (계측·시한과 같은 문) |
| 켜지는 조건 | `NODE_ENV !== "production"` — 라우트도 제스처도 같은 기준으로 닫힌다 |
| 사는 곳 | **프로세스 메모리의 링버퍼** — 최근 20 채팅 턴, 넘치면 오래된 턴부터 버린다 |
| 키 | **채팅 턴 인덱스** (`state.chat`의 자리) — 그 아래 호출 여럿이 순서대로 붙는다 |
| 묶는 자리 | `runTurnLocked`(평시·경기)와 `runOnboardingTurn`(첫 장면) — model 턴을 밀어 넣는 그 자리 |
| 라우트 | `GET /api/games/[id]/trace/[index]` — production이면 404 |

- **세이브에는 넣지 않는다.** 시스템 프롬프트와 이력 원문은 턴마다 수만 토큰이고
  세이브는 이미 수 MB다. 서버가 재시작하면 기록이 사라지는 것을 받아들인다 — 지금
  보고 있는 턴을 읽는 도구이지 이력을 남기는 도구가 아니다.
- **한 채팅 턴은 호출 하나가 아니다.** 평시 턴은 `gm` + 결산 raters, 경기 턴은
  `match-intent` + `match-caster` + `match-rater`가 함께 돈다. 그래서 키가 호출이
  아니라 턴이고, 한 턴을 열면 그 턴에 오간 왕복이 **순서대로 전부** 보인다.
- **어느 호출이 이 턴의 것인가는 실행 문맥이 정한다**(`AsyncLocalStorage`). 시각이나
  전역 큐로 가르면 두 게임이 같은 프로세스에서 동시에 턴을 돌릴 때 남의 호출이
  섞인다.
- **감독 발화 턴을 누르면 바로 뒤 model 턴의 기록이 열린다** — 그 발화가 실려 나간
  호출이 거기 있다.
- **응답은 이력에 새로 붙은 메시지만 적는다** — `tool_use`·thinking 블록이 거기
  있고, 프롬프트로 이미 적은 이력을 두 번 적지 않는다.
- ⚠️ **`LLM_MODE=mock`은 기록이 비어 있다.** 모의 GM은 `createGameLLM`을 지나지
  않는다(agents.md §8) — 팝업이 모드를 함께 받아 "모의 GM은 모델을 부르지 않는다"고
  말한다. 빈 기록을 고장으로 읽지 않게 하는 것이 이 한 줄의 일이다.

## 6. ⚠️ 불변식

- **모델 ID는 `config/llm.yml` 밖에 쓰지 않는다.** 코드는 에이전트 이름으로만 부른다.
- **설정 파싱은 순수 함수로 남긴다**(`parseLlmConfig`) — 환경을 읽는 자리가 늘면 설정 검증 테스트가 깨진다.
- **출력 상한은 사고와 본문을 함께 덮는다.** "장면이 몇 줄이니 이만큼"으로 좁히면 본문이
  문장 한복판에서 잘린다. 상한은 상한일 뿐 — 과금은 실제 생성분이다.
- **어댑터가 이력을 평탄화하지 않는다.** thought signature·function call id·thinking
  블록이 사라지면 다음 호출이 실패한다.
- **키가 없으면 폴백하지 않고 실패한다** — 조용한 폴백은 설정과 실제를 갈라놓는다.
- **시한 없는 모델 호출을 만들지 않는다.** 제공자 기본값은 셋이 다르고 적혀 있지도
  않다 — 시한은 `config/llm.yml`에서만 온다.
- **잠금에 시한을 걸지 않는다.** 끝나지 않는 호출은 호출 쪽에서 끝낸다 — 잠금을 시간으로
  풀면 두 요청이 같은 세이브를 동시에 쓴다.

## 7. 미해결

- 계측을 화면에 세울지 — 지금은 `usage-meter.ts`의 `llmUsage()`·`describeUsage()`로 코드에서만
  읽고 `apps/web`에 부르는 자리가 없다. 원문 팝업(§5)은 그 턴의 사용량만 보여 준다.
- OpenAI Responses API 이전 — 서사를 그쪽으로 옮겨 추론이 필요해지는 날.
  `openai-adapter.ts`는 `chat.completions`만 부른다.
- 제공자별 캐시 적중 조건과 최소 프리픽스가 달라 히트율을 에이전트끼리 직접 비교할 수 없다 —
  `cacheHitRate`가 제공자 구분 없이 같은 비를 낸다.

## 코드 위치

| 무엇 | 어디 |
| --- | --- |
| 에이전트별 배치 | `config/llm.yml` |
| 설정 로드·검증 | `packages/llm/src/config.ts` |
| 제공자 중립 계약 | `packages/llm/src/game-llm.ts` |
| 어댑터 3종 | `packages/llm/src/anthropic-adapter.ts` · `gemini-adapter.ts` · `openai-adapter.ts` |
| 제공자 선택 + 계측·시한 부착 | `packages/llm/src/factory.ts` |
| 시한 래퍼 | `packages/llm/src/deadline.ts` |
| 턴 라우트 마감(`maxDuration`·ping) | `apps/web/app/api/games/[id]/turn/route.ts` · `turn/stream/route.ts` |
| 설정 검증 테스트 | `packages/llm/test/agent-config.test.ts` |
| 토큰 계측·예산 상한 | `packages/llm/src/usage-meter.ts` |
| 원문 기록(링버퍼·`tapLlm`) | `packages/llm/src/turn-trace.ts` |
| 턴 인덱스에 묶는 자리 | `apps/web/lib/turn-runner.ts` · `apps/web/app/api/games/route.ts` |
| 원문 라우트(dev 전용) | `apps/web/app/api/games/[id]/trace/[index]/route.ts` |
| 원문 팝업·롱프레스 | `apps/web/components/turn-trace.tsx` · `components/chat.tsx` |
| 모드 해석 (`LLM_MODE`) | `packages/agents/src/gm.ts` (`resolveLlmMode`) |
