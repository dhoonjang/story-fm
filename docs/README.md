# story-fm 문서

story-fm은 자연어로 감독이 되어 서사·협상·경기를 즐기는 게임이다.
[서비스 개요](overview.md)와 [책임 구조](architecture.md)부터 읽는다.

| 도메인                               | 설명                                  | 문서                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Story](story/README.md)             | 훈련·일상, 로어북과 요약, 보드·커리어 | [로어북](story/lorebook.md) · [인물](story/people.md) · [보드](story/board.md) · [커리어](story/career.md)                                                               |
| [Negotiation](negotiation/README.md) | 에이전트 센터·협상·메디컬·세계 시장   | [협상](negotiation/README.md)                                                                                                                                            |
| [Match](match/README.md)             | 전술·실시간 경기·개입·대회            | [경기](match/match.md) · [라이브](match/live-match.md) · [대회](match/competition.md) · [축구 규칙](match/football-reference.md)                                         |
| [Common](common/README.md)           | 선수·팀 정보와 세계 상태, 기반 규약   | [선수](common/player.md) · [팀](common/team.md) · [저장 상태](common/game-state.md) · [시즌](common/season.md) · [데이터](common/sources.md) · [재정](common/finance.md) |

공통 기반: [에이전트](common/llm/agents.md) · [파이프라인](common/llm/pipeline.md) ·
[프롬프트](common/llm/prompts.md) · [모델 설정](common/llm/models.md) ·
[화면 규약](common/ui/design-system.md) · [밸런스 관측](common/balance-harness.md).

문서는 현재 동작과 소유권을 설명한다.
