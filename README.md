# story-fm

자연어로 팀을 지휘하고, 매 시즌을 이야기로 만들어 가는 AI 풋볼 매니저 게임입니다.
선수와 세계의 상태는 코어가 결정적으로 관리하고, LLM은 감독의 지시를 해석해
경기와 인물의 반응을 서사로 전달합니다.

현재 온보딩부터 일상 지시, 경기, 시즌 전환, 멀티시즌까지 플레이할 수 있는
프로토타입 단계입니다.

## 핵심 원칙

- 언어가 핵심 인터페이스입니다.
- 경기 결과와 상태 변경은 시뮬레이션 코어가 결정합니다.
- LLM은 검증된 도구 호출을 통해서만 게임 상태에 영향을 줍니다.
- 결과보다 그 결과가 만들어 내는 납득 가능한 이야기를 중시합니다.

## 시작하기

[`.nvmrc`](.nvmrc)가 정하는 Node 26과 pnpm 9가 필요합니다.

```bash
pnpm install
pnpm dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000)을 엽니다. API 키가 없으면
mock 모드로 실행되며, 실제 LLM을 사용하려면 [`config/llm.yml`](config/llm.yml)에
설정된 제공자의 API 키를 환경 변수로 지정합니다.

## 밖에서 열어 볼 때

터널(cloudflared 등)이나 같은 LAN의 다른 기기로 이 앱을 열 때 알아 둘 것 셋입니다.

- **외부 오리진 허용** — dev 서버는 `/_next/*` 요청의 Origin을
  [`apps/web/next.config.ts`](apps/web/next.config.ts)의 `allowedDevOrigins`와
  대조합니다. 사설망 대역과 `*.trycloudflare.com`은 이미 들어 있고, 그 밖의
  오리진은 `ALLOWED_DEV_ORIGINS`에 쉼표로 이어 붙입니다.

  ```bash
  ALLOWED_DEV_ORIGINS=my-tunnel.example.com pnpm dev
  ```

- **자동 번역은 꺼져 있습니다** — 화면 전체가 한국어라 기기 언어가 다르면
  브라우저가 자동 번역을 걸고, 그러면 React가 하이드레이션하기 **전에** 텍스트
  노드가 바뀌어 불일치가 납니다. `<html translate="no">`로 막습니다.

- **남에게 보여줄 URL이면 dev 서버 대신 프로덕션 빌드를 터널 뒤에 둡니다.**
  dev 서버는 첫 요청에서 라우트를 컴파일하고 HMR 소켓을 열어 두어, 터널의 왕복
  지연 위에서는 첫 로드가 눈에 띄게 느립니다.

  ```bash
  pnpm --filter @story-fm/web build
  pnpm --filter @story-fm/web start -p 3000
  ```

  `NODE_ENV=production`이 되므로 `/admin`의 쓰기 라우트는 닫힙니다 —
  열어야 하면 `ADMIN_ENABLED=1`을 함께 줍니다.

## 개발 명령

```bash
pnpm test       # 단위 테스트
pnpm typecheck  # 타입 검사
pnpm lint       # 린트
pnpm e2e        # E2E 테스트
```

게임의 현재 동작은 [`docs/README.md`](docs/README.md), 비전과 개발 규약은
[`AGENTS.md`](AGENTS.md)를 참고하세요.
