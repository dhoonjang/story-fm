import { describe, expect, it } from "vitest";
import type { ChatTurn } from "@story-fm/engine";
import { chatForActiveMatch } from "../lib/match-chat";
import { buildTraceIndex } from "../lib/turn-trace-index";

const turn = (text: string, matchId?: string): ChatTurn => ({
  role: "model",
  text,
  toolCalls: [],
  // 걸러내는 규칙은 `matchId`만 본다 — 시각은 자리를 채우는 값이다
  at: "2026-07-01T09:00:00.000Z",
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

/**
 * 인덱스가 조용히 밀리면 **남의 턴 원문**이 열린다 — 화면에는 그럴듯한 창이
 * 그대로 서므로 눈으로는 알아채지 못한다. 그 어긋남만 여기서 잡는다.
 */
describe("buildTraceIndex", () => {
  const said = (text: string): ChatTurn => ({
    role: "user",
    text,
    toolCalls: [],
    at: "2026-07-01",
  });
  const operator = (text: string): ChatTurn => ({
    role: "operator",
    text,
    toolCalls: [],
    at: "2026-07-01",
  });

  it("모델 턴은 제 자리를, 감독 발화는 바로 뒤 모델 턴의 자리를 연다", () => {
    const u0 = said("훈련 강도를 올리자");
    const m1 = turn("코치가 고개를 끄덕인다");
    const u2 = said("다음 경기로");
    const m3 = turn("경기 전날 아침");
    const index = buildTraceIndex([u0, m1, u2, m3]);
    expect([index.get(u0), index.get(m1), index.get(u2), index.get(m3)]).toEqual([1, 1, 3, 3]);
  });

  it("경기 턴이 섞여도 걸러지지 않은 절대 자리를 준다", () => {
    const chat = [turn("평시"), turn("중계", "match-now"), turn("중계2", "match-now")];
    expect(chat.map((t) => buildTraceIndex(chat).get(t))).toEqual([0, 1, 2]);
  });

  it("오퍼레이터 턴은 발화와 그 왕복 사이를 가르지 않는다", () => {
    const u0 = said("계속");
    const chat = [u0, operator("시간 진행"), turn("전반 12분")];
    expect(buildTraceIndex(chat).get(u0)).toBe(2);
  });

  it("짝이 될 모델 턴이 없는 발화는 표에 없다 — 열 기록이 없다", () => {
    const pending = said("아직 답이 오지 않은 말");
    const orphan = said("답을 못 받은 말");
    const chat = [orphan, pending, turn("하나뿐인 응답")];
    expect(buildTraceIndex(chat).get(orphan)).toBeUndefined();
    expect(buildTraceIndex(chat).get(pending)).toBe(2);
  });
});
