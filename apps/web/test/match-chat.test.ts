import { describe, expect, it } from "vitest";
import type { ChatTurn } from "@story-fm/engine";
import { chatForActiveMatch } from "../lib/match-chat";

const turn = (text: string, matchId?: string): ChatTurn => ({
  role: "model",
  text,
  toolCalls: [],
  ...(matchId ? { inMatch: true, matchId } : {}),
});

describe("chatForActiveMatch", () => {
  const office = turn("평시 대화");
  const oldMatch = turn("지난 경기", "match-old");
  const activeMatch = turn("현재 중계", "match-now");

  it("평시에는 전체 채팅 이력을 유지한다", () => {
    expect(chatForActiveMatch([office, oldMatch], null)).toEqual([office, oldMatch]);
  });

  it("경기 중에는 현재 경기의 턴만 보여 준다", () => {
    expect(chatForActiveMatch([office, oldMatch, activeMatch], "match-now")).toEqual([activeMatch]);
  });
});
