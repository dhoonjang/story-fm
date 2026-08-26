import { describe, expect, it } from "vitest";
import {
  DEMOTION_PATIENCE_DAYS,
  advanceTime,
  demotionPatienceDaysOf,
  diffDays,
  groupOf,
  seasonStatOf,
  setSquadLevel,
  squadLevelOf,
  userPlayers,
} from "@story-fm/engine";
import { createMiniGame, drillUserTactics, keepSeat, playMockMatch } from "../test/helpers";
import { DEMOTION_GRIEVANCE } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * 2군 강등의 문턱이 **로테이션과 방치를 가르는가** (→ `docs/data/people.md` §5).
 *
 *   pnpm balance demotion-grievance
 *
 * 한 시즌 동안 감독 둘을 동시에 흉내 낸다: 핵심 셋을 내려 두고 잊는 감독과, 열흘
 * 안에 반드시 되돌리는 감독. 문턱이 낮으면 뒤쪽이 반란을 맞고, 높으면 앞쪽조차
 * 조용하다. 어느 쪽인지는 시즌을 굴려야 보인다.
 */

/** 내려 두고 잊는 인원 — 스쿼드 하한을 건드리지 않는 선에서 가장 작은 표본 */
const NEGLECTED = 3;

/** 로테이션 감독이 선수를 되돌리는 기한 — 문턱보다 확실히 짧다 */
const ROTATION_RETURN_DAYS = 10;

/**
 * 감독이 선수단을 들여다보는 주기 — **경기일에만 보면 로테이션을 잴 수 없다.**
 * 축소 세계는 리그전 열넷을 한 해에 흩뿌리므로 경기 간격이 3~4주까지 벌어진다.
 * 그 간격으로 되돌리면 그것은 로테이션이 아니라 방치다.
 */
const ROTATION_CHECK_DAYS = 7;

/** 시즌 하나를 못 끝내면 측정이 아니다 */
const ADVANCE_LIMIT = 400;

