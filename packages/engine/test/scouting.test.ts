import { describe, expect, it } from "vitest";
import {
  advanceTime,
  deferredScouts,
  diffDays,
  knowledgeNote,
  knowledgeOf,
  scoutingSummary,
  observationOf,
  observedOverall,
  observedRating,
  playersOf,
  POTENTIAL_FLOOR,
  settlingOf,
  POTENTIAL_MARGIN,
  POTENTIAL_SCOUT_FLOOR,
  SCOUT_REPEAT_LIMIT,
  potentialBand,
  scoutPlayer,
  scoutedAttributes,
  userPlayers,
  AXIS_OBSERVABILITY,
  OBSERVATION_MARGIN,
  readCondition,
  conditionMargin,
  ANALYSIS_FLOOR,
  SCOUT_ATTRS,
  type GameState,
  playerById,
  buildOfficeViews,
  formatMoney,
  pushReportCards,
  ratingLabel,
  ratingTier,
  scoutReportCard,
  scoutReportLine,
  takeReportCards,
} from "@story-fm/engine";
import { SCOUT_CONCURRENT_LIMIT, SCOUT_DAYS, SCOUT_DEFER_DAYS } from "@story-fm/domain";
import { GAP_CONDITION } from "@story-fm/sim";
import { advanceAndPlay, createTestGame, playMockMatch, settleFully } from "./helpers";

/**
 * 정보 비대칭(안개) — 우리 선수는 정확히, 타 팀은 흐릿하게.
 * 핵심 불변식: (1) 오차는 결정적이다 (2) 코어 수치는 오염되지 않는다.
 */

function anyOpponent(state: GameState) {
  return playersOf(state, "chelsea")[0]!;
}

