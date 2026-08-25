import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PersonaSchema,
  HEAD_COACH_ROLE_LABEL,
  normalizeSpeaker,
  byLoyalty,
  PLAYER_ARCHETYPE_KEYS,
  PLAYER_ARCHETYPE_LABEL,
  PLAYER_ARCHETYPE_TRAITS,
  type GamePlayer,
} from "@story-fm/domain";
import {
  HEAD_COACH_ARCHETYPES,
  HEAD_COACH_NAMES,
  ensurePersonas,
  generateHeadCoach,
  headCoachOf,
  isFamousPlayer,
  speakerRoles,
  ownerOf,
  generateOwner,
  OWNER_ARCHETYPE_LABELS,
  reportersOf,
  generateReporters,
  teamCatalog,
} from "@story-fm/engine";
import {
  applyCharacterMemories,
  CHARACTER_MEMORY_KEEP,
  generateVirtualManager,
  MANAGER_ARCHETYPE_LABELS,
  personaKeywords,
  registerCharacters,
  type CharacterDraft,
} from "../src/world/persona";
import { ensureSeededManagers } from "../src/core/state";
import { worldFigureManagerOf } from "../src/data/world-figures";
import {
  archetypeTraitsOf,
  generatePlayerPersona,
  playerArchetypeOf,
  PLAYER_ARCHETYPE_LABELS,
} from "../src/world/player-persona";
import { personaRelations } from "../src/world/relations";
import { selectCharacters } from "../src/world/character-book";
import type { GameState } from "../src/core/state";
import { createTestGame } from "./helpers";

/**
 * 인물은 **순수 함수가 시드에서 만든다** (`generateHeadCoach` 등). 세계를 세워야
 * 하는 것은 `state.personas`를 읽는 자리(`headCoachOf`·`speakerRoles`·`ensurePersonas`)
 * 뿐이고, 그것도 픽스처 보관을 타는 `createTestGame`으로 충분하다 — 예전엔 이 파일이
 * `createGame`을 열다섯 번 직접 불러 매번 세계를 새로 세웠다.
 */

