import { describe, expect, it } from "vitest";
import type { CardMark, ChatTurn, GoalMark, ToolCallRecord } from "@story-fm/engine";
import {
  groupPieces,
  groupUtterances,
  minuteOf,
  splitStaging,
  weaveTurn,
} from "../lib/turn-pieces";
import { buildPlayerNameIndex, splitPlayerNames } from "../lib/player-names";
import { mergeSlice } from "../lib/game-slice";
import { chatForActiveMatch } from "../lib/match-chat";
import { buildTraceIndex } from "../lib/turn-trace-index";
import {
  alreadyShown,
  groupTraceMessages,
  previewLine,
  traceToolFlow,
} from "../lib/turn-trace-view";
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

/** 조각을 읽기 쉬운 꼴로 — 말 묶음은 첫 줄로, 표시는 호출 이름이나 키로 */
const shape = (lines: string[], parts: Parameters<typeof weaveTurn>[1]) =>
  weaveTurn(lines, parts).map((piece) => {
    if (!piece.mark) return piece.lines[0] ?? "";
    if (piece.mark.kind === "calls") return piece.mark.calls.map((c) => c.name).join("+");
    return piece.mark.key;
  });

/**
 * 연출 구간 나누기 — 화면이 문법 밖의 출력을 흡수하는 자리다(docs/llm/prompts.md §1).
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

describe("호출 칩은 불린 자리에 선다", () => {
  const lines = [
    "@: *감독실 문이 닫힌다*",
    "@손흥민: 믿어주셔서 감사합니다.",
    "@스티브 홀랜드: 사기가 올랐습니다.",
  ];

  it("장면을 쓴 뒤에 불린 호출은 그 대사 뒤에 붙는다", () => {
    expect(shape(lines, { calls: [call("talk_to_player", 2)] })).toEqual([
      "@: *감독실 문이 닫힌다*",
      "talk_to_player",
      "@스티브 홀랜드: 사기가 올랐습니다.",
    ]);
  });

  it("아무것도 쓰기 전에 불린 호출은 맨 앞이다", () => {
    expect(shape(lines, { calls: [call("get_squad", 0)] })).toEqual([
      "get_squad",
      "@: *감독실 문이 닫힌다*",
    ]);
  });

  it("같은 자리의 호출은 한 줄에 나란히 — 칩마다 문단을 끊지 않는다", () => {
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

  it("같은 자리의 호출보다 앞선다 — 장면이 열리고 그 안에서 일이 벌어진다", () => {
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

/**
 * 이어쓰기 — **태그 없이 여는 줄은 직전 화자가 이어 말하는 것이다**
 * (docs/llm/prompts.md §1). 문법이 되풀이된 태그를 지웠으므로 화면이 이어 준다.
 */
describe("groupUtterances", () => {
  /** 읽기 쉬운 꼴로 — `화자|줄1/줄2` */
  const shown = (groups: ReturnType<typeof groupUtterances>) =>
    groups.map((g) => `${g.speaker}|${g.lines.join("/")}`);

  it("태그 없는 줄은 직전 화자에 이어진다", () => {
    expect(shown(groupUtterances(["@손흥민: 준비됐습니다.", "믿어 주십시오."]))).toEqual([
      "손흥민|준비됐습니다./믿어 주십시오.",
    ]);
  });

  it("태그를 다시 적어도 같은 화자면 한 묶음 — 이어쓰기와 결과가 같다", () => {
    const tagged = groupUtterances(["@손흥민: 준비됐습니다.", "@손흥민: 믿어 주십시오."]);
    expect(shown(tagged)).toEqual(
      shown(groupUtterances(["@손흥민: 준비됐습니다.", "믿어 주십시오."])),
    );
  });

  it("다른 화자의 태그는 묶음을 끊는다", () => {
    expect(
      shown(groupUtterances(["@손흥민: 준비됐습니다.", "믿어 주십시오.", "@감독: 알겠다."])),
    ).toEqual(["손흥민|준비됐습니다./믿어 주십시오.", "감독|알겠다."]);
  });

  it("명시적 @: 내레이션은 저마다 독립된 지문이고, 그 뒤 태그 없는 줄만 이어진다", () => {
    expect(
      shown(groupUtterances(["@: *문이 열린다*", "@: *정적이 흐른다*", "*아무도 말이 없다*"])),
    ).toEqual(["|*문이 열린다*", "|*정적이 흐른다*/*아무도 말이 없다*"]);
  });

  it("첫 @ 줄 앞의 태그 없는 줄은 이을 화자가 없어 내레이션으로 선다", () => {
    expect(shown(groupUtterances(["명단을 확인하겠습니다.", "@손흥민: 준비됐습니다."]))).toEqual([
      "|명단을 확인하겠습니다.",
      "손흥민|준비됐습니다.",
    ]);
  });

  it("넘겨받은 화자가 있으면 이어쓰기로 여는 조각도 그 화자로 선다", () => {
    expect(shown(groupUtterances(["믿어 주십시오."], "손흥민"))).toEqual(["손흥민|믿어 주십시오."]);
  });
});

