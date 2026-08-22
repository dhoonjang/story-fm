import { describe, expect, it } from "vitest";
import type { CardMark, ChatTurn, GoalMark, ToolCallRecord } from "@story-fm/engine";
import { minuteOf, splitStaging, weaveTurn } from "../lib/turn-pieces";
import { mergeSlice } from "../lib/game-slice";
import { chatForActiveMatch } from "../lib/match-chat";
import { buildTraceIndex } from "../lib/turn-trace-index";
import type { GamePayload, GameSlice } from "../lib/store";

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

/**
 * 연출 구간 나누기 — 화면이 문법 밖의 출력을 흡수하는 자리다(docs/llm/prompts.md §3).
 * 별표를 하나씩 세면 `**`에서 경계가 밀려 **말이 통째로 연출로 뒤집힌다.**
 */
describe("splitStaging", () => {
  /** 읽기 쉬운 꼴로 — 연출은 별표로 다시 감싸 경계가 어디였는지 보이게 */
  const shown = (line: string) =>
    splitStaging(line).map((p) => (p.staging ? `*${p.text}*` : p.text));

  it("연출은 기울고 말은 그대로 — 별표는 남지 않는다", () => {
    expect(shown("@손흥민: *고개를 숙인다* 죄송합니다.")).toEqual([
      "@손흥민: ",
      "*고개를 숙인다*",
      " 죄송합니다.",
    ]);
  });

  it("마크다운 볼드가 말을 연출로 뒤집지 않는다 — 연속 별표는 구분자 하나다", () => {
    expect(
      shown("스트라이커 **티에르노 배리**입니다. 로마의 **산티아고 카스트로**입니다."),
    ).toEqual([
      "스트라이커 ",
      "*티에르노 배리*",
      "입니다. 로마의 ",
      "*산티아고 카스트로*",
      "입니다.",
    ]);
  });

  it("짝이 안 맞는 홀수 별표도 구분자로 먹는다 — 날것으로 남기지 않는다", () => {
    expect(shown("*라커룸이 얼어붙는다* 그리고 남은 별표*")).toEqual([
      "*라커룸이 얼어붙는다*",
      " 그리고 남은 별표",
    ]);
    expect(shown("여는 별표만 *있다").join("")).not.toContain("**");
    expect(
      splitStaging("별표만 *있다")
        .map((p) => p.text)
        .join(""),
    ).not.toContain("*");
  });

  it("스트리밍 중 열린 채 끝난 `*…`는 연출이다 — 닫힐 때까지 깜빡이지 않는다", () => {
    expect(shown("@: *교체 보드가")).toEqual(["@: ", "*교체 보드가*"]);
    // 별표만 도착한 프레임에서는 빈 <em>이 서지 않는다
    expect(splitStaging("@: *")).toEqual([{ text: "@: ", staging: false }]);
  });

  it("별표가 없으면 조각은 하나 — 평범한 대사는 그대로다", () => {
    expect(splitStaging("@감독: 라인을 올려")).toEqual([
      { text: "@감독: 라인을 올려", staging: false },
    ]);
    expect(splitStaging("")).toEqual([]);
  });
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
    expect(shape(lines, { calls: [call("talk_to_player", 3)], cuts: [0] })).toEqual([
      "@: *감독실 문이 닫힌다*",
      "talk_to_player",
      "@스티브 홀랜드: 사기가 올랐습니다.",
    ]);
  });

  it("본문 한복판에서 떼어 낸 헤더는 그 뒤의 자리만 당긴다", () => {
    // 원문 2번째 줄이 헤더였다 — 그 앞(1)은 그대로, 뒤(3)는 한 칸 당겨진다
    expect(
      shape(lines, { calls: [call("get_squad", 1), call("talk_to_player", 3)], cuts: [2] }),
    ).toEqual([
      "@: *감독실 문이 닫힌다*",
      "get_squad",
      "@손흥민: 믿어주셔서 감사합니다.",
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

describe("시각 표시는 헤더가 서 있던 자리에 선다", () => {
  const lines = ["판정을 먼저 하겠습니다.", "@짐 랫클리프: 합의됐습니다."];

  it("본문 한복판의 헤더 자리에 낀다 — 맨 앞으로 올라가지 않는다", () => {
    expect(shape(lines, { stamps: [{ after: 1, stamp: "2026-07-15 오전" }] })).toEqual([
      "판정을 먼저 하겠습니다.",
      "sp0",
      "@짐 랫클리프: 합의됐습니다.",
    ]);
  });

  it("같은 자리의 스킬보다 앞선다 — 장면이 열리고 그 안에서 일이 벌어진다", () => {
    expect(
      shape(lines, {
        stamps: [{ after: 1, stamp: "2026-07-15 오전" }],
        calls: [call("accept_deal", 2)],
        cuts: [1],
      }),
    ).toEqual(["판정을 먼저 하겠습니다.", "sp0", "accept_deal", "@짐 랫클리프: 합의됐습니다."]);
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

/**
 * 조각 응답의 병합 — issue #17. 전술판은 조작이 멎을 때마다 저장하므로 이 병합이
 * 3초마다 돈다. 바뀐 뷰만 갈아끼우고 나머지는 **화면이 쥔 것 그대로** 남아야 한다.
 */

/** 뷰의 정체를 표식 하나로만 가른다 — 이 테스트가 보는 건 어느 뷰가 살아남는가다 */
const payload = (mark: string) =>
  ({
    id: "g1",
    date: "2025-08-15",
    timeOfDay: "오후",
    season: 1,
    phase: "normal",
    teamName: "아스널",
    managerName: "감독",
    chat: [{ role: "model", text: "안녕", toolCalls: [], at: "2025-08-15" }],
    views: {
      match: null,
      squad: { formation: `4-4-2 ${mark}` },
      calendar: { today: mark },
      competitions: { list: [mark] },
      finance: { mark },
      career: { mark },
    },
    playerNames: {},
    speakerRoles: {},
    matchLogs: {},
  }) as unknown as GamePayload;

const squadSlice = (mark: string, chatLength: number): GameSlice => ({
  id: "g1",
  views: { squad: { formation: `4-2-3-1 ${mark}` } } as GameSlice["views"],
  chatLength,
});

describe("조각 응답 병합", () => {
  it("온 뷰만 갈아끼우고 나머지 뷰는 그대로 둔다", () => {
    const before = payload("before");
    const merged = mergeSlice(before, squadSlice("after", 1));

    expect(merged.views.squad.formation).toBe("4-2-3-1 after");
    // 저장이 건드리지 않은 뷰 — 응답에 없었으니 화면이 쥔 값이 여전히 최신이다
    expect(merged.views.calendar).toBe(before.views.calendar);
    expect(merged.views.competitions).toBe(before.views.competitions);
    expect(merged.views.finance).toBe(before.views.finance);
    expect(merged.views.career).toBe(before.views.career);
  });

  it("뷰 밖의 것은 조각이 건드리지 않는다 — 채팅·날짜·이름", () => {
    const before = payload("before");
    const merged = mergeSlice(before, squadSlice("after", 1));

    expect(merged.chat).toBe(before.chat);
    expect(merged.date).toBe(before.date);
    expect(merged.teamName).toBe(before.teamName);
    expect(merged.matchLogs).toBe(before.matchLogs);
  });

  it("원본을 고치지 않는다 — 화면은 새 payload를 받는다", () => {
    const before = payload("before");
    const merged = mergeSlice(before, squadSlice("after", 1));

    expect(merged).not.toBe(before);
    expect(before.views.squad.formation).toBe("4-4-2 before");
  });
});

const modelTurn = (text: string, matchId?: string): ChatTurn => ({
  role: "model",
  text,
  toolCalls: [],
  // 걸러내는 규칙은 `matchId`만 본다 — 시각은 자리를 채우는 값이다
  at: "2026-07-01T09:00:00.000Z",
  ...(matchId ? { inMatch: true, matchId } : {}),
});

describe("chatForActiveMatch", () => {
  const office = modelTurn("평시 대화");
  const oldMatch = modelTurn("지난 경기", "match-old");
  const activeMatch = modelTurn("현재 중계", "match-now");

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
    const m1 = modelTurn("코치가 고개를 끄덕인다");
    const u2 = said("다음 경기로");
    const m3 = modelTurn("경기 전날 아침");
    const index = buildTraceIndex([u0, m1, u2, m3]);
    expect([index.get(u0), index.get(m1), index.get(u2), index.get(m3)]).toEqual([1, 1, 3, 3]);
  });

  it("경기 턴이 섞여도 걸러지지 않은 절대 자리를 준다", () => {
    const chat = [
      modelTurn("평시"),
      modelTurn("중계", "match-now"),
      modelTurn("중계2", "match-now"),
    ];
    expect(chat.map((t) => buildTraceIndex(chat).get(t))).toEqual([0, 1, 2]);
  });

  it("오퍼레이터 턴은 발화와 그 왕복 사이를 가르지 않는다", () => {
    const u0 = said("계속");
    const chat = [u0, operator("시간 진행"), modelTurn("전반 12분")];
    expect(buildTraceIndex(chat).get(u0)).toBe(2);
  });

  it("짝이 될 모델 턴이 없는 발화는 표에 없다 — 열 기록이 없다", () => {
    const pending = said("아직 답이 오지 않은 말");
    const orphan = said("답을 못 받은 말");
    const chat = [orphan, pending, modelTurn("하나뿐인 응답")];
    expect(buildTraceIndex(chat).get(orphan)).toBeUndefined();
    expect(buildTraceIndex(chat).get(pending)).toBe(2);
  });
});
