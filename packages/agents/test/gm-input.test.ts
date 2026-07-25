import { describe, expect, it } from "vitest";
import {
  advanceTime,
  createGame,
  interpretBackgroundHeuristic,
  scoutPlayer,
  playersOf,
  userPlayers,
  type GameState,
} from "@story-fm/engine";
import {
  GM_SYSTEM,
  buildGmHistory,
  buildGmReference,
  buildGmStateNote,
  buildGmTools,
  type GmToolCall,
} from "@story-fm/agents";

/**
 * GM 입력 조립 — 캐시 계층의 경계가 지켜지는지 검증한다 (docs/design/llm-io.md).
 *   레퍼런스 = 거의 안 바뀜(캐시) · 상태 스냅샷 = 매 턴 바뀜(캐시 밖)
 * 이 경계가 무너지면(레퍼런스에 날짜가 새거나, 순서가 흔들리면) 캐시가 조용히 죽는다.
 */

function game(seed = 31): GameState {
  const background = "K리그에서 뛰다 은퇴한 수비수 출신 분석가";
  return createGame({
    seed,
    userTeamId: "arsenal",
    managerName: "김감독",
    background,
    attributes: interpretBackgroundHeuristic(background),
  });
}

describe("레퍼런스 블록 (캐시되는 시스템 블록)", () => {
  it("스쿼드 전원을 id|이름|주포지션으로 담는다", () => {
    const state = game();
    const ref = buildGmReference(state);
    const squad = userPlayers(state);
    expect(squad.length).toBeGreaterThanOrEqual(30);
    for (const p of squad) expect(ref).toContain(`${p.id}|${p.name}|`);
    expect(ref).toContain("김감독");
  });

  it("능력치·컨디션을 담지 않는다 — 상세는 조회 도구의 몫", () => {
    const state = game();
    const ref = buildGmReference(state);
    expect(ref).not.toContain("OVR");
    expect(ref).not.toContain("피로");
    expect(ref).not.toContain("사기");
    expect(ref).toContain("get_player");
  });

  it("휘발성 값(날짜·순위·재정)이 새지 않는다 — 새면 매 턴 캐시가 깨진다", () => {
    const state = game();
    const ref = buildGmReference(state);
    expect(ref).not.toContain(state.date);
    expect(ref).not.toContain("잔고");
  });

  it("시간이 흘러도 내용이 그대로다 (로스터가 안 바뀌는 한)", () => {
    const state = game();
    const before = buildGmReference(state);
    advanceTime(state, { days: 5 });
    expect(buildGmReference(state)).toBe(before);
  });

  it("정렬이 결정적이다 — 같은 세이브면 항상 같은 순서", () => {
    expect(buildGmReference(game(31))).toBe(buildGmReference(game(31)));
  });
});

describe("상태 스냅샷 (매 턴 갱신되는 휘발성 블록)", () => {
  it("날짜·국면·전술·재정·주의를 담는다", () => {
    const state = game();
    const note = buildGmStateNote(state);
    expect(note).toContain(state.date);
    expect(note).toContain("프리시즌");
    expect(note).toContain("전술:");
    expect(note).toContain("재정:");
    expect(note).toContain("주의:");
  });

  it("내부 phase enum을 절대 넣지 않는다 (라우팅 전용 값)", () => {
    const state = game();
    expect(buildGmStateNote(state)).not.toContain("phase");
    expect(buildGmStateNote(state)).not.toContain("idle");
  });

  it("스쿼드 표를 넣지 않는다 — 명부는 캐시 블록에 있다", () => {
    const state = game();
    const note = buildGmStateNote(state);
    const squad = userPlayers(state);
    const mentioned = squad.filter((p) => note.includes(p.id));
    expect(mentioned).toHaveLength(0);
  });

  it("스카우트 파견을 주의 신호로 알린다", () => {
    const state = game();
    const target = playersOf(state, "chelsea")[0]!;
    scoutPlayer(state, target.id);
    expect(buildGmStateNote(state)).toContain("스카우트 파견 중");
  });

  it("날짜가 흐르면 내용이 바뀐다 (캐시 밖에 있어야 하는 이유)", () => {
    const state = game();
    const before = buildGmStateNote(state);
    advanceTime(state, { days: 3 });
    expect(buildGmStateNote(state)).not.toBe(before);
  });
});

describe("이력 창 — 시작점을 STEP 단위로만 옮긴다", () => {
  const push = (state: GameState, n: number) => {
    for (let i = 0; i < n; i++) {
      state.chat.push({ role: i % 2 === 0 ? "user" : "model", text: `턴 ${i}`, toolCalls: [], at: state.date });
    }
  };

  it("이번 턴 발화(마지막)는 이력에서 제외한다", () => {
    const state = game();
    push(state, 5);
    const history = buildGmHistory(state);
    expect(history).toHaveLength(4);
    expect(history[3]?.content).toBe("턴 3");
  });

  it("연속된 턴에서 시작점이 매번 미끄러지지 않는다", () => {
    const state = game();
    push(state, 20);
    const first = buildGmHistory(state)[0]?.content;
    state.chat.push({ role: "user", text: "다음 발화", toolCalls: [], at: state.date });
    expect(buildGmHistory(state)[0]?.content).toBe(first); // 프리픽스 유지 → 캐시 적중
  });

  it("충분히 길어지면 창이 앞으로 이동한다 (무한 성장 방지)", () => {
    const state = game();
    push(state, 60);
    const history = buildGmHistory(state);
    expect(history.length).toBeLessThanOrEqual(18);
    expect(history[0]?.content).not.toBe("턴 0");
  });
});

describe("도구 구성", () => {
  it("조회 도구는 readOnly로 표시된다 (채팅 칩에 남지 않는다)", () => {
    const state = game();
    const tools = buildGmTools(state, []);
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ["search_players", "get_player", "get_team", "get_league"]) {
      expect(byName.get(name)?.readOnly).toBe(true);
    }
    // 상태를 바꾸는 도구는 기록 대상
    expect(byName.get("scout_player")?.readOnly).toBeUndefined();
    expect(byName.get("advance_time")?.readOnly).toBeUndefined();
  });

  it("조회 도구는 호출해도 기록을 남기지 않는다", () => {
    const state = game();
    const calls: GmToolCall[] = [];
    const tools = buildGmTools(state, calls);
    const search = tools.find((t) => t.name === "search_players")!;
    const res = search.handle({ team: "mine", limit: 3 });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("시스템 프롬프트가 조회·안개 규약을 담는다", () => {
    expect(GM_SYSTEM).toContain("지어내지 마라");
    expect(GM_SYSTEM).toContain("search_players");
    expect(GM_SYSTEM).toContain("scout_player");
    expect(GM_SYSTEM).not.toContain("도구 불필요");
  });
});
