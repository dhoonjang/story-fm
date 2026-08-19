import { describe, expect, it } from "vitest";
import {
  advanceSegment,
  assignmentsOf,
  finalizeMatch,
  playerById,
  startMatch,
  substitutePlayer,
  tacticsOf,
  userPlayers,
  userSide,
  isClubTeam,
  simSquadOf,
  type GameState,
} from "@story-fm/engine";
import {
  conditionDrain,
  dailyRecovery,
  GAP_CONDITION,
  RECOVERY_BASE,
  recoveryFactor,
  buildStrengthPacket,
} from "@story-fm/sim";
import { DEFAULT_TACTICS, naturalPositionOf, weightSlotOf } from "@story-fm/domain";
import {
  advanceDays,
  advanceToMatchday,
  createTestGame,
  playMockMatch,
  playPreseason,
} from "./helpers";

/**
 * 체력의 경제 — **한 경기가 선수를 비우고, 회복은 며칠에 걸쳐 갚는다.**
 *
 * 여기서 고정하는 것은 숫자가 아니라 게임의 계약이다: 90분을 뛰면 바닥 근처로
 * 가고, 사흘 뒤 경기에는 지구력이 좋은 선수만 그대로 나갈 수 있다. 이게 무너지면
 * "누구를 쉬게 할까"라는 결정 자체가 게임에서 사라진다 (match.md §3).
 */

function startersOf(state: ReturnType<typeof createTestGame>) {
  return assignmentsOf(state, state.userTeamId)
    .filter((a) => a.role === "starting")
    .map((a) => ({ id: a.playerId, position: a.position }));
}

function createNeutralGame() {
  const state = createTestGame(9, "manutd");
  tacticsOf(state, state.userTeamId).spec = { ...DEFAULT_TACTICS };
  return state;
}

