import { describe, expect, it } from "vitest";
import type { ChatTurn } from "@story-fm/engine";
import { hasRailHint, hintsOfCall, panelHintsOf } from "../lib/panel-hints";

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

describe("어느 화면으로 가는가", () => {
  it("장부를 바꾸는 스킬은 레일이 맡는다", () => {
    for (const name of ["set_lineup", "set_tactics", "set_training", "apply_finance_event"]) {
      expect(hasRailHint(name), name).toBe(true);
    }
  });

  it("대화형도 바뀌는 장부가 있다 — 사기는 명단이, 평판은 커리어가 보여준다", () => {
    const squad = panelHintsOf([turn([{ name: "talk_to_player", summary: "면담 — 사기 +4" }])]);
    expect(squad.map((h) => h.panel)).toEqual(["스쿼드"]);
    const career = panelHintsOf([
      turn([{ name: "respond_to_media", summary: "기자회견 대응 — 언론 +2" }]),
    ]);
    expect(career.map((h) => h.panel)).toEqual(["커리어"]);
  });

  /**
   * 협상·스카우트는 **카드**로 선다(`MarketCard`) — 진행 중인 흥정은 어느 장부에도
   * 실리지 않으므로 레일이 가리킬 화면이 없다.
   */
  it("카드로 서는 스킬은 말풍선을 갖지 않는다", () => {
    for (const name of [
      "send_offer",
      "respond_offer",
      "open_renewal",
      "withdraw_offer",
      "scout_player",
    ]) {
      expect(hasRailHint(name), name).toBe(false);
    }
  });

  it("여러 장부를 건드리는 스킬도 한 화면만 가리킨다 — 같은 문장이 두 칸에 서면 두 번 벌어진 일처럼 읽힌다", () => {
    const hints = panelHintsOf([turn([{ name: "accept_deal", summary: "이적 확정" }])]);
    expect(hints.map((h) => h.panel)).toEqual(["스쿼드"]);
  });
});

describe("말풍선의 내용", () => {
  it("한 화면의 변경들이 줄로 쌓인다", () => {
    const hints = panelHintsOf([
      turn([
        { name: "set_lineup", summary: "라인업을 확정했습니다" },
        { name: "set_captain", summary: "손흥민을 주장으로" },
      ]),
    ]);
    expect(hints).toHaveLength(1);
    expect(hints[0]!.lines.map((l) => l.text)).toEqual([
      "라인업을 확정했습니다",
      "손흥민을 주장으로",
    ]);
    expect(hints[0]!.more).toBe(0);
  });

  it("세 줄을 넘으면 접는다", () => {
    const hints = panelHintsOf([
      turn(
        ["A", "B", "C", "D", "E"].map((x) => ({ name: "set_player_tactic", summary: `${x} 역할` })),
      ),
    ]);
    expect(hints[0]!.lines).toHaveLength(3);
    expect(hints[0]!.more).toBe(2);
  });

  it("같은 문장이 두 번 오면 한 번만 센다", () => {
    const hints = panelHintsOf([
      turn([
        { name: "set_lineup", summary: "라인업을 확정했습니다" },
        { name: "set_lineup", summary: "라인업을 확정했습니다" },
      ]),
    ]);
    expect(hints[0]!.lines.map((l) => l.text)).toEqual(["라인업을 확정했습니다"]);
  });

  it("갈래는 화면이 아이콘으로 세운다 — 줄에 어느 스킬인지 남는다", () => {
    const hints = panelHintsOf([turn([{ name: "set_captain", summary: "손흥민을 주장으로" }])]);
    expect(hints[0]!.lines[0]!.skill).toBe("set_captain");
  });

  it("끝에 괄호로 달린 사족은 떼어 낸다 — 본문에 붙으면 바뀐 것이 안 보인다", () => {
    const hints = panelHintsOf([
      turn([
        {
          name: "set_tactics",
          summary: "전술 변경 — 4-2-3-1, 멘탈리티 3 (전술 적응도 +20, 익혀 둔 전술)",
        },
      ]),
    ]);
    expect(hints[0]!.lines[0]!.text).toBe("전술 변경 — 4-2-3-1, 멘탈리티 3");
    expect(hints[0]!.lines[0]!.note).toBe("전술 적응도 +20, 익혀 둔 전술");
  });

  it("괄호가 없으면 사족도 없다", () => {
    const hints = panelHintsOf([turn([{ name: "set_lineup", summary: "라인업을 확정했습니다" }])]);
    expect(hints[0]!.lines[0]!.note).toBeUndefined();
  });

  it("코어가 한 일(silent)은 알림이 아니다", () => {
    const hints = panelHintsOf([
      turn([{ name: "시간 경과", summary: "2026-08-16까지 진행", silent: true }]),
    ]);
    expect(hints).toEqual([]);
  });

  it("마지막 GM 턴만 본다 — 이미 확인한 변경이 계속 서면 신호가 죽는다", () => {
    const hints = panelHintsOf([
      turn([{ name: "set_training", summary: "훈련을 잡았습니다" }]),
      { role: "user", text: "고마워", toolCalls: [], at: "2026-08-15" },
      turn([{ name: "set_lineup", summary: "라인업을 확정했습니다" }]),
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
    const hints = hintsOfCall({ name: "set_training", summary: "월요일 오전 세트피스" });
    expect(hints.map((h) => h.panel)).toEqual(["달력"]);
    expect(hints[0]!.lines.map((l) => l.text)).toEqual(["월요일 오전 세트피스"]);
  });

  it("여러 장부를 건드린 호출도 한 화면만 부른다", () => {
    const hints = hintsOfCall({ name: "accept_deal", summary: "이적 확정" });
    expect(hints.map((h) => h.panel)).toEqual(["스쿼드"]);
  });

  it("카드로 서는 스킬은 부를 말풍선이 없다", () => {
    expect(hintsOfCall({ name: "send_offer", summary: "오퍼를 넣었습니다" })).toEqual([]);
  });
});