describe("수석코치 페르소나 — 데이터로 다루는 인물 (people.md §1)", () => {
  it("새 게임에 수석코치가 함께 온다", () => {
    const state = createTestGame();
    const coach = headCoachOf(state);
    expect(() => PersonaSchema.parse(coach)).not.toThrow();
    expect(coach.role).toBe("head_coach");
    // 화자 태그는 직책이 아니라 그 사람의 이름이다
    expect(coach.characterId).toBe(coach.name);
    expect(coach.characterId).not.toBe(HEAD_COACH_ROLE_LABEL);
    expect(HEAD_COACH_ARCHETYPES).toContain(coach.archetype);
    // 말투는 지문만으로 붙지 않는다 — 예시 대사가 함께 있어야 한다 (§6)
    expect(coach.speechStyle.samples.length).toBeGreaterThan(0);
  });

  it("세이브가 담은 사람은 시드가 만든 그 사람이다 (결정적)", () => {
    // 세계가 담아 둔 인물과 순수 함수가 만드는 인물이 같아야 로드가 시드로 복원된다
    expect(headCoachOf(createTestGame(42))).toEqual(generateHeadCoach(42, "arsenal"));
    expect(generateHeadCoach(42, "arsenal")).toEqual(generateHeadCoach(42, "arsenal"));
  });

  it("화자 태그는 직책이 아니라 이름이다 — 옛 세이브도 로드 때 고쳐진다", () => {
    const state = createTestGame(42, "manutd");
    expect(headCoachOf(state).characterId).toBe("스티브 홀랜드");

    // 태그를 직책으로 쓰던 시절의 세이브를 흉내 낸다
    const coach = state.personas!.find((p) => p.role === "head_coach")!;
    coach.characterId = HEAD_COACH_ROLE_LABEL;
    ensurePersonas(state);
    // 이름으로 고쳐지되 사람 자체는 그대로다 (감독이 만난 사람이 바뀌지 않는다)
    expect(headCoachOf(state).characterId).toBe(coach.name);
    expect(headCoachOf(state).archetype).toBe(coach.archetype);
  });

  it("실제 수석코치를 아는 구단은 그 사람이 나온다 — 시드가 달라도 이름은 그대로", () => {
    for (const teamId of Object.keys(HEAD_COACH_NAMES)) {
      const expected = HEAD_COACH_NAMES[teamId]!;
      // 이름은 구단이 정하고, 사람됨(원형)만 시드가 정한다
      for (const seed of [1, 42, 777]) {
        const coach = generateHeadCoach(seed, teamId);
        expect(coach.name, teamId).toBe(expected);
        expect(coach.real, teamId).toBe(true);
      }
      // 성격은 여전히 시드로 갈린다 (같은 이름이라도 세이브마다 다른 사람됨)
      const archetypes = new Set(
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((s) => generateHeadCoach(s, teamId).archetype),
      );
      expect(archetypes.size, teamId).toBeGreaterThan(1);
    }
  });

  it("실명을 모르는 구단은 리그 국적에 맞는 가상 이름을 쓴다", () => {
    // 실명 표에 없는 팀 — 실존 인물 표식이 붙지 않는다
    const coach = generateHeadCoach(42, "dortmund");
    expect(HEAD_COACH_NAMES).not.toHaveProperty("dortmund");
    expect(coach.real).toBeUndefined();

    // 나라가 다르면 이름의 결도 다르다 (아스날에 "안드레 페레스"가 나오지 않는다)
    // 실명이 없는 팀만 — 실명 팀은 표의 이름을 그대로 쓰므로 국적 풀과 무관하다
    const byCountry = ["dortmund", "sevilla", "lecce", "nice"].map(
      (t) => generateHeadCoach(42, t).name,
    );
    expect(new Set(byCountry).size).toBe(byCountry.length);
  });

  it("다른 세이브·다른 구단이면 다른 사람을 만난다", () => {
    // 실명을 모르는 팀은 이름까지 세이브마다 갈린다
    const names = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((seed) => generateHeadCoach(seed, "dortmund").name),
    );
    expect(names.size).toBeGreaterThan(1);
    // 부임한 곳이 다르면 만나는 사람도 다르다 (같은 시드라도)
    expect(generateHeadCoach(42, "arsenal")).not.toEqual(generateHeadCoach(42, "chelsea"));
  });

  it("원형마다 먼저 보는 것이 다르다 — 성격·동기·말투가 함께 움직인다", () => {
    const seen = new Map<string, string>();
    for (let seed = 1; seed <= 60; seed++) {
      const coach = generateHeadCoach(seed, "arsenal");
      const previous = seen.get(coach.archetype);
      // 같은 원형이면 성격·동기·말투가 항상 같은 묶음이다
      if (previous) expect(previous).toBe(coach.traits.join("/") + coach.motivation);
      else seen.set(coach.archetype, coach.traits.join("/") + coach.motivation);
    }
    // 60개 시드면 원형이 골고루 나온다
    expect(seen.size).toBe(HEAD_COACH_ARCHETYPES.length);
  });

  it("화면이 붙일 직책 맵을 준다 — 모델 출력에 기대지 않는다", () => {
    const state = createTestGame(42, "manutd");
    const roles = speakerRoles(state);
    // 키는 정규화된 이름 — 사전을 만들 때와 찾을 때가 같은 함수를 쓴다
    expect(roles[normalizeSpeaker("스티브 홀랜드")]).toEqual({
      kind: "head_coach",
      label: HEAD_COACH_ROLE_LABEL,
    });
    // 모델이 공백을 다르게 써도 같은 자리를 찾는다
    expect(roles[normalizeSpeaker("스티브홀랜드")]?.label).toBe(HEAD_COACH_ROLE_LABEL);
  });

  it("자리를 아는 화자는 다 알려 준다 — 주장도", () => {
    const state = createTestGame(42, "manutd");
    const captain = state.players.find((p) => p.teamId === "manutd" && p.isCaptain)!;
    expect(speakerRoles(state)[normalizeSpeaker(captain.name)]).toEqual({
      kind: "captain",
      label: "주장",
    });
  });

  it("우리 선수는 직책 없이 자리만 갖는다 — 대화마다 (선수)는 시끄럽다", () => {
    const state = createTestGame(42, "manutd");
    const roles = speakerRoles(state);
    const squad = state.players.filter((p) => p.teamId === "manutd" && p.isCaptain !== true);
    const known = squad.filter((p) => roles[normalizeSpeaker(p.name)] !== undefined);
    // 동명이인으로 빠지는 몇을 빼면 선수단 대부분이 사전에 있다
    expect(known.length).toBeGreaterThan(squad.length - 3);
    for (const p of known) {
      expect(roles[normalizeSpeaker(p.name)]).toEqual({ kind: "player" });
    }
  });

  it("남의 팀 선수는 협상 테이블에 앉았을 때만 사전에 든다", () => {
    const state = createTestGame(42, "manutd");
    // 이름난 현역은 협상 없이도 사전에 있다 — 이 테스트의 자리는 무명의 것이다
    const outsider = state.players.find(
      (p) => p.teamId !== "manutd" && !isFamousPlayer(p.attributes.overall, p.name),
    )!;
    expect(speakerRoles(state)[normalizeSpeaker(outsider.name)]).toBeUndefined();

    state.negotiations.push({
      id: "neg-1",
      gamePlayerId: outsider.id,
      kind: "buy",
      counterpartTeamId: outsider.teamId,
      windowId: null,
      openedOn: state.date,
      expiresOn: state.date,
      status: "open",
      rounds: [],
    });
    expect(speakerRoles(state)[normalizeSpeaker(outsider.name)]).toEqual({ kind: "player" });
  });

  it("합의 뒤 메디컬을 기다리는 선수도 사전에 남는다 — open만 보면 자리가 사라진다", () => {
    const state = createTestGame(42, "manutd");
    const outsider = state.players.find((p) => p.teamId !== "manutd")!;
    state.negotiations.push({
      id: "neg-2",
      gamePlayerId: outsider.id,
      kind: "buy",
      counterpartTeamId: outsider.teamId,
      windowId: null,
      openedOn: state.date,
      expiresOn: state.date,
      status: "agreed",
      rounds: [],
      medical: { onDate: state.date, status: "scheduled" },
    });
    expect(speakerRoles(state)[normalizeSpeaker(outsider.name)]).toEqual({ kind: "player" });
  });

  it("끝난 협상은 화자를 남기지 않는다", () => {
    for (const status of ["completed", "rejected", "expired"] as const) {
      const state = createTestGame(42, "manutd");
      const outsider = state.players.find(
        (p) => p.teamId !== "manutd" && !isFamousPlayer(p.attributes.overall, p.name),
      )!;
      state.negotiations.push({
        id: `neg-${status}`,
        gamePlayerId: outsider.id,
        kind: "buy",
        counterpartTeamId: outsider.teamId,
        windowId: null,
        openedOn: state.date,
        expiresOn: state.date,
        status,
        rounds: [],
      });
      expect(speakerRoles(state)[normalizeSpeaker(outsider.name)], status).toBeUndefined();
    }
  });

  it("이름이 겹치면 아무것도 붙이지 않는다 — 틀린 직책보다 없는 게 낫다", () => {
    const state = createTestGame(42, "manutd");
    const coach = headCoachOf(state);
    // 코치와 같은 이름의 주장이 있는 상황을 만든다
    const captain = state.players.find((p) => p.teamId === "manutd" && p.isCaptain)!;
    captain.name = coach.name;
    expect(speakerRoles(state)[normalizeSpeaker(coach.name)]).toBeUndefined();
  });

  it("세계 인물 명부가 직책 라벨과 함께 선다 — 유저 팀의 명부 감독만 빠진다", () => {
    const roles = speakerRoles({ seed: 1, userTeamId: "manutd" });
    expect(roles[normalizeSpeaker("펩 과르디올라")]).toEqual({ kind: "manager", label: "감독" });
    expect(roles[normalizeSpeaker("조르제 멘데스")]).toEqual({ kind: "agent", label: "에이전트" });
    expect(roles[normalizeSpeaker("게리 네빌")]).toEqual({ kind: "pundit", label: "해설위원" });
    // 유저가 맡은 팀의 명부 감독은 이 세계에 부임한 적이 없다
    expect(
      speakerRoles({ seed: 1, userTeamId: "mancity" })[normalizeSpeaker("펩 과르디올라")],
    ).toBeUndefined();
  });

  it("이름난 현역이 사전에 든다 — 아이콘만, 이미 찬 자리는 넘보지 않는다", () => {
    const roles = speakerRoles({
      seed: 1,
      userTeamId: "manutd",
      players: [
        { name: "우리 주장", teamId: "manutd", isCaptain: true },
        // 주장과 동명의 남의 팀 스타 — 뒤 겹은 완장을 밀어내지 못한다
        { name: "우리 주장", teamId: "chelsea", attributes: { overall: 90 } },
        { name: "남의 팀 스타", teamId: "chelsea", attributes: { overall: 82 } },
        { name: "무명 선수", teamId: "chelsea", attributes: { overall: 81 } },
        // 능력치가 답하지 못하는 레전드 — 시장 리그 시드 명단이 답한다
        { name: "리오넬 메시", teamId: "intermiami", attributes: { overall: 80 } },
      ],
    });
    expect(roles[normalizeSpeaker("남의 팀 스타")]).toEqual({ kind: "player" });
    expect(roles[normalizeSpeaker("리오넬 메시")]).toEqual({ kind: "player" });
    expect(roles[normalizeSpeaker("무명 선수")]).toBeUndefined();
    expect(roles[normalizeSpeaker("우리 주장")]).toEqual({ kind: "captain", label: "주장" });
  });

  it("personas가 빈 배열이어도 직책이 사라지지 않는다", () => {
    const state = createTestGame(42, "manutd");
    // `?? `만 쓰면 빈 배열을 "있음"으로 봐서 사전이 통째로 비었다 (회귀 방지)
    state.personas = [];
    expect(speakerRoles(state)[normalizeSpeaker("스티브 홀랜드")]?.label).toBe(
      HEAD_COACH_ROLE_LABEL,
    );
  });

  it("구단주도 데이터다 — 만날 때마다 같은 사람, 코치와 다른 사람", () => {
    const state = createTestGame(7, "manutd");
    const owner = ownerOf(state);
    expect(owner.role).toBe("owner");
    // 실명을 아는 구단이면 그 사람이 나온다 (owner-seeds)
    expect(owner.name).toBe("짐 랫클리프");
    expect(owner.real).toBe(true);
    // 같은 세이브는 언제 열어도 같은 사람
    expect(generateOwner(7, "manutd")).toEqual(owner);
    // 코치와 원형이 같은 통에서 나오면 두 사람이 겹친다 — 시드 채널이 다르다
    expect(owner.archetype).not.toBe(headCoachOf(state).archetype);
    expect(OWNER_ARCHETYPE_LABELS).toContain(owner.archetype);
  });

  it("구단주를 모르는 구단은 실명을 쓰지 않는다", () => {
    // 시드 표에 없는 팀 — 리그 국적에 맞는 가상 이름이 선다
    const owner = generateOwner(7, "brentford");
    expect(owner.real).toBeUndefined();
    expect(owner.name).not.toBe("");
  });

  it("화자 사전이 구단주의 자리를 안다 — 화면이 아이콘·직책을 붙일 재료", () => {
    const state = createTestGame(7, "manutd");
    const roles = speakerRoles(state);
    expect(roles[normalizeSpeaker("짐 랫클리프")]).toEqual({
      kind: "owner",
      label: "구단주",
    });
  });

  it("구단주가 없던 세이브는 로드 때 채워진다 (버전을 올리지 않는다)", () => {
    const state = createTestGame(7, "manutd");
    const expected = ownerOf(state);
    // 수석코치만 있던 시절의 세이브
    state.personas = state.personas!.filter((p) => p.role === "head_coach");
    ensurePersonas(state);
    expect(ownerOf(state)).toEqual(expected);
    // 수석코치 · 구단주 · 기자 셋
    expect(state.personas).toHaveLength(5);
  });

  it("페르소나가 없는 옛 세이브는 로드 때 채워진다 (버전을 올리지 않는다)", () => {
    const state = createTestGame(7);
    const expected = headCoachOf(state);
    // 페르소나 도입 전 세이브를 흉내 낸다
    delete state.personas;
    ensurePersonas(state);
    // 시드로 만들었으므로 "그 세이브의 코치"가 그대로 복원된다
    expect(headCoachOf(state)).toEqual(expected);
    // 자리를 아는 인물 — 수석코치 · 구단주 · 기자 셋
    expect(state.personas).toHaveLength(5);
  });

  it("이미 있으면 덮어쓰지 않는다 (감독이 만난 사람이 바뀌지 않는다)", () => {
    const state = createTestGame(7);
    const coach = headCoachOf(state);
    ensurePersonas(state);
    ensurePersonas(state);
    // 여러 번 불러도 인물이 늘지 않는다 (수석코치 · 구단주 · 기자 셋)
    expect(state.personas).toHaveLength(5);
    expect(headCoachOf(state)).toEqual(coach);
  });
});

