import { describe, expect, it } from "vitest";
import { naturalPositionOf } from "@story-fm/domain";
import {
  applyNarrativeEvent,
  applyTalkToPlayer,
  applyTeamTalk,
  assignmentsOf,
  grantManagerXP,
  isInjured,
  setCaptain,
  setLineup,
  setPlayerInstruction,
  setPlayerPosition,
  setTactics,
  setTraining,
  userPlayers,
  userTactics,
  groupOf,
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
    const before = userPlayers(state).map((p) => p.state.morale);
    const result = applyTeamTalk(state, { occasion: "pre", outcome: "inspired", intensity: 3 });
    expect(result.ok).toBe(true);
    const after = userPlayers(state).map((p) => p.state.morale);
    for (let i = 0; i < before.length; i++) {
      expect(after[i]).toBeGreaterThan(before[i] ?? 0);
    }
  });

  it("리더십이 높을수록 같은 팀토크가 더 크게 울린다 (결정 #13)", () => {
    const low = createTestGame();
    low.manager.attributes.leadership = 40;
    const high = createTestGame();
    high.manager.attributes.leadership = 90;
    const target = userPlayers(low)[0]!;
    const targetHigh = userPlayers(high)[0]!;
    const m0 = target.state.morale;
    applyTeamTalk(low, { occasion: "pre", outcome: "inspired", intensity: 2 });
    applyTeamTalk(high, { occasion: "pre", outcome: "inspired", intensity: 2 });
    expect(targetHigh.state.morale - m0).toBeGreaterThanOrEqual(target.state.morale - m0);
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
    expect(result.message).toContain("불만 해소");
    expect(state.issues).toHaveLength(0);
  });

  it("잘못된 선수 면담은 반려된다", () => {
    const state = createTestGame();
    expect(applyTalkToPlayer(state, { playerId: "ghost", outcome: "neutral", intensity: 1 }).ok).toBe(
      false,
    );
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
    expect(leveled).toContain("리더십");
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

    // 복귀 처리하면 통과
    state.injuries[0]!.returnedOn = state.date;
    expect(setLineup(state, { starting: lineup }).ok).toBe(true);
  });

  it("배치가 role·포지션을 갱신하고 적응도는 이어받는다", () => {
    const state = createTestGame();
    const tactics = userTactics(state);
    const first = tactics.assignments.find((a) => a.role === "starting")!;
    first.familiarity = 77; // 학습된 상태
    const lineup = currentLineup(state);
    const bench = userPlayers(state)
      .filter((p) => !lineup.some((s) => s.playerId === p.id))
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

  it("배치 없는 선수는 예비(스쿼드) — 팀에 라인업 배열이 없다", () => {
    const state = createTestGame();
    const assigned = new Set(assignmentsOf(state, state.userTeamId).map((a) => a.playerId));
    const reserves = userPlayers(state).filter((p) => !assigned.has(p.id));
    expect(reserves.length).toBeGreaterThan(0);
    // 팀 엔티티에는 startingXI/bench가 없다 (v6)
    const team = state.teams.find((t) => t.id === state.userTeamId)!;
    expect("startingXI" in team).toBe(false);
    expect("bench" in team).toBe(false);
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
    // FW 공식으로 재산정
    expect(df.attributes.overall).toBe(
      Math.round((df.attributes.shooting + df.attributes.pace + df.attributes.dribbling) / 3),
    );
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

  it("모든 선수가 goalkeeping 능력치를 갖는다 — GK 전환 시 예외 처리 불필요", () => {
    const state = createTestGame();
    for (const p of userPlayers(state)) {
      expect(typeof p.attributes.goalkeeping).toBe("number");
    }
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
    expect(userTactics(state).spec.formation).toBe("4-4-2");
    expect(setTactics(state, { mentality: 9 as never }).ok).toBe(false);
  });

  it("전술을 바꾸면 배치 적응도가 변경 폭만큼 떨어진다", () => {
    const state = createTestGame();
    const before = assignmentsOf(state, state.userTeamId, "starting")[0]!.familiarity;
    setTactics(state, { formation: "5-4-1" }); // 포메이션 교체 = 큰 하락
    expect(assignmentsOf(state, state.userTeamId, "starting")[0]!.familiarity).toBeLessThan(before);
  });

  it("작은 변경은 적게, 포메이션 교체는 크게 떨어진다", () => {
    const a = createTestGame();
    const b = createTestGame();
    const base = assignmentsOf(a, a.userTeamId, "starting")[0]!.familiarity;
    setTactics(a, { mentality: 4 });
    setTactics(b, { formation: "3-5-2" });
    const dropA = base - assignmentsOf(a, a.userTeamId, "starting")[0]!.familiarity;
    const dropB = base - assignmentsOf(b, b.userTeamId, "starting")[0]!.familiarity;
    expect(dropB).toBeGreaterThan(dropA);
  });

  it("포메이션을 바꾸면 선발 슬롯 포지션도 새 포메이션에 맞춰진다", () => {
    const state = createTestGame();
    setTactics(state, { formation: "3-5-2" });
    const positions = assignmentsOf(state, state.userTeamId, "starting").map((a) => a.position);
    expect(positions).toContain("GK");
    expect(positions.filter((p) => p === "ST")).toHaveLength(2); // 3-5-2는 투톱
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
    const res = setTraining(state, {
      sessions: [
        { date: "2026-07-06", slot: "am", label: "세트피스 반복", focus: ["passing", "shooting"] },
      ],
    });
    expect(res.ok).toBe(true);
    const entry = state.schedule.find((e) => e.type === "training" && e.date === "2026-07-06");
    expect(entry).toBeTruthy();
    expect(entry?.time).toBe("10:00"); // am
    const session = state.trainingSessions.find((s) => s.id === entry?.refId);
    expect(session?.label).toBe("세트피스 반복");
    expect(session?.focus).toContain("passing");
  });

  it("요일 반복은 지정 주 수만큼 엔트리로 펼쳐진다", () => {
    const state = createTestGame();
    const res = setTraining(state, {
      repeatWeekly: [{ dow: 1, slot: "pm", label: "체력 훈련", focus: ["physical"] }],
      weeks: 4,
    });
    expect(res.ok).toBe(true);
    const entries = state.schedule.filter((e) => e.type === "training");
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
        sessions: [
          { date: "2026-07-06", slot: "am", label: "x", focus: ["nonsense" as never] },
        ],
      }).ok,
    ).toBe(false);
  });

  it("clear로 예정 훈련을 비운다 (지난 훈련은 이력으로 남는다)", () => {
    const state = createTestGame();
    setTraining(state, {
      repeatWeekly: [{ dow: 3, slot: "am", label: "패스", focus: ["passing"] }],
      weeks: 3,
    });
    expect(state.schedule.filter((e) => e.type === "training")).toHaveLength(3);
    const res = setTraining(state, { clear: true });
    expect(res.ok).toBe(true);
    expect(state.schedule.filter((e) => e.type === "training")).toHaveLength(0);
    expect(state.trainingSessions).toHaveLength(0);
  });

  it("같은 날 같은 슬롯을 다시 지정하면 덮어쓴다", () => {
    const state = createTestGame();
    setTraining(state, {
      sessions: [{ date: "2026-07-08", slot: "am", label: "첫 지시", focus: ["passing"] }],
    });
    setTraining(state, {
      sessions: [{ date: "2026-07-08", slot: "am", label: "바뀐 지시", focus: ["shooting"] }],
    });
    const entries = state.schedule.filter((e) => e.type === "training" && e.date === "2026-07-08");
    expect(entries).toHaveLength(1);
    expect(state.trainingSessions.find((s) => s.id === entries[0]?.refId)?.label).toBe("바뀐 지시");
  });
});

describe("서사 이벤트 — 사기·폼만, 한도 내 (overview §7)", () => {
  it("한도를 넘는 값은 잘린다", () => {
    const state = createTestGame();
    const player = userPlayers(state)[0]!;
    const m0 = player.state.morale;
    const result = applyNarrativeEvent(state, {
      playerIds: [player.id],
      moraleDelta: 50,
      note: "테스트",
    });
    expect(result.ok).toBe(true);
    expect(player.state.morale - m0).toBeLessThanOrEqual(5);
  });
});
