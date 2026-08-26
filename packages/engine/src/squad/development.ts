import type {
  AttributeAxis,
  AxisValues,
  GamePlayer,
  MatchRecord,
  ReserveTrainingPolicy,
} from "@story-fm/domain";
import { ATTRIBUTE_AXES, ageOf, isReserveMatch, RATING_MAX } from "@story-fm/domain";
import { ageGrowthFactor, agingDelta, axisClockFactor } from "../world/attributes";
import { archetypeTraitsOf } from "../world/player-persona";
import { makeRng } from "../core/rng";
import { isTopLeague, leagueCatalogById } from "../data/league-catalog";
import { leagueOfTeamIn } from "../competition/promotion";
import { monthlyGrowthMultiplier, personalTrainingAxis } from "./training-plan";
import {
  onLoanFromUs,
  recomputeOverall,
  recordGrowth,
  squadLevelOf,
  teamShortNameIn,
  type GameState,
} from "../core/state";

/**
 * 월간 성장·쇠퇴 — **결산 판정을 받지 않는 선수 전부**의 능력치를 조금씩 움직인다.
 *
 * 감독의 팀 1군은 훈련·경기 결산이 LLM으로 판정한다. 그 밖(우리 2군 · 모든 타 팀)은
 * 판정을 돌릴 수 없다 — 4,000명분을 매달 모델에 태울 수는 없다. 그래서 같은 질문에
 * 코어가 답한다: **이 나이의 이 선수는 이 축에서 자라는가 꺾이는가.**
 *
 * 세 가지가 확률을 정한다:
 *   ① **축별 노화 곡선**(`agingDelta`) — 다리(pace·stamina·dribbling)가 먼저 죽고
 *      머리(vision·positioning·offTheBall·composure)는 서른 넘어서까지 자란다.
 *   ② **잠재력 여유** — 천장에 가까울수록 덜 자란다. 넘어선 축은 아예 안 자란다.
 *   ③ **난수** — 같은 나이·같은 여유라도 선수마다 갈린다. 시드 해시라 결정적이다.
 *
 * 이 몫을 시즌 전환에 한 번 몰아서 적용하면 5월 마지막 날과 7월 첫날 사이에
 * 스물아홉 살 윙어의 스피드가 두세 칸 꺼져 있다 — 감독이 겪은 것 없이 숫자만
 * 달라진다. 매달 조금씩 움직여야 시즌 중에 "요즘 발이 예전 같지 않다"가 관찰
 * 가능한 사건이 된다.
 */

/** 시즌 기대 변화량을 월 확률로 환산하는 나눗수 — 12개월에 나눠 담는다 */
const MONTHS_PER_SEASON = 12;
/**
 * 한 달에 한 선수가 움직일 수 있는 축 수 — 몰아서 변하면 "조금씩"이 아니다.
 * 여유가 찬 열여덟은 한 달에 넉 대여섯 축이 기대치라 이 상한은 난간이다 — 종합이
 * 한 달에 반 칸 넘게 뛰지 않는다.
 */
export const MAX_AXES_PER_MONTH = 8;
/**
 * 잠재력 여유가 성장 세기로 포화하는 눈금 — `1 − e^(−여유/눈금)`.
 *
 * 성장은 남은 여유에 비례하되 한 시즌이 담을 수 있는 양에는 천장이 있다 — 여유 30인
 * 열여섯이 여유 12인 스물보다 세 배 빨리 크지는 않는다. 그 모양이 포화 지수다: 여유
 * 8에서 천장의 63%, 12에서 78%, 24에서 95%.
 */
const ROOM_SCALE = 8;
/** 능력치가 내려갈 수 있는 바닥 — 0은 "값이 없다"로 읽히므로 쓰지 않는다 */
const ATTRIBUTE_FLOOR = 1;

