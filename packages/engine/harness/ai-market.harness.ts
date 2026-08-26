import { describe, expect, it } from "vitest";
import { isPrecontractTarget, isTopFlight } from "@story-fm/engine";
import { createTestGame } from "../test/helpers";
import { AI_MARKET } from "./catalog";
import { playSeason } from "./season";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * 한 시즌의 **시장 규모** — 시장이 도는지는 `packages/engine/test/ai-market.test.ts`가
 * 보고, 여기서는 그 양이 실제 시장과 같은 자릿수인지를 본다.
 *
 * 우리 선수에게 선 **관심**도 같은 시즌에서 잰다 (transfer.md §1-2) — 사다리의 세
 * 칸이 하나로 이어져 있는지는 시즌을 다 돌려야 보인다: 관심이 몇 건 서고, 그중
 * 몇이 밖에 나고, 그중 몇에 값이 붙는가.
 *
 *   pnpm balance ai-market
 */

/** 여름 창이 닫히는 날 — 겨울과 가르는 경계 */
const WINDOW_CLOSE = "2026-09-05";

/** 관심 한 건의 열쇠 — 구단 × 선수 × 선 날. 같은 짝이 시즌에 두 번 서면 두 건이다 */
const interestKey = (teamId: string, playerId: string, since: string) =>
  [teamId, playerId, since].join("|");

/** 구단 × 선수 — 관심 줄과 도착한 오퍼를 견주는 자리 */
const pairKey = (teamId: string | null | undefined, playerId: string) =>
  [teamId ?? "", playerId].join("|");

describe("한 시즌의 시장 규모", () => {
  it("시드 7", () => {
    const state = createTestGame(7);

    /**
     * 관심은 **지나가는 동안 센다** — 오퍼가 되면 그 줄이 걷히고 창이 닫히면 오른
     * 칸이 내려가므로, 시즌 끝의 장부는 아무것도 말하지 않는다.
     */
    const stood = new Map<string, { pair: string; stage: string }>();
    /**
     * **AI가 우리 선수에게 건 예약**도 같은 이유로 지나가는 동안 센다 (§1-4) —
     * 시즌 전환에서 발효하며 `pending`이 사라지므로 시즌 끝의 장부는 아무것도
     * 말하지 않는다.
     */
    const reserved = new Set<string>();
    /** 창 안의 타 구단 선수 — 한 날의 사진이라 1월 1일에 한 번만 찍는다 */
    let inWindow = 0;
    let snapped = false;
    playSeason(state, undefined, (s) => {
      for (const row of s.interests ?? []) {
        const key = interestKey(row.teamId, row.gamePlayerId, row.since);
        const seen = stood.get(key)?.stage;
        // 가장 높이 오른 칸만 남긴다 — 창이 닫혀 내려간 칸이 오른 사실을 지우지는 않는다
        if (seen === "bidding" || (seen === "enquired" && row.stage === "watching")) continue;
        stood.set(key, { pair: pairKey(row.teamId, row.gamePlayerId), stage: row.stage });
      }
      for (const contract of s.contracts) {
        if (contract.status !== "pending") continue;
        const player = s.players.find((p) => p.id === contract.gamePlayerId);
        if (player?.teamId !== s.userTeamId) continue;
        reserved.add(contract.id);
      }
      // 계약은 6월 30일에 끝나므로 1월 1일이면 창은 언제나 열려 있다 (§1-4)
      if (!snapped && s.date.endsWith("-01-01")) {
        snapped = true;
        inWindow = s.players.filter((p) => isPrecontractTarget(s, p)).length;
      }
    });

    const clubs = state.teams.filter((t) => isTopFlight(t.id)).length;
    const moves = state.transfers.filter(
      (t) => t.fromTeamId !== state.userTeamId && t.toTeamId !== state.userTeamId,
    );
    const incoming = state.negotiations.filter(
      (n) => n.kind === "sell" && n.rounds[0]?.by === "them",
    );

    const interests = [...stood.values()];
    const announced = interests.filter((i) => i.stage !== "watching");
    /**
     * **값이 붙은 관심** — 밖에 난 관심(`enquired` 이상) 가운데 그 구단이 실제로
     * 오퍼를 넣은 짝. `bidding`으로 세지 않는 이유는 그 칸이 **하루도 안 남을 수
     * 있어서**다: 같은 tick에서 칸이 오르고 값이 붙으면 하루 한 번 보는 이 자로는
     * 그 칸을 영영 못 본다.
     *
     * 도착한 오퍼 전부로 세면 안 된다 — 이적 요청 갈래(§1-1)가 섞여 전환율이 1을
     * 넘는다.
     */
    const offered = new Set(incoming.map((n) => pairKey(n.counterpartTeamId, n.gamePlayerId)));
    const converted = announced.filter((i) => offered.has(i.pair)).length;

    const readings: Readings<typeof AI_MARKET> = {
      "총 이동": moves.length,
      "1부 팀당 이적": moves.filter((t) => t.type === "transfer").length / clubs,
      "1부 팀당 임대": moves.filter((t) => t.type === "loan").length / clubs,
      "여름 비중": moves.filter((t) => t.date < WINDOW_CLOSE).length / Math.max(1, moves.length),
      "우리 선수 관심": interests.length,
      "문의까지 오른 비중": announced.length / Math.max(1, interests.length),
      "오퍼가 된 비중": converted / Math.max(1, interests.length),
      "우리에게 온 오퍼": incoming.length,
      "AI 사전 계약": reserved.size,
      "사전 계약 창 선수": inWindow,
    };
    console.log(reportOf(AI_MARKET, readings, `시드 7 · 1부 ${clubs}개 구단`));
    expect(outOfBand(AI_MARKET, readings)).toEqual([]);
  });
});
