import { expect, test } from "@playwright/test";

/**
 * 이 파일만 파일 단위 직렬로 되돌린다 (`fullyParallel`에서 빠진다).
 *
 * 어드민이 고치는 카탈로그는 **서버 프로세스 하나가 들고 있는 전역 상태**다.
 * 소속을 옮기는 케이스와 팀·리그를 고치는 케이스를 나란히 돌리면 한쪽의
 * `catalog-reset`이 다른 쪽이 방금 옮긴 선수를 되돌려, 명단 수가 어긋난다
 * (`team-squad-arsenal`이 39명 그대로인 채 38명을 기다린다).
 *
 * 네 케이스를 합쳐 13초라 임계 경로(가장 긴 케이스 26초) 아래에 있다 — 직렬로
 * 두어도 전체 시간이 늘지 않는다.
 */
test.describe.configure({ mode: "default" });

/** 편집 손잡이가 되는 행 — 목록이 비었을 때의 안내 행과 구별한다 */
const ROW = '.admin-list tbody tr[role="button"]';

test("카탈로그 어드민이 500 없이 동작한다", async ({ page }) => {
  const serverErrors: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 500) {
      serverErrors.push(`${response.status()} ${response.url()}`);
    }
  });

  const adminResponse = await page.goto("/admin");
  expect(adminResponse?.status()).toBe(200);
  await expect(page.getByTestId("admin-count")).not.toHaveText("0명", {
    timeout: 20_000,
  });

  // 탭 셸 — 선수가 기본 층이고, 네 층이 모두 목록을 갖는다
  await expect(page.getByTestId("admin-tab-players")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("admin-tab-teams").click();
  await expect(page.getByTestId("team-row-arsenal")).toBeVisible();
  await page.getByTestId("admin-tab-players").click();
  await expect(page.locator(ROW).first()).toBeVisible();

  // 행을 누르면 편집 팝업이 열린다 — Esc로 닫힌다
  const modal = page.getByTestId("player-modal");
  await page.locator(ROW).first().click();
  await expect(modal).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);

  // 팝업에서 고친 값은 저장되고 카탈로그가 "편집됨"이 된다
  await page.locator(ROW).first().click();
  await expect(modal).toBeVisible();
  await page.getByTestId("player-modal-wage").fill("123000");
  await page.getByTestId("player-modal-save").click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId("catalog-edited")).toBeVisible();
  await expect(page.getByTestId("admin-msg")).toBeVisible();
  await expect(page.locator(ROW).first()).toContainText("£123,000");

  // 되돌리기 — 편집 표식이 사라진다 (뒤 테스트에 편집을 남기지 않는다)
  page.once("dialog", (d) => void d.accept());
  await page.getByTestId("catalog-reset").click();
  await expect(page.getByTestId("catalog-edited")).toHaveCount(0);

  expect(serverErrors).toEqual([]);
});

test("탭을 오가도 카탈로그를 다시 받지 않는다", async ({ page }) => {
  /** 층별 요청 수 — 카탈로그는 불변 시드라 화면이 서 있는 동안 한 번이면 된다 */
  const calls = new Map<string, number>();
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (!pathname.startsWith("/api/admin/catalog")) return;
    calls.set(pathname, (calls.get(pathname) ?? 0) + 1);
  });

  await page.goto("/admin");
  await expect(page.getByTestId("admin-count")).not.toHaveText("0명", { timeout: 20_000 });
  await page.getByTestId("admin-tab-teams").click();
  await expect(page.getByTestId("team-row-arsenal")).toBeVisible({ timeout: 20_000 });

  const onLoad = new Map(calls);
  // 리그 목록은 세 패널이 각자가 아니라 페이지가 받는다 — 선수 카탈로그와 같은 횟수다
  // (개발 서버의 StrictMode는 마운트 효과를 두 번 돌리므로 절대 횟수로 재지 않는다)
  expect(onLoad.get("/api/admin/catalog/league")).toBe(onLoad.get("/api/admin/catalog"));

  // 네 층을 한 바퀴 돌고 처음 자리로 — 패널은 언마운트되지만 카탈로그는 페이지가 쥔다
  await page.getByTestId("admin-tab-leagues").click();
  await expect(page.getByTestId("league-row-epl")).toBeVisible();
  await page.getByTestId("admin-tab-cups").click();
  await expect(page.getByTestId("cup-row-ucl")).toBeVisible();
  await page.getByTestId("admin-tab-players").click();
  await expect(page.locator(ROW).first()).toBeVisible();
  await page.getByTestId("admin-tab-teams").click();
  await expect(page.getByTestId("team-row-arsenal")).toBeVisible();

  expect([...calls]).toEqual([...onLoad]);
});

