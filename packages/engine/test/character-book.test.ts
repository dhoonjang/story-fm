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
});
