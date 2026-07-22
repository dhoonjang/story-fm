# 기획서 (Design Docs)

story-fm의 **기획 단일 소스**. "무엇을 만들 것인가" — 게임 컨셉, 핵심 시스템,
게임 루프, 밸런스, 콘텐츠 설계는 모두 여기에 쌓는다.

> 비전·개발 규약은 루트의 [`AGENTS.md`](../../AGENTS.md) 참고.
> 기술/설계 **결정 기록**은 [`../decisions/`](../decisions/) (ADR) 참고.

## 운영 방식

- 문서 하나 = 주제 하나. 파일명은 kebab-case (`game-loop.md`, `match-sim.md`).
- 작성 중인 초안은 상단에 상태 배지를 단다: 🚧 초안 / 🔬 검토 중 / ✅ 확정.
- **확정된 핵심 시스템만** AGENTS.md 2장에 요약해 옮긴다. 여기가 원본, 거긴 요약.
- 큰 방향 전환은 `../decisions/`에 ADR로 근거를 남긴다.

## 문서 목록

| 문서 | 상태 | 설명 |
| --- | --- | --- |
| [`game-overview.md`](./game-overview.md) | 🚧 초안 | **게임 핵심 기획 (뼈대)** — 메인 채팅(롤플레이)·스킬·경기 시뮬·오피스 4기둥, 결정 사항 |
| [`data-sourcing.md`](./data-sourcing.md) | 🚧 초안 | 선수/팀 데이터 소싱 전략 — 소스 분류·라이선스·MVP 적재 레시피·계층 아키텍처 |
| [`game-loop.md`](./game-loop.md) | 🚧 초안 | 온보딩 · 캘린더 · `advance_time` · daily tick · **시즌 전환(멀티시즌·트로피·업적)** |
| [`match-sim.md`](./match-sim.md) | 🚧 초안 | **LLM 통합 경기 시뮬** — 전력 분석 패킷 · 진행 루프 · 검증 · 분포 모니터링 |
| [`ai-manager.md`](./ai-manager.md) | 🚧 초안 | GM 에이전트 — 턴 파이프라인 · 판정 규약 · 출력 문법 · 안전장치 |
| [`attribute-model.md`](./attribute-model.md) | 🚧 초안 | 6축 능력치 · 상태 보정 · 성장/쇠퇴 · 노출 규약 · **감독 능력치 4축** |
| [`personas.md`](./personas.md) | 🚧 초안 | 페르소나 스키마 · 핵심/템플릿 2계층 · 감독 캐릭터 · 기억 |
| [`narrative.md`](./narrative.md) | 🚧 초안 | 서사 메모리 · 아크 · 중계 스타일 · 다이제스트 · 에필로그 |
| [`economy.md`](./economy.md) | 🚧 초안 | LLM 티어·캐싱 — 멀티 프로바이더 라우팅(GM=Opus, 경기=DeepSeek) · 멀티턴 캐시 |
| [`implementation-notes.md`](./implementation-notes.md) | 📓 기록 | 구현 중 판단·기획 편차 — 합성 스쿼드, mock GM 모드, 수치 초안 |

## 작성 후보 (백로그)

- `balance.md` — 밸런스 수치 튜닝 (attribute-model·match-sim의 계수 확정) — 시뮬 프로토타입 후
- `rating-model.md` — 실측 스탯 → 자체 능력치 산정 모델 (라이선스 부채 청산 장치, data-sourcing §6 ③)
- `club-finance.md` — 구단 재정 모델 (post-MVP 확장 시)
