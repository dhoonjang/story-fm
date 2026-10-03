import { storePersona } from "../common/people/lorebook";
import { refreshStaffPool } from "../story/people/staff-employment";
import { syncLorebook } from "./workflows/story/lorebook";
import type {
  AxisValues,
  Contract,
  Formation,
  GamePlayer,
  GameTeam,
  TeamFinance,
  RegistrablePlayer,
  TeamTactics,
} from "@story-fm/domain";
import {
  playerOverall,
  freshPlayerState,
  ATTRIBUTE_AXES,
  FAMILIARITY_BASELINE,
  MANAGER_TERMS_BY_TIER,
  FIRST_TEAM_LIMIT,
  MATCHDAY_SQUAD,
  canRegister,
  isUnder21,
  FORMATION_SLOTS,
  positionGroupOfPlayer,
  initialCaptainOf,
} from "@story-fm/domain";
import { buildScheduleEntries } from "../match/competition/calendar";
import { buildSeasonCalendar, FIRST_SEASON } from "../common/core/calendar";
import { contractUntil, seasonYear } from "../common/core/dates";
import { tierOfTeamIn } from "../common/core/club-tier";
import { defaultXiIds, playerCatalog } from "../common/world/catalog";
import { assertCatalogValid } from "./catalog-invariants";
import { estimateSquadWages, wageSubjectOf } from "../common/finance/wages";
import { clubEconomyLevel } from "../common/data/league-economy";
import { worldFigureManagerOf } from "../common/data/world-figures";
import { generateYouthPlayer } from "../common/world/generate";
import { ensureSquadNumbers } from "../common/players/numbers";
import { hasCups, scopedTeams, type WorldScope } from "../common/world/scope";
import {
  teamCatalog,
  type TeamCatalogEntry,
  countryOfTeam,
  formationOf,
  isTopFlight,
  tacticalStyleOf,
  isClubTeam,
} from "../common/data/team-catalog";
import { clubProfiles, type ClubProfile } from "../common/data/club-profile";
import { advanceDomesticCups } from "./workflows/match/competition/domestic-cup";
import { buildEuroEntrants } from "../match/competition/europe";
import { buildSeasonFixtures, isUserFixture } from "../match/competition/fixtures";
import { seedInjuryHistory } from "../common/players/injury";
import { seedInternationalCaps } from "../match/competition/international";
import {
  generateHeadCoach,
  generateOwner,
  generateReporters,
  generateStaff,
  occupiedPersonNames,
  seededVirtualManagerName,
} from "../common/people/persona";
import { makeRng, randInt } from "../common/core/rng";
import { installDefaultTraining } from "../story/players/training-plan";
import {
  ensurePotentialFloor,
  type GameState,
  proficiencyAt,
  squadLevelOf,
} from "../common/core/state";
import { pickFormation, buildAssignments } from "../match/squad/selection";

/**
 * 카탈로그 팀을 새 게임의 사본 필드로 옮긴다. 프로필은 등재된 클럽만 싣는다.
 */
function copiedTeamFields(
  team: TeamCatalogEntry,
  profile: ClubProfile | undefined,
): Pick<
  GameTeam,
  "name" | "shortName" | "honours" | "leagueId" | "tier" | "stadium" | "capacity" | "commercialTier"
> {
  return {
    name: team.name,
    shortName: team.shortName,
    honours: (team.honours ?? []).map((honour) => ({ ...honour })),
    leagueId: team.leagueId,
    tier: team.tier,
    ...(profile === undefined
      ? {}
      : {
          stadium: profile.stadium,
          capacity: profile.capacity,
          commercialTier: profile.commercialTier,
        }),
  };
}

// ── 게임 생성 ───────────────────────────────────────────

export interface CreateGameInput {
  seed?: number;
  userTeamId: string;
  managerName: string;
  background: string;
  /** 세계의 범위 — 없으면 카탈로그 전체 (`world/scope.ts`) */
  world?: WorldScope;
}

/**
 * 초기 계약의 주급 — **카탈로그의 실제 주급이 원본**이고, 없으면 모델이 어림한다.
 *
 * 시드에 공개 주급이 있는 선수(EPL 1군)는 그 값을 쓴다. 실측이 모델보다 정확하고,
 * 무엇보다 **구단마다의 특수 사정**(장기 계약을 남긴 베테랑, 팔지 못한 고액자)은
 * 모델이 만들어낼 수 없는 사실이다. 그 왜곡이 곧 급여 비중 서사의 재료다.
 *
 * 나머지는 `estimateSquadWages` — 구단 예산을 스쿼드에 나눈다 (wages.ts).
 */
