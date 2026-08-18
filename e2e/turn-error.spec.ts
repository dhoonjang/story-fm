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
  await expect(page.getByTestId("league-ring")).toBeVisible({ timeout: 20_000 });
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
        error: "모델 서버가 혼잡합니다",
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

/**
 * 무응답 — 실패와 다른 사건이다. 에러는 돌아오지만 멎은 호출은 돌아오지 않는다.
 *
 * 스트림이 `done` 없이 끊긴 것으로 재현한다(응답이 잘렸거나 서버가 중간에 죽은
 * 자리). 예전에는 이 길에서 배너 없이 조용히 마감돼, 낙관적 유저 발화가 화면에만
 * 남고 감독은 무엇이 반영됐는지 알 수 없었다.
 */
test("멎은 턴도 실패로 끝나고 다음 턴을 막지 않는다", async ({ page }) => {
  await page.goto("/new");
  await expect(page.getByTestId("league-ring")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("league-epl").click();
  await page.getByTestId("team-arsenal").click();
  await page.getByTestId("manager-name").fill("무응답확인");
  await page.getByTestId("manager-background").fill("분석가 출신");
  await page.getByTestId("start-game").click();
  await expect(page.getByTestId("chat-scroll")).toContainText("무응답확인", { timeout: 40_000 });

  const turnsBefore = await page.getByTestId("model-turn").count();

  // 델타만 흘리고 done도 error도 없이 끊긴 스트림
  await page.route("**/turn/stream", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/x-ndjson; charset=utf-8",
      body: '{"type":"delta","text":"@수석코치: 알"}\n',
    }),
  );

  await page.getByTestId("chat-input").fill("훈련 잡아줘");
  await page.getByTestId("chat-send").click();

  await expect(page.getByTestId("turn-error")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("turn-error")).toContainText("지연");
  // 반쯤 흘러온 장면은 채팅에 남지 않는다 — 서버도 저장하지 않았다
  await expect(page.getByTestId("model-turn")).toHaveCount(turnsBefore);
  await expect(page.getByTestId("chat-scroll")).not.toContainText("훈련 잡아줘");

  // **잠금이 풀렸다** — 같은 세이브의 다음 턴이 그대로 돈다
  await page.unroute("**/turn/stream");
  await expect(page.getByTestId("chat-input")).toBeEnabled();
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("model-turn")).toHaveCount(turnsBefore + 1, { timeout: 40_000 });
});
