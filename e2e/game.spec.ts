import { expect, test } from "@playwright/test";

/**
 * 핵심 유저 여정 e2e (mock GM):
 * 게임 목록 → 새 게임(팀 선택 + 감독 직접 입력) → 부임 브리핑 → 훈련 지시
 * (스킬 카드) → 경기일 진행 → 킥오프 → 경기 완주 → 오피스 4뷰 검증
 */

test("게임 목록에서 새 게임 → 첫 경기 완주까지", async ({ page }) => {
  // ── 랜딩(게임 목록) → 새 게임 ──
  await page.goto("/");
  await expect(page.getByTestId("new-game")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("new-game").click();
  await expect(page).toHaveURL(/\/new$/, { timeout: 20_000 });

  // ── 온보딩 ──
  await expect(page.getByTestId("team-grid")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("team-arsenal").click();
  await page.getByTestId("manager-name").fill("김테스트");
  await page
    .getByTestId("manager-background")
    .fill("프리미어리그에서 뛰었던 주장 출신 수비수. 은퇴 후 데이터 분석을 공부했다.");
  await page.getByTestId("start-game").click();

  // ── 부임 브리핑 (온보딩 모델 턴) ──
  await expect(page.getByTestId("chat-scroll")).toContainText("김테스트", { timeout: 30_000 });
  await expect(page.getByTestId("chat-scroll")).toContainText("수석코치");
  await expect(page.getByTestId("game-phase")).toHaveText("일상");
  await expect(page.getByTestId("team-name")).toHaveText("아스날");

  // ── 훈련 지시 → 스킬 카드 노출 (자유서술 → set_training) ──
  const input = page.getByTestId("chat-input");
  await input.fill("평일 오전은 세트피스 반복 훈련 잡아줘");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("tool-set_training").first()).toBeVisible({
    timeout: 15_000,
  });

  // ── 전술 변경 ──
  await input.fill("4-4-2로 바꾸고 공격적으로 가자");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("tool-set_tactics").first()).toBeVisible({ timeout: 15_000 });

  // ── 경기일로 진행 (부상·불만 발생 시 중간에 멈추므로 반복) ──
  for (let i = 0; i < 6; i++) {
    const phase = await page.getByTestId("game-phase").textContent();
    if (phase === "경기일") break;
    await input.fill("다음 경기로 가자");
    await page.getByTestId("chat-send").click();
    await expect(input).toBeEnabled({ timeout: 20_000 });
  }
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

  await page.getByTestId("tab-순위").click();
  const myRow = page.locator("tr.me");
  await expect(myRow).toContainText("아스날"); // 팀명은 한글로
  await expect(myRow.locator("td").nth(2)).toHaveText("1"); // 1경기 소화

  await page.getByTestId("tab-커리어").click();
  await expect(page.getByTestId("view-career")).toContainText("김테스트 감독");
  await expect(page.getByTestId("view-career")).toContainText("리더십");
  await expect(page.getByTestId("view-career")).toContainText("트로피 보관함");
});

test("면담 시나리오 — 판정형 스킬과 사기 반영", async ({ page }) => {
  await page.goto("/new");
  await expect(page.getByTestId("team-grid")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("team-chelsea").click();
  await page.getByTestId("manager-name").fill("박테스트");
  await page.getByTestId("manager-background").fill("에이전트 출신 협상가");
  await page.getByTestId("start-game").click();
  await expect(page.getByTestId("chat-scroll")).toContainText("박테스트", { timeout: 30_000 });

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

  // 채팅 탭으로 돌아와 면담 지시 (입력창은 채팅 탭에만 있다)
  await page.getByTestId("tab-채팅").click();
  const input = page.getByTestId("chat-input");
  await input.fill(`${shortName} 면담 좀 하자`);
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("tool-talk_to_player").first()).toBeVisible({ timeout: 15_000 });
});

test("달력 상세와 전술판 라인업 편집", async ({ page }) => {
  await page.goto("/new");
  await expect(page.getByTestId("team-grid")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("team-liverpool").click();
  await page.getByTestId("manager-name").fill("정테스트");
  await page.getByTestId("manager-background").fill("전술 분석가 출신");
  await page.getByTestId("start-game").click();
  await expect(page.getByTestId("chat-scroll")).toContainText("정테스트", { timeout: 30_000 });

  // 채팅에서 자연어 훈련 지시 → set_training 스킬
  const chat = page.getByTestId("chat-input");
  await chat.fill("월요일 오전은 세트피스 반복 훈련 잡아줘");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("tool-set_training").first()).toBeVisible({ timeout: 15_000 });

  // 달력 — 경기 셀 클릭 → 상세 패널 (상대·라운드). 편집 UI 없음(읽기 전용)
  await page.getByTestId("tab-달력").click();
  await expect(page.getByTestId("view-calendar")).toContainText("시즌 일정");
  await expect(page.getByTestId("view-calendar")).toContainText("채팅에서 지시");
  await page.locator('[data-testid^="cal-fixture-"]').first().click();
  await expect(page.getByTestId("cal-detail")).toBeVisible();
  await expect(page.getByTestId("cal-detail")).toContainText("R1");

  // 전술판 — 진입, 포메이션 변경, 벤치↔슬롯 스왑, 저장
  await page.getByTestId("tab-스쿼드").click();
  await page.getByTestId("edit-lineup").click();
  await expect(page.getByTestId("lineup-editor")).toBeVisible();
  await expect(page.getByTestId("pitch-board")).toBeVisible();
  await expect(page.locator(".pitch-slot")).toHaveCount(11);

  await page.getByTestId("formation-select").selectOption("4-4-2");
  await expect(page.locator(".pitch-slot")).toHaveCount(11);

  // 벤치/예비 지정 — 카운트가 보이고, 벤치 지정 선수를 예비로 토글
  await expect(page.getByTestId("bench-count")).toContainText("벤치");
  // 특정 칩을 testid로 고정 (위치 기반 locator는 토글 후 다른 칩으로 재평가됨)
  const firstOnBenchTid = await page
    .locator(".bench-chip.on-bench .bench-toggle")
    .first()
    .getAttribute("data-testid");
  const toggle = page.getByTestId(firstOnBenchTid!);
  await expect(toggle).toHaveText("벤치");
  await toggle.click();
  await expect(toggle).toHaveText("예비");

  // 벤치 첫 선수 선택 → 슬롯 10과 교체
  const firstBench = page.locator(".bench-chip").first();
  const benchName = await firstBench.locator(".slot-name").textContent();
  await firstBench.click();
  await page.getByTestId("slot-10").click();
  await expect(page.getByTestId("slot-10")).toContainText(benchName ?? "");

  // 저장 → 편집기 닫힘, 스쿼드 표에 새 선발 반영
  await page.getByTestId("save-lineup").click();
  await expect(page.getByTestId("lineup-editor")).toBeHidden({ timeout: 10_000 });
  await expect(page.getByTestId("edit-lineup")).toBeVisible();
  await expect(page.getByTestId("view-squad")).toContainText("4-4-2");

  // 전술판 저장은 채팅에 전송되지 않는다 (사용자 요청) — 채팅엔 훈련 지시 턴만
  await page.getByTestId("tab-채팅").click();
  await expect(page.getByTestId("chat-scroll")).not.toContainText("전술 보드를 정리");
});