/**
 * 기자단 — 회견은 **세계가 먼저 부르는 자리**라, 부를 사람이 세이브에 있어야 한다.
 * 없으면 GM이 즉흥으로 지어내 매번 다른 기자가 묻는다.
 */
describe("기자 페르소나", () => {
  it("새 게임에 셋이 함께 만들어진다 — 결이 서로 다르다", () => {
    const state = createTestGame(5);
    const reporters = reportersOf(state);
    expect(reporters).toHaveLength(3);
    // 소속이 다르면 무엇을 먼저 묻는지가 갈린다
    expect(new Set(reporters.map((r) => r.outlet)).size).toBe(3);
    for (const r of reporters) {
      expect(r.characterId).toBe(r.name); // 태그는 직책이 아니라 이름이다
      expect(r.speechStyle.samples.length).toBeGreaterThan(0);
    }
  });

  it("같은 시드는 같은 기자를 만난다", () => {
    expect(reportersOf(createTestGame(9)).map((r) => r.name)).toEqual(
      reportersOf(createTestGame(9)).map((r) => r.name),
    );
    expect(reportersOf(createTestGame(9))[0]?.name).not.toBe(
      reportersOf(createTestGame(10))[0]?.name,
    );
  });

  it("리그가 다르면 그 리그 국가의 이름을 쓴다", () => {
    const epl = generateReporters(42, "arsenal").map((r) => r.name);
    const laliga = generateReporters(42, "realmadrid").map((r) => r.name);
    expect(laliga).not.toEqual(epl);
    // 같은 리그의 다른 구단은 같은 사람 — 기준이 팀이 아니라 리그다
    expect(generateReporters(42, "sevilla").map((r) => r.name)).toEqual(laliga);
    // 2부도 같은 협회 아래다 — 세리에 B 클럽이면 이탈리아 이름 풀
    expect(generateReporters(42, "sampdoria").map((r) => r.name)).toEqual(
      generateReporters(42, "milan").map((r) => r.name),
    );
    // 이름 풀이 없는 리그(사우디)는 기본 풀로 떨어진다
    expect(generateReporters(42, "alhilal").map((r) => r.name)).toEqual(epl);
  });

  it("화면에는 직책 대신 매체가 붙는다 — 아이콘이 '기자'를 이미 말한다", () => {
    const state = createTestGame(5);
    const roles = speakerRoles(state);
    for (const r of reportersOf(state)) {
      const seat = roles[normalizeSpeaker(r.name)];
      expect(seat?.kind).toBe("reporter");
      expect(seat?.label).toBe(r.outlet);
    }
  });

  it("기자가 없던 세이브도 로드하면 채워진다", () => {
    const state = createTestGame(5);
    state.personas = state.personas?.filter((p) => p.role !== "reporter");
    ensurePersonas(state);
    expect(reportersOf(state)).toHaveLength(3);
  });
});

