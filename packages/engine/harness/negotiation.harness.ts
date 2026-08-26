import { describe, expect, it } from "vitest";
import {
  AGENT_PROFILE,
  COUNTERPARTY_ACCEPT_AT,
  COUNTERPARTY_COUNTER_AT,
  activeContract,
  agentOfPlayer,
  askingPriceFor,
  dealOdds,
  isClubTeam,
  renewalExpectation,
  severanceOf,
  userPlayers,
  wageExpectationOf,
} from "@story-fm/engine";
import type { AgentArchetype } from "@story-fm/domain";
import { createTestGame } from "../test/helpers";
import { NEGOTIATION } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * 선수 개인 협상의 성사 확률이 **분포인가, 도장인가** (→ `docs/simulation/transfer.md` §3).
 *
 *   pnpm balance negotiation
 *
 * 세 갈래를 한 세계에서 잰다 — 우리 스쿼드 전원의 재계약·해지, 타 구단 선수 표본의
 * 영입. 제안은 전부 **기대치를 그대로 맞춘 것**이다: 재계약은 `renewalExpectation`
 * 주급에 3년, 해지는 `severanceOf` 정산금 일시금, 영입은 `askingPriceFor` 호가에
 * `wageExpectationOf` 주급으로 4년. 그 제안이 §3이 정한 출발점(관문 수와 무관하게
 * 같은 확률)이고, 거기서 선수마다 갈리는 폭이 곧 관문의 축들이 살아 있다는 증거다.
 * 기대치를 맞췄는데 전원이 90%를 넘으면 흥정이 없는 것이고, 폭이 없으면 축이 죽어
 * 있는 것이다. 어느 쪽인지는 규칙 테스트가 아니라 분포를 봐야 안다.
 *
 * 영입의 표시 확률은 스카우트 지식으로 흐려진다(`ODDS_MARGIN`). 여기서는 표본마다
 * 완료된 스카우트 보고서를 꽂아 안개를 걷고 **순수 곡선**만 잰다.
 */

/** 영입 표본의 종합 구간 — 우리가 실제로 사러 가는 선수들 */
const BUY_OVERALL_MIN = 66;
const BUY_OVERALL_MAX = 84;

/** 영입 표본 크기 — id 순으로 앞에서 자른다 */
const BUY_SAMPLE = 80;

/** 재계약 하한 제안 — 기대 주급의 이 비율 */
const RENEW_LOWBALL = 0.7;

/** 「사실상 통과」로 읽는 확률 */
const RUBBER_STAMP_AT = 90;

/** 최근접 순위 분위수 — 정렬된 배열에서 */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1]!;
}

function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

function spread(values: readonly number[]): number {
  return quantile(values, 0.9) - quantile(values, 0.1);
}

function shareOf(values: readonly number[], pick: (v: number) => boolean): number {
  if (values.length === 0) return Number.NaN;
  return values.filter(pick).length / values.length;
}

function sorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