function initialWages(players: GamePlayer[], onDate: string): Map<string, number> {
  const seeded = new Map<string, number>();
  for (const entry of playerCatalog()) {
    if (entry.weeklyWage !== undefined) seeded.set(entry.id, entry.weeklyWage);
  }
  const out = new Map<string, number>();
  const byTeam = new Map<string, GamePlayer[]>();
  for (const p of players) byTeam.set(p.teamId, [...(byTeam.get(p.teamId) ?? []), p]);
  for (const [teamId, squad] of byTeam) {
    const modelled = estimateSquadWages(
      teamId,
      squad.map((p) => wageSubjectOf(p, onDate)),
    );
    for (const p of squad) {
      const real = p.catalogId === null ? undefined : seeded.get(p.catalogId);
      out.set(p.id, real ?? modelled.get(p.id) ?? 0);
    }
  }
  return out;
}

/**
 * 팀 tier → 시작 잔고. **EPL 기준이고 구단 경제 수준을 곱한다**
 * (`initialFinanceOf` — finance.md §6.2).
 *
 * 곱하지 않으면 PSG가 아스날과 똑같은 £120M로 시작해 6분의 1 중계 수입으로
 * 같은 살림을 산다. 수입만 리그를 알던 비대칭이 초기치에도 있던 자리다.
 */
const TIER_BALANCE: Record<number, number> = {
  1: 120_000_000,
  2: 70_000_000,
  3: 40_000_000,
  4: 25_000_000,
};

function initialFinanceOf(teamId: string, tier: number): { balance: number } {
  const base = TIER_BALANCE[tier] ?? TIER_BALANCE[4]!;
  return { balance: Math.round(base * clubEconomyLevel(teamId)) };
}

/**
 * 카탈로그 → 게임 선수 인스턴스화. 새 게임에서만 호출된다.
 * 카탈로그는 불변이므로 깊은 복사로 만들고 catalogId로 출처를 링크한다.
 */
function instantiatePlayers(seed: number, only?: (teamId: string) => boolean): GamePlayer[] {
  const players: GamePlayer[] = [];
  for (const entry of playerCatalog()) {
    if (only && !only(entry.teamId)) continue;
    const rng = makeRng(seed, `inst:${entry.id}`);
    const player: GamePlayer = {
      id: entry.id,
      catalogId: entry.id,
      teamId: entry.teamId,
      squadLevel: "first",
      isViceCaptain: false,
      growthCarry: {},
      name: entry.nameKo,
      ...(entry.squadNumber === undefined ? {} : { squadNumber: entry.squadNumber }),
      birthdate: entry.birthdate,
      positions: entry.positions.map((p) => ({ ...p })),
      ...(entry.homegrownCountry === undefined ? {} : { homegrownCountry: entry.homegrownCountry }),
      ...(entry.nationality === undefined ? {} : { nationality: entry.nationality }),
      ...(entry.secondNationality === undefined
        ? {}
        : { secondNationality: entry.secondNationality }),
      ...(entry.foot === undefined ? {} : { foot: entry.foot }),
      ...(entry.height === undefined ? {} : { height: entry.height }),
      ...(entry.weight === undefined ? {} : { weight: entry.weight }),
      attributes: {
        // 카탈로그의 16축을 그대로 복사 (2-레이어 분리 — 이후 변화는 GAME_PLAYER에만)
        ...(Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, entry[a]])) as AxisValues),
        potential: entry.potential,
      },
      state: freshPlayerState({
        /**
         * 프리시즌 시작이라 폼은 0 근처다 — 폼 축은 −1~1이라 `randInt(-1,1)`은
         * **바닥/절정**이다. 개인차만 남기고 평소 밴드 안에 둔다.
         */
        form: randInt(rng, -1, 1) * 0.15,
        // 프리시즌 시작 — 잘 쉬고 돌아왔다
        condition: randInt(rng, 70, 86),
      }),
      isCaptain: false,
    };
    ensurePotentialFloor(player);
    players.push(player);
  }
  return players;
}

const RESERVE_TEAM_SIZE = 18;

/**
 * 필수 자리를 채우고도 남는 U21을 1군에 몇 명까지 더 붙이나. 명단을 차지하지
 * 않으니 규정상 제한은 없지만, 실제로도 1군 훈련에 붙는 유망주는 소수고
 * 나머지는 2군에서 자란다.
 */
const U21_IN_FIRST = 3;

/**
 * 자리별 필수 확보 인원 — 등록 명단은 "잘하는 25명"이 아니라 **경기를 치를 수
 * 있는 25명**이다. 골키퍼 셋, 수비 여덟, 중원 여덟, 공격 다섯이 기준선.
 */
const ESSENTIAL_QUOTA: Record<string, number> = { GK: 3, DF: 8, MF: 8, FW: 5 };

/** 코어에 반드시 넣는 골키퍼 수 — 하나로는 시즌을 못 치른다 */
const CORE_GK = 2;

