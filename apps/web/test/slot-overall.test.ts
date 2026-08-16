import { describe, expect, it } from "vitest";
import { defaultRoleOf } from "@story-fm/domain";
import {
  buildOfficeViews,
  createGame,
  interpretBackgroundHeuristic,
  playersOf,
  settlingOf,
  type GameState,
} from "@story-fm/engine";
import { slotOverallOf } from "../lib/slot-overall";

/**
 * **명단 OVR·전술판 칩·선발 평균은 같은 규칙에서 나온다.**
 *
 * 규칙은 하나다 — 관측된 축에서 `roleFit`을 내고 관측 오프셋을 얹는다. 서버도
 * 같은 꼴로 계산하므로(`observedFit`) 어디서 재도 같은 값이어야 한다. 여기서
 * 고정하는 건 그 **일치**와, 안개가 여전히 살아 있다는 사실이다.
 *
 * e2e로는 잡을 수 없다 — 새 게임에는 안개(적응 중인 새 영입)가 자연히 생기지
 * 않아, 서버와 화면이 우연히 같은 값을 내고도 통과한다.
 */

function game(seed = 31): GameState {
  const background = "K리그에서 뛰다 은퇴한 수비수 출신 분석가";
  return createGame({
    seed,
    userTeamId: "arsenal",
    managerName: "김감독",
    background,
    attributes: interpretBackgroundHeuristic(background),
  });
}

type SquadRows = ReturnType<typeof buildOfficeViews>["squad"]["players"];

/** 읽기만 하는 케이스는 세계를 하나만 세워 나눠 쓴다 — 상태를 바꾸는 쪽만 제 것을 짓는다 */
let cached: { state: GameState; rows: SquadRows } | undefined;
function shared(): { state: GameState; rows: SquadRows } {
  if (cached === undefined) {
    const state = game();
    cached = { state, rows: buildOfficeViews(state).squad.players };
  }
  return cached;
}

describe("화면과 서버가 같은 값을 낸다", () => {
  it("배치된 선수의 자리 전력이 서버의 slotOverall과 같다", () => {
    const placed = shared().rows.filter((p) => p.assignedPosition !== null);
    expect(placed.length).toBeGreaterThanOrEqual(11);
    for (const p of placed) {
      const mine = slotOverallOf(p, p.assignedPosition, p.roleId ?? undefined);
      // 서버는 주 포지션과 값이 같으면 null로 접는다 — 그때는 overall이 그 자리 값이다
      expect(mine, p.name).toBe(p.slotOverall ?? p.overall);
    }
  });

  it("자리별 목록의 전력도 같다 — 옮겨 보기 전에 이미 맞는다", () => {
    for (const p of shared().rows) {
      for (const listed of p.positions) {
        expect(slotOverallOf(p, listed.position, defaultRoleOf(listed.position)), p.name).toBe(
          listed.overall,
        );
      }
    }
  });

  /**
   * 종합은 **저장값에 오프셋만** 얹는다 — 관측된 축에서 다시 굴리지 않는다.
   * 저장값(`attributes.overall`)은 생성 시점의 포지션 목록으로 계산돼 있어
   * 지금 목록으로 다시 굴리면 값이 움직이는 선수가 있다 — 화면과 시뮬의 눈금을
   * 그런 부수효과로 옮길 수는 없다.
   */
  it("종합은 저장값에 같은 오프셋을 얹은 값이다", () => {
    const { state, rows } = shared();
    for (const row of rows) {
      const stored = playersOf(state, state.userTeamId).find((x) => x.id === row.id)!;
      expect(row.overall, row.name).toBe(
        Math.max(1, Math.min(99, stored.attributes.overall + row.observation.overallOffset)),
      );
    }
  });
});

describe("안개는 축에만 있고, 합성값은 거기서 파생된다", () => {
  it("적응 중인 새 영입은 관측 오차가 남는데도 두 계산이 어긋나지 않는다", () => {
    const state = game();
    // 타 팀 선수를 우리 팀으로 옮겨 정착을 시작시킨다 (영입 직후와 같은 상태)
    const target = playersOf(state, "chelsea")[0]!;
    target.teamId = state.userTeamId;
    target.squadLevel = "first";
    state.transfers.push({
      id: `tr-test-${target.id}`,
      gamePlayerId: target.id,
      windowId: null,
      fromTeamId: "chelsea",
      toTeamId: state.userTeamId,
      date: state.date,
      type: "transfer",
      fee: 1_000_000,
      note: "테스트 영입",
    });
    expect(settlingOf(state, target.id)?.done).toBe(false);

    const row = buildOfficeViews(state).squad.players.find((p) => p.id === target.id)!;
    expect(row.observation.knowledge).toBe("adapting");
    expect(row.observation.margin).toBeGreaterThan(0);
    for (const listed of row.positions) {
      expect(slotOverallOf(row, listed.position, defaultRoleOf(listed.position))).toBe(
        listed.overall,
      );
    }
  });

  it("우리 선수는 안개가 없다 — 오프셋도 0이다", () => {
    for (const p of shared().rows) {
      expect(p.observation.knowledge, p.name).toBe("own");
      expect(p.observation.margin, p.name).toBe(0);
      expect(p.observation.overallOffset, p.name).toBe(0);
    }
  });
});

describe("자리와 역할이 값을 움직인다", () => {
  it("배치 밖이면 자리 값이 없다", () => {
    const p = shared().rows[0]!;
    expect(slotOverallOf(p, null, undefined)).toBeNull();
  });

  it("같은 자리라도 역할이 다르면 요구가 다르다", () => {
    const cb = shared().rows.find((p) => p.positions.some((x) => x.position === "CB"))!;
    expect(slotOverallOf(cb, "CB", "stopper")).not.toBe(slotOverallOf(cb, "CB", "cover-defender"));
  });

});
