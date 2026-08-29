import { describe, expect, it } from "vitest";
import {
  groupOf,
  openRenewal,
  playerCard,
  playersOf,
  rankByName,
  setCaptain,
  setTransferList,
  startMatch,
  substitutePlayer,
  userPlayers,
  userSide,
  type GameState,
  type NamedItem,
  claimPlayerId,
  playerCatalog,
  slugifyName,
  transitionSeason,
} from "@story-fm/engine";
import { type GamePlayer } from "@story-fm/domain";
import { advanceToMatchday, createTestGame } from "./helpers";

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

  it("선수 카드가 이름으로도 열린다", () => {
    const res = playerCard(state, "엔더슨");
    expect(res.ok, res.message).toBe(true);
  });

  it("갈리는 이름은 카드 대신 후보를 돌려준다", () => {
    const res = playerCard(state, "마르티네스");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("여러 선수와 맞습니다");
  });

  it("없는 이름으로는 카드가 열리지 않는다", () => {
    const res = playerCard(state, "존재하지않는사람");
    expect(res.ok).toBe(false);
  });

  it("명령도 이름으로 선수를 집는다 — 상태를 바꾸는 자리까지", () => {
    const mine = userPlayers(state).find((p) => p.name.includes(" "))!;
    const res = setCaptain(state, { playerId: mine.name.replace(/\s/g, "") });
    expect(res.ok, res.message).toBe(true);
    expect(state.players.find((p) => p.isCaptain)?.id).toBe(mine.id);
  });

  it("명령은 남의 팀 선수를 우리 선수로 만들지 않는다", () => {
    const stranger = playersOf(state, "chelsea")[0]!;
    const res = setCaptain(state, { playerId: stranger.name });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("우리 팀 선수가 아닙니다");
  });

  /**
   * 시장·경기 명령도 이름을 받는다. 다만 **상태에 남는 것은 언제나 id다** —
   * 협상 id·`gamePlayerId`·장부의 actors에 감독이 부른 이름이 박히면 세이브가
   * 그 선수를 다시 찾지 못한다.
   */
  const calledBy = (p: GamePlayer): string => p.name.replace(/\s/g, "");
  /** 붙여 쓴 채로도 그 풀에서 이 선수 하나에만 닿는가 */
  const reaches = (p: GamePlayer, pool: readonly GamePlayer[]): boolean =>
    p.name.includes(" ") && rankByName(calledBy(p), pool).best?.id === p.id;
  const namedInWorld = (game: GameState): GamePlayer =>
    userPlayers(game).find((p) => reaches(p, game.players))!;

  it("이적 리스트도 이름으로 올린다 — 등재되는 것은 id다", () => {
    const game = createTestGame(7);
    const mine = namedInWorld(game);
    const res = setTransferList(game, { playerId: calledBy(mine), listed: true });
    expect(res.ok, res.message).toBe(true);
    expect(game.transferList.map((l) => l.gamePlayerId)).toContain(mine.id);
  });

  it("재계약을 이름으로 열어도 협상에 남는 것은 id다", () => {
    const game = createTestGame(7);
    const mine = namedInWorld(game);
    const said = calledBy(mine);
    const res = openRenewal(game, { playerId: said, weeklyWage: 100_000, years: 3 });
    expect(res.ok, res.message).toBe(true);
    const negotiation = game.negotiations.at(-1)!;
    expect(negotiation.gamePlayerId).toBe(mine.id);
    expect(negotiation.id).toContain(mine.id);
    expect(negotiation.id).not.toContain(said);
  });

  it("교체도 이름으로 하고, 장부에 남는 actors는 id다", () => {
    const game = createTestGame(7);
    advanceToMatchday(game);
    const started = startMatch(game);
    expect(started.ok, started.message).toBe(true);
    const match = game.pendingMatch!;
    const ours = userSide(game) === "home" ? match.ledger.home : match.ledger.away;
    const roster = userPlayers(game);
    const byId = (id: string): GamePlayer | undefined => roster.find((p) => p.id === id);
    const pickable = (ids: readonly string[]): GamePlayer[] =>
      ids.flatMap((id) => {
        const p = byId(id);
        return p && reaches(p, roster) ? [p] : [];
      });
    const out = pickable(ours.onPitch).find((p) => groupOf(p) !== "GK")!;
    const incoming = pickable(ours.bench)[0]!;

    const res = substitutePlayer(game, { out: calledBy(out), in: calledBy(incoming) });
    expect(res.ok, res.message).toBe(true);
    const logged = match.ledger.events.filter((e) => e.type === "substitution").at(-1)!;
    expect(logged.actors).toEqual([out.id, incoming.id]);
  });

  it("갈리는 이름은 상태를 바꾸지 않고 후보를 돌려준다", () => {
    const game = createTestGame(7);
    const res = setTransferList(game, { playerId: "마르티네스", listed: true });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("여러 선수와 맞습니다");
    expect(game.transferList).toHaveLength(0);
  });
});

