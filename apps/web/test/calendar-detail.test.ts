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
  it("경기는 대회·단계·홈원정·상대·결과가 따로 선다 — 한 문자열이 아니다", () => {
    const row = scheduleRowOf(match);

    expect(row.icon).toBe("match");
    expect(row.stage).toBe("R4");
    expect(row.venue).toBe("away");
    // 칸은 약칭(LIV)이지만 상세는 자리가 있다
    expect(row.name).toBe("리버풀");
    expect(row.result).toBe("2-1 승");
    expect(row.win).toBe("W");
    // 득점자는 이름 아래 잔글씨로 내려간다
    expect(row.note).toBe("득점: 홀란 23′");
    expect(row.next).toBe(true);
    // 제목을 통째로 쓰지 않는다 — "R4 원정 vs 리버풀"은 어디에도 없다
    expect(row.name).not.toContain("vs");
  });

  it("컵 경기는 대회 약칭을 달고 선다", () => {
    const row = scheduleRowOf(
      entry({
        id: "s-cup",
        type: "match",
        title: "FA컵 16강 홈 vs 아스날",
        match: {
          competition: "FA컵",
          stage: "16강",
          opponent: "ARS",
          opponentName: "아스날",
          venue: "home",
          score: null,
        },
      }),
    );

    expect(row.competition).toBe("FA컵");
    expect(row.stage).toBe("16강");
    expect(row.venue).toBe("home");
    // 미진행 경기엔 결과가 없다 — 비어 있는 게 곧 예정이다
    expect(row.result).toBeNull();
    expect(row.win).toBeNull();
  });

  it("훈련은 경기와 다른 아이콘이고, 축은 이름에 붙지 않고 따로 달린다", () => {
    const row = scheduleRowOf(training);

    expect(row.icon).toBe("training");
    expect(row.name).toBe("오전 훈련 — 전술 압박 및 트랜지션");
    expect(row.tags).toEqual(["전술·적극성"]);
    // 훈련 성과는 아래 "기록"이 접었다 펼치며 말한다
    expect(row.result).toBeNull();
    expect(row.venue).toBeNull();
  });

  it("휴식은 훈련과 아이콘이 갈린다 — 뜻이 반대인 날이라", () => {
    const row = scheduleRowOf(rest);

    expect(row.icon).toBe("rest");
    expect(row.name).toBe("오전 휴식");
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
    expect(draw.competition).toBe("FA컵");
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
    expect(round.stage).toBe("8강");
    expect(round.result).toBeNull();
  });

  it("이적창은 기간을 잔글씨로 데리고 선다", () => {
    const row = scheduleRowOf(
      entry({
        id: "s-window",
        type: "window-open",
        title: "여름 이적시장 개장",
        detail: "2026-07-01 ~ 2026-09-01",
      }),
    );

    expect(row.icon).toBe("window");
    expect(row.name).toBe("여름 이적시장 개장");
    expect(row.note).toBe("2026-07-01 ~ 2026-09-01");
  });
});
