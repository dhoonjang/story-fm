/**
 * 앞뒤 배치를 견주는 자 — **무엇이 달라졌는가만 낸다. 문장은 만들지 않는다.**
 *
 * 같은 비교를 부르는 자리가 둘이다: 라인업 확정이 내는 `{notes, items}`와 전술판
 * 저장이 내는 한 줄. 문장은 서로 다르지만 세는 것은 같으므로, 세는 쪽만 여기 둔다.
 */

/**
 * 견줄 한 쪽의 배치.
 *
 * 자리·명단·지문은 **아는 쪽만 채운다** — 전술판 저장은 저장 전 스냅샷으로 선발
 * 명단과 모양과 지문만 들고 있고, 라인업 확정은 배치 전체를 들고 있다. 모르는
 * 것은 비워 두면 그 비교의 답이 `null`이 된다.
 */
export type LineupSide = {
  /** 좌표에서 읽은 모양 이름 (`4-2-3-1`) */
  readonly shape: string;
  readonly starting: readonly LineupSlotRef[];
  /** 매치데이 명단 전체 — 선발과 벤치를 함께 */
  readonly squad?: readonly string[];
  /** 선수·자리·좌표 지문 */
  readonly signature?: string;
};

export type LineupSlotRef = { readonly playerId: string; readonly position?: string };

export type LineupDiff = {
  readonly shapeBefore: string;
  readonly shapeAfter: string;
  readonly shapeChanged: boolean;
  /** 앞선 선발이 없다 — 견줄 것이 없는 첫 편성 */
  readonly firstSetup: boolean;
  /** 선발로 들어온 선수 (뒤 배치 순서) */
  readonly added: readonly LineupSlotRef[];
  /** 선발에서 빠진 선수 (앞 배치 순서) */
  readonly gone: readonly LineupSlotRef[];
  /** 선발로 남은 채 자리만 옮긴 선수 — 양쪽 자리를 다 알 때만 셀 수 있다 */
  readonly moved: readonly {
    readonly playerId: string;
    readonly from: string;
    readonly to: string;
  }[];
  /** 명단이 달라졌나 — 양쪽 명단을 다 알 때만 참·거짓이 된다 */
  readonly squadChanged: boolean | null;
  /** 지문이 달라졌나(인원이 그대로여도 좌표가 움직였나) — 양쪽 지문을 다 알 때만 */
  readonly pointsChanged: boolean | null;
};

const sameIds = (a: readonly string[], b: readonly string[]): boolean => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...right].every((id) => left.has(id));
};

export function diffLineup(before: LineupSide, after: LineupSide): LineupDiff {
  const was = new Map(before.starting.map((s) => [s.playerId, s]));
  const startsNow = new Set(after.starting.map((s) => s.playerId));
  return {
    shapeBefore: before.shape,
    shapeAfter: after.shape,
    shapeChanged: before.shape !== after.shape,
    firstSetup: before.starting.length === 0,
    added: after.starting.filter((s) => !was.has(s.playerId)),
    gone: before.starting.filter((s) => !startsNow.has(s.playerId)),
    moved: after.starting.flatMap((s) => {
      const old = was.get(s.playerId);
      return old?.position && s.position && old.position !== s.position
        ? [{ playerId: s.playerId, from: old.position, to: s.position }]
        : [];
    }),
    squadChanged: before.squad && after.squad ? !sameIds(before.squad, after.squad) : null,
    pointsChanged:
      before.signature !== undefined && after.signature !== undefined
        ? before.signature !== after.signature
        : null,
  };
}