/**
 * 다섯이 같은 풀에서 독립 추첨하던 자리다 — 겹치면 `speakerRoles`가 둘 다
 * 포기해 **직책과 아이콘이 함께 사라진다** (people.md §1 · §2).
 */
describe("인물 이름의 유일성", () => {
  it("한 세이브의 다섯(수석코치·구단주·기자 3인)은 이름이 서로 겹치지 않는다", () => {
    const clashing: string[] = [];
    for (const seed of [1, 7, 42, 99, 2026]) {
      for (const team of teamCatalog()) {
        const names = [
          generateHeadCoach(seed, team.id).characterId,
          generateOwner(seed, team.id).characterId,
          ...generateReporters(seed, team.id).map((r) => r.characterId),
        ].map(normalizeSpeaker);
        if (new Set(names).size !== names.length) clashing.push(`${seed}:${team.id}`);
      }
    }
    expect(clashing).toEqual([]);
  });

  it("화자 사전이 인물 전원의 자리를 안다 — 이름이 겹쳐 생략되는 자리가 없다", () => {
    for (const seed of [3, 11]) {
      const state = createTestGame(seed);
      const roles = speakerRoles(state);
      for (const persona of state.personas ?? []) {
        expect(roles[normalizeSpeaker(persona.characterId)]?.kind, persona.name).toBe(persona.role);
      }
    }
  });
});

/**
 * 선수 페르소나 — **저장하지 않고 (시드, 선수 id)에서 파생한다** (people.md §6).
 *
 * 값어치가 있는 것은 **결정성**이다: 같은 세이브는 언제 열어도 같은 사람을 만나고,
 * 시즌이 흘러 나이가 바뀌어도 사람됨은 그대로다. 원형 라벨의 문구는 테스트하지 않는다.
 */
