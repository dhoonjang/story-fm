import { beforeAll, describe, expect, it } from "vitest";
import {
  advanceTime,
  createGame,
  dealOdds,
  interpretBackgroundHeuristic,
  openNegotiationFor,
  pendingOffer,
  suggestTerms,
  tacticsOf,
  userPlayers,
  type GameState,
} from "@story-fm/engine";
import { TIME_PASSED, buildOnboardingTurn, runGmTurn } from "@story-fm/agents";

/**
 * **mock 모드가 실 경로를 지나는가** (docs/llm/agents.md §8).
 *
 * 재는 것은 대본의 문장이 아니라 **기록**이다: 표의 한 줄이 `gm-tools.ts`의 핸들러를
 * 지나 코어 명령의 이름으로 `recordCall`을 남기면, 화면의 칩·말풍선이 실모드와 같은
 * 것을 받는다. 그 이름이 갈리면 e2e가 실모드에 없는 동작을 통과시킨다 (#397).
 *
 * 대본이 감독의 말을 알아듣는지는 재지 않는다 — 표의 키와 글자까지 같을 때만 걸리는
 * 것이 계약이고, 그 계약 자체가 이 파일의 전제다.
 */
process.env.LLM_MODE = "mock";

/** 답이 수락으로 갈리는 확률 문턱 — `e2e/seed.ts`가 고르는 자와 같은 값이다 */
const ACCEPT_ODDS_FLOOR = 70;

function build(seed: number): GameState {
  const background = "프리미어리그에서 뛰었던 주장 출신 수비수";
  return createGame({
    seed,
    userTeamId: "arsenal",
    managerName: "김감독",
    background,
    attributes: interpretBackgroundHeuristic(background),
  });
}

/**
 * 시드 42의 세계를 **한 번만** 세우고 케이스마다 복제한다 — `createGame`은 판당
 * 수 초, 복제는 그 수십 분의 일이다.
 */
let BASE: GameState;
beforeAll(() => {
  BASE = build(42);
});
const newGame = (): GameState => structuredClone(BASE);

/**
 * 모델 턴 문법 — **첫 줄은 장면의 시점**이고 나머지 텍스트 줄은 `@`로 시작한다
 * (overview §2.1). 시점 줄이 시계를 움직이므로 문법의 일부다.
 */
function expectGmGrammar(text: string) {
  const lines = text.split("\n");
  const first = lines.find((line) => line.trim().length > 0)?.trim() ?? "";
  expect(/^\[[^\]]+\]$/u.test(first), `첫 줄이 시점이 아니다: "${first}"`).toBe(true);
  for (const line of lines.slice(lines.indexOf(first) + 1)) {
    if (line.trim().length === 0) continue;
    expect(line.startsWith("@"), `문법 위반 줄: "${line}"`).toBe(true);
  }
}

const namesOf = (turn: { toolCalls: ReadonlyArray<{ name: string }> }): string[] =>
  turn.toolCalls.map((call) => call.name);

describe("mock 대본 — 부임 첫 장면", () => {
  it("@문법으로 배경·스쿼드·다음 일정을 브리핑한다", () => {
    const turn = buildOnboardingTurn(newGame());
    expectGmGrammar(turn.text);
    expect(turn.text).toContain("김감독");
  });

  /**
   * 첫 장면은 **상태만 읽는다** — 같은 세이브를 두 번 열면 같은 장면이고, 세계가
   * 다르면 장면도 갈린다. 방향이 결정적이라 시드 둘이면 잡힌다.
   */
  it("같은 세이브에서 재현되고 다른 세계에선 장면이 달라진다", () => {
    const state = newGame();
    expect(buildOnboardingTurn(state).text).toBe(buildOnboardingTurn(state).text);
    // 첫 줄은 시점(모든 세이브가 7월 1일)이므로 장면이 갈리는 건 그다음 줄이다
    const opening = (seed: number) => buildOnboardingTurn(build(seed)).text.split("\n")[1];
    expect(opening(1)).not.toBe(opening(2));
  });
});