/**
 * 세계 인물 명부가 이 벤치에 세운 감독 — 없으면 빈 객체다 (people.md §2-1).
 *
 * **명부가 이름을 심는 자리는 여기 하나뿐이다.** 심고 나면 그 사람이 어디에 있는지는
 * 명부가 아니라 `managerName`이 답한다 — 인물지에 변하는 값을 넣지 않는다는 원칙이
 * 여기서도 같다.
 *
 * **유저가 맡은 팀은 비운다** — 그 자리를 감독(유저)이 받았으므로 명부의 그 사람은
 * 이 세계에 부임한 적이 없다 (`worldFigures`가 후보에서도 뺀다).
 */
function seededManagerName(
  teamId: string,
  state: { userTeamId: string },
): { managerName?: string } {
  if (teamId === state.userTeamId) return {};
  const figure = worldFigureManagerOf(teamId);
  return figure ? { managerName: figure.name } : {};
}

/**
 * 세계 생성 — 이름 없는 벤치를 전부 채운다. 명부의 감독이 먼저, 나머지는 가상
 * 이름이다 (people.md §2). 가상 이름은 (시드, 팀) 채널로 결정적이라 같은 시드는
 * 같은 사람을 만난다.
 *
 * ⚠️ **이미 이름이 있으면 건드리지 않는다** — 명부의 벤치가 그렇다.
 *
 * ⚠️ **유저 팀 벤치는 채우지 않는다** — 그 자리는 유저의 것이다. 우리 구단 인물
 * (`personas`)이 선 뒤에 돌아야 그 이름들을 피해서 뽑는다.
 */
export function ensureSeededManagers(state: GameState): void {
  const taken = occupiedPersonNames(state);
  for (const team of state.teams) {
    if (team.managerName !== undefined || !isClubTeam(team.id)) continue;
    if (team.id === state.userTeamId) continue;
    const name =
      worldFigureManagerOf(team.id)?.name ?? seededVirtualManagerName(state.seed, team.id, taken);
    team.managerName = name;
    taken.add(name);
  }
}

/**
 * 새 게임의 구단별 1·2군을 구성한다 — **등록 규칙을 지키며** 전력순으로 채운다.
 *
 * 상위 25명을 그냥 자르면 홈그로운 8명 조건을 어긴 명단이 만들어져, 감독이
 * 부임하자마자 위반 상태에서 시작한다. 그래서 위에서부터 훑되 `canRegister`가
 * 허락할 때만 1군에 올린다 — 홈그로운이 부족한 구단은 25명을 다 못 채우고
 * 시작하는데, 그것이 현실이고 그 자체가 첫 시즌의 과제가 된다.
 */