// ─── 선수 id 짓기 (player-id.test.ts에서 옮겨 왔다 — 이름→식별자 도메인) ───
/**
 * 선수 id에는 **소속 클럽이 없다** — 이적하면 클럽은 바뀌고 id는 그대로다.
 * 클럽을 박아 두면 손흥민이 레알에서 뛰는데 id는 `tottenham-son`이 된다.
 */

describe("id 고르기", () => {
  it("이름만으로 유일하면 이름만 쓴다", () => {
    expect(claimPlayerId("Bukayo Saka", "2001-09-05", new Set())).toBe("bukayo-saka");
  });

  it("동명이인은 태어난 해로 갈린다", () => {
    const taken = new Set<string>();
    expect(claimPlayerId("Vitinha", "2000-02-13", taken)).toBe("vitinha");
    expect(claimPlayerId("Vitinha", "1999-01-15", taken)).toBe("vitinha-1999");
  });

  it("생년까지 같으면 번호가 붙는다", () => {
    const taken = new Set<string>();
    const same = ["a", "b", "c"].map(() => claimPlayerId("Musa Diarra", "2004-06-01", taken));
    expect(same).toEqual(["musa-diarra", "musa-diarra-2004", "musa-diarra-2004-2"]);
  });

  it("로마자가 없는 이름도 id를 받는다 — 빈 id는 없다", () => {
    const id = claimPlayerId("한글만", "2005-03-03", new Set());
    expect(id.length).toBeGreaterThan(0);
  });

  it("고른 id는 집합에 등록된다 — 부르는 쪽이 잊어서 겹치는 일이 없다", () => {
    const taken = new Set<string>();
    claimPlayerId("Bukayo Saka", "2001-09-05", taken);
    expect(taken.has("bukayo-saka")).toBe(true);
  });
});

describe("카탈로그의 id", () => {
  const catalog = playerCatalog();

  it("팀 id가 섞여 들어가지 않는다", () => {
    const tainted = catalog.filter((e) => e.id.startsWith(`${e.teamId}-`));
    expect(tainted.map((e) => e.id)).toEqual([]);
  });

  it("이름에서 나온다 — 접두어 없이 슬러그로 시작한다", () => {
    for (const e of catalog.slice(0, 200)) {
      const slug = slugifyName(e.nameEn);
      if (slug === "") continue;
      expect(e.id.startsWith(slug), `${e.nameEn} → ${e.id}`).toBe(true);
    }
  });

  it("세계 전체에서 유일하다", () => {
    expect(new Set(catalog.map((e) => e.id)).size).toBe(catalog.length);
  });
});

describe("게임 안의 id", () => {
  it("유스가 들어와도 세계의 id는 유일하다", () => {
    const state = createTestGame(5);
    transitionSeason(state);
    expect(new Set(state.players.map((p) => p.id)).size).toBe(state.players.length);
  });

  it("떠난 선수의 id를 신인에게 다시 주지 않는다 — 기록이 합쳐진다", () => {
    const state = createTestGame(5);
    const seen = new Set(state.players.map((p) => p.id));
    transitionSeason(state);
    // 은퇴로 명단에서 빠져도 원장에는 남는다 — 그 id를 다시 쓰면 두 사람이 한 사람이 된다
    const gone = state.transfers.filter((t) => t.type === "retire").map((t) => t.gamePlayerId);
    const newcomers = state.players.filter((p) => !seen.has(p.id)).map((p) => p.id);
    expect(newcomers.filter((id) => gone.includes(id))).toEqual([]);
  });
});
