import { describe, expect, it } from "vitest";
import type { OfficeViews } from "@story-fm/engine";
import { scheduleRowOf } from "../lib/calendar-detail";

/**
 * 달력은 **훑는 화면**이다. 칸이 색과 모양으로 가른 것을 상세에서 글자로 되돌리면
 * 감독이 같은 정보를 두 번, 서로 다른 언어로 배운다.
 * 그래서 상세의 한 줄은 문자열이 아니라 **조각**이다 — 여기서 잇지도 자르지도 않는다.
 */

type CalEntry = OfficeViews["calendar"]["entries"][number];

const base = {
  id: "s",
  date: "2026-09-12",
  time: "15:00",
  type: "training",
  status: "scheduled",
  title: "",
  detail: null,
  result: null,
  win: null,
  isNext: false,
  match: null,
  cup: null,
} satisfies CalEntry;

const entry = (over: Partial<CalEntry> & Pick<CalEntry, "id" | "type">): CalEntry => ({
  ...base,
  ...over,
});

const match = entry({
  id: "s-match",
  type: "match",
  title: "R4 원정 vs 리버풀",
  detail: "득점: 홀란 23′",
  result: "2-1 승",
  win: "W",
  isNext: true,
  match: {
    matchId: "m-liv",
    competition: null,
    stage: "R4",
    opponent: "LIV",
    opponentName: "리버풀",
    venue: "away",
    score: "2-1",
  },
});

const training = entry({
  id: "s-train",
  type: "training",
  time: "10:00",
  title: "오전 훈련 — 전술 압박 및 트랜지션",
  detail: "전술·적극성",
  rest: false,
});

const rest = entry({
  id: "s-rest",
  type: "training",
  time: "10:00",
  title: "오전 휴식",
  rest: true,
});

describe("일정 상세 한 줄", () => {
  it("경기의 이름은 제목이 아니라 상대다 — 한 문자열이 아니다", () => {
    const row = scheduleRowOf(match);

    expect(row.icon).toBe("match");
    // 칸은 약칭(LIV)이지만 상세는 자리가 있다
    expect(row.name).toBe("리버풀");
    // 제목을 통째로 쓰지 않는다 — "R4 원정 vs 리버풀"은 어디에도 없다
    expect(row.name).not.toContain("vs");
  });

  it("훈련의 축은 이름에 붙지 않고 따로 달린다", () => {
    const row = scheduleRowOf(training);

    expect(row.icon).toBe("training");
    expect(row.tags).toEqual(["전술·적극성"]);
  });

  it("휴식은 훈련과 아이콘이 갈린다 — 뜻이 반대인 날이라", () => {
    const row = scheduleRowOf(rest);

    expect(row.icon).toBe("rest");
    expect(row.tags).toEqual([]);
  });

  it("추첨은 제 아이콘을 갖고, 날짜만 잡힌 컵 라운드는 대진이 비어 있다고 선다", () => {
    const draw = scheduleRowOf(
      entry({
        id: "s-draw",
        type: "draw",
        title: "FA컵 16강 대진 추첨",
        cup: { competition: "FA컵", stage: "16강" },
      }),
    );
    expect(draw.icon).toBe("draw");
    expect(draw.name).toBe("대진 추첨");

    const round = scheduleRowOf(
      entry({
        id: "s-round",
        type: "cup-round",
        title: "FA컵 8강 예정",
        cup: { competition: "FA컵", stage: "8강" },
      }),
    );
    expect(round.pending).toBe(true);
  });
});
