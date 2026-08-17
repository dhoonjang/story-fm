import { describe, expect, it } from "vitest";
import type { MatchEvent } from "@story-fm/domain";
import { buildSegmentMessage } from "@story-fm/agents";

const NAMES: Record<string, string> = {
  p1: "손흥민",
  p2: "페드로 포로",
};
const nameOf = (id: string) => NAMES[id] ?? id;
const sideName = (side: "home" | "away") => (side === "home" ? "토트넘" : "아스널");

function script(ev: MatchEvent): string {
  return buildSegmentMessage([ev], "flow", nameOf, sideName);
}

describe("구간 대본 — 배우 표기", () => {
  it("골은 득점자와 도움을 역할로 갈라 적는다", () => {
    const line = script({
      minute: 44,
      type: "goal",
      team: "home",
      actors: ["p1", "p2"],
      causes: [],
    });
    expect(line).toContain("득점 손흥민 · 도움 페드로 포로");
    expect(line).not.toContain("→");
  });

  it("도움 없는 골은 득점자만 적는다", () => {
    expect(
      script({ minute: 12, type: "goal", team: "home", actors: ["p1"], causes: [] }),
    ).toContain("득점 손흥민");
  });

  it("교체는 나가는 선수와 들어오는 선수를 갈라 적는다", () => {
    const line = script({
      minute: 60,
      type: "substitution",
      team: "away",
      actors: ["p1", "p2"],
      causes: [],
    });
    expect(line).toContain("OUT 손흥민 · IN 페드로 포로");
    expect(line).not.toContain("→");
  });

  it("사건 종류가 달라도 같은 순서가 같은 뜻으로 읽히지 않는다", () => {
    const actors = ["p1", "p2"];
    const goal = script({ minute: 44, type: "goal", team: "home", actors, causes: [] });
    const sub = script({ minute: 44, type: "substitution", team: "home", actors, causes: [] });
    expect(goal).not.toEqual(sub);
  });

  it("배우가 하나뿐인 사건은 이름만 적는다", () => {
    expect(
      script({ minute: 33, type: "yellow_card", team: "home", actors: ["p1"], causes: [] }),
    ).toContain("경고: 손흥민");
  });

  it("배우가 없는 사건은 이름 자리를 비운다", () => {
    expect(script({ minute: 45, type: "half_time", actors: [], causes: [] })).toContain(
      "- 45′ 하프타임",
    );
  });
});