/**
 * 여유가 찬 축 하나가 한 시즌에 기대하는 칸 수의 천장 (나이 배율 1 = 열아홉·스물) — ⚠️ 밸런스 값.
 *
 * 열여섯 축이 저마다 이만큼 오르면 종합도 그만큼 오른다. 실제 유망주의 종합은 열일곱에서
 * 스물셋까지 해마다 2~4칸씩 자라 잠재력 대역(player.md §6.5 — 열여덟의 간격 상한 28)을
 * 스물일곱 언저리에 닿는다. 여기가 그보다 낮으면 잠재력은 닿지 않는 천장이 되고,
 * 노화는 실제 눈금으로 깎이므로 리그가 해마다 늙는다(0.25면 세 시즌에 EPL 1군이 −1).
 * 그보다 높으면 세계가 해마다 자란다(2.4면 세 시즌에 +0.6) — 두 값 사이에서 실제
 * 유망주의 눈금 쪽에 둔다. 우리 2군의 배율(아래)까지 다 곱해도 결산 판정을 부지런히
 * 받는 1군 유망주(판정마다 한 칸 · 시즌 +3~4)와 같은 자릿수에 선다 — 2군은 자라는
 * 곳이고, 뛰는 곳은 1군이다.
 */
export const AXIS_GROWTH_PER_SEASON = 2.6;

// ── 감독의 육성 손잡이 (season.md §2 2군 리그) ──────────────────────
// 배율은 **성장 쪽에만** 붙는다 — 노화 하락은 출전과 무관하다. 감독이 다 걸어도
// 1.3 × 1.25 ≈ 1.63이고, 그 위에 사람됨(원형 `professionalism` 0.85~1.25 —
// people.md §6)이 한 항으로 더 붙어 꼭대기가 2.0이 된다. 그 자리에 서려면 셋이 다
// 맞아야 한다: 격주 2군 일정을 만근하고, 집중 육성 셋 안에 들고, 표 꼭대기의
// 직업의식을 타고났을 것. 그래도 결산 판정을 부지런히 받는 1군 유망주와 같은
// 자릿수다 — 2군은 자라는 곳이고, 뛰는 곳은 1군이다. 축을 겨냥하는 손잡이(방침 ·
// 개인 훈련)는 얼마나 빨리가 아니라 어느 쪽으로를 정하므로 총량 이동이고,
// 원본은 `training-plan.ts`다.

/** 지난달 2군 출전 한 경기가 성장 확률에 얹는 배율 증분 */
export const RESERVE_APP_BOOST = 0.15;
/** 출전 배율 상한 — 격주 일정(월 2경기)을 다 뛰면 찬다 */
export const RESERVE_APP_BOOST_MAX = 1.3;
/** 집중 육성 배율 — `set_development_focus`가 지정한 유망주 */
export const FOCUS_BOOST = 1.25;
/** 집중 육성 인원 상한 — 코치진의 눈이 닿는 수 */
export const DEVELOPMENT_FOCUS_LIMIT = 3;

/** 지난달 2군 출전 수 → 성장 확률 배율 */
export function reserveAppsBoost(apps: number): number {
  return Math.min(RESERVE_APP_BOOST_MAX, 1 + RESERVE_APP_BOOST * apps);
}

/**
 * 집중 육성 명단 — **우리 2군만 남긴다.** 승격·이적으로 떠난 선수는 여기서
 * 걷어낸다: 1군은 결산 판정(LLM)의 몫이라 코어 배율이 닿을 자리가 없고, 남의
 * 선수는 우리 코치진의 것이 아니다. 스킬(`setDevelopmentFocus`)과 월간 성장이
 * 같은 문을 지나므로 어느 쪽이 먼저 와도 명단은 같다.
 */
export function pruneDevelopmentFocus(state: GameState): string[] {
  const focus = (state.developmentFocus ?? []).filter((id) => {
    const player = state.players.find((p) => p.id === id);
    return (
      player !== undefined &&
      player.teamId === state.userTeamId &&
      squadLevelOf(player) === "reserve"
    );
  });
  state.developmentFocus = focus;
  return focus;
}

