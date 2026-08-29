import { describe, expect, it } from "vitest";
import {
  type ManagerAttributes,
  FORMATIONS,
  presetOf,
  MANAGER_ATTRIBUTES,
  FORMATION_SLOTS,
  GamePlayerSchema,
  TeamTacticsSchema,
  clusterOf,
  isMirrorPair,
  isReserveMatch,
  naturalPositionOf,
  positionGroupOfPlayer,
  sameCluster,
} from "@story-fm/domain";
import {
  adminCatalog,
  DEFAULT_XI,
  tacticalStyles,
  teamCatalog,
  catalogOfTeam,
  defaultXiIds,
  defaultXiSlugs,
  slugifyName,
  pickFormation,
  squadLevelOf,
  isClubTeam,
  isTopFlight,
  tacticsOf,
  teamsOfLeague,
  buildMatches,
  buildTransferWindows,
  windowOpenOn,
  interpretBackgroundHeuristic,
  clampJudgedAttributes,
  seedOpenings,
  tickOpenings,
  ATTRIBUTE_JUDGE_BAND,
  ATTRIBUTE_SUM_BAND,
  MAX_OPENINGS,
  OPENING_DAYS,
  addDays,
  specialtyAxesOf,
  careerTierOf,
  teamFloorOf,
  startingWalletAnchor,
  clampStartingWallet,
  WALLET_JUDGE_BAND,
  START_MAX_WALLET,
  SPECIALTY_BUDGET,
  START_MIN_AXIS,
  START_MAX_AXIS,
  playerCatalog,
  buildTeamSquad,
  generateYouthPlayer,
  syntheticNamePoolOf,
  personaNamePoolOf,
  SYNTHETIC_NAME_COUNTRIES,
  PERSONA_NAME_COUNTRIES,
  playersOf,
  assignmentsOf,
  activeContract,
  proficiencyAt,
  weeklyWagesOf,
  advanceTime,
  computeStandings,
  createGame,
  isFriendly,
  MINI_WORLD,
  MINI_WORLD_TWO_LEAGUES,
  scopedTeams,
  countryOfTeam,
  pseudonymClubs,
  pseudonymSquad,
  type PlayerNameInput,
} from "@story-fm/engine";
import { createTestGame, userFixtureCount, createMiniGame, playFullSeason } from "./helpers";

/** 스쿼드를 갖는 팀 — 무소속(`free`)은 비어 있게 시작한다 */
const SQUAD_TEAMS = teamCatalog().filter((t) => t.leagueId !== "free");

