import { describe, expect, it } from "vitest";
import { ATTRIBUTE_AXES, PlayerStateSchema } from "@story-fm/domain";
import {
  clampForm,
  decayedForm,
  formAngle,
  formDeltaFromMatch,
  formLabel,
  formSwing,
  formTone,
  seasonStatOf,
  userPlayers,
} from "@story-fm/engine";
import type { GamePlayer } from "@story-fm/domain";
import { advanceAndPlay, advanceDays, createTestGame } from "./helpers";

/**
 * 폼만 보는 최소 선수 — 침착성과 현재 폼이 전부다.
 *
 * 게임을 만들어 선수를 빌려오면 안 된다(`createTestGame`은 수천 명을 인스턴스화해
 * 수 초가 걸리고, 부하가 걸리면 기본 타임아웃 5초를 넘겨 **간헐 실패**한다).
 * 폼 계산은 `attributes.composure`와 `state.form`만 읽으므로 리터럴로 충분하다.
 */
function player(form: number, composure = 70): GamePlayer {
  const axes = Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, 70])) as Record<string, number>;
  return {
    id: "t",
    catalogId: null,
    teamId: "t",
    name: "테스트",
    birthdate: "2000-01-01",
    positions: [{ position: "CM", proficiency: 90, isNatural: true }],
    attributes: { ...axes, composure, overall: 70, potential: 75 } as GamePlayer["attributes"],
    state: { form, condition: 75 },
    isCaptain: false,
  };
}

