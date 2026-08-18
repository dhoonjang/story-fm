import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  adminAddLeague,
  adminAddTeam,
  adminRemoveCatalogPlayer,
  adminRemoveLeague,
  adminRemoveTeam,
  adminResetCupCatalog,
  adminResetLeagueCatalog,
  adminResetTeamCatalog,
  adminTeamCatalog,
  adminUpdateCup,
  adminUpdateDomesticCup,
  adminUpdateLeague,
  adminUpdateTeam,
  boardExpectation,
  boardExpectationOfTier,
  catalogPath,
  catalogTierOf,
  checkEuroCupInvariants,
  checkLeagueInvariants,
  clubProfile,
  cupCatalog,
  cupCatalogPath,
  domesticCupCatalog,
  isCupCatalogEdited,
  isLeagueCatalogEdited,
  leagueSizeIn,
  isTeamCatalogEdited,
  leagueCatalog,
  leagueCatalogPath,
  loadGame,
  playerCatalog,
  saveGame,
  tacticalStyleOf,
  teamCatalog,
  teamCatalogPath,
  teamsOfLeague,
  tierOfTeamIn,
  type AdminCupPatch,
  type AdminDomesticCupPatch,
  type AdminLeaguePatch,
  type LeagueCatalogEntry,
} from "@story-fm/engine";
import { createTestGame, rebuildEveryFixture } from "./helpers";

// 카탈로그를 고치는 파일 — 편집 뒤에 시작한 게임은 편집을 반영해야 하므로 보관본을 안 쓴다
rebuildEveryFixture();

/**
 * 팀·리그·컵 카탈로그 어드민 — **게임과 무관한 초기치 DB**를 편집한다 (v6).
 * 편집은 데이터 디렉터리의 오버라이드 파일에 저장되고 새 게임에만 반영된다.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "story-fm-catalog-admin-"));
  process.env.STORY_FM_DATA_DIR = dir;
});
afterEach(() => {
  // 편집 파일을 지우고 시드 상태로 복귀 (다른 테스트에 새지 않게)
  adminResetTeamCatalog();
  adminResetLeagueCatalog();
  adminResetCupCatalog();
  delete process.env.STORY_FM_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("카탈로그 조회", () => {
  it("편집 전에는 세 '편집됨' 플래그가 전부 꺼져 있다", () => {
    expect(isTeamCatalogEdited()).toBe(false);
    expect(isLeagueCatalogEdited()).toBe(false);
    expect(isCupCatalogEdited()).toBe(false);
  });
});

describe("팀 편집", () => {
  it("정체성·전술 성향·구단 프로필을 한 번에 저장한다", () => {
    const res = adminUpdateTeam("brentford", {
      name: "브렌트포드 FC",
      tier: 3,
      formation: "3-5-2",
      tacticalStyle: "low-block",
      stadium: "새 구장",
      capacity: 25_000,
      commercialTier: 3,
    });
    expect(res.ok).toBe(true);
    expect(existsSync(teamCatalogPath())).toBe(true);

    const row = adminTeamCatalog().find((t) => t.id === "brentford")!;
    expect(row.name).toBe("브렌트포드 FC");
    expect(row.tier).toBe(3);
    expect(row.formation).toBe("3-5-2");
    expect(tacticalStyleOf("brentford")).toBe("low-block");
    expect(clubProfile("brentford", 3)).toEqual({
      stadium: "새 구장",
      capacity: 25_000,
      commercialTier: 3,
    });
    expect(isTeamCatalogEdited()).toBe(true);
  });

  it("편집이 새 게임의 초기치가 된다 (진행 중 세이브와 무관)", () => {
    adminUpdateTeam("brentford", { name: "브렌트포드 FC", tacticalStyle: "possession" });
    const state = createTestGame(7, "brentford");
    expect(state.teams.some((t) => t.id === "brentford")).toBe(true);
    expect(adminTeamCatalog().find((t) => t.id === "brentford")!.name).toBe("브렌트포드 FC");
  });

  it("리그를 옮기면 양쪽 리그 팀 수가 홀수가 되어 막힌다", () => {
    const res = adminUpdateTeam("brentford", { leagueId: "laliga" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("홀수");
    expect(existsSync(teamCatalogPath())).toBe(false);
  });

  it("2부끼리 옮기는 편집은 리그전이 없으므로 통과한다", () => {
    const before = teamsOfLeague("championship").length;
    const res = adminUpdateTeam("wolves", { leagueId: "segunda" });
    expect(res.ok).toBe(true);
    expect(teamsOfLeague("championship")).toHaveLength(before - 1);
    // 나라별 컵 인원이 32에서 어긋나면 경고로 알린다 (막지는 않는다)
    expect(res.message).toContain("FA컵");
  });

  it("없는 리그를 가리키면 막힌다", () => {
    const res = adminUpdateTeam("arsenal", { leagueId: "kleague" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("카탈로그에 없는 리그");
  });

  it("잘못된 값은 한국어 메시지로 거절한다", () => {
    expect(adminUpdateTeam("arsenal", { name: "  " }).message).toContain("이름");
    expect(adminUpdateTeam("arsenal", { capacity: 0 }).message).toContain("수용인원");
    expect(adminUpdateTeam("없는팀", { tier: 1 }).message).toContain("카탈로그에 없는 팀");
  });
});

/**
 * 체급은 **세이브가 갖는다** (team.md §2). 카탈로그의 값은 게임 시작의 초기치일
 * 뿐이라, 어드민이 그것을 고쳐도 진행 중인 세이브의 보드 기대치와 경질 위험선은
 * 움직이지 않는다 — 감독은 자기가 한 일이 아닌 이유로 자리가 흔들리지 않는다.
 */