describe("선수 개인 협상의 성사 확률 분포", () => {
  it("시드 42 · 아스날", () => {
    const state = createTestGame(42);

    // ── 재계약 · 해지: 계약이 살아 있는 우리 선수 전원 ──
    const ours = userPlayers(state).filter((p) => activeContract(state, p.id) !== null);
    const renewAtExpectation: number[] = [];
    const renewLowball: number[] = [];
    const releaseAtExpectation: number[] = [];
    for (const player of ours) {
      const expectation = renewalExpectation(state, player);
      renewAtExpectation.push(
        dealOdds(state, {
          playerId: player.id,
          fee: 0,
          weeklyWage: expectation,
          years: 3,
          kind: "renew",
        }).probability,
      );
      renewLowball.push(
        dealOdds(state, {
          playerId: player.id,
          fee: 0,
          weeklyWage: Math.round(expectation * RENEW_LOWBALL),
          years: 3,
          kind: "renew",
        }).probability,
      );
      // blockers(잔고 부족 등)는 확률과 무관하다 — 확률만 읽는다
      releaseAtExpectation.push(
        dealOdds(state, {
          playerId: player.id,
          fee: severanceOf(state, player.id),
          weeklyWage: 0,
          years: 0,
          kind: "release",
        }).probability,
      );
    }

    // ── 영입: 타 구단 소속 · 계약 있는 선수 표본 ──
    const targets = state.players
      .filter(
        (p) =>
          p.teamId !== state.userTeamId &&
          isClubTeam(p.teamId) &&
          !p.loan &&
          activeContract(state, p.id) !== null &&
          p.attributes.overall >= BUY_OVERALL_MIN &&
          p.attributes.overall <= BUY_OVERALL_MAX,
      )
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, BUY_SAMPLE);
    // 안개를 걷는다 — 완료된 보고서가 있으면 `knowledgeOf`가 scouted를 돌려준다
    for (const target of targets) {
      state.scoutReports.push({
        id: `harness-scout-${target.id}`,
        gamePlayerId: target.id,
        requestedOn: state.date,
        dueOn: state.date,
        completedOn: state.date,
      });
    }
    const buyAtExpectation = targets.map((target) => {
      const odds = dealOdds(state, {
        playerId: target.id,
        fee: askingPriceFor(state, target),
        weeklyWage: wageExpectationOf(state, target),
        years: 4,
        kind: "buy",
      });
      if (odds.fuzzy) throw new Error(`${target.id}의 안개가 걷히지 않았다 (${odds.knowledge})`);
      return odds.probability;
    });

    /**
     * ── 원형이 확률에 실제로 걸리는가 ──
     *
     * 대리인의 `askingLift`는 **호가와 주급 기대 자체**를 움직인다. 그래서 위처럼
     * 「그 선수의 기대치를 그대로 맞춘」 오퍼로 재면 비율이 언제나 1이라 원형이
     * 보이지 않는다 — 그 폭은 **중립 오퍼**를 같은 값으로 놓고 재야 드러난다.
     * 여기서는 `askingLift`를 걷어 낸 값을 부르고, 원형별로 중앙값을 나눈다.
     */
    const byArchetype = new Map<AgentArchetype, number[]>();
    for (const target of targets) {
      const agent = agentOfPlayer(state, target.id);
      if (!agent) continue;
      const lift = AGENT_PROFILE[agent.archetype].askingLift;
      const odds = dealOdds(state, {
        playerId: target.id,
        fee: Math.round(askingPriceFor(state, target) / lift),
        weeklyWage: Math.round(wageExpectationOf(state, target) / lift),
        years: 4,
        kind: "buy",
      });
      const row = byArchetype.get(agent.archetype) ?? [];
      row.push(odds.probability);
      byArchetype.set(agent.archetype, row);
    }
    const archetypeMedians = [...byArchetype.entries()].map(
      ([key, values]) => [key, median(sorted(values))] as const,
    );
    const medianOf = (key: AgentArchetype) =>
      archetypeMedians.find(([k]) => k === key)?.[1] ?? Number.NaN;
    const spanOfArchetypes =
      Math.max(...archetypeMedians.map(([, v]) => v)) -
      Math.min(...archetypeMedians.map(([, v]) => v));

    const renew = sorted(renewAtExpectation);
    const lowball = sorted(renewLowball);
    const release = sorted(releaseAtExpectation);
    const buy = sorted(buyAtExpectation);

    const readings: Readings<typeof NEGOTIATION> = {
      "표본 · 재계약": renew.length,
      "재계약 기대치 · 중앙값": median(renew),
      "재계약 기대치 · p90−p10": spread(renew),
      "재계약 기대치 · 90% 이상 비율": shareOf(renew, (v) => v >= RUBBER_STAMP_AT),
      "재계약 기대치 · 앵커가 조정인 비율": shareOf(
        renew,
        (v) => v >= COUNTERPARTY_COUNTER_AT && v < COUNTERPARTY_ACCEPT_AT,
      ),
      "재계약 70% 주급 · 중앙값": median(lowball),
      "해지 기대치 · 중앙값": median(release),
      "해지 기대치 · p90−p10": spread(release),
      "표본 · 영입": buy.length,
      "영입 기대치 · 중앙값": median(buy),
      "영입 기대치 · p90−p10": spread(buy),
      "영입 기대치 · 90% 이상 비율": shareOf(buy, (v) => v >= RUBBER_STAMP_AT),
      "영입 · 원형별 중앙값 폭": spanOfArchetypes,
      "영입 · 승부사형 중앙값": medianOf("hardballer"),
      "영입 · 제국형 중앙값": medianOf("empire"),
      "영입 · 법률가형 중앙값": medianOf("lawyer"),
    };
    console.log(reportOf(NEGOTIATION, readings, `시드 42 · 아스날 · ${state.date}`));
    expect(outOfBand(NEGOTIATION, readings)).toEqual([]);
  });
});
