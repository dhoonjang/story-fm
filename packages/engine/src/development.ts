import type { AttributeAxis, GamePlayer } from "@story-fm/domain";
import { ATTRIBUTE_AXES, ageOf } from "@story-fm/domain";
import { agingDelta } from "./attributes";
import { makeRng } from "./rng";
import { recomputeOverall, recordGrowth, squadLevelOf, type GameState } from "./state";

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
const GROW_MIN = 0.02;
const GROW_MAX = 0.35;

/** 이 선수가 코어 로직으로 자라는가 — 감독 팀 1군만 결산 판정을 받는다 */
export function developsByCore(state: GameState, player: GamePlayer): boolean {
  if (player.teamId !== state.userTeamId) return true;
  return squadLevelOf(player) === "reserve";
}

/**
 * 성장 쪽 확률 — 잠재력 여유가 클수록, 어릴수록 높다.
 * 노화 곡선이 이미 꺾인 축(음수)은 여기 들어오지 않는다.
 */
function growChance(room: number, age: number): number {
  if (room <= 0) return 0;
  const byRoom = Math.min(1, room / ROOM_FULL);
  // 스물셋까지가 가장 빠르고, 스물여덟을 넘으면 눈에 띄게 준다
  const byAge = age <= 20 ? 1 : age <= 23 ? 0.85 : age <= 27 ? 0.6 : age <= 30 ? 0.35 : 0.15;
  return Math.max(GROW_MIN, Math.min(GROW_MAX, byRoom * byAge));
}

/**
 * 한 달치 성장·쇠퇴를 적용한다 — 매월 1일 tick에서 부른다.
 *
 * 난수 채널에 날짜를 넣으므로 **같은 세이브는 같은 달에 같은 결과**다. 선수 목록을
 * id 순으로 돌아 순서에 의존하지 않는다.
 *
 * @returns 감독에게 알릴 우리 팀(2군) 변화 요약
 */
export function applyMonthlyDevelopment(state: GameState): string[] {
  const rng = makeRng(state.seed, `development:${state.date}`);
  const lines: string[] = [];
  const targets = state.players
    .filter((p) => developsByCore(state, p))
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const player of targets) {
    const age = ageOf(player.birthdate, state.date);
    let moved = 0;
    for (const axis of ATTRIBUTE_AXES) {
      if (moved >= MAX_AXES_PER_MONTH) break;
      const step = rollAxis(player, axis, age, rng);
      if (step === 0) continue;
      player.attributes[axis] = Math.max(1, Math.min(99, player.attributes[axis] + step));
      moved += 1;
      recordGrowth(state, player.id, null, "development", axis, step, "월간 성장");
    }
    if (moved === 0) continue;
    recomputeOverall(player);
    if (player.teamId === state.userTeamId) {
      lines.push(`${player.name} (2군) ${player.attributes.overall}`);
    }
  }
  return lines;
}

/** 이 축이 이번 달에 움직이는가 — +1 / −1 / 0 */
function rollAxis(player: GamePlayer, axis: AttributeAxis, age: number, rng: () => number): number {
  const value = player.attributes[axis];
  const bias = agingDelta(axis, age);

  // 꺾이는 축 — 시즌 기대치를 열두 달에 나눠 담는다
  if (bias < 0) {
    if (value <= 1) return 0;
    return rng() < Math.abs(bias) / MONTHS_PER_SEASON ? -1 : 0;
  }

  // 자라는 축 — 잠재력이 천장이다. 노화 곡선이 미는 축은 조금 더 잘 자란다
  const room = player.attributes.potential - value;
  if (room <= 0) return 0;
  const chance = growChance(room, age) * (bias > 0 ? 1 : 0.6);
  return rng() < chance / MONTHS_PER_SEASON ? 1 : 0;
}
