import { describe, expect, it } from "vitest";
import {
  advanceTime,
  leagueView,
  playerCard,
  playersOf,
  scoutPlayer,
  searchPlayers,
  teamProfile,
  userPlayers,
} from "@story-fm/engine";
import { SCOUT_DAYS } from "@story-fm/domain";
import { createTestGame } from "./helpers";

/**
 * 읽기 전용 조회 — GM이 컨텍스트 대신 온디맨드로 부르는 도구의 엔진 구현.
 * 가장 중요한 검증: **타 팀 선수의 참값 수치가 새어나가지 않는다.**
 */

/**
 * 그 선수 행에 참값 능력치가 새어나갔는가 — 나이·출전·득점처럼 **공개해도 되는**
 * 숫자는 먼저 지우고 남은 숫자만 본다 (안 지우면 나이와 능력치가 우연히 겹쳐 오탐).
 */
function leaksTrueRatings(message: string, playerId: string, attrs: Record<string, number>): boolean {
  const row = message.split("\n").find((l) => l.includes(playerId));
  if (!row) return false;
  const scrubbed = row
    .replace(new RegExp(playerId, "g"), "")
    .replace(/\d+세/g, "")
    .replace(/출전\d+/g, "")
    .replace(/득점\d+/g, "")
    .replace(/~\d{4}-\d{2}-\d{2}/g, "");
  const keys = ["pace", "shooting", "passing", "dribbling", "defending", "physical"] as const;
  return keys.some((k) => new RegExp(`\\b${attrs[k]}\\b`).test(scrubbed));
}

describe("search_players", () => {
  it("우리 팀은 정확한 수치를 준다", () => {
    const state = createTestGame(21);
    const res = searchPlayers(state, { team: "mine", limit: 5 });
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/OVR\d+/);
    expect(res.message).toContain("피로");
  });

  it("리그 전체 검색에서 타 팀 선수는 서술만, 능력치 숫자는 없다", () => {
    const state = createTestGame(21);
    const target = playersOf(state, "chelsea")[0]!;
    const res = searchPlayers(state, { team: "chelsea", limit: 15 });
    expect(res.ok).toBe(true);
    expect(res.message).not.toMatch(/OVR\d+/);
    expect(leaksTrueRatings(res.message, target.id, target.attributes)).toBe(false);
  });

  it("포지션·나이·이름 필터와 상한이 걸린다", () => {
    const state = createTestGame(21);
    const gk = searchPlayers(state, { team: "mine", position: "GK" });
    expect(gk.message).toContain("GK");

    const young = searchPlayers(state, { maxAge: 20, limit: 3 });
    expect(young.ok).toBe(true);
    // 상한을 넘으면 남은 인원을 알려준다 (조용한 절단 금지)
    expect(young.message).toMatch(/그 외 \d+명/);

    const none = searchPlayers(state, { team: "mine", name: "존재하지않는이름" });
    expect(none.message).toContain("조건에 맞는 선수가 없습니다");
  });

  it("없는 팀은 반려한다", () => {
    const state = createTestGame(21);
    const res = searchPlayers(state, { team: "레알마드리드" });
    expect(res.ok).toBe(false);
  });
});

describe("get_player", () => {
  it("우리 선수는 능력치·컨디션·계약·전술까지 전부 준다", () => {
    const state = createTestGame(22);
    const mine = userPlayers(state)[0]!;
    const res = playerCard(state, mine.id);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("우리 선수");
    expect(res.message).toContain(`${mine.attributes.pace}`);
    expect(res.message).toContain("POT");
    expect(res.message).toContain("계약");
  });

  it("타 팀 선수는 라벨·인상만 주고 참값·잠재력을 감춘다", () => {
    const state = createTestGame(22);
    const other = playersOf(state, "chelsea")[0]!;
    const res = playerCard(state, other.id);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("평판");
    expect(res.message).toContain("오차");
    expect(res.message).toContain("강점");
    expect(res.message).not.toContain("POT");
    expect(leaksTrueRatings(res.message, other.id, other.attributes)).toBe(false);
  });

  it("스카우팅을 마치면 같은 선수가 정확한 수치로 바뀐다", () => {
    const state = createTestGame(22);
    const other = playersOf(state, "chelsea")[0]!;
    scoutPlayer(state, other.id);
    advanceTime(state, { days: SCOUT_DAYS });
    const res = playerCard(state, other.id);
    expect(res.message).toContain("스카우팅 완료");
    expect(res.message).toContain(`${other.attributes.pace}`);
    expect(res.message).not.toContain("POT"); // 잠재력은 여전히 미지
  });

  it("없는 id는 반려하고 검색을 안내한다", () => {
    const state = createTestGame(22);
    const res = playerCard(state, "nope");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("search_players");
  });
});

describe("get_team · get_league", () => {
  it("팀 프로필은 순위·전술·주력 선수를 주고, 타 팀엔 안개를 적용한다", () => {
    const state = createTestGame(23);
    const res = teamProfile(state, "chelsea");
    expect(res.ok).toBe(true);
    expect(res.message).toContain("팀 프로필");
    expect(res.message).toContain("전술");
    expect(res.message).toContain("우리와의 전적");
    expect(res.message).not.toMatch(/OVR\d+/);
  });

  it("우리 팀 프로필은 정확한 수치를 준다", () => {
    const state = createTestGame(23);
    const res = teamProfile(state, "mine");
    expect(res.message).toMatch(/OVR\d+/);
  });

  it("순위표는 20팀 전부와 우리 팀 표시를 준다", () => {
    const state = createTestGame(23);
    const res = leagueView(state, { view: "standings" });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("리그 순위");
    expect(res.message).toContain("←우리");
    expect(res.message.split("\n")).toHaveLength(21); // 헤더 + 20팀
  });

  it("일정은 지난 결과와 예정 경기를 함께 준다", () => {
    const state = createTestGame(23);
    const res = leagueView(state, { view: "fixtures", count: 3 });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("예정 R");
  });
});