describe("선수 페르소나 — 파생되는 카드", () => {
  // 세계는 세우지 않는다 — 원본 하나를 복제해 나이·포지션만 바꾼 순수 입력을 만든다
  const basePlayer = createTestGame().players[0]!;
  const playerLike = (id: string, position: string, birthdate: string): GamePlayer => ({
    ...basePlayer,
    id,
    name: `가상 ${id}`,
    birthdate,
    positions: [{ position, proficiency: 85, isNatural: true }],
  });
  const youngStriker = playerLike("p-young-st", "ST", "2007-04-11");
  const veteranCentreBack = playerLike("p-vet-cb", "CB", "1993-02-20");
  const samples = [
    youngStriker,
    veteranCentreBack,
    playerLike("p-prime-st", "ST", "1999-09-01"),
    playerLike("p-prime-gk", "GK", "1997-05-30"),
    playerLike("p-young-cm", "CM", "2006-01-15"),
    playerLike("p-vet-cf", "CF", "1992-11-03"),
  ];

  it("같은 (시드, 선수)는 언제나 같은 사람이다 — 세이브가 담지 않아도 복원된다", () => {
    expect(generatePlayerPersona(7, youngStriker)).toEqual(generatePlayerPersona(7, youngStriker));
    // 화자 태그는 직책이 아니라 이름이다 (코치와 같은 규약)
    expect(generatePlayerPersona(7, youngStriker).characterId).toBe(youngStriker.name);
    // 세이브가 다르면 다른 사람을 만난다
    const archetypes = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => generatePlayerPersona(seed, youngStriker).archetype),
    );
    expect(archetypes.size).toBeGreaterThan(1);
    // 시드 채널은 이름이 아니라 **id**다 — 동명이인도, 이적한 선수도 같은 사람이다
    expect(
      generatePlayerPersona(7, { ...youngStriker, name: "다른 이름", teamId: "chelsea" }).archetype,
    ).toBe(generatePlayerPersona(7, youngStriker).archetype);
    // 선수가 다르면 각자의 추첨을 탄다
    const byPlayer = new Set(
      Array.from(
        { length: 12 },
        (_, i) => generatePlayerPersona(7, { ...youngStriker, id: `p-${i}` }).archetype,
      ),
    );
    expect(byPlayer.size).toBeGreaterThan(1);
  });

  it("나이가 흘러도 같은 사람이다 — 기준일이 고정이라 시즌이 바뀌어도 흔들리지 않는다", () => {
    const before = samples.map((p) => generatePlayerPersona(7, p).archetype);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2032-03-01T00:00:00Z"));
      expect(samples.map((p) => generatePlayerPersona(7, p).archetype)).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("원형 전수가 스키마를 통과한다 — 성격·동기·말투가 한 묶음으로 온다", () => {
    const seen = new Map<string, string>();
    for (const player of samples) {
      for (let seed = 1; seed <= 120; seed++) {
        const persona = generatePlayerPersona(seed, player);
        expect(() => PersonaSchema.parse(persona)).not.toThrow();
        expect(persona.role).toBe("player");
        // 말투는 지문만으로 붙지 않는다 — 예시 대사가 함께 있어야 한다
        expect(persona.speechStyle.samples.length).toBeGreaterThan(0);
        const bundle = persona.traits.join("/") + persona.motivation;
        const previous = seen.get(persona.archetype);
        if (previous) expect(previous).toBe(bundle);
        else seen.set(persona.archetype, bundle);
      }
    }
    expect([...seen.keys()].sort()).toEqual([...PLAYER_ARCHETYPE_LABELS].sort());
  });

  it("나이와 포지션이 확률을 기울인다 — 국적은 걸지 않는다", () => {
    const countOf = (player: GamePlayer, label: string) =>
      Array.from({ length: 300 }, (_, i) => generatePlayerPersona(i + 1, player).archetype).filter(
        (a) => a === label,
      ).length;
    // 어린 공격수 쪽에 야심가가, 노장 수비수 쪽에 라커룸 리더가 더 자주 선다
    expect(countOf(youngStriker, "야심가형")).toBeGreaterThan(
      countOf(veteranCentreBack, "야심가형"),
    );
    expect(countOf(veteranCentreBack, "라커룸 리더")).toBeGreaterThan(
      countOf(youngStriker, "라커룸 리더"),
    );
    // 나이가 라벨과 어긋나는 자리는 아예 서지 않는다
    expect(countOf(veteranCentreBack, "불안한 유망주")).toBe(0);
    expect(countOf(youngStriker, "불안한 유망주")).toBeGreaterThan(0);
  });

  /**
   * 카드를 짓는 쪽과 계수를 읽는 쪽이 **한 뽑기**를 지난다 — 갈리면 GM이 연기하는
   * 사람과 장부가 그에게 붙이는 사실이 어긋난다 (people.md §6).
   */
  it("코드와 라벨과 계수가 한 행이다 — 카드를 짓지 않고 뽑기만 해도 같은 사람이다", () => {
    for (const player of samples) {
      for (let seed = 1; seed <= 40; seed++) {
        const key = playerArchetypeOf(seed, player);
        expect(PLAYER_ARCHETYPE_LABEL[key]).toBe(generatePlayerPersona(seed, player).archetype);
        expect(archetypeTraitsOf(seed, player)).toBe(PLAYER_ARCHETYPE_TRAITS[key]);
      }
    }
    // 표에 빠진 행이 있으면 그 원형만 계수 없이 산다
    expect(Object.keys(PLAYER_ARCHETYPE_TRAITS).sort()).toEqual([...PLAYER_ARCHETYPE_KEYS].sort());
    expect(Object.values(PLAYER_ARCHETYPE_LABEL).sort()).toEqual(
      [...PLAYER_ARCHETYPE_LABELS].sort(),
    );
  });

  /**
   * **남을 이유는 곱하고 떠날 이유는 나눈다** (transfer.md §3).
   *
   * 축을 하나 늘리지 않고 기존 두 축을 기울이는 규칙이라, 부호를 헷갈리면 애착형이
   * 먼저 팀을 뜨는 정반대 세계가 조용히 선다.
   */
  it("충성은 남을 이유를 키우고 떠날 이유를 줄인다", () => {
    const [loyal, restless] = [1.45, 0.6];
    // 남을 이유 — 애착이 크면 더 크게, 작으면 더 작게
    expect(byLoyalty(0.6, loyal, "stay")).toBeGreaterThan(0.6);
    expect(byLoyalty(0.6, restless, "stay")).toBeLessThan(0.6);
    // 떠날 이유 — 부호는 그대로이고 크기만 줄거나 는다
    expect(byLoyalty(-0.7, loyal, "leave")).toBeGreaterThan(-0.7);
    expect(byLoyalty(-0.7, loyal, "leave")).toBeLessThan(0);
    expect(byLoyalty(0.5, restless, "leave")).toBeGreaterThan(0.5);
    // 애착이 평범하면 아무것도 움직이지 않는다
    for (const means of ["stay", "leave"] as const) expect(byLoyalty(0.4, 1, means)).toBe(0.4);
    // 표의 어느 행도 부호를 뒤집지 않는다
    for (const key of PLAYER_ARCHETYPE_KEYS) {
      const { loyalty } = PLAYER_ARCHETYPE_TRAITS[key];
      expect(loyalty, key).toBeGreaterThan(0);
      for (const means of ["stay", "leave"] as const) {
        expect(Math.sign(byLoyalty(-0.6, loyalty, means)), `${key}/${means}`).toBe(-1);
        expect(Math.sign(byLoyalty(0.6, loyalty, means)), `${key}/${means}`).toBe(1);
      }
    }
  });

  /**
   * **전력 패킷과 xG는 원형을 읽지 않는다** (people.md 요구사항 3).
   *
   * 런타임으로는 증명할 수 없는 부재다 — 원형이 선수 id의 파생이라 원형만 바꿔 같은
   * 경기를 두 번 돌릴 수 없다. 그래서 경계를 **읽는 자리가 없다**로 잰다: 이 폴더들이
   * 원형을 이름으로도 부르지 않으면 경기 결과는 사람됨을 모른다.
   */
  it("경기 코어는 원형을 이름으로도 부르지 않는다", () => {
    const roots = ["../../sim/src", "../src/match"];
    const banned = /archetype|ARCHETYPE|player-persona/u;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts") && banned.test(readFileSync(path, "utf8"))) {
          offenders.push(path);
        }
      }
    };
    for (const root of roots) walk(join(__dirname, root));
    expect(offenders).toEqual([]);
  });
});