/**
 * 지난달 1일 — 출전을 세는 창의 시작. 월간 성장이 매월 1일에 돌기 때문에 창은
 * [이 날, 오늘)이고, 2군 출전과 임대 출전이 **같은 창을 읽는다**. 시즌 전환이
 * 장부를 통째로 갈아도(7월 1일) 빈 창이 될 뿐 깨지지 않는다.
 */
function lastMonthStart(date: string): string {
  const [year, month] = date.split("-").map(Number) as [number, number];
  return month === 1 ? `${year - 1}-12-01` : `${year}-${String(month - 1).padStart(2, "0")}-01`;
}

/**
 * 지난달 창 안의 출전 수 — **장부의 라인업에서 센다**(별도 저장이 없다).
 * 어느 경기를 세는지(`counts`)와 누구를 세는지(`keep`)만 부르는 쪽이 정한다.
 */
function appsInLastMonth(
  state: GameState,
  counts: (match: MatchRecord) => boolean,
  keep?: (playerId: string) => boolean,
): Map<string, number> {
  const from = lastMonthStart(state.date);
  const tally = new Map<string, number>();
  for (const match of state.matches) {
    if (!match.result) continue;
    if (match.date < from || match.date >= state.date) continue;
    if (!counts(match)) continue;
    for (const id of [...(match.result.homeLineup ?? []), ...(match.result.awayLineup ?? [])]) {
      if (keep && !keep(id)) continue;
      tally.set(id, (tally.get(id) ?? 0) + 1);
    }
  }
  return tally;
}

/** 지난 한 달 2군 리그 출전 수 */
export function reserveAppsByPlayer(state: GameState): Map<string, number> {
  return appsInLastMonth(state, isReserveMatch);
}

/**
 * 우리가 임대 보낸 선수의 지난 한 달 **그 구단 1군 출전 수** (season.md §2 임대).
 *
 * ⚠️ **2군 경기는 세지 않는다.** 2군 리그는 감독 팀만 편성되지만 상대 클럽의 2군
 * 선수가 그 명단에 서므로, 거르지 않으면 임대 보낸 선수가 우리 2군 리그에서 뛴
 * 경기로 자란다.
 */
export function loanAppsByPlayer(state: GameState): Map<string, number> {
  const loaned = new Set(state.players.filter((p) => onLoanFromUs(state, p)).map((p) => p.id));
  if (loaned.size === 0) return new Map();
  return appsInLastMonth(
    state,
    (match) => !isReserveMatch(match),
    (id) => loaned.has(id),
  );
}

// ── 임대 배율 (season.md §2 임대 — 2군과 1군 사이의 길) ──────────────
// 눈금은 2군과 **같은 자** 위에 있다: 출전 한 경기가 `RESERVE_APP_BOOST`와 같은
// 값이고 상한만 다르다. 2군은 격주 일정이라 월 2경기가 만근이고 1군 일정은 월
// 4~5경기라, 같은 리그에서 매주 뛰면 우리 2군의 출전×집중 육성 꼭대기에 닿는다.
// ⚠️ 두 상수는 2군 쪽을 따라간다 — 2군의 눈금만 옮기면 임대가 더 빠른 길이 된다.

/** 지난달 임대처 1군 출전 한 경기가 성장 확률에 얹는 배율 증분 (= `RESERVE_APP_BOOST`) */
export const LOAN_APP_BOOST = RESERVE_APP_BOOST;
/** 임대 출전 배율 상한 — 우리 2군의 출전 만근 × 집중 육성과 같은 꼭대기 */
export const LOAN_APP_BOOST_MAX = RESERVE_APP_BOOST_MAX * FOCUS_BOOST;
/** 리그 계수(UEFA 어림 순위) 한 칸이 임대처 수준 계수에 얹는 몫 */
export const LOAN_LEAGUE_STEP = 0.05;
/** 2부 임대의 배율 — 리그전을 돌지 않는 컵 전용 리그 (`isTopLeague`가 false) */
export const LOAN_SECOND_TIER = 0.85;
/** 임대처 수준 계수의 구간 */
export const LOAN_LEVEL_MIN = 0.6;
export const LOAN_LEVEL_MAX = 1.25;