/**
 * **화자는 조각 경계를 넘는다** — 골 카드가 한 화자의 발화 한복판을 끊으면
 * 그 뒤 조각은 태그 없는 줄로 열린다. 조각마다 따로 묶으면 화자를 잃는다.
 */
describe("groupPieces", () => {
  const shown = (pieces: ReturnType<typeof weaveTurn>) =>
    groupPieces(pieces).map((groups) => groups.map((g) => `${g.speaker}|${g.lines.join("/")}`));

  it("골 카드가 끊은 뒤에도 이어쓰기 줄은 같은 화자가 말한다", () => {
    const pieces = weaveTurn(["@중계: 23′ 손흥민이 밀어 넣습니다!", "믿기지 않는 마무리입니다."], {
      goals: [goal(23, "손흥민")],
    });
    expect(shown(pieces)).toEqual([
      ["중계|23′ 손흥민이 밀어 넣습니다!"],
      [],
      ["중계|믿기지 않는 마무리입니다."],
    ]);
  });

  it("표시가 여럿 껴도 화자는 마지막 태그를 따라간다", () => {
    const pieces = weaveTurn(
      [
        "@중계: 23′ 골입니다!",
        "@손흥민: *포효한다*",
        "이 골은 팬들께 바칩니다.",
        "@중계: 44′ 경고입니다.",
      ],
      { goals: [goal(23, "손흥민")], cards: [booking(44, "파비우")] },
    );
    expect(shown(pieces)).toEqual([
      ["중계|23′ 골입니다!"],
      [],
      ["손흥민|*포효한다*/이 골은 팬들께 바칩니다.", "중계|44′ 경고입니다."],
      [],
    ]);
  });
});

/**
 * 원문 팝업이 읽는 제공자 원형 꼬리 (turn-trace-view.ts · models.md §5).
 *
 * 세 제공자가 모양이 다르고, 그 셋을 화면이 각자 알지 않게 하는 것이 이 함수들의
 * 일이다 — 모양 하나가 어긋나면 창이 원문을 감춘다.
 */