test("선수 팝업과 팀 명단에서 소속을 옮긴다", async ({ page }) => {
  const serverErrors: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 500) {
      serverErrors.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto("/admin");
  await expect(page.getByTestId("admin-count")).not.toHaveText("0명", { timeout: 20_000 });

  // ── 선수 쪽 — 편집 팝업의 팀 셀렉트가 소속을 옮긴다 (방출 = 무소속으로 옮기기)
  await page.getByTestId("admin-team-filter").selectOption("arsenal");
  const row = page.locator(ROW).first();
  const rowId = await row.getAttribute("data-testid");
  const modal = page.getByTestId("player-modal");
  await row.click();
  await expect(modal).toBeVisible();
  await page.getByTestId("player-modal-team").selectOption("freeagents");
  await page.getByTestId("player-modal-save").click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId("admin-msg")).toContainText("무소속");
  // 목록이 새 소속으로 갱신된다 — 떠난 팀에선 사라지고 무소속에서 보인다
  await expect(page.getByTestId(rowId!)).toHaveCount(0);
  await page.getByTestId("admin-team-filter").selectOption("freeagents");
  await expect(page.getByTestId(rowId!)).toBeVisible();

  // ── 팀 쪽 — 스쿼드 칸이 명단 창을 열고, 거기서도 소속을 옮긴다
  await page.getByTestId("admin-tab-teams").click();
  const squadBtn = page.getByTestId("team-squad-arsenal");
  await expect(squadBtn).toBeVisible({ timeout: 20_000 });
  const before = Number((await squadBtn.innerText()).replace(/\D/g, ""));
  await squadBtn.click();
  const squadModal = page.getByTestId("squad-modal");
  await expect(squadModal).toBeVisible();
  const squadRow = squadModal.locator(".admin-squad-row").first();
  const squadRowId = await squadRow.getAttribute("data-testid");
  await squadRow.locator("select").selectOption("freeagents");
  await expect(page.getByTestId("squad-modal-msg")).toContainText("무소속");
  // 옮긴 선수는 이 명단에서 빠지고, 창은 열린 채로 남는다
  await expect(page.getByTestId(squadRowId!)).toHaveCount(0);
  await expect(squadModal).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(squadModal).toHaveCount(0);
  await expect(squadBtn).toHaveText(`${before - 1}명`);

  // 되돌리기 — 뒤 테스트에 편집을 남기지 않는다
  await page.getByTestId("admin-tab-players").click();
  page.once("dialog", (d) => void d.accept());
  await page.getByTestId("catalog-reset").click();
  await expect(page.getByTestId("catalog-edited")).toHaveCount(0);

  expect(serverErrors).toEqual([]);
});