/**
 * 임대처 수준 계수 — **어디서 뛰었는가**. 리그 계수(1이 가장 강하다)의 차이 한
 * 칸이 ±`LOAN_LEAGUE_STEP`이고, 2부면 ×`LOAN_SECOND_TIER`다.
 *
 * ⚠️ **돈(`leagueEconomyLevel`)을 쓰지 않는다** — 그 축은 살림의 크기지 경기의
 * 수준이 아니다. 카탈로그가 계수를 모르는 리그는 우리 리그와 같다고 보되 2부
 * 판정만 적용한다 — 지어내지 않는다.
 */
export function loanLevelFactor(state: GameState, teamId: string): number {
  const theirLeague = leagueOfTeamIn(state, teamId);
  const ours = leagueCatalogById(leagueOfTeamIn(state, state.userTeamId))?.coefficient;
  const theirs = leagueCatalogById(theirLeague)?.coefficient;
  const steps = ours === undefined || theirs === undefined ? 0 : ours - theirs;
  const tier = isTopLeague(theirLeague) ? 1 : LOAN_SECOND_TIER;
  return Math.max(LOAN_LEVEL_MIN, Math.min(LOAN_LEVEL_MAX, (1 + LOAN_LEAGUE_STEP * steps) * tier));
}

/** 지난달 임대처 출전 수 × 임대처 수준 → 성장 확률 배율 */
export function loanAppsBoost(apps: number, levelFactor: number): number {
  return Math.min(LOAN_APP_BOOST_MAX, 1 + LOAN_APP_BOOST * apps * levelFactor);
}

/**
 * 이 선수가 코어 로직으로 자라는가 — 감독 팀 1군만 결산 판정을 받는다.
 *
 * **우리가 임대 보낸 선수도 이 문을 지난다** — `teamId`가 빌린 구단이라 첫 줄에서
 * true다. 배율과 성장 로그는 `applyMonthlyDevelopment`가 따로 가른다.
 */
export function developsByCore(state: GameState, player: GamePlayer): boolean {
  if (player.teamId !== state.userTeamId) return true;
  return squadLevelOf(player) === "reserve";
}

/**
 * 성장 쪽 시즌 세기 — **한 축이 한 시즌에 오르는 칸 수의 기대치**. 월 확률은 이
 * 세기를 열두 달로 나눈 푸아송 분할(`monthlyChance`)이다. 잠재력 여유에 포화 지수로
 * 붙고 어릴수록 높다. 나이 배율은 결산 경로와 같은 한 열에서 온다(`ageGrowthFactor` —
 * player.md §6.3). 노화 곡선이 이미 꺾인 축(음수)은 여기 들어오지 않는다.
 *
 * ⚠️ **사람됨은 여기 곱하지 않는다.** 직업의식은 감독의 손잡이와 같은 자리, 즉
 * 여유·나이가 정한 대역 **밖**에서 곱한다 (`rollAxis`) — 그래야 원형이 자라는
 * 나이에서도 안 자라는 나이에서도 같은 비로 가른다.
 */
export function growChance(room: number, age: number): number {
  if (room <= 0) return 0;
  const byRoom = 1 - Math.exp(-room / ROOM_SCALE);
  return AXIS_GROWTH_PER_SEASON * byRoom * ageGrowthFactor(age);
}

/**
 * 시즌 세기 λ를 한 달로 나눈 확률 — **푸아송 과정의 달 분할** `1 − e^(−λ/12)`.
 * λ/12를 그대로 확률로 쓰면 세기가 커질 때 1을 넘고 자르는 상수가 필요해진다;
 * 이 꼴은 어떤 세기에도 1 아래이고 작은 세기에서는 λ/12와 같다.
 */
export function monthlyChance(seasonRate: number): number {
  return 1 - Math.exp(-Math.max(0, seasonRate) / MONTHS_PER_SEASON);
}

