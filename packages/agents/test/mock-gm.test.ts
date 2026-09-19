import { beforeAll, describe, expect, it } from "vitest";
import {
  advanceTime,
  createGame,
  dealOdds,
  interpretBackgroundHeuristic,
  openNegotiationFor,
  pendingOffer,
  suggestTerms,
  tableOf,
  tacticsOf,
  userPlayers,
  type GameState,
} from "@story-fm/engine";
import {
  SUGGESTION_MAX_CHARS,
  TABLE_LEFT,
  TIME_PASSED,
  buildOnboardingTurn,
  runGmTurn,
  takeSuggestion,
} from "@story-fm/agents";
import { turnFactLines } from "@story-fm/engine";

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

  /**
   * 감독의 다음 말은 **턴 결과에만** 실린다 (agents.md §2) — 본문에 남으면 화면에 태그가
   * 서고 다음 턴 이력이 그 문장을 감독의 말처럼 읽는다. 기록에도 없어야 압축 브리프의
   * `[장부]` 줄이 그것을 싣지 않는다.
   */
  it("매 턴 감독의 다음 말 하나가 제안으로 실리고, 본문과 기록에는 남지 않는다", async () => {
    const state = newGame();
    const turn = await runGmTurn(state, "음...");
    expect(turn.suggestion).toBe("하루 넘기자");
    expect(turn.text).not.toContain("suggest_reply");
    expect(turn.toolCalls).toHaveLength(0);
    expect(turnFactLines({ toolCalls: turn.toolCalls })).toEqual([]);
    // 경기일에는 킥오프를 여는 말이다
    for (let guard = 0; guard < 40 && state.phase !== "matchday"; guard += 1) {
      advanceTime(state, "next_match");
    }
    const matchday = await runGmTurn(state, "음...");
    expect(matchday.suggestion).toBe("경기 시작하자");
  });
});

/**
 * 마지막 줄의 태그는 **코어가 읽는 자유 텍스트**다 (prompts.md §1) — 시점 헤더와 같은 급이라
 * 경계가 조용히 어긋난다: 값을 못 꺼내면 placeholder만 비지만, 본문에서 못 지우면 태그가
 * 화면과 다음 턴의 이력에 선다.
 */
