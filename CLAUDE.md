# CLAUDE.md

이 프로젝트의 비전·아키텍처·개발 규약은 **[AGENTS.md](./AGENTS.md)** 에 모여
있다. Claude Code로 작업할 땐 먼저 그 문서를 따른다.

@AGENTS.md

---

## Claude 작업 시 핵심 (요약)

- **언어**: 사용자와의 대화·설명·주석은 한국어. 코드 식별자는 원문 유지.
- **코어 vs LLM 경계**: 시뮬레이션 코어는 결정적 순수 함수, LLM은 "판단·서사"만
  주입. 둘을 섞지 말 것. (AGENTS.md 4·6장)
- **LLM 호출 추가 시**: Zod 스키마 검증 + 캐싱 + 에이전트 설정을 반드시 적용.
  모델 ID는 하드코딩하지 말고 `config/llm.yml`에 에이전트 항목을 추가한다
  (docs/design/llm.md).
- **Claude API 세부**(모델 ID·가격·캐싱·도구 사용)는 기억에 의존하지 말고
  `claude-api` 스킬/최신 레퍼런스로 확인한다.
- **커밋/푸시**: 사용자가 요청할 때만. `main` 직접 커밋 금지 — 브랜치 작업.
- **불확실하면 질문**: 게임 밸런스·핵심 루프에 영향 주는 결정은 임의로 정하지
  말고 확인한다.

## 자주 쓰는 명령

```bash
pnpm install          # 의존성 설치 (Node 26 — .nvmrc 참고)
pnpm test             # 유닛+API 통합 테스트 (Vitest — LLM 없이 실행됨)
pnpm typecheck        # tsc --noEmit (TS 6.x — typescript-eslint 호환 때문에 7 미사용)
pnpm lint             # ESLint
pnpm e2e              # Playwright e2e (mock GM 모드 — dev 서버 자동 기동)
pnpm dev              # 웹 앱 개발 서버 (LLM_MODE=mock 이면 API 키 불필요)
pnpm match --dry      # 경기 CLI 프로토타입: 전력 패킷만 출력
```

> LLM 모드: `LLM_MODE=mock|real` (미지정 시 YAML의 GM 제공자 키가 있으면 real).
> 구현 판단·기획 편차는 docs/design/implementation-notes.md에 기록한다.
