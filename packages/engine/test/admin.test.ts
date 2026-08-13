import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ATTRIBUTE_AXES, ageOf, naturalPositionOf, roleFit } from "@story-fm/domain";
import {
  teamCatalog,
  adminAddCatalogPlayer,
  adminCatalog,
  adminMoveCatalogPlayer,
  adminRemoveCatalogPlayer,
  adminResetCatalog,
  adminSetCatalogPositions,
  adminUpdateCatalogPlayer,
  catalogPath,
  isCatalogEdited,
  playerCatalog,
  playersOf,
  CATALOG_AGE_REF,
  type CatalogPlayerInput,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

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
  delete process.env.STORY_FM_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

/** 어드민 추가 입력 — 15축을 전부 채워야 하므로 기본값 위에 덮어쓴다 */
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
  it("전 클럽 · 3,800명+ · 파생값(나이·OVR·주 포지션)을 함께 준다", () => {
    const teams = adminCatalog();
    expect(teams).toHaveLength(teamCatalog().length);
    expect(teams.reduce((s, t) => s + t.players.length, 0)).toBeGreaterThanOrEqual(3800);
    const row = teams[0]!.players[0]!;
    expect(row.age).toBe(ageOf(row.birthdate, CATALOG_AGE_REF));
    expect(row.overall).toBeGreaterThan(0);
    expect(row.position).toBe(naturalPositionOf(row).position);
    expect(row.goalkeeping).toBeGreaterThan(0); // 전 선수 GK 축
    expect(teams[0]!.teamName).toBeTruthy();
    expect(teams[0]!.tier).toBeGreaterThanOrEqual(1);
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
    // 저장 파일이 생긴다
    expect(catalogPath().endsWith("player-catalog.json")).toBe(true);
    // 재조회(캐시 무효화)에도 편집이 유지된다
    expect(playerCatalog().find((e) => e.id === target.id)?.pace).toBe(99);
  });

  it("주급을 편집하면 새 게임의 계약에 그 값이 실린다", () => {
    const target = adminCatalog().find((t) => t.teamId === "arsenal")!.players[0]!;
    expect(adminUpdateCatalogPlayer(target.id, { weeklyWage: 123_000 }).ok).toBe(true);
    expect(playerCatalog().find((e) => e.id === target.id)?.weeklyWage).toBe(123_000);

    const game = createTestGame(7);
    const contract = game.contracts.find((c) => c.gamePlayerId === target.id);
    expect(contract?.weeklyWage).toBe(123_000);
    // 음수는 반려된다
    expect(adminUpdateCatalogPlayer(target.id, { weeklyWage: -1 }).ok).toBe(false);
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

  it("소속 팀을 옮길 수 있다 — 이동 전후 팀 이름이 메시지에 남는다", () => {
    const target = adminCatalog()
      .find((t) => t.teamId === "arsenal")!
      .players.find((p) => p.position !== "GK")!;
    const res = adminMoveCatalogPlayer(target.id, "chelsea");
    expect(res.ok).toBe(true);
    expect(res.message).toContain("아스날");
    expect(res.message).toContain("첼시");

    expect(playerCatalog().find((e) => e.id === target.id)?.teamId).toBe("chelsea");
    const teams = adminCatalog();
    expect(teams.find((t) => t.teamId === "arsenal")!.players.some((p) => p.id === target.id)).toBe(
      false,
    );
    expect(teams.find((t) => t.teamId === "chelsea")!.players.some((p) => p.id === target.id)).toBe(
      true,
    );
    // 새 게임은 옮긴 팀에서 출발한다
    expect(playersOf(createTestGame(5), "chelsea").some((p) => p.id === target.id)).toBe(true);
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
    expect(adminMoveCatalogPlayer(outfield.find((p) => p.position !== "GK")!.id, "freeagents").ok).toBe(
      false,
    );
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

  it("카탈로그에 추가한 선수는 새 게임의 스쿼드에 들어온다", () => {
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
  });
});
