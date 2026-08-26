import { describe, expect, it } from "vitest";
import type { GamePlayer } from "@story-fm/domain";
import {
  leagueOfTeamIn,
  FAMILIARITY_DRIFT_CAP,
  FAMILIARITY_DRIFT_PER_DAY,
  advanceTime,
  assignmentFor,
  driftFamiliarity,
  playersOf,
  proficiencyAt,
  simSquadOf,
  tickOtherClubs,
  type GameState,
} from "@story-fm/engine";
import { applyFamiliarityGain } from "@story-fm/domain";
import { dailyRecovery } from "@story-fm/sim";
import { createTestGame, playMockMatch } from "./helpers";

/**
 * 타 팀의 체력 관리 — **리그가 같은 규칙으로 돈다.**
 *
 * 예전엔 하루 회복이 우리 팀에만 있었다(`dailyTick`이 `userPlayers`만 돌았다).
 * 남의 팀 선수는 경기로 깎이기만 하고 되찾는 일이 없어 시즌 내내 단조 감소했고,
 * 시즌 중반에 재 보면 우리 선발은 늘 100인데 상대 상위 14명은 평균 77 · 최저 30이었다.
 * 감독 화면의 "상대는 늘 지쳐 있다"가 거기서 나왔다.
 */

describe("타 팀도 매일 회복한다", () => {
  it("간이 시뮬 팀도 경기 당일에는 훈련일이 아닌 휴식 회복을 받는다", () => {
    const state = createTestGame(7);
    const match = state.matches.find(
      (m) => m.homeTeamId !== state.userTeamId && m.awayTeamId !== state.userTeamId,
    )!;
    state.date = match.date;
    const player = playersOf(state, match.homeTeamId)[0]!;
    player.state.condition = 50;

    tickOtherClubs(state);

    expect(player.state.condition).toBe(Math.round(50 + dailyRecovery(player, "idle")));
  });

  it("경기 다음 날부터 체력이 오른다 — 깎이기만 하지 않는다", () => {
    const state = createTestGame(7);
    // 첫 라운드를 치른 팀 하나를 잡는다 (우리 팀 제외)
    let guard = 40;
    let worn: { id: string; after: number } | null = null;
    while (guard-- > 0 && !worn) {
      // 개막까지는 6주가 비어 있다 — 경기일로 건너뛴다
      advanceTime(state, "next_match");
      if (state.phase === "matchday") playMockMatch(state);
      const played = state.matches.find(
        (m) =>
          m.result &&
          m.date === state.date &&
          m.homeTeamId !== state.userTeamId &&
          m.awayTeamId !== state.userTeamId,
      );
      if (!played) continue;
      const p = playersOf(state, played.homeTeamId).find((x) => x.state.condition < 90);
      if (p) worn = { id: p.id, after: p.state.condition };
    }
    expect(worn, "경기로 지친 타 팀 선수").toBeTruthy();
    advanceTime(state, { days: 2 });
    const now = state.players.find((p) => p.id === worn!.id)!.state.condition;
    expect(now, "이틀이 지나도 회복이 없다").toBeGreaterThan(worn!.after);
  });
});

describe("타 팀은 로테이션으로 다리를 안배한다", () => {
  it("지친 선발은 신선한 자원에게 자리를 내준다", () => {
    const state = createTestGame(7);
    // 스쿼드에 지친 선수를 심고 그 자리가 바뀌는지 본다 — 로테이션은 그 순간의
    // 체력만 읽으므로(`simSquadOf`) 시즌을 굴려 피로를 쌓을 필요가 없다
    const xi = simSquadOf(state, "mancity", leagueOfTeamIn(state, "mancity")).starters;
    const victim = xi.find((p) => p.attributes.overall < 88) ?? xi[5]!;
    victim.state.condition = 40;
    const after = simSquadOf(state, "mancity", leagueOfTeamIn(state, "mancity")).starters.map(
      (p) => p.id,
    );
    expect(after, `${victim.name}이 지쳤는데도 선발`).not.toContain(victim.id);
  });

  it("다리가 멎으면 대체 자원의 기량과 무관하게 뺀다", () => {
    const state = createTestGame(7);
    const xi = simSquadOf(state, "mancity", leagueOfTeamIn(state, "mancity")).starters;
    // 팀에서 가장 뛰어난 선수 — 8점 안쪽의 대체 자원이 없을 만한 자리
    const star = [...xi].sort((a, b) => b.attributes.overall - a.attributes.overall)[0]!;
    star.state.condition = 20;
    const after = simSquadOf(state, "mancity", leagueOfTeamIn(state, "mancity")).starters.map(
      (p) => p.id,
    );
    expect(after, `체력 20인 ${star.name}이 선발`).not.toContain(star.id);
  });

  it("멀쩡한 선수는 그대로 선다 — 로테이션이 라인업을 흔들지 않는다", () => {
    const state = createTestGame(7);
    const before = simSquadOf(state, "mancity", leagueOfTeamIn(state, "mancity")).starters.map(
      (p) => p.id,
    );
    const after = simSquadOf(state, "mancity", leagueOfTeamIn(state, "mancity")).starters.map(
      (p) => p.id,
    );
    expect(after).toEqual(before);
  });
});

/**
 * 로테이션의 대가는 **출전 시간까지** 이어져야 대가다 (match.md §7).
 *
 * 벤치가 OVR 순이라 방금 지쳐서 뺀 에이스가 맨 위에 서면, 투입 후보를 포지션군과
 * OVR로만 고르는 `planSubs`가 그를 46분에 되돌린다.
 */