describe("다음 말 제안 — 마지막 줄의 태그에서 꺼낸다", () => {
  const SCENE = ["[2026-07-01 AM 9:45 · 감독실]", "@코치: 첫 주는 체력입니다."].join("\n");

  it("태그의 값을 꺼내고 본문에서는 지운다 — 감싼 따옴표와 안쪽 줄바꿈은 걷는다", () => {
    const taken = takeSuggestion(`${SCENE}\n<suggest_reply>“훈련\n잡아줘”</suggest_reply>`);
    expect(taken).toEqual({ text: SCENE, suggestion: "훈련 잡아줘" });
    // 줄 한복판의 태그도 지운다 — 위생은 줄 앞머리의 꺾쇠만 본다
    const inline = takeSuggestion(`@코치: 갑시다. <suggest_reply>가자</suggest_reply>`);
    expect(inline).toEqual({ text: "@코치: 갑시다. ", suggestion: "가자" });
  });

  it("태그가 없으면 본문 그대로, 값이 없거나 상한을 넘으면 제안 없이 태그만 지운다", () => {
    expect(takeSuggestion(SCENE)).toEqual({ text: SCENE });
    expect(takeSuggestion(`${SCENE}\n<suggest_reply>  </suggest_reply>`)).toEqual({ text: SCENE });
    const long = "가".repeat(SUGGESTION_MAX_CHARS + 1);
    expect(takeSuggestion(`${SCENE}\n<suggest_reply>${long}</suggest_reply>`)).toEqual({
      text: SCENE,
    });
    const fits = "가".repeat(SUGGESTION_MAX_CHARS);
    expect(takeSuggestion(`${SCENE}\n<suggest_reply>${fits}</suggest_reply>`).suggestion).toBe(
      fits,
    );
  });

  it("닫히지 않은 태그는 잘린 응답이다 — 꼬리를 지우고 제안은 없다", () => {
    expect(takeSuggestion(`${SCENE}\n<suggest_reply>하루 넘기`)).toEqual({ text: SCENE });
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

    // 입장 턴은 첫 휘슬만 — 사건은 아직 없다. 도구 없는 턴에도 다음 말은 선다
    const entered = await runGmTurn(state, "진행", undefined, { kind: "advance_match" });
    expect(entered.text).toContain("@중계:");
    expect(entered.suggestion).toBe("계속 가자");
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

/**
 * **협상 방** — 경기와 같은 골격의 모드다 (transfer.md §12-2). 문을 여는 것은 평시 GM의
 * 도구(`start_negotiation`), 앉는 것은 손잡이, 그 뒤의 턴은 협상 GM의 것이다. 재는 것은
 * 여기서도 **기록**이다 — 방 안의 말이 손잡이를 지나 코어 명령으로 남고, 상대의 답이
 * 앵커대로 장부에 서고, 방이 국면을 되돌려 놓는가.
 */
describe("mock 대본 — 협상 방", () => {
  /** 성사 확률이 문턱을 넘는 영입 상대 — 답이 수락으로 갈려야 방이 스스로 닫힌다 */
  function acceptableTarget(state: GameState) {
    const target = state.players.find((p) => {
      if (p.teamId === state.userTeamId) return false;
      const terms = suggestTerms(state, p.id);
      if (!terms) return false;
      if (state.players.filter((q) => q.name === p.name).length > 1) return false;
      return dealOdds(state, terms).probability >= ACCEPT_ODDS_FLOOR;
    });
    if (!target) throw new Error("성사 확률이 문턱을 넘는 영입 상대가 없다");
    return target;
  }

  /** 방을 세우고 자리에 앉는 두 걸음 — 케이스마다 같다. 여는 말이 건너편을 정한다 */
  async function seatWith(state: GameState, name: string, say = "협상하자") {
    const opened = await runGmTurn(state, `${name} ${say}`);
    expectGmGrammar(opened.text);
    expect(namesOf(opened)).toContain("start_negotiation");
    expect(state.phase).toBe("negotiation");
    expect(state.pendingNegotiation?.seated).toBe(false);

    // 자리에 앉는 턴 — 방의 도구가 없고, 방과 상대의 첫 말까지다. 다음 말은 그래도 선다
    const seated = await runGmTurn(state, "협상 자리에 앉는다", undefined, {
      kind: "enter_negotiation",
    });
    expectGmGrammar(seated.text);
    expect(seated.toolCalls).toHaveLength(0);
    expect(seated.suggestion).toBe("제안한 조건으로 갑시다");
    expect(state.pendingNegotiation?.seated).toBe(true);
    return openNegotiationFor(state, acceptableTarget(state).id) ?? state.negotiations.at(-1)!;
  }

  it("단장의 방에서 값을 말하면 이적료가 굳고, 에이전트의 방에서 조건을 말하면 합의가 방을 닫는다", async () => {
    const state = newGame();
    const target = acceptableTarget(state);
    const from = state.date;
    const negotiation = await seatWith(state, target.name);
    expect(negotiation.gamePlayerId).toBe(target.id);
    expect(negotiation.rounds).toHaveLength(0);
    expect(state.pendingNegotiation?.party).toBe("club");

    const spoke = await runGmTurn(state, "제안한 조건으로 갑시다");
    expectGmGrammar(spoke.text);
    // 감독의 말은 코어가 단장의 테이블에 us 줄로 적었다
    expect(tableOf(state, negotiation, "club")?.lines.some((l) => l.by === "us")).toBe(true);
    // 값이 실린 말 — 해석기가 오퍼로 옮기고, 단장이 그 자리에서 답한다
    expect(namesOf(spoke)).toContain("send_offer");
    expect(namesOf(spoke)).toContain("reply_at_table");
    expect(negotiation.rounds.length).toBeGreaterThanOrEqual(1);
    // 앵커가 수락이되 단장의 수락은 이적료의 합의다 — 협상도 방도 열려 있다 (transfer.md §12-1)
    expect(negotiation.feeAgreed?.fee).toBe(negotiation.rounds[0]!.fee);
    expect(negotiation.status).toBe("open");
    expect(state.phase).toBe("negotiation");

    // 일어나 에이전트의 방을 연다 — 그 방의 값은 개인 조건 선제안이다
    await runGmTurn(state, "오늘은 여기까지 하죠");
    expect(state.phase).toBe("idle");
    const same = await seatWith(state, target.name, "에이전트 만나자");
    expect(same.id).toBe(negotiation.id);
    expect(state.pendingNegotiation?.party).toBe("agent");
    const personal = await runGmTurn(state, "제안한 조건으로 갑시다");
    expectGmGrammar(personal.text);
    expect(namesOf(personal)).toContain("propose_personal");
    expect(namesOf(personal)).not.toContain("send_offer");
    // 둘이 다 굳었다 — 협상은 합의로 끝나고, 끝난 협상 위에 열린 방은 없다
    expect(negotiation.personal?.agreedOn).toBe(from);
    expect(negotiation.status).toBe("agreed");
    expect(state.phase).toBe("idle");
    expect(state.pendingNegotiation ?? null).toBeNull();
    // 방 안에서 날짜는 흐르지 않는다
    expect(state.date).toBe(from);
  });

  it("값 없는 말에는 상대의 답만 서고, 일어서는 손잡이가 방을 닫되 협상은 열어 둔다", async () => {
    const state = newGame();
    const target = acceptableTarget(state);
    const negotiation = await seatWith(state, target.name);

    const talked = await runGmTurn(state, "음...");
    expect(namesOf(talked)).toContain("reply_at_table");
    expect(namesOf(talked)).not.toContain("table_orders");
    expect(negotiation.rounds).toHaveLength(0);
    expect(state.phase).toBe("negotiation");

    const left = await runGmTurn(state, "협상 자리에서 일어선다", undefined, {
      kind: "leave_negotiation",
    });
    expectGmGrammar(left.text);
    // 코어가 턴 앞에서 방을 닫았다 — 기록은 남되 칩으로 서지 않는다
    expect(left.toolCalls.find((c) => c.name === TABLE_LEFT)?.silent).toBe(true);
    expect(state.phase).toBe("idle");
    expect(negotiation.status).toBe("open");
    expect(tableOf(state, negotiation, "club")?.lines.at(-1)?.by).toBe("ledger");
  });

  it("자리를 뜨는 말은 leave_table로 방을 닫는다", async () => {
    const state = newGame();
    const target = acceptableTarget(state);
    const negotiation = await seatWith(state, target.name);

    const left = await runGmTurn(state, "오늘은 여기까지 하죠");
    expectGmGrammar(left.text);
    expect(namesOf(left)).toContain("leave_table");
    expect(state.phase).toBe("idle");
    expect(negotiation.status).toBe("open");
  });
});