describe("mock 대본 — 표의 한 줄이 코어 명령까지 닿는다", () => {
  it("훈련 지시가 해석기를 지나 set_training으로 남는다", async () => {
    const state = newGame();
    const turn = await runGmTurn(state, "월요일 오전은 세트피스 반복 훈련 잡아줘");
    expectGmGrammar(turn.text);
    const call = turn.toolCalls.find((c) => c.name === "set_training");
    expect(call, "set_training 기록이 없다").toBeDefined();
    /**
     * 기록은 **실모드의 것과 같아야 한다** — 항목 요약(`brief`)을 안 실으면 말풍선이
     * 조용히 옛 문자열로 폴백해, 요약을 고쳐도 mock으로 플레이하는 동안에는 아무것도
     * 달라지지 않는다.
     */
    expect(call?.brief?.items.length).toBeGreaterThan(0);
    // 월요일 오전 훈련이 일정 엔트리로 등록됐다 (v6 — 규칙 테이블 없음).
    // 기본 훈련(training-plan)과 섞이므로 감독이 지시한 세션만 본다
    const ordered = new Set(
      state.trainingSessions
        .filter((s) => s.label.includes("세트피스") && !s.auto)
        .map((s) => s.id),
    );
    const entries = state.schedule.filter((e) => e.type === "training" && ordered.has(e.refId));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(new Date(`${e.date}T00:00:00Z`).getUTCDay()).toBe(1); // 월요일
      expect(e.time).toBe("10:00"); // 오전
    }
  });

  it("포메이션 이름은 프리셋을 적용하지 않고 전술 축만 반영한다", async () => {
    const state = newGame();
    const before = tacticsOf(state, state.userTeamId).spec.formation;
    const turn = await runGmTurn(state, "4-4-2로 바꾸고 공격적으로 가자");
    expect(namesOf(turn)).toContain("set_tactics");
    expect(tacticsOf(state, state.userTeamId).spec.formation).toBe(before);
    expect(tacticsOf(state, state.userTeamId).spec.mentality).toBe(4);
  });

  it("이름 자리를 둔 줄은 감독이 부른 이름을 받아 team_talk로 간다", async () => {
    const state = newGame();
    const player = userPlayers(state)[3];
    if (!player) throw new Error("no player");
    const before = player.state.form;
    // 성(姓)으로 부른다 — 이름이 한 글자인 선수가 있어 긴 조각이 안전하다
    const called = player.name.split(" ").reduce((a, b) => (b.length > a.length ? b : a));
    const turn = await runGmTurn(state, `${called} 면담 좀 하자`);
    expect(namesOf(turn)).toContain("team_talk");
    expect(player.state.form).toBeGreaterThan(before);
  });

  it("표에 없는 말은 아무 도구도 부르지 않고 장면만 낸다", async () => {
    const state = newGame();
    const turn = await runGmTurn(state, "음...");
    expectGmGrammar(turn.text);
    expect(turn.toolCalls).toHaveLength(0);
  });

  /**
   * 시계는 **시점 헤더가** 민다 — 실모드와 같은 입구다. 시계 이동은 감독이 부른 도구가
   * 아니라 코어의 처리 결과라 사람이 읽는 이름으로 남는다.
   */
  it("넘기는 말은 시점 헤더로 시계를 밀고 코어의 기록을 남긴다", async () => {
    const state = newGame();
    const from = state.date;
    const turn = await runGmTurn(state, "하루 넘기자");
    expectGmGrammar(turn.text);
    expect(namesOf(turn)).toContain(TIME_PASSED);
    expect(state.date).not.toBe(from);
  });
});

describe("mock 대본 — 경기", () => {
  /**
   * 킥오프는 세 걸음이다 — 도구가 문을 열고(`start_match`), 감독이 들어서고(첫 휘슬),
   * 그다음 손잡이가 구간을 굴린다. 경기일까지는 코어로 걷는다: 브라우저도 감독도
   * 없는 자리에서 턴을 서른 번 도는 것은 이 케이스가 재려는 것이 아니다.
   */
  it("손잡이로 킥오프에서 종료까지 완주하고 중계가 선다", async () => {
    const state = build(7);
    for (let guard = 0; guard < 40 && state.phase !== "matchday"; guard += 1) {
      advanceTime(state, "next_match");
    }
    expect(state.phase).toBe("matchday");

    const opened = await runGmTurn(state, "경기 시작하자");
    expect(namesOf(opened)).toContain("start_match");
    expect(state.pendingMatch?.entered).not.toBe(true);

    // 입장 턴은 첫 휘슬만 — 사건은 아직 없다
    const entered = await runGmTurn(state, "진행", undefined, { kind: "advance_match" });
    expect(entered.text).toContain("@중계:");
    expect(state.pendingMatch?.entered).toBe(true);
    expect(entered.goals ?? []).toHaveLength(0);

    let broadcasts = 0;
    for (let guard = 0; guard < 80 && state.phase === "match"; guard += 1) {
      const turn = await runGmTurn(state, "진행", undefined, { kind: "advance_match" });
      if (turn.text.includes("@중계:")) broadcasts += 1;
    }
    expect(state.phase).toBe("idle");
    expect(broadcasts).toBeGreaterThan(0);
    // 마감이 장부에 섰다 — 첫 라운드의 우리 경기에 결과가 있다
    const played = state.matches.find(
      (m) => m.result !== null && (m.homeTeamId === "arsenal" || m.awayTeamId === "arsenal"),
    );
    expect(played).toBeDefined();
  });
});

describe("mock 대본 — 이적", () => {
  /**
   * 대본이 오퍼를 넣고, **상대의 답은 코어 앵커가 낸다** — mock은 교섭 상대를 부르지
   * 않으므로 `answerLetters`가 서류대로 마감한다 (agents.md §4-1의 mock).
   *
   * 성사 확률이 문턱을 넘는 상대를 **코어에게 물어서** 고른다 — 아무나 지목하면 답이
   * 수락일지 조정일지가 카탈로그에 달리고, 그러면 케이스가 `if (수락이면)`을 쓴다.
   */
  it("오퍼 → 도착한 답(respond_offer) → 확정(accept_deal)", async () => {
    const state = newGame();
    const target = state.players.find((p) => {
      if (p.teamId === state.userTeamId) return false;
      const terms = suggestTerms(state, p.id);
      if (!terms) return false;
      if (state.players.filter((q) => q.name === p.name).length > 1) return false;
      return dealOdds(state, terms).probability >= ACCEPT_ODDS_FLOOR;
    });
    if (!target) throw new Error("성사 확률이 문턱을 넘는 영입 상대가 없다");

    const sent = await runGmTurn(state, `${target.name} 영입하자`);
    expect(namesOf(sent)).toContain("send_offer");
    const negotiation = openNegotiationFor(state, target.id);
    expect(negotiation).toBeDefined();

    // 답할 날이 되면 턴이 열리기 전에 상대가 답한다 — 그 기록이 `respond_offer`다
    state.date = pendingOffer(negotiation!)!.respondsOn!;
    const answered = await runGmTurn(state, "이적 건 마무리하자");
    expect(namesOf(answered)).toContain("respond_offer");
    expect(pendingOffer(negotiation!)).toBeNull();
    expect(namesOf(answered)).toContain("accept_deal");
  });
});
