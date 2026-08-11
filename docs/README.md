# story-fm 기획서

**이 게임이 지금 어떻게 동작하는가**의 단일 소스. 결정 로그도 변경 이력도 없다 —
그건 git이 한다. 각 문서는 "오늘의 사실"만 담는다.

처음이면 **[overview.md](overview.md)** 하나로 전체 그림이 잡힌다 — 세 층이
어떻게 이어지고 한 턴이 어떤 길로 지나가는지가 거기 있다.

## 폴더가 곧 층이다

| 폴더 | 무엇 | 성격 |
| --- | --- | --- |
| [data/](data/) | 무엇이 존재하는가 — 선수·팀·대회·인물·세이브 | 카탈로그와 상태 |
| [simulation/](simulation/) | 무엇이 일어나는가 — 경기·시즌·이적·재정·커리어 | 결정적 순수 함수 |
| [llm/](llm/) | 그것을 어떻게 말하는가 — 모델·에이전트·프롬프트 | 상태를 못 바꾼다 |

## 무엇을 하려는가

| 하려는 일 | 읽을 것 |
| --- | --- |
| 게임이 뭔지 알고 싶다 | [overview.md](overview.md) |
| 선수 능력치·성장·자리를 만진다 | [data/player.md](data/player.md) |
| 구단·스쿼드 구성을 만진다 | [data/team.md](data/team.md) |
| 대회 규정을 만진다 | [data/competition.md](data/competition.md) |
| 경기 결과·밸런스를 만진다 | [simulation/match.md](simulation/match.md) |
| 일정·tick·시즌 전환을 만진다 | [simulation/season.md](simulation/season.md) |
| 이적·계약을 만진다 | [simulation/transfer.md](simulation/transfer.md) |
| 구단 살림을 만진다 | [simulation/finance.md](simulation/finance.md) |
| 감독 성장·보드를 만진다 | [simulation/career.md](simulation/career.md) |
| 대사·화자·인물을 만진다 | [data/people.md](data/people.md) |
| LLM 호출을 추가·변경한다 | [llm/models.md](llm/models.md) · [llm/agents.md](llm/agents.md) |
| 프롬프트·스킬 표면을 만진다 | [llm/prompts.md](llm/prompts.md) |
| 엔티티·세이브 구조를 만진다 | [data/game-state.md](data/game-state.md) |
| 선수/팀 데이터를 갈아 끼운다 | [data/sources.md](data/sources.md) |

## 문서 쓰는 규칙

- **지금 상태만 쓴다.** "예전엔 …였다", "2026-08-08 요청으로", "v0.2에서 바꿨다"
  같은 문장을 넣지 않는다. 왜 그렇게 됐는지가 궁금하면 `git log`가 답한다.
- 각 문서는 같은 골격을 쓴다: **요약 → 동작 방식 → 수치 표 → ⚠️ 불변식 →
  미해결 → 코드 위치**.
- **⚠️ 불변식에만 이유를 적는다.** 값·구조를 바꾸면 조용히 깨지는 것에만 한 줄씩.
  나머지 판단 근거는 적지 않는다 — 문서가 길어지면 아무도 안 읽는다.
- **한 주제의 원본은 한 문서.** 다른 문서의 영역은 링크로 넘기고 복제하지 않는다.
- 코드가 바뀌면 **문서를 먼저** 고친다. 문서와 코드가 어긋나면 코드가 맞다 —
  그건 문서의 버그다.

> 비전과 개발 규약은 저장소 루트의 [AGENTS.md](../AGENTS.md)에 있다.
