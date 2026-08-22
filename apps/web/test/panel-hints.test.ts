import { describe, expect, it } from "vitest";
import type { ChatTurn } from "@story-fm/engine";
import { hintsOfCall, panelHintsOf } from "../lib/panel-hints";

/**
 * 장부 변경은 **그 화면 쪽에서** 알린다 — 채팅은 서사의 자리다.
 * 알림은 다음 클릭에 닫히므로, 채팅에 남은 칩이 그 말풍선을 다시 부른다.
 */

const turn = (calls: ChatTurn["toolCalls"]): ChatTurn => ({
  role: "model",
  text: "[2026-08-15 오전]\n@코치: 네.",
  toolCalls: calls,
  at: "2026-08-15",
});

/** 항목 하나짜리 기록 — 무엇이 세워지는지가 아니라 어떻게 세워지는지를 보는 케이스용 */
const call = (name: string, text: string): ChatTurn["toolCalls"][number] => ({
  name,
  summary: text,
  brief: { head: "", items: [{ text }] },
});

/**
 * 코어가 낸 **머리줄 + 항목**을 화면이 그대로 세운다 — 요약 문자열을 되쪼개지
 * 않는다. 한 항목이 한 줄이므로 세 줄 상한이 실제로 건수를 센다.
 */
describe("항목으로 서는 말풍선", () => {
  it("항목마다 한 줄 — 머리줄은 첫 줄에만 붙고 이어지는 줄은 아이콘을 다시 세우지 않는다", () => {
    const hints = panelHintsOf([
      turn([
        {
          name: "set_lineup",
          summary: "라인업 확정 — 포메이션 4-4-2 → 4-3-3 · 선발 투입 김민재 외 2명",
          brief: {
            head: "라인업 확정",
            items: [
              { label: "포메이션", text: "4-4-2 → 4-3-3" },
              { label: "선발 투입", text: "김민재 외 2명" },
            ],
          },
        },
      ]),
    ]);
    expect(hints[0]!.lines).toEqual([
      { skill: "set_lineup", head: "라인업 확정", label: "포메이션", text: "4-4-2 → 4-3-3" },
      { skill: "set_lineup", label: "선발 투입", text: "김민재 외 2명", cont: true },
    ]);
  });

  it("항목이 세 줄을 넘으면 접는다 — 문장 하나로 붙어 오던 것이 이제 건수로 센다", () => {
    const hints = panelHintsOf([
      turn([
        {
          name: "set_lineup",
          summary: "라인업 확정",
          brief: {
            head: "라인업 확정",
            items: [{ text: "A" }, { text: "B" }, { text: "C" }, { text: "D" }],
          },
        },
      ]),
    ]);
    expect(hints[0]!.lines.map((l) => l.text)).toEqual(["A", "B", "C"]);
    expect(hints[0]!.more).toBe(1);
  });

  it("바뀐 것을 못 적었으면 머리줄이 그 줄이다", () => {
    const hints = panelHintsOf([
      turn([
        { name: "set_training", summary: "훈련 해제", brief: { head: "훈련 해제", items: [] } },
      ]),
    ]);
    expect(hints[0]!.lines).toEqual([{ skill: "set_training", text: "훈련 해제" }]);
  });

  it("항목이 있으면 요약 문자열은 보지 않는다 — 사족 괄호도 떼지 않는다", () => {
    const hints = panelHintsOf([
      turn([
        {
          name: "set_tactics",
          summary: "전술 변경 — 4-2-3-1 (전술 적응도 +20, 익혀 둔 전술)",
          brief: { head: "전술 변경", items: [{ text: "4-2-3-1 (전술 적응도 +20)" }] },
        },
      ]),
    ]);
    // 갈래(`note`)는 코어가 항목에 담아 낼 때만 선다 — 화면이 문자열에서 떼어 내지 않는다
    expect(hints[0]!.lines[0]!.text).toBe("4-2-3-1 (전술 적응도 +20)");
    expect(hints[0]!.lines[0]!.note).toBeUndefined();
  });

  /**
   * 부호는 **코어가 숫자로 낸다** — 화면이 값에서 `+`·`−`를 찾아 칠하면 포메이션이
   * 같은 자를 지난다. `0`도 사실이라 그대로 실려야 한다 (색만 붙지 않는다).
   */
  it("증감은 숫자로 실려 온다 — 값 문자열에서 다시 읽지 않는다", () => {
    const hints = panelHintsOf([
      turn([
        {
          name: "set_tactics",
          summary: "전술 변경",
          brief: {
            head: "전술 변경",
            items: [
              { label: "포메이션", text: "4-2-3-1" },
              { label: "전술 적응도", text: "62", delta: 20 },
              { label: "멘탈리티", text: "3", delta: 0 },
            ],
          },
        },
      ]),
    ]);
    expect(hints[0]!.lines.map((l) => l.delta)).toEqual([undefined, 20, 0]);
  });

  /**
   * `brief`가 없는 기록은 그 규약보다 오래된 세이브의 것이다 — 요약 문자열은
   * 모델에게 돌려주는 줄이지 화면의 항목이 아니라, 말풍선에 서지 않는다.
   * 그 지시는 채팅의 칩으로 남아 있다.
   */
  it("항목 없는 기록은 서지 않는다 — 요약 문자열을 갈라 세우지 않는다", () => {
    const hints = panelHintsOf([
      turn([{ name: "set_lineup", summary: "라인업을 확정했습니다\n두 번째 줄" }]),
    ]);
    expect(hints).toEqual([]);
  });

  it("항목 없는 기록이 섞여도 나머지는 그대로 선다", () => {
    const hints = panelHintsOf([
      turn([
        { name: "set_lineup", summary: "라인업을 확정했습니다" },
        call("set_captain", "손흥민"),
      ]),
    ]);
    expect(hints[0]!.lines.map((l) => l.text)).toEqual(["손흥민"]);
  });
});