function buildInitialSquads(
  players: GamePlayer[],
  seed: number,
  formations: Map<string, Formation>,
  teams: readonly TeamCatalogEntry[] = teamCatalog(),
): void {
  const seasonStartYear = seasonYear(FIRST_SEASON);
  // 2군을 메울 유스가 여기서 태어난다 — id도 이름도 세계 전체에서 유일해야 한다
  const takenIds = new Set(players.map((p) => p.id));
  // 이름 집합을 팀마다 새로 쥐면 남의 팀 동명이인이 서고, 그 하나가 감독이 부른
  // 이름을 후보 둘로 갈라 지시를 죽인다 (people.md §2)
  const takenNames = new Set(players.map((p) => p.name));
  for (const team of teams) {
    const squad = players
      .filter((p) => p.teamId === team.id)
      .sort((a, b) => playerOverall(b) - playerOverall(a));
    // 2부 클럽은 컵에만 나온다 — 2군 개발 스쿼드를 둘 이유가 없다 (전원 1군)
    if (!isTopFlight(team.id)) {
      for (const player of squad) player.squadLevel = "first";
      continue;
    }
    /**
     * **자리부터 채운다.** 전력순으로만 훑으면 홈그로운 상한에 걸려 골키퍼가
     * 통째로 명단 밖으로 밀리는 일이 생긴다(실제로 그렇게 짜는 구단은 없다).
     * 그룹별 필수 인원을 먼저 확보하고, 남은 자리를 전력순으로 메운다.
     */
    /**
     * **코어** — 이들이 빠지면 경기를 못 치른다. 구단 지정 선발 XI와, 그것으로
     * 못 채운 자리의 최적 선수. 나이가 어려도 1군이다(골키퍼가 전부 19살인
     * 구단도 있다).
     */
    const core = new Set<string>();
    for (const id of defaultXiIds(team.id)) {
      if (squad.some((p) => p.id === id)) core.add(id);
    }
    for (const slot of FORMATION_SLOTS[formations.get(team.id) ?? formationOf(team.id)]) {
      if (
        [...core].some(
          (id) =>
            proficiencyAt(
              squad.find((p) => p.id === id)!,
              slot,
            ) >= 70,
        )
      ) {
        continue;
      }
      const best = squad
        .filter((p) => !core.has(p.id))
        .reduce<GamePlayer | null>(
          (top, p) => (top === null || proficiencyAt(p, slot) > proficiencyAt(top, slot) ? p : top),
          null,
        );
      if (best) core.add(best.id);
    }
    // 백업 골키퍼도 코어다 — 키퍼 하나로 시즌을 치를 수는 없다
    for (const p of squad.filter((x) => positionGroupOfPlayer(x) === "GK").slice(0, CORE_GK)) {
      core.add(p.id);
    }
    /** 코어 + 자리별 뎁스 — 등록 순서의 우선권만 갖는다 (로테이션·부상 대비) */
    const essential = new Set(core);
    for (const [group, quota] of Object.entries(ESSENTIAL_QUOTA)) {
      const inGroup = squad.filter((p) => positionGroupOfPlayer(p) === group);
      for (const p of inGroup.slice(0, quota)) essential.add(p.id);
    }
    /**
     * **코어를 맨 앞에 세워 등록한다.** 뎁스 자원이 전력순으로 앞질러 등록되면
     * 홈그로운 상한(25명 중 비홈그로운 17)에 걸려 정작 지정 선발이 2군에 남는다
     * — 실제로 노팅엄의 지정 공격형 미드필더가 그렇게 밀렸다. 코어는 11~13명이라
     * 먼저 등록해도 상한에 닿지 않으므로, 순서만 바꾸면 규칙을 어기지 않고
     * "지정 선발은 반드시 1군"이 보장된다.
     */
    const rank = (p: GamePlayer) => (core.has(p.id) ? 0 : essential.has(p.id) ? 1 : 2);
    const ordered = [...squad].sort(
      (a, b) => rank(a) - rank(b) || playerOverall(b) - playerOverall(a),
    );

    const registered: RegistrablePlayer[] = [];
    let youngInFirst = 0;
    for (const player of ordered) {
      const entry: RegistrablePlayer = {
        id: player.id,
        birthdate: player.birthdate,
        homegrown: player.homegrownCountry === countryOfTeam(team.id),
        positionGroup: positionGroupOfPlayer(player),
      };
      if (isUnder21(player.birthdate, seasonStartYear)) {
        // U21은 명단 밖이라 규정이 막지 않는다 — 몇 명을 붙일지는 운영 판단이다.
        // 단 **코어는 쿼터에서 뺀다** — 골키퍼가 전부 19살인 구단도 있고
        // (스트라스부르), 그 팀의 골키퍼는 어려도 1군 골키퍼다.
        if (core.has(player.id) || youngInFirst < U21_IN_FIRST) {
          player.squadLevel = "first";
          registered.push(entry);
          if (!core.has(player.id)) youngInFirst += 1;
        } else {
          player.squadLevel = "reserve";
        }
        continue;
      }
      const allowed = canRegister(registered, entry, seasonStartYear);
      player.squadLevel = allowed.ok ? "first" : "reserve";
      if (allowed.ok) registered.push(entry);
    }
    /**
     * **1군 상한에서 끊는다.** 등록 명단(25)은 만 21세 초과만 세므로 U21을 붙이는
     * 만큼 1군이 불어난다 — 말라가가 등록 25 + U21 7명으로 서른둘이었다.
     * 우선순위가 낮은 쪽부터 2군으로 내리되 **코어는 건드리지 않는다**: 코어를
     * 내리면 선발 XI를 세울 수 없다.
     */
    let over = squad.filter((p) => p.squadLevel === "first").length - FIRST_TEAM_LIMIT;
    for (let i = ordered.length - 1; i >= 0 && over > 0; i--) {
      const player = ordered[i];
      if (!player || player.squadLevel !== "first" || core.has(player.id)) continue;
      player.squadLevel = "reserve";
      over -= 1;
    }
    /**
     * 매치데이(20명)를 못 채우면 **U21로 메운다.** 홈그로운이 모자라 명단을 25까지
     * 못 채운 구단이 실제로 하는 일이 이것이다 — 명단을 차지하지 않는 어린 선수로
     * 벤치를 채운다. 21세 초과는 규정이 막으므로 여기서 올릴 수 없다.
     */
    let firstCount = squad.filter((p) => p.squadLevel === "first").length;
    if (firstCount < MATCHDAY_SQUAD) {
      for (const player of ordered) {
        if (firstCount >= MATCHDAY_SQUAD) break;
        if (player.squadLevel === "first") continue;
        if (!isUnder21(player.birthdate, seasonStartYear)) continue;
        player.squadLevel = "first";
        firstCount += 1;
      }
    }
    const reserveCount = squad.filter((p) => p.squadLevel === "reserve").length;
    for (let i = reserveCount; i < RESERVE_TEAM_SIZE; i++) {
      const youth = generateYouthPlayer(
        seed + 17,
        team.id,
        0,
        i,
        team.tier,
        takenIds,
        undefined,
        seasonStartYear,
        takenNames,
      );
      youth.squadLevel = "reserve";
      players.push(youth);
    }
  }
}

