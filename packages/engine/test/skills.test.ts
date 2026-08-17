import { describe, expect, it } from "vitest";
import {
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
  applyNarrativeEvent,
  applyTalkToPlayer,
  applyTeamTalk,
  assignmentsOf,
  buildOfficeViews,
  grantManagerXP,
  isAvailable,
  isInjured,
  playerById,
  setCaptain,
  setLineup,
  setPlayerInstruction,
  setPlayerPosition,
  setPlayerRole,
  setPlayerTactic,
  setSquadLevel,
  setTactics,
  settleTactics,
  squadFamiliarity,
  rememberTactics,
  setTraining,
  userPlayers,
  userTactics,
  groupOf,
  type GameState,
  squadReturnOf,
  addDays,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

/** 현재 배치를 setLineup 입력 형태로 (검증 테스트의 기준 라인업) */
function currentLineup(state: ReturnType<typeof createTestGame>) {
  return assignmentsOf(state, state.userTeamId, "starting").map((a) => ({
    playerId: a.playerId,
    position: a.position,
  }));
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

  it("면담은 불만 이슈를 해소한다", () => {
    const state = createTestGame();
    const player = userPlayers(state)[5]!;
    state.issues.push({
      gamePlayerId: player.id,
      kind: "unhappy",
      note: "출전 불만",
      since: state.date,
    });
    const result = applyTalkToPlayer(state, {
      playerId: player.id,
      outcome: "reassured",
      intensity: 2,
    });
    expect(result.ok).toBe(true);
    expect(state.issues).toHaveLength(0);
  });

  it("잘못된 선수 면담은 반려된다", () => {
    const state = createTestGame();
    expect(
      applyTalkToPlayer(state, { playerId: "ghost", outcome: "neutral", intensity: 1 }).ok,
    ).toBe(false);
  });
});

describe("감독 성장 — XP 100당 +1, 상한 90", () => {
  it("XP 임계 도달 시 능력치가 오른다", () => {
    const state = createTestGame();
    const before = state.manager.attributes.leadership;
    let leveled: string | null = null;
    for (let i = 0; i < 13 && !leveled; i++) {
      leveled = grantManagerXP(state, "leadership", 8);
    }
    expect(state.manager.attributes.leadership).toBe(before + 1);
  });

  it("상한 90에서는 더 오르지 않는다", () => {
    const state = createTestGame();
    state.manager.attributes.tactics = 90;
    expect(grantManagerXP(state, "tactics", 500)).toBeNull();
    expect(state.manager.attributes.tactics).toBe(90);
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
      (p) => !starters.some((a) => a.playerId === p.id) && isAvailable(state, p.id),
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

describe("포지션 스킬 (멀티 포지션)", () => {
  it("주 포지션을 옮기면 isNatural이 이동하고 OVR이 재산정된다", () => {
    const state = createTestGame();
    const df = userPlayers(state).find((p) => groupOf(p) === "DF")!;
    expect(setPlayerPosition(state, { playerId: df.id, position: "XX" }).ok).toBe(false);

    const ok = setPlayerPosition(state, { playerId: df.id, position: "ST" });
    expect(ok.ok).toBe(true);
    expect(naturalPositionOf(df).position).toBe("ST");
    expect(df.positions.filter((p) => p.isNatural)).toHaveLength(1);
    expect(groupOf(df)).toBe("FW");
    // ST 자리 가중치로 재산정 (15축 가중합 — player.md §2)
    expect(df.attributes.overall).toBe(roleFit(df.attributes, "ST"));
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
  it("주장은 팀당 1명 — 새로 지명하면 이전 주장은 해제된다", () => {
    const state = createTestGame();
    const before = userPlayers(state).find((p) => p.isCaptain)!;
    const next = userPlayers(state).find((p) => !p.isCaptain)!;
    expect(setCaptain(state, next.id).ok).toBe(true);
    expect(next.isCaptain).toBe(true);
    expect(before.isCaptain).toBe(false);
    expect(userPlayers(state).filter((p) => p.isCaptain)).toHaveLength(1);
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
    const cb = assignmentsOf(state, state.userTeamId, "starting").find(
      (a) => weightSlotOf(a.position) === "CB",
    )!;
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
    const cb = assignmentsOf(state, state.userTeamId, "starting").find(
      (a) => weightSlotOf(a.position) === "CB",
    )!;
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

describe("훈련 스킬 = 일정 생성 (규칙 테이블 없음)", () => {
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

describe("서사 이벤트 — 체력·폼만, 한도 내 (overview §7)", () => {
  it("한도를 넘는 값은 잘린다", () => {
    const state = createTestGame();
    const player = userPlayers(state)[0]!;
    const m0 = player.state.condition;
    const result = applyNarrativeEvent(state, {
      playerIds: [player.id],
      conditionDelta: 50,
      note: "테스트",
    });
    expect(result.ok).toBe(true);
    expect(player.state.condition - m0).toBeLessThanOrEqual(5);
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
        isAvailable(state, p.id) &&
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

    // 예비 — 배치째 사라진다
    expect(setLineup(state, { starting: without(state, cb.playerId) }).ok).toBe(true);
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
        isAvailable(state, p.id) &&
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
