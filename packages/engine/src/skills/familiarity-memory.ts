import {
  clampFamiliarity,
  defaultRoleOf,
  roleChangeCost,
  type RoleMemo,
  type ShelvedFamiliarity,
  type TacticAssignment,
  type TeamTactics,
} from "@story-fm/domain";

/**
 * 적응도의 선반과 역할 대가의 정산 — **배치보다 오래 사는 값들**
 * (→ docs/data/player.md §7.2·§7.3).
 *
 * 배치(`TacticAssignment`)는 로테이션마다, 전술판 조작마다 통째로 다시 써진다.
 * 적응도와 그 기억은 선수가 몸으로 쌓은 값이라 그 주기를 따라 사라지면 안 된다 —
 * 감독이 판을 시험하는 행위 자체가 값을 태우게 된다.
 */

/** 오늘 이 자리가 져야 할 역할 대가 — 아침의 자리를 벗어나 있으면 없다 */
function roleCostOwed(memo: RoleMemo, at: { position: string; roleId?: string } | null): number {
  if (!at) return 0;
  /**
   * 자리가 다르면 0이다. 자리 이동 자체에는 적응도 대가가 없고, 다른 자리의 역할은
   * 아침의 역할과 견줄 자가 없다 — 역할 목록은 자리마다 다르고(player.md §3.1)
   * `roleDistance`는 그 자리에 없는 역할을 조용히 기본 역할로 읽는다.
   */
  const morning = memo.position ?? at.position;
  if (morning !== at.position) return 0;
  return roleChangeCost(morning, memo.role, at.roleId ?? defaultRoleOf(morning));
}

/**
 * 오늘 낸 역할 대가를 지금 자리에 맞춰 정산한다 — **차액만 가감한다.**
 *
 * 배치를 쓰는 모든 경로가 이 함수 하나를 부른다(역할 선택·자리 이동·라인업 저장·
 * 1·2군 이동). 한 곳이 빠지면 그 경로로 지나간 값만 환불되지 않아, 감독은 자기가
 * 무엇을 지불했는지 모른 채 팀이 약해진다.
 *
 * `at`이 null이면 **자리가 없다**(벤치·예비·2군)는 뜻이고, 낸 값은 되돌아온다.
 */
export function settleRoleCost(
  slot: { familiarity: number; roleMemo?: RoleMemo },
  today: string,
  at: { position: string; roleId?: string } | null,
): void {
  const memo = slot.roleMemo;
  // 날짜가 바뀌면 기준이 새로 잡힌다 — 하루를 보냈으면 몸에 밴 것이다
  if (!memo || memo.date !== today) return;
  const owed = roleCostOwed(memo, at);
  if (owed === memo.paid) return;
  slot.familiarity = clampFamiliarity(slot.familiarity - (owed - memo.paid));
  slot.roleMemo = { ...memo, paid: owed };
}

/**
 * 배치가 사라지기 전에 적응도·기억을 선반에 올린다.
 *
 * 올리면서 자리를 잃은 것으로 정산하므로, 선반 위의 값은 **오늘 아침의 값**이다.
 * 다시 배치될 때 그 자리의 역할로 다시 물린다 — 그래서 왕복이 정확히 닫힌다.
 */
export function shelveFamiliarity(
  tactics: TeamTactics,
  assignment: TacticAssignment,
  today: string,
): void {
  const entry: ShelvedFamiliarity = {
    playerId: assignment.playerId,
    familiarity: assignment.familiarity,
    ...(assignment.drilled ? { drilled: assignment.drilled } : {}),
    ...(assignment.roleMemo ? { roleMemo: assignment.roleMemo } : {}),
  };
  settleRoleCost(entry, today, null);
  const shelf = (tactics.shelved ??= []);
  const index = shelf.findIndex((s) => s.playerId === assignment.playerId);
  if (index >= 0) shelf[index] = entry;
  else shelf.push(entry);
}

/** 선반에서 꺼낸다 — 꺼내면 선반에서 사라진다 (이제 배치가 들고 있다) */
export function unshelveFamiliarity(
  tactics: TeamTactics,
  playerId: string,
): ShelvedFamiliarity | undefined {
  const index = tactics.shelved?.findIndex((s) => s.playerId === playerId) ?? -1;
  if (index < 0) return undefined;
  return tactics.shelved!.splice(index, 1)[0];
}

// 팀을 떠난 선수의 선반을 비우는 일은 `releaseFromTactics`(core/state.ts)가 한다 —
// 배치에서 빼는 자리와 같아야 한 쪽만 남는 일이 없다.