describe("체급 편집과 진행 중인 세이브", () => {
  it("카탈로그의 체급을 고쳐도 세이브의 보드 기대치가 그대로다", () => {
    const state = createTestGame(7, "arsenal");
    const before = tierOfTeamIn(state, state.userTeamId);
    const expected = boardExpectation(state, state.userTeamId);

    const res = adminUpdateTeam("arsenal", { tier: 4 });
    expect(res.ok).toBe(true);
    // 편집은 카탈로그에 확실히 닿았다 — 그런데도 세이브는 흔들리지 않는다
    expect(catalogTierOf("arsenal")).toBe(4);

    expect(tierOfTeamIn(state, state.userTeamId)).toBe(before);
    expect(boardExpectation(state, state.userTeamId)).toEqual(expected);
    /**
     * 경질 위험선(`manager-market.ts`의 SEAT)도 같은 값 하나에서 나온다 —
     * 그 표는 모듈 밖으로 나오지 않으므로 입력인 체급으로 확인한다.
     */
    expect(tierOfTeamIn(state, state.userTeamId)).not.toBe(catalogTierOf("arsenal"));
  });

  it("체급이 없는 옛 세이브는 그대로 로드되고 카탈로그로 폴백한다", () => {
    const state = createTestGame(7, "arsenal");
    // 옛 세이브 — GAME_TEAM에 체급이 없다 (SAVE_VERSION은 그대로)
    for (const team of state.teams) delete team.tier;
    saveGame(state);

    const loaded = loadGame(state.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.teams.every((t) => t.tier === undefined)).toBe(true);
    expect(tierOfTeamIn(loaded!, "arsenal")).toBe(catalogTierOf("arsenal"));
    expect(boardExpectation(loaded!, "arsenal")).toEqual(
      boardExpectationOfTier(catalogTierOf("arsenal"), leagueSizeIn(loaded!, "arsenal")),
    );
  });
});

