import { beforeAll, describe, expect, it } from "vitest";
import type { GamePlayer } from "@story-fm/domain";
import {
  bestOverall,
  DEFAULT_TACTICS,
  defaultRoleOf,
  naturalPositionOf,
  positionAtPoint,
  positionGroupOf,
  roleChangeCost,
  roleDistance,
  rolesFor,
  roleFit,
  weightSlotOf,
} from "@story-fm/domain";
import {
  MATCHDAY_BENCH,
  PENDING_EDIT_LIMIT,
  INCIDENT_MORALE_BOUND,
  MANAGER_SUBJECT,
  MAX_INCIDENTS_PER_DAY,
  applyTalkToPlayer,
  applyTeamTalk,
  assignmentsOf,
  buildOfficeViews,
  grantManagerXP,
  canRegisterFor,
  isAvailable,
  isInjured,
  lineupChangeNote,
  lineupSignature,
  movePlayerSlot,
  moraleToForm,
  playerById,
  pushNarrative,
  receptivityOf,
  recordIncident,
  relationTierOf,
  setRelationTier,
  recordEdit,
  occupiesSquadList,
  isHomegrownFor,
  reservePlayers,
  setSquadLevels,
  setMentor,
  mentorPairOf,
  menteePairsOf,
  MENTEES_PER_MENTOR,
  MENTEE_AGE_MAX,
  MENTOR_AGE_MIN,
  MENTOR_LEADERSHIP_MIN,
  squadLevelOf,
  startingIdsOf,
  takeEdits,
  setCaptain,
  setSetPieceRoutine,
  leaderGroupOf,
  LEADER_GROUP_SIZE,
  setLineup,
  setPlayerInstruction,
  setPlayerPosition,
  setPlayerRole,
  setPlayerTactic,
  setPlayerTraining,
  setSquadLevel,
  setTactics,
  settleTactics,
  shapeOfTactics,
  squadFamiliarity,
  rememberTactics,
  setTraining,
  userPlayers,
  userTactics,
  groupOf,
  type GameState,
  squadReturnOf,
  addDays,
  startMatch,
} from "@story-fm/engine";
import { advanceToMatchday, createTestGame } from "./helpers";

/**
 * **역할이 값을 실제로 움직이는** 선발 센터백. `roleFit`은 정수로 접히므로 두 역할이
 * 같은 숫자에 앉는 선수가 있고(힌카피는 어느 역할로도 79다), 그 선수로는 "역할을
 * 바꾸면 그 자리 전력이 달라진다"를 잴 수 없다 — 라인업이 흔들릴 때마다 그런 선수가
 * 첫 센터백이 되면 케이스가 이유 없이 붉어진다.
 */
function pickCentreBack(state: ReturnType<typeof createTestGame>) {
  return assignmentsOf(state, state.userTeamId, "starting").find((a) => {
    if (weightSlotOf(a.position) !== "CB") return false;
    const attrs = playerById(state, a.playerId)!.attributes;
    const fit = (role: string) => roleFit(attrs, a.position, role);
    return (
      fit("ball-playing-defender") !== fit("no-nonsense-cb") &&
      fit("ball-playing-defender") !== bestOverall(attrs, playerById(state, a.playerId)!.positions)
    );
  })!;
}

/** 현재 배치를 setLineup 입력 형태로 (검증 테스트의 기준 라인업) */
function currentLineup(state: ReturnType<typeof createTestGame>) {
  return assignmentsOf(state, state.userTeamId, "starting").map((a) => ({
    playerId: a.playerId,
    position: a.position,
  }));
}

/**
 * 감독과의 사이를 등급 끝까지 민다 — 수용성 앵커를 열림·닫힘으로 세우는 가장 짧은 길.
 * 원형이 ±1을 얹어도 `trusted`(+2)·`hostile`(−2)은 등급을 넘지 못한다.
 */
function openUp(state: GameState, player: GamePlayer): void {
  while (relationTierOf(state, MANAGER_SUBJECT, player.id) !== "trusted") {
    setRelationTier(state, state.manager.name, player.name, "trusted");
  }
  expect(receptivityOf(state, player.id).tier).toBe("open");
}
function closeOff(state: GameState, player: GamePlayer): void {
  while (relationTierOf(state, MANAGER_SUBJECT, player.id) !== "hostile") {
    setRelationTier(state, state.manager.name, player.name, "hostile");
  }
  expect(receptivityOf(state, player.id).tier).toBe("closed");
}
/** 앵커가 가운데인 선수 — 새 게임에서는 원형이 밀지 않은 대부분이 그렇다 */
function waryOne(state: GameState, skip: ReadonlySet<string> = new Set()): GamePlayer {
  const found = userPlayers(state).find(
    (p) => !skip.has(p.id) && receptivityOf(state, p.id).tier === "wary",
  );
  if (!found) throw new Error("경계 등급의 선수가 없다");
  return found;
}
/**
 * 불만을 건 채로도 앵커가 가운데인 선수 — 열린 불만이 수용성을 한 칸 닫으므로
 * (career.md §2) 사이를 `close`로 한 칸 열어 상쇄한다. 그저 그런 사이의 불만은 닫힌다.
 */
function waryWithIssue(state: GameState, skip: ReadonlySet<string> = new Set()): GamePlayer {
  const player = waryOne(state, skip);
  setRelationTier(state, state.manager.name, player.name, "close");
  state.issues.push({
    gamePlayerId: player.id,
    kind: "unhappy",
    note: "출전 불만",
    since: state.date,
  });
  expect(receptivityOf(state, player.id).tier).toBe("wary");
  return player;
}

describe("판정형 스킬 — 변화량은 공식이 정한다 (overview §7)", () => {
  it("팀토크: outcome×intensity×리더십 계수로 사기가 움직인다", () => {
    const state = createTestGame();
    const before = userPlayers(state).map((p) => ({
      form: p.state.form,
      condition: p.state.condition,
    }));
    const result = applyTeamTalk(state, { occasion: "pre", outcome: "inspired", intensity: 3 });
    expect(result.ok).toBe(true);
    const after = userPlayers(state).map((p) => ({
      form: p.state.form,
      condition: p.state.condition,
    }));
    for (let i = 0; i < before.length; i++) {
      expect(after[i]!.form).toBeGreaterThan(before[i]!.form);
      expect(after[i]!.condition).toBe(before[i]!.condition);
    }
  });

  it("리더십이 높을수록 같은 팀토크가 더 크게 울린다 (career.md §2)", () => {
    const low = createTestGame();
    low.manager.attributes.leadership = 40;
    const high = createTestGame();
    high.manager.attributes.leadership = 90;
    const target = userPlayers(low)[0]!;
    const targetHigh = userPlayers(high)[0]!;
    const lowBefore = target.state.form;
    const highBefore = targetHigh.state.form;
    applyTeamTalk(low, { occasion: "pre", outcome: "inspired", intensity: 2 });
    applyTeamTalk(high, { occasion: "pre", outcome: "inspired", intensity: 2 });
    expect(targetHigh.state.form - highBefore).toBeGreaterThanOrEqual(
      target.state.form - lowBefore,
    );
  });

  /**
   * 라커룸 계수 — 완장을 어디에 채웠는지가 **장부에서 갈리는** 자리다
   * (people.md §5-1 · career.md §2). 이 값이 죽으면 주장 지명은 다시 서사에서만
   * 뜻을 갖는 결정이 된다.
   */
  it("리더십 80인 라커룸과 30인 라커룸이 같은 팀토크에서 다른 폭을 낸다", () => {
    const play = (leadership: number) => {
      const state = createTestGame();
      state.manager.attributes.leadership = 60; // 감독 계수는 양쪽이 같다
      for (const p of userPlayers(state)) p.attributes.leadership = leadership;
      const target = userPlayers(state)[0]!;
      const before = target.state.form;
      const result = applyTeamTalk(state, { occasion: "pre", outcome: "inspired", intensity: 3 });
      return { gain: target.state.form - before, result };
    };
    const strong = play(80);
    const weak = play(30);
    expect(strong.gain).toBeGreaterThan(weak.gain);
    // **폭이 왜 그만큼이었는지가 그 자리에 남는다** — 숫자만 돌려주면 근거가 없다
    const room = strong.result.brief?.items.find((i) => i.label === "라커룸");
    expect(room?.text).toMatch(/^×1\.\d\d$/);
    expect(room?.note).toContain("리더십");
  });

  it("잘 통하는 라커룸에서는 어긋난 말도 그만큼 크게 울린다 — 계수는 부호를 가리지 않는다", () => {
    const drop = (leadership: number) => {
      const state = createTestGame();
      state.manager.attributes.leadership = 60;
      for (const p of userPlayers(state)) p.attributes.leadership = leadership;
      const target = userPlayers(state)[0]!;
      const before = target.state.form;
      applyTeamTalk(state, { occasion: "pre", outcome: "backfired", intensity: 3 });
      return target.state.form - before;
    };
    expect(drop(80)).toBeLessThan(drop(30));
  });

  it("한 번의 말이 움직이는 폭엔 한도가 있다 — 면담 ±8 (overview §7)", () => {
    const state = createTestGame();
    state.manager.attributes.leadership = 99; // 계수가 가장 큰 자리 — 한도를 미는 쪽
    const players = userPlayers(state);
    /** 한 선수에게 한 번, 0에서 출발해 남은 폼을 읽는다 (면담은 하루 한 번이다) */
    const formAfter = (
      index: number,
      outcome: "motivated" | "reassured" | "angered",
      intensity: 1 | 2 | 3,
    ) => {
      const player = players[index]!;
      // 사다리 끝의 말은 그쪽으로 열린 사람에게만 닿는다 — 앵커가 먼저 선다 (career.md §2)
      if (outcome === "motivated") openUp(state, player);
      if (outcome === "angered") closeOff(state, player);
      player.state.form = 0;
      expect(applyTalkToPlayer(state, { playerId: player.id, outcome, intensity }).ok).toBe(true);
      return player.state.form;
    };

    // 한도 아래에서는 더 센 말이 더 크게 남는다
    expect(formAfter(0, "motivated", 2)).toBeGreaterThan(formAfter(1, "reassured", 2));
    // 한도 위에서는 둘 다 같은 자리에 선다 — 8에서 잘린다
    expect(formAfter(2, "motivated", 3)).toBeCloseTo(moraleToForm(8), 10);
    expect(formAfter(3, "reassured", 3)).toBeCloseTo(moraleToForm(8), 10);
    // 아래쪽 한도도 같은 폭이다
    expect(formAfter(4, "angered", 3)).toBeCloseTo(moraleToForm(-8), 10);
  });

  it("팀토크는 한도에 딱 닿는다 — 여기서 더 세지면 조용히 잘린다 (overview §7)", () => {
    const state = createTestGame();
    state.manager.attributes.leadership = 99;
    const player = userPlayers(state)[0]!;

    // 방이 열려 있어야 `inspired`가 선다 — 앵커는 명단의 중앙값이다
    for (const p of userPlayers(state)) openUp(state, p);
    player.state.form = 0;
    expect(applyTeamTalk(state, { occasion: "pre", outcome: "inspired", intensity: 3 }).ok).toBe(
      true,
    );
    expect(player.state.form).toBeCloseTo(moraleToForm(6), 10);

    // 같은 폭이 아래로도 열려 있다 (자리가 다르면 하루에 또 한 번이다)
    for (const p of userPlayers(state)) closeOff(state, p);
    player.state.form = 0;
    expect(applyTeamTalk(state, { occasion: "half", outcome: "backfired", intensity: 3 }).ok).toBe(
      true,
    );
    expect(player.state.form).toBeCloseTo(moraleToForm(-6), 10);
  });

  it("면담이 불만 이슈를 푸는 것은 잘 풀렸을 때뿐이다 (career.md §2)", () => {
    const state = createTestGame();
    const calmed = waryWithIssue(state);
    const shouted = waryWithIssue(state, new Set([calmed.id]));
    expect(
      applyTalkToPlayer(state, { playerId: calmed.id, outcome: "reassured", intensity: 2 }).ok,
    ).toBe(true);
    expect(
      applyTalkToPlayer(state, { playerId: shouted.id, outcome: "angered", intensity: 2 }).ok,
    ).toBe(true);
    // 화를 내고 나오는 것이 불만 해소책이 되면 안 된다
    expect(state.issues.map((i) => i.gamePlayerId)).toEqual([shouted.id]);
  });

  it("같은 선수의 면담은 하루에 한 번만 셈한다 (`talkedOn` — career.md §2)", () => {
    const state = createTestGame();
    const player = userPlayers(state)[4]!;
    player.state.form = 0;
    const talk = { playerId: player.id, outcome: "motivated", intensity: 3 } as const;

    expect(applyTalkToPlayer(state, talk).ok).toBe(true);
    expect(player.state.talkedOn).toBe(state.date);
    const form = player.state.form;
    const xp = state.managerXP.leadership;
    const narrated = state.narrative.length;
    expect(form).toBeGreaterThan(0);

    // 두 번째부터는 사기도 XP도 서사도 움직이지 않는다 — 반려가 아니라 무효다
    expect(applyTalkToPlayer(state, talk).ok).toBe(true);
    expect(player.state.form).toBe(form);
    expect(state.managerXP.leadership).toBe(xp);
    expect(state.narrative.length).toBe(narrated);

    // 날이 바뀌면 다시 열린다
    state.date = addDays(state.date, 1);
    expect(applyTalkToPlayer(state, talk).ok).toBe(true);
    expect(player.state.form).toBeGreaterThan(form);
    expect(player.state.talkedOn).toBe(state.date);
  });

  it("팀토크는 occasion마다 하루에 한 번만 셈한다 (career.md §2)", () => {
    const state = createTestGame();
    const player = userPlayers(state)[0]!;
    player.state.form = 0;
    const pre = { occasion: "pre", outcome: "inspired", intensity: 3 } as const;

    expect(applyTeamTalk(state, pre).ok).toBe(true);
    expect(state.manager.teamTalkedOn?.pre).toBe(state.date);
    const form = player.state.form;
    const xp = state.managerXP.leadership;
    const narrated = state.narrative.length;
    expect(form).toBeGreaterThan(0);

    expect(applyTeamTalk(state, pre).ok).toBe(true);
    expect(player.state.form).toBe(form);
    expect(state.managerXP.leadership).toBe(xp);
    expect(state.narrative.length).toBe(narrated);

    // 하프타임의 한마디는 경기 전의 한마디와 다른 순간이다 — 자리마다 따로 센다
    expect(applyTeamTalk(state, { ...pre, occasion: "half" }).ok).toBe(true);
    const afterHalf = player.state.form;
    expect(afterHalf).toBeGreaterThan(form);

    // 날이 바뀌면 같은 자리도 다시 열린다
    state.date = addDays(state.date, 1);
    expect(applyTeamTalk(state, pre).ok).toBe(true);
    expect(player.state.form).toBeGreaterThan(afterHalf);
  });

  it("잘못된 선수 면담은 반려된다", () => {
    const state = createTestGame();
    expect(
      applyTalkToPlayer(state, { playerId: "ghost", outcome: "neutral", intensity: 1 }).ok,
    ).toBe(false);
  });
});

