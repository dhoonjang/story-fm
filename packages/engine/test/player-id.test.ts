import { describe, expect, it } from "vitest";
import {
  claimPlayerId,
  playerCatalog,
  playersOf,
  slugifyName,
  transitionSeason,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

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
  it("이적해도 id는 그대로다 — 바뀌는 것은 teamId뿐", () => {
    const state = createTestGame(3);
    const player = playersOf(state, state.userTeamId)[0]!;
    const before = player.id;
    player.teamId = "realmadrid";
    expect(player.id).toBe(before);
    expect(player.id.includes("realmadrid")).toBe(false);
  });

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
