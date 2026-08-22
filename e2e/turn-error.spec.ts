import { expect, test } from "@playwright/test";

import { COLD_MS } from "./timeouts";

/** 서버가 돌려주는 실패 문장 — 이 스펙이 만들어 넣고 배너에서 그대로 되찾는다 */
const SERVER_ERROR = "모델 서버가 혼잡합니다";

/**
 * LLM 실패 시 UI — **채팅은 그대로 두고 배너로만 알린다.** 실패한 턴은 채팅에
 * 아무것도 남기지 않는다: 유저 발화도, 사과 대사를 읊는 모델 턴도.
 *
 * 턴 응답을 502로 가로채 재현한다 (서버가 세이브를 건드리지 않는 것은
 * apps/web/test/turn-error.test.ts가 검증한다).
 */
test("LLM 실패 배너", async ({ page }) => {
  await page.goto("/new");
  await expect(page.getByTestId("league-ring")).toBeVisible({ timeout: COLD_MS });
  await page.getByTestId("league-epl").click();
  await page.getByTestId("team-arsenal").click();
  await page.getByTestId("manager-name").fill("에러확인");
  await page.getByTestId("manager-background").fill("분석가 출신");
  await page.getByTestId("start-game").click();
  await expect(page.getByTestId("chat-scroll")).toContainText("에러확인", { timeout: COLD_MS });

  const turnsBefore = await page.getByTestId("model-turn").count();

  // 턴 요청만 502로 (서버는 실제로 채팅을 저장하지 않는다 — turn-error.test.ts가 검증)
  await page.route("**/turn/stream", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        error: SERVER_ERROR,
        detail: '529 {"type":"overloaded_error"}',
      }),
    }),
  );

  await page.getByTestId("chat-input").fill("훈련 잡아줘");
  await page.getByTestId("chat-send").click();

  await expect(page.getByTestId("turn-error")).toBeVisible();
  // 배너는 **서버가 준 문장 그대로**를 세운다 — 이 문구의 주인은 위 라우트다
  await expect(page.getByTestId("turn-error")).toContainText(SERVER_ERROR);
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
 * 자리). 이 길도 **배너로 끝나야 한다** — 조용히 마감되면 낙관적 유저 발화가
 * 화면에만 남고 감독은 무엇이 반영됐는지 알 수 없다.
 *
 * 그리고 그 배너는 "취소"라고 말하지 않는다: 서버는 연결이 끊겨도 턴을 끝까지 돌려
 * 저장하므로 입력도 되돌아오지 않는다 — 되돌리면 재시도가 같은 지시를 두 번 태운다
 * (docs/llm/models.md §1-1).
 */
test("멎은 턴도 실패로 끝나고 다음 턴을 막지 않는다", async ({ page }) => {
  await page.goto("/new");
  await expect(page.getByTestId("league-ring")).toBeVisible({ timeout: COLD_MS });
  await page.getByTestId("league-epl").click();
  await page.getByTestId("team-arsenal").click();
  await page.getByTestId("manager-name").fill("무응답확인");
  await page.getByTestId("manager-background").fill("분석가 출신");
  await page.getByTestId("start-game").click();
  await expect(page.getByTestId("chat-scroll")).toContainText("무응답확인", { timeout: COLD_MS });

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

  await expect(page.getByTestId("turn-error")).toBeVisible();
  // 서버가 준 문장이 없는 길이다 — 배너가 세우는 것은 **클라이언트가 지어낸** 문장
  // (`TURN_TIMEOUT_MESSAGE`, turn-stream.ts). 두 실패를 가르는 것이 이 한 조각뿐이다
  await expect(page.getByTestId("turn-error")).toContainText("기다리기를 멈췄");
  await expect(page.getByTestId("turn-error")).not.toContainText("취소");
  // 반쯤 흘러온 장면은 채팅에 남지 않는다 — 이 스펙에서는 서버도 요청을 받지 않았다
  await expect(page.getByTestId("model-turn")).toHaveCount(turnsBefore);
  await expect(page.getByTestId("chat-scroll")).not.toContainText("훈련 잡아줘");
  // 입력은 되돌아오지 않는다 — 그 말은 서버에 가 있을 수 있다 (`다시 시도`도 잠긴다)
  await expect(page.getByTestId("chat-input")).toHaveValue("");

  // **잠금이 풀렸다** — 같은 세이브의 다음 턴이 그대로 돈다
  await page.unroute("**/turn/stream");
  await expect(page.getByTestId("chat-input")).toBeEnabled();
  await page.getByTestId("chat-input").fill("훈련 잡아줘");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("model-turn")).toHaveCount(turnsBefore + 1, { timeout: COLD_MS });
});