/**
 * 이번 달 이 선수가 실제로 움직이는 축 — 최대 `MAX_AXES_PER_MONTH`개.
 *
 * **축은 목록 순서가 아니라 시드가 고른다.** 16축이 저마다 제 난수 채널을 받고,
 * 움직인 축 중 시드가 정한 순서로 상한까지 반영한다. 앞에서부터 굴리다 상한이 차면
 * 멈추는 방식은 `ATTRIBUTE_AXES` 앞쪽(pace·stamina)만 키우고 뒤쪽(leadership·
 * goalkeeping)을 구조적으로 굳힌다 — `axes`를 어떤 순서로 넘겨도 결과가 같아야 한다.
 */
export function rollMonthlyAxes(
  input: {
    seed: number;
    date: string;
    playerId: string;
    age: number;
    values: AxisValues;
    potential: number;
    /** 감독의 육성 손잡이 — 2군 출전 × 집중 육성. 성장 쪽에만 곱한다 (기본 1) */
    boost?: number;
    /**
     * 사람됨 — 원형의 `professionalism` (기본 1). 감독의 손잡이와 같은 자리에서
     * 곱하되 **항은 따로 둔다**: 하나는 감독이 고른 것이고 하나는 타고난 것이라,
     * 한 값으로 접으면 육성 배율을 조율할 때 사람됨까지 함께 움직인다 (people.md §6).
     */
    professionalism?: number;
    /** 2군 훈련 방침 — 축마다 다른 배율을 얹는다. 없으면 어느 축도 흔들리지 않는다 */
    policy?: ReserveTrainingPolicy;
    /** 이 선수에게 걸린 개인 훈련의 축 — 방침 위에 한 축을 더 겨냥한다 (season.md §2) */
    personal?: AttributeAxis;
  },
  axes: readonly AttributeAxis[] = ATTRIBUTE_AXES,
): { axis: AttributeAxis; step: number }[] {
  return axes
    .map((axis) => {
      const rng = makeRng(input.seed, `development:${input.date}:${input.playerId}:${axis}`);
      // 뽑히는 순서도 난수다 — 축 이름으로 세우면 편향이 자리만 옮긴다
      const priority = rng();
      // 배율이 1이면 곱하지 않는다 — 겨냥 없는 세이브가 부동소수로 흔들리지 않게
      const aim =
        input.policy || input.personal
          ? monthlyGrowthMultiplier(axis, { policy: input.policy, personal: input.personal })
          : 1;
      const boost = aim === 1 ? input.boost : (input.boost ?? 1) * aim;
      const step = rollAxis(
        axis,
        input.age,
        input.values[axis],
        input.potential,
        rng,
        boost,
        input.professionalism,
      );
      return { axis, step, priority };
    })
    .filter((rolled) => rolled.step !== 0)
    .sort((a, b) => a.priority - b.priority || a.axis.localeCompare(b.axis))
    .slice(0, MAX_AXES_PER_MONTH)
    .map(({ axis, step }) => ({ axis, step }));
}

/**
 * 한 달치 성장·쇠퇴를 적용한다 — 매월 1일 tick에서 부른다.
 *
 * 난수 채널이 (시드, 날짜, 선수, 축)이라 **같은 세이브는 같은 달에 같은 결과**이고,
 * 선수 목록 순서에도 의존하지 않는다.
 *
 * ⚠️ **능력치는 대상 전원이 움직이지만 `growthLog`에는 우리 선수만 남긴다.** 리그
 * 전체를 적으면 매월 ≈2,000행이 들어와 4,000행 상한이 두 달 만에 감독의 훈련·경기
 * 기록을 밀어낸다. 로그를 읽는 곳(성장 일지 · 선수 카드 "최근 성장" · 달력 요약)은
 * 전부 우리 선수만 거르므로 타 팀 행은 아무도 읽지 않는다
 * (→ docs/data/game-state.md §3.4).
 *
 * 갈래는 셋이다 — **우리 2군 · 우리가 임대 보낸 선수 · 타 팀** (season.md §2 임대).
 * 임대는 그 구단 1군 출전 × 임대처 수준으로 자라고 감독의 손잡이(집중 육성 · 2군
 * 방침 · 개인 훈련)는 닿지 않지만, 계약이 우리 것이므로 로그와 요약에는 선다.
 *
 * @returns 감독에게 알릴 우리 선수(2군 · 임대) 변화 요약
 */
