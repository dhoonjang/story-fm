import { describe, expect, it } from "vitest";
import {
  playerCard,
  playersOf,
  rankByName,
  searchPlayers,
  setCaptain,
  userPlayers,
  type NamedItem,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

/**
 * 이름 지목 — 감독은 카탈로그 표기를 모른다. "엔더슨"이라 불러도 "앤더슨"에
 * 닿아야 하지만, **엉뚱한 사람을 조용히 골라서는 안 된다.** 그래서 이 파일의
 * 절반은 "닿는다"이고 나머지 절반은 "닿지 않는다"이다.
 */

const POOL: NamedItem[] = [
  { id: "elliot-anderson", name: "엘리엇 앤더슨" },
  { id: "lisandro-martinez", name: "리산드로 마르티네스" },
  { id: "emiliano-martinez", name: "에밀리아노 마르티네스" },
  { id: "kevin-de-bruyne", name: "케빈 더 브라위너" },
  { id: "erling-haaland", name: "엘링 홀란" },
  { id: "harry-kane", name: "해리 케인" },
  { id: "kevin", name: "케빈" },
  { id: "son-heung-min", name: "손흥민" },
  { id: "bukayo-saka", name: "부카요 사카" },
  { id: "martin-odegaard", name: "마르틴 외데고르" },
  { id: "vinicius-junior", name: "비니시우스 주니오르" },
  { id: "bruno-pereira", name: "브루누 페레이라" },
];

const bestId = (query: string, pool: readonly NamedItem[] = POOL): string | null =>
  rankByName(query, pool).best?.id ?? null;

describe("표기가 흔들려도 닿는다", () => {
  /** [감독이 말한 것, 닿아야 할 id, 무엇이 흔들렸나] */
  const cases: Array<[string, string, string]> = [
    ["엘리엇 앤더슨", "elliot-anderson", "그대로"],
    ["앤더슨", "elliot-anderson", "성만 부르기"],
    ["엔더슨", "elliot-anderson", "애/에"],
    ["엘리엇 엔더슨", "elliot-anderson", "애/에 + 전체 이름"],
    ["엘리엇", "elliot-anderson", "이름만 부르기"],
    ["Anderson", "elliot-anderson", "로마자"],
    ["elliot andersen", "elliot-anderson", "로마자 표기 흔들림"],
    ["리산드로 마르티네즈", "lisandro-martinez", "ㅅ/ㅈ"],
    ["더 브라위너", "kevin-de-bruyne", "성만 부르기"],
    ["데 브라위너", "kevin-de-bruyne", "어/에"],
    ["데브라위너", "kevin-de-bruyne", "어/에 + 띄어쓰기"],
    ["더·브라위너", "kevin-de-bruyne", "가운뎃점"],
    ["케빈 데 브라위너", "kevin-de-bruyne", "어/에 (온전한 동명이인이 있어도)"],
    ["De Bruyne", "kevin-de-bruyne", "로마자 성만"],
    ["홀란", "erling-haaland", "성만 부르기"],
    ["홀란드", "erling-haaland", "꼬리 흔들림"],
    ["Haaland", "erling-haaland", "로마자"],
    ["사까", "bukayo-saka", "된소리/거센소리"],
    ["웨데고르", "martin-odegaard", "왜/외/웨"],
    ["비니시으스", "vinicius-junior", "우/으"],
    ["손흥민", "son-heung-min", "그대로"],
    ["케빈", "kevin", "온전한 일치가 부분 일치를 이긴다"],
  ];

  it.each(cases)("%s → %s (%s)", (said, id) => {
    expect(bestId(said)).toBe(id);
  });
});

describe("닿지 않는다 — 틀린 사람을 조용히 고르지 않는다", () => {
  /** 짧은 이름은 한 자만 달라도 남이다 */
  it("케인은 케빈이 아니다", () => {
    expect(bestId("케인")).toBe("harry-kane");
    expect(bestId("케빈")).toBe("kevin");
  });

  it("모음과 꼬리가 함께 흔들리면 짐작하지 않는다 — 할란드", () => {
    expect(rankByName("할란드", POOL).matches).toEqual([]);
  });

  it("두 자 이상 어긋난 성은 잇지 않는다 — 마르티넬리 ≠ 마르티네스", () => {
    expect(rankByName("마르티넬리", POOL).matches).toEqual([]);
  });

  it("세계에 없는 이름은 후보도 없다", () => {
    expect(rankByName("존재하지않는사람", POOL).matches).toEqual([]);
    expect(rankByName("귀케레스", POOL).matches).toEqual([]);
  });

  it("id 조각이 다른 id 한가운데 끼어도 걸리지 않는다", () => {
    // "nope"는 "bruno-pereira"의 글자를 가로지를 뿐이다
    expect(rankByName("nope", POOL).matches).toEqual([]);
  });

  it("빈 문자열·공백은 아무도 부르지 않은 것이다", () => {
    expect(rankByName("", POOL).matches).toEqual([]);
    expect(rankByName("   ", POOL).matches).toEqual([]);
  });
});

describe("갈리면 고르지 않고 후보를 준다", () => {
  it("동명의 성 둘 — 확정은 없고 후보는 둘", () => {
    const ranked = rankByName("마르티네스", POOL);
    expect(ranked.best).toBeNull();
    expect(ranked.matches.map((m) => m.id)).toEqual(["emiliano-martinez", "lisandro-martinez"]);
  });

  it("표기가 흔들린 채 갈려도 마찬가지다", () => {
    const ranked = rankByName("마르티네즈", POOL);
    expect(ranked.best).toBeNull();
    expect(ranked.matches).toHaveLength(2);
  });

  it("동점 후보의 순서는 id 오름차순으로 고정된다 — 같은 입력이면 같은 답", () => {
    const shuffled = [...POOL].reverse();
    expect(rankByName("마르티네스", shuffled).matches.map((m) => m.id)).toEqual([
      "emiliano-martinez",
      "lisandro-martinez",
    ]);
    expect(rankByName("마르티네스", POOL).matches.map((m) => m.id)).toEqual(
      rankByName("마르티네스", shuffled).matches.map((m) => m.id),
    );
  });

  it("확실한 일치가 있으면 흔들림 후보는 섞이지 않는다", () => {
    // "홀란"이 그대로 있으므로 "홀랜드"류를 추정할 이유가 없다
    const pool = [...POOL, { id: "andre-holland", name: "안드레 홀랜드" }];
    expect(bestId("홀란", pool)).toBe("erling-haaland");
    expect(rankByName("홀란", pool).matches.map((m) => m.id)).toEqual(["erling-haaland"]);
  });
});

describe("카탈로그 — 실제 세계에서", () => {
  const state = createTestGame(7);

  it("엔더슨 → 엘리엇 앤더슨", () => {
    const found = rankByName("엔더슨", state.players).best;
    expect(found?.name).toBe("엘리엇 앤더슨");
  });

  it("search_players가 흔들린 표기를 받는다", () => {
    const res = searchPlayers(state, { name: "엔더슨" });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("엘리엇 앤더슨");
  });

  it("선수 카드가 이름으로도 열린다", () => {
    const res = playerCard(state, "엔더슨");
    expect(res.ok, res.message).toBe(true);
    expect(res.message).toContain("엘리엇 앤더슨");
  });

  it("갈리는 이름은 카드 대신 후보를 돌려준다", () => {
    const res = playerCard(state, "마르티네스");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("여러 선수와 맞습니다");
    expect(res.message).toContain("마르티네스");
  });

  it("없는 이름은 검색을 안내한다", () => {
    const res = playerCard(state, "존재하지않는사람");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("search_players");
  });

  it("스킬도 이름으로 선수를 집는다 — 상태를 바꾸는 자리까지", () => {
    const mine = userPlayers(state).find((p) => p.name.includes(" "))!;
    const res = setCaptain(state, mine.name.replace(/\s/g, ""));
    expect(res.ok, res.message).toBe(true);
    expect(state.players.find((p) => p.isCaptain)?.id).toBe(mine.id);
  });

  it("스킬은 남의 팀 선수를 우리 선수로 만들지 않는다", () => {
    const stranger = playersOf(state, "chelsea")[0]!;
    const res = setCaptain(state, stranger.name);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("우리 팀 선수가 아닙니다");
  });
});
