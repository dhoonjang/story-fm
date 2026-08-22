import type { SkillBriefItem } from "../core/state";

/**
 * **말풍선 항목을 짓는 한 벌** — 스킬이 어느 폴더에 있든 같은 모양으로 낸다.
 *
 * 항목은 `label`(무엇에 대한 것) · `text`(바뀐 값) · `note`(갈래) · `delta`(증감)로
 * 나뉜다. 화면이 그 자리마다 톤을 정하므로, 코어가 셋을 한 문자열로 붙여 내면
 * 화면은 되쪼개는 수밖에 없다 (→ docs/data/game-state.md §3.6).
 */

/** 한 항목에 이름을 몇 개까지 적나 — 항목 하나가 말풍선 한 줄이라 둘에서 접는다 */
const BRIEF_NAMES_SHOWN = 2;

/**
 * 항목에 적는 이름 — **둘에서 접는다.**
 *
 * `message`는 모델이 읽으므로 더 길어도 되지만(`nameList`) 항목 하나는 한 줄이라
 * 더 좁다. 누가 더 있는지는 스쿼드 화면이 갖고 있다.
 */
export const briefNames = (names: readonly string[]): string =>
  names.slice(0, BRIEF_NAMES_SHOWN).join(", ") +
  (names.length > BRIEF_NAMES_SHOWN ? ` 외 ${names.length - BRIEF_NAMES_SHOWN}명` : "");

/**
 * 부호를 붙인 수 — 항목의 증감 표기 (`+2` · `−2`).
 *
 * 감소는 유니코드 −(U+2212)다. ASCII 하이픈을 쓰면 포메이션(`4-2-3-1`)과 같은 자를
 * 지나 사람 눈에도 갈리지 않는다.
 */
export const signed = (n: number): string => (n < 0 ? `−${Math.abs(n)}` : `+${n}`);

/**
 * 말풍선 항목 하나 — **앞의 이름(`label`) · 값(`text`) · 뒤의 갈래(`note`) · 증감(`delta`).**
 *
 * 빈 조각은 달지 않는다 (없는 키와 빈 문자열이 화면에서 달리 그려지지 않게).
 * `delta`만은 `0`도 싣는다 — "안 움직였다"는 증감을 말하지 않는 것과 다른 사실이다.
 */
export const item = (parts: {
  label?: string;
  text: string;
  note?: string;
  delta?: number;
}): SkillBriefItem => ({
  ...(parts.label ? { label: parts.label } : {}),
  text: parts.text,
  ...(parts.note ? { note: parts.note } : {}),
  ...(parts.delta === undefined ? {} : { delta: parts.delta }),
});

/**
 * 오르내린 값 한 줄 — **0인 축은 항목이 되지 않는다.**
 *
 * 판정형 스킬(회견·다가옴)은 축 여럿이 한 번에 움직이고 그중 대개는 0이다.
 * 움직이지 않은 축까지 세우면 말풍선이 0으로 채워져 정작 무엇이 움직였는지가 묻힌다
 * — 그 자리에서 부호가 곧 사실인 항목만 낸다.
 */
export const deltaItem = (label: string, n: number): SkillBriefItem | null =>
  n === 0 ? null : item({ label, text: signed(n), delta: n });

/** 0인 축을 걸러 낸 증감 항목들 — `deltaItem`을 여럿 세우는 자리의 한 벌 */
export const deltaItems = (
  axes: readonly (readonly [label: string, value: number] | null)[],
): SkillBriefItem[] =>
  axes
    .map((axis) => (axis === null ? null : deltaItem(axis[0], axis[1])))
    .filter((it): it is SkillBriefItem => it !== null);
