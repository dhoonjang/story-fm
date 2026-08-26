import { beforeAll, describe, expect, it } from "vitest";
import type { GamePlayer, Negotiation, PressConference, ScoutReport } from "@story-fm/domain";
import { createTestGame } from "./helpers";
import type { GameState } from "../src/core/state";
import {
  CHARACTER_INJECTION_LIMIT,
  characterDepthOf,
  characterEntry,
  selectCharacters,
} from "../src/world/character-book";
import { headCoachOf, reportersOf } from "../src/world/persona";

/** 이번 턴에 실린 이름들 — 순서까지 보는 케이스만 배열을 직접 읽는다 */
function names(
  state: GameState,
  message: string,
  injected: { characterId: string; depth: "full" | "outline" | "rumour" }[] = [],
) {
  return selectCharacters(state, { message, injected }).map((e) => e.characterId);
}

/** 협상 테이블에 앉힌다 — 남의 팀 선수를 후보로 만드는 유일한 길 */
function openNegotiation(state: GameState, playerId: string): void {
  const negotiation: Negotiation = {
    id: `neg-${playerId}`,
    gamePlayerId: playerId,
    kind: "buy",
    counterpartTeamId: null,
    windowId: null,
    openedOn: state.date,
    expiresOn: state.date,
    status: "open",
    rounds: [],
  };
  state.negotiations.push(negotiation);
}