/**
 * 정지점의 외침 — 팀토크와 **같은 명령**을 지나되 세는 자가 다르다 (career.md §2).
 * 하루가 세면 벤치의 한마디가 라커룸 몫을 먹고, 게이트가 없으면 정지점마다 외치는
 * 것이 폼을 올리는 최적 전략이 된다.
 */
describe("정지점의 외침 — 하루가 아니라 경기가 센다 (career.md §2)", () => {
  /** 경기 하나를 열어 두고 케이스마다 복제한다 — 세계를 다시 세우는 것이 가장 비싸다 */
  let base: GameState;
  beforeAll(() => {
    base = createTestGame();
    base.manager.attributes.leadership = 99; // 계수가 가장 큰 자리 — 한도를 미는 쪽
    advanceToMatchday(base);
    const started = startMatch(base);
    if (!started.ok) throw new Error(started.message);
  });

  /** 그 경기의 명단에 선 우리 선수 하나 — 외침이 닿는 것은 여기까지다 */
  function onSquad(state: GameState): GamePlayer {
    const pending = state.pendingMatch!;
    const side =
      pending.packet.home.teamId === state.userTeamId ? pending.ledger.home : pending.ledger.away;
    const ids = new Set([...side.onPitch, ...side.bench]);
    return userPlayers(state).find((p) => ids.has(p.id))!;
  }

  it("폭은 ±2에서 잘린다 — 라커룸의 한마디와 같은 무게가 아니다", () => {
    const state = structuredClone(base);
    const player = onSquad(state);

    // 사다리 끝의 외침은 그쪽으로 열린 명단에만 닿는다 — 앵커가 먼저 선다
    for (const p of userPlayers(state)) openUp(state, p);
    player.state.form = 0;
    expect(applyTeamTalk(state, { occasion: "shout", outcome: "inspired", intensity: 3 }).ok).toBe(
      true,
    );
    expect(player.state.form).toBeCloseTo(moraleToForm(2), 10);

    // 같은 폭이 아래로도 열려 있다
    for (const p of userPlayers(state)) closeOff(state, p);
    player.state.form = 0;
    expect(applyTeamTalk(state, { occasion: "shout", outcome: "backfired", intensity: 3 }).ok).toBe(
      true,
    );
    expect(player.state.form).toBeCloseTo(moraleToForm(-2), 10);
  });

  it("경기당 셋이다 — 넷째 외침은 사기도 XP도 서사도 움직이지 않는다", () => {
    const state = structuredClone(base);
    const player = onSquad(state);
    player.state.form = 0;
    const shout = { occasion: "shout", outcome: "encouraged", intensity: 2 } as const;

    for (let i = 1; i <= 3; i++) {
      expect(applyTeamTalk(state, shout).ok).toBe(true);
      expect(state.pendingMatch?.shouts).toBe(i);
    }
    const form = player.state.form;
    const xp = state.managerXP.leadership;
    const narrated = state.narrative.length;
    expect(form).toBeGreaterThan(0);

    // 넷째부터는 반려가 아니라 무효다 — 팀토크의 하루 한 번과 같은 결
    expect(applyTeamTalk(state, shout).ok).toBe(true);
    expect(player.state.form).toBe(form);
    expect(state.managerXP.leadership).toBe(xp);
    expect(state.narrative.length).toBe(narrated);
    expect(state.pendingMatch?.shouts).toBe(3);
  });

  it("외침 셋을 다 써도 하프타임 팀토크는 그대로 남는다 (#569)", () => {
    const state = structuredClone(base);
    const player = onSquad(state);
    for (let i = 0; i < 3; i++) {
      applyTeamTalk(state, { occasion: "shout", outcome: "encouraged", intensity: 2 });
    }
    // 외침은 하루의 장부에 적히지 않는다 — 네 자리가 모두 열려 있어야 한다
    expect(state.manager.teamTalkedOn).toBeUndefined();

    player.state.form = 0;
    expect(applyTeamTalk(state, { occasion: "half", outcome: "inspired", intensity: 3 }).ok).toBe(
      true,
    );
    expect(state.manager.teamTalkedOn?.half).toBe(state.date);
    // 라커룸의 한마디는 외침보다 넓다 — 같은 한도에 걸리면 자리를 가른 뜻이 없다
    expect(player.state.form).toBeGreaterThan(moraleToForm(2));
  });

  it("경기 밖에서는 반려된다 — 벤치가 없으면 외칠 자리도 없다", () => {
    const state = structuredClone(base);
    state.pendingMatch = null;
    expect(applyTeamTalk(state, { occasion: "shout", outcome: "inspired", intensity: 2 }).ok).toBe(
      false,
    );
  });
});

describe("감독 성장 — XP 100당 +1, 상한 90", () => {
  // 월드는 검증 대상이 아니다 — 픽스처 하나를 나눠 쓰고, 케이스마다 축의 초기값을 세운다
  const state = createTestGame();

  it("XP 임계 도달 시 능력치가 오른다", () => {
    const before = state.manager.attributes.leadership;
    let leveled: string | null = null;
    for (let i = 0; i < 13 && !leveled; i++) {
      leveled = grantManagerXP(state, "leadership", 8);
    }
    expect(state.manager.attributes.leadership).toBe(before + 1);
  });

  it("상한 90에서는 더 오르지 않고 XP도 한 칸 직전에서 멈춘다", () => {
    state.manager.attributes.tactics = 90;
    state.managerXP.tactics = 0;
    expect(grantManagerXP(state, "tactics", 500)).toBeNull();
    expect(state.manager.attributes.tactics).toBe(90);
    expect(state.managerXP.tactics).toBe(99);
    // 몇 번을 더 줘도 장부는 그대로다 — 상한 뒤 XP가 세이브에서 무한히 자라지 않는다
    grantManagerXP(state, "tactics", 500);
    expect(state.managerXP.tactics).toBe(99);
  });

  it("상한 뒤 XP가 부풀어 있던 옛 세이브도 다음 부여에서 잘린다", () => {
    state.manager.attributes.negotiation = 90;
    state.managerXP.negotiation = 4000;
    expect(grantManagerXP(state, "negotiation", 15)).toBeNull();
    expect(state.managerXP.negotiation).toBe(99);
  });

  it("한 번에 준 큰 XP는 나눠 준 것과 같은 칸수를 올린다", () => {
    state.manager.attributes.training = 60;
    state.managerXP.training = 0;
    state.manager.attributes.analysis = 60;
    state.managerXP.analysis = 0;
    expect(grantManagerXP(state, "training", 250)).not.toBeNull();
    for (let i = 0; i < 500; i++) grantManagerXP(state, "analysis", 0.5);
    expect(state.manager.attributes.training).toBe(state.manager.attributes.analysis);
    expect(state.managerXP.training).toBeCloseTo(state.managerXP.analysis, 9);
  });

  it("상한을 넘겨 준 XP는 상한까지만 쓰인다", () => {
    state.manager.attributes.leadership = 88;
    state.managerXP.leadership = 0;
    expect(grantManagerXP(state, "leadership", 1000)).not.toBeNull();
    expect(state.manager.attributes.leadership).toBe(90);
    expect(state.managerXP.leadership).toBe(99);
  });
});

describe("라인업 = 전술 배치 (v6)", () => {
  it("11명·GK 1명·부상 제외를 강제한다", () => {
    const state = createTestGame();
    const lineup = currentLineup(state);
    expect(setLineup(state, { starting: lineup.slice(0, 10) }).ok).toBe(false);

    // GK 포지션 없이 11명 → 반려
    const noGk = lineup.map((s) => ({ ...s, position: s.position === "GK" ? "CB" : s.position }));
    expect(setLineup(state, { starting: noGk }).ok).toBe(false);

    // 부상자를 선발에 넣으면 반려
    const starter = userPlayers(state).find((p) => p.id === lineup[5]!.playerId)!;
    state.injuries.push({
      id: "inj-1",
      gamePlayerId: starter.id,
      bodyPart: "발목",
      severity: "minor",
      cause: "training",
      occurredOn: state.date,
      expectedReturn: "2026-12-31",
      returnedOn: null,
    });
    expect(isInjured(state, starter.id)).toBe(true);
    expect(setLineup(state, { starting: lineup }).ok).toBe(false);

    // 복귀 처리하면 통과 — 표에는 부임 전 이력이 먼저 실려 있으므로 id로 찾는다
    state.injuries.find((i) => i.id === "inj-1")!.returnedOn = state.date;
    expect(setLineup(state, { starting: lineup }).ok).toBe(true);
  });

  it("배치가 role·포지션을 갱신하고 적응도는 이어받는다", () => {
    const state = createTestGame();
    const tactics = userTactics(state);
    const first = tactics.assignments.find((a) => a.role === "starting")!;
    first.familiarity = 77; // 학습된 상태
    const lineup = currentLineup(state);
    const bench = userPlayers(state)
      .filter((p) => p.squadLevel === "first" && !lineup.some((s) => s.playerId === p.id))
      .slice(0, 5)
      .map((p) => ({ playerId: p.id }));

    const res = setLineup(state, { starting: lineup, bench });
    expect(res.ok).toBe(true);
    const after = userTactics(state);
    expect(after.assignments.filter((a) => a.role === "starting")).toHaveLength(11);
    expect(after.assignments.filter((a) => a.role === "bench")).toHaveLength(5);
    // 적응도 계승
    expect(after.assignments.find((a) => a.playerId === first.playerId)?.familiarity).toBe(77);
  });
});

describe("set_lineup은 조정해 둔 좌표를 건드리지 않는다", () => {
  /** 전술판에서 볼란치를 조금 올려 두는 상황을 만든다 */
  const tunedGame = () => {
    const state = createTestGame();
    const tactics = userTactics(state);
    const starters = tactics.assignments.filter((a) => a.role === "starting");
    const target = starters.find((a) => positionGroupOf(a.position) === "MF")!;
    const tuned = { x: target.point!.x, y: target.point!.y - 6 };
    target.point = tuned;
    target.position = positionAtPoint(tuned);
    return { state, tunedId: target.playerId, tuned, before: snapshot(state) };
  };
  const snapshot = (state: GameState) =>
    new Map(
      userTactics(state)
        .assignments.filter((a) => a.role === "starting")
        .map((a) => [a.playerId, { ...a.point! }] as const),
    );

  it("id만 넘기면 **아무 좌표도 안 바뀐다** — 배열 순서로 자리를 정하지 않는다", () => {
    const { state, before } = tunedGame();
    const ids = userTactics(state)
      .assignments.filter((a) => a.role === "starting")
      .map((a) => a.playerId);
    // 순서를 뒤집어 넘긴다 — 예전에는 이것만으로 전원이 프리셋으로 튕겼다
    expect(setLineup(state, { starting: [...ids].reverse() }).ok).toBe(true);

    const after = snapshot(state);
    for (const [id, point] of before) expect(after.get(id), id).toEqual(point);
  });

  it("한 명만 교체하면 **나머지는 그대로**이고, 새 선수는 빈자리를 물려받는다", () => {
    const { state, before } = tunedGame();
    const starters = userTactics(state).assignments.filter((a) => a.role === "starting");
    const out = starters.find((a) => positionGroupOf(a.position) === "FW")!;
    const vacated = { ...out.point! };
    const replacement = userPlayers(state).find(
      (p) => !starters.some((a) => a.playerId === p.id) && isAvailable(state, p),
    )!;

    const next = starters.map((a) => (a.playerId === out.playerId ? replacement.id : a.playerId));
    expect(setLineup(state, { starting: next }).ok).toBe(true);

    const after = snapshot(state);
    for (const [id, point] of before) {
      if (id === out.playerId) continue;
      expect(after.get(id), id).toEqual(point);
    }
    // 들어온 선수가 나간 선수의 자리를 잇는다
    expect(after.get(replacement.id)).toEqual(vacated);
  });

  it("자리를 명시하면 그 선수만 옮겨간다", () => {
    const { state, tunedId, before } = tunedGame();
    const starters = userTactics(state).assignments.filter((a) => a.role === "starting");
    const mover = starters.find(
      (a) => a.playerId !== tunedId && positionGroupOf(a.position) === "MF",
    )!;
    expect(
      setLineup(state, {
        starting: starters.map((a) =>
          a.playerId === mover.playerId ? { playerId: a.playerId, position: "CAM" } : a.playerId,
        ),
      }).ok,
    ).toBe(true);

    const after = snapshot(state);
    expect(after.get(mover.playerId)).not.toEqual(before.get(mover.playerId));
    // 조정해 둔 선수는 그대로다
    expect(after.get(tunedId)).toEqual(before.get(tunedId));
  });

  it("같은 자리를 다시 지시해도 미세 조정이 튀지 않는다", () => {
    const { state, tunedId, tuned } = tunedGame();
    const starters = userTactics(state).assignments.filter((a) => a.role === "starting");
    const code = starters.find((a) => a.playerId === tunedId)!.position;
    expect(
      setLineup(state, {
        starting: starters.map((a) =>
          a.playerId === tunedId ? { playerId: a.playerId, position: code } : a.playerId,
        ),
      }).ok,
    ).toBe(true);
    const after = userTactics(state).assignments.find((a) => a.playerId === tunedId)!;
    expect(after.point).toEqual(tuned);
  });

  it("포메이션 이름을 보내도 프리셋으로 좌표를 덮지 않는다", () => {
    const { state, before } = tunedGame();
    expect(setTactics(state, { formation: "3-5-2" }).ok).toBe(true);
    const after = snapshot(state);
    expect(after).toEqual(before);
  });
});

