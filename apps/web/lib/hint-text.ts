import { ROLE_ABBR } from "@story-fm/domain";

/**
 * 말풍선의 글을 **좁은 자리에 맞게 다듬는다.**
 *
 * 알림 한 장은 320px이고 줄은 11px이다. 코어가 쓴 문장을 그대로 세우면 한 줄이
 * 두 줄로 접히고, 정작 바뀐 값이 사족에 묻힌다.
 */

/** 역할 이름은 **판에서 부르는 이름**으로 — 긴 이름부터 지운다 */
const ROLE_NAME = new RegExp(
  [...ROLE_ABBR.keys()]
    .sort((a, b) => b.length - a.length)
    .map((ko) => ko.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
  "g",
);

/** `컴플리트 포워드` → `CF`. 전술판 칩과 같은 표기라야 같은 역할로 읽힌다 */
export function abbreviateRoles(text: string): string {
  return text.replace(ROLE_NAME, (ko) => ROLE_ABBR.get(ko) ?? ko);
}

/**
 * 수치가 든 절인가 — 숫자가 있으면 값을 말하는 절로 본다.
 * 쉼표·점은 **뒤에 숫자가 올 때만** 수의 일부다 (`1,200`은 하나, `+20, 익혀…`는 둘).
 */
const NUMBER = /[+−]?\d+(?:[,.]\d+)*/;
/** 수치 뒤에서 설명이 시작되는 자리 — 줄표나 쉼표로 갈린다 */
const ASIDE = /\s*[—,]\s*/;

/** 앞은 수치(밝게), 뒤는 설명(흐리게). 수치가 없으면 통째로 설명이다 */
export function splitNote(note: string): { fact: string; aside: string } {
  const num = NUMBER.exec(note);
  if (!num) return { fact: "", aside: note };
  const after = num.index + num[0].length;
  const rest = note.slice(after);
  const cut = ASIDE.exec(rest);
  if (!cut) return { fact: note, aside: "" };
  return { fact: note.slice(0, after + cut.index), aside: rest.slice(cut.index) };
}