describe("가상 감독 — 명부 밖 벤치의 사람 (people.md §2)", () => {
  it("같은 (시드, 팀, 이름)이면 같은 사람이다 — 저장하지 않아도 복원된다", () => {
    const manager = generateVirtualManager(42, "dortmund", "옌스 바그너");
    expect(manager).toEqual(generateVirtualManager(42, "dortmund", "옌스 바그너"));
    expect(() => PersonaSchema.parse(manager)).not.toThrow();
    expect(manager.role).toBe("manager");
    expect(manager.characterId).toBe("옌스 바그너");
    expect(MANAGER_ARCHETYPE_LABELS).toContain(manager.archetype);
    // 지어낸 이름이라 실존 표식이 없다 — 실명 부채 장부가 셀 것도 없다
    expect(manager.real).toBeUndefined();
    // 키워드는 명부 규칙 그대로 — 전체 이름과 성, 이름 조각은 담지 않는다
    expect(manager.keywords).toEqual(["옌스 바그너", "바그너"]);
  });

  it("이름이 시드 채널에 들어간다 — 경질로 이름이 갈리면 새 추첨이다", () => {
    const names = ["가브리엘 로시", "마르코 벨리", "루카 페라리", "엔조 콘티", "다비드 리치"];
    const labels = new Set(names.map((n) => generateVirtualManager(42, "lecce", n).archetype));
    // 같은 (시드, 팀)이라도 이름이 다르면 독립 추첨 — 후임이 전임의 사람됨을 물려받지 않는다
    expect(labels.size).toBeGreaterThan(1);
  });

  it("모든 클럽 벤치에 감독이 선다 — 명부가 먼저, 이름은 겹치지 않고, 유저 팀만 빈다", () => {
    const state = createTestGame();
    // 유저 팀 벤치는 유저의 것
    expect(state.teams.find((t) => t.id === state.userTeamId)?.managerName).toBeUndefined();
    // 클럽(AI 감독 역량치를 받은 팀)인데 이름 없는 벤치가 없다
    const clubs = state.teams.filter(
      (t) => t.aiManagerTacticsRating !== undefined && t.id !== state.userTeamId,
    );
    expect(clubs.length).toBeGreaterThan(0);
    for (const team of clubs) expect(team.managerName, team.id).toBeDefined();
    // 명부의 벤치는 명부의 그 사람
    expect(state.teams.find((t) => t.id === "mancity")?.managerName).toBe("펩 과르디올라");
    // 이름이 곧 characterId(전역 유일) — 벤치끼리도, 우리 구단 인물·유저와도 겹치지 않는다
    const names = clubs.map((t) => t.managerName!);
    const occupied = new Set([...state.personas!.map((p) => p.name), state.manager.name]);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(occupied.has(name), name).toBe(false);
  });

  it("빈 벤치는 로드 보정이 채운다 — 채워도 같은 사람이다 (버전을 올리지 않는다)", () => {
    const state = createTestGame();
    const before = state.teams.map((t) => t.managerName);
    for (const team of state.teams) if (team.id !== state.userTeamId) delete team.managerName;
    ensureSeededManagers(state);
    // (시드, 팀) 채널이라 다시 채워도 그 벤치의 사람은 같다
    expect(state.teams.map((t) => t.managerName)).toEqual(before);
  });

  it("화자 사전과 캐릭터북이 상대 벤치를 안다 — 감독 라벨, 이름으로 걸리는 카드", () => {
    const state = createTestGame();
    const bench = state.teams.find(
      (t) =>
        t.id !== state.userTeamId &&
        t.managerName !== undefined &&
        worldFigureManagerOf(t.id) === null,
    )!;
    const name = bench.managerName!;
    // 화면이 붙일 직책 — 명부 감독과 같은 자리다
    expect(speakerRoles(state)[normalizeSpeaker(name)]).toEqual({ kind: "manager", label: "감독" });
    // 이름이 불리면 카드가 선다 — 파생이라 세이브에 없어도 같은 사람이 복원된다
    const cards = selectCharacters(state, { message: name });
    const card = cards.find((c) => c.characterId === name)!;
    expect(card.role).toBe("manager");
    expect(card.depth).toBe("full");
    expect(MANAGER_ARCHETYPE_LABELS).toContain(card.archetype);
  });
});

/**
 * 캐릭터북 키워드 — **나열한 것만 본다** (people.md §6). 만드는 자리가 한 곳이라
 * 자리마다 다른 규칙이 생기지 않는다.
 */
describe("페르소나 키워드", () => {
  it("이름과 이름 조각이 키워드가 된다 — 두 글자 미만은 되지 못한다", () => {
    const keywords = personaKeywords({ name: "스티브 홀랜드", role: "player" });
    expect(keywords).toContain("스티브 홀랜드");
    expect(keywords).toContain("홀랜드");
    // 중복도 한 글자도 남지 않는다
    expect(new Set(keywords).size).toBe(keywords.length);
    expect(personaKeywords({ name: "박 지", role: "player" })).toEqual(["박 지"]);
  });

  it("자리를 부르는 말이 함께 걸린다 — 매 턴 나오는 말은 넣지 않는다", () => {
    const coach = generateHeadCoach(42, "manutd");
    expect(coach.keywords).toEqual(expect.arrayContaining(["수석코치", "코치", coach.name]));
    const owner = generateOwner(42, "manutd");
    expect(owner.keywords).toEqual(expect.arrayContaining(["구단주", "회장", "보드"]));
    const reporter = generateReporters(42, "arsenal")[0]!;
    expect(reporter.keywords).toEqual(
      expect.arrayContaining(["기자", "회견", "인터뷰", reporter.outlet!]),
    );
    // "이적"처럼 매 턴 나오는 말이 한 턴 상한 3장을 다 채우면 불린 사람이 밀린다
    for (const persona of [coach, owner, reporter]) expect(persona.keywords).not.toContain("이적");
  });

  it("키워드가 없던 옛 세이브는 로드가 채운다 — 선수는 만들지 않는다", () => {
    const state = createTestGame(7);
    for (const persona of state.personas ?? []) delete persona.keywords;
    ensurePersonas(state);
    for (const persona of state.personas ?? []) {
      expect(persona.keywords?.length, persona.name).toBeGreaterThan(0);
      expect(persona.keywords).toContain(persona.name);
    }
    // 선수 페르소나는 파생이라 세이브에 들어가지 않는다
    expect(state.personas?.some((p) => p.role === "player")).toBe(false);
    expect(state.personas).toHaveLength(5);
  });
});