describe("라인업 명령은 검증 뒤에 적용한다 (team.md §6)", () => {
  /**
   * 세계 하나를 이 describe가 함께 쓴다 (AGENTS.md §5 — `createTestGame`은 한 번에
   * 1초다). 반려 케이스는 **상태를 바꾸지 않는 것이 곧 검증 대상**이라 앞뒤 순서에
   * 기대지 않고, 기준점은 케이스마다 그 자리에서 다시 읽는다.
   */
  const state = createTestGame();
  const promotable = () =>
    reservePlayers(state, state.userTeamId).find(
      (p) => canRegisterFor(state, p, state.userTeamId).ok && isAvailable(state, p),
    );
  const benchIds = () => assignmentsOf(state, state.userTeamId, "bench").map((a) => a.playerId);

  it("배치가 반려되면 승격도 남지 않는다", () => {
    const target = promotable();
    expect(target, "승격 가능한 2군이 없다").toBeDefined();
    const before = lineupSignature(state);

    // 승격 자체는 옳고 배치가 열 명이라 걸린다 — 예전엔 승격만 적용된 채 반려됐다
    const res = setLineup(state, {
      starting: currentLineup(state).slice(0, 10),
      squadLevels: [{ playerId: target!.id, level: "first" }],
    });
    expect(res.ok).toBe(false);
    expect(squadLevelOf(target!)).toBe("reserve");
    expect(lineupSignature(state)).toBe(before);
  });

  it("같은 요청이 배치에 앉힌 선수는 2군으로 내리지 못한다", () => {
    const lineup = currentLineup(state);
    const starter = userPlayers(state).find((p) => p.id === lineup[3]!.playerId)!;
    const res = setLineup(state, {
      starting: lineup,
      squadLevels: [{ playerId: starter.id, level: "reserve" }],
    });
    expect(res.ok).toBe(false);
    // 강등이 배치보다 뒤라, 통과시켰다면 선발이 열 명으로 남았다
    expect(squadLevelOf(starter)).toBe("first");
    expect(startingIdsOf(state)).toContain(starter.id);
    expect(startingIdsOf(state)).toHaveLength(11);
  });

  it("벤치는 정원까지만 — 넘으면 반려하고 지금 벤치는 그대로다", () => {
    const lineup = currentLineup(state);
    const spare = userPlayers(state)
      .filter((p) => squadLevelOf(p) === "first" && !lineup.some((s) => s.playerId === p.id))
      .slice(0, MATCHDAY_BENCH + 1)
      .map((p) => ({ playerId: p.id }));
    expect(spare.length, "정원을 넘길 만큼의 비선발이 없다").toBe(MATCHDAY_BENCH + 1);
    const before = benchIds();

    expect(setLineup(state, { starting: lineup, bench: spare }).ok).toBe(false);
    expect(benchIds()).toEqual(before);
    expect(setLineup(state, { starting: lineup, bench: spare.slice(0, MATCHDAY_BENCH) }).ok).toBe(
      true,
    );
    expect(benchIds()).toHaveLength(MATCHDAY_BENCH);
  });

  it("벤치를 생략하면 지금 벤치가 남고, 빈 배열은 비운다", () => {
    const lineup = currentLineup(state);
    const kept = benchIds();
    expect(kept.length).toBeGreaterThan(0);

    expect(setLineup(state, { starting: lineup }).ok).toBe(true);
    expect(benchIds()).toEqual(kept);

    expect(setLineup(state, { starting: lineup, bench: [] }).ok).toBe(true);
    expect(benchIds()).toEqual([]);
  });

  it("승격과 배치가 한 요청으로 간다 — 2군 선수가 그대로 선발에 선다", () => {
    const target = promotable();
    expect(target, "승격 가능한 2군이 없다").toBeDefined();
    const lineup = currentLineup(state);
    const out = lineup.findIndex((s) => positionGroupOf(s.position) !== "GK");
    const next = lineup.map((s, i) => (i === out ? { playerId: target!.id } : s));

    const res = setLineup(state, {
      starting: next,
      squadLevels: [{ playerId: target!.id, level: "first" }],
    });
    expect(res.ok, res.message).toBe(true);
    expect(squadLevelOf(target!)).toBe("first");
    expect(startingIdsOf(state)).toContain(target!.id);
  });

  /**
   * 명단이 찬 팀의 "하나 내리고 하나 올려" — 두 문이 같은 셈을 하는지가 이 케이스다
   * (team.md §6). `set_lineup`만 강등을 빈자리로 안 세던 때는 같은 지시가 전술판에서만
   * 반려됐다.
   */
  it("같은 요청이 내리는 자리를 승격이 쓴다 — set_squad_level과 같은 답", () => {
    const up = reservePlayers(state, state.userTeamId).find(
      (p) => occupiesSquadList(state, p) && !canRegisterFor(state, p, state.userTeamId).ok,
    );
    expect(up, "명단이 차서 혼자서는 못 올라가는 2군이 없다").toBeDefined();
    const seated = new Set(assignmentsOf(state, state.userTeamId).map((a) => a.playerId));
    const down = userPlayers(state).find(
      (p) =>
        squadLevelOf(p) === "first" &&
        !seated.has(p.id) &&
        occupiesSquadList(state, p) &&
        // 홈그로운 하한은 이 교대가 재는 것이 아니다 — 같은 갈래끼리 맞바꾼다
        isHomegrownFor(p, state.userTeamId) === isHomegrownFor(up!, state.userTeamId),
    );
    expect(down, "배치 밖에서 맞바꿀 1군이 없다").toBeDefined();

    const swap = [
      { playerId: up!.id, level: "first" as const },
      { playerId: down!.id, level: "reserve" as const },
    ];
    const back = {
      moves: [
        { playerId: down!.id, level: "first" as const },
        { playerId: up!.id, level: "reserve" as const },
      ],
    };

    // 말로 하는 문 — 여기서는 원래 통과했다
    expect(setSquadLevels(state, { moves: swap }).ok).toBe(true);
    expect(squadLevelOf(up!)).toBe("first");
    expect(setSquadLevels(state, back).ok).toBe(true);

    // 전술판·set_lineup의 문 — 같은 교대에 같은 답이어야 한다
    const res = setLineup(state, { starting: currentLineup(state), squadLevels: swap });
    expect(res.ok, res.message).toBe(true);
    expect(squadLevelOf(up!)).toBe("first");
    expect(squadLevelOf(down!)).toBe("reserve");
    setSquadLevels(state, back); // 뒤 케이스를 위해 제자리로
  });

  it("자리를 옮기고 역할이 반려되면 결과로 알린다 — 옮긴 자리를 되돌리지 않는다", () => {
    const mover = assignmentsOf(state, state.userTeamId, "starting").find(
      (a) => positionGroupOf(a.position) === "DF",
    )!;
    // 리베로는 센터백의 역할이라 CAM에는 없다 — 자리는 옮기고 역할만 걸린다
    const res = setPlayerTactic(state, {
      playerId: mover.playerId,
      position: "CAM",
      role: "libero",
    });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("반려");
    const after = assignmentsOf(state, state.userTeamId).find(
      (a) => a.playerId === mover.playerId,
    )!;
    expect(after.position).toBe("CAM");
  });
});

describe("포지션 명령 (멀티 포지션)", () => {
  it("주 포지션을 옮기면 isNatural이 이동하고 OVR이 재산정된다", () => {
    const state = createTestGame();
    const df = userPlayers(state).find((p) => groupOf(p) === "DF")!;
    expect(setPlayerPosition(state, { playerId: df.id, position: "XX" }).ok).toBe(false);

    const ok = setPlayerPosition(state, { playerId: df.id, position: "ST" });
    expect(ok.ok).toBe(true);
    expect(naturalPositionOf(df).position).toBe("ST");
    expect(df.positions.filter((p) => p.isNatural)).toHaveLength(1);
    expect(groupOf(df)).toBe("FW");
    /**
     * 종합은 **가장 잘 맞는 자리**의 값이라 주 포지션 표기를 옮겨도 그 자리의
     * 값으로 갈아치워지지 않는다 (player.md §4) — 어드민 표와 같은 함수다.
     * 실제로 최전방에 세웠을 때의 전력은 `roleFit`이 따로 낸다.
     */
    expect(df.attributes.overall).toBe(bestOverall(df.attributes, df.positions));
    expect(roleFit(df.attributes, "ST")).toBeLessThanOrEqual(df.attributes.overall);
  });

  it("처음 맡는 포지션은 낮은 적응도로 추가된다", () => {
    const state = createTestGame();
    const player = userPlayers(state).find((p) => groupOf(p) === "MF")!;
    const before = player.positions.length;
    setPlayerPosition(state, { playerId: player.id, position: "GK" });
    expect(player.positions.length).toBe(before + 1);
    const gk = player.positions.find((p) => p.position === "GK")!;
    expect(gk.isNatural).toBe(true);
    expect(gk.proficiency).toBeLessThan(60); // 생소한 자리
  });
});

