import { defineConfig } from "@playwright/test";

/**
 * e2e — mock GM 모드로 LLM 없이 전체 시나리오를 브라우저에서 검증한다.
 * 실모드 시나리오는 스모크로 별도 수행 (config/llm.yml의 GM 제공자 키 필요).
 *
 * 기본 슬롯(E2E_SLOT 미지정)은 포트 3399를 쓴다 — 3399는 e2e 전용이라
 * 개발용 플레이 서버(3311, 실모드일 수 있음)를 reuseExistingServer가 재사용해
 * mock 기대가 깨지는 사고를 막는다.
 *
 * `E2E_SLOT=1`~`9`는 한 워크트리에서 e2e를 동시에 돌리기 위한 슬롯이다. 포트·빌드
 * 산출물·세이브 디렉터리가 슬롯 하나에서 함께 갈라진다 — 셋 중 하나만 나누면
 * 동시 실행이 서로를 밟으므로 개별 변수로는 열지 않는다.
 */
const BASE_PORT = 3399;
// 슬롯을 늘리면 apps/web/tsconfig.json의 include에도 그 distDir을 함께 적는다 —
// Next가 처음 보는 distDir을 tsconfig에 자동으로 덧붙여 추적 파일을 더럽힌다.
const MAX_SLOT = 9;

function readSlot(): number {
  const raw = process.env.E2E_SLOT;
  if (raw === undefined || raw === "") return 0;
  const slot = Number(raw);
  if (!Number.isInteger(slot) || slot < 0 || slot > MAX_SLOT) {
    throw new Error(`E2E_SLOT은 0~${MAX_SLOT} 정수여야 한다 (받은 값: "${raw}")`);
  }
  return slot;
}

const slot = readSlot();
const suffix = slot === 0 ? "" : `-${slot}`;
const port = BASE_PORT + slot;
const url = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  retries: 1,
  /**
   * 한 파일 안의 케이스도 서로 나눠 돈다.
   *
   * 이걸 켜기 전에는 병렬도의 천장이 **워커 수가 아니라 파일 수**였다 — 스펙이
   * 넷뿐이라 워커를 아무리 줘도 넷이 상한이고, 15개 중 6개를 혼자 든
   * `game.spec.ts`가 그대로 임계 경로였다. 켜면 천장이 가장 긴 케이스 하나로
   * 내려간다(26초).
   *
   * ⚠️ 카탈로그는 서버 프로세스 하나가 들고 있는 전역 상태다. 그것을 고치는
   * 스펙은 `test.describe.configure({ mode: "default" })`로 파일 단위 직렬을
   * 되찾아야 한다 (`e2e/admin.spec.ts`) — 안 그러면 서로의 편집을 밟는다.
   */
  fullyParallel: true,
  /**
   * 워커 넷. 기본값(`코어/2`)은 2코어 러너에서 1이 되어 15개를 직렬로 돌린다.
   *
   * 12코어에서 잰 값(dev 서버, `fullyParallel` 켠 상태): 1워커 93초 · 2워커 59초
   * · 4워커 43초 · 6워커 43초 · 8워커는 서버가 포화해 실패. 넷에서 이미 평평해지고
   * 여섯은 얻는 것이 없다 — 대상이 dev 서버 **한 개**라 그쪽이 먼저 막힌다.
   */
  workers: 4,
  // 대상은 프로덕션 빌드가 아니라 **개발 서버**다 — 라우트를 처음 두드릴 때
  // 컴파일하고(수 초), 그 서버 하나를 워커 넷이 나눠 쓴다. 그래서 클릭 한 번이
  // 부르는 왕복이 냉간에 7초를 넘기기도 한다(컴파일 2.6s + 첫 요청 4.8s를 관측).
  // Playwright 기본값 5초는 이 환경을 잰 값이 아니다 — 기다림만 늘리고 무엇을
  // 확인하는지는 그대로 둔다.
  expect: { timeout: 15_000 },
  use: {
    baseURL: url,
  },
  webServer: {
    command: "pnpm --filter @story-fm/web dev",
    url,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: String(port),
      LLM_MODE: "mock",
      STORY_FM_DATA_DIR: `/tmp/story-fm-e2e${suffix}`,
      // 개발 서버(.next)와 빌드 산출물을 나눠 쓴다 — 공유하면 재컴파일 때
      // 서로의 청크를 지워 테스트가 무작위로 깨진다
      NEXT_DIST_DIR: `.next-e2e${suffix}`,
    },
  },
});
