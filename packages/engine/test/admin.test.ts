import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ageOf, naturalPositionOf } from "@story-fm/domain";
import {
  adminAddCatalogPlayer,
  adminCatalog,
  adminRemoveCatalogPlayer,
  adminResetCatalog,
  adminSetCatalogPositions,
  adminUpdateCatalogPlayer,
  catalogPath,
  isCatalogEdited,
  playerCatalog,
  playersOf,
  CATALOG_AGE_REF,
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

describe("카탈로그 조회", () => {
  it("20팀 · 600명+ · 파생값(나이·OVR·주 포지션)을 함께 준다", () => {
    const teams = adminCatalog();
    expect(teams).toHaveLength(20);
    expect(teams.reduce((s, t) => s + t.players.length, 0)).toBeGreaterThanOrEqual(600);
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
    const res = adminUpdateCatalogPlayer(target.id, { pace: 99, shooting: 99, dribbling: 99 });
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

  it("주 포지션을 바꾸면 목록에 반영되고 OVR 공식도 바뀐다", () => {
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
    expect(after.overall).not.toBe(before); // FW 공식으로 재산정
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

    // 주 포지션이 2개면 반려
    expect(
      adminSetCatalogPositions(target.id, [
        { position: "CM", proficiency: 90, isNatural: true },
        { position: "AM", proficiency: 80, isNatural: true },
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
    const res = adminAddCatalogPlayer("arsenal", {
      nameKo: "김유망",
      nameEn: "Kim Prospect",
      birthdate: "2008-01-01",
      position: "AM",
      pace: 80,
      shooting: 70,
      passing: 78,
      dribbling: 82,
      defending: 40,
      physical: 60,
      goalkeeping: 20,
      potential: 88,
    });
    expect(res.ok).toBe(true);
    expect(playerCatalog().length).toBe(before + 1);
    const added = playerCatalog().find((e) => e.id === res.playerId)!;
    expect(added.nameKo).toBe("김유망");
    expect(added.teamId).toBe("arsenal");
    expect(naturalPositionOf(added).position).toBe("AM");
  });

  it("같은 이름을 두 번 추가해도 id가 충돌하지 않는다", () => {
    const base = {
      nameKo: "동명이인",
      nameEn: "Same Name",
      birthdate: "2004-01-01",
      position: "CB",
      pace: 60,
      shooting: 40,
      passing: 60,
      dribbling: 55,
      defending: 70,
      physical: 72,
      goalkeeping: 18,
      potential: 75,
    };
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
    const res = adminAddCatalogPlayer("arsenal", {
      nameKo: "신규유망주",
      nameEn: "New Prospect",
      birthdate: "2007-05-05",
      position: "ST",
      pace: 85,
      shooting: 80,
      passing: 65,
      dribbling: 82,
      defending: 35,
      physical: 70,
      goalkeeping: 22,
      potential: 92,
    });
    expect(res.ok).toBe(true);
    const game = createTestGame(33);
    const added = playersOf(game, "arsenal").find((p) => p.id === res.playerId);
    expect(added?.name).toBe("신규유망주");
    // 계약도 함께 생성된다 (인스턴스화 경로)
    expect(game.contracts.some((c) => c.gamePlayerId === res.playerId && c.status === "active")).toBe(
      true,
    );
  });
});