describe("폼 — 시간 축을 가진 컨디션 (form.ts)", () => {
  it("같은 경기라도 평점이 다르면 폼이 다르게 움직인다 (개인차)", () => {
    const hero = formDeltaFromMatch(player(0), 8.2, "win");
    const anonymous = formDeltaFromMatch(player(0), 6.3, "win");
    const flop = formDeltaFromMatch(player(0), 4.8, "win");
    expect(hero).toBeGreaterThan(anonymous);
    expect(anonymous).toBeGreaterThan(flop);
    // **이긴 경기에도 부진하면 내려간다** — 예전엔 열한 명이 똑같이 +1이었다
    expect(flop).toBeLessThan(0);
  });

  it("팀 결과는 얹히지만 주인은 개인 활약이다", () => {
    const won = formDeltaFromMatch(player(0), 7.0, "win");
    const lost = formDeltaFromMatch(player(0), 7.0, "loss");
    expect(won).toBeGreaterThan(lost);
    // 잘한 선수는 진 경기에도 폼이 크게 깎이지 않는다
    expect(lost).toBeGreaterThan(-0.3);
  });

  it("기복은 침착성이 정한다 — 침착한 선수는 덜 흔들린다", () => {
    expect(formSwing(player(0, 99))).toBeLessThan(formSwing(player(0, 20)));
    const steady = formDeltaFromMatch(player(0, 95), 8.5, "win");
    const volatile = formDeltaFromMatch(player(0, 25), 8.5, "win");
    expect(volatile).toBeGreaterThan(steady);
    // 나쁜 쪽도 마찬가지 — 기복이 큰 선수는 더 깊이 떨어진다
    expect(formDeltaFromMatch(player(0, 25), 4.5, "loss")).toBeLessThan(
      formDeltaFromMatch(player(0, 95), 4.5, "loss"),
    );
  });

  it("절정에 가까울수록 더 오르기 어렵고, 식는 건 온전히 통한다", () => {
    const fromFlat = formDeltaFromMatch(player(0), 8.0, "win");
    const fromPeak = formDeltaFromMatch(player(0.85), 8.0, "win");
    expect(fromPeak).toBeLessThan(fromFlat * 0.5);
    // 반대 방향(절정에서 부진)은 감쇠 없이 그대로 깎인다
    const down = formDeltaFromMatch(player(0.85), 4.5, "loss");
    expect(down).toBeCloseTo(formDeltaFromMatch(player(0), 4.5, "loss"), 5);
  });

  it("매일 평균으로 끌린다 — 쉬면 식는다", () => {
    let hot = 0.8;
    for (let day = 0; day < 14; day++) hot = decayedForm(hot);
    expect(hot).toBeLessThan(0.8);
    expect(hot).toBeGreaterThan(0.5); // 2주에 사라지지는 않는다
    // 0은 0에 머물고, 음수는 위로 끌린다
    expect(decayedForm(0)).toBe(0);
    expect(decayedForm(-1)).toBeGreaterThan(-1);
    expect(decayedForm(0.001)).toBe(0);
  });

  it("범위와 해상도 — −1~1 실수이고 그 밖으로 나가지 않는다", () => {
    expect(clampForm(4.2)).toBe(1);
    expect(clampForm(-9)).toBe(-1);
    expect(clampForm(0.12345)).toBe(0.123);
    // 스키마가 소수를 통과시켜야 세이브에 남는다 (정수였을 때는 잘렸다)
    expect(() => PlayerStateSchema.parse({ form: 0.42, condition: 75 })).not.toThrow();
    // 축 밖의 값은 거부한다 — 옛 −3~3 세이브는 로드에서 옮긴다(persistence.ts)
    expect(() => PlayerStateSchema.parse({ form: 2, condition: 75 })).toThrow();
  });

  it("각도는 연속이고, 절정에서만 12시를 본다", () => {
    expect(formAngle(1)).toBe(0); // 12시 — 절정에서만
    expect(formAngle(0)).toBe(90); // 3시 — 평소
    expect(formAngle(-1)).toBe(180); // 6시 — 바닥
    expect(formAngle(0.5)).toBe(45);
    expect(formAngle(-0.5)).toBe(135);
    // 눈금이 아니라 연속이다 — 조금만 올라도 각도가 달라진다
    expect(formAngle(0.42)).not.toBe(formAngle(0.45));
    // 축 밖은 잘린다 (12시를 넘어 돌지 않는다)
    expect(formAngle(2)).toBe(0);
    expect(formAngle(-2)).toBe(180);
  });

  it("명단에 여러 각도가 함께 뜬다 — 전부 같으면 폼이 있으나 마나다", () => {
    const state = createTestGame(11, "arsenal");
    for (let i = 0; i < 16; i++) {
      const before = state.date;
      advanceAndPlay(state);
      if (state.date === before || state.season > 1) break;
    }
    const played = userPlayers(state).filter((p) => (seasonStatOf(state, p.id)?.apps ?? 0) > 0);
    const angles = new Set(played.map((p) => formAngle(p.state.form)));
    expect(played.length).toBeGreaterThan(10);
    expect(angles.size).toBeGreaterThanOrEqual(5);
    // 12시(절정)는 아무나 도달하지 못한다
    expect(Math.min(...angles)).toBeGreaterThan(0);
  }, 120_000);

  it("라벨은 시기를 말한다 — 경계는 ±0.33과 ±0.73", () => {
    expect(formLabel(0.85)).toBe("절정");
    expect(formLabel(0.45)).toBe("상승세");
    expect(formLabel(0.1)).toBe("평소");
    expect(formLabel(-0.5)).toBe("침체");
    expect(formLabel(-0.9)).toBe("바닥");
    // 색 계열은 더 좁은 경계를 쓴다 — 평소 안에서도 기울기가 보이게
    expect(formTone(0.2)).toBe("up");
    expect(formTone(0.05)).toBe("flat");
    expect(formTone(-0.2)).toBe("down");
  });

  it("경기를 치르면 선수마다 폼이 갈리고, 쉬면 다시 모인다 (통합)", () => {
    const state = createTestGame(11, "arsenal");
    for (let i = 0; i < 8; i++) {
      const before = state.date;
      advanceAndPlay(state);
      if (state.date === before || state.season > 1) break;
    }
    const played = userPlayers(state).filter((p) => (seasonStatOf(state, p.id)?.apps ?? 0) > 0);
    expect(played.length).toBeGreaterThan(10);

    // ① 한 값에 고정되지 않는다 — 예전 모델은 전원이 +3이었다
    const forms = played.map((p) => p.state.form);
    expect(new Set(forms.map((f) => f.toFixed(3))).size).toBeGreaterThan(3);
    expect(Math.max(...forms)).toBeGreaterThan(Math.min(...forms) + 0.15);
    // ② 소수가 남는다
    expect(forms.some((f) => !Number.isInteger(f))).toBe(true);

    // ③ 쉬면 평균으로 끌린다
    const before = played.map((p) => Math.abs(p.state.form));
    advanceDays(state, 10);
    const after = played.map((p) => Math.abs(p.state.form));
    const shrank = after.filter((v, i) => v < before[i]!).length;
    expect(shrank).toBeGreaterThan(played.length / 2);
  }, 120_000);
});