describe("주장·전술·개인 지시", () => {
  /**
   * **중립은 칸을 비운다** (match.md §1.4). 「지시 없음」이 옛 세이브의 `undefined`와
   * 지시를 푼 판의 `normal` 두 모양으로 적히면, 같은 판이 두 지문을 갖고 저장 경로가
   * 「달라진 축만」을 가리는 규칙도 함께 흔들린다. 화면에는 둘 다 「보통」이라 이
   * 갈림은 장부에서만 보인다.
   */
  it("세트피스 지시는 말한 축만 바꾸고, 중립으로 돌리면 칸을 걷는다", () => {
    const state = createTestGame();
    expect(userTactics(state).setPieceRoutine).toBeUndefined();

    expect(setSetPieceRoutine(state, { commit: "many" }).ok).toBe(true);
    expect(userTactics(state).setPieceRoutine).toEqual({ commit: "many" });

    // 말하지 않은 축은 그대로다
    expect(setSetPieceRoutine(state, { guard: "few" }).ok).toBe(true);
    expect(userTactics(state).setPieceRoutine).toEqual({ commit: "many", guard: "few" });

    // 같은 값을 다시 넣으면 편집 노트가 남지 않는다
    expect(setSetPieceRoutine(state, { commit: "many" }).unchanged).toBe(true);

    // `null`도 `normal`도 같은 중립이고, 둘 다 풀면 칸 자체가 걷힌다
    expect(setSetPieceRoutine(state, { commit: null }).ok).toBe(true);
    expect(userTactics(state).setPieceRoutine).toEqual({ guard: "few" });
    expect(setSetPieceRoutine(state, { guard: "normal" }).ok).toBe(true);
    expect(userTactics(state).setPieceRoutine).toBeUndefined();
  });

  it("주장은 팀당 1명 — 새로 지명하면 이전 주장은 해제된다", () => {
    const state = createTestGame();
    const before = userPlayers(state).find((p) => p.isCaptain)!;
    const next = userPlayers(state).find((p) => !p.isCaptain)!;
    expect(setCaptain(state, { playerId: next.id }).ok).toBe(true);
    expect(next.isCaptain).toBe(true);
    expect(before.isCaptain).toBe(false);
    expect(userPlayers(state).filter((p) => p.isCaptain)).toHaveLength(1);
  });

  it("완장의 체력 보너스는 선수마다 첫 지명에만 붙는다 (career.md §2)", () => {
    const state = createTestGame();
    const [first, second] = userPlayers(state).filter((p) => !p.isCaptain);
    first!.state.condition = 70;
    second!.state.condition = 70;

    expect(setCaptain(state, { playerId: first!.id }).ok).toBe(true);
    expect(first!.state.condition).toBe(74);
    expect(first!.state.captainedOn).toBe(state.date);
    expect(setCaptain(state, { playerId: second!.id }).ok).toBe(true);
    expect(second!.state.condition).toBe(74);

    // 둘을 번갈아 지명하는 것만으로 둘 다 체력이 차던 자리
    expect(setCaptain(state, { playerId: first!.id }).ok).toBe(true);
    expect(setCaptain(state, { playerId: second!.id }).ok).toBe(true);
    expect(first!.state.condition).toBe(74);
    expect(second!.state.condition).toBe(74);
    expect(second!.isCaptain).toBe(true);
  });

  it("완장은 둘 — 부주장을 세우고, 주장으로 올리면 그 자리는 빈다", () => {
    const state = createTestGame();
    const [a, b] = userPlayers(state).filter((p) => !p.isCaptain);
    expect(setCaptain(state, { vice: b!.id }).ok).toBe(true);
    expect(b!.isViceCaptain).toBe(true);

    // 부주장을 주장으로 — 한 사람이 완장 둘을 차지 않는다
    expect(setCaptain(state, { playerId: b!.id }).ok).toBe(true);
    expect(b!.isCaptain).toBe(true);
    expect(b!.isViceCaptain).not.toBe(true);

    // 주장을 부주장으로 세우려는 지시는 반려된다
    expect(setCaptain(state, { vice: b!.id }).ok).toBe(false);

    // 팀당 하나 — 새로 세우면 앞사람이 벗는다
    expect(setCaptain(state, { vice: a!.id }).ok).toBe(true);
    expect(userPlayers(state).filter((p) => p.isViceCaptain === true)).toHaveLength(1);
    expect(setCaptain(state, { vice: null }).ok).toBe(true);
    expect(userPlayers(state).filter((p) => p.isViceCaptain === true)).toHaveLength(0);
  });

  /**
   * 서열은 저장하지 않는 파생이라 **같은 세이브가 언제나 같은 명단**을 내야 한다
   * (people.md §5-1) — 동점이 id로 갈리지 않으면 화면과 판정이 다른 서열을 읽는다.
   */
  it("라커룸 서열은 리더십이 절반을 넘게 가르고, 완장은 서열을 이긴다", () => {
    const state = createTestGame();
    const squad = userPlayers(state).filter((p) => squadLevelOf(p) === "first");
    // 완장을 비운 라커룸 — 순수한 서열만 남긴다 (시드 주장은 OVR이 세운 자리다)
    for (const p of squad) {
      p.attributes.leadership = 20;
      p.isCaptain = false;
    }
    const top = squad[0]!;
    top.attributes.leadership = 90;

    const first = leaderGroupOf(state, state.userTeamId);
    expect(first).toHaveLength(LEADER_GROUP_SIZE);
    // 리더십 하나만 90이면 나머지가 어떻든 그 사람이 맨 위다 (지분 0.55)
    expect(first[0]?.playerId).toBe(top.id);
    // 두 번 불러도 같은 명단 — 동점은 id로 갈린다
    expect(leaderGroupOf(state, state.userTeamId).map((r) => r.playerId)).toEqual(
      first.map((r) => r.playerId),
    );

    // 서열 밖의 두 사람에게 완장을 채우면 둘 다 그룹에 들어온다
    const outside = squad.filter((p) => !first.some((r) => r.playerId === p.id));
    const [captain, vice] = outside;
    expect(setCaptain(state, { playerId: captain!.id, vice: vice!.id }).ok).toBe(true);
    const after = leaderGroupOf(state, state.userTeamId);
    expect(after.find((r) => r.playerId === captain!.id)?.role).toBe("captain");
    expect(after.find((r) => r.playerId === vice!.id)?.role).toBe("vice");
    expect(after).toHaveLength(LEADER_GROUP_SIZE + 2);
  });

  it("2군으로 내리면 완장이 둘 다 빠진다 — 서열의 후보는 1군뿐이다", () => {
    const state = createTestGame();
    const vice = userPlayers(state).find((p) => !p.isCaptain)!;
    expect(setCaptain(state, { vice: vice.id }).ok).toBe(true);
    expect(setSquadLevel(state, { playerId: vice.id, level: "reserve" }).ok).toBe(true);
    expect(vice.isViceCaptain).not.toBe(true);
    expect(leaderGroupOf(state, state.userTeamId).some((r) => r.playerId === vice.id)).toBe(false);
  });

  it("전술: Zod 검증을 통과해야 반영된다", () => {
    const state = createTestGame();
    expect(setTactics(state, { formation: "4-4-2", mentality: 5 }).ok).toBe(true);
    expect(userTactics(state).spec.formation).not.toBe("4-4-2");
    expect(userTactics(state).spec.mentality).toBe(5);
    expect(setTactics(state, { mentality: 9 as never }).ok).toBe(false);
  });

  it("전술을 바꾸면 배치 적응도가 변경 폭만큼 떨어진다", () => {
    const state = createTestGame();
    const before = assignmentsOf(state, state.userTeamId, "starting")[0]!.familiarity;
    setTactics(state, { pressing: 5, tempo: 5 });
    expect(assignmentsOf(state, state.userTeamId, "starting")[0]!.familiarity).toBeLessThan(before);
  });

  it("작은 변경보다 여러 전술 축 변경이 크게 떨어진다", () => {
    const a = createTestGame();
    const b = createTestGame();
    const base = assignmentsOf(a, a.userTeamId, "starting")[0]!.familiarity;
    setTactics(a, { mentality: 4 });
    setTactics(b, { mentality: 5, pressing: 5, tempo: 5, defensiveLine: 5, width: 5 });
    const dropA = base - assignmentsOf(a, a.userTeamId, "starting")[0]!.familiarity;
    const dropB = base - assignmentsOf(b, b.userTeamId, "starting")[0]!.familiarity;
    expect(dropB).toBeGreaterThan(dropA);
  });

  /**
   * 예전 모델은 "기억 없는 일방 차감"이라 익힌 전술로 되돌아와도 처음처럼 깎였고,
   * 슬라이더를 올렸다 내리면 그만큼 영구히 사라졌다. 아래 셋이 그 회귀를 막는다.
   */
  it("익힌 전술로 되돌아오면 그때의 적응도를 되찾는다 (기억)", () => {
    const state = createTestGame();
    const fam = () => assignmentsOf(state, state.userTeamId, "starting")[0]!.familiarity;
    // 시작 포메이션은 구단 카탈로그가 정한다 (팀마다 다르다)
    const opening = userTactics(state).spec.mentality;

    // 시작 전술을 드릴해 숙련도를 올려 둔다
    for (const a of userTactics(state).assignments) a.familiarity = 88;
    rememberTactics(userTactics(state), state.date);
    expect(fam()).toBe(88);

    // 다른 포메이션으로 갔다가
    setTactics(state, { mentality: opening === 5 ? 1 : 5 });
    const away = fam();
    expect(away).toBeLessThan(88);

    // 되돌아오면 드릴해 둔 수준을 되찾는다 (또 깎이지 않는다)
    setTactics(state, { mentality: opening });
    expect(fam()).toBe(88);
    expect(fam()).toBeGreaterThan(away);
  });

  it("슬라이더를 올렸다 되돌리면 잃은 만큼 돌아온다 (되돌리기가 공짜)", () => {
    const state = createTestGame();
    const fam = () => assignmentsOf(state, state.userTeamId, "starting")[0]!.familiarity;
    // 시작 성향은 스쿼드가 정한다 — 값을 박아 두면 카탈로그가 바뀔 때 어긋난다
    const opening = userTactics(state).spec.mentality;
    for (const a of userTactics(state).assignments) a.familiarity = 90;
    rememberTactics(userTactics(state), state.date);

    setTactics(state, { mentality: opening === 5 ? 1 : 5 });
    expect(fam()).toBeLessThan(90);
    setTactics(state, { mentality: opening });
    expect(fam()).toBe(90);
  });

  it("전술을 갈아엎으면 바닥까지 떨어질 수 있다 — 하한은 없다", () => {
    const state = createTestGame();
    const fam = () => assignmentsOf(state, state.userTeamId, "starting")[0]!.familiarity;
    /**
     * **매번 새로운 설정으로** 옮겨 다니면 "전술을 모르는 상태"에 닿는다.
     *
     * ⚠️ 세 전술을 **돌려막는 것**으로는 안 된다 — 기억이 선수마다 남아 되돌아올
     * 때마다 그 값을 되찾기 때문이다(그게 맞다: 세 가지를 번갈아 쓰는 팀은 셋 다
     * 어느 정도 익힌다). 바닥은 **아무것도 몸에 붙일 시간을 주지 않을 때** 온다.
     */
    for (let i = 0; i < 18; i++) {
      setTactics(state, {
        mentality: ((i * 2) % 5) + 1,
        pressing: ((i * 3) % 5) + 1,
        tempo: ((i * 4) % 5) + 1,
        passStyle: ((i + 2) % 5) + 1,
        defensiveLine: ((i * 3 + 1) % 5) + 1,
        width: ((i + 4) % 5) + 1,
      });
    }
    expect(fam()).toBeGreaterThanOrEqual(0);
    expect(fam()).toBeLessThan(60);
  });

  it("시간만으로는 오르지 않는다 — 달력을 넘기는 건 훈련이 아니다", () => {
    const state = createTestGame();
    const fam = () => assignmentsOf(state, state.userTeamId, "starting")[0]!.familiarity;
    const before = fam();
    for (let i = 0; i < 60; i++) settleTactics(state, state.date);
    expect(fam(), "가만히 있었는데 전술이 몸에 붙었다").toBe(before);
    // 기억 갱신은 계속 돈다 — 되돌아왔을 때 되찾는 통로다.
    // **기억은 선수마다 따로다**(팀 평균 한 숫자였을 때의 왕복 누수 때문에 옮겼다)
    expect(
      assignmentsOf(state, state.userTeamId, "starting")[0]!.drilled?.length ?? 0,
    ).toBeGreaterThan(0);
  });

  it("적응도는 선수마다 다르고, 전술을 바꿔도 개인차가 보존된다", () => {
    const state = createTestGame();
    const tactics = userTactics(state);
    const opening = tactics.spec.formation; // 시작 포메이션은 구단 카탈로그가 정한다
    const starters = tactics.assignments.filter((a) => a.role === "starting");
    // 오래 뛴 선수 / 갓 온 선수 / 벤치 — 서로 다른 수준
    starters[0]!.familiarity = 95;
    starters[1]!.familiarity = 70;
    for (const a of starters.slice(2)) a.familiarity = 80;
    rememberTactics(tactics, state.date);

    setTactics(state, { formation: opening === "5-4-1" ? "4-3-3" : "5-4-1" });
    const after = userTactics(state).assignments.filter((a) => a.role === "starting");
    // 전원이 같은 값으로 덮이지 않는다 — 서열이 그대로다
    expect(after[0]!.familiarity).toBeGreaterThan(after[2]!.familiarity);
    expect(after[2]!.familiarity).toBeGreaterThan(after[1]!.familiarity);
    // 팀 적응도는 이 개인값들의 집계(선발 평균)다
    const avg = after.reduce((s, a) => s + a.familiarity, 0) / after.length;
    expect(squadFamiliarity(state, state.userTeamId)).toBeCloseTo(avg, 5);

    // 되돌아오면 각자 제 수준을 되찾는다
    setTactics(state, { formation: opening });
    const back = userTactics(state).assignments.filter((a) => a.role === "starting");
    expect(back[0]!.familiarity).toBe(95);
    expect(back[1]!.familiarity).toBe(70);
    expect(back[2]!.familiarity).toBe(80);
  });

  it("축마다 대가가 다르다 — 패스 길이 한 칸과 수비 라인 한 칸이 같을 수 없다", () => {
    /** 선발 전원을 70에서 출발시키고 그 변경의 평균 하락을 잰다 */
    const dropFor = (spec: Parameters<typeof setTactics>[1]): number => {
      const state = createTestGame(7);
      userTactics(state).spec = { ...DEFAULT_TACTICS };
      for (const a of userTactics(state).assignments) a.familiarity = 70;
      const before = assignmentsOf(state, state.userTeamId, "starting").map((a) => a.familiarity);
      setTactics(state, spec);
      const after = assignmentsOf(state, state.userTeamId, "starting").map((a) => a.familiarity);
      return before.reduce((sum, v, i) => sum + (v - after[i]!), 0) / before.length;
    };

    const pass = dropFor({ passStyle: 4 });
    const tempo = dropFor({ tempo: 4 });
    const line = dropFor({ defensiveLine: 4 });
    const combined = dropFor({ mentality: 5, pressing: 5, tempo: 5, defensiveLine: 5, width: 5 });

    // 패스 길이는 공 가진 선수의 선택에 가깝고, 수비 라인은 넷이 함께 움직여야 한다
    expect(pass).toBeLessThan(line);
    expect(tempo).toBeLessThan(line);
    // 그래도 공짜는 아니다
    expect(pass).toBeGreaterThan(0);
    expect(combined).toBeGreaterThan(line);
  });

  it("같은 변경에도 흔들리는 폭은 선수마다 다르다 — 판단 축이 높으면 덜 흔들린다", () => {
    const state = createTestGame(7);
    const tactics = userTactics(state);
    for (const a of tactics.assignments) a.familiarity = 70;
    const uptake = (id: string) => {
      const at = playerById(state, id)!.attributes;
      return (at.vision + at.positioning + at.composure) / 3;
    };
    const starters = tactics.assignments.filter((a) => a.role === "starting");
    const sorted = [...starters].sort((a, b) => uptake(a.playerId) - uptake(b.playerId));

    setTactics(state, { pressing: 5, defensiveLine: 5 }); // 폭이 보이도록 크게 바꾼다
    // 전원이 정확히 같은 값만큼 떨어지면 그건 팀이 아니라 슬라이더의 움직임이다
    const drops = starters.map((a) => 70 - a.familiarity);
    expect(new Set(drops).size, "전원이 같은 폭으로 떨어졌다").toBeGreaterThan(1);
    // 개인 편차가 얹히므로 **양 끝 한 명씩**이 아니라 무리로 본다 — 한 명끼리
    // 재면 스쿼드가 바뀔 때마다 뒤집힌다
    const half = Math.floor(sorted.length / 2);
    const mean = (xs: typeof starters) =>
      xs.reduce((t, a) => t + (70 - a.familiarity), 0) / xs.length;
    expect(mean(sorted.slice(-half)), "판단 축이 높은 무리가 더 흔들렸다").toBeLessThan(
      mean(sorted.slice(0, half)),
    );
  });

  it("자기 축구에 가까워지면 덜 잃는다 — 롱볼형은 패스를 길게 하면 오히려 오른다", () => {
    const state = createTestGame(7);
    const tactics = userTactics(state);
    for (const a of tactics.assignments) a.familiarity = 60;
    const starters = assignmentsOf(state, state.userTeamId, "starting");
    // 킥·제공권으로 먹고사는 선수와, 짧게 주고받는 기술자
    const longBall = playerById(state, starters[1]!.playerId)!;
    Object.assign(longBall.attributes, { kicking: 92, aerial: 88, passing: 55, composure: 55 });
    const shortPass = playerById(state, starters[2]!.playerId)!;
    Object.assign(shortPass.attributes, { kicking: 50, aerial: 48, passing: 92, composure: 90 });

    setTactics(state, { passStyle: 5 }); // 3 → 5, 롱볼로
    const famOf = (id: string) =>
      assignmentsOf(state, state.userTeamId, "starting").find((a) => a.playerId === id)!
        .familiarity;
    // 팀은 대가를 치르지만 롱볼형에겐 오히려 익숙한 축구다
    expect(squadFamiliarity(state, state.userTeamId)).toBeLessThan(60);
    expect(famOf(longBall.id), "롱볼형이 롱볼 전환에서 손해를 봤다").toBeGreaterThan(60);
    expect(famOf(shortPass.id), "숏패스형이 롱볼 전환에서 이득을 봤다").toBeLessThan(60);
  });

  it("방향은 부호가 그대로 뒤집힌다 — 왔다 갔다 해도 적응도를 불릴 수 없다", () => {
    const state = createTestGame(7);
    const tactics = userTactics(state);
    tactics.spec = { ...DEFAULT_TACTICS };
    for (const a of tactics.assignments) a.familiarity = 60;
    const starters = assignmentsOf(state, state.userTeamId, "starting");
    const longBall = playerById(state, starters[1]!.playerId)!;
    Object.assign(longBall.attributes, { kicking: 92, aerial: 88, passing: 55, composure: 55 });

    setTactics(state, { passStyle: 5, tempo: 5 });
    const away = assignmentsOf(state, state.userTeamId, "starting").map((a) => a.familiarity);
    expect(new Set(away).size, "방향이 갈리면 값도 갈려야 한다").toBeGreaterThan(1);

    setTactics(state, { passStyle: 3, tempo: 3 });
    const back = assignmentsOf(state, state.userTeamId, "starting").map((a) => a.familiarity);
    // 적응도는 소수라 부동소수 오차만큼만 어긋난다 — 값이 불어나지 않는 것이 계약이다
    for (const v of back) expect(v).toBeCloseTo(60, 6);
  });

  it("각자 자기 기억에서 도착한다 — 팀 적응도는 그 평균(파생)이다", () => {
    const state = createTestGame(7);
    const tactics = userTactics(state);
    for (const a of tactics.assignments) a.familiarity = 70;

    setTactics(state, { pressing: 5, defensiveLine: 5 });
    const values = assignmentsOf(state, state.userTeamId, "starting").map((a) => a.familiarity);

    /**
     * 예전엔 팀 평균이 계산된 목표에 **정확히** 닿아야 했다 — 기억이 팀 값
     * 하나였기 때문이고, 그래서 모든 개인 보정이 "평균을 흔들지 않는 재분배"여야
     * 했다(적응도가 "남들보다 맞나"가 된 이유). 이제 기억이 선수별이라 각자
     * 자기 자리에서 도착하고, 팀 적응도는 그 평균일 뿐이다.
     */
    expect(new Set(values.map((v) => Math.round(v))).size, "개인차가 사라졌다").toBeGreaterThan(1);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(squadFamiliarity(state, state.userTeamId)).toBeCloseTo(mean, 0);
    expect(mean).toBeLessThan(70); // 처음 가는 전술이라 팀 전체로는 손해다
  });

  it("되돌아오면 그때 값을 되찾는다 — 오갈수록 깎이지 않는다", () => {
    const state = createTestGame(7);
    const tactics = userTactics(state);
    for (const a of tactics.assignments) a.familiarity = 70;
    rememberTactics(tactics, state.date);
    const home = squadFamiliarity(state, state.userTeamId);
    // ⚠️ spec은 참조라 갈아엎으면 함께 바뀐다 — 돌아올 값을 미리 떠 둔다
    const origin = { ...tactics.spec };

    // 갔다가
    setTactics(state, { pressing: 5, defensiveLine: 5 });
    rememberTactics(userTactics(state), state.date);
    // 돌아온다
    setTactics(state, { pressing: origin.pressing, defensiveLine: origin.defensiveLine });

    // 실제로 도달했던 값을 기억이 갖고 있으므로 제자리로 온다
    expect(squadFamiliarity(state, state.userTeamId)).toBeCloseTo(home, 0);
  });

  it("자리를 옮겨도 호환 역할은 유지하고 비호환 역할만 초기화한다", () => {
    const state = createTestGame(7);
    const cb = pickCentreBack(state);
    expect(cb, "센터백 배치를 찾지 못했다").toBeTruthy();

    // 그 자리에 없는 역할은 거부하고 고를 수 있는 목록을 알려 준다
    const bad = setPlayerRole(state, { playerId: cb.playerId, role: "poacher" });
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("센터백");

    const ok = setPlayerRole(state, { playerId: cb.playerId, role: "ball-playing-defender" });
    expect(ok.ok).toBe(true);
    expect(
      assignmentsOf(state, state.userTeamId).find((a) => a.playerId === cb.playerId)!.roleId,
    ).toBe("ball-playing-defender");

    // 역할은 자리 위에 얹히는 축이다 — 요구 역량이 달라지므로 그 자리 전력도 달라진다
    const player = playerById(state, cb.playerId)!;
    expect(roleFit(player.attributes, cb.position, "ball-playing-defender")).not.toBe(
      roleFit(player.attributes, cb.position, "no-nonsense-cb"),
    );

    expect(setPlayerTactic(state, { playerId: cb.playerId, position: "LCB" }).ok).toBe(true);
    expect(
      assignmentsOf(state, state.userTeamId).find((a) => a.playerId === cb.playerId)!.roleId,
    ).toBe("ball-playing-defender");

    expect(setPlayerTactic(state, { playerId: cb.playerId, position: "ST" }).ok).toBe(true);
    expect(
      assignmentsOf(state, state.userTeamId).find((a) => a.playerId === cb.playerId)!.roleId,
    ).toBeUndefined();
  });

  it("벤치 선수에겐 역할을 걸 수 없다 — 주 포지션으로 대신 검증하지 않는다", () => {
    const state = createTestGame(7);
    // 최전방 선수를 CF 라인으로 옮겨 CF 역할을 준다 — 선발 정상 경로는 그대로 통과한다
    const fw = assignmentsOf(state, state.userTeamId, "starting").find((a) => a.position === "ST")!;
    expect(setPlayerTactic(state, { playerId: fw.playerId, position: "CF" }).ok).toBe(true);
    const onPitch = setPlayerRole(state, { playerId: fw.playerId, role: "false-nine" });
    expect(onPitch.ok, onPitch.message).toBe(true);

    // 명단 화살표로 벤치와 맞바꾼다 — 벤치 배치엔 좌표가 없어 position이 주 포지션이 된다
    const spare = assignmentsOf(state, state.userTeamId, "bench").find((a) => a.position === "ST")!;
    const swapped = setLineup(state, {
      starting: currentLineup(state).map((s) =>
        s.playerId === fw.playerId ? { ...s, playerId: spare.playerId } : s,
      ),
      bench: [fw.playerId],
    });
    expect(swapped.ok, swapped.message).toBe(true);
    const benched = assignmentsOf(state, state.userTeamId).find((a) => a.playerId === fw.playerId)!;
    expect(benched.role).toBe("bench");
    expect(benched.position).toBe("ST");

    const res = setPlayerRole(state, { playerId: fw.playerId, role: "false-nine" });
    expect(res.ok, "자리 없는 배치에 역할이 걸렸다").toBe(false);

    // 버그의 핵심: 주 포지션으로 대신 검증하면 화면은 CF라 말하는데 반려는 ST 목록을 내민다
    expect(res.message).not.toContain("없는 역할입니다");
    for (const r of rolesFor(benched.position)) {
      expect(res.message, `주 포지션 역할 목록이 새어 나왔다: ${r.id}`).not.toContain(r.id);
    }
    expect(res.message).toContain("선발");
  });

  it("역할을 바꾸면 화면의 전력과 적응도가 실제로 움직인다", () => {
    const state = createTestGame(7);
    const cb = pickCentreBack(state);
    const row = () => buildOfficeViews(state).squad.players.find((x) => x.id === cb.playerId)!;
    const before = row();
    const famBefore = cb.familiarity;

    setPlayerRole(state, { playerId: cb.playerId, role: "ball-playing-defender" });
    const after = row();

    // ① 그 자리 전력이 역할을 반영한다.
    //    예전엔 "자리 묶음이 주 포지션과 다를 때"만 냈더니, 센터백이 센터백 자리에서
    //    역할만 바꿨을 땐 화면 숫자가 꿈쩍도 하지 않았다
    expect(after.slotOverall, "역할을 바꿨는데 자리 전력이 안 나온다").not.toBeNull();
    expect(after.slotOverall).not.toBe(before.slotOverall ?? before.overall);
    expect(after.roleId).toBe("ball-playing-defender");

    // ② 하는 일이 달라졌으니 그 선수의 전술 적응도가 깎인다 (팀 전체가 아니다)
    const now = assignmentsOf(state, state.userTeamId).find((a) => a.playerId === cb.playerId)!;
    expect(now.familiarity).toBeLessThan(famBefore);
  });

  it("역할 변경 비용은 하드코딩이 아니라 **역할 사이 거리**에서 나온다", () => {
    // 볼 플레잉 ↔ 리베로는 둘 다 발로 푸는 수비수라 가깝고,
    // 볼 플레잉 ↔ 노넌센스는 요구가 정반대라 멀다
    const near = roleDistance("CB", "ball-playing-defender", "libero");
    const far = roleDistance("CB", "ball-playing-defender", "no-nonsense-cb");
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
    // 같은 역할이면 0 — 다시 눌러도 손해가 없다
    expect(roleDistance("CB", "libero", "libero")).toBe(0);

    const state = createTestGame(7);
    const cb = assignmentsOf(state, state.userTeamId, "starting").find(
      (a) => weightSlotOf(a.position) === "CB",
    )!;
    const fam = cb.familiarity;
    setPlayerRole(state, { playerId: cb.playerId, role: "ball-playing-defender" });
    const again = assignmentsOf(state, state.userTeamId).find((a) => a.playerId === cb.playerId)!;
    const dropped = fam - again.familiarity;
    setPlayerRole(state, { playerId: cb.playerId, role: "ball-playing-defender" });
    expect(
      assignmentsOf(state, state.userTeamId).find((a) => a.playerId === cb.playerId)!.familiarity,
      "같은 역할을 다시 눌렀는데 또 깎였다",
    ).toBe(again.familiarity);
    expect(dropped).toBeGreaterThan(0);
  });

  it("경기를 뛴 선수는 벤치보다 그 전술을 잘 안다 (개인차의 출처)", () => {
    const state = createTestGame();
    const tactics = userTactics(state);
    const starter = tactics.assignments.find((a) => a.role === "starting")!;
    const bench = tactics.assignments.find((a) => a.role === "bench")!;
    expect(starter.familiarity).toBe(bench.familiarity); // 출발은 같다

    // 시간은 배치된 전원에게 똑같이 붙지만, 출전 보너스는 뛴 선수만 받는다
    for (let i = 0; i < 5; i++) settleTactics(state, state.date);
    expect(starter.familiarity).toBe(bench.familiarity);
    starter.familiarity += 8; // 경기 출전 (match-flow)
    expect(starter.familiarity).toBeGreaterThan(bench.familiarity);
  });

  it("처음 배치되는 선수는 팀보다 전술을 잘 알 수 없다 (신입 역전 방지)", () => {
    const state = createTestGame();
    const tactics = userTactics(state);
    // 팀이 재적응 중 — 배치된 전원이 40
    for (const a of tactics.assignments) a.familiarity = 40;

    // 배치가 없던 선수를 선발에 넣는다 (2군 승격·신규 영입이 이 경로다)
    const assigned = new Set(tactics.assignments.map((a) => a.playerId));
    const newcomer = userPlayers(state).find(
      (p) => !assigned.has(p.id) && p.squadLevel !== "reserve",
    )!;
    const lineup = currentLineup(state);
    lineup[10] = { playerId: newcomer.id, position: lineup[10]!.position };
    expect(setLineup(state, { starting: lineup }).ok).toBe(true);

    const added = assignmentsOf(state, state.userTeamId).find((a) => a.playerId === newcomer.id)!;
    expect(added.familiarity).toBe(40); // 기준선 60이 아니라 팀 수준
    expect(added.familiarity).toBeLessThanOrEqual(
      Math.max(...assignmentsOf(state, state.userTeamId, "starting").map((a) => a.familiarity)),
    );
  });

  it("팀이 이미 숙달돼 있어도 신입은 기준선에서 출발한다", () => {
    const state = createTestGame();
    const tactics = userTactics(state);
    for (const a of tactics.assignments) a.familiarity = 95;
    const assigned = new Set(tactics.assignments.map((a) => a.playerId));
    const newcomer = userPlayers(state).find(
      (p) => !assigned.has(p.id) && p.squadLevel !== "reserve",
    )!;
    const lineup = currentLineup(state);
    lineup[10] = { playerId: newcomer.id, position: lineup[10]!.position };
    expect(setLineup(state, { starting: lineup }).ok).toBe(true);
    const added = assignmentsOf(state, state.userTeamId).find((a) => a.playerId === newcomer.id)!;
    expect(added.familiarity).toBe(60); // 팀이 높다고 공짜로 숙달되지는 않는다
  });

  it("전술을 그대로 다시 저장하면 아무 일도 없다 (자동 저장이 깎지 않는다)", () => {
    const state = createTestGame();
    const spec = { ...userTactics(state).spec };
    for (const a of userTactics(state).assignments) a.familiarity = 71;
    const res = setTactics(state, spec);
    expect(res.ok).toBe(true);
    expect(assignmentsOf(state, state.userTeamId, "starting")[0]!.familiarity).toBe(71);
  });

  it("선수별 좌표 변경이 포메이션 요약을 바꾼다", () => {
    const state = createTestGame();
    const tactics = userTactics(state);
    const before = tactics.spec.formation;
    const mover = tactics.assignments.find((a) => a.role === "starting" && a.position !== "GK")!;
    expect(setPlayerTactic(state, { playerId: mover.playerId, point: { x: 50, y: 9 } }).ok).toBe(
      true,
    );
    expect(tactics.spec.formation).not.toBe(before);
  });

  it("포메이션 이름은 배열 순서와 선수 좌표를 바꾸지 않는다", () => {
    const state = createTestGame();
    const tactics = userTactics(state);
    const keeperId = tactics.assignments.find(
      (a) => a.role === "starting" && a.position === "GK",
    )!.playerId;
    tactics.assignments = [...tactics.assignments].reverse();

    const before = tactics.assignments.map((a) => ({ id: a.playerId, point: a.point }));
    expect(setTactics(state, { formation: "3-5-2" }).ok).toBe(true);
    const keeper = tactics.assignments.find((a) => a.playerId === keeperId)!;
    expect(keeper.position).toBe("GK");
    expect(tactics.assignments.map((a) => ({ id: a.playerId, point: a.point }))).toEqual(before);
  });

  it("개인 지시는 배치에 저장된다", () => {
    const state = createTestGame();
    const target = assignmentsOf(state, state.userTeamId, "starting")[7]!;
    const res = setPlayerInstruction(state, { playerId: target.playerId, note: "더 높게" });
    expect(res.ok).toBe(true);
    expect(
      assignmentsOf(state, state.userTeamId).find((a) => a.playerId === target.playerId)
        ?.instruction,
    ).toBe("더 높게");
  });
});

