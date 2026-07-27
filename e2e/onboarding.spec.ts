import { expect, test } from "@playwright/test";

test("새 게임 첫 메시지가 부임 장면과 수석코치 브리핑으로 표시된다", async ({ page }) => {
  await page.goto("/new");
  await expect(page.getByTestId("team-grid")).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("team-arsenal").click();
  await page.getByTestId("manager-name").fill("온보딩테스트");
  await page
    .getByTestId("manager-background")
    .fill("K리그 주장 출신으로 은퇴 후 데이터 분석과 유소년 지도를 공부했다.");
  await page.getByTestId("start-game").click();

  const firstTurn = page.getByTestId("model-turn").first();
  await expect(firstTurn).toBeVisible({ timeout: 30_000 });
  await expect(firstTurn).toContainText("온보딩테스트");
  await expect(firstTurn.getByText("수석코치", { exact: true }).first()).toBeVisible();
  await expect(firstTurn.locator(".narration")).toHaveCount(1);
  expect(await firstTurn.locator(".line").count()).toBeGreaterThanOrEqual(4);
});
