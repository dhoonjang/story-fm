import type { AttributeAxis, AxisValues, GamePlayer } from "@story-fm/domain";
import { ATTRIBUTE_AXES, ageOf, isReserveMatch, RATING_MAX } from "@story-fm/domain";
import { agingDelta, monthlyGrowthFactor } from "../world/attributes";
import { makeRng } from "../core/rng";
import { recomputeOverall, recordGrowth, squadLevelOf, type GameState } from "../core/state";

/**
 * 월간 성장·쇠퇴 — **결산 판정을 받지 않는 선수 전부**의 능력치를 조금씩 움직인다.
 *
 * 감독의 팀 1군은 훈련·경기 결산이 LLM으로 판정한다. 그 밖(우리 2군 · 모든 타 팀)은
 * 판정을 돌릴 수 없다 — 4,000명분을 매달 모델에 태울 수는 없다. 그래서 같은 질문에
 * 코어가 답한다: **이 나이의 이 선수는 이 축에서 자라는가 꺾이는가.**
 *
 * 세 가지가 확률을 정한다:
 *   ① **축별 노화 곡선**(`agingDelta`) — 다리(pace·stamina·dribbling)가 먼저 죽고
 *      머리(vision·positioning·composure)는 서른 넘어서까지 자란다.
 *   ② **잠재력 여유** — 천장에 가까울수록 덜 자란다. 넘어선 축은 아예 안 자란다.
 *   ③ **난수** — 같은 나이·같은 여유라도 선수마다 갈린다. 시드 해시라 결정적이다.
 *
 * 예전엔 이 몫을 **시즌 전환에 한 번** 몰아서 적용했다(`agingDelta`를 그대로 더했다).
 * 그러면 5월 마지막 날과 7월 첫날 사이에 스물아홉 살 윙어의 스피드가 두세 칸 꺼져
 * 있다 — 감독이 겪은 것 없이 숫자만 달라진다. 매달 조금씩 움직이면 시즌 중에
 * "요즘 발이 예전 같지 않다"가 관찰 가능한 사건이 된다.
 */

/** 시즌 기대 변화량을 월 확률로 환산하는 나눗수 — 12개월에 나눠 담는다 */
const MONTHS_PER_SEASON = 12;
/** 한 달에 한 선수가 움직일 수 있는 축 수 — 몰아서 변하면 "조금씩"이 아니다 */
const MAX_AXES_PER_MONTH = 2;
/** 잠재력 여유가 이만큼이면 성장 확률이 최대가 된다 */
const ROOM_FULL = 12;
/** 성장 확률의 상한·하한 — 여유가 없어도 아주 가끔은 는다 */
/** 능력치가 내려갈 수 있는 바닥 — 0은 "값이 없다"로 읽히므로 쓰지 않는다 */
const ATTRIBUTE_FLOOR = 1;

/** 이미 노화 곡선이 꺾인 축이 그래도 오를 확률의 배율 */
const DECLINING_AXIS_GROWTH = 0.6;

const GROW_MIN = 0.02;
const GROW_MAX = 0.35;

// ── 감독의 육성 손잡이 (season.md §2 2군 리그) ──────────────────────
// 배율은 **성장 쪽에만** 붙는다 — 노화 하락은 출전과 무관하다. 상한을 다 곱해도
// (1.6 × 1.5 = 2.4 → 시즌 기대 0.84칸) 1군 결산 경로보다 느리다 — 2군은 자라는
// 곳이고, 뛰는 곳은 1군이다.

/** 지난달 2군 출전 한 경기가 성장 확률에 얹는 배율 증분 */
export const RESERVE_APP_BOOST = 0.3;
/** 출전 배율 상한 — 격주 일정(월 2경기)을 다 뛰면 찬다 */
export const RESERVE_APP_BOOST_MAX = 1.6;
/** 집중 육성 배율 — `set_development_focus`가 지정한 유망주 */
export const FOCUS_BOOST = 1.5;
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
 * 지난 한 달 2군 리그 출전 수 — **장부의 라인업에서 센다**(별도 저장이 없다).
 * 창은 [지난달 1일, 오늘) — 월간 성장이 매월 1일에 돌기 때문이다. 시즌 전환이
 * 장부를 통째로 갈아도(7월 1일) 빈 창이 될 뿐 깨지지 않는다.
 */
