import { expect, test, type Page } from "@playwright/test";

/**
 * 핵심 유저 여정 e2e (mock GM):
 * 게임 목록 → 새 게임(팀 선택 + 감독 직접 입력) → 부임 브리핑 → 훈련 지시
 * (스킬 카드) → 경기일 진행 → 킥오프 → 경기 완주 → 오피스 4뷰 검증
 */

/**
 * **같은 선수의 OVR은 전술판 칩과 명단에서 같은 숫자여야 한다.**
 *
 * 예전엔 칩이 `roleFit`으로 처음부터 다시 계산하고 명단은 서버 값에 차이만
 * 얹어서, 같은 선수가 왼쪽과 오른쪽에서 다른 숫자를 달고 있었다. 특히
 * **비선발을 선발로 올린 직후** 크게 갈렸다 — 명단은 종합값 그대로인데 칩만
 * 자리 값으로 뛰었다. 지금은 두 곳이 `slotOverallOf` 하나를 부른다.
 */
/** 전술판 손잡이를 눌러 판을 펼친다 — 이미 펼쳐져 있으면 그대로 둔다 */
async function pressBoardToggle(page: Page, testId = "board-toggle") {
  const toggle = page.getByTestId(testId);
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
}

/** 접힌 전술 패널을 펼친다 — 눈금(1~5 버튼)은 펼쳤을 때만 있다 */
async function openTactics(page: Page) {
  const toggle = page.getByTestId("tactics-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

/**
 * 스쿼드 화면을 열고 **전술판까지 펼친다.**
 *
 * 스쿼드는 어느 폭에서나 **명단만** 먼저 보인다 — 판은 폭도 높이도 크게 먹으므로
 * 감독이 부를 때 선다. 판을 만지는 테스트는 손잡이를 눌러 받아야 한다.
 */
async function openBoard(page: Page) {
  await page.getByTestId("tab-스쿼드").click();
  await pressBoardToggle(page);
  await expect(page.getByTestId("pitch-board")).toBeVisible();
}

async function expectOvrConsistent(page: Page) {
  const check = await page.evaluate(() => {
    const chips = [...document.querySelectorAll(".pitch-slot")].map((el) => ({
      name: (el.querySelector(".slot-name")?.textContent ?? "").replace("Ⓒ", "").trim(),
      ovr: (el.querySelector(".slot-meta b")?.textContent ?? "").trim(),
    }));
    const heads = [...document.querySelectorAll(".squad-table thead th")];
    const col = heads.findIndex((h) => (h.textContent ?? "").includes("OVR"));
    const rows = [...document.querySelectorAll(".squad-table tbody tr")];
    const out: string[] = [];
    let compared = 0;
    for (const chip of chips) {
      if (!chip.name || !chip.ovr) continue;
      // 칩은 **성만** 보여준다(`chipName`) — 명단의 전체 이름에서 마지막 낱말로 잇는다.
      // 성이 겹치면 어느 행인지 알 수 없으므로 건너뛴다 (틀린 비교보다 안 하는 게 낫다)
      const matches = rows.filter((r) => {
        const full = (r.querySelector(".row-name")?.textContent ?? "").replace("Ⓒ", "").trim();
        return full.split(/\s+/).at(-1) === chip.name;
      });
      if (matches.length !== 1) continue;
      const row = matches[0]!;
      const cell = (row.querySelectorAll("td")[col]?.textContent ?? "").replace("?", "").trim();
      compared++;
      if (cell !== chip.ovr) out.push(`${chip.name}: 칩 ${chip.ovr} vs 명단 ${cell}`);
    }
    return { mismatched: out, compared };
  });
  // 이름이 안 붙어 아무것도 비교하지 못한 채 통과하는 일이 없게 한다
  expect(check.compared).toBeGreaterThanOrEqual(8);
  expect(check.mismatched).toEqual([]);
}

test("게임 목록에서 새 게임 → 첫 경기 완주까지", async ({ page }) => {
  // ── 랜딩(게임 목록) → 새 게임 ──
  await page.goto("/");
  await expect(page.getByTestId("new-game")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("new-game").click();
  await expect(page).toHaveURL(/\/new$/, { timeout: 20_000 });

  // ── 온보딩 ──
  await expect(page.getByTestId("league-ring")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("league-epl").click();
  await expect(page.getByTestId("team-grid")).toBeVisible();
  await page.getByTestId("team-arsenal").click();
  await page.getByTestId("manager-name").fill("김테스트");
  await page
    .getByTestId("manager-background")
    .fill("프리미어리그에서 뛰었던 주장 출신 수비수. 은퇴 후 데이터 분석을 공부했다.");
  await page.getByTestId("start-game").click();

  // ── 부임 브리핑 (온보딩 모델 턴) ──
  await expect(page.getByTestId("chat-scroll")).toContainText("김테스트", { timeout: 30_000 });
  // 화자는 이름으로 말하고, 직책은 화면이 붙인다 — `알베르트 스투이벤베르흐 (수석코치)`
  // 직함은 괄호가 아니라 칩이다 — 테두리가 경계를 말한다
  await expect(page.locator(".say-who .speaker-role").first()).toHaveText("수석코치");

  await expect(page.getByTestId("chat-scroll")).toContainText("수석코치");
  // 단계는 화면에 배지로 적지 않는다 — 앱 루트의 `data-phase`가 그 자리다
  await expect(page.locator(".app")).toHaveAttribute("data-phase", "idle");
  await expect(page.getByTestId("team-name")).toHaveText("아스날");

  // ── 훈련 지시 (자유서술 → set_training) ──
  const input = page.getByTestId("chat-input");
  await input.fill("평일 오전은 세트피스 반복 훈련 잡아줘");
  await page.getByTestId("chat-send").click();
  /**
   * 장부가 바뀐 일은 **그 화면 쪽에서** 알린다 — 훈련은 달력 아이콘 아래 말풍선으로
   * 선다. 그 지시는 채팅에도 칩으로 남는다: 알림은 다음 클릭에 닫히므로 되짚을
   * 자리가 있어야 한다.
   */
  await expect(page.getByTestId("hint-달력")).toBeVisible({ timeout: 15_000 });
  const trainChip = page.getByTestId("tool-set_training").first();
  await expect(trainChip).toBeVisible();
  // 답이 끝나면 커서가 입력칸으로 돌아온다 — 감독은 대개 이어서 말한다
  await expect(page.getByTestId("chat-input")).toBeEnabled();
  await expect(page.getByTestId("chat-input")).toBeFocused();
  // 다른 쪽을 누르면 알림은 닫히고, 칩을 누르면 그 말풍선이 다시 선다
  await page.getByTestId("chat-scroll").click({ position: { x: 4, y: 4 } });
  await expect(page.getByTestId("hint-달력")).toHaveCount(0);
  await trainChip.click();
  await expect(page.getByTestId("hint-달력")).toBeVisible();
  /**
   * 기다리는 동안은 **말로 적지 않는다** — "세계가 반응하는 중…"을 띄우던 때는
   * 매 턴 같은 문장이 대화 사이에 끼어 대사인 척했다. 점 세 개면 충분하다.
   */
  await expect(page.getByTestId("chat-scroll")).not.toContainText("세계가 반응");

  // ── 전술 변경 ──
  await input.fill("4-4-2로 바꾸고 공격적으로 가자");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("hint-스쿼드")).toBeVisible({ timeout: 15_000 });

  // ── 경기일로 진행 (부상·불만 발생 시 중간에 멈추므로 반복) ──
  // 정지 횟수는 세이브 시드마다 달라 넉넉히 돈다 — 6회로는 간간이 못 닿았다
  for (let i = 0; i < 14; i++) {
    const phase = await page.locator(".app").getAttribute("data-phase");
    if (phase === "matchday") break;
    await input.fill("다음 경기로 가자");
    await page.getByTestId("chat-send").click();
    await expect(input).toBeEnabled({ timeout: 20_000 });
  }
  await expect(page.locator(".app")).toHaveAttribute("data-phase", "matchday", { timeout: 20_000 });
  // 시계 이동은 스킬이 아니라 코어의 처리 결과다 — **칩으로 세우지 않는다**.
  // 시간이 흘렀다는 증거는 위의 phase(=matchday)이고, 칩은 감독이 부른 것만 선다
  await expect(page.getByTestId("tool-시간 경과")).toHaveCount(0);

  /**
   * ── 킥오프는 **세 걸음**이다 ──────────────────────────
   * GM이 `start_match`로 문을 열고(판이 서고 판세가 계산된다), 감독이 입장 확인
   * 창을 지나면 중계가 첫 휘슬만 연다. 공이 구르는 것은 그다음 진행부터다 —
   * 예전엔 입장과 동시에 20분이 지나가 감독이 킥오프를 본 적이 없었다.
   */
  await input.fill("경기 시작하자");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("kickoff-gate")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("chat-scroll")).not.toContainText("중계");
  await page.getByTestId("kickoff-enter").click();
  await expect(page.getByTestId("kickoff-gate")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId("chat-scroll")).toContainText("킥오프", { timeout: 20_000 });
  await expect(page.getByTestId("chat-scroll")).toContainText("중계");
  // 첫 휘슬 턴은 시계를 움직이지 않는다 — 0분에서 감독의 차례로 돌아온다
  await expect(page.getByTestId("match-clock").locator("b")).toHaveText("0′", { timeout: 10_000 });

  /**
   * 중계 판세 — 스코어는 **화면에 붙어 있고**, 선수 기록은 실시간으로 붙는다.
   * 아래로 훑어 내려가도 지금 몇 대 몇인지가 시야에서 사라지면 안 된다.
   */
  await expect(page.getByTestId("view-match")).toBeVisible();
  const score = page.getByTestId("match-score");
  await expect(score).toBeVisible();
  /**
   * 규칙은 **"스크롤해도 스코어가 시야에 남는다"** 이지 특정 CSS가 아니다.
   * (sticky로 붙이든 상단 띠에 고정하든 감독에겐 같은 일이다 — 예전엔
   * `position: sticky`를 단언했다가 더 나은 구현을 막을 뻔했다.)
   */
  await page.getByTestId("stage-board").evaluate((n) => n.scrollTo({ top: n.scrollHeight }));
  await expect(score).toBeInViewport();

  /*
   * 경기 화면 — **오피스 메뉴가 사라지고 경기 탭이 선다.**
   * 채팅은 왼쪽에 고정되고 오른쪽이 탭에 따라 바뀐다.
   */
  await expect(page.locator(".rail.match-rail")).toBeVisible();
  await expect(page.getByTestId("tab-스쿼드")).toHaveCount(0);
  for (const tab of ["판세", "팀", "대회"]) {
    await page.getByTestId(`mtab-${tab}`).click();
    await expect(page.getByTestId("stage-board")).not.toBeEmpty();
  }
  // 90분 안에 볼 것만 남긴다 — 달력은 그때 갈 곳이 아니다 (다음 경기는 대회 탭에)
  await expect(page.getByTestId("mtab-달력")).toHaveCount(0);
  await page.getByTestId("mtab-대회").click();
  await expect(page.getByTestId("next-fixture")).toBeVisible();
  /**
   * 대회 뷰는 **어디서 열리든 같은 표**다 — 경기 탭이든 장부든.
   * 표의 바탕(`border-collapse` · 칸 여백)이 장부 쪽에만 걸려 있던 때는, 경기 중에
   * 연 순위표만 브라우저 기본 표로 떨어져 같은 화면이 두 얼굴을 가졌다.
   */
  await expect(page.getByTestId("standings")).toBeVisible();
  await expect(
    page.getByTestId("standings").evaluate((el) => getComputedStyle(el).borderCollapse),
  ).resolves.toBe("collapse");

  /**
   * 판세 = 존 + 키포인트 한 화면. 전술 6축은 여기 없다 — 전술판이 갖는다
   * (두 곳에 같은 값을 세우면 어느 쪽이 진짜인지 흐려진다)
   */
  await page.getByTestId("mtab-판세").click();
  await expect(page.getByTestId("match-zones")).toBeVisible();
  await expect(page.getByTestId("match-tactics")).toHaveCount(0);

  /**
   * 팀 탭 — **우리와 상대가 같은 구성, 다른 정확도.**
   * 양쪽 다 판 → 전술 → 명단으로 읽히고, 상대는 안개를 지나 조작이 없다.
   */
  await page.getByTestId("mtab-팀").click();
  await page.getByTestId("side-theirs").click();
  await expect(page.getByTestId("view-match-opponent")).toBeVisible();
  /**
   * 상대 명단은 **우리 명단과 같은 표**다 — 같은 클래스, 같은 구역 경계선.
   * 마크업이 갈리면 두 탭에서 같은 것이 다른 높이·다른 모양으로 서고, 감독은
   * 오갈 때마다 눈으로 자리를 다시 찾는다.
   */
  const oppTable = page.getByTestId("opponent-table");
  await expect(oppTable).toHaveClass(/squad-table/);
  await expect(oppTable.locator("tbody tr.row-tier.t-start")).toHaveCount(11);
  // 칸이 갈리는 자리는 **선 하나**다 — 이름(선발·벤치)은 적지 않는다
  const oppDividers = oppTable.locator("tbody tr.tier-head");
  expect(await oppDividers.count()).toBeGreaterThan(0);
  await expect(oppDividers.first()).toHaveText("");
  // 상대 명단은 훑는 것이지 고르는 것이 아니다 — 우리 표와 달리 손에 반응하지 않는다
  await expect(
    oppTable
      .locator("tbody tr.row-tier")
      .first()
      .evaluate((el) => getComputedStyle(el).cursor),
  ).resolves.toBe("default");
  // 경기 중에도 명단이 먼저다 — 판은 손잡이를 눌러야 선다 (양쪽 탭이 같은 상태를 쓴다)
  await expect(page.getByTestId("opponent-board")).not.toBeVisible();
  await pressBoardToggle(page, "opp-board-toggle");
  await expect(page.getByTestId("opponent-board")).toBeVisible();
  await expect(page.locator("#__next, body").locator(".pitch-slot.theirs")).toHaveCount(11);
  // 상대 전술은 읽기 전용 — 우리 쪽에만 있는 조작 버튼이 여기엔 없다
  await expect(page.getByTestId("match-tactics")).toBeVisible();
  await expect(page.getByTestId("tactic-pressing-5")).toHaveCount(0);
  /**
   * 판을 펼치면 **채팅 자리 위에 한 장이 얹힌다** — 대화는 지워지지 않고 가라앉는다.
   * 그 자리가 돌아갈 곳이라는 게 보여야 하므로 흐릿하게 남고, 손은 닿지 않는다.
   * 접으면 있던 자리에서 그대로 다시 떠오른다.
   */
  // 값이 260ms에 걸쳐 잦아든다 — 한 번 읽고 끝내면 지나가는 중간값을 집는다
  const chatDim = () =>
    page.locator(".chat-pane").evaluate((el) => Number(getComputedStyle(el).opacity));
  await expect(page.getByTestId("chat-scroll")).toBeVisible();
  await expect.poll(chatDim).toBeLessThan(0.5);
  await expect
    .poll(() => page.locator(".chat-pane").evaluate((el) => getComputedStyle(el).pointerEvents))
    .toBe("none");
  /**
   * 가라앉은 대화를 **누르면 닫힌다** — 서랍 밖을 눌러 닫는 몸짓이라 안내가 없다.
   * 손이 닿는 곳은 덮개(`board-scrim`)이지 아래 채팅이 아니다.
   */
  await expect(page.getByTestId("board-scrim")).toBeVisible();
  await page.getByTestId("board-scrim").click({ position: { x: 40, y: 300 } });
  await expect.poll(chatDim).toBe(1);
  await expect(page.getByTestId("opp-board-toggle")).toHaveAttribute("aria-pressed", "false");
  await pressBoardToggle(page, "opp-board-toggle");

  /*
   * 전술판 — **자동 저장은 막히지만 판은 살아 있다.**
   * 조작은 곧바로 상태가 되지 않고 GM에게 보내는 지시가 된다(`onOrder`).
   * 우리 팀 6축은 여기서 **고칠 수 있다** (경기 중에는 그것이 지시가 된다).
   */
  await page.getByTestId("side-ours").click();
  await openTactics(page);
  await expect(page.getByTestId("tactic-pressing-5")).toBeVisible();
  await expect(page.locator(".pitch-slot")).toHaveCount(11);
  // 자동 저장이 아니라 지시를 받는 상태 — 보낼 지시가 쌓이면 `pending`이 된다
  await expect(page.getByTestId("view-squad")).toHaveAttribute("data-save", "ready");
  // 선수를 고르면 교체할 상대에 화살표가 뜬다 — 그 화살표가 교체 지시를 보낸다
  await page.locator(".squad-table tbody tr.row-tier.t-start:not(.detail-row)").nth(6).click();
  await expect(page.locator(".squad-table .swap-btn").first()).toBeVisible();
  await page.getByTestId("mtab-판세").click();

  // ── 진행 버튼으로 경기 완주 — 경기 중에는 빈 입력의 손잡이가 **진행**이다 ──
  for (let i = 0; i < 15; i++) {
    const phase = await page.locator(".app").getAttribute("data-phase");
    if (phase === "idle") break;
    await page.getByTestId("match-advance").click();
    await expect(input).toBeEnabled({ timeout: 20_000 });
  }
  await expect(page.locator(".app")).toHaveAttribute("data-phase", "idle");
  /*
   * 종료 화면 — 휘슬과 평시 사이의 한 걸음. 스코어·득점·잘한 선수까지만 짧게.
   */
  const fulltime = page.getByTestId("fulltime");
  await expect(fulltime).toBeVisible({ timeout: 20_000 });
  await expect(fulltime).toContainText("경기 종료");
  await page.getByTestId("fulltime-close").click();
  await expect(fulltime).toHaveCount(0);
  /*
   * 경기가 끝나면 그 대화는 **한 장으로 접힌다** — 중계 수십 턴이 평시 대화 사이에
   * 그대로 흐르지 않는다. 결과 카드가 그 자리에 서고, 펼치면 그때의 중계가 나온다.
   */
  const log = page.locator(".match-log-head");
  await expect(log).toHaveCount(1);
  await expect(page.locator(".turn-model.in-match"), "경기 이력이 접히지 않았다").toHaveCount(0);
  await log.click();
  await expect(page.getByTestId("chat-scroll")).toContainText("최종 스코어");

  // ── 오피스 4뷰 ──
  await page.getByTestId("tab-스쿼드").click();
  await expect(page.getByTestId("view-squad")).toContainText("선발");

  /*
   * **시즌 첫 경기는 프리시즌 친선이다** — 몸(폼·체력)에는 남고 시즌 기록에는
   * 안 남는다(season.md §2). 그래서 여기서 도움·평점을 물으면 빈칸이 맞다.
   * 시즌 기록이 서는 것은 개막 이후이고, 그 규칙은 단위 테스트가 지킨다
   * (`friendly-ledger.test.ts` · `ratings.test.ts`).
   */
  await page.locator(".squad-table tbody tr.row-tier.t-start:not(.detail-row)").first().click();
  const detail = page.getByTestId("player-detail");
  await expect(detail).toContainText("폼");
  await expect(detail).not.toContainText("도움");
  await page.locator(".squad-table tbody tr.row-tier.t-start:not(.detail-row)").first().click();

  await page.getByTestId("tab-재정").click();
  await expect(page.getByTestId("view-finance")).toContainText("구단 잔고");
  // 실시간 재정 활동 + 이번 달 진행 중 집계 (club-finance §7·§8)
  await expect(page.getByTestId("fin-feed")).toContainText("선수 주급");
  await expect(page.getByTestId("view-finance")).toContainText("월간 재정 보고서");
  await expect(page.getByTestId("view-finance")).toContainText("진행 중");

  // ── 대회 탭 — 대회별 순위 + 라운드별 일정 ──
  await page.getByTestId("tab-대회").click();
  const myRow = page.getByTestId("standings").locator("tr.me");
  await expect(myRow).toContainText("아스날"); // 팀명은 한글로
  // 치른 경기는 친선이라 순위표는 그대로다 — 대회를 세는 자리는 친선을 건너뛴다
  await expect(myRow.locator("td").nth(2)).toHaveText("0");
  // 라운드별 일정 — 우리 경기가 표시되고 라운드를 오갈 수 있다
  const fixtures = page.getByTestId("round-fixtures");
  await expect(fixtures.locator(".fixture.ours")).toHaveCount(1);
  await page.getByTestId("round-select").selectOption({ index: 0 });
  await expect(fixtures.locator(".fixture")).toHaveCount(10); // 20팀 = 라운드당 10경기
  // 1라운드는 아직이다 — 치른 경기는 친선이고 대회 화면에 서지 않는다
  await expect(fixtures.locator(".fixture.ours .mid.played")).toHaveCount(0);

  // 국내 컵 — 순위표 없는 녹아웃이라 표 대신 브래킷이 나온다
  await page.getByTestId("comp-tab-eflcup").click();
  await expect(page.getByTestId("view-competitions")).toContainText("카라바오컵");
  await expect(page.getByTestId("standings")).toHaveCount(0);
  await expect(page.getByTestId("comp-tab-facup")).toBeVisible();

  // 컵 추첨도 일정 축에 오른다 — 경기가 아니라 "상대가 정해지는 날"
  await page.getByTestId("tab-달력").click();
  const draw = page.locator('[data-testid^="cal-draw-"]').first();
  await expect(draw).toBeVisible();
  await draw.click();
  await expect(page.getByTestId("cal-detail")).toContainText("대진 추첨");

  await page.getByTestId("tab-커리어").click();
  await expect(page.getByTestId("view-career")).toContainText("김테스트 감독");
  await expect(page.getByTestId("view-career")).toContainText("리더십");
  await expect(page.getByTestId("view-career")).toContainText("트로피 보관함");

  // ── 로고 → 게임 목록으로 나가기 (진행한 게임이 목록에 남아 있다) ──
  await page.getByTestId("home-link").click();
  await expect(page).toHaveURL(/localhost:\d+\/$/, { timeout: 20_000 });
  await expect(page.getByTestId("new-game")).toBeVisible();
  /*
   * 진행한 게임이 목록에 남아 있다 — **첫 카드로 못박지 않는다.** 다른 스펙이
   * 같은 데이터 디렉터리에 세이브를 만들면 그쪽이 위에 설 수 있다(최근 생성 순).
   */
  await expect(page.locator(".game-card", { hasText: "아스날" }).first()).toBeVisible({
    timeout: 20_000,
  });
});

test("면담 시나리오 — 판정형 스킬과 사기 반영", async ({ page }) => {
  await page.goto("/new");
  await expect(page.getByTestId("league-ring")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("league-epl").click();
  await expect(page.getByTestId("team-grid")).toBeVisible();
  await page.getByTestId("team-chelsea").click();
  await page.getByTestId("manager-name").fill("박테스트");
  await page.getByTestId("manager-background").fill("에이전트 출신 협상가");
  await page.getByTestId("start-game").click();
  await expect(page.getByTestId("chat-scroll")).toContainText("박테스트", { timeout: 30_000 });

  // 스쿼드에서 첫 선수 이름을 읽어와 면담 지시
  await page.getByTestId("tab-스쿼드").click();
  const firstName = await page
    .getByTestId("view-squad")
    .locator("tbody tr.row-tier")
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
  /**
   * 면담은 칩으로 남고, 바뀐 것(사기·심경)은 **스쿼드 말풍선**이 알린다.
   * 펼치지 않아도 잘 풀렸는지는 보여야 하므로 칩이 결(`good`/`bad`)을 갖는다.
   */
  const chip = page.getByTestId("tool-talk_to_player").first();
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await expect(chip).toHaveClass(/good|bad/);
  await expect(page.getByTestId("hint-스쿼드")).toBeVisible();

  /**
   * 휴대폰 폭 — **좌표는 지우지 않는다.**
   *
   * 구단·감독·지금은 화면이 바뀌어도 그대로여야 하는 값이라, 좁아지면 군말만
   * 줄이고(직함·연도) 아이콘 줄이 자기 줄을 받는다. 예전엔 감독 이름과 날짜를
   * 차례로 `display: none` 했고, 그러다 띠가 격자 칸보다 넓어져 **아이콘 줄의
   * 마지막 칸이 잘렸다** — 그 둘을 함께 지킨다.
   */
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByTestId("team-name")).toBeVisible();
  await expect(page.getByTestId("game-date")).toBeVisible();
  await expect(page.locator(".topbar-sub")).toContainText("박테스트");
  const fits = await page.evaluate(() => {
    const bar = document.querySelector(".topbar")!;
    const last = [...bar.querySelectorAll(".rail button")].at(-1)!;
    return {
      barClipped: bar.scrollWidth > bar.clientWidth + 1,
      // 마지막 칸이 띠 안에 온전히 들어와 있나 — 잘리면 오른쪽이 넘친다
      lastBtnRight: Math.round(last.getBoundingClientRect().right),
      barRight: Math.round(bar.getBoundingClientRect().right),
    };
  });
  expect(fits.barClipped).toBe(false);
  expect(fits.lastBtnRight).toBeLessThanOrEqual(fits.barRight);
});

/**
 * 협상은 **카드**다 — 진행 중인 흥정은 어느 장부에도 실리지 않아서 레일이 알릴
 * 수 없고, 금액 두 벌(제시·요구)과 확률은 칩 속에 접어 두면 매번 펼쳐야 한다.
 */
test("협상은 카드로 선다 — 재계약 제안", async ({ page }) => {
  await page.goto("/new");
  await expect(page.getByTestId("league-ring")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("league-epl").click();
  await expect(page.getByTestId("team-grid")).toBeVisible();
  await page.getByTestId("team-arsenal").click();
  await page.getByTestId("manager-name").fill("협테스트");
  await page.getByTestId("manager-background").fill("스카우트 출신");
  await page.getByTestId("start-game").click();
  await expect(page.getByTestId("chat-scroll")).toContainText("협테스트", { timeout: 30_000 });

  // 계약이 급한 선수에게 재계약 제안 — mock GM이 코어의 기대 주급으로 연다
  const input = page.getByTestId("chat-input");
  await input.fill("계약 만료 다가오는 선수 재계약 하자");
  await page.getByTestId("chat-send").click();

  const card = page.getByTestId("market-renewal").first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  // 카드가 조건과 기한을 갖는다 (칩을 펼쳐 읽던 것들)
  await expect(card).toContainText("주급");
  await expect(card).toContainText("기간");
  await expect(card).toContainText("답");
  // 같은 사실이 칩으로 또 서지 않는다 — 카드가 칩의 부연처럼 읽히면 안 된다
  await expect(page.getByTestId("tool-open_renewal")).toHaveCount(0);
  // 카드는 말풍선이 아니다 — 협상은 어느 장부에도 실리지 않는다
  await expect(page.locator(".rail-hints")).toHaveCount(0);
});

test("달력 상세와 전술판 라인업 편집", async ({ page }) => {
  await page.goto("/new");
  await expect(page.getByTestId("league-ring")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("league-epl").click();
  await expect(page.getByTestId("team-grid")).toBeVisible();
  await page.getByTestId("team-liverpool").click();
  await page.getByTestId("manager-name").fill("정테스트");
  await page.getByTestId("manager-background").fill("전술 분석가 출신");
  await page.getByTestId("start-game").click();
  await expect(page.getByTestId("chat-scroll")).toContainText("정테스트", { timeout: 30_000 });

  // 채팅에서 자연어 훈련 지시 → set_training 스킬
  const chat = page.getByTestId("chat-input");
  await chat.fill("월요일 오전은 세트피스 반복 훈련 잡아줘");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("hint-달력")).toBeVisible({ timeout: 15_000 });

  // 달력 — 경기 셀 클릭 → 상세 패널 (상대·라운드). 편집 UI 없음(읽기 전용)
  await page.getByTestId("tab-달력").click();
  await expect(page.getByTestId("view-calendar")).toContainText("시즌 일정");
  // 머리줄은 이적창 상태만 알린다 (조작 안내 문구 없음)
  await expect(page.getByTestId("view-calendar")).toContainText("이적시장");
  // 시즌 첫 경기는 프리시즌 친선이다 — 대회가 없으니 라운드도 없고 이름이 곧 정보다
  await page.locator('[data-testid^="cal-fixture-"]').first().click();
  await expect(page.getByTestId("cal-detail")).toBeVisible();
  await expect(page.getByTestId("cal-detail")).toContainText("친선");
  await expect(page.getByTestId("cal-detail")).toContainText("홈");

  // 경기 아닌 일정은 점으로만 오른다 — 훈련은 노란 점, 추첨·이적창은 파란 점.
  // 무슨 일정인지는 칸을 눌러 여는 상세가 말한다
  await expect(page.locator(".cal-mark.train").first()).toBeVisible();
  const drawDot = page.locator('[data-testid^="cal-draw-"]').first();
  await expect(drawDot).toBeVisible();
  await drawDot.click();
  await expect(page.getByTestId("cal-detail")).toContainText("추첨");

  // 전술판 — 편집 모드 없이 스쿼드 화면에서 바로 조작한다 (전술판 | 명단 2단)
  await openBoard(page);
  // 조작법 안내 문구는 없다 (잠긴 경기 중에만 이유를 밝힌다)
  await expect(page.getByTestId("board-hint")).toHaveCount(0);
  await expect(page.getByTestId("squad-table")).toBeVisible();
  await expect(page.locator(".pitch-slot")).toHaveCount(11);
  // 편집 진입 버튼도, 포메이션 셀렉트도 없다 (자리는 끌어서 바꾼다)
  await expect(page.getByTestId("edit-lineup")).toHaveCount(0);
  await expect(page.getByTestId("formation-select")).toHaveCount(0);
  // 포메이션 숫자는 실제 배치에서 읽힌다 — 시작 모양은 구단 카탈로그가 정한다
  // (리버풀은 4-2-3-1로 부임한다)
  await expect(page.getByTestId("shape")).toHaveText("4-2-3-1");

  /*
   * 채팅으로 모양을 말해도 **판은 그대로 서 있다** — 프리셋은 새 게임의 최초 배치를
   * 만드는 데만 쓰고, 세이브가 시작된 뒤 자리를 옮기는 것은 칩을 끄는 일이다
   * (docs/data/team.md §6). 그 지시에서 상태가 되는 것은 전술 6축뿐이다.
   */
  await page.getByTestId("tab-채팅").click();
  await page.getByTestId("chat-input").fill("4-4-2로 수비적으로 가자");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("hint-스쿼드")).toBeVisible({ timeout: 15_000 });
  // 그 화면을 열면 알림은 사라진다 — 읽었으면 할 일이 끝난 알림이다
  await openBoard(page);
  await expect(page.getByTestId("hint-스쿼드")).toHaveCount(0);
  await expect(page.locator(".pitch-slot")).toHaveCount(11);
  await expect(page.getByTestId("shape")).toHaveText("4-2-3-1");
  // 멘탈리티는 지시대로 내려섰다 (리버풀은 하이프레스라 4로 부임한다)
  await openTactics(page);
  await expect(page.getByTestId("tactic-mentality-2")).toHaveClass(/\bon\b/);
  // 펼친 눈금은 판 위에 얹히므로 다시 접는다 — 아래는 칩을 눌러 확인한다
  await page.getByTestId("tactics-toggle").click();
  await expect(page.getByTestId("tactics-panel")).not.toHaveClass(/\bopen\b/);

  // 칸은 **행의 왼쪽 선 색**이 말한다 — 배지 열은 없앴다
  await expect(page.getByTestId("bench-count")).toContainText("벤치");
  // 펼친 상세 행도 같은 칸 색을 쓴다(왼쪽 선이 이어지도록) — 선수 행만 센다
  await expect(page.locator(".squad-table tbody tr.row-tier.t-start:not(.detail-row)")).toHaveCount(
    11,
  );
  await expect(page.locator(".squad-table tbody tr.row-tier.t-bench").first()).toBeVisible();

  // 벤치/예비 지정은 행을 펼쳐 상세 카드에서 한다
  const benchTierRow = page.locator(".squad-table tbody tr.row-tier.t-bench").first();
  // 토글하면 그 행의 칸이 바뀌므로 **id로 붙잡아 둔다** — 클래스 로케이터를 다시
  // 평가하면 다른 행을 가리켜 상세가 엉뚱한 데서 열린다
  const benchRowTid = await benchTierRow.getAttribute("data-testid");
  await benchTierRow.click();
  const benchBtn = page.getByTestId(/^benchtoggle-/).first();
  await expect(benchBtn).toHaveText("벤치에서 빼기");
  await benchBtn.click();
  await expect(page.getByTestId("view-squad")).toHaveAttribute("data-save", "saved", {
    // 자동 저장 디바운스가 3초다 — 왕복까지 감안해 여유를 둔다
    timeout: 15_000,
  });
  await page.getByTestId(benchRowTid!).click(); // 상세를 닫는다

  // **명단 행 클릭은 상세 보기뿐** — 라인업이 바뀌면 안 된다
  // 비선발 중 **필드 플레이어**를 고른다 — 백업 GK를 뽑으면 아래 교체가 규칙에
  // 막혀(골키퍼는 필드 슬롯에 못 선다) 화면이 아니라 검증을 시험하게 된다
  const benchRow = page
    .locator(".squad-table tbody tr.row-tier.t-bench, .squad-table tbody tr.row-tier.t-squad")
    .filter({ hasNot: page.locator("td:nth-child(2):text-is('GK')") })
    .first();
  // 이름 칸엔 교체 화살표·표식·상태 배지가 함께 선다 — 이름은 자체 요소에서 읽는다
  const inName = ((await benchRow.locator(".row-name").textContent()) ?? "")
    .replace("Ⓒ", "")
    .trim();
  const beforeXI = await page.locator(".pitch-slot .slot-name").allTextContents();
  await benchRow.click();
  await expect(page.getByTestId("player-detail")).toBeVisible();
  expect(await page.locator(".pitch-slot .slot-name").allTextContents()).toEqual(beforeXI);

  /**
   * 포지션 칩의 세 상태는 **다른 채널**로 갈린다 — 선호는 금색, 소화 가능은 흐린 글자.
   * 색을 계산된 값으로 본다: 예전에 `globals.css` 뒤쪽에 같은 선택자가 한 벌 더
   * 있어 앞에서 무엇을 고쳐도 조용히 덮였다(화면은 그대로인데 코드만 바뀌었다).
   * 클래스 이름만 확인하면 그런 사고를 못 잡는다.
   */
  const colorOf = (sel: string) =>
    page
      .locator(`[data-testid="player-detail"] ${sel}`)
      .first()
      .evaluate((n) => getComputedStyle(n).color);
  // 글자색은 자리의 등급만 말한다 — 선호 금색 · 소화 가능 은색 · 못 보는 자리 회색
  expect(await colorOf(".pd-pos.natural")).toBe("rgb(194, 160, 94)"); // --gold-soft
  const playable = page.locator(
    '[data-testid="player-detail"] .pd-pos:not(.natural):not(.foreign)',
  );
  if ((await playable.count()) > 0) {
    expect(await playable.first().evaluate((n) => getComputedStyle(n).color)).toBe(
      "rgb(204, 214, 228)", // --silver
    );
  }
  /**
   * **지금 자리라고 글자색을 바꾸지 않는다.** 밑줄만 얹는다 — 색까지 바꾸면
   * 그 자리가 선호인지 무리한 배치인지가 화면에서 사라진다.
   */
  // 벤치 선수는 맡은 자리가 없어 `.here`가 아예 없다 — 있을 때만 본다
  const here = page.locator('[data-testid="player-detail"] .pd-pos.here');
  if ((await here.count()) > 0) {
    const state = await here.first().evaluate((n) => ({
      color: getComputedStyle(n).color,
      shadow: getComputedStyle(n).boxShadow,
      natural: n.classList.contains("natural"),
      foreign: n.classList.contains("foreign"),
    }));
    expect(state.color).toBe(
      state.natural
        ? "rgb(194, 160, 94)" // --gold-soft
        : state.foreign
          ? "rgb(95, 104, 117)" // --dim
          : "rgb(204, 214, 228)", // --silver
    );
    expect(state.shadow).toContain("96, 165, 250"); // 밑줄만이 "여기"를 말한다
  }
  // 포지션은 테두리 없는 글자다 — 읽는 값이지 누르는 물건이 아니다
  const borders = await page
    .locator('[data-testid="player-detail"] .pd-pos')
    .evaluateAll((ns) => ns.map((n) => getComputedStyle(n).borderTopWidth));
  expect(new Set(borders)).toEqual(new Set(["0px"])); // 포지션은 **하나도** 테두리가 없다
  /**
   * **자리가 없으면 역할도 없다** (player.md §3.1). 이 상세는 비선발이라 알약이
   * 아예 서지 않는다 — 주 포지션을 자리로 치고 목록을 켜 두면 감독은 코어가 받지
   * 않는 값을 고르게 되고, 그 선택이 저장마다 따라가 라인업이 통째로 반려된다.
   */
  await expect(page.locator('[data-testid="player-detail"] .pd-role')).toHaveCount(0);
  // 비선발을 고르면 **선발 행**에 화살표가 뜬다 (어느 쪽을 먼저 골라도 교체가 열린다)
  // 선발 11명은 내려가는 → , 예비·2군은 올라오는 ← (칸이 다르면 전부 열린다)
  await expect(page.locator('.swap-btn:text("→")')).toHaveCount(11);
  await expect(page.locator('.swap-btn:text("←")').first()).toBeVisible();
  // 선택을 풀면 화살표도 사라진다
  await benchRow.click();
  await expect(page.locator(".swap-btn")).toHaveCount(0);

  // 예비 ↔ 벤치처럼 선발이 끼지 않는 조합도 열린다 (칸이 다르면 전부)
  const yebiRow = page.locator(".squad-table tbody tr.row-tier.t-squad").first();
  if ((await yebiRow.count()) > 0) {
    await yebiRow.click();
    const benchArrow = page
      .locator(".squad-table tbody tr.row-tier.t-bench")
      .filter({ has: page.locator(".swap-btn") })
      .first();
    await expect(benchArrow).toHaveCount(1);
    await benchArrow.getByTestId(/^swapin-/).click();
    await expect(page.getByTestId("view-squad")).toHaveAttribute("data-save", "saved", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("lineup-error")).toHaveCount(0);
  }

  // 선발을 고르면 반대로 비선발 행에 화살표가 뜬다
  await page.getByTestId("slot-10").click();
  await expect(page.locator('.swap-btn:text("←")').first()).toBeVisible();
  await expect(page.locator('.swap-btn:text("→")')).toHaveCount(0);
  const outName = (await page.getByTestId("slot-10").locator(".slot-name").textContent()) ?? "";
  await page
    .locator(".squad-table tbody tr.row-tier")
    .filter({ has: page.locator(".row-name", { hasText: inName }) })
    .getByTestId(/^swapin-/)
    .click();
  await expect(
    page.locator(".pitch-slot").filter({ hasText: inName.split(" ").pop() ?? "" }),
  ).toHaveCount(1);
  // 밀려난 선수는 전술판에서 빠진다 (중복 배치 없음)
  await expect(page.locator(".pitch-slot", { hasText: outName })).toHaveCount(0);
  // 방금 올라온 선수의 OVR이 칩과 명단에서 같은 숫자인가 — 여기가 가장 크게 갈렸다
  await expectOvrConsistent(page);

  // **칩을 눌러도 자리는 바뀌지 않는다** — 고르기만 한다 (자리 교환은 드래그뿐)
  const before5 = (await page.getByTestId("slot-5").locator(".slot-name").textContent()) ?? "";
  const before0 = (await page.getByTestId("slot-0").locator(".slot-name").textContent()) ?? "";
  await page.getByTestId("slot-0").click();
  await page.getByTestId("slot-5").click();
  await expect(page.getByTestId("slot-0")).toContainText(before0.replace("Ⓒ", ""));
  await expect(page.getByTestId("slot-5")).toContainText(before5.replace("Ⓒ", ""));

  // 명단에서 선수를 누르면 그 행 아래에 상세가 펼쳐지고, 다시 누르면 접힌다
  const firstRow = page.locator(".squad-table tbody tr.row-tier.t-start:not(.detail-row)").first();
  await firstRow.click();
  await expect(page.locator(".detail-row")).toHaveCount(1);
  // 적응은 자리·전술을 합친 한 칸이다 (숫자가 아니라 게이지 — 값은 툴팁이 갖는다)
  await expect(page.locator(".detail-row")).toContainText("적응");
  await expect(page.locator(".detail-row .fit-gauge").first()).toBeVisible();
  /**
   * 선발은 자리가 있으니 역할이 있다 — 역할만 **누르는 물건**의 생김새를 갖는다.
   * (커서로는 못 잰다: 상세가 행 안에 있어 행의 `pointer`를 물려받는다)
   */
  const rolePill = page.locator('[data-testid="player-detail"] .pd-role').first();
  await expect(rolePill).toBeVisible();
  expect(await rolePill.evaluate((n) => getComputedStyle(n).borderTopWidth)).not.toBe("0px");
  // 펼치면 15축이 전부 보이고, 체력이 왜 그런지 한 문장으로 설명한다
  await expect(page.getByTestId("player-mood")).not.toBeEmpty();
  await expect(page.locator(".detail-row .pd-axis")).toHaveCount(15);
  // 명단은 사기·피로 두 열이 아니라 체력 한 열이다
  await expect(page.locator(".squad-table thead")).toContainText("체력");
  await expect(page.locator(".squad-table thead")).not.toContainText("사기");
  await expect(page.locator(".squad-table thead")).not.toContainText("피로");
  await firstRow.click();
  await expect(page.locator(".detail-row")).toHaveCount(0);

  /**
   * 정렬 — **첫 칸(선수)이 기본으로 돌아오는 자리다.**
   *
   * 다른 기준으로 흩어 놓으면 칸 순으로 되돌릴 손잡이가 없었다. 적응 칸도
   * 누를 수 있어야 한다(예전엔 정렬 대상이 아니었다).
   */
  const heads = page.locator(".squad-table thead th");
  const firstName = async () =>
    (
      (await page
        .locator(".squad-table tbody tr.row-tier:not(.detail-row) .row-name")
        .first()
        .textContent()) ?? ""
    ).replace("Ⓒ", "");
  const byTier = await firstName();
  // 칸 경계선은 칸 순일 때만 선다
  expect(await page.locator(".squad-table tbody tr.tier-head").count()).toBeGreaterThan(0);
  await heads.filter({ hasText: "적응" }).click();
  await expect(heads.filter({ hasText: "적응" })).toHaveClass(/sorted/);
  await expect(page.locator(".squad-table tbody tr.tier-head")).toHaveCount(0);
  // 적응도 내림차순 — 첫 행의 게이지가 마지막 행보다 크다
  const fitAt = async (nth: number) => {
    const label = await page
      .locator(".squad-table tbody tr.row-tier:not(.detail-row)")
      .nth(nth)
      .locator(".fit-gauge")
      .getAttribute("aria-label");
    return Number(/(\d+)/.exec(label ?? "")?.[1] ?? "0");
  };
  expect(await fitAt(0)).toBeGreaterThanOrEqual(await fitAt(5));
  // 선수 칸을 누르면 칸 순으로 돌아온다
  await heads.filter({ hasText: "선수" }).click();
  expect(await firstName()).toBe(byTier);
  expect(await page.locator(".squad-table tbody tr.tier-head").count()).toBeGreaterThan(0);

  // 전술판 칩을 눌러도 같은 자리(명단)에서 상세가 열린다
  await page.getByTestId("slot-0").click();
  await expect(page.locator(".detail-row")).toHaveCount(1);

  /*
   * 전술도 같은 화면에서 바꾼다 — 값의 뜻이 말로 보인다.
   * 접힌 패널은 지금 값만 적고, 눈금은 **고치려고 펼쳤을 때** 나온다.
   *
   * **적응도는 선수마다 다르다** — 팀 총합 같은 값은 화면에 없으므로 한 명을
   * 골라 따라간다. 명단 첫 행이 아니라 **전술판 첫 칩**에서 이름을 읽는 이유는
   * 명단 정렬이 지금 칸을 따라 실시간으로 바뀌기 때문이다 — 앞선 교체로 첫 행이
   * 방금 올라온 선수가 되면 자리 성분까지 함께 움직여 무엇을 재는지 흐려진다.
   */
  const tracked = ((await page.getByTestId("slot-0").locator(".slot-name").innerText()) ?? "")
    .replace("Ⓒ", "")
    .trim();
  const famOf = async () => {
    const label = await page
      .locator(".squad-table tbody tr.row-tier:not(.detail-row)", { hasText: tracked })
      .first()
      .locator(".fit-gauge")
      .getAttribute("aria-label");
    return Number(/(\d+)/.exec(label ?? "")?.[1]);
  };
  const famBefore = await famOf();
  expect(famBefore, "적응도를 읽지 못했다").not.toBeNaN();
  // 접혀 있을 땐 여섯 축의 지금 값만 — 눈금은 아직 없다
  await expect(page.getByTestId("tactic-mentality-5")).toHaveCount(0);
  await openTactics(page);
  await page.getByTestId("tactic-mentality-5").click();
  await expect(page.getByTestId("tactics-panel")).toContainText("매우 공격적");
  await expect(page.getByTestId("view-squad")).toHaveAttribute("data-save", "saved", {
    // 자동 저장 디바운스가 3초다 — 왕복까지 감안해 여유를 둔다
    timeout: 15_000,
  });
  // 하한 아래로는 절대 안 내려간다 (증감 폭은 유닛 테스트가 고정한다)
  const famShifted = await famOf();
  expect(famShifted).toBeGreaterThan(0);
  /*
   * 되돌리면 다시 오른다 — **누적 차감이 아니다.**
   *
   * 정확한 복원은 유닛 테스트가 고정한다 (skills.test.ts "왔다 갔다 해도 적응도를
   * 불릴 수 없다" — 전술 적응도는 소수까지 제자리로 온다). 여기서 같은 값을
   * 요구하지 않는 이유는 화면 값이 **자리 성분이 섞인 합친 적응도**이고, 이 시점의
   * 첫 행은 앞서 교체로 방금 선발이 된 선수라 자리 성분이 함께 움직이기 때문이다.
   */
  await page.getByTestId("tactic-mentality-3").click();
  await expect(page.getByTestId("view-squad")).toHaveAttribute("data-save", "saved", {
    // 자동 저장 디바운스가 3초다 — 왕복까지 감안해 여유를 둔다
    timeout: 15_000,
  });
  expect(await famOf(), "되돌렸는데 손해가 남았다").toBeGreaterThanOrEqual(famShifted);

  await page.getByTestId("tactic-passStyle-5").click();
  await expect(page.getByTestId("tactics-panel")).toContainText("매우 길게");

  // 자동 저장이 끝나면 서버 값이 그대로 반영되어 있다 — 탭을 떠났다 와도 남는다
  await expect(page.getByTestId("view-squad")).toHaveAttribute("data-save", "saved", {
    // 자동 저장 디바운스가 3초다 — 왕복까지 감안해 여유를 둔다
    timeout: 15_000,
  });
  await page.getByTestId("tab-달력").click();
  await page.getByTestId("tab-스쿼드").click();
  await expect(page.getByTestId("tactics-panel")).toContainText("매우 길게");
  // 위에서 멘탈리티를 3으로 되돌렸으므로 그 값이 저장돼 있어야 한다
  await expect(page.getByTestId("tactics-panel")).toContainText("균형");

  // 전술판 저장은 채팅에 전송되지 않는다 (사용자 요청) — 채팅엔 훈련 지시 턴만
  await page.getByTestId("tab-채팅").click();
  await expect(page.getByTestId("chat-scroll")).not.toContainText("전술 보드를 정리");
});

test("전술판 자유 배치 — 드래그로 한 자리만 세밀하게 조정한다", async ({ page }) => {
  await page.goto("/new");
  await expect(page.getByTestId("league-ring")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("league-epl").click();
  await expect(page.getByTestId("team-grid")).toBeVisible();
  await page.getByTestId("team-mancity").click();
  await page.getByTestId("manager-name").fill("배치테스트");
  await page.getByTestId("manager-background").fill("포지션 실험을 즐기는 전술가");
  await page.getByTestId("start-game").click();
  await expect(page.getByTestId("chat-scroll")).toContainText("배치테스트", { timeout: 30_000 });

  await openBoard(page);
  const board = page.getByTestId("pitch-board");
  // 전술판이 기본 뷰포트보다 길다 — 마우스 좌표는 뷰포트 기준이라 전체를 화면에 올린다
  await page.setViewportSize({ width: 1440, height: 1100 });
  await board.scrollIntoViewIfNeeded();

  // 아무 칩도 없는 빈 자리를 찾는다 — 다른 칩 위에 놓으면 "자리 교환"이 되므로
  // 순수한 재배치를 검증하려면 확실히 빈 곳이어야 한다.
  // ⚠️ **라인을 넘는 곳이어야 한다** — 포메이션 숫자는 라인별 인원에서 파생되므로,
  // 같은 라인 안에서 옮기면 코드만 바뀌고(ST→LF) 숫자는 그대로다. 옮길 칩이
  // 어느 라인에 서 있는지는 배치 순서에 따라 매번 다르다.
  // 옮길 칩은 **9번이 아닌 아무 자리** — 이 테스트는 뒤에서 다시 ST를 찾아 CF로
  // 내리므로, 첫 재배치로 ST를 라인 밖으로 빼면 그 검증이 설 자리가 없어진다.
  // (배치 순서는 구단·시드마다 달라 `slot-1`이 9번일 수도 있다)
  const movingId = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".pitch-slot")].find(
      (e) => e.querySelector(".slot-code")?.textContent !== "ST",
    );
    return el?.getAttribute("data-testid") ?? "";
  });
  expect(movingId).not.toBe("");

  const target = await page.evaluate((id: string) => {
    const boardEl = document.querySelector('[data-testid="pitch-board"]')!;
    const b = boardEl.getBoundingClientRect();
    const rectOf = (el: Element) => el.getBoundingClientRect();
    const centreY = (r: DOMRect) => ((r.top + r.height / 2 - b.top) / b.height) * 100;
    const moving = centreY(rectOf(document.querySelector(`[data-testid="${id}"]`)!));
    const chips = [...document.querySelectorAll(".pitch-slot")].map((el) => {
      const r = rectOf(el);
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    });
    let best = { x: 0, y: 0, dist: -1 };
    for (let px = 15; px <= 85; px += 5) {
      for (let py = 15; py <= 85; py += 5) {
        if (Math.abs(py - moving) < 30) continue; // 같은 라인 안의 이동은 숫자를 안 바꾼다
        const x = b.left + (b.width * px) / 100;
        const y = b.top + (b.height * py) / 100;
        const dist = Math.min(...chips.map((c) => Math.hypot(c.cx - x, c.cy - y)));
        if (dist > best.dist) best = { x, y, dist };
      }
    }
    return best;
  }, movingId);

  const slot1 = page.getByTestId(movingId);
  const beforeShape = await page.getByTestId("shape").textContent();
  const beforeCode = await slot1.locator(".slot-code").textContent();
  const beforeName = await slot1.locator(".slot-name").textContent();
  const chip = (await slot1.boundingBox())!;
  await page.mouse.move(chip.x + chip.width / 2, chip.y + chip.height / 2);
  await page.mouse.down();
  // 중간 지점을 거쳐야 드래그 임계값을 넘고 미리보기가 따라온다
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await expect(page.locator(".pitch-chip.dragging")).toHaveCount(1);
  await page.mouse.up();

  await expect(page.locator(".pitch-chip.dragging")).toHaveCount(0);
  // 좌표가 옮겨졌으니 그 자리의 포지션 코드도 달라진다 (좌표가 포지션의 원본)
  await expect(slot1.locator(".slot-code")).not.toHaveText(beforeCode ?? "");
  // 교환이 아니라 이동이므로 그 자리의 선수는 그대로다
  await expect(slot1.locator(".slot-name")).toHaveText(beforeName ?? "");

  // 다른 선수·다른 슬롯은 그대로 — 재배치는 그 한 자리만 건드린다
  await expect(page.locator(".pitch-slot")).toHaveCount(11);
  // 포메이션 숫자가 실제 배치에서 다시 읽혀 달라졌다 (자동 감지)
  await expect(page.getByTestId("shape")).not.toHaveText(beforeShape ?? "");

  // 카드가 서로를 가리지 않는다 (겹침 해소 — CB·CM이 완전히 겹치던 문제)
  const overlapping = await page.evaluate(() => {
    const rects = [...document.querySelectorAll(".pitch-slot")].map((el) =>
      el.getBoundingClientRect(),
    );
    return rects.some((a, i) =>
      rects.some(
        (b, j) =>
          j > i &&
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0,
      ),
    );
  });
  expect(overlapping).toBe(false);

  // 자동 저장 — 손을 뗀 뒤 잠시 지나면 서버에 반영된다 (저장 버튼이 없다)
  await expect(page.getByTestId("save-lineup")).toHaveCount(0);
  await expect(page.getByTestId("view-squad")).toHaveAttribute("data-save", "saved", {
    // 자동 저장 디바운스가 3초다 — 왕복까지 감안해 여유를 둔다
    timeout: 15_000,
  });

  // 9번을 조금 끌어내리면 CF가 된다 (요구 역량이 다른 자리 — 정통 9번이 아닌 전방)
  const st = page
    .locator(".pitch-slot")
    .filter({ has: page.locator(".slot-code", { hasText: /^ST$/ }) });
  await expect(st).toHaveCount(1);
  // 앞선 재배치로 이미 CF가 생겼을 수 있다 — 개수가 아니라 **이 선수**가 CF가
  // 됐는지를 본다 (시작 포메이션이 구단마다 달라 빈 자리 위치도 달라진다)
  const stName = (await st.locator(".slot-name").textContent()) ?? "";
  const stBox = (await st.boundingBox())!;
  const boardBox = (await board.boundingBox())!;
  await page.mouse.move(stBox.x + stBox.width / 2, stBox.y + stBox.height / 2);
  await page.mouse.down();
  // 프리셋 9번(y=7%)에서 CF 구간(12~25%) 안으로 — 보드 높이의 10%만 내려도 닿는다
  await page.mouse.move(boardBox.x + boardBox.width * 0.5, boardBox.y + boardBox.height * 0.17, {
    steps: 10,
  });
  await page.mouse.up();
  await expect(
    page
      .locator(".pitch-slot")
      .filter({ has: page.locator(".slot-name", { hasText: stName }) })
      .locator(".slot-code"),
  ).toHaveText("CF");
  await expect(st).toHaveCount(0);
  // 명단의 포지션 열은 지금 맡은 자리를 그대로 보여준다 (저장 반영 후 CF)
  await expect(page.getByTestId("view-squad")).toHaveAttribute("data-save", "saved", {
    // 자동 저장 디바운스가 3초다 — 왕복까지 감안해 여유를 둔다
    timeout: 15_000,
  });
  await expect(page.locator(".squad-table tbody")).toContainText("CF");

  // 감지된 숫자는 언제나 필드 10명을 나눈 합이다
  const shapeSum = (await page.getByTestId("shape").textContent())!
    .split("-")
    .reduce((sum, n) => sum + Number(n), 0);
  expect(shapeSum).toBe(10);
  await expect(page.getByTestId("view-squad")).toHaveAttribute("data-save", "saved", {
    // 자동 저장 디바운스가 3초다 — 왕복까지 감안해 여유를 둔다
    timeout: 15_000,
  });

  // 탭을 떠났다 돌아와도 옮긴 자리가 그대로다 (서버가 좌표를 기록했다)
  const movedName = (beforeName ?? "").replace("Ⓒ", "").trim();
  const movedCode = await slot1.locator(".slot-code").textContent();
  await page.getByTestId("tab-달력").click();
  await page.getByTestId("tab-스쿼드").click();
  await expect(page.locator(".pitch-slot")).toHaveCount(11);
  const persisted = page.locator(".pitch-slot", { hasText: movedName });
  await expect(persisted).toHaveCount(1);
  await expect(persisted.locator(".slot-code")).toHaveText(movedCode ?? "");

  await expectOvrConsistent(page);
});

