# 모델과 제공자 — 티어 · 어댑터 · 예산

**프로바이더는 티어가 고른다 — 세트로 묶지 않는다.** 한 회사가 모든 자리에서 가장
좋거나 가장 싸지는 않아서, 자리마다 맞는 곳으로 보낸다. 모델 ID는 코드에 흩지 않고
`packages/llm/src/config.ts` 하나가 갖는다.

누가 무엇을 하는지는 [agents.md](./agents.md), 모델에게 무엇을 어떻게 말하는지는
[prompts.md](./prompts.md).

## 1. 티어 셋

| 티어 | 담당 | 기본 제공자 · 모델 | 출력 상한 |
| --- | --- | --- | --- |
| `gm` | 평시 서사 · 의도 해석 · 판정 | Anthropic `claude-opus-4-8` | 64,000 |
| `match` | 경기 중계 · 벤치 대화 | Google `gemini-3.5-flash-lite` | 64,000 |
| `chore` | 결산 — 훈련 · 경기 평점 · 심경 | OpenAI `gpt-5.6-luna` | 8,000 |

- **중계가 가벼운 이유는 사건을 코어가 정하기 때문**이다 — 모델은 xg가 굴린 결과를
  문장으로 옮길 뿐인데 90분에 스무 번 도니 지연이 곧 게임 속도다
  ([../simulation/match.md](../simulation/match.md) §2).
- **결산이 싼 자리로 가는 이유는 값이 아니라 빈도**다. 출력이 코어 앵커 ± 한도 안에서만
  움직여서 모델이 무뎌도 장부가 흔들리지 않는다 (agents.md §4).
  입력 $0.20 / 출력 $1.20 per 1M — Flash-Lite $0.30/$2.50 · Haiku 4.5 $1.00/$5.00.
- **판정은 GM 티어 고정** — 팀토크·면담·이적 판정 기준이 장면에 따라 흔들리면 안 된다.

## 2. 라우팅 (`tierConfig(name, env)`)

제공자별로 그 티어에서 쓸 모델을 적은 표(`MODELS`)가 있고, 티어는 **모델도 있고 키도
있는 첫 후보**로 간다. 후보 순서는 ① 티어가 고른 곳 ② `LLM_PROVIDER` ③ anthropic →
google → openai. 끝까지 못 찾으면 티어가 고른 곳을 그대로 돌려주고 위에서 mock으로
판정된다.

| 제공자 | gm | match | chore | 키 |
| --- | --- | --- | --- | --- |
| anthropic | `claude-opus-4-8` | `claude-opus-4-8` | `claude-haiku-4-5` | `ANTHROPIC_API_KEY` |
| google | `gemini-3.6-flash` | `gemini-3.5-flash-lite` | `gemini-3.5-flash-lite` | `GOOGLE_API_KEY` \| `GEMINI_API_KEY` |
| openai | — | — | `gpt-5.6-luna` | `OPENAI_API_KEY` |

- ⚠️ **`LLM_PROVIDER`는 전 티어를 갈아엎는 스위치가 아니라 선호 순위**다 — 티어가 고른
  곳에 키가 없을 때 어디로 보낼지만 정한다.
- ⚠️ **키가 없는 제공자로는 보내지 않는다** — 보내면 그 티어만 조용히 mock이 되어
  "GM은 멀쩡한데 중계만 무뎌진" 이유를 알 수 없다.
- ⚠️ **`MODELS`의 빈 칸은 "그쪽으로 안 보낸다"는 뜻**이다. OpenAI에 잡무 모델만 둔 덕에
  키 하나가 없어져도 서사가 그쪽으로 새지 않는다.
- 순수 함수라 테스트가 키 조합을 인자로 갈아 끼운다. `TIERS`는 앱 시작 시 한 번 적용한
  결과다.

**`LLM_MODE=mock|real`** — 미지정이면 그 턴의 티어(평시 GM · 경기 매치)에 키가 있는지로
정한다. mock은 폴백이 아니라 **모드**이고 규칙 기반 오케스트레이터가 대신 돈다
(agents.md §7).

## 3. 어댑터 — 제공자 중립 계약 하나 (`GameLLM`)

```
runTurn({ system, history, user, stateNote?, tools?, maxTokens?, onText? })
  → { text, history: StoredLlmHistory, usage, toolCallCount, stopReason }
```

- `system`은 **블록 배열**이다 — 앞이 더 안정적인 순서로 배치해 캐시 프리픽스를 만든다.
- 도구는 `GameToolSpec` — 제공자 중립 JSON Schema + `handle()`. 검증 실패·규칙 위반은
  한국어 메시지로 돌아가 모델이 고쳐 다시 부른다.
- 한 턴의 도구 왕복 상한은 셋 다 **8회**(`MAX_TOOL_ITERATIONS`).
- 이력은 **제공자·모델로 태깅해 저장**한다(`StoredLlmHistory`). 태그가 다르면 그 이력은
  버리고 새로 시작한다 — 장부와 패킷이 남아 있어 경기는 이어진다.
- `stateNote`(휘발 상태 스냅샷)는 어느 어댑터에서든 **저장 이력에 남기지 않는다**.

| 어댑터 | 캐싱 | 상태 스냅샷 자리 | 사고 |
| --- | --- | --- | --- |
| Anthropic | `cache_control` 브레이크포인트(요청당 4개) | `role:"system"` 오퍼레이터 채널 | `thinking: disabled` |
| Gemini | implicit (동일 프리픽스) | 유저 발화 앞에 접어 넣음 | `ThinkingLevel.MINIMAL` |
| OpenAI | 자동 프롬프트 캐시 | `role:"developer"` | `reasoning_effort: "none"` |

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

