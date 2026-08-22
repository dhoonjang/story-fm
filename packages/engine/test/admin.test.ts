import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ATTRIBUTE_AXES, ageOf, naturalPositionOf, roleFit } from "@story-fm/domain";
import {
  leagueCatalog,
  teamCatalog,
  teamCatalogById,
  adminAddCatalogPlayer,
  adminAddTeam,
  adminCatalog,
  adminEditCatalogPlayer,
  adminMoveCatalogPlayer,
  adminRemoveCatalogPlayer,
  adminResetCatalog,
  adminResetTeamCatalog,
  adminSetCatalogPositions,
  adminUpdateCatalogPlayer,
  adminUpdateTeam,
  annualRevenueEstimate,
  clubEconomyLevelIn,
  clubProfileIn,
  isCatalogEdited,
  leagueOfTeamIn,
  loadGame,
  monthlyFixedCostOf,
  playerCatalog,
  playersOf,
  saveGame,
  teamNameIn,
  CATALOG_AGE_REF,
  type CatalogPlayerInput,
} from "@story-fm/engine";
import { createTestGame, rebuildEveryFixture } from "./helpers";

// 카탈로그를 고치는 파일 — 편집 뒤에 시작한 게임은 편집을 반영해야 하므로 보관본을 안 쓴다
rebuildEveryFixture();

/**
 * 카탈로그 어드민 — **게임과 무관한 초기치 DB**만 편집한다 (v6).
 * 편집은 데이터 디렉터리의 카탈로그 파일에 저장되고, 새 게임에만 반영된다.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "story-fm-catalog-"));
  process.env.STORY_FM_DATA_DIR = dir;
});
afterEach(() => {
  // 편집 파일을 지우고 시드 상태로 복귀 (다른 테스트에 새지 않게)
  adminResetCatalog();
  adminResetTeamCatalog();
  delete process.env.STORY_FM_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

/** 어드민 추가 입력 — 16축을 전부 채워야 하므로 기본값 위에 덮어쓴다 */
function addInput(
  over: Partial<CatalogPlayerInput> & Pick<CatalogPlayerInput, "nameKo" | "position">,
): CatalogPlayerInput {
  return {
    nameEn: over.nameKo,
    birthdate: "2005-01-01",
    potential: 80,
    ...(Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, 60])) as Record<string, number>),
    ...over,
  } as CatalogPlayerInput;
}

describe("카탈로그 조회", () => {
  it("전 클럽을 빠짐없이 · 나이는 고정 기준일에서 파생한다", () => {
    const teams = adminCatalog();
    expect(teams).toHaveLength(teamCatalog().length);
    const row = teams[0]!.players[0]!;
    expect(row.age).toBe(ageOf(row.birthdate, CATALOG_AGE_REF));
  });

  it("팀 순서가 리그별로 이어져 있다 — 화면은 바뀌는 자리마다 묶기만 하면 된다", () => {
    const seen = new Set<string>();
    let prev = "";
    for (const t of adminCatalog()) {
      if (t.leagueId === prev) continue;
      expect(seen.has(t.leagueId)).toBe(false); // 한 리그가 두 번 끊겼다 나오지 않는다
      seen.add(t.leagueId);
      prev = t.leagueId;
    }
    expect(seen.size).toBe(leagueCatalog().length);
  });

  it("편집 전에는 '편집됨' 플래그가 꺼져 있다", () => {
    expect(isCatalogEdited()).toBe(false);
  });
});