describe("캐릭터북 — 이번 턴에 실을 인물지", () => {
  let base: GameState;
  let squad: GamePlayer[];

  beforeAll(() => {
    base = createTestGame();
    /**
     * 새 게임은 **부임 회견 하나를 열고 시작한다** (people.md §4) — 열린 회견의
     * 기자는 언제나 카드가 서는 후보라(§6), 그대로 두면 이 파일의 모든 케이스가
     * 그 기자 한 사람을 함께 세운다. 이 파일이 재는 것은 회견이 아니다.
     */
    base.pressConferences = [];
    squad = base.players.filter((p) => p.teamId === base.userTeamId);
  });

  it("이력 창 안에 이미 서 있는 카드는 다시 주입되지 않는다", () => {
    const state = structuredClone(base);
    const target = squad[0]!;
    const first = selectCharacters(state, { message: `${target.name} 어떻게 지내나` });
    expect(first.map((e) => e.characterId)).toContain(target.name);

    const standing = first.map((e) => ({ characterId: e.characterId, depth: e.depth }));
    const again = selectCharacters(state, {
      message: `${target.name} 어떻게 지내나`,
      injected: standing,
    });
    expect(again).toEqual([]);
  });

  it("창 밖으로 밀려나면 다시 주입된다", () => {
    const state = structuredClone(base);
    const target = squad[1]!;
    const message = `${target.name} 오늘 훈련은 어땠나`;
    const shown = selectCharacters(state, { message }).find((e) => e.characterId === target.name)!;
    const standing = [{ characterId: shown.characterId, depth: shown.depth }];
    expect(selectCharacters(state, { message, injected: standing })).toEqual([]);
    // 이력 창이 미끄러져 기록이 넘어오지 않는 턴 — 만료 규칙 없이 이것만으로 되돌아온다
    expect(names(state, message)).toContain(target.name);
  });

  /**
   * 기억은 카드가 실리는 그 턴 층에만 선다 (people.md §6) — 창 안에 카드가 서 있는
   * 동안 압축이 적은 기억은 다시 세우지 않으면 모델에 닿지 않는다.
   */
  it("창 안에 서 있어도 기억이 늘면 다시 주입된다", () => {
    const state = structuredClone(base);
    const coach = headCoachOf(state);
    const message = `${coach.characterId} 잠깐 보자`;
    const first = selectCharacters(state, { message });
    expect(first.map((e) => e.characterId)).toContain(coach.characterId);
    const standing = first.map((e) => ({
      characterId: e.characterId,
      depth: e.depth,
      memories: e.memories?.length ?? 0,
    }));
    expect(selectCharacters(state, { message, injected: standing })).toEqual([]);

    state.characterMemories = [
      {
        characterId: coach.characterId,
        date: state.date,
        text: "주장 교체를 놓고 부딪혔다",
        salience: 3,
      },
    ];
    const again = selectCharacters(state, { message, injected: standing });
    expect(again.map((e) => e.characterId)).toEqual([coach.characterId]);
    expect(again[0]?.memories).toHaveLength(1);

    // 기억 수가 없는 옛 기록은 재주입을 부르지 않는다 — 0으로 읽으면 그 세이브의
    // 카드가 한꺼번에 다시 선다
    const old = standing.map(({ characterId, depth }) => ({ characterId, depth }));
    expect(selectCharacters(state, { message, injected: old })).toEqual([]);
  });

  it("훑는 창은 직전 모델 턴 하나다", () => {
    const state = structuredClone(base);
    const target = squad[2]!;
    state.chat.push({
      role: "model",
      text: `${target.name}이 훈련장에 남았다.`,
      toolCalls: [],
      at: state.date,
    });
    expect(names(state, "")).toContain(target.name);

    state.chat.push({ role: "model", text: "조용한 하루였다.", toolCalls: [], at: state.date });
    expect(names(state, "")).not.toContain(target.name);
  });

  it("지식 눈금이 오르면 더 자세한 판으로 다시 주입된다", () => {
    const state = structuredClone(base);
    const outsider = state.players.find((p) => p.teamId !== state.userTeamId)!;
    openNegotiation(state, outsider.id);
    const message = `${outsider.name} 영입 가능한가`;

    const rumoured = selectCharacters(state, { message }).find(
      (e) => e.characterId === outsider.name,
    );
    expect(rumoured?.depth).toBe("rumour");
    expect(rumoured?.speechStyle).toBeUndefined();

    const standing = [{ characterId: outsider.name, depth: "rumour" as const }];
    expect(selectCharacters(state, { message, injected: standing })).toEqual([]);

    const report: ScoutReport = {
      id: `scout-${outsider.id}`,
      gamePlayerId: outsider.id,
      requestedOn: state.date,
      dueOn: state.date,
      completedOn: state.date,
    };
    state.scoutReports.push(report);

    const scouted = selectCharacters(state, { message, injected: standing }).find(
      (e) => e.characterId === outsider.name,
    );
    expect(scouted?.depth).toBe("outline");
    expect(scouted?.speechStyle?.note).toBeTruthy();
  });

  it("한 턴 상한을 넘으면 이름순으로 잘린다", () => {
    const state = structuredClone(base);
    const called = squad.slice(0, CHARACTER_INJECTION_LIMIT + 2);
    const picked = names(state, called.map((p) => p.name).join(", "));
    expect(picked).toHaveLength(CHARACTER_INJECTION_LIMIT);
    expect(picked).toEqual([...picked].sort());
  });

  it("세계가 지목한 기자는 이름이 불리지 않아도 상한 안에 남는다", () => {
    const state = structuredClone(base);
    const reporter = reportersOf(state)[0]!;
    const pointed: PressConference & { reporterId: string } = {
      id: "press-1",
      date: state.date,
      trigger: "match",
      context: "홈 패배 뒤",
      facts: [{ kind: "result", text: "홈 0-2 패배", about: null, sharp: false }],
      status: "pending",
      weight: 2,
      reporterId: reporter.characterId,
    };
    state.pressConferences = [pointed];

    const called = squad.slice(0, CHARACTER_INJECTION_LIMIT + 1);
    const picked = names(state, called.map((p) => p.name).join(", "));
    expect(picked).toHaveLength(CHARACTER_INJECTION_LIMIT);
    expect(picked[0]).toBe(reporter.characterId);
  });

  /**
   * 카드가 그 사람의 말을 인용하라고 요구해 놓고 인물지를 싣지 않으면, GM이 그
   * 이름으로 즉흥의 말투를 지어낸다 — 캐릭터북이 풀었던 그 문제다 (people.md §4).
   */
  it("회견 카드에 오른 상대 감독은 이름이 불리지 않아도 자리를 받는다", () => {
    const state = structuredClone(base);
    const rival = state.teams.find((t) => t.id === "mancity")!;
    const quoted: PressConference = {
      id: "press-rival",
      date: state.date,
      trigger: "derby",
      context: "전야",
      facts: [
        {
          kind: "rival-quote",
          data: { refId: rival.id, name: rival.managerName!, tags: ["provoke"] },
          about: null,
          sharp: true,
        },
      ],
      status: "pending",
      weight: 2,
    };
    state.pressConferences = [quoted];

    const called = squad.slice(0, CHARACTER_INJECTION_LIMIT + 1);
    const picked = names(state, called.map((p) => p.name).join(", "));
    expect(picked).toContain(rival.managerName);
  });

  it("깊이가 인물지에서 덜어내는 것 — 동기·예시 대사·말투 순으로 사라진다", () => {
    const coach = headCoachOf(base);
    const full = characterEntry(coach, "full");
    expect(full.motivation).toBe(coach.motivation);
    expect(full.speechStyle?.samples.length).toBeGreaterThan(0);

    const outline = characterEntry(coach, "outline");
    expect(outline.motivation).toBeUndefined();
    expect(outline.speechStyle?.note).toBe(coach.speechStyle.note);
    expect(outline.speechStyle?.samples).toEqual([]);

    const rumour = characterEntry(coach, "rumour");
    expect(rumour.motivation).toBeUndefined();
    expect(rumour.speechStyle).toBeUndefined();
    expect(rumour.traits).toEqual(coach.traits);
  });

  it("지식 눈금 다섯이 깊이 셋으로 접힌다", () => {
    expect(characterDepthOf("own")).toBe("full");
    expect(characterDepthOf("adapting")).toBe("full");
    expect(characterDepthOf("scouted")).toBe("outline");
    expect(characterDepthOf("seen")).toBe("outline");
    expect(characterDepthOf("rumoured")).toBe("rumour");
  });

  /* ── 후보의 세 겹 — 우리 사람 · 이름난 현역 · 세계 인물 명부 (people.md §6) ── */

  it("이름난 현역은 우리 팀이 아니어도 카드가 선다 — 시장 전용 리그 시드는 능력치를 묻지 않는다", () => {
    const state = structuredClone(base);
    const legend = state.players.find((p) => p.name === "리오넬 메시")!;
    // 이 선은 능력치가 아니라 명단이 긋는다 — 나이가 깎은 것은 기량이지 이름값이 아니다
    expect(legend.attributes.overall).toBeLessThan(82);

    const [card] = selectCharacters(state, { message: "메시 같은 자원이면 데려올 만한가" });
    expect(card?.characterId).toBe("리오넬 메시");
    // 소문으로만 아는 사람이다 — 말투도 속내도 서지 않는다
    expect(card?.depth).toBe("rumour");
  });

  it("명부 인물은 말투와 예시 대사까지 선다 — 원형으로 뽑을 수 없어 표가 직접 적는다", () => {
    const state = structuredClone(base);
    const [card] = selectCharacters(state, { message: "무리뉴가 저 라인을 그냥 둘 리 없다" });
    expect(card?.characterId).toBe("조제 무리뉴");
    expect(card?.role).toBe("manager");
    expect(card?.depth).toBe("full");
    expect(card?.speechStyle?.note).toBeTruthy();
    expect(card?.speechStyle?.samples.length).toBeGreaterThan(0);
    // 실명 가드와 세트로만 운용한다 (sources.md §7)
    expect(card?.real).toBe(true);
  });

  it("유저가 맡은 팀의 명부 감독은 세계에 없다 — 그 자리를 감독이 받았다", () => {
    const state = structuredClone(base);
    expect(state.userTeamId).toBe("arsenal");
    expect(names(state, "아르테타는 저 상황을 어떻게 봤을까")).toEqual([]);
    expect(state.teams.find((t) => t.id === "arsenal")?.managerName).toBeUndefined();
    // 다른 구단의 벤치에는 명부가 이름을 심는다
    expect(state.teams.find((t) => t.id === "mancity")?.managerName).toBe("펩 과르디올라");
  });

  it("상한 경합 — 같은 문장에 함께 불려도 우리 선수단이 세계의 이름보다 앞선다", () => {
    const state = structuredClone(base);
    const ours = squad.slice(0, CHARACTER_INJECTION_LIMIT);
    const picked = names(
      state,
      `${ours.map((p) => p.name).join(", ")} 를 두고 과르디올라와 메시 이야기가 나왔다`,
    );
    // 상한이 셋이고 우리 쪽이 셋 이상 걸렸으므로 세계의 이름은 한 장도 서지 못한다.
    // **누가** 섰는지는 세지 않는다 — 키워드가 이름 조각까지 보므로("크리스티안"이
    // "리스"를 품는다) 우리 선수단 안에서 누가 걸리는지는 시드가 정한다
    expect(picked).toHaveLength(CHARACTER_INJECTION_LIMIT);
    const squadNames = new Set(squad.map((p) => p.name));
    expect(picked.every((name) => squadNames.has(name))).toBe(true);
  });

  it("이름이 겹치면 우리 쪽이 자리를 지킨다 — `characterId`는 전역 유일이다", () => {
    const state = structuredClone(base);
    const ourPlayer = state.players.find((p) => p.teamId === state.userTeamId)!;
    ourPlayer.name = "펩 과르디올라";

    const [card] = selectCharacters(state, { message: "과르디올라 어떻게 지내나" });
    expect(card?.characterId).toBe("펩 과르디올라");
    expect(card?.role).toBe("player");
  });

  it("같은 상태·같은 입력이면 같은 목록, 같은 순서다", () => {
    const state = structuredClone(base);
    const message = `${squad[0]!.name}와 메시, 그리고 무리뉴 이야기`;
    expect(selectCharacters(state, { message })).toEqual(selectCharacters(state, { message }));
  });
});