describe("지식 수준 파생", () => {
  it("우리 선수는 own — 능력치는 정확하지만 잠재력은 구간으로만 안다", () => {
    const state = createTestGame(11);
    const mine = userPlayers(state)[0]!;
    expect(knowledgeOf(state, mine.id)).toBe("own");
    for (const attr of scoutedAttributes(state, mine)) {
      expect(attr.exact).not.toBeNull();
    }
    // 잠재력만은 우리 선수도 단정하지 못한다 — 성장은 예언이 아니다
    const band = potentialBand(state, mine);
    expect(band).not.toBeNull();
    expect(band!.margin).toBeGreaterThanOrEqual(POTENTIAL_FLOOR);
  });

  it("만난 적 없는 타 팀 선수는 rumoured — 숫자를 감추고 잠재력도 미지", () => {
    const state = createTestGame(11);
    const other = anyOpponent(state);
    expect(knowledgeOf(state, other.id)).toBe("rumoured");
    for (const attr of scoutedAttributes(state, other)) {
      expect(attr.exact).toBeNull();
    }
    expect(potentialBand(state, other)).toBeNull();
  });

  it("맞대결에서 실제로 뛴 선수만 seen이 된다 (벤치에만 앉은 선수는 아니다)", () => {
    const state = createTestGame(11);
    advanceAndPlay(state); // 첫 경기를 끝까지
    // 우리가 치른 경기 — 같은 날 다른 팀 경기도 시뮬되므로 유저 경기를 명시적으로 찾는다
    const played = state.matches.find(
      (m) => m.result && (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    )!;
    const userIsHome = played.homeTeamId === state.userTeamId;
    const opponentId = userIsHome ? played.awayTeamId : played.homeTeamId;
    const lineup = (userIsHome ? played.result!.awayLineup : played.result!.homeLineup) ?? [];
    expect(lineup.length).toBeGreaterThanOrEqual(11);

    for (const id of lineup) expect(knowledgeOf(state, id)).toBe("seen");

    // 같은 팀인데 출전 명단에 없던 선수는 여전히 평판 수준
    const benched = playersOf(state, opponentId).find((p) => !lineup.includes(p.id));
    expect(benched).toBeDefined();
    expect(knowledgeOf(state, benched!.id)).toBe("rumoured");
  });

  it("우리가 없던 경기의 선수는 seen이 되지 않는다 (남의 경기는 못 본다)", () => {
    const state = createTestGame(11);
    advanceAndPlay(state);
    // 우리 경기는 금요일 개막전일 수 있다 — 라운드가 끝나도록 며칠 더 보내
    // 타 팀 경기(간이 시뮬)가 치러지게 한다
    advanceTime(state, { days: 5 });
    const otherMatch = state.matches.find(
      (m) =>
        m.result &&
        m.homeTeamId !== state.userTeamId &&
        m.awayTeamId !== state.userTeamId &&
        (m.result.homeLineup?.length ?? 0) > 0,
    );
    expect(otherMatch).toBeDefined();
    const someone = otherMatch!.result!.homeLineup![0]!;
    expect(knowledgeOf(state, someone)).toBe("rumoured");
  });

  it("스카우팅을 마쳐도 판단 계열 축은 오차가 남는다 (히든 레이어 대체물)", () => {
    const state = createTestGame(11);
    const target = anyOpponent(state);
    expect(scoutPlayer(state, target.id).ok).toBe(true);
    expect(knowledgeOf(state, target.id)).toBe("rumoured"); // 아직 파견 중

    advanceTime(state, { days: SCOUT_DAYS });
    expect(knowledgeOf(state, target.id)).toBe("scouted");
    // 관측형(실행 계열)도 ±1 — 리포트는 정답 공개가 아니라 오차를 좁히는 행위다
    for (const attr of scoutedAttributes(state, target)) {
      expect(attr.exact, `${attr.key}는 스카우팅으로도 확정되지 않는다`).toBeNull();
      const observed = observedRating(
        state,
        target.id,
        attr.key,
        target.attributes[attr.key],
        "scouted",
      );
      const limit = AXIS_OBSERVABILITY[attr.key] === "observable" ? 1 : 3;
      expect(Math.abs(observed - target.attributes[attr.key])).toBeLessThanOrEqual(limit);
    }
    // 스카우트 한 번으로는 잠재력을 "대강" 잡을 뿐이다
    const band = potentialBand(state, target);
    expect(band).not.toBeNull();
    expect(band!.margin).toBe(POTENTIAL_MARGIN.scouted);
  });

  it("분석형 축이 관측형보다 넓게 틀린다 — 계층이 실제로 다르게 작동한다", () => {
    const state = createTestGame(11);
    const errorOf = (layer: "observable" | "analytical", knowledge: "seen" | "rumoured") => {
      let sum = 0;
      let n = 0;
      for (const p of playersOf(state, "chelsea")) {
        for (const axis of SCOUT_ATTRS) {
          if (AXIS_OBSERVABILITY[axis] !== layer) continue;
          sum += Math.abs(
            observedRating(state, p.id, axis, p.attributes[axis], knowledge) - p.attributes[axis],
          );
          n++;
        }
      }
      return sum / n;
    };
    expect(errorOf("analytical", "seen")).toBeGreaterThan(errorOf("observable", "seen"));
    expect(errorOf("analytical", "rumoured")).toBeGreaterThan(errorOf("observable", "rumoured"));
  });
});

describe("관측 오차", () => {
  it("결정적이다 — 같은 선수·능력치는 항상 같은 관측값", () => {
    const state = createTestGame(11);
    const other = anyOpponent(state);
    const first = SCOUT_ATTRS.map((a) => observedRating(state, other.id, a, other.attributes[a]));
    const second = SCOUT_ATTRS.map((a) => observedRating(state, other.id, a, other.attributes[a]));
    expect(second).toEqual(first);
  });

  it("오차는 축의 계층별 상한 안에 머문다 (관측형 ±3/±6 · 분석형 ±6/±10)", () => {
    const state = createTestGame(11);
    for (const p of playersOf(state, "chelsea")) {
      for (const attr of SCOUT_ATTRS) {
        const trueValue = p.attributes[attr];
        const rumoured = observedRating(state, p.id, attr, trueValue, "rumoured");
        const seen = observedRating(state, p.id, attr, trueValue, "seen");
        const layer = AXIS_OBSERVABILITY[attr];
        expect(Math.abs(rumoured - trueValue)).toBeLessThanOrEqual(
          OBSERVATION_MARGIN[layer].rumoured,
        );
        expect(Math.abs(seen - trueValue)).toBeLessThanOrEqual(OBSERVATION_MARGIN[layer].seen);
        expect(rumoured).toBeGreaterThanOrEqual(1);
        expect(rumoured).toBeLessThanOrEqual(99);
      }
    }
  });

  it("실제로 흔들린다 — 전원이 참값과 같지는 않다", () => {
    const state = createTestGame(11);
    const shifted = playersOf(state, "chelsea").filter((p) =>
      SCOUT_ATTRS.some(
        (a) => observedRating(state, p.id, a, p.attributes[a], "rumoured") !== p.attributes[a],
      ),
    );
    expect(shifted.length).toBeGreaterThan(5);
  });

  it("안개는 표현 계층 전용 — 선수의 실제 능력치는 그대로다", () => {
    const state = createTestGame(11);
    const other = anyOpponent(state);
    const before = { ...other.attributes };
    scoutedAttributes(state, other);
    observedRating(state, other.id, "pace", other.attributes.pace);
    expect(other.attributes).toEqual(before);
  });
});

describe("스카우트 파견 규칙", () => {
  it("우리 선수에게는 보낼 수 없다", () => {
    const state = createTestGame(11);
    const mine = userPlayers(state)[0]!;
    const res = scoutPlayer(state, mine.id);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("우리 선수");
  });

  it("같은 선수에게 두 번 보내지 않는다", () => {
    const state = createTestGame(11);
    const target = anyOpponent(state);
    expect(scoutPlayer(state, target.id).ok).toBe(true);
    const again = scoutPlayer(state, target.id);
    expect(again.ok).toBe(false);
    expect(again.message).toContain("이미");
  });

  /** 셋을 채우고 넷째를 부른다 — 한도에 막힌 그 넷째를 돌려준다 */
  function fillAndOverflow(state: GameState) {
    const pool = playersOf(state, "chelsea");
    for (let i = 0; i < SCOUT_CONCURRENT_LIMIT; i++) {
      expect(scoutPlayer(state, pool[i]!.id).ok).toBe(true);
    }
    const fourth = pool[SCOUT_CONCURRENT_LIMIT]!;
    return { pool, fourth, result: scoutPlayer(state, fourth.id) };
  }

  it("동시 파견 한도를 넘기면 무엇이 나갔고 무엇이 안 나갔는지 말한다", () => {
    const state = createTestGame(11);
    const { pool, fourth, result } = fillAndOverflow(state);
    expect(result.ok).toBe(false);
    // 한도만 알려 주면 감독은 지목한 넷 중 누가 빠졌는지 알 수 없다
    expect(result.message).toContain(fourth.name);
    expect(result.message).toContain(pool[0]!.name);
    expect(result.message).toContain(`${SCOUT_CONCURRENT_LIMIT}명`);
  });

  it("못 나간 요청은 대기로 남아 다음 턴 스카우팅 줄에 실린다", () => {
    const state = createTestGame(11);
    const { fourth } = fillAndOverflow(state);
    expect(deferredScouts(state).map((d) => d.gamePlayerId)).toEqual([fourth.id]);
    // 같은 이름을 다시 불러도 대기는 하나다
    scoutPlayer(state, fourth.id);
    expect(deferredScouts(state)).toHaveLength(1);
    const summary = scoutingSummary(state).join("\n");
    expect(summary).toContain(fourth.name);
    expect(summary).toContain("빈 자리 없음");
  });

  it("자리가 나는 날에도 대기는 살아 있고, 다시 보내면 지워진다", () => {
    const state = createTestGame(11);
    const { fourth } = fillAndOverflow(state);
    // 보고가 들어와 자리가 나는 그날 — 대기가 사라지면 감독은 넷째를 잊는다
    advanceTime(state, { days: SCOUT_DAYS });
    expect(deferredScouts(state)).toHaveLength(1);
    expect(scoutingSummary(state).join("\n")).toContain(`지금 자리 ${SCOUT_CONCURRENT_LIMIT}`);
    expect(scoutPlayer(state, fourth.id).ok).toBe(true);
    // 나간 파견이 "아직 안 나갔다"로 남으면 한 화면이 두 말을 한다
    expect(deferredScouts(state)).toHaveLength(0);
    expect(state.deferredScouts).toHaveLength(0);
  });

  it("일주일을 넘긴 대기는 지운다 — 그 안에 자리는 반드시 난다", () => {
    const state = createTestGame(11);
    const requestedOn = state.date;
    fillAndOverflow(state);
    advanceTime(state, { days: SCOUT_DEFER_DAYS + 1 });
    // 시계가 실제로 그만큼 넘어갔는지 — 중간에 멈췄으면 아래 단언이 뜻을 잃는다
    expect(diffDays(requestedOn, state.date)).toBeGreaterThan(SCOUT_DEFER_DAYS);
    expect(deferredScouts(state)).toHaveLength(0);
    // 읽는 쪽이 걸러 준 게 아니라 tick이 지웠다
    expect(state.deferredScouts).toHaveLength(0);
    expect(scoutingSummary(state).join("\n")).not.toContain("미파견");
  });

  it("완료되면 다이제스트로 보고된다", () => {
    const state = createTestGame(11);
    const target = anyOpponent(state);
    scoutPlayer(state, target.id);
    const outcome = advanceTime(state, { days: SCOUT_DAYS });
    expect(outcome.digest.join("\n")).toContain("스카우트 보고서 도착");
  });

  it("없는 선수는 반려한다", () => {
    const state = createTestGame(11);
    expect(scoutPlayer(state, "ghost-player").ok).toBe(false);
  });
});

describe("영입 직후 — 안개는 날짜가 아니라 정착으로 걷힌다", () => {
  /** 타 팀 선수를 우리 팀으로 옮기고 TRANSFER 원장에 남긴다 (협상 스킬의 결과만 모사) */
  function signPlayer(state: ReturnType<typeof createTestGame>, playerId: string) {
    const player = playerById(state, playerId)!;
    const fromTeamId = player.teamId;
    player.teamId = state.userTeamId;
    state.transfers.push({
      id: `t-${playerId}`,
      gamePlayerId: playerId,
      windowId: null,
      fromTeamId,
      toTeamId: state.userTeamId,
      date: state.date,
      type: "transfer",
      fee: 0,
    });
  }

  it("영입 당일은 adapting — 우리 선수인데도 수치를 단정하지 못한다", () => {
    const state = createTestGame(11);
    const target = anyOpponent(state);
    signPlayer(state, target.id);

    expect(knowledgeOf(state, target.id)).toBe("adapting");
    for (const attr of scoutedAttributes(state, target)) {
      expect(attr.exact, `${attr.key}는 정착 전엔 확정되지 않는다`).toBeNull();
    }
    // 오차 폭은 스카우트 수준에서 출발한다
    for (const axis of SCOUT_ATTRS) {
      const limit = OBSERVATION_MARGIN[AXIS_OBSERVABILITY[axis]].adapting;
      const observed = observedRating(state, target.id, axis, target.attributes[axis]);
      expect(Math.abs(observed - target.attributes[axis])).toBeLessThanOrEqual(limit);
    }
    // 잠재력은 우리 선수보다도 넓게 본다 — 계약서에 사인해도 아직 모르는 몸이다
    expect(potentialBand(state, target)!.margin).toBeGreaterThan(POTENTIAL_FLOOR);
  });

  it("정착이 끝나면 own — 수치가 정확해진다", () => {
    const state = createTestGame(11);
    const target = anyOpponent(state);
    signPlayer(state, target.id);
    settleFully(state, target.id);

    expect(knowledgeOf(state, target.id)).toBe("own");
    for (const attr of scoutedAttributes(state, target)) {
      expect(attr.exact).not.toBeNull();
    }
  });

  it("원소속 선수는 정착 과정이 없다 — 이미 함께해 온 선수다", () => {
    const state = createTestGame(11);
    for (const p of userPlayers(state)) {
      expect(knowledgeOf(state, p.id)).toBe("own");
      expect(settlingOf(state, p.id)).toBeNull();
    }
  });

  it("오피스 스쿼드 뷰도 정착 중인 선수는 추정치를 보여준다", () => {
    const state = createTestGame(11);
    const target = anyOpponent(state);
    const trueOverall = target.attributes.overall;
    signPlayer(state, target.id);
    const row = buildOfficeViews(state).squad.players.find((p) => p.id === target.id)!;
    expect(row.settling).not.toBeNull();
    // 종합은 판단 계열을 포함하므로 분석형 오차 — 참값과 다를 수 있어야 안개가 작동한다
    expect(Math.abs(row.overall - trueOverall)).toBeLessThanOrEqual(
      OBSERVATION_MARGIN.analytical.adapting,
    );
  });
});

describe("잠재력 — 누구도 단정하지 못한다 (구간으로만 안다)", () => {
  const opponentOf = (state: GameState) => playersOf(state, "chelsea")[0]!;

  /**
   * 보고서가 닫힐 때까지 하루씩 — advanceTime은 부상·불만에 걸려 일찍 멈춘다.
   * 프리시즌에도 경기가 있으므로(친선) 경기일에 걸리면 치르고 간다 — 안 그러면
   * 시계가 경기일에 멎어 보고서가 영영 안 닫힌다.
   */
  const awaitReport = (state: GameState, playerId: string) => {
    for (let i = 0; i < SCOUT_DAYS * 3; i++) {
      const pending = state.scoutReports.some(
        (r) => r.gamePlayerId === playerId && r.completedOn === null,
      );
      if (!pending) return;
      if (state.phase === "matchday") playMockMatch(state);
      else advanceTime(state, { days: 1 });
    }
    throw new Error("스카우트 보고서가 닫히지 않았다");
  };

  it("참값은 언제나 추정 구간 안에 있다 — 안개는 거짓말이 아니다", () => {
    const state = createTestGame(11);
    const ours = userPlayers(state).slice(0, 12);
    expect(ours.length, "우리 선수를 못 찾았다").toBe(12);
    for (const p of ours) {
      const band = potentialBand(state, p);
      expect(band, `${p.name} 구간이 없다`).not.toBeNull();
      expect(band!.low, `${p.name} 하한`).toBeLessThanOrEqual(p.attributes.potential);
      expect(band!.high, `${p.name} 상한`).toBeGreaterThanOrEqual(p.attributes.potential);
      // 하한이 현재 실력 아래로 내려가지 않는다 — 이미 가진 것을 못 가질 수는 없다
      expect(band!.low).toBeLessThanOrEqual(band!.high);
    }
    // 스카우팅 전의 타 팀 선수는 구간 자체가 없다 — 짐작할 근거가 없으면 "미지"다
    for (const p of playersOf(state, "chelsea").slice(0, 12)) {
      expect(potentialBand(state, p), `${p.name}`).toBeNull();
    }
  });

  it("하한은 감독이 아는 현재 실력 아래로 내려가지 않는다 — 이미 가진 것을 못 가질 수는 없다", () => {
    const state = createTestGame(11);
    const scouted = opponentOf(state);
    scoutPlayer(state, scouted.id);
    awaitReport(state, scouted.id);
    expect(knowledgeOf(state, scouted.id)).toBe("scouted");

    for (const p of [...userPlayers(state), scouted]) {
      const band = potentialBand(state, p)!;
      // 기준은 **관측** 종합이다 — 참 종합을 쓰면 하한이 그 숫자를 그대로 부른다
      const known = observedOverall(p.attributes.overall, observationOf(state, p.id));
      // 안개가 종합을 참 잠재력 위로 부풀렸으면 참값이 이긴다 (구간 안 불변식이 먼저)
      expect(band.low, `${p.name} 하한`).toBeGreaterThanOrEqual(
        Math.min(known, p.attributes.potential),
      );
      expect(band.low, `${p.name} 하한은 참값 아래`).toBeLessThanOrEqual(p.attributes.potential);
      expect(band.high, `${p.name} 상한은 참값 위`).toBeGreaterThanOrEqual(p.attributes.potential);
    }
  });

  it("같은 선수를 몇 번을 물어도 같은 구간이 나온다 — 결정적", () => {
    const state = createTestGame(11);
    const p = userPlayers(state)[0]!;
    expect(potentialBand(state, p)).toEqual(potentialBand(state, p));
  });

  it("만난 적 없는 선수는 짐작조차 못 한다", () => {
    const state = createTestGame(11);
    const unknown = opponentOf(state);
    expect(potentialBand(state, unknown)).toBeNull();
    // 안내문도 같은 말을 한다 — 구간이 없으면 구간을 약속하지 않는다
    expect(knowledgeNote(state, unknown.id)).toContain("짐작할 근거가 없다");
  });

  it("우리 선수는 **데리고 뛸수록** 좁아지고, 끝까지 ±2는 남는다", () => {
    const state = createTestGame(11);
    const p = userPlayers(state)[0]!;
    const before = potentialBand(state, p)!.margin;
    expect(before).toBe(POTENTIAL_MARGIN.own);

    state.seasonStats.push({
      gamePlayerId: p.id,
      season: state.season,
      teamId: state.userTeamId,
      apps: 40,
      goals: 0,
    });
    const after = potentialBand(state, p)!.margin;
    expect(after).toBeLessThan(before);
    expect(after).toBe(POTENTIAL_FLOOR);
  });

  it("타 팀은 스카우트를 거듭 보내야 좁아진다 — 한 번으로는 대강일 뿐", () => {
    const state = createTestGame(11);
    const target = opponentOf(state);
    const margins: number[] = [];
    for (let i = 0; i < SCOUT_REPEAT_LIMIT; i++) {
      expect(scoutPlayer(state, target.id).ok, `${i + 1}번째 파견`).toBe(true);
      awaitReport(state, target.id);
      margins.push(potentialBand(state, target)!.margin);
    }
    // 안내문이 "알 수 없다"고 하면 모델이 손에 든 구간을 버린다
    expect(knowledgeNote(state, target.id)).toContain("구간으로만");
    expect(margins[0]).toBe(POTENTIAL_MARGIN.scouted);
    expect(margins[margins.length - 1]).toBe(POTENTIAL_SCOUT_FLOOR);
    for (let i = 1; i < margins.length; i++) expect(margins[i]!).toBeLessThan(margins[i - 1]!);
    // 훈련장을 못 보는 한 우리 선수만큼은 못 좁힌다
    expect(POTENTIAL_SCOUT_FLOOR).toBeGreaterThan(POTENTIAL_FLOOR);
  });

  it("한도를 넘겨 보내면 반려한다 — 더 봐도 새로 알 게 없다", () => {
    const state = createTestGame(11);
    const target = opponentOf(state);
    for (let i = 0; i < SCOUT_REPEAT_LIMIT; i++) {
      expect(scoutPlayer(state, target.id).ok).toBe(true);
      awaitReport(state, target.id);
    }
    const over = scoutPlayer(state, target.id);
    expect(over.ok).toBe(false);
    expect(over.message).toContain("새로 알 게 없");
  });
});

/**
 * 체력 안개 — 능력치와 **다른 자**를 쓴다. 리포트가 아니라 눈으로 읽는 것이라
 * 스카우팅 5단계가 아니라 "출발점을 아는가 · 얼마나 뛰었나 · 감독의 분석"이 가른다.
 */
describe("체력 안개", () => {
  it("우리 선수도 값 하나로 서지 않는다 — 다만 폭이 좁다", () => {
    const state = createTestGame(11);
    const mine = userPlayers(state)[0]!;
    const them = anyOpponent(state);
    const mineRead = readCondition(state, mine.id, 64, 20, "match-1");
    const themRead = readCondition(state, them.id, 64, 20, "match-1");
    expect(mineRead.margin).toBeGreaterThan(0);
    expect(mineRead.low).toBeLessThanOrEqual(64);
    expect(mineRead.high).toBeGreaterThanOrEqual(64);
    // 출발점을 아는 쪽이 훨씬 좁다 — 아침에 쟀으니까
    expect(mineRead.margin).toBeLessThan(themRead.margin / 2);
  });

  it("뛴 만큼 흐려진다 — 킥오프엔 거의 정확하고 막판이 가장 흐리다", () => {
    const state = createTestGame(11);
    const mine = userPlayers(state)[0]!;
    const them = anyOpponent(state);
    for (const id of [mine.id, them.id]) {
      const fresh = conditionMargin(state, id, 0);
      const spent = conditionMargin(state, id, 34); // 90분 온전히 뛴 스트라이커
      expect(spent, id).toBeGreaterThan(fresh);
    }
    // 교체를 정해야 하는 그 순간이 가장 흐리다는 게 이 규칙의 요점이다
    expect(conditionMargin(state, mine.id, 34)).toBeGreaterThan(
      conditionMargin(state, mine.id, 10),
    );
  });

  it("참값은 언제나 구간 안에 있다 — 결정적이다", () => {
    const state = createTestGame(11);
    const them = anyOpponent(state);
    for (const truth of [0, 12, 37, 55, 78, 100]) {
      const read = readCondition(state, them.id, truth, 25, "match-1");
      expect(read.margin).toBeGreaterThan(0);
      expect(read.low).toBeLessThanOrEqual(truth);
      expect(read.high).toBeGreaterThanOrEqual(truth);
      expect(read.low).toBeGreaterThanOrEqual(0);
      expect(read.high).toBeLessThanOrEqual(100);
      // 같은 질문엔 같은 답 — 정지점마다 값이 튀면 상대가 지치는 건지 알 수 없다
      expect(readCondition(state, them.id, truth, 25, "match-1")).toEqual(read);
    }
  });

  it("다리가 멈춘 건 가리지 못한다 — 추정 구간이 구멍 문턱을 넘지 않는다", () => {
    const state = createTestGame(11);
    const mine = userPlayers(state)[0]!;
    const them = anyOpponent(state);
    for (const id of [mine.id, them.id]) {
      for (let truth = 0; truth <= 100; truth++) {
        const read = readCondition(state, id, truth, 34, "match-1");
        const gassed = truth <= GAP_CONDITION;
        // 화면이 두 말을 하지 않는다: 읽은 값의 구멍 판정 = 참값의 구멍 판정
        expect(read.value <= GAP_CONDITION, `${id} 체력 ${truth}`).toBe(gassed);
        expect(read.low <= GAP_CONDITION, `${id} 체력 ${truth}`).toBe(gassed);
        expect(read.high <= GAP_CONDITION, `${id} 체력 ${truth}`).toBe(gassed);
      }
    }
  });

  it("경기가 다르면 편향도 다시 뽑힌다 — 어제의 오독이 오늘까지 따라오지 않는다", () => {
    const state = createTestGame(11);
    const ids = playersOf(state, "chelsea").slice(0, 12);
    const a = ids.map((p) => readCondition(state, p.id, 70, 25, "match-1").value);
    const b = ids.map((p) => readCondition(state, p.id, 70, 25, "match-2").value);
    expect(a).not.toEqual(b);
  });

  it("분석이 높은 감독은 다리를 더 정확히 읽는다 — 남의 것도 내 것도", () => {
    const state = createTestGame(11);
    const mine = userPlayers(state)[0]!;
    const them = anyOpponent(state);
    for (const id of [mine.id, them.id]) {
      state.manager.attributes.analysis = 1;
      const dull = conditionMargin(state, id, 34);
      state.manager.attributes.analysis = 99;
      const sharp = conditionMargin(state, id, 34);
      // 절반 아래로 좁아진다 (반올림 때문에 좁은 쪽은 비율이 조금 흔들린다)
      expect(sharp, id).toBeLessThan(dull / 2);
      // 다 보이지는 않는다 — 안개가 0이 되면 안개가 아니다
      expect(sharp, id).toBeGreaterThan(0);
    }
    // 폭이 넉넉한 상대 쪽에서 계수가 그대로 드러난다
    state.manager.attributes.analysis = 1;
    const dull = conditionMargin(state, them.id, 34);
    state.manager.attributes.analysis = 99;
    expect(conditionMargin(state, them.id, 34) / dull).toBeCloseTo(ANALYSIS_FLOOR, 1);
  });

  it("코어 수치는 오염되지 않는다 — 안개는 읽는 쪽에만 씌운다", () => {
    const state = createTestGame(11);
    const them = anyOpponent(state);
    const before = them.state.condition;
    readCondition(state, them.id, before, 20, "match-1");
    expect(playerById(state, them.id)!.state.condition).toBe(before);
  });
});

// ─── 스카우팅 보고서 카드 (scout-report-card.test.ts에서 옮겨 왔다) ───
/**
 * 스카우팅 보고서 카드 — 며칠을 기다려 얻은 것이라 **한 장으로 펴서** 보여준다.
 * 안개는 값이 아니라 `exact`로 드러난다: 화면이 흐리게 그릴 근거다.
 */

const isKeeper = (p: { positions: { position: string }[] }) =>
  p.positions.some((x) => x.position === "GK");

const target = (state: GameState) =>
  playersOf(state, "chelsea").find((p) => p.teamId !== state.userTeamId && !isKeeper(p))!;

const keeper = (state: GameState) => playersOf(state, "chelsea").find(isKeeper)!;

describe("보고서 한 장", () => {
  /** 필드 플레이어의 골키핑은 어디에도 쓰이지 않는다 — 보고서에 두면 줄만 잡아먹는다 */
  it("골키핑은 골키퍼의 보고서에만 실린다", () => {
    const state = createTestGame(11);
    const hasGk = (id: string) =>
      scoutReportCard(state, id)!.attributes.some((a) => a.key === "goalkeeping");

    expect(hasGk(target(state).id)).toBe(false);
    expect(hasGk(keeper(state).id)).toBe(true);
  });

  /**
   * 종합·잠재력은 **등급으로 말한다** — 스카우트가 가져온 숫자에는 늘 ±가 붙는데
   * 또렷한 숫자 하나로 그리면 감독이 그걸 사실로 읽는다.
   */
  it("종합과 잠재력은 등급이다", () => {
    const state = createTestGame(11);
    const card = scoutReportCard(state, target(state).id)!;

    expect(card.overall.margin).toBeGreaterThan(0);
    // 등급은 관측값에서 나온다 — 화면이 따로 계산하면 같은 값이 두 말을 한다
    expect(card.overall.label).toBe(ratingLabel(card.overall.value));
    expect(card.overall.tier).toBe(ratingTier(card.overall.value));
    if (card.potential) {
      expect(card.potential.low.value).toBeLessThanOrEqual(card.potential.high.value);
    }
  });

  it("스카우팅이 안개를 좁힌다 — 다만 0으로 만들지는 않는다", () => {
    const state = createTestGame(11);
    const p = target(state);
    const spread = (card: NonNullable<ReturnType<typeof scoutReportCard>>) =>
      card.attributes.reduce((sum, a) => sum + a.margin, 0);

    const before = spread(scoutReportCard(state, p.id)!);
    expect(scoutPlayer(state, p.id).ok).toBe(true);
    for (let i = 0; i < SCOUT_DAYS * 3 && !state.scoutReports[0]?.completedOn; i++) {
      advanceTime(state, { days: 1 });
    }
    const after = spread(scoutReportCard(state, p.id)!);

    /**
     * 리포트는 **정답 공개가 아니라 오차를 좁히는 행위**다 — 관측형 ±1 ·
     * 분석형 ±3이 끝까지 남는다 (player.md §9).
     */
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
  });

  /**
   * 카드는 모델이 장면을 **쓴 뒤에** 붙어 화면에만 간다. 모델이 읽는 것은 도착 줄뿐이라
   * 두 값이 갈리면 카드는 £34.9M인데 대사는 4,000만이 된다 (agents.md §6).
   */
  it("도착 다이제스트가 카드와 같은 값을 낸다", () => {
    const state = createTestGame(11);
    const p = target(state);
    expect(scoutPlayer(state, p.id).ok).toBe(true);

    let arrival = "";
    for (let i = 0; i < SCOUT_DAYS * 3 && !arrival; i++) {
      arrival =
        advanceTime(state, { days: 1 }).digest.find((d) => d.startsWith("스카우트 보고서 도착")) ??
        "";
    }
    const card = scoutReportCard(state, p.id)!;
    expect(arrival).toBe(`스카우트 보고서 도착 — ${scoutReportLine(state, p.id)}`);
    expect(arrival).toContain(formatMoney(card.marketValue));
    expect(arrival).toContain(formatMoney(card.wageExpectation));
    expect(arrival).toContain(`종합 ${card.overall.value}`);
  });

  /**
   * 카드는 **모델이 그 값을 읽은 턴에만** 선다 — 시계가 장면 뒤에 구른 턴(모델 헤더)의
   * 도착은 줄에 남아 다음 턴에 실린다. 도착과 동시에 카드를 세우면 그 턴의 모델은
   * 금액을 못 읽은 채 카드 옆에서 지어낸다 (agents.md §6).
   */
  it("도착한 보고서는 카드로 꺼내 갈 때까지 줄에 남는다", () => {
    const state = createTestGame(11);
    const p = target(state);
    expect(scoutPlayer(state, p.id).ok).toBe(true);
    for (let i = 0; i < SCOUT_DAYS * 3 && !state.scoutReports[0]?.completedOn; i++) {
      advanceTime(state, { days: 1 });
    }

    expect(state.pendingReportCards).toEqual([p.id]);
    // 며칠이 더 흘러도 사라지지 않는다 — 아직 아무도 읽지 않았다
    advanceTime(state, { days: 3 });
    expect(state.pendingReportCards).toEqual([p.id]);

    expect(takeReportCards(state, 3)).toEqual([p.id]);
    expect(takeReportCards(state, 3)).toEqual([]);
  });

  /** 상한을 넘긴 만큼은 **버리지 않고 남긴다** — 며칠을 기다려 산 카드다 */
  it("한 턴 상한을 넘으면 남은 것은 다음 턴 몫으로 남는다", () => {
    const state = createTestGame(11);
    pushReportCards(state, ["a", "b", "c", "d"]);
    expect(takeReportCards(state, 3)).toEqual(["a", "b", "c"]);
    expect(takeReportCards(state, 3)).toEqual(["d"]);
  });

  it("없는 선수는 null — 화면이 빈 카드를 그리지 않는다", () => {
    const state = createTestGame(11);
    expect(scoutReportCard(state, "ghost")).toBeNull();
  });
});