describe("카탈로그 편집", () => {
  it("능력치를 편집하면 파일에 저장되고 OVR 파생이 갱신된다", () => {
    const target = adminCatalog()[0]!.players.find((p) => p.position !== "GK")!;
    const res = adminUpdateCatalogPlayer(target.id, { pace: 99, finishing: 99, dribbling: 99 });
    expect(res.ok).toBe(true);

    const after = adminCatalog()
      .flatMap((t) => t.players)
      .find((p) => p.id === target.id)!;
    expect(after.pace).toBe(99);
    expect(isCatalogEdited()).toBe(true);
    // 재조회(캐시 무효화)에도 편집이 유지된다
    expect(playerCatalog().find((e) => e.id === target.id)?.pace).toBe(99);
  });

  /**
   * 카탈로그의 주급은 **실측이고 없는 것이 기본**이다 (game-state.md §2). 세 뜻이
   * 갈리지 않으면 능력치 하나만 고쳐 저장해도 주급이 0으로 굳고, 그 선수의 새 게임
   * 계약이 £0/주가 된다 — 화면에는 아무 흔적도 남지 않는다.
   */
  it("주급은 미입력·지움·값이 갈리고, 값은 새 게임의 계약에 그대로 실린다", () => {
    const target = adminCatalog().find((t) => t.teamId === "arsenal")!.players[0]!;
    const wageOf = () => playerCatalog().find((e) => e.id === target.id)?.weeklyWage;

    expect(adminUpdateCatalogPlayer(target.id, { weeklyWage: 123_000 }).ok).toBe(true);
    expect(wageOf()).toBe(123_000);
    // 음수는 반려된다
    expect(adminUpdateCatalogPlayer(target.id, { weeklyWage: -1 }).ok).toBe(false);

    // 미입력 — 능력치만 고쳐도 주급은 그대로다
    expect(adminEditCatalogPlayer(target.id, { pace: 71 }).ok).toBe(true);
    expect(wageOf()).toBe(123_000);

    // 0은 "값 없음"이 아니라 진짜 0이다
    expect(adminEditCatalogPlayer(target.id, { weeklyWage: 0 }).ok).toBe(true);
    expect(wageOf()).toBe(0);

    // 값이 있으면 새 게임의 계약이 그 값이고, null로 지우면 다시 모델이 어림한다
    expect(adminEditCatalogPlayer(target.id, { weeklyWage: 90_000 }).ok).toBe(true);
    const seeded = createTestGame(7);
    expect(seeded.contracts.find((c) => c.gamePlayerId === target.id)?.weeklyWage).toBe(90_000);

    expect(adminEditCatalogPlayer(target.id, { weeklyWage: null }).ok).toBe(true);
    expect(wageOf()).toBeUndefined();
    const modelled = createTestGame(9);
    expect(
      modelled.contracts.find((c) => c.gamePlayerId === target.id)!.weeklyWage,
    ).toBeGreaterThan(0);
  });

  /**
   * 이동 → 포지션 → 수치를 나눠 저장하면 뒤가 거절될 때 앞의 절반만 파일에 남고
   * 화면은 갱신되지 않는다. 한 요청은 전부 반영되거나 아무것도 반영되지 않는다.
   */
  it("한 요청 안에서 하나가 반려되면 아무것도 저장되지 않는다", () => {
    const target = adminCatalog().find((t) => t.teamId === "arsenal")!.players[0]!;
    const before = playerCatalog().find((e) => e.id === target.id)!;
    const res = adminEditCatalogPlayer(target.id, {
      teamId: "freeagents",
      pace: 55,
      // 주 포지션이 없는 목록은 반려된다 — 앞의 이동·능력치까지 되돌아가야 한다
      positions: [{ position: "ST", proficiency: 80, isNatural: false }],
    });
    expect(res.ok).toBe(false);

    const after = playerCatalog().find((e) => e.id === target.id)!;
    expect(after.teamId).toBe(before.teamId);
    expect(after.pace).toBe(before.pace);
  });

  it("주 포지션을 바꿔도 종합은 안 떨어진다 — 가장 잘 맞는 자리 기준이라", () => {
    /**
     * 종합은 **그 선수가 가장 잘 맞는 자리에서, 기본 역할로** 낸 값이다.
     * 그래서 센터백에게 최전방을 주 포지션으로 찍어도 종합은 센터백 값을 유지한다 —
     * 자리 표기 하나로 선수의 등급이 흔들리면 이적·라인업 판단이 통째로 어긋난다
     * (시드의 주 포지션 표기는 출처마다 갈린다: EA는 윙어를 LM/RM으로 적는다).
     * 실제로 최전방에 세웠을 때의 값은 `roleFit`이 따로 낸다.
     */
    const df = adminCatalog()
      .flatMap((t) => t.players)
      .find((p) => p.position === "CB" || p.position === "RCB")!;
    const before = df.overall;
    const res = adminUpdateCatalogPlayer(df.id, { position: "ST" });
    expect(res.ok).toBe(true);
    const after = adminCatalog()
      .flatMap((t) => t.players)
      .find((p) => p.id === df.id)!;
    expect(after.position).toBe("ST");
    expect(after.positions.filter((p) => p.isNatural)).toHaveLength(1);
    // 자리를 더해도 최댓값은 내려갈 수 없다
    expect(after.overall).toBeGreaterThanOrEqual(before);
    // 그리고 최전방 값으로 갈아치워지지도 않는다 — 센터백은 최전방이 더 낮다
    expect(roleFit(after, "ST")).toBeLessThan(after.overall);
  });

  it("가능 포지션·적응도를 직접 편집할 수 있다", () => {
    const target = adminCatalog()[0]!.players[2]!;
    const res = adminSetCatalogPositions(target.id, [
      { position: "CM", proficiency: 92, isNatural: true },
      { position: "AM", proficiency: 78, isNatural: false },
    ]);
    expect(res.ok).toBe(true);
    const after = playerCatalog().find((e) => e.id === target.id)!;
    expect(after.positions).toHaveLength(2);
    expect(naturalPositionOf(after).position).toBe("CM");

    // 주 포지션은 **여럿일 수 있다** — 두 자리를 다 자기 자리로 삼는 선수가 있다
    expect(
      adminSetCatalogPositions(target.id, [
        { position: "CM", proficiency: 90, isNatural: true },
        { position: "AM", proficiency: 80, isNatural: true },
      ]).ok,
    ).toBe(true);
    const both = playerCatalog().find((e) => e.id === target.id)!;
    expect(both.positions.filter((p) => p.isNatural)).toHaveLength(2);
    // 대표 자리는 적응도가 높은 쪽 (화면 한 칸·포지션군이 쓴다)
    expect(naturalPositionOf(both).position).toBe("CM");
    // 주 포지션이 하나도 없으면 반려 — 대표 자리를 못 정한다
    expect(
      adminSetCatalogPositions(target.id, [
        { position: "CM", proficiency: 90, isNatural: false },
        { position: "AM", proficiency: 80, isNatural: false },
      ]).ok,
    ).toBe(false);
  });

  it("잘못된 값은 반려된다 (없는 선수·포지션·출생년월일)", () => {
    expect(adminUpdateCatalogPlayer("ghost", { pace: 80 }).ok).toBe(false);
    const p = adminCatalog()[0]!.players[0]!;
    expect(adminUpdateCatalogPlayer(p.id, { position: "XX" }).ok).toBe(false);
    expect(adminUpdateCatalogPlayer(p.id, { birthdate: "not-a-date" }).ok).toBe(false);
  });

  it("새 선수를 추가하면 카탈로그가 늘어난다", () => {
    const before = playerCatalog().length;
    const res = adminAddCatalogPlayer(
      "arsenal",
      addInput({
        nameKo: "김유망",
        nameEn: "Kim Prospect",
        birthdate: "2008-01-01",
        position: "AM",
        pace: 80,
        finishing: 70,
        passing: 78,
        dribbling: 82,
        tackling: 40,
        strength: 60,
        goalkeeping: 20,
        potential: 88,
      }),
    );
    expect(res.ok).toBe(true);
    expect(playerCatalog().length).toBe(before + 1);
    const added = playerCatalog().find((e) => e.id === res.playerId)!;
    expect(added.nameKo).toBe("김유망");
    expect(added.teamId).toBe("arsenal");
    expect(naturalPositionOf(added).position).toBe("AM");
  });

  it("같은 이름을 두 번 추가해도 id가 충돌하지 않는다", () => {
    const base: CatalogPlayerInput = addInput({
      nameKo: "동명이인",
      nameEn: "Same Name",
      birthdate: "2004-01-01",
      position: "CB",
      pace: 60,
      finishing: 40,
      passing: 60,
      dribbling: 55,
      tackling: 70,
      strength: 72,
      goalkeeping: 18,
      potential: 75,
    });
    const a = adminAddCatalogPlayer("arsenal", base);
    const b = adminAddCatalogPlayer("arsenal", base);
    expect(a.playerId).not.toBe(b.playerId);
  });

  it("삭제는 팀 최소 인원·GK 2명을 지킨다", () => {
    const arsenal = adminCatalog().find((t) => t.teamId === "arsenal")!;
    const outfield = arsenal.players.find((p) => p.position !== "GK")!;
    const before = playerCatalog().length;
    expect(adminRemoveCatalogPlayer(outfield.id).ok).toBe(true);
    expect(playerCatalog().length).toBe(before - 1);

    // GK를 2명까지 줄이면 더는 못 지운다
    const gks = adminCatalog()
      .find((t) => t.teamId === "arsenal")!
      .players.filter((p) => p.position === "GK");
    for (const gk of gks.slice(0, Math.max(0, gks.length - 2))) {
      expect(adminRemoveCatalogPlayer(gk.id).ok).toBe(true);
    }
    const left = adminCatalog()
      .find((t) => t.teamId === "arsenal")!
      .players.filter((p) => p.position === "GK");
    expect(left.length).toBe(2);
    expect(adminRemoveCatalogPlayer(left[0]!.id).ok).toBe(false);

    expect(adminRemoveCatalogPlayer("ghost").ok).toBe(false);
  });

  it("소속 팀을 옮길 수 있다", () => {
    const target = adminCatalog()
      .find((t) => t.teamId === "arsenal")!
      .players.find((p) => p.position !== "GK")!;
    const res = adminMoveCatalogPlayer(target.id, "chelsea");
    expect(res.ok).toBe(true);

    expect(playerCatalog().find((e) => e.id === target.id)?.teamId).toBe("chelsea");
    const teams = adminCatalog();
    expect(teams.find((t) => t.teamId === "arsenal")!.players.some((p) => p.id === target.id)).toBe(
      false,
    );
    expect(teams.find((t) => t.teamId === "chelsea")!.players.some((p) => p.id === target.id)).toBe(
      true,
    );
  });

  it("없는 팀·없는 선수·같은 팀으로의 이동은 반려된다 (카탈로그는 그대로)", () => {
    const target = adminCatalog().find((t) => t.teamId === "arsenal")!.players[0]!;
    expect(adminMoveCatalogPlayer(target.id, "notateam").ok).toBe(false);
    expect(adminMoveCatalogPlayer("ghost", "chelsea").ok).toBe(false);
    // 이미 그 팀이면 반려한다 — 아무것도 안 바뀌는 저장으로 '편집됨'을 켜지 않는다
    expect(adminMoveCatalogPlayer(target.id, "arsenal").ok).toBe(false);
    expect(isCatalogEdited()).toBe(false);
  });

  it("방출은 무소속으로 옮기는 것이고, 무소속에서 다시 클럽으로 돌아올 수 있다", () => {
    const target = adminCatalog()
      .find((t) => t.teamId === "arsenal")!
      .players.find((p) => p.position !== "GK")!;
    expect(adminMoveCatalogPlayer(target.id, "freeagents").ok).toBe(true);
    expect(playerCatalog().find((e) => e.id === target.id)?.teamId).toBe("freeagents");

    // 무소속은 클럽이 아니다 — 팀 최소 인원 하한이 나가는 길을 막지 않는다
    const back = adminMoveCatalogPlayer(target.id, "brighton");
    expect(back.ok).toBe(true);
    expect(playerCatalog().find((e) => e.id === target.id)?.teamId).toBe("brighton");
  });

  it("이동도 삭제와 같은 하한을 지킨다 — 팀 최소 인원·GK 2명", () => {
    const arsenal = adminCatalog().find((t) => t.teamId === "arsenal")!;
    const gks = arsenal.players.filter((p) => p.position === "GK");
    // GK를 2명까지 줄이면 더는 못 내보낸다
    for (const gk of gks.slice(0, Math.max(0, gks.length - 2))) {
      expect(adminMoveCatalogPlayer(gk.id, "freeagents").ok).toBe(true);
    }
    const left = adminCatalog()
      .find((t) => t.teamId === "arsenal")!
      .players.filter((p) => p.position === "GK");
    expect(left).toHaveLength(2);
    expect(adminMoveCatalogPlayer(left[0]!.id, "freeagents").ok).toBe(false);

    // 명단이 최소 인원까지 얇아지면 필드 플레이어도 못 나간다
    let outfield = adminCatalog()
      .find((t) => t.teamId === "arsenal")!
      .players.filter((p) => p.position !== "GK");
    for (const p of outfield) {
      const res = adminMoveCatalogPlayer(p.id, "freeagents");
      if (!res.ok) break;
    }
    outfield = adminCatalog().find((t) => t.teamId === "arsenal")!.players;
    expect(outfield).toHaveLength(14);
    expect(
      adminMoveCatalogPlayer(outfield.find((p) => p.position !== "GK")!.id, "freeagents").ok,
    ).toBe(false);
  });

  it("시드 기본값으로 되돌릴 수 있다", () => {
    const p = adminCatalog()[0]!.players[0]!;
    adminUpdateCatalogPlayer(p.id, { pace: 12 });
    expect(isCatalogEdited()).toBe(true);
    const res = adminResetCatalog();
    expect(res.ok).toBe(true);
    expect(isCatalogEdited()).toBe(false);
    expect(playerCatalog().find((e) => e.id === p.id)?.pace).not.toBe(12);
  });
});