/**
 * 캐릭터북 갱신 — 이력이 접힐 때 LLM에 맡기는 둘 (people.md §9-1).
 * 성격·동기·말투는 시드의 것이고, 코어가 검사해 통과한 것만 세이브에 남는다.
 */
describe("캐릭터북 갱신", () => {
  const draftOf = (over: Partial<CharacterDraft> = {}): CharacterDraft => ({
    characterId: "미란다 코스타",
    name: "미란다 코스타",
    role: "friend",
    archetype: "옛 동료",
    traits: ["직설적", "오래 봤다"],
    motivation: "감독이 무너지지 않게 옆에 있고 싶다.",
    speechStyle: { note: "반말. 짧게 자른다.", samples: ["그만 좀 해. 얼굴이 말이 아니야."] },
    ...over,
  });

  it("이름이 이미 선 화자와 겹치면 등록하지 않는다", () => {
    const state = createTestGame();
    const before = state.personas!.length;
    const squadName = state.players.find((p) => p.teamId === state.userTeamId)!.name;

    // 우리 선수와 같은 이름의 에이전트 — 화면이 두 사람을 한 사람으로 읽는다
    expect(registerCharacters(state, [draftOf({ characterId: squadName, name: squadName })])).toBe(
      0,
    );
    // 공백만 다른 이름도 같은 사람이다 (normalizeSpeaker)
    const spaced = squadName.replace(/\s+/gu, "");
    expect(registerCharacters(state, [draftOf({ characterId: spaced, name: spaced })])).toBe(0);
    expect(state.personas).toHaveLength(before);

    // 겹치지 않는 이름은 선다 — 시드와 키워드는 코어가 채운다
    expect(registerCharacters(state, [draftOf()])).toBe(1);
    const added = state.personas!.find((p) => p.characterId === "미란다 코스타")!;
    expect(() => PersonaSchema.parse(added)).not.toThrow();
    expect(added.keywords).toEqual(expect.arrayContaining(["미란다 코스타", "코스타"]));
    // 같은 세이브는 같은 사람을 만난다
    const twin = createTestGame();
    registerCharacters(twin, [draftOf()]);
    expect(twin.personas!.at(-1)!.seed).toBe(added.seed);
    // 두 번째 등록은 이름이 이미 서 있어 걸린다
    expect(registerCharacters(state, [draftOf()])).toBe(0);
  });

  it("이미 있는 characterId는 자리를 지킨다 — 성격도 말투도 덮이지 않는다", () => {
    const state = createTestGame();
    const coach = headCoachOf(state);
    const before = structuredClone(coach);

    expect(
      registerCharacters(state, [
        draftOf({
          characterId: coach.characterId,
          name: coach.name,
          role: "friend",
          archetype: "지어낸 원형",
          traits: ["LLM이 적은 성격"],
          speechStyle: { note: "지어낸 말투.", samples: ["지어낸 대사."] },
        }),
      ]),
    ).toBe(0);
    expect(state.personas!.find((p) => p.role === "head_coach")).toEqual(before);
  });

  it("자리가 하나뿐인 역할과 선수는 등록할 수 없다", () => {
    const state = createTestGame();
    const before = state.personas!.length;
    for (const role of ["head_coach", "owner", "player"] as const) {
      expect(
        registerCharacters(state, [
          draftOf({ characterId: `새 ${role}`, name: `새 ${role}`, role }),
        ]),
        role,
      ).toBe(0);
    }
    expect(state.personas).toHaveLength(before);
  });

  it("명부와 리그의 이름 위에는 등록할 수 없고, 그 앞으로 적힌 기억은 반영된다", () => {
    const state = createTestGame();
    const before = state.personas!.length;

    // 명부 이름으로 friend를 세우면 캐릭터북이 등록본을 먼저 찾아 표의 인격이 가려진다
    expect(
      registerCharacters(state, [draftOf({ characterId: "조제 무리뉴", name: "조제 무리뉴" })]),
    ).toBe(0);
    // 사전 밖 리그 선수의 이름도 이 세계가 이미 아는 이름이다 — 파생 선수가 가려진다
    const outsider = state.players.find((p) => p.teamId !== state.userTeamId)!;
    expect(
      registerCharacters(state, [draftOf({ characterId: outsider.name, name: outsider.name })]),
    ).toBe(0);
    expect(state.personas).toHaveLength(before);

    // 압축이 적은 명부 인물·파생 선수의 기억은 조용히 버려지지 않는다
    expect(
      applyCharacterMemories(state, [
        { characterId: "조르제 멘데스", text: "재계약 조건을 두고 한 차례 부딪혔다" },
        { characterId: outsider.name, text: "경기 뒤 터널에서 짧게 인사를 나눴다" },
      ]),
    ).toBe(2);
  });

  it("화자가 아닌 이름의 기억은 버려지고, 인물당 상한을 넘으면 오래된 것부터 밀린다", () => {
    const state = createTestGame();
    const coach = headCoachOf(state);

    // GM이 지어낸 이름에 붙인 기억은 아무에게도 닿지 않는다
    expect(
      applyCharacterMemories(state, [{ characterId: "없는 사람", text: "무언가 있었다" }]),
    ).toBe(0);
    expect(state.characterMemories ?? []).toHaveLength(0);

    // 스키마 밖 — 120자 상한과 무게 1~5는 CharacterMemorySchema가 정한다
    expect(
      applyCharacterMemories(state, [
        { characterId: coach.characterId, text: "긴".repeat(121) },
        { characterId: coach.characterId, text: "무게가 범위 밖이다", salience: 9 },
      ]),
    ).toBe(0);

    // 날짜는 모델이 아니라 세이브가 적는다. 같은 문장은 두 번 쌓이지 않는다
    expect(
      applyCharacterMemories(state, [
        { characterId: coach.characterId, text: "기억 1" },
        { characterId: coach.characterId, text: "기억 1" },
      ]),
    ).toBe(1);
    expect(state.characterMemories![0]).toEqual({
      characterId: coach.characterId,
      date: state.date,
      text: "기억 1",
      salience: 2,
    });

    const owner = ownerOf(state);
    applyCharacterMemories(state, [{ characterId: owner.characterId, text: "구단주의 기억" }]);
    applyCharacterMemories(
      state,
      Array.from({ length: CHARACTER_MEMORY_KEEP + 1 }, (_, i) => ({
        characterId: coach.characterId,
        text: `기억 ${i + 2}`,
      })),
    );

    const mine = state.characterMemories!.filter((m) => m.characterId === coach.characterId);
    expect(mine).toHaveLength(CHARACTER_MEMORY_KEEP);
    expect(mine.map((m) => m.text)).toEqual(
      Array.from({ length: CHARACTER_MEMORY_KEEP }, (_, i) => `기억 ${i + 3}`),
    );
    // 다른 인물의 기억은 밀리지 않는다
    expect(state.characterMemories!.some((m) => m.characterId === owner.characterId)).toBe(true);
  });
});