/**
 * 포메이션이 의도하는 공간 사용과 모순되지 않는 초기 운용값.
 *
 * ⚠️ **여섯 축의 리그 평균이 3에 서야 한다.** 3이 중립이고 전술의 효과는 3에서의
 * 편차로 읽히므로, 프리셋이 한쪽으로 쏠리면 **리그 전체가 같은 방향의 이득과 대가를
 * 달고 선다.**
 *
 * 그래서 각 스타일은 **올린 축만큼 내린 축을 갖는다** — 점유는 라인과 폭을 올리는
 * 대신 템포와 패스 길이를 내리고, 역습·롱볼은 라인과 압박을 내린다. 프리셋을
 * 고칠 때는 리그 평균을 다시 재라(`docs/match/match.md` §1.2).
 *
 * ⚠️ **갈래 넷(`TACTIC_TOGGLES`)도 같은 규칙을 탄다.** 갈래는 중립이 "아무 데도 서지
 * 않은 것"이라 평균이 아니라 **리그 합**으로 잰다. 그리고 그 합은 **스타일별 팀 수로
 * 가중해야** 한다 — `TACTICAL_STYLE_SEED`의 96팀은 스타일마다 수가 다르므로(high-press
 * 26 · possession 24 · direct 15 · transition 13 · low-block 10 · balanced 8) 여섯을
 * 같은 무게로 놓고 맞춘 표는 실제 리그에서 기운다. 지금 표의 96팀 가중 합은
 * 공격 +0.29% · 중원 +0.11% · 수비 −0.02% · 강도 +1.0%다. **빈칸은 필드를 쓰지 않는다**
 * — 프리셋은 자기 스타일이 실제로 말하는 갈래에만 선다. 갈래를 더하거나 옮길 때는 그
 * 가중 합을 다시 재라(`docs/common/team.md` §6).
 */