describe("팀 추가·삭제", () => {
  it("2부에 팀을 더하면 스쿼드가 절차 생성으로 따라온다", () => {
    const res = adminAddTeam({
      id: "wrexham",
      name: "렉섬",
      shortName: "WRX",
      leagueId: "championship",
      tier: 4,
      tacticalStyle: "direct",
      stadium: "레이스코스 그라운드",
      capacity: 13_000,
      commercialTier: 4,
    });
    expect(res.ok).toBe(true);
    const row = adminTeamCatalog().find((t) => t.id === "wrexham")!;
    expect(row.squadSize).toBeGreaterThan(14);
    expect(playerCatalog().some((p) => p.teamId === "wrexham")).toBe(true);
  });

  it("1부에 한 팀만 더하면 홀수가 되어 막힌다", () => {
    const res = adminAddTeam({
      id: "newclub",
      name: "새 클럽",
      shortName: "NEW",
      leagueId: "epl",
      tier: 4,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("홀수");
  });

  it("id 규칙과 중복을 지킨다", () => {
    const base = { name: "새 클럽", shortName: "NEW", leagueId: "championship", tier: 4 } as const;
    expect(adminAddTeam({ ...base, id: "New Club" }).message).toContain("영소문자");
    expect(adminAddTeam({ ...base, id: "arsenal" }).message).toContain("이미 있는");
  });

  it("1부 팀을 지우면 홀수가 되어 막히고, 2부 팀은 지워진다", () => {
    expect(adminRemoveTeam("arsenal").ok).toBe(false);
    const res = adminRemoveTeam("wolves");
    expect(res.ok).toBe(true);
    expect(teamCatalog().some((t) => t.id === "wolves")).toBe(false);
  });

  it("팀을 지우면 편집된 선수 카탈로그에서도 그 팀 선수가 빠진다", () => {
    // 선수 카탈로그 편집본을 만들어 둔다 (파일이 있어야 동기화 대상이 된다)
    adminAddTeam({
      id: "wrexham",
      name: "렉섬",
      shortName: "WRX",
      leagueId: "championship",
      tier: 4,
    });
    expect(adminRemoveTeam("wrexham").ok).toBe(true);
    expect(playerCatalog().some((p) => p.teamId === "wrexham")).toBe(false);
  });

  it("리셋은 전술 성향·구단 프로필까지 되돌린다", () => {
    adminUpdateTeam("brentford", { name: "바뀐 이름", tacticalStyle: "low-block" });
    expect(adminResetTeamCatalog().ok).toBe(true);
    expect(existsSync(teamCatalogPath())).toBe(false);
    expect(adminTeamCatalog().find((t) => t.id === "brentford")!.name).toBe("브렌트포드");
    expect(tacticalStyleOf("brentford")).toBe("direct");
    expect(isTeamCatalogEdited()).toBe(false);
  });
});

describe("리그 편집", () => {
  it("구조 필드까지 편집되고 파생 조회에 반영된다", () => {
    const res = adminUpdateLeague("epl", { name: "잉글랜드 1부", broadcastPool: 0.9 });
    expect(res.ok).toBe(true);
    expect(existsSync(leagueCatalogPath())).toBe(true);
    expect(leagueCatalog().find((l) => l.id === "epl")!.name).toBe("잉글랜드 1부");
    expect(isLeagueCatalogEdited()).toBe(true);
  });

  it("2부를 리그전 리그로 바꾸면 팀 수가 짝수인지 따진다", () => {
    // 챔피언십은 12팀이라 리그전을 돌 수 있다 — 세리에 B는 홀수라 막힌다
    expect(adminUpdateLeague("championship", { kind: "playable" }).ok).toBe(true);
    adminResetLeagueCatalog();
    adminUpdateTeam("wolves", { leagueId: "serieb" });
    const res = adminUpdateLeague("serieb", { kind: "playable" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("홀수");
  });

  it("팀이 남은 리그는 지울 수 없다", () => {
    const res = adminRemoveLeague("epl");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("20팀");
  });

  it("리그를 더하고 지운다", () => {
    const entry: LeagueCatalogEntry = {
      id: "kleague",
      name: "K리그1",
      country: "대한민국",
      kind: "market-only",
      coefficient: 30,
      realSquads: false,
      broadcastPool: 0.05,
      avgTicketPrice: 12,
    };
    expect(adminAddLeague(entry).ok).toBe(true);
    expect(leagueCatalog().some((l) => l.id === "kleague")).toBe(true);
    expect(adminAddLeague(entry).message).toContain("이미 있는");
    expect(adminRemoveLeague("kleague").ok).toBe(true);
    expect(leagueCatalog().some((l) => l.id === "kleague")).toBe(false);
  });

  /**
   * 패치는 어드민이 보낸 **런타임 JSON**이다 — 타입이 `Omit<…, "id">`라고 해서
   * 그 모양으로 온다는 보장이 없다. 그대로 얹으면 id가 옮겨가거나 숫자 자리에
   * 문자열이 앉은 파일이 저장되고, 그 파일은 다음 로드에서 통째로 시드로 폴백해
   * 편집이 조용히 사라진다.
   */
  it("패치가 id를 옮기거나 숫자 자리에 문자열을 앉히면 거절한다", () => {
    const moved = { id: "epl2", name: "다른 리그" } as unknown as AdminLeaguePatch;
    expect(adminUpdateLeague("epl", moved).ok).toBe(false);
    const notNumber = { coefficient: "1" } as unknown as AdminLeaguePatch;
    expect(adminUpdateLeague("epl", notNumber).message).toContain("계수");
    expect(existsSync(leagueCatalogPath())).toBe(false);

    // 모르는 키는 저장 파일에 들어가지 않는다
    const extra = { name: "잉글랜드 1부", nope: 1 } as unknown as AdminLeaguePatch;
    expect(adminUpdateLeague("epl", extra).ok).toBe(true);
    expect(leagueCatalog().find((l) => l.id === "epl")).not.toHaveProperty("nope");
  });

  it("리셋이 시드로 되돌린다", () => {
    adminUpdateLeague("epl", { name: "바뀐 이름" });
    expect(adminResetLeagueCatalog().ok).toBe(true);
    expect(existsSync(leagueCatalogPath())).toBe(false);
    expect(leagueCatalog().find((l) => l.id === "epl")!.name).toBe("프리미어리그");
  });
});

describe("컵 편집", () => {
  it("상금·이름을 편집하면 저장된다", () => {
    const res = adminUpdateCup("uecl", { name: "UEFA 컨퍼런스", short: "UECL2" });
    expect(res.ok).toBe(true);
    expect(existsSync(cupCatalogPath())).toBe(true);
    expect(cupCatalog().find((c) => c.id === "uecl")!.short).toBe("UECL2");
    expect(isCupCatalogEdited()).toBe(true);
  });

  it("규모를 바꾸면 티켓 합·브래킷을 함께 확인한다", () => {
    expect(adminUpdateCup("ucl", { size: 25 }).message).toContain("짝수");
    expect(adminUpdateCup("ucl", { size: 26 }).message).toContain("티켓 합");
    expect(adminUpdateCup("ucl", { directSlots: 7 }).message).toContain("2의 거듭제곱");
    expect(adminUpdateCup("ucl", { slots: { epl: 24, nowhere: 0 } }).message).toContain(
      "카탈로그에 없는 리그",
    );
  });

  it("규모를 앞뒤 맞게 바꾸면 통과한다", () => {
    const res = adminUpdateCup("uecl", {
      size: 12,
      slots: { epl: 3, laliga: 3, seriea: 2, bundesliga: 2, ligue1: 2 },
      directSlots: 4,
      playoffSlots: 8,
    });
    expect(res.ok).toBe(true);
    expect(cupCatalog().find((c) => c.id === "uecl")!.size).toBe(12);
  });

  /**
   * `windows`가 라운드 하나를 빠뜨리면 저장은 통과하고 **시즌 중에** 터진다 —
   * `stageTarget`이 그 라운드를 편성할 때 목표일을 찾지 못한다 (competition.md §7).
   */
  it("국내 컵 목표일은 치르는 다섯 라운드를 다 가져야 한다", () => {
    const half = { windows: { r32: [1, 10], r16: [2, 7] } } as unknown as AdminDomesticCupPatch;
    const res = adminUpdateDomesticCup("facup", half);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("qf");

    // 시드가 함께 갖는 league·playoff 키는 남아 있어도 거절하지 않는다
    const full = {
      windows: {
        league: [1, 10],
        playoff: [1, 10],
        r32: [1, 10],
        r16: [2, 7],
        qf: [3, 21],
        sf: [4, 25],
        final: [5, 16],
      },
    } as unknown as AdminDomesticCupPatch;
    expect(adminUpdateDomesticCup("facup", full).ok).toBe(true);
  });

  it("컵 패치도 id를 옮기지 못한다", () => {
    const moved = { id: "ucl2" } as unknown as AdminCupPatch;
    expect(adminUpdateCup("ucl", moved).ok).toBe(false);
    const domestic = { id: "facup2" } as unknown as AdminDomesticCupPatch;
    expect(adminUpdateDomesticCup("facup", domestic).ok).toBe(false);
    expect(existsSync(cupCatalogPath())).toBe(false);
  });

  it("국내 컵도 같은 파일에서 편집·리셋된다", () => {
    expect(adminUpdateDomesticCup("facup", { name: "잉글랜드 FA컵" }).ok).toBe(true);
    expect(domesticCupCatalog().find((c) => c.id === "facup")!.name).toBe("잉글랜드 FA컵");
    // 유럽 대항전 편집과 한 파일을 쓰므로 서로를 지우지 않는다
    expect(adminUpdateCup("uecl", { short: "UECL2" }).ok).toBe(true);
    expect(domesticCupCatalog().find((c) => c.id === "facup")!.name).toBe("잉글랜드 FA컵");

    expect(adminResetCupCatalog().ok).toBe(true);
    expect(existsSync(cupCatalogPath())).toBe(false);
    expect(domesticCupCatalog().find((c) => c.id === "facup")!.name).toBe("FA컵");
    expect(isCupCatalogEdited()).toBe(false);
  });
});

describe("불변식 (순수 함수)", () => {
  const league = (over: Partial<LeagueCatalogEntry>): LeagueCatalogEntry => ({
    id: "x",
    name: "리그",
    country: "나라",
    kind: "playable",
    coefficient: 1,
    realSquads: false,
    broadcastPool: 1,
    avgTicketPrice: 10,
    ...over,
  });
  const team = (id: string, leagueId: string) => ({
    id,
    name: id,
    shortName: id.toUpperCase(),
    leagueId,
    tier: 4 as const,
  });

  it("리그전 리그는 2팀 이상 · 짝수 · 20팀 이하", () => {
    const l = [league({ id: "a" })];
    expect(checkLeagueInvariants(l, [team("t1", "a")])[0]).toContain("2팀 이상");
    expect(
      checkLeagueInvariants(l, [team("t1", "a"), team("t2", "a"), team("t3", "a")])[0],
    ).toContain("홀수");
    const many = Array.from({ length: 22 }, (_, i) => team(`t${i}`, "a"));
    expect(checkLeagueInvariants(l, many)[0]).toContain("38라운드");
    expect(checkLeagueInvariants(l, [team("t1", "a"), team("t2", "a")])).toEqual([]);
  });

  it("리그전이 없는 리그는 팀 수를 따지지 않는다", () => {
    const l = [league({ id: "a", kind: "cup-only" })];
    expect(checkLeagueInvariants(l, [team("t1", "a")])).toEqual([]);
  });

  /**
   * 팀 id 중복은 크래시가 아니라 **소실**이라 조용하다 — `teamCatalogById`가 하나만
   * 답해 나머지 동명 클럽이 스쿼드·일정·순위표에서 통째로 사라진다 (team.md §8).
   */
  it("팀 id는 카탈로그 안에서 유일하다", () => {
    const l = [league({ id: "a", kind: "cup-only" })];
    expect(checkLeagueInvariants(l, [team("t1", "a"), team("t1", "a")]).join()).toContain(
      "팀 id가 중복",
    );
  });

  it("대항전은 브래킷·티켓 합·리그 참조를 함께 본다", () => {
    const leagues = [league({ id: "epl" })];
    const base = {
      id: "c",
      name: "컵",
      short: "C",
      size: 8,
      matchesPerTeam: 4,
      slots: { epl: 8 },
      directSlots: 2,
      playoffSlots: 4,
      prize: { participation: 0, win: 0, draw: 0, stage: {}, winner: 0 },
    };
    expect(checkEuroCupInvariants([base], leagues)).toEqual([]);
    expect(checkEuroCupInvariants([{ ...base, playoffSlots: 3 }], leagues).join()).toContain(
      "짝수",
    );
    expect(checkEuroCupInvariants([{ ...base, matchesPerTeam: 10 }], leagues).join()).toContain(
      "상대가 모자랍니다",
    );
    expect(
      checkEuroCupInvariants([{ ...base, directSlots: 6, playoffSlots: 6 }], leagues).join(),
    ).toContain("참가 팀");
  });

  /**
   * 본선 첫 단계는 직행 팀 하나에 플레이오프 승자 하나를 붙인다(`mainDrawPairs`).
   * 합만 보면 통과하는 조합이 있다 — 직행 6 + 플레이오프 4는 브래킷 8로 2의
   * 거듭제곱이지만, 승자는 둘뿐이라 직행 넷이 상대 없이 남는다. 그러면 결승이
   * 만들어지지 않아 **시즌이 끝나지 않는다.**
   */
  it("플레이오프가 있으면 직행 팀이 승자와 일대일로 맞아야 한다", () => {
    const leagues = [league({ id: "epl" })];
    const lopsided = {
      id: "c",
      name: "컵",
      short: "C",
      size: 12,
      matchesPerTeam: 4,
      slots: { epl: 12 },
      directSlots: 6,
      playoffSlots: 4,
      prize: { participation: 0, win: 0, draw: 0, stage: {}, winner: 0 },
    };
    // 브래킷(6 + 2 = 8)은 2의 거듭제곱이라 합 검사에는 걸리지 않는다
    const problems = checkEuroCupInvariants([lopsided], leagues);
    expect(problems.join()).not.toContain("2의 거듭제곱");
    expect(problems.join()).toContain("일대일");
    // 플레이오프가 없으면 직행만으로 브래킷이 서므로 이 식을 묻지 않는다
    expect(
      checkEuroCupInvariants([{ ...lopsided, directSlots: 8, playoffSlots: 0 }], leagues),
    ).toEqual([]);
  });

  it("시드 대항전은 이 식을 만족한다 (UCL 8/16 · UEL 4/8 · UECL 2/4)", () => {
    expect(checkEuroCupInvariants(cupCatalog(), leagueCatalog())).toEqual([]);
  });
});

/**
 * 오버라이드 파일은 **모양을 검사해 통과한 것만** 카탈로그가 된다. 어긋난 파일이
 * 그대로 읽히면 실패가 저장한 순간이 아니라 한참 뒤 새 게임을 세울 때 터지고,
 * 반대로 멀쩡한 파일을 거절하면 편집이 조용히 사라진다 — 양쪽을 함께 본다.
 */
describe("오버라이드 파일 로드", () => {
  it("모양이 어긋난 선수 카탈로그는 시드로 돌아간다", () => {
    // 15축이 통째로 빠진 줄 — 그대로 카탈로그가 되면 전력을 재는 자리에서 터진다
    writeFileSync(
      catalogPath(),
      JSON.stringify([
        {
          id: "ghost",
          teamId: "arsenal",
          nameKo: "유령",
          nameEn: "Ghost",
          birthdate: "2000-01-01",
          positions: [{ position: "ST", proficiency: 80, isNatural: true }],
          potential: 80,
        },
      ]),
      "utf8",
    );
    expect(playerCatalog().some((p) => p.id === "ghost")).toBe(false);
    expect(playerCatalog().some((p) => p.teamId === "arsenal")).toBe(true);
  });

  it("어드민이 저장한 선수 카탈로그는 파일에서 그대로 다시 읽힌다", () => {
    const victim = playerCatalog()[0]!.id;
    expect(adminRemoveCatalogPlayer(victim).ok).toBe(true);
    expect(existsSync(catalogPath())).toBe(true);
    // 편집 세대가 오르면 카탈로그 캐시가 비고, 다음 조회는 파일을 다시 읽는다
    adminResetLeagueCatalog();
    // 스키마가 엔진이 쓴 모양을 거절하면 시드로 폴백해 지운 선수가 되살아난다
    expect(playerCatalog().some((p) => p.id === victim)).toBe(false);
  });

  it("팀 id가 중복된 팀 카탈로그는 시드로 돌아간다", () => {
    const seed = teamCatalog().map((t) => ({ ...t }));
    writeFileSync(
      teamCatalogPath(),
      JSON.stringify({
        teams: [...seed, { ...seed[0]! }],
        tacticalStyle: {},
        clubProfiles: {},
      }),
      "utf8",
    );
    adminResetLeagueCatalog(); // 편집 세대를 올려 캐시를 비운다
    expect(teamCatalog()).toHaveLength(seed.length);
  });
});