describe("groupTraceMessages", () => {
  const chunk = (text: string) => ({ role: "model", parts: [{ text }] });

  it("스트리밍 조각은 하나로 합치고 원문은 남긴다", () => {
    const groups = groupTraceMessages([
      { role: "user", parts: [{ text: "감독의 말" }] },
      chunk("[2026-07-13 "),
      chunk("AM 9:30]\n@레오: "),
      { role: "model", parts: [{ text: "왼쪽이 문제입니다.", thoughtSignature: "sig" }] },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[1]).toMatchObject({ role: "model", from: 1, to: 3 });
    expect(groups[1]?.text).toBe("[2026-07-13 AM 9:30]\n@레오: 왼쪽이 문제입니다.");
    // 합친 것은 읽기 위한 모양이고 기록이 아니다 — 조각 셋이 그대로 남는다
    expect(groups[1]?.raw).toHaveLength(3);
  });

  it("역할이 갈리면 잇지 않는다", () => {
    const groups = groupTraceMessages([chunk("가"), { role: "user", parts: [{ text: "나" }] }]);
    expect(groups.map((g) => g.role)).toEqual(["model", "user"]);
  });

  it("도구가 실린 메시지는 텍스트로 합치지 않는다 — JSON으로 선다", () => {
    const groups = groupTraceMessages([
      chunk("앞"),
      { role: "model", parts: [{ functionCall: { name: "get_squad", args: {} } }] },
      chunk("뒤"),
    ]);
    expect(groups.map((g) => g.text)).toEqual(["앞", null, "뒤"]);
  });

  it("모르는 모양도 버리지 않는다 — 덩어리 하나로 선다", () => {
    const groups = groupTraceMessages([{ role: "model", parts: [{ 미래의칸: 1 }] }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.text).toBeNull();
  });
});

describe("traceToolFlow", () => {
  it("Gemini — 호출에 id가 없어도 이름으로 짝짓는다", () => {
    const steps = traceToolFlow([
      {
        role: "model",
        parts: [{ functionCall: { name: "respond_to_media", args: { stance: "bold" } } }],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "call_1",
              name: "respond_to_media",
              response: { error: "지금 답할 기자회견이 없습니다" },
            },
          },
        ],
      },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      order: 1,
      name: "respond_to_media",
      failed: true,
      unanswered: false,
      summary: "지금 답할 기자회견이 없습니다",
    });
  });

  it("같은 스킬을 두 번 부르면 결과도 순서대로 붙는다", () => {
    const call = (id: string) => ({
      role: "model",
      parts: [{ functionCall: { name: "set_lineup", args: { at: id } } }],
    });
    const back = (text: string) => ({
      role: "user",
      parts: [{ functionResponse: { name: "set_lineup", response: { output: text } } }],
    });
    const steps = traceToolFlow([call("a"), back("첫째"), call("b"), back("둘째")]);
    expect(steps.map((s) => s.summary)).toEqual(["첫째", "둘째"]);
  });

  it("Anthropic — id로 짝짓고 결과 문자열을 그대로 읽는다", () => {
    const steps = traceToolFlow([
      {
        role: "assistant",
        content: [
          { type: "text", text: "확인하겠습니다" },
          { type: "tool_use", id: "toolu_1", name: "get_squad", input: { squad: "first" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "선수 25명" }],
      },
    ]);
    expect(steps).toEqual([
      {
        order: 1,
        name: "get_squad",
        input: { squad: "first" },
        output: "선수 25명",
        unanswered: false,
        failed: false,
        summary: "선수 25명",
      },
    ]);
  });

  it("OpenAI — 인자는 JSON 문자열로 오므로 풀어서 싣는다", () => {
    const steps = traceToolFlow([
      {
        type: "function_call",
        call_id: "c1",
        name: "set_captain",
        arguments: '{"playerId":"bruno"}',
      },
      { type: "function_call_output", call_id: "c1", output: "완장 지정" },
    ]);
    expect(steps[0]?.input).toEqual({ playerId: "bruno" });
    expect(steps[0]?.summary).toBe("완장 지정");
  });

  it("짝 없는 호출은 미응답으로 선다 — 잘린 응답이 그렇다", () => {
    const steps = traceToolFlow([
      { role: "model", parts: [{ functionCall: { name: "set_tactics", args: {} } }] },
    ]);
    expect(steps[0]).toMatchObject({ unanswered: true, output: null, summary: "결과 없음" });
  });
});

describe("alreadyShown", () => {
  const scene = "[2026-07-19 AM 9:00]\n@레오: 왼쪽이 문제입니다. 오늘 오후에 그 자리만 돌릴까요?";

  it("같은 글이면 접는다 — 합쳐진 꼬리가 응답 본문과 같은 자리다", () => {
    expect(alreadyShown(scene, [scene])).toBe(true);
  });

  it("발화에 스냅샷을 이어 붙여 적는 어댑터도 접힌다", () => {
    const user = "@장동훈: 내일 보자";
    const note = "<snapshot>\n<now>2026-07-18 PM 5:35</now>\n</snapshot>";
    expect(alreadyShown(`${user}\n\n${note}`, [user, note, `${user}\n\n${note}`])).toBe(true);
  });

  it("짧은 인용 하나로는 접지 않는다 — 품은 쪽의 절반은 넘어야 같은 글이다", () => {
    expect(alreadyShown(scene, ["네"])).toBe(false);
  });

  it("빈 기준은 무엇도 접지 않는다 — 응답이 비어 온 호출이 그렇다", () => {
    expect(alreadyShown(scene, ["", "   "])).toBe(false);
  });

  it("JSON으로 서는 덩어리는 판정하지 않는다", () => {
    expect(alreadyShown(null, [scene])).toBe(false);
  });
});