describe("게임 격리 — 카탈로그 편집은 새 게임에만 반영된다", () => {
  it("진행 중인 게임은 편집에 영향받지 않고, 새 게임은 편집을 반영한다", () => {
    // ① 편집 전에 시작한 게임
    const before = createTestGame(31);
    const target = playersOf(before, "arsenal")[0]!;
    const originalPace = target.attributes.pace;

    // ② 카탈로그에서 같은 선수의 pace를 크게 바꾼다
    const res = adminUpdateCatalogPlayer(target.id, { pace: 11 });
    expect(res.ok).toBe(true);

    // ③ 진행 중인 게임은 그대로 (인스턴스화된 복사본이므로)
    expect(target.attributes.pace).toBe(originalPace);
    expect(playersOf(before, "arsenal")[0]!.attributes.pace).toBe(originalPace);

    // ④ 새로 시작한 게임은 편집된 값으로 출발
    const after = createTestGame(31);
    const same = playersOf(after, "arsenal").find((p) => p.id === target.id)!;
    expect(same.attributes.pace).toBe(11);
  });

  it("추가·이동한 선수가 새 게임의 스쿼드에 그 팀 소속으로 들어온다", () => {
    const moved = adminCatalog()
      .find((t) => t.teamId === "arsenal")!
      .players.find((p) => p.position !== "GK")!;
    expect(adminMoveCatalogPlayer(moved.id, "chelsea").ok).toBe(true);

    const res = adminAddCatalogPlayer(
      "arsenal",
      addInput({
        nameKo: "신규유망주",
        nameEn: "New Prospect",
        birthdate: "2007-05-05",
        position: "ST",
        pace: 85,
        finishing: 80,
        passing: 65,
        dribbling: 82,
        tackling: 35,
        strength: 70,
        goalkeeping: 22,
        potential: 92,
      }),
    );
    expect(res.ok).toBe(true);
    const game = createTestGame(33);
    const added = playersOf(game, "arsenal").find((p) => p.id === res.playerId);
    expect(added?.name).toBe("신규유망주");
    // 계약도 함께 생성된다 (인스턴스화 경로)
    expect(
      game.contracts.some((c) => c.gamePlayerId === res.playerId && c.status === "active"),
    ).toBe(true);
    // 옮긴 선수는 새 소속에서 출발한다
    expect(playersOf(game, "chelsea").some((p) => p.id === moved.id)).toBe(true);
    expect(playersOf(game, "arsenal").some((p) => p.id === moved.id)).toBe(false);
  });
});