**OpenAI** — 잡무 전용이다. ⚠️ **Chat Completions에서 함수 도구와 추론을 함께 쓰지
못한다** — `reasoning_effort: "none"`이라야 한다(아니면 `/v1/responses`). 잡무는 원래
사고를 최소로 두는 자리라 어긋나지 않지만, 서사를 이쪽으로 옮기면 Responses API로
갈아타야 하고 그때 저장 이력의 모양이 통째로 바뀐다(`messages[]` → input item[]).
스트리밍의 도구 호출은 **`index`가 자리를 정하고**(id·이름은 첫 조각에만, 인자는 문자
단위로 쪼개져 온다), 사용량은 `stream_options.include_usage`가 붙여 주는 마지막
chunk에만 실린다 — 그 옵션이 없으면 계측이 이 티어를 못 본다.

## 4. 계측과 예산 (`usage-meter.ts`)

계측은 **팩토리 한 곳에 붙는다** — 모든 실호출이 `createGameLLM`을 지나므로 어댑터 셋에
같은 코드를 복제하지 않고도 세션 누적과 상한이 빠짐없이 걸린다. 누적 자체는 순수 함수라
장부를 손으로 굴려 검증한다.

| 무엇 | 값 |
| --- | --- |
| 예산이 세는 것 | `inputTokens + outputTokens` (세션 누적) |
| 상한 | `LLM_TOKEN_BUDGET` — 없거나 0 이하면 무제한 |
| 상한 초과 시 끊기는 티어 | `chore`뿐 (`SKIPPABLE_TIERS`) |
| 캐시 히트율 | `cacheReadTokens ÷ inputTokens` |
| 히트율 경고 문턱 | 평균 입력 1,024 토큰 이상 × 3회 이상 호출 × 히트율 0 |
| 세션 = 프로세스 | `resetLlmUsage()` · 읽기는 `llmUsage()` · 한 줄 요약은 `describeUsage()` |

- ⚠️ **`inputTokens`는 캐시분을 포함한 입력 전부**다. Gemini·OpenAI는 프롬프트 합계에
  이미 포함하지만 Anthropic은 빼고 보고하므로 어댑터가 되돌려 놓는다 — 안 그러면 캐시가
  잘 먹을수록 분모가 줄어 히트율이 1을 넘는다.
- **히트율 0은 프리픽스가 조용히 무효화됐다는 신호다** — 고정층에 날짜·id가 섞이면 매 턴
  앞이 바뀌어 뒤가 전부 정가로 읽히는데, 화면엔 아무 증상이 없고 요금만 오른다. 잡무의
  짧은 결산 프롬프트는 애초에 캐시가 안 걸려 신호가 아니라서 문턱을 둔다.
- ⚠️ **상한은 게임을 멈추지 않는다.** 넘겨도 GM·중계는 계속 돌고 경고 한 번만 남는다 —
  그 자리에는 대신 세울 값이 없다. 끊기는 것은 잡무뿐이고, 결산은 원래 실패하면 앵커가
  남는 계약이라 건너뛴 자리에 이미 코어의 값이 서 있다. 건너뛴 횟수도 장부에 적는다 —
  안 적으면 결산이 왜 비었는지 알 수 없다.

## 5. ⚠️ 불변식

- **모델 ID는 `config.ts` 밖에 쓰지 않는다.** 티어 이름으로만 부른다.
- **`tierConfig`는 순수 함수로 남긴다** — 환경을 읽는 자리가 늘면 키 조합 테스트가 깨진다.
- **출력 상한은 사고와 본문을 함께 덮는다.** "장면이 몇 줄이니 이만큼"으로 좁히면 본문이
  문장 한복판에서 잘린다. 상한은 상한일 뿐 — 과금은 실제 생성분이다.
- **어댑터가 이력을 평탄화하지 않는다.** thought signature·function call id·thinking
  블록이 사라지면 다음 호출이 실패한다.
- **`config.tier`가 없는 설정은 계측이 감싸지 않는다** — 어댑터를 직접 만드는 테스트용
  경로다. 실행 경로에는 언제나 실려 있다.

## 6. 미해결

- 계측을 화면에 세울지 — 지금은 `llmUsage()`·`describeUsage()`로 코드에서만 읽는다.
- OpenAI Responses API 이전 — 서사를 잡무 티어 밖으로 옮겨 추론이 필요해지는 날.
- 제공자별 캐시 적중 조건과 최소 프리픽스가 달라 히트율을 티어끼리 직접 비교할 수 없다.

## 코드 위치

| 무엇 | 어디 |
| --- | --- |
| 티어·모델 설정, 라우팅 | `packages/llm/src/config.ts` |
| 제공자 중립 계약 | `packages/llm/src/game-llm.ts` |
| 어댑터 3종 | `packages/llm/src/anthropic-adapter.ts` · `gemini-adapter.ts` · `openai-adapter.ts` |
| 제공자 선택 + 계측 부착 | `packages/llm/src/factory.ts` |
| 토큰 계측·예산 상한 | `packages/llm/src/usage-meter.ts` |
| 모드 해석 (`LLM_MODE`) | `packages/agents/src/gm.ts` (`resolveLlmMode`) |