describe("선수 카탈로그 (불변 초기치 DB)", () => {
  const catalog = playerCatalog();

  it("1부 96팀 + 2부 64팀 · 5,000명+ · 전역 id 유일", () => {
    // 무소속(`free`)은 스쿼드를 갖지 않는다 — 방출·계약 만료로만 사람이 들어온다
    expect(new Set(catalog.map((e) => e.teamId)).size).toBe(SQUAD_TEAMS.length);
    expect(catalog.length).toBeGreaterThanOrEqual(3800);
    expect(new Set(catalog.map((e) => e.id)).size).toBe(catalog.length);
  });

  it("실선수 시드에 표기만 다른 같은 선수가 둘 다 남지 않는다", () => {
    // 시드를 갱신할 때 로마자 표기가 갈린 같은 선수가 둘 다 살아남는 사고가
    // 난다 (Yarmoliuk/Yarmolyuk). id 슬러그도 생년월일도 달라서 유일성 검사엔
    // 안 걸리므로 **이름의 편집 거리**로 본다. 절차 생성 선수(`synthetic`)는
    // 이름을 무작위 조합으로 만들어 우연한 충돌이 정상이라 제외한다.
    const plain = (s: string) =>
      s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z]/g, "");
    const distance = (a: string, b: string) => {
      if (Math.abs(a.length - b.length) > 2) return 9;
      let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
      for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
          cur.push(
            Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)),
          );
        }
        prev = cur;
      }
      return prev[b.length]!;
    };

    const byTeam = new Map<string, { id: string; name: string; birthdate: string }[]>();
    for (const e of catalog) {
      if (e.synthetic) continue;
      const list = byTeam.get(e.teamId) ?? [];
      list.push({ id: e.id, name: plain(e.nameEn), birthdate: e.birthdate });
      byTeam.set(e.teamId, list);
    }
    // 이름만으로는 한 팀의 다른 두 사람을 잡는다 (알라베스의 Mikel/Miguel Rodríguez).
    // 표기가 갈린 **같은 사람**이라면 생일이 같으므로 그것까지 봐야 한 사람이다.
    const dupes: string[] = [];
    for (const [teamId, list] of byTeam) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (
            distance(list[i]!.name, list[j]!.name) <= 2 &&
            list[i]!.birthdate === list[j]!.birthdate
          ) {
            dupes.push(`${teamId}: ${list[i]!.id} ~ ${list[j]!.id}`);
          }
        }
      }
    }
    expect(dupes).toEqual([]);
  });

  it("실측 등번호는 1~99이고 같은 팀에서 겹치지 않는다", () => {
    const assigned = catalog.filter((p) => p.squadNumber !== undefined);
    // FC 24 전수 스냅샷 + 확인 가능한 2026/27 구단표를 이름으로 대조한 범위다.
    expect(assigned.length).toBeGreaterThanOrEqual(1500);

    const seen = new Set<string>();
    for (const player of assigned) {
      expect(player.squadNumber).toBeGreaterThanOrEqual(1);
      expect(player.squadNumber).toBeLessThanOrEqual(99);
      const key = `${player.teamId}:${player.squadNumber}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it("같은 선수가 두 클럽에 동시에 있지 않는다 (이적 뒤 원소속에 남은 행)", () => {
    // 팀 안만 보면 이걸 못 잡는다. 여름 이적 선수를 새 구단에 넣고 **원소속에서
    // 지우지 않으면** 한 사람이 두 팀에서 뛴다 — 실제로 5명이 그렇게 남아 있었다
    // (트래포드·후안루·바르코·상가레·곤살로 가르시아). 동명이인과는 **생년월일**로
    // 가른다: 이름이 같아도 생일이 다르면 다른 사람이다 (비티냐·무사 디아라).
    const key0 = (s: string) =>
      s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z]/g, "");
    const byPerson = new Map<string, string[]>();
    for (const e of catalog) {
      if (e.synthetic) continue;
      const key = `${key0(e.nameEn)}|${e.birthdate}`;
      byPerson.set(key, [...(byPerson.get(key) ?? []), e.id]);
    }
    const twoClubs = [...byPerson.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([key, ids]) => `${key}: ${ids.join(" ⇄ ")}`);
    expect(twoClubs).toEqual([]);
  });

  it("전 선수가 goalkeeping을 갖는다 — 예외 분기 없음 (v6)", () => {
    for (const e of catalog) {
      expect(e.goalkeeping).toBeGreaterThan(0);
    }
    // 필드 플레이어는 낮고, GK는 높다
    const gks = catalog.filter((e) => e.positions.some((p) => p.isNatural && p.position === "GK"));
    const outfield = catalog.filter(
      (e) => !e.positions.some((p) => p.isNatural && p.position === "GK"),
    );
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean(gks.map((e) => e.goalkeeping))).toBeGreaterThan(
      mean(outfield.map((e) => e.goalkeeping)) + 30,
    );
  });

  it("주 포지션 하나 이상 + 멀티 포지션 적응도를 갖는다", () => {
    // 주 포지션은 **여럿일 수 있다** — 두 자리를 다 자기 자리로 삼는 선수가 있다.
    // 시드가 자리를 하나만 들고 있어 지금 카탈로그는 전부 1개지만, 모델은 열어 둔다
    for (const e of catalog) {
      expect(e.positions.filter((p) => p.isNatural).length).toBeGreaterThanOrEqual(1);
      for (const p of e.positions) {
        expect(p.proficiency).toBeGreaterThan(0);
        expect(p.proficiency).toBeLessThanOrEqual(99);
      }
    }
    // 필드 플레이어 대다수는 부포지션을 갖는다 (GK는 전문 포지션)
    const outfield = catalog.filter((e) => naturalPositionOf(e).position !== "GK");
    const multi = outfield.filter((e) => e.positions.length > 1);
    expect(multi.length).toBeGreaterThan(outfield.length * 0.8);
  });

  it("사실상 같은 자리(CB↔RCB/LCB 등)는 적응도가 거의 같다", () => {
    let compared = 0;
    for (const e of catalog) {
      const nat = naturalPositionOf(e);
      const cluster = clusterOf(nat.position);
      if (!cluster) continue;
      // 묶음 전체를 갖고 있어야 한다 — 좌우 분화는 다른 자리가 아니다
      for (const code of cluster) {
        const own = e.positions.find((p) => p.position === code);
        expect(own, `${e.nameEn} (${nat.position}) 에 ${code} 없음`).toBeDefined();
        /**
         * **좌우 분화는 저장값이 정확히 같다** — 주발은 저장하지 않고 조회할 때
         * `positionProficiency`가 붙인다 (player.md §4·§8). 여기 얹어 두면 조회가
         * 다시 얹어 폭이 두 배가 됐다. 역할이 다른 묶음(RB↔RWB · ST↔CF)만 −2가
         * 남는다 — 같은 묶음이어도 하는 일이 다르기 때문이다.
         */
        const expected = code === nat.position || isMirrorPair(nat.position, code) ? 0 : 2;
        expect(nat.proficiency - own!.proficiency, `${e.nameEn} ${nat.position}→${code}`).toBe(
          expected,
        );
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(1000); // 중앙 계열이 카탈로그의 큰 몫
  });

  it("묶음 밖 확장 포지션은 여전히 뚜렷하게 낮다", () => {
    // 적응도가 "다 비슷해지는" 반대 방향 붕괴를 막는다
    const outside = catalog.flatMap((e) => {
      const nat = naturalPositionOf(e);
      return e.positions
        .filter((p) => !p.isNatural && !sameCluster(nat.position, p.position))
        .map((p) => nat.proficiency - p.proficiency);
    });
    expect(outside.length).toBeGreaterThan(1000);
    expect(Math.min(...outside)).toBeGreaterThan(3);
  });

  it("인접 포지션 값이 계층 안에 있다 — 70~82 (주 포지션 88~96 아래)", () => {
    // 하한: 프로 1군이 **바로 옆 자리**를 62로 소화한다는 건 실제 축구와 어긋난다.
    // 상한: 그렇다고 주 포지션과 구별이 사라지면 자리 개념이 무의미해진다.
    const outside = catalog.flatMap((e) => {
      const nat = naturalPositionOf(e);
      return e.positions
        .filter((p) => !p.isNatural && !sameCluster(nat.position, p.position))
        .map((p) => p.proficiency);
    });
    expect(Math.min(...outside)).toBeGreaterThanOrEqual(70);
    expect(Math.max(...outside)).toBeLessThanOrEqual(82);
  });

  it("결정적이다 — 같은 카탈로그가 반복 호출에도 동일", () => {
    expect(playerCatalog()).toEqual(catalog);
  });

  /**
   * 한 팀 안의 동명이인은 화면만의 문제가 아니다 — `rankByName`이 매번 되묻고,
   * GM 명부에 같은 이름 두 줄이 서며, 로마자까지 같으면 id가 연도로 갈린다.
   */
  it("한 팀 안에서 이름만으로 사람이 갈린다 — 한글도 로마자도", () => {
    const byTeam = new Map<string, typeof catalog>();
    for (const entry of catalog)
      byTeam.set(entry.teamId, [...(byTeam.get(entry.teamId) ?? []), entry]);
    const clashing: string[] = [];
    for (const [teamId, squad] of byTeam) {
      const ko = new Set(squad.map((e) => e.nameKo));
      const en = new Set(squad.map((e) => e.nameEn));
      if (ko.size !== squad.length) clashing.push(`${teamId}: 한글 ${squad.length - ko.size}`);
      if (en.size !== squad.length) clashing.push(`${teamId}: 로마자 ${squad.length - en.size}`);
    }
    expect(clashing).toEqual([]);
  });

  /**
   * 합성 선수가 실선수와 같은 이름이면 유일성을 지켜도 사람이 안 갈린다.
   * 뽑힌 조합이 아니라 **뽑힐 수 있는 조합 전부**를 보는 이유다 — 풀을 고칠 때
   * 걸려야 하지, 시드가 그 조합을 뽑는 날 걸려서는 늦다.
   */
  it("합성 이름 조합이 실선수 이름과 겹치지 않는다", () => {
    const real = catalog.filter((e) => e.synthetic !== true);
    const realKo = new Set(real.map((e) => e.nameKo));
    const realEn = new Set(real.map((e) => e.nameEn));
    const clashing: string[] = [];
    for (const country of SYNTHETIC_NAME_COUNTRIES) {
      const pool = syntheticNamePoolOf(country);
      for (const first of pool.first) {
        for (const last of pool.last) {
          if (realKo.has(`${first.ko} ${last.ko}`)) clashing.push(`${first.ko} ${last.ko}`);
          if (realEn.has(`${first.en} ${last.en}`)) clashing.push(`${first.en} ${last.en}`);
        }
      }
    }
    expect(clashing).toEqual([]);
  });

  /**
   * 인물(수석코치·구단주·기자)과 선수가 동명이인이면 `speakerRoles`가 둘 다
   * 포기해 직책·아이콘이 함께 사라진다. 성을 나눠 두면 조합이 겹칠 수 없다.
   */
  it("인물 이름 풀과 선수 이름 풀은 성을 나눠 갖는다", () => {
    const playerFamily = new Set(
      SYNTHETIC_NAME_COUNTRIES.flatMap((c) => syntheticNamePoolOf(c).last.map((n) => n.ko)),
    );
    const shared = PERSONA_NAME_COUNTRIES.flatMap((c) => personaNamePoolOf(c).family).filter((f) =>
      playerFamily.has(f),
    );
    expect(shared).toEqual([]);
  });

  /**
   * 이름 재추첨은 시드 rng를 쓴다 — 같은 시드가 두 번 돌면 같은 명단이 나와야
   * 세계 생성이 결정적이다 (AGENTS.md §4).
   */
  it("같은 시드로 두 번 만들면 같은 명단이 나온다 — 재추첨도 결정적", () => {
    const team = teamCatalog().find((t) => t.leagueId !== "free")!;
    const once = buildTeamSquad(team, new Set());
    const twice = buildTeamSquad(team, new Set());
    expect(twice).toEqual(once);

    const takenA = new Set<string>();
    const takenB = new Set<string>();
    const youthOf = (taken: Set<string>, names: Set<string>) =>
      Array.from(
        { length: 6 },
        (_, i) =>
          generateYouthPlayer(7, team.id, 0, i, team.tier, taken, undefined, 2026, names).name,
      );
    const namesA = new Set<string>();
    const namesB = new Set<string>();
    expect(youthOf(takenB, namesB)).toEqual(youthOf(takenA, namesA));
    expect(namesA.size).toBe(6); // 같은 팀에 콜업된 유스끼리도 겹치지 않는다
  });
});

describe("게임 생성 (7월 1일 프리시즌 시작)", () => {
  const state = createTestGame();

  it("7월 1일에 시작하고 여름 이적창이 열려 있다", () => {
    expect(state.date).toBe("2026-07-01");
    expect(state.calendar.preseasonStart).toBe("2026-07-01");
    expect(state.date < state.calendar.start).toBe(true); // 프리시즌
    const summer = state.windows.find((w) => w.kind === "summer");
    expect(summer?.opensOn).toBe("2026-07-01");
    expect(state.date >= (summer?.opensOn ?? "")).toBe(true);
  });

  it("2군을 메운 유스까지 팀 안에서 이름이 겹치지 않는다", () => {
    for (const team of state.teams.filter((entry) => entry.id !== "freeagents")) {
      const squad = playersOf(state, team.id);
      expect(new Set(squad.map((p) => p.name)).size).toBe(squad.length);
    }
  });

  it("모든 클럽 소속 선수는 팀 안에서 고유한 등번호를 갖는다", () => {
    for (const team of state.teams.filter((entry) => entry.id !== "freeagents")) {
      const squad = playersOf(state, team.id);
      expect(
        squad.every((player) => player.squadNumber !== undefined),
        team.id,
      ).toBe(true);
      expect(new Set(squad.map((player) => player.squadNumber)).size, team.id).toBe(squad.length);
    }
  });

  it("어드민 표의 OVR과 게임 선수의 OVR이 같은 숫자다", () => {
    /**
     * **파생의 원본은 하나다** (player.md §4). 어드민은 `bestOverall`, 게임은 주
     * 포지션 `roleFit`이던 때 카탈로그 5,320명 중 1,160명이 갈렸고(사카 89/86),
     * 같은 선수의 시장가·희망 주급·노출 밴드가 보는 화면마다 달랐다.
     */
    const shown = new Map<string, number>();
    for (const team of adminCatalog()) {
      for (const row of team.players) shown.set(row.id, row.overall);
    }
    const mismatched = state.players
      .filter((p) => p.catalogId !== null && shown.has(p.catalogId))
      .map((p) => ({ p, admin: shown.get(p.catalogId!)! }))
      .filter(({ p, admin }) => admin !== p.attributes.overall)
      .map(({ p, admin }) => `${p.name} 게임 ${p.attributes.overall} ≠ 어드민 ${admin}`);
    expect(mismatched.slice(0, 5)).toEqual([]);
    // 비교 대상이 실제로 있었는지 — 조인이 통째로 빗나가면 위가 조용히 통과한다
    expect(
      state.players.filter((p) => p.catalogId !== null && shown.has(p.catalogId)).length,
    ).toBeGreaterThan(100);
  });

  it("리그 개막은 8월 중순 금요일 밤 (실제 EPL처럼 개막전 1경기가 금요일)", () => {
    expect(state.calendar.start.startsWith("2026-08")).toBe(true);
    expect(new Date(`${state.calendar.start}T00:00:00Z`).getUTCDay()).toBe(5);
    // 개막일에 정확히 1경기 — 나머지 라운드는 주말에 흩어진다
    // 리그마다 금요일 개막전이 1경기씩 (5개 리그 = 5경기)
    const openerDay = state.matches.filter(
      (m) => m.date === state.calendar.start && m.competitionId === "epl",
    );
    expect(openerDay).toHaveLength(1);
  });

  it("팀·선수·전술·재정·계약이 인스턴스화된다", () => {
    // 1부 96 + 2부 64 — 2부는 리그전을 돌지 않지만 컵 참가자라 엔티티는 갖는다
    expect(state.teams).toHaveLength(teamCatalog().length);
    expect(state.players.length).toBeGreaterThanOrEqual(3800);
    // 무소속은 **클럽이 아니다** — 팀 엔티티 한 줄만 서고 스쿼드도 전술도 장부도 없다
    expect(playersOf(state, "freeagents")).toHaveLength(0);
    const clubs = teamCatalog().filter((t) => isClubTeam(t.id)).length;
    expect(state.tactics).toHaveLength(clubs);
    expect(state.finances).toHaveLength(clubs);
    expect(state.contracts).toHaveLength(state.players.length);
    for (const p of state.players) {
      expect(() => GamePlayerSchema.parse(p)).not.toThrow();
      if (p.catalogId !== null) expect(p.catalogId).toBe(p.id);
    }
    for (const t of state.tactics) {
      expect(() => TeamTacticsSchema.parse(t)).not.toThrow();
    }
  });

  it("팀마다 선발 11 + 벤치 배치가 있고 GK가 정확히 1명이다", () => {
    for (const team of state.teams) {
      if (team.id === "freeagents") continue; // 클럽이 아니다
      const starters = assignmentsOf(state, team.id, "starting");
      expect(starters).toHaveLength(11);
      expect(starters.filter((a) => a.position === "GK")).toHaveLength(1);
      expect(assignmentsOf(state, team.id, "bench").length).toBeGreaterThan(0);
      // 배치는 모두 그 팀 선수
      const ids = new Set(playersOf(state, team.id).map((p) => p.id));
      for (const a of assignmentsOf(state, team.id)) expect(ids.has(a.playerId)).toBe(true);
    }
  });

  it("기본 배치는 자리에 맞는 선수를 세운다 — 적응도 70 미만이 없다", () => {
    // 시작 배치에서 "생소한 자리"가 나오면 감독이 손대기 전부터 손해를 안고 시작한다.
    const placed = state.teams.flatMap((team) =>
      (isClubTeam(team.id) ? assignmentsOf(state, team.id) : []).map((a) => {
        const player = playersOf(state, team.id).find((p) => p.id === a.playerId)!;
        return { name: player.name, position: a.position, fit: proficiencyAt(player, a.position) };
      }),
    );
    const worst = placed.reduce((min, x) => (x.fit < min.fit ? x : min));
    expect(worst.fit, `${worst.name} → ${worst.position}`).toBeGreaterThanOrEqual(70);
  });

  it("구단마다 자기 모양으로 시작한다 — 리서치 값 + 스쿼드 적합", () => {
    const topFlight = teamCatalog().filter((t) => isTopFlight(t.id));
    // 1부는 전부 리서치한 기본 포메이션을 갖는다
    expect(topFlight.every((t) => t.formation !== undefined)).toBe(true);

    for (const team of SQUAD_TEAMS) {
      // 새 게임의 시작 모양은 언제나 프리셋이다 (자유 배치는 감독이 판을 만진 뒤에 생긴다)
      const formation = presetOf(tacticsOf(state, team.id).spec.formation);
      expect(FORMATIONS).toContain(formation);
      // 배치는 그 모양의 슬롯을 그대로 쓴다
      expect(assignmentsOf(state, team.id, "starting").map((a) => a.position)).toEqual(
        FORMATION_SLOTS[formation!],
      );
    }

    // 스쿼드 적합 판정은 **거부권**이다 — 리서치 값이 대부분 살아남아야 한다
    const kept = topFlight.filter((t) => tacticsOf(state, t.id).spec.formation === t.formation);
    expect(kept.length / topFlight.length).toBeGreaterThan(0.85);
    // 한 모양으로 쏠리지도 않는다
    const shapes = new Set(topFlight.map((t) => tacticsOf(state, t.id).spec.formation));
    expect(shapes.size).toBeGreaterThanOrEqual(4);
  });

  it("1부 구단은 모두 조사된 전술 정체성을 갖는다", () => {
    const topFlight = teamCatalog().filter((team) => isTopFlight(team.id));
    expect(topFlight.filter((team) => tacticalStyles()[team.id] === undefined)).toEqual([]);
  });

  it("리서치한 모양은 스쿼드가 감당하면 유지된다", () => {
    const squad = playersOf(state, "crystalpalace").filter((p) => squadLevelOf(p) === "first");
    // 선입견이 자기 스쿼드의 최적과 같으면 그대로 간다 (결정적)
    const own = pickFormation(squad, undefined);
    expect(FORMATIONS).toContain(own);
    expect(pickFormation(squad, own)).toBe(own);
    expect(pickFormation(squad, undefined)).toBe(own);

    // 온전한 스쿼드라면 백3 선입견이 살아남는다
    const defenders = squad.filter((p) => positionGroupOfPlayer(p) === "DF");
    expect(defenders.length).toBeGreaterThanOrEqual(6);
    expect(pickFormation(squad, "3-5-2")).toBe("3-5-2");
  });

  it("지정 선발이 감당하는 리서치 모양은 새 게임에서 그대로 선다", () => {
    // 모양 고르기의 시험 배치가 실제 라인업과 다른 잣대를 쓰면(지정 선발 가산 누락)
    // 세울 수 있는 모양인데도 미달자가 나와 리서치 값이 조용히 버려진다
    for (const teamId of ["arsenal", "liverpool", "tottenham"]) {
      const prior = teamCatalog().find((t) => t.id === teamId)?.formation;
      expect(tacticsOf(state, teamId).spec.formation).toBe(prior);
    }
  });

  it("기본 선발 슬러그가 전부 카탈로그에 실재한다 (오타 방지)", () => {
    // 슬러그가 틀리면 조용히 무시되고 라인업이 슬그머니 바뀐다 — 여기서 잡는다
    const missing: string[] = [];
    for (const teamId of Object.keys(DEFAULT_XI)) {
      const have = new Set(catalogOfTeam(teamId).map((e) => slugifyName(e.nameEn)));
      for (const slug of defaultXiSlugs(teamId)) {
        if (!have.has(slug)) missing.push(`${teamId}: ${slug}`);
      }
      expect(defaultXiIds(teamId).length, teamId).toBe(11);
    }
    expect(missing).toEqual([]);
  });

  it("기본 선발이 실제 선발에 반영된다 — 팀마다 9명 이상", () => {
    // 전원이 아닌 이유: 지정 11인은 그 구단의 실제 포메이션에서 뽑혔고,
    // 프리셋으로 접힌 모양과 포지션군이 어긋나는 자리는 스쿼드가 메운다.
    for (const teamId of Object.keys(DEFAULT_XI)) {
      const wanted = new Set(defaultXiIds(teamId));
      const started = assignmentsOf(state, teamId, "starting").filter((a) =>
        wanted.has(a.playerId),
      );
      expect(started.length, teamId).toBeGreaterThanOrEqual(9);
    }
  });

  it("계약이 주급의 원본 — 팀 주급 총액은 활성 계약의 합", () => {
    const team = state.userTeamId;
    const sum = state.contracts
      .filter((c) => c.status === "active" && c.teamId === team)
      .reduce((s, c) => s + c.weeklyWage, 0);
    expect(weeklyWagesOf(state, team)).toBe(sum);
    expect(sum).toBeGreaterThan(0);
    for (const p of playersOf(state, team)) {
      expect(activeContract(state, p.id)).not.toBeNull();
    }
  });

  it("카탈로그에 실제 주급이 있으면 공식 대신 그 값이 계약에 실린다", () => {
    const catalogWage = new Map(
      playerCatalog()
        .filter((e) => e.weeklyWage !== undefined)
        .map((e) => [e.id, e.weeklyWage!] as const),
    );
    expect(catalogWage.size).toBeGreaterThan(500); // EPL 시드는 주급을 갖는다
    let checked = 0;
    for (const p of playersOf(state, state.userTeamId)) {
      const real = p.catalogId === null ? undefined : catalogWage.get(p.catalogId);
      if (real === undefined) continue;
      expect(activeContract(state, p.id)?.weeklyWage).toBe(real);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("주장이 정확히 1명이다", () => {
    expect(playersOf(state, state.userTeamId).filter((p) => p.isCaptain)).toHaveLength(1);
  });

  it("초기 상태 — 기록 테이블은 부임 전 이력만 갖고 기본 훈련이 깔려 있다", () => {
    /**
     * 부상 표는 비어 있지 않다 — 조사된 선수의 **부임 전 이력**이 실려 있다
     * (`injury.ts`의 `seedInjuryHistory`). 감독을 만나기 전의 몸도 사실이다.
     * 다만 이 게임에서 벌어진 일은 아직 하나도 없다.
     */
    expect(state.injuries.length).toBeGreaterThan(0);
    expect(state.injuries.every((i) => i.cause === "pre_appointment")).toBe(true);
    expect(state.bookings).toHaveLength(0);
    expect(state.suspensions).toHaveLength(0);
    expect(state.growthLog).toHaveLength(0);
    // 프리시즌 훈련이 미리 깔려 있다 — 다만 부임 첫날은 아직 여름 휴가다
    expect(state.trainingSessions.length).toBeGreaterThan(0);
    expect(state.schedule.some((e) => e.type === "training" && e.date === state.date)).toBe(false);
    expect(state.schedule.some((e) => e.type === "training" && e.date > state.date)).toBe(true);
    expect(state.phase).toBe("idle");
  });

  it("tier가 낮을수록(강할수록) 평균 overall이 높다", () => {
    const avg = (id: string) => {
      const roster = playersOf(state, id);
      return roster.reduce((s, p) => s + p.attributes.overall, 0) / roster.length;
    };
    expect(avg("arsenal")).toBeGreaterThan(avg("hull") + 3);
  });
});

describe("시즌 일정 (일정 축)", () => {
  it("38라운드 더블 라운드로빈 — 팀당 38경기, 홈 19 어웨이 19", () => {
    const ids = teamsOfLeague("epl").map((t) => t.id);
    const matches = buildMatches(1, ids);
    expect(matches).toHaveLength(380);
    for (const id of ids) {
      const mine = matches.filter((m) => m.homeTeamId === id || m.awayTeamId === id);
      expect(mine).toHaveLength(38);
      expect(mine.filter((m) => m.homeTeamId === id)).toHaveLength(19);
    }
    for (let r = 1; r <= 38; r++) {
      const round = matches.filter((m) => m.round === r);
      expect(new Set(round.flatMap((m) => [m.homeTeamId, m.awayTeamId])).size).toBe(20);
    }
  });

  it("경기·이적창이 SCHEDULE_ENTRY로 등록된다 (시간 포함)", () => {
    const state = createTestGame();
    const matchEntries = state.schedule.filter((e) => e.type === "match");
    // 우리 리그 380경기 전체 + 우리 팀 대항전 경기 (남의 대항전은 달력에 없다)
    expect(matchEntries).toHaveLength(380 + (userFixtureCount(state) - 38));
    for (const e of matchEntries) expect(e.time).toMatch(/^\d{2}:\d{2}$/);
    // 이적창 개장·폐장 = 창 2개 × 2
    expect(state.schedule.filter((e) => e.type === "window-open")).toHaveLength(2);
    expect(state.schedule.filter((e) => e.type === "window-close")).toHaveLength(2);
    // 정렬 — 날짜·시간 순
    const dates = state.schedule.map((e) => `${e.date} ${e.time}`);
    expect([...dates].sort()).toEqual(dates);
  });

  it("이적창은 여름(7/1~9/1)·겨울(1/1~2/1)", () => {
    // 우리 창은 leagueId가 없다 — 사우디·MLS는 자기 리그 창을 따로 갖는다
    const windows = buildTransferWindows(1).filter((w) => w.leagueId === undefined);
    expect(windows.map((w) => w.kind)).toEqual(["summer", "winter"]);
    expect(windows[0]?.opensOn).toBe("2026-07-01");
    expect(windows[0]?.closesOn).toBe("2026-09-01");
    expect(windows[1]?.opensOn).toBe("2027-01-01");
  });

  it("이적 시장 전용 리그는 창이 우리와 다르다 — 사우디는 늦게 닫힌다", () => {
    const windows = buildTransferWindows(1);
    const ours = windows.find((w) => w.leagueId === undefined && w.kind === "summer")!;
    const saudi = windows.find((w) => w.leagueId === "saudi" && w.kind === "summer")!;
    const mls = windows.filter((w) => w.leagueId === "mls");

    // 우리 창이 닫힌 뒤에도 사우디는 열려 있다 — 팔 수는 있고 대체 영입은 못 한다
    expect(saudi.closesOn > ours.closesOn).toBe(true);
    expect(windowOpenOn(windows, "2026-09-20")).toBeNull();
    expect(windowOpenOn(windows, "2026-09-20", "saudi")).not.toBeNull();
    // 리그를 안 주면 우리 창만 본다 — 섞이면 "사우디가 열렸으니 우리도"가 된다
    expect(windowOpenOn(windows, "2026-08-01")?.leagueId).toBeUndefined();
    // MLS는 아예 다른 계절에 연다 (북미 시즌이 봄에 시작한다)
    expect(mls.length).toBe(2);
    expect(mls.some((w) => w.opensOn.includes("-02-"))).toBe(true);
  });
});

describe("온보딩 — 배경 직접 입력 해석 (career.md §1)", () => {
  const sum = (a: ManagerAttributes) => MANAGER_ATTRIBUTES.reduce((t, axis) => t + a[axis], 0);

  it("모든 축이 시작 범위 안에 있다", () => {
    for (const bg of ["선수 출신 주장", "데이터 분석가", "에이전트로 일했다", "축구 유튜버", "―"]) {
      const attrs = interpretBackgroundHeuristic(bg);
      for (const v of Object.values(attrs)) {
        expect(v).toBeGreaterThanOrEqual(START_MIN_AXIS);
        expect(v).toBeLessThanOrEqual(START_MAX_AXIS);
      }
    }
  });

  it("배경 키워드가 해당 축을 끌어올린다", () => {
    const player = interpretBackgroundHeuristic("프리미어리그에서 뛰었던 주장 출신 수비수");
    const agent = interpretBackgroundHeuristic("선수 에이전트로 협상 경력 10년");
    expect(player.leadership).toBeGreaterThan(agent.leadership);
    expect(agent.negotiation).toBeGreaterThan(player.negotiation);
  });

  it("커리어의 격이 기준선을 정한다 — 무경력은 낮게 시작한다", () => {
    expect(careerTierOf("특별한 경력은 없다")).toBe("none");
    // 직함만으로는 무대를 알 수 없다 — 레벨이 안 적힌 축구 경력은 minor에서 출발한다
    expect(careerTierOf("동네 조기축구 감독")).toBe("minor");
    expect(careerTierOf("프리미어리그에서 뛰었던 수비수")).toBe("major");
    expect(careerTierOf("챔피언스리그 우승 감독")).toBe("elite");

    const none = interpretBackgroundHeuristic("특별한 경력은 없다");
    const minor = interpretBackgroundHeuristic("동네 조기축구 감독");
    const major = interpretBackgroundHeuristic("프리미어리그에서 뛰었던 수비수");
    const elite = interpretBackgroundHeuristic("챔피언스리그를 우승한 감독");
    expect(sum(none)).toBeLessThan(sum(minor));
    expect(sum(minor)).toBeLessThan(sum(major));
    expect(sum(major)).toBeLessThan(sum(elite));
    // 무경력은 평균 34 — 성장 상한(90)까지 남은 여지가 곧 서사다
    expect(sum(none) / MANAGER_ATTRIBUTES.length).toBeLessThan(40);
  });

  it("무대의 격을 가른다 — K리그 프로는 5대 리그와 같지 않다", () => {
    // "프로"는 무대가 아니다. 5대 리그 밖 리그·하부·2부는 minor에 머문다
    for (const bg of [
      "K리그에서 뛰다 은퇴한 수비수",
      "J리그 프로 선수 출신",
      "MLS에서 감독으로 일했다",
      "챔피언십(2부) 팀 감독",
    ]) {
      expect(careerTierOf(bg)).toBe("minor");
    }
    const kleague = interpretBackgroundHeuristic("K리그에서 뛰다 은퇴한 수비수");
    const epl = interpretBackgroundHeuristic("프리미어리그에서 뛰다 은퇴한 수비수");
    expect(sum(kleague)).toBeLessThan(sum(epl));

    // 하위 무대의 성취는 인정하되 최상위와 같은 자리에 두지 않는다
    expect(careerTierOf("K리그 우승 감독")).toBe("major");
    expect(careerTierOf("챔피언스리그 우승 감독")).toBe("elite");
  });

  it("부임 구단의 격이 기준선의 하한을 올린다", () => {
    const bg = "축구를 좋아하는 평범한 회사원입니다"; // 커리어 단서 없음 = 34
    const nobody = interpretBackgroundHeuristic(bg);
    const atBigClub = interpretBackgroundHeuristic(bg, "mancity"); // tier 1
    const atMidTable = interpretBackgroundHeuristic(bg, "brighton"); // tier 3
    expect(sum(nobody)).toBeLessThan(sum(atMidTable));
    expect(sum(atMidTable)).toBeLessThan(sum(atBigClub));
    expect(atBigClub.leadership).toBe(teamFloorOf("mancity"));

    // 하한이므로 이미 그 격을 넘는 커리어는 깎이지 않는다 —
    // 챔스 우승자가 승격팀에 부임하는 것도 그것으로 이야기가 된다
    const legend = "챔피언스리그를 우승한 감독";
    expect(interpretBackgroundHeuristic(legend, "ipswich")).toEqual(
      interpretBackgroundHeuristic(legend, "mancity"),
    );

    // 알 수 없는 팀·미지정은 보정 없음
    expect(interpretBackgroundHeuristic(bg, "없는팀")).toEqual(nobody);
  });

  it("부정 구문 안의 낱말은 등급도 특화 가산도 올리지 않는다", () => {
    // `감독`이 minor를 찍고 리더십 +6까지 얹던 자리 — 경력을 부정하는 문장이 능력치를 올렸다
    expect(careerTierOf("감독 경험이 전혀 없는 사람이다")).toBe("none");
    expect(specialtyAxesOf("감독 경험이 전혀 없는 사람이다")).toEqual([]);
    expect(careerTierOf("선수 생활을 해본 적이 없다")).toBe("none");
    expect(careerTierOf("축구에는 문외한이다")).toBe("none");
    expect(careerTierOf("무경력자입니다")).toBe("none");

    // 지우는 단위는 문장이 아니라 **절**이다 — 부정은 자기 절만 뒤집는다
    expect(careerTierOf("선수로 뛰었고 우승은 없다")).toBe("minor");
    expect(specialtyAxesOf("전술은 공부했지만 분석은 해본 적 없다")).toEqual(["tactics"]);

    // `없이`는 부정 표지가 아니다 — 부정하는 것이 경력이 아니라 부상이다
    expect(careerTierOf("부상 없이 10년을 뛴 프리미어리그 수비수")).toBe("major");
  });

  it("배경이 이력을 명시적으로 부정하면 구단 하한이 물러난다", () => {
    // 하한은 "이 구단이 뽑았으니 이력이 있을 것"이라는 추론이고, 배경이 그 반례다
    const denied = "감독 경험이 전혀 없는 사람이다";
    expect(interpretBackgroundHeuristic(denied, "arsenal")).toEqual(
      interpretBackgroundHeuristic(denied),
    );

    // 부정한 적이 없으면 구단의 선택은 여전히 정보다 (위 테스트가 지키는 하한)
    const silent = "축구를 좋아하는 평범한 회사원입니다";
    expect(interpretBackgroundHeuristic(silent, "arsenal").leadership).toBe(teamFloorOf("arsenal"));
  });

  it("낙하산은 `none` 아래 칸이고 구단 하한을 뚫는다", () => {
    const parachute = "낙하산 인사다. 축구 경력은 전혀 없다.";
    expect(careerTierOf(parachute)).toBe("parachute");
    expect(careerTierOf("구단주 아들이다")).toBe("parachute");
    expect(careerTierOf("오너 일가의 조카고 축구는 문외한이다")).toBe("parachute");

    // 다른 등급 신호가 하나라도 있으면 그쪽이다 — 낙하산은 바닥이지 딱지가 아니다
    expect(careerTierOf("인맥으로 들어온 스포츠 기자 출신이다")).toBe("minor");

    // tier 1 구단에 부임해도 무경력(34)은커녕 그 아래로 선다
    const atBigClub = interpretBackgroundHeuristic(parachute, "arsenal");
    expect(sum(atBigClub)).toBeLessThan(sum(interpretBackgroundHeuristic("축구 팬입니다")));
    expect(atBigClub).toEqual(interpretBackgroundHeuristic(parachute));

    // 사다리의 바닥 — 시작 범위(20~80)의 아래 끝이 배경으로 닿는 눈금이 된다
    const floor = Math.min(...MANAGER_ATTRIBUTES.map((axis) => atBigClub[axis]));
    expect(floor).toBeGreaterThanOrEqual(START_MIN_AXIS);
    expect(floor - START_MIN_AXIS).toBeLessThanOrEqual(10);
  });

  it("지갑은 낙하산과 함께 내려가지 않는다 (career.md §1)", () => {
    const parachute = "낙하산 인사다. 축구 경력은 전혀 없다.";
    // 앵커는 `none`과 같고 — 구단주 아들은 무경력이지 무일푼이 아니다
    expect(startingWalletAnchor(parachute)).toBe(startingWalletAnchor("축구 팬입니다"));
    // 구단 하한도 능력치와 달리 물러나지 않는다: 돈은 있는데 실력이 없다
    expect(startingWalletAnchor(parachute, "arsenal")).toBe(
      startingWalletAnchor("축구 팬입니다", "arsenal"),
    );
    expect(startingWalletAnchor(parachute, "arsenal")).toBeGreaterThan(
      startingWalletAnchor(parachute),
    );
  });

  it("시작 지갑 앵커는 등급이 올리고 구단이 하한을 건다 (career.md §1)", () => {
    const nobody = "축구를 좋아하는 평범한 회사원입니다";
    const legend = "챔피언스리그를 우승한 감독";

    // 등급이 앵커를 올린다
    expect(startingWalletAnchor(nobody)).toBeLessThan(startingWalletAnchor("K리그 선수 출신"));
    expect(startingWalletAnchor("K리그 선수 출신")).toBeLessThan(
      startingWalletAnchor("프리미어리그에서 뛰었던 수비수"),
    );
    expect(startingWalletAnchor("프리미어리그에서 뛰었던 수비수")).toBeLessThan(
      startingWalletAnchor(legend),
    );

    // 구단은 가산이 아니라 하한이다 — 능력치와 같은 규약
    expect(startingWalletAnchor(nobody)).toBeLessThan(startingWalletAnchor(nobody, "mancity"));
    expect(startingWalletAnchor(legend, "ipswich")).toBe(startingWalletAnchor(legend, "mancity"));
    // 카탈로그에 없는 팀은 하한을 올리지 않는다 (오타 난 이름이 빅클럽 부임이 되지 않게)
    expect(startingWalletAnchor(nobody, "없는팀")).toBe(startingWalletAnchor(nobody));
  });

  it("판정값은 앵커 ± 한도 안으로 잘린다 — 없으면 앵커다 (career.md §1)", () => {
    const anchor = startingWalletAnchor("챔피언스리그를 우승한 감독", "mancity");
    const low = anchor * (1 - WALLET_JUDGE_BAND);
    const high = anchor * (1 + WALLET_JUDGE_BAND);

    // 판정이 없으면 앵커가 그대로 답이고, 같은 입력이면 언제나 같은 값이다
    expect(clampStartingWallet(undefined, anchor)).toBe(clampStartingWallet(undefined, anchor));
    expect(clampStartingWallet(undefined, anchor)).toBeGreaterThanOrEqual(low);

    // 폭을 벗어난 판정은 양쪽에서 잘린다
    expect(clampStartingWallet(0, anchor)).toBeGreaterThanOrEqual(Math.floor(low));
    expect(clampStartingWallet(999_999_999, anchor)).toBeLessThanOrEqual(Math.ceil(high));
    // 절대 상한 — 판정이 무엇을 읽든 시작부터 한 시즌 이적 예산은 아니다
    expect(clampStartingWallet(999_999_999, 50_000_000)).toBe(START_MAX_WALLET);
    // 눈금은 £10,000 단위로 떨어진다
    expect(clampStartingWallet(3_214_777, anchor) % 10_000).toBe(0);
    // 음수·NaN은 앵커로 떨어진다 (스키마가 막지만 코어가 마지막 관문이다)
    expect(clampStartingWallet(Number.NaN, anchor)).toBe(clampStartingWallet(undefined, anchor));
    expect(clampStartingWallet(-1, anchor)).toBeGreaterThanOrEqual(Math.floor(low));
  });

  it("축끼리 같은 낱말을 나눠 갖지 않는다 — 한 단어가 두 축을 올리면 예산이 샌다", () => {
    /**
     * `분석`이 전술과 분석 양쪽 패턴에 걸려 있던 때, "데이터 분석가" 한 마디가
     * 두 축을 동시에 올려 특화 예산이 조용히 두 배가 됐다.
     */
    // 결과값으로는 못 잰다 — 같은 낱말이 커리어 등급까지 움직이면 기준선이 통째로
    // 올라 다섯 축이 함께 오른다. 키워드 표에 직접 묻는다
    for (const word of [
      "분석",
      "데이터",
      "스카우트",
      "전술",
      "훈련",
      "피지컬",
      "에이전트",
      "주장",
    ]) {
      const hit = specialtyAxesOf(word);
      expect(hit.length, `"${word}"가 ${hit.join("·")} 를 함께 올린다`).toBeLessThanOrEqual(1);
    }
  });

  it("키워드를 나열해도 특화 총량은 예산을 넘지 않는다", () => {
    // 둘 다 minor 등급(무대가 안 적힌 경력) — 기준선은 같고 가산의 합만 예산으로 묶인다.
    // 축별 반올림 때문에 합이 1~2점 흔들릴 수 있어 여유를 둔다
    const stuffed = interpretBackgroundHeuristic(
      "주장 출신으로 데이터 분석가이고 에이전트였으며 방송 해설도 했다",
    );
    const single = interpretBackgroundHeuristic("에이전트로 일했다");
    expect(careerTierOf("에이전트로 일했다")).toBe("minor");
    expect(sum(stuffed) - sum(single)).toBeLessThan(SPECIALTY_BUDGET);
    expect(sum(stuffed) - MANAGER_ATTRIBUTES.length * 42).toBeLessThanOrEqual(SPECIALTY_BUDGET + 2);
  });
});

// ─── 축소 세계 (mini-world.test.ts에서 옮겨 왔다) ───
describe("축소 세계 — 같은 규칙의 작은 세계", () => {
  it("범위 안의 클럽만 존재한다 — 무소속은 언제나 있다", () => {
    const state = createMiniGame();
    expect(state.teams).toHaveLength(MINI_WORLD.teamsPerLeague + 1); // + 무소속
    expect(state.teams.some((t) => t.id === "freeagents")).toBe(true);
    // 선수도 그 클럽들 것만 만들어진다
    const teamIds = new Set(state.teams.map((t) => t.id));
    expect(state.players.every((p) => teamIds.has(p.teamId))).toBe(true);
  });

  it("컵이 없는 세계 — 대항전 참가도 컵 경기도 없다", () => {
    const state = createMiniGame();
    expect(state.euroEntrants).toHaveLength(0);
    // 리그·친선·2군 리그뿐이다 — 컵은 한 경기도 없다
    expect(
      state.matches.every((m) => m.competitionId === "epl" || isFriendly(m) || isReserveMatch(m)),
    ).toBe(true);
  });

  it("리그전은 그대로 더블 라운드로빈이다", () => {
    const state = createMiniGame();
    const n = MINI_WORLD.teamsPerLeague;
    // 프리시즌 친선·2군 리그는 리그전이 아니다 — 라운드로빈은 리그 경기만 센다
    const league = state.matches.filter((m) => !isFriendly(m) && !isReserveMatch(m));
    expect(league).toHaveLength(n * (n - 1));
    // 팀마다 홈·원정이 같은 수만큼
    for (const team of state.teams.filter((t) => t.id !== "freeagents")) {
      const home = league.filter((m) => m.homeTeamId === team.id).length;
      const away = league.filter((m) => m.awayTeamId === team.id).length;
      expect(home).toBe(n - 1);
      expect(away).toBe(n - 1);
    }
  });

  it("시즌이 끝나고 다음 시즌으로 넘어간다", () => {
    const state = createMiniGame();
    const ended = playFullSeason(state);
    expect(ended).toBe(true);
    // 전 경기가 소화된 뒤에 끝난다
    const table = computeStandings(state, "epl");
    expect(table).toHaveLength(MINI_WORLD.teamsPerLeague);
    // 시즌 전환 — 새 일정이 깔린다
    advanceTime(state, { days: 1 });
    expect(state.season).toBe(2);
    expect(
      state.matches.filter((m) => m.season === 2 && !isFriendly(m) && !isReserveMatch(m)),
    ).toHaveLength(MINI_WORLD.teamsPerLeague * (MINI_WORLD.teamsPerLeague - 1));
  });

  it("두 리그 세계도 각자 리그전을 돈다", () => {
    const background = "은퇴한 수비수";
    const state = createGame({
      seed: 7,
      userTeamId: "arsenal",
      managerName: "김감독",
      background,
      attributes: interpretBackgroundHeuristic(background, "arsenal"),
      world: MINI_WORLD_TWO_LEAGUES,
    });
    const leagues = new Set(
      state.matches.filter((m) => !isFriendly(m) && !isReserveMatch(m)).map((m) => m.competitionId),
    );
    expect([...leagues].sort()).toEqual(["epl", "laliga"]);
  });

  it("범위를 벗어난 팀으로는 시작할 수 없다", () => {
    const background = "은퇴한 수비수";
    expect(() =>
      createGame({
        seed: 1,
        userTeamId: "barcelona", // MINI_WORLD는 EPL만 있다
        managerName: "김감독",
        background,
        attributes: interpretBackgroundHeuristic(background, "barcelona"),
        world: MINI_WORLD,
      }),
    ).toThrow();
  });

  it("전체 세계는 그대로다 — 범위를 주지 않으면 카탈로그 전부", () => {
    expect(scopedTeams().length).toBeGreaterThan(150);
    expect(scopedTeams(MINI_WORLD)).toHaveLength(MINI_WORLD.teamsPerLeague + 1);
  });
});

/**
 * 가명 매핑 — 라이선스 부채의 가명화 갈래 (sources.md §7.3).
 *
 * 여기서 지키는 것은 둘뿐이다: **결정성**과 **유일성**. 어떤 이름이 나오는가는
 * 풀을 고치면 바뀌는 값이라 잡아 둘 것이 아니고, 이 둘이 깨지면 파이프라인을 두 번
 * 돌린 diff가 시드 변경분이 아니게 되거나(결정성) 한 클럽에 동명이인이 서서 화자
 * 판별이 무너진다(유일성 — people.md §2).
 */
describe("가명 매핑 (sources.md §7.3)", () => {
  const clubs = SQUAD_TEAMS.map((t) => ({ id: t.id, country: countryOfTeam(t.id) }));
  const named = pseudonymClubs(clubs);

  const squad: PlayerNameInput[] = Array.from({ length: 45 }, (_, i) => ({
    nameEn: `Seed Player ${i}`,
    birthdate: `199${i % 10}-0${(i % 9) + 1}-15`,
    wikidataId: `Q${1000 + i}`,
  }));

  it("같은 입력은 같은 가명 — 나열 순서는 결과를 움직이지 않는다", () => {
    const again = pseudonymClubs([...clubs].reverse());
    for (const club of clubs) expect(again.get(club.id)).toEqual(named.get(club.id));

    const first = pseudonymSquad("잉글랜드", squad);
    const reversed = pseudonymSquad("잉글랜드", [...squad].reverse());
    expect([...reversed].reverse()).toEqual(first);
  });

  it("클럽 이름·약어·구장은 전 클럽에서 유일하다", () => {
    // shortName은 리그를 넘나드는 표시라 겹치면 두 클럽이 같은 얼굴로 선다
    expect(new Set([...named.values()].map((c) => c.shortName)).size).toBe(named.size);
    expect(new Set([...named.values()].map((c) => c.name)).size).toBe(named.size);
    expect(new Set([...named.values()].map((c) => c.stadium)).size).toBe(named.size);
  });

  it("한 클럽 안에 동명이인이 서지 않는다", () => {
    const names = pseudonymSquad("이탈리아", squad);
    expect(new Set(names.map((n) => n.nameKo)).size).toBe(squad.length);
    expect(new Set(names.map((n) => n.nameEn)).size).toBe(squad.length);
  });
});

describe("온보딩 판정 — 능력치의 결과 시작 사건 (career.md §1)", () => {
  const anchor = { leadership: 50, tactics: 50, training: 50, negotiation: 50, analysis: 50 };

  it("판정이 없으면 앵커가 그대로고, 축은 ±폭으로 잘린다", () => {
    expect(clampJudgedAttributes(undefined, anchor)).toEqual(anchor);
    const wide = clampJudgedAttributes({ tactics: 99, training: 10 }, anchor);
    expect(wide.tactics).toBe(50 + ATTRIBUTE_JUDGE_BAND);
    expect(wide.training).toBe(50 - ATTRIBUTE_JUDGE_BAND);
    expect(wide.leadership).toBe(50);
  });

  it("합이 폭을 넘으면 델타를 비례 축소한다 — 총량은 앵커가 쥔다", () => {
    const up = clampJudgedAttributes(
      { leadership: 58, tactics: 58, training: 58, negotiation: 58, analysis: 58 },
      anchor,
    );
    const sum = Object.values(up).reduce((a, b) => a + b, 0);
    expect(sum - 250).toBeLessThanOrEqual(ATTRIBUTE_SUM_BAND);
    // 결은 남는다 — 다섯 축이 같은 만큼 올랐으니 같은 값이다
    expect(new Set(Object.values(up)).size).toBe(1);
  });

  it("시작 사건은 셋까지, 실재하는 사람에게만, 기한은 코어가 박고 지나면 닫힌다", () => {
    const state = createTestGame();
    const ours = state.players.find((p) => p.teamId === state.userTeamId)!;
    const seeded = seedOpenings(state, [
      { kind: "press", title: "낙하산", line: "지역지가 연줄을 물었다" },
      { kind: "dressing-room", title: "주장의 시선", line: "새 감독을 잰다", subjectId: ours.id },
      { kind: "board", title: "없는 사람", line: "…", subjectId: "nobody" },
      { kind: "personal", title: "빚", line: "부임 전의 빚" },
      { kind: "personal", title: "넷째", line: "상한 밖" },
    ]);
    expect(seeded).toBe(MAX_OPENINGS);
    expect(state.openings!.map((o) => o.title)).toEqual(["낙하산", "주장의 시선", "빚"]);
    expect(state.openings![0]!.dueOn).toBe(addDays(state.date, OPENING_DAYS));
    const digest: string[] = [];
    tickOpenings(state, digest);
    expect(state.openings!.every((o) => o.resolvedOn === null)).toBe(true);
    state.date = addDays(state.date, OPENING_DAYS + 1);
    tickOpenings(state, digest);
    expect(state.openings!.every((o) => o.resolvedOn !== null)).toBe(true);
    expect(digest).toHaveLength(MAX_OPENINGS);
  });
});
