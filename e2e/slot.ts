/**
 * e2e 슬롯 — **포트·빌드 산출물·세이브 디렉터리가 한자리에서 갈린다.**
 *
 * `E2E_SLOT=1`~`9`는 한 워크트리에서 e2e를 동시에 돌리기 위한 슬롯이다. 하나만
 * 나누면 동시 실행이 서로를 밟으므로 개별 변수로는 열지 않는다.
 *
 * 설정(`playwright.config.ts`)만 쓰던 값을 여기로 뺀 이유는 **스펙도 같은 자리를
 * 알아야 하기 때문이다** — 세이브를 미리 놓고 여는 스펙(`e2e/seed.ts`)은 서버가
 * 읽는 그 디렉터리에 써야 한다. 두 곳에 따로 적으면 슬롯을 옮길 때 한쪽만 옮는다.
 */
const BASE_PORT = 3399;
// 상한을 옮겨도 다른 파일을 따라 고칠 일은 없다 — apps/web/tsconfig.json은 슬롯을
// 하나씩 적는 대신 `.next-e2e*/types`로 받는다. (그 줄이 있어야 Next가 처음 보는
// distDir을 tsconfig에 제멋대로 덧붙여 추적 파일을 더럽히는 것을 막는다.)
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

/** 슬롯 꼬리표 — 기본 슬롯은 꼬리표가 없다 (`playwright-report`, `.next-e2e`, …) */
export const SUFFIX = slot === 0 ? "" : `-${slot}`;
/** 이 슬롯의 서버 포트 — 3399는 e2e 전용이라 개발 서버(3311)와 겹치지 않는다 */
export const PORT = BASE_PORT + slot;
/** 이 슬롯의 세이브 디렉터리 — 서버도 스펙도 여기만 본다 */
export const DATA_DIR = `/tmp/story-fm-e2e${SUFFIX}`;
