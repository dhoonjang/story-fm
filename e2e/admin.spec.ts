import { expect, test } from "@playwright/test";

test.afterEach(async ({ request }) => {
  await request.delete("/api/admin/prompts");
  await request.delete("/api/admin/skills");
});

test("어드민과 기본 프롬프트 편집 화면이 500 없이 동작한다", async ({ page }) => {
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

  await page.getByTestId("admin-prompts-link").click();
  await expect(page).toHaveURL(/\/admin\/prompts$/);

  const gm = page.getByTestId("prompt-gm");
  const match = page.getByTestId("prompt-match");
  await expect(gm).toBeVisible({ timeout: 20_000 });
  await expect(match).toBeVisible();
  await expect(gm).toHaveValue(/게임 마스터/);
  await expect(match).toHaveValue(/경기 마스터/);

  const originalGm = await gm.inputValue();
  const marker = "\n\n# e2e 프롬프트 편집";
  await gm.fill(`${originalGm}${marker}`);
  await page.getByTestId("prompts-save").click();
  await expect(page.getByTestId("prompts-msg")).toContainText("저장했습니다");
  await expect(page.getByTestId("prompts-edited")).toBeVisible();

  await page.reload();
  await expect(gm).toHaveValue(new RegExp(`${marker.trim()}$`), { timeout: 20_000 });

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("prompts-reset").click();
  await expect(page.getByTestId("prompts-msg")).toContainText("기본값으로 되돌렸습니다");
  await expect(gm).not.toHaveValue(new RegExp(`${marker.trim()}$`));
  await expect(page.getByTestId("prompts-edited")).toBeHidden();

  const advanceTime = page.getByTestId("skill-advance_time");
  await expect(advanceTime).toBeVisible();
  await expect(page.getByTestId("skill-log_match_events")).toBeVisible();
  const originalSkill = await advanceTime.inputValue();
  const skillMarker = "\n어드민 e2e 스킬 설명";
  await advanceTime.fill(`${originalSkill}${skillMarker}`);
  await page.getByTestId("skills-save").click();
  await expect(page.getByTestId("skills-msg")).toContainText("저장했습니다");
  await expect(page.getByTestId("skills-edited")).toBeVisible();

  await page.reload();
  await expect(advanceTime).toHaveValue(new RegExp(`${skillMarker.trim()}$`), {
    timeout: 20_000,
  });

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("skills-reset").click();
  await expect(page.getByTestId("skills-msg")).toContainText("기본값으로 되돌렸습니다");
  await expect(advanceTime).not.toHaveValue(new RegExp(`${skillMarker.trim()}$`));
  await expect(page.getByTestId("skills-edited")).toBeHidden();

  expect(serverErrors).toEqual([]);
});