describe("훈련 명령 = 일정 생성 (규칙 테이블 없음)", () => {
  it("특정 날짜 세션을 등록하면 일정 엔트리가 생긴다", () => {
    const state = createTestGame();
    // 휴가 기간엔 훈련을 걸 수 없다 — 소집일 이후로 잡는다
    const day = addDays(squadReturnOf(state.calendar), 1);
    const res = setTraining(state, {
      sessions: [
        { date: day, slot: "am", label: "세트피스 반복", focus: ["passing", "finishing"] },
      ],
    });
    expect(res.ok).toBe(true);
    const entry = state.schedule.find((e) => e.type === "training" && e.date === day);
    expect(entry).toBeTruthy();
    expect(entry?.time).toBe("10:00"); // am
    const session = state.trainingSessions.find((s) => s.id === entry?.refId);
    expect(session?.label).toBe("세트피스 반복");
    expect(session?.focus).toContain("passing");
  });

  it("요일 반복은 지정 주 수만큼 엔트리로 펼쳐진다", () => {
    const state = createTestGame();
    const res = setTraining(state, {
      repeatWeekly: [{ dow: 1, slot: "pm", label: "체력 훈련", focus: ["strength"] }],
      weeks: 4,
    });
    expect(res.ok).toBe(true);
    // 기본 훈련이 이미 깔려 있으므로(training-plan) 감독이 지시한 세션만 센다
    const ordered = new Set(
      state.trainingSessions.filter((s) => s.label === "체력 훈련").map((s) => s.id),
    );
    const entries = state.schedule.filter((e) => e.type === "training" && ordered.has(e.refId));
    expect(entries).toHaveLength(4);
    for (const e of entries) {
      expect(new Date(`${e.date}T00:00:00Z`).getUTCDay()).toBe(1); // 월요일
      expect(e.time).toBe("15:00"); // pm
    }
  });

  it("잘못된 focus는 반려된다", () => {
    const state = createTestGame();
    expect(
      setTraining(state, {
        sessions: [{ date: "2026-07-06", slot: "am", label: "x", focus: ["nonsense" as never] }],
      }).ok,
    ).toBe(false);
  });

  it("clear로 예정 훈련을 비운다 (지난 훈련은 이력으로 남는다)", () => {
    const state = createTestGame();
    setTraining(state, {
      repeatWeekly: [{ dow: 3, slot: "am", label: "패스", focus: ["passing"] }],
      weeks: 3,
    });
    expect(state.trainingSessions.filter((s) => s.label === "패스")).toHaveLength(3);
    // clear는 기본 훈련까지 포함해 예정 훈련을 전부 비운다 ("당분간 훈련 없다").
    // 자리는 **휴식으로 못 박힌다** — 그냥 지우면 다음 tick이 기본 훈련을 도로 깐다
    const res = setTraining(state, { clear: true });
    expect(res.ok).toBe(true);
    expect(state.trainingSessions.filter((x) => x.rest !== true)).toHaveLength(0);
    // 감독이 잡은 훈련만 걷고 평소 일정으로 돌리려면 rest=false
    const back = setTraining(state, { clear: { rest: false } });
    expect(back.ok).toBe(true);
    expect(state.schedule.filter((e) => e.type === "training")).toHaveLength(0);
  });

  /**
   * 조기 소집은 체력·불만·소집일을 한꺼번에 움직이는 **되돌릴 수 없는** 걸음이다
   * (season.md §4). 뒤따르는 세션 하나가 걸리면 반려를 읽은 감독의 선수단이 이미
   * 지쳐 있었다 — 검증이 전부 끝난 뒤에 적용해야 하는 이유다.
   */
  it("뒤에서 반려되면 조기 소집도 남지 않는다", () => {
    const state = createTestGame();
    const was = squadReturnOf(state.calendar);
    const day = addDays(state.date, 1);
    expect(day < was, "테스트 시작일이 이미 소집일 뒤다").toBe(true);
    const condition = userPlayers(state).map((p) => p.state.condition);
    const issues = state.issues.length;
    const sessions = state.trainingSessions.length;

    const res = setTraining(state, {
      recallSquad: true,
      sessions: [
        { date: day, slot: "am", label: "복귀 훈련", focus: ["strength"] },
        // 설명이 없는 세션 — 예전에는 여기서 반려하면서 소집일만 앞당겨져 있었다
        { date: addDays(day, 1), slot: "am", label: "", focus: ["strength"] },
      ],
    });
    expect(res.ok).toBe(false);
    expect(squadReturnOf(state.calendar)).toBe(was);
    expect(userPlayers(state).map((p) => p.state.condition)).toEqual(condition);
    expect(state.issues).toHaveLength(issues);
    expect(state.trainingSessions).toHaveLength(sessions);
  });

  it("같은 날 같은 슬롯을 다시 지정하면 덮어쓴다", () => {
    const state = createTestGame();
    const day = addDays(squadReturnOf(state.calendar), 2);
    setTraining(state, {
      sessions: [{ date: day, slot: "am", label: "첫 지시", focus: ["passing"] }],
    });
    setTraining(state, {
      sessions: [{ date: day, slot: "am", label: "바뀐 지시", focus: ["finishing"] }],
    });
    const entries = state.schedule.filter((e) => e.type === "training" && e.date === day);
    expect(entries).toHaveLength(1);
    expect(state.trainingSessions.find((s) => s.id === entries[0]?.refId)?.label).toBe("바뀐 지시");
  });
});