describe("페르소나 사이의 관계 초기값 (people.md §6)", () => {
  // 관계는 원형에서만 나오므로 나머지는 그대로 두고 원형만 갈아 끼운다.
  // 기자의 원형은 건드리지 않는다 — `"타블로이드 · 데일리 버즈"`처럼 매체가 붙은
  // 실제 문자열에서도 축이 나와야 한다
  const base = createTestGame(42);
  const withAxes = (coach: string, owner: string): GameState => ({
    ...base,
    personas: (base.personas ?? []).map((p) =>
      p.role === "head_coach"
        ? { ...p, archetype: coach }
        : p.role === "owner"
          ? { ...p, archetype: owner }
          : p,
    ),
  });
  const stanceWith = (state: GameState, from: string, to: string) =>
    personaRelations(state, from).find((r) => r.characterId === to)?.stance;

  it("같은 세이브는 언제 물어도 같은 관계다", () => {
    const state = withAxes("인간관계형", "산업가형");
    const coach = headCoachOf(state);
    expect(personaRelations(state, coach.characterId)).toEqual(
      personaRelations(state, coach.characterId),
    );
  });

  it("축이 부딪히면 tense, 통하면 aligned, 나머지는 목록에 없다", () => {
    // 사람 · 효율 — 라커룸을 보는 코치와 손익을 보는 구단주
    const tense = withAxes("인간관계형", "산업가형");
    const coach = headCoachOf(tense);
    const owner = ownerOf(tense);
    expect(stanceWith(tense, coach.characterId, owner.characterId)).toBe("tense");
    // 관계는 양쪽에서 같은 결로 보인다
    expect(stanceWith(tense, owner.characterId, coach.characterId)).toBe("tense");

    // 구단 · 연고
    const aligned = withAxes("구단 토박이형", "지역 유지형");
    expect(
      stanceWith(aligned, headCoachOf(aligned).characterId, ownerOf(aligned).characterId),
    ).toBe("aligned");

    // 같은 축은 통한다 — 경기를 먼저 보는 구단주와 전술 기자
    const national = reportersOf(aligned).find((r) => r.archetype.startsWith("전국지"))!;
    const sameAxis = withAxes("구단 토박이형", "축구광형");
    expect(stanceWith(sameAxis, ownerOf(sameAxis).characterId, national.characterId)).toBe(
      "aligned",
    );

    // 중립은 관계를 만들지 않는다 — 몸 · 화제는 짝 표에 없다
    const neutral = withAxes("야전 조련사형", "흥행가형");
    expect(
      stanceWith(neutral, headCoachOf(neutral).characterId, ownerOf(neutral).characterId),
    ).toBe(undefined);
    // 그 코치에게 서는 것은 전국지 기자(몸 · 경기) 하나뿐이다
    expect(personaRelations(neutral, headCoachOf(neutral).characterId)).toEqual([
      {
        characterId: national.characterId,
        name: national.name,
        stance: "aligned",
        ours: "몸",
        theirs: "경기",
      },
    ]);
  });

  it("자기 자신과는 관계가 서지 않는다 — 같은 축이라도", () => {
    const state = withAxes("축구광형", "축구광형");
    for (const persona of [headCoachOf(state), ownerOf(state), ...reportersOf(state)]) {
      expect(personaRelations(state, persona.characterId).map((r) => r.characterId)).not.toContain(
        persona.characterId,
      );
    }
    // 선수도 세계 인물 명부도 대상이 아니다
    expect(personaRelations(state, state.players[0]!.name)).toEqual([]);
  });

  it("full 깊이의 카드에만 실린다", () => {
    const state = withAxes("인간관계형", "산업가형");
    const coach = headCoachOf(state);
    const card = selectCharacters(state, { pointed: [coach.characterId] }).find(
      (e) => e.characterId === coach.characterId,
    )!;
    expect(card.depth).toBe("full");
    expect(card.relations).toEqual(personaRelations(state, coach.characterId));
    // 선수 카드에는 관계 필드 자체가 없다
    const player = state.players[0]!;
    const playerCard = selectCharacters(state, { pointed: [player.name] }).find(
      (e) => e.characterId === player.name,
    )!;
    expect(playerCard.relations).toBeUndefined();
  });
});