test("팀·리그·컵 탭이 팝업으로 카탈로그를 고친다", async ({ page }) => {
  const serverErrors: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 500) {
      serverErrors.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto("/admin");

  // ── 팀 — 살림 값을 고치면 목록과 "편집됨"이 함께 바뀐다
  await page.getByTestId("admin-tab-teams").click();
  const teamRow = page.getByTestId("team-row-arsenal");
  await expect(teamRow).toBeVisible({ timeout: 20_000 });
  const teamModal = page.getByTestId("team-modal");
  await teamRow.click();
  await expect(teamModal).toBeVisible();
  await page.getByTestId("team-modal-capacity").fill("61234");
  await page.getByTestId("team-modal-save").click();
  await expect(teamModal).toHaveCount(0);
  await expect(page.getByTestId("teams-edited")).toBeVisible();
  await expect(teamRow).toContainText("61,234석");

  // 리그를 옮기면 두 리그가 홀수가 된다 — 엔진이 한국어로 거절하고 팝업은 남는다
  await teamRow.click();
  await expect(teamModal).toBeVisible();
  await page.getByTestId("team-modal-league").selectOption("laliga");
  await page.getByTestId("team-modal-save").click();
  await expect(page.getByTestId("team-modal-err")).toContainText("홀수");
  await expect(teamModal).toBeVisible();
  await page.keyboard.press("Escape");

  page.once("dialog", (d) => void d.accept());
  await page.getByTestId("teams-reset").click();
  await expect(page.getByTestId("teams-edited")).toHaveCount(0);
  await expect(teamRow).not.toContainText("61,234석");

  // ── 리그 — 종류(kind)는 셀렉트로 고른다
  await page.getByTestId("admin-tab-leagues").click();
  const leagueRow = page.getByTestId("league-row-epl");
  await expect(leagueRow).toBeVisible();
  const leagueModal = page.getByTestId("league-modal");
  await leagueRow.click();
  await expect(leagueModal).toBeVisible();
  await page.getByTestId("league-modal-ticket").fill("52");
  await page.getByTestId("league-modal-save").click();
  await expect(leagueModal).toHaveCount(0);
  await expect(page.getByTestId("leagues-edited")).toBeVisible();
  await expect(leagueRow).toContainText("£52");

  page.once("dialog", (d) => void d.accept());
  await page.getByTestId("leagues-reset").click();
  await expect(page.getByTestId("leagues-edited")).toHaveCount(0);

  // ── 컵 — 티켓 합이 참가 팀 수와 어긋나면 저장 전에 막힌다
  await page.getByTestId("admin-tab-cups").click();
  const cupRow = page.getByTestId("cup-row-ucl");
  await expect(cupRow).toBeVisible();
  const cupModal = page.getByTestId("cup-modal");
  await cupRow.click();
  await expect(cupModal).toBeVisible();
  await page.getByTestId("cup-modal-slot-epl").fill("7");
  await expect(page.getByTestId("cup-modal-slot-sum")).toContainText("합계 26 / 참가 24");
  await page.getByTestId("cup-modal-save").click();
  await expect(page.getByTestId("cup-modal-err")).toContainText("티켓 합");
  await expect(cupModal).toBeVisible();

  // 합을 맞추면 저장된다
  await page.getByTestId("cup-modal-slot-ligue1").fill("2");
  await expect(page.getByTestId("cup-modal-slot-sum")).toContainText("합계 24 / 참가 24");
  await page.getByTestId("cup-modal-save").click();
  await expect(cupModal).toHaveCount(0);
  await expect(page.getByTestId("cups-edited")).toBeVisible();

  // 국내 컵은 다른 필드를 가진 같은 팝업이다 (라운드 목표일·유럽 진출권)
  const domesticRow = page.getByTestId("cup-row-facup");
  await domesticRow.click();
  await expect(cupModal).toBeVisible();
  await expect(page.getByTestId("cup-modal-window-final-month")).toHaveValue("5");
  await page.getByTestId("cup-modal-prize-winner").fill("3500000");
  await page.getByTestId("cup-modal-save").click();
  await expect(cupModal).toHaveCount(0);
  await expect(domesticRow).toContainText("£3,500,000");

  page.once("dialog", (d) => void d.accept());
  await page.getByTestId("cups-reset").click();
  await expect(page.getByTestId("cups-edited")).toHaveCount(0);

  expect(serverErrors).toEqual([]);
});