describe("사건 기록 — 감독이 말로 만든 사건이 장부에 선다 (people.md §6)", () => {
  const incident = (
    state: GameState,
    over: Partial<Parameters<typeof recordIncident>[1]> & { playerIds: string[] },
  ) =>
    recordIncident(state, {
      kind: "other",
      intensity: 1,
      summary: "장면",
      ...over,
    });

  it("하루 세 건까지다 — 네 번째는 반려되고 장부를 건드리지 않는다", () => {
    const state = createTestGame();
    const player = userPlayers(state)[0]!;
    const fire = () => incident(state, { playerIds: [player.id] });
    for (let n = 1; n <= MAX_INCIDENTS_PER_DAY; n++)
      expect(fire().ok, `${n}번째가 막혔다`).toBe(true);

    const before = { form: player.state.form, rows: state.incidents?.length };
    expect(fire().ok, "네 번째가 통과했다").toBe(false);
    expect(player.state.form).toBe(before.form);
    expect(state.incidents?.length).toBe(before.rows);

    // 날이 바뀌면 다시 세 건이 열린다 — 한도의 단위는 하루다
    state.date = addDays(state.date, 1);
    expect(fire().ok).toBe(true);
  });

  /**
   * 한도를 세는 열쇠는 **갈래**다 (records.ts `NarrativeKind`). 접두 문장으로
   * 가르던 자리라, 문구를 다듬는 것만으로 상한이 사라지던 판정이다. 옛 세이브의
   * `gm-event` 줄도 세지 않는다 — 그 갈래는 더 적히지 않는다.
   */
  it("한도는 문구가 아니라 갈래로 센다", () => {
    const state = createTestGame();
    const player = userPlayers(state)[0]!;
    const fire = () => incident(state, { playerIds: [player.id] });
    expect(fire().ok).toBe(true);

    const line = state.narrative[state.narrative.length - 1]!;
    expect(line.kind, "갈래 없이 적혔다").toBe("incident");
    expect(line.text, "문구에 표식이 박혔다").toBe("장면");

    pushNarrative(state, "리그 3연승", 3, "match");
    pushNarrative(state, "옛 서사 이벤트", 3, "gm-event");
    pushNarrative(state, "갈래를 모르는 옛 줄", 3);
    expect(fire().ok).toBe(true);
    expect(fire().ok).toBe(true);
    expect(fire().ok, "네 번째가 통과했다").toBe(false);
  });

  it("효과표 한 줄 — discipline 세기 2는 당사자 사기 −4 · 팀 사기 +1", () => {
    const state = createTestGame();
    const [party, other] = userPlayers(state) as [GamePlayer, GamePlayer];
    party.state.form = 0;
    other.state.form = 0;
    const before = relationTierOf(state, MANAGER_SUBJECT, party.id);

    const result = incident(state, { kind: "discipline", intensity: 2, playerIds: [party.id] });
    expect(result.ok).toBe(true);
    // 당사자도 팀의 한 사람이다 — 자기 몫 −4 위에 팀 몫 +1이 얹힌다
    expect(party.state.form).toBeCloseTo(moraleToForm(-4 + 1), 10);
    expect(other.state.form).toBeCloseTo(moraleToForm(1), 10);
    expect(result.brief?.items.find((i) => i.label === "사기")?.delta).toBe(-4);
    // 벌금이 그 자리에서 사이를 옮기지는 않는다 — 등급은 압축이 매긴다 (people.md §6)
    expect(relationTierOf(state, MANAGER_SUBJECT, party.id)).toBe(before);
    expect(state.relations ?? []).toHaveLength(0);
  });

  it("세기가 사기를 늘이되 `INCIDENT_MORALE_BOUND` 밖으로는 못 나간다", () => {
    const state = createTestGame();
    const player = userPlayers(state)[2]!;
    // reward 세기 3 = round(4 × 1.5) = 6 — 폭의 끝에 딱 선다
    const result = incident(state, { kind: "reward", intensity: 3, playerIds: [player.id] });
    expect(result.brief?.items.find((i) => i.label === "사기")?.delta).toBe(INCIDENT_MORALE_BOUND);
    const low = incident(state, { kind: "discipline", intensity: 3, playerIds: [player.id] });
    expect(low.brief?.items.find((i) => i.label === "사기")?.delta).toBe(-INCIDENT_MORALE_BOUND);
  });

  it("장부와 인물 기억에 즉시 선다 — 당사자는 이름으로 불러도 id로 적힌다", () => {
    const state = createTestGame();
    const player = userPlayers(state)[3]!;
    const summary = "훈련 지각으로 벌금";
    expect(
      incident(state, { kind: "discipline", intensity: 1, playerIds: [player.name], summary }).ok,
    ).toBe(true);
    const row = state.incidents?.[state.incidents.length - 1];
    expect(row).toMatchObject({
      date: state.date,
      kind: "discipline",
      playerIds: [player.id],
      intensity: 1,
      summary,
    });
    expect(
      state.characterMemories?.some((m) => m.characterId === player.name && m.text === summary),
      "인물 기억이 서지 않았다",
    ).toBe(true);
  });

  it("없는 선수가 하나라도 있으면 반려하고 아무것도 움직이지 않는다 — 원자성", () => {
    const state = createTestGame();
    const player = userPlayers(state)[0]!;
    const snapshot = {
      form: userPlayers(state).map((p) => p.state.form),
      narrative: state.narrative.length,
      relations: state.relations?.length ?? 0,
    };
    const result = incident(state, {
      kind: "outing",
      intensity: 2,
      playerIds: [player.id, "ghost"],
    });
    expect(result.ok).toBe(false);
    expect(userPlayers(state).map((p) => p.state.form)).toEqual(snapshot.form);
    expect(state.narrative.length).toBe(snapshot.narrative);
    expect(state.relations?.length ?? 0).toBe(snapshot.relations);
    expect(state.incidents ?? []).toEqual([]);
  });
});

/**
 * 수용성 앵커 — outcome은 그 선수가 지금 감독의 말을 어떻게 듣는지의 ± 한 단계 안에서만
 * 선다 (career.md §2). 사기·관계는 **잘린 outcome**으로 셈한다.
 */
describe("수용성 — 판정은 앵커 ± 한 단계 안에서만 선다 (career.md §2)", () => {
  it("닫힌 선수에게 보낸 motivated는 neutral에서 멈춘다", () => {
    const state = createTestGame();
    const player = userPlayers(state)[0]!;
    closeOff(state, player);
    player.state.form = 0;
    const result = applyTalkToPlayer(state, {
      playerId: player.id,
      outcome: "motivated",
      intensity: 3,
    });
    expect(result.ok).toBe(true);
    expect(player.state.form).toBe(0);
    expect(result.message).toContain("motivated은 neutral으로");
    expect(result.brief?.items.find((i) => i.label === "수용성")?.text).toBe("닫힘");
  });

  it("열린 선수에게 보낸 angered도 neutral에서 멈춘다", () => {
    const state = createTestGame();
    const player = userPlayers(state)[1]!;
    openUp(state, player);
    player.state.form = 0;
    const result = applyTalkToPlayer(state, {
      playerId: player.id,
      outcome: "angered",
      intensity: 3,
    });
    expect(player.state.form).toBe(0);
    expect(result.message).toContain("angered은 neutral으로");
    // 잘리지 않은 판정에는 그 조각이 없다 — 사실 줄만 남는다
    const plain = applyTalkToPlayer(state, {
      playerId: userPlayers(state)[2]!.id,
      outcome: "neutral",
      intensity: 1,
    });
    expect(plain.message).not.toContain("으로)");
    expect(plain.message).toContain("수용성");
  });
});

describe("잔향 — 그 대화를 쥔 호출이 심경 한 문장을 남긴다 (people.md §5)", () => {
  it("면담의 mood가 그 선수의 moodNote로 선다", () => {
    const state = createTestGame();
    const player = waryOne(state);
    applyTalkToPlayer(state, {
      playerId: player.id,
      outcome: "reassured",
      intensity: 2,
      mood: { text: "자리를 약속받고 한결 가벼워졌다" },
    });
    expect(player.state.moodNote?.text).toBe("자리를 약속받고 한결 가벼워졌다.");
    expect(player.state.moodNote?.on).toBe(state.date);
  });

  it("불만을 푼 면담의 문장은 acknowledgesIssue 없이도 선다 — 해소가 잔향보다 먼저다", () => {
    const state = createTestGame();
    const player = waryWithIssue(state);
    applyTalkToPlayer(state, {
      playerId: player.id,
      outcome: "reassured",
      intensity: 2,
      mood: { text: "응어리가 풀렸다" },
    });
    expect(state.issues.some((i) => i.gamePlayerId === player.id)).toBe(false);
    expect(player.state.moodNote?.text).toBe("응어리가 풀렸다.");
  });

  it("팀토크의 moods는 셋까지다 — 넷이 오면 앞의 셋만", () => {
    const state = createTestGame();
    const four = userPlayers(state).slice(0, 4);
    applyTeamTalk(state, {
      occasion: "daily",
      outcome: "neutral",
      intensity: 1,
      moods: four.map((p, i) => ({ playerId: p.id, text: `한마디 ${i}` })),
    });
    expect(four.slice(0, 3).every((p) => p.state.moodNote !== undefined)).toBe(true);
    expect(four[3]!.state.moodNote).toBeUndefined();
  });
});

/**
 * 역할 기억 — **감독의 결정은 배치보다 오래 산다** (docs/data/player.md §3.1).
 *
 * 배치는 로테이션마다 다시 써지고 벤치·예비는 자리를 갖지 않는다. 기억이 없으면
 * 감독이 고른 역할이 로테이션 한 번에 지워지고, 그 역할은 `roleFit`으로 경기
 * 결과에 그대로 닿는다.
 */