describe("말풍선의 내용", () => {
  it("한 화면의 변경들이 줄로 쌓인다", () => {
    const hints = panelHintsOf([
      turn([call("set_lineup", "4-4-2 → 4-3-3"), call("set_captain", "손흥민")]),
    ]);
    expect(hints).toHaveLength(1);
    expect(hints[0]!.lines.map((l) => l.text)).toEqual(["4-4-2 → 4-3-3", "손흥민"]);
    expect(hints[0]!.more).toBe(0);
  });

  it("세 줄을 넘으면 접는다", () => {
    const hints = panelHintsOf([
      turn(["A", "B", "C", "D", "E"].map((x) => call("set_player_tactic", `${x} 역할`))),
    ]);
    expect(hints[0]!.lines).toHaveLength(3);
    expect(hints[0]!.more).toBe(2);
  });

  it("같은 문장이 두 번 오면 한 번만 센다", () => {
    const hints = panelHintsOf([
      turn([call("set_lineup", "4-4-2 → 4-3-3"), call("set_lineup", "4-4-2 → 4-3-3")]),
    ]);
    expect(hints[0]!.lines.map((l) => l.text)).toEqual(["4-4-2 → 4-3-3"]);
  });

  it("코어가 한 일(silent)은 알림이 아니다", () => {
    const hints = panelHintsOf([
      turn([{ name: "시간 경과", summary: "2026-08-16까지 진행", silent: true }]),
    ]);
    expect(hints).toEqual([]);
  });

  it("마지막 GM 턴만 본다 — 이미 확인한 변경이 계속 서면 신호가 죽는다", () => {
    const hints = panelHintsOf([
      turn([call("set_training", "매주 3회 × 4주")]),
      { role: "user", text: "고마워", toolCalls: [], at: "2026-08-15" },
      turn([call("set_lineup", "4-4-2 → 4-3-3")]),
    ]);
    expect(hints.map((h) => h.panel)).toEqual(["스쿼드"]);
  });
});

/**
 * 알림은 다음 클릭에 닫힌다 — 되부르는 손잡이는 **채팅에 남은 칩**이다.
 * 그때 서는 것은 누른 그 호출뿐이라야 어느 지시의 결과인지가 분명하다.
 */
describe("칩으로 되부르는 말풍선", () => {
  it("누른 호출 하나만 세운다", () => {
    const hints = hintsOfCall(call("set_training", "월요일 오전 세트피스"));
    expect(hints.map((h) => h.panel)).toEqual(["달력"]);
    expect(hints[0]!.lines.map((l) => l.text)).toEqual(["월요일 오전 세트피스"]);
  });
});
