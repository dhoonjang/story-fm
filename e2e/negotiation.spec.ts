import { expect, test } from "@playwright/test";

import { seedTransferTarget } from "./seed";
import { COLD_MS } from "./timeouts";

/**
 * 협상 방 한 판 — **여닫는 경로** (transfer.md §12-2 · design-system.md §7-1).
 *
 * 경기와 같은 골격이다: `start_negotiation`이 방을 세우면 게이트가 서고, 자리에 앉으면
 * 무대가 방으로 갈리고(조건서 · 인내 · 건너편), 일어서면 평시로 돌아온다. 그 사이의
 * 턴은 메인 채팅에서 한 덩어리로 묶인다.
 *
 * ⚠️ **채팅에 치는 말은 mock 대본의 키다** (`packages/agents/src/mock-script.ts`). 글자가
 * 하나만 달라도 그 턴은 아무 도구도 부르지 않는다. 상대는 픽스처가 고른다 —
 * `seedTransferTarget`이 코어에게 물어 성사 확률이 문턱을 넘는 이름을 준다.
 */
test("협상 방 — 단장과 앉아 값을, 에이전트와 앉아 조건을 맞춘다", async ({ page }) => {
  const { gameId, targetName } = seedTransferTarget();
  await page.goto(`/game/${gameId}`);

  const input = page.getByTestId("chat-input");
  await expect(input).toBeEnabled({ timeout: COLD_MS });
  await expect(page.locator(".app")).toHaveAttribute("data-phase", "idle");

  // ① 방을 세운다 — 게이트가 서고 단계는 이미 협상이다. 화자는 아직 평시 GM이다
  await input.fill(`${targetName} 협상하자`);
  await page.getByTestId("chat-send").click();
  const gate = page.getByTestId("negotiation-gate");
  await expect(gate).toBeVisible();
  await expect(page.locator(".app")).toHaveAttribute("data-phase", "negotiation");
  // 게이트는 방의 지금을 든다 — 누구와의 자리인가, 인내는 얼마나 남았나
  await expect(gate).toContainText(targetName);
  await expect(gate.getByTestId("negotiation-patience")).toBeVisible();
  // 문이 닫힌 동안 방의 칸은 아직 없다 — 뒤에 남는 것은 오피스다
  await expect(page.getByTestId("negotiation-room")).toHaveCount(0);

  /**
   * ② 자리에 앉는다 — **문을 연 것은 감독이고 그 사실은 화면이 먼저 안다.** 킥오프와
   * 같은 규칙이라 누른 직후의 지금을 그대로 센다: 무대는 서버의 답이 오기 전에 이미
   * 방이다.
   */
  await page.getByTestId("negotiation-enter").click();
  expect(await page.locator(".app.in-negotiation").count()).toBe(1);
  await expect(gate).toHaveCount(0);
  const room = page.getByTestId("negotiation-room");
  await expect(room).toBeVisible();
  await expect(room).toContainText(targetName);
  // 장부 레일은 그대로 선다 — 채팅 탭이 방으로 돌아오는 문이다
  await expect(page.getByTestId("tab-채팅")).toBeVisible();
  // 방 안에서 날짜는 흐르지 않는다 — 빈 입력의 손잡이가 잠긴다
  await expect(input).toBeEnabled();
  await expect(page.getByTestId("time-skip-toggle")).toBeDisabled();

  // ③ 값 없는 말 — 상대가 답만 한다. 방은 그대로 열려 있고 인내의 칸이 선다
  await input.fill("조건을 먼저 들어 보고 싶습니다");
  await page.getByTestId("chat-send").click();
  await expect(input).toBeEnabled();
  await expect(page.locator(".app")).toHaveAttribute("data-phase", "negotiation");
  await expect(room.getByTestId("negotiation-patience")).toBeVisible();

  // ④ 일어선다 — 협상은 열린 채 방만 닫히고 단계는 들어오기 전으로 돌아간다
  await page.getByTestId("negotiation-leave").click();
  await expect(page.locator(".app")).toHaveAttribute("data-phase", "idle");
  await expect(room).toHaveCount(0);
  expect(await page.locator(".app.in-negotiation").count()).toBe(0);
  // 방 안의 턴은 메인 채팅에서 한 덩어리로 묶인다 — 열린 협상이라 접히지는 않는다
  await expect(page.locator('[data-testid^="negotiation-log-"]')).toHaveCount(1);
  await expect(page.locator(".negotiation-log-head")).toHaveCount(0);
  // 시간 손잡이가 돌아온다
  await expect(page.getByTestId("time-skip-toggle")).toBeEnabled();

  /**
   * ⑤ 다시 단장과 앉아 값을 부른다 — 같은 협상이라 같은 테이블이다. 값이 실린 말은
   * 손잡이를 부르고 단장이 답한다. 픽스처가 고른 상대는 확률이 문턱을 넘어 앵커가
   * **수락**인데, 단장의 수락은 **이적료의 합의**다 — 개인 조건은 에이전트의 방에서
   * 따로 굳혀야 하므로 협상도 방도 열려 있다 (transfer.md §12-1 「두 테이블, 두 사람」).
   */
  await input.fill(`${targetName} 협상하자`);
  await page.getByTestId("chat-send").click();
  await expect(gate).toBeVisible();
  await expect(gate).toContainText("단장");
  await page.getByTestId("negotiation-enter").click();
  await expect(room).toBeVisible();
  await expect(room).toContainText("단장");
  // 폼의 구성은 건너편이 정한다 — 단장 앞에서는 이적료의 절만 선다 (design-system.md §6)
  await page.getByTestId("negotiation-propose").click();
  const form = page.getByTestId("proposal-form");
  await expect(form).toBeVisible();
  await expect(form.getByTestId("proposal-club")).toBeVisible();
  await expect(form.getByTestId("proposal-agent")).toHaveCount(0);
  await form.getByRole("button", { name: "닫기" }).click();
  await expect(form).toHaveCount(0);
  await input.fill("제안한 조건으로 갑시다");
  await page.getByTestId("chat-send").click();
  await expect(page.locator(".market-card").first()).toBeVisible();
  await expect(input).toBeEnabled();
  await expect(page.locator(".app")).toHaveAttribute("data-phase", "negotiation");
  await expect(room).toContainText("이적료 합의");
  await expect(page.locator(".negotiation-log-head")).toHaveCount(0);

  /**
   * ⑥ 일어나 에이전트의 방을 연다 — 건너편이 갈리고, 이 방의 값은 개인 조건이다. 굳은
   * 이적료는 조건서에 그대로 서 있다. 에이전트가 받아들이면 둘이 다 굳어 **합의**고,
   * 합의된 협상에 앉아 있는 방은 없다 — 코어가 같은 턴에 방을 닫는다.
   */
  await page.getByTestId("negotiation-leave").click();
  await expect(room).toHaveCount(0);
  await input.fill(`${targetName} 에이전트 만나자`);
  await page.getByTestId("chat-send").click();
  await expect(gate).toBeVisible();
  await expect(gate).not.toContainText("단장");
  await page.getByTestId("negotiation-enter").click();
  await expect(room).toBeVisible();
  await expect(room).toContainText("이적료 합의");
  // 에이전트 앞에서는 개인 조건의 절만 선다 — 이적료는 단장의 방의 것이다
  await page.getByTestId("negotiation-propose").click();
  await expect(form).toBeVisible();
  await expect(form.getByTestId("proposal-agent")).toBeVisible();
  await expect(form.getByTestId("proposal-club")).toHaveCount(0);
  await form.getByRole("button", { name: "닫기" }).click();
  await expect(form).toHaveCount(0);
  await input.fill("제안한 조건으로 갑시다");
  await page.getByTestId("chat-send").click();
  await expect(input).toBeEnabled();
  await expect(page.locator(".app")).toHaveAttribute("data-phase", "idle");
  await expect(room).toHaveCount(0);
  // 끝난 협상은 자리마다 한 덩어리로 접힌다 — 세 번 앉았으니 셋, 결과는 마지막 자리의 머리에만
  const heads = page.locator(".negotiation-log-head");
  await expect(heads).toHaveCount(3);
  await expect(heads.last()).toHaveAttribute("data-status", "agreed");
  await expect(heads.first()).not.toHaveAttribute("data-status", /.+/);
  for (const head of await heads.all()) await expect(head).toContainText(targetName);
});