function initialTactics(
  teamId: string,
  formation: Formation,
): import("@story-fm/domain").TacticsSpec {
  switch (tacticalStyleOf(teamId)) {
    // 라인을 올려 압축하되 천천히 넓게 짧은 패스로 돌린다 — 공을 잃으면 자리부터
    // 잡고, 올린 라인은 트랩으로 지키며, 뒤에서 짧게 풀어 나간다
    case "possession":
      return {
        formation,
        mentality: 3,
        defensiveLine: 4,
        pressing: 3,
        tempo: 2,
        width: 4,
        passStyle: 2,
        transition: "regroup",
        offsideTrap: true,
        tackling: "soft",
        keeperDistribution: "short",
      };
    // 앞으로 무게를 싣고 라인을 올려 빠르게 — 대신 좁게 압축한다. 높은 곳에서 뺏어
    // 곧장 나가고, 올린 라인을 트랩으로 지키며, 거칠게 문다.
    // ⚠️ GK 배급은 비운다 — 압박으로 이미 공을 상대 진영에서 얻는다. 배급까지 짧게
    // 묶으면 "앞에서 시작한다"는 **같은 사실을 두 번 싣는다**.
    case "high-press":
      return {
        formation,
        mentality: 4,
        defensiveLine: 4,
        pressing: 5,
        tempo: 4,
        width: 2,
        passStyle: 3,
        transition: "counter",
        offsideTrap: true,
        tackling: "hard",
      };
    // 내려서서 기다리다 빠르고 넓게 나간다 — 뺏으면 곧장 앞으로, GK도 넘겨서 그
    // 출발을 앞당긴다. 트랩은 라인 2 앞에 걸 자리가 없고, 태클은 기다리는 쪽이라
    // 어느 끝에도 서지 않는다
    case "transition":
      return {
        formation,
        mentality: 3,
        defensiveLine: 2,
        pressing: 2,
        tempo: 4,
        width: 4,
        passStyle: 4,
        transition: "counter",
        keeperDistribution: "long",
      };
    // 내려서서 길게 찬다 — 폭보다 타깃이 먼저다. 라인 2로 내려서서 자리부터 잡으므로
    // 전환은 `regroup`이다.
    // ⚠️ GK 배급은 비운다 — 롱볼은 이미 `passStyle` 5가 말하고 있어 배급까지 길게 두면
    // **같은 사실을 두 번 싣는다**(team.md §6). 태클도 어느 끝에도 서지 않는다.
    case "direct":
      return {
        formation,
        mentality: 3,
        defensiveLine: 2,
        pressing: 2,
        tempo: 4,
        width: 3,
        passStyle: 5,
        transition: "regroup",
      };
    // 전부 내린다 — 뺏어도 자리부터 잡고(`counter`가 아니다: 역습으로 사는 팀은
    // `transition` 프리셋이 맡는다), 낮은 블록 앞에서 거칠게 물고, GK는 넘겨 버린다.
    // 라인이 낮아 트랩은 걸 자리가 없다
    case "low-block":
      return {
        formation,
        mentality: 2,
        defensiveLine: 2,
        pressing: 2,
        tempo: 2,
        width: 2,
        passStyle: 4,
        transition: "regroup",
        tackling: "hard",
        keeperDistribution: "long",
      };
    case "balanced":
      break;
  }
  switch (formation) {
    case "4-3-3":
      return {
        formation,
        mentality: 3,
        defensiveLine: 4,
        pressing: 4,
        tempo: 3,
        width: 4,
        passStyle: 2,
      };
    case "4-2-3-1":
      return {
        formation,
        mentality: 3,
        defensiveLine: 3,
        pressing: 4,
        tempo: 3,
        width: 3,
        passStyle: 2,
      };
    // 두 줄 넷이 **모양으로** 폭을 만들고 길게 갈 자리를 낸다 — 지시로 더 얹지
    // 않는다(3-5-2와 같은 규칙). 얹어 두면(템포·폭·패스 전부 4) 이 프리셋을 쓰는
    // 구단이 늘어날 때 리그 평균이 통째로 그쪽으로 밀린다. 남기는 것은 두 줄이
    // 내려서 기다린다는 것 하나다.
    case "4-4-2":
      return {
        formation,
        mentality: 3,
        defensiveLine: 2,
        pressing: 3,
        tempo: 3,
        width: 3,
        passStyle: 3,
      };
    // 윙백이 폭을 만드는 모양이라 지시로 더 벌리지 않는다 — 여섯 축 전부 중립
    case "3-5-2":
      return {
        formation,
        mentality: 3,
        defensiveLine: 3,
        pressing: 3,
        tempo: 3,
        width: 3,
        passStyle: 3,
      };
    case "5-4-1":
      return {
        formation,
        mentality: 2,
        defensiveLine: 2,
        pressing: 3,
        tempo: 3,
        width: 3,
        passStyle: 4,
      };
    /**
     * 앞을 셋으로 세운 백3 — 무게를 앞에 싣고 높은 곳에서 뺏어 짧게 잇는다.
     * 폭은 윙어 둘이 **모양으로** 만드므로 지시로 벌리지 않고 오히려 안으로
     * 좁혀 연결한다. 올린 둘(멘탈·압박)만큼 내린 둘(폭·패스)이 있다.
     */
    case "3-4-3":
      return {
        formation,
        mentality: 4,
        defensiveLine: 3,
        pressing: 4,
        tempo: 3,
        width: 2,
        passStyle: 2,
      };
    /**
     * 같은 백5지만 5-4-1과 갈리는 자리 — **라인을 내리지 않는다.** 원톱은 받아 줄
     * 사람이 없어 내려서서 길게 차야 하지만, 투톱은 중간에서 막고 그대로 나갈 수
     * 있다. 그래서 내리는 것은 무게 하나뿐이다.
     *
     * ⚠️ **템포·패스를 올리지 않는다.** "백5에 롱볼"로 읽고 싶어지지만 두 축은 리그
     * 평균의 남은 여유가 한 칸의 절반쯤뿐이고, 열댓 구단이 서는 프리셋이 한 칸을
     * 올리면 그 여유를 통째로 먹어 리그 전체가 같은 방향으로 기운다
     * (`match-stamina.test.ts`가 잡는다).
     */
    case "5-3-2":
      return {
        formation,
        mentality: 2,
        defensiveLine: 3,
        pressing: 3,
        tempo: 3,
        width: 3,
        passStyle: 3,
      };
  }
}

