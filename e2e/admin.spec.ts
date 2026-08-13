import { expect, test } from "@playwright/test";

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
