import { describe, expect, it } from "vitest";
import {
  advanceTime,
  knowledgeOf,
  observedRating,
  playersOf,
  potentialView,
  scoutPlayer,
  scoutedAttributes,
  userPlayers,
  AXIS_OBSERVABILITY,
  OBSERVATION_MARGIN,
  SCOUT_ATTRS,
  type GameState,
} from "@story-fm/engine";
import { SCOUT_CONCURRENT_LIMIT, SCOUT_DAYS } from "@story-fm/domain";
import { advanceAndPlay, createTestGame } from "./helpers";

/**
 * 정보 비대칭(안개) — 우리 선수는 정확히, 타 팀은 흐릿하게.
 * 핵심 불변식: (1) 오차는 결정적이다 (2) 코어 수치는 오염되지 않는다.
 */

function anyOpponent(state: GameState) {
  return playersOf(state, "chelsea")[0]!;
}

describe("지식 수준 파생", () => {
  it("우리 선수는 own — 모든 수치가 정확하고 잠재력도 보인다", () => {
    const state = createTestGame(11);
    const mine = userPlayers(state)[0]!;
    expect(knowledgeOf(state, mine.id)).toBe("own");
    for (const attr of scoutedAttributes(state, mine)) {
      expect(attr.exact).not.toBeNull();
    }
    expect(potentialView(state, mine)).toContain("POT");
  });

  it("만난 적 없는 타 팀 선수는 rumoured — 숫자를 감추고 잠재력도 미지", () => {
    const state = createTestGame(11);
    const other = anyOpponent(state);
    expect(knowledgeOf(state, other.id)).toBe("rumoured");
    for (const attr of scoutedAttributes(state, other)) {
      expect(attr.exact).toBeNull();
      expect(attr.label.length).toBeGreaterThan(0);
    }
    expect(potentialView(state, other)).toContain("미지");
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
      const observed = observedRating(state, target.id, attr.key, target.attributes[attr.key], "scouted");
      const limit = AXIS_OBSERVABILITY[attr.key] === "observable" ? 1 : 3;
      expect(Math.abs(observed - target.attributes[attr.key])).toBeLessThanOrEqual(limit);
    }
    expect(potentialView(state, target)).toContain("미지");
  });

  it("분석형 축이 관측형보다 넓게 틀린다 — 계층이 실제로 다르게 작동한다", () => {
    const state = createTestGame(11);
    const errorOf = (layer: "observable" | "analytical", knowledge: "seen" | "rumoured") => {
      let sum = 0;
      let n = 0;
      for (const p of playersOf(state, "chelsea")) {
        for (const axis of SCOUT_ATTRS) {
          if (AXIS_OBSERVABILITY[axis] !== layer) continue;
          sum += Math.abs(observedRating(state, p.id, axis, p.attributes[axis], knowledge) - p.attributes[axis]);
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
        expect(Math.abs(rumoured - trueValue)).toBeLessThanOrEqual(OBSERVATION_MARGIN[layer].rumoured);
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

  it("동시 파견 한도를 넘기면 반려한다", () => {
    const state = createTestGame(11);
    const pool = playersOf(state, "chelsea");
    for (let i = 0; i < SCOUT_CONCURRENT_LIMIT; i++) {
      expect(scoutPlayer(state, pool[i]!.id).ok).toBe(true);
    }
    const over = scoutPlayer(state, pool[SCOUT_CONCURRENT_LIMIT]!.id);
    expect(over.ok).toBe(false);
    expect(over.message).toContain(`${SCOUT_CONCURRENT_LIMIT}명까지`);
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
