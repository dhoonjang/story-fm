import { expect, test } from "@playwright/test";

/**
 * LLM 실패 시 UI — 채팅은 그대로 두고 배너로만 알린다.
 *
 * 턴 응답을 502로 가로채 재현한다 (서버가 세이브를 건드리지 않는 것은
 * apps/web/test/turn-error.test.ts가 검증한다). 예전에는 수석코치가
 * 사과 대사와 오류 문자열을 읊는 모델 턴이 채팅에 저장됐다.
 */
test("LLM 실패 배너", async ({ page }) => {
  await page.goto("/new");
  await expect(page.getByTestId("league-grid")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("league-epl").click();
  await page.getByTestId("team-arsenal").click();
  await page.getByTestId("manager-name").fill("에러확인");
  await page.getByTestId("manager-background").fill("분석가 출신");
  await page.getByTestId("start-game").click();
  await expect(page.getByTestId("chat-scroll")).toContainText("에러확인", { timeout: 40_000 });

  const turnsBefore = await page.getByTestId("model-turn").count();

  // 턴 요청만 502로 (서버는 실제로 채팅을 저장하지 않는다 — turn-error.test.ts가 검증)
  await page.route("**/turn/stream", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        error: "모델 서버가 혼잡합니다 — 잠시 후 다시 시도해 주세요.",
        detail: '529 {"type":"overloaded_error"}',
      }),
    }),
  );

  await page.getByTestId("chat-input").fill("훈련 잡아줘");
  await page.getByTestId("chat-send").click();

  await expect(page.getByTestId("turn-error")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("turn-error")).toContainText("혼잡");
  // 채팅에는 유저 발화도, 사과 대사도 남지 않는다
  await expect(page.getByTestId("chat-scroll")).not.toContainText("훈련 잡아줘");
  await expect(page.getByTestId("chat-scroll")).not.toContainText("죄송");
  await expect(page.getByTestId("model-turn")).toHaveCount(turnsBefore);
  // 입력은 되돌아온다 (그대로 다시 시도 가능)
  await expect(page.getByTestId("chat-input")).toHaveValue("훈련 잡아줘");
});
