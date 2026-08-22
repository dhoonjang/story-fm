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
 * 산출물·세이브 디렉터리·실패 아티팩트가 슬롯 하나에서 함께 갈라진다 — 하나만
 * 나누면 동시 실행이 서로를 밟으므로 개별 변수로는 열지 않는다.
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
// 리포트·트레이스도 슬롯을 따라 갈린다 — 두 슬롯이 한 디렉터리에 쓰면 나중 실행이
// 앞 실행의 실패 증거를 지운다. ci.yml이 올리는 것은 슬롯 0의 이름이다.
const reportDir = `playwright-report${suffix}`;

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
   * 12코어(dev 서버): 1워커 93초 · 2워커 59초 · 4워커 43초 · 6워커 43초 ·
   * 8워커는 서버가 포화해 실패. 넷에서 평평해진다 — 대상이 서버 **한 개**라
   * 그쪽이 먼저 막힌다.
   *
   * ⚠️ 워커만 늘리는 것으로는 2코어 러너에서 아무것도 얻지 못한다. 잰 값:
   * dev 서버 1워커 194초 → dev 서버 4워커 197초, 게다가 가장 긴 케이스가
   * 굶어 재시도로 넘어갔다(run 31988320173). 코어 둘을 서버와 브라우저 넷이
   * 나눠 쓰면 겹칠 여유 자체가 없다 — 그래서 아래 webServer가 **일을 줄인다**.
   */
  workers: 4,
  // 냉간 왕복이 7초를 넘기기도 한다(dev 서버에서 컴파일 2.6s + 첫 요청 4.8s를
  // 관측). Playwright 기본값 5초는 이 환경을 잰 값이 아니다 — 기다림만 늘리고
  // 무엇을 확인하는지는 그대로 둔다.
  expect: { timeout: 15_000 },
  /**
   * **빨간 e2e는 아티팩트로 읽는다.** 러너 로그에 남는 것은 실패한 단언 한 줄뿐이라
   * 그 순간 화면이 무엇이었는지가 없다 — html 리포트·트레이스·스크린샷이 그 자리를
   * 메운다 (`.github/workflows/ci.yml`의 e2e 잡이 실패할 때 업로드한다).
   *
   * CI에서만 켠다. 로컬은 실패한 자리에서 곧바로 다시 돌리면 되고, 기본 리포터가
   * 리포트 서버를 띄워 터미널을 붙잡는 쪽이 성가시다 — `open: "never"`가 그것도 막는다.
   */
  reporter: process.env.CI
    ? [["html", { open: "never", outputFolder: reportDir }], ["dot"]]
    : "list",
  outputDir: `test-results${suffix}`,
  use: {
    baseURL: url,
    // 실패한 시도만 남긴다 — 초록 실행에서는 지워지므로 러너 디스크를 먹지 않는다
    trace: process.env.CI ? "retain-on-failure" : "off",
    screenshot: process.env.CI ? "only-on-failure" : "off",
  },
  /**
   * CI는 **빌드된 앱**을 본다. 로컬은 dev 서버 그대로다.
   *
   * dev 서버는 라우트를 처음 두드릴 때마다 컴파일한다. 코어가 열둘이면 그 값이
   * 묻히지만(43초 → 40초) 둘이면 그게 시간의 절반이다. 2코어 러너에서 잰 값:
   *
   *   dev 서버 · 1워커                194초
   *   dev 서버 · 4워커                197초 (+ 재시도 1회)
   *   빌드 + `next start` · 4워커      91초 = 빌드 39초 + 테스트 52초
   *
   * 빌드 값을 다 물고도 절반이 넘게 줄고, 재시도도 사라진다 — 컴파일이 없어져야
   * 워커 넷이 비로소 겹쳐 돈다.
   *
   * 로컬까지 빌드로 바꾸지 않는 이유는 로컬에는 그 병목이 없기 때문이다. 매번
   * 12초짜리 빌드를 물리고 3초를 벌 자리가 아니고, `reuseExistingServer`가 주는
   * 반복 실행의 이점도 사라진다.
   */
  webServer: {
    command: process.env.CI
      ? "pnpm --filter @story-fm/web build && pnpm --filter @story-fm/web start"
      : "pnpm --filter @story-fm/web dev",
    url,
    reuseExistingServer: !process.env.CI,
    // 빌드가 앞에 붙는다 — dev 서버가 서기만 기다리던 2분으로는 모자란다
    timeout: 300_000,
    env: {
      PORT: String(port),
      LLM_MODE: "mock",
      // CI는 `next start`로 도므로 NODE_ENV가 production이다 — 어드민 쓰기 라우트의
      // 기본 문이 닫히는 자리다(game-state.md §2). 어드민 스펙이 카탈로그를 고쳐야
      // 하므로 여기서 명시적으로 연다.
      ADMIN_ENABLED: "1",
      STORY_FM_DATA_DIR: `/tmp/story-fm-e2e${suffix}`,
      // 개발 서버(.next)와 빌드 산출물을 나눠 쓴다 — 공유하면 재컴파일 때
      // 서로의 청크를 지워 테스트가 무작위로 깨진다
      NEXT_DIST_DIR: `.next-e2e${suffix}`,
    },
  },
});
