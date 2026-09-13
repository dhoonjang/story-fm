import type { Player, PositionGroup, SetPieceTakers } from "@story-fm/domain";
import { positionGroupOf, positionGroupOfPlayer } from "@story-fm/domain";
import { penaltySkill } from "./shot-model";
import type { LineupSlot } from "./strength-packet";

/**
 * 죽은 공을 차는 사람 — **이 규칙의 유일한 자리** (match.md §1.4).
 *
 * 구간 시뮬(`match-engine.ts`)·간이 시뮬(`engine/match/quick-sim.ts`)·전력 패킷
 * (`strength-packet.ts`)·스쿼드 화면(`engine/views/views.ts`)·키포인트
 * (`key-points.ts`)가 전부 여기를 지난다. 한 곳이 스스로 「킥력 최고」를 다시 재면
 * 감독이 화면에서 읽는 키커와 90분이 실제로 세우는 키커가 갈린다 — 그때 감독이
 * 믿는 것은 화면이지 판정이 아니다.
 */

/** 키커를 고르는 데 필요한 것 — 선수와 그가 선 자리 (`LineupSlot`의 부분집합) */
export type TakerSlot = Pick<LineupSlot, "player" | "position">;

/**
 * 배치 포지션 → 존 그룹. 선수의 주 포지션이 아니라 "맡은 자리"가 기준이다.
 *
 * 받는 것은 `LineupSlot`의 **두 칸뿐**이다 — 키커를 고르는 자리를 화면 쪽 뷰도
 * 부르는데, 거기에는 적응도·피로 같은 경기용 칸이 없다.
 */
export function slotGroup(slot: TakerSlot): PositionGroup {
  return positionGroupOf(slot.position) ?? positionGroupOfPlayer(slot.player);
}

/** 죽은 공의 세 자리 */
export type SetPieceRole = "corner" | "freeKick" | "penalty";

/**
 * 자리마다 읽는 능력 — 코너·프리킥은 배급(`kicking`), 페널티는 `penaltySkill`.
 * 기본값을 고르는 저울이자 태그가 싣는 수치다.
 */
export const TAKER_SKILL: Record<SetPieceRole, (p: Player) => number> = {
  corner: (p) => p.attributes.kicking,
  freeKick: (p) => p.attributes.kicking,
  penalty: penaltySkill,
};

/**
 * 한 자리를 채운다 — **지정이 먼저, 그가 그라운드에 없으면 능력 최고.**
 *
 * `onPitch`는 지정을 대조하는 전원이고 `fallback`은 기본값을 고르는 후보다. 둘이
 * 갈리는 것은 **골키퍼 때문**이다: 골킥·펀트를 재는 `kicking`은 골키퍼가 거의
 * 언제나 팀 최고라 걸러 내지 않으면 모든 팀의 코너를 골키퍼가 올리지만, 자기
 * 골문을 비우고 올라가는 일 자체는 감독이 지정으로 시킬 수 있다.
 */
function fill<T>(
  named: string | null | undefined,
  onPitch: readonly T[],
  fallback: readonly T[],
  playerOf: (item: T) => Player,
  read: (p: Player) => number,
): T | null {
  if (named !== null && named !== undefined) {
    const designated = onPitch.find((item) => playerOf(item).id === named);
    if (designated) return designated;
  }
  if (fallback.length === 0) return null;
  return fallback.reduce((a, b) => (read(playerOf(b)) > read(playerOf(a)) ? b : a));
}

/** 골키퍼를 뺀 후보 — 기본값은 언제나 여기서 고른다 */
const outfieldSlots = <S extends TakerSlot>(slots: readonly S[]): S[] =>
  slots.filter((slot) => slotGroup(slot) !== "GK");

/**
 * 죽은 공 세 자리를 한 번에 — 패킷의 `guide.setPieces[side].takers`가 이것이다.
 *
 * 지정한 선수가 선발에 없으면(교체·퇴장·로테이션) 그 자리는 곧바로 기본값으로
 * 돌아간다. 지정 자체는 전술에 남는다 — 한 경기의 명단이 감독의 지시를 지우지 않는다.
 */
export function setPieceTakersOf(
  slots: readonly TakerSlot[],
  designated?: SetPieceTakers,
): Record<SetPieceRole, string | null> {
  const field = outfieldSlots(slots);
  const of = (role: SetPieceRole) =>
    fill(designated?.[role], slots, field, (s) => s.player, TAKER_SKILL[role])?.player.id ?? null;
  return { corner: of("corner"), freeKick: of("freeKick"), penalty: of("penalty") };
}

/**
 * 그라운드 위에서 그 자리를 실제로 채우는 선수 — 구간 시뮬·간이 시뮬이 부른다.
 *
 * 패킷은 킥오프·교체·구간마다 다시 서므로 대개 이미 온필드 기준이지만, 같은 구간
 * 안에서 퇴장이 나면 패킷보다 장부가 앞선다. 그래서 고르는 자리에서 한 번 더
 * 대조한다 — 나간 사람이 코너를 차는 장부는 §5의 반려다.
 */
export function takerOnPitch(
  named: string | null | undefined,
  role: SetPieceRole,
  onPitch: readonly Player[],
): Player | null {
  const field = onPitch.filter((p) => positionGroupOfPlayer(p) !== "GK");
  return fill(named, onPitch, field, (p) => p, TAKER_SKILL[role]);
}

/**
 * 그 팀의 죽은 공을 대표하는 한 사람 — 키포인트 `set-piece`가 세우는 이름이다.
 *
 * 코너와 프리킥을 다른 사람이 차면 **둘 중 킥력이 높은 쪽**이 선다: 감독이 읽는
 * 사실은 「이 팀 죽은 공이 얼마나 위협적인가」이고, 그것을 정하는 것은 더 잘 차는
 * 발이다. 지정이 없으면 두 자리가 같은 사람이라 필드 최고 킥력 하나로 접힌다.
 */
export function deliveryTakerOf<S extends TakerSlot>(
  slots: readonly S[],
  designated?: SetPieceTakers,
): S | undefined {
  const takers = setPieceTakersOf(slots, designated);
  const found = (id: string | null) =>
    id === null ? undefined : slots.find((slot) => slot.player.id === id);
  const corner = found(takers.corner);
  const freeKick = found(takers.freeKick);
  if (!corner) return freeKick;
  if (!freeKick) return corner;
  return freeKick.player.attributes.kicking > corner.player.attributes.kicking ? freeKick : corner;
}