export function applyMonthlyDevelopment(state: GameState): string[] {
  const lines: string[] = [];
  const targets = state.players
    .filter((p) => developsByCore(state, p))
    .sort((a, b) => a.id.localeCompare(b.id));
  // 감독의 육성 손잡이 — 우리 2군에만 붙는다. 타 팀은 배율 없이 지금 그대로다
  const focus = new Set(pruneDevelopmentFocus(state));
  const reserveApps = reserveAppsByPlayer(state);
  const loanApps = loanAppsByPlayer(state);

  for (const player of targets) {
    const ours = player.teamId === state.userTeamId;
    const loaned = !ours && onLoanFromUs(state, player);
    const boost = ours
      ? reserveAppsBoost(reserveApps.get(player.id) ?? 0) * (focus.has(player.id) ? FOCUS_BOOST : 1)
      : loaned
        ? loanAppsBoost(loanApps.get(player.id) ?? 0, loanLevelFactor(state, player.teamId))
        : 1;
    // 개인 훈련은 우리 2군에만 걸린다 — 임대처 훈련장은 그쪽 코치진의 것이다
    const personal = ours ? personalTrainingAxis(state, player.id) : null;
    const steps = rollMonthlyAxes({
      seed: state.seed,
      date: state.date,
      playerId: player.id,
      age: ageOf(player.birthdate, state.date),
      values: player.attributes,
      potential: player.attributes.potential,
      boost,
      // 사람됨은 소속을 가리지 않는다 — 타 팀 선수도 임대 나간 선수도 같은 표를 읽는다
      professionalism: archetypeTraitsOf(state.seed, player).professionalism,
      ...(ours && state.reserveTraining ? { policy: state.reserveTraining } : {}),
      ...(personal ? { personal } : {}),
    });
    if (steps.length === 0) continue;

    for (const { axis, step } of steps) {
      player.attributes[axis] = Math.max(
        ATTRIBUTE_FLOOR,
        Math.min(RATING_MAX, player.attributes[axis] + step),
      );
      if (ours || loaned) {
        recordGrowth(state, player.id, null, "development", axis, step, "monthly");
      }
    }
    recomputeOverall(player);
    if (ours) lines.push(`${player.name} (2군) ${player.attributes.overall}`);
    else if (loaned) {
      lines.push(
        `${player.name} (임대·${teamShortNameIn(state, player.teamId)}) ${player.attributes.overall}`,
      );
    }
  }
  return lines;
}

/** 이 축이 이번 달에 움직이는가 — +1 / −1 / 0 */
export function rollAxis(
  axis: AttributeAxis,
  age: number,
  value: number,
  potential: number,
  rng: () => number,
  /** 육성 배율 — 성장 확률에만 곱한다. 노화 하락은 출전과 무관하다 */
  boost = 1,
  /** 직업의식 — 감독의 배율과 같은 자리. 노화 하락에는 붙지 않는다 (people.md §6) */
  professionalism = 1,
): number {
  const bias = agingDelta(axis, age);

  // 꺾이는 축 — 시즌 기대치를 열두 달에 나눠 담는다
  if (bias < 0) {
    if (value <= ATTRIBUTE_FLOOR) return 0;
    return rng() < monthlyChance(Math.abs(bias)) ? -1 : 0;
  }

  // 자라는 축 — 잠재력이 천장이다. 늦게까지 크는 축은 결산과 같은 시계로 조금 더 자란다
  const room = potential - value;
  if (room <= 0) return 0;
  const rate = growChance(room, age) * axisClockFactor(axis, age) * boost * professionalism;
  return rng() < monthlyChance(rate) ? 1 : 0;
}
