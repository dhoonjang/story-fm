import { expect, test } from "@playwright/test";

test("선수 카탈로그 어드민이 500 없이 동작한다", async ({ page }) => {
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

  expect(serverErrors).toEqual([]);
});