describe("한 시즌의 2군 강등", () => {
  it("시드 42 · 축소 세계", () => {
    const state = createMiniGame(42);
    keepSeat(state);

    /** 종합 순으로 — 위쪽이 핵심 자원이다 */
    const byOverall = () =>
      [...userPlayers(state)].sort((a, b) => b.attributes.overall - a.attributes.overall);

    // ── 감독 ①: 핵심 셋을 내려 두고 잊는다 ──
    const neglected = new Map<string, string>(); // id → 내린 날
    for (const player of byOverall().slice(0, NEGLECTED)) {
      if (!setSquadLevel(state, { playerId: player.id, level: "reserve" }).ok) continue;
      neglected.set(player.id, state.date);
    }

    // ── 감독 ②: 로테이션 — 덜 뛴 자원을 내렸다가 열흘 안에 되돌린다 ──
    const rotated = new Set<string>();
    let rotations = 0;
    let returnFailures = 0;

    function rotate(): void {
      for (const player of userPlayers(state)) {
        if (!rotated.has(player.id)) continue;
        if (squadLevelOf(player) !== "reserve") continue;
        const since = player.state.demotedOn;
        if (since && diffDays(since, state.date) < ROTATION_RETURN_DAYS) continue;
        if (!setSquadLevel(state, { playerId: player.id, level: "first" }).ok) returnFailures += 1;
      }
      const down = byOverall()
        .filter(
          (p) =>
            squadLevelOf(p) === "first" &&
            !neglected.has(p.id) &&
            !rotated.has(p.id) &&
            groupOf(p) !== "GK",
        )
        .sort(
          (a, b) => (seasonStatOf(state, a.id)?.apps ?? 0) - (seasonStatOf(state, b.id)?.apps ?? 0),
        )[0];
      if (!down) return;
      if (!setSquadLevel(state, { playerId: down.id, level: "reserve" }).ok) return;
      rotated.add(down.id);
      rotations += 1;
    }

    /**
     * 불만은 **걸린 순간을 잡아야 한다** — 승격이 지우므로 시즌 끝에 세면
     * 로테이션이 낳은 불만이 통째로 사라진다.
     */
    const grieved = new Map<string, string>(); // id → 걸린 날
    /**
     * 강등 밴드의 분모를 흔드는 이웃 — **먼저 걸린 불만은 다음 불만을 막는다**
     * (people.md §5). 지위 대비 출전이 낳는 `minutes` 불만이 로테이션 자원에 먼저
     * 걸리면 그 선수의 강등 불만은 영영 서지 않으므로, 같은 자리에서 함께 센다.
     */
    const otherGrieved = new Map<string, Set<string>>();
    function sample(): void {
      for (const issue of state.issues) {
        if (issue.reason === "minutes" || issue.reason === "promise") {
          const seen = otherGrieved.get(issue.reason) ?? new Set<string>();
          seen.add(`${issue.gamePlayerId}:${issue.since}`);
          otherGrieved.set(issue.reason, seen);
          continue;
        }
        if (issue.reason !== "demotion") continue;
        if (!grieved.has(issue.gamePlayerId)) grieved.set(issue.gamePlayerId, issue.since);
      }
    }

    let finished = false;
    for (let i = 0; i < ADVANCE_LIMIT; i++) {
      let advanced = advanceTime(state, { days: ROTATION_CHECK_DAYS });
      if (!advanced.ok) throw new Error(advanced.digest.join(" / "));
      // 안 치른 경기가 시계를 막으면 그 경기까지 간다
      if (advanced.stopped === "blocked") {
        advanced = advanceTime(state, "next_match");
        if (!advanced.ok) throw new Error(advanced.digest.join(" / "));
      }
      sample();
      if (advanced.stopped === "season_end") {
        finished = true;
        break;
      }
      if (advanced.stopped === "blocked") break;
      if (advanced.stopped === "matchday") {
        drillUserTactics(state, 7);
        playMockMatch(state);
        sample();
      }
      rotate();
    }
    expect(finished).toBe(true);

    const neglectedGrieved = [...grieved.keys()].filter((id) => neglected.has(id));
    const waits = neglectedGrieved.map((id) => diffDays(neglected.get(id)!, grieved.get(id)!));
    const firstWait = Math.min(...waits);
    /**
     * 문턱은 이제 **그 사람의 것**이다 (people.md §6) — 날짜로 재면 밴드가 원형 추첨을
     * 따라간다. 대신 각자의 문턱을 넘고 실제로 걸리기까지 밀린 날을 잰다: 판정이
     * 주에 한 번이라 0~6일이고, 음수면 문턱을 지키지 않고 걸린 것이다.
     */
    const patienceOf = (id: string) =>
      demotionPatienceDaysOf(
        state,
        userPlayers(state).find((p) => p.id === id)!,
      );
    const thresholds = [...neglected.keys()].map(patienceOf);
    const slack = neglectedGrieved.map(
      (id) => diffDays(neglected.get(id)!, grieved.get(id)!) - patienceOf(id),
    );

    const readings: Readings<typeof DEMOTION_GRIEVANCE> = {
      "로테이션 강등 횟수": rotations,
      "로테이션 복귀 실패": returnFailures,
      "로테이션 자원에 걸린 불만": [...grieved.keys()].filter((id) => rotated.has(id)).length,
      "방치한 핵심 자원": neglected.size,
      "방치 끝에 불만이 걸린 수": neglectedGrieved.length,
      "첫 방치 불만까지 걸린 날": Number.isFinite(firstWait) ? firstWait : Number.NaN,
      "방치 자원의 문턱 폭": Math.max(...thresholds) - Math.min(...thresholds),
      "제 문턱을 넘고 밀린 날": slack.length > 0 ? Math.max(...slack) : Number.NaN,
      "시즌 강등발 불만 건수": grieved.size,
      "시즌 출전 불만 건수": otherGrieved.get("minutes")?.size ?? 0,
      "시즌 약속 파기 건수": otherGrieved.get("promise")?.size ?? 0,
    };
    console.log(
      reportOf(
        DEMOTION_GRIEVANCE,
        readings,
        `시드 42 · 기준 문턱 ${DEMOTION_PATIENCE_DAYS}일(원형 배수 전) · 방치 셋의 문턱 ${thresholds
          .slice()
          .sort((a, b) => a - b)
          .join("·")}일 · 복귀 ${ROTATION_RETURN_DAYS}일 · ${state.date}`,
      ),
    );
    expect(outOfBand(DEMOTION_GRIEVANCE, readings)).toEqual([]);
  });
});