describe("역할 기억 — 벤치를 다녀와도 감독의 결정이 남는다", () => {
  /** 리베로를 고를 수 있는 선발 센터백 하나 */
  const cbOf = (state: GameState) =>
    assignmentsOf(state, state.userTeamId, "starting").find(
      (a) => weightSlotOf(a.position) === "CB",
    )!;

  const assignmentOf = (state: GameState, playerId: string) =>
    userTactics(state).assignments.find((a) => a.playerId === playerId);

  const famOf = (state: GameState, playerId: string) => assignmentOf(state, playerId)!.familiarity;

  const rowOf = (state: GameState, playerId: string) =>
    buildOfficeViews(state).squad.players.find((x) => x.id === playerId)!;

  /** 그 선수를 뺀 선발 11 — 빈 자리는 예비 선수가 메운다 */
  function without(state: GameState, playerId: string) {
    const lineup = currentLineup(state);
    const spare = userPlayers(state).find(
      (p) =>
        p.squadLevel === "first" &&
        isAvailable(state, p) &&
        !lineup.some((s) => s.playerId === p.id),
    )!;
    return lineup.map((s) =>
      s.playerId === playerId ? { playerId: spare.id, position: s.position } : s,
    );
  }

  it("선발 → 벤치 → 예비 → 다시 선발: 리베로로 돌아온다", () => {
    const state = createTestGame(7);
    const cb = cbOf(state);
    const slot = cb.position;
    const lineup = currentLineup(state);
    expect(setPlayerRole(state, { playerId: cb.playerId, role: "libero" }).ok).toBe(true);

    // 벤치 — 자리가 없으니 배치는 역할을 들지 않는다
    expect(
      setLineup(state, {
        starting: without(state, cb.playerId),
        bench: [{ playerId: cb.playerId, position: slot }],
      }).ok,
    ).toBe(true);
    expect(assignmentOf(state, cb.playerId)!.role).toBe("bench");
    expect(assignmentOf(state, cb.playerId)!.roleId).toBeUndefined();

    // 예비 — 벤치 지정을 거두면 배치째 사라진다 (생략은 "지금 벤치 그대로"다 · team.md §6)
    expect(setLineup(state, { starting: without(state, cb.playerId), bench: [] }).ok).toBe(true);
    expect(assignmentOf(state, cb.playerId)).toBeUndefined();

    // 다시 선발 — 그 자리의 기본 역할이 아니라 마지막에 맡긴 역할로 선다
    expect(setLineup(state, { starting: lineup }).ok).toBe(true);
    const back = assignmentOf(state, cb.playerId)!;
    expect(back.position).toBe(slot);
    expect(back.roleId).toBe("libero");
    expect(defaultRoleOf(slot)).not.toBe("libero");
  });

  /**
   * 화면은 기억을 따로 읽지 않는다 (§3.1 · §3.2) — 벤치 행에는 역할이 없고,
   * 다시 선발이 될 때 코어가 배치에 적어 넣은 값이 그대로 알약에 선다.
   * 화면만 기억을 읽으면 장부에 없는 역할을 화면이 말하게 된다.
   */
  it("벤치 행엔 역할이 없고, 다시 선발이 되면 그 역할로 선다", () => {
    const state = createTestGame(7);
    const cb = cbOf(state);
    const slot = cb.position;
    const lineup = currentLineup(state);
    setPlayerRole(state, { playerId: cb.playerId, role: "libero" });
    const onPitch = rowOf(state, cb.playerId);
    expect(onPitch.roleId).toBe("libero");

    setLineup(state, {
      starting: without(state, cb.playerId),
      bench: [{ playerId: cb.playerId, position: slot }],
    });
    const onBench = rowOf(state, cb.playerId);
    // 자리가 없으면 역할도 없다 — 알약도, 목록도 서지 않는다
    expect(onBench.roleId).toBeNull();
    expect(onBench.roleOptions).toHaveLength(0);

    setLineup(state, { starting: lineup });
    const back = rowOf(state, cb.playerId);
    expect(back.roleId).toBe("libero");
    expect(back.slotOverall).toBe(onPitch.slotOverall);
  });

  it("감독이 새로 고르면 그게 새 기억이다 — 되찾기는 기본값을 갈아끼울 뿐", () => {
    const state = createTestGame(7);
    const cb = cbOf(state);
    const slot = cb.position;
    const lineup = currentLineup(state);
    setPlayerRole(state, { playerId: cb.playerId, role: "libero" });
    setPlayerRole(state, { playerId: cb.playerId, role: "ball-playing-defender" });

    setLineup(state, {
      starting: without(state, cb.playerId),
      bench: [{ playerId: cb.playerId, position: slot }],
    });
    setLineup(state, { starting: lineup });
    expect(assignmentOf(state, cb.playerId)!.roleId).toBe("ball-playing-defender");
  });

  it("자리가 다르면 기억이 닿지 않는다 — 키는 (선수, 자리)다", () => {
    const state = createTestGame(7);
    const cb = cbOf(state);
    setPlayerRole(state, { playerId: cb.playerId, role: "libero" });

    const moved = currentLineup(state).map((s) =>
      s.playerId === cb.playerId ? { playerId: s.playerId, position: "DM" } : s,
    );
    expect(setLineup(state, { starting: moved }).ok).toBe(true);
    const now = assignmentOf(state, cb.playerId)!;
    expect(weightSlotOf(now.position)).not.toBe("CB");
    expect(now.roleId).toBeUndefined();
    expect(rowOf(state, cb.playerId).roleId).toBe(defaultRoleOf(now.position));
  });

  it("같은 날 벤치를 다녀와도 역할 대가를 두 번 물지 않는다", () => {
    const state = createTestGame(7);
    const cb = cbOf(state);
    const slot = cb.position;
    const lineup = currentLineup(state);
    const morning = cb.roleId ?? defaultRoleOf(slot);
    const start = famOf(state, cb.playerId);

    setPlayerRole(state, { playerId: cb.playerId, role: "libero" });
    expect(famOf(state, cb.playerId)).toBeLessThan(start);

    setLineup(state, {
      starting: without(state, cb.playerId),
      bench: [{ playerId: cb.playerId, position: slot }],
    });
    setLineup(state, { starting: lineup });

    // 아침의 역할로 되돌아오면 낸 값도 돌아온다 — 장부(roleMemo)가 벤치를 건너 이어진다
    expect(setPlayerRole(state, { playerId: cb.playerId, role: morning }).ok).toBe(true);
    expect(famOf(state, cb.playerId)).toBeCloseTo(start, 6);
  });
});

/**
 * 왕복 — **되돌린 것은 정확히 제자리로** (docs/data/player.md §7.2·§7.3).
 *
 * 적응도는 시뮬에서 곱셈 팩터로 전력에 직접 닿는다. 되돌릴 수 있어야 감독이 판을
 * 시험하는데, 넣어 보는 행위 자체가 값을 태우면 시험하지 않는다.
 */
describe("적응도 왕복 — 2군 · 자리 · 천장 100", () => {
  const cbOf = (state: GameState) =>
    assignmentsOf(state, state.userTeamId, "starting").find(
      (a) => weightSlotOf(a.position) === "CB",
    )!;

  const assignmentOf = (state: GameState, playerId: string) =>
    userTactics(state).assignments.find((a) => a.playerId === playerId);

  /** 그 선수를 뺀 선발 11 — 빈 자리는 예비 선수가 메운다 */
  function without(state: GameState, playerId: string) {
    const lineup = currentLineup(state);
    const spare = userPlayers(state).find(
      (p) =>
        p.squadLevel === "first" &&
        isAvailable(state, p) &&
        !lineup.some((s) => s.playerId === p.id),
    )!;
    return lineup.map((s) =>
      s.playerId === playerId ? { playerId: spare.id, position: s.position } : s,
    );
  }

  it("2군을 다녀와도 적응도와 익힌 전술 기억을 그대로 갖고 돌아온다", () => {
    const state = createTestGame(7);
    const cb = cbOf(state);
    const lineup = currentLineup(state);
    const assignment = assignmentOf(state, cb.playerId)!;
    assignment.familiarity = 95;
    settleTactics(state, state.date);
    const drilled = assignment.drilled!.map((d) => ({ ...d }));
    expect(drilled.length).toBeGreaterThan(0);

    // 배치에서 통째로 빠진다 — 여기서 값이 새면 돌아올 통로 자체가 없다
    expect(setLineup(state, { starting: without(state, cb.playerId) }).ok).toBe(true);
    expect(setSquadLevel(state, { playerId: cb.playerId, level: "reserve" }).ok).toBe(true);
    expect(assignmentOf(state, cb.playerId)).toBeUndefined();
    expect(userTactics(state).shelved?.some((s) => s.playerId === cb.playerId)).toBe(true);

    expect(setSquadLevel(state, { playerId: cb.playerId, level: "first" }).ok).toBe(true);
    expect(setLineup(state, { starting: lineup }).ok).toBe(true);

    const back = assignmentOf(state, cb.playerId)!;
    expect(back.familiarity).toBe(95);
    expect(back.drilled).toEqual(drilled);
    // 선반은 배치가 다시 들고 갔으므로 비어 있다
    expect(userTactics(state).shelved?.some((s) => s.playerId === cb.playerId)).toBe(false);
  });

  it("매치데이 명단 밖으로 밀려나도 개인 기억이 살아 있다", () => {
    const state = createTestGame(7);
    const cb = cbOf(state);
    const lineup = currentLineup(state);
    assignmentOf(state, cb.playerId)!.familiarity = 88;
    settleTactics(state, state.date);

    // 선발도 벤치도 아니면 배치가 없다(예비) — 선반이 받아 간다
    expect(setLineup(state, { starting: without(state, cb.playerId), bench: [] }).ok).toBe(true);
    expect(assignmentOf(state, cb.playerId)).toBeUndefined();

    expect(setLineup(state, { starting: lineup }).ok).toBe(true);
    expect(assignmentOf(state, cb.playerId)!.familiarity).toBe(88);
  });

  it("라인업을 저장해도 개인 전술 기억은 배치를 따라간다", () => {
    const state = createTestGame(7);
    const cb = cbOf(state);
    settleTactics(state, state.date);
    const drilled = assignmentOf(state, cb.playerId)!.drilled!.map((d) => ({ ...d }));

    expect(setLineup(state, { starting: currentLineup(state) }).ok).toBe(true);
    expect(assignmentOf(state, cb.playerId)!.drilled).toEqual(drilled);
  });

  it("자리를 옮겼다 되돌리면 역할도 적응도도 그날 아침 값으로 닫힌다", () => {
    const state = createTestGame(7);
    const cb = cbOf(state);
    const slot = cb.position;
    const morning = cb.roleId ?? defaultRoleOf(slot);
    const start = assignmentOf(state, cb.playerId)!.familiarity;
    const cost = roleChangeCost(slot, morning, "libero");
    expect(cost).toBeGreaterThan(0);

    expect(setPlayerRole(state, { playerId: cb.playerId, role: "libero" }).ok).toBe(true);
    expect(assignmentOf(state, cb.playerId)!.familiarity).toBeCloseTo(start - cost, 6);

    // 자리를 벗어나면 낸 값은 되돌아온다 — 아침의 역할과 견줄 자가 없다
    expect(setPlayerTactic(state, { playerId: cb.playerId, position: "DM" }).ok).toBe(true);
    expect(assignmentOf(state, cb.playerId)!.familiarity).toBeCloseTo(start, 6);

    // 되돌아오면 기억이 리베로를 되살리고, 그 대가를 다시 문다 (떠난 적 없는 것과 같다)
    expect(setPlayerTactic(state, { playerId: cb.playerId, position: slot }).ok).toBe(true);
    const back = assignmentOf(state, cb.playerId)!;
    expect(back.roleId).toBe("libero");
    expect(back.familiarity).toBeCloseTo(start - cost, 6);

    // 아침의 역할로 되돌리면 환불이다 — 왕복 한 번에 두 배가 아니다
    expect(setPlayerRole(state, { playerId: cb.playerId, role: morning }).ok).toBe(true);
    expect(assignmentOf(state, cb.playerId)!.familiarity).toBeCloseTo(start, 6);
  });

  it("전술판이 자리를 옮겨도(라인업 저장) 같은 값으로 닫힌다", () => {
    const state = createTestGame(7);
    const cb = cbOf(state);
    const slot = cb.position;
    const morning = cb.roleId ?? defaultRoleOf(slot);
    const start = assignmentOf(state, cb.playerId)!.familiarity;
    const lineup = currentLineup(state);

    expect(setPlayerRole(state, { playerId: cb.playerId, role: "libero" }).ok).toBe(true);
    const moved = lineup.map((s) =>
      s.playerId === cb.playerId ? { playerId: s.playerId, position: "DM" } : s,
    );
    expect(setLineup(state, { starting: moved }).ok).toBe(true);
    expect(assignmentOf(state, cb.playerId)!.familiarity).toBeCloseTo(start, 6);

    expect(setLineup(state, { starting: lineup }).ok).toBe(true);
    expect(setPlayerRole(state, { playerId: cb.playerId, role: morning }).ok).toBe(true);
    expect(assignmentOf(state, cb.playerId)!.familiarity).toBeCloseTo(start, 6);
  });

  it("선반에 있는 선수의 행은 판에 올렸을 때의 값을 미리 낸다", () => {
    const state = createTestGame(7);
    const cb = cbOf(state);
    assignmentOf(state, cb.playerId)!.familiarity = 95;
    expect(setLineup(state, { starting: without(state, cb.playerId), bench: [] }).ok).toBe(true);

    const rows = buildOfficeViews(state).squad.players;
    const shelved = rows.find((x) => x.id === cb.playerId)!;
    // 화면이 min(60, 팀)을 스스로 계산하면 돌아온 주전을 60으로 예고했다가 튄다
    expect(shelved.familiarityIfSlotted, "선반이 기준선을 이긴다").toBe(95);

    // 선반에도 없는 선수는 그대로 진짜 신입의 기준선이다
    const teamLevel = squadFamiliarity(state, state.userTeamId);
    const newcomer = rows.find(
      (x) => assignmentOf(state, x.id) === undefined && x.id !== cb.playerId,
    )!;
    expect(newcomer.familiarityIfSlotted).toBe(Math.round(Math.min(60, teamLevel)));
  });

  it("적응도 100인 선수가 전술을 바꿨다 되돌리면 다시 100이다", () => {
    const state = createTestGame(7);
    const tactics = userTactics(state);
    tactics.spec = { ...DEFAULT_TACTICS };
    for (const a of tactics.assignments) a.familiarity = 100;
    settleTactics(state, state.date);

    expect(setTactics(state, { mentality: 5, pressing: 5 }).ok).toBe(true);
    expect(squadFamiliarity(state, state.userTeamId)).toBeLessThan(100);

    expect(
      setTactics(state, {
        mentality: DEFAULT_TACTICS.mentality,
        pressing: DEFAULT_TACTICS.pressing,
      }).ok,
    ).toBe(true);
    for (const a of tactics.assignments) {
      expect(a.familiarity, "천장 100은 기억에도 그대로 적힌다").toBe(100);
    }
  });
});

