import { describe, expect, it } from "vitest";
import type { ManagerAttributes } from "@story-fm/domain";
import {
  FORMATIONS,
  presetOf,
  MANAGER_ATTRIBUTES,
  FORMATION_SLOTS,
  GamePlayerSchema,
  TeamTacticsSchema,
  clusterOf,
  naturalPositionOf,
  positionGroupOfPlayer,
  sameCluster,
} from "@story-fm/domain";
import {
  DEFAULT_XI,
  tacticalStyles,
  teamCatalog,
  catalogOfTeam,
  defaultXiIds,
  defaultXiSlugs,
  slugifyName,
  pickFormation,
  squadLevelOf,
  isTopFlight,
  tacticsOf,
  teamsOfLeague,
  buildMatches,
  buildTransferWindows,
  windowOpenOn,
  interpretBackgroundHeuristic,
  specialtyAxesOf,
  careerTierOf,
  teamFloorOf,
  SPECIALTY_BUDGET,
  START_MIN_AXIS,
  START_MAX_AXIS,
  playerCatalog,
  playersOf,
  assignmentsOf,
  activeContract,
  proficiencyAt,
  weeklyWagesOf,
} from "@story-fm/engine";
import { createTestGame, userFixtureCount } from "./helpers";

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
         * 위아래 모두 6 이내 — **주 포지션이 상한은 아니다**. 오른발 센터백은
         * 뭉뚱그린 CB보다 RCB를 잘 본다(`footAdjust`). 한쪽만 막으면 주발 모델을
         * 도로 금지하게 된다.
         *
         * 폭이 6인 이유: 보정은 두 발 차이에 비례하고(±3이 최대), 주 포지션이
         * 이미 한쪽 끝이면(왼발 5/1 선수의 LCB) 반대편까지 3+3이 벌어진다.
         * 약발이 좋은 선수(5/4)는 좌우 차이가 2뿐이다 — 그게 이 모델의 요점이다.
         */
        expect(Math.abs(nat.proficiency - own!.proficiency)).toBeLessThanOrEqual(6);
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

  it("모든 클럽 소속 선수는 팀 안에서 고유한 등번호를 갖는다", () => {
    for (const team of state.teams.filter((entry) => entry.id !== "freeagents")) {
      const squad = playersOf(state, team.id);
      expect(squad.every((player) => player.squadNumber !== undefined), team.id).toBe(true);
      expect(new Set(squad.map((player) => player.squadNumber)).size, team.id).toBe(squad.length);
    }
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
    // 무소속 클럽은 비어 있게 시작한다
    expect(playersOf(state, "freeagents")).toHaveLength(0);
    expect(state.tactics).toHaveLength(teamCatalog().length);
    expect(state.finances).toHaveLength(teamCatalog().length);
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
      assignmentsOf(state, team.id).map((a) => {
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
    expect(state.injuries.every((i) => i.note === "부임 전 이력")).toBe(true);
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
