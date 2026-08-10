import { describe, expect, it } from "vitest";
import type { CardMark, GoalMark, ToolCallRecord } from "@story-fm/engine";
import { minuteOf, weaveTurn } from "../lib/turn-pieces";

/**
 * 표시의 자리 — **벌어진 지점에 선다** (turn-pieces.ts).
 * 턴 맨 앞에 몰면 결과를 먼저 보고 장면을 거꾸로 읽게 된다.
 */

const goal = (minute: number, scorer: string): GoalMark => ({
  minute,
  scorer,
  assist: null,
  ours: true,
  team: "아스널",
  score: { home: 1, away: 0 },
});

const booking = (minute: number, player: string): CardMark => ({
  minute,
  player,
  kind: "yellow",
  ours: true,
  team: "아스널",
});

const call = (name: string, line?: number): ToolCallRecord => ({
  name,
  summary: `${name} 실행`,
  ...(line === undefined ? {} : { line }),
});

/** 조각을 읽기 쉬운 꼴로 — 말 묶음은 첫 줄로, 표시는 스킬 이름이나 키로 */
const shape = (lines: string[], parts: Parameters<typeof weaveTurn>[1]) =>
  weaveTurn(lines, parts).map((piece) => {
    if (!piece.mark) return piece.lines[0] ?? "";
    if (piece.mark.kind === "calls") return piece.mark.calls.map((c) => c.name).join("+");
    return piece.mark.key;
  });

describe("분 읽기", () => {
  it("프라임·아포스트로피·추가 시간을 모두 읽는다", () => {
    expect(minuteOf("@중계: *23′ — 사카, 골입니다!*")).toBe(23);
    expect(minuteOf("@중계: 67' 슛이 빗나갑니다")).toBe(67);
    expect(minuteOf("@중계: 45+2′ 전반 종료 직전")).toBe(45);
  });

  it("시간이 없는 줄은 자리를 정하지 않는다", () => {
    expect(minuteOf("@감독: 라인을 올려")).toBeNull();
    expect(minuteOf("@: *교체 보드가 올라간다*")).toBeNull();
  });
});

describe("골·경고는 그 분이 지나간 줄 뒤에 선다", () => {
  it("골 문장 다음에 골 카드가 낀다", () => {
    expect(
      shape(["@중계: 킥오프!", "@중계: *23′ — 사카, 골입니다!*", "@중계: 30′ 흐름이 이어집니다"], {
        goals: [goal(23, "사카")],
      }),
    ).toEqual(["@중계: 킥오프!", "g0", "@중계: 30′ 흐름이 이어집니다"]);
  });

  it("두 사건은 저마다 제 자리로 흩어진다 — 앞에 몰리지 않는다", () => {
    expect(
      shape(["@중계: 12′ 첫 골!", "@중계: 40′ 경고가 나옵니다", "@중계: 55′ 두 번째 골!"], {
        goals: [goal(12, "사카"), goal(55, "하베르츠")],
        cards: [booking(40, "라이스")],
      }),
    ).toEqual([
      "@중계: 12′ 첫 골!",
      "g0",
      "@중계: 40′ 경고가 나옵니다",
      "c0",
      "@중계: 55′ 두 번째 골!",
      "g1",
    ]);
  });

  it("중계가 시간을 안 적었으면 맨 뒤에 남는다 — 사라지지 않는다", () => {
    expect(shape(["@중계: 골이 터집니다!"], { goals: [goal(23, "사카")] })).toEqual([
      "@중계: 골이 터집니다!",
      "g0",
    ]);
  });
});

describe("스킬 칩은 불린 자리에 선다", () => {
  const lines = [
    "@: *감독실 문이 닫힌다*",
    "@손흥민: 믿어주셔서 감사합니다.",
    "@스티브 홀랜드: 사기가 올랐습니다.",
  ];

  it("장면을 쓴 뒤에 불린 스킬은 그 대사 뒤에 붙는다", () => {
    expect(shape(lines, { calls: [call("talk_to_player", 2)] })).toEqual([
      "@: *감독실 문이 닫힌다*",
      "talk_to_player",
      "@스티브 홀랜드: 사기가 올랐습니다.",
    ]);
  });

  it("아무것도 쓰기 전에 불린 스킬은 맨 앞이다", () => {
    expect(shape(lines, { calls: [call("get_squad", 0)] })).toEqual([
      "get_squad",
      "@: *감독실 문이 닫힌다*",
    ]);
  });

  it("같은 자리의 스킬은 한 줄에 나란히 — 칩마다 문단을 끊지 않는다", () => {
    expect(shape(lines, { calls: [call("team_talk", 1), call("set_captain", 1)] })).toEqual([
      "@: *감독실 문이 닫힌다*",
      "team_talk+set_captain",
      "@손흥민: 믿어주셔서 감사합니다.",
    ]);
  });

  it("자리를 모르는 옛 기록은 지금까지처럼 맨 앞에 선다", () => {
    expect(shape(lines, { calls: [call("team_talk")] })).toEqual([
      "team_talk",
      "@: *감독실 문이 닫힌다*",
    ]);
  });

  it("떼어 낸 헤더만큼 자리를 당긴다 — 시각 표시는 줄에서 빠졌다", () => {
    // 저장된 본문은 `[2026-08-15 AM 9:00]` 헤더를 포함해 세므로 3, 화면에서는 2다
    expect(shape(lines, { calls: [call("talk_to_player", 3)], dropped: 1 })).toEqual([
      "@: *감독실 문이 닫힌다*",
      "talk_to_player",
      "@스티브 홀랜드: 사기가 올랐습니다.",
    ]);
  });

  it("본문보다 뒤를 가리키면 맨 끝에 남는다", () => {
    expect(shape(lines, { calls: [call("set_lineup", 99)] })).toEqual([
      "@: *감독실 문이 닫힌다*",
      "set_lineup",
    ]);
  });
});

describe("아무 표시도 없으면 조각은 하나 — 평시 대화는 그대로다", () => {
  it("쪼개지 않는다", () => {
    const lines = ["@수석코치: 훈련 계획입니다", "@감독: 좋아"];
    expect(weaveTurn(lines)).toEqual([{ lines }]);
  });
});

describe("칩과 사건이 함께 있는 턴", () => {
  it("각자 제 자리로 — 칩은 줄 수로, 골은 분으로", () => {
    expect(
      shape(["@중계: 킥오프!", "@중계: *23′ — 사카, 골입니다!*", "@스티브 홀랜드: 교체할까요?"], {
        goals: [goal(23, "사카")],
        calls: [call("substitute", 3)],
      }),
    ).toEqual(["@중계: 킥오프!", "g0", "@스티브 홀랜드: 교체할까요?", "substitute"]);
  });
});