export function reserveAppsByPlayer(state: GameState): Map<string, number> {
  const [year, month] = state.date.split("-").map(Number) as [number, number];
  const from =
    month === 1 ? `${year - 1}-12-01` : `${year}-${String(month - 1).padStart(2, "0")}-01`;
  const counts = new Map<string, number>();
  for (const match of state.matches) {
    if (!isReserveMatch(match) || !match.result) continue;
    if (match.date < from || match.date >= state.date) continue;
    for (const id of [...(match.result.homeLineup ?? []), ...(match.result.awayLineup ?? [])]) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/** 이 선수가 코어 로직으로 자라는가 — 감독 팀 1군만 결산 판정을 받는다 */
export function developsByCore(state: GameState, player: GamePlayer): boolean {
  if (player.teamId !== state.userTeamId) return true;
  return squadLevelOf(player) === "reserve";
}

/**
 * 성장 쪽 확률 (시즌 기대치 — 월 확률은 이 값을 열두 달로 나눈다).
 * 잠재력 여유가 클수록, 어릴수록 높다. 나이 배율은 결산 경로와 같은 표에서 온다
 * (`monthlyGrowthFactor` — player.md §6.3). 노화 곡선이 이미 꺾인 축(음수)은
 * 여기 들어오지 않는다.
 */
export function growChance(room: number, age: number): number {
  if (room <= 0) return 0;
  const byRoom = Math.min(1, room / ROOM_FULL);
  return Math.max(GROW_MIN, Math.min(GROW_MAX, byRoom * monthlyGrowthFactor(age)));
}

/**
 * 이번 달 이 선수가 실제로 움직이는 축 — 최대 `MAX_AXES_PER_MONTH`개.
 *
 * **축은 목록 순서가 아니라 시드가 고른다.** 15축이 저마다 제 난수 채널을 받고,
 * 움직인 축 중 시드가 정한 순서로 둘까지 반영한다. 앞에서부터 굴리다 둘이 차면
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
  },
  axes: readonly AttributeAxis[] = ATTRIBUTE_AXES,
): { axis: AttributeAxis; step: number }[] {
  return axes
    .map((axis) => {
      const rng = makeRng(input.seed, `development:${input.date}:${input.playerId}:${axis}`);
      // 뽑히는 순서도 난수다 — 축 이름으로 세우면 편향이 자리만 옮긴다
      const priority = rng();
      const step = rollAxis(axis, input.age, input.values[axis], input.potential, rng, input.boost);
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
 * ⚠️ **능력치는 대상 전원이 움직이지만 `growthLog`에는 감독 팀만 남긴다.** 리그
 * 전체를 적으면 매월 ≈2,000행이 들어와 4,000행 상한이 두 달 만에 감독의 훈련·경기
 * 기록을 밀어낸다. 로그를 읽는 곳(성장 일지 · 선수 카드 "최근 성장" · 달력 요약)은
 * 전부 우리 선수만 거르므로 타 팀 행은 아무도 읽지 않는다
 * (→ docs/data/game-state.md §3.4).
 *
 * @returns 감독에게 알릴 우리 팀(2군) 변화 요약
 */
export function applyMonthlyDevelopment(state: GameState): string[] {
  const lines: string[] = [];
  const targets = state.players
    .filter((p) => developsByCore(state, p))
    .sort((a, b) => a.id.localeCompare(b.id));
  // 감독의 육성 손잡이 — 우리 2군에만 붙는다. 타 팀은 배율 없이 지금 그대로다
  const focus = new Set(pruneDevelopmentFocus(state));
  const reserveApps = reserveAppsByPlayer(state);

  for (const player of targets) {
    const ours = player.teamId === state.userTeamId;
    const boost = ours
      ? reserveAppsBoost(reserveApps.get(player.id) ?? 0) * (focus.has(player.id) ? FOCUS_BOOST : 1)
      : 1;
    const steps = rollMonthlyAxes({
      seed: state.seed,
      date: state.date,
      playerId: player.id,
      age: ageOf(player.birthdate, state.date),
      values: player.attributes,
      potential: player.attributes.potential,
      boost,
    });
    if (steps.length === 0) continue;

    for (const { axis, step } of steps) {
      player.attributes[axis] = Math.max(
        ATTRIBUTE_FLOOR,
        Math.min(RATING_MAX, player.attributes[axis] + step),
      );
      if (ours) recordGrowth(state, player.id, null, "development", axis, step, "월간 성장");
    }
    recomputeOverall(player);
    if (ours) lines.push(`${player.name} (2군) ${player.attributes.overall}`);
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
): number {
  const bias = agingDelta(axis, age);

  // 꺾이는 축 — 시즌 기대치를 열두 달에 나눠 담는다
  if (bias < 0) {
    if (value <= ATTRIBUTE_FLOOR) return 0;
    return rng() < Math.abs(bias) / MONTHS_PER_SEASON ? -1 : 0;
  }

  // 자라는 축 — 잠재력이 천장이다. 노화 곡선이 미는 축은 조금 더 잘 자란다
  const room = potential - value;
  if (room <= 0) return 0;
  const chance = growChance(room, age) * (bias > 0 ? 1 : DECLINING_AXIS_GROWTH) * boost;
  return rng() < chance / MONTHS_PER_SEASON ? 1 : 0;
}