export function createGame(input: CreateGameInput): GameState {
  // 세계를 세우기 전에 카탈로그가 성립하는지 먼저 묻는다 — 어긋난 카탈로그로 세운
  // 세계는 실패가 몇 시즌 뒤 엉뚱한 자리에서 터진다 (team.md §1)
  assertCatalogValid();
  const seed = input.seed ?? randInt(makeRng(Date.now() % 2 ** 31, "seed"), 1, 2 ** 30);
  if (!teamCatalog().some((t) => t.id === input.userTeamId)) {
    throw new Error(`알 수 없는 팀: ${input.userTeamId}`);
  }
  const season = FIRST_SEASON;
  const calendar = buildSeasonCalendar(season);
  const rng = makeRng(seed, "ai-managers");
  const world = input.world;
  const catalogTeams = scopedTeams(world);
  const inThisWorld = new Set(catalogTeams.map((t) => t.id));
  if (!inThisWorld.has(input.userTeamId)) {
    throw new Error(`이 세계에 없는 팀: ${input.userTeamId}`);
  }

  // 카탈로그의 정체성은 여기서 **복사된다** — 이후 어드민이 카탈로그를 고쳐도
  // 이 세이브의 이름·소속·체급·살림은 흔들리지 않는다 (team.md §1)
  const profiles = clubProfiles();
  /**
   * **무소속은 클럽이 아니다** — 팀 엔티티 한 줄만 서고 AI 감독도 부임일도 갖지
   * 않는다 (team.md §4).
   */
  const teams: GameTeam[] = catalogTeams.map((t) => ({
    managerSpells: [],
    id: t.id,
    ...copiedTeamFields(t, profiles[t.id]),
    ...(isClubTeam(t.id)
      ? {
          aiManagerTacticsRating: randInt(rng, 55, 82),
          managerSince: calendar.preseasonStart,
          ...seededManagerName(t.id, { userTeamId: input.userTeamId }),
        }
      : {}),
  }));
  const players = instantiatePlayers(seed, (teamId) => inThisWorld.has(teamId));
  // 구단마다 **자기 스쿼드에 맞는 모양**을 먼저 고른다 — 1·2군 분할도 이 모양의
  // 자리를 기준으로 코어를 잡으므로 순서가 여기여야 한다
  const formations = new Map<string, Formation>(
    catalogTeams.map((t) => [
      t.id,
      pickFormation(
        players.filter((p) => p.teamId === t.id),
        t.formation,
        defaultXiIds(t.id),
      ),
    ]),
  );
  buildInitialSquads(players, seed, formations, catalogTeams);
  ensureSquadNumbers(players);

  // 전술·배치 — 구단의 기본 포메이션과 기본 선발로 시작한다 (팀 카탈로그).
  // 무소속은 스쿼드도 배치도 없으므로 전술을 만들지 않는다.
  const tactics: TeamTactics[] = teams
    .filter((t) => isClubTeam(t.id))
    .map((t) => {
      const formation = formations.get(t.id) ?? formationOf(t.id);
      return {
        teamId: t.id,
        spec: initialTactics(t.id, formation),
        assignments: buildAssignments(
          players.filter((p) => p.teamId === t.id && squadLevelOf(p) === "first"),
          formation,
          FAMILIARITY_BASELINE,
          undefined,
          defaultXiIds(t.id),
        ),
      };
    });

  /**
   * 완장 — **카탈로그가 먼저 들고, 없는 자리만 파생이 선다** (people.md §5-1).
   * 실제 그 구단의 주장·부주장이 시드에 있으면 그 사람이 찬다.
   *
   * 시드에 주장이 없으면 실제 선발을 우선 후보로 삼아 완장을 배정한다.
   */
  const catalogById = new Map(playerCatalog().map((entry) => [entry.id, entry] as const));
  const catalogOf = (p: GamePlayer) =>
    p.catalogId === null ? undefined : catalogById.get(p.catalogId);
  const userSquad = players.filter((p) => p.teamId === input.userTeamId);
  const userStartingXi = (tactics.find((t) => t.teamId === input.userTeamId)?.assignments ?? [])
    .filter((a) => a.role === "starting")
    .map((a) => a.playerId);
  const captain =
    userSquad.find((p) => catalogOf(p)?.isCaptain === true) ??
    initialCaptainOf(userSquad, userStartingXi);
  if (captain) captain.isCaptain = true;
  // 파생 주장이 시드의 부주장이면 부주장 자리는 빈다 — 한 사람이 완장 둘을 찰 수 없다
  const vice = userSquad.find((p) => catalogOf(p)?.isViceCaptain === true);
  if (vice && vice.id !== captain?.id) vice.isViceCaptain = true;

  // 재정 + 계약(주급의 원본) — 무소속은 장부를 갖지 않는다 (team.md §4)
  const finances: TeamFinance[] = catalogTeams
    .filter((t) => isClubTeam(t.id))
    .map((t) => {
      const f = initialFinanceOf(t.id, t.tier);
      return {
        teamId: t.id,
        balance: f.balance,
        ledger: [],
        prizesPaid: [],
        assets: [],
      };
    });
  const wages = initialWages(players, calendar.preseasonStart);
  const contracts: Contract[] = players.map((p, i) => {
    // 계약 지위 — 시드가 적은 선수만 든다. 칸이 비어야 `squadStatusOf`가 서열에서
    // 파생하므로, 없는 자리에 칸을 만들어선 안 된다 (people.md §5-2)
    const squadStatus = catalogOf(p)?.squadStatus;
    const contract: Contract = {
      id: `c-${p.id}`,
      gamePlayerId: p.id,
      teamId: p.teamId,
      weeklyWage: wages.get(p.id) ?? 0,
      since: calendar.preseasonStart,
      // 계약 만료를 1~4년 뒤로 분산 — 끝나는 해에 그 선수는 무소속으로 떠난다
      until: contractUntil(calendar.preseasonStart, 1 + (i % 4)),
      status: "active",
      ...(squadStatus === undefined ? {} : { squadStatus }),
    };
    return contract;
  });

  // 일정 — 전 리그 + 유럽 대항전 경기
  // 다른 리그도 같은 캘린더 골격으로 동시에 진행된다
  const euroEntrants = hasCups(world) ? buildEuroEntrants(season, seed) : [];
  const matches = buildSeasonFixtures(
    season,
    seed,
    euroEntrants,
    world,
    undefined,
    input.userTeamId,
  );
  // 일정 축(SCHEDULE_ENTRY)은 **감독의 달력**이다 — 유저 리그 전체 + 유저 팀
  // 대항전 경기만 등록한다. 타 리그·타 팀 대항전은 state.matches에만 있고
  // tick이 간이 시뮬로 소화한다.
  const schedule = buildScheduleEntries(
    matches.filter((m) => isUserFixture(m, input.userTeamId)),
    input.userTeamId,
  );

  const uniqueSuffix = Math.random().toString(36).slice(2, 8);
  const state: GameState = {
    id: `game-${seed.toString(36)}-${uniqueSuffix}`,
    seed,
    createdAt: new Date().toISOString(),
    season,
    // 게임 시작 = 7월 1일 (프리시즌)
    date: calendar.preseasonStart,
    calendar,
    userTeamId: input.userTeamId,
    phase: "idle",
    pendingMatch: null,
    ...(world ? { world } : {}),

    teams,
    players,
    tactics,
    finances,
    financeReports: [],
    contracts,

    schedule,
    matches,
    trainingSessions: [],

    euroEntrants,

    injuries: [],
    bookings: [],
    suspensions: [],
    moves: [],
    negotiations: [],
    transferListings: [],
    transferPayments: [],
    marketReview: { lastDate: null, clubs: [] },
    negotiationRequests: [],
    growthLog: [],
    trainingReports: [],
    seasonStats: [],
    lorebook: [],
    lorebookRevisions: [],
    lorebookJobSequence: 0,
    lorebookJobs: [],
    staffPool: [],
    playerTraining: [],
    roleMemory: [],
    managerInterviews: [],
    // 새 게임의 풀은 비어 있다 — 아직 아무도 자리를 잃지 않았다
    managerPool: [],
    boardRequests: [],
    predictions: [],
    media: [],
    dismissals: [],
    managerOffers: [],
    managerVacancies: [],
    developmentFocus: [],
    retired: [],
    youthCandidates: [],
    callUps: [],

    manager: {
      name: input.managerName,
      background: input.background,
    },
    // 부임하면 사람이 먼저 기다린다 — 수석코치는 시드로 결정되므로
    // 같은 세이브는 언제 열어도 같은 사람이다 (persona.ts)
    personas: [],
    history: [],
    seasonRecords: [],
    trophies: [],
    achievements: [],
    awards: [],
    milestones: [],

    chat: [],
  };

  state.personas = [
    generateHeadCoach(seed, input.userTeamId, calendar.preseasonStart),
    generateOwner(seed, input.userTeamId),
    // 기자단 — 회견은 세계가 먼저 부르는 자리라 부를 사람이 세이브에 있어야 한다
    ...generateReporters(seed, input.userTeamId),
    /**
     * 코치 둘 · 의료진 · 스카우트 — 감독이 오기 전부터 그 구단에 있던 사람들이다
     * (people.md §2-2). 부임일이 오늘보다 앞서는 이유가 그것이다.
     */
    ...generateStaff(seed, input.userTeamId, calendar.preseasonStart),
  ].map((persona) => storePersona(state, persona));

  // 명부 밖 벤치의 가상 감독 — 페르소나가 선 뒤에 채워야 그 이름들을 피해서 뽑는다
  ensureSeededManagers(state);
  // 감독도 계약으로 서 있다 (career.md §5.1) — 부임 구단 등급의 기본 조건.
  // 체급은 세이브가 가지므로 state가 선 뒤에야 읽을 수 있다
  {
    const terms = MANAGER_TERMS_BY_TIER[tierOfTeamIn(state, input.userTeamId)];
    state.manager.contract = {
      salary: terms.salary,
      signedOn: state.date,
      until: contractUntil(state.date, terms.years),
    };
  }
  // 국내 컵 1라운드 추첨일을 미리 달력에 올린다 — tick을 기다리면 부임 첫날의
  // 달력이 비어 보인다 ("리그컵 추첨이 7월 말"이라는 사실은 시작부터 알 수 있다)
  if (hasCups(world)) advanceDomesticCups(state, []);
  // 기본 훈련 — 감독이 부임하기 전부터 팀은 훈련하고 있었다 (training-plan.ts)
  installDefaultTraining(state);
  /**
   * 부임 전 부상 이력 — 선수들에겐 감독을 만나기 전의 몸이 있다 (injury.ts).
   * 조사된 선수만 채워지고, 복귀일이 아직 안 온 선수는 다친 채로 인계된다.
   */
  seedInjuryHistory(state);
  // 통산 캡·골 — 없으면 서른 살 주전이 첫 소집에서 데뷔한다 (competition.md §5-1)
  seedInternationalCaps(state);
  syncLorebook(state);
  refreshStaffPool(state, state.season);
  return state;
}
