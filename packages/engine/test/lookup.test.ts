import { describe, expect, it } from "vitest";
import {
  advanceTime,
  assignmentsOf,
  leagueView,
  playerById,
  playerCard,
  playersOf,
  scheduleView,
  scoutPlayer,
  searchPlayers,
  setTraining,
  squadView,
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
function leaksTrueRatings(
  message: string,
  playerId: string,
  attrs: Record<string, number>,
): boolean {
  const row = message.split("\n").find((l) => l.includes(playerId));
  if (!row) return false;
  const scrubbed = row
    .replace(new RegExp(playerId, "g"), "")
    .replace(/\d+세/g, "")
    .replace(/출전\d+/g, "")
    .replace(/득점\d+/g, "")
    .replace(/~\d{4}-\d{2}-\d{2}/g, "");
  const keys = ["pace", "finishing", "passing", "dribbling", "tackling", "strength"] as const;
  return keys.some((k) => new RegExp(`\\b${attrs[k]}\\b`).test(scrubbed));
}

/**
 * 결과에 실린 선수 id를 **순서대로**. 행이 라벨만 보여도 순서는 정렬 키를 말하므로,
 * 안개가 새는지는 값이 아니라 이 순서를 봐야 보인다 (player.md §10).
 */
function rowIds(message: string, pool: ReadonlyArray<{ id: string }>): string[] {
  const known = new Set(pool.map((p) => p.id));
  return message
    .split("\n")
    .map((l) => l.trim().split(" ")[0] ?? "")
    .filter((id) => known.has(id));
}

describe("search_players", () => {
  it("우리 팀은 정확한 수치를 준다", () => {
    const state = createTestGame(21);
    const res = searchPlayers(state, { team: "mine", limit: 5 });
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/OVR\d+/);
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

  it("타 팀은 참값 순서로 줄을 세우지 않는다 — 같은 질문엔 같은 답", () => {
    const state = createTestGame(21);
    const pool = playersOf(state, "chelsea");
    const res = searchPlayers(state, { team: "chelsea", limit: 15 });
    const shown = rowIds(res.message, pool);
    expect(shown).toHaveLength(15);
    const byTruth = [...pool]
      .sort((a, b) => b.attributes.overall - a.attributes.overall)
      .slice(0, 15)
      .map((p) => p.id);
    expect(shown).not.toEqual(byTruth);
    // 오차는 (seed, playerId, 축) 해시라 순서가 호출마다 흔들리지 않는다
    expect(rowIds(searchPlayers(state, { team: "chelsea", limit: 15 }).message, pool)).toEqual(
      shown,
    );
  });

  it("체력 정렬은 우리 선수만 참값 순이다 — 타 팀은 읽은 값으로 세운다", () => {
    const state = createTestGame(21);
    const ours = playersOf(state, state.userTeamId);
    const theirs = playersOf(state, "chelsea");
    // 전원이 같은 값이면 무엇으로 세우든 순서가 같아 보인다 — 값을 갈라 둔다
    ours.forEach((p, i) => (p.state.condition = 100 - i * 2));
    theirs.forEach((p, i) => (p.state.condition = 100 - i * 2));
    const byCondition = (pool: ReadonlyArray<(typeof ours)[number]>) =>
      [...pool]
        .sort((a, b) => a.state.condition - b.state.condition)
        .slice(0, 15)
        .map((p) => p.id);

    const mine = searchPlayers(state, { team: "mine", sortBy: "fatigue", limit: 15 });
    expect(rowIds(mine.message, ours)).toEqual(byCondition(ours));
    const other = searchPlayers(state, { team: "chelsea", sortBy: "fatigue", limit: 15 });
    expect(rowIds(other.message, theirs)).not.toEqual(byCondition(theirs));
  });

  it("팀 이름 표기가 흔들려도 해석하고, 없는 팀만 반려한다", () => {
    const state = createTestGame(21);
    // 공백 없는 표기도 카탈로그("레알 마드리드")에 닿는다
    expect(searchPlayers(state, { team: "레알마드리드" }).ok).toBe(true);
    expect(searchPlayers(state, { team: "맨유" }).ok).toBe(true);
    const missing = searchPlayers(state, { team: "존재하지않는팀" });
    expect(missing.ok).toBe(false);
    // 모호하면 조용히 비우지 말고 후보를 준다
    const ambiguous = searchPlayers(state, { team: "맨체스터" });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.message).toContain("여러 팀");
  });
});

describe("playerCard — 선수 상세", () => {
  it("우리 선수는 능력치·컨디션·계약·전술까지 전부 준다", () => {
    const state = createTestGame(22);
    const mine = userPlayers(state)[0]!;
    const res = playerCard(state, mine.id);
    expect(res.ok).toBe(true);
    expect(res.message).toContain(`${mine.attributes.pace}`);
    // 잠재력은 숫자 하나가 아니라 구간이다 (우리 선수도 단정 못 한다)
    expect(res.message).toMatch(/잠재력: \d+~\d+/);
  });

  it("타 팀 선수는 라벨·인상만 주고 참값·잠재력을 감춘다", () => {
    const state = createTestGame(22);
    const other = playersOf(state, "chelsea")[0]!;
    const res = playerCard(state, other.id);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("잠재력: 미지");
    expect(leaksTrueRatings(res.message, other.id, other.attributes)).toBe(false);
  });

  it("스카우팅을 마치면 오차가 좁혀지지만 여전히 라벨로 말한다", () => {
    const state = createTestGame(22);
    const other = playersOf(state, "chelsea")[0]!;
    scoutPlayer(state, other.id);
    advanceTime(state, { days: SCOUT_DAYS });
    const res = playerCard(state, other.id);
    expect(res.message).toContain("스카우팅 완료");
    // 우리 선수가 아니면 숫자를 주지 않는다 — 오차가 ±1이라도 단정하지 않는다
    expect(leaksTrueRatings(res.message, other.id, other.attributes)).toBe(false);
    // 스카우트 한 번은 잠재력을 "대강 짐작" 수준까지만 열어 준다
    expect(res.message).toMatch(/잠재력: \d+~\d+ \(대강 짐작/);
  });

  it("없는 id는 반려한다", () => {
    const state = createTestGame(22);
    expect(playerCard(state, "nope").ok).toBe(false);
  });
});

describe("get_team · get_league", () => {
  it("팀 프로필은 순위·전술·주력 선수를 주고, 타 팀엔 안개를 적용한다", () => {
    const state = createTestGame(23);
    const res = teamProfile(state, "chelsea");
    expect(res.ok).toBe(true);
    expect(res.message).not.toMatch(/OVR\d+/);
  });

  it("타 팀 주력 선수는 참값 상위 6이 아니다 — 고르는 것도 노출이다", () => {
    const state = createTestGame(23);
    const starting = assignmentsOf(state, "chelsea", "starting")
      .map((a) => playerById(state, a.playerId))
      .filter((p) => p !== null);
    const byTruth = [...starting]
      .sort((a, b) => b.attributes.overall - a.attributes.overall)
      .slice(0, 6)
      .map((p) => p.id);
    expect(rowIds(teamProfile(state, "chelsea").message, starting)).not.toEqual(byTruth);
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
    expect(res.message).toContain("←우리");
    expect(res.message.split("\n")).toHaveLength(21); // 헤더 + 20팀
  });

  it("일정은 지난 결과와 예정 경기를 함께 준다", () => {
    const state = createTestGame(23);
    const res = leagueView(state, { view: "fixtures", count: 3 });
    expect(res.ok).toBe(true);
    // 날짜·요일·킥오프·대회·홈원정이 한 줄에 — "R1"만으로는 언제인지 답할 수 없다.
    // 라운드는 대회가 있는 경기만 갖는다(친선은 단계가 없다)
    expect(res.message).toMatch(
      /예정 \d{4}-\d{2}-\d{2}\([일월화수목금토]\) \d{2}:\d{2} \S+ (홈|원정|중립) vs /,
    );
  });

  it("순위표는 다른 리그·대항전도 볼 수 있고, 없는 대회는 반려한다", () => {
    const state = createTestGame(23);
    const laliga = leagueView(state, { view: "standings", competition: "laliga" });
    expect(laliga.ok).toBe(true);
    expect(laliga.message).toContain("라리가");
    expect(laliga.message).not.toContain("←우리"); // 우리 팀은 EPL 소속
    // 팀만 줘도 그 팀의 리그 표를 본다
    expect(leagueView(state, { view: "standings", team: "유벤투스" }).message).toContain("세리에");
    const bad = leagueView(state, { view: "standings", competition: "K리그" });
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("찾지 못했습니다");
  });
});

/**
 * 일정 검색 — 감독은 "다음 맨유전", "토트넘과 지난 맞대결"처럼 **특정 경기**를
 * 묻는다. 가까운 N경기만 보여주는 창으로는 답할 수 없어야 하는 질문들.
 */
describe("get_league — 일정 검색", () => {
  /** 두 팀이 맞붙는 경기 (리그 2경기 + 대항전에서 만나면 더) */
  const meetings = (state: ReturnType<typeof createTestGame>, a: string, b: string) =>
    state.matches.filter(
      (m) =>
        (m.homeTeamId === a && m.awayTeamId === b) || (m.homeTeamId === b && m.awayTeamId === a),
    );
  const fixtureLines = (message: string) =>
    message.split("\n").filter((l) => l.startsWith("  지난") || l.startsWith("  예정"));

  it("상대를 지정하면 맞대결만 주고 전적을 요약한다", () => {
    const state = createTestGame(23);
    const derbies = meetings(state, "arsenal", "tottenham");
    expect(derbies.length).toBeGreaterThanOrEqual(2);
    const first = derbies.sort((a, b) => (a.date < b.date ? -1 : 1))[0]!;
    const arsenalHome = first.homeTeamId === "arsenal";
    first.result = {
      homeGoals: arsenalHome ? 3 : 1,
      awayGoals: arsenalHome ? 1 : 2,
      scorers: [`${arsenalHome ? "home" : "away"}:${playersOf(state, "arsenal")[0]!.id}`],
    };

    const res = leagueView(state, { view: "fixtures", opponent: "토트넘" });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("1승 0무 0패");
    expect(res.message).toContain(playersOf(state, "arsenal")[0]!.name); // 득점자
    const lines = fixtureLines(res.message);
    expect(lines).toHaveLength(derbies.length);
    for (const line of lines) expect(line).toMatch(/TOT|토트넘/);
  });

  it("when=upcoming은 예정만, past는 지난 경기만 준다", () => {
    const state = createTestGame(24);
    const round1 = state.matches.filter((m) => m.competitionId === "epl" && m.round === 1);
    for (const m of round1) m.result = { homeGoals: 1, awayGoals: 0, scorers: [] };

    const upcoming = leagueView(state, { view: "fixtures", when: "upcoming", count: 3 });
    expect(fixtureLines(upcoming.message).every((l) => l.startsWith("  예정"))).toBe(true);
    expect(fixtureLines(upcoming.message)).toHaveLength(3);

    const past = leagueView(state, { view: "fixtures", when: "past" });
    const pastLines = fixtureLines(past.message);
    expect(pastLines.every((l) => l.startsWith("  지난"))).toBe(true);
    expect(pastLines).toHaveLength(1); // 1라운드만 치렀다
  });

  it("team=all + round는 그 라운드 전체 경기를 준다", () => {
    const state = createTestGame(24);
    const res = leagueView(state, { view: "fixtures", team: "all", round: 3, count: 20 });
    expect(res.ok).toBe(true);
    expect(fixtureLines(res.message)).toHaveLength(10); // EPL 20팀 → 라운드당 10경기
  });

  it("날짜 범위와 대회로 좁힌다", () => {
    const state = createTestGame(24);
    const res = leagueView(state, {
      view: "fixtures",
      competition: "epl",
      from: "2026-09-01",
      to: "2026-09-30",
      count: 20,
    });
    expect(res.ok).toBe(true);
    for (const line of fixtureLines(res.message)) expect(line).toContain("2026-09-");
  });

  it("약칭을 해석하고, 모호하거나 없는 이름은 반려한다", () => {
    const state = createTestGame(24);
    const next = leagueView(state, {
      view: "fixtures",
      opponent: "맨유",
      when: "upcoming",
      count: 1,
    });
    expect(next.ok).toBe(true);
    expect(next.message).toContain("맨체스터 유나이티드");
    expect(fixtureLines(next.message)).toHaveLength(1);

    const ambiguous = leagueView(state, { view: "fixtures", opponent: "맨체스터" });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.message).toContain("여러 팀");
    expect(leagueView(state, { view: "fixtures", opponent: "존재하지않는팀" }).ok).toBe(false);
  });

  it("절단된 경기 수를 조용히 숨기지 않는다", () => {
    const state = createTestGame(24);
    const res = leagueView(state, { view: "fixtures", when: "upcoming", count: 2 });
    expect(res.message).toMatch(/더 뒤의 예정 경기 \d+건/);
  });
});

/**
 * get_squad — **현재 배치**를 읽는 자리. 컨텍스트엔 선수단 이름뿐이고 search_players는
 * 상한이 15명이라, 이 도구가 없으면 "지금 누가 선발인지"를 알 방법이 없다.
 */
describe("get_squad", () => {
  it("선발·벤치·예비를 나누고 자리 적합도까지 준다", () => {
    const state = createTestGame(31);
    const res = squadView(state);
    expect(res.ok).toBe(true);
    // 배치 인원이 요약과 목록 양쪽에서 일치한다
    expect(res.message).toMatch(/── 선발 11명 ──/);
    // 골키퍼가 첫 줄 — 전술판 좌표 순(골문→공격, 왼쪽→오른쪽)으로 읽힌다
    const rows = res.message.split("\n").filter((l) => l.startsWith("  "));
    expect(rows[0]).toMatch(/^ {2}GK/);
    expect(rows).toHaveLength(userPlayers(state).filter((p) => p.squadLevel !== "reserve").length);
  });

  it("level=reserve는 2군만, role=starting은 선발만 준다", () => {
    const state = createTestGame(31);
    const reserve = squadView(state, { level: "reserve" });
    const reserveCount = userPlayers(state).filter((p) => p.squadLevel === "reserve").length;
    expect(reserve.message.split("\n").filter((l) => l.startsWith("  "))).toHaveLength(
      reserveCount,
    );

    const starting = squadView(state, { role: "starting" });
    expect(starting.message).not.toContain("── 벤치");
    expect(starting.message.split("\n").filter((l) => l.startsWith("  "))).toHaveLength(11);
  });

  it("부상·정지·경고 임박·불만을 배치 줄에 표시한다", () => {
    const state = createTestGame(31);
    const starter = userPlayers(state).find((p) => p.squadLevel !== "reserve")!;
    for (let i = 0; i < 4; i++) {
      state.bookings.push({
        gamePlayerId: starter.id,
        matchId: `m${i}`,
        season: state.season,
        card: "yellow",
        minute: 20,
      });
    }
    state.injuries.push({
      id: "inj-x",
      gamePlayerId: starter.id,
      bodyPart: "발목",
      severity: "minor",
      cause: "training",
      occurredOn: state.date,
      expectedReturn: "2026-08-10",
      returnedOn: null,
    });
    const res = squadView(state, { level: "all" });
    const row = res.message.split("\n").find((l) => l.includes(starter.id))!;
    expect(row).toContain("부상(발목");
    expect(row).toContain("정지 임박");
  });
});

describe("search_players — 대상 범위", () => {
  it("competition으로 한 리그만 뒤진다", () => {
    const state = createTestGame(32);
    const epl = searchPlayers(state, { competition: "epl", position: "ST", limit: 5 });
    expect(epl.ok).toBe(true);
    // 다른 리그 선수가 섞이지 않는다 (id 접두사가 팀이다)
    for (const line of epl.message.split("\n").slice(1)) {
      if (!line.startsWith("…"))
        expect(line).not.toMatch(/^(realmadrid|barcelona|bayern|psg|inter)-/);
    }
  });

  it("없는 대회는 반려한다", () => {
    const state = createTestGame(32);
    expect(searchPlayers(state, { competition: "K리그" }).ok).toBe(false);
  });
});

describe("scheduleView — 감독의 달력", () => {
  it("경기·훈련·이적창을 한 축에 날짜순으로 놓는다", () => {
    const state = createTestGame(33);
    const applied = setTraining(state, {
      repeatWeekly: [{ dow: 2, slot: "am", label: "고강도 압박", focus: ["stamina", "tactical"] }],
      weeks: 2,
    });
    expect(applied.ok).toBe(true);

    const res = scheduleView(state, { days: 20 });
    expect(res.ok).toBe(true);
    // 등록한 훈련이 달력에 실린다 (setTraining → 일정)
    expect(res.message).toContain("고강도 압박");
    // 날짜 오름차순
    const dates = res.message
      .split("\n")
      .slice(1)
      .map((l) => l.trim().slice(0, 10));
    expect([...dates].sort()).toEqual(dates);
  });

  it("type으로 좁히고, 빈 기간은 그렇다고 말한다", () => {
    const state = createTestGame(33);
    setTraining(state, {
      repeatWeekly: [{ dow: 2, slot: "am", label: "회복", focus: ["recovery"] }],
      weeks: 1,
    });
    const training = scheduleView(state, { type: "training", days: 14 });
    for (const line of training.message.split("\n").slice(1)) expect(line).toContain("훈련");
  });

  it("우리 팀 경기만 달력에 올린다 (리그 타 팀 경기는 get_league의 몫)", () => {
    const state = createTestGame(33);
    const res = scheduleView(state, {
      type: "match",
      from: "2026-08-01",
      to: "2026-10-31",
      limit: 60,
    });
    for (const line of res.message.split("\n").slice(1)) {
      expect(line).toMatch(/홈 vs|원정 vs|중립 vs/);
    }
  });
});

describe("이력·폼", () => {
  it("선수 카드는 부상 이력과 경고 누적을 준다", () => {
    const state = createTestGame(35);
    const p = userPlayers(state)[0]!;
    state.injuries.push({
      id: "inj-1",
      gamePlayerId: p.id,
      bodyPart: "햄스트링",
      severity: "moderate",
      cause: "match",
      occurredOn: "2026-03-02",
      expectedReturn: "2026-04-01",
      returnedOn: "2026-03-28",
    });
    for (let i = 0; i < 4; i++) {
      state.bookings.push({
        gamePlayerId: p.id,
        matchId: `m${i}`,
        season: state.season,
        card: "yellow",
        minute: 20,
      });
    }
    const res = playerCard(state, p.id);
    expect(res.message).toContain("부상 이력: 총 1회");
    expect(res.message).toContain("누적 결장 26일"); // 03-02 → 03-28
    expect(res.message).toContain("경고 4장");
    expect(res.message).toContain("경고 1장 더 받으면 출장 정지");
  });

  it("순위표에 최근 5경기 폼이 붙는다", () => {
    const state = createTestGame(35);
    const ours = state.matches
      .filter((m) => m.competitionId === "epl" && [m.homeTeamId, m.awayTeamId].includes("arsenal"))
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .slice(0, 3);
    for (const m of ours) {
      const home = m.homeTeamId === "arsenal";
      m.result = { homeGoals: home ? 2 : 0, awayGoals: home ? 0 : 2, scorers: [] };
    }
    const res = leagueView(state, { view: "standings" });
    const ourRow = res.message.split("\n").find((l) => l.includes("←우리"))!;
    expect(ourRow).toContain("폼 승승승");
  });
});