/**
 * 자리 이동·개인 훈련 — 감독이 도구 하나로 바로 거는 명령이다 (`commands/index.ts`).
 * 이적·방출과 한 파일에 있었지만 여기가 그 코드가 사는 자리다.
 */
describe("자리 이동 — 교체 없이 선발 안에서만", () => {
  /** 목표 자리를 지금 쓰고 있지 않은 선발 — 옮겨야 옮긴 것이 보인다 */
  function starterAwayFrom(state: GameState, position: string) {
    const found = userTactics(state).assignments.find(
      (a) => a.role === "starting" && a.position !== position,
    );
    expect(found, `모든 선발이 ${position}에 서 있다`).toBeDefined();
    return found!;
  }

  it("뛰고 있는 선수의 자리를 바꾼다", () => {
    const state = createTestGame();
    const starter = starterAwayFrom(state, "CM");
    const res = movePlayerSlot(state, { playerId: starter.playerId, position: "CM" });
    expect(res.ok, res.message).toBe(true);
    expect(
      userTactics(state).assignments.find((a) => a.playerId === starter.playerId)!.position,
    ).toBe("CM");
  });

  it("벤치 선수는 교체로만 넣는다 — 자리 이동으로는 못 들어온다", () => {
    const state = createTestGame();
    const bench = userTactics(state).assignments.find((a) => a.role === "bench")!;
    const res = movePlayerSlot(state, { playerId: bench.playerId, position: "CM" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("그라운드에 없습니다");
  });
});

describe("개인 훈련 — 팀 훈련 위에 한 선수만", () => {
  /** 주전이 아닌 1군 — 개인 프로그램을 걸 대상 (자리까지 걸 수 있는 층) */
  const spare = (state: GameState) =>
    userPlayers(state)
      .filter((p) => squadLevelOf(p) === "first")
      .sort((a, b) => a.attributes.overall - b.attributes.overall)[0]!;

  it("축과 자리를 걸고 거둘 수 있다", () => {
    const state = createTestGame();
    const target = spare(state);
    expect(setPlayerTraining(state, { playerId: target.id, axis: "finishing" }).ok).toBe(true);
    expect(state.playerTraining).toHaveLength(1);

    expect(setPlayerTraining(state, { playerId: target.id, position: "CB" }).ok).toBe(true);
    expect(state.playerTraining[0]!.position).toBe("CB");
    // 프로그램은 선수당 하나 — 덮어쓴다
    expect(state.playerTraining).toHaveLength(1);

    expect(setPlayerTraining(state, { playerId: target.id, clear: true }).ok).toBe(true);
    expect(state.playerTraining).toHaveLength(0);
  });

  it("없는 축·자리는 반려한다", () => {
    const state = createTestGame();
    const target = spare(state);
    expect(setPlayerTraining(state, { playerId: target.id, axis: "wizardry" }).ok).toBe(false);
    expect(setPlayerTraining(state, { playerId: target.id, position: "XX" }).ok).toBe(false);
  });

  /**
   * 2군에는 축만 걸린다 — 자리를 올리는 문은 훈련 결산 하나뿐이고 2군은 결산을
   * 받지 않는다 (season.md §2). 성공으로 답해 놓고 아무 데도 닿지 않는 것이 버그였다.
   */
  it("2군에는 자리를 걸 수 없고, 축은 걸린다", () => {
    const state = createTestGame();
    const reserve = reservePlayers(state, state.userTeamId)[0]!;

    const rejected = setPlayerTraining(state, { playerId: reserve.id, position: "CB" });
    expect(rejected.ok).toBe(false);
    expect(state.playerTraining).toHaveLength(0);

    // 반려는 요청 전체에 걸린다 — 축만 남기고 걸지 않는다
    expect(
      setPlayerTraining(state, { playerId: reserve.id, axis: "finishing", position: "CB" }).ok,
    ).toBe(false);
    expect(state.playerTraining).toHaveLength(0);

    expect(setPlayerTraining(state, { playerId: reserve.id, axis: "finishing" }).ok).toBe(true);
    expect(state.playerTraining[0]!.axis).toBe("finishing");
  });

  it("강등하면 자리 프로그램만 거둬지고 겨냥한 축은 남는다", () => {
    const state = createTestGame();
    const target = spare(state);
    expect(
      setPlayerTraining(state, { playerId: target.id, axis: "passing", position: "CB" }).ok,
    ).toBe(true);

    const moved = setSquadLevel(state, { playerId: target.id, level: "reserve" });
    expect(moved.ok, moved.message).toBe(true);
    expect(moved.message).toContain("전향 훈련은 거뒀습니다");
    expect(state.playerTraining[0]!.position).toBeUndefined();
    // 축은 월간 성장이 이어 받는다
    expect(state.playerTraining[0]!.axis).toBe("passing");
  });

  it("자리만 걸린 선수를 강등하면 프로그램 자체가 걷힌다", () => {
    const state = createTestGame();
    const target = spare(state);
    expect(setPlayerTraining(state, { playerId: target.id, position: "CB" }).ok).toBe(true);
    expect(setSquadLevel(state, { playerId: target.id, level: "reserve" }).ok).toBe(true);
    expect(state.playerTraining).toHaveLength(0);
  });
});

/**
 * 화면 조작은 **모아 두었다가 한 번에** 읽힌다 (state.ts).
 * 판을 짜며 열 번을 만지는데 그때마다 턴을 만들면 채팅이 조작 로그가 된다.
 */

describe("조작 모으기", () => {
  it("같은 대상은 접힌다 — 과정이 아니라 결과가 남는다", () => {
    const state = createTestGame();
    recordEdit(state, "role:p1", "역할 → 볼 플레잉 디펜더");
    recordEdit(state, "role:p1", "역할 → 리베로");
    recordEdit(state, "role:p1", "역할 → 노넌센스");
    recordEdit(state, "role:p2", "역할 → 레지스타");

    expect(state.pendingEdits).toHaveLength(2);
    expect(state.pendingEdits![0]!.text).toContain("노넌센스");
  });

  it("상한을 넘으면 오래된 것부터 밀린다", () => {
    const state = createTestGame();
    for (let i = 0; i < PENDING_EDIT_LIMIT + 5; i++) recordEdit(state, `k${i}`, `조작 ${i}`);
    expect(state.pendingEdits).toHaveLength(PENDING_EDIT_LIMIT);
    expect(state.pendingEdits![0]!.text).toBe("조작 5");
  });

  it("꺼내면 비워진다 — 다음 턴에 다시 읽히지 않는다", () => {
    const state = createTestGame();
    recordEdit(state, "lineup", "전술판: 자리를 조정했다");
    expect(takeEdits(state)).toHaveLength(1);
    expect(takeEdits(state)).toHaveLength(0);
  });
});

describe("전술판이 바꾼 것", () => {
  it("선발이 바뀌면 들어온 사람과 빠진 사람을 적는다", () => {
    const state = createTestGame();
    const before = {
      starting: startingIdsOf(state),
      shape: shapeOfTactics(state),
      signature: lineupSignature(state),
    };
    const bench = userPlayers(state).find((p) => !before.starting.includes(p.id))!;
    const starting = [...before.starting.slice(0, 10), bench.id];

    const res = setLineup(state, { starting: starting.map((playerId) => ({ playerId })) });
    expect(res.ok, res.message).toBe(true);

    const note = lineupChangeNote(state, before)!;
    expect(note).toContain(bench.name);
  });

  it("아무것도 안 바뀌면 남기지 않는다", () => {
    const state = createTestGame();
    const before = {
      starting: startingIdsOf(state),
      shape: shapeOfTactics(state),
      signature: lineupSignature(state),
    };
    expect(lineupChangeNote(state, before)).toBeNull();
  });
});

describe("멘토링 — 감독이 고참에게 유망주를 맡긴다 (people.md §5-3)", () => {
  /** 나이를 못 박은 생일 — 시즌 시작이 7월이라 1월 1일생은 그 해에 이미 그 나이다 */
  const bornAt = (state: GameState, age: number) => `${Number(state.date.slice(0, 4)) - age}-01-01`;

  /**
   * 자격을 못 박아 둔다 — 시드의 나이와 리더십은 세계가 바뀌면 함께 움직인다.
   * 경계를 재는 케이스가 그 값에 기대면 세계를 손볼 때마다 이유 없이 붉어진다.
   */
  function makeMentor(state: GameState, player: GamePlayer, leadership = 70): GamePlayer {
    player.squadLevel = "first";
    player.birthdate = bornAt(state, MENTOR_AGE_MIN + 2);
    player.attributes.leadership = leadership;
    return player;
  }
  function makeMentee(state: GameState, player: GamePlayer, age = 19): GamePlayer {
    player.birthdate = bornAt(state, age);
    return player;
  }

  it("자격 밖은 반려된다 — 2군 멘토 · 어린 멘토 · 리더십 미달 · 다 큰 멘티", () => {
    const state = createTestGame();
    const [first, second] = userPlayers(state).filter((p) => squadLevelOf(p) === "first");
    const mentor = makeMentor(state, first!);
    const mentee = makeMentee(state, second!);
    const ask = () => setMentor(state, { mentorId: mentor.id, menteeIds: [mentee.id] });

    mentor.squadLevel = "reserve";
    expect(ask().ok).toBe(false);
    mentor.squadLevel = "first";

    mentor.birthdate = bornAt(state, MENTOR_AGE_MIN - 1);
    expect(ask().ok).toBe(false);
    mentor.birthdate = bornAt(state, MENTOR_AGE_MIN);

    mentor.attributes.leadership = MENTOR_LEADERSHIP_MIN - 1;
    expect(ask().ok).toBe(false);
    mentor.attributes.leadership = MENTOR_LEADERSHIP_MIN;

    mentee.birthdate = bornAt(state, MENTEE_AGE_MAX + 1);
    expect(ask().ok).toBe(false);
    mentee.birthdate = bornAt(state, MENTEE_AGE_MAX);

    // 넷을 다 통과한 뒤에야 사이가 선다 — 반려가 장부를 건드리지 않았다는 사실도 여기 선다
    expect(ask().ok).toBe(true);
    expect(mentorPairOf(state, mentee.id)?.mentorId).toBe(mentor.id);
    expect(state.mentoring).toHaveLength(1);
  });

  it("한 멘토의 인원에는 상한이 있다", () => {
    const state = createTestGame();
    const ours = userPlayers(state).filter((p) => squadLevelOf(p) === "first");
    const mentor = makeMentor(state, ours[0]!);
    const kids = ours.slice(1, MENTEES_PER_MENTOR + 2).map((p) => makeMentee(state, p));

    const over = setMentor(state, { mentorId: mentor.id, menteeIds: kids.map((p) => p.id) });
    expect(over.ok).toBe(false);
    expect(state.mentoring ?? []).toHaveLength(0);

    const fits = kids.slice(0, MENTEES_PER_MENTOR);
    expect(setMentor(state, { mentorId: mentor.id, menteeIds: fits.map((p) => p.id) }).ok).toBe(
      true,
    );
    expect(menteePairsOf(state, mentor.id)).toHaveLength(MENTEES_PER_MENTOR);
  });

  it("목록을 다시 적으면 빠진 짝은 지워지지 않고 manager로 닫힌다", () => {
    const state = createTestGame();
    const ours = userPlayers(state).filter((p) => squadLevelOf(p) === "first");
    const mentor = makeMentor(state, ours[0]!);
    const other = makeMentor(state, ours[1]!);
    const dropped = makeMentee(state, ours[2]!);
    const kept = makeMentee(state, ours[3]!, 20);

    expect(setMentor(state, { mentorId: mentor.id, menteeIds: [dropped.id, kept.id] }).ok).toBe(
      true,
    );

    // 한 선수는 한 멘토 — 남의 아이를 데려가려면 그쪽 목록을 먼저 다시 적어야 한다
    expect(setMentor(state, { mentorId: other.id, menteeIds: [kept.id] }).ok).toBe(false);

    expect(setMentor(state, { mentorId: mentor.id, menteeIds: [kept.id] }).ok).toBe(true);
    const closed = (state.mentoring ?? []).find((m) => m.menteeId === dropped.id);
    expect(closed?.endedBy).toBe("manager");
    expect(closed?.until).toBe(state.date);
    expect(menteePairsOf(state, mentor.id).map((m) => m.menteeId)).toEqual([kept.id]);
    // 닫힌 줄은 창(MENTORING_ECHO_DAYS) 안에서 그대로 남는다
    expect(state.mentoring).toHaveLength(2);

    // 목록을 비우면 그 멘토의 사이가 다 닫힌다
    expect(setMentor(state, { mentorId: mentor.id }).ok).toBe(true);
    expect(menteePairsOf(state, mentor.id)).toHaveLength(0);
    expect(mentorPairOf(state, kept.id)).toBeNull();
  });

  it("멘토가 2군으로 내려가면 squad로 닫힌다 — 멘티가 내려가는 것은 닫지 않는다", () => {
    const state = createTestGame();
    const ours = userPlayers(state).filter((p) => squadLevelOf(p) === "first");
    const mentor = makeMentor(state, ours[0]!);
    const mentee = makeMentee(state, ours[1]!);
    expect(setMentor(state, { mentorId: mentor.id, menteeIds: [mentee.id] }).ok).toBe(true);

    // 멘티는 두 층 어디에도 선다 (배율이 닿는 경로만 다르다)
    expect(setSquadLevel(state, { playerId: mentee.id, level: "reserve" }).ok).toBe(true);
    expect(mentorPairOf(state, mentee.id)?.mentorId).toBe(mentor.id);

    // 2군에는 완장이 없듯 멘토도 없다
    expect(setSquadLevel(state, { playerId: mentor.id, level: "reserve" }).ok).toBe(true);
    const row = (state.mentoring ?? []).find((m) => m.menteeId === mentee.id);
    expect(row?.endedBy).toBe("squad");
    expect(menteePairsOf(state, mentor.id)).toHaveLength(0);
  });
});