describe("previewLine", () => {
  it("시점 헤더만 있는 장면은 다음 줄까지 잇는다 — 헤더뿐이면 예순 줄이 다 날짜다", () => {
    const scene = "[2026-07-01 AM 9:00]\n@: *캐링턴 훈련장 감독실.*\n@스티브 홀랜드: 감독님.";
    expect(previewLine(scene)).toBe("[2026-07-01 AM 9:00]  @: *캐링턴 훈련장 감독실.*");
  });

  it("빈 줄은 세지 않는다", () => {
    expect(previewLine("\n\n  \n첫 마디\n둘째 마디")).toBe("첫 마디  둘째 마디");
  });

  it("길면 자른다 — 줄 하나로 서는 자리다", () => {
    expect(previewLine("가".repeat(200), 10)).toBe(`${"가".repeat(10)}…`);
  });
});

/**
 * 산문의 이름을 손잡이로 — **규칙이 한 벌이어야 한다** (player.md §9.5).
 * 서버가 사전에 무엇을 실을지 고르는 자와 화면이 문장을 가르는 자가 같은 함수다.
 */
describe("splitPlayerNames", () => {
  const index = buildPlayerNameIndex({
    "a-sener-lamens": "세너 라먼스",
    "b-kim": "김민재",
    "c-park-lamens": "박 라먼스",
    "d-son": "손흥민",
  });

  it("전체 이름이 서면 성으로 다시 자르지 않는다", () => {
    expect(splitPlayerNames("세너 라먼스가 뛴다", index)).toEqual([
      { text: "세너 라먼스", playerId: "a-sener-lamens" },
      { text: "가 뛴다" },
    ]);
  });

  it("조사는 이름 밖이다", () => {
    expect(splitPlayerNames("김민재는 남고 손흥민을 뺀다", index)).toEqual([
      { text: "김민재", playerId: "b-kim" },
      { text: "는 남고 " },
      { text: "손흥민", playerId: "d-son" },
      { text: "을 뺀다" },
    ]);
  });

  it("성이 둘이면 손잡이가 서지 않는다 — 어느 쪽인지 모른다", () => {
    expect(splitPlayerNames("라먼스가 넣었다", index)).toEqual([{ text: "라먼스가 넣었다" }]);
  });

  it("성만 부른 이름도 사전 안에서 유일하면 선다", () => {
    const one = buildPlayerNameIndex({ "a-sener-lamens": "세너 라먼스" });
    expect(splitPlayerNames("라먼스가 넣었다", one)).toEqual([
      { text: "라먼스", playerId: "a-sener-lamens" },
      { text: "가 넣었다" },
    ]);
  });

  it("앞이 한글이면 이름이 아니다 — 다른 이름의 꼬리를 자르지 않는다", () => {
    expect(splitPlayerNames("이김민재라는 사람", index)).toEqual([{ text: "이김민재라는 사람" }]);
  });

  it("사전에 없는 이름은 글자 그대로다", () => {
    expect(splitPlayerNames("홀란드가 넣었다", index)).toEqual([{ text: "홀란드가 넣었다" }]);
  });

  it("id 토큰 한복판은 이름이 아니다", () => {
    const latin = buildPlayerNameIndex({ "arsenal-raya": "raya" });
    expect(splitPlayerNames("arsenal-raya-2", latin)).toEqual([{ text: "arsenal-raya-2" }]);
  });

  it("동명이인은 어느 쪽도 걸지 않는다", () => {
    const twins = buildPlayerNameIndex({ "a-kim": "김민재", "b-kim": "김민재" });
    expect(splitPlayerNames("김민재가 뛴다", twins)).toEqual([{ text: "김민재가 뛴다" }]);
  });
});
