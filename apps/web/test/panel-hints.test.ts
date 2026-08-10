import { describe, expect, it } from "vitest";
import type { ChatTurn } from "@story-fm/engine";
import { movedToRail, panelHintsOf } from "../lib/panel-hints";

/**
 * 장부 변경은 **그 화면 쪽에서** 알린다 — 채팅은 서사의 자리다.
 * 채팅에 남는 칩은 갈 화면이 없는 것들뿐이다(대화·협상·스카우트 파견).
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
      expect(movedToRail(name), name).toBe(true);
    }
  });

  it("갈 화면이 없는 것은 채팅에 남는다", () => {
    for (const name of ["talk_to_player", "team_talk", "respond_to_media", "send_offer", "scout_player"]) {
      expect(movedToRail(name), name).toBe(false);
    }
  });

  it("한 스킬이 두 장부를 건드리면 둘 다 선다", () => {
    const hints = panelHintsOf([turn([{ name: "accept_deal", summary: "이적 확정" }])]);
    expect(hints.map((h) => h.panel).sort()).toEqual(["스쿼드", "재정"]);
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
    expect(hints[0]!.lines).toEqual(["라인업을 확정했습니다", "손흥민을 주장으로"]);
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
    expect(hints[0]!.lines).toEqual(["라인업을 확정했습니다"]);
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
