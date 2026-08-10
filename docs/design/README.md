# 기획서 (Game Design Docs)

게임 컨셉·시스템·밸런스의 단일 소스. **[game-overview.md](./game-overview.md)가
입구**다 — 무엇이 어떻게 돌아가는지의 뼈대와 문서 지도를 갖는다.

| 문서 | 다루는 것 |
| --- | --- |
| [game-overview.md](./game-overview.md) | 컨셉 · 핵심 구조(채팅/스킬/코어) · 게임 루프 · 화면 · 현재 범위 |
| [attribute-model.md](./attribute-model.md) | 선수 15축 · 포지션 가중치 · 역할 · 폼 · 체력 · 성장 · 적응도 · 안개 |
| [match-sim.md](./match-sim.md) | 전력 패킷 · xg 구간 시뮬 · 전술 상성 · 체력 · 평점 · 간이 시뮬 |
| [season.md](./season.md) | 시즌 달력 · 리그 편성 · 국내 컵 · 유럽 대항전 · 훈련 계획 · tick · 시즌 전환 |
| [transfers.md](./transfers.md) | 이적 시장 · 협상 · 설득 · 메디컬 · AI 시장 · 감독 시장 · 주급 |
| [club-finance.md](./club-finance.md) | 구단 재정 — 수입·지출 · 상각 · PSR · 월간 보고서 |
| [people.md](./people.md) | 페르소나 · 화자 규칙 · 기자회견 · 심경 · 세계가 말 걸기(설계) |
| [llm.md](./llm.md) | LLM 티어 · 어댑터 · 입력 3층 · 조회 도구 · 결산 계약 · 프롬프트 규약 |
| [data-sourcing.md](./data-sourcing.md) | 데이터 출처 · 라이선스 부채 |
| [implementation-notes.md](./implementation-notes.md) | ERD · 세이브 호환 규칙 · 설계 결정 로그 |

작성 규칙:

- **동작 방식이 원본이다** — 각 문서는 요약 → 동작 방식 → 수치 표 → ⚠️ 불변식 →
  미해결 → 코드 위치 순으로 쓴다. 역사 서술·긴 정당화는 넣지 않는다.
- 바꾸면 조용히 깨지는 제약만 ⚠️ 한 줄로 남긴다.
- 한 주제의 원본은 한 문서 — 다른 문서는 링크한다.
- 기획·아키텍처가 바뀌면 **코드보다 문서를 먼저** 갱신한다. 중요한 결정은
  [../decisions/](../decisions/)에 ADR로.
