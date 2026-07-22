import { expect, test } from "@playwright/test";

/**
 * 핵심 유저 여정 e2e (mock GM):
 * 온보딩(팀 선택 + 감독 직접 입력) → 부임 브리핑 → 훈련 지시(스킬 카드)
 * → 경기일 진행 → 킥오프 → 경기 완주 → 오피스 4뷰 검증
 */

test("온보딩부터 첫 경기 완주까지", async ({ page }) => {
  // ── 온보딩 ──
  await page.goto("/");
  await expect(page.getByTestId("team-grid")).toBeVisible();
  await page.getByTestId("team-arsenal").click();
  await page.getByTestId("manager-name").fill("김테스트");
  await page
    .getByTestId("manager-background")
    .fill("프리미어리그에서 뛰었던 주장 출신 수비수. 은퇴 후 데이터 분석을 공부했다.");
  await page.getByTestId("start-game").click();

  // ── 부임 브리핑 (온보딩 모델 턴) ──
  await expect(page.getByTestId("chat-scroll")).toContainText("김테스트", { timeout: 15_000 });
  await expect(page.getByTestId("chat-scroll")).toContainText("수석코치");
  await expect(page.getByTestId("game-phase")).toHaveText("일상");
  await expect(page.getByTestId("team-name")).toHaveText("아스날");

  // ── 훈련 지시 → 스킬 카드 노출 ──
  const input = page.getByTestId("chat-input");
  await input.fill("이번 주 훈련은 세트피스 위주로 잡아줘");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("tool-set_training_focus").first()).toBeVisible({
    timeout: 15_000,
  });

  // ── 전술 변경 ──
  await input.fill("4-4-2로 바꾸고 공격적으로 가자");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("tool-set_tactics").first()).toBeVisible({ timeout: 15_000 });

  // ── 경기일로 진행 ──
  await input.fill("다음 경기로 가자");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("game-phase")).toHaveText("경기일", { timeout: 20_000 });
  await expect(page.getByTestId("tool-advance_time").first()).toBeVisible();

  // ── 킥오프 ──
  await input.fill("경기 시작");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("chat-scroll")).toContainText("킥오프", { timeout: 20_000 });
  await expect(page.getByTestId("chat-scroll")).toContainText("중계");

  // ── "계속"으로 경기 완주 ──
  for (let i = 0; i < 15; i++) {
    const phase = await page.getByTestId("game-phase").textContent();
    if (phase === "일상") break;
    await input.fill("계속");
    await page.getByTestId("chat-send").click();
    // 응답이 오면 입력창이 다시 활성화된다 (버튼은 빈 입력이라 비활성일 수 있음)
    await expect(input).toBeEnabled({ timeout: 20_000 });
  }
  await expect(page.getByTestId("game-phase")).toHaveText("일상");
  await expect(page.getByTestId("chat-scroll")).toContainText("최종 스코어");

  // ── 오피스 4뷰 ──
  await page.getByTestId("tab-스쿼드").click();
  await expect(page.getByTestId("view-squad")).toContainText("선발");

  await page.getByTestId("tab-재정").click();
  await expect(page.getByTestId("view-finance")).toContainText("구단 잔고");

  await page.getByTestId("tab-일정·순위").click();
  const myRow = page.locator("tr.me");
  await expect(myRow).toContainText("ARS");
  await expect(myRow.locator("td").nth(2)).toHaveText("1"); // 1경기 소화

  await page.getByTestId("tab-커리어").click();
  await expect(page.getByTestId("view-career")).toContainText("김테스트 감독");
  await expect(page.getByTestId("view-career")).toContainText("리더십");
  await expect(page.getByTestId("view-career")).toContainText("트로피 보관함");
});

test("면담 시나리오 — 판정형 스킬과 사기 반영", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("team-chelsea").click();
  await page.getByTestId("manager-name").fill("박테스트");
  await page.getByTestId("manager-background").fill("에이전트 출신 협상가");
  await page.getByTestId("start-game").click();
  await expect(page.getByTestId("chat-scroll")).toContainText("박테스트", { timeout: 15_000 });

  // 스쿼드에서 첫 선수 이름을 읽어와 면담 지시
  await page.getByTestId("tab-스쿼드").click();
  const firstName = await page
    .getByTestId("view-squad")
    .locator("tbody tr")
    .first()
    .locator("td")
    .first()
    .textContent();
  // 성(姓)을 사용 — 이름 풀에 1글자 이름("톰" 등)이 있어 성이 안전하다
  const parts = (firstName ?? "").replace("Ⓒ", "").trim().split(" ");
  const shortName = parts[parts.length - 1] ?? "";
  expect(shortName.length).toBeGreaterThan(1);

  const input = page.getByTestId("chat-input");
  await input.fill(`${shortName} 면담 좀 하자`);
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("tool-talk_to_player").first()).toBeVisible({ timeout: 15_000 });
});