/**
 * 전술을 바꾸고 **곧바로** 말을 걸면 — 저장이 턴보다 먼저 간다.
 *
 * 자동 저장은 조작이 멎기를 기다리므로, 예전에는 그 창(3초) 안에 보낸 턴이 옛 전술로
 * 나갔다. 화면에는 바꾼 판이 그대로 보이는데 수석코치만 다른 전술을 말했다.
 * 판을 **접기만 하고 떠나지 않는 것**이 이 시험의 핵심이다 — 탭을 옮기면 언마운트가
 * 저장을 흘려보내 경합이 가려진다.
 */
test("전술판 편집은 턴보다 먼저 서버에 닿는다", async ({ page }) => {
  await page.goto("/new");
  await expect(page.getByTestId("league-ring")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("league-epl").click();
  await expect(page.getByTestId("team-grid")).toBeVisible();
  await page.getByTestId("team-arsenal").click();
  await page.getByTestId("manager-name").fill("순서정");
  await page.getByTestId("manager-background").fill("전술 분석가 출신");
  await page.getByTestId("start-game").click();
  await expect(page.getByTestId("chat-scroll")).toContainText("순서정", { timeout: 30_000 });

  await openBoard(page);
  await openTactics(page);

  // 나간 요청과 돌아온 응답을 순서대로 적는다
  const wire: string[] = [];
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    const path = new URL(req.url()).pathname;
    if (path.endsWith("/lineup")) wire.push("저장→");
    else if (path.endsWith("/turn/stream")) wire.push("턴→");
  });
  page.on("response", (res) => {
    if (new URL(res.url()).pathname.endsWith("/lineup")) wire.push("←저장");
  });

  await page.getByTestId("tactic-mentality-5").click();
  await expect(page.getByTestId("tactics-panel")).toContainText("매우 공격적");
  // 판만 접는다 — 명단은 채팅 옆에 그대로 서 있다 (저장은 아직 예약 상태)
  await page.getByTestId("board-toggle").click();
  await page.getByTestId("chat-input").fill("이 전술로 가자");
  await page.getByTestId("chat-send").click();

  // 저장이 끝난 뒤에야 턴이 나간다 — 그래야 세계가 지금 판으로 답한다
  await expect
    .poll(() => wire.filter((w) => w === "턴→").length, { timeout: 20_000 })
    .toBeGreaterThan(0);
  expect(wire.slice(0, 3)).toEqual(["저장→", "←저장", "턴→"]);
  await expect(page.getByTestId("view-squad")).toHaveAttribute("data-save", "saved", {
    timeout: 15_000,
  });

  // 턴이 끝나도 바꾼 전술 그대로다 — 늦게 도착한 저장 응답이 턴 결과를 되감지 않는다
  await expect(page.getByTestId("chat-scroll")).toContainText("이 전술로 가자");
  await page.getByTestId("tab-달력").click();
  await openBoard(page);
  await expect(page.getByTestId("tactics-panel")).toContainText("매우 공격적");
});