describe("경기 체력 — 소모", () => {
  it("90분을 뛰면 절반 아래로 — 그래도 다리가 멈추지는 않는다", () => {
    const state = createNeutralGame();
    advanceToMatchday(state);
    const starters = startersOf(state);
    for (const s of starters) playerById(state, s.id)!.state.condition = 100;

    playMockMatch(state);

    const outfield = starters
      .filter((s) => s.position !== "GK")
      .map((s) => playerById(state, s.id)!.state.condition);
    /**
     * 필드 플레이어는 **평균 절반 아래**로 — 이겨서 사기가 붙어도 마찬가지다.
     * ⚠️ 최댓값에 문턱을 걸지 않는다: 센터백은 원래 덜 지치고 거기에 그날의 몫
     * (`drainVariance` ±12%)이 곱해져 운 좋은 한 명이 50을 살짝 넘을 수 있다.
     */
    const mean = outfield.reduce((a, b) => a + b, 0) / outfield.length;
    expect(mean).toBeLessThan(42);
    // 가장 많이 뛴 자리(중원·측면)가 절반 아래인 것까지가 계약이다
    expect(Math.min(...outfield)).toBeLessThan(35);
    /**
     * **여기가 하한이다.** 만땅으로 시작해 90분을 뛴 선수가 구멍 문턱
     * (`GAP_CONDITION`) 아래로 내려가면 그 문턱은 예외가 아니라 상수가 되고, 후반마다
     * 모든 라인에 구멍 키포인트가 뜬다 (stamina.ts §구멍).
     */
    expect(Math.min(...outfield)).toBeGreaterThan(GAP_CONDITION);
  });

  it("자리가 소모를 가른다 — 골키퍼와 중원이 같이 지치지 않는다", () => {
    const state = createNeutralGame();
    advanceToMatchday(state);
    const starters = startersOf(state);
    for (const s of starters) playerById(state, s.id)!.state.condition = 100;

    playMockMatch(state);

    const at = (pos: string) => {
      const found = starters.find((s) => s.position === pos);
      return found ? playerById(state, found.id)!.state.condition : null;
    };
    const gk = at("GK")!;
    const outfield = starters
      .filter((s) => s.position !== "GK")
      .map((s) => playerById(state, s.id)!.state.condition);
    expect(gk).toBeGreaterThan(Math.max(...outfield) + 15);
    // 뒤(센터백)와 앞·옆(중원·측면)도 갈린다
    expect(Math.max(...outfield) - Math.min(...outfield)).toBeGreaterThan(10);
  });

  /**
   * **감독이 직접 교체를 지시한다.** 예전 이 케이스는 시즌 스탯에서 교체 자원을
   * 뽑고 비면 `return` 했는데, 시즌 첫 경기는 친선이라 시즌 장부에 한 줄도 안
   * 남고(season.md §2) mock 경기는 우리 선수를 스스로 빼지도 않는다 — 목록이 늘
   * 비어서 케이스가 **한 번도 돌지 않았다.**
   */
  it("교체로 들어온 선수는 뛴 만큼만 지친다 — 상수로 뭉개지 않는다", () => {
    const state = createNeutralGame();
    advanceToMatchday(state);
    for (const p of userPlayers(state)) p.state.condition = 100;

    const started = startMatch(state);
    expect(started.ok, started.message).toBe(true);
    const side = userSide(state);
    const ledger = () => state.pendingMatch!.ledger[side];
    const starters = startersOf(state);
    const goingOff = starters.find((x) => x.position !== "GK")!;
    /**
     * 벤치의 **필드 플레이어**를 넣는다. 벤치 첫 자리는 백업 골키퍼라, 그를 오른쪽
     * 수비로 넣으면 지구력 축이 낮아 45분에 90분치를 소모한다 — 재는 것이
     * "뛴 시간"이 아니라 "잘못 세운 사람"이 된다.
     */
    const coming = ledger()
      .bench.map((id) => playerById(state, id)!)
      .find((p) => weightSlotOf(naturalPositionOf(p).position) !== "GK")!;
    expect(coming, "벤치에 필드 플레이어가 없다").toBeDefined();

    // 하프타임까지 굴리고 한 명을 바꾼다 — 그가 뛰는 시간이 절반으로 갈린다
    let guard = 60;
    while (state.phase === "match" && guard-- > 0) {
      const step = advanceSegment(state);
      expect(step.ok, step.message).toBe(true);
      if (step.plan?.stop === "half_time") break;
      expect(step.plan?.stop, "하프타임 전에 경기가 끝났다").not.toBe("full_time");
    }
    const swapped = substitutePlayer(state, {
      out: playerById(state, goingOff.id)!.name,
      in: coming.name,
    });
    expect(swapped.ok, swapped.message).toBe(true);

    guard = 60;
    while (state.phase === "match" && guard-- > 0) {
      const step = advanceSegment(state);
      expect(step.ok, step.message).toBe(true);
      if (step.plan?.stop === "full_time") {
        finalizeMatch(state);
        break;
      }
    }
    expect(state.phase, "경기가 끝나지 않았다").not.toBe("match");

    // 45분만 뛴 선수는 90분을 뛴 누구보다도 덜 닳았다
    const played90 = starters
      .filter((x) => x.position !== "GK" && x.id !== goingOff.id)
      .map((x) => playerById(state, x.id)!.state.condition);
    expect(played90.length).toBeGreaterThan(5);
    // 90분을 채운 **누구보다도** 남아 있다 — 상수로 뭉개면 여기가 뒤집힌다
    expect(playerById(state, coming.id)!.state.condition).toBeGreaterThan(Math.max(...played90));
  });

  it("우리와 붙은 상대도 대가를 치른다 — 우리만 지치지 않는다", () => {
    const state = createNeutralGame();
    advanceToMatchday(state);
    const match = state.matches.find(
      (m) => !m.result && (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    )!;
    const oppId = match.homeTeamId === state.userTeamId ? match.awayTeamId : match.homeTeamId;
    const before = new Map(
      state.players.filter((p) => p.teamId === oppId).map((p) => [p.id, p.state.condition]),
    );

    playMockMatch(state);

    const dropped = [...before.entries()].filter(
      ([id, was]) => (playerById(state, id)?.state.condition ?? was) < was - 20,
    );
    expect(dropped.length).toBeGreaterThanOrEqual(10);
  });
});

describe("경기 체력 — 회복", () => {
  it("지구력 70 공격수는 체력 100에서 풀타임 뒤 35~41을 남긴다", () => {
    const player = {
      attributes: { stamina: 70 },
      state: { condition: 100 },
    } as unknown as Parameters<typeof conditionDrain>[0];
    const remaining = 100 - conditionDrain(player, "ST", DEFAULT_TACTICS, 90);
    expect(remaining).toBeGreaterThanOrEqual(35);
    expect(remaining).toBeLessThanOrEqual(41);
  });

  it("감쇠 곡선은 경기를 나눈 구간 수와 무관하다", () => {
    const player = {
      attributes: { stamina: 70 },
      state: { condition: 100 },
    } as unknown as Parameters<typeof conditionDrain>[0];
    const whole = conditionDrain(player, "ST", DEFAULT_TACTICS, 90);
    const first = conditionDrain(player, "ST", DEFAULT_TACTICS, 45);
    const second = conditionDrain(player, "ST", DEFAULT_TACTICS, 45, 1, 1, 0.5, 100 - first);
    expect(first + second).toBeCloseTo(whole, 9);
    expect(second).toBeLessThan(first);
  });

  it("지구력 60 중앙 미드필더는 60분 뒤 체력 60 아래로 내려간다", () => {
    const player = {
      attributes: { stamina: 60 },
      state: { condition: 100 },
    } as unknown as Parameters<typeof conditionDrain>[0];
    const condition = 100 - conditionDrain(player, "RCM", DEFAULT_TACTICS, 60);
    expect(condition).toBeLessThanOrEqual(60);
  });

  it("지구력 60 중앙 미드필더는 풀타임 뒤 만 7일에 체력 95 이상으로 돌아온다", () => {
    const player = {
      attributes: { stamina: 60 },
      state: { condition: 100 },
    } as unknown as Parameters<typeof conditionDrain>[0];
    // 평균보다 가장 무거운 날(+12%)까지 포함해도 주 1경기 계약을 지킨다.
    const afterMatch = 100 - conditionDrain(player, "RCM", DEFAULT_TACTICS, 90, 1.12);
    const week = [
      "recovery",
      "idle",
      "training",
      "training",
      "training",
      "training",
      "idle",
    ] as const;
    const afterWeek = week.reduce(
      (condition, kind) => Math.min(100, condition + dailyRecovery(player, kind)),
      afterMatch,
    );

    expect(afterWeek).toBeGreaterThanOrEqual(95);
  });

  /**
   * **가장 잘 뛰는 선수도 사흘로는 못 채운다** — 주 2경기 리듬이 로테이션을
   * 강요한다는 계약의 상한선이다. 여기가 뚫리면 "지구력 좋은 열한 명을 그냥 계속
   * 세운다"가 정답이 되어 로테이션이라는 결정이 사라진다.
   */
  it("지구력 90 중앙 미드필더도 사흘로는 완전히 회복하지 못한다", () => {
    const player = {
      attributes: { stamina: 90 },
      state: { condition: 100 },
    } as unknown as Parameters<typeof conditionDrain>[0];
    const afterMatch = 100 - conditionDrain(player, "RCM", DEFAULT_TACTICS, 90, 1.12);
    const afterThreeDays = (["recovery", "idle", "training"] as const).reduce(
      (condition, kind) => Math.min(100, condition + dailyRecovery(player, kind)),
      afterMatch,
    );

    // 바닥에서 0으로 직선 낙하하지도 않는다 — 감쇠 곡선의 몫
    expect(afterMatch).toBeGreaterThanOrEqual(30);
    expect(afterMatch).toBeLessThanOrEqual(36);
    // 사흘이면 다시 뛸 만하지만 **만땅은 아니다**
    expect(afterThreeDays).toBeGreaterThanOrEqual(74);
    expect(afterThreeDays).toBeLessThan(85);
  });

  it("회복 집중 주간은 지구력 50 중앙 미드필더를 7일 안에 완전히 회복시킨다", () => {
    const player = {
      attributes: { stamina: 50 },
      state: { condition: 100 },
    } as unknown as Parameters<typeof conditionDrain>[0];
    const afterMatch = 100 - conditionDrain(player, "RCM", DEFAULT_TACTICS, 90, 1.12);
    const afterWeek = Array.from({ length: 7 }).reduce<number>(
      (condition) => Math.min(100, condition + dailyRecovery(player, "recovery")),
      afterMatch,
    );

    expect(afterWeek).toBe(100);
  });

  it("사흘로는 다 못 채운다 — 3일 뒤 경기에 로테이션이 필요해진다", () => {
    const state = createNeutralGame();
    // 연전의 대가를 재는 시험이라 개막 이후를 본다 — 프리시즌은 주 1회다
    playPreseason(state);
    advanceToMatchday(state);
    /**
     * **배치의 선발이 그대로 뛴다는 보장은 없다** — 정지·부상은 킥오프에 자동
     * 대체된다. 그래서 스쿼드 전원을 만땅으로 세우고, 뒤에서 **실제로 그라운드를
     * 밟은** 선발만 잰다. 안 뛴 선수를 세면 100이 그대로 남아 시험이 뒤집힌다.
     */
    const starters = startersOf(state).filter((s) => s.position !== "GK");
    for (const p of userPlayers(state)) p.state.condition = 100;

    playMockMatch(state);
    // **방금 치른 경기**를 집는다 — 앞선 친선들도 결과를 갖고 있어 배열 순서로는 안 된다
    const match = state.matches
      .filter(
        (m) => m.result && (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
      )
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .at(-1);
    const lineup = new Set([
      ...(match?.result?.homeLineup ?? []),
      ...(match?.result?.awayLineup ?? []),
    ]);
    advanceDays(state, 3);

    const after = starters
      .filter((s) => lineup.has(s.id))
      .map((s) => ({
        slot: weightSlotOf(s.position),
        condition: playerById(state, s.id)!.state.condition,
      }));
    expect(after.length, "실제로 뛴 선발").toBeGreaterThanOrEqual(9);
    const conditions = after.map((a) => a.condition);
    // 아무도 만땅으로 돌아오지 못한다 — 그대로 열한 명을 다시 세우면 대가가 있다
    expect(Math.max(...conditions)).toBeLessThan(90);
    // 그렇다고 못 뛸 몸은 아니다. 감독이 고를 수 있는 구간이어야 판단이 생긴다
    expect(Math.min(...conditions)).toBeGreaterThan(65);

    /**
     * **연전을 누가 견디는지가 자리마다 갈려야** 로테이션이 판단이 된다. 많이 뛰는
     * 자리(풀백·중원·윙어)와 덜 뛰는 자리(센터백·최전방)의 사흘 뒤가 붙어 있으면
     * 감독은 그냥 어제와 같은 열한 명을 적는다.
     */
    const meanOf = (slots: string[]) => {
      const group = after.filter((a) => slots.includes(a.slot)).map((a) => a.condition);
      expect(group.length).toBeGreaterThan(0);
      return group.reduce((a, b) => a + b, 0) / group.length;
    };
    expect(meanOf(["CB", "ST", "CF"]) - meanOf(["FB", "DM", "CM", "W"])).toBeGreaterThan(5);
  });

  /**
   * ⚠️ **회복은 소모보다 훨씬 덜 갈라야 한다.** 한 축이 소모와 회복 양쪽에 곱으로
   * 걸리면 격차가 복리로 벌어져 지구력 하나가 나머지 열네 축을 덮는다. 회복은
   * 소모가 만든 차이를 거들 뿐이라는 것을 여기서 고정한다.
   */
  it("회복 편차는 소모 편차보다 작다 — 지구력이 복리로 벌어지지 않는다", () => {
    const of = (stamina: number) =>
      ({ attributes: { stamina }, state: {} }) as unknown as Parameters<typeof recoveryFactor>[0];
    const slow = recoveryFactor(of(30));
    const fast = recoveryFactor(of(99));
    expect(fast).toBeGreaterThan(slow); // 그래도 갈리기는 한다
    expect(fast / slow).toBeLessThan(1.25); // 소모 쪽(≈1.7배)의 절반 아래
  });

  it("지구력이 회복 속도도 가른다 — 같은 자리라도 사흘 뒤가 다르다", () => {
    const state = createNeutralGame();
    advanceToMatchday(state);
    // **같은 자리끼리** 견준다 — 자리가 다르면 소모 배율이 섞여 지구력의 몫이 흐려진다
    const starters = startersOf(state).filter((s) => s.position !== "GK");
    const pair = starters.filter(
      (s) => weightSlotOf(s.position) === weightSlotOf(starters[0]!.position),
    );
    expect(pair.length).toBeGreaterThanOrEqual(2);
    const iron = playerById(state, pair[0]!.id)!;
    const glass = playerById(state, pair[1]!.id)!;
    iron.attributes.stamina = 95;
    glass.attributes.stamina = 45;
    iron.state.condition = 100;
    glass.state.condition = 100;

    playMockMatch(state);
    advanceDays(state, 3);

    expect(iron.state.condition).toBeGreaterThan(glass.state.condition + 8);
  });

  it("일주일이면 온전히 돌아온다 — 주 1경기 리듬은 로테이션을 강요하지 않는다", () => {
    const state = createNeutralGame();
    advanceToMatchday(state);
    const starters = startersOf(state).filter((s) => s.position !== "GK");
    for (const s of starters) playerById(state, s.id)!.state.condition = 100;

    playMockMatch(state);
    advanceDays(state, 6);

    const after = starters.map((s) => playerById(state, s.id)!.state.condition);
    // 만 7일 리듬에서는 **전원이 만땅**이다 — 여기가 무너지면 시즌 내내 계단으로 내려간다
    expect(Math.min(...after)).toBeGreaterThan(98);
  });

  it("쉬는 날이 훈련일보다 많이 회복하고, 회복 세션이 가장 크다", () => {
    expect(RECOVERY_BASE.recovery).toBeGreaterThan(RECOVERY_BASE.idle);
    expect(RECOVERY_BASE.idle).toBeGreaterThan(RECOVERY_BASE.training);
  });
});

/**
 * **후반에 무너지는 것은 전원이 아니라 일부다.**
 *
 * 여기가 이 밸런스의 목적이다. 만땅으로 시작한 선수가 90분에 구멍이 나면 감독은
 * 아무것도 판단할 수 없다 — 누굴 세워도 후반에 라인이 열리니까. 구멍은 **지구력이
 * 낮은 선수**와 **덜 회복된 채 나온 선수**에게만 와야 하고, 그때 감독의 선택
 * (쉬게 할까 · 미리 바꿀까)이 결과를 가른다.
 */
describe("경기 체력 — 후반에 무너지는 사람", () => {
  const of = (stamina: number, condition: number) =>
    ({ attributes: { stamina }, state: { condition } }) as unknown as Parameters<
      typeof conditionDrain
    >[0];
  const conditionAt = (
    player: Parameters<typeof conditionDrain>[0],
    position: string,
    minutes: number,
  ) =>
    player.state.condition -
    conditionDrain(player, position, DEFAULT_TACTICS, minutes, 1, 1, 0.5, player.state.condition);
  /** 구멍이 나는 시각 — 90분 내내 버티면 null */
  const gapMinute = (player: Parameters<typeof conditionDrain>[0], position: string) => {
    for (let minute = 1; minute <= 90; minute++) {
      if (conditionAt(player, position, minute) < GAP_CONDITION) return minute;
    }
    return null;
  };

  it("온전한 몸으로 시작하면 자리·지구력을 통틀어 90분을 버틴다", () => {
    for (const position of ["RCM", "RB", "RW", "ST", "RCB"]) {
      for (const stamina of [50, 70, 90]) {
        expect(gapMinute(of(stamina, 100), position), `${position} 지구력 ${stamina}`).toBeNull();
      }
    }
    // 지구력이 좋으면 여유까지 남는다 — 문턱에 겨우 걸치는 게 아니다
    expect(conditionAt(of(90, 100), "RCM", 90)).toBeGreaterThan(GAP_CONDITION + 10);
  });

  it("덜 회복된 채 나오면 후반에 구멍이 난다 — 사흘 만에 다시 세운 다리", () => {
    // 사흘 뒤 중원의 실제 체력대(73 근처)와 그보다 못한 몸
    const late = gapMinute(of(70, 73), "RCM");
    expect(late).not.toBeNull();
    expect(late!).toBeGreaterThan(45); // 전반이 아니라 후반이다
    const worse = gapMinute(of(60, 70), "RCM");
    expect(worse).not.toBeNull();
    expect(worse!).toBeGreaterThan(45);
    // 더 못한 몸이 더 먼저 무너진다
    expect(worse!).toBeLessThan(late!);
  });

  it("덜 회복돼도 덜 뛰는 자리는 버틴다 — 자리마다 감독의 선택이 다르다", () => {
    expect(gapMinute(of(70, 73), "RCB")).toBeNull();
    expect(gapMinute(of(70, 73), "GK")).toBeNull();
  });
});

// ─── 존 매치업 기준선 (zone-baseline.test.ts에서 옮겨 왔다) ───
/**
 * **매치업 비율의 기준선은 1이다** (docs/simulation/match.md §1.1).
 *
 * 판세 3×3은 감독이 무엇을 손볼지 고르는 화면이다. 그 화면이 상대와 무관하게 늘
 * 같은 두 문장을 말하면 신호가 0이다 — 실제로 그랬다: 시드 42의 첫 시즌 편성
 * 400경기에서 공격 존 매치업이 342:7, 수비 존이 7:349였다(평균 비율 1.173 · 0.861).
 *
 * 존 가중치(`ZONE_CONTRIBUTION`)가 기울어서가 아니었다 — 전술과 공략을 모두 끄고
 * 같은 400경기를 재면 세 존이 1.001·1.002·1.001로 이미 같은 눈금에 선다. 기울기는
 * 존 위에 얹히는 두 층에서 왔고, 그 둘이 **구조적으로 공격 쪽으로만 실린다.**
 *
 * 그래서 여기서 지키는 것은 존 하나의 값이 아니라 **리그가 실제로 서 있는 자리의
 * 기준선**이다. 팀 단위의 이탈은 신호다: 수비가 공격보다 좋은 스쿼드는 공격 존이
 * 낮게 나와야 맞다. 쏠리면 안 되는 것은 리그 전체다.
 */

/** 편성에서 앞쪽 N경기의 매치업 판정을 센다 — 전술·공략이 모두 살아 있는 실제 조건 */
function tallyFixtures(state: GameState, count: number) {
  const squads = new Map<string, ReturnType<typeof simSquadOf>>();
  const sideOf = (teamId: string) => {
    let squad = squads.get(teamId);
    if (!squad) {
      squad = simSquadOf(state, teamId);
      squads.set(teamId, squad);
    }
    return {
      teamId,
      teamName: teamId,
      starters: squad.slots ?? [],
      bench: [],
      tactics: squad.tactics!,
      managerTactics: squad.managerTactics ?? 65,
    };
  };
  const tally = {
    attack: { home: 0, away: 0, even: 0, ratio: 0 },
    midfield: { home: 0, away: 0, even: 0, ratio: 0 },
    defense: { home: 0, away: 0, even: 0, ratio: 0 },
  };
  const fixtures = state.matches
    .filter((m) => m.season === state.season && !m.result)
    .slice(0, count);
  for (const match of fixtures) {
    const packet = buildStrengthPacket(sideOf(match.homeTeamId), sideOf(match.awayTeamId));
    const ratio = {
      attack: packet.home.zones.attack / packet.away.zones.defense,
      midfield: packet.home.zones.midfield / packet.away.zones.midfield,
      defense: packet.home.zones.defense / packet.away.zones.attack,
    };
    for (const m of packet.matchups) {
      tally[m.zone][m.edge] += 1;
      tally[m.zone].ratio += ratio[m.zone];
    }
  }
  for (const zone of ["attack", "midfield", "defense"] as const) {
    tally[zone].ratio /= Math.max(1, fixtures.length);
  }
  return { tally, played: fixtures.length };
}

describe("존 눈금의 리그 기준선", () => {
  // 세계는 한 번만 짓는다 — `createTestGame`은 호출당 1초다 (AGENTS.md §5 테스트)
  const state = createTestGame(42);
  const { tally, played } = tallyFixtures(state, 200);

  it("편성의 매치업 비율이 세 존 모두 1 언저리다", () => {
    expect(played).toBe(200);
    for (const zone of ["attack", "midfield", "defense"] as const) {
      expect(tally[zone].ratio, `${zone} 존의 기준선이 1에서 벗어났다`).toBeGreaterThan(0.97);
      expect(tally[zone].ratio, `${zone} 존의 기준선이 1에서 벗어났다`).toBeLessThan(1.03);
    }
  });

  it("판정이 한쪽으로 쏠리지 않는다 — 공격 존이 늘 이기던 자리다", () => {
    for (const zone of ["attack", "midfield", "defense"] as const) {
      const { home, away } = tally[zone];
      const lean = Math.max(home, away) / Math.max(1, Math.min(home, away));
      // 예전엔 공격 존이 342:7(48.9배) · 수비 존이 7:349였다
      expect(lean, `${zone} 존 판정이 ${home}:${away}로 쏠렸다`).toBeLessThan(2);
    }
  });

  /**
   * **프리셋 여섯 축의 리그 평균은 3에 서야 한다.**
   *
   * 3이 중립이고 전술 델타는 3에서의 편차로 계산되므로, 프리셋이 한쪽으로 쏠리면
   * 리그 전체가 같은 방향의 이득과 대가를 달고 선다. 예전 프리셋은 여섯 축이 전부
   * 3 이상이라(멘탈리티 3.30 · 압박 3.47 · 라인 3.30 · 템포 3.34 · 폭 3.78 ·
   * 패스 3.12) 리그 평균이 공격 +2.4 / 수비 −2.3으로 섰다.
   */
  it("전술 프리셋 여섯 축의 리그 평균이 3 근처다", () => {
    const axes = ["mentality", "defensiveLine", "pressing", "tempo", "width", "passStyle"] as const;
    // 무소속은 클럽이 아니라 전술을 갖지 않는다 (team.md §4)
    const specs = state.teams
      .filter((team) => isClubTeam(team.id))
      .map((team) => tacticsOf(state, team.id).spec);
    expect(specs.length).toBeGreaterThan(100);
    for (const axis of axes) {
      const mean = specs.reduce((sum, spec) => sum + spec[axis], 0) / specs.length;
      expect(mean, `${axis}의 리그 평균이 ${mean.toFixed(2)}다`).toBeGreaterThan(2.8);
      expect(mean, `${axis}의 리그 평균이 ${mean.toFixed(2)}다`).toBeLessThan(3.2);
    }
  });
});
