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

  // 표는 능력치 15축이라 화면보다 넓다 — 오른쪽 끝까지 스크롤해도 이름과 저장
  // 버튼이 남아 있어야 편집이 가능하다 (좌우 고정 열)
  const firstRow = page.locator(".admin-table tbody tr").first();
  const name = firstRow.locator("td").nth(1);
  const save = firstRow.locator(".mini-btn.save");
  const nameBefore = await name.boundingBox();
  await page.locator(".admin-table-wrap").evaluate((el) => (el.scrollLeft = 99999));
  await expect(name).toBeInViewport();
  await expect(save).toBeInViewport();
  // 스크롤해도 이름 열은 왼쪽 끝에 붙어 있다 (원래 위치보다 왼쪽으로 오지 않는다)
  const nameAfter = await name.boundingBox();
  expect(nameAfter!.x).toBeLessThanOrEqual(nameBefore!.x + 1);
  // 행 높이가 고르다 — 고정 셀이 행을 채우지 못하면 그 틈으로 다른 열이 비친다
  const heights = await page
    .locator(".admin-table tbody tr")
    .evaluateAll((rows) =>
      rows.slice(0, 8).map((r) => Math.round(r.getBoundingClientRect().height)),
    );
  expect(new Set(heights).size).toBe(1);

  await page.getByTestId("admin-prompts-link").click();
  await expect(page).toHaveURL(/\/admin\/prompts$/);

  const gm = page.getByTestId("prompt-gm");
  const match = page.getByTestId("prompt-match");
  await expect(gm).toBeVisible({ timeout: 20_000 });
  await expect(match).toBeVisible();
  await expect(gm).toHaveValue(/게임 마스터/);
  await expect(match).toHaveValue(/경기 중계자/);

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

  // 시간·경기 진행은 스킬이 아니라 장면 헤더가 맡는다 — 카탈로그에 없다
  const skillField = page.getByTestId("skill-set_captain");
  await expect(skillField).toBeVisible();
  await expect(page.getByTestId("skill-substitute")).toBeVisible();
  const originalSkill = await skillField.inputValue();
  const skillMarker = "\n어드민 e2e 스킬 설명";
  await skillField.fill(`${originalSkill}${skillMarker}`);
  await page.getByTestId("skills-save").click();
  await expect(page.getByTestId("skills-msg")).toContainText("저장했습니다");
  await expect(page.getByTestId("skills-edited")).toBeVisible();

  await page.reload();
  await expect(skillField).toHaveValue(new RegExp(`${skillMarker.trim()}$`), {
    timeout: 20_000,
  });

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("skills-reset").click();
  await expect(page.getByTestId("skills-msg")).toContainText("기본값으로 되돌렸습니다");
  await expect(skillField).not.toHaveValue(new RegExp(`${skillMarker.trim()}$`));
  await expect(page.getByTestId("skills-edited")).toBeHidden();

  expect(serverErrors).toEqual([]);
});
