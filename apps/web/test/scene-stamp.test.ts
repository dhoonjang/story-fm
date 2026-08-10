import { describe, expect, it } from "vitest";
import type { ChatTurn } from "@story-fm/engine";
import { cutStamps, partOfDayStamp, turnStamp } from "../lib/scene-stamp";

/**
 * 장면 시각의 눈금 — **때(오전·오후·저녁…).**
 * 정확한 시각은 상단 띠가 갖는다. 채팅이 알려야 하는 건 장면이 언제로
 * 넘어갔나뿐이라 눈금은 굵을수록 좋다.
 */

const modelTurn = (text: string): ChatTurn => ({
  role: "model",
  text,
  toolCalls: [],
  at: "2026-07-02",
});

describe("partOfDayStamp", () => {
  it("하루를 때로 접는다 — 정확한 시각은 상단 띠가 갖는다", () => {
    expect(partOfDayStamp("2026-07-02 AM 5:40")).toBe("2026-07-02 새벽");
    expect(partOfDayStamp("2026-07-02 AM 8:10")).toBe("2026-07-02 아침");
    expect(partOfDayStamp("2026-07-02 AM 10:10")).toBe("2026-07-02 오전");
    expect(partOfDayStamp("2026-07-02 PM 2:30")).toBe("2026-07-02 오후");
    expect(partOfDayStamp("2026-07-02 PM 7:05")).toBe("2026-07-02 저녁");
    expect(partOfDayStamp("2026-07-02 PM 10:40")).toBe("2026-07-02 밤");
  });

  it("같은 때의 장면들은 한 눈금으로 묶인다 — 스탬프가 매번 서지 않는다", () => {
    const bucket = ["PM 1:05", "PM 2:12", "PM 4:59"].map((t) => partOfDayStamp(`7/2 ${t}`));
    expect(new Set(bucket).size).toBe(1);
    // 때가 넘어가면 그때 선다
    expect(partOfDayStamp("7/2 PM 6:00")).not.toBe(bucket[0]);
  });

  it("정오·자정의 12시 표기를 바로 읽는다", () => {
    expect(partOfDayStamp("2026-07-02 PM 12:05")).toBe("2026-07-02 오후");
    expect(partOfDayStamp("2026-07-02 AM 12:40")).toBe("2026-07-02 새벽");
  });

  it("시각이 아닌 헤더는 그대로 둔다 — 경기 중 분 표시", () => {
    expect(partOfDayStamp("43분")).toBe("43분");
    expect(partOfDayStamp("하프타임")).toBe("하프타임");
  });
});

describe("cutStamps", () => {
  it("본문 한복판의 헤더도 걷어낸다 — 대사 사이에 날것으로 남지 않는다", () => {
    const cut = cutStamps([
      "판정을 먼저 하겠습니다.",
      "[2026-07-15 AM 9:15]",
      "@짐 랫클리프: 합의됐습니다.",
    ]);
    expect(cut.lines).toEqual(["판정을 먼저 하겠습니다.", "@짐 랫클리프: 합의됐습니다."]);
    expect(cut.stamps).toEqual([{ after: 1, stamp: "2026-07-15 오전" }]);
    expect(cut.cuts).toEqual([1]);
  });

  it("한 턴이 장면을 여럿 열면 시각도 여럿 선다", () => {
    const cut = cutStamps([
      "[2026-07-15 AM 9:05]",
      "@코치: 네.",
      "[2026-07-15 PM 3:00]",
      "@코치: 끝났습니다.",
    ]);
    expect(cut.stamps.map((s) => s.stamp)).toEqual(["2026-07-15 오전", "2026-07-15 오후"]);
    expect(cut.stamps.map((s) => s.after)).toEqual([0, 1]);
  });

  it("헤더가 없으면 줄은 그대로다", () => {
    const cut = cutStamps(["@코치: 안녕하세요."]);
    expect(cut.lines).toEqual(["@코치: 안녕하세요."]);
    expect(cut.stamps).toEqual([]);
  });
});

describe("turnStamp", () => {
  it("첫 줄의 시점 헤더를 때로 읽는다", () => {
    expect(turnStamp(modelTurn("[2026-07-02 AM 10:10]\n@코치: 안녕하세요."))).toBe(
      "2026-07-02 오전",
    );
  });

  it("장면이 여럿이면 마지막 시각이 다음 턴의 기준이다", () => {
    expect(
      turnStamp(
        modelTurn(
          "판정하겠습니다.\n[2026-07-02 AM 10:10]\n@코치: 네.\n[2026-07-02 PM 8:00]\n@코치: 끝.",
        ),
      ),
    ).toBe("2026-07-02 저녁");
  });

  it("헤더가 없으면 null", () => {
    expect(turnStamp(modelTurn("@코치: 안녕하세요."))).toBeNull();
  });

  it("감독의 말에는 시각이 없다", () => {
    expect(
      turnStamp({ role: "user", text: "[2026-07-02 AM 10:10]", toolCalls: [], at: "x" }),
    ).toBeNull();
  });
});
