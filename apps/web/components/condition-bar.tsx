"use client";

import type { ConditionRead } from "@story-fm/engine";
import { conditionBand } from "@story-fm/domain";

/**
 * 체력 막대 — **값이 아니라 구간이다.**
 *
 * 경기 중 남은 다리는 아무도 실시간으로 재지 못한다(player.md §9.2). 흐린 숫자를
 * 또렷한 막대로 그리면 감독은 그걸 사실로 읽으므로, 확실한 만큼만 채우고 그 위로
 * **모르는 폭**을 흐리게 얹는다 — 막대의 끝이 어디인지 모른다는 사실이 모양으로
 * 드러난다. 안내 문구는 두지 않는다.
 *
 * 우리 선수의 꼬리는 짧고 상대는 길며, 둘 다 후반으로 갈수록 길어진다. 경기 밖에서는
 * 아침에 잰 값이라 꼬리가 아예 없다 — 폭 자체가 "지금 이걸 얼마나 믿을 수 있나"다.
 *
 * **명단·판세·상대 표가 이 하나를 쓴다.** 화면마다 따로 그리면 같은 선수가 두 모양,
 * 두 색으로 선다 — 색의 경계도 여기서 정하지 않고 코어(`conditionBand`)가 정한다.
 */
export function ConditionBar({ c }: { c: ConditionRead }) {
  const known = c.low === c.high;
  return (
    <span
      className={`cond-bar ${conditionBand(c.value)}`}
      title={`${c.label} — 체력 ${known ? c.value : `${c.low}~${c.high}`}`}
    >
      <span className="cond-sure" style={{ width: `${c.low}%` }} />
      {!known && (
        <span className="cond-fog" style={{ left: `${c.low}%`, width: `${c.high - c.low}%` }} />
      )}
    </span>
  );
}
