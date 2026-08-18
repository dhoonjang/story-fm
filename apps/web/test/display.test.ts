import { describe, expect, it } from "vitest";
import { defaultRoleOf, formatMoney } from "@story-fm/domain";
import {
  buildOfficeViews,
  createGame,
  interpretBackgroundHeuristic,
  playersOf,
  settlingOf,
  type GameState,
} from "@story-fm/engine";
import { slotOverallOf } from "../lib/slot-overall";
import { ratingTone, scoutMargin, scoutValue } from "../lib/scout-report-display";

/**
 * 화면이 만드는 **순수 파생값** — `apps/web/lib`의 표시 규칙들이다. 문자열이 아니라
 * 공식이라 여기서 잰다: 코어 등급을 색 구간으로 접는 경계, 금액의 눈금, 그리고
 * 자리·역할에서 나오는 OVR. 어느 것도 화면을 열면 바로 드러나지 않는다.
 */

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

/**
 * 재정 활동 피드를 펼치면 선수 한 명 몫의 월 상각이 선다 — 백만 눈금으로는
 * 전부 `£0.0M`이 되어 서른 줄이 아무 말도 하지 않는다
 * (docs/simulation/finance.md §8.1).
 */
/**
 * 금액 표기는 자가 하나고 **금액이 눈금을 고른다** (`formatMoney` — overview §5).
 * 백만으로 고정하면 원장 명세가 전부 `£0.0M`이 되고, 천으로 고정하면 이적료가
 * `£12000k`가 되어 그대로 모델의 컨텍스트에 들어간다. 그 경계가 여기서 지켜진다.
 */
describe("돈의 눈금", () => {
  it("백만 아래는 천 단위로 읽는다 — 백만 눈금이었다면 £0.0M이 될 값들이다", () => {
    expect(formatMoney(40_000)).toBe("£40k");
    expect(formatMoney(120_000)).toBe("£120k");
    expect(formatMoney(725_000)).toBe("£725k");
  });

  it("백만부터는 백만 단위다 — 이적료가 £12000k로 서지 않는다", () => {
    expect(formatMoney(1_000_000)).toBe("£1.0M");
    expect(formatMoney(1_250_000)).toBe("£1.3M");
    expect(formatMoney(48_000_000)).toBe("£48.0M");
  });

  it("눈금은 부호가 아니라 크기가 고른다", () => {
    expect(formatMoney(-40_000)).toBe("£-40k");
    expect(formatMoney(-2_000_000)).toBe("£-2.0M");
  });
});

describe("스카우트 보고서 표시 호환성", () => {
  it("옛 세이브의 숫자 종합과 잠재력을 그대로 읽는다", () => {
    expect(scoutValue(81)).toBe(81);
    expect(scoutValue(94)).toBe(94);
    expect(scoutMargin(81)).toBe(0);
  });

  it("새 보고서의 등급 객체에서는 숫자와 오차만 꺼낸다", () => {
    const observed = { value: 82, label: "주전급", tier: "first", margin: 3 };
    expect(scoutValue(observed)).toBe(82);
    expect(scoutMargin(observed)).toBe(3);
  });

  /** 색 넷은 코어 등급 일곱을 묶은 것이다 — 경계가 코어와 어긋나면 여기서 잡힌다 */
  it("능력치 숫자를 코어 등급 경계에 맞춰 네 가지 색 구간으로 접는다", () => {
    expect([59, 60, 70, 78, 85, 90].map(ratingTone)).toEqual([
      "low",
      "solid",
      "solid",
      "strong",
      "top",
      "top",
    ]);
  });
});