/**
 * 어드민 편집은 **새 게임에만** 반영된다 — 그것이 2-레이어의 약속이다
 * (game-state.md §1). 체급은 이미 세이브가 갖고 있었고(admin-catalog.test.ts),
 * 여기서는 나머지 축을 본다: 이름·소속 리그·구장·브랜드.
 *
 * 화면 문구가 아니라 **장부의 숫자**까지 따라오는지가 요점이다. 수용인원과 브랜드는
 * 매치데이·상업 수입의 입력이라, 카탈로그를 읽는 자리가 하나만 남아도 감독은
 * 자기가 한 일이 아닌 이유로 매출이 달라진다.
 */
describe("팀 정체성 편집과 진행 중인 세이브", () => {
  it("이름·구장·브랜드·소속 리그를 고쳐도 세이브의 값이 그대로다", () => {
    const state = createTestGame(51, "arsenal");
    const name = teamNameIn(state, "arsenal");
    const profile = clubProfileIn(state, "arsenal");
    const revenue = annualRevenueEstimate(state, "arsenal");
    const fixedCost = monthlyFixedCostOf("arsenal", state);

    const res = adminUpdateTeam("arsenal", {
      name: "북런던 FC",
      shortName: "NLD",
      capacity: 1_000,
      commercialTier: 4,
    });
    expect(res.ok).toBe(true);
    // 편집은 카탈로그에 확실히 닿았다 — 그런데도 세이브는 흔들리지 않는다
    expect(teamCatalogById("arsenal")!.name).toBe("북런던 FC");

    expect(teamNameIn(state, "arsenal")).toBe(name);
    expect(clubProfileIn(state, "arsenal")).toEqual(profile);
    expect(annualRevenueEstimate(state, "arsenal")).toBe(revenue);
    expect(monthlyFixedCostOf("arsenal", state)).toBe(fixedCost);

    /**
     * 소속 리그도 같은 약속이다. 1부는 팀 수가 짝수여야 해서 한 팀만 옮길 수 없으니
     * 리그 이동이 실제로 열리는 자리는 리그전을 돌지 않는 2부끼리다 (`admin-team.ts`).
     * 소속이 바뀌면 그 나라 1부에서 파생하는 살림도 함께 움직이므로 둘 다 본다.
     */
    const league = leagueOfTeamIn(state, "wolves");
    const economy = clubEconomyLevelIn(state, "wolves");
    expect(league).toBe("championship");

    expect(adminUpdateTeam("wolves", { leagueId: "segunda" }).ok).toBe(true);
    expect(teamCatalogById("wolves")!.leagueId).toBe("segunda");

    expect(leagueOfTeamIn(state, "wolves")).toBe(league);
    expect(clubEconomyLevelIn(state, "wolves")).toBe(economy);
  });

  it("정체성이 없는 옛 세이브는 그대로 로드되고 카탈로그로 폴백한다", () => {
    const state = createTestGame(52, "arsenal");
    // 옛 세이브 — GAME_TEAM에 복사본이 없다 (SAVE_VERSION은 그대로)
    for (const team of state.teams) {
      delete team.name;
      delete team.shortName;
      delete team.leagueId;
      delete team.stadium;
      delete team.capacity;
      delete team.commercialTier;
    }
    saveGame(state);

    const loaded = loadGame(state.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.teams.every((t) => t.name === undefined)).toBe(true);
    expect(teamNameIn(loaded!, "arsenal")).toBe(teamCatalogById("arsenal")!.name);
    expect(leagueOfTeamIn(loaded!, "arsenal")).toBe(teamCatalogById("arsenal")!.leagueId);
  });

  /**
   * 로드가 세이브에 없는 클럽을 채워 넣는 자리(`addMissingClubs`)는 **시드 카탈로그**만
   * 본다. 지금 유효한 카탈로그(=오버라이드)를 읽으면 어드민이 팀 하나를 추가할 때마다
   * 열려 있는 **모든 옛 세이브**에 그 클럽과 스쿼드가 주입된다.
   */
  it("어드민이 더한 팀은 이미 열려 있는 세이브에 들어가지 않는다", () => {
    const state = createTestGame(53, "arsenal");
    const before = state.teams.length;
    saveGame(state);

    // 2부는 리그전을 돌지 않아 팀 수 짝수 제약이 없다 (컵 32팀은 경고일 뿐)
    const res = adminAddTeam({
      id: "wrexham",
      name: "렉섬",
      shortName: "WRX",
      leagueId: "championship",
      tier: 4,
    });
    expect(res.ok).toBe(true);
    expect(teamCatalogById("wrexham")).not.toBeNull();

    const loaded = loadGame(state.id)!;
    expect(loaded.teams).toHaveLength(before);
    expect(loaded.teams.some((t) => t.id === "wrexham")).toBe(false);
    expect(loaded.players.some((p) => p.teamId === "wrexham")).toBe(false);
  });
});