describe("로테이션으로 뺀 선수는 그 경기에서 빠진다", () => {
  // 로테이션이 한 번 일어난 상태를 세 케이스가 나눠 쓴다 (`createTestGame`이 비싸다)
  let fixture: {
    state: GameState;
    before: ReturnType<typeof simSquadOf>;
    after: ReturnType<typeof simSquadOf>;
    victim: GamePlayer;
    index: number;
  } | null = null;

  const rotated = () => {
    if (!fixture) {
      const state = createTestGame(7);
      const before = simSquadOf(state, "mancity", leagueOfTeamIn(state, "mancity"));
      const victim = before.starters.find((p) => p.attributes.overall < 88) ?? before.starters[5]!;
      victim.state.condition = 40;
      fixture = {
        state,
        before,
        after: simSquadOf(state, "mancity", leagueOfTeamIn(state, "mancity")),
        victim,
        index: before.starters.findIndex((p) => p.id === victim.id),
      };
    }
    return fixture;
  };

  it("벤치에도 없다 — OVR 순 벤치의 맨 위로 돌아오지 않는다", () => {
    const { after, victim } = rotated();
    expect(
      after.starters.map((p) => p.id),
      `${victim.name}이 지쳤는데도 선발`,
    ).not.toContain(victim.id);
    expect(
      (after.bench ?? []).map((p) => p.id),
      `${victim.name}이 벤치 1순위로 돌아왔다 — 46분에 다시 들어온다`,
    ).not.toContain(victim.id);
  });

  it("자리는 그대로 두고 들어온 선수의 숙련도로 그 슬롯이 선다", () => {
    const { before, after, victim, index } = rotated();
    const was = before.slots![index]!;
    const now = after.slots![index]!;
    expect(now.player.id, "그 자리의 주인이 바뀌지 않았다").not.toBe(victim.id);
    expect(now.position, "전술판의 자리는 사람이 바뀌어도 그대로다").toBe(was.position);
    // 물려받으면 그라운드에 없는 사람의 숫자로 패킷이 선다
    expect(now.proficiency).toBe(proficiencyAt(now.player, now.position));
  });

  it("적응도도 들어온 선수 자신의 것이다", () => {
    const { state, after, index } = rotated();
    const incoming = after.slots![index]!.player;
    const assignment = assignmentFor(state, incoming.id);
    expect(assignment, `${incoming.name}에게 전술 배치가 없다`).not.toBeNull();
    assignment!.familiarity = 42;
    const again = simSquadOf(state, "mancity", leagueOfTeamIn(state, "mancity"));
    expect(again.slots![index]!.player.id).toBe(incoming.id);
    expect(again.slots![index]!.familiarity).toBe(42);
  });
});

/**
 * 남의 팀 전술 적응도 — **체력과 같은 이유로 여기 있다.** 이게 없으면 AI 팀은
 * 영원히 기준선(60)에 멈추고 감독 팀만 결산 판정으로 올라, 시즌이 갈수록 전력
 * 우위가 벌어진다. 다만 붙는 자리는 감독이 닿는 곳보다 낮아야 한다 —
 * 전술을 파고든 감독이 남의 팀보다 나은 자리가 남아야 하기 때문이다.
 */
describe("타 팀의 전술 적응도는 천장까지만 붙는다", () => {
  const tacticsOfTeam = (state: GameState, teamId: string) =>
    state.tactics.find((t) => t.teamId === teamId)!;

  it("하루치가 곡선대로 붙고, 감독 팀은 이 손으로 움직이지 않는다", () => {
    const state = createTestGame(7);
    const theirs = tacticsOfTeam(state, "mancity").assignments[0]!;
    const ours = tacticsOfTeam(state, state.userTeamId).assignments[0]!;
    theirs.familiarity = 60;
    ours.familiarity = 60;

    driftFamiliarity(state);

    // 하루치는 곡선을 그대로 통과한다 — 눈금을 여기서 따로 계산하지 않는다
    expect(theirs.familiarity).toBe(
      applyFamiliarityGain(60, FAMILIARITY_DRIFT_PER_DAY, "training"),
    );
    expect(theirs.familiarity).toBeGreaterThan(60);
    // 감독 팀의 적응도는 훈련·경기 결산 판정만이 움직인다 (training-report의 계약)
    expect(ours.familiarity, "감독 팀이 공짜로 붙었다").toBe(60);
  });

  it("천장 80에서 멎고, 이미 그 위에 있는 값은 깎지 않는다", () => {
    const state = createTestGame(7);
    const [near, over] = tacticsOfTeam(state, "mancity").assignments;
    near!.familiarity = FAMILIARITY_DRIFT_CAP - 0.2;
    // 감독이 경질돼 팀이 바뀌면 결산으로 95까지 올린 배치가 그대로 AI 팀의 것이 된다
    over!.familiarity = 95;

    for (let day = 0; day < 60; day++) {
      driftFamiliarity(state);
      expect(near!.familiarity, `${day}일차`).toBeLessThanOrEqual(FAMILIARITY_DRIFT_CAP);
    }
    expect(near!.familiarity).toBe(FAMILIARITY_DRIFT_CAP);
    expect(over!.familiarity, "천장 위의 값이 천장으로 끌려 내려왔다").toBe(95);
    // 감독이 결산으로 닿는 95·100보다 낮다 — 파고든 감독의 자리가 남는다
    expect(FAMILIARITY_DRIFT_CAP).toBeLessThan(95);
  });
});
