import { describe, expect, it } from "vitest";
import { pushEvent, scopeEvents, tickEvents, eventTexts } from "../src/tick-event";

/**
 * 사건을 쌓는 자리 — **종류가 조용히 무너지면 아무도 모른다.**
 *
 * 화면은 종류로 꼬리표와 픽토그램을 고르는데(ui/design-system.md §6), 자리가 종류를
 * 잃으면 카드는 그대로 서고 얼굴만 전부 「소식」이 된다. 화면이 깨지는 것이 아니라
 * 흐려지는 종류의 실패라 여기서 잰다.
 */
describe("tick 사건 자리", () => {
  it("종류를 붙이지 않고 민 사실은 소식이다", () => {
    const sink = tickEvents();
    sink.push("월간 성장: 손흥민", "임대 리포트");
    expect(sink.events).toEqual([
      { kind: "news", text: "월간 성장: 손흥민" },
      { kind: "news", text: "임대 리포트" },
    ]);
  });

  it("자리를 파 두면 그 패스가 민 사실에 그 종류가 붙는다", () => {
    const sink = tickEvents();
    scopeEvents(sink, "injury").push("햄스트링, 약 12일");
    expect(sink.events).toEqual([{ kind: "injury", text: "햄스트링, 약 12일" }]);
  });

  it("판 자리 안에서도 한 줄만 다른 종류로 설 수 있다", () => {
    const sink = tickEvents();
    const draw = scopeEvents(sink, "draw");
    draw.push("FA컵 8강 대진 추첨");
    pushEvent(draw, "news", "FA컵 우승 상금 입금");
    expect(sink.events.map((e) => e.kind)).toEqual(["draw", "news"]);
  });

  it("문장만 받는 자리(배열)에는 문장만 남는다", () => {
    const plain: string[] = [];
    pushEvent(plain, "injury", "발목");
    scopeEvents(plain, "board").push("보드가 답했다");
    expect(plain).toEqual(["발목", "보드가 답했다"]);
  });

  it("문장만 뽑는 자리는 종류를 잃지 않고 순서를 지킨다", () => {
    const sink = tickEvents();
    scopeEvents(sink, "matchday").push("경기일 — 리그 1R");
    sink.push("이적시장 개장");
    expect(eventTexts(sink.events)).toEqual(["경기일 — 리그 1R", "이적시장 개장"]);
  });
});
