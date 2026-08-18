import { expect, test } from "@playwright/test";

import { token } from "./palette";

test("새 게임 첫 메시지가 부임 장면과 수석코치 브리핑으로 표시된다", async ({ page }) => {
  await page.goto("/new");
  await expect(page.getByTestId("league-ring")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("league-epl").click();
  await expect(page.getByTestId("team-grid")).toBeVisible();

  await page.getByTestId("team-arsenal").click();
  await page.getByTestId("manager-name").fill("온보딩테스트");
  await page
    .getByTestId("manager-background")
    .fill("K리그 주장 출신으로 은퇴 후 데이터 분석과 유소년 지도를 공부했다.");
  await page.getByTestId("start-game").click();

  const firstTurn = page.getByTestId("model-turn").first();
  await expect(firstTurn).toBeVisible({ timeout: 30_000 });
  await expect(firstTurn).toContainText("온보딩테스트");
  // 화자 태그는 사람 이름이고 직책은 세이브가 안다 (docs/data/people.md §3)
  await expect(firstTurn.locator(".speaker-role").first()).toHaveText("수석코치");
  // 다만 **소개할 때 한 번만** — 같은 사람이 이어 말하는 줄엔 이름만 남는다.
  // 온보딩은 수석코치가 연속으로 말하므로 직책은 정확히 한 번 보인다
  await expect(firstTurn.locator(".speaker-role")).toHaveCount(1);
  await expect(firstTurn.locator(".narration")).toHaveCount(1);
  expect(await firstTurn.locator(".line").count()).toBeGreaterThanOrEqual(4);

  // 입력창의 자리는 대화 길이와 무관하다 — 첫 턴 하나뿐인 지금도 바닥에 붙어 있다.
  // (.chat-pane이 남은 높이를 채우지 않으면 메시지가 쌓일 때까지 화면 중앙에 뜬다)
  const input = await page.getByTestId("chat-input").boundingBox();
  const viewport = page.viewportSize();
  expect(input).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(viewport!.height - (input!.y + input!.height)).toBeLessThan(24);
});

test("부임은 리그 → 팀 → 감독 한 단계씩 서고, 되돌아갈 수 있다", async ({ page }) => {
  /**
   * 새 게임은 설정 폼이 아니라 부임이라는 사건이다 — 한 번에 한 가지만 묻고,
   * 고른 것은 다음 단계의 맥락으로 남는다 (season.md §1).
   */
  await page.goto("/new");
  await expect(page.getByTestId("league-ring")).toBeVisible({ timeout: 20_000 });
  // 리그를 고르기 전에는 팀도 감독도 화면에 없다 — 안내 문구로 때울 자리가 없다
  await expect(page.getByTestId("team-grid")).toHaveCount(0);
  await expect(page.getByTestId("manager-name")).toHaveCount(0);

  await page.getByTestId("league-epl").click();
  await expect(page.getByTestId("team-grid")).toBeVisible();
  await expect(page.getByTestId("league-ring")).toHaveCount(0);
  await expect(page.getByTestId("step-context")).toContainText("프리미어리그");

  await page.getByTestId("team-arsenal").click();
  // 마지막 단계는 부임 직전의 확인 — 팀과 보드 기대가 이름을 적기 전에 서 있다
  const appointment = page.getByTestId("appointment");
  await expect(appointment).toContainText("아스날");
  await expect(appointment).toContainText("우승 경쟁");
  await expect(appointment).toContainText("프리미어리그");
  await expect(page.getByTestId("start-game")).toContainText("아스날");

  // 진행 표시의 지나온 칸이 곧 되돌아가는 길이다 — 두 단계를 한 번에 건넌다
  await page.getByTestId("step-to-league").click();
  await expect(page.getByTestId("league-epl")).toHaveClass(/selected/);

  // 왼쪽 위 한 칸씩도 같은 길 — 되돌아가면 고른 것이 그대로 서 있다
  await page.getByTestId("league-epl").click();
  await page.getByTestId("step-back").click();
  await expect(page.getByTestId("league-epl")).toHaveClass(/selected/);
  await expect(page.getByTestId("league-ring")).toBeVisible();

  // 리그를 바꾸면 팀 선택은 무효 — 보이지 않는 선택은 남지 않는다
  await page.getByTestId("league-laliga").click();
  await expect(page.getByTestId("team-arsenal")).toHaveCount(0);
  await expect(page.getByTestId("step-context")).toContainText("라리가");
});

test("같은 시각은 다시 적지 않는다 — 화자 이름은 턴마다 선다", async ({ page }) => {
  /**
   * 시각이 턴마다 반복되면 시간이 흐른다는 신호가 오히려 죽는다 — 값이 바뀔 때만
   * 세운다. **화자 이름은 반대다**: 감독의 말과 코치의 답이 번갈아 오는 화면에서
   * 이름이 빠진 턴은 누가 말하는지를 위쪽까지 거슬러 찾아야 한다.
   */
  await page.goto("/new");
  await expect(page.getByTestId("league-ring")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("league-epl").click();
  await page.getByTestId("team-arsenal").click();
  await page.getByTestId("manager-name").fill("접기테스트");
  await page.getByTestId("manager-background").fill("전술 분석가 출신");
  await page.getByTestId("start-game").click();
  await expect(page.getByTestId("chat-scroll")).toContainText("접기테스트", { timeout: 30_000 });

  // 한 턴이 끝난 것은 **모델 턴이 하나 늘었다**로 안다 — 고정 대기는 빠른 날엔
  // 낭비고 느린 날엔 다음 발화를 아직 잠긴 입력칸에 밀어 넣는다.
  // 기다림은 기본값(15초)에 맡긴다 — 턴 하나가 그보다 오래 걸리면 케이스 전체가
  // 90초에 걸려 죽으므로, 여기서 늘려 잡으면 무엇이 멎었는지만 흐려진다
  const modelTurns = page.getByTestId("model-turn");
  const messages = ["팀 분위기는 좀 어때", "알겠어", "그대로 가자"];
  for (const [i, msg] of messages.entries()) {
    await expect(page.getByTestId("chat-input")).toBeEnabled();
    await page.getByTestId("chat-input").fill(msg);
    await page.getByTestId("chat-send").click();
    await expect(modelTurns).toHaveCount(i + 2);
  }

  const turns = await modelTurns.evaluateAll((nodes) =>
    nodes.map((n) => ({
      stamp: n.querySelector('[data-testid="scene-stamp"]')?.textContent?.trim() ?? null,
      speakers: [...n.querySelectorAll(".say-who .speaker")].length,
      says: [...n.querySelectorAll(".say")].length,
    })),
  );
  // ① 같은 시각이 연달아 서지 않는다
  const stamps = turns.map((t) => t.stamp).filter((x): x is string => x !== null);
  for (let i = 1; i < stamps.length; i++) {
    expect(stamps[i], "같은 시각이 연달아 섰다").not.toBe(stamps[i - 1]);
  }
  // ② 말한 사람이 있는 턴은 이름을 반드시 갖는다 (턴 단위로 선다)
  for (const t of turns) {
    if (t.says > 0) expect(t.speakers, "이름 없는 턴이 있다").toBeGreaterThan(0);
  }

  // 이름 색은 **강조색이 아니다** — 턴마다 서므로 원색이면 화면이 계속 깜빡인다.
  // 값이 아니라 토큰으로 비교한다: 팔레트를 손봐도 이 규칙은 그대로여야 한다
  const speakerColor = await page
    .locator(".say-who .speaker")
    .first()
    .evaluate((n) => getComputedStyle(n).color);
  expect(speakerColor).toBe(await token(page, "--silver"));
  expect(speakerColor).not.toBe(await token(page, "--accent"));
});
